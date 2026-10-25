// Waterfalls where a pass river pours over the head wall of a fjord (world.waterfalls). The sheet follows the actual
// cliff profile: it is sampled from world.height along the flow line, so it hugs the rock. Streaks of foam run
// down it, and billows of mist and a ring of foam hide the plunge into the sea.
import * as THREE from 'three';
import { rng } from '../../../shared/math.js';

export function createWaterfalls(world, timeU) {
  const group = new THREE.Group();
  group.name = 'waterfalls';
  if (!world.waterfalls || !world.waterfalls.length) return group;

  const fallMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { time: timeU }]),
    fog: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform float time;
      varying vec2 vUv;
      float h1(float x) { return fract(sin(x * 91.7) * 43758.5); }
      float n1(float x) { float i = floor(x), f = fract(x); return mix(h1(i), h1(i + 1.0), f * f * (3.0 - 2.0 * f)); }
      void main() {
        float fall = vUv.y; // 0 at the lip, 1 at the sea
        float x = vUv.x;
        float streak = n1(x * 26.0 + 3.0) * 0.6 + n1(x * 71.0) * 0.4;
        float sp = 5.0 + 2.5 * n1(x * 13.0);
        float flow = n1(x * 17.0 + floor(fall * 40.0 - time * sp));
        float flow2 = n1(x * 53.0 + 7.0 + floor(fall * 110.0 - time * sp * 1.8));
        float sheet = smoothstep(0.22, 0.72, streak + (flow - 0.5) * 0.7 + (flow2 - 0.5) * 0.3);
        float edge = smoothstep(0.0, 0.14, x) * smoothstep(1.0, 0.86, x);
        float lip = 1.0 - smoothstep(0.0, 0.05, fall);
        float base = smoothstep(0.82, 1.0, fall);
        float a = (0.55 + sheet * 0.45) * edge;
        a = clamp(a + lip * 0.35 + base * 0.4, 0.0, 1.0) * 0.92;
        vec3 water = mix(vec3(0.55, 0.76, 0.86), vec3(1.0), sheet * 0.75 + lip + base * 0.6);
        gl_FragColor = vec4(water * (0.9 + 0.5 * sheet) * 1.15, a);
        #include <fog_fragment>
      }`,
  });

  const mistTex = (() => {
    const S = 128, c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gr.addColorStop(0, 'rgba(255,255,255,0.9)');
    gr.addColorStop(0.35, 'rgba(235,245,255,0.45)');
    gr.addColorStop(1, 'rgba(225,238,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, S, S);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const mistUniforms = { time: timeU, map: { value: mistTex }, scale: { value: 1000 } };
  const mistMat = new THREE.ShaderMaterial({
    uniforms: mistUniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      attribute vec4 aMist;
      uniform float scale; uniform float time;
      varying float vK;
      void main() {
        vec3 p = position + vec3(sin(time * 0.7 + aMist.x * 9.0), sin(time * 0.5 + aMist.y * 7.0) * 0.6, cos(time * 0.6 + aMist.x * 5.0)) * aMist.w;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(aMist.z * scale / max(1.0, -mv.z), 2.0, 260.0);
        vK = exp(length(mv.xyz) * -0.00018) * (0.8 + 0.2 * sin(time * 1.7 + aMist.x * 20.0));
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      varying float vK;
      void main() { float a = texture2D(map, gl_PointCoord).a; gl_FragColor = vec4(vec3(0.9, 0.95, 1.0) * a * vK * 0.5, a * vK * 0.7); }`,
  });

  const mistPos = [], mistAttr = [];
  for (const w of world.waterfalls) {
    const r = rng(w.seed);
    // flow line from the lip: the terrain surface just in front of it, never rising
    const N = 36, run = 90;
    let yPrev = w.y + 1.4;
    const line = [];
    for (let i = 0; i <= N; i++) {
      const s = (i / N) * run;
      const x = w.x + w.dx * s, z = w.z + w.dz * s;
      const y = Math.min(yPrev, Math.max(world.height(x, z), 0) + 1.6);
      line.push([x, y, z]);
      yPrev = y;
    }
    // stop where the water meets the sea
    let end = line.findIndex((p) => p[1] <= 2.4);
    if (end < 0) end = N;
    const seg = line.slice(0, end + 1);
    const nx = -w.dz, nz = w.dx;
    const pos = [], uv = [], idx = [];
    // the sheet starts a little upstream so there is no gap at the lip
    for (let i = 0; i < seg.length; i++) {
      const t = i / (seg.length - 1);
      const half = (w.width * 0.5) * (1 + t * 1.5);
      for (const sgn of [-1, 1]) {
        pos.push(seg[i][0] + nx * half * sgn, seg[i][1], seg[i][2] + nz * half * sgn);
        uv.push(sgn < 0 ? 0 : 1, t);
      }
      if (i) { const a = (i - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, fallMat);
    mesh.renderOrder = 3;
    group.add(mesh);
    // mist and foam at the plunge pool, a wisp along the lower half
    const bot = seg[seg.length - 1];
    for (let i = 0; i < 34; i++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * w.width * 1.3;
      mistPos.push(bot[0] + Math.cos(a) * d, 1.5 + r() * 14, bot[2] + Math.sin(a) * d);
      mistAttr.push(r(), r(), 26 + r() * 40, 2 + r() * 4);
    }
    for (let i = 0; i < 14; i++) {
      const k = seg[Math.floor((0.45 + 0.55 * r()) * (seg.length - 1))];
      mistPos.push(k[0] + w.dx * (3 + r() * 6) + nx * (r() - 0.5) * w.width, k[1], k[2] + w.dz * (3 + r() * 6) + nz * (r() - 0.5) * w.width);
      mistAttr.push(r(), r(), 18 + r() * 28, 1.5 + r() * 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(mistPos, 3));
  g.setAttribute('aMist', new THREE.Float32BufferAttribute(mistAttr, 4));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 100, 0), 3000);
  const pts = new THREE.Points(g, mistMat);
  pts.frustumCulled = false;
  pts.renderOrder = 4;
  group.add(pts);

  group.userData.update = (renderer) => {
    if (renderer) mistUniforms.scale.value = renderer.domElement.height * 0.5;
  };
  return group;
}
