import { randomUUID } from "crypto";
import { logger } from "../../logger";
import type { MessageUpdate } from "$lib/types/MessageUpdate";
import { MessageToolUpdateType, MessageUpdateType } from "$lib/types/MessageUpdate";
import type { MessageToolConfirmUpdate } from "$lib/types/MessageUpdate";
import { ToolResultStatus } from "$lib/types/Tool";
import type { ChatFileChunk, RagFileMetadata } from "$lib/rag/client";
import type { RAGClient } from "$lib/server/rag/client";
import { buildRagContextMessage } from "$lib/server/rag/contextBuilder";
import { evaluate, reformulateQuery } from "$lib/server/rag/ragCritic";
import { RAG_TOOL_NAMES, handleGetFileChunks, handleRetrieveDocs } from "$lib/server/rag/ragTools";
import { generateFromDefaultEndpoint } from "$lib/server/generateFromDefaultEndpoint";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { McpToolMapping } from "$lib/server/mcp/tools";
import type { McpServerConfig } from "$lib/server/mcp/httpClient";
import {
	callMcpTool,
	getMcpToolTimeoutMs,
	type McpToolTextResponse,
} from "$lib/server/mcp/httpClient";
import { getClient } from "$lib/server/mcp/clientPool";
import { attachFileRefsToArgs, type FileRefResolver } from "./fileRefs";
import type { Client } from "@modelcontextprotocol/sdk/client";
import { createConfirmation } from "../../mcp/confirmationBuffer";

export type Primitive = string | number | boolean;

export type ToolRun = {
	name: string;
	parameters: Record<string, Primitive>;
	output: string;
};

export interface NormalizedToolCall {
	id: string;
	name: string;
	arguments: string;
}

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

export interface ToolCallExecutionResult {
	toolMessages: ChatCompletionMessageParam[];
	toolRuns: ToolRun[];
	finalAnswer?: { text: string; interrupted: boolean };
}

export type ToolExecutionEvent =
	| { type: "update"; update: MessageUpdate }
	| { type: "complete"; summary: ToolCallExecutionResult };

const serverMap = (servers: McpServerConfig[]): Map<string, McpServerConfig> => {
	const map = new Map<string, McpServerConfig>();
	for (const server of servers) {
		if (server?.name) {
			map.set(server.name, server);
		}
	}
	return map;
};

const CLIENT_SIDE_TOOLS = new Set<string>(["generate_artifact"]);
const MAX_CRITIC_RETRIES_PER_TURN = 2;

function escapeXmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

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

