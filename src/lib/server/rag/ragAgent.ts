/**
 * RAG Agent — Frontend Orchestrator
 *
 * The single entry point for all RAG context retrieval logic.
 *
 * Architecture:
 *   plan()    → decide strategy (LLM-based with Regex fallback)
 *   execute() → run strategies in parallel via Promise.allSettled
 *   run()     → plan + execute → merged ChatFileChunk[]
 */

import type { Message } from "$lib/types/Message";
import type { ChatFileChunk, SemanticSearchResponse } from "$lib/rag/client";
import type { RAGClient } from "$lib/server/rag/client";
import { type RagFileContext } from "$lib/server/rag/ragRouter";
import { compressHistory } from "$lib/server/rag/historyCompressor";

export type RagStrategy =
	| "NO_RAG"
	| "SEMANTIC_SEARCH"
	| "FILE_SEMANTIC"
	| "FILE_DEEP_DIVE"
	| "FULL_CONTEXT"
	| "HYBRID";

/** Per-file execution plan within a HYBRID strategy */
export interface FileExecutionPlan {
	fileId: string;
	fileName: string;
	action: "DEEP_DIVE" | "SEMANTIC" | "SKIP";
	/** Number of chunks to fetch (DEEP_DIVE only) */
	limit?: number;
	/** top_k for semantic search (SEMANTIC only) */
	topK?: number;
}

/** The full execution plan for a single user query */
export interface ExecutionPlan {
	strategy: RagStrategy;
	/** Possibly rewritten query for semantic search */
	searchQuery: string;
	/** Compressed conversation context (for logging/debug) */
	historyContext: string;
	/** Per-file decisions (populated for HYBRID / FILE_DEEP_DIVE / FILE_SEMANTIC) */
	filePlans: FileExecutionPlan[];
	/** top_k for SEMANTIC_SEARCH (global) */
	globalTopK?: number;
}

import { generateFromDefaultEndpoint } from "$lib/server/generateFromDefaultEndpoint";
import { planRagExecution } from "./ragAgentLegacy";
import { RagPlanner } from "./ragPlanner";

// ============================================================================
// CONSTANTS (Legacy fallbacks)
// ============================================================================

const GLOBAL_SEMANTIC_TOP_K = 5;
const FILE_SEMANTIC_TOP_K = 10;

// ============================================================================
// RAG AGENT CLASS
// ============================================================================

export class RagAgent {
	private planner: RagPlanner;

	constructor(
		private ragClient: RAGClient,
		plannerOrGenerateFn: RagPlanner | typeof generateFromDefaultEndpoint
	) {
		// Dependency Injection: can pass either a RagPlanner instance or the generateFn directly
		if (plannerOrGenerateFn instanceof RagPlanner) {
			this.planner = plannerOrGenerateFn;
		} else {
			this.planner = new RagPlanner(plannerOrGenerateFn);
		}
	}

	/**
	 * Plan the retrieval strategy.
	 * 1. Tries the LLM planner (RagPlanner)
	 * 2. Falls back to Regex planner (planRagExecution) on failure/timeout
	 */
	async plan(
		userQuery: string,
		availableFiles: RagFileContext[],
		conversationHistory: Message[],
		locals: App.Locals
	): Promise<ExecutionPlan> {
		const compressed = compressHistory(conversationHistory);
		const historyContext = compressed.contextString;

		try {
			// 1. Attempt LLM Planning
			return await this.planner.plan(userQuery, availableFiles, historyContext, locals);
		} catch (error) {
			console.warn(
				"[RagAgent] LLM Planner failed, falling back to Regex:",
				(error as Error).message
			);

			// 2. Fallback to deterministic regex-based planning
			// We import it from the logic we previously had in this file (now extracted/moved)
			return planRagExecution(userQuery, availableFiles, conversationHistory);
		}
	}

