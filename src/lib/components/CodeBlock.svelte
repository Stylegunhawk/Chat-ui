<script lang="ts">
	import CopyToClipBoardBtn from "./CopyToClipBoardBtn.svelte";
	import DOMPurify from "isomorphic-dompurify";
	import HtmlPreviewModal from "./HtmlPreviewModal.svelte";
	import PlayFilledAlt from "~icons/carbon/play-filled-alt";
	import CarbonSidePanelOpen from "~icons/carbon/side-panel-open";
	import EosIconsLoading from "~icons/eos-icons/loading";
	import { artifactStore, TYPE_COLORS, TYPE_LABELS, type ArtifactType } from "$lib/stores/artifact.svelte";

	interface Props {
		code?: string;
		rawCode?: string;
		loading?: boolean;
		lang?: string;
	}

	let { code = "", rawCode = "", loading = false, lang }: Props = $props();

	let previewOpen = $state(false);
	let artifactId = $state<string | null>(null);

	const ARTIFACT_LANGS: Record<string, ArtifactType> = {
		html: "text/html",
		svg: "image/svg+xml",
		mermaid: "text/x-mermaid",
		json: "application/json",
		markdown: "text/markdown",
		md: "text/markdown",
		csv: "text/csv",
		jsx: "text/x-react",
		tsx: "text/x-react",
		react: "text/x-react",
		dart: "text/x-flutter",
		flutter: "text/x-flutter",
	};

	function hasStrictHtml5Doctype(input: string): boolean {
		if (!input) return false;
		const withoutBOM = input.replace(/^\uFEFF/, "");
		const trimmed = withoutBOM.trimStart();
		return /^<!doctype\s+html\s*>/i.test(trimmed);
	}

	function isSvgDocument(input: string): boolean {
		const trimmed = input.trimStart();
		return /^(?:<\?xml[^>]*>\s*)?(?:<!doctype\s+svg[^>]*>\s*)?<svg[\s>]/i.test(trimmed);
	}

	let showPreview = $derived(hasStrictHtml5Doctype(rawCode) || isSvgDocument(rawCode));
	let artifactType = $derived(lang ? ARTIFACT_LANGS[lang.toLowerCase()] : undefined);
</script>

{#if artifactId}
	<!-- Collapsed artifact card — click to re-focus the panel -->
	<button
		class="my-4 flex w-full cursor-pointer items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-left transition-colors hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800/60 dark:hover:bg-gray-700/60"
		onclick={() => {
			artifactStore.setActive(artifactId!);
			artifactStore.openPanel();
		}}
		title="Open in artifact panel"
	>
		{#if artifactType}
			<span
				class="shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold text-white {TYPE_COLORS[artifactType] ?? 'bg-gray-500'}"
			>
				{TYPE_LABELS[artifactType] ?? lang}
			</span>
		{/if}
		<span class="flex-1 truncate text-sm font-medium text-gray-700 dark:text-gray-200">
			{lang?.toUpperCase() ?? "Artifact"}
		</span>
		<CarbonSidePanelOpen class="size-4 shrink-0 text-gray-400" />
	</button>
{:else}
	<div class="group relative my-4 rounded-lg">
		<div class="pointer-events-none sticky top-0 w-full">
			<div
				class="pointer-events-auto absolute right-2 top-2 flex items-center gap-1.5 md:right-3 md:top-3"
			>
				{#if showPreview}
					<button
						class="btn h-7 gap-1 rounded-lg border px-2 text-xs shadow-sm backdrop-blur transition-none hover:border-gray-500 active:shadow-inner disabled:cursor-not-allowed disabled:opacity-80 dark:border-gray-600 dark:bg-gray-600/50 dark:hover:border-gray-500"
						disabled={loading}
						onclick={() => {
							if (!loading) {
								previewOpen = true;
							}
						}}
						title="Preview HTML"
						aria-label="Preview HTML"
					>
						{#if loading}
							<EosIconsLoading class="size-3.5" />
						{:else}
							<PlayFilledAlt class="size-3.5" />
						{/if}
						Preview
					</button>
				{/if}
				{#if artifactType}
					<button
						class="btn h-7 gap-1 rounded-lg border px-2 text-xs shadow-sm backdrop-blur transition-none hover:border-gray-500 active:shadow-inner disabled:cursor-not-allowed disabled:opacity-80 dark:border-gray-600 dark:bg-gray-600/50 dark:hover:border-gray-500"
						disabled={loading}
						onclick={() => {
							if (!loading && rawCode) {
								artifactId = artifactStore.pushArtifact({
									type: artifactType!,
									title: lang?.toUpperCase() ?? "Artifact",
									content: rawCode,
								});
							}
						}}
						title="Open in artifact panel"
						aria-label="Open in artifact panel"
					>
						{#if loading}
							<EosIconsLoading class="size-3.5" />
						{:else}
							<CarbonSidePanelOpen class="size-3.5" />
						{/if}
						Open in Panel
					</button>
				{/if}
				<CopyToClipBoardBtn
					iconClassNames="size-3"
					classNames="btn transition-none rounded-lg border size-7 text-sm shadow-sm dark:bg-gray-600/50 backdrop-blur dark:hover:border-gray-500  active:shadow-inner dark:border-gray-600  hover:border-gray-500"
					value={rawCode}
				/>
			</div>
		</div>
		<pre class="scrollbar-custom overflow-auto px-5 font-mono transition-[height]"><code
				><!-- eslint-disable svelte/no-at-html-tags -->{@html DOMPurify.sanitize(code)}</code
			></pre>

		{#if previewOpen}
			<HtmlPreviewModal html={rawCode} onclose={() => (previewOpen = false)} />
		{/if}
	</div>
{/if}
