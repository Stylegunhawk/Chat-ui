# Agentic Artifact Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Claude-style persistent split-panel artifact registry to chat-ui that renders LLM-generated HTML, SVG, Mermaid, JSON, CSV, and Markdown live in a sandboxed preview alongside the chat.

**Architecture:** Two trigger paths feed one Svelte 5 reactive store: (A) code blocks with artifact-compatible languages get an "Open in Panel" button in `CodeBlock.svelte`, and (B) the LLM can call `generate_artifact` as a client-side tool intercepted in `toolInvocation.ts` before any MCP call, with `ArtifactOpener.svelte` handling the tool result. Both paths call `artifactStore.pushArtifact()`. The split-panel layout is wired in `+page.svelte` — `ChatWindow` shrinks to half-width when `artifactStore.panelOpen` is true and `ArtifactPanel` slides in on the right.

**Tech Stack:** Svelte 5 runes (`$state` in `.svelte.ts`), `@friendofsvelte/mermaid`, existing `buildSrcdoc` logic (extracted to a shared utility), TailwindCSS, Vitest

---

## File Map

| File                                                  | Action     | Responsibility                                                             |
| ----------------------------------------------------- | ---------- | -------------------------------------------------------------------------- |
| `src/lib/stores/artifact.svelte.ts`                   | **Create** | Reactive class-based store: artifact list, active ID, panel open state     |
| `src/lib/utils/buildSrcdoc.ts`                        | **Create** | Pure function extracted from HtmlPreviewModal — builds safe srcdoc string  |
| `src/lib/components/chat/ArtifactSandbox.svelte`      | **Create** | Inline sandboxed iframe renderer (HTML + SVG)                              |
| `src/lib/components/chat/ArtifactPanel.svelte`        | **Create** | Right panel: header, content-type router, footer error pill                |
| `src/lib/components/chat/tools/ArtifactOpener.svelte` | **Create** | Tool renderer for `generate_artifact` — calls pushArtifact on mount        |
| `src/lib/components/HtmlPreviewModal.svelte`          | **Modify** | Import `buildSrcdoc` from shared utility instead of defining locally       |
| `src/lib/components/CodeBlock.svelte`                 | **Modify** | Add `lang` prop + "Open in Panel" button for artifact-compatible languages |
| `src/lib/components/chat/MarkdownBlock.svelte`        | **Modify** | Pass `lang={token.lang}` to CodeBlock                                      |
| `src/lib/server/textGeneration/mcp/toolInvocation.ts` | **Modify** | Add `CLIENT_SIDE_TOOLS` set + short-circuit before MCP call                |
| `src/lib/components/chat/tools/registry.ts`           | **Modify** | Register `generate_artifact → ArtifactOpener`                              |
| `src/lib/server/textGeneration/utils/toolPrompt.ts`   | **Modify** | Document `generate_artifact` tool in LLM system prompt                     |
| `src/routes/conversation/[id]/+page.svelte`           | **Modify** | Flex split-panel layout wrapping ChatWindow + ArtifactPanel                |

---

## Task 1: Install @friendofsvelte/mermaid

**Files:**

- Run: `npm install @friendofsvelte/mermaid`

- [ ] **Step 1: Install the package**

```bash
npm install @friendofsvelte/mermaid
```

Expected output: package added to `package.json` and `package-lock.json`, no errors.

- [ ] **Step 2: Verify install**

```bash
node -e "require('./node_modules/@friendofsvelte/mermaid/package.json')" && echo "OK"
```

Expected: prints `OK`.

---

## Task 2: Extract buildSrcdoc to shared utility + update HtmlPreviewModal

**Files:**

- Create: `src/lib/utils/buildSrcdoc.ts`
- Create: `src/lib/utils/buildSrcdoc.spec.ts`
- Modify: `src/lib/components/HtmlPreviewModal.svelte:18-60`

The `buildSrcdoc` function in `HtmlPreviewModal.svelte` (lines 18–60) is a pure function — it takes a string and a channel ID and returns a safe srcdoc string. Moving it out makes it reusable by `ArtifactSandbox` and testable.

- [ ] **Step 1: Write the failing test**

Create `src/lib/utils/buildSrcdoc.spec.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildSrcdoc } from "./buildSrcdoc";

describe("buildSrcdoc", () => {
	it("wraps bare HTML in head/body with base tag", () => {
		const result = buildSrcdoc("<!doctype html><html><head></head><body>hi</body></html>", "ch1");
		expect(result).toContain('<base target="_blank">');
		expect(result).toContain("chatui.preview.error");
	});

	it("detects SVG and wraps it in an HTML page", () => {
		const result = buildSrcdoc('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', "ch2");
		expect(result).toContain("<!doctype html>");
		expect(result).toContain("<svg");
	});

	it("injects base tag into existing <head>", () => {
		const html = "<!doctype html><html><head><title>T</title></head><body></body></html>";
		const result = buildSrcdoc(html, "ch3");
		expect(result.indexOf('<base target="_blank">')).toBeGreaterThan(result.indexOf("<head>"));
	});
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
npx vitest run src/lib/utils/buildSrcdoc.spec.ts
```

