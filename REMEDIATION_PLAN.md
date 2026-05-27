# Remediation Plan: chat-ui Agentic RAG
*Generated: 2026-05-27 | Source: `.audit/AUDIT_REPORT.md` | Revised: 1 time (critique-incorporated)*

## Executive Summary

The agentic RAG subsystem ships two production-breaking defects and a set of correctness bugs. **(1)** Both the RAG and MCP completion flows forward the end-user's OAuth/OIDC access token (`Authorization: Bearer ${locals.token}`) to whatever `OPENAI_BASE_URL` the operator configured, with no trust gate — a credential-leak vector active on every deployment. **(2)** The agentic system prompt is an unfinished artifact: it hardcodes a developer's local file reference, triplicates conflicting rules, and advertises a tool the RAG flow never registers (training the model to hallucinate it). The remaining ten bugs produce double answers, silently-disabled RAG on retry, mis-reported tool errors, resource leaks, and broken graph artifacts. This plan fixes the credential leak first as a hotfix, rewrites the prompt into per-flow builders with regression tests, and closes the correctness and observability gaps in dependency order. Total effort ~70 h; P0+P1 critical path 50 h.

## Issue Inventory

| # | Issue | Type | Severity | Verified | Effort |
|---|-------|------|----------|----------|--------|
| 1 | User OAuth token forwarded to `OPENAI_BASE_URL` in **both** flows, no gate | BUG (security) | P0 | ✓ | 5 h |
| 2 | System prompt: hardcoded `agent.py`, triplicated rules, unregistered tool, dead `ragEnabled` flag, missing grounding/citation/anti-loop sections | BUG + QUALITY | P0 | ✓ | 16 h |
| 3 | `buildToolPreprompt(ragEnabled)` flag dropped at both call sites | BUG | P1 | ✓ | 1 h |
| 4 | Tool-result status hardcoded `Success` even on errors (must build `ToolResultError` variant) | BUG | P1 | ✓ | 3 h |
| 5 | Loop-exhaustion → `not_applicable` → fall-through to plain gen → double answers | BUG | P1 | ✓ | 3 h |
| 6 | Retry path silently disables RAG engagement | BUG | P1 | ✓ | 4 h |
| 7 | Silent drop of hallucinated tool names → loop burn | BUG | P1 | ✓ | 3 h |
| 8 | Shared `criticRetriesUsed` counter across calls/iterations | BUG | P1 | ✓ | 2 h |
| 9 | `reformulateQuery` `Promise.race` leaks stream + timer (needs `abortSignal` plumbing) | BUG | P1 | ✓ | 5 h |
| 10 | Duplicate inventory injection (prepended + `list_files`) | BUG | P1 | ✓ | 3 h |
| 11 | `graphToMermaid` does not escape label special chars → invalid Mermaid | BUG | P1 | ✓ | 3 h |
| 12 | `get_code_graph_related` accepts arbitrary `entity`; tool description leaks `tenant::file::name` | BUG + QUALITY | P1 | ✓ | 2 h |
| 13 | No structured telemetry (`conv`/`tenant`/`tool`/`loop`/`verdict`) | MISSING | P2 | ✓ | 6 h |
| 14 | Anti-loop guardrail is prompt-only; no server-side dedupe | ARCH | P2 | ✓ | 4 h |
| 15 | Prompt-snapshot tests | QUALITY | P2 | ✓ | 0 h* |
| 16 | Tool-call audit log to MongoDB for retrieval-precision analysis | MISSING | P3 | ✓ | 6 h |
| 17 | Stray `console.*` in `+server.ts` → structured logger | QUALITY | P3 | ✓ | 1 h |
| 18 | `RAGClient.getJWT` swallows refresh failures; typed errors + recursive-401 guard | BUG | P2 | ✓ | 3 h |

*\*Item 15's 4 h is built inside issue 2's 16 h (same PR) — not double-counted.*

## Priority Definitions
- **P0** — Fix immediately. System broken or data/credentials at risk.
- **P1** — Fix this sprint. Significant reliability, correctness, or security impact.
- **P2** — Fix next sprint. Technical debt or missing enterprise capability.
- **P3** — Backlog.

