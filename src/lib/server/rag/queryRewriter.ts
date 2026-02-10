/**
 * Rewrites user queries using conversation context
 *
 * Example:
 * History: User asked about authentication, assistant explained login flow
 * Query: "fix that bug"
 * Rewritten: "fix authentication bug in login flow"
 */

import type { Message } from "$lib/types/Message";
import { generateFromDefaultEndpoint } from "$lib/server/generateFromDefaultEndpoint";

interface RewriteOptions {
	maxHistoryMessages?: number; // How many messages to include as context
	locals?: App.Locals;
}

/**
 * Rewrite query using conversation history
 *
 * CRITICAL: Only use last N messages to avoid context overflow
 */
export async function rewriteQueryWithHistory(
	userQuery: string,
	conversationHistory: Message[],
	options: RewriteOptions = {}
): Promise<string> {
	const { maxHistoryMessages = 3, locals } = options;

	// Skip rewriting for very short queries (likely greetings) or very long ones
	if (userQuery.length < 5 || userQuery.length > 500) {
		return userQuery;
	}

	// Get recent context (last N messages)
	const recentHistory = conversationHistory
		.filter((msg) => msg.from !== "system") // Filter system prompts
		.slice(-maxHistoryMessages);

	// If no history, nothing to rewrite based on
	if (recentHistory.length === 0) {
		return userQuery;
	}

	// Build context string
	const contextStr = recentHistory
		.map((msg) => `${msg.from}: ${msg.content.substring(0, 300)}`)
		.join("\n");

	try {
		// Call LLM to rewrite
		const generator = generateFromDefaultEndpoint({
			messages: [
				{
					from: "user",
					content: `Given this conversation history:

${contextStr}

The user just asked: "${userQuery}"

        Task:
        Rewrite the query so it is self-contained and unambiguous for vector search.
        If no rewrite is needed, return the original query verbatim.
        Output MUST be 5–20 words.`,
				},
			],
			preprompt: `
      You are a query rewriter for a semantic search system.

        STRICT RULES:
        - Do NOT include reasoning
        - Do NOT include explanations
        - Do NOT include <think> blocks
        - Do NOT include analysis
        - Output ONLY the rewritten query as plain text
        - One single sentence
        - No quotes

        RULES:
        - Rewrite ONLY if the query depends on previous context.
        - If the query is already clear, return it EXACTLY unchanged.
        - Resolve references like "above", "this", "that", "it".
        - Do NOT add explanations or extra details.
        - Output MUST be 5–20 words.
        - Output length MUST be similar to the input length.
        - Output ONLY the rewritten query text.`,
			locals,
			modelId: "gpt-oss:20b-cloud",
		});

		// We need to iterate the generator to completion to get the return value (the full text)
		// The yielded values are just stream updates which we ignore
		let result = await generator.next();
		while (!result.done) {
			result = await generator.next();
		}
		const rewritten = result.value;

		const cleaned = rewritten
			.replace(/<think>[\s\S]*?<\/think>/gi, "") // REMOVE reasoning
			.replace(/^\s+|\s+$/g, "")
			.replace(/^["']|["']$/g, "");

		console.log("[RAG][Phase2] Generated Query:", cleaned);

		// Validation: Don't return if too similar or too long
		// If rewrite is insanely long, it might be hallucinating
		if (cleaned.length === 0 || cleaned.length > Math.max(120, userQuery.length * 3)) {
			console.warn("[RAG] Rewrite rejected, using original");
			return userQuery;
		}

		return cleaned;
	} catch (error) {
		console.warn("[RAG] Query rewrite failed:", error);
		return userQuery; // Fallback to original
	}
}
