import * as THREE from 'three';
import { fbm3 } from './noise';
import { mulberry32 } from './spatialHash';

// Tuned so land covers roughly 30% of the surface, like real Earth's
// land:sea ≈ 3:7 (verified empirically against heightAt's noise distribution).
export const SEA_LEVEL = 0.072;
const COAST_WIDTH = 0.006;

// Toned down across the board — high-saturation primary colors are what
// made this read as "cheap mobile game" regardless of how much detail
// sat on top of them. Real terrain photography has much narrower,
// muddier, more correlated color ranges than a clean color wheel.
const shoreColor = new THREE.Color('#a89b80');
// muted/soil-toned on purpose — the vivid green now comes from actually
// covering the ground in grass/tree instances, not from painting the
// terrain itself bright green underneath them
const landColor = new THREE.Color('#6a6a50');
// Two separate deserts, because sand and stone desert look nothing alike:
// pale wind-sorted sand, and the darker gravel pavement that surrounds it.
const desertColor = new THREE.Color('#c0a878');
const desertGravelColor = new THREE.Color('#8a7554');
// Warm sedimentary rock, for the foothills a forest could grow on.
const rockColor = new THREE.Color('#6f5c4a');
// Alpine stone is a *different rock*, and it is the difference the eye
// reads first at altitude: cold grey granite scoured bare, not the warm
// brown of a lowland outcrop. Colouring high ground as merely a darker
// version of the same brown is what made every mountain read as a big hill.
const alpineRockColor = new THREE.Color('#7a7a80');
const alpineShadowColor = new THREE.Color('#4e5058');
// Boreal forest floor: needle litter and peat, much darker and cooler than
// temperate soil.
const taigaColor = new THREE.Color('#4a5344');
// Tropical soil: the red laterite that shows through equatorial jungle.
const tropicalSoilColor = new THREE.Color('#6b5138');
const snowColor = new THREE.Color('#e7eef2');
const riverColor = new THREE.Color('#3184a0');
const tundraColor = new THREE.Color('#8b8a6e');
const iceColor = new THREE.Color('#dce8ee');
// exposed sedimentary rock strata — badlands/canyon country
const badlandsColorA = new THREE.Color('#6f5b47');
const badlandsColorB = new THREE.Color('#948269');
const badlandsColorC = new THREE.Color('#5e463a');

// Rich, saturated sapphire blue — darker in the depths but never reading
// as black; a real poured-resin ocean over blue paint keeps its color
// even in shadow; only the *highlight* should go near-white, not the
// whole sea.
const deepOceanColor = new THREE.Color('#0e3a5c');
const midOceanColor = new THREE.Color('#186a95');
const shallowOceanColor = new THREE.Color('#3ba3b6');

// The seabed, which until now was painted one flat blue on the assumption
// that nothing would ever see it. In the reference photograph the resin is
// the most obviously *physical* material on the model precisely because you
// can see down through it: pale sand right off the beach, going silty and
// then dark as the shelf drops away. Painting the floor and then letting
// the water's own opacity vary with depth is what produces that read — a
// uniformly opaque sheet of blue is a painted ball no matter how glossy.
const seabedSandColor = new THREE.Color('#96917a');
const seabedSiltColor = new THREE.Color('#4a6357');
const seabedDeepColor = new THREE.Color('#2b3d47');

function smoothstep(x: number, edge0: number, edge1: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------
// Great mountain belts: instead of a random noise threshold scattering
// tall bumps anywhere, a couple of explicit arcs are drawn across the
// sphere (like an artist deciding "the range runs here") — the same way
// real orogenic belts are specific lines where two plates actually
// collided (Himalaya, Andes), not an evenly-distributed phenomenon.
// Every other point on the planet only cares "how close am I to one of
// these arcs", which reads as one coherent mountain chain rather than
// scattered unrelated peaks.
// ---------------------------------------------------------------------

function slerpDir(a: THREE.Vector3, b: THREE.Vector3, t: number): THREE.Vector3 {
  const dot = THREE.MathUtils.clamp(a.dot(b), -1, 1);
  const theta = Math.acos(dot) * t;
  if (theta === 0) return a.clone();
  const relative = b.clone().addScaledVector(a, -dot).normalize();
  return a.clone().multiplyScalar(Math.cos(theta)).addScaledVector(relative, Math.sin(theta));
}

function buildBeltSamples(controlPoints: THREE.Vector3[], segmentsPerSpan: number): THREE.Vector3[] {
  const samples: THREE.Vector3[] = [];
  for (let i = 0; i < controlPoints.length - 1; i++) {
    for (let s = 0; s <= segmentsPerSpan; s++) {
      samples.push(slerpDir(controlPoints[i], controlPoints[i + 1], s / segmentsPerSpan));
    }
  }
  return samples;
}

const MOUNTAIN_BELT_A = [
  new THREE.Vector3(0.9, 0.25, -0.35),
  new THREE.Vector3(0.55, 0.5, -0.05),
  new THREE.Vector3(0.15, 0.62, 0.35),
  new THREE.Vector3(-0.2, 0.55, 0.68),
  new THREE.Vector3(-0.55, 0.35, 0.78),
].map((v) => v.normalize());

const MOUNTAIN_BELT_B = [
  new THREE.Vector3(-0.6, -0.2, 0.75),
  new THREE.Vector3(-0.3, -0.5, 0.55),
  new THREE.Vector3(0.05, -0.68, 0.25),
  new THREE.Vector3(0.35, -0.62, -0.15),
].map((v) => v.normalize());

const mountainBeltSamples: THREE.Vector3[] = [
  ...buildBeltSamples(MOUNTAIN_BELT_A, 5),
  ...buildBeltSamples(MOUNTAIN_BELT_B, 5),
];

function distanceToNearestBelt(dir: THREE.Vector3): number {
  let best = Math.PI;
  for (let i = 0; i < mountainBeltSamples.length; i++) {
    const dot = THREE.MathUtils.clamp(dir.dot(mountainBeltSamples[i]), -1, 1);
    const angle = Math.acos(dot);
    if (angle < best) best = angle;
  }
  return best;
}

// 1 right on a designated "great range" belt, fading to 0 a
// continent-width away.
function rawOrogenyBelt(dir: THREE.Vector3): number {
  const dist = distanceToNearestBelt(dir);
  return 1 - smoothstep(dist, 0.06, 0.26);
}

// distanceToNearestBelt scans every sample on every one of the belts for
// every call — fine occasionally, but heightAt alone calls this for every
// pixel of 3 different textures (3.5M+ calls). Precomputing it once onto a
// coarse grid (same trick as the river-flow field below) turns that into a
// cheap O(1) lookup on the hot path instead of visibly slowing page load.
let orogenyGridCache: { grid: Float32Array; width: number; height: number } | null = null;
function orogenyGrid(): { grid: Float32Array; width: number; height: number } {
  if (orogenyGridCache) return orogenyGridCache;
  const width = 192;
  const height = 96;
  const grid = new Float32Array(width * height);
  const dir = new THREE.Vector3();
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      dirForPixel(px, py, width, height, dir);
      grid[py * width + px] = rawOrogenyBelt(dir);
    }
  }
  orogenyGridCache = { grid, width, height };
  return orogenyGridCache;
}

