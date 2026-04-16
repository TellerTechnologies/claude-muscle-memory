import { createHash } from 'node:crypto';
import {
  getRecentObservations,
  getObservationsSince,
  getMaxObservationId,
  getMeta,
  setMeta,
  upsertPattern,
} from './store.js';
import { getReinforcementDelta } from './strength.js';
import type { Observation, DetectedPattern } from './types.js';

const LAST_ANALYZED_KEY = 'last_analyzed_observation_id';

/** Generate a deterministic signature for dedup. */
function sig(parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

/** Normalize a shell command: strip arguments, keep the base command. */
function normalizeCommand(cmd: string): string {
  const trimmed = cmd.trim();
  // Handle piped commands — take the first segment
  const firstSegment = trimmed.split('|')[0].trim();
  // Handle chained commands — take the first segment
  const firstChained = firstSegment.split('&&')[0].trim();
  // Extract the base command (first word)
  const parts = firstChained.split(/\s+/);
  return parts[0] || trimmed;
}

/** Extract the general context from an observation (e.g., file extension being edited). */
function extractContext(obs: Observation): string | null {
  if (obs.context) return obs.context;
  // Try to extract file extension from content
  const fileMatch = obs.content.match(/\.(ts|js|py|rs|go|java|rb|css|html|json|md|yaml|yml|toml|sh|sql)\b/);
  if (fileMatch) return `.${fileMatch[1]}`;
  return null;
}

// --- Detector 1: Command Frequency ---

function detectCommandFrequency(observations: Observation[]): DetectedPattern[] {
  const bashObs = observations.filter(o => o.tool_name === 'Bash' && o.event_type === 'tool_use');
  const commandCounts = new Map<string, { count: number; examples: string[] }>();

  for (const obs of bashObs) {
    const base = normalizeCommand(obs.content);
    if (!base || base.length < 2) continue;
    const existing = commandCounts.get(base) || { count: 0, examples: [] };
    existing.count++;
    if (existing.examples.length < 3) existing.examples.push(obs.content.slice(0, 100));
    commandCounts.set(base, existing);
  }

  const patterns: DetectedPattern[] = [];
  for (const [cmd, data] of commandCounts) {
    if (data.count >= 3) {
      patterns.push({
        type: 'command_freq',
        description: `User frequently runs \`${cmd}\` (${data.count} times)`,
        signature: sig(['cmd_freq', cmd]),
        metadata: { command: cmd, count: data.count, examples: data.examples },
      });
    }
  }
  return patterns;
}

// --- Detector 2: Edit Sequences ---

function detectEditSequences(observations: Observation[]): DetectedPattern[] {
  // Look for tool-use sequences that repeat
  const toolObs = observations
    .filter(o => o.event_type === 'tool_use' && o.tool_name)
    .reverse(); // chronological order

  if (toolObs.length < 6) return [];

  // Build sequences of 2-3 tool names and count them
  const seqCounts = new Map<string, { count: number; tools: string[] }>();

  for (let windowSize = 2; windowSize <= 3; windowSize++) {
    for (let i = 0; i <= toolObs.length - windowSize * 2; i++) {
      const seq = toolObs.slice(i, i + windowSize).map(o => o.tool_name!);
      const seqKey = seq.join(' → ');

      // Check if this sequence repeats in the next window
      const nextSeq = toolObs.slice(i + windowSize, i + windowSize * 2).map(o => o.tool_name!);
      if (seqKey === nextSeq.join(' → ')) {
        const existing = seqCounts.get(seqKey) || { count: 0, tools: seq };
        existing.count++;
        seqCounts.set(seqKey, existing);
      }
    }
  }

  const patterns: DetectedPattern[] = [];
  for (const [seqKey, data] of seqCounts) {
    if (data.count >= 2) {
      patterns.push({
        type: 'sequence',
        description: `Repeated workflow: ${seqKey}`,
        signature: sig(['seq', seqKey]),
        metadata: { sequence: data.tools, repetitions: data.count },
      });
    }
  }
  return patterns;
}

// --- Detector 3: Correction Patterns ---

const CORRECTION_MARKERS = [
  /^no[,.]?\s/i,
  /^actually[,.]?\s/i,
  /^don'?t\s/i,
  /^stop\s/i,
  /^use\s+\S+\s+instead/i,
  /^not\s+that/i,
  /^wrong/i,
  /^instead[,.]?\s/i,
  /^please\s+(don'?t|stop|use)/i,
  /\bnot\s+\S+[,.]?\s*(use|prefer|want)\b/i,
];

function detectCorrectionPatterns(observations: Observation[]): DetectedPattern[] {
  const sorted = [...observations].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime() || a.id - b.id,
  );

  const patterns: DetectedPattern[] = [];
  const correctionCounts = new Map<string, { count: number; correction: string; originalTool?: string }>();

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];

    // A user prompt right after a tool use that contains correction language
    if (prev.event_type === 'tool_use' && curr.event_type === 'user_prompt') {
      const isCorrection = CORRECTION_MARKERS.some(re => re.test(curr.content));
      if (isCorrection) {
        const key = `${prev.tool_name}:${curr.content.slice(0, 60).toLowerCase().trim()}`;
        const existing = correctionCounts.get(key) || {
          count: 0,
          correction: curr.content.slice(0, 200),
          originalTool: prev.tool_name ?? undefined,
        };
        existing.count++;
        correctionCounts.set(key, existing);
      }
    }
  }

  for (const [key, data] of correctionCounts) {
    if (data.count >= 2) {
      patterns.push({
        type: 'correction',
        description: `User corrects after ${data.originalTool ?? 'tool use'}: "${data.correction}"`,
        signature: sig(['corr', key]),
        metadata: { correction: data.correction, tool: data.originalTool, count: data.count },
      });
    }
  }

  // Detect explicit directives — "always/never" at the start of a prompt (imperative intent)
  const promptObs = observations.filter(o => o.event_type === 'user_prompt');
  const directiveCounts = new Map<string, { count: number; directive: string }>();
  for (const obs of promptObs) {
    // Only match "always/never" at the start of the prompt or after correction markers
    const alwaysNever = obs.content.match(/^(?:please\s+)?(always|never)\s+(.{5,60})/i);
    if (alwaysNever) {
      const directive = alwaysNever[0].slice(0, 100);
      const key = directive.toLowerCase().trim();
      const existing = directiveCounts.get(key) || { count: 0, directive };
      existing.count++;
      directiveCounts.set(key, existing);
    }
  }
  for (const [key, data] of directiveCounts) {
    // Require at least 2 occurrences to avoid false positives
    if (data.count >= 2) {
      patterns.push({
        type: 'correction',
        description: `User directive: "${data.directive}"`,
        signature: sig(['directive', key]),
        metadata: { directive: data.directive, source: 'explicit', count: data.count },
      });
    }
  }

  return patterns;
}

