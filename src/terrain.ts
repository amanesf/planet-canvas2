import * as THREE from 'three';
import { fbm3 } from './noise';

// Tuned so land covers roughly 30% of the surface, like real Earth's
// land:sea ≈ 3:7 (verified empirically against heightAt's noise distribution).
export const SEA_LEVEL = 0.095;
const COAST_WIDTH = 0.012;

// Toned down across the board — high-saturation primary colors are what
// made this read as "cheap mobile game" regardless of how much detail
// sat on top of them. Real terrain photography has much narrower,
// muddier, more correlated color ranges than a clean color wheel.
const shoreColor = new THREE.Color('#d9c58a');
// muted/soil-toned on purpose — the vivid green now comes from actually
// covering the ground in grass/tree instances, not from painting the
// terrain itself bright green underneath them
const landColor = new THREE.Color('#6d7f4c');
const desertColor = new THREE.Color('#bd9a5f');
const rockColor = new THREE.Color('#7d7264');
const snowColor = new THREE.Color('#e9eef0');
const riverColor = new THREE.Color('#3184a0');
const tundraColor = new THREE.Color('#8b8a6e');
const iceColor = new THREE.Color('#dce8ea');
// exposed sedimentary rock strata — badlands/canyon country
const badlandsColorA = new THREE.Color('#b5652f');
const badlandsColorB = new THREE.Color('#dba15c');
const badlandsColorC = new THREE.Color('#823f28');

