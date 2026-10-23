// One-off repair for rows written before OKX swap sizes were converted from contracts
// to base currency. Trades are rescaled exactly; liquidations are retired instead,
// because instType=SWAP mixes linear and inverse contracts and `markets.source_symbol`
// collapses both into one row, so there is no way to tell afterwards which rule applied.
//
// Run it with the collector STOPPED and before the new code starts writing: it rescales
// every active OKX perp row, so rows already written in base currency would be scaled a
// second time. A marker in schema_migrations makes a repeat run refuse rather than
// silently halve the data again; --force is there only for a re-run after a restore.
//
// Dry run by default. Pass --apply to write.
import { resolve } from 'node:path';
import { CollectorDb } from './db.js';
import { loadOkxContracts } from './okx-contracts.js';

const ASSETS = ['BTC', 'ETH', 'SOL', 'HYPE'];

// A decimal like "0.01" becomes the exact ratio 1/100 so the rescale stays in integers.
function ratio(ctVal) {
  const [whole, frac = ''] = String(ctVal).split('.');
  return { num: BigInt(whole + frac), den: 10n ** BigInt(frac.length) };
}

export const MIGRATION_VERSION = 2;

export async function migrate({ dbPath, apply = false, force = false, fetchImpl = fetch, log = console.log } = {}) {
  await loadOkxContracts({ fetchImpl });
  const { okxBaseQty } = await import('./okx-contracts.js');

  const db = new CollectorDb(dbPath);
  const rows = (sql, ...a) => { const s = db.db.prepare(sql); s.setReadBigInts(true); return s.all(...a); };

  const scale = new Map();
  for (const code of ASSETS) {
    const one = okxBaseQty(`${code}-USDT-SWAP`, '1', 1);
    if (one == null) throw new Error(`no contract spec for ${code}-USDT-SWAP`);
    scale.set(code, ratio(one.replace(/0+$/, '').replace(/\.$/, '')));
  }

  const [done] = rows('SELECT count(*) n FROM schema_migrations WHERE version=?', MIGRATION_VERSION);
  if (Number(done.n) > 0 && !force) {
    log(`Already applied (schema_migrations ${MIGRATION_VERSION}). Re-running would rescale rows that are already in base currency.`);
    log('Pass --force only if you have restored a pre-migration database.');
    db.close();
    return { applied: false, alreadyApplied: true, trades: 0n, liquidations: 0n };
  }

  const markets = rows(`SELECT m.market_id,a.code asset FROM markets m
    JOIN venues v USING(venue_id) JOIN assets a USING(asset_id)
    WHERE v.code='okx' AND m.market_kind='perp'`);

  log(`OKX perp markets: ${markets.length}`);
  let totalRows = 0n, unsafe = 0n;
  const plan = [];

  for (const m of markets) {
    const { num, den } = scale.get(m.asset);
    const id = m.market_id;
    const [stat] = rows(`SELECT count(*) n,
        sum(CASE WHEN (base_qty_i*${num})%${den}!=0 OR (quote_qty_i*${num})%${den}!=0 THEN 1 ELSE 0 END) lossy,
        sum(CASE WHEN base_qty_i*${num}/${den}<=0 THEN 1 ELSE 0 END) zeroed,
        sum(base_qty_i) before
      FROM trades WHERE market_id=? AND is_active=1`, id);
    if (!stat.n) continue;
    totalRows += stat.n; unsafe += (stat.lossy ?? 0n) + (stat.zeroed ?? 0n);
    plan.push({ id, asset: m.asset, num, den, n: stat.n, lossy: stat.lossy ?? 0n, zeroed: stat.zeroed ?? 0n, before: stat.before ?? 0n });
    log(`  ${m.asset.padEnd(5)} x${num}/${den}  rows=${stat.n}  stored=${(Number(stat.before) / 1e8).toFixed(2)}  ->  ${(Number(stat.before) * Number(num) / Number(den) / 1e8).toFixed(2)}` +
        (stat.lossy || stat.zeroed ? `  UNSAFE lossy=${stat.lossy} zeroed=${stat.zeroed}` : ''));
  }

  const [liq] = rows(`SELECT count(*) n FROM liquidations l JOIN markets m USING(market_id)
    JOIN venues v USING(venue_id) WHERE v.code='okx' AND m.market_kind='perp' AND l.is_active=1`);
  log(`OKX perp liquidations to retire (is_active=0): ${liq.n}`);

  if (unsafe > 0n) throw new Error(`${unsafe} rows would lose precision or round to zero; refusing to migrate`);
  if (!apply) { log(`\nDRY RUN — ${totalRows} trade rows would be rescaled. Re-run with --apply to write.`); db.close(); return { applied: false, trades: totalRows, liquidations: liq.n }; }

  db.atomic(() => {
    for (const p of plan) {
      db.db.prepare(`UPDATE trades SET base_qty_i=base_qty_i*${p.num}/${p.den}, quote_qty_i=quote_qty_i*${p.num}/${p.den}
        WHERE market_id=? AND is_active=1`).run(p.id);
    }
    db.db.prepare(`UPDATE liquidations SET is_active=0 WHERE is_active=1 AND market_id IN (
      SELECT m.market_id FROM markets m JOIN venues v USING(venue_id) WHERE v.code='okx' AND m.market_kind='perp')`).run();
    // Same transaction as the rescale, so the marker cannot outlive a rolled-back write.
    db.db.prepare("INSERT OR REPLACE INTO schema_migrations VALUES(?,datetime('now'))").run(MIGRATION_VERSION);
  });

  log(`\nAPPLIED — rescaled ${totalRows} trade rows, retired ${liq.n} liquidation rows.`);
  db.close();
  return { applied: true, trades: totalRows, liquidations: liq.n };
}

if (process.argv[1]?.endsWith('migrate-okx-contracts.js')) {
  await migrate({
    dbPath: process.env.DB_PATH ?? resolve('data/skyterminal.db'),
    apply: process.argv.includes('--apply'),
    force: process.argv.includes('--force'),
  });
}
