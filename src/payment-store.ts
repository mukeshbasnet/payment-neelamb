import { DurableObject } from "cloudflare:workers";
import type { Env, PaymentProvider } from "./env";

type PaymentStatus = "pending" | "paid" | "failed" | "expired";

type PaymentRow = Record<string, SqlStorageValue> & {
	id: string;
	provider: PaymentProvider;
	amount_paise: number;
	currency: string;
	status: PaymentStatus;
	created_at: number;
	expires_at: number;
	provider_transaction_id: string | null;
	verified_at: number | null;
	verification_method: "provider" | "admin";
};

interface PaymentInput {
	id: string;
	provider: PaymentProvider;
	amountPaise: number;
	currency: string;
	status: "pending";
	createdAt: number;
	expiresAt: number;
	verifiedAt: null;
}

interface VerificationInput {
	provider: PaymentProvider;
	providerTransactionId: string;
	status: "paid" | "failed";
	amountPaise: number;
	currency: string;
}

const PROVIDERS: PaymentProvider[] = ["citizens-bank", "esewa", "nepal-bank"];
const PAYMENT_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function isProvider(value: unknown): value is PaymentProvider {
	return (
		typeof value === "string" && PROVIDERS.includes(value as PaymentProvider)
	);
}

function isPaymentInput(value: unknown): value is PaymentInput {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const input = value as Record<string, unknown>;
	return (
		typeof input.id === "string" &&
		PAYMENT_ID_PATTERN.test(input.id) &&
		isProvider(input.provider) &&
		typeof input.amountPaise === "number" &&
		Number.isSafeInteger(input.amountPaise) &&
		input.amountPaise > 0 &&
		typeof input.currency === "string" &&
		/^[A-Z]{3}$/.test(input.currency) &&
		input.status === "pending" &&
		typeof input.createdAt === "number" &&
		Number.isSafeInteger(input.createdAt) &&
		typeof input.expiresAt === "number" &&
		Number.isSafeInteger(input.expiresAt) &&
		input.expiresAt > input.createdAt &&
		input.verifiedAt === null
	);
}

function isVerificationInput(value: unknown): value is VerificationInput {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const input = value as Record<string, unknown>;
	return (
		isProvider(input.provider) &&
		typeof input.providerTransactionId === "string" &&
		input.providerTransactionId.length > 0 &&
		input.providerTransactionId.length <= 200 &&
		(input.status === "paid" || input.status === "failed") &&
		typeof input.amountPaise === "number" &&
		Number.isSafeInteger(input.amountPaise) &&
		typeof input.currency === "string" &&
		/^[A-Z]{3}$/.test(input.currency)
	);
}

