import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { StreakPass } from '../gfx/streaks';
import { rumble } from './pad';

/** The renderer's current pixel ratio, shared by every point-sprite shader
 * (gl_PointSize is in device pixels). Updated on resize and quality change. */
export const PIXEL_RATIO = { value: Math.min(window.devicePixelRatio, 2) };

/** Whether WebGL runs on a software rasteriser (SwiftShader, llvmpipe): VMs, remote desktops,
 * blocklisted GPUs. Such a context gets a lighter pipeline and smaller procedural bakes. */
let softGL: boolean | null = null;
export function softwareGL(renderer: THREE.WebGLRenderer): boolean {
  if (softGL === null) {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    softGL = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
  }
  return softGL;
}

/** One full-screen mode of the client: owns a scene, a camera and its DOM. */
export interface Screen {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /** Bloom for this screen; the engine eases toward it on switch. */
  readonly bloom?: { strength: number; radius: number; threshold: number };
  /** Anamorphic lens streak strength through hot highlights (default 0.22; 0 for none). */
  readonly streaks?: number;
  enter(params: Record<string, string>): void | Promise<void>;
  exit(): void;
  update(dt: number, time: number): void;
  resize?(width: number, height: number): void;
}

/* A guard between the scene and bloom: one NaN or Inf pixel from any shader would be smeared by
 * bloom's blur chain into flickering black squares, so such pixels are zeroed here. */
