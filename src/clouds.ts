import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { fbm3 } from './noise';
import { heightAt, displayHeight } from './terrain';
import { jitterGeometry, SpatialHash, mulberry32 } from './spatialHash';
import { orientShadowDecal } from './shadow';

// Low-frequency "weather system" noise — clouds cluster into patches
// instead of scattering uniformly, like real cloud cover does.
function cloudDensityAt(dir: THREE.Vector3): number {
  return fbm3(dir.x * 1.1 + 150, dir.y * 1.1 + 150, dir.z * 1.1 + 150, 2);
}

// A cute puffy "cumulus" shape: a handful of overlapping low-poly spheres
// merged into one piece of geometry, so hundreds of clouds still cost only
// one instanced draw call each variant.
function buildPuffGeometry(rand: () => number): THREE.BufferGeometry {
  const lumps = 5 + Math.floor(rand() * 3);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < lumps; i++) {
    const r = 0.4 + rand() * 0.55;
    const g = new THREE.SphereGeometry(r, 8, 6);
    // heavier jitter + a non-uniform stretch per lobe — real cotton
    // batting is torn and wispy, not a cluster of smooth round balloons
    jitterGeometry(g, 0.32, rand);
    g.scale(0.7 + rand() * 0.7, 0.55 + rand() * 0.5, 0.7 + rand() * 0.7);
    g.translate((rand() - 0.5) * 1.6, (rand() - 0.5) * 0.4, (rand() - 0.5) * 0.75);
    parts.push(g);
  }
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
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
    roughness: 0.95,
    transparent: true,
    opacity: 0.88,
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
      const scale = 0.11 + rand() * 0.09;
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
