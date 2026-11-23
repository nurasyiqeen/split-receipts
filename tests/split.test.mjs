import assert from 'node:assert';
import * as S from '../js/split.js';
// allocate exactness
for (let t = -500; t < 5000; t += 37) { const a = S.allocate(t, {a:1,b:2,c:3}); assert.equal(a.a+a.b+a.c, t); }
// Coliseum: lamb burger (me), 2 chicken (ali, siti by unit), 3 water (one each by unit)
const r = { id:'r1', date:'2026-11-17', currency:'MYR', payerId:'me', createdAt:1,
  items:[{id:'1',name:'Lamb',qty:1,amount:35.9,shares:{me:1}},
         {id:'2',name:'Chicken',qty:2,amount:57.8,byUnit:true,shares:{ali:1,siti:1}},
         {id:'3',name:'Water',qty:3,amount:2.7,byUnit:true,shares:{me:1,ali:1,siti:1}}],
  adjustments:[{amount:9.64},{amount:5.78},{amount:-0.02}] };
const s = S.splitReceipt(r);
const tot = Object.values(s.people).reduce((x,p)=>x+p.total,0);
assert.equal(tot, 11180); assert.equal(s.unassigned, 0);
console.log(Object.fromEntries(Object.entries(s.people).map(([k,p])=>[k,p.total/100])));
// partial unit assignment
r.items[2].shares = {me:1};
assert.equal(S.splitReceipt(r).unassigned > 0, true);
r.items[2].shares = {me:1,ali:1,siti:1};
// balances & payments
const pay = [{from:'ali',to:'me',amount:10,currency:'MYR',date:'2026-11-18',createdAt:2}];
const b = S.pairBalances([r], pay);
console.log('ali owes me', S.balanceWith(b,'me','ali'), 'siti', S.balanceWith(b,'me','siti'));
const ev = S.ledger([r], pay, 'me', 'ali'); console.log(ev.map(e=>[e.type,e.cents,e.balance]));
console.log('outstanding', S.outstanding(ev,'MYR').length);
// friend paid: ali paid, me owes ali
const r2 = {...r, id:'r2', payerId:'ali'};
console.log('after r2 ali owes me', S.balanceWith(S.pairBalances([r,r2],pay),'me','ali'));
console.log('all ok');