function orogenyBeltAt(dir: THREE.Vector3): number {
  const { grid, width, height } = orogenyGrid();
  const theta = Math.acos(THREE.MathUtils.clamp(dir.y, -1, 1));
  let phi = Math.atan2(dir.z, -dir.x);
  if (phi < 0) phi += Math.PI * 2;
  const px = Math.min(width - 1, Math.floor((phi / (Math.PI * 2)) * width));
  const py = Math.min(height - 1, Math.floor((theta / Math.PI) * height));
  return grid[py * width + px];
}

// Big smooth rounded continents and coastal hills as the base shape — kept
// separate from the "rugged" detail below because it also drives river
// flow direction, and rugged high-frequency noise creates countless tiny
// local pits that would trap water before it ever reaches the sea.
function macroHeightAt(dir: THREE.Vector3): number {
  return (
    fbm3(dir.x * 1.6, dir.y * 1.6, dir.z * 1.6, 3) * 0.8 +
    fbm3(dir.x * 3.2 + 9.2, dir.y * 3.2 + 9.2, dir.z * 3.2 + 9.2, 2) * 0.2
  );
}

export function heightAt(dir: THREE.Vector3): number {
  const macro = macroHeightAt(dir);

  // real terrain isn't uniformly smooth either — coasts and lowlands are
  // gentle, but the higher land gets, the more rugged/jagged it should
  // look. Fade in finer, higher-frequency noise only once we're well into
  // "mountain" elevation, so peaks read as genuinely rocky and steep.
  // Inside a designated mountain belt, that ruggedness kicks in earlier
  // and hits harder — even modest foothills there already look torn up,
  // not like an ordinary hill that just happens to be taller.
  const rugged = fbm3(dir.x * 6.5 + 4.1, dir.y * 6.5 + 4.1, dir.z * 6.5 + 4.1, 4);
  const beltBoost = orogenyBeltAt(dir);
  const ruggedAmount = smoothstep(macro, SEA_LEVEL + 0.04 - beltBoost * 0.05, SEA_LEVEL + 0.22 - beltBoost * 0.12);

  let n = macro + rugged * 0.2 * ruggedAmount * (1 + beltBoost * 0.9);

  // Mid-frequency relief across *all* land, not just the mountains.
  // Without it the lowlands are pure smooth macro noise, and terracing a
  // smooth dome necessarily produces perfectly concentric steps — which is
  // where the tree-ring / wood-grain look on the plateaus came from. It is
  // not a texture problem: no amount of paint fixes contours that really
  // are nested circles. Irregular mid-scale relief makes each terrace edge
  // wander, and the wash then traces genuinely rock-like strata.
  // (fbm3 here is signed and centred on zero, like every other use of it
  // in this file — subtracting 0.5 to "centre" it would quietly lower every
  // landmass by half the amplitude and shrink the continents.)
  const midRelief = fbm3(dir.x * 3.4 + 17.7, dir.y * 3.4 + 17.7, dir.z * 3.4 + 17.7, 3);
  const landMask = smoothstep(macro, SEA_LEVEL - 0.03, SEA_LEVEL + 0.07);
  n += midRelief * 0.145 * landMask;

  // Polar ice continents: guarantee a broad ice-sheet landmass right at
  // the poles instead of leaving it to chance whether ordinary continent
  // noise happens to land there — Antarctica isn't a lucky accident, it's
  // reliably there every time you look at a real globe's pole.
  const poleCloseness = smoothstep(Math.abs(dir.y), 0.86, 0.98);
  if (poleCloseness > 0) {
    // Blend toward the shelf, never all the way to it. Pulling the height
    // fully onto a smooth low-frequency surface flattened the cap into a
    // featureless disc — a white plate sitting on top of the globe — where
    // the reference has snow draped over ground that still has shape under
    // it. Capping the blend keeps the underlying relief showing through.
    const iceShelfHeight =
      SEA_LEVEL + 0.03 + fbm3(dir.x * 5 + 222, dir.y * 5 + 222, dir.z * 5 + 222, 3) * 0.06;
    n = THREE.MathUtils.lerp(n, iceShelfHeight, poleCloseness * 0.62);
  }

  return Math.max(n, -0.2); // flatten the deep ocean floor a bit
}

// Real deserts follow latitude, not random chance: Earth's subtropical
// high-pressure belts (~15-35° from the equator) are where the Sahara,
// Arabian, Kalahari and Australian deserts all sit, with humid air right
// at the equator and humid temperate zones further out toward the poles.
// dir.y stands in for latitude, matching how the rest of this file uses it.
function desertBeltAt(dir: THREE.Vector3): number {
  const lat = Math.abs(dir.y);
  return smoothstep(lat, 0.1, 0.3) * (1 - smoothstep(lat, 0.55, 0.8));
}

// Very low-frequency, continent-scale "is this whole landmass dry or wet"
// identity — a real Sahara doesn't have much jungle hiding inside it; an
// entire continent commits to being arid or lush, and only its edges blend.
function climateBiasAt(dir: THREE.Vector3): number {
  return fbm3(dir.x * 0.35 + 300, dir.y * 0.35 + 300, dir.z * 0.35 + 300, 2);
}

// Climate variety in three layers: the latitude desert belt (where deserts
// are *allowed* at all), a continent-scale wet/dry bias (whether this
// particular landmass commits to being one), and local noise for patchy
// edges. Where the belt and the continent's own bias both agree it's dry,
// local noise is mostly ignored so the whole region reads as one
// unbroken desert instead of a speckled mix.
function rawAridityAt(dir: THREE.Vector3): number {
  const belt = desertBeltAt(dir);
  const bias = climateBiasAt(dir);
  const local = fbm3(dir.x * 2.6 + 51.3, dir.y * 2.6 + 51.3, dir.z * 2.6 + 51.3, 3);
  const commitment = belt * smoothstep(bias, 0, 0.5);
  return belt * 0.55 + bias * 0.4 + local * (0.4 - commitment * 0.28);
}

// Aridity, badlands and the climate wobble are all *low-frequency* fields —
// nothing in them turns faster than about three cycles across the sphere —
// and all three were being evaluated from scratch for every one of the
// million-odd texels the terrain paint covers, at seven, two and two noise
// lookups apiece. Baking them onto coarse grids costs a few hundred
// kilobytes and removes eleven noise evaluations from the hot path, the
// same trick the orogeny belt above already uses for the same reason.
function bakeField(width: number, height: number, f: (dir: THREE.Vector3) => number): Float32Array {
  const grid = new Float32Array(width * height);
  const dir = new THREE.Vector3();
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      dirForPixel(px, py, width, height, dir);
      grid[py * width + px] = f(dir);
    }
  }
  return grid;
}

const FIELD_W = 384;
const FIELD_H = 192;

function sampleField(grid: Float32Array, dir: THREE.Vector3): number {
  const theta = Math.acos(THREE.MathUtils.clamp(dir.y, -1, 1));
  let phi = Math.atan2(dir.z, -dir.x);
  if (phi < 0) phi += Math.PI * 2;
  const px = Math.min(FIELD_W - 1, Math.floor((phi / (Math.PI * 2)) * FIELD_W));
  const py = Math.min(FIELD_H - 1, Math.floor((theta / Math.PI) * FIELD_H));
  return grid[py * FIELD_W + px];
}

let aridityGrid: Float32Array | null = null;
export function aridityAt(dir: THREE.Vector3): number {
  aridityGrid ??= bakeField(FIELD_W, FIELD_H, rawAridityAt);
  return sampleField(aridityGrid, dir);
}

