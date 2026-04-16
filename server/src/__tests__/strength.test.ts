import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers.js';
import { reinforce, decay, applyDecayToAll, strengthBar, getReinforcementDelta, getManualTrainDelta } from '../strength.js';
import { getStrengthTier } from '../types.js';
import * as store from '../store.js';

describe('Strength — Pure math functions', () => {
  it('reinforce adds 0.15 to current strength', () => {
    expect(reinforce(0)).toBeCloseTo(0.15);
    expect(reinforce(0.3)).toBeCloseTo(0.45);
    expect(reinforce(0.85)).toBeCloseTo(1.0);
  });

  it('reinforce caps at 1.0', () => {
    expect(reinforce(0.95)).toBe(1.0);
    expect(reinforce(1.0)).toBe(1.0);
  });

  it('decay applies exponential decay correctly', () => {
    // 0.95^1 = 0.95
    expect(decay(1.0, 1)).toBeCloseTo(0.95);
    // 0.95^7 ≈ 0.6983
    expect(decay(1.0, 7)).toBeCloseTo(0.6983, 3);
    // 0.95^30 ≈ 0.2146
    expect(decay(1.0, 30)).toBeCloseTo(0.2146, 3);
    // 0.95^90 ≈ 0.0099 — nearly gone after 3 months
    expect(decay(1.0, 90)).toBeLessThan(0.01);
  });

  it('decay returns same value for 0 days', () => {
    expect(decay(0.5, 0)).toBe(0.5);
  });

  it('decay returns same value for negative days', () => {
    expect(decay(0.5, -3)).toBe(0.5);
  });

  it('decay scales with initial strength', () => {
    const full = decay(1.0, 10);
    const half = decay(0.5, 10);
    expect(half).toBeCloseTo(full / 2, 5);
  });

  it('getReinforcementDelta returns 0.15', () => {
    expect(getReinforcementDelta()).toBe(0.15);
  });

  it('getManualTrainDelta returns 0.3', () => {
    expect(getManualTrainDelta()).toBe(0.3);
  });
});

describe('Strength — Tier classification', () => {
  it('classifies dormant: 0.0–0.2', () => {
    expect(getStrengthTier(0)).toBe('dormant');
    expect(getStrengthTier(0.1)).toBe('dormant');
    expect(getStrengthTier(0.19)).toBe('dormant');
  });

  it('classifies emerging: 0.2–0.5', () => {
    expect(getStrengthTier(0.2)).toBe('emerging');
    expect(getStrengthTier(0.35)).toBe('emerging');
    expect(getStrengthTier(0.49)).toBe('emerging');
  });

  it('classifies active: 0.5–0.8', () => {
    expect(getStrengthTier(0.5)).toBe('active');
    expect(getStrengthTier(0.65)).toBe('active');
    expect(getStrengthTier(0.79)).toBe('active');
  });

  it('classifies reflex: 0.8–1.0', () => {
    expect(getStrengthTier(0.8)).toBe('reflex');
    expect(getStrengthTier(0.9)).toBe('reflex');
    expect(getStrengthTier(1.0)).toBe('reflex');
  });

  it('handles edge boundaries correctly', () => {
    // Exactly at boundaries
    expect(getStrengthTier(0.2)).toBe('emerging'); // >= 0.2
    expect(getStrengthTier(0.5)).toBe('active');   // >= 0.5
    expect(getStrengthTier(0.8)).toBe('reflex');   // >= 0.8
  });
});

describe('Strength — strengthBar display', () => {
  it('shows empty bar for 0', () => {
    expect(strengthBar(0)).toBe('░░░░░░░░░░');
  });

  it('shows full bar for 1.0', () => {
    expect(strengthBar(1.0)).toBe('██████████');
  });

  it('shows half bar for 0.5', () => {
    expect(strengthBar(0.5)).toBe('█████░░░░░');
  });

  it('bar length is always 10', () => {
    for (const v of [0, 0.1, 0.25, 0.5, 0.75, 1.0]) {
      expect(strengthBar(v)).toHaveLength(10);
    }
  });
});

