import { env } from "$env/dynamic/private";
import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, locals, fetch }) => {
	const userId = locals.user?._id?.toString() || locals.sessionId;

	if (!userId) {
		error(401, "Unauthorized");
	}

	// Use internal docker network URL if available, otherwise localhost
	const RAG_BASE_URL = env.RAG_BASE_URL || "http://localhost:8000";

	try {
		// Get the form data from the request
		const formData = await request.formData();

		// Note: We don't need to manually reconstruct the FormData if we pass the original body
		// BUT: SvelteKit's request.formData() consumes the body.
		// AND: passing the FormData object directly to fetch works in Node.js environments
		// if the node-fetch version supports it, or we might need to handle headers carefully.
		// Generally, creating a new FormData and appending is safest for forwarding.

		const payload = new FormData();
		const collection = formData.get("collection") as string;
		if (collection) payload.append("collection", collection);

		const files = formData.getAll("files");
		for (const file of files) {
			payload.append("files", file);
		}

		console.log(`Proxying upload for user ${userId} to ${RAG_BASE_URL}`);

		const response = await fetch(`${RAG_BASE_URL}/api/v1/rag/file/upload`, {
			method: "POST",
			headers: {
				"X-User-ID": userId,
				// Do NOT set Content-Type here, let fetch/FormData handle the boundary
			},
			body: payload,
		});

		if (!response.ok) {
			const text = await response.text();
			console.error(`RAG Upload Error ${response.status}: ${text}`);
			error(response.status, text || response.statusText);
		}

		const data = await response.json();
		return new Response(JSON.stringify(data), {
			headers: { "Content-Type": "application/json" },
		});
	} catch (err) {
		console.error("RAG Proxy Extension Error:", err);
		if (err && typeof err === "object" && "status" in err) throw err;
		const message = err instanceof Error ? err.message : "Unknown error";
		error(500, `Failed to upload files: ${message}`);
	}
};
