/**
 * REPAIRS — every self-repair the Runner made, waiting for a person. A repair changes HOW a step
 * is done (a renamed button, a moved field), never what a check checks; the server refuses one
 * that would. Accept keeps the new actions; Reject restores the old ones.
 */
import type { QaRepair } from './types';
import { ActionList, BTN_GHOST, BTN_PRIMARY, CARD, Empty, Loading } from './ui';
import { isCheckSentence } from './sentences';

export function RepairsTab({ repairs, onAccept, onReject }: {
  repairs: QaRepair[] | undefined;
  onAccept: (r: QaRepair) => Promise<void> | void;
  onReject: (r: QaRepair) => Promise<void> | void;
}) {
  if (repairs === undefined) return <Loading what="repairs" />;
  const pending = repairs.filter((r) => r.status === 'pending');
  if (pending.length === 0) {
    return (
      <Empty art="empty-repairs" title="Nothing to review">
        <p>When the app changes — a button renamed, a field moved — the Runner repairs the step and lists the change here, before and after, for you to accept or reject.</p>
      </Empty>
    );
  }
  return (
    <ul className="space-y-3">
      {pending.map((r) => (
        <li key={r.id} data-qa-repair={r.id} className={`${CARD} panel-ask space-y-3`}>
          <div>
            <div className="text-[12px] text-gray-400">{r.testName || r.testId} · step {r.stepIndex + 1}</div>
            <div className={`font-semibold ${isCheckSentence(r.sentence) ? 'text-neon-200' : 'text-gray-100'}`}>{r.sentence}</div>
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <div className="text-[12px] text-gray-500 mb-1">Before</div>
              <ActionList actions={r.before} tone="before" />
            </div>
            <div>
              <div className="text-[12px] text-gray-500 mb-1">After</div>
              <ActionList actions={r.after} tone="after" />
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <button className={BTN_GHOST} onClick={() => onReject(r)}>Reject</button>
            <button className={BTN_PRIMARY} onClick={() => onAccept(r)}>Accept</button>
          </div>
        </li>
      ))}
    </ul>
  );
}
