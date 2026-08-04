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

export type CloudType = 'cumulus' | 'stratus' | 'cirrus' | 'storm' | 'typhoon';

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
  // A tropical cyclone. Not laid along a band like every other type — its
  // nodules are placed in spiral coordinates around a moving centre (see
  // buildTyphoon) — so `arc` is unused here; the rest of the numbers are
  // what the eyewall's cotton is made of: dense, tall, dark underneath.
  typhoon: {
    arc: [0, 0],
    hoverBase: 0.13,
    hoverBulk: 0.16,
    sizeBase: 0.026,
    sizeBulk: 0.034,
    clusterBulk: 0,
    clusterBase: 1,
    flatten: 0.8,
    haloOpacity: 0.12,
    haloScale: 1.3,
    undersideFloor: 0.3,
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
  /** latitude/longitude at t = 0, in radians; the wind works on these */
  lat: number;
  lon: number;
  /** how far above the globe surface this nodule floats */
  hover: number;
  /** world-space radius of the nodule */
  size: number;
  /** rotation about the local normal */
  spin: number;
  /** which weather band this nodule belongs to, for independent drift */
  band: number;
  /**
   * Set only on tropical cyclone nodules: polar coordinates in the storm's
   * own frame (angular distance from the eye, and bearing) rather than a
   * fixed place on the globe, because the whole system both spins and
   * travels. See buildTyphoon.
   */
  spiral?: { radius: number; theta: number };
  /** where this nodule is *this frame*, filled in by tick */
  live: THREE.Vector3;
  /** and how big it is this frame (breathing, storm intensity) */
  liveScale: number;
}

