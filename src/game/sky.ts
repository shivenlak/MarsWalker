// Mars atmosphere: butterscotch daytime sky, blue glow around a low sun (Mars sunsets are blue), sun disk,
// stars at night, plus the matching sun light, ambient light, fog and the reflection env map.

import * as THREE from "three";

const vert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // always at the far plane
}`;

const frag = /* glsl */ `
uniform vec3 uSun;      // unit vector towards the sun
uniform float uDay;     // 0 night .. 1 full day
uniform float uDust;    // 0 clear .. 1 thick dust storm
varying vec3 vDir;
float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
void main() {
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  float sunH = uSun.y;
  // dusty daytime gradient: bright butterscotch at the horizon, deeper towards zenith
  vec3 horizon = vec3(0.86, 0.63, 0.45);
  vec3 zenith  = vec3(0.47, 0.30, 0.21);
  vec3 col = mix(horizon, zenith, pow(h, 0.55));
  // twilight darkening
  col *= mix(0.03, 1.0, uDay);
  // forward-scattering blue halo around the sun, strongest when the sun is low
  float cosA = max(dot(d, uSun), 0.0);
  float halo = pow(cosA, 12.0) * 0.55 + pow(cosA, 120.0) * 0.9;
  vec3 blue = vec3(0.45, 0.62, 0.85);
  float low = 1.0 - smoothstep(0.0, 0.5, sunH);
  col += blue * halo * mix(0.25, 1.0, low) * smoothstep(-0.12, 0.05, sunH);
  // warm glow elsewhere along the horizon at dusk
  col += vec3(0.5, 0.28, 0.12) * pow(1.0 - h, 6.0) * low * 0.25 * smoothstep(-0.15, 0.05, sunH);
  // sun disk (Mars sun ~0.35 deg; drawn a bit larger)
  float disk = smoothstep(0.99996, 0.99999, cosA);
  col += vec3(1.0, 0.97, 0.92) * disk * 6.0 * smoothstep(-0.02, 0.02, sunH);
  // stars at night
  if (uDay < 0.35) {
    vec3 cell = floor(d * 300.0);
    float s = step(0.9975, hash(cell));
    col += vec3(s) * (0.35 - uDay) * 2.5 * h;
  }
  // dust storm: a flat, dim brown pall; the sun becomes a faint smudge
  vec3 pall = vec3(0.55, 0.38, 0.26) * mix(0.03, 1.0, uDay) * (1.0 - 0.55 * uDust);
  col = mix(col, pall + vec3(0.4, 0.3, 0.2) * pow(cosA, 6.0) * 0.4 * uDay, uDust);
  // below horizon: dark ground haze
  if (d.y < 0.0) col = mix(col, horizon * 0.35 * mix(0.03, 1.0, uDay), min(-d.y * 8.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class MarsSky {
  readonly mesh: THREE.Mesh;
  readonly sun = new THREE.DirectionalLight(0xfff1df, 3);
  readonly hemi = new THREE.HemisphereLight(0xd9a77c, 0x5a3420, 0.9);
  readonly fog = new THREE.FogExp2(0xc99a73, 1 / 30000);
  private uni = { uSun: { value: new THREE.Vector3(0, 1, 0) }, uDay: { value: 1 }, uDust: { value: 0 } };
  readonly sunDir = new THREE.Vector3(0, 1, 0);
  private envScene = new THREE.Scene();
  private envSky: THREE.Mesh;
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private lastEnvSun = new THREE.Vector3(0, -2, 0);

  constructor(renderer: THREE.WebGLRenderer) {
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader: frag, uniforms: this.uni,
      side: THREE.BackSide, depthWrite: false, depthTest: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
    this.mesh.scale.setScalar(1000);
    this.envSky = new THREE.Mesh(this.mesh.geometry, mat);
    this.envSky.scale.setScalar(100);
    this.envScene.add(this.envSky);
    this.pmrem = new THREE.PMREMGenerator(renderer);

    const s = this.sun;
    s.castShadow = true;
    s.shadow.mapSize.set(2048, 2048);
    s.shadow.camera.near = 1;
    s.shadow.camera.far = 400;
    const e = 45;
    Object.assign(s.shadow.camera, { left: -e, right: e, top: e, bottom: -e });
    s.shadow.bias = -0.0004;
    s.shadow.normalBias = 0.04;
  }

  /** elevDeg/azDeg: sun position; az 0 = north (-Z), clockwise (east = +X). */
  /** Atmospheric dust optical depth (tau). ~0.6 is a clear Gale day; regional storms reach several. */
  tau = 0.6;

  setSun(elevDeg: number, azDeg: number) {
    const el = (elevDeg * Math.PI) / 180, az = (azDeg * Math.PI) / 180;
    this.sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az));
    this.uni.uSun.value.copy(this.sunDir);
    const day = THREE.MathUtils.smoothstep(elevDeg, -12, 8);
    this.uni.uDay.value = day;
    const lowSun = 1 - THREE.MathUtils.smoothstep(elevDeg, 0, 30);
    // Beer-Lambert: direct sunlight falls as exp(-tau / sin(elev)); normalised to a clear (tau 0.6) noon
    const mu = Math.max(Math.sin(el), 0.05);
    const direct = Math.min(1.2, Math.exp(-this.tau / mu) / Math.exp(-0.6));
    const dust = THREE.MathUtils.clamp((this.tau - 0.6) / 4, 0, 1);
    this.uni.uDust.value = dust;
    this.sun.intensity = 3.2 * THREE.MathUtils.smoothstep(elevDeg, -1, 10) * (1 - 0.35 * lowSun) * (this.tau > 0.65 ? direct : 1);
    this.sun.color.setRGB(1, 0.95 - 0.12 * lowSun, 0.88 - 0.2 * lowSun);
    this.hemi.intensity = (0.15 + 1.0 * day) * (1 - 0.45 * dust); // diffuse light holds up better than direct
    this.fog.color.setRGB(0.79, 0.6, 0.45).multiplyScalar((0.06 + 0.94 * day) * (1 - 0.5 * dust));
    // visibility: clear ~30 km fog scale, down to a few hundred metres in a thick storm
    // exponential, so a moderate storm already hazes the horizon and a thick one closes in to ~170 m
    this.fog.density = 1 / (30000 * Math.pow(150 / 30000, dust));
  }

  /** Keep the shadow camera centred on the player. */
  follow(target: THREE.Vector3) {
    this.sun.position.copy(target).addScaledVector(this.sunDir, 200);
    this.sun.target.position.copy(target);
    this.sun.target.updateMatrixWorld();
    this.mesh.position.copy(target);
  }

  /** Re-render the reflection environment (visor) when the sun has moved noticeably. */
  envMap(): THREE.Texture | null {
    if (this.envRT && this.lastEnvSun.distanceTo(this.sunDir) < 0.05) return this.envRT.texture;
    this.envRT?.dispose();
    this.envRT = this.pmrem.fromScene(this.envScene, 0, 0.1, 1000);
    this.lastEnvSun.copy(this.sunDir);
    return this.envRT.texture;
  }
}
