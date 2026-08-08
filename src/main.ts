import './style.css';
import * as THREE from 'three';
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
  sampledHeight,
  seaLevelRadius,
} from './terrain';
import { buildSpecies } from './species';
import { buildClouds, CLOUD_SHADOW_GLSL, zonalWind } from './clouds';
import { buildAurora } from './aurora';
import { buildFog } from './fog';
import { buildSnowfall } from './snowfall';
import { buildEruptions } from './eruptions';
import { buildLandmarks } from './landmarks';
import { buildIcebergs } from './icebergs';
import { buildAircraft, buildSatellites, buildShips } from './traffic';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CameraPassShader } from './cameraPass';
import {
  AXIAL_TILT,
  buildWorkshop,
  GLOBE_CENTRE_Y,
  GLOBE_RADIUS,
  KEY_LIGHT_POSITION,
} from './setDressing';


document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div class="cyber-panel" id="cyber-panel">
    <div class="panel-corner panel-corner--tl"></div>
    <div class="panel-corner panel-corner--tr"></div>
    <div class="panel-header">
      <div class="title"><span class="title-glyph"></span>天青の晶玉</div>
      <button id="story-button" class="story-button" title="ストーリーを見る" aria-label="ストーリーを見る">STORY</button>
    </div>

    <div class="panel-controls">
      <div class="dial-cluster">
        <div class="dial-label">E - W</div>
        <div class="yaw-dial" id="yaw-dial" role="slider" aria-label="東西に回転" tabindex="0">
          <div class="yaw-dial-ring"></div>
          <div class="yaw-dial-tick" id="yaw-dial-tick"></div>
          <div class="yaw-dial-core"></div>
        </div>
      </div>
      <div class="dial-cluster">
        <div class="dial-label">N - S</div>
        <div class="pitch-dial" id="pitch-dial" role="slider" aria-label="南北に回転" tabindex="0">
          <div class="pitch-dial-ring"></div>
          <div class="pitch-dial-tick" id="pitch-dial-tick"></div>
          <div class="pitch-dial-core"></div>
        </div>
      </div>
      <button id="flag-button" class="cyber-button cyber-button--small" title="中心に旗を立てる" aria-label="中心に旗を立てる">
        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M5 3v18M5 4h13l-3 4 3 4H5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>
      </button>
      <button id="spin-toggle" class="cyber-button cyber-button--small" title="自転を止める" aria-label="自転を止める">
        <svg viewBox="0 0 24 24" width="16" height="16" id="spin-toggle-icon"><path d="M6 4h4v16H6zM14 4h4v16h-4z" fill="currentColor"/></svg>
      </button>
    </div>
  </div>

  <div class="loading-screen" id="loading-screen">
    <div class="loading-ring"></div>
    <div class="loading-title">天青の晶玉</div>
    <div class="loading" id="loading" role="status">組み立て中…</div>
  </div>

  <div class="flag-bubble" id="flag-bubble" hidden>
    <div class="flag-bubble-coord" id="flag-bubble-coord">N 00.0° E 000.0°</div>
    <div class="flag-bubble-tail"></div>
  </div>

  <div class="story-overlay" id="story-overlay" hidden>
    <div class="story-panel">
      <button id="story-close" class="story-close" aria-label="閉じる">✕</button>
      <div class="story-cover"></div>
      <h1 class="story-title">天青の晶玉（てんせいのしょうぎょく）</h1>
      <p class="story-lead">ハルカが手にした「天青の晶玉」。それは単なるアンティークのジオラマなどではなく、別次元に封印された未知の惑星へと繋がるポータルデバイスだった。</p>
      <section class="story-section">
        <h2>掌（てのひら）の上の星回り</h2>
        <p>ハルカがデバイスの球体を静かに回転させると、緑豊かな大陸や吹き荒れる局地的な嵐など、星の全容が立体的なホログラムとして浮かび上がる。彼女は掌の上で回る星を観察し、未知の領域へ降り立つための転送座標を慎重に割り出していく。</p>
      </section>
      <section class="story-section">
        <h2>未知へのダイブ</h2>
        <p>座標が定まり、ハルカがデバイスを起動する。まばゆい光とともに彼女自身がホログラムとして浮かび上がる「晶玉」の内部空間へと直接転送され、彼女の孤独で危険な探索の幕が上がる。</p>
      </section>
      <section class="story-section">
        <h2>現実となる箱庭</h2>
        <p>転送の果てにハルカを待っていたのは、デバイス上で緑が濃く光っていた原生林や、厚い雲に覆われていた未踏の荒野だった。先ほどまで掌の上で見ていた小さなジオラマの光景が、今は圧倒的なスケールを持つ現実の世界として、彼女の目の前に立ちはだかるのだった。</p>
      </section>
    </div>
  </div>
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
  oceanSegments: [176, 100] as const,
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

