// Dragon visuals: the Blender-built rig (assets/dragon.glb), breed materials and procedural animation.
//
// Meshes (tools/build_dragon.py): Body + BodyLOD (every breed shares them), Wings + WingsLOD, Eyes, and per-breed
// extras that only that breed shows: Extra_<breed> / ExtraLOD_<breed> (horns, crests, crystals, tail ornaments)
// and WExtra_<breed> (membrane sails, ear fins, hoods).
//
// Body vertex-colour masks: R belly, G horn/claw/tooth (0.5 root..1 tip; 0.3 = crest webbing), B unused,
// A mouth interior (1), tongue (0.75) or ice crystal (0.25). Baked maps from the sculpted high-poly copy:
//   dragon_body_normal  tangent normals
//   dragon_body_ao      R ambient occlusion, G sculpt height (scale domes, grooves), B per-scale random id
//   dragon_body_col     R stripe bands, G blotches, B mottling: the shader tints these per breed
//   dragon_wing_*       the same for membranes (veins, ribs, mottle, freckles)
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { SKY } from './atmosphere.js';

// pat: strength of [stripe bands, blotches, mottling, per-scale tint]; the rest tint the shared bake
export const BREED_LOOK = {
  ember: {
    back: 0x56120a, belly: 0xd09444, accent: 0x8c3416, stripe: 0x1f0402, membrane: 0x7a2412, memLight: 0xb84a20, horn: 0x5a4636, hornTip: 0xe6d6b0,
    eye: 0xffa516, fire: [[1.0, 0.86, 0.5], [1.0, 0.45, 0.08], [0.7, 0.12, 0.02]], glow: 0xff6a10, iri: 0,
    pat: [0.9, 0.22, 0.55, 0.4], magma: 1.0, wet: 0, frost: 0, storm: 0,
  },
  frost: {
    back: 0x86a6c8, belly: 0xeef5fb, accent: 0xeef7ff, stripe: 0x35567a, membrane: 0x4d7ca8, memLight: 0xa8d4ee, horn: 0x8faac4, hornTip: 0xf2f8ff,
    eye: 0x6ff0ff, fire: [[0.72, 0.93, 1.0], [0.16, 0.58, 1.0], [0.03, 0.18, 0.85]], glow: 0x60d0ff, iri: 0.3,
    pat: [0.45, 0.8, 0.6, 0.3], magma: 0, wet: 0.1, frost: 1, storm: 0,
  },
  storm: {
    back: 0x251d3a, belly: 0x6a5890, accent: 0x6e56b4, stripe: 0x0a0714, membrane: 0x432670, memLight: 0x9a72e0, horn: 0x6a6088, hornTip: 0xeae4ff,
    eye: 0xc78cff, fire: [[0.95, 0.9, 1.0], [0.65, 0.45, 1.0], [0.25, 0.15, 0.85]], glow: 0xa070ff, iri: 0.85,
    pat: [0.95, 0.2, 0.5, 0.35], magma: 0, wet: 0.15, frost: 0, storm: 1,
  },
  venom: {
    back: 0x20401a, belly: 0xb6ba4e, accent: 0xc8ee34, stripe: 0x08160a, membrane: 0x3c6020, memLight: 0xa4cc3a, horn: 0x2a2a12, hornTip: 0xe4e08a,
    eye: 0xd0ff38, fire: [[0.9, 1.0, 0.6], [0.55, 0.95, 0.15], [0.2, 0.5, 0.05]], glow: 0x9cff30, iri: 0,
    pat: [0.8, 0.95, 0.5, 0.4], magma: 0, wet: 0.75, frost: 0, storm: 0,
  },
};

const TIME = { value: 0 }; // shared by every dragon material, set from DragonView.animate

// Hit flash: the hide reddens under its own lighting (diffuse x (1.5, 0.6, 0.5) at full hurt) with a faint warm
// fresnel rim, so a hit dragon stays a lit, solid animal instead of a flat glowing silhouette.
export const HURT_TINT = 'diffuseColor.rgb *= mix(vec3(1.0), vec3(1.5, 0.6, 0.5), hurt);';
export const HURT_RIM = 'vec3(1.0, 0.45, 0.25) * hurt * 0.45'; // multiplied by a fresnel term in each shader

// Dragons keep their contrast in the haze longer than the scenery (height fog x0.6), so a far dragon still reads as
// a solid shape against the mountains, in the main view and inside the lenses.
export function withDragonFog(mat) {
  const inner = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, renderer) => {
    inner.call(mat, sh, renderer);
    const fog = THREE.ShaderChunk.fog_fragment.replace('heightFogAmount(fogRay)', 'heightFogAmount(fogRay) * 0.6');
    sh.fragmentShader = sh.fragmentShader.replace('#include <fog_fragment>', fog);
  };
  return mat;
}

