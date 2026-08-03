import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildTerrainTexture, displaceSphere, seaLevelRadius } from './terrain';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div class="title">箱庭プラネット — mockup</div>
  <div class="ui">
    <button id="mode-toggle" class="mode-button">⏸ 停止する</button>
  </div>
`;

const RADIUS = 2;
const BUMP_HEIGHT = 0.22; // exaggerated on purpose — cute over accurate, but sphere reads as round first
const GLOBE_FLOAT_Y = 1.15; // resting height, leaves a visible gap above the stand

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
camera.position.set(0, 1.4, cameraDistanceForViewport());

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
controls.minPolarAngle = Math.PI * 0.15;
controls.maxPolarAngle = Math.PI * 0.85;
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0.7, 0);

// ---------- lighting ----------

scene.add(new THREE.AmbientLight(0xfff1e0, 0.5));

const keyLight = new THREE.DirectionalLight(0xfff6e6, 1.15);
keyLight.position.set(4, 5, 3);
scene.add(keyLight);

const rimLight = new THREE.DirectionalLight(0xbfe0ff, 0.5);
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
const oceanMaterial = new THREE.MeshPhysicalMaterial({
  color: 0x2f9fd0,
  transparent: true,
  opacity: 0.95,
  roughness: 0.35,
  metalness: 0,
  // a strong clearcoat is what was reading as a hard candy-shell/gummy
  // highlight regardless of the base roughness — dial it way back so
  // sheen comes from soft, diffuse-ish reflections instead
  clearcoat: 0.2,
  clearcoatRoughness: 0.4,
  envMapIntensity: 0.35,
});
const oceanMesh = new THREE.Mesh(oceanGeometry, oceanMaterial);
globeGroup.add(oceanMesh);

// soft cloud shell, purely decorative for now
const cloudGeometry = new THREE.SphereGeometry(RADIUS + 0.16, 48, 32);
const cloudMaterial = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  transparent: true,
  opacity: 0.05,
  roughness: 1,
  depthWrite: false,
});
const cloudMesh = new THREE.Mesh(cloudGeometry, cloudMaterial);
globeGroup.add(cloudMesh);

// ---------- stand: base + magnetic-looking glow ring, no axis ----------

const standGroup = new THREE.Group();
scene.add(standGroup);

const baseMaterial = new THREE.MeshStandardMaterial({
  color: 0xe7cdb0,
  roughness: 0.7,
  metalness: 0.05,
  envMapIntensity: 0.3, // the room env map was blowing the stand out to near-white
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

// glowing ring hinting at the magnetic field holding the globe up,
// floating in the gap between the stand and the globe
const glowRingGeometry = new THREE.TorusGeometry(1.05, 0.05, 16, 64);
const glowRingMaterial = new THREE.MeshBasicMaterial({
  color: 0xffe5b8,
  transparent: true,
  opacity: 0.55,
});
const glowRing = new THREE.Mesh(glowRingGeometry, glowRingMaterial);
glowRing.rotation.x = Math.PI / 2;
glowRing.position.y = -1.45;
standGroup.add(glowRing);

// soft contact shadow blob cast onto the stand by the floating globe
const shadowGeometry = new THREE.CircleGeometry(1.1, 48);
const shadowMaterial = new THREE.MeshBasicMaterial({
  color: 0x6b4a36,
  transparent: true,
  opacity: 0.18,
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
  toggleButton.textContent = spinning ? '⏸ 停止する' : '▶ 回転する';
});

// ---------- animation loop ----------

const clock = new THREE.Clock();

function animate() {
  const t = clock.getElapsedTime();

  if (spinning) {
    globeGroup.rotation.y += 0.0025 * 60 * (1 / 60);
  }

  // gentle magnetic-levitation bob + a touch of tilt
  globeGroup.position.y = GLOBE_FLOAT_Y + Math.sin(t * 1.1) * 0.06;
  globeGroup.rotation.z = Math.sin(t * 0.6) * 0.02;

  cloudMesh.rotation.y += 0.0006;

  const ringPulse = 0.45 + Math.sin(t * 2.2) * 0.1;
  glowRingMaterial.opacity = ringPulse;
  contactShadow.scale.setScalar(1 + Math.sin(t * 1.1) * 0.03);

  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

animate();