// Shared with setDressing.ts rather than restated here: the shadow the
// globe throws on the desk is a projection of *this* sphere under *that*
// lamp, and a second copy of either number is free to drift out of step.
const RADIUS = GLOBE_RADIUS;
const BUMP_HEIGHT = 0.36; // exaggerated on purpose — mountains were reading as flat/thin at 0.22
// The globe hangs on its axis, 3cm clear of the wood.
//
// It used to nest into a brass collar, and before that it hovered over the
// pedestal with a gap as a nod to magnetic levitation. The collar was the
// right correction to the levitation — a thing that floats unsupported is
// not a thing standing on a workbench — but it is not the only way to
// support something, and it is not how a globe is supported. A gap under a
// sphere reads as levitation when nothing crosses it and as an axle when a
// rod does. The rod crosses it now, so the sphere can come up off the wood
// without going back to floating: it is held at both poles, which is more
// visibly *held* than resting in a collar ever was.
const GLOBE_SEAT_Y = GLOBE_CENTRE_Y;

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
//
// 7.0 was still not far enough, and the arithmetic says so rather than the
// eye. At 7.0, a 40 degree lens and this polar angle, the bottom edge of
// the frame crossed the desk plane at z = -0.37 — *behind* the globe's own
// centre. Nothing in front of the sphere's own silhouette could be in the
// picture at all: not the pedestal it stands on (front face at z = 1.85),
// not one millimetre of the desk under it. The globe's lower limb landed
// within a twentieth of a degree of the frame's bottom edge, which is why
// the stand looked sliced off — it was not cropped by accident, there was
// no room for it by construction. A photograph of an object on a table
// shows the table; this one could not. 9.6 puts the bottom edge on the
// desk at z = 2.5, which is the pedestal's foot plus about two thirds of a
// base-radius of bare desk in front of it. The cost is the globe going
// from 84% to 63% of the frame height — still by a distance the largest
// thing in the picture, and the set dressing that was already built (the
// book piles, the plants) finally reads at a size where it can do its job.
//
// 10.2, from 9.6, because the subject grew a mount. The rule above is the
// one being applied again, not overridden: the frame has to hold the whole
// object, and the object is no longer just the sphere and the wood. The
// tallest brass is the north pin, 3.301 up, and at 9.6 it landed 19.15
// degrees off the axis against a 20 degree half-frame — 17px short of the
// top edge, close enough that the arc read as running off the picture.
// 10.2 puts it at 17.99 degrees, 40px clear, and it buys the bottom back
// at the same time: the desk at z = 2.5 goes from -20.02 (exactly on the
// edge, which is what 9.6 was chosen to do) to -18.71, so there is finally
// margin at both ends instead of none at either. The globe pays 6% of its
// diameter for that, 458px to 431px, and is still over half the frame.
const BASE_CAMERA_DISTANCE = 10.2;
// Portrait pulls back, but not by the full 1/aspect it used to.
//
// The old rule divided the distance by the aspect ratio outright, which
// frames the globe's *width* consistently and lets its height do whatever
// falls out. That was survivable while the landscape distance was 7; at
// 9.6 the same rule puts a phone at 17 units back, where the globe is a
// third of the frame height sitting above an enormous empty apron of desk.
// A fractional exponent keeps the pullback (the sphere still has to fit
// across a narrow frame) while stopping it from running away, and it is
// still exactly 1 at aspect 1, so there is no step at the orientation
// change. 0.6 lands a 9:16 phone at 13.5 units — the same apparent globe
// size that shipped before this change.
const PORTRAIT_PULLBACK_EXPONENT = 0.6;
function cameraDistanceForViewport() {
  const aspect = window.innerWidth / window.innerHeight;
  if (aspect >= 1) return BASE_CAMERA_DISTANCE;
  return BASE_CAMERA_DISTANCE * Math.pow(1 / Math.max(aspect, 0.45), PORTRAIT_PULLBACK_EXPONENT);
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
//
// Raised from 0.43pi (13° above the horizon) to 0.405pi. Not to make it
// look more like a miniature — the reason is that pulling the camera back
// to get the desk into the frame flattens the angle between the lens and
// the fixed key light, and that angle is what fixes the terminator's
// position on the disc. Measured: at the new distance and 0.43pi the
// terminator's centre moves from 0.578 of the disc radius to 0.53, because
// the direction from globe to camera swings toward the horizontal and away
// from the sun. Lifting the lens by four degrees puts it back at 0.567 —
// the same read documented in gap-analysis 2-12, a fixed line about
// three-fifths out on the anti-sun side that terrain crosses rather than a
// line that sweeps. Anything the eye notices about the daylight boundary
// stays where it was.
const CAMERA_POLAR_ANGLE = Math.PI * 0.405; // ~73° from vertical = ~17° above horizon
// The aim point, and it is *not* the globe's centre (0.6) any more.
//
// The frame has to hold the sphere, the pedestal below it and a strip of
// desk in front of the pedestal, and that whole subject has its mass above
// its base. Aiming at 0.15 — a little below the sphere's own centre —
// leaves the globe sitting slightly high in the frame with the stand and
// the desk filling the lower quarter, which is where a photographer of an
// object on a table would put it. Aiming at the sphere's centre instead
// costs about a degree and a half of headroom for nothing: the space is
// needed at the bottom, not the top.
const TARGET_Y = 0.15;
// On a phone-aspect screen the cyber-panel (bottom, scale(2)'d, and taller
// again now that it carries its own header row) eats a real fraction of
// the viewport height. Camera position and look-at target move together
// in cameraStartPosition/lookAt below, which keeps the viewing *angle*
// fixed but translates the whole rig vertically — moving both down by the
// same amount pushes the globe (whose own world position does not move)
// up in the frame, exactly the headroom the taller panel needs. Left at 0
// for landscape/desktop, where the panel is a much smaller fraction of
// the screen and this globe already had headroom to spare.
const PORTRAIT_TARGET_Y_LIFT = 0.4;
function targetYForViewport() {
  const aspect = window.innerWidth / window.innerHeight;
  return aspect >= 1 ? TARGET_Y : TARGET_Y - PORTRAIT_TARGET_Y_LIFT;
}
function cameraStartPosition() {
  const dist = cameraDistanceForViewport();
  const targetY = targetYForViewport();
  return new THREE.Vector3(0, targetY + dist * Math.cos(CAMERA_POLAR_ANGLE), dist * Math.sin(CAMERA_POLAR_ANGLE));
}
const startPos = cameraStartPosition();
camera.position.set(startPos.x, startPos.y, startPos.z);
camera.lookAt(0, targetYForViewport(), 0);

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

  // A cyan band low on the horizon, on request — "make things richer via
  // lighting/reflection, not by touching individual materials." The
  // saucer's own glow ring is right at the bench line this environment
  // already darkens toward, so every clearcoat/metal surface in the scene
  // (the ocean above all — see its own note on why a discrete shape here
  // was rejected once already) now picks up a faint cyan kiss at its
  // lower reflections without a single material needing to change. Kept
  // to a soft band, not a hard shape, for the same reason the original
  // gradient is one broad wash rather than distinct light panels: a sharp
  // reflected shape reads as "there is a visible object out there,"
  // which is exactly what this environment has always been built to
  // avoid.
  const cyan = ctx.createLinearGradient(0, height * 0.58, 0, height * 0.86);
  cyan.addColorStop(0, 'rgba(57, 200, 255, 0)');
  cyan.addColorStop(0.5, 'rgba(57, 200, 255, 0.22)');
  cyan.addColorStop(1, 'rgba(57, 200, 255, 0)');
  ctx.fillStyle = cyan;
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
// Raised (1.1 -> 1.4) on request, as the "richer via lighting/reflection,
// not by touching individual materials" lever — this is a single global
// multiplier every clearcoat/metal surface in the scene already reads
// (ocean, saucer base, plaque, ring), so turning it up lifts all of their
// reflections together without any per-material change.
scene.environmentIntensity = 1.4;

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

// ---------- controls ----------
//
// Pinch-zoom and drag-to-orbit are gone, on request — replaced by the
// cyber control panel below, which turns the globe itself (two rotation
// dials) rather than moving the camera around it. The camera is now
// fully static except for the same viewport-responsive repositioning it
// always had on resize (see the resize handler).

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
// Cut again, from 0.42, alongside fill and rim below. The day/night
// terminator has no floor of its own — the terrain paint is the same
// colour whether the sun is on it or not (see globeMaterial's
// onBeforeCompile: night only *adds* the city-lights emissive, it never
// darkens the diffuse) — so how dark the far side of the globe actually
// reads depends entirely on these three lights.
//
// Checked by replicating three's own Lambertian-irradiance + ACES-filmic
// pipeline for a flat grey sphere rather than trusting a screenshot: with
// the old values (ambient 0.42 / fill 0.62 / rim 0.45) a point on the far
// side, lit by none of the key, came out at 117/255 — a dim overcast
// afternoon, not a shaded side of anything. Halving all three (to 0.16 /
// 0.28 / 0.30) drops that same point to 58/255, while the front, dominated
// by the key at 3.4, is barely touched by the same cut: 230 -> 226.
//
// Still read as too bright to be night rather than an overcast afternoon —
// 58/255 is a lit grey, not a dark one, and it is the floor every other
// object in the scene (the clouds, the workshop) is lit by too, not just
// the globe. Cut again, more gently this time (ambient and fill only —
// rim's job is the far *silhouette* against the backdrop, not the sphere's
// own dark side, and was already kept closer to its old value for that
// reason the first time). The globe's own further drop below is the bigger
// piece of the actual fix; this keeps the clouds and the rest of the desk
// consistent with it instead of them alone staying at the old floor.
scene.add(new THREE.AmbientLight(0xffe9c2, 0.1));

const keyLight = new THREE.DirectionalLight(0xfff1dc, 3.4);
// Raking, not frontal. This sat at (-3.2, 4.6, 4.2) with the camera at
// roughly (0, 3.9, 13), which put the light barely off the lens axis — and
// a light near the lens axis casts every shadow directly behind the thing
// casting it, where the camera cannot see it. Measured, the clouds were
// darkening under one percent of the frame. Swinging the key round to the
// side costs some fill on the right of the globe and buys shadows that
// land *across* the visible face, which is what makes the clouds read as
// floating above the surface rather than stuck to it.
keyLight.position.copy(KEY_LIGHT_POSITION);
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
// side readable, nowhere near enough to compete with the key. Cut from
// 0.62 alongside the ambient above — see the note there for the
// before/after numbers this pair was checked against.
//
// X mirrored alongside the key's move to the front-right: a bounce card
// fills in the key's *own* shadow side, so it has to stay on the opposite
// side of the key rather than at a fixed world position — otherwise, once
// the key moved, this would have started adding light to the day side
// while leaving the actual night side exactly as unfilled as before.
const fillLight = new THREE.DirectionalLight(0xcfe0f2, 0.19);
fillLight.position.set(-3.5, -0.8, 2.5);
scene.add(fillLight);

// cool separation edge along the far side, so the globe doesn't merge
// into the dim background it's sitting against. Kept closer to its old
// value than the fill and the ambient were: its job is the silhouette
// against the background, not filling in the sphere's own dark side, and
// cutting it as hard as the other two let the globe's far limb melt into
// the room behind it.
// Bumped from 0.30 per an explicit ask for a stronger silhouette edge —
// this is the scene light half of that (a real light, catching the
// physical set-dressing too), paired with the shader-side rimFresnel
// terms on the globe/ocean materials being pushed up the same way.
const rimLight = new THREE.DirectionalLight(0x9fc8e8, 0.48);
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
// This group's rotation carries the day spin (y, inner) and the user's own
// north-south dial (x, outer) — the axial tilt (z) that used to live here
// is permanently 0 now that the rod through the poles is gone (see the
// cyber-panel commit). Which of x/y is "inner" vs "outer" in the Euler
// composition is not a style choice, the same way it was not one when this
// used to be about a rod tracking the pole: whichever term is *outer* is a
// rotation around a truly fixed world axis regardless of what the inner
// term does, and whichever is *inner* gets carried around by the outer
// term instead.
//
// Y (day spin + the east-west dial) is inner, X (the north-south dial) is
// outer, which is 'XYZ' — the opposite of the 'ZYX' this group used to
// carry back when Z (the axial tilt) needed to be the inner term so the
// rod's fixed mount could track a pole that only ever wandered a couple of
// degrees. Getting this backwards ('ZYX', X inner/Y outer, which is what a
// first pass at the two dials shipped with) is a real bug, not a cosmetic
// one: with pitch on the *inner* term, pitching the globe bakes the tilt
// into the body, and then any further yaw — including the day spin running
// in the background — carries that tilt around with it, so a pole tipped
// toward the viewer visibly sweeps into a circle as the planet keeps
// turning instead of staying tipped toward the viewer the way "回して視点
// 正面側で" (spin it, but always relative to the front of the viewpoint)
// asks for. With pitch outer, the identity `Ry(yaw)` leaves the poles (on
// the Y axis) untouched, and `Rx(pitch)` alone decides where they point,
// so the north-south dial's effect never depends on how much yaw — dial or
// day spin — has accumulated.
globeGroup.rotation.order = 'XYZ';
scene.add(globeGroup);

// A soft halo behind the globe, on request ("新海誠的な" -- the globe
// reads as a lit object sitting *in front of* a dark room rather than as
// something that itself glows the way a planet actually would against
// open space). A plain radial-gradient canvas sprite rather than any kind
// of light or geometry: sprites always face the camera for free, need no
// extra draw setup, and — crucially — sit *behind* the globe in the
// depth buffer without a single line of depth-sorting logic, because it
// is placed a little further from the camera than the globe itself and
// additive blending means anything the opaque globe occludes simply never
// contributes. A child of the scene, not globeGroup, since a glow behind
// a spinning object should not itself spin.
function buildGlowDisc(): THREE.Sprite {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(120, 190, 255, 0.55)');
  gradient.addColorStop(0.4, 'rgba(80, 150, 220, 0.28)');
  gradient.addColorStop(1, 'rgba(40, 90, 160, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.setScalar(RADIUS * 5.5);
  sprite.position.set(0, GLOBE_SEAT_Y, -RADIUS * 1.4);
  return sprite;
}
scene.add(buildGlowDisc());

// terrain color is painted once onto a texture (crisp, cheap to sample)
// instead of interpolated per-vertex (which read as blurry) — geometry
// only needs to be smooth enough to carry the displacement + lighting
const standGroup = new THREE.Group();
scene.add(standGroup);

// A maglev-style "cyber" saucer, on request, replacing the turned-wood
// museum pedestal. Faint brushed striping rather than flat black — a bare
// flat colour under one warm key light reads as a silhouette with no
// material at all, the same lesson the wood grain existed to teach, just
// aimed at a dark gadget shell instead of a light one.
function buildSaucerTexture(width = 512, height = 512): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const base = ctx.createLinearGradient(0, 0, width, 0);
  base.addColorStop(0, '#0c0f14');
  base.addColorStop(0.5, '#171c24');
  base.addColorStop(1, '#0c0f14');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, width, height);

  // fine brushed-metal streaking, vertical (around the cylinder), rather
  // than the wood texture's long wandering fibres
  for (let i = 0; i < 140; i++) {
    const x = Math.random() * width;
    ctx.strokeStyle = `rgba(120, 150, 180, ${0.03 + Math.random() * 0.06})`;
    ctx.lineWidth = 1 + Math.random();
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + (Math.random() - 0.5) * 8, height);
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
  map: buildSaucerTexture(),
  color: 0x2a323d,
  roughness: 0.32,
  metalness: 0.55,
  clearcoat: 0.7,
  clearcoatRoughness: 0.18,
  envMapIntensity: 0.5,
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

// Same footprint and same tier heights as the wood pedestal this replaced
// (§2-18's camera framing was measured against exactly this profile, right
// down to the 0.385-unit gap to the globe's south pole) — only the taper on
// the upper tier is gentler, which is what turns a turned "neck" into a
// flat saucer lid.
addTurnedTier(1.85, 1.65, 0.35, -1.9);
addTurnedTier(1.65, 1.45, 0.25, -1.65);

// small nameplate on the front of the saucer
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
  ctx.fillText('天青の晶玉', width / 2, height / 2 + 4);
  ctx.fillStyle = 'rgba(28, 16, 4, 0.95)';
  ctx.fillText('天青の晶玉', width / 2, height / 2 + 1);
  const texture = new THREE.CanvasTexture(canvas);
  return texture;
}

