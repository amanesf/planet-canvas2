import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  aridityAt,
  badlandsAt,
  BADLANDS_THRESHOLD,
  DESERT_ARIDITY_THRESHOLD,
  displayHeight,
  heightAt,
  SEA_LEVEL,
  temperatureAt,
  terracedElevation,
} from './terrain';
import { displaceWithNoise, SpatialHash, mulberry32 } from './spatialHash';
import { orientShadowDecal } from './shadow';

type Kind = 'tree' | 'rock' | 'dune' | 'desertRock';

// Below this aridity: lush enough for a real forest canopy mass (handled
// by scatterForest, not individual trees). Between this and the desert
// threshold: savanna — sparse, individually-visible trees are correct
// there, not a mistake to "fix" with more density.
const FOREST_ARIDITY_MAX = 0.44;

// Below this temperature it's tundra/ice country — too cold for forest,
// savanna, or desert dressing; those zones stay bare (the paint itself
// already reads as tundra/ice, see terrain.ts's biomeColor).
const COLD_TEMPERATURE_LIMIT = 0.09;

interface ScatterPoint {
  dir: THREE.Vector3;
  height: number;
  kind: Kind;
}

// Dense, evenly-ish spread points on the sphere, classified by both
// elevation and aridity — mirroring how the terrain paint itself already
// separates smooth lowlands / rugged peaks / dry patches. Every biome
// should get its look from actual objects sitting on the ground (grass,
// dunes, rocks), not from what color the terrain is painted underneath.
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

    const elevation = terracedElevation(height);
    let kind: Kind;
    if (elevation < 0.15) {
      if (temperatureAt(dir, elevation) < COLD_TEMPERATURE_LIMIT) continue; // tundra/ice — stays bare
      if (badlandsAt(dir) > BADLANDS_THRESHOLD) continue; // bare exposed rock — no trees
      const aridity = aridityAt(dir);
      if (aridity > DESERT_ARIDITY_THRESHOLD) continue; // handled by the denser scatterDesert pass
      if (aridity <= FOREST_ARIDITY_MAX) continue; // lush forest zone — covered by the canopy pass instead
      kind = 'tree'; // savanna: sparse, individually-visible trees
    } else {
      // climbing into rugged/mountain elevation — big accent boulders here;
      // ground-covering scree/rubble is handled by the denser scatterScree pass
      kind = 'rock';
    }

    const point = dir.clone();
    hash.add(point);
    placed.push({ dir: point, height, kind });
  }

  return placed;
}

// Ground-covering grass tufts — much denser and tinier than trees/rocks.
// The green shouldn't come from painting the terrain green; it should
// come from the ground actually being covered in vegetation, the way a
// real diorama uses flocking/foliage clusters over a plain dirt-colored
// base instead of a green-painted surface. Skips desert patches, which
// get dunes/dry rock instead.
interface GrassPoint {
  dir: THREE.Vector3;
  height: number;
}

function scatterGrass(candidateCount: number, minSpacing: number, rand: () => number): GrassPoint[] {
  const placed: GrassPoint[] = [];
  const hash = new SpatialHash(minSpacing);
  const minSpacingSq = minSpacing * minSpacing;
  const dir = new THREE.Vector3();

  for (let i = 0; i < candidateCount; i++) {
    const z = rand() * 2 - 1;
    const t = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    dir.set(r * Math.cos(t), z, r * Math.sin(t));

    const height = heightAt(dir);
    if (height < SEA_LEVEL + 0.012) continue; // keep the shoreline clear
    const elevation = terracedElevation(height);
    if (elevation > 0.16) continue; // grass, not alpine scrub
    if (temperatureAt(dir, elevation) < COLD_TEMPERATURE_LIMIT) continue; // tundra/ice — stays bare
    if (badlandsAt(dir) > BADLANDS_THRESHOLD) continue; // bare exposed rock — no grass
    const aridity = aridityAt(dir);
    if (aridity > DESERT_ARIDITY_THRESHOLD) continue; // no grass in the desert
    if (aridity <= FOREST_ARIDITY_MAX) continue; // forest floor is covered by canopy instead

    if (hash.hasNeighborWithin(dir, minSpacingSq)) continue;

    const point = dir.clone();
    hash.add(point);
    placed.push({ dir: point, height });
  }

  return placed;
}

