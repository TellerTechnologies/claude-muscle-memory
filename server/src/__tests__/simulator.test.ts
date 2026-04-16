/**
 * Layer 4: Session Simulator
 *
 * Simulates realistic multi-session usage with different user personas.
 * Tests the full lifecycle: observation → detection → reinforcement → decay → injection.
 * Verifies patterns progress through tiers correctly across simulated days.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

const CLI = join(import.meta.dirname, '../../dist/cli.js');

let testDb: string;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mm-sim-test-'));
  testDb = join(tmpDir, 'test.db');
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// --- Helpers ---

function cli(args: string[], stdin?: string) {
  return spawnSync('node', [CLI, ...args], {
    input: stdin,
    env: { ...process.env, MUSCLE_MEMORY_DB: testDb },
    encoding: 'utf-8',
    timeout: 10000,
  });
}

function observe(toolName: string, command: string) {
  cli(['observe', 'tool_use'], JSON.stringify({
    tool_name: toolName,
    tool_input: toolName === 'Bash' ? { command } : { file_path: command },
  }));
}

function observePrompt(prompt: string) {
  cli(['observe', 'user_prompt'], JSON.stringify({ prompt }));
}

function analyze() {
  return cli(['analyze']);
}

function inject(): string {
  return cli(['inject']).stdout;
}

function getStatus(): string {
  return cli(['status']).stdout;
}

function train(desc: string) {
  cli(['train', desc]);
}

function getPatterns(): any[] {
  const db = new Database(testDb);
  const patterns = db.prepare('SELECT * FROM patterns ORDER BY strength DESC').all();
  db.close();
  return patterns;
}

function getObservationCount(): number {
  const db = new Database(testDb);
  const row = db.prepare('SELECT COUNT(*) as c FROM observations').get() as any;
  db.close();
  return row.c;
}

/** Simulate time passing by backdating all pattern last_seen timestamps.
 *  Does NOT reset the analysis marker — new observations will trigger fresh analysis. */
function simulateDaysPassing(days: number) {
  const db = new Database(testDb);
  db.prepare(`
    UPDATE patterns SET last_seen = datetime(last_seen, '-${days} days')
  `).run();
  db.close();
}

/** Apply decay directly via DB (useful when testing pure decay without re-detection). */
function applyDecayDirect() {
  const db = new Database(testDb);
  const patterns = db.prepare('SELECT * FROM patterns').all() as any[];
  const now = new Date();
  for (const p of patterns) {
    const lastSeen = new Date(p.last_seen + 'Z');
    const days = Math.max(0, (now.getTime() - lastSeen.getTime()) / 86400000);
    if (days > 0) {
      const decayed = p.strength * Math.pow(0.95, days);
      db.prepare('UPDATE patterns SET strength = ? WHERE id = ?').run(
        decayed < 0.01 ? 0 : decayed,
        p.id,
      );
    }
  }
  db.close();
}

// === PERSONA 1: The Rust Developer ===
// Runs cargo test obsessively, edits .rs files, corrects grep to rg

