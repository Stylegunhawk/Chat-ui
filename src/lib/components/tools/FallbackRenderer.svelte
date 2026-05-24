<script lang="ts">
	import type { ToolRunViewModel } from "$lib/utils/mcp/toolRunAdapter";

	interface Props {
		vm: ToolRunViewModel;
	}

	let { vm }: Props = $props();

	let isOpen = $state(false);

	const prettyPayload = $derived.by(() => {
		try {
			return JSON.stringify(vm.payload, null, 2);
		} catch {
			return String(vm.payload);
		}
	});
</script>

<div class="rounded-md border border-gray-200 bg-white p-3 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">
	<div class="mb-1 flex items-center justify-between">
		<span class="font-semibold">
			Tool:
			<code class="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-gray-600 dark:bg-gray-800 dark:text-gray-300">
				{vm.toolName ?? "unknown"}
			</code>
		</span>
		<button
			type="button"
			class="text-[11px] text-gray-500 underline-offset-2 hover:underline dark:text-gray-400"
			onclick={() => (isOpen = !isOpen)}
		>
			{isOpen ? "Hide payload" : "Show raw payload"}
		</button>
	</div>

	{#if isOpen}
		<pre class="mt-1 max-h-64 overflow-auto rounded bg-gray-50 p-2 font-mono text-[11px] leading-snug dark:bg-gray-950">
{prettyPayload}</pre>
	{/if}
</div>

