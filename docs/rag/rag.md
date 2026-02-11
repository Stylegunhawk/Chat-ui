# RAG Integration Documentation

This document provides a comprehensive overview of the Retrieval-Augmented Generation (RAG) implementation in Chat-UI.

## 🚀 Overview
The RAG system enables the chat interface to contextually retrieve and reference code snippets from a user's codebase (or uploaded files). It integrates a backend FastAPI RAG engine with the SvelteKit-based Chat-UI frontend.

---

## 📅 Implementation Roadmap

### ✅ Completed Phases

#### Phase 1: Basic RAG Injection (MVP)
**Goal:** Establish connectivity and basic context injection.
- **Key Changes:**
  - Created `src/lib/server/rag/client.ts`: The core API client for the RAG backend.
  - Created `src/lib/server/rag/contextBuilder.ts`: Formats retrieved chunks into LLM-readable system messages.
  - Integration: Modified `src/routes/conversation/[id]/+server.ts` to perform semantic searches during the chat flow.
- **Verification:** Successfully injected code snippets into LLM prompts using XML-like `<coderef>` tags.

#### Phase 2: Query Rewriting (Enhanced)
**Goal:** Improve retrieval by rewriting user queries based on conversation history.
- **Key Changes:**
  - Created `src/lib/server/rag/queryRewriter.ts`: Uses the LLM to convert vague follow-up questions (e.g., "how does it work?") into standalone searchable queries.
- **Verification:** Improved accuracy for multi-turn conversations where context is required to stay relevant.

#### Phase 3: File Upload & Management
**Goal:** Enable users to manage their RAG context directly from the UI.
- **Key Changes:**
  - **Single Point of Truth:** Refactored RAG Client to a shared location (`src/lib/rag/client.ts`) for browser compatibility.
  - **SvelteKit Proxy:** Implemented server-side proxies to handle CORS and secure `X-User-ID` injection.
  - **Dynamic UI:** Refactored `RagFileManager.svelte` to use the proxy and implemented automatic polling for file processing status.
- **Architecture Note:** Solved CORS restrictions by routing browser requests through SvelteKit before reaching the RAG backend.

#### Phase 4: RAG Chunk UI (Visual Enhancements)
**Goal:** Make the "hidden" RAG context visible and interactive for users.
- **Key Changes:**
  - **Metadata Enrichment:** Updated `contextBuilder.ts` to attach full chunk objects to message metadata.
  - **Decoupled Rendering:** Created `MessageRenderer.svelte` and `RagReferenceCard.svelte` to separate UI routing from streaming.
  - **Type Safety:** Created `src/lib/rag/context.ts` to share types across client and server.
- **Verification:** RAG contexts are now displayed as interactive cards above the AI response.

---

### ⏳ Upcoming Phases

#### Phase 5: Advanced Features (Optional)
**Goal:** Deepen the integration with more specialized codebase analysis tools.
- **Code Graph Visualization:** Visualize relationships between files and classes based on RAG embeddings.
- **Test Discovery:** Automatically identify relevant unit tests for the current context.

#### Phase 6: Performance & Scalability
**Goal:** Optimize for larger codebases and more concurrent users.
- **Streaming Retrieval:** Begin rendering citations *while* the backend is still fetching subsequent chunks.
- **Per-User Vector Collections:** Isolate tenant data at the database level for better security and performance.

---

## 🔮 Future Roadmap
Beyond the current phases, we plan to implement:
- **Git Context Integration**: Automatically pull context from the current branch or recent commits.
- **Multi-Backend Support**: Toggle between vector providers (e.g., Pinecone, Weaviate, PgVector) via environment variables.
- **Interactive Citations**: Click a citation to jump directly to the relevant file in a built-in code viewer.

---

## 🏗 Key Architectural Decisions

### 1. Tenant Isolation
Every request to the RAG backend includes an `X-User-ID` header. This is injected by SvelteKit server-side logic using the user's session ID or Mongo ID, ensuring users only see and search their own files.

### 2. Browser-Secure Requests
The browser uses a `browserRagClient` with relative paths (`/api/v1/rag/...`). This ensures all traffic is handled by SvelteKit proxies, which securely append environment-protected Base URLs and Headers.

### 3. Pure UI Routing (`MessageRenderer`)
By moving rendering logic out of `ChatMessage.svelte`, we preserved the complex streaming/scroll logic in one place while allowing the rendering layer to scale as more message types (e.g., MCP tools) are added.

---

## 📂 File Reference

| File Path | Description | Phase |
|-----------|-------------|-------|
| `src/lib/rag/client.ts` | Centralized API client | 3 |
| `src/lib/rag/browserClient.ts` | Browser-safe proxy client | 3 |
| `src/lib/rag/context.ts` | Shared RAG types | 4 |
| `src/lib/server/rag/contextBuilder.ts` | Prompt formatter | 1, 4 |
| `src/lib/server/rag/queryRewriter.ts` | Query transformation logic | 2 |
| `src/lib/components/chat/MessageRenderer.svelte` | UI Routing layer | 4 |
| `src/lib/components/chat/RagReferenceCard.svelte` | Citation UI Card | 4 |
| `src/routes/api/v1/rag/...` | SvelteKit Proxy API | 3 |
| `src/routes/conversation/[id]/+server.ts` | Core Chat-RAG integration | 1 |
