import test from 'node:test';import assert from 'node:assert/strict';
import { setOkxContracts, okxBaseQty, loadOkxContracts, okxContractCount } from '../src/okx-contracts.js';
import { normalizeOkx } from '../src/normalizers.js';

const SPECS=[
 ['BTC-USDT-SWAP',{ctVal:0.01,ctMult:1,inverse:false}],
 ['ETH-USDT-SWAP',{ctVal:0.1,ctMult:1,inverse:false}],
 ['SOL-USDT-SWAP',{ctVal:1,ctMult:1,inverse:false}],
 ['BTC-USD-SWAP',{ctVal:100,ctMult:1,inverse:true}],
];

test('linear swap contracts convert to base currency by ctVal',()=>{setOkxContracts(SPECS);
 assert.equal(Number(okxBaseQty('BTC-USDT-SWAP','1',81000)),0.01);
 assert.equal(Number(okxBaseQty('BTC-USDT-SWAP','250',81000)),2.5);
 assert.equal(Number(okxBaseQty('ETH-USDT-SWAP','30',2400)),3);
 assert.equal(Number(okxBaseQty('SOL-USDT-SWAP','7',104)),7,'ctVal 1 leaves the size untouched');});

test('inverse swap contracts are USD per contract so price is required',()=>{setOkxContracts(SPECS);
 assert.ok(Math.abs(Number(okxBaseQty('BTC-USD-SWAP','5',80000))-5*100/80000)<1e-9);
 assert.equal(okxBaseQty('BTC-USD-SWAP','5',0),null,'no usable price means no safe conversion');});

test('spot sizes pass through and unknown swaps are dropped, never mis-scaled',()=>{setOkxContracts(SPECS);
 assert.equal(okxBaseQty('BTC-USDT','0.25',81000),'0.25');
 assert.equal(okxBaseQty('DOGE-USDT-SWAP','10',0.1),null);
 assert.equal(okxBaseQty('BTC-USDT-SWAP','0',81000),null);});

test('normalizeOkx scales swap trades but leaves spot alone',()=>{setOkxContracts(SPECS);
 const swap=normalizeOkx({arg:{channel:'trades-all'},data:[{instId:'BTC-USDT-SWAP',tradeId:'1',seqId:1,ts:'1792734085276',side:'buy',px:'81756.6',sz:'250'}]},1n);
 assert.equal(swap.length,1);assert.equal(swap[0].marketKind,'perp');assert.equal(Number(swap[0].qty),2.5);
 const spot=normalizeOkx({arg:{channel:'trades-all'},data:[{instId:'BTC-USDT',tradeId:'2',seqId:2,ts:'1792734085276',side:'sell',px:'81756.6',sz:'0.25'}]},1n);
 assert.equal(spot[0].marketKind,'spot');assert.equal(Number(spot[0].qty),0.25);});

test('normalizeOkx scales liquidations, including inverse contracts',()=>{setOkxContracts(SPECS);
 const linear=normalizeOkx({arg:{channel:'liquidation-orders'},data:[{instId:'ETH-USDT-SWAP',details:[{side:'sell',sz:'40',bkPx:'2400',ts:'1792734085276'}]}]},1n);
 assert.equal(linear.length,1);assert.equal(Number(linear[0].qty),4);assert.equal(linear[0].liquidatedSide,'long');
 const inverse=normalizeOkx({arg:{channel:'liquidation-orders'},data:[{instId:'BTC-USD-SWAP',details:[{side:'buy',sz:'8',bkPx:'80000',ts:'1792734085276'}]}]},1n);
 assert.ok(Math.abs(Number(inverse[0].qty)-8*100/80000)<1e-9);assert.equal(inverse[0].liquidatedSide,'short');});

test('loadOkxContracts keeps only usable specs and rejects an error envelope',async()=>{
 const ok={ok:true,json:async()=>({code:'0',data:[
  {instId:'BTC-USDT-SWAP',ctVal:'0.01',ctMult:'1',ctValCcy:'BTC'},
  {instId:'BTC-USD-SWAP',ctVal:'100',ctMult:'1',ctValCcy:'USD'},
  {instId:'BROKEN-SWAP',ctVal:'0',ctMult:'1',ctValCcy:'X'}]})};
 assert.equal(await loadOkxContracts({fetchImpl:async()=>ok}),2);
 assert.equal(okxContractCount(),2);
 assert.ok(Math.abs(Number(okxBaseQty('BTC-USD-SWAP','1',50000))-100/50000)<1e-12,'ctValCcy USD marks it inverse');
 await assert.rejects(()=>loadOkxContracts({fetchImpl:async()=>({ok:true,json:async()=>({code:'51000',msg:'bad request'})})}),/bad request/);});
