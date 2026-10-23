import test from 'node:test';import assert from 'node:assert/strict';
import { BatchWriter, SourceSupervisor, backoffMs } from '../src/supervisor.js';
import { OpenInterestPoller } from '../src/pollers.js';

test('backoff is exponential and capped',()=>{assert.equal(backoffMs(0,()=>0),500);assert.equal(backoffMs(3,()=>0),4000);assert.equal(backoffMs(99,()=>0),30000);});

test('batch writer flushes a bounded batch and retains remaining events',()=>{const calls=[],db={insertEvents:x=>{calls.push(x);return x.length;}};const w=new BatchWriter(db,{batchSize:2,flushMs:10000});w.add(1);w.add(2);w.add(3);assert.deepEqual(calls,[[1,2]]);assert.equal(w.flush(),1);assert.deepEqual(calls,[[1,2],[3]]);w.close();});

test('source supervisor subscribes, normalizes, updates health and stops cleanly',async()=>{class FakeSocket extends EventTarget{static OPEN=1;readyState=1;sent=[];constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('open')));}send(x){this.sent.push(x);}close(){this.dispatchEvent(new CloseEvent('close',{code:1000}));}}
 const states=[],events=[];const db={setHealth:(...x)=>states.push(x)},writer={add:x=>events.push(x)};const s=new SourceSupervisor({name:'fake',url:'wss://fake',subscribe:()=>({op:'sub'}),normalize:x=>[x],db,writer,WebSocketImpl:FakeSocket,heartbeatMs:10000});s.start();await new Promise(r=>setTimeout(r,5));s.ws.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({x:1})}));await new Promise(r=>setTimeout(r,1));assert.deepEqual(s.ws.sent,['{"op":"sub"}']);assert.deepEqual(events,[{x:1}]);assert.equal(states.at(-1)[1],'connected');s.stop();assert.equal(s.stopped,true);});

test('open source with no events becomes degraded instead of healthy',async()=>{class QuietSocket extends EventTarget{readyState=1;constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('open')));}send(){}close(){}}const states=[];const s=new SourceSupervisor({name:'quiet',url:'wss://quiet',subscribe:()=>[],normalize:()=>[],db:{setHealth:(...x)=>states.push(x)},writer:{add(){}},WebSocketImpl:QuietSocket,heartbeatMs:2,staleMs:3});s.start();await new Promise(r=>setTimeout(r,20));assert.ok(states.some(x=>x[1]==='degraded'&&/no events/.test(x[2])));s.stop();});

test('plain text websocket pong is ignored without degrading source',async()=>{const states=[];const s=new SourceSupervisor({name:'pong',url:'wss://pong',subscribe:()=>[],normalize:()=>[],db:{setHealth:(...x)=>states.push(x)},writer:{add(){}},WebSocketImpl:class extends EventTarget{readyState=1;constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('open')))}send(){}close(){}},heartbeatMs:10000});s.start();await new Promise(r=>setTimeout(r,2));s.ws.dispatchEvent(new MessageEvent('message',{data:'pong'}));await new Promise(r=>setTimeout(r,2));assert.equal(states.at(-1)[1],'connected');s.stop();});

test('late websocket error after stop does not touch a closed database',async()=>{class LateSocket extends EventTarget{readyState=1;constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('open')));}send(){}close(){setTimeout(()=>this.dispatchEvent(new Event('error')),2);}}let closed=false;const db={setHealth:()=>{if(closed)throw new Error('database is not open');}};const s=new SourceSupervisor({name:'late',url:'wss://late',subscribe:()=>[],normalize:()=>[],db,writer:{add(){}},WebSocketImpl:LateSocket});s.start();await new Promise(r=>setTimeout(r,1));s.stop();closed=true;await new Promise(r=>setTimeout(r,5));assert.equal(s.stopped,true);});

test('open interest poller does not write after stop', async () => {
  let release; const inFlight = new Promise((r) => { release = r; });
  let closed = false;
  const db = { insertOpenInterest(){ if(closed) throw new Error('database is not open'); return 1; },
               setHealth(){ if(closed) throw new Error('database is not open'); } };
  const poller = new OpenInterestPoller({ name:'t-oi', intervalMs: 60_000, db,
    fetchOi: async () => { await inFlight; return [{venue:'okx',symbol:'BTC',oi:'1'}]; } });
  poller.stopped = false;
  const tick = poller.tick();
  poller.stopped = true; closed = true;           // service shuts down mid-request
  release();
  assert.equal(await tick, 0, 'a tick that lands after stop must write nothing');
});

test('open interest poller trims venue precision to the storage scale', async () => {
  const written = [];
  const db = { insertOpenInterest(rows){ written.push(...rows); return rows.length; }, setHealth(){} };
  // OKX really does return values like this; the store only holds 8 decimals.
  const poller = new OpenInterestPoller({ name:'t', intervalMs: 60_000, db,
    fetchOi: async () => [{venue:'okx',symbol:'BTC',oi:'31349.5305000001251'},
                          {venue:'okx',symbol:'ETH',oi:'0'}] });
  poller.stopped = false;
  await poller.tick();
  assert.equal(written.length, 1, 'a zero sample is dropped rather than failing the batch');
  assert.equal(written[0].oi, '31349.53050000');
  assert.ok(written[0].tsUs > 0);
});
