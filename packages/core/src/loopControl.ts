/** Model-authored control footers are removed before publishing the final answer. */
export const LOOP_BLOCKED_MARKER = '<harness_status>blocked</harness_status>';

export function loopResult(output: string, doneMarker: string, hasLoadedSkills: boolean) {
  const lines = output.trim().split(/\r?\n/);
  const footer = lines.at(-1)?.trim();
  const blocked = footer === LOOP_BLOCKED_MARKER;
  const done = footer === doneMarker;
  const content = blocked || done ? lines.slice(0, -1).join('\n').trim() : output.trim();
  // The skill completion audit already defines this as a final, incomplete report.
  // Do not ask a new pass to rewrite it merely because successful completion is impossible.
  const incomplete = hasLoadedSkills && /^\s*(?:#{1,6}\s+)?(?:\*\*)?RUN INCOMPLETE\b/.test(content);
  return {
    status: blocked || incomplete ? 'blocked' : done ? 'done' : 'continue',
    content,
  } as const;
}
