# Artifact Panel Layout Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `ArtifactPanel` from a fixed overlay in `+page.svelte` into the layout's CSS Grid as a third column, so the chat genuinely shrinks when the panel opens — without wrapping `ChatWindow` (which breaks its height chain).

**Architecture:** The layout's `fixed grid` is the only element with a true definite height. `ChatWindow` must remain a direct grid child of that element. We add a conditional `45vw` third column to the layout grid and render `ArtifactPanel` there. The `1fr` chat column shrinks automatically. The existing `transition-[grid-template-columns]` animation handles the slide.

**Tech Stack:** SvelteKit 2, Svelte 5 runes (`$state`, `$effect`, `$derived`), TailwindCSS JIT

---

## File Map

| File                                        | Change                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| `src/lib/stores/artifact.svelte.ts`         | Add `reset()` method                                                   |
| `src/routes/+layout.svelte`                 | Import store + panel, modify grid class, add panel cell, add nav guard |
| `src/routes/conversation/[id]/+page.svelte` | Remove 2 imports + fixed overlay block                                 |

`ChatWindow.svelte`, `ArtifactPanel.svelte`, `ArtifactSandbox.svelte`, `CodeBlock.svelte`, `ArtifactOpener.svelte`, `registry.ts`, `toolInvocation.ts` — **zero changes.**

---

### Task 1: Add `reset()` to the artifact store

**Files:**

- Modify: `src/lib/stores/artifact.svelte.ts`

- [ ] **Step 1: Add `reset()` method**

  Open `src/lib/stores/artifact.svelte.ts`. After the `openPanel()` method (the last method in the class, currently around line 55), add:

  ```ts
  reset(): void {
    this.artifacts = [];
    this.activeArtifactId = null;
    this.panelOpen = false;
  }
  ```

  The full class should end like this:

  ```ts
    openPanel(): void {
      this.panelOpen = true;
    }

    reset(): void {
      this.artifacts = [];
      this.activeArtifactId = null;
      this.panelOpen = false;
    }
  }

  export const artifactStore = new ArtifactStore();
  ```

- [ ] **Step 2: Verify no TypeScript errors**

  Run:

  ```bash
  cd /Users/siddesh.kale/Documents/chatui/chat-ui && npx svelte-check 2>&1 | grep "artifact.svelte"
  ```

  Expected: no output (no errors on that file).

---

### Task 2: Wire ArtifactPanel into the layout grid

**Files:**

- Modify: `src/routes/+layout.svelte`

The layout's grid div is at line 254–258. `{@render children?.()}` is at line 315.

- [ ] **Step 1: Add imports**

  In the `<script>` block of `src/routes/+layout.svelte`, after the existing imports (the last import is currently `import CheatsheetModal ...`), add:

  ```ts
  import { artifactStore } from "$lib/stores/artifact.svelte";
  import ArtifactPanel from "$lib/components/chat/ArtifactPanel.svelte";
  ```

- [ ] **Step 2: Add the navigation guard `$effect`**

  In the `<script>` block, after the existing `$effect` blocks (search for the last `$effect` in the script), add:

  ```ts
  $effect(() => {
  	void page.url.pathname;
  	if (!page.url.pathname.startsWith("/conversation/")) {
  		artifactStore.reset();
  	}
  });
  ```

  Note: `page` is already imported at line 6 via `import { page } from "$app/state";` — no new import needed.

- [ ] **Step 3: Modify the grid class**

  Find the grid div (lines 254–258). Its current class expression is:

  ```svelte
  class="fixed grid h-full w-screen grid-cols-1 grid-rows-[auto,1fr] overflow-hidden text-smd {!isNavCollapsed
  	? "md:grid-cols-[290px,1fr]"
  	: "md:grid-cols-[0px,1fr]"} transition-[300ms] [transition-property:grid-template-columns] dark:text-gray-300
  md:grid-rows-[1fr]"
  ```

  Replace it with:

  ```svelte
  class="fixed grid h-full w-screen grid-cols-1 grid-rows-[auto,1fr] overflow-hidden text-smd {artifactStore.panelOpen
  	? !isNavCollapsed
  		? "md:grid-cols-[290px,1fr,45vw]"
  		: "md:grid-cols-[0px,1fr,45vw]"
  	: !isNavCollapsed
  		? "md:grid-cols-[290px,1fr]"
  		: "md:grid-cols-[0px,1fr]"} transition-[300ms] [transition-property:grid-template-columns] dark:text-gray-300
  md:grid-rows-[1fr]"
  ```

