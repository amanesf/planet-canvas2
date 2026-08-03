import * as THREE from 'three';
import { fbm3 } from './noise';
import { displaceWithNoise, mulberry32 } from './spatialHash';

// Low-frequency "weather system" noise — clouds cluster into patches
// instead of scattering uniformly, like real cloud cover does.
function cloudDensityAt(dir: THREE.Vector3): number {
  return fbm3(dir.x * 1.1 + 150, dir.y * 1.1 + 150, dir.z * 1.1 + 150, 2);
}

// ---------------------------------------------------------------------
// Cotton laid on a sphere
// ---------------------------------------------------------------------
// Two things about the reference photograph's clouds matter more than any
// amount of surface detail, and every previous attempt here got both wrong.
//
// First, they are not discrete objects sitting on the globe. They are a
// wad of batting *pulled apart and laid along the surface*, so each one is
// a long, low band that follows the curvature — several times wider than
// it is thick, trailing off at both ends. Building a cloud as one rigid
// mesh cannot do that: a mesh wide enough to read as a band is flat, so it
// either sinks into the globe in the middle or lifts off it at the ends.
// Building the band out of many small nodules, each placed individually on
// the sphere, wraps for free.
//
// Second, real cotton is *translucent at its edges*. Light passes through
// the thin fringe, so the outline glows rather than ending at a hard lit
// silhouette. That is reproduced here with two layers over the same
// positions: an opaque core, and a larger, much fainter halo that
// surrounds it. The halo is what makes the outline soft — the core alone
// reads as painted polystyrene however lumpy it is.

interface Nodule {
  /** unit direction on the sphere */
  dir: THREE.Vector3;
  /** how far above the globe surface this nodule floats */
  hover: number;
  /** world-space radius of the nodule */
  size: number;
  /** rotation about the local normal */
  spin: number;
}

/**
 * One cloud: a chain of nodules walked along a great-circle arc, thick in
 * the middle and tapering to wisps at both ends.
 */
function buildCloudBand(
  start: THREE.Vector3,
  rand: () => number,
  out: Nodule[],
): void {
  // a tangent direction to walk along, and a second tangent to spread across
  const along = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5)
    .addScaledVector(start, -start.dot(new THREE.Vector3()))
    .normalize();
  // re-orthogonalize properly against the surface normal
  along.addScaledVector(start, -along.dot(start)).normalize();
  const across = new THREE.Vector3().crossVectors(start, along).normalize();

  // Arc length in radians. On a two-unit globe, half a radian is a band
  // spanning about a quarter of the visible face — which is the scale the
  // reference's cloud masses actually sit at, and several times bigger
  // than the popcorn puffs this replaced.
  const arc = 0.3 + rand() * 0.34;
  const steps = 16 + Math.floor(rand() * 12);
  // how far the band wanders off a clean great circle, so it isn't a ruler line
  const wander = (rand() - 0.5) * 0.5;

  const point = new THREE.Vector3();
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // 0 at both ends, 1 in the middle: drives thickness, count and height
    const bulk = Math.sin(t * Math.PI);

    const angle = (t - 0.5) * arc;
    const drift = Math.sin(t * Math.PI * 1.3 + wander * 6) * wander;

    point
      .copy(start)
      .multiplyScalar(Math.cos(angle))
      .addScaledVector(along, Math.sin(angle))
      .addScaledVector(across, drift * 0.35)
      .normalize();

    // more nodules where the band is thickest; the tapering ends thin out
    // to one or two, which is what reads as a wisp
    const clusterSize = 1 + Math.floor(bulk * 2.4 + rand() * 1.2);
    for (let c = 0; c < clusterSize; c++) {
      const lateral = (rand() - 0.5) * (0.06 + bulk * 0.13);
      const forward = (rand() - 0.5) * 0.05;
      const dir = point
        .clone()
        .addScaledVector(across, lateral)
        .addScaledVector(along, forward)
        .normalize();

      out.push({
        dir,
        // Standing clear of the surface rather than lying on it: pinned
        // this tightly they read as frost on the shell, and the gap is what
        // lets their shadows land on the terrain where you can see them.
        hover: 0.16 + bulk * 0.11 + rand() * 0.05,
        size: (0.036 + bulk * 0.058) * (0.55 + rand() * 0.8),
        spin: rand() * Math.PI * 2,
      });
    }
  }
}

