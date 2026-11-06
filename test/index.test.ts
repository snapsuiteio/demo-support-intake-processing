import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker, { handleEmail } from "../src/index";

type TestEnv = Omit<Env, "ALLOWED_RECIPIENT_DOMAIN" | "ALLOWED_SENDERS" | "FORWARD_TO" | "ROUTE_ADDRESS"> & {
	ALLOWED_RECIPIENT_DOMAIN: string;
	ALLOWED_SENDERS: string;
	EMAIL_FORWARD_TO: string;
	FORWARD_TO: string;
	ROUTE_ADDRESS: string;
};

function createMessage(to = "support@company.example", from = "anyone@sender.example") {
	const forward = vi.fn<ForwardableEmailMessage["forward"]>();
	const setReject = vi.fn<ForwardableEmailMessage["setReject"]>();

	return {
		message: {
			from,
			to,
			forward,
			setReject,
		} as unknown as ForwardableEmailMessage,
		forward,
		setReject,
	};
}

function createEnv(overrides: Partial<TestEnv> = {}): Env {
	return {
		ASSETS: {} as Fetcher,
		ALLOWED_RECIPIENT_DOMAIN: "company.example",
		ALLOWED_SENDERS: "trusted@partner.example",
		EMAIL_FORWARD_TO: "private-destination@test.invalid",
		FORWARD_TO: "owner@mailbox.example",
		ROUTE_ADDRESS: "support@company.example",
		...overrides,
	} as TestEnv as Env;
}

function htmlAssets(html: string): Fetcher {
	return {
		fetch: vi.fn(() =>
			Promise.resolve(
				new Response(html, { headers: { "Content-Type": "text/html" } }),
			),
		),
	} as unknown as Fetcher;
}

describe("Email Routing Worker", () => {
	it("serves setup guidance", async () => {
		const response = await SELF.fetch("https://example.com");

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		const html = await response.text();
		expect(html).toContain("Email Routing starter");
		expect(html).toContain("configuration-warning");
	});

	it("renders setup addresses without exposing the private forwarding destination", async () => {
		const response = await worker.fetch(
			new Request("https://worker.test/"),
			createEnv({
				ALLOWED_SENDERS: "private-sender@test.invalid",
				ASSETS: htmlAssets(`
					<span id="route-address"></span>
					<span id="forward-to"></span>
					<span id="allowed-senders-state"></span>
					<div id="configuration-warning">Configure</div>
				`),
				FORWARD_TO: "destination@test.invalid",
				ROUTE_ADDRESS: "support@test.invalid",
			}),
		);
		const html = await response.text();

		expect(html).toContain("support@test.invalid");
		expect(html).toContain("destination@test.invalid");
		expect(html).toContain("Configured");
		expect(html).not.toContain("private-sender@test.invalid");
		expect(html).not.toContain("private-destination@test.invalid");
		expect(html).not.toContain("configuration-warning");
	});

	it("forwards email to the catch-all domain from any sender", async () => {
		const { message, forward, setReject } = createMessage();

		await handleEmail(message, createEnv());

		expect(forward).toHaveBeenCalledWith("private-destination@test.invalid");
		expect(setReject).not.toHaveBeenCalled();
	});

	it("normalizes the recipient domain and accepts other local parts", async () => {
		const { message, forward } = createMessage("SALES+TEST@COMPANY.EXAMPLE");

		await handleEmail(
			message,
			createEnv({
				ALLOWED_RECIPIENT_DOMAIN: " Company.Example ",
			}),
		);

		expect(forward).toHaveBeenCalledOnce();
	});

	it.each([
		"support@unrelated.example",
		"support@sub.company.example",
		"support@company.example.unrelated.example",
	])("rejects mail to %s even from a matching sender domain", async (to) => {
		const { message, forward, setReject } = createMessage(to, "sender@company.example");

		await handleEmail(message, createEnv());

		expect(setReject).toHaveBeenCalledWith("Recipient domain is not allowed");
		expect(forward).not.toHaveBeenCalled();
	});

	it("rejects email when the destination is missing", async () => {
		const { message, forward, setReject } = createMessage();

		await handleEmail(message, createEnv({ EMAIL_FORWARD_TO: " " }));

		expect(setReject).toHaveBeenCalledWith("Email routing is not configured");
		expect(forward).not.toHaveBeenCalled();
	});

	it("rejects email when the allowed recipient domain is empty", async () => {
		const { message, forward, setReject } = createMessage();

		await handleEmail(message, createEnv({ ALLOWED_RECIPIENT_DOMAIN: " " }));

		expect(setReject).toHaveBeenCalledWith("Email routing is not configured");
		expect(forward).not.toHaveBeenCalled();
	});

	it("propagates forwarding failures", async () => {
		const { message, forward } = createMessage();
		forward.mockRejectedValue(new Error("forward failed"));

		await expect(handleEmail(message, createEnv())).rejects.toThrow(
			"forward failed",
		);
	});
});
