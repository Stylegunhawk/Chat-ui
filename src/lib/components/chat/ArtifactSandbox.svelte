<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import { buildSrcdoc, buildReactSrcdoc } from "$lib/utils/buildSrcdoc";

	interface Props {
		content: string;
		type?: string;
		onerror?: (errors: { message: string; stack?: string }[]) => void;
	}

	let { content, type, onerror }: Props = $props();

	let iframeEl: HTMLIFrameElement | undefined = $state();
	let channel = $state(`preview_${Math.random().toString(36).slice(2)}`);
	let errors: { message: string; stack?: string }[] = $state([]);

	let srcdoc = $derived(
		type === "text/x-react" ? buildReactSrcdoc(content, channel) : buildSrcdoc(content, channel)
	);

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
		onerror?.(errors);
	}

	onMount(() => {
		window.addEventListener("message", onMessage);
	});
	onDestroy(() => {
		window.removeEventListener("message", onMessage);
	});
</script>

<iframe
	bind:this={iframeEl}
	title="Artifact Preview"
	class="h-full w-full border-0"
	sandbox="allow-scripts allow-popups"
	referrerpolicy="no-referrer"
	{srcdoc}
></iframe>
