/**
 * Browser ports for the source asset registry: network + decode (fetch + createImageBitmap) and GPU upload
 * (three.js textures). Kept in the WebGL backend folder because the upload half is three/WebGL specific.
 */
import * as THREE from 'three';
import { type PageFetcher, PageFetchError, type PageUploader } from '../../assets/source-registry.ts';
import type { CompiledPage } from '../../schema/compiled-manifest.ts';

/** Straight-alpha sRGB PNG -> premultiplied, vertically flipped ImageBitmap, decoded off the main thread. */
export function createBitmapFetcher(): PageFetcher<ImageBitmap> {
  return {
    async fetch(_page: CompiledPage, url: string, signal: AbortSignal): Promise<ImageBitmap> {
      let res: Response;
      try {
        res = await fetch(url, { signal });
      } catch (e) {
        if (signal.aborted) throw e;
        throw new PageFetchError(`network error: ${(e as Error).message}`, true);
      }
      if (!res.ok) {
        // 408/429/5xx are transient; other 4xx (e.g. 404) will not fix themselves: no retry storm.
        const transient = res.status === 408 || res.status === 429 || res.status >= 500;
        throw new PageFetchError(`HTTP ${res.status}`, transient, res.status);
      }
      const blob = await res.blob();
      try {
        // Premultiply + flip at decode time (UNPACK_* pixelStorei flags are ignored for ImageBitmaps).
        return await createImageBitmap(blob, { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none', imageOrientation: 'flipY' });
      } catch (e) {
        throw new PageFetchError(`decode failed: ${(e as Error).message}`, false);
      }
    },
    release(bitmap: ImageBitmap) {
      bitmap.close();
    },
  };
}

/** Full-chain bytes, as allocated by texStorage2D when mipmaps are generated. */
export function pageGpuBytes(page: CompiledPage, mipmapped: boolean): number {
  if (!mipmapped) return page.width * page.height * 4;
  let total = 0;
  for (let w = page.width, h = page.height; ; w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) {
    total += w * h * 4;
    if (w === 1 && h === 1) break;
  }
  return total;
}

export interface UploaderOptions {
  /** Force a filter (pixel-exact test scenes use nearest without mipmaps). */
  forceFilter: 'linear' | 'nearest' | null;
}

/**
 * Uploads a decoded page as a three.js texture. Linear pages with mipLevels > 0 get GL-generated mipmaps
 * (box-filtered in premultiplied space) and TEXTURE_MAX_LEVEL = mipLevels: deeper levels would mix images,
 * the compiler only guarantees bleed-free levels 0..mipLevels.
 */
export function createTextureUploader(three: THREE.WebGLRenderer, options: UploaderOptions): PageUploader<ImageBitmap, THREE.Texture> {
  const gl = three.getContext() as WebGL2RenderingContext;
  const useMips = (page: CompiledPage): boolean => page.mipLevels > 0 && (options.forceFilter ?? page.filter) === 'linear';
  return {
    upload(page, bitmap) {
      const tex = new THREE.Texture(bitmap);
      tex.name = page.id;
      tex.colorSpace = THREE.NoColorSpace; // raw sRGB-encoded values; blending happens in sRGB space
      tex.flipY = false; // already flipped by createImageBitmap
      tex.premultiplyAlpha = false; // already premultiplied by createImageBitmap
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      const nearest = (options.forceFilter ?? page.filter) === 'nearest';
      tex.magFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
      const mips = useMips(page);
      tex.generateMipmaps = mips;
      tex.minFilter = nearest ? THREE.NearestFilter : mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
      tex.needsUpdate = true;
      three.initTexture(tex);
      if (mips) {
        // three.js never sets TEXTURE_MAX_LEVEL; clamp sampling to the compiler's bleed-free levels.
        const glTexture = (three.properties.get(tex) as { __webglTexture?: WebGLTexture }).__webglTexture;
        if (glTexture) {
          const previous = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
          gl.bindTexture(gl.TEXTURE_2D, glTexture);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, page.mipLevels);
          gl.bindTexture(gl.TEXTURE_2D, previous);
        } else {
          // Cannot clamp => do not risk cross-image bleed: fall back to no mipmaps.
          tex.generateMipmaps = false;
          tex.minFilter = THREE.LinearFilter;
          tex.needsUpdate = true;
          three.initTexture(tex);
        }
      }
      return tex;
    },
    dispose(tex) {
      tex.dispose();
    },
    gpuBytes(page) {
      return pageGpuBytes(page, useMips(page));
    },
  };
}
