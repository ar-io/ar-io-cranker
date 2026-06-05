/**
 * Epoch cranker state machine.
 *
 * Drives the 6-step permissionless epoch pipeline:
 * create_epoch → tally_weights → prescribe_epoch → [wait] → distribute_epoch → close_epoch
 *
 * Each poll cycle reads on-chain state and executes the next required step.
 * All instructions are idempotent — safe to run multiple crankers concurrently.
 */
import type { Address, Rpc, SolanaRpcApi, TransactionSigner } from '@solana/kit';
import { classifyError, type ErrorCategory } from './errors.js';

const LAMPORTS_PER_SOL = 1_000_000_000;

// We import the SDK's SolanaARIOWriteable which has all the epoch methods.
// In standalone mode, the cranker instantiates this directly.
// In observer mode, it receives one from the observer's system.ts.
//
// The type is defined inline here to avoid a direct import dependency on the SDK
// build artifacts. The actual object passed in must have these methods.
/** Result of one `SolanaARIOWriteable.crankEpochStep()` call (mirrors @ar.io/sdk). */
export interface CrankEpochStepResult {
  action:
    | 'create'
    | 'tally'
    | 'prescribe'
    | 'distribute'
    | 'compound'
    | 'update_demand_factor'
    | 'prune_returned_names'
    | 'close_observation'
    | 'close'
    | 'idle';
  epochIndex?: number;
  txId?: string;
  progress?: { index: number; total: number };
  reason?: string;
}

/**
 * The subset of @ar.io/sdk's `SolanaARIOWriteable` this state machine drives.
 *
 * `crankEpochStep` owns the entire create → tally → prescribe → distribute →
 * close lifecycle — including the size-safe prescribe prediction
 * (`getPredictedObserverPDAs`, ≤50 PDAs, never the whole registry) and the
 * `InvalidGatewayAccount` re-predict-and-retry. The cranker only schedules it
 * and maps the result to metrics/logging. (The permissionless cleanup pass
 * still reaches the broader SDK surface via an `as any` cast in `runCleanup`.)
 */
