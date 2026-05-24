# Decoupled RAG Flow — `runRagFlow.ts` Design Spec

**Date:** 2026-05-24  
**Branch:** `cheatsheet`  
**Status:** Approved — ready for implementation plan  
**Replaces:** Task 10 / Task 11 in `2026-05-22-agentic-rag-redesign.md` (the `runMcpFlow.ts` wiring sections)

---

## 1. Problem Statement

The current agentic RAG implementation wires `retrieve_docs` and `get_file_chunks` directly into `runMcpFlow.ts`. This creates three concrete bugs:

1. **`ragContext` is never forwarded** — `textGeneration/index.ts:55–69` calls `runToolFlow()` without `ragContext: ctx.ragContext`, so RAG tools are never advertised to the LLM. The LLM sees the `## Uploaded Files` inventory block but has no tools to call. Every turn produces the same answer — the "stuck at same" symptom.

2. **RAG is gated behind MCP server checks** — `runMcpFlow.ts` has multiple `if (servers.length === 0)` guards that must be individually bypassed with `if (ragContext?.engaged)` escape hatches. This is fragile and will regress as the file evolves.

3. **Tool dispatch is split across two files** — `toolInvocation.ts` contains a 90-line RAG dispatch block that reimplements critic, retry, and chunk accumulation. Removing it from there and owning it inside the RAG flow makes both files simpler.

---

## 2. Goals

- **One entry point for all agentic RAG calls.** Every call to `semanticSearchForChat` and `file/{id}/chunks` goes through `runRagFlow.ts`. Nothing in `runMcpFlow.ts` or `toolInvocation.ts` touches RAG.
- **Zero MCP dependency.** RAG works with zero MCP servers configured.
- **Same LLM tool-calling UX.** The LLM still decides when to call `retrieve_docs` / `get_file_chunks` — the agentic behaviour from the spec is preserved.
- **Professional reliability.** Abort support, per-turn retry cap, graceful fallback when RAG backend is unreachable, structured logging at every decision point.
- **Clean MCP.** `runMcpFlow.ts` and `toolInvocation.ts` become purely MCP concerns.

---

## 3. Backend API Contract (frozen — DevForge v1.3.0)

All endpoints require `Authorization: Bearer <tenant_jwt>`.  
JWT is obtained via `RAGClient.getJWT()` using `locals.sessionId`.

### 3.1 Semantic Search

```
POST /api/v1/rag/chunk/semanticSearchForChat
Authorization: Bearer <tenant_jwt>
Content-Type: application/json

{
  "messageId": "<uuid>",        // required — server-generated per call
  "userQuery": "<string>",      // required — natural-language query
  "fileIds": ["<uuid>", ...],   // optional — scope to specific files (vector-only when set)
  "top_k": 5                    // optional — default 5, max 50
}
```

Response: `SemanticSearchResponse` — `{ chunks, queryId, expansion_count }`

Each chunk: `{ id, fileId, filename, fileType, fileUrl, text, similarity, pageNumber, role, is_graph_expansion, expanded_from }`

Roles: `"entry"` (primary match) | `"dependency"` (called by entry) | `"supporting"` (related)  
Graph expansion: runs automatically server-side when `ENABLE_CODE_GRAPH=true`. No per-request flag.  
When `fileIds` is set: BM25/hybrid search is disabled; vector-only `WHERE file_id = ANY(fileIds)`. Graph expansion still runs on anchors.

### 3.2 Sequential Chunk Retrieval

```
GET /api/v1/rag/file/{fileId}/chunks?limit=8&offset=0
Authorization: Bearer <tenant_jwt>
```

Response: same `SemanticSearchResponse` schema. `is_graph_expansion` always `false`, `expansion_count` always `0`. `similarity` hardcoded `1.0` (not scored — sequential read).

### 3.3 File Listing (used in `+server.ts` for inventory — not in `runRagFlow`)

```
GET /api/v1/rag/files
Authorization: Bearer <tenant_jwt>
```

File listing happens in `+server.ts` before the LLM call. `runRagFlow` receives the already-hydrated inventory via `ragContext.inventory`.

---

## 4. Architecture

### 4.1 New File: `src/lib/server/textGeneration/mcp/runRagFlow.ts`

A self-contained, ~250-line RAG tool-calling loop. No imports from `runMcpFlow.ts`. No MCP server discovery. No URL safety checks. No HF token forwarding. No Exa injection. No router resolution.

**Context type:**

```typescript
export type RunRagFlowContext = Pick<
  TextGenerationContext,
  "model" | "conv" | "locals" | "forceTools" | "ragContext"
> & {
  messages: EndpointMessage[];
  preprompt?: string;
  abortSignal?: AbortSignal;
  abortController?: AbortController;
  promptedAt?: Date;
};
```

