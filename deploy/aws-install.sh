#!/usr/bin/env bash
set -Eeuo pipefail

# Install Skyterminal Collector on a fresh Ubuntu/Debian VPS.
# Run as root from the cloned repository:
#   sudo bash deploy/aws-install.sh

APP_DIR="${APP_DIR:-/opt/skyterminal-collector}"
APP_USER="${APP_USER:-skycollector}"
APP_PORT="${APP_PORT:-4180}"
NODE_VERSION="${NODE_VERSION:-26.7.0}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/aws-install.sh" >&2
  exit 1
fi

if [[ ! -f "${REPO_DIR}/package.json" || ! -f "${REPO_DIR}/src/service.js" ]]; then
  echo "Run this script from the cloned skyterminal-collector repository." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl tar sqlite3

ARCH="$(dpkg --print-architecture)"
case "${ARCH}" in
  amd64) NODE_ARCH="x64" ;;
  arm64) NODE_ARCH="arm64" ;;
  *) echo "Unsupported Debian architecture: ${ARCH}" >&2; exit 1 ;;
esac

NODE_ROOT="/opt/node-v${NODE_VERSION}-linux-${NODE_ARCH}"
if [[ ! -x "${NODE_ROOT}/bin/node" ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' EXIT
  curl --fail --location --retry 3 \
    "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
    -o "${tmp}/node.tar.xz"
  mkdir -p /opt
  tar -xJf "${tmp}/node.tar.xz" -C /opt
fi
ln -sfn "${NODE_ROOT}" /opt/node
ln -sfn /opt/node/bin/node /usr/local/bin/node
ln -sfn /opt/node/bin/npm /usr/local/bin/npm

if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --home-dir "${APP_DIR}" --create-home --shell /usr/sbin/nologin "${APP_USER}"
fi

mkdir -p "${APP_DIR}" "${APP_DIR}/data" "${APP_DIR}/run"
rsync_available=0
if command -v rsync >/dev/null 2>&1; then rsync_available=1; fi
if [[ "${rsync_available}" -eq 1 ]]; then
  rsync -a --delete --exclude data --exclude run --exclude node_modules "${REPO_DIR}/" "${APP_DIR}/"
else
  cp -a "${REPO_DIR}/." "${APP_DIR}/"
  rm -rf "${APP_DIR}/data" "${APP_DIR}/run"
  mkdir -p "${APP_DIR}/data" "${APP_DIR}/run"
fi
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
chmod 750 "${APP_DIR}"

cat > /etc/systemd/system/skyterminal-collector.service <<UNIT
[Unit]
Description=Skyterminal public market collector
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=DB_PATH=${APP_DIR}/data/skyterminal.db
Environment=HOST=127.0.0.1
Environment=PORT=${APP_PORT}
ExecStart=/opt/node/bin/node src/service.js
Restart=always
RestartSec=5
TimeoutStopSec=30
KillSignal=SIGTERM
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${APP_DIR}

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now skyterminal-collector.service
sleep 2

if ! systemctl is-active --quiet skyterminal-collector.service; then
  journalctl -u skyterminal-collector.service -n 80 --no-pager >&2 || true
  exit 1
fi

curl --fail --silent --show-error "http://127.0.0.1:${APP_PORT}/health" >/tmp/skyterminal-collector-health.json
printf 'Collector installed and healthy.\n'
printf 'Service: systemctl status skyterminal-collector\n'
printf 'Health:  http://127.0.0.1:%s/health\n' "${APP_PORT}"
cat /tmp/skyterminal-collector-health.json
