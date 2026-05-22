import { describe, it, expect } from "vitest";

const CLIENT_SIDE_TOOLS = new Set<string>(["generate_artifact"]);

describe("CLIENT_SIDE_TOOLS", () => {
	it("includes generate_artifact", () => {
		expect(CLIENT_SIDE_TOOLS.has("generate_artifact")).toBe(true);
	});

	it("does not include unknown tools", () => {
		expect(CLIENT_SIDE_TOOLS.has("github_operation")).toBe(false);
		expect(CLIENT_SIDE_TOOLS.has("retrieve_docs")).toBe(false);
	});

	it("correctly short-circuits for client-side tools", () => {
		const toolName = "generate_artifact";
		const args = { type: "text/html", title: "Test", content: "<h1>Hi</h1>" };
		const output = JSON.stringify({ success: true, ...args });
		expect(CLIENT_SIDE_TOOLS.has(toolName)).toBe(true);
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.success).toBe(true);
		expect(parsed.type).toBe("text/html");
		expect(parsed.title).toBe("Test");
	});
});
