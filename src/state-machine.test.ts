import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  type CrankEpochStepResult,
  type EpochCrankerContract,
  EpochStateMachine,
  type EpochSettings,
  type StateMachineConfig,
} from './state-machine.js';

const noopLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * A stub that yields `result` once and then `idle` — i.e. one unit of work and
 * a quiescent tail, which is what a real cycle looks like.
 *
 * The state machine DRAINS `crankEpochStep` until it reports `idle`, so a stub
 * that returns the same non-idle result forever models a wedged lifecycle, not
 * a normal one. (That case is covered explicitly by the drain tests below.)
 */
function once(
  result: CrankEpochStepResult,
): () => Promise<CrankEpochStepResult> {
  let done = false;
  return async () => {
    if (done) return { action: 'idle', reason: 'epoch_complete' };
    done = true;
    return result;
  };
}

const enabledSettings: EpochSettings = {
  currentEpochIndex: 5,
  genesisTimestamp: 0,
  epochDuration: 100,
  enabled: true,
};

function makeStateMachine(
  crankResult: CrankEpochStepResult | (() => Promise<CrankEpochStepResult>),
  overrides: Partial<StateMachineConfig> = {},
): {
  sm: EpochStateMachine;
  crankCalls: Array<Record<string, unknown>>;
  settingsCalls: number;
} {
  const crankCalls: Array<Record<string, unknown>> = [];
  let settingsCalls = 0;
  const contract: EpochCrankerContract = {
    async crankEpochStep(opts) {
      crankCalls.push(opts);
      return typeof crankResult === 'function' ? crankResult() : crankResult;
    },
  };
  const config: StateMachineConfig = {
    contract,
    rpc: {} as never,
    signer: { address: 'signer' } as never,
    pollIntervalMs: 1000,
    batchSize: 25,
    enableCloseEpochs: true,
    epochRetention: 9,
    enableCleanup: false, // cleanup needs the broader SDK surface; out of scope here
    log: noopLog,
    getEpochSettings: async () => {
      settingsCalls++;
      return enabledSettings;
    },
    nameRegistryAccount: 'nameReg' as never,
    ...overrides,
  };
  return { sm: new EpochStateMachine(config), crankCalls, settingsCalls: 0 };
}

// runCycle is private; drive it directly.
// biome-ignore lint/suspicious/noExplicitAny: test reaches a private method
// `runCycle` is reached directly here, bypassing start()/tick(). The drain
// loop honours `running` so that stop() halts it promptly, so these harnesses
// must set it the way a live cranker would.
const runCycle = (sm: EpochStateMachine) => {
  (sm as any).running = true;
  return (sm as any).runCycle();
};

