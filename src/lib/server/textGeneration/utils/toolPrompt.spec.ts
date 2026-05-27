import { describe, expect, it } from "vitest";

import { buildRagFlowPrompt, buildMcpFlowPrompt } from "./toolPrompt";
import type { OpenAiTool } from "$lib/server/mcp/tools";

function tool(name: string): OpenAiTool {
	return { type: "function", function: { name, description: "", parameters: {} } } as OpenAiTool;
}

const RAG_TOOLS = [
	tool("list_files"),
	tool("retrieve_docs"),
	tool("get_file_chunks"),
	tool("get_code_graph_related"),
];
const MCP_TOOLS = [tool("web_search"), tool("github_operation"), tool("generate_artifact")];

describe("buildRagFlowPrompt", () => {
	it("returns empty string when there are no tools", () => {
		expect(buildRagFlowPrompt([])).toBe("");
	});

	it("contains no developer-private fixture references", () => {
		const p = buildRagFlowPrompt(RAG_TOOLS, true);
		expect(p).not.toMatch(/agent\.py/);
		expect(p).not.toMatch(/AgentRunner/);
		expect(p).not.toMatch(/MyClass/);
		expect(p).not.toMatch(/tenant::file::name/);
	});

	it("does not state the response-length rule more than once", () => {
		const p = buildRagFlowPrompt(RAG_TOOLS, true);
		const occurrences = p.match(/2–3 lines/g) ?? [];
		expect(occurrences.length).toBe(1);
	});

	it("includes the new grounding, anti-loop, and scope sections when RAG is active", () => {
		const p = buildRagFlowPrompt(RAG_TOOLS, true);
		expect(p).toMatch(/RETRIEVAL GROUNDING/);
		expect(p).toMatch(/#chunk/);
		expect(p).toMatch(/same tool with the same arguments twice/);
		expect(p).toMatch(/## SCOPE/);
	});

	it("emits a single coherent disabled instruction (no contradiction) when RAG is off", () => {
		const p = buildRagFlowPrompt(RAG_TOOLS, false);
		expect(p).toMatch(/Document search is currently disabled/);
		expect(p).not.toMatch(/indexed and searchable/);
		expect(p).not.toMatch(/RETRIEVAL GROUNDING/);
	});

	it("only chains tools that are registered (no generate_artifact ghost)", () => {
		const p = buildRagFlowPrompt(RAG_TOOLS, true);
		expect(p).not.toMatch(/generate_artifact/);
	});
});

describe("buildMcpFlowPrompt", () => {
	it("includes chaining examples for its registered tools only", () => {
		const p = buildMcpFlowPrompt(MCP_TOOLS, true);
		expect(p).toMatch(/web_search/);
		expect(p).toMatch(/generate_artifact/);
		// no RAG retrieval-grounding section without RAG tools
		expect(p).not.toMatch(/RETRIEVAL GROUNDING/);
		expect(p).not.toMatch(/get_file_chunks/);
	});
});
