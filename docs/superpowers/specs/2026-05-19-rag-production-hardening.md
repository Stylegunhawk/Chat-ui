# RAG Production Hardening Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close four production-readiness gaps in the frontend RAG system: timeouts, dead code / unused routing helpers, embedding-ready UX guard, and type safety / constant deduplication.

**Architecture:** Four independent categories of changes, each touching 1-3 files. No new abstractions introduced — fixes are applied at the call sites that already exist. All changes are backwards-compatible; graceful-degradation paths already handle empty chunks.

**Tech Stack:** SvelteKit 2, Svelte 5, TypeScript strict, Vitest

---

## Category 1: Resilience — Timeout + Graceful Degradation

### Problem

`ragAgent.execute()` makes `fetch` calls with no timeout. If the RAG backend is slow or unreachable, the entire streaming chat response hangs until Node's default socket timeout (~2 minutes). This is a production-blocking issue.

### Fix

Add a `withTimeout<T>(ms: number, promise: Promise<T>): Promise<T>` helper inside `ragAgent.ts`. It races the given promise against a `setTimeout` rejection. On timeout, the error is caught by the existing `try/catch` in `execute()`, which already returns `[]` on failure — so chat continues without RAG context.

**Timeout values:**

- `SEARCH` strategy: **5 000 ms** — single backend round-trip with reranking
- `SUMMARIZE_FILE` / `SUMMARIZE_ALL` strategy: **10 000 ms** — parallel file chunk reads, more data

**Behavior on timeout:**

- Log: `[RagAgent] Backend timeout after ${ms}ms for strategy ${plan.strategy} — degrading gracefully`
- Return `[]` (existing empty-chunk path: LLM answers without RAG context, no crash)

**File:** `src/lib/server/rag/ragAgent.ts`

```typescript
function withTimeout<T>(ms: number, promise: Promise<T>): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) =>
			setTimeout(() => reject(new Error(`RAG timeout after ${ms}ms`)), ms)
		),
	]);
}
```

Usage in `execute()`:

```typescript
const TIMEOUT_SEARCH_MS = 5_000;
const TIMEOUT_SUMMARIZE_MS = 10_000;

// In SEARCH branch:
const resp = await withTimeout(
  TIMEOUT_SEARCH_MS,
  this.ragClient.semanticSearch({ ... })
);

// In SUMMARIZE branch (per file task):
const result = await withTimeout(
  TIMEOUT_SUMMARIZE_MS,
  this.ragClient.getFileChunks(fp.fileId, fp.limit ?? 8, 0) as Promise<SemanticSearchResponse>
);
```

---

## Category 2: Query Quality — `inferActiveFile` + Delete Dead Code

### Problem A: `inferActiveFile` never called

`inferActiveFile()` is exported from `ragRouter.ts` but never used in `ragAgent.ts`. The intended use case: user has exactly one file uploaded and asks something like "what does the uploaded file do?" — no explicit filename, `findFileMatch()` returns `undefined`, `isSummarize` could be false (since "what does" isn't in `SUMMARIZE_VERBS` unless it's "what does this file"). The query falls to SEARCH.

Even with the file-list preamble fix, SEARCH returns top-5 semantic snippets. SUMMARIZE_FILE returns the full sequential file content — far better for "explain what this file does" intent.

**Fix:** In `classify()`, after the `explicitFile && isSummarize` check, add a fallback: if `!explicitFile` and `availableFiles.length === 1` and the query is not a meta query and no global summarize matched, call `inferActiveFile(conversationHistory, availableFiles)`. If it returns a file (it always will when `length === 1`), route to `SUMMARIZE_FILE`.

```typescript
// After the explicitFile + isSummarize branch:
if (!explicitFile && availableFiles.length === 1) {
	const activeFile = inferActiveFile(conversationHistory, availableFiles);
	if (activeFile && isSummarize) {
		const totalChunks = activeFile.chunkCount ?? 10;
		const isPdf = activeFile.name.toLowerCase().endsWith(".pdf");
		const limit = Math.min(totalChunks, 20) + (isPdf ? 3 : 0);
		return {
			strategy: "SUMMARIZE_FILE",
			searchQuery: userQuery,
			historyContext,
			filePlans: [{ fileId: activeFile.id, fileName: activeFile.name, action: "DEEP_DIVE", limit }],
		};
	}
}
```

**Note:** Only trigger when `isSummarize` is true AND single file. Vague queries like "what does it do?" without a summarize verb still go to SEARCH (correct — SEARCH + file list preamble handles those well).

**File:** `src/lib/server/rag/ragAgent.ts`

### Problem B: `queryRewriter.ts` is dead code

`queryRewriter.ts` exports `rewriteQueryWithHistory()` which calls `generateFromDefaultEndpoint` (an LLM). Nothing in `ragAgent.ts` imports it. It was superseded when the LLM planner was removed. Leaving it risks:

- A future contributor accidentally re-importing it and reintroducing LLM latency
- Confusion about whether query rewriting is active

**Fix:** Delete `src/lib/server/rag/queryRewriter.ts`.

### Tests to add

**File:** `src/lib/server/rag/ragAgent.spec.ts`

```typescript
it("routes single-file + summarize verb with no explicit name → SUMMARIZE_FILE", () => {
	const files = [{ id: "f1", name: "service.ts", chunkCount: 12 }];
	const plan = agent.classify("summarize this", files, []);
	expect(plan.strategy).toBe("SUMMARIZE_FILE");
	expect(plan.filePlans[0].fileId).toBe("f1");
});

it("does NOT route to SUMMARIZE_FILE when multi-file + no explicit name", () => {
	const files = [
		{ id: "f1", name: "a.ts", chunkCount: 8 },
		{ id: "f2", name: "b.ts", chunkCount: 8 },
	];
	const plan = agent.classify("summarize this", files, []);
	expect(plan.strategy).toBe("SUMMARIZE_ALL");
});
```

