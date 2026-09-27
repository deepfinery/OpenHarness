import { stat } from 'node:fs/promises';

/** Full host commands are a local installation choice, never enabled by gateway instructions. */
export async function assertHostCommandAccess() {
  if (process.getuid?.() !== 0 || process.env.HOST_ACCESS !== 'true')
    throw new Error('Privileged host mode requires root, HOST_ACCESS=true, --privileged and --pid=host.');
  const [self, target] = await Promise.all([stat('/proc/self/ns/mnt'), stat('/proc/1/ns/mnt')]);
  if (self.ino === target.ino)
    throw new Error(
      'Host PID namespace is not available. Recreate the connector with --privileged --pid=host --user 0.',
    );
}
export function hostCommand(argv: string[], cwd = '/') {
  if (!cwd.startsWith('/') || cwd.includes('\0'))
    throw new Error('Host working directory must be an absolute path.');
  return [
    'nsenter',
    '--target',
    '1',
    '--mount',
    '--pid',
    '--net',
    '--uts',
    '--ipc',
    '--root',
    `--wd=${cwd}`,
    '--',
    ...argv,
  ];
}