// Deep and saturated, almost black in shadow — a real poured-resin ocean
// over dark blue paint reads as near-black except right where a light
// actually hits it, not as an evenly bright teal swimming pool.
const deepOceanColor = new THREE.Color('#040e1c');
const midOceanColor = new THREE.Color('#0c3450');
const shallowOceanColor = new THREE.Color('#1c5f76');

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

  // Polar ice continents: guarantee a broad ice-sheet landmass right at
  // the poles instead of leaving it to chance whether ordinary continent
  // noise happens to land there — Antarctica isn't a lucky accident, it's
  // reliably there every time you look at a real globe's pole.
  const poleCloseness = smoothstep(Math.abs(dir.y), 0.88, 0.97);
  if (poleCloseness > 0) {
    const iceShelfHeight =
      SEA_LEVEL + 0.05 + fbm3(dir.x * 3 + 222, dir.y * 3 + 222, dir.z * 3 + 222, 2) * 0.03;
    n = THREE.MathUtils.lerp(n, iceShelfHeight, poleCloseness);
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
export function aridityAt(dir: THREE.Vector3): number {
  const belt = desertBeltAt(dir);
  const bias = climateBiasAt(dir);
  const local = fbm3(dir.x * 2.6 + 51.3, dir.y * 2.6 + 51.3, dir.z * 2.6 + 51.3, 3);
  const commitment = belt * smoothstep(bias, 0, 0.5);
  return belt * 0.55 + bias * 0.4 + local * (0.4 - commitment * 0.28);
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
function badlandsAt(dir: THREE.Vector3): number {
  return fbm3(dir.x * 0.9 + 555, dir.y * 0.9 + 555, dir.z * 0.9 + 555, 2);
}
export const BADLANDS_THRESHOLD = 0.28;

// Latitude-driven climate (Whittaker's temperature axis), like the design
// memo originally called for: hot at the equator, cold at the poles, and
// colder again with elevation — with a little noise so the ice line isn't
// a perfect circle. dir.y stands in for latitude, matching how the rest
// of the terrain already uses it.
export function temperatureAt(dir: THREE.Vector3, elevation: number): number {
  const latitude = 1 - Math.abs(dir.y);
  const wobble = fbm3(dir.x * 1.3 + 700, dir.y * 1.3 + 700, dir.z * 1.3 + 700, 2) * 0.18;
  const elevationCooling = Math.max(elevation, 0) * 1.6;
  return latitude + wobble - elevationCooling;
}

export const ICE_TEMPERATURE = -0.14;
const TUNDRA_TEMPERATURE = 0.09;

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
const LAND_BOOST = 2.5;
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
export function terracedElevation(height: number): number {
  if (height < SEA_LEVEL) return 0;
  const t = Math.min((height - SEA_LEVEL) / TERRACE_MAX, 1);
  return terraceCurve(t) * TERRACE_MAX;
}

// dir is needed to look up whether this point sits in a rare "great
// range" (Himalaya-scale) zone — see orogenyAt above. Paint/coloring
// still uses plain terracedElevation, so a dramatic peak still gets
// colored by its normal elevation percentile (naturally reads as rock/
// snow already); only the geometry shoots up further.
export function displayHeight(height: number, dir: THREE.Vector3): number {
  if (height < SEA_LEVEL) return UNDERWATER_HEIGHT;
  const orogenyBoost = 1 + smoothstep(orogenyAt(dir), OROGENY_THRESHOLD, OROGENY_THRESHOLD + 0.12) * 2.4;
  return SEA_LEVEL + terracedElevation(height) * LAND_BOOST * orogenyBoost;
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
  // aridity — Antarctica doesn't care if it would otherwise be a beach
  if (temperature < ICE_TEMPERATURE) {
    return outColor.copy(iceColor);
  }

  const desertAmount = smoothstep(aridity, 0.4, 0.58);

  if (elevation < 0.15) {
    // cold + dry lowland reads as bare tundra instead of green — being
    // *cold* isn't the same as being *dry*, so this stacks with (and can
    // override) the desert blend below rather than replacing it outright
    if (temperature < TUNDRA_TEMPERATURE) {
      const coldness = smoothstep(temperature, TUNDRA_TEMPERATURE, ICE_TEMPERATURE);
      outColor.copy(landColor).lerp(tundraColor, coldness);
      outColor.lerp(desertColor, desertAmount * (1 - coldness));
    } else {
      // sand only right at the coast — being *low* elevation isn't the
      // same as being *dry*. A wide shore→green transition was tying the
      // two together, so any low flat continent read as one giant beach
      // regardless of its actual (independent) aridity value.
      const t = elevation / 0.035;
      outColor.copy(shoreColor).lerp(landColor, Math.min(Math.max(t, 0), 1));
      outColor.lerp(desertColor, desertAmount);
    }
  } else if (elevation < 0.22) {
    const t = (elevation - 0.15) / 0.07;
    outColor.copy(landColor).lerp(rockColor, t);
    outColor.lerp(desertColor, desertAmount * (1 - t) * 0.5);
  } else if (elevation < TERRACE_MAX) {
    const t = (elevation - 0.22) / (TERRACE_MAX - 0.22);
    outColor.copy(rockColor).lerp(snowColor, t);
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
    outColor.lerp(badlandsColor(elevation), badlandsGate);
  }

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

function terrainColor(dir: THREE.Vector3, height: number, riverStrength: number): THREE.Color {
  const h = height + coastlineJitter(dir);
  const temperature = temperatureAt(dir, terracedElevation(Math.max(h, SEA_LEVEL)));
  const seaIce = smoothstep(temperature, ICE_TEMPERATURE, ICE_TEMPERATURE - 0.08);
  const beltCloseness = orogenyBeltAt(dir);

  let color: THREE.Color;
  if (h < SEA_LEVEL - COAST_WIDTH) {
    // hidden beneath the glass ocean shell almost all the time, but the
    // shell is very slightly transparent, so keep this in the same family
    color = outColor.copy(midOceanColor).lerp(iceColor, seaIce);
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
  const t = smoothstep(height, -0.2, SEA_LEVEL);
  if (t < 0.6) {
    outColor.copy(deepOceanColor).lerp(midOceanColor, t / 0.6);
  } else {
    outColor.copy(midOceanColor).lerp(shallowOceanColor, (t - 0.6) / 0.4);
  }
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

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      dirForPixel(px, py, width, height, dir);

      const h = heightAt(dir);
      const riverStrength = h >= SEA_LEVEL ? sampleRiverFlow(river, dir) : 0;
      const c = terrainColor(dir, h, riverStrength);

      const idx = (py * width + px) * 4;
      image.data[idx] = Math.round(c.r * 255);
      image.data[idx + 1] = Math.round(c.g * 255);
      image.data[idx + 2] = Math.round(c.b * 255);
      image.data[idx + 3] = 255;
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
      const h = heightAt(dir);
      const c = oceanColor(dir, h);

      const idx = (py * width + px) * 4;
      image.data[idx] = Math.round(c.r * 255);
      image.data[idx + 1] = Math.round(c.g * 255);
      image.data[idx + 2] = Math.round(c.b * 255);
      image.data[idx + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
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

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      dirForPixel(px, py, width, height, dir);

      const ridge = Math.sin(dir.x * 42 + dir.z * 17 + dir.y * 9) * 0.5 + 0.5;
      const chop = fbm3(dir.x * 30 + 8, dir.y * 30 + 8, dir.z * 30 + 8, 3);
      const v = 0.5 + (ridge - 0.5) * 0.5 + chop * 0.18;

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
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
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

      const h = heightAt(dir);
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

        // fine crystalline sparkle only on the highest, snowiest ground —
        // real granular snow/frost catches light in tiny irregular
        // flecks, not as a single smooth white gradient
        const elevation = terracedElevation(h);
        const snowiness = smoothstep(elevation, 0.2, TERRACE_MAX);
        if (snowiness > 0) {
          const sparkle = fbm3(dir.x * 300 + 91, dir.y * 300 + 91, dir.z * 300 + 91, 2);
          v += sparkle * 0.06 * snowiness;
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
