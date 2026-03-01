/**
 * Rewrites user queries using conversation context and file awareness
 *
 * Production-grade query rewriter for semantic search over code repositories.
 * Preserves filenames, converts action verbs to searchable keywords,
 * and resolves contextual references.
 */

import type { Message } from "$lib/types/Message";
import { generateFromDefaultEndpoint } from "$lib/server/generateFromDefaultEndpoint";

interface RewriteOptions {
	maxHistoryMessages?: number;
	locals?: App.Locals;
	availableFiles?: Array<{ id: string; name: string; chunkCount?: number }>;
}

/**
 * Detect if query is already semantic-search friendly
 */
function isAlreadySearchFriendly(query: string): boolean {
	// Technical queries with keywords don't need rewriting
	const technicalPatterns = [
		/\b(implementation|function|class|method|api|endpoint|database|query|algorithm)\b/i,
		/\bhow (to|do|does)\b/i, // "how to" queries are usually good
		/\b(bug|error|issue|problem|fix)\b.*\b(in|with)\b/i, // "bug in X" is specific
	];

	return technicalPatterns.some((pattern) => pattern.test(query));
}

/**
 * Rewrite query using conversation history and file context
 */
export async function rewriteQueryWithHistory(
	userQuery: string,
	conversationHistory: Message[],
	options: RewriteOptions = {}
): Promise<string> {
	const { maxHistoryMessages = 3, locals, availableFiles = [] } = options;

	// ============================================
	// SKIP CONDITIONS (Don't rewrite if...)
	// ============================================

	// 1. Too short (greetings) or too long (already detailed)
	if (userQuery.length < 5 || userQuery.length > 500) {
		console.log("[RAG] Skip: Query length out of range");
		return userQuery;
	}

	// 2. Already semantic-search friendly
	if (isAlreadySearchFriendly(userQuery)) {
		console.log("[RAG] Skip: Query already search-friendly");
		return userQuery;
	}

	// 3. No conversation history (nothing to contextualize)
	const recentHistory = conversationHistory
		.filter((msg) => msg.from !== "system")
		.slice(-maxHistoryMessages);

	if (recentHistory.length === 0) {
		console.log("[RAG] Skip: No conversation history");
		return userQuery;
	}

	// ============================================
	// BUILD CONTEXT
	// ============================================

	const contextStr = recentHistory
		.map((msg) => {
			const preview = msg.content.substring(0, 300);
			// Strip <think> blocks from history context
			const cleaned = preview.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
			return `${msg.from}: ${cleaned}`;
		})
		.join("\n");

	// Build file context (for pronoun/reference resolution only)
	const fileContext =
		availableFiles.length > 0
			? `\n\nUploaded files (for resolving references like "this file" or "the auth file"): ${availableFiles
					.slice(0, 10)
					.map((f) => f.name)
					.join(", ")}`
			: "";

	// ============================================
	// LLM REWRITE
	// ============================================

	try {
		console.log("[RAG][Phase2] Calling Query Rewriter");
		console.log("[RAG][Phase2] Original:", userQuery);

		const preprompt = `You are a semantic search query optimizer.

RULES:
1. Make the query self-contained by resolving pronouns using context ("it", "that bug", "this file").
2. Convert action verbs to topic keywords:
   - "fix that bug" → "authentication bug database query sanitization"
   - "explain the flow" → "request lifecycle execution flow"
3. Add relevant technical keywords from context (function names, concepts).
4. NEVER include filenames or file extensions (.pdf, .js, .ts) in the output.
5. Keep output 5-25 words, plain text only.
6. If the query is already clear and specific, return it unchanged.

Examples:
Input: "what does that function do?" (after discussing validateUser())
Output: validateUser function authentication logic behavior

Input: "fix the bug we discussed" (after discussing SQL injection)
Output: SQL injection database query sanitization vulnerability fix

Input: "how does auth work?"
Output: authentication authorization flow implementation logic

Now rewrite the query:`;

		const generator = generateFromDefaultEndpoint({
			messages: [
				{
					from: "user",
					content: `Context:\n${contextStr}${fileContext}\n\nQuery to rewrite: "${userQuery}"`,
				},
			],
			preprompt,
			locals,
			modelId: "gpt-oss:20b-cloud",
		});

		// Execute generator
		let result = await generator.next();
		while (!result.done) {
			result = await generator.next();
		}
		const rewritten = result.value;

		// ============================================
		// POST-PROCESSING
		// ============================================

		const cleaned = rewritten
			.replace(/<think>[\s\S]*?<\/think>/gi, "") // Remove reasoning
			.replace(/^["'`]+|["'`]+$/g, "") // Remove quotes
			.replace(/^\s+|\s+$/g, "") // Trim
			.replace(/^(rewritten query:|query:)/i, "") // Remove prefixes
			// Strip filenames from output
			.replace(
				/\b\w+\.(py|js|ts|jsx|tsx|java|go|rs|cpp|c|h|hpp|rb|php|swift|kt|scala|md|txt|json|yaml|yml|toml|ini|cfg|conf|xml|html|css|scss|sql|sh|bash|dockerfile|pdf)\b/gi,
				""
			)
			.replace(/\s+/g, " ") // Collapse spaces
			.trim();

		console.log("[RAG][Phase2] Generated Query:", cleaned);

		// ============================================
		// VALIDATION
		// ============================================

		// Reject if empty or suspiciously long (hallucination)
		if (cleaned.length === 0) {
			console.warn("[RAG] Rewrite rejected: empty output");
			return userQuery;
		}

		if (cleaned.length > Math.max(150, userQuery.length * 4)) {
			console.warn("[RAG] Rewrite rejected: too long (hallucination?)");
			return userQuery;
		}

		// Reject if model just repeated the input verbatim
		if (cleaned.toLowerCase() === userQuery.toLowerCase()) {
			console.log("[RAG] Rewrite skipped: identical to input");
			return userQuery;
		}

		console.log("[RAG][Phase2] Rewrite accepted");
		return cleaned;
	} catch (error) {
		console.warn("[RAG] Query rewrite failed:", error);
		return userQuery; // Always fallback gracefully
	}
}

/**
 * Get list of user's uploaded files for query context
 * @deprecated Use rewriteQueryWithHistory and pass files from the frontend instead.
 */
export async function getUserUploadedFiles(
	tenantId: string,
	ragClient: {
		listFiles: (tenantId: string) => Promise<import("$lib/rag/client").RagFileMetadata[]>;
	}
): Promise<string[]> {
	try {
		const files = await ragClient.listFiles(tenantId);
		return files.map((f) => f.name).filter(Boolean);
	} catch (error) {
		console.warn("[RAG] Failed to fetch file list:", error);
		return [];
	}
}