// same threshold biomeColor uses to start blending toward desert — shared
// so vegetation placement (dunes/dry rock vs. grass/trees) agrees with
// what the paint underneath actually looks like
export const DESERT_ARIDITY_THRESHOLD = 0.52;

// A separate, decorrelated low-frequency field marking "canyon/badlands
// country" — dry, exposed sedimentary rock distinct from both a sand-dune
// desert and ordinary rocky mountains, like the American Southwest or the
// Grand Canyon. Reuses the terracing language already established
// elsewhere (a hand-cut layered model) but as color banding instead of
// geometric steps.
let badlandsGrid: Float32Array | null = null;
function badlandsAt(dir: THREE.Vector3): number {
  badlandsGrid ??= bakeField(FIELD_W, FIELD_H, (d) =>
    fbm3(d.x * 0.9 + 555, d.y * 0.9 + 555, d.z * 0.9 + 555, 2),
  );
  return sampleField(badlandsGrid, dir);
}
export const BADLANDS_THRESHOLD = 0.28;

// Latitude-driven climate (Whittaker's temperature axis), like the design
// memo originally called for: hot at the equator, cold at the poles, and
// colder again with elevation — with a little noise so the ice line isn't
// a perfect circle. dir.y stands in for latitude, matching how the rest
// of the terrain already uses it.
let climateWobbleGrid: Float32Array | null = null;
export function temperatureAt(dir: THREE.Vector3, elevation: number): number {
  climateWobbleGrid ??= bakeField(
    FIELD_W,
    FIELD_H,
    (d) => fbm3(d.x * 1.1 + 700, d.y * 1.1 + 700, d.z * 1.1 + 700, 2) * 0.085,
  );
  const latitude = 1 - Math.abs(dir.y);
  const elevationCooling = Math.max(elevation, 0) * 1.6;
  return latitude + sampleField(climateWobbleGrid, dir) - elevationCooling;
}

export const ICE_TEMPERATURE = -0.04;
const TUNDRA_TEMPERATURE = 0.14;

// Extra height multiplier on top of the belt's own increased ruggedness
// (see heightAt) — some peaks along the range still tower further above
// others, the way a real range has both dramatic summits and lower
// passes along its length rather than a uniform wall.
function orogenyAt(dir: THREE.Vector3): number {
  const beltBoost = orogenyBeltAt(dir);
  const jitter = fbm3(dir.x * 2.2 + 900, dir.y * 2.2 + 900, dir.z * 2.2 + 900, 3);
  return beltBoost * (0.5 + jitter * 0.5);
}
const OROGENY_THRESHOLD = 0.28;

// water is flattened to sea level on the mesh so it doesn't visibly
// inherit the terrain noise as bumpy waves — only land pokes up. Land is
// pushed up well beyond its raw noise height for a toy-globe, exaggerated
// mountain look; since the ocean (~70% of the surface) stays perfectly
// flat regardless, this doesn't reintroduce the "potato" whole-sphere
// distortion from earlier — only the 30% landmass gets dramatic.
const LAND_BOOST = 2.0;
// a bigger drop than a purely cosmetic clamp needs — real relief globes
// have a visible carved "step" right at the coastline instead of land
// gently sloping into the water, and this is what makes that step read
const UNDERWATER_HEIGHT = SEA_LEVEL - 0.045;
// sits between the flattened underwater terrain and true sea level, so the
// glass ocean shell (built from this in main.ts) fully covers the seabed
// without z-fighting the coastline
export const GLASS_SEA_HEIGHT = SEA_LEVEL - 0.015;

// Land elevation is quantized into flat terraces with a small beveled
// transition at each edge — like a laser-cut layered topographic model —
// instead of one continuous smooth slope. This reads as "hand-built model"
// far more strongly than smoothness or color ever could, independent of
// how photoreal anything else is.
export const TERRACE_STEPS = 6;
const TERRACE_MAX = 0.3;
const TERRACE_BEVEL = 0.32;

function terraceCurve(t: number): number {
  const scaled = t * TERRACE_STEPS;
  const i = Math.floor(scaled);
  const f = scaled - i;
  let localT: number;
  if (f < TERRACE_BEVEL) {
    localT = 0.5 * smoothstep(f / TERRACE_BEVEL, 0, 1);
  } else if (f > 1 - TERRACE_BEVEL) {
    localT = 0.5 + 0.5 * smoothstep((f - (1 - TERRACE_BEVEL)) / TERRACE_BEVEL, 0, 1);
  } else {
    localT = 0.5;
  }
  return (Math.min(i, TERRACE_STEPS - 1) + localT) / TERRACE_STEPS;
}

// Raw elevation above sea level (0..TERRACE_MAX), terraced. Shared by both
// the mesh displacement and the color banding so a terrace's edge always
// lines up with a color change, like distinct painted layers.
// Terracing fades in above the shoreline rather than starting at it. With
// six steps over TERRACE_MAX, the very first step is a ~0.05 jump, so
// applying it from sea level up meant *every* coast got a cliff the moment
// land appeared — a whole planet of fjords. Real coastline is mostly the
// opposite: a shallow ramp of beach, with cliffs the exception. Blending
// from the raw height into the terraced one over the first stretch of
// elevation gives the beach back and keeps the layered look inland.
const BEACH_RAMP = 0.055;

export function terracedElevation(height: number): number {
  if (height < SEA_LEVEL) return 0;
  const above = height - SEA_LEVEL;
  const t = Math.min(above / TERRACE_MAX, 1);
  const terraced = terraceCurve(t) * TERRACE_MAX;
  return THREE.MathUtils.lerp(above, terraced, smoothstep(above, 0, BEACH_RAMP));
}

// How cliff-like this stretch of coast is. Mountain ranges meeting the sea
// drop straight into it, and a few other headlands are rocky by their own
// accord, but most shoreline is not.
function coastCliffiness(dir: THREE.Vector3): number {
  const belt = smoothstep(orogenyBeltAt(dir), 0.12, 0.45);
  const rocky = smoothstep(
    fbm3(dir.x * 1.7 + 808, dir.y * 1.7 + 808, dir.z * 1.7 + 808, 2),
    0.05,
    0.22,
  );
  return Math.max(belt, rocky * 0.85);
}

// dir is needed to look up whether this point sits in a rare "great
// range" (Himalaya-scale) zone — see orogenyAt above. Paint/coloring
// still uses plain terracedElevation, so a dramatic peak still gets
// colored by its normal elevation percentile (naturally reads as rock/
// snow already); only the geometry shoots up further.
export function displayHeight(height: number, dir: THREE.Vector3): number {
  if (height < SEA_LEVEL) return UNDERWATER_HEIGHT;
  const orogenyBoost = 1 + smoothstep(orogenyAt(dir), OROGENY_THRESHOLD, OROGENY_THRESHOLD + 0.12) * 1.3;
  // A step lifting land clear of the resin as it crosses the shoreline —
  // but only where the coast is actually rocky. Applying it everywhere (as
  // it was) walled every continent with the same vertical cliff, which is
  // a fjord coastline, and fjords are not what most shoreline looks like.
  // Gentle coasts get barely any lift and meet the water as a beach; the
  // glass sea already sits slightly below SEA_LEVEL, so they still emerge.
  const coastalStep = 0.012 + coastCliffiness(dir) * 0.15;
  return SEA_LEVEL + coastalStep + terracedElevation(height) * LAND_BOOST * orogenyBoost;
}

