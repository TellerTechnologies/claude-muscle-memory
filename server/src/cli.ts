#!/usr/bin/env node

import {
  addObservation,
  getAllPatterns,
  getActivePatterns,
  getStats,
  clearAll,
  closeDb,
  findPatternByDescription,
  deletePattern,
  upsertPattern,
} from './store.js';
import { analyzePatterns } from './patterns.js';
import { applyDecayToAll, strengthBar, getManualTrainDelta } from './strength.js';
import { createHash } from 'node:crypto';
import { getStrengthTier } from './types.js';
import type { EventType, ToolUseEvent, UserPromptEvent } from './types.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// --- Subcommands ---

async function observe(eventType: string): Promise<void> {
  const validTypes: EventType[] = ['tool_use', 'user_prompt', 'correction'];
  if (!validTypes.includes(eventType as EventType)) {
    process.stderr.write(`Invalid event type: ${eventType}\n`);
    process.exit(1);
  }

  let input: string;
  try {
    input = await readStdin();
  } catch {
    // No stdin available — skip silently
    return;
  }

  if (!input.trim()) return;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(input);
  } catch {
    // Non-JSON input, store raw
    addObservation(eventType as EventType, input.trim());
    return;
  }

  if (eventType === 'tool_use') {
    const event = parsed as unknown as ToolUseEvent;
    const toolName = event.tool_name || 'unknown';
    // Extract the meaningful content from tool_input
    let content: string;
    if (typeof event.tool_input === 'object' && event.tool_input !== null) {
      // For Bash, extract the command string directly
      if ('command' in event.tool_input && typeof event.tool_input.command === 'string') {
        content = event.tool_input.command;
      } else if ('file_path' in event.tool_input && typeof event.tool_input.file_path === 'string') {
        content = event.tool_input.file_path as string;
      } else {
        content = JSON.stringify(event.tool_input);
      }
    } else {
      content = String(event.tool_input || '');
    }
    addObservation('tool_use', content, toolName);
  } else if (eventType === 'user_prompt') {
    const event = parsed as unknown as UserPromptEvent;
    const content = event.prompt || JSON.stringify(parsed);
    addObservation('user_prompt', content);
  } else {
    addObservation(eventType as EventType, JSON.stringify(parsed));
  }
}

function analyze(): void {
  applyDecayToAll();
  const detected = analyzePatterns();
  process.stderr.write(`Analyzed: ${detected.length} patterns detected/updated\n`);
}

function inject(): void {
  // Run analysis first
  applyDecayToAll();
  analyzePatterns();

  // Get active patterns (strength >= 0.5)
  const active = getActivePatterns(0.5);
  if (active.length === 0) return;

  // Build context text for injection
  const lines: string[] = [
    'Muscle Memory — Learned Patterns',
    '',
    'The following patterns have been learned from observing your workflow.',
    'These are preferences and habits to follow unless the user says otherwise.',
    '',
  ];

  // Separate reflexes (>=0.8) from active (>=0.5)
  const reflexes = active.filter(p => p.strength >= 0.8);
  const activePatterns = active.filter(p => p.strength >= 0.5 && p.strength < 0.8);

  if (reflexes.length > 0) {
    lines.push('Reflexes (strong habits — follow automatically):');
    for (const p of reflexes) {
      lines.push(`- ${p.description}`);
    }
    lines.push('');
  }

  if (activePatterns.length > 0) {
    lines.push('Active Patterns (established preferences):');
    for (const p of activePatterns) {
      lines.push(`- ${p.description}`);
    }
    lines.push('');
  }

  // Output as JSON expected by Claude Code SessionStart hooks
  const output = {
    hookSpecificOutput: {
      additionalContext: lines.join('\n'),
    },
  };
  process.stdout.write(JSON.stringify(output));
}

