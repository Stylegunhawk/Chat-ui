import { config } from "$lib/server/config";
import { isValidUrl } from "$lib/server/urlSafety";
import { logger } from "$lib/server/logger";

let warnedOnce = false;

/**
 * Headers to merge into an OpenAI completion request. Forwards the end-user's
 * access token (`locals.token`) as `Authorization: Bearer` ONLY when explicitly
 * enabled via OPENAI_FORWARD_USER_TOKEN AND the configured OPENAI_BASE_URL is a
 * trusted (https / loopback) URL. Default is off — the completion call does not
 * need the user's identity to function, and forwarding it to an arbitrary base
 * URL leaks the credential to whatever endpoint the operator configured.
 */
export function userTokenHeaders(locals: App.Locals | undefined): Record<string, string> {
	if (config.OPENAI_FORWARD_USER_TOKEN !== "true") {
		return {};
	}
	const baseUrl = config.OPENAI_BASE_URL;
	if (typeof baseUrl !== "string" || !isValidUrl(baseUrl)) {
		if (!warnedOnce) {
			warnedOnce = true;
			logger.warn(
				{ baseUrl },
				"[auth] OPENAI_FORWARD_USER_TOKEN is enabled but OPENAI_BASE_URL did not pass isValidUrl — not forwarding the user token"
			);
		}
		return {};
	}
	return locals?.token ? { Authorization: `Bearer ${locals.token}` } : {};
}
