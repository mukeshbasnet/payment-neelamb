export interface CustomerDetails {
	customerName: string;
	customerPhone: string;
}

export function parseCustomerDetails(
	name: unknown,
	phone: unknown
): CustomerDetails | null {
	if (
		typeof name !== "string" ||
		typeof phone !== "string" ||
		/[\u0000-\u001f\u007f]/.test(name)
	) {
		return null;
	}

	const customerName = name.trim();
	const normalizedPhone = phone.trim().replace(/[\s().-]/g, "");
	const phoneDigits = normalizedPhone.replace(/^\+/, "");
	if (
		customerName.length < 2 ||
		customerName.length > 100 ||
		!/^\+?\d{7,15}$/.test(normalizedPhone) ||
		phoneDigits.length < 7 ||
		phoneDigits.length > 15
	) {
		return null;
	}

	return { customerName, customerPhone: normalizedPhone };
}
