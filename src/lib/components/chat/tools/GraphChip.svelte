<script lang="ts">
	import { artifactStore } from "$lib/stores/artifact.svelte";
	import { ToolResultStatus } from "$lib/types/Tool";
	import type { MessageToolResultUpdate } from "$lib/types/MessageUpdate";

	// Renders the dependency-graph result from get_code_graph_related as a clickable
	// pill that opens the Mermaid diagram in the artifact panel. Reads the structured
	// payload (`outputs[0].structured`) attached in runRagFlow; renders nothing if it
	// is absent or malformed.
	let { update }: { update: MessageToolResultUpdate } = $props();

	const structured = $derived.by(() => {
		if (update.result.status !== ToolResultStatus.Success) return null;
		const outputs = update.result.outputs;
		const first = Array.isArray(outputs) ? (outputs[0] as Record<string, unknown>) : undefined;
		const s = first?.structured as
			| { mermaid?: unknown; entity?: unknown; nodeCount?: unknown }
			| undefined;
		if (
			!s ||
			typeof s.mermaid !== "string" ||
			typeof s.entity !== "string" ||
			typeof s.nodeCount !== "number"
		) {
			return null;
		}
		return { mermaid: s.mermaid, entity: s.entity, nodeCount: s.nodeCount };
	});

	function open() {
		if (!structured) return;
		artifactStore.pushArtifact({
			type: "text/x-mermaid",
			title: `Dependency graph: ${structured.entity}`,
			content: structured.mermaid,
		});
	}
</script>

{#if structured}
	<button
		type="button"
		onclick={open}
		class="inline-flex items-center gap-1.5 rounded-full border border-violet-100 bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-800 hover:bg-violet-100 dark:border-violet-900/60 dark:bg-violet-900/30 dark:text-violet-100"
	>
		<span aria-hidden="true">🕸</span>
		<span>Dependency graph: {structured.entity} ({structured.nodeCount} nodes)</span>
	</button>
{/if}
