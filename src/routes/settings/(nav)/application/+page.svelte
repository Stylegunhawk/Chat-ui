<script lang="ts">
	import CarbonTrashCan from "~icons/carbon/trash-can";
	import CarbonArrowUpRight from "~icons/carbon/arrow-up-right";
	import CarbonLogoGithub from "~icons/carbon/logo-github";

	import { useSettingsStore } from "$lib/stores/settings";
	import Switch from "$lib/components/Switch.svelte";

	import { goto } from "$app/navigation";
	import { error } from "$lib/stores/errors";
	import { base } from "$app/paths";
	import { page } from "$app/state";
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";
	import { useAPIClient, handleResponse } from "$lib/APIClient";
	import { onMount } from "svelte";
	import { browser } from "$app/environment";
	import { getThemePreference, setTheme, type ThemePreference } from "$lib/switchTheme";

	const publicConfig = usePublicConfig();
	let settings = useSettingsStore();

	// Functional bindings for store fields (Svelte 5): avoid mutating $settings directly
	function getShareWithAuthors() {
		return $settings.shareConversationsWithModelAuthors;
	}
	function setShareWithAuthors(v: boolean) {
		settings.update((s) => ({ ...s, shareConversationsWithModelAuthors: v }));
	}
	function getDisableStream() {
		return $settings.disableStream;
	}
	function setDisableStream(v: boolean) {
		settings.update((s) => ({ ...s, disableStream: v }));
	}
	function getDirectPaste() {
		return $settings.directPaste;
	}
	function setDirectPaste(v: boolean) {
		settings.update((s) => ({ ...s, directPaste: v }));
	}

	const client = useAPIClient();

	let OPENAI_BASE_URL = $state<string | null>(null);

	// Billing organization state
	type BillingOrg = { sub: string; name: string; preferred_username: string };
	let billingOrgs = $state<BillingOrg[]>([]);
	let billingOrgsLoading = $state(false);
	let billingOrgsError = $state<string | null>(null);

	// GitHub token state
	let githubTokenInput = $state("");
	let githubTokenSaving = $state(false);
	let githubTokenError = $state<string | null>(null);
	let showGithubToken = $state(false);

	function getGithubToken() {
		return $settings.githubToken ?? null;
	}

	// Check if current input matches the masked placeholder (user hasn't entered a new token)
	function isInputMaskedPlaceholder() {
		return githubTokenInput.trim() === "ghp_****";
	}

	async function saveGithubToken() {
		// If input is the masked placeholder, skip saving (no change to make)
		if (isInputMaskedPlaceholder()) {
			return;
		}
		if (!githubTokenInput.trim()) {
			githubTokenError = "Token cannot be empty";
			return;
		}
		githubTokenSaving = true;
		githubTokenError = null;
		try {
			await client.user.settings.post({ githubToken: githubTokenInput.trim() });
			settings.update((s) => ({ ...s, githubToken: "ghp_****" }));
			githubTokenInput = "";
			showGithubToken = false;
		} catch (e) {
			githubTokenError = "Failed to save token";
			console.error(e);
		} finally {
			githubTokenSaving = false;
		}
	}

	async function clearGithubToken() {
		githubTokenSaving = true;
		githubTokenError = null;
		try {
			await client.user.settings.post({ githubToken: "" });
			settings.update((s) => ({ ...s, githubToken: null }));
		} catch (e) {
			githubTokenError = "Failed to clear token";
			console.error(e);
		} finally {
			githubTokenSaving = false;
		}
	}

	function getBillingOrganization() {
		return $settings.billingOrganization ?? "";
	}
	function setBillingOrganization(v: string) {
		settings.update((s) => ({ ...s, billingOrganization: v }));
	}

	onMount(async () => {
		// Fetch debug config
		try {
			const cfg = await client.debug.config.get().then(handleResponse);
			OPENAI_BASE_URL = (cfg as { OPENAI_BASE_URL?: string }).OPENAI_BASE_URL || null;
		} catch (e) {
			// ignore if debug endpoint is unavailable
		}

		// Fetch billing organizations (only for HuggingChat + logged in users)
		if (publicConfig.isHuggingChat && page.data.user) {
			billingOrgsLoading = true;
			try {
				const data = (await client.user["billing-orgs"].get().then(handleResponse)) as {
					userCanPay: boolean;
					organizations: BillingOrg[];
					currentBillingOrg?: string;
				};
				billingOrgs = data.organizations ?? [];
				// Update settings if current billing org was cleared by server
				if (data.currentBillingOrg !== getBillingOrganization()) {
					setBillingOrganization(data.currentBillingOrg ?? "");
				}
			} catch {
				billingOrgsError = "Failed to load billing options";
			} finally {
				billingOrgsLoading = false;
			}
		}
	});

	let themePref = $state<ThemePreference>(browser ? getThemePreference() : "system");

	// Admin: model refresh UI state
	let refreshing = $state(false);
	let refreshMessage = $state<string | null>(null);
