import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  aridityAt,
  badlandsAt,
  BADLANDS_THRESHOLD,
  climateFactsAt,
  DESERT_ARIDITY_THRESHOLD,
  orogenyBeltAt,
  sampledHeight,
  SEA_LEVEL,
  snowinessAt,
  canopyAt,
  temperatureAt,
  terracedElevation,
  latLonToDir,
  urbanAt,
  type ClimateGroup,
} from './terrain';
import { clumpDensity, displaceWithNoise, mulberry32, smoothstep, SpatialHash } from './spatialHash';
import { fbm3 } from './noise';

// ---------------------------------------------------------------------
// One scatter, everything that stands on the ground
// ---------------------------------------------------------------------
// This used to be two systems sweeping the sphere independently: a
// "vegetation" pass (savanna trees/mountain rocks, dense forest canopy,
// ground grass, loose scree — four sub-sweeps of its own) and a "species"
// pass classifying candidates into fourteen further kinds. Each sweep
// generated its own random directions and resampled height, elevation,
// temperature, aridity, badlands and snowiness independently for them —
// so adding the species pass on top of the existing four made startup
// slower in proportion, not because there was more to build but because
// there was another full sphere to walk.
//
// Now there is one candidate stream. Every candidate's climate is sampled
// once (see `sampleAt`) and handed to every layer that might want it —
// the fourteen-species classifier, the forest canopy, the grass, the
// savanna trees and mountain rocks, and the scree — each of which still
// keeps its own spatial hash and spacing (they have very different
// densities), but none of which pays to regenerate the point or its
// climate. Adding a new layer costs a branch and a hash, not a sweep.
//
// The other half of "one scatter" is not looking like one: accepting
// every candidate that passes a biome test produces a mathematically even
// lattice, and nothing in nature is that regular — real ground cover sits
// in drifts and clusters with bare gaps between. `clumpDensity` (see
// spatialHash.ts) gates acceptance by coherent noise instead of a flat
// probability, so cacti come in stands, boulders in fields, and there is
// always somewhere for the ground to just be ground.

export type Species =
  | 'conifer'
  | 'cypress'
  | 'broadleaf'
  | 'acacia'
  | 'palm'
  | 'deadTree'
  | 'bamboo'
  | 'mangrove'
  | 'shrub'
  | 'tussock'
  | 'cactus'
  | 'desertScrub'
  | 'dune'
  | 'butte'
  | 'seaStack'
  | 'iceFloe'
  | 'glacier'
  | 'snowDrift'
  | 'geyser'
  // Regional icons: the six below are not climate types, they are places.
  // See REGIONAL_ICONS.
  | 'baobab'
  | 'eucalyptus'
  | 'sakura'
  | 'bambooGrove'
  | 'saguaro'
  | 'redwood';

/** Whether a species is planted (tinted green-ish) or mineral. */
const MINERAL: ReadonlySet<Species> = new Set<Species>([
  'dune',
  'butte',
  'seaStack',
  'iceFloe',
  'glacier',
  'snowDrift',
  'geyser',
]);

interface Placement {
  dir: THREE.Vector3;
  height: number;
  species: Species;
}

// Climate sampled once per candidate direction and shared by every layer
// below, instead of each layer resampling it for its own private stream
// of candidates.
interface Sample {
  dir: THREE.Vector3;
  height: number;
  elevation: number;
  temperature: number;
  snow: number;
  arid: number;
  belt: number;
  badlands: number;
  /** how much closed forest the real climate map puts here, 0..1 */
  canopy: number;
  /** and whether that forest is conifer */
  coniferous: boolean;
  /** the Köppen group itself — what decides which species stand here */
  group: ClimateGroup;
  underwater: boolean;
  shelfDepth: number;
}

/**
 * Everything every layer wants to know about a candidate, or null if there
 * is nothing any of them could put there.
 *
 * The early return is worth more than it looks. Roughly seven candidates in
 * ten land on open ocean deeper than the shelf, where nothing is ever
 * placed — and each one was paying for a climate-raster probe, four baked
 * field lookups and a snow computation before anything got round to
 * discarding it. Height alone answers the question, and height is the one
 * field that is a single array read.
 */
function sampleAt(dir: THREE.Vector3): Sample | null {
  const height = sampledHeight(dir).raw;
  const shelfDepth = SEA_LEVEL - height;
  if (shelfDepth > 0.045) return null;

  const elevation = terracedElevation(height);
  const { group, coniferous } = climateFactsAt(dir);
  return {
    dir,
    height,
    elevation,
    temperature: temperatureAt(dir, elevation),
    snow: snowinessAt(dir, height),
    arid: aridityAt(dir),
    belt: orogenyBeltAt(dir),
    badlands: badlandsAt(dir),
    canopy: canopyAt(dir),
    coniferous,
    group,
    underwater: height < SEA_LEVEL,
    shelfDepth,
  };
}

/**
 * What belongs at this point, or null for bare ground.
 *
 * Which species stands here is the Köppen group's call. It used to be a
 * ladder of temperature and aridity thresholds, which is a reasonable way
 * to guess a biome when you have no biome data — but the classification is
 * *already* the biome, hand-drawn from a century of station records, and
 * reconstructing it badly out of two scalars threw that away. Concretely,
 * a threshold ladder cannot tell an Aw savanna from a Cfa oak wood (same
 * temperature, similar aridity), nor a Cs Mediterranean hillside from a
 * Cfb oceanic one, so both pairs came out as the same generic shrub. The
 * groups separate them by construction.
 *
 * Within a group the order still runs from the most specific habitat to
 * the least, so that (say) a mangrove coast is not first claimed by the
 * generic tropical case. Each acceptance chance is gated by `clumpDensity`
 * with a seed of its own, so one species' clusters don't line up with
 * another's.
 */
function classify(s: Sample, rand: () => number): Species | null {
  const { dir, elevation, temperature, snow, belt, badlands, group, underwater, shelfDepth } = s;

  if (underwater) {
    // Only the shallow shelf holds anything; anything deeper never reaches
    // here, sampleAt having already discarded it.
    if (temperature < 0.06) return rand() < 0.55 * clumpDensity(dir, 11) ? 'iceFloe' : null;
    if (temperature > 0.62 && shelfDepth < 0.02) return rand() < 0.5 * clumpDensity(dir, 23) ? 'mangrove' : null;
    // rock left standing where a cliffed coast has been cut back
    if (belt > 0.2 && shelfDepth < 0.03) return rand() < 0.35 * clumpDensity(dir, 37) ? 'seaStack' : null;
    return null;
  }

  // Frozen ground: ice and drifts, nothing that grows. This and the two
  // tests after it are landform, not climate — an ice cap, a volcano and a
  // canyon each override whatever the classification says grows nearby.
  if (snow > 0.5 || group === 'EF') {
    if (elevation > 0.2 && belt > 0.25) return rand() < 0.4 * clumpDensity(dir, 41) ? 'glacier' : null;
    return rand() < 0.3 * clumpDensity(dir, 53) ? 'snowDrift' : null;
  }

  // Volcanic country vents steam.
  if (belt > 0.55 && elevation > 0.16 && rand() < 0.06 * clumpDensity(dir, 61)) return 'geyser';

  // Mesas stand where the real badlands are (see KOPPEN_BADLANDS in
  // terrain.ts) — which is inside the dry classes and nowhere else, rather
  // than wherever a global noise blob happened to peak. A chance, not a
  // branch: badlands country is still desert, so what a candidate is not
  // claimed by here falls through to its group below and gets sand or
  // scrub. Making it terminal is what left the Sahara a field of mesas
  // with not one dune in it.
  if (badlands > BADLANDS_THRESHOLD + 0.04 && rand() < 0.22 * clumpDensity(dir, 71)) return 'butte';

  // Above the tree line: standing deadwood, whatever the climate below is.
  if (elevation > 0.15) return rand() < 0.18 * clumpDensity(dir, 101) ? 'deadTree' : null;

  switch (group) {
    // --- A: tropical ---
    case 'Af':
    case 'Am': {
      // everwet: palms along the shore, then broadleaf with bamboo through
      // the understorey. The forest canopy layer supplies the mass; these
      // are the individual crowns that break its outline.
      if (elevation < 0.02 && rand() < 0.42 * clumpDensity(dir, 113)) return 'palm';
      if (rand() >= 0.55 * clumpDensity(dir, 127)) return null;
      return rand() < 0.3 ? 'bamboo' : 'broadleaf';
    }
    case 'Aw': {
      // savanna: the flat-topped acacia is the whole signature of the
      // biome — a single silhouette that says "Serengeti" at a glance.
      if (rand() >= 0.5 * clumpDensity(dir, 163)) return null;
      return rand() < 0.85 ? 'acacia' : 'deadTree';
    }

    // --- B: dry ---
    case 'BW': {
      // sand desert: dunes are the landform, succulents only at the warm
      // margins where there is any moisture at all
      if (rand() < 0.3 * clumpDensity(dir, 167)) return 'dune';
      if (temperature > 0.55 && rand() < 0.1 * clumpDensity(dir, 83)) return 'cactus';
      return null;
    }
    case 'BS': {
      // steppe: low scrub, thicker than true desert but nothing like a wood
      if (rand() >= 0.5 * clumpDensity(dir, 97)) return null;
      if (temperature > 0.6) return rand() < 0.35 ? 'cactus' : 'desertScrub';
      return rand() < 0.4 ? 'shrub' : 'desertScrub';
    }

    // --- C: temperate ---
    case 'Cs': {
      // Mediterranean: cypress spires over dry maquis scrub. The cypress
      // is doing the same job for southern Europe that the acacia does for
      // the savanna and the spruce for the taiga.
      if (rand() >= 0.55 * clumpDensity(dir, 131)) return null;
      return rand() < 0.45 ? 'cypress' : 'shrub';
    }
    case 'Cw': {
      // monsoon-temperate (south China, the Indian foothills): broadleaf
      // with real bamboo stands in it
      if (rand() >= 0.55 * clumpDensity(dir, 137)) return null;
      return rand() < 0.4 ? 'bamboo' : 'broadleaf';
    }
    case 'Cf': {
      // oceanic/humid-subtropical: mixed broadleaf wood with shrub between
      if (rand() >= 0.6 * clumpDensity(dir, 139)) return null;
      return rand() < 0.7 ? 'broadleaf' : 'shrub';
    }

    // --- D: continental ---
    case 'Ds': {
      // dry-summer continental — the interior west: open conifer stands
      // over sage, and deadwood where it burns
      if (rand() >= 0.5 * clumpDensity(dir, 149)) return null;
      const roll = rand();
      return roll < 0.5 ? 'conifer' : roll < 0.85 ? 'shrub' : 'deadTree';
    }
    case 'Dw':
    case 'Df': {
      // the boreal belt: spruce, and the single most recognisable
      // vegetation silhouette on the planet
      if (rand() >= 0.7 * clumpDensity(dir, 151)) return null;
      return rand() < 0.88 ? 'conifer' : 'deadTree';
    }

    // --- E: polar ---
    case 'ET': {
      // tundra: no trees at all, tussock grass and lichen over frozen
      // ground, with drifts where the snow catches
      if (rand() >= 0.6 * clumpDensity(dir, 157)) return null;
      return rand() < 0.78 ? 'tussock' : 'snowDrift';
    }

    // Only reachable on ground the climate raster calls sea — a strip of
    // pixels along coastlines where the two datasets disagree. Generic
    // scrub is the safe answer; it is never a large area.
    case 'none':
    default:
      return rand() < 0.35 * clumpDensity(dir, 173) ? 'shrub' : null;
  }
}

