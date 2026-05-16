import { Marked } from "marked";
import type { Message } from "$lib/types/Message";

/** All 9 backend-supported languages + common aliases that map to them. */
const LANGUAGE_ALIASES: Record<string, string> = {
	python: "python",
	py: "python",
	python3: "python",
	javascript: "javascript",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	typescript: "typescript",
	ts: "typescript",
	tsx: "typescript",
	go: "go",
	golang: "go",
	rust: "rust",
	rs: "rust",
	java: "java",
	ruby: "ruby",
	rb: "ruby",
	php: "php",
	csharp: "csharp",
	"c#": "csharp",
	cs: "csharp",
	dotnet: "csharp",
};

export const SUPPORTED_LANGUAGES = [
	"python",
	"javascript",
	"typescript",
	"go",
	"rust",
	"java",
	"ruby",
	"php",
	"csharp",
] as const;

/** Normalize a fenced-code-block language tag to a backend-supported value. */
export function normalizeLanguage(raw: string): string {
	const key = raw.toLowerCase().trim();
	return LANGUAGE_ALIASES[key] ?? key;
}

export interface ChatDetection {
	/** Normalized language (may or may not be in SUPPORTED_LANGUAGES). */
	lang: string;
	/** Aggregated code from recent messages (blocks joined with separators). */
	code: string;
	/** Inferred intent from recent non-code user messages. */
	intent: string;
	/** Number of code blocks found. */
	blockCount: number;
}

/**
 * Scans the last 15 messages for code blocks and conversational intent.
 *
 * - Aggregates ALL code blocks (up to 20 000 chars) with `\n\n---\n\n` separators
 *   so the backend's library detector sees the full picture.
 * - Picks the most frequent language across blocks (not just the latest).
 * - Extracts intent from recent user messages that aren't pure code.
 */
export function detectLanguageFromMessages(messages: Message[]): ChatDetection | null {
	if (!messages || messages.length === 0) return null;

	const marked = new Marked();
	const recentMessages = messages.slice(-15);

	// --- 1. Collect all code blocks ---
	const blocks: { lang: string; code: string }[] = [];
	const langCounts: Record<string, number> = {};

	for (const msg of recentMessages) {
		if (!msg.content) continue;
		const tokens = marked.lexer(msg.content);
		for (const token of tokens) {
			if (token.type === "code" && token.text) {
				const rawLang = (token.lang || "").toLowerCase().trim();
				const normalized = rawLang ? normalizeLanguage(rawLang) : "";

				blocks.push({ lang: normalized, code: token.text });

				if (normalized) {
					langCounts[normalized] = (langCounts[normalized] || 0) + 1;
				}
			}
		}
	}

	// --- 2. Pick the dominant language (most frequent, tie-break: latest) ---
	let dominantLang = "";
	if (Object.keys(langCounts).length > 0) {
		const sorted = Object.entries(langCounts).sort((a, b) => b[1] - a[1]);
		dominantLang = sorted[0][0];
	} else if (blocks.length > 0) {
		// All blocks are untagged — try the latest tagged one
		const lastTagged = [...blocks].reverse().find((b) => b.lang);
		dominantLang = lastTagged?.lang ?? "";
	}

	// --- 3. Aggregate code (most recent first, cap at 20k chars) ---
	const MAX_CODE_CHARS = 20_000;
	const reversed = [...blocks].reverse();
	const codeParts: string[] = [];
	let charCount = 0;

	for (const block of reversed) {
		if (charCount + block.code.length > MAX_CODE_CHARS) break;
		codeParts.push(block.code);
		charCount += block.code.length;
	}

	const aggregatedCode = codeParts.join("\n\n---\n\n");

	// --- 4. Extract intent from recent user text ---
	const intentParts: string[] = [];
	const userMessages = recentMessages
		.filter((m) => m.from === "user" && m.content)
		.slice(-5)
		.reverse();

	for (const msg of userMessages) {
		// Strip fenced code blocks to get just the conversational text
		const textOnly = msg.content
			.replace(/```[\s\S]*?```/g, "")
			.replace(/`[^`]+`/g, "")
			.trim();
		if (textOnly.length > 5) {
			intentParts.push(textOnly);
		}
		if (intentParts.join(" ").length >= 400) break;
	}

	const intent = intentParts.join(" — ").slice(0, 400);

	if (!dominantLang && !aggregatedCode && !intent) return null;

	return {
		lang: dominantLang,
		code: aggregatedCode,
		intent,
		blockCount: blocks.length,
	};
}
