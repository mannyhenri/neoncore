/** Keep queueable offline cartridges, while honoring the user's dismissed-cartridge view. */
export function workflowAgentOptions<T extends { dismissedAt?: string }>(agents: readonly T[]): T[] {
  return agents.filter((agent) => !agent.dismissedAt);
}
