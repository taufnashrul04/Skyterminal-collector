# Skyterminal remote deployment handoff

This document is for the separate AWS Ubuntu VPS that will run the persistent collector.

## Architecture

```text
Public exchange WebSockets
        |
        v
skyterminal-collector on AWS VPS
  - Node.js 26.7.0
  - SQLite WAL
  - systemd auto-restart
  - local API: 127.0.0.1:4180
        |
        v
HTTPS reverse proxy/auth layer
        |
        v
Skyterminal frontend/API on Vercel
```

The VPS runs the collector only. The frontend remains in the `Skyterminal` repository and continues to run on Vercel.

## Install on a fresh Ubuntu VPS

Run as `ubuntu` with sudo:

```bash
sudo apt-get update
sudo apt-get install -y git
cd /home/ubuntu
git clone https://github.com/taufnashrul04/Skyterminal-collector.git
cd Skyterminal-collector
sudo bash deploy/aws-install.sh
```

The installer:

- installs Node.js 26.7.0,
- creates system user `skycollector`,
- installs `/etc/systemd/system/skyterminal-collector.service`,
- stores SQLite at `/opt/skyterminal-collector/data/skyterminal.db`,
- binds the API to `127.0.0.1:4180`,
- enables restart-on-failure,
- verifies `/health`.

## Verify service

```bash
sudo systemctl status skyterminal-collector --no-pager
curl -fsS http://127.0.0.1:4180/health
sudo journalctl -u skyterminal-collector -n 80 --no-pager
```

Expected service state: `active (running)`.

## API endpoints

Local endpoints:

```text
GET /health
GET /v1/cvd
GET /v1/divergence/spot-perp
GET /v1/footprint
GET /v1/profile/volume
GET /v1/profile/tpo
GET /v1/liquidations
```

Supported assets: `BTC`, `ETH`, `SOL`, `HYPE`.

Do not expose port `4180` directly to the internet. Put an HTTPS reverse proxy and authentication in front of it first.

## Updates

```bash
cd /home/ubuntu/Skyterminal-collector
git pull --ff-only origin main
sudo systemctl restart skyterminal-collector
curl -fsS http://127.0.0.1:4180/health
```

## Operational checks

```bash
sudo systemctl is-active skyterminal-collector
du -sh /opt/skyterminal-collector/data
sudo journalctl -u skyterminal-collector --since '15 minutes ago' --no-pager
```

SQLite raw-trade storage can grow quickly. Keep raw-event retention/rollup enabled before leaving the VPS unattended and monitor disk usage.

## Vercel connection

The Vercel project is `https://skyterminal.vercel.app` and the frontend repository is:

```text
https://github.com/taufnashrul04/Skyterminal
```

`COLLECTOR_URL` must point to the stable HTTPS reverse-proxy URL, never to `127.0.0.1:4180`.

Example shape only:

```text
COLLECTOR_URL=https://collector.example.com
```

Do not commit or paste tokens, private keys, passwords, cookies, or `.env` files. Configure secrets in the provider's environment-variable UI.
