# RAG Thin Frontend Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

teh **Goal:** Replace the frontend's LLM planner + strategy engine with a 3-bucket regex classifier that delegates all intelligence (intent classification, query expansion, reranking, graph expansion) to the backend's `semanticSearchForChat` endpoint.

**Architecture:** The frontend `RagAgent` becomes a thin router: META queries answer from the file list with no backend call; SUMMARIZE queries use sequential `getFileChunks` (preserving chunk order for summarization); all other queries go directly to `semanticSearchForChat` and let the backend's Phase 12A pipeline handle the rest. The citation UI gains a provenance label ("via file::entity") on graph-expanded dependency chunks.

**Tech Stack:** SvelteKit 2, Svelte 5, TypeScript strict, Vitest

---

## File Map

| Action | Path | Responsibility |
|--------|------|---------------|
| **Modify** | `src/lib/rag/client.ts` | Add `expanded_from?: string` and `similarity: number \| null` to `ChatFileChunk` |
| **Rewrite** | `src/lib/server/rag/ragAgent.ts` | 3-bucket classifier + simplified execute; remove LLM planner |
| **Delete** | `src/lib/server/rag/ragPlanner.ts` | LLM planner — no longer needed |
| **Delete** | `src/lib/server/rag/ragAgentLegacy.ts` | Regex planner — logic inlined into new ragAgent.ts |
| **Modify** | `src/lib/server/rag/contextBuilder.ts` | Update strategy names in budget calc; add `expanded_from` to `<coderef>` block |
| **Modify** | `src/lib/components/chat/RagReferenceCard.svelte` | Provenance label + null-score guard for graph-expanded dependency chunks |
| **Modify** | `src/routes/conversation/[id]/+server.ts` | Remove `generateFromDefaultEndpoint` import and `locals` arg from `ragAgent.run()` |
| **Create** | `src/lib/server/rag/ragAgent.spec.ts` | Unit tests for the 3-bucket classifier |

---

## Task 1: Update shared `ChatFileChunk` type

**Files:**
- Modify: `src/lib/rag/client.ts:17-27`

- [ ] **Step 1.1: Write failing test**

Create `src/lib/server/rag/ragAgent.spec.ts` with this initial type guard test:

```typescript
import { describe, expect, test } from "vitest";

// Type-level test: verify ChatFileChunk accepts expanded_from and null similarity
import type { ChatFileChunk } from "$lib/rag/client";

describe("ChatFileChunk type contract", () => {
	test("accepts null similarity (graph-expanded chunk)", () => {
		const chunk: ChatFileChunk = {
			id: "c1",
			fileId: "f1",
			filename: "auth.py",
			fileType: "text/x-python",
			fileUrl: "http://localhost/auth.py",
			text: "def auth(): pass",
			similarity: null,
			role: "dependency",
			expanded_from: "utils.py::decode_jwt",
		};
		expect(chunk.similarity).toBeNull();
		expect(chunk.expanded_from).toBe("utils.py::decode_jwt");
	});
});
```

- [ ] **Step 1.2: Run test to confirm it fails**

```bash
cd /Users/siddesh.kale/Documents/chatui/chat-ui
npx vitest run src/lib/server/rag/ragAgent.spec.ts
```

Expected: TypeScript error — `similarity: null` not assignable to `number`; `expanded_from` does not exist.

- [ ] **Step 1.3: Update `ChatFileChunk` in `src/lib/rag/client.ts`**

Replace lines 17–27:

```typescript
export interface ChatFileChunk {
	id: string;
	fileId: string;
	filename: string;
	fileType: string;
	fileUrl: string;
	text: string;
	similarity: number | null;
	pageNumber?: number | null;
	role: "entry" | "dependency" | "supporting";
	/** QID of the chunk this was graph-expanded from (backend Phase 10.1) */
	expanded_from?: string;
}
```

- [ ] **Step 1.4: Run test to confirm it passes**

