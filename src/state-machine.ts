/**
 * Epoch cranker state machine.
 *
 * Drives the 6-step permissionless epoch pipeline:
 * create_epoch → tally_weights → prescribe_epoch → [wait] → distribute_epoch → close_epoch
 *
 * Each poll cycle reads on-chain state and executes the next required step.
 * All instructions are idempotent — safe to run multiple crankers concurrently.
 */
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { classifyError, type ErrorCategory } from './errors.js';

// We import the SDK's SolanaARIOWriteable which has all the epoch methods.
// In standalone mode, the cranker instantiates this directly.
// In observer mode, it receives one from the observer's system.ts.
//
// The type is defined inline here to avoid a direct import dependency on the SDK
// build artifacts. The actual object passed in must have these methods.
export interface EpochCrankerContract {
  createEpoch(): Promise<{ id: string }>;
  tallyWeights(params: { epochIndex: number; gatewayAccounts: PublicKey[] }): Promise<{ id: string }>;
  prescribeEpoch(params: { epochIndex: number; gatewayAccounts: PublicKey[]; nameRegistryAccount?: PublicKey }): Promise<{ id: string }>;
  distributeEpoch(params: { epochIndex: number; gatewayAccounts: PublicKey[] }): Promise<{ id: string }>;
  closeEpoch(params: { epochIndex: number }): Promise<{ id: string }>;
  getRegistryGatewayPDAs(startIndex: number, batchSize: number): Promise<PublicKey[]>;
  getAllRegistryGatewayPDAs(): Promise<PublicKey[]>;
  getEpochRaw(epochIndex: number): Promise<{
    tallyIndex: number;
    distributionIndex: number;
    weightsTallied: number;
    prescriptionsDone: number;
    rewardsDistributed: number;
    activeGatewayCount: number;
    endTimestamp: number;
  } | null>;
}

export interface EpochSettings {
  currentEpochIndex: number;
  genesisTimestamp: number;
  epochDuration: number;
  enabled: boolean;
}

export interface CrankerLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface StateMachineConfig {
  contract: EpochCrankerContract;
  connection: Connection;
  signer: Keypair;
  pollIntervalMs: number;
  batchSize: number;
  enableCloseEpochs: boolean;
  /** Number of epochs behind current to close (GAR-006 retention). Default 7. */
  epochRetention?: number;
  /** Warn when wallet balance drops below this many SOL. Default 0.3. */
  warnBalanceSol?: number;
  /** Critical threshold — health endpoint reports unhealthy. Default 0.1. */
  criticalBalanceSol?: number;
  log: CrankerLogger;
  /** Callback to read epoch settings from chain */
  getEpochSettings: () => Promise<EpochSettings>;
  /** NameRegistry PDA — pass to enable name prescription during prescribeEpoch */
  nameRegistryAccount?: PublicKey;
}

export interface StateMachineMetrics {
  currentEpoch: number;
  phase: string;
  tallyProgress: string;
  distributionProgress: string;
  lastActionTime: string;
  lastTickTime: string;
  walletBalanceSol: string;
  walletBalanceCritical: boolean;
  epochsCreated: number;
  tallyBatches: number;
  prescriptions: number;
  distributionBatches: number;
  epochsClosed: number;
  errorsAlreadyDone: number;
  errorsNotReady: number;
  errorsReal: number;
  consecutiveRealErrors: number;
}

export class EpochStateMachine {
  private config: StateMachineConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private busy = false;

  // Metrics
  private metrics: StateMachineMetrics = {
    currentEpoch: 0,
    phase: 'idle',
    tallyProgress: '0/0',
    distributionProgress: '0/0',
    lastActionTime: '',
    lastTickTime: '',
    walletBalanceSol: '0',
    walletBalanceCritical: false,
    epochsCreated: 0,
    tallyBatches: 0,
    prescriptions: 0,
    distributionBatches: 0,
    epochsClosed: 0,
    errorsAlreadyDone: 0,
    errorsNotReady: 0,
    errorsReal: 0,
    consecutiveRealErrors: 0,
  };

  constructor(config: StateMachineConfig) {
    this.config = config;
  }

  getMetrics(): StateMachineMetrics {
    return { ...this.metrics };
  }

  isBusy(): boolean {
    return this.busy;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.config.log.info('Epoch cranker started', {
      pollIntervalMs: this.config.pollIntervalMs,
      batchSize: this.config.batchSize,
    });
    // Run immediately, then on interval
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.pollIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.config.log.info('Epoch cranker stopped');
  }

  private async tick(): Promise<void> {
    if (this.busy) return; // Skip if previous tick is still running
    this.busy = true;

    try {
      // Random jitter (1-5s) to reduce collision with other crankers
      const jitter = Math.floor(Math.random() * 4000) + 1000;
      await sleep(jitter);

      // Check if stopped during jitter sleep
      if (!this.running) return;

      await this.updateWalletBalance();
      await this.runCycle();
      this.metrics.lastTickTime = new Date().toISOString();
    } catch (err) {
      this.handleError(err, 'tick');
    } finally {
      this.busy = false;
    }
  }

