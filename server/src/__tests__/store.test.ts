import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers.js';

// Each test gets a fresh DB — we dynamically import store so the singleton resets
async function freshStore() {
  // Force re-import by clearing module cache won't work with ESM,
  // so we rely on closeDb + env var change to get a fresh DB
  const store = await import('../store.js');
  return store;
}

describe('Store — Schema & Initialization', () => {
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = createTestDb();
    cleanup = ctx.cleanup;
  });

  afterEach(async () => {
    const store = await freshStore();
    store.closeDb();
    cleanup();
  });

  it('creates database and tables on first access', async () => {
    const store = await freshStore();
    const db = store.getDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toContain('observations');
    expect(names).toContain('patterns');
    expect(names).toContain('reflexes');
    expect(names).toContain('meta');
  });

  it('uses WAL journal mode', async () => {
    const store = await freshStore();
    const db = store.getDb();
    const result = db.pragma('journal_mode') as { journal_mode: string }[];
    expect(result[0].journal_mode).toBe('wal');
  });

  it('has foreign keys enabled', async () => {
    const store = await freshStore();
    const db = store.getDb();
    const result = db.pragma('foreign_keys') as { foreign_keys: number }[];
    expect(result[0].foreign_keys).toBe(1);
  });
});

describe('Store — Observations CRUD', () => {
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = createTestDb();
    cleanup = ctx.cleanup;
  });

  afterEach(async () => {
    const store = await freshStore();
    store.closeDb();
    cleanup();
  });

  it('adds an observation and returns it with an ID', async () => {
    const store = await freshStore();
    const obs = store.addObservation('tool_use', 'npm test', 'Bash');
    expect(obs.id).toBe(1);
    expect(obs.event_type).toBe('tool_use');
    expect(obs.tool_name).toBe('Bash');
    expect(obs.content).toBe('npm test');
    expect(obs.created_at).toBeTruthy();
  });

  it('handles null tool_name and context', async () => {
    const store = await freshStore();
    const obs = store.addObservation('user_prompt', 'fix the bug');
    expect(obs.tool_name).toBeNull();
    expect(obs.context).toBeNull();
  });

  it('getRecentObservations returns in DESC order', async () => {
    const store = await freshStore();
    store.addObservation('tool_use', 'first', 'Bash');
    store.addObservation('tool_use', 'second', 'Bash');
    store.addObservation('tool_use', 'third', 'Bash');
    const recent = store.getRecentObservations(10);
    expect(recent).toHaveLength(3);
    expect(recent[0].content).toBe('third');
    expect(recent[2].content).toBe('first');
  });

  it('getRecentObservations respects limit', async () => {
    const store = await freshStore();
    for (let i = 0; i < 10; i++) {
      store.addObservation('tool_use', `cmd_${i}`, 'Bash');
    }
    const recent = store.getRecentObservations(3);
    expect(recent).toHaveLength(3);
  });

  it('getObservationsSince returns only newer observations', async () => {
    const store = await freshStore();
    store.addObservation('tool_use', 'old', 'Bash');
    store.addObservation('tool_use', 'old2', 'Bash');
    const sinceId = store.getMaxObservationId();
    store.addObservation('tool_use', 'new1', 'Bash');
    store.addObservation('tool_use', 'new2', 'Bash');
    const newer = store.getObservationsSince(sinceId);
    expect(newer).toHaveLength(2);
    expect(newer.map(o => o.content).sort()).toEqual(['new1', 'new2']);
  });

  it('getObservationsByType filters correctly', async () => {
    const store = await freshStore();
    store.addObservation('tool_use', 'cmd', 'Bash');
    store.addObservation('user_prompt', 'hello');
    store.addObservation('tool_use', 'cmd2', 'Edit');
    const toolObs = store.getObservationsByType('tool_use');
    expect(toolObs).toHaveLength(2);
    const promptObs = store.getObservationsByType('user_prompt');
    expect(promptObs).toHaveLength(1);
  });

  it('getObservationCount returns correct count', async () => {
    const store = await freshStore();
    expect(store.getObservationCount()).toBe(0);
    store.addObservation('tool_use', 'cmd', 'Bash');
    store.addObservation('tool_use', 'cmd2', 'Bash');
    expect(store.getObservationCount()).toBe(2);
  });

  it('getMaxObservationId returns 0 for empty table', async () => {
    const store = await freshStore();
    expect(store.getMaxObservationId()).toBe(0);
  });
});

