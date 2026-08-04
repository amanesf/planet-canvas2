import * as THREE from 'three';

// ---------------------------------------------------------------------
// Minimal GPGPU stability probe
// ---------------------------------------------------------------------
// Standalone and deliberately unrelated to the rest of the app: no
// terrain, no shadows, no post-processing, nothing but the one pattern
// in question — render to an off-screen target, then render the screen
// from it, every single frame, forever. That's the same shape of work a
// live continent-drift simulation would need (write the next height
// state to a texture, read it back to draw), and the same shape of work
// the shadow map + camera-pass composer were doing when this exact class
// of device (Imagination/PowerVR — see main.ts's fullGpuFeatures check)
// started crashing outright during normal use.
//
// The question this answers: is *any* sustained render-target switching
// viable on this device at all, or is the earlier crash tied to the
// specific weight of the full scene? If this crashes fast too, real-time
// plate movement needs a fundamentally throttled/coarser update scheme
// on this hardware, not just a leaner shader. If it runs for minutes
// without trouble, the earlier crash was more likely about everything
// else happening at once, and a careful GPGPU implementation has a real
// shot on this device.
//
// Progress is checkpointed to localStorage every 30 frames specifically
// so a hard crash still leaves a number behind — reloading this page
// after a crash shows the last frame it reached, which a screenshot of a
// dead tab cannot.
//
// Extended a second time for the color-advection design (see the plan
// this session is working from): that design wants a SECOND, larger
// (512x256, versus this file's proven 128x128) ping-pong pair running
// *concurrently* with the first, dispatched up to 12 times within a
// single throttled "tick" at the fast end of the speed toggle — a
// meaningfully different bandwidth/fill-rate profile than the single
// 128x128 pair this file already proved stable for 200+s/5000+ frames.
// Rather than assume that scales, this probes it directly: the original
// small pair still runs every animation frame exactly as before, and a
// second, larger pair now runs alongside it on the same throttled
// tick/substep cadence the real plate-color simulation would use
// (TICK_INTERVAL / MAX_SUBSTEPS_PER_TICK below, copied from
// plateSim.ts), continuously — i.e. permanently pinned at the worst-case
// dispatch rate a real session would only hit while the user is actively
// holding the 100x speed button, not the norm. If this runs for minutes
// without trouble, the color-advection resolution/substep budget in the
// plan is safe to build for real; if it crashes fast, the candidate
// resolution or substep cap needs to come down before writing the
// feature.

const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const detailEl = document.querySelector<HTMLDivElement>('#detail')!;
const holder = document.querySelector<HTMLDivElement>('#canvas-holder')!;

function setStatus(text: string) {
  statusEl.textContent = text;
}
function setDetail(text: string) {
  detailEl.textContent = text;
}

const STORAGE_KEY = 'gpgpuProbeLastFrame';
function readLastCheckpoint(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
function writeCheckpoint(frame: number, seconds: number) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      `frame ${frame} / ${seconds.toFixed(1)}s / 色用ペア ${colorDispatchCount} 回転送`,
    );
  } catch {
    // ignore — private browsing etc.
  }
}
function clearCheckpoint() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

const priorRun = readLastCheckpoint();
if (priorRun) {
  setDetail(`前回の到達点(クラッシュ/終了時の最後の記録): ${priorRun}`);
}

let frame = 0;
const start = performance.now();

window.addEventListener('error', (event) => {
  setStatus(`✕ エラーで停止 (frame ${frame})`);
  setDetail(`${event.message}\n${((performance.now() - start) / 1000).toFixed(1)}s 経過`);
  writeCheckpoint(frame, (performance.now() - start) / 1000);
});
window.addEventListener('unhandledrejection', (event) => {
  setStatus(`✕ エラーで停止 (frame ${frame})`);
  setDetail(`${String(event.reason)}\n${((performance.now() - start) / 1000).toFixed(1)}s 経過`);
  writeCheckpoint(frame, (performance.now() - start) / 1000);
});

let renderer: THREE.WebGLRenderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
} catch (error) {
  setStatus('✕ WebGL コンテキストを作成できませんでした');
  setDetail(String(error));
  throw error;
}
const CANVAS_SIZE = 256;
renderer.setSize(CANVAS_SIZE, CANVAS_SIZE);
holder.appendChild(renderer.domElement);

renderer.domElement.addEventListener(
  'webglcontextlost',
  (event) => {
    event.preventDefault();
    const seconds = (performance.now() - start) / 1000;
    setStatus(`✕ WebGL コンテキストロスト (frame ${frame})`);
    setDetail(`${seconds.toFixed(1)}s 経過`);
    writeCheckpoint(frame, seconds);
  },
  false,
);

const SIM_SIZE = 128;
let rtA = new THREE.WebGLRenderTarget(SIM_SIZE, SIM_SIZE);
let rtB = new THREE.WebGLRenderTarget(SIM_SIZE, SIM_SIZE);