const SanitizeShader = {
  uniforms: { tDiffuse: { value: null as THREE.Texture | null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    float ok(float x) { return isnan(x) || isinf(x) ? 0.0 : x; }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      gl_FragColor = vec4(ok(c.r), ok(c.g), ok(c.b), ok(c.a));
    }
  `,
};

/* Final grade, in display space after tone mapping: a light unsharp mask so
 * pixel art and type stay crisp through MSAA and bloom; a filmic split tone
 * (cool, deep shadows; warm highlights), a soft S-curve and a touch of
 * saturation; vignette, a whisper of chromatic aberration toward the edges,
 * scanline shimmer and luma-weighted grain. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uVignette: { value: 0.9 },
    uAberration: { value: 0.00055 },
    uGrain: { value: 0.03 },
    uSharpen: { value: 0.22 },
    uMaterialize: { value: 0 },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color(1, 1, 1) },
    uResolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uAberration, uGrain, uFlash, uSharpen, uMaterialize;
    uniform vec3 uFlashColor;
    uniform vec2 uResolution;
    varying vec2 vUv;
    float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    vec3 grade(vec3 c) {
      float l = luma(c);
      // Split tone: shadows sink toward deep teal-navy, highlights warm a hair.
      c += vec3(-0.006, 0.002, 0.012) * (1.0 - smoothstep(0.0, 0.3, l));
      c = mix(c, c * vec3(1.03, 1.0, 0.955), smoothstep(0.4, 1.0, l));
      c = clamp(c, 0.0, 1.0);
      c = mix(c, c * c * (3.0 - 2.0 * c), 0.16);
      return max(mix(vec3(luma(c)), c, 1.07), 0.0);
    }
    void main() {
      vec2 uv = vUv;
      // Materialize: a new screen resolves in coarse digital blocks, bands of scanlines slipping sideways.
      float m = uMaterialize;
      if (m > 0.0) {
        float band = floor(uv.y * uResolution.y / 6.0);
        float slip = step(1.0 - m * 0.6, hash(vec2(band, floor(uTime * 24.0)))) * (hash(vec2(band * 1.7, 3.1)) - 0.5) * 0.04 * m;
        uv.x += slip;
      }
      vec2 c = uv - 0.5;
      float r2 = dot(c, c);
      vec2 off = c * r2 * (uAberration + m * 0.01) * 12.0;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + off).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - off).b;
      vec2 px = 1.0 / uResolution;
      vec3 nb = texture2D(tDiffuse, uv + vec2(px.x, 0.0)).rgb + texture2D(tDiffuse, uv - vec2(px.x, 0.0)).rgb
              + texture2D(tDiffuse, uv + vec2(0.0, px.y)).rgb + texture2D(tDiffuse, uv - vec2(0.0, px.y)).rgb;
      col = max(col + (col - nb * 0.25) * uSharpen, 0.0);
      col = grade(col);
      float vig = smoothstep(0.95, 0.18, r2 * uVignette * 1.6);
      col *= mix(0.5, 1.0, vig);
      float scan = 0.992 + 0.008 * sin(vUv.y * uResolution.y * 1.5 + uTime * 6.0);
      col *= scan;
      // Grain lives in the mid-tones, like film; pure black stays black.
      float l = luma(col);
      col += (hash(vUv * uResolution + fract(uTime * 13.7) * 97.0) - 0.5) * uGrain * (0.35 + 0.65 * smoothstep(0.0, 0.25, l) * (1.0 - smoothstep(0.6, 1.0, l)));
      if (m > 0.0) {
        // Block grid: big blocks resolve first, then finer cells, with a hot teal leading edge.
        // Three fixed grid sizes (16, 8, 4 px): a cell keeps its hash while it resolves, so nothing strobes.
        vec2 cell = floor(gl_FragCoord.xy / exp2(2.0 + floor(m * 2.99)));
        float n = hash(cell + 0.37) * 0.7 + (1.0 - vUv.y) * 0.3;
        float th = m * 1.15 - 0.075;
        float vis = smoothstep(th, th + 0.03, n);
        float edge = smoothstep(0.03, 0.0, abs(n - th - 0.012)) * step(0.001, m);
        col = col * vis + vec3(0.26, 0.80, 0.71) * edge * 0.55;
      }
      col = mix(col, uFlashColor, uFlash);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

/* The Dreamcast look, last in the chain: the picture is drawn at about 480 lines (the console's
 * 640×480) and leaves in 16-bit colour (RGB565), with a 4×4 ordered dither standing in for the
 * banding, as the PowerVR's framebuffer did. Dither cells are in drawing-buffer pixels. */
const DcShader = {
  uniforms: { tDiffuse: { value: null as THREE.Texture | null }, uOn: { value: 1 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uOn;
    varying vec2 vUv;
    float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
    float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
    void main() {
      vec3 c = clamp(texture2D(tDiffuse, vUv).rgb, 0.0, 1.0);
      vec3 levels = vec3(31.0, 63.0, 31.0);
      vec3 q = floor(c * levels + bayer4(gl_FragCoord.xy)) / levels;
      gl_FragColor = vec4(mix(c, min(q, 1.0), uOn), 1.0);
    }
  `,
};

export type Look = 'dc' | 'modern';
/** The look in force, for builders that size their meshes by it (Dreamcast budgets: ~60k triangles
 * a frame). Objects built before a change keep their detail; new ones follow. */
export const LOOK = { dc: true };

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  private composer: EffectComposer;
  private renderPass: RenderPass;
  private bloomPass: UnrealBloomPass;
  private streakPass: StreakPass;
  private streakTarget = 0.22;
  private gradePass: ShaderPass;
  private dcPass: ShaderPass;
  /** 'dc': ~480 lines, 16-bit dithered colour, no film effects. 'modern': full resolution and the film grade. */
  look: Look = 'dc';
  private screen: Screen | null = null;
  /** Last frame's timestamp (ms); 0 until the first frame. */
  private lastFrame = 0;
  private elapsed = 0;
  /** The last frame's wall-clock step in seconds (at most 0.25). */
  realDt = 0;
  private shake = 0;
  private flash = 0;
  /** WebGL runs on a software rasteriser: see the constructor. */
  private soft = false;
  private materializeT = 0;
  private bloomTarget = { strength: 1.0, radius: 0.6, threshold: 0.2 };
  private placeholderScene = new THREE.Scene();
  /** Adaptive resolution: drop to 1× if frames stay slow. */
  private maxPixelRatio = Math.min(window.devicePixelRatio, 2);
  private perf = { t: 0, frames: 0, slow: 0 };
  private placeholderCamera = new THREE.PerspectiveCamera();
  /** Accessibility: no camera shake, no full-screen flashes. */
  reduceMotion = false;
  private bloomEnabled = true;
  /** What the last frame cost the GPU, summed over every pass (the studio's hardware budget reads it). */
  readonly stats = { calls: 0, triangles: 0, points: 0, lines: 0, textures: 0, geometries: 0, width: 0, height: 0 };
  /** Seconds since start; screens animate off this so pauses stay smooth. */
  get time() { return this.elapsed; }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x0b0f15, 1);
    // Counted per frame (all passes), not per render call: see stats.
    this.renderer.info.autoReset = false;

    // A software rasteriser (SwiftShader, llvmpipe) shades and compiles on the CPU, starving the page
    // itself: it renders at 1×, without MSAA, bloom or lens streaks.
    this.soft = softwareGL(this.renderer);
    if (this.soft) { this.maxPixelRatio = 1; this.renderer.setPixelRatio(1); }
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: this.soft ? 0 : 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.renderPass = new RenderPass(this.placeholderScene, this.placeholderCamera);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 1.0, 0.6, 0.2);
    this.gradePass = new ShaderPass(GradeShader);
    this.dcPass = new ShaderPass(DcShader);
    this.streakPass = new StreakPass();
    this.composer.addPass(this.renderPass);
    this.composer.addPass(new ShaderPass(SanitizeShader));
    this.composer.addPass(this.streakPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(this.gradePass);
    this.composer.addPass(this.dcPass);

    if (this.soft) { this.streakPass.enabled = false; this.bloomPass.enabled = false; }

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    // The Dreamcast look draws about 480 lines whatever the window (never more than the cap).
    const ratio = this.look === 'dc' ? Math.min(this.maxPixelRatio, Math.max(0.25, 480 / Math.max(1, h))) : this.maxPixelRatio;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(w, h);
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.gradePass.uniforms.uResolution.value.set(size.x, size.y);
    PIXEL_RATIO.value = this.renderer.getPixelRatio();
    if (this.screen) {
      this.screen.camera.aspect = w / h;
      this.screen.camera.updateProjectionMatrix();
      this.screen.resize?.(w, h);
    }
  }

  private captureCb: ((b: Blob | null) => void) | null = null;
  /** Grab the next rendered frame as a PNG (read right after render, so the buffer is intact). */
  capture(): Promise<Blob | null> { return new Promise((r) => { this.captureCb = r; }); }

  setBloom(on: boolean) { this.bloomEnabled = on; this.bloomPass.enabled = on && !this.soft; this.streakPass.enabled = on && !this.soft && this.look !== 'dc'; }
  /** The picture: the Dreamcast's (low resolution, 16-bit dither, no lens or film effects) or the modern grade. */
  setLook(look: Look) {
    this.look = look;
    const dc = look === 'dc';
    LOOK.dc = dc;
    this.dcPass.enabled = dc;
    const u = this.gradePass.uniforms;
    u.uAberration.value = dc ? 0 : 0.00055;
    u.uGrain.value = dc ? 0 : 0.03;
    u.uSharpen.value = dc ? 0 : 0.22;
    u.uVignette.value = dc ? 0.55 : 0.9;
    this.canvas.classList.toggle('dc', dc);
    this.setBloom(this.bloomEnabled);
    this.resize();
  }
  /** 'high' renders at up to 2× device pixels, 'low' at 1×. */
  setQuality(q: 'high' | 'low') { this.maxPixelRatio = q === 'high' && !this.soft ? Math.min(window.devicePixelRatio, 2) : 1; this.resize(); }
  get bloomOn() { return this.bloomEnabled; }

  setScreen(screen: Screen) {
    this.screen = screen;
    this.renderPass.scene = screen.scene;
    this.renderPass.camera = screen.camera;
    if (screen.bloom) Object.assign(this.bloomTarget, screen.bloom);
    this.streakTarget = screen.streaks ?? 0.22;
    this.resize();
  }

  /** Camera shake in world units, decaying; a connected pad rumbles with it. */
  addShake(amount: number) { if (!this.reduceMotion) { this.shake = Math.min(1.6, this.shake + amount); rumble(amount); } }
  /** A full-frame flash (0..1) that fades over ~0.3 s. */
  addFlash(amount: number, color = 0xffffff) {
    if (this.reduceMotion) return;
    this.flash = Math.min(0.85, this.flash + amount);
    (this.gradePass.uniforms.uFlashColor.value as THREE.Color).set(color);
  }

  /** Resolve the current screen in with a digital dissolve (skipped for reduced motion). */
  materialize() { if (!this.reduceMotion) this.materializeT = 1; }

  start() {
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** Tooling: render `seconds` of frames synchronously at a fixed step
   * (screenshots and checks while the page's own frame loop is throttled). */
  advance(seconds: number, fps = 60) {
    const n = Math.max(1, Math.round(seconds * fps));
    for (let i = 0; i < n; i++) this.frame(1 / fps);
    this.delta();
  }

  /** Seconds since the previous call (0 on the first). */
  private delta() {
    const now = performance.now();
    const d = this.lastFrame ? (now - this.lastFrame) / 1000 : 0;
    this.lastFrame = now;
    return d;
  }

  private frame(fixedDt?: number) {
    const raw = fixedDt ?? this.delta();
    const dt = Math.min(raw, 1 / 20);
    // Animation steps are capped so a stall never teleports anything; clocks that
    // must keep wall time (a battle's block timer) read this instead.
    this.realDt = Math.min(raw, 0.25);
    // Sample real frame times while visible; sustained < ~38 fps at 2× drops to 1×.
    if (!document.hidden && raw < 0.5) {
      this.perf.t += raw; this.perf.frames++;
      if (this.perf.t > 2) {
        const fps = this.perf.frames / this.perf.t;
        this.perf.slow = fps < 38 ? this.perf.slow + 1 : 0;
        if (this.perf.slow >= 2 && this.maxPixelRatio > 1) {
          this.maxPixelRatio = 1;
          this.resize();
          console.info('[engine] lowering resolution to keep the frame rate up');
        }
        this.perf.t = 0; this.perf.frames = 0;
      }
    }
    this.elapsed += dt;
    const screen = this.screen;
    if (!screen) return;
    screen.update(dt, this.elapsed);

    // Ease bloom toward the screen's preference.
    const b = this.bloomPass;
    b.strength += (this.bloomTarget.strength - b.strength) * Math.min(1, dt * 3);
    b.radius += (this.bloomTarget.radius - b.radius) * Math.min(1, dt * 3);
    b.threshold += (this.bloomTarget.threshold - b.threshold) * Math.min(1, dt * 3);
    this.streakPass.strength += (this.streakTarget - this.streakPass.strength) * Math.min(1, dt * 3);

    // Shake: offset the camera for the render only, then restore.
    const cam = screen.camera;
    let restore: THREE.Vector3 | null = null;
    if (this.shake > 0.001) {
      restore = cam.position.clone();
      const s = this.shake * this.shake;
      cam.position.x += (Math.random() - 0.5) * s;
      cam.position.y += (Math.random() - 0.5) * s;
      this.shake *= Math.exp(-dt * 7);
    }
    this.flash *= Math.exp(-dt * 9);
    // Real time, so a slow first frame after a switch doesn't stretch the dissolve.
    this.materializeT = Math.max(0, this.materializeT - this.realDt / 0.75);
    this.gradePass.uniforms.uMaterialize.value = this.materializeT * this.materializeT * (3 - 2 * this.materializeT);
    this.gradePass.uniforms.uTime.value = this.elapsed;
    this.gradePass.uniforms.uFlash.value = this.flash;
    this.renderer.info.reset();
    this.composer.render(dt);
    const info = this.renderer.info, st = this.stats;
    st.calls = info.render.calls; st.triangles = info.render.triangles; st.points = info.render.points; st.lines = info.render.lines;
    st.textures = info.memory.textures; st.geometries = info.memory.geometries;
    st.width = this.canvas.width; st.height = this.canvas.height;
    if (this.captureCb) { const cb = this.captureCb; this.captureCb = null; this.canvas.toBlob((b) => cb(b), 'image/png'); }
    if (restore) cam.position.copy(restore);
  }
}
