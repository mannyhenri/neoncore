/**
 * JIRA CLOUD REST v3 — what Bug Triage reads and writes, and nothing else.
 *
 * Auth is Basic with a service account: the source stores the NAMES of the environment variables
 * holding its email and API token (authEnv), never the values. The values are read here, at call
 * time, and never logged, stored or returned. `fetch` is injectable so tests can answer for Jira.
 */
import type { TriageSource } from './types.js';
import { TriageError } from './types.js';

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let fetcher: Fetch = (url, init) => fetch(url, init);
export function setJiraFetch(f: Fetch | null): void { fetcher = f ?? ((url, init) => fetch(url, init)); }

/** Atlassian Document Format: just what comments need — paragraphs, a mention, links. */
export type AdfNode = { type: string; version?: number; text?: string; attrs?: Record<string, unknown>; content?: AdfNode[]; marks?: { type: string; attrs?: Record<string, unknown> }[] };

export function adfDoc(paragraphs: AdfNode[][]): AdfNode {
  return { type: 'doc', version: 1, content: paragraphs.map((content) => ({ type: 'paragraph', content })) };
}
export const adfText = (text: string): AdfNode => ({ type: 'text', text });
export const adfMention = (accountId: string, name = ''): AdfNode => ({ type: 'mention', attrs: { id: accountId, text: name ? `@${name}` : '' } });
export const adfLink = (text: string, href: string): AdfNode => ({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] });

/** Plain text from an ADF document (or a plain string, as Jira v2 and the simulator may send). */
export function adfToText(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  const n = node as AdfNode;
  if (n.type === 'text') return n.text ?? '';
  if (n.type === 'mention') return String(n.attrs?.text ?? '');
  if (n.type === 'hardBreak') return '\n';
  const inner = (n.content ?? []).map(adfToText).join('');
  return ['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'].includes(n.type) ? `${inner}\n` : inner;
}

export interface JiraIssue {
  key: string; projectKey: string; summary: string; description: string; issueType: string; status: string;
  reporter: { accountId: string; displayName: string }; labels: string[]; created: string; updated: string;
  environment: string; attachments: { filename: string; url: string }[]; links: { key: string; type: string }[];
}
export interface JiraComment { id: string; author: { accountId: string; displayName: string }; body: string; created: string }

export class JiraClient {
  constructor(private readonly source: Pick<TriageSource, 'jiraBaseUrl' | 'authEnv'>) {}

  private auth(): string {
    const email = process.env[this.source.authEnv.email || ''] ?? '';
    const token = process.env[this.source.authEnv.token || ''] ?? '';
    if (!email || !token) throw new TriageError(`Jira credentials are not set: define the environment variables ${this.source.authEnv.email || '(email)'} and ${this.source.authEnv.token || '(token)'}`, 412);
    return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const base = this.source.jiraBaseUrl.replace(/\/+$/, '');
    const res = await fetcher(`${base}${path}`, {
      method,
      headers: { Authorization: this.auth(), Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new TriageError(`Jira ${method} ${path} → ${res.status} ${text.slice(0, 200)}`, 502);
    return (text ? JSON.parse(text) : null) as T;
  }

  myself(): Promise<{ accountId: string; displayName: string }> {
    return this.call('GET', '/rest/api/3/myself');
  }

  /** Every issue matching `jql` (follows nextPageToken). */
  async search(jql: string, max = 200): Promise<JiraIssue[]> {
    const out: JiraIssue[] = [];
    let nextPageToken: string | undefined;
    do {
      const page = await this.call<{ issues?: unknown[]; nextPageToken?: string; isLast?: boolean }>('POST', '/rest/api/3/search/jql', {
        jql, maxResults: 50, fields: ISSUE_FIELDS, ...(nextPageToken ? { nextPageToken } : {}),
      });
      for (const raw of page.issues ?? []) out.push(toIssue(raw));
      nextPageToken = page.isLast === false || page.nextPageToken ? page.nextPageToken : undefined;
    } while (nextPageToken && out.length < max);
    return out;
  }

  async getIssue(key: string): Promise<JiraIssue> {
    return toIssue(await this.call('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS.join(',')}`));
  }

  async comments(key: string): Promise<JiraComment[]> {
    const r = await this.call<{ comments?: Record<string, unknown>[] }>('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/comment?orderBy=created&maxResults=100`);
    return (r?.comments ?? []).map((c) => ({
      id: String(c.id), body: adfToText(c.body).trim(), created: String(c.created ?? ''),
      author: { accountId: String((c.author as Record<string, unknown>)?.accountId ?? ''), displayName: String((c.author as Record<string, unknown>)?.displayName ?? '') },
    }));
  }

  addComment(key: string, body: AdfNode): Promise<{ id: string }> {
    return this.call('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body });
  }

  addLabels(key: string, labels: string[]): Promise<unknown> {
    if (labels.length === 0) return Promise.resolve(null);
    return this.call('PUT', `/rest/api/3/issue/${encodeURIComponent(key)}`, { update: { labels: labels.map((add) => ({ add })) } });
  }

  async transitionTo(key: string, statusName: string): Promise<boolean> {
    const r = await this.call<{ transitions?: { id: string; name: string; to?: { name?: string } }[] }>('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
    const t = (r?.transitions ?? []).find((x) => x.to?.name?.toLowerCase() === statusName.toLowerCase() || x.name.toLowerCase() === statusName.toLowerCase());
    if (!t) return false;
    await this.call('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: t.id } });
    return true;
  }

  addRemoteLink(key: string, url: string, title: string): Promise<unknown> {
    return this.call('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`, { object: { url, title } });
  }

  async createIssue(projectKey: string, summary: string, description: string, issueType = 'Bug'): Promise<{ key: string }> {
    return this.call('POST', '/rest/api/3/issue', {
      fields: { project: { key: projectKey }, summary, issuetype: { name: issueType }, description: adfDoc(description.split('\n\n').map((p) => [adfText(p)])) },
    });
  }
}

const ISSUE_FIELDS = ['summary', 'description', 'issuetype', 'status', 'reporter', 'labels', 'created', 'updated', 'environment', 'attachment', 'issuelinks', 'project'];

function toIssue(raw: unknown): JiraIssue {
  const r = raw as { key: string; fields?: Record<string, any> };
  const f = r.fields ?? {};
  return {
    key: String(r.key), projectKey: String(f.project?.key ?? String(r.key).split('-')[0]),
    summary: String(f.summary ?? ''), description: adfToText(f.description).trim(),
    issueType: String(f.issuetype?.name ?? ''), status: String(f.status?.name ?? ''),
    reporter: { accountId: String(f.reporter?.accountId ?? ''), displayName: String(f.reporter?.displayName ?? '') },
    labels: Array.isArray(f.labels) ? f.labels.map(String) : [],
    created: String(f.created ?? ''), updated: String(f.updated ?? ''), environment: adfToText(f.environment).trim(),
    attachments: Array.isArray(f.attachment) ? f.attachment.map((a: any) => ({ filename: String(a.filename ?? ''), url: String(a.content ?? '') })) : [],
    links: Array.isArray(f.issuelinks) ? f.issuelinks.map((l: any) => ({ key: String(l.outwardIssue?.key ?? l.inwardIssue?.key ?? ''), type: String(l.type?.name ?? '') })) : [],
  };
}