  private async runCycle(): Promise<void> {
    const { contract, log, batchSize, enableCloseEpochs } = this.config;

    // 1. Read epoch settings
    let settings: EpochSettings;
    try {
      settings = await this.config.getEpochSettings();
    } catch (err) {
      log.error('Failed to read epoch settings', { error: String(err) });
      return;
    }

    if (!settings.enabled) {
      this.metrics.phase = 'disabled';
      log.debug('Epochs are disabled');
      return;
    }

    const currentIndex = settings.currentEpochIndex;
    // The most recently created epoch is currentIndex - 1
    // (currentIndex is the NEXT epoch to be created)
    const targetEpochIndex = currentIndex > 0 ? currentIndex - 1 : 0;
    this.metrics.currentEpoch = targetEpochIndex;

    const now = Math.floor(Date.now() / 1000);
    const nextEpochStart = settings.genesisTimestamp + currentIndex * settings.epochDuration;

    // 2. Bootstrap: no epochs exist yet, create epoch 0 if genesis time has passed
    if (currentIndex === 0) {
      if (now >= nextEpochStart) {
        this.metrics.phase = 'create_epoch';
        log.info('Creating epoch', { epochIndex: 0 });
        try {
          const result = await contract.createEpoch();
          log.info('Epoch created', { epochIndex: 0, tx: result.id });
          this.metrics.epochsCreated++;
          this.metrics.lastActionTime = new Date().toISOString();
        } catch (err) {
          this.handleError(err, 'create_epoch');
        }
      } else {
        this.metrics.phase = 'waiting_for_genesis';
        log.debug('Waiting for genesis', {
          remainingSeconds: nextEpochStart - now,
        });
      }
      return;
    }

    // 3. Read current epoch state
    // IMPORTANT: Always complete the previous epoch's lifecycle
    // (tally → prescribe → wait → distribute → close) BEFORE creating a new
    // epoch. Otherwise rewards for the previous epoch never get distributed.
    const epoch = await contract.getEpochRaw(targetEpochIndex);
    if (!epoch) {
      this.metrics.phase = 'waiting_for_epoch';
      log.debug('No epoch account found', { epochIndex: targetEpochIndex });
      return;
    }

    // 4. Tally weights
    // Edge case: when activeGatewayCount === 0, tallyIndex is already >= active
    // count so the contract will set weights_tallied=1 with no remaining_accounts.
    // We must still submit ONE tx to trigger that flag flip, otherwise we loop.
    if (epoch.weightsTallied === 0) {
      this.metrics.phase = 'tally_weights';
      this.metrics.tallyProgress = `${epoch.tallyIndex}/${epoch.activeGatewayCount}`;
      log.info('Tallying weights', {
        epochIndex: targetEpochIndex,
        progress: `${epoch.tallyIndex}/${epoch.activeGatewayCount}`,
      });
      try {
        const gatewayPDAs = epoch.activeGatewayCount > 0
          ? await contract.getRegistryGatewayPDAs(epoch.tallyIndex, batchSize)
          : [];
        const result = await contract.tallyWeights({
          epochIndex: targetEpochIndex,
          gatewayAccounts: gatewayPDAs,
        });
        log.info('Tally batch submitted', { tx: result.id });
        this.metrics.tallyBatches++;
        this.metrics.lastActionTime = new Date().toISOString();
      } catch (err) {
        this.handleError(err, 'tally_weights');
      }
      return;
    }

    // 5. Prescribe epoch
    if (epoch.prescriptionsDone === 0) {
      this.metrics.phase = 'prescribe_epoch';
      log.info('Prescribing epoch', { epochIndex: targetEpochIndex });
      try {
        // Pass all active gateway PDAs — program selects the ones it needs
        const allGatewayPDAs = await contract.getAllRegistryGatewayPDAs();
        const result = await contract.prescribeEpoch({
          epochIndex: targetEpochIndex,
          gatewayAccounts: allGatewayPDAs,
          nameRegistryAccount: this.config.nameRegistryAccount,
        });
        log.info('Epoch prescribed', { tx: result.id });
        this.metrics.prescriptions++;
        this.metrics.lastActionTime = new Date().toISOString();
      } catch (err) {
        this.handleError(err, 'prescribe_epoch');
      }
      return;
    }

    // 6. Wait for epoch to end (observations happen during the epoch)
    if (now < epoch.endTimestamp) {
      this.metrics.phase = 'waiting_for_observations';
      const remaining = epoch.endTimestamp - now;
      log.debug('Waiting for epoch to end', {
        epochIndex: targetEpochIndex,
        remainingSeconds: remaining,
      });
      return;
    }

    // 7. Distribute rewards
    // Edge case: when activeGatewayCount === 0, call distributeEpoch with an
    // empty remaining_accounts array so the contract sets rewards_distributed=1.
    if (epoch.rewardsDistributed === 0) {
      this.metrics.phase = 'distribute_epoch';
      this.metrics.distributionProgress = `${epoch.distributionIndex}/${epoch.activeGatewayCount}`;
      log.info('Distributing epoch', {
        epochIndex: targetEpochIndex,
        progress: `${epoch.distributionIndex}/${epoch.activeGatewayCount}`,
      });
      try {
        const gatewayPDAs = epoch.activeGatewayCount > 0
          ? await contract.getRegistryGatewayPDAs(epoch.distributionIndex, batchSize)
          : [];
        const result = await contract.distributeEpoch({
          epochIndex: targetEpochIndex,
          gatewayAccounts: gatewayPDAs,
        });
        log.info('Distribution batch submitted', { tx: result.id });
        this.metrics.distributionBatches++;
        this.metrics.lastActionTime = new Date().toISOString();
      } catch (err) {
        this.handleError(err, 'distribute_epoch');
      }
      return;
    }

    // 8. Close old epochs (optional) — GAR-006: close epochs older than retention
    const retention = this.config.epochRetention ?? 7;
    if (enableCloseEpochs && targetEpochIndex >= retention) {
      const closeTarget = targetEpochIndex - retention;
      this.metrics.phase = 'close_epoch';
      try {
        const oldEpoch = await contract.getEpochRaw(closeTarget);
        if (oldEpoch && oldEpoch.rewardsDistributed === 1) {
          log.info('Closing old epoch', { epochIndex: closeTarget });
          const result = await contract.closeEpoch({ epochIndex: closeTarget });
          log.info('Epoch closed', { epochIndex: closeTarget, tx: result.id });
          this.metrics.epochsClosed++;
          this.metrics.lastActionTime = new Date().toISOString();
        }
      } catch (err) {
        // close_epoch has stricter preconditions than other steps (epoch must
        // be fully distributed AND past retention). Errors here are expected
        // during normal operation and are already counted via handleError's
        // category metric — no extra logging needed.
        this.handleError(err, 'close_epoch');
      }
    }

    // 9. Current epoch is fully processed. If time has passed nextEpochStart,
    // create the next epoch. This MUST come after the distribute check above,
    // otherwise rewards for the current epoch would never be distributed
    // (the cranker would create the next epoch first and lose track of the
    // previous one).
    if (now >= nextEpochStart) {
      this.metrics.phase = 'create_epoch';
      log.info('Creating epoch', { epochIndex: currentIndex });
      try {
        const result = await contract.createEpoch();
        log.info('Epoch created', { epochIndex: currentIndex, tx: result.id });
        this.metrics.epochsCreated++;
        this.metrics.lastActionTime = new Date().toISOString();
      } catch (err) {
        const cat = this.handleError(err, 'create_epoch');
        if (cat === 'already_done') {
          log.debug('Epoch already created — will process on next tick');
        }
      }
      return;
    }

    // 10. All done for this epoch, waiting for next one to be due
    this.metrics.phase = 'idle';
    log.debug('Epoch cycle complete', { epochIndex: targetEpochIndex });
  }

