import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const MCP_SERVER = join(import.meta.dirname, '../../dist/mcp-server.js');
const CLI = join(import.meta.dirname, '../../dist/cli.js');

let testDb: string;
let tmpDir: string;

function seedCli(args: string[], stdin?: string) {
  spawnSync('node', [CLI, ...args], {
    input: stdin,
    env: { ...process.env, MUSCLE_MEMORY_DB: testDb },
    encoding: 'utf-8',
    timeout: 10000,
  });
}

async function createMcpClient(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [MCP_SERVER],
    env: { ...process.env, MUSCLE_MEMORY_DB: testDb } as Record<string, string>,
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mm-mcp-test-'));
  testDb = join(tmpDir, 'test.db');
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('MCP — Server initialization', () => {
  it('connects and reports server info', async () => {
    const client = await createMcpClient();
    const info = client.getServerVersion();
    expect(info).toBeDefined();
    expect(info!.name).toBe('muscle-memory');
    expect(info!.version).toBe('0.1.0');
    await client.close();
  });
});

describe('MCP — tools/list', () => {
  it('lists all 4 tools', async () => {
    const client = await createMcpClient();
    const tools = await client.listTools();
    const names = tools.tools.map(t => t.name).sort();
    expect(names).toEqual([
      'muscle_memory_forget',
      'muscle_memory_status',
      'muscle_memory_suggest',
      'muscle_memory_train',
    ]);
    await client.close();
  });

  it('each tool has a description and input schema', async () => {
    const client = await createMcpClient();
    const tools = await client.listTools();
    for (const tool of tools.tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    }
    await client.close();
  });
});

describe('MCP — muscle_memory_status tool', () => {
  it('returns empty message when no patterns exist', async () => {
    const client = await createMcpClient();
    const result = await client.callTool({ name: 'muscle_memory_status', arguments: {} });
    const text = (result.content as any[])[0].text;
    expect(text).toContain('No patterns found');
    await client.close();
  });

  it('returns patterns after training', async () => {
    seedCli(['train', 'prefer tabs over spaces']);
    const client = await createMcpClient();
    const result = await client.callTool({ name: 'muscle_memory_status', arguments: {} });
    const text = (result.content as any[])[0].text;
    expect(text).toContain('prefer tabs over spaces');
    await client.close();
  });

  it('filters by type', async () => {
    seedCli(['train', 'some preference']);
    const client = await createMcpClient();
    // Manual train creates "preference" type, so filtering by command_freq should show nothing
    const result = await client.callTool({
      name: 'muscle_memory_status',
      arguments: { type: 'command_freq' },
    });
    const text = (result.content as any[])[0].text;
    expect(text).toContain('No patterns found');
    await client.close();
  });

  it('filters by min_strength', async () => {
    seedCli(['train', 'weak pattern']); // 0.3
    const client = await createMcpClient();
    const result = await client.callTool({
      name: 'muscle_memory_status',
      arguments: { min_strength: 0.5 },
    });
    const text = (result.content as any[])[0].text;
    expect(text).toContain('No patterns found');
    await client.close();
  });
});

describe('MCP — muscle_memory_train tool', () => {
  it('creates a new pattern', async () => {
    const client = await createMcpClient();
    const result = await client.callTool({
      name: 'muscle_memory_train',
      arguments: { description: 'always run linter' },
    });
    const text = (result.content as any[])[0].text;
    expect(text).toContain('Created new pattern');
    expect(text).toContain('always run linter');
    await client.close();
  });

  it('reinforces an existing pattern', async () => {
    seedCli(['train', 'always run linter']);
    const client = await createMcpClient();
    const result = await client.callTool({
      name: 'muscle_memory_train',
      arguments: { description: 'linter' },
    });
    const text = (result.content as any[])[0].text;
    expect(text).toContain('Reinforced');
    await client.close();
  });
});

describe('MCP — muscle_memory_forget tool', () => {
  it('removes a pattern by description', async () => {
    seedCli(['train', 'use spaces']);
    const client = await createMcpClient();
    const result = await client.callTool({
      name: 'muscle_memory_forget',
      arguments: { pattern: 'spaces' },
    });
    const text = (result.content as any[])[0].text;
    expect(text).toContain('Removed pattern');
    await client.close();
  });

  it('reports when no pattern found', async () => {
    const client = await createMcpClient();
    const result = await client.callTool({
      name: 'muscle_memory_forget',
      arguments: { pattern: 'nonexistent_xyz' },
    });
    const text = (result.content as any[])[0].text;
    expect(text).toContain('No pattern found');
    await client.close();
  });
});

describe('MCP — muscle_memory_suggest tool', () => {
  it('returns message when no patterns exist', async () => {
    const client = await createMcpClient();
    const result = await client.callTool({
      name: 'muscle_memory_suggest',
      arguments: {},
    });
    const text = (result.content as any[])[0].text;
    expect(text).toContain('No relevant patterns');
    await client.close();
  });

  it('returns patterns with context filtering', async () => {
    seedCli(['train', 'always use TypeScript generics']);
    seedCli(['train', 'always use TypeScript generics']); // make it emerging
    const client = await createMcpClient();
    const result = await client.callTool({
      name: 'muscle_memory_suggest',
      arguments: { context: 'TypeScript' },
    });
    const text = (result.content as any[])[0].text;
    expect(text).toContain('TypeScript');
    await client.close();
  });
});
