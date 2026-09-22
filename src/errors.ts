/**
 * Anchor error parsing and classification for epoch cranker.
 * Mirrors ar-io-observer/src/epoch/errors.ts — keep in sync.
 *
 * Three categories:
 * - "already_done": Step was completed by another cranker. Safe to skip.
 * - "not_ready": Preconditions not met yet. Wait and retry.
 * - "real": Unexpected failure. Needs investigation.
 *
 * Codes come from `@ar.io/solana-contracts`, generated from the shipped IDL.
 * They are NOT written out numerically here, and must not be: Anchor assigns
 * `6000 + variant-index`, so inserting a variant anywhere but the end of
 * `GarError` shifts every later code. That has already happened once — this
 * table drifted two positions and silently mis-classified a block of errors:
 *
 *   suppressed as "already_done" but actually real
 *     6037 NotPrescribedObserver, 6041 InvalidObservation,
 *     6045 NoNamesAvailable, 6049 InvalidGatewayAccount
 *   suppressed as "not_ready" but actually real
 *     6032 EpochsAlreadyEnabled, 6038 AlreadyObserved, 6046 InvalidEpochIndex
 *   genuinely benign, but reported as real (alert noise, and enough of them
 *   in a row trips the health check)
 *     RewardsAlreadyDistributed, EpochAlreadyExists, WeightsAlreadyTallied,
 *     EpochInProgress, DistributionIncomplete, PrescriptionsNotDone,
 *     EpochNotCloseable
 *
 * Importing the generated constants makes that class of bug impossible.
 */

import {
  ARIO_GAR_ERROR__DELEGATION_NOT_DISABLED,
  ARIO_GAR_ERROR__DISTRIBUTION_INCOMPLETE,
  ARIO_GAR_ERROR__EPOCH_ALREADY_EXISTS,
  ARIO_GAR_ERROR__EPOCH_IN_PROGRESS,
  ARIO_GAR_ERROR__EPOCH_NOT_CLOSEABLE,
  ARIO_GAR_ERROR__EPOCH_NOT_STARTED,
  ARIO_GAR_ERROR__EPOCHS_NOT_ENABLED,
  ARIO_GAR_ERROR__LATEST_EPOCH_UNFINISHED,
  ARIO_GAR_ERROR__LEAVE_WINDOW_NOT_EXPIRED,
  ARIO_GAR_ERROR__PRESCRIPTIONS_ALREADY_DONE,
  ARIO_GAR_ERROR__PRESCRIPTIONS_NOT_DONE,
  ARIO_GAR_ERROR__REWARDS_ALREADY_DISTRIBUTED,
  ARIO_GAR_ERROR__WEIGHTS_ALREADY_TALLIED,
  ARIO_GAR_ERROR__WEIGHTS_NOT_TALLIED,
} from '@ar.io/solana-contracts/gar';

export type ErrorCategory = 'already_done' | 'not_ready' | 'real';

export const ALREADY_DONE_ERRORS = new Set<number>([
  // AlreadyInitialized (Anchor built-in) — epoch account already exists
  0,
  // Anchor framework account-error codes that all map to the same
  // semantic for the cranker's `close_observation` cleanup loop: the
  // candidate Observation PDA address doesn't currently hold an
  // Observation account, so there's nothing to close. The loop walks
  // every registry observer; misses are expected.
  //
  //   3007 = AccountOwnedByWrongProgram. When the (epoch_index, observer)
  //          PDA address has never been initialized, it's owned by the
  //          System Program (`11111...`), not ario-gar. Anchor's
  //          `Account<Observation>` check raises this. **This is what
  //          devnet produces in practice** (confirmed via
  //          `custom program error: 0xbbf` in failed simulations).
  //   3012 = AccountNotInitialized. Defensive: a slightly different
  //          path where the account exists but has zero data could
  //          surface this. Semantically equivalent to "nothing to
  //          close."
  3007,
  3012,
  // Another cranker got there first — every one of these means the step
  // this cycle wanted to perform is already done.
  ARIO_GAR_ERROR__REWARDS_ALREADY_DISTRIBUTED,
  ARIO_GAR_ERROR__EPOCH_ALREADY_EXISTS,
  ARIO_GAR_ERROR__WEIGHTS_ALREADY_TALLIED,
  ARIO_GAR_ERROR__PRESCRIPTIONS_ALREADY_DONE,
  // DelegationNotDisabled — the disabled-gateway delegate sweep (Phase 8)
  // raced an operator re-enabling delegation between discovery and the claim
  // landing; nothing left to crank for that gateway.
  ARIO_GAR_ERROR__DELEGATION_NOT_DISABLED,
]);

