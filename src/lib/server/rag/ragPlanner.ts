/**
 * RAG Planner — LLM-based strategy planner
 *
 * Architecture:
 *   - Injected with `generateFromDefaultEndpoint` at construction time (pure DI)
 *   - `plan()` receives `locals` for auth — keeps RagAgent auth-free
 *   - On LLM failure / timeout / bad JSON → throws so RagAgent falls back to regex
 *
 * Hard limits (enforced AFTER LLM response, not negotiable):
 *   - Max 3 DEEP_DIVE files
 *   - Max 5 total filePlans
 *   - globalTopK capped at 10
 *   - 2-second timeout on LLM call
 */

import { z } from "zod";
import type { RagFileContext } from "$lib/server/rag/ragRouter";
import type { ExecutionPlan, FileExecutionPlan, RagStrategy } from "$lib/server/rag/ragAgent";
import type { generateFromDefaultEndpoint } from "$lib/server/generateFromDefaultEndpoint";

// ============================================================================
// TYPE: generateFn dependency (injected)
// ============================================================================

type GenerateFn = typeof generateFromDefaultEndpoint;

// ============================================================================
// HARD LIMITS
// ============================================================================

const MAX_DEEP_DIVE_FILES = 3;
const MAX_FILE_PLANS = 5;
const MAX_GLOBAL_TOP_K = 10;
const LLM_TIMEOUT_MS = 2000;
const LLM_MAX_TOKENS = 350;

// ============================================================================
// ZOD SCHEMA — what we expect from the LLM
// ============================================================================

const FileActionSchema = z.enum(["DEEP_DIVE", "SEMANTIC", "SKIP"]);

const FilePlanSchema = z.object({
	fileId: z.string().min(1),
	fileName: z.string().min(1),
	action: FileActionSchema,
	reason: z.string().optional(),
});

const RagStrategySchema = z.enum([
	"NO_RAG",
	"SEMANTIC_SEARCH",
	"FILE_SEMANTIC",
	"FILE_DEEP_DIVE",
	"FULL_CONTEXT",
	"HYBRID",
]);

const LlmPlanSchema = z.object({
	strategy: RagStrategySchema,
	reasoning: z.string().optional(),
	filePlans: z.array(FilePlanSchema).default([]),
	globalTopK: z.number().int().min(1).max(20).default(5),
});

type LlmPlan = z.infer<typeof LlmPlanSchema>;

// ============================================================================
// SYSTEM PROMPT BUILDER
// ============================================================================

function buildSystemPrompt(): string {
	return `You are a RAG retrieval planner. Your job is to decide the best retrieval strategy for a user query.
Respond ONLY with valid JSON matching the schema below. No prose, no markdown, no explanation outside JSON.

STRATEGIES (pick exactly one):
- FILE_DEEP_DIVE: Read ALL chunks of exactly ONE named file. Use when user explicitly names one file and wants to summarize/read it.
- FULL_CONTEXT: Read chunks from ALL available files. Use when user says "summarize all", "overview of everything", "explain all files".
- FILE_SEMANTIC: Semantic search WITHIN one file (user asks a question about a specific file but doesn't need the whole file).
- HYBRID: Per-file mix of DEEP_DIVE/SEMANTIC/SKIP. Use for complex multi-file relational queries (e.g. "how does auth.ts use db.ts?"). Populate filePlans[].
- SEMANTIC_SEARCH: Cross-file semantic search. Use for general questions with no specific file focus.
- NO_RAG: No retrieval. Use ONLY for pure meta questions like "what files do I have?" or "list my uploads".

RULES (never violate):
1. If user names exactly one file AND wants to summarize/read it → FILE_DEEP_DIVE
2. If user says "all files", "everything", "all of it" → FULL_CONTEXT
3. For code-structure queries (dependency graph, imports, call graph) → HYBRID, skip .pdf/.txt/.md files
4. filePlans[] is ONLY populated for HYBRID strategy; leave empty for all others
5. globalTopK is only used for SEMANTIC_SEARCH (1-10 range)

OUTPUT SCHEMA:
{"strategy":"FILE_DEEP_DIVE","reasoning":"one sentence","filePlans":[],"globalTopK":5}`;
}

