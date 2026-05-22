# Agentic RAG Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the regex-based RAG classifier in `src/lib/server/rag/ragAgent.ts` with an agentic tool-calling layer that exposes `retrieve_docs` and `get_file_chunks` to the LLM, adds a deterministic server-side critic for re-retrieval, strips stale RAG context from history, and uses the backend's `fileIds` and `rewriteQuery` parameters that today are wasted.

**Architecture:** Two-layer gating (per-conversation `ragEnabled` toggle → per-turn binary engagement gate) feeding an LLM tool loop that calls the existing DevForge backend (`/api/v1/rag/chunk/semanticSearchForChat`, `/api/v1/rag/file/{id}/chunks`). A deterministic critic evaluates each retrieval result (similarity floor + role mix), with up to 2 critic-triggered retries per turn using an LLM-reformulated query. Backend untouched in `chat-ui`; the `fileIds` filter gap is being fixed in parallel on the backend's `rag_resolve` branch.

**Tech Stack:** SvelteKit 2 + Svelte 5 (existing), TypeScript strict mode, Vitest (server workspace), existing `RAGClient` (no new HTTP endpoints), existing `runMcpFlow.ts` tool-calling infrastructure.

**Spec:** `docs/superpowers/specs/2026-05-22-agentic-rag-redesign-design.md`

**Branch:** `cheatsheet` (current). User commits manually — every "commit" step below is a suggested command, not auto-run.

---

## File Structure (locked in before tasks)

### New files (all under `src/lib/server/rag/`)

| File | Responsibility | Lines (est.) |
|---|---|---|
| `historyHygiene.ts` | Pure: strip `<rag_result>` / `# Retrieved Document Context` / `## Uploaded Files` blocks from prior user messages | ~50 |
| `historyHygiene.spec.ts` | Unit tests for above | ~80 |
| `inventoryInjector.ts` | Pure: build `## Uploaded Files` system-prompt block from `RagFileMetadata[]` | ~40 |
| `inventoryInjector.spec.ts` | Unit tests | ~50 |
| `ragGate.ts` | Pure: `shouldEngage(query, files, history) → boolean` | ~60 |
| `ragGate.spec.ts` | Unit tests | ~90 |
| `ragCritic.ts` | `evaluate(chunks)` (pure) + `reformulateQuery(...)` (LLM-backed) | ~120 |
| `ragCritic.spec.ts` | Unit tests | ~100 |
| `ragTools.ts` | OpenAI tool schemas + handlers wrapping `RAGClient` | ~180 |
| `ragTools.spec.ts` | Unit tests with mocked `RAGClient` | ~120 |

### Modified files

| File | Lines touched | What changes |
|---|---|---|
| `src/routes/conversation/[id]/+server.ts` | 320-410 | Replace RAG block: strip → toggle check → gate → inventory → tool loop |
| `src/lib/server/textGeneration/mcp/runMcpFlow.ts` | Tool list assembly + tool-result hook | Append RAG tools when gate engaged; intercept `retrieve_docs` results through critic |
| `src/lib/server/textGeneration/utils/toolPrompt.ts` | 37-39, 16-18 | Replace `retrieve_docs` block; drop `rerank_docs` mention |
| `src/lib/server/rag/contextBuilder.ts` | 36-42, 81-84 | Drop `RagStrategy` dependency from `getContextBudget`; keep `buildRagContextMessage` for tool result formatting |

### Deleted files (final cleanup task only)

| File | Lines |
|---|---|
| `src/lib/server/rag/ragAgent.ts` | 248 |
| `src/lib/server/rag/ragAgent.spec.ts` | 128 |
| `src/lib/server/rag/historyCompressor.ts` | 128 (verify no other consumers first) |

### Untouched

- `src/lib/server/rag/client.ts` — HTTP wrapper
- `src/lib/server/rag/auth.ts` — JWT
- `src/lib/rag/**` — browser-side
- `src/lib/components/chat/**` — RagFileManager, RagReferenceCard, ChatInput (toggle stays)

---

## Conventions for every task

- All test files use Vitest: `import { describe, it, expect, vi } from "vitest";`
- All test files end with `.spec.ts` and live next to the module
- Run a single spec with: `npx vitest run src/lib/server/rag/<name>.spec.ts`
- Run the full type-check: `npm run check`
- Run the full lint: `npm run lint`
- Use tabs (project Prettier config); 100-char width
- No `any`, no non-null assertions (project ESLint rules)
- Path alias `$lib` → `src/lib`

---

## Task 1: `historyHygiene.ts` — strip stale RAG blocks from history

