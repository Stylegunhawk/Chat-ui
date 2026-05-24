import { describe, expect, it, vi } from "vitest";

import { shouldEngage } from "./ragGate";
import { buildInventoryBlock } from "./inventoryInjector";
import { evaluate } from "./ragCritic";
import { handleRetrieveDocs } from "./ragTools";
import type { RagFileMetadata, ChatFileChunk } from "$lib/rag/client";
import type { RAGClient } from "./client";

const FILES: RagFileMetadata[] = [
	{
		id: "f_auth",
		name: "auth.py",
		size: 1000,
		fileType: "text/x-python",
		chunkCount: 12,
		chunkingStatus: "success",
		embeddingStatus: "success",
		finishEmbedding: true,
		chunkingError: null,
		embeddingError: null,
		createdAt: "2026-05-22T00:00:00Z",
		updatedAt: "2026-05-22T00:00:00Z",
	},
	{
		id: "f_utils",
		name: "utils.py",
		size: 500,
		fileType: "text/x-python",
		chunkCount: 8,
		chunkingStatus: "success",
		embeddingStatus: "success",
		finishEmbedding: true,
		chunkingError: null,
		embeddingError: null,
		createdAt: "2026-05-22T00:00:00Z",
		updatedAt: "2026-05-22T00:00:00Z",
	},
];

const fileContexts = FILES.map((file) => ({
	id: file.id,
	name: file.name,
	chunkCount: file.chunkCount,
}));

function chunk(overrides: Partial<ChatFileChunk>): ChatFileChunk {
	return {
		id: "c_x",
		fileId: "f_auth",
		filename: "auth.py",
		fileType: "text/x-python",
		fileUrl: "",
		text: "code",
		similarity: 0.8,
		role: "entry",
		is_graph_expansion: false,
		...overrides,
	};
}

describe("integration: canonical bug case", () => {
	it("engages gate, injects inventory, passes fileIds to retrieve_docs, critic passes", async () => {
		const query = "give me the authenticate function from auth.py";

		expect(shouldEngage(query, fileContexts)).toBe(true);

		const inventory = buildInventoryBlock(FILES);
		expect(inventory).toContain("## Uploaded Files");
		expect(inventory).toContain("f_auth");
		expect(inventory).toContain("f_utils");

		const semanticSearch = vi.fn(async () => ({
			chunks: [
				chunk({ id: "c_authn", similarity: 0.84, role: "entry" }),
				chunk({
					id: "c_validate",
					similarity: 0,
					role: "dependency",
					is_graph_expansion: true,
					expanded_from: "user::auth.py::authenticate",
				}),
			],
			queryId: "qid",
			expansion_count: 1,
		}));

		const ragClient = { semanticSearch } as unknown as RAGClient;
		const result = await handleRetrieveDocs(
			{ query, rewriteQuery: "def authenticate", fileIds: ["f_auth"], top_k: 10 },
			{ ragClient, inventory: FILES }
		);

		expect(semanticSearch).toHaveBeenCalledWith(
			expect.objectContaining({ fileIds: ["f_auth"], rewriteQuery: "def authenticate" })
		);
		expect(evaluate(result.chunks).verdict).toBe("PASS");
	});
});

describe("integration: gate behavior", () => {
	it("returns false for a greeting", () => {
		expect(shouldEngage("hi how are you", fileContexts)).toBe(false);
	});
});

describe("integration: critic retry verdict case", () => {
	it("returns RETRY for weak retrieval quality", async () => {
		const semanticSearch = vi.fn(async () => ({
			chunks: [chunk({ similarity: 0.4, role: "supporting" })],
			queryId: "qid",
			expansion_count: 0,
		}));
		const ragClient = { semanticSearch } as unknown as RAGClient;

		const result = await handleRetrieveDocs(
			{ query: "thing that handles login" },
			{ ragClient, inventory: FILES }
		);

		expect(evaluate(result.chunks).verdict).toBe("RETRY");
	});
});

describe("integration: cross-file parallel retrieve_docs", () => {
	it("supports parallel calls with distinct fileIds", async () => {
		const semanticSearch = vi.fn(async (request: { fileIds?: string[] }) => ({
			chunks: [chunk({ fileId: request.fileIds?.[0] ?? "f_unknown" })],
			queryId: "qid",
			expansion_count: 0,
		}));
		const ragClient = { semanticSearch } as unknown as RAGClient;

		const [resultOne, resultTwo] = await Promise.all([
			handleRetrieveDocs(
				{ query: "frontend login route", fileIds: ["f_utils"] },
				{ ragClient, inventory: FILES }
			),
			handleRetrieveDocs(
				{ query: "backend authenticate", fileIds: ["f_auth"] },
				{ ragClient, inventory: FILES }
			),
		]);

		expect(resultOne.chunks[0].fileId).toBe("f_utils");
		expect(resultTwo.chunks[0].fileId).toBe("f_auth");
		expect(semanticSearch).toHaveBeenCalledTimes(2);
	});
});

describe("integration: messageId uniqueness", () => {
	it("generates unique messageIds server-side per retrieve_docs call", async () => {
		const semanticSearch = vi.fn(async () => ({
			chunks: [],
			queryId: "qid",
			expansion_count: 0,
		}));
		const ragClient = { semanticSearch } as unknown as RAGClient;

		await handleRetrieveDocs({ query: "a" }, { ragClient, inventory: FILES });
		await handleRetrieveDocs({ query: "b" }, { ragClient, inventory: FILES });

		const callOneMessageId = (semanticSearch as ReturnType<typeof vi.fn>).mock.calls[0][0]
			.messageId;
		const callTwoMessageId = (semanticSearch as ReturnType<typeof vi.fn>).mock.calls[1][0]
			.messageId;

		expect(callOneMessageId).not.toEqual(callTwoMessageId);
		expect(callOneMessageId).toMatch(/^[0-9a-f-]{36}$/);
		expect(callTwoMessageId).toMatch(/^[0-9a-f-]{36}$/);
	});
});
