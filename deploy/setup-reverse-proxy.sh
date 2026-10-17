#!/usr/bin/env bash
set -Eeuo pipefail

DOMAIN="${1:-collector.taufn.my.id}"
APP_PORT="${APP_PORT:-4180}"
ENV_FILE="/etc/skyterminal-collector.env"
CADDY_FILE="/etc/caddy/Caddyfile"
OVERRIDE_DIR="/etc/systemd/system/skyterminal-collector.service.d"
OVERRIDE_FILE="$OVERRIDE_DIR/security.conf"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/setup-reverse-proxy.sh [domain]" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then apt-get update && apt-get install -y curl; fi
apt-get update
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg openssl
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

if [[ -f "$ENV_FILE" ]] && grep -q '^COLLECTOR_API_TOKEN=' "$ENV_FILE"; then
  TOKEN="$(sed -n 's/^COLLECTOR_API_TOKEN=//p' "$ENV_FILE")"
else
  TOKEN="$(openssl rand -hex 32)"
  install -m 600 /dev/null "$ENV_FILE"
  printf 'COLLECTOR_API_TOKEN=%s\n' "$TOKEN" > "$ENV_FILE"
fi

mkdir -p "$OVERRIDE_DIR"
cat > "$OVERRIDE_FILE" <<UNIT
[Service]
EnvironmentFile=$ENV_FILE
Environment=HOST=127.0.0.1
Environment=PORT=$APP_PORT
UNIT

mkdir -p /etc/caddy
cat > "$CADDY_FILE" <<CADDY
$DOMAIN {
    encode zstd gzip
    header {
        -Server
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy no-referrer
    }
    reverse_proxy 127.0.0.1:$APP_PORT
}
CADDY

if command -v ufw >/dev/null 2>&1; then
  ufw allow 80/tcp >/dev/null || true
  ufw allow 443/tcp >/dev/null || true
fi

systemctl daemon-reload
systemctl enable --now caddy
systemctl restart skyterminal-collector
systemctl reload caddy
sleep 2
curl -fsS "http://127.0.0.1:$APP_PORT/health" >/tmp/skyterminal-collector-health.json
printf 'Collector local health: '
cat /tmp/skyterminal-collector-health.json
printf '\nHTTPS hostname: https://%s\n' "$DOMAIN"
printf 'Token file: %s (mode 600)\n' "$ENV_FILE"
printf 'Next: copy only the token value into Vercel COLLECTOR_API_TOKEN, and set COLLECTOR_URL=https://%s\n' "$DOMAIN"