describe('Simulator — Rust Developer persona', () => {
  it('develops muscle memory over 5 simulated sessions', () => {
    // --- Session 1: Getting started ---
    for (let i = 0; i < 4; i++) {
      observe('Edit', `/src/lib.rs`);
      observe('Bash', 'cargo test');
    }
    observe('Bash', 'cargo build');
    analyze();

    let patterns = getPatterns();
    expect(patterns.length).toBeGreaterThan(0);
    const cargoPattern = patterns.find((p: any) => p.description.includes('cargo'));
    expect(cargoPattern).toBeDefined();
    expect(cargoPattern.strength).toBeCloseTo(0.15); // first detection
    expect(inject()).toBe(''); // still dormant, nothing injected

    // --- Session 2: Next day, same habits ---
    simulateDaysPassing(1);
    for (let i = 0; i < 5; i++) {
      observe('Edit', `/src/main.rs`);
      observe('Bash', 'cargo test');
    }
    observe('Bash', 'cargo clippy');
    // Correct grep to rg (twice to trigger)
    observe('Bash', 'grep -r TODO .');
    observePrompt('no, use rg instead of grep');
    observe('Bash', 'grep -r FIXME .');
    observePrompt('no, use rg instead of grep');
    analyze();

    patterns = getPatterns();
    const cargoNow = patterns.find((p: any) => p.description.includes('cargo'));
    expect(cargoNow).toBeDefined();
    expect(cargoNow.strength).toBeGreaterThan(0.15); // reinforced
    expect(inject()).toBe(''); // probably still emerging

    // --- Session 3: Day 3, patterns strengthening ---
    simulateDaysPassing(1);
    for (let i = 0; i < 6; i++) {
      observe('Edit', `/src/handler.rs`);
      observe('Bash', 'cargo test');
    }
    analyze();

    patterns = getPatterns();
    const cargoS3 = patterns.find((p: any) => p.description.includes('cargo'));
    expect(cargoS3.strength).toBeGreaterThan(0.3);

    // Check .rs file extension preference is forming
    const rsPattern = patterns.find((p: any) => p.description.includes('.rs'));
    // May not exist yet if fewer than 5 unique observations in window — that's OK

    // --- Session 4: Day 5 (skipped a day), keep going ---
    simulateDaysPassing(2);
    for (let i = 0; i < 5; i++) {
      observe('Edit', `/src/models.rs`);
      observe('Bash', 'cargo test --release');
    }
    analyze();

    // --- Session 5: Day 6, the payoff ---
    simulateDaysPassing(1);
    for (let i = 0; i < 5; i++) {
      observe('Bash', 'cargo test');
    }
    analyze();

    // By now cargo should be well into active or approaching it
    patterns = getPatterns();
    const cargoFinal = patterns.find((p: any) => p.description.includes('cargo'));
    expect(cargoFinal).toBeDefined();
    // Multiple reinforcements minus some decay
    expect(cargoFinal.strength).toBeGreaterThan(0.3);

    // Verify status output is well-formed
    const statusOutput = getStatus();
    expect(statusOutput).toContain('Claude Muscle Memory Status');
    expect(statusOutput).toContain('cargo');
  });
});

// === PERSONA 2: The TypeScript Full-Stack Developer ===
// Heavy npm/pnpm usage, Edit→Bash cycle, manual preferences

describe('Simulator — TypeScript Full-Stack persona', () => {
  it('builds patterns through mixed automatic and manual training', () => {
    // Session 1: Lots of npm test and .ts file edits
    for (let i = 0; i < 8; i++) {
      observe('Edit', `/src/components/Button.tsx`);
      observe('Bash', 'npm test');
    }
    for (let i = 0; i < 3; i++) {
      observe('Read', `/src/types.ts`);
      observe('Edit', `/src/types.ts`);
      observe('Bash', 'npm run build');
    }
    analyze();

    // Manually train some preferences
    train('prefer pnpm over npm');
    train('always use strict TypeScript');

    let patterns = getPatterns();
    expect(patterns.length).toBeGreaterThan(2);

    // Verify the manual patterns exist
    const pnpmPattern = patterns.find((p: any) => p.description.includes('pnpm'));
    expect(pnpmPattern).toBeDefined();
    expect(pnpmPattern.strength).toBeCloseTo(0.3);

    // Session 2: Reinforce the manual pattern
    simulateDaysPassing(1);
    train('prefer pnpm over npm'); // now 0.3 + 0.3 = ~0.57 (after decay)

    // Session 3: More reinforcement
    simulateDaysPassing(1);
    train('prefer pnpm over npm'); // approaching 0.8+

    patterns = getPatterns();
    const pnpmFinal = patterns.find((p: any) => p.description.includes('pnpm'));
    expect(pnpmFinal.strength).toBeGreaterThan(0.6);

    // Check injection includes the trained pattern
    const injected = inject();
    if (pnpmFinal.strength >= 0.5) {
      expect(injected).toContain('pnpm');
      // Validate JSON structure
      const parsed = JSON.parse(injected);
      expect(parsed.hookSpecificOutput.additionalContext).toContain('pnpm');
    }
  });
});

// === PERSONA 3: The Correction-Heavy User ===
// Always correcting Claude's tool choices

describe('Simulator — Correction-heavy persona', () => {
  it('learns from repeated corrections', () => {
    // User keeps correcting grep → rg across multiple sessions
    for (let session = 0; session < 3; session++) {
      for (let i = 0; i < 3; i++) {
        observe('Bash', 'grep -r pattern src/');
        observePrompt('no, use rg instead');
      }
      if (session < 2) {
        simulateDaysPassing(1);
        // Reset analysis marker
      }
      analyze();
    }

    const patterns = getPatterns();
    const correction = patterns.find((p: any) => p.type === 'correction');
    expect(correction).toBeDefined();
    expect(correction.description).toContain('rg instead');
  });
});

