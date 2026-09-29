/**
 * Keeps an agent that can reach several machines honest about which one it is using: every machine result is
 * tagged with its origin, the prompt lists the machines, and a request that names one machine is not carried
 * out on another by mistake.
 */
export type MachineRef = {
  connectionId: string;
  name: string;
  deviceId?: string;
  hostname?: string;
  platform?: string;
};

/** The origin line prepended to every result a machine tool returns, in the trace and in what the model reads. */
export function machineTag(machine: MachineRef) {
  const parts = [machine.name];
  if (machine.hostname && machine.hostname !== machine.name) parts.push(machine.hostname);
  if (machine.deviceId && machine.deviceId !== machine.name && machine.deviceId !== machine.hostname)
    parts.push(`id ${machine.deviceId}`);
  return `[machine ${parts.join(' · ')}]`;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The machines a request names, matched as whole words on the name, device id and hostname (also the hostname's
 * first label). Short names (under three characters) are ignored: they match too much ordinary text.
 */
export function requestedMachines(request: string, machines: MachineRef[]): MachineRef[] {
  const text = request.toLowerCase();
  return machines.filter((machine) => {
    const candidates = new Set<string>();
    for (const value of [machine.name, machine.deviceId, machine.hostname, machine.hostname?.split('.')[0]])
      if (value && value.trim().length >= 3) candidates.add(value.trim().toLowerCase());
    return [...candidates].some((candidate) =>
      new RegExp(`(^|[^\\p{L}\\p{N}_])${escape(candidate)}(?=$|[^\\p{L}\\p{N}_])`, 'u').test(text),
    );
  });
}

/**
 * The prompt's roster when the agent can reach machines that no single binding pins down: which machines exist,
 * how their tools are named, and the rule that results are attributed to the machine that produced them.
 */
export function machinesNote(machines: MachineRef[], toolNames: (connectionId: string) => string[]) {
  if (!machines.length) return '';
  const lines = machines.map((machine) => {
    const tools = toolNames(machine.connectionId);
    const where = [machine.platform, machine.hostname].filter(Boolean).join(', ');
    return `- ${machine.name}${where ? ` (${where})` : ''}: tools ${tools.join(', ') || 'none'}`;
  });
  return (
    `\n\nMachines you can reach (${machines.length}). Each tool belongs to exactly one machine and its description starts with that machine’s name:\n${lines.join('\n')}\n` +
    'When the request names a machine, use only that machine’s tools. Every machine result starts with a [machine …] tag naming where it ran: attribute findings to that machine, exactly as tagged, never to the machine the request mentioned. If the request names a machine that is not listed here, say so instead of using another one.'
  );
}

/** What the model reads when it calls a tool of a machine other than the one the request named. */
export function wrongMachineNotice(called: MachineRef, wanted: MachineRef, wantedTools: string[]) {
  return (
    `Not executed: the request names the machine "${wanted.name}"${wanted.hostname ? ` (${wanted.hostname})` : ''}, but this tool belongs to "${called.name}"${called.hostname ? ` (${called.hostname})` : ''}. ` +
    `Use ${wanted.name}’s tools instead: ${wantedTools.join(', ') || 'none are attached'}. ` +
    `If the task really needs ${called.name}, call this tool again and it will run.`
  );
}
