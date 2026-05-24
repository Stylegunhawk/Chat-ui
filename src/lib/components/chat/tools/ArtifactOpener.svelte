<script lang="ts">
	import { artifactStore, type ArtifactType } from "$lib/stores/artifact.svelte";
	import type { ToolRendererProps } from "./registry";
	import { ToolResultStatus } from "$lib/types/Tool";

	const VALID_TYPES = new Set<string>([
		"text/html",
		"image/svg+xml",
		"text/x-mermaid",
		"application/json",
		"text/markdown",
		"text/csv",
	]);

	let { update, parseToolOutputs }: ToolRendererProps = $props();

	$effect(() => {
		if (update.result.status !== ToolResultStatus.Success) return;
		const outputs = parseToolOutputs(update.result.outputs) as unknown[];
		const raw = outputs[0] as Record<string, unknown> | undefined;
		if (!raw) return;

		const type =
			typeof raw.type === "string" && VALID_TYPES.has(raw.type)
				? (raw.type as ArtifactType)
				: undefined;
		const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "Artifact";
		const content = typeof raw.content === "string" ? raw.content : "";

		if (type && content) {
			artifactStore.pushArtifact({ type, title, content });
		}
	});
</script>
