const MAX_SAFE_AMOUNT_PAISE = BigInt(Number.MAX_SAFE_INTEGER);

export function parseNprAmountToPaise(value: string): number | null {
	const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
	if (!match) {
		return null;
	}

	const amountPaise =
		BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
	return amountPaise > 0n && amountPaise <= MAX_SAFE_AMOUNT_PAISE
		? Number(amountPaise)
		: null;
}

export function isValidPaymentAmountPaise(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
