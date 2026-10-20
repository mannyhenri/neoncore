import { reportStepConfig, WORKFLOW_REPORT_PROMPT, RUN_ID_PLACEHOLDER } from './workflow-report.js';

export const GRIDLIGHT_QA_TEMPLATE_NAMES = [
  'Gridlight Local QA',
  'Gridlight Full Release QA',
] as const;

const models = [
  ['qwen3-coder-30b-a3b-q4', 'Qwen3-Coder 30B-A3B Q4'],
  ['lfm2.5-2.6b-q4', 'LiquidAI LFM2.5 2.6B Q4'],
  ['gpt-oss-20b-q4', 'gpt-oss 20B Q4'],
  ['gemma3-4b-q4', 'Gemma 3 4B Q4'],
  ['qwen2.5-7b-q4', 'Qwen2.5 7B Q4 — release baseline'],
  ['qwen2.5-1.5b-fp16', 'Qwen2.5 1.5B FP16'],
  ['qwen2.5-1.5b-q8', 'Qwen2.5 1.5B Q8'],
  ['qwen2.5-1.5b-q4_0', 'Qwen2.5 1.5B Q4_0'],
  ['qwen2.5-1.5b-q5_0', 'Qwen2.5 1.5B Q5_0'],
  ['qwen2.5-1.5b-q4', 'Qwen2.5 1.5B Q4 — quick baseline'],
  ['qwen2.5-1.5b-q6_k', 'Qwen2.5 1.5B Q6_K'],
  ['qwen2.5-1.5b-iq4_xs', 'Qwen2.5 1.5B IQ4_XS'],
  ['qwen2.5-1.5b-q2_k', 'Qwen2.5 1.5B Q2_K'],
  ['qwen2.5-coder-7b-q4', 'Qwen2.5 Coder 7B Q4'],
  ['mistral-7b-v0.3-q4', 'Mistral 7B v0.3 Q4'],
  ['phi3-mini-4k-q4', 'Phi-3 Mini 4K Q4'],
].map(([value, label]) => ({ value, label }));

const engines = [
  { value: 'gridlight', label: 'Gridlight only' },
  { value: 'gridlight,llama', label: 'Gridlight → llama.cpp' },
  { value: 'gridlight,vllm', label: 'Gridlight → vLLM' },
  { value: 'gridlight,llama,vllm', label: 'Gridlight → llama.cpp → vLLM' },
];

const yesNo = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];

const mediaAgents = [
  ['image', 'Image'], ['audio', 'Audio'], ['video', 'Video'], ['3d', '3D'],
  ['stt', 'Speech to text'], ['voice', 'Voice'], ['stem-split', 'Stem split'],
].map(([value, label]) => ({ value, label }));

const baseOptionGroups = (modelDefault: string) => ({
  run: [
    { key: 'modelProfile', label: 'Model profile', type: 'select', defaultValue: modelDefault,
      flag: '--model-profile', choices: models },
    { key: 'engines', label: 'Engines', type: 'select', defaultValue: 'gridlight',
      flag: '--engines', choices: engines },
    { key: 'metrics', label: 'Capture metrics', type: 'select', defaultValue: 'yes',
      flag: '--metrics', choices: yesNo },
    { key: 'manager', label: 'Post to Gridlight Manager', type: 'select', defaultValue: 'no',
      flag: '--manager', choices: yesNo },
  ],
  environment: [
    { key: 'mediaAgents', label: 'Rebuild media agents', type: 'multi-select', defaultValue: [],
      flag: '--media-agents', joinWith: ',', emptyValue: 'none', choices: mediaAgents,
      description: 'Gateway and the LLM agent are handled by the script; choose only optional media images.' },
    { key: 'envFile', label: 'Environment file', type: 'text', defaultValue: '', flag: '--env-file',
      placeholder: '~/.config/gridlight/qa.env', description: 'Leave blank to use the script default.' },
  ],
});

const releaseBaseOptions = baseOptionGroups('qwen2.5-7b-q4');

