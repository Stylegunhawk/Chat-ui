<script lang="ts">
	import type { ToolRunViewModel } from "$lib/utils/mcp/toolRunAdapter";
	import MarkdownRenderer from "$lib/components/chat/MarkdownRenderer.svelte";

	interface Props {
		vm: ToolRunViewModel;
	}

	let { vm }: Props = $props();

	const text = $derived(vm.payload.text ?? "");
</script>

{#if text}
	<div class="prose max-w-none text-xs text-gray-700 dark:prose-invert dark:text-gray-200">
		<MarkdownRenderer content={text} />
	</div>
{/if}
