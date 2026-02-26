<script lang="ts">
	import { fade, fly } from "svelte/transition";
	import Modal from "../Modal.svelte";
	import { detectLanguageFromMessages } from "$lib/utils/cheatsheet";
	import type { Message } from "$lib/types/Message";
	import { base } from "$app/paths";
	import MarkdownRenderer from "./MarkdownRenderer.svelte";
	import EosIconsLoading from "~icons/eos-icons/loading";
	import LucideHammer from "~icons/lucide/hammer";
	import LucideZap from "~icons/lucide/zap";
	import LucideCode from "~icons/lucide/code";

	interface Props {
		open: boolean;
		messages: Message[];
	}

	let { open = $bindable(), messages }: Props = $props();

	let language = $state("");
	let skillLevel = $state("Intermediate");
	let markdown = $state("");
	let loading = $state(false);
	let error = $state("");
	let codeContext = $state("");
	let suggestedLang = $state("");

	let detectedMeta = $state<{
		detected_libraries: string[];
		complexity_score: number;
		sections: { title: string }[];
	} | null>(null);

	// Initial detection only once when modal opens
	let hasInitialized = $state(false);
	$effect(() => {
		if (open && !hasInitialized) {
			const detection = detectLanguageFromMessages(messages);
			if (detection) {
				language = detection.lang;
				suggestedLang = detection.lang;
				codeContext = detection.code;
			}
			hasInitialized = true;
		} else if (!open) {
			hasInitialized = false;
		}
	});

	async function generateCheatsheet() {
		if (!language) {
			error = "Please specify a language.";
			return;
		}

		loading = true;
		error = "";
		markdown = "";
		detectedMeta = null;

		try {
			const res = await fetch(`${base}/api/gateway`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					name: "generate_cheatsheet",
					arguments: {
						language,
						skill_level: skillLevel.toLowerCase(),
						code_context: codeContext,
					},
				}),
			});

			if (!res.ok) {
				const errText = await res.text();
				throw new Error(errText || "Failed to generate cheatsheet");
			}

			const result = await res.json();
			const data = result.data;

			markdown = data?.markdown || "";

			if (data) {
				detectedMeta = {
					detected_libraries: data.detected_libraries || [],
					complexity_score: data.complexity_score || 0,
					sections: data.sections || [],
				};
			}
		} catch (e) {
			console.error(e);
			error = e instanceof Error ? e.message : "An error occurred. Please try again.";
		} finally {
			loading = false;
		}
	}
</script>

{#if open}
	<Modal onclose={() => (open = false)} width="max-w-4xl">
		<div class="flex h-full flex-col p-6" in:fade={{ duration: 200 }}>
			<div class="mb-6 flex items-center justify-between">
				<div in:fly={{ y: -10, duration: 300, delay: 100 }}>
					<h2 class="text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100">
						Programming Cheatsheet
					</h2>
					<p class="text-sm text-gray-500 dark:text-gray-400">
						Generate a customized reference guide for your stack
					</p>
				</div>
				{#if suggestedLang}
					<div
						in:fade={{ delay: 400 }}
						class="flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-600 dark:bg-blue-900/30 dark:text-blue-400"
					>
						<LucideZap class="size-3" />
						Auto-detected: <span class="capitalize">{suggestedLang}</span>
					</div>
				{/if}
			</div>

			<div
				class="mb-8 grid grid-cols-1 items-end gap-6 rounded-2xl border border-gray-100 bg-gray-50 p-5 dark:border-gray-700/50 dark:bg-gray-800/40 sm:grid-cols-3"
				in:fly={{ y: 10, duration: 400, delay: 200 }}
			>
				<div>
					<label
						for="language"
						class="mb-1.5 block text-[13px] font-semibold text-gray-700 dark:text-gray-300"
					>
						Language
					</label>
					<div class="relative">
						<input
							id="language"
							type="text"
							bind:value={language}
							placeholder="e.g. Python, Javascript"
							class="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-3 pr-10 text-sm shadow-sm transition-all focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/10 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
						/>
						<LucideCode class="absolute right-3 top-1/2 size-4 -translate-y-1/2 text-gray-400" />
					</div>
				</div>

				<div>
					<label
						for="skill-level"
						class="mb-1.5 block text-[13px] font-semibold text-gray-700 dark:text-gray-300"
					>
						Target Level
					</label>
					<select
						id="skill-level"
						bind:value={skillLevel}
						class="w-full cursor-pointer appearance-none rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm shadow-sm transition-all focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/10 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
					>
						<option value="Beginner">Beginner</option>
						<option value="Intermediate">Intermediate</option>
						<option value="Expert">Expert</option>
					</select>
				</div>

				<button
					onclick={generateCheatsheet}
					disabled={loading}
					class="relative flex h-[44px] items-center justify-center gap-2 overflow-hidden rounded-xl bg-blue-600 px-6 py-2.5 text-sm font-bold text-white shadow-md transition-all hover:bg-blue-700 hover:shadow-lg active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
				>
					{#if loading}
						<EosIconsLoading class="size-5" />
						<span>Analyzing...</span>
					{:else}
						<LucideHammer class="size-4" />
						<span>Generate</span>
					{/if}
				</button>
			</div>

			{#if error}
				<div
					in:fly={{ y: 5, duration: 200 }}
					class="mb-6 flex items-center gap-3 rounded-xl border border-red-100 bg-red-50 p-4 text-sm text-red-600 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-400"
				>
					<span class="rounded-full bg-red-100 p-1 dark:bg-red-900/40">⚠️</span>
					{error}
				</div>
			{/if}

			{#if detectedMeta}
				<div in:fade class="mb-4 flex flex-wrap items-center gap-2">
					<span class="mr-1 text-[11px] font-bold uppercase tracking-wider text-gray-400"
						>Detected:</span
					>
					{#each detectedMeta.detected_libraries as lib}
						<span
							class="rounded-lg border border-gray-200/50 bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600 dark:border-gray-600/30 dark:bg-gray-800 dark:text-gray-300"
						>
							{lib}
						</span>
					{/each}
					{#if detectedMeta.complexity_score > 0}
						<div class="ml-2 flex items-center gap-1 text-[11px] font-semibold text-gray-500">
							<span class="text-yellow-500">★</span>
							Complexity: {detectedMeta.complexity_score}
						</div>
					{/if}
				</div>
			{/if}

			{#if markdown}
				<div
					in:fade={{ duration: 400 }}
					class="scrollbar-custom flex-1 overflow-y-auto rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800/40"
				>
					<MarkdownRenderer content={markdown} />
				</div>
			{:else if loading}
				<div class="flex flex-1 flex-col items-center justify-center space-y-4 opacity-50">
					<div class="flex animate-pulse flex-col items-center">
						<LucideCode class="mb-2 size-12 text-blue-500" />
						<p class="text-sm font-medium">Crunching your code context...</p>
					</div>
				</div>
			{:else}
				<div class="flex flex-1 flex-col items-center justify-center space-y-2 py-12 text-gray-400">
					<LucideZap class="mb-2 size-12 opacity-10" />
					<p class="text-sm">Select language and level to start</p>
				</div>
			{/if}
		</div>
	</Modal>
{/if}

<style>
	select {
		background-image: url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3e%3cpath stroke='%236b7280' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3e%3c/svg%3e");
		background-position: right 0.75rem center;
		background-repeat: no-repeat;
		background-size: 1.5em 1.5em;
	}
</style>