function status(): void {
  const stats = getStats();
  const patterns = getAllPatterns();

  const lines: string[] = [
    '╔══════════════════════════════════════════════╗',
    '║         Claude Muscle Memory Status          ║',
    '╠══════════════════════════════════════════════╣',
    `║  Observations: ${String(stats.observations).padStart(6)}                       ║`,
    `║  Patterns:     ${String(stats.patterns).padStart(6)}                       ║`,
    `║  Reflexes:     ${String(stats.reflexes).padStart(6)}                       ║`,
    '╚══════════════════════════════════════════════╝',
    '',
  ];

  if (patterns.length === 0) {
    lines.push('No patterns detected yet. Keep using Claude and patterns will emerge.');
  } else {
    const tiers = {
      reflex: patterns.filter(p => getStrengthTier(p.strength) === 'reflex'),
      active: patterns.filter(p => getStrengthTier(p.strength) === 'active'),
      emerging: patterns.filter(p => getStrengthTier(p.strength) === 'emerging'),
      dormant: patterns.filter(p => getStrengthTier(p.strength) === 'dormant'),
    };

    for (const [tier, pats] of Object.entries(tiers)) {
      if (pats.length === 0) continue;
      const label = tier.charAt(0).toUpperCase() + tier.slice(1);
      lines.push(`### ${label} (${pats.length})`);
      for (const p of pats) {
        const bar = strengthBar(p.strength);
        lines.push(`  ${bar} ${p.strength.toFixed(2)} │ ${p.description}`);
        lines.push(`  ${''.padEnd(10)} ${''.padEnd(5)} │ type: ${p.type} │ seen: ${p.occurrences}x │ last: ${p.last_seen}`);
      }
      lines.push('');
    }
  }

  process.stdout.write(lines.join('\n') + '\n');
}

function train(description: string): void {
  if (!description) {
    process.stderr.write('Usage: muscle-memory train <description>\n');
    process.exit(1);
  }

  // Check if pattern already exists
  const existing = findPatternByDescription(description);
  if (existing) {
    const delta = getManualTrainDelta();
    upsertPattern(existing.type, existing.description, existing.signature, delta);
    process.stdout.write(`Reinforced pattern: "${existing.description}" (strength +${delta})\n`);
  } else {
    // Create new pattern from manual training
    const signature = createHash('sha256').update(`manual:${description}`).digest('hex').slice(0, 16);
    upsertPattern('preference', description, signature, getManualTrainDelta(), { source: 'manual_train' });
    process.stdout.write(`Created new pattern: "${description}" (strength ${getManualTrainDelta()})\n`);
  }
}

function forget(description: string): void {
  if (!description) {
    process.stderr.write('Usage: muscle-memory forget <description>\n');
    process.exit(1);
  }

  const pattern = findPatternByDescription(description);
  if (pattern) {
    deletePattern(pattern.id);
    process.stdout.write(`Removed pattern: "${pattern.description}"\n`);
  } else {
    // Try as numeric ID
    const id = parseInt(description, 10);
    if (!isNaN(id)) {
      deletePattern(id);
      process.stdout.write(`Removed pattern #${id}\n`);
    } else {
      process.stderr.write(`No pattern found matching: "${description}"\n`);
      process.exit(1);
    }
  }
}

function reset(): void {
  clearAll();
  process.stdout.write('All muscle memory data cleared.\n');
}

// --- Main ---

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  try {
    switch (command) {
      case 'observe':
        await observe(args[0]);
        break;
      case 'analyze':
        analyze();
        break;
      case 'inject':
        inject();
        break;
      case 'status':
        status();
        break;
      case 'train':
        train(args.join(' '));
        break;
      case 'forget':
        forget(args.join(' '));
        break;
      case 'reset':
        reset();
        break;
      default:
        process.stderr.write(
          'Usage: muscle-memory <observe|analyze|inject|status|train|forget|reset>\n',
        );
        process.exit(1);
    }
  } finally {
    closeDb();
  }
}

main().catch(err => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
