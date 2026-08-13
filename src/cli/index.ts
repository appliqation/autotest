#!/usr/bin/env node
// Phase 1 entrypoint: prove the engine against a workflow that already exists
// in production today (`runman`), with zero appq changes. Later phases add
// `judge` (Phase 2, the executor/validator pair) and `run` (Phase 5, the
// full-scenario router) as additional subcommands here.

import { Command } from 'commander';
import { chromium } from 'playwright';
import { config, resolveProvider } from '../config/env.js';
import { createAnthropicAdapter } from '../providers/anthropic.js';
import { createOpenAiAdapter } from '../providers/openai.js';
import { PlaywrightBrowserTools, BROWSER_TOOL_DEFS } from '../tools/browserTools.js';
import { READONLY_APPQ_TOOLS } from '../tools/safety.js';
import { fetchAppqToolDefs, dispatchAppqTool } from '../tools/appqTools.js';
import { runWorkflow } from '../engine/workflowRunner.js';
import type { ProviderAdapter, ToolDispatcher } from '../types.js';

function buildAdapter(): ProviderAdapter {
  const provider = resolveProvider();
  return provider === 'anthropic'
    ? createAnthropicAdapter(config.anthropicApiKey!)
    : createOpenAiAdapter(config.openaiApiKey!);
}

const program = new Command();
program
  .name('appliqation-autotest')
  .description('Standalone autonomous testing agent that executes Appliqation MCP workflows.');

program
  .command('runman')
  .description(
    'Phase 1 proof: run the existing, already-registered appq:runman workflow against a real target. ' +
      'Validates the engine (fetch, tool-calling loop, budget caps, safety gate) with zero appq changes.',
  )
  .requiredOption('--url <url>', 'target URL to explore')
  .option('--project-id <id>', 'appq project id, passed through to the runman prompt')
  .option('--prompt <text>', 'what to test/explore', 'Explore this page like a senior QA lead.')
  .action(async (opts: { url: string; projectId?: string; prompt: string }) => {
    const adapter = buildAdapter();
    const browser = await chromium.launch();
    const page = await browser.newPage();

    try {
      const browserTools = new PlaywrightBrowserTools(page);
      const appqToolDefs = await fetchAppqToolDefs(READONLY_APPQ_TOOLS);

      const dispatch: ToolDispatcher = async (name, args) => {
        if (name.startsWith('browser_')) return browserTools.dispatch(name, args);
        return dispatchAppqTool(name, args);
      };

      const result = await runWorkflow({
        source: { kind: 'appq', name: 'runman', args: { project_id: opts.projectId, site_url: opts.url, prompt: opts.prompt } },
        seedMessage: `Test intent: ${opts.prompt}\nURL under test: ${opts.url}\nBegin now — start with browser_snapshot.`,
        tools: [...BROWSER_TOOL_DEFS, ...appqToolDefs],
        dispatch,
        adapter,
        budget: config.budget,
        onEvent: (e) => {
          if (e.type === 'tool') {
            const d = e.detail as { name: string; result: string };
            console.error(`[tool] ${d.name} -> ${d.result.slice(0, 200)}`);
          } else if (e.type === 'log') {
            console.error(`[log] ${e.detail}`);
          }
        },
      });

      console.log('\n=== Report ===\n');
      console.log(result.report);
      console.error(`\n(${result.turns} turns, budget exceeded: ${result.budgetExceeded})`);
    } finally {
      await browser.close();
    }
  });

program.parseAsync(process.argv);
