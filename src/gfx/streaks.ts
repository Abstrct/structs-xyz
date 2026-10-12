/* Anamorphic streaks: the long horizontal flares a cinema lens draws through
 * hot highlights. Bright pixels are thresholded into a quarter-res buffer,
 * smeared sideways by a chain of widening 1D blurs, then added back over the
 * scene in a cool blue. Runs on the HDR image before tone mapping. */
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

const VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

export class StreakPass extends Pass {
  strength = 0.22;
  threshold = 1.6;
  tint = new THREE.Color(0.55, 0.75, 1.0);
  private a: THREE.WebGLRenderTarget;
  private b: THREE.WebGLRenderTarget;
  private quad = new FullScreenQuad();
  private brightMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private addMat: THREE.ShaderMaterial;

  constructor() {
    super();
    const opts = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.a = new THREE.WebGLRenderTarget(1, 1, opts);
    this.b = new THREE.WebGLRenderTarget(1, 1, opts);
    this.brightMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uThreshold: { value: 1 }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse; uniform float uThreshold; uniform vec2 uTexel; varying vec2 vUv;
        vec3 pick(vec2 uv) { vec3 c = texture2D(tDiffuse, uv).rgb; float l = max(c.r, max(c.g, c.b)); return c * smoothstep(uThreshold, uThreshold * 2.5, l); }
        void main() {
          // Six bilinear taps cover the whole 4×6 footprint, so a one-pixel line on any row registers.
          vec3 c = vec3(0.0);
          for (int j = -1; j <= 1; j++) {
            c += pick(vUv + uTexel * vec2(-1.0, 2.0 * float(j))) + pick(vUv + uTexel * vec2(1.0, 2.0 * float(j)));
          }
          gl_FragColor = vec4(min(c / 6.0, vec3(24.0)), 1.0);
        }
      `,
      depthTest: false, depthWrite: false,
    });
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uStep: { value: 1 }, uTexelX: { value: 0 } },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse; uniform float uStep, uTexelX; varying vec2 vUv;
        void main() {
          vec3 s = vec3(0.0); float wsum = 0.0;
          for (int i = -4; i <= 4; i++) {
            float w = exp(-float(i * i) / 9.0);
            s += texture2D(tDiffuse, vUv + vec2(float(i) * uStep * uTexelX, 0.0)).rgb * w;
            wsum += w;
          }
          gl_FragColor = vec4(s / wsum, 1.0);
        }
      `,
      depthTest: false, depthWrite: false,
    });
    this.addMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, tStreak: { value: null }, uStrength: { value: 0 }, uTint: { value: this.tint } },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse, tStreak; uniform float uStrength; uniform vec3 uTint; varying vec2 vUv;
        void main() {
          vec3 base = texture2D(tDiffuse, vUv).rgb;
          vec3 st = texture2D(tStreak, vUv).rgb;
          // The streak keeps a breath of its source colour but leans toward the lens tint.
          float l = dot(st, vec3(0.299, 0.587, 0.114));
          gl_FragColor = vec4(base + mix(st, uTint * l, 0.7) * uStrength, 1.0);
        }
      `,
      depthTest: false, depthWrite: false,
    });
  }

  setSize(width: number, height: number) {
    const w = Math.max(1, Math.round(width / 4)), h = Math.max(1, Math.round(height / 6));
    this.a.setSize(w, h);
    this.b.setSize(w, h);
    (this.brightMat.uniforms.uTexel.value as THREE.Vector2).set(1 / width, 1 / height);
    this.blurMat.uniforms.uTexelX.value = 1 / w;
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    this.brightMat.uniforms.tDiffuse.value = readBuffer.texture;
    this.brightMat.uniforms.uThreshold.value = this.threshold;
    this.quad.material = this.brightMat;
    renderer.setRenderTarget(this.a);
    this.quad.render(renderer);
    // Widening steps: each pass spreads the last, so a few cheap passes reach far across the frame.
    let src = this.a, dst = this.b;
    this.quad.material = this.blurMat;
    for (const step of [1, 2.5, 6, 14]) {
      this.blurMat.uniforms.tDiffuse.value = src.texture;
      this.blurMat.uniforms.uStep.value = step;
      renderer.setRenderTarget(dst);
      this.quad.render(renderer);
      [src, dst] = [dst, src];
    }
    this.addMat.uniforms.tDiffuse.value = readBuffer.texture;
    this.addMat.uniforms.tStreak.value = src.texture;
    this.addMat.uniforms.uStrength.value = this.strength;
    this.quad.material = this.addMat;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
    renderer.autoClear = autoClear;
  }

  dispose() {
    this.a.dispose(); this.b.dispose();
    this.brightMat.dispose(); this.blurMat.dispose(); this.addMat.dispose();
    this.quad.dispose();
  }
}