export function seaLevelRadius(radius: number, bumpHeight: number): number {
  return radius + GLASS_SEA_HEIGHT * bumpHeight;
}

const outColor = new THREE.Color();
const badlandsScratch = new THREE.Color();

// Purely cosmetic: perturbs where a pixel's color band boundary falls,
// without touching the height value used for geometry, sea level, or
// vegetation placement. Perfectly smooth, mathematically clean coastlines
// read as vector art; a hand-cut miniature's coastline has a bit of
// irregularity to it.
function coastlineJitter(dir: THREE.Vector3): number {
  return fbm3(dir.x * 55 + 71, dir.y * 55 + 71, dir.z * 55 + 71, 2) * 0.008;
}

// A little per-pixel brightness grain so painted terrain reads as a
// matte, slightly textured surface (like painted resin/flock) instead of
// a flawless digital gradient — real miniatures are never perfectly smooth.
function paintGrain(dir: THREE.Vector3): number {
  return fbm3(dir.x * 180 + 13, dir.y * 180 + 13, dir.z * 180 + 13, 1) * 0.05;
}

// Alternating sediment-layer stripes driven directly by elevation, so the
// bands stay perfectly horizontal/contour-following like real exposed
// rock strata, and automatically line up with the terrace steps underneath.
function badlandsColor(elevation: number): THREE.Color {
  const stripeA = Math.sin(elevation * 95) * 0.5 + 0.5;
  const stripeB = Math.sin(elevation * 230 + 1.7) * 0.5 + 0.5;
  badlandsScratch.copy(badlandsColorA).lerp(badlandsColorB, stripeA);
  return badlandsScratch.lerp(badlandsColorC, stripeB * 0.4);
}

// green lowland, with patches nudged toward desert; rock band climbing
// into rugged elevation; snow capping the highest peaks — real elevation
// color grading instead of a single flat "land" band.
// Thresholds were picked by sampling the actual height/aridity noise
// distributions so bands land at sensible percentiles of land area.
// Takes the already-terraced elevation (0..TERRACE_MAX) so each color
// band's edge lines up exactly with a geometric terrace edge — the
// "layers are individually painted" read this is going for.
function biomeColor(
  elevation: number,
  aridity: number,
  temperature: number,
  badlandsRaw: number,
  beltCloseness: number,
): THREE.Color {
  // polar ice caps: cold enough, and it's ice regardless of elevation or
  // aridity — Antarctica doesn't care if it would otherwise be a beach.
  // Graded rather than switched, so the cap has a ragged frozen margin
  // instead of a hard edge stamped across whatever biome it lands on.
  const iceAmount = 1 - smoothstep(temperature, ICE_TEMPERATURE, ICE_TEMPERATURE + 0.13);
  if (iceAmount > 0.995) {
    return outColor.copy(iceColor);
  }

  const desertAmount = smoothstep(aridity, 0.4, 0.58);
  // How equatorial this is: drives the tropical/temperate/boreal split that
  // used to be missing entirely — every warm lowland was painted the same
  // olive regardless of whether it sat on the equator or near the tree line.
  const tropical = smoothstep(temperature, 0.62, 0.88);
  const boreal = 1 - smoothstep(temperature, TUNDRA_TEMPERATURE, 0.45);

  if (elevation < 0.15) {
    // cold + dry lowland reads as bare tundra instead of green — being
    // *cold* isn't the same as being *dry*, so this stacks with (and can
    // override) the desert blend below rather than replacing it outright
    if (temperature < TUNDRA_TEMPERATURE) {
      const coldness = smoothstep(temperature, TUNDRA_TEMPERATURE, ICE_TEMPERATURE);
      outColor.copy(landColor).lerp(tundraColor, coldness);
      outColor.lerp(desertGravelColor, desertAmount * (1 - coldness));
    } else {
      // sand only right at the coast — being *low* elevation isn't the
      // same as being *dry*. A wide shore→green transition was tying the
      // two together, so any low flat continent read as one giant beach
      // regardless of its actual (independent) aridity value.
      const t = elevation / 0.035;
      outColor.copy(shoreColor).lerp(landColor, Math.min(Math.max(t, 0), 1));
      // climate belts on the ground itself, under whatever grows on it
      outColor.lerp(tropicalSoilColor, tropical * 0.65);
      outColor.lerp(taigaColor, boreal * 0.7);

      // A sand sea has a pale, almost bleached core with a darker gravel
      // margin. Ramping straight to one sand colour gave a flat khaki
      // patch that read as discoloured grass rather than as desert.
      outColor.lerp(desertGravelColor, desertAmount);
      outColor.lerp(desertColor, smoothstep(aridity, 0.56, 0.72));
    }
  } else if (elevation < 0.22) {
    const t = (elevation - 0.15) / 0.07;
    outColor.copy(landColor).lerp(rockColor, t);
    outColor.lerp(taigaColor, boreal * 0.5 * (1 - t));
    outColor.lerp(desertGravelColor, desertAmount * (1 - t) * 0.6);
  } else if (elevation < TERRACE_MAX) {
    // Above the tree line the rock changes character, not just shade: warm
    // sedimentary brown gives way to cold grey granite, and only then to
    // snow. The old ramp went brown straight to white.
    const t = (elevation - 0.22) / (TERRACE_MAX - 0.22);
    outColor.copy(rockColor).lerp(alpineRockColor, smoothstep(t, 0, 0.55));
    outColor.lerp(alpineShadowColor, smoothstep(t, 0.1, 0.45) * 0.35);
    outColor.lerp(snowColor, smoothstep(t, 0.62, 1));
  } else {
    outColor.copy(snowColor);
  }

  // Canyon/badlands banding: only in dry-but-not-desert, low/foothill,
  // warm-enough country that isn't already claimed by a great mountain
  // belt (which keeps its own alpine-rock look).
  const badlandsGate =
    smoothstep(badlandsRaw, BADLANDS_THRESHOLD, BADLANDS_THRESHOLD + 0.15) *
    (1 - smoothstep(beltCloseness, 0.15, 0.4)) *
    smoothstep(aridity, -0.05, 0.15) *
    (1 - smoothstep(elevation, 0.2, 0.28)) *
    smoothstep(temperature, TUNDRA_TEMPERATURE - 0.05, TUNDRA_TEMPERATURE + 0.05);

  if (badlandsGate > 0.001) {
    outColor.lerp(badlandsColor(elevation), badlandsGate * 0.3);
  }

  if (iceAmount > 0) outColor.lerp(iceColor, iceAmount);

  return outColor;
}

// Real shadow maps are off (mobile GPU stability), so the coastline's
// geometric "step" never actually casts a shadow onto the beach — without
// this the carved edge just looks like a color boundary, not a relief.
// Baking a fake AO crease directly into the paint fakes the same read.
// Steeper/darker right where a mountain belt meets the sea, matching the
// fjord-style cliff coastline used there (see terrainColor).
function coastalAO(height: number, cliffiness: number): number {
  const t = smoothstep(height, SEA_LEVEL, SEA_LEVEL + 0.05);
  return -0.16 * (1 - t) * (1 + cliffiness * 1.3);
}