export async function* executeToolCalls({
	calls,
	mapping,
	servers,
	parseArgs,
	resolveFileRef,
	toPrimitive,
	processToolOutput,
	abortSignal,
	toolTimeoutMs,
	locals,
	ragFiles,
	ragContext,
}: ExecuteToolCallsParams): AsyncGenerator<ToolExecutionEvent, void, undefined> {
	const effectiveTimeoutMs = toolTimeoutMs ?? getMcpToolTimeoutMs();
	const toolMessages: ChatCompletionMessageParam[] = [];
	const toolRuns: ToolRun[] = [];
	const serverLookup = serverMap(servers);
	// Pre-emit call + ETA updates and prepare tasks
	type TaskResult = {
		index: number;
		output?: string;
		structured?: unknown;
		blocks?: unknown[];
		error?: string;
		uuid: string;
		paramsClean: Record<string, Primitive>;
	};

	const prepared = calls.map((call) => {
		const argsObj = parseArgs(call.arguments) as Record<string, unknown> & {
			context?: Record<string, unknown> & { file_url?: string; available_files?: unknown[] };
			query?: string;
			file_path?: string;
			commit_message?: string;
			repo_name?: string;
			branch_name?: string;
			head_branch?: string;
			base_branch?: string;
			source_branch?: string;
			content?: string;
			fields?: unknown;
		};
		const paramsClean: Record<string, Primitive> = {};
		for (const [k, v] of Object.entries(argsObj ?? {})) {
			const prim = toPrimitive(v);
			if (prim !== undefined) paramsClean[k] = prim;
		}
		// Attach any resolved image payloads _after_ computing paramsClean so that
		// logging / status updates continue to show only the lightweight primitive
		// arguments (e.g. "image_1") while the full data: URLs or image blobs are
		// only sent to the MCP tool server.
		attachFileRefsToArgs(argsObj, resolveFileRef);
		return {
			call,
			argsObj,
			paramsClean,
			uuid: randomUUID(),
			ambiguityError: undefined as string | undefined,
		};
	});

	// Inject GitHub token for github_operation tool calls
	for (const p of prepared) {
		const mappingEntry = mapping[p.call.name];
		if (
			mappingEntry?.tool === "github_operation" &&
			locals?.settings &&
			typeof locals.settings.githubToken === "string"
		) {
			p.argsObj.context = {
				...(p.argsObj.context as Record<string, unknown> | undefined),
				github_token: locals.settings.githubToken,
			};
		}
		// Inject RAG file_url if filename matches query or file_path
		if (
			mappingEntry?.tool === "github_operation" &&
			Array.isArray(ragFiles) &&
			ragFiles.length > 0
		) {
			const query = String(p.argsObj.query || "").toLowerCase();
			const filePath = String(p.argsObj.file_path || "").toLowerCase();

			// 1. Try Exact Matches
			const exactMatches = ragFiles.filter(
				(f) => query.includes(f.name.toLowerCase()) || filePath.includes(f.name.toLowerCase())
			);

			if (exactMatches.length === 1) {
				const ctx = p.argsObj.context ?? {};
				ctx.file_url = exactMatches[0].url;
				p.argsObj.context = ctx;
			} else if (exactMatches.length > 1) {
				p.ambiguityError = `Multiple exact matches found: ${exactMatches.map((f) => f.name).join(", ")}. Please be more specific.`;
			} else {
				// 2. Try Extension-less Matches
				const extLessMatches = ragFiles.filter((f) => {
					const nameWithoutExt = f.name.replace(/\.[^/.]+$/, "").toLowerCase();
					return query.includes(nameWithoutExt) || filePath.includes(nameWithoutExt);
				});

				if (extLessMatches.length === 1) {
					const ctx = p.argsObj.context ?? {};
					ctx.file_url = extLessMatches[0].url;
					p.argsObj.context = ctx;
				} else if (extLessMatches.length > 1) {
					p.ambiguityError = `Ambiguous reference. Multiple files match: ${extLessMatches.map((f) => f.name).join(", ")}. Please specify the extension.`;
				}
			}
		}

		// Normalize generate_data fields (GPT-OSS often sends objects instead of strings)
		if (mappingEntry?.tool === "generate_data") {
			const fields = p.argsObj.fields;
			if (Array.isArray(fields)) {
				p.argsObj.fields = fields.map((item) => {
					if (typeof item === "object" && item !== null) {
						const obj = item as Record<string, unknown>;
						if ("name" in obj && typeof obj.name === "string") {
							return obj.name;
						}
						return Object.keys(obj)[0];
					}
					return String(item);
				});
				// Refresh paramsClean for logging/UI
				for (const [k, v] of Object.entries(p.argsObj)) {
					const prim = toPrimitive(v);
					if (prim !== undefined) p.paramsClean[k] = prim;
				}
			}
		}
	}

	for (const p of prepared) {
		yield {
			type: "update",
			update: {
				type: MessageUpdateType.Tool,
				subtype: MessageToolUpdateType.Call,
				uuid: p.uuid,
				call: { name: p.call.name, parameters: p.paramsClean },
			},
		};
		yield {
			type: "update",
			update: {
				type: MessageUpdateType.Tool,
				subtype: MessageToolUpdateType.ETA,
				uuid: p.uuid,
				eta: 10,
			},
		};
	}

	// Preload clients per distinct server used in this batch
	const distinctServerNames = Array.from(
		new Set(prepared.map((p) => mapping[p.call.name]?.server).filter(Boolean) as string[])
	);
	const clientMap = new Map<string, Client>();
	await Promise.all(
		distinctServerNames.map(async (name) => {
			const cfg = serverLookup.get(name);
			if (!cfg) return;
			try {
				const client = await getClient(cfg, abortSignal);
				clientMap.set(name, client);
			} catch (e) {
				logger.warn({ server: name, err: String(e) }, "[mcp] failed to connect client");
			}
		})
	);

	// Async queue to stream results in finish order
	function createQueue<T>() {
		const items: T[] = [];
		const waiters: Array<(v: IteratorResult<T>) => void> = [];
		let closed = false;
		return {
			push(item: T) {
				const waiter = waiters.shift();
				if (waiter) waiter({ value: item, done: false });
				else items.push(item);
			},
			close() {
				closed = true;
				let waiter: ((v: IteratorResult<T>) => void) | undefined;
				while ((waiter = waiters.shift())) {
					waiter({ value: undefined as unknown as T, done: true });
				}
			},
			async *iterator() {
				for (;;) {
					if (items.length) {
						const first = items.shift();
						if (first !== undefined) yield first as T;
						continue;
					}
					if (closed) return;
					const value: IteratorResult<T> = await new Promise((res) => waiters.push(res));
					if (value.done) return;
					yield value.value as T;
				}
			},
		};
	}

	const updatesQueue = createQueue<MessageUpdate>();
	const results: TaskResult[] = [];

	const tasks = prepared.map(async (p, index) => {
		// Check abort before starting each tool call
		if (abortSignal?.aborted) {
			const message = "Aborted by user";
			results.push({
				index,
				error: message,
				uuid: p.uuid,
				paramsClean: p.paramsClean,
			});
			updatesQueue.push({
				type: MessageUpdateType.Tool,
				subtype: MessageToolUpdateType.Error,
				uuid: p.uuid,
				message,
			});
			return;
		}

		if (p.ambiguityError) {
			const message = p.ambiguityError;
			results.push({
				index,
				error: message,
				uuid: p.uuid,
				paramsClean: p.paramsClean,
			});
			updatesQueue.push({
				type: MessageUpdateType.Tool,
				subtype: MessageToolUpdateType.Error,
				uuid: p.uuid,
				message,
			});
			return;
		}

		if (RAG_TOOL_NAMES.has(p.call.name) && ragContext) {
			console.log(
				`[RAG] dispatch START tool=${p.call.name} args=${JSON.stringify(p.paramsClean)}`
			);
			const dispatchStartTime = Date.now();
			try {
				const ragToolCtx = {
					ragClient: ragContext.ragClient,
					inventory: ragContext.inventory,
				};
				const toolName = p.call.name;
				let result:
					| Awaited<ReturnType<typeof handleRetrieveDocs>>
					| Awaited<ReturnType<typeof handleGetFileChunks>>;
				let verdictValue: string | undefined;

				if (toolName === "retrieve_docs") {
					console.log(`[RAG] handleRetrieveDocs calling backend...`);
					result = await handleRetrieveDocs(
						p.argsObj as unknown as Parameters<typeof handleRetrieveDocs>[0],
						ragToolCtx
					);
					console.log(
						`[RAG] handleRetrieveDocs returned chunks=${result.chunks?.length ?? 0} error=${result.error ?? "none"} (${Date.now() - dispatchStartTime}ms)`
					);
					let verdict = evaluate(result.chunks ?? []);
					verdictValue = verdict.verdict;
					console.log(
						`[RAG] Critic verdict: ${verdict.verdict} (maxSim=${verdict.signals.maxSimilarity.toFixed(2)}, entry=${verdict.signals.entryCount}, graphOnly=${verdict.signals.graphOnlyRatio.toFixed(2)})`
					);

					if (
						verdict.verdict === "RETRY" &&
						ragContext.criticRetriesUsed < MAX_CRITIC_RETRIES_PER_TURN
					) {
						console.log(
							`[RAG] Critic firing RETRY (retriesUsed=${ragContext.criticRetriesUsed}/${MAX_CRITIC_RETRIES_PER_TURN})`
						);
						const originalQuery = typeof p.argsObj.query === "string" ? p.argsObj.query : "";
						const CRITIC_TIMEOUT_MS = 1500;
						const rewrittenQuery = await reformulateQuery({
							userQuery: originalQuery,
							fileNames: ragContext.inventory.map((f) => f.name),
							maxSim: verdict.signals.maxSimilarity,
							callLlm: (prompt: string) => {
								// Race the LLM call against the spec'd 1.5s timeout (§7.2).
								// On timeout, the callLlm rejection makes reformulateQuery fall
								// back to its templated form.
								const llmCall = (async () => {
									const generation = generateFromDefaultEndpoint({
										messages: [{ from: "user", content: prompt }],
										locals,
									});
									let streamed = "";
									let step = await generation.next();
									while (!step.done) {
										if (step.value.type === MessageUpdateType.Stream) {
											streamed += step.value.token ?? "";
										}
										step = await generation.next();
									}
									const finalText = typeof step.value === "string" ? step.value : "";
									return finalText.trim().length > 0 ? finalText.trim() : streamed.trim();
								})();
								const timeout = new Promise<string>((_, reject) => {
									setTimeout(
										() => reject(new Error(`reformulator timeout after ${CRITIC_TIMEOUT_MS}ms`)),
										CRITIC_TIMEOUT_MS
									);
								});
								return Promise.race([llmCall, timeout]);
							},
						});

						const trimmedRewrite = typeof rewrittenQuery === "string" ? rewrittenQuery.trim() : "";
						console.log(`[RAG] Reformulated query: "${trimmedRewrite}"`);
						if (trimmedRewrite.length > 0) {
							console.log(`[RAG] Retry backend call with reformulated query...`);
							const retryResult = await handleRetrieveDocs(
								{
									...(p.argsObj as unknown as Parameters<typeof handleRetrieveDocs>[0]),
									query: trimmedRewrite,
									rewriteQuery: trimmedRewrite,
								},
								ragToolCtx
							);
							result = {
								...result,
								chunks: mergeChunksById(result.chunks ?? [], retryResult.chunks ?? []),
								error: result.error ?? retryResult.error,
							};
							verdict = evaluate(result.chunks ?? []);
							verdictValue = verdict.verdict;
							ragContext.criticRetriesUsed += 1;
							console.log(
								`[RAG] After retry: chunks=${result.chunks?.length ?? 0}, new verdict=${verdict.verdict}`
							);
						}
					}
				} else {
					console.log(`[RAG] handleGetFileChunks calling backend...`);
					result = await handleGetFileChunks(
						p.argsObj as unknown as Parameters<typeof handleGetFileChunks>[0],
						ragToolCtx
					);
					console.log(
						`[RAG] handleGetFileChunks returned chunks=${result.chunks?.length ?? 0} error=${result.error ?? "none"} (${Date.now() - dispatchStartTime}ms)`
					);
				}

				const resultChunks = Array.isArray(result.chunks) ? result.chunks : [];
				ragContext.chunksAccumulator.push(...resultChunks);
				console.log(
					`[RAG] dispatch DONE tool=${p.call.name} chunks=${resultChunks.length} totalTime=${Date.now() - dispatchStartTime}ms (accumulator total=${ragContext.chunksAccumulator.length})`
				);

				let output: string;
				if (resultChunks.length > 0) {
					const ragMessage = buildRagContextMessage(resultChunks);
					const attrs = [
						`tool="${toolName}"`,
						verdictValue ? `verdict="${escapeXmlAttribute(verdictValue)}"` : undefined,
						result.error ? `error="true"` : undefined,
					]
						.filter(Boolean)
						.join(" ");
					output = `<rag_result ${attrs}>${ragMessage.content}</rag_result>`;
				} else if (result.error) {
					output = `<rag_result tool="${toolName}" error="true" message="${escapeXmlAttribute(result.error)}"/>`;
				} else {
					output = `<rag_result tool="${toolName}" empty="true"/>`;
				}

				results.push({
					index,
					output,
					structured: {
						tool: toolName,
						chunks: resultChunks,
						error: result.error,
						verdict: verdictValue,
					},
					uuid: p.uuid,
					paramsClean: p.paramsClean,
				});
				updatesQueue.push({
					type: MessageUpdateType.Tool,
					subtype: MessageToolUpdateType.Result,
					uuid: p.uuid,
					result: {
						status: ToolResultStatus.Success,
						call: { name: p.call.name, parameters: p.paramsClean },
						outputs: [
							{
								text: output,
								structured: {
									chunks: resultChunks,
									error: result.error,
									verdict: verdictValue,
								},
							} as unknown as Record<string, unknown>,
						],
						display: true,
					},
				});
				console.log(`[RAG] result pushed to queue (output length=${output.length} chars)`);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.error(
					`[RAG] dispatch THREW after ${Date.now() - dispatchStartTime}ms:`,
					message
				);
				results.push({
					index,
					error: message,
					uuid: p.uuid,
					paramsClean: p.paramsClean,
				});
				updatesQueue.push({
					type: MessageUpdateType.Tool,
					subtype: MessageToolUpdateType.Error,
					uuid: p.uuid,
					message,
				});
			}
			return;
		}

		// Log if a known RAG tool name came in but ragContext is missing (would otherwise
		// silently fall through to "Unknown MCP function" branch)
		if (RAG_TOOL_NAMES.has(p.call.name) && !ragContext) {
			console.warn(
				`[RAG] tool ${p.call.name} requested but ragContext is undefined — RAG path skipped, will return "Unknown MCP function" error to LLM`
			);
		}

		const mappingEntry = mapping[p.call.name];
		if (!mappingEntry) {
			if (CLIENT_SIDE_TOOLS.has(p.call.name)) {
				const argsRaw = parseArgs(p.call.arguments) as Record<string, unknown>;
				const output = JSON.stringify({ success: true, ...argsRaw });
				results.push({ index, output, uuid: p.uuid, paramsClean: p.paramsClean });
				updatesQueue.push({
					type: MessageUpdateType.Tool,
					subtype: MessageToolUpdateType.Result,
					uuid: p.uuid,
					result: {
						status: ToolResultStatus.Success,
						call: { name: p.call.name, parameters: p.paramsClean },
						outputs: [argsRaw as Record<string, unknown>],
						display: true,
					},
				});
				return;
			}
			const message = `Unknown MCP function: ${p.call.name}`;
			results.push({
				index,
				error: message,
				uuid: p.uuid,
				paramsClean: p.paramsClean,
			});
			updatesQueue.push({
				type: MessageUpdateType.Tool,
				subtype: MessageToolUpdateType.Error,
				uuid: p.uuid,
				message,
			});
			return;
		}
		const serverCfg = serverLookup.get(mappingEntry.server);
		if (!serverCfg) {
			const message = `Unknown MCP server: ${mappingEntry.server}`;
			results.push({
				index,
				error: message,
				uuid: p.uuid,
				paramsClean: p.paramsClean,
			});
			updatesQueue.push({
				type: MessageUpdateType.Tool,
				subtype: MessageToolUpdateType.Error,
				uuid: p.uuid,
				message,
			});
			return;
		}
		const client = clientMap.get(mappingEntry.server);
		try {
			logger.debug(
				{ server: mappingEntry.server, tool: mappingEntry.tool, parameters: p.paramsClean },
				"[mcp] invoking tool"
			);

			let toolResponse: McpToolTextResponse;
			try {
				toolResponse = await callMcpTool(serverCfg, mappingEntry.tool, p.argsObj, {
					client,
					signal: abortSignal,
					timeoutMs: effectiveTimeoutMs,
					onProgress: (progress) => {
						updatesQueue.push({
							type: MessageUpdateType.Tool,
							subtype: MessageToolUpdateType.Progress,
							uuid: p.uuid,
							progress: progress.progress,
							total: progress.total,
							message: progress.message,
						});
					},
				});
			} catch (gateErr) {
				const gateMsg = gateErr instanceof Error ? gateErr.message : String(gateErr);
				const isGithubOp = mappingEntry.tool === "github_operation";
				const isRiskGate =
					gateMsg.includes("Risk gate blocked") || gateMsg.includes("requires: confirmed=true");

				if (!isGithubOp || !isRiskGate) throw gateErr;

				// CRITICAL ops require both risk_confirmed + risk_reason.
				// Backend error message contains "reason (non-empty string)" for CRITICAL.
				// This string is defined in DevForge backend src/agents/github/agent.py risk_gate_check().
				const isCritical = gateMsg.includes("reason (non-empty string)");

				const structuredOp = typeof p.argsObj.operation === "string" ? p.argsObj.operation : "";
				const opMatch = /Operation (\w+) requires:/i.exec(gateMsg);
				const rawOp = structuredOp || (opMatch ? opMatch[1] : "");
				const knownOps = new Set<MessageToolConfirmUpdate["operation"]>([
					"commit_file",
					"create_branch",
					"delete_branch",
					"merge_pr",
					"create_repo",
					"delete_repo",
					"create_release",
					"trigger_workflow",
					"create_webhook",
					"delete_webhook",
					"force_push",
					"commit",
					"delete",
					"merge",
					"branch",
					"push",
					"update",
				]);
				const operation: MessageToolConfirmUpdate["operation"] = knownOps.has(
					rawOp as MessageToolConfirmUpdate["operation"]
				)
					? (rawOp as MessageToolConfirmUpdate["operation"])
					: "commit"; // safe fallback — hits default card UI

				updatesQueue.push({
					type: MessageUpdateType.Tool,
					subtype: MessageToolUpdateType.Confirm,
					uuid: p.uuid,
					operation,
					isCritical,
					repoName: String(p.paramsClean.repo_name ?? ""),
					filePath: String(p.paramsClean.file_path ?? ""),
					content: String(p.paramsClean.content ?? ""),
					query: p.paramsClean.query ? String(p.paramsClean.query) : undefined,
					commitMessage: String(p.paramsClean.commit_message ?? ""),
					branchName: String(p.paramsClean.branch_name ?? p.paramsClean.head_branch ?? ""),
					sourceBranch: String(p.paramsClean.source_branch ?? p.paramsClean.base_branch ?? ""),
				});

				// 5-minute timeout: if the user navigates away or never responds,
				// cancel the pending confirmation to release the streaming connection.
				const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;
				const { action } = await Promise.race([
					createConfirmation(p.uuid),
					new Promise<never>((_, reject) =>
						setTimeout(
							() => reject(new Error("Confirmation timed out after 5 minutes")),
							CONFIRM_TIMEOUT_MS
						)
					),
				]);
				if (action === "reject") throw new Error("Operation cancelled by user");

				// Build a new args object for the retry — don't mutate p.argsObj
				// in case it's referenced elsewhere (logging, error handling, etc.)
				const retryArgs = {
					...p.argsObj,
					context: {
						...(p.argsObj.context as Record<string, unknown> | undefined),
						risk_confirmed: true,
						...(isCritical ? { risk_reason: "Confirmed by user via chat UI" } : {}),
					},
				};

				toolResponse = await callMcpTool(serverCfg, mappingEntry.tool, retryArgs, {
					client,
					signal: abortSignal,
					timeoutMs: effectiveTimeoutMs,
					onProgress: (progress) => {
						updatesQueue.push({
							type: MessageUpdateType.Tool,
							subtype: MessageToolUpdateType.Progress,
							uuid: p.uuid,
							progress: progress.progress,
							total: progress.total,
							message: progress.message,
						});
					},
				});
			}
			const { annotated } = processToolOutput(toolResponse.text ?? "");
			logger.debug(
				{ server: mappingEntry.server, tool: mappingEntry.tool },
				"[mcp] tool call completed"
			);
			results.push({
				index,
				output: annotated,
				structured: toolResponse.structured,
				blocks: toolResponse.content,
				uuid: p.uuid,
				paramsClean: p.paramsClean,
			});
			updatesQueue.push({
				type: MessageUpdateType.Tool,
				subtype: MessageToolUpdateType.Result,
				uuid: p.uuid,
				result: {
					status: ToolResultStatus.Success,
					call: { name: p.call.name, parameters: p.paramsClean },
					outputs: [
						{
							text: annotated ?? "",
							structured: toolResponse.structured,
							content: toolResponse.content,
						} as unknown as Record<string, unknown>,
					],
					display: true,
				},
			});
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			const errName = err instanceof Error ? err.name : "";
			const isAbortError =
				abortSignal?.aborted ||
				errName === "AbortError" ||
				errName === "APIUserAbortError" ||
				errMsg === "Request was aborted." ||
				errMsg === "This operation was aborted";
			const message = isAbortError ? "Aborted by user" : errMsg;

			if (isAbortError) {
				logger.debug(
					{ server: mappingEntry.server, tool: mappingEntry.tool },
					"[mcp] tool call aborted by user"
				);
			} else {
				logger.warn(
					{ server: mappingEntry.server, tool: mappingEntry.tool, err: message },
					"[mcp] tool call failed"
				);
			}
			results.push({ index, error: message, uuid: p.uuid, paramsClean: p.paramsClean });
			updatesQueue.push({
				type: MessageUpdateType.Tool,
				subtype: MessageToolUpdateType.Error,
				uuid: p.uuid,
				message,
			});
		}
	});

	// kick off and stream as they finish
	Promise.allSettled(tasks).then(() => updatesQueue.close());

	for await (const update of updatesQueue.iterator()) {
		yield { type: "update", update };
	}

	// Collate outputs in original call order
	results.sort((a, b) => a.index - b.index);
	for (const r of results) {
		const name = prepared[r.index].call.name;
		const id = prepared[r.index].call.id;
		if (!r.error) {
			const output = r.output ?? "";
			toolRuns.push({ name, parameters: r.paramsClean, output });
			// For the LLM follow-up call, we keep only the textual output
			toolMessages.push({ role: "tool", tool_call_id: id, content: output });
		} else {
			// Communicate error to LLM so it doesn't hallucinate success
			toolMessages.push({ role: "tool", tool_call_id: id, content: `Error: ${r.error}` });
		}
	}

	yield { type: "complete", summary: { toolMessages, toolRuns } };
}