describe('EpochStateMachine.runCycle (crankEpochStep delegation)', () => {
  it('passes batchSize / enableClose / epochRetention / nameRegistry to crankEpochStep', async () => {
    const { sm, crankCalls } = makeStateMachine({ action: 'idle', reason: 'epoch_complete' });
    await runCycle(sm);
    assert.equal(crankCalls.length, 1);
    // Assert the lifecycle opts individually so added opts (e.g. the returned-
    // name prune knobs) don't make this brittle.
    assert.equal(crankCalls[0].batchSize, 25);
    assert.equal(crankCalls[0].enableClose, true);
    assert.equal(crankCalls[0].epochRetention, 9);
    assert.equal(crankCalls[0].nameRegistryAccount, 'nameReg');
  });

  it('does not call crankEpochStep when epochs are disabled', async () => {
    const { sm, crankCalls } = makeStateMachine(
      { action: 'idle' },
      { getEpochSettings: async () => ({ ...enabledSettings, enabled: false }) },
    );
    await runCycle(sm);
    assert.equal(crankCalls.length, 0);
    assert.equal(sm.getMetrics().phase, 'disabled');
  });

  it('maps a prescribe action to metrics', async () => {
    const { sm } = makeStateMachine(
      once({ action: 'prescribe', epochIndex: 4, txId: 'tx1' }),
    );
    await runCycle(sm);
    const m = sm.getMetrics();
    assert.equal(m.prescriptions, 1, 'the work is still counted');
    assert.notEqual(m.lastActionTime, '');
    // `phase` now reports the cycle's END STATE, not the single step it took.
    // Draining to `idle` means the cranker genuinely has nothing left to do,
    // and saying so is more accurate than reporting the last thing it did.
    // Work performed is still visible in the counters and in
    // `crankStepsLastCycle`.
    assert.equal(m.phase, 'epoch_complete');
  });

  it('maps a tally action with progress', async () => {
    const { sm } = makeStateMachine(
      once({
        action: 'tally',
        epochIndex: 4,
        txId: 'tx2',
        progress: { index: 25, total: 667 },
      }),
    );
    await runCycle(sm);
    const m = sm.getMetrics();
    assert.equal(m.tallyBatches, 1);
    assert.equal(m.tallyProgress, '25/667');
  });

  it('maps create / distribute / close actions', async () => {
    for (const [action, field] of [
      ['create', 'epochsCreated'],
      ['distribute', 'distributionBatches'],
      ['close', 'epochsClosed'],
    ] as const) {
      const { sm } = makeStateMachine(
        once({ action, epochIndex: 1, txId: 't' }),
      );
      await runCycle(sm);
      assert.equal(
        (sm.getMetrics() as unknown as Record<string, unknown>)[field],
        1,
        action,
      );
    }
  });

  it('classifies a thrown crankEpochStep error and does not crash the cycle', async () => {
    const { sm } = makeStateMachine(async () => {
      throw new Error('completely unexpected program error');
    });
    await runCycle(sm); // must not throw
    assert.equal(sm.getMetrics().errorsReal, 1);
  });

  it('resets consecutiveRealErrors after a successful step', async () => {
    const { sm } = makeStateMachine({ action: 'prescribe', txId: 'tx' });
    // simulate a prior real error
    (sm as unknown as { metrics: { consecutiveRealErrors: number } }).metrics.consecutiveRealErrors = 3;
    await runCycle(sm);
    assert.equal(sm.getMetrics().consecutiveRealErrors, 0);
  });
});

// ---------------------------------------------------------------
// Phase 8: disabled-gateway delegate sweep (WP §6.3 / Fix #6)
// ---------------------------------------------------------------

/**
 * Build a state machine whose contract safely stubs every cleanup method
 * (default: async () => []), with explicit overrides for the disabled-gateway
 * sweep. getArnsConfigRaw → null skips the ArNS phases; crankEpochStep → idle
 * so the cleanup pass runs. Returns the captured claim calls.
 */
function makeCleanupSM(opts: {
  disabledGateways: Array<{
    pubkey: string;
    operator: string;
    totalDelegatedStake: bigint;
  }>;
  delegatesByGateway: Record<string, string[]>;
  /** Live balance per delegator address; defaults to 1 (active). 0 = drained. */
  delegateStakeByAddress?: Record<string, number>;
  enableDisabledGatewaySweep?: boolean;
  maxCleanupTxsPerCycle?: number;
}): {
  sm: EpochStateMachine;
  claimCalls: Array<{ gatewayAddress: string; delegatorAddress: string }>;
} {
  const claimCalls: Array<{
    gatewayAddress: string;
    delegatorAddress: string;
  }> = [];
  const overrides: Record<string, (...a: unknown[]) => unknown> = {
    crankEpochStep: async () => ({ action: 'idle', reason: 'epoch_complete' }),
    getArnsConfigRaw: async () => null,
    getDisabledGatewaysWithDelegatedStake: async () => opts.disabledGateways,
    getGatewayDelegates: async (params: unknown) => {
      const address = (params as { address: string }).address;
      return {
        items: (opts.delegatesByGateway[address] ?? []).map((a) => ({
          address: a,
          delegatedStake: opts.delegateStakeByAddress?.[a] ?? 1,
        })),
      };
    },
    claimDelegateFromDisabledGateway: async (params: unknown) => {
      claimCalls.push(
        params as { gatewayAddress: string; delegatorAddress: string },
      );
      return { id: 'tx' };
    },
  };
  // Any cleanup method not explicitly overridden returns an empty scan, so
  // every prior phase is a no-op and the budget reaches Phase 8 intact.
  const contract = new Proxy(
    {},
    {
      get(_t, prop: string) {
        return prop in overrides ? overrides[prop] : async () => [];
      },
    },
  ) as unknown as EpochCrankerContract;

  const config: StateMachineConfig = {
    contract,
    rpc: {} as never,
    signer: { address: 'signer' } as never,
    pollIntervalMs: 1000,
    batchSize: 25,
    enableCloseEpochs: true,
    epochRetention: 9,
    enableCleanup: true,
    cleanupMinIntervalMs: 0,
    maxCleanupTxsPerCycle: opts.maxCleanupTxsPerCycle ?? 50,
    enableDisabledGatewaySweep: opts.enableDisabledGatewaySweep ?? true,
    log: noopLog,
    getEpochSettings: async () => enabledSettings,
    nameRegistryAccount: 'nameReg' as never,
  };
  return { sm: new EpochStateMachine(config), claimCalls };
}