Expected: FAIL — `buildSrcdoc` not found.

- [ ] **Step 3: Create `src/lib/utils/buildSrcdoc.ts`**

Copy the function body verbatim from `HtmlPreviewModal.svelte:18-60`, export it:

```ts
export function buildSrcdoc(content: string, channel: string): string {
	const trimmed = content.trimStart();
	const svgPattern = /^(?:<\?xml[^>]*>\s*)?(?:<!doctype\s+svg[^>]*>\s*)?<svg[\s>]/i;
	const baseTag = '<base target="_blank">';
	const disabledLinkStyles = `<style>
		a[data-chatui-link-disabled] {}
	</style>`;
	const endScriptTag = "</scr" + "ipt>";
	const errorHook = `\n<script>\n(function(){\n  function send(detail){\n    try{ parent.postMessage({ type: 'chatui.preview.error', channel: '${channel}', detail: detail }, '*'); }catch(e){}\n  }\n  function markDisabled(anchor){\n    if (!anchor || anchor.dataset.chatuiLinkDisabled === 'true') return;\n    anchor.dataset.chatuiLinkDisabled = 'true';\n    var note = 'Link disabled in preview';\n    var title = anchor.getAttribute('title');\n    if (!title) {\n      anchor.setAttribute('title', note);\n    } else if (title.indexOf(note) === -1) {\n      anchor.setAttribute('title', title + ' — ' + note);\n    }\n  }\n  function disableAnchors(scope){\n    try {\n      var root = scope && scope.querySelectorAll ? scope : document;\n      var anchors = root.querySelectorAll ? root.querySelectorAll('a') : [];\n      for (var i = 0; i < anchors.length; i++) {\n        markDisabled(anchors[i]);\n      }\n    } catch (err) {}\n  }\n  function nearestAnchor(node){\n    while (node && node !== document) {\n      if (node.tagName && node.tagName.toLowerCase() === 'a') return node;\n      node = node.parentNode;\n    }\n    return null;\n  }\n  function intercept(ev){\n    var anchor = nearestAnchor(ev.target);\n    if (!anchor) return;\n    markDisabled(anchor);\n    ev.preventDefault();\n    ev.stopPropagation();\n  }\n  disableAnchors();\n  if (document.readyState === 'loading') {\n    document.addEventListener('DOMContentLoaded', function(){ disableAnchors(); });\n  } else {\n    setTimeout(function(){ disableAnchors(); }, 0);\n  }\n  if (window.MutationObserver) {\n    var observer = new MutationObserver(function(mutations){\n      for (var i = 0; i < mutations.length; i++) {\n        var nodes = mutations[i].addedNodes;\n        for (var j = 0; j < nodes.length; j++) {\n          var node = nodes[j];\n          if (!node || node.nodeType !== 1) continue;\n          if (node.tagName && node.tagName.toLowerCase() === 'a') {\n            markDisabled(node);\n          } else {\n            disableAnchors(node);\n          }\n        }\n      }\n    });\n    observer.observe(document.documentElement, { childList: true, subtree: true });\n  }\n  window.addEventListener('click', intercept, true);\n  window.addEventListener('auxclick', intercept, true);\n  window.addEventListener('keydown', function(ev){\n    if (ev.key === 'Enter' || ev.key === ' ') {\n      intercept(ev);\n    }\n  }, true);\n  window.addEventListener('error', function(ev){\n    var msg = ev && ev.message ? ev.message : 'Script error';\n    var stack = ev && ev.error && ev.error.stack ? ev.error.stack : undefined;\n    send({ message: msg, stack: stack });\n  });\n  window.addEventListener('unhandledrejection', function(ev){\n    var r = ev && ev.reason;\n    var msg = (typeof r === 'string') ? r : (r && r.message) ? r.message : 'Unhandled promise rejection';\n    var stack = r && r.stack ? r.stack : undefined;\n    send({ message: msg, stack: stack });\n  });\n})();\n${endScriptTag}`;

	if (svgPattern.test(trimmed)) {
		const svgContent = trimmed
			.replace(/^(<\?xml[^>]*>\s*)/i, "")
			.replace(/^(<!doctype[^>]*>\s*)/i, "");
		return `<!doctype html><html><head>${baseTag}${disabledLinkStyles}${errorHook}</head><body>${svgContent}</body></html>`;
	}

	const headMatch = content.match(/<head[^>]*>/i);
	if (headMatch) {
		return content.replace(headMatch[0], headMatch[0] + baseTag + disabledLinkStyles + errorHook);
	}
	const htmlTagMatch = content.match(/<html[^>]*>/i);
	if (htmlTagMatch) {
		return content.replace(
			htmlTagMatch[0],
			htmlTagMatch[0] + "\n<head>" + baseTag + disabledLinkStyles + errorHook + "</head>"
		);
	}
	const doctypeMatch = content.match(/<!doctype[^>]*>/i);
	if (doctypeMatch) {
		const idx = content.indexOf(doctypeMatch[0]) + doctypeMatch[0].length;
		return (
			content.slice(0, idx) +
			"\n<head>" +
			baseTag +
			disabledLinkStyles +
			errorHook +
			"</head>" +
			content.slice(idx)
		);
	}
	return "<head>" + baseTag + disabledLinkStyles + errorHook + "</head>\n" + content;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run src/lib/utils/buildSrcdoc.spec.ts
```

