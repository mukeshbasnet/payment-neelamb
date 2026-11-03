const form = document.querySelector("#payment-form");
const methodsElement = document.querySelector("#payment-methods");
const loadingMessage = document.querySelector("#loading-message");
const amountInput = document.querySelector("#payment-amount");
const submitButton = document.querySelector("#submit-button");
const amountCurrency = document.querySelector("#amount-currency");
const errorMessage = document.querySelector("#error-message");
const paymentProgress = document.querySelector("#payment-progress");
const paymentReference = document.querySelector("#payment-reference");
const paymentDestination = document.querySelector("#payment-destination");
const paymentInstructions = document.querySelector("#payment-instructions");
const paymentQr = document.querySelector("#payment-qr");
const paymentQrImage = document.querySelector("#payment-qr-image");
const progressTitle = document.querySelector("#progress-title");
const progressDescription = document.querySelector("#progress-description");
const pendingNote = document.querySelector("#pending-note");
let activeTransaction = null;
let pollTimer = null;

paymentQrImage.addEventListener("error", () => {
	paymentQr.hidden = true;
});

const providerPresentation = {
	"citizens-bank": { short: "CB", detail: "Direct bank transfer" },
	esewa: { short: "eS", detail: "Digital wallet payment" },
	"nepal-bank": { short: "NB", detail: "Direct bank transfer" },
};

function formatAmount(amountPaise, currency) {
	return new Intl.NumberFormat("en-NP", {
		style: "currency",
		currency,
		minimumFractionDigits: 2,
	}).format(amountPaise / 100);
}

function showError(message) {
	errorMessage.textContent = message;
	errorMessage.hidden = false;
}

function clearError() {
	errorMessage.textContent = "";
	errorMessage.hidden = true;
}

function amountToPaise(value) {
	const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
	if (!match) {
		return null;
	}
	try {
		const amountPaise =
			BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0"));
		return amountPaise > 0n && amountPaise <= BigInt(Number.MAX_SAFE_INTEGER)
			? Number(amountPaise)
			: null;
	} catch {
		return null;
	}
}

function updateSubmitState() {
	submitButton.disabled =
		!form.querySelector('input[name="provider"]:checked') ||
		amountToPaise(amountInput.value) === null;
}

function renderMethods(config) {
	loadingMessage.remove();
	amountCurrency.textContent = config.currency;

	for (const method of config.methods) {
		const presentation = providerPresentation[method.id];
		const label = document.createElement("label");
		label.className = `method-card${method.enabled ? "" : " disabled"}`;

		const icon = document.createElement("span");
		icon.className = `method-icon ${method.id}`;
		icon.textContent = presentation.short;
		icon.setAttribute("aria-hidden", "true");

		const copy = document.createElement("span");
		const name = document.createElement("span");
		name.className = "method-name";
		name.textContent = method.label;
		const detail = document.createElement("span");
		detail.className = "method-description";
		detail.textContent = method.enabled
			? presentation.detail
			: "Not available yet";
		copy.append(name, document.createElement("br"), detail);

		const input = document.createElement("input");
		input.className = "method-radio";
		input.type = "radio";
		input.name = "provider";
		input.value = method.id;
		input.disabled = !method.enabled;
		input.setAttribute("aria-label", method.label);
		input.addEventListener("change", () => {
			document.querySelectorAll(".method-card").forEach((card) => {
				card.classList.remove("selected");
			});
			label.classList.add("selected");
			updateSubmitState();
			clearError();
		});

		label.append(icon, copy, input);
		methodsElement.append(label);
	}

	if (!config.methods.some((method) => method.enabled)) {
		showError("Payment methods are being configured. Please try again later.");
	}
}

async function loadConfig() {
	const response = await fetch("/api/config", {
		headers: { Accept: "application/json" },
	});
	if (!response.ok) {
		throw new Error("Could not load payment options.");
	}
	const config = await response.json();
	if (
		typeof config.currency !== "string" ||
		!/^[A-Z]{3}$/.test(config.currency) ||
		!Array.isArray(config.methods)
	) {
		throw new Error("Payment options are temporarily unavailable.");
	}
	renderMethods(config);
}

