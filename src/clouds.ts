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
//
// ---------------------------------------------------------------------
// A "simulator", cheaply
// ---------------------------------------------------------------------
// A real GPGPU weather sim was tried for the ground (plate tectonics) and
// cost a real-device crash for the trouble. Clouds get the same lesson
// applied in miniature instead of skipped: rather than one rigid sky dome
// rotating as a unit, every weather band keeps its own identity —
// latitude-band-appropriate wind speed and direction (the trade
// easterlies/westerlies pattern real weather actually follows), and a slow
// breathing scale standing in for forming/dissipating. Both are just a
// per-band angle and scale recomputed from elapsed time each frame — a few
// hundred cheap instance-matrix updates, no render target, no simulation
// state carried between frames.

export type CloudType = 'cumulus' | 'stratus' | 'cirrus' | 'storm';

interface CloudTypeParams {
  /** min/max arc length in radians */
  arc: [number, number];
  hoverBase: number;
  hoverBulk: number;
  sizeBase: number;
  sizeBulk: number;
  /** extra nodules per step at full bulk */
  clusterBulk: number;
  clusterBase: number;
  /** vertical squash on top of the nodule's own geometry (1 = unchanged) */
  flatten: number;
  haloOpacity: number;
  haloScale: number;
  /** underside shading: lower = darker, storm cells read as heavy with rain */
  undersideFloor: number;
}

const CLOUD_TYPE_PARAMS: Record<CloudType, CloudTypeParams> = {
  cumulus: {
    arc: [0.3, 0.64],
    hoverBase: 0.16,
    hoverBulk: 0.11,
    sizeBase: 0.036,
    sizeBulk: 0.058,
    clusterBulk: 2.0,
    clusterBase: 1,
    flatten: 1,
    haloOpacity: 0.13,
    haloScale: 1.32,
    undersideFloor: 0.52,
  },
  // A flat, low, wide overcast sheet — few tall lumps, lots of shallow
  // wide ones packed close together so the gaps between nodules close up
  // into one hazy layer instead of reading as a string of puffs.
  stratus: {
    arc: [0.55, 0.95],
    hoverBase: 0.09,
    hoverBulk: 0.03,
    sizeBase: 0.05,
    sizeBulk: 0.02,
    clusterBulk: 1.1,
    clusterBase: 2,
    flatten: 0.45,
    haloOpacity: 0.16,
    haloScale: 1.5,
    undersideFloor: 0.62,
  },
  // Thin, sparse, high wisps — the opposite instinct from every other
  // type: fewer nodules, not more, each one small and stretched long
  // along the band so it reads as combed rather than piled.
  cirrus: {
    arc: [0.75, 1.25],
    hoverBase: 0.34,
    hoverBulk: 0.06,
    sizeBase: 0.018,
    sizeBulk: 0.014,
    clusterBulk: 0.4,
    clusterBase: 0,
    flatten: 0.32,
    haloOpacity: 0.06,
    haloScale: 1.6,
    undersideFloor: 0.78,
  },
  // Tall and dense with a dark, heavy underside — a cumulonimbus cell,
  // the only type that gets its own material (see buildClouds) so it can
  // flicker with lightning independently of the calm weather around it.
  storm: {
    arc: [0.22, 0.4],
    hoverBase: 0.14,
    hoverBulk: 0.2,
    sizeBase: 0.05,
    sizeBulk: 0.09,
    clusterBulk: 2.6,
    clusterBase: 1,
    flatten: 1.15,
    haloOpacity: 0.1,
    haloScale: 1.24,
    undersideFloor: 0.22,
  },
};

interface Nodule {
  /** unit direction on the sphere, before this frame's band rotation */
  dir: THREE.Vector3;
  /** how far above the globe surface this nodule floats */
  hover: number;
  /** world-space radius of the nodule */
  size: number;
  /** rotation about the local normal */
  spin: number;
  /** which weather band this nodule belongs to, for independent drift */
  band: number;
}

/**
 * One cloud: a chain of nodules walked along a great-circle arc, thick in
 * the middle and tapering to wisps at both ends.
 */
function buildCloudBand(
  start: THREE.Vector3,
  band: number,
  params: CloudTypeParams,
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
  const arc = params.arc[0] + rand() * (params.arc[1] - params.arc[0]);
  const steps = 14 + Math.floor(rand() * 10);
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
    const clusterSize = params.clusterBase + Math.floor(bulk * params.clusterBulk + rand() * 1.0);
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
        hover: params.hoverBase + bulk * params.hoverBulk + rand() * 0.05,
        size: (params.sizeBase + bulk * params.sizeBulk) * (0.55 + rand() * 0.8),
        spin: rand() * Math.PI * 2,
        band,
      });
    }
  }
}

