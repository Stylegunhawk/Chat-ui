/**
 * History Compressor — zero-latency conversation context builder
 *
 * Strips noise (RAG prefixes, <think> blocks, system messages) from recent
 * conversation history and produces a short plain-text context string that
 * the RAG Agent uses for query rewriting and per-file planning decisions.
 *
 * NO LLM call. Template-based only.
 */

import type { Message } from "$lib/types/Message";

// ============================================================================
// STRIP HELPERS
// ============================================================================

/** Remove <think>…</think> blocks (reasoning leakage from some models) */
function stripThinkBlocks(text: string): string {
	return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "").trim();
}

/**
 * Strip the RAG context prefix we inject at the start of user messages.
 * These look like:
 *   "# Retrieved Document Context\n...\n---\n\n[actual user message]"
 *   "[System: The user has N uploaded file(s):]\n...\n---\n\n[actual user message]"
 */
function stripRagPrefix(text: string): string {
	// RAG context block: ends with "---\n\n"
	const ragEnd = text.lastIndexOf("---\n\n");
	if (ragEnd !== -1 && ragEnd < text.length - 10) {
		return text.slice(ragEnd + 5).trim();
	}
	return text;
}

/** Strip all system-injected content from a message; return clean user text */
function cleanMessageContent(content: string): string {
	return stripRagPrefix(stripThinkBlocks(content));
}

// ============================================================================
// CODE STRUCTURE QUERY DETECTION
// ============================================================================

const CODE_STRUCTURE_PATTERNS: RegExp[] = [
	/\b(?:dependency|dependencies)\s+graph\b/i,
	/\b(?:call|import)\s+graph\b/i,
	/\b(?:dependency|import)\s+tree\b/i,
	/\b(?:what|show|find|list)\s+(?:imports?|dependencies|dependents?)\b/i,
	/\b(?:which|what)\s+files?\s+(?:import|use|call|depend)\b/i,
	/\b(?:trace|follow)\s+(?:the\s+)?(?:call|import|dependency)\b/i,
	/\barchitecture\b/i,
	/\bcode\s+(?:graph|map|structure|flow)\b/i,
];

export function isCodeStructureQuery(query: string): boolean {
	return CODE_STRUCTURE_PATTERNS.some((p) => p.test(query));
}

// ============================================================================
// NON-CODE FILE DETECTION
// ============================================================================

const NON_CODE_EXTENSIONS = new Set([
	"pdf",
	"md",
	"txt",
	"docx",
	"doc",
	"csv",
	"xlsx",
	"xls",
	"pptx",
	"ppt",
]);

export function isNonCodeFile(filename: string): boolean {
	const ext = filename.split(".").pop()?.toLowerCase() ?? "";
	return NON_CODE_EXTENSIONS.has(ext);
}

export function isMarkdownFile(filename: string): boolean {
	return filename.toLowerCase().endsWith(".md");
}

// ============================================================================
// MAIN EXPORT
// ============================================================================

export interface CompressedHistory {
	/** Short plain text summary of recent conversation for RAG context */
	contextString: string;
	/** The last file that was actively discussed (if any) */
	lastMentionedFile?: string;
}

/**
 * Compress conversation history into a compact context string.
 *
 * @param messages  - Full conversation history
 * @param maxMessages - How many recent non-system messages to include (default: 6)
 * @param maxCharsPerMessage - Max chars per message preview (default: 180)
 */
export function compressHistory(
	messages: Message[],
	maxMessages = 6,
	maxCharsPerMessage = 180
): CompressedHistory {
	const relevant = messages.filter((m) => m.from !== "system").slice(-maxMessages);

	if (relevant.length === 0) {
		return { contextString: "" };
	}

	const lines = relevant.map((m) => {
		const role = m.from === "user" ? "User" : "AI";
		const raw = typeof m.content === "string" ? m.content : "";
		const cleaned = cleanMessageContent(raw);
		const preview = cleaned.slice(0, maxCharsPerMessage);
		const truncated = cleaned.length > maxCharsPerMessage ? preview + "…" : preview;
		return `${role}: ${truncated}`;
	});

	return {
		contextString: lines.join("\n"),
	};
}
