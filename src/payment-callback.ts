import type { PaymentProvider } from "./env";

export interface VerifiedPaymentCallback {
	transactionId: string;
	provider: PaymentProvider;
	providerTransactionId: string;
	status: "paid" | "failed";
	amountPaise: number;
	currency: string;
}

const PAYMENT_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function verifyCallbackSignature(
	rawBody: string,
	signature: string,
	secret: string
): Promise<boolean> {
	const signatureHex = signature.startsWith("sha256=")
		? signature.slice("sha256=".length)
		: signature;
	if (!/^[\da-f]{64}$/i.test(signatureHex)) {
		return false;
	}

	const signatureBytes = new Uint8Array(32);
	for (let index = 0; index < signatureBytes.length; index += 1) {
		signatureBytes[index] = Number.parseInt(
			signatureHex.slice(index * 2, index * 2 + 2),
			16
		);
	}
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"]
	);
	return crypto.subtle.verify(
		"HMAC",
		key,
		signatureBytes,
		new TextEncoder().encode(rawBody)
	);
}

export function parseCallbackPayload(
	value: unknown,
	provider: PaymentProvider
): VerifiedPaymentCallback | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}

	const payload = value as Record<string, unknown>;
	if (
		typeof payload.transactionId !== "string" ||
		!PAYMENT_ID_PATTERN.test(payload.transactionId) ||
		typeof payload.providerTransactionId !== "string" ||
		payload.providerTransactionId.length < 1 ||
		payload.providerTransactionId.length > 200 ||
		(payload.status !== "paid" && payload.status !== "failed") ||
		typeof payload.amountPaise !== "number" ||
		!Number.isSafeInteger(payload.amountPaise) ||
		payload.amountPaise <= 0 ||
		typeof payload.currency !== "string" ||
		!/^[A-Z]{3}$/.test(payload.currency)
	) {
		return null;
	}

	return {
		transactionId: payload.transactionId,
		provider,
		providerTransactionId: payload.providerTransactionId,
		status: payload.status,
		amountPaise: payload.amountPaise,
		currency: payload.currency,
	};
}
