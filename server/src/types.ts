// Event types that hooks can fire
export type EventType = 'tool_use' | 'user_prompt' | 'correction';

// Pattern categories detected by the engine
export type PatternType = 'command_freq' | 'sequence' | 'correction' | 'preference';

// Reflex types — what gets generated from strong patterns
export type ReflexType = 'context_injection' | 'hook_suggestion';

// Strength tiers
export type StrengthTier = 'dormant' | 'emerging' | 'active' | 'reflex';

// Raw observation from a hook event
export interface Observation {
  id: number;
  event_type: EventType;
  tool_name: string | null;
  content: string;
  context: string | null;
  created_at: string;
}

// Detected pattern with strength tracking
export interface Pattern {
  id: number;
  type: PatternType;
  description: string;
  signature: string;
  strength: number;
  occurrences: number;
  last_seen: string;
  created_at: string;
  metadata: string | null; // JSON blob
}

// Generated reflex from a strong pattern
export interface Reflex {
  id: number;
  pattern_id: number;
  type: ReflexType;
  content: string;
  active: number;
  created_at: string;
}

// Hook input for PostToolUse events
export interface ToolUseEvent {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

// Hook input for UserPromptSubmit events
export interface UserPromptEvent {
  prompt: string;
}

// Result from a pattern detector
export interface DetectedPattern {
  type: PatternType;
  description: string;
  signature: string;
  metadata: Record<string, unknown>;
}

// Strength tier boundaries
export const STRENGTH_TIERS: Record<StrengthTier, [number, number]> = {
  dormant: [0.0, 0.2],
  emerging: [0.2, 0.5],
  active: [0.5, 0.8],
  reflex: [0.8, 1.0],
};

export function getStrengthTier(strength: number): StrengthTier {
  if (strength >= 0.8) return 'reflex';
  if (strength >= 0.5) return 'active';
  if (strength >= 0.2) return 'emerging';
  return 'dormant';
}
