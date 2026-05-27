/**
 * DevForge RAG API Client
 * Handles communication with backend RAG endpoints
 *
 * IMMUTABLE BACKEND CONTRACT - DO NOT MODIFY SCHEMAS
 */

import type { ChatFileChunk, SemanticSearchResponse, RagFileMetadata } from "$lib/rag/client";
import { logger } from "$lib/server/logger";

const RAG_BASE_URL = process.env.RAG_BASE_URL || "http://localhost:8000";

export { RAG_BASE_URL };

// ============================================================================
// TYPE DEFINITIONS (Match backend schemas exactly)
// ============================================================================

export interface SemanticSearchRequest {
	messageId: string;
	userQuery: string;
	rewriteQuery?: string;
	top_k?: number;
	fileIds?: string[];
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
	private sessionId: string;

	constructor(baseUrl: string = RAG_BASE_URL, sessionId: string = "") {
		this.baseUrl = baseUrl;
		this.sessionId = sessionId;
	}

	/**
	 * Get JWT token from session with automatic refresh
	 */
	private async getJWT(): Promise<string> {
		const {
			getRAGTokenFromSession,
			getRAGRefreshTokenFromSession,
			refreshRAGToken,
			storeRAGTokenInSession,
			isRAGTokenExpired,
		} = await import("$lib/server/rag/auth");

		let jwt = await getRAGTokenFromSession(this.sessionId);

		// Track why we ended up without a token so the terminal error names the root
		// cause (refresh failure vs. missing credentials) instead of collapsing both
		// into a generic "no token" message.
		let refreshFailed = false;

		// Check if token is expired and needs refresh
		if (jwt) {
			const { collections } = await import("$lib/server/database");
			const session = await collections.sessions.findOne({ sessionId: this.sessionId });
			if (session && isRAGTokenExpired(session)) {
				const refreshToken = await getRAGRefreshTokenFromSession(this.sessionId);

				if (refreshToken) {
					try {
						const newAuth = await refreshRAGToken(refreshToken);
						await storeRAGTokenInSession(this.sessionId, newAuth);
						jwt = newAuth.access_token;
					} catch (refreshError) {
						logger.warn(
							{ sessionId: this.sessionId, err: refreshError },
							"[RAG] JWT refresh failed — falling back to id-token authentication"
						);
						refreshFailed = true;
						// Fall through to fallback authentication
						jwt = null;
					}
				} else {
					jwt = null;
				}
			}
		}

		if (!jwt) {
			// Try fallback authentication
			const { collections } = await import("$lib/server/database");
			const { authenticateWithRAG } = await import("$lib/server/rag/auth");

			const session = await collections.sessions.findOne({ sessionId: this.sessionId });
			if (session?.oauth?.idToken) {
				try {
					const ragAuth = await authenticateWithRAG(
						session.oauth.idToken,
						session.userId?.toString() || ""
					);
					await storeRAGTokenInSession(this.sessionId, ragAuth);
					jwt = ragAuth.access_token;
				} catch (e) {
					logger.error(
						{ sessionId: this.sessionId, err: e },
						"[RAG] Fallback id-token authentication failed"
					);
				}
			}
		}

		if (!jwt) {
			throw new Error(
				refreshFailed
					? "RAG token refresh failed and fallback authentication did not succeed. Please log in again."
					: "No RAG authentication token found. Please log in again."
			);
		}

		return jwt;
	}

	/**
	 * Make HTTP request with JWT authentication and retry logic
	 */
	private async makeRequest(url: string, options: RequestInit): Promise<Response> {
		const response = await fetch(url, options);

		// If 401, try to refresh token and retry once
		if (response.status === 401) {
			await this.refreshToken();

			// Retry with new token
			const newOptions = { ...options };
			const newJwt = await this.getJWT();
			if (newOptions.headers) {
				(newOptions.headers as Record<string, string>)["Authorization"] = `Bearer ${newJwt}`;
			}

			return fetch(url, newOptions);
		}

		return response;
	}