describe('Strength — applyDecayToAll (database integration)', () => {
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = createTestDb();
    cleanup = ctx.cleanup;
  });

  afterEach(() => {
    store.closeDb();
    cleanup();
  });

  it('decays patterns that have old last_seen dates', () => {
    // Insert a pattern with a last_seen 10 days ago
    const db = store.getDb();
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare(`
      INSERT INTO patterns (type, description, signature, strength, last_seen)
      VALUES ('command_freq', 'old pattern', 'sig1', 0.8, ?)
    `).run(tenDaysAgo);

    const updated = applyDecayToAll();
    expect(updated).toBe(1);

    const p = store.getPatternBySignature('sig1')!;
    // 0.8 * 0.95^10 ≈ 0.478
    expect(p.strength).toBeCloseTo(0.478, 2);
  });

  it('does not decay patterns seen today', () => {
    store.upsertPattern('command_freq', 'fresh pattern', 'sig1', 0.8);
    const updated = applyDecayToAll();
    expect(updated).toBe(0);
    expect(store.getPatternBySignature('sig1')!.strength).toBeCloseTo(0.8);
  });

  it('zeros out patterns that decay below 0.01', () => {
    const db = store.getDb();
    // 100 days ago with strength 0.1 → 0.1 * 0.95^100 ≈ 0.00059 → should zero
    const longAgo = new Date(Date.now() - 100 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare(`
      INSERT INTO patterns (type, description, signature, strength, last_seen)
      VALUES ('command_freq', 'ancient', 'sig1', 0.1, ?)
    `).run(longAgo);

    applyDecayToAll();
    expect(store.getPatternBySignature('sig1')!.strength).toBe(0);
  });

  it('handles empty pattern table gracefully', () => {
    expect(applyDecayToAll()).toBe(0);
  });
});

describe('Strength — Lifecycle progression', () => {
  let cleanup: () => void;

  beforeEach(() => {
    const ctx = createTestDb();
    cleanup = ctx.cleanup;
  });

  afterEach(() => {
    store.closeDb();
    cleanup();
  });

  it('pattern progresses from dormant to reflex with repeated reinforcement', () => {
    // Start at 0.15 (dormant)
    let p = store.upsertPattern('command_freq', 'test', 'sig1', 0.15);
    expect(getStrengthTier(p.strength)).toBe('dormant');

    // +0.15 = 0.30 (emerging)
    p = store.upsertPattern('command_freq', 'test', 'sig1', 0.15);
    expect(getStrengthTier(p.strength)).toBe('emerging');

    // +0.15 = 0.45 (still emerging)
    p = store.upsertPattern('command_freq', 'test', 'sig1', 0.15);
    expect(getStrengthTier(p.strength)).toBe('emerging');

    // +0.15 = 0.60 (active)
    p = store.upsertPattern('command_freq', 'test', 'sig1', 0.15);
    expect(getStrengthTier(p.strength)).toBe('active');

    // +0.15 = 0.75 (still active)
    p = store.upsertPattern('command_freq', 'test', 'sig1', 0.15);
    expect(getStrengthTier(p.strength)).toBe('active');

    // +0.15 = 0.90 (reflex!)
    p = store.upsertPattern('command_freq', 'test', 'sig1', 0.15);
    expect(getStrengthTier(p.strength)).toBe('reflex');
  });

  it('takes 6 reinforcements to reach reflex from scratch', () => {
    // 6 × 0.15 = 0.90 ≥ 0.8 → reflex
    let p: any;
    for (let i = 0; i < 6; i++) {
      p = store.upsertPattern('command_freq', 'test', 'sig1', 0.15);
    }
    expect(p.strength).toBeCloseTo(0.9);
    expect(getStrengthTier(p.strength)).toBe('reflex');
  });

  it('manual train reaches active in 2 boosts', () => {
    // 2 × 0.30 = 0.60 ≥ 0.5 → active
    store.upsertPattern('preference', 'test', 'sig1', 0.30);
    const p = store.upsertPattern('preference', 'test', 'sig1', 0.30);
    expect(p.strength).toBeCloseTo(0.6);
    expect(getStrengthTier(p.strength)).toBe('active');
  });
});