function toPayment(row: PaymentRow) {
	return {
		id: row.id,
		provider: row.provider,
		amountPaise: row.amount_paise,
		currency: row.currency,
		status: row.status,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		verifiedAt: row.verified_at,
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return Response.json(body, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}

export class PaymentStore extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS payments (
				id TEXT PRIMARY KEY,
				provider TEXT NOT NULL,
				amount_paise INTEGER NOT NULL,
				currency TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'expired')),
				created_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL,
				provider_transaction_id TEXT,
				verified_at INTEGER,
				verification_method TEXT NOT NULL DEFAULT 'provider'
			);
			CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_transaction_id
			ON payments (provider, provider_transaction_id)
			WHERE provider_transaction_id IS NOT NULL;
		`);
		const columns = ctx.storage.sql
			.exec<{ name: string }>("PRAGMA table_info(payments)")
			.toArray();
		if (!columns.some((column) => column.name === "verification_method")) {
			ctx.storage.sql.exec(
				"ALTER TABLE payments ADD COLUMN verification_method TEXT NOT NULL DEFAULT 'provider'"
			);
		}
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/transactions" && request.method === "POST") {
			return this.createPayment(request);
		}
		if (url.pathname === "/transactions" && request.method === "GET") {
			return this.listPendingPayments();
		}

		const match = url.pathname.match(
			/^\/transactions\/([^/]+)(\/verify|\/admin-confirm)?$/
		);
		if (!match || !PAYMENT_ID_PATTERN.test(match[1])) {
			return jsonResponse({ error: "Not found" }, 404);
		}

		if (match[2] === "/verify" && request.method === "POST") {
			return this.verifyPayment(match[1], request);
		}
		if (match[2] === "/admin-confirm" && request.method === "POST") {
			return this.adminConfirmPayment(match[1]);
		}
		if (!match[2] && request.method === "GET") {
			return this.getPayment(match[1]);
		}
		return jsonResponse({ error: "Method not allowed" }, 405);
	}

	private listPendingPayments(): Response {
		const now = Date.now();
		this.ctx.storage.sql.exec(
			"UPDATE payments SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?",
			now
		);
		const rows = this.ctx.storage.sql
			.exec<PaymentRow>(
				"SELECT * FROM payments WHERE status = 'pending' ORDER BY created_at ASC LIMIT 100"
			)
			.toArray();
		return jsonResponse({ payments: rows.map(toPayment), limit: 100 });
	}

	private adminConfirmPayment(id: string): Response {
		const result = this.ctx.storage.transactionSync(() => {
			const row = this.ctx.storage.sql
				.exec<PaymentRow>("SELECT * FROM payments WHERE id = ?", id)
				.toArray()[0];
			if (!row) {
				return {
					status: 404,
					body: { error: "Payment transaction not found" },
				};
			}
			if (row.status !== "pending") {
				return {
					status: 409,
					body: { error: `Payment is ${row.status}` },
				};
			}
			const now = Date.now();
			if (row.expires_at <= now) {
				this.ctx.storage.sql.exec(
					"UPDATE payments SET status = 'expired' WHERE id = ? AND status = 'pending'",
					id
				);
				return { status: 410, body: { error: "Payment transaction expired" } };
			}
			this.ctx.storage.sql.exec(
				`UPDATE payments
				 SET status = 'paid', verified_at = ?, verification_method = 'admin'
				 WHERE id = ? AND status = 'pending'`,
				now,
				id
			);
			return { status: 200, body: { status: "paid", verifiedBy: "admin" } };
		});
		return jsonResponse(result.body, result.status);
	}

	private async createPayment(request: Request): Promise<Response> {
		let value: unknown;
		try {
			value = await request.json();
		} catch {
			return jsonResponse({ error: "Invalid payment record" }, 400);
		}
		if (!isPaymentInput(value)) {
			return jsonResponse({ error: "Invalid payment record" }, 400);
		}

		try {
			await this.ctx.storage.setAlarm(Date.now() + RETENTION_MS);
			this.ctx.storage.sql.exec(
				`INSERT INTO payments
					(id, provider, amount_paise, currency, status, created_at, expires_at)
				 VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
				value.id,
				value.provider,
				value.amountPaise,
				value.currency,
				value.createdAt,
				value.expiresAt
			);
		} catch (error) {
			console.error(
				JSON.stringify({
					message: "could not persist payment record",
					error: error instanceof Error ? error.message : "Unknown error",
				})
			);
			return jsonResponse({ error: "Could not persist payment record" }, 503);
		}
		return jsonResponse({ created: true }, 201);
	}

	private getPayment(id: string): Response {
		let row = this.ctx.storage.sql
			.exec<PaymentRow>("SELECT * FROM payments WHERE id = ?", id)
			.toArray()[0];
		if (row?.status === "pending" && row.expires_at <= Date.now()) {
			this.ctx.storage.sql.exec(
				"UPDATE payments SET status = 'expired' WHERE id = ? AND status = 'pending'",
				id
			);
			row = { ...row, status: "expired" };
		}
		return row
			? jsonResponse(toPayment(row))
			: jsonResponse({ error: "Not found" }, 404);
	}

	private async verifyPayment(id: string, request: Request): Promise<Response> {
		let value: unknown;
		try {
			value = await request.json();
		} catch {
			return jsonResponse({ error: "Invalid verification record" }, 400);
		}
		if (!isVerificationInput(value)) {
			return jsonResponse({ error: "Invalid verification record" }, 400);
		}

		const result = this.ctx.storage.transactionSync(() => {
			const row = this.ctx.storage.sql
				.exec<PaymentRow>("SELECT * FROM payments WHERE id = ?", id)
				.toArray()[0];
			if (!row) {
				return {
					status: 404,
					body: { error: "Payment transaction not found" },
				};
			}
			if (
				row.provider !== value.provider ||
				row.amount_paise !== value.amountPaise ||
				row.currency !== value.currency
			) {
				return {
					status: 409,
					body: { error: "Callback does not match payment" },
				};
			}
			if (row.status === "paid") {
				return row.provider_transaction_id === value.providerTransactionId
					? { status: 200, body: { status: "paid", duplicate: true } }
					: { status: 409, body: { error: "Payment is already verified" } };
			}
			if (row.status !== "pending") {
				return { status: 409, body: { error: `Payment is ${row.status}` } };
			}

			const now = Date.now();
			if (row.expires_at <= now) {
				this.ctx.storage.sql.exec(
					"UPDATE payments SET status = 'expired' WHERE id = ? AND status = 'pending'",
					id
				);
				return { status: 410, body: { error: "Payment transaction expired" } };
			}

			const existingReference = this.ctx.storage.sql
				.exec<{
					id: string;
				}>(
					"SELECT id FROM payments WHERE provider = ? AND provider_transaction_id = ?",
					value.provider,
					value.providerTransactionId
				)
				.toArray()[0];
			if (existingReference) {
				return {
					status: 409,
					body: { error: "Provider transaction was already used" },
				};
			}

			const nextStatus = value.status === "paid" ? "paid" : "failed";
			this.ctx.storage.sql.exec(
				`UPDATE payments
				 SET status = ?, provider_transaction_id = ?, verified_at = ?
				 WHERE id = ? AND status = 'pending'`,
				nextStatus,
				value.providerTransactionId,
				value.status === "paid" ? now : null,
				id
			);
			return { status: 200, body: { status: nextStatus, duplicate: false } };
		});

		return jsonResponse(result.body, result.status);
	}

	async alarm(): Promise<void> {
		const now = Date.now();
		this.ctx.storage.sql.exec(
			"UPDATE payments SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?",
			now
		);
		this.ctx.storage.sql.exec(
			"DELETE FROM payments WHERE created_at <= ?",
			now - RETENTION_MS
		);
		const remaining = this.ctx.storage.sql
			.exec<{ count: number }>("SELECT COUNT(*) AS count FROM payments")
			.toArray()[0]?.count;
		if (remaining && remaining > 0) {
			await this.ctx.storage.setAlarm(now + 24 * 60 * 60 * 1000);
		}
	}
}