export interface EpochCrankerContract {
  crankEpochStep(opts: {
    batchSize?: number;
    nameRegistryAccount?: Address | null;
    enableClose?: boolean;
    epochRetention?: number;
    enablePrune?: boolean;
    pruneBatchSize?: number;
    pruneScanIntervalMs?: number;
  }): Promise<CrankEpochStepResult>;
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
  rpc: Rpc<SolanaRpcApi>;
  signer: TransactionSigner;
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
  nameRegistryAccount?: Address;
  // --- Permissionless cleanup loop (mirrors ar-io-observer/src/epoch/epoch-cranker.ts). ---
  /** Master toggle for the cleanup pass. Default true. */
  enableCleanup?: boolean;
  /** Minimum interval between cleanup passes. Default 300_000 ms (5 min). */
  cleanupMinIntervalMs?: number;
  /** Batch size for ArNS record / returned-name pruning. Default 15. */
  cleanupBatchSize?: number;
  /** Per-cycle tx cap across all cleanup sub-phases. Default 50. */
  maxCleanupTxsPerCycle?: number;
  /** Consecutive failed observations before a gateway becomes prune-eligible. Default 30. */
  cleanupFailureThreshold?: number;
  /** Recent signatures to scan when reclaiming leaked prescribe ALTs (Phase 7). Default 200; 0 disables. */
  altReclaimScanLimit?: number;
  /** Sweep delegates out of gateways with delegation disabled (Phase 8 — Fix #6). Default true. */
  enableDisabledGatewaySweep?: boolean;
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
  compoundBatches: number;
  demandFactorRolls: number;
  returnedNamesPruneBatches: number;
  observationCloseBatches: number;
  errorsAlreadyDone: number;
  errorsNotReady: number;
  errorsReal: number;
  consecutiveRealErrors: number;
  cleanupTxsLastCycle: number;
  cleanupTxsTotal: number;
  lastCleanupTime: string;
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
    compoundBatches: 0,
    demandFactorRolls: 0,
    returnedNamesPruneBatches: 0,
    observationCloseBatches: 0,
    errorsAlreadyDone: 0,
    errorsNotReady: 0,
    errorsReal: 0,
    consecutiveRealErrors: 0,
    cleanupTxsLastCycle: 0,
    cleanupTxsTotal: 0,
    lastCleanupTime: '',
  };

  // Timestamp of the last cleanup pass — used to throttle the cleanup
  // sub-pipeline to at most once per `cleanupMinIntervalMs`.
  private lastCleanupRunMs = 0;

  // Lowest epoch index that actually exists on-chain (AO→Solana continuity
  // floor). Cached so the Phase-4 observation cleanup never fans out
  // `closeObservation` to pre-continuity epochs that never existed (the 3007
  // RPC-noise floor). Null until first probed.
  private firstExistingEpochIndex: number | null = null;

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
    const { contract, log } = this.config;

    // 1. Read epoch settings — the cheap source of truth for the `enabled`
    // gate, `metrics.currentEpoch`, and the cleanup target. (crankEpochStep
    // reads settings again internally to drive the lifecycle.)
    let settings: EpochSettings;
    try {
      settings = await this.config.getEpochSettings();
    } catch (err) {
      // Transient RPC issues (fetch failed, blockhash not found) classify as
      // not_ready and must NOT count as real errors for the health endpoint.
      this.handleError(err, 'read_epoch_settings');
      return;
    }

    if (!settings.enabled) {
      this.metrics.phase = 'disabled';
      log.debug('Epochs are disabled');
      return;
    }

    const currentIndex = settings.currentEpochIndex;
    // currentIndex is the NEXT epoch to create; the live one is currentIndex-1.
    const targetEpochIndex = currentIndex > 0 ? currentIndex - 1 : 0;
    this.metrics.currentEpoch = targetEpochIndex;

    // 2. Advance the epoch lifecycle by ONE step. `crankEpochStep` (in
    // @ar.io/sdk) owns create → tally → prescribe → distribute → close,
    // including the size-safe prescribe prediction (≤50 Gateway PDAs, never the
    // whole registry — the fix for MAX_TX_ACCOUNT_LOCKS) and the
    // InvalidGatewayAccount re-predict-and-retry. We only map the result to
    // metrics/logging and classify any thrown error.
    let action: CrankEpochStepResult['action'] | undefined;
    try {
      const result = await contract.crankEpochStep({
        batchSize: this.config.batchSize,
        enableClose: this.config.enableCloseEpochs,
        epochRetention: this.config.epochRetention ?? 7,
        nameRegistryAccount: this.config.nameRegistryAccount,
        // Returned-name pruning is folded into the epoch step (solana.36+):
        // tie it to the same cleanup config the runCleanup phases use.
        enablePrune: this.config.enableCleanup !== false,
        pruneBatchSize: this.config.cleanupBatchSize,
        pruneScanIntervalMs: this.config.cleanupMinIntervalMs,
      });
      this.applyCrankResult(result);
      action = result.action;
    } catch (err) {
      this.handleError(err, 'crank_epoch');
    }

    // 3. Permissionless prune / cleanup (best-effort, throttled). Gated on the
    // quiescent tail (`action === 'idle'`) so it never competes with a pending
    // lifecycle step — same intent as the previous early-return structure.
    if (action === 'idle' && this.config.enableCleanup !== false) {
      const minInterval = this.config.cleanupMinIntervalMs ?? 300_000;
      const elapsed = Date.now() - this.lastCleanupRunMs;
      if (elapsed >= minInterval) {
        this.lastCleanupRunMs = Date.now();
        try {
          await this.runCleanup(targetEpochIndex);
        } catch (err) {
          this.handleError(err, 'cleanup');
        }
      }
    }
  }

  /** Map a `crankEpochStep` result onto the cranker's metrics + logging. */
  private applyCrankResult(r: CrankEpochStepResult): void {
    const { log } = this.config;
    const t = new Date().toISOString();
    // A successful (non-throwing) step means we're making progress / not stuck.
    this.metrics.consecutiveRealErrors = 0;
    switch (r.action) {
      case 'create':
        this.metrics.phase = 'create_epoch';
        this.metrics.epochsCreated++;
        this.metrics.lastActionTime = t;
        log.info('Epoch created', { epochIndex: r.epochIndex, tx: r.txId });
        break;
      case 'tally':
        this.metrics.phase = 'tally_weights';
        this.metrics.tallyBatches++;
        if (r.progress)
          this.metrics.tallyProgress = `${r.progress.index}/${r.progress.total}`;
        this.metrics.lastActionTime = t;
        log.info('Tally batch submitted', {
          tx: r.txId,
          progress: this.metrics.tallyProgress,
        });
        break;
      case 'prescribe':
        this.metrics.phase = 'prescribe_epoch';
        this.metrics.prescriptions++;
        this.metrics.lastActionTime = t;
        log.info('Epoch prescribed', { epochIndex: r.epochIndex, tx: r.txId });
        break;
      case 'distribute':
        this.metrics.phase = 'distribute_epoch';
        this.metrics.distributionBatches++;
        if (r.progress)
          this.metrics.distributionProgress = `${r.progress.index}/${r.progress.total}`;
        this.metrics.lastActionTime = t;
        log.info('Distribution batch submitted', {
          tx: r.txId,
          progress: this.metrics.distributionProgress,
        });
        break;
      case 'close':
        this.metrics.phase = 'close_epoch';
        this.metrics.epochsClosed++;
        this.metrics.lastActionTime = t;
        log.info('Epoch closed', { epochIndex: r.epochIndex, tx: r.txId });
        break;
      case 'compound':
        this.metrics.phase = 'compound_rewards';
        this.metrics.compoundBatches++;
        this.metrics.lastActionTime = t;
        log.info('Delegate rewards compounded', {
          tx: r.txId,
          progress: r.progress
            ? `${r.progress.index}/${r.progress.total}`
            : undefined,
        });
        break;
      case 'update_demand_factor':
        this.metrics.phase = 'update_demand_factor';
        this.metrics.demandFactorRolls++;
        this.metrics.lastActionTime = t;
        log.info('Demand factor rolled', { tx: r.txId });
        break;
      case 'prune_returned_names':
        this.metrics.phase = 'prune_returned_names';
        this.metrics.returnedNamesPruneBatches++;
        this.metrics.lastActionTime = t;
        log.info('Pruned expired returned names', {
          tx: r.txId,
          progress: r.progress
            ? `${r.progress.index}/${r.progress.total}`
            : undefined,
        });
        break;
      case 'close_observation':
        this.metrics.phase = 'close_observation';
        this.metrics.observationCloseBatches++;
        this.metrics.lastActionTime = t;
        log.info('Closed epoch observations (pre close_epoch)', {
          epochIndex: r.epochIndex,
          tx: r.txId,
          progress: r.progress
            ? `${r.progress.index}/${r.progress.total}`
            : undefined,
        });
        break;
      case 'idle':
        this.metrics.phase = r.reason ?? 'idle';
        log.debug('Idle', { reason: r.reason });
        break;
    }
  }

  /**
   * Permissionless prune / cleanup pass — mirrors
   * ar-io-observer/src/epoch/epoch-cranker.ts::runCleanup. All sub-steps
   * are best-effort. A per-cycle tx budget across the 6 phases prevents
   * a pathological discovery from burning fees on a single cycle.
   *
   * Methods consumed here are on `SolanaARIOWriteable` (in @ar.io/sdk's
   * solana entrypoint) but are not in the cranker's narrow
   * `EpochCrankerContract` facade — cast `as any` to access them. If you
   * want stricter typing, extend the facade.
   */
  private async runCleanup(currentEpochIndex: number): Promise<void> {
    const { contract, log } = this.config;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ario = contract as any;
    const batchSize = this.config.cleanupBatchSize ?? 15;
    const maxTxs = this.config.maxCleanupTxsPerCycle ?? 50;
    const failureThreshold = this.config.cleanupFailureThreshold ?? 30;
    const now = Math.floor(Date.now() / 1000);

    // Mutable budget — every successful submission decrements; sub-steps
    // exit early when it hits 0.
    const budget = { remaining: maxTxs };

    log.debug('Cleanup cycle starting', {
      maxTxs,
      batchSize,
      failureThreshold,
    });

    // Phase 1: ArNS expired records — gated on `next_records_prune_timestamp`.
    if (budget.remaining > 0) {
      try {
        const cfg = await ario.getArnsConfigRaw();
        if (cfg && Number(cfg.nextRecordsPruneTimestamp) <= now) {
          const expired = await ario.getExpiredArnsRecords(now);
          while (expired.length > 0 && budget.remaining > 0) {
            const batch = expired
              .splice(0, batchSize)
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .map((r: any) => r.pubkey);
            try {
              await ario.pruneExpiredNames({
                maxNames: batch.length,
                arnsRecords: batch,
              });
              budget.remaining--;
              log.info('Pruned expired ArnsRecords', { count: batch.length });
            } catch (err) {
              this.handleError(err, 'prune_expired_names');
              break;
            }
          }
        }
      } catch (err) {
        this.handleError(err, 'cleanup_arns_records_scan');
      }
    }

    // Phase 2: ArNS expired returned names — now owned by `crankEpochStep`
    // (@ar.io/sdk >= solana.36). It scans the ReturnedName PDAs directly in the
    // epoch step's idle exits, WITHOUT the stale `next_returned_names_prune_timestamp`
    // gate that stranded imported returned names. Removed here so there's a
    // single source of truth — see the crankEpochStep call in runCycle.

    // Phase 3: Deficient gateways → prune_gateway, plus Gone gateways → finalize_gone.
    if (budget.remaining > 0) {
      try {
        const deficient = await ario.getDeficientGateways(failureThreshold);
        for (const g of deficient) {
          if (budget.remaining <= 0) break;
          try {
            await ario.pruneGateway({ gateway: g.operator });
            budget.remaining--;
            log.info('Pruned deficient gateway', {
              operator: g.operator,
              failedConsecutive: g.failedConsecutive,
            });
          } catch (err) {
            this.handleError(err, 'prune_gateway');
          }
        }
      } catch (err) {
        this.handleError(err, 'cleanup_deficient_gateways_scan');
      }
    }
    if (budget.remaining > 0) {
      try {
        const gone = await ario.getGoneGateways();
        for (const g of gone) {
          if (budget.remaining <= 0) break;
          try {
            await ario.finalizeGone({ gateway: g.operator });
            budget.remaining--;
            log.info('Finalized gone gateway', { operator: g.operator });
          } catch (err) {
            this.handleError(err, 'finalize_gone');
          }
        }
      } catch (err) {
        this.handleError(err, 'cleanup_gone_gateways_scan');
      }
    }

    // Phase 4: Close old observations from epochs older than
    // `currentEpochIndex - retention`. The Observation PDA seed is
    // `(epochIndex, observer)`. We need the observer addresses — easiest
    // source is the active GatewayRegistry. Observers not in the current
    // registry won't be found; `closeObservation` no-ops on missing PDAs
    // (Anchor returns AccountNotInitialized / AccountOwnedByWrongProgram,
    // both classified as `already_done`).
    //
    // CONTINUITY FLOOR (mirror of ar-io-observer/src/epoch/epoch-cranker.ts):
    // at AO→Solana cutover the network jumped `current_epoch_index` straight to
    // the AO value (~454) with NO prior epochs on-chain, so every epoch below
    // the first-created index never existed. Fanning `closeObservation` out to
    // those is N guaranteed 3007 misses PER CYCLE (wasted RPC simulations →
    // 429s) that classify as `already_done` and silently burn the budget. Skip
    // below the known floor with zero RPC; otherwise probe the epoch's
    // existence ONCE and skip the whole observer fan-out if it never existed.
    const retention = this.config.epochRetention ?? 7;
    if (budget.remaining > 0 && currentEpochIndex >= retention + 1) {
      try {
        const closeTarget = currentEpochIndex - retention - 1;
        if (
          this.firstExistingEpochIndex !== null &&
          closeTarget < this.firstExistingEpochIndex
        ) {
          // Below the continuity floor — nothing to close, zero RPC.
        } else {
          const targetEpoch = await ario.getEpochRaw?.(closeTarget);
          if (!targetEpoch) {
            // Never existed (pre-continuity gap) — raise the floor estimate and
            // skip the per-observer fan-out entirely.
            this.firstExistingEpochIndex = closeTarget + 1;
          } else {
            this.firstExistingEpochIndex = closeTarget; // pin the real floor
            const observerAddrs = await ario.getRegistryGatewayAddresses?.();
            if (Array.isArray(observerAddrs)) {
              for (const observer of observerAddrs) {
                if (budget.remaining <= 0) break;
                try {
                  await ario.closeObservation({
                    epochIndex: closeTarget,
                    observer,
                  });
                  budget.remaining--;
                } catch (err) {
                  const cat = this.handleError(err, 'close_observation');
                  if (cat === 'real') break;
                }
              }
            }
          }
        }
      } catch (err) {
        this.handleError(err, 'cleanup_observations_scan');
      }
    }

    // Phase 5: Dust accounts — empty Delegations + drained Withdrawals.
    if (budget.remaining > 0) {
      try {
        const empty = await ario.getEmptyDelegations();
        for (const d of empty) {
          if (budget.remaining <= 0) break;
          try {
            await ario.closeEmptyDelegation({
              gateway: d.gateway,
              delegator: d.delegator,
            });
            budget.remaining--;
          } catch (err) {
            this.handleError(err, 'close_empty_delegation');
          }
        }
      } catch (err) {
        this.handleError(err, 'cleanup_empty_delegations_scan');
      }
    }
    if (budget.remaining > 0) {
      try {
        const drained = await ario.getDrainedWithdrawals();
        for (const w of drained) {
          if (budget.remaining <= 0) break;
          try {
            await ario.closeDrainedWithdrawal({
              owner: w.owner,
              withdrawalId: w.withdrawalId,
            });
            budget.remaining--;
          } catch (err) {
            this.handleError(err, 'close_drained_withdrawal');
          }
        }
      } catch (err) {
        this.handleError(err, 'cleanup_drained_withdrawals_scan');
      }
    }

    // Phase 6: Expired primary-name requests. Skipping `releaseVault` —
    // it requires `owner: Signer`, so the cranker can only release its
    // own vaults. Users have a strong incentive to call release_vault
    // themselves (it returns their tokens).
    if (budget.remaining > 0) {
      try {
        const expired = await ario.getExpiredPrimaryNameRequests(now);
        for (const r of expired) {
          if (budget.remaining <= 0) break;
          try {
            await ario.closeExpiredRequest({ initiator: r.initiator });
            budget.remaining--;
          } catch (err) {
            this.handleError(err, 'close_expired_request');
          }
        }
      } catch (err) {
        this.handleError(err, 'cleanup_expired_requests_scan');
      }
    }

    // Phase 7: Reclaim leaked prescribe Address Lookup Tables. Each
    // prescribe_epoch via the ephemeral-ALT path leaves a single-use table
    // allocated (~0.0126 SOL rent); reclaiming needs deactivate → ~513-slot
    // cooldown → close, so it lives here rather than inline. Discovery walks the
    // signer's tx history (the ALT program can't be enumerated via
    // getProgramAccounts) and only touches tables whose entries are all
    // GAR/ArNS-owned (the prescribe fingerprint). Each deactivate/close is one
    // submission, charged to the same budget.
    const altScanLimit = this.config.altReclaimScanLimit ?? 200;
    if (budget.remaining > 0 && altScanLimit > 0) {
      try {
        // Optional-chained: older @ar.io/sdk builds lack this method (added
        // alongside the ephemeral-ALT prescribe path). Absent → no-op, no error.
        const r = await ario.reclaimLookupTableRent?.({
          maxTables: budget.remaining,
          scanLimit: altScanLimit,
        });
        const submitted = (r?.deactivated ?? 0) + (r?.closed ?? 0);
        budget.remaining -= submitted;
        if (submitted > 0) {
          log.info('Reclaimed prescribe ALTs', {
            deactivated: r.deactivated,
            closed: r.closed,
            candidates: r.candidates,
          });
        }
      } catch (err) {
        this.handleError(err, 'cleanup_reclaim_lookup_tables');
      }
    }

    // Phase 8: Disabled-gateway delegate sweep (WP §6.3 / Fix #6). When an
    // operator turns off `allow_delegated_staking`, existing delegates are NOT
    // auto-withdrawn (Solana can't iterate PDAs in one tx). This permissionless
    // crank moves each stranded delegate into its own 30-day withdrawal vault,
    // which also unblocks the operator's re-enable (gated on
    // total_delegated_stake == 0 + cooldown). `claimDelegateFromDisabledGateway`
    // is permissionless: the cranker pays rent; stake routes to the delegate.
    if (budget.remaining > 0 && this.config.enableDisabledGatewaySweep !== false) {
      try {
        const disabled = await ario.getDisabledGatewaysWithDelegatedStake();
        for (const gw of disabled) {
          if (budget.remaining <= 0) break;
          try {
            // Enumerate this gateway's remaining delegates and crank each out.
            const delegates = await ario.getGatewayDelegates({
              address: gw.operator,
              limit: budget.remaining,
            });
            for (const d of delegates.items) {
              if (budget.remaining <= 0) break;
              // Skip delegates already drained to 0 (e.g. self-claimed earlier);
              // claiming them would fail the `delegation.amount > 0` constraint.
              // They're swept off by the empty-delegation phase, not here.
              if (Number(d.delegatedStake ?? 0) <= 0) continue;
              try {
                await ario.claimDelegateFromDisabledGateway({
                  gatewayAddress: gw.operator,
                  delegatorAddress: d.address,
                });
                budget.remaining--;
              } catch (err) {
                this.handleError(err, 'claim_delegate_from_disabled_gateway');
              }
            }
          } catch (err) {
            this.handleError(err, 'disabled_gateway_delegates_scan');
          }
        }
      } catch (err) {
        this.handleError(err, 'cleanup_disabled_gateways_scan');
      }
    }

    const txsSubmitted = maxTxs - budget.remaining;
    this.metrics.cleanupTxsLastCycle = txsSubmitted;
    this.metrics.cleanupTxsTotal += txsSubmitted;
    this.metrics.lastCleanupTime = new Date().toISOString();
    log.debug('Cleanup cycle complete', {
      txsSubmitted,
      remainingBudget: budget.remaining,
    });
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
      // @solana/kit returns `{ value: bigint }` from getBalance.
      const { value } = await this.config.rpc
        .getBalance(this.config.signer.address)
        .send();
      const sol = Number(value) / LAMPORTS_PER_SOL;
      this.metrics.walletBalanceSol = sol.toFixed(4);

      const warnThreshold = this.config.warnBalanceSol ?? 0.3;
      const criticalThreshold = this.config.criticalBalanceSol ?? 0.1;
      this.metrics.walletBalanceCritical = sol < criticalThreshold;

      if (sol < criticalThreshold) {
        this.config.log.error('Wallet balance CRITICAL — cranker will halt soon', {
          balanceSol: sol.toFixed(4),
          critical: criticalThreshold,
          address: this.config.signer.address,
        });
      } else if (sol < warnThreshold) {
        this.config.log.warn('Wallet balance low — top up soon', {
          balanceSol: sol.toFixed(4),
          warn: warnThreshold,
          address: this.config.signer.address,
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
