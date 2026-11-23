/**
 * WHERE A PROJECT'S DESIGN EXPLORATION IS KEPT. On the server, with the project
 * (server lib/design-system.ts). A server from before the design system existed answers "not
 * found" for the route: then it is kept in this browser instead, and the page says so — the
 * feature works either way, and nothing is silently lost.
 */
import type { DesignExploration } from '../../types';
import { api } from '../api';

export const EMPTY_EXPLORATION: DesignExploration = { inspirations: [], rounds: [], selected: null, updatedAt: '' };
export type Kept = 'server' | 'browser';
const key = (projectId: string) => `neoncore.design.${projectId}`;
export const missingRoute = (e: unknown) => /not found|404|cannot (get|put)/i.test(e instanceof Error ? e.message : String(e));

function fromBrowser(projectId: string): DesignExploration {
  try {
    const raw = window.localStorage.getItem(key(projectId));
    const v = raw ? JSON.parse(raw) : null;
    if (v && Array.isArray(v.inspirations) && Array.isArray(v.rounds)) return { ...EMPTY_EXPLORATION, ...v };
  } catch { /* unreadable: start empty */ }
  return { ...EMPTY_EXPLORATION };
}

export async function loadExploration(projectId: string): Promise<{ data: DesignExploration; kept: Kept }> {
  try {
    const data = await api.getDesignSystem(projectId);
    return { data: { ...EMPTY_EXPLORATION, ...data }, kept: 'server' };
  } catch (e) {
    if (!missingRoute(e)) throw e;
    return { data: fromBrowser(projectId), kept: 'browser' };
  }
}

export async function saveExploration(projectId: string, data: DesignExploration, kept: Kept): Promise<{ data: DesignExploration; kept: Kept }> {
  // The system, where it was published and the repo list are the server's own: never sent back to it.
  const { updatedAt: _dropped, system: _system, published: _published, repos: _repos, designer: _designer, designing: _designing, ...body } = data;
  if (kept === 'server') {
    try {
      return { data: { ...EMPTY_EXPLORATION, ...(await api.saveDesignSystem(projectId, body as never)) }, kept: 'server' };
    } catch (e) {
      if (!missingRoute(e)) throw e;
    }
  }
  const stamped = { ...data, updatedAt: new Date().toISOString() };
  try { window.localStorage.setItem(key(projectId), JSON.stringify(stamped)); } catch { throw new Error('This browser has no room left to keep the design system. Remove an inspiration picture, or restart the server so it is kept there.'); }
  return { data: stamped, kept: 'browser' };
}

/** Step 2 is the server's: what it made (the system), where it put it (published) and the project's repos. */
export type ServerPart = Pick<DesignExploration, 'system' | 'published' | 'repos'>;
const serverPart = (d: DesignExploration): ServerPart => ({ system: d.system ?? null, published: d.published ?? null, repos: d.repos ?? [] });
export const finalizeExploration = async (projectId: string): Promise<ServerPart> => serverPart(await api.finalizeDesignSystem(projectId));
export const publishExploration = async (projectId: string): Promise<ServerPart> => serverPart(await api.publishDesignSystem(projectId));

/** Ask Claude's /design (in the project's main repo) for a round of four; stop waiting for one. Both answer with the whole page. */
export const requestRound = async (projectId: string, ask: { note: string; basedOn: { roundId: string; variationId: string } | null }): Promise<DesignExploration> =>
  ({ ...EMPTY_EXPLORATION, ...(await api.requestDesign(projectId, ask)) });
export const cancelRound = async (projectId: string): Promise<DesignExploration> => ({ ...EMPTY_EXPLORATION, ...(await api.cancelDesign(projectId)) });