// Forest as one continuous, overlapping canopy mass instead of individual
// spaced-out trees — a real forest reads as a bumpy green blanket covering
// the ground, not as separated toy-tree cutouts with gaps between them.
// Placement is dense and spacing is intentionally *smaller* than each
// clump's own footprint, so neighboring clumps overlap and merge visually.
interface ForestPoint {
  dir: THREE.Vector3;
  height: number;
}

function scatterForest(candidateCount: number, minSpacing: number, rand: () => number): ForestPoint[] {
  const placed: ForestPoint[] = [];
  const hash = new SpatialHash(minSpacing);
  const minSpacingSq = minSpacing * minSpacing;
  const dir = new THREE.Vector3();

  for (let i = 0; i < candidateCount; i++) {
    const z = rand() * 2 - 1;
    const t = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    dir.set(r * Math.cos(t), z, r * Math.sin(t));

    const height = heightAt(dir);
    if (height < SEA_LEVEL + 0.02) continue; // clear shoreline
    const elevation = terracedElevation(height);
    if (elevation > 0.15) continue; // canopy stays off the rocky slopes
    if (temperatureAt(dir, elevation) < COLD_TEMPERATURE_LIMIT) continue; // too cold for forest — taiga/tundra instead
    if (badlandsAt(dir) > BADLANDS_THRESHOLD) continue; // bare exposed rock — no canopy
    if (aridityAt(dir) > FOREST_ARIDITY_MAX) continue; // savanna/desert get their own treatment

    if (hash.hasNeighborWithin(dir, minSpacingSq)) continue;

    const point = dir.clone();
    hash.add(point);
    placed.push({ dir: point, height });
  }

  return placed;
}

// Dense dune-field coverage — a real desert is a sea of sand shapes, not
// a few sparse mounds scattered on empty painted ground.
interface DesertPoint {
  dir: THREE.Vector3;
  height: number;
  kind: 'dune' | 'desertRock';
}

function scatterDesert(candidateCount: number, minSpacing: number, rand: () => number): DesertPoint[] {
  const placed: DesertPoint[] = [];
  const hash = new SpatialHash(minSpacing);
  const minSpacingSq = minSpacing * minSpacing;
  const dir = new THREE.Vector3();

  for (let i = 0; i < candidateCount; i++) {
    const z = rand() * 2 - 1;
    const t = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    dir.set(r * Math.cos(t), z, r * Math.sin(t));

    const height = heightAt(dir);
    if (height < SEA_LEVEL + 0.015) continue;
    const elevation = terracedElevation(height);
    if (elevation > 0.15) continue;
    if (temperatureAt(dir, elevation) < COLD_TEMPERATURE_LIMIT) continue; // cold + dry is tundra, not a sand desert
    if (badlandsAt(dir) > BADLANDS_THRESHOLD) continue; // badlands gets rock banding, not sand dunes
    if (aridityAt(dir) <= DESERT_ARIDITY_THRESHOLD) continue;

    if (hash.hasNeighborWithin(dir, minSpacingSq)) continue;

    const point = dir.clone();
    hash.add(point);
    placed.push({ dir: point, height, kind: rand() < 0.7 ? 'dune' : 'desertRock' });
  }

  return placed;
}

// Dense loose scree/rubble covering rocky mountain slopes, on top of the
// sparser big accent boulders — a bare-painted rock terrace looks like a
// video-game collision mesh; a slope covered in broken rock fragments
// looks like an actual mountain.
interface ScreePoint {
  dir: THREE.Vector3;
  height: number;
}

