# Agentic Artifact Registry — Design Spec

**Date:** 2026-05-21  
**Status:** Approved  
**Stack:** SvelteKit 2 / Svelte 5 / TypeScript / TailwindCSS

---

## Overview

Add a Claude-style artifact registry to chat-ui: a persistent split-panel that renders LLM-generated artifacts (HTML apps, SVG, Mermaid diagrams, JSON, CSV, Markdown) live in a sandboxed preview alongside the chat. Artifacts are triggered via two paths: automatic "Open in Panel" buttons on code blocks, and a new `generate_artifact` client-side tool the LLM can call explicitly.

---

## Goals

- LLM-generated HTML/SVG/Mermaid/JSON/CSV content renders live in a right-side panel.
- Any model works (code block path). Smart models that call `generate_artifact` get auto-open + metadata.
- Zero new backend MCP servers — `generate_artifact` is intercepted client-side.
- Reuse existing sandbox infrastructure (`HtmlPreviewModal.buildSrcdoc`) — no new iframe security work.
- Phase 1 ships 6 content types. React/JSX and Pyodide are explicitly out of scope.

---

## Architecture

### Two Trigger Paths → One Store

````
Path A (any model):
  LLM writes ```html / ```mermaid / ```svg / ```json / ```csv / ```markdown block
  → CodeBlock.svelte detects language
  → Shows "▶ Open in Panel" button
  → On click: pushes Artifact to artifactStore, sets panelOpen = true

Path B (smart models):
  LLM calls generate_artifact({ type, title, content })
  → executeToolCalls intercepts as CLIENT_SIDE_TOOL (no MCP server call)
  → Emits MessageToolResultUpdate with the artifact payload
  → ArtifactOpener.svelte (registered in toolRendererRegistry) receives update
  → Pushes to artifactStore + sets panelOpen = true automatically
````

### Artifact Store (`src/lib/stores/artifact.svelte.ts`)

Svelte 5 module-level `$state` — importable from any component.

```ts
export type ArtifactType =
	| "text/html"
	| "image/svg+xml"
	| "text/x-mermaid"
	| "application/json"
	| "text/markdown"
	| "text/csv";

export interface Artifact {
	id: string; // randomUUID()
	type: ArtifactType;
	title: string;
	content: string;
	createdAt: Date;
}

// Module-level reactive state
export let artifacts = $state<Artifact[]>([]);
export let activeArtifactId = $state<string | null>(null);
export let panelOpen = $state(false);

// Helpers
export function pushArtifact(artifact: Omit<Artifact, "id" | "createdAt">): void;
export function setActive(id: string): void;
export function closePanel(): void;
```

---

## Content Type Registry

| MIME Type          | Triggered by            | Renderer                                      |
| ------------------ | ----------------------- | --------------------------------------------- |
| `text/html`        | ` ```html ` or tool     | `ArtifactSandbox` (iframe + `buildSrcdoc`)    |
| `image/svg+xml`    | ` ```svg ` or tool      | `ArtifactSandbox` (SVG path in `buildSrcdoc`) |
| `text/x-mermaid`   | ` ```mermaid ` or tool  | `ArtifactMermaid` (`@friendofsvelte/mermaid`) |
| `application/json` | ` ```json ` or tool     | Formatted `<pre>` with syntax color           |
| `text/markdown`    | ` ```markdown ` or tool | Existing `MarkdownRenderer`                   |
| `text/csv`         | ` ```csv ` or tool      | Existing `DataTableRenderer` row parser       |

**Language → MIME mapping** in `CodeBlock.svelte`:

```ts
const ARTIFACT_LANGS: Record<string, ArtifactType> = {
	html: "text/html",
	svg: "image/svg+xml",
	mermaid: "text/x-mermaid",
	json: "application/json",
	markdown: "text/markdown",
	md: "text/markdown",
	csv: "text/csv",
};
```

The existing `showPreview` logic in `CodeBlock.svelte` (DOCTYPE / SVG sniff) is preserved for backward compatibility — the new "Open in Panel" button is additive.

---

## New Files

### `src/lib/stores/artifact.svelte.ts`

Module-level Svelte 5 state. Exports `artifacts`, `activeArtifactId`, `panelOpen`, `pushArtifact`, `setActive`, `closePanel`.

### `src/lib/components/chat/ArtifactPanel.svelte`

Right panel. Props: none (reads from artifactStore directly).

Structure:

```
<div class="flex flex-col h-full w-full">
  <!-- Header -->
  <div> [type badge] [title] [← 1/N →] [⤢ fullscreen] [✕ close] </div>
  <!-- Content area -->
  <div class="flex-1 overflow-hidden">
    {#if type === "text/html" || type === "image/svg+xml"}
      <ArtifactSandbox {content} />
    {:else if type === "text/x-mermaid"}
      <ArtifactMermaid {content} />
    {:else if type === "application/json"}
      <ArtifactJson {content} />
    {:else if type === "text/markdown"}
      <MarkdownRenderer {content} />
    {:else if type === "text/csv"}
      <ArtifactCsv {content} />
    {/if}
  </div>
  <!-- Footer: error pill from sandbox postMessage -->
  <div> [error count or "No errors"] </div>
</div>
```

Fullscreen opens a full-`dvh` overlay (same pattern as `HtmlPreviewModal`).

### `src/lib/components/chat/ArtifactSandbox.svelte`

Thin wrapper around the `buildSrcdoc` function extracted from `HtmlPreviewModal.svelte`. Accepts `content: string`, detects SVG vs HTML automatically (same logic as `HtmlPreviewModal`), renders `<iframe srcdoc sandbox="allow-scripts allow-popups" referrerpolicy="no-referrer">`. Forwards postMessage errors to parent via an `onerror` callback prop. Does **not** open a modal — it's an inline renderer.

### `src/lib/components/chat/ArtifactJson.svelte`

Inline component (no separate file needed beyond ~30 lines). Parses `content` as JSON, falls back to raw `<pre>` if invalid. Renders with `JSON.stringify(parsed, null, 2)` inside a scrollable `<pre class="font-mono text-sm">`. Defined inside `ArtifactPanel.svelte` as a local sub-component or a small standalone file.

### `src/lib/components/chat/ArtifactCsv.svelte`

Parses CSV rows using `papaparse` (already a common transitive dep — check `package.json`; if absent, use a 10-line manual split on `\n` and `,`). Renders as a scrollable table using the same styling conventions as `DataTableRenderer`. Defined inline in `ArtifactPanel.svelte` or as a small standalone file.

### `src/lib/components/chat/tools/ArtifactOpener.svelte`

A tool renderer registered for the `generate_artifact` tool in `registry.ts`. On mount, reads `update.result.outputs[0]` to extract `{ type, title, content }`, calls `pushArtifact(...)`, and renders nothing visible (the panel opening is the UX). If parsing fails, shows a small error inline.

---

## Modified Files

### `src/lib/components/CodeBlock.svelte`

Add after the existing `showPreview` derived:

```ts
const ARTIFACT_LANGS: Record<string, ArtifactType> = { ... }; // see above

// Extract language from the rendered code token
// rawCode already exists; language comes from the `lang` prop (add to interface)
interface Props { code?: string; rawCode?: string; loading?: boolean; lang?: string; }
let { code, rawCode, loading, lang }: Props = $props();

const artifactType = $derived(lang ? ARTIFACT_LANGS[lang.toLowerCase()] : undefined);
```

Add "Open in Panel" button alongside the existing "Preview" button:

```svelte
{#if artifactType}
	<button
		onclick={() => {
			pushArtifact({ type: artifactType, title: lang ?? "Artifact", content: rawCode });
		}}
	>
		▶ Open in Panel
	</button>
{/if}
```

The existing `showPreview` / `HtmlPreviewModal` flow is unchanged — the new button is additive.

**Note:** `lang` must be plumbed through from the markdown parser. Check `src/lib/utils/marked.ts` — the `CodeToken` type already carries `lang`. Pass it through `MarkdownBlock.svelte` → `CodeBlock.svelte`.

### `src/routes/conversation/[id]/+page.svelte`

Import `panelOpen` and `ArtifactPanel`. Wrap the existing `ChatWindow` in a flex container:

```svelte
<div class="flex h-full w-full overflow-hidden">
	<div class="min-w-0 flex-1 transition-all">
		<ChatWindow ... />
	</div>
	{#if panelOpen}
		<div class="hidden w-1/2 shrink-0 border-l border-gray-200 dark:border-gray-700 md:flex">
			<ArtifactPanel />
		</div>
	{/if}
</div>
```

Note: `panelOpen` is Svelte 5 module-level `$state` — imported directly, no `$` prefix needed (unlike Svelte 4 stores).