**Return type:** `ToolFlowResult` — `"completed" | "not_applicable" | "aborted"` (same as `runMcpFlow.ts`).

**Guard conditions (return `"not_applicable"` immediately):**
- `ragContext?.engaged !== true`
- Model does not support tools: `!model.supportsTools && !forceTools`

**Tool list:** `[RETRIEVE_DOCS_TOOL, GET_FILE_CHUNKS_TOOL]` — imported from `ragTools.ts`.

**System prompt assembly:**
```
buildToolPreprompt([RETRIEVE_DOCS_TOOL, GET_FILE_CHUNKS_TOOL])
  + preprompt (if any)
  + "Note: Document search (RAG) is currently disabled..." (if conv.ragEnabled === false)
```

The `## Uploaded Files` inventory is already injected into the last user message by `+server.ts` before the flow runs. No duplicate injection here.

**Tool loop (max 10 iterations):**

```
for loop in 0..9:
  checkAborted() → "aborted"
  
  stream OpenAI completion (same base params: model, temperature, top_p, stop, max_tokens, tools, tool_choice="auto")
  
  for each token chunk:
    handle reasoning delta → <think> wrapping (same as runMcpFlow)
    yield Stream update (only when no tool calls in flight)
    checkAborted()
  
  if tool calls present:
    if missing tool_call id → non-stream retry to recover ids (same pattern as runMcpFlow)
    for await (const event of dispatchRagToolCalls(calls, ragContext)):
      if event.type === "update" → yield event.update   // ToolCall, ETA, Result UI events
      if event.type === "complete" → collect toolMessages
    append assistantToolMessage + toolMessages to messagesOpenAI
    continue loop
  
  // No tool calls — finalize
  if thinkOpen → close </think>
  yield FinalAnswer
  return "completed"

// Loop exhausted
return "not_applicable"  // triggers plain generation fallback
```

### 4.2 RAG Tool Dispatch (internal to `runRagFlow.ts`)

A private `dispatchRagToolCalls()` async generator handles tool execution, yielding `MessageUpdate` events for real-time UI (ToolCall, ETA, Result) exactly as `executeToolCalls` does today. The outer loop consumes it with `for await`:

**For `retrieve_docs`:**
1. `handleRetrieveDocs(args, { ragClient, inventory })` → `RagToolResult`
2. `ragCritic.evaluate(result.chunks)` → verdict
3. If `verdict === "RETRY"` and `ragContext.criticRetriesUsed < 2`:
   - `reformulateQuery(...)` with a 1500ms timeout (race against `setTimeout` reject)
   - Retry `handleRetrieveDocs` with reformulated query
   - `mergeChunksById(original, retry)` — union by id, highest similarity wins
   - Re-evaluate merged result
   - `ragContext.criticRetriesUsed++`
4. Format: `<rag_result tool="retrieve_docs" verdict="PASS|RETRY|EMPTY">...chunks...</rag_result>`
5. Push chunks to `ragContext.chunksAccumulator`

**For `get_file_chunks`:**
1. `handleGetFileChunks(args, { ragClient, inventory })` → `RagToolResult`
2. No critic (similarity=1.0, sequential read — critic always passes; skip it)
3. Format: `<rag_result tool="get_file_chunks">...chunks...</rag_result>`
4. Push chunks to `ragContext.chunksAccumulator`

**Error handling:** Any thrown error becomes `<rag_result tool="..." error="true" message="..."/>`. Never throws out of `dispatchRagToolCalls`. The LLM sees the error and can explain it to the user.

**Chunk formatting:** `buildRagContextMessage(chunks)` from `contextBuilder.ts` — unchanged.

**Tool result message for OpenAI history:**
```typescript
{ role: "tool", tool_call_id: call.id, content: "<rag_result ...>...</rag_result>" }
```

### 4.3 Modified: `src/lib/server/textGeneration/index.ts`

**Before (broken):**
```typescript
const mcpGen = runToolFlow({ ...ctx, ragFiles: ctx.ragFiles }); // ragContext missing
```

