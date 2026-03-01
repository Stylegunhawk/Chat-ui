/**
 * Formats RAG chunks into LLM-readable context
 *
 * CRITICAL: Use structured format so LLM can reference specific chunks
 */

import type { ChatFileChunk } from "$lib/rag/client";
import { type RagContextMessage } from "$lib/rag/context";

// Re-export for server usage
export { isRagContextMessage } from "$lib/rag/context";

// ============================================================================
// QUALITY GATES
// ============================================================================

/**
 * Minimum similarity score (post-rerank, sigmoid-normalized [0,1]) to include
 * a chunk in the LLM context. Cross-encoder scores below this are noise.
 *
 * 0.45 is deliberately conservative — the cross-encoder reranker on the backend
 * already throws away the worst results. This just prevents marginal ones from
 * polluting the prompt.
 */
const MIN_SIMILARITY_SCORE = 0.45;

/**
 * Maximum total character length to inject into a single LLM prompt.
 * Prevents context window overflow on large FULL_SUMMARY fetches.
 *
 * ~4000 chars ≈ ~1000 tokens — safe headroom for most models.
 * FULL_SUMMARY can return 20 chunks × ~300 chars each = 6000 chars without this cap.
 */
const MAX_CONTEXT_CHARS = 4000;

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
 *   3. Budget cap    — trim to MAX_CONTEXT_CHARS to prevent context overflow
 *   4. Format        — structured <coderef> XML with file, relevance, role, line
 */
export function buildRagContextMessage(chunks: ChatFileChunk[]): RagContextMessage {
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
	// Walk chunks in priority order, accumulate text length, stop when budget
	// is exhausted. This prevents FULL_SUMMARY from blowing the context window.
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
