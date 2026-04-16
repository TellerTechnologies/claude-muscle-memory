import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers.js';
import { analyzePatterns } from '../patterns.js';
import * as store from '../store.js';

describe('Patterns — Command Frequency Detector', () => {
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = createTestDb();
    cleanup = ctx.cleanup;
  });

  afterEach(() => {
    store.closeDb();
    cleanup();
  });

  it('detects a command used 3+ times', () => {
    for (let i = 0; i < 4; i++) {
      store.addObservation('tool_use', 'npm test', 'Bash');
    }
    const detected = analyzePatterns();
    const cmdFreq = detected.filter(d => d.type === 'command_freq');
    expect(cmdFreq.length).toBeGreaterThanOrEqual(1);
    expect(cmdFreq[0].description).toContain('npm');
  });

  it('does not detect commands with fewer than 3 occurrences', () => {
    store.addObservation('tool_use', 'npm test', 'Bash');
    store.addObservation('tool_use', 'npm test', 'Bash');
    store.addObservation('tool_use', 'cargo build', 'Bash'); // padding to reach 3 total
    const detected = analyzePatterns();
    const cmdFreq = detected.filter(d => d.type === 'command_freq');
    // npm only has 2, cargo only has 1 — neither should fire
    expect(cmdFreq).toHaveLength(0);
  });

  it('normalizes piped commands to the base command', () => {
    // "cat file | grep foo" → base command "cat"
    for (let i = 0; i < 4; i++) {
      store.addObservation('tool_use', 'cat /tmp/log | grep error', 'Bash');
    }
    const detected = analyzePatterns();
    const cmdFreq = detected.filter(d => d.type === 'command_freq');
    expect(cmdFreq.length).toBe(1);
    expect(cmdFreq[0].description).toContain('cat');
  });

  it('normalizes chained commands (&&)', () => {
    for (let i = 0; i < 4; i++) {
      store.addObservation('tool_use', 'cd /tmp && ls -la', 'Bash');
    }
    const detected = analyzePatterns();
    const cmdFreq = detected.filter(d => d.type === 'command_freq');
    expect(cmdFreq[0].description).toContain('cd');
  });

  it('only counts Bash tool observations', () => {
    // Edit tool observations should not contribute to command frequency
    for (let i = 0; i < 5; i++) {
      store.addObservation('tool_use', '/src/main.ts', 'Edit');
    }
    const detected = analyzePatterns();
    const cmdFreq = detected.filter(d => d.type === 'command_freq');
    expect(cmdFreq).toHaveLength(0);
  });

  it('creates distinct patterns for distinct commands', () => {
    for (let i = 0; i < 4; i++) {
      store.addObservation('tool_use', 'npm test', 'Bash');
      store.addObservation('tool_use', 'npm run build', 'Bash');
    }
    const detected = analyzePatterns();
    const cmdFreq = detected.filter(d => d.type === 'command_freq');
    // Both "npm" variants normalize to "npm" — should be 1 pattern
    expect(cmdFreq).toHaveLength(1);
  });
});

describe('Patterns — Edit Sequence Detector', () => {
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = createTestDb();
    cleanup = ctx.cleanup;
  });

  afterEach(() => {
    store.closeDb();
    cleanup();
  });

  it('detects a repeating 2-tool sequence', () => {
    // Edit → Bash → Edit → Bash → Edit → Bash (3 repetitions of Edit → Bash)
    for (let i = 0; i < 3; i++) {
      store.addObservation('tool_use', '/src/main.ts', 'Edit');
      store.addObservation('tool_use', 'npm test', 'Bash');
    }
    const detected = analyzePatterns();
    const seqs = detected.filter(d => d.type === 'sequence');
    expect(seqs.length).toBeGreaterThanOrEqual(1);
    expect(seqs.some(s => s.description.includes('Edit') && s.description.includes('Bash'))).toBe(true);
  });

  it('detects a repeating 3-tool sequence', () => {
    // Need 3+ repetitions for count >= 2 (detector compares adjacent windows)
    for (let i = 0; i < 4; i++) {
      store.addObservation('tool_use', '/src/main.ts', 'Read');
      store.addObservation('tool_use', '/src/main.ts', 'Edit');
      store.addObservation('tool_use', 'npm test', 'Bash');
    }
    const detected = analyzePatterns();
    const seqs = detected.filter(d => d.type === 'sequence');
    expect(seqs.some(s => s.description.includes('Read') && s.description.includes('Edit'))).toBe(true);
  });

  it('requires at least 6 tool observations to detect sequences', () => {
    // Only 4 observations — below the threshold
    store.addObservation('tool_use', 'a', 'Edit');
    store.addObservation('tool_use', 'b', 'Bash');
    store.addObservation('tool_use', 'a', 'Edit');
    store.addObservation('tool_use', 'b', 'Bash');
    const detected = analyzePatterns();
    const seqs = detected.filter(d => d.type === 'sequence');
    expect(seqs).toHaveLength(0);
  });
});

