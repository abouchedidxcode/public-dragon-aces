// Heat-haze and shockwave refraction. Distortion sprites (a SpritePool of kind 'distort') are drawn into a
// half-resolution offset buffer, then this post pass bends the already-rendered scene by that buffer. The pass
// disables itself when nothing is distorting, so it costs nothing outside a fight.
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const _clear = new THREE.Color();

export class DistortPass extends Pass {
  constructor(pool, camera) {
    super();
    this.pool = pool;
    this.camera = camera;
    this.scene = new THREE.Scene();
    this.scene.add(pool.mesh);
    this.rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.strength = 0.07;
    this.quad = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, tDist: { value: this.rt.texture }, uStrength: { value: this.strength }, uAspect: { value: 1 } },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse, tDist;
        uniform float uStrength, uAspect;
        varying vec2 vUv;
        void main() {
          vec2 d = texture2D(tDist, vUv).xy;
          d = clamp(d, vec2(-1.5), vec2(1.5)) * uStrength;
          d.x /= uAspect;
          // a hint of dispersion on strong refraction
          vec3 col;
          col.r = texture2D(tDiffuse, vUv + d * 1.12).r;
          col.g = texture2D(tDiffuse, vUv + d).g;
          col.b = texture2D(tDiffuse, vUv + d * 0.9).b;
          gl_FragColor = vec4(col, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    }));
    this.enabled = false;
    this.needsSwap = true;
  }

  setSize(w, h) {
    this.rt.setSize(Math.max(2, w >> 1), Math.max(2, h >> 1));
    this.quad.material.uniforms.uAspect.value = w / h;
  }

  // Fill the half-res offset buffer (this.rt). The lens pipeline (post.js) calls this and bends the scene itself
  // in its final pass; the Pass.render below is the standalone EffectComposer path.
  renderOffsets(renderer) {
    const prevColor = renderer.getClearColor(_clear);
    const prevAlpha = renderer.getClearAlpha();
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, false, false);
    renderer.render(this.scene, this.camera);
    renderer.setClearColor(prevColor, prevAlpha);
    renderer.autoClear = prevAuto;
  }

  render(renderer, writeBuffer, readBuffer) {
    const prevTarget = renderer.getRenderTarget();
    this.renderOffsets(renderer);
    this.quad.material.uniforms.tDiffuse.value = readBuffer.texture;
    this.quad.material.uniforms.uStrength.value = this.strength;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
    if (prevTarget !== undefined) renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
  }

  dispose() {
    this.rt.dispose();
    this.quad.dispose();
  }
}