---

## Remediation Plan

### P0 — Critical (ship now)

#### 1. Token leak to `OPENAI_BASE_URL` (both flows)
**Problem.** Every completion request in **both** the RAG flow (`runRagFlow.ts:526-535`) and the MCP flow (`runMcpFlow.ts:503-513` streaming, `:657-667` non-stream id-recovery) attaches the user's raw OAuth/OIDC access token (`locals.token`, from `hooks.server.ts:206` → `auth.ts:451`) as `Authorization: Bearer …` to whatever URL the operator set in `OPENAI_BASE_URL`. A compromised gateway can replay the token against the issuer for the token's lifetime.

**Root cause.** The outbound completion call was copied across flows without re-evaluating the trust boundary on `OPENAI_BASE_URL`. The `isValidUrl`/`MCP_FORWARD_HF_USER_TOKEN` gates at `runMcpFlow.ts:172,195` apply to downstream MCP **tool-server** URLs, *not* the completion endpoint — so both flows leak. The header comment at `runRagFlow.ts:5-9` claiming "no HF token forwarding" is false.

**Fix.**
- Add one config key `OPENAI_FORWARD_USER_TOKEN` (default `""` = off) in `config.ts` next to `MCP_FORWARD_HF_USER_TOKEN:161`.
- Add a shared helper `userTokenHeaders(locals)` (e.g. `mcp/forwardUserToken.ts`) reusing `isValidUrl` from `urlSafety.ts`: returns the `Authorization` header only when `OPENAI_FORWARD_USER_TOKEN === "true"` AND `isValidUrl(OPENAI_BASE_URL)` AND `locals?.token` present.
- Replace all three leaking header blocks with `...userTokenHeaders(locals)`.
- Correct the false header comment at `runRagFlow.ts:5-9`.
- Emit one warn log per process when the flag is on but `isValidUrl` rejects.

**Validation.** Unit tests on the helper (default off → no header; flag on + valid HTTPS + token → header; flag on + invalid URL → no header + warn; flag on + no token → no header; assert `router.huggingface.co/v1` passes `isValidUrl`). Integration grep-test asserting no remaining inline `Authorization: Bearer ${locals` literal in either flow. Manual `curl`-trace to a local recorder.

**Rollback.** Behavior is fully controlled by the flag — operators who depended on forwarding (e.g. HF-router billing) set `OPENAI_FORWARD_USER_TOKEN=true` to restore prior behavior without a code revert (provided the URL passes `isValidUrl`). Code revert is a clean single-PR revert, no schema coupling. **Verify the HF-router path passes `isValidUrl` before merge.**

**Effort.** 5 h. **Dependencies.** None — ship first, both flows in one hotfix PR.

#### 2. System-prompt rewrite (`toolPrompt.ts`)
**Problem.** The 240-line `buildToolPreprompt` builder: hardcodes "agent.py had 16 chunks" (line 96) into every user's prompt; states the same rule three different ways (lines 33/116/233 "2–3 lines"; 45/224/235 "ask vs. don't ask"; 33/234 "don't explain"); advertises `generate_artifact` in the unconditional `## TOOL CHAINING` block (line 215) which the RAG flow never registers — training hallucination that feeds issue 7 then issue 5; carries a `ragEnabled` flag both call sites ignore (issue 3); and is missing every section a modern agentic-RAG prompt has (grounding, citation discipline, anti-loop, EMPTY-vs-ERROR handling, privacy/scope).

**Root cause.** The prompt grew as a single string during feature-add sprints with no per-flow split, no snapshot tests, and no review gate. The `agent.py` reference is the smoking gun it was a debug scratchpad that shipped.