	/**
	 * Execute a pre-built plan, returning merged chunks.
	 */
	async execute(plan: ExecutionPlan, messageId: string): Promise<ChatFileChunk[]> {
		if (plan.strategy === "NO_RAG") {
			return [];
		}

		const allChunks: ChatFileChunk[] = [];

		// ── SEMANTIC_SEARCH: cross-file, no scope ───────────────────────────────
		if (plan.strategy === "SEMANTIC_SEARCH") {
			try {
				const resp = await this.ragClient.semanticSearch({
					messageId,
					userQuery: plan.searchQuery,
					rewriteQuery: plan.searchQuery,
					top_k: plan.globalTopK ?? GLOBAL_SEMANTIC_TOP_K,
				});
				allChunks.push(...(resp.chunks ?? []));
			} catch (e) {
				console.warn("[RagAgent] SEMANTIC_SEARCH failed:", e);
			}
			return allChunks;
		}

		// ── FILE_SEMANTIC: semantic scoped to one file ───────────────────────────
		if (plan.strategy === "FILE_SEMANTIC") {
			const targets = plan.filePlans.filter((p) => p.action === "SEMANTIC");
			if (targets.length === 0) return allChunks;

			const results = await Promise.allSettled(
				targets.map((fp) =>
					this.ragClient.semanticSearch({
						messageId,
						userQuery: plan.searchQuery,
						rewriteQuery: plan.searchQuery,
						top_k: fp.topK ?? FILE_SEMANTIC_TOP_K,
						fileIds: [fp.fileId],
					})
				)
			);
			for (const r of results) {
				if (r.status === "fulfilled") allChunks.push(...(r.value.chunks ?? []));
			}
			return allChunks;
		}

		// ── FILE_DEEP_DIVE: full sequential read of one file ────────────────────
		if (plan.strategy === "FILE_DEEP_DIVE") {
			const targets = plan.filePlans.filter((p) => p.action === "DEEP_DIVE");
			if (targets.length === 0) return allChunks;

			const fp = targets[0]; // FILE_DEEP_DIVE always has exactly one file
			try {
				const resp = (await this.ragClient.getFileChunks(
					fp.fileId,
					fp.limit ?? 20,
					0
				)) as SemanticSearchResponse;
				allChunks.push(...(resp.chunks ?? []));
			} catch (e) {
				console.warn("[RagAgent] FILE_DEEP_DIVE failed:", e);
			}
			return allChunks;
		}

		// ── FULL_CONTEXT + HYBRID: per-file parallel execution ──────────────────
		// Both use filePlans[] with DEEP_DIVE / SEMANTIC / SKIP per file
		const tasks: Array<Promise<SemanticSearchResponse | null>> = plan.filePlans.map((fp) => {
			if (fp.action === "SKIP") return Promise.resolve(null);

			if (fp.action === "DEEP_DIVE") {
				return (
					this.ragClient.getFileChunks(
						fp.fileId,
						fp.limit ?? 8,
						0
					) as Promise<SemanticSearchResponse>
				).catch((e) => {
					console.warn(`[RagAgent] DEEP_DIVE failed for "${fp.fileName}":`, e);
					return null;
				});
			}

			// SEMANTIC scoped to this file (HYBRID mode)
			return this.ragClient
				.semanticSearch({
					messageId,
					userQuery: plan.searchQuery,
					rewriteQuery: plan.searchQuery,
					top_k: fp.topK ?? 8,
					fileIds: [fp.fileId],
				})
				.catch((e) => {
					console.warn(`[RagAgent] SEMANTIC failed for "${fp.fileName}":`, e);
					return null;
				});
		});

		const results = await Promise.allSettled(tasks);
		for (const r of results) {
			if (r.status === "fulfilled" && r.value) {
				allChunks.push(...(r.value.chunks ?? []));
			}
		}
		return allChunks;
	}

	/**
	 * Full pipeline: plan → execute → return merged chunks.
	 */
	async run(
		userQuery: string,
		availableFiles: RagFileContext[],
		conversationHistory: Message[],
		messageId: string,
		locals: App.Locals
	): Promise<{ plan: ExecutionPlan; chunks: ChatFileChunk[] }> {
		// 1. Plan
		const plan = await this.plan(userQuery, availableFiles, conversationHistory, locals);

		// Log the plan
		console.log("\n[RAG AGENT] ========================");
		console.log(`- Strategy  : ${plan.strategy}`);
		console.log(`- Query     : "${userQuery}"`);
		if (plan.historyContext) {
			console.log(`- History   : ${plan.historyContext.slice(0, 100).replace(/\n/g, " ")}…`);
		}
		console.log("======================================");

		if (plan.strategy === "NO_RAG") {
			return { plan, chunks: [] };
		}

		// 2. Execute
		const chunks = await this.execute(plan, messageId);

		// Log results
		const fileNames = [...new Set(chunks.map((c) => c.filename))];
		console.log(
			`[RAG AGENT] Retrieved ${chunks.length} chunks from: ${fileNames.join(", ") || "none"}\n`
		);

		return { plan, chunks };
	}
}
