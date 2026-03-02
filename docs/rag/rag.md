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

#### Phase 5: File-Aware Rewriting & Context Optimization

**Goal:** Improve retrieval precision by making the query rewriter aware of the entire codebase file structure.

- **Key Changes:**
  - **Frontend Caching:** The RAG file list is fetched once on page load and cached on the frontend to avoid redundant API calls.
  - **Payload Enrichment:** The cached `availableFiles` list is passed to the backend with every message.
  - **File-Aware Rewriting:** Updated `queryRewriter.ts` to include the available file list in the LLM prompt, enabling resolution of references like "explain this file".
  - **Visual Status Indicators:** Enhanced `UploadedFile.svelte` with "RAG Ready" and "Indexing..." badges based on real-time indexing status.
- **Verification:** Reduced query rewriter latency and improved handling of file-specific queries.

---

#### Phase 6: JWT Authentication Implementation (Security Enhancement)

**Goal:** Replace tenant ID headers with secure JWT Bearer token authentication for improved security and proper session management.

**Date:** March 2, 2026

**Key Changes:**
- **JWT Authentication Flow:** Integrated RAG JWT authentication with Google SSO login process
- **Session Storage:** Store RAG JWT tokens server-side in user sessions (never exposed to client)
- **Token Type Fix:** Switched from Google access tokens to Google ID tokens for RAG backend authentication
- **Fallback Mechanism:** Added automatic JWT authentication for existing sessions without requiring logout
- **Proxy Route Updates:** Updated all RAG proxy routes to use JWT Bearer tokens instead of `X-User-ID` headers
- **Error Handling:** RAG authentication failures are logged but don't break the login process

**Architecture Changes:**
- **Frontend:** `browserRagClient` uses `/api/v1/rag` proxy routes exclusively
- **Backend:** Proxy routes call RAG backend directly with JWT `Authorization: Bearer <token>` headers
- **Authentication:** Google ID token → RAG JWT → Secure session storage
- **Security:** JWT tokens stored server-side only, automatic refresh ready

**Files Modified:**
- `src/lib/types/Session.ts` - Added `ragToken`, `ragRefreshToken`, `ragTokenExpiresAt`, `oauth.idToken`
- `src/lib/server/rag/auth.ts` - Created JWT authentication utilities
- `src/lib/rag/browserClient.ts` - Fixed baseUrl configuration
- `src/routes/login/callback/updateUser.ts` - Integrated RAG auth with Google SSO
- `src/routes/api/v1/rag/*/ +server.ts` - Updated all proxy routes for JWT authentication
- `src/lib/server/auth.ts` - Added ID token storage

**Verification:**
- ✅ Google SSO login automatically authenticates with RAG backend
- ✅ Existing sessions get fallback JWT authentication
- ✅ All RAG operations (list, upload, delete, search) work with JWT
- ✅ RAG authentication failures don't break login flow
- ✅ JWT tokens are securely stored server-side only

---

### ⏳ Upcoming Phases

#### Phase 7: Advanced Features (Optional)

**Goal:** Deepen the integration with more specialized codebase analysis tools.

- **Code Graph Visualization:** Visualize relationships between files and classes based on RAG embeddings.
- **Test Discovery:** Automatically identify relevant unit tests for the current context.

#### Phase 7: Performance & Scalability

**Goal:** Optimize for larger codebases and more concurrent users.

- **Streaming Retrieval:** Begin rendering citations _while_ the backend is still fetching subsequent chunks.
- **Per-User Vector Collections:** Isolate tenant data at the database level for better security and performance.

---

## 📄 Supported Text Extensions

The RAG system supports indexing for standard text formats and common developer files:

- **Code:** `.js`, `.ts`, `.py`, `.go`, `.rs`, `.c`, `.cpp`, `.h`, `.java`, `.prisma`, `.graphql`
- **Data/Config:** `.json`, `.xml`, `.csv`, `.yml`, `.yaml`, `.toml`
- **Docs:** `.md`, `.txt`

---

## ✅ RAG Features Verification (March 2, 2026)

### Core RAG Operations
- ✅ **File Listing:** Users can view their uploaded RAG files via RagFileManager
- ✅ **File Upload:** Files can be uploaded through the UI with automatic processing
- ✅ **File Deletion:** Users can delete their RAG files through the interface
- ✅ **Semantic Search:** Context retrieval works for chat conversations
- ✅ **File Chunks:** Individual file chunks can be retrieved and displayed

### Authentication & Security
- ✅ **JWT Authentication:** All RAG requests use secure JWT Bearer tokens
- ✅ **Google SSO Integration:** Automatic RAG authentication during login
- ✅ **Session Security:** JWT tokens stored server-side only
- ✅ **Fallback Authentication:** Existing sessions automatically get JWT tokens
- ✅ **Error Handling:** RAG failures don't break login flow

