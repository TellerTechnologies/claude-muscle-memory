import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, execFile, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach } from 'vitest';

const CLI_PATH = join(import.meta.dirname, '../../dist/cli.js');
const MCP_PATH = join(import.meta.dirname, '../../dist/mcp-server.js');
const BIN_PATH = join(import.meta.dirname, '../../bin/muscle-memory');

/** Create an isolated temp DB and set the env var. Returns cleanup function. */
export function createTestDb(): { dbPath: string; cleanup: () => void } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'muscle-memory-test-'));
  const dbPath = join(tmpDir, 'test.db');
  process.env.MUSCLE_MEMORY_DB = dbPath;
  return {
    dbPath,
    cleanup: () => {
      delete process.env.MUSCLE_MEMORY_DB;
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    },
  };
}

/** Vitest hooks that auto-create/teardown a test DB per test. */
export function useTestDb() {
  let ctx: ReturnType<typeof createTestDb>;
  beforeEach(() => {
    ctx = createTestDb();
  });
  afterEach(() => {
    // Close the module-level DB singleton if it was opened
    // We'll need to dynamically import store to call closeDb
    ctx.cleanup();
  });
  return {
    get dbPath() { return ctx.dbPath; },
  };
}

/** Run a CLI command with an isolated DB. Returns { stdout, stderr, exitCode }. */
export function runCli(
  args: string[],
  options?: { stdin?: string; env?: Record<string, string>; dbPath?: string },
): { stdout: string; stderr: string; exitCode: number } {
  const dbPath = options?.dbPath ?? process.env.MUSCLE_MEMORY_DB;
  const env = {
    ...process.env,
    ...options?.env,
    ...(dbPath ? { MUSCLE_MEMORY_DB: dbPath } : {}),
  };
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      input: options?.stdin,
      env,
      encoding: 'utf-8',
      timeout: 10000,
    });
    // stderr is inherited by default with execFileSync, use spawnSync for capture
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      exitCode: err.status ?? 1,
    };
  }
}

/** Run CLI and capture both stdout and stderr properly. */
export function runCliFull(
  args: string[],
  options?: { stdin?: string; env?: Record<string, string>; dbPath?: string },
): { stdout: string; stderr: string; exitCode: number } {
  const { spawnSync } = await_child_process();
  const dbPath = options?.dbPath ?? process.env.MUSCLE_MEMORY_DB;
  const env = {
    ...process.env,
    ...options?.env,
    ...(dbPath ? { MUSCLE_MEMORY_DB: dbPath } : {}),
  };
  const result = spawnSync('node', [CLI_PATH, ...args], {
    input: options?.stdin,
    env,
    encoding: 'utf-8',
    timeout: 10000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

function await_child_process() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('node:child_process') as typeof import('node:child_process');
}

/** Pipe a tool_use observation into the CLI. */
export function observeToolUse(
  toolName: string,
  toolInput: Record<string, unknown>,
  dbPath?: string,
): void {
  const json = JSON.stringify({ tool_name: toolName, tool_input: toolInput });
  runCli(['observe', 'tool_use'], { stdin: json, dbPath });
}

/** Pipe a user_prompt observation into the CLI. */
export function observePrompt(prompt: string, dbPath?: string): void {
  const json = JSON.stringify({ prompt });
  runCli(['observe', 'user_prompt'], { stdin: json, dbPath });
}

/** Run analyze and return stderr output. */
export function analyze(dbPath?: string): string {
  const result = runCliFull(['analyze'], { dbPath });
  return result.stderr;
}

/** Run inject and return stdout (JSON or empty). */
export function inject(dbPath?: string): string {
  const result = runCli(['inject'], { dbPath });
  return result.stdout;
}

/** Run status and return stdout. */
export function status(dbPath?: string): string {
  const result = runCli(['status'], { dbPath });
  return result.stdout;
}

/** Send a JSON-RPC request to the MCP server and get the response. */
export async function mcpRequest(
  method: string,
  params: Record<string, unknown>,
  dbPath?: string,
): Promise<any> {
  const { spawn } = await import('node:child_process');
  const db = dbPath ?? process.env.MUSCLE_MEMORY_DB;

  return new Promise((resolve, reject) => {
    const proc = spawn('node', [MCP_PATH], {
      env: { ...process.env, ...(db ? { MUSCLE_MEMORY_DB: db } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      // Parse the last JSON-RPC response from stdout
      try {
        const lines = stdout.split('\n').filter(l => l.trim());
        const lastLine = lines[lines.length - 1];
        resolve(JSON.parse(lastLine));
      } catch {
        resolve({ stdout, stderr, code });
      }
    });

    // Send JSON-RPC message
    const msg = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    });
    // MCP uses Content-Length header framing
    const frame = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;
    proc.stdin.write(frame);

    // Give the server time to process, then close stdin
    setTimeout(() => {
      proc.stdin.end();
    }, 2000);

    // Safety timeout
    setTimeout(() => {
      proc.kill();
      reject(new Error('MCP request timed out'));
    }, 8000);
  });
}

export { CLI_PATH, MCP_PATH, BIN_PATH };
