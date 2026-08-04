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
    localStorage.setItem(STORAGE_KEY, `frame ${frame} / ${seconds.toFixed(1)}s`);
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

// The "display" step: shows the current state texture on screen, reading
// from whichever render target the simulation just wrote to.
const displayMaterial = new THREE.MeshBasicMaterial({ map: rtA.texture });
const displayScene = new THREE.Scene();
displayScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), displayMaterial));

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

  if (frame % 30 === 0) {
    setStatus(`実行中… frame ${frame} / ${seconds.toFixed(1)}s`);
    setDetail('落ちずに動いていれば、この数字が増え続けます。');
    writeCheckpoint(frame, seconds);
  }

  requestAnimationFrame(tick);
}

setStatus('実行中…');
clearCheckpoint();
requestAnimationFrame(tick);
