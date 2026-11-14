// Real terrain for the walk: 2 m HiRISE DTM heightmap + HiRISE colour + 1 m normals, in 512 m chunks
// with distance LOD, plus a ~110 km HRSC-MOLA backdrop (Mount Sharp, crater rim) with planet curvature.
// World coords: X = east, Z = south (m from the DTM NW corner), Y = elevation - yRef.

import * as THREE from "three";
import { R_MARS, type XY } from "../core/grid";

export interface WorldMeta {
  width: number; depth: number; originX: number; originY: number; yRef: number;
  height: { file: string; cols: number; rows: number; spacing: number; min: number; max: number };
  chunkSize: number;
  chunks: { i: number; j: number; x0: number; z0: number; w: number; h: number }[];
  overview: { file: string; mpp: number };
  backdrop: { file: string; color: string; n: number; postM: number; x0: number; z0: number };
  sources: Record<string, string>;
}

export class Terrain {
  readonly meta: WorldMeta;
  private h: Float32Array; // metres relative to yRef, row 0 = north
  readonly group = new THREE.Group();
  private detailTex: THREE.Texture;
  readonly detailUniforms = {
    uCamPos: { value: new THREE.Vector3() },
    uOv: { value: null as THREE.Texture | null },
    uOvMix: { value: 0 },
    uOvRect: { value: new THREE.Vector4(0, 0, 1, 1) }, // world x0, z0, width, depth covered by the overlay
  };

  /** Drape a data layer on the terrain (null = off). rect in world metres. */
  setOverlay(tex: THREE.Texture | null, rect?: { x0: number; z0: number; w: number; h: number }, mix = 0.7) {
    this.detailUniforms.uOv.value = tex;
    this.detailUniforms.uOvMix.value = tex ? mix : 0;
    if (rect) this.detailUniforms.uOvRect.value.set(rect.x0, rect.z0, rect.w, rect.h);
  }

  private constructor(meta: WorldMeta, h: Float32Array) {
    this.meta = meta;
    this.h = h;
    this.detailTex = makeDetailTexture();
  }

