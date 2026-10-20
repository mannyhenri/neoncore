import { describe, expect, it } from 'vitest';
import {
  defaultLaunchOptionValues,
  findWorkflowLaunchConfig,
  launchOptionErrors,
  parseWorkflowLaunchConfig,
  renderLaunchCommand,
  type WorkflowLaunchOption,
} from '../workflowLaunchOptions';

const OPTIONS: WorkflowLaunchOption[] = [
  { key: 'engine', label: 'Engine', type: 'select', defaultValue: 'gridlight', flag: '--engine',
    choices: [{ value: 'gridlight', label: 'Gridlight' }, { value: 'llama', label: 'llama.cpp' }] },
  { key: 'download', label: 'Download', type: 'boolean', defaultValue: false, enabledArgs: ['--download-model'] },
  { key: 'path', label: 'Environment file', type: 'text', defaultValue: '', flag: '--env-file' },
  { key: 'surfaces', label: 'Surfaces', type: 'multi-select', defaultValue: ['deb', 'docker'],
    flag: '--flavours', joinWith: ' ', choices: [
      { value: 'deb', label: 'DEB' }, { value: 'rpm', label: 'RPM' }, { value: 'docker', label: 'Docker' },
    ] },
  { key: 'location', label: 'Location', type: 'select', defaultValue: 'provision', choices: [
    { value: 'provision', label: 'Provision', args: ['--provision-build'] },
    { value: 'local', label: 'Local', args: ['--local-build'] },
  ] },
];

describe('workflow launch options', () => {
  it('builds one shell-safe command from every selected value', () => {
    const values = {
      ...defaultLaunchOptionValues(OPTIONS),
      engine: 'llama',
      download: true,
      path: "/tmp/qa env'; touch /tmp/nope",
      surfaces: ['rpm', 'docker'],
      location: 'local',
    };
    expect(renderLaunchCommand({ script: 'scripts/qa/run.sh', fixedArgs: ['--non-interactive'], options: OPTIONS }, values)).toBe(
      "scripts/qa/run.sh --non-interactive --engine llama --download-model --env-file '/tmp/qa env'\"'\"'; touch /tmp/nope' --flavours 'rpm docker' --local-build",
    );
  });

  it('rejects values outside a declared choice set', () => {
    expect(() => renderLaunchCommand({ script: 'scripts/qa/run.sh', fixedArgs: [], options: OPTIONS }, {
      ...defaultLaunchOptionValues(OPTIONS), engine: 'invented',
    })).toThrow(/engine.*invented/i);
  });

  it('omits empty optional text and disabled flags, but still emits declared defaults', () => {
    expect(renderLaunchCommand({ script: 'scripts/qa/run.sh', fixedArgs: [], options: OPTIONS }, defaultLaunchOptionValues(OPTIONS))).toBe(
      "scripts/qa/run.sh --engine gridlight --flavours 'deb docker' --provision-build",
    );
  });

  it('requires a conditional host only when its existing-host mode is selected', () => {
    const options: WorkflowLaunchOption[] = [
      { key: 'location', label: 'Location', type: 'select', defaultValue: 'provision', choices: [
        { value: 'provision', label: 'Provision' }, { value: 'existing', label: 'Existing' },
      ] },
      { key: 'host', label: 'SSH host', type: 'text', defaultValue: '', flag: '--host', required: true,
        visibleWhen: { key: 'location', value: 'existing' } },
    ];
    expect(launchOptionErrors(options, { location: 'provision', host: '' })).toEqual([]);
    expect(launchOptionErrors(options, { location: 'existing', host: '' })).toEqual(['SSH host is required.']);
  });

  it('emits explicit empty values and selected environment acknowledgements', () => {
    const options: WorkflowLaunchOption[] = [
      { key: 'media', label: 'Media', type: 'multi-select', defaultValue: [], flag: '--media-agents',
        emptyValue: 'none', choices: [{ value: 'image', label: 'Image' }] },
      { key: 'qa', label: 'QA location', type: 'select', defaultValue: 'provision', choices: [
        { value: 'provision', label: 'Provision', args: ['--provision-qa'] },
        { value: 'existing', label: 'Existing', env: { QA_ALLOW_REUSED_HOST: '1' } },
      ] },
    ];
    const config = { script: 'run.sh', fixedArgs: [], options };
    expect(renderLaunchCommand(config, defaultLaunchOptionValues(options))).toBe(
      'run.sh --media-agents none --provision-qa',
    );
    expect(renderLaunchCommand(config, { media: [], qa: 'existing' })).toBe(
      'QA_ALLOW_REUSED_HOST=1 run.sh --media-agents none',
    );
  });

  it('rejects an incomplete launch schema at the UI boundary', () => {
    expect(parseWorkflowLaunchConfig({ launchScript: 'run.sh', launchOptions: [{
      key: 'engine', label: 'Engine', type: 'select', defaultValue: 'gridlight',
    }] })).toBeNull();
    expect(parseWorkflowLaunchConfig({ launchScript: 'run.sh', launchOptions: [{
      key: 'host', label: 'Host', type: 'text', defaultValue: '', flag: 42,
    }] })).toBeNull();
    expect(parseWorkflowLaunchConfig({ launchScript: 'run.sh', launchOptions: [{
      key: 'host', label: 'Host', type: 'text', defaultValue: '', visibleWhen: { key: false, value: 'existing' },
    }] })).toBeNull();
  });

  it('distinguishes no launch schema from a declared but invalid one', () => {
    expect(findWorkflowLaunchConfig([{ prompt: 'ordinary step' }])).toEqual({ config: null, error: null });
    expect(findWorkflowLaunchConfig([{ launchScript: 'run.sh', launchOptions: [{ key: 'broken' }] }])).toEqual({
      config: null,
      error: 'This workflow has an invalid QA launch configuration and cannot be started.',
    });
  });
});
