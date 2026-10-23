# Collector deploy runbook

For the deploy that takes production to `861b3db` or later. Written for whoever has SSH
on the VPS.

This release changes stored data, not just code. Read
[Step 3](#step-3--migrate-the-okx-contract-sizes) before starting: the migration cannot
safely be re-run, and it must happen while the service is stopped.

## The two directories

This trips people up, and it is why production drifted:

| | |
|---|---|
| **Git checkout** | `/home/ubuntu/Skyterminal-collector` — where you pull |
| **Installed copy** | `/opt/skyterminal-collector` — what systemd actually runs |

`aws-install.sh` rsyncs the checkout into `/opt`. **A `git pull` alone changes nothing**,
because systemd's `WorkingDirectory` is `/opt`. The rsync step is what deploys.

The Updates section of `REMOTE-HANDOFF.md` omitted that step, which is the most likely
reason the running collector sat at pre-`6142f63` code.

### `/opt` reporting a stale commit is expected

The sync excludes `.git`, so `/opt/.git` is frozen at whichever commit was installed
first — `08022aa` — while the files have moved on. Git there diffs newer files against a
stale index and calls them "modified". They are not hand edits.

That was checked for this deploy: the six files reported as modified
(`README.md`, `src/server.js`, `src/service.js`, `test/server.test.js`,
`deploy/REMOTE-HANDOFF.md`, `deploy/setup-reverse-proxy.sh`) are exactly the files changed
between `08022aa` and `6142f63`. Nothing was unaccounted for, so there is nothing in
`/opt` to preserve.

Confirm it still holds before relying on it:

```bash
cd /opt/skyterminal-collector
git status --porcelain
git stash list
```

If a file appears that is **not** in that list of six, stop and capture it first:

```bash
git diff 08022aa > ~/opt-unexpected-$(date +%F).patch
```

## What is in this release

| | |
|---|---|
| New venues | Bitget, Coinbase, Deribit |
| New routes | `/v1/liquidations/levels`, `/v1/liquidations/map` |
| New table | `open_interest`, created automatically on start |
| New pollers | `hyperliquid-oi`, `okx-oi` — REST, every 30s |
| Data repair | OKX perp sizes converted from contracts to base currency |

The frontend half is already live on Vercel (`Skyterminal` at `77bac13`), including
`api/liquidation-levels.js`. It answers `available: false` today because the collector it
proxies does not serve those routes yet. This deploy is what makes the projected heatmap
work.

## Step 0 — set the paths

```bash
CHECKOUT=/home/ubuntu/Skyterminal-collector
APP=/opt/skyterminal-collector
DB="$APP/data/skyterminal.db"

[ -d "$CHECKOUT/.git" ] && git -C "$CHECKOUT" rev-parse --short HEAD
sudo systemctl show skyterminal-collector -p WorkingDirectory --value   # expect $APP
```

If `WorkingDirectory` is not `/opt/skyterminal-collector`, stop and re-read the unit
before going further — the rest of this assumes it.

## Step 1 — stop the service and back up the database

The migration rewrites hundreds of thousands of rows in one transaction. A writing
collector would contend for the same lock.

```bash
sudo systemctl stop skyterminal-collector
sudo systemctl is-active skyterminal-collector   # expect: inactive

sudo cp "$DB" ~/skyterminal-$(date +%F).db
ls -lh ~/skyterminal-$(date +%F).db
```

Do not skip the backup. The migration is the only step that redeploying cannot undo.

## Step 2 — pull, then sync into the installed copy

```bash
cd "$CHECKOUT"
git fetch origin main
git pull --ff-only origin main
git log -1 --oneline                   # expect 861b3db or later

sudo rsync -a --delete --exclude='.git' --exclude='data' --exclude='run' ./ "$APP/"
sudo chown -R skycollector:skycollector "$APP"
```

Those rsync flags match `setup-reverse-proxy.sh`. `--delete` is what removes files the
release drops; `data` and `run` are excluded so the database survives.

Confirm the new code actually arrived:

```bash
ls "$APP/src/"   # expect pollers.js, liquidation-model.js, okx-contracts.js, migrate-okx-contracts.js
```

If those are missing, the sync did not happen and everything after this is pointless.

## Step 3 — migrate the OKX contract sizes

OKX reports swap sizes in contracts: `BTC-USDT-SWAP` is 0.01 BTC, `ETH-USDT-SWAP` 0.1 ETH,
`SOL-USDT-SWAP` 1 SOL. Older rows stored the raw figure, so OKX perp volume reads up to
100x too large against every other venue.

**Ordering is load-bearing.** The script cannot tell a row in contracts from one already
converted, so it runs with the service stopped and before the new code writes anything.
Let the new collector run first and its correct rows get rescaled too.

Dry run:

```bash
cd "$APP"
sudo -u skycollector DB_PATH="$DB" /opt/node/bin/node src/migrate-okx-contracts.js
```

It prints per-asset row counts and before/after totals, and writes nothing. It aborts
rather than proceeding if any row would lose precision or round to zero. Check the
arithmetic — BTC divided by 100, ETH and HYPE by 10, SOL unchanged — then apply:

```bash
sudo -u skycollector DB_PATH="$DB" /opt/node/bin/node src/migrate-okx-contracts.js --apply
```

Expected tail: `APPLIED — rescaled N trade rows, retired M liquidation rows.`

Liquidations are retired (`is_active=0`) rather than rescaled. `instType=SWAP` mixes
linear and inverse contracts and `markets.source_symbol` collapses both into one row, so
which rule applied is no longer recoverable. They are hidden, not deleted.

A second run refuses by design. `Already applied (schema_migrations 2)` is the correct
outcome — do not reach for `--force`, which exists only for a database restored from
before the migration.

## Step 4 — start and verify

```bash
sudo systemctl start skyterminal-collector
sudo systemctl status skyterminal-collector --no-pager
sudo journalctl -u skyterminal-collector -n 40 --no-pager
```

Two lines matter in the log:

```
[okx] loaded 522 swap contract specs
{"status":"started","sources":[...],"pollers":["hyperliquid-oi","okx-oi"]}
```

Without the first, OKX swap events are dropped rather than stored in the wrong unit, so
OKX will look silent. Without `pollers`, the old code is still running — go back to
Step 2.

Every route sits behind auth, so an unauthenticated call returns 401 whether or not the
route exists. The token lives in the environment file:

```bash
TOKEN="$(sudo sed -n 's/^COLLECTOR_API_TOKEN=//p' /etc/skyterminal-collector.env)"
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4180/health | head -c 500
```

Expect every source `connected`, with `hyperliquid-oi` and `okx-oi` present. Leave
`COLLECTOR_SKIP` unset on this host: all eight feeds should run, Binance perp and Bybit
included — those are only unreachable from the developer's machine.

Then the route this deploy exists for:

```bash
FROM=$(( ($(date +%s) - 86400) * 1000 )); TO=$(( $(date +%s) * 1000 ))
time curl -fsS -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:4180/v1/liquidations/levels?asset=BTC&from=$FROM&to=$TO&timeBucket=30m&priceBin=50" \
  | head -c 300
```

It should return in about a second. If it hangs, the sync did not take: the pre-`e89cac2`
version scanned every trade once per bucket and took long enough to exceed the client's
12s timeout.

Confirm the rescale landed by comparing OKX against another venue over the same window:

```bash
sudo -u skycollector sqlite3 "$DB" "
SELECT v.code, round(sum(t.base_qty_i)/1e8, 2)
FROM trades t JOIN markets m USING(market_id)
  JOIN venues v USING(venue_id) JOIN assets a USING(asset_id)
WHERE m.market_kind='perp' AND a.code='BTC' AND t.is_active=1
  AND t.ts_event_us > (strftime('%s','now')-3600)*1000000
GROUP BY 1;"
```

OKX should sit in the same order of magnitude as Hyperliquid and Bitget. An OKX figure
~100x the others means the migration did not run.

## Step 5 — check the site

Open <https://www.bothmarket.live>, go to **LIQUIDATIONS**. The default view is
**LIQ HEATMAP**.

- It should draw horizontal bands rather than
  `BUILDING LIQUIDATION MODEL — NEEDS OPEN-INTEREST HISTORY`.
- The header reads `MODELLED · N/48 buckets from open interest, rest volume proxy`.
  `N` starts at 0 and climbs. That is expected: open interest is only collected from this
  deploy onward, and the volume proxy stands in meanwhile.
- **LIQ MAP** should show red bars below the mark and teal above.

Still landing on ACTUAL EVENTS means the page fell back because
`/api/liquidation-levels` returned `available: false`. Read the reason:

```bash
curl -s "https://www.bothmarket.live/api/liquidation-levels?asset=BTC&window=24h" | head -c 300
```

Vercel serves `app.js` with a four-hour TTL, so purge the Cloudflare cache if the browser
is clearly running older code.

## Rollback

Code only:

```bash
cd "$CHECKOUT" && git checkout 6142f63
sudo rsync -a --delete --exclude='.git' --exclude='data' --exclude='run' ./ "$APP/"
sudo chown -R skycollector:skycollector "$APP"
sudo systemctl restart skyterminal-collector
```

Data as well — only if the migration produced something wrong:

```bash
sudo systemctl stop skyterminal-collector
sudo cp ~/skyterminal-$(date +%F).db "$DB"
sudo rm -f "$DB-wal" "$DB-shm"
sudo chown skycollector:skycollector "$DB"
sudo systemctl start skyterminal-collector
```

The restored database predates the migration, carries no marker, and the script will run
again normally.

## After the deploy

- **Watch disk.** `open_interest` adds two rows per asset every 30 seconds, small beside
  raw trades, but trade storage grows quickly: `du -sh /opt/skyterminal-collector/data`
- **Leave it a day.** The projected model reads real open interest only once there is
  history to compare against. Before that it runs on the volume proxy, which counts
  positions being closed as well as opened and so overstates buildup. The chart header
  says which it is using.
