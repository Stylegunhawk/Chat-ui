import { error, json } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
	const backendUrl = env.BACKEND_DEVFORGE || "http://localhost:8001";

	let body;
	try {
		body = await request.json();
	} catch {
		error(400, "Invalid JSON body");
	}

	// Forward any extra headers the client sent (e.g. x-api-key from MCP server config)
	const extraHeaders: Record<string, string> = body.headers ?? {};

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...extraHeaders,
	};

	// Remove headers from the body before forwarding — backend doesn't expect it
	const payload = { ...body };
	delete payload.headers;

	let res: Response;
	try {
		res = await fetch(`${backendUrl}/api/gateway`, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
		});
	} catch (e) {
		console.error("[Gateway Proxy Error]:", e);
		error(500, `Failed to connect to backend gateway at ${backendUrl}`);
	}

	// Forward the response as-is (preserving status) so the client can parse
	// structured error bodies like 429 rate-limit with limit_info, or 200 with success:false.
	const data = await res.json().catch(() => null);

	if (!res.ok) {
		if (data) {
			return json(data, { status: res.status });
		}
		error(res.status, "Gateway error");
	}

	return json(data);
};
