import type { RagFileMetadata } from "./client";

export type AvailableRagFile = Pick<RagFileMetadata, "id" | "name" | "url">;

export function mapRagFilesForMessageUpdates(
	ragFiles: RagFileMetadata[]
): AvailableRagFile[] {
	return ragFiles.map(({ id, name, url }) => ({ id, name, url }));
}