// --- Detector 4: Preference Patterns ---

function detectPreferencePatterns(observations: Observation[]): DetectedPattern[] {
  const patterns: DetectedPattern[] = [];

  // Detect preferred file types being worked on
  const fileExtCounts = new Map<string, number>();
  for (const obs of observations) {
    const ctx = extractContext(obs);
    if (ctx && ctx.startsWith('.')) {
      fileExtCounts.set(ctx, (fileExtCounts.get(ctx) || 0) + 1);
    }
  }
  for (const [ext, count] of fileExtCounts) {
    if (count >= 5) {
      patterns.push({
        type: 'preference',
        description: `User frequently works with ${ext} files (${count} observations)`,
        signature: sig(['pref_ext', ext]),
        metadata: { extension: ext, count },
      });
    }
  }

  // Detect preferred tools
  const toolCounts = new Map<string, number>();
  const toolObs = observations.filter(o => o.event_type === 'tool_use' && o.tool_name);
  for (const obs of toolObs) {
    toolCounts.set(obs.tool_name!, (toolCounts.get(obs.tool_name!) || 0) + 1);
  }
  // Find the dominant tool if one is used much more than others
  const totalToolUse = [...toolCounts.values()].reduce((a, b) => a + b, 0);
  for (const [tool, count] of toolCounts) {
    const ratio = count / totalToolUse;
    if (ratio > 0.4 && count >= 10) {
      patterns.push({
        type: 'preference',
        description: `Heavy use of ${tool} tool (${Math.round(ratio * 100)}% of tool uses)`,
        signature: sig(['pref_tool', tool]),
        metadata: { tool, count, ratio },
      });
    }
  }

  return patterns;
}

// --- Main entry point ---

/** Run all detectors and upsert found patterns. Returns list of all detected patterns.
 *  Only processes observations that arrived since the last analysis run,
 *  preventing strength inflation from re-analyzing the same data. */
export function analyzePatterns(): DetectedPattern[] {
  // Check for new observations since last analysis
  const lastAnalyzedStr = getMeta(LAST_ANALYZED_KEY);
  const lastAnalyzedId = lastAnalyzedStr ? parseInt(lastAnalyzedStr, 10) : 0;
  const currentMaxId = getMaxObservationId();

  // No new observations — skip analysis entirely
  if (currentMaxId <= lastAnalyzedId) return [];

  // Use the full recent window for pattern detection (context matters),
  // but only reinforce if there are genuinely new observations
  const observations = getRecentObservations(500);
  if (observations.length < 3) return [];

  const delta = getReinforcementDelta();
  const allDetected: DetectedPattern[] = [];

  const detectors = [
    detectCommandFrequency,
    detectEditSequences,
    detectCorrectionPatterns,
    detectPreferencePatterns,
  ];

  for (const detector of detectors) {
    const detected = detector(observations);
    for (const pattern of detected) {
      upsertPattern(pattern.type, pattern.description, pattern.signature, delta, pattern.metadata);
      allDetected.push(pattern);
    }
  }

  // Mark current position so we don't re-analyze the same observations
  setMeta(LAST_ANALYZED_KEY, String(currentMaxId));

  return allDetected;
}