**Fix.**
- **Builder split:** create `buildRagFlowPrompt.ts` and `buildMcpFlowPrompt.ts`, plus a `promptSections/` directory (identity, contextResolution, multiTurnRetrieval, retrievalGrounding, ragTools, codeGraphTools, web/github/artifact/cheatsheet/refinePrompt/generateData, toolChaining, errorHandling, antiLoop, responseStyle). Each section emitted exactly once. Keep `toolPrompt.ts` as a thin deprecated re-export.
- **Add missing sections:** product identity & scope; retrieval grounding ("cite `[<file>#chunk<n>]`; quote verbatim what the user asked to see; if chunks don't answer, say so — don't fill from prior knowledge"); anti-loop ("don't call the same tool with the same args twice; refine on EMPTY before retrying"); EMPTY-vs-ERROR handling; privacy (no internal file-ID format leakage).
- **Gate `## TOOL CHAINING`** so each example only appears when its tool is in `names` — never reference an unregistered tool.
- **Delete** `agent.py` and any other fixture identifiers; collapse the triplicated rules into one each in `responseStyle.ts`.
- **Rewire** both call sites to pass `conv.ragEnabled !== false` (fixes issue 3); delete the after-the-fact "RAG disabled" notes at `runRagFlow.ts:457-461` / `runMcpFlow.ts:377-381`.

**Validation.** Full snapshot-test suite (five permutations per flow) in `buildRagFlowPrompt.spec.ts` / `buildMcpFlowPrompt.spec.ts` (this is the entirety of item 15). CI grep-assert: `! grep -E "agent\.py|MyClass|AgentRunner|tenant::file::name" src/lib/server/textGeneration/utils/`. New `promptInjection.spec.ts` exercising injection probes against a mocked completion, asserting the grounding rule holds. Manual: real RAG turn with a small `.py` file, confirm `[file#chunkN]` citations and no `generate_artifact` calls.

**Effort.** 16 h (3 h section authoring, 4 h builder split + rewiring, 4 h full snapshot + injection suite, 2 h dead-branch deletion + shim, 2 h manual tuning across small/large/cross-file conversations, 1 h release notes + mark prompt review-required). **Dependencies.** None; issues 3, 7, 10, 14, 15 assume this lands first.

### P1 — High Priority (after P0; ordering matters)

#### 3. Pass `ragEnabled` at both call sites
**Problem.** `buildToolPreprompt(tools, ragEnabled = true)` — neither caller passes the flag, so the prompt always says "File retrieval ACTIVE" even when the user disabled RAG, then contradicts itself with an appended "RAG disabled" note.
**Fix.** Folded into issue 2: both builders receive `conv.ragEnabled !== false`; the disabled branch is handled in one place.
**Validation.** Snapshot permutation with `ragEnabled=false` asserts no contradiction. **Effort.** 1 h. **Dependencies.** Issue 2.

