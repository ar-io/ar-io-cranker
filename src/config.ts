/**
 * Cranker configuration from environment variables.
 */
export interface CrankerConfig {
  solanaRpcUrl: string;
  solanaKeypairPath: string;
  pollIntervalMs: number;
  batchSize: number;
  enableCloseEpochs: boolean;
  /** Number of epochs behind current to close. Default 7. */
  epochRetention: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** 'json' for production log aggregation, 'text' for local dev. Default 'json'. */
  logFormat: 'json' | 'text';
  healthPort: number;
  /** Health server bind address. Default 127.0.0.1 (loopback only). */
  healthHost: string;
  /** Warn at this SOL balance. Default 0.3. */
  warnBalanceSol: number;
  /** Health endpoint returns 503 below this. Default 0.1. */
  criticalBalanceSol: number;
  /** Refuse to start if balance is below this. Default 0.01. */
  minStartBalanceSol: number;
  /** Graceful shutdown deadline in ms. Default 12000 (12s). */
  shutdownTimeoutMs: number;
  /** Override program IDs for localnet/devnet (default: SDK constants) */
  coreProgramId?: string;
  garProgramId?: string;
  arnsProgramId?: string;
  // --- Permissionless cleanup loop (see state-machine.ts:runCleanup) ---
  /** Master toggle for the cleanup pass. Default true. */
  enableCleanup: boolean;
  /** Minimum interval between cleanup passes (ms). Default 300000 = 5 min. */
  cleanupMinIntervalMs: number;
  /** Batch size for ArNS-record / returned-name pruning. Default 15. */
  cleanupBatchSize: number;
  /** Per-cycle tx cap across all cleanup sub-phases. Default 50. */
  maxCleanupTxsPerCycle: number;
  /** Consecutive failed observations before a gateway is prune-eligible. Default 30. */
  cleanupFailureThreshold: number;
  /**
   * Recent signatures to scan when reclaiming leaked prescribe Address Lookup
   * Tables (Phase 7). The ALT program can't be enumerated via getProgramAccounts,
   * so discovery walks the signer's tx history. Default 200. Set 0 to disable.
   */
  altReclaimScanLimit: number;
}

function envOrDefault(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

function parseFloatEnv(key: string, defaultValue: string): number {
  const raw = envOrDefault(key, defaultValue);
  const val = parseFloat(raw);
  if (isNaN(val)) {
    throw new Error(`Invalid ${key}: must be a number, got "${raw}"`);
  }
  return val;
}

function parseIntEnv(key: string, defaultValue: string, min?: number, max?: number): number {
  const raw = envOrDefault(key, defaultValue);
  const val = parseInt(raw);
  if (isNaN(val)) {
    throw new Error(`Invalid ${key}: must be an integer, got "${raw}"`);
  }
  if (min !== undefined && val < min) {
    throw new Error(`Invalid ${key}: must be >= ${min}, got ${val}`);
  }
  if (max !== undefined && val > max) {
    throw new Error(`Invalid ${key}: must be <= ${max}, got ${val}`);
  }
  return val;
}

export function loadConfig(): CrankerConfig {
  const rpcUrl = process.env['SOLANA_RPC_URL'];
  if (!rpcUrl) {
    throw new Error('SOLANA_RPC_URL is required');
  }
  const keypairPath = process.env['SOLANA_KEYPAIR_PATH'];
  if (!keypairPath) {
    throw new Error('SOLANA_KEYPAIR_PATH is required');
  }

  const logLevel = envOrDefault('LOG_LEVEL', 'info');
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new Error(`Invalid LOG_LEVEL: must be debug, info, warn, or error`);
  }

  const logFormat = envOrDefault('LOG_FORMAT', 'json');
  if (!['json', 'text'].includes(logFormat)) {
    throw new Error(`Invalid LOG_FORMAT: must be json or text`);
  }

  return {
    solanaRpcUrl: rpcUrl,
    solanaKeypairPath: keypairPath,
    pollIntervalMs: parseIntEnv('POLL_INTERVAL_MS', '10000', 1000),
    batchSize: parseIntEnv('BATCH_SIZE', '15', 1),
    enableCloseEpochs: envOrDefault('ENABLE_CLOSE_EPOCHS', 'true') === 'true',
    epochRetention: parseIntEnv('EPOCH_RETENTION', '7', 1),
    logLevel: logLevel as CrankerConfig['logLevel'],
    logFormat: logFormat as CrankerConfig['logFormat'],
    healthPort: parseIntEnv('HEALTH_PORT', '8080', 1, 65535),
    healthHost: envOrDefault('HEALTH_HOST', '127.0.0.1'),
    warnBalanceSol: parseFloatEnv('WARN_BALANCE_SOL', '0.3'),
    criticalBalanceSol: parseFloatEnv('CRITICAL_BALANCE_SOL', '0.1'),
    minStartBalanceSol: parseFloatEnv('MIN_START_BALANCE_SOL', '0.01'),
    shutdownTimeoutMs: parseIntEnv('SHUTDOWN_TIMEOUT_MS', '12000', 1000),
    coreProgramId: process.env['ARIO_CORE_PROGRAM_ID'] || undefined,
    garProgramId: process.env['ARIO_GAR_PROGRAM_ID'] || undefined,
    arnsProgramId: process.env['ARIO_ARNS_PROGRAM_ID'] || undefined,
    enableCleanup: envOrDefault('ENABLE_CLEANUP', 'true') === 'true',
    cleanupMinIntervalMs: parseIntEnv('CLEANUP_MIN_INTERVAL_MS', '300000', 30_000),
    cleanupBatchSize: parseIntEnv('CLEANUP_BATCH_SIZE', '15', 1, 100),
    maxCleanupTxsPerCycle: parseIntEnv('MAX_CLEANUP_TXS_PER_CYCLE', '50', 1, 500),
    cleanupFailureThreshold: parseIntEnv('CLEANUP_FAILURE_THRESHOLD', '30', 1),
    altReclaimScanLimit: parseIntEnv('ALT_RECLAIM_SCAN_LIMIT', '200', 0, 1000),
  };
}
