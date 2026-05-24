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
			"Semantic search — finds the most relevant chunks across uploaded files for a query. Use when the user asks a question whose answer lives in a specific part of a file. Do NOT use for exhaustive tasks like listing all functions, symbols, or imports — use get_file_chunks instead.",
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
			"Read a specific uploaded file sequentially in chunk order. Use for: summaries, full-file walkthroughs, listing all functions/classes/imports/symbols, finding all usages of something, or any task requiring complete file coverage. Always prefer this over retrieve_docs when the user asks to 'list all X' or 'what does this file contain'.",
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

export const LIST_FILES_TOOL: OpenAiTool = {
	type: "function",
	function: {
		name: "list_files",
		description:
			"List all uploaded files with their IDs, names, and readiness status. Call this first when the user's query is ambiguous or refers to 'my files' without naming one, so you can discover what's available before deciding whether to use retrieve_docs (semantic search) or get_file_chunks (full read).",
		parameters: {
			type: "object",
			properties: {},
			required: [],
		},
	},
};

export const GET_CODE_GRAPH_RELATED_TOOL: OpenAiTool = {
	type: "function",
	function: {
		name: "get_code_graph_related",
		description:
			"Find code entities related to a given class or function via the dependency graph. " +
			"Use when you need to understand what a class depends on, what calls it, or what it imports. " +
			"Returns names, files, and optionally code snippets of related entities. " +
			"Use include_snippets=true only when you need the actual code of related entities.",
		parameters: {
			type: "object",
			properties: {
				entity: {
					type: "string",
					description:
						"Class or function name (e.g. 'CacheStore') or fully-qualified ID (tenant::file::name).",
				},
				depth: {
					type: "integer",
					minimum: 1,
					maximum: 3,
					default: 2,
					description: "BFS traversal depth (1–3).",
				},
				max: {
					type: "integer",
					minimum: 1,
					maximum: 20,
					default: 10,
					description: "Maximum number of related entities to return.",
				},
				include_snippets: {
					type: "boolean",
					default: false,
					description: "Attach a 200-char code snippet to each related entity.",
				},
			},
			required: ["entity"],
		},
	},
};

export const RAG_TOOL_NAMES = new Set([
	"retrieve_docs",
	"get_file_chunks",
	"list_files",
	"get_code_graph_related",
]);

export interface CodeGraphRelatedArgs {
	entity: string;
	depth?: number;
	max?: number;
	include_snippets?: boolean;
}

export interface CodeGraphRelatedResult {
	data?: unknown;
	error?: string;
}

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

export const handleGetCodeGraphRelated = async (
	args: CodeGraphRelatedArgs,
	ctx: { ragClient: RAGClient }
): Promise<CodeGraphRelatedResult> => {
	const { entity, depth = 2, max = 10, include_snippets = false } = args;
	const clampedDepth = Math.min(Math.max(depth, 1), 3);
	const clampedMax = Math.min(Math.max(max, 1), 20);

	try {
		const data = await ctx.ragClient.getGraphRelated(
			entity,
			clampedDepth,
			clampedMax,
			include_snippets
		);
		return { data };
	} catch (error) {
		const message = error instanceof Error ? error.message : "Graph related query failed";
		return { error: message };
	}
};
