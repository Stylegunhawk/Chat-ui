// Shared server-side URL safety helper (exact behavior preserved)
export function isValidUrl(urlString: string): boolean {
	try {
		const url = new URL(urlString.trim());
		const hostname = url.hostname.toLowerCase();

		// For security, require HTTPS for remote hosts, but allow HTTP for local
		// development (localhost / loopback only).
		const isLocalHost =
			hostname === "localhost" || hostname === "[::1]" || hostname.startsWith("127.");

		if (!isLocalHost && url.protocol !== "https:") {
			return false;
		}

		// Still reject obvious non-routable or wildcard hosts
		if (hostname === "0.0.0.0") {
			return false;
		}

		return true;
	} catch {
		return false;
	}
}
