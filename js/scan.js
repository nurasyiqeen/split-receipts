// Receipt scanning with the Gemini API. Works in the browser and in Node 18+ (used by tests).

// Flash-Lite read all sample receipts correctly, is fast, and has the most generous free quota.
export const DEFAULT_MODEL = 'gemini-flash-lite-latest';
// Separate models have separate capacity, so when one is busy another often isn't.
// Gemma 4 is slower but runs on its own capacity, so it comes last.
export const FALLBACK_MODELS = ['gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-flash-latest', 'gemma-4-26b-a4b-it', 'gemma-4-31b-it'];
const REQUEST_TIMEOUT = 45000;   // per request (Gemma can take ~30s)
const PATIENCE = 90000;          // keep trying this long in total
const STAGGER = 1200;            // start the next model this soon if the current one hasn't answered

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    merchant: { type: 'STRING', description: 'Shop / restaurant name' },
    date: { type: 'STRING', description: 'Receipt date as YYYY-MM-DD, empty if unknown' },
    currency: { type: 'STRING', description: 'ISO 4217 code, e.g. MYR' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          quantity: { type: 'NUMBER' },
          lineTotal: { type: 'NUMBER', description: 'Total price for this line (all units, including add-ons)' },
        },
        required: ['name', 'quantity', 'lineTotal'],
        propertyOrdering: ['name', 'quantity', 'lineTotal'],
      },
    },
    subtotal: { type: 'NUMBER' },
    adjustments: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          label: { type: 'STRING' },
          kind: { type: 'STRING', enum: ['discount', 'service_charge', 'tax', 'rounding', 'other'] },
          amount: { type: 'NUMBER', description: 'Signed: negative for discounts/negative rounding' },
        },
        required: ['label', 'kind', 'amount'],
        propertyOrdering: ['label', 'kind', 'amount'],
      },
    },
    total: { type: 'NUMBER', description: 'Final amount payable' },
  },
  required: ['merchant', 'date', 'currency', 'items', 'subtotal', 'adjustments', 'total'],
  propertyOrdering: ['merchant', 'date', 'currency', 'items', 'subtotal', 'adjustments', 'total'],
};

const PROMPT = `You are reading a photo of a shop or restaurant receipt so friends can split it.
Extract every purchased line item exactly as charged.

Rules:
- One entry per purchased line. quantity = the number of units on that line (default 1). lineTotal = the amount charged for the whole line.
- If a line shows a unit price like "(17.90/ea)" or "@28.90", lineTotal = quantity x unit price (it should match the printed line amount).
- Add-ons, modifiers and extra charges printed under an item (e.g. "+ Takeaway charge 0.50", "add egg 2.00") belong to that item: add them into its lineTotal, do not list them separately. Lines with no price (e.g. "- Black Pepper Sauce", "- Cold") are just notes; ignore them.
- Item names: short and readable. Drop leading menu codes (e.g. "365", "AG01", "068A") and drop Chinese/other-script duplicates when an English name is present. Keep size/qty hints like "(1L)" or "*6".
- Receipt columns can be misaligned on narrow paper; use the numbers so that the line totals add up to the printed subtotal.
- adjustments: everything between the subtotal and the total, in printed order: discounts (negative), service charge, SST/GST/VAT/tax, bill rounding (signed), tips. Use the amount actually charged, not the percentage or base amount. Do not include payment method lines (VISA, cash, debit, change) or tax summary tables that repeat amounts already listed.
- subtotal = the printed subtotal (sum of items before adjustments). If none is printed, use the sum of lineTotals.
- total = the final amount payable.
- merchant: the shop/brand name printed at the top (e.g. "Kafe La Raasa"), not the registered company name ("... Sdn Bhd"), in Title Case.
- currency: infer from symbols / country (RM or MYR => MYR). date as YYYY-MM-DD.
- Check before answering: sum(lineTotal) should equal subtotal, and subtotal + sum(adjustments) should equal total. If not, re-read the receipt.
If the image is not a receipt, return empty items and zero totals.`;

