<script lang="ts">
	import type { ToolRunViewModel } from "$lib/utils/mcp/toolRunAdapter";
	import { artifactStore } from "$lib/stores/artifact.svelte";

	interface Props {
		vm: ToolRunViewModel;
		isLoading?: boolean;
	}

	let { vm, isLoading = false }: Props = $props();

	const structured = $derived.by(() => {
		const raw = vm.payload.structured as unknown;
		if (!raw || typeof raw !== "object") return null;
		const obj = raw as { mermaid?: unknown; entity?: unknown; nodeCount?: unknown };
		if (typeof obj.mermaid !== "string") return null;
		if (typeof obj.entity !== "string") return null;
		if (typeof obj.nodeCount !== "number") return null;
		return { mermaid: obj.mermaid, entity: obj.entity, nodeCount: obj.nodeCount };
	});

	function handleClick() {
		if (!structured) return;
		artifactStore.pushArtifact({
			type: "text/x-mermaid",
			title: `Dependency graph: ${structured.entity}`,
			content: structured.mermaid,
		});
	}
</script>

{#if structured || isLoading}
	<button
		type="button"
		onclick={handleClick}
		class="inline-flex items-center gap-1.5 rounded-full border border-violet-100 bg-violet-50 px-2 py-1 text-xs font-medium text-violet-800 hover:bg-violet-100 dark:border-violet-900/60 dark:bg-violet-900/30 dark:text-violet-100"
	>
		<span aria-hidden="true">🕸</span>
		<span>
			{#if isLoading}
				Analyzing graph…
			{:else}
				Dependency graph: {structured?.entity ?? "…"} ({structured?.nodeCount ?? "…"} nodes)
			{/if}
		</span>
	</button>
{/if}
