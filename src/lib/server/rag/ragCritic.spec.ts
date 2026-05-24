import { describe, expect, it, vi } from "vitest";

import { evaluate, reformulateQuery } from "./ragCritic";
import type { ChatFileChunk } from "$lib/rag/client";

function chunk(overrides: Partial<ChatFileChunk>): ChatFileChunk {
	return {
		id: "c_default",
		fileId: "f_default",
		filename: "default.py",
		fileType: "text/x-python",
		fileUrl: "",
		text: "code",
		similarity: 0.8,
		role: "entry",
		is_graph_expansion: false,
		...overrides,
	};
}

describe("ragCritic.evaluate", () => {
	it("returns EMPTY for zero chunks", () => {
		expect(evaluate([]).verdict).toBe("EMPTY");
	});

	it("returns PASS when there is a strong direct hit and an entry chunk", () => {
		const result = evaluate([
			chunk({ similarity: 0.84, role: "entry", is_graph_expansion: false }),
			chunk({ similarity: 0.6, role: "supporting" }),
		]);
		expect(result.verdict).toBe("PASS");
	});

	it("returns RETRY when max similarity is below floor and there is no entry chunk", () => {
		const result = evaluate([
			chunk({ similarity: 0.4, role: "supporting" }),
			chunk({ similarity: 0.35, role: "supporting" }),
		]);
		expect(result.verdict).toBe("RETRY");
	});

	it("returns PASS when vector score is weak but useful graph context arrives", () => {
		const result = evaluate([
			chunk({ similarity: 0.4, role: "supporting", is_graph_expansion: false }),
			chunk({ similarity: 0, role: "entry", is_graph_expansion: true }),
			chunk({ similarity: 0, role: "dependency", is_graph_expansion: true }),
		]);
		expect(result.verdict).toBe("PASS");
		expect(result.reason).toMatch(/graph/i);
	});

	it("returns RETRY when all chunks are graph-expanded", () => {
		const result = evaluate([
			chunk({ similarity: 0, role: "entry", is_graph_expansion: true }),
			chunk({ similarity: 0, role: "dependency", is_graph_expansion: true }),
			chunk({ similarity: 0, role: "supporting", is_graph_expansion: true }),
		]);
		expect(result.verdict).toBe("RETRY");
	});

	it("returns RETRY when scores are strong but no entry-role chunk", () => {
		const result = evaluate([
			chunk({ similarity: 0.82, role: "supporting" }),
			chunk({ similarity: 0.75, role: "dependency" }),
		]);
		expect(result.verdict).toBe("RETRY");
	});

	it("computes signals correctly, maxSimilarity ignores graph-expansion chunks", () => {
		const result = evaluate([
			chunk({ similarity: 0.5, role: "supporting", is_graph_expansion: false }),
			chunk({ similarity: 1.0, role: "dependency", is_graph_expansion: true }),
		]);
		expect(result.signals.maxSimilarity).toBe(0.5);
		expect(result.signals.graphOnlyRatio).toBe(0.5);
	});

	it("handles null similarity gracefully", () => {
		const result = evaluate([chunk({ similarity: null, role: "entry" })]);
		expect(result.signals.maxSimilarity).toBe(0);
		expect(result.verdict).toBe("RETRY");
	});
});

describe("ragCritic.reformulateQuery", () => {
	it("returns the LLM-generated rewrite on success", async () => {
		const llm = vi.fn(async () => "login authentication handler function");
		const result = await reformulateQuery({
			userQuery: "thing that handles login",
			fileNames: ["auth.py", "session.py"],
			maxSim: 0.4,
			callLlm: llm,
		});
		expect(result).toBe("login authentication handler function");
		expect(llm).toHaveBeenCalledOnce();
	});

	it("falls back when the LLM call returns empty text", async () => {
		const llm = vi.fn(async () => "");
		const result = await reformulateQuery({
			userQuery: "thing that handles login",
			fileNames: ["auth.py"],
			maxSim: 0.4,
			callLlm: llm,
		});
		expect(result).toBe("thing that handles login auth.py");
	});

	it("falls back to template when the LLM throws", async () => {
		const llm = vi.fn(async () => {
			throw new Error("LLM timeout");
		});
		const result = await reformulateQuery({
			userQuery: "find login",
			fileNames: ["auth.py"],
			maxSim: 0.3,
			callLlm: llm,
		});
		expect(result).toBe("find login auth.py");
	});

	it("includes file names in the generated LLM prompt", async () => {
		let receivedPrompt = "";
		const llm = vi.fn(async (prompt: string) => {
			receivedPrompt = prompt;
			return "rewritten";
		});
		await reformulateQuery({
			userQuery: "x",
			fileNames: ["auth.py", "utils.py"],
			maxSim: 0.4,
			callLlm: llm,
		});
		expect(receivedPrompt).toContain("auth.py");
		expect(receivedPrompt).toContain("utils.py");
	});

	it("trims whitespace and quotes from the LLM response", async () => {
		const llm = vi.fn(async () => `  "rewritten query"\n  `);
		const result = await reformulateQuery({
			userQuery: "x",
			fileNames: ["a.py"],
			maxSim: 0.4,
			callLlm: llm,
		});
		expect(result).toBe("rewritten query");
	});
});
