// Pre-enrolled devices from the environment (tests, demos, fleets provisioned by configuration management).
import { z } from 'zod';
import { deviceIdPattern, platforms, type Logger } from '@openharness/connector-core';
import type { Registry } from './registry.js';
import { hashDeviceToken } from './tokens.js';

const bootstrapSchema = z.array(
  z.object({
    device_id: z.string().regex(deviceIdPattern),
    name: z.string().max(100).default(''),
    platform: z.enum(platforms),
    token: z.string().min(16).max(512),
    owner: z.string().max(200).default(''),
    allowed_tools: z.array(z.string()).max(200).default([]),
  }),
);
export async function applyBootstrapDevices(spec: string | undefined, registry: Registry, log: Logger) {
  if (!spec) return;
  for (const device of bootstrapSchema.parse(JSON.parse(spec))) {
    if (await registry.get(device.device_id)) continue;
    const { token, ...rest } = device;
    await registry.create({
      ...rest,
      token_hash: await hashDeviceToken(token),
      created_at: new Date().toISOString(),
      disabled: false,
    });
    log.info('bootstrap device enrolled', { device_id: device.device_id, platform: device.platform });
  }
}
