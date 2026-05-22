/**
 * RAG Agent — 3-Bucket Frontend Router
 *
 * Classifies queries into 3 buckets (~0ms, regex only):
 *   NO_RAG        — metadata query, answer from file list, no backend call
 *   SUMMARIZE_FILE — sequential chunk read of one named file (getFileChunks)
 *   SUMMARIZE_ALL  — sequential chunk reads across all files (getFileChunks parallel)
 *   SEARCH         — delegate to backend semanticSearch (intent + reranking + graph expansion)
 *
 * The LLM planner (ragPlanner.ts) is intentionally removed — the backend Phase 12A
 * pipeline already handles intent classification, query expansion, and graph expansion.
 */

import type { Message } from "$lib/types/Message";
import type { ChatFileChunk, SemanticSearchResponse } from "$lib/rag/client";
import type { RAGClient } from "$lib/server/rag/client";
import {
	METADATA_QUERY_PATTERNS,
	SUMMARIZE_VERBS,
	GLOBAL_SUMMARIZE_PATTERNS,
	findFileMatch,
	type RagFileContext,
} from "$lib/server/rag/ragRouter";
import { compressHistory } from "$lib/server/rag/historyCompressor";

export type RagStrategy = "NO_RAG" | "SUMMARIZE_FILE" | "SUMMARIZE_ALL" | "SEARCH";

export interface FileExecutionPlan {
	fileId: string;
	fileName: string;
	action: "DEEP_DIVE";
	limit?: number;
}

export interface ExecutionPlan {
	strategy: RagStrategy;
	searchQuery: string;
	historyContext: string;
	filePlans: FileExecutionPlan[];
	globalTopK?: number;
}

const SEARCH_TOP_K = 5;
const TIMEOUT_SEARCH_MS = 5_000;
const TIMEOUT_SUMMARIZE_MS = 10_000;

