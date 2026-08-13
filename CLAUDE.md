# CLAUDE.md — appliqation-autotest

Part of the Appliqation workspace. See `~/Sites/localhost/CLAUDE.md` for how the
product fits together; this file is the map of **this repo only**.

## What this repo is

A standalone, independently-hosted autonomous testing agent. It is a **generic
MCP-workflow execution engine** — it has no testing logic of its own. The testing
methodology (routing policy, execution discipline, judgment criteria) is owned by
Appliqation and served as MCP workflow prose (`start_workflow`/`prompts/get`); this repo
just fetches a named workflow and executes it: drives a real Playwright browser, calls
appq MCP tools, and runs a think→act→observe loop until the model's turn has zero tool
calls.

Full design rationale and phasing lives in the plan this was built from:
`~/.claude/plans/this-looks-good-lets-quirky-oasis.md`. Read that before making
architectural changes here — in particular the reasoning behind the executor/validator
split, the coverage-decision (never hardcode whether agentic coverage runs alongside a
canonical script), and why `appliqation-runman-ext` is explicitly not a design basis.

**Current phase: Phase 1** (bootstrap, zero appq changes) — proving the engine against
appq's already-registered `runman` workflow. `autotest-executor`/`autotest-validator`
don't exist in appq yet (that's Phase 3, blocked on another feature currently in flight
on the `appq` branch); until then this repo builds toward them via specs and local
stand-ins (Phase 2), not by waiting.

## Where to find what

- `src/cli/` — CLI entrypoints. `runman` (Phase 1) proves the engine against the
  existing, real `appq:runman` workflow. Later: `judge` (Phase 2, executor/validator
  pair), `run` (Phase 5, full-scenario router).
- `src/engine/` — the generic, workflow-agnostic core: `loop.ts` (think→act→observe),
  `budget.ts` (call/page/time caps), `workflowRunner.ts` (fetches a named appq workflow —
  or a local stand-in — and runs it through the loop as one fresh-context invocation).
  This is the one piece meant to be reusable by future sibling agents (runman-as-CLI,
  defect-fix, PR-raise) per the plan's "larger vision" section — keep it workflow-name-
  agnostic, resist adding autotest-specific assumptions here.
- `src/tools/` — `browserTools.ts` (Playwright-backed `browser_*` tool palette, ref-based
  via `page.ariaSnapshot({mode:'ai'})` + `aria-ref=` locators — no manual DOM injection),
  `appqTools.ts` (wraps appq MCP tools as LLM-callable defs, schemas fetched live from
  `tools/list`), `safety.ts` (**the one hardcoded, non-negotiable invariant** — the
  destructive-action gate and the per-stage write-tool allowlist; no served workflow
  prompt can widen these).
- `src/appq/` — `mcpClient.ts` (JSON-RPC client to `/api/appq/mcp`: `prompts/get`,
  `start_workflow`, `tools/call`, `tools/list`, screenshot upload). `localStub.ts` (not
  yet built — Phase 2's temporary stand-in for `submit_execution_evidence`/
  `get_automation_readiness`, which don't exist in appq yet; built exactly to
  `docs/specs/*.md` so the later swap to live appq is a config change).
- `src/evidence/capture.ts` — screenshot/console/network/accessibility-snapshot capture
  via native Playwright/CDP APIs.
- `src/providers/` — official `@anthropic-ai/sdk`/`openai` adapters (server-side, not the
  raw-`fetch` browser-constrained style — that constraint doesn't apply here).
- `docs/specs/` — precise schemas for appq-side tools this repo depends on but appq
  hasn't implemented yet. These are the literal source of truth appq's later
  implementation should match, not scratch notes.
- `docs/prompts/` — drafted `autotest-executor`/`autotest-validator` workflow content,
  bundled locally until appq registers the real thing (Phase 3).

## Commands

- `npm run dev -- <command>` — run the CLI via `tsx` without building
- `npm run build` / `npm run typecheck`
- `npx tsx src/cli/index.ts runman --url <target> --project-id <id>` — Phase 1 proof run

## Config

Copy `.env.example` to `.env`. Requires `APPQ_API_KEY` (a real appq API key — see the
plan's CI section on using a scoped service-account key, not a personal one, once this
moves beyond local dev) and one of `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`.

## Keeping this file current

When you add, remove, or rename a top-level file or a directory under `src/`, update the
map above in the same change. When a phase completes, update "Current phase" above.