---

## Category 3: UX Correctness — Embedding-Ready Guard

### Problem

After file upload, `finishEmbedding` is `false` while the backend chunks and embeds the file (can take 5-30s). If the user sends a message immediately, RAG retrieval returns zero chunks silently. The LLM responds as if no files exist — confusing and trust-eroding.

### Fix

In `+server.ts`, just before `ragAgent.run()`, inspect `mergedFiles` for unready files. Two cases:

**Case 1 — Query references a specific file that isn't ready:**
Skip RAG entirely and prepend a targeted note to the user message so the LLM can explain:

```
Note: "[filename]" is still being processed (embedding in progress). Please wait a moment and try again.
```

**Case 2 — Some files not ready but query is general:**
Run RAG normally (ready files will be searched) but prepend a softer warning:

```
Note: Some uploaded files are still being processed and may not appear in search results yet.
```

**Implementation location:** `src/routes/conversation/[id]/+server.ts`, inside the `if (conv.ragEnabled !== false && userQuery)` block, before `ragAgent.run()`.

```typescript
const notReadyFiles = mergedFiles.filter((f) => !f.finishEmbedding);
if (notReadyFiles.length > 0) {
	const referencedNotReady = notReadyFiles.find((f) =>
		userQuery.toLowerCase().includes(f.name.toLowerCase().split(".")[0])
	);
	const lastMsg = messagesForPrompt[messagesForPrompt.length - 1];
	if (referencedNotReady && lastMsg?.from === "user") {
		lastMsg.content = `Note: "${referencedNotReady.name}" is still being processed (embedding in progress). Please wait a moment and try again.\n\n---\n\n${lastMsg.content}`;
	} else if (lastMsg?.from === "user") {
		lastMsg.content = `Note: Some uploaded files are still being processed and may not appear in search results yet.\n\n---\n\n${lastMsg.content}`;
	}
}
```

**File:** `src/routes/conversation/[id]/+server.ts`

---

## Category 4: Type Safety + Proxy Constant Deduplication

### Problem A: `unknown` return types in server RAG client

`src/lib/server/rag/client.ts`:

- `listFiles()` returns `Promise<unknown[]>` — should be `Promise<RagFileMetadata[]>`
- `getFileChunks()` returns `Promise<unknown>` — should be `Promise<SemanticSearchResponse>`
- `deleteFile()` returns `Promise<unknown>` — should be `Promise<void>` (callers don't use the body)

The shared types already exist in `$lib/rag/client`. Import and use them.

```typescript
import type { RagFileMetadata, SemanticSearchResponse } from "$lib/rag/client";

async listFiles(): Promise<RagFileMetadata[]> { ... }
async getFileChunks(fileId: string, limit = 5, offset = 0): Promise<SemanticSearchResponse> { ... }
async deleteFile(fileId: string): Promise<void> { ... }
```

**File:** `src/lib/server/rag/client.ts`

### Problem B: `RAG_BASE_URL` duplicated in 5 proxy routes

Each of the 5 proxy routes has:

```typescript
const RAG_BASE_URL = process.env.RAG_BASE_URL || "http://localhost:8000";
// or
const RAG_BASE_URL = env.RAG_BASE_URL || "http://localhost:8000";
```

`RAG_BASE_URL` is already exported from `src/lib/server/rag/client.ts`. Replace inline declarations with:

```typescript
import { RAG_BASE_URL } from "$lib/server/rag/client";
```

**Files:**

- `src/routes/api/v1/rag/chunk/semanticSearchForChat/+server.ts`
- `src/routes/api/v1/rag/file/[id]/+server.ts`
- `src/routes/api/v1/rag/file/[id]/chunks/+server.ts`
- `src/routes/api/v1/rag/file/upload/+server.ts`
- `src/routes/api/v1/rag/files/+server.ts`

---

## Summary of Files Changed

| File                                                           | Change                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------ |
| `src/lib/server/rag/ragAgent.ts`                               | Add `withTimeout`, timeout constants, wire `inferActiveFile` |
| `src/lib/server/rag/ragAgent.spec.ts`                          | Add 2 new classifier tests                                   |
| `src/lib/server/rag/queryRewriter.ts`                          | **Delete**                                                   |
| `src/lib/server/rag/client.ts`                                 | Fix `listFiles`, `getFileChunks`, `deleteFile` return types  |
| `src/routes/conversation/[id]/+server.ts`                      | Add embedding-ready guard                                    |
| `src/routes/api/v1/rag/chunk/semanticSearchForChat/+server.ts` | Import shared `RAG_BASE_URL`                                 |
| `src/routes/api/v1/rag/file/[id]/+server.ts`                   | Import shared `RAG_BASE_URL`                                 |
| `src/routes/api/v1/rag/file/[id]/chunks/+server.ts`            | Import shared `RAG_BASE_URL`                                 |
| `src/routes/api/v1/rag/file/upload/+server.ts`                 | Import shared `RAG_BASE_URL`                                 |
| `src/routes/api/v1/rag/files/+server.ts`                       | Import shared `RAG_BASE_URL`                                 |

**Total:** 10 files (1 deleted, 9 modified)

## Non-Goals

- Rate limiting on proxy routes (infrastructure concern, not app-layer)
- Streaming progress indicator during RAG retrieval (separate UI feature)
- fileIds scoping on semanticSearch (backend already scopes by tenant)
