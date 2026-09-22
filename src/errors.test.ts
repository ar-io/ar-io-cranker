import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  ARIO_GAR_ERROR__EPOCH_NO_LONGER_LIVE,
  ARIO_GAR_ERROR__EPOCH_WEIGHTS_CLOBBERED,
  ARIO_GAR_ERROR__LATEST_EPOCH_UNFINISHED,
  ARIO_GAR_ERROR__MISSING_LATEST_EPOCH_ACCOUNT,
} from '@ar.io/solana-contracts/gar';

import { classifyError } from './errors.js';

describe('classifyError — LeaveWindowNotExpired (6079)', () => {
  it('classifies 6079 (decimal "Error Number") as not_ready', () => {
    const err = new Error(
      'finalize_gone: AnchorError caused by account: gateway. Error Code: LeaveWindowNotExpired. Error Number: 6079.',
    );
    assert.equal(classifyError(err), 'not_ready');
  });

  it('classifies 0x17bf (hex custom program error = 6079) as not_ready', () => {
    const err = new Error(
      'Transaction simulation failed: custom program error: 0x17bf',
    );
    assert.equal(classifyError(err), 'not_ready');
  });

  it('still classifies an unmapped program error as real', () => {
    const err = new Error('some failure. Error Number: 9999.');
    assert.equal(classifyError(err), 'real');
  });
});

/**
 * Regression tests for the drifted error table.
 *
 * Every code below was verified against the ario-gar IDL deployed to mainnet
 * on 2026-09-15 (99 errors). The point of these cases is that they FAIL against
 * the previous hard-coded table, which was two positions out of date for a
 * block of codes: it suppressed four real errors as "already_done", three more
 * as "not_ready", and reported seven genuinely benign conditions as "real".
 */
describe('classifyError — drifted-table regressions', () => {
  const anchor = (code: number) =>
    new Error(`AnchorError. Error Number: ${code}.`);

  it('treats the real "already done" conditions as already_done', () => {
    for (const [code, name] of [
      [6039, 'RewardsAlreadyDistributed'],
      [6043, 'EpochAlreadyExists'],
      [6047, 'WeightsAlreadyTallied'],
      [6051, 'PrescriptionsAlreadyDone'],
      [6091, 'DelegationNotDisabled'],
    ] as const) {
      assert.equal(classifyError(anchor(code)), 'already_done', name);
    }
  });

  it('treats the real "not ready" preconditions as not_ready', () => {
    for (const [code, name] of [
      [6031, 'EpochsNotEnabled'],
      [6034, 'EpochNotStarted'],
      [6036, 'EpochInProgress'],
      [6040, 'DistributionIncomplete'],
      [6048, 'WeightsNotTallied'],
      [6050, 'PrescriptionsNotDone'],
      [6053, 'EpochNotCloseable'],
      [6079, 'LeaveWindowNotExpired'],
    ] as const) {
      assert.equal(classifyError(anchor(code)), 'not_ready', name);
    }
  });

  it('no longer suppresses the codes the stale table pointed at', () => {
    // These are the codes the old sets actually listed. Each is a real failure
    // that was being swallowed, so each must now surface as 'real'.
    for (const [code, name] of [
      [6037, 'NotPrescribedObserver (was already_done)'],
      [6041, 'InvalidObservation (was already_done)'],
      [6045, 'NoNamesAvailable (was already_done)'],
      [6049, 'InvalidGatewayAccount (was already_done)'],
      [6032, 'EpochsAlreadyEnabled (was not_ready)'],
      [6038, 'AlreadyObserved (was not_ready)'],
      [6046, 'InvalidEpochIndex (was not_ready)'],
    ] as const) {
      assert.equal(classifyError(anchor(code)), 'real', name);
    }
  });

  it('surfaces the ADR-0032/0033 errors as real — they need a human', () => {
    // Pinned against the generated constants rather than written out, so a
    // renumbering in a future IDL fails here instead of silently changing what
    // the cranker suppresses:
    //   EpochWeightsClobbered — epoch can never be distributed correctly
    //   EpochNoLongerLive     — epoch can never be tallied
    assert.equal(ARIO_GAR_ERROR__EPOCH_WEIGHTS_CLOBBERED, 6097);
    assert.equal(ARIO_GAR_ERROR__EPOCH_NO_LONGER_LIVE, 6098);
    for (const code of [
      ARIO_GAR_ERROR__EPOCH_WEIGHTS_CLOBBERED,
      ARIO_GAR_ERROR__EPOCH_NO_LONGER_LIVE,
    ]) {
      assert.equal(classifyError(anchor(code)), 'real');
    }
  });
});

describe('classifyError — Wave 2 (ADR-0034 / ADR-0036)', () => {
  const anchor = (code: number) =>
    new Error(`AnchorError. Error Number: ${code}.`);

  // The Wave 2 program upgrade makes `finalize_gone` refuse for the whole
  // window between an epoch's creation and its distribution (registry
  // positions are frozen while an epoch is unfinished). The cleanup pass runs
  // every cycle, so this becomes the STEADY STATE, not an edge case.
  //
  // If it were left to the default 'real' classification, the upgrade would
  // make a correctly-behaving cranker log errors on most cycles, accumulate
  // `consecutiveRealErrors` and trip its own health check.
  it('treats LatestEpochUnfinished as not_ready, not a real error', () => {
    assert.equal(ARIO_GAR_ERROR__LATEST_EPOCH_UNFINISHED, 6102);
    assert.equal(
      classifyError(anchor(ARIO_GAR_ERROR__LATEST_EPOCH_UNFINISHED)),
      'not_ready',
    );
  });

  // Deliberately the opposite call. This one means the CRANKER is stale — it
  // did not send the latest Epoch PDA that ADR-0034's predicate requires — so
  // it must be loud rather than retried quietly. Anchor derives these two
  // codes adjacently, which is exactly why they are pinned by value here: a
  // renumbering that swapped them would silently invert both behaviours.
  it('treats MissingLatestEpochAccount as a real error', () => {
    assert.equal(ARIO_GAR_ERROR__MISSING_LATEST_EPOCH_ACCOUNT, 6103);
    assert.equal(
      classifyError(anchor(ARIO_GAR_ERROR__MISSING_LATEST_EPOCH_ACCOUNT)),
      'real',
    );
  });
});
