<script lang="ts">
	import { artifactStore, TYPE_COLORS, TYPE_LABELS } from "$lib/stores/artifact.svelte";
	import ArtifactSandbox from "./ArtifactSandbox.svelte";
	import MarkdownRenderer from "./MarkdownRenderer.svelte";
	import CarbonClose from "~icons/carbon/close";
	import CarbonChevronLeft from "~icons/carbon/chevron-left";
	import CarbonChevronRight from "~icons/carbon/chevron-right";
	import CarbonMaximize from "~icons/carbon/maximize";
	import { browser } from "$app/environment";

	let errors = $state<{ message: string; stack?: string }[]>([]);
	let isFullscreen = $state(false);
	let viewMode = $state<"preview" | "code">("preview");

	let artifact = $derived(artifactStore.activeArtifact);
	let total = $derived(artifactStore.artifacts.length);
	let currentIndex = $derived(artifactStore.activeIndex + 1);

	function formatJson(content: string): string {
		try {
			return JSON.stringify(JSON.parse(content), null, 2);
		} catch {
			return content;
		}
	}

	function parseCsvRows(content: string): string[][] {
		return content
			.split("\n")
			.filter((l) => l.trim())
			.map((line) => line.split(",").map((cell) => cell.trim().replace(/^"(.*)"$/, "$1")));
	}

	function handleSandboxError(errs: { message: string; stack?: string }[]) {
		errors = errs;
	}

	$effect(() => {
		if (artifact) {
			errors = [];
			viewMode = "preview";
		}
	});
</script>