export const NOT_READY_ERRORS = new Set<number>([
  ARIO_GAR_ERROR__EPOCHS_NOT_ENABLED,
  ARIO_GAR_ERROR__EPOCH_NOT_STARTED,
  // EpochInProgress — the epoch is still running, so it cannot be distributed
  // yet. Reached on every cycle before the window closes.
  ARIO_GAR_ERROR__EPOCH_IN_PROGRESS,
  ARIO_GAR_ERROR__DISTRIBUTION_INCOMPLETE,
  ARIO_GAR_ERROR__WEIGHTS_NOT_TALLIED,
  ARIO_GAR_ERROR__PRESCRIPTIONS_NOT_DONE,
  ARIO_GAR_ERROR__EPOCH_NOT_CLOSEABLE,
  // LeaveWindowNotExpired — a Leaving gateway whose leave window hasn't
  // elapsed yet can't be finalize_gone'd. `getGoneGateways()` returns every
  // Leaving gateway (not just expired ones), so the cleanup pass attempts them
  // and they revert with this until their window passes — a wait-and-retry
  // condition, NOT a real error (must not spam error logs or trip unhealthy
  // via consecutiveRealErrors).
  ARIO_GAR_ERROR__LEAVE_WINDOW_NOT_EXPIRED,
]);

// LatestEpochUnfinished (6102) is deliberately absent from BOTH sets above:
// what it means depends on which instruction raised it, so it is classified by
// `classifyLatestEpochUnfinished` below rather than by a flat code lookup.

// Deliberately NOT suppressed — each means an epoch needs a human, and the
// default 'real' classification is correct:
//   MissingLatestEpochAccount (6103) — the client did not supply the latest
//     Epoch PDA that ADR-0034's predicate requires. Distinct from
//     LatestEpochUnfinished on purpose: it means the CRANKER is stale, not
//     that the chain is busy, so it must be loud rather than retried quietly.
//   EpochWeightsClobbered (6097) — an epoch in the reward set lost its weights
//     to another epoch's tally; it can never be distributed correctly and needs
//     a write-off (admin_close_stale_epoch).
//   EpochNoLongerLive (6098) — tally was attempted on a non-live epoch, which
//     means that epoch can never be tallied and something drove the crank out
//     of order.
// Their codes are pinned against the generated constants in errors.test.ts, so a
// future renumbering fails the suite rather than silently changing what the
// cranker suppresses.

/**
 * Walk the `cause` chain on a thrown error and concatenate every
 * message + every `context.logs[]` (kit packs the program logs there)
 * so the regex extractors below can find the Anchor code.
 *
 * The SDK's `sendAndConfirm` throws a `SolanaError` whose top-level
 * `message` is just `"Transaction simulation failed"`. The actual
 * `custom program error: 0xNNN` line and the `Error Number: NNNN`
 * AnchorError text live one or two levels down in `cause.context.logs`
 * and `cause.message`. Reading only the top-level message misses
 * everything useful.
 */
function collectErrorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 10; depth++) {
    if (typeof current === 'string') {
      parts.push(current);
      break;
    }
    if (current instanceof Error || typeof current === 'object') {
      const e = current as {
        message?: string;
        context?: { logs?: string[]; err?: unknown };
        cause?: unknown;
      };
      if (e.message) parts.push(e.message);
      if (Array.isArray(e.context?.logs)) parts.push(e.context.logs.join('\n'));
      if (e.context?.err && typeof e.context.err === 'object') {
        // kit packs `{ InstructionError: [idx, {Custom: N}] }` here
        try {
          parts.push(JSON.stringify(e.context.err));
        } catch {
          /* ignore circular */
        }
      }
      current = e.cause;
    } else {
      break;
    }
  }
  return parts.join('\n');
}

export function parseAnchorErrorCode(error: unknown): number | null {
  const msg = collectErrorText(error);
  const match = msg.match(/Error Number: (\d+)/);
  if (match) return parseInt(match[1]);
  const hexMatch = msg.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if (hexMatch) return parseInt(hexMatch[1], 16);
  // kit's structured `InstructionError: [idx, {Custom: NNNN}]` form
  // (decimal, JSON-stringified from the `context.err` field).
  const customMatch = msg.match(/"Custom":\s*(\d+)/);
  if (customMatch) return parseInt(customMatch[1]);
  if (msg.includes('already in use')) return 0;
  return null;
}

