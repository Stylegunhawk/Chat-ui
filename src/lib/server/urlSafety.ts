// Shared server-side URL safety helper (exact behavior preserved)
export function isValidUrl(
	urlString: string,
	options: { allowHttp?: boolean; allowLocal?: boolean } = {}
): boolean {
	try {
		const url = new URL(urlString.trim());
		// Only allow HTTPS protocol by default
		if (!options.allowHttp && url.protocol !== "https:") {
			return false;
		}

		// Basic check for allowed protocols
		if (!["http:", "https:"].includes(url.protocol)) {
			return false;
		}

		if (options.allowLocal) {
			return true;
		}

		// Prevent localhost/private IPs (basic check)
		const hostname = url.hostname.toLowerCase();
		if (
			hostname === "localhost" ||
			hostname.startsWith("127.") ||
			hostname.startsWith("192.168.") ||
			hostname.startsWith("172.16.") ||
			hostname === "[::1]" ||
			hostname === "0.0.0.0"
		) {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}
