import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { fbm3 } from './noise';

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
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

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

scene.add(new THREE.AmbientLight(0xfff1e0, 0.4));

const keyLight = new THREE.DirectionalLight(0xfff6e6, 1.7);
keyLight.position.set(4, 5, 3);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
scene.add(keyLight);

const rimLight = new THREE.DirectionalLight(0xbfe0ff, 0.5);
rimLight.position.set(-4, 2, -3);
scene.add(rimLight);

// ---------- globe: displaced sphere, pastel "clay" colors ----------

const globeGroup = new THREE.Group();
globeGroup.position.set(0, GLOBE_FLOAT_Y, 0);
scene.add(globeGroup);

const geometry = new THREE.IcosahedronGeometry(RADIUS, 44);
const positionAttr = geometry.attributes.position;
const colors = new Float32Array(positionAttr.count * 3);

const deepColor = new THREE.Color('#3fb6e0'); // saturated sea
const shoreColor = new THREE.Color('#ffe58a'); // warm sand
const landColor = new THREE.Color('#6bcf5a'); // vivid meadow
const peakColor = new THREE.Color('#ff8fc2'); // candy-pink peak

const tmp = new THREE.Vector3();
for (let i = 0; i < positionAttr.count; i++) {
  tmp.fromBufferAttribute(positionAttr, i).normalize();

  // higher frequency so bumps read as continents/mountains, not a
  // whole-sphere ovoid distortion (that's what was making it look like
  // a potato) — the low-frequency term is now just a mild base wobble
  const n =
    fbm3(tmp.x * 2.4, tmp.y * 2.4, tmp.z * 2.4, 4) * 0.65 +
    fbm3(tmp.x * 5 + 9.2, tmp.y * 5 + 9.2, tmp.z * 5 + 9.2, 3) * 0.25 +
    fbm3(tmp.x * 1.1 + 3.7, tmp.y * 1.1 + 3.7, tmp.z * 1.1 + 3.7, 2) * 0.1;

  const height = Math.max(n, -0.2); // flatten deep ocean floor a bit

  // sea level sits well above the noise midpoint so oceans dominate,
  // and the coastline itself is a near-hard cutoff (a real map doesn't
  // fade gradually from water to sand over a wide band)
  const SEA_LEVEL = 0.16;
  const COAST_WIDTH = 0.012;

  // water is a flat shell — only land pokes up above sea level, so the
  // ocean doesn't visibly inherit the terrain noise as bumpy waves
  const displayHeight = height < SEA_LEVEL ? SEA_LEVEL - 0.02 : height;
  const displaced = tmp.clone().multiplyScalar(RADIUS + displayHeight * BUMP_HEIGHT);
  positionAttr.setXYZ(i, displaced.x, displaced.y, displaced.z);

  const c = new THREE.Color();
  if (height < SEA_LEVEL - COAST_WIDTH) {
    c.copy(deepColor);
  } else if (height < SEA_LEVEL + COAST_WIDTH) {
    c.copy(deepColor).lerp(shoreColor, (height - (SEA_LEVEL - COAST_WIDTH)) / (COAST_WIDTH * 2));
  } else if (height < SEA_LEVEL + 0.08) {
    c.copy(shoreColor).lerp(landColor, (height - SEA_LEVEL) / 0.08);
  } else {
    c.copy(landColor).lerp(peakColor, Math.min((height - (SEA_LEVEL + 0.08)) / 0.25, 1));
  }
  colors[i * 3] = c.r;
  colors[i * 3 + 1] = c.g;
  colors[i * 3 + 2] = c.b;
}
geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
geometry.computeVertexNormals();

const globeMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.65,
  metalness: 0.02,
  flatShading: false,
});

const globeMesh = new THREE.Mesh(geometry, globeMaterial);
globeMesh.castShadow = true;
globeMesh.receiveShadow = true;
globeGroup.add(globeMesh);

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
  roughness: 0.55,
  metalness: 0.15,
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
