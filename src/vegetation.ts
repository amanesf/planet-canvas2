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

// Sparse, evenly-ish spread points on the sphere, classified into
// "tree" (gentle mid-elevation land, i.e. forest) or "rock" (higher,
// rugged elevation) — mirroring how the terrain noise itself already
// separates smooth lowlands from rugged peaks.
function scatterPoints(candidateCount: number, minSpacing: number, rand: () => number): ScatterPoint[] {
  const placed: ScatterPoint[] = [];
  const minSpacingSq = minSpacing * minSpacing;
  const dir = new THREE.Vector3();

  for (let i = 0; i < candidateCount; i++) {
    const z = rand() * 2 - 1;
    const t = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    dir.set(r * Math.cos(t), z, r * Math.sin(t));

    const height = heightAt(dir);
    if (height < SEA_LEVEL + 0.015) continue; // keep a clear sandy shoreline

    let tooClose = false;
    for (let j = 0; j < placed.length; j++) {
      if (dir.distanceToSquared(placed[j].dir) < minSpacingSq) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    // gentle land → forest; once it's climbing into rugged/mountain
    // elevation, switch to rocks instead (trees don't cling to cliffs)
    const kind: ScatterPoint['kind'] = height < SEA_LEVEL + 0.14 ? 'tree' : 'rock';
    placed.push({ dir: dir.clone(), height, kind });
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

  const points = scatterPoints(3200, 0.15, rand);
  const trees = points.filter((p) => p.kind === 'tree');
  const rocks = points.filter((p) => p.kind === 'rock');

  // ---------- trees: simple low-poly pines, trunk + foliage instanced ----------
  // (kept tiny relative to the globe — the first pass made these look like
  // giant spikes/thorns rather than a forest texture)

  const TRUNK_H = 0.02;
  const FOLIAGE_H = 0.045;
  const trunkGeometry = new THREE.CylinderGeometry(0.003, 0.0045, TRUNK_H, 5);
  trunkGeometry.translate(0, TRUNK_H / 2, 0);
  const foliageGeometry = new THREE.ConeGeometry(0.014, FOLIAGE_H, 6);
  foliageGeometry.translate(0, TRUNK_H + FOLIAGE_H / 2 - 0.006, 0);

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
    const scale = 0.65 + rand() * 0.6;
    orient(position, p.dir, rand() * Math.PI * 2);
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    trunkMesh.setMatrixAt(i, dummy.matrix);
    foliageMesh.setMatrixAt(i, dummy.matrix);
    // a little per-tree color variance so a forest doesn't look like one
    // flat-shaded cutout repeated hundreds of times
    foliageColor.setHSL(0.32 + rand() * 0.06, 0.45 + rand() * 0.15, 0.38 + rand() * 0.12);
    foliageMesh.setColorAt(i, foliageColor);
  });
  trunkMesh.instanceMatrix.needsUpdate = true;
  foliageMesh.instanceMatrix.needsUpdate = true;
  if (foliageMesh.instanceColor) foliageMesh.instanceColor.needsUpdate = true;
  group.add(trunkMesh, foliageMesh);

  // ---------- rocks: small faceted low-poly boulders, tumbled at random ----------

  const rockGeometry = new THREE.IcosahedronGeometry(0.026, 0);
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

  return group;
}