	/**
	 * Refresh JWT token
	 */
	private async refreshToken(): Promise<void> {
		const { getRAGRefreshTokenFromSession, refreshRAGToken, storeRAGTokenInSession } = await import(
			"$lib/server/rag/auth"
		);

		const refreshToken = await getRAGRefreshTokenFromSession(this.sessionId);
		if (!refreshToken) {
			throw new Error("No refresh token available. Please log in again.");
		}

		const newAuth = await refreshRAGToken(refreshToken);
		await storeRAGTokenInSession(this.sessionId, newAuth);
	}

	/**
	 * Semantic search for chat context
	 *
	 * CRITICAL: Must include JWT Bearer token for authentication
	 */
	async semanticSearch(request: SemanticSearchRequest): Promise<SemanticSearchResponse> {
		const jwt = await this.getJWT();
		const response = await this.makeRequest(
			`${this.baseUrl}/api/v1/rag/chunk/semanticSearchForChat`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${jwt}`, // CRITICAL: JWT authentication
				},
				body: JSON.stringify({
					messageId: request.messageId,
					userQuery: request.userQuery,
					rewriteQuery: request.rewriteQuery,
					top_k: request.top_k || 5,
					fileIds: request.fileIds,
				}),
			}
		);

		if (!response.ok) {
			// 404 = No files uploaded yet (not an error)
			if (response.status === 404) {
				return { chunks: [], queryId: "", expansion_count: 0 };
			}
			throw new Error(`RAG search failed: ${response.status} ${response.statusText}`);
		}

		return response.json();
	}

	/**
	 * Upload files to RAG
	 */
	async uploadFiles(files: File[], collection: string = "default"): Promise<FileUploadResponse> {
		const jwt = await this.getJWT();
		const formData = new FormData();
		formData.append("collection", collection);
		files.forEach((file) => formData.append("files", file));

		const response = await this.makeRequest(`${this.baseUrl}/api/v1/rag/file/upload`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${jwt}`,
			},
			body: formData,
		});

		if (!response.ok) {
			throw new Error(`File upload failed: ${response.status}`);
		}

		return response.json();
	}

	/**
	 * List all files for authenticated user
	 */
	async listFiles(): Promise<RagFileMetadata[]> {
		const jwt = await this.getJWT();
		const response = await this.makeRequest(`${this.baseUrl}/api/v1/rag/files`, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${jwt}`,
			},
		});

		if (!response.ok) {
			throw new Error(`Files list failed: ${response.status}`);
		}

		return response.json() as Promise<RagFileMetadata[]>;
	}

	/**
	 * Get chunks for a specific file
	 */
	async getFileChunks(
		fileId: string,
		limit: number = 5,
		offset: number = 0
	): Promise<SemanticSearchResponse> {
		const jwt = await this.getJWT();
		const response = await this.makeRequest(
			`${this.baseUrl}/api/v1/rag/file/${fileId}/chunks?limit=${limit}&offset=${offset}`,
			{
				headers: {
					Authorization: `Bearer ${jwt}`,
				},
			}
		);

		if (!response.ok) {
			throw new Error(`File chunks failed: ${response.status}`);
		}

		return response.json() as Promise<SemanticSearchResponse>;
	}

	/**
	 * Fetch code entities related to a given class or function via the dependency graph.
	 */
	async getGraphRelated(
		entity: string,
		depth = 2,
		max = 10,
		includeSnippets = false
	): Promise<unknown> {
		const jwt = await this.getJWT();
		const params = new URLSearchParams({ entity, depth: String(depth), max: String(max) });
		if (includeSnippets) params.set("include_snippets", "true");

		const response = await this.makeRequest(
			`${this.baseUrl}/api/v1/rag/graph/related?${params.toString()}`,
			{ headers: { Authorization: `Bearer ${jwt}` } }
		);

		if (!response.ok) {
			throw new Error(`Graph related failed: ${response.status} ${response.statusText}`);
		}

		return response.json();
	}

	/**
	 * Delete file from RAG
	 */
	async deleteFile(fileId: string): Promise<void> {
		const jwt = await this.getJWT();
		const response = await this.makeRequest(`${this.baseUrl}/api/v1/rag/file/${fileId}`, {
			method: "DELETE",
			headers: {
				Authorization: `Bearer ${jwt}`,
			},
		});

		if (!response.ok) {
			throw new Error(`File deletion failed: ${response.status}`);
		}

		return;
	}
}

// Singleton instance
export const ragClient = new RAGClient();
