import { env } from "$env/dynamic/private";
import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const DELETE: RequestHandler = async ({ params, locals, fetch }) => {
	const userId = locals.user?._id?.toString() || locals.sessionId;
	const fileId = params.id;

	if (!userId) {
		error(401, "Unauthorized");
	}

	if (!fileId) {
		error(400, "File ID is required");
	}

	// Use internal docker network URL if available, otherwise localhost
	const RAG_BASE_URL = env.RAG_BASE_URL || "http://localhost:8000";

	try {
		console.log(`Proxying delete for file ${fileId}, user ${userId} to ${RAG_BASE_URL}`);

		const response = await fetch(`${RAG_BASE_URL}/api/v1/rag/file/${fileId}`, {
			method: "DELETE",
			headers: {
				"X-User-ID": userId,
			},
		});

		if (!response.ok) {
			const text = await response.text();
			console.error(`RAG Delete Error ${response.status}: ${text}`);
			error(response.status, text || response.statusText);
		}

		return new Response(null, { status: 200 });
	} catch (err) {
		console.error("RAG Proxy Delete Error:", err);
		if (err && typeof err === "object" && "status" in err) throw err;
		const message = err instanceof Error ? err.message : "Unknown error";
		error(500, `Failed to delete file: ${message}`);
	}
};
