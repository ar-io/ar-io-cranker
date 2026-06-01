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
      assert.equal((sm.getMetrics() as Record<string, unknown>)[field], 1, action);
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
