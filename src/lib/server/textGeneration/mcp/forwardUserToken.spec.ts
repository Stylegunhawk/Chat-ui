import { describe, expect, it, vi, beforeEach } from "vitest";

const mockConfig = vi.hoisted(() => ({
	OPENAI_FORWARD_USER_TOKEN: "",
	OPENAI_BASE_URL: "https://router.huggingface.co/v1",
}));

vi.mock("$lib/server/config", () => ({ config: mockConfig }));
vi.mock("$lib/server/logger", () => ({ logger: { warn: vi.fn() } }));

import { userTokenHeaders } from "./forwardUserToken";

const localsWithToken = { token: "abc" } as unknown as App.Locals;

describe("userTokenHeaders", () => {
	beforeEach(() => {
		mockConfig.OPENAI_FORWARD_USER_TOKEN = "";
		mockConfig.OPENAI_BASE_URL = "https://router.huggingface.co/v1";
	});

	it("returns no header when the flag is off (default), even with a valid URL and token", () => {
		expect(userTokenHeaders(localsWithToken)).toEqual({});
	});

	it("forwards the token when the flag is on and the URL is valid", () => {
		mockConfig.OPENAI_FORWARD_USER_TOKEN = "true";
		expect(userTokenHeaders(localsWithToken)).toEqual({ Authorization: "Bearer abc" });
	});

	it("does not forward when the flag is on but the URL fails isValidUrl", () => {
		mockConfig.OPENAI_FORWARD_USER_TOKEN = "true";
		mockConfig.OPENAI_BASE_URL = "http://evil.example.com/v1"; // non-loopback http
		expect(userTokenHeaders(localsWithToken)).toEqual({});
	});

	it("does not forward when the flag is on but there is no token", () => {
		mockConfig.OPENAI_FORWARD_USER_TOKEN = "true";
		expect(userTokenHeaders({} as unknown as App.Locals)).toEqual({});
		expect(userTokenHeaders(undefined)).toEqual({});
	});

	it("confirms the primary prod base URL passes isValidUrl (flag-on path works)", () => {
		mockConfig.OPENAI_FORWARD_USER_TOKEN = "true";
		mockConfig.OPENAI_BASE_URL = "https://router.huggingface.co/v1";
		expect(userTokenHeaders(localsWithToken)).toEqual({ Authorization: "Bearer abc" });
	});
});
