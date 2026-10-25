// Sky, sun and aerial perspective.
// The sky is the Poly Haven "Kloofendal 48d Partly Cloudy (Pure Sky)" HDRI, stored as an sRGB JPEG of
// hdr * skyScale (see tools/prepare_assets.py); the dome shader decodes it back to linear HDR so it goes
// through the same tone mapping as the world. Fog is exponential height fog, replacing three.js's fog chunks
// for every material, tinted toward the sun so distant mountains blend into the HDRI's haze.
import * as THREE from 'three';

export const SKY = {
  sunDir: new THREE.Vector3(0.5543, 0.7418, 0.3775).normalize(),
  skyScale: 0.22,
  minElevation: -12,
  horizon: new THREE.Color(0.43, 0.462, 0.56),
  sunColor: new THREE.Color(1.0, 0.94, 0.86),
};

export function configureSky(json) {
  if (!json) return;
  SKY.sunDir.set(...json.sun).normalize();
  SKY.skyScale = json.skyScale;
  SKY.minElevation = json.minElevation;
  SKY.horizon.setRGB(...json.horizon);
}

const FOG_HEIGHT = 650; // m: fog density halves every ~450 m of altitude
const FOG_DENSITY = 0.000105;

// ---- aerial perspective: the haze colour is read straight out of the HDRI, per view direction, so distant
// mountains, islands and clouds dissolve into exactly the sky behind them.
const FOG_AZ = 24, FOG_EL = 8;
let fogTable = null; // Float32Array(FOG_AZ * FOG_EL * 3) of linear colours
const elevOfRow = (r) => Math.pow(r / (FOG_EL - 1), 2) * 90; // degrees; denser rows near the horizon

export function buildFogTable(image) {
  try {
    const W = 1024, H = Math.round(W * (image.height / image.width));
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(image, 0, 0, W, H);
    const px = g.getImageData(0, 0, W, H).data;
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const vMin = (SKY.minElevation + 90) / 180;
    const out = new Float32Array(FOG_AZ * FOG_EL * 3);
    for (let r = 0; r < FOG_EL; r++) {
      for (let a = 0; a < FOG_AZ; a++) {
        const acc = [0, 0, 0];
        let n = 0;
        // average a patch (about 14 deg wide) so photographic cloud detail doesn't leak into the haze
        for (let da = -3; da <= 3; da++) {
          for (let de = -2; de <= 2; de++) {
            const az = ((a + 0.5) / FOG_AZ + da * 0.0075);
            const el = Math.min(88, Math.max(0.5, elevOfRow(r) + de * (r === 0 ? 1.2 : 2.5)));
            const v = el / 180 + 0.5;
            const t = Math.min(0.998, Math.max(0.002, (v - vMin) / (1 - vMin)));
            const x = Math.min(W - 1, Math.max(0, Math.floor((((az % 1) + 1) % 1) * W)));
            const y = Math.min(H - 1, Math.max(0, Math.floor((1 - t) * H)));
            const k = (y * W + x) * 4;
            acc[0] += lin(px[k]); acc[1] += lin(px[k + 1]); acc[2] += lin(px[k + 2]);
            n++;
          }
        }
        const o = (r * FOG_AZ + a) * 3;
        const sc = 1 / (SKY.skyScale * n);
        out[o] = acc[0] * sc; out[o + 1] = acc[1] * sc; out[o + 2] = acc[2] * sc;
      }
    }
    fogTable = out;
  } catch (e) {
    fogTable = null;
  }
}

// Height-fog GLSL shared by every material's fog chunk, the ocean and the cloud march. Needs cameraPosition.
export function fogFunctions() {
  const v3 = (v) => `vec3(${v.x.toFixed(5)}, ${v.y.toFixed(5)}, ${v.z.toFixed(5)})`;
  const c3 = (c) => `vec3(${c.r.toFixed(5)}, ${c.g.toFixed(5)}, ${c.b.toFixed(5)})`;
  const sunFog = SKY.horizon.clone().lerp(new THREE.Color(1.25, 1.12, 0.95), 0.75);
  const table = fogTable
    ? `const vec3 FOG_TAB[${FOG_AZ * FOG_EL}] = vec3[${FOG_AZ * FOG_EL}](${Array.from({ length: FOG_AZ * FOG_EL }, (_, i) => `vec3(${fogTable[i * 3].toFixed(4)},${fogTable[i * 3 + 1].toFixed(4)},${fogTable[i * 3 + 2].toFixed(4)})`).join(',')});
  vec3 hazeTable(vec3 dir) {
    float az = (atan(dir.z, dir.x) * 0.15915494 + 0.5) * ${FOG_AZ}.0 - 0.5;
    float r = clamp(sqrt(max(asin(clamp(dir.y, -1.0, 1.0)), 0.0) * 0.63661977) * ${(FOG_EL - 1).toFixed(1)}, 0.0, ${(FOG_EL - 1).toFixed(1)});
    int a0 = int(floor(az)), r0 = int(min(floor(r), ${(FOG_EL - 2).toFixed(1)}));
    float fa = az - floor(az), fr = r - float(r0);
    int a1 = ((a0 + 1) % ${FOG_AZ} + ${FOG_AZ}) % ${FOG_AZ};
    a0 = (a0 % ${FOG_AZ} + ${FOG_AZ}) % ${FOG_AZ};
    vec3 c0 = mix(FOG_TAB[r0 * ${FOG_AZ} + a0], FOG_TAB[r0 * ${FOG_AZ} + a1], fa);
    vec3 c1 = mix(FOG_TAB[(r0 + 1) * ${FOG_AZ} + a0], FOG_TAB[(r0 + 1) * ${FOG_AZ} + a1], fa);
    return mix(c0, c1, fr);
  }`
    : `vec3 hazeTable(vec3 dir) { return ${c3(SKY.horizon)}; }`;
  return /* glsl */ `
  ${table}
  float heightFogAmount(vec3 ray) {
    float dist = length(ray);
    float dy = ray.y;
    float H = ${FOG_HEIGHT.toFixed(1)};
    float camTerm = exp(-max(cameraPosition.y, -50.0) / H);
    float integral = abs(dy) > 0.5 ? camTerm * H * (1.0 - exp(-dy / H)) / dy * dist : camTerm * dist;
    return 1.0 - exp(-${FOG_DENSITY.toFixed(6)} * max(integral, 0.0));
  }
  vec3 heightFogColor(vec3 dir) {
    float s = max(dot(dir, ${v3(SKY.sunDir)}), 0.0);
    // looking down at the sea or land the haze is the horizon's; the sun adds a warm forward-scattering glow
    vec3 base = hazeTable(dir);
    // over open water the haze is bluer and deeper than the sky it meets at the horizon
    float down = smoothstep(0.025, -0.035, dir.y);
    base *= mix(vec3(1.0), vec3(0.62, 0.8, 1.08), down * 0.9);
    return mix(base, base + ${c3(sunFog)} * 0.28 * (1.0 - down * 0.7), pow(s, 6.0));
  }`;
}

