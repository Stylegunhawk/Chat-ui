import { describe, expect, it, vi } from "vitest";

import { handleRetrieveDocs, handleGetFileChunks } from "./ragTools";
import type { RAGClient } from "./client";
import type { ChatFileChunk, RagFileMetadata, SemanticSearchResponse } from "$lib/rag/client";

function makeRagClient(overrides: Partial<RAGClient> = {}): RAGClient {
	return {
		semanticSearch: vi.fn(async () => ({ chunks: [], queryId: "qid_test", expansion_count: 0 })),
		getFileChunks: vi.fn(async () => ({ chunks: [], queryId: "fid_test", expansion_count: 0 })),
		...overrides,
	} as unknown as RAGClient;
}

function file(id: string, name: string, finishEmbedding = true): RagFileMetadata {
	return {
		id,
		name,
		size: 100,
		fileType: "text/plain",
		chunkCount: 5,
		chunkingStatus: "success",
		embeddingStatus: "success",
		finishEmbedding,
		chunkingError: null,
		embeddingError: null,
		createdAt: "2026-05-22T00:00:00Z",
		updatedAt: "2026-05-22T00:00:00Z",
	};
}

describe("handleRetrieveDocs", () => {
	it("maps tool query to backend userQuery", async () => {
		const ragClient = makeRagClient();
		await handleRetrieveDocs(
			{ query: "find login function" },
			{ ragClient, inventory: [file("f1", "auth.py")] }
		);
		expect(ragClient.semanticSearch).toHaveBeenCalledWith(
			expect.objectContaining({ userQuery: "find login function" })
		);
	});

	it("generates a UUID messageId per call", async () => {
		const ragClient = makeRagClient();
		await handleRetrieveDocs({ query: "x" }, { ragClient, inventory: [file("f1", "a.py")] });
		const call = (ragClient.semanticSearch as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(call.messageId).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("passes rewriteQuery and top_k through with bounds respected", async () => {
		const ragClient = makeRagClient();
		await handleRetrieveDocs(
			{ query: "x", rewriteQuery: "def authenticate", top_k: 10 },
			{ ragClient, inventory: [file("f1", "a.py")] }
		);
		expect(ragClient.semanticSearch).toHaveBeenCalledWith(
			expect.objectContaining({ rewriteQuery: "def authenticate", top_k: 10 })
		);
	});

	it("clamps top_k below minimum and above maximum", async () => {
		const ragClient = makeRagClient();
		await handleRetrieveDocs(
			{ query: "x", top_k: 999 },
			{ ragClient, inventory: [file("f1", "a.py")] }
		);
		expect(ragClient.semanticSearch).toHaveBeenCalledWith(expect.objectContaining({ top_k: 20 }));

		await handleRetrieveDocs(
			{ query: "x", top_k: 0 },
			{ ragClient, inventory: [file("f1", "a.py")] }
		);
		expect(ragClient.semanticSearch).toHaveBeenLastCalledWith(
			expect.objectContaining({ top_k: 1 })
		);
	});

	it("validates fileIds against inventory and drops unknown ones when partial match exists", async () => {
		const ragClient = makeRagClient();
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		await handleRetrieveDocs(
			{ query: "x", fileIds: ["f1", "f_unknown"] },
			{ ragClient, inventory: [file("f1", "a.py")] }
		);

		expect(ragClient.semanticSearch).toHaveBeenCalledWith(
			expect.objectContaining({ fileIds: ["f1"] })
		);
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it("returns error when all fileIds are unknown", async () => {
		const ragClient = makeRagClient();
		const result = await handleRetrieveDocs(
			{ query: "x", fileIds: ["f_unknown1", "f_unknown2"] },
			{ ragClient, inventory: [file("f1", "a.py")] }
		);
		expect(result.error).toMatch(/unknown fileIds/i);
		expect(result.chunks).toEqual([]);
		expect(ragClient.semanticSearch).not.toHaveBeenCalled();
	});

	it("rejects fileIds pointing at files not yet embedded", async () => {
		const ragClient = makeRagClient();
		const result = await handleRetrieveDocs(
			{ query: "x", fileIds: ["f_pending"] },
			{ ragClient, inventory: [file("f_pending", "pending.py", false)] }
		);
		expect(result.error).toMatch(/still being processed/i);
		expect(ragClient.semanticSearch).not.toHaveBeenCalled();
	});

	it("passes chunks through on success", async () => {
		const chunks: ChatFileChunk[] = [
			{
				id: "c1",
				fileId: "f1",
				filename: "a.py",
				fileType: "text/x-python",
				fileUrl: "",
				text: "code",
				similarity: 0.8,
				role: "entry",
				is_graph_expansion: false,
			},
		];
		const ragClient = makeRagClient({
			semanticSearch: vi.fn(
				async () =>
					({
						chunks,
						queryId: "qid",
						expansion_count: 0,
					}) as SemanticSearchResponse
			),
		});

		const result = await handleRetrieveDocs(
			{ query: "x" },
			{ ragClient, inventory: [file("f1", "a.py")] }
		);

		expect(result.chunks).toEqual(chunks);
		expect(result.error).toBeUndefined();
	});

	it("converts backend errors into RagToolResult.error and never throws", async () => {
		const ragClient = makeRagClient({
			semanticSearch: vi.fn(async () => {
				throw new Error("RAG search failed: 503");
			}),
		});
		const result = await handleRetrieveDocs(
			{ query: "x" },
			{ ragClient, inventory: [file("f1", "a.py")] }
		);
		expect(result.error).toMatch(/503/);
		expect(result.chunks).toEqual([]);
	});
});

describe("handleGetFileChunks", () => {
	it("rejects unknown fileId", async () => {
		const ragClient = makeRagClient();
		const result = await handleGetFileChunks(
			{ fileId: "f_unknown" },
			{ ragClient, inventory: [file("f1", "a.py")] }
		);
		expect(result.error).toMatch(/unknown fileId/i);
		expect(ragClient.getFileChunks).not.toHaveBeenCalled();
	});

	it("rejects unready file", async () => {
		const ragClient = makeRagClient();
		const result = await handleGetFileChunks(
			{ fileId: "f_pending" },
			{ ragClient, inventory: [file("f_pending", "p.py", false)] }
		);
		expect(result.error).toMatch(/still being processed/i);
		expect(ragClient.getFileChunks).not.toHaveBeenCalled();
	});

	it("clamps limit and offset, and applies defaults", async () => {
		const ragClient = makeRagClient();
		await handleGetFileChunks(
			{ fileId: "f1", limit: 100, offset: -20 },
			{ ragClient, inventory: [file("f1", "a.py")] }
		);
		expect(ragClient.getFileChunks).toHaveBeenCalledWith("f1", 30, 0);

		await handleGetFileChunks({ fileId: "f1" }, { ragClient, inventory: [file("f1", "a.py")] });
		expect(ragClient.getFileChunks).toHaveBeenLastCalledWith("f1", 8, 0);
	});

	it("converts backend errors into RagToolResult.error", async () => {
		const ragClient = makeRagClient({
			getFileChunks: vi.fn(async () => {
				throw new Error("File chunks failed: 500");
			}),
		});
		const result = await handleGetFileChunks(
			{ fileId: "f1" },
			{ ragClient, inventory: [file("f1", "a.py")] }
		);
		expect(result.error).toMatch(/500/);
		expect(result.chunks).toEqual([]);
	});
});
