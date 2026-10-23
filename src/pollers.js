// Open interest is a snapshot, not a stream, so it is polled over REST rather than
// subscribed to. It is what the liquidation-level model is built from: a rise in OI
// between two samples means positions were opened, and those positions carry liquidation
// prices that depend on the leverage behind them.

const ASSETS = ['BTC', 'ETH', 'SOL', 'HYPE'];

// Venues report open interest with more precision than the store's 8-decimal scale
// (OKX returns values like 31349.5305000001251), so trim before handing it over.
// A non-positive sample carries nothing for the model, so it is dropped rather than
// forced through a scale conversion that rejects zero.
const toScale8 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n.toFixed(8) : null;
};

// Hyperliquid returns every asset's context in one call, open interest already in base
// currency, so a single request covers the whole universe.
async function hyperliquidOi(fetchImpl) {
  const res = await fetchImpl('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
  });
  if (!res.ok) throw new Error(`hyperliquid HTTP ${res.status}`);
  const [meta, ctxs] = await res.json();
  const out = [];
  for (const code of ASSETS) {
    const i = meta?.universe?.findIndex((u) => u.name === code);
    const oi = i >= 0 ? ctxs?.[i]?.openInterest : null;
    if (oi != null) out.push({ venue: 'hyperliquid', symbol: code, oi });
  }
  return out;
}

// OKX exposes oiCcy already converted to base currency, so the contract multiplier that
// trades need does not apply here.
async function okxOi(fetchImpl) {
  const res = await fetchImpl('https://www.okx.com/api/v5/public/open-interest?instType=SWAP');
  if (!res.ok) throw new Error(`okx HTTP ${res.status}`);
  const body = await res.json();
  if (body?.code !== '0') throw new Error(`okx open-interest: ${body?.msg ?? body?.code}`);
  const want = new Map(ASSETS.map((c) => [`${c}-USDT-SWAP`, c]));
  const out = [];
  for (const row of body.data ?? []) {
    const code = want.get(row.instId);
    if (code && row.oiCcy != null) out.push({ venue: 'okx', symbol: code, oi: row.oiCcy });
  }
  return out;
}

export function pollerConfigs() {
  return [
    { name: 'hyperliquid-oi', intervalMs: 30_000, fetchOi: hyperliquidOi },
    { name: 'okx-oi', intervalMs: 30_000, fetchOi: okxOi },
  ];
}

export class OpenInterestPoller {
  constructor({ name, intervalMs = 30_000, fetchOi, db, fetchImpl = fetch }) {
    Object.assign(this, { name, intervalMs, fetchOi, db, fetchImpl });
    this.stopped = true;
    this.sampleCount = 0;
    this.lastError = null;
  }

  async tick() {
    if (this.stopped) return 0;
    try {
      const rows = await this.fetchOi(this.fetchImpl);
      // stop() can land while the request is still in flight; writing after that would
      // hit a closed database.
      if (this.stopped) return 0;
      // One timestamp for the whole sample so every venue lines up on the same grid.
      const tsUs = Date.now() * 1000;
      const samples = [];
      for (const r of rows) {
        const oi = toScale8(r.oi);
        if (oi) samples.push({ ...r, oi, tsUs });
      }
      const written = samples.length ? this.db.insertOpenInterest(samples) : 0;
      this.sampleCount += written;
      this.lastError = null;
      this.db.setHealth(this.name, samples.length ? 'connected' : 'degraded', samples.length ? null : 'no usable open interest rows', tsUs, this.sampleCount, 0);
      return written;
    } catch (error) {
      if (this.stopped) return 0;
      this.lastError = String(error?.message ?? error);
      this.db.setHealth(this.name, 'degraded', this.lastError, null, this.sampleCount, 0);
      return 0;
    }
  }

  start() {
    this.stopped = false;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.db.setHealth(this.name, 'stopped', null, null, this.sampleCount, 0);
  }
}
