/**
 * RAG Agent Legacy — Deterministic Regex Planner
 *
 * Extracted from the original ragAgent.ts to serve as a zero-latency fallback
 * if the LLM planner fails or times out.
 */

import type { Message } from "$lib/types/Message";
import {
	METADATA_QUERY_PATTERNS,
	SUMMARIZE_VERBS,
	GLOBAL_SUMMARIZE_PATTERNS,
	findFileMatch,
	inferActiveFile,
	type RagFileContext,
} from "$lib/server/rag/ragRouter";
import { compressHistory, isCodeStructureQuery } from "$lib/server/rag/historyCompressor";
import type { ExecutionPlan, FileExecutionPlan } from "./ragAgent";

// ============================================================================
// CONSTANTS
// ============================================================================

const HYBRID_DEEP_DIVE_THRESHOLD = 15;
const HYBRID_SEMANTIC_TOP_K = 8;
const GLOBAL_SEMANTIC_TOP_K = 5;
const FILE_SEMANTIC_TOP_K = 10;

function fullContextChunksPerFile(fileCount: number): number {
	if (fileCount <= 3) return 12;
	if (fileCount <= 6) return 8;
	return 6;
}

function isMetadataQuery(q: string): boolean {
	return METADATA_QUERY_PATTERNS.some((p) => p.test(q));
}

function hasSummarizeVerb(q: string): boolean {
	const lower = q.toLowerCase();
	return SUMMARIZE_VERBS.some((v) => lower.includes(v));
}

function isGlobalSummarize(q: string): boolean {
	return GLOBAL_SUMMARIZE_PATTERNS.some((p) => p.test(q));
}

// ============================================================================
// PLANNER (Regex-based)
// ============================================================================

export function planRagExecution(
	userQuery: string,
	availableFiles: RagFileContext[],
	conversationHistory: Message[]
): ExecutionPlan {
	const compressed = compressHistory(conversationHistory);
	const historyContext = compressed.contextString;

	const isSummarize = hasSummarizeVerb(userQuery);
	const isGlobalSum = isGlobalSummarize(userQuery);
	const isCodeStructure = isCodeStructureQuery(userQuery);

	const explicitFile = findFileMatch(userQuery, availableFiles);

	// ── Rule 1: Explicit single file + summarize verb ──────
	if (explicitFile && isSummarize) {
		const totalChunks = explicitFile.chunkCount ?? 10;
		const isPdf = explicitFile.name.toLowerCase().endsWith(".pdf");
		const limit = Math.min(totalChunks, 20);
		const offset = isPdf ? 3 : 0;
		return {
			strategy: "FILE_DEEP_DIVE",
			searchQuery: userQuery,
			historyContext,
			filePlans: [
				{
					fileId: explicitFile.id,
					fileName: explicitFile.name,
					action: "DEEP_DIVE",
					limit: limit + offset,
				},
			],
		};
	}

	// ── Rule 2: Global summarize ──────
	if ((isGlobalSum || isSummarize) && availableFiles.length > 0) {
		const perFile = fullContextChunksPerFile(availableFiles.length);
		const filePlans: FileExecutionPlan[] = availableFiles.map((f) => ({
			fileId: f.id,
			fileName: f.name,
			action: "DEEP_DIVE",
			limit: perFile,
		}));
		return {
			strategy: "FULL_CONTEXT",
			searchQuery: userQuery,
			historyContext,
			filePlans,
		};
	}

	// ── Rule 3: Metadata / system query ──────
	if (isMetadataQuery(userQuery)) {
		return {
			strategy: "NO_RAG",
			searchQuery: userQuery,
			historyContext,
			filePlans: [],
		};
	}

	// ── Rule 4: Code structure query → HYBRID ──────
	const activeFile = explicitFile ?? inferActiveFile(conversationHistory, availableFiles);
	if (isCodeStructure && availableFiles.length > 0) {
		const filePlans = availableFiles.map((f) => {
			if (f.chunkCount && f.chunkCount <= HYBRID_DEEP_DIVE_THRESHOLD) {
				return {
					fileId: f.id,
					fileName: f.name,
					action: "DEEP_DIVE" as const,
					limit: f.chunkCount,
				};
			}
			return {
				fileId: f.id,
				fileName: f.name,
				action: "SEMANTIC" as const,
				topK: HYBRID_SEMANTIC_TOP_K,
			};
		});

		return {
			strategy: "HYBRID",
			searchQuery: userQuery,
			historyContext,
			filePlans,
		};
	}

	// ── Rule 5: Active file context ──────
	if (activeFile) {
		return {
			strategy: "FILE_SEMANTIC",
			searchQuery: userQuery,
			historyContext,
			filePlans: [
				{
					fileId: activeFile.id,
					fileName: activeFile.name,
					action: "SEMANTIC",
					topK: FILE_SEMANTIC_TOP_K,
				},
			],
		};
	}

	// ── Rule 6: Default cross-file semantic search ──────
	return {
		strategy: "SEMANTIC_SEARCH",
		searchQuery: userQuery,
		historyContext,
		filePlans: [],
		globalTopK: GLOBAL_SEMANTIC_TOP_K,
	};
}
