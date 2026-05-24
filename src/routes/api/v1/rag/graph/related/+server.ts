import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getRAGTokenFromSession } from "$lib/server/rag/auth";
import { RAG_BASE_URL } from "$lib/server/rag/client";

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user?._id) {
		error(401, "Authentication required for RAG operations");
	}

	const sessionId = locals.sessionId;
	if (!sessionId) {
		error(401, "No session found");
	}

	const entity = url.searchParams.get("entity");
	if (!entity) {
		error(400, "entity query parameter is required");
	}

	try {
		const jwt = await getRAGTokenFromSession(sessionId);
		if (!jwt) {
			error(401, "RAG authentication token not found. Please log in again.");
		}

		// Forward all query params (entity, depth, max, include_snippets)
		const backendUrl = new URL(`${RAG_BASE_URL}/api/v1/rag/graph/related`);
		url.searchParams.forEach((value, key) => backendUrl.searchParams.set(key, value));

		const response = await fetch(backendUrl.toString(), {
			headers: { Authorization: `Bearer ${jwt}` },
		});

		if (!response.ok) {
			const errorText = await response.text();
			error(response.status, errorText || "Failed to fetch related graph entities");
		}

		const data = await response.json();
		return new Response(JSON.stringify(data), {
			headers: { "Content-Type": "application/json" },
		});
	} catch (err) {
		if (err && typeof err === "object" && "status" in err) throw err;
		const message = err instanceof Error ? err.message : "Unknown error";
		error(500, `Failed to fetch related graph entities: ${message}`);
	}
};