function buildUserPrompt(
	userQuery: string,
	availableFiles: RagFileContext[],
	historyContext: string
): string {
	const fileList = availableFiles
		.map((f) => `  - id="${f.id}" name="${f.name}" chunks=${f.chunkCount ?? "?"}`)
		.join("\n");

	const historyBlock = historyContext
		? `RECENT CONVERSATION:\n${historyContext.slice(0, 400)}\n\n`
		: "";

	return `${historyBlock}AVAILABLE FILES:\n${fileList || "  (none)"}\n\nUSER QUERY: "${userQuery}"\n\nReturn JSON only:`;
}

// ============================================================================
// JSON EXTRACTOR
// ============================================================================

/**
 * Extract raw JSON from LLM output — handles ```json ... ``` wrappers
 * and leading/trailing prose some models add.
 */
function extractJson(raw: string): string {
	// Try ```json ... ``` block
	const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) return fenced[1].trim();

	// Try first { ... } block
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start !== -1 && end > start) {
		return raw.slice(start, end + 1);
	}

	return raw.trim();
}

// ============================================================================
// HARD LIMIT ENFORCEMENT
// ============================================================================

function enforceLimits(plan: LlmPlan, availableFiles: RagFileContext[]): LlmPlan {
	let { filePlans, globalTopK } = plan;

	// 1. Cap globalTopK
	globalTopK = Math.min(globalTopK ?? 5, MAX_GLOBAL_TOP_K);

	// 2. Cap total filePlans
	if (filePlans.length > MAX_FILE_PLANS) {
		console.warn(`[RagPlanner] Trimming filePlans from ${filePlans.length} → ${MAX_FILE_PLANS}`);
		filePlans = filePlans.slice(0, MAX_FILE_PLANS);
	}

	// 3. Cap DEEP_DIVE at 3 — demote extras to SEMANTIC
	let deepDiveCount = 0;
	filePlans = filePlans.map((fp) => {
		if (fp.action === "DEEP_DIVE") {
			deepDiveCount++;
			if (deepDiveCount > MAX_DEEP_DIVE_FILES) {
				console.warn(`[RagPlanner] Demoting "${fp.fileName}" DEEP_DIVE → SEMANTIC (limit reached)`);
				return { ...fp, action: "SEMANTIC" as const };
			}
		}
		return fp;
	});

	// 4. Validate fileIds exist in available files — silently skip phantoms
	const validIds = new Set(availableFiles.map((f) => f.id));
	const validFilePlans = filePlans.filter((fp) => {
		if (!validIds.has(fp.fileId)) {
			console.warn(`[RagPlanner] Dropping phantom fileId "${fp.fileId}" from plan`);
			return false;
		}
		return true;
	});

	return { ...plan, filePlans: validFilePlans, globalTopK };
}

// ============================================================================
// PLAN CONVERTER: LlmPlan → ExecutionPlan
// ============================================================================