function scatterScree(candidateCount: number, minSpacing: number, rand: () => number): ScreePoint[] {
  const placed: ScreePoint[] = [];
  const hash = new SpatialHash(minSpacing);
  const minSpacingSq = minSpacing * minSpacing;
  const dir = new THREE.Vector3();

  for (let i = 0; i < candidateCount; i++) {
    const z = rand() * 2 - 1;
    const t = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    dir.set(r * Math.cos(t), z, r * Math.sin(t));

    const height = heightAt(dir);
    if (terracedElevation(height) < 0.15) continue; // rocky slopes only

    if (hash.hasNeighborWithin(dir, minSpacingSq)) continue;

    const point = dir.clone();
    hash.add(point);
    placed.push({ dir: point, height });
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

  // this pass covers savanna trees, mountain rocks, and desert dressing —
  // real forest canopy is handled separately below as a dense connected
  // mass, not as individually-spaced trees, so savanna can stay properly
  // sparse without looking like "not enough trees yet"
  const points = scatterPoints(60000, 0.09, rand);
  const trees = points.filter((p) => p.kind === 'tree');
  const rocks = points.filter((p) => p.kind === 'rock');

  // dense dedicated passes — a sparse handful of dunes/rocks read as
  // "a few objects on empty ground", not "a desert" or "a mountainside"
  const desertPoints = scatterDesert(70000, 0.045, rand);
  const dunes = desertPoints.filter((p) => p.kind === 'dune');
  const desertRocks = desertPoints.filter((p) => p.kind === 'desertRock');
  const screePoints = scatterScree(70000, 0.03, rand);

  // ---------- trees: 3 archetypes mixed by pseudo-climate + chance ----------
  // (a tall pointy cone looked fine from directly above, but at the
  // sphere's silhouette edge — where we're looking almost along the
  // surface — a ring of them stands straight out sideways into a comical
  // "spike wall". Short + rounded keeps the grazing-angle silhouette calm.)
  // Repeating one single tree/rock shape everywhere reads as "one game
  // asset instanced a lot"; a real diorama artist mixes several kit
  // pieces. dir.y stands in for latitude (poles → conifers), with some
  // random mixing so it isn't a hard band.

  const TRUNK_H = 0.014;

  const bushGeometry = new THREE.IcosahedronGeometry(0.02, 1);
  bushGeometry.scale(1, 0.72, 1);
  bushGeometry.translate(0, TRUNK_H + 0.02 * 0.55, 0);

  const coniferGeometry = new THREE.ConeGeometry(0.016, 0.05, 6);
  coniferGeometry.translate(0, TRUNK_H + 0.05 / 2 - 0.008, 0);

  const clumpGeometry = mergeGeometries(
    [
      (() => {
        const g = new THREE.IcosahedronGeometry(0.015, 1);
        g.translate(-0.011, TRUNK_H + 0.013, 0.004);
        return g;
      })(),
      (() => {
        const g = new THREE.IcosahedronGeometry(0.017, 1);
        g.translate(0.01, TRUNK_H + 0.016, -0.006);
        return g;
      })(),
    ],
    false,
  );

  const trunkGeometry = new THREE.CylinderGeometry(0.004, 0.006, TRUNK_H, 5);
  trunkGeometry.translate(0, TRUNK_H / 2, 0);

  const trunkMaterial = new THREE.MeshStandardMaterial({
    color: '#8a5a3a',
    roughness: 0.95,
    envMapIntensity: 0.1,
  });
  // left white on purpose — instanceColor below multiplies against this,
  // so a tinted base color here would compound with (and mute/darken) the
  // per-instance hue instead of showing it cleanly
  const foliageMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.9,
    envMapIntensity: 0.1,
  });

  // real diorama foliage ("clump foliage" flock/lichen material) is a
  // distinctly bright, saturated yellow-green — noticeably more lime than
  // an ordinary tree green, and part of what makes a miniature's
  // vegetation read as a real physical material instead of rendered grass
  const treeVariants: { geometry: THREE.BufferGeometry; hue: [number, number] }[] = [
    { geometry: bushGeometry, hue: [0.235, 0.045] },
    { geometry: coniferGeometry, hue: [0.28, 0.025] },
    { geometry: clumpGeometry, hue: [0.225, 0.04] },
  ];
  const treeByVariant: ScatterPoint[][] = treeVariants.map(() => []);
  trees.forEach((p) => {
    const coolness = Math.abs(p.dir.y); // stand-in for latitude
    let variant = rand() < 0.35 ? 2 : 0; // base mix: bush or clump
    if (rand() < coolness * 0.8 + 0.05) variant = 1; // conifers lean polar
    treeByVariant[variant].push(p);
  });

  const trunkMesh = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, trees.length);
  let trunkIndex = 0;
  // NOTE on the `THREE.SRGBColorSpace` argument passed to every setHSL
  // below: three's working color space is linear-sRGB, so setHSL's default
  // treats the lightness/saturation you give it as *linear* values. A
  // "0.4 lightness green" then displays at roughly sRGB 0.66 — which is
  // exactly how the foliage ended up as glowing neon lime. Naming sRGB
  // explicitly makes the numbers mean what they look like in a color picker.
  const foliageColor = new THREE.Color();

  treeVariants.forEach((variant, vi) => {
    const pts = treeByVariant[vi];
    if (pts.length === 0) return;
    const foliageMesh = new THREE.InstancedMesh(variant.geometry, foliageMaterial, pts.length);
    pts.forEach((p, i) => {
      const surfaceRadius = radius + displayHeight(p.height, p.dir) * bumpHeight;
      const position = p.dir.clone().multiplyScalar(surfaceRadius);
      const scale = 0.6 + rand() * 0.75;
      orient(position, p.dir, rand() * Math.PI * 2);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      trunkMesh.setMatrixAt(trunkIndex++, dummy.matrix);
      foliageMesh.setMatrixAt(i, dummy.matrix);
      // a little per-tree color variance so a forest doesn't look like one
      // flat-shaded cutout repeated hundreds of times
      foliageColor.setHSL(variant.hue[0] + rand() * variant.hue[1], 0.42 + rand() * 0.14, 0.26 + rand() * 0.12, THREE.SRGBColorSpace);
      foliageMesh.setColorAt(i, foliageColor);
    });
    foliageMesh.instanceMatrix.needsUpdate = true;
    if (foliageMesh.instanceColor) foliageMesh.instanceColor.needsUpdate = true;
    group.add(foliageMesh);
  });
  trunkMesh.instanceMatrix.needsUpdate = true;
  group.add(trunkMesh);

  // ---------- rocks: 2 archetypes — angular boulders + flatter slabs ----------

  const boulderGeometry = new THREE.IcosahedronGeometry(0.038, 0);
  const slabGeometry = new THREE.IcosahedronGeometry(0.04, 0);
  slabGeometry.scale(1.3, 0.45, 1.1);

  const rockMaterial = new THREE.MeshStandardMaterial({
    color: '#9b9086',
    roughness: 0.95,
    flatShading: true,
    envMapIntensity: 0.1,
  });

  const rockVariants = [boulderGeometry, slabGeometry];
  const rockByVariant: ScatterPoint[][] = rockVariants.map(() => []);
  rocks.forEach((p) => rockByVariant[rand() < 0.4 ? 1 : 0].push(p));
  const rockColor = new THREE.Color();

  rockVariants.forEach((geo, vi) => {
    const pts = rockByVariant[vi];
    if (pts.length === 0) return;
    const rockMesh = new THREE.InstancedMesh(geo, rockMaterial, pts.length);
    pts.forEach((p, i) => {
      const surfaceRadius = radius + displayHeight(p.height, p.dir) * bumpHeight;
      const position = p.dir.clone().multiplyScalar(surfaceRadius);
      orient(position, p.dir, rand() * Math.PI * 2, (rand() - 0.5) * 0.7, rand() * Math.PI * 2);
      dummy.scale.set(0.7 + rand() * 0.9, 0.6 + rand() * 0.7, 0.7 + rand() * 0.9);
      dummy.updateMatrix();
      rockMesh.setMatrixAt(i, dummy.matrix);
      rockColor.setHSL(0.09 + rand() * 0.03, 0.12 + rand() * 0.08, 0.5 + rand() * 0.15, THREE.SRGBColorSpace);
      rockMesh.setColorAt(i, rockColor);
    });
    rockMesh.instanceMatrix.needsUpdate = true;
    if (rockMesh.instanceColor) rockMesh.instanceColor.needsUpdate = true;
    group.add(rockMesh);
  });

  // ---------- desert: dune mounds + sun-bleached dry rock ----------

  const duneGeometry = new THREE.IcosahedronGeometry(0.032, 1);
  duneGeometry.scale(1.8, 0.28, 1.15);
  const duneMaterial = new THREE.MeshStandardMaterial({
    color: '#d9bb7c',
    roughness: 0.92,
    envMapIntensity: 0.1,
  });
  const duneMesh = new THREE.InstancedMesh(duneGeometry, duneMaterial, dunes.length);
  const duneColor = new THREE.Color();
  dunes.forEach((p, i) => {
    const surfaceRadius = radius + displayHeight(p.height, p.dir) * bumpHeight;
    const position = p.dir.clone().multiplyScalar(surfaceRadius);
    orient(position, p.dir, rand() * Math.PI * 2);
    dummy.scale.set(0.6 + rand() * 1.1, 0.5 + rand() * 0.7, 0.6 + rand() * 1.1);
    dummy.updateMatrix();
    duneMesh.setMatrixAt(i, dummy.matrix);
    duneColor.setHSL(0.11 + rand() * 0.02, 0.4 + rand() * 0.15, 0.62 + rand() * 0.1, THREE.SRGBColorSpace);
    duneMesh.setColorAt(i, duneColor);
  });
  duneMesh.instanceMatrix.needsUpdate = true;
  if (duneMesh.instanceColor) duneMesh.instanceColor.needsUpdate = true;
  group.add(duneMesh);

  const desertRockGeometry = new THREE.IcosahedronGeometry(0.034, 0);
  const desertRockMaterial = new THREE.MeshStandardMaterial({
    color: '#c7a877',
    roughness: 0.95,
    flatShading: true,
    envMapIntensity: 0.1,
  });
  const desertRockMesh = new THREE.InstancedMesh(desertRockGeometry, desertRockMaterial, desertRocks.length);
  const desertRockColor = new THREE.Color();
  desertRocks.forEach((p, i) => {
    const surfaceRadius = radius + displayHeight(p.height, p.dir) * bumpHeight;
    const position = p.dir.clone().multiplyScalar(surfaceRadius);
    orient(position, p.dir, rand() * Math.PI * 2, (rand() - 0.5) * 0.6, rand() * Math.PI * 2);
    dummy.scale.set(0.6 + rand() * 0.8, 0.55 + rand() * 0.6, 0.6 + rand() * 0.8);
    dummy.updateMatrix();
    desertRockMesh.setMatrixAt(i, dummy.matrix);
    desertRockColor.setHSL(0.1 + rand() * 0.02, 0.3 + rand() * 0.1, 0.55 + rand() * 0.12, THREE.SRGBColorSpace);
    desertRockMesh.setColorAt(i, desertRockColor);
  });
  desertRockMesh.instanceMatrix.needsUpdate = true;
  if (desertRockMesh.instanceColor) desertRockMesh.instanceColor.needsUpdate = true;
  group.add(desertRockMesh);

  // ---------- scree: dense loose rubble covering rocky/mountain slopes ----------

  const screeGeometry = new THREE.IcosahedronGeometry(0.016, 0);
  const screeMaterial = new THREE.MeshStandardMaterial({
    color: '#847a6c',
    roughness: 0.97,
    flatShading: true,
    envMapIntensity: 0.08,
  });
  const screeMesh = new THREE.InstancedMesh(screeGeometry, screeMaterial, screePoints.length);
  const screeColor = new THREE.Color();
  screePoints.forEach((p, i) => {
    const surfaceRadius = radius + displayHeight(p.height, p.dir) * bumpHeight;
    const position = p.dir.clone().multiplyScalar(surfaceRadius);
    orient(position, p.dir, rand() * Math.PI * 2, (rand() - 0.5) * 0.5, rand() * Math.PI * 2);
    dummy.scale.set(0.6 + rand() * 1.0, 0.5 + rand() * 0.7, 0.6 + rand() * 1.0);
    dummy.updateMatrix();
    screeMesh.setMatrixAt(i, dummy.matrix);
    screeColor.setHSL(0.08 + rand() * 0.03, 0.14 + rand() * 0.08, 0.42 + rand() * 0.18, THREE.SRGBColorSpace);
    screeMesh.setColorAt(i, screeColor);
  });
  screeMesh.instanceMatrix.needsUpdate = true;
  if (screeMesh.instanceColor) screeMesh.instanceColor.needsUpdate = true;
  group.add(screeMesh);

  // ---------- forest: big rock-clinging clumps, not a solid blanket ----------
  // A real diorama's foliage clumps are substantial individual masses
  // with visible bare rock between and around them — packing tons of tiny
  // clumps edge-to-edge (the previous approach) just reads as a uniform
  // green speckle/stipple hiding the rock entirely, not as clumped
  // vegetation. Bigger clumps + wider spacing gets both: still a "mass"
  // per clump (each one is several overlapping lobes), but the ground
  // shows through between them the way it does in a real miniature.

  const forestPoints = scatterForest(38000, 0.11, rand);
  const canopyVariantCount = 3;
  const canopyVariants = Array.from({ length: canopyVariantCount }, () => buildCanopyBlob(rand));
  const canopyMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.92,
    envMapIntensity: 0.1,
  });
  const canopyByVariant: ForestPoint[][] = Array.from({ length: canopyVariantCount }, () => []);
  forestPoints.forEach((p, i) => canopyByVariant[i % canopyVariantCount].push(p));
  const canopyColor = new THREE.Color();

  canopyByVariant.forEach((pts, vi) => {
    if (pts.length === 0) return;
    const mesh = new THREE.InstancedMesh(canopyVariants[vi], canopyMaterial, pts.length);
    pts.forEach((p, i) => {
      const surfaceRadius = radius + displayHeight(p.height, p.dir) * bumpHeight;
      const position = p.dir.clone().multiplyScalar(surfaceRadius);
      orient(position, p.dir, rand() * Math.PI * 2);
      const scale = 1.35 + rand() * 1.1;
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      // wide lightness spread (not just hue jitter) so neighboring clumps
      // read as light/shadow variation across the canopy, not one flat
      // uniform green — real clump foliage isn't evenly lit all over
      canopyColor.setHSL(0.235 + rand() * 0.05, 0.42 + rand() * 0.16, 0.24 + rand() * 0.15, THREE.SRGBColorSpace);
      mesh.setColorAt(i, canopyColor);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    group.add(mesh);
  });

  // ---------- grass: dense tiny tufts covering the (non-desert) ground ----------

  const grassPoints = scatterGrass(220000, 0.024, rand);
  const grassGeometry = new THREE.ConeGeometry(0.008, 0.016, 5);
  grassGeometry.translate(0, 0.008, 0);
  const grassMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.9,
    envMapIntensity: 0.08,
  });
  const grassMesh = new THREE.InstancedMesh(grassGeometry, grassMaterial, grassPoints.length);
  const grassColor = new THREE.Color();
  grassPoints.forEach((p, i) => {
    const surfaceRadius = radius + displayHeight(p.height, p.dir) * bumpHeight;
    const position = p.dir.clone().multiplyScalar(surfaceRadius);
    orient(position, p.dir, rand() * Math.PI * 2);
    dummy.scale.set(0.7 + rand() * 0.9, 0.5 + rand() * 1.0, 0.7 + rand() * 0.9);
    dummy.updateMatrix();
    grassMesh.setMatrixAt(i, dummy.matrix);
    grassColor.setHSL(0.245 + rand() * 0.05, 0.4 + rand() * 0.14, 0.3 + rand() * 0.1, THREE.SRGBColorSpace);
    grassMesh.setColorAt(i, grassColor);
  });
  grassMesh.instanceMatrix.needsUpdate = true;
  if (grassMesh.instanceColor) grassMesh.instanceColor.needsUpdate = true;
  group.add(grassMesh);

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
  const shadowPoints: (ScatterPoint | DesertPoint)[] = [...points, ...desertPoints];
  const shadowMesh = new THREE.InstancedMesh(shadowGeometry, shadowMaterial, shadowPoints.length);

  shadowPoints.forEach((p, i) => {
    const surfaceRadius = radius + displayHeight(p.height, p.dir) * bumpHeight + 0.0015;
    const basePosition = p.dir.clone().multiplyScalar(surfaceRadius);
    const size =
      p.kind === 'tree'
        ? 0.05 + rand() * 0.02
        : p.kind === 'dune'
          ? 0.09 + rand() * 0.05
          : 0.07 + rand() * 0.04;
    orientShadowDecal(dummy, basePosition, p.dir, size, 1.5, rand() * Math.PI * 2);
    dummy.updateMatrix();
    shadowMesh.setMatrixAt(i, dummy.matrix);
  });
  shadowMesh.instanceMatrix.needsUpdate = true;
  group.add(shadowMesh);

  return group;
}

