import { RAGClient } from "./client";

// Browser-specific singleton instance
// Uses public env var, safe for client-side code
// Browser-specific singleton instance
// Uses relative path to hit SvelteKit proxy endpoints
export const browserRagClient = new RAGClient("");
