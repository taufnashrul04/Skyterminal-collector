import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLiquidationLevels, liquidationMapFrom, DEFAULT_TIERS } from '../src/liquidation-model.js';

// A bucket where nothing trades, used to let the model run on without new buildup.
const quiet = (startMs, price) => ({
  startMs, endMs: startMs + 60_000, high: price, low: price, close: price, vwap: price,
  buyVolume: 0, sellVolume: 0, buildup: 0, source: 'oi',
});

const opening = (startMs, price, buildup, { buy = 1, sell = 1 } = {}) => ({
  startMs, endMs: startMs + 60_000, high: price, low: price, close: price, vwap: price,
  buyVolume: buy, sellVolume: sell, buildup, source: 'oi',
});

test('positions opened project to the liquidation price implied by each leverage tier', () => {
  const r = buildLiquidationLevels([opening(0, 80_000, 10)], { priceBin: 100 });
  const prices = r.buckets[0].levels.map((l) => l.price);
  // 10x sits 10% away, 25x 4%, 50x 2%, 100x 1% — on both sides of the entry.
  for (const expected of [72_000, 76_800, 78_400, 79_200, 80_800, 81_600, 83_200, 88_000]) {
    assert.ok(prices.includes(expected), `expected a level at ${expected}, got ${prices.join(',')}`);
  }
});

test('a level persists across later buckets, which is what draws a band', () => {
  const r = buildLiquidationLevels(
    [opening(0, 80_000, 10), quiet(60_000, 80_000), quiet(120_000, 80_000)],
    { priceBin: 100 });
  const at72k = r.buckets.map((b) => b.levels.find((l) => l.price === 72_000)?.total ?? 0);
  assert.ok(at72k[0] > 0, 'level is created');
  assert.equal(at72k[1], at72k[0], 'and still stands a bucket later');
  assert.equal(at72k[2], at72k[0], 'and the one after that');
});

test('price trading through a level consumes it', () => {
  const touch = { ...quiet(60_000, 72_000), high: 72_100, low: 71_900 };
  const r = buildLiquidationLevels(
    [opening(0, 80_000, 10), touch, quiet(120_000, 72_000)],
    { priceBin: 100 });
  assert.ok(r.buckets[0].levels.some((l) => l.price === 72_000), 'level exists before the touch');
  assert.ok(!r.buckets[1].levels.some((l) => l.price === 72_000), 'the touch removes it');
  assert.ok(!r.buckets[2].levels.some((l) => l.price === 72_000), 'and it does not come back');
});

test('aggressor imbalance decides how much of the buildup is long versus short', () => {
  const buys = buildLiquidationLevels([opening(0, 80_000, 10, { buy: 9, sell: 1 })], { priceBin: 100 });
  const below = buys.buckets[0].levels.filter((l) => l.price < 80_000);
  const above = buys.buckets[0].levels.filter((l) => l.price > 80_000);
  const longSum = below.reduce((a, l) => a + l.long, 0);
  const shortSum = above.reduce((a, l) => a + l.short, 0);
  assert.ok(longSum > shortSum * 5, 'aggressive buying stacks long liquidations below price');

  const even = buildLiquidationLevels([opening(0, 80_000, 10, { buy: 5, sell: 5 })], { priceBin: 100 });
  const l2 = even.buckets[0].levels.reduce((a, l) => a + l.long, 0);
  const s2 = even.buckets[0].levels.reduce((a, l) => a + l.short, 0);
  assert.ok(Math.abs(l2 - s2) < 1e-6, 'balanced flow splits evenly');
});

test('no buildup means no new levels, and tier weights sum the whole notional', () => {
  const r = buildLiquidationLevels([quiet(0, 80_000)], { priceBin: 100 });
  assert.equal(r.buckets[0].levels.length, 0);

  const weight = DEFAULT_TIERS.reduce((a, t) => a + t.weight, 0);
  assert.ok(Math.abs(weight - 1) < 1e-9, 'tier weights must be a full split of the buildup');
  const one = buildLiquidationLevels([opening(0, 80_000, 10)], { priceBin: 100 });
  const total = one.buckets[0].levels.reduce((a, l) => a + l.total, 0);
  assert.ok(Math.abs(total - 10 * 80_000) < 1, 'projected notional equals buildup times price');
});

test('buckets carry the source so a chart can separate real OI from the volume proxy', () => {
  const r = buildLiquidationLevels(
    [{ ...opening(0, 80_000, 10), source: 'volume' }, quiet(60_000, 80_000)],
    { priceBin: 100 });
  assert.equal(r.buckets[0].source, 'volume');
  assert.equal(r.buckets[1].source, 'oi');
});

test('the map is the final snapshot expressed as distance from the mark', () => {
  const m = liquidationMapFrom([opening(0, 80_000, 10), quiet(60_000, 80_000)], { priceBin: 100, mark: 80_000 });
  assert.equal(m.mark, 80_000);
  const ten = m.levels.find((l) => l.price === 72_000);
  assert.ok(ten, 'the 10x long level is present');
  assert.ok(Math.abs(ten.distancePct + 10) < 1e-9, 'and reads as 10% below the mark');
  assert.ok(m.levels.every((l) => l.total > 0));
});

test('priceBin must be positive', () => {
  assert.throws(() => buildLiquidationLevels([], { priceBin: 0 }), /priceBin/);
});