describe('EpochStateMachine.runCycle — draining multi-batch phases', () => {
  // `crankEpochStep` advances the lifecycle by ONE step. Distribution is one
  // tx per ~15 gateways and the post-distribution compound sweep is one tx per
  // 6 delegations, so at one step per cycle those became one tx per CYCLE: on
  // staging a single rollover spent ~42 minutes distributing 617 gateways, and
  // compound (542 delegations, ~91 batches) sat in front of "create the next
  // epoch" — which is why the next epoch was over two hours late.

  it('keeps stepping until idle instead of one step per cycle', async () => {
    // 5 distribute batches then idle — one cycle should do all of them.
    let n = 0;
    const { sm, crankCalls } = makeStateMachine(async () => {
      if (n >= 5) return { action: 'idle', reason: 'epoch_complete' };
      n += 1;
      return {
        action: 'distribute',
        epochIndex: 4,
        txId: `tx${n}`,
        progress: { index: n * 15, total: 75 },
      };
    });
    await runCycle(sm);
    assert.equal(crankCalls.length, 6, '5 batches + the idle that ends the drain');
    assert.equal(sm.getMetrics().distributionBatches, 5);
    assert.equal(sm.getMetrics().crankStepsLastCycle, 6);
  });

  it('drains a compound sweep, whose progress shrinks `total` rather than advancing `index`', async () => {
    // The compound step reports {index: batchSize, total: remaining}, so
    // `index` is constant at 6 while `total` falls. A progress check that only
    // watched `index` would mistake that for no progress and stop after one
    // batch — reintroducing the bug.
    let remaining = 30;
    const { sm } = makeStateMachine(async () => {
      if (remaining <= 0) return { action: 'idle', reason: 'epoch_complete' };
      remaining -= 6;
      return {
        action: 'compound',
        txId: 'c',
        progress: { index: 6, total: remaining + 6 },
      };
    });
    await runCycle(sm);
    assert.equal(sm.getMetrics().crankStepsLastCycle, 6, '5 batches + idle');
  });

  it('stops when a step repeats with no progress, rather than firing the whole budget', async () => {
    // A wedged lifecycle must cost ONE extra tx, not 50.
    const { sm, crankCalls } = makeStateMachine({
      action: 'distribute',
      epochIndex: 4,
      txId: 'stuck',
      progress: { index: 15, total: 600 },
    });
    await runCycle(sm);
    assert.equal(
      crankCalls.length,
      2,
      'one step, one identical repeat, then stop',
    );
  });

  it('respects the per-cycle step budget', async () => {
    let i = 0;
    const { sm, crankCalls } = makeStateMachine(async () => {
      i += 1;
      return {
        action: 'distribute',
        epochIndex: 4,
        txId: `t${i}`,
        progress: { index: i, total: 10_000 },
      };
    }, { maxStepsPerCycle: 7 });
    await runCycle(sm);
    assert.equal(crankCalls.length, 7, 'never exceeds maxStepsPerCycle');
  });

  it('stops stepping when the cranker is stopped mid-drain', async () => {
    // Without this the drain keeps submitting for the whole budget after
    // stop() — up to 50 further transactions during a shutdown or redeploy.
    // The hazard arrives WITH the drain: a cycle used to be a single step.
    let i = 0;
    let smRef: EpochStateMachine | undefined;
    const { sm, crankCalls } = makeStateMachine(async () => {
      i += 1;
      if (i === 2) smRef?.stop();
      return {
        action: 'distribute',
        epochIndex: 4,
        txId: `t${i}`,
        progress: { index: i, total: 10_000 },
      };
    });
    smRef = sm;
    await runCycle(sm);
    assert.equal(crankCalls.length, 2, 'no further steps after stop()');
  });

  it('ends the drain when a step throws, keeping the error classified', async () => {
    let i = 0;
    const { sm, crankCalls } = makeStateMachine(async () => {
      i += 1;
      if (i === 3) throw new Error('AnchorError. Error Number: 9999.');
      return {
        action: 'distribute',
        epochIndex: 4,
        txId: `t${i}`,
        progress: { index: i, total: 100 },
      };
    });
    await runCycle(sm);
    assert.equal(crankCalls.length, 3, 'stops at the throwing step');
    assert.equal(sm.getMetrics().consecutiveRealErrors, 1);
  });
});

