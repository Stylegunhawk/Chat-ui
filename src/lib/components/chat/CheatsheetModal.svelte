<script lang="ts">
	import { fade, fly } from "svelte/transition";
	import Modal from "../Modal.svelte";
	import { detectLanguageFromMessages, SUPPORTED_LANGUAGES } from "$lib/utils/cheatsheet";
	import type { Message } from "$lib/types/Message";
	import {
		type CheatsheetData,
		type CheatsheetResponse,
		type Quality,
		type PackUsed,
	} from "$lib/types/Cheatsheet";
	import { base } from "$app/paths";
	import { allMcpServers } from "$lib/stores/mcpServers";
	import { get } from "svelte/store";
	import MarkdownRenderer from "./MarkdownRenderer.svelte";
	import EosIconsLoading from "~icons/eos-icons/loading";
	import LucideZap from "~icons/lucide/zap";
	import LucideCode from "~icons/lucide/code";
	import LucideInfo from "~icons/lucide/info";
	import LucideChevronDown from "~icons/lucide/chevron-down";
	import LucideSend from "~icons/lucide/send";
	import LucideSparkles from "~icons/lucide/sparkles";
	import LucideFileCode from "~icons/lucide/file-code-2";

	interface Props {
		open: boolean;
		messages: Message[];
	}

	let { open = $bindable(), messages }: Props = $props();

	let language = $state("");
	let skillLevel = $state("Intermediate");
	let intent = $state("");
	let markdown = $state("");
	let loading = $state(false);
	let error = $state("");
	let codeContext = $state("");
	let suggestedLang = $state("");
	let intro = $state("");
	let quality = $state<Quality | "">("");
	let packsUsed = $state<PackUsed[]>([]);
	let suggestedLevel = $state("");
	let loadingElapsed = $state(0);
	let blockCount = $state(0);
	let showContext = $state(false);

	let detectedMeta = $state<{
		detected_libraries: string[];
		complexity_score: number;
	} | null>(null);

	// Backend requires at least language OR code_context to resolve a language.
	// Intent alone is rejected ("language required"). Intent only boosts relevance.
	let canSubmit = $derived(!loading && (language.trim() !== "" || codeContext !== ""));

	let loadingHint = $derived(
		loadingElapsed >= 15
			? "Still working — LLM inference can be slow. You can close and come back."
			: loadingElapsed >= 5
				? "Personalizing against curated knowledge packs..."
				: "Analyzing your code context..."
	);

	let loadingTimer: ReturnType<typeof setInterval> | null = null;

	// Initial detection only once when modal opens
	let hasInitialized = $state(false);
	$effect(() => {
		if (open && !hasInitialized) {
			const detection = detectLanguageFromMessages(messages);
			if (detection) {
				language = detection.lang;
				suggestedLang = detection.lang;
				codeContext = detection.code;
				blockCount = detection.blockCount;
				if (detection.intent && !intent) {
					intent = detection.intent;
				}
			}
			hasInitialized = true;
		} else if (!open) {
			hasInitialized = false;
		}
	});

	async function generateCheatsheet() {
		if (!canSubmit) {
			error = "Provide a language or have code in your conversation.";
			return;
		}

		loading = true;
		loadingElapsed = 0;
		loadingTimer = setInterval(() => (loadingElapsed += 1), 1000);
		error = "";
		markdown = "";
		intro = "";
		quality = "";
		packsUsed = [];
		suggestedLevel = "";
		detectedMeta = null;

		try {
			const args: Record<string, string> = {};
			if (language.trim()) args.language = language.trim().toLowerCase();
			args.skill_level = skillLevel.toLowerCase();
			if (codeContext) args.code_context = codeContext;
			if (intent.trim()) args.intent = intent.trim().slice(0, 400);

			// Resolve headers from the MCP server config that points to the devforge backend
			const servers = get(allMcpServers);
			const devforgeServer = servers.find(
				(s) =>
					s.url?.includes("devforge") ||
					s.url?.includes("8001") ||
					s.name?.toLowerCase().includes("devforge")
			);
			const mcpHeaders: Record<string, string> = {};
			if (devforgeServer?.headers) {
				for (const h of devforgeServer.headers) {
					if (h.key && h.value) mcpHeaders[h.key] = h.value;
				}
			}

			const res = await fetch(`${base}/api/gateway`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "generate_cheatsheet",
					arguments: args,
					headers: mcpHeaders,
				}),
			});

			if (res.status === 429) {
				// Rate limit — parse limit_info if available
				try {
					const rl = await res.json();
					const reset = rl.limit_info?.hourly_reset_at;
					const resetStr = reset ? ` Resets at ${new Date(reset).toLocaleTimeString()}.` : "";
					error = `Rate limit reached (${rl.limit_info?.hourly_used ?? "?"}/${rl.limit_info?.hourly_limit ?? "?"} requests).${resetStr}`;
				} catch {
					error = "Rate limit exceeded. Please wait a moment and try again.";
				}
				return;
			}

			if (!res.ok) {
				const errText = await res.text();
				throw new Error(errText || "Failed to generate cheatsheet");
			}

			const result: CheatsheetResponse = await res.json();

			if (!result.success) {
				const rawMsg =
					result.data && "message" in result.data ? result.data.message : result.message || "";

				if (rawMsg.includes("pack data missing")) {
					error = `The "${language || "requested"}" / ${skillLevel.toLowerCase()} combination isn't available yet. Try Python + Beginner, or adjust your selection.`;
				} else if (rawMsg.includes("is not supported")) {
					error = rawMsg;
				} else if (rawMsg.includes("language required")) {
					error = "Could not detect a language from your code. Please specify one.";
				} else {
					error = rawMsg || "Something went wrong. Please try again.";
				}
				return;
			}

			const data = result.data as CheatsheetData;

			markdown = data?.markdown || "";
			intro = data?.intro || "";
			quality = data?.quality || "";
			packsUsed = data?.packs_used || [];
			suggestedLevel = data?.complexity_suggested_level || "";

			if (data) {
				detectedMeta = {
					detected_libraries: data.detected_libraries || [],
					complexity_score: data.complexity_score || 0,
				};
			}
		} catch (e) {
			console.error(e);
			error = e instanceof Error ? e.message : "An error occurred. Please try again.";
		} finally {
			loading = false;
			if (loadingTimer) {
				clearInterval(loadingTimer);
				loadingTimer = null;
			}
		}
	}

	function applySuggestedLevel() {
		if (suggestedLevel) {
			skillLevel = suggestedLevel.charAt(0).toUpperCase() + suggestedLevel.slice(1);
			generateCheatsheet();
		}
	}