/** A single lumpy nodule — the unit the whole sky is built from. */
function buildNoduleGeometry(rand: () => number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 8, 6);
  displaceWithNoise(g, 0.34, 3.2, rand() * 500);
  g.scale(1, 0.72, 1); // batting settles wider than it is tall
  g.computeVertexNormals();

  // Self-shadowing, baked in. Every nodule is lit as an isolated ball, so a
  // cloud came out as a heap of separately-lit spheres with nothing darker
  // where they meet — which is what makes a mass of them read flat however
  // lumpy the outline is. Real batting is bright on top and progressively
  // dimmer underneath, because the material above it is in the way. A
  // vertical gradient in the vertex colours reproduces that for nothing per
  // frame, and it does the job the shadow map cannot at this scale.
  const position = g.attributes.position;
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    // -1 at the underside, +1 at the crown
    const t = THREE.MathUtils.clamp(position.getY(i) / 0.72, -1, 1);
    const shade = 0.52 + (t * 0.5 + 0.5) * 0.55;
    colors[i * 3] = shade;
    colors[i * 3 + 1] = shade;
    // the shaded underside of white cotton goes cool, not just dark
    colors[i * 3 + 2] = Math.min(1, shade * 1.04);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

export function buildClouds(radius: number): THREE.Group {
  const group = new THREE.Group();
  const rand = mulberry32(4242);

  // where the weather systems sit
  const seeds: THREE.Vector3[] = [];
  const dir = new THREE.Vector3();
  for (let i = 0; i < 4000 && seeds.length < 10; i++) {
    const z = rand() * 2 - 1;
    const t = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    dir.set(r * Math.cos(t), z, r * Math.sin(t));
    if (cloudDensityAt(dir) < 0.16) continue; // only inside a weather patch
    if (seeds.some((s) => s.dot(dir) > 0.68)) continue; // keep the bands apart
    seeds.push(dir.clone());
  }

  const nodules: Nodule[] = [];
  seeds.forEach((seed) => buildCloudBand(seed, rand, nodules));

  const variantCount = 3;
  const variants = Array.from({ length: variantCount }, () => buildNoduleGeometry(rand));

  const coreMaterial = new THREE.MeshStandardMaterial({
    color: '#f2f0ee',
    vertexColors: true, // baked top-lit / underside-shaded gradient, above
    roughness: 0.96, // matte fibre, not the sheen of a moulded surface
    // Cotton scatters light through itself, so its thin edges glow instead
    // of falling off to grey. A small constant emissive stands in for that
    // subsurface term at no per-frame cost.
    emissive: '#ffffff',
    emissiveIntensity: 0.08,
    envMapIntensity: 0.15,
  });

  // The fringe. Bigger, far fainter, writing no depth so the layers blend
  // into each other instead of cutting each other out — this is the layer
  // that turns a lumpy white solid into something that looks like it has
  // air in it.
  const haloMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 1,
    vertexColors: true,
    emissive: '#ffffff',
    emissiveIntensity: 0.14,
    transparent: true,
    // At 1.85x and this opacity the halo lumps were large enough to be read
    // individually: where several overlapped, their alpha built up into a
    // visible polygon boundary — a pale box around the cloud rather than a
    // soft fringe. Closer to the core and fainter, it does the job it was
    // added for without announcing itself.
    opacity: 0.13,
    depthWrite: false,
    envMapIntensity: 0.1,
  });

  const dummy = new THREE.Object3D();
  const up = new THREE.Vector3(0, 1, 0);

  const place = (
    material: THREE.Material,
    sizeScale: number,
    castShadow: boolean,
  ): THREE.Group => {
    const layer = new THREE.Group();
    const perVariant: Nodule[][] = Array.from({ length: variantCount }, () => []);
    nodules.forEach((n, i) => perVariant[i % variantCount].push(n));

    perVariant.forEach((list, vi) => {
      if (list.length === 0) return;
      const mesh = new THREE.InstancedMesh(variants[vi], material, list.length);
      list.forEach((n, i) => {
        dummy.position.copy(n.dir).multiplyScalar(radius + n.hover);
        const align = new THREE.Quaternion().setFromUnitVectors(up, n.dir);
        const spin = new THREE.Quaternion().setFromAxisAngle(n.dir, n.spin);
        dummy.quaternion.copy(spin).multiply(align);
        const s = n.size * sizeScale;
        dummy.scale.set(s, s * 0.8, s);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = castShadow;
      layer.add(mesh);
    });
    return layer;
  };

  // only the core casts: a shadow from the translucent fringe would be as
  // dark as one from the solid middle, which is not how looking through
  // cotton works
  group.add(place(coreMaterial, 1, true));
  group.add(place(haloMaterial, 1.32, false));

  return group;
}