// Brushed chrome rather than brass, to go with the saucer: a modern
// console reads its badge in cool metal, not warm engraved trophy-plate
// metal. Metalness held down a little short of 1, same reason the old
// plaque did — pure metal in this dim a room renders as near-black, and
// some diffuse response is what keeps the plate legible at all.
const plaqueMaterial = new THREE.MeshStandardMaterial({
  color: 0xc4ccd6,
  metalness: 0.75,
  roughness: 0.24,
  envMapIntensity: 1.4,
});
standBrass.push(new THREE.BoxGeometry(1.15, 0.32, 0.03).translate(0, -1.86, 1.78));

const plaqueTextMaterial = new THREE.MeshBasicMaterial({
  map: buildPlaqueTexture(),
  transparent: true,
});
const plaqueText = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 0.29), plaqueTextMaterial);
plaqueText.position.set(0, -1.86, 1.797);
standGroup.add(plaqueText);

// ---------------------------------------------------------------------
// The glow ring: this saucer's one deliberately non-physical light source
// ---------------------------------------------------------------------
// Sitting right at the seam between the two tiers, where the brass trim
// ring used to be — same reasoning, different century: a plain stacked
// block of dark plastic needs *something* marking the joint or it reads as
// two separate cylinders shoved together, and here that something is the
// maglev base's own light instead of a metal trim.
//
// Two meshes, not one. The bright core is what a strip of LEDs actually
// is: a saturated, nearly self-coloured band. But this scene has no bloom
// pass (shadowMap and any heavier post-processing stayed off after the
// mobile-crash scare — see the shadowMap note elsewhere in this file), so
// a light source with a hard-edged falloff and nothing else reads as a
// painted stripe, not a glow. A second, larger, much dimmer additive ring
// just outside it fakes the bloom a real emitter would throw on the metal
// around it — cheap (one more merged draw call, no render target) and it
// is the difference between "a cyan line" and "a light".
const RING_Y = -1.75;
const RING_RADIUS = 1.655;
const glowCore = new THREE.Mesh(
  new THREE.TorusGeometry(RING_RADIUS, 0.028, 12, 96),
  new THREE.MeshBasicMaterial({ color: 0x5be4ff }),
);
glowCore.rotation.x = Math.PI / 2;
glowCore.position.y = RING_Y;
standGroup.add(glowCore);

const glowHalo = new THREE.Mesh(
  new THREE.TorusGeometry(RING_RADIUS, 0.1, 12, 96),
  new THREE.MeshBasicMaterial({
    color: 0x39c8ff,
    transparent: true,
    opacity: 0.35,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }),
);
glowHalo.rotation.x = Math.PI / 2;
glowHalo.position.y = RING_Y;
standGroup.add(glowHalo);

// A faint upward wash on the underside of the globe and the saucer's own
// top face — a real maglev unit's ring lights the air and the object
// hovering in it, not just itself. One more additive disc, flush with the
// lid, costs nothing extra to justify (no shadow, no physical light) since
// it is standing in for bounce light this scene's single dim key does not
// actually compute.
const glowWash = new THREE.Mesh(
  new THREE.CircleGeometry(1.5, 48),
  new THREE.MeshBasicMaterial({
    color: 0x2fb8ff,
    transparent: true,
    opacity: 0.06,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  }),
);
glowWash.rotation.x = -Math.PI / 2;
glowWash.position.y = -1.635;
standGroup.add(glowWash);

// A small emissive status dot, dead centre of the lid — the one glowing
// "power on" detail every product shot like the reference has.
const glowDot = new THREE.Mesh(
  new THREE.CircleGeometry(0.05, 24),
  new THREE.MeshBasicMaterial({ color: 0x8fefff }),
);
glowDot.rotation.x = -Math.PI / 2;
glowDot.position.y = -1.634;
standGroup.add(glowDot);

// ---------------------------------------------------------------------
// No mount. On request: no rod through the poles, no meridian arc — the
// globe floats over the saucer with nothing visibly holding it up at all,
// which is the whole point of a maglev display and the reason the axial
// tilt above went to 0 as well (a rod gave the tilt something to be read
// against; without one a lean just looks like the globe sitting crooked).
// The 0.385-unit gap to the saucer's lid (same number the old rod's
// GLOBE_CENTRE_Y produced, see setDressing.ts) now reads as levitation
// instead of an axle, with the glow ring built above doing the work of
// explaining *why* it floats.
// ---------------------------------------------------------------------

// two meshes for the whole stand, instead of one per turned part
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

// ---------- cyber control panel: spin toggle, rotation dials, flag ----------
//
// Pinch-zoom and drag-to-orbit are gone (see the controls note above);
// these four controls are the entire interaction surface now, and all of
// them turn the *globe*, not the camera — the camera stays exactly where
// cameraStartPosition() put it.

let spinning = true;
const spinToggle = document.querySelector<HTMLButtonElement>('#spin-toggle')!;
spinToggle.addEventListener('click', () => {
  spinning = !spinning;
  spinToggle.classList.toggle('is-off', !spinning);
  const label = spinning ? '自転を止める' : '自転を再開する';
  spinToggle.title = label;
  spinToggle.setAttribute('aria-label', label);
});

// The day spin and the user's own east-west turn are two separate
// accumulators added together each frame, rather than the dial writing
// straight into globeGroup.rotation.y — that would make "spin off, drag
// the dial" and "spin on" fight over the same number every frame. Keeping
// them apart means turning the dial while the planet is still spinning
// simply offsets where in its day the globe currently reads, and toggling
// spin off leaves the dial's own offset exactly where the user left it.
let autoSpinY = 0;
let userYaw = 0;
// Both dials turn freely now, on request — no more pitch clamp keeping
// the view above the pole. Spinning either one all the way around no
// longer maps 1:1 onto the globe either: three full turns of the dial is
// one full turn of the planet, so a small, precise flick of the knob
// still reads as a small, precise nudge instead of the globe snapping
// past whole continents per turn.
const DIAL_GEAR_RATIO = 3;
let userPitch = 0;

// A single helper drives both dials: each is a round knob, dragged in a
// circle, reading only the *change* in angle between pointer-move events
// (not the pointer's absolute angle) so grabbing the rim anywhere and
// turning it feels like a real knob rather than snapping to point at
// wherever the cursor first landed. The knob's own on-screen tick spins
// 1:1 with the finger; the value it drives (yaw or pitch) only advances
// at 1/DIAL_GEAR_RATIO of that, per the gear ratio above.
function wireRotaryDial(
  dial: HTMLElement,
  tick: HTMLElement,
  onDelta: (deltaRad: number) => void,
  keys: [string, string],
): void {
  let dialAngle = 0; // cosmetic — which way the tick currently points
  let dragging = false;
  let lastAngle = 0;
  const angleAt = (ev: PointerEvent) => {
    const rect = dial.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    return Math.atan2(ev.clientY - cy, ev.clientX - cx);
  };
  const spinTick = (delta: number) => {
    dialAngle += delta;
    tick.style.transform = `rotate(${dialAngle}rad)`;
  };
  dial.addEventListener('pointerdown', (ev) => {
    dragging = true;
    dial.setPointerCapture(ev.pointerId);
    lastAngle = angleAt(ev);
  });
  dial.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const angle = angleAt(ev);
    let delta = angle - lastAngle;
    // wrap the shortest way round rather than snapping when crossing ±π
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    spinTick(delta);
    onDelta(delta / DIAL_GEAR_RATIO);
    lastAngle = angle;
  });
  const stop = (ev: PointerEvent) => {
    dragging = false;
    if (dial.hasPointerCapture(ev.pointerId)) dial.releasePointerCapture(ev.pointerId);
  };
  dial.addEventListener('pointerup', stop);
  dial.addEventListener('pointercancel', stop);
  // keyboard: an accessible nudge, for anyone not on a touch/mouse pointer
  dial.addEventListener('keydown', (ev) => {
    if (ev.key !== keys[0] && ev.key !== keys[1]) return;
    ev.preventDefault();
    const step = (ev.key === keys[0] ? -1 : 1) * 0.12;
    spinTick(step);
    onDelta(step / DIAL_GEAR_RATIO);
  });
}

wireRotaryDial(
  document.querySelector<HTMLDivElement>('#yaw-dial')!,
  document.querySelector<HTMLDivElement>('#yaw-dial-tick')!,
  (d) => { userYaw += d; },
  ['ArrowLeft', 'ArrowRight'],
);
wireRotaryDial(
  document.querySelector<HTMLDivElement>('#pitch-dial')!,
  document.querySelector<HTMLDivElement>('#pitch-dial-tick')!,
  (d) => { userPitch += d; },
  ['ArrowUp', 'ArrowDown'],
);

// ---------- flag: plant a marker at the point currently facing the camera ----------
//
// "Facing the camera" is read off the *sphere*, not off any one layer of
// paint: the direction from the globe's centre to the camera, carried back
// into the globe's own object space (undoing whatever the two dials and
// the day spin currently have it rotated to), is exactly the point the
// viewer is looking square at — because the camera always looks at the
// globe's centre (see TARGET_Y/camera.lookAt above), that direction and
// the view direction coincide at the surface.
// On request, the physical pole-and-cloth flag is gone — the marker is now
// a small flat pin on the ground (just enough geometry to say "here",
// visible from any angle including nearly straight down, which a cloth
// billboard is not) plus an HTML "digital speech bubble" that always faces
// the viewer and carries the coordinates, tracked onto screen every frame
// below.
const flagGroup = new THREE.Group();
flagGroup.visible = false;
{
  const pin = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, 0.006, 20),
    new THREE.MeshStandardMaterial({ color: 0x2fa8e8, emissive: 0x0e3f5c, roughness: 0.4 }),
  );
  pin.position.y = 0.003;
  flagGroup.add(pin);
}
globeGroup.add(flagGroup);

