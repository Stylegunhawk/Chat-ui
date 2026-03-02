import { env } from "$env/dynamic/private";
import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	getRAGTokenFromSession,
	storeRAGTokenInSession,
	authenticateWithRAG,
} from "$lib/server/rag/auth";
import { collections } from "$lib/server/database";

export const GET: RequestHandler = async ({ locals }) => {
	// Block anonymous access - require authenticated user
	if (!locals.user?._id) {
		error(401, "Authentication required for RAG operations");
	}

	const sessionId = locals.sessionId;
	if (!sessionId) {
		error(401, "No session found");
	}

	try {
		// Get JWT from session
		let jwt = await getRAGTokenFromSession(sessionId);

		// If no JWT, try to authenticate with RAG using stored Google ID token
		if (!jwt) {
			// Get the user's Google ID token from the database
			const session = await collections.sessions.findOne({ sessionId });
			if (session?.oauth?.idToken) {
				const idToken = session.oauth.idToken;

				try {
					const ragAuth = await authenticateWithRAG(idToken, locals.user._id.toString());
					await storeRAGTokenInSession(sessionId, ragAuth);
					jwt = ragAuth.access_token;
				} catch (ragError) {
					console.error("[RAG] Fallback authentication failed:", ragError);
					error(401, "RAG authentication failed. Please log out and log back in.");
				}
			} else {
				error(401, "No authentication token found. Please log out and log back in.");
			}
		}

		if (!jwt) {
			error(401, "RAG authentication token not found. Please log in again.");
		}

		// Call RAG backend directly
		const RAG_BASE_URL = env.RAG_BASE_URL || "http://localhost:8000";
		const response = await fetch(`${RAG_BASE_URL}/api/v1/rag/files`, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${jwt}`,
			},
		});

		if (!response.ok) {
			const errorText = await response.text();
			console.error(`[RAG] Backend error ${response.status}: ${errorText}`);
			error(response.status, errorText || "Failed to fetch files from RAG service");
		}

		const files = await response.json();

		return new Response(JSON.stringify(files), {
			headers: { "Content-Type": "application/json" },
		});
	} catch (err) {
		console.error("[RAG] Files list error:", err);

		if (err instanceof Error) {
			if (err.message.includes("RAG authentication token not found")) {
				error(401, "RAG authentication failed. Please log in again.");
			}
		}

		error(500, "Failed to fetch files from RAG service");
	}
};
