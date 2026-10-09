/**
 * Turns a source manifest into a "fully mirrored" one: every part allowMirror, W/SW/NW frames dropped (the compiler
 * derives them from E/SE/NE) and every rig's mirrored directions set to mirrors of their sources. This is the shape
 * the art spec asks for (draw N NE E SE S only); used by the art-spec generator and the mirror tests.
 */
import type { Direction8 } from '../../src/uvce/core/directions.ts';
import { MIRROR_SOURCE, mirrorRigDirections } from '../../src/uvce/core/mirror.ts';
import type { SourceManifest } from './source-schema.ts';

export const DRAWN_DIRECTIONS: readonly Direction8[] = ['N', 'NE', 'E', 'SE', 'S'];

export function fullyMirroredManifest(source: SourceManifest): SourceManifest {
  const m = structuredClone(source);
  m.rigs = m.rigs.map((rig) => mirrorRigDirections(rig));
  for (const item of m.items) {
    for (const part of item.parts) {
      part.allowMirror = true;
      for (const target of Object.keys(MIRROR_SOURCE) as Direction8[]) {
        for (const byDir of Object.values(part.clips ?? {})) delete byDir[target];
        if (part.static) delete part.static[target];
      }
    }
  }
  return m;
}
