import type { RagFileMetadata } from "$lib/rag/client";

function formatFileLine(file: RagFileMetadata): string {
	const chunkLabel = `${file.chunkCount} chunk${file.chunkCount === 1 ? "" : "s"}`;
	const processingLabel = file.finishEmbedding ? "" : " — processing — not searchable yet";
	const urlPart = file.url ? `\n  URL: ${file.url}` : "";
	return `- **${file.name}** (${chunkLabel}, id=\`${file.id}\`)${processingLabel}${urlPart}`;
}

export function buildInventoryBlock(files: RagFileMetadata[]): string {
	if (files.length === 0) return "";

	const list = files.map(formatFileLine).join("\n");
	return `## Uploaded Files

The user has ${files.length} uploaded file(s) available for retrieval:
${list}

Use \`retrieve_docs\` with \`fileIds\` to scope search to specific files, or omit \`fileIds\` for cross-file queries. Use \`get_file_chunks\` to read a file sequentially.`;
}
