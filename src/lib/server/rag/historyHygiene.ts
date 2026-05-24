import type { Message } from "$lib/types/Message";

// Each injected block ends at the `\n\n---\n\n` boundary added by +server.ts when
// prepending the block to the user message. The retrieved-context block contains
// internal `\n---\n\n` separators between chunks, so we anchor on the unique
// `**Instructions:**` sentinel that always sits just before the FINAL boundary
// (contextBuilder.ts emits this block tail).
const RETRIEVED_CONTEXT_BLOCK_RE =
	/^# Retrieved Document Context[\s\S]*?\*\*Instructions:\*\*[\s\S]*?\n---\n\n/;
const UPLOADED_FILES_BLOCK_RE = /^## Uploaded Files[\s\S]*?\n---\n\n/;
const RAG_RESULT_BLOCK_RE = /<rag_result\b[^>]*(?:\/>|>[\s\S]*?<\/rag_result>)\s*/gi;

function stripBlocks(content: string): string {
	let next = content;
	let prev = "";

	while (next !== prev) {
		prev = next;
		next = next.replace(RAG_RESULT_BLOCK_RE, "");
		next = next.replace(RETRIEVED_CONTEXT_BLOCK_RE, "");
		next = next.replace(UPLOADED_FILES_BLOCK_RE, "");
	}

	return next;
}

export function stripPriorRagBlocks(messages: Message[]): Message[] {
	return messages.map((message, index) => {
		if (index === messages.length - 1) return message;
		if (message.from !== "user") return message;
		if (typeof message.content !== "string") return message;

		const cleaned = stripBlocks(message.content);
		return cleaned === message.content ? message : { ...message, content: cleaned };
	});
}
