const SESSION_TTL_SECONDS = 8 * 60 * 60;
const PASSWORD_CHALLENGE = new TextEncoder().encode(
	"secure-payment-selector-admin-password:v1"
);
const SESSION_PREFIX = "secure-payment-selector-admin-session:v1:";

function isStrongSecret(secret: string): boolean {
	return new TextEncoder().encode(secret).byteLength >= 32;
}

async function importHmacKey(
	secret: string,
	usages: ("sign" | "verify")[]
): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		usages
	);
}

function encodeBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
	if (!/^[\w-]+$/.test(value)) {
		return null;
	}
	try {
		const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
		const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
		return Uint8Array.from(binary, (character) => character.charCodeAt(0));
	} catch {
		return null;
	}
}

export async function verifyAdminPassword(
	candidate: string,
	expected: string
): Promise<boolean> {
	if (
		!isStrongSecret(expected) ||
		candidate.length === 0 ||
		new TextEncoder().encode(candidate).byteLength > 1024
	) {
		return false;
	}
	const expectedSignature = await crypto.subtle.sign(
		"HMAC",
		await importHmacKey(expected, ["sign"]),
		PASSWORD_CHALLENGE
	);
	return crypto.subtle.verify(
		"HMAC",
		await importHmacKey(candidate, ["verify"]),
		expectedSignature,
		PASSWORD_CHALLENGE
	);
}

export async function createAdminSession(
	secret: string,
	now = Date.now()
): Promise<{ token: string; expiresAt: number }> {
	if (!isStrongSecret(secret)) {
		throw new Error("Admin password must contain at least 32 bytes");
	}
	const expiresAt = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
	const payload = `${SESSION_PREFIX}${expiresAt}`;
	const signature = await crypto.subtle.sign(
		"HMAC",
		await importHmacKey(secret, ["sign"]),
		new TextEncoder().encode(payload)
	);
	return {
		token: `${expiresAt}.${encodeBase64Url(new Uint8Array(signature))}`,
		expiresAt,
	};
}

export async function verifyAdminSession(
	token: string,
	secret: string,
	now = Date.now()
): Promise<boolean> {
	if (!isStrongSecret(secret) || token.length > 128) {
		return false;
	}
	const match = /^(\d{10})\.([\w-]{43})$/.exec(token);
	if (!match) {
		return false;
	}
	const expiresAt = Number(match[1]);
	const nowSeconds = Math.floor(now / 1000);
	if (
		!Number.isSafeInteger(expiresAt) ||
		expiresAt <= nowSeconds ||
		expiresAt > nowSeconds + SESSION_TTL_SECONDS
	) {
		return false;
	}
	const signature = decodeBase64Url(match[2]);
	if (!signature || signature.byteLength !== 32) {
		return false;
	}
	return crypto.subtle.verify(
		"HMAC",
		await importHmacKey(secret, ["verify"]),
		signature,
		new TextEncoder().encode(`${SESSION_PREFIX}${expiresAt}`)
	);
}

export const ADMIN_SESSION_TTL_SECONDS = SESSION_TTL_SECONDS;
