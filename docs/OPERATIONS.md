# AR.IO Cranker — Operations Guide

Day-to-day operations for running the cranker in production.

## Wallet funding

The cranker burns ~0.01 SOL/day at default settings (1 tx every ~10 seconds × 6 epoch instructions per cycle).

| Threshold | Default | Behavior |
|-----------|---------|----------|
| Warn | 0.3 SOL | `level=warn` log line; alert your on-call channel |
| Critical | 0.1 SOL | `level=error` log + `/health` returns **503** |
| Refuse start | 0.01 SOL | Cranker exits with code 3 |

Recommended: keep ~1 SOL in the cranker wallet (~100 days runway), alert at 0.3 SOL.

### Funding flow

1. Generate a fresh keypair just for the cranker (don't reuse a treasury wallet):
   ```bash
   solana-keygen new --outfile cranker-keypair.json
   ```
2. Send 1 SOL from your treasury to the cranker's pubkey:
   ```bash
   solana address -k cranker-keypair.json
   solana transfer --from treasury.json $(solana address -k cranker-keypair.json) 1
   ```
3. Place the keypair file with mode 0400 wherever the cranker will read it from.

### Refill automation

Two patterns:

**Alert-driven (recommended):** Prometheus alert on `cranker_wallet_balance_sol < 0.3` fires to PagerDuty/Slack; a human tops up from treasury.

```yaml
- alert: CrankerWalletLow
  expr: cranker_wallet_balance_sol < 0.3
  for: 5m
  annotations:
    summary: "Cranker wallet at {{ $value }} SOL"
```

**Auto-refill:** A second tiny service watches the balance and pulls from a hot wallet when below a threshold. Extra moving part; defer unless on-call load justifies it.

## Monitoring

### Prometheus metrics

The cranker exposes `/metrics` in standard Prometheus exposition format:

| Metric | Type | Notes |
|--------|------|-------|
| `cranker_epochs_created_total` | counter | Each new epoch |
| `cranker_tally_batches_total` | counter | Each tally_weights tx |
| `cranker_prescriptions_total` | counter | Each prescribe_epoch tx |
| `cranker_distribution_batches_total` | counter | Each distribute_epoch tx |
| `cranker_epochs_closed_total` | counter | Each close_epoch tx |
| `cranker_errors_total{type=...}` | counter | Categorized errors |
| `cranker_consecutive_real_errors` | gauge | Resets to 0 on success |
| `cranker_wallet_balance_sol` | gauge | Updated on every tick |
| `cranker_wallet_balance_critical` | gauge | 1 when below threshold |
| `cranker_current_epoch` | gauge | Currently-processed epoch |
| `cranker_uptime_seconds` | gauge | |
| `cranker_last_tick_timestamp_seconds` | gauge | For staleness alerts |

### Suggested alerts

```yaml
- alert: CrankerStuck
  expr: time() - cranker_last_tick_timestamp_seconds > 60
  for: 2m
  annotations:
    summary: "Cranker has not ticked in {{ $value }}s"

- alert: CrankerErrorsRising
  expr: rate(cranker_errors_total{type="real"}[5m]) > 0.1
  for: 5m

- alert: CrankerWalletLow
  expr: cranker_wallet_balance_sol < 0.3
  for: 5m

- alert: CrankerWalletCritical
  expr: cranker_wallet_balance_critical == 1
  for: 1m
```

### Health endpoint

`GET /health` returns:
- **200** `{"status":"ok",...}` when healthy
- **503** `{"status":"unhealthy","reason":"...",...}` when:
  - No tick in 3× the poll interval
  - Wallet balance below `CRITICAL_BALANCE_SOL`
  - 10+ consecutive real errors

Use this for Kubernetes readiness probes — a 503 reading drops the pod from any service routing.

## Concurrency

All cranker instructions are permissionless and idempotent. Multiple crankers running concurrently is **safe by design**:

- Whoever lands a transaction first wins
- Others get an `already_done` debug log + counter increment
- No double-spend or state corruption possible

This means:
- Foundation can run a sidecar cranker for liveness
- Gateway operators can run the embedded cranker (`ENABLE_EPOCH_CRANKING=true` in `ar-io-observer`)
- Multiple operators racing each other is fine
- Cost is small wasted SOL on losing tx attempts (~15% in heavily-contested epochs)

## Common operations

### View live logs
```bash
docker logs -f ar-io-cranker          # docker
docker compose logs -f cranker        # compose
journalctl -u ar-io-cranker -f        # systemd
kubectl logs -f deploy/ar-io-cranker  # k8s
```

### Restart cleanly
```bash
docker restart ar-io-cranker
docker compose restart cranker
systemctl restart ar-io-cranker
kubectl rollout restart deploy/ar-io-cranker
```

All of these send SIGTERM and wait up to ~12s for graceful shutdown.

### Stop temporarily
```bash
docker stop ar-io-cranker
systemctl stop ar-io-cranker
kubectl scale deploy/ar-io-cranker --replicas=0
```

The cranker is safe to stop at any time — no in-progress state is lost. Other crankers will pick up where this one left off.

### Rotate the keypair
1. Generate new keypair, fund it from treasury
2. Update the mounted secret/file
3. Restart the cranker
4. Verify the new pubkey appears in `Wallet loaded` log line
5. Sweep any remaining SOL from the old keypair back to treasury

## Troubleshooting

### Cranker stuck at "not_ready" errors
Usually a contract precondition isn't met yet (e.g., epochs disabled, no active gateways). Check the contract state directly:
```bash
solana account $(solana address -k cranker.json) --url $SOLANA_RPC_URL
```

### Real errors climbing
Check the `cranker_errors_total{type="real"}` counter and tail recent logs. Real errors usually mean RPC issues or unexpected on-chain state changes — escalate.

### Wallet drained unexpectedly
Possible causes:
- RPC sending duplicate txs (check `errors_total{type="already_done"}` is high)
- Many other crankers racing on a low-activity epoch
- Poll interval too aggressive (default 10s is fine; don't go below 5s)

### No epochs being created
Verify:
1. `EpochsNotEnabled` (6031) errors → admin needs to call `set_epochs_enabled(true)`
2. `EpochNotStarted` (6032) errors → next epoch's start time hasn't passed
3. Genesis timestamp is correct (epoch 0 won't create until `now >= genesisTimestamp`)
