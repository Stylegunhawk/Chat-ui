import { error } from "@sveltejs/kit";
import { getRAGTokenFromSession } from "$lib/server/rag/auth";
import type { RequestEvent } from "@sveltejs/kit";

export async function POST({ request, locals }: RequestEvent) {
	// Block anonymous access
	if (!locals.user?._id) {
		error(401, "Authentication required for RAG operations");
	}

	const sessionId = locals.sessionId;
	if (!sessionId) {
		error(401, "No session found");
	}

	try {
		// Get JWT from session
		const jwt = await getRAGTokenFromSession(sessionId);
		if (!jwt) {
			error(401, "RAG authentication token not found. Please log in again.");
		}

		const body = await request.json();

		// Call RAG backend directly
		const RAG_BASE_URL = process.env.RAG_BASE_URL || "http://localhost:8000";
		const response = await fetch(`${RAG_BASE_URL}/api/v1/rag/chunk/semanticSearchForChat`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${jwt}`,
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const errorText = await response.text();
			console.error(`[RAG] Semantic search error ${response.status}: ${errorText}`);
			error(response.status, errorText || "RAG semantic search failed");
		}

		const result = await response.json();

		return new Response(JSON.stringify(result), {
			headers: { "Content-Type": "application/json" },
		});
	} catch (err) {
		// Re-throw SvelteKit HttpErrors (from error() calls above)
		if (err && typeof err === "object" && "status" in err) throw err;

		console.error("[RAG] Semantic search error:", err);
		const message = err instanceof Error ? err.message : "Unknown error";
		error(500, `RAG semantic search failed: ${message}`);
	}
}
