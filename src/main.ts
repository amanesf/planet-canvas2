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
import { DepthOfFieldShader } from './dof';
import { buildWorkshop } from './setDressing';
import {
  clearDowngradeAfterStableRun,
  currentTier,
  installContextLossRecovery,
  settingsFor,
} from './quality';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div class="title">箱庭プラネット — mockup</div>
  <div class="vignette"></div>
  <div class="ui">
    <button id="mode-toggle" class="mode-button" title="回転を止める" aria-label="回転を止める">⏸</button>
  </div>
  <div class="loading" id="loading" role="status">組み立て中…</div>
`;

const TIER = currentTier();
const QUALITY = settingsFor(TIER);

// Building the model blocks the main thread for seconds: the terrain paint
// alone evaluates noise over a million texels, and the scatter passes test
// hundreds of thousands of candidate positions. Done in one go, the tab is
// frozen for the whole of it — no paint, no input, and on a phone a real
// risk of being killed outright before the first frame ever appears.
//
// Yielding between steps does not make the work any smaller, but it hands
// the browser back often enough to stay alive and to show progress.
// Yielding also gives the loading caption a chance to say where it has got
// to. An unchanging "組み立て中…" is indistinguishable from a page that has
// hung, which is exactly how it was read — so the caption carries the step,
// the elapsed seconds and the quality tier. The tier in particular is the
// one fact worth having when a device behaves differently from every device
// it was tested on.
const BUILD_STEPS = 9;
let buildStep = 0;
const buildStartedAt = performance.now();

function setStatus(text: string): void {
  const el = document.querySelector<HTMLDivElement>('#loading');
  if (el) el.textContent = text;
}

// The build advances on whichever comes first: the next animation frame,
// or a short timer.
//
// requestAnimationFrame alone was a real trap. Browsers do not fire it for
// a hidden tab — so switching away from a page that takes fifteen seconds
// to assemble suspends the build at whatever step it had reached, and it
// never resumes even when you come back, because the promise that step is
// waiting on has already been abandoned. The caption sits there forever.
// The same happens wherever rAF is throttled hard. The timer guarantees
// progress; the frame callback is still preferred when the page is visible,
// because it means each step gets painted.
const yieldToBrowser = (label?: string) =>
  new Promise<void>((resolve) => {
    if (label) {
      buildStep++;
      const seconds = ((performance.now() - buildStartedAt) / 1000).toFixed(1);
      setStatus(`組み立て中… ${label} (${buildStep}/${BUILD_STEPS}) ${seconds}s · ${TIER}`);
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(finish);
    window.setTimeout(finish, 40);
  });

// A build that throws used to leave the caption up forever, with no way to
// tell a failure from a slow phone. Anything unhandled now says so on
// screen — including the case where the GPU drops the context and there is
// no cheaper tier left to retry at, which otherwise ends as a dead canvas
// under a caption that never changes.
window.addEventListener('error', (event) => {
  setStatus(`読み込みに失敗しました: ${event.message}`);
});
window.addEventListener('unhandledrejection', (event) => {
  setStatus(`読み込みに失敗しました: ${String(event.reason)}`);
});

const RADIUS = 2;
const BUMP_HEIGHT = 0.36; // exaggerated on purpose — mountains were reading as flat/thin at 0.22
// The globe *sits on* the pedestal. It used to hover above it with a
// visible gap, as a nod to a magnetic-levitation idea — and that gap was
// one of the strongest anti-physical cues left in the frame: a thing that
// floats is unmistakably not a thing standing on a workbench, however well
// it is lit or painted. In the reference the sphere nests into a brass
// collar on the wood, which is what this height and the cradle ring below
// are set up to reproduce.
const GLOBE_SEAT_Y = 0.6;

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
// Pulled back further than a tight product shot — the reference photo
// leaves a lot of dim, blurred workshop visible above and below the
// globe; filling the whole frame edge-to-edge with the globe (the old
// distance) left no room for that surrounding context to read at all.
const BASE_CAMERA_DISTANCE = 7.0;
function cameraDistanceForViewport() {
  const aspect = window.innerWidth / window.innerHeight;
  if (aspect >= 1) return BASE_CAMERA_DISTANCE;
  return BASE_CAMERA_DISTANCE / Math.max(aspect, 0.45);
}

// The single biggest thing separating "a planet floating in space" from
// "a miniature sitting on my desk" is camera angle, not material tweaks —
// real diorama/miniature photography looks down at roughly 25-35° above
// the horizon, not near eye level. Aim the default view that way.
// The reference is shot from only a little above the globe's equator, not
// steeply down onto it. The steeper angle here was chosen to sell
// "miniature", but it also put the lens so high that nothing standing on
// the bench between camera and subject could enter the frame at all — and
// a defocused object in the near foreground is the single clearest signal
// that a photograph was taken of something small and real.
const CAMERA_POLAR_ANGLE = Math.PI * 0.43; // ~77° from vertical = ~13° above horizon
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

// Getting a context is not a given. A browser will only hand out a limited
// number of live WebGL contexts across all tabs — a dozen or so — and once
// that budget is spent, the next request simply fails. With twenty tabs
// open, or after this page has reloaded itself a few times chasing a lost
// context, that is exactly what happens, and the constructor throws
// "Error creating WebGL context" before anything else can run.
//
// So: ask for less on each retry, and if there is still nothing to be had,
// say so in terms the reader can act on rather than surfacing the raw
// exception.
function createRenderer(): THREE.WebGLRenderer {
  const attempts: THREE.WebGLRendererParameters[] = [
    { antialias: true, alpha: true },
    // antialiasing needs a multisampled buffer, which is a large part of
    // what a constrained driver is refusing to allocate
    { antialias: false, alpha: true },
    // last resort: the integrated GPU, an opaque buffer, and permission to
    // fall back to a software rasteriser
    {
      antialias: false,
      alpha: false,
      powerPreference: 'low-power',
      failIfMajorPerformanceCaveat: false,
    },
  ];

  let lastError: unknown = null;
  for (const options of attempts) {
    try {
      return new THREE.WebGLRenderer(options);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

let renderer: THREE.WebGLRenderer;
try {
  renderer = createRenderer();
} catch (error) {
  setStatus(
    'この端末で 3D を開始できませんでした。ブラウザの他のタブを閉じてから再読み込みしてください。',
  );
  console.error(error);
  throw error;
}
renderer.setSize(window.innerWidth, window.innerHeight);
// capping pixel ratio keeps this from overloading weaker mobile GPUs
renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY.maxPixelRatio));
// Real cast shadows, and they are not optional for this subject. What
// separates the reference photograph from a rendered planet is not its
// palette — it is that the clouds throw soft shadows down onto the sea,
// the coastal cliffs shade the water at their foot, and every mountain
// occludes the valley beside it. Blob decals fake contact, but they
// cannot produce an object shadowing a *different* object, which is the
// cue the eye actually reads as "these things share one physical space".
// Only the key light casts (one shadow pass), and the map is sized for a
// subject that occupies a fixed, known volume.
renderer.shadowMap.enabled = QUALITY.shadowMapSize > 0;
// PCFSoftShadowMap is deprecated in this three version and silently falls
// back to PCF anyway; VSM was tried for a softer edge and produced no
// visible shadow at all here (its light-bleeding term washes out contact
// shade over a subject this small relative to the shadow frustum).
renderer.shadowMap.type = THREE.PCFShadowMap;
// filmic contrast/highlight rolloff — a bright resin highlight should
// roll off smoothly toward white like a real photo, not clip to a flat
// disc the way plain linear output does
renderer.toneMapping = THREE.ACESFilmicToneMapping;
// Turning shadows off does not just remove shade — it *adds* light,
// because every surface that was occluded now receives the key in full. At
// the same exposure the cheap tier came out visibly brighter and flatter
// than the others: not a lower-detail version of the same picture, a
// different one. Pulled back to match.
renderer.toneMappingExposure = QUALITY.shadowMapSize > 0 ? 1.4 : 1.1;
app.appendChild(renderer.domElement);

// Tilt-shift blur (see tiltShift.ts for why this is a cheap single-pass
// shader rather than the stock, much heavier BokehPass). One extra
// full-screen pass with a fixed 8-tap kernel — nowhere near the cost of a
// second full scene render, but still an extra per-frame GPU cost this
// project doesn't have a great deal of headroom for, so it stays modest
// on purpose.
// The composer's own render target carries a depth texture, so the
// depth-of-field pass below can read scene depth without the second full
// scene render the stock BokehPass costs. Both ping-pong buffers share the
// one depth texture: only the RenderPass writes depth, and it runs first
// every frame, so there is nothing to keep separate.
const sceneDepth = QUALITY.depthOfField
  ? new THREE.DepthTexture(window.innerWidth, window.innerHeight)
  : null;
if (sceneDepth) sceneDepth.type = THREE.UnsignedIntType;
// the depthTexture key is omitted rather than passed as undefined: the
// render target treats the key's presence as "attach one"
const composerTarget = new THREE.WebGLRenderTarget(
  window.innerWidth,
  window.innerHeight,
  sceneDepth ? { depthTexture: sceneDepth, depthBuffer: true } : { depthBuffer: true },
);
const composer = new EffectComposer(renderer, composerTarget);
if (sceneDepth) composer.renderTarget2.depthTexture = sceneDepth;

const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);

// At the lowest tier the blur is dropped rather than cheapened: it is the
// most expensive pass per pixel in the frame (every tap costs a color fetch
// *and* a depth fetch), and a device that cannot hold the context is better
// served by a sharp frame than by a soft one it cannot draw. The render pass
// then has to go straight to the screen, since the composer only presents
// through its final enabled pass.
let dofPass: ShaderPass | null = null;
if (sceneDepth) {
  dofPass = new ShaderPass(DepthOfFieldShader);
  dofPass.renderToScreen = true;
  dofPass.material.defines = { ...dofPass.material.defines, RINGS: QUALITY.dofRings };
  composer.addPass(dofPass);
  dofPass.uniforms.tDepth.value = sceneDepth;
  dofPass.uniforms.uNear.value = camera.near;
  dofPass.uniforms.uFar.value = camera.far;
  dofPass.uniforms.uResolution.value.set(window.innerWidth, window.innerHeight);
} else {
  renderPass.renderToScreen = true;
}

// A generic light "room" environment for the resin ocean's reflections,
// generated once at startup (PMREM), not a per-frame cost. Softening the
// reflection is the ocean material's job via its roughness — raising the
// PMREM blur instead only trips its sample cap and gets clamped anyway.
const pmremGenerator = new THREE.PMREMGenerator(renderer);
scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
// the room map is here to put believable reflections in the resin, not to
// light the scene — at full strength it acts as a second, shadowless
// ambient term and flattens everything the key light is doing
scene.environmentIntensity = 0.42;
pmremGenerator.dispose();

// A lost context now comes back at a cheaper tier rather than rebuilding
// the scene that lost it — see quality.ts.
installContextLossRecovery(renderer.domElement, TIER, () =>
  setStatus('この端末では表示できませんでした（WebGL が停止しました）'),
);
// and if this run goes fine, stop holding a past failure against the tab
clearDowngradeAfterStableRun();

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
controls.minPolarAngle = Math.PI * 0.24;
controls.maxPolarAngle = Math.PI * 0.5;
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, TARGET_Y, 0);

// ---------- lighting ----------

// One softbox, one bounce card. That is the whole lighting rig in the
// reference photograph, and matching its *ratio* matters more than
// matching any individual color.
//
// The previous rig had this backwards: ambient 0.72 + fill 0.55 + rim 0.3
// + a full-strength environment map added up to well over half the total
// illumination, all of it from sources that cast nothing. Enabling shadow
// maps against that changed the frame by at most 13 of 255 levels — the
// shadows were rendering correctly and were simply drowned. A shadow is
// only as legible as the fraction of the light it removes, so the key has
// to actually dominate before any of this is visible.
scene.add(new THREE.AmbientLight(0xffe9c2, 0.16));

const keyLight = new THREE.DirectionalLight(0xfff1dc, QUALITY.shadowMapSize > 0 ? 3.4 : 2.6);
keyLight.position.set(-3.2, 4.6, 4.2);
keyLight.castShadow = QUALITY.shadowMapSize > 0;
keyLight.shadow.mapSize.set(QUALITY.shadowMapSize || 1, QUALITY.shadowMapSize || 1);
// the subject is a 2-unit globe floating at a known height on a 1.85-unit
// stand, so the shadow frustum can be wrapped tightly around it instead of
// wasting depth precision on empty scene
keyLight.shadow.camera.left = -4;
keyLight.shadow.camera.right = 4;
keyLight.shadow.camera.top = 4;
keyLight.shadow.camera.bottom = -4;
keyLight.shadow.camera.near = 1;
keyLight.shadow.camera.far = 20;
keyLight.shadow.camera.updateProjectionMatrix(); // three does not do this for you
// normalBias rather than a plain constant bias: the globe is a heavily
// displaced sphere, and a constant offset that clears the shallow terraces
// visibly detaches shadows from the steep cliff faces
keyLight.shadow.bias = -0.00025;
keyLight.shadow.normalBias = 0.005;
scene.add(keyLight);

// the bounce card propped against the desk: enough to keep the shaded
// side readable, nowhere near enough to compete with the key
const fillLight = new THREE.DirectionalLight(0xcfe0f2, 0.42);
fillLight.position.set(3.5, -0.8, 2.5);
scene.add(fillLight);

// cool separation edge along the far side, so the globe doesn't merge
// into the dim background it's sitting against
const rimLight = new THREE.DirectionalLight(0x9fc8e8, 0.35);
rimLight.position.set(-4, 2, -3);
scene.add(rimLight);

// The bench lamp itself. Once the surroundings became real geometry they
// needed a real reason to be visible: the key is aimed at the subject with
// a shadow frustum wrapped tightly around it, so on its own it left the
// desk, the bottles and the foreground clutter sitting in near-black. A
// warm falloff light above the bench lights the room without touching the
// key-to-fill ratio the globe is lit by.
const benchLamp = new THREE.PointLight(0xffcf95, QUALITY.shadowMapSize > 0 ? 210 : 150, 44, 2);
benchLamp.position.set(-3, 7, 4);
scene.add(benchLamp);

// ---------- globe: displaced sphere, crisp painted terrain texture ----------

await yieldToBrowser('作業台');
scene.add(buildWorkshop());

const globeGroup = new THREE.Group();
globeGroup.position.set(0, GLOBE_SEAT_Y, 0);
scene.add(globeGroup);

// terrain color is painted once onto a texture (crisp, cheap to sample)
// instead of interpolated per-vertex (which read as blurry) — geometry
// only needs to be smooth enough to carry the displacement + lighting
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

  // dark walnut/espresso, not a light honey oak — a real display pedestal
  // for something like this is a rich, near-black-brown stained hardwood
  const base = ctx.createLinearGradient(0, 0, width, 0);
  base.addColorStop(0, '#4a2c19');
  base.addColorStop(0.5, '#6b4023');
  base.addColorStop(1, '#4a2c19');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, width, height);

  for (let i = 0; i < 70; i++) {
    const y = Math.random() * height;
    // the grain was mixed so dark against so dark a base that it never
    // resolved at all — the pedestal read as a flat brown gradient
    ctx.strokeStyle = `rgba(30, 15, 7, ${0.16 + Math.random() * 0.26})`;
    ctx.lineWidth = 1 + Math.random() * 3.5;
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
  texture.repeat.set(2, 1);
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
baseTop.castShadow = true;
standGroup.add(baseTop);

// small brass nameplate on the front of the pedestal
function buildPlaqueTexture(width = 512, height = 160): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(38, 24, 8, 0.92)';
  ctx.font = '600 56px "Hiragino Maru Gothic ProN", "Yu Gothic", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('箱庭プラネット', width / 2, height / 2 + 2);
  const texture = new THREE.CanvasTexture(canvas);
  return texture;
}

// Polished metal is almost pure reflection, so in a dim room a fully
// metallic surface renders nearly black — which is what turned the
// nameplate into a dull brown slab. Backing off the metalness lets some
// diffuse brass colour through, and a strong environment term gives it the
// warm sheen the reference's fittings have.
const plaqueMaterial = new THREE.MeshStandardMaterial({
  color: 0xd8ab5c,
  metalness: 0.55,
  roughness: 0.28,
  envMapIntensity: 1.8,
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

// a thin brass trim ring right at the seam between the two wood tiers —
// the "museum trophy base" detail that reads as a real display stand
// rather than a plain stacked block of wood
const trimRing = new THREE.Mesh(
  new THREE.CylinderGeometry(1.655, 1.655, 0.045, 48, 1, true),
  plaqueMaterial,
);
trimRing.position.y = -1.75;
standGroup.add(trimRing);

// The brass collar the sphere rests in. A pulsing glow ring used to sit
// here; a glowing ring belongs to a sci-fi prop, not to something
// photographed on a workbench next to a jar of paint.
// A ring of radius 1.2 at this height was not cradling anything: the
// sphere's bottom is only about 1.42 below its centre, so at that height
// the sphere is already down to a point and the ring was a wide disc
// around its tip. Sized to the sphere's actual horizontal radius where it
// meets the collar, and raised onto a turned wooden neck so the brass has
// something to sit on.
const collarNeck = new THREE.Mesh(
  new THREE.CylinderGeometry(1.16, 1.2, 0.48, 44),
  baseMaterial,
);
collarNeck.position.y = -1.29;
collarNeck.castShadow = true;
collarNeck.receiveShadow = true;
standGroup.add(collarNeck);

// Sized to where the sphere actually is at the collar's height, so the
// brass meets the curve instead of ringing empty air below the south pole.
const cradleRing = new THREE.Mesh(
  new THREE.TorusGeometry(1.16, 0.065, 16, 72),
  plaqueMaterial,
);
cradleRing.rotation.x = Math.PI / 2;
cradleRing.position.y = -1.05;
cradleRing.castShadow = true;
cradleRing.receiveShadow = true;
standGroup.add(cradleRing);

// (the globe's shadow on the stand is a real cast shadow now — the blob
// decal that used to stand in for it would only double up on top of it)

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
let rendering = false;
let globeTick: ((t: number) => void) | null = null;

function startRendering() {
  if (rendering) return;
  rendering = true;
  animate();
}

function animate() {
  const t = clock.getElapsedTime();

  if (spinning) {
    globeGroup.rotation.y += 0.0025 * 60 * (1 / 60);
  }

  // A display globe sits still in its collar; the bob that used to be here
  // was the levitation idea, and it survived the sphere being seated only
  // as a slow wobble that read as the whole model being loose.
  globeGroup.rotation.z = 0.04;

  // The globe's own per-frame work is registered once it exists. It cannot
  // be referenced directly from here: rendering starts before those
  // bindings are initialised, and a `const` read before its declaration
  // throws rather than yielding undefined, so an optional-chained access
  // would not have saved it either.
  globeTick?.(t);


  // keep the focal plane pinned to the front face of the globe as the
  // viewer orbits or zooms, the way a photographer refocuses on the
  // subject rather than on a fixed distance
  if (dofPass) {
    const globeCenter = globeGroup.position;
    dofPass.uniforms.uFocusDistance.value = Math.max(
      camera.position.distanceTo(globeCenter) - RADIUS * 0.72,
      0.5,
    );
  }

  controls.update();
  composer.render();
  requestAnimationFrame(animate);
}


// The bench, the stand and the lighting are all cheap; the globe is not.
// Rendering starts here rather than after everything is finished, so the
// scene appears within a second or so and visibly fills in, instead of
// showing a caption for the twenty seconds the model takes to assemble on
// a phone — which is indistinguishable from the page having hung, and was
// read as exactly that.
startRendering();

const geometry = new THREE.SphereGeometry(RADIUS, QUALITY.globeSegments[0], QUALITY.globeSegments[1]);
displaceSphere(geometry, RADIUS, BUMP_HEIGHT);
await yieldToBrowser('地形');
const TEX_W = QUALITY.textureWidth;
const TEX_H = TEX_W / 2;
await yieldToBrowser('地形');
const terrainTexture = buildTerrainTexture(TEX_W, TEX_H);
await yieldToBrowser('起伏');

const terrainBumpTexture = buildBumpTexture(TEX_W, TEX_H);
await yieldToBrowser('海');

const globeMaterial = new THREE.MeshStandardMaterial({
  map: terrainTexture,
  // fine surface relief via lighting only (no extra geometry) — the
  // single biggest lever for "sculpted miniature" vs. "smooth painted
  // ball" once you actually zoom in on it
  bumpMap: terrainBumpTexture,
  bumpScale: 0.005,
  // pushed to fully matte — the whole point of the glossy ocean resin is
  // that it's the *only* shiny thing in the scene; any gloss on the rock
  // undercuts that contrast and makes both materials read as "plastic"
  roughness: 0.97,
  metalness: 0,
  envMapIntensity: 0.06,
});

const globeMesh = new THREE.Mesh(geometry, globeMaterial);
globeMesh.castShadow = true;
globeMesh.receiveShadow = true;
globeGroup.add(globeMesh);

// glossy resin-like ocean shell sitting right at sea level, covering the
// flattened seabed below. Mostly opaque with a hard glassy clearcoat reads
// as poured diorama resin; the earlier more-transparent/liquid version
// read as a soft gummy-candy jelly instead of a solid miniature material.
const oceanGeometry = new THREE.SphereGeometry(
  seaLevelRadius(RADIUS, BUMP_HEIGHT),
  QUALITY.oceanSegments[0],
  QUALITY.oceanSegments[1],
);
rippleSphere(oceanGeometry, seaLevelRadius(RADIUS, BUMP_HEIGHT), 0.004);
// a thin raised lip hugging the actual coastline, like poured resin (or
// real water) climbing slightly against the land instead of meeting it
// as a flat sheet
applyCoastalMeniscus(oceanGeometry, 0.006);
const oceanTexture = buildOceanTexture(TEX_W, TEX_H);
await yieldToBrowser('水面');
const waveTexture = buildWaveTexture();
await yieldToBrowser('植生');
const oceanMaterial = new THREE.MeshPhysicalMaterial({
  map: oceanTexture,
  // a directional wave pattern, slowly scrolled in the animation loop —
  // gives moving, shimmering highlights instead of a fixed pattern
  bumpMap: waveTexture,
  bumpScale: 0.012,
  transparent: true,
  // full strength — the per-texel alpha ramp baked into the ocean texture
  // is what varies the transparency now, so a flat material opacity here
  // would only fight it
  opacity: 1,
  roughness: 0.3,
  metalness: 0,
  // poured-epoxy-resin read: a strong, very smooth clearcoat gives the
  // hard, glassy top layer real resin has, instead of reading as a
  // painted-flat "lake" surface. Sharper clearcoat highlights (low
  // clearcoatRoughness) rather than a soft/wide sheen is what actually
  // sells "smooth cured epoxy" over "wet candy" — that came from the
  // *base* roughness being too low, not the clearcoat itself.
  clearcoat: 0.85,
  clearcoatRoughness: 0.16,
  ior: 1.5,
  // enough ambient reflection to keep the resin looking wet/glassy
  // without washing the saturated blue out to a flat gray-teal
  envMapIntensity: 0.35,
});
const oceanMesh = new THREE.Mesh(oceanGeometry, oceanMaterial);
// receives only — a translucent resin sheet casting a hard opaque shadow
// onto the seabed it covers would read as a lid, not as water
oceanMesh.receiveShadow = true;
globeGroup.add(oceanMesh);

// scattered trees and rocks — discrete miniature objects standing on the
// terrain are what actually reads as "diorama", not just a smooth
// colored/shiny surface
await yieldToBrowser('植生');
const vegetation = buildVegetation(RADIUS, BUMP_HEIGHT, QUALITY.canopyDetail, QUALITY.scatterBudget);
vegetation.traverse((child) => {
  if ((child as THREE.Mesh).isMesh) {
    child.castShadow = true;
    child.receiveShadow = true;
  }
});
globeGroup.add(vegetation);

// (A faint white "atmosphere" shell used to sit here, wrapping the whole
// globe at five percent opacity. On a planet render that reads as air; on a
// photographed object it is a veil of milk over every material at once,
// flattening the resin's depth, greying the rock and desaturating the
// flock. Nothing in the reference has an atmosphere — it is a painted ball
// on a desk — so the shell is gone.)

// real puffy 3D clouds with cast shadows — matches the design memo's
// "evaporation + rain shadow" sky layer with an actual visible presence
await yieldToBrowser('雲');
const clouds = buildClouds(RADIUS);
// (castShadow is decided per layer inside buildClouds: the opaque core
// casts, the translucent fringe does not.)
globeGroup.add(clouds);

// ---------- stand: real wood pedestal + nameplate, globe hovers just
// slightly above it (a hint of "magnetic levitation" kept, but the wood
// itself — not a glowing ring — is now the dominant, grounded object) ----------

// ---------- resize ----------

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  if (sceneDepth) {
    sceneDepth.image.width = window.innerWidth;
    sceneDepth.image.height = window.innerHeight;
    sceneDepth.needsUpdate = true;
  }
  dofPass?.uniforms.uResolution.value.set(window.innerWidth, window.innerHeight);

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

globeTick = (t) => {
  waveTexture.offset.x = t * 0.006;
  waveTexture.offset.y = Math.sin(t * 0.15) * 0.01;
};

document.querySelector<HTMLDivElement>('#loading')?.remove();
