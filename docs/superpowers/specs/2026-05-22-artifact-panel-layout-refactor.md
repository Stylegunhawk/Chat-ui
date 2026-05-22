# Artifact Panel Layout Refactor — Design Spec
**Date:** 2026-05-22
**Status:** Approved
**Stack:** SvelteKit 2 / Svelte 5 / TailwindCSS

---

## Problem

Adding any wrapper div around `ChatWindow` in `+page.svelte` breaks the chat layout. `ChatWindow`'s scroll container uses `h-full` which requires `ChatWindow`'s root div (`relative z-[-1]`) to be a **direct grid child** of the layout's `1fr` row. A wrapper div — whether `flex`, `flex-col`, or `grid` — breaks this height chain because block-context children of those containers get `height: auto`, not the parent's definite height.

The previous implementation put `ArtifactPanel` as a `position: fixed` sibling overlay in `+page.svelte`. This restored chat interactivity but the panel overlaps the chat instead of splitting it.

---

## Solution

Move `ArtifactPanel` into `+layout.svelte` as a **third grid column** in the same CSS Grid that owns the nav and content columns. `ChatWindow` stays as a direct layout grid item — height chain preserved. The `1fr` content column shrinks automatically when the panel column is added.

---

## Architecture

### Grid column states

```
Panel closed:  [nav: 290px or 0px] [chat: 1fr           ]
Panel open:    [nav: 290px or 0px] [chat: 1fr  ] [panel: 45vw]
```

The existing `transition-[grid-template-columns]` animation already on the layout grid handles the open/close slide transition — no additional CSS needed.

### Ownership

| Concern | Owner |
|---|---|
| Artifact state (list, active, panelOpen) | `artifact.svelte.ts` store |
| Panel column in grid | `+layout.svelte` |
| Panel content | `ArtifactPanel.svelte` |
| "Open in Panel" button | `CodeBlock.svelte` → `artifactStore.pushArtifact()` |
| Auto-open via tool call | `ArtifactOpener.svelte` → `artifactStore.pushArtifact()` |

---

## File Changes

### `src/lib/stores/artifact.svelte.ts`

Add a `reset()` method to the `ArtifactStore` class:

```ts
reset(): void {
  this.artifacts = [];
  this.activeArtifactId = null;
  this.panelOpen = false;
}
```

Used when navigating away from a conversation page so stale artifacts don't reappear.

---

### `src/routes/+layout.svelte`

**1. Add imports** (in `<script>`):

```ts
import { artifactStore } from "$lib/stores/artifact.svelte";
import ArtifactPanel from "$lib/components/chat/ArtifactPanel.svelte";
```

**2. Modify the grid class expression** — add panel column when open:

```svelte
{artifactStore.panelOpen
  ? (!isNavCollapsed ? 'md:grid-cols-[290px,1fr,45vw]' : 'md:grid-cols-[0px,1fr,45vw]')
  : (!isNavCollapsed ? 'md:grid-cols-[290px,1fr]'      : 'md:grid-cols-[0px,1fr]')
}
```

The rest of the grid class string (`fixed grid h-full w-screen grid-rows-[auto,1fr] overflow-hidden ... md:grid-rows-[1fr]`) is unchanged.

**3. Add panel column cell** after `{@render children?.()}`:

```svelte
{#if artifactStore.panelOpen}
  <div class="hidden h-full overflow-hidden md:flex md:flex-col">
    <ArtifactPanel />
  </div>
{/if}
```

**4. Add navigation guard** (in `<script>`, after `page` is available):

```ts
$effect(() => {
  void page.url.pathname; // reactive dependency
  if (!page.url.pathname.startsWith('/conversation/')) {
    artifactStore.reset();
  }
});
```

---

### `src/routes/conversation/[id]/+page.svelte`

**Remove:**
- `import ArtifactPanel from "$lib/components/chat/ArtifactPanel.svelte";`
- `import { artifactStore } from "$lib/stores/artifact.svelte";`
- The `{#if artifactStore.panelOpen}` fixed-overlay block (the entire `<div class="fixed ...">` block)

`ChatWindow` and all its props remain **completely unchanged**.

---

### `src/lib/components/chat/ArtifactPanel.svelte`

**No changes required.** The component's own root element (`flex h-full flex-col`) fills whatever container it's placed in. The `isFullscreen` toggle (`fixed inset-0 z-50`) continues to work correctly as a viewport overlay.

---

## Behavior

### Desktop (≥ md)
- Panel closed: chat fills `1fr`, full width
- Panel opens: grid transitions to `[nav][1fr][45vw]`; chat narrows, panel slides in from right
- Panel closes: grid transitions back to `[nav][1fr]`; chat expands to full width
- Transition: animated via existing `transition-[grid-template-columns]`

### Mobile (< md)
- Panel column is hidden (`hidden ... md:flex`)
- On mobile, `ArtifactPanel` is not rendered (the `{#if}` block and `hidden` class together suppress it)
- Mobile artifact viewing is out of scope for this refactor — the "Open in Panel" button is a future enhancement for mobile

### Navigation guard
- Navigating to any page other than `/conversation/*` resets the artifact store
- This prevents stale artifacts from reappearing when returning to a conversation

---

## What Does NOT Change

- `ChatWindow.svelte` — zero modifications
- `ArtifactSandbox.svelte` — zero modifications
- `CodeBlock.svelte` — zero modifications
- `ArtifactOpener.svelte` — zero modifications
- `registry.ts` — zero modifications
- `toolInvocation.ts` — zero modifications
- `toolPrompt.ts` — zero modifications
- All test files — zero modifications

---

## Testing Checklist

- [ ] Chat input and RAG toggle are interactive before and after a message exchange
- [ ] Chat input and RAG toggle remain interactive when artifact panel is open
- [ ] On desktop: panel opens and chat shrinks side by side
- [ ] On desktop: panel closes and chat expands back to full width
- [ ] Column transition animates smoothly (no jump)
- [ ] Navigating to `/` or `/settings` resets artifact store (panel closes, artifacts cleared)
- [ ] Returning to a conversation starts with empty artifact store
- [ ] Existing `HtmlPreviewModal` still opens correctly (backward compat)
- [ ] `npm run check` — no new TypeScript errors
