# Skyterminal Collector

A dependency-free Node.js 26 service that continuously collects public trades and liquidation messages into SQLite and exposes local Phase-4 order-flow analytics.

## Run

```sh
npm test
npm run check
npm start                       # 127.0.0.1:4180, data/skyterminal.db
SMOKE_SECONDS=25 npm run smoke  # bounded public-feed probe
bin/start-detached.sh           # nohup launcher; PID/log under run/
```

Environment: `DB_PATH`, `HOST` (default `127.0.0.1`), `PORT` (default `4180`), `COLLECTOR_API_TOKEN` (optional bearer token), and `SMOKE_SECONDS` (default 25). The systemd template is `ops/skyterminal-collector.service`; it is not installed automatically.

For an HTTPS reverse proxy on a domain that already points to this VPS, run `sudo bash deploy/setup-reverse-proxy.sh collector.example.com`. The script installs Caddy, keeps the collector bound to `127.0.0.1:4180`, enables HTTPS, generates `/etc/skyterminal-collector.env` with mode `600`, and prints the Vercel variables to configure. Do not paste the token into chat.

## Sources

Independent reconnecting WebSocket supervisors cover:

- Hyperliquid perpetual trades
- Binance spot trades; USD-M perpetual aggregate trades and `forceOrder`
- Bybit spot/linear public trades and linear `allLiquidation`
- OKX spot/swap `trades-all` and `liquidation-orders`

Assets are BTC, ETH, SOL, and HYPE where the venue offers the symbol. One blocked or rejected feed is recorded as degraded/backoff and does not stop other feeds. No keys or private channels are used.

## Storage contract

SQLite is opened in WAL mode with strict tables for assets, venues, versioned markets, raw trades, raw liquidations, and per-source health. Timestamps are UTC microseconds. Price/base/quote values are validated decimal strings at adapter boundaries and stored as scale-8 signed 64-bit integers. JSON quantities are decimal strings. Duplicate `(market_id, source_key)` deliveries are ignored; identical prints with distinct source IDs remain distinct. Queries use `[from,to)`.

The MVP uses a common scale of 8 and integer multiplication/division to derive quote quantity. Values that exceed precision or signed 64-bit range are rejected rather than rounded or fabricated. Tick/contract metadata is not yet discovered dynamically: OKX swap `sz` is venue contract size and therefore cross-venue base-volume comparisons involving OKX swaps require contract-multiplier normalization before production use. This limitation is reported here rather than silently represented as exact economic base volume.

Liquidation semantics are explicit:

- Binance `forceOrder`: `order` (average fill price when supplied)
- Bybit `allLiquidation`: `order` at reported bankruptcy price
- OKX `liquidation-orders`: `summary` at bankruptcy price

These are never silently labeled executed liquidation volume. `liquidatedSide` is position side; expected pressure is presentation metadata, not observed aggressor direction.

## API

Every analytics response has `schemaVersion`, `query`, `data`, and `meta`. Required common parameters are `asset`, `from`, and exclusive `to`; timestamps accept epoch milliseconds or ISO-8601.

- `GET /health`
- `GET /v1/cvd?asset=BTC&from=...&to=...&bucket=30m`
- `GET /v1/divergence/spot-perp?...&bucket=30m&threshold=0.15`
- `GET /v1/footprint?...&timeBucket=30m&priceBin=1`
- `GET /v1/profile/volume?...&priceBin=1&valueArea=0.70`
- `GET /v1/profile/tpo?...&priceBin=1&tpoMinutes=30&ibMinutes=60`
- `GET /v1/liquidations?...&bucket=30m&eventKind=execution|order|summary`

`priceBin` is a positive decimal price width. CVD unknown-side volume is reported but does not move delta. Volume profile includes unknown volume. TPO intentionally fills each period high-low range. TPO output includes POC/VAH/VAL, letters/counts, Initial Balance, extensions, internal single prints, and incomplete-session warnings. Volume profile includes contiguous value area plus HVN/LVN nodes.

## Operational notes

SIGTERM/SIGINT stops all sources, flushes pending writes, closes HTTP, checkpoints WAL, optimizes, and closes SQLite. Source health stores status, last error/event, event count, and reconnect count. The API is synchronous and local-only by default; do not expose it publicly without authentication, request limits, and query-cost controls.
