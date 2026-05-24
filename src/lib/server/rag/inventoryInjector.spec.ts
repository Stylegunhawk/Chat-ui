import { describe, expect, it } from "vitest";

import { buildInventoryBlock } from "./inventoryInjector";
import type { RagFileMetadata } from "$lib/rag/client";

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

describe("buildInventoryBlock", () => {
	it("returns empty string for empty file list", () => {
		expect(buildInventoryBlock([])).toBe("");
	});

	it("includes file id, name, and chunk count for each file", () => {
		const block = buildInventoryBlock([
			file({ id: "f_auth", name: "auth.py", chunkCount: 12 }),
			file({ id: "f_utils", name: "utils.py", chunkCount: 8 }),
		]);

		expect(block).toContain("## Uploaded Files");
		expect(block).toContain("**auth.py** (12 chunks, id=`f_auth`)");
		expect(block).toContain("**utils.py** (8 chunks, id=`f_utils`)");
	});

	it("includes file URL when present", () => {
		const block = buildInventoryBlock([
			file({ id: "f1", name: "doc.pdf", url: "https://rag.example/doc.pdf" }),
		]);

		expect(block).toContain("https://rag.example/doc.pdf");
	});

	it("flags files still being embedded as processing and not searchable", () => {
		const block = buildInventoryBlock([
			file({ id: "f1", name: "ready.py", finishEmbedding: true }),
			file({ id: "f2", name: "pending.py", finishEmbedding: false }),
		]);

		expect(block).toContain("**ready.py**");
		expect(block).not.toMatch(/\*\*ready\.py\*\*[^\n]*processing/);
		expect(block).toMatch(/\*\*pending\.py\*\*[^\n]*processing — not searchable yet/);
	});

	it("includes usage instructions for retrieve_docs and get_file_chunks", () => {
		const block = buildInventoryBlock([file({ name: "x.py" })]);

		expect(block).toContain("retrieve_docs");
		expect(block).toContain("get_file_chunks");
		expect(block).toContain("fileIds");
	});

	it("renders file count correctly", () => {
		expect(buildInventoryBlock([file({ id: "f1" })])).toContain("1 uploaded file(s)");
		expect(buildInventoryBlock([file({ id: "f1" }), file({ id: "f2" })])).toContain(
			"2 uploaded file(s)"
		);
	});
});
