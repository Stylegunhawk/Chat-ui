/**
 * Formats RAG chunks into LLM-readable context
 *
 * CRITICAL: Use structured format so LLM can reference specific chunks
 */

import type { ChatFileChunk } from "./client";

interface RagContextMessage {
	from: "system";
	content: string;
	id: string;
	createdAt: Date;
	metadata: {
		type: "rag-context";
		chunkIds: string[];
	};
}

/**
 * Detect programming language from filename
 */
function getLanguageFromFilename(filename: string): string {
	const ext = filename.split(".").pop()?.toLowerCase();
	const langMap: Record<string, string> = {
		py: "python",
		js: "javascript",
		ts: "typescript",
		tsx: "typescript",
		jsx: "javascript",
		java: "java",
		cpp: "cpp",
		c: "c",
		go: "go",
		rs: "rust",
		rb: "ruby",
		php: "php",
		swift: "swift",
		kt: "kotlin",
		cs: "csharp",
	};
	return langMap[ext || ""] || "text";
}

/**
 * Build structured RAG context message for LLM
 *
 * Format: XML-like tags with metadata for citation tracking
 */
export function buildRagContextMessage(chunks: ChatFileChunk[]): RagContextMessage {
	if (chunks.length === 0) {
		throw new Error("Cannot build context from empty chunks");
	}

	// Sort chunks by role priority (entry > dependency > supporting)
	const rolePriority = { entry: 1, dependency: 2, supporting: 3 };
	const sortedChunks = [...chunks].sort((a, b) => {
		return rolePriority[a.role] - rolePriority[b.role];
	});

	// Format each chunk with structured tags
	const formattedChunks = sortedChunks
		.map((chunk, idx) => {
			const lang = getLanguageFromFilename(chunk.filename);
			const relevancePercent = (chunk.similarity * 100).toFixed(0);

			return `<coderef id="${chunk.id}" index="${idx + 1}">
File: ${chunk.filename}
Relevance: ${relevancePercent}%
Role: ${chunk.role}
${chunk.pageNumber ? `Line: ${chunk.pageNumber}` : ""}

\`\`\`${lang}
${chunk.text.trim()}
\`\`\`
</coderef>`;
		})
		.join("\n\n---\n\n");

	// Build final context message
	const contextContent = `# Retrieved Code Context

The following code snippets have been retrieved from the user's codebase and are relevant to their question. Use these references to provide accurate, code-aware answers.

${formattedChunks}

---

**Instructions:**
- Reference specific files and line numbers when answering
- Prioritize chunks marked as "entry" role
- If multiple files are relevant, explain their relationships
- If the context doesn't contain enough information, say so clearly`;

	// Generate unique ID
	const messageId = `rag_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

	return {
		from: "system",
		content: contextContent,
		id: messageId,
		createdAt: new Date(),
		metadata: {
			type: "rag-context",
			chunkIds: chunks.map((c) => c.id),
		},
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
