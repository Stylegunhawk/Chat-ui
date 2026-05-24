import { findFileMatch, type RagFileContext } from "./ragRouter";

const INVENTORY_META_PATTERNS = [
	/\bwhat\s+files?\s+do\s+i\s+have\b/i,
	/\blist\s+(?:my\s+)?(?:uploaded\s+)?(?:files?|uploads?)\b/i,
	/\bwhat\s+(?:did\s+i\s+upload|uploads?)\b/i,
	/\bshow\s+(?:me\s+)?(?:my\s+)?(?:uploaded\s+)?(?:files?|uploads?)\b/i,
];

const GREETING_PATTERNS = [
	/^\s*(?:hi|hello|hey|yo|hola)\s*[!.?]*\s*$/i,
	/^\s*how\s+are\s+you(?:\s+doing)?\s*[!.?]*\s*$/i,
	/^\s*hi[\s,]+how\s+are\s+you(?:\s+doing)?\s*[!.?]*\s*$/i,
];

const FILE_REFERENCE_WORDS = [
	"file",
	"files",
	"document",
	"documents",
	"doc",
	"docs",
	"upload",
	"uploads",
	"uploaded",
	"pdf",
];

const STRONG_CONTENT_VERBS = [
	"summarize",
	"summarise",
	"summary",
	"overview",
	"review",
	"walk me through",
	"walk through",
];

const CONTENT_VERBS = [
	...STRONG_CONTENT_VERBS,
	"explain",
	"describe",
	"show",
	"read",
	"analyze",
	"analyse",
	"give me",
	"tell me about",
	"what does",
	"how does",
];

const CODE_REFERENCE_WORDS = [
	"code",
	"function",
	"class",
	"method",
	"definition",
	"implementation",
	"handler",
	"module",
];

const GENERAL_KNOWLEDGE_PATTERNS = [
	/^\s*what\s+is\s+\d+[\s+\-*/]\d+/i,
	/\bphotosynthesis\b/i,
	/\bwrite\s+me\s+a\s+poem\b/i,
];

function hasWord(query: string, word: string): boolean {
	return new RegExp(`\\b${word}\\b`, "i").test(query);
}

export function shouldEngage(query: string, files: RagFileContext[]): boolean {
	if (files.length === 0) return false;

	const normalized = query.trim();
	if (normalized.length === 0) return false;

	if (GREETING_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
	if (INVENTORY_META_PATTERNS.some((pattern) => pattern.test(normalized))) return true;

	if (findFileMatch(normalized, files)) return true;

	const hasFileReference = FILE_REFERENCE_WORDS.some((word) => hasWord(normalized, word));
	if (hasFileReference) return true;

	if (GENERAL_KNOWLEDGE_PATTERNS.some((pattern) => pattern.test(normalized))) return false;

	const lower = normalized.toLowerCase();
	const hasStrongContentVerb = STRONG_CONTENT_VERBS.some((verb) => lower.includes(verb));
	if (hasStrongContentVerb) return true;

	const hasContentVerb = CONTENT_VERBS.some((verb) => lower.includes(verb));
	const hasCodeCue = CODE_REFERENCE_WORDS.some((word) => hasWord(normalized, word));
	return hasContentVerb && hasCodeCue;
}
