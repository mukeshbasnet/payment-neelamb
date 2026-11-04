# Secure Payment Selector

A single-link payment checkout running on Cloudflare Workers. The landing page lets customers enter an NPR amount and choose Citizens Bank, eSewa, or Nepal Bank. Transactions start as `pending`; a signed provider callback or an authenticated admin confirmation after checking the bank/wallet receipt can mark the matching, unexpired transaction as `paid`. The browser receives a one-hour, `HttpOnly`, `Secure`, `SameSite=Strict` JWT cookie only after it reads that confirmed state.

The project is deployable without Cloudflare credentials for local development. Live provider payments are deliberately fail-closed until payment destinations, JWT signing, and callback verification are configured.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars
# Replace all secret placeholders with independent random secrets (at least 32 bytes).
npm run dev
```

Open `http://localhost:8787`. Set the payment destinations, `JWT_SECRET`, and `ADMIN_PASSWORD` before checkout options become available. Open `/admin` to sign in and review pending payments. Local Durable Object state is managed by Wrangler.

Run checks:

```sh
npm test
npm run typecheck
npm run format:check
npm run lint
npm run deploy -- --dry-run
```

`npm run deploy -- --dry-run` bundles the Worker and assets and validates Wrangler
configuration without uploading a deployment. The checkout is a single link at
`/`; customers enter a positive amount in the configured currency and choose an
enabled method from `/api/config`. The server validates and stores the submitted
amount with the selected provider in the pending transaction.

## Configuration

### Public configuration

Set these non-secret values in `wrangler.jsonc` under `vars` or in the
Cloudflare Worker dashboard. Because this repository is public, configure the
payment destination variables in the Cloudflare dashboard rather than
committing merchant payout details to `wrangler.jsonc`. The deploy script uses
`--keep-vars` to preserve dashboard-managed variables omitted from the config.

| Variable                    | Purpose                                                                         |
| --------------------------- | ------------------------------------------------------------------------------- |
| `PAYMENT_CURRENCY`          | Three-letter currency shown for the customer-entered amount; defaults to `NPR`. |
| `PAYMENT_EXPIRY_MINUTES`    | Pending payment lifetime from 5 to 60 minutes.                                  |
| `CITIZENS_BANK_DESTINATION` | Account name/number and other pay-to instructions shown to customers.           |
| `ESEWA_MERCHANT_ID`         | eSewa merchant identifier shown to customers.                                   |
| `NEPAL_BANK_DESTINATION`    | Account name/number and other pay-to instructions shown to customers.           |
| `CITIZENS_BANK_QR_IMAGE`    | Optional path to the Citizens Bank QR image in `public/`.                       |
| `ESEWA_QR_IMAGE`            | Optional path to the eSewa QR image in `public/`.                               |
| `NEPAL_BANK_QR_IMAGE`       | Optional path to the Nepal Bank QR image in `public/`.                          |

Payment destinations are displayed to customers at checkout. Never put banking
passwords, PINs, one-time codes, API credentials, or callback secrets in these
variables.

Customers must enter their name and phone number along with any positive amount
with up to two decimal places. The server validates these details before saving
them with the payment record. Payment records, including customer contact
details, are automatically deleted after 30 days. There is no configured amount
maximum; the server rejects zero, negative, fractional-paisa, or unsafe-integer
amounts. The QR images are static merchant codes, so customers must enter the
checkout amount in their bank or wallet app after scanning.

The supplied provider QR images are served from `public/payment-qr/` and
configured in `wrangler.jsonc`. To replace one, use the actual QR image supplied
or issued for your merchant account and update its matching variable to a
root-relative PNG, JPEG, or WebP path. The application does not fabricate
payment QR codes. If an image is unavailable, the checkout continues to show
the payment destination and instructions without a QR.
After payment is confirmed, the checkout replaces payment instructions and the
merchant QR with a thank-you success screen. It does not display a customer
session token or generate a post-payment QR code.

### Secrets

Create independent random secrets, each at least 32 bytes. For local development, store them in the ignored `.dev.vars` file. In production, set Worker secrets:

```sh
npx wrangler secret put JWT_SECRET
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put CITIZENS_CALLBACK_SECRET
npx wrangler secret put ESEWA_CALLBACK_SECRET
npx wrangler secret put NEPAL_BANK_CALLBACK_SECRET
```

`JWT_SECRET` signs customer sessions. `ADMIN_PASSWORD` protects `/admin`; use a unique random value, not a human-memorable password. Admin sessions are signed, `HttpOnly`, `Secure`, `SameSite=Strict` cookies and expire after eight hours. Each callback secret authenticates that provider's callback; never share the JWT or admin secret with a provider. A payment method is available when it has a destination, `JWT_SECRET`, and either its callback secret or `ADMIN_PASSWORD`. Provider callbacks still require that provider's callback secret.

