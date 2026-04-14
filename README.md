# AR.IO Epoch Cranker

Standalone bot that drives the AR.IO Network's permissionless epoch lifecycle on Solana.

Each epoch goes through six steps:

```
create_epoch → tally_weights → prescribe_epoch → [observe] → distribute_epoch → close_epoch
```

The cranker polls on-chain state and submits whichever step is due. All instructions are permissionless and idempotent — multiple crankers can run concurrently without conflict.

## Quick start

### Docker

```bash
docker run -d \
  --name ar-io-cranker \
  --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v /path/to/cranker-keypair.json:/keys/cranker.json:ro \
  -e SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
  -e SOLANA_KEYPAIR_PATH=/keys/cranker.json \
  ghcr.io/ar-io/ar-io-cranker:latest
```

### Node

```bash
yarn install   # requires GitHub Packages auth — see below
yarn build
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
SOLANA_KEYPAIR_PATH=/path/to/cranker-keypair.json \
yarn start
```

## Configuration

All settings are environment variables. Defaults match production-mainnet usage.

| Variable | Default | Notes |
|---|---|---|
| **`SOLANA_RPC_URL`** | *(required)* | Solana JSON-RPC endpoint |
| **`SOLANA_KEYPAIR_PATH`** | *(required)* | Path to signer keypair JSON |
| `POLL_INTERVAL_MS` | `10000` | Tick interval (min 1000) |
| `BATCH_SIZE` | `15` | Tally/distribute batch size |
| `ENABLE_CLOSE_EPOCHS` | `true` | Close old epochs |
| `EPOCH_RETENTION` | `7` | Epochs to keep before closing |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `LOG_FORMAT` | `json` | `json` (production) / `text` (dev) |
| `HEALTH_PORT` | `8080` | Health/metrics HTTP port |
| `HEALTH_HOST` | `127.0.0.1` | Bind address (loopback by default) |
| `WARN_BALANCE_SOL` | `0.3` | Log warn below this |
| `CRITICAL_BALANCE_SOL` | `0.1` | Health endpoint returns 503 below this |
| `MIN_START_BALANCE_SOL` | `0.01` | Refuse to start below this |
| `SHUTDOWN_TIMEOUT_MS` | `12000` | Graceful shutdown deadline |
| `ARIO_*_PROGRAM_ID` | *(SDK constants)* | Override for localnet/devnet |

See [`.env.example`](./.env.example) for a copy-paste template.

## Endpoints

The cranker exposes a small HTTP server (default `127.0.0.1:8080`):

- `GET /health` — JSON operational state. Returns **200** when healthy, **503** when:
  - No tick recorded in `3 × pollIntervalMs`
  - Wallet balance below `CRITICAL_BALANCE_SOL`
  - 10+ consecutive real errors
- `GET /metrics` — Prometheus exposition. Counters for each pipeline step, error categories, wallet balance gauge.
- `GET /` — Plain `ok` (basic liveness, never 503).

Use `/health` for Kubernetes readiness probes and `/metrics` for Prometheus scraping.

## Wallet funding

The cranker burns a small amount of SOL on every transaction (~0.01 SOL/day at default settings).

| Threshold | Default | Action |
|---|---|---|
| Warn | 0.3 SOL | `level=warn` log line each balance check |
| Critical | 0.1 SOL | `level=error` log + `/health` returns 503 |
| Refuse start | 0.01 SOL | Cranker exits with code 3 |

Recommended: alert on the `cranker_wallet_balance_sol` Prometheus gauge dropping below your warn threshold, then top up from a treasury wallet.

## Two ways to run a cranker

The AR.IO observer (`ar-io-observer`) ships with a built-in cranker that gateway operators can enable with `ENABLE_EPOCH_CRANKING=true` — same algorithm, reuses the observer's keypair and connection. Both modes can run concurrently (idempotent by design); the first cranker to land each transaction wins, others get an `already_done` debug log.

Pick the standalone (this repo) when:
- You're not running an observer (e.g., dedicated cranker host, foundation infrastructure)
- You want separate logs / metrics / restart policy from the observer
- You want a dedicated funded wallet for cranking

Pick the observer-embedded version when:
- You already run an observer and want to contribute to keeping the network alive without managing a second service

## CLI flags

```
ar-io-cranker [--help|-h] [--version|-v]
```

Daemon-only — no other subcommands.

## Build from source

```bash
yarn install
yarn build         # outputs to dist/
yarn start         # node dist/index.js
yarn dev           # tsx src/index.ts (no build needed)
yarn typecheck     # tsc --noEmit
```

### Authenticating with GitHub Packages

This repo depends on `@ar-io/sdk` from GitHub Packages. To install:

1. Create a GitHub Personal Access Token (PAT) with `read:packages` scope.
2. Export it as `NODE_AUTH_TOKEN`:
   ```bash
   export NODE_AUTH_TOKEN=<your-pat>
   ```
3. Run `yarn install`.

The included `.npmrc` references `${NODE_AUTH_TOKEN}` so no token lands in the repo.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