</script>

{#if open}
	<Modal onclose={() => (open = false)} width="max-w-4xl">
		<div class="flex h-full flex-col" in:fade={{ duration: 200 }}>
			<!-- Header -->
			<div
				class="border-b border-gray-100 px-6 pb-4 pt-6 dark:border-gray-700/50"
				in:fly={{ y: -10, duration: 300, delay: 100 }}
			>
				<div class="flex items-center justify-between">
					<div class="flex items-center gap-3">
						<div
							class="flex size-9 items-center justify-center rounded-xl bg-blue-600/10 dark:bg-blue-500/10"
						>
							<LucideSparkles class="size-5 text-blue-600 dark:text-blue-400" />
						</div>
						<div>
							<h2 class="text-lg font-semibold text-gray-900 dark:text-gray-100">
								Cheatsheet Generator
							</h2>
							<p class="text-xs text-gray-500 dark:text-gray-500">
								Personalized reference guide from your conversation
							</p>
						</div>
					</div>
					{#if suggestedLang}
						<div
							in:fade={{ delay: 300 }}
							class="flex items-center gap-1.5 rounded-full border border-blue-200/50 bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-600 dark:border-blue-800/30 dark:bg-blue-900/20 dark:text-blue-400"
						>
							<LucideZap class="size-3" />
							<span class="capitalize">{suggestedLang}</span> detected
						</div>
					{/if}
				</div>
			</div>

			<!-- Form -->
			<div class="px-6 pt-5" in:fly={{ y: 10, duration: 400, delay: 200 }}>
				<div class="space-y-3">
					<div class="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto]">
						<div>
							<label
								for="language"
								class="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500"
							>
								Language
							</label>
							<div class="relative">
								<input
									id="language"
									type="text"
									bind:value={language}
									placeholder="e.g. Python, Rust, Go"
									list="lang-suggestions"
									class="w-full rounded-lg border border-gray-200 bg-white py-2 pl-3 pr-9 text-sm transition-all placeholder:text-gray-300 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-100 dark:placeholder:text-gray-600"
								/>
								<datalist id="lang-suggestions">
									{#each SUPPORTED_LANGUAGES as lang}
										<option value={lang} />
									{/each}
								</datalist>
								<LucideCode
									class="pointer-events-none absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-gray-300 dark:text-gray-600"
								/>
							</div>
						</div>

						<div>
							<label
								for="skill-level"
								class="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500"
							>
								Level
							</label>
							<div class="relative">
								<select
									id="skill-level"
									bind:value={skillLevel}
									class="w-full cursor-pointer appearance-none rounded-lg border border-gray-200 bg-white py-2 pl-3 pr-9 text-sm transition-all focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-100"
								>
									<option value="Beginner">Beginner</option>
									<option value="Intermediate">Intermediate</option>
									<option value="Expert">Expert</option>
								</select>
								<LucideChevronDown
									class="pointer-events-none absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-gray-300 dark:text-gray-600"
								/>
							</div>
						</div>

						<div class="flex items-end">
							<button
								onclick={generateCheatsheet}
								disabled={!canSubmit}
								class="flex h-[38px] items-center gap-2 rounded-lg bg-blue-600 px-5 text-sm font-medium text-white shadow-sm transition-all hover:bg-blue-700 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40"
							>
								{#if loading}
									<EosIconsLoading class="size-4" />
								{:else}
									<LucideSend class="size-3.5" />
								{/if}
								<span>Generate</span>
							</button>
						</div>
					</div>

					<div>
						<label
							for="intent"
							class="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500"
						>
							What are you working on?
							<span class="font-normal normal-case tracking-normal">(optional)</span>
						</label>
						<input
							id="intent"
							type="text"
							bind:value={intent}
							maxlength={400}
							placeholder="e.g. debugging async deadlock, learning metaclasses"
							class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm transition-all placeholder:text-gray-300 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-100 dark:placeholder:text-gray-600"
						/>
					</div>

					<!-- Context preview -->
					{#if codeContext}
						<button
							type="button"
							class="flex w-full items-center gap-2 text-left text-[11px] text-gray-400 transition-colors hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-400"
							onclick={() => (showContext = !showContext)}
						>
							<LucideFileCode class="size-3" />
							{blockCount} code block{blockCount !== 1 ? "s" : ""} from conversation ({(
								codeContext.length / 1000
							).toFixed(1)}k chars)
							<LucideChevronDown
								class="size-3 transition-transform {showContext ? 'rotate-180' : ''}"
							/>
						</button>
						{#if showContext}
							<div
								in:fly={{ y: -5, duration: 200 }}
								class="scrollbar-custom max-h-32 overflow-y-auto rounded-lg border border-gray-100 bg-gray-50 p-3 font-mono text-[11px] leading-relaxed text-gray-500 dark:border-gray-700/50 dark:bg-gray-900/50 dark:text-gray-500"
							>
								<pre class="whitespace-pre-wrap">{codeContext.slice(0, 2000)}{codeContext.length >
									2000
										? "\n...truncated for preview"
										: ""}</pre>
							</div>
						{/if}
					{/if}
				</div>
			</div>

			<!-- Divider -->
			<div class="my-4 border-b border-gray-100 dark:border-gray-700/30"></div>

			<!-- Results area -->
			<div class="flex min-h-0 flex-1 flex-col px-6 pb-6">
				{#if error}
					<div
						in:fly={{ y: 5, duration: 200 }}
						class="mb-4 flex items-start gap-3 rounded-lg border border-red-200/50 bg-red-50/50 p-3.5 text-sm text-red-600 dark:border-red-900/30 dark:bg-red-900/10 dark:text-red-400"
					>
						<LucideInfo class="mt-0.5 size-4 shrink-0" />
						<span>{error}</span>
					</div>
				{/if}

				{#if detectedMeta}
					<div in:fade class="mb-3 flex flex-wrap items-center gap-1.5">
						{#each detectedMeta.detected_libraries as lib}
							<span
								class="rounded-md border border-gray-200/50 bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600 dark:border-gray-600/30 dark:bg-gray-800 dark:text-gray-400"
							>
								{lib}
							</span>
						{/each}
						{#if detectedMeta.complexity_score > 0}
							<span
								class="rounded-md border border-yellow-200/50 bg-yellow-50 px-2 py-0.5 text-[11px] font-medium text-yellow-700 dark:border-yellow-800/30 dark:bg-yellow-900/10 dark:text-yellow-500"
							>
								complexity {detectedMeta.complexity_score}
							</span>
						{/if}
						{#if suggestedLevel && suggestedLevel !== skillLevel.toLowerCase()}
							<button
								onclick={applySuggestedLevel}
								class="flex items-center gap-1 rounded-md border border-blue-200/50 bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-600 transition-colors hover:bg-blue-100 dark:border-blue-800/30 dark:bg-blue-900/10 dark:text-blue-400 dark:hover:bg-blue-900/20"
							>
								Try <span class="capitalize">{suggestedLevel}</span>?
							</button>
						{/if}
					</div>
				{/if}

				{#if intro}
					<div
						in:fade={{ duration: 300 }}
						class="mb-3 rounded-lg border-l-2 border-blue-400/50 bg-blue-50/30 px-3 py-2 text-[13px] italic text-gray-500 dark:bg-blue-900/5 dark:text-gray-400"
					>
						{intro}
					</div>
				{/if}

				{#if quality === "curated_unpersonalized"}
					<div
						in:fade
						class="mb-3 flex items-center gap-2 rounded-lg border border-amber-200/50 bg-amber-50/50 px-3 py-2 text-[12px] text-amber-600 dark:border-amber-800/30 dark:bg-amber-900/10 dark:text-amber-400"
					>
						<LucideInfo class="size-3.5 shrink-0" />
						Curated baseline — personalization unavailable
					</div>
				{/if}

				{#if markdown}
					<div
						in:fade={{ duration: 400 }}
						class="scrollbar-custom min-h-0 flex-1 overflow-y-auto rounded-xl border border-gray-100 bg-white p-5 dark:border-gray-700/40 dark:bg-gray-800/30"
					>
						<MarkdownRenderer content={markdown} />
					</div>

					{#if packsUsed.length > 0}
						<details class="mt-2">
							<summary
								class="cursor-pointer text-[11px] text-gray-400 hover:text-gray-500 dark:text-gray-600 dark:hover:text-gray-500"
							>
								Source packs
							</summary>
							<p class="mt-1 text-[11px] text-gray-400 dark:text-gray-600">
								{#each packsUsed as p, i}
									{p.id} v{p.version} ({p.last_reviewed}){i < packsUsed.length - 1 ? ", " : ""}
								{/each}
							</p>
						</details>
					{/if}
				{:else if loading}
					<div class="flex flex-1 flex-col items-center justify-center py-12">
						<div class="flex flex-col items-center gap-3">
							<div class="relative">
								<div
									class="absolute inset-0 animate-ping rounded-full bg-blue-500/20"
									style="animation-duration: 2s"
								></div>
								<div
									class="relative flex size-12 items-center justify-center rounded-full bg-blue-600/10 dark:bg-blue-500/10"
								>
									<EosIconsLoading class="size-6 text-blue-500" />
								</div>
							</div>
							<p class="text-sm font-medium text-gray-500 dark:text-gray-400">
								{loadingHint}
							</p>
							{#if loadingElapsed >= 3}
								<p in:fade class="text-[11px] tabular-nums text-gray-300 dark:text-gray-600">
									{loadingElapsed}s
								</p>
							{/if}
						</div>
					</div>
				{:else}
					<div
						class="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-gray-300 dark:text-gray-600"
					>
						<LucideCode class="size-10 opacity-30" />
						<p class="text-sm">Pick a language and hit Generate</p>
					</div>
				{/if}
			</div>
		</div>
	</Modal>
{/if}

<style>
	select {
		background-image: none;
	}
</style>
