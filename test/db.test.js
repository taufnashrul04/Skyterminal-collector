import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollectorDb, decimalToScaled } from '../src/db.js';

function fresh(){const dir=mkdtempSync(join(tmpdir(),'skydb-'));return {dir,db:new CollectorDb(join(dir,'x.db'))};}

test('database migrates in WAL mode with required tables and indexes',()=>{const {dir,db}=fresh();try{assert.equal(db.db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');const names=db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name);for(const n of ['assets','venues','markets','trades','liquidations','source_health'])assert.ok(names.includes(n));assert.ok(db.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_trades_market_time_active'").get());}finally{db.close();rmSync(dir,{recursive:true,force:true});}});

test('scaled decimal parser is exact and rejects invalid or excessive precision',()=>{assert.equal(decimalToScaled('42000.10',8),4200010000000n);assert.throws(()=>decimalToScaled('NaN',8),/decimal/);assert.throws(()=>decimalToScaled('1.000000001',8),/precision/);});

test('trade inserts deduplicate source key but retain identical distinct prints',()=>{const {dir,db}=fresh();try{const e={type:'trade',venue:'binance',symbol:'BTC',marketKind:'spot',sourceKey:'1',sourceSequence:'1',tsEventUs:1000,tsRecvUs:1100,side:1,price:'100',qty:'2'};assert.equal(db.insertEvents([e]),1);assert.equal(db.insertEvents([e]),0);assert.equal(db.insertEvents([{...e,sourceKey:'2'}]),1);assert.equal(db.db.prepare('SELECT count(*) n FROM trades').get().n,2);}finally{db.close();rmSync(dir,{recursive:true,force:true});}});

test('unknown side is stored but invalid side and values are rejected',()=>{const {dir,db}=fresh();try{const e={type:'trade',venue:'okx',symbol:'ETH',marketKind:'spot',sourceKey:'x',tsEventUs:1,tsRecvUs:2,side:0,price:'2',qty:'3'};assert.equal(db.insertEvents([e]),1);assert.throws(()=>db.insertEvents([{...e,sourceKey:'y',side:9}]),/side/);assert.throws(()=>db.insertEvents([{...e,sourceKey:'z',price:'Infinity'}]),/decimal/);}finally{db.close();rmSync(dir,{recursive:true,force:true});}});

test('liquidation kinds and source health are persisted independently',()=>{const {dir,db}=fresh();try{const e={type:'liquidation',venue:'bybit',symbol:'SOL',marketKind:'perp',sourceKey:'l',tsEventUs:1,tsRecvUs:2,eventKind:'order',liquidatedSide:'long',aggressorSide:0,priceKind:'bankruptcy',price:'150',qty:'4'};assert.equal(db.insertEvents([e]),1);db.setHealth('bybit-linear','connected',null,10,2);assert.deepEqual(db.health()[0],{source:'bybit-linear',status:'connected',last_error:null,last_event_us:10,event_count:2,reconnect_count:0});}finally{db.close();rmSync(dir,{recursive:true,force:true});}});
