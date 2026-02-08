# AI SearchDocs + Failure Logs Plan

## Goals

- Add a true model-invoked `searchDocs` tool (Path A: AI SDK tool loop with `stopWhen`).
- Support OpenAI + Anthropic only.
- Move to a single prompt function for create/edit/fix flows.
- Feed failed-run context using full app logs from both client and server.
- Keep logs in memory only, using last 20 log entries per app/runtime side.

## Scope Decisions (Locked)

- Docs corpus for search: `docs/` only.
- Tool model behavior: real tool calls (not pre-retrieval only).
- Providers: OpenAI + Anthropic.
- Log redaction: not in first rollout.
- Log window: last 20 entries (entry-based, not line-based).

## PR Work Units (Tracked Checklist)

### PR-1: AI Provider Consolidation + Shared Runner
- [ ] Remove xAI/Google branches and centralize provider selection to OpenAI/Anthropic only.
- [ ] Introduce a shared AI runner module used by both create and script-edit/fix paths.
- [ ] Keep existing behavior unchanged (still single-step generation for now).
- Concrete steps:
- Touch `src/core/systems/ServerAI.js`.
- Touch `src/core/systems/ServerAIScripts.js`.
- Add shared helper module under `src/core/systems/` (or `src/core/extras/`), used by both systems.
- Acceptance criteria:
- Server boots with both providers.
- Existing AI create/edit/fix behavior still works with current prompts.
- Notes:
- This unit is independent.

### PR-2: Docs Search Service (Tool Backend)
- [ ] Implement server-side docs search service over `docs/**/*.md(x)` only.
- [ ] Build chunking/scoring and return top matches with `path`, `excerpt`, and score metadata.
- [ ] Add constraints for bounded payload size per tool response.
- Concrete steps:
- Add docs search module(s), e.g. `src/core/ai/DocsSearch*.js`.
- Reuse existing docs root resolution behavior from server AI/index code.
- Add tests for chunking/scoring determinism and path validation.
- Acceptance criteria:
- Query returns stable top-k results from `docs/`.
- No reads outside docs root.
- Response size is bounded.
- Notes:
- This unit is independent.

### PR-3: Client App Log Buffer (Memory Ring)
- [ ] Add in-memory ring buffers keyed by `appId` for client-side script logs.
- [ ] Capture `console.log/warn/error/time/timeEnd` emitted by app scripts.
- [ ] Expose API to fetch last 20 entries for a given app.
- Concrete steps:
- Touch `src/core/systems/Scripts.js` and/or app execution path to add app-aware logging context.
- Add a client-side log buffer system/module and register in `createClientWorld`.
- Add retrieval method used by AI request builder.
- Acceptance criteria:
- For a test app, logs are captured in order with timestamp + level + args/message.
- Buffer trims to 20 entries.
- No persistence across reloads.
- Notes:
- This unit is independent.
- Risk note: async attribution may require context plumbing around script callbacks and timers.

### PR-4: Server App Log Buffer (Memory Ring)
- [ ] Add in-memory ring buffers keyed by `appId` for server-side script logs.
- [ ] Capture script console output from server runtime execution.
- [ ] Expose API to fetch last 20 entries for a given app.
- Concrete steps:
- Touch `src/core/systems/Scripts.js` and/or server app execution path for app-aware context.
- Add server-side log buffer system/module and register in `createServerWorld`.
- Add retrieval API for AI fix path.
- Acceptance criteria:
- Server captures app-script logs with timestamp + level + args/message.
- Buffer trims to 20 entries.
- No DB/file persistence.
- Notes:
- This unit is independent.
- Risk note: same async attribution caveat as PR-3.

### PR-5: Unified AI Request Contract + Single Prompt Function
- [ ] Define one internal prompt builder function used for create/edit/fix.
- [ ] Standardize one response schema across modes (JSON contract).
- [ ] Update client payload construction to use unified request shape.
- Concrete steps:
- Refactor prompt assembly in `src/core/systems/ServerAI.js` and `src/core/systems/ServerAIScripts.js`.
- Add shared prompt builder module and shared schema validation.
- Update `src/core/systems/ClientAI.js` and `src/core/systems/ClientAIScripts.js` request composition as needed.
- Acceptance criteria:
- Create/edit/fix all route through a single prompt function.
- Output parsing/validation is shared and deterministic.
- Existing UI still receives `scriptAiProposal` and create still completes.
- Notes:
- Dependency: recommended after PR-1 (shared runner), but can proceed without it if needed.

### PR-6: Tool Loop Integration (Path A) + `searchDocs` Tool
- [x] Add AI SDK tool loop (`tools` + `stopWhen`) for OpenAI/Anthropic.
- [x] Register `searchDocs` tool that calls PR-2 docs search service.
- [x] Add tool budgets (max steps, max tool calls, timeout/fail-safe).
- Concrete steps:
- Update shared AI runner / server AI systems to call tool-enabled generation.
- Implement `searchDocs` tool input schema and output schema.
- Add telemetry/logging for tool-call count and finish reason.
- Acceptance criteria:
- Model can invoke `searchDocs` during generation.
- Final output still conforms to the shared response schema.
- Behavior is bounded by configured step/tool limits.
- Notes:
- Dependency: PR-2, PR-5.

### PR-7: Failure Context Wiring (Client + Server Logs into Fix)
- [ ] On fix requests, include client last-20 app log entries.
- [ ] On server handling, append server last-20 app log entries for same app.
- [ ] Inject both into unified prompt context for fix mode.
- Concrete steps:
- Extend fix payload in `src/core/systems/ClientAIScripts.js` with client log snapshot.
- Server resolves server logs by `appId` and merges both contexts in prompt builder.
- Add bounds/formatting for logs in prompt context.
- Acceptance criteria:
- Fix-mode prompt includes exception + client logs + server logs.
- No logs included for non-fix modes unless explicitly enabled.
- Payload size remains bounded.
- Notes:
- Dependency: PR-3, PR-4, PR-5.

### PR-8: Hardening, Tests, and Rollout Switch
- [x] Add integration tests for searchDocs tool flow and fix-with-logs flow.
- [x] Add smoke checks for provider selection and failure fallback paths.
- [x] Add feature flag / safe rollout toggle and ship docs.
- Concrete steps:
- Add tests under `test/integration/` for:
- Tool-call path returning valid patch output.
- Fix request includes both log sides and yields valid patch output.
- Add documentation updates in `docs/` for AI behavior and operational limits.
- Acceptance criteria:
- End-to-end tests pass with OpenAI and Anthropic configs.
- Rollout can be toggled safely.
- Notes:
- Dependency: PR-6, PR-7.

## Dependency Graph Summary

- PR-1: none
- PR-2: none
- PR-3: none
- PR-4: none
- PR-5: PR-1 (recommended, not hard-blocking)
- PR-6: PR-2 + PR-5
- PR-7: PR-3 + PR-4 + PR-5
- PR-8: PR-6 + PR-7

## Non-Goals (Initial Rollout)

- Log redaction/scrubbing.
- Persisted log history (DB/files/S3).
- Non-docs corpora (no `ai-docs.md`, no source-code search tool).
- Non OpenAI/Anthropic providers.
