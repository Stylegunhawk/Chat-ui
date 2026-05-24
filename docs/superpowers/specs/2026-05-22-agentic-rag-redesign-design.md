# Agentic RAG Redesign — Design Spec

**Status:** Draft — awaiting user review
**Date:** 2026-05-22
**Branch:** `cheatsheet`
**Author:** Sid (with Claude)
**Scope:** `src/lib/server/rag/`, `src/lib/server/textGeneration/mcp/`, `src/routes/conversation/[id]/+server.ts`. Backend frozen.

---

## 1. Motivation

The current RAG layer in `chat-ui` classifies every user query into one of four buckets (`NO_RAG`, `SUMMARIZE_FILE`, `SUMMARIZE_ALL`, `SEARCH`) using regex patterns in `ragAgent.ts:77`. This frontend classifier:

1. **Duplicates work the backend already does better.** The DevForge backend has Phase 12A query intelligence (intent classification, query expansion, semantic caching), hybrid retrieval (BM25 + vector with RRF fusion), cross-encoder reranking, code-graph BFS expansion, and deterministic context shaping. The frontend regex is a dumber layer sitting in front of a smarter system.
2. **Misses natural phrasings.** Queries like _"give me the `authenticate` function from auth.py"_ don't match any pattern and fall through to `SEARCH` without `fileIds` — so the backend searches across all tenant files instead of scoping to `auth.py`.
3. **Leaks prior retrieval into the current turn.** Prior `<coderef>` blocks remain in conversation history. When the new turn's retrieval is weak, the LLM falls back to _stale_ chunks from a previous summary request and answers from those.
4. **Wastes the backend's `rewriteQuery` parameter.** `ragAgent.ts:191` passes `rewriteQuery: plan.searchQuery` — literally the raw user query. The backend would honor an actual rewrite; we never send one.
5. **Wastes the backend's `fileIds` whitelist.** Never set, so retrieval always runs over the whole tenant index even when the user named a file.

This document specifies a replacement: an agentic RAG layer that exposes retrieval as **tools** the LLM calls, with a deterministic server-side critic for re-retrieval and clean history hygiene.

---

## 2. Goals & Non-Goals

### Goals

- Replace the regex classifier with LLM-driven tool calls (`retrieve_docs`, `get_file_chunks`).
- Actually use the backend's `fileIds` and `rewriteQuery` parameters.
- Add a deterministic critic that re-retrieves on weak results (capped retries).
- Strip prior RAG context blocks from history before each turn — kill the leak-from-history bug.
- Preserve the `ragEnabled` toggle UX exactly.
- Preserve the citation UI exactly.
- Bound worst-case latency.

### Non-goals

- Changing the backend. The contract (`/api/v1/rag/*` endpoints) is frozen.
- Changing chunking, embedding, or reranking. Backend owns these.
- New UI affordances beyond the inventory text already required.
- A multi-agent planner / synthesizer architecture (overkill — backend already plans internally).
- A `recall_context` tool for prior-turn chunks (strip-and-re-retrieve covers it).

---

## 3. Backend Surface (Inputs — frozen)

The five endpoints the redesign uses, in their canonical Phase 15 forms:

| Endpoint                                  | Method | Purpose                                  | Key inputs                                                     |
| ----------------------------------------- | ------ | ---------------------------------------- | -------------------------------------------------------------- |
| `/api/v1/rag/chunk/semanticSearchForChat` | POST   | Hybrid search + rerank + graph expansion | `userQuery`, `rewriteQuery?`, `fileIds?`, `top_k`, `messageId` |
| `/api/v1/rag/file/{id}/chunks`            | GET    | Sequential chunks for one file           | `limit`, `offset`                                              |
| `/api/v1/rag/files`                       | GET    | Tenant file inventory                    | —                                                              |
| `/api/v1/rag/file/upload`                 | POST   | Upload (untouched by this redesign)      | multipart                                                      |
| `/api/v1/rag/file/{id}`                   | DELETE | Hard delete (untouched)                  | —                                                              |

The chunk response shape includes `similarity`, `role: "entry" | "dependency" | "supporting"`, `is_graph_expansion`, and `expanded_from` — all of which the critic uses to evaluate retrieval quality.