/** The guided-local-run.sh option set. The performance workflow reuses it with a 7B default. */
const localQaOptions = (modelDefault: string) => {
  const localBaseOptions = baseOptionGroups(modelDefault);
  return [
  ...localBaseOptions.run,
  { key: 'downloadModel', label: 'Download missing model', type: 'boolean', defaultValue: false,
    enabledArgs: ['--download-model'] },
  { key: 'syncComparators', label: 'Update comparator sources', type: 'boolean', defaultValue: false,
    enabledArgs: ['--sync-comparators'] },
  { key: 'build', label: 'Rebuild local binaries', type: 'select', defaultValue: 'yes',
    flag: '--build', choices: yesNo },
  ...localBaseOptions.environment,
  { key: 'backend', label: 'Gridlight backend', type: 'text', defaultValue: 'metal', flag: '--backend',
    description: 'For example metal, cuda, rocm, or cpu.' },
  { key: 'quick', label: 'Quick iteration pass', type: 'boolean', defaultValue: false,
    enabledArgs: ['--quick'] },
  ];
};

const GRIDLIGHT_LOCAL_QA_OPTIONS = localQaOptions('qwen2.5-1.5b-q8');

const GRIDLIGHT_RELEASE_QA_OPTIONS = [
  { key: 'scope', label: 'Run scope', type: 'select', defaultValue: 'build-and-qa', choices: [
    { value: 'build-and-qa', label: 'Build and QA', args: [] },
    { value: 'build-only', label: 'Build only', args: ['--build-only'] },
    { value: 'qa-only', label: 'QA existing artifacts', args: ['--qa-only'] },
  ] },
  ...releaseBaseOptions.run,
  { key: 'cacheS3', label: 'Immutable model cache', type: 'text', defaultValue: '', flag: '--cache-s3',
    placeholder: 's3://bucket/prefix' },
  ...releaseBaseOptions.environment,
  { key: 'dryRun', label: 'Dry run', type: 'boolean', defaultValue: false, enabledArgs: ['--dry-run'],
    description: 'Print the full flow without building, installing, or provisioning.' },
  { key: 'flavours', label: 'Install flavours', type: 'multi-select',
    defaultValue: ['deb', 'rpm', 'helm', 'docker'], flag: '--flavours', joinWith: ' ', required: true, choices: [
      { value: 'deb', label: 'DEB' }, { value: 'rpm', label: 'RPM' },
      { value: 'helm', label: 'Helm' }, { value: 'docker', label: 'Docker' },
    ] },
  { key: 'buildLocation', label: 'Build location', type: 'select', defaultValue: 'provision', choices: [
    { value: 'provision', label: 'Provision AWS compute host', args: ['--provision-build'] },
    { value: 'existing', label: 'Use an existing SSH host', args: [] },
  ], description: 'Full release images require AWS or another remote build host; the script\'s local-build escape hatch cannot complete the image phase.' },
  { key: 'buildHost', label: 'Existing build host', type: 'text', defaultValue: '', flag: '--build-host',
    placeholder: 'ubuntu@host', required: true, visibleWhen: { key: 'buildLocation', value: 'existing' } },
  { key: 'qaLocation', label: 'QA location', type: 'select', defaultValue: 'provision', choices: [
    { value: 'provision', label: 'Provision AWS GPU host', args: ['--provision-qa'] },
    { value: 'local', label: 'QA on this Linux cartridge', args: ['--local-qa'] },
    { value: 'existing', label: 'Use a reset and verified SSH host', args: [], env: { QA_ALLOW_REUSED_HOST: '1' } },
  ] },
  { key: 'qaHost', label: 'Existing QA host', type: 'text', defaultValue: '', flag: '--qa-host',
    placeholder: 'ubuntu@host', required: true, visibleWhen: { key: 'qaLocation', value: 'existing' } },
  { key: 'keep', label: 'Keep provisioned AWS instances', type: 'boolean', defaultValue: false,
    enabledArgs: ['--keep'], description: 'Leaves billable instances running and reports their IDs.' },
];

