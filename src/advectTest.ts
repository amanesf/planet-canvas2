import * as THREE from 'three';
import { createPlateSimulation } from './plateSim';

// ---------------------------------------------------------------------
// Does the color-advection render target actually change its content on
// this device, or does it just sit there?
// ---------------------------------------------------------------------
// The main app's globe uses this same plateSim.ts machinery, and it
// looks correct in every check possible without the real device: it
// compiles, the injected shader code is present in what's actually sent
// to the GPU, and a 60-second headless desktop run shows the color
// texture visibly changing. But none of that proves the render-target
// ping-pong itself is producing new pixel data on THIS device — the
// earlier gpgpu-test.html probe only ever checked "does dispatching this
// many times per tick crash or hang", never "is the target's content
// actually different afterward". This closes that gap directly: sample
// real pixels back from the real plateSim color texture, at forced high
// speed, and print the numbers — if they hold constant while the device
// clearly renders new frames, the render-target write itself isn't
// taking effect, not just "moving too slowly to notice".
//
// Reads out as text specifically so the numbers can be read off and
// typed back, rather than needing a screenshot.

const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const detailEl = document.querySelector<HTMLDivElement>('#detail')!;
const holder = document.querySelector<HTMLDivElement>('#canvas-holder')!;

function setStatus(text: string) {
  statusEl.textContent = text;
}
function setDetail(text: string) {
  detailEl.textContent = text;
}

let renderer: THREE.WebGLRenderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
} catch (error) {
  setStatus('✕ WebGL コンテキストを作成できませんでした');
  setDetail(String(error));
  throw error;
}
renderer.setSize(512, 256);
holder.appendChild(renderer.domElement);

window.addEventListener('error', (event) => {
  setStatus(`✕ エラーで停止`);
  setDetail(`${event.message}`);
});

// A seed texture with sharp, distinct, high-contrast quadrants — the
// point is that ANY change at all should be unmistakable in the sampled
// numbers, unlike the real terrain texture where a small shift can be
// subtle at any single sample point.
function buildSeedTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const colors = ['#ff2020', '#20ff40', '#2040ff', '#ffe020'];
  const w = canvas.width / 2;
  const h = canvas.height / 2;
  let i = 0;
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) {
      ctx.fillStyle = colors[i++];
      ctx.fillRect(x * w, y * h, w, h);
    }
  }
  // fine grid on top so bilinear blur is visible in the sampled numbers
  // too, not just at quadrant borders
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 2;
  for (let x = 0; x < canvas.width; x += 16) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

// A flat mid-value elevation field — this page is only exercising the
// color/render-target pipeline, not real terrain data, so any constant
// works; it just needs to satisfy createPlateSimulation's contract.
function buildFlatElevationTexture(): THREE.DataTexture {
  const data = new Uint8Array(512 * 256).fill(128);
  const texture = new THREE.DataTexture(data, 512, 256, THREE.RedFormat);
  texture.needsUpdate = true;
  return texture;
}

const seedTexture = buildSeedTexture();
const plateSim = createPlateSimulation(seedTexture, buildFlatElevationTexture());

// Also shown on screen, at the plain sim resolution, so it can be
// visually inspected too if a screenshot is ever wanted — but the text
// readout below is the actual point of this page.
const displayMaterial = new THREE.MeshBasicMaterial({ map: plateSim.getColorTexture() });
const displayScene = new THREE.Scene();
displayScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), displayMaterial));
const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

// A handful of fixed sample points, away from plate seams so a "no
// change" reading isn't a coincidence of landing exactly on a boundary.
const SAMPLE_POINTS: [number, number][] = [
  [128, 64],
  [384, 64],
  [128, 192],
  [384, 192],
  [256, 128],
];
const pixelBuf = new Uint8Array(4);
let baseline: number[][] | null = null;

function samplePixels(): number[][] {
  const colorTexture = plateSim.getColorTexture();
  const rt = new THREE.WebGLRenderTarget(1, 1);
  // readRenderTargetPixels needs an actual WebGLRenderTarget, not a bare
  // texture — wrap the current color texture into a 1x1 read target via
  // a quick blit instead of fighting three's API for reading an
  // arbitrary existing target's texture directly from outside plateSim.
  const blitMaterial = new THREE.MeshBasicMaterial({ map: colorTexture });
  const blitScene = new THREE.Scene();
  const blitMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blitMaterial);
  blitScene.add(blitMesh);
  const results: number[][] = [];
  const prevTarget = renderer.getRenderTarget();
  for (const [px, py] of SAMPLE_POINTS) {
    // Sample one texel by scissoring the source down to it and blitting
    // to a 1x1 target — texture2D lookups don't have a direct JS-side
    // "read this texel" API, so a tiny render is the practical way.
    const u = (px + 0.5) / 512;
    const v = (py + 0.5) / 256;
    blitMesh.position.set(0, 0, 0);
    (blitMaterial.map as THREE.Texture).offset.set(u - 0.5, v - 0.5);
    renderer.setRenderTarget(rt);
    renderer.render(blitScene, orthoCamera);
    renderer.readRenderTargetPixels(rt, 0, 0, 1, 1, pixelBuf);
    results.push([pixelBuf[0], pixelBuf[1], pixelBuf[2]]);
  }
  renderer.setRenderTarget(prevTarget);
  rt.dispose();
  blitMaterial.dispose();
  return results;
}

let frame = 0;
const start = performance.now();
let lastSampleAt = 0;

function tick() {
  frame++;
  const seconds = (performance.now() - start) / 1000;

  // Forced fast speed — this page exists purely to answer "does the
  // content change at all", not to look like realistic drift.
  plateSim.update(renderer, seconds, 100);

  displayMaterial.map = plateSim.getColorTexture();
  renderer.setRenderTarget(null);
  renderer.render(displayScene, orthoCamera);

  if (seconds - lastSampleAt >= 2) {
    lastSampleAt = seconds;
    const samples = samplePixels();
    if (!baseline) baseline = samples;
    let totalDiff = 0;
    for (let i = 0; i < samples.length; i++) {
      for (let c = 0; c < 3; c++) {
        totalDiff += Math.abs(samples[i][c] - baseline[i][c]);
      }
    }
    const lines = samples.map((s, i) => `点${i + 1}: RGB(${s[0]}, ${s[1]}, ${s[2]})`);
    setStatus(`実行中… ${seconds.toFixed(0)}s / t=0からの合計差分: ${totalDiff}`);
    setDetail(
      `${lines.join('\n')}\n\n` +
        (totalDiff > 20
          ? '→ 数字が変化しています(移流は動作しています)'
          : '→ まだ数字がt=0とほぼ同じです(このまま増えなければ移流が効いていない可能性)'),
    );
  }

  requestAnimationFrame(tick);
}

setStatus('実行中…');
requestAnimationFrame(tick);
