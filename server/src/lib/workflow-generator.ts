/**
 * AI-assisted workflow generator.
 * Takes a natural language description and produces a structured V2 workflow
 * graph using an LLM (Anthropic or OpenAI).
 */

export interface GeneratedStep {
  name: string;
  description: string;
  executorType: 'claude-code' | 'quality-gate' | 'connector' | 'command';
  config: Record<string, unknown>;
  /** Indices into the parent steps array (0-based). Linear only — max 1 entry. */
  dependsOn: number[];
  autoAdvance: boolean;
}

export interface GeneratedWorkflow {
  name: string;
  description: string;
  steps: GeneratedStep[];
}

const SYSTEM_PROMPT = `You are a workflow architect for NeonCore, an AI agent orchestration platform.
Given a task description, produce a V2 workflow as JSON.

EXECUTOR TYPES:
- "claude-code": Sends a natural language prompt to an AI coding agent. config: { role, prompt, includeDepOutput }
  Roles: researcher, architect, backend, frontend, tester, reviewer, planner, general, performance
- "quality-gate": Runs automated checks. config: { gateType, includeDepOutput }
  Gate types: test, security, full-review
- "connector": External integration. config: { connectorType, ... }
  Connector types: system-notify (title, message), http (httpUrl, httpMethod, httpBodyTemplate)
- "command": Shell command. config: { command }

RULES:
1. Return ONLY valid JSON — no markdown, no prose, no code fences.
2. Steps MUST be linear — each step depends on at most the single previous step.
   dependsOn is an array of step indices (0-based). First step always has dependsOn: [].
3. Maximum 8 steps total.
4. Always end with a system-notify connector step.
5. Use __deferred__ as executorId for claude-code and quality-gate steps (agent assigned at run time).
6. For claude-code steps, set includeDepOutput: true and loopCount: 1.
7. The prompt field in claude-code config should be a brief role instruction; the step description carries details.
8. autoAdvance: false only for human-review steps; true for all others.

OUTPUT FORMAT (strict JSON, no other text):
{
  "name": "Short workflow name",
  "description": "One-line description",
  "steps": [
    {
      "name": "Step Name",
      "description": "What this step does",
      "executorType": "claude-code",
      "config": { "role": "researcher", "includeDepOutput": true, "loopCount": 1, "prompt": "" },
      "dependsOn": [],
      "autoAdvance": true
    }
  ]
}

EXAMPLE for "review code and fix bugs":
{
  "name": "Code Review & Bug Fix",
  "description": "Review codebase, identify bugs, fix them, verify tests pass.",
  "steps": [
    { "name": "Code Review", "description": "Audit the codebase for bugs, issues, and improvements.", "executorType": "claude-code", "config": { "role": "reviewer", "includeDepOutput": true, "loopCount": 1, "prompt": "" }, "dependsOn": [], "autoAdvance": true },
    { "name": "Implement Fixes", "description": "Apply fixes for all identified issues.", "executorType": "claude-code", "config": { "role": "backend", "includeDepOutput": true, "loopCount": 1, "prompt": "" }, "dependsOn": [0], "autoAdvance": true },
    { "name": "Run Tests", "description": "Execute all tests and verify fixes pass.", "executorType": "quality-gate", "config": { "gateType": "test", "includeDepOutput": true }, "dependsOn": [1], "autoAdvance": true },
    { "name": "Notify", "description": "Send completion notification.", "executorType": "connector", "config": { "connectorType": "system-notify", "title": "Code Review & Bug Fix — Done", "message": "{{workflowName}} completed." }, "dependsOn": [2], "autoAdvance": true }
  ]
}`;

