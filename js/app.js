import { db } from './db.js';
import { scanWithFallback, checkReceipt, DEFAULT_MODEL } from './scan.js';
import * as S from './split.js';

const ME = 'me';
const VERSION = '1.2.2';
const PERSON_COLORS = ['#ec5f93', '#7c5ce0', '#2f9fd8', '#f59a3c', '#22a699', '#d6457a', '#5b6fd6', '#f2705a', '#4fae5a', '#a855c7', '#1fb3c4', '#d19a1a'];
const ACCENTS = ['#0f9d76', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#0891b2', '#475569'];
// Lively style: accent + a second colour for gradients.
const LIVELY = { '#e8508a': '#ff9f7a', '#c04a9b': '#f59ac0', '#8b5cf6': '#f472b6', '#f2665e': '#ffb36b', '#0ea5a0': '#a78bfa', '#4f7cf5': '#c084fc' };
const STYLES = { lively: Object.keys(LIVELY), classic: ACCENTS };
const CURRENCIES = ['MYR', 'SGD', 'USD', 'EUR', 'GBP', 'THB', 'IDR', 'JPY', 'KRW', 'CNY', 'AUD', 'HKD', 'TWD'];
const SYMBOLS = { MYR: 'RM', SGD: 'S$', USD: 'US$', EUR: '€', GBP: '£', THB: '฿', IDR: 'Rp', JPY: '¥', KRW: '₩', CNY: 'CN¥', AUD: 'A$', HKD: 'HK$', TWD: 'NT$' };
const MODELS = [
  ['gemini-flash-lite-latest', 'Gemini Flash-Lite (recommended, free)'],
  ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite'],
  ['gemini-flash-latest', 'Gemini Flash (smarter, lower free limit)'],
  ['gemini-3.5-flash', 'Gemini 3.5 Flash'],
];
const DEFAULT_SETTINGS = { apiKey: '', model: DEFAULT_MODEL, myName: '', currency: 'MYR', countryCode: '60', theme: 'auto', style: 'lively', pattern: true, accent: '#e8508a' };

const state = { people: [], groups: [], receipts: [], payments: [], settings: { ...DEFAULT_SETTINGS }, draft: null, draftPhoto: null, scanning: null, scanError: null, pendingGroup: '' };

// ---------- helpers ----------
const $ = sel => document.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayISO = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const sym = cur => SYMBOLS[cur] || cur;
const fmt = (cents, cur = state.settings.currency, signed = false) => `${cents < 0 ? '−' : signed && cents > 0 ? '+' : ''}${sym(cur)} ${(Math.abs(cents) / 100).toFixed(2)}`;
const fmtDate = iso => { if (!iso) return ''; const d = new Date(iso + 'T00:00:00'); return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
const parseAmount = v => { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : Math.round(n * 100) / 100; };
const person = id => state.people.find(p => p.id === id) || { id, name: 'Unknown', color: '#888' };
const pname = id => (id === ME ? 'Me' : person(id).name);
const myName = () => state.settings.myName || 'me';
const friends = (includeArchived = false) => state.people.filter(p => p.id !== ME && (includeArchived || !p.archived)).sort((a, b) => a.name.localeCompare(b.name));
const initials = name => (name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
const avatar = (id, cls = '') => { const p = person(id); return `<span class="avatar ${cls}" style="background:${p.color}">${esc(initials(pname(id)))}</span>`; };
const tidyName = s => (/[a-z]/.test(s) || s.length < 4 ? s : s.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase()));
const clone = o => JSON.parse(JSON.stringify(o));

function toast(msg, ms = 2600) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg; t.setAttribute('role', 'status');
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

const ICONS = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h4"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.8"/><path d="M16 14.6c2.7.2 4.6 2 5.3 5.4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  gallery: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  pen: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  group: '<circle cx="12" cy="7" r="3"/><circle cx="5" cy="10" r="2.3"/><circle cx="19" cy="10" r="2.3"/><path d="M6.5 20c.6-3.6 2.8-5.5 5.5-5.5s4.9 1.9 5.5 5.5M1.5 19c.4-2.3 1.7-3.6 3.5-3.8M22.5 19c-.4-2.3-1.7-3.6-3.5-3.8"/>',
};
const icon = (name, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${ICONS[name]}</svg>`;

// ---------- persistence ----------
async function load() {
  const [people, groups, receipts, payments, settings, draft] = await Promise.all([
    db.all('people'), db.all('groups'), db.all('receipts'), db.all('payments'), db.get('kv', 'settings'), db.get('kv', 'draft'),
  ]);
  Object.assign(state, { people, groups, receipts, payments, settings: { ...DEFAULT_SETTINGS, ...(settings || {}) }, draft: draft || null });
  if (settings && !settings.style) { state.settings.style = 'lively'; state.settings.accent = DEFAULT_SETTINGS.accent; await saveSettings(); }
  if (draft) state.draftPhoto = await db.get('photos', 'draft') || null;
  if (!state.people.find(p => p.id === ME)) {
    const me = { id: ME, name: 'Me', color: '#475569' };
    state.people.push(me);
    await db.put('people', me);
  }
}
const saveSettings = () => db.put('kv', state.settings, 'settings');
async function putRecord(store, rec) {
  await db.put(store, rec);
  const list = state[store];
  const i = list.findIndex(x => x.id === rec.id);
  if (i >= 0) list[i] = rec; else list.push(rec);
  navigator.storage?.persist?.();
}
async function delRecord(store, id) {
  await db.del(store, id);
  state[store] = state[store].filter(x => x.id !== id);
}
let draftTimer;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => { if (state.draft) db.put('kv', state.draft, 'draft'); }, 300);
}
async function clearDraft() {
  state.draft = null; state.draftPhoto = null;
  await db.del('kv', 'draft');
  await db.del('photos', 'draft');
}

function newPerson(name, phone = '') {
  const used = state.people.length;
  return { id: uid(), name: name.trim(), phone: phone.trim(), color: PERSON_COLORS[used % PERSON_COLORS.length], createdAt: Date.now() };
}

// ---------- theme ----------
function applyTheme() {
  const { theme, accent, style } = state.settings;
  const root = document.documentElement;
  if (theme === 'auto') delete root.dataset.theme; else root.dataset.theme = theme;
  root.dataset.style = style;
  root.dataset.pattern = state.settings.pattern === false ? 'off' : 'on';
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-2', LIVELY[accent] || `color-mix(in srgb, ${accent} 65%, #04140f)`);
  const me = state.people.find(p => p.id === ME);
  if (me) me.color = accent; // your own avatar follows the accent colour
  // Status bar blends with the page background in both light and dark.
  requestAnimationFrame(() => document.querySelector('meta[name=theme-color]')?.setAttribute('content', getComputedStyle(root).getPropertyValue('--bg').trim()));
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme());

// ---------- balances ----------
const balances = () => S.pairBalances(state.receipts, state.payments);
function sumByCurrency(objs) {
  const out = {};
  for (const o of objs) for (const [c, v] of Object.entries(o)) out[c] = (out[c] || 0) + v;
  return out;
}
const fmtMulti = (obj, signed) => Object.entries(obj).filter(([, v]) => v).map(([c, v]) => fmt(v, c, signed)).join(' · ') || fmt(0);

// ---------- sheets (bottom dialogs) ----------
function sheet(html, { onClose } = {}) {
  const d = document.createElement('dialog');
  d.className = 'sheet';
  d.innerHTML = `<div class="inner">${html}</div>`;
  document.body.append(d);
  d.addEventListener('click', e => { if (e.target === d) d.close(); });
  d.addEventListener('close', () => { d.remove(); onClose?.(); });
  d.showModal();
  return d;
}
function confirmSheet(title, body, okLabel = 'Delete', danger = true) {
  return new Promise(resolve => {
    let ok = false;
    const d = sheet(`<h3>${esc(title)}</h3><p class="muted">${esc(body)}</p>
      <div class="btns"><button class="btn" data-x="no">Cancel</button><button class="btn ${danger ? 'primary' : 'primary'}" data-x="ok" style="${danger ? 'background:var(--bad)' : ''}">${esc(okLabel)}</button></div>`,
    { onClose: () => resolve(ok) });
    d.querySelector('[data-x=no]').onclick = () => d.close();
    d.querySelector('[data-x=ok]').onclick = () => { ok = true; d.close(); };
  });
}

// ---------- router ----------
const routes = [
  [/^$/, homePage], [/^receipts$/, receiptsPage], [/^new$/, newPage], [/^edit$/, editorPage],
  [/^r\/([\w-]+)$/, receiptPage], [/^r\/([\w-]+)\/edit$/, editExisting],
  [/^friends$/, friendsPage], [/^f\/([\w-]+)$/, friendPage],
  [/^groups$/, groupsPage], [/^g\/([\w-]+)$/, groupPage], [/^settings$/, settingsPage],
];
let current = null;
function render() {
  const path = location.hash.replace(/^#\/?/, '');
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) {
      const page = fn(...m.slice(1));
      if (!page) return;
      current = page;
      $('#top').innerHTML = `${page.back ? `<a class="icon-btn" href="${page.back}" aria-label="Back">${icon('back')}</a>` : ''}<h1>${esc(page.title)}</h1>${page.actions || ''}`;
      $('#app').innerHTML = page.html;
      document.title = page.title === 'Split Receipts' ? page.title : `${page.title} · Split Receipts`;
      renderTabs(page.tab);
      page.after?.();
      return;
    }
  }
  location.hash = '#/';
}
function rerender() { const y = scrollY; render(); scrollTo(0, y); }
function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }
function renderTabs(tab) {
  const t = (key, href, label, ic) => `<a href="${href}" class="${tab === key ? 'on' : ''}">${icon(ic)}<span>${label}</span></a>`;
  $('#tabs').innerHTML = t('home', '#/', 'Home', 'home') + t('receipts', '#/receipts', 'Receipts', 'receipt') +
    `<a href="#/new" class="scan ${tab === 'new' ? 'on' : ''}" aria-label="Scan receipt"><span class="dot">${icon('camera')}</span><span>Scan</span></a>` +
    t('friends', '#/friends', 'Friends', 'people') + t('settings', '#/settings', 'Settings', 'settings');
}

// ---------- pages ----------
function homePage() {
  const bal = balances();
  const rows = friends(true).map(f => ({ f, b: S.balanceWith(bal, ME, f.id) })).filter(x => Object.keys(x.b).length);
  const owed = sumByCurrency(rows.map(x => Object.fromEntries(Object.entries(x.b).filter(([, v]) => v > 0))));
  const owe = sumByCurrency(rows.map(x => Object.fromEntries(Object.entries(x.b).filter(([, v]) => v < 0).map(([c, v]) => [c, -v]))));
  rows.sort((a, b) => Math.abs(Object.values(b.b)[0]) - Math.abs(Object.values(a.b)[0]));
  const between = [...bal].filter(([k, v]) => v && !k.split('|').slice(0, 2).includes(ME));
  const recent = [...state.receipts].sort(byDateDesc).slice(0, 5);
  const noKey = !state.settings.apiKey;

  const html = `
    ${noKey ? `<div class="banner warn">To scan receipts, add a free Gemini API key in <a href="#/settings">Settings</a>. You can still type receipts in by hand.</div>` : ''}
    <div class="hero">
      <div class="card"><div class="muted small">Owed to you</div><div class="big-amount num good" style="font-size:24px">${fmtMulti(owed)}</div></div>
      <div class="card"><div class="muted small">You owe</div><div class="big-amount num ${Object.keys(owe).length ? 'bad' : ''}" style="font-size:24px">${fmtMulti(owe)}</div></div>
    </div>
    <div class="card flush">
      <h2>Balances</h2>
      ${rows.length ? `<div class="list">${rows.map(({ f, b }) => `<a href="#/f/${f.id}">${avatar(f.id)}<div class="grow"><div class="ellipsis">${esc(f.name)}</div><div class="small muted">${Object.values(b)[0] > 0 ? 'owes you' : 'you owe'}</div></div><div class="amt num ${Object.values(b)[0] > 0 ? 'good' : 'bad'}">${Object.entries(b).map(([c, v]) => fmt(Math.abs(v), c)).join('<br>')}</div></a>`).join('')}</div>`
        : `<div class="empty">All settled up. 🎉</div>`}
    </div>
    ${between.length ? `<div class="card flush"><h2>Between friends</h2><div class="list">${between.map(([k, v]) => {
      const [a, b, cur] = k.split('|'); const [from, to] = v > 0 ? [a, b] : [b, a];
      return `<li>${avatar(from, 'sm')}<div class="grow small">${esc(pname(from))} owes ${esc(pname(to))}</div><div class="amt num">${fmt(Math.abs(v), cur)}</div></li>`;
    }).join('')}</div></div>` : ''}
    <div class="card flush">
      <div class="row between" style="padding-right:16px"><h2>Recent receipts</h2>${state.receipts.length > 5 ? '<a class="small" href="#/receipts">See all</a>' : ''}</div>
      ${recent.length ? `<div class="list">${recent.map(receiptRow).join('')}</div>` : `<div class="empty"><p>No receipts yet.</p><a class="btn primary" href="#/new">${icon('camera', 'width=20 height=20')} Scan your first receipt</a></div>`}
    </div>`;
  return { title: 'Split Receipts', html, tab: 'home' };
}

