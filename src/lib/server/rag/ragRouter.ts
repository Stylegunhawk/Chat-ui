/**
 * RAG Router — Utility Helpers
 *
 * This module provides the rule-based detection helpers used by `ragAgent.ts`.
 * The main routing orchestration has moved to `RagAgent` in `ragAgent.ts`.
 *
 * Exports:
 *   - Pattern arrays (METADATA_QUERY_PATTERNS, SUMMARIZE_VERBS, …)
 *   - `findFileMatch()` — find a file explicitly named in a query
 *   - `inferActiveFile()` — infer "active" file from conversation history
 *   - `RagFileContext` — shared type used across router + agent
 *
 * @deprecated `routeRagQuery()` has been removed — use `RagAgent` instead.
 */

import type { Message } from "$lib/types/Message";

// ============================================================================
// TYPES
// ============================================================================

export interface RagFileContext {
	id: string;
	name: string;
	chunkCount?: number;
}

// ============================================================================
// PATTERN CONSTANTS
// ============================================================================

/** Summary/review action verbs (including common typos) */
export const SUMMARIZE_VERBS = [
	"summarize",
	"summarise",
	// Common typos / misspellings
	"simmarize",
	"sumarize",
	"summerize",
	"summerise",
	"sumamrize",
	"summerize",
	"sumarise",
	"summerrise",
	// Phrasing variants
	"summary",
	"overview",
	"give me an overview",
	"give me a summary",
	"explain this file",
	"describe this file",
	"review this file",
	"show me this file",
	"walk me through this",
	"tell me about this file",
	"what does this file",
	"what is this file",
	"what's in this file",
	"read this file",
	"analyze this file",
	"take me through",
];

/**
 * Patterns that indicate the user wants a summary spanning ALL uploaded files.
 * Verified against: "summarize all of it", "give me a summary of everything",
 * "overview of all my files", "explain everything I've uploaded"
 */
export const GLOBAL_SUMMARIZE_PATTERNS: RegExp[] = [
	/\b(?:summarize|summarise|summary\s+of)\s+(?:all|each|every(?:thing)?|both)\b/i,
	/\bgive\s+(?:me\s+)?(?:a\s+)?(?:summary|overview|review)\s+of\s+(?:all|each|every(?:thing)?|both)\b/i,
	/\b(?:overview|summary|review)\s+of\s+(?:all|each|every(?:thing)?|both)\b/i,
	/\bexplain\s+(?:all|each|every(?:thing)?|both)\b/i,
	/\b(?:analyze|analyse|review|read|go\s+through|walk\s+(?:me\s+)?through)\s+(?:all|each|every(?:thing)?|both)\b/i,
	/\b(?:summarize|summarise)\s+(?:all\s+)?(?:the\s+)?(?:documents?|files?|uploads?|content|material)\b/i,
];

/**
 * Metadata/system queries that NEVER hit the RAG search endpoint.
 *
 * Verified against:
 *   ✓ "what are my uploaded files?"
 *   ✓ "show my files" / "list files"
 *   ✓ "what files do I have?"
 *   ✓ "how many documents did I upload?"
 *   ✓ "do I have any uploaded files?"
 *   ✓ "can you see my files?"
 *   ✓ "what can you access?"
 *   ✓ "is RAG enabled?"
 */