// Where snow lies, agreed on by the paint, the wash and the bump texture.
// These used to disagree: the cap was painted from *temperature* (so it
// covers the flat polar landmass) while its sparkle keyed off *elevation*,
// which meant the one piece of snow big enough to see had no surface
// texture at all and rendered as a flat white sticker.
export function snowinessAt(dir: THREE.Vector3, height: number): number {
  if (height < SEA_LEVEL) return 0;
  const elevation = terracedElevation(height);
  const temperature = temperatureAt(dir, elevation);
  const polar = 1 - smoothstep(temperature, ICE_TEMPERATURE, ICE_TEMPERATURE + 0.14);
  const alpine =
    smoothstep(elevation, 0.27, TERRACE_MAX) * (1 - smoothstep(temperature, 0.1, 0.42));
  return Math.max(polar, alpine);
}

// ---------------------------------------------------------------------
// Wash + drybrush: the two pigment passes that make a painted model read
// as a solid sculpted object
// ---------------------------------------------------------------------
// A painted resin miniature does not get its readable form from its base
// colors. It gets it from two passes applied *after* the base coat: a
// thin dark wash that flows into every recess and pools there, and a
// nearly-dry brush dragged across the surface so pigment catches only on
// raised edges and leaves the hollows untouched. Both depend on local
// surface *curvature*.
//
// That is exactly the term a height-colored texture has no way to
// express. Coloring by elevation and climate produces a map — accurate,
// and flat-looking no matter how many biomes it distinguishes — because
// every point at the same altitude gets the same pigment whether it sits
// on a ridge crest or at the bottom of a ravine. Adding the curvature
// term is what turns the paint into something that describes a shape.
//
// Curvature is read off a precomputed height grid rather than by sampling
// the noise field four extra times per texel, which would have multiplied
// an already-expensive texture bake by five.
const washColor = new THREE.Color('#241a11'); // sepia recess pigment, never neutral black
const drybrushColor = new THREE.Color('#cdc4b1'); // bone highlight caught on raised edges
const cliffColor = new THREE.Color('#6a5a49'); // bare stone: paint doesn't hold on a vertical face
// Snow takes the opposite treatment. Its recesses are lit by skylight
// bouncing between crystals, so they go cool blue-grey, never sepia — a
// brown wash over snow is the classic way to make a winter model look
// like it was left out in the mud.
const snowWashColor = new THREE.Color('#7e9ac0');
const snowDrybrushColor = new THREE.Color('#ffffff');

// Every texture below needs the height at each texel, and each one used to
// work it out for itself: the terrain paint, the ocean paint, the bump map
// and the relief field each ran heightAt over all 1.18M texels, at roughly
// fourteen noise evaluations apiece. Four passes over the same function with
// the same arguments — about eight seconds of blocked main thread on a
// desktop, and enough to get the tab killed on a phone before it ever drew a
// frame. Computed once and shared.
interface SharedHeightField {
  width: number;
  height: number;
  /** raw terrain height, as heightAt returns it */
  raw: Float32Array;
  /** the displaced radius offset actually used for geometry */
  display: Float32Array;
}

let sharedHeightCache: SharedHeightField | null = null;

/**
 * Terrain height sampled from the shared grid instead of evaluated.
 *
 * heightAt costs somewhere around fifteen 3D noise lookups. The scatter
 * passes call it for every candidate position — hundreds of thousands of
 * them, the great majority only to discover the point is underwater and
 * throw it away — and the ocean and bump textures call it per texel for a
 * second and third time over ground the terrain paint has already covered.
 * The grid is finer than a third of a degree, far below anything placement
 * or a bump map can resolve, so reading from it is free accuracy.
 *
 * Falls back to evaluating directly if the field has not been built yet.
 */
export function sampledHeight(dir: THREE.Vector3): { raw: number; display: number } {
  const field = sharedHeightCache;
  if (!field) {
    const raw = heightAt(dir);
    return { raw, display: displayHeight(raw, dir) };
  }
  const theta = Math.acos(THREE.MathUtils.clamp(dir.y, -1, 1));
  let phi = Math.atan2(dir.z, -dir.x);
  if (phi < 0) phi += Math.PI * 2;
  const px = Math.min(field.width - 1, Math.floor((phi / (Math.PI * 2)) * field.width));
  const py = Math.min(field.height - 1, Math.floor((theta / Math.PI) * field.height));
  const idx = py * field.width + px;
  return { raw: field.raw[idx], display: field.display[idx] };
}

function sharedHeightField(width: number, height: number): SharedHeightField {
  if (sharedHeightCache && sharedHeightCache.width === width && sharedHeightCache.height === height) {
    return sharedHeightCache;
  }
  const size = width * height;
  const raw = new Float32Array(size);
  const display = new Float32Array(size);
  const dir = new THREE.Vector3();
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      dirForPixel(px, py, width, height, dir);
      const h = heightAt(dir);
      const idx = py * width + px;
      raw[idx] = h;
      display[idx] = displayHeight(h, dir);
    }
  }
  sharedHeightCache = { width, height, raw, display };
  return sharedHeightCache;
}

export interface ReliefField {
  width: number;
  height: number;
  /** positive on convex ridges and edges, negative inside concave recesses */
  convexity: Float32Array;
  /** 0 on flat ground, 1 on a near-vertical face */
  slope: Float32Array;
}

export function buildReliefField(width: number, height: number): ReliefField {
  const size = width * height;
  // the *displayed* height (terraced and boosted), not the raw noise — the
  // wash has to pool along the terrace edges the geometry actually has,
  // otherwise the paint describes a shape the model doesn't
  const field = sharedHeightField(width, height).display;

  const convexity = new Float32Array(size);
  const slope = new Float32Array(size);

  for (let py = 0; py < height; py++) {
    // texel spacing collapses toward the poles; without normalizing by the
    // ring circumference the wash smears into a solid band at the caps
    const theta = ((py + 0.5) / height) * Math.PI;
    const sx = Math.max(Math.sin(theta), 0.15);
    const py0 = Math.max(py - 1, 0);
    const py1 = Math.min(py + 1, height - 1);

    for (let px = 0; px < width; px++) {
      const idx = py * width + px;
      const c = field[idx];
      const l = field[py * width + ((px - 1 + width) % width)];
      const r = field[py * width + ((px + 1) % width)];
      const u = field[py0 * width + px];
      const d = field[py1 * width + px];

      const dhdx = (r - l) / (2 * sx);
      const dhdy = (d - u) / 2;
      slope[idx] = Math.min(Math.sqrt(dhdx * dhdx + dhdy * dhdy) * SLOPE_GAIN, 1);

      // Laplacian is positive in a pit and negative on a crest; flip it so
      // the stored value reads directly as "how convex is this point"
      const laplacian = (l + r - 2 * c) / (sx * sx) + (u + d - 2 * c);
      convexity[idx] = THREE.MathUtils.clamp(-laplacian * CURVATURE_GAIN, -1, 1);
    }
  }

  return { width, height, convexity, slope };
}

// Both gains are in units of "displayHeight per texel", so they only make
// sense against the texture resolution the field is built at.
const CURVATURE_GAIN = 11;
const SLOPE_GAIN = 7;