describe('Patterns — Correction Detector', () => {
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = createTestDb();
    cleanup = ctx.cleanup;
  });

  afterEach(() => {
    store.closeDb();
    cleanup();
  });

  it('detects correction when user says "no" after a tool use', () => {
    // Create the pattern twice (threshold = 2)
    for (let i = 0; i < 2; i++) {
      store.addObservation('tool_use', 'grep -r pattern .', 'Bash');
      store.addObservation('user_prompt', 'no, use rg instead of grep');
    }
    const detected = analyzePatterns();
    const corrections = detected.filter(d => d.type === 'correction');
    expect(corrections.length).toBeGreaterThanOrEqual(1);
    expect(corrections.some(c => c.description.includes('rg instead'))).toBe(true);
  });

  it('detects various correction markers', () => {
    const markers = [
      "actually, use pnpm",
      "don't use npm",
      "stop using grep",
      "use rg instead of grep",
      "wrong, it should be yarn",
      "instead, run cargo test",
    ];
    // Each marker needs 2 occurrences after a tool use
    for (const marker of markers) {
      store.addObservation('tool_use', 'some command', 'Bash');
      store.addObservation('user_prompt', marker);
      store.addObservation('tool_use', 'some command', 'Bash');
      store.addObservation('user_prompt', marker);
    }
    const detected = analyzePatterns();
    const corrections = detected.filter(d => d.type === 'correction');
    expect(corrections.length).toBeGreaterThan(0);
  });

  it('does not detect non-correction prompts as corrections', () => {
    for (let i = 0; i < 3; i++) {
      store.addObservation('tool_use', 'npm test', 'Bash');
      store.addObservation('user_prompt', 'great, now build the project');
    }
    const detected = analyzePatterns();
    const corrections = detected.filter(d => d.type === 'correction');
    expect(corrections).toHaveLength(0);
  });

  it('detects "always/never" directives only at prompt start and with 2+ occurrences', () => {
    // Need 3+ total observations for analyzePatterns to run
    store.addObservation('tool_use', 'npm test', 'Bash'); // padding
    store.addObservation('user_prompt', 'always use TypeScript');
    store.addObservation('user_prompt', 'fix the login bug'); // padding

    let detected = analyzePatterns();
    let directives = detected.filter(d => d.metadata.source === 'explicit');
    // Single "always" occurrence — should NOT create a pattern
    expect(directives).toHaveLength(0);

    // Add second occurrence + new observation so analyze triggers
    store.addObservation('user_prompt', 'always use TypeScript');
    detected = analyzePatterns();
    directives = detected.filter(d => d.metadata.source === 'explicit');
    expect(directives.length).toBeGreaterThanOrEqual(1);
  });

  it('does not detect "always/never" in the middle of a sentence', () => {
    for (let i = 0; i < 3; i++) {
      store.addObservation('user_prompt', 'I can never remember the syntax for destructuring');
    }
    const detected = analyzePatterns();
    const directives = detected.filter(d => d.metadata.source === 'explicit');
    expect(directives).toHaveLength(0);
  });
});

