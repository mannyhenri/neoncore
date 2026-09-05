/**
 * Turning a permission request into something you can ANSWER from a phone.
 *
 * REPORTED: Discord showed only "gridlight — Question / AskUserQuestion" and "gridlight — Plan
 * Ready / Agent completed planning and is waiting for your review." No question text, no
 * options, no way to reply. The request carried all of it — `tool_input` holds the question,
 * the header, and every option with its description — and the notice threw it away.
 *
 * That was my omission: routes/permissions.ts sent `actions: []` with a comment deferring
 * buttons to N3, and N3 turned out to cover workflow attention events only. A notification you
 * cannot act on is a strictly worse version of the dashboard you were not at.
 *
 * ── THE ANSWER SHAPE IS NOT NEGOTIABLE ─────────────────────────────────────────────────
 * The dashboard answers with `{ answers: { [key]: label } }`, where the key is the question's
 * id, else its text, else its index — see CartridgeCard's QuestionAnswerCard. The agent's hook
 * reads that. A channel that invents its own shape produces a decision the agent cannot parse,
 * which is worse than no button at all: the request is consumed and the answer is gibberish.
 * So the key derivation is duplicated from the dashboard DELIBERATELY and asserted in a test.
 */

export interface QuestionOption { label: string; description?: string }
export interface ParsedQuestion {
  id?: string;
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/** Discord caps a button label at 80 characters and a custom id at 100. */
export const MAX_LABEL = 80;
export const MAX_ACTION_ID = 100;
/** 5 buttons per row, 5 rows. Well under it: a wall of buttons is not a choice, it is a menu. */
export const MAX_BUTTONS = 10;

export const PERM_PREFIX = { answer: 'pmans', approve: 'pmyes', reject: 'pmno' } as const;

function normalizeOption(raw: unknown): QuestionOption | null {
  if (typeof raw === 'string') return raw.trim() ? { label: raw.trim() } : null;
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const label = typeof o.label === 'string' ? o.label.trim() : '';
  return label ? { label, description: typeof o.description === 'string' ? o.description : undefined } : null;
}

function normalizeQuestion(raw: unknown): ParsedQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const q = raw as Record<string, unknown>;
  const text = typeof q.question === 'string' ? q.question.trim()
    : typeof q.prompt === 'string' ? q.prompt.trim() : '';
  if (!text) return null;
  return {
    id: typeof q.id === 'string' ? q.id : undefined,
    question: text,
    header: typeof q.header === 'string' ? q.header : undefined,
    options: Array.isArray(q.options) ? q.options.map(normalizeOption).filter((o): o is QuestionOption => !!o) : [],
    multiSelect: Boolean(q.multiSelect),
  };
}

/** Never throws: a malformed payload yields no questions, and the caller degrades to a link. */
export function parseQuestions(toolInput: unknown): ParsedQuestion[] {
  let input: unknown = toolInput;
  if (typeof toolInput === 'string') {
    try { input = JSON.parse(toolInput); } catch { return []; }
  }
  if (!input || typeof input !== 'object') return [];
  const parsed = input as Record<string, unknown>;
  if (Array.isArray(parsed.questions)) {
    return parsed.questions.map(normalizeQuestion).filter((q): q is ParsedQuestion => !!q);
  }
  const single = normalizeQuestion(parsed);
  return single ? [single] : [];
}

/**
 * The key an answer is filed under. Copied from the dashboard on purpose — see the header.
 * id, else the question text, else the index.
 */
export function questionKey(q: ParsedQuestion, index: number): string {
  return q.id?.trim() || q.question.trim() || String(index);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface NoticeParts {
  detail: Record<string, string>;
  actions: { id: string; label: string; style?: string }[];
  /** True when the request could not be turned into buttons — the caller says where to go instead. */
  needsDashboard: boolean;
}

/**
 * Build the answerable part of a permission notice.
 *
 * ONLY THE FIRST QUESTION GETS BUTTONS. A multi-question request is a form, and a row of
 * buttons cannot express "answer three things then submit" — pretending otherwise would file a
 * partial answer under one key and leave the agent believing it had been told everything. Those
 * say so and point at the dashboard.
 */
export function buildPermissionParts(
  permissionId: string,
  toolName: string,
  toolInput: unknown,
  description: string,
): NoticeParts {
  const detail: Record<string, string> = {};
  const actions: NoticeParts['actions'] = [];

  if (toolName === 'AskUserQuestion') {
    const questions = parseQuestions(toolInput);

    if (questions.length === 0) {
      detail.Question = clip(description || 'The agent asked something, but the payload could not be read.', 300);
      return { detail, actions, needsDashboard: true };
    }

    const q = questions[0];
    if (q.header) detail.Topic = clip(q.header, 100);
    detail.Question = clip(q.question, 400);

    if (questions.length > 1 || q.multiSelect) {
      detail.Note = questions.length > 1
        ? `${questions.length} questions — answer them together in the dashboard.`
        : 'Multiple selections allowed — answer in the dashboard.';
      return { detail, actions, needsDashboard: true };
    }

    if (q.options.length === 0) {
      detail.Note = 'This one wants free text — reply in the dashboard.';
      return { detail, actions, needsDashboard: true };
    }

    // The options themselves, so the buttons are not the only place the wording appears —
    // a button label is clipped to 80 characters and several options can start alike.
    q.options.slice(0, MAX_BUTTONS).forEach((o, i) => {
      detail[`Option ${i + 1}`] = clip(o.description ? `${o.label} — ${o.description}` : o.label, 240);
    });

    for (let i = 0; i < Math.min(q.options.length, MAX_BUTTONS); i++) {
      actions.push({
        id: `${PERM_PREFIX.answer}:${permissionId}:${i}`,
        label: clip(q.options[i].label, MAX_LABEL),
        style: i === 0 ? 'primary' : 'secondary',
      });
    }
    if (q.options.length > MAX_BUTTONS) {
      detail.Note = `${q.options.length} options — only the first ${MAX_BUTTONS} are shown here.`;
    }
    return { detail, actions, needsDashboard: false };
  }

  // Everything else is a yes/no: a plan to approve, a tool to allow.
  if (description) detail.Detail = clip(description, 400);
  detail.Tool = toolName;
  actions.push(
    { id: `${PERM_PREFIX.approve}:${permissionId}`, label: toolName === 'ExitPlanMode' ? 'Approve plan' : 'Allow', style: 'success' },
    { id: `${PERM_PREFIX.reject}:${permissionId}`, label: 'Reject', style: 'danger' },
  );
  return { detail, actions, needsDashboard: false };
}

/**
 * The decide payload for a chosen option — the same object the dashboard posts.
 * Returns null when the index does not name an option, so a stale button cannot file an
 * empty answer.
 */
export function answerPayloadFor(toolInput: unknown, optionIndex: number): { answers: Record<string, string> } | null {
  const questions = parseQuestions(toolInput);
  if (questions.length !== 1) return null;
  const q = questions[0];
  const option = q.options[optionIndex];
  if (!option) return null;
  return { answers: { [questionKey(q, 0)]: option.label } };
}
