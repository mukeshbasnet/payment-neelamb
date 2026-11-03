import {
	verifyCallbackSignature,
	parseCallbackPayload,
} from "./payment-callback";
import {
	ADMIN_SESSION_TTL_SECONDS,
	createAdminSession,
	verifyAdminPassword,
	verifyAdminSession,
} from "./admin-auth";
import { isValidPaymentAmountPaise } from "./payment-amount";
import { generateJWT, verifyJWT } from "./jwt";
import type { Env, PaymentProvider } from "./env";

const COOKIE_NAME = "__Host-payment_session";
const ADMIN_COOKIE_NAME = "__Host-payment_admin";
const SESSION_TTL_SECONDS = 60 * 60;
const MAX_BODY_BYTES = 8 * 1024;
const PAYMENT_PROVIDERS: PaymentProvider[] = [
	"citizens-bank",
	"esewa",
	"nepal-bank",
];

interface PaymentTransaction {
	id: string;
	provider: PaymentProvider;
	amountPaise: number;
	currency: string;
	status: "pending" | "paid" | "failed" | "expired";
	createdAt: number;
	expiresAt: number;
	verifiedAt: number | null;
}

interface PaymentMethod {
	id: PaymentProvider;
	label: string;
	destination: string | null;
	qrImage: string | null;
	instructions: string;
}

function getQrImagePath(value: string | undefined): string | null {
	const path = value?.trim();
	if (
		!path ||
		!/^\/[A-Za-z0-9][A-Za-z0-9/_-]*\.(?:png|jpe?g|webp)$/i.test(path) ||
		path.split("/").some((segment) => segment === "." || segment === "..")
	) {
		return null;
	}
	return path;
}

function isProvider(value: string): value is PaymentProvider {
	return PAYMENT_PROVIDERS.includes(value as PaymentProvider);
}

function getMethods(env: Env): PaymentMethod[] {
	return [
		{
			id: "citizens-bank",
			label: "Citizens Bank",
			destination: env.CITIZENS_BANK_DESTINATION?.trim() || null,
			qrImage: getQrImagePath(env.CITIZENS_BANK_QR_IMAGE),
			instructions:
				"Scan the QR code or use the account details, enter the exact checkout amount, and include the payment reference in the remarks.",
		},
		{
			id: "esewa",
			label: "eSewa",
			destination: env.ESEWA_MERCHANT_ID?.trim() || null,
			qrImage: getQrImagePath(env.ESEWA_QR_IMAGE),
			instructions:
				"Scan the QR code, enter the exact checkout amount, and include the payment reference when prompted.",
		},
		{
			id: "nepal-bank",
			label: "Nepal Bank",
			destination: env.NEPAL_BANK_DESTINATION?.trim() || null,
			qrImage: getQrImagePath(env.NEPAL_BANK_QR_IMAGE),
			instructions:
				"Scan the QR code or use the account details, enter the exact checkout amount, and include the payment reference in the remarks.",
		},
	];
}

function hasSecret(secret: string | undefined): secret is string {
	return (
		typeof secret === "string" &&
		new TextEncoder().encode(secret).byteLength >= 32
	);
}

function callbackSecret(
	env: Env,
	provider: PaymentProvider
): string | undefined {
	switch (provider) {
		case "citizens-bank":
			return env.CITIZENS_CALLBACK_SECRET;
		case "esewa":
			return env.ESEWA_CALLBACK_SECRET;
		case "nepal-bank":
			return env.NEPAL_BANK_CALLBACK_SECRET;
	}
}

function jsonResponse(
	body: unknown,
	status = 200,
	additionalHeaders?: HeadersInit
): Response {
	const headers = new Headers(additionalHeaders);
	headers.set("Content-Type", "application/json; charset=utf-8");
	headers.set("Cache-Control", "no-store");
	headers.set("X-Content-Type-Options", "nosniff");
	return Response.json(body, { status, headers });
}

function sameOrigin(request: Request): boolean {
	const origin = request.headers.get("Origin");
	return origin === new URL(request.url).origin;
}

async function readLimitedBody(request: Request): Promise<string | null> {
	if (!request.body) {
		return "";
	}

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		totalBytes += value.byteLength;
		if (totalBytes > MAX_BODY_BYTES) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}

	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