export function createBodyMaterial(breed) {
  const L = BREED_LOOK[breed];
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.5, metalness: 0.0, clearcoat: 0.35, clearcoatRoughness: 0.45,
    iridescence: L.iri, iridescenceIOR: 1.6, vertexColors: true, envMapIntensity: 1.0,
    normalMap: maps.bodyN, normalScale: new THREE.Vector2(1.7, 1.7), aoMap: maps.bodyAO, aoMapIntensity: 1.0,
  });
  const u = {
    cBack: { value: new THREE.Color(L.back) },
    cBelly: { value: new THREE.Color(L.belly) },
    cAccent: { value: new THREE.Color(L.accent) },
    cHorn: { value: new THREE.Color(L.horn) },
    cHornTip: { value: new THREE.Color(L.hornTip) },
    cStripe: { value: new THREE.Color(L.stripe) },
    cGlow: { value: new THREE.Color(L.glow) },
    uPat: { value: new THREE.Vector4(...L.pat) },
    uBreed: { value: new THREE.Vector4(L.magma, L.wet, L.frost, L.storm) },
    tCol: { value: maps.bodyC },
    uTime: TIME,
    glow: { value: 0 }, // breath charge: lights the mouth, throat and seams
    hurt: { value: 0 }, // flash on hit
    sunlit: { value: 1 }, // 0 inside a mountain's shadow
  };
  mat.userData.u = u;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBind;\nvarying vec3 vBindN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBind = position;\nvBindN = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 cBack, cBelly, cAccent, cHorn, cHornTip, cStripe, cGlow;
        uniform vec4 uPat, uBreed;
        uniform sampler2D tCol;
        uniform float uTime, glow, hurt, sunlit;
        varying vec3 vBind; varying vec3 vBindN;
        float dMouth, dTongue, dCrys, dHorn, dBelly, dScale, hornT, dStripe, dRid, dGroove;
        `,
      )
      .replace('#include <color_fragment>', `
        vec4 m = vColor;
        dBelly = m.r; dHorn = smoothstep(0.4, 0.5, m.g);
        dMouth = smoothstep(0.88, 0.95, m.a);
        dTongue = smoothstep(0.6, 0.66, m.a) * (1.0 - dMouth);
        dCrys = step(0.15, m.a) * step(m.a, 0.35);
        hornT = clamp((m.g - 0.5) * 2.0, 0.0, 1.0);
        vec3 bn = normalize(vBindN);
        vec3 aoT = texture2D(aoMap, vAoMapUv).rgb;
        vec3 pc = texture2D(tCol, vAoMapUv).rgb;
        dScale = aoT.g; dRid = aoT.b;
        dGroove = 1.0 - smoothstep(0.12, 0.45, dScale);
        float belly = smoothstep(0.1, 0.9, dBelly);
        // countershading: dark back, paler flanks, light belly
        float dors = smoothstep(-0.25, 0.85, bn.y);
        vec3 flank = mix(cBack, cBelly, 0.2);
        vec3 base = mix(flank, cBack, dors);
        base = mix(base, cBelly, belly);
        // blotches (lighter on the scale crowns), then dark stripe bands that wrap the flanks and fade on the belly
        float blot = pc.g * uPat.y * (1.0 - belly) * (0.45 + 0.8 * dScale);
        base = mix(base, cAccent, clamp(blot, 0.0, 1.0));
        dStripe = pc.r * uPat.x * (1.0 - smoothstep(0.15, 0.8, dBelly));
        base = mix(base, cStripe, clamp(dStripe * 0.85, 0.0, 1.0));
        // soft mottling and a per-scale tint (warmer / cooler scales)
        base *= 1.0 + (pc.b - 0.5) * uPat.z * 1.5;
        float jit = (dRid - 0.5) * uPat.w;
        base *= vec3(1.0 + jit * 0.7, 1.0 + jit * 0.25, 1.0 - jit * 0.5);
        // grooves between scales: darker, deeper in hue; belly plate seams darker
        base *= 0.55 + 0.6 * dScale;
        base = mix(base * vec3(1.15, 0.85, 0.8), base, smoothstep(0.15, 0.5, dScale));
        // thin crest skin between the spikes
        base = mix(base, cStripe * 1.6 + cAccent * 0.15, smoothstep(0.2, 0.3, m.g) * (1.0 - dHorn) * 0.75);
        // horns, claws and teeth: dark keratin roots with growth rings, pale worn tips
        vec3 ivory = mix(vec3(0.92, 0.85, 0.68), cHornTip, 0.6);
        vec3 hornC = mix(cHorn * 0.8, ivory, smoothstep(0.25, 0.95, hornT) * 0.9);
        hornC *= 0.62 + 0.55 * dScale;
        hornC = mix(hornC, hornC * vec3(1.15, 1.0, 0.85) + 0.03, smoothstep(0.7, 1.0, hornT));
        base = mix(base, hornC, dHorn);
        // mouth: red-black flesh, pink tongue
        base = mix(base, vec3(0.07, 0.01, 0.014) + vec3(0.04, 0.0, 0.0) * dScale, dMouth);
        base = mix(base, vec3(0.2, 0.035, 0.05) * (0.7 + 0.5 * dScale), dTongue);
        // ice crystals: blue-white glass with deeper cores
        base = mix(base, mix(cAccent * 0.55, vec3(0.8, 0.93, 1.0), 0.55) , dCrys);
        diffuseColor.rgb = base;
        ${HURT_TINT}
      `)
      .replace('mapN.xy *= normalScale;', 'mapN.xy *= normalScale * (1.0 - 0.25 * smoothstep(-4.8, -6.4, vBind.z));')
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = roughness;
         roughnessFactor = mix(0.64 - dScale * 0.26 + (dRid - 0.5) * 0.14, 0.52 + hornT * 0.1 - dScale * 0.1, dHorn);
         roughnessFactor *= 1.0 - uBreed.y * 0.3 * (1.0 - dHorn);
         roughnessFactor = mix(roughnessFactor, 0.18, dMouth);
         roughnessFactor = mix(roughnessFactor, 0.3, dTongue);
         roughnessFactor = mix(roughnessFactor, 0.07, dCrys);`,
      )
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
         material.clearcoat = clamp(0.3 + uBreed.y * 0.25 + dCrys + dMouth * 0.6 + dTongue * 0.5 + dHorn * 0.05, 0.0, 1.0);
         material.clearcoatRoughness = mix(0.45 - uBreed.y * 0.15, 0.05, max(dCrys, dMouth));`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         vec3 vd = normalize(vViewPosition);
         float fres = pow(1.0 - clamp(abs(dot(normal, vd)), 0.0, 1.0), 3.0);
         float pulse = 0.62 + 0.38 * sin(uTime * 1.6 + vBind.z * 0.9 + pc.b * 7.0);
         // breath charge lights the mouth and throat
         totalEmissiveRadiance += cGlow * glow * (dMouth * 14.0 + dTongue * 6.0 + smoothstep(-5.0, -7.5, vBind.z) * smoothstep(0.3, -0.4, vBind.y) * 2.0);
         // ember: magma seeping through the grooves between scales, strongest on belly, throat and chest
         float seam = dGroove * (1.0 - dHorn) * (1.0 - dMouth) * (1.0 - dTongue) * smoothstep(-5.9, -5.0, vBind.z);
         totalEmissiveRadiance += vec3(1.0, 0.3, 0.04) * uBreed.x * seam * pulse * (0.02 + 1.0 * belly + 0.12 * dStripe) * (1.0 + 3.5 * glow);
         // storm: lightning crawling along the dark bands
         float zap = pow(0.5 + 0.5 * sin(uTime * 7.0 + vBind.z * 2.7 + pc.b * 9.0 + dRid * 5.0), 5.0);
         totalEmissiveRadiance += cGlow * uBreed.w * dStripe * (0.03 + 0.8 * zap) * (1.0 - dHorn) * (1.0 + 2.0 * glow);
         // frost: glittering frost crystals on scale crowns, ice glowing from within
         float glit = pow(max(0.0, sin(dot(vd, normal) * 38.0 + dRid * 90.0 + vBind.x * 6.0)), 220.0);
         totalEmissiveRadiance += vec3(0.7, 0.9, 1.0) * uBreed.z * glit * dScale * 0.3 * sunlit;
         totalEmissiveRadiance += cGlow * dCrys * (0.5 + 1.2 * fres) * (0.6 + 0.4 * pulse);
         // charging a breath heats the horn tips
         totalEmissiveRadiance += cGlow * glow * dHorn * smoothstep(0.55, 1.0, hornT) * 2.2;
         // venom: faint toxic glow beneath the belly scales
         totalEmissiveRadiance += cGlow * (uBreed.y > 0.5 ? 1.0 : 0.0) * (belly * dGroove * 0.35 * smoothstep(-5.9, -5.0, vBind.z) + blot * 0.3) * pulse;
         totalEmissiveRadiance += ${HURT_RIM} * fres;`,
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
         reflectedLight.directDiffuse *= sunlit;
         reflectedLight.directSpecular *= sunlit;
         // cavities between scales hold less light
         reflectedLight.directDiffuse *= 0.75 + 0.25 * smoothstep(0.05, 0.4, dScale);`,
      );
  };
  withDragonFog(mat);
  mat.customProgramCacheKey = () => 'dragon-body-v3';
  return mat;
}

export function createWingMaterial(breed) {
  const L = BREED_LOOK[breed];
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.6, metalness: 0, side: THREE.DoubleSide, vertexColors: true, envMapIntensity: 0.8,
    normalMap: maps.wingN, normalScale: new THREE.Vector2(1.4, 1.4), aoMap: maps.wingAO,
  });
  const u = {
    cMem: { value: new THREE.Color(L.membrane) },
    cMemLight: { value: new THREE.Color(L.memLight) },
    cTrans: { value: new THREE.Color(L.membrane).lerp(new THREE.Color(L.glow), 0.3) },
    cVein: { value: new THREE.Color(L.back).multiplyScalar(0.55) },
    cAccent: { value: new THREE.Color(L.accent) },
    cGlow: { value: new THREE.Color(L.glow) },
    uBreed: { value: new THREE.Vector4(L.magma, L.wet, L.frost, L.storm) },
    tCol: { value: maps.wingC },
    uTime: TIME,
    sunCol: { value: SKY.sunColor },
    sunlit: { value: 1 },
    hurt: { value: 0 },
  };
  mat.userData.u = u;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBind;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBind = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 cMem, cMemLight, cTrans, cVein, cAccent, cGlow, sunCol; uniform vec4 uBreed;
        uniform sampler2D tCol; uniform float sunlit, hurt, uTime;
        varying vec3 vBind; float wThin; float wVein; float wFin; float wRib;
        float h31(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
        float vn3(vec3 p) {
          vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(h31(i), h31(i + vec3(1, 0, 0)), f.x), mix(h31(i + vec3(0, 1, 0)), h31(i + vec3(1, 1, 0)), f.x), f.y),
                     mix(mix(h31(i + vec3(0, 0, 1)), h31(i + vec3(1, 0, 1)), f.x), mix(h31(i + vec3(0, 1, 1)), h31(i + vec3(1, 1, 1)), f.x), f.y), f.z);
        }`)
      .replace('#include <color_fragment>', `
        wThin = vColor.r; wFin = step(0.5, vColor.g);
        vec3 aoT = texture2D(aoMap, vAoMapUv).rgb;
        vec3 pc = texture2D(tCol, vAoMapUv).rgb; // R mottle, G freckles
        // veins and ribs sculpted and baked in Blender
        wVein = smoothstep(0.35, 0.75, aoT.g) * smoothstep(0.02, 0.2, wThin);
        // capillaries: contour lines of two noise fields make a fine branching net across the thin skin
        float cap = max((1.0 - smoothstep(0.0, 0.045, abs(vn3(vBind * 4.5) - 0.5))) * 0.7, (1.0 - smoothstep(0.0, 0.06, abs(vn3(vBind * 10.0 + 7.0) - 0.5))) * 0.45);
        cap *= smoothstep(0.1, 0.5, wThin) * (1.0 - wFin * 0.5);
        // thick near the bones (dark, saturated), thin and bright toward the edges
        float edgeT = smoothstep(0.0, 0.85, wThin);
        vec3 mem = mix(cMem * 0.55, cMem, smoothstep(0.0, 0.5, wThin));
        mem = mix(mem, cMemLight, smoothstep(0.45, 1.0, edgeT) * 0.55);
        mem *= 0.72 + 0.5 * pc.r;
        mem = mix(mem, cVein, pc.g * 0.45 * (1.0 - wFin));
        // a darker band along the leading edge and a fine dark rim
        float rr = length(vec2(abs(vBind.x) - 6.0, vBind.z + 1.75));
        mem *= 1.0 - 0.25 * smoothstep(5.0, 7.5, rr) * (1.0 - wFin);
        // fins: accent coloured webbing between the ribs
        mem = mix(mem, vec3(0.82, 0.93, 1.0), uBreed.z * smoothstep(0.5, 0.95, pc.r + wThin * 0.35) * 0.5 * (1.0 - wFin));
        mem = mix(mem, mix(cAccent, cMemLight, 0.5) * (0.6 + 0.6 * pc.r), wFin * 0.3);
        mem = mix(mem, mem * 0.6 + cVein * 0.4, cap * 0.7);
        diffuseColor.rgb = mix(mem, cVein, clamp(wVein, 0.0, 1.0) * 0.9);
        wRib = clamp(wVein + cap * 0.35, 0.0, 1.0);
        ${HURT_TINT}`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = roughness * (1.0 - uBreed.y * 0.35) * (0.85 + 0.3 * (1.0 - aoT.g));`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        reflectedLight.directDiffuse *= sunlit;
        reflectedLight.directSpecular *= sunlit;`)
      .replace('#include <opaque_fragment>', `
        #if NUM_DIR_LIGHTS > 0
        {
          // light passing through the membrane from behind: blood-warm, brighter where it is thin
          vec3 Ld = directionalLights[0].direction;
          float back = max(0.0, -dot(normal, Ld));
          float viewBack = pow(max(0.0, dot(normalize(vViewPosition), -Ld) * -1.0 + 1.0) * 0.5, 0.5);
          float th = 0.35 + 0.65 * wThin;
          float flaw = 0.8 + 0.4 * pc.r;
          outgoingLight += cTrans * cTrans * sunCol * back * th * flaw * (1.0 - wRib * 0.9) * 0.95 * sunlit * (0.6 + 0.4 * viewBack);
          // a soft glow where the sun rakes the edge of a thin membrane
          float grazing = pow(1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0), 3.0);
          outgoingLight += cMemLight * sunCol * grazing * wThin * 0.12 * sunlit;
        }
        #endif
        // storm: veins of lightning in the fins and sails
        float zap = pow(0.5 + 0.5 * sin(uTime * 6.0 + vBind.z * 2.3 + vBind.x * 1.7), 6.0);
        outgoingLight += cGlow * uBreed.w * wRib * (0.12 + 1.1 * zap);
        // ember: heat glow in the membrane veins
        outgoingLight += vec3(1.0, 0.3, 0.05) * uBreed.x * wRib * 0.25 * (0.7 + 0.3 * sin(uTime * 1.6 + vBind.z));
        outgoingLight += ${HURT_RIM} * pow(1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0), 3.0);
        #include <opaque_fragment>`);
  };
  withDragonFog(mat);
  mat.customProgramCacheKey = () => 'dragon-wing-v3';
  return mat;
}

