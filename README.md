# BS Detector — Backend (Phase 1 MVP)

Receives the public-scan form from your GPT-built front-end, runs a live web
search, has Claude assess and hedge the result as Green/Yellow, logs every
check + marketing consent to Google Sheets, and enforces the free-tier cap.

## What it does NOT do (by design, for now)
- No CIPC / bank / credit-bureau / criminal-record checks (Phase 4).
- No user accounts or OTP login yet — phone number is used only as a usage-cap
  key, not a verified identity. Add Twilio Verify (or similar) before this
  goes further than a closed pilot, since the framework calls for verified-phone
  gating on the free tier.
- No Postgres — Google Sheets is the "database." Fine at low volume; migrate
  before Phase 3 (estate portal) or once concurrent writes get slow.

## 1. Google Sheet setup
1. Create a Google Sheet with two tabs named exactly `Checks` and `Marketing`.
2. Add header rows matching the columns documented in `src/sheets.js`.
3. Create a Google Cloud project → enable the **Google Sheets API** →
   create a **Service Account** → generate a JSON key.
4. Share the Sheet with the service account's email (Editor access).
5. Copy the service account email + private key + Sheet ID (from the Sheet's
   URL) into your `.env`.

## 2. Anthropic + Search keys
- `ANTHROPIC_API_KEY` from console.anthropic.com.
- `SERPAPI_KEY` from serpapi.com (or swap `src/search.js` for another
  provider — Bing Web Search works similarly).

## 3. Local run
```bash
cp .env.example .env   # fill in real values
npm install
npm run dev
```
Test it:
```bash
curl -X POST http://localhost:3000/api/check \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Contractor","company":"Test Co","town":"Cape Town","phone":"+27000000000","reason":"Considering hiring"}'
```

## 4. Deploy to Railway
1. Push this folder to a GitHub repo.
2. In Railway: New Project → Deploy from GitHub repo → select it.
3. Railway auto-detects Node via Nixpacks and runs `npm start`.
4. In the Railway service's **Variables** tab, paste in everything from
   `.env.example` with real values. For the private key, keep the `\n`
   literal — the code un-escapes it at runtime.
5. Once deployed, Railway gives you a public URL
   (e.g. `bsdetector-backend-production.up.railway.app`) — this is what
   your GPT-built front-end's `fetch('/api/check')` call should point to
   (update the placeholder URL in the HTML to the full Railway URL, or set
   up a custom domain in Railway's settings).
6. Set `ALLOWED_ORIGINS` to the exact domain your front-end is served from,
   so the API only accepts requests from your site.

## 5. Wiring up the front-end
In the HTML GPT builds, change:
```js
fetch('/api/check', { ... })
```
to the full Railway URL:
```js
fetch('https://your-service.up.railway.app/api/check', { ... })
```

## Known gaps before real users touch this
- No OTP/phone verification (spoofable usage cap).
- No dispute/correction workflow for a Yellow result (flagged as a priority
  in the framework — build before public launch).
- SerpAPI free tier is limited (100 searches/month) — fine for testing,
  not for real free-tier traffic; budget for this before launch.
