# RAG Integration Documentation

This document provides a comprehensive overview of the Retrieval-Augmented Generation (RAG) implementation in Chat-UI.

## Overview

The RAG system enables the chat interface to retrieve and reference content from user-uploaded files during conversation. It connects a backend FastAPI RAG engine to the SvelteKit frontend via an agentic tool-calling loop.

**Current architecture (v4.0):** A dedicated `runRagFlow.ts` owns all RAG tool calls, completely decoupled from MCP infrastructure. The LLM autonomously decides when and how to retrieve — choosing between semantic search, sequential file read, or file listing based on tool descriptions.

---

## Implementation Phases

### ✅ Phase 1: Basic RAG Injection (MVP)

**Goal:** Establish connectivity and inject retrieved context into LLM prompts.

- Created `src/lib/server/rag/client.ts` — core API client for the RAG backend
- Created `src/lib/server/rag/contextBuilder.ts` — formats retrieved chunks into `<coderef>` XML
- Modified `src/routes/conversation/[id]/+server.ts` to perform semantic search during chat flow

### ✅ Phase 2: Query Rewriting

**Goal:** Improve retrieval for multi-turn conversations where queries reference prior context.

- Created `src/lib/server/rag/queryRewriter.ts` — LLM-based query transformation for follow-up questions

### ✅ Phase 3: File Upload & Management

**Goal:** User-facing file management with secure auth.

- Centralized RAG client to `src/lib/rag/client.ts` for browser compatibility
- SvelteKit proxy routes to handle CORS and secure JWT injection
- `RagFileManager.svelte` with real-time polling for processing status

### ✅ Phase 4: RAG Chunk UI

**Goal:** Make retrieved context visible as interactive citations.

- `MessageRenderer.svelte` — UI routing layer separating streaming from rendering
- `RagReferenceCard.svelte` — interactive citation cards above AI responses
- `src/lib/rag/context.ts` — shared types across client and server

### ✅ Phase 5: File-Aware Query Rewriting

**Goal:** Query rewriter understands the full file inventory.

- File list cached on frontend, passed with every message
- `queryRewriter.ts` updated to resolve references like "explain this file"

### ✅ Phase 6: JWT Authentication

**Goal:** Secure per-user authentication for all RAG operations.

**Date:** March 2, 2026

- Google SSO → Google ID Token → RAG JWT → server-side session storage
- All proxy routes use `Authorization: Bearer <jwt>` headers
- JWT tokens never exposed to client

**Files:** `src/lib/types/Session.ts`, `src/lib/server/rag/auth.ts`, `src/routes/login/callback/updateUser.ts`, `src/routes/api/v1/rag/*`

### ✅ Phase 7: Agentic RAG — Decoupled `runRagFlow`

**Goal:** Replace fragile RAG-in-MCP wiring with a clean, independent tool-calling loop.

**Date:** May 24, 2026

**Root bug fixed:** `ragContext` was not forwarded to `runToolFlow()`, so RAG tools were never advertised to the LLM — causing identical responses on every turn ("stuck at same").

**Key changes:**

- **Created `src/lib/server/textGeneration/mcp/runRagFlow.ts`** — self-contained OpenAI tool-calling loop (max 10 iterations) that advertises only `list_files`, `retrieve_docs`, and `get_file_chunks`. No MCP server discovery, no URL safety checks, no HF token forwarding.
- **Updated `src/lib/server/textGeneration/index.ts`** — orchestration: try RAG first (when `ragContext.engaged`) → try MCP → plain generation fallback.
- **Stripped RAG from `runMcpFlow.ts`** — removed all `ragContext` references, RAG tool advertisement, and bypass paths from zero-server checks.
- **Stripped RAG from `toolInvocation.ts`** — removed RAG dispatch block (~185 lines), 6 RAG-specific imports, `ragContext` from the interface.
- **Added `list_files` tool** — instant inventory read (no backend call) for ambiguous queries.
- **Critic loop** on `retrieve_docs`: `ragCritic.evaluate()` → PASS/RETRY/EMPTY → `reformulateQuery()` with 1500ms timeout → merge by highest similarity per chunk id.
- **Fixed 100% similarity display** — sequential read chunks (`get_file_chunks`) now have `similarity: null` so the UI hides the relevance bar.
- **Fixed multi-turn re-retrieval** — system prompt explicitly instructs the LLM not to re-fetch files whose content is already in conversation history.
- **Fixed tool routing** — `get_file_chunks` is now the required tool for exhaustive tasks ("list all functions", "what does this file contain"); `retrieve_docs` is explicitly marked as NOT for exhaustive tasks.

---

## Current Architecture

### Text Generation Flow

