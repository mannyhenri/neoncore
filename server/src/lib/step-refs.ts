/**
 * STEP-ID REFERENCES INSIDE A STEP'S CONFIG — remapped wherever step ids are regenerated.
 *
 * `dependsOn` is a column and every path that gives steps new ids remaps it. Two references live
 * INSIDE `executor_config`, and none of those paths touched them:
 *
 *   routingRules[].nextStepId   the step a routing rule sends the run back to
 *   options[].nextStepId        a decision option's target (carried for the editor; the engine
 *                               does not branch on it, but a stale id is still a wrong id)
 *
 * Ids are regenerated in four places — /v2/create and PUT /v2/:id (the canvas editor's create and
 * save), the template → run clone in /v2/:id/start, and cloneTemplateAsRun (scheduled launches).
 * With the targets left behind, every routing rule in every run pointed at a step that was not in
 * it, the executor skipped it silently, and no rule ever fired. All four call this.
 *
 * A reference the map does not know is left as it is rather than dropped: it is already dangling,
 * and the executor reports a dangling target when the rule is evaluated.
 */

type IdMap = Map<string, string> | ((oldId: string) => string | undefined);

function lookup(map: IdMap, id: string): string | undefined {
  return typeof map === 'function' ? map(id) : map.get(id);
}

/** A copy of `config` with every step-id reference remapped. */
export function remapStepRefs<T extends Record<string, unknown>>(config: T, map: IdMap): T {
  const out: Record<string, unknown> = { ...config };
  if (Array.isArray(config.routingRules)) {
    out.routingRules = (config.routingRules as Array<Record<string, unknown>>).map((r) => {
      const id = typeof r?.nextStepId === 'string' ? r.nextStepId : '';
      const to = id ? lookup(map, id) : undefined;
      return to ? { ...r, nextStepId: to } : r;
    });
  }
  if (Array.isArray(config.options)) {
    out.options = (config.options as Array<Record<string, unknown>>).map((o) => {
      const id = typeof o?.nextStepId === 'string' ? o.nextStepId : '';
      const to = id ? lookup(map, id) : undefined;
      return to ? { ...o, nextStepId: to } : o;
    });
  }
  return out as T;
}

/** The same, for a config stored as JSON. Unparseable JSON is returned untouched. */
export function remapStepRefsJson(configJson: string, map: IdMap): string {
  if (!configJson || (!configJson.includes('nextStepId'))) return configJson;
  try {
    return JSON.stringify(remapStepRefs(JSON.parse(configJson) as Record<string, unknown>, map));
  } catch {
    return configJson;
  }
}
