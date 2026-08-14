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
Note the plan's phasing has drifted from reality in one respect: Phase 2 originally
called for local specs/stubs standing in for appq's tools; instead, the real
`autotest-executor`/`autotest-validator`/`autotest` workflows and their backing tools
were built directly on appq's `appq/autotest-mcp-tools` branch (isolated from the other
feature in flight there), so there was never a stub to build or later swap out.

**Current phase: Phase 2** — the two-stage executor/validator pattern is wired
(`judge` command) against the real appq workflows, not yet run live end-to-end (needs
`APPQ_API_KEY` + an LLM key — neither is something this session can supply). appq's
`appq/autotest-mcp-tools` branch is local-only there too: not pushed, not merged, not
deployed to the public origin — for local testing point `APPQ_ORIGIN` at the Lando
instance running that branch (see `.env.example`), not `https://appq.appliqation.io`.

## Where to find what

- `src/cli/` — CLI entrypoints. `runman` (Phase 1) proves the engine against the
  existing, real `appq:runman` workflow. `judge` (Phase 2) runs a test case as two
  genuinely separate `runWorkflow()` invocations — `appq:autotest-executor` then
  `appq:autotest-validator` — with a plain, non-LLM-mediated `update_run_results`
  `create_run` call in between if no `--run-id` is given. Still to come: a `run` command
  (Phase 5, full-scenario router + coverage policy).
- `src/engine/` — the generic, workflow-agnostic core: `loop.ts` (think→act→observe),
  `budget.ts` (call/page/time caps), `workflowRunner.ts` (fetches a named appq workflow
  and runs it through the loop as one fresh-context invocation — the same function backs
  both `runman` and each stage of `judge`; two calls to it with no shared `messages`
  array is the entire mechanism behind executor/validator isolation, nothing fancier).
  This is the one piece meant to be reusable by future sibling agents (runman-as-CLI,
  defect-fix, PR-raise) per the plan's "larger vision" section — keep it workflow-name-
  agnostic, resist adding autotest-specific assumptions here.
- `src/tools/` — `browserTools.ts` (Playwright-backed `browser_*` tool palette, ref-based
  via `page.ariaSnapshot({mode:'ai'})` + `aria-ref=` locators — no manual DOM injection),
  `appqTools.ts` (`fetchAppqToolDefs()` filters `tools/list` to an allowlist for what's
  *offered* to the model; `createGatedAppqDispatcher()` is the actual enforcement point —
  it calls `assertToolAllowed()` before every dispatch, so a call outside the allowlist
  can't execute even if a model attempts it or a served prompt suggests it), `safety.ts`
  (**the one hardcoded, non-negotiable invariant** — the destructive-action gate and the
  per-stage read/write allowlists; no served workflow prompt can widen these).
- `src/appq/mcpClient.ts` — JSON-RPC client to `/api/appq/mcp`: `fetchPrompt()`
  (`prompts/get` — pass the **full** name, e.g. `appq:runman`, not the short
  `start_workflow` name), `startWorkflow()`, `callTool()`, `listTools()`,
  `uploadScreenshot()`.
- `src/evidence/capture.ts` — screenshot/console/network/accessibility-snapshot capture
  via native Playwright/CDP APIs.
- `src/providers/` — official `@anthropic-ai/sdk`/`openai` adapters. The Anthropic one
  sets `cache_control` breakpoints (system prompt, tool defs, growing message history) —
  see the plan/session notes on why: the workflow prompt and tool list are static and
  reused across every turn and every TC, and the full history gets resent every turn
  regardless, so caching is high-leverage here, not optional polish.

## Commands

- `npm run dev -- <command>` — run the CLI via `tsx` without building
- `npm run build` / `npm run typecheck`
- `npx tsx src/cli/index.ts runman --url <target> --project-id <id>` — Phase 1 proof run
- `npx tsx src/cli/index.ts judge --test-case-uuid <uuid> --url <target> --scenario-id <id> --project-id <id>`
  — Phase 2 proof run (add `--run-id` to reuse an existing run instead of creating one)

## Config

Copy `.env.example` to `.env`. Requires `APPQ_API_KEY` and one of
`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`. For local testing against appq's
`appq/autotest-mcp-tools` branch (pre-merge), set `APPQ_ORIGIN` to the local Lando
instance, not the public origin — see the comment in `.env.example` for the TLS caveat
that comes with that (self-signed cert).

## Keeping this file current

When you add, remove, or rename a top-level file or a directory under `src/`, update the
map above in the same change. When a phase completes, update "Current phase" above.
