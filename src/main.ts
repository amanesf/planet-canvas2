import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import {
  applyCoastalMeniscus,
  buildBumpTexture,
  buildCityLightsTexture,
  buildOceanTexture,
  buildTerrainTexture,
  buildWaveTexture,
  displaceSphere,
  loadClimateData,
  loadRealElevationData,
  rippleSphere,
  seaLevelRadius,
} from './terrain';
import { buildSpecies } from './species';
import { buildClouds, zonalWind } from './clouds';
import { buildSnowfall } from './snowfall';
import { buildEruptions } from './eruptions';
import { buildLandmarks } from './landmarks';
import { buildAircraft, buildSatellites, buildShips } from './traffic';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CameraPassShader } from './cameraPass';
import { buildWorkshop } from './setDressing';


document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div class="title">箱庭プラネット — mockup</div>
  <div class="ui">
    <button id="mode-toggle" class="mode-button" title="回転を止める" aria-label="回転を止める">⏸</button>
  </div>
  <div class="loading" id="loading" role="status">組み立て中…</div>
`;

// One configuration, not a ladder of them.
//
// There used to be three quality tiers with an automatic downgrade on a
// lost context. It cost more than it bought: three code paths to keep in
// step, tiers that differed in whether depth of field and shadows exist at
// all (so the cheap one was a visibly different picture rather than a
// lower-detail one), and a downgrade that stuck to the tab and pinned it
// there. The failure that triggered it in practice was running out of
// WebGL contexts because too many tabs were open — nothing to do with what
// the device could sustain. These numbers are picked for a current phone
// and used everywhere.
// Chased a crash on a real mid/low-end Android phone through several
// rounds here: cutting these numbers hard, on their own, never got a
// stable combination with shadows on. What actually fixed it was turning
// shadow mapping off (see renderer.shadowMap.enabled below) — a
// standalone stress test of the same device (gpgpu-test.html) ran a
// per-frame render-target switch, the same shape of work the camera pass
// alone needs, clean for 200+ seconds and 5000+ frames, and post-
// processing by itself turned out to be fine at these numbers too. So
// these are restored most of the way back toward their original values
// now that the actual culprit is isolated and off, rather than left at
// the hardest cuts that turned out not to be what mattered.
const SETTINGS = {
  /** longitudinal / latitudinal segments for the displaced globe */
  // Raised from 200x112. This, not the elevation data, was what stopped
  // Japan (about four degrees across) from having a recognisable shape:
  // at 200 segments a degree and a half of longitude is one quad, so the
  // whole archipelago was two vertices wide however good the height field
  // underneath it was.
  globeSegments: [384, 216] as const,
  oceanSegments: [76, 44] as const,
  shadowMapSize: 768,
  /** rings of blur taps in the camera pass; each ring is 8 taps */
  dofRings: 1,
  maxPixelRatio: 1.2,
  /** width of the baked terrain/ocean/bump textures; height is half */
  // Doubled alongside the geometry, and alongside a source elevation image
  // that went to 4096x2048 in the same pass — a crisper coastline is no
  // use if the paint over it is still averaging four of its pixels into
  // one.
  textureWidth: 2048,
};

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
const BUILD_STEPS = 16;
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
      setStatus(`組み立て中… ${label} (${buildStep}/${BUILD_STEPS}) ${seconds}s`);
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
//
// A specific failure (the WebGL context refusal below, in particular) sets
// its own actionable message and then throws to halt startup — but that
// throw reaches this same generic handler, which used to immediately
// overwrite the actionable message with the raw exception text, so the
// reader only ever saw "Error creating WebGL context" and never the "close
// your other tabs" guidance that was written specifically for them. This
// flag lets a specific handler claim the caption so its message survives.
let fatalErrorShown = false;
window.addEventListener('error', (event) => {
  if (fatalErrorShown) return;
  setStatus(`読み込みに失敗しました: ${event.message}`);
});
window.addEventListener('unhandledrejection', (event) => {
  if (fatalErrorShown) return;
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
  fatalErrorShown = true;
  setStatus(
    'この端末で 3D を開始できませんでした。ブラウザの他のタブを閉じてから再読み込みしてください。',
  );
  console.error(error);
  throw error;
}
renderer.setSize(window.innerWidth, window.innerHeight);
// capping pixel ratio keeps this from overloading weaker mobile GPUs
renderer.setPixelRatio(Math.min(window.devicePixelRatio, SETTINGS.maxPixelRatio));

// Real cast shadows, and they are not optional for this subject. What
// separates the reference photograph from a rendered planet is not its
// palette — it is that the clouds throw soft shadows down onto the sea,
// the coastal cliffs shade the water at their foot, and every mountain
// occludes the valley beside it. Blob decals fake contact, but they
// cannot produce an object shadowing a *different* object, which is the
// cue the eye actually reads as "these things share one physical space".
// Only the key light casts (one shadow pass), and the map is sized for a
// subject that occupies a fixed, known volume.
//
// A device kept crashing on this even after the whole scene's weight
// (SETTINGS, species.ts's CANDIDATES, clouds.ts's cloud count) came down
// hard — with the camera-pass composer still on. Temporarily off, as a
// diagnostic: does shadows alone (against everything else already at
// today's reduced weight, and post-processing left running) survive on
// that device? Whatever the answer, it narrows down whether the crash is
// shadows specifically, the composer specifically, or needs both present
// at once — see the same reasoning trail above/in git log for the
// composer side of this.
renderer.shadowMap.enabled = false;
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
renderer.toneMappingExposure = 1.9;
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
const sceneDepth = new THREE.DepthTexture(window.innerWidth, window.innerHeight);
sceneDepth.type = THREE.UnsignedIntType;
// the depthTexture key is omitted rather than passed as undefined: the
// render target treats the key's presence as "attach one"
const composerTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
  depthTexture: sceneDepth,
  depthBuffer: true,
});
const composer = new EffectComposer(renderer, composerTarget);
composer.renderTarget2.depthTexture = sceneDepth;

const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);

const cameraPass = new ShaderPass(CameraPassShader);
cameraPass.renderToScreen = true;
cameraPass.material.defines = { ...cameraPass.material.defines, RINGS: SETTINGS.dofRings };
composer.addPass(cameraPass);
cameraPass.uniforms.tDepth.value = sceneDepth;
cameraPass.uniforms.uNear.value = camera.near;
cameraPass.uniforms.uFar.value = camera.far;
cameraPass.uniforms.uResolution.value.set(window.innerWidth, window.innerHeight);

// The environment the resin reflects.
//
// This used three's RoomEnvironment, and the sea paid for it: that scene is
// a box with several bright rectangular light panels in it, and a smooth
// glossy sphere reflects them as two or three hard, discrete ovals. Read as
// a material, that is a glass marble catching windows — not a poured resin
// surface under a softbox. What is wanted instead is a single broad
// gradient: bright overhead, falling off to the dark bench below, with no
// shape in it to be reflected as an object.
function buildStudioEnvironment(): THREE.Texture {
  const width = 64;
  const height = 32;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, '#fdf6e8'); // the softbox directly above
  sky.addColorStop(0.42, '#b8ab98');
  sky.addColorStop(0.62, '#4a3b2e'); // horizon: the dim far wall
  sky.addColorStop(1, '#1a120c'); // the bench underneath
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

const pmremGenerator = new THREE.PMREMGenerator(renderer);
const studioEnvironment = buildStudioEnvironment();
scene.environment = pmremGenerator.fromEquirectangular(studioEnvironment).texture;
studioEnvironment.dispose();
pmremGenerator.dispose();
scene.environmentIntensity = 1.1;

// A lost context now comes back at a cheaper tier rather than rebuilding
// the scene that lost it — see quality.ts.
// With one configuration there is no cheaper one to retry at, so a lost
// context is reported rather than chased through reloads — which is the
// better behaviour anyway: each reload spends another WebGL context, and
// the budget for those is shared across every open tab.
renderer.domElement.addEventListener(
  'webglcontextlost',
  (event) => {
    event.preventDefault();
    setStatus('WebGL が停止しました。他のタブを閉じて再読み込みしてください。');
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
scene.add(new THREE.AmbientLight(0xffe9c2, 0.42));

const keyLight = new THREE.DirectionalLight(0xfff1dc, 3.4);
// Raking, not frontal. This sat at (-3.2, 4.6, 4.2) with the camera at
// roughly (0, 3.9, 13), which put the light barely off the lens axis — and
// a light near the lens axis casts every shadow directly behind the thing
// casting it, where the camera cannot see it. Measured, the clouds were
// darkening under one percent of the frame. Swinging the key round to the
// side costs some fill on the right of the globe and buys shadows that
// land *across* the visible face, which is what makes the clouds read as
// floating above the surface rather than stuck to it.
keyLight.position.set(-5.0, 4.4, 3.2);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(SETTINGS.shadowMapSize, SETTINGS.shadowMapSize);
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
const fillLight = new THREE.DirectionalLight(0xcfe0f2, 0.62);
fillLight.position.set(3.5, -0.8, 2.5);
scene.add(fillLight);

// cool separation edge along the far side, so the globe doesn't merge
// into the dim background it's sitting against
const rimLight = new THREE.DirectionalLight(0x9fc8e8, 0.45);
rimLight.position.set(-4, 2, -3);
scene.add(rimLight);

// The bench lamp itself. Once the surroundings became real geometry they
// needed a real reason to be visible: the key is aimed at the subject with
// a shadow frustum wrapped tightly around it, so on its own it left the
// desk, the bottles and the foreground clutter sitting in near-black. A
// warm falloff light above the bench lights the room without touching the
// key-to-fill ratio the globe is lit by.
const benchLamp = new THREE.PointLight(0xffcf95, 280, 44, 2);
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

// Turned wood has no sharp arris on it: every edge is eased, and that
// eased edge is what catches a bright line under a lamp. A cylinder with a
// hard 90-degree rim gets one dark seam instead, which is a large part of
// why the pedestal read as a stacked primitive rather than as something
// made on a lathe. Each tier is built as a short chamfer, the body, and
// another chamfer.
function turnedTier(
  bottomRadius: number,
  topRadius: number,
  height: number,
  bevel = 0.035,
): THREE.CylinderGeometry[] {
  const body = new THREE.CylinderGeometry(topRadius, bottomRadius, height - bevel * 2, 48);
  const lowerChamfer = new THREE.CylinderGeometry(bottomRadius, bottomRadius - bevel, bevel, 48);
  lowerChamfer.translate(0, -(height - bevel) / 2, 0);
  const upperChamfer = new THREE.CylinderGeometry(topRadius - bevel, topRadius, bevel, 48);
  upperChamfer.translate(0, (height - bevel) / 2, 0);
  return [body, lowerChamfer, upperChamfer];
}

// The stand is fifteen small static parts across two materials, and each
// one was its own draw call. They never move relative to each other, so
// they are collected here and merged into one mesh per material at the end.
const standWood: THREE.BufferGeometry[] = [];
const standBrass: THREE.BufferGeometry[] = [];

function addTurnedTier(
  bottomRadius: number,
  topRadius: number,
  height: number,
  y: number,
): void {
  turnedTier(bottomRadius, topRadius, height).forEach((geometry) => {
    geometry.translate(0, y, 0);
    standWood.push(geometry);
  });
}

addTurnedTier(1.85, 1.65, 0.35, -1.9);
addTurnedTier(1.65, 1.3, 0.25, -1.65);

// small brass nameplate on the front of the pedestal
function buildPlaqueTexture(width = 512, height = 160): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, width, height);
  ctx.font = '600 56px "Hiragino Maru Gothic ProN", "Yu Gothic", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Engraved, not printed. A letter cut into brass has a shadow on the side
  // the light comes from and a bright burr on the far side; drawing the
  // glyph three times, offset, is enough to fake that at this size and is
  // the difference between a sticker and a machined plate.
  ctx.fillStyle = 'rgba(255, 236, 190, 0.5)';
  ctx.fillText('箱庭プラネット', width / 2, height / 2 + 4);
  ctx.fillStyle = 'rgba(28, 16, 4, 0.95)';
  ctx.fillText('箱庭プラネット', width / 2, height / 2 + 1);
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
standBrass.push(new THREE.BoxGeometry(1.15, 0.32, 0.03).translate(0, -1.86, 1.78));

const plaqueTextMaterial = new THREE.MeshBasicMaterial({
  map: buildPlaqueTexture(),
  transparent: true,
});
const plaqueText = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 0.29), plaqueTextMaterial);
plaqueText.position.set(0, -1.86, 1.797);
standGroup.add(plaqueText);

// The four screws holding the plate on. Tiny — a couple of pixels each at
// this framing — and exactly the sort of thing that separates a fitting
// from a decal: a real plate is fixed to the wood by something.
const screwGeometry = new THREE.CylinderGeometry(0.018, 0.018, 0.012, 10);
screwGeometry.rotateX(Math.PI / 2);
[
  [-0.5, -1.955],
  [0.5, -1.955],
  [-0.5, -1.765],
  [0.5, -1.765],
].forEach(([x, y]) => {
  standBrass.push(screwGeometry.clone().translate(x, y, 1.797));
});
screwGeometry.dispose();

// a thin brass trim ring right at the seam between the two wood tiers —
// the "museum trophy base" detail that reads as a real display stand
// rather than a plain stacked block of wood
standBrass.push(
  new THREE.CylinderGeometry(1.655, 1.655, 0.045, 48, 1, true).translate(0, -1.75, 0),
);

// The brass collar the sphere rests in. A pulsing glow ring used to sit
// here; a glowing ring belongs to a sci-fi prop, not to something
// photographed on a workbench next to a jar of paint.
// A ring of radius 1.2 at this height was not cradling anything: the
// sphere's bottom is only about 1.42 below its centre, so at that height
// the sphere is already down to a point and the ring was a wide disc
// around its tip. Sized to the sphere's actual horizontal radius where it
// meets the collar, and raised onto a turned wooden neck so the brass has
// something to sit on.
standWood.push(new THREE.CylinderGeometry(1.16, 1.2, 0.48, 44).translate(0, -1.29, 0));

// Sized to where the sphere actually is at the collar's height, so the
// brass meets the curve instead of ringing empty air below the south pole.
{
  const ring = new THREE.TorusGeometry(1.16, 0.065, 12, 56);
  ring.rotateX(Math.PI / 2);
  ring.translate(0, -1.05, 0);
  standBrass.push(ring);
}

// There is deliberately no meridian half-ring around the sphere. One used
// to arc from the collar up over the pole and back down, with an engraved
// scale along it, on the argument that a desk globe is not legible as a
// globe without one. In the frame this piece actually uses it did the
// opposite: sitting in the plane facing the camera it projects to a circle
// riding the silhouette, so the brass traces the limb all the way round and
// the planet reads as something mounted behind a hoop rather than as a
// sphere sitting on a workbench. The collar below is enough to say "this
// object is held" — the earth itself stays unencircled.

// two meshes for the whole pedestal, instead of one per turned part
[
  [standWood, baseMaterial],
  [standBrass, plaqueMaterial],
].forEach(([parts, material]) => {
  const list = parts as THREE.BufferGeometry[];
  if (list.length === 0) return;
  const mesh = new THREE.Mesh(mergeGeometries(list, false), material as THREE.Material);
  list.forEach((g) => g.dispose());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  standGroup.add(mesh);
});

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
  cameraPass.uniforms.uTime.value = t;
  cameraPass.uniforms.uFocusDistance.value = Math.max(
    camera.position.distanceTo(globeGroup.position) - RADIUS * 0.72,
    0.5,
  );

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

// Every subsequent terrain call (displaceSphere, buildTerrainTexture, the
// river/relief bakes) reads real-world elevation via heightAt, so the image
// backing it must already be decoded before any of them run.
await loadRealElevationData(`${import.meta.env.BASE_URL}world-elevation.png`);
// Where the deserts, the rainforests and the taiga actually are. Everything
// that reads aridity or canopy density needs this decoded before it runs,
// exactly as the elevation image does — see terrain.ts's Köppen section.
await loadClimateData(`${import.meta.env.BASE_URL}world-climate.png`);
await yieldToBrowser('地形データ');

const geometry = new THREE.SphereGeometry(RADIUS, SETTINGS.globeSegments[0], SETTINGS.globeSegments[1]);
displaceSphere(geometry, RADIUS, BUMP_HEIGHT);
await yieldToBrowser('地形');
const TEX_W = SETTINGS.textureWidth;
const TEX_H = TEX_W / 2;
await yieldToBrowser('地形');
const terrainTexture = buildTerrainTexture(TEX_W, TEX_H);
await yieldToBrowser('起伏');

const terrainBumpTexture = buildBumpTexture(TEX_W, TEX_H);
await yieldToBrowser('海');

// Season phase, shared by every material below whose live color needs to
// respond to it (this globe's own snow line, every vegetation material in
// species.ts) — one plain uniform object, updated once per frame in
// globeTick; every material references the *same* object, so that single
// update propagates to all of them without a per-material loop. A full
// year takes one minute.
const SEASON_SPEED = (Math.PI * 2) / 60;
const seasonUniforms = { uSeasonTilt: { value: 0 } };

// Which way the sun is.
//
// There was no notion of night in this scene at all: the key light is
// fixed, the globe turns under it, and the far side was simply the unlit
// half of a painted ball. Naming that direction gives every later system
// something to key off — the city lights below, the aircraft's navigation
// strobes, the ships' running lamps — and it costs one constant vec3,
// because the light does not move. The *globe* moving under it is what
// produces a day-night cycle (one turn takes about forty seconds, against
// the sixty-second year the seasons run on).
const sunDirection = keyLight.position.clone().normalize();
const dayNightUniforms = { uSunDir: { value: sunDirection } };

// Cloud shade, without a shadow map.
//
// Shadow mapping is off in this project and staying off — it was the
// isolated cause of a real-device crash (see renderer.shadowMap above).
// But nothing in the scene casting anything onto anything else is the
// loudest remaining "this is a render" cue: the sea is lit identically
// whether or not there is a cloud over it.
//
// The deck is baked to an equirectangular cover map once (clouds.ts), and
// the surfaces under it offset their lookup by the same closed-form drift
// the nodules themselves move under, so the shade tracks the cotton
// overhead for one texture fetch and no second pass. Declared here rather
// than beside the clouds because both materials compile before the sky is
// built; the objects are filled in after buildClouds.
const cloudShadowUniforms = {
  uCloudShadow: { value: null as THREE.Texture | null },
  uCloudTime: { value: 0 },
  uOmegaScale: { value: 1 },
};

/** GLSL shared by the globe and the ocean, so the shade cannot disagree. */
const CLOUD_SHADOW_GLSL = `
  float cloudShade(vec3 objNormal, float strength) {
    float lat = asin(clamp(objNormal.y, -1.0, 1.0));
    float v = lat / 3.14159265 + 0.5;
    // green is row-constant: this latitude's drift rate, encoded
    float omega = (texture2D(uCloudShadow, vec2(0.5, v)).g - 0.5) * uOmegaScale;
    float lon = atan(objNormal.z, -objNormal.x);
    // a nodule now at this longitude started at lon - omega*t
    float u = (lon - omega * uCloudTime) / 6.28318530718 + 0.5;
    float cover = texture2D(uCloudShadow, vec2(fract(u), v)).r;
    return 1.0 - cover * strength;
  }