// ---------------------------------------------------------------------
// Regional icons
// ---------------------------------------------------------------------
// Everything above this point is climate: the Köppen group decides what
// stands here, and the same group produces the same forest everywhere it
// occurs. That is right for a biome map and wrong for a souvenir globe,
// because it makes Madagascar, the Kimberley and the Chaco the same
// yellow-green savanna, and Japan the same Cfa broadleaf wood as Georgia.
// A globe is read by looking for the places you already know, and the
// places you know have a plant attached to them: Madagascar has baobabs,
// Australia has gum trees, Japan has cherry blossom.
//
// So a short list of icons is pinned to real coordinates and allowed to
// stand in for the generic species where the two overlap. Substitution
// rather than a separate layer, deliberately: the density, the spacing,
// the city clearing and the farmland thinning are all decided above and
// none of it has to be restated here, and an icon can never appear
// somewhere its climate cannot support one — a eucalypt is only ever put
// where the classification already grew *something*, so the Australian
// interior stays sand rather than sprouting a forest with the right
// accent. `seed` is the one exception and it is small: in dry country the
// generic table leaves most ground bare, and a region that produced six
// plants in total (the Sonoran, measured) cannot show an icon at all.
//
// Regions are circles because their edges have to be soft. A hard
// boundary at a coordinate reads as a rectangle of one tree species
// abutting another, which is a land-use map, not a landscape; the
// acceptance chance falls off across the outer quarter of every circle so
// the icons thin out into the generic wood around them.
//
// Measured over the whole planet after the change, this layer only:
// 50 baobabs (26 in the Sahel box, 14 in Madagascar),
// 65 eucalypts (64 of them in Australia), 14 bamboo groves (13 in south
// China), 12 saguaros (7 in the Sonoran box), 9 cherries (7 in Japan,
// 2 in Korea), 7 redwoods. The layer's own total went 5,910 → 5,904 and
// the canopy, grass and scatter layers moved by under 1%, which is what
// substitution is for: this adds six silhouettes to the globe, not six
// thousand instances.
//
// One icon was built and thrown away: the Joshua tree. Its range is the
// Mojave, and the Mojave measured *five* plants of any kind in the whole
// box (four dunes and one shrub) — a region that small cannot carry a
// species, it can only carry a landmark, and landmarks.ts is where those
// live. Its distinguishing feature fails the same test twice over: the
// splayed branch tips that make the silhouette are about 0.010 units
// across, which is 0.9 px. An olive grove for the Mediterranean was
// dropped for the opposite reason — plenty of room, but at this size it
// is a low round green blob, which is exactly what the generic shrub
// already is, and the cypress beside it already says "Mediterranean"
// with the only outline in that region that is not a blob.
interface IconRegion {
  species: Species;
  /** [latitude, longitude, angular radius in radians] — 1 rad ≈ 6,371 km */
  areas: readonly (readonly [number, number, number])[];
  /** the generic species this icon stands in for inside its region */
  replaces: readonly Species[];
  /** chance of taking one of those over */
  takeover: number;
  /** chance of claiming ground the generic table left bare (see above) */
  seed: number;
}

const REGIONAL_ICONS: readonly IconRegion[] = [
  {
    // Madagascar's Avenue and the Sahel's lone giants. The baobab replaces
    // the acacia rather than joining it: both are "the one tree standing
    // in dry grass", and having both in the same place would just read as
    // two kinds of scrub.
    species: 'baobab',
    areas: [
      [-19, 45, 0.13], // Madagascar, west coast
      [14, -11, 0.1], // Senegal / Mali
      [13, 3, 0.1], // Niger
      [12, 20, 0.1], // Chad / Sudan
    ],
    replaces: ['acacia', 'deadTree', 'desertScrub', 'broadleaf'],
    takeover: 0.6,
    seed: 0.05,
  },
  {
    // One circle covers the continent: at 0.33 rad it reaches from the
    // Kimberley to Tasmania, which is right, because the gum tree does
    // too — it is the one genus that spans every Australian climate from
    // the wet tropics to the alps, and it is what makes the place look
    // like nowhere else.
    species: 'eucalyptus',
    areas: [
      [-25, 134, 0.33],
      [-42, 147, 0.05], // Tasmania, just outside the big circle's falloff
    ],
    replaces: ['broadleaf', 'shrub', 'acacia', 'conifer', 'cypress'],
    takeover: 0.7,
    seed: 0.03,
  },
  {
    // Cherry, and only where the blossom is the season: Honshu, Kyushu,
    // Hokkaido, Korea. Kept well under half the local wood — an island
    // entirely of blossom is a pattern, one in three trees is a spring.
    species: 'sakura',
    areas: [
      [36, 138, 0.1], // Honshu
      [33, 131, 0.05], // Kyushu
      [43, 142, 0.06], // Hokkaido
      [36.5, 127.8, 0.05], // Korea
    ],
    replaces: ['broadleaf', 'shrub'],
    takeover: 0.7,
    seed: 0.12,
  },
  {
    // The generic `bamboo` species is single scattered culms mixed
    // through a tropical wood, which is what bamboo is in the Amazon
    // understorey. A managed grove — a solid block of stems with a mass
    // of leaf on top — is a different thing and belongs to south China
    // and Japan specifically, so it takes over the generic one there.
    species: 'bambooGrove',
    areas: [
      [25, 110, 0.13], // Guangxi / Hunan
      [30, 104, 0.08], // Sichuan
      [34.5, 134, 0.07], // western Honshu
    ],
    replaces: ['bamboo', 'broadleaf'],
    takeover: 0.55,
    seed: 0.03,
  },
  {
    // The Sonoran, and nothing else. There is already a `cactus` and it
    // is already saguaro-shaped, which is exactly the problem: the one
    // silhouette that means "Arizona" was being planted in the Sahel, the
    // Kalahari and the Australian interior, none of which has ever had a
    // columnar cactus in it. The generic one keeps its shape (it is the
    // only succulent outline that reads at this size) and the real
    // Sonoran gets a taller, heavier, properly candelabra'd version so
    // that the place it actually comes from still wins the comparison.
    species: 'saguaro',
    areas: [
      [32, -112, 0.075], // Arizona / Sonora
      [29, -113.5, 0.05], // Baja California
    ],
    replaces: ['cactus', 'desertScrub', 'shrub'],
    takeover: 0.85,
    // The Sonoran box measured six plants of any kind in total, so
    // substitution alone would have put two saguaros in Arizona.
    seed: 0.2,
  },
  {
    // Coast redwood: the tallest tree there is, and height is the only
    // property of a tree that survives being 7 pixels tall. A narrow
    // strip, because the real range is one.
    species: 'redwood',
    areas: [
      [40.5, -123.4, 0.07], // northern California
      [46, -122.8, 0.07], // Oregon / Washington coast
    ],
    replaces: ['conifer', 'deadTree', 'broadleaf', 'shrub', 'cypress'],
    takeover: 0.75,
    seed: 0.12,
  },
];

// Precomputed once: the direction of each circle's centre and the cosines
// of its edge and of the inner circle where the falloff begins. A dot
// product against a unit direction is the whole test, which matters
// because it runs on every one of the 900,000 candidates.
const ICON_AREAS = REGIONAL_ICONS.map((region) => ({
  region,
  circles: region.areas.map(([lat, lon, radius]) => ({
    at: latLonToDir(lat, lon),
    cosOuter: Math.cos(radius),
    cosInner: Math.cos(radius * 0.72),
  })),
}));

/**
 * The icon that belongs at this point, or `base` unchanged.
 *
 * Ground the generic table left bare (`base === null`) can still be
 * claimed, but only where something could have grown: the landform cases
 * in `classify` — ice, badlands, above the tree line, underwater — have
 * already had their say by the time this is called, and an icon must not
 * overrule them. A baobab standing on a glacier is a worse failure than
 * no baobab.
 */
function regionalIcon(s: Sample, base: Species | null, rand: () => number): Species | null {
  if (base !== null && MINERAL.has(base)) return base;
  for (const { region, circles } of ICON_AREAS) {
    let strength = 0;
    for (const c of circles) {
      const d = s.dir.dot(c.at);
      if (d <= c.cosOuter) continue;
      strength = Math.max(strength, smoothstep(d, c.cosOuter, c.cosInner));
    }
    if (strength === 0) continue;
    if (base !== null) {
      if (!region.replaces.includes(base)) continue;
      return rand() < region.takeover * strength ? region.species : base;
    }
    const plantable =
      !s.underwater &&
      s.snow <= 0.5 &&
      s.elevation <= 0.15 &&
      s.badlands <= BADLANDS_THRESHOLD &&
      s.temperature >= COLD_TEMPERATURE_LIMIT;
    // No `return` on a failed roll: the regions overlap (western Honshu is
    // both cherry country and bamboo country), and returning here would
    // silently give every square of overlap to whichever icon happens to
    // be listed first.
    if (plantable && rand() < region.seed * strength) return region.species;
  }
  return base;
}

// ---------------------------------------------------------------------
// The models
// ---------------------------------------------------------------------
// Everything here is sized against the display scale: the globe is about
// 500 pixels across for a radius of 2, so one world unit is roughly 125
// pixels and nothing under about 0.03 units can be seen at all. These run
// from 0.03 to 0.09 — small enough to read as miniature, large enough to
// have a recognisable outline, which is the only thing that distinguishes
// one species from another at this size.

function cone(radius: number, height: number, y: number, segments = 6): THREE.BufferGeometry {
  return new THREE.ConeGeometry(radius, height, segments).translate(0, y + height / 2, 0);
}

function column(
  bottom: number,
  top: number,
  height: number,
  y: number,
  segments = 6,
): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(top, bottom, height, segments).translate(0, y + height / 2, 0);
}

