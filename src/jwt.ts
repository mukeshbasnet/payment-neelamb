/**
 * JWT utility functions using Web Crypto API (crypto.subtle)
 * Implements stateless authentication with HMAC-SHA256 signatures
 */

export interface JWTPayload {
	paid: true;
	paymentId: string;
	provider: "citizens-bank" | "esewa" | "nepal-bank";
	iat: number;
	exp: number;
}

/**
 * Base64URL encoding (URL-safe base64 without padding)
 */
function base64UrlEncode(data: BufferSource): string {
	// Convert to Uint8Array if it's an ArrayBuffer
	const bytes = ArrayBuffer.isView(data)
		? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
		: new Uint8Array(data);
	const base64 = btoa(String.fromCharCode(...bytes));
	return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Base64URL decoding
 */
function base64UrlDecode(str: string): Uint8Array {
	if (!/^[\w-]*$/.test(str)) {
		throw new Error("Invalid base64url value");
	}
	// Add padding back
	const paddedStr = str + "==".substring(0, (4 - (str.length % 4)) % 4);
	// Replace URL-safe characters
	const base64 = paddedStr.replace(/-/g, "+").replace(/_/g, "/");
	// Decode
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

/**
 * Convert string to Uint8Array
 */
function stringToArrayBuffer(str: string): Uint8Array {
	const encoder = new TextEncoder();
	return encoder.encode(str);
}

/**
 * Convert BufferSource to string
 */
function arrayBufferToString(buffer: BufferSource): string {
	const decoder = new TextDecoder();
	return decoder.decode(buffer);
}

/**
 * Import the JWT secret as a CryptoKey for HMAC operations
 */
async function importSecretKey(secret: string): Promise<CryptoKey> {
	const keyData = stringToArrayBuffer(secret);
	return await crypto.subtle.importKey(
		"raw",
		keyData,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"]
	);
}

/**
 * Generate a JWT token
 * @param secret - The secret key for signing
 * @param expiresInSeconds - Token validity duration (default: 3600 = 1 hour)
 * @returns JWT token string
 */
export async function generateJWT(
	secret: string,
	paymentId: string,
	provider: JWTPayload["provider"],
	expiresInSeconds = 3600
): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	if (
		new TextEncoder().encode(secret).byteLength < 32 ||
		!Number.isSafeInteger(expiresInSeconds) ||
		expiresInSeconds <= 0 ||
		expiresInSeconds > 3600
	) {
		throw new Error("Invalid session signing configuration");
	}

	// JWT Header
	const header = {
		alg: "HS256",
		typ: "JWT",
	};

	// JWT Payload
	const payload: JWTPayload = {
		paid: true,
		paymentId,
		provider,
		iat: now,
		exp: now + expiresInSeconds,
	};

	// Encode header and payload
	const encodedHeader = base64UrlEncode(
		stringToArrayBuffer(JSON.stringify(header))
	);
	const encodedPayload = base64UrlEncode(
		stringToArrayBuffer(JSON.stringify(payload))
	);

	// Create signature
	const dataToSign = `${encodedHeader}.${encodedPayload}`;
	const key = await importSecretKey(secret);
	const signatureBuffer = await crypto.subtle.sign(
		"HMAC",
		key,
		stringToArrayBuffer(dataToSign)
	);
	const encodedSignature = base64UrlEncode(signatureBuffer);

	// Return complete JWT
	return `${dataToSign}.${encodedSignature}`;
}

/**
 * Verify and decode a JWT token
 * @param token - The JWT token to verify
 * @param secret - The secret key for verification
 * @returns Decoded payload if valid, null otherwise
 */
export async function verifyJWT(
	token: string,
	secret: string
): Promise<JWTPayload | null> {
	try {
		// Split token into parts
		const parts = token.split(".");
		if (parts.length !== 3) {
			return null;
		}

		const [encodedHeader, encodedPayload, encodedSignature] = parts;
		if (token.length > 4096) {
			return null;
		}

		// Verify signature
		const dataToVerify = `${encodedHeader}.${encodedPayload}`;
		const key = await importSecretKey(secret);
		const signatureBuffer = base64UrlDecode(encodedSignature);

		const isValid = await crypto.subtle.verify(
			"HMAC",
			key,
			signatureBuffer,
			stringToArrayBuffer(dataToVerify)
		);

		if (!isValid) {
			return null;
		}

		const header = JSON.parse(
			arrayBufferToString(base64UrlDecode(encodedHeader))
		) as { alg?: unknown; typ?: unknown };
		if (header.alg !== "HS256" || header.typ !== "JWT") {
			return null;
		}

		// Decode and parse payload
		const payloadBuffer = base64UrlDecode(encodedPayload);
		const payloadStr = arrayBufferToString(payloadBuffer);
		const payload = JSON.parse(payloadStr) as Partial<JWTPayload>;

		// Check expiration
		const now = Math.floor(Date.now() / 1000);
		if (
			payload.paid !== true ||
			typeof payload.paymentId !== "string" ||
			!/^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(
				payload.paymentId
			) ||
			(payload.provider !== "citizens-bank" &&
				payload.provider !== "esewa" &&
				payload.provider !== "nepal-bank") ||
			typeof payload.iat !== "number" ||
			!Number.isSafeInteger(payload.iat) ||
			typeof payload.exp !== "number" ||
			!Number.isSafeInteger(payload.exp) ||
			payload.iat > now ||
			payload.exp <= now ||
			payload.exp <= payload.iat ||
			payload.exp - payload.iat > 3600
		) {
			return null; // Token expired
		}

		return {
			paid: true,
			paymentId: payload.paymentId,
			provider: payload.provider,
			iat: payload.iat,
			exp: payload.exp,
		};
	} catch {
		// Invalid token format or parsing error
		return null;
	}
}
