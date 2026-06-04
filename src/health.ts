/**
 * Health check and Prometheus metrics HTTP server.
 *
 * Endpoints:
 *   GET /health   — JSON with operational state; 200 if healthy, 503 if unhealthy
 *   GET /metrics  — Prometheus text format
 *   GET /         — 200 "ok" (basic liveness, never 503)
 */
import * as http from 'node:http';

export interface CrankerMetrics {
  currentEpoch: number;
  phase: string;
  tallyProgress: string;
  distributionProgress: string;
  lastActionTime: string;
  lastTickTime: string;
  walletBalanceSol: string;
  walletBalanceCritical: boolean;
  uptimeSeconds: number;
  epochsCreated: number;
  tallyBatches: number;
  prescriptions: number;
  distributionBatches: number;
  epochsClosed: number;
  compoundBatches: number;
  demandFactorRolls: number;
  errorsAlreadyDone: number;
  errorsNotReady: number;
  errorsReal: number;
  consecutiveRealErrors: number;
  cleanupTxsLastCycle: number;
  cleanupTxsTotal: number;
  lastCleanupTime: string;
}

export interface HealthServerConfig {
  port: number;
  host: string;
  /** Tick must have run within this many ms to be healthy. */
  maxTickAgeMs: number;
  /** Consecutive real errors that trip unhealthy status. */
  maxConsecutiveRealErrors: number;
  getMetrics: () => CrankerMetrics;
}

interface HealthStatus {
  healthy: boolean;
  reason: string | null;
}

function evaluateHealth(m: CrankerMetrics, cfg: HealthServerConfig): HealthStatus {
  // Tick staleness
  if (m.lastTickTime) {
    const lastTick = Date.parse(m.lastTickTime);
    if (!isNaN(lastTick)) {
      const ageMs = Date.now() - lastTick;
      if (ageMs > cfg.maxTickAgeMs) {
        return { healthy: false, reason: `tick stale (${Math.floor(ageMs / 1000)}s since last tick)` };
      }
    }
  } else if (m.uptimeSeconds > 60) {
    // No tick recorded after 60s — state machine never started
    return { healthy: false, reason: 'no tick recorded after startup' };
  }

  if (m.walletBalanceCritical) {
    return { healthy: false, reason: `wallet balance critical (${m.walletBalanceSol} SOL)` };
  }

  if (m.consecutiveRealErrors >= cfg.maxConsecutiveRealErrors) {
    return {
      healthy: false,
      reason: `${m.consecutiveRealErrors} consecutive real errors`,
    };
  }

  return { healthy: true, reason: null };
}