  static async load(): Promise<Terrain> {
    const meta: WorldMeta = await (await fetch("world/world.json")).json();
    const raw = new Uint16Array(await (await fetch(meta.height.file)).arrayBuffer());
    const { min, max } = meta.height;
    const h = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) h[i] = min + (raw[i] / 65535) * (max - min) - meta.yRef;
    return new Terrain(meta, h);
  }

  // ---------- coordinates ----------
  toWorld(p: XY): { x: number; z: number } {
    return { x: p.x - this.meta.originX, z: this.meta.originY - p.y };
  }
  toProj(x: number, z: number): XY {
    return { x: x + this.meta.originX, y: this.meta.originY - z };
  }
  lonLat(x: number, z: number) {
    const p = this.toProj(x, z);
    return { lon: (p.x / R_MARS) * 180 / Math.PI, lat: (p.y / R_MARS) * 180 / Math.PI };
  }
  inside(x: number, z: number, margin = 0) {
    return x >= margin && z >= margin && x <= this.meta.width - margin && z <= this.meta.depth - margin;
  }

  /** Bilinear height (world Y) at world x, z. Samples are 2 m block means centred at (2c+1, 2r+1). */
  heightAt(x: number, z: number): number {
    const { cols, rows, spacing } = this.meta.height;
    const u = Math.min(Math.max(x / spacing - 0.5, 0), cols - 1.001);
    const v = Math.min(Math.max(z / spacing - 0.5, 0), rows - 1.001);
    const c = Math.floor(u), r = Math.floor(v), fu = u - c, fv = v - r;
    const i = r * cols + c;
    const a = this.h[i], b = this.h[i + 1], d = this.h[i + cols], e = this.h[i + cols + 1];
    return (a * (1 - fu) + b * fu) * (1 - fv) + (d * (1 - fu) + e * fu) * fv;
  }

  /** Surface gradient (dY/dx, dY/dz) over +-1 m. */
  gradient(x: number, z: number): [number, number] {
    return [
      (this.heightAt(x + 1, z) - this.heightAt(x - 1, z)) / 2,
      (this.heightAt(x, z + 1) - this.heightAt(x, z - 1)) / 2,
    ];
  }
  slopeDeg(x: number, z: number): number {
    const [gx, gz] = this.gradient(x, z);
    return Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI;
  }
  normalAt(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const [gx, gz] = this.gradient(x, z);
    return out.set(-gx, 1, -gz).normalize();
  }

  // ---------- meshes ----------
  build(renderer: THREE.WebGLRenderer, onProgress: (f: number) => void): Promise<void> {
    const loader = new THREE.TextureLoader();
    const aniso = renderer.capabilities.getMaxAnisotropy();
    const chunks = this.meta.chunks;
    let done = 0;
    const jobs = chunks.map(async (c) => {
      const [map, nrm] = await Promise.all([
        loader.loadAsync(`world/chunks/c${c.i}_${c.j}.jpg`),
        loader.loadAsync(`world/chunks/n${c.i}_${c.j}.jpg`),
      ]);
      map.colorSpace = THREE.SRGBColorSpace;
      map.anisotropy = aniso;
      nrm.anisotropy = aniso;
      const mat = this.terrainMaterial(map, nrm);
      const lod = new THREE.LOD();
      for (const [step, dist] of [[2, 0], [4, 700], [8, 1600]] as const) {
        const mesh = new THREE.Mesh(this.chunkGeometry(c.x0, c.z0, c.w, c.h, step), mat);
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        lod.addLevel(mesh, dist);
      }
      lod.position.set(c.x0 + c.w / 2, 0, c.z0 + c.h / 2);
      // geometry is in world coords; LOD object only exists to measure camera distance from the chunk centre
      lod.children.forEach((m) => { m.position.set(-lod.position.x, 0, -lod.position.z); m.updateMatrix(); });
      this.group.add(lod);
      onProgress(++done / (chunks.length + 1));
    });
    return Promise.all(jobs).then(() => this.buildBackdrop(loader)).then(() => onProgress(1));
  }

  /** Grid of vertices every `step` m in world coords, with a 4 m skirt to hide LOD cracks. */
  private chunkGeometry(x0: number, z0: number, w: number, h: number, step: number) {
    const nx = Math.ceil(w / step), nz = Math.ceil(h / step);
    const vx = nx + 1, vz = nz + 1;
    const ring = 2 * (vx + vz) - 4;
    const pos = new Float32Array((vx * vz + ring) * 3);
    const uv = new Float32Array((vx * vz + ring) * 2);
    const at = (k: number, x: number, z: number, y: number) => {
      pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
      uv[k * 2] = (x - x0) / w; uv[k * 2 + 1] = 1 - (z - z0) / h;
    };
    for (let r = 0; r < vz; r++) {
      for (let c = 0; c < vx; c++) {
        const x = Math.min(x0 + c * step, x0 + w), z = Math.min(z0 + r * step, z0 + h);
        at(r * vx + c, x, z, this.heightAt(x, z));
      }
    }
    const idx: number[] = [];
    for (let r = 0; r < nz; r++) {
      for (let c = 0; c < nx; c++) {
        const a = r * vx + c, b = a + 1, d = a + vx, e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    }
    // skirt: walk the border, duplicate each vertex 4 m lower, stitch quads
    const border: number[] = [];
    for (let c = 0; c < vx; c++) border.push(c);
    for (let r = 1; r < vz; r++) border.push(r * vx + vx - 1);
    for (let c = vx - 2; c >= 0; c--) border.push((vz - 1) * vx + c);
    for (let r = vz - 2; r > 0; r--) border.push(r * vx);
    const base = vx * vz;
    border.forEach((v, k) => at(base + k, pos[v * 3], pos[v * 3 + 2], pos[v * 3 + 1] - 4));
    for (let k = 0; k < border.length; k++) {
      const a = border[k], b = border[(k + 1) % border.length];
      const a2 = base + k, b2 = base + ((k + 1) % border.length);
      idx.push(a, b, a2, b, b2, a2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }

  /** Standard PBR material + world-space normal map + close-range procedural grit so the ground holds up at 1.7 m eye height. */
  private terrainMaterial(map: THREE.Texture, nrm: THREE.Texture) {
    const mat = new THREE.MeshStandardMaterial({
      map, normalMap: nrm, normalMapType: THREE.ObjectSpaceNormalMap, roughness: 0.95, metalness: 0,
    });
    const detail = this.detailTex;
    const uni = this.detailUniforms;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uDetail = { value: detail };
      sh.uniforms.uCamPos = uni.uCamPos;
      sh.uniforms.uOv = uni.uOv;
      sh.uniforms.uOvMix = uni.uOvMix;
      sh.uniforms.uOvRect = uni.uOvRect;
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vWPos;")
        .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vWPos;\nuniform sampler2D uDetail;\nuniform vec3 uCamPos;\nuniform sampler2D uOv;\nuniform float uOvMix;\nuniform vec4 uOvRect;")
        .replace("#include <map_fragment>", `#include <map_fragment>
          float dCam = distance(vWPos, uCamPos);
          float near = 1.0 - smoothstep(10.0, 70.0, dCam);
          float g1 = texture2D(uDetail, vWPos.xz * 0.45).r;
          float g2 = texture2D(uDetail, vWPos.xz * 0.11 + 0.37).g;
          float grit = mix(1.0, 0.62 + 0.76 * g1 * (0.55 + 0.9 * g2), near);
          diffuseColor.rgb *= grit;
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.06, 0.97, 0.9), 0.5);
          if (uOvMix > 0.0) {
            vec2 ouv = (vWPos.xz - uOvRect.xy) / uOvRect.zw;
            if (ouv.x > 0.0 && ouv.x < 1.0 && ouv.y > 0.0 && ouv.y < 1.0) {
              vec4 ov = texture2D(uOv, vec2(ouv.x, 1.0 - ouv.y));
              diffuseColor.rgb = mix(diffuseColor.rgb, ov.rgb, uOvMix * ov.a);
            }
          }`)
        .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
          {
            // close-range micro relief: bump the normal from the grit texture (world-space -> view-space)
            vec2 q = vWPos.xz * 0.45;
            float e = 1.0 / 256.0;
            float h0 = texture2D(uDetail, q).r, hx = texture2D(uDetail, q + vec2(e, 0.0)).r, hz = texture2D(uDetail, q + vec2(0.0, e)).r;
            vec2 q2 = vWPos.xz * 1.7;
            float k0 = texture2D(uDetail, q2).r, kx = texture2D(uDetail, q2 + vec2(e, 0.0)).r, kz = texture2D(uDetail, q2 + vec2(0.0, e)).r;
            vec3 dW = vec3(-(hx - h0) - 0.5 * (kx - k0), 0.0, -(hz - h0) - 0.5 * (kz - k0)) * 6.0 * near;
            normal = normalize(normal + (viewMatrix * vec4(dW, 0.0)).xyz);
          }`);
    };
    return mat;
  }

  private async buildBackdrop(loader: THREE.TextureLoader) {
    const b = this.meta.backdrop;
    const raw = new Int16Array(await (await fetch(b.file)).arrayBuffer());
    const map = await loader.loadAsync(b.color);
    map.colorSpace = THREE.SRGBColorSpace;
    const n = b.n;
    const cx = this.meta.width / 2, cz = this.meta.depth / 2;
    const pos = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const k = r * n + c;
        const x = b.x0 + c * b.postM, z = b.z0 + r * b.postM;
        const d2 = (x - cx) ** 2 + (z - cz) ** 2;
        pos[k * 3] = x;
        pos[k * 3 + 1] = raw[k] - this.meta.yRef - d2 / (2 * R_MARS); // planet curvature drop
        pos[k * 3 + 2] = z;
        uv[k * 2] = (c + 0.5) / n; uv[k * 2 + 1] = 1 - (r + 0.5) / n;
      }
    }
    const idx = new Uint32Array((n - 1) * (n - 1) * 6);
    let q = 0;
    for (let r = 0; r < n - 1; r++) {
      for (let c = 0; c < n - 1; c++) {
        const a = r * n + c;
        idx.set([a, a + n, a + 1, a + 1, a + n, a + n + 1], q); q += 6;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map, roughness: 1, metalness: 0 }));
    mesh.receiveShadow = false;
    this.group.add(mesh);
  }
}

/** 256x256 tileable noise texture (R = fine grit, G = coarse mottling), generated at runtime. */
function makeDetailTexture(): THREE.Texture {
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  const rnd = mulberry(7);
  const grid = (cells: number) => {
    const g = Array.from({ length: cells * cells }, () => rnd());
    return (x: number, y: number) => {
      const fx = (x / N) * cells, fy = (y / N) * cells;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const s = (i: number, j: number) => g[((j % cells + cells) % cells) * cells + ((i % cells + cells) % cells)];
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      return (s(x0, y0) * (1 - sx) + s(x0 + 1, y0) * sx) * (1 - sy) + (s(x0, y0 + 1) * (1 - sx) + s(x0 + 1, y0 + 1) * sx) * sy;
    };
  };
  const o1 = grid(64), o2 = grid(32), o3 = grid(8), o4 = grid(4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const k = (y * N + x) * 4;
      const pebble = Math.max(0, o1(x, y) - 0.7) * 2.5;
      data[k] = Math.min(255, (0.55 * o1(x, y) + 0.3 * o2(x, y) + 0.15 * rnd() - pebble * 0.5) * 255);
      data[k + 1] = Math.min(255, (0.6 * o3(x, y) + 0.4 * o4(x, y)) * 255);
      data[k + 2] = 128;
      data[k + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, N, N);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

export function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