```
POST /conversation/[id]
  │
  ├─ 1. Gate: ragGate.shouldEngage(userQuery, files)
  │     SKIPPED → textGeneration skips runRagFlow
  │     ENGAGED → ragContext built with inventory + ragClient
  │
  └─ 2. textGeneration(ctx)
        │
        ├─ A. runRagFlow()  ← when ragContext.engaged
        │     ├─ Advertise: [list_files, retrieve_docs, get_file_chunks]
        │     ├─ Tool loop (≤10 iterations)
        │     │     LLM calls tool → dispatch → append → loop
        │     │     No tool call → FinalAnswer → "completed"
        │     └─ "not_applicable" if model has no tool support
        │
        ├─ B. runToolFlow() ← pure MCP (no RAG tools)
        │
        └─ C. generate()   ← plain generation fallback
```

### RAG Tools

| Tool              | Use case                                            | Backend                                        |
| ----------------- | --------------------------------------------------- | ---------------------------------------------- |
| `list_files`      | Discover available files for ambiguous queries      | None (in-memory inventory)                     |
| `retrieve_docs`   | Semantic search, targeted questions                 | `POST /api/v1/rag/chunk/semanticSearchForChat` |
| `get_file_chunks` | Summaries, exhaustive analysis, listing all symbols | `GET /api/v1/rag/file/{fileId}/chunks`         |

### Critic Loop (retrieve_docs)

```
retrieve_docs result
  │
  └─ ragCritic.evaluate(chunks)
        PASS  → use chunks
        EMPTY → return empty result
        RETRY → reformulateQuery() [1500ms timeout]
                  → retry retrieve_docs
                  → mergeChunksById (highest similarity wins)
                  → criticRetriesUsed++ (cap: 2/turn)
```

---

## Supported File Types

- **Code:** `.js`, `.ts`, `.py`, `.go`, `.rs`, `.c`, `.cpp`, `.h`, `.java`, `.prisma`, `.graphql`
- **Data/Config:** `.json`, `.xml`, `.csv`, `.yml`, `.yaml`, `.toml`
- **Docs:** `.md`, `.txt`

---

## File Reference

| File                                                           | Description                                       | Phase   |
| -------------------------------------------------------------- | ------------------------------------------------- | ------- |
| `src/lib/server/textGeneration/mcp/runRagFlow.ts`              | **RAG tool-calling loop** — owns all RAG dispatch | 7       |
| `src/lib/server/textGeneration/index.ts`                       | Orchestration: RAG → MCP → plain gen              | 7       |
| `src/lib/server/textGeneration/mcp/runMcpFlow.ts`              | Pure MCP flow (no RAG)                            | 7       |
| `src/lib/server/textGeneration/mcp/toolInvocation.ts`          | MCP tool execution (no RAG)                       | 7       |
| `src/lib/server/rag/ragTools.ts`                               | Tool definitions + handlers                       | 7       |
| `src/lib/server/rag/ragCritic.ts`                              | Quality evaluation + query reformulation          | 7       |
| `src/lib/server/rag/ragGate.ts`                                | `shouldEngage()` — turn-level RAG gate            | 7       |
| `src/lib/server/rag/ragRouter.ts`                              | File-name matching for the gate                   | 7       |
| `src/lib/server/rag/contextBuilder.ts`                         | Formats chunks into `<coderef>` XML               | 1, 4, 7 |
| `src/lib/server/rag/inventoryInjector.ts`                      | Injects file inventory into system prompt         | 7       |
| `src/lib/server/rag/historyHygiene.ts`                         | Strips noise from conversation history            | 7       |
| `src/lib/server/rag/client.ts`                                 | Server-side `RAGClient` with JWT auth             | 3, 6    |
| `src/lib/rag/client.ts`                                        | Shared types + browser-safe proxy client          | 3       |
| `src/lib/server/textGeneration/utils/toolPrompt.ts`            | System prompt with tool routing rules             | 7       |
| `src/lib/server/rag/auth.ts`                                   | JWT authentication utilities                      | 6       |
| `src/lib/components/chat/RagReferenceCard.svelte`              | Citation UI card                                  | 4       |
| `src/lib/components/chat/MessageRenderer.svelte`               | UI routing layer                                  | 4       |
| `src/lib/components/chat/RagFileManager.svelte`                | File management UI                                | 3       |
| `src/routes/api/v1/rag/files/+server.ts`                       | File listing proxy (JWT auth)                     | 3, 6    |
| `src/routes/api/v1/rag/file/upload/+server.ts`                 | File upload proxy (JWT auth)                      | 3, 6    |
| `src/routes/api/v1/rag/file/[id]/+server.ts`                   | File deletion proxy (JWT auth)                    | 3, 6    |
| `src/routes/api/v1/rag/chunk/semanticSearchForChat/+server.ts` | Semantic search proxy (JWT auth)                  | 3, 6    |
| `src/routes/api/v1/rag/file/[id]/chunks/+server.ts`            | File chunks proxy (JWT auth)                      | 3, 6    |
| `src/routes/conversation/[id]/+server.ts`                      | Core chat-RAG integration                         | 1, 7    |
| `src/routes/login/callback/updateUser.ts`                      | Google SSO + RAG JWT integration                  | 6       |
| `src/lib/types/Session.ts`                                     | Session interface with JWT fields                 | 6       |