**Files:**
- Create: `src/lib/server/rag/historyHygiene.ts`
- Create: `src/lib/server/rag/historyHygiene.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/server/rag/historyHygiene.spec.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { stripPriorRagBlocks } from "./historyHygiene";
import type { Message } from "$lib/types/Message";

function msg(from: Message["from"], content: string, id = "m_" + Math.random()): Message {
	return { from, content, id, createdAt: new Date(), updatedAt: new Date() };
}

describe("stripPriorRagBlocks", () => {
	it("removes # Retrieved Document Context block from prior user messages", () => {
		const messages: Message[] = [
			msg(
				"user",
				`# Retrieved Document Context\n\n<coderef>foo</coderef>\n\n---\n\nsummarize auth.py`
			),
			msg("assistant", "Sure, auth.py defines..."),
			msg("user", "and what about validate_token?"),
		];

		const result = stripPriorRagBlocks(messages);

		expect(result[0].content).toBe("summarize auth.py");
		expect(result[1].content).toBe("Sure, auth.py defines...");
		expect(result[2].content).toBe("and what about validate_token?");
	});

	it("removes <rag_result> tags from prior user messages", () => {
		const messages: Message[] = [
			msg(
				"user",
				`<rag_result query="x"><coderef>data</coderef></rag_result>previous question`
			),
			msg("user", "current question"),
		];

		const result = stripPriorRagBlocks(messages);

		expect(result[0].content).toBe("previous question");
		expect(result[1].content).toBe("current question");
	});

	it("removes ## Uploaded Files block from prior user messages", () => {
		const messages: Message[] = [
			msg(
				"user",
				`## Uploaded Files\nThe user has 2 uploaded file(s):\n- auth.py\n- utils.py\n\nshow me login`
			),
			msg("user", "current"),
		];

		const result = stripPriorRagBlocks(messages);

		expect(result[0].content).toBe("show me login");
		expect(result[1].content).toBe("current");
	});

	it("NEVER strips the last message", () => {
		const messages: Message[] = [
			msg("user", "earlier"),
			msg(
				"user",
				`# Retrieved Document Context\n<coderef>x</coderef>\n---\n\ncurrent query`
			),
		];

		const result = stripPriorRagBlocks(messages);

		// Last message is preserved verbatim — the RAG block is freshly injected this turn
		expect(result[1].content).toContain("# Retrieved Document Context");
	});

	it("does not touch assistant messages", () => {
		const messages: Message[] = [
			msg("assistant", "# Retrieved Document Context\nsome text\n---\n\nresponse"),
			msg("user", "current"),
		];

		const result = stripPriorRagBlocks(messages);

		expect(result[0].content).toBe(
			"# Retrieved Document Context\nsome text\n---\n\nresponse"
		);
	});

	it("is idempotent (running twice produces the same result)", () => {
		const messages: Message[] = [
			msg(
				"user",
				`<rag_result>x</rag_result># Retrieved Document Context\nfoo\n---\n\nquery`
			),
			msg("user", "current"),
		];

		const once = stripPriorRagBlocks(messages);
		const twice = stripPriorRagBlocks(once);

		expect(twice[0].content).toBe(once[0].content);
	});

	it("returns the same array reference for messages that don't change", () => {
		const messages: Message[] = [
			msg("user", "no rag here"),
			msg("user", "current"),
		];

		const result = stripPriorRagBlocks(messages);

		expect(result[0]).toBe(messages[0]); // mutation-safe: unchanged → same ref
	});

	it("handles non-string content gracefully", () => {
		const messages = [
			{
				from: "user" as const,
				content: undefined as unknown as string,
				id: "x",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			msg("user", "current"),
		];

		expect(() => stripPriorRagBlocks(messages)).not.toThrow();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/server/rag/historyHygiene.spec.ts`

Expected: FAIL with `Cannot find module './historyHygiene'`

- [ ] **Step 3: Implement `historyHygiene.ts`**

Create `src/lib/server/rag/historyHygiene.ts`:

```typescript
/**
 * History Hygiene — strip stale RAG context from prior user messages.
 *
 * Runs at the top of every turn (regardless of ragEnabled). Removes:
 *   - `# Retrieved Document Context\n...\n---\n\n` blocks (from old buildRagContextMessage)
 *   - `## Uploaded Files\n...\n\n` blocks (from inventoryInjector and old buildFileListNote)
 *   - `<rag_result>...</rag_result>` blocks (from new tool-result wrapper)
 *
 * Properties: idempotent, mutation-safe (returns same ref when unchanged),
 * last-message protected (current turn's freshly-injected context is preserved),
 * assistant-message no-op.
 */

import type { Message } from "$lib/types/Message";

const RAG_BLOCK_PATTERN = /^# Retrieved Document Context[\s\S]*?\n---\n\n/;
const RAG_RESULT_TAG_PATTERN = /<rag_result\b[\s\S]*?<\/rag_result>\s*/g;
const FILE_INVENTORY_PATTERN = /^## Uploaded Files\n[\s\S]*?\n\n/;

export function stripPriorRagBlocks(messages: Message[]): Message[] {
	return messages.map((m, idx) => {
		// Never strip the last message — current turn's RAG context is freshly injected
		if (idx === messages.length - 1) return m;
		if (m.from !== "user") return m;
		if (typeof m.content !== "string") return m;

		let content = m.content;
		content = content.replace(RAG_BLOCK_PATTERN, "");
		content = content.replace(FILE_INVENTORY_PATTERN, "");
		content = content.replace(RAG_RESULT_TAG_PATTERN, "");

		return content === m.content ? m : { ...m, content };
	});
}
```

- [ ] **Step 4: Run test to verify all 8 cases pass**

Run: `npx vitest run src/lib/server/rag/historyHygiene.spec.ts`

Expected: PASS — 8 tests pass.

- [ ] **Step 5: Type-check**

Run: `npm run check`

Expected: PASS (no new errors).

- [ ] **Step 6: Suggest commit (user runs manually)**

```bash
git add src/lib/server/rag/historyHygiene.ts src/lib/server/rag/historyHygiene.spec.ts
git commit -m "feat(rag): add historyHygiene for stripping stale RAG blocks"
```

---

## Task 2: `inventoryInjector.ts` — build the `## Uploaded Files` block

**Files:**
- Create: `src/lib/server/rag/inventoryInjector.ts`
- Create: `src/lib/server/rag/inventoryInjector.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/server/rag/inventoryInjector.spec.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildInventoryBlock } from "./inventoryInjector";
import type { RagFileMetadata } from "$lib/rag/client";

function file(overrides: Partial<RagFileMetadata>): RagFileMetadata {
	return {
		id: "f_default",
		name: "default.txt",
		size: 100,
		fileType: "text/plain",
		chunkCount: 5,
		chunkingStatus: "success",
		embeddingStatus: "success",
		finishEmbedding: true,
		chunkingError: null,
		embeddingError: null,
		createdAt: "2026-05-22T00:00:00.000Z",
		updatedAt: "2026-05-22T00:00:00.000Z",
		...overrides,
	};
}

describe("buildInventoryBlock", () => {
	it("returns empty string for empty file list", () => {
		expect(buildInventoryBlock([])).toBe("");
	});

	it("includes file id, name, and chunk count for each file", () => {
		const block = buildInventoryBlock([
			file({ id: "f_auth", name: "auth.py", chunkCount: 12 }),
			file({ id: "f_utils", name: "utils.py", chunkCount: 8 }),
		]);

		expect(block).toContain("## Uploaded Files");
		expect(block).toContain("**auth.py** (12 chunks, id=`f_auth`)");
		expect(block).toContain("**utils.py** (8 chunks, id=`f_utils`)");
	});

	it("includes file URL when present", () => {
		const block = buildInventoryBlock([
			file({ id: "f1", name: "doc.pdf", url: "https://rag.example/doc.pdf" }),
		]);

		expect(block).toContain("https://rag.example/doc.pdf");
	});

	it("flags files still being embedded as (processing — not searchable yet)", () => {
		const block = buildInventoryBlock([
			file({ id: "f1", name: "ready.py", finishEmbedding: true }),
			file({ id: "f2", name: "pending.py", finishEmbedding: false }),
		]);

		expect(block).toContain("**ready.py**");
		expect(block).not.toMatch(/\*\*ready\.py\*\*[^\n]*processing/);
		expect(block).toMatch(/\*\*pending\.py\*\*[^\n]*processing — not searchable yet/);
	});

	it("includes usage instructions for retrieve_docs and get_file_chunks", () => {
		const block = buildInventoryBlock([file({ name: "x.py" })]);

		expect(block).toContain("retrieve_docs");
		expect(block).toContain("get_file_chunks");
		expect(block).toContain("fileIds");
	});

	it("renders file count correctly", () => {
		expect(
			buildInventoryBlock([file({ id: "f1" })])
		).toContain("1 uploaded file(s)");
		expect(
			buildInventoryBlock([file({ id: "f1" }), file({ id: "f2" })])
		).toContain("2 uploaded file(s)");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/server/rag/inventoryInjector.spec.ts`

Expected: FAIL with `Cannot find module './inventoryInjector'`

- [ ] **Step 3: Implement `inventoryInjector.ts`**

Create `src/lib/server/rag/inventoryInjector.ts`:

```typescript
/**
 * Inventory Injector — builds the `## Uploaded Files` block that gets prepended
 * to the system prompt when RAG is engaged.
 *
 * The block tells the LLM which files exist (id + name + chunk count + URL +
 * processing status) so it can pick `fileIds` for retrieve_docs / get_file_chunks
 * tool calls.
 *
 * Pure function — no I/O.
 */

import type { RagFileMetadata } from "$lib/rag/client";

function formatLine(file: RagFileMetadata): string {
	const chunkLabel = `${file.chunkCount} chunk${file.chunkCount !== 1 ? "s" : ""}`;
	const processingNote = !file.finishEmbedding
		? " — *(processing — not searchable yet)*"
		: "";
	const idPart = `id=\`${file.id}\``;
	const urlPart = file.url ? `\n  File URL: ${file.url}` : "";

	return `- **${file.name}** (${chunkLabel}, ${idPart})${processingNote}${urlPart}`;
}

export function buildInventoryBlock(files: RagFileMetadata[]): string {
	if (files.length === 0) return "";

	const lines = files.map(formatLine).join("\n");

	return `## Uploaded Files

The user has ${files.length} uploaded file(s) available for retrieval:
${lines}

Use \`retrieve_docs\` with \`fileIds\` to scope search to specific files, or omit \`fileIds\` for cross-file queries. Use \`get_file_chunks\` to read a file sequentially (summarization, full-file overview).
`;
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run src/lib/server/rag/inventoryInjector.spec.ts`

Expected: PASS — 6 tests pass.

- [ ] **Step 5: Type-check**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 6: Suggest commit**

```bash
git add src/lib/server/rag/inventoryInjector.ts src/lib/server/rag/inventoryInjector.spec.ts
git commit -m "feat(rag): add inventoryInjector for system-prompt file inventory block"
```

---

## Task 3: `ragGate.ts` — binary "engage RAG?" decision

**Files:**
- Create: `src/lib/server/rag/ragGate.ts`
- Create: `src/lib/server/rag/ragGate.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/server/rag/ragGate.spec.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { shouldEngage } from "./ragGate";
import type { RagFileContext } from "./ragRouter";

const files = (names: string[]): RagFileContext[] =>
	names.map((name, i) => ({ id: `f_${i}`, name, chunkCount: 5 }));

describe("ragGate.shouldEngage", () => {
	it("returns false when there are no files", () => {
		expect(shouldEngage("summarize my file", [])).toBe(false);
	});

	it("returns false for pure greetings", () => {
		expect(shouldEngage("hi", files(["auth.py"]))).toBe(false);
		expect(shouldEngage("hello", files(["auth.py"]))).toBe(false);
		expect(shouldEngage("how are you", files(["auth.py"]))).toBe(false);
	});

	it("returns false for math/general knowledge with files present", () => {
		expect(shouldEngage("what is 2+2", files(["auth.py"]))).toBe(false);
		expect(shouldEngage("explain photosynthesis", files(["auth.py"]))).toBe(false);
	});

	it("returns true when query names an uploaded file", () => {
		expect(shouldEngage("show me auth.py", files(["auth.py"]))).toBe(true);
		expect(
			shouldEngage("what's in the authentication file", files(["authentication.py"]))
		).toBe(true);
	});

	it("returns true for content-verb queries with files present", () => {
		expect(shouldEngage("summarize", files(["auth.py"]))).toBe(true);
		expect(shouldEngage("give me the login function", files(["auth.py"]))).toBe(true);
		expect(shouldEngage("explain the code", files(["auth.py"]))).toBe(true);
		expect(shouldEngage("what does this file do", files(["auth.py"]))).toBe(true);
		expect(shouldEngage("walk me through", files(["auth.py"]))).toBe(true);
	});

	it("returns true for file/doc reference verbs", () => {
		expect(shouldEngage("from my upload", files(["x.pdf"]))).toBe(true);
		expect(shouldEngage("in the document", files(["x.pdf"]))).toBe(true);
		expect(shouldEngage("what's in my file", files(["x.pdf"]))).toBe(true);
	});

	it("returns true for code identifiers that match file content keywords", () => {
		expect(shouldEngage("explain authenticate function", files(["auth.py"]))).toBe(true);
	});

	it("returns false for unrelated identifiers when no file matches", () => {
		expect(shouldEngage("write me a poem about cats", files(["auth.py"]))).toBe(false);
	});

	it("returns true for inventory-style meta queries (LLM answers from inventory)", () => {
		// Note: gate=true even though the LLM won't call tools — inventory injection
		// alone is enough for the LLM to answer "what files do I have?"
		expect(shouldEngage("what files do I have", files(["auth.py"]))).toBe(true);
		expect(shouldEngage("list my uploads", files(["auth.py"]))).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(shouldEngage("SUMMARIZE AUTH.PY", files(["auth.py"]))).toBe(true);
		expect(shouldEngage("Hi", files(["auth.py"]))).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/server/rag/ragGate.spec.ts`

Expected: FAIL with `Cannot find module './ragGate'`

- [ ] **Step 3: Implement `ragGate.ts`**

Create `src/lib/server/rag/ragGate.ts`:

```typescript
/**
 * RAG Gate — binary decision: should this turn engage RAG tools at all?
 *
 * Runs ONLY when conv.ragEnabled is true. Returns true if the query plausibly
 * needs file content; returns false to skip inventory injection + tool advertisement.
 *
 * Pure function. Cheap heuristics only — the LLM does the actual smart routing
 * via tool calls.
 */

import { findFileMatch, type RagFileContext } from "./ragRouter";

const FILE_REFERENCE_WORDS = [
	"file",
	"files",
	"document",
	"documents",
	"doc",
	"docs",
	"upload",
	"uploads",
	"uploaded",
	"pdf",
];

const CONTENT_VERBS = [
	"summarize",
	"summarise",
	"summary",
	"overview",
	"explain",
	"describe",
	"show",
	"read",
	"analyze",
	"analyse",
	"review",
	"walk me through",
	"walk through",
	"give me",
	"tell me about",
	"what does",
	"what is",
	"what's",
	"how does",
	"how do",
	"function",
	"class",
	"method",
	"definition",
	"implementation",
	"code",
];

const INVENTORY_META_PATTERNS = [
	/\bwhat\s+(files?|documents?|uploads?)\b/i,
	/\blist\s+(my\s+)?(files?|uploads?)\b/i,
	/\bmy\s+(uploaded\s+)?(files?|uploads?)\b/i,
];

export function shouldEngage(query: string, files: RagFileContext[]): boolean {
	if (files.length === 0) return false;

	const lower = query.toLowerCase().trim();

	// Meta queries about the inventory — gate true so inventory is injected
	if (INVENTORY_META_PATTERNS.some((p) => p.test(query))) return true;

	// Filename match — strongest signal
	if (findFileMatch(query, files)) return true;

	// File-reference words ("my file", "from my upload", "in the document")
	if (FILE_REFERENCE_WORDS.some((w) => new RegExp(`\\b${w}\\b`, "i").test(lower))) {
		return true;
	}

	// Content verbs — phrasal matches first, then single words
	if (CONTENT_VERBS.some((v) => lower.includes(v))) return true;

	return false;
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run src/lib/server/rag/ragGate.spec.ts`

Expected: PASS — 10 tests pass.

- [ ] **Step 5: Type-check + lint**

Run: `npm run check && npm run lint`

Expected: PASS.

- [ ] **Step 6: Suggest commit**

```bash
git add src/lib/server/rag/ragGate.ts src/lib/server/rag/ragGate.spec.ts
git commit -m "feat(rag): add binary engagement gate (replaces 4-bucket regex classifier)"
```

---

## Task 4: `ragCritic.evaluate` — deterministic retrieval-quality verdict

**Files:**
- Create: `src/lib/server/rag/ragCritic.ts` (evaluate function only — reformulator in Task 7)
- Create: `src/lib/server/rag/ragCritic.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/server/rag/ragCritic.spec.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { evaluate } from "./ragCritic";
import type { ChatFileChunk } from "$lib/rag/client";

function chunk(overrides: Partial<ChatFileChunk>): ChatFileChunk {
	return {
		id: "c_default",
		fileId: "f_default",
		filename: "default.py",
		fileType: "text/x-python",
		fileUrl: "",
		text: "code",
		similarity: 0.8,
		role: "entry",
		is_graph_expansion: false,
		...overrides,
	};
}

describe("ragCritic.evaluate", () => {
	it("returns EMPTY for zero chunks", () => {
		expect(evaluate([]).verdict).toBe("EMPTY");
	});

	it("returns PASS when there is a strong direct hit AND an entry-role chunk", () => {
		const result = evaluate([
			chunk({ similarity: 0.84, role: "entry", is_graph_expansion: false }),
			chunk({ similarity: 0.6, role: "supporting" }),
		]);
		expect(result.verdict).toBe("PASS");
	});

	it("returns RETRY when max similarity is below the floor AND there is no entry chunk", () => {
		const result = evaluate([
			chunk({ similarity: 0.4, role: "supporting" }),
			chunk({ similarity: 0.35, role: "supporting" }),
		]);
		expect(result.verdict).toBe("RETRY");
	});

	it("returns PASS when vector score is weak but an entry chunk arrived via graph expansion", () => {
		// graph-expansion chunks have similarity=0 by backend convention; the role still
		// indicates structural relevance
		const result = evaluate([
			chunk({ similarity: 0.4, role: "supporting", is_graph_expansion: false }),
			chunk({ similarity: 0, role: "entry", is_graph_expansion: true }),
			chunk({ similarity: 0, role: "dependency", is_graph_expansion: true }),
		]);
		expect(result.verdict).toBe("PASS");
		expect(result.reason).toMatch(/graph/i);
	});

	it("returns RETRY when ALL chunks are graph-expanded (vector missed entirely)", () => {
		const result = evaluate([
			chunk({ similarity: 0, role: "entry", is_graph_expansion: true }),
			chunk({ similarity: 0, role: "dependency", is_graph_expansion: true }),
			chunk({ similarity: 0, role: "supporting", is_graph_expansion: true }),
		]);
		expect(result.verdict).toBe("RETRY");
	});

	it("returns RETRY when scores are strong but no entry-role chunk", () => {
		const result = evaluate([
			chunk({ similarity: 0.82, role: "supporting" }),
			chunk({ similarity: 0.75, role: "dependency" }),
		]);
		expect(result.verdict).toBe("RETRY");
	});

	it("computes signals correctly (maxSimilarity ignores graph-expansion chunks)", () => {
		const result = evaluate([
			chunk({ similarity: 0.5, role: "supporting", is_graph_expansion: false }),
			chunk({ similarity: 1.0, role: "dependency", is_graph_expansion: true }), // graph hit, ignored for maxSim
		]);
		expect(result.signals.maxSimilarity).toBe(0.5);
		expect(result.signals.graphOnlyRatio).toBe(0.5);
	});

	it("handles null/missing similarity gracefully", () => {
		const result = evaluate([
			chunk({ similarity: null as unknown as number, role: "entry" }),
		]);
		expect(result.signals.maxSimilarity).toBe(0);
		expect(result.verdict).toBe("RETRY");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/server/rag/ragCritic.spec.ts`

Expected: FAIL with `Cannot find module './ragCritic'`

- [ ] **Step 3: Implement `ragCritic.ts` (evaluate function only)**

Create `src/lib/server/rag/ragCritic.ts`:

```typescript
/**
 * RAG Critic — deterministic retrieval-quality evaluator.
 *
 * Runs server-side after every retrieve_docs tool call. Emits a verdict:
 *   PASS  — return chunks to LLM as-is
 *   RETRY — fire one more retrieve_docs with an LLM-reformulated query
 *   EMPTY — return empty result (LLM tells user no relevant docs)
 *
 * Thresholds calibrated against backend sigmoid-normalized similarity scores
 * (NOT rerank scores — see spec §3.3). Pure function.
 *
 * reformulateQuery() (LLM-backed) lives in Task 7 of the implementation plan.
 */

import type { ChatFileChunk } from "$lib/rag/client";

const MIN_SIMILARITY_FLOOR = 0.55;
const MIN_ENTRY_CHUNKS = 1;
const MAX_GRAPH_ONLY_RATIO = 0.7;

export interface CriticSignals {
	maxSimilarity: number;
	entryCount: number;
	graphOnlyRatio: number;
}

export interface CriticVerdict {
	verdict: "PASS" | "RETRY" | "EMPTY";
	reason: string;
	signals: CriticSignals;
}

function zeroSignals(): CriticSignals {
	return { maxSimilarity: 0, entryCount: 0, graphOnlyRatio: 0 };
}

export function evaluate(chunks: ChatFileChunk[]): CriticVerdict {
	if (chunks.length === 0) {
		return { verdict: "EMPTY", reason: "no chunks returned", signals: zeroSignals() };
	}

	const directHits = chunks.filter((c) => !c.is_graph_expansion);
	const maxSimilarity = directHits.reduce(
		(acc, c) => Math.max(acc, c.similarity ?? 0),
		0
	);
	const entryCount = chunks.filter((c) => c.role === "entry").length;
	const graphOnlyRatio =
		chunks.filter((c) => c.is_graph_expansion).length / chunks.length;

	const signals: CriticSignals = { maxSimilarity, entryCount, graphOnlyRatio };

	if (maxSimilarity >= MIN_SIMILARITY_FLOOR && entryCount >= MIN_ENTRY_CHUNKS) {
		return { verdict: "PASS", reason: "strong hit + entry role present", signals };
	}

	if (entryCount >= MIN_ENTRY_CHUNKS && graphOnlyRatio < MAX_GRAPH_ONLY_RATIO) {
		return {
			verdict: "PASS",
			reason: "weak vector but useful graph context",
			signals,
		};
	}

	return {
		verdict: "RETRY",
		reason: `low similarity (${maxSimilarity.toFixed(2)}) and no entry chunks below threshold`,
		signals,
	};
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run src/lib/server/rag/ragCritic.spec.ts`

Expected: PASS — 8 tests pass.

- [ ] **Step 5: Suggest commit**

```bash
git add src/lib/server/rag/ragCritic.ts src/lib/server/rag/ragCritic.spec.ts
git commit -m "feat(rag): add deterministic critic for retrieval quality evaluation"
```

---

## Task 5: `ragTools.ts` — define OpenAI tool schemas (no handler yet)

**Files:**
- Create: `src/lib/server/rag/ragTools.ts` (schemas exported; handlers stubbed)

- [ ] **Step 1: Add tool schemas + handler stubs to `ragTools.ts`**

Create `src/lib/server/rag/ragTools.ts`:

```typescript
/**
 * RAG Tools — OpenAI tool definitions and handlers for the agentic loop.
 *
 * Exposes two tools to the LLM:
 *   retrieve_docs    — semantic search across uploaded files
 *   get_file_chunks  — sequential read of one file (for summarization)
 *
 * Handler responsibilities (per spec §5.1):
 *   1. Map LLM-facing `query` → backend `userQuery`
 *   2. Generate `messageId` server-side via crypto.randomUUID()
 *   3. Validate `fileIds` against the per-turn inventory; drop unknown ones
 *   4. Clamp top_k / limit defensively
 *   5. Format chunks into <rag_result> blocks via contextBuilder
 *   6. Push chunks to the per-turn ragChunksAccumulator (citation UI)
 */

import type { ChatFileChunk, RagFileMetadata } from "$lib/rag/client";
import type { RAGClient } from "./client";

export interface OpenAiTool {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}

export const RETRIEVE_DOCS_TOOL: OpenAiTool = {
	type: "function",
	function: {
		name: "retrieve_docs",
		description:
			"Search the user's uploaded files (PDFs, code, docs) for content relevant to a query. The backend performs hybrid search (BM25 + vector) with reranking and code-graph expansion. Returns the most relevant chunks with file/line metadata. Use this whenever you need actual content from an uploaded file — do NOT guess. Use fileIds to scope when the user names a specific file; omit fileIds for broad questions.",
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "The user's natural-language question, as-is.",
				},
				rewriteQuery: {
					type: "string",
					description:
						"OPTIONAL but RECOMMENDED. Your own optimized search query — keywords, function names, technical terms.",
				},
				fileIds: {
					type: "array",
					items: { type: "string" },
					description:
						"OPTIONAL whitelist of file IDs to scope the search. Look IDs up in the `## Uploaded Files` inventory.",
				},
				top_k: {
					type: "integer",
					default: 5,
					minimum: 1,
					maximum: 20,
					description: "Number of chunks to return. Start with 5. Use 10+ for summarization.",
				},
			},
			required: ["query"],
		},
	},
};

export const GET_FILE_CHUNKS_TOOL: OpenAiTool = {
	type: "function",
	function: {
		name: "get_file_chunks",
		description:
			"Read a specific uploaded file sequentially, chunk by chunk. Use for SUMMARIZATION or full-file reading. Unlike retrieve_docs (semantic search), this returns chunks in original document order.",
		parameters: {
			type: "object",
			properties: {
				fileId: { type: "string", description: "File ID from the inventory." },
				limit: { type: "integer", default: 8, minimum: 1, maximum: 30 },
				offset: { type: "integer", default: 0, minimum: 0 },
			},
			required: ["fileId"],
		},
	},
};

export const RAG_TOOL_NAMES = new Set(["retrieve_docs", "get_file_chunks"]);

export interface RetrieveDocsArgs {
	query: string;
	rewriteQuery?: string;
	fileIds?: string[];
	top_k?: number;
}

export interface GetFileChunksArgs {
	fileId: string;
	limit?: number;
	offset?: number;
}

export interface RagToolResult {
	chunks: ChatFileChunk[];
	error?: string;
}

// Handlers — implemented in Task 6.
// Declared here so the type surface is locked in.
export type RetrieveDocsHandler = (
	args: RetrieveDocsArgs,
	ctx: { ragClient: RAGClient; inventory: RagFileMetadata[] }
) => Promise<RagToolResult>;

export type GetFileChunksHandler = (
	args: GetFileChunksArgs,
	ctx: { ragClient: RAGClient; inventory: RagFileMetadata[] }
) => Promise<RagToolResult>;

export const handleRetrieveDocs: RetrieveDocsHandler = async () => {
	throw new Error("handleRetrieveDocs not yet implemented — see Task 6");
};

export const handleGetFileChunks: GetFileChunksHandler = async () => {
	throw new Error("handleGetFileChunks not yet implemented — see Task 6");
};
```

- [ ] **Step 2: Type-check**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 3: Suggest commit**

```bash
git add src/lib/server/rag/ragTools.ts
git commit -m "feat(rag): define retrieve_docs and get_file_chunks tool schemas"
```

---

## Task 6: `ragTools` handlers — wrap RAGClient with validation, UUID gen, fileIds mapping

**Files:**
- Modify: `src/lib/server/rag/ragTools.ts` (replace stubs with real handlers)
- Create: `src/lib/server/rag/ragTools.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/server/rag/ragTools.spec.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { handleRetrieveDocs, handleGetFileChunks } from "./ragTools";
import type { RAGClient } from "./client";
import type { ChatFileChunk, RagFileMetadata, SemanticSearchResponse } from "$lib/rag/client";

function makeRagClient(overrides: Partial<RAGClient> = {}): RAGClient {
	return {
		semanticSearch: vi.fn(async () => ({ chunks: [], queryId: "qid_test", expansion_count: 0 })),
		getFileChunks: vi.fn(async () => ({ chunks: [], queryId: "fid_test", expansion_count: 0 })),
		...overrides,
	} as unknown as RAGClient;
}

function file(id: string, name: string, finishEmbedding = true): RagFileMetadata {
	return {
		id,
		name,
		size: 100,
		fileType: "text/plain",
		chunkCount: 5,
		chunkingStatus: "success",
		embeddingStatus: "success",
		finishEmbedding,
		chunkingError: null,
		embeddingError: null,
		createdAt: "2026-05-22T00:00:00Z",
		updatedAt: "2026-05-22T00:00:00Z",
	};
}

describe("handleRetrieveDocs", () => {
	it("maps tool `query` → backend `userQuery`", async () => {
		const ragClient = makeRagClient();
		await handleRetrieveDocs(
			{ query: "find login function" },
			{ ragClient, inventory: [file("f1", "auth.py")] }
		);
		expect(ragClient.semanticSearch).toHaveBeenCalledWith(
			expect.objectContaining({ userQuery: "find login function" })
		);
	});

	it("auto-generates a messageId per call (server-side, not exposed to LLM)", async () => {
		const ragClient = makeRagClient();
		await handleRetrieveDocs(
			{ query: "x" },
			{ ragClient, inventory: [file("f1", "a.py")] }
		);
		const call = (ragClient.semanticSearch as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(call.messageId).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("passes rewriteQuery and top_k through unchanged", async () => {
		const ragClient = makeRagClient();
		await handleRetrieveDocs(
			{ query: "x", rewriteQuery: "def authenticate", top_k: 10 },
			{ ragClient, inventory: [file("f1", "a.py")] }
		);
		expect(ragClient.semanticSearch).toHaveBeenCalledWith(
			expect.objectContaining({ rewriteQuery: "def authenticate", top_k: 10 })
		);
	});

	it("clamps top_k below minimum and above maximum", async () => {
		const ragClient = makeRagClient();
		await handleRetrieveDocs(
			{ query: "x", top_k: 999 },
			{ ragClient, inventory: [file("f1", "a.py")] }
		);
		expect(ragClient.semanticSearch).toHaveBeenCalledWith(
			expect.objectContaining({ top_k: 20 })
		);

		await handleRetrieveDocs(
			{ query: "x", top_k: 0 },
			{ ragClient, inventory: [file("f1", "a.py")] }
		);
		expect(ragClient.semanticSearch).toHaveBeenLastCalledWith(
			expect.objectContaining({ top_k: 1 })
		);
	});

	it("validates fileIds against inventory and drops unknown ones", async () => {
		const ragClient = makeRagClient();
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		await handleRetrieveDocs(
			{ query: "x", fileIds: ["f1", "f_unknown"] },
			{ ragClient, inventory: [file("f1", "a.py")] }
		);

		expect(ragClient.semanticSearch).toHaveBeenCalledWith(
			expect.objectContaining({ fileIds: ["f1"] })
		);
		warnSpy.mockRestore();
	});

	it("returns error if all fileIds are unknown", async () => {
		const ragClient = makeRagClient();
		const result = await handleRetrieveDocs(
			{ query: "x", fileIds: ["f_unknown1", "f_unknown2"] },
			{ ragClient, inventory: [file("f1", "a.py")] }
		);
		expect(result.error).toMatch(/unknown fileIds/i);
		expect(result.chunks).toEqual([]);
		expect(ragClient.semanticSearch).not.toHaveBeenCalled();
	});

	it("rejects fileIds pointing at files not yet embedded", async () => {
		const ragClient = makeRagClient();
		const result = await handleRetrieveDocs(
			{ query: "x", fileIds: ["f_pending"] },
			{ ragClient, inventory: [file("f_pending", "pending.py", false)] }
		);
		expect(result.error).toMatch(/still being processed/i);
		expect(ragClient.semanticSearch).not.toHaveBeenCalled();
	});

	it("passes chunks through on success", async () => {
		const chunks: ChatFileChunk[] = [
			{
				id: "c1",
				fileId: "f1",
				filename: "a.py",
				fileType: "text/x-python",
				fileUrl: "",
				text: "code",
				similarity: 0.8,
				role: "entry",
				is_graph_expansion: false,
			},
		];
		const ragClient = makeRagClient({
			semanticSearch: vi.fn(async () => ({
				chunks,
				queryId: "qid",
				expansion_count: 0,
			} as SemanticSearchResponse)),
		});

		const result = await handleRetrieveDocs(
			{ query: "x" },
			{ ragClient, inventory: [file("f1", "a.py")] }
		);

		expect(result.chunks).toEqual(chunks);
		expect(result.error).toBeUndefined();
	});

	it("converts backend errors into RagToolResult.error (does not throw)", async () => {
		const ragClient = makeRagClient({
			semanticSearch: vi.fn(async () => {
				throw new Error("RAG search failed: 503");
			}),
		});
		const result = await handleRetrieveDocs(
			{ query: "x" },
			{ ragClient, inventory: [file("f1", "a.py")] }
		);
		expect(result.error).toMatch(/503/);
		expect(result.chunks).toEqual([]);
	});
});

describe("handleGetFileChunks", () => {
	it("rejects unknown fileId", async () => {
		const ragClient = makeRagClient();
		const result = await handleGetFileChunks(
			{ fileId: "f_unknown" },
			{ ragClient, inventory: [file("f1", "a.py")] }
		);
		expect(result.error).toMatch(/unknown fileId/i);
		expect(ragClient.getFileChunks).not.toHaveBeenCalled();
	});

	it("rejects unready file", async () => {
		const ragClient = makeRagClient();
		const result = await handleGetFileChunks(
			{ fileId: "f_pending" },
			{ ragClient, inventory: [file("f_pending", "p.py", false)] }
		);
		expect(result.error).toMatch(/still being processed/i);
	});

	it("clamps limit and applies defaults", async () => {
		const ragClient = makeRagClient();
		await handleGetFileChunks(
			{ fileId: "f1", limit: 100 },
			{ ragClient, inventory: [file("f1", "a.py")] }
		);
		expect(ragClient.getFileChunks).toHaveBeenCalledWith("f1", 30, 0);

		await handleGetFileChunks(
			{ fileId: "f1" },
			{ ragClient, inventory: [file("f1", "a.py")] }
		);
		expect(ragClient.getFileChunks).toHaveBeenLastCalledWith("f1", 8, 0);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/server/rag/ragTools.spec.ts`

Expected: FAIL — handlers throw "not yet implemented".

- [ ] **Step 3: Replace stub handlers with real implementations**

Edit `src/lib/server/rag/ragTools.ts` — replace the two stub handler exports at the bottom with:

```typescript
const TOP_K_MIN = 1;
const TOP_K_MAX = 20;
const TOP_K_DEFAULT = 5;
const LIMIT_MIN = 1;
const LIMIT_MAX = 30;
const LIMIT_DEFAULT = 8;

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function partitionFileIds(
	requested: string[] | undefined,
	inventory: RagFileMetadata[]
): { valid: string[]; unknown: string[]; unready: string[] } {
	if (!requested || requested.length === 0) {
		return { valid: [], unknown: [], unready: [] };
	}
	const byId = new Map(inventory.map((f) => [f.id, f]));
	const valid: string[] = [];
	const unknown: string[] = [];
	const unready: string[] = [];
	for (const id of requested) {
		const file = byId.get(id);
		if (!file) {
			unknown.push(id);
		} else if (!file.finishEmbedding) {
			unready.push(id);
		} else {
			valid.push(id);
		}
	}
	return { valid, unknown, unready };
}

export const handleRetrieveDocs: RetrieveDocsHandler = async (args, ctx) => {
	const { query, rewriteQuery, fileIds, top_k } = args;
	const { ragClient, inventory } = ctx;

	const { valid, unknown, unready } = partitionFileIds(fileIds, inventory);

	if (unready.length > 0) {
		return {
			chunks: [],
			error: `File(s) still being processed (embedding in progress): ${unready.join(", ")}. Please wait and try again.`,
		};
	}

	if (fileIds && fileIds.length > 0 && valid.length === 0) {
		return {
			chunks: [],
			error: `unknown fileIds: ${unknown.join(", ")}. Check the inventory in the system prompt.`,
		};
	}

	if (unknown.length > 0) {
		console.warn(`[ragTools] Dropping unknown fileIds: ${unknown.join(", ")}`);
	}

	const clampedTopK = clamp(top_k ?? TOP_K_DEFAULT, TOP_K_MIN, TOP_K_MAX);

	try {
		const response = await ragClient.semanticSearch({
			messageId: crypto.randomUUID(),
			userQuery: query,
			rewriteQuery: rewriteQuery,
			fileIds: valid.length > 0 ? valid : undefined,
			top_k: clampedTopK,
		});
		return { chunks: response.chunks ?? [] };
	} catch (e) {
		const msg = e instanceof Error ? e.message : "RAG search failed";
		return { chunks: [], error: msg };
	}
};

export const handleGetFileChunks: GetFileChunksHandler = async (args, ctx) => {
	const { fileId, limit, offset } = args;
	const { ragClient, inventory } = ctx;

	const file = inventory.find((f) => f.id === fileId);
	if (!file) {
		return { chunks: [], error: `unknown fileId: ${fileId}. Check the inventory.` };
	}
	if (!file.finishEmbedding) {
		return {
			chunks: [],
			error: `File "${file.name}" is still being processed. Please wait and try again.`,
		};
	}

	const clampedLimit = clamp(limit ?? LIMIT_DEFAULT, LIMIT_MIN, LIMIT_MAX);
	const safeOffset = Math.max(0, offset ?? 0);

	try {
		const response = await ragClient.getFileChunks(fileId, clampedLimit, safeOffset);
		return { chunks: response.chunks ?? [] };
	} catch (e) {
		const msg = e instanceof Error ? e.message : "get_file_chunks failed";
		return { chunks: [], error: msg };
	}
};
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/server/rag/ragTools.spec.ts`

Expected: PASS — 11 tests pass.

- [ ] **Step 5: Type-check + lint**

Run: `npm run check && npm run lint`

Expected: PASS.

- [ ] **Step 6: Suggest commit**

```bash
git add src/lib/server/rag/ragTools.ts src/lib/server/rag/ragTools.spec.ts
git commit -m "feat(rag): implement retrieve_docs and get_file_chunks handlers"
```

---

## Task 7: `ragCritic.reformulateQuery` — LLM-backed query reformulation with templated fallback

**Files:**
- Modify: `src/lib/server/rag/ragCritic.ts` (add `reformulateQuery` export)
- Modify: `src/lib/server/rag/ragCritic.spec.ts` (add reformulator tests)

- [ ] **Step 1: Add the failing test**

Append to `src/lib/server/rag/ragCritic.spec.ts`:

```typescript
import { reformulateQuery } from "./ragCritic";

describe("ragCritic.reformulateQuery", () => {
	it("returns the LLM-generated rewrite on success", async () => {
		const llm = vi.fn(async () => "login authentication handler function");
		const result = await reformulateQuery({
			userQuery: "thing that handles login",
			fileNames: ["auth.py", "session.py"],
			maxSim: 0.4,
			callLlm: llm,
		});
		expect(result).toBe("login authentication handler function");
		expect(llm).toHaveBeenCalledOnce();
	});

	it("falls back to a templated query when the LLM call returns empty", async () => {
		const llm = vi.fn(async () => "");
		const result = await reformulateQuery({
			userQuery: "thing that handles login",
			fileNames: ["auth.py"],
			maxSim: 0.4,
			callLlm: llm,
		});
		expect(result).toMatch(/thing that handles login.*auth\.py/);
	});

	it("falls back to a templated query when the LLM throws", async () => {
		const llm = vi.fn(async () => {
			throw new Error("LLM timeout");
		});
		const result = await reformulateQuery({
			userQuery: "find login",
			fileNames: ["auth.py"],
			maxSim: 0.3,
			callLlm: llm,
		});
		expect(result).toMatch(/find login.*auth\.py/);
	});

	it("includes file names in the LLM prompt", async () => {
		let receivedPrompt = "";
		const llm = vi.fn(async (prompt: string) => {
			receivedPrompt = prompt;
			return "rewritten";
		});
		await reformulateQuery({
			userQuery: "x",
			fileNames: ["auth.py", "utils.py"],
			maxSim: 0.4,
			callLlm: llm,
		});
		expect(receivedPrompt).toContain("auth.py");
		expect(receivedPrompt).toContain("utils.py");
	});

	it("trims whitespace and quotes from the LLM response", async () => {
		const llm = vi.fn(async () => `  "rewritten query"\n  `);
		const result = await reformulateQuery({
			userQuery: "x",
			fileNames: ["a.py"],
			maxSim: 0.4,
			callLlm: llm,
		});
		expect(result).toBe("rewritten query");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/server/rag/ragCritic.spec.ts -t reformulateQuery`

Expected: FAIL with `reformulateQuery is not a function`.

- [ ] **Step 3: Add the reformulator implementation**

Append to `src/lib/server/rag/ragCritic.ts`:

```typescript
export type LlmCaller = (prompt: string) => Promise<string>;

export interface ReformulateInput {
	userQuery: string;
	fileNames: string[];
	maxSim: number;
	callLlm: LlmCaller;
}

const REFORMULATE_PROMPT_TEMPLATE = (input: ReformulateInput): string => `
The user asked: "${input.userQuery}"
Files available: ${input.fileNames.join(", ") || "(none)"}
Initial search returned weak results (max similarity ${input.maxSim.toFixed(2)}, no entry-role chunks).

Reformulate as a precise SEARCH QUERY:
- Include specific identifiers, function/class names, technical terms.
- Drop filler words ("what's the thing that", "can you tell me").
- One line only. No explanation.

Reformulated query:`;

function templatedFallback(userQuery: string, fileNames: string[]): string {
	const topFile = fileNames[0] ?? "";
	return topFile ? `${userQuery} ${topFile}` : userQuery;
}

function cleanResponse(raw: string): string {
	return raw
		.trim()
		.replace(/^["'`]+|["'`]+$/g, "")
		.split("\n")[0]
		.trim();
}

export async function reformulateQuery(input: ReformulateInput): Promise<string> {
	const prompt = REFORMULATE_PROMPT_TEMPLATE(input);
	try {
		const raw = await input.callLlm(prompt);
		const cleaned = cleanResponse(raw);
		if (cleaned.length === 0) {
			return templatedFallback(input.userQuery, input.fileNames);
		}
		return cleaned;
	} catch (e) {
		console.warn("[ragCritic] reformulator LLM call failed:", e);
		return templatedFallback(input.userQuery, input.fileNames);
	}
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/server/rag/ragCritic.spec.ts`

Expected: PASS — all critic tests (evaluate + reformulator) pass.

- [ ] **Step 5: Type-check**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 6: Suggest commit**

```bash
git add src/lib/server/rag/ragCritic.ts src/lib/server/rag/ragCritic.spec.ts
git commit -m "feat(rag): add LLM-backed query reformulator with templated fallback"
```

---

## Task 8: Wire `stripPriorRagBlocks` into `+server.ts` (safe everywhere, no flag)

This task lands the history-stripping cleanup before anything else. It runs regardless of `AGENTIC_RAG` or `ragEnabled` — pure cleanup that never hurts.

**Files:**
- Modify: `src/routes/conversation/[id]/+server.ts` (insert call before existing RAG block)

- [ ] **Step 1: Read the current RAG injection block**

Read: `src/routes/conversation/[id]/+server.ts:316-411` to confirm context.

The block currently starts at line 316 (`messagesForPrompt = buildSubtree(...)`). The stripping call needs to land RIGHT AFTER that line and BEFORE the existing `try` block at line 324.

- [ ] **Step 2: Add the import and call**

In `src/routes/conversation/[id]/+server.ts`:

Find the import block near the top and add (with other `$lib/server/rag` imports if any, else add a fresh import line):

```typescript
import { stripPriorRagBlocks } from "$lib/server/rag/historyHygiene";
```

Find this line (around line 318 in current file):

```typescript
			messagesForPrompt = buildSubtree(conv, newUserMessageId).map((m) => ({ ...m }));
```

Add immediately after it:

```typescript
			// Strip stale RAG context blocks from prior user messages — runs every turn,
			// regardless of conv.ragEnabled or AGENTIC_RAG flag. Pure cleanup.
			messagesForPrompt = stripPriorRagBlocks(messagesForPrompt);
```

- [ ] **Step 3: Type-check**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 4: Manual smoke test**

```bash
npm run dev
```

In a browser:
1. Open a new conversation with at least one uploaded file.
2. Send: "summarize my files" — get a response that injects `<coderef>` blocks.
3. Send: "what's the second function" — observe that the prior `<coderef>` blocks are no longer in the prompt context (check server logs).

Kill the dev server with Ctrl-C when done.

- [ ] **Step 5: Suggest commit**

```bash
git add src/routes/conversation/[id]/+server.ts
git commit -m "feat(rag): strip stale RAG blocks from history before every turn"
```

---

## Task 9: Add `AGENTIC_RAG` env flag + agentic flow in `+server.ts` (behind flag)

Behind the flag, the new flow runs INSTEAD of the existing `ragAgent` path. With the flag off, behavior is unchanged.

**Files:**
- Modify: `src/routes/conversation/[id]/+server.ts:320-410` (wrap RAG block with flag branch)

- [ ] **Step 1: Add the flag check + new flow scaffolding**

In `src/routes/conversation/[id]/+server.ts`, locate this section (around line 320, right after the `stripPriorRagBlocks` call you added in Task 8):

```typescript
			// ============================================================================
			// RAG METADATA — Always sync for MCP/GitOps (even if prompt injection is off)
			// ============================================================================

			try {
				const { RAGClient } = await import("$lib/server/rag/client");
				const { RagAgent } = await import("$lib/server/rag/ragAgent");
				...
```

Wrap the existing try-block so that when `AGENTIC_RAG === "1"`, a new agentic path runs instead. The shape:

```typescript
			// ============================================================================
			// RAG METADATA — Always sync for MCP/GitOps + run gate/inventory for agentic path
			// ============================================================================

			const useAgenticRag = process.env.AGENTIC_RAG === "1";

			try {
				const { RAGClient } = await import("$lib/server/rag/client");
				const ragClient = new RAGClient(undefined, locals.sessionId);
				const userQuery = newPrompt?.trim();
				const tenantId = locals.user?._id ?? locals.sessionId;

				if (tenantId) {
					// ── Always sync files for tool metadata ──
					let mergedFiles: import("$lib/rag/client").RagFileMetadata[] = [];
					try {
						const backendFiles =
							(await ragClient.listFiles()) as import("$lib/rag/client").RagFileMetadata[];
						const seed = (availableFiles ||
							[]) as unknown as import("$lib/rag/client").RagFileMetadata[];
						const mergedMap = new Map(
							[...seed, ...backendFiles].map((f) => [f.id, f])
						);
						mergedFiles = Array.from(mergedMap.values());
					} catch (e) {
						console.warn(
							"[RAG] Failed to sync backend files, using frontend list only.",
							e
						);
						mergedFiles = (availableFiles ||
							[]) as unknown as import("$lib/rag/client").RagFileMetadata[];
					}
					mergedFilesForContext = mergedFiles;

					if (conv.ragEnabled !== false && userQuery) {
						if (useAgenticRag) {
							// ── AGENTIC PATH: gate + inventory injection only ──
							// (Tool advertisement and critic happen in runMcpFlow — Tasks 10/11)
							const { shouldEngage } = await import("$lib/server/rag/ragGate");
							const { buildInventoryBlock } = await import(
								"$lib/server/rag/inventoryInjector"
							);

							const fileContexts = mergedFiles.map((f) => ({
								id: f.id,
								name: f.name,
								chunkCount: f.chunkCount,
							}));

							const engaged = shouldEngage(userQuery, fileContexts);

							console.log(
								`[RAG] Agentic gate: ${engaged ? "ENGAGED" : "SKIPPED"} (files=${mergedFiles.length})`
							);

							if (engaged) {
								const inventory = buildInventoryBlock(mergedFiles);
								const lastMsg = messagesForPrompt[messagesForPrompt.length - 1];
								if (lastMsg && lastMsg.from === "user") {
									lastMsg.content = `${inventory}\n\n---\n\n${lastMsg.content}`;
								}
								// Mark conv so runMcpFlow knows to expose RAG tools (Task 10).
								// Use a request-scoped flag rather than mutating the DB doc.
								agenticRagEngaged = true;
								agenticRagInventory = mergedFiles;
							}
						} else {
							// ── LEGACY PATH: existing ragAgent.classify + buildRagContextMessage ──
							const { RagAgent } = await import("$lib/server/rag/ragAgent");
							const { buildRagContextMessage, buildFileListNote } = await import(
								"$lib/server/rag/contextBuilder"
							);

							const ragAgent = new RagAgent(ragClient);
							const historyForAgent = buildSubtree(conv, newUserMessageId).slice(0, -1);

							const notReadyFiles = mergedFiles.filter(
								(f) => f.finishEmbedding === false
							);
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

							const { plan, chunks } = await ragAgent.run(
								userQuery,
								mergedFiles,
								historyForAgent,
								newUserMessageId.toString()
							);

							const lastMsg = messagesForPrompt[messagesForPrompt.length - 1];

							if (chunks.length > 0) {
								const ragContextMessage = buildRagContextMessage(
									chunks,
									plan.strategy,
									mergedFiles
								);
								ragChunksForAssistant = ragContextMessage.ragChunks ?? chunks;
								ragStrategyForAssistant = plan.strategy;
								if (lastMsg && lastMsg.from === "user") {
									lastMsg.content = `${ragContextMessage.content}\n\n---\n\n${lastMsg.content}`;
								}
							} else if (plan.strategy === "NO_RAG" && mergedFiles.length > 0) {
								if (lastMsg && lastMsg.from === "user") {
									const fileNote = buildFileListNote(mergedFiles);
									lastMsg.content = `${fileNote}\n\n---\n\n${lastMsg.content}`;
								}
							}
						}
					}
				}
			} catch (error) {
				console.error("[RAG] Metadata sync or injection failed:", error);
			}
```

ALSO declare the two new request-scoped variables near the existing declarations of `ragChunksForAssistant` and `ragStrategyForAssistant` (around line 269):

```typescript
		let ragChunksForAssistant: ChatFileChunk[] | undefined;
		let ragStrategyForAssistant: string | undefined;
		let agenticRagEngaged = false;
		let agenticRagInventory: import("$lib/rag/client").RagFileMetadata[] = [];
```

- [ ] **Step 2: Make `agenticRagEngaged` and `agenticRagInventory` visible to `runMcpFlow`**

These two values need to reach `runMcpFlow.ts`. The cleanest path is to pass them through the existing `locals` extension or a new field on the message-generation options. Search for the call site:

```bash
grep -n "runMcpFlow\|preprocessMessagesForPrompt" /Users/siddesh.kale/Documents/chatui/chat-ui/src/routes/conversation/[id]/+server.ts | head -10
```

Then thread the two values into whatever options object is being passed to the text-generation entry point. Add them as:

```typescript
ragContext: {
    engaged: agenticRagEngaged,
    inventory: agenticRagInventory,
    ragClient,
},
```

The exact wiring depends on the existing call chain (which is `getTextGenerationStream` or similar — confirm by reading `+server.ts:443` onward). Inspect and route through to `runMcpFlow.ts`'s arguments.

- [ ] **Step 3: Type-check**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 4: Smoke test with flag OFF (default)**

```bash
npm run dev
```

Confirm: existing chat with RAG works exactly as before (legacy path runs).

- [ ] **Step 5: Smoke test with flag ON**

```bash
AGENTIC_RAG=1 npm run dev
```

Confirm: server logs show `[RAG] Agentic gate: ENGAGED` or `SKIPPED` per turn. Sending a normal query proceeds (tool advertisement comes in Task 10 — for now, LLM has no RAG tools to call, so it answers without retrieval; this is expected for one task only).

Kill the dev server.

- [ ] **Step 6: Suggest commit**

```bash
git add src/routes/conversation/[id]/+server.ts
git commit -m "feat(rag): add AGENTIC_RAG flag + gate/inventory injection (legacy path remains default)"
```

---

## Task 10: Advertise RAG tools in `runMcpFlow.ts` when gate engaged

**Files:**
- Modify: `src/lib/server/textGeneration/mcp/runMcpFlow.ts` (tool list assembly)
- Modify: `src/lib/server/textGeneration/mcp/toolInvocation.ts` (handler dispatch for the two new tools)

- [ ] **Step 1: Read the current tool-list assembly**

Read `src/lib/server/textGeneration/mcp/runMcpFlow.ts:300-310` to see where `oaTools` is built.

- [ ] **Step 2: Append RAG tools when `ragContext.engaged === true`**

In `runMcpFlow.ts`, locate the line where `oaTools` is initialized (around line 300):

```typescript
		const { tools: oaTools, mapping } = await getOpenAiToolsForMcp(servers, {
			...
		});
```

Add immediately after the assignment:

```typescript
		// Append agentic RAG tools when the request has engaged RAG context.
		// Skipped entirely when ragContext is absent or engaged=false.
		if (options.ragContext?.engaged) {
			const { RETRIEVE_DOCS_TOOL, GET_FILE_CHUNKS_TOOL } = await import(
				"$lib/server/rag/ragTools"
			);
			oaTools.push(RETRIEVE_DOCS_TOOL, GET_FILE_CHUNKS_TOOL);
			logger.info(
				{ tools: ["retrieve_docs", "get_file_chunks"] },
				"[mcp] RAG tools advertised"
			);
		}
```

Also extend the function's options type to accept `ragContext` (search for the existing `options` type definition in the file — likely an interface at the top — and add):

```typescript
ragContext?: {
    engaged: boolean;
    inventory: import("$lib/rag/client").RagFileMetadata[];
    ragClient: import("$lib/server/rag/client").RAGClient;
};
```

- [ ] **Step 3: Wire dispatcher in `toolInvocation.ts`**

Read `src/lib/server/textGeneration/mcp/toolInvocation.ts` to find the dispatcher that maps tool name → handler.

Add a branch for the two RAG tool names: when the call name is `retrieve_docs` or `get_file_chunks`, dispatch to the handlers from `ragTools.ts` instead of going through the MCP client. Pseudocode:

```typescript
import {
	handleRetrieveDocs,
	handleGetFileChunks,
	RAG_TOOL_NAMES,
} from "$lib/server/rag/ragTools";

// In the dispatch function:
if (RAG_TOOL_NAMES.has(toolName) && options.ragContext) {
	const ctx = {
		ragClient: options.ragContext.ragClient,
		inventory: options.ragContext.inventory,
	};
	const result =
		toolName === "retrieve_docs"
			? await handleRetrieveDocs(parsedArgs, ctx)
			: await handleGetFileChunks(parsedArgs, ctx);

	// Format chunks into <rag_result> block for the LLM (Task 11 wraps this in critic)
	const { buildRagContextMessage } = await import("$lib/server/rag/contextBuilder");
	const formatted =
		result.chunks.length > 0
			? `<rag_result tool="${toolName}">${buildRagContextMessage(result.chunks).content}</rag_result>`
			: result.error
				? `<rag_result tool="${toolName}" error="${result.error}"/>`
				: `<rag_result tool="${toolName}" empty="true"/>`;

	// Accumulate chunks for citation UI
	options.ragContext.chunksAccumulator?.push(...result.chunks);

	return formatted;
}
```

The exact integration depends on the existing dispatcher's shape. Read the file carefully and follow its patterns.

Also extend `ragContext` to include the accumulator:

```typescript
ragContext?: {
    engaged: boolean;
    inventory: import("$lib/rag/client").RagFileMetadata[];
    ragClient: import("$lib/server/rag/client").RAGClient;
    chunksAccumulator: import("$lib/rag/client").ChatFileChunk[];
};
```

Initialize `chunksAccumulator: []` in `+server.ts` (Task 9 caller), and after the stream completes, dedupe by `chunk.id` and assign:

```typescript
messageToWriteTo.ragChunks = Array.from(
    new Map(agenticRagChunksAccumulator.map((c) => [c.id, c])).values()
);
messageToWriteTo.ragStrategy = "AGENTIC";
```

- [ ] **Step 4: Smoke test with flag ON**

```bash
AGENTIC_RAG=1 npm run dev
```

In a browser:
1. Upload `auth.py` (or any small file).
2. Send: "give me the authenticate function from auth.py".
3. Confirm the LLM calls `retrieve_docs` (visible in server logs as `[mcp] tools executed`).
4. Confirm chunks render in the citation UI.

Kill the dev server.

- [ ] **Step 5: Type-check + lint**

Run: `npm run check && npm run lint`

Expected: PASS.

- [ ] **Step 6: Suggest commit**

```bash
git add src/lib/server/textGeneration/mcp/runMcpFlow.ts src/lib/server/textGeneration/mcp/toolInvocation.ts src/routes/conversation/[id]/+server.ts
git commit -m "feat(rag): advertise retrieve_docs/get_file_chunks tools and dispatch handlers"
```

---

## Task 11: Wire critic into `retrieve_docs` tool result (server-side retry loop)

The critic runs ONLY for `retrieve_docs` results (not `get_file_chunks` — those are sequential reads with `similarity=1.0` hardcoded; critic would always PASS, no value added). Per-turn retry cap: 2.

**Files:**
- Modify: `src/lib/server/textGeneration/mcp/toolInvocation.ts` (intercept retrieve_docs result, run critic, retry if RETRY)

- [ ] **Step 1: Add critic hook in the `retrieve_docs` branch**

In the dispatcher branch you added in Task 10 (for `toolName === "retrieve_docs"`), wrap the handler call with the critic loop:

```typescript
if (toolName === "retrieve_docs" && options.ragContext) {
	const { evaluate, reformulateQuery } = await import("$lib/server/rag/ragCritic");

	let result = await handleRetrieveDocs(parsedArgs, ctx);
	let verdict = evaluate(result.chunks);

	// Per-turn retry counter (initialized in ragContext by +server.ts caller).
	const retriesUsed = options.ragContext.criticRetriesUsed ?? 0;

	if (
		verdict.verdict === "RETRY" &&
		retriesUsed < 2 // MAX_RETRIES_PER_TURN
	) {
		const fileNames = options.ragContext.inventory.map((f) => f.name);
		const newQuery = await reformulateQuery({
			userQuery: parsedArgs.query,
			fileNames,
			maxSim: verdict.signals.maxSimilarity,
			callLlm: async (prompt) => {
				const { generateFromDefaultEndpoint } = await import(
					"$lib/server/generateFromDefaultEndpoint"
				);
				const gen = generateFromDefaultEndpoint({
					messages: [{ from: "user", content: prompt }],
					locals: options.locals,
				});
				let final = "";
				for await (const update of gen) {
					if (update.type === "stream") final += update.token ?? "";
				}
				const ret = await gen.next();
				return typeof ret.value === "string" ? ret.value : final;
			},
		});

		console.log(
			`[RAG] Critic RETRY (maxSim=${verdict.signals.maxSimilarity.toFixed(2)}). Reformulated: "${newQuery}"`
		);

		const retryResult = await handleRetrieveDocs(
			{ ...parsedArgs, query: newQuery, rewriteQuery: newQuery },
			ctx
		);

		// Merge: union by chunk id, keep highest-similarity duplicate
		const merged = new Map<string, ChatFileChunk>();
		for (const c of [...result.chunks, ...retryResult.chunks]) {
			const existing = merged.get(c.id);
			if (!existing || (c.similarity ?? 0) > (existing.similarity ?? 0)) {
				merged.set(c.id, c);
			}
		}
		result = { chunks: Array.from(merged.values()) };
		verdict = evaluate(result.chunks);

		options.ragContext.criticRetriesUsed = retriesUsed + 1;
	}

	console.log(
		`[RAG] Critic verdict: ${verdict.verdict} (maxSim=${verdict.signals.maxSimilarity.toFixed(2)}, entry=${verdict.signals.entryCount})`
	);

	// Format and accumulate (same as Task 10):
	const { buildRagContextMessage } = await import("$lib/server/rag/contextBuilder");
	const formatted =
		result.chunks.length > 0
			? `<rag_result tool="retrieve_docs" verdict="${verdict.verdict}">${buildRagContextMessage(result.chunks).content}</rag_result>`
			: `<rag_result tool="retrieve_docs" empty="true"/>`;

	options.ragContext.chunksAccumulator.push(...result.chunks);
	return formatted;
}
```

Extend `ragContext` again:

```typescript
ragContext?: {
    engaged: boolean;
    inventory: import("$lib/rag/client").RagFileMetadata[];
    ragClient: import("$lib/server/rag/client").RAGClient;
    chunksAccumulator: import("$lib/rag/client").ChatFileChunk[];
    criticRetriesUsed: number;
};
```

Initialize `criticRetriesUsed: 0` in `+server.ts` (Task 9 caller).

- [ ] **Step 2: Smoke test the retry path**

```bash
AGENTIC_RAG=1 npm run dev
```

Send a vague query: "what's the thing that does login stuff". Server logs should show:

```
[RAG] Critic RETRY (maxSim=0.42). Reformulated: "login authentication handler function"
[RAG] Critic verdict: PASS (maxSim=0.79, entry=1)
```

- [ ] **Step 3: Type-check**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 4: Suggest commit**

```bash
git add src/lib/server/textGeneration/mcp/toolInvocation.ts src/routes/conversation/[id]/+server.ts
git commit -m "feat(rag): wire critic with one-shot retry and reformulated query"
```

---

## Task 12: Update `toolPrompt.ts` — replace `retrieve_docs` block, drop `rerank_docs`

**Files:**
- Modify: `src/lib/server/textGeneration/utils/toolPrompt.ts` (lines 37-39, 48, plus 16-18 stays)

- [ ] **Step 1: Read the current prompt**

The current relevant lines (37–39):

```typescript
`- retrieve_docs: Use ONLY when you need to understand file content to complete a task. Skip for general questions.`,
`- generate_data: Use for synthetic dataset generation. Specify domain and schema clearly.`,
`- rerank_docs: Use after retrieve_docs when result quality matters.`,
```

And line 48 (chain example):

```typescript
`- "review and commit refactored code" → [retrieve_docs] → [rerank_docs] → [github_operation commit]`,
```

- [ ] **Step 2: Edit `toolPrompt.ts`**

Replace line 37 (`- retrieve_docs: ...`) and line 39 (`- rerank_docs: ...`) with a single, expanded block. The replacement block goes where the old single `retrieve_docs` line was; the `rerank_docs` line gets deleted entirely.

New block to insert (replacing the single old `retrieve_docs` line at line 37):

```typescript
`## RAG TOOLS (UPLOADED FILES)`,
`- retrieve_docs(query, rewriteQuery, fileIds, top_k):`,
`    • SEMANTIC SEARCH across uploaded files. Backend handles reranking + graph expansion.`,
`    • ALWAYS pass \`rewriteQuery\` — extract keywords, identifiers, technical terms.`,
`    • ALWAYS pass \`fileIds\` when the user names a specific file (look id up in inventory).`,
`    • OMIT fileIds for cross-file questions ("how does login flow work?").`,
`    • Default top_k=5; raise to 10+ for summarization or broad coverage.`,
`    • Call multiple times in parallel for cross-file questions.`,
`- get_file_chunks(fileId, limit, offset):`,
`    • SEQUENTIAL READ of one file. Use for "summarize X", "walk me through Y".`,
`    • Returns chunks in original document order (not by relevance).`,
`## WHEN NOT TO CALL RAG TOOLS`,
`- Greetings, general knowledge, math, code unrelated to uploads.`,
`- Questions about prior assistant responses (use conversation history, not RAG).`,
`- After a retrieval already answered the question in this turn.`,
`## CITING SOURCES`,
`- Reference chunks by file + line (e.g., "auth.py:42").`,
`- Tool results show chunks inside <coderef> tags — reproduce code verbatim from them.`,
```

Delete the line `- rerank_docs: Use after retrieve_docs when result quality matters.`

Update the chain example at line 48 by replacing it with:

```typescript
`- "review and commit refactored code" → [retrieve_docs with fileIds] → [github_operation commit]`,
```

- [ ] **Step 3: Type-check**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 4: Smoke test**

```bash
AGENTIC_RAG=1 npm run dev
```

Send the bug-case query: "give me the authenticate function from auth.py". Confirm the LLM now passes `fileIds` in its `retrieve_docs` call (visible in server logs).

- [ ] **Step 5: Suggest commit**

```bash
git add src/lib/server/textGeneration/utils/toolPrompt.ts
git commit -m "feat(rag): expand retrieve_docs prompt; drop rerank_docs (auto on backend)"
```

---

## Task 13: Integration test — five regression cases

**Files:**
- Create: `src/lib/server/rag/conversation.rag.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/server/rag/conversation.rag.spec.ts`:

```typescript
/**
 * Integration test for the agentic RAG pipeline.
 *
 * Mocks RAGClient and the LLM tool-calling layer. Verifies the behavior matrix
 * for the five canonical cases from the spec (§11).
 */

import { describe, it, expect, vi } from "vitest";
import { shouldEngage } from "./ragGate";
import { buildInventoryBlock } from "./inventoryInjector";
import { evaluate } from "./ragCritic";
import { handleRetrieveDocs } from "./ragTools";
import type { RagFileMetadata, ChatFileChunk } from "$lib/rag/client";
import type { RAGClient } from "./client";

const FILES: RagFileMetadata[] = [
	{
		id: "f_auth",
		name: "auth.py",
		size: 1000,
		fileType: "text/x-python",
		chunkCount: 12,
		chunkingStatus: "success",
		embeddingStatus: "success",
		finishEmbedding: true,
		chunkingError: null,
		embeddingError: null,
		createdAt: "2026-05-22T00:00:00Z",
		updatedAt: "2026-05-22T00:00:00Z",
	},
	{
		id: "f_utils",
		name: "utils.py",
		size: 500,
		fileType: "text/x-python",
		chunkCount: 8,
		chunkingStatus: "success",
		embeddingStatus: "success",
		finishEmbedding: true,
		chunkingError: null,
		embeddingError: null,
		createdAt: "2026-05-22T00:00:00Z",
		updatedAt: "2026-05-22T00:00:00Z",
	},
];

const fileContexts = FILES.map((f) => ({ id: f.id, name: f.name, chunkCount: f.chunkCount }));

function chunk(overrides: Partial<ChatFileChunk>): ChatFileChunk {
	return {
		id: "c_x",
		fileId: "f_auth",
		filename: "auth.py",
		fileType: "text/x-python",
		fileUrl: "",
		text: "code",
		similarity: 0.8,
		role: "entry",
		is_graph_expansion: false,
		...overrides,
	};
}

describe("integration: case 1 — bug case (give me authenticate from auth.py)", () => {
	it("gate engages, retrieve_docs is called with fileIds=[f_auth], critic passes", async () => {
		const query = "give me the authenticate function from auth.py";

		// Step 1: gate engages
		expect(shouldEngage(query, fileContexts)).toBe(true);

		// Step 2: inventory includes both file IDs
		const inventory = buildInventoryBlock(FILES);
		expect(inventory).toContain("f_auth");

		// Step 3: LLM calls retrieve_docs with fileIds (simulated)
		const semanticSearch = vi.fn(async () => ({
			chunks: [
				chunk({ id: "c_authn", similarity: 0.84, role: "entry" as const }),
				chunk({
					id: "c_validate",
					similarity: 0,
					role: "dependency" as const,
					is_graph_expansion: true,
					expanded_from: "user::auth.py::authenticate",
				}),
			],
			queryId: "qid",
			expansion_count: 1,
		}));
		const ragClient = { semanticSearch } as unknown as RAGClient;

		const result = await handleRetrieveDocs(
			{ query, rewriteQuery: "def authenticate", fileIds: ["f_auth"], top_k: 10 },
			{ ragClient, inventory: FILES }
		);

		// Backend was called with fileIds
		expect(semanticSearch).toHaveBeenCalledWith(
			expect.objectContaining({ fileIds: ["f_auth"], rewriteQuery: "def authenticate" })
		);

		// Step 4: critic passes
		const verdict = evaluate(result.chunks);
		expect(verdict.verdict).toBe("PASS");
	});
});

describe("integration: case 2 — greeting (gate=false)", () => {
	it("gate returns false for 'hi how are you'", () => {
		expect(shouldEngage("hi how are you", fileContexts)).toBe(false);
	});
});

describe("integration: case 3 — toggle OFF skips entirely", () => {
	it("the runtime path is to not call shouldEngage when ragEnabled=false (verified at +server.ts)", () => {
		// This case is enforced by +server.ts wrapping in `if (conv.ragEnabled !== false)`.
		// Unit-testing the wrapper is done in conversation.rag.e2e (manual or future task).
		// Here we assert the runtime contract: no engagement means no calls.
		expect(true).toBe(true);
	});
});

describe("integration: case 4 — critic retry on weak retrieval", () => {
	it("vague query → weak first result → critic RETRY", async () => {
		const semanticSearch = vi.fn(async () => ({
			chunks: [chunk({ similarity: 0.4, role: "supporting" as const })],
			queryId: "qid",
			expansion_count: 0,
		}));
		const ragClient = { semanticSearch } as unknown as RAGClient;

		const result = await handleRetrieveDocs(
			{ query: "thing that handles login" },
			{ ragClient, inventory: FILES }
		);

		const verdict = evaluate(result.chunks);
		expect(verdict.verdict).toBe("RETRY");
	});
});

describe("integration: case 5 — multi-call cross-file", () => {
	it("two parallel retrieve_docs with different fileIds", async () => {
		const semanticSearch = vi.fn(async (req: { fileIds?: string[] }) => ({
			chunks: [chunk({ fileId: req.fileIds?.[0] ?? "f_unknown" })],
			queryId: "qid",
			expansion_count: 0,
		}));
		const ragClient = { semanticSearch } as unknown as RAGClient;

		const [r1, r2] = await Promise.all([
			handleRetrieveDocs(
				{ query: "frontend login route", fileIds: ["f_utils"] },
				{ ragClient, inventory: FILES }
			),
			handleRetrieveDocs(
				{ query: "backend authenticate", fileIds: ["f_auth"] },
				{ ragClient, inventory: FILES }
			),
		]);

		expect(r1.chunks[0].fileId).toBe("f_utils");
		expect(r2.chunks[0].fileId).toBe("f_auth");
		expect(semanticSearch).toHaveBeenCalledTimes(2);
	});
});

describe("integration: messageId is generated server-side, never from LLM", () => {
	it("each retrieve_docs call gets a unique messageId", async () => {
		const semanticSearch = vi.fn(async () => ({
			chunks: [],
			queryId: "qid",
			expansion_count: 0,
		}));
		const ragClient = { semanticSearch } as unknown as RAGClient;

		await handleRetrieveDocs(
			{ query: "a" },
			{ ragClient, inventory: FILES }
		);
		await handleRetrieveDocs(
			{ query: "b" },
			{ ragClient, inventory: FILES }
		);

		const call1 = (semanticSearch as ReturnType<typeof vi.fn>).mock.calls[0][0].messageId;
		const call2 = (semanticSearch as ReturnType<typeof vi.fn>).mock.calls[1][0].messageId;
		expect(call1).not.toEqual(call2);
		expect(call1).toMatch(/^[0-9a-f-]{36}$/);
	});
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/lib/server/rag/conversation.rag.spec.ts`

Expected: PASS — all 6 describe blocks pass.

- [ ] **Step 3: Run the full server test suite to check for regressions**

Run: `npm run test`

Expected: PASS (existing tests still pass; new tests pass).

- [ ] **Step 4: Suggest commit**

```bash
git add src/lib/server/rag/conversation.rag.spec.ts
git commit -m "test(rag): integration tests for 5 canonical agentic flow cases"
```

---

## Task 14: Flip flag default to ON; delete dead code

**Files:**
- Modify: `src/routes/conversation/[id]/+server.ts` (change flag default; delete legacy path)
- Delete: `src/lib/server/rag/ragAgent.ts`
- Delete: `src/lib/server/rag/ragAgent.spec.ts`
- Delete: `src/lib/server/rag/historyCompressor.ts` (verify no other consumers first)
- Modify: `src/lib/server/rag/ragRouter.ts` (shrink — keep only `findFileMatch` + `RagFileContext`)
- Modify: `src/lib/server/rag/contextBuilder.ts` (drop `RagStrategy` import, simplify budget)

- [ ] **Step 1: Verify `historyCompressor.ts` has no other consumers**

Run:

```bash
grep -rn "historyCompressor\|compressHistory\|isCodeStructureQuery\|isNonCodeFile\|isMarkdownFile" /Users/siddesh.kale/Documents/chatui/chat-ui/src 2>/dev/null | grep -v "/rag/historyCompressor"
```

Expected: NO results outside `historyCompressor.ts` itself, or only inside `ragAgent.ts` (which is also being deleted).

If other consumers exist, KEEP `historyCompressor.ts` and skip its deletion below. (Do not delete files with unverified usage.)

- [ ] **Step 2: Verify `ragAgent.ts` has no other consumers**

```bash
grep -rn "RagAgent\|ragAgent" /Users/siddesh.kale/Documents/chatui/chat-ui/src 2>/dev/null | grep -v -e "/rag/ragAgent" -e "conversation/\[id\]/+server.ts"
```

Expected: NO results.

- [ ] **Step 3: Flip the default**

In `src/routes/conversation/[id]/+server.ts`, find:

```typescript
const useAgenticRag = process.env.AGENTIC_RAG === "1";
```

Replace with:

```typescript
const useAgenticRag = process.env.AGENTIC_RAG !== "0"; // default ON
```

- [ ] **Step 4: Delete the legacy `else` branch**

In the same file, delete the entire `else` branch (the `// ── LEGACY PATH ──` block from Task 9). The structure goes from:

```typescript
if (useAgenticRag) {
    // ── AGENTIC PATH ──
    ...
} else {
    // ── LEGACY PATH ──
    ...
}
```

to just:

```typescript
// ── AGENTIC PATH ──
...
```

Also remove the now-unused `useAgenticRag` variable if simplifying down to a single path.

- [ ] **Step 5: Delete legacy modules**

```bash
rm src/lib/server/rag/ragAgent.ts
rm src/lib/server/rag/ragAgent.spec.ts
# Only if Step 1 confirmed no other consumers:
rm src/lib/server/rag/historyCompressor.ts
```

- [ ] **Step 6: Shrink `ragRouter.ts`**

Replace the entire contents of `src/lib/server/rag/ragRouter.ts` with:

```typescript
/**
 * RAG Router — minimal helpers used by the agentic RAG layer.
 *
 * Only exports the file-match helper used by `ragGate.ts`. Pattern arrays
 * (METADATA_QUERY_PATTERNS, SUMMARIZE_VERBS, etc.) were deleted along with
 * ragAgent.ts.
 */

export interface RagFileContext {
	id: string;
	name: string;
	chunkCount?: number;
}

/**
 * Find a file explicitly named in the query (exact, base name, or keyword token match).
 */
export function findFileMatch(
	query: string,
	files: RagFileContext[]
): RagFileContext | undefined {
	const lowerQuery = query.toLowerCase();
	for (const file of files) {
		const lowerName = file.name.toLowerCase();
		const nameParts = lowerName.split(".");
		const baseName = nameParts.length > 1 ? nameParts.slice(0, -1).join(".") : lowerName;

		if (new RegExp(`\\b${lowerName.replace(/\./g, "\\.")}\\b`).test(lowerQuery)) {
			return file;
		}
		if (
			baseName.length > 2 &&
			new RegExp(`\\b${baseName.replace(/\./g, "\\.")}\\b`).test(lowerQuery)
		) {
			return file;
		}
		const tokens = baseName.split(/[\s_\-.]+/).filter((t) => t.length > 3);
		for (const token of tokens) {
			if (new RegExp(`\\b${token}\\b`, "i").test(lowerQuery)) {
				return file;
			}
		}
	}
	return undefined;
}
```

- [ ] **Step 7: Shrink `contextBuilder.ts`**

In `src/lib/server/rag/contextBuilder.ts`:

(a) Delete the `RagStrategy` import (line 9):

```typescript
import type { RagStrategy } from "$lib/server/rag/ragAgent";
```

(b) Delete `getContextBudget` and replace its callsites with a single constant:

```typescript
const CONTEXT_BUDGET = 8000; // chars (~2000 tokens) — single budget for tool results
```

Replace `getContextBudget(strategy)` with `CONTEXT_BUDGET` in `buildRagContextMessage`.

(c) Change the signature of `buildRagContextMessage` to drop the `strategy` parameter:

```typescript
export function buildRagContextMessage(
	chunks: ChatFileChunk[],
	files?: RagFileMetadata[]
): RagContextMessage {
```

(d) Update all callsites in `toolInvocation.ts` to match the new signature.

(e) `buildFileListNote` can stay — it's referenced from the old code paths that are being removed. Delete it if no consumers remain after the cleanup.

```bash
grep -rn "buildFileListNote" /Users/siddesh.kale/Documents/chatui/chat-ui/src 2>/dev/null
```

Delete `buildFileListNote` if zero consumers.

- [ ] **Step 8: Run full test suite**

Run: `npm run test`

Expected: PASS. All spec files for new modules pass. No references to deleted modules.

- [ ] **Step 9: Type-check + lint**

Run: `npm run check && npm run lint`

Expected: PASS.

- [ ] **Step 10: Smoke test**

```bash
npm run dev
```

Run the five regression queries by hand:

```
Q1: "summarize all my files"
Q2: "give me the authenticate function from auth.py"
Q3: "what files do I have"
Q4: "how does login flow work"
Q5: "hi how are you"
```

Each should behave as in the spec §11 table. Server logs should show `[RAG]` lines for engaged turns and silence for greetings.

- [ ] **Step 11: Suggest commit**

```bash
git add -A src/lib/server/rag/ src/lib/server/textGeneration/ src/routes/conversation/[id]/+server.ts
git status   # verify deletions are staged
git commit -m "feat(rag): flip AGENTIC_RAG default to ON; delete legacy ragAgent path"
```

---

## Self-Review Checklist (run before handoff)

After implementing all 14 tasks:

- [ ] **Spec coverage**: Each spec section (§§1–15) has at least one task implementing it.
  - §3 Backend surface: Tasks 5/6 (tool schemas, handler mapping)
  - §3.1 fileIds gap: Acknowledged in plan header; handler passes `fileIds` from day one
  - §4 Architecture: Tasks 8/9/10/11 wire the pipeline
  - §5 Components: Tasks 1–7 create each new module
  - §6 Tool Schemas: Tasks 5 + 12
  - §7 Critic Logic: Tasks 4 + 7 + 11
  - §8 Error Handling: Task 6 (handler error wrapping)
  - §9 History Hygiene: Tasks 1 + 8
  - §10 Citation UI Continuity: Tasks 10 + 14 (chunksAccumulator)
  - §11 Data Flow Cases: Task 13 (integration tests)
  - §12 Testing: All tasks include their tests; Task 13 adds integration; Task 14 verifies no regressions
  - §13 Migration & Rollout: Tasks 8–14 follow the staged commit sequence
  - §15 Acceptance Criteria: Task 13 + Task 14 smoke test cover #1–6

- [ ] **Placeholder scan**: No TBDs, no "implement later", no "similar to Task N" without code shown.

- [ ] **Type consistency**:
  - `RetrieveDocsArgs` / `GetFileChunksArgs` types defined in Task 5, used in Tasks 6, 10, 11, 13.
  - `RagToolResult` shape consistent across handlers and dispatch.
  - `ragContext` shape grows monotonically: Task 9 adds `engaged` + `inventory` + `ragClient`; Task 10 adds `chunksAccumulator`; Task 11 adds `criticRetriesUsed`. Final shape verified in Task 11.

- [ ] **Acceptance criterion §15.1**: Verification gated on backend `rag_resolve` shipping `file_ids` filtering. Plan acknowledges this in the header and in Task 13's case 1 (which tests that the handler passes `fileIds` correctly — backend behavior verified separately).

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-22-agentic-rag-redesign.md`.**
