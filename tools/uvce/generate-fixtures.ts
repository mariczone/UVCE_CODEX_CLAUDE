/**
 * Deterministic seeded synthetic fixture generator (no network, no AI tools).
 *   node tools/uvce/generate-fixtures.ts [--out assets/source/uvce-synthetic] [--seed 1337]
 * Same seed => byte-identical PNGs and manifest. Output is SYNTHETIC TEST ART for renderer correctness.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DIRECTIONS, type Direction8, byDirection } from '../../src/uvce/core/directions.ts';
import { formatIssues } from '../../src/uvce/core/issues.ts';
import type { RgbaImage } from '../../src/uvce/compositor/rgba.ts';
import { drawArmFrontLayer, drawArmor, drawBodyLayer, drawHairBack, drawHairFront, drawHat, drawHeadLayer, drawWeapon } from './fixture-art.ts';
import { computeBodyPose, restSockets } from './fixture-pose.ts';
import { ALIASES, ART_STATUS, CLIPS, DEFAULT_SEED, GENERATOR_NAME, GENERATOR_VERSION, ITEMS, buildRig } from './fixture-spec.ts';
import { encodePng } from './png.ts';
import { SOURCE_MANIFEST_SCHEMA, type SourceFrame, type SourceItem, type SourceManifest, type SourcePart, parseSourceManifest } from './source-schema.ts';

export const DEFAULT_SOURCE_DIR = 'assets/source/uvce-synthetic';

export interface GenerateOptions {
  outDir: string;
  seed: number;
}

export interface GenerateResult {
  manifest: SourceManifest;
  files: number;
  bytes: number;
}

function staticImage(itemId: string, layer: string, direction: Direction8, seed: number): RgbaImage | null {
  switch (layer) {
    case 'head':
      return drawHeadLayer(direction);
    case 'hair_back':
      return drawHairBack(itemId, direction, seed);
    case 'hair_front':
      return drawHairFront(itemId, direction);
    case 'hat':
      return drawHat(itemId, direction, seed);
    case 'armor':
      return drawArmor(itemId, direction, seed);
    case 'weapon':
      return drawWeapon(itemId, direction);
    default:
      throw new Error(`no static art for layer ${layer}`);
  }
}

export async function generateFixtures(options: GenerateOptions): Promise<GenerateResult> {
  const { outDir, seed } = options;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError(`seed must be a uint32, got ${seed}`);
  await rm(outDir, { recursive: true, force: true });
  let files = 0;
  let bytes = 0;
  const write = async (rel: string, image: RgbaImage): Promise<void> => {
    const path = join(outDir, rel);
    await mkdir(dirname(path), { recursive: true });
    const png = encodePng(image);
    await writeFile(path, png);
    files++;
    bytes += png.byteLength;
  };
  const rest = byDirection((d) => restSockets(d));
  const rig = buildRig(rest);
  const items: SourceItem[] = [];
  for (const spec of ITEMS) {
    const parts: SourcePart[] = [];
    for (const partSpec of spec.parts) {
      const part: SourcePart = { layer: partSpec.layer, attach: partSpec.attach, representation: 'FRAME', allowMirror: false };
      if (partSpec.animated) {
        const clips: NonNullable<SourcePart['clips']> = {};
        for (const clip of CLIPS) {
          const byDir: Partial<Record<Direction8, SourceFrame[]>> = {};
          for (const dir of DIRECTIONS) {
            const frames: SourceFrame[] = [];
            for (let f = 0; f < clip.frameDurationsMs.length; f++) {
              const pose = computeBodyPose(clip.id, dir, f);
              const image = partSpec.layer === 'body' ? drawBodyLayer(pose) : drawArmFrontLayer(pose);
              if (!image) break; // part absent in this direction
              const file = `${spec.id}/${partSpec.layer}/${clip.id}/${dir}/${String(f).padStart(3, '0')}.png`;
              await write(file, image);
              frames.push(partSpec.layer === rig.socketDriverLayer ? { file, sockets: { ...pose.sockets } } : { file });
            }
            if (frames.length > 0) byDir[dir] = frames;
          }
          clips[clip.id] = byDir;
        }
        part.clips = clips;
      } else {
        const stat: NonNullable<SourcePart['static']> = {};
        for (const dir of DIRECTIONS) {
          const image = staticImage(spec.id, partSpec.layer, dir, seed);
          if (!image) continue;
          const file = `${spec.id}/${partSpec.layer}/static/${dir}.png`;
          await write(file, image);
          const anchor = partSpec.attach === 'root' ? undefined : rest[dir][partSpec.attach];
          stat[dir] = anchor ? { file, anchor: { ...anchor } } : { file };
        }
        part.static = stat;
      }
      parts.push(part);
    }
    items.push({ id: spec.id, version: '1', slot: spec.slot, rigProfileId: rig.id, displayName: spec.displayName, filter: 'linear', ...(spec.atlasGroup ? { atlasGroup: spec.atlasGroup } : {}), parts });
  }
  const manifest: SourceManifest = {
    schemaVersion: SOURCE_MANIFEST_SCHEMA,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION, seed, artStatus: ART_STATUS },
    rigs: [rig],
    clips: CLIPS,
    items,
    aliases: ALIASES,
  };
  const check = parseSourceManifest(manifest);
  if (!check.ok) throw new Error(`generator produced an invalid source manifest:\n${formatIssues(check.issues)}`);
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(outDir, 'source-manifest.json'), json);
  files++;
  bytes += Buffer.byteLength(json);
  return { manifest, files, bytes };
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

// pathToFileURL: a hand-built `file://${argv[1]}` never matches on Windows (backslashes, missing third slash).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const outDir = argValue(args, '--out') ?? DEFAULT_SOURCE_DIR;
  const seed = Number(argValue(args, '--seed') ?? DEFAULT_SEED);
  const t0 = performance.now();
  const result = await generateFixtures({ outDir, seed });
  const ms = (performance.now() - t0).toFixed(0);
  console.log(`[generate:fixtures] seed=${seed} -> ${outDir}: ${result.files} files, ${(result.bytes / 1024).toFixed(1)} KiB in ${ms} ms`);
}