describe('Store — Patterns CRUD', () => {
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = createTestDb();
    cleanup = ctx.cleanup;
  });

  afterEach(async () => {
    const store = await freshStore();
    store.closeDb();
    cleanup();
  });

  it('upsertPattern creates a new pattern', async () => {
    const store = await freshStore();
    const p = store.upsertPattern('command_freq', 'runs npm test', 'sig1', 0.15, { cmd: 'npm' });
    expect(p.id).toBe(1);
    expect(p.type).toBe('command_freq');
    expect(p.signature).toBe('sig1');
    expect(p.strength).toBe(0.15);
    expect(p.occurrences).toBe(1);
  });

  it('upsertPattern reinforces existing pattern by signature', async () => {
    const store = await freshStore();
    store.upsertPattern('command_freq', 'runs npm test', 'sig1', 0.15);
    const p2 = store.upsertPattern('command_freq', 'runs npm test', 'sig1', 0.15);
    expect(p2.id).toBe(1); // same row
    expect(p2.strength).toBeCloseTo(0.30);
    expect(p2.occurrences).toBe(2);
  });

  it('upsertPattern caps strength at 1.0', async () => {
    const store = await freshStore();
    store.upsertPattern('command_freq', 'test', 'sig1', 0.9);
    const p = store.upsertPattern('command_freq', 'test', 'sig1', 0.5);
    expect(p.strength).toBe(1.0);
  });

  it('getAllPatterns returns ordered by strength DESC', async () => {
    const store = await freshStore();
    store.upsertPattern('command_freq', 'weak', 'sig1', 0.1);
    store.upsertPattern('command_freq', 'strong', 'sig2', 0.9);
    store.upsertPattern('command_freq', 'mid', 'sig3', 0.5);
    const all = store.getAllPatterns();
    expect(all[0].description).toBe('strong');
    expect(all[2].description).toBe('weak');
  });

  it('getActivePatterns filters by min strength', async () => {
    const store = await freshStore();
    store.upsertPattern('command_freq', 'weak', 'sig1', 0.1);
    store.upsertPattern('command_freq', 'strong', 'sig2', 0.7);
    const active = store.getActivePatterns(0.5);
    expect(active).toHaveLength(1);
    expect(active[0].description).toBe('strong');
  });

  it('getPatternById and getPatternBySignature work', async () => {
    const store = await freshStore();
    const created = store.upsertPattern('command_freq', 'test', 'mysig', 0.15);
    expect(store.getPatternById(created.id)?.signature).toBe('mysig');
    expect(store.getPatternBySignature('mysig')?.id).toBe(created.id);
    expect(store.getPatternById(999)).toBeUndefined();
    expect(store.getPatternBySignature('nonexistent')).toBeUndefined();
  });

  it('updatePatternStrength clamps to [0, 1]', async () => {
    const store = await freshStore();
    const p = store.upsertPattern('command_freq', 'test', 'sig1', 0.5);
    store.updatePatternStrength(p.id, 1.5);
    expect(store.getPatternById(p.id)!.strength).toBe(1.0);
    store.updatePatternStrength(p.id, -0.5);
    expect(store.getPatternById(p.id)!.strength).toBe(0);
  });

  it('deletePattern removes the pattern', async () => {
    const store = await freshStore();
    const p = store.upsertPattern('command_freq', 'test', 'sig1', 0.5);
    store.deletePattern(p.id);
    expect(store.getPatternById(p.id)).toBeUndefined();
  });

  it('findPatternByDescription does partial match', async () => {
    const store = await freshStore();
    store.upsertPattern('command_freq', 'User frequently runs npm test', 'sig1', 0.5);
    expect(store.findPatternByDescription('npm test')?.signature).toBe('sig1');
    expect(store.findPatternByDescription('cargo build')).toBeUndefined();
  });

  it('findPatternByDescription escapes LIKE wildcards', async () => {
    const store = await freshStore();
    store.upsertPattern('preference', 'uses 100% TypeScript', 'sig1', 0.5);
    // A raw % would match everything — this should only match the literal
    const result = store.findPatternByDescription('100%');
    expect(result).toBeDefined();
    expect(result?.description).toContain('100%');
    // Searching for just "%" should not match random patterns
    store.upsertPattern('preference', 'prefers tabs', 'sig2', 0.5);
    const wildcard = store.findPatternByDescription('%');
    // Should match "100%" because it contains literal %
    expect(wildcard?.description).toContain('%');
  });
});

