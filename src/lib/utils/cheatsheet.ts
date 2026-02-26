import { Marked } from "marked";
import type { Message } from "$lib/types/Message";

/**
 * Detects the most likely programming language from the conversation history.
 * Scans the last 10 messages for fenced code blocks and returns the latest language tag.
 */
export function detectLanguageFromMessages(
	messages: Message[]
): { lang: string; code: string } | null {
	if (!messages || messages.length === 0) return null;

	const marked = new Marked();
	// Scan from end to beginning
	const recentMessages = messages.slice(-10).reverse();

	for (const msg of recentMessages) {
		const tokens = marked.lexer(msg.content);
		for (const token of tokens) {
			if (token.type === "code" && token.lang) {
				// Normalize common tags (e.g. bash/sh -> shell)
				const lang = token.lang.toLowerCase().trim();
				if (lang) {
					return {
						lang,
						code: token.text,
					};
				}
			}
		}
	}

	return null;
}