#### 4. Tool-result status hardcoded `Success`
**Problem.** `runRagFlow.ts:361-377` emits `status: Success` for every tool result, including JWT failures and backend 5xx — telemetry and the UI status badge undercount failures.
**Root cause.** The dispatch loop never tracks whether the catch fired or the inner result carried `error`.
**Fix.** `ToolResult` (`Tool.ts:12-26`) is a discriminated union — `ToolResultError` has `message` and **no** `outputs`. Do **not** flip the enum on the `outputs` payload (won't compile). Track `let dispatchError: string | null`; set it in the catch (line 355) and in each error-bearing branch (`retrieve_docs`/`get_file_chunks` on `error && chunks.length===0`; `get_code_graph_related` on `data===undefined && error`). Emit the `.Error` variant with `message` when set, else the `.Success` variant with `outputs`. Keep the model-facing XML unchanged so the agent still sees the error text. The UI already renders `.Error` via `result.message` (`ToolUpdate.svelte:302`).
**Validation.** `npm run check` (the compile gate that the naive enum-flip would fail); unit tests asserting `.Error` variant carries `message` and no `outputs`, `.Success` carries `outputs`. **Effort.** 3 h. **Dependencies.** None.

#### 5. Loop-exhaustion → double answers
**Problem.** When the agentic loop hits `MAX_LOOPS`, `runRagFlow` returns `verdict: not_applicable`, which the consumer (`index.ts:74-80`) treats as "RAG didn't apply" and falls through to plain `generate()` — after tool updates already streamed. User sees two answers.
**Fix.** Distinguish `exhausted` from `not_applicable` in the `RagFlowResult` union (`runRagFlow.ts:53`); on exhaustion, return the best partial answer (or a graceful "couldn't complete retrieval" message) and signal the consumer **not** to fall through.
**Validation.** Test asserting an exhausted turn yields exactly one streamed answer. **Effort.** 3 h. **Dependencies.** Land after issue 7 (so exhaustion is rare and the partial-answer path is verifiable).

#### 6. Retry path silently disables RAG
**Problem.** The RAG engagement gate runs only in the non-retry branch of `+server.ts` (`:294-386`); the retry branch (`:246-293`) skips it, so clicking "Retry" silently answers without RAG.
**Fix.** Hoist the engagement decision so both branches run it, using the appropriate `userQuery` (the `newPrompt` for user-retry, the parent user message for assistant-retry).
**Validation.** Test asserting `agenticRagEngaged=true` parity between retry and non-retry turns for the same conversation. **Effort.** 4 h. **Dependencies.** None.

#### 7. Hallucinated tool names silently dropped
**Problem.** `runRagFlow.ts:612-638` filters unknown tool names out silently; the model is never told a name was invalid, so it re-hallucinates and burns all 10 iterations.
**Fix.** Split into `knownCalls`/`unknownCalls`; synthesize a `tool`-role `<tool_error code="UNKNOWN_TOOL">` reply (listing available tools) for each unknown call, with the assistant message retaining the original tool_calls so `tool_call_id`s match (OpenAI schema requirement). **Token-blowup guard:** cap synthetic replies at 3 per iteration (collapse overflow into one summary) and break to a graceful answer after 2 consecutive all-unknown iterations.
**Validation.** Tests for mixed known/unknown and all-unknown cases; regression asserting loops complete within 4 iterations on a standard query. **Effort.** 3 h. **Dependencies.** Issue 2 (removes the `generate_artifact` chaining hint — the dominant hallucination trigger). **Land issue 2 first.**

#### 8. Shared `criticRetriesUsed` counter
**Problem.** `criticRetriesUsed` is initialized once (`+server.ts:668`) and incremented globally (`runRagFlow.ts:269`); the first multi-tool-call call burns both retries for the whole turn, starving later calls.
**Fix.** Scope the counter per tool call (or per logical retrieval) rather than per turn.
**Validation.** Test: a turn with two distinct retrieval calls each gets its own retry budget. **Effort.** 2 h. **Dependencies.** None.

#### 9. `reformulateQuery` Promise.race leak
**Problem.** `runRagFlow.ts:225-251` — when the 1500ms timeout wins, the inner generator keeps draining the LLM with no abort; when the LLM wins, the `setTimeout` is never cleared; user "Stop" has no effect on the reformulator.
**Prerequisite (verified).** `generateFromDefaultEndpoint` (`generateFromDefaultEndpoint.ts:5-18`) takes no `abortSignal` — add `abortSignal?: AbortSignal` to its params, forward to `endpoint(...)` at line 23, confirm the endpoint propagates it. Three other callers (`reasoning.ts:11`, `generate.ts:121`, `title.ts:46`) are unaffected (optional param) but verify `npm run check`.
**Fix.** Wrap the race in an `AbortController` chained to the user `abortSignal`; `clearTimeout` in a `finally`; abort the controller on timeout and on outer-catch.
**Validation.** Fake-timer tests: LLM never resolves → generator aborted + timeout rejects once; user abort mid-flight → timeout cleared + generator aborted. **Effort.** 5 h. **Dependencies.** The signature change above.

#### 10. Duplicate inventory injection
**Problem.** The file inventory is injected twice — prepended to the first user message (`+server.ts:367-371`) and returned via the `list_files` tool result (`runRagFlow.ts:288-302`).
**Fix.** Pick one source of truth. Keep the `list_files` tool (model refreshes on demand) and drop the prepend, or vice versa — but not both. Removing the duplicated prompt rule is part of issue 2.
**Validation.** Test asserting the inventory text appears once in the assembled messages. **Effort.** 3 h. **Dependencies.** Issue 2.

#### 11. Mermaid label escaping
**Problem.** `graphToMermaid` (`runRagFlow.ts:115-148`) interpolates raw names inside `["…"]` with no escaping; `MyClass<T>`, `Array[T]`, or quoted paths produce invalid Mermaid → renderer throws → JSON fallback.
**Fix.** Add a `mermaidEscape` helper using Mermaid's `#`-prefixed entity codes (`#quot;`, `#lt;`, `#gt;`, `#91;`, `#93;`) and apply to node and edge labels. (Note: Mermaid's documented escape is the `#code;` form, not `&code;`; the validation test is the arbiter.)
**Validation.** Parse-round-trip tests with the real `mermaid` lib over fixtures (`Foo<T>`, quoted paths, `Array[T]`, `a&b`); manual graph render. **Effort.** 3 h. **Dependencies.** None.