function applyReliefPaint(
  color: THREE.Color,
  convexity: number,
  slope: number,
  snowiness: number,
): THREE.Color {
  // bare stone shows through wherever the face is too steep to hold paint —
  // but snow drapes over a slope instead of sliding off it
  if (slope > 0.01) color.lerp(cliffColor, slope * 0.7 * (1 - snowiness));
  const flatness = 1 - slope * 0.8;

  // Ridge crests. A drybrush weighted by curvature alone spreads the
  // highlight over every mildly convex surface, which is why the mountains
  // came out rounded, like soft clay. On real rock the brightest line is
  // narrow and sits exactly on the arete — so the top of the curvature range
  // gets a separate, much harder hit.
  const crest = smoothstep(convexity, 0.55, 1);
  if (crest > 0) color.lerp(drybrushColor, crest * 0.45 * (1 - snowiness * 0.4));
  if (convexity < 0) {
    // wash: pigment runs downhill and pools, so recesses darken hard
    const t = Math.min(-convexity, 1) * flatness;
    color.lerp(washColor, t * 0.33 * (1 - snowiness));
    color.lerp(snowWashColor, t * 0.62 * snowiness);
  } else {
    // drybrush: a much lighter touch, and only on the raised edge itself
    const t = Math.min(convexity, 1) * flatness;
    color.lerp(drybrushColor, t * 0.3 * (1 - snowiness));
    color.lerp(snowDrybrushColor, t * 0.45 * snowiness);
  }
  return color;
}

function terrainColor(dir: THREE.Vector3, height: number, riverStrength: number): THREE.Color {
  const h = height + coastlineJitter(dir);
  const temperature = temperatureAt(dir, terracedElevation(Math.max(h, SEA_LEVEL)));
  const seaIce = smoothstep(temperature, ICE_TEMPERATURE, ICE_TEMPERATURE - 0.08);
  const beltCloseness = orogenyBeltAt(dir);

  let color: THREE.Color;
  if (h < SEA_LEVEL - COAST_WIDTH) {
    // Real seabed, graded by depth and mottled, because the resin above it
    // is see-through in the shallows (see buildOceanTexture's alpha ramp).
    const shelf = smoothstep(h, SEA_LEVEL - 0.035, SEA_LEVEL);
    const abyss = 1 - smoothstep(h, -0.14, SEA_LEVEL - 0.05);
    color = outColor.copy(seabedSiltColor).lerp(seabedSandColor, shelf);
    color.lerp(seabedDeepColor, abyss);
    // patchy sand/weed mottling, low frequency enough to read as bed
    // features through the water rather than as noise on the surface
    const mottle = fbm3(dir.x * 22 + 61, dir.y * 22 + 61, dir.z * 22 + 61, 3);
    color.offsetHSL(0, 0, mottle * 0.12);
    color.lerp(iceColor, seaIce);
  } else if (h < SEA_LEVEL + COAST_WIDTH * 0.35) {
    // The waterline itself. A wide pale band around every coast reads as a
    // map's shoreline symbol, which is why the beach was narrowed — but the
    // opposite extreme, land meeting sea at a bare colour boundary, throws
    // away the one place on the model where the eye most wants detail. A
    // line only a texel or two across, brighter than either side, reads as
    // wet sand catching the light.
    color = outColor.copy(shoreColor).lerp(drybrushColor, 0.55);
    color.lerp(iceColor, seaIce);
  } else if (h < SEA_LEVEL + COAST_WIDTH) {
    if (beltCloseness > 0.35) {
      // fjord-style coastline: a mountain range meeting the sea drops
      // straight into deep water instead of tapering out to a sandy beach
      const t = smoothstep(h, SEA_LEVEL - COAST_WIDTH * 0.4, SEA_LEVEL + COAST_WIDTH);
      color = outColor.copy(midOceanColor).lerp(rockColor, t);
      color.offsetHSL(0, 0, -0.05);
    } else {
      color = outColor.copy(midOceanColor).lerp(shoreColor, (h - (SEA_LEVEL - COAST_WIDTH)) / (COAST_WIDTH * 2));
    }
    color.lerp(iceColor, seaIce);
  } else {
    const elevation = terracedElevation(h);
    const aridity = aridityAt(dir);
    const badlandsRaw = badlandsAt(dir);
    color = biomeColor(elevation, aridity, temperature, badlandsRaw, beltCloseness);
    if (riverStrength > 0) color.lerp(riverColor, riverStrength);
    color.offsetHSL(0, 0, coastalAO(h, beltCloseness));
  }

  return color.offsetHSL(0, 0, paintGrain(dir));
}

function oceanColor(dir: THREE.Vector3, height: number): THREE.Color {
  // Turquoise belongs to the last stretch of the shelf, not to most of the
  // sea. Splitting the ramp at 0.6 put the pale colour over everything
  // within reach of a continent and left a broad milky ring around every
  // landmass; in the reference the bright water is a narrow rim and the
  // basin behind it stays a deep blue.
  const t = smoothstep(height, -0.2, SEA_LEVEL);
  if (t < 0.86) {
    outColor.copy(deepOceanColor).lerp(midOceanColor, t / 0.86);
  } else {
    outColor.copy(midOceanColor).lerp(shallowOceanColor, (t - 0.86) / 0.14);
  }
  // Large-scale tint variation. A pour of tinted resin is never perfectly
  // even — pigment settles and swirls as it cures — and without that the
  // open water was a flawless airbrushed gradient, which is the most
  // synthetic-looking surface in the whole frame.
  const swirl = fbm3(dir.x * 4.5 + 611, dir.y * 4.5 + 611, dir.z * 4.5 + 611, 3);
  outColor.offsetHSL(swirl * 0.02, swirl * 0.1, swirl * 0.07);

  // polar pack ice — a real ice cap freezes the sea around it too, not
  // just the land
  const temperature = temperatureAt(dir, 0);
  const seaIce = smoothstep(temperature, ICE_TEMPERATURE, ICE_TEMPERATURE - 0.08);
  outColor.lerp(iceColor, seaIce);
  return outColor.offsetHSL(0, 0, paintGrain(dir) * 0.6);
}

function dirForPixel(px: number, py: number, width: number, height: number, out: THREE.Vector3): THREE.Vector3 {
  const u = px / width;
  const v = py / height;
  const phi = u * Math.PI * 2;
  const theta = v * Math.PI;
  return out.set(-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta));
}

// Simple hydrology pass: steepest-descent flow accumulation on a coarse
// grid (matching the design memo's original "flow accumulation derives
// rivers" plan). Every land cell starts with 1 unit of flow and hands it
// downhill to its lowest neighbor; processing cells from highest to
// lowest lets flow accumulate exactly like water actually would, so
// branching river networks fall out for free instead of being hand-drawn.
function computeRiverFlow(width: number, height: number): { flow: Float32Array; width: number; height: number } {
  const size = width * height;
  const heightField = new Float32Array(size);
  const isLand = new Uint8Array(size);
  const dir = new THREE.Vector3();

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const idx = py * width + px;
      // macro-only height: rugged detail noise creates countless tiny
      // local pits that would trap flow before it reaches the ocean
      const h = macroHeightAt(dirForPixel(px, py, width, height, dir));
      heightField[idx] = h;
      isLand[idx] = h >= SEA_LEVEL ? 1 : 0;
    }
  }

  const downhill = new Int32Array(size).fill(-1);
  const dxs = [-1, 0, 1, -1, 1, -1, 0, 1];
  const dys = [-1, -1, -1, 0, 0, 1, 1, 1];

  const landIndices: number[] = [];
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const idx = py * width + px;
      if (!isLand[idx]) continue;
      landIndices.push(idx);

      let lowest = heightField[idx];
      let lowestIdx = -1;
      for (let k = 0; k < 8; k++) {
        const nx = (px + dxs[k] + width) % width;
        const ny = py + dys[k];
        if (ny < 0 || ny >= height) continue;
        const nIdx = ny * width + nx;
        if (heightField[nIdx] < lowest) {
          lowest = heightField[nIdx];
          lowestIdx = nIdx;
        }
      }
      downhill[idx] = lowestIdx;
    }
  }

  landIndices.sort((a, b) => heightField[b] - heightField[a]);

  const flow = new Float32Array(size).fill(1);
  for (const idx of landIndices) {
    const d = downhill[idx];
    if (d >= 0) flow[d] += flow[idx];
  }

  return { flow, width, height };
}

