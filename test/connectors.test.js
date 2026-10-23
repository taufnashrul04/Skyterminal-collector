import test from 'node:test';import assert from 'node:assert/strict';import { connectorConfigs, activeConnectorConfigs } from '../src/connectors.js';
test('connector inventory covers required independent public feeds',()=>{const c=connectorConfigs();const names=c.map(x=>x.name);for(const n of ['hyperliquid-perp','binance-spot','binance-perp','bybit-spot','bybit-linear','okx-trades','okx-liquidations','bitget-perp','coinbase-spot','deribit-perp'])assert.ok(names.includes(n),`${n} missing`);assert.equal(new Set(names).size,names.length);for(const x of c){assert.match(x.url,/^wss:\/\//);assert.equal(typeof x.normalize,'function');assert.ok(x.subscribe);}});
test('subscriptions include canonical assets where venue symbols exist',()=>{const configs=connectorConfigs();const text=JSON.stringify(configs.map(x=>({url:x.url,subscribe:x.subscribe?.()})));for(const a of ['BTC','ETH','SOL','HYPE'])assert.match(text,new RegExp(a,'i'));assert.match(text,/forceOrder/);assert.match(text,/allLiquidation/);assert.match(text,/trades-all/);assert.match(text,/liquidation-orders/);assert.match(text,/data-stream\.binance\.vision/);assert.match(text,/btcusdt@trade/);});

test('every feed runs by default so a host with full connectivity needs no config',()=>{assert.deepEqual(activeConnectorConfigs({}).map(x=>x.name),connectorConfigs().map(x=>x.name));});
test('COLLECTOR_SKIP drops only the named feeds',()=>{const names=activeConnectorConfigs({COLLECTOR_SKIP:'binance-perp, bybit-spot,bybit-linear'}).map(x=>x.name);for(const n of ['binance-perp','bybit-spot','bybit-linear'])assert.ok(!names.includes(n),`${n} should be skipped`);assert.equal(names.length,connectorConfigs().length-3);});
test('COLLECTOR_SOURCES allowlist wins over everything else',()=>{assert.deepEqual(activeConnectorConfigs({COLLECTOR_SOURCES:'bybit-linear, binance-perp',COLLECTOR_SKIP:'binance-perp'}).map(x=>x.name).sort(),['binance-perp','bybit-linear']);});

test('bitget perp normalizes base-currency trade sizes',()=>{const c=connectorConfigs().find(x=>x.name==='bitget-perp');const out=c.normalize({arg:{channel:'trade',instId:'HYPEUSDT'},data:[{ts:'1792734077694',price:'78.116',size:'1.7',side:'sell',tradeId:'1497400741011918848'}]},1n);assert.equal(out.length,1);assert.equal(out[0].symbol,'HYPE');assert.equal(out[0].marketKind,'perp');assert.equal(out[0].side,-1);assert.equal(out[0].qty,'1.7');assert.equal(out[0].price,'78.116');});

test('coinbase inverts maker side into aggressor side and parses ISO timestamps',()=>{const c=connectorConfigs().find(x=>x.name==='coinbase-spot');const base={type:'match',trade_id:1109669356,size:'0.5',price:'81758.05',product_id:'BTC-USD',sequence:138191929698,time:'2026-10-23T05:50:55.934Z'};
 const makerSell=c.normalize({...base,side:'sell'},1n)[0];
 const makerBuy=c.normalize({...base,side:'buy'},1n)[0];
 assert.equal(makerSell.side,1,'maker selling means the taker bought');
 assert.equal(makerBuy.side,-1,'maker buying means the taker sold');
 assert.equal(makerSell.symbol,'BTC');assert.equal(makerSell.marketKind,'spot');assert.equal(makerSell.qty,'0.5');
 assert.equal(makerSell.tsEventUs,Date.parse(base.time)*1000);
 assert.deepEqual(c.normalize({type:'heartbeat'},1n),[]);});

test('deribit converts inverse USD notional to base but leaves linear amounts alone',()=>{const c=connectorConfigs().find(x=>x.name==='deribit-perp');
 const inverse=c.normalize({params:{data:[{timestamp:1792733970080,price:81690.5,direction:'sell',instrument_name:'BTC-PERPETUAL',trade_seq:308822668,amount:1.5e4,trade_id:'455374083'}]}},1n);
 assert.equal(inverse.length,1);assert.equal(inverse[0].symbol,'BTC');assert.equal(inverse[0].side,-1);
 assert.ok(Math.abs(Number(inverse[0].qty)-15000/81690.5)<1e-8,`expected USD notional converted to base, got ${inverse[0].qty}`);
 const linear=c.normalize({params:{data:[{timestamp:1792734620506,price:104.469,direction:'buy',instrument_name:'SOL_USDC-PERPETUAL',trade_seq:16452289,amount:13.572,trade_id:'USDC-86639176'}]}},1n);
 assert.equal(linear[0].symbol,'SOL');assert.equal(linear[0].side,1);
 assert.equal(Number(linear[0].qty),13.572,'linear amounts are already base currency');
 assert.deepEqual(c.normalize({params:{data:[{instrument_name:'DOGE_USDC-PERPETUAL',price:1,direction:'buy',amount:1,timestamp:1,trade_id:'x',trade_seq:1}]}},1n),[],'unsupported assets are dropped');});
