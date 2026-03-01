import { authCondition } from "$lib/server/auth";
import { collections } from "$lib/server/database";
import { config } from "$lib/server/config";
import { models, validModelIdSchema } from "$lib/server/models";
import { ERROR_MESSAGES } from "$lib/stores/errors";
import type { Message } from "$lib/types/Message";
import { error } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import {
	MessageUpdateStatus,
	MessageUpdateType,
	MessageReasoningUpdateType,
	type MessageUpdate,
	type MessageStreamUpdate,
} from "$lib/types/MessageUpdate";
import { uploadFile } from "$lib/server/files/uploadFile";
import { convertLegacyConversation } from "$lib/utils/tree/convertLegacyConversation";
import { isMessageId } from "$lib/utils/tree/isMessageId";
import { buildSubtree } from "$lib/utils/tree/buildSubtree.js";
import { addChildren } from "$lib/utils/tree/addChildren.js";
import { addSibling } from "$lib/utils/tree/addSibling.js";
import { usageLimits } from "$lib/server/usageLimits";
import { textGeneration } from "$lib/server/textGeneration";
import type { TextGenerationContext } from "$lib/server/textGeneration/types";
import { logger } from "$lib/server/logger.js";
import { AbortRegistry } from "$lib/server/abortRegistry";
import { MetricsServer } from "$lib/server/metrics";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, locals, params, getClientAddress }) => {
	const id = z.string().parse(params.id);
	const convId = new ObjectId(id);
	const promptedAt = new Date();

	const userId = locals.user?._id ?? locals.sessionId;

	// check user
	if (!userId) {
		error(401, "Unauthorized");
	}

	// check if the user has access to the conversation
	const convBeforeCheck = await collections.conversations.findOne({
		_id: convId,
		...authCondition(locals),
	});

	if (convBeforeCheck && !convBeforeCheck.rootMessageId) {
		const res = await collections.conversations.updateOne(
			{
				_id: convId,
			},
			{
				$set: {
					...convBeforeCheck,
					...convertLegacyConversation(convBeforeCheck),
				},
			}
		);

		if (!res.acknowledged) {
			error(500, "Failed to convert conversation");
		}
	}

	const conv = await collections.conversations.findOne({
		_id: convId,
		...authCondition(locals),
	});

	if (!conv) {
		error(404, "Conversation not found");
	}

	// register the event for ratelimiting
	await collections.messageEvents.insertOne({
		type: "message",
		userId,
		createdAt: new Date(),
		expiresAt: new Date(Date.now() + 60_000),
		ip: getClientAddress(),
	});

	if (usageLimits?.messagesPerMinute) {
		// check if the user is rate limited
		const nEvents = Math.max(
			await collections.messageEvents.countDocuments({
				userId,
				type: "message",
				expiresAt: { $gt: new Date() },
			}),
			await collections.messageEvents.countDocuments({
				ip: getClientAddress(),
				type: "message",
				expiresAt: { $gt: new Date() },
			})
		);
		if (nEvents > usageLimits.messagesPerMinute) {
			error(429, ERROR_MESSAGES.rateLimited);
		}
	}

	if (usageLimits?.messages && conv.messages.length > usageLimits.messages) {
		error(
			429,
			`This conversation has more than ${usageLimits.messages} messages. Start a new one to continue`
		);
	}

	// fetch the model
	const model = models.find((m) => m.id === conv.model);

	if (!model) {
		error(410, "Model not available anymore");
	}

	// finally parse the content of the request
	const form = await request.formData();

	const json = form.get("data");

	if (!json || typeof json !== "string") {
		error(400, "Invalid request");
	}

	const {
		inputs: newPrompt,
		id: messageId,
		is_retry: isRetry,
		selectedMcpServerNames,
		selectedMcpServers,
		availableFiles,
	} = z
		.object({
			id: z.string().uuid().refine(isMessageId).optional(), // parent message id to append to for a normal message, or the message id for a retry/continue
			inputs: z.optional(
				z
					.string()
					.min(1)
					.transform((s) => s.replace(/\r\n/g, "\n"))
			),
			is_retry: z.optional(z.boolean()),
			selectedMcpServerNames: z.optional(z.array(z.string())),
			selectedMcpServers: z
				.optional(
					z.array(
						z.object({
							name: z.string(),
							url: z.string(),
							headers: z
								.optional(z.array(z.object({ key: z.string(), value: z.string() })))
								.default([]),
						})
					)
				)
				.default([]),
			files: z.optional(
				z.array(
					z.object({
						type: z.literal("base64").or(z.literal("hash")),
						name: z.string(),
						value: z.string(),
						mime: z.string(),
					})
				)
			),
			availableFiles: z.optional(z.array(z.object({ id: z.string(), name: z.string() }))),
		})
		.parse(JSON.parse(json));

	// Attach MCP selection to locals so the text generation pipeline can consume it
	try {
		(locals as unknown as Record<string, unknown>).mcp = {
			selectedServerNames: selectedMcpServerNames,
			selectedServers: (selectedMcpServers ?? []).map((s) => ({
				name: s.name,
				url: s.url,
				headers:
					s.headers && s.headers.length > 0
						? Object.fromEntries(s.headers.map((h) => [h.key, h.value]))
						: undefined,
			})),
		};
	} catch {
		// ignore attachment errors, pipeline will just use env servers
	}

	const inputFiles = await Promise.all(
		form
			.getAll("files")
			.filter((entry: FormDataEntryValue): entry is File => entry instanceof File && entry.size > 0)
			.map(async (file: File) => {
				const [type, ...name] = file.name.split(";");

				return {
					type: z.literal("base64").or(z.literal("hash")).parse(type),
					value: await file.text(),
					mime: file.type,
					name: name.join(";"),
				};
			})
	);

	if (usageLimits?.messageLength && (newPrompt?.length ?? 0) > usageLimits.messageLength) {
		error(400, "Message too long.");
	}

	// each file is either:
	// base64 string requiring upload to the server
	// hash pointing to an existing file
	const hashFiles = inputFiles?.filter((file) => file.type === "hash") ?? [];
	const b64Files =
		inputFiles
			?.filter((file) => file.type !== "hash")
			.map((file) => {
				const blob = Buffer.from(file.value, "base64");
				return new File([blob], file.name, { type: file.mime });
			}) ?? [];

	// check sizes
	// todo: make configurable
	if (b64Files.some((file) => file.size > 10 * 1024 * 1024)) {
		error(413, "File too large, should be <10MB");
	}

	const uploadedFiles = await Promise.all(b64Files.map((file) => uploadFile(file, conv))).then(
		(files) => [...files, ...hashFiles]
	);

	// we will append tokens to the content of this message
	let messageToWriteToId: Message["id"] | undefined = undefined;
	// RAG chunks to attach to the assistant message for citation UI rendering
	let ragChunksForAssistant: import("$lib/rag/client").ChatFileChunk[] | undefined = undefined;
	// used for building the prompt, subtree of the conversation that goes from the latest message to the root
	let messagesForPrompt: Message[] = [];

	if (isRetry && messageId) {
		// two cases, if we're retrying a user message with a newPrompt set,
		// it means we're editing a user message
		// if we're retrying on an assistant message, newPrompt cannot be set
		// it means we're retrying the last assistant message for a new answer

		const messageToRetry = conv.messages.find((message) => message.id === messageId);

		if (!messageToRetry) {
			error(404, "Message not found");
		}

		if (messageToRetry.from === "user" && newPrompt) {
			// add a sibling to this message from the user, with the alternative prompt
			// add a children to that sibling, where we can write to
			const newUserMessageId = addSibling(
				conv,
				{
					from: "user",
					content: newPrompt,
					files: uploadedFiles,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
				messageId
			);
			messageToWriteToId = addChildren(
				conv,
				{
					from: "assistant",
					content: "",
					createdAt: new Date(),
					updatedAt: new Date(),
				},
				newUserMessageId
			);
			messagesForPrompt = buildSubtree(conv, newUserMessageId).map((m) => ({ ...m }));
		} else if (messageToRetry.from === "assistant") {
			// we're retrying an assistant message, to generate a new answer
			// just add a sibling to the assistant answer where we can write to
			messageToWriteToId = addSibling(
				conv,
				{ from: "assistant", content: "", createdAt: new Date(), updatedAt: new Date() },
				messageId
			);
			messagesForPrompt = buildSubtree(conv, messageId).map((m) => ({ ...m }));
			messagesForPrompt.pop(); // don't need the latest assistant message in the prompt since we're retrying it
		}
	} else {
		// just a normal linear conversation, so we add the user message
		// and the blank assistant message back to back
		const newUserMessageId = addChildren(
			conv,
			{
				from: "user",
				content: newPrompt ?? "",
				files: uploadedFiles,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			messageId
		);

		messageToWriteToId = addChildren(
			conv,
			{
				from: "assistant",
				content: "",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			newUserMessageId
		);
		// build the prompt from the user message
		// IMPORTANT: shallow copy messages so we don't mutate originals in conv.messages during injection/sanitization
		messagesForPrompt = buildSubtree(conv, newUserMessageId).map((m) => ({ ...m }));

		// ============================================================================
		// RAG INJECTION - Phase 1
		// ============================================================================

		try {
			// Import RAG modules
			const { ragClient } = await import("$lib/rag/client");
			const { buildRagContextMessage } = await import("$lib/server/rag/contextBuilder");
			const { routeRagQuery } = await import("$lib/server/rag/ragRouter");

			// Extract user query (last message in tree)
			const userQuery = newPrompt?.trim();

			// Get tenant ID from session (Google user ID)
			const tenantId = locals.user?._id ?? locals.sessionId;

			if (conv.ragEnabled !== false && userQuery && tenantId) {
				// Sync actual files from backend just in case frontend 'availableFiles' is stale (e.g., just uploaded)
				let mergedFiles = availableFiles || [];
				try {
					const backendFiles = await ragClient.listFiles(tenantId.toString());
					// Merge by ID to prevent duplicates, maintaining name and chunkCount
					const backendMapped = backendFiles.map(
						(f: import("$lib/rag/client").RagFileMetadata) => ({
							id: f.id,
							name: f.name,
							chunkCount: f.chunkCount || 0,
						})
					);
					const mergedMap = new Map([...mergedFiles, ...backendMapped].map((f) => [f.id, f]));
					mergedFiles = Array.from(mergedMap.values());
				} catch (e) {
					console.warn("[RAG] Failed to sync backend files, using frontend list only", e);
				}

				// Build history WITHOUT current message, always use newUserMessageId tree
				// Slice off the last element (the current message) so active file inference
				// works correctly even on brand-new conversations with no parent messageId.
				const historyForRewrite = buildSubtree(conv, newUserMessageId).slice(0, -1);

				// ====================================================================
				// ROUTING
				// ====================================================================
				const decision = await routeRagQuery(userQuery, {
					availableFiles: mergedFiles,
					conversationHistory: historyForRewrite,
					locals,
				});

				let ragResponse: import("$lib/rag/client").SemanticSearchResponse | undefined = undefined;

				// ====================================================================
				// EXECUTION
				// ====================================================================
				if (decision.intent === "NO_RAG") {
					// File list is NOT guaranteed to be in the system prompt —
					// explicitly inject it so the LLM can answer "what files do I have?"
					// accurately without hallucinating.
					if (mergedFiles.length > 0) {
						const fileList = mergedFiles
							.map(
								(f: { name: string; chunkCount?: number }, i) =>
									`${i + 1}. ${f.name}${f.chunkCount ? ` (${f.chunkCount} chunks)` : ""}`
							)
							.join("\n");
						const lastMsg = messagesForPrompt[messagesForPrompt.length - 1];
						if (lastMsg && lastMsg.from === "user") {
							lastMsg.content = `[System: The user has ${mergedFiles.length} uploaded file(s):]\n${fileList}\n\n---\n\n${lastMsg.content}`;
						}
						console.log(`[RAGRouter] → NO_RAG | injected file list (${mergedFiles.length} files)`);
					} else {
						console.log(`[RAGRouter] → NO_RAG | no files to inject, skipping`);
					}
				} else if (decision.intent === "FULL_SUMMARY" && decision.fileId) {
					try {
						ragResponse = await ragClient.getFileChunks(
							decision.fileId,
							tenantId.toString(),
							decision.limit ?? 20,
							decision.offset ?? 0
						);
					} catch (e) {
						console.warn("[RAG] FULL_SUMMARY fetch failed:", e);
					}
				} else if (
					decision.intent === "KEYWORD_LOOKUP" ||
					decision.intent === "TARGETED_SEARCH" ||
					decision.intent === "GLOBAL_SEARCH"
				) {
					// Scale topK for GLOBAL_SEARCH based on how many files the tenant has
					let effectiveTopK = decision.topK ?? 5;
					if (decision.intent === "GLOBAL_SEARCH") {
						if (mergedFiles.length > 20) effectiveTopK = 10;
						else if (mergedFiles.length > 10) effectiveTopK = 8;
					}
					try {
						ragResponse = await ragClient.semanticSearch(
							{
								messageId: newUserMessageId.toString(),
								userQuery,
								rewriteQuery: decision.searchQuery,
								top_k: effectiveTopK,
								fileIds: decision.fileId ? [decision.fileId] : undefined,
							},
							tenantId.toString()
						);
					} catch (e) {
						console.warn(`[RAG] ${decision.intent} failed:`, e);
					}
				}

				// ====================================================================
				// INJECTION
				// ====================================================================
				if (decision.intent !== "NO_RAG") {
					console.log("\n[RAG TRIGGERED] ====================");
					console.log(`- Intent         : ${decision.intent}`);
					console.log(`- Original Query : "${userQuery}"`);
					if (decision.searchQuery) console.log(`- Rewrite Query  : "${decision.searchQuery}"`);
					if (decision.fileName) console.log(`- Scoped File    : ${decision.fileName}`);
					if (decision.limit) console.log(`- Chunks Limit   : ${decision.limit}`);

					const foundFiles = ragResponse
						? [
								...new Set(
									ragResponse.chunks.map((c: import("$lib/rag/client").ChatFileChunk) => c.filename)
								),
							]
						: [];
					console.log(
						`- Docs Retrieved : ${foundFiles.length > 0 ? foundFiles.join(", ") : "None"}`
					);
					console.log("====================================\n");
				}

				// If chunks found, inject context directly into the user message
				if (ragResponse && ragResponse.chunks.length > 0) {
					const ragContextMessage = buildRagContextMessage(ragResponse.chunks);

					// Save chunks so we can attach them to the assistant message for citation UI
					ragChunksForAssistant = ragContextMessage.ragChunks ?? ragResponse.chunks;

					// Injection Strategy: Prefix the latest user message with context
					// This is more robust than a separate system message for most models
					const lastMsg = messagesForPrompt[messagesForPrompt.length - 1];
					if (lastMsg && lastMsg.from === "user") {
						lastMsg.content = `${ragContextMessage.content}\n\n---\n\n${lastMsg.content}`;
					}
				}
			}
		} catch (error) {
			// NEVER block chat if RAG fails - degrade gracefully
			console.error("[RAG] Search failed, proceeding without context:", error);
		}

		// ============================================================================
		// END RAG INJECTION
		// ============================================================================
	}

	const messageToWriteTo = conv.messages.find((message) => message.id === messageToWriteToId);
	if (!messageToWriteTo) {
		error(500, "Failed to create message");
	}
	// Attach RAG citation chunks to the assistant message so the frontend can render them
	if (ragChunksForAssistant) {
		messageToWriteTo.ragChunks = ragChunksForAssistant;
	}
	if (messagesForPrompt.length === 0) {
		error(500, "Failed to create prompt");
	}

	// Sanitization: Strip <think> blocks from all history messages to prevent "thinking leakage"
	messagesForPrompt = messagesForPrompt.map((msg, idx) => {
		// Don't sanitize the very last message (it might contain the RAG context we just prefixed)
		if (idx === messagesForPrompt.length - 1) return msg;

		if (typeof msg.content === "string") {
			const sanitized = msg.content.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "").trim();
			return { ...msg, content: sanitized };
		}
		return msg;
	});

	// update the conversation with the new messages
	await collections.conversations.updateOne(
		{ _id: convId },
		{ $set: { messages: conv.messages, title: conv.title, updatedAt: new Date() } }
	);

	let doneStreaming = false;
	let clientDetached = false;

	let lastTokenTimestamp: undefined | Date = undefined;
	let firstTokenObserved = false;
	const metricsEnabled = MetricsServer.isEnabled();
	const metrics = metricsEnabled ? MetricsServer.getMetrics() : undefined;
	const metricsModelId = model.id ?? model.name ?? conv.model;
	const metricsLabels = { model: metricsModelId };

	const persistConversation = async () => {
		const messagesForSave = conv.messages.map((msg) => {
			const filteredUpdates =
				msg.updates
					?.filter(
						(u) =>
							!(u.type === MessageUpdateType.Status && u.status === MessageUpdateStatus.KeepAlive)
					)
					.map((u) => {
						if (u.type !== MessageUpdateType.Stream) return u;
						// Preserve existing len if already compressed, otherwise compute from token
						const len = u.len ?? (u.token ?? "").length;
						// store a lightweight marker to preserve ordering without duplicating content
						return { type: MessageUpdateType.Stream, token: "", len } satisfies MessageStreamUpdate;
					}) ?? [];

			return { ...msg, updates: filteredUpdates };
		});

		await collections.conversations.updateOne(
			{ _id: convId },
			{ $set: { messages: messagesForSave, title: conv.title, updatedAt: new Date() } }
		);
	};

	const abortRegistry = AbortRegistry.getInstance();

	// we now build the stream
	const stream = new ReadableStream({
		async start(controller) {
			const conversationKey = convId.toString();
			const ctrl = new AbortController();
			abortRegistry.register(conversationKey, ctrl);

			let finalAnswerReceived = false;
			let abortedByUser = false;

			messageToWriteTo.updates ??= [];
			async function update(event: MessageUpdate) {
				if (!messageToWriteTo || !conv) {
					throw Error("No message or conversation to write events to");
				}

				// Add token to content or skip if empty
				if (event.type === MessageUpdateType.Stream) {
					if (event.token === "") return;
					messageToWriteTo.content += event.token;

					if (metricsEnabled && metrics) {
						const now = Date.now();
						metrics.model.tokenCountTotal.inc(metricsLabels);

						if (!firstTokenObserved) {
							metrics.model.timeToFirstToken.observe(metricsLabels, now - promptedAt.getTime());
							firstTokenObserved = true;
						}

						const previousTimestamp = lastTokenTimestamp
							? lastTokenTimestamp.getTime()
							: promptedAt.getTime();
						metrics.model.timePerOutputToken.observe(metricsLabels, now - previousTimestamp);
					}

					lastTokenTimestamp = new Date();
				}

				// Append reasoning stream tokens to message.reasoning (server-side)
				else if (
					event.type === MessageUpdateType.Reasoning &&
					event.subtype === MessageReasoningUpdateType.Stream &&
					"token" in event
				) {
					messageToWriteTo.reasoning ??= "";
					messageToWriteTo.reasoning += event.token;
				}

				// Set the title
				else if (event.type === MessageUpdateType.Title) {
					// Always strip <think> markers from titles when saving
					const sanitizedTitle = event.title.replace(/<\/?think>/gi, "").trim();
					conv.title = sanitizedTitle;
					await collections.conversations.updateOne(
						{ _id: convId },
						{ $set: { title: conv?.title, updatedAt: new Date() } }
					);
				}

				// Set the final text and the interrupted flag
				else if (event.type === MessageUpdateType.FinalAnswer) {
					messageToWriteTo.interrupted = event.interrupted;
					// Default behavior: replace the streamed text with the provider's final text.
					// However, when tools (MCP/function calls) were used, providers often stream
					// some content (e.g., a story) before triggering tools, then return a
					// different follow‑up message afterwards (e.g., an image caption). Our
					// previous logic overwrote the pre‑tool content. Preserve it by merging in
					// the pre‑tool stream when tool updates occurred and the final text does
					// not already include the streamed prefix.
					const hadTools = (messageToWriteTo.updates ?? []).some(
						(u) => u.type === MessageUpdateType.Tool
					);

					if (hadTools) {
						const existing = messageToWriteTo.content.slice(initialMessageContent.length);
						if (existing && existing.length > 0) {
							// A. If we already streamed the same final text, keep as-is.
							if (event.text && existing.endsWith(event.text)) {
								messageToWriteTo.content = initialMessageContent + existing;
							}
							// B. If the final text already includes the streamed prefix, use it verbatim.
							else if (event.text && event.text.startsWith(existing)) {
								messageToWriteTo.content = initialMessageContent + event.text;
							}
							// C. Otherwise, merge with a paragraph break for readability.
							else {
								const needsGap = !/\n\n$/.test(existing) && !/^\n/.test(event.text ?? "");
								messageToWriteTo.content =
									initialMessageContent + existing + (needsGap ? "\n\n" : "") + (event.text ?? "");
							}
						} else {
							messageToWriteTo.content = initialMessageContent + (event.text ?? "");
						}
					} else {
						messageToWriteTo.content = initialMessageContent + event.text;
					}
					finalAnswerReceived = true;

					if (metricsEnabled && metrics) {
						metrics.model.latency.observe(metricsLabels, Date.now() - promptedAt.getTime());
					}
				}

				// Add file
				else if (event.type === MessageUpdateType.File) {
					messageToWriteTo.files = [
						...(messageToWriteTo.files ?? []),
						{ type: "hash", name: event.name, value: event.sha, mime: event.mime },
					];
				}

				// Store router metadata (for router models) or provider info (for all models)
				else if (event.type === MessageUpdateType.RouterMetadata) {
					// Merge metadata updates to preserve existing fields (router may send route/model first, then provider comes later)
					if (model?.isRouter) {
						messageToWriteTo.routerMetadata = {
							route: event.route || messageToWriteTo.routerMetadata?.route || "",
							model: event.model || messageToWriteTo.routerMetadata?.model || "",
							provider: event.provider || messageToWriteTo.routerMetadata?.provider,
						};
					}
					// Store provider-only metadata for non-router models if available
					else if (event.provider) {
						messageToWriteTo.routerMetadata = {
							route: messageToWriteTo.routerMetadata?.route || "",
							model: messageToWriteTo.routerMetadata?.model || "",
							provider: event.provider,
						};
					}
				}

				// Append updates for audit/replay (streams too, to preserve ordering)
				if (
					!(
						event.type === MessageUpdateType.Status &&
						event.status === MessageUpdateStatus.KeepAlive
					)
				) {
					messageToWriteTo?.updates?.push(
						event.type === MessageUpdateType.Stream ? { ...event } : event
					);
				}

				// Avoid remote keylogging attack executed by watching packet lengths
				// by padding the text with null chars to a fixed length
				// https://cdn.arstechnica.net/wp-content/uploads/2024/03/LLM-Side-Channel.pdf
				if (event.type === MessageUpdateType.Stream) {
					event = { ...event, token: event.token.padEnd(16, "\0") };
				}

				messageToWriteTo.updatedAt = new Date();

				const enqueueUpdate = async () => {
					if (clientDetached) return;
					try {
						controller.enqueue(JSON.stringify(event) + "\n");
						if (event.type === MessageUpdateType.FinalAnswer) {
							controller.enqueue(" ".repeat(4096));
						}
					} catch (err) {
						clientDetached = true;
						logger.info(
							{ conversationId: convId.toString() },
							"Client detached during message streaming"
						);
					}
				};

				await enqueueUpdate();

				if (clientDetached) {
					await persistConversation();
				}
			}

			let hasError = false;
			const initialMessageContent = messageToWriteTo.content;

			try {
				// Fetch user settings once for all overrides and billing org
				const userSettings = await collections.settings.findOne(authCondition(locals));

				// Add billing organization to locals for the endpoint to use
				locals.billingOrganization = userSettings?.billingOrganization;
				// Add settings to locals for MCP tool injection
				locals.settings = userSettings ?? undefined;

				const ctx: TextGenerationContext = {
					model,
					endpoint: await model.getEndpoint(),
					conv,
					messages: messagesForPrompt,
					assistant: undefined,
					promptedAt,
					ip: getClientAddress(),
					username: locals.user?.username,
					// Force-enable multimodal if user settings say so for this model
					forceMultimodal: Boolean(userSettings?.multimodalOverrides?.[model.id]),
					// Force-enable tools if user settings say so for this model
					forceTools: Boolean(userSettings?.toolsOverrides?.[model.id]),
					// Inference provider preference (HuggingChat only, skip for router models)
					provider:
						config.isHuggingChat && !model.isRouter
							? userSettings?.providerOverrides?.[model.id]
							: undefined,
					locals,
					abortController: ctrl,
				};
				// run the text generation and send updates to the client
				for await (const event of textGeneration(ctx)) await update(event);
				if (ctrl.signal.aborted) {
					abortedByUser = true;
				}
				if (abortedByUser && !finalAnswerReceived) {
					const partialText = messageToWriteTo.content.slice(initialMessageContent.length);
					await update({
						type: MessageUpdateType.FinalAnswer,
						text: partialText,
						interrupted: true,
					});
				}
			} catch (e) {
				const err = e as Error;
				const isAbortError =
					err?.name === "AbortError" ||
					err?.name === "APIUserAbortError" ||
					err?.message === "Request was aborted.";
				if (isAbortError || ctrl.signal.aborted) {
					abortedByUser = true;
					logger.info({ conversationId: conversationKey }, "Generation aborted by user");
					if (!finalAnswerReceived) {
						const partialText = messageToWriteTo.content.slice(initialMessageContent.length);
						await update({
							type: MessageUpdateType.FinalAnswer,
							text: partialText,
							interrupted: true,
						});
					}
				} else {
					hasError = true;
					// Extract status code if available from HTTPError or APIError
					const errObj = err as unknown as Record<string, unknown>;
					const statusCode =
						(typeof errObj.statusCode === "number" ? errObj.statusCode : undefined) ||
						(typeof errObj.status === "number" ? errObj.status : undefined);
					await update({
						type: MessageUpdateType.Status,
						status: MessageUpdateStatus.Error,
						message: err.message,
						...(statusCode && { statusCode }),
					});
					logger.error(err, "Error in conversation stream");
				}
			} finally {
				// check if no output was generated
				if (!hasError && !abortedByUser && messageToWriteTo.content === initialMessageContent) {
					logger.warn(
						{
							conversationId: conversationKey,
							updatesCount: messageToWriteTo.updates?.length ?? 0,
							filesCount: messageToWriteTo.files?.length ?? 0,
							reasoningLen: messageToWriteTo.reasoning?.length ?? 0,
							initialLen: initialMessageContent.length,
							finalLen: messageToWriteTo.content.length,
						},
						"No output generated after streaming; emitting error status"
					);
					await update({
						type: MessageUpdateType.Status,
						status: MessageUpdateStatus.Error,
						message: "No output was generated. Something went wrong.",
					});
				}
			}

			await persistConversation();
			abortRegistry.unregister(conversationKey, ctrl);

			// used to detect if cancel() is called bc of interrupt or just because the connection closes
			doneStreaming = true;
			if (!clientDetached) {
				controller.close();
			}
		},
		async cancel() {
			if (doneStreaming) return;
			clientDetached = true;
			await persistConversation();
		},
	});

	if (metricsEnabled && metrics) {
		metrics.model.messagesTotal.inc(metricsLabels);
	}

	// Todo: maybe we should wait for the message to be saved before ending the response - in case of errors
	return new Response(stream, {
		headers: {
			"Content-Type": "application/jsonl",
		},
	});
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	const convId = new ObjectId(params.id);

	const conv = await collections.conversations.findOne({
		_id: convId,
		...authCondition(locals),
	});

	if (!conv) {
		error(404, "Conversation not found");
	}

	await collections.conversations.deleteOne({ _id: conv._id });

	return new Response();
};

export const PATCH: RequestHandler = async ({ request, locals, params }) => {
	const values = z
		.object({
			title: z.string().trim().min(1).max(100).optional(),
			model: validModelIdSchema.optional(),
			ragEnabled: z.boolean().optional(),
		})
		.parse(await request.json());

	const convId = new ObjectId(params.id);

	const conv = await collections.conversations.findOne({
		_id: convId,
		...authCondition(locals),
	});

	if (!conv) {
		error(404, "Conversation not found");
	}

	// Only include defined values in the update, with title sanitized
	const updateValues = {
		...(values.title !== undefined && {
			title: values.title.replace(/<\/?think>/gi, "").trim(),
		}),
		...(values.model !== undefined && { model: values.model }),
		...(values.ragEnabled !== undefined && { ragEnabled: values.ragEnabled }),
	};

	await collections.conversations.updateOne(
		{
			_id: convId,
		},
		{
			$set: updateValues,
		}
	);

	return new Response();
};