export const METADATA_QUERY_PATTERNS: RegExp[] = [
	/\b(?:list|show(?:\s+me)?|display)\s*(?:all\s+)?(?:my\s+|the\s+)?(?:uploaded\s+|available\s+|existing\s+)?(?:files?|documents?|docs?|uploads?)\b/i,
	/\b(?:what\s+(?:are|were)|list\s+of)\s+(?:(?:my|the|all|rag)\s+)*(?:uploaded\s+|available\s+|existing\s+)?(?:files?|documents?|docs?|uploads?)\b/i,
	/\bwhat\s+(?:files?|documents?|docs?|uploads?)\s+(?:do\s+i|have\s+i|did\s+i|can\s+you)\s+(?:have|upload(?:ed|ing)?|add(?:ed)?|see|access(?:ed)?)\b/i,
	/\bwhat\s+(?:did\s+i|have\s+i)\s+(?:upload(?:ed|ing)?|add(?:ed)?|attach(?:ed)?|share[d]?|submit(?:ted)?)\b/i,
	/\b(?:can\s+you|do\s+you)\s+(?:see|access|view|read|find)\s+(?:my\s+)?(?:files?|documents?|uploads?)\b/i,
	/\bdo\s+i\s+have\s+(?:any\s+)?(?:uploaded\s+|available\s+)?(?:files?|documents?|docs?|uploads?)\b/i,
	/\bmy\s+(?:uploaded\s+|available\s+|existing\s+)?(?:files?|documents?|docs?|uploads?)\b(?!\s+(?:say|show|contain|mention|talk|discuss|include|have|for|about|search|find|look|scan|with|that|which|where))\s*[.?!]?$/i,
	/\bhow\s+many\s+(?:files?|documents?|docs?|uploads?)\b/i,
	/\bwhich\s+(?:files?|documents?)\s+(?:do\s+you|can\s+you|have\s+you)\b/i,
	/\bwhat\s+(?:can\s+you\s+(?:access|see|read)|do\s+you\s+have\s+access\s+to)\b/i,
	/\brag\s+(?:is\s+)?(?:enabled?|disabled?|off|on|not\s+working|working|active|inactive)\b/i,
	/\bis\s+rag\s+(?:enabled?|disabled?|on|off|working|active)\b/i,
];

/** Patterns that indicate a specific structured lookup within a document */
export const KEYWORD_LOOKUP_PATTERNS: RegExp[] = [
	/\bq\.?\s*\d{1,3}\b/i,
	/\bquestion\s+\d+\b/i,
	/\bsection\s+[\d.]+\b/i,
	/\bpage\s+\d+\b/i,
	/\bline\s+\d+\b/i,
	/\bpart\s+[a-z\d]+\b/i,
	/\bitem\s+\d+\b/i,
	/\brow\s+\d+\b/i,
	/\bno\.?\s*\d+\b/i,
	/what\s+(?:did|have)\s+i\s+(?:answer|select|choose|pick|mark(?:ed)?)/i,
	/my\s+(?:answer|response|choice|selection|option)\s+(?:for|to|on|at)\b/i,
	/(?:what|which)\s+(?:option|choice)\s+(?:did|have)\s+i\b/i,
];

// ============================================================================
// FILE MATCH HELPERS
// ============================================================================

/**
 * Find a file explicitly named in the query (exact + base name + keyword tokens).
 */
export function findFileMatch(query: string, files: RagFileContext[]): RagFileContext | undefined {
	const lowerQuery = query.toLowerCase();
	for (const file of files) {
		const lowerName = file.name.toLowerCase();
		const nameParts = lowerName.split(".");
		const baseName = nameParts.length > 1 ? nameParts.slice(0, -1).join(".") : lowerName;

		// 1. Exact filename match (e.g. "auth.ts")
		if (new RegExp(`\\b${lowerName.replace(/\./g, "\\.")}\\b`).test(lowerQuery)) {
			return file;
		}

		// 2. Base name match (e.g. "auth")
		if (
			baseName.length > 2 &&
			new RegExp(`\\b${baseName.replace(/\./g, "\\.")}\\b`).test(lowerQuery)
		) {
			return file;
		}

		// 3. Keyword token match (for multi-word names like "gate response")
		const tokens = baseName.split(/[\s_\-.]+/).filter((t) => t.length > 3);
		for (const token of tokens) {
			if (new RegExp(`\\b${token}\\b`, "i").test(lowerQuery)) {
				return file;
			}
		}
	}
	return undefined;
}

/**
 * Infer the "active file" from conversation history (last file the user was discussing).
 */
export function inferActiveFile(
	history: Message[],
	files: RagFileContext[]
): RagFileContext | undefined {
	if (files.length === 0) return undefined;
	// Only 1 file? it's always active
	if (files.length === 1) return files[0];

	// Scan recent history for the last mentioned file name
	const recentMessages = history.filter((m) => m.from !== "system").slice(-6);
	for (let i = recentMessages.length - 1; i >= 0; i--) {
		const content = recentMessages[i].content ?? "";
		const match = findFileMatch(content, files);
		if (match) return match;
	}
	return undefined;
}
