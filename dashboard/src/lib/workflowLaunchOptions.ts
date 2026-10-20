export type WorkflowLaunchOptionType = 'select' | 'multi-select' | 'boolean' | 'text';

export interface WorkflowLaunchChoice {
  value: string;
  label: string;
  /** Choice-specific argv, for mutually exclusive switches such as build/QA location. */
  args?: string[];
  /** Environment assignments emitted before the script for this choice. */
  env?: Record<string, string>;
}

export interface WorkflowLaunchOption {
  key: string;
  label: string;
  description?: string;
  type: WorkflowLaunchOptionType;
  defaultValue: string | boolean | string[];
  choices?: WorkflowLaunchChoice[];
  /** Ordinary `--flag value` options. */
  flag?: string;
  /** Boolean argv emitted only when enabled. */
  enabledArgs?: string[];
  /** Multi-select values are joined into the single value expected by the script. */
  joinWith?: string;
  /** Value emitted when a multi-select is empty and omission would expose an ambient default. */
  emptyValue?: string;
  placeholder?: string;
  required?: boolean;
  /** Only show/emit this option when another selection has this exact value. */
  visibleWhen?: { key: string; value: string };
}

export type WorkflowLaunchValues = Record<string, string | boolean | string[]>;

export interface WorkflowLaunchConfig {
  script: string;
  fixedArgs: string[];
  options: WorkflowLaunchOption[];
}

export interface WorkflowLaunchConfigResult {
  config: WorkflowLaunchConfig | null;
  error: string | null;
}

function isChoice(value: unknown): value is WorkflowLaunchChoice {
  if (!value || typeof value !== 'object') return false;
  const choice = value as Partial<WorkflowLaunchChoice>;
  return typeof choice.value === 'string' && typeof choice.label === 'string'
    && (choice.args === undefined || (Array.isArray(choice.args) && choice.args.every((arg) => typeof arg === 'string')))
    && (choice.env === undefined || isEnvironment(choice.env));
}

function isEnvironment(value: unknown): value is Record<string, string> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([key, item]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof item === 'string');
}

function isLaunchOption(value: unknown): value is WorkflowLaunchOption {
  if (!value || typeof value !== 'object') return false;
  const option = value as Partial<WorkflowLaunchOption>;
  if (typeof option.key !== 'string' || typeof option.label !== 'string'
    || !['select', 'multi-select', 'boolean', 'text'].includes(String(option.type))) return false;
  if (option.choices !== undefined && (!Array.isArray(option.choices) || !option.choices.every(isChoice))) return false;
  if (option.enabledArgs !== undefined
    && (!Array.isArray(option.enabledArgs) || !option.enabledArgs.every((arg) => typeof arg === 'string'))) return false;
  if (option.description !== undefined && typeof option.description !== 'string') return false;
  if (option.flag !== undefined && typeof option.flag !== 'string') return false;
  if (option.joinWith !== undefined && typeof option.joinWith !== 'string') return false;
  if (option.emptyValue !== undefined && typeof option.emptyValue !== 'string') return false;
  if (option.placeholder !== undefined && typeof option.placeholder !== 'string') return false;
  if (option.required !== undefined && typeof option.required !== 'boolean') return false;
  if (option.visibleWhen !== undefined && (!option.visibleWhen || typeof option.visibleWhen !== 'object'
    || typeof option.visibleWhen.key !== 'string' || typeof option.visibleWhen.value !== 'string')) return false;
  if (option.type === 'boolean') return typeof option.defaultValue === 'boolean' && option.choices === undefined;
  if (option.type === 'multi-select') return Array.isArray(option.defaultValue)
    && option.defaultValue.every((item) => typeof item === 'string') && Array.isArray(option.choices)
    && option.defaultValue.every((item) => option.choices?.some((choice) => choice.value === item));
  if (option.type === 'select') return typeof option.defaultValue === 'string' && Array.isArray(option.choices)
    && option.choices.some((choice) => choice.value === option.defaultValue);
  return typeof option.defaultValue === 'string' && option.choices === undefined;
}

export function parseWorkflowLaunchConfig(config: Record<string, unknown>): WorkflowLaunchConfig | null {
  if (typeof config.launchScript !== 'string' || !config.launchScript
    || !Array.isArray(config.launchOptions) || !config.launchOptions.every(isLaunchOption)) return null;
  if (config.launchFixedArgs !== undefined
    && (!Array.isArray(config.launchFixedArgs) || !config.launchFixedArgs.every((arg) => typeof arg === 'string'))) return null;
  return {
    script: config.launchScript,
    fixedArgs: (config.launchFixedArgs as string[] | undefined) ?? [],
    options: config.launchOptions,
  };
}

