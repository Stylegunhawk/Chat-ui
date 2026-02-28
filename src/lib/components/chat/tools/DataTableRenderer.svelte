<script lang="ts">
	import type { MessageToolResultUpdate } from "$lib/types/MessageUpdate";
	import { ToolResultStatus } from "$lib/types/Tool";
	import Modal from "../../Modal.svelte";
	import CopyToClipBoardBtn from "../../CopyToClipBoardBtn.svelte";
	import CarbonTable from "~icons/carbon/table";
	import CarbonDownload from "~icons/carbon/download";
	import CarbonMaximize from "~icons/carbon/maximize";
	import CarbonChartCombo from "~icons/carbon/chart-combo";
	import { browser } from "$app/environment";

	interface Props {
		update: MessageToolResultUpdate;
		parseToolOutputs: (outputs: unknown[]) => unknown[];
		formatValue: (value: unknown) => string;
	}

	let { update, parseToolOutputs, formatValue }: Props = $props();

	function tryParseJson(text: string) {
		try {
			// Try full string first
			return JSON.parse(text);
		} catch {
			// Find first '{' and last '}'
			const start = text.indexOf("{");
			const end = text.lastIndexOf("}");
			if (start !== -1 && end !== -1 && end > start) {
				try {
					return JSON.parse(text.substring(start, end + 1));
				} catch {
					return null;
				}
			}
		}
		return null;
	}

	// Parse tool output
	const toolOutput = $derived.by(() => {
		if (update.result.status !== ToolResultStatus.Success) return null;

		for (const output of update.result.outputs) {
			const data = output.data as any;
			// If already structured and has expected fields
			if (data?.entities && data?.data) return data;
			if (data?.success && data?.data?.entities) return data.data;

			// If text output, try parsing
			if (typeof output.text === "string") {
				const parsed = tryParseJson(output.text) as any;
				if (parsed) {
					// Handle nesting: { success: true, data: { entities: [], data: {} } }
					if (parsed.success && parsed.data?.entities) return parsed.data;
					// Handle direct: { entities: [], data: {} }
					if (parsed.entities && parsed.data) return parsed;
				}
			}
		}
		return null;
	});

	let entities = $derived(toolOutput?.entities ?? []);
	let activeEntity = $state("");
	let isModalOpen = $state(false);

	// Sync activeEntity when toolOutput changes
	$effect(() => {
		if (entities.length > 0 && !activeEntity) {
			activeEntity = entities[0];
		}
	});

	let currentRows = $derived((toolOutput?.data as any)?.[activeEntity] ?? []);
	let columns = $derived.by(() => {
		if (currentRows.length === 0) return [];
		return Object.keys(currentRows[0]);
	});

	function downloadCSV() {
		if (!browser || !currentRows.length) return;
		const headers = columns.join(",");
		const csvRows = currentRows.map((row: Record<string, unknown>) =>
			columns
				.map((col) => {
					const val = row[col];
					if (val == null) return "";
					const str = String(val).replace(/"/g, '""');
					return str.includes(",") || str.includes('"') || str.includes("\n") ? `"${str}"` : str;
				})
				.join(",")
		);
		const csvContent = [headers, ...csvRows].join("\n");
		const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.setAttribute("href", url);
		link.setAttribute("download", `${activeEntity}_data.csv`);
		link.style.visibility = "hidden";
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
	}

	function downloadJSON() {
		if (!browser || !toolOutput) return;
		const blob = new Blob([JSON.stringify(toolOutput, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.setAttribute("href", url);
		link.setAttribute("download", `generated_data.json`);
		link.style.visibility = "hidden";
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
	}
</script>

{#if toolOutput}
	<div class="flex flex-col gap-3">
		<!-- Header with Metadata -->
		<div
			class="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 pb-2 dark:border-gray-700"
		>
			<div class="flex items-center gap-2">
				<div
					class="flex h-6 w-6 items-center justify-center rounded bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400"
				>
					<CarbonTable class="size-4" />
				</div>
				<span class="text-xs font-semibold text-gray-700 dark:text-gray-300">Generated Dataset</span
				>
				{#if (toolOutput as any).metadata?.semantic_analysis_summary}
					{@const summary = (toolOutput as any).metadata.semantic_analysis_summary}
					<span
						class="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400"
					>
						{#if typeof summary === "object" && summary !== null}
							Avg confidence: {(summary.avg_confidence * 100).toFixed(0)}% ·
							{summary.total_fields} fields analyzed
						{:else}
							{summary}
						{/if}
					</span>
				{:else if (toolOutput as any).metadata?.performance}
					<span
						class="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400"
					>
						{(toolOutput as any).metadata.performance}
					</span>
				{/if}
			</div>

			<div class="flex items-center gap-2">
				<button
					type="button"
					onclick={downloadCSV}
					class="flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
					title="Download CSV"
				>
					<CarbonDownload class="size-3" />
					CSV
				</button>
				<button
					type="button"
					onclick={downloadJSON}
					class="flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
					title="Download JSON"
				>
					<CarbonDownload class="size-3" />
					JSON
				</button>
				<button
					type="button"
					onclick={() => (isModalOpen = true)}
					class="flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-purple-600 hover:bg-purple-50 dark:text-purple-400 dark:hover:bg-purple-900/20"
				>
					<CarbonMaximize class="size-3" />
					Fullscreen
				</button>
			</div>
		</div>

		<!-- Entity Tabs -->
		{#if entities.length > 1}
			<div class="flex flex-wrap gap-1 border-b border-gray-50 pb-1 dark:border-gray-800">
				{#each entities as entity}
					<button
						type="button"
						onclick={() => (activeEntity = entity)}
						class="rounded-md px-3 py-1 text-xs font-medium transition-colors {activeEntity ===
						entity
							? 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300'
							: 'text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800'}"
					>
						{entity}
						<span class="ml-1 opacity-50">({(toolOutput.data as any)[entity]?.length ?? 0})</span>
					</button>
				{/each}
			</div>
		{/if}

		<!-- Table Preview -->
		<div
			class="scrollbar-custom relative max-h-80 overflow-auto rounded-lg border border-gray-100 bg-white dark:border-gray-700 dark:bg-gray-800/50"
		>
			<table class="w-full text-left text-[11px] text-gray-600 dark:text-gray-400">
				<thead
					class="sticky top-0 z-10 bg-gray-50 font-semibold text-gray-700 dark:bg-gray-800 dark:text-gray-300"
				>
					<tr>
						{#each columns as column}
							<th class="whitespace-nowrap border-b border-gray-100 px-3 py-2 dark:border-gray-700">
								{column}
							</th>
						{/each}
					</tr>
				</thead>
				<tbody class="divide-y divide-gray-50 dark:divide-gray-800">
					{#each currentRows.slice(0, 10) as row}
						<tr class="hover:bg-gray-50/50 dark:hover:bg-gray-800/30">
							{#each columns as column}
								<td class="whitespace-nowrap px-3 py-2">
									{row[column]?.toString() ?? ""}
								</td>
							{/each}
						</tr>
					{/each}
					{#if currentRows.length > 10}
						<tr>
							<td
								colspan={columns.length}
								class="bg-gray-50/30 px-3 py-2 text-center text-[10px] italic text-gray-400 dark:bg-gray-800/20"
							>
								+ {currentRows.length - 10} more rows (view in fullscreen)
							</td>
						</tr>
					{/if}
				</tbody>
			</table>
		</div>

		<!-- Field Analysis Summary -->
		{#if (toolOutput as any).metadata?.semantic_analysis_summary}
			<div
				class="rounded-lg bg-emerald-50/50 p-3 text-[11px] text-emerald-800 dark:bg-emerald-900/10 dark:text-emerald-300"
			>
				<div class="mb-1 flex items-center gap-1.5 font-semibold">
					<CarbonChartCombo class="size-3" />
					Semantic Analysis
				</div>
				<p class="leading-relaxed opacity-90">
					{#if typeof (toolOutput as any).metadata.semantic_analysis_summary === "object"}
						{(toolOutput as any).metadata.semantic_analysis_summary.summary ||
							JSON.stringify((toolOutput as any).metadata.semantic_analysis_summary)}
					{:else}
						{(toolOutput as any).metadata.semantic_analysis_summary}
					{/if}
				</p>
			</div>
		{/if}
	</div>
{:else}
	<!-- Fallback to generic render if parsing failed -->
	<div
		class="scrollbar-custom rounded-md border border-gray-100 bg-white p-2 text-gray-500 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-400"
	>
		{#each parseToolOutputs((update.result as any).outputs) as parsedOutput}
			{@const po = parsedOutput as any}
			<div class="space-y-2">
				{#if po.text}
					<pre
						class="scrollbar-custom max-h-60 overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs">{po.text}</pre>
				{/if}

				{#if po.images && po.images.length > 0}
					<div class="flex flex-wrap gap-2">
						{#each po.images as image, imageIndex}
							<img
								alt={`Tool result image ${imageIndex + 1}`}
								class="max-h-60 cursor-pointer rounded border border-gray-200 dark:border-gray-700"
								src={`data:${image.mimeType};base64,${image.data}`}
							/>
						{/each}
					</div>
				{/if}

				{#if po.metadata && po.metadata.length > 0}
					<pre class="whitespace-pre-wrap break-all font-mono text-xs">{formatValue(
							Object.fromEntries(po.metadata)
						)}</pre>
				{/if}
			</div>
		{/each}
	</div>
{/if}

<!-- Fullscreen Modal -->
{#if isModalOpen}
	<Modal width="max-w-6xl" onclose={() => (isModalOpen = false)} closeButton>
		<div class="flex h-[90dvh] flex-col p-6">
			<div class="mb-6 flex items-center justify-between">
				<div>
					<h3 class="text-xl font-bold text-gray-800 dark:text-gray-100">Browse Dataset</h3>
					<p class="text-sm text-gray-500">{activeEntity}: {currentRows.length} total rows</p>
				</div>
				<div class="flex gap-2">
					<button
						type="button"
						onclick={downloadCSV}
						class="flex items-center gap-2 rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600"
					>
						<CarbonDownload class="size-4" />
						Download CSV
					</button>
					<CopyToClipBoardBtn
						value={JSON.stringify(currentRows, null, 2)}
						classNames="flex items-center gap-2 rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700"
					>
						Copy JSON
					</CopyToClipBoardBtn>
				</div>
			</div>

			<!-- Entity Switcher in Modal -->
			{#if entities.length > 1}
				<div class="mb-4 flex gap-1 rounded-lg bg-gray-100 p-1 dark:bg-gray-900">
					{#each entities as entity}
						<button
							type="button"
							onclick={() => (activeEntity = entity)}
							class="flex-1 rounded-md py-2 text-sm font-semibold transition-all {activeEntity ===
							entity
								? 'bg-white shadow-sm dark:bg-gray-800 dark:text-white'
								: 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}"
						>
							{entity}
						</button>
					{/each}
				</div>
			{/if}

			<div
				class="scrollbar-custom flex-1 overflow-auto rounded-xl border border-gray-200 dark:border-gray-700"
			>
				<table class="w-full text-left text-sm text-gray-600 dark:text-gray-400">
					<thead
						class="sticky top-0 z-10 bg-gray-50 font-semibold text-gray-700 dark:bg-gray-800 dark:text-gray-200"
					>
						<tr>
							<th class="w-12 border-b border-gray-200 px-4 py-3 dark:border-gray-700">#</th>
							{#each columns as column}
								<th
									class="whitespace-nowrap border-b border-gray-200 px-4 py-3 dark:border-gray-700"
								>
									{column}
								</th>
							{/each}
						</tr>
					</thead>
					<tbody class="divide-y divide-gray-100 dark:divide-gray-800">
						{#each currentRows as row, i}
							<tr class="hover:bg-gray-50/50 dark:hover:bg-gray-800/30">
								<td class="px-4 py-2.5 font-mono text-xs opacity-50">{i + 1}</td>
								{#each columns as column}
									<td class="whitespace-nowrap px-4 py-2.5">
										{row[column]?.toString() ?? ""}
									</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	</Modal>
{/if}
