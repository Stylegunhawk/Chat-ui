<script lang="ts">
	import type { ChatFileChunk } from "$lib/rag/client";
	import CarbonDocument from "~icons/carbon/document";
	import CarbonCode from "~icons/carbon/code";
	import CarbonChevronDown from "~icons/carbon/chevron-down";
	import CarbonChevronUp from "~icons/carbon/chevron-up";
	import { slide } from "svelte/transition";

	interface Props {
		chunks: ChatFileChunk[];
	}

	let { chunks }: Props = $props();

	let expanded = $state(false);

	function getRelevanceColor(score: number) {
		if (score > 0.8) return "text-green-600 bg-green-50 dark:bg-green-900/20 dark:text-green-400";
		if (score > 0.5) return "text-yellow-600 bg-yellow-50 dark:bg-yellow-900/20 dark:text-yellow-400";
		return "text-gray-600 bg-gray-50 dark:bg-gray-800 dark:text-gray-400";
	}

	function truncateFilename(name: string) {
		const parts = name.split("/");
		return parts[parts.length - 1];
	}
</script>

<div class="my-4 flex flex-col gap-2 rounded-xl border border-gray-200 bg-gray-50/50 p-3 dark:border-gray-800 dark:bg-gray-900/30">
	<button 
		class="flex w-full items-center justify-between text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-black dark:hover:text-white transition-colors"
		onclick={() => expanded = !expanded}
	>
		<div class="flex items-center gap-2">
			<CarbonCode class="size-4" />
			<span>Used {chunks.length} codebase references</span>
		</div>
		
		{#if expanded}
			<CarbonChevronUp class="size-4" />
		{:else}
			<CarbonChevronDown class="size-4" />
		{/if}
	</button>

	{#if expanded}
		<div class="mt-2 grid gap-2 sm:grid-cols-2" transition:slide>
			{#each chunks as chunk}
				<div class="flex flex-col gap-1 rounded-lg border border-gray-200 bg-white p-2 text-xs shadow-sm dark:border-gray-700 dark:bg-gray-800">
					<div class="flex items-center justify-between">
						<div class="flex items-center gap-1.5 min-w-0">
							<CarbonDocument class="size-3.5 flex-none text-gray-400" />
							<span class="truncate font-medium text-gray-700 dark:text-gray-300" title={chunk.filename}>
								{truncateFilename(chunk.filename)}
							</span>
						</div>
						<span class={`px-1.5 py-0.5 rounded text-[10px] font-medium ${getRelevanceColor(chunk.similarity)}`}>
							{(chunk.similarity * 100).toFixed(0)}%
						</span>
					</div>
					
					{#if chunk.pageNumber}
						<div class="text-[10px] text-gray-400">Line {chunk.pageNumber}</div>
					{/if}
					
					<!-- Snippet Preview -->
					<div class="mt-1 max-h-20 overflow-hidden text-[10px] font-mono text-gray-500 dark:text-gray-400 opacity-80">
						{chunk.text.slice(0, 150)}...
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
