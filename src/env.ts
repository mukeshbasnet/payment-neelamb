export type PaymentProvider = "citizens-bank" | "esewa" | "nepal-bank";

export interface Env extends CloudflareBindings {
	JWT_SECRET?: string;
	ADMIN_PASSWORD?: string;
	CITIZENS_CALLBACK_SECRET?: string;
	ESEWA_CALLBACK_SECRET?: string;
	NEPAL_BANK_CALLBACK_SECRET?: string;
}
