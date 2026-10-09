import { z } from 'zod';
import { type Issue, issue } from '../core/issues.ts';
import { hexColorSchema, idSchema, versionSchema, zodIssues } from './common.ts';

/**
 * Appearance = logical look only (equipment ids, dyes, variants). No entity id, position or animation:
 * those live on the character instance, so identical looks share caches across players.
 */
export const APPEARANCE_SCHEMA_V2 = 'uvce-appearance-v2';
export const APPEARANCE_SCHEMA_V1 = 'uvce-appearance-v1';

export const slotAssignmentSchema = z.strictObject({
  itemId: idSchema,
  /** Optional pin; when omitted the manifest's current version is used. */
  version: versionSchema.optional(),
  variant: z.string().min(1).max(64).optional(),
  dye: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), hexColorSchema).optional(),
  hidden: z.boolean().optional(),
});
export type SlotAssignment = z.infer<typeof slotAssignmentSchema>;

export const appearanceV2Schema = z.strictObject({
  schemaVersion: z.literal(APPEARANCE_SCHEMA_V2),
  rigProfileId: idSchema,
  slots: z.record(idSchema, slotAssignmentSchema),
});
export type AppearanceDefinition = z.infer<typeof appearanceV2Schema>;

/** The starter-pack proposal format (examples/appearance.example.json). Read-only legacy input. */
const legacyAssetRefSchema = z.object({ id: z.string().min(1), version: z.string().min(1), contentHash: z.string() });
export const appearanceV1Schema = z.looseObject({
  schemaVersion: z.literal(APPEARANCE_SCHEMA_V1),
  rigProfileId: z.string().min(1),
  body: legacyAssetRefSchema,
  head: legacyAssetRefSchema,
  slots: z.record(
    z.string(),
    z.object({ asset: legacyAssetRefSchema, dye: z.record(z.string(), hexColorSchema).optional(), hidden: z.boolean().optional(), variant: z.string().optional() }),
  ),
});
type AppearanceV1 = z.infer<typeof appearanceV1Schema>;

export type AppearanceParseResult =
  | { ok: true; appearance: AppearanceDefinition; migratedFrom: string | null; issues: Issue[] }
  | { ok: false; issues: Issue[] };

function migrateV1(v1: AppearanceV1): { appearance: AppearanceDefinition; issues: Issue[] } {
  const issues: Issue[] = [];
  const slots: Record<string, SlotAssignment> = {};
  const toId = (raw: string, path: string): string => {
    const id = raw.toLowerCase();
    if (id !== raw) issues.push(issue('warning', 'migrate.id-case', path, `id "${raw}" lower-cased to "${id}"`));
    return id;
  };
  const note = (path: string, hash: string): void => {
    issues.push(
      issue(
        'warning',
        'migrate.content-hash-dropped',
        path,
        hash.startsWith('demo-')
          ? 'placeholder contentHash dropped; the item is re-resolved against the compiled manifest'
          : 'contentHash dropped; v2 appearances pin versions, hashes come from the compiled manifest',
      ),
    );
  };
  slots.body = { itemId: toId(v1.body.id, '/body/id'), version: v1.body.version };
  note('/body/contentHash', v1.body.contentHash);
  slots.head = { itemId: toId(v1.head.id, '/head/id'), version: v1.head.version };
  note('/head/contentHash', v1.head.contentHash);
  for (const [slotName, entry] of Object.entries(v1.slots)) {
    const assignment: SlotAssignment = { itemId: toId(entry.asset.id, `/slots/${slotName}/asset/id`), version: entry.asset.version };
    if (entry.dye) assignment.dye = Object.fromEntries(Object.entries(entry.dye).map(([k, v]) => [k.toLowerCase(), v.toLowerCase()]));
    if (entry.hidden !== undefined) assignment.hidden = entry.hidden;
    if (entry.variant !== undefined) assignment.variant = entry.variant;
    slots[toId(slotName, `/slots/${slotName}`)] = assignment;
    note(`/slots/${slotName}/asset/contentHash`, entry.asset.contentHash);
  }
  for (const moved of ['entityId', 'animation', 'footPivotPx']) {
    if (moved in v1) {
      issues.push(issue('warning', 'migrate.field-moved', `/${moved}`, `"${moved}" is not part of an appearance in v2 (belongs to the character instance / rig) and was dropped`));
    }
  }
  return { appearance: { schemaVersion: APPEARANCE_SCHEMA_V2, rigProfileId: toId(v1.rigProfileId, '/rigProfileId'), slots }, issues };
}

/** Parses any supported appearance version and migrates it to the canonical v2 form. */
export function parseAppearance(json: unknown): AppearanceParseResult {
  const version = typeof json === 'object' && json !== null ? (json as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (version === APPEARANCE_SCHEMA_V2) {
    const parsed = appearanceV2Schema.safeParse(json);
    return parsed.success ? { ok: true, appearance: parsed.data, migratedFrom: null, issues: [] } : { ok: false, issues: zodIssues(parsed.error) };
  }
  if (version === APPEARANCE_SCHEMA_V1) {
    const parsed = appearanceV1Schema.safeParse(json);
    if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
    const { appearance, issues } = migrateV1(parsed.data);
    const check = appearanceV2Schema.safeParse(appearance);
    if (!check.success) return { ok: false, issues: [...issues, ...zodIssues(check.error, '/migrated')] };
    return { ok: true, appearance: check.data, migratedFrom: APPEARANCE_SCHEMA_V1, issues };
  }
  return {
    ok: false,
    issues: [issue('error', 'appearance.version', '/schemaVersion', `unsupported appearance schemaVersion ${JSON.stringify(version)}`)],
  };
}