const scriptPrompt = (output: string, fallbackCommand: string) => `Run the Gridlight QA script configured at launch.

When the launch context above contains a RESOLVED COMMAND assembled from choices made in NeonCore, execute that exact command from the repository root. If this workflow was started from a surface that cannot collect launch choices and no RESOLVED COMMAND is present, execute this declared default instead: \`${fallbackCommand}\`. Do not enter guided mode or change the selected flags. Stream meaningful progress while it runs and let the real exit code determine PASS or FAIL.

The script writes its durable evidence under \`${output}\`. At the end report: the exact command, exit code, newest run directory, summary/report files produced, pass/fail counts, and any cleanup warning (especially an AWS instance left running). Do not summarize a failed assertion as a pass.`;

const customReportPrompt = (kind: 'local' | 'release') => {
  const specific = kind === 'local'
    ? `This is a GRIDLIGHT LOCAL QA report. Read the newest output/qa-local run created by the dependency step. The visible scorecard must include the selected model and compatibility status, backend, engine order, build/media choices, every engine result, test/assertion counts, latency/throughput/concurrency metrics when captured, comparator fairness notes, artifact paths, and Manager-post status. Put per-engine metrics in a comparison table; never compare unlike model formats as if they were bit-identical.`
    : `This is a GRIDLIGHT FULL RELEASE QA report. Read the newest output/qa-release run and dist-linux evidence created by the dependency step. The visible scorecard must include commit/version, build-versus-QA scope, every selected install flavour, model and engine order, artifact/checksum and image results, per-flavour QA assertions, active backend/hardware, AWS build and QA hosts, teardown status, Manager-post status, and any instance deliberately kept or left billing. A dry run is DRY RUN, never SUCCESSFUL RELEASE QA.`;
  return `${specific}

This template's deliverable is that scorecard as ONE self-contained HTML file at \`.neoncore/reports/${RUN_ID_PLACEHOLDER}/scorecard.html\`, opened once: selection summary first, then a compact PASS/FAIL matrix, measured metrics/artifacts, failures and cleanup. Then return the run JSON below as well.

${WORKFLOW_REPORT_PROMPT}`;
};

const LOCAL_DEFAULT_COMMAND = 'scripts/qa/guided-local-run.sh --non-interactive --model-profile qwen2.5-1.5b-q8 --engines gridlight --metrics yes --manager no --build yes --media-agents none --backend metal';
const RELEASE_DEFAULT_COMMAND = "scripts/qa/full-release-run.sh --model-profile qwen2.5-7b-q4 --engines gridlight --metrics yes --manager no --media-agents none --flavours 'deb rpm helm docker' --provision-build --provision-qa";

interface GridlightQaTemplateDefinition {
  name: typeof GRIDLIGHT_QA_TEMPLATE_NAMES[number];
  description: string;
  scriptStepName: string;
  scriptDescription: string;
  scriptConfig: Record<string, unknown>;
  reportConfig: Record<string, unknown>;
}

export const GRIDLIGHT_QA_TEMPLATES: readonly GridlightQaTemplateDefinition[] = [
  {
    name: 'Gridlight Local QA',
    description: 'Runs the guided local Gridlight/model/comparator QA suite with selected options, then renders a purpose-built HTML comparison report.',
    scriptStepName: 'Run Local QA',
    scriptDescription: 'Build and test the selected local Gridlight configuration.',
    scriptConfig: {
      role: 'tester', includeDepOutput: true, systemPromptMode: 'free', systemPrompt: '', loopCount: 1,
      launchScript: 'scripts/qa/guided-local-run.sh', launchFixedArgs: ['--non-interactive'],
      launchOptions: GRIDLIGHT_LOCAL_QA_OPTIONS,
      launchDefaultCommand: LOCAL_DEFAULT_COMMAND,
      prompt: scriptPrompt('output/qa-local/<timestamp>/', LOCAL_DEFAULT_COMMAND),
    },
    reportConfig: { ...reportStepConfig(), reportVariant: 'gridlight-qa', reportPromptManaged: false,
      prompt: customReportPrompt('local') },
  },
  {
    name: 'Gridlight Full Release QA',
    description: 'Builds and qualifies the selected Gridlight release surfaces, including disposable AWS hosts when chosen, then renders a purpose-built HTML release report.',
    scriptStepName: 'Run Full Release QA',
    scriptDescription: 'Build release artifacts and qualify the selected installation surfaces.',
    scriptConfig: {
      role: 'tester', includeDepOutput: true, systemPromptMode: 'free', systemPrompt: '', loopCount: 1,
      launchScript: 'scripts/qa/full-release-run.sh', launchFixedArgs: [],
      launchOptions: GRIDLIGHT_RELEASE_QA_OPTIONS,
      launchDefaultCommand: RELEASE_DEFAULT_COMMAND,
      prompt: scriptPrompt('output/qa-release/<timestamp>/', RELEASE_DEFAULT_COMMAND),
    },
    reportConfig: { ...reportStepConfig(), reportVariant: 'gridlight-qa', reportPromptManaged: false,
      prompt: customReportPrompt('release') },
  },
] as const;

