import { createHash } from 'node:crypto';

const DECIMAL=/^(?:0|[1-9]\d*)(?:\.\d+)?$/;
function decimal(v,name='decimal'){const s=String(v);if(!DECIMAL.test(s)||Number(s)<=0)throw new TypeError(`invalid ${name} decimal`);return s;}
function msUs(v){const n=Number(v);if(!Number.isFinite(n))throw new TypeError('invalid timestamp');return Math.trunc(n*1000);}
function asset(symbol){return String(symbol).replace(/[-_]/g,'').match(/^(BTC|ETH|SOL|HYPE)/)?.[1]??null;}
function key(prefix,obj){return prefix+createHash('sha256').update(JSON.stringify(obj)).digest('hex');}
function trade({venue,symbol,marketKind,id,seq,ts,recv,side,price,qty}){return {type:'trade',venue,symbol:asset(symbol),marketKind,sourceKey:String(id),sourceSequence:seq==null?null:String(seq),tsEventUs:msUs(ts),tsRecvUs:recv,side,price:decimal(price,'price'),qty:decimal(qty,'quantity')};}
function liq({venue,symbol,id,ts,recv,eventKind,liquidatedSide,priceKind,price,qty}){return {type:'liquidation',venue,symbol:asset(symbol),marketKind:'perp',sourceKey:String(id),sourceSequence:null,tsEventUs:msUs(ts),tsRecvUs:recv,eventKind,liquidatedSide,aggressorSide:0,priceKind,price:decimal(price,'price'),qty:decimal(qty,'quantity')};}

export function normalizeHyperliquid(msg,recv){
 if(msg.channel!=='trades'||!Array.isArray(msg.data))return [];
 return msg.data.filter(x=>asset(x.coin)).map(x=>trade({venue:'hyperliquid',symbol:x.coin,marketKind:'perp',id:x.tid,seq:x.tid,ts:x.time,recv,side:x.side==='B'?1:x.side==='A'?-1:0,price:x.px,qty:x.sz}));
}

export function normalizeBinance(msg,recv,kind){
 const d=msg.data??msg;if(d.e==='trade'||d.e==='aggTrade') return asset(d.s)?[trade({venue:'binance',symbol:d.s,marketKind:kind,id:d.t??d.a,seq:d.t??d.a,ts:d.T??d.E,recv,side:d.m?-1:1,price:d.p,qty:d.q})]:[];
 if(d.e==='forceOrder'){const o=d.o;if(!asset(o.s))return [];const px=Number(o.ap)>0?o.ap:o.p;return [liq({venue:'binance',symbol:o.s,id:key('force:',d),ts:o.T??d.E,recv,eventKind:'order',liquidatedSide:o.S==='SELL'?'long':o.S==='BUY'?'short':'unknown',priceKind:Number(o.ap)>0?'execution':'unknown',price:px,qty:o.q})];}
 return [];
}

export function normalizeBybit(msg,recv,category){
 if(msg.topic?.startsWith('publicTrade.')) return (msg.data??[]).filter(x=>asset(x.s)).map(x=>trade({venue:'bybit',symbol:x.s,marketKind:category==='spot'?'spot':'perp',id:x.i??key('trade:',x),seq:x.seq,ts:x.T,recv,side:x.S==='Buy'?1:x.S==='Sell'?-1:0,price:x.p,qty:x.v}));
 if(msg.topic?.startsWith('allLiquidation.')) return (msg.data??[]).filter(x=>asset(x.s)).map(x=>liq({venue:'bybit',symbol:x.s,id:key('liq:',x),ts:x.T,recv,eventKind:'order',liquidatedSide:x.S==='Sell'?'long':x.S==='Buy'?'short':'unknown',priceKind:'bankruptcy',price:x.p,qty:x.v}));
 return [];
}

export function normalizeOkx(msg,recv){
 const channel=msg.arg?.channel;
 if(channel==='trades-all')return (msg.data??[]).filter(x=>asset(x.instId)).map(x=>trade({venue:'okx',symbol:x.instId,marketKind:x.instId.endsWith('-SWAP')?'perp':'spot',id:x.tradeId,seq:x.seqId,ts:x.ts,recv,side:x.side==='buy'?1:x.side==='sell'?-1:0,price:x.px,qty:x.sz}));
 if(channel==='liquidation-orders'){
  const out=[];for(const group of msg.data??[])for(const x of group.details??[])if(asset(group.instId))out.push(liq({venue:'okx',symbol:group.instId,id:key('liq:',{i:group.instId,...x}),ts:x.ts,recv,eventKind:'summary',liquidatedSide:x.side==='sell'?'long':x.side==='buy'?'short':'unknown',priceKind:'bankruptcy',price:x.bkPx,qty:x.sz}));return out;
 }
 return [];
}
