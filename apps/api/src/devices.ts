// Machines API: enroll, list, sync and remove devices through the gateway; the studio's Machines page uses it.
import { Router } from 'express';
import { z } from 'zod';
import { deviceIdPattern, devicePlatforms } from '../../../packages/core/src/schema.js';
import {
  deviceToolCatalog,
  enrollMachine,
  gatewayConfigured,
  gatewayPublicUrl,
  listMachines,
  removeMachine,
  rotateMachineToken,
  syncMachines,
  updateMachine,
} from '../../../packages/core/src/devices.js';

export const devices = Router();
devices.get('/', async (req, res) => {
  res.json({ ...(await listMachines(req.principal!.tenantId)), catalog: deviceToolCatalog });
});
devices.get('/catalog', (_req, res) => {
  res.json({
    configured: gatewayConfigured(),
    publicUrl: gatewayConfigured() ? gatewayPublicUrl() : '',
    catalog: deviceToolCatalog,
  });
});
devices.post('/', async (req, res) => {
  const body = z
    .object({
      name: z.string().trim().min(1).max(100),
      deviceId: z.string().regex(deviceIdPattern).optional(),
      platform: z.enum(devicePlatforms),
      allowedTools: z.array(z.string().min(1).max(200)).max(200).default([]),
    })
    .parse(req.body);
  const deviceId =
    body.deviceId ??
    `${
      body.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'machine'
    }-${Math.random().toString(36).slice(2, 6)}`;
  res
    .status(201)
    .json(await enrollMachine(req.principal!.tenantId, { ...body, deviceId }, req.principal!.user._id));
});
devices.post('/sync', async (req, res) => {
  res.json({
    ...(await syncMachines(req.principal!.tenantId, req.principal!.user._id)),
    catalog: deviceToolCatalog,
  });
});
devices.put('/:id', async (req, res) => {
  const body = z
    .object({
      name: z.string().trim().min(1).max(100).optional(),
      allowedTools: z.array(z.string().min(1).max(200)).max(200).optional(),
      disabled: z.boolean().optional(),
    })
    .parse(req.body);
  res.json(
    await updateMachine(req.principal!.tenantId, String(req.params.id), body, req.principal!.user._id),
  );
});
devices.post('/:id/rotate-token', async (req, res) => {
  res.json(await rotateMachineToken(req.principal!.tenantId, String(req.params.id)));
});
devices.delete('/:id', async (req, res) => {
  await removeMachine(req.principal!.tenantId, String(req.params.id));
  res.status(204).end();
});