On `<768px` the panel is hidden in the flex layout and instead `ArtifactPanel` renders as a full-screen overlay (controlled by a `mobile` prop or a media query inside `ArtifactPanel`).

### `src/lib/components/chat/tools/registry.ts`

```ts
import ArtifactOpener from "./ArtifactOpener.svelte";

export const toolRendererRegistry: Record<string, Component<ToolRendererProps>> = {
	generate_data: DataTableRenderer as unknown as Component<ToolRendererProps>,
	generate_artifact: ArtifactOpener as unknown as Component<ToolRendererProps>,
};
```

### `src/lib/server/textGeneration/mcp/toolInvocation.ts`

Before the `Unknown MCP function` error block, add:

```ts
const CLIENT_SIDE_TOOLS = new Set(["generate_artifact"]);

// Inside the tasks.map(async (p, index) => { ... }) callback,
// BEFORE the existing "Unknown MCP function" error block:
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
		// toolMessages is built after all tasks complete in the collation loop;
		// store output in results so it gets picked up there — return early.
		return; // NOT continue — this is inside an async callback, not a for loop
	}
	// existing error path...
}
```

### `src/lib/server/textGeneration/utils/toolPrompt.ts`

Add to the `## TOOL USAGE RULES` section:

```
- generate_artifact: Use whenever you produce output the user should SEE rendered — HTML apps,
  SVG graphics, Mermaid diagrams, JSON data, Markdown documents, CSV tables. The artifact panel
  opens automatically. Parameters: type (text/html | image/svg+xml | text/x-mermaid |
  application/json | text/markdown | text/csv), title (short human label), content (full string).
  Prefer this over a bare code block for any self-contained renderable output.
```

---

## Package to Install

```bash
npm install @friendofsvelte/mermaid
```

All other renderers reuse existing code (`buildSrcdoc`, `MarkdownRenderer`, `DataTableRenderer`).

---

## Data Flow (end to end)

````
1. LLM streams message containing ```html block
2. MarkdownRenderer → MarkdownBlock → CodeBlock
3. CodeBlock detects lang="html" → renders "▶ Open in Panel" button
4. User clicks → pushArtifact({ type: "text/html", title: "html", content: rawCode })
5. artifactStore: artifacts.push(artifact), activeArtifactId = artifact.id, panelOpen = true
6. +page.svelte reacts: ArtifactPanel mounts in right column
7. ArtifactPanel renders ArtifactSandbox with the content in a sandboxed iframe
8. postMessage error hook reports runtime errors back to ArtifactPanel footer
````

```
1. LLM calls generate_artifact({ type: "text/x-mermaid", title: "Auth Flow", content: "..." })
2. executeToolCalls: CLIENT_SIDE_TOOLS intercepts, emits ToolResultUpdate
3. ArtifactOpener.svelte mounts (via toolRendererRegistry), calls pushArtifact on mount
4. Panel opens automatically — no user click needed
5. ArtifactPanel renders ArtifactMermaid with @friendofsvelte/mermaid
```

---

## Out of Scope (Phase 1)

- **React/JSX execution** — requires `@babel/standalone` inline transpilation. Deferred to Phase 2.
- **Pyodide (Python execution)** — 8MB+ Wasm bundle. Static code display only.
- **Multi-file sandpack playground** — deferred to Phase 2.
- **RAG file "Open in Panel"** — the `file.url` external link covers the need for now.
- **Artifact persistence across sessions** — artifacts live in memory only; page reload clears them.

---

## Testing Checklist

- [ ] HTML artifact opens in panel with live counter/button interactivity
- [ ] SVG artifact renders correctly (path through `buildSrcdoc` SVG branch)
- [ ] Mermaid diagram renders a flowchart without console errors
- [ ] JSON artifact formats a nested object with indentation
- [ ] Markdown artifact renders headings and code blocks
- [ ] CSV artifact parses rows into a table (reusing DataTableRenderer row logic)
- [ ] Panel history: 3 artifacts in a session, ← → navigation works
- [ ] Panel closes on ✕; "Open in Panel" re-opens it
- [ ] On mobile (`<768px`): panel renders as full-screen overlay, not side-by-side
- [ ] `generate_artifact` tool call: panel auto-opens without user click
- [ ] Runtime JS error in HTML artifact shows error pill in footer
- [ ] Existing "Preview" modal (HtmlPreviewModal) still works unchanged
- [ ] No TypeScript errors (`npm run check`)
