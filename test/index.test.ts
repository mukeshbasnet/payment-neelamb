import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
	parseCallbackPayload,
	verifyCallbackSignature,
} from "../src/payment-callback";
import {
	isValidPaymentAmountPaise,
	parseNprAmountToPaise,
} from "../src/payment-amount";
import { parseAdminPaymentQuery } from "../src/admin-payment-query";
import { parseCustomerDetails } from "../src/payment-customer";
import {
	createAdminSession,
	verifyAdminPassword,
	verifyAdminSession,
} from "../src/admin-auth";
import { generateJWT, verifyJWT } from "../src/jwt";

const SECRET = "a".repeat(64);
const PAYMENT_ID = "7c4c965e-bd43-4fa2-8506-09e6aefb3a5d";

describe("customer payment details", () => {
	it("trims customer names and normalizes phone separators", () => {
		assert.deepEqual(
			parseCustomerDetails(" Test Customer ", "+977 981-234-5678"),
			{
				customerName: "Test Customer",
				customerPhone: "+9779812345678",
			}
		);
	});

	it("rejects missing, oversized, or invalid customer details", () => {
		assert.equal(parseCustomerDetails("", "9812345678"), null);
		assert.equal(parseCustomerDetails("A", "9812345678"), null);
		assert.equal(parseCustomerDetails("A".repeat(101), "9812345678"), null);
		assert.equal(parseCustomerDetails("Name", "phone-number"), null);
		assert.equal(parseCustomerDetails("Name\nAdmin", "9812345678"), null);
		assert.equal(parseCustomerDetails("Name", "+123"), null);
	});
});

describe("admin payment history query", () => {
	it("defaults to page one with all statuses and accepts filters", () => {
		assert.deepEqual(parseAdminPaymentQuery(new URLSearchParams()), {
			page: 1,
			status: "all",
		});
		assert.deepEqual(
			parseAdminPaymentQuery(new URLSearchParams("page=3&status=paid")),
			{ page: 3, status: "paid" }
		);
	});

	it("rejects invalid page numbers and status filters", () => {
		for (const query of [
			"page=0",
			"page=-1",
			"page=1.5",
			"page=9007199254740992",
			"status=unknown",
		]) {
			assert.equal(
				parseAdminPaymentQuery(new URLSearchParams(query)),
				null,
				query
			);
		}
	});
});

describe("admin authentication", () => {
	it("verifies strong passwords and rejects invalid candidates", async () => {
		assert.equal(await verifyAdminPassword(SECRET, SECRET), true);
		assert.equal(await verifyAdminPassword("wrong-password", SECRET), false);
		assert.equal(await verifyAdminPassword("short", "short"), false);
		assert.equal(await verifyAdminPassword("x".repeat(1025), SECRET), false);
	});

	it("creates expiring signed sessions and rejects tampering", async () => {
		const now = 1_800_000_000_000;
		const session = await createAdminSession(SECRET, now);
		assert.equal(await verifyAdminSession(session.token, SECRET, now), true);
		assert.equal(
			await verifyAdminSession(session.token, "b".repeat(64), now),
			false
		);
		assert.equal(
			await verifyAdminSession(session.token, SECRET, now + 8 * 60 * 60 * 1000),
			false
		);
		const [expiresAt, signature] = session.token.split(".");
		const changedToken = `${expiresAt}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
		assert.equal(await verifyAdminSession(changedToken, SECRET, now), false);
	});
});

describe("customer-entered payment amounts", () => {
	it("converts NPR decimal amounts to exact paisa", () => {
		assert.equal(parseNprAmountToPaise("1"), 100);
		assert.equal(parseNprAmountToPaise("1.2"), 120);
		assert.equal(parseNprAmountToPaise("100.05"), 10005);
		assert.equal(parseNprAmountToPaise(" 0.01 "), 1);
		assert.equal(
			parseNprAmountToPaise("90071992547409.91"),
			Number.MAX_SAFE_INTEGER
		);
	});

	it("rejects zero, negative, malformed, and unsafe amounts", () => {
		for (const value of [
			"0",
			"-1",
			"1.001",
			"1e3",
			"NaN",
			"90071992547409.92",
		]) {
			assert.equal(parseNprAmountToPaise(value), null, value);
		}
	});

	it("accepts only positive safe integer paisa from checkout requests", () => {
		assert.equal(isValidPaymentAmountPaise(1), true);
		assert.equal(isValidPaymentAmountPaise(Number.MAX_SAFE_INTEGER), true);
		assert.equal(isValidPaymentAmountPaise(0), false);
		assert.equal(isValidPaymentAmountPaise(-1), false);
		assert.equal(isValidPaymentAmountPaise(1.5), false);
		assert.equal(isValidPaymentAmountPaise(Number.MAX_SAFE_INTEGER + 1), false);
		assert.equal(isValidPaymentAmountPaise("100"), false);
	});
});

describe("provider callback verification", () => {
	it("verifies the exact raw callback body", async () => {
		const body = JSON.stringify({
			transactionId: PAYMENT_ID,
			providerTransactionId: "esewa-12345",
			status: "paid",
			amountPaise: 10000,
			currency: "NPR",
		});
		const signature = createHmac("sha256", SECRET).update(body).digest("hex");

		assert.equal(
			await verifyCallbackSignature(body, `sha256=${signature}`, SECRET),
			true
		);
		assert.equal(
			await verifyCallbackSignature(`${body} `, `sha256=${signature}`, SECRET),
			false
		);
		assert.equal(
			await verifyCallbackSignature(body, "not-a-signature", SECRET),
			false
		);
	});

	it("accepts only normalized callback data with a valid payment reference", () => {
		const payload = {
			transactionId: PAYMENT_ID,
			providerTransactionId: "bank-txn-88",
			status: "paid",
			amountPaise: 10000,
			currency: "NPR",
		};
		assert.deepEqual(parseCallbackPayload(payload, "citizens-bank"), {
			...payload,
			provider: "citizens-bank",
		});
		assert.equal(
			parseCallbackPayload(
				{ ...payload, amountPaise: "10000" },
				"citizens-bank"
			),
			null
		);
		assert.equal(
			parseCallbackPayload(
				{ ...payload, status: "confirmed" },
				"citizens-bank"
			),
			null
		);
		assert.equal(
			parseCallbackPayload(
				{ ...payload, transactionId: "not-a-uuid" },
				"citizens-bank"
			),
			null
		);
	});
});

describe("payment session JWT", () => {
	it("round-trips signed payment claims and rejects modified tokens", async () => {
		const token = await generateJWT(SECRET, PAYMENT_ID, "esewa", 300);
		const payload = await verifyJWT(token, SECRET);
		assert.ok(payload);
		assert.equal(payload.paid, true);
		assert.equal(payload.paymentId, PAYMENT_ID);
		assert.equal(payload.provider, "esewa");
		assert.equal(payload.exp - payload.iat, 300);

		const [header, encodedPayload, signature] = token.split(".");
		assert.equal(
			await verifyJWT(`${header}.${encodedPayload}.${signature}x`, SECRET),
			null
		);
		assert.equal(await verifyJWT(token, "b".repeat(64)), null);
	});

	it("refuses weak signing keys and invalid session lifetimes", async () => {
		await assert.rejects(() => generateJWT("short", PAYMENT_ID, "esewa"));
		await assert.rejects(() => generateJWT(SECRET, PAYMENT_ID, "esewa", 3601));
	});
});