function paymentStore(env: Env): DurableObjectStub {
	const id = env.PAYMENT_STORE.idFromName("payment-records");
	return env.PAYMENT_STORE.get(id);
}

async function callStore<T>(
	stub: DurableObjectStub,
	path: string,
	method: "GET" | "POST",
	body?: unknown
): Promise<{ response: Response; data: T | null }> {
	const response = await stub.fetch(`https://payment-store.internal${path}`, {
		method,
		headers:
			body === undefined ? undefined : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});

	let data: T | null = null;
	try {
		data = (await response.json()) as T;
	} catch {
		console.error(
			JSON.stringify({ message: "payment store returned invalid JSON" })
		);
	}
	return { response, data };
}

function parseExpiryMinutes(env: Env): number | null {
	const minutes = Number(env.PAYMENT_EXPIRY_MINUTES);
	return Number.isInteger(minutes) && minutes >= 5 && minutes <= 60
		? minutes
		: null;
}

function parsePaymentId(value: string): string | null {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		value
	)
		? value
		: null;
}

function paymentIdFromPath(pathname: string): string | null {
	const match = pathname.match(/^\/api\/payments\/([^/]+)$/);
	return match ? parsePaymentId(match[1]) : null;
}

function handleConfig(env: Env): Response {
	const expiryMinutes = parseExpiryMinutes(env);
	const currency = env.PAYMENT_CURRENCY || "NPR";
	const checkoutConfigured =
		expiryMinutes !== null && /^[A-Z]{3}$/.test(currency);
	const jwtReady = hasSecret(env.JWT_SECRET);
	const methods = getMethods(env).map((method) => {
		const verifierReady =
			hasSecret(callbackSecret(env, method.id)) ||
			hasSecret(env.ADMIN_PASSWORD);
		return {
			...method,
			enabled: Boolean(
				checkoutConfigured && method.destination && verifierReady && jwtReady
			),
		};
	});

	return jsonResponse({
		currency,
		expiryMinutes,
		methods,
	});
}

async function handleCreatePayment(
	request: Request,
	env: Env
): Promise<Response> {
	if (!sameOrigin(request)) {
		return jsonResponse({ error: "Origin is not allowed" }, 403);
	}
	if (
		!request.headers
			.get("Content-Type")
			?.toLowerCase()
			.startsWith("application/json")
	) {
		return jsonResponse({ error: "Expected application/json" }, 415);
	}
	if (!hasSecret(env.JWT_SECRET)) {
		return jsonResponse({ error: "Payment checkout is not configured" }, 503);
	}

	const rawBody = await readLimitedBody(request);
	if (rawBody === null) {
		return jsonResponse({ error: "Request body is too large" }, 413);
	}

	let input: unknown;
	try {
		input = JSON.parse(rawBody);
	} catch {
		return jsonResponse({ error: "Invalid JSON" }, 400);
	}
	if (
		typeof input !== "object" ||
		input === null ||
		!("provider" in input) ||
		typeof input.provider !== "string" ||
		!isProvider(input.provider) ||
		!("amountPaise" in input) ||
		!isValidPaymentAmountPaise(input.amountPaise)
	) {
		return jsonResponse(
			{ error: "Enter a valid amount and select a payment method" },
			400
		);
	}

	const method = getMethods(env).find(
		(candidate) => candidate.id === input.provider
	);
	if (
		!method?.destination ||
		(!hasSecret(callbackSecret(env, input.provider)) &&
			!hasSecret(env.ADMIN_PASSWORD))
	) {
		return jsonResponse(
			{ error: "This payment method is not configured for verification yet" },
			503
		);
	}
	if (!hasSecret(env.JWT_SECRET)) {
		return jsonResponse({ error: "Payment checkout is not configured" }, 503);
	}

	const amountPaise = input.amountPaise;
	const expiryMinutes = parseExpiryMinutes(env);
	const currency = env.PAYMENT_CURRENCY || "NPR";
	if (expiryMinutes === null || !/^[A-Z]{3}$/.test(currency)) {
		console.error(
			JSON.stringify({
				message: "invalid payment amount or expiry configuration",
			})
		);
		return jsonResponse({ error: "Payment checkout is not configured" }, 503);
	}

	const now = Date.now();
	const transaction: PaymentTransaction = {
		id: crypto.randomUUID(),
		provider: input.provider,
		amountPaise,
		currency,
		status: "pending",
		createdAt: now,
		expiresAt: now + expiryMinutes * 60_000,
		verifiedAt: null,
	};
	const { response } = await callStore<{ error?: string }>(
		paymentStore(env),
		"/transactions",
		"POST",
		transaction
	);
	if (!response.ok) {
		console.error(
			JSON.stringify({
				message: "could not create payment transaction",
				status: response.status,
			})
		);
		return jsonResponse({ error: "Could not start payment" }, 503);
	}

	return jsonResponse({
		id: transaction.id,
		provider: method.id,
		amountPaise,
		currency: transaction.currency,
		status: "pending",
		expiresAt: transaction.expiresAt,
		destination: method.destination,
		qrImage: method.qrImage,
		instructions: method.instructions,
	});
}