// ── Gridlight Performance Improvement ─────────────────────────────────────────────────
//
// Jira task → numeric target written BEFORE coding → develop → local QA on the 7B model →
// met: HTML report + Jira Done; not met: gap + suggestions → a human approves the next round.
//
// THE LOOP IS THE QUALITY GATE'S RETRY, NOT A ROUTING RULE. applyRoutingRules resets one target
// step and leaves everything after it `completed`, so routing "back to Develop" would re-run
// Develop and never re-run the QA script. processQualityGateResult's FAIL path resets the gate
// AND every one of its direct dependencies, so "Targets Met?" depends on exactly the loop body:
// the approval decision, develop, QA and compare. On FAIL all four go back to pending; the
// decision is the first of them to become ready (it depends only on the written target), so the
// next round cannot start until a human approves it. maxRetries 2 = at most 3 rounds.
//
// The decision is inside the loop, so it also runs before round 1 — nothing in the engine can
// skip a decision step conditionally. Round 1's approval is of the target and plan.
//
// Launch context (the Jira key and the RESOLVED COMMAND) reaches ONLY the first step
// (workflow-context.ts), so "Load Jira Task" echoes both as TICKET:/QA COMMAND: lines and the
// steps that need them depend on it directly.

export const GRIDLIGHT_PERF_TEMPLATE_NAME = 'Gridlight Performance Improvement' as const;

export const PERF_QA_DEFAULT_COMMAND = 'scripts/qa/guided-local-run.sh --non-interactive --model-profile qwen2.5-7b-q4 --engines gridlight --metrics yes --manager no --build yes --media-agents none --backend metal';

export const GRIDLIGHT_PERF_TEMPLATE_DESCRIPTION = 'Put the Jira ticket key in the launch context. Reads the ticket, writes a numeric performance target (baseline, target, how measured) before coding, develops test-first, runs the local QA script on the 7B model and compares against the target. Met: HTML report and the Jira task marked Done. Not met: the gap and suggested improvements, and you approve each further round (max 3).';

export interface PerfTemplateStep {
  key: string;
  name: string;
  description: string;
  type: 'claude-code' | 'decision' | 'quality-gate';
  config: Record<string, unknown>;
  deps: string[];
}

const cc = (role: string, prompt: string, extra: Record<string, unknown> = {}) => ({
  role, includeDepOutput: true, systemPromptMode: 'free', systemPrompt: '', loopCount: 1, ...extra, prompt,
});

const LOAD_PROMPT = `The Jira ticket key for this run is in the launch Context above (for example GRD-123). If there is no ticket key there, STOP and say so — do not guess one.

1. Read the ticket in Jira with the Atlassian MCP (getJiraIssue): summary, description, acceptance criteria, linked issues, and ALL comments. Comments often carry the real numbers and constraints — read every one.
2. Confirm you are at the Gridlight repository root (\`git rev-parse --show-toplevel\`).
3. Record the QA command. If the launch Context contains a RESOLVED COMMAND block, copy that exact command. Otherwise use the declared default: \`${PERF_QA_DEFAULT_COMMAND}\`.
4. Write \`docs/benchmarks/<TICKET>/run.md\` with the ticket key, summary, the QA command and today's date.

Your output MUST start with these lines, exactly (later steps read them — only this step sees the launch context):
\`\`\`
TICKET: <KEY>
QA COMMAND: <the exact command>
REPO: <absolute repo path>
\`\`\`
Then: ## Ticket summary · ## What it asks for, performance-wise · ## Comments that matter · ## Constraints (correctness, memory, platforms).`;

