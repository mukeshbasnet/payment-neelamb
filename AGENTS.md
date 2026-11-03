# Project guidance

This repository is a single-link payment selector on Cloudflare Workers, not an
x402 proxy. The page at `/` lets a customer choose among Citizens Bank, eSewa,
and Nepal Bank for one configured amount. `src/index.ts` handles checkout and
callbacks; `src/payment-store.ts` is the SQLite-backed Durable Object; `public/`
contains the checkout UI.

## Payment safety

- Never accept a browser redirect, uploaded receipt, or client-supplied status
  as proof of payment. Only a verified provider callback can mark a transaction
  paid.
- Keep secrets in Wrangler secrets or the ignored `.dev.vars`, not in source,
  `wrangler.jsonc`, or public assets. Do not log secrets or full callback bodies.
- Do not describe the generic callback adapter as a production integration for
  a bank or wallet. Before live use, implement that provider's official
  signature, replay protection, normalization, and server-side confirmation.
- Preserve the submitted amount, currency, expiry, provider match, and
  idempotency checks when changing checkout or callback behavior.

## Validate changes

Run the relevant checks before handing off:

```sh
npm test
npm run lint
npm run deploy -- --dry-run
```

The dry-run builds and packages the Worker without deploying it. A live deploy
requires explicit user intent, the intended Cloudflare account, configured
payment destinations, verified provider adapters, and production secrets.
