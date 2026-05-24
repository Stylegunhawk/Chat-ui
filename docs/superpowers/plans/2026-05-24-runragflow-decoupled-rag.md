# Decoupled RAG Flow — `runRagFlow.ts` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken RAG-in-MCP wiring with a clean, independent `runRagFlow.ts` that owns all agentic RAG tool calls, fixes the `ragContext` forwarding bug, and strips all RAG knowledge from `runMcpFlow.ts` and `toolInvocation.ts`.

**Architecture:** `textGeneration/index.ts` tries `runRagFlow` first (when `ragContext.engaged`), then `runToolFlow` (pure MCP), then plain generation. `runRagFlow.ts` is a self-contained OpenAI tool-call loop — no MCP server discovery, no URL safety, no HF token forwarding — that dispatches `retrieve_docs` and `get_file_chunks` directly to `RAGClient`.

**Tech Stack:** SvelteKit 2, TypeScript strict, OpenAI SDK, existing `ragTools.ts` / `ragCritic.ts` / `contextBuilder.ts` (all unchanged).

**Spec:** `docs/superpowers/specs/2026-05-24-runragflow-decoupled-rag-design.md`

**Branch:** `cheatsheet`. **No git commits** — run `git add .` once at the end of each task to stage; user commits and pushes manually.

---

## File Structure (locked in)

| File                                                  | Change        | Responsibility                     |
| ----------------------------------------------------- | ------------- | ---------------------------------- |
| `src/lib/server/textGeneration/mcp/runRagFlow.ts`     | **Create**    | RAG-only tool-calling loop         |
| `src/lib/server/textGeneration/index.ts`              | **Modify**    | Orchestrate RAG → MCP → plain gen  |
| `src/lib/server/textGeneration/mcp/runMcpFlow.ts`     | **Modify**    | Remove all RAG coupling            |
| `src/lib/server/textGeneration/mcp/toolInvocation.ts` | **Modify**    | Remove RAG dispatch block          |
| `src/lib/server/rag/**`                               | **Unchanged** | Handlers, critic, gate, client     |
| `src/routes/conversation/[id]/+server.ts`             | **Unchanged** | ragContext construction is correct |
| `src/lib/server/textGeneration/types.ts`              | **Unchanged** | ragContext type already defined    |

---

## Conventions for every task

- TypeScript strict mode — no `any`, no non-null assertions
- Tabs, 100-char width (project Prettier config)
- Run `npm run check` to type-check after each task
- `git add .` at the end of each task (no commit — user commits manually)

---

## Task 1 — Create `runRagFlow.ts`

**Files:**

- Create: `src/lib/server/textGeneration/mcp/runRagFlow.ts`

- [ ] **Step 1: Create the file with all imports, types, and helpers**

Create `src/lib/server/textGeneration/mcp/runRagFlow.ts` with the full content below. This is the complete file — write it all in one step:

```typescript
/**
 * runRagFlow — Lightweight agentic RAG tool-calling loop.
 *
 * Independent of MCP servers. Advertises only retrieve_docs and get_file_chunks.
 * All RAG backend calls go through RAGClient directly — no MCP server discovery,
 * no URL safety checks, no HF token forwarding, no router resolution.
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
import { buildToolPreprompt } from "../utils/toolPrompt";
import { prepareMessagesWithFiles } from "$lib/server/textGeneration/utils/prepareFiles";
import { makeImageProcessor } from "$lib/server/endpoints/images";
import {
	RETRIEVE_DOCS_TOOL,
	GET_FILE_CHUNKS_TOOL,
	RAG_TOOL_NAMES,
	handleRetrieveDocs,
	handleGetFileChunks,
} from "$lib/server/rag/ragTools";
import { evaluate, reformulateQuery } from "$lib/server/rag/ragCritic";
import { buildRagContextMessage } from "$lib/server/rag/contextBuilder";
import { generateFromDefaultEndpoint } from "$lib/server/generateFromDefaultEndpoint";
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

export type RagFlowResult = "completed" | "not_applicable" | "aborted";

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

// ─── RAG tool dispatch ───────────────────────────────────────────────────────

/**
 * Execute a batch of RAG tool calls sequentially, yielding MessageUpdate events
 * (ToolCall, ETA, Result) for real-time UI, then a final "complete" event with
 * the tool messages to append to the OpenAI conversation history.
 *
 * Includes critic loop for retrieve_docs: if verdict is RETRY and the per-turn
 * retry cap hasn't been reached, reformulates the query via a 1500ms-capped LLM
 * call, retries the backend, merges results (highest-similarity wins per chunk id),
 * and increments ragContext.criticRetriesUsed.
 *
 * Never throws — errors become <rag_result error="true"/> so the LLM can explain
 * to the user.
 */
async function* dispatchRagToolCalls(
	calls: NormalizedCall[],
	ragContext: NonNullable<TextGenerationContext["ragContext"]>,
	locals: App.Locals | undefined
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
		try {
			if (call.name === "retrieve_docs") {
				// ── retrieve_docs: call backend + critic loop ──────────────────
				let result = await handleRetrieveDocs(
					argsObj as Parameters<typeof handleRetrieveDocs>[0],
					ragToolCtx
				);
				let verdict = evaluate(result.chunks ?? []);

				console.log(
					`[RAG] retrieve_docs returned chunks=${result.chunks?.length ?? 0} verdict=${verdict.verdict} maxSim=${verdict.signals.maxSimilarity.toFixed(2)}`
				);

				if (verdict.verdict === "RETRY" && ragContext.criticRetriesUsed < MAX_CRITIC_RETRIES) {
					console.log(
						`[RAG] critic RETRY (retriesUsed=${ragContext.criticRetriesUsed}) — reformulating query`
					);

					const rewritten = await reformulateQuery({
						userQuery: typeof argsObj.query === "string" ? argsObj.query : "",
						fileNames: ragContext.inventory.map((f) => f.name),
						maxSim: verdict.signals.maxSimilarity,
						callLlm: (prompt: string) =>
							Promise.race([
								// Drive generateFromDefaultEndpoint to completion and collect streamed text
								(async () => {
									const gen = generateFromDefaultEndpoint({
										messages: [{ from: "user", content: prompt }],
										locals,
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
								new Promise<string>((_, rej) =>
									setTimeout(
										() => rej(new Error(`reformulator timeout after ${CRITIC_TIMEOUT_MS}ms`)),
										CRITIC_TIMEOUT_MS
									)
								),
							]),
					});

					if (rewritten.trim()) {
						console.log(`[RAG] retry with reformulated query: "${rewritten.trim()}"`);
						const retryResult = await handleRetrieveDocs(
							{
								...(argsObj as Parameters<typeof handleRetrieveDocs>[0]),
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
						ragContext.criticRetriesUsed++;
						console.log(
							`[RAG] after retry: chunks=${result.chunks?.length ?? 0} new verdict=${verdict.verdict}`
						);
					}
				}

				const chunks = result.chunks ?? [];
				ragContext.chunksAccumulator.push(...chunks);

				if (chunks.length > 0) {
					const body = buildRagContextMessage(chunks).content;
					output = `<rag_result tool="retrieve_docs" verdict="${escapeXmlAttr(verdict.verdict)}">${body}</rag_result>`;
				} else if (result.error) {
					output = `<rag_result tool="retrieve_docs" error="true" message="${escapeXmlAttr(result.error)}"/>`;
				} else {
					output = `<rag_result tool="retrieve_docs" empty="true"/>`;
				}
			} else {
				// ── get_file_chunks: sequential read — no critic needed ────────
				const result = await handleGetFileChunks(
					argsObj as Parameters<typeof handleGetFileChunks>[0],
					ragToolCtx
				);
				const chunks = result.chunks ?? [];
				ragContext.chunksAccumulator.push(...chunks);

				console.log(
					`[RAG] get_file_chunks returned chunks=${chunks.length} error=${result.error ?? "none"}`
				);

				if (chunks.length > 0) {
					const body = buildRagContextMessage(chunks).content;
					output = `<rag_result tool="get_file_chunks">${body}</rag_result>`;
				} else if (result.error) {
					output = `<rag_result tool="get_file_chunks" error="true" message="${escapeXmlAttr(result.error)}"/>`;
				} else {
					output = `<rag_result tool="get_file_chunks" empty="true"/>`;
				}
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[RAG] dispatch error for ${call.name}:`, msg);
			output = `<rag_result tool="${call.name}" error="true" message="${escapeXmlAttr(msg)}"/>`;
		}

		yield {
			type: "update",
			update: {
				type: MessageUpdateType.Tool,
				subtype: MessageToolUpdateType.Result,
				uuid,
				result: {
					status: ToolResultStatus.Success,
					call: {
						name: call.name,
						parameters: argsObj as Record<string, string | number | boolean>,
					},
					outputs: [{ text: output } as unknown as Record<string, unknown>],
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

	const supportsTools = Boolean((model as unknown as { supportsTools?: boolean }).supportsTools);
	if (!supportsTools && !forceTools) {
		logger.info({ model: model.id ?? model.name }, "[rag] model does not support tools — skipping");
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

	console.log(
		`[RAG] runRagFlow start — model=${model.id ?? model.name} files=${ragContext.inventory.length}`
	);

	// ── Prepare messages for OpenAI ───────────────────────────────────────────
	const imageProcessor = makeImageProcessor({
		supportedMimeTypes: ["image/png", "image/jpeg"],
		preferredMimeType: "image/jpeg",
		maxSizeInMB: 1,
		maxWidth: 1024,
		maxHeight: 1024,
	});
	const mmEnabled = Boolean((model as unknown as { multimodal?: boolean }).multimodal);

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
	const oaTools = [RETRIEVE_DOCS_TOOL, GET_FILE_CHUNKS_TOOL];
	const pieces: string[] = [];
	const toolPreprompt = buildToolPreprompt(oaTools);
	if (toolPreprompt.trim()) pieces.push(toolPreprompt);
	if (preprompt?.trim()) pieces.push(preprompt);
	if (conv.ragEnabled === false) {
		pieces.push(
			"Note: Document search (RAG) is currently disabled. Do not call retrieve_docs or get_file_chunks. Work with conversation context only."
		);
	}
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

	for (let loop = 0; loop < MAX_LOOPS; loop++) {
		console.log(`[RAG] loop ${loop} starting`);
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
					...(locals?.token ? { Authorization: `Bearer ${locals.token}` } : {}),
				},
			}
		);

		const toolCallState: Record<number, { id?: string; name?: string; arguments: string }> = {};
		let sawToolCall = false;

		for await (const chunk of completionStream) {
			const delta = chunk.choices?.[0]?.delta;
			if (!delta) continue;

			// Accumulate tool_call deltas
			for (const tc of delta.tool_calls ?? []) {
				const call = tc as unknown as {
					index?: number;
					id?: string;
					function?: { name?: string; arguments?: string };
				};
				const idx = call.index ?? 0;
				const cur = toolCallState[idx] ?? { arguments: "" };
				if (call.id) cur.id = call.id;
				if (call.function?.name) cur.name = call.function.name;
				if (call.function?.arguments) cur.arguments += call.function.arguments;
				toolCallState[idx] = cur;
				sawToolCall = true;
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
				if (!sawToolCall) {
					streamedContent = true;
					yield { type: MessageUpdateType.Stream, token: combined };
				}
			}

			if (checkAborted()) return "aborted";
		}

		logger.info({ loop, sawToolCall }, "[rag] completion stream closed");
		if (checkAborted()) return "aborted";

		if (Object.keys(toolCallState).length > 0) {
			// Some providers don't stream tool_call ids — recover with a non-stream retry
			const missingId = Object.values(toolCallState).some((c) => c?.name && !c?.id);
			let calls: NormalizedCall[];

			if (missingId) {
				logger.debug({ loop }, "[rag] missing tool_call id — retrying non-stream to recover");
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

			// Only dispatch known RAG tools — unknown names are silently skipped
			// (the LLM may occasionally hallucinate tool names)
			calls = calls.filter((c) => RAG_TOOL_NAMES.has(c.name));
			console.log(`[RAG] LLM called ${calls.map((c) => c.name).join(", ")} on loop ${loop}`);

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

			let toolMessages: ChatCompletionMessageParam[] = [];
			for await (const event of dispatchRagToolCalls(calls, ragContext, locals)) {
				if (event.type === "update") yield event.update;
				else toolMessages = event.toolMessages;
			}

			messagesOpenAI = [...messagesOpenAI, assistantMsg, ...toolMessages];
			if (checkAborted()) return "aborted";
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
		console.log(
			`[RAG] final answer emitted on loop ${loop} (${lastAssistantContent.length} chars)`
		);
		return "completed";
	}

	logger.warn({}, "[rag] loop exhausted — returning not_applicable for plain gen fallback");
	return "not_applicable";
}
```

- [ ] **Step 2: Type-check**

```bash
npm run check
```

Expected: PASS — no errors from the new file. If you see `Cannot find module` errors, confirm the `$lib/server/rag/ragTools`, `$lib/server/rag/ragCritic`, and `$lib/server/rag/contextBuilder` paths exist (they do — see file structure in spec).

- [ ] **Step 3: Stage changes**

```bash
git add .
```

---

## Task 2 — Update `index.ts`: try RAG first, then MCP

**Files:**

- Modify: `src/lib/server/textGeneration/index.ts`

- [ ] **Step 1: Add `runRagFlow` import**

Open `src/lib/server/textGeneration/index.ts`. The current imports at the top look like:

```typescript
import { generate } from "./generate";
import { runToolFlow } from "./mcp/runMcpFlow";
```

Add the `runRagFlow` import on the line after `runToolFlow`:

```typescript
import { generate } from "./generate";
import { runToolFlow } from "./mcp/runMcpFlow";
import { runRagFlow } from "./mcp/runRagFlow";
```

- [ ] **Step 2: Replace `textGenerationWithoutTitle` body**

Find the entire `textGenerationWithoutTitle` function (starts around line 36). Replace the `try` block inside it (lines ~54–94) with the following. The surrounding function signature and `yield Started` line stay unchanged — only the `try` block changes:

```typescript
const processedMessages = await preprocessMessages(messages, convId);

try {
	// ── 1. Agentic RAG loop (when gate engaged) ───────────────────────────
	// Owns all retrieve_docs / get_file_chunks calls. MCP flow never sees them.
	if (ctx.ragContext?.engaged) {
		const ragGen = runRagFlow({
			model: ctx.model,
			conv,
			messages: processedMessages,
			locals: ctx.locals,
			forceTools: ctx.forceTools,
			preprompt,
			abortSignal: ctx.abortController.signal,
			abortController: ctx.abortController,
			promptedAt: ctx.promptedAt,
			ragContext: ctx.ragContext,
		});
		let ragStep = await ragGen.next();
		while (!ragStep.done) {
			yield ragStep.value;
			ragStep = await ragGen.next();
		}
		const ragResult = ragStep.value;
		if (ragResult === "completed" || ragResult === "aborted") {
			done.abort();
			return;
		}
		// "not_applicable" → model doesn't support tools → fall through to MCP / plain gen
	}

	// ── 2. MCP tool loop (pure MCP — no RAG tools) ───────────────────────
	const mcpGen = runToolFlow({
		model: ctx.model,
		conv,
		messages: processedMessages,
		assistant: ctx.assistant,
		forceMultimodal: ctx.forceMultimodal,
		forceTools: ctx.forceTools,
		provider: ctx.provider,
		locals: ctx.locals,
		preprompt,
		abortSignal: ctx.abortController.signal,
		abortController: ctx.abortController,
		promptedAt: ctx.promptedAt,
		ragFiles: ctx.ragFiles,
	});
	let mcpStep = await mcpGen.next();
	while (!mcpStep.done) {
		yield mcpStep.value;
		mcpStep = await mcpGen.next();
	}
	const mcpResult = mcpStep.value;
	if (mcpResult !== "not_applicable") {
		done.abort();
		return;
	}

	// ── 3. Plain generation fallback ──────────────────────────────────────
	yield * generate({ ...ctx, messages: processedMessages }, preprompt);
} catch (err) {
	const isAbort =
		ctx.abortController.signal.aborted ||
		(err instanceof Error &&
			(err.name === "AbortError" ||
				err.name === "APIUserAbortError" ||
				err.message.includes("Request was aborted")));
	if (!isAbort) {
		yield * generate({ ...ctx, messages: processedMessages }, preprompt);
	}
}
done.abort();
```

- [ ] **Step 3: Type-check**

```bash
npm run check
```

Expected: PASS. If you see `Property 'ragContext' does not exist on type 'RunToolFlowContext'`, that's expected — we'll fix that in Task 3 when we update `runMcpFlow.ts`. If the error is only in `runMcpFlow.ts`, proceed; the file we edited (`index.ts`) should be clean.

- [ ] **Step 4: Stage changes**

```bash
git add .
```

---

## Task 3 — Strip RAG from `runMcpFlow.ts`

**Files:**

- Modify: `src/lib/server/textGeneration/mcp/runMcpFlow.ts`

- [ ] **Step 1: Remove the `RETRIEVE_DOCS_TOOL` / `GET_FILE_CHUNKS_TOOL` import**

Find line 45 (approximately):

```typescript
import { GET_FILE_CHUNKS_TOOL, RETRIEVE_DOCS_TOOL } from "$lib/server/rag/ragTools";
```

Delete this line entirely.

- [ ] **Step 2: Remove `"ragContext"` from `RunToolFlowContext`**

Find the `RunToolFlowContext` type definition (around line 47). It currently reads:

```typescript
export type RunToolFlowContext = Pick<
	TextGenerationContext,
	| "model"
	| "conv"
	| "assistant"
	| "forceMultimodal"
	| "forceTools"
	| "provider"
	| "locals"
	| "ragFiles"
	| "ragContext"
> & { messages: EndpointMessage[] };
```

Remove the `| "ragContext"` line so it becomes:

```typescript
export type RunToolFlowContext = Pick<
	TextGenerationContext,
	| "model"
	| "conv"
	| "assistant"
	| "forceMultimodal"
	| "forceTools"
	| "provider"
	| "locals"
	| "ragFiles"
> & { messages: EndpointMessage[] };
```

- [ ] **Step 3: Remove `ragContext` from the function signature**

Find the `runToolFlow` function signature. It destructures parameters including `ragContext`. Remove `ragContext,` from the destructure list:

Before (find this block in the function signature):

```typescript
	ragFiles,
	ragContext,
}: RunMcpFlowContext & {
```

After:

```typescript
	ragFiles,
}: RunMcpFlowContext & {
```

- [ ] **Step 4: Simplify the first zero-servers check (~line 170)**

Find this block:

```typescript
if (servers.length === 0) {
	if (ragContext?.engaged) {
		console.log(
			"[RAG] zero MCP servers (post merge/name filter) but ragContext engaged — continuing for local RAG tools"
		);
	} else {
		logger.warn({}, "[mcp] no MCP servers selected after merge/name filter");
		return "not_applicable";
	}
}
```

Replace with:

```typescript
if (servers.length === 0) {
	logger.warn({}, "[mcp] no MCP servers selected after merge/name filter");
	return "not_applicable";
}
```

- [ ] **Step 5: Simplify the second zero-servers check (~line 201, after URL safety)**

Find this block:

```typescript
if (servers.length === 0) {
	if (ragContext?.engaged) {
		console.log(
			"[RAG] all MCP servers rejected by URL safety, but ragContext engaged — continuing for local RAG tools"
		);
	} else {
		logger.warn({}, "[mcp] all selected MCP servers rejected by URL safety guard");
		return "not_applicable";
	}
}
```

Replace with:

```typescript
if (servers.length === 0) {
	logger.warn({}, "[mcp] all selected MCP servers rejected by URL safety guard");
	return "not_applicable";
}
```

- [ ] **Step 6: Remove the third zero-servers / ragContext check (~line 276)**

Find and delete this entire block (it is now unreachable because the two checks above already return):

```typescript
if (servers.length === 0 && !ragContext?.engaged) {
	return "not_applicable";
}
if (servers.length === 0) {
	console.log(
		"[RAG] zero MCP servers but ragContext engaged — proceeding to RAG tool advertisement"
	);
}
```

- [ ] **Step 7: Remove the RAG tool advertisement block (~line 342)**

Find and delete this entire `if/else` block:

```typescript
if (ragContext?.engaged) {
	oaTools.push(RETRIEVE_DOCS_TOOL, GET_FILE_CHUNKS_TOOL);
	console.log(
		`[RAG] tools advertised: retrieve_docs, get_file_chunks (inventory=${ragContext.inventory.length} files)`
	);
	logger.info({ tools: ["retrieve_docs", "get_file_chunks"] }, "[mcp] RAG tools advertised");
} else {
	console.log(`[RAG] tools NOT advertised (ragContext.engaged=${Boolean(ragContext?.engaged)})`);
}
```

- [ ] **Step 8: Remove `ragContext` from the `executeToolCalls` call (~line 739)**

Find the `executeToolCalls({` call. It currently includes `ragContext,`. Remove that line:

Before:

```typescript
const exec = executeToolCalls({
	calls,
	mapping,
	servers,
	parseArgs,
	resolveFileRef,
	toPrimitive,
	processToolOutput,
	abortSignal,
	locals,
	ragFiles,
	ragContext,
});
```

After:

```typescript
const exec = executeToolCalls({
	calls,
	mapping,
	servers,
	parseArgs,
	resolveFileRef,
	toPrimitive,
	processToolOutput,
	abortSignal,
	locals,
	ragFiles,
});
```

- [ ] **Step 9: Type-check**

```bash
npm run check
```

Expected: PASS. Any remaining errors should only reference `ragContext` inside `toolInvocation.ts` — those are fixed in Task 4.

- [ ] **Step 10: Stage changes**

```bash
git add .
```

---

## Task 4 — Strip RAG from `toolInvocation.ts`

**Files:**

- Modify: `src/lib/server/textGeneration/mcp/toolInvocation.ts`

- [ ] **Step 1: Remove RAG-specific imports**

Find the following lines in the import block and make these exact changes:

**Line 1** — `ChatFileChunk` is only used in the RAG block. `RagFileMetadata` is still used for `ragFiles`. Change:

```typescript
import type { ChatFileChunk, RagFileMetadata } from "$lib/rag/client";
```

To:

```typescript
import type { RagFileMetadata } from "$lib/rag/client";
```

**Line 2** — `RAGClient` is only used in the removed `ragContext` type. Delete entirely:

```typescript
import type { RAGClient } from "$lib/server/rag/client";
```

**Line 3** — Only used in RAG block. Delete entirely:

```typescript
import { buildRagContextMessage } from "$lib/server/rag/contextBuilder";
```

**Line 4** — Only used in RAG block. Delete entirely:

```typescript
import { evaluate, reformulateQuery } from "$lib/server/rag/ragCritic";
```

**Line 5** — Only used in RAG block. Delete entirely:

```typescript
import { RAG_TOOL_NAMES, handleGetFileChunks, handleRetrieveDocs } from "$lib/server/rag/ragTools";
```

**Line 6** — Only used in RAG block. Delete entirely:

```typescript
import { generateFromDefaultEndpoint } from "$lib/server/generateFromDefaultEndpoint";
```

- [ ] **Step 2: Remove `ragContext` from `ExecuteToolCallsParams`**

Find the `ExecuteToolCallsParams` interface. Remove the `ragContext` field:

Before:

```typescript
export interface ExecuteToolCallsParams {
	calls: NormalizedToolCall[];
	mapping: Record<string, McpToolMapping>;
	servers: McpServerConfig[];
	parseArgs: (raw: unknown) => Record<string, unknown>;
	resolveFileRef?: FileRefResolver;
	toPrimitive: (value: unknown) => Primitive | undefined;
	processToolOutput: (text: string) => {
		annotated: string;
		sources: { index: number; link: string }[];
	};
	abortSignal?: AbortSignal;
	toolTimeoutMs?: number;
	locals?: App.Locals;
	ragFiles?: RagFileMetadata[];
	ragContext?: {
		engaged: boolean;
		inventory: RagFileMetadata[];
		ragClient: RAGClient;
		chunksAccumulator: ChatFileChunk[];
		criticRetriesUsed: number;
	};
}
```

After:

```typescript
export interface ExecuteToolCallsParams {
	calls: NormalizedToolCall[];
	mapping: Record<string, McpToolMapping>;
	servers: McpServerConfig[];
	parseArgs: (raw: unknown) => Record<string, unknown>;
	resolveFileRef?: FileRefResolver;
	toPrimitive: (value: unknown) => Primitive | undefined;
	processToolOutput: (text: string) => {
		annotated: string;
		sources: { index: number; link: string }[];
	};
	abortSignal?: AbortSignal;
	toolTimeoutMs?: number;
	locals?: App.Locals;
	ragFiles?: RagFileMetadata[];
}
```

- [ ] **Step 3: Remove `ragContext` from `executeToolCalls` function signature**

Find the destructured parameter list of `executeToolCalls`. Remove `ragContext,` from it:

Before (find in function signature):

```typescript
	locals,
	ragFiles,
	ragContext,
}: ExecuteToolCallsParams
```

After:

```typescript
	locals,
	ragFiles,
}: ExecuteToolCallsParams
```

- [ ] **Step 4: Remove `mergeChunksById` helper**

Find and delete this function entirely:

```typescript
function mergeChunksById(existing: ChatFileChunk[], retry: ChatFileChunk[]): ChatFileChunk[] {
	const merged = new Map<string, ChatFileChunk>();
	for (const chunk of [...existing, ...retry]) {
		const prev = merged.get(chunk.id);
		if (!prev) {
			merged.set(chunk.id, chunk);
			continue;
		}
		const prevSimilarity = prev.similarity ?? Number.NEGATIVE_INFINITY;
		const nextSimilarity = chunk.similarity ?? Number.NEGATIVE_INFINITY;
		if (nextSimilarity > prevSimilarity) {
			merged.set(chunk.id, chunk);
		}
	}
	return [...merged.values()];
}
```

- [ ] **Step 5: Remove the RAG dispatch block**

Find the `if (RAG_TOOL_NAMES.has(p.call.name) && ragContext)` block inside the `tasks` array `.map()`. Delete from the opening `if` all the way to the closing `return;` and the empty line after it. The block starts at approximately line 359 and ends around line 544:

```typescript
if (RAG_TOOL_NAMES.has(p.call.name) && ragContext) {
	// ... ~90 lines ...
	return;
}

// Log if a known RAG tool name came in but ragContext is missing ...
if (RAG_TOOL_NAMES.has(p.call.name) && !ragContext) {
	console.warn(
		`[RAG] tool ${p.call.name} requested but ragContext is undefined — RAG path skipped, will return "Unknown MCP function" error to LLM`
	);
}
```

Delete both of these `if` blocks entirely (from the first `if (RAG_TOOL_NAMES.has...` through the closing `}` of the second one, inclusive). The next line after the deletion should be:

```typescript
const mappingEntry = mapping[p.call.name];
```

- [ ] **Step 6: Remove `escapeXmlAttribute` function**

Find and delete this function (only used in the RAG dispatch block, now removed):

```typescript
function escapeXmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
```

- [ ] **Step 7: Also remove the `MAX_CRITIC_RETRIES_PER_TURN` constant**

Find and delete this line (only used by the removed RAG dispatch block):

```typescript
const MAX_CRITIC_RETRIES_PER_TURN = 2;
```

- [ ] **Step 8: Type-check**

```bash
npm run check
```

Expected: PASS — zero errors. The entire codebase should now be clean.

- [ ] **Step 9: Lint**

```bash
npm run lint
```

Expected: PASS. Fix any import-order or formatting issues Prettier reports.

- [ ] **Step 10: Stage changes**

```bash
git add .
```

---

## Task 5 — Smoke test via dev server

- [ ] **Step 1: Start the dev server with agentic RAG enabled**

```bash
AGENTIC_RAG=1 npm run dev
```

Wait until you see `Local: http://localhost:5173` in the output.

- [ ] **Step 2: Verify gate — no files uploaded**

Open `http://localhost:5173` in a browser. Start a new conversation. Send any message (e.g. "hello"). Check the server terminal for:

```
[RAG] Agentic gate: SKIPPED (files=0)
```

No `[RAG] runRagFlow start` should appear. The response should come from plain generation (no tools).

- [ ] **Step 3: Verify gate — with files, general query**

Upload a file (e.g. any `.py` or `.txt` file via the file upload button). Send: `"hello how are you"`.

Expected server log:

```
[RAG] Agentic gate: SKIPPED (files=1)
```

Again no `runRagFlow start`. General questions don't engage the gate.

- [ ] **Step 4: Verify RAG tools — file-relevant query**

With the same uploaded file, send: `"summarize my file"` (or `"explain auth.py"` if you uploaded a Python file).

Expected server logs (in order):

```
[RAG] Agentic gate: ENGAGED (files=1)
[RAG] runRagFlow start — model=<model-name> files=1
[RAG] loop 0 starting
[RAG] LLM called retrieve_docs on loop 0
[RAG] retrieve_docs returned chunks=N verdict=PASS|RETRY maxSim=0.XX
[RAG] final answer emitted on loop 1 (XXX chars)
```

The LLM response should cite specific content from your uploaded file with `<coderef>` blocks visible in the UI.

- [ ] **Step 5: Verify MCP is unaffected (if MCP servers configured)**

If you have `MCP_SERVERS` configured in `.env.local`, send a query that would trigger MCP (e.g. a GitHub question). Confirm MCP tools still work and no `[RAG]` logs appear for that turn.

- [ ] **Step 6: Kill dev server**

`Ctrl-C` in the terminal running `npm run dev`.

- [ ] **Step 7: Final type-check + lint**

```bash
npm run check && npm run lint
```

Expected: PASS.

- [ ] **Step 8: Stage all changes**

```bash
git add .
```

All changes are now staged. User reviews and commits manually.

---

## Summary of changes staged

| File                                                  | What changed                              |
| ----------------------------------------------------- | ----------------------------------------- |
| `src/lib/server/textGeneration/mcp/runRagFlow.ts`     | **New** — self-contained RAG tool loop    |
| `src/lib/server/textGeneration/index.ts`              | Orchestration: try RAG → MCP → plain gen  |
| `src/lib/server/textGeneration/mcp/runMcpFlow.ts`     | Removed RAG bypasses + tool advertisement |
| `src/lib/server/textGeneration/mcp/toolInvocation.ts` | Removed RAG dispatch block + imports      |
