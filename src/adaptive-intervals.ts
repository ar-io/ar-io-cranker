/**
 * Epoch-adaptive cranker intervals.
 *
 * The cranker's poll cadence and permissionless-cleanup cadence only need to be
 * sized relative to the epoch duration. Fixed defaults (10s poll / 5min cleanup)
 * are fine for short dev/localnet epochs but wastefully over-poll — and fire far
 * too many credit-heavy `getProgramAccounts` cleanup scans — on 24h production
 * epochs. Deriving both from the on-chain `epochDuration` lets one config
 * self-tune from 24h mainnet down to minute-scale localnet.
 *
 * The clamps are chosen so the floors sit at/below the fixed defaults: short
 * epochs are unchanged-or-slightly-faster (no regression), and only long epochs
 * change — strictly toward fewer RPC calls. An explicit `POLL_INTERVAL_MS` /
 * `CLEANUP_MIN_INTERVAL_MS` env always overrides these.
 *
 * Mirrors ar-io-observer/src/epoch/adaptive-intervals.ts — keep in sync.
 *
 *   epoch    poll    cleanup
 *   24h      60s     30min   (reproduces the proven hand-tuned production values)
 *   12h      60s     15min
 *    1h      15s      5min
 *   10min    10s      5min   (floors)
 */

const POLL_DIVISOR = 240;
const POLL_FLOOR_MS = 10_000; // 10s
const POLL_CEILING_MS = 60_000; // 60s

const CLEANUP_DIVISOR = 48;
const CLEANUP_FLOOR_MS = 300_000; // 5min
const CLEANUP_CEILING_MS = 1_800_000; // 30min

/**
 * Static fallbacks for when the epoch duration can't be read at startup (e.g.
 * RPC error, or epochs not yet enabled). Conservative for any epoch length.
 */
export const FALLBACK_POLL_INTERVAL_MS = 10_000;
export const FALLBACK_CLEANUP_MIN_INTERVAL_MS = 300_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface CrankIntervals {
  pollIntervalMs: number;
  cleanupMinIntervalMs: number;
}

/**
 * Derive poll + cleanup intervals (ms) from the epoch duration, clamped.
 *
 * `epochDurationSeconds` is the on-chain `EpochSettings.epochDuration` field,
 * denominated in **seconds** (e.g. 86400 for a 24h epoch) — not ms. A
 * non-positive / non-finite duration yields the safe floors.
 */
export function deriveCrankIntervals(
  epochDurationSeconds: number,
): CrankIntervals {
  const durMs =
    Number.isFinite(epochDurationSeconds) && epochDurationSeconds > 0
      ? epochDurationSeconds * 1000
      : 0;
  return {
    pollIntervalMs: clamp(
      Math.round(durMs / POLL_DIVISOR),
      POLL_FLOOR_MS,
      POLL_CEILING_MS,
    ),
    cleanupMinIntervalMs: clamp(
      Math.round(durMs / CLEANUP_DIVISOR),
      CLEANUP_FLOOR_MS,
      CLEANUP_CEILING_MS,
    ),
  };
}