function makeNodule(dir: THREE.Vector3, rest: Omit<Nodule, 'lat' | 'lon' | 'live' | 'liveScale'>): Nodule {
  return { ...rest, lat: latOf(dir), lon: lonOf(dir), live: dir.clone(), liveScale: 1 };
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

      out.push(makeNodule(dir, {
        // Standing clear of the surface rather than lying on it: pinned
        // this tightly they read as frost on the shell, and the gap is what
        // lets their shadows land on the terrain where you can see them.
        hover: params.hoverBase + bulk * params.hoverBulk + rand() * 0.05,
        size: (params.sizeBase + bulk * params.sizeBulk) * (0.55 + rand() * 0.8),
        spin: rand() * Math.PI * 2,
        band,
      }));
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

// ---------------------------------------------------------------------
// Wind
// ---------------------------------------------------------------------
// The direction was already right — trade easterlies in the tropics,
// westerlies in the temperate belt, polar easterlies again at the top —
// but three things about how it was applied gave the game away as soon as
// you watched it for more than a few seconds.
//
// 1. Three constants with hard steps between them. A cloud at 20° and one
//    at 21° moved at exactly the same speed; one at 39° and one at 41°
//    moved in opposite directions at full speed with nothing in between.
//    Real prevailing winds go through zero at the doldrums (0°), the horse
//    latitudes (~30°) and the polar front (~60°), and peak halfway between
//    — so the profile here is a sine that does exactly that, and the belts
//    fade into each other the way the actual circulation cells do.
//
// 2. One speed for the whole band, taken from the seed's latitude. That
//    makes a cloud mass a rigid object sliding across the globe. Wind
//    shear — the fact that the poleward edge of a cloud moves at a
//    different speed from the equatorward edge — is *the* thing that makes
//    real cloud fields look alive: bands stretch, tilt and comb out as
//    they travel. Every nodule now takes its wind from its own latitude,
//    which costs nothing extra and gives that for free.
//
// 3. Rotation about the globe's axis at a constant *angular* rate, which
//    means a cloud near the pole covers ground as fast as one at the
//    equator. Wind is a linear speed; angular speed is that divided by
//    cos(latitude), so the same wind whips a polar cloud around its much
//    smaller circle of latitude far faster. That conversion is here now.
//
// On top of the zonal flow, mid-latitude clouds ride a slow meander —
// the Rossby waves that make a real jet stream snake north and south
// rather than run around a parallel like a drawn line. It is strongest
// where the westerlies are and dies away toward the equator and the pole.

/** Peak wind speed, in radians of great circle per second. */
const WIND_SCALE = 0.02;

/**
 * Eastward wind speed at a latitude, in radians of great circle per second.
 * Negative is an easterly (blowing toward the west).
 */
function zonalWind(lat: number): number {
  const deg = Math.abs(lat) * (180 / Math.PI);
  if (deg < 30) return -0.85 * WIND_SCALE * Math.sin((Math.PI * deg) / 30); // trades
  if (deg < 60) return 1.35 * WIND_SCALE * Math.sin((Math.PI * (deg - 30)) / 30); // westerlies
  return -0.6 * WIND_SCALE * Math.sin((Math.PI * (deg - 60)) / 30); // polar easterlies
}

/** The same wind expressed as a rate of change of longitude. */
function zonalOmega(lat: number): number {
  // clamped so the 1/cos does not run away to infinity at the pole itself
  return zonalWind(lat) / Math.max(Math.cos(lat), 0.22);
}

/** How far this latitude's flow meanders north/south, in radians. */
function meanderAmplitude(lat: number): number {
  const deg = Math.abs(lat) * (180 / Math.PI);
  if (deg < 20 || deg > 75) return 0;
  return 0.085 * Math.sin((Math.PI * (deg - 20)) / 55);
}

const HALF_PI = Math.PI / 2;

function latOf(dir: THREE.Vector3): number {
  return Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
}

// Longitude increases *eastward*, matching terrain.ts's latLonToDir (which
// puts the prime meridian at the elevation image's horizontal centre) —
// otherwise every wind on this planet would blow the wrong way relative to
// the continents painted underneath them.
function lonOf(dir: THREE.Vector3): number {
  return Math.atan2(dir.z, -dir.x);
}

function dirFromLatLon(lat: number, lon: number, out: THREE.Vector3): THREE.Vector3 {
  const c = Math.cos(lat);
  return out.set(-c * Math.cos(lon), Math.sin(lat), c * Math.sin(lon));
}

// ---------------------------------------------------------------------
// Tropical cyclones
// ---------------------------------------------------------------------
// The one weather system on the planet that is a *shape* rather than a
// patch: banded spiral arms wound around a clear eye, the whole thing
// rotating cyclonically while its centre travels. None of that survives
// being built the way the other cloud types are (nodules pinned to fixed
// points on the globe), so a typhoon's nodules keep polar coordinates in
// the storm's own frame instead, and their place on the globe is resolved
// every frame from wherever the eye currently is.
//
// The track is the textbook one, because the textbook one is what people
// recognise: form in the tropics, run west-northwest with the trades,
// then recurve poleward and back east once the storm reaches the
// westerlies — and weaken to nothing at both ends of its life, so the
// planet is not permanently carrying the same hurricane around.
interface TyphoonSystem {
  band: number;
  /** longitude the track starts at, radians */
  lon0: number;
  /** +1 northern hemisphere, -1 southern */
  hemi: number;
  /** seconds for one form → recurve → dissipate cycle, and where in it we start */
  period: number;
  phase: number;
  /** angular radius of the eye, and of the outermost arm */
  eye: number;
  reach: number;
  spin: number;
  /** 0..1, recomputed each frame from the track age */
  intensity: number;
  /** its own nodules, gathered once so the per-frame pass is not a search */
  nodules: Nodule[];
}

/**
 * How far through its life the storm is, 0..1 — or negative while there is
 * no storm at all. Only the first TYPHOON_DUTY of each cycle carries one;
 * the rest of the cycle is open ocean, which is what makes the next one an
 * event rather than a permanent fixture.
 */
const TYPHOON_DUTY = 0.55;

function typhoonAge(sys: TyphoonSystem, t: number): number {
  const cycle = ((t / sys.period + sys.phase) % 1 + 1) % 1;
  return cycle < TYPHOON_DUTY ? cycle / TYPHOON_DUTY : -1;
}

/** 0 while forming and dissipating, 1 at peak — scales every nodule. */
function typhoonIntensity(age: number): number {
  return age < 0 ? 0 : Math.pow(Math.sin(age * Math.PI), 0.7);
}

function typhoonCentre(sys: TyphoonSystem, age: number, out: THREE.Vector3): THREE.Vector3 {
  // 12°N-ish at formation, recurving out to about 34°
  const lat = (0.21 + 0.38 * Math.pow(age, 1.7)) * sys.hemi;
  // carried west by the trades, then east again once it is in the westerlies
  const lon = sys.lon0 - 0.95 * age + 1.7 * Math.pow(age, 3);
  return dirFromLatLon(lat, lon, out);
}

function buildTyphoon(sys: TyphoonSystem, rand: () => number, out: Nodule[]): void {
  const arms = 3;
  const params = CLOUD_TYPE_PARAMS.typhoon;

  // The eyewall: a dense, unbroken ring right at the eye's edge. This is
  // the single feature that makes the whole thing read as a cyclone rather
  // than as a patch of bad weather, so it is packed tight enough that the
  // nodules touch and the hole in the middle stays a clean hole.
  const wallCount = 56;
  for (let i = 0; i < wallCount; i++) {
    const theta = (i / wallCount) * Math.PI * 2;
    const r = sys.eye * (1.0 + rand() * 0.16);
    out.push(pushSpiralNodule(sys, r, theta, 1, rand, params));
  }

  // and the rainbands: logarithmic spirals unwinding out of the eyewall.
  // Continuous, not sampled sparsely — an arm made of well-separated puffs
  // is read as a scatter of clouds that happen to lie on a curve, which is
  // exactly what the first attempt here looked like. Each step lays two or
  // three nodules *across* the arm instead, so it comes out as a band with
  // width, and only the outermost fifth is allowed to break up.
  for (let a = 0; a < arms; a++) {
    const base = (a / arms) * Math.PI * 2 + rand() * 0.3;
    const steps = 40;
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      const r = sys.eye * 1.1 + (sys.reach - sys.eye * 1.1) * Math.pow(f, 0.9);
      // the further out, the more the arm has been wound back — this is
      // what makes the arms trail rather than stick out like spokes
      const theta = base - sys.hemi * 3.1 * Math.log(r / sys.eye);
      if (f > 0.8 && rand() < (f - 0.8) * 2.6) continue;
      const across = 3 - Math.floor(f * 2);
      for (let c = 0; c < across; c++) {
        out.push(
          pushSpiralNodule(
            sys,
            r * (1 + ((c - (across - 1) / 2) * 0.05 + (rand() - 0.5) * 0.03)),
            theta + (rand() - 0.5) * 0.12,
            1 - f * 0.6,
            rand,
            params,
          ),
        );
      }
    }
  }
}

