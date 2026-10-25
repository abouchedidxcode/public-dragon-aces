// Ember shrines: glowing orbs that float over each sky island and heal whoever flies through them.
// A charged shrine is a roiling molten-gold orb ringed by turning rune bands, with a faint beacon beam you can
// spot from across the map and golden motes spiralling off it. A drained one is a dim ember until it recharges.
import * as THREE from 'three';

function glowTexture() {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.2, 'rgba(255,230,170,0.75)');
  grad.addColorStop(0.5, 'rgba(255,170,60,0.2)');
  grad.addColorStop(1, 'rgba(255,120,30,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(c);
}

// a strip of invented runes, drawn once, wrapped around the ring bands
function runeTexture() {
  const W = 1024, H = 64;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.strokeStyle = '#ffd890';
  g.lineWidth = 3.2;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const n = 16;
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) * (W / n), y = H / 2;
    g.beginPath();
    const k = 3 + ((rnd() * 4) | 0);
    let px = x + (rnd() - 0.5) * 8, py = y - 18;
    g.moveTo(px, py);
    for (let j = 0; j < k; j++) {
      px = x + (rnd() - 0.5) * 30;
      py = y - 18 + ((j + 1) / k) * 36 + (rnd() - 0.5) * 6;
      g.lineTo(px, py);
    }
    g.stroke();
    if (rnd() < 0.5) {
      g.beginPath();
      g.arc(x + (rnd() - 0.5) * 20, y + (rnd() - 0.5) * 20, 3 + rnd() * 3, 0, 6.283);
      g.stroke();
    }
    // divider
    g.globalAlpha = 0.5;
    g.beginPath();
    g.moveTo(i * (W / n), 8);
    g.lineTo(i * (W / n), H - 8);
    g.stroke();
    g.globalAlpha = 1;
  }
  g.fillStyle = '#ffd890';
  g.globalAlpha = 0.55;
  g.fillRect(0, 4, W, 3);
  g.fillRect(0, H - 7, W, 3);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const ORB_VERT = /* glsl */ `
  varying vec3 vN; varying vec3 vP; varying vec3 vV;
  void main() {
    vP = position;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;
const ORB_FRAG = /* glsl */ `
  uniform float uTime; uniform float uCharge;
  varying vec3 vN; varying vec3 vP; varying vec3 vV;
  float h3(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
  float n3(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(h3(i), h3(i + vec3(1,0,0)), f.x), mix(h3(i + vec3(0,1,0)), h3(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(h3(i + vec3(0,0,1)), h3(i + vec3(1,0,1)), f.x), mix(h3(i + vec3(0,1,1)), h3(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  void main() {
    float fres = pow(1.0 - clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0), 2.2);
    vec3 q = vP * 0.55;
    float a = n3(q * 2.0 + vec3(0.0, uTime * 0.9, 0.0));
    float b = n3(q * 4.5 - vec3(uTime * 0.7, 0.0, uTime * 0.5));
    float m = a * 0.65 + b * 0.35;
    vec3 deep = vec3(1.1, 0.34, 0.05), hot = vec3(3.2, 2.3, 0.9), white = vec3(4.5, 4.0, 2.8);
    vec3 col = mix(deep, hot, smoothstep(0.25, 0.7, m));
    col = mix(col, white, smoothstep(0.62, 0.95, m) * 0.7 + fres * 0.45);
    float dim = mix(0.07, 1.0, uCharge);
    col *= dim * (0.8 + 0.4 * sin(uTime * 3.0));
    col = mix(col, vec3(0.35, 0.09, 0.03) * 2.0, (1.0 - uCharge) * 0.6);
    gl_FragColor = vec4(col, 1.0);
  }`;
const BEAM_VERT = /* glsl */ `
  varying vec2 vUv; varying vec3 vN; varying vec3 vV;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;
const BEAM_FRAG = /* glsl */ `
  uniform float uTime; uniform float uCharge;
  varying vec2 vUv; varying vec3 vN; varying vec3 vV;
  void main() {
    float y = vUv.y; // 0 bottom .. 1 top
    float fade = smoothstep(0.0, 0.32, y) * (1.0 - smoothstep(0.55, 1.0, y));
    float streak = 0.65 + 0.35 * sin(vUv.x * 40.0 + y * 6.0 - uTime * 2.0) * sin(vUv.x * 17.0 - uTime * 1.3);
    // soft silhouette: the tube is brightest face-on and vanishes at its edges
    float edge = pow(abs(dot(normalize(vN), normalize(vV))), 2.2);
    float a = fade * streak * edge * 0.3 * uCharge;
    gl_FragColor = vec4(vec3(1.4, 0.85, 0.32) * 1.2, a);
  }`;

export class Shrines {
  constructor(scene, points) {
    this.items = [];
    const glow = glowTexture();
    const runes = runeTexture();
    const orbGeo = new THREE.SphereGeometry(3.4, 40, 28);
    const bandGeo = new THREE.CylinderGeometry(9, 9, 2.2, 72, 1, true);
    const beamGeo = new THREE.CylinderGeometry(1.9, 4.2, 220, 20, 1, true);
    beamGeo.translate(0, 110, 0);
    for (const p of points) {
      const group = new THREE.Group();
      group.position.set(p[0], p[1], p[2]);
      const coreMat = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uCharge: { value: 1 } }, vertexShader: ORB_VERT, fragmentShader: ORB_FRAG });
      const core = new THREE.Mesh(orbGeo, coreMat);
      group.add(core);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: new THREE.Color(0.9, 0.65, 0.32), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      halo.scale.setScalar(34);
      group.add(halo);
      const bandMat = new THREE.MeshBasicMaterial({ map: runes, color: new THREE.Color(1.8, 1.15, 0.4), transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
      const ring = new THREE.Mesh(bandGeo, bandMat);
      const ring2 = new THREE.Mesh(bandGeo, bandMat);
      ring2.scale.set(0.7, 0.8, 0.7);
      group.add(ring, ring2);
      const beamMat = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uCharge: { value: 1 } },
        vertexShader: BEAM_VERT,
        fragmentShader: BEAM_FRAG,
        transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      });
      const beam = new THREE.Mesh(beamGeo, beamMat);
      beam.frustumCulled = false;
      group.add(beam);
      scene.add(group);
      this.items.push({ p: new THREE.Vector3(...p), group, core, halo, ring, ring2, coreMat, ringMat: bandMat, beamMat, readyAt: 0, charge: 1 });
    }
  }

  setReady(i, readyInMs) {
    const it = this.items[i];
    if (it) it.readyAt = performance.now() + readyInMs;
  }

  ready(i) {
    return performance.now() >= this.items[i].readyAt;
  }

  // `cam` (optional): the rune rings (9 m) and the orb (3 m) are sub-pixel from afar, so they stop being drawn
  // beyond ~1 km; the halo and the beacon beam carry the shrine across the map. That is 3 draw calls per far shrine.
  update(dt, t, fx, cam) {
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (cam) {
        const d = it.group.position.distanceTo(cam.position);
        it.ring.visible = it.ring2.visible = d < 1000;
        it.core.visible = d < 1500;
      }
      const target = this.ready(i) ? 1 : 0;
      it.charge += (target - it.charge) * Math.min(1, dt * 3);
      it.core.scale.setScalar(0.5 + it.charge * 0.5 + Math.sin(t * 3 + i) * 0.05 * it.charge);
      it.coreMat.uniforms.uTime.value = t + i * 3.7;
      it.coreMat.uniforms.uCharge.value = it.charge;
      it.beamMat.uniforms.uTime.value = t;
      it.beamMat.uniforms.uCharge.value = it.charge;
      it.halo.material.opacity = 0.15 + it.charge * 0.85;
      it.halo.scale.setScalar(10 + it.charge * 18);
      it.ringMat.opacity = 0.1 + it.charge * 0.75;
      it.ring.rotation.set(t * 0.31, t * 0.9, 0.2);
      it.ring2.rotation.set(-t * 0.5, -t * 1.1, t * 0.35);
      it.group.position.y = it.p.y + Math.sin(t * 0.8 + it.p.x) * 1.5;
      if (it.charge > 0.5 && fx) {
        fx.light(it.group.position, [1, 0.7, 0.3], 14 * it.charge);
        fx.shrine(it.group.position, it.charge, dt);
      }
    }
  }
}
