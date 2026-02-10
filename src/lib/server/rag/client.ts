/**
 * DevForge RAG API Client
 * Handles communication with backend RAG endpoints
 *
 * IMMUTABLE BACKEND CONTRACT - DO NOT MODIFY SCHEMAS
 */

const RAG_BASE_URL = process.env.RAG_BASE_URL || "http://localhost:8000";

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

// ============================================================================
// RAG CLIENT CLASS
// ============================================================================

export class RAGClient {
	private baseUrl: string;

	constructor(baseUrl: string = RAG_BASE_URL) {
		this.baseUrl = baseUrl;
	}

	/**
	 * Semantic search for chat context
	 *
	 * CRITICAL: Must include X-User-ID header for tenant isolation
	 */
	async semanticSearch(
		request: SemanticSearchRequest,
		userId: string
	): Promise<SemanticSearchResponse> {
		const response = await fetch(`${this.baseUrl}/api/v1/rag/chunk/semanticSearchForChat`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-User-ID": userId, // CRITICAL: Tenant isolation
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
			// 404 = No files uploaded yet (not an error)
			if (response.status === 404) {
				return { chunks: [], queryId: "" };
			}
			throw new Error(`RAG search failed: ${response.status} ${response.statusText}`);
		}

		return response.json();
	}

	/**
	 * Upload files to RAG
	 */
	async uploadFiles(
		files: File[],
		userId: string,
		collection: string = "default"
	): Promise<FileUploadResponse> {
		const formData = new FormData();
		formData.append("collection", collection);
		files.forEach((file) => formData.append("files", file));

		const response = await fetch(`${this.baseUrl}/api/v1/rag/file/upload`, {
			method: "POST",
			headers: {
				"X-User-ID": userId,
			},
			body: formData,
		});

		if (!response.ok) {
			throw new Error(`File upload failed: ${response.status}`);
		}

		return response.json();
	}

	/**
	 * Poll file status until embedding completes
	 */
	async pollFileStatus(
		fileId: string,
		maxAttempts: number = 30,
		intervalMs: number = 2000
	): Promise<boolean> {
		for (let i = 0; i < maxAttempts; i++) {
			const response = await fetch(`${this.baseUrl}/api/v1/rag/file/${fileId}`);

			if (!response.ok) {
				throw new Error(`File status check failed: ${response.status}`);
			}

			const data = await response.json();

			if (data.finishEmbedding === true) {
				return true;
			}

			await new Promise((resolve) => setTimeout(resolve, intervalMs));
		}

		return false; // Timeout
	}

	/**
	 * Delete file from RAG
	 */
	async deleteFile(fileId: string, userId: string): Promise<void> {
		const response = await fetch(`${this.baseUrl}/api/v1/rag/file/${fileId}`, {
			method: "DELETE",
			headers: {
				"X-User-ID": userId,
			},
		});

		if (!response.ok) {
			throw new Error(`File deletion failed: ${response.status}`);
		}
	}
}

// Singleton instance
export const ragClient = new RAGClient();
