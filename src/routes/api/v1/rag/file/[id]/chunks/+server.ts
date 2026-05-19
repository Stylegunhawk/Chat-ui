import { error } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";
import { getRAGTokenFromSession } from "$lib/server/rag/auth";
import { RAG_BASE_URL } from "$lib/server/rag/client";

export const GET = async ({ params, locals, url }: RequestEvent) => {
	// Block anonymous access - require authenticated user
	if (!locals.user?._id) {
		error(401, "Authentication required for RAG operations");
	}

	const sessionId = locals.sessionId;
	if (!sessionId) {
		error(401, "No session found");
	}

	const fileId = params.id;
	if (!fileId) {
		error(400, "File ID is required");
	}

	const limit = parseInt(url.searchParams.get("limit") || "5");
	const offset = parseInt(url.searchParams.get("offset") || "0");

	try {
		// Get JWT from session
		const jwt = await getRAGTokenFromSession(sessionId);
		if (!jwt) {
			error(401, "RAG authentication token not found. Please log in again.");
		}

		console.log(`[RAG] Getting chunks for file ${fileId} for user ${locals.user._id}`);

		// Call RAG backend directly
		const response = await fetch(
			`${RAG_BASE_URL}/api/v1/rag/file/${fileId}/chunks?limit=${limit}&offset=${offset}`,
			{
				headers: {
					Authorization: `Bearer ${jwt}`,
				},
			}
		);

		if (!response.ok) {
			const errorText = await response.text();
			console.error(`[RAG] File chunks error ${response.status}: ${errorText}`);
			error(response.status, errorText || "Failed to fetch file chunks");
		}

		const chunks = await response.json();

		return new Response(JSON.stringify(chunks), {
			headers: { "Content-Type": "application/json" },
		});
	} catch (err) {
		// Re-throw SvelteKit HttpErrors (from error() calls above)
		if (err && typeof err === "object" && "status" in err) throw err;

		console.error("[RAG] File chunks error:", err);
		const message = err instanceof Error ? err.message : "Unknown error";
		error(500, `Failed to fetch file chunks: ${message}`);
	}
};
