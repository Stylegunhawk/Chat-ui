<script lang="ts">
	import type { Message } from "$lib/types/Message";
	import type { MessageToolUpdate } from "$lib/types/MessageUpdate";
	import { isRagContextMessage } from "$lib/rag/context";
	
	import MarkdownRenderer from "./MarkdownRenderer.svelte";
	import OpenReasoningResults from "./OpenReasoningResults.svelte";
	import ToolUpdate from "./ToolUpdate.svelte";
	import IconLoading from "../icons/IconLoading.svelte";
	import RagReferenceCard from "./RagReferenceCard.svelte";

	// Replicate the Block type from ChatMessage to ensure type safety
	type Block =
		| { type: "text"; content: string }
		| { type: "tool"; uuid: string; updates: MessageToolUpdate[] };

	interface Props {
		message: Message;
		blocks: Block[];
		loading?: boolean;
		isLast?: boolean;
		hasClientThink?: boolean;
	}

	let { 
		message, 
		blocks, 
		loading = false, 
		isLast = false,
		hasClientThink = false 
	}: Props = $props();

	// Zero-config reasoning autodetection regex (same as in ChatMessage)
	const THINK_BLOCK_REGEX = /(<think>[\s\S]*?(?:<\/think>|$))/gi;
	const THINK_BLOCK_TEST_REGEX = /(<think>[\s\S]*?(?:<\/think>|$))/i;
</script>

{#if isRagContextMessage(message)}
	<RagReferenceCard chunks={message.ragChunks || []} />
{:else}
	{#if isLast && loading && blocks.length === 0}
		<IconLoading classNames="loading inline ml-2 first:ml-0" />
	{/if}
	
	{#each blocks as block, blockIndex (block.type === "tool" ? `${block.uuid}-${blockIndex}` : `text-${blockIndex}`)}
		{@const nextBlock = blocks[blockIndex + 1]}
		{@const nextBlockHasThink =
			nextBlock?.type === "text" && THINK_BLOCK_TEST_REGEX.test(nextBlock.content)}
		{@const nextIsLinkable = nextBlock?.type === "tool" || nextBlockHasThink}
		
		{#if block.type === "tool"}
			<div data-exclude-from-copy class="has-[+.prose]:mb-3 [.prose+&]:mt-4">
				<ToolUpdate tool={block.updates} {loading} hasNext={nextIsLinkable} />
			</div>
		{:else if block.type === "text"}
			{#if isLast && loading && block.content.length === 0}
				<IconLoading classNames="loading inline ml-2 first:ml-0" />
			{/if}

			{#if hasClientThink}
				{@const parts = block.content.split(THINK_BLOCK_REGEX)}
				{#each parts as part, partIndex}
					{@const remainingParts = parts.slice(partIndex + 1)}
					{@const hasMoreLinkable =
						remainingParts.some((p) => p && THINK_BLOCK_TEST_REGEX.test(p)) || nextIsLinkable}
					{#if part && part.startsWith("<think>")}
						{@const isClosed = part.endsWith("</think>")}
						{@const thinkContent = part.slice(7, isClosed ? -8 : undefined)}

						<OpenReasoningResults
							content={thinkContent}
							loading={isLast && loading && !isClosed}
							hasNext={hasMoreLinkable}
						/>
					{:else if part && part.trim().length > 0}
						<div
							class="prose max-w-none dark:prose-invert max-sm:prose-sm prose-headings:font-semibold prose-h1:text-lg prose-h2:text-base prose-h3:text-base prose-pre:bg-gray-800 prose-img:my-0 prose-img:cursor-pointer prose-img:rounded-lg dark:prose-pre:bg-gray-900"
						>
							<MarkdownRenderer content={part} loading={isLast && loading} />
						</div>
					{/if}
				{/each}
			{:else}
				<div
					class="prose max-w-none dark:prose-invert max-sm:prose-sm prose-headings:font-semibold prose-h1:text-lg prose-h2:text-base prose-h3:text-base prose-pre:bg-gray-800 prose-img:my-0 prose-img:cursor-pointer prose-img:rounded-lg dark:prose-pre:bg-gray-900"
				>
					<MarkdownRenderer content={block.content} loading={isLast && loading} />
				</div>
			{/if}
		{/if}
	{/each}
{/if}
