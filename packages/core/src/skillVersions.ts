import { createHash } from 'node:crypto';
import { collection } from './db.js';
import type { Skill, Stored } from './schema.js';
export type VersionedSkill = Stored<Skill> & {
  revision?: number;
  version?: string;
  category?: string;
  vendor?: string;
  files?: Record<string, string>;
  changelog?: string;
  displayTitle?: string;
};
export function skillVersion(s: VersionedSkill) {
  return s.version ?? `1.0.${Math.max(0, (s.revision ?? 1) - 1)}`;
}
export async function snapshotSkill(s: VersionedSkill) {
  const version = skillVersion(s),
    _id = createHash('sha256').update(`${s.ownerId}:${s._id}:${version}`).digest('hex');
  await collection<VersionedSkill & { skillId: string }>('skill_versions').updateOne(
    { _id, ownerId: s.ownerId },
    { $setOnInsert: { ...s, _id, skillId: s._id, version } },
    { upsert: true },
  );
}