const totalQty = r => r.items.reduce((s, i) => s + (i.qty || 1), 0);
const qtyLine = (it, cur) => `<span class="qty-line">Qty ${it.qty}${it.qty > 1 ? ` × ${fmt(Math.round(S.toCents(it.amount) / it.qty), cur)}` : ''}</span>`;
const byDateDesc = (a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0);
function receiptRow(r) {
  const total = S.receiptTotal(r);
  return `<a href="#/r/${r.id}">${avatar(r.payerId, 'sm')}<div class="grow"><div class="ellipsis">${esc(r.merchant || 'Receipt')}</div><div class="small muted">${fmtDate(r.date)} · ${r.participants.length} people${r.groupId ? ' · ' + esc(state.groups.find(g => g.id === r.groupId)?.name || '') : ''}</div></div><div class="amt num">${fmt(total, r.currency)}</div></a>`;
}

const monthName = m => { const d = new Date(m + '-01T00:00:00'); return isNaN(d) ? m : d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }); };
let receiptFilter = { q: '', group: '' };
function receiptsPage() {
  const q = receiptFilter.q.toLowerCase();
  const list = state.receipts.filter(r => (!receiptFilter.group || r.groupId === receiptFilter.group) &&
    (!q || (r.merchant || '').toLowerCase().includes(q) || r.items.some(i => i.name.toLowerCase().includes(q)) || r.participants.some(p => pname(p).toLowerCase().includes(q))))
    .sort(byDateDesc);
  const months = {};
  for (const r of list) { const m = (r.date || '').slice(0, 7) || 'Undated'; (months[m] ||= []).push(r); }
  const html = `
    <div class="row" style="margin-top:4px">
      <input type="text" id="rq" placeholder="Search shop, item or friend" value="${esc(receiptFilter.q)}" class="grow">
      ${state.groups.length ? `<select id="rg" style="width:auto"><option value="">All groups</option>${state.groups.map(g => `<option value="${g.id}" ${g.id === receiptFilter.group ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select>` : ''}
    </div>
    <div id="rlist">${Object.entries(months).map(([m, rs]) => `<div class="card flush"><h2>${esc(monthName(m))}</h2><div class="list">${rs.map(receiptRow).join('')}</div></div>`).join('') || `<div class="empty">${state.receipts.length ? 'No matching receipts.' : 'No receipts yet.'}</div>`}</div>`;
  return {
    title: 'Receipts', html, tab: 'receipts',
    actions: state.receipts.length ? `<button class="btn sm" data-act="report" data-id="${receiptFilter.group}">${icon('gallery', 'width=16 height=16')} Report</button>` : '',
    after() {
      const rq = $('#rq');
      rq.oninput = () => { receiptFilter.q = rq.value; const pos = rq.selectionStart; render(); const n = $('#rq'); n.focus(); n.setSelectionRange(pos, pos); };
      const rg = $('#rg'); if (rg) rg.onchange = () => { receiptFilter.group = rg.value; render(); };
    },
  };
}

// ----- new receipt / scanning -----
function newPage() {
  if (state.scanning) {
    return { title: 'Reading receipt', tab: 'new', html: `<div class="card scan-zone"><div class="spinner"></div><p><strong>Reading your receipt…</strong></p><p class="muted small">${esc(state.scanning)}</p></div>` };
  }
  const noKey = !state.settings.apiKey;
  const html = `
    ${state.draft ? `<div class="banner warn row between"><span>You have an unsaved receipt${state.draft.merchant ? ` (${esc(state.draft.merchant)})` : ''}.</span><span class="btns" style="flex:none"><button class="btn sm" data-act="draft-discard">Discard</button><button class="btn sm primary" data-act="draft-continue">Continue</button></span></div>` : ''}
    ${state.scanError ? `<div class="banner warn"><strong>Couldn't read the receipt.</strong><br>${esc(state.scanError)}${state.draftPhoto ? '<div class="btns" style="margin-top:8px"><button class="btn sm" data-act="rescan">Try again</button><button class="btn sm" data-act="manual-photo">Enter by hand</button></div>' : ''}</div>` : ''}
    <div class="card scan-zone">
      ${icon('receipt')}
      <h2 style="text-transform:none;letter-spacing:0;font-size:20px;color:var(--ink)">Add a receipt</h2>
      <p class="muted small">Take a photo of the whole receipt, flat and in good light.</p>
      <div class="stack">
        <label class="btn primary block">${icon('camera', 'width=22 height=22')} Take photo<input type="file" accept="image/*" capture="environment" data-photo hidden></label>
        <label class="btn block">${icon('gallery', 'width=22 height=22')} Choose from gallery<input type="file" accept="image/*" data-photo hidden></label>
        <button class="btn block ghost" data-act="manual">${icon('pen', 'width=20 height=20')} Type it in by hand</button>
      </div>
    </div>
    ${noKey ? keyHelp() : ''}`;
  return { title: 'New receipt', html, tab: 'new' };
}

function keyHelp() {
  return `<div class="card"><h2>Set up scanning (free, 2 minutes)</h2>
    <ol class="small" style="padding-left:20px;margin:0">
      <li>Open <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio → API keys</a> and sign in with your Google account.</li>
      <li>Tap <strong>Create API key</strong> and copy it.</li>
      <li>Paste it in <a href="#/settings">Settings → Receipt scanning</a>.</li>
    </ol>
    <p class="small muted" style="margin-bottom:0">The free tier is plenty for personal use. The key is stored only on this phone and sent only to Google.</p></div>`;
}

async function compressImage(file, max = 1800, quality = 0.85) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(b => res(b || file), 'image/jpeg', quality));
  } catch {
    return file; // e.g. HEIC the browser can't draw; Gemini can still read it
  } finally {
    URL.revokeObjectURL(url);
  }
}
const blobToBase64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });

async function handlePhoto(file) {
  if (!file) return;
  state.scanError = null;
  const blob = await compressImage(file);
  state.draftPhoto = blob;
  await db.put('photos', blob, 'draft');
  if (!state.settings.apiKey) {
    startDraft(null, true);
    toast('No API key yet, so enter the items by hand (photo attached).');
    return;
  }
  await runScan();
}
async function runScan() {
  state.scanError = null;
  state.scanning = 'This usually takes a few seconds.';
  go('#/new');
  try {
    const data = await scanWithFallback({ apiKey: state.settings.apiKey, model: state.settings.model, imageBase64: await blobToBase64(state.draftPhoto), mimeType: state.draftPhoto.type || 'image/jpeg' },
      (m, round) => { state.scanning = m ? (round ? `Busy, retrying (${m})…` : `Using ${m}…`) : 'Google is busy, waiting a moment…'; if (location.hash === '#/new') rerender(); });
    state.scanning = null;
    if (!data.items.length) throw new Error("No items found. Make sure the whole receipt is in the photo and it's in focus.");
    startDraft(data, true);
  } catch (e) {
    state.scanning = null;
    state.scanError = e.status === 400 && /API key/i.test(e.message) ? 'Your API key was rejected. Check it in Settings.' :
      e.status === 429 ? 'Free limit reached for now. Wait a minute and try again, or enter it by hand.' : (e.message || 'Something went wrong.');
    go('#/new');
    rerender();
  }
}

function startDraft(data, withPhoto) {
  const group = state.groups.find(g => g.id === state.pendingGroup);
  state.draft = {
    id: uid(), isNew: true,
    merchant: data?.merchant || '', date: data?.date || todayISO(), currency: data?.currency || state.settings.currency,
    items: (data?.items || []).map(i => ({ id: uid(), name: tidyName(i.name), qty: i.quantity || 1, amount: i.lineTotal, shares: {}, byUnit: false })),
    adjustments: (data?.adjustments || []).map(a => ({ id: uid(), label: a.label, kind: a.kind, amount: a.amount })),
    payerId: ME, participants: group ? [...new Set([ME, ...group.members])] : [ME], groupId: group?.id || '',
    hasPhoto: !!(withPhoto && state.draftPhoto), scan: data ? { subtotal: data.subtotal, total: data.total, model: data.model } : null,
    note: '', createdAt: Date.now(),
  };
  if (!withPhoto) state.draftPhoto = null;
  state.pendingGroup = '';
  saveDraft();
  go('#/edit');
}

// ----- editor -----
function editExisting(id) {
  const r = state.receipts.find(x => x.id === id);
  if (!r) { go('#/receipts'); return null; }
  state.draft = { ...clone(r), isNew: false };
  state.draftPhoto = null;
  saveDraft();
  go('#/edit');
  return null;
}

function editorPage() {
  const d = state.draft;
  if (!d) { setTimeout(() => go('#/new')); return null; }
  const split = S.splitReceipt(d);
  const itemSum = S.itemsTotal(d);
  const total = S.receiptTotal(d);
  const cur = d.currency;
  const parts = d.participants;

  let check = '';
  if (d.scan && d.items.length) {
    const subOk = Math.abs(itemSum - S.toCents(d.scan.subtotal)) <= 1;
    const totOk = Math.abs(total - S.toCents(d.scan.total)) <= 1;
    check = subOk && totOk
      ? `<div class="banner ok">✓ Items add up to the subtotal and the total matches the receipt (${fmt(total, cur)}). Still worth a quick look.</div>`
      : `<div class="banner warn">${!subOk ? `Items add up to ${fmt(itemSum, cur)} but the receipt subtotal says ${fmt(S.toCents(d.scan.subtotal), cur)}. ` : ''}${!totOk ? `Total is ${fmt(total, cur)} but the receipt says ${fmt(S.toCents(d.scan.total), cur)}.` : ''} Please check the items against the photo.
         ${!totOk ? `<div style="margin-top:8px"><button class="btn sm" data-act="fix-diff">Add the ${fmt(S.toCents(d.scan.total) - total, cur, true)} difference as an adjustment</button></div>` : ''}</div>`;
  }

  const chip = (pid, on, act, extra = '') => `<button class="chip ${on ? 'on' : ''}" style="--c:${person(pid).color}" data-act="${act}" data-pid="${pid}" ${extra}>${avatar(pid)}${esc(pname(pid))}</button>`;

  const itemHtml = d.items.map(it => {
    const parts2 = S.itemSplit(it);
    const un = parts2[S.UNASSIGNED] || 0;
    const takers = Object.keys(it.shares).filter(k => it.shares[k] > 0);
    let hint = '';
    if (it.byUnit && it.qty > 1) {
      const used = Object.values(it.shares).reduce((s, n) => s + n, 0);
      hint = `${used} of ${it.qty} assigned`;
    } else if (takers.length > 1) hint = `Shared by ${takers.length} · ${fmt(Math.round(S.toCents(it.amount) / takers.length), cur)} per person`;
    return `<div class="item ${un ? 'unassigned' : ''}" data-item="${it.id}">
      <div class="head" data-act="edit-item" data-id="${it.id}"><span class="name">${esc(it.name)}${qtyLine(it, cur)}</span><span class="num">${fmt(S.toCents(it.amount), cur)}</span></div>
      ${it.byUnit && it.qty > 1 ? `<div class="units">${parts.map(pid => `<div class="row">${avatar(pid, 'sm')}<span class="grow small">${esc(pname(pid))}</span>
          <span class="stepper"><button data-act="unit-dec" data-item="${it.id}" data-pid="${pid}" aria-label="Less">−</button><span>${it.shares[pid] || 0}</span><button data-act="unit-inc" data-item="${it.id}" data-pid="${pid}" aria-label="More">+</button></span></div>`).join('')}</div>`
        : `<div class="chips">${parts.map(pid => chip(pid, it.shares[pid] > 0, 'toggle-share', `data-item="${it.id}"`)).join('')}${parts.length > 1 ? `<button class="chip plain ${parts.every(p => it.shares[p] > 0) ? 'on' : ''}" data-act="share-all" data-item="${it.id}">Everyone</button>` : ''}</div>`}
      <div class="row between small muted" style="margin-top:6px"><span>${hint || (un ? '<span class="bad">Tap who had this</span>' : '')}</span>${it.qty > 1 ? `<button class="btn sm ghost" data-act="toggle-units" data-item="${it.id}">${it.byUnit ? 'Split equally instead' : 'Split by units'}</button>` : ''}</div>
    </div>`;
  }).join('');

  const summary = parts.map(pid => {
    const p = split.people[pid];
    return `<div class="sumline"><span class="row">${avatar(pid, 'sm')}${esc(pname(pid))}${pid === d.payerId ? ' <span class="small muted">(paid)</span>' : ''}</span><span class="num">${fmt(p?.total || 0, cur)}</span></div>`;
  }).join('');

  const html = `
    ${d.hasPhoto ? `<div class="card" style="padding:8px"><img class="thumb" id="draftimg" alt="Receipt photo" data-act="zoom-photo"></div>` : ''}
    ${check}
    <div class="card">
      <div class="fields">
        <label class="field full"><span>Shop / restaurant</span><input type="text" data-f="merchant" value="${esc(d.merchant)}" placeholder="e.g. Hock Kee"></label>
        <label class="field"><span>Date</span><input type="date" data-f="date" value="${esc(d.date)}"></label>
        <label class="field"><span>Currency</span><select data-f="currency">${[...new Set([...CURRENCIES, cur])].map(c => `<option ${c === cur ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        ${state.groups.length ? `<label class="field full"><span>Group</span><select data-f="groupId"><option value="">None</option>${state.groups.map(g => `<option value="${g.id}" ${g.id === d.groupId ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>` : ''}
      </div>
    </div>
    <div class="card">
      <h2>Who was there?</h2>
      <div class="chips">${parts.map(pid => chip(pid, true, 'people')).join('')}<button class="chip dashed" data-act="people">${icon('plus', 'width=16 height=16')} Add friends</button></div>
    </div>
    <div class="card flush">
      <div class="row between" style="padding-right:12px"><h2>Items · Qty ${totalQty(d)}</h2><button class="btn sm ghost" data-act="add-item">${icon('plus', 'width=16 height=16')} Item</button></div>
      ${d.items.length ? '<p class="small muted" style="margin:2px 16px 4px">Tap who had each item.</p>' : ''}
      ${itemHtml || '<div class="empty">No items yet. Add them with “+ Item”.</div>'}
    </div>
    <div class="card">
      <h2>Tax, charges & discounts</h2>
      <p class="small muted" style="margin-top:0">Shared in proportion to what each person ordered.</p>
      ${d.adjustments.map(a => `<div class="adj-row"><input type="text" value="${esc(a.label)}" data-adj-label="${a.id}" aria-label="Label"><input type="text" inputmode="decimal" class="num" value="${a.amount.toFixed(2)}" data-adj-amount="${a.id}" aria-label="Amount"><button class="icon-btn" data-act="del-adj" data-id="${a.id}" aria-label="Remove">${icon('trash')}</button></div>`).join('')}
      <div class="btns"><button class="btn sm" data-act="add-adj" data-kind="tax" data-label="SST 6%">+ SST 6%</button><button class="btn sm" data-act="add-adj" data-kind="service_charge" data-label="Service charge 10%">+ Service 10%</button><button class="btn sm" data-act="add-adj" data-kind="other" data-label="">+ Other</button></div>
      <hr>
      <div class="sumline"><span>Items</span><span class="num">${fmt(itemSum, cur)}</span></div>
      <div class="sumline total"><span>Total</span><span class="num">${fmt(total, cur)}</span></div>
    </div>
    <div class="card">
      <h2>Paid by</h2>
      <div class="chips">${parts.map(pid => chip(pid, d.payerId === pid, 'payer')).join('')}</div>
    </div>
    <div class="card" id="summary">
      <h2>Split</h2>
      ${split.unassigned ? `<div class="banner warn">${fmt(split.unassigned, cur)} not assigned yet.<div class="btns" style="margin-top:8px"><button class="btn sm" data-act="assign-rest">Give the rest to ${esc(pname(d.payerId))}</button>${parts.length > 1 ? '<button class="btn sm" data-act="split-rest">Split the rest equally</button>' : ''}</div></div>` : ''}
      ${summary}
    </div>
    <div class="card"><label class="field"><span>Note (optional)</span><input type="text" data-f="note" value="${esc(d.note)}" placeholder="e.g. Ali's birthday dinner"></label></div>
    <div class="btns"><button class="btn" data-act="cancel-edit">Cancel</button><button class="btn primary" data-act="save-receipt">Save receipt</button></div>`;
  return {
    title: d.isNew ? 'New receipt' : 'Edit receipt', tab: 'new', html,
    back: d.isNew ? '#/new' : `#/r/${d.id}`,
    actions: `<button class="btn sm primary" data-act="save-receipt">Save</button>`,
    after: () => setPhoto('#draftimg', d.isNew ? 'draft' : d.id),
  };
}

async function setPhoto(sel, key) {
  const img = $(sel); if (!img) return;
  const blob = key === 'draft' ? state.draftPhoto : await db.get('photos', key);
  if (blob) img.src = URL.createObjectURL(blob); else img.closest('.card')?.remove();
}

function editItemSheet(id) {
  const d = state.draft;
  const it = d.items.find(i => i.id === id) || { id: null, name: '', qty: 1, amount: 0 };
  const dlg = sheet(`<h3>${it.id ? 'Edit item' : 'Add item'}</h3>
    <div class="fields">
      <label class="field full"><span>Name</span><input type="text" id="in-name" value="${esc(it.name)}" placeholder="e.g. Nasi lemak"></label>
      <label class="field"><span>Quantity</span><input type="number" id="in-qty" min="1" step="1" value="${it.qty}" inputmode="numeric"></label>
      <label class="field"><span>Line total (${esc(sym(d.currency))})</span><input type="text" id="in-amt" inputmode="decimal" value="${it.amount ? it.amount.toFixed(2) : ''}" placeholder="0.00"></label>
    </div>
    <p class="small muted">Line total is the price for all units on this line.</p>
    <div class="btns">${it.id ? '<button class="btn danger" id="in-del">Delete</button>' : ''}<button class="btn primary" id="in-save">${it.id ? 'Save' : 'Add'}</button></div>`);
  if (!it.id) setTimeout(() => dlg.querySelector('#in-name').focus(), 50);
  dlg.querySelector('#in-save').onclick = () => {
    const name = dlg.querySelector('#in-name').value.trim() || 'Item';
    const qty = Math.max(1, parseInt(dlg.querySelector('#in-qty').value, 10) || 1);
    const amount = parseAmount(dlg.querySelector('#in-amt').value);
    if (it.id) {
      Object.assign(it, { name, qty, amount });
      if (qty < 2) it.byUnit = false;
      if (it.byUnit) { let used = 0; for (const k of Object.keys(it.shares)) { it.shares[k] = Math.min(it.shares[k], qty - used); used += it.shares[k]; } }
    } else d.items.push({ id: uid(), name, qty, amount, shares: {}, byUnit: false });
    saveDraft(); dlg.close(); rerender();
  };
  dlg.querySelector('#in-del')?.addEventListener('click', () => { d.items = d.items.filter(i => i.id !== it.id); saveDraft(); dlg.close(); rerender(); });
}

function peopleSheet(onDone) {
  const d = state.draft;
  const draw = () => `<h3>Who was there?</h3>
    ${state.groups.length ? `<div class="small muted" style="margin-bottom:6px">Add a group</div><div class="chips" style="margin-bottom:12px">${state.groups.map(g => `<button class="chip plain" data-g="${g.id}">${icon('group', 'width=16 height=16')} ${esc(g.name)}</button>`).join('')}</div>` : ''}
    <div class="chips">${[ME, ...friends().map(f => f.id)].map(pid => `<button class="chip ${d.participants.includes(pid) ? 'on' : ''}" style="--c:${person(pid).color}" data-p="${pid}">${avatar(pid)}${esc(pname(pid))}</button>`).join('')}</div>
    <div class="row" style="margin-top:14px"><input type="text" id="nf" placeholder="New friend's name" class="grow"><button class="btn" id="nfb">Add</button></div>
    <button class="btn primary block" style="margin-top:14px" id="done">Done</button>`;
  const dlg = sheet(draw(), { onClose: () => { saveDraft(); onDone?.(); } });
  const inner = dlg.querySelector('.inner');
  const toggle = pid => {
    if (d.participants.includes(pid)) {
      if (d.participants.length === 1) return toast('At least one person is needed.');
      d.participants = d.participants.filter(x => x !== pid);
      for (const it of d.items) delete it.shares[pid];
      if (d.payerId === pid) d.payerId = d.participants[0];
    } else d.participants.push(pid);
  };
  const addNew = async () => {
    const name = inner.querySelector('#nf').value.trim();
    if (!name) return;
    const existing = friends().find(f => f.name.toLowerCase() === name.toLowerCase());
    const p = existing || newPerson(name);
    if (!existing) await putRecord('people', p);
    if (!d.participants.includes(p.id)) d.participants.push(p.id);
    redraw(); inner.querySelector('#nf').focus();
  };
  const redraw = () => { inner.innerHTML = draw(); bind(); };
  const bind = () => {
    inner.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { toggle(b.dataset.p); redraw(); });
    inner.querySelectorAll('[data-g]').forEach(b => b.onclick = () => { const g = state.groups.find(x => x.id === b.dataset.g); for (const m of g.members) if (!d.participants.includes(m) && !person(m).archived) d.participants.push(m); if (!d.groupId) d.groupId = g.id; redraw(); });
    inner.querySelector('#nfb').onclick = addNew;
    inner.querySelector('#nf').onkeydown = e => { if (e.key === 'Enter') addNew(); };
    inner.querySelector('#done').onclick = () => dlg.close();
  };
  bind();
}

async function saveReceipt() {
  const d = state.draft;
  if (!d.items.length) return toast('Add at least one item.');
  const split = S.splitReceipt(d);
  if (split.unassigned) { $('#summary')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return toast('Some items are not assigned to anyone yet.'); }
  if (!d.participants.includes(d.payerId)) d.payerId = d.participants[0];
  const { isNew, ...rec } = d;
  rec.updatedAt = Date.now();
  rec.merchant = rec.merchant.trim() || 'Receipt';
  if (isNew && state.draftPhoto && rec.hasPhoto) await db.put('photos', state.draftPhoto, rec.id);
  await putRecord('receipts', rec);
  await clearDraft();
  toast('Saved');
  go(`#/r/${rec.id}`);
}

// ----- receipt view -----
function receiptPage(id) {
  const r = state.receipts.find(x => x.id === id);
  if (!r) { setTimeout(() => go('#/receipts')); return null; }
  const split = S.splitReceipt(r);
  const cur = r.currency;
  const group = state.groups.find(g => g.id === r.groupId);
  const people = r.participants.map(pid => {
    const p = split.people[pid] || { items: 0, extra: 0, total: 0, lines: [] };
    const phone = person(pid).phone;
    return `<div class="person-sum"><details><summary class="row">${avatar(pid)}<div class="grow"><div>${esc(pname(pid))}</div><div class="small muted">${pid === r.payerId ? 'paid the bill' : pid === ME ? `you owe ${esc(pname(r.payerId))}` : `owes ${r.payerId === ME ? 'you' : esc(pname(r.payerId))}`}</div></div><div class="amt num">${fmt(p.total, cur)}</div></summary>
      <div class="lines">${p.lines.map(l => `<div class="sumline"><span>${esc(l.name)}${l.units ? ` ×${l.units}` : l.sharedWith > 1 ? ` (1/${l.sharedWith})` : ''}</span><span class="num">${fmt(l.amount, cur)}</span></div>`).join('')}
      ${p.extra ? `<div class="sumline"><span>Tax, charges & discounts</span><span class="num">${fmt(p.extra, cur)}</span></div>` : ''}
      ${pid !== ME ? `<button class="btn sm" style="margin-top:6px" data-act="share-person" data-id="${r.id}" data-pid="${pid}">${icon('share', 'width=16 height=16')} Send ${esc(pname(pid))} their share</button>` : ''}<button class="btn sm" style="margin-top:6px" data-act="image-person" data-id="${r.id}" data-pid="${pid}">${icon('gallery', 'width=16 height=16')} Image</button></div></details></div>`;
  }).join('');
  const html = `
    <div class="card">
      <div class="muted small">${fmtDate(r.date)}</div>
      <div class="big-amount num">${fmt(split.total, cur)}</div>
      <div class="row small muted">${avatar(r.payerId, 'sm')} Paid by ${esc(pname(r.payerId))}</div>
      ${r.note ? `<p class="small" style="margin-bottom:0">${esc(r.note)}</p>` : ''}
      <hr>
      <div class="row">${icon('group', 'width=20 height=20 style="flex:none;color:var(--ink-2)"')}
        ${state.groups.length ? `<select data-receipt-group="${r.id}" aria-label="Group" class="grow"><option value="">Not in a group</option>${state.groups.map(g => `<option value="${g.id}" ${g.id === r.groupId ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}<option value="__new">+ New group…</option></select>${group ? `<a class="btn sm" href="#/g/${group.id}">Open</a>` : ''}`
          : `<span class="grow small muted">Not in a group</span><button class="btn sm" data-act="receipt-new-group" data-id="${r.id}">Add to a group</button>`}
      </div>
    </div>
    <div class="card flush"><h2>Who owes what</h2>${people}</div>
    ${r.hasPhoto ? `<div class="card" style="padding:8px"><img class="thumb" id="rimg" alt="Receipt photo" data-act="zoom-photo"></div>` : ''}
    <div class="card flush"><h2>Items · Qty ${totalQty(r)}</h2><div class="list">${r.items.map(it => `<li><div class="grow"><div>${esc(it.name)}${qtyLine(it, cur)}</div><div class="small muted">${Object.entries(it.shares).filter(([, n]) => n > 0).map(([pid, n]) => esc(pname(pid)) + (it.byUnit && it.qty > 1 ? ` ×${n}` : '')).join(', ')}</div></div><div class="num">${fmt(S.toCents(it.amount), cur)}</div></li>`).join('')}
      ${r.adjustments.map(a => `<li class="small muted"><div class="grow">${esc(a.label)}</div><div class="num">${fmt(S.toCents(a.amount), cur)}</div></li>`).join('')}</div></div>
    <div class="btns"><button class="btn primary" data-act="share-receipt" data-id="${r.id}">${icon('share', 'width=20 height=20')} WhatsApp text</button><button class="btn primary" data-act="image-receipt" data-id="${r.id}">${icon('gallery', 'width=20 height=20')} Image</button></div>
    <div class="btns" style="margin-top:8px"><a class="btn" href="#/r/${r.id}/edit">${icon('edit', 'width=20 height=20')} Edit</a><button class="btn danger" data-act="delete-receipt" data-id="${r.id}">${icon('trash', 'width=20 height=20')} Delete</button></div>`;
  return { title: r.merchant || 'Receipt', back: '#/receipts', tab: 'receipts', html, after: () => setPhoto('#rimg', r.id) };
}

function receiptShareText(r) {
  const split = S.splitReceipt(r);
  const lines = [`🧾 *${r.merchant}* · ${fmtDate(r.date)}`, `Total ${fmt(split.total, r.currency)} · paid by ${r.payerId === ME ? myName() : pname(r.payerId)}`, ''];
  for (const pid of r.participants) {
    const p = split.people[pid]; if (!p) continue;
    lines.push(`*${pid === ME ? myName() : pname(pid)}*: ${fmt(p.total, r.currency)}`);
    for (const l of p.lines) lines.push(`  • ${l.name}${l.units ? ` ×${l.units}` : l.sharedWith > 1 ? ` (shared)` : ''}`);
  }
  lines.push('', '_Tax, service charge & discounts split by what each person ordered._');
  return lines.join('\n');
}
function personShareText(r, pid) {
  const p = S.splitReceipt(r).people[pid];
  const lines = [`Hi ${pname(pid)}! Your share for *${r.merchant}* (${fmtDate(r.date)}):`, ''];
  for (const l of p.lines) lines.push(`• ${l.name}${l.units ? ` ×${l.units}` : l.sharedWith > 1 ? ` (shared by ${l.sharedWith})` : ''}: ${fmt(l.amount, r.currency)}`);
  if (p.extra) lines.push(`• Tax, charges & discounts: ${fmt(p.extra, r.currency)}`);
  lines.push('', `*Total: ${fmt(p.total, r.currency)}*`);
  if (r.payerId === ME) lines.push('Please pay me when you can 🙏');
  else if (r.payerId !== pid) lines.push(`Please pay ${pname(r.payerId)} 🙏`);
  return lines.join('\n');
}
function waNumber(phone) {
  let n = String(phone || '').replace(/[^\d+]/g, '');
  if (!n) return '';
  if (n.startsWith('+')) return n.slice(1);
  if (n.startsWith('00')) return n.slice(2);
  if (n.startsWith('0')) return (state.settings.countryCode || '60') + n.slice(1);
  return n;
}
async function shareText(text, phone) {
  const num = waNumber(phone);
  if (num) { window.open(`https://wa.me/${num}?text=${encodeURIComponent(text)}`, '_blank'); return; }
  if (navigator.share) {
    try { await navigator.share({ text }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
}

// ----- friends -----
function friendsPage() {
  const bal = balances();
  const list = friends();
  const archived = friends(true).filter(f => f.archived);
  const row = f => { const b = S.balanceWith(bal, ME, f.id); const v = Object.values(b)[0] || 0;
    return `<a href="#/f/${f.id}">${avatar(f.id)}<div class="grow"><div class="ellipsis">${esc(f.name)}</div><div class="small muted">${v > 0 ? 'owes you' : v < 0 ? 'you owe' : 'settled up'}</div></div><div class="amt num ${v > 0 ? 'good' : v < 0 ? 'bad' : 'muted'}">${Object.keys(b).length ? Object.entries(b).map(([c, x]) => fmt(Math.abs(x), c)).join('<br>') : ''}</div></a>`; };
  const html = `
    <div class="card flush">${list.length ? `<div class="list">${list.map(row).join('')}</div>` : '<div class="empty">No friends yet. Add them here or while splitting a receipt.</div>'}</div>
    <div class="btns"><button class="btn primary" data-act="new-friend">${icon('plus', 'width=20 height=20')} Add friend</button><a class="btn" href="#/groups">${icon('group', 'width=20 height=20')} Groups</a></div>
    ${archived.length ? `<div class="card flush" style="margin-top:16px"><h2>Archived</h2><div class="list">${archived.map(row).join('')}</div></div>` : ''}`;
  return { title: 'Friends', tab: 'friends', html };
}

function friendSheet(f) {
  const dlg = sheet(`<h3>${f ? 'Edit friend' : 'Add friend'}</h3>
    <div class="stack">
      <label class="field"><span>Name</span><input type="text" id="fn" value="${esc(f?.name || '')}"></label>
      <label class="field"><span>WhatsApp number (optional)</span><input type="tel" id="fp" value="${esc(f?.phone || '')}" placeholder="e.g. 012-345 6789"></label>
      ${f ? `<div class="small muted">Colour</div><div class="swatches">${PERSON_COLORS.map(c => `<button class="swatch ${c === f.color ? 'on' : ''}" style="background:${c}" data-c="${c}" aria-label="Colour"></button>`).join('')}</div>` : ''}
    </div>
    <div class="btns" style="margin-top:14px">${f ? `<button class="btn danger" id="fd">${isReferenced(f.id) ? (f.archived ? 'Unarchive' : 'Archive') : 'Delete'}</button>` : ''}<button class="btn primary" id="fs">Save</button></div>`);
  let color = f?.color;
  dlg.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { color = b.dataset.c; dlg.querySelectorAll('[data-c]').forEach(x => x.classList.toggle('on', x === b)); });
  if (!f) setTimeout(() => dlg.querySelector('#fn').focus(), 50);
  dlg.querySelector('#fs').onclick = async () => {
    const name = dlg.querySelector('#fn').value.trim();
    if (!name) return toast('Enter a name.');
    const rec = f ? { ...f, name, phone: dlg.querySelector('#fp').value.trim(), color } : newPerson(name, dlg.querySelector('#fp').value);
    await putRecord('people', rec);
    dlg.close(); rerender();
  };
  dlg.querySelector('#fd')?.addEventListener('click', async () => {
    if (isReferenced(f.id)) { await putRecord('people', { ...f, archived: !f.archived }); dlg.close(); toast(f.archived ? 'Unarchived' : 'Archived: hidden from pickers, history kept'); rerender(); return; }
    dlg.close();
    if (await confirmSheet(`Delete ${f.name}?`, 'They are not on any receipt or payment.')) {
      await delRecord('people', f.id);
      for (const g of state.groups.filter(g => g.members.includes(f.id))) await putRecord('groups', { ...g, members: g.members.filter(m => m !== f.id) });
      go('#/friends');
    }
  });
}
const isReferenced = id => state.receipts.some(r => r.participants.includes(id) || r.payerId === id) || state.payments.some(p => p.from === id || p.to === id);

function friendPage(id) {
  const f = state.people.find(p => p.id === id && p.id !== ME);
  if (!f) { setTimeout(() => go('#/friends')); return null; }
  const bal = S.balanceWith(balances(), ME, id);
  const ev = S.ledger(state.receipts, state.payments, ME, id).reverse();
  const curs = Object.keys(bal);
  const balHtml = curs.length ? curs.map(c => `<div class="big-amount num ${bal[c] > 0 ? 'good' : 'bad'}">${fmt(Math.abs(bal[c]), c)}</div><div class="muted">${bal[c] > 0 ? `${esc(f.name)} owes you` : `You owe ${esc(f.name)}`}</div>`).join('<hr>')
    : `<div class="big-amount">Settled up</div><div class="muted">Nothing owed either way.</div>`;
  const evHtml = ev.map(e => e.type === 'receipt'
    ? `<a href="#/r/${e.receipt.id}"><div class="grow"><div class="ellipsis">${esc(e.receipt.merchant)}</div><div class="small muted">${fmtDate(e.date)} · ${e.cents > 0 ? `${esc(f.name)}'s share` : 'your share'}</div></div><div class="amt num ${e.cents > 0 ? 'good' : 'bad'}">${fmt(e.cents, e.currency, true)}</div></a>`
    : `<li data-act="payment-menu" data-id="${e.payment.id}" style="cursor:pointer"><div class="grow"><div>💸 ${e.cents < 0 ? `${esc(f.name)} paid you` : `You paid ${esc(f.name)}`}</div><div class="small muted">${fmtDate(e.date)}${e.payment.note ? ' · ' + esc(e.payment.note) : ''}</div></div><div class="amt num">${fmt(e.cents, e.currency, true)}</div></li>`).join('');
  const owesMe = curs.some(c => bal[c] > 0);
  const html = `
    <div class="card"><div class="row" style="margin-bottom:10px">${avatar(id)}<div class="grow"><strong>${esc(f.name)}</strong>${f.phone ? `<div class="small muted">${esc(f.phone)}</div>` : ''}</div></div>${balHtml}</div>
    <div class="btns">
      ${curs.length ? `<button class="btn primary" data-act="settle" data-id="${id}">Mark as paid</button>` : ''}
      <button class="btn" data-act="record-payment" data-id="${id}">Record payment</button>
    </div>
    <div class="btns" style="margin-top:8px">${owesMe ? `<button class="btn" data-act="remind" data-id="${id}">${icon('share', 'width=20 height=20')} WhatsApp reminder</button>` : ''}${curs.length ? `<button class="btn" data-act="image-friend" data-id="${id}">${icon('gallery', 'width=20 height=20')} Statement image</button>` : ''}</div>
    <div class="card flush"><h2>History</h2>${ev.length ? `<div class="list">${evHtml}</div>` : '<div class="empty">Nothing yet.</div>'}</div>`;
  return { title: f.name, back: '#/friends', tab: 'friends', html, actions: `<button class="icon-btn" data-act="edit-friend" data-id="${id}" aria-label="Edit">${icon('edit')}</button>` };
}

function paymentSheet(fid, preset) {
  const f = person(fid);
  const bal = S.balanceWith(balances(), ME, fid);
  const cur0 = preset?.currency || Object.keys(bal)[0] || state.settings.currency;
  const owes = (bal[cur0] || 0) >= 0;
  const dlg = sheet(`<h3>Record payment</h3>
    <div class="stack">
      <div class="seg" id="dir"><button data-d="in" class="${owes ? 'on' : ''}">${esc(f.name)} paid me</button><button data-d="out" class="${owes ? '' : 'on'}">I paid ${esc(f.name)}</button></div>
      <div class="fields">
        <label class="field"><span>Amount</span><input type="text" inputmode="decimal" id="pa" value="${bal[cur0] ? (Math.abs(bal[cur0]) / 100).toFixed(2) : ''}" placeholder="0.00"></label>
        <label class="field"><span>Currency</span><select id="pc">${[...new Set([cur0, ...CURRENCIES])].map(c => `<option ${c === cur0 ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        <label class="field"><span>Date</span><input type="date" id="pd" value="${todayISO()}"></label>
        <label class="field"><span>Note</span><input type="text" id="pn" placeholder="e.g. DuitNow"></label>
      </div>
      <p class="small muted" style="margin:0">Partial payments are fine. The balance just goes down.</p>
    </div>
    <button class="btn primary block" style="margin-top:14px" id="ps">Save payment</button>`);
  let dir = owes ? 'in' : 'out';
  dlg.querySelectorAll('[data-d]').forEach(b => b.onclick = () => { dir = b.dataset.d; dlg.querySelectorAll('[data-d]').forEach(x => x.classList.toggle('on', x === b)); });
  dlg.querySelector('#pc').onchange = e => { const v = bal[e.target.value]; dlg.querySelector('#pa').value = v ? (Math.abs(v) / 100).toFixed(2) : ''; };
  dlg.querySelector('#ps').onclick = async () => {
    const amount = parseAmount(dlg.querySelector('#pa').value);
    if (amount <= 0) return toast('Enter an amount.');
    await putRecord('payments', { id: uid(), from: dir === 'in' ? fid : ME, to: dir === 'in' ? ME : fid, amount, currency: dlg.querySelector('#pc').value, date: dlg.querySelector('#pd').value || todayISO(), note: dlg.querySelector('#pn').value.trim(), createdAt: Date.now() });
    dlg.close(); toast('Payment saved'); rerender();
  };
}

async function settle(fid) {
  const bal = S.balanceWith(balances(), ME, fid);
  const f = person(fid);
  const desc = Object.entries(bal).map(([c, v]) => v > 0 ? `${f.name} paid you ${fmt(v, c)}` : `you paid ${f.name} ${fmt(-v, c)}`).join(' and ');
  if (!(await confirmSheet('Mark as paid?', `This records that ${desc}.`, 'Mark as paid', false))) return;
  for (const [c, v] of Object.entries(bal)) {
    await putRecord('payments', { id: uid(), from: v > 0 ? fid : ME, to: v > 0 ? ME : fid, amount: Math.abs(v) / 100, currency: c, date: todayISO(), note: 'Settled up', createdAt: Date.now() });
  }
  toast(`Settled up with ${f.name}`); rerender();
}

function reminderText(fid) {
  const f = person(fid);
  const ev = S.ledger(state.receipts, state.payments, ME, fid);
  const bal = S.balanceWith(balances(), ME, fid);
  const lines = [`Hi ${f.name}! Here's what's still owing 😊`, ''];
  for (const [c, v] of Object.entries(bal)) {
    if (v <= 0) continue;
    for (const e of S.outstanding(ev, c)) {
      if (e.type === 'receipt') lines.push(`• ${fmtDate(e.date)} · ${e.receipt.merchant}: ${fmt(e.cents, c)}`);
      else lines.push(`• ${fmtDate(e.date)} · ${e.cents < 0 ? 'Paid' : 'I paid you'}: ${fmt(e.cents, c, true)}`);
    }
    lines.push('', `*Total: ${fmt(v, c)}*`, '');
  }
  lines.push('Thank you! 🙏');
  return lines.join('\n');
}

// ----- groups -----
function groupsPage() {
  const html = `
    <div class="card flush">${state.groups.length ? `<div class="list">${state.groups.map(g => `<a href="#/g/${g.id}"><span class="avatar" style="background:var(--surface-2);color:var(--ink-2)">${icon('group', 'width=20 height=20')}</span><div class="grow"><div>${esc(g.name)}</div><div class="small muted ellipsis">${g.members.map(pname).join(', ')}</div></div></a>`).join('')}</div>`
      : '<div class="empty">Groups let you add everyone at once, e.g. “Housemates” or “Penang trip”.</div>'}</div>
    <button class="btn primary block" data-act="new-group">${icon('plus', 'width=20 height=20')} New group</button>`;
  return { title: 'Groups', back: '#/friends', tab: 'friends', html };
}
function groupSheet(g, onCreated) {
  const sel = new Set(g?.members || [ME]);
  const dlg = sheet(`<h3>${g ? 'Edit group' : 'New group'}</h3>
    <label class="field"><span>Name</span><input type="text" id="gn" value="${esc(g?.name || '')}" placeholder="e.g. Housemates"></label>
    <div class="small muted" style="margin:12px 0 6px">Members</div>
    <div class="chips">${[ME, ...friends().map(f => f.id)].map(pid => `<button class="chip ${sel.has(pid) ? 'on' : ''}" style="--c:${person(pid).color}" data-p="${pid}">${avatar(pid)}${esc(pname(pid))}</button>`).join('')}</div>
    ${friends().length ? '' : '<p class="small muted">Add friends first on the Friends tab.</p>'}
    <div class="btns" style="margin-top:14px">${g ? '<button class="btn danger" id="gd">Delete</button>' : ''}<button class="btn primary" id="gs">Save</button></div>`);
  dlg.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { const p = b.dataset.p; sel.has(p) ? sel.delete(p) : sel.add(p); b.classList.toggle('on', sel.has(p)); });
  dlg.querySelector('#gs').onclick = async () => {
    const name = dlg.querySelector('#gn').value.trim();
    if (!name) return toast('Enter a group name.');
    const rec = { ...(g || { id: uid(), createdAt: Date.now() }), name, members: [...sel] };
    await putRecord('groups', rec);
    dlg.close(); if (onCreated) await onCreated(rec); else if (g) rerender(); else go(`#/g/${rec.id}`);
  };
  dlg.querySelector('#gd')?.addEventListener('click', async () => {
    dlg.close();
    if (await confirmSheet(`Delete “${g.name}”?`, 'Receipts in this group are kept.')) {
      await delRecord('groups', g.id);
      for (const r of state.receipts.filter(r => r.groupId === g.id)) await putRecord('receipts', { ...r, groupId: '' });
      go('#/groups');
    }
  });
}
function groupPage(id) {
  const g = state.groups.find(x => x.id === id);
  if (!g) { setTimeout(() => go('#/groups')); return null; }
  const rs = state.receipts.filter(r => r.groupId === id).sort(byDateDesc);
  const spend = {};
  for (const r of rs) for (const [pid, p] of Object.entries(S.splitReceipt(r).people)) { spend[pid] ||= {}; spend[pid][r.currency] = (spend[pid][r.currency] || 0) + p.total; }
  const bal = balances();
  const html = `
    <div class="card flush"><h2>Members</h2><div class="list">${g.members.map(pid => {
      const b = pid === ME ? {} : S.balanceWith(bal, ME, pid); const v = Object.values(b)[0] || 0;
      return `<${pid === ME ? 'li' : `a href="#/f/${pid}"`}>${avatar(pid)}<div class="grow"><div>${esc(pname(pid))}</div><div class="small muted">Spent ${fmtMulti(spend[pid] || {})} in this group</div></div><div class="amt num small ${v > 0 ? 'good' : v < 0 ? 'bad' : 'muted'}">${pid === ME ? '' : v ? `${v > 0 ? 'owes you' : 'you owe'}<br>${fmt(Math.abs(v), Object.keys(b)[0])}` : 'settled'}</div></${pid === ME ? 'li' : 'a'}>`;
    }).join('')}</div></div>
    <div class="btns"><button class="btn primary" data-act="group-receipt" data-id="${id}">${icon('camera', 'width=20 height=20')} New receipt</button><button class="btn" data-act="group-add-existing" data-id="${id}">${icon('plus', 'width=20 height=20')} Add existing</button></div>
    ${rs.length ? `<button class="btn block" style="margin-top:8px" data-act="report" data-id="${id}">${icon('gallery', 'width=20 height=20')} Report image</button>` : ''}
    <div class="card flush"><h2>Receipts</h2>${rs.length ? `<div class="list">${rs.map(receiptRow).join('')}</div>` : '<div class="empty">No receipts in this group yet.</div>'}</div>`;
  return { title: g.name, back: '#/groups', tab: 'friends', html, actions: `<button class="icon-btn" data-act="edit-group" data-id="${id}" aria-label="Edit">${icon('edit')}</button>` };
}

async function setReceiptGroup(rid, gid) {
  const r = state.receipts.find(x => x.id === rid);
  await putRecord('receipts', { ...r, groupId: gid });
  const g = state.groups.find(x => x.id === gid);
  toast(g ? `Added to ${g.name}` : 'Removed from group');
  rerender();
}
function newGroupForReceipt(rid) {
  const r = state.receipts.find(x => x.id === rid);
  // Start the new group with the people from this receipt.
  groupSheet(null, rec => setReceiptGroup(rid, rec.id));
  const dlg = document.querySelector('dialog.sheet:last-of-type');
  dlg?.querySelectorAll('[data-p]').forEach(b => { if (r.participants.includes(b.dataset.p) && !b.classList.contains('on')) b.click(); });
}
function addExistingSheet(gid) {
  const g = state.groups.find(x => x.id === gid);
  const list = state.receipts.filter(r => r.groupId !== gid).sort(byDateDesc);
  if (!list.length) return toast('All your receipts are already in this group.');
  const sel = new Set();
  const dlg = sheet(`<h3>Add receipts to ${esc(g.name)}</h3>
    <div class="list" style="max-height:50vh;overflow:auto;margin:0 -16px">${list.map(r => {
      const other = state.groups.find(x => x.id === r.groupId);
      return `<li data-r="${r.id}" style="cursor:pointer"><input type="checkbox" style="width:22px;height:22px;min-height:0;flex:none;accent-color:var(--accent)" tabindex="-1"><div class="grow"><div class="ellipsis">${esc(r.merchant)}</div><div class="small muted">${fmtDate(r.date)} · ${r.participants.map(pname).map(esc).join(', ')}${other ? ` · <span class="bad">moves from ${esc(other.name)}</span>` : ''}</div></div><div class="amt num small">${fmt(S.receiptTotal(r), r.currency)}</div></li>`;
    }).join('')}</div>
    <label class="row small" style="margin-top:12px"><input type="checkbox" id="addm" checked style="width:auto;min-height:0;accent-color:var(--accent)"> Also add the people on these receipts to the group</label>
    <button class="btn primary block" style="margin-top:12px" id="ax" disabled>Add receipts</button>`);
  const btn = dlg.querySelector('#ax');
  dlg.querySelectorAll('[data-r]').forEach(li => li.onclick = () => {
    const id = li.dataset.r; sel.has(id) ? sel.delete(id) : sel.add(id);
    li.querySelector('input').checked = sel.has(id);
    btn.disabled = !sel.size; btn.textContent = sel.size ? `Add ${sel.size} receipt${sel.size > 1 ? 's' : ''}` : 'Add receipts';
  });
  btn.onclick = async () => {
    const members = new Set(g.members);
    for (const id of sel) {
      const r = state.receipts.find(x => x.id === id);
      await putRecord('receipts', { ...r, groupId: gid });
      if (dlg.querySelector('#addm').checked) r.participants.forEach(p => members.add(p));
    }
    if (members.size !== g.members.length) await putRecord('groups', { ...g, members: [...members] });
    dlg.close(); toast(`Added ${sel.size} receipt${sel.size > 1 ? 's' : ''}`); rerender();
  };
}

// ----- image export -----
const imgName = id => (id === ME ? (state.settings.myName || 'Me') : pname(id));
function shareLineLabel(l) { return `${l.name}${l.units ? ` ×${l.units}` : l.sharedWith > 1 ? ` (1/${l.sharedWith})` : ''}`; }

// Draws a clean, receipt-style summary card and returns a PNG blob.
async function makeImage({ title, subtitle, big, bigNote, sections, footer }) {
  const W = 1080, P = 64, accent = state.settings.accent;
  const F = (w, px) => `${w} ${px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const ink = '#1b1f1d', ink2 = '#5d6661', line = '#e3e6e2';
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const fit = (text, max) => { text = String(text); if (ctx.measureText(text).width <= max) return text; while (text.length > 1 && ctx.measureText(text + '…').width > max) text = text.slice(0, -1); return text + '…'; };
  const ops = []; let y = 0;
  const block = (h, fn) => { const top = y; ops.push(() => fn(top)); y += h; };

  block(bigNote ? 340 : 300, t => {
    const grad = ctx.createLinearGradient(0, t, W, t + 340);
    grad.addColorStop(0, accent); grad.addColorStop(1, state.settings.style === 'lively' && LIVELY[accent] ? LIVELY[accent] : accent);
    ctx.fillStyle = grad; ctx.fillRect(0, t, W, bigNote ? 340 : 300);
    ctx.fillStyle = '#fff';
    ctx.font = F(700, 54); ctx.fillText(fit(title, W - 2 * P), P, t + 96);
    ctx.globalAlpha = 0.9; ctx.font = F(500, 32); ctx.fillText(fit(subtitle, W - 2 * P), P, t + 146); ctx.globalAlpha = 1;
    ctx.font = F(800, 80); ctx.fillText(big, P, t + 250);
    if (bigNote) { ctx.globalAlpha = 0.9; ctx.font = F(500, 32); ctx.fillText(fit(bigNote, W - 2 * P), P, t + 305); ctx.globalAlpha = 1; }
  });
  y += 24;
  for (const s of sections) {
    block(s.heading ? 84 : 20, t => {
      if (!s.heading) return;
      let x = P;
      if (s.color) {
        ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(P + 28, t + 46, 28, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = F(700, 24); ctx.textAlign = 'center'; ctx.fillText(initials(s.heading), P + 28, t + 55); ctx.textAlign = 'left';
        x = P + 76;
      }
      ctx.font = F(700, 38); ctx.textAlign = 'right'; ctx.fillStyle = ink;
      const amtW = s.amount ? ctx.measureText(s.amount).width : 0;
      if (s.amount) ctx.fillText(s.amount, W - P, t + 59);
      ctx.textAlign = 'left';
      ctx.font = F(650, 38); const name = fit(s.heading, W - P - x - amtW - 140); ctx.fillText(name, x, t + 59);
      if (s.note) { const nx = x + ctx.measureText(name).width + 14; ctx.font = F(500, 26); ctx.fillStyle = ink2; ctx.fillText(s.note, nx, t + 59); }
    });
    for (const [l, r, strong] of s.lines) block(48, t => {
      ctx.fillStyle = strong ? ink : ink2;
      ctx.font = F(strong ? 650 : 400, 30);
      ctx.textAlign = 'right'; const rw = ctx.measureText(r).width; ctx.fillText(r, W - P, t + 34);
      ctx.textAlign = 'left'; ctx.fillText(fit(l, W - 2 * P - rw - 110 - (s.color ? 76 : 0)), P + (s.color ? 76 : 0), t + 34);
    });
    block(36, t => { ctx.strokeStyle = line; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(P, t + 18); ctx.lineTo(W - P, t + 18); ctx.stroke(); });
  }
  block(footer ? 130 : 90, t => {
    ctx.fillStyle = ink2; ctx.font = F(400, 26);
    let yy = t + 40;
    if (footer) { ctx.fillText(fit(footer, W - 2 * P), P, yy); yy += 46; }
    ctx.fillStyle = accent; ctx.font = F(650, 26); ctx.fillText('Split Receipts', P, yy);
  });

  c.width = W; c.height = y;
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, y);
  ctx.textBaseline = 'alphabetic';
  for (const op of ops) op();
  return new Promise(res => c.toBlob(res, 'image/png'));
}

function receiptImageSpec(r) {
  const split = S.splitReceipt(r);
  const cur = r.currency;
  const sections = r.participants.filter(pid => split.people[pid]).map(pid => {
    const p = split.people[pid];
    return { heading: imgName(pid), color: person(pid).color, amount: fmt(p.total, cur), note: pid === r.payerId ? 'paid' : '',
      lines: [...p.lines.map(l => [shareLineLabel(l), fmt(l.amount, cur)]), ...(p.extra ? [['Tax, charges & discounts', fmt(p.extra, cur)]] : [])] };
  });
  sections.push({ heading: `Receipt · Qty ${totalQty(r)}`, lines: [
    ['Items', fmt(S.itemsTotal(r), cur)], ...r.adjustments.map(a => [a.label, fmt(S.toCents(a.amount), cur)]), ['Total', fmt(split.total, cur), true]] });
  return { title: r.merchant, subtitle: `${fmtDate(r.date)} · Paid by ${imgName(r.payerId)}`, big: fmt(split.total, cur), sections,
    footer: 'Tax, service charge & discounts shared by what each person ordered.' };
}
function personImageSpec(r, pid) {
  const p = S.splitReceipt(r).people[pid];
  const cur = r.currency;
  return { title: r.merchant, subtitle: fmtDate(r.date), big: fmt(p.total, cur),
    bigNote: `${imgName(pid)}'s share${r.payerId !== pid ? ` · pay ${imgName(r.payerId)}` : ''}`,
    sections: [{ heading: imgName(pid), color: person(pid).color, amount: fmt(p.total, cur),
      lines: [...p.lines.map(l => [shareLineLabel(l), fmt(l.amount, cur)]), ...(p.extra ? [['Tax, charges & discounts', fmt(p.extra, cur)]] : [])] }],
    footer: 'Tax, service charge & discounts shared by what each person ordered.' };
}
function friendImageSpec(fid) {
  const f = person(fid);
  const bal = S.balanceWith(balances(), ME, fid);
  const ev = S.ledger(state.receipts, state.payments, ME, fid);
  const curs = Object.keys(bal);
  const sections = curs.map(c => ({
    heading: curs.length > 1 ? c : 'Still owing', lines: [
      ...S.outstanding(ev, c).map(e => [`${fmtDate(e.date)} · ${e.type === 'receipt' ? e.receipt.merchant : (e.cents < 0 ? 'Payment' : 'Paid to you')}`, fmt(bal[c] > 0 ? e.cents : -e.cents, c, e.type === 'payment')]),
      ['Balance', fmt(Math.abs(bal[c]), c), true]] }));
  const first = curs[0];
  return { title: f.name, subtitle: `Statement · ${fmtDate(todayISO())}`, big: first ? fmt(Math.abs(bal[first]), first) : 'Settled up',
    bigNote: first ? (bal[first] > 0 ? `${f.name} owes ${imgName(ME)}` : `${imgName(ME)} owes ${f.name}`) : 'Nothing owed either way',
    sections: sections.length ? sections : [{ heading: '', lines: [] }] };
}

async function imageSheet(spec, filename, text) {
  const blob = await makeImage(spec);
  const url = URL.createObjectURL(blob);
  const file = new File([blob], filename, { type: 'image/png' });
  const canShare = !!navigator.canShare?.({ files: [file] });
  const dlg = sheet(`<h3>Image</h3>
    <img src="${url}" alt="Split summary image" style="width:100%;max-height:58vh;object-fit:contain;border-radius:12px;background:#fff;border:1px solid var(--line)">
    <p class="small muted" style="margin:8px 0">Tip: you can also long-press the image to save or copy it.</p>
    <div class="btns"><button class="btn" id="isave">Save image</button>${canShare ? '<button class="btn primary" id="ishare">Share</button>' : ''}</div>`,
  { onClose: () => setTimeout(() => URL.revokeObjectURL(url), 1000) });
  dlg.querySelector('#isave').onclick = () => download(filename, blob);
  dlg.querySelector('#ishare')?.addEventListener('click', async () => {
    try { await navigator.share({ files: [file], text }); } catch (e) { if (e.name !== 'AbortError') download(filename, blob); }
  });
}
// ----- group report (debts per person, one line per receipt, no items) -----
function reportData(groupId, range, who) {
  const rs = state.receipts.filter(r => (!groupId || r.groupId === groupId) && (!range.from || (r.date || '') >= range.from) && (!range.to || (r.date || '9') <= range.to))
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.createdAt || 0) - (b.createdAt || 0));
  const pairs = new Map(); // "from|to|cur" -> {from, to, cur, total, lines}
  for (const r of rs) for (const d of S.receiptDebts(r)) {
    if (who && d.from !== who) continue;
    const key = `${d.from}|${d.to}|${d.currency}`;
    if (!pairs.has(key)) pairs.set(key, { from: d.from, to: d.to, cur: d.currency, total: 0, lines: [] });
    const p = pairs.get(key);
    p.total += d.cents;
    p.lines.push({ date: r.date, merchant: r.merchant, cents: d.cents });
  }
  const list = [...pairs.values()];
  // Group by debtor (me last), and within a debtor put what they owe me first.
  list.sort((a, b) => (a.from === ME) - (b.from === ME) || pname(a.from).localeCompare(pname(b.from)) || (b.to === ME) - (a.to === ME) || pname(a.to).localeCompare(pname(b.to)));
  return { receipts: rs, pairs: list };
}
const shortDate = iso => { const d = new Date(iso + 'T00:00:00'); return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };

function reportImageSpec(groupId, range, who) {
  const { receipts, pairs } = reportData(groupId, range, who);
  const g = state.groups.find(x => x.id === groupId);
  const totals = {};
  for (const p of pairs) totals[p.cur] = (totals[p.cur] || 0) + p.total;
  const single = who && pairs.length === 1 ? pairs[0] : null;
  return {
    title: g ? g.name : who ? `${imgName(who)}` : 'All receipts',
    subtitle: `${rangeLabel(range, receipts)}${g && who ? ` · ${imgName(who)}` : ''}`,
    big: pairs.length ? fmtMulti(totals) : 'Nothing owed',
    bigNote: single ? `${imgName(single.from)} owes ${imgName(single.to)} · ${single.lines.length} receipt${single.lines.length > 1 ? 's' : ''}`
      : `Total owed · ${receipts.length} receipt${receipts.length === 1 ? '' : 's'}`,
    sections: pairs.length ? pairs.map(p => ({
      heading: imgName(p.from), color: person(p.from).color, amount: fmt(p.total, p.cur),
      note: pairs.every(x => x.to === ME) ? '' : `owes ${imgName(p.to)}`,
      lines: p.lines.map(l => [`${shortDate(l.date)} · ${l.merchant}`, fmt(l.cents, p.cur)]),
    })) : [{ heading: '', lines: [] }],
    footer: 'Each amount is that person’s share of the receipt, incl. tax & charges.',
  };
}
function reportText(groupId, range, who) {
  const { receipts, pairs } = reportData(groupId, range, who);
  const g = state.groups.find(x => x.id === groupId);
  const lines = [`📊 *${g ? g.name : 'All receipts'}* · ${rangeLabel(range, receipts)}`, ''];
  for (const p of pairs) {
    lines.push(`*${imgName(p.from)}* owes ${imgName(p.to)}: *${fmt(p.total, p.cur)}*`);
    for (const l of p.lines) lines.push(`  • ${shortDate(l.date)} · ${l.merchant}: ${fmt(l.cents, p.cur)}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

function rangeLabel(range, receipts) {
  if (range.from || range.to) return `${range.from ? fmtDate(range.from) : 'Start'} – ${range.to ? fmtDate(range.to) : 'today'}`;
  const ds = receipts.map(r => r.date).filter(Boolean).sort();
  return ds.length ? `All receipts · ${fmtDate(ds[0])} – ${fmtDate(ds[ds.length - 1])}` : 'All receipts';
}

function reportSheet(groupId) {
  let sel = { group: groupId, period: 'all', from: '', to: '', who: '' };
  let blob, url;
  const dlg = sheet(`<h3>Report</h3>
    <div class="fields">
      <label class="field full"><span>Group</span><select id="rpg"><option value="">All receipts</option>${state.groups.map(g => `<option value="${g.id}" ${g.id === groupId ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Period</span><select id="rpp">
        <option value="all">All receipts</option>
        <option value="custom">Custom dates…</option></select></label>
      <label class="field"><span>Show</span><select id="rpw"></select></label>
      <label class="field" id="rpf" hidden><span>From</span><input type="date" id="rpfrom"></label>
      <label class="field" id="rpt2" hidden><span>To</span><input type="date" id="rpto"></label>
    </div>
    <img id="rpi" alt="Report preview" style="width:100%;max-height:46vh;object-fit:contain;border-radius:12px;background:#fff;border:1px solid var(--line);margin-top:12px">
    <div class="btns" style="margin-top:12px"><button class="btn" id="rps">Save image</button><button class="btn" id="rpt">WhatsApp text</button><button class="btn primary" id="rpx" hidden>Share image</button></div>`,
  { onClose: () => url && URL.revokeObjectURL(url) });
  const $d = q => dlg.querySelector(q);
  const range = () => sel.period === 'custom' ? { from: sel.from, to: sel.to } : { from: '', to: '' };
  const draw = async () => {
    const custom = sel.period === 'custom';
    $d('#rpf').hidden = !custom; $d('#rpt2').hidden = !custom;
    const debtors = [...new Set(reportData(sel.group, range(), '').pairs.map(p => p.from))];
    if (!debtors.includes(sel.who)) sel.who = '';
    $d('#rpw').innerHTML = `<option value="">Everyone</option>${debtors.map(pid => `<option value="${pid}" ${pid === sel.who ? 'selected' : ''}>${esc(pname(pid))} only</option>`).join('')}`;
    blob = await makeImage(reportImageSpec(sel.group, range(), sel.who));
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(blob);
    $d('#rpi').src = url;
    $d('#rpx').hidden = !navigator.canShare?.({ files: [new File([blob], 'r.png', { type: 'image/png' })] });
  };
  const fname = () => { const r = range(); return `report-${slug(state.groups.find(g => g.id === sel.group)?.name || 'all')}${r.from || r.to ? `-${r.from || 'start'}-to-${r.to || 'now'}` : ''}${sel.who ? '-' + slug(pname(sel.who)) : ''}.png`; };
  $d('#rpg').onchange = e => { sel.group = e.target.value; draw(); };
  $d('#rpp').onchange = e => {
    sel.period = e.target.value;
    draw();
  };
  $d('#rpfrom').onchange = e => { sel.from = e.target.value; draw(); };
  $d('#rpto').onchange = e => { sel.to = e.target.value; draw(); };
  $d('#rpw').onchange = e => { sel.who = e.target.value; draw(); };
  $d('#rps').onclick = () => download(fname(), blob);
  $d('#rpt').onclick = () => shareText(reportText(sel.group, range(), sel.who), sel.who ? person(sel.who).phone : '');
  $d('#rpx').onclick = async () => {
    try { await navigator.share({ files: [new File([blob], fname(), { type: 'image/png' })], text: reportText(sel.group, range(), sel.who) }); }
    catch (e) { if (e.name !== 'AbortError') download(fname(), blob); }
  };
  draw();
}

const slug = s => String(s || 'receipt').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// ----- settings -----
function settingsPage() {
  const s = state.settings;
  const known = MODELS.some(([m]) => m === s.model);
  const html = `
    <div class="card stack">
      <h2>Receipt scanning</h2>
      <label class="field"><span>Gemini API key</span>
        <div class="row"><input type="password" id="key" value="${esc(s.apiKey)}" placeholder="Paste your key" autocomplete="off" class="grow"><button class="btn sm" data-act="toggle-key">Show</button></div></label>
      <div class="btns"><button class="btn sm primary" data-act="save-key">Save key</button><button class="btn sm" data-act="test-key">Test</button></div>
      <p class="small muted" style="margin:0">Get a free key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>. It stays on this phone and is only sent to Google when you scan.</p>
      <label class="field"><span>Model</span><select data-setting="model">${MODELS.map(([m, l]) => `<option value="${m}" ${m === s.model ? 'selected' : ''}>${l}</option>`).join('')}${known ? '' : `<option value="${esc(s.model)}" selected>${esc(s.model)}</option>`}<option value="__custom">Other…</option></select></label>
      <p class="small muted" style="margin:0">If the chosen model is busy, the app automatically tries the others.</p>
    </div>
    <div class="card stack">
      <h2>You</h2>
      <label class="field"><span>Your name (used in WhatsApp messages)</span><input type="text" data-setting="myName" value="${esc(s.myName)}" placeholder="e.g. Asyiqeen"></label>
      <div class="fields">
        <label class="field"><span>Default currency</span><select data-setting="currency">${CURRENCIES.map(c => `<option ${c === s.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        <label class="field"><span>Phone country code</span><input type="tel" data-setting="countryCode" value="${esc(s.countryCode)}" placeholder="60"></label>
      </div>
    </div>
    <div class="card stack">
      <h2>Appearance</h2>
      <div class="seg">${[['lively', 'Lively'], ['classic', 'Classic']].map(([v, l]) => `<button class="${s.style === v ? 'on' : ''}" data-act="style" data-v="${v}">${l}</button>`).join('')}</div>
      ${s.style === 'lively' ? `<label class="row small"><input type="checkbox" data-act="pattern" ${s.pattern !== false ? 'checked' : ''} style="width:20px;height:20px;min-height:0"> Background pattern</label>` : ''}
      <div class="seg">${['auto', 'light', 'dark'].map(t => `<button class="${s.theme === t ? 'on' : ''}" data-act="theme" data-v="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
      <div class="swatches">${(STYLES[s.style] || ACCENTS).map(c => `<button class="swatch ${c === s.accent ? 'on' : ''}" style="background:${c}" data-act="accent" data-v="${c}" aria-label="Accent colour"></button>`).join('')}</div>
    </div>
    <div class="card flush"><div class="list"><a href="#/groups">${icon('group', 'width=22 height=22')}<div class="grow">Groups</div><span class="muted">${state.groups.length}</span></a></div></div>
    <div class="card stack">
      <h2>Export & backup</h2>
      <p class="small muted" style="margin:0">Your data lives only on this phone. Back it up now and then, e.g. to Google Drive.</p>
      <div class="btns"><button class="btn sm" data-act="export-csv" data-kind="shares">CSV: who owes what</button><button class="btn sm" data-act="export-csv" data-kind="items">CSV: all items</button><button class="btn sm" data-act="export-csv" data-kind="ledger">CSV: debts & payments</button></div>
      <label class="row small"><input type="checkbox" id="withPhotos" checked style="width:auto;min-height:0"> Include receipt photos in backup</label>
      <div class="btns"><button class="btn sm primary" data-act="backup">Download backup</button><label class="btn sm">Restore backup<input type="file" accept="application/json,.json" data-restore hidden></label></div>
      <button class="btn sm danger" data-act="erase">Erase all data</button>
    </div>
    <p class="small muted" style="text-align:center">Split Receipts ${VERSION} · ${state.receipts.length} receipts · <span id="persist"></span></p>`;
  return {
    title: 'Settings', tab: 'settings', html,
    async after() { const p = await navigator.storage?.persisted?.(); const el = $('#persist'); if (el) el.textContent = p ? 'storage protected' : 'storage not yet protected'; },
  };
}

function download(name, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const csv = rows => '﻿' + rows.map(r => r.map(v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\n');
const money = c => (c / 100).toFixed(2);

function exportCSV(kind) {
  const rs = [...state.receipts].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  let rows;
  if (kind === 'items') {
    rows = [['Date', 'Shop', 'Item', 'Qty', 'Line total', 'Currency', 'Who', 'Person share']];
    for (const r of rs) for (const it of r.items) for (const [pid, c] of Object.entries(S.itemSplit(it))) rows.push([r.date, r.merchant, it.name, it.qty, it.amount.toFixed(2), r.currency, pid === S.UNASSIGNED ? '' : pname(pid), money(c)]);
  } else if (kind === 'shares') {
    rows = [['Date', 'Shop', 'Person', 'Items', 'Tax/charges/discounts', 'Total', 'Currency', 'Paid by', 'Receipt total']];
    for (const r of rs) { const sp = S.splitReceipt(r); for (const [pid, p] of Object.entries(sp.people)) rows.push([r.date, r.merchant, pname(pid), money(p.items), money(p.extra), money(p.total), r.currency, pname(r.payerId), money(sp.total)]); }
  } else {
    rows = [['Date', 'Type', 'Description', 'From', 'To', 'Amount', 'Currency']];
    const ev = [];
    for (const r of rs) for (const dd of S.receiptDebts(r)) ev.push([r.date, 'Owes', r.merchant, pname(dd.from), pname(dd.to), money(dd.cents), r.currency]);
    for (const p of state.payments) ev.push([p.date, 'Payment', p.note || '', pname(p.from), pname(p.to), p.amount.toFixed(2), p.currency]);
    ev.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    rows.push(...ev);
  }
  download(`split-receipts-${kind}-${todayISO()}.csv`, csv(rows), 'text/csv');
}

async function backup(withPhotos) {
  const photos = {};
  if (withPhotos) for (const key of await db.keys('photos')) {
    if (key === 'draft') continue;
    const b = await db.get('photos', key);
    photos[key] = 'data:' + (b.type || 'image/jpeg') + ';base64,' + await blobToBase64(b);
  }
  const { apiKey, ...settings } = state.settings;
  const data = { app: 'split-receipts', version: 1, exportedAt: new Date().toISOString(), people: state.people, groups: state.groups, receipts: state.receipts, payments: state.payments, settings, photos };
  download(`split-receipts-backup-${todayISO()}.json`, JSON.stringify(data), 'application/json');
}
async function restore(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast('That file is not a valid backup.'); }
  if (data?.app !== 'split-receipts') return toast('That file is not a Split Receipts backup.');
  if (!(await confirmSheet('Restore backup?', `This replaces everything on this phone with the backup from ${fmtDate((data.exportedAt || '').slice(0, 10))} (${data.receipts?.length || 0} receipts).`, 'Restore', true))) return;
  for (const s of ['people', 'groups', 'receipts', 'payments', 'photos']) await db.clear(s);
  for (const s of ['people', 'groups', 'receipts', 'payments']) for (const rec of data[s] || []) await db.put(s, rec);
  for (const [k, url] of Object.entries(data.photos || {})) await db.put('photos', await (await fetch(url)).blob(), k);
  state.settings = { ...state.settings, ...(data.settings || {}), apiKey: state.settings.apiKey };
  await saveSettings();
  await load(); applyTheme();
  toast('Backup restored'); go('#/');
}

// ---------- event handling ----------
const actions = {
  'manual': () => startDraft(null, false),
  'manual-photo': () => { state.scanError = null; startDraft(null, true); },
  'rescan': () => runScan(),
  'draft-continue': () => go('#/edit'),
  'draft-discard': async () => { await clearDraft(); rerender(); },
  'cancel-edit': async el => {
    const d = state.draft;
    if (d.isNew && d.items.length && !(await confirmSheet('Discard this receipt?', 'The scanned items will be lost.', 'Discard'))) return;
    const back = d.isNew ? '#/new' : `#/r/${d.id}`;
    await clearDraft(); go(back);
  },
  'toggle-share': el => { const it = itemOf(el); const pid = el.dataset.pid; if (it.shares[pid] > 0) delete it.shares[pid]; else it.shares[pid] = 1; changed(); },
  'share-all': el => { const it = itemOf(el); const all = state.draft.participants.every(p => it.shares[p] > 0); it.shares = all ? {} : Object.fromEntries(state.draft.participants.map(p => [p, 1])); changed(); },
  'toggle-units': el => {
    const it = itemOf(el); it.byUnit = !it.byUnit;
    if (it.byUnit) { // turn current sharers into unit counts where it fits
      const takers = Object.keys(it.shares).filter(k => it.shares[k] > 0);
      it.shares = {};
      if (takers.length && it.qty % takers.length === 0) for (const t of takers) it.shares[t] = it.qty / takers.length;
    } else it.shares = Object.fromEntries(Object.keys(it.shares).filter(k => it.shares[k] > 0).map(k => [k, 1]));
    changed();
  },
  'unit-inc': el => { const it = itemOf(el); const used = Object.values(it.shares).reduce((s, n) => s + n, 0); if (used >= it.qty) return toast(`All ${it.qty} already assigned.`); it.shares[el.dataset.pid] = (it.shares[el.dataset.pid] || 0) + 1; changed(); },
  'unit-dec': el => { const it = itemOf(el); const pid = el.dataset.pid; if (!it.shares[pid]) return; it.shares[pid]--; if (!it.shares[pid]) delete it.shares[pid]; changed(); },
  'edit-item': el => editItemSheet(el.dataset.id),
  'add-item': () => editItemSheet(null),
  'add-adj': el => addAdjustment(el.dataset.kind, el.dataset.label),
  'del-adj': el => { state.draft.adjustments = state.draft.adjustments.filter(a => a.id !== el.dataset.id); changed(); },
  'fix-diff': () => { const d = state.draft; const diff = S.toCents(d.scan.total) - S.receiptTotal(d); d.adjustments.push({ id: uid(), label: 'Difference', kind: 'other', amount: diff / 100 }); changed(); },
  'people': () => peopleSheet(rerender),
  'payer': el => { state.draft.payerId = el.dataset.pid; changed(); },
  'assign-rest': () => assignRest('payer'),
  'split-rest': () => assignRest('all'),
  'save-receipt': () => saveReceipt(),
  'zoom-photo': el => { const d = document.createElement('dialog'); d.className = 'photo'; d.innerHTML = `<img src="${el.src}" alt="Receipt photo">`; document.body.append(d); d.onclick = () => d.close(); d.onclose = () => d.remove(); d.showModal(); },
  'share-receipt': el => shareText(receiptShareText(state.receipts.find(r => r.id === el.dataset.id))),
  'share-person': el => { const r = state.receipts.find(x => x.id === el.dataset.id); shareText(personShareText(r, el.dataset.pid), person(el.dataset.pid).phone); },
  'delete-receipt': async el => {
    const r = state.receipts.find(x => x.id === el.dataset.id);
    if (!(await confirmSheet(`Delete ${r.merchant}?`, 'Balances will be recalculated without it.'))) return;
    await delRecord('receipts', r.id); await db.del('photos', r.id);
    toast('Deleted'); go('#/receipts');
  },
  'image-receipt': el => { const r = state.receipts.find(x => x.id === el.dataset.id); imageSheet(receiptImageSpec(r), `${slug(r.merchant)}-${r.date}.png`, `${r.merchant} · ${fmtDate(r.date)}`); },
  'image-person': el => { const r = state.receipts.find(x => x.id === el.dataset.id); imageSheet(personImageSpec(r, el.dataset.pid), `${slug(r.merchant)}-${slug(pname(el.dataset.pid))}.png`, personShareText(r, el.dataset.pid)); },
  'image-friend': el => imageSheet(friendImageSpec(el.dataset.id), `statement-${slug(pname(el.dataset.id))}-${todayISO()}.png`, reminderText(el.dataset.id)),
  'receipt-new-group': el => newGroupForReceipt(el.dataset.id),
  'group-add-existing': el => addExistingSheet(el.dataset.id),
  'report': el => reportSheet(el.dataset.id || ''),
  'new-friend': () => friendSheet(null),
  'edit-friend': el => friendSheet(person(el.dataset.id)),
  'record-payment': el => paymentSheet(el.dataset.id),
  'settle': el => settle(el.dataset.id),
  'remind': el => shareText(reminderText(el.dataset.id), person(el.dataset.id).phone),
  'payment-menu': async el => {
    const p = state.payments.find(x => x.id === el.dataset.id);
    if (await confirmSheet('Delete this payment?', `${pname(p.from)} → ${pname(p.to)}: ${fmt(S.toCents(p.amount), p.currency)} on ${fmtDate(p.date)}`)) { await delRecord('payments', p.id); rerender(); }
  },
  'new-group': () => groupSheet(null),
  'edit-group': el => groupSheet(state.groups.find(g => g.id === el.dataset.id)),
  'group-receipt': el => { state.pendingGroup = el.dataset.id; go('#/new'); },
  'toggle-key': el => { const k = $('#key'); k.type = k.type === 'password' ? 'text' : 'password'; el.textContent = k.type === 'password' ? 'Show' : 'Hide'; },
  'save-key': async () => { state.settings.apiKey = $('#key').value.trim(); await saveSettings(); toast(state.settings.apiKey ? 'Key saved' : 'Key removed'); },
  'test-key': async el => {
    const key = $('#key').value.trim(); if (!key) return toast('Paste a key first.');
    el.disabled = true; el.textContent = 'Testing…';
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(state.settings.model)}`, { headers: { 'x-goog-api-key': key } });
      const j = await res.json().catch(() => ({}));
      toast(res.ok ? '✓ Key works' : `✗ ${j?.error?.message || 'Key rejected'}`, 4000);
      if (res.ok && key !== state.settings.apiKey) { state.settings.apiKey = key; await saveSettings(); }
    } catch { toast('Could not reach Google. Check your connection.'); }
    el.disabled = false; el.textContent = 'Test';
  },
  'theme': async el => { state.settings.theme = el.dataset.v; await saveSettings(); applyTheme(); rerender(); },
  'style': async el => { state.settings.style = el.dataset.v; state.settings.accent = STYLES[el.dataset.v][0]; await saveSettings(); applyTheme(); rerender(); },
  'pattern': async el => { state.settings.pattern = !(state.settings.pattern !== false); await saveSettings(); applyTheme(); rerender(); },
  'accent': async el => { state.settings.accent = el.dataset.v; await saveSettings(); applyTheme(); rerender(); },
  'export-csv': el => exportCSV(el.dataset.kind),
  'backup': () => backup($('#withPhotos').checked),
  'erase': async () => {
    if (!(await confirmSheet('Erase everything?', 'All receipts, friends, groups, payments and photos on this phone will be deleted. Download a backup first if unsure.', 'Erase all'))) return;
    for (const s of ['people', 'groups', 'receipts', 'payments', 'photos', 'kv']) await db.clear(s);
    await load(); applyTheme(); toast('All data erased'); go('#/');
  },
};
const itemOf = el => state.draft.items.find(i => i.id === (el.dataset.item || el.closest('[data-item]')?.dataset.item));
function addAdjustment(kind, label) {
  const d = state.draft;
  const sumKinds = kinds => d.adjustments.filter(a => kinds.includes(a.kind)).reduce((s, a) => s + S.toCents(a.amount), 0);
  let amount = 0;
  // Malaysian receipts: service charge is on the (discounted) subtotal, SST on subtotal + service charge.
  if (kind === 'service_charge') amount = Math.round((S.itemsTotal(d) + sumKinds(['discount'])) * 0.10) / 100;
  if (kind === 'tax') amount = Math.round((S.itemsTotal(d) + sumKinds(['discount', 'service_charge'])) * 0.06) / 100;
  d.adjustments.push({ id: uid(), label, kind, amount });
  changed();
  if (kind === 'other') setTimeout(() => { const ins = document.querySelectorAll('[data-adj-label]'); ins[ins.length - 1]?.focus(); });
}
function changed() { saveDraft(); rerender(); }
function assignRest(mode) {
  const d = state.draft;
  for (const it of d.items) {
    const parts = S.itemSplit(it);
    if (!parts[S.UNASSIGNED]) continue;
    if (it.byUnit && it.qty > 1) {
      const left = it.qty - Object.values(it.shares).reduce((s, n) => s + n, 0);
      if (mode === 'payer') it.shares[d.payerId] = (it.shares[d.payerId] || 0) + left;
      else { it.byUnit = false; it.shares = Object.fromEntries(d.participants.map(p => [p, 1])); }
    } else it.shares = mode === 'payer' ? { [d.payerId]: 1 } : Object.fromEntries(d.participants.map(p => [p, 1]));
  }
  changed();
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || !actions[el.dataset.act]) return;
  e.preventDefault();
  actions[el.dataset.act](el, e);
});
document.addEventListener('change', async e => {
  const t = e.target;
  if (t.matches('[data-photo]')) { const f = t.files[0]; t.value = ''; await handlePhoto(f); return; }
  if (t.matches('[data-receipt-group]')) {
    const rid = t.dataset.receiptGroup;
    if (t.value === '__new') { t.value = state.receipts.find(x => x.id === rid)?.groupId || ''; newGroupForReceipt(rid); return; }
    await setReceiptGroup(rid, t.value); return;
  }
  if (t.matches('[data-restore]')) { const f = t.files[0]; t.value = ''; if (f) restore(f); return; }
  if (t.matches('[data-setting]')) {
    let v = t.value;
    if (v === '__custom') { v = prompt('Gemini model name (e.g. gemini-3.5-flash-lite)', state.settings.model) || state.settings.model; }
    state.settings[t.dataset.setting] = v.trim(); await saveSettings();
    if (t.dataset.setting === 'model') rerender();
    toast('Saved', 1200); return;
  }
  if (!state.draft) return;
  if (t.matches('[data-f]')) { state.draft[t.dataset.f] = t.value; if (t.dataset.f === 'currency') rerender(); saveDraft(); }
  if (t.matches('[data-adj-amount]')) { const a = state.draft.adjustments.find(x => x.id === t.dataset.adjAmount); a.amount = parseAmount(t.value); changed(); }
});
document.addEventListener('input', e => {
  const t = e.target;
  if (!state.draft) return;
  if (t.matches('[data-f]') && t.type === 'text') { state.draft[t.dataset.f] = t.value; saveDraft(); }
  if (t.matches('[data-adj-label]')) { state.draft.adjustments.find(x => x.id === t.dataset.adjLabel).label = t.value; saveDraft(); }
});

// ---------- start ----------
(async () => {
  try {
    await load();
  } catch (e) {
    $('#app').innerHTML = `<div class="banner warn">Couldn't open storage on this browser (${esc(e.message)}). Private browsing can block it.</div>`;
    return;
  }
  applyTheme();
  window.addEventListener('hashchange', () => { if (location.hash !== '#/new') state.scanError = null; render(); });
  render();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
      // Check for a new version whenever the app is opened or brought back to the front.
      const check = () => reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
      check();
    }).catch(() => {});
  }
})();