// Replace three.js's fog with height fog. Must run before any material compiles.
export function patchFog() {
  THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying vec3 vFogWorld;
#endif`;
  // world position from the view-space position every material computes (works for skinned, instanced, sprites)
  THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogWorld = transpose(mat3(viewMatrix)) * mvPosition.xyz + cameraPosition;
#endif`;
  THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  uniform float fogDensity;
  uniform float fogNear; // cloud drift (m), see SkyFog
  uniform float fogFar;
  varying vec3 vFogWorld;
  ${fogFunctions()}
#endif`;
  THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  {
    vec3 fogRay = vFogWorld - cameraPosition;
    float fogF = heightFogAmount(fogRay);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, heightFogColor(normalize(fogRay)), fogF);
  }
#endif`;
}

// three.js refreshes fogColor, fogNear and fogFar on every fog-enabled material each frame. We don't use linear
// fog, so near/far carry the cloud drift (x, z in metres) to every shader that shades cloud shadows.
export class SkyFog extends THREE.Fog {
  constructor(color) {
    super(color, 0, 0);
    this.density = FOG_DENSITY;
  }

  setDrift(x, z) {
    this.near = x;
    this.far = z;
  }
}

export function createFog() {
  return new SkyFog(SKY.horizon.clone());
}

// The sky dome: a big sphere that follows the camera.
export function createSky(texture) {
  texture.colorSpace = THREE.NoColorSpace; // decoded manually below
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  const vMin = (SKY.minElevation + 90) / 180;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      sky: { value: texture },
      sunDir: { value: SKY.sunDir },
      sunColor: { value: SKY.sunColor },
      scale: { value: 1 / SKY.skyScale },
      haze: { value: SKY.horizon },
      brightness: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww; // at the far plane
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D sky;
      uniform vec3 sunDir, sunColor, haze;
      uniform float scale, brightness;
      varying vec3 vDir;
      ${fogFunctions()}
      vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
      void main() {
        vec3 d = normalize(vDir);
        float u = atan(d.z, d.x) * 0.15915494 + 0.5;
        float v = asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5;
        float t = clamp((v - ${vMin.toFixed(5)}) / ${(1 - vMin).toFixed(5)}, 0.002, 0.998);
        vec3 col = toLinear(texture2D(sky, vec2(u, t)).rgb) * scale;
        // below the image: fade to haze
        col = mix(hazeTable(normalize(vec3(d.x, 0.03, d.z))), col, smoothstep(${vMin.toFixed(4)} - 0.01, ${vMin.toFixed(4)} + 0.02, v));
        float s = dot(d, sunDir);
        col += sunColor * (smoothstep(0.99996, 0.99999, s) * 60.0 + pow(max(s, 0.0), 900.0) * 6.0 + pow(max(s, 0.0), 60.0) * 0.35 + pow(max(s, 0.0), 16.0) * 0.025);
        gl_FragColor = vec4(col * brightness, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1000, 64, 32), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.onBeforeRender = (renderer, scene, camera) => mesh.position.copy(camera.position);
  return mesh;
}

// Clamp the sun out of the environment HDR before PMREM so it isn't counted twice (the directional light is the sun).
export function tameEnvironment(tex, maxValue = 24) {
  const d = tex.image.data;
  if (d instanceof Float32Array) {
    for (let i = 0; i < d.length; i += 4) {
      const m = Math.max(d[i], d[i + 1], d[i + 2]);
      if (m > maxValue) {
        const k = maxValue / m;
        d[i] *= k; d[i + 1] *= k; d[i + 2] *= k;
      }
    }
  }
  tex.needsUpdate = true;
  return tex;
}