// The candidate color-advection resolution/cadence being probed — see
// the file header. Copied constants, not imported: this file is
// deliberately standalone (see the original header above), and these
// need to match plateSim.ts's real values for the probe to mean anything
// if that file's constants ever change.
const COLOR_SIM_WIDTH = 512;
const COLOR_SIM_HEIGHT = 256;
const TICK_INTERVAL = 0.25;
const MAX_SUBSTEPS_PER_TICK = 12;

let colorRtA = new THREE.WebGLRenderTarget(COLOR_SIM_WIDTH, COLOR_SIM_HEIGHT);
let colorRtB = new THREE.WebGLRenderTarget(COLOR_SIM_WIDTH, COLOR_SIM_HEIGHT);
let colorDispatchCount = 0;
let colorTickAccumulator = 0;

const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

// The "simulation" step: reads the previous state texture, writes a
// slightly-evolved one. Content is intentionally trivial — this probe is
// about the render-target switch itself, not about computation cost.
const simMaterial = new THREE.ShaderMaterial({
  uniforms: {
    tPrev: { value: null },
    uTime: { value: 0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: `
    precision mediump float;
    uniform sampler2D tPrev;
    uniform float uTime;
    varying vec2 vUv;
    void main() {
      vec4 prev = texture2D(tPrev, vUv);
      float wave = sin((vUv.x + vUv.y) * 12.0 + uTime) * 0.5 + 0.5;
      vec3 target = vec3(wave, 1.0 - wave, 0.5 + 0.5 * sin(uTime * 0.7));
      gl_FragColor = vec4(mix(prev.rgb, target, 0.03), 1.0);
    }
  `,
});
const simScene = new THREE.Scene();
simScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), simMaterial));

// The second, larger pair. Same trivial "evolve toward a moving target
// color" shader as the small pair above — this probe is about the
// render-target switch/bandwidth cost at this resolution, not about
// computation cost, exactly as the original file's header says.
const colorSimMaterial = new THREE.ShaderMaterial({
  uniforms: {
    tPrev: { value: null },
    uTime: { value: 0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: `
    precision mediump float;
    uniform sampler2D tPrev;
    uniform float uTime;
    varying vec2 vUv;
    void main() {
      vec4 prev = texture2D(tPrev, vUv);
      float wave = sin((vUv.x - vUv.y) * 18.0 - uTime) * 0.5 + 0.5;
      vec3 target = vec3(wave, 0.5 + 0.5 * sin(uTime * 0.5), 1.0 - wave);
      gl_FragColor = vec4(mix(prev.rgb, target, 0.05), 1.0);
    }
  `,
});
const colorSimScene = new THREE.Scene();
colorSimScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), colorSimMaterial));

// The "display" step: shows the current state texture on screen, reading
// from whichever render target the simulation just wrote to.
const displayMaterial = new THREE.MeshBasicMaterial({ map: rtA.texture });
const displayScene = new THREE.Scene();
displayScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), displayMaterial));

let lastElapsed = 0;

function tick() {
  frame++;
  const seconds = (performance.now() - start) / 1000;

  simMaterial.uniforms.tPrev.value = rtA.texture;
  simMaterial.uniforms.uTime.value = seconds;

  // switch 1: off-screen target
  renderer.setRenderTarget(rtB);
  renderer.render(simScene, orthoCamera);

  const swap = rtA;
  rtA = rtB;
  rtB = swap;
  displayMaterial.map = rtA.texture;

  // switch 2: back to the screen
  renderer.setRenderTarget(null);
  renderer.render(displayScene, orthoCamera);

  // The second, larger pair, throttled and sub-stepped exactly the way
  // plateSim.ts's real update() is — see this file's header. Pinned at
  // the fast-end worst case continuously, not just occasionally.
  const dt = Math.max(0, Math.min(seconds - lastElapsed, 0.25));
  lastElapsed = seconds;
  colorTickAccumulator += dt;
  if (colorTickAccumulator >= TICK_INTERVAL) {
    colorTickAccumulator = 0;
    for (let i = 0; i < MAX_SUBSTEPS_PER_TICK; i++) {
      colorSimMaterial.uniforms.tPrev.value = colorRtA.texture;
      colorSimMaterial.uniforms.uTime.value = seconds + i * 0.01;
      renderer.setRenderTarget(colorRtB);
      renderer.render(colorSimScene, orthoCamera);
      const colorSwap = colorRtA;
      colorRtA = colorRtB;
      colorRtB = colorSwap;
      colorDispatchCount++;
    }
    renderer.setRenderTarget(null);
  }

  if (frame % 30 === 0) {
    setStatus(`実行中… frame ${frame} / ${seconds.toFixed(1)}s`);
    setDetail(
      `落ちずに動いていれば、この数字が増え続けます。\n` +
        `色用ペア(${COLOR_SIM_WIDTH}x${COLOR_SIM_HEIGHT}): ${colorDispatchCount} 回転送`,
    );
    writeCheckpoint(frame, seconds);
  }

  requestAnimationFrame(tick);
}

setStatus('実行中…');
clearCheckpoint();
requestAnimationFrame(tick);