function buildModel(species: Species, rand: () => number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  switch (species) {
    case 'conifer': {
      // a spire, which is the whole point — nothing else on the planet has
      // a vertical silhouette, so it reads as boreal at a glance
      parts.push(column(0.006, 0.004, 0.02, 0, 5));
      for (let i = 0; i < 3; i++) {
        const t = i / 3;
        parts.push(cone(0.026 * (1 - t * 0.55), 0.038, 0.016 + t * 0.026, 7));
      }
      break;
    }
    case 'cypress': {
      // narrower and taller than anything else that grows — the Tuscan
      // exclamation mark. Distinguishable from the conifer spire beside it
      // only by proportion, which is exactly how it works in life.
      parts.push(column(0.005, 0.004, 0.016, 0, 5));
      const body = new THREE.CylinderGeometry(0.002, 0.011, 0.062, 6);
      body.translate(0, 0.045, 0);
      parts.push(body);
      break;
    }
    case 'broadleaf': {
      // trunk plus one wide domed crown: the default "tree" silhouette,
      // and the thing the temperate and tropical woods were missing —
      // every individual tree on the planet was previously a spire.
      parts.push(column(0.007, 0.005, 0.022, 0, 5));
      // A sphere, not an icosahedron, purely so it can be merged with the
      // cylinder above: mergeGeometries returns null (and the caller then
      // throws on it) if some of its inputs are indexed and some are not,
      // and IcosahedronGeometry is the one primitive here that is not.
      const crown = new THREE.SphereGeometry(0.03, 7, 5);
      displaceWithNoise(crown, 0.22, 3.5, rand() * 500);
      crown.scale(1.15, 0.82, 1.15);
      crown.translate(0, 0.042, 0);
      parts.push(crown);
      break;
    }
    case 'acacia': {
      // the flat-topped umbrella. One silhouette, and it says Serengeti
      // with no other cue at all — which is the whole reason the savanna
      // needs a species of its own rather than a shrub.
      const trunk = column(0.006, 0.003, 0.03, 0, 5);
      trunk.rotateZ(0.07);
      parts.push(trunk);
      const canopyDisc = new THREE.CylinderGeometry(0.036, 0.022, 0.012, 8);
      displaceWithNoise(canopyDisc, 0.16, 5, rand() * 500);
      canopyDisc.translate(0, 0.034, 0);
      parts.push(canopyDisc);
      break;
    }
    case 'tussock': {
      // tundra: no woody stem anywhere, just a low hummock of blades over
      // frozen ground
      for (let i = 0; i < 5; i++) {
        const blade = new THREE.ConeGeometry(0.005, 0.016 + rand() * 0.008, 4);
        blade.translate(0, 0.008, 0);
        blade.rotateZ((rand() - 0.5) * 0.8);
        blade.rotateY(rand() * Math.PI * 2);
        blade.translate((rand() - 0.5) * 0.02, 0, (rand() - 0.5) * 0.02);
        parts.push(blade);
      }
      break;
    }
    case 'dune': {
      const rand0 = rand() * 6.283;
      // A dune is a ridge, not a lump.
      //
      // This used to be a sphere scaled to (1.5, 0.18, 0.55). An ellipsoid
      // squashed that way is a lens: from above it comes to a sharp point
      // at both ends, and it stops in mid-air there rather than going
      // anywhere. At the size these are actually drawn, every single one
      // read as an almond lying on the sand instead of reading as sand —
      // which is the same failure as the old field-of-mesas Sahara, just
      // with a rounder mesa.
      //
      // What makes an erg look like an erg is not the individual mound. It
      // is that the mounds are long, that they all run the same way (see
      // duneBearing at the placement loop), and that they sink back into
      // the ground at their ends. Only the last of those is geometry.
      const R = 0.05;
      const g = new THREE.SphereGeometry(R, 16, 8);
      // Gentle: sand is a smooth material. The noise amplitude that reads
      // as "weathered rock" on a butte reads as "gravel" here.
      displaceWithNoise(g, 0.09, 3.4, rand() * 500);

      const HALF = 0.1; // half-length of the ridge along its crest line
      const HALF_WIDTH = 0.03;
      const HEIGHT = 0.017;
      const pos = g.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const x0 = pos.getX(i);
        const y0 = pos.getY(i);
        const z0 = pos.getZ(i);
        // Off the sphere's own cross-section first.
        //
        // Scaling a sphere along one axis was the whole bug, and tapering
        // the *height* afterwards (the first fix) did not undo it: at a
        // given x the sphere's cross-section is already narrowed by
        // sqrt(R²−x²), so the plan outline stayed a lens whatever was done
        // to y. Seen from above — which is how a globe is seen — a lens is
        // an almond, and the sand still read as a scatter of almonds.
        // Dividing that factor out gives a lateral coordinate that runs
        // −1..1 at every station along the crest, so the plan shape can be
        // stated outright instead of inherited.
        const cross = Math.sqrt(Math.max(R * R - x0 * x0, 1e-6));
        const ny = y0 / cross;
        const nz = z0 / cross;
        const t = x0 / R; // −1..1 along the crest
        const a = Math.abs(t);
        // A ridge holds its width nearly to its ends and then rounds off,
        // rather than coming to a point: this is flat until about 0.8 and
        // falls to zero over the last fifth.
        const widthProfile = Math.pow(Math.max(0, 1 - Math.pow(a, 7)), 0.4);
        // The crest itself runs level for most of the length and sinks into
        // the sand at both ends.
        const heightProfile = Math.pow(Math.max(0, 1 - a * a), 0.8);
        // Sinuous, not ruled. A real linear dune wanders by a fraction of
        // its own width along its length; dead-straight ridges laid in
        // parallel read as corduroy.
        const meander = Math.sin(t * 2.3 + rand0) * 0.5;
        let z = (nz + meander) * HALF_WIDTH * widthProfile;
        // The slip face. A dune is not symmetric — the windward side
        // climbs gently and the lee side drops at the angle of repose, and
        // that asymmetry is most of what says "wind put this here" rather
        // than "something was dropped here".
        if (z > 0) z *= 0.55;
        // A crest, not a tube. The sphere's own cross-section is a
        // semicircle, so taking the height straight off it gave a rounded
        // bolster lying on the sand — read as a sausage where the old
        // version read as an almond. Sand does not hold that shape: it
        // stands at the angle of repose, which makes a ridge with a line
        // along the top, gentle on the windward side and steep on the lee
        // (the z compression above). Stating the profile against the
        // lateral coordinate instead gives that ridge line.
        //
        // Flat underneath either way: only the half above the ground is
        // ever seen, and carrying a buried lower hemisphere is what forced
        // the whole shape to be so thin in the first place.
        const flank = Math.pow(Math.max(0, 1 - Math.abs(nz)), 0.62);
        const y = ny > 0 ? HEIGHT * heightProfile * flank : 0;
        pos.setXYZ(i, t * HALF, y, z);
      }
      g.computeVertexNormals();
      pos.needsUpdate = true;
      parts.push(g);
      break;
    }
    case 'palm': {
      const trunk = column(0.005, 0.004, 0.07, 0, 5);
      trunk.rotateZ(0.18);
      parts.push(trunk);
      for (let i = 0; i < 5; i++) {
        const frond = new THREE.ConeGeometry(0.012, 0.05, 4);
        frond.translate(0, 0.025, 0);
        frond.rotateZ(Math.PI * 0.42);
        frond.rotateY((i / 5) * Math.PI * 2 + rand());
        frond.translate(0.012, 0.07, 0);
        parts.push(frond);
      }
      break;
    }
    case 'deadTree': {
      parts.push(column(0.006, 0.002, 0.055, 0, 5));
      for (let i = 0; i < 3; i++) {
        const branch = new THREE.CylinderGeometry(0.0012, 0.003, 0.03, 4);
        branch.translate(0, 0.015, 0);
        branch.rotateZ(0.7 + rand() * 0.5);
        branch.rotateY(rand() * Math.PI * 2);
        branch.translate(0, 0.036 + i * 0.008, 0);
        parts.push(branch);
      }
      break;
    }
    case 'bamboo': {
      for (let i = 0; i < 6; i++) {
        const culm = column(0.0035, 0.0025, 0.055 + rand() * 0.03, 0, 4);
        culm.rotateZ((rand() - 0.5) * 0.22);
        culm.translate((rand() - 0.5) * 0.026, 0, (rand() - 0.5) * 0.026);
        parts.push(culm);
      }
      break;
    }
    case 'mangrove': {
      // the recognisable part is the stilt roots standing out of the water
      parts.push(cone(0.028, 0.03, 0.022, 7));
      for (let i = 0; i < 5; i++) {
        const root = new THREE.CylinderGeometry(0.002, 0.003, 0.03, 4);
        root.translate(0, 0.015, 0);
        root.rotateZ(0.5);
        root.rotateY((i / 5) * Math.PI * 2);
        parts.push(root);
      }
      break;
    }
    case 'shrub': {
      const g = new THREE.IcosahedronGeometry(0.024, 1);
      displaceWithNoise(g, 0.3, 3, rand() * 500);
      g.scale(1.1, 0.7, 1.1);
      g.translate(0, 0.014, 0);
      parts.push(g);
      break;
    }
    case 'cactus': {
      parts.push(column(0.008, 0.007, 0.06, 0, 7));
      for (let i = 0; i < 2; i++) {
        const arm = new THREE.CylinderGeometry(0.005, 0.005, 0.028, 6);
        arm.translate(0, 0.014, 0);
        arm.rotateZ(i === 0 ? 1.2 : -1.2);
        arm.translate(0, 0.034, 0);
        parts.push(arm);
        const tip = new THREE.CylinderGeometry(0.005, 0.005, 0.018, 6);
        tip.translate(0, 0.009, 0);
        tip.translate(i === 0 ? 0.017 : -0.017, 0.042, 0);
        parts.push(tip);
      }
      break;
    }
    case 'desertScrub': {
      for (let i = 0; i < 4; i++) {
        const twig = new THREE.ConeGeometry(0.004, 0.022, 4);
        twig.translate(0, 0.011, 0);
        twig.rotateZ((rand() - 0.5) * 1.1);
        twig.rotateY(rand() * Math.PI * 2);
        parts.push(twig);
      }
      break;
    }
    case 'butte': {
      // a flat-topped mesa, the shape the badlands paint has been
      // describing with no geometry to back it up
      const g = new THREE.CylinderGeometry(0.03, 0.045, 0.055, 7);
      displaceWithNoise(g, 0.12, 8, rand() * 500);
      g.translate(0, 0.02, 0);
      parts.push(g);
      break;
    }
    case 'seaStack': {
      const g = new THREE.CylinderGeometry(0.014, 0.026, 0.075, 6);
      displaceWithNoise(g, 0.2, 7, rand() * 500);
      g.translate(0, 0.03, 0);
      parts.push(g);
      break;
    }
    case 'iceFloe': {
      const g = new THREE.CylinderGeometry(0.055, 0.05, 0.012, 7);
      displaceWithNoise(g, 0.25, 6, rand() * 500);
      g.scale(1, 1, 0.7);
      parts.push(g);
      break;
    }
    case 'glacier': {
      const g = new THREE.BoxGeometry(0.05, 0.02, 0.11, 2, 1, 3);
      displaceWithNoise(g, 0.18, 9, rand() * 500);
      g.translate(0, 0.008, 0);
      parts.push(g);
      break;
    }
    case 'snowDrift': {
      const g = new THREE.SphereGeometry(0.045, 7, 5);
      displaceWithNoise(g, 0.3, 4, rand() * 500);
      g.scale(1.3, 0.4, 1);
      parts.push(g);
      break;
    }
    // --- the regional icons ---
    //
    // Sized against the pixel budget rather than against botany. At the
    // shipped camera one world unit is about 108 px, and the placement
    // loop multiplies every instance by `0.6 + rand*rand*0.85`, whose
    // mean is 0.81 — so the honest conversion for anything here is about
    // 87 px per unit, and a feature narrower than 0.023 units is under
    // two pixels and cannot be seen at all. Every dimension below that
    // carries meaning is checked against that number in its comment; the
    // ones that fail it are stated as failing rather than quietly shipped.
    case 'baobab': {
      // The bottle trunk is the whole animal. 0.034 across at the base
      // (3.0 px) against the 0.014 of a broadleaf trunk (1.2 px) — the
      // one tree on the planet whose *stem* is visible from orbit, which
      // is exactly the joke a baobab makes in life.
      const trunk = column(0.017, 0.009, 0.044, 0, 7);
      parts.push(trunk);
      // Flat, wide and thin — "roots in the air". 0.062 across (5.4 px)
      // and 0.026 deep (2.3 px), which is the shallowest a crown can be
      // and still register as a crown rather than as a line.
      const crown = new THREE.SphereGeometry(0.031, 8, 5);
      displaceWithNoise(crown, 0.26, 3.5, rand() * 500);
      crown.scale(1, 0.42, 1);
      crown.translate(0, 0.052, 0);
      parts.push(crown);
      for (let i = 0; i < 3; i++) {
        const limb = new THREE.CylinderGeometry(0.0035, 0.005, 0.022, 4);
        limb.translate(0, 0.011, 0);
        limb.rotateZ(0.9);
        limb.rotateY((i / 3) * Math.PI * 2 + rand());
        limb.translate(0, 0.042, 0);
        parts.push(limb);
      }
      break;
    }
    case 'eucalyptus': {
      // Tall, bare for most of its height, with a thin open crown right
      // at the top: 0.095 overall (8.3 px) against the broadleaf's 0.072
      // (6.3 px), and a crown 0.046 wide (4.0 px) against the
      // broadleaf's 0.069 (6.0 px). Two pixels taller and two pixels
      // narrower is a small margin, and it is only half the cue — the
      // other half is the blue-grey foliage, which no other species here
      // has and which does not need any pixels at all.
      const trunk = column(0.0075, 0.005, 0.07, 0, 6);
      trunk.rotateZ(0.05);
      parts.push(trunk);
      for (let i = 0; i < 3; i++) {
        const lobe = new THREE.SphereGeometry(0.016 + rand() * 0.005, 6, 4);
        displaceWithNoise(lobe, 0.3, 4, rand() * 500);
        lobe.translate(
          (rand() - 0.5) * 0.03,
          0.078 + rand() * 0.014,
          (rand() - 0.5) * 0.03,
        );
        parts.push(lobe);
      }
      break;
    }
    case 'sakura': {
      // Deliberately the least distinctive shape of the six. A cherry in
      // blossom is not recognised by its outline — it is a low vase of a
      // tree much like any other — it is recognised by being pink, and
      // colour is the one property that survives at one pixel. So the
      // geometry only has to say "small round tree" (crown 0.072 across,
      // 6.3 px, sitting lower than a broadleaf's) and `speciesColor`
      // does the work.
      parts.push(column(0.006, 0.004, 0.016, 0, 5));
      const crown = new THREE.SphereGeometry(0.036, 8, 5);
      displaceWithNoise(crown, 0.24, 3.2, rand() * 500);
      crown.scale(1, 0.55, 1);
      crown.translate(0, 0.03, 0);
      parts.push(crown);
      break;
    }
    case 'bambooGrove': {
      // A single culm is 0.008 across — 0.7 px, invisible on its own,
      // and that is fine because a grove is never seen as culms. What is
      // seen is a tall narrow block of one bright colour: 0.028 wide
      // (2.4 px) and 0.105 tall (9.1 px) including the leaf mass, the
      // most extreme height-to-width ratio of anything that grows here,
      // which is precisely what a managed grove looks like from outside.
      for (let i = 0; i < 9; i++) {
        const culm = column(0.004, 0.003, 0.072 + rand() * 0.026, 0, 4);
        culm.rotateZ((rand() - 0.5) * 0.16);
        culm.translate((rand() - 0.5) * 0.02, 0, (rand() - 0.5) * 0.02);
        parts.push(culm);
      }
      // The canopy of leaf the culms carry at the top. Without it the
      // grove ends in a flat cut line, which reads as a fence.
      for (let i = 0; i < 3; i++) {
        const leaf = new THREE.SphereGeometry(0.014, 6, 4);
        leaf.scale(1, 0.7, 1);
        leaf.translate((rand() - 0.5) * 0.018, 0.086 + rand() * 0.014, (rand() - 0.5) * 0.018);
        parts.push(leaf);
      }
      break;
    }
    case 'saguaro': {
      // Taller and thicker than the generic cactus (0.085 against 0.06,
      // trunk 0.024 across against 0.016) and with the arms turned into
      // a proper candelabra: the span across the arm tips is 0.056,
      // 4.9 px, against the 2.1 px of the bare column.
      //
      // The arms themselves are 0.020 thick, which is 1.7 px — under the
      // two-pixel line, and stated here rather than hidden: they are not
      // readable as limbs and are not meant to be. What is readable is
      // that the top half of the silhouette is twice as wide as the
      // bottom half, and that is the shape everyone recognises.
      parts.push(column(0.012, 0.011, 0.085, 0, 8));
      for (let i = 0; i < 2; i++) {
        const side = i === 0 ? 1 : -1;
        const arm = new THREE.CylinderGeometry(0.01, 0.01, 0.03, 6);
        arm.rotateZ(Math.PI / 2);
        arm.translate(side * 0.017, 0.04 + i * 0.012, 0);
        parts.push(arm);
        const tip = new THREE.CylinderGeometry(0.01, 0.01, 0.03, 6);
        tip.translate(side * 0.028, 0.055 + i * 0.012, 0);
        parts.push(tip);
      }
      break;
    }
    case 'redwood': {
      // Height is the entire species. 0.135 tall is 11.7 px against the
      // conifer's 0.08 (6.9 px) standing next to it — nearly double, and
      // the only difference on this list that cannot be mistaken for
      // instance scale jitter. Narrow with it: a redwood is a mast, and
      // the crown starts high up the trunk.
      parts.push(column(0.009, 0.005, 0.135, 0, 6));
      for (let i = 0; i < 3; i++) {
        const t = i / 3;
        parts.push(cone(0.022 * (1 - t * 0.5), 0.05, 0.06 + t * 0.03, 6));
      }
      break;
    }
    case 'geyser': {
      // the plume, not the vent: steam is what you can see from here
      for (let i = 0; i < 4; i++) {
        const puff = new THREE.SphereGeometry(0.012 + i * 0.004, 6, 4);
        puff.translate((rand() - 0.5) * 0.012, 0.02 + i * 0.022, (rand() - 0.5) * 0.012);
        parts.push(puff);
      }
      break;
    }
  }

  const merged = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  merged.computeVertexNormals();
  return merged;
}

