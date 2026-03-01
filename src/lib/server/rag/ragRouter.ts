/**
 * Deterministic RAG Router
 *
 * Rule-first routing for RAG document retrieval.
 * Replaces the previous fuzzy + LLM FILE_ACTION chain.
 *
 * Intent Priority (top to bottom):
 *   NO_RAG          → system/metadata query
 *   FULL_SUMMARY    → explicit file name + summarize/review verb
 *   KEYWORD_LOOKUP  → known active file + question number / specific key
 *   TARGETED_SEARCH → active file context, scoped semantic search
 *   GLOBAL_SEARCH   → no file context, cross-file semantic search
 */

import type { Message } from "$lib/types/Message";
import { generateFromDefaultEndpoint } from "$lib/server/generateFromDefaultEndpoint";

// ============================================================================
// TYPES
// ============================================================================

export type RagIntent =
	| "NO_RAG"
	| "FULL_SUMMARY"
	| "KEYWORD_LOOKUP"
	| "TARGETED_SEARCH"
	| "GLOBAL_SEARCH";

export interface RagFileContext {
	id: string;
	name: string;
	chunkCount?: number;
}

export interface RagRouteDecision {
	intent: RagIntent;
	/** fileId to scope to, if any */
	fileId?: string;
	/** filename for logging */
	fileName?: string;
	/** limit for getFileChunks (FULL_SUMMARY) */
	limit?: number;
	/** offset for getFileChunks (FULL_SUMMARY) */
	offset?: number;
	/** rewritten/expanded query for semantic search */
	searchQuery?: string;
	/** top_k for semanticSearch */
	topK?: number;
}

// ============================================================================
// RULE DETECTION HELPERS
// ============================================================================

