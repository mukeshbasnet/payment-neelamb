export type AdminPaymentStatus =
	| "all"
	| "pending"
	| "paid"
	| "failed"
	| "expired";

export interface AdminPaymentQuery {
	page: number;
	status: AdminPaymentStatus;
}

const STATUSES: AdminPaymentStatus[] = [
	"all",
	"pending",
	"paid",
	"failed",
	"expired",
];

function isAdminPaymentStatus(value: string): value is AdminPaymentStatus {
	return STATUSES.some((status) => status === value);
}

export function parseAdminPaymentQuery(
	params: URLSearchParams
): AdminPaymentQuery | null {
	const pageValue = params.get("page") ?? "1";
	const statusValue = params.get("status") ?? "all";
	if (
		!/^[1-9]\d*$/.test(pageValue) ||
		!Number.isSafeInteger(Number(pageValue)) ||
		!isAdminPaymentStatus(statusValue)
	) {
		return null;
	}
	return {
		page: Number(pageValue),
		status: statusValue,
	};
}