- [ ] **Step 4: Add panel grid cell after `{@render children?.()}`**

  Find line 315: `{@render children?.()}`. After it, add:

  ```svelte
  {#if artifactStore.panelOpen}
  	<div class="hidden h-full overflow-hidden md:flex md:flex-col">
  		<ArtifactPanel />
  	</div>
  {/if}
  ```

  The block goes immediately after `{@render children?.()}`, before the `{#if publicConfig.PUBLIC_PLAUSIBLE_SCRIPT_URL}` block.

- [ ] **Step 5: Verify**

  Run:

  ```bash
  cd /Users/siddesh.kale/Documents/chatui/chat-ui && npx svelte-check 2>&1 | grep -E "\+layout|ArtifactPanel" | head -20
  ```

  Expected: no errors on `+layout.svelte`.

---

### Task 3: Remove the fixed overlay from `+page.svelte`

**Files:**

- Modify: `src/routes/conversation/[id]/+page.svelte`

- [ ] **Step 1: Remove `ArtifactPanel` import (line 3)**

  Remove this line:

  ```ts
  import ArtifactPanel from "$lib/components/chat/ArtifactPanel.svelte";
  ```

- [ ] **Step 2: Remove `artifactStore` import (line 4)**

  Remove this line:

  ```ts
  import { artifactStore } from "$lib/stores/artifact.svelte";
  ```

- [ ] **Step 3: Remove the fixed overlay block**

  Find and remove the entire block (currently after the `ChatWindow` closing `/>`, before `{#if showSafetyModal}`):

  ```svelte
  {#if artifactStore.panelOpen}
  	<div
  		class="fixed inset-y-0 right-0 z-40 hidden w-[45vw] border-l border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900 md:flex md:flex-col"
  	>
  		<ArtifactPanel />
  	</div>
  {/if}
  ```

  After removal, the template should go directly from `/>` (ChatWindow close) to `{#if showSafetyModal}`.

- [ ] **Step 4: Verify**

  Run:

  ```bash
  cd /Users/siddesh.kale/Documents/chatui/chat-ui && npx svelte-check 2>&1 | tail -5
  ```

  Expected: same error count as before these changes (21 pre-existing errors, all in unrelated files). No new errors.

---

### Task 4: Smoke test

- [ ] **Step 1: Start the dev server**

  ```bash
  cd /Users/siddesh.kale/Documents/chatui/chat-ui && npm run dev
  ```

  Expected: server starts on `http://localhost:5173`, no build errors in console.

- [ ] **Step 2: Verify chat layout is intact (no panel)**

  Open `http://localhost:5173`. Start or open a conversation. Send a message. Confirm:

  - Input box sits at the bottom of the viewport
  - Input is typeable after the LLM responds
  - RAG toggle is clickable
  - Scroll-to-bottom works

- [ ] **Step 3: Verify split panel opens correctly**

  In the chat, ask for an HTML artifact (e.g. `write me a simple HTML counter app`). When the response has a ` ```html ` code block, click **Open in Panel**. Confirm:

  - Panel slides in from the right
  - Chat shrinks to ~55% width (left column is `1fr`, panel is `45vw`)
  - Transition is smooth (no jump)
  - Chat input and RAG toggle remain interactive
  - Panel renders the sandboxed iframe

- [ ] **Step 4: Verify panel close**

  Click ✕ in the panel header. Confirm:

  - Panel slides out
  - Chat expands back to full width
  - Transition is smooth

- [ ] **Step 5: Verify navigation guard**

  With the panel open, navigate to `/` (home). Confirm:

  - Panel disappears
  - Returning to the conversation shows no lingering panel

- [ ] **Step 6: Verify backward-compat HtmlPreviewModal**

  Click the existing **Preview** button (not "Open in Panel") on any HTML code block. Confirm the full-screen preview modal still opens correctly.
