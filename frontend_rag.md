# Frontend RAG Architecture
**Version:** 2.1 — Hardened Deterministic Router  
**Last Updated:** 2026-03-01

---

## Overview

The frontend RAG system intercepts every user message on the server side, classifies the query intent **deterministically** via regex rules, and injects relevant document context into the LLM prompt before generation.

Entry point: `src/routes/conversation/[id]/+server.ts`  
Router: `src/lib/server/rag/ragRouter.ts`  
Query rewriter: `src/lib/server/rag/queryRewriter.ts`  
RAG API client: `src/lib/rag/client.ts`

---

## Architecture Flow

```
User Message (POST /conversation/[id])
  │
  ├─ RAG enabled? (conv.ragEnabled !== false)
  │     └─ NO → skip RAG entirely, pass message to LLM unchanged
  │
  ├─ Sync backend files
  │     └─ ragClient.listFiles(tenantId)   → GET /api/v1/rag/files
  │         Merges with frontend availableFiles prop (adds chunkCount)
  │
  ├─ routeRagQuery(userQuery, { availableFiles, conversationHistory })
  │     └─ Returns RagRouteDecision (see Routing Rules below)
  │
  ├─ Execute by intent:
  │     NO_RAG          → no backend call
  │     FULL_SUMMARY    → ragClient.getFileChunks(fileId, limit, offset)
  │     KEYWORD_LOOKUP  → ragClient.semanticSearch({ fileIds, top_k=15/20 })
  │     TARGETED_SEARCH → ragClient.semanticSearch({ fileIds, top_k=10 })
  │     GLOBAL_SEARCH   → ragClient.semanticSearch({ top_k=5 })
  │
  └─ Inject chunks into last user message content → LLM
```

---

## Routing Rules (`ragRouter.ts`)

Rules are evaluated **top-to-bottom, first match wins**. No LLM is consulted for routing decisions.

---

### Rule 0 — NO_RAG (Metadata Guard)

Runs **first**, before any file-matching or semantic logic.

```
METADATA_QUERY_PATTERNS (12 regexes)
```

**Catches:**

| Pattern Group | Examples |
|---|---|
| list/show/display files | "list my files", "show me the files" |
| what are my files | "what are my uploaded files?" ✓ |
| what files do I have | "what documents do I have?" |
| what did I upload | "what have I added?" |
| can you see my files | "can you access my documents?" |
| do I have any files | "do I have any uploaded files?" |
| my files (bare possessive) | "my files" — with negative lookahead |
| how many files | "how many documents did I upload?" |
| which files | "which files can you see?" |
| what can you access | "what do you have access to?" |
| RAG status × 2 | "is RAG enabled?", "RAG is off" |

**Critical: "my files" negative lookahead**

Bare possessive `"my files"` is blocked as `NO_RAG` **unless** followed by a semantic verb that means "search within":

```
# BLOCKED as NO_RAG:
"my files"
"my uploaded files"
"my documents"

# ALLOWED → falls through to GLOBAL_SEARCH:
"search my files for config"
"find in my files"
"look through my files"
"my files mention auth flow"
"my files have the answer"
```

The negative lookahead excludes: `say|show|contain|mention|talk|discuss|include|have|for|about|search|find|look|scan|with|that|which|where`

---

### Rule 1 — FULL_SUMMARY

```ts
if (findFileMatch(userQuery, availableFiles) && isSummarizeVerb(userQuery))
```

**Requires:** explicit filename in query **AND** one of these verbs (all file-scoped — no broad "explain"):
```
summarize, summary, overview, give me an overview, give me a summary,
explain this file, describe this file, review this file, show me this file,
walk me through this, tell me about this file, what does this file,
what is this file, what's in this file, read this file, analyze this file,
take me through
```

**API Call:** `GET /api/v1/rag/file/{file_id}/chunks?limit=N&offset=M`
```ts
limit  = Math.min(file.chunkCount ?? 10, 20)  // capped at 20 chunks
offset = file.name.endsWith(".pdf") ? 3 : 0   // skip PDF title pages
```

---

### Rule 2 — KEYWORD_LOOKUP

```ts
const activeFile = explicitFile ?? inferActiveFile(history, files);
if (activeFile && isKeywordLookup(userQuery))
```

