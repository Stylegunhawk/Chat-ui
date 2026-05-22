<script lang="ts">
	import Modal from "./Modal.svelte";
	import { onMount, onDestroy } from "svelte";
	import CarbonCopy from "~icons/carbon/copy";
	import CarbonClose from "~icons/carbon/close";
	import { buildSrcdoc } from "$lib/utils/buildSrcdoc";

	interface Props {
		html: string;
		onclose?: () => void;
	}

	let { html, onclose }: Props = $props();

	let iframeEl: HTMLIFrameElement | undefined = $state();
	let channel = $state(`preview_${Math.random().toString(36).slice(2)}`);
	let errors: { message: string; stack?: string }[] = $state([]);

	let srcdoc = $derived(buildSrcdoc(html, channel));

	type PreviewMessage = {
		type: string;
		channel: string;
		detail?: { message?: unknown; stack?: string };
	};

	function onMessage(ev: MessageEvent) {
		if (!iframeEl || ev.source !== iframeEl.contentWindow) return;
		const raw = ev.data as unknown;
		if (!raw || typeof raw !== "object") return;
		const data = raw as Partial<PreviewMessage>;
		if (data.type !== "chatui.preview.error" || data.channel !== channel) return;
		const detail = (data.detail ?? {}) as { message?: unknown; stack?: string };
		errors = [...errors, { message: String(detail.message ?? "Error"), stack: detail.stack }];
	}

	onMount(() => {
		window.addEventListener("message", onMessage);
	});
	onDestroy(() => {
		window.removeEventListener("message", onMessage);
		if (copyTimer) clearTimeout(copyTimer);
	});

	function composeText(): string {
		const lines = errors.map((e, i) => `${i + 1}. ${e.message}${e.stack ? `\n${e.stack}` : ""}`);
		const summary = lines[0] ?? "Unknown error";
		return errors.length > 1
			? `it's not working: ${summary} (+${errors.length - 1} more) - can you fix it?`
			: `it's not working: ${summary} - can you fix it?`;
	}

	async function copy(text: string) {
		try {
			if (navigator.clipboard && window.isSecureContext) {
				await navigator.clipboard.writeText(text);
			} else {
				const ta = document.createElement("textarea");
				ta.value = text;
				ta.style.position = "fixed";
				ta.style.left = "-9999px";
				document.body.appendChild(ta);
				ta.focus();
				ta.select();
				document.execCommand("copy");
				document.body.removeChild(ta);
			}
			copied = true;
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => (copied = false), 1200);
		} catch (e) {
			console.error("Copy failed", e);
		}
	}

	let copied = $state(false);
	let copyTimer: ReturnType<typeof setTimeout>;

	function handleKeydown(event: KeyboardEvent) {
		// Close preview on ESC key
		if (event.key === "Escape") {
			event.preventDefault();
			onclose?.();
		}
	}
</script>

<svelte:window on:keydown={handleKeydown} />

<Modal
	width="max-w-none max-h-none w-[100dvw] h-[100dvh] !rounded-none"
	onclose={() => onclose?.()}
>
	<div class="relative h-[100dvh] w-[100dvw]">
		<iframe
			bind:this={iframeEl}
			title="HTML Preview"
			class="h-full w-full"
			sandbox="allow-scripts allow-popups"
			referrerpolicy="no-referrer"
			{srcdoc}
		></iframe>

		<!-- Close button with visible container -->
		<button
			class="btn fixed right-6 top-4 z-50 flex h-7 items-center gap-1 rounded-lg border border-gray-500/60 bg-gray-800 px-2 text-xs text-white shadow-sm backdrop-blur transition-none hover:border-gray-500 hover:bg-gray-700 active:shadow-inner"
			title="Close preview (Esc)"
			onclick={() => onclose?.()}
		>
			<CarbonClose class="size-3.5" />
			Close preview
		</button>

		{#if errors.length > 0}
			<button
				class="btn fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full border-2 border-red-500/60 bg-red-800/90 px-4 py-1.5 text-sm text-white shadow-lg"
				title="Copy error"
				onclick={() => copy(composeText())}
			>
				<CarbonCopy class="text-xs" />
				<span>{copied ? "Copied" : `Error caught (${errors.length})`}</span>
			</button>
		{/if}
	</div>
</Modal>
