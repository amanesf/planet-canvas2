import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { fbm3 } from './noise';
import { heightAt, displayHeight } from './terrain';
import { displaceWithNoise, SpatialHash, mulberry32 } from './spatialHash';
import { orientShadowDecal } from './shadow';

// Low-frequency "weather system" noise — clouds cluster into patches
// instead of scattering uniformly, like real cloud cover does.
function cloudDensityAt(dir: THREE.Vector3): number {
  return fbm3(dir.x * 1.1 + 150, dir.y * 1.1 + 150, dir.z * 1.1 + 150, 2);
}

// A handful of thin, stretched slivers stabbed outward from random points
// near a lobe's surface — this is what actually breaks a round silhouette
// into something that reads as torn/frayed cotton rather than a smooth
// balloon; no amount of surface bumpiness alone fixes a perfectly round
// outline, because silhouette shape is the strongest cue the eye uses.
function addWisps(parts: THREE.BufferGeometry[], center: THREE.Vector3, baseRadius: number, count: number, rand: () => number) {
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < count; i++) {
    const dir = new THREE.Vector3(rand() - 0.5, (rand() - 0.5) * 0.6, rand() - 0.5).normalize();
    const length = baseRadius * (0.6 + rand() * 1.1);
    const wisp = new THREE.ConeGeometry(baseRadius * (0.1 + rand() * 0.12), length, 5, 1);
    wisp.translate(0, length / 2, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(up, dir);
    wisp.applyQuaternion(q);
    const originOffset = baseRadius * (0.55 + rand() * 0.35);
    wisp.translate(
      center.x + dir.x * originOffset,
      center.y + dir.y * originOffset,
      center.z + dir.z * originOffset,
    );
    parts.push(wisp);
  }
}