describe('Store — Meta key-value', () => {
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = createTestDb();
    cleanup = ctx.cleanup;
  });

  afterEach(async () => {
    const store = await freshStore();
    store.closeDb();
    cleanup();
  });

  it('getMeta returns null for missing key', async () => {
    const store = await freshStore();
    expect(store.getMeta('nonexistent')).toBeNull();
  });

  it('setMeta and getMeta round-trip', async () => {
    const store = await freshStore();
    store.setMeta('last_id', '42');
    expect(store.getMeta('last_id')).toBe('42');
  });

  it('setMeta overwrites existing key', async () => {
    const store = await freshStore();
    store.setMeta('key', 'old');
    store.setMeta('key', 'new');
    expect(store.getMeta('key')).toBe('new');
  });
});

describe('Store — Reflexes & Maintenance', () => {
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = createTestDb();
    cleanup = ctx.cleanup;
  });

  afterEach(async () => {
    const store = await freshStore();
    store.closeDb();
    cleanup();
  });

  it('addReflex creates a reflex linked to a pattern', async () => {
    const store = await freshStore();
    const pattern = store.upsertPattern('command_freq', 'test', 'sig1', 0.9);
    const reflex = store.addReflex(pattern.id, 'context_injection', 'Always run tests');
    expect(reflex.pattern_id).toBe(pattern.id);
    expect(reflex.active).toBe(1);
    expect(reflex.content).toBe('Always run tests');
  });

  it('getActiveReflexes returns only active ones', async () => {
    const store = await freshStore();
    const p = store.upsertPattern('command_freq', 'test', 'sig1', 0.9);
    store.addReflex(p.id, 'context_injection', 'Active one');
    const db = store.getDb();
    const r2 = store.addReflex(p.id, 'context_injection', 'Inactive one');
    db.prepare('UPDATE reflexes SET active = 0 WHERE id = ?').run(r2.id);
    const active = store.getActiveReflexes();
    expect(active).toHaveLength(1);
    expect(active[0].content).toBe('Active one');
  });

  it('clearAll wipes everything', async () => {
    const store = await freshStore();
    store.addObservation('tool_use', 'cmd', 'Bash');
    store.upsertPattern('command_freq', 'test', 'sig1', 0.5);
    store.setMeta('key', 'val');
    store.clearAll();
    const stats = store.getStats();
    expect(stats.observations).toBe(0);
    expect(stats.patterns).toBe(0);
    expect(stats.reflexes).toBe(0);
    expect(store.getMeta('key')).toBeNull();
  });

  it('getStats returns correct counts', async () => {
    const store = await freshStore();
    store.addObservation('tool_use', 'a', 'Bash');
    store.addObservation('tool_use', 'b', 'Bash');
    store.upsertPattern('command_freq', 'test', 'sig1', 0.5);
    const stats = store.getStats();
    expect(stats.observations).toBe(2);
    expect(stats.patterns).toBe(1);
    expect(stats.reflexes).toBe(0);
  });

  it('cascade deletes reflexes when pattern is deleted', async () => {
    const store = await freshStore();
    const p = store.upsertPattern('command_freq', 'test', 'sig1', 0.9);
    store.addReflex(p.id, 'context_injection', 'Will be orphaned');
    expect(store.getActiveReflexes()).toHaveLength(1);
    store.deletePattern(p.id);
    expect(store.getActiveReflexes()).toHaveLength(0);
  });
});
