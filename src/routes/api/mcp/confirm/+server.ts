import { json } from "@sveltejs/kit";
import { resolveConfirmation } from "$lib/server/mcp/confirmationBuffer";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
	const { uuid, action } = await request.json();

	if (!uuid || (action !== "accept" && action !== "reject")) {
		return json({ error: "Invalid request" }, { status: 400 });
	}

	const success = resolveConfirmation(uuid, action);

	if (success) {
		return json({ success: true });
	}

	return json({ error: "Confirmation not found or already processed" }, { status: 404 });
};
