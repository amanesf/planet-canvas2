import * as THREE from 'three';
import { heightAt, displayHeight, SEA_LEVEL } from './terrain';

// deterministic RNG so the scatter looks the same every reload
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ScatterPoint {
  dir: THREE.Vector3;
  height: number;
  kind: 'tree' | 'rock';
}

// A spatial hash over the (small) 3D direction space so the minimum-spacing
// rejection test is ~O(1) per candidate instead of checking against every
// point placed so far — needed once density gets high enough to look like
// an actual forest rather than a handful of scattered toy trees.
class SpatialHash {
  private cellSize: number;
  private cells = new Map<string, THREE.Vector3[]>();

  constructor(cellSize: number) {
    this.cellSize = cellSize;
  }

  private key(x: number, y: number, z: number) {
    const s = this.cellSize;
    return `${Math.floor(x / s)},${Math.floor(y / s)},${Math.floor(z / s)}`;
  }

  hasNeighborWithin(p: THREE.Vector3, minDistSq: number): boolean {
    const s = this.cellSize;
    const cx = Math.floor(p.x / s);
    const cy = Math.floor(p.y / s);
    const cz = Math.floor(p.z / s);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = this.cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!bucket) continue;
          for (const q of bucket) {
            if (p.distanceToSquared(q) < minDistSq) return true;
          }
        }
      }
    }
    return false;
  }

  add(p: THREE.Vector3) {
    const k = this.key(p.x, p.y, p.z);
    let bucket = this.cells.get(k);
    if (!bucket) {
      bucket = [];
      this.cells.set(k, bucket);
    }
    bucket.push(p);
  }
}

// Dense, evenly-ish spread points on the sphere, classified into "tree"
// (gentle mid-elevation land, i.e. forest) or "rock" (higher, rugged
// elevation) — mirroring how the terrain noise itself already separates
// smooth lowlands from rugged peaks.
function scatterPoints(candidateCount: number, minSpacing: number, rand: () => number): ScatterPoint[] {
  const placed: ScatterPoint[] = [];
  const hash = new SpatialHash(minSpacing);
  const minSpacingSq = minSpacing * minSpacing;
  const dir = new THREE.Vector3();

  for (let i = 0; i < candidateCount; i++) {
    const z = rand() * 2 - 1;
    const t = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    dir.set(r * Math.cos(t), z, r * Math.sin(t));

    const height = heightAt(dir);
    if (height < SEA_LEVEL + 0.015) continue; // keep a clear sandy shoreline

    if (hash.hasNeighborWithin(dir, minSpacingSq)) continue;

    // gentle land → forest; once it's climbing into rugged/mountain
    // elevation, switch to rocks instead (trees don't cling to cliffs)
    const kind: ScatterPoint['kind'] = height < SEA_LEVEL + 0.14 ? 'tree' : 'rock';
    const point = dir.clone();
    hash.add(point);
    placed.push({ dir: point, height, kind });
  }

  return placed;
}

const dummy = new THREE.Object3D();
const up = new THREE.Vector3(0, 1, 0);

function orient(position: THREE.Vector3, normal: THREE.Vector3, spin: number, tilt = 0, tiltAxisAngle = 0) {
  dummy.position.copy(position);
  const align = new THREE.Quaternion().setFromUnitVectors(up, normal);
  const spinQ = new THREE.Quaternion().setFromAxisAngle(normal, spin);
  dummy.quaternion.copy(spinQ).multiply(align);
  if (tilt !== 0) {
    const tiltAxis = new THREE.Vector3(Math.cos(tiltAxisAngle), 0, Math.sin(tiltAxisAngle))
      .applyQuaternion(dummy.quaternion)
      .normalize();
    const tiltQ = new THREE.Quaternion().setFromAxisAngle(tiltAxis, tilt);
    dummy.quaternion.premultiply(tiltQ);
  }
}

