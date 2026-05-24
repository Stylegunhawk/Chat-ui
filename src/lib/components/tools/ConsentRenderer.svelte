<script lang="ts">
	import type { ToolRunViewModel } from "$lib/utils/mcp/toolRunAdapter";
	import LucideShield from "~icons/lucide/shield";
	import { dispatchRequestConsent } from "$lib/events/toolEvents";

	interface Props {
		vm: ToolRunViewModel;
	}

	let { vm }: Props = $props();

	let containerEl: HTMLDivElement | undefined = $state();

	function handleAction(approved: boolean) {
		if (containerEl) {
			dispatchRequestConsent(containerEl, {
				toolName: vm.toolName ?? "unknown",
				uuid: vm.uuid,
				action: approved ? "approve" : "deny",
				parameters: vm.payload.rawOutputs?.[0], // Pass context if needed
			});
		}
	}
</script>

<div
	bind:this={containerEl}
	class="flex flex-col gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-3 dark:border-amber-900/60 dark:bg-amber-900/20"
>
	<div class="flex items-center gap-2 text-sm">
		<LucideShield class="size-4 text-amber-600 dark:text-amber-400" />
		<span class="font-medium text-amber-800 dark:text-amber-200"> Requires approval </span>
		{#if vm.toolName}
			<code
				class="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-xs text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
			>
				{vm.toolName}
			</code>
		{/if}
	</div>

	<div class="flex items-center gap-2">
		<button
			onclick={() => handleAction(true)}
			class="rounded-md bg-amber-600 px-3 py-1 text-xs font-semibold text-white hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-600"
		>
			Approve
		</button>
		<button
			onclick={() => handleAction(false)}
			class="rounded-md border border-amber-300 bg-white px-3 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-50 dark:border-amber-700 dark:bg-gray-800 dark:text-amber-200 dark:hover:bg-gray-700"
		>
			Deny
		</button>
	</div>
</div>