const TARGET_PROMPT = `Write the expected performance improvement BEFORE any development. Do not change any production code in this step.

1. Pick the metrics this ticket should move — only the relevant ones — e.g. tok/s at c=8/16/32, TTFT (p50/p95), per-step ms, peak memory.
2. BASELINE for each, on the current unchanged code with the same model profile: cite a trustworthy existing output/qa-local run for this commit, or run the QA COMMAND from the Load Jira Task output once. Name the file each baseline number came from.
3. TARGET for each: a numeric value and the % change from baseline, with direction. "Faster" is not a target; every target is concrete and numeric.
4. HOW MEASURED: the command, the output file and field each number is read from, runs per measurement, and the noise band you will treat as no change.
5. EXPECTED RESULT: what should be observably different when this lands.

Write \`docs/benchmarks/<TICKET>/target.md\` (table: Metric | Baseline | Target | Change | Measured by | Source) and \`docs/benchmarks/<TICKET>/plan.md\` (the intended approach). Create \`docs/benchmarks/<TICKET>/results.md\` fresh with only a "# Results — <TICKET>" header — every run starts from round 1.

The targets in target.md are the contract for this whole run: later steps judge against that file, not against what was built. They change only if the user explicitly amends them.

Output: the TICKET line, the target table, and the three file paths.`;

const DEVELOP_PROMPT = `Read the decision in "Approve Development Round" above (its optionId).

IF "stop" or "accept-done": output exactly "ROUND SKIPPED — user chose <optionId>." and change nothing.

IF "revise": use AskUserQuestion to ask the user what to change in the approach. Rewrite docs/benchmarks/<TICKET>/plan.md with their changes. Leave target.md's numbers alone unless the user explicitly amends a target — then record the amendment and their reason under "## Amendments" in target.md. Then develop as for "continue".

IF "continue": implement plan.md (round 1) or the QUALITY GATE FEEDBACK appended below, which carries the measured gap and the suggested improvements the user just approved (later rounds). Follow the repo's work standard:
1. Write the failing test first — correctness always, and a focused micro-benchmark where the change is measurable in isolation. Watch it fail.
2. Implement. Keep the change to what the plan or the approved suggestions call for.
3. Run the relevant test suites and paste the real output. Never weaken or delete a test to get green.
4. Commit with the ticket key in the message.

Do NOT run the full QA script here — the next step does that. Report: files and commits changed, tests run (with output), and the effect you expect on each metric in target.md.`;

const QA_PROMPT = `Measure this round with the Gridlight local QA script on the 7B model.

If the Develop Improvement output says "ROUND SKIPPED", run nothing: output "QA SKIPPED — <the reason given>".

Otherwise execute, from the repository root, the exact command on the \`QA COMMAND:\` line of the Load Jira Task output — it is the RESOLVED COMMAND chosen in NeonCore's launch form. If that line is missing, run the declared default: \`${PERF_QA_DEFAULT_COMMAND}\`. Do not enter guided mode or change flags. Stream meaningful progress, and let the real exit code decide PASS or FAIL.

Evidence lands under \`output/qa-local/<timestamp>/\`. Report: the exact command, exit code, newest run directory, summary files, pass/fail counts, and EVERY measured value relevant to docs/benchmarks/<TICKET>/target.md (tok/s at each concurrency, TTFT, per-step ms, memory) with the file each came from. Do not summarize a failed assertion as a pass.

Do not modify code in this step. Any QUALITY GATE FEEDBACK appended below is for the Develop step — ignore it here.`;

