import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHyperliquid, normalizeBinance, normalizeBybit, normalizeOkx } from '../src/normalizers.js';
import { setOkxContracts } from '../src/okx-contracts.js';

const recv = 1700000000999000;

test('Hyperliquid trade preserves decimals and maps taker side', () => {
  const [x] = normalizeHyperliquid({ channel:'trades', data:[{coin:'BTC',side:'B',px:'42000.10',sz:'0.002',time:1700000000000,tid:99}] }, recv);
  assert.deepEqual(x, {type:'trade',venue:'hyperliquid',symbol:'BTC',marketKind:'perp',sourceKey:'99',sourceSequence:'99',tsEventUs:1700000000000000,tsRecvUs:recv,side:1,price:'42000.10',qty:'0.002'});
});

test('Binance spot and perp trades map buyer-maker to aggressor side', () => {
  const spot = normalizeBinance({stream:'btcusdt@trade',data:{e:'trade',E:1700000000001,T:1700000000000,s:'BTCUSDT',t:7,p:'100.00',q:'2.5',m:true}}, recv, 'spot')[0];
  const perp = normalizeBinance({stream:'btcusdt@aggTrade',data:{e:'aggTrade',E:1700000000001,T:1700000000000,s:'BTCUSDT',a:8,p:'101',q:'3',m:false}}, recv, 'perp')[0];
  assert.equal(spot.side, -1); assert.equal(perp.side, 1);
  assert.equal(spot.price, '100.00'); assert.equal(perp.sourceKey, '8');
});

test('Binance forceOrder is an order event and side is liquidated position', () => {
  const x = normalizeBinance({stream:'!forceOrder@arr',data:{e:'forceOrder',E:1700000000000,o:{s:'BTCUSDT',S:'SELL',o:'LIMIT',f:'IOC',q:'5',p:'99',ap:'98.5',X:'FILLED',T:1700000000000}}}, recv, 'perp')[0];
  assert.equal(x.type, 'liquidation'); assert.equal(x.eventKind, 'order');
  assert.equal(x.liquidatedSide, 'long'); assert.equal(x.aggressorSide, 0);
  assert.equal(x.priceKind, 'execution'); assert.equal(x.price, '98.5');
});

test('Bybit trades and allLiquidation retain execution versus order caveat', () => {
  const t = normalizeBybit({topic:'publicTrade.BTCUSDT',data:[{T:1700000000000,s:'BTCUSDT',S:'Sell',v:'1.2',p:'100',i:'abc'}]},recv,'linear')[0];
  const l = normalizeBybit({topic:'allLiquidation.BTCUSDT',data:[{T:1700000000000,s:'BTCUSDT',S:'Buy',v:'2',p:'101'}]},recv,'linear')[0];
  assert.equal(t.side,-1); assert.equal(l.eventKind,'order'); assert.equal(l.liquidatedSide,'short'); assert.equal(l.priceKind,'bankruptcy');
});

test('OKX trades-all and liquidation summary preserve semantics', () => {
  setOkxContracts([['BTC-USDT-SWAP',{ctVal:0.01,ctMult:1,inverse:false}]]);
  const t = normalizeOkx({arg:{channel:'trades-all',instId:'BTC-USDT-SWAP'},data:[{instId:'BTC-USDT-SWAP',tradeId:'55',px:'102',sz:'4',side:'buy',ts:'1700000000000'}]},recv)[0];
  const l = normalizeOkx({arg:{channel:'liquidation-orders'},data:[{instId:'BTC-USDT-SWAP',details:[{side:'sell',bkPx:'90',sz:'3',ts:'1700000000000'}]}]},recv)[0];
  assert.equal(t.marketKind,'perp'); assert.equal(t.side,1); assert.equal(Number(t.qty),0.04,'4 contracts at 0.01 BTC each');
  assert.equal(l.eventKind,'summary'); assert.equal(l.liquidatedSide,'long'); assert.equal(l.priceKind,'bankruptcy'); assert.equal(Number(l.qty),0.03);
});

test('OKX swap events are dropped rather than stored in contract units when the spec is missing', () => {
  setOkxContracts([]);
  assert.deepEqual(normalizeOkx({arg:{channel:'trades-all'},data:[{instId:'BTC-USDT-SWAP',tradeId:'1',px:'102',sz:'4',side:'buy',ts:'1700000000000'}]},recv),[]);
  assert.deepEqual(normalizeOkx({arg:{channel:'liquidation-orders'},data:[{instId:'BTC-USDT-SWAP',details:[{side:'sell',bkPx:'90',sz:'3',ts:'1700000000000'}]}]},recv),[]);
  const spot=normalizeOkx({arg:{channel:'trades-all'},data:[{instId:'BTC-USDT',tradeId:'9',px:'102',sz:'0.4',side:'buy',ts:'1700000000000'}]},recv);
  assert.equal(spot.length,1,'spot never depended on contract specs');
});

test('normalizers reject invalid finite decimal values and use unknown side', () => {
  assert.throws(()=>normalizeHyperliquid({channel:'trades',data:[{coin:'BTC',side:'X',px:'NaN',sz:'1',time:1,tid:1}]},recv),/decimal/);
  const x=normalizeHyperliquid({channel:'trades',data:[{coin:'BTC',side:'X',px:'1',sz:'1',time:1,tid:2}]},recv)[0];
  assert.equal(x.side,0);
});
