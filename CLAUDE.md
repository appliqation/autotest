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

**Current phase: Phase 5 verified live, Phase 6 (CI polish) done, test-set mode (`judge --test-set-id`) added and verified live. The `runman` command (Phase 1's engine proof) has been removed — replaced outright by the dedicated `appliqation-explorer` agent, which offers the same real `appq:runman` workflow more capability (resize/tabs/evaluate, a configurable budget, read-only project-context awareness) than this command ever did.**
The appq side is done and verified: `appq:autotest-executor`/`-validator`/`autotest`,
`get_automation_readiness`, `submit_execution_evidence`/`get_execution_evidence`, and the
`blocked` status enum are all deployed to the real origin and confirmed working by direct
MCP calls (PR #622, `appq/hotfix-autotest-mcp-tools`, merged to `appq/prod/iron`).
`APPQ_ORIGIN` can point at the real origin now, not Lando. `judge` (Phase 2, one TC) has
run live against real DailyPulse/appq data (Haiku for both roles, `--dry-run`,
`--environment Stage`): real Playwright browser, real executor→evidence→validator hand-off
through appq, validator producing a grounded verdict citing actual accessibility-tree
evidence. That first run surfaced and fixed two real bugs — `browser_take_screenshot`
wasn't wired to `uploadScreenshot()` (the executor's prompt told it to POST screenshot
bytes directly, which an LLM tool-calling loop can't do) and `uploadScreenshot()` sent
the wrong Content-Type for appq's whitelist — see `src/tools/browserTools.ts` and
`src/appq/mcpClient.ts`. `run` (Phase 5, whole scenario + coverage policy) has also now
run live end to end against the same project (10 TCs, `on-script-absence` coverage):
correctly caught a real regression (a field that should've been mandatory still showing
as optional) and correctly marked a second TC `blocked` when the executor stumbled on a
stale element ref after a page reload rather than fabricating a pass — the fail-closed
design holding up under genuine model flakiness, not just the happy path. `.env` now has
real credentials (with Haiku set for both roles, to keep cost down for the first live
runs).

**Phase 6 (CI polish) done:** `--json`/`--ci` (see `src/cli/output.ts`) print a single
structured summary on stdout instead of the human table, and the process exits non-zero
whenever a non-dry-run test case comes back failed/blocked/never-settled — `judge` polls
`get_test_results` after judging so its exit code reflects appq's own authoritative status
rather than being parsed out of the validator's report prose. Example wiring at
`.github/workflows/autotest.yml` (runs `--dry-run --ci`, uploads the JSON as an artifact —
flip `--dry-run` off once trusted against a real project). Not done: the dedicated CI
service-account key the workflow example expects (`AUTOTEST_APPQ_API_KEY`) doesn't exist
yet in appq — someone needs to actually create that account and scope its project
membership.

**Automated tests (vitest):** `npm test`. Started with the pure-logic/safety-invariant
modules first, not broad coverage — these are the pieces where a regression would be
silent and expensive rather than immediately obvious: `tools/safety.ts` (destructive-action
gate, executor/validator write boundary), `tools/appqTools.ts` (the actual dispatch-level
enforcement — asserts a disallowed call never reaches `callTool` at all, not just that an
error surfaces somewhere), `tools/dryRun.ts`, `cli/output.ts` (exit-code logic),
`orchestrator/coveragePolicy.ts`, `tools/roleInference.ts`, `tools/authState.ts`,
`tools/browserLabel.ts`, `tools/screenshotViewer.ts`, `orchestrator/pollResults.ts` (fake
timers, not real sleeps), `engine/budget.ts`, `cli/resolvers.ts`. `cli/resolvers.ts` is a
new file — `resolveRun`/`scenarioIdFromTcUuid`/`resolveScenarioId`/`fetchScenarioInfo`/
`resolveUrl` were extracted out of `cli/index.ts` specifically to make them importable in
isolation without triggering that file's top-level `program.parseAsync(process.argv)` side
effect. Second slice added `engine/loop.ts` (the think→act→observe loop itself — turned out
fully unit-testable with a mocked `ProviderAdapter`/`ToolDispatcher`, not integration-test
territory as first assumed: budget-cap messaging, the max-turns hard stop with its final
tools-withheld completion call, abort-signal handling mid-tool-loop, dispatch-error
recovery), `engine/workflowRunner.ts` (appq vs local workflow source resolution),
`appq/mcpClient.ts` (the JSON-RPC client itself, mocked `fetch` — request/response
shape, error mapping, the `image/png` vs `application/octet-stream` upload content-type
that broke a real live run earlier this session), and `config/env.ts` (`resolveModel`'s
full role-override > blanket-override > provider-default precedence, using
`vi.resetModules()` since `config` is frozen at import time from `process.env` — `dotenv/config`
mocked to a no-op so this repo's real `.env` credentials never leak into a test run).

Third slice covered what was left — real Playwright/SDK integration points, using a fake
`Page`/browser chain and mocked SDK client constructors rather than the real thing:
`tools/browserTools.ts`, `evidence/capture.ts`, `orchestrator/judgeTc.ts` (mocked
`chromium.launch()` — browser-lifecycle guarantees: closes even when the executor stage
throws, and the validator stage never runs in that case; `browser.version()`'s label
correctly threading into the validator's `create_defect` calls), `providers/anthropic.ts`/
`openai.ts` (mocked `@anthropic-ai/sdk`/`openai` client constructors as classes, not
`vi.fn().mockImplementation()` — the latter doesn't honor a returned object under `new` in
this vitest version, cost an hour of debugging before switching; message/image conversion
for both wire formats, Anthropic's cache-control breakpoints, the real `?? undefined` vs `0`
distinction on `cache_read_input_tokens`). 283 tests total — every source file with real
logic now has one, except `cli/index.ts` itself (Commander wiring calling already-tested
pieces; testing it meaningfully would mean invoking `.parseAsync()` with fake argv, more
E2E than unit) and the `.d.ts` type shim (no runtime code).

**Two real bugs surfaced by writing this last slice, now fixed:**
1. `EvidenceCapture.captureStep()` was defined but never called anywhere in this codebase
   (grepped: zero call sites outside its own file and its test). `getSteps()` was
   therefore always empty, so `browser_console_messages`/`browser_network_requests`
   unconditionally returned `"[]"` regardless of what actually happened on the page —
   since the executor is instructed to call these before `submit_execution_evidence`, this
   meant console/network deltas had been submitted empty to appq this whole time,
   independent of the model-compliance explanation floated earlier this session for a
   similar-looking gap. `EvidenceCapture`'s own capture logic was already correct
   (`captureStep()` behaves fine, per its existing tests) — this was purely a wiring gap.
   Fixed by adding `EvidenceCapture.getConsoleDeltas()`/`getNetworkDeltas()`, cursor-based
   direct reads that share the same consumption cursor as `captureStep()` so nothing is
   double-counted, and pointing `browserTools.ts`'s two dispatch cases at them directly
   instead of `getSteps()`. Verified live against real DailyPulse data post-fix —
   `browser_network_requests` returned genuine captured requests with real status codes,
   not `"[]"`.
2. In `judgeTc.ts`, `createDryRunDispatcher` wrapped `createBrowserLabelDispatcher` from the
   outside (`createDryRunDispatcher(createBrowserLabelDispatcher(...), dryRun)`). Since
   `createDryRunDispatcher` intercepts `create_defect`/`update_run_results` before ever
   calling `inner`, the browser-label correction never ran for a dry-run verdict-write —
   the logged "would call create_defect with..." preview showed the model's own raw
   (possibly bare/wrong) `browser` value, not what a real, non-dry-run call would actually
   send. Fixed by reordering the wrap so `createBrowserLabelDispatcher` is outermost (see
   `judgeTc.ts`'s comment on the dispatch chain for why the order matters). Confirmed via
   `judgeTc.test.ts` (a dry-run preview now shows the corrected label); not separately
   confirmed against a live defect-filing run, since the live regression check's dry-run
   pass happened to reach a passing verdict and never called `create_defect` — the unit
   test exercises the exact same dispatcher chain deterministically, so this is considered
   sufficiently verified without forcing a failing scenario just to observe it live.

**`run` merged into `judge`:** originally two separate commands (`judge` for one TC,
`run` for a whole scenario) — merged into one, since `run` was always just `judge`'s exact
same `judgeTc()` call looped with a coverage-policy decision layered on top, not a
genuinely different mechanism. `judge --test-case-uuid <uuid>` is single-TC mode
(unconditional executor/validator pair); `judge --scenario-id <id>` with no
`--test-case-uuid` is whole-scenario mode (coverage policy decides per TC).

**Test-set mode (`judge --test-set-id <id>`):** the most common CI shape — a regression/
sanity/smoke suite is a test set, not a single scenario. appq's own `get_test_set`
describes a test set as spanning multiple scenarios, but `create_run`/
`update_run_results` is inherently scenario-scoped, so this mode groups the test set's
TCs by their own UUID-derived `scenario_id` (`scenarioIdFromTcUuid()`, the same source of
truth used everywhere else in this codebase — never a second parsed field that could
disagree with it) and resolves one run + one `get_automation_readiness` check per
distinct scenario represented, not one overall. Coverage policy, role inference, and
poll-then-report all apply per TC exactly as in whole-scenario mode; the final report is
one consolidated summary across every scenario, with each `TcOutcome` carrying its own
`runId`/`scenarioId` since there's no single one to report at the top level (see
`RunSummary`/`TcOutcome` in `src/cli/output.ts`). `--run-id` reuse is deliberately not
supported in this mode — there's no single run to reuse across possibly-many scenarios.
`fetchTestSetInfo()` (in `@appliqation/agent-core`'s `scenarioResolvers.ts`) is the
`get_test_set` counterpart to `fetchScenarioInfo()` — note its MCP param is
`testset_id`, not `test_set_id` (a real trap hit during implementation: the tool's actual
`inputSchema`, confirmed via `tools/list`, differs from the CLI flag's own naming).
Verified live (`--dry-run --json`) against the real "DailyPulse — Smoke" test set
(test_set_id 1358, 8 TCs spanning 8 distinct scenarios): correctly created 8 separate
per-scenario runs, applied `on-script-absence` coverage (1 TC with no canonical script
got real agentic judging, the other 7 were left deterministic-only), and produced one
consolidated JSON summary with each TC's own `runId`/`scenarioId` populated correctly.

`--project-id` and `--url` are **not CLI options at all** — always derived, never
accepted as separate caller-supplied inputs (`fetchScenarioInfo`/`resolveUrl` in
`src/cli/resolvers.ts`): project_id via `get_scenario` (a scenario belongs to exactly one
project, so there's no legitimate override case), url via `get_project_settings`'s
per-environment URL given `--environment` (now a `requiredOption`). Deliberate, not an
oversight: a caller-supplied `--project-id` that diverged from the real one would at
least get rejected late by appq's own `create_run` validation, but a caller-supplied
`--url` that diverged from the named `--environment`'s real URL had **no check
anywhere** — the browser would silently test the wrong target while the run got recorded
against a different environment. Removing the override closes that gap rather than
trusting the caller to keep two representations of the same thing in sync — the same
reasoning MCP tools themselves already follow (deduce from one source of truth, don't
accept a second value that could quietly disagree with it). `--scenario-id` stays a real
option, but only matters/is read in whole-scenario mode — in single-TC mode it's always
derived from the TC UUID's own `{scenario_id}-{uuid4}` format, silently ignored if passed
alongside `--test-case-uuid`. Verified live against real DailyPulse data after removing
the override paths — project/url still resolve correctly, missing `--environment` fails
immediately via commander before any API call.

**Authenticated sessions (`judge --role`):** the executor previously had no login handling
at all — never surfaced because every live test targeted DailyPulse, an ungated demo site.
No appq-side change was needed to fix this: Appliqation already has a complete mechanism
(`appq:setup-auth` for a human-reviewed, customer-committed `login.ts`; `@appliqation/automation-sdk`'s
`setupAuth({project_id, role})` for the canonical session-file path every runtime agrees
on; `npx appq-auth-setup` to actually perform the login and write that file). This client
just became one more reader of that file — see `src/tools/authState.ts` above. Verified
directly: `resolveStorageState()` against the real SDK path function (both the fail-closed
missing-file error and the happy-path read), the CLI failing immediately before any run
creation when `--role` names a session that doesn't exist, and a full regression check
confirming the unauthenticated path (no `--role`) still works after switching
`judgeTc.ts`'s browser launch from `browser.newPage()` to an explicit
`browser.newContext()` (needed so `storageState` has something to attach to). **Not**
verified in this environment: the actual authenticated-navigation happy path — there's no
real gated project among what this session has touched, so a real `storageState` actually
getting an executor past a login wall is unconfirmed and should be checked against a real
gated project before trusting it.

**Per-TC role inference (mixed-role scenarios):** `--role` applies one role uniformly to
every TC in an invocation, which is wrong for scenarios that legitimately mix roles (RBAC
tests: "admin can see settings", "standard user gets 403 on the same page" both belong in
one scenario). `src/tools/roleInference.ts` — when `--role` is omitted, `knownRolesForProject()`
scans `process.env` for `APPQ_PROJECT_<id>_<ROLE>_USERNAME` keys already required by
`appq-auth-setup` (no new appq lookup needed — role names are UI-validated lowercase/no-spaces,
so the env var's role segment round-trips back exactly), then `inferRole()` checks each TC's
own tag (`role:<name>`, `role:anonymous` explicitly meaning unauthenticated) or its title
for a known role's name — mirrors the precedence already proven in production by
`workers/automan-worker/src/services/AIScriptGenerator.js`'s `parseRoleFromTestcaseName()`,
reused rather than reinvented, but deliberately never falls back to an LLM call (unlike that
implementation) — role selection is a safety-adjacent decision, kept deterministic like every
other one in this codebase. **No match is not an error** — the TC just runs unauthenticated;
if it actually needed a session, the existing fail-closed executor/validator machinery
already surfaces that honestly, so duplicating a hard stop here would wrongly block the
common case where a mixed scenario has some TCs needing no auth at all. `fetchScenarioInfo()`
(renamed from `resolveProjectId()`) now parses both project_id and the TC list (name/UUID/tag,
via `parseScenarioTcList()`) from one `get_scenario` call rather than two. Verified: all three
functions directly (env var scanning isolates per-project correctly, precedence gives the
expected role for each case including the anonymous/no-signal ones, the real
`GetScenarioTool.php` text format parses correctly) and live against DailyPulse — both
"no roles configured" (fully inert, unchanged from before) and "roles configured but this
TC's name doesn't match any" (falls through to unauthenticated, doesn't crash).

**Config philosophy:** avoid hardcoded values wherever a real choice exists — see
`src/config/env.ts` and `.env.example` for the full surface (models per provider per
role, max tokens, all budget caps, ring buffer size, poll interval/timeout). The one
deliberate exception is the destructive-action gate and the per-stage tool allowlists
(`src/tools/safety.ts` + the shared enforcement mechanism, see below) — that's "the one
hardcoded, non-negotiable invariant" the whole executor/validator safety model rests on,
not an oversight to fix. Don't add a config knob for those.

**Migrated onto `@appliqation/agent-core` (shared package).** This repo's generic engine
(think→act→observe loop, budget tracking, the appq MCP JSON-RPC client, the gated-tool-
dispatch mechanism, Playwright browser tools, evidence capture, auth/role inference,
scenario resolvers, LLM provider adapters) was always meant to be reused by future sibling
agents (per the plan's "larger vision" section) — that became real once
`appliqation-scriptgen` (a script-generation agent) needed the same pieces, so it was
extracted into a new sibling repo/npm package, `~/Sites/localhost/appliqation-agent-core/`
(`@appliqation/agent-core`), and this repo was migrated onto it in the same change. Not yet
published — consumed via a local `file:../appliqation-agent-core` dependency in
`package.json` until it's actually published to npm; switch that to a real version pin once
it is. Two real refactors happened as part of the move, not just a file relocation:
`mcpClient.ts` became a `createMcpClient({origin, apiKey})` factory instead of a module-level
singleton reading a global `config` (each consuming agent has its own `.env` shape), and
`browserTools.ts`'s `PlaywrightBrowserTools` gained two injectable hooks
(`onBeforeClick`/`screenshotSink`) instead of hardcoding `classifyClick`/`uploadScreenshot`
directly, so a sibling agent with no appq write access (or a different destructive-action
policy) can supply its own. Everything that moved is re-exported from `@appliqation/agent-core`
(root barrel) and its subpaths (`/engine`, `/appq`, `/providers`, `/tools`, `/evidence`,
`/config`) — see that package's own source for exact contents. What stayed local, deliberately:
the **allowlist content** (`src/tools/safety.ts` — which tools each stage may touch is this
app's own domain knowledge; only the generic *enforcement mechanism*, `assertToolAllowed()`,
moved), and everything else that's genuinely autotest-specific (dry-run, browser-label
correction, screenshot-viewer, coverage policy, poll-results, `judgeTc.ts`'s orchestration,
CLI/output). Verified: full test suite green post-migration (84 tests, split across what
moved — now covered by `agent-core`'s own 205-test suite — and what stayed), `npx tsc --noEmit`
clean, and a live `judge --dry-run` regression run against real DailyPulse/appq data producing
the identical executor→evidence→validator→verdict flow as before the migration.

## Where to find what

**Local to this repo:**
- `src/cli/` — CLI entrypoints. `judge` (Phase 2 + 5, merged) runs one test case
  or a whole scenario, branching on whether `--test-case-uuid` is given. Single-TC mode:
  two genuinely separate `runWorkflow()` invocations — `appq:autotest-executor` then
  `appq:autotest-validator` — with a plain, non-LLM-mediated `update_run_results`
  `create_run` call in between if no `--run-id` is given. Whole-scenario mode: fetches
  `get_automation_readiness` once, applies `--coverage` per TC, calls `judgeTc()` (see
  `src/orchestrator/`) for the TCs that need agentic coverage, then polls
  `get_test_results` once for the full TC list — that single poll picks up both the
  deterministic pipeline's own results and whatever the validator already wrote itself, so
  no special-casing is needed between the two paths. Constructs one `McpClient` (via
  `createMcpClient()` from `@appliqation/agent-core`) near the top of the file and threads
  it down everywhere — the same "construct once, pass down" pattern already used for the
  executor/validator adapters.
- `src/orchestrator/` — `judgeTc.ts` (the executor→validator pair for one TC, factored out
  so `judge`'s two modes share exactly one implementation; takes an `McpClient` as an
  explicit param now, not a module-level import), `coveragePolicy.ts` (`always` /
  `on-script-absence` / `sampled:N` / `external` — never hardcoded, see the plan's
  "coverage decision"; `external` throws if selected without a decider function wired up —
  a deliberate hook for a future orchestrating agent, not a silent fallback),
  `pollResults.ts` (poll-until-settled against `get_test_results`, since the deterministic
  path is SQS-driven with no blocking/webhook API — also takes an `McpClient` param now).
- `src/tools/safety.ts` — **the one hardcoded, non-negotiable invariant that's local to
  this app**: which appq tools the executor/validator stages may each touch
  (`READONLY_APPQ_TOOLS`, `EXECUTOR_WRITE_TOOL`, `VALIDATOR_ONLY_APPQ_TOOLS`,
  `executorAllowedAppqTools()`/`validatorAllowedAppqTools()`). The enforcement mechanism
  itself (`assertToolAllowed()`, the gated-dispatcher factory) lives in
  `@appliqation/agent-core` now, shared with every sibling agent — only the allowlist
  *content* stays here, since it's specific to this app's executor/validator split.
- `src/tools/screenshotViewer.ts` — turns `get_execution_evidence`'s `screenshot_url` (a
  string in text, never actually seen by the model on its own) into a real vision input.
  Two modes, chosen by `--mandatory-image-check`/`MANDATORY_IMAGE_CHECK`, deliberately an
  orchestration/deployment setting and not something the workflow prompt controls: on-
  demand (model gets a `view_screenshot(step_index)` tool, decides for itself when text
  evidence isn't enough — most steps don't need it) or mandatory (every step's screenshot
  fetched and attached unconditionally, enforced in code before the model ever gets a
  turn — same reasoning as the destructive-action gate: don't rely on the model asking).
- `src/tools/dryRun.ts` — `--dry-run`'s enforcement point: intercepts
  `update_run_results`/`create_defect` calls and logs what would have been sent instead of
  sending it. A dispatch-level intercept, not a prompt instruction, same reasoning as the
  destructive-action gate — the validator's own workflow prose is what decides to write,
  so "don't write" has to be enforced below that, not asked of it.
- `src/tools/browserLabel.ts` — corrects create_defect's LLM-guessed bare `"Chromium"`
  browser value to the real `browser.version()`-derived label, in code rather than trusting
  the model to know something it has no runtime access to.
- `src/cli/output.ts` — `--json`/`--ci`'s renderer: a single structured `RunSummary` (one
  TC in single-TC mode, all of them in whole-scenario mode) either printed as JSON or as
  the human table, plus `exitCodeFor()` — non-zero whenever a non-dry-run result is
  `failed`/`blocked`/`pending` (poll-timeout), so a CI job can gate on the process exit
  code without scraping prose. Progress logs (`onEvent` → `console.error`) are untouched
  by this; it only changes the final-outcome rendering on stdout.
- `src/cli/audit.ts` — `recordJudgeRun()`, extracted out of `cli/index.ts` for the same
  testability reason as `cli/resolvers.ts`. One audit record per `judge` invocation
  regardless of mode (single-TC/whole-scenario/test-set all converge on the same
  `RunSummary` shape as `outcome`) — `cli/index.ts`'s whole action body is wrapped in a
  single `try/finally` (`summary` hoisted to a `let` the three modes assign into) so the
  write fires exactly once whichever branch runs, including the two "no test cases
  found" early returns (`summary` stays `undefined` there, recorded as a real, non-error
  outcome). `model` is a combined `executor:<model> validator:<model>` string, since
  this is the one agent in the family with two genuinely different models per run.
- `src/config/env.ts` — this app's own frozen `config` object + `resolveProvider()`/
  `resolveModel(role)`, built from `@appliqation/agent-core/config`'s shared `required()`/
  `optional()` primitives (a shared config *schema*/singleton was deliberately not built —
  each agent's `.env` shape is genuinely different). `auditSink` resolves
  `AUDIT_MONGO_*`/`AUDIT_JSONL_PATH` via `@appliqation/agent-core/audit`'s
  `resolveAuditSink()` — opt-in, no-op when unconfigured.

**In `@appliqation/agent-core`** (`~/Sites/localhost/appliqation-agent-core/`, imported as
`@appliqation/agent-core` and its subpaths) — the generic, workflow-agnostic core meant to
be reused by every sibling agent, not just this one:
- `/engine` — `loop.ts` (think→act→observe), `budget.ts` (call/page/time caps),
  `workflowRunner.ts` (fetches a named appq workflow and runs it through the loop as one
  fresh-context invocation — the same function backs each stage of `judge`; two calls to
  it with no shared `messages` array is the entire mechanism behind executor/validator
  isolation, nothing fancier). Takes an explicit `fetchPrompt` function now rather than
  importing one, so it has zero appq-specific coupling. Also what `appliqation-explorer`
  is built on for its own `appq:runman` invocation — see that repo's `CLAUDE.md`.
- `/appq` — `mcpClient.ts` (`createMcpClient({origin, apiKey})` factory: `fetchPrompt()`
  (`prompts/get` — pass the **full** name, e.g. `appq:runman`, not the short
  `start_workflow` name), `startWorkflow()`, `callTool()`, `listTools()`,
  `uploadScreenshot()`), `scenarioResolvers.ts` (`resolveScenarioId`/`fetchScenarioInfo`/
  `resolveUrl`/`resolveRun`, each taking an `McpClient` param — project_id/url are always
  derived, never accepted as separate inputs, see "Current phase" above for why;
  scenario_id is derived from the TC UUID in single-TC mode).
- `/providers` — official `@anthropic-ai/sdk`/`openai` adapters, model and max-tokens
  passed in (this app's own `config/env.ts`'s `resolveModel(role)` supplies them —
  separate overrides per provider AND per role, since judging captured evidence is closer
  to bounded classification than the executor's open-ended browser-driving planning; a
  cheaper/different model is a reasonable fit for the validator specifically, and a
  decorrelation lever against same-model self-grading risk). The Anthropic adapter also
  sets `cache_control` breakpoints (system prompt, tool defs, growing message history) —
  the workflow prompt and tool list are static and reused across every turn and every TC,
  and the full history gets resent every turn regardless, so caching is high-leverage
  here, not optional polish. Both adapters also handle `LlmMessage.images` on tool
  results — Anthropic inline in the `tool_result` block, OpenAI as a synthetic follow-up
  `input_image` message (the Responses API has no way to attach an image to a function
  output directly).
- `/tools` — `browserTools.ts` (Playwright-backed `browser_*` tool palette, ref-based via
  `page.ariaSnapshot({mode:'ai'})` + `aria-ref=` locators — no manual DOM injection;
  `PlaywrightBrowserTools`'s constructor takes optional `{onBeforeClick, screenshotSink}`
  hooks now, defaulting to the shared `classifyClick`/no-op respectively), `gatedDispatcher.ts`
  (`fetchAppqToolDefs()` filters `tools/list` to an allowlist for what's *offered* to the
  model; `createGatedAppqDispatcher()` is the actual enforcement point — it calls
  `assertToolAllowed()` before every dispatch, so a call outside the allowlist can't
  execute even if a model attempts it or a served prompt suggests it — the mechanism is
  shared, the allowlist content stays local to each agent, see `src/tools/safety.ts`
  above), `destructiveActionGate.ts` (`classifyClick` — the destructive-verb/mailto/tel/sms
  regex bank, checked before any click dispatches; genuinely universal, no appq coupling),
  `authState.ts` (`resolveStorageState()` — `judge --role <name>`'s implementation: reads
  the Playwright storageState `@appliqation/automation-sdk`'s `setupAuth({project_id,
  role})` resolves (`~/.appq-auth/` by default), fail-closed with an actionable error
  pointing at `npx appq-auth-setup` if it doesn't exist yet. Deliberately does not perform
  login or handle credentials itself — Appliqation already has a complete, human-reviewed
  mechanism for that, this is just one more reader of the same file every other runtime
  already agrees on. Resolved once per CLI invocation and threaded into `judgeTc.ts`'s
  executor browser context only — the validator never launches a browser. Credentials
  never reach this client or the LLM's own context; only the resulting session
  (cookies/localStorage) does, read directly from disk in code. `@appliqation/automation-sdk/utils`
  ships with no TypeScript declarations — `src/types/automation-sdk.d.ts` inside
  `agent-core` is a minimal ambient shim for just the functions actually used, kept in
  sync with the real source rather than guessed), `roleInference.ts` (per-TC role
  auto-detection for mixed-role scenarios, used when `--role` is omitted:
  `knownRolesForProject()` (env var scan for `APPQ_PROJECT_<id>_<ROLE>_USERNAME` — no new
  appq lookup needed, role names are UI-validated lowercase/no-spaces so the env var's role
  segment round-trips back exactly), `inferRole()` (tag/name precedence — explicit
  `role:<name>` tag > `role:anonymous`/"anonymous" in the name as an explicit
  unauthenticated signal > a known role's name appearing in the title > no match, run
  unauthenticated, not an error — mirrors the precedence already proven in production by
  `workers/automan-worker/src/services/AIScriptGenerator.js`'s `parseRoleFromTestcaseName()`,
  but deliberately never falls back to an LLM call, since role selection is a
  safety-adjacent decision kept deterministic like every other one in this codebase),
  `parseScenarioTcList()` (parses `get_scenario`'s TC list text — same text-coupling
  trade-off `fetchScenarioInfo()` already accepts for `Project ID: N`)).
- `/evidence` — `capture.ts` (`EvidenceCapture` — screenshot/console/network/accessibility-
  snapshot capture via native Playwright/CDP APIs, cursor-based delta reads).
- `/config` — `helpers.ts` (`required()`/`optional()` — the only two primitives shared;
  each agent still builds its own frozen `config` object from its own `.env` shape).

## Commands

- `npm run dev -- <command>` — run the CLI via `tsx` without building
- `npm run build` / `npm run typecheck`
- `npm test` / `npm run test:watch` — vitest, colocated `src/**/*.test.ts` files
- `npx tsx src/cli/index.ts judge --test-case-uuid <uuid> --environment <name>`
  — one TC. `--environment` is required (its URL is looked up, never taken directly);
  project_id/scenario_id are always derived, not accepted as options. Pass `--run-id` to
  reuse an existing run, `--dry-run` to suppress writeback, `--json`/`--ci` for a
  structured summary + CI-friendly exit code.
- `npx tsx src/cli/index.ts judge --scenario-id <id> --environment <name> [--coverage <policy>] [--dry-run] [--json|--ci]`
  — a whole scenario (no `--test-case-uuid`), consolidated report across every TC.
  `--project-id`/`--url` are still not options — always derived from `--scenario-id`.
- `npx tsx src/cli/index.ts judge --test-set-id <id> --environment <name> [--coverage <policy>] [--dry-run] [--json|--ci]`
  — every TC in a test set (regression/sanity/smoke — the common CI case), which can span
  multiple scenarios; one run per distinct scenario represented, consolidated report
  across all of them. `--run-id` is not supported in this mode.
- Add `--role <name>` to either form to force one role for every TC — see
  `@appliqation/agent-core`'s `tools/authState.ts` above. Omit it and per-TC role
  auto-detection kicks in instead (see its `tools/roleInference.ts`) — each TC's own
  tag/name decides its role, or it runs unauthenticated if none matches. Omit it entirely
  *and* have no `APPQ_PROJECT_<id>_*` env vars set and nothing changes at all for ungated
  projects.
- `.github/workflows/autotest.yml` — example CI wiring for `judge --dry-run --ci`; needs a
  dedicated appq service-account key (see the workflow's comments) that doesn't exist yet

## Config

Copy `.env.example` to `.env`. Requires `APPQ_API_KEY` and one of
`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`. `APPQ_ORIGIN` can point at the real origin now that
the appq-side tools are deployed there — only fall back to a local Lando instance if
testing against appq changes that haven't landed on `prod/iron` yet.

## Keeping this file current

When you add, remove, or rename a top-level file or a directory under `src/`, update the
map above in the same change. When a phase completes, update "Current phase" above.
