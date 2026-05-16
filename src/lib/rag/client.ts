/**
 * DevForge RAG API Client
 * Handles communication with RAG endpoints via SvelteKit proxy
 *
 * IMMUTABLE BACKEND CONTRACT - DO NOT MODIFY SCHEMAS
 */

// All RAG calls go through SvelteKit proxy routes for security
const PROXY_BASE_URL = "/api/v1/rag";

export { PROXY_BASE_URL };

// ============================================================================
// TYPE DEFINITIONS (Match backend schemas exactly)
// ============================================================================

export interface ChatFileChunk {
	id: string;
	fileId: string;
	filename: string;
	fileType: string;
	fileUrl: string;
	text: string;
	similarity: number;
	pageNumber?: number | null;
	role: "entry" | "dependency" | "supporting";
}

export interface SemanticSearchRequest {
	messageId: string;
	userQuery: string;
	rewriteQuery?: string;
	top_k?: number;
	fileIds?: string[];
}

export interface SemanticSearchResponse {
	chunks: ChatFileChunk[];
	queryId: string;
	// relevant_docs might remain if backend sends it, but we focus on chunks
}

export interface FileUploadResponse {
	files: Array<{
		id: string;
		name: string;
		size: number;
		url: string;
		finishEmbedding: boolean;
		chunkCount: number;
	}>;
}

export interface RagFileMetadata {
	id: string;
	name: string;
	size: number;
	fileType: string;
	chunkCount: number;
	chunkingStatus: "pending" | "processing" | "success" | "failed";
	embeddingStatus: "pending" | "processing" | "success" | "failed";
	finishEmbedding: boolean;
	chunkingError: string | null;
	embeddingError: string | null;
	createdAt: string;
	updatedAt: string;
	url?: string;
}

// ============================================================================
// RAG CLIENT CLASS
// ============================================================================

export class RAGClient {
	private baseUrl: string;

	constructor(baseUrl: string = PROXY_BASE_URL) {
		this.baseUrl = baseUrl;
	}

	/**
	 * Semantic search for chat context
	 *
	 * Goes through SvelteKit proxy which adds JWT authentication
	 */
	async semanticSearch(request: SemanticSearchRequest): Promise<SemanticSearchResponse> {
		const response = await fetch(`${this.baseUrl}/chunk/semanticSearchForChat`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				messageId: request.messageId,
				userQuery: request.userQuery,
				rewriteQuery: request.rewriteQuery,
				top_k: request.top_k || 5,
				fileIds: request.fileIds,
			}),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`RAG Semantic Search failed: ${response.status} ${errorText}`);
		}

		return await response.json();
	}
	/**
	 * Get chunks for a specific file
	 */
	async getFileChunks(
		fileId: string,
		limit: number = 5,
		offset: number = 0
	): Promise<SemanticSearchResponse> {
		const response = await fetch(
			`${this.baseUrl}/file/${fileId}/chunks?limit=${limit}&offset=${offset}`
		);

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Failed to fetch file chunks: ${response.status} ${errorText}`);
		}

		// Backend might return chunks array directly or wrapped in SemanticSearchResponse
		const data = await response.json();
		if (Array.isArray(data)) {
			return { chunks: data, queryId: `file_${fileId}` };
		}
		return data;
	}

	/**
	 * List all files for authenticated user
	 */
	async listFiles(): Promise<RagFileMetadata[]> {
		const response = await fetch(`${this.baseUrl}/files`);

		if (!response.ok) {
			throw new Error(`Failed to list files: ${response.statusText}`);
		}

		return response.json();
	}

	/**
	 * Upload files to RAG system via proxy
	 */
	async uploadFiles(
		files: File[],
		collection: string = "default"
	): Promise<{ file_ids: string[] }> {
		const formData = new FormData();

		files.forEach((file) => formData.append("files", file));
		formData.append("collection", collection);

		const response = await fetch(`${this.baseUrl}/file/upload`, {
			method: "POST",
			body: formData,
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(errorText || `Upload failed: ${response.statusText}`);
		}

		return response.json();
	}

	/**
	 * Delete a file from RAG system via proxy
	 */
	async deleteFile(fileId: string): Promise<void> {
		const response = await fetch(`${this.baseUrl}/file/${fileId}`, {
			method: "DELETE",
		});

		if (!response.ok) {
			throw new Error(`Delete failed: ${response.statusText}`);
		}
	}
}

export const ragClient = new RAGClient();