const flagButton = document.querySelector<HTMLButtonElement>('#flag-button')!;
const flagBubble = document.querySelector<HTMLDivElement>('#flag-bubble')!;
const flagBubbleCoord = document.querySelector<HTMLDivElement>('#flag-bubble-coord')!;
const flagWorldDir = new THREE.Vector3();
const flagLocalDir = new THREE.Vector3();
const flagGlobeQuat = new THREE.Quaternion();
const flagGlobeCentre = new THREE.Vector3();
const flagRaycaster = new THREE.Raycaster();
const flagBubbleWorldPos = new THREE.Vector3();
const flagBubbleGlobeCentre = new THREE.Vector3();
const flagBubbleNormal = new THREE.Vector3();
const flagBubbleToCamera = new THREE.Vector3();
// Slightly above dead centre in normalised device coordinates (+Y is up in
// NDC), on request — a flag planted at the exact optical centre of the
// frame is fine geometrically but sits low relative to how the globe's own
// mass is framed (see TARGET_Y's own note on why the aim point is already
// off-centre for composition). 0.18 is a small nudge, not a relocation.
const FLAG_NDC_BIAS = new THREE.Vector2(0, 0.18);
const flagHit = new THREE.Vector3();
flagButton.addEventListener('click', () => {
  // Was `camera.position - globeCentre`, which is the direction from the
  // globe's *centre* to the camera — correct only if the camera looks
  // straight at that centre, which it does not: the camera aims at
  // (0, TARGET_Y, 0) = (0, 0.15, 0) for framing reasons (see the note by
  // TARGET_Y — it leaves room for the stand at the bottom of the shot),
  // while the globe itself is seated at (0, GLOBE_CENTRE_Y, 0) = (0, 0.86,
  // 0). Those are different points, so the old formula planted the flag
  // wherever a line from the globe's centre through the camera happened
  // to land — not the point the viewer is actually looking at, which is
  // what "正面視点" asked for. Using a raycaster through a screen-space
  // point (here, a touch above dead centre — see FLAG_NDC_BIAS) is both
  // the fix and the way to bias the pick without hand-rolling the same
  // camera-ray math a second time.
  flagRaycaster.setFromCamera(FLAG_NDC_BIAS, camera);
  globeGroup.getWorldPosition(flagGlobeCentre);
  const sphere = new THREE.Sphere(flagGlobeCentre, RADIUS);
  if (!flagRaycaster.ray.intersectSphere(sphere, flagHit)) {
    // Should not happen at this camera's framing (the globe fills most of
    // the frame), but fall back to the simple globe-centre-to-camera
    // approximation rather than silently doing nothing if it somehow ever
    // does.
    flagHit.copy(camera.position).sub(flagGlobeCentre).setLength(RADIUS).add(flagGlobeCentre);
  }
  flagWorldDir.copy(flagHit).sub(flagGlobeCentre).normalize();
  globeGroup.getWorldQuaternion(flagGlobeQuat);
  flagLocalDir.copy(flagWorldDir).applyQuaternion(flagGlobeQuat.invert()).normalize();
  const surface = RADIUS + sampledHeight(flagLocalDir).display * BUMP_HEIGHT;
  flagGroup.position.copy(flagLocalDir).multiplyScalar(surface);
  // the pin geometry lies flat along local +Y, so aligning +Y with the
  // surface normal is what makes it sit flush with the ground
  flagGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), flagLocalDir);
  flagGroup.visible = true;

  // Latitude/longitude. Read off flagLocalDir directly — it is the
  // point's own object-space direction, which does not change as the
  // globe keeps spinning under it.
  //
  // atan2(z, -x) is this project's internal texture-sampling angle (see
  // lonOf in clouds.ts, realElevationAt in terrain.ts) — it is *not* real
  // -world longitude on its own. terrain.ts's own latLonToDir shows the
  // actual relationship: real lon 0 (Greenwich) maps to phi = π, i.e.
  // atan2(z, -x) = 180°, not 0°. The two are offset by exactly 180°
  // because the source equirectangular texture's left edge (px=0, where
  // this project's internal atan2 angle is 0) is real longitude -180, not
  // Greenwich. Without the +180 correction below, a flag planted on real
  // Tokyo (35N 140E) reported "W 40.0°" instead of "E 140.0°" — every
  // reading was off by exactly half the globe.
  const latDeg = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(flagLocalDir.y, -1, 1)));
  let lonDeg = THREE.MathUtils.radToDeg(Math.atan2(flagLocalDir.z, -flagLocalDir.x)) + 180;
  if (lonDeg > 180) lonDeg -= 360;
  const ns = latDeg >= 0 ? 'N' : 'S';
  const ew = lonDeg >= 0 ? 'E' : 'W';
  flagBubbleCoord.textContent =
    `${ns} ${Math.abs(latDeg).toFixed(1).padStart(4, '0')}°  ${ew} ${Math.abs(lonDeg).toFixed(1).padStart(5, '0')}°`;
  flagBubble.hidden = false;
});

// ---------- story screen ----------

const storyOverlay = document.querySelector<HTMLDivElement>('#story-overlay')!;
const storyButton = document.querySelector<HTMLButtonElement>('#story-button')!;
const storyClose = document.querySelector<HTMLButtonElement>('#story-close')!;
storyButton.addEventListener('click', () => {
  storyOverlay.hidden = false;
});
storyClose.addEventListener('click', () => {
  storyOverlay.hidden = true;
});
storyOverlay.addEventListener('click', (ev) => {
  if (ev.target === storyOverlay) storyOverlay.hidden = true;
});

// ---------- animation loop ----------

const clock = new THREE.Clock();
let rendering = false;
let globeTick: ((t: number) => void) | null = null;
let lastT = 0;

function startRendering() {
  if (rendering) return;
  rendering = true;
  animate();
}