function stopPolling() {
	if (pollTimer !== null) {
		window.clearTimeout(pollTimer);
		pollTimer = null;
	}
}

async function pollPayment() {
	if (!activeTransaction) {
		return;
	}
	if (Date.now() >= activeTransaction.expiresAt) {
		progressTitle.textContent = "Payment reference expired";
		progressDescription.textContent =
			"Start a new checkout to receive a fresh payment reference.";
		pendingNote.hidden = true;
		stopPolling();
		return;
	}

	try {
		const response = await fetch(
			`/api/payments/${encodeURIComponent(activeTransaction.id)}`,
			{
				headers: { Accept: "application/json" },
				cache: "no-store",
			}
		);
		const result = await response.json();
		if (!response.ok) {
			throw new Error(result.error || "Could not check payment status.");
		}
		if (result.status === "paid") {
			paymentProgress.classList.add("paid");
			progressTitle.textContent = "Payment confirmed";
			progressDescription.textContent =
				"Your payment was verified. A secure session has been issued in this browser.";
			pendingNote.hidden = true;
			stopPolling();
			return;
		}
		if (result.status === "failed" || result.status === "expired") {
			progressTitle.textContent =
				result.status === "failed"
					? "Payment was not completed"
					: "Payment reference expired";
			progressDescription.textContent =
				"Start a new checkout if you would like to try again.";
			pendingNote.hidden = true;
			stopPolling();
			return;
		}
		pollTimer = window.setTimeout(pollPayment, 4000);
	} catch (error) {
		showError(
			error instanceof Error ? error.message : "Could not check payment status."
		);
		pollTimer = window.setTimeout(pollPayment, 6000);
	}
}

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	clearError();
	if (!form.reportValidity()) {
		return;
	}
	const selection = form.querySelector('input[name="provider"]:checked');
	const amountPaise = amountToPaise(amountInput.value);
	if (!selection || amountPaise === null) {
		showError("Enter a valid amount and choose a payment method to continue.");
		return;
	}

	submitButton.disabled = true;
	submitButton.querySelector("span").textContent = "Creating secure payment…";
	try {
		const response = await fetch("/api/payments", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({ provider: selection.value, amountPaise }),
		});
		const result = await response.json();
		if (!response.ok) {
			throw new Error(result.error || "Could not start payment.");
		}

		activeTransaction = result;
		paymentReference.textContent = result.id;
		paymentDestination.textContent = result.destination;
		paymentInstructions.textContent = result.instructions;
		paymentQr.hidden = !result.qrImage;
		if (result.qrImage) {
			paymentQrImage.src = result.qrImage;
			paymentQrImage.alt = `${result.provider} payment QR code`;
		} else {
			paymentQrImage.removeAttribute("src");
			paymentQrImage.alt = "";
		}
		progressTitle.textContent = "Payment reference created";
		progressDescription.textContent = `Pay ${formatAmount(result.amountPaise, result.currency)} using the details below.`;
		pendingNote.hidden = false;
		paymentProgress.hidden = false;
		form.hidden = true;
		pollTimer = window.setTimeout(pollPayment, 2000);
	} catch (error) {
		showError(
			error instanceof Error ? error.message : "Could not start payment."
		);
		submitButton.disabled = false;
		submitButton.querySelector("span").textContent = "Continue to payment";
	}
});

document.querySelector("#start-over").addEventListener("click", () => {
	stopPolling();
	activeTransaction = null;
	paymentProgress.hidden = true;
	paymentProgress.classList.remove("paid");
	form.hidden = false;
	updateSubmitState();
	submitButton.querySelector("span").textContent = "Continue to payment";
	clearError();
});

amountInput.addEventListener("input", updateSubmitState);

loadConfig().catch((error) => {
	loadingMessage.textContent =
		error instanceof Error
			? error.message
			: "Payment options are temporarily unavailable.";
});
