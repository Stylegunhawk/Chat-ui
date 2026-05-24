<script lang="ts">
	import Modal from "../Modal.svelte";
	import CarbonClose from "~icons/carbon/close";
	import CarbonDownload from "~icons/carbon/download";
	import { TOOL_EVENTS, dispatchCopyOutput } from "$lib/events/toolEvents";

	interface Props {
		title?: string;
		data: unknown;
		onclose: () => void;
	}

	let { title = "Tool Output", data, onclose }: Props = $props();

	let containerEl: HTMLElement | undefined = $state();

	const isArray = $derived(Array.isArray(data));
	const rows = $derived(isArray ? (data as unknown[]) : []);
	const isObject = $derived(data !== null && typeof data === "object" && !isArray);

	function downloadJson() {
		const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `${title.toLowerCase().replace(/\s+/g, "_")}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}

	function copyToClipboard() {
		if (containerEl) {
			dispatchCopyOutput(containerEl, {
				toolName: "artifact_viewer",
				content: JSON.stringify(data, null, 2),
				contentType: "json",
			});
		}
	}
</script>

<Modal width="max-w-4xl" {onclose}>
	<div class="flex h-[80dvh] flex-col" bind:this={containerEl}>
		<!-- Header -->
		<div
			class="flex items-center justify-between border-b border-gray-100 px-6 py-4 dark:border-gray-700"
		>
			<h3 class="text-lg font-semibold text-gray-800 dark:text-gray-100">{title}</h3>
			<div class="flex items-center gap-2">
				<button
					onclick={copyToClipboard}
					class="flex h-8 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
				>
					Copy JSON
				</button>
				<button
					onclick={downloadJson}
					class="flex h-8 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
				>
					<CarbonDownload class="size-3.5" />
					Download
				</button>
				<button
					onclick={onclose}
					class="ml-2 rounded-full p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-200"
				>
					<CarbonClose class="size-6" />
				</button>
			</div>
		</div>

		<!-- Content -->
		<div class="scrollbar-custom flex-1 overflow-auto p-6">
			{#if isArray && rows.length > 0}
				<div class="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
					<table class="w-full text-left text-sm text-gray-500 dark:text-gray-400">
						<thead
							class="bg-gray-50 text-xs uppercase text-gray-700 dark:bg-gray-800/50 dark:text-gray-300"
						>
							<tr>
								{#each Object.keys(rows[0] as object) as key}
									<th class="px-4 py-3 font-semibold">{key}</th>
								{/each}
							</tr>
						</thead>
						<tbody class="divide-y divide-gray-200 dark:divide-gray-700">
							{#each rows as row}
								<tr class="bg-white hover:bg-gray-50 dark:bg-gray-900 dark:hover:bg-gray-800/50">
									{#each Object.values(row as object) as value}
										<td class="whitespace-nowrap px-4 py-3 font-mono text-xs">
											{typeof value === "object" ? JSON.stringify(value) : value}
										</td>
									{/each}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else}
				<div
					class="rounded-lg border border-gray-200 bg-gray-50 p-4 font-mono text-xs dark:border-gray-700 dark:bg-gray-900/50"
				>
					<pre class="whitespace-pre-wrap text-gray-700 dark:text-gray-300">{JSON.stringify(
							data,
							null,
							2
						)}</pre>
				</div>
			{/if}
		</div>
	</div>
</Modal>