/**
 * The Anchor instruction that actually failed, read back from the program
 * logs.
 *
 * Anchor emits `Program log: Instruction: <Name>` as the first log of every
 * instruction it handles, so the LAST such line before the error is the one
 * that reverted. That holds for a bundled transaction too — e.g. ADR-0036's
 * recommended `[distribute_epoch, finalize_gone]` sweep logs both names in
 * order, and the last is the failing one. Non-Anchor programs in the same
 * transaction (ComputeBudget) emit no such line, so they cannot be mistaken
 * for it.
 *
 * Returns null when the logs are unavailable — the caller must treat that as
 * "unknown", not as a particular instruction.
 */
function extractFailingInstruction(text: string): string | null {
  const matches = [...text.matchAll(/Program log: Instruction: (\w+)/g)];
  return matches.length > 0 ? matches[matches.length - 1][1] : null;
}

/**
 * `LatestEpochUnfinished` (6102) means two very different things depending on
 * which instruction raised it, and a flat code lookup cannot tell them apart:
 *
 *   finalize_gone — ROUTINE. ADR-0036 freezes registry positions while an
 *     epoch is unfinished, so the GC sweep is refused for the whole window
 *     between an epoch's creation and its distribution. The cleanup pass runs
 *     every cycle, so this is the steady state, not an exception. Classified
 *     `not_ready`: it must not spam error logs or trip the health check via
 *     `consecutiveRealErrors`.
 *
 *   create_epoch — THE NETWORK IS HALTED. ADR-0034 refuses to supersede an
 *     unfinished epoch, so this means the previous epoch cannot be
 *     distributed and the whole lifecycle has stopped: no epochs, no rewards,
 *     no observations, for everyone, until an operator writes the stuck epoch
 *     off with `admin_close_stale_epoch`. Classified `real` — this is the
 *     loudest thing the cranker can say.
 *
 * Unknown instruction (no logs) is deliberately classified `real`. The failure
 * direction is toward NOISE rather than SILENCE: a spurious alert costs
 * attention, a silent network halt costs the protocol. The common path
 * (finalize_gone) carries logs in practice, so this should stay rare.
 */
function classifyLatestEpochUnfinished(text: string): ErrorCategory {
  return extractFailingInstruction(text) === 'FinalizeGone'
    ? 'not_ready'
    : 'real';
}

export function classifyError(error: unknown): ErrorCategory {
  const code = parseAnchorErrorCode(error);
  if (code !== null) {
    if (ALREADY_DONE_ERRORS.has(code)) return 'already_done';
    if (code === ARIO_GAR_ERROR__LATEST_EPOCH_UNFINISHED) {
      return classifyLatestEpochUnfinished(collectErrorText(error));
    }
    if (NOT_READY_ERRORS.has(code)) return 'not_ready';
  }

  // RPC-level dedup: Solana returns this when another signer has already
  // submitted an identical tx (multiple crankers racing). Safe to ignore.
  // Walk the cause chain so we catch it whether it's at the top-level
  // message or nested inside a `SolanaError`.
  const msg = collectErrorText(error);
  if (msg.includes('already been processed') || msg.includes('AlreadyProcessed')) {
    return 'already_done';
  }

  // Transient RPC errors — treat as not_ready so we don't spam error logs
  if (
    msg.includes('BlockhashNotFound') ||
    msg.includes('blockhash not found') ||
    msg.includes('block height exceeded') ||
    msg.includes('fetch failed') ||
    msg.includes('Connection terminated') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    // RPC provider rate-limit responses. QuickNode / Helius / Triton
    // return HTTP 429 with a `Too Many Requests` body when the
    // per-second or per-month quota is hit. Cranker + observer cycles
    // burst at epoch boundaries (cleanup + tally + distribute fire
    // together) and routinely trip free-tier limits. Categorising as
    // transient avoids `error:` spam; the cleanup loop will retry on
    // the next cycle.
    msg.includes('HTTP error (429)') ||
    msg.includes('Too Many Requests') ||
    msg.includes('rate limit') ||
    msg.includes('rate-limited')
  ) {
    return 'not_ready';
  }

  return 'real';
}
