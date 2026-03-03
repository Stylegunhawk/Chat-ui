/**
 * Formats RAG chunks into LLM-readable context
 *
 * CRITICAL: Use structured format so LLM can reference specific chunks
 */

import type { ChatFileChunk } from "$lib/rag/client";
import { type RagContextMessage } from "$lib/rag/context";
import type { RagStrategy } from "$lib/server/rag/ragAgent";

// Re-export for server usage
export { isRagContextMessage } from "$lib/rag/context";

// ============================================================================
// QUALITY GATES
// ============================================================================

/**
 * Minimum similarity score (post-rerank, sigmoid-normalized [0,1]) to include
 * a chunk in the LLM context.
 */
const MIN_SIMILARITY_SCORE = 0.45;

/**
 * Context budget in chars.
 * - Simple queries (FILE_SEMANTIC, SEMANTIC_SEARCH, FILE_DEEP_DIVE): 4000 chars (~1000 tokens)
 * - Multi-file queries (HYBRID, FULL_CONTEXT): 8000 chars (~2000 tokens)
 */
const CONTEXT_BUDGET_SIMPLE = 4000;
const CONTEXT_BUDGET_LARGE = 8000;

function getContextBudget(strategy?: RagStrategy): number {
	if (strategy === "HYBRID" || strategy === "FULL_CONTEXT") return CONTEXT_BUDGET_LARGE;
	return CONTEXT_BUDGET_SIMPLE;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Detect programming language from filename
 */
function getLanguageFromFilename(filename: string): string {
	const ext = filename.split(".").pop()?.toLowerCase();
	const langMap: Record<string, string> = {
		py: "python",
		js: "javascript",
		ts: "typescript",
		tsx: "typescript",
		jsx: "javascript",
		java: "java",
		cpp: "cpp",
		c: "c",
		go: "go",
		rs: "rust",
		rb: "ruby",
		php: "php",
		swift: "swift",
		kt: "kotlin",
		cs: "csharp",
	};
	return langMap[ext || ""] || "text";
}

// ============================================================================
// MAIN EXPORT
// ============================================================================

/**
 * Build structured RAG context message for LLM injection.
 *
 * Pipeline:
 *   1. Score filter  — drop chunks with similarity < MIN_SIMILARITY_SCORE
 *   2. Role sort     — entry > dependency > supporting
 *   3. Budget cap    — trim to budget (4k simple / 8k HYBRID+FULL_CONTEXT)
 *   4. Format        — structured <coderef> XML with file, relevance, role, line
 */
export function buildRagContextMessage(
	chunks: ChatFileChunk[],
	strategy?: RagStrategy
): RagContextMessage {
	if (chunks.length === 0) {
		throw new Error("Cannot build context from empty chunks");
	}

	// ── Step 1: Score filter ─────────────────────────────────────────────────
	// FULL_SUMMARY chunks from getFileChunks() have similarity=1.0 (sequential,
	// not scored) — they always pass. Semantic search chunks are reranked
	// on the backend; anything ≥ 0.45 survived the cross-encoder cut.
	const scoredChunks = chunks.filter((c) => (c.similarity ?? 1) >= MIN_SIMILARITY_SCORE);

	if (scoredChunks.length === 0) {
		// All chunks below threshold — fall back to top-3 by score so we never
		// return empty context when the query IS relevant but scores are low.
		const fallback = [...chunks]
			.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
			.slice(0, 3);
		console.warn(
			`[RAG] All ${chunks.length} chunks below score threshold — using top-3 fallback (best score: ${(fallback[0]?.similarity ?? 0).toFixed(2)})`
		);
		return buildRagContextMessage(fallback); // recurse with fallback (scores now pass since no filter)
	}

	if (scoredChunks.length < chunks.length) {
		console.log(
			`[RAG] Score filter: kept ${scoredChunks.length}/${chunks.length} chunks (≥${MIN_SIMILARITY_SCORE})`
		);
	}

	// ── Step 2: Role sort ────────────────────────────────────────────────────
	const rolePriority = { entry: 1, dependency: 2, supporting: 3 };
	const sorted = [...scoredChunks].sort((a, b) => rolePriority[a.role] - rolePriority[b.role]);

	// ── Step 3: Context budget cap ───────────────────────────────────────────
	const MAX_CONTEXT_CHARS = getContextBudget(strategy);
	let budget = MAX_CONTEXT_CHARS;
	const budgeted: ChatFileChunk[] = [];
	for (const chunk of sorted) {
		if (budget <= 0) break;
		budgeted.push(chunk);
		budget -= chunk.text.length;
	}

	if (budgeted.length < sorted.length) {
		console.log(
			`[RAG] Budget cap: injecting ${budgeted.length}/${sorted.length} chunks (${MAX_CONTEXT_CHARS - budget} chars)`
		);
	}

	// ── Step 4: Format ───────────────────────────────────────────────────────
	const formattedChunks = budgeted
		.map((chunk, idx) => {
			const lang = getLanguageFromFilename(chunk.filename);
			const relevancePercent = (chunk.similarity * 100).toFixed(0);

			return `<coderef id="${chunk.id}" index="${idx + 1}">
File: ${chunk.filename}
Relevance: ${relevancePercent}%
Role: ${chunk.role}
${chunk.pageNumber ? `Line: ${chunk.pageNumber}` : ""}
Source URL: ${chunk.fileUrl || "N/A"}

\`\`\`${lang}
${chunk.text.trim()}
\`\`\`
</coderef>`;
		})
		.join("\n\n---\n\n");

	const contextContent = `# Retrieved Document Context

The following snippets were retrieved from the user's uploaded files and are relevant to their question. Use these references to provide accurate answers.

${formattedChunks}

---

**Instructions:**
- Reference specific files and line numbers when answering
- Prioritize chunks marked as "entry" role
- If multiple files are relevant, explain their relationships
- If the context doesn't contain enough information, say so clearly`;

	const messageId = `rag_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

	return {
		from: "system",
		content: contextContent,
		id: messageId,
		createdAt: new Date(),
		ragChunks: chunks, // Pass ALL original chunks to frontend (not capped)
		metadata: {
			type: "rag-context",
			chunkIds: chunks.map((c) => c.id),
		},
	};
}
