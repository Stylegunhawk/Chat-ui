import { collections } from "$lib/server/database";
import type { Session } from "$lib/types/Session";
import { RAG_BASE_URL } from "$lib/server/rag/client";

export interface RAGAuthResponse {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
	token_type?: string;
}

/**
 * Authenticate with RAG backend using Google token
 */
export async function authenticateWithRAG(
	googleToken: string,
	mongodbId: string
): Promise<RAGAuthResponse> {
	const response = await fetch(`${RAG_BASE_URL}/api/auth/google`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			google_token: googleToken,
			mongodb_id: mongodbId,
		}),
	});

	if (!response.ok) {
		throw new Error(`RAG authentication failed: ${response.status} ${response.statusText}`);
	}

	return response.json() as Promise<RAGAuthResponse>;
}

/**
 * Refresh RAG JWT token
 */
export async function refreshRAGToken(refreshToken: string): Promise<RAGAuthResponse> {
	const response = await fetch(`${RAG_BASE_URL}/api/auth/refresh`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			refresh_token: refreshToken,
		}),
	});

	if (!response.ok) {
		const errorText = await response.text();
		if (response.status === 401 && errorText.includes("Session expired")) {
			throw new Error("RAG session expired, please re-authenticate with Google");
		}
		throw new Error(`RAG token refresh failed: ${response.status} ${response.statusText}`);
	}

	return response.json() as Promise<RAGAuthResponse>;
}

/**
 * Store RAG JWT in user session
 */
export async function storeRAGTokenInSession(
	sessionId: string,
	ragAuth: RAGAuthResponse
): Promise<void> {
	const expiresAt = new Date();
	expiresAt.setSeconds(expiresAt.getSeconds() + (ragAuth.expires_in || 3600));

	await collections.sessions.updateOne(
		{ sessionId },
		{
			$set: {
				ragToken: ragAuth.access_token,
				ragRefreshToken: ragAuth.refresh_token || ragAuth.access_token,
				ragTokenExpiresAt: expiresAt,
				updatedAt: new Date(),
			},
		}
	);
}

/**
 * Get RAG JWT from session
 */
export async function getRAGTokenFromSession(sessionId: string): Promise<string | null> {
	const session = await collections.sessions.findOne({ sessionId });
	return session?.ragToken || null;
}

/**
 * Get RAG refresh token from session
 */
export async function getRAGRefreshTokenFromSession(sessionId: string): Promise<string | null> {
	const session = await collections.sessions.findOne({ sessionId });
	return session?.ragRefreshToken || null;
}

/**
 * Check if RAG token is expired or close to expiry
 */
export function isRAGTokenExpired(session: Session): boolean {
	if (!session?.ragTokenExpiresAt) {
		return false; // No expiry set, assume valid
	}
	// Add 5 minute buffer before expiry
	return new Date() >= new Date(session.ragTokenExpiresAt.getTime() - 5 * 60 * 1000);
}