The authenticated admin dashboard lists all payment statuses with filters and
20 records per page, newest first. It shows the customer name and phone, amount,
provider, payment reference, provider transaction ID when supplied, status,
created/expiry/verification times, and verification method. Records created
before customer details were added remain available with blank identity fields.
Confirm a payment only after independently checking that the exact amount has
arrived in the merchant account. Admin confirmations are persisted with their
verification time and `admin` method; expired, already-confirmed, or failed
transactions cannot be confirmed again.

If a provider requires a merchant API key or secret to create payment intents, store it as a separate Wrangler secret. This template does not invent or embed vendor API credentials.

## Callback contract and vendor integration

The Worker endpoint is `POST /api/callbacks/{provider}`, where provider is `citizens-bank`, `esewa`, or `nepal-bank`. The starter verifier requires `X-Payment-Signature: sha256=<hex HMAC-SHA256>` over the exact raw UTF-8 request body using that provider's callback secret. Its normalized JSON body is:

```json
{
	"transactionId": "the-Worker-generated-checkout-UUID",
	"providerTransactionId": "unique-provider-payment-reference",
	"status": "paid",
	"amountPaise": 10000,
	"currency": "NPR"
}
```

The callback must report `paid` or `failed`. A paid callback is accepted only once for a pending transaction before its expiry, with exact provider, amount, and currency matches. Repeated delivery of the same verified provider transaction is idempotent; reusing a provider transaction reference for another checkout is rejected. A browser redirect or user-submitted receipt is not proof of payment.

The generic raw-body HMAC adapter is a secure integration boundary, **not a claim that all three providers use this header or payload**. Before going live, implement each provider's current official callback signature, timestamp/replay rules, field normalization, and server-side payment-status/amount confirmation in `src/payment-callback.ts`. Keep the exact provider callback secret in Wrangler secrets. Do not mark a payment paid based only on a client-side return URL.

The browser polls `GET /api/payments/{transactionId}`. Only when the Durable Object reports `paid` does the Worker issue the signed session cookie. Its expiration is capped at one hour after confirmation, so repeated polls cannot extend access.

## Deployment

The Wrangler config uses a SQLite-backed Durable Object for strongly consistent transaction state and includes its initial migration, static assets, current compatibility date, Workers Logs, and Traces. No D1/KV IDs need to be provisioned.

1. Configure the public payment destinations in the Worker dashboard, and
   confirm the provider callback adapters match their official specifications.
2. Authenticate Wrangler with the intended Cloudflare account (`npx wrangler login`) or use an already-authorized CI environment.
3. Set the four production secrets listed above.
4. Deploy with `npm run deploy`. This script uses Wrangler's `--keep-vars`
   option so dashboard-managed variables omitted from the repository config
   are not cleared by code deployments.

Cloudflare authentication is not needed for `npm run dev`, tests, or type checking. A live Worker deployment requires Cloudflare account access. The repo contains no provider credentials; the merchant must obtain them from each provider as needed.

Before deploying, run `npm run deploy -- --dry-run` to verify the Worker bundle,
static assets, and configured bindings. This does not test remote credentials,
provider callback integration, or deploy the Worker.

## Endpoints

| Method | Path                               | Purpose                                                             |
| ------ | ---------------------------------- | ------------------------------------------------------------------- |
| `GET`  | `/`                                | Single-link payment selector.                                       |
| `GET`  | `/api/config`                      | Public price and currently enabled payment methods.                 |
| `POST` | `/api/payments`                    | Create a pending transaction for the submitted amount and provider. |
| `GET`  | `/api/payments/{id}`               | Read transaction status; issue a cookie only for verified payment.  |
| `POST` | `/api/callbacks/{provider}`        | Verify and process a normalized provider callback.                  |
| `GET`  | `/api/session`                     | Check the signed payment session cookie.                            |
| `GET`  | `/admin`                           | Admin sign-in and pending-payment confirmation panel.               |
| `POST` | `/api/admin/login`                 | Authenticate with `ADMIN_PASSWORD` and set an admin session cookie. |
| `GET`  | `/api/admin/payments`              | List pending payments (admin session required).                     |
| `POST` | `/api/admin/payments/{id}/confirm` | Manually confirm a specific payment (admin session required).       |
| `POST` | `/api/admin/logout`                | Expire the admin session cookie.                                    |
| `GET`  | `/api/health`                      | Worker health check.                                                |

Worker secrets and full callback payloads are never returned by the public config or transaction-status APIs.