#### 12. `get_code_graph_related` input validation + description leak
**Problem.** `ragTools.ts:306-326` — no length cap or character validation on `entity` (long values → 414/431 backend errors); the tool description (`:107-108`) literally exposes the backend's internal `tenant::file::name` format to the model.
**Fix.** Rewrite the description to a user-facing symbol-name spec (no `tenant::file::name`). Add runtime validation: max 256 chars; Unicode-aware pattern `/^[\p{L}\p{N}_.<>:\-]+$/u` (ASCII-only would reject valid non-English identifiers). Also cap `handleRetrieveDocs` query length and `fileIds.length`.
**Validation.** Tests: empty/300-char/whitespace/`a;b` → error; valid `MyClass<T>`, `café`, and a CJK identifier → backend call. CI grep-assert against `tenant::file::name` in `ragTools.ts`. **Effort.** 2 h. **Dependencies.** None.

### P2 — Medium Priority

- **13. Structured telemetry.** Contextual child logger (`{ tenant, conv }`) at the top of `runRagFlow` and `dispatchRagToolCalls`; standardize fields (`tool`, `loop`, `verdict`, `chunkCount`) across call sites. Unblocks most success metrics. **6 h.**
- **14. Server-side anti-loop guardrail.** `seenCalls: Set<string>` keyed `${name}::${normalizedArgs}` per turn in `dispatchRagToolCalls`; on duplicate, skip the backend and synthesize a `<tool_error code="DUPLICATE_CALL">` reply (reuses issue 7 infra). **4 h.** Depends on issue 7.
- **15. Prompt snapshot tests.** Built inside issue 2; **0 h additional** — listed for traceability and to make the regression-lock explicit.
- **18. `RAGClient.getJWT` swallows refresh failures** (`client.ts:76-83`). Distinguish failure classes (expired vs. backend-5xx vs. network) via a typed `RagAuthError`; only fall back on the expired/absent case, propagate the rest so they surface as real tool errors (issue 4); add a re-entrant-refresh guard against the recursive-401 loop. **3 h.** Cleanest after items 13 and 4.

### P3 — Backlog
- **16. Tool-call audit log.** New `ragToolEvents` MongoDB collection written from `dispatchRagToolCalls` (`{ convId, userId, turnId, callId, tool, argsHash, status, chunkCount, verdict, ts }`) for offline retrieval-precision analysis. Depends on item 13. **6 h.**
- **17. Stray `console.*` cleanup.** Swap `+server.ts:343,362,380` to the contextual logger. **1 h.**

---

## Enterprise Gap Analysis

Specific to this codebase, not generic monitoring advice.

