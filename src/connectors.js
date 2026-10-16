import { normalizeHyperliquid,normalizeBinance,normalizeBybit,normalizeOkx } from './normalizers.js';
const A=['BTC','ETH','SOL','HYPE'];
const usdt=A.map(x=>`${x}USDT`),okSpot=A.map(x=>`${x}-USDT`),okSwap=A.map(x=>`${x}-USDT-SWAP`);
export function connectorConfigs(){return [
 {name:'hyperliquid-perp',url:'wss://api.hyperliquid.xyz/ws',subscribe:()=>A.map(coin=>({method:'subscribe',subscription:{type:'trades',coin}})),normalize:normalizeHyperliquid,ping:()=>({method:'ping'})},
 {name:'binance-spot',url:`wss://data-stream.binance.vision/stream?streams=${usdt.map(x=>x.toLowerCase()+'@trade').join('/')}`,subscribe:()=>[],normalize:(m,r)=>normalizeBinance(m,r,'spot')},
 {name:'binance-perp',url:`wss://fstream.binance.com/stream?streams=${[...usdt.map(x=>x.toLowerCase()+'@trade'),'!forceOrder@arr'].join('/')}`,subscribe:()=>[],normalize:(m,r)=>normalizeBinance(m,r,'perp')},
 {name:'bybit-spot',url:'wss://stream.bybit.com/v5/public/spot',subscribe:()=>({op:'subscribe',args:usdt.map(x=>`publicTrade.${x}`)}),normalize:(m,r)=>normalizeBybit(m,r,'spot'),ping:()=>({op:'ping'})},
 {name:'bybit-linear',url:'wss://stream.bybit.com/v5/public/linear',subscribe:()=>({op:'subscribe',args:[...usdt.map(x=>`publicTrade.${x}`),...usdt.map(x=>`allLiquidation.${x}`)]}),normalize:(m,r)=>normalizeBybit(m,r,'linear'),ping:()=>({op:'ping'})},
 {name:'okx-trades',url:'wss://ws.okx.com/ws/v5/business',subscribe:()=>({op:'subscribe',args:[...okSpot,...okSwap].map(instId=>({channel:'trades-all',instId}))}),normalize:normalizeOkx,ping:()=> 'ping'},
 {name:'okx-liquidations',url:'wss://ws.okx.com/ws/v5/public',subscribe:()=>({op:'subscribe',args:[{channel:'liquidation-orders',instType:'SWAP'}]}),normalize:normalizeOkx,ping:()=> 'ping'}
 ];}