</script>

<div class="flex w-full flex-col gap-4">
	<h2 class="text-center text-lg font-semibold text-gray-800 dark:text-gray-200 md:text-left">
		Application Settings
	</h2>

	{#if OPENAI_BASE_URL !== null}
		<div
			class="mt-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-[12px] text-gray-700 dark:border-gray-700 dark:bg-gray-700/80 dark:text-gray-300"
		>
			<span class="font-medium">API Base URL:</span>
			<code class="ml-1 break-all font-mono text-[12px] text-gray-800 dark:text-gray-100"
				>{OPENAI_BASE_URL}</code
			>
		</div>
	{/if}
	{#if !!publicConfig.PUBLIC_COMMIT_SHA}
		<div
			class="flex flex-col items-start justify-between text-xl font-semibold text-gray-800 dark:text-gray-200"
		>
			<a
				href={`https://github.com/huggingface/chat-ui/commit/${publicConfig.PUBLIC_COMMIT_SHA}`}
				target="_blank"
				rel="noreferrer"
				class="text-sm font-light text-gray-500 dark:text-gray-400"
			>
				Latest deployment <span class="gap-2 font-mono"
					>{publicConfig.PUBLIC_COMMIT_SHA.slice(0, 7)}</span
				>
			</a>
		</div>
	{/if}
	{#if page.data.isAdmin}
		<div class="flex items-center gap-2">
			<p
				class="rounded-md bg-red-50 px-2 py-1 text-xs font-medium text-red-700 dark:bg-red-500/10 dark:text-red-300"
			>
				Admin mode
			</p>
			<button
				class="btn rounded-md text-xs"
				class:underline={!refreshing}
				type="button"
				onclick={async () => {
					try {
						refreshing = true;
						refreshMessage = null;
						const res = await client.models.refresh.post().then(handleResponse);
						const delta = `+${res.added.length} −${res.removed.length} ~${res.changed.length}`;
						refreshMessage = `Refreshed in ${res.durationMs} ms • ${delta} • total ${res.total}`;
						await goto(page.url.pathname, { invalidateAll: true });
					} catch (e) {
						console.error(e);
						$error = "Model refresh failed";
					} finally {
						refreshing = false;
					}
				}}
				disabled={refreshing}
			>
				{refreshing ? "Refreshing…" : "Refresh models"}
			</button>
			{#if refreshMessage}
				<span class="text-xs text-gray-600 dark:text-gray-400">{refreshMessage}</span>
			{/if}
		</div>
	{/if}
	<div class="flex h-full flex-col gap-4 max-sm:pt-0">
		<div
			class="rounded-xl border border-gray-200 bg-white px-3 shadow-sm dark:border-gray-700 dark:bg-gray-800"
		>
			<div class="divide-y divide-gray-200 dark:divide-gray-700">
				{#if publicConfig.PUBLIC_APP_DATA_SHARING === "1"}
					<div class="flex items-start justify-between py-3">
						<div>
							<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
								Share with model authors
							</div>
							<p class="text-[12px] text-gray-500 dark:text-gray-400">
								Sharing your data helps improve open models over time.
							</p>
						</div>
						<Switch
							name="shareConversationsWithModelAuthors"
							bind:checked={getShareWithAuthors, setShareWithAuthors}
						/>
					</div>
				{/if}

				<div class="flex items-start justify-between py-3">
					<div>
						<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
							Disable streaming tokens
						</div>
						<p class="text-[12px] text-gray-500 dark:text-gray-400">
							Show responses only when complete.
						</p>
					</div>
					<Switch name="disableStream" bind:checked={getDisableStream, setDisableStream} />
				</div>

				<div class="flex items-start justify-between py-3">
					<div>
						<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
							Paste text directly
						</div>
						<p class="text-[12px] text-gray-500 dark:text-gray-400">
							Paste long text directly into chat instead of a file.
						</p>
					</div>
					<Switch name="directPaste" bind:checked={getDirectPaste, setDirectPaste} />
				</div>

				<!-- Theme selector -->
				<div class="flex items-start justify-between py-3">
					<div>
						<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">Theme</div>
						<p class="text-[12px] text-gray-500 dark:text-gray-400">
							Choose light, dark, or follow system.
						</p>
					</div>
					<div
						class="flex overflow-hidden rounded-md border text-center dark:divide-gray-600 dark:border-gray-600 max-sm:flex-col max-sm:divide-y sm:items-center sm:divide-x"
					>
						<button
							class={"inline-flex items-center justify-center px-2.5 py-1 text-center text-xs " +
								(themePref === "system"
									? "bg-black text-white dark:border-white/10 dark:bg-white/80 dark:text-gray-900"
									: "hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700/60")}
							onclick={() => {
								setTheme("system");
								themePref = "system";
							}}
						>
							system
						</button>
						<button
							class={"inline-flex items-center justify-center px-2.5 py-1 text-center text-xs " +
								(themePref === "light"
									? "bg-black text-white dark:border-white/10 dark:bg-white/80 dark:text-gray-900"
									: "hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700/60")}
							onclick={() => {
								setTheme("light");
								themePref = "light";
							}}
						>
							light
						</button>
						<button
							class={"inline-flex items-center justify-center px-2.5 py-1 text-center text-xs " +
								(themePref === "dark"
									? "bg-black text-white dark:border-white/10 dark:bg-white/80 dark:text-gray-900"
									: "hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700/60")}
							onclick={() => {
								setTheme("dark");
								themePref = "dark";
							}}
						>
							dark
						</button>
					</div>
				</div>
			</div>
		</div>

		<!-- Billing section (HuggingChat only) -->
		{#if publicConfig.isHuggingChat && page.data.user}
			<div
				class="rounded-xl border border-gray-200 bg-white px-3 shadow-sm dark:border-gray-700 dark:bg-gray-800"
			>
				<div class="divide-y divide-gray-200 dark:divide-gray-700">
					<!-- Bill usage to -->
					<div class="flex items-start justify-between py-3">
						<div>
							<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">Billing</div>
							<p class="text-[12px] text-gray-500 dark:text-gray-400">
								Select between personal or organization billing (for eligible organizations).
							</p>
						</div>
						<div class="flex items-center">
							{#if billingOrgsLoading}
								<span class="text-xs text-gray-500 dark:text-gray-400">Loading...</span>
							{:else if billingOrgsError}
								<span class="text-xs text-red-500">{billingOrgsError}</span>
							{:else}
								<select
									class="rounded-md border border-gray-300 bg-white px-1 py-1 text-xs text-gray-800 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
									value={getBillingOrganization()}
									onchange={(e) => setBillingOrganization(e.currentTarget.value)}
								>
									<option value="">Personal</option>
									{#each billingOrgs as org}
										<option value={org.preferred_username}>{org.name}</option>
									{/each}
								</select>
							{/if}
						</div>
					</div>
					<!-- Providers Usage -->
					<div class="flex items-start justify-between py-3">
						<div>
							<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
								Providers Usage
							</div>
							<p class="text-[12px] text-gray-500 dark:text-gray-400">
								See which providers you use and choose your preferred ones.
							</p>
						</div>
						<a
							href={getBillingOrganization()
								? `https://huggingface.co/organizations/${getBillingOrganization()}/settings/inference-providers/overview`
								: "https://huggingface.co/settings/inference-providers/overview"}
							target="_blank"
							class="whitespace-nowrap rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
						>
							View Usage
						</a>
					</div>
				</div>
			</div>
		{/if}

		<!-- GitHub Integration section -->
		{#if page.data.user}
			<div
				class="rounded-xl border border-gray-200 bg-white px-3 shadow-sm dark:border-gray-700 dark:bg-gray-800"
			>
				<div class="divide-y divide-gray-200 dark:divide-gray-700">
					<div class="py-3">
						<div class="mb-3 flex items-start justify-between gap-3">
							<div class="flex items-center gap-2">
								<div
									class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-gray-200 bg-gray-50 dark:border-gray-600 dark:bg-gray-700"
								>
									<CarbonLogoGithub class="text-base text-gray-700 dark:text-gray-200" />
								</div>
								<div class="min-w-0">
									<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
										GitHub Integration
									</div>
									<p class="text-[12px] text-gray-500 dark:text-gray-400">
										Store a Personal Access Token for GitHub MCP tool operations.
									</p>
								</div>
							</div>
							<span
								class="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium {getGithubToken()
									? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-700/40 dark:bg-emerald-900/20 dark:text-emerald-300'
									: 'border-gray-200 bg-gray-50 text-gray-600 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300'}"
							>
								{getGithubToken() ? "Configured" : "Not configured"}
							</span>
						</div>
						<div
							class="rounded-lg border border-gray-200 bg-gray-50/70 p-2.5 dark:border-gray-600 dark:bg-gray-700/40"
						>
							<div class="mb-2 flex flex-wrap items-center gap-2">
								<span
									class="text-[11px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
									>Stored token</span
								>
								{#if getGithubToken()}
									<code
										class="rounded bg-white px-1.5 py-0.5 font-mono text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-200"
										>{getGithubToken()}</code
									>
									<button
										type="button"
										class="rounded border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-800/50 dark:bg-red-900/20 dark:text-red-300 dark:hover:bg-red-900/30"
										onclick={clearGithubToken}
										disabled={githubTokenSaving}
									>
										Clear
									</button>
								{:else}
									<span class="text-xs text-gray-500 dark:text-gray-400">None</span>
								{/if}
							</div>
							<div class="flex flex-col gap-2">
								<div class="flex items-center gap-2">
									<input
										type={showGithubToken ? "text" : "password"}
										placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
										bind:value={githubTokenInput}
										class="flex-1 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder:text-gray-500"
									/>
									<button
										type="button"
										class="rounded-md border border-gray-300 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
										onclick={() => (showGithubToken = !showGithubToken)}
									>
										{showGithubToken ? "Hide" : "Show"}
									</button>
								</div>
								<div class="flex flex-wrap items-center gap-2">
									<button
										type="button"
										class="rounded-md bg-black px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-gray-300"
										onclick={saveGithubToken}
										disabled={githubTokenSaving || !githubTokenInput.trim()}
									>
										{githubTokenSaving ? "Saving..." : "Save Token"}
									</button>
									{#if githubTokenError}
										<span class="text-xs text-red-500">{githubTokenError}</span>
									{/if}
								</div>
							</div>
						</div>
						<div class="mt-2 rounded-md bg-gray-50 px-2 py-1.5 dark:bg-gray-700/50">
							<p class="text-[11px] text-gray-500 dark:text-gray-400">
								Token is stored securely and only used for GitHub MCP tool calls.
							</p>
						</div>
					</div>
				</div>
			</div>
		{/if}

		<div class="mt-6 flex flex-col gap-2 self-start text-[13px]">
			{#if publicConfig.isHuggingChat}
				<a
					href="https://github.com/huggingface/chat-ui"
					target="_blank"
					class="flex items-center underline decoration-gray-300 underline-offset-2 hover:decoration-gray-700 dark:decoration-gray-700 dark:hover:decoration-gray-400"
					><CarbonLogoGithub class="mr-1.5 shrink-0 text-sm " /> Github repository</a
				>
				<a
					href="https://huggingface.co/spaces/huggingchat/chat-ui/discussions/764"
					target="_blank"
					rel="noreferrer"
					class="flex items-center underline decoration-gray-300 underline-offset-2 hover:decoration-gray-700 dark:decoration-gray-700 dark:hover:decoration-gray-400"
					><CarbonArrowUpRight class="mr-1.5 shrink-0 text-sm " /> Share your feedback on HuggingChat</a
				>
				<a
					href="{base}/privacy"
					class="flex items-center underline decoration-gray-300 underline-offset-2 hover:decoration-gray-700 dark:decoration-gray-700 dark:hover:decoration-gray-400"
					><CarbonArrowUpRight class="mr-1.5 shrink-0 text-sm " /> About & Privacy</a
				>
			{/if}
			<button
				onclick={async (e) => {
					e.preventDefault();

					confirm("Are you sure you want to delete all conversations?") &&
						client.conversations
							.delete()
							.then(async () => {
								await goto(`${base}/`, { invalidateAll: true });
							})
							.catch((err) => {
								console.error(err);
								$error = err.message;
							});
				}}
				type="submit"
				class="flex items-center underline decoration-red-200 underline-offset-2 hover:decoration-red-500 dark:decoration-red-900 dark:hover:decoration-red-700"
				><CarbonTrashCan class="mr-2 inline text-sm text-red-500" />Delete all conversations</button
			>
		</div>
	</div>
</div>
