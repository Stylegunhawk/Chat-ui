import { describe, expect, test, vi } from "vitest";

vi.mock("$env/dynamic/public", () => ({
	env: {},
}));

vi.mock("$env/dynamic/private", () => ({
	env: {},
}));

import { getEffectiveMcpToolTimeoutMs } from "./httpClient";

describe("getEffectiveMcpToolTimeoutMs", () => {
	test("uses the base timeout for regular tools", () => {
		expect(getEffectiveMcpToolTimeoutMs("search", 120_000)).toBe(120_000);
	});

	test("gives generate_data a longer minimum timeout", () => {
		expect(getEffectiveMcpToolTimeoutMs("generate_data", 120_000)).toBe(600_000);
	});

	test("does not reduce a configured timeout that is already longer", () => {
		expect(getEffectiveMcpToolTimeoutMs("generate_data", 900_000)).toBe(900_000);
	});
});
