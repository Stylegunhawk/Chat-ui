<script lang="ts">
	import type { MessageToolResultUpdate } from "$lib/types/MessageUpdate";
	import { ToolResultStatus } from "$lib/types/Tool";
	import Modal from "../../Modal.svelte";
	import CopyToClipBoardBtn from "../../CopyToClipBoardBtn.svelte";
	import CarbonTable from "~icons/carbon/table";
	import CarbonDownload from "~icons/carbon/download";
	import CarbonMaximize from "~icons/carbon/maximize";
	import CarbonChartCombo from "~icons/carbon/chart-combo";
	import CarbonClose from "~icons/carbon/close";
	import { browser } from "$app/environment";

	interface Props {
		update: MessageToolResultUpdate;
		parseToolOutputs: (outputs: unknown[]) => unknown[];
		formatValue: (value: unknown) => string;
	}

	type DataRow = Record<string, unknown>;
	type GeneratedDataset = {
		entities: string[];
		data: Record<string, DataRow[]>;
		metadata?: Record<string, unknown>;
	};

	let { update, parseToolOutputs, formatValue }: Props = $props();

	const isRecord = (value: unknown): value is Record<string, unknown> =>
		typeof value === "object" && value !== null && !Array.isArray(value);

	const toRows = (value: unknown): DataRow[] =>
		Array.isArray(value) ? value.filter(isRecord) : [];

	function normalizeDataset(value: unknown): GeneratedDataset | null {
		if (!isRecord(value)) return null;

		const nested = isRecord(value.data) && Array.isArray(value.data.entities) ? value.data : value;
		if (!Array.isArray(nested.entities) || !isRecord(nested.data)) return null;

		const entities = nested.entities.filter(
			(entity): entity is string => typeof entity === "string"
		);
		if (!entities.length) return null;

		const data = Object.fromEntries(
			entities.map((entity) => [entity, toRows((nested.data as Record<string, unknown>)[entity])])
		);

		const metadata = isRecord(nested.metadata) ? nested.metadata : undefined;
		return { entities, data, metadata };
	}

	function tryParseJson(text: string): unknown {
		try {
			return JSON.parse(text);
		} catch {
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

	const toolOutput = $derived.by(() => {
		if (update.result.status !== ToolResultStatus.Success) return null;

		for (const output of update.result.outputs) {
			const fromData = normalizeDataset(output.data);
			if (fromData) return fromData;

			if (typeof output.text === "string") {
				const parsed = normalizeDataset(tryParseJson(output.text));
				if (parsed) return parsed;
			}
		}
		return null;
	});

	let entities = $derived(toolOutput?.entities ?? []);
	let activeEntity = $state("");
	let isModalOpen = $state(false);

	$effect(() => {
		if (entities.length > 0 && (!activeEntity || !entities.includes(activeEntity))) {
			activeEntity = entities[0];
		}
	});

	let currentRows = $derived(toolOutput?.data[activeEntity] ?? []);
	let columns = $derived.by(() => (currentRows.length === 0 ? [] : Object.keys(currentRows[0])));
	let totalRows = $derived(
		entities.reduce((sum, entity) => sum + (toolOutput?.data[entity]?.length ?? 0), 0)
	);
	let totalColumns = $derived(
		new Set(entities.flatMap((entity) => Object.keys(toolOutput?.data[entity]?.[0] ?? {}))).size
	);
	let activeEntityLabel = $derived(activeEntity || "dataset");
	let resultOutputs = $derived(
		update.result.status === ToolResultStatus.Success ? update.result.outputs : []
	);

	let semanticSummary = $derived.by(() => {
		const summary = toolOutput?.metadata?.semantic_analysis_summary;
		if (!summary) return null;
		if (isRecord(summary)) {
			const avgConfidence =
				typeof summary.avg_confidence === "number"
					? `${Math.round(summary.avg_confidence * 100)}% confidence`
					: undefined;
			const totalFields =
				typeof summary.total_fields === "number" ? `${summary.total_fields} fields` : undefined;
			const label = [avgConfidence, totalFields].filter(Boolean).join(" · ");
			return {
				label,
				body:
					typeof summary.summary === "string" && summary.summary.trim()
						? summary.summary
						: formatValue(summary),
			};
		}
		return { label: "", body: String(summary) };
	});

	let performanceLabel = $derived.by(() => {
		const performance = toolOutput?.metadata?.performance;
		return typeof performance === "string" && performance.trim() ? performance : null;
	});

	const cellText = (value: unknown): string => {
		if (value == null) return "";
		if (typeof value === "object") return formatValue(value);
		return String(value);
	};

	const getColumnKind = (column: string): "description" | "date" | "id" | "default" => {
		const normalized = column.toLowerCase();
		if (normalized.includes("description") || normalized.includes("summary")) return "description";
		if (normalized.includes("date")) return "date";
		if (normalized === "id" || normalized.endsWith("_id")) return "id";
		return "default";
	};

	const fullscreenHeaderClass = (column: string): string => {
		const kind = getColumnKind(column);
		if (kind === "description") return "min-w-[28rem] max-w-[40rem] whitespace-normal";
		if (kind === "date") return "min-w-36 whitespace-nowrap";
		if (kind === "id") return "min-w-72 whitespace-nowrap";
		return "min-w-44 whitespace-nowrap";
	};

	const fullscreenCellClass = (column: string): string => {
		const kind = getColumnKind(column);
		if (kind === "description") {
			return "min-w-[28rem] max-w-[40rem] whitespace-normal break-words leading-relaxed";
		}
		if (kind === "date") return "min-w-36 whitespace-nowrap";
		if (kind === "id") return "min-w-72 whitespace-nowrap font-mono text-xs";
		return "min-w-44 whitespace-nowrap";
	};

	function downloadCSV() {
		if (!browser || !currentRows.length) return;
		const headers = columns.join(",");
		const csvRows = currentRows.map((row) =>
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
		link.setAttribute("download", `${activeEntityLabel}_data.csv`);
		link.style.visibility = "hidden";
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
		URL.revokeObjectURL(url);
	}

	function downloadJSON() {
		if (!browser || !toolOutput) return;
		const blob = new Blob([JSON.stringify(toolOutput, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.setAttribute("href", url);
		link.setAttribute("download", "generated_data.json");
		link.style.visibility = "hidden";
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
		URL.revokeObjectURL(url);
	}
</script>

{#if toolOutput}
	<div
		class="overflow-hidden rounded-lg border border-purple-100 bg-white shadow-sm dark:border-purple-500/20 dark:bg-gray-900/40"
	>
		<div
			class="flex flex-col gap-3 border-b border-gray-100 bg-gray-50/70 p-3 dark:border-gray-800 dark:bg-gray-900/70"
		>
			<div class="flex flex-wrap items-start justify-between gap-3">
				<div class="flex min-w-0 items-start gap-2.5">
					<div
						class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-emerald-100 text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-300"
					>
						<CarbonTable class="size-4" />
					</div>
					<div class="min-w-0">
						<div class="text-sm font-semibold text-gray-800 dark:text-gray-100">
							Generated dataset
						</div>
						<div class="mt-0.5 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-gray-500">
							<span>{entities.length} {entities.length === 1 ? "entity" : "entities"}</span>
							<span>{totalRows.toLocaleString()} rows</span>
							<span>{totalColumns} columns</span>
							{#if semanticSummary?.label}
								<span>{semanticSummary.label}</span>
							{:else if performanceLabel}
								<span>{performanceLabel}</span>
							{/if}
						</div>
					</div>
				</div>

				<div class="flex flex-wrap items-center gap-1.5">
					<button
						type="button"
						onclick={downloadCSV}
						disabled={!currentRows.length}
						class="flex h-8 items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 text-[11px] font-medium text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
						title="Download active entity as CSV"
					>
						<CarbonDownload class="size-3.5" />
						CSV
					</button>
					<button
						type="button"
						onclick={downloadJSON}
						class="flex h-8 items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 text-[11px] font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
						title="Download full dataset as JSON"
					>
						<CarbonDownload class="size-3.5" />
						JSON
					</button>
					<button
						type="button"
						onclick={() => (isModalOpen = true)}
						class="flex h-8 items-center gap-1.5 rounded-md bg-purple-600 px-2.5 text-[11px] font-semibold text-white hover:bg-purple-700 dark:bg-purple-500 dark:hover:bg-purple-400"
					>
						<CarbonMaximize class="size-3.5" />
						Open
					</button>
				</div>
			</div>

			{#if entities.length > 1}
				<div class="scrollbar-custom flex gap-1 overflow-x-auto">
					{#each entities as entity}
						<button
							type="button"
							onclick={() => (activeEntity = entity)}
							class="flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors {activeEntity ===
							entity
								? 'bg-white text-purple-700 shadow-sm ring-1 ring-purple-100 dark:bg-gray-800 dark:text-purple-300 dark:ring-purple-500/20'
								: 'text-gray-500 hover:bg-white/70 dark:text-gray-400 dark:hover:bg-gray-800/70'}"
						>
							<span>{entity}</span>
							<span class="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] dark:bg-gray-700">
								{(toolOutput.data[entity]?.length ?? 0).toLocaleString()}
							</span>
						</button>
					{/each}
				</div>
			{/if}
		</div>

		<div class="p-3">
			<div class="mb-2 flex items-center justify-between gap-2">
				<div class="text-xs font-semibold text-gray-700 dark:text-gray-300">
					{activeEntityLabel}
					<span class="font-normal text-gray-400">
						· {currentRows.length.toLocaleString()} rows · {columns.length} columns
					</span>
				</div>
				{#if currentRows.length > 10}
					<div class="text-[10px] text-gray-400">Previewing first 10 rows</div>
				{/if}
			</div>

			<div
				class="scrollbar-custom relative max-h-80 overflow-auto rounded-lg border border-gray-100 bg-white dark:border-gray-700 dark:bg-gray-800/50"
			>
				{#if currentRows.length && columns.length}
					<table class="w-full text-left text-[11px] text-gray-600 dark:text-gray-400">
						<thead
							class="sticky top-0 z-10 bg-gray-50 font-semibold text-gray-700 dark:bg-gray-800 dark:text-gray-300"
						>
							<tr>
								<th
									class="w-10 whitespace-nowrap border-b border-gray-100 px-3 py-2 dark:border-gray-700"
								>
									#
								</th>
								{#each columns as column}
									<th
										class="whitespace-nowrap border-b border-gray-100 px-3 py-2 dark:border-gray-700"
									>
										{column}
									</th>
								{/each}
							</tr>
						</thead>
						<tbody class="divide-y divide-gray-50 dark:divide-gray-800">
							{#each currentRows.slice(0, 10) as row, rowIndex}
								<tr class="hover:bg-gray-50/70 dark:hover:bg-gray-800/40">
									<td class="px-3 py-2 font-mono text-[10px] text-gray-400">{rowIndex + 1}</td>
									{#each columns as column}
										<td
											class="max-w-64 truncate whitespace-nowrap px-3 py-2"
											title={cellText(row[column])}
										>
											{cellText(row[column])}
										</td>
									{/each}
								</tr>
							{/each}
							{#if currentRows.length > 10}
								<tr>
									<td
										colspan={columns.length + 1}
										class="bg-gray-50/50 px-3 py-2 text-center text-[10px] text-gray-400 dark:bg-gray-800/30"
									>
										+ {(currentRows.length - 10).toLocaleString()} more rows available in full view
									</td>
								</tr>
							{/if}
						</tbody>
					</table>
				{:else}
					<div class="px-3 py-8 text-center text-xs text-gray-400">No rows available.</div>
				{/if}
			</div>

			{#if semanticSummary}
				<div
					class="mt-3 rounded-lg border border-emerald-100 bg-emerald-50/60 p-3 text-[11px] text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-900/10 dark:text-emerald-300"
				>
					<div class="mb-1 flex items-center gap-1.5 font-semibold">
						<CarbonChartCombo class="size-3.5" />
						Semantic analysis
						{#if semanticSummary.label}
							<span class="font-normal opacity-70">· {semanticSummary.label}</span>
						{/if}
					</div>
					<p class="leading-relaxed opacity-90">{semanticSummary.body}</p>
				</div>
			{/if}
		</div>
	</div>
{:else}
	<div
		class="scrollbar-custom rounded-md border border-gray-100 bg-white p-2 text-gray-500 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-400"
	>
		{#each parseToolOutputs(resultOutputs) as parsedOutput}
			{@const po = parsedOutput as Record<string, unknown>}
			<div class="space-y-2">
				{#if typeof po.text === "string"}
					<pre
						class="scrollbar-custom max-h-60 overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs">{po.text}</pre>
				{/if}

				{#if Array.isArray(po.images) && po.images.length > 0}
					<div class="flex flex-wrap gap-2">
						{#each po.images as image, imageIndex}
							{#if isRecord(image) && typeof image.mimeType === "string" && typeof image.data === "string"}
								<img
									alt={`Tool result image ${imageIndex + 1}`}
									class="max-h-60 cursor-pointer rounded border border-gray-200 dark:border-gray-700"
									src={`data:${image.mimeType};base64,${image.data}`}
								/>
							{/if}
						{/each}
					</div>
				{/if}

				{#if Array.isArray(po.metadata) && po.metadata.length > 0}
					<pre class="whitespace-pre-wrap break-all font-mono text-xs">{formatValue(
							Object.fromEntries(po.metadata as Iterable<[PropertyKey, unknown]>)
						)}</pre>
				{/if}
			</div>
		{/each}
	</div>
{/if}

{#if isModalOpen}
	<Modal width="w-[96dvw] max-w-7xl" onclose={() => (isModalOpen = false)}>
		<div class="flex h-[90dvh] min-h-0 flex-col overflow-hidden">
			<div
				class="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-gray-100 bg-white px-5 py-4 pr-4 dark:border-gray-700 dark:bg-gray-800"
			>
				<div class="min-w-0">
					<div class="flex items-center gap-2">
						<div
							class="flex h-8 w-8 items-center justify-center rounded-md bg-purple-100 text-purple-600 dark:bg-purple-900/40 dark:text-purple-300"
						>
							<CarbonTable class="size-4" />
						</div>
						<div>
							<h3 class="text-lg font-bold leading-tight text-gray-900 dark:text-gray-100">
								Browse dataset
							</h3>
							<p class="text-xs text-gray-500">
								{activeEntityLabel}: {currentRows.length.toLocaleString()} rows · {columns.length}
								columns
							</p>
						</div>
					</div>
				</div>

				<div class="flex flex-wrap items-center justify-end gap-2">
					<button
						type="button"
						onclick={downloadCSV}
						disabled={!currentRows.length}
						class="flex h-9 items-center gap-2 rounded-md bg-gray-100 px-3 text-sm font-medium text-gray-700 hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
					>
						<CarbonDownload class="size-4" />
						Download CSV
					</button>
					<CopyToClipBoardBtn
						value={JSON.stringify(currentRows, null, 2)}
						classNames="flex h-9 items-center gap-2 rounded-md bg-purple-600 px-3 text-sm font-medium text-white hover:bg-purple-700"
					>
						Copy JSON
					</CopyToClipBoardBtn>
					<button
						type="button"
						onclick={() => (isModalOpen = false)}
						class="flex h-9 w-9 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white"
						aria-label="Close dataset browser"
					>
						<CarbonClose class="size-5" />
					</button>
				</div>
			</div>

			<div class="flex min-h-0 flex-1 flex-col gap-3 bg-gray-50/60 p-4 dark:bg-gray-900/40">
				{#if entities.length > 1}
					<div
						class="scrollbar-custom flex shrink-0 gap-1 overflow-x-auto rounded-lg bg-gray-100 p-1 dark:bg-gray-900"
					>
						{#each entities as entity}
							<button
								type="button"
								onclick={() => (activeEntity = entity)}
								class="flex shrink-0 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-all {activeEntity ===
								entity
									? 'bg-white text-gray-900 shadow-sm dark:bg-gray-800 dark:text-white'
									: 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}"
							>
								{entity}
								<span class="rounded bg-gray-100 px-1.5 py-0.5 text-xs dark:bg-gray-700">
									{(toolOutput?.data[entity]?.length ?? 0).toLocaleString()}
								</span>
							</button>
						{/each}
					</div>
				{/if}

				<div
					class="scrollbar-custom min-h-0 flex-1 overflow-auto rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800"
				>
					{#if currentRows.length && columns.length}
						<table class="min-w-full table-auto text-left text-sm text-gray-600 dark:text-gray-400">
							<thead
								class="sticky top-0 z-10 bg-gray-50 font-semibold text-gray-700 dark:bg-gray-800 dark:text-gray-200"
							>
								<tr>
									<th class="w-14 border-b border-gray-200 px-4 py-3 dark:border-gray-700"> # </th>
									{#each columns as column}
										<th
											class="border-b border-gray-200 px-4 py-3 dark:border-gray-700 {fullscreenHeaderClass(
												column
											)}"
										>
											{column}
										</th>
									{/each}
								</tr>
							</thead>
							<tbody class="divide-y divide-gray-100 dark:divide-gray-800">
								{#each currentRows as row, i}
									<tr class="hover:bg-gray-50/70 dark:hover:bg-gray-800/50">
										<td class="px-4 py-2.5 font-mono text-xs text-gray-400">{i + 1}</td>
										{#each columns as column}
											<td
												class="px-4 py-2.5 {fullscreenCellClass(column)}"
												title={cellText(row[column])}
											>
												{cellText(row[column])}
											</td>
										{/each}
									</tr>
								{/each}
							</tbody>
						</table>
					{:else}
						<div class="flex h-full items-center justify-center p-8 text-sm text-gray-400">
							No rows available for this entity.
						</div>
					{/if}
				</div>
			</div>
		</div>
	</Modal>
{/if}