function validateAndClamp(raw: unknown): GeneratedWorkflow {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('LLM returned non-object response');
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.name !== 'string' || !obj.name.trim()) throw new Error('Generated workflow missing name');
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) throw new Error('Generated workflow has no steps');

  const VALID_EXECUTOR_TYPES = new Set(['claude-code', 'quality-gate', 'connector', 'command']);

  // Clamp to 8 steps
  const rawSteps = (obj.steps as unknown[]).slice(0, 8);

  const steps: GeneratedStep[] = rawSteps.map((s, i) => {
    if (typeof s !== 'object' || s === null) throw new Error(`Step ${i} is not an object`);
    const step = s as Record<string, unknown>;

    const executorType = step.executorType as string;
    if (!VALID_EXECUTOR_TYPES.has(executorType)) {
      throw new Error(`Step ${i} has invalid executorType: "${executorType}"`);
    }

    // Ensure dependsOn is linear: at most 1 entry, and it must be a valid prior index
    let dependsOn: number[] = [];
    if (Array.isArray(step.dependsOn)) {
      dependsOn = (step.dependsOn as number[])
        .filter((d) => typeof d === 'number' && d >= 0 && d < i)
        .slice(0, 1); // keep at most 1
    }

    return {
      name: (step.name as string) || `Step ${i + 1}`,
      description: (step.description as string) || '',
      executorType: executorType as GeneratedStep['executorType'],
      config: (typeof step.config === 'object' && step.config !== null ? step.config : {}) as Record<string, unknown>,
      dependsOn,
      autoAdvance: step.autoAdvance !== false,
    };
  });

  // Ensure last step is a system-notify connector
  const last = steps[steps.length - 1];
  const isNotify = last.executorType === 'connector' &&
    (last.config as Record<string, unknown>).connectorType === 'system-notify';

  if (!isNotify) {
    const prevIdx = steps.length - 1;
    steps.push({
      name: 'Notify',
      description: 'Send completion notification.',
      executorType: 'connector',
      config: {
        connectorType: 'system-notify',
        title: `${(obj.name as string)} — Done`,
        message: '{{workflowName}} completed.',
      },
      dependsOn: [prevIdx],
      autoAdvance: true,
    });
  }

  return {
    name: (obj.name as string).trim(),
    description: typeof obj.description === 'string' ? obj.description.trim() : '',
    steps,
  };
}

async function callAnthropic(description: string, apiKey: string): Promise<GeneratedWorkflow> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: description }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as { content: { type: string; text: string }[] };
  const text = data.content?.find((c) => c.type === 'text')?.text || '';
  if (!text) throw new Error('Anthropic returned empty response');

  // Strip any accidental markdown fences
  const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(`LLM returned non-JSON response: ${jsonText.slice(0, 200)}`);
  }
  return validateAndClamp(parsed);
}

async function callOpenAI(description: string, apiKey: string): Promise<GeneratedWorkflow> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: description },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI API error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as { choices: { message: { content: string } }[] };
  const text = data.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('OpenAI returned empty response');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`LLM returned non-JSON response: ${text.slice(0, 200)}`);
  }
  return validateAndClamp(parsed);
}

async function callGridlight(description: string, gatewayUrl: string, model: string): Promise<GeneratedWorkflow> {
  const base = gatewayUrl.replace(/\/$/, '');
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: description },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gridlight API error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as { choices: { message: { content: string } }[] };
  const text = data.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('Gridlight returned empty response');

  const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(`LLM returned non-JSON response: ${jsonText.slice(0, 200)}`);
  }
  return validateAndClamp(parsed);
}

export async function generateWorkflow(
  description: string,
  options: { provider: 'anthropic'; apiKey: string }
        | { provider: 'openai'; apiKey: string }
        | { provider: 'gridlight'; gatewayUrl: string; model: string },
): Promise<GeneratedWorkflow> {
  if (!description.trim()) throw new Error('description is required');

  if (options.provider === 'gridlight') return callGridlight(description, options.gatewayUrl, options.model);
  if (options.provider === 'anthropic') return callAnthropic(description, options.apiKey);
  return callOpenAI(description, options.apiKey);
}
