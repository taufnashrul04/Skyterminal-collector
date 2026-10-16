export const sessionStartMs = Date.parse('2026-01-01T09:30:00Z');
export const fixtureTrades = [
['09:30',100,1,2],['09:35',101,-1,1],['09:50',102,1,3],['10:05',101,1,1],['10:20',103,-1,2],['10:35',102,-1,1],['10:50',104,1,4],['11:05',103,1,2],['11:20',102,-1,2]
].map(([hm,price,side,qty],i)=>{const [h,m]=hm.split(':').map(Number);return {id:i+1,tsMs:Date.UTC(2026,0,1,h,m),price:BigInt(price),qty:BigInt(qty),quote:BigInt(price*qty),side};});
