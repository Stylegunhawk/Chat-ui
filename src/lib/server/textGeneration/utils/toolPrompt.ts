import type { OpenAiTool } from "$lib/server/mcp/tools";

interface ToolPromptOptions {
	/** Whether document search (RAG) is engaged for this conversation. */
	ragEnabled: boolean;
}

function toolNames(tools: OpenAiTool[]): string[] {
	if (!Array.isArray(tools)) return [];
	return tools
		.map((t) => (t?.function?.name ? String(t.function.name) : ""))
		.filter((s) => s.length > 0);
}

function today(): string {
	return new Date().toLocaleDateString("en-US", {
		year: "numeric",
		month: "long",
		day: "numeric",
	});
}

/**
 * Core tool-preamble builder. Emits only the sections relevant to the tools that
 * are actually registered, so neither flow advertises a tool it cannot call.
 *
 * Rules that used to appear in three different places (response length,
 * clarification, "don't explain") now live in a single RESPONSE STYLE section.
 */
function buildToolPrompt(tools: OpenAiTool[], opts: ToolPromptOptions): string {
	const names = toolNames(tools);
	if (names.length === 0) return "";

	const has = (n: string) => names.includes(n);
	const hasRagTool = ["retrieve_docs", "get_file_chunks", "list_files"].some(has);
	const hasGraph = has("get_code_graph_related");
	const hasWebSearch = has("web_search");
	const hasGithub = has("github_operation");
	const hasArtifact = has("generate_artifact");
	const hasCheatsheet = has("generate_cheatsheet");
	const hasRefinePrompt = has("refine_prompt");
	const hasGenerateData = has("generate_data");
	const ragActive = hasRagTool && opts.ragEnabled;

	const sections: string[] = [];

	// ── Identity ──────────────────────────────────────────────────────────────
	sections.push(
		`You are a precise, tool-using assistant. You complete the user's task by calling the tools available to you and grounding your answers in their results.`,
		`Available tools: ${names.join(", ")}.`,
		`Today's date: ${today()}.`
	);

	// ── Context resolution ─────────────────────────────────────────────────────
	sections.push(
		``,
		`## CONTEXT RESOLUTION`,
		`Resolve references in the user's message from conversation history before calling any tool:`,
		`- "the above / that / this / it" → the most recently named or retrieved file, code block, or function. Read it from history; do not ask which one.`,
		`- "summarize it" / "explain it" → resolve the referent from the immediately preceding turn.`,
		`Only ask for clarification when the referent is genuinely ambiguous and cannot be resolved from any prior turn.`
	);

	// ── Uploaded file tools ─────────────────────────────────────────────────────
	if (hasRagTool && !opts.ragEnabled) {
		sections.push(
			``,
			`## UPLOADED FILES`,
			`Document search is currently disabled for this conversation. Do not call file-retrieval tools (retrieve_docs, get_file_chunks, list_files). Answer from conversation context only, and tell the user file search is unavailable if they ask about uploaded files.`
		);
	}

	if (ragActive) {
		sections.push(
			``,
			`## UPLOADED FILE TOOLS`,
			`The user's uploaded files are indexed and searchable. The current file inventory (names and IDs) is already provided to you in context — use it directly; do not call \`list_files\` just to see what exists. Choose the right tool:`,
			`1. Summarize / walk through / list all symbols in a complete file → \`get_file_chunks\` (sequential, complete coverage).`,
			`2. Targeted question answerable from part of a file → \`retrieve_docs\`.`,
			`3. Cross-file or project-wide question → \`retrieve_docs\` without fileIds.`,
			``,
			`**Hard rule:** \`retrieve_docs\` returns top-k chunks by similarity — it is NOT exhaustive. Never use it for "list all X" or "what does this file contain"; use \`get_file_chunks\`.`,
			``,
			`### list_files(no params)`,
			`Refresh-only: call this solely when you suspect the inventory in context is stale (e.g. the user just uploaded a file mid-conversation). The inventory is otherwise already provided.`,
			``,
			`### retrieve_docs(query, rewriteQuery?, fileIds?, top_k?)`,
			`Semantic search; the backend handles reranking and graph expansion.`,
			`- Always set \`rewriteQuery\` to the technical keywords and identifiers from the question.`,
			`- Set \`fileIds\` (looked up from the inventory) when the user names a file; omit it for cross-file questions.`,
			`- Default \`top_k\` is 5; raise to 10–15 for broad-coverage questions.`,
			``,
			`### get_file_chunks(fileId, limit?, offset?)`,
			`Reads a file sequentially in document order — complete coverage, no similarity scores.`,
			`- Use for summaries, full walkthroughs, listing all symbols, exhaustive analysis.`,
			`- Default limit is 8; paginate large files with \`offset\`.`,
			``,
			`### RETRIEVAL GROUNDING`,
			`- Base factual claims about the user's files on retrieved content, not prior knowledge. If the chunks do not answer the question, say so explicitly rather than filling the gap.`,
			`- Cite the source of each claim as \`[<filename>#chunk<n>]\`. When the user asks to see code or text, quote it verbatim in a fenced block rather than paraphrasing.`
		);
	}

	// ── Code graph ───────────────────────────────────────────────────────────
	if (hasGraph) {
		sections.push(
			``,
			`## CODE GRAPH`,
			`Use \`get_code_graph_related\` for dependencies, callers, imports, or relationships between code entities.`,
			`Trigger phrases: "what calls X", "what does X depend on", "what imports X", "callers of X", "dependency graph", "relationships".`,
			`Parameters:`,
			`- \`entity\`: class, function, or method name as it appears in the code. Resolve "it"/"that function" from history.`,
			`- \`depth\`: 1 (direct), 2 (default, transitive), 3 (deep).`,
			`- \`include_snippets\`: true only when the user needs the actual code of related entities.`,
			`A visual dependency-graph chip is rendered automatically — you do not generate a diagram yourself.`
		);
	}

	// ── Web search ──────────────────────────────────────────────────────────────
	if (hasWebSearch) {
		sections.push(
			``,
			`## WEB SEARCH`,
			`Use \`web_search\` for current events, public library/framework docs, version lookups, and facts needing up-to-date information.`,
			`- Do not search for information already in the conversation or uploaded files.`,
			`- Use targeted queries with version numbers and library names; synthesize results into a direct answer rather than dumping raw output.`,
			`- If results are ambiguous or outdated, say so.`
		);
	}

	// ── GitHub ───────────────────────────────────────────────────────────────
	if (hasGithub) {
		sections.push(
			``,
			`## GITHUB OPERATIONS`,
			`Use \`github_operation\` for reading repos, creating/updating files, branches, PRs, issues, releases, and workflows.`,
			`- The server enforces a risk gate; HIGH/CRITICAL operations require UI confirmation. Do not pass \`risk_confirmed\` or \`risk_reason\` yourself.`,
			`- Use exact \`owner/repo\` format. Commit messages are mandatory; follow Conventional Commits (feat/fix/docs/refactor/chore). Treat operations on main/master as HIGH risk.`
		);
	}

	// ── Artifact generation ───────────────────────────────────────────────────
	if (hasArtifact) {
		sections.push(
			``,
			`## ARTIFACT GENERATION`,
			`Use \`generate_artifact\` when output should be rendered visually, not read as a code block: HTML apps, React components, SVG, Mermaid, JSON, Markdown, CSV, Flutter widgets.`,
			`Parameters: \`type\` (text/html | text/x-react | image/svg+xml | text/x-mermaid | application/json | text/markdown | text/csv | text/x-flutter), \`title\` (2–5 words), \`content\` (complete, self-contained).`,
			`- HTML: include \`<!DOCTYPE html>\`. React: top-level \`App\` function, no imports — React, useState, useEffect, Tailwind are globals. Mermaid: start with \`graph\`/\`sequenceDiagram\`/\`classDiagram\`.`,
			`- Do not use this for code snippets meant to be read — only for content meant to be rendered.`
		);
	}

	// ── Cheatsheet ───────────────────────────────────────────────────────────
	if (hasCheatsheet) {
		sections.push(
			``,
			`## CHEATSHEET GENERATION`,
			`Use \`generate_cheatsheet\` for language/library reference requests ("Python cheatsheet", "cheatsheet for React hooks").`
		);
	}

	// ── Prompt refinement ───────────────────────────────────────────────────────
	if (hasRefinePrompt) {
		sections.push(
			``,
			`## PROMPT REFINEMENT`,
			`Use \`refine_prompt\` when the request is too vague to act on. Then inspect \`data.quality.prompt_grounding\`:`,
			`- "low": tell the user what context is missing (\`data.quality.missing_signals\`) and ask before retrying.`,
			`- "medium"/"high": proceed using \`data.quality.suggested_inputs\`.`
		);
	}

	// ── Data generation ────────────────────────────────────────────────────────
	if (hasGenerateData) {
		sections.push(
			``,
			`## DATA GENERATION`,
			`Use \`generate_data\` for synthetic dataset generation. Specify domain and schema clearly in the call.`
		);
	}

	// ── Tool chaining (only examples for registered tools) ──────────────────────
	const chainExamples: string[] = [];
	if (ragActive) {
		chainExamples.push(
			'- "summarize <file>" → `get_file_chunks(<file>)` → answer',
			'- "where is X handled?" → `retrieve_docs("X")` → answer with citations'
		);
	}
	if (ragActive && hasGithub) {
		chainExamples.push(
			'- "find the auth bug and open an issue" → `retrieve_docs("auth error")` → `github_operation(create_issue)`'
		);
	}
	if (hasGraph) {
		chainExamples.push('- "show the dependency graph for X" → `get_code_graph_related("X")` → summarize');
	}
	if (hasArtifact) {
		chainExamples.push('- "build a dashboard" → `generate_artifact(type=text/html ...)`');
	}
	if (hasWebSearch) {
		chainExamples.push('- "latest version of X" → `web_search("X latest version")` → answer');
	}
	if (chainExamples.length > 0) {
		sections.push(
			``,
			`## TOOL CHAINING`,
			`Complex tasks require sequenced calls. Execute the full chain without pausing for permission between steps:`,
			...chainExamples
		);
	}

	// ── Error & loop handling ────────────────────────────────────────────────────
	sections.push(
		``,
		`## ERROR & LOOP HANDLING`,
		`- A tool that returns EMPTY (no results) is not an error: refine the query — different keywords, broader scope, or a different tool — before retrying, or tell the user nothing was found.`,
		`- A tool that returns an ERROR (failure, permission, bad params) means the operation failed: diagnose the cause, correct the inputs, and retry once. State exactly which scope or credential is required for permission errors.`,
		`- Do not call the same tool with the same arguments twice in a turn. If a retry does not help, stop and report what happened.`,
		`- Never silently fail or fabricate results.`
	);

	// ── Scope ──────────────────────────────────────────────────────────────────
	if (hasRagTool) {
		sections.push(
			``,
			`## SCOPE`,
			`Answer only from the user's uploaded content and the conversation. Do not infer beyond what was provided, and do not expose internal identifiers, storage keys, or backend file-ID formats to the user.`
		);
	}

	// ── Response style (single source of truth) ──────────────────────────────────
	sections.push(
		``,
		`## RESPONSE STYLE`,
		`- After tool use, respond in 2–3 lines summarizing the outcome; include links, SHAs, or file references where relevant.`,
		`- Do not narrate what you are about to do — execute, then report.`,
		`- Do not ask for clarification when the answer can be inferred from context or history.`,
		`- Use precise technical language; avoid filler.`
	);

	return sections.join("\n");
}

/** Tool preamble for the agentic RAG flow (runRagFlow). */
export function buildRagFlowPrompt(tools: OpenAiTool[], ragEnabled = true): string {
	return buildToolPrompt(tools, { ragEnabled });
}

/** Tool preamble for the MCP flow (runMcpFlow). */
export function buildMcpFlowPrompt(tools: OpenAiTool[], ragEnabled = true): string {
	return buildToolPrompt(tools, { ragEnabled });
}
