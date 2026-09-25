import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { collection } from '../../../packages/core/src/db.js';
import { config, secureCookies } from '../../../packages/core/src/config.js';
import {
  constantEqual,
  hash,
  HttpError,
  passwordHash,
  passwordMatches,
  randomToken,
} from '../../../packages/core/src/security.js';

export type User = {
  _id: string;
  name: string;
  email: string;
  passwordHash: string;
  role: 'admin' | 'member';
  enabled: boolean;
  createdAt: Date;
  tenantId?: string;
};
type Session = { _id: string; userId: string; expiresAt: Date };
export type ApiToken = {
  _id: string;
  ownerId: string;
  name: string;
  tokenHash: string;
  agentIds: string[];
  workflowIds: string[];
  /** `harness` grants full workspace access through the Open Harness API (and read/execute on /api). */
  scopes: ('read' | 'execute' | 'harness')[];
  expiresAt: Date;
  createdAt: Date;
  createdBy?: string;
};
export type Principal = { user: User; tenantId: string; sessionHash?: string; token?: ApiToken };
declare global {
  namespace Express {
    interface Request {
      principal?: Principal;
    }
  }
}
export const publicUser = (u: User) => ({
  id: u._id,
  name: u.name,
  email: u.email,
  role: u.role,
  enabled: u.enabled,
  tenantId: u.tenantId ?? u._id,
});
export const credentialsSchema = z.object({
  email: z
    .string()
    .email()
    .max(254)
    .transform((s) => s.trim().toLowerCase()),
  password: z.string().min(12).max(256),
});
export async function rateLimit(key: string, limit: number, windowMs = 60000) {
  const bucket = Math.floor(Date.now() / windowMs);
  const records = collection<{ _id: string; count: number; expiresAt: Date }>('rate_limits');
  const result = await records.findOneAndUpdate(
    { _id: hash(`${key}:${bucket}`) },
    { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((bucket + 2) * windowMs) } },
    { upsert: true, returnDocument: 'after' },
  );
  if (result!.count > limit) throw new HttpError(429, 'Too many requests. Try again later.');
}
export async function newSession(res: Response, user: User) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + 7 * 86400000);
  await collection<Session>('sessions').insertOne({ _id: hash(token), userId: user._id, expiresAt });
  res.cookie('agentic_session', token, {
    httpOnly: true,
    secure: secureCookies,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
  return publicUser(user);
}
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    let userId: string | undefined;
    let token: ApiToken | undefined;
    let sessionHash: string | undefined;
    if (req.headers.authorization?.startsWith('Bearer ')) {
      token =
        (await collection<ApiToken>('api_tokens').findOne({
          tokenHash: hash(req.headers.authorization.slice(7)),
          expiresAt: { $gt: new Date() },
        })) ?? undefined;
      userId = token?.createdBy ?? token?.ownerId;
    } else if (typeof req.cookies.agentic_session === 'string') {
      sessionHash = hash(req.cookies.agentic_session);
      const session = await collection<Session>('sessions').findOne({
        _id: sessionHash,
        expiresAt: { $gt: new Date() },
      });
      userId = session?.userId;
    }
    if (!userId) throw new HttpError(401, 'Please sign in');
    const user = await collection<User>('users').findOne({ _id: userId, enabled: true });
    if (!user) throw new HttpError(401, 'Account unavailable');
    const tenantId = user.tenantId ?? user._id;
    if (token && token.ownerId !== tenantId) throw new HttpError(401, 'Token workspace is unavailable');
    req.principal = { user, tenantId, token, sessionHash };
    next();
  } catch (e) {
    next(e);
  }
}
export function requireSession(req: Request, _res: Response, next: NextFunction) {
  if (!req.principal?.sessionHash) return next(new HttpError(403, 'This action requires a studio session'));
  next();
}
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.principal?.user.role !== 'admin' || !req.principal.sessionHash)
    return next(new HttpError(403, 'Administrator access required'));
  next();
}
export function checkTokenScope(
  req: Request,
  scope: 'read' | 'execute',
  target?: { agentId?: string; workflowId?: string },
) {
  const token = req.principal!.token;
  if (!token || token.scopes.includes('harness')) return;
  if (!token.scopes.includes(scope)) throw new HttpError(403, `Token requires the ${scope} scope`);
  if (
    (target?.agentId && !token.agentIds.includes(target.agentId)) ||
    (target?.workflowId && !token.workflowIds.includes(target.workflowId))
  )
    throw new HttpError(403, 'Token cannot access this agent or workflow');
}
export async function setup(req: Request, res: Response) {
  await rateLimit(`setup:${req.ip}`, 10, 600000);
  const body = credentialsSchema
    .extend({ name: z.string().trim().min(1).max(100), setupToken: z.string() })
    .parse(req.body);
  if (!constantEqual(body.setupToken, config.SETUP_TOKEN))
    throw new HttpError(403, 'Invalid setup token. Find it in your local .env file.');
  // A fixed UUID makes the first-account operation atomic without replica-set transactions.
  const user: User = {
    _id: '00000000-0000-4000-8000-000000000001',
    name: body.name,
    email: body.email,
    passwordHash: await passwordHash(body.password),
    role: 'admin',
    enabled: true,
    createdAt: new Date(),
    tenantId: '00000000-0000-4000-8000-000000000001',
  };
  try {
    await collection<User>('users').insertOne(user);
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw new HttpError(409, 'Studio setup is already complete');
    throw e;
  }
  res.status(201).json(await newSession(res, user));
}
export async function login(req: Request, res: Response) {
  await rateLimit(`login:${req.ip}`, 20, 600000);
  const body = credentialsSchema.parse(req.body);
  const user = await collection<User>('users').findOne({ email: body.email, enabled: true });
  // Run the password KDF even for unknown users to avoid a cheap account oracle.
  const valid = await passwordMatches(
    body.password,
    user?.passwordHash ?? 'scrypt:00000000000000000000000000000000:' + '0'.repeat(128),
  );
  if (!user || !valid) throw new HttpError(401, 'Invalid email or password');
  res.json(await newSession(res, user));
}
export async function logout(req: Request, res: Response) {
  await collection<Session>('sessions').deleteOne({ _id: req.principal!.sessionHash! });
  res.clearCookie('agentic_session', { path: '/', httpOnly: true, sameSite: 'lax', secure: secureCookies });
  res.status(204).end();
}
export async function updateProfile(req: Request, res: Response) {
  const body = z
    .object({
      name: z.string().trim().min(1).max(100),
      email: z
        .string()
        .email()
        .max(254)
        .transform((s) => s.trim().toLowerCase()),
      currentPassword: z.string().max(256).optional(),
      newPassword: z.string().min(12).max(256).optional(),
    })
    .parse(req.body);
  const user = req.principal!.user;
  if (
    (body.newPassword || body.email !== user.email) &&
    !(await passwordMatches(body.currentPassword ?? '', user.passwordHash))
  )
    throw new HttpError(400, 'Current password is incorrect');
  const update = {
    name: body.name,
    email: body.email,
    ...(body.newPassword ? { passwordHash: await passwordHash(body.newPassword) } : {}),
  };
  await collection<User>('users').updateOne({ _id: user._id }, { $set: update });
  if (body.newPassword) {
    await collection<Session>('sessions').deleteMany({ userId: user._id });
    await newSession(res, { ...user, ...update });
  }
  res.json(publicUser({ ...user, ...update }));
}
