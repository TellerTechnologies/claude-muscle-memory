import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = join(import.meta.dirname, '../../dist/cli.js');

function cli(args: string[], opts?: { stdin?: string; dbPath?: string }) {
  const dbPath = opts?.dbPath ?? testDb;
  const result = spawnSync('node', [CLI, ...args], {
    input: opts?.stdin,
    env: { ...process.env, MUSCLE_MEMORY_DB: dbPath },
    encoding: 'utf-8',
    timeout: 10000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

let testDb: string;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mm-cli-test-'));
  testDb = join(tmpDir, 'test.db');
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('CLI — observe command', () => {
  it('accepts tool_use event via stdin JSON', () => {
    const r = cli(['observe', 'tool_use'], {
      stdin: '{"tool_name":"Bash","tool_input":{"command":"npm test"}}',
    });
    expect(r.exitCode).toBe(0);
  });

  it('extracts command from Bash tool_input', () => {
    cli(['observe', 'tool_use'], {
      stdin: '{"tool_name":"Bash","tool_input":{"command":"cargo build"}}',
    });
    const s = cli(['status']);
    expect(s.stdout).toContain('Observations:      1');
  });

  it('extracts file_path from Edit tool_input', () => {
    cli(['observe', 'tool_use'], {
      stdin: '{"tool_name":"Edit","tool_input":{"file_path":"/src/main.ts","old_string":"a","new_string":"b"}}',
    });
    const s = cli(['status']);
    expect(s.stdout).toContain('Observations:      1');
  });

  it('accepts user_prompt event', () => {
    cli(['observe', 'user_prompt'], {
      stdin: '{"prompt":"fix the login bug"}',
    });
    const s = cli(['status']);
    expect(s.stdout).toContain('Observations:      1');
  });

  it('handles non-JSON stdin gracefully', () => {
    const r = cli(['observe', 'tool_use'], { stdin: 'not json at all' });
    expect(r.exitCode).toBe(0); // stores raw
    const s = cli(['status']);
    expect(s.stdout).toContain('Observations:      1');
  });

  it('handles empty stdin gracefully', () => {
    const r = cli(['observe', 'tool_use'], { stdin: '' });
    expect(r.exitCode).toBe(0);
    const s = cli(['status']);
    expect(s.stdout).toContain('Observations:      0');
  });

  it('rejects invalid event types', () => {
    const r = cli(['observe', 'invalid_type'], { stdin: '{}' });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Invalid event type');
  });
});

describe('CLI — analyze command', () => {
  it('reports detected patterns on stderr', () => {
    for (let i = 0; i < 5; i++) {
      cli(['observe', 'tool_use'], {
        stdin: '{"tool_name":"Bash","tool_input":{"command":"pytest"}}',
      });
    }
    const r = cli(['analyze']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('patterns detected');
  });

  it('reports 0 patterns on second run with no new observations', () => {
    for (let i = 0; i < 5; i++) {
      cli(['observe', 'tool_use'], {
        stdin: '{"tool_name":"Bash","tool_input":{"command":"pytest"}}',
      });
    }
    cli(['analyze']); // first
    const r = cli(['analyze']); // second
    expect(r.stderr).toContain('0 patterns');
  });
});

describe('CLI — inject command', () => {
  it('outputs nothing when no active patterns exist', () => {
    const r = cli(['inject']);
    expect(r.stdout).toBe('');
  });

  it('outputs valid JSON with hookSpecificOutput when patterns are active', () => {
    // Create a pattern and train it to active strength
    cli(['train', 'always use TypeScript']);
    cli(['train', 'always use TypeScript']); // 0.6 → active
    const r = cli(['inject']);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toHaveProperty('hookSpecificOutput');
    expect(parsed.hookSpecificOutput).toHaveProperty('additionalContext');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('always use TypeScript');
  });

  it('separates reflexes from active patterns', () => {
    // Create a reflex-strength pattern
    cli(['train', 'prefer pnpm']);
    cli(['train', 'prefer pnpm']);
    cli(['train', 'prefer pnpm']); // 0.9 → reflex

    const r = cli(['inject']);
    const parsed = JSON.parse(r.stdout);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('Reflexes');
    expect(ctx).toContain('prefer pnpm');
  });
});

describe('CLI — status command', () => {
  it('shows box-drawing UI with stats', () => {
    const r = cli(['status']);
    expect(r.stdout).toContain('╔');
    expect(r.stdout).toContain('Claude Muscle Memory Status');
    expect(r.stdout).toContain('Observations:');
    expect(r.stdout).toContain('Patterns:');
  });

  it('shows patterns grouped by tier', () => {
    cli(['train', 'emerging pattern']); // 0.3 → emerging
    cli(['train', 'active pattern']);
    cli(['train', 'active pattern']); // 0.6 → active
    const r = cli(['status']);
    expect(r.stdout).toContain('Emerging');
    expect(r.stdout).toContain('Active');
  });

  it('shows "no patterns" message when empty', () => {
    const r = cli(['status']);
    expect(r.stdout).toContain('No patterns detected');
  });
});

describe('CLI — train command', () => {
  it('creates a new pattern', () => {
    const r = cli(['train', 'always use semicolons']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Created new pattern');
    expect(r.stdout).toContain('always use semicolons');
  });

  it('reinforces an existing pattern', () => {
    cli(['train', 'always use semicolons']);
    const r = cli(['train', 'semicolons']); // partial match finds it
    expect(r.stdout).toContain('Reinforced pattern');
  });

  it('errors with no description', () => {
    const r = cli(['train']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Usage');
  });
});

describe('CLI — forget command', () => {
  it('removes a pattern by description', () => {
    cli(['train', 'use tabs']);
    const r = cli(['forget', 'tabs']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Removed pattern');
    // Verify it's gone
    const s = cli(['status']);
    expect(s.stdout).toContain('Patterns:          0');
  });

  it('removes a pattern by numeric ID', () => {
    cli(['train', 'use tabs']);
    const r = cli(['forget', '1']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Removed pattern');
  });

  it('errors when no match found', () => {
    const r = cli(['forget', 'nonexistent_pattern_xyz']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('No pattern found');
  });

  it('errors with no description', () => {
    const r = cli(['forget']);
    expect(r.exitCode).toBe(1);
  });
});

describe('CLI — reset command', () => {
  it('clears all data', () => {
    cli(['observe', 'tool_use'], {
      stdin: '{"tool_name":"Bash","tool_input":{"command":"npm test"}}',
    });
    cli(['train', 'some pattern']);
    const r = cli(['reset']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('cleared');
    const s = cli(['status']);
    expect(s.stdout).toContain('Observations:      0');
    expect(s.stdout).toContain('Patterns:          0');
  });
});

describe('CLI — error handling', () => {
  it('shows usage for unknown command', () => {
    const r = cli(['bogus']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Usage');
  });

  it('shows usage for no command', () => {
    const r = cli([]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Usage');
  });
});