/** A single lumpy nodule — the unit the whole sky is built from. */
function buildNoduleGeometry(rand: () => number, flatten: number, undersideFloor: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 8, 6);
  displaceWithNoise(g, 0.34, 3.2, rand() * 500);
  g.scale(1, 0.72 * flatten, 1); // batting settles wider than it is tall
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
  const span = 1 - undersideFloor;
  for (let i = 0; i < position.count; i++) {
    // -1 at the underside, +1 at the crown
    const t = THREE.MathUtils.clamp(position.getY(i) / (0.72 * flatten), -1, 1);
    const shade = undersideFloor + (t * 0.5 + 0.5) * span;
    colors[i * 3] = shade;
    colors[i * 3 + 1] = shade;
    // the shaded underside of white cotton goes cool, not just dark
    colors[i * 3 + 2] = Math.min(1, shade * 1.04);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

// Real prevailing winds reverse direction by latitude band (trade
// easterlies near the equator, westerlies in the temperate belt, polar
// easterlies again near the poles) — a cheap, geography-appropriate stand-
// in for the "evaporation + rain shadow" atmospheric simulation the
// original design memo wanted but that this project's plate-tectonics
// scare ruled out running for real. latY is the band seed's own dir.y.
function windAngularVelocity(latY: number): number {
  const abs = Math.abs(latY);
  if (abs < 0.35) return -0.024; // tropical easterlies
  if (abs < 0.75) return 0.017; // mid-latitude westerlies
  return -0.01; // polar easterlies
}

export interface CloudSystem {
  group: THREE.Group;
  tick: (t: number) => void;
}

export function buildClouds(radius: number): CloudSystem {
  const group = new THREE.Group();
  const rand = mulberry32(4242);

  // where the weather systems sit
  //
  // Was cut to 6 chasing a crash that turned out to be shadow mapping,
  // not scene weight (see SETTINGS/shadowMap.enabled in main.ts) —
  // restored most of the way back now that shadows are off there.
  const seeds: { dir: THREE.Vector3; type: CloudType }[] = [];
  const dir = new THREE.Vector3();
  for (let i = 0; i < 4000 && seeds.length < 10; i++) {
    const z = rand() * 2 - 1;
    const t = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    dir.set(r * Math.cos(t), z, r * Math.sin(t));
    if (cloudDensityAt(dir) < 0.16) continue; // only inside a weather patch
    if (seeds.some((s) => s.dir.dot(dir) > 0.68)) continue; // keep the bands apart

    // Type follows latitude, loosely, the way real weather does: storm
    // cells cluster in the tropics, thin cirrus favours higher latitude,
    // stratus sheets sit over the temperate belt, cumulus fills the rest.
    const lat = Math.abs(dir.y);
    let type: CloudType;
    const roll = rand();
    if (lat < 0.3) type = roll < 0.4 ? 'storm' : 'cumulus';
    else if (lat < 0.65) type = roll < 0.35 ? 'stratus' : 'cumulus';
    else type = roll < 0.45 ? 'cirrus' : 'stratus';

    seeds.push({ dir: dir.clone(), type });
  }

  const nodules: Nodule[] = [];
  const bandType: CloudType[] = [];
  seeds.forEach((seed, band) => {
    bandType.push(seed.type);
    buildCloudBand(seed.dir, band, CLOUD_TYPE_PARAMS[seed.type], rand, nodules);
  });
  const bandVelocity = seeds.map((s) => windAngularVelocity(s.dir.y));
  // each band breathes (grows/shrinks) on its own slow cycle, standing in
  // for forming and dissipating without ever changing instance counts
  const bandBreathPhase = seeds.map(() => rand() * Math.PI * 2);
  const bandBreathSpeed = seeds.map(() => 0.06 + rand() * 0.05);

  const regularVariantCount = 3;
  const regularVariants = Array.from({ length: regularVariantCount }, () =>
    buildNoduleGeometry(rand, 1, CLOUD_TYPE_PARAMS.cumulus.undersideFloor),
  );
  const stratusGeometry = buildNoduleGeometry(rand, CLOUD_TYPE_PARAMS.stratus.flatten, CLOUD_TYPE_PARAMS.stratus.undersideFloor);
  const cirrusGeometry = buildNoduleGeometry(rand, CLOUD_TYPE_PARAMS.cirrus.flatten, CLOUD_TYPE_PARAMS.cirrus.undersideFloor);

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

  const cirrusHaloMaterial = haloMaterial.clone();
  cirrusHaloMaterial.opacity = CLOUD_TYPE_PARAMS.cirrus.haloOpacity;

  const dummy = new THREE.Object3D();
  const up = new THREE.Vector3(0, 1, 0);
  const rotated = new THREE.Vector3();

  // Every InstancedMesh built below is re-driven live in tick(): each
  // nodule keeps its original (pre-drift) dir and remembers which band it
  // belongs to, and every frame that band's own wind angle + breathing
  // scale is applied when recomposing its matrix. A few hundred instances
  // recomposed this way costs nothing next to a single rigid rotation, and
  // it is what turns nine static weather patches into ones that visibly
  // drift apart and swell/shrink independently — a simulated *look*
  // without an actual simulation running underneath.
  interface LiveMesh {
    mesh: THREE.InstancedMesh;
    list: Nodule[];
    sizeScale: number;
  }
  const liveMeshes: LiveMesh[] = [];

  const buildLayer = (
    list: Nodule[],
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    sizeScale: number,
    castShadow: boolean,
  ): THREE.InstancedMesh | null => {
    if (list.length === 0) return null;
    const mesh = new THREE.InstancedMesh(geometry, material, list.length);
    mesh.castShadow = castShadow;
    liveMeshes.push({ mesh, list, sizeScale });
    group.add(mesh);
    return mesh;
  };

  // ---- regular types (cumulus/stratus/cirrus), pooled by geometry so the
  // draw-call count stays flat no matter how many weather bands exist ----
  const regularByVariant: Nodule[][] = Array.from({ length: regularVariantCount }, () => []);
  const stratusNodules: Nodule[] = [];
  const cirrusNodules: Nodule[] = [];
  const stormNodulesByBand = new Map<number, Nodule[]>();

  nodules.forEach((n) => {
    const type = bandType[n.band];
    if (type === 'storm') {
      const list = stormNodulesByBand.get(n.band) ?? [];
      list.push(n);
      stormNodulesByBand.set(n.band, list);
    } else if (type === 'stratus') {
      stratusNodules.push(n);
    } else if (type === 'cirrus') {
      cirrusNodules.push(n);
    } else {
      regularByVariant[n.band % regularVariantCount].push(n);
    }
  });

  regularByVariant.forEach((list, vi) => {
    buildLayer(list, regularVariants[vi], coreMaterial, 1, true);
    buildLayer(list, regularVariants[vi], haloMaterial, CLOUD_TYPE_PARAMS.cumulus.haloScale, false);
  });
  buildLayer(stratusNodules, stratusGeometry, coreMaterial, 1, true);
  buildLayer(stratusNodules, stratusGeometry, haloMaterial, CLOUD_TYPE_PARAMS.stratus.haloScale, false);
  buildLayer(cirrusNodules, cirrusGeometry, coreMaterial, 1, false);
  buildLayer(cirrusNodules, cirrusGeometry, cirrusHaloMaterial, CLOUD_TYPE_PARAMS.cirrus.haloScale, false);

  // ---- storm cells: each band gets its own material so lightning can
  // flicker one storm without lighting up every cloud on the planet ----
  interface StormBand {
    band: number;
    coreMaterial: THREE.MeshStandardMaterial;
    nextFlashAt: number;
    flashUntil: number;
  }
  const stormBands: StormBand[] = [];
  stormNodulesByBand.forEach((list, band) => {
    const stormCore = coreMaterial.clone();
    stormCore.emissiveIntensity = 0.08;
    buildLayer(list, regularVariants[band % regularVariantCount], stormCore, 1, true);
    buildLayer(list, regularVariants[band % regularVariantCount], haloMaterial, CLOUD_TYPE_PARAMS.storm.haloScale, false);
    stormBands.push({ band, coreMaterial: stormCore, nextFlashAt: 2 + rand() * 6, flashUntil: 0 });
  });

  const tick = (t: number) => {
    liveMeshes.forEach(({ mesh, list, sizeScale }) => {
      list.forEach((n, i) => {
        const angle = t * bandVelocity[n.band];
        rotated.copy(n.dir).applyAxisAngle(up, angle);
        const breath = 1 + Math.sin(t * bandBreathSpeed[n.band] + bandBreathPhase[n.band]) * 0.09;

        dummy.position.copy(rotated).multiplyScalar(radius + n.hover);
        const align = new THREE.Quaternion().setFromUnitVectors(up, rotated);
        const spin = new THREE.Quaternion().setFromAxisAngle(rotated, n.spin);
        dummy.quaternion.copy(spin).multiply(align);
        const s = n.size * sizeScale * breath;
        dummy.scale.set(s, s * 0.8, s);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
    });

    // Lightning: an occasional brief emissive spike on one storm band's own
    // material, nothing else touched. Scheduled per-band so storms flash
    // independently rather than in unison.
    stormBands.forEach((s) => {
      if (t >= s.nextFlashAt) {
        // start a new flash now; schedule the one after it
        s.flashUntil = t + 0.09 + rand() * 0.06;
        s.nextFlashAt = s.flashUntil + 3 + rand() * 9;
      }
      if (t < s.flashUntil) {
        // a quick double-pulse reads as lightning; a single flat spike reads
        // as the material just changing color
        const flicker = Math.sin((s.flashUntil - t) * 90) > 0 ? 1 : 0.35;
        s.coreMaterial.emissiveIntensity = 1.4 * flicker;
      } else {
        s.coreMaterial.emissiveIntensity = 0.08;
      }
    });
  };

  return { group, tick };
}
