<script lang="ts">
	import { goto, replaceState } from "$app/navigation";
	import { base } from "$app/paths";
	import { page } from "$app/state";
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";

	const publicConfig = usePublicConfig();

	import ChatWindow from "$lib/components/chat/ChatWindow.svelte";
	import { ERROR_MESSAGES, error } from "$lib/stores/errors";
	import { pendingMessage } from "$lib/stores/pendingMessage";
	import { useSettingsStore } from "$lib/stores/settings.js";
	import { findCurrentModel } from "$lib/utils/models";
	import { sanitizeUrlParam } from "$lib/utils/urlParams";
	import { onMount, tick } from "svelte";
	import { loading } from "$lib/stores/loading.js";
	import { loadAttachmentsFromUrls } from "$lib/utils/loadAttachmentsFromUrls";
	import { requireAuthUser } from "$lib/utils/auth";

	let { data } = $props();

	let hasModels = $derived(Boolean(data.models?.length));
	let files: File[] = $state([]);
	let draft = $state("");
	let ragEnabled = $state(true);

	// Initialize directly from server data:
	// - If user is logged in → go straight to chat
	// - Otherwise → show the DevForge splash screen
	let uiState = $state(page.data.user ? "chat" : "splash");

	const settings = useSettingsStore();

	async function createConversation(message: string) {
		try {
			$loading = true;

			// check if $settings.activeModel is a valid model
			// else check if it's an assistant, and use that model
			// else use the first model

			const validModels = data.models.map((model) => model.id);

			let model;
			if (validModels.includes($settings.activeModel)) {
				model = $settings.activeModel;
			} else {
				model = data.models[0].id;
			}
			const res = await fetch(`${base}/conversation`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model,
					preprompt: $settings.customPrompts[$settings.activeModel],
					ragEnabled,
				}),
			});

			if (!res.ok) {
				let errorMessage = ERROR_MESSAGES.default;
				try {
					const json = await res.json();
					errorMessage = json.message || errorMessage;
				} catch {
					// Response wasn't JSON (e.g., HTML error page)
					if (res.status === 401) {
						errorMessage = "Authentication required";
					}
				}
				error.set(errorMessage);
				console.error("Error while creating conversation: ", errorMessage);
				return;
			}

			const { conversationId } = await res.json();

			// Ugly hack to use a store as temp storage, feel free to improve ^^
			pendingMessage.set({
				content: message,
				files,
			});

			// invalidateAll to update list of conversations
			await goto(`${base}/conversation/${conversationId}`, { invalidateAll: true });
		} catch (err) {
			error.set((err as Error).message || ERROR_MESSAGES.default);
			console.error(err);
		} finally {
			$loading = false;
		}
	}

	onMount(async () => {
		try {
			// Don't call requireAuthUser() here — the DevForge splash screen
			// acts as the gate. Unauthenticated users will see it and log in via
			// the auth buttons. Only redirect if they deep-link with query params.
			const hasQ = page.url.searchParams.has("q");
			const hasPrompt = page.url.searchParams.has("prompt");
			const hasAttachments = page.url.searchParams.has("attachments");

			if ((hasQ || hasPrompt || hasAttachments) && requireAuthUser()) {
				// Deep-linked with params but not logged in — redirect to login
				return;
			}

			// If user is authenticated but uiState is still on splash (e.g. after a soft nav)
			// push to chat. Synchronous init above handles the normal login redirect case.
			if (page.data.user && uiState !== "chat") {
				uiState = "chat";
			}

			// Handle attachments parameter first
			if (hasAttachments) {
				const result = await loadAttachmentsFromUrls(page.url.searchParams);
				files = result.files;

				// Show errors if any
				if (result.errors.length > 0) {
					console.error("Failed to load some attachments:", result.errors);
					error.set(
						`Failed to load ${result.errors.length} attachment(s). Check console for details.`
					);
				}

				// Clean up URL
				const url = new URL(page.url);
				url.searchParams.delete("attachments");
				history.replaceState({}, "", url);
			}

			const query = sanitizeUrlParam(page.url.searchParams.get("q"));
			if (query) {
				void createConversation(query);
				const url = new URL(page.url);
				url.searchParams.delete("q");
				tick().then(() => {
					replaceState(url, page.state);
				});
				return;
			}

			const promptQuery = sanitizeUrlParam(page.url.searchParams.get("prompt"));
			if (promptQuery && !draft) {
				draft = promptQuery;
				const url = new URL(page.url);
				url.searchParams.delete("prompt");
				tick().then(() => {
					replaceState(url, page.state);
				});
			}
		} catch (err) {
			console.error("Failed to process URL parameters:", err);
		}
	});

	let currentModel = $derived(findCurrentModel(data.models, data.oldModels, $settings.activeModel));