export async function scanReceipt({ apiKey, model = DEFAULT_MODEL, imageBase64, mimeType = 'image/jpeg', fetchImpl = fetch, baseUrl = 'https://generativelanguage.googleapis.com', signal }) {
  const body = {
    contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mimeType, data: imageBase64 } }, { text: PROMPT }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA },
  };
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-goog-api-key'] = apiKey;
  const res = await fetchImpl(`${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers, body: JSON.stringify(body), signal,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json?.error?.message || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const text = json?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  if (!text) throw new Error('The model returned no result. Try a clearer photo.');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Could not read the model response.'); }
  return normalize(data);
}

// Race the models: start one, and start the next after a short stagger (or right away if one fails).
// The first good answer wins and the rest are cancelled. If every model is busy, wait a bit and
// go again, until PATIENCE runs out or the caller cancels.
export async function scanWithFallback(opts, onAttempt, outerSignal) {
  let models = [...new Set([opts.model || DEFAULT_MODEL, ...FALLBACK_MODELS])];
  const deadline = Date.now() + PATIENCE;
  let lastErr, round = 0;
  while (models.length) {
    if (outerSignal?.aborted) throw cancelled();
    try {
      return await race(models, opts, (m) => onAttempt?.(m, round), outerSignal);
    } catch (errs) {
      const list = errs.errors || [errs];
      if (outerSignal?.aborted) throw cancelled();
      const fatal = list.find(e => [400, 401, 403].includes(e.status));
      if (fatal) throw fatal;
      const gone = new Set(list.filter(e => e.status === 404).map(e => e.model));
      models = models.filter(m => !gone.has(m));
      lastErr = list.find(e => e.status === 503) || list.find(e => e.status === 429) || list[0];
    }
    round++;
    const wait = Math.min(2000 * round, 8000);
    if (Date.now() + wait > deadline) break;
    onAttempt?.(null, round);
    await sleep(wait, outerSignal);
  }
  const err = new Error(lastErr?.status === 429
    ? 'Free limit reached for now. Wait a minute and try again.'
    : 'Google\'s free scanner is overloaded right now. Try again in a few minutes, or type it in by hand.');
  err.status = lastErr?.status || 503;
  throw err;
}

function race(models, opts, onStart, outerSignal) {
  return new Promise((resolve, reject) => {
    const ctls = [], errors = [];
    let next = 0, done = false, timer;
    const finish = () => { done = true; clearTimeout(timer); ctls.forEach(c => c.abort()); };
    const onOuter = () => { finish(); reject(cancelled()); };
    outerSignal?.addEventListener('abort', onOuter, { once: true });
    const launch = () => {
      if (done || next >= models.length) return;
      const model = models[next++];
      const ctl = new AbortController(); ctls.push(ctl);
      const t = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT);
      onStart(model);
      scanReceipt({ ...opts, model, signal: ctl.signal }).then(r => {
        if (done) return;
        r.model = model; finish(); outerSignal?.removeEventListener('abort', onOuter); resolve(r);
      }, e => {
        if (done) return;
        if (e.name === 'AbortError') { e = new Error('Request timed out'); e.status = 'timeout'; }
        e.model = model; errors.push(e);
        if ([400, 401, 403].includes(e.status)) { finish(); return reject({ errors }); }
        if (errors.length === models.length) { finish(); outerSignal?.removeEventListener('abort', onOuter); return reject({ errors }); }
        clearTimeout(timer); launch(); // failed fast: try the next one now
      }).finally(() => clearTimeout(t));
      clearTimeout(timer); timer = setTimeout(launch, STAGGER);
    };
    launch();
  });
}

const cancelled = () => { const e = new Error('Cancelled'); e.status = 'cancelled'; return e; };
const sleep = (ms, signal) => new Promise(res => { const t = setTimeout(res, ms); signal?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true }); });

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

export function normalize(d) {
  const items = (d.items || [])
    .filter(it => it && (it.name || it.lineTotal))
    .map(it => ({ name: String(it.name || 'Item').trim(), quantity: Math.max(1, Math.round(Number(it.quantity) || 1)), lineTotal: round2(it.lineTotal) }));
  const adjustments = (d.adjustments || [])
    .filter(a => a && Number(a.amount))
    .map(a => ({ label: String(a.label || a.kind || 'Adjustment').trim(), kind: a.kind || 'other', amount: round2(a.amount) }));
  const itemSum = round2(items.reduce((s, i) => s + i.lineTotal, 0));
  const subtotal = round2(d.subtotal) || itemSum;
  const total = round2(d.total) || round2(subtotal + adjustments.reduce((s, a) => s + a.amount, 0));
  const currency = (String(d.currency || 'MYR').toUpperCase().replace(/^RM$/, 'MYR')) || 'MYR';
  return { merchant: String(d.merchant || '').trim(), date: /^\d{4}-\d{2}-\d{2}$/.test(d.date || '') ? d.date : '', currency, items, subtotal, adjustments, total };
}

// Consistency checks shown to the user after a scan.
export function checkReceipt(r) {
  const itemSum = round2(r.items.reduce((s, i) => s + i.lineTotal, 0));
  const adjSum = round2(r.adjustments.reduce((s, a) => s + a.amount, 0));
  return {
    itemSum,
    itemsMatchSubtotal: Math.abs(itemSum - r.subtotal) < 0.015,
    adjustmentsMatchTotal: Math.abs(round2(r.subtotal + adjSum) - r.total) < 0.015,
  };
}
