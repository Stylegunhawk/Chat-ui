import { env } from "$env/dynamic/private";
import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals, fetch }) => {
	const userId = locals.user?._id?.toString() || locals.sessionId;

	if (!userId) {
		error(401, "Unauthorized");
	}

	// Use internal docker network URL if available, otherwise localhost
	const RAG_BASE_URL = env.RAG_BASE_URL || "http://localhost:8000";

	try {
		const response = await fetch(`${RAG_BASE_URL}/api/v1/rag/files`, {
			method: "GET",
			headers: {
				"X-User-ID": userId,
			},
		});

		if (!response.ok) {
			const text = await response.text();
			error(response.status, text || response.statusText);
		}

		const data = await response.json();
		return new Response(JSON.stringify(data), {
			headers: { "Content-Type": "application/json" },
		});
	} catch (e) {
		console.error("RAG Proxy Error:", e);
		error(500, "Failed to fetch files from RAG service");
	}
};