### 3.1 Backend dependency — `fileIds` filtering (parallel work)

**The backend currently accepts `fileIds` in the request schema but ignores it in `retrieve_with_reranking()`** (`agent.py:837` — no `file_ids` parameter threaded into `_vector_search()` or store-level `search()`). The infrastructure exists (`file_id` is in chunk metadata; both stores have `get_chunks_by_file_id()`) but isn't wired into the semantic-search path.

**This redesign assumes the backend will add `file_ids` filtering in the `rag_resolve` branch in parallel.** The frontend `retrieve_docs` tool will pass `fileIds` from day one; until the backend lands the filter, scoping will silently no-op (backend will return chunks from all files) — but no frontend changes will be needed once the backend ships. Acceptance criterion §15.1 cannot be verified until both ship.

### 3.2 Schema field mapping (frontend → backend)

The tool schema exposes parameters in LLM-friendly form. The `ragTools.ts` handler maps them to the backend's `SemanticSearchRequest`:

| Tool param (LLM-facing) | Backend field  | Notes                                                                                           |
| ----------------------- | -------------- | ----------------------------------------------------------------------------------------------- |
| `query`                 | `userQuery`    | Renamed for LLM clarity ("query" is more intuitive).                                            |
| `rewriteQuery`          | `rewriteQuery` | Pass-through.                                                                                   |
| `fileIds`               | `fileIds`      | Pass-through. Awaiting backend wiring (§3.1).                                                   |
| `top_k`                 | `top_k`        | Pass-through.                                                                                   |
| _(not exposed to LLM)_  | `messageId`    | **Server-generated** by the handler via `crypto.randomUUID()` per call. Not in the tool schema. |

### 3.3 Backend behavior notes for the critic