function animate() {
  const t = clock.getElapsedTime();

  if (spinning) {
    // Was `0.0025 * 60 * (1 / 60)` — a fixed increment added once per
    // animate() call, not scaled by how much wall-clock time that call
    // actually covered. That is silently correct only at exactly 60fps.
    // Every other system in this file (season, wind, eruptions, tides)
    // is driven off `t` itself, i.e. real elapsed seconds, so "a day is
    // ~42 seconds" holds for them regardless of frame rate — but the
    // globe's own spin was the one exception, decoupled from wall-clock
    // time and tied to however many animate() calls happened to run.
    // On a slow device (this project explicitly targets phones — see
    // gap-analysis §0's "携帯で動く") a frame-rate dip would have made a
    // day visibly longer than 42s while the season and every light cue
    // kept the real schedule; on a high-refresh-rate display it would run
    // fast for the same reason. `delta` recovers actual elapsed time from
    // the same clock the rest of the frame already reads, so the spin
    // rate now means what its constant says regardless of frame rate.
    const delta = Math.max(0, t - lastT);
    autoSpinY += 0.0025 * 60 * delta;
  }
  lastT = t;

  // Day spin and the user's own east-west dial add together (see the
  // cyber-panel note above); north-south is the pitch dial directly, and
  // the axial tilt is a flat 0 now that nothing is mounted on a rod to
  // read a lean against.
  globeGroup.rotation.y = autoSpinY + userYaw;
  globeGroup.rotation.x = userPitch;
  globeGroup.rotation.z = AXIAL_TILT;

  // The globe's own per-frame work is registered once it exists. It cannot
  // be referenced directly from here: rendering starts before those
  // bindings are initialised, and a `const` read before its declaration
  // throws rather than yielding undefined, so an optional-chained access
  // would not have saved it either.
  globeTick?.(t);


  // keep the focal plane pinned to the front face of the globe — the
  // camera is static now, but the globe itself still turns under the
  // dials/spin, so this still has work to do
  cameraPass.uniforms.uTime.value = t;
  cameraPass.uniforms.uFocusDistance.value = Math.max(
    camera.position.distanceTo(globeGroup.position) - RADIUS * 0.72,
    0.5,
  );

  composer.render();

  // The speech bubble is HTML, not a 3D billboard — crisp text at any
  // zoom, and no second draw call for a sprite. Positioned by projecting
  // the marker's *current* world position (matrixWorld is now up to date:
  // render() just traversed the whole scene graph) through the same
  // camera the globe was just drawn with, so it tracks the marker exactly
  // regardless of how the two dials or the day spin have turned the globe
  // since it was planted.
  if (flagGroup.visible) {
    flagGroup.getWorldPosition(flagBubbleWorldPos);
    globeGroup.getWorldPosition(flagBubbleGlobeCentre);
    // Hidden once the marker has rotated onto the far side of the globe —
    // a speech bubble anchored to a point behind the sphere, still drawn
    // in front of it, would read as a bug rather than as "not visible from
    // here right now."
    flagBubbleNormal.copy(flagBubbleWorldPos).sub(flagBubbleGlobeCentre).normalize();
    flagBubbleToCamera.copy(camera.position).sub(flagBubbleWorldPos).normalize();
    const front = flagBubbleNormal.dot(flagBubbleToCamera) > 0.08;
    if (front) {
      const ndc = flagBubbleWorldPos.clone().project(camera);
      const x = (ndc.x * 0.5 + 0.5) * window.innerWidth;
      const y = (1 - (ndc.y * 0.5 + 0.5)) * window.innerHeight;
      flagBubble.style.display = '';
      flagBubble.style.left = `${x}px`;
      flagBubble.style.top = `${y}px`;
    } else {
      flagBubble.style.display = 'none';
    }
  }

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
// G32: a quarter-resolution pass first, so the globe itself has a face
// within a second or two of the workshop appearing, instead of staying
// bare geometry for however long the full 2048-wide bake takes. This is
// the "structural" candidate docs/gap-analysis §2-42/§2-44 left open —
// the earlier work there (skipping zero-coefficient noise, the sRGB LUT)
// cut the cost of one bake; this changes *when* a bake's result is first
// shown, which is what the original complaint (a long silent wait, not a
// long total time) was actually about. Total CPU work goes up a little —
// a quarter-res bake costs roughly a sixteenth of the full one, on top
// of the full bake that still has to run — but nothing downstream reads
// these pixels: species placement, roads, rivers and every other system
// read terrain.ts's own fields (heightAt, ergAt, ...) directly, never the
// rasterised texture, so baking it twice at two resolutions doesn't
// duplicate or risk drifting anything else.
const terrainTexture = buildTerrainTexture(TEX_W / 4, TEX_H / 4);
await yieldToBrowser('起伏');

const terrainBumpTexture = buildBumpTexture(TEX_W / 4, TEX_H / 4);
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

await yieldToBrowser('街の灯り');
const cityLightsTexture = buildCityLightsTexture(TEX_W, TEX_H);

const globeMaterial = new THREE.MeshPhysicalMaterial({
  map: terrainTexture,
  // fine surface relief via lighting only (no extra geometry) — the
  // single biggest lever for "sculpted miniature" vs. "smooth painted
  // ball" once you actually zoom in on it
  bumpMap: terrainBumpTexture,
  bumpScale: 0.005,
  // pushed to fully matte — the whole point of the glossy ocean resin is
  // that it's the *only really shiny* thing in the scene; any strong gloss
  // on the rock undercuts that contrast and makes both materials read as
  // "plastic". Kept matte at the base layer; see the clearcoat note below
  // for how the land now catches a *little* reflected light without
  // touching that contrast.
  roughness: 0.97,
  metalness: 0,
  // On request ("陸地もハイクオリティにしたい" — land looked flat and dull
  // next to the now-glossy ocean). A thin clearcoat is not the ocean's
  // shiny resin lobe (clearcoat 0.85 @ roughness 0.16) — it stays well
  // short of that gloss so the land/ocean material contrast stays intact.
  // clearcoatRoughness tightened from 0.75 to 0.35 on the follow-up "新海
  // 誠的な" request: a wide soft satin sheen reads as a matte-lacquered
  // diorama, but that director's own sunlit terrain catches the light as
  // small, sharp highlights along ridgelines rather than a broad soft
  // glow — a *lower* clearcoatRoughness (tighter specular lobe), not a
  // higher one. envMapIntensity raised alongside it (0.06 -> 0.18) so
  // there's actually more of the studio environment map (see
  // buildStudioEnvironment) for those sharper highlights to catch.
  clearcoat: 0.16,
  clearcoatRoughness: 0.35,
  envMapIntensity: 0.18,
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
        // Narrowed from (0.16, -0.12) on request for more day/night
        // contrast — still soft enough not to read as a stencil, just a
        // tighter band so the transition itself is crisper.
        float night = smoothstep(0.12, -0.08, sun);
        // Raised from 2.4: with the night side darkened further below, the
        // lights need more headroom above that darker floor to still read
        // as distinct bright points instead of getting lost in a merely
        // dim rather than genuinely dark sky.
        totalEmissiveRadiance += texture2D(uCityLights, vMapUv).rgb * night * 3.6;

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
        // Cut hard (0.95 -> 0.4) on request — "a strange vivid dark-blue
        // band". This "blue hour" cool band was already here and tuned
        // against the old, gentler colour grade; the saturation/contrast
        // lift added since (cameraPass.ts's uSaturation/uContrast, raised
        // when cel-shading was dropped for bloom+saturation instead) push
        // a saturated blue like this one much harder than the flatter grade
        // it was originally judged against, and it read as an odd painted
        // streak rather than a dusk tint once amplified that way.
        totalEmissiveRadiance +=
          mix(vec3(0.28), diffuseColor.rgb, 0.5) * vec3(0.26, 0.44, 0.95) * coolBand * 0.4;

        // G54: past the dusk bands, the rest of the night limb was simply
        // pure black — nothing at the silhouette edge at all. A grazing-
        // angle (Fresnel) term on the object's own normal and view
        // direction, gated to the night hemisphere so it never competes
        // with the sunlit side's own much stronger response, and kept
        // well under the dusk bands' strength so it reads as a whisper of
        // cool light tracing the curve of the ball rather than a halo —
        // not a revived atmosphere shell (gap-analysis §9 rules that back
        // out explicitly), just this object's own surface catching a rim
        // the way the resin ocean and every painted edge here already do.
        // Pushed a lot further on request: "brighten/light up the rim, the
        // way Earth actually reads from space." Exponent dropped again
        // (2.2 -> 1.5) so the band is wide enough to read as a halo hugging
        // the silhouette rather than a thin pencil line, and both gains
        // roughly doubled. Still no shell mesh — gap-analysis §9's ban on
        // reviving one stands — this is the same silhouette-only Fresnel
        // trick, just turned up until it actually looks like the reference
        // "glowing blue limb" instead of a whisper ACES quietly ate.
        float rimFresnel = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 1.5);
        // Pushed further again (0.55 -> 0.85, and the day term below the
        // same amount) alongside rimLight's own boost, on request for a
        // stronger silhouette edge overall.
        totalEmissiveRadiance += vec3(0.22, 0.42, 0.68) * rimFresnel * night * 0.85;

        // A thin atmosphere, on request. Still not a revived shell mesh —
        // same constraint as the night rim just above, same technique (add
        // to this object's own emissive at its silhouette, no new geometry,
        // no new draw call) — just also gated to the *daylit* fraction
        // (1.0 - night) instead of only the night one, and given the
        // brighter, whiter sky-blue a sunlit limb actually has rather than
        // the night rim's cooler, dimmer tone.
        totalEmissiveRadiance += vec3(0.55, 0.75, 1.0) * rimFresnel * (1.0 - night) * 0.85;

        // The far side's own colour, not just what lights it. Cutting the
        // ambient/fill/rim rig (see the note by their definitions) only goes
        // so far: three's tonemap pipeline recovers visibility from
        // whatever light survives however small, so a point that keeps its
        // full daylight albedo and is merely lit very dimly still reads as
        // an underexposed photo of daytime rather than as night. Darkening
        // the albedo itself, after the emissive terms above have already
        // read its true colour, is what actually sells "the sun isn't up
        // here" — city lights, the dusk bands and the rim above are all in
        // totalEmissiveRadiance, a separate accumulator, so none of them
        // are dimmed by this.
        // Deepened from 0.32: even with the fill/rim/ambient rig cut back
        // (see their own definitions), those lights are not gated by day/
        // night at all — they light the whole ball from fixed directions,
        // the way a photography rig would — so their contribution here was
        // only ever reduced in proportion to whatever this multiplier kept,
        // never zeroed. At 0.32 the far side still read as "dim daytime"
        // rather than night, which is also most of why the city lights
        // above struggled to read as bright points against it: they were
        // competing with a sky-and-ground base that was too bright to look
        // dark next to, not just under-lit lights.
        // Deepened again (0.14 -> 0.10) alongside the tighter terminator
        // above, for more day/night contrast.
        diffuseColor.rgb *= mix(1.0, 0.10, night);

        // Atmospheric perspective, on request ("新海誠的な" -- his wide
        // shots always cool and desaturate toward the horizon, standing in
        // for miles of haze between the viewer and the far ground). This
        // globe has no real distance for haze to travel across, so the
        // grazing-angle rimFresnel above is reused as the stand-in: it is
        // already exactly "how close to the silhouette is this point",
        // which is the one variable that would drive real atmospheric
        // perspective on an actual planet limb. Desaturating and cooling
        // the *albedo* here (not just adding an emissive glow, which the
        // rim terms above already do) is what actually reads as haze
        // sitting in front of the terrain rather than a light shining on
        // it. Strengthened again (0.22 -> 0.4) on request ("陸地の空気遠
        // 近法強くできない？海と同じように") -- land's higher-frequency
        // biome colour was eating the same 0.22 mix the more uniform blue
        // ocean read clearly, so land needed a stronger push to land in
        // the same visual place, not a smaller one.
        float aerial = rimFresnel * 0.4;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.7, 0.82), aerial);
      }`,
    )
    .replace(
      '#include <map_fragment>',
      `#include <map_fragment>
      // G38: how much this point is "cold enough for a passing storm to
      // lay down snow, even if it is outside where snow survives for
      // good" — declared out here, rather than inside either block below,
      // because both the fresh-snow pass and the wet-ground pass need it:
      // a storm cell cold enough to snow should not also get the "rained
      // on" mud darkening a warm one does.
      float freshSnowGate = 0.0;
      {
        float landMask = smoothstep(uSeaRadius - 0.01, uSeaRadius + 0.01, vSeasonRadius);
        float seasonalFactor = uSeasonTilt * vSeasonLat;
        float winterAmount = clamp(-seasonalFactor, 0.0, 1.0);
        float snowLine = mix(0.82, 0.5, winterAmount);
        float seasonalSnow = smoothstep(snowLine, snowLine + 0.14, abs(vSeasonLat)) * winterAmount * landMask;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.799, 0.855, 0.888), seasonalSnow * 0.8);

        // Fresh snow, riding on top of the settled line rather than
        // replacing it. seasonalSnow above is the climatological floor —
        // where winter has settled in for good — but a cloud passing
        // slightly outside that band can still lay snow down, and it does
        // not survive there the way the permanent line does.
        //
        // rainWet (the wet-ground pass below) is the wrong signal to
        // reuse here even though it looks tailor-made: its "raining now"
        // flag is only ever stamped by storm/typhoon bands (clouds.ts's
        // rainingAtBake), and storm is a type this deck only assigns in
        // the tropics — it never occurs at a latitude cold enough for
        // this gate to be nonzero. Reusing it would have shipped a term
        // that could never actually fire. Coverage — cloudCoverAt, any
        // band type, the same red channel cloudShade already reads —
        // does exist this far out, so that is the signal snow rides on:
        // ground under a cold, sufficiently thick cloud gets fresh white
        // laid on top. It fades as the deck drifts off again, which is
        // this project's usual proxy for melt (§2-22's wet ground is the
        // same idea for rain).
        freshSnowGate = smoothstep(snowLine - 0.4, snowLine, abs(vSeasonLat)) * winterAmount * landMask;
        float freshSnow = smoothstep(0.12, 0.4, cloudCoverAt(vObjNormal)) * freshSnowGate;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.9, 0.93), freshSnow * 0.55);
      }
      // Cloud shade. Applied to the albedo rather than to the light so it
      // costs nothing extra and darkens the ground the way an overcast
      // does — the land keeps its own colour, it just receives less.
      diffuseColor.rgb *= cloudShade(vObjNormal, 0.38);
      // Wet ground. Rock and soil that has just been rained on is darker,
      // and that is the whole of it here: the paint keeps its hue and
      // loses a fifth of its value. Multiplied, never subtracted — a
      // constant taken off a linear colour clamps the dark parts to black
      // and draws a hard key line round everything (§2-15) — and left out
      // of the gloss entirely, because "only the sea is shiny" is a
      // standing decision about this object, not an oversight (§2-18).
      {
        // Land only. The sea does not get wet, and the painted ocean under
        // the glass shell is part of this same map — darkening it here
        // would have put a "rained on" patch on the one surface in the
        // scene that cannot be. Cold ground is excluded too (1 -
        // freshSnowGate) — that precipitation already went white above,
        // not dark.
        float wetLand = smoothstep(uSeaRadius - 0.01, uSeaRadius + 0.01, vSeasonRadius);
        diffuseColor.rgb *= 1.0 - rainWet(vObjNormal) * wetLand * (1.0 - freshSnowGate) * 0.2;
      }`,
    );
};

const globeMesh = new THREE.Mesh(geometry, globeMaterial);
globeMesh.castShadow = true;
globeMesh.receiveShadow = true;
globeGroup.add(globeMesh);

// G32: the refine pass. The globe above is already on screen — rendering
// started before this file even began building textures (see
// startRendering() near the top) — carrying the quarter-res preview, so
// this is the point where the extra cost of having baked twice actually
// buys something: everything after this line runs against an already-
// present, already-spinning globe instead of a blank one. Swap the
// Texture objects themselves rather than mutating .image, since the
// preview and the full bake are different-sized canvases; needsUpdate
// tells the material to rebind rather than trust its compiled state.
await yieldToBrowser('地形（精細化）');
const fullTerrainTexture = buildTerrainTexture(TEX_W, TEX_H);
const fullBumpTexture = buildBumpTexture(TEX_W, TEX_H);
globeMaterial.map = fullTerrainTexture;
globeMaterial.bumpMap = fullBumpTexture;
globeMaterial.needsUpdate = true;
terrainTexture.dispose();
terrainBumpTexture.dispose();

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

// ---------- what the resin is reflecting ----------
//
// The single loudest "this is a render" cue left on the sphere was a small
// round blown-out white dot on its upper left. Traced with temporary
// switches rather than guessed at, and the first two guesses were both
// wrong: zeroing the key light left the dot exactly as it was, and so did
// zeroing the bench lamp. Zeroing every light in the scene — with the
// environment map still on — removed it, which settles that it is direct
// light and not the environment. It turns out to be the *rim* light, a
// directional at (-4, 2, -3) with an intensity of 0.45; confirmed by
// switching that one light off on its own.
//
// The count is worse than one. Photographed against open ocean, the old
// shading puts *four* of these on the sphere, one per light: the key's, the
// bench lamp's, the fill's and the rim's, all of them small hard circles.
// Only the rim's was in open water in the frame that got reviewed — the
// others happened to be sitting on North America. Nothing about this is a
// tuning error either: the ocean carries clearcoat 0.85 at
// clearcoatRoughness 0.16, and a punctual light has no angular size at all.
// A GGX lobe that narrow, fed by a source that is mathematically a point,
// can only ever be a circle; at exposure 1.9 it clips to flat white and
// reads as a lens flare stuck to a ball.
//
// Nothing in a photograph of a glossy sphere looks like that. What a resin
// sphere on a desk shows is a picture of the room: the *shape* of whatever
// is lighting it — a shade, a softbox, a window — with a soft edge and an
// area falloff, plus dimmer, larger, vaguer reflections of everything else
// bright in the room. So the fix is in the shading, in two halves, and it
// adds no light and no draw call (see gap-analysis section 9: another light
// source is what makes the frame look like two photographs stuck together).
//
// Half one, in the shader below: the punctual lights get their clearcoat
// roughness widened *for the direct lobe only* — an honest stand-in for the
// angular size the light source in the story actually has. The GGX peak
// falls with the square of alpha, so 0.16 -> 0.52 drops it by two orders of
// magnitude and spreads its energy across a broad wash. The dot stops being
// a dot. Restored immediately afterwards so the environment map's own
// reflection, which is what gives the resin its wet look, keeps the sharp
// value it was tuned at.
//
// Half two, here: the sources get drawn back in with a shape. Each one is a
// rounded rectangle in the direction domain — evaluated against the mirror
// direction, so it behaves like a reflection and not like a decal: it stays
// put in the room while the planet turns under it, it compresses toward the
// limb the way a real reflection does, and because it is evaluated against
// the bump-mapped normal the swell breaks its edge up. Two of them: the
// bench lamp's shade above and to the left (bright, near-white, the size of
// a shade at that distance) and the lit part of the room off to the right
// (large, dim, warm — the secondary the eye reads as "there is a room
// here"). Warm rather than cool for the second one because what is being
// reflected is walnut and book cloth under the same lamp, not daylight.
function shapedSource(x: number, y: number, z: number) {
  const axis = new THREE.Vector3(x, y, z).normalize();
  // world up is only a reference for which way "sideways" is; neither
  // source is anywhere near vertical, so the degenerate case cannot arise
  const right = new THREE.Vector3().crossVectors(axis, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, axis).normalize();
  return { axis, right, up };
}
// the direction from the globe's centre to the bench lamp at (-3, 7, 4)
const LAMP_SOURCE = shapedSource(-3, 6.4, 4);
// and to the lit part of the room off to the right. Pointed well round the
// side on purpose: a secondary this dim only reads as a reflection if it
// hugs the limb, where a reflection is compressed and strengthened. A first
// pass aimed it at (4.2, 1.8, 2.6), which put it two thirds of the way in
// from the edge as a broad flat grey oval — over dark ocean that is not a
// reflection of a room, it is a smudge on the lens.
const CARD_SOURCE = shapedSource(5.0, 1.5, -1.6);

/**
 * Rounded-rectangle emitter in the direction domain.
 *
 * Returns (belly, face, spill), three nested falloffs off one signed
 * distance. One smoothstep is not enough and the first attempt proved it:
 * a single ramp gives a flat plateau clipped to white with an edge on it,
 * which is a sticker of a softbox rather than a reflection of one. A real
 * diffuser is brightest across the middle and falls off before it reaches
 * its own frame (belly), has a definite but soft boundary (face), and
 * throws a much fainter, much larger haze into the room around it (spill).
 */
const SHAPED_SOURCE_GLSL = `
  vec3 sourceLobe(
    vec3 mirrorDir, vec3 axis, vec3 right, vec3 up,
    vec2 halfSize, float corner, float feather
  ) {
    vec2 q = vec2(dot(mirrorDir, right), dot(mirrorDir, up));
    vec2 d = abs(q) - halfSize + corner;
    float sd = min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - corner;
    // the emitter is in front of the surface, not behind it
    float front = step(0.0, dot(mirrorDir, axis));
    // the shorter half-axis is the only length scale the interior has
    float depth = min(halfSize.x, halfSize.y);
    return front * vec3(
      smoothstep(0.0, -depth * 0.9, sd),
      smoothstep(feather * 0.34, -feather * 0.12, sd),
      smoothstep(feather * 1.2, -feather * 0.05, sd));
  }