**After:**
```typescript
// 1. RAG-only tool loop (when gate engaged)
if (ctx.ragContext?.engaged) {
  const ragGen = runRagFlow({
    model: ctx.model, conv, messages: processedMessages,
    locals: ctx.locals, preprompt,
    abortSignal: ctx.abortController.signal,
    abortController: ctx.abortController,
    promptedAt: ctx.promptedAt,
    ragContext: ctx.ragContext,
    forceTools: ctx.forceTools,
  });
  const ragResult = yield* drainGenerator(ragGen);
  if (ragResult === "completed" || ragResult === "aborted") {
    done.abort(); return;
  }
  // "not_applicable" → fall through to MCP
}

// 2. MCP tool loop (pure MCP, no ragContext)
const mcpGen = runToolFlow({
  model: ctx.model, conv, messages: processedMessages,
  // ... all existing fields ...
  ragFiles: ctx.ragFiles,
  // ragContext intentionally not forwarded
});
const mcpResult = yield* drainGenerator(mcpGen);
if (mcpResult !== "not_applicable") {
  done.abort(); return;
}

// 3. Plain generation fallback
yield* generate({ ...ctx, messages: processedMessages }, preprompt);
done.abort();
```

`drainGenerator` is a small inline helper that yields all updates and returns the final value.

### 4.4 Modified: `src/lib/server/textGeneration/mcp/runMcpFlow.ts`

Remove:
- Import: `RETRIEVE_DOCS_TOOL`, `GET_FILE_CHUNKS_TOOL` from `ragTools.ts`
- The two `if (ragContext?.engaged)` bypass blocks in the zero-servers checks (lines ~171–179 and ~201–210)
- The redundant `if (servers.length === 0 && !ragContext?.engaged)` check (line ~276)
- The `if (ragContext?.engaged) { oaTools.push(...) }` block (lines ~342–352)
- `ragContext` from `RunToolFlowContext` and the function signature
- The `ragFiles` and `ragContext` props from the `executeToolCalls` call (lines ~739–751)

After removal, `RunToolFlowContext` no longer includes `ragContext`. `runMcpFlow.ts` has zero knowledge of RAG.

### 4.5 Modified: `src/lib/server/textGeneration/mcp/toolInvocation.ts`

Remove:
- The `if (RAG_TOOL_NAMES.has(p.call.name) && ragContext)` dispatch block (~lines 359–544)
- The `if (RAG_TOOL_NAMES.has(p.call.name) && !ragContext)` warning (~lines 549–553)
- `mergeChunksById` helper function
- `ragContext` from `ExecuteToolCallsParams`
- Imports: `ChatFileChunk`, `RAGClient`, `buildRagContextMessage`, `evaluate`, `reformulateQuery`, `RAG_TOOL_NAMES`, `handleGetFileChunks`, `handleRetrieveDocs`, `generateFromDefaultEndpoint`

After removal, `toolInvocation.ts` handles only: MCP server tools, client-side tools (`generate_artifact`), and the GitHub operation risk-gate confirmation flow.

### 4.6 Unchanged

- `src/lib/server/rag/ragTools.ts` — handlers, schemas, `RAG_TOOL_NAMES`
- `src/lib/server/rag/ragCritic.ts` — `evaluate`, `reformulateQuery`
- `src/lib/server/rag/contextBuilder.ts` — `buildRagContextMessage`
- `src/lib/server/rag/client.ts` — `RAGClient`, JWT acquisition via `sessionId`
- `src/lib/server/rag/ragGate.ts` — `shouldEngage`
- `src/lib/server/rag/inventoryInjector.ts` — `buildInventoryBlock`
- `src/lib/server/rag/historyHygiene.ts` — `stripPriorRagBlocks`
- `src/routes/conversation/[id]/+server.ts` — `ragContext` construction is correct; no changes needed

---

## 5. Data Flow (end to end)

```
User sends message
  ↓
+server.ts
  RAGClient.listFiles()  →  mergedFiles
  ragGate.shouldEngage() →  engaged: true/false
  if engaged:
    buildInventoryBlock(mergedFiles) → inject into last user message
    set agenticRagEngaged=true, agenticRagInventory, agenticRagClient
  stripPriorRagBlocks(messagesForPrompt)
  build TextGenerationContext with ragContext={ engaged, inventory, ragClient, chunksAccumulator:[], criticRetriesUsed:0 }
  ↓
textGeneration(ctx)
  ↓
index.ts
  if ctx.ragContext.engaged:
    runRagFlow(ctx)
      OpenAI stream + tool loop
      LLM calls retrieve_docs / get_file_chunks
      dispatchRagToolCalls():
        RAGClient.semanticSearch() / RAGClient.getFileChunks()
        ragCritic.evaluate() → retry if needed
        buildRagContextMessage() → <rag_result>
        push to chunksAccumulator
      yield FinalAnswer
      return "completed"
  else:
    runToolFlow(ctx)  ← pure MCP, no RAG
    generate(ctx)     ← plain fallback
  ↓
+server.ts (after stream)
  dedupe chunksAccumulator by chunk.id
  messageToWriteTo.ragChunks = deduped
  messageToWriteTo.ragStrategy = "AGENTIC"
```