describe('EpochStateMachine cleanup — disabled-gateway delegate sweep (Phase 8)', () => {
  it('claims every delegate of each disabled gateway that still holds stake', async () => {
    const { sm, claimCalls } = makeCleanupSM({
      disabledGateways: [
        { pubkey: 'GW1_PDA', operator: 'OP1', totalDelegatedStake: 5n },
        { pubkey: 'GW2_PDA', operator: 'OP2', totalDelegatedStake: 9n },
      ],
      delegatesByGateway: {
        OP1: ['DEL_A', 'DEL_B'],
        OP2: ['DEL_C'],
      },
    });
    await runCycle(sm);

    assert.equal(claimCalls.length, 3, 'must claim all 3 delegates across 2 gateways');
    assert.deepEqual(claimCalls, [
      { gatewayAddress: 'OP1', delegatorAddress: 'DEL_A' },
      { gatewayAddress: 'OP1', delegatorAddress: 'DEL_B' },
      { gatewayAddress: 'OP2', delegatorAddress: 'DEL_C' },
    ]);
  });

  it('does nothing when the sweep is disabled by config', async () => {
    const { sm, claimCalls } = makeCleanupSM({
      disabledGateways: [
        { pubkey: 'GW1_PDA', operator: 'OP1', totalDelegatedStake: 5n },
      ],
      delegatesByGateway: { OP1: ['DEL_A'] },
      enableDisabledGatewaySweep: false,
    });
    await runCycle(sm);
    assert.equal(claimCalls.length, 0, 'sweep must be skipped when disabled');
  });

  it('respects the per-cycle tx budget', async () => {
    const { sm, claimCalls } = makeCleanupSM({
      disabledGateways: [
        { pubkey: 'GW1_PDA', operator: 'OP1', totalDelegatedStake: 5n },
      ],
      delegatesByGateway: { OP1: ['DEL_A', 'DEL_B', 'DEL_C', 'DEL_D'] },
      maxCleanupTxsPerCycle: 2,
    });
    await runCycle(sm);
    assert.equal(claimCalls.length, 2, 'must stop at the budget cap (2)');
  });

  it('skips already-drained (zero-balance) delegates', async () => {
    const { sm, claimCalls } = makeCleanupSM({
      disabledGateways: [
        { pubkey: 'GW1_PDA', operator: 'OP1', totalDelegatedStake: 5n },
      ],
      delegatesByGateway: { OP1: ['DEL_A', 'DEL_DRAINED', 'DEL_B'] },
      // DEL_DRAINED self-claimed earlier — amount already 0, must be skipped
      // (claiming it would fail the on-chain `delegation.amount > 0` constraint).
      delegateStakeByAddress: { DEL_DRAINED: 0 },
    });
    await runCycle(sm);
    assert.deepEqual(claimCalls, [
      { gatewayAddress: 'OP1', delegatorAddress: 'DEL_A' },
      { gatewayAddress: 'OP1', delegatorAddress: 'DEL_B' },
    ]);
  });
});

// ---------------------------------------------------------------
// Phase 4: observation close — enumerate the epoch's real observers,
// NEVER brute-force the GatewayRegistry (firehose fix; parity with
// ar-io-observer PR #105).
// ---------------------------------------------------------------