// Eyes: a wet glassy ball whose UVs are the gaze-axis projection (tools/build_dragon.py), so the shader
// can paint a veined iris, a slit pupil and a dark limbal ring. The iris glows; the pupil stays black.
export function createEyeMaterial(breed) {
  const L = BREED_LOOK[breed];
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.22, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.4,
  });
  const u = { cIris: { value: new THREE.Color(L.eye) }, hurt: { value: 0 }, rage: { value: 0 } };
  mat.userData.u = u;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vEyeUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEyeUv = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 cIris; uniform float hurt, rage;
        varying vec2 vEyeUv; vec3 eyeEmit;`)
      .replace('#include <color_fragment>', `
        vec2 ep = (vEyeUv - 0.5) * 2.0;
        float er = length(ep);
        float ea = atan(ep.y, ep.x);
        float iris = 1.0 - smoothstep(0.68, 0.76, er);
        float pw = (0.1 + 0.06 * abs(ep.y)) * (1.0 - 0.45 * clamp(rage, 0.0, 1.0));
        float pupil = 1.0 - smoothstep(0.82, 1.0, length(vec2(ep.x / pw, ep.y / 0.5)));
        float fib = 0.5 + 0.5 * sin(ea * 42.0 + sin(ea * 7.0 + er * 9.0) * 1.7);
        float t = smoothstep(0.1, 0.7, er);
        vec3 irisCol = mix(cIris * 1.25 + vec3(0.35, 0.3, 0.1), cIris * vec3(0.55, 0.3, 0.2), t);
        irisCol *= 0.65 + 0.55 * fib;
        irisCol *= 1.0 - 0.75 * smoothstep(0.56, 0.74, er);   // limbal ring
        vec3 outer = cIris * vec3(0.22, 0.1, 0.07) + vec3(0.02);
        vec3 eyeCol = mix(outer, irisCol, iris) * (1.0 - pupil);
        eyeEmit = (irisCol * (1.0 - pupil) * iris) * mix(1.9, 0.9, t) * (1.0 + rage);
        diffuseColor.rgb = eyeCol * 0.6;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += eyeEmit;`);
  };
  withDragonFog(mat);
  mat.customProgramCacheKey = () => 'dragon-eye-v1';
  return mat;
}

let template = null;
let kit = null; // the procedural dragon (dragon-code.js), unless the Blender model was chosen: { template, createBodyMaterial, ... }
const maps = {};
/** the code-built dragon as a kit DragonView can use (new DragonView(breed, kit)); see dragon-code.js */
export async function loadCodeKit() {
  return (await import('./dragon-code.js')).loadCodeDragon();
}
/**
 * Which dragon to build: 'code' (generated by dragon-code.js, the default) or 'glb' (the Blender model).
 * ?dragon=code|glb overrides the choice saved in Settings (localStorage da.dragon).
 */
export function dragonModelChoice() {
  if (typeof location === 'undefined') return 'glb'; // node tests load the GLB
  const q = new URLSearchParams(location.search).get('dragon');
  if (q === 'code' || q === 'glb') return q;
  let saved = null;
  try { saved = localStorage.getItem('da.dragon'); } catch {}
  return saved === 'glb' ? 'glb' : 'code';
}
export async function loadDragonModel(url) {
  if (dragonModelChoice() === 'code') {
    kit = await loadCodeKit();
    template = kit.template;
    return template;
  }
  const base = url.replace(/[^/]*$/, '');
  const tl = new THREE.TextureLoader();
  const load = async (name) => {
    const t = await tl.loadAsync(base + name);
    t.flipY = false; // glTF UV convention
    t.colorSpace = THREE.NoColorSpace;
    t.anisotropy = 8;
    return t;
  };
  const [gltf, bn, ba, bc, wn, wa, wc] = await Promise.all([
    new GLTFLoader().loadAsync(url),
    load('dragon_body_normal.jpg'), load('dragon_body_ao.jpg'), load('dragon_body_col.jpg'),
    load('dragon_wing_normal.jpg'), load('dragon_wing_ao.jpg'), load('dragon_wing_col.jpg'),
  ]);
  Object.assign(maps, { bodyN: bn, bodyAO: ba, bodyC: bc, wingN: wn, wingAO: wa, wingC: wc });
  template = gltf.scene;
  template.traverse((o) => {
    if (o.isSkinnedMesh) {
      o.castShadow = o.name !== 'Eyes' && !o.name.includes('Extra'); // ornaments cast no shadows (saves the shadow pass)
      o.receiveShadow = true;
      o.frustumCulled = false; // skinned bounds are the rest pose; we cull by distance ourselves
    }
  });
  return template;
}

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler();
const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);
const _v = new THREE.Vector3();

// One dragon on screen. `scale` sizes the whole model (the game draws dragons at DRAGON_SCALE in shared/constants.js,
// the title showcase at 1); the mouth, wingtips and bones scale with it, so breath, trails and shots follow.
export class DragonView {
  constructor(breed, k = kit, scale = 1) {
    this.kit = k;
    this.root = new THREE.Group();
    this.model = SkeletonUtils.clone(k ? k.template : template);
    this.root.add(this.model);
    this.breed = null;
    this.bones = {};
    this.extras = {}; // breed -> { body, bodyLod, wing } meshes shown only for that breed
    const ex = (b) => (this.extras[b] = this.extras[b] || {});
    this.model.traverse((o) => {
      if (o.isBone) this.bones[o.name.replace(/^(.*[a-z0-9])([LR])$/, '$1.$2')] = o; // GLTFLoader strips the '.' from 'x.R'
      if (o.isSkinnedMesh) {
        const n = o.name;
        if (n === 'BodyLOD') this.bodyLod = o;
        else if (n === 'WingsLOD') this.wingsLod = o;
        else if (n === 'Body') this.body = o;
        else if (n === 'Wings') this.wings = o;
        else if (n === 'Eyes') this.eyes = o;
        else if (n.startsWith('ExtraLOD_')) ex(n.slice(9)).bodyLod = o;
        else if (n.startsWith('Extra_')) ex(n.slice(6)).body = o;
        else if (n.startsWith('WExtra_')) ex(n.slice(7)).wing = o;
      }
    });
    this.far = null;
    this.setFar(false);
    // rest pose: local quats and the parent's model-space rotation (to express deltas in model axes)
    this.model.updateMatrixWorld(true);
    const inv = new THREE.Quaternion();
    this.model.getWorldQuaternion(inv).invert();
    this.rest = {};
    for (const [name, b] of Object.entries(this.bones)) {
      const pw = new THREE.Quaternion();
      if (b.parent) b.parent.getWorldQuaternion(pw);
      pw.premultiply(inv);
      this.rest[name] = { q: b.quaternion.clone(), p: b.position.clone(), pw, pwi: pw.clone().invert() };
    }
    // mouth and wingtip points in their bones' local space
    const toLocal = (bone, x, y, z) => bone.worldToLocal(new THREE.Vector3(x, y, z));
    this.mouthLocal = toLocal(this.bones.head, 0, 0.25, -8.6);
    this.tipLocalR = toLocal(this.bones['finger1.R'], 12.0, 0.45, -0.4);
    this.tipLocalL = toLocal(this.bones['finger1.L'], -12.0, 0.45, -0.4);
    this.phase = Math.random() * 10;
    this.t = Math.random() * 10;
    this.flapAmp = 0.6;
    this.sweep = 0;
    this.jaw = 0;
    this.look = new THREE.Vector2();
    this.tailYaw = 0;
    this.tailPitch = 0;
    this.limp = 0;
    this.lastFlapSign = 1;
    this.onFlap = null;
    this.setBreed(breed);
    // after the rest pose and the anchors above were measured in unscaled model space
    this.scale = scale;
    this.model.scale.setScalar(scale);
  }

  setBreed(breed) {
    if (breed === this.breed) return;
    this.breed = breed;
    if (this.bodyMat) {
      this.bodyMat.dispose();
      this.wingMat.dispose();
      this.eyeMat.dispose();
    }
    const K = this.kit || { createBodyMaterial, createWingMaterial, createEyeMaterial };
    this.bodyMat = K.createBodyMaterial(breed);
    this.wingMat = K.createWingMaterial(breed);
    this.eyeMat = K.createEyeMaterial(breed);
    this.body.material = this.bodyLod.material = this.bodyMat;
    this.wings.material = this.wingsLod.material = this.wingMat;
    this.eyes.material = this.eyeMat;
    for (const e of Object.values(this.extras)) {
      if (e.body) e.body.material = this.bodyMat;
      if (e.bodyLod) e.bodyLod.material = this.bodyMat;
      if (e.wing) e.wing.material = this.wingMat;
    }
    this.applyVisibility();
  }

  // full-detail mesh up close, the decimated one beyond ~140 m
  setFar(far) {
    if (far === this.far) return;
    this.far = far;
    this.applyVisibility();
  }

  applyVisibility() {
    const far = this.far;
    if (far === null) return;
    this.body.visible = this.wings.visible = !far;
    this.bodyLod.visible = this.wingsLod.visible = far;
    for (const [b, e] of Object.entries(this.extras)) {
      const on = b === this.breed;
      if (e.body) e.body.visible = on && !far;
      if (e.bodyLod) e.bodyLod.visible = on && far;
      if (e.wing) e.wing.visible = on;
    }
  }

  rot(name, axis, angle) {
    // bone.quaternion = pw^-1 * R(axis, angle) * pw * current
    const r = this.rest[name];
    const b = this.bones[name];
    _q.setFromAxisAngle(axis, angle);
    _q2.copy(r.pwi).multiply(_q).multiply(r.pw);
    b.quaternion.premultiply(_q2);
  }

  /**
   * s: { throttle, boost, brake, breath, speed, yawRate, pitchRate, rollRate, lookYaw, lookPitch, dive, dead, firing }
   */
  animate(dt, s) {
    this.t += dt;
    TIME.value = (typeof performance !== 'undefined' ? performance.now() : 0) / 1000;
    for (const [name, r] of Object.entries(this.rest)) {
      this.bones[name].quaternion.copy(r.q);
      this.bones[name].position.copy(r.p);
    }
    const k = 1 - Math.exp(-6 * dt);
    this.limp += ((s.dead ? 1 : 0) - this.limp) * (1 - Math.exp(-3 * dt));
    // flap rate and depth from effort; glide when easing off; tuck wings in steep dives
    const effort = s.boost ? 1.25 : s.brake ? 0.35 : s.throttle;
    const freq = s.dead ? 0 : 0.42 + effort * 1.25;
    const ampT = s.dead ? 0 : effort < 0.32 && !s.boost ? 0.1 : 0.35 + effort * 0.45;
    this.flapAmp += (ampT - this.flapAmp) * k;
    const sweepT = (s.dive ? 0.75 : 0) + (s.boost ? 0.25 : 0) - (s.brake ? 0.35 : 0);
    this.sweep += (sweepT - this.sweep) * k;
    this.phase += dt * Math.PI * 2 * freq;
    const ph = this.phase;
    const flap = Math.sin(ph);
    if (this.onFlap && Math.sign(flap) !== this.lastFlapSign && flap < 0) this.onFlap(this.flapAmp);
    this.lastFlapSign = Math.sign(flap) || 1;
    const A = this.flapAmp;
    for (const [tag, sd] of [['R', 1], ['L', -1]]) {
      const up = A * flap + 0.08 - this.limp * 0.9;
      this.rot(`upperarm.${tag}`, AZ, sd * up);
      this.rot(`upperarm.${tag}`, AY, -sd * (this.sweep * 0.55 + this.limp * 0.4));
      // the forearm lags and the wing folds a little on the upstroke
      const fold = Math.max(0, Math.cos(ph)) * A * 0.5 + this.sweep * 0.5 + this.limp * 0.6;
      this.rot(`forearm.${tag}`, AZ, sd * A * 0.55 * Math.sin(ph - 0.8));
      this.rot(`forearm.${tag}`, AY, sd * fold * 0.9);
      for (let f = 1; f <= 4; f++) {
        this.rot(`finger${f}.${tag}`, AY, sd * (fold * (0.15 + f * 0.12)) * (f === 1 ? 0.4 : 1));
        this.rot(`finger${f}.${tag}`, AZ, sd * A * 0.25 * Math.sin(ph - 1.3) * (0.4 + f * 0.15));
      }
      // legs tuck tighter at speed
      this.rot(`thigh.${tag}`, AX, -0.15 * (s.boost ? 1 : 0) + this.limp * 0.5);
    }
    // body bob with the wingbeat; the ribcage swells with each breath
    this.bones.chest.position.y += -Math.cos(ph) * 0.12 * A;
    const breathe = 1 + Math.sin(this.t * 2.3) * 0.007 * (1 - this.limp);
    this.bones.chest.scale.set(breathe, breathe, breathe);
    // neck and head look toward the aim; the tail swings against turns
    const ly = THREE.MathUtils.clamp(s.lookYaw || 0, -0.7, 0.7), lp = THREE.MathUtils.clamp(s.lookPitch || 0, -0.45, 0.45);
    this.look.x += (ly - this.look.x) * k;
    this.look.y += (lp - this.look.y) * k;
    const necks = ['neck1', 'neck2', 'neck3', 'neck4', 'head'];
    this.look.x += Math.sin(this.t * 0.9) * 0.0016;
    for (const n of necks) {
      this.rot(n, AY, -this.look.x / necks.length);
      this.rot(n, AX, this.look.y / necks.length + Math.sin(ph - 0.5) * 0.015 * A + this.limp * 0.12);
    }
    const jawT = s.breath ? 0.55 : s.firing ? 0.4 : this.limp * 0.3;
    this.jaw += (jawT - this.jaw) * (1 - Math.exp(-14 * dt));
    this.rot('jaw', AX, -this.jaw);
    this.tailYaw += (THREE.MathUtils.clamp(s.yawRate || 0, -2, 2) * 0.06 - this.tailYaw) * k;
    this.tailPitch += (THREE.MathUtils.clamp(s.pitchRate || 0, -2, 2) * 0.05 - this.tailPitch) * k;
    for (let i = 1; i <= 7; i++) {
      const sway = Math.sin(this.t * 1.7 - i * 0.55) * (0.025 + i * 0.006) * (1 - this.limp * 0.5);
      this.rot(`tail${i}`, AY, sway + this.tailYaw + this.limp * Math.sin(this.t * 3 + i) * 0.1);
      this.rot(`tail${i}`, AX, -this.tailPitch + Math.sin(this.t * 1.1 - i * 0.4) * 0.012 - this.limp * 0.05);
    }
  }

  mouthWorld(out) {
    return out.copy(this.mouthLocal).applyMatrix4(this.bones.head.matrixWorld);
  }

  tipsWorld(r, l) {
    r.copy(this.tipLocalR).applyMatrix4(this.bones['finger1.R'].matrixWorld);
    l.copy(this.tipLocalL).applyMatrix4(this.bones['finger1.L'].matrixWorld);
  }

  setLight(sunlit, glow, hurt) {
    const b = this.bodyMat.userData.u, w = this.wingMat.userData.u;
    b.sunlit.value = w.sunlit.value = sunlit;
    b.glow.value = glow;
    b.hurt.value = w.hurt.value = this.eyeMat.userData.u.hurt.value = hurt;
    this.eyeMat.userData.u.rage.value = glow;
  }

  dispose() {
    this.bodyMat.dispose();
    this.wingMat.dispose();
    this.eyeMat.dispose();
  }
}