const COMPARE_PROMPT = `Judge this round against docs/benchmarks/<TICKET>/target.md — the targets written before development — never against the implementation report.

IF the Develop Improvement output says "ROUND SKIPPED": the decision optionId decides — "stop" → VERDICT: STOPPED, "accept-done" → VERDICT: ACCEPTED. Restate the latest measured numbers from results.md (if any round ran) and skip the rest.

Otherwise:
1. ROUND N = the number of "## Round" headings already in docs/benchmarks/<TICKET>/results.md, plus 1.
2. For EVERY metric in target.md: baseline, target, measured (read from this round's QA output files, not from memory), change vs baseline, MET or MISSED. A metric the QA run did not capture is MISSED, never assumed.
3. If the QA script failed (non-zero exit or failed assertions), the round is NOT MET whatever the speed — a faster wrong answer is not an improvement.
4. If any target is missed: the gap for each (in the metric's units and in %), then concrete suggested further improvements ranked by expected impact — each naming the code area, the mechanism, the expected gain and how it will be measured. These suggestions are what the user approves for the next round, so make them specific enough to implement.
5. Append "## Round N" to results.md: the table, the verdict, the suggestions.

End your output with exactly these two lines:
VERDICT: MET | VERDICT: NOT MET | VERDICT: STOPPED | VERDICT: ACCEPTED   (one of them)
ROUND: N`;

const GATE_PROMPT = `You are the loop gate for a Gridlight performance round. Read the "Compare Against Target" output and docs/benchmarks/<TICKET>/results.md and target.md. Do not implement anything and do not re-measure.

Your FIRST LINE must be exactly PASS or FAIL:
- VERDICT: MET → PASS — but check the table against target.md first. If Compare claimed MET while any metric is missed or unmeasured, treat it as NOT MET.
- VERDICT: STOPPED or VERDICT: ACCEPTED → PASS — the user ended the loop.
- VERDICT: NOT MET on round 3 (ROUND: 3, or three "## Round" sections in results.md) → PASS, with "ROUND LIMIT REACHED — targets not met" on the second line. 3 rounds is the limit; the report is written and the Jira task is NOT marked Done.
- VERDICT: NOT MET before round 3 → FAIL.

After a FAIL, write the gap per metric and the ranked suggested improvements. That text is handed to the next Develop round, and the user reads it before approving that round.`;

const REPORT_PROMPT = `Write the final performance report as ONE self-contained HTML file at docs/benchmarks/<TICKET>/report.html (inline CSS, no external assets, readable in light and dark mode).

In this order:
1. Header: ticket key and summary, and the outcome — TARGETS MET · NOT MET — STOPPED BY USER · NOT MET — ACCEPTED AS DONE · NOT MET — ROUND LIMIT REACHED (from the final VERDICT and the gate result).
2. Baseline vs target vs measured: one row per metric, with change vs baseline and MET/MISSED, one column group per round.
3. QA summary: command, model profile, exit code, pass/fail counts, run directory of every round.
4. What changed: the approach, commits and files for each round.
5. If not met: the remaining gap and the suggested next improvements.

Every number comes from target.md, results.md and the QA run files — never from memory. Output the report path and the outcome line.`;

const DONE_PROMPT = `Update the Jira task (the TICKET line of the Load Jira Task output) according to the final VERDICT line of "Compare Against Target":

- VERDICT: MET → transition the issue to Done with the Atlassian MCP (getTransitionsForJiraIssue to find the Done transition, then transitionJiraIssue). Add a comment with baseline → target → measured for each metric and the report path.
- VERDICT: ACCEPTED → the user explicitly approved stopping as done: transition to Done the same way. The comment must say the targets were NOT met and the user accepted the result, with the numbers.
- Any other verdict (NOT MET, STOPPED): do NOT transition the issue. Add a comment with the measured results, the gap and the report path, and output "NOT MARKED DONE — <reason>".

Never transition on anything but those two verdicts. After a transition, re-read the issue and report its actual status.`;

