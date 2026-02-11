import { env } from "$env/dynamic/public";

/**
 * DevForge RAG API Client
 * Handles communication with backend RAG endpoints
 *
 * IMMUTABLE BACKEND CONTRACT - DO NOT MODIFY SCHEMAS
 */

// Use public env var for client-side compatibility, fallback to localhost:8000
const RAG_BASE_URL = env.PUBLIC_RAG_BASE_URL || "http://localhost:8000";

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
			const errorText = await response.text();
			throw new Error(`RAG Semantic Search failed: ${response.status} ${errorText}`);
		}

		return await response.json();
	}

	/**
	 * List all files for a tenant
	 */
	async listFiles(tenantId: string): Promise<RagFileMetadata[]> {
		const response = await fetch(`${this.baseUrl}/api/v1/rag/files`, {
			headers: {
				"X-User-ID": tenantId,
			},
		});

		if (!response.ok) {
			throw new Error(`Failed to list files: ${response.statusText}`);
		}

		return response.json();
	}

	/**
	 * Upload files to RAG system
	 */
	async uploadFiles(
		files: File[],
		tenantId: string,
		collection: string = "default"
	): Promise<{ file_ids: string[] }> {
		const formData = new FormData();

		files.forEach((file) => formData.append("files", file));
		formData.append("collection", collection);

		const response = await fetch(`${this.baseUrl}/api/v1/rag/file/upload`, {
			method: "POST",
			headers: {
				"X-User-ID": tenantId,
				// Content-Type is set automatically by browser with boundary
			},
			body: formData,
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(errorText || `Upload failed: ${response.statusText}`);
		}

		return response.json();
	}

	/**
	 * Delete a file from RAG system
	 */
	async deleteFile(fileId: string, tenantId: string): Promise<void> {
		const response = await fetch(`${this.baseUrl}/api/v1/rag/file/${fileId}`, {
			method: "DELETE",
			headers: {
				"X-User-ID": tenantId,
			},
		});

		if (!response.ok) {
			throw new Error(`Delete failed: ${response.statusText}`);
		}
	}
}

export const ragClient = new RAGClient();
