/** Shared helpers for scripted browser runs (screenshots, benchmarks): preview server + Chromium launch. */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { type Browser, chromium } from '@playwright/test';

/** Forces ANGLE's SwiftShader backend: works on GPU-less containers; NOT representative of GPU performance. */
export const SWIFTSHADER_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

export interface PreviewServer {
  url: string;
  stop(): void;
}

/** Serves a production build (default `dist/`; another checkout's build dir for A/B runs) with COOP/COEP headers. */
export async function startPreviewServer(port: number, distDir = 'dist'): Promise<PreviewServer> {
  if (!existsSync(`${distDir}/index.html`)) throw new Error(`${distDir}/ not found: run \`pnpm build\` first`);
  const child: ChildProcess = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--outDir', distDir], {
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return { url, stop: () => child.kill() };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`preview server did not start on ${url}`);
}

export async function launchChromium(options: { swiftshader: boolean; headed?: boolean }): Promise<Browser> {
  return chromium.launch({ headless: !options.headed, args: options.swiftshader ? SWIFTSHADER_ARGS : [] });
}
