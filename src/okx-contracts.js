// OKX reports swap sizes in CONTRACTS, not base currency, and the contract value differs
// per instrument (BTC-USDT-SWAP is 0.01 BTC, ETH-USDT-SWAP 0.1 ETH, SOL-USDT-SWAP 1 SOL).
// Storing `sz` directly made OKX perp volume wrong by up to 100x against every other venue.
// Inverse swaps such as BTC-USD-SWAP are quoted in USD per contract and need the trade
// price to reach base currency at all.
//
// Confirmed against OKX's own ticker: volCcy24h / vol24h equals ctVal exactly.

const SPECS = new Map();
const warned = new Set();

export function setOkxContracts(entries) {
  SPECS.clear();
  for (const [instId, spec] of entries) SPECS.set(instId, spec);
  warned.clear();
  return SPECS.size;
}

export async function loadOkxContracts({ fetchImpl = fetch, baseUrl = 'https://www.okx.com', instType = 'SWAP' } = {}) {
  const res = await fetchImpl(`${baseUrl}/api/v5/public/instruments?instType=${instType}`);
  if (!res.ok) throw new Error(`OKX instruments HTTP ${res.status}`);
  const body = await res.json();
  if (body?.code !== '0') throw new Error(`OKX instruments: ${body?.msg ?? body?.code}`);
  const entries = [];
  for (const i of body.data ?? []) {
    const ctVal = Number(i.ctVal), ctMult = Number(i.ctMult || 1);
    if (!(ctVal > 0) || !(ctMult > 0)) continue;
    entries.push([i.instId, { ctVal, ctMult, inverse: i.ctValCcy === 'USD' }]);
  }
  return setOkxContracts(entries);
}

export const okxContractCount = () => SPECS.size;

// Contracts -> base currency, as a decimal string. Returns null when the instrument is
// unknown or the result underflows, so the caller drops the event instead of writing a
// quantity in the wrong unit — a visible gap beats silent corruption.
export function okxBaseQty(instId, sz, price) {
  if (!String(instId).endsWith('-SWAP')) return String(sz);
  const spec = SPECS.get(instId);
  if (!spec) {
    if (!warned.has(instId)) {
      warned.add(instId);
      console.error(`[okx] no contract spec for ${instId}; dropping its events`);
    }
    return null;
  }
  const contracts = Number(sz);
  const px = Number(price);
  if (!(contracts > 0)) return null;
  const units = contracts * spec.ctVal * spec.ctMult;
  const base = spec.inverse ? (px > 0 ? units / px : NaN) : units;
  if (!(base > 0)) return null;
  const out = base.toFixed(8);
  return Number(out) > 0 ? out : null;
}