function pushSpiralNodule(
  sys: TyphoonSystem,
  r: number,
  theta: number,
  bulk: number,
  rand: () => number,
  params: CloudTypeParams,
): Nodule {
  const n = makeNodule(new THREE.Vector3(0, 1, 0), {
    hover: params.hoverBase + bulk * params.hoverBulk + rand() * 0.03,
    size: (params.sizeBase + bulk * params.sizeBulk) * (0.6 + rand() * 0.7),
    spin: rand() * Math.PI * 2,
    band: sys.band,
  });
  n.spiral = { radius: r, theta };
  return n;
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

  // One cyclone, not two. A pair (one per hemisphere) meant that at almost
  // any moment there was a hurricane somewhere on the planet, and a storm
  // that is always present is scenery rather than an event — which is the
  // opposite of the reason for building it. One, with long quiet gaps
  // between its lives, is a thing you notice when it happens.
  const typhoons: TyphoonSystem[] = [1].map((hemi, i) => ({
    band: seeds.length + i,
    lon0: rand() * Math.PI * 2,
    hemi,
    period: 210 + rand() * 60,
    phase: i * 0.5 + rand() * 0.15,
    eye: 0.042,
    reach: 0.22,
    spin: 0.55,
    intensity: 0,
    nodules: [],
  }));
  typhoons.forEach((sys) => {
    bandType[sys.band] = 'typhoon';
    buildTyphoon(sys, rand, sys.nodules);
    nodules.push(...sys.nodules);
  });

  // each band breathes (grows/shrinks) on its own slow cycle, standing in
  // for forming and dissipating without ever changing instance counts
  const bandBreathPhase = bandType.map(() => rand() * Math.PI * 2);
  const bandBreathSpeed = bandType.map(() => 0.06 + rand() * 0.05);
  // how far this band's flow is displaced by the current meander, and where
  // in that meander it sits — a per-band phase keeps neighbouring bands from
  // snaking in lockstep
  const bandMeanderPhase = bandType.map(() => rand() * Math.PI * 2);

  const regularVariantCount = 3;
  const regularVariants = Array.from({ length: regularVariantCount }, () =>
    buildNoduleGeometry(rand, 1, CLOUD_TYPE_PARAMS.cumulus.undersideFloor),
  );
  const stratusGeometry = buildNoduleGeometry(rand, CLOUD_TYPE_PARAMS.stratus.flatten, CLOUD_TYPE_PARAMS.stratus.undersideFloor);
  const cirrusGeometry = buildNoduleGeometry(rand, CLOUD_TYPE_PARAMS.cirrus.flatten, CLOUD_TYPE_PARAMS.cirrus.undersideFloor);

  // The halo needs its *own* copy of each geometry, differing only in the
  // baked vertex colours.
  //
  // It was drawn from the core's geometry, which carries the top-lit /
  // underside-shaded gradient the cores are shaded by — so the halo, which
  // extends a third further out in every direction, was painting that
  // gradient's dark underside over the sky *around* each nodule. Against
  // the ocean it came out as a distinct grey ring following every lump: the
  // exact opposite of what a fringe is for, and the single most CG-looking
  // thing left in the sky. A fringe is backlit — the thin edge of a wad of
  // cotton is the *brightest* part of it, not the darkest — so the halo
  // copies are flooded to near-white and only the core keeps the shading.
  const flatWhite = (source: THREE.BufferGeometry): THREE.BufferGeometry => {
    const g = source.clone();
    const count = g.attributes.position.count;
    const colors = new Float32Array(count * 3).fill(0.97);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return g;
  };
  const regularHaloVariants = regularVariants.map(flatWhite);
  const stratusHaloGeometry = flatWhite(stratusGeometry);
  const cirrusHaloGeometry = flatWhite(cirrusGeometry);

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
    if (type === 'storm' || type === 'typhoon') {
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
    buildLayer(list, regularHaloVariants[vi], haloMaterial, CLOUD_TYPE_PARAMS.cumulus.haloScale, false);
  });
  buildLayer(stratusNodules, stratusGeometry, coreMaterial, 1, true);
  buildLayer(stratusNodules, stratusHaloGeometry, haloMaterial, CLOUD_TYPE_PARAMS.stratus.haloScale, false);
  buildLayer(cirrusNodules, cirrusGeometry, coreMaterial, 1, false);
  buildLayer(cirrusNodules, cirrusHaloGeometry, cirrusHaloMaterial, CLOUD_TYPE_PARAMS.cirrus.haloScale, false);

  // ---- storm cells: each band gets its own material so lightning can
  // flicker one storm without lighting up every cloud on the planet ----
  interface StormBand {
    band: number;
    coreMaterial: THREE.MeshStandardMaterial;
    nextFlashAt: number;
    flashUntil: number;
    /** minimum seconds between flashes, and the random spread on top */
    flashGap: number;
    flashSpread: number;
  }
  const stormBands: StormBand[] = [];
  stormNodulesByBand.forEach((list, band) => {
    const stormCore = coreMaterial.clone();
    stormCore.emissiveIntensity = 0.08;
    buildLayer(list, regularVariants[band % regularVariantCount], stormCore, 1, true);
    buildLayer(list, regularHaloVariants[band % regularVariantCount], haloMaterial, CLOUD_TYPE_PARAMS.storm.haloScale, false);
    // a cyclone is a far more electrically active thing than a lone
    // thunderhead, so its eyewall flickers several times as often
    const cyclone = bandType[band] === 'typhoon';
    stormBands.push({
      band,
      coreMaterial: stormCore,
      nextFlashAt: 2 + rand() * 6,
      flashUntil: 0,
      flashGap: cyclone ? 0.5 : 3,
      flashSpread: cyclone ? 1.6 : 9,
    });
  });

  // Scratch objects for the per-frame advection, hoisted out of the loop:
  // this runs over every nodule on the planet each frame, and allocating a
  // vector per nodule per frame is exactly the kind of thing that turns a
  // free update into garbage-collection stutter.
  const centre = new THREE.Vector3();
  const east = new THREE.Vector3();
  const north = new THREE.Vector3();
  const align = new THREE.Quaternion();
  const spinQ = new THREE.Quaternion();

  // Where every nodule is *right now*. Done once per frame over the nodule
  // list rather than inside the mesh loop, because the core and halo layers
  // share the same Nodule objects — computing it per mesh would do all of
  // this twice for no difference on screen.
  const advect = (t: number) => {
    typhoons.forEach((sys) => {
      const age = typhoonAge(sys, t);
      typhoonCentre(sys, age, centre);
      // the storm's own tangent frame, so its spiral can be laid out
      // relative to north/east at wherever the eye currently is
      north.set(0, 1, 0).addScaledVector(centre, -centre.y).normalize();
      east.crossVectors(north, centre).normalize();
      sys.intensity = typhoonIntensity(age);

      sys.nodules.forEach((n) => {
        const r = n.spiral!.radius;
        // Differential rotation: the eyewall goes round several times for
        // each turn of the outer rainbands, which is what winds the arms
        // tighter over time instead of spinning a rigid pinwheel. A
        // cyclone turns anticlockwise seen from above in the north and
        // clockwise in the south, hence the hemisphere sign.
        const omega = (sys.spin / (0.45 + r / sys.reach)) * -sys.hemi;
        const theta = n.spiral!.theta + omega * t;
        const tangentX = Math.cos(theta);
        const tangentZ = Math.sin(theta);
        n.live
          .copy(centre)
          .multiplyScalar(Math.cos(r))
          .addScaledVector(north, Math.sin(r) * tangentX)
          .addScaledVector(east, Math.sin(r) * tangentZ)
          .normalize();
        // a storm that is forming or falling apart is made of smaller,
        // sparser cotton, so it fades in and out instead of popping
        n.liveScale = sys.intensity;
      });
    });

    nodules.forEach((n) => {
      if (n.spiral) return; // cyclones are placed above
      // Wind read at this nodule's *own* latitude, not its band's: that is
      // what shears a band apart as it travels instead of sliding it along
      // rigid. Closed-form in t (not accumulated per frame) so the sky is
      // identical at a given time whatever the frame rate, the same rule
      // the rest of this project's animation follows.
      const lon = n.lon + zonalOmega(n.lat) * t;
      const lat =
        n.lat +
        meanderAmplitude(n.lat) * Math.sin(lon * 3 + t * 0.05 + bandMeanderPhase[n.band]);
      dirFromLatLon(THREE.MathUtils.clamp(lat, -HALF_PI, HALF_PI), lon, n.live);
      n.liveScale = 1 + Math.sin(t * bandBreathSpeed[n.band] + bandBreathPhase[n.band]) * 0.09;
    });
  };

  const tick = (t: number) => {
    advect(t);

    liveMeshes.forEach(({ mesh, list, sizeScale }) => {
      list.forEach((n, i) => {
        rotated.copy(n.live);
        dummy.position.copy(rotated).multiplyScalar(radius + n.hover);
        align.setFromUnitVectors(up, rotated);
        spinQ.setFromAxisAngle(rotated, n.spin);
        dummy.quaternion.copy(spinQ).multiply(align);
        const s = n.size * sizeScale * n.liveScale;
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
        s.nextFlashAt = s.flashUntil + s.flashGap + rand() * s.flashSpread;
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