`;

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
  // Was full strength — the per-texel alpha ramp baked into the ocean
  // texture is what varies transparency across the surface, so this is a
  // flat multiplier on top of that ramp rather than a competing one.
  // Nudged down only slightly, on request: a much lower value is what
  // previously read as "soft gummy-candy jelly" rather than solid poured
  // resin (see the note above this material), so this stays close to fully
  // opaque and only barely lets the seabed show through.
  opacity: 0.92,
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
  shader.uniforms.uSeasonTilt = seasonUniforms.uSeasonTilt;
  shader.uniforms.uSunDir = dayNightUniforms.uSunDir;
  shader.uniforms.uCloudShadow = cloudShadowUniforms.uCloudShadow;
  shader.uniforms.uCloudTime = cloudShadowUniforms.uCloudTime;
  shader.uniforms.uOmegaScale = cloudShadowUniforms.uOmegaScale;
  // the two reflected sources, in world space and therefore constant: the
  // room does not turn with the planet, which is the whole point of them
  shader.uniforms.uLampAxis = { value: LAMP_SOURCE.axis };
  shader.uniforms.uLampRight = { value: LAMP_SOURCE.right };
  shader.uniforms.uLampUp = { value: LAMP_SOURCE.up };
  shader.uniforms.uCardAxis = { value: CARD_SOURCE.axis };
  shader.uniforms.uCardRight = { value: CARD_SOURCE.right };
  shader.uniforms.uCardUp = { value: CARD_SOURCE.up };
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      '#include <common>\nuniform float uTime;\nuniform sampler2D uCloudShadow;\nuniform float uOmegaScale;\nvarying vec3 vOceanNormal;\nvarying vec3 vObjNormal;',
    )
    .replace(
      '#include <beginnormal_vertex>',
      `#include <beginnormal_vertex>
      // The swell, and — the part that was missing — its slope.
      //
      // There has been a vertex swell on this sphere for a long time and it
      // could not be seen, for a reason worth writing down: it moved the
      // vertices and left the normal alone. A displacement that does not
      // change the shading normal can only be seen in the silhouette, and
      // this one stood 0.002 units tall on a globe carrying about 108
      // pixels per unit — a fifth of a pixel. It was a wave the light knew
      // nothing about.
      //
      // Both waves are plain sinusoids in object space, so their gradient
      // is closed form: d/dp of A*sin(k·p + wt) is A*k*cos(k·p + wt). The
      // surface is p + n*s(p), so tilting the normal against the part of
      // that gradient which lies along the surface is the whole of it —
      // exact, four cosines, no finite differences and no extra passes.
      // What the eye reads is the *slope* A*|k|, not the height, and this
      // surface is far more sensitive to it than open water would be —
      // the clearcoat is sharp (roughness 0.16) and the sea is nearly the
      // darkest thing on the sphere, so a tilt that reflects the room
      // instead of the lamp goes almost black. The first pass ran at four
      // degrees and laid visible dark diagonal streaks across both oceans:
      // a corduroy of swell rather than a sheet of poured resin with a
      // slow movement in it. Half that is where it stops announcing the
      // wave vector and starts reading as water.
      vec3 oceanUp = normalize(position);
      // The swell travels with the wind belt it is in, which is the last
      // thing on this planet that was still turning as one rigid piece.
      //
      // The wind profile itself is not repeated here. clouds.ts bakes each
      // latitude's drift rate into the green channel of the cloud-shade map
      // — row-constant, decoded exactly as cloudShade does it in the
      // fragment stage — and this shader already has that texture bound for
      // the shade. So the sea reads the same trades and westerlies the sky
      // does, off a texture fetch that costs nothing, instead of carrying a
      // second copy of zonalWind() in GLSL that would drift out of step the
      // first time anyone tuned one of them.
      float oceanLat = asin(clamp(oceanUp.y, -1.0, 1.0));
      float oceanOmega =
        (texture2D(uCloudShadow, vec2(0.5, oceanLat / 3.14159265 + 0.5)).g - 0.5) * uOmegaScale;
      // Turning the sample point back by omega*t is the same as sliding the
      // whole wave field forward along the parallel: east in the
      // westerlies, west in the trades, and stalled at the doldrums and the
      // horse latitudes where the profile crosses zero.
      float oceanDrift = -oceanOmega * uTime * 12.0;
      float driftCos = cos(oceanDrift);
      float driftSin = sin(oceanDrift);
      vec2 oceanXZ = vec2(
        position.x * driftCos - position.z * driftSin,
        position.x * driftSin + position.z * driftCos
      );
      float wavePhaseA = oceanXZ.x * 9.0 + oceanXZ.y * 5.5 + uTime * 1.1;
      float wavePhaseB = oceanXZ.x * 4.5 - oceanXZ.y * 6.5 - uTime * 0.7;
      float oceanSwell = sin(wavePhaseA) * 0.0034 + sin(wavePhaseB) * 0.0024;
      // Gradients in the drifted frame, rotated back into object space —
      // the wave vectors turn with the sample point, so the crests keep
      // running the way the wind put them however far the field has slid.
      vec2 kA = vec2(9.0, 5.5);
      vec2 kB = vec2(4.5, -6.5);
      vec2 gradXZ = kA * (cos(wavePhaseA) * 0.0034) + kB * (cos(wavePhaseB) * 0.0024);
      vec3 oceanGrad = vec3(
        gradXZ.x * driftCos + gradXZ.y * driftSin,
        0.0,
        -gradXZ.x * driftSin + gradXZ.y * driftCos
      );
      // only the component along the surface tilts it; the radial part is
      // just the height change, which the displacement below already does
      oceanGrad -= oceanUp * dot(oceanUp, oceanGrad);
      objectNormal = normalize(oceanUp - oceanGrad);`,
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      // Wavelength, set against the mesh rather than by eye. At a
      // wavenumber of 9 the swell runs about 0.7 radians from crest to
      // crest, and the ocean shell (SETTINGS.oceanSegments) puts eight or
      // nine vertices across that — the old pair ran at 14 and 6 on a
      // 76-segment shell, which is two or three vertices per wavelength,
      // i.e. below the point where a sine can exist at all in the
      // geometry. Anything finer than this belongs in the bump map, which
      // is not tessellation-limited.
      transformed += oceanUp * oceanSwell;
      // same world-space outward direction the globe material carries, for
      // the same reason: the terminator has to travel with the sphere as it
      // turns under the fixed key light. Deliberately the *undisturbed*
      // radial, not the swell-tilted normal above: day and night are a
      // property of where this point is on the planet, and letting a wave
      // tilt it would make the terminator crawl with the swell.
      vOceanNormal = mat3(modelMatrix) * oceanUp;
      // and the object-space one, which is the frame the cloud deck drifts in
      vObjNormal = oceanUp;`,
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
      '#include <common>\nuniform float uSeasonTilt;\nuniform vec3 uSunDir;\nvarying vec3 vOceanNormal;\nuniform sampler2D uCloudShadow;\nuniform float uCloudTime;\nuniform float uOmegaScale;\nvarying vec3 vObjNormal;\nuniform vec3 uLampAxis;\nuniform vec3 uLampRight;\nuniform vec3 uLampUp;\nuniform vec3 uCardAxis;\nuniform vec3 uCardRight;\nuniform vec3 uCardUp;' +
        CLOUD_SHADOW_GLSL +
        SHAPED_SOURCE_GLSL,
    )
    // Half one of the highlight rework (see the shapedSource block above):
    // give the punctual lights the angular size they do not have, for the
    // direct lobe only. material.clearcoatRoughness is read by the punctual
    // loop inside lights_fragment_begin and by the environment reflection
    // inside lights_fragment_maps/_end, which run after it — so widening it
    // here and putting it back immediately affects the light-source
    // reflections and leaves the resin's environment sheen at the sharp
    // 0.16 it was tuned to. 0.52 is where the rim light's disc stops being
    // a disc; below about 0.4 a bright core survives at the centre of the
    // wash and still reads as a dot.
    .replace(
      '#include <lights_fragment_begin>',
      `#ifdef USE_CLEARCOAT
        float oceanSharpClearcoat = material.clearcoatRoughness;
        material.clearcoatRoughness = 0.52;
      #endif
      #include <lights_fragment_begin>
      #ifdef USE_CLEARCOAT
        material.clearcoatRoughness = oceanSharpClearcoat;
      #endif`,
    )
    // Half two: the sources, with a shape. Added to the clearcoat's own
    // direct term rather than to emissive, because that is physically what
    // this is — a reflection in the varnish — and because the emissive path
    // gets multiplied by (1 - clearcoat * Fresnel) further down, which would
    // dim the highlight exactly where a real one gets brightest, at the
    // grazing angles near the limb.
    .replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
      {
        vec3 worldNormal = transformDirectionByInverseViewMatrix(geometryNormal, viewMatrix);
        vec3 worldView = transformDirectionByInverseViewMatrix(geometryViewDir, viewMatrix);
        vec3 mirrorDir = reflect(-worldView, worldNormal);

        vec3 lamp = sourceLobe(
          mirrorDir, uLampAxis, uLampRight, uLampUp, vec2(0.26, 0.15), 0.07, 0.20);
        vec3 card = sourceLobe(
          mirrorDir, uCardAxis, uCardRight, uCardUp, vec2(0.55, 0.30), 0.15, 0.45);

        // A reflection gets stronger toward the limb, and on a sphere that
        // is most of what stops a highlight looking pasted on. Deliberately
        // a gentle version of Schlick rather than the real thing: the full
        // fifth power makes the shade invisible over the middle of the disc,
        // where this one has to live.
        float grazing = pow(1.0 - saturate(dot(worldNormal, worldView)), 4.0);
        float sheen = mix(0.85, 1.5, grazing);

        // Peak about 0.64 linear once the 0.85 clearcoat weighting further
        // down has taken its cut, which at exposure 1.9 through ACES comes
        // out just short of clipping: bright enough to be the brightest
        // thing on the sphere, graded enough that it is still a surface.
        // The face on its own at 0.78 (the first attempt) clipped flat
        // across its whole width and read as a hole cut in the ocean.
        vec3 shaped =
          vec3(1.0, 0.94, 0.84) * (lamp.y * 0.40 + lamp.x * 0.34 + lamp.z * 0.14) * sheen
          + vec3(0.92, 0.78, 0.58) * (card.y * 0.030 + card.z * 0.018) * sheen;

        // G16: sun glint. The lamp reflection above is built from
        // geometryNormal — the smooth macro swell — which is exactly what
        // makes it read as one coherent softbox. Real glitter on choppy
        // water is the opposite: hundreds of wave facets each catching the
        // light at a slightly different tilt, breaking one highlight into a
        // scattered field of sparkle. normal at this point already
        // carries the bump map's per-texel wave tilt (normal_fragment_maps
        // runs before this chunk) — reused here rather than adding a
        // second noise source, the same rule this project keeps following.
        // A narrow lobe is what turns that per-texel tilt into visible
        // sparkle: wide enough to miss it, this would just be a slightly
        // softer version of the same blob.
        vec3 glintNormal = transformDirectionByInverseViewMatrix(normal, viewMatrix);
        vec3 glintMirror = reflect(-worldView, glintNormal);
        vec3 glintLamp = sourceLobe(
          glintMirror, uLampAxis, uLampRight, uLampUp, vec2(0.05, 0.03), 0.01, 0.05);
        // Confined to the lamp's own spill (lamp.z) so the sparkle reads as
        // texture *inside* that reflection, not noise scattered over the
        // whole sea.
        vec3 glint = vec3(1.0, 0.97, 0.9) * glintLamp.y * lamp.z * 2.2;

        #ifdef USE_CLEARCOAT
          clearcoatSpecularDirect += shaped + glint;
        #else
          reflectedLight.directSpecular += shaped + glint;
        #endif
      }`,
    )
    .replace(
      '#include <map_fragment>',
      `#include <map_fragment>
      // Sea ice, and the one part of this planet whose *shape* has a season.
      //
      // Everything seasonal so far changes a colour in place: the foliage
      // turns, the snow line slides, the rain belt moves. The pack is the
      // thing a viewer already knows moves — it is the picture everyone has
      // of a warming planet — and it is the only place on this globe where
      // the outline of the water itself changes through the year.
      //
      // Same construction as the land's snow line above and deliberately
      // so: local winter is uSeasonTilt and this fragment's own latitude
      // carrying opposite signs, and it drives the edge equatorward. The
      // limits are the real ones in sin(latitude), which is the honest
      // parameter here because it is also the one the eye reads as area:
      // 0.93 is about 68 degrees, roughly September's Arctic minimum, and
      // 0.82 is about 55, roughly March's maximum down the Labrador and
      // Bering coasts. Antarctica gets the same band for free, half a year
      // out of step, which is correct.
      //
      // Costs nothing: no re-bake, no texture, no draw call, a dozen
      // instructions on a pass the shell already runs.
      float iceLat = vObjNormal.y;
      float iceWinter = clamp(-uSeasonTilt * iceLat, 0.0, 1.0);
      // A pack edge is not a circle of latitude. Two harmonics in longitude
      // is enough to say so at this size — it wanders about three degrees,
      // which is a couple of pixels of raggedness on the limb.
      float iceLon = atan(vObjNormal.z, vObjNormal.x);
      float iceWobble = sin(iceLon * 7.0) * 0.012 + sin(iceLon * 13.0 + 1.7) * 0.008;
      float iceEdge = mix(0.93, 0.82, iceWinter) + iceWobble;
      float seaIceAmount = smoothstep(iceEdge, iceEdge + 0.05, abs(iceLat));
      // G30: floes and leads. iceWobble above shapes where the pack
      // *starts*; this shapes what it looks like once you're in it — real
      // pack ice is broken into floes with narrow leads of open water
      // between them, not a solid plate. A second, much faster sin pair
      // (frequencies unrelated to the edge wobble's 7/13, so the two
      // patterns don't beat against each other) punches gaps well inside
      // the ice, tapering to nothing right at the edge so that wobble
      // stays clean and legible.
      float floeNoise = sin(iceLon * 41.0 + iceLat * 53.0) + sin(iceLon * 97.0 - iceLat * 31.0 + 2.1);
      float floeDepth = smoothstep(iceEdge + 0.1, iceEdge + 0.22, abs(iceLat));
      float leadGap = smoothstep(0.7, 1.35, floeNoise) * floeDepth;
      seaIceAmount *= 1.0 - leadGap * 0.45;

      // The sea takes the shade harder than the land does. Open water has
      // almost no texture of its own to carry the eye, so cloud shadows
      // crossing it end up being most of what says the sea is a surface
      // under a sky rather than a painted blue field — which is where the
      // absence of shadows was doing the most damage.
      diffuseColor.rgb *= cloudShade(vObjNormal, 0.62);

      // Matched to the land's snow so the pack and the shore agree where
      // they meet, a shade darker because it is ice over water rather than
      // snow over ground. Opaque, too: the shell's alpha is a depth ramp
      // and the sea under the pack is deep, so without this the ice would
      // be a pale film with the abyss showing through it.
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.74, 0.80, 0.85), seaIceAmount * 0.92);
      diffuseColor.a = max(diffuseColor.a, seaIceAmount * 0.97);`,
    )
    .replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
      // Rain stipples the water.
      //
      // The one place this project can show rain landing. On the ground it
      // would be a change of paint value under a canopy that hides the
      // ground (§2-16); on the sea it is a change of *finish*, and the sea
      // here is a sheet of poured resin whose whole character is its
      // gloss. Water under a shower is not glassy — the drops break the
      // surface into a matte, scattering skin — so the same wet channel
      // that darkens soil roughens this instead. Nothing else about the
      // sea changes: it is still the only shiny thing in the scene, just
      // not shiny under a storm.
      roughnessFactor = mix(roughnessFactor, 0.78, rainWet(vObjNormal) * 0.85);
      // Pack ice is the one part of this sea that is not poured resin. Left
      // glassy it reads as a white *reflection* sliding over the water
      // rather than as something floating on it.
      roughnessFactor = mix(roughnessFactor, 0.88, seaIceAmount);`,
    )
    .replace(
      '#include <lights_physical_fragment>',
      `#include <lights_physical_fragment>
      // and the clearcoat with it — the resin's gloss lives almost
      // entirely in this term (clearcoat 0.85 at roughness 0.16), so
      // roughening the base alone would have changed a number without
      // changing the picture.
      material.clearcoatRoughness = mix(material.clearcoatRoughness, 0.55, rainWet(vObjNormal) * 0.85);
      material.clearcoat = mix(material.clearcoat, 0.06, seaIceAmount);
      material.clearcoatRoughness = mix(material.clearcoatRoughness, 0.7, seaIceAmount);`,
    )
    .replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      {
        vec3 oceanN = normalize(vOceanNormal);
        float sun = dot(oceanN, uSunDir);
        // Narrowed to match the globe material's tighter terminator.
        float night = smoothstep(0.06, -0.12, sun);
        // broad, then a tighter core: a wide sheen over the whole night sea
        // with a brighter patch where the moon would stand overhead
        float moon = max(-sun, 0.0);
        // G25: this highlight has always stood in for a moon rather than
        // showing one — there is no open sky in this scene to hang a disc
        // in, only the fixed study-wall backdrop, and a floating moon
        // pasted over that photo is exactly the "two photos composited"
        // failure mode this project has turned down before (see the
        // rejected support-wire idea in the gap analysis). A moon that
        // never phases isn't finishing the job, though, so the sheen
        // itself waxes and wanes: a slow cycle, deliberately not locked to
        // the day (42s) or the year (60s) so it doesn't read as tied to
        // either, between a dim near-new sea and the full brightness
        // tuned below.
        float moonPhase = 0.55 + 0.45 * cos(uCloudTime * 0.257);
        float sheen = (moon * 0.10 + pow(moon, 6.0) * 0.16) * moonPhase;
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
        // Cut alongside the matching term in the globe material — see its
        // note. The ocean is where this read worst: a saturated blue band
        // on already-dark water, further amplified by the later colour
        // grade, looked like a stripe painted across the sea rather than a
        // dusk tint on it.
        totalEmissiveRadiance +=
          mix(vec3(0.26), diffuseColor.rgb, 0.5) * vec3(0.26, 0.46, 0.98) * coolBand * 0.35;

        // Same silhouette rim the globe material carries (main.ts's other
        // onBeforeCompile), added here too rather than left to the land
        // alone: the ocean shell is the outer surface at a good third of
        // the limb on any given view (open water is most of the planet),
        // so a glow that only ever appeared over land read as a broken
        // ring — bright over continents, gapped over the Pacific.
        float oceanRim = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 1.5);
        // Matching the globe material's own rim boost, so the silhouette
        // doesn't get brighter over land and stay dim wherever the limb
        // happens to be open water.
        totalEmissiveRadiance += vec3(0.22, 0.42, 0.68) * oceanRim * night * 0.85;
        totalEmissiveRadiance += vec3(0.55, 0.75, 1.0) * oceanRim * (1.0 - night) * 0.85;

        // Same atmospheric-perspective desaturation the globe material
        // carries toward its own limb (see its note) -- applied here too
        // so the sea doesn't stay saturated blue right up to the edge
        // while the coastline beside it fades to haze.
        float oceanAerial = oceanRim * 0.22;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.7, 0.82), oceanAerial);
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
const clouds = buildClouds(RADIUS, seasonUniforms, dayNightUniforms.uSunDir.value);
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

