const loginForm = document.querySelector("#login-form");
const passwordInput = document.querySelector("#admin-password");
const paymentsSection = document.querySelector("#payments-section");
const paymentsList = document.querySelector("#payments-list");
const paymentsSummary = document.querySelector("#payments-summary");
const message = document.querySelector("#message");
const statusFilter = document.querySelector("#status-filter");
const previousPageButton = document.querySelector("#previous-page");
const nextPageButton = document.querySelector("#next-page");
const pageIndicator = document.querySelector("#page-indicator");
let currentPage = 1;
let currentStatus = "all";
let totalPages = 0;

function showMessage(text, isError = false) {
	message.textContent = text;
	message.classList.toggle("error", isError);
}

function formatAmount(amountPaise, currency) {
	return new Intl.NumberFormat("en-NP", {
		style: "currency",
		currency,
		minimumFractionDigits: 2,
	}).format(amountPaise / 100);
}

function providerLabel(provider) {
	return (
		{
			"citizens-bank": "Citizens Bank",
			esewa: "eSewa",
			"nepal-bank": "Nepal Bank",
		}[provider] || "Unknown provider"
	);
}

function addDetail(container, labelText, value) {
	const row = document.createElement("div");
	row.className = "payment-detail";
	const label = document.createElement("span");
	label.textContent = labelText;
	const content = document.createElement("strong");
	content.textContent = value;
	row.append(label, content);
	container.append(row);
}

function formatDate(value) {
	return value === null ? "Not available" : new Date(value).toLocaleString();
}

function renderSummary(summary, total) {
	paymentsSummary.replaceChildren();
	for (const [label, key] of [
		["All", "all"],
		["Paid", "paid"],
		["Pending", "pending"],
		["Failed", "failed"],
		["Expired", "expired"],
	]) {
		const item = document.createElement("div");
		item.className = "summary-item";
		const count = document.createElement("strong");
		count.textContent = String(summary[key] ?? 0);
		const name = document.createElement("span");
		name.textContent = label;
		item.append(count, name);
		paymentsSummary.append(item);
	}
	pageIndicator.textContent =
		total === 0
			? "No payments"
			: `Page ${currentPage} of ${totalPages} · ${total} payments`;
	previousPageButton.disabled = currentPage <= 1;
	nextPageButton.disabled = currentPage >= totalPages;
}

function renderPayments(payments) {
	paymentsList.replaceChildren();
	if (payments.length === 0) {
		const empty = document.createElement("p");
		empty.className = "empty";
		empty.textContent = "No payments found for this status.";
		paymentsList.append(empty);
		return;
	}

	for (const payment of payments) {
		const card = document.createElement("article");
		card.className = "payment-card";
		const heading = document.createElement("div");
		heading.className = "payment-card-heading";
		const amount = document.createElement("strong");
		amount.textContent = formatAmount(payment.amountPaise, payment.currency);
		const status = document.createElement("span");
		status.className = `status-badge ${payment.status}`;
		status.textContent = payment.status;
		heading.append(amount, status);
		const details = document.createElement("div");
		details.className = "payment-details";
		addDetail(
			details,
			"Customer",
			payment.customerName || "Not collected (older payment)"
		);
		addDetail(
			details,
			"Phone",
			payment.customerPhone || "Not collected (older payment)"
		);
		addDetail(details, "Payment method", providerLabel(payment.provider));
		addDetail(details, "Status", payment.status);
		addDetail(details, "Payment reference", payment.id);
		addDetail(
			details,
			"Provider transaction ID",
			payment.providerTransactionId || "Not provided"
		);
		addDetail(details, "Created", formatDate(payment.createdAt));
		addDetail(details, "Payment expiry", formatDate(payment.expiresAt));
		addDetail(details, "Verified", formatDate(payment.verifiedAt));
		addDetail(
			details,
			"Verification method",
			payment.verifiedAt === null
				? "Not verified"
				: payment.verificationMethod === "admin"
					? "Manually confirmed by admin"
					: "Provider callback"
		);

		card.append(heading, details);
		if (payment.status === "pending") {
			const confirmButton = document.createElement("button");
			confirmButton.type = "button";
			confirmButton.textContent = "Confirm received";
			confirmButton.addEventListener("click", () =>
				confirmPayment(payment, confirmButton)
			);
			card.append(confirmButton);
		}
		paymentsList.append(card);
	}
}

async function loadPayments(page = currentPage) {
	const params = new URLSearchParams({
		page: String(page),
		status: currentStatus,
	});
	const response = await fetch(`/api/admin/payments?${params}`, {
		credentials: "same-origin",
		cache: "no-store",
	});
	if (response.status === 401) {
		loginForm.hidden = false;
		paymentsSection.hidden = true;
		return;
	}
	const result = await response.json();
	if (!response.ok) {
		throw new Error(result.error || "Could not load pending payments.");
	}
	loginForm.hidden = true;
	paymentsSection.hidden = false;
	currentPage = result.page;
	totalPages = result.totalPages;
	renderSummary(result.summary, result.total);
	renderPayments(result.payments);
	showMessage("");
}

async function confirmPayment(payment, button) {
	const amount = formatAmount(payment.amountPaise, payment.currency);
	if (
		!window.confirm(
			`Have you received exactly ${amount} for payment ${payment.id}? This grants the customer access.`
		)
	) {
		return;
	}
	button.disabled = true;
	try {
		const response = await fetch(
			`/api/admin/payments/${encodeURIComponent(payment.id)}/confirm`,
			{ method: "POST", credentials: "same-origin" }
		);
		const result = await response.json();
		if (!response.ok) {
			throw new Error(result.error || "Could not confirm payment.");
		}
		showMessage(`Payment ${payment.id} was marked as received.`);
		await loadPayments();
	} catch (error) {
		showMessage(error.message, true);
		button.disabled = false;
	}
}

loginForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	showMessage("");
	try {
		const response = await fetch("/api/admin/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			credentials: "same-origin",
			body: JSON.stringify({ password: passwordInput.value }),
		});
		const result = await response.json();
		passwordInput.value = "";
		if (!response.ok) {
			throw new Error(result.error || "Sign-in failed.");
		}
		await loadPayments();
	} catch (error) {
		showMessage(error.message, true);
	}
});

document
	.querySelector("#refresh-button")
	.addEventListener("click", async () => {
		try {
			await loadPayments();
		} catch (error) {
			showMessage(error.message, true);
		}
	});

statusFilter.addEventListener("change", async () => {
	currentStatus = statusFilter.value;
	try {
		await loadPayments(1);
	} catch (error) {
		showMessage(error.message, true);
	}
});

previousPageButton.addEventListener("click", async () => {
	if (currentPage > 1) {
		try {
			await loadPayments(currentPage - 1);
		} catch (error) {
			showMessage(error.message, true);
		}
	}
});

nextPageButton.addEventListener("click", async () => {
	if (currentPage < totalPages) {
		try {
			await loadPayments(currentPage + 1);
		} catch (error) {
			showMessage(error.message, true);
		}
	}
});

document.querySelector("#logout-button").addEventListener("click", async () => {
	try {
		const response = await fetch("/api/admin/logout", {
			method: "POST",
			credentials: "same-origin",
		});
		if (!response.ok) {
			const result = await response.json();
			throw new Error(result.error || "Sign-out failed.");
		}
		paymentsSection.hidden = true;
		loginForm.hidden = false;
		currentPage = 1;
		currentStatus = "all";
		statusFilter.value = "all";
		showMessage("Signed out.");
	} catch (error) {
		showMessage(error.message, true);
	}
});

loadPayments().catch((error) => showMessage(error.message, true));