- `get_file_chunks` returns chunks with `similarity: 1.0` hardcoded (sequential reads aren't ranked). The critic will always PASS on these — by design, since sequential reads are user-intent-driven, not relevance-driven.
- `similarity` on `retrieve_docs` results is the pre-rerank vector score (post-sigmoid normalization), not the rerank score — `ChunkResult.rerank_score` is a dataclass attribute, not in metadata, so the router doesn't surface it. The critic's `MIN_SIMILARITY_FLOOR = 0.55` is calibrated against this pre-rerank signal.
- The backend's semantic cache key does not include `fileIds`. A cached response for `"authenticate function"` without `fileIds` could be returned for the same query _with_ `fileIds`. This is a backend concern flagged for the `rag_resolve` branch — frontend treats cache as opaque.

---

## 4. Architecture

### 4.1 Layered gating

```
ragEnabled toggle (per-conversation, MongoDB)
    │
    ├─ OFF  →  strip history (cleanup is always safe)
    │         skip inventory inject, skip tool advertisement.
    │         (toolPrompt already emits "RAG IS OFF" string)
    │
    └─ ON   →  strip history
              binary gate evaluates per-turn:
                ├─ files=[]                       → skip tool loop
                ├─ files exist, clearly non-RAG   → skip tool loop
                └─ files exist + plausibly needs  → enter tool loop
```

### 4.2 Per-turn pipeline (when tool loop engaged)

```
1. listFiles()                                 — sync inventory
2. stripPriorRagBlocks(messagesForPrompt)      — kill stale context
3. ragGate.shouldEngage(userQuery, files, hist) — binary engage decision
4. inventoryInjector.build(files)              — prepend "## Uploaded Files"
5. runMcpFlow with oaTools += [retrieve_docs, get_file_chunks]
       LLM tool-calls 0..N times.
       After each retrieve_docs result:
         ragCritic.evaluate(chunks) →
           PASS  → return result to LLM
           RETRY → reformulate via 1-shot LLM, fire one more backend call,
                   merge results, return to LLM
           EMPTY → return [], LLM tells user
6. Accumulate all chunks → messageToWriteTo.ragChunks (citation UI)
7. LLM streams final answer
```

### 4.3 Key changes vs current

| Current                                        | After                                                   |
| ---------------------------------------------- | ------------------------------------------------------- |
| 4-bucket regex classifier (`ragAgent.ts`)      | Binary gate + LLM tool calling                          |
| One retrieval per turn, server-decides         | LLM decides; up to 2 retrievals + 2 retries per turn    |
| `fileIds` never passed                         | LLM passes `fileIds` from inventory                     |
| `rewriteQuery === userQuery`                   | LLM writes `rewriteQuery`; critic reformulates on retry |
| Prior `<coderef>` blocks stay in history       | Stripped every turn                                     |
| No critic                                      | Deterministic critic (similarity floor + role mix)      |
| `retrieve_docs` mentioned in prompt but unused | `retrieve_docs` actually called by the LLM              |

---

## 5. Components

### 5.1 New modules — `src/lib/server/rag/`

| File                   | Lines (est.) | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ragGate.ts`           | ~60          | Pure binary "engage RAG this turn?" function.                                                                                                                                                                                                                                                                                                                                                                                              |
| `historyHygiene.ts`    | ~50          | `stripPriorRagBlocks(messages)` — idempotent, mutation-safe.                                                                                                                                                                                                                                                                                                                                                                               |
| `ragCritic.ts`         | ~80          | `evaluate(chunks)` + `reformulateQuery(...)`. Deterministic verdict + LLM-backed rewrite.                                                                                                                                                                                                                                                                                                                                                  |
| `ragTools.ts`          | ~120         | OpenAI tool schemas + handlers for `retrieve_docs` and `get_file_chunks`. Handler responsibilities: (a) map `query → userQuery`; (b) auto-generate `messageId` via `crypto.randomUUID()`; (c) validate `fileIds` against inventory and drop unknown ones with a warning; (d) clamp `top_k`/`limit` defensively; (e) format chunks into `<rag_result>` blocks via `contextBuilder`; (f) push chunks to the per-turn `ragChunksAccumulator`. |
| `inventoryInjector.ts` | ~40          | Builds the `## Uploaded Files` system-prompt block.                                                                                                                                                                                                                                                                                                                                                                                        |

### 5.2 Modified files

| File                                                | Changes                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/routes/conversation/[id]/+server.ts:320-410`   | Replace RAG injection block. New flow: strip → toggle check → gate → inventory → tool loop.             |
| `src/lib/server/textGeneration/mcp/runMcpFlow.ts`   | Filter RAG tools out of `oaTools` when `ragEnabled === false`. Hook critic between tool result and LLM. |
| `src/lib/server/textGeneration/utils/toolPrompt.ts` | Rewrite `retrieve_docs` block. Drop `rerank_docs` mention.                                              |
| `src/lib/server/rag/contextBuilder.ts`              | Shrunk: single budget value, drop `RagStrategy` import, move `buildFileListNote` to inventoryInjector.  |
| `src/lib/server/rag/ragRouter.ts`                   | Shrunk: keep `findFileMatch()`, drop all pattern arrays + `inferActiveFile()`. ~30 lines remain.        |

### 5.3 Deleted

| File                                                  | Reason                                                |
| ----------------------------------------------------- | ----------------------------------------------------- |
| `src/lib/server/rag/ragAgent.ts` (248 lines)          | Replaced by tool-loop + critic.                       |
| `src/lib/server/rag/ragAgent.spec.ts` (128 lines)     | New unit tests cover the replacement.                 |
| `src/lib/server/rag/historyCompressor.ts` (128 lines) | Only consumer was `ragAgent`. Verify before deleting. |

### 5.4 Untouched

- `src/lib/server/rag/client.ts` — HTTP client
- `src/lib/server/rag/auth.ts` — JWT auth
- `src/lib/rag/*` — browser-side
- `src/lib/components/chat/RagFileManager.svelte`
- `src/lib/components/chat/RagReferenceCard.svelte`
- `src/lib/components/chat/ChatInput.svelte` — toggle stays exactly as-is

### 5.5 Module boundaries

```
                  ┌──────────────────────────┐
                  │ +server.ts (orchestrator)│
                  └────────────┬─────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
┌───────────────┐    ┌─────────────────┐    ┌──────────────────┐
│ historyHygiene│    │     ragGate     │    │ inventoryInjector│
│   (pure fn)   │    │    (pure fn)    │    │    (pure fn)     │
└───────────────┘    └─────────────────┘    └──────────────────┘
                                                     │
                                                     ▼
                                            ┌──────────────────┐
                                            │   runMcpFlow.ts  │
                                            │  (tool exec loop)│
                                            └────────┬─────────┘
                                                     │
                                ┌────────────────────┴────────────────────┐
                                ▼                                         ▼
                       ┌─────────────────┐                       ┌────────────────┐
                       │    ragTools     │◄────────uses─────────►│   ragCritic    │
                       │ (tool handlers) │                       │ (eval + retry) │
                       └────────┬────────┘                       └────────┬───────┘
                                │                                         │
                                ▼                                         ▼
                       ┌─────────────────┐                       ┌────────────────┐
                       │   RAGClient     │                       │ contextBuilder │
                       │   (HTTP wrapper)│                       │ (format chunks)│
                       └─────────────────┘                       └────────────────┘
```

Pure functions (gate, hygiene, inventory) have zero cross-dependencies. RAGClient stays the only HTTP boundary.

---

## 6. Tool Schemas

### 6.1 `retrieve_docs`

```json
{
	"type": "function",
	"function": {
		"name": "retrieve_docs",
		"description": "Search the user's uploaded files (PDFs, code, docs) for content relevant to a query. The backend performs hybrid search (BM25 + vector) with reranking and code-graph expansion. Returns the most relevant chunks with file/line metadata. Use this whenever you need actual content from an uploaded file — do NOT guess. Use fileIds to scope when the user names a specific file; omit fileIds for broad questions.",
		"parameters": {
			"type": "object",
			"properties": {
				"query": {
					"type": "string",
					"description": "The user's natural-language question, as-is."
				},
				"rewriteQuery": {
					"type": "string",
					"description": "OPTIONAL but RECOMMENDED. Your own optimized search query — keywords, function names, technical terms."
				},
				"fileIds": {
					"type": "array",
					"items": { "type": "string" },
					"description": "OPTIONAL whitelist of file IDs to scope the search. Look IDs up in the `## Uploaded Files` inventory."
				},
				"top_k": {
					"type": "integer",
					"default": 5,
					"minimum": 1,
					"maximum": 20,
					"description": "Number of chunks to return. Start with 5. Use 10+ for summarization."
				}
			},
			"required": ["query"]
		}
	}
}
```

**Server-side parameters not exposed to the LLM:**

- `messageId` — auto-generated per call by `ragTools.ts` via `crypto.randomUUID()`. The backend requires this on every `SemanticSearchRequest`; the LLM should never see or set it.
- The schema's `query` param is mapped to the backend's `userQuery` field by the handler.

### 6.2 `get_file_chunks`

```json
{
	"type": "function",
	"function": {
		"name": "get_file_chunks",
		"description": "Read a specific uploaded file sequentially, chunk by chunk. Use for SUMMARIZATION or full-file reading. Unlike retrieve_docs (semantic search), this returns chunks in original document order.",
		"parameters": {
			"type": "object",
			"properties": {
				"fileId": { "type": "string", "description": "File ID from the inventory." },
				"limit": { "type": "integer", "default": 8, "minimum": 1, "maximum": 30 },
				"offset": { "type": "integer", "default": 0, "minimum": 0 }
			},
			"required": ["fileId"]
		}
	}
}
```

### 6.3 Tool result shape

Tool results are returned to the LLM as a single text block wrapped in `<rag_result>` so it can be distinguished from system-injected context and cleanly stripped next turn by `historyHygiene`:

````xml
<rag_result query="authenticate function" fileIds="[f_auth]" top_k="10">
  <coderef id="..." index="1">
    File: auth.py
    Relevance: 84%
    Role: entry
    Line: 42
    Source URL: ...

    ```python
    def authenticate(token: str) -> User | None:
        ...
    ```
  </coderef>
  ---
  <coderef id="..." index="2">
    ...
  </coderef>
</rag_result>
````

### 6.4 System prompt — inventory block

When `ragEnabled && gate=true`, prepended before tool preprompt:

```
## Uploaded Files

The user has 3 uploaded file(s) available for retrieval:
- **auth.py** (12 chunks, id=`f_auth`) — http://.../static/uploads/auth.py
- **utils.py** (8 chunks, id=`f_utils`)
- **api_design.pdf** (24 chunks, id=`f_pdf_api`) — http://.../static/uploads/api_design.pdf

Use `retrieve_docs` with `fileIds` to scope search to specific files, or omit `fileIds`
for cross-file queries. Use `get_file_chunks` to read a file sequentially.
```

### 6.5 `toolPrompt.ts` changes

Replace lines 37–39 with:

```
## RAG TOOLS (UPLOADED FILES)
- retrieve_docs(query, rewriteQuery, fileIds, top_k):
    • SEMANTIC SEARCH across uploaded files. Backend handles reranking + graph expansion.
    • ALWAYS pass `rewriteQuery` — extract keywords, identifiers, technical terms.
    • ALWAYS pass `fileIds` when the user names a specific file.
    • OMIT fileIds for cross-file questions.
    • Default top_k=5; raise to 10+ for summarization.
    • Call multiple times in parallel for cross-file questions.

- get_file_chunks(fileId, limit, offset):
    • SEQUENTIAL READ of one file. Use for "summarize X", "walk me through Y".
    • Returns chunks in original document order.

## WHEN NOT TO CALL RAG TOOLS
- Greetings, general knowledge, math, code unrelated to uploads.
- Questions about prior assistant responses.
- After a retrieval already answered the question in this turn.

## CITING SOURCES
- Reference chunks by file + line (e.g., "auth.py:42").
- Tool results show chunks inside <coderef> tags — reproduce code verbatim from them.
```

The `rerank_docs` mention is dropped (backend reranking is automatic, not a separate tool the LLM should think about).

---

## 7. Critic Logic

### 7.1 Evaluation

```ts
const MIN_SIMILARITY_FLOOR = 0.55;
const MIN_ENTRY_CHUNKS = 1;
const MAX_GRAPH_ONLY_RATIO = 0.7;

function evaluate(chunks: ChatFileChunk[]): CriticVerdict {
  if (chunks.length === 0) return { verdict: "EMPTY", ... };

  const directHits = chunks.filter(c => !c.is_graph_expansion);
  const maxSim = Math.max(...directHits.map(c => c.similarity ?? 0), 0);
  const entryCount = chunks.filter(c => c.role === "entry").length;
  const graphOnlyRatio = chunks.filter(c => c.is_graph_expansion).length / chunks.length;

  if (maxSim >= MIN_SIMILARITY_FLOOR && entryCount >= MIN_ENTRY_CHUNKS) {
    return { verdict: "PASS", ... };
  }
  if (entryCount >= MIN_ENTRY_CHUNKS && graphOnlyRatio < MAX_GRAPH_ONLY_RATIO) {
    return { verdict: "PASS", reason: "weak vector but useful graph context", ... };
  }
  return { verdict: "RETRY", ... };
}
```

### 7.2 Retry budget

```
MAX_RETRIES_PER_TOOL_CALL = 1   // one retry attached to a single retrieve_docs call
MAX_RETRIES_PER_TURN      = 2   // total critic-triggered retries across all retrieve_docs
                                // calls in one turn (NOT a cap on LLM-initiated tool calls)
CRITIC_TIMEOUT_MS         = 1500
```

If the LLM calls `retrieve_docs` three times in one turn and the first two trigger retry, the third weak result will NOT retry (turn cap reached). LLM-initiated tool calls themselves are bounded by the existing `runMcpFlow` iteration limit.

Reformulator failure → templated fallback (`query + " " + topMatchedFilename`).

### 7.3 Reformulator prompt

```
The user asked: "{userQuery}"
Files available: {fileNamesCsv}
Initial search returned weak results (max similarity {maxSim}, no entry-role chunks).

Reformulate as a precise SEARCH QUERY:
- Include specific identifiers, function/class names, technical terms.
- Drop filler words ("what's the thing that", "can you tell me").
- One line only. No explanation.

Reformulated query:
```

Same model as chat (cheap due to tiny token count).

---

## 8. Error Handling

| Failure                                 | Handling                                                                                     | User behavior                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------- |
| `semanticSearch` 401                    | One retry with refreshed JWT; if still 401 → tool returns `{ error }`                        | LLM tells user to re-login            |
| `semanticSearch` 404 (no files)         | Returns `{ chunks: [] }` (existing)                                                          | LLM tells user no files               |
| `semanticSearch` 5xx / timeout          | Tool returns `{ error }`. No exception propagated.                                           | LLM acknowledges, falls back          |
| `getFileChunks` failure                 | Same pattern                                                                                 | Same                                  |
| Reformulator LLM fails                  | Templated fallback                                                                           | Invisible — retry still happens       |
| `listFiles()` fails                     | Use frontend-only file list (existing fallback at `+server.ts:347`)                          | RAG still works with thinner metadata |
| Mid-stream toggle off                   | Affects next turn only                                                                       | No impact on current turn             |
| LLM passes unknown `fileIds`            | Drop them; log warning; if all unknown return `{ error }`                                    | LLM gets error, can retry             |
| Unready files (`finishEmbedding=false`) | Inventory shows `(processing — not searchable yet)`; tool rejects `fileIds` pointing at them | LLM tells user to wait                |
| Toggle ON, zero files                   | Gate returns false                                                                           | Normal chat                           |
| Toggle ON, "what files do I have?"      | Gate=false but inventory still injected; LLM answers from text                               | Same UX as today's NO_RAG             |

---

## 9. History Hygiene

```ts
const RAG_BLOCK_PATTERN = /^# Retrieved Document Context[\s\S]*?\n---\n\n/;
const RAG_RESULT_TAG_PATTERN = /<rag_result\b[\s\S]*?<\/rag_result>\s*/g;
const FILE_INVENTORY_PATTERN = /^## Uploaded Files\n[\s\S]*?\n\n/;
const FILE_LIST_NOTE_PATTERN =
	/^## Uploaded Files\nThe user has \d+ uploaded file\(s\)[\s\S]*?\n\n/;

function stripPriorRagBlocks(messages: Message[]): Message[] {
	return messages.map((m, idx) => {
		if (idx === messages.length - 1) return m; // never strip current turn
		if (m.from !== "user" || typeof m.content !== "string") return m;
		let content = m.content;
		content = content.replace(RAG_BLOCK_PATTERN, "");
		content = content.replace(FILE_INVENTORY_PATTERN, "");
		content = content.replace(FILE_LIST_NOTE_PATTERN, "");
		content = content.replace(RAG_RESULT_TAG_PATTERN, "");
		return content === m.content ? m : { ...m, content };
	});
}
```

Properties: idempotent, mutation-safe (new objects only when changed), last-message protected, assistant-message no-op.

History stripping runs **regardless of `ragEnabled`** — cleanup is always safe and prevents stale chunks from misleading the LLM if the user toggles RAG off mid-conversation.

---

## 10. Citation UI Continuity

`messageToWriteTo.ragChunks` is populated from the **union** of all tool-call results in the turn:

```ts
// in runMcpFlow.ts:
ragChunksAccumulator.push(...resultChunks);

// at end of turn:
messageToWriteTo.ragChunks = dedupeByChunkId(ragChunksAccumulator);
messageToWriteTo.ragStrategy = "AGENTIC"; // single new strategy label
```

`RagReferenceCard.svelte` reads `ragChunks` unchanged — citations render identically.

---

## 11. Data Flow Cases

| Case                                             | Gate  | Tool calls                   | Critic       | Latency vs today    |
| ------------------------------------------------ | ----- | ---------------------------- | ------------ | ------------------- |
| Greeting (`"hi"`)                                | false | 0                            | —            | Same (~0)           |
| Bug case (`"give me authenticate from auth.py"`) | true  | 1 `retrieve_docs` w/ fileIds | PASS         | +1 LLM round-trip   |
| Vague (`"thing that handles login"`)             | true  | 1 + retry                    | RETRY → PASS | +1 LLM + +1 backend |
| Cross-file (`"how does login flow"`)             | true  | 2 parallel `retrieve_docs`   | PASS×2       | +1 LLM round-trip   |
| Toggle OFF                                       | n/a   | 0 (tools filtered)           | —            | Same                |
| Summary (`"summarize all my files"`)             | true  | N `get_file_chunks`          | —            | +1 LLM round-trip   |

---

## 12. Testing

### 12.1 Unit (Vitest, server workspace)

| File                        | Cases                                                     |
| --------------------------- | --------------------------------------------------------- |
| `ragGate.spec.ts`           | ~12 — engage decisions across query types                 |
| `historyHygiene.spec.ts`    | ~8 — strip patterns, idempotency, last-message protection |
| `ragCritic.spec.ts`         | ~10 — verdict matrix                                      |
| `inventoryInjector.spec.ts` | ~5 — file inventory rendering                             |
| `ragTools.spec.ts`          | ~8 — handler validation, error pass-through, dedup        |

### 12.2 Integration

| File                       | Cases                       |
| -------------------------- | --------------------------- |
| `conversation.rag.spec.ts` | 5 — one per Section 11 case |
| `ragCritic.retry.spec.ts`  | retry flow + per-turn cap   |

### 12.3 Regression queries

Run end-to-end against mock backend with fixed canned responses:

```
Q1: "summarize all my files"
Q2: "give me the authenticate function from auth.py"   ← the original bug
Q3: "what files do I have"
Q4: "how does login flow work"
Q5: "hi how are you"
```

Snapshot tool-call sequence and final `ragChunks`. Snapshot churn = behavior change.

### 12.4 Deletions

- `ragAgent.spec.ts` (128 lines)
- `contextBuilder.spec.ts` (65 lines) if existing snapshot no longer applies

---

## 13. Migration & Rollout

### 13.1 Staged commits (single PR)

```
1. Scaffolding — add 5 new files (stubs + tests). Production unchanged.
2. Wire history stripping in +server.ts. Safe regardless of flag.
3. Add retrieve_docs + get_file_chunks to oaTools behind AGENTIC_RAG=1 env flag.
4. Inventory injection + binary gate (behind flag).
5. Wire critic into runMcpFlow tool-result hook.
6. Flip AGENTIC_RAG=1 default. Delete ragAgent.ts, ragAgent.spec.ts, dead patterns
   in ragRouter.ts, historyCompressor.ts if no other consumers.
```

### 13.2 Feature flag

Single env var `AGENTIC_RAG` (default `0` until commit 6). One server-side check at the top of the RAG block. Toggle button stays orthogonal.

### 13.3 Rollback

- `historyHygiene` is idempotent — safe even if everything else reverts.
- Tool handlers are pure wrappers over existing `RAGClient` methods — no new endpoints.
- Flag flip drops back to old `ragAgent` path.

### 13.4 Observability

```
[RAG] ────────────────────────────
- Toggle      : ON
- Gate        : ENGAGED (reason: filename match "auth.py" + content verb "authenticate")
- Inventory   : 3 files injected
- Tool calls  : retrieve_docs (1), get_file_chunks (0)
- Critic      : PASS (maxSim=0.84, entry=1, graphOnly=0.0)
- Total chunks: 5
─────────────────────────────────
```

---

## 14. Open Questions

- **Reformulator model choice.** Same as chat model, or a smaller/cheaper model? Decide during implementation based on observed latency.
- **Backend `expansion_count` use.** Could be a critic signal beyond the current ratio check. Defer until we see real production data.
- **Multi-file `get_file_chunks` parallelism.** When the LLM calls it for multiple files in a "summarize all" intent, run in parallel? Backend handles concurrent reads fine; LLM tool-calling already supports parallel calls.
- **Backend semantic cache & `fileIds`.** Cache keys do not include `fileIds`, so a cached non-scoped result may be returned for a scoped query. Flagged for the `rag_resolve` backend branch — frontend treats cache as opaque.

---

## 15. Acceptance Criteria

1. The original bug query (_"give me the `authenticate` function from auth.py"_) returns the actual function content from `auth.py`, not stale chunks from a prior summary. **Verification gated on backend `rag_resolve` shipping `file_ids` filtering (§3.1)** — until then, the frontend will pass `fileIds` but scoping will silently no-op.
2. All five regression queries in §12.3 pass snapshot tests.
3. `ragEnabled=false` removes RAG tools from the LLM's tool list (verified by snapshotting `oaTools`).
4. Citation UI continues to render correctly across all five cases.
5. `ragAgent.ts` is deleted; no imports of it remain in the codebase.
6. Critic-triggered retries are bounded: ≤2 backend retry calls + ≤2 reformulator calls per turn, irrespective of how many tool calls the LLM makes. (LLM-initiated tool-call rounds are bounded by `runMcpFlow`'s existing iteration limit, not by this redesign.)

---

**End of design.** Implementation plan to follow via the writing-plans skill.