{#if artifact}
	<div
		class="flex h-full flex-col border-l border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900
		{isFullscreen ? 'fixed inset-0 z-50' : 'w-full'}"
	>
		<!-- Header -->
		<div
			class="flex shrink-0 items-center justify-between gap-2 border-b border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-800"
		>
			<div class="flex min-w-0 items-center gap-2">
				<span
					class="shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold text-white {TYPE_COLORS[
						artifact.type
					] ?? 'bg-gray-500'}"
				>
					{TYPE_LABELS[artifact.type] ?? artifact.type}
				</span>
				<span class="truncate text-sm font-medium text-gray-800 dark:text-gray-200">
					{artifact.title}
				</span>
			</div>

			<!-- Preview / Code toggle -->
			<div
				class="flex shrink-0 items-center gap-0.5 rounded-md border border-gray-200 bg-white p-0.5 dark:border-gray-700 dark:bg-gray-900"
			>
				<button
					class="rounded px-2.5 py-0.5 text-xs font-medium transition-colors {viewMode === 'preview'
						? 'bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-gray-100'
						: 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'}"
					onclick={() => (viewMode = "preview")}
				>
					Preview
				</button>
				<button
					class="rounded px-2.5 py-0.5 text-xs font-medium transition-colors {viewMode === 'code'
						? 'bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-gray-100'
						: 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'}"
					onclick={() => (viewMode = "code")}
				>
					Code
				</button>
			</div>

			<div class="flex shrink-0 items-center gap-1">
				{#if total > 1}
					<button
						onclick={() => artifactStore.navigatePrev()}
						disabled={currentIndex <= 1}
						class="flex h-7 w-7 items-center justify-center rounded text-gray-500 hover:bg-gray-200 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-gray-700"
						aria-label="Previous artifact"
					>
						<CarbonChevronLeft class="size-3.5" />
					</button>
					<span class="text-xs text-gray-500 dark:text-gray-400">{currentIndex}/{total}</span>
					<button
						onclick={() => artifactStore.navigateNext()}
						disabled={currentIndex >= total}
						class="flex h-7 w-7 items-center justify-center rounded text-gray-500 hover:bg-gray-200 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-gray-700"
						aria-label="Next artifact"
					>
						<CarbonChevronRight class="size-3.5" />
					</button>
				{/if}
				<button
					onclick={() => (isFullscreen = !isFullscreen)}
					class="flex h-7 w-7 items-center justify-center rounded text-gray-500 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-700"
					aria-label="Toggle fullscreen"
				>
					<CarbonMaximize class="size-3.5" />
				</button>
				<button
					onclick={() => artifactStore.closePanel()}
					class="flex h-7 w-7 items-center justify-center rounded text-gray-500 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-700"
					aria-label="Close panel"
				>
					<CarbonClose class="size-3.5" />
				</button>
			</div>
		</div>

		<!-- Content -->
		<div class="min-h-0 flex-1 overflow-hidden">
			{#if viewMode === "code"}
				<div class="scrollbar-custom h-full overflow-auto bg-gray-50 p-4 dark:bg-gray-950">
					<pre
						class="whitespace-pre font-mono text-xs leading-relaxed text-gray-800 dark:text-gray-200">{artifact.content}</pre>
				</div>
			{:else if artifact.type === "text/html" || artifact.type === "image/svg+xml"}
				<ArtifactSandbox content={artifact.content} onerror={handleSandboxError} />
			{:else if artifact.type === "text/x-react"}
				<ArtifactSandbox
					content={artifact.content}
					type={artifact.type}
					onerror={handleSandboxError}
				/>
			{:else if artifact.type === "text/x-flutter"}
				<div class="flex h-full flex-col">
					<div
						class="shrink-0 border-b border-sky-200 bg-sky-50 px-4 py-2 text-xs text-sky-700 dark:border-sky-800 dark:bg-sky-900/20 dark:text-sky-400"
					>
						Flutter web requires a Dart runtime — showing source. Copy to
						<a href="https://dartpad.dev" target="_blank" rel="noopener" class="underline"
							>DartPad</a
						>
						to run.
					</div>
					<div class="scrollbar-custom min-h-0 flex-1 overflow-auto p-4">
						<pre
							class="whitespace-pre font-mono text-xs leading-relaxed text-gray-800 dark:text-gray-200">{artifact.content}</pre>
					</div>
				</div>
			{:else if artifact.type === "text/x-mermaid"}
				{#if browser}
					{#await import("@friendofsvelte/mermaid") then { Mermaid }}
						<div class="flex h-full items-center justify-center overflow-auto p-4">
							<Mermaid string={artifact.content} />
						</div>
					{/await}
				{/if}
			{:else if artifact.type === "application/json"}
				<div class="scrollbar-custom h-full overflow-auto p-4">
					<pre class="font-mono text-xs text-gray-800 dark:text-gray-200">{formatJson(
							artifact.content
						)}</pre>
				</div>
			{:else if artifact.type === "text/markdown"}
				<div
					class="scrollbar-custom prose prose-sm h-full max-w-none overflow-auto p-4 dark:prose-invert"
				>
					<MarkdownRenderer content={artifact.content} />
				</div>
			{:else if artifact.type === "text/csv"}
				{@const rows = parseCsvRows(artifact.content)}
				{@const headers = rows[0] ?? []}
				{@const dataRows = rows.slice(1)}
				<div class="scrollbar-custom h-full overflow-auto">
					<table class="w-full border-collapse text-xs">
						<thead class="sticky top-0 bg-gray-50 dark:bg-gray-800">
							<tr>
								{#each headers as header}
									<th
										class="border border-gray-200 px-3 py-2 text-left font-semibold text-gray-700 dark:border-gray-700 dark:text-gray-300"
									>
										{header}
									</th>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each dataRows as row, i}
								<tr
									class={i % 2 === 0
										? "bg-white dark:bg-gray-900"
										: "bg-gray-50 dark:bg-gray-800/50"}
								>
									{#each headers as _header, j}
										<td
											class="border border-gray-200 px-3 py-2 text-gray-600 dark:border-gray-700 dark:text-gray-400"
										>
											{row[j] ?? ""}
										</td>
									{/each}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>

		<!-- Footer -->
		<div
			class="flex shrink-0 items-center border-t border-gray-200 px-3 py-1.5 dark:border-gray-700"
		>
			{#if errors.length > 0}
				<span
					class="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400"
				>
					{errors.length} error{errors.length > 1 ? "s" : ""} caught
				</span>
			{:else}
				<span class="text-xs text-gray-400 dark:text-gray-600">No errors</span>
			{/if}
		</div>
	</div>
{/if}
