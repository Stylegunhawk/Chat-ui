# Frontend RAG Agentic Architecture

**Version:** 4.0 — Decoupled `runRagFlow` (MCP-tool-calling loop)
**Last Updated:** 2026-05-24

---

## Overview

The RAG system uses a **dedicated tool-calling loop** (`runRagFlow.ts`) that is fully independent of the MCP server infrastructure. Instead of a rule-based planner or an LLM orchestrator, the LLM itself decides which RAG tool to call on each turn — making retrieval agentic, transparent, and steerable via tool descriptions.

**Key Design Principles:**

1. **Separation of concerns** — RAG and MCP are completely independent code paths. `runRagFlow` never touches MCP server discovery, URL safety, or HF token forwarding.
2. **LLM-driven retrieval** — The model decides when to call `list_files`, `retrieve_docs`, or `get_file_chunks` based on tool descriptions and the conversation.
3. **Critic loop on semantic search** — `retrieve_docs` results are evaluated by `ragCritic`; weak hits trigger query reformulation and a retry (max 2 retries/turn).
4. **Graceful degradation** — If the model doesn't support tools, `runRagFlow` returns `"not_applicable"` and the caller falls through to MCP or plain generation.

---

## Architecture Flow

```
User Message (POST /conversation/[id])
  │
  ├─ 1. ragGate.shouldEngage(userQuery, files) → ENGAGED / SKIPPED
  │
  ├─ 2. Build ragContext { engaged, inventory, ragClient, chunksAccumulator, criticRetriesUsed: 0 }
  │
  └─ 3. textGeneration(ctx) → textGenerationWithoutTitle()
        │
        ├─ A. ctx.ragContext?.engaged → runRagFlow()
        │     │
        │     ├─ Guard: model.supportsTools || forceTools?
        │     │
        │     ├─ Advertise tools to LLM: [list_files, retrieve_docs, get_file_chunks]
        │     │
        │     └─ Tool-calling loop (max 10 iterations):
        │           LLM streams → tool_calls detected?
        │               Yes → dispatchRagToolCalls() → append tool messages → loop
        │               No  → emit FinalAnswer → return "completed"
        │
        ├─ B. "not_applicable" → runToolFlow() (pure MCP, no RAG tools)
        │
        └─ C. "not_applicable" → generate() (plain generation fallback)
```

---

## RAG Tools (advertised to LLM)

| Tool              | Description                                                       | When LLM uses it                                                     | Backend cost                                   |
| ----------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------- |
| `list_files`      | Returns all uploaded files with id, name, type, readiness         | Ambiguous query — discovers available files before deciding          | None (reads `ragContext.inventory` in-memory)  |
| `retrieve_docs`   | Semantic search across uploaded files, top-k chunks by similarity | Targeted question whose answer is in a specific part of a file       | `POST /api/v1/rag/chunk/semanticSearchForChat` |
| `get_file_chunks` | Sequential read of one file in chunk order                        | Summaries, listing all functions/classes/imports, full-file analysis | `GET /api/v1/rag/file/{fileId}/chunks`         |

### Tool routing rules (enforced via system prompt)

- `list_files` → unclear query, "what files do I have?", discovering context before retrieval
- `retrieve_docs` → "how does X work?", cross-file questions, finding specific content
- `get_file_chunks` → "summarize Y", "list all functions in Z", ANY exhaustive file task
- **Never** use `retrieve_docs` for exhaustive tasks — it returns top-k, not all content

---

## Critic Loop (retrieve_docs only)

After `retrieve_docs` returns chunks, `ragCritic.evaluate()` scores the quality:

| Verdict | Condition                                                   | Action                                                 |
| ------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| `PASS`  | `maxSimilarity >= 0.55` AND at least one `entry`-role chunk | Use chunks as-is                                       |
| `PASS`  | Graph expansion chunks present with entry role, ratio < 70% | Use chunks as-is                                       |
| `RETRY` | Weak relevance signal                                       | Reformulate query via LLM (1500ms timeout), retry once |
| `EMPTY` | Zero chunks returned                                        | Return `<rag_result empty="true"/>`                    |

Cap: `MAX_CRITIC_RETRIES = 2` per turn (`ragContext.criticRetriesUsed` tracks this).

Reformulation calls `generateFromDefaultEndpoint` with a 1500ms `Promise.race` — if the LLM is too slow the original query is retried unchanged.

Results from both the original call and the retry are merged by `mergeChunksById` (highest-similarity wins per unique chunk id).

---

## Agentic Gate (`ragGate.ts`)

Before `runRagFlow` is even called, `shouldEngage(userQuery, files)` decides whether RAG is needed:

```
files.length === 0 → false (no files, skip RAG entirely)
Greeting patterns  → false
Inventory meta     → true  ("what files do I have?")
File name match    → true  (user named a specific file)
FILE_REFERENCE_WORDS in query → true
STRONG_CONTENT_VERBS ("summarize", "review") → true
CONTENT_VERBS + CODE_REFERENCE_WORDS → true
GENERAL_KNOWLEDGE_PATTERNS → false
```

If not engaged, `ragContext.engaged = false` → `runRagFlow` returns `"not_applicable"` immediately.

---

## Multi-Turn Behavior

- **No re-retrieval of previous files** — system prompt instructs the LLM: each user message is an independent task; content from prior turns is already in conversation history.
- **Chunk accumulation** — all retrieved chunks across loops in one turn are pushed to `ragContext.chunksAccumulator`, which is persisted to the message metadata after generation for citation display.
- **Sequential read chunks** have `similarity: null` — the UI similarity bar is hidden for `get_file_chunks` results (sequential order has no semantic relevance score).

---

## Key Files

| File                                                  | Purpose                                                                                                        |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/lib/server/textGeneration/mcp/runRagFlow.ts`     | Self-contained RAG tool-calling loop. Owns all RAG tool dispatch.                                              |
| `src/lib/server/textGeneration/index.ts`              | Orchestrates: RAG → MCP → plain gen                                                                            |
| `src/lib/server/rag/ragTools.ts`                      | Tool definitions (`LIST_FILES_TOOL`, `RETRIEVE_DOCS_TOOL`, `GET_FILE_CHUNKS_TOOL`), handlers, `RAG_TOOL_NAMES` |
| `src/lib/server/rag/ragCritic.ts`                     | `evaluate()` + `reformulateQuery()` — quality gate on semantic search                                          |
| `src/lib/server/rag/ragGate.ts`                       | `shouldEngage()` — determines if RAG should run for this turn                                                  |
| `src/lib/server/rag/ragRouter.ts`                     | File-name matching helpers used by ragGate                                                                     |
| `src/lib/server/rag/contextBuilder.ts`                | Formats retrieved chunks into `<coderef>` XML for LLM context                                                  |
| `src/lib/server/rag/inventoryInjector.ts`             | Injects file inventory into the system prompt                                                                  |
| `src/lib/server/rag/historyHygiene.ts`                | Strips `<think>` blocks and noise from conversation history                                                    |
| `src/lib/server/rag/client.ts`                        | Server-side `RAGClient` with JWT authentication                                                                |
| `src/lib/rag/client.ts`                               | Shared types (`ChatFileChunk`, `RagFileMetadata`) and browser client                                           |
| `src/lib/server/textGeneration/utils/toolPrompt.ts`   | Builds system prompt with tool routing rules for the LLM                                                       |
| `src/lib/server/textGeneration/mcp/runMcpFlow.ts`     | Pure MCP flow — zero RAG knowledge                                                                             |
| `src/lib/server/textGeneration/mcp/toolInvocation.ts` | MCP tool execution — zero RAG knowledge                                                                        |