function withTimeout<T>(ms: number, promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<T>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`RAG timeout after ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

function chunksPerFile(fileCount: number): number {
	if (fileCount <= 3) return 12;
	if (fileCount <= 6) return 8;
	return 6;
}

function isMetaQuery(q: string): boolean {
	return METADATA_QUERY_PATTERNS.some((p) => p.test(q));
}

function hasSummarizeVerb(q: string): boolean {
	const lower = q.toLowerCase();
	return SUMMARIZE_VERBS.some((v) => lower.includes(v));
}

function isGlobalSummarize(q: string): boolean {
	return GLOBAL_SUMMARIZE_PATTERNS.some((p) => p.test(q));
}

export class RagAgent {
	constructor(private ragClient: RAGClient) {}

	classify(
		userQuery: string,
		availableFiles: RagFileContext[],
		conversationHistory: Message[]
	): ExecutionPlan {
		const { contextString: historyContext } = compressHistory(conversationHistory);

		const explicitFile = findFileMatch(userQuery, availableFiles);
		const isSummarize = hasSummarizeVerb(userQuery);

		// Check global summarize BEFORE meta-query. "summarize all my files" matches meta-query
		// pattern 6 (/\bmy\s+…files?\b/) but is clearly a summarize intent, not a list request.
		// Exclude single-file: that case is handled by the dedicated SUMMARIZE_FILE branch below.
		const isGlobalSummarizeQuery =
			isGlobalSummarize(userQuery) ||
			(isSummarize && !explicitFile && availableFiles.length !== 1);
		if (isGlobalSummarizeQuery) {
			if (availableFiles.length > 0) {
				const perFile = chunksPerFile(availableFiles.length);
				return {
					strategy: "SUMMARIZE_ALL",
					searchQuery: userQuery,
					historyContext,
					filePlans: availableFiles.map((f) => ({
						fileId: f.id,
						fileName: f.name,
						action: "DEEP_DIVE" as const,
						limit: perFile,
					})),
				};
			}
			// No files available — fall through to SEARCH (don't treat as NO_RAG)
			return {
				strategy: "SEARCH",
				searchQuery: userQuery,
				historyContext,
				filePlans: [],
				globalTopK: SEARCH_TOP_K,
			};
		}

		if (isMetaQuery(userQuery)) {
			return { strategy: "NO_RAG", searchQuery: userQuery, historyContext, filePlans: [] };
		}

		// Explanation intent: "explain what X.py does", "how does X.py work", "describe X.py", etc.
		// Kept separate from SUMMARIZE_VERBS to avoid triggering SUMMARIZE_ALL for non-file queries.
		const EXPLAIN_FILE_RE =
			/\b(explain|describe|how\s+does|what\s+does|tell\s+me\s+about|walk\s+(?:me\s+)?through)\b/i;
		const EXACT_CODE_RE =
			/\b(?:exact\s+code|exact\s+implementation|show\s+me\s+the\s+code|give\s+me\s+the\s+code|give\s+the\s+code|show\s+the\s+code|implementation\s+of|code\s+for)\b/i;

		if (explicitFile && (isSummarize || EXPLAIN_FILE_RE.test(userQuery) || EXACT_CODE_RE.test(userQuery))) {
			const totalChunks = explicitFile.chunkCount ?? 10;
			const isPdf = explicitFile.name.toLowerCase().endsWith(".pdf");
			const limit = Math.min(totalChunks, 20) + (isPdf ? 3 : 0);
			return {
				strategy: "SUMMARIZE_FILE",
				searchQuery: userQuery,
				historyContext,
				filePlans: [
					{ fileId: explicitFile.id, fileName: explicitFile.name, action: "DEEP_DIVE", limit },
				],
			};
		}

		// Single-file context: when there's only one file, it IS the active file — no inference needed
		if (!explicitFile && isSummarize && availableFiles.length === 1) {
			const activeFile = availableFiles[0];
			const totalChunks = activeFile.chunkCount ?? 10;
			const isPdf = activeFile.name.toLowerCase().endsWith(".pdf");
			const limit = Math.min(totalChunks, 20) + (isPdf ? 3 : 0);
			return {
				strategy: "SUMMARIZE_FILE",
				searchQuery: userQuery,
				historyContext,
				filePlans: [{ fileId: activeFile.id, fileName: activeFile.name, action: "DEEP_DIVE", limit }],
			};
		}

		if ((isGlobalSummarize(userQuery) || isSummarize) && availableFiles.length > 0) {
			const perFile = chunksPerFile(availableFiles.length);
			return {
				strategy: "SUMMARIZE_ALL",
				searchQuery: userQuery,
				historyContext,
				filePlans: availableFiles.map((f) => ({
					fileId: f.id,
					fileName: f.name,
					action: "DEEP_DIVE" as const,
					limit: perFile,
				})),
			};
		}

		return {
			strategy: "SEARCH",
			searchQuery: userQuery,
			historyContext,
			filePlans: [],
			globalTopK: SEARCH_TOP_K,
		};
	}

	async execute(plan: ExecutionPlan, messageId: string): Promise<ChatFileChunk[]> {
		if (plan.strategy === "NO_RAG") return [];

		if (plan.strategy === "SEARCH") {
			try {
				const resp = await withTimeout(
					TIMEOUT_SEARCH_MS,
					this.ragClient.semanticSearch({
						messageId,
						userQuery: plan.searchQuery,
						rewriteQuery: plan.searchQuery,
						top_k: plan.globalTopK ?? SEARCH_TOP_K,
					})
				);
				return resp.chunks ?? [];
			} catch (e) {
				console.warn(`[RagAgent] Backend timeout or error for ${plan.strategy}:`, e);
				return [];
			}
		}

		const tasks = plan.filePlans.map((fp) =>
			withTimeout(
				TIMEOUT_SUMMARIZE_MS,
				this.ragClient.getFileChunks(fp.fileId, fp.limit ?? 8, 0) as Promise<SemanticSearchResponse>
			).catch((e) => {
				console.warn(`[RagAgent] getFileChunks failed for "${fp.fileName}":`, e);
				return null;
			})
		);

		const results = await Promise.allSettled(tasks);
		const chunks: ChatFileChunk[] = [];
		for (const r of results) {
			if (r.status === "fulfilled" && r.value) {
				chunks.push(...(r.value.chunks ?? []));
			}
		}
		return chunks;
	}

	async run(
		userQuery: string,
		availableFiles: RagFileContext[],
		conversationHistory: Message[],
		messageId: string
	): Promise<{ plan: ExecutionPlan; chunks: ChatFileChunk[] }> {
		const plan = this.classify(userQuery, availableFiles, conversationHistory);

		console.log("\n[RAG AGENT] ========================");
		console.log(`- Strategy  : ${plan.strategy}`);
		console.log(`- Query     : "${userQuery}"`);
		if (plan.historyContext) {
			console.log(`- History   : ${plan.historyContext.slice(0, 100).replace(/\n/g, " ")}...`);
		}
		console.log("======================================");

		if (plan.strategy === "NO_RAG") return { plan, chunks: [] };

		const chunks = await this.execute(plan, messageId);
		const fileNames = [...new Set(chunks.map((c) => c.filename))];
		console.log(
			`[RAG AGENT] Retrieved ${chunks.length} chunks from: ${fileNames.join(", ") || "none"}\n`
		);

		return { plan, chunks };
	}
}
