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

  /**
   * A realistic kit-shaped failure: the useful text is in `context.logs`, not
   * the top-level message, and Anchor's `Instruction: <Name>` line is what
   * identifies which instruction reverted.
   */
  const anchorFromInstructions = (code: number, instructions: string[]) =>
    Object.assign(new Error('Transaction simulation failed'), {
      context: {
        logs: [
          'Program ComputeBudget111111111111111111111111111111 invoke [1]',
          'Program ComputeBudget111111111111111111111111111111 success',
          ...instructions.flatMap((ix) => [
            'Program 89fNiiwgpFSPHKuqfNUkgYTYjtAJAhyqHjXmgXeppGpf invoke [1]',
            `Program log: Instruction: ${ix}`,
          ]),
          `Program log: AnchorError occurred. Error Number: ${code}. Error Message: x.`,
        ],
      },
    });

  // 6102 means two opposite things depending on which instruction raised it,
  // so a flat code lookup is not enough to classify it.

  it('treats LatestEpochUnfinished from finalize_gone as not_ready', () => {
    // ROUTINE: ADR-0036 freezes registry positions while an epoch is
    // unfinished, so the GC sweep is refused for the whole window between an
    // epoch's creation and its distribution — the steady state, not an
    // exception. Must not trip the health check.
    assert.equal(ARIO_GAR_ERROR__LATEST_EPOCH_UNFINISHED, 6102);
    assert.equal(
      classifyError(
        anchorFromInstructions(ARIO_GAR_ERROR__LATEST_EPOCH_UNFINISHED, [
          'FinalizeGone',
        ]),
      ),
      'not_ready',
    );
  });

  it('treats LatestEpochUnfinished from create_epoch as REAL — the network is halted', () => {
    // THE ALARM. ADR-0034 refuses to supersede an unfinished epoch, so this
    // means the previous epoch cannot be distributed and the entire lifecycle
    // has stopped for everyone until an operator writes it off with
    // `admin_close_stale_epoch`. Classifying it `not_ready` — as a flat code
    // lookup would — makes the cranker retry a halted network in silence.
    assert.equal(
      classifyError(
        anchorFromInstructions(ARIO_GAR_ERROR__LATEST_EPOCH_UNFINISHED, [
          'CreateEpoch',
        ]),
      ),
      'real',
    );
  });

  it('reads the LAST instruction, so a bundled sweep is still not_ready', () => {
    // ADR-0036's race-free pattern puts finalize_gone in the SAME transaction
    // as the final distribute_epoch batch. Both names appear in the logs; the
    // failing one is the last.
    assert.equal(
      classifyError(
        anchorFromInstructions(ARIO_GAR_ERROR__LATEST_EPOCH_UNFINISHED, [
          'DistributeEpoch',
          'FinalizeGone',
        ]),
      ),
      'not_ready',
    );
  });

  it('defaults an unattributable LatestEpochUnfinished to real, not not_ready', () => {
    // No logs -> the instruction cannot be identified. The failure direction is
    // deliberately toward NOISE rather than SILENCE: a spurious alert costs
    // attention, a silently retried network halt costs the protocol.
    assert.equal(
      classifyError(anchor(ARIO_GAR_ERROR__LATEST_EPOCH_UNFINISHED)),
      'real',
    );
  });

  // Deliberately the opposite call. This one means the CRANKER is stale — it
  // did not send the latest Epoch PDA that ADR-0034's predicate requires — so
  // it must be loud rather than retried quietly. Anchor derives these two
  // codes adjacently, which is exactly why they are pinned by value: a
  // renumbering that swapped them would silently invert both behaviours.
  it('treats MissingLatestEpochAccount as a real error', () => {
    assert.equal(ARIO_GAR_ERROR__MISSING_LATEST_EPOCH_ACCOUNT, 6103);
    assert.equal(
      classifyError(anchor(ARIO_GAR_ERROR__MISSING_LATEST_EPOCH_ACCOUNT)),
      'real',
    );
  });
});