async function handlePaymentStatus(
	env: Env,
	paymentId: string
): Promise<Response> {
	const { response, data } = await callStore<PaymentTransaction>(
		paymentStore(env),
		`/transactions/${paymentId}`,
		"GET"
	);
	if (response.status === 404) {
		return jsonResponse({ error: "Payment transaction not found" }, 404);
	}
	if (!response.ok || !data) {
		return jsonResponse({ error: "Could not read payment status" }, 503);
	}

	const headers = new Headers();
	if (data.status === "paid" && data.verifiedAt !== null) {
		const expiresAt = Math.floor(data.verifiedAt / 1000) + SESSION_TTL_SECONDS;
		const remainingSeconds = expiresAt - Math.floor(Date.now() / 1000);
		if (remainingSeconds > 0) {
			if (!hasSecret(env.JWT_SECRET)) {
				console.error(
					JSON.stringify({ message: "JWT_SECRET is missing or too short" })
				);
				return jsonResponse(
					{ error: "Payment confirmed; session is not configured" },
					503
				);
			}
			const token = await generateJWT(
				env.JWT_SECRET,
				data.id,
				data.provider,
				remainingSeconds
			);
			headers.append(
				"Set-Cookie",
				`${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${remainingSeconds}`
			);
		}
	}

	return jsonResponse(
		{
			id: data.id,
			provider: data.provider,
			amountPaise: data.amountPaise,
			currency: data.currency,
			status: data.status,
			createdAt: data.createdAt,
			expiresAt: data.expiresAt,
		},
		200,
		headers
	);
}

async function handleCallback(
	request: Request,
	env: Env,
	providerName: string
): Promise<Response> {
	if (!isProvider(providerName)) {
		return jsonResponse({ error: "Unknown payment provider" }, 404);
	}
	if (
		!request.headers
			.get("Content-Type")
			?.toLowerCase()
			.startsWith("application/json")
	) {
		return jsonResponse({ error: "Expected application/json" }, 415);
	}

	const rawBody = await readLimitedBody(request);
	if (rawBody === null) {
		return jsonResponse({ error: "Request body is too large" }, 413);
	}

	const secret = callbackSecret(env, providerName);
	if (!hasSecret(secret)) {
		console.error(
			JSON.stringify({
				message: "provider callback secret is not configured",
				provider: providerName,
			})
		);
		return jsonResponse(
			{ error: "Callback verification is not configured" },
			503
		);
	}

	const signature = request.headers.get("X-Payment-Signature");
	if (
		!signature ||
		!(await verifyCallbackSignature(rawBody, signature, secret))
	) {
		return jsonResponse({ error: "Invalid callback signature" }, 401);
	}

	let value: unknown;
	try {
		value = JSON.parse(rawBody);
	} catch {
		return jsonResponse({ error: "Invalid callback JSON" }, 400);
	}
	const callback = parseCallbackPayload(value, providerName);
	if (!callback) {
		return jsonResponse({ error: "Invalid callback payload" }, 400);
	}

	const { response, data } = await callStore<{
		status?: string;
		error?: string;
	}>(
		paymentStore(env),
		`/transactions/${callback.transactionId}/verify`,
		"POST",
		callback
	);
	if (!response.ok) {
		return jsonResponse(
			{ error: data?.error ?? "Callback did not match a pending payment" },
			response.status
		);
	}

	return jsonResponse({ received: true, status: data?.status });
}

