<script lang="ts">
	import type { ChatFileChunk } from "$lib/rag/client";
	import CarbonDocument from "~icons/carbon/document";
	import CarbonCode from "~icons/carbon/code";
	import CarbonDocumentPdf from "~icons/carbon/document-pdf";
	import CarbonChevronDown from "~icons/carbon/chevron-down";
	import CarbonChevronUp from "~icons/carbon/chevron-up";
	import { slide } from "svelte/transition";

	interface Props {
		chunks: ChatFileChunk[];
	}

	let { chunks }: Props = $props();

	// De-duplicate by fileId for the header pills
	const uniqueFiles = $derived(
		[...new Map(chunks.map((c) => [c.fileId, { filename: c.filename, fileType: c.fileType }])).values()]
	);

	const entryChunks = $derived(chunks.filter((c) => c.role === "entry"));
	const dependencyChunks = $derived(chunks.filter((c) => c.role === "dependency"));
	const supportingChunks = $derived(chunks.filter((c) => c.role === "supporting"));

	let expanded = $state(false);
	let activeTab = $state<"entry" | "dependency" | "supporting" | "all">("entry");

	const activeChunks = $derived(
		activeTab === "all"
			? chunks
			: activeTab === "entry"
				? entryChunks
				: activeTab === "dependency"
					? dependencyChunks
					: supportingChunks
	);

	function scoreStyle(s: number) {
		if (s >= 0.8) return { bar: "bg-emerald-500", label: "text-emerald-600 dark:text-emerald-400" };
		if (s >= 0.6) return { bar: "bg-blue-500", label: "text-blue-600 dark:text-blue-400" };
		if (s >= 0.45) return { bar: "bg-amber-500", label: "text-amber-600 dark:text-amber-400" };
		return { bar: "bg-gray-400", label: "text-gray-500 dark:text-gray-400" };
	}

	function fileIcon(filename: string) {
		const ext = filename.split(".").pop()?.toLowerCase() ?? "";
		if (ext === "pdf") return CarbonDocumentPdf;
		if (["py", "js", "ts", "tsx", "jsx", "go", "rs", "java", "cs", "cpp"].includes(ext))
			return CarbonCode;
		return CarbonDocument;
	}

	function shortFilename(name: string) {
		return name.split(/[/\\]/).at(-1) ?? name;
	}

	function truncate(str: string, n: number) {
		return str.length > n ? str.slice(0, n) + "…" : str;
	}

	const roleLabel: Record<string, string> = {
		entry: "Primary",
		dependency: "Related",
		supporting: "Context",
	};

	const roleBadge: Record<string, string> = {
		entry: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
		dependency: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
		supporting: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
	};

	const tabs = ["entry", "dependency", "supporting", "all"] as const;
	type Tab = (typeof tabs)[number];

	function tabCount(tab: Tab) {
		if (tab === "all") return chunks.length;
		if (tab === "entry") return entryChunks.length;
		if (tab === "dependency") return dependencyChunks.length;
		return supportingChunks.length;
	}
</script>

<div class="mt-3 overflow-hidden rounded-xl border border-gray-200/80 bg-white/60 shadow-sm backdrop-blur-sm dark:border-gray-700/60 dark:bg-gray-900/40">
	<!-- Header button -->
	<button
		class="flex w-full items-center justify-between px-3 py-2.5 text-left transition-colors hover:bg-gray-50/80 dark:hover:bg-gray-800/40"
		onclick={() => (expanded = !expanded)}
	>
		<div class="flex flex-wrap items-center gap-2">
			<!-- Source file pills -->
			{#each uniqueFiles.slice(0, 3) as file}
				{@const Icon = fileIcon(file.filename)}
				<span class="flex items-center gap-1 rounded-md border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-medium text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
					<Icon class="size-3 flex-none" />
					{shortFilename(file.filename)}
				</span>
			{/each}
			{#if uniqueFiles.length > 3}
				<span class="rounded-md bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">
					+{uniqueFiles.length - 3} more
				</span>
			{/if}

			<span class="text-xs text-gray-400 dark:text-gray-500">
				{chunks.length} chunk{chunks.length !== 1 ? "s" : ""}
			</span>
		</div>

		<div class="flex flex-none items-center gap-1 text-gray-400">
			<span class="text-[11px]">Sources</span>
			{#if expanded}
				<CarbonChevronUp class="size-3.5" />
			{:else}
				<CarbonChevronDown class="size-3.5" />
			{/if}
		</div>
	</button>

	{#if expanded}
		<div transition:slide={{ duration: 180 }}>
			<!-- Role tabs -->
			<div class="flex border-t border-gray-100 dark:border-gray-800">
				{#each tabs as tab}
					{@const count = tabCount(tab)}
					{#if count > 0 || tab === "all"}
						<button
							class="flex-1 border-b-2 px-2 py-1.5 text-[11px] font-medium transition-colors {activeTab === tab
								? 'border-gray-700 bg-gray-50 dark:border-gray-300 dark:bg-gray-800/40'
								: 'border-transparent text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300'}"
							onclick={() => (activeTab = tab)}
						>
							{tab === "all" ? "All" : roleLabel[tab]}
							<span class="ml-0.5 opacity-60">({count})</span>
						</button>
					{/if}
				{/each}
			</div>

			<!-- Chunk rows -->
			<div class="max-h-72 divide-y divide-gray-100 overflow-y-auto dark:divide-gray-800">
				{#each activeChunks as chunk (chunk.id)}
					{@const style = scoreStyle(chunk.similarity ?? 1)}
					{@const Icon = fileIcon(chunk.filename)}
					{@const pct = (chunk.similarity * 100).toFixed(0)}
					<div class="flex flex-col gap-1.5 px-3 py-2.5">
						<!-- File name + role badge -->
						<div class="flex items-center justify-between gap-2">
							<div class="flex min-w-0 items-center gap-1.5">
								<Icon class="size-3.5 flex-none text-gray-400" />
								<span class="truncate text-[11px] font-medium text-gray-700 dark:text-gray-300" title={chunk.filename}>
									{shortFilename(chunk.filename)}
								</span>
								{#if chunk.pageNumber}
									<span class="text-[10px] text-gray-400">· Line {chunk.pageNumber}</span>
								{/if}
							</div>
							<span class="flex-none rounded px-1.5 py-0.5 text-[10px] font-medium {roleBadge[chunk.role]}">
								{roleLabel[chunk.role]}
							</span>
						</div>

						<!-- Relevance bar -->
						<div class="flex items-center gap-2">
							<div class="h-1 flex-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
								<div class="h-full rounded-full transition-all {style.bar}" style="width:{pct}%"></div>
							</div>
							<span class="w-7 text-right text-[10px] font-medium {style.label}">{pct}%</span>
						</div>

						<!-- Text preview -->
						<p class="mt-0.5 font-mono text-[10px] leading-relaxed text-gray-500 dark:text-gray-400">
							{truncate(chunk.text.trim(), 160)}
						</p>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
