import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { fbm3 } from './noise';
import { displaceWithNoise, SpatialHash, mulberry32 } from './spatialHash';

// Low-frequency "weather system" noise — clouds cluster into patches
// instead of scattering uniformly, like real cloud cover does.
function cloudDensityAt(dir: THREE.Vector3): number {
  return fbm3(dir.x * 1.1 + 150, dir.y * 1.1 + 150, dir.z * 1.1 + 150, 2);
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
    const shade = 0.4 + t * 0.6;
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
  // A puff's silhouette is the only thing carrying "cotton" at this size,
  // and there are two ways to get it wrong. A few large smooth spheres give
  // a clean closed outline that reads as moulded plastic. Modelling actual
  // fibres fails for the opposite reason: a strand thin enough to be
  // convincing is well under a pixel wide here, so it does not blur into
  // fuzz the way a real one does — it aliases into a hard white needle, and
  // the puff ends up looking like a burr.
  //
  // What survives at this scale is the *lump structure*: teased batting is
  // a cluster of small nodules of widely varying size, dense in the middle
  // and loose at the edges. Many small lobes give a bumpy, cauliflower-like
  // outline that reads as cotton without a single sub-pixel detail in it.
  const parts: THREE.BufferGeometry[] = [];
  const nodules = 16 + Math.floor(rand() * 10);

  for (let i = 0; i < nodules; i++) {
    // small lobes crowd the fringe, big ones anchor the core, so the mass
    // has a dense middle and a ragged edge rather than uniform bubbles
    const t = rand();
    const r = 0.16 + t * t * 0.5;
    const g = new THREE.SphereGeometry(r, 8, 6);
    displaceWithNoise(g, 0.32, 3.4, rand() * 500);
    g.scale(0.9 + rand() * 0.35, 0.75 + rand() * 0.3, 0.9 + rand() * 0.35);
    // placed further out the smaller they are — the loose fringe nodules
    const spread = 0.35 + (1 - t) * 0.75;
    const dir = new THREE.Vector3(rand() - 0.5, (rand() - 0.5) * 0.5, rand() - 0.5).normalize();
    g.translate(dir.x * spread, dir.y * spread * 0.7, dir.z * spread * 0.85);
    g.computeVertexNormals();
    parts.push(g);
  }

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  bakeVerticalShading(merged);
  return merged;
}


// Fluffy 3D cloud puffs hovering above the terrain, each casting a soft
// shadow blob onto the ground below — matching the original design memo's
// "evaporation + rain shadow" sky layer with an actual visible presence,
// instead of the flat translucent shell this globe started with.
export function buildClouds(radius: number): THREE.Group {
  const group = new THREE.Group();
  const rand = mulberry32(4242);

  const hash = new SpatialHash(0.44);
  const minSpacingSq = 0.44 * 0.44;
  const points: THREE.Vector3[] = [];
  const dir = new THREE.Vector3();

  for (let i = 0; i < 6000 && points.length < 58; i++) {
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
    color: '#d6d4d3',
    vertexColors: true, // baked top-lit/underside-shadow gradient, see bakeVerticalShading
    roughness: 0.95, // matte fibre, not the soft sheen of a moulded surface
    // Cotton scatters light through itself, so a thin edge of it glows
    // rather than going dark the way an opaque edge does. A small constant
    // emissive stands in for that subsurface term cheaply, and it is what
    // stops the fibre fringe from reading as dirty grey against the sky.
    emissive: '#ffffff',
    emissiveIntensity: 0.09,
    transparent: true,
    opacity: 0.92,
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
      const hoverRadius = radius + 0.08 + rand() * 0.16;
      dummy.position.copy(p).multiplyScalar(hoverRadius);
      const align = new THREE.Quaternion().setFromUnitVectors(up, p);
      const spin = new THREE.Quaternion().setFromAxisAngle(p, rand() * Math.PI * 2);
      dummy.quaternion.copy(spin).multiply(align);
      const scale = 0.2 + rand() * 0.12;
      // real cotton-batting clouds laid on a globe spread sideways and stay
      // shallow; a uniform scale gives spherical popcorn balls instead
      dummy.scale.set(scale * 1.15, scale * 0.95, scale * 1.05);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
  });

  // (cloud shadows are real cast shadows now — see the key light's shadow
  // camera in main.ts. A decal projected straight down could never land in
  // the right place anyway, since the light rakes in from the side.)

  return group;
}