/** Summary/review action verbs — require explicit file/document framing */
const SUMMARIZE_VERBS = [
	"summarize",
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
 * Metadata/system queries that NEVER hit the RAG search endpoint.
 *
 * These are questions about the RAG system itself (file list, status, access).
 * The LLM already receives a file list in the system prompt — no retrieval needed.
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
const METADATA_QUERY_PATTERNS: RegExp[] = [
	// "list [my] files", "show [me] [my] files", "display files"
	/\b(?:list|show(?:\s+me)?|display)\s*(?:all\s+)?(?:my\s+|the\s+)?(?:uploaded\s+|available\s+|existing\s+)?(?:files?|documents?|docs?|uploads?)\b/i,

	// "what are my [uploaded] files?"  "what were the files?" "list of rag files"
	/\b(?:what\s+(?:are|were)|list\s+of)\s+(?:(?:my|the|all|rag)\s+)*(?:uploaded\s+|available\s+|existing\s+)?(?:files?|documents?|docs?|uploads?)\b/i,

	// "what files do I have?"  "what documents have I uploaded?"
	// IMPORTANT: verbs allow -ed/-d/-ing suffix so "uploaded", "added" etc. all match
	/\bwhat\s+(?:files?|documents?|docs?|uploads?)\s+(?:do\s+i|have\s+i|did\s+i|can\s+you)\s+(?:have|upload(?:ed|ing)?|add(?:ed)?|see|access(?:ed)?)\b/i,

	// "what did I upload?"  "what have I added/attached/shared/uploaded?"
	// Covers: upload, uploaded, uploading, add, added, attach, attached, share, shared, submit, submitted
	/\bwhat\s+(?:did\s+i|have\s+i)\s+(?:upload(?:ed|ing)?|add(?:ed)?|attach(?:ed)?|share[d]?|submit(?:ted)?)\b/i,

	// "can you see my files?"  "do you have access to my files?"
	/\b(?:can\s+you|do\s+you)\s+(?:see|access|view|read|find)\s+(?:my\s+)?(?:files?|documents?|uploads?)\b/i,

	// "do I have [any] [uploaded] files?"
	/\bdo\s+i\s+have\s+(?:any\s+)?(?:uploaded\s+|available\s+)?(?:files?|documents?|docs?|uploads?)\b/i,

	// "my [uploaded/available] files" (bare possessive — metadata query)
	// Negative lookahead allows semantic queries that USE the files as a source:
	//   ✓ BLOCKED as NO_RAG:  "my files" / "my uploaded files"
	//   ✓ ALLOWED as RAG:     "search my files for config" / "find in my files" /
	//                           "my files mention auth" / "look through my files"
	/\bmy\s+(?:uploaded\s+|available\s+|existing\s+)?(?:files?|documents?|docs?|uploads?)\b(?!\s+(?:say|show|contain|mention|talk|discuss|include|have|for|about|search|find|look|scan|with|that|which|where))\s*[.?!]?$/i,

	// "how many [files/documents] [did I upload]?"
	/\bhow\s+many\s+(?:files?|documents?|docs?|uploads?)\b/i,

	// "which files can you see?"
	/\bwhich\s+(?:files?|documents?)\s+(?:do\s+you|can\s+you|have\s+you)\b/i,

	// "what can you access?"  "what do you have access to?"
	/\bwhat\s+(?:can\s+you\s+(?:access|see|read)|do\s+you\s+have\s+access\s+to)\b/i,

	// RAG system status queries
	/\brag\s+(?:is\s+)?(?:enabled?|disabled?|off|on|not\s+working|working|active|inactive)\b/i,
	/\bis\s+rag\s+(?:enabled?|disabled?|on|off|working|active)\b/i,
];

/** Patterns that indicate a specific structured lookup within a document */
const KEYWORD_LOOKUP_PATTERNS: RegExp[] = [
	/\bq\.?\s*\d{1,3}\b/i, // Q55, Q.55, q 55 (cap at 3 digits)
	/\bquestion\s+\d+\b/i, // question 55
	/\bsection\s+[\d.]+\b/i, // section 3.2
	/\bpage\s+\d+\b/i, // page 4
	/\bline\s+\d+\b/i, // line 42
	/\bpart\s+[a-z\d]+\b/i, // part B
	/\bitem\s+\d+\b/i, // item 12
	/\brow\s+\d+\b/i, // row 7
	/\bno\.?\s*\d+\b/i, // No. 5 / no 5
	/what\s+(?:did|have)\s+i\s+(?:answer|select|choose|pick|mark(?:ed)?)/i,
	/my\s+(?:answer|response|choice|selection|option)\s+(?:for|to|on|at)\b/i,
	/(?:what|which)\s+(?:option|choice)\s+(?:did|have)\s+i\b/i,
];

function isSummarizeVerb(query: string): boolean {
	const lower = query.toLowerCase();
	return SUMMARIZE_VERBS.some((v) => lower.includes(v));
}

function isKeywordLookup(query: string): boolean {
	return KEYWORD_LOOKUP_PATTERNS.some((p) => p.test(query));
}

/**
 * Find a file by name match (exact + base name fallback + keyword tokens).
 */
function findFileMatch(query: string, files: RagFileContext[]): RagFileContext | undefined {
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

// ============================================================================
// QUERY REWRITE (falls back for GLOBAL / TARGETED searches)
// ============================================================================

async function rewriteForSearch(
	query: string,
	history: Message[],
	locals: App.Locals | undefined
): Promise<string> {
	if (query.length < 5 || query.length > 500) return query;

	const recentHistory = history.filter((m) => m.from !== "system").slice(-3);
	// Skip rewrite if no history to contextualize against, OR if query is already long
	// (long queries are usually self-contained enough for semantic search)
	if (recentHistory.length === 0 || query.split(/\s+/).length > 10) return query;

	const contextStr = recentHistory
		.map((m) => {
			const preview = m.content
				.substring(0, 200)
				.replace(/<think>[\s\S]*?<\/think>/gi, "")
				.trim();
			return `${m.from}: ${preview}`;
		})
		.join("\n");

	try {
		const generator = generateFromDefaultEndpoint({
			messages: [
				{
					from: "user",
					content: `Context:\n${contextStr}\n\nQuery: "${query}"\n\nRewrite for semantic search:`,
				},
			],
			preprompt: `You are a search query optimizer. Rewrite the user's query to be self-contained and keyword-rich for semantic vector search.
RULES:
- Resolve pronouns (this/that/it) using context
- Never include filenames or extensions
- Convert action verbs to topic keywords: "where is the bug" → "bug error root cause"  
- Output plain text only, 5-20 words, no quotes or explanations`,
			locals,
			modelId: "gpt-oss:20b-cloud",
		});

		let result = await generator.next();
		while (!result.done) result = await generator.next();

		const cleaned = (result.value ?? "")
			.replace(/<think>[\s\S]*?<\/think>/gi, "")
			.replace(/^["'`]+|["'`]+$/g, "")
			.replace(/^(rewritten query:|query:)/i, "")
			.replace(/\b\w+\.(py|js|ts|jsx|tsx|java|go|pdf|txt|md)\b/gi, "")
			.replace(/\s+/g, " ")
			.trim();

		return cleaned.length > 0 && cleaned.length < 150 ? cleaned : query;
	} catch {
		return query;
	}
}

// ============================================================================
// MAIN ROUTER
// ============================================================================

export interface RagRouterOptions {
	availableFiles: RagFileContext[];
	conversationHistory: Message[];
	locals?: App.Locals;
}

/**
 * Deterministically determine how to retrieve RAG context.
 *
 * Returns a `RagRouteDecision` that the caller uses to execute the
 * appropriate API call (getFileChunks vs semanticSearch).
 */
export async function routeRagQuery(
	userQuery: string,
	options: RagRouterOptions
): Promise<RagRouteDecision> {
	const { availableFiles, conversationHistory, locals } = options;

	// --- Rule 0: Metadata query → NO_RAG (never hits the search endpoint) ---
	if (METADATA_QUERY_PATTERNS.some((p) => p.test(userQuery))) {
		console.log(`[RAGRouter] → NO_RAG | metadata query, skipping search`);
		return { intent: "NO_RAG" };
	}

	// --- Rule 1: File explicitly named + summarize verb → FULL_SUMMARY ---
	const explicitFile = findFileMatch(userQuery, availableFiles);
	if (explicitFile && isSummarizeVerb(userQuery)) {
		const totalChunks = explicitFile.chunkCount ?? 10;
		const isPdf = explicitFile.name.toLowerCase().endsWith(".pdf");
		const limit = Math.min(totalChunks, 20);
		const offset = isPdf ? 3 : 0;

		console.log(
			`[RAGRouter] → FULL_SUMMARY | file="${explicitFile.name}" limit=${limit} offset=${offset}`
		);
		return {
			intent: "FULL_SUMMARY",
			fileId: explicitFile.id,
			fileName: explicitFile.name,
			limit,
			offset,
		};
	}

	// --- Rule 2: Active file context + keyword lookup pattern → KEYWORD_LOOKUP ---
	const activeFile = explicitFile ?? inferActiveFile(conversationHistory, availableFiles);
	if (activeFile && isKeywordLookup(userQuery)) {
		// Structured PDFs (response sheets, exam papers) need wider recall for sparse row data
		const isPdf = activeFile.name.toLowerCase().endsWith(".pdf");
		const topK = isPdf ? 20 : 15;
		console.log(
			`[RAGRouter] → KEYWORD_LOOKUP | file="${activeFile.name}" isPdf=${isPdf} top_k=${topK}`
		);
		return {
			intent: "KEYWORD_LOOKUP",
			fileId: activeFile.id,
			fileName: activeFile.name,
			topK,
			searchQuery: userQuery, // keyword queries are usually specific enough
		};
	}

	// --- Rule 3: Active file context, general question → TARGETED_SEARCH ---
	if (activeFile) {
		// Rewrite query for better semantic matching within this file
		const searchQuery = await rewriteForSearch(userQuery, conversationHistory, locals);
		console.log(`[RAGRouter] → TARGETED_SEARCH | file="${activeFile.name}" q="${searchQuery}"`);
		return {
			intent: "TARGETED_SEARCH",
			fileId: activeFile.id,
			fileName: activeFile.name,
			topK: 10,
			searchQuery,
		};
	}

	// --- Rule 4: No file context → GLOBAL_SEARCH ---
	const searchQuery = await rewriteForSearch(userQuery, conversationHistory, locals);
	console.log(`[RAGRouter] → GLOBAL_SEARCH | q="${searchQuery}"`);
	return {
		intent: "GLOBAL_SEARCH",
		topK: 5,
		searchQuery,
	};
}
