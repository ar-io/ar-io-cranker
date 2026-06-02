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
const runCycle = (sm: EpochStateMachine) => (sm as any).runCycle();

describe('EpochStateMachine.runCycle (crankEpochStep delegation)', () => {
  it('passes batchSize / enableClose / epochRetention / nameRegistry to crankEpochStep', async () => {
    const { sm, crankCalls } = makeStateMachine({ action: 'idle', reason: 'epoch_complete' });
    await runCycle(sm);
    assert.equal(crankCalls.length, 1);
    assert.deepEqual(crankCalls[0], {
      batchSize: 25,
      enableClose: true,
      epochRetention: 9,
      nameRegistryAccount: 'nameReg',
    });
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
    const { sm } = makeStateMachine({ action: 'prescribe', epochIndex: 4, txId: 'tx1' });
    await runCycle(sm);
    const m = sm.getMetrics();
    assert.equal(m.prescriptions, 1);
    assert.equal(m.phase, 'prescribe_epoch');
    assert.notEqual(m.lastActionTime, '');
  });

  it('maps a tally action with progress', async () => {
    const { sm } = makeStateMachine({
      action: 'tally',
      epochIndex: 4,
      txId: 'tx2',
      progress: { index: 25, total: 667 },
    });
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
      const { sm } = makeStateMachine({ action, epochIndex: 1, txId: 't' });
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