```bash
npx vitest run src/lib/server/rag/ragAgent.spec.ts
```

Expected: PASS

- [ ] **Step 1.5: Commit**

```bash
git add src/lib/rag/client.ts src/lib/server/rag/ragAgent.spec.ts
git commit -m "feat(rag): add expanded_from and nullable similarity to ChatFileChunk"
```

---

## Task 2: Rewrite `ragAgent.ts` — 3-bucket classifier

**Files:**
- Rewrite: `src/lib/server/rag/ragAgent.ts`

- [ ] **Step 2.1: Add classifier unit tests to `ragAgent.spec.ts`**

Append to `src/lib/server/rag/ragAgent.spec.ts`:

```typescript
import { RagAgent } from "$lib/server/rag/ragAgent";
import type { RagFileContext } from "$lib/server/rag/ragRouter";

// Minimal RAGClient stub — only classify() is called (no network)
const noopClient = {} as Parameters<typeof RagAgent>[0];

const files: RagFileContext[] = [
	{ id: "f1", name: "auth.py", chunkCount: 15 },
	{ id: "f2", name: "utils.ts", chunkCount: 8 },
];

describe("RagAgent.classify — 3-bucket router", () => {
	test("META: file list query returns NO_RAG", () => {
		const agent = new RagAgent(noopClient);
		const plan = agent.classify("what files do I have?", files, []);
		expect(plan.strategy).toBe("NO_RAG");
	});

	test("META: show uploaded files returns NO_RAG", () => {
		const agent = new RagAgent(noopClient);
		const plan = agent.classify("show me my uploaded files", files, []);
		expect(plan.strategy).toBe("NO_RAG");
	});

	test("SUMMARIZE_FILE: named file + summarize verb", () => {
		const agent = new RagAgent(noopClient);
		const plan = agent.classify("summarize auth.py", files, []);
		expect(plan.strategy).toBe("SUMMARIZE_FILE");
		expect(plan.filePlans).toHaveLength(1);
		expect(plan.filePlans[0].fileId).toBe("f1");
	});

	test("SUMMARIZE_FILE: PDF gets extra offset chunks", () => {
		const pdfFiles: RagFileContext[] = [{ id: "p1", name: "report.pdf", chunkCount: 10 }];
		const agent = new RagAgent(noopClient);
		const plan = agent.classify("summarize report.pdf", pdfFiles, []);
		expect(plan.strategy).toBe("SUMMARIZE_FILE");
		// limit = min(10,20) + 3 (pdf offset) = 13
		expect(plan.filePlans[0].limit).toBe(13);
	});

	test("SUMMARIZE_ALL: global summarize with files returns SUMMARIZE_ALL", () => {
		const agent = new RagAgent(noopClient);
		const plan = agent.classify("summarize all my files", files, []);
		expect(plan.strategy).toBe("SUMMARIZE_ALL");
		expect(plan.filePlans).toHaveLength(2);
	});

	test("SUMMARIZE_ALL: global summarize with no files returns SEARCH", () => {
		const agent = new RagAgent(noopClient);
		const plan = agent.classify("summarize all my files", [], []);
		// No files to summarize — fall through to SEARCH
		expect(plan.strategy).toBe("SEARCH");
	});

	test("SEARCH: general question delegates to backend", () => {
		const agent = new RagAgent(noopClient);
		const plan = agent.classify("how does authentication work?", files, []);
		expect(plan.strategy).toBe("SEARCH");
		expect(plan.filePlans).toHaveLength(0);
	});

	test("SEARCH: code structure query delegates to backend (not HYBRID)", () => {
		const agent = new RagAgent(noopClient);
		const plan = agent.classify("what does auth.py import from utils.ts?", files, []);
		expect(plan.strategy).toBe("SEARCH");
	});

	test("SEARCH: named file without summarize verb delegates to backend", () => {
		const agent = new RagAgent(noopClient);
		const plan = agent.classify("explain the validate function in auth.py", files, []);
		expect(plan.strategy).toBe("SEARCH");
	});
});
```