export const GRIDLIGHT_PERF_STEPS: readonly PerfTemplateStep[] = [
  { key: 'load', name: 'Load Jira Task', type: 'claude-code', deps: [],
    description: 'Read the Jira ticket named in the launch context, including every comment, and record the QA command.',
    config: cc('researcher', LOAD_PROMPT) },
  { key: 'target', name: 'Write Performance Target', type: 'claude-code', deps: ['load'],
    description: 'Before coding: metric, baseline, numeric target and how it is measured, saved to docs/benchmarks/<ticket>/target.md.',
    config: cc('architect', TARGET_PROMPT) },
  { key: 'decide', name: 'Approve Development Round', type: 'decision', deps: ['target'],
    description: 'You approve every development round: the plan before round 1, the suggested improvements after a missed target.',
    config: {
      question: 'Approve the next development round for this performance target?',
      eli10: 'Round 1: read "Write Performance Target" — the targets and plan in docs/benchmarks/<ticket>/. Later rounds: the targets were NOT met; read "Compare Against Target" for the measured gap and the suggested improvements, and "Targets Met?" for the verdict. Nothing is developed until you choose.',
      stakes: 'Each round rebuilds Gridlight and re-runs the 7B QA suite. At most 3 rounds run, then the workflow reports and stops. Only "Accept current result and mark Done" marks the Jira task Done without meeting the targets.',
      recommendation: 'continue',
      options: [
        { id: 'continue', label: 'Continue with these improvements', description: 'Develop the plan (round 1) or the suggested improvements (later rounds), test-first, then re-run the 7B QA.' },
        { id: 'revise', label: 'Revise the plan', description: 'The developer asks what to change in the approach, rewrites plan.md, then develops it. The numeric targets stay fixed.' },
        { id: 'stop', label: 'Stop here', description: 'No more development. The report records where things stand; the Jira task is NOT marked Done.' },
        { id: 'accept-done', label: 'Accept current result and mark Done', description: 'Stop and mark the Jira task Done even though the targets are not met. The report records the shortfall.' },
      ],
    } },
  { key: 'develop', name: 'Develop Improvement', type: 'claude-code', deps: ['decide', 'target'],
    description: 'Implement the plan or the approved improvements, test-first, per the work standard.',
    config: cc('backend', DEVELOP_PROMPT) },
  { key: 'qa', name: 'Run Local QA (7B)', type: 'claude-code', deps: ['develop', 'load'],
    description: 'Run scripts/qa/guided-local-run.sh on qwen2.5-7b-q4 and collect the measured metrics.',
    config: cc('tester', QA_PROMPT, {
      launchScript: 'scripts/qa/guided-local-run.sh', launchFixedArgs: ['--non-interactive'],
      launchOptions: localQaOptions('qwen2.5-7b-q4'),
      launchDefaultCommand: PERF_QA_DEFAULT_COMMAND,
    }) },
  { key: 'compare', name: 'Compare Against Target', type: 'claude-code', deps: ['qa', 'target', 'decide'],
    description: 'Measured vs target per metric; the gap and ranked suggested improvements when a target is missed.',
    config: cc('reviewer', COMPARE_PROMPT) },
  { key: 'gate', name: 'Targets Met?', type: 'quality-gate', deps: ['decide', 'develop', 'qa', 'compare'],
    description: 'PASS when met, stopped, accepted or at the 3-round limit; FAIL loops back to your approval, then Develop and QA.',
    config: { gateType: 'custom', includeDepOutput: true, customPrompt: GATE_PROMPT, maxRetries: 2, terminalOnFail: true } },
  { key: 'report', name: 'Write Performance Report', type: 'claude-code', deps: ['gate', 'compare', 'target'],
    description: 'Self-contained HTML report: baseline vs target vs measured, QA summary, what changed.',
    config: cc('general', REPORT_PROMPT) },
  { key: 'done', name: 'Mark Jira Task Done', type: 'claude-code', deps: ['report', 'compare', 'load'],
    description: 'Transition the Jira task to Done only if the targets were met or you accepted the result as done.',
    config: cc('general', DONE_PROMPT) },
];
