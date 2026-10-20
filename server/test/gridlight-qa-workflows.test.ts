/**
 * THE TWO GRIDLIGHT QA WORKFLOWS, AS COMPLETE SETS.
 *
 * These workflows are UI wrappers around real CLIs in the Gridlight repository. A partial
 * wrapper is dangerous: the launch form looks authoritative while silently omitting a release
 * control. Keep the option sets counted here, and keep each workflow to the requested two-step
 * contract: run the script, then render its purpose-built HTML report.
 */
import './helpers/isolated-db.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import db, { STANDARD_TEMPLATE_NAMES } from '../src/db.ts';
import { ensureReportStepOnTemplates, isReportStep } from '../src/lib/workflow-report.ts';

type Step = {
  id: string;
  name: string;
  executor_config: string;
  depends_on: string;
};

const EXPECTED = {
  'Gridlight Local QA': {
    script: 'scripts/qa/guided-local-run.sh',
    keys: [
      'modelProfile', 'engines', 'metrics', 'manager', 'downloadModel',
      'syncComparators', 'build', 'mediaAgents', 'envFile', 'backend', 'quick',
    ],
  },
  'Gridlight Full Release QA': {
    script: 'scripts/qa/full-release-run.sh',
    keys: [
      'scope', 'modelProfile', 'engines', 'metrics', 'manager', 'cacheS3',
      'mediaAgents', 'envFile', 'dryRun', 'flavours', 'buildLocation',
      'buildHost', 'qaLocation', 'qaHost', 'keep',
    ],
  },
} as const;

type CliOptionContract = Record<string, unknown> & { choices?: string | Array<string | Record<string, unknown>> };
const CLI_CONTRACT = JSON.parse(readFileSync(
  new URL('./fixtures/gridlight-qa-cli-contract.json', import.meta.url), 'utf8',
)) as {
  sourceCommit: string;
  models: string[];
  workflows: Record<string, { script: string; fixedArgs: string[]; options: Record<string, CliOptionContract> }>;
};

function optionContract(option: Record<string, unknown>): CliOptionContract {
  const normalized: CliOptionContract = {};
  for (const key of ['type', 'defaultValue', 'flag', 'enabledArgs', 'joinWith', 'emptyValue', 'required', 'visibleWhen']) {
    if (option[key] !== undefined) normalized[key] = option[key];
  }
  const choices = option.choices as Array<Record<string, unknown>> | undefined;
  if (choices) {
    const carriesArgv = choices.some((choice) => choice.args !== undefined || choice.env !== undefined);
    normalized.choices = carriesArgv
      ? choices.map(({ value, args, env }) => Object.fromEntries(
          Object.entries({ value, args, env }).filter(([, item]) => item !== undefined),
        ))
      : choices.map((choice) => String(choice.value));
  }
  return normalized;
}

function templateSteps(name: string): Step[] {
  const workflow = db.prepare(
    'SELECT id FROM workflows WHERE template_id IS NULL AND name = ?',
  ).get(name) as { id: string } | undefined;
  assert.ok(workflow, `${name} was not seeded`);
  return db.prepare(
    'SELECT id, name, executor_config, depends_on FROM workflow_steps WHERE workflow_id = ? ORDER BY position_y',
  ).all(workflow.id) as Step[];
}

const config = (step: Step): Record<string, unknown> =>
  JSON.parse(step.executor_config || '{}') as Record<string, unknown>;

test('both Gridlight QA workflows expose every supported launch choice and exactly two steps', () => {
  let workflows = 0;
  let launchOptions = 0;

  for (const [name, expected] of Object.entries(EXPECTED)) {
    assert.ok((STANDARD_TEMPLATE_NAMES as readonly string[]).includes(name), `${name} is not registered`);
    const steps = templateSteps(name);
    assert.equal(steps.length, 2, `${name} must contain only script + HTML report`);

    const run = config(steps[0]);
    const report = config(steps[1]);
    assert.equal(run.launchScript, expected.script);
    assert.match(String(run.prompt || ''), /RESOLVED COMMAND/,
      `${name} must instruct the cartridge to use the command resolved from launch selections`);
    assert.match(String(run.prompt || ''), new RegExp(String(run.launchDefaultCommand).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${name} must remain runnable with declared defaults from launch surfaces without an option form`);
    assert.deepEqual(
      (run.launchOptions as { key: string }[]).map((option) => option.key).sort(),
      [...expected.keys].sort(),
      `${name} launch form drifted from its CLI option set`,
    );
    assert.equal(run.launchFixedArgs instanceof Array, true);

    const options = run.launchOptions as Array<Record<string, unknown>>;
    const contract = CLI_CONTRACT.workflows[name];
    assert.ok(contract, `${name} has no captured gl-dev-b CLI contract`);
    assert.equal(run.launchScript, contract.script);
    assert.deepEqual(run.launchFixedArgs, contract.fixedArgs);
    const actualContract = Object.fromEntries(options.map((option) => [option.key, optionContract(option)]));
    const expectedContract = Object.fromEntries(Object.entries(contract.options).map(([key, option]) => [
      key,
      option.choices === '$models' ? { ...option, choices: CLI_CONTRACT.models } : option,
    ]));
    assert.deepEqual(actualContract, expectedContract,
      `${name} drifted from gl-dev-b ${CLI_CONTRACT.sourceCommit}'s non-guided CLI contract`);

    const media = options.find((option) => option.key === 'mediaAgents');
    assert.equal(media?.emptyValue, 'none', `${name} must override an ambient QA_MEDIA_IMAGES value when none is selected`);
    if (name === 'Gridlight Full Release QA') {
      const buildLocation = options.find((option) => option.key === 'buildLocation');
      const buildChoices = buildLocation?.choices as Array<{ value: string }>;
      assert.deepEqual(buildChoices.map((choice) => choice.value), ['provision', 'existing'],
        'full release must not offer --local-build, which cannot complete the image phase');
      const qaLocation = options.find((option) => option.key === 'qaLocation');
      const qaChoices = qaLocation?.choices as Array<{ value: string; env?: Record<string, string> }>;
      assert.deepEqual(qaChoices.find((choice) => choice.value === 'existing')?.env,
        { QA_ALLOW_REUSED_HOST: '1' }, 'existing QA hosts require explicit reuse acknowledgement');
    }

    assert.equal(isReportStep(report), true, `${name}'s second step is not a journal report`);
    assert.equal(report.reportVariant, 'gridlight-qa');
    assert.equal(report.reportPromptManaged, false,
      `${name}'s customized report would be overwritten by the generic report refresh`);
    assert.deepEqual(JSON.parse(steps[1].depends_on), [steps[0].id],
      `${name}'s report must depend on its script step`);

    workflows++;
    launchOptions += (run.launchOptions as unknown[]).length;
  }

  assert.equal(workflows, 2);
  assert.equal(launchOptions, 26);
  console.log(`[set] ${workflows}/2 workflows · ${launchOptions}/26 launch options · 2/2 steps each`);
});

test('the generic report backfill preserves each customized report and adds no third step', () => {
  ensureReportStepOnTemplates(db);
  for (const name of Object.keys(EXPECTED)) {
    const steps = templateSteps(name);
    assert.equal(steps.length, 2, `${name} gained an unwanted generic report step`);
    const reports = steps.filter((step) => isReportStep(config(step)));
    assert.equal(reports.length, 1);
    assert.equal(config(reports[0]).reportVariant, 'gridlight-qa');
  }
});