function sampleRiverFlow(river: { flow: Float32Array; width: number; height: number }, dir: THREE.Vector3): number {
  // dir -> (u,v) using the same convention dirForPixel used in reverse
  const theta = Math.acos(THREE.MathUtils.clamp(dir.y, -1, 1));
  let phi = Math.atan2(dir.z, -dir.x);
  if (phi < 0) phi += Math.PI * 2;
  const px = Math.min(river.width - 1, Math.floor((phi / (Math.PI * 2)) * river.width));
  const py = Math.min(river.height - 1, Math.floor((theta / Math.PI) * river.height));
  const flow = river.flow[py * river.width + px];
  // log-compress: a trickle near the source vs. a wide river near the
  // mouth shouldn't be the same line weight. Thresholds picked from the
  // actual flow distribution so only the top ~2% of land (real rivers,
  // not every hillside trickle) shows any blue at all.
  const strength = (Math.log(flow + 1) - 3.4) / (5.9 - 3.4);
  return smoothstep(strength, 0, 1);
}

// THREE.Color holds its components in the renderer's *linear* working
// color space (so `new THREE.Color('#123f7a')` is nowhere near 0x12/0x3f/
// 0x7a numerically). A canvas holds sRGB bytes, and the textures below are
// tagged SRGBColorSpace so the GPU converts them back to linear on sample.
// Writing raw linear components straight into the canvas therefore applied
// the linear->sRGB decode twice, crushing every mid-tone toward black —
// that's what turned the sapphire ocean into a near-black mirror. Encode
// on the way out so the painted color survives the round trip intact.
const srgbScratch = new THREE.Color();
function writeSRGBPixel(data: Uint8ClampedArray, idx: number, c: THREE.Color): void {
  srgbScratch.copy(c).convertLinearToSRGB();
  data[idx] = Math.round(srgbScratch.r * 255);
  data[idx + 1] = Math.round(srgbScratch.g * 255);
  data[idx + 2] = Math.round(srgbScratch.b * 255);
  data[idx + 3] = 255;
}

// Renders terrain color to a canvas once, matching the exact UV formula
// THREE.SphereGeometry uses internally, so the crisp texture lines up with
// the (much lower-poly) displaced mesh without any seams or misalignment.
export function buildTerrainTexture(width = 1536, height = 768): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(width, height);
  const dir = new THREE.Vector3();

  // rivers computed on a coarser grid — plenty for branching river shapes,
  // and much cheaper than running full hydrology at texture resolution
  const river = computeRiverFlow(384, 192);
  const relief = buildReliefField(width, height);
  const heights = sharedHeightField(width, height).raw;

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      dirForPixel(px, py, width, height, dir);

      const h = heights[py * width + px];
      const riverStrength = h >= SEA_LEVEL ? sampleRiverFlow(river, dir) : 0;
      const c = terrainColor(dir, h, riverStrength);
      // the wash/drybrush passes go on over the finished base coat, exactly
      // as they do on the workbench — and only on land, since the sea is a
      // poured surface nobody drybrushes
      if (h >= SEA_LEVEL) {
        const ri = py * width + px;
        applyReliefPaint(c, relief.convexity[ri], relief.slope[ri], snowinessAt(dir, h));
      }

      const idx = (py * width + px) * 4;
      writeSRGBPixel(image.data, idx, c);
    }
  }

  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

