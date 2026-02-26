export const DESTRUCTIVE_KEYWORDS = [
	// Deletion / Removal
	"delete",
	"remove",
	"drop",
	// Force operations
	"force push",
	"force-push",
	"force_push",
	// PR / Merge operations
	"merge pr",
	"merge pull request",
	"merge branch",
	// Repo creation (modifies GitHub account)
	"create repo",
	"create repository",
	"create_repo",
	"scaffold repo",
	"scaffold repository",
	"scaffold_repo",
	// File write operations
	"commit file",
	"commit to",
	"push to",
	"push file",
	// Issue / PR creation
	"create issue",
	"create pull request",
	"create pr",
	"open pr",
	"open issue",
];

/**
 * Checks if a github_operation query contains any write/destructive keywords.
 * Used to trigger a confirmation modal before executing the tool call.
 */
export function containsDestructiveKeyword(text: string): boolean {
	const lower = text.toLowerCase();
	return DESTRUCTIVE_KEYWORDS.some((keyword) => lower.includes(keyword.toLowerCase()));
}

/**
 * Returns the matched keyword for display in the confirmation modal.
 */
export function getMatchedKeyword(text: string): string | null {
	const lower = text.toLowerCase();
	return DESTRUCTIVE_KEYWORDS.find((keyword) => lower.includes(keyword.toLowerCase())) ?? null;
}
