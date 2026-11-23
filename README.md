# Split Receipts

A phone-friendly web app for splitting bills with friends. Snap a receipt, tap who had what, and it keeps track of who owes you, and who you owe.

## Features

- **Scan receipts.** Gemini reads every item, quantity, discount, SST, service charge and rounding, then checks that the items add up to the receipt total.
- **Assign items.** Tap friends on each item. A shared item is split equally. Items with a quantity (e.g. 3 × water) can also be split by unit.
- **Fair tax and charges.** Discounts, SST, service charge and rounding are shared in proportion to what each person ordered. Shares always add up to the exact total, to the cent.
- **Whoever paid.** Usually you, but any friend can be marked as the payer.
- **Balances.** See per-friend balances, record partial payments, "Mark as paid", and see who owes whom between friends.
- **WhatsApp.** Share a receipt summary, send a friend their share, or send a reminder with everything still owing.
- **Groups** (e.g. "Housemates", "Penang trip") add everyone at once. Saved receipts can be moved into any group, either from the receipt's page or with "Add existing" on the group page.
- **Monthly report image** per group (or all receipts): each friend's total for the month with one line per receipt (no items), for everyone or one person. Also as WhatsApp text.
- **Image export.** Share or save a picture of the whole split, of one person's share, or of a friend's statement.
- Every item shows its quantity (and unit price), and each receipt shows its total quantity.
- **Receipt photos** are kept with each receipt.
- **CSV export** and **full backup / restore** (JSON, optionally with photos).
- Light/dark theme and accent colours. Works offline and can be installed on the home screen.

All data stays on your phone (IndexedDB). There is no server and no account.

## Setup

1. Enable GitHub Pages: **Settings → Pages → Deploy from a branch → `main` / root**. The app will be at `https://<user>.github.io/split-receipts/`.
2. On your phone, open the link and choose **Add to Home screen**.
3. Get a free Gemini API key at <https://aistudio.google.com/apikey> and paste it into **Settings → Receipt scanning**.

The default model is `gemini-flash-lite-latest`. It read all the test receipts correctly in about 2 seconds and has the most generous free quota. If Google is busy, the app automatically tries other Flash/Flash-Lite models and retries a few times.

## Code

- `index.html`, `styles.css`: page shell and styles
- `js/app.js`: UI, routing, sharing, export
- `js/scan.js`: Gemini prompt, response schema, consistency checks
- `js/split.js`: splitting and balance maths (in cents, largest-remainder rounding)
- `js/db.js`: IndexedDB storage
- `sw.js`: offline cache

Run the maths tests with `node tests/split.test.mjs`.
