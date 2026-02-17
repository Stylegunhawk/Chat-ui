# Phase 1 (MVP): DevForge RAG injection

## Preconditions (verify before edits)

- Confirm [`/Users/siddesh.kale/Documents/chatui/chat-ui/src/routes/conversation/[id]/+server.ts`](/Users/siddesh.kale/Documents/chatui/chat-ui/src/routes/conversation/[id]/+server.ts) exists and calls `buildSubtree()` in `POST` (it does; we saw `messagesForPrompt = buildSubtree(conv, newUserMessageId);`).
- Confirm an identifier for `X-User-ID` is available in the `POST` handler.
- Current `App.Locals` is defined in [`/Users/siddesh.kale/Documents/chatui/chat-ui/src/app.d.ts`](/Users/siddesh.kale/Documents/chatui/chat-ui/src/app.d.ts) and provides `locals.sessionId` and optional `locals.user`.
- You selected **use `locals.sessionId`** as the tenant id.

## Step 1.1 — Create RAG client module (STOP after this step)

- Create folder: [`/Users/siddesh.kale/Documents/chatui/chat-ui/src/lib/server/rag/`](/Users/siddesh.kale/Documents/chatui/chat-ui/src/lib/server/rag/)
- Add file: [`/Users/siddesh.kale/Documents/chatui/chat-ui/src/lib/server/rag/client.ts`](/Users/siddesh.kale/Documents/chatui/chat-ui/src/lib/server/rag/client.ts)
- Implement **exactly** the provided `RAGClient` + types.
- Use `process.env.RAG_BASE_URL || 'http://localhost:8000'`.
- Ensure `semanticSearch()` and `uploadFiles()` and `deleteFile()` include `X-User-ID` header.

## Verification for Step 1.1

- Confirm the file exists with the exact exported symbols: `ChatFileChunk`, `SemanticSearchRequest`, `SemanticSearchResponse`, `FileUploadResponse`, `RAGClient`, `ragClient`.
- Run TypeScript diagnostics for the new file only (no repo-wide changes).

## Pause for approval

- Show the full contents of the created `client.ts`.
- Ask: **“Phase 1, Step 1.1 complete. Proceed to Step 1.2?”**

## Next steps (not executed until you approve)

- Step 1.2: add `contextBuilder.ts`.
- Step 1.3: inject RAG immediately after the `buildSubtree()` call in `POST`.
- Step 1.4: add `RAG_BASE_URL=http://localhost:8000` to `.env.local`.
- Phase 1 verification checklist run.
