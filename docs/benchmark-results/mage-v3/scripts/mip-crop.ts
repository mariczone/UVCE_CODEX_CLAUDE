/** Side-by-side 3x crop of the same region of the 300-crowd screenshot: with mips (left) vs mips=0 (right). */
import { readFile, writeFile } from 'node:fs/promises';
import { createImage } from 'file:///C:/Project/UVCE_CODEX_CLAUDE/src/uvce/compositor/rgba.ts';
import { decodePng, encodePng } from 'file:///C:/Project/UVCE_CODEX_CLAUDE/tools/uvce/png.ts';

const dir = 'C:/Project/UVCE_CODEX_CLAUDE/bench-data/mage-v3/mipcheck';
const a = decodePng(await readFile(`${dir}/mips/scene-300.png`)).image;
const b = decodePng(await readFile(`${dir}/nomips/scene-300.png`)).image;
const [cx, cy, cw, ch, k] = [820, 330, 280, 180, 3];
const out = createImage(cw * k * 2 + 8, ch * k);
for (const [src, ox] of [[a, 0], [b, cw * k + 8]] as const) {
  for (let y = 0; y < ch * k; y++) {
    for (let x = 0; x < cw * k; x++) {
      const si = ((cy + Math.floor(y / k)) * src.width + cx + Math.floor(x / k)) * 4;
      out.data.set(src.data.subarray(si, si + 4), (y * out.width + ox + x) * 4);
    }
  }
}
await writeFile(`${dir}/mips-vs-nomips-crop.png`, encodePng(out));
let diff = 0;
for (let i = 0; i < a.data.length; i += 4) if (Math.abs((a.data[i] as number) - (b.data[i] as number)) > 24) diff++;
console.log(`pixels differing by > 24 in red: ${diff} of ${a.width * a.height}`);