- [ ] **Step 2.2: Run tests to confirm they fail**

```bash
npx vitest run src/lib/server/rag/ragAgent.spec.ts
```

Expected: Failures on `classify` method not existing (or wrong strategy returns) — confirms tests are actually testing the new code.

- [ ] **Step 2.3: Rewrite `src/lib/server/rag/ragAgent.ts`**

Replace the entire file with:

```typescript
/**
 * RAG Agent — 3-Bucket Frontend Router
 *
 * Classifies queries into 3 buckets (~0ms, regex only):
 *   NO_RAG        → metadata query, answer from file list, no backend call
 *   SUMMARIZE_FILE → sequential chunk read of one named file (getFileChunks)
 *   SUMMARIZE_ALL  → sequential chunk reads across all files (getFileChunks parallel)
 *   SEARCH         → delegate to backend semanticSearch (intent + reranking + graph expansion)
 *
 * The LLM planner (ragPlanner.ts) is intentionally removed — the backend's
 * Phase 12A pipeline already handles intent classification, query expansion,
 * and graph expansion on every semanticSearch call.
 */

import type { Message } from "$lib/types/Message";
import type { ChatFileChunk, SemanticSearchResponse } from "$lib/rag/client";
import type { RAGClient } from "$lib/server/rag/client";
import {
	METADATA_QUERY_PATTERNS,
	SUMMARIZE_VERBS,
	GLOBAL_SUMMARIZE_PATTERNS,
	findFileMatch,
	type RagFileContext,
} from "$lib/server/rag/ragRouter";
import { compressHistory } from "$lib/server/rag/historyCompressor";

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

export type RagStrategy = "NO_RAG" | "SUMMARIZE_FILE" | "SUMMARIZE_ALL" | "SEARCH";

export interface FileExecutionPlan {
	fileId: string;
	fileName: string;
	action: "DEEP_DIVE";
	limit?: number;
}

export interface ExecutionPlan {
	strategy: RagStrategy;
	searchQuery: string;
	historyContext: string;
	filePlans: FileExecutionPlan[];
	globalTopK?: number;
}

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

const SEARCH_TOP_K = 5;

function chunksPerFile(fileCount: number): number {
	if (fileCount <= 3) return 12;
	if (fileCount <= 6) return 8;
	return 6;
}

// ─────────────────────────────────────────────
// CLASSIFIER HELPERS
// ─────────────────────────────────────────────

function isMetaQuery(q: string): boolean {
	return METADATA_QUERY_PATTERNS.some((p) => p.test(q));
}

function hasSummarizeVerb(q: string): boolean {
	const lower = q.toLowerCase();
	return SUMMARIZE_VERBS.some((v) => lower.includes(v));
}

function isGlobalSummarize(q: string): boolean {
	return GLOBAL_SUMMARIZE_PATTERNS.some((p) => p.test(q));
}

// ─────────────────────────────────────────────
// RAG AGENT CLASS
// ─────────────────────────────────────────────

export class RagAgent {
	constructor(private ragClient: RAGClient) {}

	/**
	 * Classify the query into one of 4 strategies (~0ms, pure regex).
	 * No LLM call. No network call.
	 */
	classify(
		userQuery: string,
		availableFiles: RagFileContext[],
		conversationHistory: Message[]
	): ExecutionPlan {
		const { contextString: historyContext } = compressHistory(conversationHistory);

		if (isMetaQuery(userQuery)) {
			return { strategy: "NO_RAG", searchQuery: userQuery, historyContext, filePlans: [] };
		}

		const explicitFile = findFileMatch(userQuery, availableFiles);
		const isSummarize = hasSummarizeVerb(userQuery);

		if (explicitFile && isSummarize) {
			const totalChunks = explicitFile.chunkCount ?? 10;
			const isPdf = explicitFile.name.toLowerCase().endsWith(".pdf");
			const limit = Math.min(totalChunks, 20) + (isPdf ? 3 : 0);
			return {
				strategy: "SUMMARIZE_FILE",
				searchQuery: userQuery,
				historyContext,
				filePlans: [
					{ fileId: explicitFile.id, fileName: explicitFile.name, action: "DEEP_DIVE", limit },
				],
			};
		}

		if ((isGlobalSummarize(userQuery) || isSummarize) && availableFiles.length > 0) {
			const perFile = chunksPerFile(availableFiles.length);
			return {
				strategy: "SUMMARIZE_ALL",
				searchQuery: userQuery,
				historyContext,
				filePlans: availableFiles.map((f) => ({
					fileId: f.id,
					fileName: f.name,
					action: "DEEP_DIVE" as const,
					limit: perFile,
				})),
			};
		}

		return {
			strategy: "SEARCH",
			searchQuery: userQuery,
			historyContext,
			filePlans: [],
			globalTopK: SEARCH_TOP_K,
		};
	}

	/**
	 * Execute a pre-built plan, returning merged chunks.
	 */
	async execute(plan: ExecutionPlan, messageId: string): Promise<ChatFileChunk[]> {
		if (plan.strategy === "NO_RAG") return [];

		if (plan.strategy === "SEARCH") {
			try {
				const resp = await this.ragClient.semanticSearch({
					messageId,
					userQuery: plan.searchQuery,
					rewriteQuery: plan.searchQuery,
					top_k: plan.globalTopK ?? SEARCH_TOP_K,
				});
				return resp.chunks ?? [];
			} catch (e) {
				console.warn("[RagAgent] SEARCH failed:", e);
				return [];
			}
		}

		// SUMMARIZE_FILE or SUMMARIZE_ALL — sequential chunk reads in parallel
		const tasks = plan.filePlans.map((fp) =>
			(
				this.ragClient.getFileChunks(fp.fileId, fp.limit ?? 8, 0) as Promise<SemanticSearchResponse>
			).catch((e) => {
				console.warn(`[RagAgent] getFileChunks failed for "${fp.fileName}":`, e);
				return null;
			})
		);

		const results = await Promise.allSettled(tasks);
		const chunks: ChatFileChunk[] = [];
		for (const r of results) {
			if (r.status === "fulfilled" && r.value) {
				chunks.push(...(r.value.chunks ?? []));
			}
		}
		return chunks;
	}

	/**
	 * Full pipeline: classify → execute → return merged chunks.
	 */
	async run(
		userQuery: string,
		availableFiles: RagFileContext[],
		conversationHistory: Message[],
		messageId: string
	): Promise<{ plan: ExecutionPlan; chunks: ChatFileChunk[] }> {
		const plan = this.classify(userQuery, availableFiles, conversationHistory);

		console.log("\n[RAG AGENT] ========================");
		console.log(`- Strategy  : ${plan.strategy}`);
		console.log(`- Query     : "${userQuery}"`);
		if (plan.historyContext) {
			console.log(`- History   : ${plan.historyContext.slice(0, 100).replace(/\n/g, " ")}…`);
		}
		console.log("======================================");

		if (plan.strategy === "NO_RAG") return { plan, chunks: [] };

		const chunks = await this.execute(plan, messageId);
		const fileNames = [...new Set(chunks.map((c) => c.filename))];
		console.log(
			`[RAG AGENT] Retrieved ${chunks.length} chunks from: ${fileNames.join(", ") || "none"}\n`
		);

		return { plan, chunks };
	}
}
```