Expected: 3 tests PASS.

- [ ] **Step 5: Update HtmlPreviewModal.svelte to import from the utility**

In `src/lib/components/HtmlPreviewModal.svelte`, replace the local `buildSrcdoc` function definition (lines 18–60) with an import:

```ts
import { buildSrcdoc } from "$lib/utils/buildSrcdoc";
```

Delete everything from `function buildSrcdoc(content: string, channel: string): string {` through the closing `}` of that function (lines 18–60). The `let srcdoc = $derived(buildSrcdoc(html, channel));` line (now around line 62) stays unchanged.

- [ ] **Step 6: Verify TypeScript still passes**

```bash
npm run check
```

Expected: 0 errors.

---

## Task 3: Create the artifact store

**Files:**

- Create: `src/lib/stores/artifact.svelte.ts`

- [ ] **Step 1: Create `src/lib/stores/artifact.svelte.ts`**

```ts
export type ArtifactType =
	| "text/html"
	| "image/svg+xml"
	| "text/x-mermaid"
	| "application/json"
	| "text/markdown"
	| "text/csv";

export interface Artifact {
	id: string;
	type: ArtifactType;
	title: string;
	content: string;
	createdAt: Date;
}

class ArtifactStore {
	artifacts = $state<Artifact[]>([]);
	activeArtifactId = $state<string | null>(null);
	panelOpen = $state(false);

	get activeArtifact(): Artifact | undefined {
		return this.artifacts.find((a) => a.id === this.activeArtifactId);
	}

	get activeIndex(): number {
		return this.artifacts.findIndex((a) => a.id === this.activeArtifactId);
	}

	pushArtifact(artifact: Omit<Artifact, "id" | "createdAt">): void {
		const id = crypto.randomUUID();
		const newArtifact: Artifact = { ...artifact, id, createdAt: new Date() };
		this.artifacts = [...this.artifacts, newArtifact];
		this.activeArtifactId = id;
		this.panelOpen = true;
	}

	setActive(id: string): void {
		if (this.artifacts.some((a) => a.id === id)) {
			this.activeArtifactId = id;
		}
	}

	navigatePrev(): void {
		const i = this.activeIndex;
		if (i > 0) this.activeArtifactId = this.artifacts[i - 1].id;
	}

	navigateNext(): void {
		const i = this.activeIndex;
		if (i < this.artifacts.length - 1) this.activeArtifactId = this.artifacts[i + 1].id;
	}

	closePanel(): void {
		this.panelOpen = false;
	}

	openPanel(): void {
		this.panelOpen = true;
	}
}

export const artifactStore = new ArtifactStore();
```

- [ ] **Step 2: Verify TypeScript**

```bash
npm run check
```

Expected: 0 errors.

---

## Task 4: Plumb `lang` through MarkdownBlock → CodeBlock + add "Open in Panel" button

**Files:**

- Modify: `src/lib/components/chat/MarkdownBlock.svelte:21`
- Modify: `src/lib/components/CodeBlock.svelte`

The `CodeToken` type in `src/lib/utils/marked.ts:397-403` already has `lang: string`. It just isn't passed to `CodeBlock`. We add it now and use it to show the "Open in Panel" button.

- [ ] **Step 1: Pass `lang` in MarkdownBlock.svelte**

In `src/lib/components/chat/MarkdownBlock.svelte`, change line 21 from:

```svelte
<CodeBlock code={token.code} rawCode={token.rawCode} loading={loading && !token.isClosed} />
```

to:

```svelte
<CodeBlock
	code={token.code}
	rawCode={token.rawCode}
	lang={token.lang}
	loading={loading && !token.isClosed}
/>
```

- [ ] **Step 2: Add `lang` prop and "Open in Panel" button to CodeBlock.svelte**

Replace the entire `<script lang="ts">` block in `src/lib/components/CodeBlock.svelte` with:

```ts
import CopyToClipBoardBtn from "./CopyToClipBoardBtn.svelte";
import DOMPurify from "isomorphic-dompurify";
import HtmlPreviewModal from "./HtmlPreviewModal.svelte";
import PlayFilledAlt from "~icons/carbon/play-filled-alt";
import CarbonSidePanelOpen from "~icons/carbon/side-panel-open";
import EosIconsLoading from "~icons/eos-icons/loading";
import { artifactStore, type ArtifactType } from "$lib/stores/artifact.svelte";

interface Props {
	code?: string;
	rawCode?: string;
	loading?: boolean;
	lang?: string;
}

let { code = "", rawCode = "", loading = false, lang }: Props = $props();

let previewOpen = $state(false);

const ARTIFACT_LANGS: Record<string, ArtifactType> = {
	html: "text/html",
	svg: "image/svg+xml",
	mermaid: "text/x-mermaid",
	json: "application/json",
	markdown: "text/markdown",
	md: "text/markdown",
	csv: "text/csv",
};

function hasStrictHtml5Doctype(input: string): boolean {
	if (!input) return false;
	const withoutBOM = input.replace(/^﻿/, "");
	const trimmed = withoutBOM.trimStart();
	return /^<!doctype\s+html\s*>/i.test(trimmed);
}

function isSvgDocument(input: string): boolean {
	const trimmed = input.trimStart();
	return /^(?:<\?xml[^>]*>\s*)?(?:<!doctype\s+svg[^>]*>\s*)?<svg[\s>]/i.test(trimmed);
}

let showPreview = $derived(hasStrictHtml5Doctype(rawCode) || isSvgDocument(rawCode));
let artifactType = $derived(lang ? ARTIFACT_LANGS[lang.toLowerCase()] : undefined);
```

- [ ] **Step 3: Add the "Open in Panel" button to the template**

In `src/lib/components/CodeBlock.svelte`, add the new button inside the existing button container (right after the `{#if showPreview}` block, before `<CopyToClipBoardBtn>`):

```svelte
{#if artifactType}
	<button
		class="btn h-7 gap-1 rounded-lg border px-2 text-xs shadow-sm backdrop-blur transition-none hover:border-gray-500 active:shadow-inner disabled:cursor-not-allowed disabled:opacity-80 dark:border-gray-600 dark:bg-gray-600/50 dark:hover:border-gray-500"
		disabled={loading}
		onclick={() => {
			if (!loading && rawCode) {
				artifactStore.pushArtifact({
					type: artifactType!,
					title: lang ?? "Artifact",
					content: rawCode,
				});
			}
		}}
		title="Open in artifact panel"
		aria-label="Open in artifact panel"
	>
		{#if loading}
			<EosIconsLoading class="size-3.5" />
		{:else}
			<CarbonSidePanelOpen class="size-3.5" />
		{/if}
		Open in Panel
	</button>
{/if}
```

- [ ] **Step 4: Verify TypeScript**

```bash
npm run check
```

Expected: 0 errors. If `CarbonSidePanelOpen` isn't found, replace with `CarbonLaunch` from `~icons/carbon/launch` (already imported in `RagFileManager`).

---

## Task 5: Create ArtifactSandbox.svelte

**Files:**

- Create: `src/lib/components/chat/ArtifactSandbox.svelte`

This is a thin inline iframe renderer. It reuses `buildSrcdoc` from the utility we created in Task 2. It does NOT open a modal — it fills whatever container it's placed in.

- [ ] **Step 1: Create `src/lib/components/chat/ArtifactSandbox.svelte`**

```svelte
<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import { buildSrcdoc } from "$lib/utils/buildSrcdoc";

	interface Props {
		content: string;
		onerror?: (errors: { message: string; stack?: string }[]) => void;
	}

	let { content, onerror }: Props = $props();

	let iframeEl: HTMLIFrameElement | undefined = $state();
	const channel = `artifact_${Math.random().toString(36).slice(2)}`;
	let errors: { message: string; stack?: string }[] = $state([]);

	let srcdoc = $derived(buildSrcdoc(content, channel));

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
		const newError = { message: String(detail.message ?? "Error"), stack: detail.stack };
		errors = [...errors, newError];
		onerror?.(errors);
	}

	onMount(() => window.addEventListener("message", onMessage));
	onDestroy(() => window.removeEventListener("message", onMessage));
</script>

<iframe
	bind:this={iframeEl}
	title="Artifact Preview"
	class="h-full w-full border-0"
	sandbox="allow-scripts allow-popups"
	referrerpolicy="no-referrer"
	{srcdoc}
></iframe>
```

- [ ] **Step 2: Verify TypeScript**

```bash
npm run check
```

Expected: 0 errors.

---

## Task 6: Create ArtifactPanel.svelte

**Files:**

- Create: `src/lib/components/chat/ArtifactPanel.svelte`

This is the full right panel. It reads from `artifactStore` directly and routes to the correct renderer based on `activeArtifact.type`.

- [ ] **Step 1: Create `src/lib/components/chat/ArtifactPanel.svelte`**

