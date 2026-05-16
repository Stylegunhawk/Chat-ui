<script lang="ts">
	import type { MessageToolConfirmUpdate } from "$lib/types/MessageUpdate";
	import CarbonTrashCan from "~icons/carbon/trash-can";
	import CarbonDocument from "~icons/carbon/document";
	import LucideGitBranch from "~icons/lucide/git-branch";
	import LucideGitMerge from "~icons/lucide/git-merge";
	import LucideBug from "~icons/lucide/bug";
	import LucideArrowLeft from "~icons/lucide/arrow-left";
	import CarbonEdit from "~icons/carbon/edit";
	import CarbonDebug from "~icons/carbon/debug";

	interface Props {
		confirm: MessageToolConfirmUpdate;
		disabled?: boolean;
	}

	let { confirm, disabled = false }: Props = $props();

	let loading = $state(false);
	let error = $state("");
	let isProcessed = $state(false);
	let acceptedOrRejected = $state<"accept" | "reject" | null>(null);

	async function handleAction(action: "accept" | "reject") {
		if (isProcessed || disabled) return;
		loading = true;
		error = "";
		try {
			const res = await fetch("/api/mcp/confirm", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ uuid: confirm.uuid, action }),
			});
			if (res.ok) {
				isProcessed = true;
				acceptedOrRejected = action;
			} else {
				const data = await res.json();
				error = data.error || "Failed to process confirmation";
			}
		} catch (e) {
			error = "Error connecting to server";
		} finally {
			loading = false;
		}
	}

	const config = $derived.by(() => {
		switch (confirm.operation) {
			case "branch":
				return {
					title: "Create Branch",
					icon: LucideGitBranch,
					accent: "border-l-blue-500",
					description: "This will create a new branch. You can delete it later if needed.",
				};
			case "commit":
				return {
					title: "Commit Changes",
					icon: CarbonDocument,
					accent: "border-l-green-500",
					description: "Apply these changes to the file.",
				};
			case "delete":
				return {
					title: "Delete",
					icon: CarbonTrashCan,
					accent: "border-l-red-500",
					description: "This action cannot be undone. Please confirm you want to delete this.",
				};
			case "merge":
				return {
					title: "Merge",
					icon: LucideGitMerge,
					accent: "border-l-purple-500",
					description: "This will merge the branches. Conflicts may occur.",
				};
			case "update":
				return {
					title: "Update",
					icon: CarbonEdit,
					accent: "border-l-yellow-500",
					description: "Update the existing resource.",
				};
			default:
				try {
					return {
						title: confirm.operation.charAt(0).toUpperCase() + confirm.operation.slice(1),
						icon: CarbonDebug,
						accent: "border-l-gray-400",
						description: "Please review this operation.",
					};
				} catch {
					return {
						title: "Operation",
						icon: LucideBug,
						accent: "border-l-gray-400",
						description: "Please review this operation.",
					};
				}
		}
	});

	let previewLines = $derived.by(() => {
		if (confirm.content && confirm.content.trim()) {
			return confirm.content
				.split("\n")
				.slice(0, 8)
				.map((line) => line);
		}
		if (confirm.query && confirm.query.trim()) {
			return [confirm.query];
		}
		return [];
	});

	let repoBasename = $derived(confirm.repoName.split("/").pop() || confirm.repoName);

	let isInteractionDisabled = $derived(disabled || isProcessed || loading);
</script>

<div
	class="mt-2 flex flex-col gap-2 rounded-md border border-l-4 border-gray-100 bg-white p-2 shadow-sm dark:border-gray-700 dark:bg-gray-800/50 {config.accent} {disabled &&
	!isProcessed
		? 'pointer-events-none opacity-50 grayscale'
		: ''}"
>
	<div class="flex items-center gap-2 font-medium text-gray-800 dark:text-gray-200">
		<config.icon class="size-4" />
		<span class="text-[13px] leading-none">{config.title}</span>
	</div>

	{#if confirm.operation === "branch"}
		<div class="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
			<span class="font-mono text-blue-600 dark:text-blue-400"
				>{confirm.branchName || "new-branch"}</span
			>
			<LucideArrowLeft class="size-3 opacity-50" />
			<span class="font-mono">{confirm.sourceBranch || "main"}</span>
			<span class="opacity-50">•</span>
			<span class="truncate">{repoBasename}</span>
		</div>
	{:else if confirm.operation === "merge"}
		<div class="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
			<span class="font-mono text-purple-600 dark:text-purple-400"
				>{confirm.sourceBranch || "head"}</span
			>
			<LucideArrowLeft class="size-3 opacity-50" />
			<span class="font-mono">{confirm.branchName || "base"}</span>
			<span class="opacity-50">•</span>
			<span class="truncate">{repoBasename}</span>
		</div>
	{:else}
		<div
			class="flex items-center gap-1 truncate text-[11px] text-gray-500 opacity-80 dark:text-gray-400"
		>
			<span class="font-medium">{repoBasename || "Githops Repo"}</span>
			{#if confirm.filePath}
				<span class="opacity-30">/</span>
				<span>{confirm.filePath}</span>
			{/if}
		</div>
	{/if}

	<div class="text-[12px] leading-snug text-gray-600 dark:text-gray-300">
		{config.description}
	</div>

	{#if previewLines.length > 0}
		<div
			class="mt-1 overflow-hidden rounded border border-gray-100 bg-gray-50/50 dark:border-gray-700/50 dark:bg-gray-900/40"
		>
			<div class="font-mono text-[10px] leading-relaxed">
				{#each previewLines as line}
					<div
						class="flex border-b border-gray-50 px-2 py-0.5 last:border-0 dark:border-gray-700/20"
					>
						<span class="mr-2 flex-shrink-0 text-green-600"
							>{confirm.operation === "commit" ? "+" : "•"}</span
						>
						<span class="truncate text-gray-700 dark:text-gray-400">{line}</span>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	{#if confirm.operation === "delete"}
		<div
			class="mt-1 flex items-center gap-1 text-[11px] font-bold uppercase tracking-tight text-red-500"
		>
			⚠️ This cannot be undone
		</div>
	{/if}

	{#if error}
		<div class="mt-1 text-[10px] text-red-500">{error}</div>
	{/if}

	<div class="mt-2 flex items-center justify-end gap-2">
		{#if isProcessed}
			<span
				class="text-xs font-semibold {acceptedOrRejected === 'accept'
					? 'text-green-600 dark:text-green-400'
					: 'text-red-600 dark:text-red-400'}"
			>
				{acceptedOrRejected === "accept" ? "✓ Accepted" : "✗ Rejected"}
			</span>
		{:else}
			<button
				type="button"
				disabled={isInteractionDisabled}
				onclick={() => handleAction("reject")}
				class="px-3 py-1.5 text-xs font-medium text-gray-400 transition-colors hover:text-gray-600 disabled:opacity-50 dark:text-gray-500 dark:hover:text-gray-300"
			>
				Reject
			</button>
			<button
				type="button"
				disabled={isInteractionDisabled}
				onclick={() => handleAction("accept")}
				class="flex items-center gap-1.5 rounded-md bg-purple-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-purple-700 disabled:opacity-50 dark:bg-purple-500 dark:hover:bg-purple-600"
			>
				{#if loading}
					<div
						class="size-3 animate-spin rounded-full border-2 border-white border-t-transparent"
					></div>
				{/if}
				Accept →
			</button>
		{/if}
	</div>
</div>
