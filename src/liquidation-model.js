// Projected liquidation levels — where leveraged positions WOULD be wiped out, which is
// a different question from the liquidations that already happened.
//
// A rise in open interest means positions were opened around that bucket's price. Each
// one carries a liquidation price set by its leverage: a long at P with leverage L is
// liquidated near P*(1-1/L), a short near P*(1+1/L). Those projected levels sit on the
// chart until price actually trades through them, which is what draws the long horizontal
// bands — a band begins when positions build up and ends where price consumes it.
//
// Every number here rests on assumptions that cannot be observed from public data: how
// leverage is distributed, and that OI growth opens near the traded price. `source` on
// each bucket records whether the buildup came from real OI or the weaker volume proxy,
// so a chart can show which parts are which instead of blending them silently.

// Share of new positions assumed at each leverage. Retail crowds into lower leverage, so
// the weight declines; the exact split is an assumption, not a measurement.
export const DEFAULT_TIERS = [
  { leverage: 10, weight: 0.40 },
  { leverage: 25, weight: 0.30 },
  { leverage: 50, weight: 0.20 },
  { leverage: 100, weight: 0.10 },
];

const binOf = (price, bin) => Math.round(price / bin) * bin;

/**
 * @param buckets ordered [{startMs,endMs,high,low,close,vwap,buyVolume,sellVolume,buildup,source}]
 *   buildup is in base currency; source is 'oi' or 'volume'.
 * @returns {{buckets:Array,tiers:Array,priceBin:number}}
 */
export function buildLiquidationLevels(buckets, { priceBin, tiers = DEFAULT_TIERS, maxLevels = 4000 } = {}) {
  if (!(priceBin > 0)) throw new Error('priceBin must be positive');
  const active = new Map(); // binKey|side|leverage -> level
  const out = [];
  let seq = 0;

  for (const b of buckets) {
    const high = Number(b.high), low = Number(b.low);

    // 1. Price trading through a level consumes it: those positions are gone.
    if (Number.isFinite(high) && Number.isFinite(low)) {
      for (const [k, lv] of active) if (lv.price >= low && lv.price <= high) active.delete(k);
    }

    // 2. New positions open around this bucket's traded price.
    const buildup = Number(b.buildup) || 0;
    const ref = Number(b.vwap ?? b.close);
    if (buildup > 0 && ref > 0) {
      const buy = Number(b.buyVolume) || 0, sell = Number(b.sellVolume) || 0;
      // Aggressor imbalance decides how much of the buildup is long vs short; with no
      // flow to go on, split it evenly rather than inventing a bias.
      const longShare = buy + sell > 0 ? buy / (buy + sell) : 0.5;
      const notional = buildup * ref;

      for (const t of tiers) {
        const share = notional * t.weight;
        const drop = 1 / t.leverage;
        for (const [side, portion, price] of [
          ['long', share * longShare, ref * (1 - drop)],
          ['short', share * (1 - longShare), ref * (1 + drop)],
        ]) {
          if (portion <= 0) continue;
          const p = binOf(price, priceBin);
          if (!(p > 0)) continue;
          const key = `${p}|${side}|${t.leverage}`;
          const cur = active.get(key);
          if (cur) cur.notional += portion;
          else active.set(key, { price: p, side, leverage: t.leverage, notional: portion, bornMs: b.startMs, seq: seq++ });
        }
      }
    }

    // Runaway protection: keep the heaviest levels if the map ever grows unbounded.
    if (active.size > maxLevels) {
      const keep = [...active.entries()].sort((x, y) => y[1].notional - x[1].notional).slice(0, maxLevels);
      active.clear();
      for (const [k, v] of keep) active.set(k, v);
    }

    // 3. Snapshot every level still standing, which is what extends a band rightward.
    const byPrice = new Map();
    for (const lv of active.values()) {
      const row = byPrice.get(lv.price) ?? { price: lv.price, long: 0, short: 0, total: 0 };
      row[lv.side] += lv.notional;
      row.total += lv.notional;
      byPrice.set(lv.price, row);
    }
    out.push({
      startMs: b.startMs,
      endMs: b.endMs,
      source: b.source ?? 'volume',
      levels: [...byPrice.values()].sort((x, y) => x.price - y.price),
    });
  }

  return { buckets: out, tiers, priceBin };
}

// The Liquidation Map is the final snapshot of the same model, kept per leverage tier so
// the chart can stack them, and expressed as distance from the mark price.
export function liquidationMapFrom(buckets, { priceBin, tiers = DEFAULT_TIERS, mark } = {}) {
  const model = buildLiquidationLevels(buckets, { priceBin, tiers });
  const last = model.buckets.at(-1);
  if (!last) return { mark, priceBin, levels: [] };
  const levels = last.levels.map((l) => ({
    price: l.price,
    long: l.long,
    short: l.short,
    total: l.total,
    distancePct: mark > 0 ? (l.price / mark - 1) * 100 : null,
  }));
  return { mark, priceBin, tiers, levels };
}
