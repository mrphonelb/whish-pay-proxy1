
# Whish Pay Proxy (Sandbox)

A tiny Express server to proxy Whish Pay API calls. Designed for Daftra checkout iframe + Render hosting.

## Endpoints

- `GET /` → "Whish proxy up"
- `GET /health` → health JSON
- `GET /whish/balance` → Calls Whish `/payment/account/balance`
- `POST /whish/create` → Calls Whish `/payment/whish` and returns `{ redirect }`
- `GET /whish/callback` → Whish hits this; server checks `/payment/collect/status` then redirects user
- `POST /whish/status` → Manual status check

## Deploy on Render

1. Set Node 18+.
2. Build: `npm install`
3. Start: `node server.js`
4. Add environment variables from `.env.example`. Leave `PUBLIC_BASE_URL` empty until after Render gives you the URL.
5. After first deploy, copy your Render URL and set `PUBLIC_BASE_URL` to it, then redeploy.

## Test

- Open `/` → should show ✅ message.
- Open `/whish/balance` → should return JSON with `status:true` (sandbox).