1. **Retrieval grounding is not enforced server-side.** Post-rewrite the prompt *asks* the model to cite chunks, but nothing verifies a citation `[file.py#chunk7]` corresponds to an actually-retrieved chunk. Claude Code / OpenAI Assistants v2 return citations as first-class structured objects the UI cross-checks. *Fix: parse the final answer for `[<file>#chunk<n>]`, cross-check against `chunksAccumulator`, strip/warn on mismatch before persistence (~8 h, P2 once the prompt enforces the format).*
2. **Anti-loop guardrails are prompt-only.** No server-side "same (tool, args) twice" enforcement; `MAX_LOOPS` is the bottom-of-cliff catch. Covered by P2 item 14.
3. **No tenant/conversation context in logs.** Triage across users is manual grep. Covered by P2 item 13.
4. **No error-class taxonomy.** EMPTY-vs-ERROR-vs-PARTIAL are conflated (issues 4, 18); dashboards can't distinguish "no results" from "backend down." Covered by issues 4 + 18.
5. **No prompt-injection regression suite.** Zero tests for "uploaded file contains IGNORE PREVIOUS INSTRUCTIONS." Covered as a sub-bullet of issue 2 (`promptInjection.spec.ts`); broader eval (~8 h) is a P2 follow-up.

---

## Implementation Order

Dependency-driven, not strictly priority-ordered.

**Day 0 — hotfix**
1. **Issue 1** — token leak, both flows. Branch `hotfix/openai-token-leak` off `cheatsheet`, single PR (shared helper), cherry-pick to release branches. Blocks any safe production deploy.

**Day 1–3 — P0-B + linked P1s (PR stack on `cheatsheet`)**
2. **Issue 2** — prompt rewrite (builder split, missing sections, snapshot + injection tests). Includes issue 3 and item 15.

**Day 3–4 — P1s that depend on a stable prompt**
3. **Issue 7** — hallucinated-tool synthetic-error reply. *Must come after issue 2* (otherwise the synthetic path fires constantly on `generate_artifact` ghost calls and telemetry can't separate prompt-noise from real misbehavior).
4. **Issue 10** — inventory dedup (issue 2 removed the duplicate prompt rule).
5. **Issue 5** — `exhausted` return (after issue 7, so exhaustion is rare and the partial-answer path is verifiable).

**Day 4–5 — independent P1s (parallelizable)**
6. **Issues 4, 8, 12** — independent quality fixes.
7. **Issue 6** — retry path (routes + RAG lead).
8. **Issues 9, 11** — reformulator leak + Mermaid escape.

**Next sprint — P2/P3**
9. **Item 13** (telemetry) early — unblocks success metrics → **item 14** (depends on issue 7) → **item 18** (depends on 13 + 4) → **items 16, 17**.

---

## Success Metrics

Tuned to a RAG/agentic system; chart within two weeks of shipping.

> **Instrumentation prerequisite:** metrics marked † require P2 item 13 (structured telemetry) and, for retrieval precision, P3 item 16. Measurable *today*: double-answer rate, reformulator orphan rate, Mermaid render success, prompt-injection pass rate, token-leak config audit. Sequence item 13 early to populate the rest.

| Metric | Target | Source |
|--------|--------|--------|
| Loop-exhaustion rate † | < 1% (from est. 5–8%) | issues 5, 7 |
| Double-answer rate | 0% | issue 5 |
| Tool-error surface accuracy † | 100% | issue 4 |
| Retry RAG-parity † | 100% | issue 6 |
| Retrieval precision (offline) † | > 60% → > 75% | item 16 |
| First-turn `list_files` rate † | < 10% (from est. 60–80%) | issue 10 |
| Hallucinated-tool rate † | < 2% | issues 2, 7 |
| Reformulator orphan rate | 0% | issue 9 |
| Mermaid render success | 100% on fixtures | issue 11 |
| Prompt-injection pass rate | 100% per PR | issue 2 / Gap 5 |
| Cross-domain token-leak audit | 0 (default off, both flows) | issue 1 |
| **Test coverage** (RAG modules) | > 80% | all |
| **Open P0 issues** | 0 | — |

---

## Total Effort
- **Phase A (P0):** 21 h
- **Phase B (P1):** 29 h
- **Phase C (P2):** 13 h
- **Phase D (P3):** 7 h
- **P0+P1 critical path:** 50 h
- **Grand total (P0–P3):** ~70 h (≈9 senior-eng days; ~5 calendar days with two engineers given the parallelizable P1 stack)

---

*Implementation can begin with Phase A (the token-leak hotfix).*
