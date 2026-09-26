import type { Agent, Run } from './schema.js';

export type NotebookSettings = Pick<Agent, 'workspace' | 'experience'> & {
  knowledgeBaseIds?: string[];
};

/** Explicit agent/workflow choices win; a plain knowledge attachment also provides a notebook. */
export function resolveNotebook(settings?: NotebookSettings, inherited?: NotebookSettings) {
  const attached = settings?.knowledgeBaseIds?.[0];
  const workspace =
    settings?.workspace ??
    inherited?.workspace ??
    (attached ? { knowledgeBaseId: attached, offloadToolResults: true } : undefined);
  return {
    workspace,
    experience:
      settings?.experience ??
      inherited?.experience ??
      (workspace
        ? {
            enabled: Boolean(attached && !settings?.workspace && !inherited?.workspace),
            recallLimit: 3,
            learnFromFailures: true,
          }
        : undefined),
  };
}

export function memorySettings(run: Run) {
  return resolveNotebook(
    run.snapshot.workflow ?? (run.agentId ? run.snapshot.agents[run.agentId] : undefined),
  );
}

/** Include compiled resource edges and legacy saved-agent references, with workflow inheritance. */
export function notebookTargets(run: Run) {
  const root = memorySettings(run);
  return [
    root,
    ...Object.values(run.snapshot.nodeAgents ?? {}).map((agent) => resolveNotebook(agent, root)),
    ...Object.values(run.snapshot.agents).map((agent) => resolveNotebook(agent, root)),
  ].filter((settings) => settings.workspace);
}

/** A run with only agent-local notebooks can still expose those destinations in its Memory panel. */
export function runNotebookIds(run: Run) {
  return [
    ...new Set([
      ...notebookTargets(run).map((settings) => settings.workspace!.knowledgeBaseId),
      ...Object.values(run.snapshot.nodeAgents ?? {}).flatMap((agent) => agent.knowledgeBaseIds),
      ...Object.values(run.snapshot.agents).flatMap((agent) => agent.knowledgeBaseIds),
    ]),
  ];
}