**Keyword patterns** (digit cap enforced):
```
Q55, Q.55       → /\bq\.?\s*\d{1,3}\b/i   ← max 3 digits
question 55     → /\bquestion\s+\d+\b/i
section 3.2     → /\bsection\s+[\d.]+\b/i
page 4          → /\bpage\s+\d+\b/i
line 42         → /\bline\s+\d+\b/i
part B          → /\bpart\s+[a-z\d]+\b/i
item 12         → /\bitem\s+\d+\b/i
row 7           → /\brow\s+\d+\b/i
No. 5           → /\bno\.?\s*\d+\b/i
what did I answer/select/choose/pick/mark
my answer/choice/selection/option for/to/on
what/which option/choice did I
```

**API Call:** `POST /api/v1/rag/chunk/semanticSearchForChat`
```json
{ "fileIds": ["<activeFile.id>"], "top_k": 20 }  // PDF = 20, other = 15
```

---

### Rule 3 — TARGETED_SEARCH

```ts
if (activeFile)
```

General question while a file is contextually active. Query is rewritten by `rewriteForSearch()` only if:
- Conversation history exists (pronoun context needed)
- Query is ≤ 10 words (longer queries are already self-contained)

```json
{ "fileIds": ["<activeFile.id>"], "userQuery": "<rewritten>", "top_k": 10 }
```

---

### Rule 4 — GLOBAL_SEARCH

No active file context. Cross-file semantic search.

```json
{ "userQuery": "<rewritten>", "top_k": 5 }
```

No `fileIds` → backend enforces tenant isolation via `X-User-ID` header.

---

## Active File Inference (`inferActiveFile`)

```ts
// Single file uploaded → always active
if (files.length === 1) return files[0];

// Multiple files → scan last 6 messages for a filename mention
```

**File matching levels (priority order):**
1. Exact filename (`gate2026 my response.pdf`)
2. Base name without extension (`gate2026 my response`)
3. Keyword tokens > 3 chars from the name (`gate`, `response`)

---

## Rewrite Short-Circuits

`rewriteForSearch()` **skips the LLM call** and returns the query unchanged when:
- Query < 5 or > 500 characters
- No conversation history (nothing to resolve pronouns against)
- Query is > 10 words (already self-contained — LLM would return it unchanged anyway)

This keeps TARGETED_SEARCH and GLOBAL_SEARCH low-latency for already-clear queries.

---

## DO NOT

- Add new endpoints to the backend
- Increase `top_k` beyond the values above
- Introduce LLM-based routing decisions
- Reintroduce broad un-scoped summarize verbs (`"explain"`, `"describe"`, `"review"` — must be `"explain this file"` etc.)

---

## Backend Endpoints Used

| Intent | Endpoint | Method |
|--------|----------|--------|
| FULL_SUMMARY | `/api/v1/rag/file/{file_id}/chunks` | GET |
| KEYWORD_LOOKUP | `/api/v1/rag/chunk/semanticSearchForChat` | POST |
| TARGETED_SEARCH | `/api/v1/rag/chunk/semanticSearchForChat` | POST |
| GLOBAL_SEARCH | `/api/v1/rag/chunk/semanticSearchForChat` | POST |
| File Sync | `/api/v1/rag/files` | GET |

---

## Debug Console Logging

Every RAG trigger logs intent, query, scoped file, and retrieved docs:

```
[RAGRouter] → KEYWORD_LOOKUP | file="gate2026 my response.pdf" isPdf=true top_k=20

[RAG TRIGGERED] ====================
- Intent         : KEYWORD_LOOKUP
- Original Query : "what did I answer for Q55"
- Scoped File    : gate2026 my response.pdf
- Chunks Limit   : 20
- Docs Retrieved : gate2026 my response.pdf
====================================
```

---

## Key Files

| File | Role |
|------|------|
| `src/lib/server/rag/ragRouter.ts` | Deterministic intent router (Rules 0–4) |
| `src/lib/server/rag/queryRewriter.ts` | Pure semantic query rewriter (LLM, with short-circuits) |
| `src/lib/server/rag/contextBuilder.ts` | Formats retrieved chunks into LLM context |
| `src/lib/rag/client.ts` | RAG API client |
| `src/routes/conversation/[id]/+server.ts` | Entry point — router → API → injection |
