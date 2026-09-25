import nodemailer from 'nodemailer';
import { collection } from './db.js';
import { config } from './config.js';
import { decrypt, encrypt, HttpError, validateRemoteUrl } from './security.js';
import { emailSettingsSchema, type EmailSettings } from './schema.js';

type StoredEmailSettings = Omit<EmailSettings, 'password'> & {
  _id: string;
  ownerId: string;
  passwordEncrypted?: string;
  updatedAt: Date;
};
const settings = () => collection<StoredEmailSettings>('email_settings');

function envDefaults(): EmailSettings {
  return {
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE === 'true',
    username: config.SMTP_USER,
    password: config.SMTP_PASSWORD,
    from: config.SMTP_FROM,
    enabled: Boolean(config.SMTP_HOST),
  };
}

/** Effective SMTP configuration: the workspace's saved settings, falling back to .env values. */
export async function resolveEmailSettings(
  ownerId: string,
): Promise<EmailSettings & { source: 'workspace' | 'env' | 'none' }> {
  const saved = await settings().findOne({ _id: `${ownerId}:email` });
  if (saved?.host) {
    const { _id, ownerId: _o, passwordEncrypted, updatedAt, ...rest } = saved;
    return { ...rest, password: passwordEncrypted ? decrypt(passwordEncrypted) : '', source: 'workspace' };
  }
  const env = envDefaults();
  return { ...env, source: env.host ? 'env' : 'none' };
}

/** What the studio may see: no password, but whether one is stored and where the config comes from. */
export async function publicEmailSettings(ownerId: string) {
  const { password, ...rest } = await resolveEmailSettings(ownerId);
  return { ...rest, hasPassword: Boolean(password) };
}

export async function saveEmailSettings(ownerId: string, input: unknown) {
  const body = emailSettingsSchema.parse(input);
  // The same private-network rules as model and MCP endpoints apply to the mail relay.
  if (body.host)
    try {
      await validateRemoteUrl(`http://${body.host}:${body.port}`);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, `SMTP host ${body.host} could not be resolved. Check the hostname.`);
    }
  const previous = await settings().findOne({ _id: `${ownerId}:email` });
  const { password, ...rest } = body;
  const passwordEncrypted =
    password === undefined ? previous?.passwordEncrypted : password ? encrypt(password) : '';
  await settings().updateOne(
    { _id: `${ownerId}:email` },
    { $set: { ...rest, ownerId, passwordEncrypted, updatedAt: new Date() } },
    { upsert: true },
  );
  return publicEmailSettings(ownerId);
}

export async function clearEmailSettings(ownerId: string) {
  await settings().deleteOne({ _id: `${ownerId}:email` });
}

function transportFor(resolved: EmailSettings) {
  if (config.SMTP_TRANSPORT === 'json') return nodemailer.createTransport({ jsonTransport: true });
  if (!resolved.host) throw new HttpError(400, 'Configure an SMTP server in Settings → Email first');
  return nodemailer.createTransport({
    host: resolved.host,
    port: resolved.port,
    secure: resolved.secure,
    ...(resolved.username ? { auth: { user: resolved.username, pass: resolved.password ?? '' } } : {}),
    connectionTimeout: 15000,
    socketTimeout: 30000,
  });
}

export type OutgoingEmail = { to: string; subject: string; text: string };
export async function sendEmail(ownerId: string, message: OutgoingEmail) {
  const resolved = await resolveEmailSettings(ownerId);
  if (!resolved.enabled && resolved.source !== 'none')
    throw new HttpError(400, 'Outgoing email is disabled for this workspace');
  const recipients = message.to
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!recipients.length) throw new Error('Email step has no recipient');
  if (recipients.length > 50) throw new Error('Email step cannot address more than 50 recipients');
  for (const r of recipients)
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(r)) throw new Error(`Invalid email recipient: ${r}`);
  const from = resolved.from || resolved.username;
  if (!from && config.SMTP_TRANSPORT !== 'json') throw new Error('Set a From address in Settings → Email');
  const transport = transportFor(resolved);
  const info = await transport.sendMail({
    from: from || 'agentic@localhost',
    to: recipients.join(', '),
    subject: message.subject.slice(0, 998),
    text: message.text.slice(0, 200000),
  });
  return { messageId: info.messageId, accepted: (info.accepted ?? []).map(String), recipients };
}
