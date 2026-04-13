import { getAllPatterns, updatePatternStrength } from './store.js';
import type { Pattern } from './types.js';

// How much strength increases per observation
const REINFORCEMENT_DELTA = 0.15;

// Manual training boost
const MANUAL_TRAIN_DELTA = 0.3;

// Daily decay factor — strength * (DECAY_RATE ^ days_since_last_seen)
const DECAY_RATE = 0.95;

/** Reinforce a pattern by one observation. Returns new strength. */
export function reinforce(currentStrength: number): number {
  return Math.min(1.0, currentStrength + REINFORCEMENT_DELTA);
}

/** Get the reinforcement delta for automated pattern detection. */
export function getReinforcementDelta(): number {
  return REINFORCEMENT_DELTA;
}

/** Get the manual training delta. */
export function getManualTrainDelta(): number {
  return MANUAL_TRAIN_DELTA;
}

/** Apply time-based decay to a strength value. */
export function decay(strength: number, daysSinceLastSeen: number): number {
  if (daysSinceLastSeen <= 0) return strength;
  return strength * Math.pow(DECAY_RATE, daysSinceLastSeen);
}

/** Calculate days between two date strings. */
function daysBetween(dateStr: string, now: Date): number {
  const date = new Date(dateStr + 'Z'); // SQLite dates are UTC
  const diff = now.getTime() - date.getTime();
  return Math.max(0, diff / (1000 * 60 * 60 * 24));
}

/** Apply decay to all patterns in the database. Returns count of patterns updated. */
export function applyDecayToAll(): number {
  const patterns = getAllPatterns();
  const now = new Date();
  let updated = 0;

  for (const pattern of patterns) {
    const days = daysBetween(pattern.last_seen, now);
    if (days > 0) {
      const decayed = decay(pattern.strength, days);
      // Remove patterns that have decayed to near-zero
      if (decayed < 0.01) {
        updatePatternStrength(pattern.id, 0);
      } else if (Math.abs(decayed - pattern.strength) > 0.001) {
        updatePatternStrength(pattern.id, decayed);
        updated++;
      }
    }
  }

  return updated;
}

/** Format a pattern's strength as a visual bar for display. */
export function strengthBar(strength: number): string {
  const filled = Math.round(strength * 10);
  const empty = 10 - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}
