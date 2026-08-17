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

**Current phase: Phase 5 code complete, nothing run live yet.** The appq side is done
and verified: `appq:autotest-executor`/`-validator`/`autotest`, `get_automation_readiness`,
`submit_execution_evidence`/`get_execution_evidence`, and the `blocked` status enum are
all deployed to the real origin and confirmed working by direct MCP calls (PR #622,
`appq/hotfix-autotest-mcp-tools`, merged to `appq/prod/iron`). `APPQ_ORIGIN` can point at
the real origin now, not Lando. What's still unverified is this repo's own code: `judge`
(Phase 2, one TC) and `run` (Phase 5, whole scenario + coverage policy + `--dry-run`) are
built and typecheck clean, but neither has executed against a real LLM + real browser —
confirming the appq tools work is not the same as confirming this client's engine,
Playwright driving, or image-viewing wiring actually work end to end. `.env` now has real
credentials (with Haiku set for both roles, to keep cost down for the first live runs).

**Config philosophy:** avoid hardcoded values wherever a real choice exists — see
`src/config/env.ts` and `.env.example` for the full surface (models per provider per
role, max tokens, all budget caps, ring buffer size, poll interval/timeout). The one
deliberate exception is `src/tools/safety.ts`: the destructive-action gate and the
per-stage tool allowlists stay hardcoded on purpose — that's "the one hardcoded,
non-negotiable invariant" the whole executor/validator safety model rests on, not an
oversight to fix. Don't add a config knob for those.

## Where to find what

- `src/cli/` — CLI entrypoints. `runman` (Phase 1) proves the engine against the
  existing, real `appq:runman` workflow. `judge` (Phase 2) runs one test case as two
  genuinely separate `runWorkflow()` invocations — `appq:autotest-executor` then
  `appq:autotest-validator` — with a plain, non-LLM-mediated `update_run_results`
  `create_run` call in between if no `--run-id` is given. `run` (Phase 5) applies the same
  pattern across a whole scenario: fetches `get_automation_readiness` once, applies
  `--coverage` per TC, calls `judgeTc()` (see `src/orchestrator/`) for the TCs that need
  agentic coverage, then polls `get_test_results` once for the full TC list — that single
  poll picks up both the deterministic pipeline's own results and whatever the validator
  already wrote itself, so no special-casing is needed between the two paths.
- `src/orchestrator/` — `judgeTc.ts` (the executor→validator pair for one TC, factored out
  of `judge` so `run` doesn't duplicate it), `coveragePolicy.ts` (`always` /
  `on-script-absence` / `sampled:N` / `external` — never hardcoded, see the plan's
  "coverage decision"; `external` throws if selected without a decider function wired up —
  a deliberate hook for a future orchestrating agent, not a silent fallback),
  `pollResults.ts` (poll-until-settled against `get_test_results`, since the deterministic
  path is SQS-driven with no blocking/webhook API).
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
- `src/tools/screenshotViewer.ts` — turns `get_execution_evidence`'s `screenshot_url` (a
  string in text, never actually seen by the model on its own) into a real vision input.
  Two modes, chosen by `--mandatory-image-check`/`MANDATORY_IMAGE_CHECK`, deliberately an
  orchestration/deployment setting and not something the workflow prompt controls: on-
  demand (model gets a `view_screenshot(step_index)` tool, decides for itself when text
  evidence isn't enough — most steps don't need it) or mandatory (every step's screenshot
  fetched and attached unconditionally, enforced in code before the model ever gets a
  turn — same reasoning as the destructive-action gate: don't rely on the model asking).
- `src/providers/` — official `@anthropic-ai/sdk`/`openai` adapters, model and max-tokens
  passed in (`config/env.ts`'s `resolveModel(role)` — separate overrides per provider AND
  per role, since judging captured evidence is closer to bounded classification than the
  executor's open-ended browser-driving planning; a cheaper/different model is a
  reasonable fit for the validator specifically, and a decorrelation lever against
  same-model self-grading risk). The Anthropic adapter also sets `cache_control`
  breakpoints (system prompt, tool defs, growing message history) — see the plan/session
  notes on why: the workflow prompt and tool list are static and reused across every turn
  and every TC, and the full history gets resent every turn regardless, so caching is
  high-leverage here, not optional polish. Both adapters also handle `LlmMessage.images`
  on tool results — Anthropic inline in the `tool_result` block, OpenAI as a synthetic
  follow-up `input_image` message (the Responses API has no way to attach an image to a
  function output directly).
- `src/tools/dryRun.ts` — `--dry-run`'s enforcement point: intercepts
  `update_run_results`/`create_defect` calls and logs what would have been sent instead of
  sending it. A dispatch-level intercept, not a prompt instruction, same reasoning as the
  destructive-action gate — the validator's own workflow prose is what decides to write,
  so "don't write" has to be enforced below that, not asked of it.

## Commands

- `npm run dev -- <command>` — run the CLI via `tsx` without building
- `npm run build` / `npm run typecheck`
- `npx tsx src/cli/index.ts runman --url <target> --project-id <id>` — Phase 1 proof run
- `npx tsx src/cli/index.ts judge --test-case-uuid <uuid> --url <target> --scenario-id <id> --project-id <id>`
  — one TC (add `--run-id` to reuse an existing run, `--dry-run` to suppress writeback)
- `npx tsx src/cli/index.ts run --scenario-id <id> --project-id <id> --url <target> [--coverage <policy>] [--dry-run]`
  — a whole scenario, consolidated report across every TC

## Config

Copy `.env.example` to `.env`. Requires `APPQ_API_KEY` and one of
`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`. `APPQ_ORIGIN` can point at the real origin now that
the appq-side tools are deployed there — only fall back to a local Lando instance if
testing against appq changes that haven't landed on `prod/iron` yet.

## Keeping this file current

When you add, remove, or rename a top-level file or a directory under `src/`, update the
map above in the same change. When a phase completes, update "Current phase" above.
