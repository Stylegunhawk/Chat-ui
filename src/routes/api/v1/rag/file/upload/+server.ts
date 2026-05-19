import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getRAGTokenFromSession } from "$lib/server/rag/auth";
import { RAG_BASE_URL } from "$lib/server/rag/client";

export const POST: RequestHandler = async ({ request, locals }) => {
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
		const jwt = await getRAGTokenFromSession(sessionId);
		if (!jwt) {
			error(401, "RAG authentication token not found. Please log in again.");
		}

		// Get the form data from the request
		const formData = await request.formData();
		const collection = (formData.get("collection") as string) || "default";
		const files = formData.getAll("files") as File[];

		if (!files.length) {
			error(400, "No files provided");
		}

		console.log(`[RAG] Uploading ${files.length} files for user ${locals.user._id}`);

		// Call RAG backend directly
		// Rebuild FormData for backend call
		const payload = new FormData();
		payload.append("collection", collection);
		files.forEach((file) => payload.append("files", file));

		const response = await fetch(`${RAG_BASE_URL}/api/v1/rag/file/upload`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${jwt}`,
			},
			body: payload,
		});

		if (!response.ok) {
			const errorText = await response.text();
			console.error(`[RAG] Upload error ${response.status}: ${errorText}`);
			error(response.status, errorText || "Failed to upload files");
		}

		const result = await response.json();

		return new Response(JSON.stringify(result), {
			headers: { "Content-Type": "application/json" },
		});
	} catch (err) {
		console.error("[RAG] Upload error:", err);

		if (err instanceof Error) {
			if (err.message.includes("RAG authentication token not found")) {
				error(401, "RAG authentication failed. Please log in again.");
			}
		}

		if (err && typeof err === "object" && "status" in err) throw err;
		const message = err instanceof Error ? err.message : "Unknown error";
		error(500, `Failed to upload files: ${message}`);
	}
};
