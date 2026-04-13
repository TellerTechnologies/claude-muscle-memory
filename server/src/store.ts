import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Observation, Pattern, Reflex, EventType, PatternType, ReflexType } from './types.js';

const DB_DIR = join(homedir(), '.claude-muscle-memory');
const DB_PATH = join(DB_DIR, 'patterns.db');

function ensureDir(): void {
  mkdirSync(DB_DIR, { recursive: true });
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  ensureDir();
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  initSchema(_db);
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      content TEXT NOT NULL,
      context TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS patterns (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      signature TEXT UNIQUE NOT NULL,
      strength REAL DEFAULT 0.1,
      occurrences INTEGER DEFAULT 1,
      last_seen TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now')),
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS reflexes (
      id INTEGER PRIMARY KEY,
      pattern_id INTEGER REFERENCES patterns(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_observations_event_type ON observations(event_type);
    CREATE INDEX IF NOT EXISTS idx_observations_created_at ON observations(created_at);
    CREATE INDEX IF NOT EXISTS idx_patterns_strength ON patterns(strength);
    CREATE INDEX IF NOT EXISTS idx_patterns_signature ON patterns(signature);
  `);
}

// --- Observations ---

export function addObservation(
  eventType: EventType,
  content: string,
  toolName?: string | null,
  context?: string | null,
): Observation {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO observations (event_type, tool_name, content, context)
    VALUES (?, ?, ?, ?)
  `);
  const result = stmt.run(eventType, toolName ?? null, content, context ?? null);
  return db.prepare('SELECT * FROM observations WHERE id = ?').get(result.lastInsertRowid) as Observation;
}

export function getRecentObservations(limit = 500): Observation[] {
  const db = getDb();
  return db.prepare('SELECT * FROM observations ORDER BY created_at DESC LIMIT ?').all(limit) as Observation[];
}

export function getObservationsSince(sinceId: number, limit = 500): Observation[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM observations WHERE id > ? ORDER BY created_at DESC LIMIT ?',
  ).all(sinceId, limit) as Observation[];
}

export function getMaxObservationId(): number {
  const db = getDb();
  const row = db.prepare('SELECT MAX(id) as max_id FROM observations').get() as { max_id: number | null };
  return row.max_id ?? 0;
}

// --- Meta key-value store ---

export function getMeta(key: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

export function getObservationsByType(eventType: EventType, limit = 200): Observation[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM observations WHERE event_type = ? ORDER BY created_at DESC LIMIT ?',
  ).all(eventType, limit) as Observation[];
}

export function getObservationCount(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
  return row.count;
}

// --- Patterns ---

export function upsertPattern(
  type: PatternType,
  description: string,
  signature: string,
  strengthDelta: number,
  metadata?: Record<string, unknown>,
): Pattern {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM patterns WHERE signature = ?').get(signature) as Pattern | undefined;

  if (existing) {
    const newStrength = Math.min(1.0, existing.strength + strengthDelta);
    db.prepare(`
      UPDATE patterns
      SET strength = ?, occurrences = occurrences + 1, last_seen = datetime('now'),
          description = ?, metadata = ?
      WHERE id = ?
    `).run(newStrength, description, metadata ? JSON.stringify(metadata) : existing.metadata, existing.id);
    return db.prepare('SELECT * FROM patterns WHERE id = ?').get(existing.id) as Pattern;
  } else {
    const stmt = db.prepare(`
      INSERT INTO patterns (type, description, signature, strength, metadata)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(type, description, signature, strengthDelta, metadata ? JSON.stringify(metadata) : null);
    return db.prepare('SELECT * FROM patterns WHERE id = ?').get(result.lastInsertRowid) as Pattern;
  }
}

export function getAllPatterns(): Pattern[] {
  const db = getDb();
  return db.prepare('SELECT * FROM patterns ORDER BY strength DESC').all() as Pattern[];
}

export function getActivePatterns(minStrength = 0.5): Pattern[] {
  const db = getDb();
  return db.prepare('SELECT * FROM patterns WHERE strength >= ? ORDER BY strength DESC').all(minStrength) as Pattern[];
}

export function getPatternById(id: number): Pattern | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM patterns WHERE id = ?').get(id) as Pattern | undefined;
}

export function getPatternBySignature(signature: string): Pattern | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM patterns WHERE signature = ?').get(signature) as Pattern | undefined;
}

export function updatePatternStrength(id: number, strength: number): void {
  const db = getDb();
  db.prepare('UPDATE patterns SET strength = ? WHERE id = ?').run(Math.max(0, Math.min(1.0, strength)), id);
}

export function deletePattern(id: number): void {
  const db = getDb();
  db.prepare('DELETE FROM patterns WHERE id = ?').run(id);
}

export function findPatternByDescription(description: string): Pattern | undefined {
  const db = getDb();
  // Escape LIKE wildcards to prevent unintended matching
  const escaped = description.toLowerCase().replace(/[%_]/g, '\\$&');
  return db.prepare(
    "SELECT * FROM patterns WHERE LOWER(description) LIKE ? ESCAPE '\\' ORDER BY strength DESC LIMIT 1",
  ).get(`%${escaped}%`) as Pattern | undefined;
}

// --- Reflexes ---

export function addReflex(patternId: number, type: ReflexType, content: string): Reflex {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO reflexes (pattern_id, type, content)
    VALUES (?, ?, ?)
  `);
  const result = stmt.run(patternId, type, content);
  return db.prepare('SELECT * FROM reflexes WHERE id = ?').get(result.lastInsertRowid) as Reflex;
}

export function getActiveReflexes(): Reflex[] {
  const db = getDb();
  return db.prepare('SELECT * FROM reflexes WHERE active = 1').all() as Reflex[];
}

// --- Maintenance ---

export function clearAll(): void {
  const db = getDb();
  db.exec('DELETE FROM reflexes; DELETE FROM patterns; DELETE FROM observations; DELETE FROM meta; VACUUM;');
}

export function getStats(): { observations: number; patterns: number; reflexes: number } {
  const db = getDb();
  const obs = (db.prepare('SELECT COUNT(*) as c FROM observations').get() as { c: number }).c;
  const pat = (db.prepare('SELECT COUNT(*) as c FROM patterns').get() as { c: number }).c;
  const ref = (db.prepare('SELECT COUNT(*) as c FROM reflexes').get() as { c: number }).c;
  return { observations: obs, patterns: pat, reflexes: ref };
}
