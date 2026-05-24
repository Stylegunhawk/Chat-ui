/**
 * RAG Router — minimal helpers used by the agentic RAG layer.
 */

export interface RagFileContext {
	id: string;
	name: string;
	chunkCount?: number;
}

/**
 * Find a file explicitly named in the query (exact, base name, or keyword token match).
 */
export function findFileMatch(query: string, files: RagFileContext[]): RagFileContext | undefined {
	const lowerQuery = query.toLowerCase();
	for (const file of files) {
		const lowerName = file.name.toLowerCase();
		const nameParts = lowerName.split(".");
		const baseName = nameParts.length > 1 ? nameParts.slice(0, -1).join(".") : lowerName;

		if (new RegExp(`\\b${lowerName.replace(/\./g, "\\.")}\\b`).test(lowerQuery)) {
			return file;
		}
		if (
			baseName.length > 2 &&
			new RegExp(`\\b${baseName.replace(/\./g, "\\.")}\\b`).test(lowerQuery)
		) {
			return file;
		}

		const tokens = baseName.split(/[\s_\-.]+/).filter((t) => t.length > 3);
		for (const token of tokens) {
			if (new RegExp(`\\b${token}\\b`, "i").test(lowerQuery)) {
				return file;
			}
		}
	}

	return undefined;
}
