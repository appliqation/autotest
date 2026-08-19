// Turns get_execution_evidence's screenshot_url (a string sitting in text,
// never actually seen by the model) into a real vision input. Two modes,
// both driven by orchestration config (see cli/index.ts's
// --mandatory-image-check), never by the workflow prompt itself:
//
//   - on-demand (default): the model gets a `view_screenshot(step_index)`
//     tool and decides for itself when text evidence (accessibility
//     snapshot, console/network deltas) isn't enough to judge a step —
//     most functional assertions don't need pixels at all.
//   - mandatory: every step's screenshot is fetched and attached inline the
//     moment get_execution_evidence returns, unconditionally. This is
//     enforced in code, not requested via the prompt — same reasoning as
//     the destructive-action gate: a "please look at every screenshot"
//     instruction depends on model compliance, an eager fetch doesn't.

import type { LlmImage, LlmToolDef, ToolResult } from '@appliqation/agent-core';

export const VIEW_SCREENSHOT_TOOL: LlmToolDef = {
  name: 'view_screenshot',
  description:
    "Load a specific step's screenshot as an actual image so you can visually inspect it. Use this when a " +
    "step's expected_result depends on something the accessibility snapshot and console/network deltas can't " +
    'establish on their own — colour, layout, visual rendering. Most functional assertions (element present, ' +
    'correct text, field has a value) are already verifiable from that text evidence and do not need this.',
  inputSchema: {
    type: 'object',
    properties: {
      step_index: { type: 'number', description: "The step to view, from get_execution_evidence's response" },
    },
    required: ['step_index'],
  },
};

interface EvidenceStep {
  step_index?: number;
  screenshot_url?: string | null;
}

async function fetchImageAsBase64(url: string): Promise<{ data: string; mimeType: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch screenshot: HTTP ${res.status}`);
  const mimeType = res.headers.get('content-type') || 'image/png';
  const buffer = Buffer.from(await res.arrayBuffer());
  return { data: buffer.toString('base64'), mimeType };
}

export class ScreenshotViewer {
  private stepUrls = new Map<number, string>();

  constructor(private readonly mandatory: boolean) {}

  /** Tool defs to add to the validator's palette — empty in mandatory mode, since there's nothing to ask for. */
  toolDefs(): LlmToolDef[] {
    return this.mandatory ? [] : [VIEW_SCREENSHOT_TOOL];
  }

  /** Wraps a dispatcher: handles view_screenshot itself, and intercepts get_execution_evidence to cache/attach. */
  wrapDispatch(
    inner: (name: string, args: Record<string, unknown>) => Promise<ToolResult>,
  ): (name: string, args: Record<string, unknown>) => Promise<ToolResult> {
    return async (name, args) => {
      if (name === 'view_screenshot') {
        return this.viewScreenshot(Number(args.step_index));
      }
      const result = await inner(name, args);
      if (name !== 'get_execution_evidence' || !result.ok) return result;
      return this.interceptEvidence(result);
    };
  }

  private async interceptEvidence(result: ToolResult): Promise<ToolResult> {
    let parsed: { steps?: EvidenceStep[] };
    try {
      parsed = JSON.parse(result.text);
    } catch {
      return result;
    }
    const steps = parsed.steps ?? [];
    for (const step of steps) {
      if (typeof step.step_index === 'number' && step.screenshot_url) {
        this.stepUrls.set(step.step_index, step.screenshot_url);
      }
    }

    if (!this.mandatory) return result;

    const images: LlmImage[] = [];
    for (const step of steps) {
      if (typeof step.step_index !== 'number' || !step.screenshot_url) continue;
      try {
        const img = await fetchImageAsBase64(step.screenshot_url);
        images.push({ ...img, label: `step ${step.step_index} screenshot` });
      } catch {
        // Non-fatal — the step's text evidence (accessibility snapshot,
        // console/network) still stands on its own; one screenshot failing
        // to load shouldn't fail the whole evidence fetch.
      }
    }
    return { ...result, images };
  }

  private async viewScreenshot(stepIndex: number): Promise<ToolResult> {
    const url = this.stepUrls.get(stepIndex);
    if (!url) {
      return {
        ok: false,
        text: `No screenshot URL known for step ${stepIndex} — call get_execution_evidence first.`,
      };
    }
    try {
      const img = await fetchImageAsBase64(url);
      return {
        ok: true,
        text: `Screenshot for step ${stepIndex} attached below.`,
        images: [{ ...img, label: `step ${stepIndex} screenshot` }],
      };
    } catch (err) {
      return { ok: false, text: `Failed to load screenshot for step ${stepIndex}: ${(err as Error).message}` };
    }
  }
}
