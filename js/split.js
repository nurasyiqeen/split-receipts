// Pure money maths. All amounts are handled in cents (integers) so shares always add up exactly.

export const toCents = n => Math.round((Number(n) || 0) * 100);
export const UNASSIGNED = '__unassigned__';

// Split `total` cents by `weights` ({key: weight}) using the largest-remainder method.
export function allocate(total, weights) {
  const keys = Object.keys(weights).filter(k => weights[k] > 0);
  const out = {};
  if (!keys.length) return out;
  const sum = keys.reduce((s, k) => s + weights[k], 0);
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  let given = 0;
  const rema = keys.map(k => {
    const exact = (abs * weights[k]) / sum;
    const base = Math.floor(exact + 1e-9);
    out[k] = base;
    given += base;
    return { k, r: exact - base };
  });
  rema.sort((a, b) => b.r - a.r || keys.indexOf(a.k) - keys.indexOf(b.k));
  for (let i = 0; given < abs; i++, given++) out[rema[i % rema.length].k] += 1;
  for (const k of keys) out[k] *= sign;
  return out;
}

// Who pays what for one item. Returns {personId: cents} plus UNASSIGNED for any part nobody took.
export function itemSplit(item) {
  const cents = toCents(item.amount);
  const shares = Object.fromEntries(Object.entries(item.shares || {}).filter(([, n]) => n > 0));
  if (item.byUnit && item.qty > 1) {
    const used = Object.values(shares).reduce((s, n) => s + n, 0);
    const w = { ...shares };
    if (used < item.qty) w[UNASSIGNED] = item.qty - used;
    return allocate(cents, w);
  }
  if (!Object.keys(shares).length) return { [UNASSIGNED]: cents };
  // Equal split among everyone who took a share.
  return allocate(cents, Object.fromEntries(Object.keys(shares).map(k => [k, 1])));
}

export const itemsTotal = r => r.items.reduce((s, i) => s + toCents(i.amount), 0);
export const adjustmentsTotal = r => r.adjustments.reduce((s, a) => s + toCents(a.amount), 0);
export const receiptTotal = r => itemsTotal(r) + adjustmentsTotal(r);

// Full split of a receipt. Tax, service charge, discounts and rounding are shared in proportion
// to what each person ordered.
export function splitReceipt(r) {
  const people = {};
  const ensure = id => (people[id] ||= { items: 0, extra: 0, total: 0, lines: [] });
  let unassigned = 0;
  for (const item of r.items) {
    const parts = itemSplit(item);
    for (const [pid, c] of Object.entries(parts)) {
      if (pid === UNASSIGNED) { unassigned += c; continue; }
      const p = ensure(pid);
      p.items += c;
      p.lines.push({ itemId: item.id, name: item.name, amount: c, units: item.byUnit && item.qty > 1 ? item.shares[pid] : null, sharedWith: item.byUnit ? 0 : Object.keys(parts).length });
    }
  }
  const adj = adjustmentsTotal(r);
  const extras = allocate(adj, Object.fromEntries(Object.entries(people).map(([k, p]) => [k, Math.max(p.items, 0)])));
  for (const [pid, p] of Object.entries(people)) {
    p.extra = extras[pid] || 0;
    p.total = p.items + p.extra;
  }
  // Adjustments that could not be shared (nobody assigned yet) are counted as unassigned.
  const assignedExtra = Object.values(extras).reduce((s, n) => s + n, 0);
  return { people, unassigned: unassigned + (adj - assignedExtra), total: receiptTotal(r) };
}

// Debts implied by a saved receipt: everyone except the payer owes the payer their share.
export function receiptDebts(r) {
  const { people } = splitReceipt(r);
  return Object.entries(people)
    .filter(([pid, p]) => pid !== r.payerId && p.total !== 0)
    .map(([pid, p]) => ({ from: pid, to: r.payerId, cents: p.total, currency: r.currency, receiptId: r.id, date: r.date }));
}

// Net balances between every pair of people, per currency.
// Returns Map key "a|b|CUR" (a<b) -> cents that a owes b (negative = b owes a).
export function pairBalances(receipts, payments) {
  const m = new Map();
  const add = (from, to, cents, cur) => {
    if (from === to || !cents) return;
    const [a, b, s] = from < to ? [from, to, 1] : [to, from, -1];
    const key = `${a}|${b}|${cur}`;
    m.set(key, (m.get(key) || 0) + s * cents);
  };
  for (const r of receipts) for (const d of receiptDebts(r)) add(d.from, d.to, d.cents, d.currency);
  for (const p of payments) add(p.to, p.from, toCents(p.amount), p.currency); // paying reduces what `from` owes `to`
  return m;
}

// What `other` owes `me` per currency (negative = I owe them).
export function balanceWith(balances, me, other) {
  const out = {};
  for (const [key, cents] of balances) {
    const [a, b, cur] = key.split('|');
    if (a === other && b === me) out[cur] = (out[cur] || 0) + cents;
    else if (a === me && b === other) out[cur] = (out[cur] || 0) - cents;
  }
  for (const k of Object.keys(out)) if (!out[k]) delete out[k];
  return out;
}

// Chronological ledger between two people: receipts and payments, with a running balance
// (positive = other owes me).
export function ledger(receipts, payments, me, other) {
  const ev = [];
  for (const r of receipts) for (const d of receiptDebts(r)) {
    if (d.from === other && d.to === me) ev.push({ type: 'receipt', date: r.date, created: r.createdAt, receipt: r, cents: d.cents, currency: r.currency });
    if (d.from === me && d.to === other) ev.push({ type: 'receipt', date: r.date, created: r.createdAt, receipt: r, cents: -d.cents, currency: r.currency });
  }
  for (const p of payments) {
    if (p.from === other && p.to === me) ev.push({ type: 'payment', date: p.date, created: p.createdAt, payment: p, cents: -toCents(p.amount), currency: p.currency });
    if (p.from === me && p.to === other) ev.push({ type: 'payment', date: p.date, created: p.createdAt, payment: p, cents: toCents(p.amount), currency: p.currency });
  }
  ev.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.created || 0) - (b.created || 0));
  const run = {};
  for (const e of ev) { run[e.currency] = (run[e.currency] || 0) + e.cents; e.balance = run[e.currency]; }
  return ev;
}

// Entries still outstanding for one currency: everything since the balance was last settled.
export function outstanding(ev, currency) {
  const list = ev.filter(e => e.currency === currency);
  let start = 0;
  list.forEach((e, i) => { if (Math.sign(e.balance) !== Math.sign(list[list.length - 1].balance) || e.balance === 0) start = i + 1; });
  return list.slice(start);
}
