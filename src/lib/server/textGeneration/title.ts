import { config } from "$lib/server/config";
import { generateFromDefaultEndpoint } from "$lib/server/generateFromDefaultEndpoint";
import { logger } from "$lib/server/logger";
import { MessageUpdateType, type MessageUpdate } from "$lib/types/MessageUpdate";
import type { Conversation } from "$lib/types/Conversation";
import { getReturnFromGenerator } from "$lib/utils/getReturnFromGenerator";

export async function* generateTitleForConversation(
	conv: Conversation,
	locals: App.Locals | undefined
): AsyncGenerator<MessageUpdate, undefined, undefined> {
	try {
		const userMessage = conv.messages.find((m) => m.from === "user");
		// HACK: detect if the conversation is new
		if (conv.title !== "New Chat" || !userMessage) return;

		// Strip prepended RAG context — all injection paths use "\n\n---\n\n" as separator
		const prompt = userMessage.content.includes("\n\n---\n\n")
			? userMessage.content.split("\n\n---\n\n").at(-1)!.trim()
			: userMessage.content;
		const modelForTitle = config.TASK_MODEL?.trim() ? config.TASK_MODEL : conv.model;
		const title = (await generateTitle(prompt, modelForTitle, locals)) ?? "New Chat";

		yield {
			type: MessageUpdateType.Title,
			title,
		};
	} catch (cause) {
		logger.error(cause, "Failed while generating title for conversation");
	}
}

async function generateTitle(
	prompt: string,
	modelId: string | undefined,
	locals: App.Locals | undefined
) {
	if (config.LLM_SUMMARIZATION !== "true") {
		// When summarization is disabled, use the first five words without adding emojis
		return prompt.split(/\s+/g).slice(0, 5).join(" ");
	}

	// Tools removed: no tool-based title path

	return await getReturnFromGenerator(
		generateFromDefaultEndpoint({
			messages: [{ from: "user", content: `User message: "${prompt}"` }],
			preprompt: `You are a chat thread titling assistant.
Goal: Produce a very short, descriptive title (2–4 words) that names the topic of the user's first message.

Rules:
- Output ONLY the title text. No prefixes, labels, quotes, emojis, hashtags, or trailing punctuation.
- Use the user's language.
- Write a noun phrase that names the topic. Do not write instructions.
- Never output just a pronoun (me/you/I/we/us/myself/yourself). Prefer a neutral subject (e.g., "Assistant", "model", or the concrete topic).
- Never include meta-words: Summarize, Summary, Title, Prompt, Topic, Subject, About, Question, Request, Chat.

Examples:
User: "Summarize hello" -> Hello
User: "How do I reverse a string in Python?" -> Python string reversal
User: "help me plan a NYC weekend" -> NYC weekend plan
User: "请解释Transformer是如何工作的" -> Transformer 工作原理
User: "tell me more about you" -> About the assistant
Return only the title text.`,
			generateSettings: {
				max_tokens: 200,
				temperature: 0,
			},
			modelId,
			locals,
		})
	)
		.then((summary) => {
			const firstFive = prompt.split(/\s+/g).slice(0, 5).join(" ");
			// Strip <think> blocks — reasoning models (DeepSeek-R1, QwQ etc.) include
			// chain-of-thought in generated_text. Handle both complete blocks and
			// truncated ones (no closing tag) caused by max_tokens cutoff.
			const stripped = String(summary ?? "")
				.replace(/<think>[\s\S]*?<\/think>/gi, "")
				.replace(/<think>[\s\S]*/gi, "")
				.trim();
			return stripped || firstFive;
		})
		.catch((e) => {
			logger.error(e, "Error generating title");
			const firstFive = prompt.split(/\s+/g).slice(0, 5).join(" ");
			return firstFive;
		});
}

// No post-processing: rely solely on prompt instructions above