  private handleError(error: unknown, context: string): ErrorCategory {
    const category = classifyError(error);
    const msg = error instanceof Error ? error.message : String(error);

    switch (category) {
      case 'already_done':
        this.metrics.errorsAlreadyDone++;
        this.metrics.consecutiveRealErrors = 0;
        this.config.log.debug(`[${context}] Already done: ${msg}`);
        break;
      case 'not_ready':
        this.metrics.errorsNotReady++;
        this.metrics.consecutiveRealErrors = 0;
        this.config.log.debug(`[${context}] Not ready: ${msg}`);
        break;
      case 'real':
        this.metrics.errorsReal++;
        this.metrics.consecutiveRealErrors++;
        this.config.log.error(`[${context}] Error: ${msg}`);
        break;
    }

    return category;
  }

  private async updateWalletBalance(): Promise<void> {
    try {
      const balance = await this.config.connection.getBalance(
        this.config.signer.publicKey,
      );
      const sol = balance / LAMPORTS_PER_SOL;
      this.metrics.walletBalanceSol = sol.toFixed(4);

      const warnThreshold = this.config.warnBalanceSol ?? 0.3;
      const criticalThreshold = this.config.criticalBalanceSol ?? 0.1;
      this.metrics.walletBalanceCritical = sol < criticalThreshold;

      if (sol < criticalThreshold) {
        this.config.log.error('Wallet balance CRITICAL — cranker will halt soon', {
          balanceSol: sol.toFixed(4),
          critical: criticalThreshold,
          publicKey: this.config.signer.publicKey.toBase58(),
        });
      } else if (sol < warnThreshold) {
        this.config.log.warn('Wallet balance low — top up soon', {
          balanceSol: sol.toFixed(4),
          warn: warnThreshold,
          publicKey: this.config.signer.publicKey.toBase58(),
        });
      }
    } catch {
      // Non-critical — don't fail the cycle
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
