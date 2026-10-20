/** Standard workflow templates: Confer. Seeded on every boot by ./index.ts. */
import { randomUUID } from 'crypto';
import type { SeedKit } from './kit.js';

export function seedConfer({ now, stableId, insertWorkflow, step, cc }: SeedKit): void {
  // ── 0c. Confer ────────────────────────────────────────────────────────────
  //
  // Confer as a TEMPLATE rather than a button in the header. It was a global action in the top
  // menu, which made it the one way of starting work that had no run history, no project, no
  // report and no place on the canvas. It is a workflow like everything else.
  //
  // The confer step ships with an EMPTY conferAgentIds: the launch modal fills it from the
  // cartridges picked under "Run on" (CONFER_FILL, lib/workflow-launch.ts).
  {
    const wfId = stableId('Confer');
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID();
    insertWorkflow.run(wfId, 'Confer',
      'Two or more cartridges work one task together — they agree an approach, split it between themselves, and build in rounds. Pick the cartridges under "Run on" at launch and put the task in the description.', now);

    step(wfId, s1, 'Confer & Build', 'The cartridges agree an approach, divide the work, and build it.', 300, 50, 'confer',
      { conferAgentIds: [], conferMode: 'divide', conferIsolation: 'shared', buildRounds: 3, includeDepOutput: true,
        prompt: 'The task is in the workflow description above. The milestones walk you through agreeing, building and reviewing it together; throughout:\n- Each of you is in a different repo or checkout and none of you owns the whole task. Never edit a repo you are not in.\n- Disagree out loud. An unspoken disagreement becomes two incompatible implementations.\n- The moment you change something a peer depends on (a shared type, API shape or schema), tell them.\n- Blocked on a peer? Name them and what you need.' }, []);

    step(wfId, s2, 'Verify Together', 'Does the combined result actually work across repos?', 300, 225, 'claude-code',
      { ...cc('reviewer'), prompt: 'The confer is finished. Verify the COMBINED result — the failure mode of a confer is a set of pieces that each work alone and do not fit.\n\n1. Read what every participant reported.\n2. For each shared contract they touched (types, API shapes, schemas, env vars), check both sides actually agree. Name the file on each side.\n3. Run the tests in this repo and paste the real output.\n4. List anything a participant said they were blocked on that was never resolved.\n\nVerdict: DOES IT FIT — yes, or exactly what does not.' }, [s1]);

    step(wfId, s3, 'Notify', 'Confer complete.', 300, 400, 'connector',
      { connectorType: 'system-notify', title: 'Confer — Done', message: 'The cartridges have finished conferring. Check NeonCore for the report.' }, [s2]);
  }
}