- [ ] **Step 2.4: Run classifier tests to confirm they pass**

```bash
npx vitest run src/lib/server/rag/ragAgent.spec.ts
```

Expected: All 9 tests PASS.

- [ ] **Step 2.5: Run TypeScript check**

```bash
npm run check
```

Expected: No errors. Fix any type errors before continuing.

- [ ] **Step 2.6: Commit**

```bash
git add src/lib/server/rag/ragAgent.ts src/lib/server/rag/ragAgent.spec.ts
git commit -m "feat(rag): replace LLM planner with 3-bucket regex classifier"
```

---

## Task 3: Delete `ragPlanner.ts` and `ragAgentLegacy.ts`

**Files:**
- Delete: `src/lib/server/rag/ragPlanner.ts`
- Delete: `src/lib/server/rag/ragAgentLegacy.ts`

- [ ] **Step 3.1: Verify nothing imports these files**

```bash
grep -r "ragPlanner\|ragAgentLegacy" /Users/siddesh.kale/Documents/chatui/chat-ui/src --include="*.ts" --include="*.svelte"
```

Expected: Zero results (the new `ragAgent.ts` no longer imports either).

- [ ] **Step 3.2: Delete both files**

```bash
rm /Users/siddesh.kale/Documents/chatui/chat-ui/src/lib/server/rag/ragPlanner.ts
rm /Users/siddesh.kale/Documents/chatui/chat-ui/src/lib/server/rag/ragAgentLegacy.ts
```