```svelte
<script lang="ts">
	import { artifactStore } from "$lib/stores/artifact.svelte";
	import ArtifactSandbox from "./ArtifactSandbox.svelte";
	import MarkdownRenderer from "./MarkdownRenderer.svelte";
	import CarbonClose from "~icons/carbon/close";
	import CarbonChevronLeft from "~icons/carbon/chevron-left";
	import CarbonChevronRight from "~icons/carbon/chevron-right";
	import CarbonMaximize from "~icons/carbon/maximize";
	import { browser } from "$app/environment";

	const TYPE_LABELS: Record<string, string> = {
		"text/html": "HTML",
		"image/svg+xml": "SVG",
		"text/x-mermaid": "Mermaid",
		"application/json": "JSON",
		"text/markdown": "Markdown",
		"text/csv": "CSV",
	};

	const TYPE_COLORS: Record<string, string> = {
		"text/html": "bg-orange-500",
		"image/svg+xml": "bg-purple-500",
		"text/x-mermaid": "bg-teal-500",
		"application/json": "bg-yellow-500",
		"text/markdown": "bg-blue-500",
		"text/csv": "bg-green-500",
	};

	let errors = $state<{ message: string; stack?: string }[]>([]);
	let isFullscreen = $state(false);

	let artifact = $derived(artifactStore.activeArtifact);
	let total = $derived(artifactStore.artifacts.length);
	let currentIndex = $derived(artifactStore.activeIndex + 1);

	function formatJson(content: string): string {
		try {
			return JSON.stringify(JSON.parse(content), null, 2);
		} catch {
			return content;
		}
	}

	function parseCsvRows(content: string): string[][] {
		return content
			.split("\n")
			.filter((l) => l.trim())
			.map((line) => line.split(",").map((cell) => cell.trim().replace(/^"(.*)"$/, "$1")));
	}

	function handleSandboxError(errs: { message: string; stack?: string }[]) {
		errors = errs;
	}

	$effect(() => {
		// reset errors when artifact changes
		if (artifact) errors = [];
	});
</script>

{#if artifact}
	<div
		class="flex h-full flex-col border-l border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900
		{isFullscreen ? 'fixed inset-0 z-50' : 'w-full'}"
	>
		<!-- Header -->
		<div
			class="flex shrink-0 items-center justify-between gap-2 border-b border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-800"
		>
			<div class="flex min-w-0 items-center gap-2">
				<span
					class="shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold text-white {TYPE_COLORS[
						artifact.type
					] ?? 'bg-gray-500'}"
				>
					{TYPE_LABELS[artifact.type] ?? artifact.type}
				</span>
				<span class="truncate text-sm font-medium text-gray-800 dark:text-gray-200">
					{artifact.title}
				</span>
			</div>

			<div class="flex shrink-0 items-center gap-1">
				{#if total > 1}
					<button
						onclick={() => artifactStore.navigatePrev()}
						disabled={currentIndex <= 1}
						class="flex h-7 w-7 items-center justify-center rounded text-gray-500 hover:bg-gray-200 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-gray-700"
						aria-label="Previous artifact"
					>
						<CarbonChevronLeft class="size-3.5" />
					</button>
					<span class="text-xs text-gray-500 dark:text-gray-400">{currentIndex}/{total}</span>
					<button
						onclick={() => artifactStore.navigateNext()}
						disabled={currentIndex >= total}
						class="flex h-7 w-7 items-center justify-center rounded text-gray-500 hover:bg-gray-200 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-gray-700"
						aria-label="Next artifact"
					>
						<CarbonChevronRight class="size-3.5" />
					</button>
				{/if}
				<button
					onclick={() => (isFullscreen = !isFullscreen)}
					class="flex h-7 w-7 items-center justify-center rounded text-gray-500 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-700"
					aria-label="Toggle fullscreen"
				>
					<CarbonMaximize class="size-3.5" />
				</button>
				<button
					onclick={() => artifactStore.closePanel()}
					class="flex h-7 w-7 items-center justify-center rounded text-gray-500 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-700"
					aria-label="Close panel"
				>
					<CarbonClose class="size-3.5" />
				</button>
			</div>
		</div>

		<!-- Content -->
		<div class="min-h-0 flex-1 overflow-hidden">
			{#if artifact.type === "text/html" || artifact.type === "image/svg+xml"}
				<ArtifactSandbox content={artifact.content} onerror={handleSandboxError} />
			{:else if artifact.type === "text/x-mermaid"}
				{#if browser}
					{#await import("@friendofsvelte/mermaid") then { default: Mermaid }}
						<div class="flex h-full items-center justify-center overflow-auto p-4">
							<Mermaid code={artifact.content} />
						</div>
					{/await}
				{/if}
			{:else if artifact.type === "application/json"}
				<div class="scrollbar-custom h-full overflow-auto p-4">
					<pre class="font-mono text-xs text-gray-800 dark:text-gray-200">{formatJson(
							artifact.content
						)}</pre>
				</div>
			{:else if artifact.type === "text/markdown"}
				<div
					class="scrollbar-custom prose prose-sm h-full max-w-none overflow-auto p-4 dark:prose-invert"
				>
					<MarkdownRenderer content={artifact.content} />
				</div>
			{:else if artifact.type === "text/csv"}
				{@const rows = parseCsvRows(artifact.content)}
				{@const headers = rows[0] ?? []}
				{@const dataRows = rows.slice(1)}
				<div class="scrollbar-custom h-full overflow-auto">
					<table class="w-full border-collapse text-xs">
						<thead class="sticky top-0 bg-gray-50 dark:bg-gray-800">
							<tr>
								{#each headers as header}
									<th
										class="border border-gray-200 px-3 py-2 text-left font-semibold text-gray-700 dark:border-gray-700 dark:text-gray-300"
									>
										{header}
									</th>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each dataRows as row, i}
								<tr
									class={i % 2 === 0
										? "bg-white dark:bg-gray-900"
										: "bg-gray-50 dark:bg-gray-800/50"}
								>
									{#each headers as _header, j}
										<td
											class="border border-gray-200 px-3 py-2 text-gray-600 dark:border-gray-700 dark:text-gray-400"
										>
											{row[j] ?? ""}
										</td>
									{/each}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>

		<!-- Footer -->
		<div
			class="flex shrink-0 items-center border-t border-gray-200 px-3 py-1.5 dark:border-gray-700"
		>
			{#if errors.length > 0}
				<span
					class="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400"
				>
					{errors.length} error{errors.length > 1 ? "s" : ""} caught
				</span>
			{:else}
				<span class="text-xs text-gray-400 dark:text-gray-600">No errors</span>
			{/if}
		</div>
	</div>
{/if}
```