function readAuthToken(request: Request): string | null {
	return readCookie(request, COOKIE_NAME);
}

function readCookie(request: Request, name: string): string | null {
	const cookieHeader = request.headers.get("Cookie");
	if (!cookieHeader) {
		return null;
	}
	for (const cookie of cookieHeader.split(";")) {
		const separator = cookie.indexOf("=");
		if (separator >= 0 && cookie.slice(0, separator).trim() === name) {
			return cookie.slice(separator + 1).trim();
		}
	}
	return null;
}

async function isAdminAuthenticated(
	request: Request,
	env: Env
): Promise<boolean> {
	const secret = env.ADMIN_PASSWORD;
	const token = readCookie(request, ADMIN_COOKIE_NAME);
	return Boolean(
		hasSecret(secret) && token && (await verifyAdminSession(token, secret))
	);
}

async function handleAdminLogin(request: Request, env: Env): Promise<Response> {
	if (!sameOrigin(request)) {
		return jsonResponse({ error: "Origin is not allowed" }, 403);
	}
	if (!hasSecret(env.ADMIN_PASSWORD)) {
		return jsonResponse(
			{ error: "Admin authentication is not configured" },
			503
		);
	}
	if (
		!request.headers
			.get("Content-Type")
			?.toLowerCase()
			.startsWith("application/json")
	) {
		return jsonResponse({ error: "Expected application/json" }, 415);
	}
	const rawBody = await readLimitedBody(request);
	if (rawBody === null) {
		return jsonResponse({ error: "Request body is too large" }, 413);
	}
	let value: unknown;
	try {
		value = JSON.parse(rawBody);
	} catch {
		return jsonResponse({ error: "Invalid JSON" }, 400);
	}
	if (
		typeof value !== "object" ||
		value === null ||
		!("password" in value) ||
		typeof value.password !== "string" ||
		!(await verifyAdminPassword(value.password, env.ADMIN_PASSWORD))
	) {
		return jsonResponse({ error: "Invalid admin credentials" }, 401);
	}

	const session = await createAdminSession(env.ADMIN_PASSWORD);
	return jsonResponse(
		{ authenticated: true, expiresAt: session.expiresAt },
		200,
		{
			"Set-Cookie": `${ADMIN_COOKIE_NAME}=${session.token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${ADMIN_SESSION_TTL_SECONDS}`,
		}
	);
}

async function handleAdminLogout(
	request: Request,
	env: Env
): Promise<Response> {
	if (!sameOrigin(request)) {
		return jsonResponse({ error: "Origin is not allowed" }, 403);
	}
	if (!(await isAdminAuthenticated(request, env))) {
		return jsonResponse({ error: "Admin authentication required" }, 401);
	}
	return jsonResponse({ authenticated: false }, 200, {
		"Set-Cookie": `${ADMIN_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
	});
}

async function handleAdminPayments(
	request: Request,
	env: Env
): Promise<Response> {
	if (request.headers.has("Origin") && !sameOrigin(request)) {
		return jsonResponse({ error: "Origin is not allowed" }, 403);
	}
	if (!(await isAdminAuthenticated(request, env))) {
		return jsonResponse({ error: "Admin authentication required" }, 401);
	}
	const { response, data } = await callStore<{
		payments?: PaymentTransaction[];
		limit?: number;
	}>(paymentStore(env), "/transactions", "GET");
	if (!response.ok || !data?.payments) {
		return jsonResponse({ error: "Could not read pending payments" }, 503);
	}
	return jsonResponse(data);
}

async function handleAdminConfirm(
	request: Request,
	env: Env,
	paymentId: string
): Promise<Response> {
	if (!sameOrigin(request)) {
		return jsonResponse({ error: "Origin is not allowed" }, 403);
	}
	if (!(await isAdminAuthenticated(request, env))) {
		return jsonResponse({ error: "Admin authentication required" }, 401);
	}
	const { response, data } = await callStore<{
		status?: string;
		error?: string;
	}>(paymentStore(env), `/transactions/${paymentId}/admin-confirm`, "POST");
	if (!response.ok) {
		return jsonResponse(
			{ error: data?.error ?? "Could not confirm payment receipt" },
			response.status
		);
	}
	return jsonResponse({ id: paymentId, status: data?.status });
}

async function handleSession(request: Request, env: Env): Promise<Response> {
	if (!hasSecret(env.JWT_SECRET)) {
		return jsonResponse(
			{ error: "Session authentication is not configured" },
			503
		);
	}
	const token = readAuthToken(request);
	if (!token) {
		return jsonResponse({ authenticated: false }, 401);
	}
	const payload = await verifyJWT(token, env.JWT_SECRET);
	if (!payload) {
		return jsonResponse({ authenticated: false }, 401, {
			"Set-Cookie": `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
		});
	}
	return jsonResponse({
		authenticated: true,
		paymentId: payload.paymentId,
		expiresAt: payload.exp,
	});
}

