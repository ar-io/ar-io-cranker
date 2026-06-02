/**
 * AR.IO Epoch Cranker — standalone bot.
 *
 * Drives the permissionless 6-step epoch pipeline on Solana:
 * create_epoch → tally_weights → prescribe_epoch → [wait] → distribute_epoch → close_epoch
 *
 * Usage:
 *   SOLANA_RPC_URL=https://api.devnet.solana.com \
 *   SOLANA_KEYPAIR_PATH=~/.config/solana/devnet.json \
 *   node dist/index.js
 *
 * CLI flags:
 *   --help, -h       Show usage and exit
 *   --version, -v    Show version and exit
 */
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
} from '@solana/kit';
import { loadConfig, type CrankerConfig } from './config.js';
import { EpochStateMachine, type CrankerLogger, type EpochSettings } from './state-machine.js';
import { startHealthServer, type CrankerMetrics } from './health.js';

const LAMPORTS_PER_SOL = 1_000_000_000;

const require = createRequire(import.meta.url);

// --- CLI args ---
function parseArgs(argv: string[]): void {
  for (const arg of argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--version' || arg === '-v') {
      try {
        const pkg = require('../package.json');
        console.log(pkg.version);
      } catch {
        console.log('unknown');
      }
      process.exit(0);
    }
  }
}

function printUsage(): void {
  console.log(`AR.IO Epoch Cranker

Usage:
  ar-io-cranker [--help] [--version]

Required env vars:
  SOLANA_RPC_URL              Solana RPC endpoint
  SOLANA_KEYPAIR_PATH         Path to signer keypair JSON

Optional env vars:
  POLL_INTERVAL_MS            Poll interval (default 10000, min 1000)
  BATCH_SIZE                  Tally/distribute batch size (default 15)
  ENABLE_CLOSE_EPOCHS         Close old epochs (default true)
  EPOCH_RETENTION             Epochs to retain before closing (default 7)
  LOG_LEVEL                   debug|info|warn|error (default info)
  LOG_FORMAT                  json|text (default json)
  HEALTH_PORT                 Health/metrics port (default 8080)
  HEALTH_HOST                 Bind address (default 127.0.0.1)
  WARN_BALANCE_SOL            Warn below this (default 0.3)
  CRITICAL_BALANCE_SOL        Health returns 503 below this (default 0.1)
  MIN_START_BALANCE_SOL       Refuse to start below this (default 0.01)
  SHUTDOWN_TIMEOUT_MS         Graceful shutdown deadline (default 12000)
  ARIO_CORE_PROGRAM_ID        Override core program ID (localnet/devnet)
  ARIO_GAR_PROGRAM_ID         Override GAR program ID
  ARIO_ARNS_PROGRAM_ID        Override ArNS program ID

Permissionless cleanup loop (mirrors ar-io-observer's runCleanup):
  ENABLE_CLEANUP              Master toggle (default true)
  CLEANUP_MIN_INTERVAL_MS     Minimum ms between cleanup passes (default 300000 = 5min)
  CLEANUP_BATCH_SIZE          Batch size for ArNS-record / returned-name pruning (default 15)
  MAX_CLEANUP_TXS_PER_CYCLE   Per-cycle tx cap across all cleanup sub-phases (default 50)
  CLEANUP_FAILURE_THRESHOLD   Consecutive failed observations before a gateway becomes prune-eligible (default 30)

Endpoints (health server):
  GET /health                 Operational status (200 ok, 503 unhealthy)
  GET /metrics                Prometheus metrics
  GET /                       Basic liveness
`);
}

// SDK static imports — types come from the installed @ar.io/sdk package.
import {
  SolanaARIOWriteable,
  deserializeEpochSettingsFull,
  getEpochSettingsPDA,
  getArnsRegistryPDA,
} from '@ar.io/sdk';

// --- Logger ---
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function createLogger(level: string, format: 'json' | 'text'): CrankerLogger {
  const minLevel = LOG_LEVELS[level as keyof typeof LOG_LEVELS] ?? 1;
  const log = (lvl: keyof typeof LOG_LEVELS, msg: string, meta?: Record<string, unknown>) => {
    if (LOG_LEVELS[lvl] < minLevel) return;
    if (format === 'json') {
      const line = { ts: new Date().toISOString(), level: lvl, msg, ...(meta ?? {}) };
      process.stdout.write(JSON.stringify(line) + '\n');
    } else {
      const ts = new Date().toISOString();
      const metaStr = meta ? ' ' + JSON.stringify(meta) : '';
      process.stdout.write(`${ts} [${lvl.toUpperCase()}] ${msg}${metaStr}\n`);
    }
  };
  return {
    debug: (msg, meta) => log('debug', msg, meta),
    info: (msg, meta) => log('info', msg, meta),
    warn: (msg, meta) => log('warn', msg, meta),
    error: (msg, meta) => log('error', msg, meta),
  };
}