// A poofy, "mokomoko" canopy clump — several overlapping rounded lobes
// merged into one piece of geometry (same trick as the cloud puffs), so
// hundreds of forest clumps still cost only a few instanced draw calls.
// A big, substantial clump — several overlapping lobes with coherent
// fractal surface detail (see displaceWithNoise) at two scales instead of
// independently-randomized per-vertex jitter, which only ever reads as a
// faceted potato at this poly count. Sized to be a real visible mass on
// its own (bare rock shows between clumps at the scatter level, see
// buildVegetation), not a tiny piece of a wall-to-wall speckle blanket.
function buildCanopyBlob(rand: () => number): THREE.BufferGeometry {
  const lobes = 4 + Math.floor(rand() * 3);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < lobes; i++) {
    const r = 0.05 + rand() * 0.038;
    const g = new THREE.IcosahedronGeometry(r, 2);
    displaceWithNoise(g, 0.32, 3.2, rand() * 500);
    displaceWithNoise(g, 0.14, 9, rand() * 500 + 300);
    g.computeVertexNormals();
    g.translate((rand() - 0.5) * 0.13, rand() * 0.035, (rand() - 0.5) * 0.13);
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
  gradient.addColorStop(0, 'rgba(50,34,20,0.6)');
  gradient.addColorStop(0.6, 'rgba(50,34,20,0.3)');
  gradient.addColorStop(1, 'rgba(50,34,20,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  return texture;
}