export function findWorkflowLaunchConfig(configs: Record<string, unknown>[]): WorkflowLaunchConfigResult {
  for (const candidate of configs) {
    const declared = 'launchScript' in candidate || 'launchOptions' in candidate || 'launchFixedArgs' in candidate;
    if (!declared) continue;
    const config = parseWorkflowLaunchConfig(candidate);
    return config
      ? { config, error: null }
      : { config: null, error: 'This workflow has an invalid QA launch configuration and cannot be started.' };
  }
  return { config: null, error: null };
}

export function defaultLaunchOptionValues(options: WorkflowLaunchOption[]): WorkflowLaunchValues {
  return Object.fromEntries(options.map((option) => [
    option.key,
    Array.isArray(option.defaultValue) ? [...option.defaultValue] : option.defaultValue,
  ]));
}

export function isLaunchOptionVisible(option: WorkflowLaunchOption, values: WorkflowLaunchValues): boolean {
  if (!option.visibleWhen) return true;
  return values[option.visibleWhen.key] === option.visibleWhen.value;
}

export function launchOptionErrors(options: WorkflowLaunchOption[], values: WorkflowLaunchValues): string[] {
  const errors: string[] = [];
  for (const option of options) {
    if (!isLaunchOptionVisible(option, values)) continue;
    const value = values[option.key] ?? option.defaultValue;
    if (option.required && (value === '' || value === false || (Array.isArray(value) && value.length === 0))) {
      errors.push(`${option.label} is required.`);
      continue;
    }
    if (option.type === 'select' && typeof value === 'string'
      && !option.choices?.some((choice) => choice.value === value)) {
      errors.push(`${option.label} has an invalid selection.`);
    }
    if (option.type === 'multi-select' && Array.isArray(value)) {
      const allowed = new Set(option.choices?.map((choice) => choice.value) || []);
      if (value.some((selected) => !allowed.has(selected))) {
        errors.push(`${option.label} has an invalid selection.`);
      }
    }
  }
  return errors;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_~./:@,+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function checkedChoice(option: WorkflowLaunchOption, value: string): WorkflowLaunchChoice {
  const choice = option.choices?.find((candidate) => candidate.value === value);
  if (!choice) throw new Error(`${option.key} does not accept ${JSON.stringify(value)}`);
  return choice;
}

export function renderLaunchCommand(
  config: WorkflowLaunchConfig,
  values: WorkflowLaunchValues,
): string {
  const argv = [config.script, ...config.fixedArgs];
  const environment: Record<string, string> = {};

  for (const option of config.options) {
    if (!isLaunchOptionVisible(option, values)) continue;
    const value = values[option.key] ?? option.defaultValue;

    if (option.type === 'boolean') {
      if (value === true) argv.push(...(option.enabledArgs || []));
      continue;
    }

    if (option.type === 'text') {
      if (typeof value !== 'string') throw new Error(`${option.key} must be text`);
      if (value && option.flag) argv.push(option.flag, value);
      continue;
    }

    if (option.type === 'select') {
      if (typeof value !== 'string') throw new Error(`${option.key} must be one selection`);
      const choice = checkedChoice(option, value);
      Object.assign(environment, choice.env);
      if (choice.args) argv.push(...choice.args);
      else if (option.flag) argv.push(option.flag, value);
      continue;
    }

    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
      throw new Error(`${option.key} must be a list of selections`);
    }
    for (const selected of value) checkedChoice(option, selected);
    if (option.flag && (value.length > 0 || option.emptyValue !== undefined)) {
      argv.push(option.flag, value.length > 0 ? value.join(option.joinWith ?? ',') : option.emptyValue!);
    }
  }

  const envAssignments = Object.entries(environment).map(([key, value]) => `${key}=${shellQuote(value)}`);
  return [...envAssignments, ...argv.map(shellQuote)].join(' ');
}

export function buildLaunchContext(command: string, options: WorkflowLaunchOption[], values: WorkflowLaunchValues): string {
  const selected = options
    .filter((option) => isLaunchOptionVisible(option, values))
    .map((option) => `- ${option.label}: ${Array.isArray(values[option.key]) ? (values[option.key] as string[]).join(', ') : String(values[option.key])}`)
    .join('\n');
  return `GRIDLIGHT QA LAUNCH SELECTIONS\n${selected}\n\nRESOLVED COMMAND\n${command}`;
}
