/**
 * runRagFlow — Lightweight agentic RAG tool-calling loop.
 *
 * Independent of MCP servers. Advertises list_files, retrieve_docs, get_file_chunks, and get_code_graph_related.
 * All RAG backend calls go through RAGClient directly — no MCP server discovery,
 * no router resolution. The outbound OpenAI completion forwards the user's
 * `locals.token` as `Authorization: Bearer` ONLY when OPENAI_FORWARD_USER_TOKEN
 * is "true" AND isValidUrl(OPENAI_BASE_URL) passes (see userTokenHeaders).
 *
 * Returns "not_applicable" when RAG is not engaged so callers can fall through
 * to the MCP flow or plain generation.
 */
import { randomUUID } from "crypto";
import { config } from "$lib/server/config";
import {
	MessageUpdateType,
	MessageToolUpdateType,
	type MessageUpdate,
} from "$lib/types/MessageUpdate";
import { ToolResultStatus } from "$lib/types/Tool";
import { logger } from "$lib/server/logger";
import { AbortedGenerations } from "$lib/server/abortedGenerations";
import { buildRagFlowPrompt } from "../utils/toolPrompt";
import { prepareMessagesWithFiles } from "$lib/server/textGeneration/utils/prepareFiles";
import { makeImageProcessor } from "$lib/server/endpoints/images";
import {
	RETRIEVE_DOCS_TOOL,
	GET_FILE_CHUNKS_TOOL,
	LIST_FILES_TOOL,
	GET_CODE_GRAPH_RELATED_TOOL,
	RAG_TOOL_NAMES,
	handleRetrieveDocs,
	handleGetFileChunks,
	handleGetCodeGraphRelated,
	type RetrieveDocsArgs,
	type GetFileChunksArgs,
	type CodeGraphRelatedArgs,
} from "$lib/server/rag/ragTools";
import { evaluate, reformulateQuery } from "$lib/server/rag/ragCritic";
import { buildRagContextMessage } from "$lib/server/rag/contextBuilder";
import { generateFromDefaultEndpoint } from "$lib/server/generateFromDefaultEndpoint";
import { userTokenHeaders } from "./forwardUserToken";
import type { TextGenerationContext } from "../types";
import type { EndpointMessage } from "../../endpoints/endpoints";
import type { ChatFileChunk } from "$lib/rag/client";
import type {
	ChatCompletionChunk,
	ChatCompletionCreateParamsStreaming,
	ChatCompletionMessageParam,
	ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import type { Stream } from "openai/streaming";

// ─── Public types ────────────────────────────────────────────────────────────

export type RagFlowResult = "completed" | "not_applicable" | "aborted" | "exhausted";

export type RunRagFlowContext = Pick<
	TextGenerationContext,
	"model" | "conv" | "locals" | "forceTools" | "ragContext"
> & {
	messages: EndpointMessage[];
	preprompt?: string;
	abortSignal?: AbortSignal;
	abortController?: AbortController;
	promptedAt?: Date;
};

// ─── Internal types ──────────────────────────────────────────────────────────

type NormalizedCall = { id: string; name: string; arguments: string };

type DispatchEvent =
	| { type: "update"; update: MessageUpdate }
	| { type: "complete"; toolMessages: ChatCompletionMessageParam[] };

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_LOOPS = 10;
const MAX_CRITIC_RETRIES = 2;
const CRITIC_TIMEOUT_MS = 1500;
// Hallucinated-tool handling: how many synthetic error replies to emit per
// iteration, and after how many consecutive all-unknown iterations to bail out.
const MAX_UNKNOWN_REPLIES_PER_ITER = 3;
const MAX_UNKNOWN_STRIKES = 2;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeXmlAttr(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function mergeChunksById(a: ChatFileChunk[], b: ChatFileChunk[]): ChatFileChunk[] {
	const m = new Map<string, ChatFileChunk>();
	for (const c of [...a, ...b]) {
		const prev = m.get(c.id);
		if (!prev || (c.similarity ?? 0) > (prev.similarity ?? 0)) m.set(c.id, c);
	}
	return [...m.values()];
}

function parseArgs(raw: string): Record<string, unknown> {
	if (!raw.trim()) return {};
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

interface GraphRelatedResponse {
	entity: string;
	anchor?: { name: string; type?: string; file?: string };
	related?: Array<{ name: string; type?: string; file?: string; relation?: string }>;
	related_count?: number;
}

function graphToMermaid(data: unknown, entity: string): string | null {
	if (!data || typeof data !== "object") return null;
	const g = data as Partial<GraphRelatedResponse>;
	const related = Array.isArray(g.related) ? g.related : [];

	const safeId = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, "_");
	// Mermaid escapes special characters in quoted labels via `#`-prefixed entity
	// codes (it substitutes #code; -> &code; at render time). Without this, names
	// like `Foo<T>`, `Array[T]`, or paths containing `"` produce invalid syntax.
	const mermaidEscape = (s: string) =>
		s
			.replace(/"/g, "#quot;")
			.replace(/</g, "#lt;")
			.replace(/>/g, "#gt;")
			.replace(/\[/g, "#91;")
			.replace(/\]/g, "#93;");
	const nodeLabel = (name: string, file?: string) =>
		file
			? `["${mermaidEscape(name)}<br/>${mermaidEscape(file)}"]`
			: `["${mermaidEscape(name)}"]`;

	const anchorId = safeId(g.anchor?.name ?? entity);
	const anchorLabel = nodeLabel(g.anchor?.name ?? entity, g.anchor?.file);

	const nodeLines: string[] = [`  ${anchorId}${anchorLabel}`];
	const edgeLines: string[] = [];
	const seen = new Set<string>([anchorId]);

	for (const r of related) {
		if (!r.name) continue;
		const rId = safeId(r.name);
		if (!seen.has(rId)) {
			nodeLines.push(`  ${rId}${nodeLabel(r.name, r.file)}`);
			seen.add(rId);
		}
		const edgeLabel = r.relation ? `-->|"${mermaidEscape(r.relation)}"| ` : "--> ";
		edgeLines.push(`  ${anchorId} ${edgeLabel}${rId}`);
	}

	if (related.length === 0) {
		nodeLines.push(`  ${anchorId}_note["(no related entities found)"]`);
		edgeLines.push(`  ${anchorId} -.-> ${anchorId}_note`);
	}

	return `graph TD\n${[...nodeLines, ...edgeLines].join("\n")}`;
}

// ─── RAG tool dispatch ───────────────────────────────────────────────────────

/**
 * Execute a batch of RAG tool calls sequentially, yielding MessageUpdate events
 * (ToolCall, ETA, Result) for real-time UI, then a final "complete" event with
 * the tool messages to append to the OpenAI conversation history.
 *
 * Includes critic loop for retrieve_docs: if verdict is RETRY and the per-call
 * retry cap (MAX_CRITIC_RETRIES) hasn't been reached, reformulates the query via a
 * 1500ms-capped LLM call, retries the backend, merges results (highest-similarity
 * wins per chunk id). The retry budget is scoped per tool call; ragContext.criticRetriesUsed
 * is still incremented for turn-level telemetry.
 *
 * Never throws — errors become <rag_result error="true"/> so the LLM can explain
 * to the user.
 */
async function* dispatchRagToolCalls(
	calls: NormalizedCall[],
	ragContext: NonNullable<TextGenerationContext["ragContext"]>,
	locals: App.Locals | undefined,
	log: typeof logger,
	abortSignal?: AbortSignal
): AsyncGenerator<DispatchEvent, void, undefined> {
	const toolMessages: ChatCompletionMessageParam[] = [];
	const ragToolCtx = { ragClient: ragContext.ragClient, inventory: ragContext.inventory };

	for (const call of calls) {
		const uuid = randomUUID();
		const argsObj = parseArgs(call.arguments);

		// Emit call + ETA so the UI shows a spinner immediately
		yield {
			type: "update",
			update: {
				type: MessageUpdateType.Tool,
				subtype: MessageToolUpdateType.Call,
				uuid,
				call: { name: call.name, parameters: argsObj as Record<string, string | number | boolean> },
			},
		};
		yield {
			type: "update",
			update: {
				type: MessageUpdateType.Tool,
				subtype: MessageToolUpdateType.ETA,
				uuid,
				eta: 8,
			},
		};

		let output: string;
		let dispatchError: string | null = null;
		// Critic-retry budget is scoped per tool call so that a multi-file turn does
		// not let the first retrieve_docs call exhaust the retries for later calls.
		let callRetriesUsed = 0;
		let graphStructured: { mermaid: string; entity: string; nodeCount: number } | null = null;
		try {
			graphStructured = null;
			if (call.name === "retrieve_docs") {
				// ── retrieve_docs: call backend + critic loop ──────────────────
				let result = await handleRetrieveDocs(argsObj as unknown as RetrieveDocsArgs, ragToolCtx);
				let verdict = evaluate(result.chunks ?? []);

				log.info(
					{
						chunks: result.chunks?.length ?? 0,
						verdict: verdict.verdict,
						maxSim: verdict.signals.maxSimilarity.toFixed(2),
					},
					"[rag] retrieve_docs returned"
				);

				if (verdict.verdict === "RETRY" && callRetriesUsed < MAX_CRITIC_RETRIES) {
					log.info(
						{ callRetriesUsed, turnRetriesUsed: ragContext.criticRetriesUsed },
						"[rag] critic RETRY — reformulating query"
					);

					const rewritten = await reformulateQuery({
						userQuery: typeof argsObj.query === "string" ? argsObj.query : "",
						fileNames: ragContext.inventory.map((f) => f.name),
						maxSim: verdict.signals.maxSimilarity,
						callLlm: (prompt: string) => {
							// Cancel the underlying LLM stream when the timeout wins the race
							// or the user aborts — Promise.race alone never cancels the loser,
							// which would leak the open generation and the timer.
							const reformulatorController = new AbortController();
							const onUserAbort = () => reformulatorController.abort();
							abortSignal?.addEventListener("abort", onUserAbort, { once: true });
							let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
							return Promise.race([
								(async () => {
									const gen = generateFromDefaultEndpoint({
										messages: [{ from: "user", content: prompt }],
										locals,
										abortSignal: reformulatorController.signal,
									});
									let streamed = "";
									let step = await gen.next();
									while (!step.done) {
										if (step.value.type === MessageUpdateType.Stream) {
											streamed += step.value.token ?? "";
										}
										step = await gen.next();
									}
									const final = typeof step.value === "string" ? step.value.trim() : "";
									return final.length > 0 ? final : streamed.trim();
								})(),
								// 1500ms safety timeout — on reject, reformulateQuery uses templated fallback
								new Promise<string>((_, rej) => {
									timeoutHandle = setTimeout(() => {
										reformulatorController.abort();
										rej(new Error(`reformulator timeout after ${CRITIC_TIMEOUT_MS}ms`));
									}, CRITIC_TIMEOUT_MS);
								}),
							]).finally(() => {
								if (timeoutHandle) clearTimeout(timeoutHandle);
								abortSignal?.removeEventListener("abort", onUserAbort);
							});
						},
					});

					if (rewritten.trim()) {
						log.info({ query: rewritten.trim() }, "[rag] retry with reformulated query");
						const retryResult = await handleRetrieveDocs(
							{
								...(argsObj as unknown as RetrieveDocsArgs),
								query: rewritten.trim(),
								rewriteQuery: rewritten.trim(),
							},
							ragToolCtx
						);
						result = {
							chunks: mergeChunksById(result.chunks ?? [], retryResult.chunks ?? []),
							error: result.error ?? retryResult.error,
						};
						verdict = evaluate(result.chunks ?? []);
						callRetriesUsed++;
						ragContext.criticRetriesUsed++;
						log.info(
							{ chunks: result.chunks?.length ?? 0, verdict: verdict.verdict },
							"[rag] after retry"
						);
					}
				}

				const chunks = result.chunks ?? [];
				ragContext.chunksAccumulator.push(...chunks);

				if (chunks.length > 0) {
					const body = buildRagContextMessage(chunks).content;
					output = `<rag_result tool="retrieve_docs" verdict="${escapeXmlAttr(verdict.verdict)}">${body}</rag_result>`;
				} else if (result.error) {
					dispatchError = result.error;
					output = `<rag_result tool="retrieve_docs" error="true" message="${escapeXmlAttr(result.error)}"/>`;
				} else {
					output = `<rag_result tool="retrieve_docs" empty="true"/>`;
				}
			} else if (call.name === "list_files") {
				// ── list_files: inventory read — no backend call needed ────────
				const files = ragContext.inventory;
				log.info({ count: files.length }, "[rag] list_files returning inventory");
				if (files.length === 0) {
					output = `<files_list empty="true"/>`;
				} else {
					const items = files
						.map(
							(f) =>
								`  <file id="${escapeXmlAttr(f.id)}" name="${escapeXmlAttr(f.name)}" type="${escapeXmlAttr(f.fileType)}" ready="${f.finishEmbedding}"/>`
						)
						.join("\n");
					output = `<files_list count="${files.length}">\n${items}\n</files_list>`;
				}
			} else if (call.name === "get_code_graph_related") {
				// ── get_code_graph_related: dependency-graph traversal ─────────
				const result = await handleGetCodeGraphRelated(
					argsObj as unknown as CodeGraphRelatedArgs,
					ragToolCtx
				);
				const graphArgs = argsObj as unknown as CodeGraphRelatedArgs;
				log.info(
					{ entity: graphArgs.entity, error: result.error ?? "none" },
					"[rag] get_code_graph_related returned"
				);
				if (result.data !== undefined) {
					const mermaid = graphToMermaid(result.data, graphArgs.entity);
					const related = Array.isArray((result.data as { related?: unknown[] }).related)
						? (result.data as { related: unknown[] }).related.length
						: 0;
					if (mermaid) {
						graphStructured = {
							mermaid,
							entity: graphArgs.entity,
							nodeCount: related + 1,
						};
					}
					output = `<graph_result tool="get_code_graph_related" entity="${escapeXmlAttr(graphArgs.entity)}">\n${JSON.stringify(result.data, null, 2)}\n</graph_result>`;
				} else {
					dispatchError = result.error ?? "unknown error";
					output = `<graph_result tool="get_code_graph_related" error="true" message="${escapeXmlAttr(result.error ?? "unknown error")}"/>`;
				}
			} else {
				// ── get_file_chunks: sequential read — no critic needed ────────
				const result = await handleGetFileChunks(
					argsObj as unknown as GetFileChunksArgs,
					ragToolCtx
				);
				// Sequential reads have no semantic similarity — null it out so the
				// UI does not show a misleading "100%" relevance bar.
				const chunks = (result.chunks ?? []).map((c) => ({ ...c, similarity: null as null }));
				ragContext.chunksAccumulator.push(...chunks);

				log.info(
					{ chunks: chunks.length, error: result.error ?? "none" },
					"[rag] get_file_chunks returned"
				);

				if (chunks.length > 0) {
					const body = buildRagContextMessage(chunks).content;
					output = `<rag_result tool="get_file_chunks">${body}</rag_result>`;
				} else if (result.error) {
					dispatchError = result.error;
					output = `<rag_result tool="get_file_chunks" error="true" message="${escapeXmlAttr(result.error)}"/>`;
				} else {
					output = `<rag_result tool="get_file_chunks" empty="true"/>`;
				}
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.error({ tool: call.name, error: msg }, "[rag] dispatch error");
			dispatchError = msg;
			output = `<rag_result tool="${call.name}" error="true" message="${escapeXmlAttr(msg)}"/>`;
		}

		const resultCall = {
			name: call.name,
			parameters: argsObj as Record<string, string | number | boolean>,
		};
		yield {
			type: "update",
			update: {
				type: MessageUpdateType.Tool,
				subtype: MessageToolUpdateType.Result,
				uuid,
				result: dispatchError
					? {
							status: ToolResultStatus.Error,
							call: resultCall,
							message: dispatchError,
							display: true,
						}
					: {
							status: ToolResultStatus.Success,
							call: resultCall,
							outputs: [
								{ text: output, ...(graphStructured ? { structured: graphStructured } : {}) },
							],
							display: true,
						},
			},
		};

		toolMessages.push({ role: "tool", tool_call_id: call.id, content: output });
	}

	yield { type: "complete", toolMessages };
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function* runRagFlow({
	model,
	conv,
	messages,
	locals,
	preprompt,
	abortSignal,
	abortController,
	promptedAt,
	ragContext,
	forceTools,
}: RunRagFlowContext): AsyncGenerator<MessageUpdate, RagFlowResult, undefined> {
	// ── Guards ────────────────────────────────────────────────────────────────
	if (!ragContext?.engaged) return "not_applicable";

	// Conversation-scoped logger so every line in this flow is correlatable.
	const log = logger.child({ conv: conv._id.toString() });

	const supportsTools = Boolean(model.supportsTools);
	if (!supportsTools && !forceTools) {
		log.info({ model: model.id ?? model.name }, "[rag] model does not support tools — skipping");
		return "not_applicable";
	}

	// ── Abort helper ──────────────────────────────────────────────────────────
	const checkAborted = (): boolean => {
		if (abortSignal?.aborted) return true;
		const abortTime = AbortedGenerations.getInstance().getAbortTime(conv._id.toString());
		if (abortTime && promptedAt && abortTime > promptedAt) {
			if (abortController && !abortController.signal.aborted) abortController.abort();
			return true;
		}
		return false;
	};

	log.info(
		{ model: model.id ?? model.name, files: ragContext.inventory.length },
		"[rag] runRagFlow start"
	);

	// ── Prepare messages for OpenAI ───────────────────────────────────────────
	const imageProcessor = makeImageProcessor({
		supportedMimeTypes: ["image/png", "image/jpeg"],
		preferredMimeType: "image/jpeg",
		maxSizeInMB: 1,
		maxWidth: 1024,
		maxHeight: 1024,
	});
	const mmEnabled = Boolean(model.multimodal);

	// ── Build OpenAI client ───────────────────────────────────────────────────
	const { OpenAI } = await import("openai");
	const openai = new OpenAI({
		apiKey: config.OPENAI_API_KEY || config.HF_TOKEN || "sk-",
		baseURL: config.OPENAI_BASE_URL,
		defaultHeaders: {
			...(config.isHuggingChat && locals?.billingOrganization
				? { "X-HF-Bill-To": locals.billingOrganization }
				: {}),
		},
	});

	// ── Build system prompt ───────────────────────────────────────────────────
	const oaTools = [
		LIST_FILES_TOOL,
		RETRIEVE_DOCS_TOOL,
		GET_FILE_CHUNKS_TOOL,
		GET_CODE_GRAPH_RELATED_TOOL,
	];
	const pieces: string[] = [];
	const toolPreprompt = buildRagFlowPrompt(oaTools, conv.ragEnabled !== false);
	if (toolPreprompt.trim()) pieces.push(toolPreprompt);
	if (preprompt?.trim()) pieces.push(preprompt);
	const mergedPreprompt = pieces.join("\n\n");

	let messagesOpenAI: ChatCompletionMessageParam[] = await prepareMessagesWithFiles(
		messages,
		imageProcessor,
		mmEnabled
	);

	if (messagesOpenAI.length > 0 && messagesOpenAI[0]?.role === "system") {
		if (mergedPreprompt) {
			const existing = messagesOpenAI[0].content ?? "";
			const existingText = typeof existing === "string" ? existing : "";
			messagesOpenAI[0].content = mergedPreprompt + (existingText ? "\n\n" + existingText : "");
		}
	} else if (mergedPreprompt) {
		messagesOpenAI = [{ role: "system", content: mergedPreprompt }, ...messagesOpenAI];
	}

	// Work around servers that reject `system` role
	if (
		typeof config.OPENAI_BASE_URL === "string" &&
		(config.OPENAI_BASE_URL.includes("hf.space") ||
			config.OPENAI_BASE_URL.includes("gradio.app")) &&
		messagesOpenAI[0]?.role === "system"
	) {
		messagesOpenAI[0] = { ...messagesOpenAI[0], role: "user" };
	}

	// ── Completion params ─────────────────────────────────────────────────────
	const parameters = { ...model.parameters } as Record<string, unknown>;
	const maxTokens =
		(parameters?.max_tokens as number | undefined) ??
		(parameters?.max_new_tokens as number | undefined) ??
		(parameters?.max_completion_tokens as number | undefined);

	const completionBase: Omit<ChatCompletionCreateParamsStreaming, "messages"> = {
		model: model.id ?? model.name,
		stream: true,
		temperature: typeof parameters?.temperature === "number" ? parameters.temperature : undefined,
		top_p: typeof parameters?.top_p === "number" ? parameters.top_p : undefined,
		stop:
			typeof parameters?.stop === "string"
				? parameters.stop
				: Array.isArray(parameters?.stop)
					? (parameters.stop as string[])
					: undefined,
		max_tokens: typeof maxTokens === "number" ? maxTokens : undefined,
		tools: oaTools,
		tool_choice: "auto",
	};

	// ── Tool-calling loop ─────────────────────────────────────────────────────
	let lastAssistantContent = "";
	let streamedContent = false;
	let thinkOpen = false;
	let unknownToolStrikes = 0;
	// Per-turn record of dispatched (tool, args) pairs so the model cannot spin on
	// the same call repeatedly — server-side backstop to the prompt's anti-loop rule.
	const seenCalls = new Set<string>();
	const callKey = (c: NormalizedCall) => `${c.name}::${c.arguments.trim()}`;

	for (let loop = 0; loop < MAX_LOOPS; loop++) {
		log.info({ loop }, "[rag] loop starting");
		if (checkAborted()) return "aborted";

		lastAssistantContent = "";
		streamedContent = false;
		thinkOpen = false;

		const completionStream: Stream<ChatCompletionChunk> = await openai.chat.completions.create(
			{ ...completionBase, messages: messagesOpenAI },
			{
				signal: abortSignal,
				headers: {
					"ChatUI-Conversation-ID": conv._id.toString(),
					"X-use-cache": "false",
					...userTokenHeaders(locals),
				},
			}
		);

		const toolCallState: Record<number, { id?: string; name?: string; arguments: string }> = {};

		for await (const chunk of completionStream) {
			const delta = chunk.choices?.[0]?.delta;
			if (!delta) continue;

			// Accumulate tool_call deltas
			for (const tc of delta.tool_calls ?? []) {
				const idx = tc.index ?? 0;
				const cur = toolCallState[idx] ?? { arguments: "" };
				if (tc.id) cur.id = tc.id;
				if (tc.function?.name) cur.name = tc.function.name;
				if (tc.function?.arguments) cur.arguments += tc.function.arguments;
				toolCallState[idx] = cur;
			}

			// Merge reasoning + content (handles <think> blocks from reasoning models)
			const deltaContent = typeof delta.content === "string" ? delta.content : "";
			const deltaReasoning: string =
				typeof (delta as unknown as Record<string, unknown>)?.reasoning === "string"
					? ((delta as unknown as { reasoning?: string }).reasoning as string)
					: typeof (delta as unknown as Record<string, unknown>)?.reasoning_content === "string"
						? ((delta as unknown as { reasoning_content?: string }).reasoning_content as string)
						: "";

			let combined = "";
			if (deltaReasoning.trim()) {
				combined += thinkOpen ? deltaReasoning : "<think>" + deltaReasoning;
				thinkOpen = true;
			}
			if (deltaContent) {
				combined += thinkOpen ? "</think>" + deltaContent : deltaContent;
				if (thinkOpen) thinkOpen = false;
			}

			if (combined) {
				lastAssistantContent += combined;
				streamedContent = true;
				yield { type: MessageUpdateType.Stream, token: combined };
			}

			if (checkAborted()) return "aborted";
		}

		log.info(
			{ loop, toolCalls: Object.keys(toolCallState).length },
			"[rag] completion stream closed"
		);
		if (checkAborted()) return "aborted";

		if (Object.keys(toolCallState).length > 0) {
			// Some providers don't stream tool_call ids — recover with a non-stream retry
			const missingId = Object.values(toolCallState).some((c) => c?.name && !c?.id);
			let calls: NormalizedCall[];

			if (missingId) {
				log.debug({ loop }, "[rag] missing tool_call id — retrying non-stream to recover");
				const nonStream = await openai.chat.completions.create(
					{ ...completionBase, messages: messagesOpenAI, stream: false },
					{ signal: abortSignal }
				);
				calls = (nonStream.choices?.[0]?.message?.tool_calls ?? []).map((t) => ({
					id: t.id,
					name: t.function?.name ?? "",
					arguments: t.function?.arguments ?? "",
				}));
			} else {
				calls = Object.values(toolCallState)
					.filter((c): c is { id: string; name: string; arguments: string } =>
						Boolean(c?.id && c?.name)
					)
					.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }));
			}

			const unknownCalls = calls.filter((c) => !RAG_TOOL_NAMES.has(c.name));
			const knownCalls = calls.filter((c) => RAG_TOOL_NAMES.has(c.name));
			// Split known calls into fresh vs. already-seen (same tool + same args this
			// turn). Fresh calls dispatch; duplicates get a DUPLICATE_CALL reply.
			const freshCalls = knownCalls.filter((c) => !seenCalls.has(callKey(c)));
			const dupCalls = knownCalls.filter((c) => seenCalls.has(callKey(c)));
			for (const c of freshCalls) seenCalls.add(callKey(c));
			log.info(
				{
					fresh: freshCalls.map((c) => c.name),
					duplicate: dupCalls.map((c) => c.name),
					unknown: unknownCalls.map((c) => c.name),
					loop,
				},
				"[rag] LLM called tools"
			);

			// Count iterations that dispatched nothing fresh (all unknown and/or all
			// duplicate) so we can bail out instead of burning the whole loop budget.
			if (freshCalls.length === 0 && calls.length > 0) unknownToolStrikes++;
			else unknownToolStrikes = 0;

			// The assistant message must carry ALL tool_calls so that every tool reply
			// below has a matching tool_call_id (OpenAI requires one reply per call).
			const toolCalls: ChatCompletionMessageToolCall[] = calls.map((c) => ({
				id: c.id,
				type: "function",
				function: { name: c.name, arguments: c.arguments },
			}));

			const assistantMsg: ChatCompletionMessageParam = {
				role: "assistant",
				// Strip reasoning blocks before sending back to the model
				content: lastAssistantContent.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, ""),
				tool_calls: toolCalls,
			};

			// Synthesize tool replies for hallucinated names and for duplicate calls so
			// the model can self-correct. Detailed UNKNOWN_TOOL replies are capped per
			// iteration to bound tokens; the overflow still gets a short reply.
			const availableTools = [...RAG_TOOL_NAMES].join(", ");
			const unknownToolMessages: ChatCompletionMessageParam[] = unknownCalls.map((c, i) => ({
				role: "tool",
				tool_call_id: c.id,
				content:
					i < MAX_UNKNOWN_REPLIES_PER_ITER
						? `<tool_error code="UNKNOWN_TOOL" name="${escapeXmlAttr(c.name)}">This tool is not available. Available tools: ${availableTools}. Use one of these or answer directly.</tool_error>`
						: `<tool_error code="UNKNOWN_TOOL" name="${escapeXmlAttr(c.name)}">Not available.</tool_error>`,
			}));
			const duplicateToolMessages: ChatCompletionMessageParam[] = dupCalls.map((c) => ({
				role: "tool",
				tool_call_id: c.id,
				content: `<tool_error code="DUPLICATE_CALL" name="${escapeXmlAttr(c.name)}">You already called this tool with the same arguments this turn. Use the earlier result, refine the arguments, or answer directly.</tool_error>`,
			}));

			let toolMessages: ChatCompletionMessageParam[] = [];
			if (freshCalls.length > 0) {
				for await (const event of dispatchRagToolCalls(
					freshCalls,
					ragContext,
					locals,
					log,
					abortSignal
				)) {
					if (event.type === "update") yield event.update;
					else toolMessages = event.toolMessages;
				}
			}

			messagesOpenAI = [
				...messagesOpenAI,
				assistantMsg,
				...unknownToolMessages,
				...duplicateToolMessages,
				...toolMessages,
			];
			if (checkAborted()) return "aborted";

			// Stuck calling no fresh tools across iterations → finalize gracefully
			// rather than looping to exhaustion (which would otherwise double-answer).
			if (unknownToolStrikes >= MAX_UNKNOWN_STRIKES) {
				log.warn(
					{ loop, unknownToolStrikes },
					"[rag] repeated unknown-tool calls — finalizing gracefully"
				);
				const stuckMsg =
					lastAssistantContent.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").trim() ||
					"I tried to use tools that aren't available here. Could you rephrase, or tell me which file you'd like me to look at?";
				if (!streamedContent) yield { type: MessageUpdateType.Stream, token: stuckMsg };
				yield { type: MessageUpdateType.FinalAnswer, text: stuckMsg, interrupted: false };
				return "completed";
			}
			continue;
		}

		// ── No tool calls: emit final answer ──────────────────────────────────
		if (thinkOpen) {
			lastAssistantContent += "</think>";
			thinkOpen = false;
		}
		if (!streamedContent && lastAssistantContent.trim()) {
			yield { type: MessageUpdateType.Stream, token: lastAssistantContent };
		}
		yield {
			type: MessageUpdateType.FinalAnswer,
			text: lastAssistantContent,
			interrupted: false,
		};
		log.info({ loop, chars: lastAssistantContent.length }, "[rag] final answer emitted");
		return "completed";
	}

	// Loop exhausted after streaming tool activity. Returning "not_applicable" here
	// would make the caller fall through to plain generation and emit a SECOND
	// answer. Finalize with the best content we have and return a terminal status.
	log.warn({ maxLoops: MAX_LOOPS }, "[rag] loop exhausted without a final answer");
	if (thinkOpen) {
		lastAssistantContent += "</think>";
		thinkOpen = false;
	}
	const exhaustMsg =
		lastAssistantContent.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").trim() ||
		"I wasn't able to complete this with the available tools. Could you narrow the question or point me at a specific file?";
	if (!streamedContent) yield { type: MessageUpdateType.Stream, token: exhaustMsg };
	yield { type: MessageUpdateType.FinalAnswer, text: exhaustMsg, interrupted: false };
	return "exhausted";
}
