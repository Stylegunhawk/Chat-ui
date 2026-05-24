import { describe, expect, it } from "vitest";

import { stripPriorRagBlocks } from "./historyHygiene";
import { buildInventoryBlock } from "./inventoryInjector";
import { buildRagContextMessage } from "./contextBuilder";
import type { Message } from "$lib/types/Message";
import type { RagFileMetadata, ChatFileChunk } from "$lib/rag/client";

function msg(from: Message["from"], content: string, id = "m_" + Math.random()): Message {
	return { from, content, id, createdAt: new Date(), updatedAt: new Date() };
}

function file(overrides: Partial<RagFileMetadata>): RagFileMetadata {
	return {
		id: "f_default",
		name: "default.txt",
		size: 100,
		fileType: "text/plain",
		chunkCount: 5,
		chunkingStatus: "success",
		embeddingStatus: "success",
		finishEmbedding: true,
		chunkingError: null,
		embeddingError: null,
		createdAt: "2026-05-22T00:00:00.000Z",
		updatedAt: "2026-05-22T00:00:00.000Z",
		...overrides,
	};
}

function chunk(overrides: Partial<ChatFileChunk>): ChatFileChunk {
	return {
		id: "c_default",
		fileId: "f_auth",
		filename: "auth.py",
		fileType: "text/x-python",
		fileUrl: "",
		text: "def authenticate(): pass",
		similarity: 0.8,
		role: "entry",
		is_graph_expansion: false,
		...overrides,
	};
}

describe("stripPriorRagBlocks", () => {
	it("removes the full # Retrieved Document Context block produced by buildRagContextMessage", () => {
		// Use the REAL output from contextBuilder so we test against actual production shape,
		// not a synthetic fixture that happens to match the regex.
		const ragMessage = buildRagContextMessage([chunk({}), chunk({ id: "c2" })]);
		const injected = `${ragMessage.content}\n\n---\n\nsummarize auth.py`;

		const messages: Message[] = [
			msg("user", injected),
			msg("assistant", "Sure, auth.py defines..."),
			msg("user", "and what about validate_token?"),
		];

		const result = stripPriorRagBlocks(messages);

		expect(result[0].content).toBe("summarize auth.py");
		expect(result[0].content).not.toContain("# Retrieved Document Context");
		expect(result[0].content).not.toContain("**Instructions:**");
		expect(result[0].content).not.toContain("<coderef");
		expect(result[1].content).toBe("Sure, auth.py defines...");
		expect(result[2].content).toBe("and what about validate_token?");
	});

	it("removes <rag_result> tags from prior user messages", () => {
		const messages: Message[] = [
			msg("user", `<rag_result query="x"><coderef>data</coderef></rag_result>previous question`),
			msg("user", "current question"),
		];

		const result = stripPriorRagBlocks(messages);

		expect(result[0].content).toBe("previous question");
		expect(result[1].content).toBe("current question");
	});

	it("removes the full ## Uploaded Files block produced by buildInventoryBlock", () => {
		// Use the REAL output from inventoryInjector — same reasoning as above.
		const inventory = buildInventoryBlock([
			file({ id: "f_auth", name: "auth.py", chunkCount: 12 }),
			file({ id: "f_utils", name: "utils.py", chunkCount: 8 }),
		]);
		const injected = `${inventory}\n\n---\n\nshow me login`;

		const messages: Message[] = [msg("user", injected), msg("user", "current")];

		const result = stripPriorRagBlocks(messages);

		expect(result[0].content).toBe("show me login");
		expect(result[0].content).not.toContain("## Uploaded Files");
		expect(result[0].content).not.toContain("retrieve_docs");
		expect(result[0].content).not.toContain("get_file_chunks");
		expect(result[1].content).toBe("current");
	});

	it("strips inventory + retrieved-context + rag_result blocks all in one go", () => {
		const inventory = buildInventoryBlock([file({ id: "f_auth", name: "auth.py" })]);
		const ragMessage = buildRagContextMessage([chunk({})]);
		const injected = `${inventory}\n\n---\n\n${ragMessage.content}\n\n---\n\n<rag_result>previous</rag_result>actual query`;

		const result = stripPriorRagBlocks([msg("user", injected), msg("user", "current")]);

		expect(result[0].content).toBe("actual query");
	});

	it("NEVER strips the last message", () => {
		const ragMessage = buildRagContextMessage([chunk({})]);
		const messages: Message[] = [
			msg("user", "earlier"),
			msg("user", `${ragMessage.content}\n\n---\n\ncurrent query`),
		];

		const result = stripPriorRagBlocks(messages);
		expect(result[1].content).toContain("# Retrieved Document Context");
	});

	it("does not touch assistant messages", () => {
		const ragMessage = buildRagContextMessage([chunk({})]);
		const assistantContent = `${ragMessage.content}\n\n---\n\nresponse`;
		const messages: Message[] = [msg("assistant", assistantContent), msg("user", "current")];

		const result = stripPriorRagBlocks(messages);

		expect(result[0].content).toBe(assistantContent);
	});

	it("is idempotent (running twice produces the same result)", () => {
		const inventory = buildInventoryBlock([file({ id: "f_auth", name: "auth.py" })]);
		const ragMessage = buildRagContextMessage([chunk({})]);
		const injected = `${inventory}\n\n---\n\n${ragMessage.content}\n\n---\n\n<rag_result>x</rag_result>query`;

		const messages: Message[] = [msg("user", injected), msg("user", "current")];

		const once = stripPriorRagBlocks(messages);
		const twice = stripPriorRagBlocks(once);

		expect(twice[0].content).toBe(once[0].content);
	});

	it("returns the same message object reference when content does not change", () => {
		const messages: Message[] = [msg("user", "no rag here"), msg("user", "current")];

		const result = stripPriorRagBlocks(messages);

		expect(result[0]).toBe(messages[0]);
		expect(result[1]).toBe(messages[1]);
	});

	it("handles non-string content without throwing", () => {
		const messages = [
			{
				from: "user" as const,
				content: undefined as unknown as string,
				id: "x",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			msg("user", "current"),
		];

		expect(() => stripPriorRagBlocks(messages)).not.toThrow();
	});
});
