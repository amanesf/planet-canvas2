import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import {
  applyCoastalMeniscus,
  buildBumpTexture,
  buildOceanTexture,
  buildTerrainTexture,
  buildWaveTexture,
  displaceSphere,
  rippleSphere,
  seaLevelRadius,
} from './terrain';
import { buildVegetation } from './vegetation';
import { buildClouds } from './clouds';
import { TiltShiftShader } from './tiltShift';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div class="title">箱庭プラネット — mockup</div>
  <div class="vignette"></div>
  <div class="ui">
    <button id="mode-toggle" class="mode-button" title="回転を止める" aria-label="回転を止める">⏸</button>
  </div>
`;

const RADIUS = 2;
const BUMP_HEIGHT = 0.34; // exaggerated on purpose — mountains were reading as flat/thin at 0.22
// A real wood pedestal reads as the dominant, grounded object; the globe
// should hover just slightly above it (a hint of the magnetic-levitation
// idea), not float high overhead like a sci-fi prop.
const GLOBE_FLOAT_Y = 0.95;

// ---------- renderer / scene / camera ----------

const app = document.querySelector<HTMLDivElement>('#app')!;

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  40,
  window.innerWidth / window.innerHeight,
  0.1,
  100,
);

// on a narrow portrait screen the globe + stand need more breathing room
// horizontally, so pull the camera back as the viewport gets taller than wide
const BASE_CAMERA_DISTANCE = 9.5;
function cameraDistanceForViewport() {
  const aspect = window.innerWidth / window.innerHeight;
  if (aspect >= 1) return BASE_CAMERA_DISTANCE;
  return BASE_CAMERA_DISTANCE / Math.max(aspect, 0.45);
}

// The single biggest thing separating "a planet floating in space" from
// "a miniature sitting on my desk" is camera angle, not material tweaks —
// real diorama/miniature photography looks down at roughly 25-35° above
// the horizon, not near eye level. Aim the default view that way.
const CAMERA_POLAR_ANGLE = Math.PI * 0.36; // ~65° from vertical = ~25° above horizon
const TARGET_Y = 1.0;
function cameraStartPosition() {
  const dist = cameraDistanceForViewport();
  return new THREE.Vector3(
    0,
    TARGET_Y + dist * Math.cos(CAMERA_POLAR_ANGLE),
    dist * Math.sin(CAMERA_POLAR_ANGLE),
  );
}
const startPos = cameraStartPosition();
camera.position.set(startPos.x, startPos.y, startPos.z);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
// capping pixel ratio keeps this from overloading weaker mobile GPUs
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
// real-time shadow maps are a well-known trigger for driver-level GPU
// hangs/resets on weaker mobile GPUs after continuous rendering — the
// fake blob shadow under the globe (contactShadow, below) does the same
// visual job for a fraction of the cost, so skip real shadows entirely
renderer.shadowMap.enabled = false;
app.appendChild(renderer.domElement);

// Tilt-shift blur (see tiltShift.ts for why this is a cheap single-pass
// shader rather than the stock, much heavier BokehPass). One extra
// full-screen pass with a fixed 8-tap kernel — nowhere near the cost of a
// second full scene render, but still an extra per-frame GPU cost this
// project doesn't have a great deal of headroom for, so it stays modest
// on purpose.
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const tiltShiftPass = new ShaderPass(TiltShiftShader);
tiltShiftPass.renderToScreen = true;
composer.addPass(tiltShiftPass);
tiltShiftPass.uniforms.uResolution.value.set(window.innerWidth, window.innerHeight);

// a generic light "room" environment for the glass ocean's reflections/
// highlights — generated once at startup (PMREM), not a per-frame cost
const pmremGenerator = new THREE.PMREMGenerator(renderer);
scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
pmremGenerator.dispose();

// if the GPU driver does drop the context, the page can't recover its
// uploaded textures/geometry on its own — reload rather than leaving a
// permanently blank canvas
renderer.domElement.addEventListener(
  'webglcontextlost',
  (event) => {
    event.preventDefault();
    console.warn('WebGL context lost — reloading to recover');
    window.setTimeout(() => window.location.reload(), 300);
  },
  false,
);

// ---------- controls: pinch / wheel zoom, drag to look around ----------

const controls = new OrbitControls(camera, renderer.domElement);
controls.enablePan = false;
controls.enableZoom = true;
controls.enableRotate = true;
let viewportScale = cameraDistanceForViewport() / BASE_CAMERA_DISTANCE;
controls.minDistance = 5 * viewportScale;
controls.maxDistance = 14 * viewportScale;
// keep the user inside "looking down at a diorama" territory — never let
// them drop to a flat eye-level view (which reads as "planet in space"
// again) or flip to looking sharply up from underneath the stand
controls.minPolarAngle = Math.PI * 0.22;
controls.maxPolarAngle = Math.PI * 0.55;
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, TARGET_Y, 0);

// ---------- lighting ----------

// A real diorama sits under one strong, slightly-raking desk lamp, not
// flat, even studio light — low ambient + a punchy single key light is
// what gives every surface a visible sharp light/shadow terminator
// instead of the flat "everything is equally lit" CG read. The fake
// contact-shadow decals (shadow.ts) point along this exact same light
// direction, so the two reinforce each other as "one consistent light
// source" instead of looking like unrelated effects.
scene.add(new THREE.AmbientLight(0xfff1e0, 0.32));

const keyLight = new THREE.DirectionalLight(0xfff6e6, 1.95);
keyLight.position.set(4, 5, 3);
scene.add(keyLight);

const rimLight = new THREE.DirectionalLight(0xbfe0ff, 0.38);
rimLight.position.set(-4, 2, -3);
scene.add(rimLight);

// ---------- globe: displaced sphere, crisp painted terrain texture ----------

const globeGroup = new THREE.Group();
globeGroup.position.set(0, GLOBE_FLOAT_Y, 0);
scene.add(globeGroup);

// terrain color is painted once onto a texture (crisp, cheap to sample)
// instead of interpolated per-vertex (which read as blurry) — geometry
// only needs to be smooth enough to carry the displacement + lighting
const geometry = new THREE.SphereGeometry(RADIUS, 112, 64);
displaceSphere(geometry, RADIUS, BUMP_HEIGHT);
const terrainTexture = buildTerrainTexture();

const globeMaterial = new THREE.MeshStandardMaterial({
  map: terrainTexture,
  // fine surface relief via lighting only (no extra geometry) — the
  // single biggest lever for "sculpted miniature" vs. "smooth painted
  // ball" once you actually zoom in on it
  bumpMap: buildBumpTexture(),
  bumpScale: 0.004,
  roughness: 0.88,
  metalness: 0.02,
  envMapIntensity: 0.15, // painted-clay matte, not shiny/rubbery
});

const globeMesh = new THREE.Mesh(geometry, globeMaterial);
globeMesh.castShadow = true;
globeMesh.receiveShadow = true;
globeGroup.add(globeMesh);

// glossy resin-like ocean shell sitting right at sea level, covering the
// flattened seabed below. Mostly opaque with a hard glassy clearcoat reads
// as poured diorama resin; the earlier more-transparent/liquid version
// read as a soft gummy-candy jelly instead of a solid miniature material.
const oceanGeometry = new THREE.SphereGeometry(seaLevelRadius(RADIUS, BUMP_HEIGHT), 96, 56);
rippleSphere(oceanGeometry, seaLevelRadius(RADIUS, BUMP_HEIGHT), 0.004);
// a thin raised lip hugging the actual coastline, like poured resin (or
// real water) climbing slightly against the land instead of meeting it
// as a flat sheet
applyCoastalMeniscus(oceanGeometry, 0.006);
const waveTexture = buildWaveTexture();
const oceanMaterial = new THREE.MeshPhysicalMaterial({
  map: buildOceanTexture(),
  // a directional wave pattern, slowly scrolled in the animation loop —
  // gives moving, shimmering highlights instead of a fixed pattern
  bumpMap: waveTexture,
  bumpScale: 0.006,
  transparent: true,
  opacity: 0.95,
  roughness: 0.3,
  metalness: 0,
  // poured-epoxy-resin read: a strong, very smooth clearcoat gives the
  // hard, glassy top layer real resin has, instead of reading as a
  // painted-flat "lake" surface. Sharper clearcoat highlights (low
  // clearcoatRoughness) rather than a soft/wide sheen is what actually
  // sells "smooth cured epoxy" over "wet candy" — that came from the
  // *base* roughness being too low, not the clearcoat itself.
  clearcoat: 0.75,
  clearcoatRoughness: 0.1,
  ior: 1.5,
  envMapIntensity: 0.4,
});
const oceanMesh = new THREE.Mesh(oceanGeometry, oceanMaterial);
globeGroup.add(oceanMesh);

// scattered trees and rocks — discrete miniature objects standing on the
// terrain are what actually reads as "diorama", not just a smooth
// colored/shiny surface
globeGroup.add(buildVegetation(RADIUS, BUMP_HEIGHT));

// faint atmospheric haze shell, purely decorative
const hazeGeometry = new THREE.SphereGeometry(RADIUS + 0.16, 48, 32);
const hazeMaterial = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  transparent: true,
  opacity: 0.05,
  roughness: 1,
  depthWrite: false,
});
const hazeMesh = new THREE.Mesh(hazeGeometry, hazeMaterial);
globeGroup.add(hazeMesh);

// real puffy 3D clouds with cast shadows — matches the design memo's
// "evaporation + rain shadow" sky layer with an actual visible presence
globeGroup.add(buildClouds(RADIUS, BUMP_HEIGHT));

// ---------- stand: real wood pedestal + nameplate, globe hovers just
// slightly above it (a hint of "magnetic levitation" kept, but the wood
// itself — not a glowing ring — is now the dominant, grounded object) ----------

const standGroup = new THREE.Group();
scene.add(standGroup);

// Simple procedural wood grain: a warm base tone with streaky darker
// fibers running around the cylinder, plus a glossy clearcoat for the
// "varnished tabletop display stand" read rather than flat painted wood.
function buildWoodTexture(width = 512, height = 512): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const base = ctx.createLinearGradient(0, 0, width, 0);
  base.addColorStop(0, '#7c5330');
  base.addColorStop(0.5, '#9c6b3e');
  base.addColorStop(1, '#7c5330');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, width, height);

  for (let i = 0; i < 46; i++) {
    const y = Math.random() * height;
    ctx.strokeStyle = `rgba(50, 28, 12, ${0.05 + Math.random() * 0.13})`;
    ctx.lineWidth = 1 + Math.random() * 2.5;
    ctx.beginPath();
    let x = 0;
    let yy = y;
    ctx.moveTo(x, yy);
    while (x < width) {
      x += 16 + Math.random() * 26;
      yy += (Math.random() - 0.5) * 16;
      ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 1);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const baseMaterial = new THREE.MeshPhysicalMaterial({
  map: buildWoodTexture(),
  roughness: 0.5,
  metalness: 0.04,
  clearcoat: 0.55,
  clearcoatRoughness: 0.22,
  envMapIntensity: 0.35,
});

const baseBottom = new THREE.Mesh(
  new THREE.CylinderGeometry(1.65, 1.85, 0.35, 48),
  baseMaterial,
);
baseBottom.position.y = -1.9;
baseBottom.receiveShadow = true;
baseBottom.castShadow = true;
standGroup.add(baseBottom);

const baseTop = new THREE.Mesh(
  new THREE.CylinderGeometry(1.3, 1.65, 0.25, 48),
  baseMaterial,
);
baseTop.position.y = -1.65;
baseTop.receiveShadow = true;
standGroup.add(baseTop);

// small brass nameplate on the front of the pedestal
function buildPlaqueTexture(width = 512, height = 160): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(60, 42, 16, 0.65)';
  ctx.font = '600 56px "Hiragino Maru Gothic ProN", "Yu Gothic", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('箱庭プラネット', width / 2, height / 2 + 2);
  const texture = new THREE.CanvasTexture(canvas);
  return texture;
}

const plaqueMaterial = new THREE.MeshStandardMaterial({
  color: 0xcda45e,
  metalness: 0.85,
  roughness: 0.32,
  envMapIntensity: 0.6,
});
const plaqueBacking = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.32, 0.03), plaqueMaterial);
plaqueBacking.position.set(0, -1.86, 1.78);
standGroup.add(plaqueBacking);

const plaqueTextMaterial = new THREE.MeshBasicMaterial({
  map: buildPlaqueTexture(),
  transparent: true,
});
const plaqueText = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 0.29), plaqueTextMaterial);
plaqueText.position.set(0, -1.86, 1.797);
standGroup.add(plaqueText);

// A thin, understated glow ring — just a hint of the magnetic-levitation
// idea now that the wood pedestal itself is the dominant grounded object,
// not the sci-fi centerpiece it was before
const glowRingGeometry = new THREE.TorusGeometry(1.05, 0.028, 16, 64);
const glowRingMaterial = new THREE.MeshBasicMaterial({
  color: 0xffe5b8,
  transparent: true,
  opacity: 0.3,
});
const glowRing = new THREE.Mesh(glowRingGeometry, glowRingMaterial);
glowRing.rotation.x = Math.PI / 2;
glowRing.position.y = -1.45;
standGroup.add(glowRing);

// soft contact shadow blob cast onto the stand by the floating globe
const shadowGeometry = new THREE.CircleGeometry(1.1, 48);
const shadowMaterial = new THREE.MeshBasicMaterial({
  color: 0x40281a,
  transparent: true,
  opacity: 0.22,
});
const contactShadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
contactShadow.rotation.x = -Math.PI / 2;
contactShadow.position.y = -1.52;
standGroup.add(contactShadow);

// ---------- resize ----------

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  tiltShiftPass.uniforms.uResolution.value.set(window.innerWidth, window.innerHeight);

  // rescale the orbit distance (and its clamps) for the new aspect ratio,
  // preserving how zoomed-in the user currently is
  const newScale = cameraDistanceForViewport() / BASE_CAMERA_DISTANCE;
  const zoomRatio = newScale / viewportScale;
  const offset = camera.position.clone().sub(controls.target);
  offset.setLength(offset.length() * zoomRatio);
  camera.position.copy(controls.target).add(offset);
  controls.minDistance = 5 * newScale;
  controls.maxDistance = 14 * newScale;
  viewportScale = newScale;
  controls.update();
});

// ---------- rotate / stop toggle ----------

let spinning = true;
const toggleButton = document.querySelector<HTMLButtonElement>('#mode-toggle')!;
toggleButton.addEventListener('click', () => {
  spinning = !spinning;
  toggleButton.textContent = spinning ? '⏸' : '▶';
  const label = spinning ? '回転を止める' : '回転を再開する';
  toggleButton.title = label;
  toggleButton.setAttribute('aria-label', label);
});

// ---------- animation loop ----------

const clock = new THREE.Clock();

function animate() {
  const t = clock.getElapsedTime();

  if (spinning) {
    globeGroup.rotation.y += 0.0025 * 60 * (1 / 60);
  }

  // gentle magnetic-levitation bob + a touch of tilt — subtler now that
  // the wood pedestal (not the floating effect) is the visual anchor
  globeGroup.position.y = GLOBE_FLOAT_Y + Math.sin(t * 1.1) * 0.035;
  globeGroup.rotation.z = Math.sin(t * 0.6) * 0.02;

  hazeMesh.rotation.y += 0.0006;
  waveTexture.offset.x = t * 0.006;
  waveTexture.offset.y = Math.sin(t * 0.15) * 0.01;

  const ringPulse = 0.45 + Math.sin(t * 2.2) * 0.1;
  glowRingMaterial.opacity = ringPulse;
  contactShadow.scale.setScalar(1 + Math.sin(t * 1.1) * 0.03);

  controls.update();
  composer.render();
  requestAnimationFrame(animate);
}

animate();
