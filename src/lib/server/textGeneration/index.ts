import { preprocessMessages } from "../endpoints/preprocessMessages";

import { generateTitleForConversation } from "./title";
import {
	type MessageUpdate,
	MessageUpdateType,
	MessageUpdateStatus,
} from "$lib/types/MessageUpdate";
import { generate } from "./generate";
import { runToolFlow } from "./mcp/runMcpFlow";
import { runRagFlow } from "./mcp/runRagFlow";
import { mergeAsyncGenerators } from "$lib/utils/mergeAsyncGenerators";
import type { TextGenerationContext } from "./types";

async function* keepAlive(done: AbortSignal): AsyncGenerator<MessageUpdate, undefined, undefined> {
	while (!done.aborted) {
		yield {
			type: MessageUpdateType.Status,
			status: MessageUpdateStatus.KeepAlive,
		};
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

export async function* textGeneration(ctx: TextGenerationContext) {
	const done = new AbortController();

	const titleGen = generateTitleForConversation(ctx.conv, ctx.locals);
	const textGen = textGenerationWithoutTitle(ctx, done);
	const keepAliveGen = keepAlive(done.signal);

	// keep alive until textGen is done

	yield* mergeAsyncGenerators([titleGen, textGen, keepAliveGen]);
}

async function* textGenerationWithoutTitle(
	ctx: TextGenerationContext,
	done: AbortController
): AsyncGenerator<MessageUpdate, undefined, undefined> {
	yield {
		type: MessageUpdateType.Status,
		status: MessageUpdateStatus.Started,
	};

	const { conv, messages } = ctx;
	const convId = conv._id;

	const preprompt = conv.preprompt;

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
		yield* generate({ ...ctx, messages: processedMessages }, preprompt);
	} catch (err) {
		const isAbort =
			ctx.abortController.signal.aborted ||
			(err instanceof Error &&
				(err.name === "AbortError" ||
					err.name === "APIUserAbortError" ||
					err.message.includes("Request was aborted")));
		if (!isAbort) {
			yield* generate({ ...ctx, messages: processedMessages }, preprompt);
		}
	}
	done.abort();
}
