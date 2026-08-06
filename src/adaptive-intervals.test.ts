import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { deriveCrankIntervals } from './adaptive-intervals.js';

// Input unit is SECONDS (matches on-chain EpochSettings.epochDuration).
const MIN_S = 60;
const HOUR_S = 60 * MIN_S;
// Output unit is MILLISECONDS.
const SEC_MS = 1000;
const MIN_MS = 60 * SEC_MS;

describe('deriveCrankIntervals', () => {
  it('reproduces the proven 24h production values (60s poll / 30min cleanup)', () => {
    assert.deepEqual(deriveCrankIntervals(24 * HOUR_S), {
      pollIntervalMs: 60 * SEC_MS,
      cleanupMinIntervalMs: 30 * MIN_MS,
    });
  });

  it('scales cleanup down but keeps the poll ceiling at 12h', () => {
    assert.deepEqual(deriveCrankIntervals(12 * HOUR_S), {
      pollIntervalMs: 60 * SEC_MS,
      cleanupMinIntervalMs: 15 * MIN_MS,
    });
  });

  it('at 1h → 15s poll / 5min cleanup floor', () => {
    assert.deepEqual(deriveCrankIntervals(1 * HOUR_S), {
      pollIntervalMs: 15 * SEC_MS,
      cleanupMinIntervalMs: 5 * MIN_MS,
    });
  });

  it('floors both at short (10min) epochs', () => {
    assert.deepEqual(deriveCrankIntervals(10 * MIN_S), {
      pollIntervalMs: 10 * SEC_MS,
      cleanupMinIntervalMs: 5 * MIN_MS,
    });
  });

  it('clamps very long epochs to the ceilings', () => {
    assert.deepEqual(deriveCrankIntervals(100 * HOUR_S), {
      pollIntervalMs: 60 * SEC_MS,
      cleanupMinIntervalMs: 30 * MIN_MS,
    });
  });

  it('returns safe floors for unknown / invalid epoch durations', () => {
    const floors = {
      pollIntervalMs: 10 * SEC_MS,
      cleanupMinIntervalMs: 5 * MIN_MS,
    };
    assert.deepEqual(deriveCrankIntervals(0), floors);
    assert.deepEqual(deriveCrankIntervals(-5), floors);
    assert.deepEqual(deriveCrankIntervals(Number.NaN), floors);
    assert.deepEqual(deriveCrankIntervals(Number.POSITIVE_INFINITY), floors);
  });

  it('never returns values outside the documented clamp bounds', () => {
    for (const durS of [0, 1, MIN_S, HOUR_S, 24 * HOUR_S, 1000 * HOUR_S]) {
      const { pollIntervalMs, cleanupMinIntervalMs } =
        deriveCrankIntervals(durS);
      assert.ok(pollIntervalMs >= 10 * SEC_MS && pollIntervalMs <= 60 * SEC_MS);
      assert.ok(
        cleanupMinIntervalMs >= 5 * MIN_MS && cleanupMinIntervalMs <= 30 * MIN_MS,
      );
    }
  });
});
