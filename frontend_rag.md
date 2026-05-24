# Frontend RAG Agentic Architecture

**Version:** 3.0 — Agentic Orchestrator (LLM + Regex Fallback)  
**Last Updated:** 2026-03-03

---

## Overview

The frontend RAG system utilizes an **Agentic Orchestrator** pattern. Instead of simple rule-based routing, a dedicated `RagAgent` uses an LLM-based `RagPlanner` to decide the best retrieval strategy.

**Key Design Principles:**

1. **Low Latency**: LLM planning is capped at 2 seconds.
2. **Reliability**: If the LLM planner fails or times out, it instantly falls back to a deterministic regex-based planner.
3. **Purity**: The `RagAgent` is dependency-injected and doesn't handle auth directly; it receives everything needed for a request at execution time.

---

## Architecture Flow

```
User Message (POST /conversation/[id])
  │
  ├─ 1. Initialize RagAgent (Injected with generateFn)
  │
  ├─ 2. ragAgent.run(userQuery, files, history, messageId, locals)
  │     │
  │     ├─ A. Plan Strategy (ragAgent.plan)
  │     │     ├─ Tries RagPlanner (LLM-based)
  │     │     │    - System Prompt with all files + history
  │     │     │    - 2s Timeout guard
  │     │     └─ Fallback: ragAgentLegacy (Regex-based)
  │     │
  │     ├─ B. Execute Plan (ragAgent.execute)
  │     │     - Parallel fetch via ragClient
  │     │     - File-specific actions (DEEP_DIVE, SEMANTIC, SKIP)
  │     │
  │     └─ C. Merge & Return Chunks
  │
  └─ 3. Inject context into message for LLM generation
```

---

## planning Strategies (`RagStrategy`)

The planner selects one of these core strategies:

| Strategy          | Description                           | Best For...                                |
| ----------------- | ------------------------------------- | ------------------------------------------ |
| `NO_RAG`          | No retrieval. Injects file list only. | Metadata queries ("what files do I have?") |
| `SEMANTIC_SEARCH` | Global cross-file search.             | General technical questions.               |
| `FILE_SEMANTIC`   | Search within 1-2 specific files.     | Questions about a specific module.         |
| `FILE_DEEP_DIVE`  | Full read of 1-3 files.               | Summarization of specific files.           |
| `FULL_CONTEXT`    | Deep dive into ALL available files.   | Global overviews, project structure.       |
| `HYBRID`          | Per-file mix of Deep Dive/Semantic.   | Complex relational questions ("X vs Y").   |

---

## Robust Fallback Logic

To ensure the chat never hangs, the system uses a **Tiered Planning** approach:

### Tier 1: LLM Planning (`ragPlanner.ts`)

- **System Prompt:** Instructs the model to return structured JSON.
- **Constraints:** Max 300 tokens, 0 temperature.
- **Zod Validation:** Discards hallucinated or malformed JSON.
- **Hard Limits:** Trims plan to max 3 DEEP_DIVE files and 5 total files.

### Tier 2: Regex Fallback (`ragAgentLegacy.ts`)

- **Deterministic:** Pure regex-based inference.
- **Instant:** Zero network latency.
- **Priority:**
  1. Explicit file + summarize verb -> `FILE_DEEP_DIVE`
  2. Global summarize -> `FULL_CONTEXT`
  3. Metadata patterns -> `NO_RAG`
  4. Code structure keywords -> `HYBRID`
  5. Default -> `SEMANTIC_SEARCH`

---

## Context Optimization

- **Zero-Latency History**: `historyCompressor.ts` strips noise (like `<think>` blocks) and truncates history into a compact string for the planner, avoiding extra LLM costs.
- **Strategy-Aware Budget**: `contextBuilder.ts` scales the retrieval window:
  - Simple queries: **4,000 characters** (faster inference)
  - HYBRID / FULL_CONTEXT: **8,000 characters** (deeper insight)

---

## Key Files & Roles

| File path                                 | Purpose                                                             |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `src/lib/server/rag/ragAgent.ts`          | The main orchestrator. Coordinates planning and parallel execution. |
| `src/lib/server/rag/ragPlanner.ts`        | The LLM-based strategist. Uses Zod for plan validation.             |
| `src/lib/server/rag/ragAgentLegacy.ts`    | The deterministic fallback planner using regex rules.               |
| `src/lib/server/rag/historyCompressor.ts` | Compresses conversation history for efficient planning.             |
| `src/lib/server/rag/contextBuilder.ts`    | Formats chunks and manages the character-based context budget.      |
| `src/lib/rag/client.ts`                   | Core RAG client using JWT Authentication.                           |
