import { describe, expect, test } from "vitest";
import type { ChatFileChunk } from "$lib/rag/client";

describe("ChatFileChunk type contract", () => {
	test("accepts null similarity (graph-expanded chunk)", () => {
		const chunk: ChatFileChunk = {
			id: "c1",
			fileId: "f1",
			filename: "auth.py",
			fileType: "text/x-python",
			fileUrl: "http://localhost/auth.py",
			text: "def auth(): pass",
			similarity: null,
			role: "dependency",
			expanded_from: "utils.py::decode_jwt",
		};
		expect(chunk.similarity).toBeNull();
		expect(chunk.expanded_from).toBe("utils.py::decode_jwt");
	});
});

import { RagAgent } from "$lib/server/rag/ragAgent";
import type { RagFileContext } from "$lib/server/rag/ragRouter";

const noopClient = {} as ConstructorParameters<typeof RagAgent>[0];

const files: RagFileContext[] = [
	{ id: "f1", name: "auth.py", chunkCount: 15 },
	{ id: "f2", name: "utils.ts", chunkCount: 8 },
];

describe("RagAgent.classify — 3-bucket router", () => {
	test("META: file list query returns NO_RAG", () => {
		const agent = new RagAgent(noopClient);
		const plan = agent.classify("what files do I have?", files, []);
		expect(plan.strategy).toBe("NO_RAG");
	});

	test("META: show uploaded files returns NO_RAG", () => {
		const agent = new RagAgent(noopClient);
		const plan = agent.classify("show me my uploaded files", files, []);
		expect(plan.strategy).toBe("NO_RAG");
	});

	test("SUMMARIZE_FILE: named file + summarize verb", () => {
		const agent = new RagAgent(noopClient);
		const plan = agent.classify("summarize auth.py", files, []);
		expect(plan.strategy).toBe("SUMMARIZE_FILE");
		expect(plan.filePlans).toHaveLength(1);
		expect(plan.filePlans[0].fileId).toBe("f1");
	});

	test("SUMMARIZE_FILE: PDF gets extra offset chunks", () => {
		const pdfFiles: RagFileContext[] = [{ id: "p1", name: "report.pdf", chunkCount: 10 }];
		const agent = new RagAgent(noopClient);
		const plan = agent.classify("summarize report.pdf", pdfFiles, []);
		expect(plan.strategy).toBe("SUMMARIZE_FILE");
		expect(plan.filePlans[0].limit).toBe(13);
	});

	test("SUMMARIZE_ALL: global summarize with files returns SUMMARIZE_ALL", () => {
		const agent = new RagAgent(noopClient);
		const plan = agent.classify("summarize all my files", files, []);
		expect(plan.strategy).toBe("SUMMARIZE_ALL");
		expect(plan.filePlans).toHaveLength(2);
	});

	test("SUMMARIZE_ALL: global summarize with no files returns SEARCH", () => {
		const agent = new RagAgent(noopClient);
		const plan = agent.classify("summarize all my files", [], []);
		expect(plan.strategy).toBe("SEARCH");
	});

	test("SEARCH: general question delegates to backend", () => {
		const agent = new RagAgent(noopClient);
		const plan = agent.classify("how does authentication work?", files, []);
		expect(plan.strategy).toBe("SEARCH");
		expect(plan.filePlans).toHaveLength(0);
	});

	test("SEARCH: code structure query delegates to backend (not HYBRID)", () => {
		const agent = new RagAgent(noopClient);
		const plan = agent.classify("what does auth.py import from utils.ts?", files, []);
		expect(plan.strategy).toBe("SEARCH");
	});

	test("SEARCH: named file without summarize verb delegates to backend", () => {
		const agent = new RagAgent(noopClient);
		const plan = agent.classify("explain the validate function in auth.py", files, []);
		expect(plan.strategy).toBe("SEARCH");
	});
});