---

## 6. Error Handling & Robustness

| Scenario | Behaviour |
|---|---|
| RAG backend unreachable (network error) | `handleRetrieveDocs` returns `{ chunks:[], error: "..." }` → `<rag_result error="true"/>` → LLM explains to user → flow completes normally |
| JWT missing / expired | `RAGClient.getJWT()` throws → caught in handler → error result to LLM → no crash |
| JWT 401 response | `makeRequest()` auto-refreshes once and retries — existing behaviour in `client.ts` |
| All fileIds unknown | `handleRetrieveDocs` returns error before calling backend — no HTTP request made |
| File still embedding | Handler returns `"still being processed"` error — LLM tells user to wait |
| Critic says RETRY, retries exhausted | Returns merged chunks from original + retry result with best verdict achievable |
| Loop exhausted (10 iterations, all tool calls) | Returns `"not_applicable"` → `index.ts` falls through to plain generation |
| Abort signal fired | `checkAborted()` at loop start and mid-stream → returns `"aborted"` → no further yields |
| Model doesn't support tools | Guard returns `"not_applicable"` → MCP tried → fallback to plain gen |

---

## 7. Logging

Every decision point gets a `console.log` (dev) or `logger.info` (structured):

| Event | Log |
|---|---|
| Flow entered | `[RAG] runRagFlow start (files=${inventory.length}, loop cap=10)` |
| Guard: model no tools | `[RAG] model ${model.id} does not support tools — skipping` |
| Loop iteration | `[RAG] loop ${loop} starting` |
| Tool called | `[RAG] LLM called ${toolName} args=${JSON.stringify(args)}` |
| Backend response | `[RAG] ${toolName} returned chunks=${n} error=${err} (${ms}ms)` |
| Critic verdict | `[RAG] critic ${verdict} (maxSim=${x}, entry=${n}, graphOnly=${r})` |
| Critic retry | `[RAG] critic RETRY → reformulated: "${query}"` |
| After retry | `[RAG] after retry chunks=${n} new verdict=${verdict}` |
| Final answer | `[RAG] final answer emitted on loop ${loop} (${chars} chars)` |
| Fallback | `[RAG] loop exhausted → not_applicable` |

---

## 8. Type Surface

### `ragContext` on `TextGenerationContext` (unchanged in `types.ts`)

```typescript
ragContext?: {
  engaged: boolean;
  inventory: RagFileMetadata[];
  ragClient: RAGClient;
  chunksAccumulator: ChatFileChunk[];
  criticRetriesUsed: number;
};
```

### `RunRagFlowContext` (new, in `runRagFlow.ts`)

```typescript
export type RunRagFlowContext = Pick<
  TextGenerationContext,
  "model" | "conv" | "locals" | "forceTools" | "ragContext"
> & {
  messages: EndpointMessage[];
  preprompt?: string;
  abortSignal?: AbortSignal;
  abortController?: AbortController;
  promptedAt?: Date;
};
```

### `ExecuteToolCallsParams` (trimmed in `toolInvocation.ts`)

`ragContext` and `ragFiles` fields removed. Pure MCP params remain.

---

## 9. File Change Summary

| File | Change | Reason |
|---|---|---|
| `src/lib/server/textGeneration/mcp/runRagFlow.ts` | **New** (~250 lines) | RAG-only tool loop |
| `src/lib/server/textGeneration/index.ts` | Modify (~20 lines) | Try RAG first, forward `ragContext` |
| `src/lib/server/textGeneration/mcp/runMcpFlow.ts` | Modify (delete ~40 lines) | Remove RAG coupling |
| `src/lib/server/textGeneration/mcp/toolInvocation.ts` | Modify (delete ~120 lines) | Remove RAG dispatch |
| Everything under `src/lib/server/rag/` | **Unchanged** | Handlers, critic, gate, client all stable |
| `src/routes/conversation/[id]/+server.ts` | **Unchanged** | ragContext construction is already correct |
| `src/lib/server/textGeneration/types.ts` | **Unchanged** | ragContext type already defined |

Net change: +250 lines added, ~160 lines deleted. Net +90 lines, but with a much cleaner boundary.

---

## 10. Out of Scope

- RAG file upload / delete — handled by `RagFileManager.svelte` component, not part of this flow
- `listFiles` — stays in `+server.ts` pre-processing; `runRagFlow` receives inventory via `ragContext`
- `ingest-async` endpoint — backend concern, not called from chat-ui
- Analytics endpoints — backend concern
- Changes to `ragTools.ts`, `ragCritic.ts`, `contextBuilder.ts`, `ragGate.ts`, `inventoryInjector.ts` — all stable; this spec only changes the wiring layer