</script>

<svelte:head>
	<title>{publicConfig.PUBLIC_APP_NAME}</title>
	<link
		href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap"
		rel="stylesheet"
	/>
</svelte:head>

<!-- Liquid Background Blobs -->
{#if uiState !== "chat"}
	<div class="devforge-blob devforge-blob-1"></div>
	<div class="devforge-blob devforge-blob-2"></div>

	<div
		class="devforge-backdrop fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
	>
		<div class="devforge-glass-panel {uiState === 'auth' ? 'expanded' : ''}" id="main-panel">
			<!-- STEP 1: Logo & Start Button — {#key uiState} remounts to replay animations -->
			{#key uiState}
				<div class="devforge-view {uiState === 'splash' ? 'active' : 'hidden-up'}" id="view-splash">
					<h1 class="devforge-logo">DevForge</h1>
					<button class="devforge-start-btn" onclick={() => (uiState = "auth")}>Start</button>
				</div>
			{/key}

			<!-- STEP 2: Auth View -->
			<div
				class="devforge-view {uiState === 'auth' ? 'active' : 'hidden-down'}"
				id="view-dashboard"
			>
				<h2 class="devforge-auth-header">Join DevForge</h2>

				<div class="devforge-auth-buttons">
					<!-- Google Button -->
					<button
						class="devforge-auth-btn devforge-google-btn"
						onclick={() => {
							window.location.href = `${base}/login`;
						}}
					>
						<svg class="h-5 w-5" viewBox="0 0 24 24">
							<path
								fill="#4285F4"
								d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
							/>
							<path
								fill="#34A853"
								d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
							/>
							<path
								fill="#FBBC05"
								d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
							/>
							<path
								fill="#EA4335"
								d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
							/>
						</svg>
						Continue with Google
					</button>

					<!-- Signup Button -->
					<button
						class="devforge-auth-btn devforge-email-btn"
						onclick={() => {
							window.location.href = `${base}/login`;
						}}
					>
						Sign up with Email
					</button>
				</div>

				<div class="devforge-muted mt-[30px] text-[0.85rem]">
					Already have an account? <a href="{base}/login" class="devforge-link">Log In</a>
				</div>
			</div>
		</div>
	</div>
{/if}

<!-- Main Chat Interface -->
{#if uiState === "chat"}
	{#if hasModels}
		<ChatWindow
			onmessage={(message) => createConversation(message)}
			loading={$loading}
			{currentModel}
			models={data.models}
			bind:files
			bind:draft
			{ragEnabled}
			onragtoggle={(enabled) => (ragEnabled = enabled)}
		/>
	{:else}
		<div
			class="relative z-10 mx-auto my-20 max-w-xl rounded-xl border bg-white p-6 text-center dark:border-gray-700 dark:bg-gray-900"
		>
			<h2 class="mb-2 text-xl font-semibold">No models available</h2>
			<p class="text-gray-600 dark:text-gray-300">
				No chat models are configured. Set `OPENAI_BASE_URL` and ensure the server can reach the
				endpoint, then reload. If unset, the app defaults to the Hugging Face router.
			</p>
		</div>
	{/if}
{/if}
