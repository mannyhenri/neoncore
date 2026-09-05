/**
 * Merging time series across a FEDERATED fleet.
 *
 * Same reason as lib/burnRate.ts: each server owns its own database, so a chart drawn from one
 * server is a chart of one machine. The difference here is that a series cannot be merged the
 * way a scalar can.
 *
 * ALIGNMENT IS BY TIMESTAMP, NEVER BY INDEX. Each server computes its own window from its own
 * `Date.now()`, so two servers answering the same request can return arrays of different length
 * — a millisecond either side of an hour boundary is enough. Zipping by index would then shift
 * one machine's history against the other's and draw a spend change that never happened, which
 * is the exact signal this page exists to show.
 */

export interface SeriesPoint { t: string; tokens: number; costUsd: number; samples: number }

export interface UsageSeries {
  bucket: string;
  days: number;
  series: SeriesPoint[];
  total: { tokens: number; costUsd: number; samples: number };
  byCartridge: { agentId: string; name: string; tokens: number; samples: number }[];
  byProject: { project: string; tokens: number; samples: number; cartridges: number }[];
}

export interface FleetSeries extends UsageSeries {
  serversReporting: number;
  serversAsked: number;
  /** Named, with the reason — see lib/serverAnswer.ts. */
  problems: Problem[];
}

import { problemsIn, type ServerAnswer, type Problem } from './serverAnswer';

/** Fields on a SeriesPoint that add when two servers are combined. */
export const POINT_SUMMED_KEYS = ['tokens', 'costUsd', 'samples'] as const;

/** The old build answers `[]`: truthy, an array, but with no `.series` of its own. */
const usableSeries = (s: UsageSeries) => Array.isArray(s?.series) && !Array.isArray(s);

export function mergeSeries(
  answers: ServerAnswer<UsageSeries>[],
  bucket: string,
  days: number,
): FleetSeries {
  const ok = answers.map((a) => a.result).filter((s): s is UsageSeries => s != null && usableSeries(s));

  // Union of every bucket start any server reported — a server that was down for a stretch
  // must not shorten the fleet's timeline.
  const byT = new Map<string, SeriesPoint>();
  for (const s of ok) {
    for (const p of s.series) {
      if (!Number.isFinite(p?.tokens)) continue;
      const cell = byT.get(p.t) ?? { t: p.t, tokens: 0, costUsd: 0, samples: 0 };
      for (const k of POINT_SUMMED_KEYS) cell[k] += Number(p[k]) || 0;
      byT.set(p.t, cell);
    }
  }

  const series = [...byT.values()].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));

  return {
    bucket: ok[0]?.bucket ?? bucket,
    days: ok[0]?.days ?? days,
    series,
    total: {
      tokens: ok.reduce((n, s) => n + (Number(s.total?.tokens) || 0), 0),
      costUsd: ok.reduce((n, s) => n + (Number(s.total?.costUsd) || 0), 0),
      samples: ok.reduce((n, s) => n + (Number(s.total?.samples) || 0), 0),
    },
    // Cartridges are per-server entities; concatenating is the merge. Sorted so the heaviest
    // spender is first regardless of which machine it lives on.
    byCartridge: ok.flatMap((s) => s.byCartridge ?? []).sort((a, b) => b.tokens - a.tokens),
    // Projects SUM, cartridges concatenate — the one place copying the line above is wrong.
    // A cartridge belongs to one server; a repo does not. film-engine runs on both machines,
    // and concatenating would list it twice and halve its share of the fleet.
    byProject: mergeProjects(ok),
    serversReporting: ok.length,
    serversAsked: answers.length,
    problems: problemsIn(answers, usableSeries),
  };
}


/** Fold per-server project rows into one row per repo. */
function mergeProjects(
  servers: UsageSeries[],
): { project: string; tokens: number; samples: number; cartridges: number }[] {
  const acc = new Map<string, { project: string; tokens: number; samples: number; cartridges: number }>();
  for (const s of servers) {
    for (const row of s.byProject ?? []) {
      const at = acc.get(row.project);
      if (at) {
        at.tokens += row.tokens;
        at.samples += row.samples;
        at.cartridges += row.cartridges;
      } else {
        acc.set(row.project, { ...row });
      }
    }
  }
  return [...acc.values()].sort((a, b) => b.tokens - a.tokens);
}