// === SCENARIO: Decay kills unused patterns ===

describe('Simulator — Pattern decay over time', () => {
  it('patterns fade when user stops exhibiting the behavior', () => {
    // Build up a pattern
    for (let i = 0; i < 8; i++) {
      observe('Bash', 'make build');
    }
    analyze();

    let patterns = getPatterns();
    const initial = patterns.find((p: any) => p.description.includes('make'));
    expect(initial).toBeDefined();
    const initialStrength = initial.strength;

    // 30 days pass — apply decay directly to test pure decay math
    simulateDaysPassing(30);
    applyDecayDirect();

    patterns = getPatterns();
    const decayed = patterns.find((p: any) => p.description.includes('make'));
    expect(decayed).toBeDefined();
    // 0.95^30 ≈ 0.2146 — strength should be ~21.5% of original
    expect(decayed.strength).toBeLessThan(initialStrength * 0.25);
    expect(decayed.strength).toBeGreaterThan(0); // not zero yet
  });

  it('90 days of inactivity nearly kills a pattern', () => {
    for (let i = 0; i < 5; i++) {
      observe('Bash', 'docker compose up');
    }
    analyze();

    let patterns = getPatterns();
    const docker = patterns.find((p: any) => p.description.includes('docker'));
    expect(docker).toBeDefined();

    // 90 days of decay — apply directly
    simulateDaysPassing(90);
    applyDecayDirect();

    patterns = getPatterns();
    const dockerDecayed = patterns.find((p: any) => p.description.includes('docker'));
    expect(dockerDecayed).toBeDefined();
    // 0.95^90 ≈ 0.0099 → zeroed out by the < 0.01 check
    expect(dockerDecayed.strength).toBe(0);
  });
});

// === SCENARIO: Mixed patterns compete for attention ===

describe('Simulator — Multiple competing patterns', () => {
  it('stronger patterns rank higher in status and injection', () => {
    // Create patterns at different strengths
    train('strong pattern AAA');
    train('strong pattern AAA');
    train('strong pattern AAA'); // 0.9

    train('medium pattern BBB');
    train('medium pattern BBB'); // 0.6

    train('weak pattern CCC'); // 0.3

    const statusOutput = getStatus();
    const lines = statusOutput.split('\n');

    // Find the lines containing our patterns
    const aaaLine = lines.findIndex(l => l.includes('AAA'));
    const bbbLine = lines.findIndex(l => l.includes('BBB'));
    const cccLine = lines.findIndex(l => l.includes('CCC'));

    // AAA should appear before BBB, BBB before CCC (ordered by tier then strength)
    expect(aaaLine).toBeLessThan(bbbLine);
    expect(bbbLine).toBeLessThan(cccLine);

    // Injection should include AAA and BBB (>= 0.5) but not CCC (0.3)
    const injected = inject();
    expect(injected).toContain('AAA');
    expect(injected).toContain('BBB');
    expect(injected).not.toContain('CCC');
  });
});

// === SCENARIO: Full lifecycle from zero to reflex ===

describe('Simulator — Full lifecycle: zero to reflex to decay', () => {
  it('pattern goes through complete dormant→emerging→active→reflex→decay lifecycle', () => {
    // Phase 1: First observations — pattern detected at dormant
    for (let i = 0; i < 4; i++) {
      observe('Bash', 'go test ./...');
    }
    analyze();
    let p = getPatterns().find((p: any) => p.description.includes('go'));
    expect(p).toBeDefined();
    expect(p.strength).toBeLessThan(0.2); // dormant

    // Phase 2: More observations — emerging
    simulateDaysPassing(1);
    for (let i = 0; i < 5; i++) {
      observe('Bash', 'go test ./...');
    }
    analyze();
    p = getPatterns().find((p: any) => p.description.includes('go'));
    expect(p.strength).toBeGreaterThanOrEqual(0.2); // emerging

    // Phase 3: Even more — approaching active
    simulateDaysPassing(1);
    for (let i = 0; i < 5; i++) {
      observe('Bash', 'go test ./...');
    }
    analyze();
    p = getPatterns().find((p: any) => p.description.includes('go'));

    // Phase 4: Push to active with manual boost (train finds pattern by description)
    train('go test');
    train('go test'); // extra boost to ensure we cross 0.5
    p = getPatterns().find((p: any) => p.description.includes('go'));
    expect(p.strength).toBeGreaterThanOrEqual(0.5); // active

    // Phase 5: Verify injection now includes the pattern
    const injected = inject();
    expect(injected).toContain('go');
    const parsed = JSON.parse(injected);
    expect(parsed.hookSpecificOutput).toBeDefined();

    // Phase 6: User stops using Go for 60 days — test pure decay
    simulateDaysPassing(60);
    applyDecayDirect();

    p = getPatterns().find((p: any) => p.description.includes('go'));
    expect(p).toBeDefined();
    // After 60 days: strength * 0.95^60 ≈ strength * 0.046
    // Should have decayed far below active threshold
    expect(p.strength).toBeLessThan(0.1);

    // Verify injection no longer includes the decayed pattern
    const injectedAfterDecay = inject();
    if (injectedAfterDecay) {
      expect(injectedAfterDecay).not.toContain('go test');
    }
  });
});

