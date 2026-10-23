import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollectorDb } from '../src/db.js';
import { migrate, MIGRATION_VERSION } from '../src/migrate-okx-contracts.js';

// Contract specs, so the migration never reaches the network in a test.
const specFetch = async () => ({
  ok: true,
  json: async () => ({
    code: '0',
    data: [
      { instId: 'BTC-USDT-SWAP', ctVal: '0.01', ctMult: '1', ctValCcy: 'BTC' },
      { instId: 'ETH-USDT-SWAP', ctVal: '0.1', ctMult: '1', ctValCcy: 'ETH' },
      { instId: 'SOL-USDT-SWAP', ctVal: '1', ctMult: '1', ctValCcy: 'SOL' },
      { instId: 'HYPE-USDT-SWAP', ctVal: '0.1', ctMult: '1', ctValCcy: 'HYPE' },
    ],
  }),
});

// A database holding OKX perp trades written the old way: sizes still in contracts.
function seeded() {
  const dir = mkdtempSync(join(tmpdir(), 'skymig-'));
  const path = join(dir, 'x.db');
  const db = new CollectorDb(path);
  db.insertEvents([
    { type: 'trade', venue: 'okx', symbol: 'BTC', marketKind: 'perp', sourceKey: '1', sourceSequence: null, tsEventUs: 1_000, tsRecvUs: 1_000, side: 1, price: '80000', qty: '500' },
    { type: 'trade', venue: 'okx', symbol: 'ETH', marketKind: 'perp', sourceKey: '2', sourceSequence: null, tsEventUs: 2_000, tsRecvUs: 2_000, side: -1, price: '2400', qty: '300' },
    { type: 'trade', venue: 'okx', symbol: 'SOL', marketKind: 'perp', sourceKey: '3', sourceSequence: null, tsEventUs: 3_000, tsRecvUs: 3_000, side: 1, price: '100', qty: '40' },
    // Another venue, to prove the rescale stays inside OKX perp.
    { type: 'trade', venue: 'hyperliquid', symbol: 'BTC', marketKind: 'perp', sourceKey: '4', sourceSequence: null, tsEventUs: 4_000, tsRecvUs: 4_000, side: 1, price: '80000', qty: '2' },
  ]);
  db.close();
  return { dir, path };
}

const qtyOf = (path, venue, asset) => {
  const db = new CollectorDb(path, { readOnly: true });
  const row = db.db.prepare(`SELECT sum(t.base_qty_i) q FROM trades t
    JOIN markets m USING(market_id) JOIN venues v USING(venue_id) JOIN assets a USING(asset_id)
    WHERE v.code=? AND a.code=? AND t.is_active=1`).get(venue, asset);
  db.close();
  return Number(row.q) / 1e8;
};

test('migration rescales OKX perp trades by contract value and leaves other venues alone', async () => {
  const { dir, path } = seeded();
  try {
    const r = await migrate({ dbPath: path, apply: true, fetchImpl: specFetch, log: () => {} });
    assert.equal(r.applied, true);
    assert.equal(qtyOf(path, 'okx', 'BTC'), 5, '500 contracts at 0.01 BTC');
    assert.equal(qtyOf(path, 'okx', 'ETH'), 30, '300 contracts at 0.1 ETH');
    assert.equal(qtyOf(path, 'okx', 'SOL'), 40, 'ctVal 1 leaves it untouched');
    assert.equal(qtyOf(path, 'hyperliquid', 'BTC'), 2, 'other venues are not contract-denominated');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a second run refuses, because rescaling base-currency rows again would halve them', async () => {
  const { dir, path } = seeded();
  try {
    await migrate({ dbPath: path, apply: true, fetchImpl: specFetch, log: () => {} });
    const after = qtyOf(path, 'okx', 'BTC');

    const again = await migrate({ dbPath: path, apply: true, fetchImpl: specFetch, log: () => {} });
    assert.equal(again.applied, false);
    assert.equal(again.alreadyApplied, true);
    assert.equal(qtyOf(path, 'okx', 'BTC'), after, 'the data is untouched by the refused run');

    const db = new CollectorDb(path, { readOnly: true });
    const marked = db.db.prepare('SELECT count(*) n FROM schema_migrations WHERE version=?').get(MIGRATION_VERSION);
    db.close();
    assert.equal(marked.n, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--force re-runs, for a database restored from before the migration', async () => {
  const { dir, path } = seeded();
  try {
    await migrate({ dbPath: path, apply: true, fetchImpl: specFetch, log: () => {} });
    const forced = await migrate({ dbPath: path, apply: true, force: true, fetchImpl: specFetch, log: () => {} });
    assert.equal(forced.applied, true);
    assert.equal(qtyOf(path, 'okx', 'BTC'), 0.05, 'forcing really does rescale again, which is why it is opt-in');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a dry run writes nothing and leaves no marker', async () => {
  const { dir, path } = seeded();
  try {
    const r = await migrate({ dbPath: path, apply: false, fetchImpl: specFetch, log: () => {} });
    assert.equal(r.applied, false);
    assert.equal(qtyOf(path, 'okx', 'BTC'), 500, 'still in contracts');
    const db = new CollectorDb(path, { readOnly: true });
    const marked = db.db.prepare('SELECT count(*) n FROM schema_migrations WHERE version=?').get(MIGRATION_VERSION);
    db.close();
    assert.equal(marked.n, 0, 'a dry run must not claim the migration happened');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