// Bakes a simple top-lit/underside-shadowed gradient directly into the
// geometry's vertex colors — real cotton batting is visibly brighter on
// top and dimmer/cooler in its own self-shadowed underside, which reads
// as volume even under otherwise flat lighting. Baked once at build time,
// so it costs nothing per frame.
function bakeVerticalShading(geometry: THREE.BufferGeometry) {
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox!;
  const minY = bbox.min.y;
  const maxY = bbox.max.y;
  const span = Math.max(maxY - minY, 1e-6);
  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const t = THREE.MathUtils.clamp((position.getY(i) - minY) / span, 0, 1);
    const shade = 0.66 + t * 0.4;
    colors[i * 3] = shade;
    colors[i * 3 + 1] = shade;
    colors[i * 3 + 2] = Math.min(1, shade + 0.02); // faint cool tint in the shadowed underside
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// A puffy "cumulus"/cotton-batting shape: several overlapping lobes with
// coherent fractal surface detail at two scales, a scatter of thin frayed
// wisps breaking up the silhouette, and baked top-lit vertex shading —
// merged into one piece of geometry so hundreds of clouds still cost only
// one instanced draw call per variant.
function buildPuffGeometry(rand: () => number): THREE.BufferGeometry {
  const lumps = 5 + Math.floor(rand() * 3);
  const parts: THREE.BufferGeometry[] = [];
  const lobeCenters: { center: THREE.Vector3; radius: number }[] = [];

  for (let i = 0; i < lumps; i++) {
    const r = 0.4 + rand() * 0.55;
    const g = new THREE.SphereGeometry(r, 14, 10);
    displaceWithNoise(g, 0.4, 2.6, rand() * 500);
    displaceWithNoise(g, 0.16, 8.5, rand() * 500 + 200);
    g.scale(0.7 + rand() * 0.7, 0.55 + rand() * 0.5, 0.7 + rand() * 0.7);
    const center = new THREE.Vector3((rand() - 0.5) * 1.6, (rand() - 0.5) * 0.4, (rand() - 0.5) * 0.75);
    g.translate(center.x, center.y, center.z);
    g.computeVertexNormals();
    parts.push(g);
    lobeCenters.push({ center, radius: r });
  }

  // frayed wisps scattered across a couple of the lobes, not every one —
  // real torn cotton has some denser core lumps and some wispier edges
  const wispyLobes = lobeCenters.filter(() => rand() < 0.6);
  wispyLobes.forEach(({ center, radius }) => {
    addWisps(parts, center, radius, 2 + Math.floor(rand() * 3), rand);
  });

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  bakeVerticalShading(merged);
  return merged;
}

function buildSoftDotTexture(): THREE.CanvasTexture {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(40,40,50,0.35)');
  gradient.addColorStop(0.6, 'rgba(40,40,50,0.18)');
  gradient.addColorStop(1, 'rgba(40,40,50,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

// Fluffy 3D cloud puffs hovering above the terrain, each casting a soft
// shadow blob onto the ground below — matching the original design memo's
// "evaporation + rain shadow" sky layer with an actual visible presence,
// instead of the flat translucent shell this globe started with.
export function buildClouds(radius: number, bumpHeight: number): THREE.Group {
  const group = new THREE.Group();
  const rand = mulberry32(4242);

  const hash = new SpatialHash(0.4);
  const minSpacingSq = 0.4 * 0.4;
  const points: THREE.Vector3[] = [];
  const dir = new THREE.Vector3();

  for (let i = 0; i < 6000 && points.length < 70; i++) {
    const z = rand() * 2 - 1;
    const t = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    dir.set(r * Math.cos(t), z, r * Math.sin(t));

    if (cloudDensityAt(dir) < 0.22) continue; // only inside a "weather patch"
    if (hash.hasNeighborWithin(dir, minSpacingSq)) continue;

    const p = dir.clone();
    hash.add(p);
    points.push(p);
  }

  const variantCount = 3;
  const variants = Array.from({ length: variantCount }, () => buildPuffGeometry(rand));
  const cloudMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    vertexColors: true, // baked top-lit/underside-shadow gradient, see bakeVerticalShading
    roughness: 0.88, // a little sheen — real cotton fiber catches a soft highlight, unlike matte rock
    transparent: true,
    opacity: 0.9,
    envMapIntensity: 0.15,
  });

  const perVariant: THREE.Vector3[][] = Array.from({ length: variantCount }, () => []);
  points.forEach((p, i) => perVariant[i % variantCount].push(p));

  const dummy = new THREE.Object3D();
  const up = new THREE.Vector3(0, 1, 0);

  perVariant.forEach((pts, vi) => {
    if (pts.length === 0) return;
    const mesh = new THREE.InstancedMesh(variants[vi], cloudMaterial, pts.length);
    pts.forEach((p, i) => {
      const hoverRadius = radius + 0.3 + rand() * 0.22;
      dummy.position.copy(p).multiplyScalar(hoverRadius);
      const align = new THREE.Quaternion().setFromUnitVectors(up, p);
      const spin = new THREE.Quaternion().setFromAxisAngle(p, rand() * Math.PI * 2);
      dummy.quaternion.copy(spin).multiply(align);
      const scale = 0.15 + rand() * 0.12;
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
  });

  // soft shadow blob cast onto the actual terrain surface below each cloud
  const shadowGeometry = new THREE.PlaneGeometry(1, 1);
  const shadowMaterial = new THREE.MeshBasicMaterial({
    map: buildSoftDotTexture(),
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
  });
  const shadowMesh = new THREE.InstancedMesh(shadowGeometry, shadowMaterial, points.length);

  points.forEach((p, i) => {
    const groundRadius = radius + displayHeight(heightAt(p), p) * bumpHeight + 0.003;
    const basePosition = p.clone().multiplyScalar(groundRadius);
    const size = 0.3 + rand() * 0.22;
    orientShadowDecal(dummy, basePosition, p, size, 1.3, rand() * Math.PI * 2);
    dummy.updateMatrix();
    shadowMesh.setMatrixAt(i, dummy.matrix);
  });
  shadowMesh.instanceMatrix.needsUpdate = true;
  group.add(shadowMesh);

  return group;
}