function toExecutionPlan(
	llmPlan: LlmPlan,
	availableFiles: RagFileContext[],
	userQuery: string,
	historyContext: string
): ExecutionPlan {
	const strategy = llmPlan.strategy as RagStrategy;

	// For HYBRID: use LLM's per-file decisions directly
	if (strategy === "HYBRID") {
		const filePlans: FileExecutionPlan[] = llmPlan.filePlans.map((fp) => ({
			fileId: fp.fileId,
			fileName: fp.fileName,
			action: fp.action,
			// Reasonable defaults for limits
			limit: fp.action === "DEEP_DIVE" ? 15 : undefined,
			topK: fp.action === "SEMANTIC" ? 8 : undefined,
		}));
		return { strategy, searchQuery: userQuery, historyContext, filePlans };
	}

	// For FILE_DEEP_DIVE: use the first DEEP_DIVE filePlan or find the file by name
	if (strategy === "FILE_DEEP_DIVE") {
		const fp = llmPlan.filePlans.find((p) => p.action === "DEEP_DIVE");
		if (fp) {
			const file = availableFiles.find((f) => f.id === fp.fileId);
			const chunkCount = file?.chunkCount ?? 20;
			const isPdf = fp.fileName.toLowerCase().endsWith(".pdf");
			return {
				strategy,
				searchQuery: userQuery,
				historyContext,
				filePlans: [
					{
						fileId: fp.fileId,
						fileName: fp.fileName,
						action: "DEEP_DIVE",
						limit: Math.min(chunkCount, 20) + (isPdf ? 3 : 0),
					},
				],
			};
		}
	}

	// For FILE_SEMANTIC: use the first SEMANTIC filePlan
	if (strategy === "FILE_SEMANTIC") {
		const fp = llmPlan.filePlans.find((p) => p.action === "SEMANTIC");
		if (fp) {
			return {
				strategy,
				searchQuery: userQuery,
				historyContext,
				filePlans: [{ fileId: fp.fileId, fileName: fp.fileName, action: "SEMANTIC", topK: 10 }],
			};
		}
	}

	// For FULL_CONTEXT: generate DEEP_DIVE plans for all files
	if (strategy === "FULL_CONTEXT") {
		const perFile = availableFiles.length <= 3 ? 12 : availableFiles.length <= 6 ? 8 : 6;
		return {
			strategy,
			searchQuery: userQuery,
			historyContext,
			filePlans: availableFiles.map((f) => ({
				fileId: f.id,
				fileName: f.name,
				action: "DEEP_DIVE",
				limit: perFile,
			})),
		};
	}

	// NO_RAG / SEMANTIC_SEARCH: no filePlans needed
	return {
		strategy,
		searchQuery: userQuery,
		historyContext,
		filePlans: [],
		globalTopK: Math.min(llmPlan.globalTopK ?? 5, MAX_GLOBAL_TOP_K),
	};
}

// ============================================================================
// RAG PLANNER CLASS
// ============================================================================

export class RagPlanner {
	constructor(private generateFn: GenerateFn) {}

	/**
	 * Call LLM to produce an execution plan.
	 * Throws on: timeout, invalid JSON, schema validation failure.
	 * Caller (RagAgent) is responsible for catching and falling back to regex.
	 */
	async plan(
		userQuery: string,
		availableFiles: RagFileContext[],
		historyContext: string,
		locals: App.Locals
	): Promise<ExecutionPlan> {
		const systemPrompt = buildSystemPrompt();
		const userPrompt = buildUserPrompt(userQuery, availableFiles, historyContext);

		// ── LLM call with timeout ─────────────────────────────────────────────
		const llmCall = (async (): Promise<string> => {
			const generator = this.generateFn({
				messages: [{ from: "user", content: userPrompt }],
				preprompt: systemPrompt,
				generateSettings: {
					max_new_tokens: LLM_MAX_TOKENS,
					temperature: 0,
					stop: ["\n\n\n"],
				},
				locals,
			});

			// Drain the generator — result.value is the full output string
			let result = await generator.next();
			while (!result.done) {
				result = await generator.next();
			}
			return (result.value as string) ?? "";
		})();

		const timeout = new Promise<never>((_, reject) =>
			setTimeout(
				() => reject(new Error(`LLM planner timed out after ${LLM_TIMEOUT_MS}ms`)),
				LLM_TIMEOUT_MS
			)
		);

		const rawOutput = await Promise.race([llmCall, timeout]);

		if (!rawOutput || rawOutput.trim() === "") {
			throw new Error("LLM planner returned empty response");
		}

		// ── Parse + validate ──────────────────────────────────────────────────
		const jsonStr = extractJson(rawOutput);
		let parsed: unknown;
		try {
			parsed = JSON.parse(jsonStr);
		} catch {
			throw new Error(`LLM planner returned invalid JSON: ${jsonStr.slice(0, 100)}`);
		}

		const validated = LlmPlanSchema.parse(parsed); // throws ZodError on bad schema
		const enforced = enforceLimits(validated, availableFiles);

		console.log(
			`[RagPlanner] LLM → strategy=${enforced.strategy} reasoning="${enforced.reasoning ?? ""}"`
		);

		return toExecutionPlan(enforced, availableFiles, userQuery, historyContext);
	}
}
