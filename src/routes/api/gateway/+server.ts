import { error, json } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
	const backendUrl = env.BACKEND_DEVFORGE || "http://localhost:8001";

	let body;
	try {
		body = await request.json();
	} catch (e) {
		return error(400, "Invalid JSON body");
	}

	try {
		const res = await fetch(`${backendUrl}/api/gateway`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});

		if (!res.ok) {
			const errorText = await res.text();
			return error(res.status, errorText || "Gateway error");
		}

		const data = await res.json();
		return json(data);
	} catch (e) {
		console.error("[Gateway Proxy Error]:", e);
		return error(500, `Failed to connect to backend gateway at ${backendUrl}`);
	}
};