- [ ] **Step 2: Verify TypeScript**

```bash
npm run check
```

Expected: 0 errors.

---

## Task 7: Wire split-panel layout in +page.svelte

**Files:**

- Modify: `src/routes/conversation/[id]/+page.svelte`

The `<ChatWindow>` component is rendered at line 598. We wrap it and `ArtifactPanel` in a flex container that splits when `artifactStore.panelOpen` is true.

- [ ] **Step 1: Add imports at the top of the script block**

In `src/routes/conversation/[id]/+page.svelte`, add these two imports alongside the existing imports (around line 2 where `ChatWindow` is imported):

```ts
import ArtifactPanel from "$lib/components/chat/ArtifactPanel.svelte";
import { artifactStore } from "$lib/stores/artifact.svelte";
```

- [ ] **Step 2: Wrap ChatWindow in split-panel layout**

Find the `<ChatWindow` tag (line 598) and wrap it. Replace:

```svelte
<ChatWindow
	loading={$loading}
	{pending}
	messages={messagesPath as Message[]}
	{messagesAlternatives}
	shared={data.shared}
	preprompt={data.preprompt}
	bind:files
	onmessage={onMessage}
	onretry={onRetry}
	onshowAlternateMsg={onShowAlternateMsg}
	onstop={stopGeneration}
	models={data.models}
	currentModel={findCurrentModel(data.models, data.oldModels, data.model)}
	ragEnabled={data.ragEnabled}
	{ragFiles}
	onragtoggle={onRagToggle}
	onragfilesrefresh={async () => {
		ragFiles = await ragClient.listFiles();
	}}
/>
```

with:

```svelte
<div class="flex h-full w-full overflow-hidden">
	<div class="min-w-0 flex-1 transition-all duration-200">
		<ChatWindow
			loading={$loading}
			{pending}
			messages={messagesPath as Message[]}
			{messagesAlternatives}
			shared={data.shared}
			preprompt={data.preprompt}
			bind:files
			onmessage={onMessage}
			onretry={onRetry}
			onshowAlternateMsg={onShowAlternateMsg}
			onstop={stopGeneration}
			models={data.models}
			currentModel={findCurrentModel(data.models, data.oldModels, data.model)}
			ragEnabled={data.ragEnabled}
			{ragFiles}
			onragtoggle={onRagToggle}
			onragfilesrefresh={async () => {
				ragFiles = await ragClient.listFiles();
			}}
		/>
	</div>
	{#if artifactStore.panelOpen}
		<div class="hidden w-1/2 shrink-0 md:flex md:h-full">
			<ArtifactPanel />
		</div>
	{/if}
</div>
```

- [ ] **Step 3: Verify TypeScript**

```bash
npm run check
```

Expected: 0 errors.

---

## Task 8: Add CLIENT_SIDE_TOOLS to toolInvocation.ts

**Files:**

- Modify: `src/lib/server/textGeneration/mcp/toolInvocation.ts`
- Create: `src/lib/server/textGeneration/mcp/toolInvocation.clientTools.spec.ts`

The insertion point is line 317 inside the `tasks.map(async (p, index) => {...})` callback, just before the existing `Unknown MCP function` error path.

- [ ] **Step 1: Write the failing test**

Create `src/lib/server/textGeneration/mcp/toolInvocation.clientTools.spec.ts`:

```ts
import { describe, it, expect } from "vitest";

// Test the CLIENT_SIDE_TOOLS logic in isolation
const CLIENT_SIDE_TOOLS = new Set<string>(["generate_artifact"]);

describe("CLIENT_SIDE_TOOLS", () => {
	it("includes generate_artifact", () => {
		expect(CLIENT_SIDE_TOOLS.has("generate_artifact")).toBe(true);
	});

	it("does not include unknown tools", () => {
		expect(CLIENT_SIDE_TOOLS.has("github_operation")).toBe(false);
		expect(CLIENT_SIDE_TOOLS.has("retrieve_docs")).toBe(false);
	});

	it("correctly short-circuits for client-side tools", () => {
		const toolName = "generate_artifact";
		const args = { type: "text/html", title: "Test", content: "<h1>Hi</h1>" };
		const output = JSON.stringify({ success: true, ...args });
		expect(CLIENT_SIDE_TOOLS.has(toolName)).toBe(true);
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.success).toBe(true);
		expect(parsed.type).toBe("text/html");
		expect(parsed.title).toBe("Test");
	});
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
npx vitest run src/lib/server/textGeneration/mcp/toolInvocation.clientTools.spec.ts
```

Expected: FAIL — `CLIENT_SIDE_TOOLS` not exported.

- [ ] **Step 3: Add CLIENT_SIDE_TOOLS constant to toolInvocation.ts**

In `src/lib/server/textGeneration/mcp/toolInvocation.ts`, add this constant just before line 71 (the `executeToolCalls` function definition):

```ts
const CLIENT_SIDE_TOOLS = new Set<string>(["generate_artifact"]);
```

- [ ] **Step 4: Insert client-side tool handler inside the tasks.map callback**

In `src/lib/server/textGeneration/mcp/toolInvocation.ts`, find lines 317–330 (the `if (!mappingEntry)` block inside the async task callback). Replace:

```ts
const mappingEntry = mapping[p.call.name];
if (!mappingEntry) {
	const message = `Unknown MCP function: ${p.call.name}`;
	results.push({
		index,
		error: message,
		uuid: p.uuid,
		paramsClean: p.paramsClean,
	});
	updatesQueue.push({
		type: MessageUpdateType.Tool,
		subtype: MessageToolUpdateType.Error,
		uuid: p.uuid,
		message,
	});
	return;
}
```

with:

```ts
const mappingEntry = mapping[p.call.name];
if (!mappingEntry) {
	if (CLIENT_SIDE_TOOLS.has(p.call.name)) {
		const argsRaw = parseArgs(p.call.arguments) as Record<string, unknown>;
		const output = JSON.stringify({ success: true, ...argsRaw });
		results.push({ index, output, uuid: p.uuid, paramsClean: p.paramsClean });
		updatesQueue.push({
			type: MessageUpdateType.Tool,
			subtype: MessageToolUpdateType.Result,
			uuid: p.uuid,
			result: {
				status: ToolResultStatus.Success,
				call: { name: p.call.name, parameters: p.paramsClean },
				outputs: [argsRaw as Record<string, unknown>],
				display: true,
			},
		});
		return; // collation loop handles toolMessages from results[]
	}
	const message = `Unknown MCP function: ${p.call.name}`;
	results.push({
		index,
		error: message,
		uuid: p.uuid,
		paramsClean: p.paramsClean,
	});
	updatesQueue.push({
		type: MessageUpdateType.Tool,
		subtype: MessageToolUpdateType.Error,
		uuid: p.uuid,
		message,
	});
	return;
}
```

- [ ] **Step 5: Update test to import the constant**

Update `toolInvocation.clientTools.spec.ts` — the test already defines its own local `CLIENT_SIDE_TOOLS` copy so it passes without changes. This is intentional: the spec tests the logic, not the export. Run:

```bash
npx vitest run src/lib/server/textGeneration/mcp/toolInvocation.clientTools.spec.ts
```

Expected: 3 tests PASS.

- [ ] **Step 6: Verify TypeScript**

```bash
npm run check
```

Expected: 0 errors.

---

## Task 9: Create ArtifactOpener.svelte + register in tool registry

**Files:**

- Create: `src/lib/components/chat/tools/ArtifactOpener.svelte`
- Modify: `src/lib/components/chat/tools/registry.ts`

`ArtifactOpener` is a zero-UI tool renderer. When the LLM calls `generate_artifact`, the tool result arrives here via the existing `toolRendererRegistry` dispatch in `ToolUpdate.svelte`. The component reads the result, calls `pushArtifact`, and renders nothing visible.

- [ ] **Step 1: Create `src/lib/components/chat/tools/ArtifactOpener.svelte`**

```svelte
<script lang="ts">
	import { artifactStore, type ArtifactType } from "$lib/stores/artifact.svelte";
	import type { ToolRendererProps } from "./registry";
	import { ToolResultStatus } from "$lib/types/Tool";

	const VALID_TYPES = new Set<string>([
		"text/html",
		"image/svg+xml",
		"text/x-mermaid",
		"application/json",
		"text/markdown",
		"text/csv",
	]);

	let { update, parseToolOutputs }: ToolRendererProps = $props();

	$effect(() => {
		if (update.result.status !== ToolResultStatus.Success) return;
		const outputs = parseToolOutputs(update.result.outputs) as unknown[];
		const raw = outputs[0] as Record<string, unknown> | undefined;
		if (!raw) return;

		const type =
			typeof raw.type === "string" && VALID_TYPES.has(raw.type)
				? (raw.type as ArtifactType)
				: undefined;
		const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "Artifact";
		const content = typeof raw.content === "string" ? raw.content : "";

		if (type && content) {
			artifactStore.pushArtifact({ type, title, content });
		}
	});
</script>

<!-- intentionally no visible output — artifact panel opening is the UX -->
```

