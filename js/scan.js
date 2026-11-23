// Receipt scanning with the Gemini API. Works in the browser and in Node 18+ (used by tests).

// Flash-Lite read all sample receipts correctly, is fast, and has the most generous free quota.
export const DEFAULT_MODEL = 'gemini-flash-lite-latest';
export const FALLBACK_MODELS = ['gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];

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

export async function scanReceipt({ apiKey, model = DEFAULT_MODEL, imageBase64, mimeType = 'image/jpeg', fetchImpl = fetch, baseUrl = 'https://generativelanguage.googleapis.com' }) {
  const body = {
    contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mimeType, data: imageBase64 } }, { text: PROMPT }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA },
  };
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-goog-api-key'] = apiKey;
  const res = await fetchImpl(`${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers, body: JSON.stringify(body),
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

// Try the chosen model, then fall back to others if it is unavailable or rate-limited.
export async function scanWithFallback(opts, onAttempt) {
  const models = [opts.model || DEFAULT_MODEL, ...FALLBACK_MODELS.filter(m => m !== opts.model)];
  let lastErr;
  for (const model of models) {
    try {
      onAttempt?.(model);
      const r = await scanReceipt({ ...opts, model });
      r.model = model;
      return r;
    } catch (e) {
      lastErr = e;
      if (![404, 429, 500, 503].includes(e.status)) throw e;
    }
  }
  throw lastErr;
}

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
