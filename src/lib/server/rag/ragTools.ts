import { randomUUID } from "node:crypto";

import type { ChatFileChunk, RagFileMetadata } from "$lib/rag/client";
import type { OpenAiTool } from "$lib/server/mcp/tools";
import type { RAGClient } from "./client";

const TOP_K_MIN = 1;
const TOP_K_MAX = 20;
const TOP_K_DEFAULT = 5;
const LIMIT_MIN = 1;
const LIMIT_MAX = 30;
const LIMIT_DEFAULT = 8;

export const RETRIEVE_DOCS_TOOL: OpenAiTool = {
	type: "function",
	function: {
		name: "retrieve_docs",
		description:
			"Search uploaded files for content relevant to a query. Use fileIds when the user names specific files.",
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "The user's natural language query.",
				},
				rewriteQuery: {
					type: "string",
					description: "Optional optimized retrieval query for better matching.",
				},
				fileIds: {
					type: "array",
					items: { type: "string" },
					description: "Optional file ID whitelist from uploaded inventory.",
				},
				top_k: {
					type: "integer",
					minimum: TOP_K_MIN,
					maximum: TOP_K_MAX,
					default: TOP_K_DEFAULT,
					description: "Number of chunks to return.",
				},
			},
			required: ["query"],
		},
	},
};

export const GET_FILE_CHUNKS_TOOL: OpenAiTool = {
	type: "function",
	function: {
		name: "get_file_chunks",
		description:
			"Read a specific uploaded file sequentially in chunk order. Best for summaries and full-file walkthroughs.",
		parameters: {
			type: "object",
			properties: {
				fileId: {
					type: "string",
					description: "File ID from uploaded inventory.",
				},
				limit: {
					type: "integer",
					minimum: LIMIT_MIN,
					maximum: LIMIT_MAX,
					default: LIMIT_DEFAULT,
				},
				offset: {
					type: "integer",
					minimum: 0,
					default: 0,
				},
			},
			required: ["fileId"],
		},
	},
};

export const RAG_TOOL_NAMES = new Set(["retrieve_docs", "get_file_chunks"]);

export interface RetrieveDocsArgs {
	query: string;
	rewriteQuery?: string;
	fileIds?: string[];
	top_k?: number;
}

export interface GetFileChunksArgs {
	fileId: string;
	limit?: number;
	offset?: number;
}

export interface RagToolResult {
	chunks: ChatFileChunk[];
	error?: string;
}

interface FileIdValidationResult {
	valid: string[];
	unknown: string[];
	unready: string[];
}

interface RagToolContext {
	ragClient: RAGClient;
	inventory: RagFileMetadata[];
}

export type RetrieveDocsHandler = (
	args: RetrieveDocsArgs,
	ctx: RagToolContext
) => Promise<RagToolResult>;

export type GetFileChunksHandler = (
	args: GetFileChunksArgs,
	ctx: RagToolContext
) => Promise<RagToolResult>;

function clampInt(
	value: number | undefined,
	min: number,
	max: number,
	defaultValue: number
): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return defaultValue;
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

function sanitizeOffset(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.trunc(value));
}

function validateRequestedFileIds(
	requested: string[] | undefined,
	inventory: RagFileMetadata[]
): FileIdValidationResult {
	if (!requested || requested.length === 0) {
		return { valid: [], unknown: [], unready: [] };
	}

	const uniqueRequested = Array.from(new Set(requested));
	const byId = new Map(inventory.map((file) => [file.id, file]));
	const valid: string[] = [];
	const unknown: string[] = [];
	const unready: string[] = [];

	for (const fileId of uniqueRequested) {
		const file = byId.get(fileId);
		if (!file) {
			unknown.push(fileId);
			continue;
		}
		if (!file.finishEmbedding) {
			unready.push(fileId);
			continue;
		}
		valid.push(fileId);
	}

	return { valid, unknown, unready };
}

export const handleRetrieveDocs: RetrieveDocsHandler = async (args, ctx) => {
	const { query, rewriteQuery, fileIds, top_k } = args;
	const { ragClient, inventory } = ctx;

	const { valid, unknown, unready } = validateRequestedFileIds(fileIds, inventory);

	if (unready.length > 0) {
		return {
			chunks: [],
			error: `File(s) still being processed: ${unready.join(", ")}. Please wait and try again.`,
		};
	}

	if (fileIds && fileIds.length > 0 && valid.length === 0) {
		return {
			chunks: [],
			error: `Unknown fileIds: ${unknown.join(", ")}.`,
		};
	}

	if (unknown.length > 0) {
		console.warn(`[ragTools] Dropping unknown fileIds: ${unknown.join(", ")}`);
	}

	const clampedTopK = clampInt(top_k, TOP_K_MIN, TOP_K_MAX, TOP_K_DEFAULT);

	try {
		const response = await ragClient.semanticSearch({
			messageId: randomUUID(),
			userQuery: query,
			rewriteQuery,
			fileIds: valid.length > 0 ? valid : undefined,
			top_k: clampedTopK,
		});
		return { chunks: response.chunks ?? [] };
	} catch (error) {
		const message = error instanceof Error ? error.message : "RAG search failed";
		return { chunks: [], error: message };
	}
};

export const handleGetFileChunks: GetFileChunksHandler = async (args, ctx) => {
	const { fileId, limit, offset } = args;
	const { ragClient, inventory } = ctx;

	const file = inventory.find((candidate) => candidate.id === fileId);
	if (!file) {
		return { chunks: [], error: `Unknown fileId: ${fileId}.` };
	}
	if (!file.finishEmbedding) {
		return {
			chunks: [],
			error: `File "${file.name}" is still being processed. Please wait and try again.`,
		};
	}

	const clampedLimit = clampInt(limit, LIMIT_MIN, LIMIT_MAX, LIMIT_DEFAULT);
	const safeOffset = sanitizeOffset(offset);

	try {
		const response = await ragClient.getFileChunks(fileId, clampedLimit, safeOffset);
		return { chunks: response.chunks ?? [] };
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to fetch file chunks";
		return { chunks: [], error: message };
	}
};