/**
 * The compass bearing a dune's crest runs along at this point, in radians.
 *
 * Deliberately very low frequency: the whole point is that neighbouring
 * dunes agree, so the field sweeps across the erg the way wind-built sand
 * actually does. It still turns slowly across a desert the size of the
 * Sahara, which keeps the far side of one from looking like a copy of the
 * near side.
 */
function duneBearing(dir: THREE.Vector3): number {
  return fbm3(dir.x * 1.6 + 71, dir.y * 1.6 + 71, dir.z * 1.6 + 71, 2) * Math.PI * 2;
}

/** Base colour for a species, before the per-instance jitter. */
function speciesColor(species: Species, temperature: number, out: THREE.Color): THREE.Color {
  switch (species) {
    case 'conifer':
      return out.setHSL(0.31, 0.44, 0.24, THREE.SRGBColorSpace);
    case 'cypress':
      // the darkest green on the planet, which is most of why a cypress
      // reads as a cypress
      return out.setHSL(0.33, 0.5, 0.17, THREE.SRGBColorSpace);
    case 'broadleaf':
      return out.setHSL(0.24, 0.52, 0.3, THREE.SRGBColorSpace);
    case 'acacia':
      // dry-season savanna foliage is yellow-green, not leaf green
      return out.setHSL(0.17, 0.44, 0.36, THREE.SRGBColorSpace);
    case 'tussock':
      return out.setHSL(0.13, 0.28, 0.38, THREE.SRGBColorSpace);
    case 'dune':
      return out.setHSL(0.11, 0.38, 0.66, THREE.SRGBColorSpace);
    case 'palm':
      return out.setHSL(0.22, 0.58, 0.32, THREE.SRGBColorSpace);
    case 'bamboo':
      return out.setHSL(0.19, 0.6, 0.35, THREE.SRGBColorSpace);
    case 'mangrove':
      return out.setHSL(0.25, 0.5, 0.33, THREE.SRGBColorSpace);
    case 'shrub':
      // the savanna belt yellows off as it dries
      return out.setHSL(0.16 + temperature * 0.06, 0.5, 0.35, THREE.SRGBColorSpace);
    case 'deadTree':
      return out.setHSL(0.08, 0.1, 0.55, THREE.SRGBColorSpace);
    case 'cactus':
      return out.setHSL(0.29, 0.36, 0.3, THREE.SRGBColorSpace);
    case 'desertScrub':
      return out.setHSL(0.11, 0.22, 0.3, THREE.SRGBColorSpace);
    case 'butte':
      return out.setHSL(0.07, 0.26, 0.4, THREE.SRGBColorSpace);
    case 'seaStack':
      return out.setHSL(0.08, 0.12, 0.38, THREE.SRGBColorSpace);
    case 'iceFloe':
      return out.setHSL(0.55, 0.1, 0.82, THREE.SRGBColorSpace);
    case 'glacier':
      return out.setHSL(0.55, 0.14, 0.76, THREE.SRGBColorSpace);
    case 'snowDrift':
      return out.setHSL(0.58, 0.05, 0.88, THREE.SRGBColorSpace);
    case 'geyser':
      return out.setHSL(0.55, 0.04, 0.9, THREE.SRGBColorSpace);
    case 'baobab':
      // Most of a baobab's visible area is trunk, and the trunk is pale
      // grey-mauve bark, not foliage. The colour is doing the same job
      // the shape is: nothing else standing in dry grass is this light.
      return out.setHSL(0.09, 0.16, 0.5, THREE.SRGBColorSpace);
    case 'eucalyptus':
      // Blue-grey-green, and the bluest foliage on the planet by some
      // distance (the taiga conifer, the next bluest, is at 0.31 with
      // more saturation). Half the reason a gum tree is recognisable at
      // this size, since the silhouette only clears the broadleaf by two
      // pixels — see the model.
      return out.setHSL(0.38, 0.16, 0.44, THREE.SRGBColorSpace);
    case 'sakura':
      // The entire species. Pale pink is a colour nothing else on the
      // globe has, so it reads at any size down to a single pixel — but
      // it is also the only cue, which is why the takeover chance is
      // kept well under half.
      return out.setHSL(0.95, 0.42, 0.74, THREE.SRGBColorSpace);
    case 'bambooGrove':
      // Brighter and yellower than the scattered `bamboo` it replaces:
      // a managed grove is uniform young growth, and the block of colour
      // is what makes it read as one object rather than as a thicket.
      return out.setHSL(0.2, 0.62, 0.42, THREE.SRGBColorSpace);
    case 'saguaro':
      return out.setHSL(0.3, 0.34, 0.27, THREE.SRGBColorSpace);
    case 'redwood':
      // Dark, and slightly red-shifted from the boreal conifer beside it
      // for the bark, which is a third of the silhouette at this height.
      return out.setHSL(0.34, 0.4, 0.19, THREE.SRGBColorSpace);
  }
}

