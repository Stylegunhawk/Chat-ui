import { describe, expect, it } from "vitest";

import { mapRagFilesForMessageUpdates } from "./availableFiles";

describe("mapRagFilesForMessageUpdates", () => {
	it("preserves file urls for backend fallback injection", () => {
		expect(
			mapRagFilesForMessageUpdates([
				{
					id: "file-1",
					name: "repo_discovery.py",
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
					url: "https://rag.example/repo_discovery.py",
				},
			])
		).toEqual([
			{
				id: "file-1",
				name: "repo_discovery.py",
				url: "https://rag.example/repo_discovery.py",
			},
		]);
	});
});