// Fog, in the two kinds the globe already has the data for: radiation fog
// ponding in enclosed basins before the sun burns it off, and advection fog
// on the cold-current coasts. Unlike the deck above it, fog lies *on* the
// surface and hides what is under it — which is the whole of what separates
// it from a low cloud. See fog.ts.
await yieldToBrowser('霧');
const fog = buildFog(RADIUS, BUMP_HEIGHT, seasonUniforms, dayNightUniforms.uSunDir.value);
globeGroup.add(fog.mesh);

// The aurora, on whichever pole is in darkness. On this globe that is
// almost always the south: the key light is fixed, so the terminator does
// not sweep (§2-12) and the southern band is in night at every rotation
// while the northern one only clears the limb occasionally. Both are built;
// the night test decides which is lit. See aurora.ts.
await yieldToBrowser('オーロラ');
const aurora = buildAurora(RADIUS, dayNightUniforms);
globeGroup.add(aurora.mesh);

// The four volcanoes stop being scenery and start being events.
await yieldToBrowser('火山');
const eruptions = buildEruptions(
  RADIUS,
  BUMP_HEIGHT,
  renderer.getPixelRatio(),
  dayNightUniforms.uSunDir.value,
  // the same profile the clouds ride, so ash and sky agree about the wind
  zonalWind,
  // and the same season clock the snow and the rain veils read, so the
  // dust storms' dry season is the globe's dry season and not a second
  // calendar keeping its own time
  seasonUniforms,
);
globeGroup.add(eruptions.group);

