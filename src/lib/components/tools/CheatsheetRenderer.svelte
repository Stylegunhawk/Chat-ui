<script lang="ts">
	import type { ToolRunViewModel } from "$lib/utils/mcp/toolRunAdapter";
	import MarkdownRenderer from "$lib/components/chat/MarkdownRenderer.svelte";
	import LucideChevronRight from "~icons/lucide/chevron-right";

	interface Props {
		vm: ToolRunViewModel;
		isLoading?: boolean;
	}

	let { vm, isLoading = false }: Props = $props();

	let isOpen = $state(false);

	// Extract markdown content from structured payload or fall back to text
	const markdownContent = $derived.by(() => {
		const structured = vm.payload.structured as unknown;
		if (structured && typeof structured === "object") {
			const obj = structured as { markdown?: string; data?: unknown };
			if (typeof obj.markdown === "string") {
				return obj.markdown;
			}
		}
		return vm.payload.text ?? "";
	});

	// Extract sections for preview
	const sections = $derived.by(() => {
		const structured = vm.payload.structured as unknown;
		if (structured && typeof structured === "object") {
			const obj = structured as { data?: { sections?: Array<{ title: string }> } };
			return obj.data?.sections ?? [];
		}
		return [];
	});

	const sectionCount = $derived(sections.length);
</script>

{#if isLoading}
	<div class="inline-flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
		<svg class="size-4 animate-spin" viewBox="0 0 24 24" fill="none">
			<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
			<path
				class="opacity-75"
				fill="currentColor"
				d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
			/>
		</svg>
		<span>Generating cheatsheet…</span>
	</div>
{:else}
	<div class="rounded-md border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
		<!-- Badge/Header -->
		<button
			type="button"
			class="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
			onclick={() => (isOpen = !isOpen)}
		>
			<div class="flex items-center gap-2">
				<span class="text-base" aria-hidden="true">📋</span>
				<span class="text-sm font-medium text-gray-800 dark:text-gray-200">
					Cheatsheet
					{#if sectionCount > 0}
						<span class="font-normal text-gray-500 dark:text-gray-400"
							>({sectionCount} sections)</span
						>
					{/if}
				</span>
			</div>
			<LucideChevronRight
				class="size-4 text-gray-400 transition-transform duration-200 {isOpen ? 'rotate-90' : ''}"
			/>
		</button>

		<!-- Collapsible Content -->
		{#if isOpen}
			<div class="border-t border-gray-200 px-3 py-3 dark:border-gray-700">
				{#if sectionCount > 0}
					<!-- Quick navigation -->
					<div class="mb-3 flex flex-wrap gap-1.5">
						{#each sections as section}
							<span
								class="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400"
							>
								{section.title}
							</span>
						{/each}
					</div>
				{/if}

				<!-- Markdown content -->
				<div class="prose prose-sm max-w-none dark:prose-invert">
					<MarkdownRenderer content={markdownContent} />
				</div>
			</div>
		{/if}
	</div>
{/if}
