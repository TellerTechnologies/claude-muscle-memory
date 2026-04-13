#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  getAllPatterns,
  getActivePatterns,
  findPatternByDescription,
  getPatternById,
  deletePattern,
  upsertPattern,
  getStats,
  closeDb,
} from './store.js';
import { getManualTrainDelta, strengthBar, applyDecayToAll } from './strength.js';
import { analyzePatterns } from './patterns.js';
import { createHash } from 'node:crypto';
import { getStrengthTier } from './types.js';

const server = new McpServer({
  name: 'muscle-memory',
  version: '0.1.0',
});

// --- Tool: muscle_memory_status ---
server.tool(
  'muscle_memory_status',
  'List all learned patterns with strength, type, and last seen. Optionally filter by type or minimum strength.',
  {
    type: z.string().optional().describe('Filter by pattern type: command_freq, sequence, correction, preference'),
    min_strength: z.number().optional().describe('Minimum strength threshold (0.0-1.0)'),
  },
  async ({ type, min_strength }) => {
    applyDecayToAll();
    let patterns = getAllPatterns();

    if (type) {
      patterns = patterns.filter(p => p.type === type);
    }
    if (min_strength !== undefined) {
      patterns = patterns.filter(p => p.strength >= min_strength);
    }

    const stats = getStats();

    if (patterns.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: `No patterns found. Total observations: ${stats.observations}. Keep using Claude and patterns will emerge.`,
        }],
      };
    }

    const lines: string[] = [
      `Muscle Memory: ${stats.observations} observations, ${stats.patterns} patterns`,
      '',
    ];

    for (const p of patterns) {
      const tier = getStrengthTier(p.strength);
      const bar = strengthBar(p.strength);
      lines.push(`${bar} ${p.strength.toFixed(2)} [${tier}] ${p.description}`);
      lines.push(`  type: ${p.type} | seen: ${p.occurrences}x | last: ${p.last_seen} | id: ${p.id}`);
    }

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
    };
  },
);

// --- Tool: muscle_memory_train ---
server.tool(
  'muscle_memory_train',
  'Manually reinforce or create a pattern. Use this when the user explicitly states a preference or habit.',
  {
    description: z.string().describe('Description of the pattern to reinforce or create'),
  },
  async ({ description }) => {
    const existing = findPatternByDescription(description);
    if (existing) {
      const delta = getManualTrainDelta();
      upsertPattern(existing.type, existing.description, existing.signature, delta);
      return {
        content: [{
          type: 'text' as const,
          text: `Reinforced existing pattern: "${existing.description}" (strength +${delta}, now ${Math.min(1.0, existing.strength + delta).toFixed(2)})`,
        }],
      };
    } else {
      const signature = createHash('sha256').update(`manual:${description}`).digest('hex').slice(0, 16);
      const delta = getManualTrainDelta();
      upsertPattern('preference', description, signature, delta, { source: 'manual_train' });
      return {
        content: [{
          type: 'text' as const,
          text: `Created new pattern: "${description}" (strength ${delta.toFixed(2)})`,
        }],
      };
    }
  },
);

// --- Tool: muscle_memory_forget ---
server.tool(
  'muscle_memory_forget',
  'Remove a learned pattern by description or ID. Use when user wants to undo a learned habit.',
  {
    pattern: z.string().describe('Pattern description (partial match) or numeric ID'),
  },
  async ({ pattern }) => {
    // Try as ID first
    const id = parseInt(pattern, 10);
    if (!isNaN(id)) {
      const existing = getPatternById(id);
      if (existing) {
        deletePattern(id);
        return {
          content: [{
            type: 'text' as const,
            text: `Removed pattern #${id}: "${existing.description}"`,
          }],
        };
      }
    }

    // Try description match
    const found = findPatternByDescription(pattern);
    if (found) {
      deletePattern(found.id);
      return {
        content: [{
          type: 'text' as const,
          text: `Removed pattern: "${found.description}"`,
        }],
      };
    }

    return {
      content: [{
        type: 'text' as const,
        text: `No pattern found matching: "${pattern}"`,
      }],
    };
  },
);

// --- Tool: muscle_memory_suggest ---
server.tool(
  'muscle_memory_suggest',
  'Get relevant learned patterns for the current context. Call this to check what muscle memory knows about the current situation.',
  {
    context: z.string().optional().describe('Current context — file being edited, recent commands, project type'),
  },
  async ({ context }) => {
    applyDecayToAll();
    analyzePatterns();

    const active = getActivePatterns(0.2); // Include emerging patterns
    if (active.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: 'No relevant patterns yet. Keep working and muscle memory will develop.',
        }],
      };
    }

    // If context provided, try to filter for relevance
    let relevant = active;
    if (context) {
      const lower = context.toLowerCase();
      const contextRelevant = active.filter(p => {
        let meta: Record<string, unknown> = {};
        try { if (p.metadata) meta = JSON.parse(p.metadata); } catch {}
        const desc = p.description.toLowerCase();
        return desc.includes(lower) ||
          Object.values(meta).some(v => String(v).toLowerCase().includes(lower));
      });
      if (contextRelevant.length > 0) {
        relevant = contextRelevant;
      }
    }

    const lines: string[] = ['Relevant muscle memory patterns:', ''];
    for (const p of relevant.slice(0, 10)) {
      const tier = getStrengthTier(p.strength);
      lines.push(`[${tier}] ${p.description} (strength: ${p.strength.toFixed(2)})`);
    }

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
    };
  },
);

// --- Start server ---
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  process.stderr.write(`MCP server error: ${err.message}\n`);
  process.exit(1);
});

// Cleanup on exit
process.on('SIGINT', () => { closeDb(); process.exit(0); });
process.on('SIGTERM', () => { closeDb(); process.exit(0); });