// ---------------------------------------------------------------------
// The rest of the ground cover, folded in from the old vegetation pass:
// forest canopy, grass, savanna trees, mountain rocks and scree. These
// keep their own geometry and colour logic (a dense clumped canopy mass
// and a ground tuft have nothing in common with a fourteen-species
// InstancedMesh-per-kind), but they now read from the same candidate
// stream as everything above instead of sweeping the sphere on their own.
// ---------------------------------------------------------------------

// Below this temperature it's tundra/ice country — too cold for forest,
// savanna, or desert dressing; those zones stay bare (the paint itself
// already reads as tundra/ice, see terrain.ts's biomeColor). Lowered from
// the original 0.09: with dir now real latitude (not fictional noise),
// that cutoff excluded most of the real boreal forest belt (Canada,
// Siberia) as "too cold" — real taiga covers most of that band, with true
// treeless tundra confined to a narrower strip right at the Arctic coast.
const COLD_TEMPERATURE_LIMIT = 0.02;

/**
 * How dry ground can be and still carry grass, and how much bare rock it
 * can carry. Both sit *above* the desert/badlands thresholds the rest of
 * the terrain uses, because grass is the one layer whose whole job is the
 * country between the forest and the sand — see the grass block below.
 * BW (true desert) is 0.90-0.97 arid and stays out; BS (steppe) is
 * 0.58-0.64 and comes in.
 */
const GRASS_ARIDITY_LIMIT = 0.78;
const BADLANDS_GRASS_LIMIT = 0.9;

/**
 * Where on the tropical/temperate/boreal scale a point sits, expressed as
 * the hue, saturation and lightness its foliage should start from.
 */
function canopyClimate(
  dir: THREE.Vector3,
  elevation: number,
): { hue: number; saturation: number; lightness: number } {
  const temperature = temperatureAt(dir, elevation);
  const tropical = smoothstep(temperature, 0.6, 0.86);
  const boreal = 1 - smoothstep(temperature, 0.22, 0.48);

  // temperate baseline
  let hue = 0.215;
  let saturation = 0.56;
  let lightness = 0.32;

  // jungle: yellower and brighter
  hue = THREE.MathUtils.lerp(hue, 0.195, tropical);
  saturation = THREE.MathUtils.lerp(saturation, 0.66, tropical);
  lightness = THREE.MathUtils.lerp(lightness, 0.36, tropical);

  // taiga: bluer, darker, less saturated — spruce, not meadow
  hue = THREE.MathUtils.lerp(hue, 0.3, boreal);
  saturation = THREE.MathUtils.lerp(saturation, 0.38, boreal);
  lightness = THREE.MathUtils.lerp(lightness, 0.2, boreal);

  // and everything thins and dulls as it climbs toward the tree line
  const alpine = smoothstep(elevation, 0.09, 0.16);
  saturation *= 1 - alpine * 0.35;
  lightness *= 1 - alpine * 0.3;

  return { hue, saturation, lightness };
}

// A poofy, "mokomoko" canopy clump — several overlapping rounded lobes'
// worth of silhouette from a single displaced sphere (see displaceWithNoise
// for why one coherent displacement reads better than independent
// per-vertex jitter at this poly count), so hundreds of forest clumps
// still cost only a few instanced draw calls.
function buildCanopyBlob(rand: () => number, detail: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.05, detail);
  displaceWithNoise(g, detail >= 2 ? 0.42 : 0.3, 2.4, rand() * 500);
  displaceWithNoise(g, 0.13, 7, rand() * 500 + 300);
  g.scale(1, 0.78, 1); // clump foliage settles wider than it is tall
  g.computeVertexNormals();
  return g;
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