// Famous buildings at their real coordinates, absurdly out of scale, which
// is exactly what a souvenir globe does.
await yieldToBrowser('名所');
globeGroup.add(buildLandmarks(RADIUS, BUMP_HEIGHT));

// G30 continuation: icebergs at the real calving grounds — geometry, not a
// shader term, because a berg stands alone against open water rather than
// tiling across the ice shell the way the pack itself does (§2-49).
await yieldToBrowser('氷山');
globeGroup.add(buildIcebergs(RADIUS, BUMP_HEIGHT));

// Traffic: shipping on the sea and airliners over it, both parented to the
// globe because both travel *with* the planet.
await yieldToBrowser('航路');
const ships = buildShips(RADIUS, BUMP_HEIGHT, dayNightUniforms.uSunDir.value);
globeGroup.add(ships.group);
const aircraft = buildAircraft(RADIUS);
globeGroup.add(aircraft.group);

// Satellites, pointedly *not* parented to the globe: an orbit that turned
// with the planet under it would be a geostationary ring. They hang off a
// group that shares the globe's seat and axial tilt but none of its spin.
const orbitGroup = new THREE.Group();
orbitGroup.position.copy(globeGroup.position);
orbitGroup.rotation.z = AXIAL_TILT; // the same tilt the globe sits at
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

  // No orbit distance to preserve any more — just recompute the same
  // viewport-responsive framing cameraStartPosition() used at load.
  const pos = cameraStartPosition();
  camera.position.set(pos.x, pos.y, pos.z);
  camera.lookAt(0, targetYForViewport(), 0);
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
  fog.tick(t);
  aurora.tick(t);
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

// On request: an animated hand-off instead of the caption just vanishing.
// Adding the class triggers the CSS transition (see .loading-screen.is-done
// in style.css); the element is only actually removed once that transition
// reports it has finished, so a slow device that clips the animation still
// ends with the overlay gone rather than stuck fading forever.
const loadingScreen = document.querySelector<HTMLDivElement>('#loading-screen');
if (loadingScreen) {
  loadingScreen.classList.add('is-done');
  loadingScreen.addEventListener('transitionend', () => loadingScreen.remove(), { once: true });
  // Belt and braces: transitionend can fail to fire (a hidden tab, a
  // reduced-motion override that drops the transition entirely) and this
  // overlay sits on top of the whole scene, so it cannot be allowed to
  // linger if the event never comes.
  window.setTimeout(() => loadingScreen.remove(), 1200);
}