export function buildVegetation(radius: number, bumpHeight: number): THREE.Group {
  const group = new THREE.Group();
  const rand = mulberry32(20260803);

  // dense enough that forests read as a textured mass from the default
  // view, not as a handful of isolated toy trees only visible up close
  const points = scatterPoints(60000, 0.065, rand);
  const trees = points.filter((p) => p.kind === 'tree');
  const rocks = points.filter((p) => p.kind === 'rock');

  // ---------- trees: short rounded bush clumps, trunk + foliage instanced ----------
  // (a tall pointy cone looked fine from directly above, but at the
  // sphere's silhouette edge — where we're looking almost along the
  // surface — a ring of them stands straight out sideways into a comical
  // "spike wall". Short + rounded keeps the grazing-angle silhouette calm.)

  const TRUNK_H = 0.014;
  const FOLIAGE_R = 0.02;
  const trunkGeometry = new THREE.CylinderGeometry(0.004, 0.006, TRUNK_H, 5);
  trunkGeometry.translate(0, TRUNK_H / 2, 0);
  const foliageGeometry = new THREE.IcosahedronGeometry(FOLIAGE_R, 1);
  foliageGeometry.scale(1, 0.72, 1);
  foliageGeometry.translate(0, TRUNK_H + FOLIAGE_R * 0.55, 0);

  const trunkMaterial = new THREE.MeshStandardMaterial({
    color: '#8a5a3a',
    roughness: 0.95,
    envMapIntensity: 0.1,
  });
  const foliageMaterial = new THREE.MeshStandardMaterial({
    color: '#3f9c4e',
    roughness: 0.9,
    envMapIntensity: 0.1,
  });

  const trunkMesh = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, trees.length);
  const foliageMesh = new THREE.InstancedMesh(foliageGeometry, foliageMaterial, trees.length);
  const foliageColor = new THREE.Color();

  trees.forEach((p, i) => {
    const surfaceRadius = radius + displayHeight(p.height) * bumpHeight;
    const position = p.dir.clone().multiplyScalar(surfaceRadius);
    const scale = 0.6 + rand() * 0.75;
    orient(position, p.dir, rand() * Math.PI * 2);
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    trunkMesh.setMatrixAt(i, dummy.matrix);
    foliageMesh.setMatrixAt(i, dummy.matrix);
    // a little per-tree color variance so a forest doesn't look like one
    // flat-shaded cutout repeated hundreds of times
    foliageColor.setHSL(0.32 + rand() * 0.06, 0.45 + rand() * 0.15, 0.34 + rand() * 0.14);
    foliageMesh.setColorAt(i, foliageColor);
  });
  trunkMesh.instanceMatrix.needsUpdate = true;
  foliageMesh.instanceMatrix.needsUpdate = true;
  if (foliageMesh.instanceColor) foliageMesh.instanceColor.needsUpdate = true;
  group.add(trunkMesh, foliageMesh);

  // ---------- rocks: small faceted low-poly boulders, tumbled at random ----------

  const rockGeometry = new THREE.IcosahedronGeometry(0.038, 0);
  const rockMaterial = new THREE.MeshStandardMaterial({
    color: '#9b9086',
    roughness: 0.95,
    flatShading: true,
    envMapIntensity: 0.1,
  });
  const rockMesh = new THREE.InstancedMesh(rockGeometry, rockMaterial, rocks.length);
  const rockColor = new THREE.Color();

  rocks.forEach((p, i) => {
    const surfaceRadius = radius + displayHeight(p.height) * bumpHeight;
    const position = p.dir.clone().multiplyScalar(surfaceRadius);
    orient(position, p.dir, rand() * Math.PI * 2, (rand() - 0.5) * 0.7, rand() * Math.PI * 2);
    dummy.scale.set(0.7 + rand() * 0.9, 0.6 + rand() * 0.7, 0.7 + rand() * 0.9);
    dummy.updateMatrix();
    rockMesh.setMatrixAt(i, dummy.matrix);
    rockColor.setHSL(0.09 + rand() * 0.03, 0.12 + rand() * 0.08, 0.5 + rand() * 0.15);
    rockMesh.setColorAt(i, rockColor);
  });
  rockMesh.instanceMatrix.needsUpdate = true;
  if (rockMesh.instanceColor) rockMesh.instanceColor.needsUpdate = true;
  group.add(rockMesh);

  // ---------- fake contact shadows ----------
  // Real shadow maps are disabled for mobile GPU stability, but without
  // *any* grounding shade, hundreds of trees/rocks just float on the
  // surface like stickers. A soft blurred dot decal under each instance,
  // flat against the terrain, buys most of the same believability for
  // almost nothing (one extra instanced draw call, no lighting).
  const shadowGeometry = new THREE.PlaneGeometry(1, 1);
  const shadowMaterial = new THREE.MeshBasicMaterial({
    map: buildSoftDotTexture(),
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  });
  const shadowMesh = new THREE.InstancedMesh(shadowGeometry, shadowMaterial, points.length);
  const planeNormal = new THREE.Vector3(0, 0, 1);

  points.forEach((p, i) => {
    const surfaceRadius = radius + displayHeight(p.height) * bumpHeight + 0.0015;
    dummy.position.copy(p.dir).multiplyScalar(surfaceRadius);
    const align = new THREE.Quaternion().setFromUnitVectors(planeNormal, p.dir);
    const spinQ = new THREE.Quaternion().setFromAxisAngle(p.dir, rand() * Math.PI * 2);
    dummy.quaternion.copy(spinQ).multiply(align);
    const size = p.kind === 'tree' ? 0.05 + rand() * 0.02 : 0.07 + rand() * 0.04;
    dummy.scale.setScalar(size);
    dummy.updateMatrix();
    shadowMesh.setMatrixAt(i, dummy.matrix);
  });
  shadowMesh.instanceMatrix.needsUpdate = true;
  group.add(shadowMesh);

  return group;
}

function buildSoftDotTexture(): THREE.CanvasTexture {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(50,34,20,0.6)');
  gradient.addColorStop(0.6, 'rgba(50,34,20,0.3)');
  gradient.addColorStop(1, 'rgba(50,34,20,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  return texture;
}
