const loginForm = document.querySelector("#login-form");
const passwordInput = document.querySelector("#admin-password");
const paymentsSection = document.querySelector("#payments-section");
const paymentsList = document.querySelector("#payments-list");
const message = document.querySelector("#message");
const currencyFormatter = new Intl.NumberFormat("en-NP", {
	style: "currency",
	currency: "NPR",
});

function showMessage(text, isError = false) {
	message.textContent = text;
	message.classList.toggle("error", isError);
}

function formatAmount(amountPaise) {
	return currencyFormatter.format(amountPaise / 100);
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

function renderPayments(payments) {
	paymentsList.replaceChildren();
	if (payments.length === 0) {
		const empty = document.createElement("p");
		empty.className = "empty";
		empty.textContent = "There are no pending payments.";
		paymentsList.append(empty);
		return;
	}

	for (const payment of payments) {
		const card = document.createElement("article");
		card.className = "payment-card";
		const details = document.createElement("div");
		const amount = document.createElement("strong");
		amount.textContent = formatAmount(payment.amountPaise);
		const provider = document.createElement("p");
		provider.textContent = providerLabel(payment.provider);
		const reference = document.createElement("code");
		reference.textContent = payment.id;
		const created = document.createElement("p");
		created.textContent = `Created ${new Date(payment.createdAt).toLocaleString()}`;
		details.append(amount, provider, reference, created);

		const confirmButton = document.createElement("button");
		confirmButton.type = "button";
		confirmButton.textContent = "Confirm received";
		confirmButton.addEventListener("click", () =>
			confirmPayment(payment, confirmButton)
		);
		card.append(details, confirmButton);
		paymentsList.append(card);
	}
}

async function loadPayments() {
	const response = await fetch("/api/admin/payments", {
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
	renderPayments(result.payments);
	showMessage("");
}

async function confirmPayment(payment, button) {
	const amount = formatAmount(payment.amountPaise);
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
		showMessage("Signed out.");
	} catch (error) {
		showMessage(error.message, true);
	}
});

loadPayments().catch((error) => showMessage(error.message, true));
