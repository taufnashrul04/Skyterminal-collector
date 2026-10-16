import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureTrades, sessionStartMs } from './fixtures.js';
import { cvd, footprint, volumeProfile, tpoProfile, findNodes, divergence, aggregateLiquidations } from '../src/analytics.js';

test('CVD deterministic sequence and 30 minute OHLC match fixture A',()=>{const r=cvd(fixtureTrades,{fromMs:sessionStartMs,toMs:Date.parse('2026-01-01T11:30:00Z'),bucketMs:1800000});assert.deepEqual(r.sequence.map(String),['2','1','4','5','3','2','6','8','6']);assert.deepEqual(r.buckets.map(x=>[String(x.buy),String(x.sell),String(x.open),String(x.high),String(x.low),String(x.close)]),[['5','1','0','4','0','4'],['1','2','4','5','3','3'],['4','1','3','6','2','6'],['2','2','6','8','6','6']]);});

test('CVD keeps empty bucket flat and unknown side does not move path',()=>{const trades=[{id:1,tsMs:0,price:1n,qty:2n,quote:2n,side:0},{id:2,tsMs:120000,price:1n,qty:1n,quote:1n,side:1}];const r=cvd(trades,{fromMs:0,toMs:180000,bucketMs:60000});assert.deepEqual(r.buckets.map(x=>[String(x.open),String(x.close),String(x.unknown)]),[['0','0','2'],['0','0','0'],['0','1','0']]);});

test('footprint assigns trades wholly to execution-price bins including boundaries',()=>{const r=footprint(fixtureTrades,{fromMs:sessionStartMs,toMs:sessionStartMs+7200000,timeBucketMs:1800000,priceBin:1n});const level=r.bars[0].levels.find(x=>x.priceLow===102n);assert.deepEqual([level.buy,level.sell,level.total,level.delta],[3n,0n,3n,3n]);});

test('volume profile computes fixture POC contiguous value area and vwap',()=>{const r=volumeProfile(fixtureTrades,{priceBin:1n,valueArea:0.7,smoothPasses:0});assert.equal(r.poc,102n);assert.equal(r.val,102n);assert.equal(r.vah,104n);assert.equal(r.valueAreaVolume,14n);assert.equal(r.totalVolume,18n);assert.equal(r.vwap,'102.33333333');});

test('volume profile returns null levels for no trades and lower tie POC',()=>{assert.equal(volumeProfile([],{priceBin:1n}).poc,null);const t=[{price:100n,qty:2n,quote:200n,side:1},{price:102n,qty:2n,quote:204n,side:-1}];assert.equal(volumeProfile(t,{priceBin:1n}).poc,100n);});

test('TPO fixture counts, POC, initial balance and extreme exclusion',()=>{const r=tpoProfile(fixtureTrades,{sessionStartMs,sessionEndMs:sessionStartMs+86400000,tpoMinutes:30,ibMinutes:60,priceBin:1n,nowMs:sessionStartMs+86400000});assert.deepEqual(r.levels.map(x=>[String(x.price),x.count,x.letters.join('')]),[['100',1,'A'],['101',2,'AB'],['102',4,'ABCD'],['103',3,'BCD'],['104',1,'C']]);assert.equal(r.poc,102n);assert.deepEqual(r.initialBalance,{low:100n,high:103n,range:3n,extensionUp:1n,extensionDown:0n,complete:true});assert.deepEqual(r.singlePrints,[]);});

test('TPO finds internal single print and ignores zero-count gaps',()=>{const t=[{tsMs:0,price:100n},{tsMs:1800000,price:100n},{tsMs:1800001,price:102n},{tsMs:3600000,price:102n}].map((x,i)=>({...x,id:i,qty:1n,quote:x.price,side:1}));const r=tpoProfile(t,{sessionStartMs:0,sessionEndMs:5400000,tpoMinutes:30,ibMinutes:60,priceBin:1n,nowMs:5400000});assert.deepEqual(r.singlePrints,[{priceLow:101n,priceHigh:102n,tpoCount:1,owner:'B'}]);});

test('HVN and LVN prominence match fixture C',()=>{const levels=[10,2,9,1,8].map((v,i)=>({price:BigInt(100+i),total:BigInt(v)}));const r=findNodes(levels,{smoothPasses:0,nodeWindow:2,minProminence:0.15,includeEdges:false});assert.equal(r.hvn[0].price,102n);assert.deepEqual(r.lvn.map(x=>x.price),[101n,103n]);assert.ok(Math.abs(r.lvn[1].prominence-.875)<1e-10);});

test('spot-perp divergence classifies opposed and handles missing data',()=>{const r=divergence({buy:9n,sell:1n,base:10n,quote:1000n},{buy:1n,sell:9n,base:10n,quote:1010n},.15);assert.equal(r.classification,'opposed');assert.equal(r.flowDivergence,'1.60000000');assert.equal(divergence({buy:0n,sell:0n,base:0n,quote:0n},{buy:1n,sell:0n,base:1n,quote:1n}).classification,'insufficient_data');});

test('liquidation aggregation retains gross sides and event kinds',()=>{const x=[{eventKind:'execution',liquidatedSide:'long',qty:5n},{eventKind:'execution',liquidatedSide:'short',qty:3n},{eventKind:'execution',liquidatedSide:'long',qty:2n}];assert.deepEqual(aggregateLiquidations(x),{long:7n,short:3n,unknown:0n,total:10n,netPressure:-4n});});
