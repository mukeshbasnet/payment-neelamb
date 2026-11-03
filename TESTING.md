# Testing the single-link checkout

## Automated checks

Run the unit tests, type check, formatting/lint checks, and Wrangler packaging
dry-run from the project directory:

```sh
npm test
npm run typecheck
npm run lint
npm run deploy -- --dry-run
```

The dry-run builds the Worker and packages the static assets without uploading
or changing a Cloudflare deployment.

## Local checkout

1. Copy `.dev.vars.example` to `.dev.vars` and replace its placeholders with
   independent random secrets of at least 32 bytes.
2. Set one or more public payment destinations in `wrangler.jsonc` (or local
   Wrangler vars). A method is offered when its destination, `JWT_SECRET`, and
   either its callback secret or `ADMIN_PASSWORD` are configured.
3. Run `npm run dev` and open `http://localhost:8787`. The root page is the
   single checkout link; `/api/config` reports the currency and enabled methods.
4. Choose a method. The checkout creates a pending payment reference and shows
   that method's destination, configured QR image, and instructions. The
   transaction remains pending until its configured callback is verified.
5. In local testing only, POST a normalized callback to
   `/api/callbacks/{provider}` with `X-Payment-Signature` set to the
   `sha256=`-prefixed HMAC-SHA256 of the exact JSON request body, signed with
   that provider's callback secret. Use the transaction ID, amount, and
   currency returned by checkout. Never use a fabricated callback to verify a
   production payment.
6. Confirm the page changes to “Payment confirmed” and that `GET /api/session`
   accepts the browser's session cookie. Wrong signatures, mismatched amounts,
   expired payments, or callbacks from another provider must not issue a
   session.
7. Open `/admin`, sign in using `ADMIN_PASSWORD`, and confirm a pending test
   payment only after checking its exact receipt and amount. The checkout should
   then report the payment as confirmed and issue the customer session.

## Provider integration boundary

The included callback verifier is a generic raw-body HMAC adapter for local
integration tests. It is not a claim that Citizens Bank, eSewa, or Nepal Bank
uses this exact callback format. Before accepting live payments, implement and
test each provider's official signature, replay protection, payload
normalization, and server-side payment confirmation in `src/payment-callback.ts`.