// A depth-graded teal texture for the ocean shell — deep water reads
// darker, shading up to a lighter turquoise near the coast, instead of a
// single flat color.
export function buildOceanTexture(width = 1536, height = 768): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(width, height);
  const dir = new THREE.Vector3();

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      dirForPixel(px, py, width, height, dir);
      const h = sampledHeight(dir).raw;
      const c = oceanColor(dir, h);

      const idx = (py * width + px) * 4;
      writeSRGBPixel(image.data, idx, c);
      // Depth-driven opacity: this is the whole trick. Water is not a
      // colored surface, it is a colored *volume*, so a hand's depth of it
      // over a sandbar hides almost nothing while the same pigment over the
      // shelf edge hides everything. Baking that into the shell's alpha
      // gives the poured-resin read without paying for real transmission.
      const depth = 1 - smoothstep(h, -0.13, SEA_LEVEL);
      image.data[idx + 3] = Math.round(THREE.MathUtils.lerp(0.26, 0.93, depth) * 255);
    }
  }

  ctx.putImageData(image, 0, 0);

  // Beads of water standing on the cured resin — the sea's signature detail
  // in the reference, and the one thing no amount of noise reproduces.
  // Fractal noise can only ever make a *cloudy* surface; droplets are
  // discrete round objects with sharp edges and clear space between them,
  // so they are drawn as literal circles. Sized generously in texels: this
  // map is about a thousand across for a sphere that fills half the frame,
  // and anything a couple of texels wide never survives to the screen.
  const dropRand = mulberry32(31337);
  const dropDir = new THREE.Vector3();
  for (let i = 0; i < 900; i++) {
    const cx = dropRand() * width;
    // biased away from the poles, where the equirectangular map crowds
    // texels together and a round bead would be drawn as a long smear
    const cy = height * (0.1 + dropRand() * 0.8);

    // Water beads up in patches — it runs together where the surface is
    // wetter and leaves clear areas between. Scattered evenly at full
    // strength they stopped reading as water at all and became a starfield.
    dirForPixel(cx, cy, width, height, dropDir);
    const wetness = fbm3(dropDir.x * 9 + 313, dropDir.y * 9 + 313, dropDir.z * 9 + 313, 2);
    if (dropRand() > wetness * 2.4 + 0.55) continue;

    const r = 1.6 + dropRand() * dropRand() * 6;
    const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 0, cx, cy, r);
    g.addColorStop(0, 'rgba(255,255,255,0.3)');
    g.addColorStop(0.45, 'rgba(220,240,255,0.1)');
    g.addColorStop(1, 'rgba(200,230,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

// A directional-ish wave pattern (not just isotropic noise) baked as a
// bumpMap and scrolled slowly in the animation loop — the ocean sphere is
// geometrically almost still (one static ripple pass), but a moving bump
// texture makes its specular highlights shimmer and drift like real
// wind-driven water instead of a fixed pattern on a billiard ball.
export function buildWaveTexture(width = 1024, height = 512): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(width, height);
  const dir = new THREE.Vector3();

  // Base: a very slight swell, kept low-contrast on purpose. Cured epoxy is
  // not choppy water — it is a hard, near-flat sheet, and giving it wave
  // relief is what made the sea read as painted-on ripples rather than as
  // something poured and set.
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      dirForPixel(px, py, width, height, dir);
      const swell = Math.sin(dir.x * 42 + dir.z * 17 + dir.y * 9) * 0.5 + 0.5;
      const chop = fbm3(dir.x * 30 + 8, dir.y * 30 + 8, dir.z * 30 + 8, 3);
      const v = 0.5 + (swell - 0.5) * 0.1 + chop * 0.07;

      const gray = Math.round(Math.min(Math.max(v, 0), 1) * 255);
      const idx = (py * width + px) * 4;
      image.data[idx] = gray;
      image.data[idx + 1] = gray;
      image.data[idx + 2] = gray;
      image.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  // (The droplets that used to be drawn here moved into the ocean's colour
  // texture. A bump map only perturbs the lighting, and on a surface this
  // diffuse and this dark that came to almost nothing — the beads were
  // there in the map and invisible on screen. In the reference they read as
  // small bright specks, which is a *paint* fact, not a shading one.)
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

// Fine-grained surface relief baked into a grayscale map and applied as a
// bumpMap — this is the single biggest lever for "sculpted miniature" vs.
// "smooth painted ball": the mesh itself stays cheap and low-poly, but
// per-pixel lighting reacts to fake micro-terrain, giving the impression
// of actual carved texture (individual clumps of foliage, rock grain,
// sand ripples) at zoom levels the real geometry could never afford.
export function buildBumpTexture(width = 1536, height = 768): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(width, height);
  const dir = new THREE.Vector3();

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      dirForPixel(px, py, width, height, dir);

      const h = sampledHeight(dir).raw;
      let v: number;
      if (h < SEA_LEVEL) {
        // fine ripple texture on the (mostly hidden) seabed — cheap
        // insurance in case it peeks through the glass shell
        v = 0.5 + fbm3(dir.x * 90, dir.y * 90, dir.z * 90, 2) * 0.08;
      } else {
        // layered detail: coarse clumps (foliage/boulder clusters), fine
        // grain (rock/sand texture), scaled down near the coast so the
        // beach itself still reads smooth. Grain is pushed harder than a
        // purely cosmetic touch-up would need — at this strength, raking
        // light catches the raised specks and reads as a dry-brushed/
        // textured-paste surface instead of a smooth painted gradient.
        const shoreFade = smoothstep(h, SEA_LEVEL, SEA_LEVEL + 0.03);
        const clumps = fbm3(dir.x * 45 + 8, dir.y * 45 + 8, dir.z * 45 + 8, 2);
        const grain = fbm3(dir.x * 140 + 22, dir.y * 140 + 22, dir.z * 140 + 22, 2);
        v = 0.5 + (clumps * 0.18 + grain * 0.11) * shoreFade;

        // Wind ripples. A sand sea is not a rough surface — it is a
        // *combed* one, ridged in one direction at a scale you can see, and
        // that directional pattern is most of what says "desert" before any
        // colour does. The dune field props were removed as unconvincing
        // objects; this puts the desert back as a surface instead.
        const sandiness = smoothstep(aridityAt(dir), 0.5, 0.7);
        if (sandiness > 0) {
          const drift = fbm3(dir.x * 4 + 88, dir.y * 4 + 88, dir.z * 4 + 88, 2);
          const ripple =
            Math.sin((dir.x * 150 + dir.z * 95 + dir.y * 40) + drift * 14) * 0.5 + 0.5;
          v = v * (1 - sandiness) + (0.5 + (ripple - 0.5) * 0.34) * sandiness;
        }

        // Granular snow: a coarse drift lump plus a hard crystalline
        // sparkle. Modelling snow as *smoother* than rock is the mistake —
        // scale snow powder up to this size and it is visibly the roughest
        // material on the model, which is why the flat white cap read as
        // painted-on rather than as sifted powder.
        const snowiness = snowinessAt(dir, h);
        if (snowiness > 0) {
          const drifts = fbm3(dir.x * 62 + 41, dir.y * 62 + 41, dir.z * 62 + 41, 3);
          const sparkle = fbm3(dir.x * 330 + 91, dir.y * 330 + 91, dir.z * 330 + 91, 2);
          v = v * (1 - snowiness) + (0.5 + drifts * 0.2 + sparkle * 0.16) * snowiness;
        }
      }

      const gray = Math.round(Math.min(Math.max(v, 0), 1) * 255);
      const idx = (py * width + px) * 4;
      image.data[idx] = gray;
      image.data[idx + 1] = gray;
      image.data[idx + 2] = gray;
      image.data[idx + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

// Displaces a SphereGeometry's vertices in place using the same height
// field the texture was painted from.
export function displaceSphere(geometry: THREE.SphereGeometry, radius: number, bumpHeight: number) {
  const positionAttr = geometry.attributes.position;
  const dir = new THREE.Vector3();
  for (let i = 0; i < positionAttr.count; i++) {
    dir.fromBufferAttribute(positionAttr, i).normalize();
    const h = displayHeight(heightAt(dir), dir);
    const displaced = dir.multiplyScalar(radius + h * bumpHeight);
    positionAttr.setXYZ(i, displaced.x, displaced.y, displaced.z);
  }
  geometry.computeVertexNormals();
}

// A perfectly smooth sphere reads as a billiard ball, not water — a tiny
// bit of gentle undulation breaks up specular highlights into something
// closer to real (if idealized/toy-like) water texture.
export function rippleSphere(geometry: THREE.SphereGeometry, radius: number, amplitude: number) {
  const positionAttr = geometry.attributes.position;
  const dir = new THREE.Vector3();
  for (let i = 0; i < positionAttr.count; i++) {
    dir.fromBufferAttribute(positionAttr, i).normalize();
    const ripple = fbm3(dir.x * 26 + 5.5, dir.y * 26 + 5.5, dir.z * 26 + 5.5, 2);
    const displaced = dir.clone().multiplyScalar(radius + ripple * amplitude);
    positionAttr.setXYZ(i, displaced.x, displaced.y, displaced.z);
  }
  geometry.computeVertexNormals();
}

// Real poured resin (or real water, via surface tension) doesn't meet a
// solid edge as a flat plane — it climbs very slightly up against it. A
// thin raised lip right where the ocean shell nears the coastline reads
// as that meniscus instead of water looking like a flat sheet dropped on
// top of the land. Reads the *land* height field to find "how close to
// the coast is this ocean vertex", so it hugs the actual jagged coastline
// rather than being a uniform ring at a fixed radius. Composes on top of
// whatever radial displacement the geometry already has (rippleSphere,
// etc.) instead of overwriting it, since it reads the vertex's current
// radius rather than assuming a base one.
export function applyCoastalMeniscus(geometry: THREE.SphereGeometry, amount: number) {
  const positionAttr = geometry.attributes.position;
  const dir = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const coastReach = 0.03;
  for (let i = 0; i < positionAttr.count; i++) {
    pos.fromBufferAttribute(positionAttr, i);
    const currentRadius = pos.length();
    dir.copy(pos).normalize();
    const distFromCoast = SEA_LEVEL - heightAt(dir);
    if (distFromCoast < 0 || distFromCoast >= coastReach) continue;
    const bump = (1 - distFromCoast / coastReach) * amount;
    const displaced = dir.multiplyScalar(currentRadius + bump);
    positionAttr.setXYZ(i, displaced.x, displaced.y, displaced.z);
  }
  geometry.computeVertexNormals();
}

export { badlandsAt };
