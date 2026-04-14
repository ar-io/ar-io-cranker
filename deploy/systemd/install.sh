#!/usr/bin/env bash
# AR.IO Cranker — systemd install helper.
#
# Run as root on the target host AFTER cloning + building the cranker:
#   git clone https://github.com/ar-io/ar-io-cranker /opt/ar-io-cranker
#   cd /opt/ar-io-cranker && yarn install --production && yarn build
#   sudo bash deploy/systemd/install.sh
#   sudo systemctl enable --now ar-io-cranker
#
# Then edit /etc/ar-io-cranker/cranker.env with your RPC URL and keypair path,
# place your funded keypair JSON at the configured path with mode 600 owned
# by ar-io-cranker:ar-io-cranker.
set -euo pipefail

if [[ "$EUID" -ne 0 ]]; then
  echo "Must run as root (use sudo)." >&2
  exit 1
fi

# 1. Create system user
if ! id -u ar-io-cranker >/dev/null 2>&1; then
  useradd --system --home /opt/ar-io-cranker --shell /usr/sbin/nologin ar-io-cranker
  echo "Created user ar-io-cranker"
fi

# 2. Create config directory
install -d -m 0750 -o ar-io-cranker -g ar-io-cranker /etc/ar-io-cranker

# 3. Drop a starter env file if missing
if [[ ! -f /etc/ar-io-cranker/cranker.env ]]; then
  cat > /etc/ar-io-cranker/cranker.env <<'EOF'
# AR.IO Cranker environment — see https://github.com/ar-io/ar-io-cranker
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_KEYPAIR_PATH=/etc/ar-io-cranker/cranker-keypair.json
LOG_LEVEL=info
LOG_FORMAT=json
HEALTH_HOST=127.0.0.1
HEALTH_PORT=8080
EOF
  chown ar-io-cranker:ar-io-cranker /etc/ar-io-cranker/cranker.env
  chmod 0640 /etc/ar-io-cranker/cranker.env
  echo "Created /etc/ar-io-cranker/cranker.env (edit before starting)"
fi

# 4. Install systemd unit
install -m 0644 "$(dirname "$0")/ar-io-cranker.service" /etc/systemd/system/ar-io-cranker.service

# 5. Reload systemd
systemctl daemon-reload

cat <<'EOF'
Installed.

Next steps:
  1. Place your funded cranker keypair at /etc/ar-io-cranker/cranker-keypair.json
       chown ar-io-cranker:ar-io-cranker /etc/ar-io-cranker/cranker-keypair.json
       chmod 0400 /etc/ar-io-cranker/cranker-keypair.json
  2. Edit /etc/ar-io-cranker/cranker.env with your RPC URL
  3. Enable + start:
       systemctl enable --now ar-io-cranker
  4. Watch:
       journalctl -u ar-io-cranker -f
EOF