export function startHealthServer(cfg: HealthServerConfig): http.Server {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/health') {
      const m = cfg.getMetrics();
      const status = evaluateHealth(m, cfg);
      res.writeHead(status.healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: status.healthy ? 'ok' : 'unhealthy',
        reason: status.reason,
        currentEpoch: m.currentEpoch,
        phase: m.phase,
        tallyProgress: m.tallyProgress,
        distributionProgress: m.distributionProgress,
        lastActionTime: m.lastActionTime,
        lastTickTime: m.lastTickTime,
        walletBalance: m.walletBalanceSol,
        walletBalanceCritical: m.walletBalanceCritical,
        consecutiveRealErrors: m.consecutiveRealErrors,
        uptimeSeconds: m.uptimeSeconds,
        cleanupTxsLastCycle: m.cleanupTxsLastCycle,
        cleanupTxsTotal: m.cleanupTxsTotal,
        lastCleanupTime: m.lastCleanupTime || null,
      }));
    } else if (url === '/metrics') {
      const m = cfg.getMetrics();
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end([
        `# HELP cranker_epochs_created_total Total epochs created by this cranker`,
        `# TYPE cranker_epochs_created_total counter`,
        `cranker_epochs_created_total ${m.epochsCreated}`,
        `# HELP cranker_tally_batches_total Total tally_weights batches submitted`,
        `# TYPE cranker_tally_batches_total counter`,
        `cranker_tally_batches_total ${m.tallyBatches}`,
        `# HELP cranker_prescriptions_total Total prescribe_epoch calls`,
        `# TYPE cranker_prescriptions_total counter`,
        `cranker_prescriptions_total ${m.prescriptions}`,
        `# HELP cranker_distribution_batches_total Total distribute_epoch batches submitted`,
        `# TYPE cranker_distribution_batches_total counter`,
        `cranker_distribution_batches_total ${m.distributionBatches}`,
        `# HELP cranker_epochs_closed_total Total epochs closed`,
        `# TYPE cranker_epochs_closed_total counter`,
        `cranker_epochs_closed_total ${m.epochsClosed}`,
        `# HELP cranker_compound_batches_total Total compound_delegation_rewards batches submitted`,
        `# TYPE cranker_compound_batches_total counter`,
        `cranker_compound_batches_total ${m.compoundBatches}`,
        `# HELP cranker_demand_factor_rolls_total Total update_demand_factor rolls submitted`,
        `# TYPE cranker_demand_factor_rolls_total counter`,
        `cranker_demand_factor_rolls_total ${m.demandFactorRolls}`,
        `# HELP cranker_errors_total Errors by category`,
        `# TYPE cranker_errors_total counter`,
        `cranker_errors_total{type="already_done"} ${m.errorsAlreadyDone}`,
        `cranker_errors_total{type="not_ready"} ${m.errorsNotReady}`,
        `cranker_errors_total{type="real"} ${m.errorsReal}`,
        `# HELP cranker_consecutive_real_errors Consecutive real errors since last success`,
        `# TYPE cranker_consecutive_real_errors gauge`,
        `cranker_consecutive_real_errors ${m.consecutiveRealErrors}`,
        `# HELP cranker_wallet_balance_sol Current wallet SOL balance`,
        `# TYPE cranker_wallet_balance_sol gauge`,
        `cranker_wallet_balance_sol ${m.walletBalanceSol}`,
        `# HELP cranker_wallet_balance_critical 1 if balance below critical threshold`,
        `# TYPE cranker_wallet_balance_critical gauge`,
        `cranker_wallet_balance_critical ${m.walletBalanceCritical ? 1 : 0}`,
        `# HELP cranker_current_epoch Currently-processed epoch index`,
        `# TYPE cranker_current_epoch gauge`,
        `cranker_current_epoch ${m.currentEpoch}`,
        `# HELP cranker_uptime_seconds Cranker uptime`,
        `# TYPE cranker_uptime_seconds gauge`,
        `cranker_uptime_seconds ${m.uptimeSeconds}`,
        `# HELP cranker_last_tick_timestamp_seconds Unix timestamp of last tick`,
        `# TYPE cranker_last_tick_timestamp_seconds gauge`,
        `cranker_last_tick_timestamp_seconds ${m.lastTickTime ? Math.floor(Date.parse(m.lastTickTime) / 1000) : 0}`,
        `# HELP cranker_cleanup_txs_total Total cleanup txs submitted across all cycles`,
        `# TYPE cranker_cleanup_txs_total counter`,
        `cranker_cleanup_txs_total ${m.cleanupTxsTotal}`,
        `# HELP cranker_cleanup_txs_last_cycle Cleanup txs submitted in the most recent cycle`,
        `# TYPE cranker_cleanup_txs_last_cycle gauge`,
        `cranker_cleanup_txs_last_cycle ${m.cleanupTxsLastCycle}`,
        `# HELP cranker_last_cleanup_timestamp_seconds Unix timestamp of last completed cleanup cycle (0 if none yet)`,
        `# TYPE cranker_last_cleanup_timestamp_seconds gauge`,
        `cranker_last_cleanup_timestamp_seconds ${m.lastCleanupTime ? Math.floor(Date.parse(m.lastCleanupTime) / 1000) : 0}`,
        '',
      ].join('\n'));
    } else if (url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Health server port ${cfg.port} already in use — health endpoint disabled`);
    } else {
      console.error('Health server error:', err.message);
    }
    // Non-critical — don't crash the cranker for a health server failure
  });

  server.listen(cfg.port, cfg.host, () => {
    console.log(`Health server listening on ${cfg.host}:${cfg.port}`);
  });

  return server;
}