describe('Patterns — Preference Detector', () => {
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = createTestDb();
    cleanup = ctx.cleanup;
  });

  afterEach(() => {
    store.closeDb();
    cleanup();
  });

  it('detects frequently used file extensions', () => {
    for (let i = 0; i < 6; i++) {
      store.addObservation('tool_use', `/src/file${i}.ts`, 'Edit');
    }
    const detected = analyzePatterns();
    const prefs = detected.filter(d => d.type === 'preference');
    expect(prefs.some(p => p.description.includes('.ts'))).toBe(true);
  });

  it('requires 5+ observations for file extension preference', () => {
    for (let i = 0; i < 4; i++) {
      store.addObservation('tool_use', `/src/file${i}.rs`, 'Edit');
    }
    const detected = analyzePatterns();
    const prefs = detected.filter(d => d.type === 'preference' && d.description.includes('.rs'));
    expect(prefs).toHaveLength(0);
  });

  it('detects dominant tool usage', () => {
    // Bash used 15 times, Edit used 3 → Bash is >40% and >=10
    for (let i = 0; i < 15; i++) {
      store.addObservation('tool_use', `cmd_${i}`, 'Bash');
    }
    for (let i = 0; i < 3; i++) {
      store.addObservation('tool_use', `/file${i}.ts`, 'Edit');
    }
    const detected = analyzePatterns();
    const prefs = detected.filter(d => d.type === 'preference' && d.description.includes('Bash'));
    expect(prefs).toHaveLength(1);
  });

  it('does not flag tool as dominant if below 40% ratio', () => {
    // Even distribution: each tool 5 times
    for (let i = 0; i < 5; i++) {
      store.addObservation('tool_use', `cmd_${i}`, 'Bash');
      store.addObservation('tool_use', `/file${i}.ts`, 'Edit');
      store.addObservation('tool_use', `/file${i}.ts`, 'Read');
    }
    const detected = analyzePatterns();
    const prefs = detected.filter(d => d.type === 'preference' && d.description.includes('Heavy use'));
    expect(prefs).toHaveLength(0);
  });
});

describe('Patterns — Inflation Guard', () => {
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = createTestDb();
    cleanup = ctx.cleanup;
  });

  afterEach(() => {
    store.closeDb();
    cleanup();
  });

  it('second analyze with no new observations returns 0 patterns', () => {
    for (let i = 0; i < 5; i++) {
      store.addObservation('tool_use', 'npm test', 'Bash');
    }
    const first = analyzePatterns();
    expect(first.length).toBeGreaterThan(0);

    // Second analyze — no new observations
    const second = analyzePatterns();
    expect(second).toHaveLength(0);
  });

  it('strength does not increase without new observations', () => {
    for (let i = 0; i < 5; i++) {
      store.addObservation('tool_use', 'npm test', 'Bash');
    }
    analyzePatterns();
    const strengthAfterFirst = store.getAllPatterns()[0].strength;

    // Run analyze 5 more times
    for (let i = 0; i < 5; i++) {
      analyzePatterns();
    }
    const strengthAfterMany = store.getAllPatterns()[0].strength;
    expect(strengthAfterMany).toBeCloseTo(strengthAfterFirst);
  });

  it('strength increases when new observations arrive', () => {
    for (let i = 0; i < 5; i++) {
      store.addObservation('tool_use', 'npm test', 'Bash');
    }
    analyzePatterns();
    const first = store.getAllPatterns()[0].strength;

    // Add more observations
    for (let i = 0; i < 3; i++) {
      store.addObservation('tool_use', 'npm test', 'Bash');
    }
    analyzePatterns();
    const second = store.getAllPatterns()[0].strength;
    expect(second).toBeGreaterThan(first);
  });
});

describe('Patterns — Signature Dedup', () => {
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = createTestDb();
    cleanup = ctx.cleanup;
  });

  afterEach(() => {
    store.closeDb();
    cleanup();
  });

  it('same command frequency produces same signature', () => {
    for (let i = 0; i < 5; i++) {
      store.addObservation('tool_use', 'cargo test', 'Bash');
    }
    analyzePatterns();
    // Reset and add more
    store.setMeta('last_analyzed_observation_id', '0');
    for (let i = 0; i < 3; i++) {
      store.addObservation('tool_use', 'cargo test', 'Bash');
    }
    analyzePatterns();

    // Should be one pattern, not two
    const patterns = store.getAllPatterns().filter(p => p.type === 'command_freq');
    expect(patterns).toHaveLength(1);
    expect(patterns[0].occurrences).toBeGreaterThan(1);
  });
});
