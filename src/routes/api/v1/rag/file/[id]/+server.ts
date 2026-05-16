import { env } from "$env/dynamic/private";
import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getRAGTokenFromSession } from "$lib/server/rag/auth";

export const DELETE: RequestHandler = async ({ params, locals }) => {
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

	try {
		// Get JWT from session
		const jwt = await getRAGTokenFromSession(sessionId);
		if (!jwt) {
			error(401, "RAG authentication token not found. Please log in again.");
		}

		console.log(`[RAG] Deleting file ${fileId} for user ${locals.user._id}`);

		// Call RAG backend directly
		const RAG_BASE_URL = env.RAG_BASE_URL || "http://localhost:8000";
		const response = await fetch(`${RAG_BASE_URL}/api/v1/rag/file/${fileId}`, {
			method: "DELETE",
			headers: {
				Authorization: `Bearer ${jwt}`,
			},
		});

		if (!response.ok) {
			const errorText = await response.text();
			console.error(`[RAG] Delete error ${response.status}: ${errorText}`);
			error(response.status, errorText || "Failed to delete file");
		}

		return new Response(null, { status: 200 });
	} catch (err) {
		console.error("[RAG] Delete error:", err);

		if (err instanceof Error) {
			if (err.message.includes("RAG authentication token not found")) {
				error(401, "RAG authentication failed. Please log in again.");
			}
		}

		if (err && typeof err === "object" && "status" in err) throw err;
		const message = err instanceof Error ? err.message : "Unknown error";
		error(500, `Failed to delete file: ${message}`);
	}
};