### User Interface
- ✅ **RagFileManager:** Complete file management interface
- ✅ **RagReferenceCard:** Interactive citation display in chat
- ✅ **MessageRenderer:** Proper routing of RAG-enhanced messages
- ✅ **Status Indicators:** Real-time file processing status
- ✅ **File-Aware Queries:** Query rewriter understands file references

### Backend Integration
- ✅ **SvelteKit Proxies:** All RAG operations go through secure proxy routes
- ✅ **Tenant Isolation:** Users only access their own files
- ✅ **Query Rewriting:** Multi-turn conversation context enhancement
- ✅ **Context Building:** Proper formatting of RAG chunks for LLM
- ✅ **Error Recovery:** Graceful handling of backend failures

### Performance & Reliability
- ✅ **Frontend Caching:** File lists cached to reduce API calls
- ✅ **Automatic Polling:** File processing status updates
- ✅ **Concurrent Safety:** Multiple simultaneous operations supported
- ✅ **Session Persistence:** JWT tokens survive page refreshes

---

## 🔮 Future Roadmap

Beyond the current phases, we plan to implement:

- **Git Context Integration**: Automatically pull context from the current branch or recent commits.
- **Multi-Backend Support**: Toggle between vector providers (e.g., Pinecone, Weaviate, PgVector) via environment variables.
- **Interactive Citations**: Click a citation to jump directly to the relevant file in a built-in code viewer.

---

## 🏗 Key Architectural Decisions

### 1. JWT-Based Authentication (Updated)

**Previous:** Every request to the RAG backend included an `X-User-ID` header for tenant isolation.

**Current:** All RAG requests use JWT Bearer token authentication for enhanced security:
- **Frontend:** Uses `browserRagClient` with `/api/v1/rag` proxy routes
- **Proxy Routes:** Authenticate users, retrieve JWT from session, call RAG backend with `Authorization: Bearer <jwt>`
- **Session Storage:** JWT tokens stored server-side only, never exposed to client
- **Authentication Flow:** Google SSO → Google ID Token → RAG JWT → Session Storage
- **Fallback:** Automatic JWT authentication for existing sessions

### 2. Browser-Secure Requests

The browser uses a `browserRagClient` with relative paths (`/api/v1/rag/...`). This ensures all traffic is handled by SvelteKit proxies, which securely append JWT authentication headers and route to the RAG backend.

### 3. Pure UI Routing (`MessageRenderer`)

By moving rendering logic out of `ChatMessage.svelte`, we preserved the complex streaming/scroll logic in one place while allowing the rendering layer to scale as more message types (e.g., MCP tools) are added.

### 4. SvelteKit Proxy Architecture

All RAG operations go through SvelteKit proxy routes for security:
- **Authentication:** Block anonymous access, require authenticated user
- **Token Management:** Retrieve JWT from session, handle fallback authentication
- **Error Handling:** Graceful handling of RAG backend failures
- **Security:** Never expose RAG backend URLs or tokens to client

---

## 📂 File Reference

| File Path                                         | Description                           | Phase |
| ------------------------------------------------- | ------------------------------------- | ----- |
| `src/lib/rag/client.ts`                           | Centralized API client                 | 3     |
| `src/lib/rag/browserClient.ts`                    | Browser-safe proxy client              | 3     |
| `src/lib/rag/context.ts`                          | Shared RAG types                      | 4     |
| `src/lib/server/rag/contextBuilder.ts`            | Prompt formatter                      | 1, 4  |
| `src/lib/server/rag/queryRewriter.ts`             | Query transformation logic            | 2     |
| `src/lib/server/rag/auth.ts`                      | JWT authentication utilities           | 6     |
| `src/lib/components/chat/MessageRenderer.svelte`  | UI Routing layer                      | 4     |
| `src/lib/components/chat/RagReferenceCard.svelte` | Citation UI Card                      | 4     |
| `src/routes/api/v1/rag/files/+server.ts`          | File listing proxy (JWT auth)         | 3, 6  |
| `src/routes/api/v1/rag/file/upload/+server.ts`    | File upload proxy (JWT auth)           | 3, 6  |
| `src/routes/api/v1/rag/file/[id]/+server.ts`      | File deletion proxy (JWT auth)        | 3, 6  |
| `src/routes/api/v1/rag/chunk/semanticSearchForChat/+server.ts` | Semantic search proxy (JWT auth) | 3, 6  |
| `src/routes/api/v1/rag/file/[id]/chunks/+server.ts` | File chunks proxy (JWT auth)          | 3, 6  |
| `src/routes/conversation/[id]/+server.ts`         | Core Chat-RAG integration              | 1     |
| `src/routes/login/callback/updateUser.ts`        | Google SSO + RAG JWT integration       | 6     |
| `src/lib/types/Session.ts`                        | Session interface with JWT fields     | 6     |