/**
 * Redact credentials from an RPC URL so they don't leak to logs.
 * Handles both `user:pass@host` basic auth and `?api-key=xxx` / `?auth=xxx`
 * style query params used by Helius, QuickNode, etc.
 */
function redactRpcUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = '<redacted>';
      u.password = '';
    }
    const sensitiveParams = ['api-key', 'apikey', 'api_key', 'auth', 'token', 'access_token', 'key'];
    for (const p of sensitiveParams) {
      if (u.searchParams.has(p)) u.searchParams.set(p, '<redacted>');
    }
    return u.toString();
  } catch {
    return raw.replace(/\/\/[^@]+@/, '//<redacted>@');
  }
}

// --- Main ---
async function main() {
  parseArgs(process.argv);

  // Shared shutdown state — registered early so SIGTERM during startup
  // triggers a clean exit instead of default signal-termination.
  let shuttingDown = false;
  let shutdownImpl: (sig: string) => void = (sig) => {
    // Pre-startup handler: just exit cleanly. State machine not yet running.
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`Received ${sig} during startup — exiting\n`);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdownImpl('SIGTERM'));
  process.on('SIGINT', () => shutdownImpl('SIGINT'));

  let config: CrankerConfig;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`Configuration error: ${err instanceof Error ? err.message : err}`);
    console.error('Run with --help for usage.');
    process.exit(2);
  }

  const log = createLogger(config.logLevel, config.logFormat);

  log.info('AR.IO Epoch Cranker starting', {
    rpcUrl: redactRpcUrl(config.solanaRpcUrl),
    pollIntervalMs: config.pollIntervalMs,
    batchSize: config.batchSize,
    epochRetention: config.epochRetention,
    logFormat: config.logFormat,
  });

  // Load keypair
  let keypairData: number[];
  try {
    keypairData = JSON.parse(fs.readFileSync(config.solanaKeypairPath, 'utf-8'));
  } catch (err) {
    log.error('Failed to read keypair', {
      path: config.solanaKeypairPath,
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(2);
  }
  const signer = await createKeyPairSignerFromBytes(
    Uint8Array.from(keypairData),
  );
  log.info('Wallet loaded', { address: signer.address });

  // Create RPC client (kit replaces web3.js's Connection).
  const rpc = createSolanaRpc(config.solanaRpcUrl);
  // The SDK's `SolanaARIOWriteable` needs an RPC subscriptions client
  // to confirm transactions via `sendAndConfirm`. Derive the websocket
  // URL from the configured HTTPS RPC by swapping the scheme — matches
  // observer/src/system.ts:160.
  const wsUrl = config.solanaRpcUrl.replace(/^http/, 'ws');
  const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);

  // Pre-flight: check wallet balance meets minimum required to start
  try {
    const { value } = await rpc.getBalance(signer.address).send();
    const sol = Number(value) / LAMPORTS_PER_SOL;
    log.info('Wallet balance', { balanceSol: sol.toFixed(4) });
    if (sol < config.minStartBalanceSol) {
      log.error('Wallet balance below MIN_START_BALANCE_SOL — refusing to start', {
        balanceSol: sol.toFixed(4),
        required: config.minStartBalanceSol,
      });
      process.exit(3);
    }
  } catch (err) {
    log.warn('Pre-flight balance check failed — continuing', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Program ID overrides (for localnet/devnet — source from localnet.env)
  const coreProgramId = config.coreProgramId ? address(config.coreProgramId) : undefined;
  const garProgramId = config.garProgramId ? address(config.garProgramId) : undefined;
  const arnsProgramId = config.arnsProgramId ? address(config.arnsProgramId) : undefined;

  if (coreProgramId || garProgramId || arnsProgramId) {
    log.info('Using custom program IDs', {
      core: coreProgramId,
      gar: garProgramId,
      arns: arnsProgramId,
    });
  }

  // Create SDK client (kit-style: pass `rpc` not `connection`).
  // The `as any` cast on `rpc` mirrors ar-io-node's on-demand-arns-resolver:
  // `@ar.io/sdk` and `@solana/kit` each ship their own nested copy of
  // `@solana/rpc-spec`, so the structural types don't unify even though
  // the underlying runtime objects are interchangeable.
  const contract = new SolanaARIOWriteable({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rpc: rpc as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rpcSubscriptions: rpcSubscriptions as any,
    signer,
    coreProgramId,
    garProgramId,
    arnsProgramId,
  });

  // Epoch settings reader
  const readEpochSettings = async (): Promise<EpochSettings> => {
    const [pda] = await getEpochSettingsPDA(garProgramId);
    const accountResp = await rpc
      .getAccountInfo(pda, { commitment: 'confirmed', encoding: 'base64' })
      .send();
    if (!accountResp.value) throw new Error('EpochSettings not found');
    const dataB64 = accountResp.value.data[0]; // [base64, "base64"]
    const data = deserializeEpochSettingsFull(Buffer.from(dataB64, 'base64'));
    return {
      currentEpochIndex: data.currentEpochIndex as number,
      genesisTimestamp: data.genesisTimestamp as number,
      epochDuration: data.epochDuration as number,
      enabled: (data.enabled as boolean) ?? true,
    };
  };

  // Derive NameRegistry PDA for name prescription
  const [nameRegistryPda] = await getArnsRegistryPDA(arnsProgramId);

  // Create state machine
  const startTime = Date.now();
  const stateMachine = new EpochStateMachine({
    contract,
    rpc,
    signer,
    pollIntervalMs: config.pollIntervalMs,
    batchSize: config.batchSize,
    enableCloseEpochs: config.enableCloseEpochs,
    epochRetention: config.epochRetention,
    warnBalanceSol: config.warnBalanceSol,
    criticalBalanceSol: config.criticalBalanceSol,
    log,
    getEpochSettings: readEpochSettings,
    nameRegistryAccount: nameRegistryPda,
    enableCleanup: config.enableCleanup,
    cleanupMinIntervalMs: config.cleanupMinIntervalMs,
    cleanupBatchSize: config.cleanupBatchSize,
    maxCleanupTxsPerCycle: config.maxCleanupTxsPerCycle,
    cleanupFailureThreshold: config.cleanupFailureThreshold,
    altReclaimScanLimit: config.altReclaimScanLimit,
    enableDisabledGatewaySweep: config.enableDisabledGatewaySweep,
  });

  // Start health server — mark unhealthy if tick hasn't run in 3x the poll interval
  const getMetrics = (): CrankerMetrics => {
    const m = stateMachine.getMetrics();
    return {
      ...m,
      uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    };
  };
  const healthServer = startHealthServer({
    port: config.healthPort,
    host: config.healthHost,
    maxTickAgeMs: Math.max(config.pollIntervalMs * 3, 30000),
    maxConsecutiveRealErrors: 10,
    getMetrics,
  });

  // Start cranking
  stateMachine.start();

  // Graceful shutdown — stop cranker, wait for in-flight tick, close health server.
  // We replace the early handler by reassigning shutdownImpl (which the
  // registered listener calls through a closure).
  shutdownImpl = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Shutting down...', { signal });
    stateMachine.stop();
    healthServer.close();

    const metrics = stateMachine.getMetrics();
    if (stateMachine.isBusy()) {
      log.info('Waiting for in-flight tick to complete', {
        phase: metrics.phase,
        currentEpoch: metrics.currentEpoch,
        timeoutMs: config.shutdownTimeoutMs,
      });
    }

    const deadline = setTimeout(() => {
      log.warn('Shutdown timeout exceeded — forcing exit', {
        phase: stateMachine.getMetrics().phase,
      });
      process.exit(1);
    }, config.shutdownTimeoutMs);
    const check = setInterval(() => {
      if (!stateMachine.isBusy()) {
        clearInterval(check);
        clearTimeout(deadline);
        log.info('Clean shutdown complete');
        process.exit(0);
      }
    }, 200);
  };
}

main().catch((err) => {
  // Emit fatal error in same format as main logger so log aggregation picks it up
  const payload = {
    ts: new Date().toISOString(),
    level: 'error',
    msg: 'Fatal error',
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  };
  process.stderr.write(JSON.stringify(payload) + '\n');
  process.exit(1);
});
