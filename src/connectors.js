import { normalizeHyperliquid,normalizeBinance,normalizeBybit,normalizeOkx,normalizeBitget,normalizeCoinbase,normalizeDeribit } from './normalizers.js';
const A=['BTC','ETH','SOL','HYPE'];
const usdt=A.map(x=>`${x}USDT`),okSpot=A.map(x=>`${x}-USDT`),okSwap=A.map(x=>`${x}-USDT-SWAP`);

// Every feed in the catalogue runs by default, which is what the VPS wants: it reaches
// all of them. Some dev machines cannot (Bybit refuses the TLS handshake on both
// stream.bybit.com and stream.bytick.com; fstream.binance.com completes TLS then drops
// the upgrade with 1006). That is a property of one host, not of the deployment, so it
// is handled with an env var instead of being baked into what ships:
//   COLLECTOR_SKIP=binance-perp,bybit-spot,bybit-linear   skip these
//   COLLECTOR_SOURCES=okx-trades,bitget-perp              run only these
export const LOCAL_UNREACHABLE_HINT='binance-perp,bybit-spot,bybit-linear';

// The full catalogue of feed definitions, independent of what this host can reach.
export function connectorConfigs(){return [
 {name:'hyperliquid-perp',url:'wss://api.hyperliquid.xyz/ws',subscribe:()=>A.map(coin=>({method:'subscribe',subscription:{type:'trades',coin}})),normalize:normalizeHyperliquid,ping:()=>({method:'ping'})},
 {name:'binance-spot',url:`wss://data-stream.binance.vision/stream?streams=${usdt.map(x=>x.toLowerCase()+'@trade').join('/')}`,subscribe:()=>[],normalize:(m,r)=>normalizeBinance(m,r,'spot')},
 {name:'binance-perp',url:`wss://fstream.binance.com/stream?streams=${[...usdt.map(x=>x.toLowerCase()+'@trade'),'!forceOrder@arr'].join('/')}`,subscribe:()=>[],normalize:(m,r)=>normalizeBinance(m,r,'perp')},
 {name:'bybit-spot',url:'wss://stream.bybit.com/v5/public/spot',subscribe:()=>({op:'subscribe',args:usdt.map(x=>`publicTrade.${x}`)}),normalize:(m,r)=>normalizeBybit(m,r,'spot'),ping:()=>({op:'ping'})},
 {name:'bybit-linear',url:'wss://stream.bybit.com/v5/public/linear',subscribe:()=>({op:'subscribe',args:[...usdt.map(x=>`publicTrade.${x}`),...usdt.map(x=>`allLiquidation.${x}`)]}),normalize:(m,r)=>normalizeBybit(m,r,'linear'),ping:()=>({op:'ping'})},
 {name:'okx-trades',url:'wss://ws.okx.com/ws/v5/business',subscribe:()=>({op:'subscribe',args:[...okSpot,...okSwap].map(instId=>({channel:'trades-all',instId}))}),normalize:normalizeOkx,ping:()=> 'ping'},
 {name:'okx-liquidations',url:'wss://ws.okx.com/ws/v5/public',subscribe:()=>({op:'subscribe',args:[{channel:'liquidation-orders',instType:'SWAP'}]}),normalize:normalizeOkx,ping:()=> 'ping'},
 {name:'bitget-perp',url:'wss://ws.bitget.com/v2/ws/public',subscribe:()=>({op:'subscribe',args:usdt.map(instId=>({instType:'USDT-FUTURES',channel:'trade',instId}))}),normalize:normalizeBitget,ping:()=> 'ping'},
 {name:'coinbase-spot',url:'wss://ws-feed.exchange.coinbase.com',subscribe:()=>({type:'subscribe',product_ids:['BTC-USD','ETH-USD','SOL-USD'],channels:['matches']}),normalize:normalizeCoinbase},
 {name:'deribit-perp',url:'wss://www.deribit.com/ws/api/v2',subscribe:()=>({jsonrpc:'2.0',id:1,method:'public/subscribe',params:{channels:['trades.BTC-PERPETUAL.100ms','trades.ETH-PERPETUAL.100ms','trades.SOL_USDC-PERPETUAL.100ms']}}),normalize:normalizeDeribit,ping:()=>({jsonrpc:'2.0',id:99,method:'public/test',params:{}})}
 ];}

// What this process should actually dial: an explicit allowlist wins, otherwise the
// whole catalogue minus anything named in COLLECTOR_SKIP.
export function activeConnectorConfigs(env=process.env){
 const all=connectorConfigs();
 const list=v=>v?.split(',').map(s=>s.trim()).filter(Boolean)??[];
 const only=list(env.COLLECTOR_SOURCES);
 if(only.length)return all.filter(c=>only.includes(c.name));
 const skip=new Set(list(env.COLLECTOR_SKIP));
 return skip.size?all.filter(c=>!skip.has(c.name)):all;
}