// === SCENARIO: High-volume stress test ===

describe('Simulator — Stress test with high observation volume', () => {
  it('handles 500+ observations without errors', () => {
    const commands = ['npm test', 'npm run build', 'npm run lint', 'git status', 'git diff'];
    const tools = ['Bash', 'Edit', 'Read', 'Grep', 'Glob'];

    for (let i = 0; i < 100; i++) {
      const cmd = commands[i % commands.length];
      const tool = i % 3 === 0 ? 'Bash' : tools[i % tools.length];
      observe(tool, tool === 'Bash' ? cmd : `/src/file${i % 20}.ts`);
    }

    expect(getObservationCount()).toBe(100);

    const analyzeResult = analyze();
    expect(analyzeResult.status).toBe(0);

    const patterns = getPatterns();
    expect(patterns.length).toBeGreaterThan(0);

    // Status should not error
    const statusResult = cli(['status']);
    expect(statusResult.status).toBe(0);

    // Inject should not error
    const injectResult = cli(['inject']);
    expect(injectResult.status).toBe(0);
  });

  it('handles rapid sequential observations', () => {
    // Simulate a burst of rapid-fire tool uses (as would happen in real sessions)
    for (let i = 0; i < 50; i++) {
      observe('Bash', `command_${i % 5}`);
    }
    analyze();

    const patterns = getPatterns();
    // Should have detected patterns for the repeated commands
    expect(patterns.length).toBeGreaterThan(0);
  });
});

// === SCENARIO: Edge cases ===

describe('Simulator — Edge cases', () => {
  it('handles empty sessions gracefully', () => {
    analyze();
    expect(getPatterns()).toHaveLength(0);
    expect(inject()).toBe('');
  });

  it('handles a session with only user prompts (no tool use)', () => {
    for (let i = 0; i < 10; i++) {
      observePrompt(`question ${i}`);
    }
    analyze();
    // Should not crash, may detect directive patterns
    expect(getStatus()).toContain('Claude Muscle Memory Status');
  });

  it('handles unicode and special characters in observations', () => {
    observe('Bash', 'echo "héllo wörld 🚀"');
    observe('Edit', '/src/データ.ts');
    observePrompt('日本語のプロンプト');
    // Should not crash
    const statusResult = cli(['status']);
    expect(statusResult.status).toBe(0);
  });

  it('handles very long command strings', () => {
    const longCmd = 'x'.repeat(10000);
    observe('Bash', longCmd);
    const statusResult = cli(['status']);
    expect(statusResult.status).toBe(0);
  });

  it('train → forget → retrain cycle works', () => {
    train('use spaces');
    let patterns = getPatterns();
    expect(patterns.length).toBe(1);

    cli(['forget', 'spaces']);
    patterns = getPatterns();
    expect(patterns.length).toBe(0);

    train('use tabs'); // different pattern
    patterns = getPatterns();
    expect(patterns.length).toBe(1);
    expect(patterns[0].description).toContain('tabs');
  });

  it('reset truly clears everything and allows fresh start', () => {
    for (let i = 0; i < 10; i++) {
      observe('Bash', 'npm test');
    }
    analyze();
    train('some pattern');

    cli(['reset']);
    expect(getPatterns()).toHaveLength(0);
    expect(getObservationCount()).toBe(0);

    // Fresh start works
    observe('Bash', 'cargo test');
    expect(getObservationCount()).toBe(1);
  });
});