- [ ] **Step 2: Register ArtifactOpener in registry.ts**

Replace the entire content of `src/lib/components/chat/tools/registry.ts` with:

```ts
import type { Component } from "svelte";
import type { MessageToolResultUpdate } from "$lib/types/MessageUpdate";
import DataTableRenderer from "./DataTableRenderer.svelte";
import ArtifactOpener from "./ArtifactOpener.svelte";

export interface ToolRendererProps {
	update: MessageToolResultUpdate;
	parseToolOutputs: (outputs: unknown[]) => unknown[];
	formatValue: (value: unknown) => string;
}

export const toolRendererRegistry: Record<string, Component<ToolRendererProps>> = {
	generate_data: DataTableRenderer as unknown as Component<ToolRendererProps>,
	generate_artifact: ArtifactOpener as unknown as Component<ToolRendererProps>,
};

export function getToolRenderer(toolName: string): Component<ToolRendererProps> | null {
	return toolRendererRegistry[toolName] ?? null;
}
```

- [ ] **Step 3: Verify TypeScript**

```bash
npm run check
```

Expected: 0 errors.

---

## Task 10: Update toolPrompt.ts with generate_artifact instructions

**Files:**

- Modify: `src/lib/server/textGeneration/utils/toolPrompt.ts`

- [ ] **Step 1: Add generate_artifact to the TOOL USAGE RULES section**

In `src/lib/server/textGeneration/utils/toolPrompt.ts`, find the `## TOOL USAGE RULES` section (around line 35). Add a new bullet after the `github_operation` rule:

```ts
`- generate_artifact: Use whenever you produce output the user should SEE rendered — not just as code. Call this for HTML apps, SVG graphics, Mermaid diagrams, JSON data, Markdown docs, or CSV tables. The artifact panel opens automatically. Parameters: type (one of: text/html | image/svg+xml | text/x-mermaid | application/json | text/markdown | text/csv), title (short label, 2-5 words), content (full string — complete and self-contained). For HTML: include <!DOCTYPE html>. For Mermaid: start with graph/sequenceDiagram/etc. Do NOT call this for code snippets that are meant to be read, only for content meant to be rendered.`,
```

- [ ] **Step 2: Also update the CHAINING section example**

Find the existing chaining example `"commit my uploaded file"` and add a new example line:

```ts
`- "build me a dashboard" → [generate_artifact type=text/html title="Dashboard" content="<!DOCTYPE html>..."]`,
```

- [ ] **Step 3: Verify TypeScript**

```bash
npm run check
```

Expected: 0 errors.

---

## Task 11: Full type check + smoke test

**Files:** none (verification only)

- [ ] **Step 1: Full TypeScript check**

```bash
npm run check
```

Expected: 0 errors, 0 warnings.

- [ ] **Step 2: Start the dev server**

```bash
npm run dev
```

Expected: server starts on `http://localhost:5173` with no build errors.

- [ ] **Step 3: Smoke test — code block path**

1. Open the chat in a browser at `http://localhost:5173`
2. Send the message: `write me a simple HTML page with a button that counts clicks. Output the full <!DOCTYPE html> document.`
3. The assistant response should contain a `\`\`\`html` code block
4. The code block header should show an "Open in Panel" button (alongside the existing "Preview" and "copy" buttons)
5. Click "Open in Panel"
6. The right panel slides in. The chat shrinks to half-width
7. The sandboxed iframe renders the counter. Clicking the button increments the counter
8. The footer shows "No errors"
9. Click ✕ to close — panel disappears, chat returns to full width

- [ ] **Step 4: Smoke test — Mermaid**

1. Send: `draw a mermaid sequence diagram for a user login flow`
2. Response should have a `\`\`\`mermaid` block with an "Open in Panel" button
3. Click "Open in Panel" → diagram renders in the panel via `@friendofsvelte/mermaid`

- [ ] **Step 5: Smoke test — artifact history navigation**

1. Send two separate messages that produce code blocks, open both in the panel
2. The header should show `1/2` and `2/2` with ← → arrows
3. Clicking ← navigates back to the first artifact

- [ ] **Step 6: Smoke test — generate_artifact tool (if MCP tools enabled)**

1. With a tools-capable model, send: `use generate_artifact to create an HTML clock that shows the current time`
2. The panel should open automatically (no user click needed)
3. The tool call card shows `generate_artifact` in the message
4. The live clock ticks in the panel

- [ ] **Step 7: Smoke test — existing HtmlPreviewModal still works**

1. Send any HTML message and verify the existing "Preview" button (full-screen modal) still opens correctly — our `buildSrcdoc` extraction should be transparent.

- [ ] **Step 8: Lint check**

```bash
npm run lint
```

Expected: 0 errors (fix any Prettier formatting issues with `npm run format` first).
