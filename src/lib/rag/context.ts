import type { ChatFileChunk } from "./client";

export interface RagContextMessage {
	from: "system";
	content: string;
	id: string;
	createdAt: Date;
	ragChunks?: ChatFileChunk[];
	metadata: {
		type: "rag-context";
		chunkIds: string[];
	};
}

/**
 * Check if message is RAG context (for filtering/display)
 */
export function isRagContextMessage(message: unknown): message is RagContextMessage {
	if (typeof message !== "object" || message === null) {
		return false;
	}

	const m = message as Partial<RagContextMessage>;

	return m.metadata?.type === "rag-context";
}