- [ ] **Step 3.3: Run TypeScript check**

```bash
npm run check
```

Expected: No errors. If there are import errors, grep for any remaining references and fix them.

- [ ] **Step 3.4: Commit**

```bash
git add -u src/lib/server/rag/ragPlanner.ts src/lib/server/rag/ragAgentLegacy.ts
git commit -m "chore(rag): delete LLM planner and legacy regex planner (inlined into ragAgent)"
```

---

## Task 4: Update `contextBuilder.ts` — new strategy names + `expanded_from`

**Files:**
- Modify: `src/lib/server/rag/contextBuilder.ts`

- [ ] **Step 4.1: Update `getContextBudget` for new strategy names**

In `contextBuilder.ts`, replace the `getContextBudget` function (lines 32–35):

```typescript
function getContextBudget(strategy?: RagStrategy): number {
	if (strategy === "SUMMARIZE_ALL") return CONTEXT_BUDGET_LARGE;
	return CONTEXT_BUDGET_SIMPLE;
}
```

- [ ] **Step 4.2: Update score filter to handle `null` similarity**

Replace line 91 (the score filter):

```typescript
const scoredChunks = chunks.filter((c) => (c.similarity ?? 1) >= MIN_SIMILARITY_SCORE);
```

(No change needed — `?? 1` already handles null. Verify this line is unchanged.)

- [ ] **Step 4.3: Add `expanded_from` to the `<coderef>` format block**

In `contextBuilder.ts`, replace the `formattedChunks` map (lines 133–149):

```typescript
const formattedChunks = budgeted
	.map((chunk, idx) => {
		const lang = getLanguageFromFilename(chunk.filename);
		const relevancePercent = chunk.similarity !== null ? (chunk.similarity * 100).toFixed(0) : "—";

		return `<coderef id="${chunk.id}" index="${idx + 1}">
File: ${chunk.filename}
Relevance: ${relevancePercent}%
Role: ${chunk.role}
${chunk.expanded_from ? `Expanded from: ${chunk.expanded_from}` : ""}
${chunk.pageNumber ? `Line: ${chunk.pageNumber}` : ""}
Source URL: ${chunk.fileUrl || "N/A"}

\`\`\`${lang}
${chunk.text.trim()}
\`\`\`
</coderef>`;
	})
	.join("\n\n---\n\n");
