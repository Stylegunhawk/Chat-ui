<script lang="ts">
	import type { ToolRunViewModel } from "$lib/utils/mcp/toolRunAdapter";
	import { dispatchOpenArtifact } from "$lib/events/toolEvents";

	interface Props {
		vm: ToolRunViewModel;
		isLoading?: boolean;
	}

	let { vm, isLoading = false }: Props = $props();

	let containerEl: HTMLButtonElement | undefined = $state();

	const structured = $derived(vm.payload.structured as unknown);

	const rowCount = $derived.by(() => {
		if (!structured || typeof structured !== "object") return null;
		const obj = structured as { rows?: unknown[] };
		if (!Array.isArray(obj.rows)) return null;
		return obj.rows.length;
	});

	function handleClick() {
		if (containerEl && structured) {
			dispatchOpenArtifact(containerEl, {
				toolName: vm.toolName ?? "unknown",
				uuid: vm.uuid,
				data: structured,
				title: "Dataset Analysis",
			});
		}
	}
</script>

<button
	bind:this={containerEl}
	type="button"
	onclick={handleClick}
	class="inline-flex items-center gap-1.5 rounded-full border border-blue-100 bg-blue-50 px-2 py-1 text-xs font-medium text-blue-800 hover:bg-blue-100 dark:border-blue-900/60 dark:bg-blue-900/30 dark:text-blue-100"
>
	<span aria-hidden="true">📊</span>
	<span>
		{#if isLoading}
			Generating dataset…
		{:else}
			Dataset generated{#if rowCount !== null}
				({rowCount} rows){/if}
		{/if}
	</span>
</button>
