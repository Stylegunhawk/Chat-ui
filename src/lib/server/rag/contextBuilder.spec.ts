import { describe, expect, it } from "vitest";

import { buildFileListNote, buildRagContextMessage } from "./contextBuilder";

describe("contextBuilder", () => {
	it("includes file urls in the file list note when available", () => {
		const note = buildFileListNote([
			{
				id: "file-1",
				name: "commit_generator.py",
				size: 123,
				fileType: "text/x-python",
				chunkCount: 1,
				chunkingStatus: "success",
				embeddingStatus: "success",
				finishEmbedding: true,
				chunkingError: null,
				embeddingError: null,
				createdAt: "2026-05-21T00:00:00.000Z",
				updatedAt: "2026-05-21T00:00:00.000Z",
				url: "https://rag.example/commit_generator.py",
			},
		]);

		expect(note).toContain("File URL: https://rag.example/commit_generator.py");
	});

	it("includes file urls in the rag file inventory when available", () => {
		const message = buildRagContextMessage(
			[
				{
					id: "chunk-1",
					fileId: "file-1",
					filename: "commit_generator.py",
					fileType: "text/x-python",
					fileUrl: "https://rag.example/commit_generator.py",
					text: "print('hi')",
					similarity: 0.9,
					role: "entry",
					is_graph_expansion: false,
				},
			],
			undefined,
			[
				{
					id: "file-1",
					name: "commit_generator.py",
					size: 123,
					fileType: "text/x-python",
					chunkCount: 1,
					chunkingStatus: "success",
					embeddingStatus: "success",
					finishEmbedding: true,
					chunkingError: null,
					embeddingError: null,
					createdAt: "2026-05-21T00:00:00.000Z",
					updatedAt: "2026-05-21T00:00:00.000Z",
					url: "https://rag.example/commit_generator.py",
				},
			]
		);

		expect(message.content).toContain("File URL: https://rag.example/commit_generator.py");
	});
});