`;

await yieldToBrowser('街の灯り');
const cityLightsTexture = buildCityLightsTexture(TEX_W, TEX_H);

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

// Automatic seasonal snow line: local winter (uSeasonTilt and this
// fragment's own latitude carrying opposite sign) pulls the snow line down
// toward the equator; local summer retreats it back toward the poles. Lives
// entirely in the fragment shader against the already-baked terrain texture
// — no re-bake, matching the "GPU-only, extra instructions on an existing
// pass" rule this project settled on after the plate-tectonics rebake scare.
// Gated to land only (vRadius vs. the ocean shell's own radius) so the
// glassy sea itself never gets dusted.
const globeSeaRadius = seaLevelRadius(RADIUS, BUMP_HEIGHT);
globeMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uSeasonTilt = seasonUniforms.uSeasonTilt;
  shader.uniforms.uSeaRadius = { value: globeSeaRadius };
  shader.uniforms.uSunDir = dayNightUniforms.uSunDir;
  shader.uniforms.uCityLights = { value: cityLightsTexture };
  shader.uniforms.uCloudShadow = cloudShadowUniforms.uCloudShadow;
  shader.uniforms.uCloudTime = cloudShadowUniforms.uCloudTime;
  shader.uniforms.uOmegaScale = cloudShadowUniforms.uOmegaScale;
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      '#include <common>\nvarying float vSeasonLat;\nvarying float vSeasonRadius;\nvarying vec3 vGlobeNormal;\nvarying vec3 vObjNormal;',
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vSeasonLat = normalize(position).y;
      vSeasonRadius = length(position);
      // the outward direction in world space, so the terminator follows the
      // globe as it turns under the fixed key light
      vGlobeNormal = mat3(modelMatrix) * normalize(position);
      // the *object*-space normal as well: the cloud deck is a child of the
      // globe, so its drift is described entirely in this frame
      vObjNormal = normalize(position);`,
    );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      '#include <common>\nuniform float uSeasonTilt;\nuniform float uSeaRadius;\nuniform vec3 uSunDir;\nuniform sampler2D uCityLights;\nuniform sampler2D uCloudShadow;\nuniform float uCloudTime;\nuniform float uOmegaScale;\nvarying float vSeasonLat;\nvarying float vSeasonRadius;\nvarying vec3 vGlobeNormal;\nvarying vec3 vObjNormal;' + CLOUD_SHADOW_GLSL,
    )
    // City lights, on the night side only. Added to the emissive term
    // rather than to the diffuse colour: they have to survive being on the
    // face no light reaches, which is the entire point of them.
    .replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      {
        float sun = dot(normalize(vGlobeNormal), uSunDir);
        // a soft terminator — a hard one reads as a stencil laid over the
        // globe rather than as the edge of the daylight
        float night = smoothstep(0.16, -0.12, sun);
        totalEmissiveRadiance += texture2D(uCityLights, vMapUv).rgb * night * 2.4;

        // Dusk. Until now the only thing that happened at the terminator was
        // the city lights fading up out of nothing; the daylight itself just
        // ran out. On a real lit object the line carries two bands: a warm
        // one on the daylight side, where the light is grazing and reddened,
        // and a cold desaturated one just past it — the blue hour, ground
        // lit by sky rather than by sun. Both are windows on the same dot
        // product, feathered on both edges for the same reason the night
        // term above is: a hard edge reads as a stencil laid over the ball.
        // Added to emissive and multiplied by the surface's own colour, so
        // it tints the paint that is there instead of painting over it.
        // The strength and the width are both load-bearing, and the first
        // pass got both wrong in the same way. Multiplying purely by
        // diffuseColor makes the band proportional to albedo, so it showed
        // up on bright land and vanished on exactly the surface that most
        // needed it — the dark ocean, which is what the terminator crosses
        // for most of its length. And a window 0.08 wide in the dot product
        // is about four degrees of arc, roughly twenty pixels at this
        // framing, which tone mapping at exposure 1.9 then flattened away.
        // Measured on a hard zoom into the terminator: no visible band at
        // all. Widened, strengthened, and given a floor so the tint still
        // lands on dark water while still being the surface's own colour
        // that gets tinted.
        float warmBand = smoothstep(0.42, 0.06, sun) * smoothstep(-0.16, 0.04, sun);
        float coolBand = smoothstep(0.06, -0.12, sun) * smoothstep(-0.46, -0.22, sun);
        totalEmissiveRadiance +=
          mix(vec3(0.34), diffuseColor.rgb, 0.62) * vec3(1.0, 0.44, 0.14) * warmBand * 1.45;
        totalEmissiveRadiance +=
          mix(vec3(0.28), diffuseColor.rgb, 0.5) * vec3(0.26, 0.44, 0.95) * coolBand * 0.95;
      }`,
    )
    .replace(
      '#include <map_fragment>',
      `#include <map_fragment>
      {
        float landMask = smoothstep(uSeaRadius - 0.01, uSeaRadius + 0.01, vSeasonRadius);
        float seasonalFactor = uSeasonTilt * vSeasonLat;
        float winterAmount = clamp(-seasonalFactor, 0.0, 1.0);
        float snowLine = mix(0.82, 0.5, winterAmount);
        float seasonalSnow = smoothstep(snowLine, snowLine + 0.14, abs(vSeasonLat)) * winterAmount * landMask;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.799, 0.855, 0.888), seasonalSnow * 0.8);
      }
      // Cloud shade. Applied to the albedo rather than to the light so it
      // costs nothing extra and darkens the ground the way an overcast
      // does — the land keeps its own colour, it just receives less.
      diffuseColor.rgb *= cloudShade(vObjNormal, 0.38);`,
    );
};

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
  SETTINGS.oceanSegments[0],
  SETTINGS.oceanSegments[1],
);
rippleSphere(oceanGeometry, seaLevelRadius(RADIUS, BUMP_HEIGHT), 0.004);
// a thin raised lip hugging the actual coastline, like poured resin (or
// real water) climbing slightly against the land instead of meeting it
// as a flat sheet. Trimmed from 0.006 once real low-lying coastal plains
// showed the old reach was eating into the (already thin) clearance real
// lowland terrain has above the ocean shell — see terrain.ts's coastalStep.
applyCoastalMeniscus(oceanGeometry, 0.004);
const oceanTexture = buildOceanTexture(TEX_W, TEX_H);
await yieldToBrowser('水面');
const waveTexture = buildWaveTexture();
await yieldToBrowser('植生');

// Real vertex motion, on top of the scrolled bump map above. A moving
// bump texture alone makes the *highlights* shimmer, but the surface
// itself never actually moves — up close, or in a still frame, that
// reads as a photograph of water rather than water. This adds one small
// sinusoidal offset along each vertex's own outward direction (the
// sphere's radius direction, doubling as its normal), cheap enough that
// it costs nothing extra to switch on: no new render target, no new
// draw call, just a few more instructions in a vertex shader this mesh
// already runs. Kept deliberately subtle — the ocean mesh here is
// already low-poly (SETTINGS.oceanSegments), so a strong displacement
// would facet visibly instead of reading as a swell.
let oceanWaveUniforms: { uTime: { value: number } } | null = null;
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
oceanMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uTime = { value: 0 };
  shader.uniforms.uSunDir = dayNightUniforms.uSunDir;
  shader.uniforms.uCloudShadow = cloudShadowUniforms.uCloudShadow;
  shader.uniforms.uCloudTime = cloudShadowUniforms.uCloudTime;
  shader.uniforms.uOmegaScale = cloudShadowUniforms.uOmegaScale;
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      '#include <common>\nuniform float uTime;\nvarying vec3 vOceanNormal;\nvarying vec3 vObjNormal;',
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      // object-space position on this sphere already points outward from
      // its center, so it doubles as the per-vertex swell direction —
      // two overlapping frequencies so it doesn't read as one uniform
      // pulse breathing in and out
      vec3 swellDir = normalize(position);
      float swell = sin(position.x * 14.0 + position.z * 9.0 + uTime * 1.3) * 0.0011
                  + sin(position.x * 6.0 - position.z * 8.0 - uTime * 0.8) * 0.0008;
      transformed += swellDir * swell;
      // same world-space outward direction the globe material carries, for
      // the same reason: the terminator has to travel with the sphere as it
      // turns under the fixed key light
      vOceanNormal = mat3(modelMatrix) * swellDir;
      // and the object-space one, which is the frame the cloud deck drifts in
      vObjNormal = swellDir;`,
    );
  // The night half of the sea was pure black — a glossy poured-resin surface
  // that simply stops existing wherever the sun does not reach it, which is
  // half the sphere. Real water is never the darkest thing in a night scene:
  // it is the one thing still catching a highlight. This is a dim cool lobe
  // centred on the antisolar point (read as the moon roughly opposite the
  // sun) plus the same two dusk bands the globe material paints, so the sea
  // does not jump from dusk-tinted to void across the terminator.
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      '#include <common>\nuniform vec3 uSunDir;\nvarying vec3 vOceanNormal;\nuniform sampler2D uCloudShadow;\nuniform float uCloudTime;\nuniform float uOmegaScale;\nvarying vec3 vObjNormal;' +
        CLOUD_SHADOW_GLSL,
    )
    .replace(
      '#include <map_fragment>',
      `#include <map_fragment>
      // The sea takes the shade harder than the land does. Open water has
      // almost no texture of its own to carry the eye, so cloud shadows
      // crossing it end up being most of what says the sea is a surface
      // under a sky rather than a painted blue field — which is where the
      // absence of shadows was doing the most damage.
      diffuseColor.rgb *= cloudShade(vObjNormal, 0.62);`,
    )
    .replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      {
        vec3 oceanN = normalize(vOceanNormal);
        float sun = dot(oceanN, uSunDir);
        float night = smoothstep(0.10, -0.16, sun);
        // broad, then a tighter core: a wide sheen over the whole night sea
        // with a brighter patch where the moon would stand overhead
        float moon = max(-sun, 0.0);
        float sheen = moon * 0.10 + pow(moon, 6.0) * 0.16;
        totalEmissiveRadiance += vec3(0.34, 0.46, 0.72) * sheen * night;

        // Same two bands as the globe material, at the same widths, so the
        // sea does not leave dusk at a different moment than the coast it
        // touches. The warm one is deliberately much weaker here than on
        // land, and that is not timidity: orange light added to dark blue
        // water does not read as sunset, it reads as dirt. Measured at the
        // land strength the whole ocean side of the terminator went a muddy
        // brown-mauve. On water the cool band carries the moment instead,
        // which is also what water actually does — it holds the sky's blue
        // long after the land beside it has gone dark.
        float warmBand = smoothstep(0.42, 0.06, sun) * smoothstep(-0.16, 0.04, sun);
        float coolBand = smoothstep(0.06, -0.12, sun) * smoothstep(-0.46, -0.22, sun);
        totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.5, 0.2) * warmBand * 0.5;
        totalEmissiveRadiance +=
          mix(vec3(0.26), diffuseColor.rgb, 0.5) * vec3(0.26, 0.46, 0.98) * coolBand * 0.85;
      }`,
    );
  oceanWaveUniforms = shader.uniforms as unknown as { uTime: { value: number } };
};
const oceanMesh = new THREE.Mesh(oceanGeometry, oceanMaterial);
// receives only — a translucent resin sheet casting a hard opaque shadow
// onto the seabed it covers would read as a lid, not as water
oceanMesh.receiveShadow = true;
globeGroup.add(oceanMesh);

// Ground cover and scattered miniature objects — discrete things standing
// on the terrain are what actually reads as "diorama", not just a smooth
// colored/shiny surface. One scatter walks the sphere once and classifies
// every candidate into whatever belongs there — forest, grass, savanna
// trees, mountain rocks, scree, or one of fourteen further species — so
// adding a kind costs a branch, not another sweep. See species.ts.
await yieldToBrowser('生物相');
const species = buildSpecies(RADIUS, BUMP_HEIGHT, seasonUniforms);
species.traverse((child) => {
  if ((child as THREE.Mesh).isMesh) {
    // Not casting: this group is ~27 InstancedMesh draw calls (grass,
    // scree, forest canopy, savanna trees, the fourteen species...), many
    // with tens of thousands of instances apiece, and every one of them
    // casting doubled the shadow pass's draw submissions on top of an
    // already real cost. A GPU process crash on a real device traced back
    // to exactly this — a tile-based mobile renderer paying for a full
    // depth pass over every blade of grass on the planet is a lot to ask
    // for a shadow contribution nobody would notice missing at this
    // scale. Still receiving, so the ground cover reads the terrain's own
    // shadows (cloud shade, mountains shading valleys) correctly.
    child.receiveShadow = true;
  }
});
globeGroup.add(species);

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
// The globe's and the sea's shaders were compiled before the sky existed,
// so they hold the uniform objects and get the contents now.
cloudShadowUniforms.uCloudShadow.value = clouds.shadowTexture;
cloudShadowUniforms.uOmegaScale.value = clouds.omegaScale;
// (castShadow is decided per layer inside buildClouds: the opaque core
// casts, the translucent fringe does not.)
globeGroup.add(clouds.group);

// Snow that actually falls, over whichever hemisphere is currently in
// winter — the painted snow line was the result, this is the event. All of
// its motion lives in a vertex shader; see snowfall.ts.
await yieldToBrowser('降雪');
const snowfall = buildSnowfall(RADIUS, seasonUniforms, renderer.getPixelRatio());
globeGroup.add(snowfall.points);

// The four volcanoes stop being scenery and start being events.
await yieldToBrowser('火山');
const eruptions = buildEruptions(
  RADIUS,
  BUMP_HEIGHT,
  renderer.getPixelRatio(),
  dayNightUniforms.uSunDir.value,
  // the same profile the clouds ride, so ash and sky agree about the wind
  zonalWind,
);
globeGroup.add(eruptions.group);

// Famous buildings at their real coordinates, absurdly out of scale, which
// is exactly what a souvenir globe does.
await yieldToBrowser('名所');
globeGroup.add(buildLandmarks(RADIUS, BUMP_HEIGHT));

// Traffic: shipping on the sea and airliners over it, both parented to the
// globe because both travel *with* the planet.
await yieldToBrowser('航路');
const ships = buildShips(RADIUS, BUMP_HEIGHT);
globeGroup.add(ships.group);
const aircraft = buildAircraft(RADIUS);
globeGroup.add(aircraft.group);

// Satellites, pointedly *not* parented to the globe: an orbit that turned
// with the planet under it would be a geostationary ring. They hang off a
// group that shares the globe's seat and axial tilt but none of its spin.
const orbitGroup = new THREE.Group();
orbitGroup.position.copy(globeGroup.position);
orbitGroup.rotation.z = 0.04; // the same tilt the globe sits at
scene.add(orbitGroup);
const satellites = buildSatellites(RADIUS);
orbitGroup.add(satellites.group);

// ---------- stand: real wood pedestal + nameplate, globe hovers just
// slightly above it (a hint of "magnetic levitation" kept, but the wood
// itself — not a glowing ring — is now the dominant, grounded object) ----------

// ---------- resize ----------

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  sceneDepth.image.width = window.innerWidth;
  sceneDepth.image.height = window.innerHeight;
  sceneDepth.needsUpdate = true;
  cameraPass.uniforms.uResolution.value.set(window.innerWidth, window.innerHeight);

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
  if (oceanWaveUniforms) oceanWaveUniforms.uTime.value = t;

  // Weather drifts independently of the ground under it — each weather
  // band has its own latitude-appropriate wind speed/direction and slow
  // breathing scale, recomputed from elapsed time (not accumulated += each
  // frame, so it stays exactly reproducible regardless of frame rate, the
  // same way the wave offset above does it). `clouds.group` is a child of
  // globeGroup, so all of this is on top of, and slower than, the globe's
  // own spin — weather visibly creeping across a much faster-spinning toy
  // planet reads as wrong, the way a lit ceiling fan looks wrong under a
  // strobe. See clouds.ts for why this is a live per-band update instead of
  // one rigid rotation.
  clouds.tick(t);
  snowfall.tick(t);
  eruptions.tick(t);
  ships.tick(t);
  aircraft.tick(t);
  satellites.tick(t);

  // +1 = northern hemisphere summer, -1 = northern hemisphere winter (and
  // the reverse south of the equator, handled by multiplying against each
  // fragment/instance's own latitude sign in the shaders above) — every
  // material sharing this one object picks the new value up next frame.
  seasonUniforms.uSeasonTilt.value = Math.sin(t * SEASON_SPEED);
};

document.querySelector<HTMLDivElement>('#loading')?.remove();