function addSecurityHeaders(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.set(
		"Content-Security-Policy",
		"default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'"
	);
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("X-Frame-Options", "DENY");
	headers.set("Referrer-Policy", "no-referrer");
	headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		try {
			if (url.pathname === "/api/health" && request.method === "GET") {
				return addSecurityHeaders(
					jsonResponse({ status: "ok", service: "payment-selector" })
				);
			}
			if (url.pathname === "/api/config" && request.method === "GET") {
				return addSecurityHeaders(handleConfig(env));
			}
			if (url.pathname === "/api/payments" && request.method === "POST") {
				return addSecurityHeaders(await handleCreatePayment(request, env));
			}
			if (url.pathname === "/api/session" && request.method === "GET") {
				return addSecurityHeaders(await handleSession(request, env));
			}
			if (url.pathname === "/api/admin/login" && request.method === "POST") {
				return addSecurityHeaders(await handleAdminLogin(request, env));
			}
			if (url.pathname === "/api/admin/logout" && request.method === "POST") {
				return addSecurityHeaders(await handleAdminLogout(request, env));
			}
			if (url.pathname === "/api/admin/payments" && request.method === "GET") {
				return addSecurityHeaders(await handleAdminPayments(request, env));
			}
			const adminConfirmMatch = url.pathname.match(
				/^\/api\/admin\/payments\/([^/]+)\/confirm$/
			);
			if (adminConfirmMatch && request.method === "POST") {
				const paymentId = parsePaymentId(adminConfirmMatch[1]);
				return addSecurityHeaders(
					paymentId
						? await handleAdminConfirm(request, env, paymentId)
						: jsonResponse({ error: "Invalid payment reference" }, 400)
				);
			}
			if (url.pathname === "/admin" && request.method === "GET") {
				return addSecurityHeaders(
					Response.redirect(new URL("/admin.html", request.url).toString(), 302)
				);
			}
			if (
				url.pathname.startsWith("/api/payments/") &&
				request.method === "GET"
			) {
				if (request.headers.has("Origin") && !sameOrigin(request)) {
					return addSecurityHeaders(
						jsonResponse({ error: "Origin is not allowed" }, 403)
					);
				}
				const paymentId = paymentIdFromPath(url.pathname);
				return addSecurityHeaders(
					paymentId
						? await handlePaymentStatus(env, paymentId)
						: jsonResponse({ error: "Invalid payment reference" }, 400)
				);
			}
			if (
				url.pathname.startsWith("/api/callbacks/") &&
				request.method === "POST"
			) {
				const provider = url.pathname.slice("/api/callbacks/".length);
				return addSecurityHeaders(await handleCallback(request, env, provider));
			}
			if (url.pathname.startsWith("/api/")) {
				return addSecurityHeaders(jsonResponse({ error: "Not found" }, 404));
			}

			if (request.method !== "GET" && request.method !== "HEAD") {
				return addSecurityHeaders(
					jsonResponse({ error: "Method not allowed" }, 405)
				);
			}
			return addSecurityHeaders(await env.ASSETS.fetch(request));
		} catch (error) {
			console.error(
				JSON.stringify({
					message: "payment request failed",
					path: url.pathname,
					error: error instanceof Error ? error.message : "Unknown error",
				})
			);
			return addSecurityHeaders(
				jsonResponse({ error: "Internal server error" }, 500)
			);
		}
	},
} satisfies ExportedHandler<Env>;

export { PaymentStore } from "./payment-store";