/**
 * Build a state machine that reaches the Phase-4 observation-close pass.
 * `currentEpochIndex` is high enough (default 20, retention 9) that
 * `closeTarget` (currentIndex-1-retention-1 = 9) lands on an EXISTING epoch
 * (getEpochRaw truthy). `getEpochObservers` returns the epoch's real
 * submitters; `getRegistryGatewayAddresses` is counted so we can assert the
 * old whole-registry fan-out (the firehose) is never taken.
 */
function makeObsCleanupSM(opts: {
  epochObservers: string[];
  currentEpochIndex?: number;
  epochRetention?: number;
}): {
  sm: EpochStateMachine;
  closeCalls: Array<{ epochIndex: number; observer: string }>;
  getEpochObserversCalls: number[];
  registryCalls: { n: number };
} {
  const currentEpochIndex = opts.currentEpochIndex ?? 20;
  const epochRetention = opts.epochRetention ?? 9;
  const closeCalls: Array<{ epochIndex: number; observer: string }> = [];
  const getEpochObserversCalls: number[] = [];
  const registryCalls = { n: 0 };

  const overrides: Record<string, (...a: unknown[]) => unknown> = {
    crankEpochStep: async () => ({ action: 'idle', reason: 'epoch_complete' }),
    getArnsConfigRaw: async () => null,
    // closeTarget epoch exists → proceed to the observer enumeration.
    getEpochRaw: async () => ({ exists: true }),
    getEpochObservers: async (epochIndex: unknown) => {
      getEpochObserversCalls.push(epochIndex as number);
      return opts.epochObservers;
    },
    // The old firehose source — Phase 4 must NEVER call this anymore.
    getRegistryGatewayAddresses: async () => {
      registryCalls.n++;
      return opts.epochObservers;
    },
    closeObservation: async (p: unknown) => {
      closeCalls.push(p as { epochIndex: number; observer: string });
      return { id: 'tx' };
    },
  };
  const contract = new Proxy(
    {},
    {
      get(_t, prop: string) {
        return prop in overrides ? overrides[prop] : async () => [];
      },
    },
  ) as unknown as EpochCrankerContract;

  const config: StateMachineConfig = {
    contract,
    rpc: {} as never,
    signer: { address: 'signer' } as never,
    pollIntervalMs: 1000,
    batchSize: 25,
    enableCloseEpochs: true,
    epochRetention,
    enableCleanup: true,
    cleanupMinIntervalMs: 0,
    maxCleanupTxsPerCycle: 50,
    log: noopLog,
    getEpochSettings: async () => ({
      currentEpochIndex,
      genesisTimestamp: 0,
      epochDuration: 100,
      enabled: true,
    }),
    nameRegistryAccount: 'nameReg' as never,
  };
  return {
    sm: new EpochStateMachine(config),
    closeCalls,
    getEpochObserversCalls,
    registryCalls,
  };
}

describe('EpochStateMachine cleanup — Phase 4 observation close (firehose fix)', () => {
  it('closes ONLY the epoch observers and NEVER walks the gateway registry', async () => {
    // currentEpochIndex 20, retention 9 → targetEpochIndex 19 → closeTarget 9.
    const { sm, closeCalls, getEpochObserversCalls, registryCalls } =
      makeObsCleanupSM({ epochObservers: ['obsA', 'obsB'] });
    await runCycle(sm);

    assert.deepEqual(closeCalls, [
      { epochIndex: 9, observer: 'obsA' },
      { epochIndex: 9, observer: 'obsB' },
    ]);
    assert.deepEqual(getEpochObserversCalls, [9]);
    assert.equal(
      registryCalls.n,
      0,
      'must never brute-force the whole registry (the firehose)',
    );
  });

  it('fires ZERO close_observation when the epoch has no live observers (the 643→0 case)', async () => {
    const { sm, closeCalls, getEpochObserversCalls, registryCalls } =
      makeObsCleanupSM({ epochObservers: [] });
    await runCycle(sm);

    assert.equal(closeCalls.length, 0);
    assert.deepEqual(getEpochObserversCalls, [9]);
    assert.equal(registryCalls.n, 0);
  });
});