// Live foliage color for the automatic season cycle: local winter fades
// chlorophyll toward autumn yellow-orange then a light frost, strongest at
// high latitude and fading to nothing at the equator (real tropical growth
// barely changes with the seasons) regardless of season phase. Applied to
// every plant-colored material (never the mineral/rock/bark ones) as a
// vertex+fragment shader tint — no texture rebake, no CPU work, the same
// onBeforeCompile pattern already used for the ocean's live wave motion in
// main.ts. seasonUniforms is one shared object so every material picks up
// main.ts's single per-frame update automatically.
function applySeasonalFoliageTint(
  material: THREE.MeshStandardMaterial,
  seasonUniforms: { uSeasonTilt: { value: number } },
) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSeasonTilt = seasonUniforms.uSeasonTilt;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vSeasonLat;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        // the instance's own placement on the sphere, not the local blade/
        // leaf geometry around it — instanceMatrix's translation column is
        // this instance's ground point, and every one of these materials is
        // only ever drawn via InstancedMesh
        vSeasonLat = normalize((instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz).y;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uSeasonTilt;\nvarying float vSeasonLat;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          float seasonalFactor = uSeasonTilt * vSeasonLat;
          float fade = clamp(-seasonalFactor, 0.0, 1.0);
          vec3 autumnTint = vec3(0.62, 0.42, 0.12);
          vec3 frostTint = vec3(0.75, 0.8, 0.82);
          vec3 seasoned = mix(diffuseColor.rgb, autumnTint, smoothstep(0.0, 0.55, fade));
          seasoned = mix(seasoned, frostTint, smoothstep(0.55, 1.0, fade));
          diffuseColor.rgb = mix(diffuseColor.rgb, seasoned, smoothstep(0.15, 0.7, abs(vSeasonLat)));
        }`,
      );
  };
}

export function buildSpecies(
  radius: number,
  bumpHeight: number,
  seasonUniforms: { uSeasonTilt: { value: number } },
): THREE.Group {
  const group = new THREE.Group();
  const rand = mulberry32(515151);

  // One hash per layer. Every spacing here is roughly a third of what it
  // was, and every model below is correspondingly smaller: the planet used
  // to carry about 2,700 pieces of vegetation in total, which sounds like a
  // lot until you divide it by the Earth. At that count each piece has to
  // be enormous — the largest forest clumps spanned some three degrees of
  // arc — to add up to anything that reads as green, and the difference
  // between the Amazon and Alberta drowns in the sampling noise of a few
  // dozen items. Smaller and roughly ten times as many reads as applied
  // flock rather than as scattered props, and makes regional density a
  // quantity you can actually see.
  const coreMinSpacing = 0.022;
  const coreMinSpacingSq = coreMinSpacing * coreMinSpacing;
  const coreHash = new SpatialHash(coreMinSpacing);
  const placements: Placement[] = [];

  interface GroundPoint {
    dir: THREE.Vector3;
    height: number;
    /** forest only: boreal/continental climates are conifer, the rest broadleaf */
    coniferous?: boolean;
  }
  interface ScatterPoint extends GroundPoint {
    kind: 'tree' | 'rock';
  }

  // Forest spacing is the one that varies across the globe, because the
  // thing it is modelling does: a rainforest is a closed roof with no gaps
  // and a wooded steppe is individual trees you can walk between, and
  // planting both on the same lattice makes them the same place with
  // different colours. The hash's cell size is the *sparse* end, since the
  // 3x3x3 neighbourhood has to cover the largest distance ever asked for.
  // Tightened from 0.0065 when clearings went in. The two are one change:
  // carving gaps costs canopy only in the gaps, but the closed-canopy areas
  // are packing-limited rather than density-limited — they are already at
  // the spacing's ceiling, so raising density there buys nothing and the
  // planet simply lost 24% of its forest. Packing the stands tighter puts
  // that back where it belongs, which is inside the stands. Same total
  // green, more contrast between wood and clearing.
  const FOREST_SPACING_DENSE = 0.0057;
  // Widened from 0.017. This is the only dial that changes how much forest
  // there *is* in open country, because the layer is a Poisson disc and a
  // Poisson disc does not listen to probability — reject a candidate and
  // the next one takes the place it would have had. Density goes as the
  // inverse square of spacing, so 0.017 -> 0.026 against a dense 0.0057
  // takes the range from 8.9x to 20.8x, which is what lets prairie read as
  // prairie beside a mountain forest instead of as slightly thinner forest.
  const FOREST_SPACING_SPARSE = 0.026;
  // The hash has to be built at the largest spacing anything will ever ask
  // for or it silently misses neighbours three cells away — the note in
  // §7 of the gap analysis. Nothing divides the spacing any more (the old
  // farmland term did), so the sparse value is now the true maximum.
  const FOREST_SPACING_MAX = FOREST_SPACING_SPARSE;
  const forestHash = new SpatialHash(FOREST_SPACING_MAX);
  const forestPoints: GroundPoint[] = [];

  // Grass spacing varies the way the forest's does, and for the same
  // reason: this is a Poisson-disc layer, so the probability test above it
  // decides almost nothing once the disc is the binding constraint. With a
  // single fixed spacing the grass came out at the same density on the
  // Kazakh steppe as under the Appalachian canopy — measured 1.83 against
  // 2.74, i.e. *more* grass in the woods than on the grassland. A steppe
  // has to be visibly grassier than a forest floor or there is no
  // grassland biome, only a texture that happens to be allowed everywhere.
  const GRASS_SPACING_OPEN = 0.0085;
  const GRASS_SPACING_UNDER_TREES = 0.018;
  const grassHash = new SpatialHash(GRASS_SPACING_UNDER_TREES);
  const grassPoints: GroundPoint[] = [];

  // savanna trees and mountain rocks share one hash, as they did before —
  // they never occur in the same place, so nothing is lost keeping them
  // out of each other's way with a single spacing.
  const pointsMinSpacing = 0.045;
  const pointsMinSpacingSq = pointsMinSpacing * pointsMinSpacing;
  const pointsHash = new SpatialHash(pointsMinSpacing);
  const points: ScatterPoint[] = [];

  const screeMinSpacing = 0.013;
  const screeMinSpacingSq = screeMinSpacing * screeMinSpacing;
  const screeHash = new SpatialHash(screeMinSpacing);
  const screePoints: GroundPoint[] = [];

  const dir = new THREE.Vector3();

  // Sized to the old forest pass's own candidate count (340,000) — the
  // densest of the five sweeps this replaces, and now the only sweep
  // there is. Every layer below tests the same stream independently
  // (no layer consumes a candidate the others wanted), so each ends up
  // sampled at least as well as it was from its own dedicated sweep,
  // for roughly half the combined candidate count the five sweeps used.
  //
  // Was cut hard chasing a crash on a real device that turned out to be
  // caused by shadow mapping specifically, not by scene weight (see
  // SETTINGS in main.ts and renderer.shadowMap.enabled in main.ts) —
  // restored most of the way back now that shadows are off there instead.
  //
  // Raised again with the spacings above: a Poisson-disk scatter only
  // reaches its packing limit if the candidate stream oversamples it
  // several times over, so cutting the spacings without raising this would
  // have bought a fraction of the density the smaller spacing allows.
  const CANDIDATES = 900000;

  for (let i = 0; i < CANDIDATES; i++) {
    const z = rand() * 2 - 1;
    const t = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    dir.set(r * Math.cos(t), z, r * Math.sin(t));

    const s = sampleAt(dir);
    if (!s) continue; // open ocean, deeper than the shelf: nothing goes here

    // Cities clear the ground they stand on.
    //
    // The paint layer draws a grey urban patch (terrain.ts, urbanAt) but
    // the scatter used to keep flocking trees straight through it, so Tokyo
    // and São Paulo were grey smudges with a full forest still standing on
    // top of them — which reads as a decal slid under the greenery rather
    // than as a place. Both systems now read the same field, so the paint
    // and the clearing cannot drift apart.
    //
    // Probabilistic rather than a hard radius: `urban` falls off smoothly
    // from the centre, so trees thin out through the suburbs and the last
    // few survive at the edge, instead of the city ending at a circle with
    // a wall of forest around it. Only ever draws from the random stream
    // inside a city, so the other 99% of the planet is bit-for-bit
    // unchanged by this.
    // The gain matters. `urbanAt` is tuned for *paint*, where the patch is
    // deliberately faint — a souvenir globe shows a city as a smudge, not
    // as a street map — and it only approaches 1 at the exact centre of the
    // largest cities. Clearing at that raw strength measured as a 27%
    // thinning of the core, which is not a clearing at all; the trees were
    // still standing on top of the grey. Ground cover is the opposite case
    // from paint: where a city is built, the ground is built on. Scaled up
    // until it saturates across the built-up core, measured over all 28
    // cities: trees within 0.012 rad of centre −80%, the 0.012–0.022 ring
    // −30% (the ragged edge, which is the point — a shaved circle would read
    // as a crop mark), ground beyond 0.06 rad −0.2%, whole-planet forest
    // −0.4%. Grass is thinned rather than cleared: the parks and verges
    // left behind are what keep a cleared patch from looking scorched.
    //
    // Note the patches are small — about 0.018 rad even for Tokyo — so any
    // measurement of this has to use city-sized bands. Averaged over a
    // 0.03 rad cap the effect vanishes into ground that was never urban.
    const urban = Math.min(1, urbanAt(dir) * 3.4);
    // Farmland used to be thinned here, off habitabilityAt alone, and it
    // has moved into openLandAt (terrain.ts) where it is multiplied by
    // flatness. It could not stay: settlement on its own points the wrong
    // way. Measured, the Appalachians score 0.842 habitable and Iowa 0.645,
    // because the field counts the eastern seaboard's cities — so the term
    // meant to clear the Corn Belt was thinning the Blue Ridge at 0.62 and
    // the Corn Belt at 0.37, pulling hardest on the one region that should
    // not have moved. That is most of why North America came out uniform.
    //
    // Nothing replaces it in this file. `s.canopy` is already the reduced
    // field, so the spacing below opens over farmland without being told
    // about farmland twice.
    const clearedByCity = (strength: number) => strength > 0 && rand() < strength;

    // ---- species classification, then the regional icons on top ----
    // The order matters: the icons stand in for what the climate already
    // decided, so everything below — clearing, thinning, spacing —
    // applies to a baobab exactly as it did to the acacia it replaced.
    const species = regionalIcon(s, classify(s, rand), rand);

    if (species && !clearedByCity(urban) && !coreHash.hasNeighborWithin(dir, coreMinSpacingSq)) {
      const point = dir.clone();
      coreHash.add(point);
      placements.push({ dir: point, height: s.height, species });
    }

    if (s.underwater) continue; // nothing below covers open water

    // There is no elevation test on any land layer below. Being above the
    // waterline (the `underwater` check above) is the whole of it.
    //
    // Each layer used to add its own margin on top — `height >= SEA_LEVEL +
    // 0.02` for forest, +0.015 for scattered trees, +0.012 for grass — left
    // over from the era when the continents were noise and "land" meant
    // "hill". Against real elevation data those are a different rule
    // entirely, because real continents are mostly flat lowland: measured,
    // the forest one alone rejected 75% of all climatically suitable ground,
    // and it rejected it in exactly the wrong places. The Amazon basin, the
    // Congo basin, the Ganges plain, the pampas and the Sahel are all low
    // and flat and all came out bare, while Alaska and Tibet, being high,
    // came out as the densest forest on the planet — the Amazon measured at
    // one thirty-fourth of Alaska's forest density, which is the exact
    // inverse of the truth. Even a margin as narrow as the painted beach
    // band (COAST_WIDTH, 0.006) is too wide: the Congo basin's own mean
    // height above sea level is 0.007.

    // ---- forest canopy: a dense, clumped, overlapping mass ----
    if (
      s.elevation <= 0.15 &&
      s.temperature >= COLD_TEMPERATURE_LIMIT &&
      s.badlands <= BADLANDS_THRESHOLD
    ) {
      // Which regions are wooded at all is no longer a noise field's
      // opinion — it is the real Köppen climate map (terrain.ts). That is
      // the difference between "somewhere around this latitude there is
      // probably forest" and the Amazon being solid canopy, the Sahara
      // having none, and the boreal belt running unbroken across Alaska,
      // Canada and Siberia. A finer noise field still breaks up the
      // margins within a wooded region, because a real forest edge is
      // ragged rather than a contour line.
      //
      // The separate `arid <= FOREST_ARIDITY_MAX` veto that used to sit
      // alongside this is gone: canopy and aridity are two readings of the
      // same climate table, so it was a second vote by the same voter, and
      // because aridity carries a noise wobble it was cancelling forest at
      // the wet margins (south China's Cw belt in particular) that the
      // canopy figure said should be there.
      const patch = fbm3(dir.x * 9 + 77, dir.y * 9 + 77, dir.z * 9 + 77, 2);
      // Clearings. The patch term above never reaches zero (its floor is
      // 1.5x), so anywhere the climate said "closed canopy" got closed
      // canopy, everywhere, and the result was an unbroken sheet of green
      // with no shape to it. A real forest at this scale has burns, blowdowns,
      // river courses and bare ridges through it, and those gaps are what
      // let the eye read the canopy as a surface with relief instead of as
      // a flat fill. Much lower frequency than `patch`, because the gaps
      // have to be big enough to survive at globe scale.
      const clearing = smoothstep(
        fbm3(dir.x * 3.5 + 401, dir.y * 3.5 + 401, dir.z * 3.5 + 401, 2),
        0.33,
        0.44,
      );
      // The multiplier keeps the planet's total canopy roughly where the
      // census put it — the point is to redistribute the same green into
      // stands with gaps between them, not to have less of it.
      const density = s.canopy * (1.5 + patch * 1.5) * (0.55 + clearing * 0.75);
      // Closed canopy packs tight, open woodland stands apart.
      //
      // Farmland opens it further, and it has to do that *here*, in the
      // spacing, rather than by rejecting candidates. A closed stand is
      // packing-limited: throw a candidate away and the next one along
      // simply takes the place it would have had, so a rejection test
      // measured a 44% thinning over the Ganges and removed 2% of the
      // trees. Distance is the only thing a Poisson-disc layer listens to.
      // Not linear in the canopy, and that is the difference between
      // giving the continents contrast and just deleting forest.
      //
      // A straight lerp moves every stand at once: widening the sparse end
      // far enough for prairie to read as prairie also pulled the Amazon,
      // the taiga and the Blue Ridge apart, and the planet lost 40% of its
      // trees to buy a 3.5x spread. What is wanted is a threshold, because
      // that is what real forest does — closed canopy is packing-limited
      // and stays closed until the climate genuinely stops supporting it,
      // then opens quickly. So anything above about 0.7 canopy packs at
      // the dense spacing regardless, and the whole range of the dial is
      // spent between 0.05 and 0.7 where the woodland/grassland margin
      // actually lives.
      const closed = THREE.MathUtils.smoothstep(s.canopy, 0.05, 0.7);
      const spacing = THREE.MathUtils.lerp(
        FOREST_SPACING_SPARSE,
        FOREST_SPACING_DENSE,
        closed,
      );
      if (
        rand() < density &&
        !clearedByCity(urban) &&
        !forestHash.hasNeighborWithin(dir, spacing * spacing)
      ) {
        const point = dir.clone();
        forestHash.add(point);
        forestPoints.push({ dir: point, height: s.height, coniferous: s.coniferous });
      }
    }

    // ---- grass: dense tiny tufts covering the open, non-desert ground ----
    // The two vetoes that used to stand here were `badlands <= 0.28` and
    // `arid <= DESERT_ARIDITY_THRESHOLD` (0.52), and between them they cut
    // the planet's grasslands out of the grass layer twice over. BSk is
    // 0.58 arid and 0.85 badlands, BSh is 0.64 and 0.45: the steppe classes
    // fail both tests, so the Eurasian steppe, the Sahel, the pampas and
    // the western Great Plains were held to be sand-and-rock. Steppe is the
    // word for grassland; it is the one biome that should never have been
    // asked whether it is dry enough for grass.
    //
    // Real desert still has to stay bare, so the dryness test is kept and
    // moved out to where the desert actually is. BW is 0.90-0.97 arid
    // against the steppe's 0.58-0.64, so a threshold between them separates
    // the two cleanly where 0.52 could not. Badlands stay a veto only where
    // the rock is genuinely dominant rather than merely present.
    if (
      s.elevation <= 0.16 &&
      s.temperature >= COLD_TEMPERATURE_LIMIT &&
      s.badlands <= BADLANDS_GRASS_LIMIT &&
      s.arid <= GRASS_ARIDITY_LIMIT
    ) {
      // Grass covers the ground the canopy does not. The old test asked
      // for aridity inside a band 0.08 wide between the forest and desert
      // thresholds — and on the real Köppen aridity table almost no class
      // lands in that band, which is why the entire planet's prairie,
      // steppe and savanna floor came to 165 tufts. Driving it off canopy
      // instead puts grass wherever there is a gap in the trees and no
      // sand, thinning to nothing under closed forest rather than stopping
      // at a contour line.
      const openness = 1 - THREE.MathUtils.clamp(s.canopy, 0, 1);
      const grassSpacing = THREE.MathUtils.lerp(
        GRASS_SPACING_UNDER_TREES,
        GRASS_SPACING_OPEN,
        THREE.MathUtils.smoothstep(openness, 0.25, 0.85),
      );
      if (
        rand() < openness * clumpDensity(dir, 199) &&
        !clearedByCity(urban * 0.55) &&
        !grassHash.hasNeighborWithin(dir, grassSpacing * grassSpacing)
      ) {
        const point = dir.clone();
        grassHash.add(point);
        grassPoints.push({ dir: point, height: s.height });
      }
    }

    // ---- savanna trees / mountain rocks ----
    {
      if (s.elevation < 0.15) {
        if (
          s.temperature >= COLD_TEMPERATURE_LIMIT &&
          s.badlands <= BADLANDS_THRESHOLD &&
          s.arid <= DESERT_ARIDITY_THRESHOLD
        ) {
          // Open woodland — scattered individual trees standing over
          // grass, which is what a savanna and a wooded steppe are. That
          // is a statement about tree cover, so it reads tree cover: a
          // middling canopy fraction, neither closed forest (whose mass
          // the canopy layer supplies) nor treeless.
          const openWoodland =
            smoothstep(s.canopy, 0.06, 0.28) * (1 - smoothstep(s.canopy, 0.45, 0.78));
          if (
            rand() < openWoodland * clumpDensity(dir, 163) &&
            !clearedByCity(urban) &&
            !pointsHash.hasNeighborWithin(dir, pointsMinSpacingSq)
          ) {
            const point = dir.clone();
            pointsHash.add(point);
            points.push({ dir: point, height: s.height, kind: 'tree' });
          }
        }
      } else if (s.snow <= 0.35) {
        // Snow buries loose rock; strewing dark boulders across a white
        // field reads as pepper spilled on it.
        if (rand() < clumpDensity(dir, 179) && !pointsHash.hasNeighborWithin(dir, pointsMinSpacingSq)) {
          const point = dir.clone();
          pointsHash.add(point);
          points.push({ dir: point, height: s.height, kind: 'rock' });
        }
      }
    }

    // ---- scree: loose rubble covering rocky/mountain slopes ----
    if (s.elevation >= 0.15 && s.snow <= 0.35) {
      if (rand() < clumpDensity(dir, 191) && !screeHash.hasNeighborWithin(dir, screeMinSpacingSq)) {
        const point = dir.clone();
        screeHash.add(point);
        screePoints.push({ dir: point, height: s.height });
      }
    }
  }

  // ======================================================================
  // Build meshes
  // ======================================================================

  // ---- fourteen species: two shared materials, one InstancedMesh each ----

  const plantMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.93,
    envMapIntensity: 0.1,
  });
  applySeasonalFoliageTint(plantMaterial, seasonUniforms);
  const mineralMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.85,
    flatShading: true,
    envMapIntensity: 0.14,
  });

  const bySpecies = new Map<Species, Placement[]>();
  placements.forEach((p) => {
    const list = bySpecies.get(p.species);
    if (list) list.push(p);
    else bySpecies.set(p.species, [p]);
  });

  const color = new THREE.Color();
  bySpecies.forEach((list, species) => {
    const geometry = buildModel(species, rand);
    const material = MINERAL.has(species) ? mineralMaterial : plantMaterial;
    const mesh = new THREE.InstancedMesh(geometry, material, list.length);

    list.forEach((p, i) => {
      // Floating species sit at sea level; everything else stands on the
      // ground, sunk slightly so it does not read as placed on top of it.
      const floats = p.species === 'iceFloe' || p.species === 'mangrove';
      const surface = floats
        ? radius + (SEA_LEVEL - 0.015) * bumpHeight
        : radius + sampledHeight(p.dir).display * bumpHeight - 0.004;
      dummy.position.copy(p.dir).multiplyScalar(surface);
      const align = new THREE.Quaternion().setFromUnitVectors(up, p.dir);
      // A random bearing is right for almost everything that stands on the
      // ground — a tree has no reason to face anywhere in particular. Sand
      // does: dune crests in an erg run parallel because one prevailing
      // wind built all of them, and a dune field with every ridge pointing
      // a different way stops reading as a landform and becomes a scatter
      // of loose objects. Only the small jitter stays random.
      const spinAngle =
        species === 'dune' ? duneBearing(p.dir) + (rand() - 0.5) * 0.45 : rand() * Math.PI * 2;
      const spin = new THREE.Quaternion().setFromAxisAngle(p.dir, spinAngle);
      dummy.quaternion.copy(spin).multiply(align);
      // Smaller than before, across the board — see the spacing block in
      // buildSpecies. Each specimen carried more of the visual load when
      // there were a couple of thousand of them on the whole globe; at ten
      // times the count the same footprint would merge into a solid crust.
      const sc = 0.6 + rand() * rand() * 0.85;
      dummy.scale.set(sc, sc * (0.85 + rand() * 0.4), sc);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      const temperature = temperatureAt(p.dir, terracedElevation(p.height));
      speciesColor(species, temperature, color);
      color.offsetHSL(0, (rand() - 0.5) * 0.05, (rand() - 0.5) * 0.09);
      mesh.setColorAt(i, color);
    });

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  });

  // ---- savanna trees: 3 archetypes mixed by pseudo-climate + chance ----
  // (a tall pointy cone looked fine from directly above, but at the
  // sphere's silhouette edge — where we're looking almost along the
  // surface — a ring of them stands straight out sideways into a comical
  // "spike wall". Short + rounded keeps the grazing-angle silhouette calm.)

  const trees = points.filter((p) => p.kind === 'tree');
  const rocks = points.filter((p) => p.kind === 'rock');

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
  applySeasonalFoliageTint(foliageMaterial, seasonUniforms);

  // real diorama foliage ("clump foliage" flock/lichen material) is a
  // distinctly bright, saturated yellow-green — noticeably more lime than
  // an ordinary tree green, and part of what makes a miniature's
  // vegetation read as a real physical material instead of rendered grass
  const treeVariants: { geometry: THREE.BufferGeometry; hue: [number, number] }[] = [
    { geometry: bushGeometry, hue: [0.235, 0.045] },
    { geometry: coniferGeometry, hue: [0.28, 0.025] },
    { geometry: clumpGeometry, hue: [0.225, 0.04] },
  ];
  const treeByVariant: GroundPoint[][] = treeVariants.map(() => []);
  trees.forEach((p) => {
    const coolness = Math.abs(p.dir.y); // stand-in for latitude
    let variant = rand() < 0.35 ? 2 : 0; // base mix: bush or clump
    if (rand() < coolness * 0.8 + 0.05) variant = 1; // conifers lean polar
    treeByVariant[variant].push(p);
  });

  const trunkMesh = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, trees.length);
  let trunkIndex = 0;
  // Note on the `THREE.SRGBColorSpace` argument passed to every setHSL
  // below: three's working color space is linear-sRGB, so setHSL's default
  // treats the lightness/saturation you give it as *linear* values. Naming
  // sRGB explicitly makes the numbers mean what they look like in a color
  // picker instead of coming out as glowing neon lime.
  const foliageColor = new THREE.Color();

  treeVariants.forEach((variant, vi) => {
    const pts = treeByVariant[vi];
    if (pts.length === 0) return;
    const foliageMesh = new THREE.InstancedMesh(variant.geometry, foliageMaterial, pts.length);
    pts.forEach((p, i) => {
      const surfaceRadius = radius + sampledHeight(p.dir).display * bumpHeight;
      const position = p.dir.clone().multiplyScalar(surfaceRadius);
      const scale = 0.42 + rand() * 0.45;
      orient(position, p.dir, rand() * Math.PI * 2);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      trunkMesh.setMatrixAt(trunkIndex++, dummy.matrix);
      foliageMesh.setMatrixAt(i, dummy.matrix);
      // a little per-tree color variance so a forest doesn't look like one
      // flat-shaded cutout repeated hundreds of times
      foliageColor.setHSL(variant.hue[0] + rand() * variant.hue[1], 0.48 + rand() * 0.14, 0.26 + rand() * 0.12, THREE.SRGBColorSpace);
      foliageMesh.setColorAt(i, foliageColor);
    });
    foliageMesh.instanceMatrix.needsUpdate = true;
    if (foliageMesh.instanceColor) foliageMesh.instanceColor.needsUpdate = true;
    group.add(foliageMesh);
  });
  trunkMesh.instanceMatrix.needsUpdate = true;
  group.add(trunkMesh);

  // ---- mountain rocks: 2 archetypes — angular boulders + flatter slabs ----

  const boulderGeometry = new THREE.IcosahedronGeometry(0.026, 0);
  const slabGeometry = new THREE.IcosahedronGeometry(0.028, 0);
  slabGeometry.scale(1.15, 0.6, 1.0);

  const rockMaterial = new THREE.MeshStandardMaterial({
    // white on purpose: instanceColor multiplies against this, so a tinted
    // base here compounds with the per-instance color and darkens it.
    color: '#ffffff',
    roughness: 0.95,
    flatShading: true,
    envMapIntensity: 0.1,
  });

  const rockVariants = [boulderGeometry, slabGeometry];
  const rockByVariant: GroundPoint[][] = rockVariants.map(() => []);
  rocks.forEach((p) => rockByVariant[rand() < 0.4 ? 1 : 0].push(p));
  const rockColor = new THREE.Color();

  rockVariants.forEach((geo, vi) => {
    const pts = rockByVariant[vi];
    if (pts.length === 0) return;
    const rockMesh = new THREE.InstancedMesh(geo, rockMaterial, pts.length);
    pts.forEach((p, i) => {
      // Sunk, not set down — a rock resting *on* smooth ground reads as a
      // separate object dropped there. Real outcrops emerge from the
      // ground, so bury most of each one and let only its crown break
      // the surface.
      const surfaceRadius = radius + sampledHeight(p.dir).display * bumpHeight - 0.016;
      const position = p.dir.clone().multiplyScalar(surfaceRadius);
      orient(position, p.dir, rand() * Math.PI * 2, (rand() - 0.5) * 0.7, rand() * Math.PI * 2);
      dummy.scale.set(0.5 + rand() * 1.0, 0.4 + rand() * 0.5, 0.5 + rand() * 1.0);
      dummy.updateMatrix();
      rockMesh.setMatrixAt(i, dummy.matrix);
      rockColor.setHSL(0.08 + rand() * 0.03, 0.13 + rand() * 0.06, 0.36 + rand() * 0.1, THREE.SRGBColorSpace);
      rockMesh.setColorAt(i, rockColor);
    });
    rockMesh.instanceMatrix.needsUpdate = true;
    if (rockMesh.instanceColor) rockMesh.instanceColor.needsUpdate = true;
    group.add(rockMesh);
  });

  // ---- scree: dense loose rubble covering rocky/mountain slopes ----

  const screeGeometry = new THREE.IcosahedronGeometry(0.008, 0);
  const screeMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.97,
    flatShading: true,
    envMapIntensity: 0.08,
  });
  const screeMesh = new THREE.InstancedMesh(screeGeometry, screeMaterial, screePoints.length);
  const screeColor = new THREE.Color();
  screePoints.forEach((p, i) => {
    const surfaceRadius = radius + sampledHeight(p.dir).display * bumpHeight - 0.004;
    const position = p.dir.clone().multiplyScalar(surfaceRadius);
    orient(position, p.dir, rand() * Math.PI * 2, (rand() - 0.5) * 0.5, rand() * Math.PI * 2);
    dummy.scale.set(0.6 + rand() * 1.0, 0.5 + rand() * 0.7, 0.6 + rand() * 1.0);
    dummy.updateMatrix();
    screeMesh.setMatrixAt(i, dummy.matrix);
    screeColor.setHSL(0.075 + rand() * 0.03, 0.14 + rand() * 0.06, 0.32 + rand() * 0.1, THREE.SRGBColorSpace);
    screeMesh.setColorAt(i, screeColor);
  });
  screeMesh.instanceMatrix.needsUpdate = true;
  if (screeMesh.instanceColor) screeMesh.instanceColor.needsUpdate = true;
  group.add(screeMesh);

  // ---- forest: big clumped canopy masses, not a solid blanket ----
  // A real diorama's foliage clumps are substantial individual masses
  // with visible bare rock between and around them. Two tessellations,
  // chosen per clump by how big it is: a clump's faces only become
  // visible when it covers enough pixels for one triangle to be several
  // across, and the scale distribution has a long tail — most clumps are
  // small, a few are several times their neighbours. Giving every clump
  // enough vertices to satisfy the largest was what made foliage seventy
  // percent of the frame; giving them all the cheap one leaves the big
  // ones reading as chips of green glass. Spend the triangles only where
  // they can be seen.
  const CANOPY_FINE_SCALE = 1.1;
  const canopyVariantCount = 3;
  const coarseVariants = Array.from({ length: canopyVariantCount }, () => buildCanopyBlob(rand, 1));
  const fineVariants = Array.from({ length: 2 }, () => buildCanopyBlob(rand, 2));
  const canopyMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.92,
    envMapIntensity: 0.1,
  });
  applySeasonalFoliageTint(canopyMaterial, seasonUniforms);

  interface CanopyInstance {
    point: GroundPoint;
    scale: number;
  }
  const coarseBuckets: CanopyInstance[][] = Array.from({ length: canopyVariantCount }, () => []);
  const fineBuckets: CanopyInstance[][] = Array.from({ length: 2 }, () => []);

  forestPoints.forEach((point, i) => {
    // Measured, a flat range put the middle half of all clumps between 0.66
    // and 1.17 — a third either side of the median, which the eye cannot
    // tell from a single size. Squaring gives the long tail real applied
    // flock has: mostly small stuff, with occasional masses several times
    // the size of their neighbours.
    // Halved from 0.45 + r^2 * 1.9: the largest clumps under that curve
    // spanned roughly three degrees of arc, one single piece of foliage
    // covering more of the globe than Lake Victoria. Halving the linear
    // size quarters the area each one covers, which is what buys the room
    // for the count to go up by an order of magnitude without the canopy
    // turning into an unbroken shell.
    // Squaring was an improvement on a flat range but not enough of one:
    // it still put the middle half of all clumps between 0.30 and 0.77,
    // and a mass of objects within a factor of two of each other reads as
    // a texture rather than as a collection of things. That is most of why
    // the forest came out as a uniform carpet with no hierarchy in it.
    //
    // Cubing pushes the bulk smaller and lets a thin tail run much larger,
    // which is the shape real applied flock has and, in a rainforest, the
    // shape the thing being modelled has: a floor of ordinary canopy with
    // occasional emergents standing clear above it. Only about one clump in
    // twenty exceeds 1.5. The old curve's ceiling of 1.19 is still cleared,
    // but nowhere near the 2.35 of the version that turned the canopy into
    // an unbroken shell.
    const r0 = rand();
    // The offset matters as much as the exponent, and the first attempt at
    // this got it wrong. Cubing alone (0.2 + r^3 * 1.5) pulled the *typical*
    // clump from 0.72 down to 0.39, and since coverage goes as the square of
    // the linear size, the canopy lost most of its body — the Amazon came
    // out as scattered broccoli rather than jungle, which trades one wrong
    // read for a worse one. The tail is what was wanted, not the shrinkage:
    // keep the bulk where the census had it and let only the top few percent
    // run away.
    const scale = 0.42 + r0 * r0 * r0 * 1.3;
    const instance = { point, scale };
    if (scale >= CANOPY_FINE_SCALE) fineBuckets[i % 2].push(instance);
    else coarseBuckets[i % canopyVariantCount].push(instance);
  });

  const canopyColor = new THREE.Color();
  const placeCanopy = (variants: THREE.BufferGeometry[], buckets: CanopyInstance[][]) => {
    buckets.forEach((list, vi) => {
      if (list.length === 0) return;
      const mesh = new THREE.InstancedMesh(variants[vi], canopyMaterial, list.length);
      list.forEach(({ point, scale }, i) => {
        const surfaceRadius = radius + sampledHeight(point.dir).display * bumpHeight;
        const position = point.dir.clone().multiplyScalar(surfaceRadius);
        orient(position, point.dir, rand() * Math.PI * 2);
        // A taiga does not look like a jungle from above, and the
        // difference is entirely in the proportion: spruce is tall and
        // narrow, broadleaf canopy is wide and domed. Stretching the same
        // clump geometry along its own normal gets that for nothing —
        // no extra variant, no extra draw call — now that the climate map
        // says which of the two a given stand actually is. Gently: the
        // clumps are displaced spheres, and stretching one hard turns its
        // displacement into spikes, so the boreal belt came out as a field
        // of golden thorns rather than as spruce.
        if (point.coniferous) dummy.scale.set(scale * 0.78, scale * 1.35, scale * 0.78);
        else dummy.scale.setScalar(scale);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        // Foliage colour follows the climate it grows in, not one palette
        // sprayed over the whole planet — a jungle, a temperate wood and a
        // taiga are three different greens. The lightness spread on top is
        // per-clump light and shade.
        const climate = canopyClimate(point.dir, terracedElevation(point.height));
        canopyColor.setHSL(
          climate.hue + rand() * 0.03,
          climate.saturation + rand() * 0.12,
          // Widened from 0.11. Per-clump light and shade is the only thing
          // standing in for the shadows the canopy cannot cast (see the
          // shadow-map note in main.ts), and at 0.11 the whole mass sat in
          // one value band, which is the other half of why it read flat.
          climate.lightness - 0.05 + rand() * 0.22,
          THREE.SRGBColorSpace,
        );

        // Shade inside the canopy, as opposed to shade scattered across it.
        //
        // The lightness spread above is per-clump `rand()`, so it is white
        // noise: it varies every neighbouring clump against every other and
        // therefore reads as speckle on one flat mass, not as a mass with
        // depth. A forest's actual value structure is the opposite of white
        // noise — it is strongly *organised*. The floor of a closed stand is
        // dark because its neighbours roof it over; the margin of the same
        // stand is bright because each crown there still sees the sky; and
        // the emergents that stand clear above the roof are the brightest
        // thing in it. None of that was represented, which is why the census
        // could put eleven thousand instances in the Amazon and still have it
        // read as one bright green carpet.
        //
        // This is the same argument as the ground shade the terrain paint now
        // carries, and it has to be made here as well as there for a reason
        // measurement made plain: at this density the paint is almost
        // entirely *hidden* by the instances standing on it, so darkening the
        // ground alone changes what you see between the trees and nothing
        // about the trees themselves. The two together are the effect.
        //
        // Three terms, all free — no geometry, no material, no draw call,
        // just the instance colour that was already being written:
        //  - `closed` is how much roof the climate says is over this point,
        //    the same field the spacing is drawn from;
        //  - `buried` keys off the size hierarchy the scale curve above
        //    already built, so the small clumps that make up the floor take
        //    the shading and the rare emergents keep their light;
        //  - `patch` is spatially coherent rather than per-instance, which is
        //    the whole difference between shadow and speckle. Its frequency
        //    matches the mid-scale term the scatter's own clumping uses, so
        //    the dark patches are the size of the stands, not of the clumps.
        const closed = canopyAt(point.dir);
        if (closed > 0.05) {
          const buried = 1 - smoothstep(scale, 0.55, 1.35);
          const patch = fbm3(
            point.dir.x * 13 + 5150,
            point.dir.y * 13 + 5150,
            point.dir.z * 13 + 5150,
            2,
          );
          const shade = closed * buried * (0.62 + patch * 0.5);
          // Multiplied, not subtracted. THREE.Color works in linear space, so
          // taking a constant off the lightness of an already-dark taiga
          // green clamps it to black while barely touching a bright one — the
          // terrain paint hit exactly that and came back wearing keylines.
          canopyColor.multiplyScalar(1 - 0.42 * Math.max(shade, 0));
        }
        mesh.setColorAt(i, canopyColor);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      group.add(mesh);
    });
  };
  placeCanopy(coarseVariants, coarseBuckets);
  placeCanopy(fineVariants, fineBuckets);

  // ---- grass: dense tiny tufts covering the (non-desert) ground ----

  const grassGeometry = new THREE.ConeGeometry(0.005, 0.013, 5);
  grassGeometry.translate(0, 0.0065, 0);
  const grassMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.9,
    envMapIntensity: 0.08,
  });
  applySeasonalFoliageTint(grassMaterial, seasonUniforms);
  const grassMesh = new THREE.InstancedMesh(grassGeometry, grassMaterial, grassPoints.length);
  const grassColor = new THREE.Color();
  grassPoints.forEach((p, i) => {
    const surfaceRadius = radius + sampledHeight(p.dir).display * bumpHeight;
    const position = p.dir.clone().multiplyScalar(surfaceRadius);
    orient(position, p.dir, rand() * Math.PI * 2);
    dummy.scale.set(0.7 + rand() * 0.9, 0.5 + rand() * 1.0, 0.7 + rand() * 0.9);
    dummy.updateMatrix();
    grassMesh.setMatrixAt(i, dummy.matrix);
    const gc = canopyClimate(p.dir, terracedElevation(p.height));
    grassColor.setHSL(
      gc.hue + rand() * 0.03,
      gc.saturation * 0.92 + rand() * 0.1,
      gc.lightness * 0.92 + rand() * 0.08,
      THREE.SRGBColorSpace,
    );
    grassMesh.setColorAt(i, grassColor);
  });
  grassMesh.instanceMatrix.needsUpdate = true;
  if (grassMesh.instanceColor) grassMesh.instanceColor.needsUpdate = true;
  group.add(grassMesh);

  return group;
}