```

- [ ] **Step 4.4: Run TypeScript check**

```bash
npm run check
```

Expected: No errors.

- [ ] **Step 4.5: Commit**

```bash
git add src/lib/server/rag/contextBuilder.ts
git commit -m "feat(rag): update contextBuilder for new strategy names and expanded_from in coderef"
```

---

## Task 5: Update `+server.ts` — remove LLM planner wiring

**Files:**
- Modify: `src/routes/conversation/[id]/+server.ts:324-362`

- [ ] **Step 5.1: Remove `generateFromDefaultEndpoint` import and update `RagAgent` construction**

In `+server.ts`, find the RAG block (around line 324). Make these two changes:

**Remove** the `generateFromDefaultEndpoint` import line from the dynamic import block:
```typescript
// REMOVE this line:
const { generateFromDefaultEndpoint } = await import(
	"$lib/server/generateFromDefaultEndpoint"
);
```

**Replace** the RagAgent construction and `run()` call:
```typescript
// Before:
const ragAgent = new RagAgent(ragClient, generateFromDefaultEndpoint);
const { plan, chunks } = await ragAgent.run(
	userQuery,
	mergedFiles,
	historyForAgent,
	newUserMessageId.toString(),
	locals
);

// After:
const ragAgent = new RagAgent(ragClient);
const { plan, chunks } = await ragAgent.run(
	userQuery,
	mergedFiles,
	historyForAgent,
	newUserMessageId.toString()
);
```

- [ ] **Step 5.2: Run TypeScript check**

```bash
npm run check
```

Expected: No errors.

- [ ] **Step 5.3: Commit**

```bash
git add src/routes/conversation/[id]/+server.ts
git commit -m "feat(rag): remove LLM planner dependency from conversation server route"
```

---

## Task 6: Update `RagReferenceCard.svelte` — provenance label for graph-expanded chunks

**Files:**
- Modify: `src/lib/components/chat/RagReferenceCard.svelte`

- [ ] **Step 6.1: Add null-score guard and provenance label to chunk rows**

In `RagReferenceCard.svelte`, replace the chunk row block (lines 146–174) with:

```svelte
<div class="flex flex-col gap-1.5 px-3 py-2.5">
    <!-- File name + role badge -->
    <div class="flex items-center justify-between gap-2">
        <div class="flex min-w-0 items-center gap-1.5">
            <Icon class="size-3.5 flex-none text-gray-400" />
            <span class="truncate text-[11px] font-medium text-gray-700 dark:text-gray-300" title={chunk.filename}>
                {shortFilename(chunk.filename)}
            </span>
            {#if chunk.pageNumber}
                <span class="text-[10px] text-gray-400">· Line {chunk.pageNumber}</span>
            {/if}
        </div>
        <span class="flex-none rounded px-1.5 py-0.5 text-[10px] font-medium {roleBadge[chunk.role]}">
            {roleLabel[chunk.role]}
        </span>
    </div>

    <!-- Graph provenance label (dependency chunks only) -->
    {#if chunk.role === "dependency" && chunk.expanded_from}
        {@const shortQid = chunk.expanded_from.split("::").slice(-2).join("::")}
        <span class="text-[10px] text-blue-500 dark:text-blue-400" title="Graph-expanded from {chunk.expanded_from}">
            via {shortQid}
        </span>
    {/if}

    <!-- Relevance bar (hidden for graph-expanded chunks with null score) -->
    {#if chunk.similarity !== null && chunk.similarity !== undefined}
        {@const style = scoreStyle(chunk.similarity)}
        {@const pct = (chunk.similarity * 100).toFixed(0)}
        <div class="flex items-center gap-2">
            <div class="h-1 flex-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                <div class="h-full rounded-full transition-all {style.bar}" style="width:{pct}%"></div>
            </div>
            <span class="w-7 text-right text-[10px] font-medium {style.label}">{pct}%</span>
        </div>
    {:else}
        <span class="text-[10px] text-gray-400 dark:text-gray-500">graph expanded</span>
    {/if}

    <!-- Text preview -->
    <p class="mt-0.5 font-mono text-[10px] leading-relaxed text-gray-500 dark:text-gray-400">
        {truncate(chunk.text.trim(), 160)}
    </p>
</div>
```

- [ ] **Step 6.2: Remove the now-unused `scoreStyle` and `pct` variables from the `{#each}` block header**

The old code had `{@const style = scoreStyle(chunk.similarity ?? 1)}` and `{@const pct = ...}` at the top of each chunk row. These are now inside the conditional. Verify the top of the `{#each}` block in the modified file no longer has those `@const` declarations.

The `{#each}` block header should now be just:
```svelte
{#each activeChunks as chunk (chunk.id)}
    {@const Icon = fileIcon(chunk.filename)}
    <div class="flex flex-col gap-1.5 px-3 py-2.5">
```

- [ ] **Step 6.3: Run TypeScript check**

```bash
npm run check
```

Expected: No errors.

- [ ] **Step 6.4: Commit**

```bash
git add src/lib/components/chat/RagReferenceCard.svelte
git commit -m "feat(rag): add graph provenance label and null-score guard to citation card"
```

---

## Task 7: End-to-end smoke test

- [ ] **Step 7.1: Run all tests**

```bash
npm run test
```

Expected: All existing tests PASS + the 9 new `ragAgent.spec.ts` tests PASS.

- [ ] **Step 7.2: Start dev server and verify the golden path**

```bash
npm run dev
```

Open `http://localhost:5173`. With a conversation that has uploaded files, test these queries manually:

| Query | Expected strategy (console log) | Expected UI |
|-------|----------------------------------|-------------|
| `what files do I have?` | `NO_RAG` | No Sources card |
| `summarize auth.py` | `SUMMARIZE_FILE` | Sources card, all chunks from auth.py |
| `summarize all my files` | `SUMMARIZE_ALL` | Sources card, chunks from every file |
| `how does authentication work?` | `SEARCH` | Sources card with entry + dependency chunks |
| `what does auth.py import from utils.ts?` | `SEARCH` (not HYBRID) | Sources card, backend graph expansion handles it |

- [ ] **Step 7.3: Verify provenance label renders for dependency chunks**

In the Sources card, open the "Related" tab. Dependency chunks that have `expanded_from` set should show a blue "via file::entity" label. Chunks with `null` similarity should show "graph expanded" instead of a score bar.

- [ ] **Step 7.4: Final TypeScript + lint check**

```bash
npm run check && npm run lint
```

Expected: No errors, no warnings.

- [ ] **Step 7.5: Final commit**

```bash
git add .
git commit -m "feat(rag): thin frontend router — delegate intelligence to backend Phase 12A"
```

---

## Self-Review

**Spec coverage check:**
- ✅ Remove LLM planner entirely → Task 2 rewrites `ragAgent.ts`, Task 3 deletes `ragPlanner.ts`
- ✅ 3-bucket regex classifier (META / SUMMARIZE / SEARCH) → Task 2 `classify()`
- ✅ META answers from file list, no backend call → `NO_RAG` strategy
- ✅ SUMMARIZE uses `getFileChunks` (single file + all files) → Tasks 2 + 4
- ✅ SEARCH delegates to `semanticSearchForChat` (no fileIds scoping) → Task 2 `execute()`
- ✅ `expanded_from` provenance in citation UI → Tasks 1 + 6
- ✅ Null similarity guard in citation UI → Task 6
- ✅ `+server.ts` wiring updated → Task 5
- ✅ `contextBuilder.ts` strategy names updated → Task 4

**Placeholder scan:** None found.

**Type consistency check:**
- `RagStrategy` in `ragAgent.ts` uses `"SUMMARIZE_FILE" | "SUMMARIZE_ALL"` — matches `contextBuilder.ts` `getContextBudget` check (`"SUMMARIZE_ALL"`), `RagReferenceCard.svelte` does not use strategy directly.
- `FileExecutionPlan.action` is `"DEEP_DIVE"` only in the new agent — matches `execute()` which calls `getFileChunks` for all filePlans regardless of action value.
- `chunk.similarity` is `number | null` in `ChatFileChunk` — `contextBuilder.ts` uses `?? 1` fallback (unchanged), `RagReferenceCard.svelte` checks `!== null` before rendering bar.
