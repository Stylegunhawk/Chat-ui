import type { ChatFileChunk } from "$lib/rag/client";

const MIN_SIMILARITY_FLOOR = 0.55;
const MAX_GRAPH_ONLY_RATIO = 0.7;

export interface CriticSignals {
	maxSimilarity: number;
	entryCount: number;
	graphOnlyRatio: number;
}

export interface CriticVerdict {
	verdict: "PASS" | "RETRY" | "EMPTY";
	reason: string;
	signals: CriticSignals;
}

export type LlmCaller = (prompt: string) => Promise<string>;

export interface ReformulateInput {
	userQuery: string;
	fileNames: string[];
	maxSim: number;
	callLlm: LlmCaller;
}

function zeroSignals(): CriticSignals {
	return { maxSimilarity: 0, entryCount: 0, graphOnlyRatio: 0 };
}

function getSimilarityOrZero(chunk: ChatFileChunk): number {
	return typeof chunk.similarity === "number" ? chunk.similarity : 0;
}

export function evaluate(chunks: ChatFileChunk[]): CriticVerdict {
	if (chunks.length === 0) {
		return { verdict: "EMPTY", reason: "no chunks returned", signals: zeroSignals() };
	}

	const directHits = chunks.filter((chunk) => !chunk.is_graph_expansion);
	const maxSimilarity = directHits.reduce((max, chunk) => {
		return Math.max(max, getSimilarityOrZero(chunk));
	}, 0);
	const entryCount = chunks.filter((chunk) => chunk.role === "entry").length;
	const graphOnlyRatio =
		chunks.filter((chunk) => chunk.is_graph_expansion).length / Math.max(chunks.length, 1);

	const signals: CriticSignals = { maxSimilarity, entryCount, graphOnlyRatio };

	if (maxSimilarity >= MIN_SIMILARITY_FLOOR && entryCount > 0) {
		return { verdict: "PASS", reason: "strong hit + entry role present", signals };
	}

	const hasGraphContext = chunks.some((chunk) => chunk.is_graph_expansion);
	if (hasGraphContext && entryCount > 0 && graphOnlyRatio < MAX_GRAPH_ONLY_RATIO) {
		return { verdict: "PASS", reason: "weak vector signal but useful graph context", signals };
	}

	return { verdict: "RETRY", reason: "weak relevance signal for current query", signals };
}

const REFORMULATE_PROMPT_TEMPLATE = (input: ReformulateInput): string => {
	const fileList = input.fileNames.length > 0 ? input.fileNames.join(", ") : "(none)";
	return `You are rewriting a retrieval query for uploaded files.
Original user query: "${input.userQuery}"
Available files: ${fileList}
Previous retrieval max similarity: ${input.maxSim.toFixed(2)}

Rewrite the query to be precise and retrieval-friendly:
- Keep intent unchanged.
- Prefer concrete identifiers, symbols, function/class names, and technical keywords.
- Output exactly one line.
- Do not include quotes or explanations.

Rewritten query:`;
};

function cleanResponse(raw: string): string {
	return raw
		.trim()
		.replace(/^["'`]+|["'`]+$/g, "")
		.split("\n")[0]
		.trim();
}

function fallbackQuery(userQuery: string, fileNames: string[]): string {
	const topFile = fileNames[0]?.trim() ?? "";
	return `${userQuery} ${topFile}`.trim();
}

export async function reformulateQuery(input: ReformulateInput): Promise<string> {
	const prompt = REFORMULATE_PROMPT_TEMPLATE(input);
	try {
		const raw = await input.callLlm(prompt);
		const cleaned = cleanResponse(raw);
		if (cleaned.length === 0) {
			return fallbackQuery(input.userQuery, input.fileNames);
		}
		return cleaned;
	} catch (error) {
		console.warn("[ragCritic] reformulateQuery failed:", error);
		return fallbackQuery(input.userQuery, input.fileNames);
	}
}
