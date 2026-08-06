import * as THREE from 'three';
import { fbm3 } from './noise';
import { clumpDensity, mulberry32 } from './spatialHash';

// Tuned so land covers roughly 30% of the surface, like real Earth's
// land:sea ≈ 3:7 (verified empirically against heightAt's noise distribution).
export const SEA_LEVEL = 0.072;
// The width of the painted beach band above sea level. Exported because
// vegetation placement needs to agree with it: the one thing an elevation
// test is genuinely for is keeping plants off the strip of sand the paint
// has already drawn, and any threshold wider than this one is a guess.
export const COAST_WIDTH = 0.006;

// Pushed a step more vivid than the original "toned down across the
// board" pass — that rule was reacting against flat primary-color-wheel
// saturation, and it overcorrected into looking washed out next to the
// reference target (a painted, lit miniature, not a satellite photo).
// Real terrain photography has narrower, muddier ranges than a color
// wheel, but a *lit, varnished model* reads with noticeably more
// chroma than raw ground does — that's the gap being closed here, not a
// reversal of the original reasoning.
const shoreColor = new THREE.Color('#b8a578');
// the vivid green mostly still comes from actually covering the ground in
// grass/tree instances, not from painting the terrain itself bright green
// underneath them — but the bare soil between them reads richer now too
const landColor = new THREE.Color('#5e7a3f');
// Two separate deserts, because sand and stone desert look nothing alike:
// pale wind-sorted sand, and the darker gravel pavement that surrounds it.
const desertColor = new THREE.Color('#d6a855');
// Paler and much less saturated than the #9c7a48 this started at. Reg is
// a dull buff gravel; at that saturation it was orange, and orange over
// most of the desert's area is what made the Sahara read as Mars.
const desertGravelColor = new THREE.Color('#b3a077');
// Grassland, and the biome this globe did not have.
//
// The scatter was measured and re-measured for it — the pampas came out at
// 5.86 tufts against the Amazon's 1.00 — and none of it put a grassland on
// the planet, because a tuft is 1 px wide against a 7 px tree crown and no
// ratio of invisible things is visible. A prairie is not read as blades of
// grass at this scale; it is read as *ground of a different colour with no
// trees on it*, and the ground here was painted the same forest green
// everywhere from Iowa to the Congo. So the biome lives in the paint now
// and the tufts are its texture.
//
// Two of them, because grassland is not one colour: temperate prairie and
// steppe are a dry olive-straw, and the tropical savanna belt is yellower
// and browner still. Both are markedly paler than `landColor`, which is
// what separates them from forest at any distance where the trees
// themselves have stopped resolving.
const grasslandColor = new THREE.Color('#9a9a5b');
const savannaGrassColor = new THREE.Color('#b09a55');
// Warm sedimentary rock, for the foothills a forest could grow on.
const rockColor = new THREE.Color('#7d5c3e');
// The dark rock of a desert massif — the Ahaggar and the Tibesti, the
// thing that is not sand in a desert full of sand.
const desertRockColor = new THREE.Color('#6b5540');
// Alpine stone is a *different rock*, and it is the difference the eye
// reads first at altitude: cold grey granite scoured bare, not the warm
// brown of a lowland outcrop. Colouring high ground as merely a darker
// version of the same brown is what made every mountain read as a big hill.
const alpineRockColor = new THREE.Color('#7d7d8c');
const alpineShadowColor = new THREE.Color('#4e5058');
// Boreal forest floor: needle litter and peat, much darker and cooler than
// temperate soil.
const taigaColor = new THREE.Color('#3d5c3a');
// Tropical soil: the red laterite that shows through equatorial jungle.
const tropicalSoilColor = new THREE.Color('#7a4a2c');
const snowColor = new THREE.Color('#e7eef2');
const riverColor = new THREE.Color('#2f95c2');
const tundraColor = new THREE.Color('#928d5c');
const iceColor = new THREE.Color('#dce8ee');
// exposed sedimentary rock strata — badlands/canyon country
const badlandsColorA = new THREE.Color('#7d6248');
const badlandsColorB = new THREE.Color('#a8916c');
const badlandsColorC = new THREE.Color('#68482f');

// Rich, saturated sapphire blue — darker in the depths but never reading
// as black; a real poured-resin ocean over blue paint keeps its color
// even in shadow; only the *highlight* should go near-white, not the
// whole sea.
const deepOceanColor = new THREE.Color('#0a4a78');
const midOceanColor = new THREE.Color('#1479ad');
const shallowOceanColor = new THREE.Color('#2bbccf');

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

// Coral: a handful of saturated accent hues against the otherwise muted
// palette. The "no high-saturation primary colors" rule elsewhere in this
// file is about *fake* vividness — live coral is one of the few things in
// nature that really is that saturated, the same exception the lava glow
// below gets.
const coralColors = [
  new THREE.Color('#e0925f'), // salmon
  new THREE.Color('#c37cab'), // magenta-pink
  new THREE.Color('#74bfb8'), // cyan
  new THREE.Color('#cdab52'), // gold
];

// A dry lakebed's crust: pale, faintly pink-white salt, with darker
// cracked mud showing through between the plates.
const saltColor = new THREE.Color('#ded2c4');
const saltCrackColor = new THREE.Color('#8c7c68');

// Cooled basalt reads as close to black but never quite — real lava rock
// still carries a little warmth. The crack glow is the other saturated
// exception in the file, next to coral: the one thing here that's meant
// to look like it's actually emitting light.
const basaltColor = new THREE.Color('#1c1815');
const lavaGlowColor = new THREE.Color('#ff5a1f');
const craterLakeColor = new THREE.Color('#2f6f8a');

// A river mouth's sediment fan: pale silty tan, distinct from both the
// riverbed blue and ordinary shore sand.
const deltaColor = new THREE.Color('#a99568');

// Whitewater foam at the base of a waterfall.
const foamColor = new THREE.Color('#eef6f2');

// Surf. Slightly cooler and less bright than the waterfall's foam: this is
// aerated water seen through the resin, not a white highlight.
const surfColor = new THREE.Color('#e4f2f1');

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

// Same convention as dirForPixel/realElevationAt below, in degrees: standard
// equirectangular, prime meridian at the image's horizontal center.
export function latLonToDir(latDeg: number, lonDeg: number): THREE.Vector3 {
  const phi = ((lonDeg + 180) / 360) * Math.PI * 2;
  const theta = ((90 - latDeg) / 180) * Math.PI;
  return new THREE.Vector3(-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta));
}

// The real Alpide belt: Alps -> Caucasus/Zagros -> Himalaya -> Myanmar ->
// Indonesian arc (Sulawesi) — where the source elevation data actually has
// mountains, not a stand-in shape.
const MOUNTAIN_BELT_A = [
  latLonToDir(46, 8), // Alps
  latLonToDir(35, 48), // Zagros / Caucasus
  latLonToDir(29, 84), // Himalaya
  latLonToDir(22, 98), // Myanmar highlands
  latLonToDir(-2, 121), // Sulawesi, Indonesian arc
];

// The Pacific Ring of Fire's eastern arm: Alaska Range -> Rockies -> Sierra
// Madre -> Andes, the length of the Americas.
const MOUNTAIN_BELT_B = [
  latLonToDir(62, -151), // Alaska Range
  latLonToDir(39, -106), // Rockies, Colorado
  latLonToDir(17, -95), // Sierra Madre, Mexico
  latLonToDir(-5, -77), // Andes, Peru
  latLonToDir(-33, -70), // Andes, Chile
  latLonToDir(-50, -73), // Patagonia
];

const mountainBeltSamples: THREE.Vector3[] = [
  ...buildBeltSamples(MOUNTAIN_BELT_A, 5),
  ...buildBeltSamples(MOUNTAIN_BELT_B, 5),
];

// ---------------------------------------------------------------------
// Volcanoes: a handful of explicit landmark peaks, the same "an artist
// decided it goes here" logic as the mountain belts above — a smooth
// conical silhouette with a crater dead centre is a specific named shape,
// not something a noise threshold over the belt would ever produce (that
// gives an irregular ridge, not a clean cone). The centres were picked by
// walking candidate points on land, well inside an orogeny belt (real
// volcanism follows subduction zones), spread apart across the globe —
// not eyeballed, since a hand-guessed direction has no guarantee of
// landing on actual land.
// ---------------------------------------------------------------------

export interface VolcanoDef {
  center: THREE.Vector3;
  radius: number;
  craterRadius: number;
  /** active: a glowing lava pool; dormant: a crater lake instead */
  active: boolean;
}

export const VOLCANOES: VolcanoDef[] = [
  // Kilauea, Hawaii — a persistently active lava lake
  { center: latLonToDir(19.42, -155.29), radius: 0.052, craterRadius: 0.016, active: true },
  // Vesuvius, Italy — dormant, overlooking the Bay of Naples
  { center: latLonToDir(40.82, 14.43), radius: 0.048, craterRadius: 0.015, active: false },
  // Cotopaxi, Ecuador — one of the Andes' most active
  { center: latLonToDir(-0.68, -78.44), radius: 0.05, craterRadius: 0.015, active: true },
  // Mount Fuji, Japan — dormant
  { center: latLonToDir(35.36, 138.73), radius: 0.046, craterRadius: 0.014, active: false },
];

export interface VolcanoSample {
  /** 0 on the outer flank, 1 at the summit */
  cone: number;
  /** 0 outside the crater, 1 at its centre */
  crater: number;
  active: boolean;
}

/** Which volcano (if any) has a hold on this point, and how strongly. */
export function volcanoAt(dir: THREE.Vector3): VolcanoSample | null {
  let best: VolcanoSample | null = null;
  for (const v of VOLCANOES) {
    const dist = dir.angleTo(v.center);
    if (dist > v.radius) continue;
    const cone = Math.pow(1 - dist / v.radius, 1.7);
    const crater = dist < v.craterRadius ? 1 - dist / v.craterRadius : 0;
    if (!best || cone > best.cone) best = { cone, crater, active: v.active };
  }
  return best;
}

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

// Bilinear, not nearest — see sampleField's comment above for why a hard
// cell edge in this grid became a visible line once real elevation data
// gave heightAt long, genuinely flat stretches with nothing else to hide it.
function orogenyBeltAt(dir: THREE.Vector3): number {
  const { grid, width, height } = orogenyGrid();
  const theta = Math.acos(THREE.MathUtils.clamp(dir.y, -1, 1));
  let phi = Math.atan2(dir.z, -dir.x);
  if (phi < 0) phi += Math.PI * 2;
  const fx = (phi / (Math.PI * 2)) * width;
  const fy = (theta / Math.PI) * height;

  const x0 = Math.floor(fx);
  const y0 = THREE.MathUtils.clamp(Math.floor(fy), 0, height - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const x0w = ((x0 % width) + width) % width;
  const x1w = (x0w + 1) % width;
  const y1 = Math.min(y0 + 1, height - 1);

  const g00 = grid[y0 * width + x0w];
  const g10 = grid[y0 * width + x1w];
  const g01 = grid[y1 * width + x0w];
  const g11 = grid[y1 * width + x1w];
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(g00, g10, tx), THREE.MathUtils.lerp(g01, g11, tx), ty);
}

// Real-world coastlines: a single small equirectangular grayscale image
// (public/world-elevation.png — a downsampled NASA Blue Marble Topography +
// Bathymetry composite, CC BY-SA 4.0 via Wikimedia Commons) stands in for
// the fbm3 noise this used to be built from. Loaded once at startup by
// loadRealElevationData; every other layer in heightAt (rugged detail, mid
// relief, ice caps, volcano cones, mountain belts) still applies on top of
// this exactly as before, so only the *shape* of the continents changed
// from imaginary to real.
let realElevation: { data: Uint8ClampedArray; width: number; height: number } | null = null;

/** Must resolve before anything that reads heightAt/macroHeightAt runs. */
export async function loadRealElevationData(url: string): Promise<void> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load elevation data: ${url}`));
    img.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, image.width, image.height);
  realElevation = { data, width: image.width, height: image.height };
}

// This dataset's own natural land/sea boundary. Anchoring one exact
// grayscale value to SEA_LEVEL keeps every one of heightAt's SEA_LEVEL-
// relative thresholds (ruggedAmount, landMask, coastal ocean opacity...)
// working unchanged.
//
// Measured off the raster itself rather than guessed. The source is a
// topography+bathymetry composite, and its two domains do not overlap:
// sampled inside a known shallow shelf sea (the North Sea) the grayscale
// tops out at 143, and sampled inside known flat continental interiors
// (the Congo basin, the Great Plains) it starts at 147-148. The gap is
// where the boundary belongs.
//
// It used to sit at 145, which cuts *through* the lowest land band rather
// than under it, and 144-145 is precisely where the world's flattest
// lowlands sit: 60% of the Amazon basin, 73% of the pampas and 83% of the
// west Siberian plain are gray 144 or 145. All of it was being read as
// ocean. The global check agrees with the local one — area-weighted over
// the whole raster, gray>143 is 28.0% of the sphere against Earth's real
// ~29%, where gray>145 gives only 23.8%.
const ELEVATION_SEA_GRAY = 143;

// The first step of land above the waterline lands here, not at zero.
//
// Land occupies the top 44% of the raster's range and the paint's shore
// band is the first 0.006 of a 0.33-unit height span — under 2% — so on a
// straight ramp any ground in the bottom fiftieth of the world's elevation
// range paints as beach. That is a fair description of a coastal plain and
// a terrible one of the Amazon, which really is in the bottom fiftieth
// (some tens of metres over two thousand kilometres) and was coming out as
// an entire continent of sand. Lifting the first land step clear of the
// band says the thing that is actually true: this is land, it is merely
// very low land. The beach has not gone anywhere — it moves to the water
// side, where the shallow shelf still sits inside the band and still paints
// as a pale rim around every coast.
const ELEVATION_LAND_FLOOR = COAST_WIDTH;

// Most land on the real dataset is unremarkable lowland — only a small
// fraction of it is genuinely mountainous — but a plain linear ramp from
// the sea-level boundary to the highest peak pushed the *median* land pixel
// (gray ~159, barely above the ELEVATION_SEA_GRAY boundary) into heightAt's
// "high mountain" ruggedness/terrace range, reading as excessively tall and
// jagged almost everywhere. Raising the normalized fraction to a power
// compresses ordinary hills/plateaus back down near sea level while still
// letting the rare true summits (Himalaya, Andes) reach the top.
//
// A *pure* power curve overcorrected: gray values only just above
// ELEVATION_SEA_GRAY (most of an ordinary continental interior — the US
// Midwest, the Great Lakes basin, that whole gray-145-to-160 band) got
// compressed to a sliver of a millimetre above SEA_LEVEL, thinner than the
// glass ocean shell's own coastal-meniscus/wave-ripple reach — so real
// lowland that should be dry land was visually drowned by the sea shell
// sitting right over it. Blending in a straight linear term restores a
// guaranteed baseline lift proportional to how far above sea level a pixel
// actually is, while the power term still does its job flattening the
// upper range.
const ELEVATION_LAND_MAX = 0.4;
const ELEVATION_LAND_GAMMA = 1.8;
const ELEVATION_LAND_LINEAR_MIX = 0.35;

function decodeRealElevation(gray: number): number {
  if (gray <= ELEVATION_SEA_GRAY) {
    // the source data is a real topography+bathymetry composite, so ocean
    // gray already varies with actual depth — preserving that range (rather
    // than flattening every ocean pixel to one value) is what gives shelves
    // and trenches their correct relative depth once the coloring below
    // reads it back out
    return THREE.MathUtils.mapLinear(gray, 0, ELEVATION_SEA_GRAY, -0.45, SEA_LEVEL);
  }
  const t = (gray - ELEVATION_SEA_GRAY) / (255 - ELEVATION_SEA_GRAY);
  const shaped = THREE.MathUtils.lerp(Math.pow(t, ELEVATION_LAND_GAMMA), t, ELEVATION_LAND_LINEAR_MIX);
  return (
    SEA_LEVEL +
    ELEVATION_LAND_FLOOR +
    shaped * (ELEVATION_LAND_MAX - SEA_LEVEL - ELEVATION_LAND_FLOOR)
  );
}

// Same inverse (dir -> phi/theta -> pixel) convention as sampleField/
// orogenyBeltAt/sampleRiverFlow above, bilinearly filtered (the source
// image is coarse enough at 768x384 that nearest-sampling would show as
// visible blocking once the terrain's own displacement magnifies it), with
// wraparound on the seam (x) and clamping at the poles (y).
function realElevationAt(dir: THREE.Vector3): number {
  if (!realElevation) return SEA_LEVEL;
  const { data, width, height } = realElevation;
  const theta = Math.acos(THREE.MathUtils.clamp(dir.y, -1, 1));
  let phi = Math.atan2(dir.z, -dir.x);
  if (phi < 0) phi += Math.PI * 2;
  const fx = (phi / (Math.PI * 2)) * width;
  const fy = (theta / Math.PI) * height;

  const x0 = Math.floor(fx);
  const y0 = THREE.MathUtils.clamp(Math.floor(fy), 0, height - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const x0w = ((x0 % width) + width) % width;
  const x1w = (x0w + 1) % width;
  const y1 = Math.min(y0 + 1, height - 1);

  const g00 = data[(y0 * width + x0w) * 4];
  const g10 = data[(y0 * width + x1w) * 4];
  const g01 = data[(y1 * width + x0w) * 4];
  const g11 = data[(y1 * width + x1w) * 4];
  const gray = THREE.MathUtils.lerp(THREE.MathUtils.lerp(g00, g10, tx), THREE.MathUtils.lerp(g01, g11, tx), ty);
  return decodeRealElevation(gray);
}

// Big smooth rounded continents and coastal hills as the base shape — kept
// separate from the "rugged" detail below because it also drives river
// flow direction, and rugged high-frequency noise creates countless tiny
// local pits that would trap water before it ever reaches the sea.
function macroHeightAt(dir: THREE.Vector3): number {
  return realElevationAt(dir);
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
  //
  // The mask starts *at* sea level rather than 0.03 below it, and reaches
  // full strength further up, because relief may shape land but it must not
  // decide whether land exists. Measured: the old mask gave a basin sitting
  // a few thousandths above sea level a signed wobble of about +-0.021,
  // several times its own height above the waterline, so the downward half
  // of it drowned the place. The Congo is dry land in 100% of the elevation
  // raster's own pixels and came out 57% below sea level after this line;
  // the Sahel 62%, central Siberia 66%. Everything downstream that asks
  // "is this land" — the paint, the beach band, every vegetation layer —
  // was reading a coin flip over the flattest and most vegetated ground on
  // the planet. Now the relief fades out as the ground it is texturing runs
  // out of headroom, which also happens to be correct: the Amazon and the
  // Congo really are flat.
  const midRelief = fbm3(dir.x * 3.4 + 17.7, dir.y * 3.4 + 17.7, dir.z * 3.4 + 17.7, 3);
  const landMask = smoothstep(macro, SEA_LEVEL, SEA_LEVEL + 0.1);
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

  // Volcanoes: an explicit conical peak with a crater bowl at its summit,
  // blended in over whatever the ordinary noise terrain says was there.
  // The crater floor sits well up the flank (not at sea level) — a lava
  // pool or crater lake is a summit feature, not a hole clear through the
  // mountain.
  const volcano = volcanoAt(dir);
  if (volcano) {
    const peakElevation = SEA_LEVEL + TERRACE_MAX * 1.05;
    let volcanoHeight = THREE.MathUtils.lerp(SEA_LEVEL, peakElevation, volcano.cone);
    if (volcano.crater > 0) {
      const craterFloor = SEA_LEVEL + TERRACE_MAX * 0.62;
      volcanoHeight = THREE.MathUtils.lerp(volcanoHeight, craterFloor, smoothstep(volcano.crater, 0, 1));
    }
    n = THREE.MathUtils.lerp(n, volcanoHeight, smoothstep(volcano.cone, 0.05, 0.3));
  }

  return Math.max(n, -0.2); // flatten the deep ocean floor a bit
}

// (The latitude desert belt and the continent-scale wet/dry bias that used
// to live here are gone: they were a stand-in for a climate map, and there
// is a real climate map now — see the Köppen section below.)

// ---------------------------------------------------------------------
// Real climate
// ---------------------------------------------------------------------
// The continents have been real since the elevation data went in. The
// *climate* on them was not: aridity came out of the latitude belt above
// plus two octaves of noise, which is a decent-looking abstraction and a
// completely fictional map. It put the subtropical dry belt in the right
// band — and then let noise decide which parts of that band were actually
// desert. So the Sahara might come out green, the Amazon might come out
// as scrub, and Alaska's boreal forest was wherever the dice fell. Once
// the coastlines are recognisable that is not a stylisation any more, it
// is just wrong, and it is wrong in exactly the places a viewer knows
// best.
//
// Köppen-Geiger is the fix, and it is the same kind of fix the elevation
// was: one small raster, looked up directly. Beck et al.'s 1980-2016
// map (CC BY-SA 4.0, via Wikimedia Commons) is quantised offline to one
// byte per pixel — a class index, 0 for sea — which comes to 88 KB at
// 2048x1024. Every downstream consumer of aridity keeps working unchanged
// because what changes is only where the values come from.
//
// Class indices are the standard legend order: 1-3 tropical A, 4-7 dry B,
// 8-16 temperate C, 17-28 continental D, 29-30 polar E.
const KOPPEN_CLASSES = 30;

/**
 * How dry each class is, on the same 0..1 scale the noise field used, so
 * DESERT_ARIDITY_THRESHOLD and every other tuned constant still mean what
 * they meant. The B classes are the only ones that clear the desert
 * threshold — which is the entire point: sand is now exactly where the
 * real deserts are and nowhere else.
 */
const KOPPEN_ARIDITY = [
  0.34, // 0: no data — a middling value, only reachable on ground the map calls sea
  0.10, 0.14, 0.36, // Af Am Aw
  0.97, 0.90, 0.64, 0.58, // BWh BWk BSh BSk
  0.48, 0.44, 0.42, // Csa Csb Csc — summer-dry, but not desert
  0.30, 0.28, 0.28, // Cwa Cwb Cwc
  0.18, 0.16, 0.18, // Cfa Cfb Cfc
  0.44, 0.42, 0.40, 0.40, // Dsa Dsb Dsc Dsd
  0.32, 0.30, 0.28, 0.28, // Dwa Dwb Dwc Dwd
  0.20, 0.18, 0.18, 0.20, // Dfa Dfb Dfc Dfd
  0.36, 0.42, // ET EF — cold deserts by rainfall, but the snow logic owns them
];

/**
 * How much closed forest each class carries, 0..1. This is what finally
 * separates rainforest from savanna from steppe from taiga: the Amazon
 * (Af) is solid canopy, the Sahara (BWh) has none, and the whole boreal
 * belt across Alaska, Canada and Siberia (Dfc) is dense conifer — which
 * is the specific thing that was missing.
 */
const KOPPEN_CANOPY = [
  0.35, // 0: no data
  1.0, 0.95, 0.5, // Af Am Aw — rainforest, monsoon, savanna
  0.0, 0.02, 0.1, 0.14, // BWh BWk BSh BSk
  0.4, 0.55, 0.45, // Csa Csb Csc
  0.6, 0.68, 0.5, // Cwa Cwb Cwc
  0.82, 0.9, 0.72, // Cfa Cfb Cfc
  0.5, 0.55, 0.5, 0.4, // Dsa Dsb Dsc Dsd
  0.6, 0.68, 0.7, 0.45, // Dwa Dwb Dwc Dwd
  0.85, 0.9, 0.85, 0.5, // Dfa Dfb Dfc Dfd
  0.05, 0.0, // ET EF
];

/** True for the continental/polar classes, where the forest is conifer. */
const KOPPEN_CONIFEROUS: boolean[] = Array.from(
  { length: KOPPEN_CLASSES + 1 },
  (_, i) => i >= 17,
);

/**
 * How much exposed sedimentary rock country — canyon, mesa, hamada — each
 * class carries, 0..1.
 *
 * Badlands used to be a pure global noise field with no geography in it at
 * all, which put grey-brown banded rock across the middle of the Amazon and
 * the Congo and let it veto vegetation over a fifth of all land. Badlands
 * are a *dry* landform: they exist because there is not enough rain to grow
 * a soil cover over the bedrock. So the field they come from should be the
 * dry classes, and essentially nothing else.
 *
 * The B group carries almost all of it (the Colorado Plateau, the Sahara's
 * hamada, the Karoo, the Gobi are BWk/BSk/BWh), the dry-summer continental
 * Ds group carries a little (the American interior west, Anatolia, inland
 * Iran), and the everwet and monsoon classes carry none — an Af rainforest
 * has no exposed bedrock by definition.
 */
const KOPPEN_BADLANDS = [
  0, // 0: no data
  0, 0, 0, // Af Am Aw — closed canopy over deep soil, never bare rock
  // The hot deserts are mostly erg and reg — sand sea and gravel plain —
  // with hamada a minority of their area, so BWh sits well below the cold
  // deserts and high plateaus (BWk, BSk: Colorado, the Gobi, Patagonia)
  // where stripped bedrock really is the characteristic surface.
  0.5, 1.0, 0.45, 0.85, // BWh BWk BSh BSk
  0.2, 0.1, 0.05, // Csa Csb Csc — a little, e.g. the Spanish bardenas
  0, 0, 0, // Cwa Cwb Cwc
  0, 0, 0, // Cfa Cfb Cfc
  0.5, 0.5, 0.35, 0.2, // Dsa Dsb Dsc Dsd — dry-summer continental interior
  0.12, 0.1, 0.05, 0.05, // Dwa Dwb Dwc Dwd — the Gobi's northern margin
  0, 0, 0, 0, // Dfa Dfb Dfc Dfd
  0.05, 0, // ET EF — polar desert is rock, but the snow logic owns it
];

/**
 * How densely people settle each climate, 0..1 — the shape of the night
 * lights map, not of the biosphere.
 *
 * The scattered night-lights pass used to score habitability as "warm, low,
 * not arid", which is a description of a *rainforest*: the Amazon, the
 * Congo and island south-east Asia came out brighter than Europe or the
 * eastern United States, the exact inverse of the photograph everybody has
 * seen. Warmth is not the variable. People live where the climate is
 * temperate-humid or monsoonal — Cfa, Cfb, Cwa, Dwa, Dfa/Dfb, the
 * Mediterranean Cs — and they conspicuously do not live in everwet
 * rainforest (Af), sand desert (BW), taiga (Dfc/Dwc) or tundra.
 */
const KOPPEN_SETTLEMENT = [
  0.15, // 0: no data
  0.10, 0.32, 0.50, // Af Am Aw — rainforest is emphatically not where people live
  0.03, 0.03, 0.26, 0.24, // BWh BWk BSh BSk — the Sahara and the outback go dark
  0.85, 0.80, 0.35, // Csa Csb Csc — the Mediterranean rim, California
  0.95, 0.68, 0.30, // Cwa Cwb Cwc — south China, the Indian plateau, highland Mexico
  1.00, 1.00, 0.45, // Cfa Cfb Cfc — the US east, western Europe, Japan, east China
  0.38, 0.34, 0.14, 0.05, // Dsa Dsb Dsc Dsd
  0.70, 0.44, 0.10, 0.03, // Dwa Dwb Dwc Dwd — Manchuria and the Korean peninsula
  0.68, 0.58, 0.06, 0.02, // Dfa Dfb Dfc Dfd — Dfc is Siberia and it is empty
  0.02, 0.00, // ET EF
];

/**
 * The Köppen group a class belongs to — the first one or two letters,
 * which is the level the eye actually reads: "rainforest", "savanna",
 * "sand desert", "steppe", "Mediterranean", "taiga", "tundra". Species
 * selection keys off this rather than off a temperature threshold, which
 * is what makes an Aw savanna get acacias and a Cs coast get cypresses
 * even though the two sit at similar temperatures.
 */
export type ClimateGroup =
  | 'none'
  | 'Af'
  | 'Am'
  | 'Aw'
  | 'BW'
  | 'BS'
  | 'Cs'
  | 'Cw'
  | 'Cf'
  | 'Ds'
  | 'Dw'
  | 'Df'
  | 'ET'
  | 'EF';

const KOPPEN_GROUP: ClimateGroup[] = [
  'none',
  'Af', 'Am', 'Aw',
  'BW', 'BW', 'BS', 'BS',
  'Cs', 'Cs', 'Cs',
  'Cw', 'Cw', 'Cw',
  'Cf', 'Cf', 'Cf',
  'Ds', 'Ds', 'Ds', 'Ds',
  'Dw', 'Dw', 'Dw', 'Dw',
  'Df', 'Df', 'Df', 'Df',
  'ET', 'EF',
];

let realClimate: { data: Uint8ClampedArray; width: number; height: number } | null = null;

export async function loadClimateData(url: string): Promise<void> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load climate data: ${url}`));
    img.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, image.width, image.height);
  realClimate = { data, width: image.width, height: image.height };
}

/**
 * The Köppen class at a direction, or 0 where the source map has no land.
 *
 * Nearest-sampled, never interpolated — these are category labels, and the
 * average of "rainforest" and "desert" is not a climate. The widening
 * search matters more than it looks: this globe's coastline comes from a
 * different dataset at a different resolution, so a strip of pixels along
 * every coast is land here and sea there. Without the search those would
 * all fall back to the no-data value and every shoreline on the planet
 * would get a ring of generic scrub. Looking outward for the nearest
 * classified pixel instead extends the neighbouring climate to the water's
 * edge, which is what it would do in reality anyway.
 */
export function climateClassAt(dir: THREE.Vector3): number {
  if (!realClimate) return 0;
  const { data, width, height } = realClimate;
  const theta = Math.acos(THREE.MathUtils.clamp(dir.y, -1, 1));
  let phi = Math.atan2(dir.z, -dir.x);
  if (phi < 0) phi += Math.PI * 2;
  const cx = Math.min(width - 1, Math.floor((phi / (Math.PI * 2)) * width));
  const cy = Math.min(height - 1, Math.floor((theta / Math.PI) * height));

  for (let r = 0; r <= 6; r++) {
    for (let dy = -r; dy <= r; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= height) continue;
      for (let dx = -r; dx <= r; dx++) {
        // only the ring at exactly this radius; the inside was searched already
        if (r > 0 && Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const x = ((cx + dx) % width + width) % width;
        const v = data[(y * width + x) * 4];
        if (v > 0 && v <= KOPPEN_CLASSES) return v;
      }
    }
  }
  return 0;
}

// Real climate, plus a little noise for texture. The noise is now doing
// the job it should always have had — breaking up an edge so a boundary
// isn't a drawn line — rather than deciding where the deserts are.
function rawAridityAt(dir: THREE.Vector3): number {
  const climate = climateClassAt(dir);
  const base = KOPPEN_ARIDITY[climate];
  const local = fbm3(dir.x * 2.6 + 51.3, dir.y * 2.6 + 51.3, dir.z * 2.6 + 51.3, 3);
  // Where the map is committed (true desert, true rainforest) the noise is
  // held back so the region reads as one unbroken thing; the middling
  // classes, where the real boundary genuinely is fuzzy, get more of it.
  const commitment = Math.abs(base - 0.5) * 2;
  return base + local * 0.22 * (1 - commitment);
}

let canopyGrid: Float32Array | null = null;

/**
 * How much closed forest belongs here, 0..1 — the real one, from the
 * climate map. Baked and bilinearly sampled (unlike the class index
 * itself) because this one *is* a continuous quantity: a forest thins out
 * toward its margin rather than stopping at a line.
 */
export function canopyAt(dir: THREE.Vector3): number {
  canopyGrid ??= bakeField(FIELD_W, FIELD_H, (d) => KOPPEN_CANOPY[climateClassAt(d)]);
  // Köppen says what the climate *could* grow. Open land is what is
  // actually there instead — see openLandAt.
  return sampleField(canopyGrid, dir) * (1 - 0.88 * openLandAt(dir));
}

// ---------------------------------------------------------------------
// Open land: grassland and cropland (G11, and the missing biome)
// ---------------------------------------------------------------------
// KOPPEN_CANOPY answers "what could grow here", and for most of the planet
// that is also what is there. Across the temperate middle latitudes it is
// not, and measuring the difference against real forest cover made the gap
// impossible to argue with:
//
//   region              canopy field   real forest cover
//   Corn Belt (IA/IL)      0.850             8%
//   Pampas (AR)            0.811             3%
//   European plain         0.900            30%
//   Appalachia             0.840            60%
//
// Iowa and the Appalachians carry the same field and differ by a factor of
// seven on the ground. The whole of North America came out inside a 1.6x
// spread where the real range is 15x, which is why the continent read as
// one even middling woodland — "trees everywhere, stone age".
//
// Two different things are missing, and they need two different signals.
//
// GRASSLAND is climate, and Köppen already carries it: BS is *steppe*,
// which is the word for grassland. The bug was not that the field was
// wrong but that grass was gated by `arid <= DESERT_ARIDITY_THRESHOLD`
// (0.52) while BSk is 0.58 and BSh is 0.64 — so every steppe on the
// planet sat on the desert side of one threshold and got no grass at all.
// The Eurasian steppe, the Sahel and the western Great Plains were being
// treated as Sahara. KOPPEN_GRASS below states openness directly instead
// of inferring it from a dryness cutoff, so steppe can be open ground
// without being sand.
//
// CROPLAND is not climate — it is history, and no raster here has it. But
// it has a geography that two existing fields do describe between them:
// people plough *flat* land, and they plough it where they *live*. Either
// signal alone is useless and measurement says so:
//
//   - flat alone clears the Amazon (relief 0.0032), the Congo (0.0036)
//     and the Siberian taiga (0.0040), which are the three flattest
//     forests on Earth;
//   - settled alone clears the Appalachians, whose habitability is 0.842
//     — higher than Iowa's 0.645, because the field counts the eastern
//     seaboard's cities. This is why the farmland thinning already in the
//     scatter could not work by being turned up: it was pulling hardest
//     on the one place that should not move.
//
// Their product separates all sixteen regions measured. Flat and settled:
// Corn Belt, Pampas, the European plain, Texas. Steep: Appalachia (0.0159),
// the Pacific NW (0.0440). Flat but empty: Amazon (habitability 0.160),
// Congo (0.188), Siberia (0.015), Scandinavia (0.000).
const KOPPEN_GRASS = [
  0.3, // 0: no data
  0.02, 0.05, 0.55, // Af Am Aw — savanna is grass with trees standing in it
  // Desert is not grassland. The steppe classes beside it are almost
  // nothing else, and this is the line the old aridity gate could not draw
  // because both sit on the same side of it.
  0.02, 0.06, 0.85, 0.85, // BWh BWk BSh BSk
  // Csa is genuinely open — Spain, inland California, the Anatolian
  // uplands are grass and scrub. Csb is not, and a first pass that lent it
  // 0.35 took the Pacific North-West down with it: Csb is the class of the
  // Douglas fir coast, the wettest temperate forest on the continent, and
  // it measured 0.409 open when almost none of it is.
  0.45, 0.14, 0.12, // Csa Csb Csc
  0.3, 0.25, 0.22, // Cwa Cwb Cwc
  // The humid temperate classes carry the eastern US, western Europe,
  // Japan and eastern China. What is open about them is *farmed*, not
  // climatic, so they state almost nothing here and let the cropland term
  // decide — otherwise every one of them is cleared everywhere at once,
  // including the parts nobody ever ploughed.
  0.16, 0.12, 0.14, // Cfa Cfb Cfc
  0.4, 0.22, 0.18, 0.18, // Dsa Dsb Dsc Dsd
  0.28, 0.2, 0.12, 0.14, // Dwa Dwb Dwc Dwd
  0.18, 0.14, 0.08, 0.1, // Dfa Dfb Dfc Dfd — the taiga is closed, not open
  0.25, 0.0, // ET EF
];

/**
 * How much the ground rises and falls within about 60 km.
 *
 * The *range* over a neighbourhood, not the gradient at a point: what
 * decides whether country can be plophed is whether there is a hill in it,
 * and a single derivative reads zero halfway up a uniform slope.
 */
const RELIEF_ARC = 0.0096; // radians ≈ 61 km
function localRelief(dir: THREE.Vector3): number {
  const t1 = new THREE.Vector3(0, 1, 0).cross(dir);
  if (t1.lengthSq() < 1e-8) t1.set(1, 0, 0);
  t1.normalize();
  const t2 = new THREE.Vector3().crossVectors(dir, t1).normalize();
  const probe = new THREE.Vector3();
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    probe
      .copy(dir)
      .addScaledVector(t1, Math.cos(a) * RELIEF_ARC)
      .addScaledVector(t2, Math.sin(a) * RELIEF_ARC)
      .normalize();
    const h = heightAt(probe);
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  return hi - lo;
}

let openLandGrid: Float32Array | null = null;

/**
 * How much of this ground is open — grass or field — rather than closed
 * forest, 0..1. Read by canopyAt, so every layer that thins itself against
 * the canopy picks it up without asking for it separately.
 */
export function openLandAt(dir: THREE.Vector3): number {
  openLandGrid ??= bakeField(FIELD_W, FIELD_H, (d) => {
    const h = heightAt(d);
    if (h <= SEA_LEVEL) return 0;
    const grass = KOPPEN_GRASS[climateClassAt(d)];
    // Flat, by the measured split: the ploughed plains come in under
    // 0.0065 and the forested uplands over 0.0159.
    const flat = 1 - smoothstep(localRelief(d), 0.004, 0.015);
    const settled = smoothstep(habitabilityAt(d, h), 0.25, 0.70);
    return Math.max(grass, flat * settled);
  });
  return sampleField(openLandGrid, dir);
}

/**
 * Which Köppen group is here, and whether its forest is conifer.
 *
 * The two travel together because `climateClassAt` is the most expensive
 * field read in this file — a nearest-pixel probe with a widening ring
 * search behind it — and the scatter wants both facts about every candidate
 * it keeps. Asking separately doubled the cost of the single most expensive
 * thing the scatter does.
 */
export function climateFactsAt(dir: THREE.Vector3): {
  group: ClimateGroup;
  coniferous: boolean;
} {
  const climate = climateClassAt(dir);
  return { group: KOPPEN_GROUP[climate], coniferous: KOPPEN_CONIFEROUS[climate] };
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

// Bilinear, not nearest: a coarse grid's cell boundaries used to be
// invisible because the old fbm3-noise terrain was busy/bumpy everywhere,
// masking the tiny discontinuity at each cell edge. Real elevation data
// gave huge stretches of genuinely flat, smooth lowland with nothing else
// competing for attention, and against that backdrop those hard cell edges
// showed up as a visible grid of lines once the (also newly sensitive)
// relief/wash paint picked up the tiny slope spike at every boundary.
function sampleGrid(
  grid: Float32Array,
  width: number,
  height: number,
  dir: THREE.Vector3,
): number {
  const theta = Math.acos(THREE.MathUtils.clamp(dir.y, -1, 1));
  let phi = Math.atan2(dir.z, -dir.x);
  if (phi < 0) phi += Math.PI * 2;
  const fx = (phi / (Math.PI * 2)) * width;
  const fy = (theta / Math.PI) * height;

  const x0 = Math.floor(fx);
  const y0 = THREE.MathUtils.clamp(Math.floor(fy), 0, height - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const x0w = ((x0 % width) + width) % width;
  const x1w = (x0w + 1) % width;
  const y1 = Math.min(y0 + 1, height - 1);

  const g00 = grid[y0 * width + x0w];
  const g10 = grid[y0 * width + x1w];
  const g01 = grid[y1 * width + x0w];
  const g11 = grid[y1 * width + x1w];
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(g00, g10, tx), THREE.MathUtils.lerp(g01, g11, tx), ty);
}

function sampleField(grid: Float32Array, dir: THREE.Vector3): number {
  return sampleGrid(grid, FIELD_W, FIELD_H, dir);
}

/**
 * Where a desert is a sand sea rather than gravel plain, 0..1.
 *
 * A desert is not a sand sea, and this globe's was: `BW` scattered dunes
 * at a flat 30% everywhere, every ridge the same 20 px and aligned to one
 * bearing field, all in one colour. Rendered, the Sahara came out looking
 * like **combed hair** — maximum detail, no information, and not
 * recognisable as desert. The Sahara is roughly a quarter erg; the rest is
 * reg and hamada, gravel and rock plain, with dark massifs standing out of
 * it. That internal contrast is what says "desert"; the dunes alone do not.
 *
 * Deliberately the lowest-frequency field in this file. An erg is hundreds
 * of kilometres across (the Grand Erg Oriental, the Rub' al Khali), so it
 * has to change slowly enough to survive as one shape at globe scale
 * rather than dissolving into patchiness. Read by both the paint and the
 * dune scatter, so the pale sand and the ridges standing on it are one
 * feature described once rather than two that can drift apart.
 */
export function ergAt(dir: THREE.Vector3): number {
  return (fbm3(dir.x * 2.1 + 913, dir.y * 2.1 + 913, dir.z * 2.1 + 913, 2) + 1) * 0.5;
}

let aridityGrid: Float32Array | null = null;
export function aridityAt(dir: THREE.Vector3): number {
  aridityGrid ??= bakeField(FIELD_W, FIELD_H, rawAridityAt);
  return sampleField(aridityGrid, dir);
}

/**
 * How much rain falls here over a year, 0..1 — where 1 is an everwet
 * equatorial rainforest and 0 is the core of a hyper-arid desert.
 *
 * This is deliberately a *table*, not a simulation. The second letter of a
 * Köppen class is itself a precipitation classification (f everwet, m
 * monsoon, w winter-dry, s summer-dry), so the information is already in
 * the raster the globe has been loading all along; it was simply never read
 * as rainfall. Values are eyeballed against real annual totals normalised
 * with 1.0 ≈ 3000 mm/yr, so the ordering — not the absolute number — is the
 * thing that has to be right.
 */
const KOPPEN_PRECIPITATION = [
  0.35, // 0: no data — only reached where the class map calls this sea
  1.00, 0.92, 0.58, // Af Am Aw — everwet, monsoon, savanna
  0.02, 0.05, 0.22, 0.25, // BWh BWk BSh BSk — the deserts, then the steppes
  0.34, 0.42, 0.44, // Csa Csb Csc — Mediterranean: a real wet season, a dry year
  0.62, 0.60, 0.54, // Cwa Cwb Cwc — monsoonal subtropics
  0.72, 0.68, 0.66, // Cfa Cfb Cfc — everwet temperate
  0.30, 0.33, 0.34, 0.28, // Dsa Dsb Dsc Dsd
  0.50, 0.48, 0.42, 0.34, // Dwa Dwb Dwc Dwd
  0.60, 0.58, 0.46, 0.38, // Dfa Dfb Dfc Dfd
  0.20, 0.06, // ET EF — cold and therefore dry; the ice sheet gets almost nothing
];

/**
 * How concentrated that rain is into part of the year, 0..1. An f class is
 * ~0 (it rains all year), a w or s class is high (Aw and Cs are *defined*
 * by when the rain falls, not by how much of it there is).
 */
const KOPPEN_PRECIP_SEASONALITY = [
  0.3, // 0: no data
  0.08, 0.55, 0.85, // Af Am Aw
  0.5, 0.5, 0.7, 0.6, // BWh BWk BSh BSk
  0.8, 0.75, 0.7, // Csa Csb Csc
  0.8, 0.78, 0.7, // Cwa Cwb Cwc
  0.15, 0.12, 0.15, // Cfa Cfb Cfc
  0.7, 0.68, 0.6, 0.6, // Dsa Dsb Dsc Dsd
  0.72, 0.7, 0.62, 0.6, // Dwa Dwb Dwc Dwd
  0.18, 0.15, 0.2, 0.25, // Dfa Dfb Dfc Dfd
  0.35, 0.3, // ET EF
];

/**
 * *When* it falls, −1..+1: +1 means the rain comes in the local summer
 * (monsoon, savanna wet season, continental thunderstorm season), −1 means
 * the local winter (Mediterranean, the marine west coasts' winter storm
 * track). "Local" is the point's own hemisphere — a consumer that knows the
 * calendar has to fold in the sign of `dir.y` itself, or use
 * `precipitationAtSeason` below, which does it.
 */
const KOPPEN_PRECIP_SUMMER_BIAS = [
  0, // 0: no data
  0, 0.8, 1.0, // Af Am Aw
  0.2, 0.1, 0.7, 0.2, // BWh BWk BSh BSk
  -1.0, -1.0, -1.0, // Csa Csb Csc — dry summer, by definition
  1.0, 1.0, 1.0, // Cwa Cwb Cwc — dry winter, by definition
  0.2, -0.4, -0.5, // Cfa Cfb Cfc — Cfb's rain leans to the winter storm track
  -0.9, -0.9, -0.8, -0.8, // Dsa Dsb Dsc Dsd
  1.0, 1.0, 0.9, 0.9, // Dwa Dwb Dwc Dwd
  0.4, 0.3, 0.4, 0.3, // Dfa Dfb Dfc Dfd — convective summer maximum inland
  0.3, 0.2, // ET EF
];

/**
 * What the class map cannot tell us: rainfall over the open ocean, where
 * there is no Köppen class at all and `climateClassAt` falls back to 0.
 *
 * Clouds and rain are the first consumers of this field and most of the
 * planet's surface is water, so a flat no-data value there would hand the
 * sky a uniform world. The zonal mean is the one piece of climatology that
 * survives having no map: the ITCZ is wet, the subtropical highs at ±25°
 * are the driest places on the planet including at sea, the mid-latitude
 * storm tracks are wet again, and the poles are dry.
 */
function zonalPrecipitation(y: number): number {
  const lat = Math.asin(THREE.MathUtils.clamp(y, -1, 1)) * (180 / Math.PI);
  const bell = (centre: number, width: number, amp: number): number =>
    amp * Math.exp(-Math.pow((lat - centre) / width, 2));
  return THREE.MathUtils.clamp(
    0.12 + bell(0, 11, 0.78) + bell(50, 17, 0.42) + bell(-50, 17, 0.42),
    0,
    1,
  );
}

function rawPrecipitationAt(dir: THREE.Vector3): number {
  const climate = climateClassAt(dir);
  // Over water, always the zonal profile. `climateClassAt` deliberately
  // reaches outward for the nearest classified pixel so that no coastline
  // falls back to no-data, which is right for paint but wrong here: out in
  // the Pacific it finds a speck of an island and paints its Af rainforest
  // rainfall across a whole grid cell of open sea, and the map came out
  // with cyan rectangles scattered over the tropics.
  const sea = sampledHeight(dir).raw < SEA_LEVEL;
  const base = sea || climate === 0
    ? zonalPrecipitation(dir.y)
    : KOPPEN_PRECIPITATION[climate];
  // Same treatment aridity gets, for the same reason: the raster is
  // 2048×1024 nearest-neighbour and its class edges read as rectangular
  // steps unless something breaks them up. Committed classes (true desert,
  // true rainforest) hold the noise back so the region stays one thing;
  // the middling classes, where the real boundary genuinely is a gradient,
  // take more of it.
  const local = fbm3(dir.x * 2.9 - 314.1, dir.y * 2.9 - 314.1, dir.z * 2.9 - 314.1, 3);
  const commitment = Math.abs(base - 0.5) * 2;
  return THREE.MathUtils.clamp(base + local * 0.24 * (1 - commitment), 0, 1);
}

let precipitationGrid: Float32Array | null = null;
let precipSeasonalityGrid: Float32Array | null = null;
let precipSummerBiasGrid: Float32Array | null = null;

/**
 * Annual precipitation at a direction, roughly 0..1.
 *
 * The single source every weather system is meant to hang off — clouds,
 * rain, snow, lightning and the river weights — instead of each one
 * inventing its own weather from its own basis, which is how a clear sky
 * came to snow and a rainless desert came to have rivers.
 *
 * Baked and bilinearly sampled like the canopy field: unlike the class
 * index, rainfall genuinely is continuous, and a rainforest fades toward
 * its margin rather than stopping at a line.
 */
export function precipitationAt(dir: THREE.Vector3): number {
  precipitationGrid ??= bakeField(FIELD_W, FIELD_H, rawPrecipitationAt);
  return sampleField(precipitationGrid, dir);
}

const ZONAL_BANDS = 181;
let zonalPrecipTable: Float32Array | null = null;

/**
 * Mean annual rainfall around a whole circle of latitude.
 *
 * The part of the rainfall map that survives being blown around the planet.
 * Anything carried by the wind — a cloud band, most obviously — spends its
 * life travelling in longitude, so *where* it was seeded says nothing about
 * where it will be a minute later; only its latitude is invariant. Placing
 * such a thing by `precipitationAt` bakes in an answer that decays (the
 * same trap the baked cloud bearings fell into, §2-17), while placing it by
 * this stays true for as long as it exists.
 *
 * The longitudinal half of the coupling is not lost, it just belongs on the
 * other side of the clock: read `precipitationAt`/`precipitationAtSeason`
 * live at wherever the thing has drifted to.
 */
export function zonalPrecipitationAt(y: number): number {
  if (!zonalPrecipTable) {
    zonalPrecipTable = new Float32Array(ZONAL_BANDS);
    const probe = new THREE.Vector3();
    const SAMPLES = 180;
    for (let b = 0; b < ZONAL_BANDS; b++) {
      const sinLat = (b / (ZONAL_BANDS - 1)) * 2 - 1;
      const c = Math.sqrt(Math.max(0, 1 - sinLat * sinLat));
      let sum = 0;
      for (let s = 0; s < SAMPLES; s++) {
        const lon = (s / SAMPLES) * Math.PI * 2;
        probe.set(c * Math.cos(lon), sinLat, c * Math.sin(lon));
        sum += precipitationAt(probe);
      }
      zonalPrecipTable[b] = sum / SAMPLES;
    }
  }
  // equal steps in sin(latitude), i.e. in area — the same parameterisation
  // the flake and cloud samplers draw from
  const f = (THREE.MathUtils.clamp(y, -1, 1) + 1) * 0.5 * (ZONAL_BANDS - 1);
  const i = Math.min(ZONAL_BANDS - 2, Math.floor(f));
  return THREE.MathUtils.lerp(zonalPrecipTable[i], zonalPrecipTable[i + 1], f - i);
}

/** Annual rainfall plus the shape of its year. See `precipitationAt`. */
export interface PrecipitationSample {
  /** Annual total, roughly 0..1. */
  amount: number;
  /** How concentrated into one part of the year, 0 (even) .. 1 (one season). */
  seasonality: number;
  /** −1 the wet season is local winter … +1 it is local summer. */
  summerBias: number;
}

/**
 * The full profile. A single scalar cannot carry Aw and Cs, whose entire
 * identity is *when* the rain falls rather than how much of it there is —
 * a savanna and a Mediterranean coast can have the same annual total and
 * opposite years — so the seasonal part is exposed here alongside it.
 */
export function precipitationProfileAt(dir: THREE.Vector3): PrecipitationSample {
  // Same sea rule as `rawPrecipitationAt`: an ocean cell takes the no-data
  // entry rather than the rainfall calendar of the nearest island.
  precipSeasonalityGrid ??= bakeField(FIELD_W, FIELD_H, (d) =>
    KOPPEN_PRECIP_SEASONALITY[sampledHeight(d).raw < SEA_LEVEL ? 0 : climateClassAt(d)]);
  precipSummerBiasGrid ??= bakeField(FIELD_W, FIELD_H, (d) =>
    KOPPEN_PRECIP_SUMMER_BIAS[sampledHeight(d).raw < SEA_LEVEL ? 0 : climateClassAt(d)]);
  return {
    amount: precipitationAt(dir),
    seasonality: sampleField(precipSeasonalityGrid, dir),
    summerBias: sampleField(precipSummerBiasGrid, dir),
  };
}

/**
 * Precipitation as it stands at one moment of the year.
 *
 * `northernSummer` runs −1 (northern midwinter) .. +1 (northern midsummer),
 * which is the form the season animation already thinks in; the hemisphere
 * flip is done here from `dir.y` so no consumer has to remember it. A
 * monsoon savanna swings hard between the two ends, an everwet rainforest
 * barely moves, and a Mediterranean coast runs exactly out of phase with
 * the savanna at the same latitude.
 */
export function precipitationAtSeason(dir: THREE.Vector3, northernSummer: number): number {
  const p = precipitationProfileAt(dir);
  const localSummer = dir.y >= 0 ? northernSummer : -northernSummer;
  // Seasonality only redistributes the year, it does not add water: at
  // seasonality 1 the wet half gets twice the mean and the dry half nothing.
  const swing = p.seasonality * p.summerBias * localSummer;
  return THREE.MathUtils.clamp(p.amount * (1 + swing), 0, 1);
}

// same threshold biomeColor uses to start blending toward desert — shared
// so vegetation placement (dunes/dry rock vs. grass/trees) agrees with
// what the paint underneath actually looks like
export const DESERT_ARIDITY_THRESHOLD = 0.52;

// "Canyon/badlands country" — dry, exposed sedimentary rock distinct from
// both a sand-dune desert and ordinary rocky mountains, like the American
// Southwest or the Grand Canyon. Reuses the terracing language already
// established elsewhere (a hand-cut layered model) but as color banding
// instead of geometric steps.
//
// This was the last purely fictional field left in the vegetation chain.
// The aridity and canopy fields were moved onto the real Köppen map and
// this one was missed, so a noise blob with no geography in it decided
// where bedrock showed through — which put banded grey-brown rock across
// the middle of the Amazon and the Congo and vetoed vegetation on a fifth
// of all land, the same class of bug the aridity move fixed.
//
// Now it is the dry classes (KOPPEN_BADLANDS) that say *whether* a region
// can have badlands at all, and noise only says *which parts of it* do.
// The mapping is written so the field crosses BADLANDS_THRESHOLD at
// roughly the top quarter of the noise inside a full-affinity desert, and
// only at the extreme tail inside the half-affinity dry-continental
// classes — badlands are a minority landform even where they belong, and
// carpeting the Sahara in mesas is as wrong as putting them in the Amazon.
let badlandsGrid: Float32Array | null = null;
function badlandsAt(dir: THREE.Vector3): number {
  badlandsGrid ??= bakeField(FIELD_W, FIELD_H, (d) => {
    const affinity = KOPPEN_BADLANDS[climateClassAt(d)];
    if (affinity <= 0) return 0;
    // Frequency raised from 0.9: at that scale one lobe of the field spans
    // most of a hemisphere, so a region the size of the Sahara sat entirely
    // inside a single peak or a single trough and came out either wholly
    // canyon or wholly not. Badlands vary at the scale of a basin, not a
    // continent.
    const shape = fbm3(d.x * 2.6 + 555, d.y * 2.6 + 555, d.z * 2.6 + 555, 3);
    return THREE.MathUtils.clamp(affinity * (BADLANDS_THRESHOLD + (shape - 0.14) * 2), 0, 1);
  });
  return sampleField(badlandsGrid, dir);
}
export const BADLANDS_THRESHOLD = 0.28;

// A dry lakebed forms in specific low, flat desert basins, not uniformly
// across every arid stretch — the same "committed regions, not speckle"
// logic aridity and badlands already use. A dedicated low-frequency field
// marks where the pan is, decorrelated from the aridity/badlands fields
// so its patches don't just retrace their existing shapes.
let saltPanGrid: Float32Array | null = null;
function saltPanAt(dir: THREE.Vector3): number {
  saltPanGrid ??= bakeField(FIELD_W, FIELD_H, (d) =>
    fbm3(d.x * 1.3 + 909, d.y * 1.3 + 909, d.z * 1.3 + 909, 2),
  );
  return sampleField(saltPanGrid, dir);
}
const SALT_PAN_THRESHOLD = 0.32;

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
// pushed up beyond its raw noise height for a toy-globe, exaggerated
// mountain look; since the ocean (~70% of the surface) stays perfectly
// flat regardless, this doesn't reintroduce the "potato" whole-sphere
// distortion from earlier — only the landmass gets dramatic. Halved from
// the original 2.0 once real-world elevation data made mountains read as
// too tall — this only scales land height above the coastline, so it
// doesn't touch ocean waves, ice shelves, or where the coast itself sits.
const LAND_BOOST = 1.0;
// a bigger drop than a purely cosmetic clamp needs — real relief globes
// have a visible carved "step" right at the coastline instead of land
// gently sloping into the water, and this is what makes that step read
const UNDERWATER_HEIGHT = SEA_LEVEL - 0.045;
// sits between the flattened underwater terrain and true sea level, so the
// glass ocean shell (built from this in main.ts) fully covers the seabed
// without z-fighting the coastline. Recessed further than the original
// -0.015 once real coastlines exposed the old margin: a huge amount of
// real-world low-lying land sits only barely above SEA_LEVEL (a real
// coastal plain, unlike the old fictional continents' coasts, is *actually*
// nearly flat), and with LAND_BOOST halved that land's displaced radius was
// landing at or below the ocean shell's own radius — visually flooding it.
export const GLASS_SEA_HEIGHT = SEA_LEVEL - 0.022;

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
  // Raised from 0.012: real low-lying coastal plains (deltas, floodplains —
  // there's a lot more of that terrain in the real data than the old
  // fictional coasts ever had) need a bit more guaranteed lift to clear the
  // ocean shell, especially with LAND_BOOST halved.
  const coastalStep = 0.028 + coastCliffiness(dir) * 0.15;
  let boost = orogenyBoost;

  // A volcano's summit is meant to read as one singular landmark, taller
  // than an ordinary range peak nearby — but the boost backs off inside
  // the crater itself (scaled by 1 - crater), or the bowl carved into the
  // raw height above would just get lifted back into a bump.
  const volcano = volcanoAt(dir);
  if (volcano) {
    const volcanoBoost = 1 + volcano.cone * (1 - volcano.crater) * 1.9;
    boost = Math.max(boost, volcanoBoost);
  }

  return SEA_LEVEL + coastalStep + terracedElevation(height) * LAND_BOOST * boost;
}

export function seaLevelRadius(radius: number, bumpHeight: number): number {
  return radius + GLASS_SEA_HEIGHT * bumpHeight;
}

const outColor = new THREE.Color();
const badlandsScratch = new THREE.Color();
const saltScratch = new THREE.Color();

// Nudges a direction by a fine noise before it is used to look up the
// climate-derived canopy density, so the class raster's axis-aligned
// staircase edges (§2-9) wander instead of being drawn straight. The offset
// is a couple of tenths of a degree — about a quarter of a cell of the
// 384x192 field `canopyAt` bakes onto — which is enough to dither a boundary
// and far too small to move a forest.
const canopyWarpScratch = new THREE.Vector3();
function canopyWarp(dir: THREE.Vector3): THREE.Vector3 {
  const a = fbm3(dir.x * 38 + 1301, dir.y * 38 + 1301, dir.z * 38 + 1301, 2);
  const b = fbm3(dir.x * 38 + 2609, dir.y * 38 + 2609, dir.z * 38 + 2609, 2);
  return canopyWarpScratch
    .set(dir.x + a * 0.02, dir.y + b * 0.02, dir.z + a * b * 0.02)
    .normalize();
}

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

// A salt pan's crust: mostly a pale, faintly pink crust with a network of
// dark cracked mud between the plates. The crack lines fall out for free
// from thresholding noise near its zero crossing — a coherent field is
// smooth almost everywhere and flips sign along thin connected seams,
// which is exactly what a real dried, cracked surface looks like.
function saltFlatColor(dir: THREE.Vector3): THREE.Color {
  const cracks = fbm3(dir.x * 130 + 4040, dir.y * 130 + 4040, dir.z * 130 + 4040, 2);
  const crackT = 1 - smoothstep(Math.abs(cracks), 0, 0.06);
  return saltScratch.copy(saltColor).lerp(saltCrackColor, crackT * 0.6);
}

// The one place in the model meant to look like it is actually emitting
// light rather than just reflecting it — a lava pool or flow gets a
// network of bright cracks through the cooled basalt, the same
// zero-crossing trick as the salt pan's mud cracks above but read as
// glowing seams instead of dark ones.
function applyLavaGlow(color: THREE.Color, strength: number, dir: THREE.Vector3): void {
  const cracks = fbm3(dir.x * 90 + 5050, dir.y * 90 + 5050, dir.z * 90 + 5050, 2);
  const glow = smoothstep(cracks, 0.15, 0.5) * strength;
  color.lerp(lavaGlowColor, glow * 0.7);
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
  /** how open this ground is — grass and field rather than wood, 0..1 */
  open: number,
  /** how much of a sand sea this is, if it is desert at all, 0..1 */
  erg: number,
  /** low-frequency mottle, so a painted biome is not a flat fill */
  mottle: number,
): THREE.Color {
  // polar ice caps: cold enough, and it's ice regardless of elevation or
  // aridity — Antarctica doesn't care if it would otherwise be a beach.
  // Graded rather than switched, so the cap has a ragged frozen margin
  // instead of a hard edge stamped across whatever biome it lands on.
  const iceAmount = 1 - smoothstep(temperature, ICE_TEMPERATURE, ICE_TEMPERATURE + 0.13);
  if (iceAmount > 0.995) {
    return outColor.copy(iceColor);
  }

  // 0.4 -> 0.58 was the single worst line in this file for "there is no
  // grassland". It reaches **full desert gravel exactly at BSk (0.58)**,
  // and BSh is 0.64 — so every steppe on the planet was painted as desert
  // pavement, and Csa (0.48, the Mediterranean) came out half-way there
  // too. Grassland could not be seen because the desert ramp had already
  // painted over it, whatever the grass layer did.
  //
  // This is the same threshold-catching-two-biomes trap the scatter fell
  // into with `arid <= 0.52`, one file over, and the fix is the same one:
  // put the ramp in the gap between the steppe classes and the true desert
  // classes. BS is 0.58-0.64 and stays out; BW is 0.90-0.97 and comes in.
  const desertAmount = smoothstep(aridity, 0.66, 0.86);
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
      // regardless of its actual (independent) aridity value. Narrowed
      // twice over once real elevation data landed: measuring an actual
      // real lowland region (the US Midwest/Great Lakes basin) put its
      // *typical* raw elevation above sea level at roughly 0.003, not the
      // single-digit-percent-of-TERRACE_MAX this was tuned against —
      // real low-relief land really does sit that close to the sea-level
      // boundary. 0.012 was still wide enough to paint most of it as sand.
      const t = elevation / 0.003;
      outColor.copy(shoreColor).lerp(landColor, Math.min(Math.max(t, 0), 1));
      // Climate belts on the ground itself, under whatever grows on it.
      //
      // The laterite is gated on dryness as well as on latitude. `tropical`
      // reads temperature, which here is latitude and nothing else, so on
      // its own it applied red soil in exact inverse proportion to rainfall:
      // full strength (0.65, enough to take the ground from green-dominant
      // to red-dominant) straight down the equator where the canopy is
      // closed, and nothing over the cerrado twenty degrees south. That put
      // the Amazon and the Congo basins under a muddy olive-brown while the
      // savanna next door stayed green — the wrong way round, and the last
      // place on the globe still being painted from latitude after the
      // Köppen map went in. Bare laterite is what open, seasonally-dry
      // tropical ground looks like, so the savanna and the Sahel margins
      // keep it and the rainforest does not.
      // Not in the desert. `tropical` is latitude, so at the Sahara's
      // latitude this applied full-strength red laterite under the sand —
      // and with the gravel pavement over it the whole desert came out
      // orange-red rather than sand-coloured. Laterite is what *wet*
      // seasonal tropics leave behind; the Sahara has none of it.
      outColor.lerp(
        tropicalSoilColor,
        tropical * 0.42 * smoothstep(aridity, 0.16, 0.34) * (1 - desertAmount),
      );
      outColor.lerp(taigaColor, boreal * 0.7);

      // GRASSLAND. The one biome with no colour of its own until now: open
      // country was painted the same green as closed forest, so the only
      // thing separating a prairie from a wood was the density of objects
      // standing on it — and at 1 px a tuft, that is nothing. `open` is
      // the same `openLandAt` the scatter thins its trees against, so the
      // ground goes pale exactly where the trees come off it and the two
      // cannot disagree.
      //
      // Not all the way to the grass colour even at open = 1: some soil
      // and some green have to stay, or the steppe reads as a painted
      // region rather than as ground. The mottle is what keeps it from
      // being a flat fill — a prairie has old burns, ploughed sections and
      // dry patches, and this is the cheapest version of that.
      const grassTone = outColor
        .clone()
        .copy(grasslandColor)
        .lerp(savannaGrassColor, tropical);
      outColor.lerp(grassTone, open * (0.72 + mottle * 0.16));

      // A sand sea has a pale, almost bleached core with a darker gravel
      // margin. Ramping straight to one sand colour gave a flat khaki
      // patch that read as discoloured grass rather than as desert.
      outColor.lerp(desertGravelColor, desertAmount);
      // DESERT INTERNAL CONTRAST. The pale sand is no longer the whole
      // desert: it is applied where `ergAt` says there is a sand sea, and
      // the gravel plain between the ergs keeps the darker pavement colour
      // it already had, with rock massifs darker again. A desert made
      // entirely of one pale sand had nothing in it for the eye to measure
      // against, which is why it read as a flat khaki blank whatever was
      // scattered on top.
      const sand = smoothstep(aridity, 0.78, 0.93);
      outColor.lerp(desertColor, sand * smoothstep(erg, 0.42, 0.62));
      outColor.lerp(
        desertRockColor,
        sand * (1 - smoothstep(erg, 0.3, 0.5)) * smoothstep(mottle, 0.1, 0.45),
      );
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
// Baking a fake AO crease directly into the paint fakes the same read, and
// it is the single most load-bearing piece of the "the land is a raised
// shell sitting on the sea, not a picture printed on it" argument. There is
// a real step there to justify it: `displayHeight` lifts land by
// `coastalStep` = 0.028 + cliffiness * 0.15 as it crosses the shoreline.
//
// This used to be gated on *height above sea level* — a narrow window from
// SEA_LEVEL to SEA_LEVEL + 0.006 — and measurement says that was barely
// doing anything at all. Over the whole planet the mean |AO| on land came
// out at 0.0040 against a possible 0.16, i.e. 2.5% of full strength; only
// 3.6% of land got even 0.02. Worse, it was landing in the wrong places in
// both directions at once. Of the land actually within three texels of a
// coastline — 10.2% of all land, the strip this effect exists for — only
// 16.5% received |AO| >= 0.08, because a cliff coast clears 0.006 of
// elevation in a single texel and so gets no crease at the exact place a
// crease is most obviously missing. Meanwhile the flat interiors sit *under*
// that threshold for thousands of kilometres (the Congo basin's mean height
// above sea level is 0.007), so the effect leaked inland as a dim wash.
// This is the same mistake §2-10 of the gap analysis records for the surf,
// found the same way and with the same fix: **the quantity is distance from
// the shoreline, not depth or height near it.** Height cannot express it —
// a delta is low a long way inland and a headland is high right at the edge.
//
// So it is measured off the chamfer distance field instead, in texels of the
// 1536-wide reference map like the surf widths are. Width and depth both
// scale with `coastCliffiness`, which is the same field driving the actual
// geometric step, so a rocky headland gets the tall step *and* the deep
// crease and a sandy shelf coast gets neither — the crease describes the
// relief that is really there rather than being applied at one strength to
// every shore. The along-shore noise term matters as much as the width does:
// a crease of even depth all the way round every landmass is a drawn outline,
// which is the decal read this model keeps having to fight off.
// The first attempt at the new formulation subtracted an HSL lightness
// offset, the way the old height-gated one did, and the flat map showed
// immediately why that was wrong quite apart from any question of taste:
// THREE.Color works in linear space, so subtracting a constant 0.24 of
// lightness from a coastal green whose linear luminance is about 0.15 does
// not darken it, it clamps it to black. Every landmass came back with a hard
// black keyline round it — the drawn-outline, decal-on-a-sphere read this
// model spends most of its effort avoiding, arrived at by accident.
//
// Occlusion scales the light that reaches a surface, it does not subtract a
// fixed quantity from it, so all three shading terms in this file multiply
// now. That is both the physically right operation and the one that cannot
// produce a keyline: a dark texel and a bright texel in the same crease lose
// the same *proportion*, so the crease reads as shading on a form instead of
// as ink along a boundary.
const COAST_SHADOW_TEXELS = 6.5;

/**
 * How much of the light is occluded at a land texel by the step it sits
 * behind, 0..1. `texels` is distance to the nearest water.
 */
function coastalAO(dir: THREE.Vector3, texels: number, cliffiness: number, scale: number): number {
  const reach = COAST_SHADOW_TEXELS * scale * 2.2;
  if (texels <= 0 || texels > reach) return 0;
  // Same frequency as the surf's along-shore term, so the two bands gather
  // and thin out over the same stretches of coast: where the water is
  // breaking hardest is also where the land above it stands highest.
  const along = fbm3(dir.x * 14 + 4242, dir.y * 14 + 4242, dir.z * 14 + 4242, 3);
  const width = COAST_SHADOW_TEXELS * scale * (0.4 + cliffiness * 0.9 + along * 0.8);
  if (texels > width) return 0;
  // Deepest hard against the water and gone by the inner edge. Not linear:
  // an occlusion crease has most of its darkness in the first fraction of
  // its width, and a linear ramp reads as a soft airbrushed band instead.
  const band = 1 - smoothstep(texels, width * 0.08, width);
  // Depth has to vary along the shore as much as width does. Varying only
  // the width still gives every coast the same maximum darkness and so still
  // reads as one continuous line, just a line that gets thinner in places.
  const depth = 0.07 + cliffiness * 0.2 + Math.max(along, 0) * 0.13;
  return band * depth;
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

  // Bilinear, not nearest — the same argument sampleField makes above, and
  // for once it is not about looks. The elevation raster's flattest ground
  // (the Amazon and Congo basins, the pampas, the west Siberian plain) sits
  // within one grayscale step of the calibrated land/sea boundary, so at
  // pixel level it dithers back and forth across it. Nearest-sampling that
  // hands every scatter candidate a coin flip on whether it is standing on
  // land: measured, it put 60% of the Amazon basin below sea level where
  // the underlying raster, read continuously, puts 37%. Interpolating
  // resolves the dither the way the eye does, into the flat, barely-above-
  // water plain it actually represents.
  const fx = (phi / (Math.PI * 2)) * field.width;
  const fy = (theta / Math.PI) * field.height;
  const x0 = Math.floor(fx);
  const y0 = THREE.MathUtils.clamp(Math.floor(fy), 0, field.height - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const x0w = ((x0 % field.width) + field.width) % field.width;
  const x1w = (x0w + 1) % field.width;
  const y1 = Math.min(y0 + 1, field.height - 1);
  const i00 = y0 * field.width + x0w;
  const i10 = y0 * field.width + x1w;
  const i01 = y1 * field.width + x0w;
  const i11 = y1 * field.width + x1w;
  const mix = (a: number, b: number, c: number, d: number) =>
    THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
  return {
    raw: mix(field.raw[i00], field.raw[i10], field.raw[i01], field.raw[i11]),
    display: mix(field.display[i00], field.display[i10], field.display[i01], field.display[i11]),
  };
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

function terrainColor(
  dir: THREE.Vector3,
  height: number,
  riverStrength: number,
  inlandTexels: number,
  texelScale: number,
): THREE.Color {
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

    // Coral reef: warm, shallow, tropical shelf only — real reefs are a
    // narrow band right off a warm coast, not the whole shelf, and they
    // grow in patches rather than as a uniform crust. Cheap checks first:
    // most of the sphere is deep, cold open ocean, and skipping straight
    // past those pixels avoids three extra noise lookups apiece over the
    // majority of the seabed pass.
    const reefShallow = smoothstep(h, SEA_LEVEL - 0.03, SEA_LEVEL - 0.006);
    if (reefShallow > 0) {
      const reefWarmth = smoothstep(temperature, 0.58, 0.78);
      if (reefWarmth > 0) {
        const reefPatch = fbm3(dir.x * 26 + 7070, dir.y * 26 + 7070, dir.z * 26 + 7070, 3);
        const reefGate = reefShallow * reefWarmth * smoothstep(reefPatch, 0.05, 0.35);
        if (reefGate > 0.01) {
          const paletteT = fbm3(dir.x * 60 + 8080, dir.y * 60 + 8080, dir.z * 60 + 8080, 2);
          const idx = Math.min(coralColors.length - 1, Math.floor(((paletteT + 1) / 2) * coralColors.length));
          color.lerp(coralColors[idx], reefGate * 0.55);
        }
      }
    }

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
    color = biomeColor(
      elevation,
      aridity,
      temperature,
      badlandsRaw,
      beltCloseness,
      openLandAt(dir),
      ergAt(dir),
      fbm3(dir.x * 17 + 2255, dir.y * 17 + 2255, dir.z * 17 + 2255, 3),
    );

    // River delta: right at the coast, a big river fans out into a wide
    // sediment plain instead of staying a single blue thread — the
    // braided-channel look of a real river mouth. Blended in before the
    // ordinary river line below, so the tan fan shows as a halo around
    // the (still blue) main channel rather than replacing it.
    const deltaCoast = 1 - smoothstep(elevation, 0, 0.05);
    if (riverStrength > 0.35 && deltaCoast > 0) {
      color.lerp(deltaColor, riverStrength * deltaCoast * 0.55);
    }
    if (riverStrength > 0) color.lerp(riverColor, riverStrength);

    // Salt lake: a dry, flat desert basin crusted white instead of
    // ordinary sand.
    if (aridity > 0.72 && elevation < 0.045) {
      const pan = saltPanAt(dir);
      if (pan > SALT_PAN_THRESHOLD) {
        color.lerp(saltFlatColor(dir), smoothstep(pan, SALT_PAN_THRESHOLD, SALT_PAN_THRESHOLD + 0.12));
      }
    }

    // Built-up ground. Land only — this whole branch is above the
    // waterline, so a coastal city cannot bleed out over its own harbour.
    // Kept under half way to the urban grey even at the very centre:
    // enough that Tokyo, the Nile delta and the US northeast are visibly
    // duller than the country around them, not enough to read as a drawn
    // patch.
    const urban = urbanAt(dir);
    if (urban > 0) color.lerp(urbanColor, urban * 0.45);

    // Ground shade under the canopy.
    //
    // The scatter puts thirty-odd thousand trees on this globe and the paint
    // underneath them never acknowledged any of them: the Amazon and the
    // savanna twenty degrees south were painted at the same value, so the
    // rainforest instances stood on ground exactly as bright as open country
    // and read as models placed *on* a picture rather than as a forest. That
    // is the "the land is floating above the sphere" tell, and the review put
    // it first — a closed canopy is the largest single area of the model that
    // ought to be in shadow and had none.
    //
    // Real shadow maps are off, so this is painted rather than cast, which
    // costs nothing per frame and nothing in draw calls: a forest floor is
    // occluded by its own crowns from every direction, so the darkening is
    // genuinely view- and light-independent and a baked texture is the right
    // place for it. It has to be baked, in fact — the globe spins, so
    // anything keyed to the light direction would have to live in the shader.
    //
    // `canopyAt` is the same field the scatter thins the forest by, which is
    // the whole point: the paint darkens exactly where the trees are dense
    // rather than approximating it from latitude. Measured over land it means
    // 22% of the surface at >= 0.7 and a mean of 0.31, so this is a broad
    // regional value change and not a local detail.
    //
    // Three things hold it back from becoming a flat green stain:
    //  - the mottle, at the same frequency as `clumpDensity`'s fine term, so
    //    the darker patches are the size of the clumps the scatter actually
    //    gathers into instead of an even wash;
    //  - the tree line, since `canopyAt` is climate only and does not know
    //    that this particular texel is bare alpine rock;
    //  - the city, since `urbanAt` has already felled the trees here (see the
    //    scatter's clearing gain) and shading ground that has no canopy left
    //    on it would put a dark halo round every forest-belt city.
    // A fourth thing had to be added after the first flat map came back: the
    // climate raster is a nearest-neighbour class index, so its boundaries
    // are axis-aligned staircases (§2-9 of the gap analysis records this as a
    // known cosmetic flaw), and a darkening keyed straight to it drew those
    // staircases at full contrast — south-east Asia came back as a set of
    // rectangles. Reducing the strength alone does not fix that, it only
    // makes the rectangles fainter. The lookup *direction* is warped by a
    // fine noise instead, so the forest edge wanders across a couple of grid
    // cells and the staircase stops being straight; warping the query rather
    // than blurring the answer keeps the margin crisp where it is genuinely
    // crisp. The mottle doubles as one of the two warp axes so this costs one
    // extra noise evaluation rather than three, on a loop that already runs
    // over two million texels.
    const canopy = canopyAt(canopyWarp(dir));
    if (canopy > 0.04) {
      const mottle = fbm3(dir.x * 16.5 + 907, dir.y * 16.5 + 907, dir.z * 16.5 + 907, 3);
      const shade =
        canopy * (1 - smoothstep(elevation, 0.13, 0.26)) * (1 - urban) * (0.78 + mottle * 0.55);
      color.multiplyScalar(1 - 0.3 * shade);
      // Shaded foliage is a deeper green, not a grey one, and a pure
      // multiply desaturates nothing — this leans the shaded ground very
      // slightly further into its own hue so the darker forest stays green.
      color.offsetHSL(0.004 * shade, 0.05 * shade, 0);
    }

    // Volcano: a crater's lava pool or lake overrides whatever the
    // elevation band said, and an active crater bleeds a glowing basalt
    // flow down its flank.
    const volcano = volcanoAt(dir);
    if (volcano) {
      if (volcano.crater > 0) {
        color.lerp(volcano.active ? basaltColor : craterLakeColor, smoothstep(volcano.crater, 0, 0.4));
        if (volcano.active) applyLavaGlow(color, volcano.crater, dir);
      } else if (volcano.active) {
        const flowNoise = fbm3(dir.x * 40 + 6060, dir.y * 40 + 6060, dir.z * 40 + 6060, 3);
        const flowGate =
          smoothstep(flowNoise, 0.1, 0.35) *
          smoothstep(volcano.cone, 0.06, 0.35) *
          (1 - smoothstep(volcano.cone, 0.55, 0.9));
        if (flowGate > 0.01) {
          color.lerp(basaltColor, flowGate * 0.7);
          applyLavaGlow(color, flowGate, dir);
        }
      }
    }

    // The crease wanders on the same jitter field as the painted coastline
    // and the surf, rather than tracing a mathematically clean offset curve
    // a fixed distance in from a line that is itself irregular.
    const crease = coastalAO(
      dir,
      inlandTexels + coastlineJitter(dir) * 220 * texelScale,
      coastCliffiness(dir),
      texelScale,
    );
    if (crease > 0) color.multiplyScalar(1 - crease);
  }

  return color.offsetHSL(0, 0, paintGrain(dir));
}

// ---------------------------------------------------------------------
// Coastal surf
// ---------------------------------------------------------------------
// Where the water shallows onto a shore it breaks, and the white band that
// leaves is the most recognisable thing about a coastline seen from any
// distance at all — the sea does not simply stop being blue at the paint
// boundary. Until now it did exactly that: land met water as a clean colour
// edge, which is what makes a globe read as printed rather than built.
//
// The band is found by distance to the shore, not by depth. Depth was the
// obvious first answer and it is wrong, and wrong in a way only the flat map
// showed: a shelf sea is shallow across its whole width, so gating on "the
// seabed is within 0.013 of SEA_LEVEL" whitened the entire North Sea, the
// Irish Sea, the Sunda shelf and half the Gulf of Thailand — thousands of
// kilometres of open water, not a coastline. A chamfer distance transform
// over the land mask gives the thing actually wanted: how far is the nearest
// beach, measured on the texture's own grid.
//
// The band is deliberately not an even outline. A uniform white rim reads as
// a decal stuck on the sphere, the failure mode this model keeps fighting.
// `coastCliffiness` says how hard the water is hitting — a rock coast inside
// a mountain belt throws spray the whole way along, a sandy shelf shore
// barely foams — and a mid-frequency noise field widens and narrows the band
// along its own length on top of that, so the surf gathers into stretches
// with quieter water between them.
//
// Widths are in texels of a 1536-wide map and are generous on purpose: this
// map is about two thousand across for a sphere filling half the frame, and
// anything a couple of texels wide never survives to the screen — the same
// argument the resin droplets below are sized by.
const SURF_TEXELS = 3.4;

/**
 * Distance from every texel on one side of the coastline to the nearest
 * texel on the other, in texels. Two-pass chamfer (1 orthogonal, √2
 * diagonal), wrapping at the seam.
 *
 * `side` says which half is being measured. 'sea' gives every ocean texel
 * its distance to the nearest shore — that is the surf band. 'land' gives
 * every land texel its distance to the nearest water, which is the only
 * honest way to draw the contact shadow at the foot of the coastal step:
 * the shadow belongs a fixed distance in from the water's edge, and the
 * height above sea level does not tell you that distance. Texels on the
 * other side of the line come back 0 either way, so the caller (which
 * already has the height) can tell "wrong side" from "right at the edge".
 */
function coastDistanceField(
  heights: Float32Array,
  width: number,
  height: number,
  side: 'sea' | 'land' = 'sea',
): Float32Array {
  const size = width * height;
  const dist = new Float32Array(size);
  const FAR = 1e9;
  const isSeed = side === 'sea' ? (h: number) => h >= SEA_LEVEL : (h: number) => h < SEA_LEVEL;
  for (let i = 0; i < size; i++) dist[i] = isSeed(heights[i]) ? 0 : FAR;
  const D = 1;
  const DD = Math.SQRT2;
  const at = (x: number, y: number) => dist[y * width + ((x % width) + width) % width];

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const i = py * width + px;
      if (dist[i] === 0) continue;
      let best = dist[i];
      if (py > 0) {
        best = Math.min(best, at(px, py - 1) + D, at(px - 1, py - 1) + DD, at(px + 1, py - 1) + DD);
      }
      best = Math.min(best, at(px - 1, py) + D);
      dist[i] = best;
    }
  }
  for (let py = height - 1; py >= 0; py--) {
    for (let px = width - 1; px >= 0; px--) {
      const i = py * width + px;
      if (dist[i] === 0) continue;
      let best = dist[i];
      if (py < height - 1) {
        best = Math.min(best, at(px, py + 1) + D, at(px - 1, py + 1) + DD, at(px + 1, py + 1) + DD);
      }
      best = Math.min(best, at(px + 1, py) + D);
      dist[i] = best;
    }
  }
  return dist;
}

/**
 * How much broken white water is on the sea here, 0..1.
 * `texels` is the distance to the nearest shore, `scale` the map's size
 * relative to the 1536-wide reference the widths are quoted in.
 */
function surfAt(dir: THREE.Vector3, texels: number, scale: number): number {
  if (texels <= 0 || texels > SURF_TEXELS * 2.6 * scale) return 0;
  const cliff = coastCliffiness(dir);
  // Along-shore variation. Frequency chosen so one lobe spans a few hundred
  // kilometres — the scale of a bay, not of a continent and not of speckle.
  const along = fbm3(dir.x * 14 + 4242, dir.y * 14 + 4242, dir.z * 14 + 4242, 3);
  const width = SURF_TEXELS * scale * (0.5 + cliff * 1.0 + along * 1.9);
  if (texels > width) return 0;
  // Strongest right against the shore, gone by the outer edge of the band.
  const band = 1 - smoothstep(texels, width * 0.15, width);
  const strength = 0.45 + cliff * 0.55 + along * 0.7;
  return THREE.MathUtils.clamp(band * strength, 0, 1);
}

// The other half of the contact crease, on the water side.
//
// `coastalAO` darkens the land just inside the shoreline; this darkens the
// resin just outside it. Between them they are what stands in for the one
// shadow this model most obviously lacks — the raised land shell dropping a
// shadow onto the sea shell it sits on. §2-14 of the gap analysis lists it
// as one of the two shadow surrogates still missing after the cloud shadows
// went in.
//
// It has to be an *occlusion*, not a cast shadow, and that is not a cosmetic
// preference: the globe spins inside a fixed key light, so anything with a
// light direction baked into it would swing round with the sphere and be
// wrong for most of the rotation. Water in the angle at the foot of a coast
// genuinely sees less of the sky than open ocean does regardless of where
// the sun is, so a direction-free darkening is both the cheap answer and the
// correct one.
//
// It goes on *under* the surf, which is the whole reason it reads rather
// than muddying: foam stays at full brightness and now sits on a darker
// collar instead of beside undifferentiated blue, so the white gains the
// contrast it was missing. The band is deliberately narrower than the surf's
// and driven by the same along-shore noise, because an even dark rim all the
// way round every landmass is the "decal stuck on the sphere" failure §2-10
// warns about — the thing to avoid is a *tidy* outline, not a dark one.
const SHORE_OCCLUSION_TEXELS = 5.0;

function shoreOcclusion(dir: THREE.Vector3, texels: number, scale: number): number {
  const reach = SHORE_OCCLUSION_TEXELS * scale * 2;
  if (texels <= 0 || texels > reach) return 0;
  const cliff = coastCliffiness(dir);
  const along = fbm3(dir.x * 14 + 4242, dir.y * 14 + 4242, dir.z * 14 + 4242, 3);
  const width = SHORE_OCCLUSION_TEXELS * scale * (0.45 + cliff * 0.8 + along * 0.7);
  if (texels > width) return 0;
  const band = 1 - smoothstep(texels, width * 0.1, width);
  // Multiplicative, and weaker than the land side: shallow water over pale
  // sand is one of the brightest things on the model and a heavy hand here
  // put a black ring round every island (see coastalAO).
  return band * (0.05 + cliff * 0.13 + Math.max(along, 0) * 0.08);
}

function oceanColor(dir: THREE.Vector3, height: number, surf: number, occlusion: number): THREE.Color {
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
  // Under the foam, over the ice: pack ice against a rocky coast sits in the
  // same angle and is shaded by it too.
  if (occlusion > 0) outColor.multiplyScalar(1 - occlusion);
  // Surf goes on last, over the ice too — a frozen shore still has a white
  // rim, it just stops being the interesting part.
  if (surf > 0) outColor.lerp(surfColor, surf * 0.92);
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
  // How far in from the water every land texel is — the contact crease at
  // the foot of the coastal step is drawn from this and not from height
  // above sea level, which cannot express it. See coastalAO.
  const inland = coastDistanceField(heights, width, height, 'land');
  const texelScale = width / 1536;

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      dirForPixel(px, py, width, height, dir);

      const h = heights[py * width + px];
      const riverStrength = h >= SEA_LEVEL ? sampleRiverFlow(river, dir) : 0;
      const c = terrainColor(dir, h, riverStrength, inland[py * width + px], texelScale);
      // the wash/drybrush passes go on over the finished base coat, exactly
      // as they do on the workbench — and only on land, since the sea is a
      // poured surface nobody drybrushes
      if (h >= SEA_LEVEL) {
        const ri = py * width + px;
        applyReliefPaint(c, relief.convexity[ri], relief.slope[ri], snowinessAt(dir, h));
        // Waterfall: a river crossing genuinely steep ground foams white
        // instead of stalling as a flat blue line drawn straight over a
        // cliff.
        if (riverStrength > 0.4 && relief.slope[ri] > 0.35) {
          const foam = smoothstep(relief.slope[ri], 0.35, 0.7) * smoothstep(riverStrength, 0.4, 0.7);
          c.lerp(foamColor, foam * 0.75);
        }
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

// ---------------------------------------------------------------------
// City lights
// ---------------------------------------------------------------------
// The night side of this globe was, until now, simply the unlit half of a
// painted ball. What makes the real thing unmistakable from orbit is that
// the dark half is not dark: it is threaded with light, and that light is
// *not* spread evenly — it hugs coastlines and river valleys, thins out
// over highland and desert, stops dead at the treeline, and knots into a
// few dozen very bright points where the actual big cities are.
//
// So this is built in two passes over one texture, which main.ts adds to
// the globe's emissive term gated by which side is facing the sun:
// a scattered glow wherever the existing climate fields say people could
// plausibly live, and named metropolises at their real coordinates on top.
export const MAJOR_CITIES: [number, number, number][] = [
  // latitude, longitude, relative size
  // --- 東アジア ---
  [35.68, 139.69, 1.0], // 東京
  [34.69, 135.5, 0.75], // 大阪
  [35.18, 136.91, 0.6], // 名古屋
  [33.59, 130.4, 0.45], // 福岡
  [43.06, 141.35, 0.4], // 札幌
  [38.27, 140.87, 0.35], // 仙台
  [37.57, 126.98, 0.85], // ソウル
  [35.18, 129.08, 0.5], // 釜山
  [39.02, 125.75, 0.35], // 平壌
  [39.9, 116.4, 0.95], // 北京
  [39.13, 117.2, 0.7], // 天津
  [31.23, 121.47, 1.0], // 上海
  [32.06, 118.8, 0.6], // 南京
  [30.27, 120.16, 0.6], // 杭州
  [30.59, 114.31, 0.7], // 武漢
  [29.56, 106.55, 0.8], // 重慶
  [30.57, 104.07, 0.75], // 成都
  [34.34, 108.94, 0.6], // 西安
  [34.75, 113.63, 0.55], // 鄭州
  [36.07, 120.38, 0.5], // 青島
  [41.8, 123.43, 0.55], // 瀋陽
  [45.8, 126.53, 0.5], // ハルビン
  [23.13, 113.26, 0.9], // 広州
  [22.54, 114.06, 0.85], // 深圳
  [22.32, 114.17, 0.7], // 香港
  [25.03, 121.57, 0.55], // 台北
  [25.04, 102.72, 0.4], // 昆明
  [43.83, 87.62, 0.3], // ウルムチ
  [29.65, 91.1, 0.25], // ラサ
  [47.89, 106.91, 0.3], // ウランバートル
  // --- 東南アジア ---
  [14.6, 120.98, 0.8], // マニラ
  [10.32, 123.89, 0.3], // セブ
  [-6.21, 106.85, 0.9], // ジャカルタ
  [-7.25, 112.75, 0.5], // スラバヤ
  [-6.91, 107.61, 0.45], // バンドン
  [3.59, 98.67, 0.35], // メダン
  [-5.15, 119.43, 0.3], // マカッサル
  [13.75, 100.5, 0.8], // バンコク
  [10.82, 106.63, 0.7], // ホーチミン
  [21.03, 105.85, 0.6], // ハノイ
  [1.35, 103.82, 0.6], // シンガポール
  [3.14, 101.69, 0.55], // クアラルンプール
  [16.87, 96.2, 0.5], // ヤンゴン
  [11.56, 104.93, 0.35], // プノンペン
  // --- 南アジア ---
  [28.61, 77.21, 1.0], // デリー
  [19.08, 72.88, 0.95], // ムンバイ
  [22.57, 88.36, 0.85], // コルカタ
  [13.08, 80.27, 0.7], // チェンナイ
  [12.97, 77.59, 0.75], // ベンガルール
  [17.38, 78.49, 0.7], // ハイデラバード
  [23.03, 72.58, 0.6], // アーメダバード
  [18.52, 73.86, 0.55], // プネー
  [21.17, 72.83, 0.45], // スーラト
  [26.91, 75.79, 0.45], // ジャイプル
  [26.85, 80.95, 0.45], // ラクナウ
  [25.59, 85.14, 0.4], // パトナ
  [21.15, 79.09, 0.4], // ナグプール
  [23.81, 90.41, 0.9], // ダッカ
  [22.36, 91.78, 0.5], // チッタゴン
  [24.86, 67.01, 0.9], // カラチ
  [31.55, 74.34, 0.8], // ラホール
  [33.68, 73.05, 0.4], // イスラマバード
  [34.53, 69.17, 0.45], // カブール
  [6.93, 79.86, 0.35], // コロンボ
  [27.72, 85.32, 0.35], // カトマンズ
  // --- 西・中央アジア ---
  [35.69, 51.39, 0.8], // テヘラン
  [36.3, 59.61, 0.45], // マシュハド
  [33.31, 44.37, 0.65], // バグダッド
  [24.71, 46.68, 0.55], // リヤド
  [21.49, 39.19, 0.45], // ジッダ
  [25.2, 55.27, 0.55], // ドバイ
  [41.01, 28.98, 0.8], // イスタンブール
  [39.93, 32.86, 0.5], // アンカラ
  [32.08, 34.78, 0.45], // テルアビブ
  [41.3, 69.24, 0.45], // タシケント
  [43.24, 76.89, 0.4], // アルマトイ
  [40.41, 49.87, 0.4], // バクー
  // --- ヨーロッパ ---
  [55.76, 37.62, 0.85], // モスクワ
  [59.94, 30.31, 0.55], // サンクトペテルブルク
  [56.84, 60.61, 0.4], // エカテリンブルク
  [55.03, 82.92, 0.4], // ノヴォシビルスク
  [43.12, 131.89, 0.3], // ウラジオストク
  [50.45, 30.52, 0.5], // キーウ
  [53.9, 27.57, 0.35], // ミンスク
  [52.23, 21.01, 0.45], // ワルシャワ
  [52.52, 13.4, 0.6], // ベルリン
  [53.55, 9.99, 0.45], // ハンブルク
  [51.4, 7.0, 0.6], // ルール
  [50.11, 8.68, 0.45], // フランクフルト
  [48.14, 11.58, 0.45], // ミュンヘン
  [48.21, 16.37, 0.45], // ウィーン
  [50.08, 14.44, 0.4], // プラハ
  [47.5, 19.04, 0.4], // ブダペスト
  [44.43, 26.1, 0.4], // ブカレスト
  [52.1, 4.6, 0.5], // ランドスタット
  [50.85, 4.35, 0.4], // ブリュッセル
  [48.86, 2.35, 0.85], // パリ
  [51.51, -0.13, 0.9], // ロンドン
  [53.48, -2.24, 0.5], // マンチェスター
  [53.35, -6.26, 0.3], // ダブリン
  [40.42, -3.7, 0.6], // マドリード
  [41.39, 2.17, 0.5], // バルセロナ
  [38.72, -9.14, 0.4], // リスボン
  [41.9, 12.5, 0.6], // ローマ
  [45.46, 9.19, 0.55], // ミラノ
  [40.85, 14.27, 0.4], // ナポリ
  [37.98, 23.73, 0.45], // アテネ
  [59.33, 18.07, 0.35], // ストックホルム
  [59.91, 10.75, 0.3], // オスロ
  [55.68, 12.57, 0.35], // コペンハーゲン
  [60.17, 24.94, 0.3], // ヘルシンキ
  // --- アフリカ ---
  [30.04, 31.24, 0.9], // カイロ
  [31.2, 29.92, 0.5], // アレクサンドリア
  [33.57, -7.59, 0.5], // カサブランカ
  [36.75, 3.06, 0.45], // アルジェ
  [36.81, 10.18, 0.35], // チュニス
  [6.52, 3.38, 0.85], // ラゴス
  [12.0, 8.52, 0.4], // カノ
  [5.36, -4.01, 0.5], // アビジャン
  [5.6, -0.19, 0.45], // アクラ
  [14.72, -17.47, 0.4], // ダカール
  [-4.32, 15.31, 0.8], // キンシャサ
  [-8.84, 13.23, 0.5], // ルアンダ
  [-1.29, 36.82, 0.55], // ナイロビ
  [9.03, 38.74, 0.55], // アディスアベバ
  [-6.79, 39.21, 0.5], // ダルエスサラーム
  [15.5, 32.56, 0.5], // ハルツーム
  [0.35, 32.58, 0.4], // カンパラ
  [-17.83, 31.05, 0.3], // ハラレ
  [-18.88, 47.51, 0.35], // アンタナナリボ
  [-26.2, 28.05, 0.6], // ヨハネスブルグ
  [-33.92, 18.42, 0.45], // ケープタウン
  [-29.86, 31.02, 0.35], // ダーバン
  // --- 北アメリカ ---
  [40.71, -74.01, 1.0], // ニューヨーク
  [39.95, -75.17, 0.5], // フィラデルフィア
  [38.9, -77.04, 0.55], // ワシントン
  [42.36, -71.06, 0.5], // ボストン
  [43.65, -79.38, 0.6], // トロント
  [45.5, -73.57, 0.45], // モントリオール
  [49.28, -123.12, 0.4], // バンクーバー
  [51.05, -114.07, 0.3], // カルガリー
  [41.88, -87.63, 0.7], // シカゴ
  [42.33, -83.05, 0.45], // デトロイト
  [33.75, -84.39, 0.5], // アトランタ
  [25.77, -80.19, 0.5], // マイアミ
  [29.76, -95.37, 0.55], // ヒューストン
  [32.78, -96.8, 0.55], // ダラス
  [39.74, -104.99, 0.4], // デンバー
  [33.45, -112.07, 0.45], // フェニックス
  [47.61, -122.33, 0.45], // シアトル
  [37.77, -122.42, 0.55], // サンフランシスコ
  [34.05, -118.24, 0.9], // ロサンゼルス
  [19.43, -99.13, 0.95], // メキシコシティ
  [20.67, -103.35, 0.5], // グアダラハラ
  [25.67, -100.32, 0.45], // モンテレイ
  [23.11, -82.37, 0.4], // ハバナ
  [14.63, -90.51, 0.4], // グアテマラシティ
  [18.49, -69.93, 0.35], // サントドミンゴ
  [8.98, -79.52, 0.35], // パナマシティ
  // --- 南アメリカ ---
  [-23.55, -46.63, 0.95], // サンパウロ
  [-22.91, -43.17, 0.8], // リオデジャネイロ
  [-19.92, -43.94, 0.5], // ベロオリゾンテ
  [-15.79, -47.88, 0.45], // ブラジリア
  [-12.97, -38.5, 0.45], // サルバドール
  [-3.73, -38.52, 0.4], // フォルタレザ
  [-8.05, -34.88, 0.4], // レシフェ
  [-30.03, -51.23, 0.4], // ポルトアレグレ
  [-3.12, -60.02, 0.35], // マナウス
  [-34.6, -58.38, 0.8], // ブエノスアイレス
  [-31.42, -64.18, 0.35], // コルドバ
  [-34.9, -56.16, 0.35], // モンテビデオ
  [-25.28, -57.64, 0.3], // アスンシオン
  [-33.45, -70.67, 0.6], // サンティアゴ
  [-12.05, -77.04, 0.65], // リマ
  [4.71, -74.07, 0.7], // ボゴタ
  [6.24, -75.58, 0.4], // メデジン
  [10.49, -66.9, 0.5], // カラカス
  [-0.18, -78.47, 0.4], // キト
  [-2.19, -79.88, 0.35], // グアヤキル
  [-16.5, -68.15, 0.35], // ラパス
  // --- オセアニア ---
  [-33.87, 151.21, 0.6], // シドニー
  [-37.81, 144.96, 0.55], // メルボルン
  [-27.47, 153.03, 0.4], // ブリスベン
  [-31.95, 115.86, 0.35], // パース
  [-34.93, 138.6, 0.3], // アデレード
  [-36.85, 174.76, 0.35], // オークランド
];

// Conurbation corridors.
//
// A night earth does not read as dots. What the eye actually recognises are
// *areas and lines* — Europe as one glow, the Nile as a single thread, the
// Tokaido belt, the US northeast. A list of isolated points, however long,
// cannot produce any of those: between two cities 300km apart there is a
// gap of black, and the shape people know is exactly the thing filling that
// gap. So a handful of great-circle segments, each a couple of lines of
// data, that both the paint and the lights sample along.
//
// Routed against the elevation raster, not against an atlas: a corridor is
// gated to land by the same water test the paint uses, so a line drawn
// through ground the raster reads as below sea level simply does not paint.
// Measured at 21 points per segment, every one of these is dry end to end
// except the Yangtze delta — the raster has that floodplain (and the whole
// Pearl and Nile delta proper) at under SEA_LEVEL, which is why the Pearl
// runs up the east bank through Shenzhen and Dongguan and the Nile forks
// inland at Tanta rather than going to Alexandria. Shanghai-Nanjing is kept
// on its true line and accepts that only its ends carry day paint.
//
// lat1, lon1, lat2, lon2, half-width in radians of arc, intensity
const CONURBATIONS: [number, number, number, number, number, number][] = [
  [35.68, 139.69, 34.69, 135.5, 0.011, 0.72], // 東海道（東京〜名古屋〜大阪）
  [34.69, 135.5, 33.59, 130.4, 0.009, 0.5], // 山陽（大阪〜福岡）
  [38.9, -77.04, 42.36, -71.06, 0.011, 0.75], // 米北東回廊（ワシントン〜ボストン）
  [51.4, 7.0, 52.1, 5.4, 0.012, 0.7], // ライン・ルール〜ランドスタット
  [50.11, 8.68, 51.4, 7.0, 0.01, 0.6], // ライン中流（フランクフルト〜ルール）
  [51.51, -0.13, 53.48, -2.24, 0.01, 0.55], // イングランド中軸
  [28.61, 77.21, 22.57, 88.36, 0.012, 0.65], // ガンジス平原（デリー〜コルカタ）
  [30.04, 31.24, 24.09, 32.9, 0.007, 0.6], // ナイル本流（カイロ〜アスワン）
  [30.04, 31.24, 30.5, 30.6, 0.008, 0.65], // ナイルデルタ西岐（カイロ〜タンタ）
  [30.04, 31.24, 30.6, 31.4, 0.007, 0.55], // ナイルデルタ東岐
  [31.23, 121.47, 32.06, 118.8, 0.01, 0.7], // 長江デルタ（上海〜南京）
  [22.32, 114.17, 22.65, 114.1, 0.009, 0.7], // 香港〜深圳
  [22.54, 114.06, 23.0, 113.6, 0.01, 0.72], // 珠江デルタ（深圳〜東莞〜広州）
  [24.86, 67.01, 31.55, 74.34, 0.009, 0.5], // インダス回廊（カラチ〜ラホール）
  [-6.91, 107.61, -7.5, 110.4, 0.008, 0.5], // ジャワ北岸 西
  [-7.5, 110.4, -7.4, 112.2, 0.008, 0.5], // ジャワ北岸 東
  [-23.55, -46.63, -22.91, -43.17, 0.009, 0.55], // サンパウロ〜リオ
];

// The same 28 cities, in daylight.
//
// MAJOR_CITIES used to be read by the night-lights pass and by nothing
// else, so every city on the planet existed only after dark: the day side
// was uninterrupted wilderness and the light came on over ground that had
// nothing there a moment earlier. A built-up area is visible from orbit at
// noon too — not as roads, which is a map's answer, but as a dulled,
// desaturated patch where the green has been rubbed off.
//
// That is also the right answer for a painted miniature: grey-tan drybrush
// worked into the flock, not a symbol. So this is a soft smudge, edge
// broken up by noise, and it never gets strong enough to read as a shape
// with a boundary.
const urbanColor = new THREE.Color('#8b8778');

interface UrbanFeature {
  /** patch centre, or the first endpoint of a corridor */
  a: THREE.Vector3;
  /** second endpoint, null for a point city */
  b: THREE.Vector3 | null;
  /** great-circle normal of a corridor, null for a point city */
  n: THREE.Vector3 | null;
  /** cos of the arc between the endpoints — the in-segment test */
  cosSpan: number;
  radius: number;
  /** peak field value at the centre line */
  peak: number;
}

// In radians of arc. Tokyo, the largest, comes out at about 0.025 — six
// texels of the 1536-wide paint, still above the smallest thing that
// reliably survives to the screen, and a good deal wider than the real
// conurbation. A souvenir globe exaggerates its landmarks.
//
// This was cut to 0.0085 + size*0.0135 when the list went from 28 cities to
// 186, to hold the *area* where it had been. Correct arithmetic, wrong
// target: measured at the shipped camera, that made Tokyo 7 pixels across
// and Cairo the same, on a globe that fills about 500. A city that small is
// not a place, it is a speck of grey — and with the tree line running over
// it there was nothing to see at all. Legibility, not census accuracy, is
// what the patch radius is for on a hand-sized model; the size term is what
// keeps Tokyo bigger than Perth, and the absolute scale is set by what can
// be seen.
// Widened again, and this time because the *buildings* measured too small
// rather than the paint. 0.015 + size*0.023 makes a patch 9-16 px across at
// the shipped camera, and a broadleaf crown on this globe is 7 px: a city
// was one to two tree-widths wide, which is smaller than a single tree
// standing in it. Nothing standing on ground that size can read as a town
// no matter how it is built or tinted, so the ground had to grow first —
// this is 22-33 px, three to five crowns, which is the least that leaves
// room for a street grid inside it (landmarks.ts).
//
// Exported because landmarks.ts builds on exactly this disc. Two
// expressions of "how big is Tokyo" is how the paint and the buildings
// would come to disagree, and this file has been bitten by that before
// (the snow line and the snow flecks).
export const cityPatchRadius = (size: number): number => 0.022 + size * 0.034;

const cityPatch = (lat: number, lon: number, size: number): UrbanFeature => ({
  a: latLonToDir(lat, lon),
  b: null,
  n: null,
  cosSpan: 1,
  radius: cityPatchRadius(size),
  peak: 0.55 + size * 0.45,
});

const URBAN_FEATURES: UrbanFeature[] = MAJOR_CITIES.map(([lat, lon, size]) =>
  cityPatch(lat, lon, size),
);
for (const [lat1, lon1, lat2, lon2, width, intensity] of CONURBATIONS) {
  const a = latLonToDir(lat1, lon1);
  const b = latLonToDir(lat2, lon2);
  URBAN_FEATURES.push({
    a,
    b,
    n: new THREE.Vector3().crossVectors(a, b).normalize(),
    cosSpan: a.dot(b),
    radius: width,
    peak: intensity,
  });
}

// A flat loop over 28 dot products was free. A flat loop over ~190 features
// is not, at 900k vegetation candidates plus every texel of two textures, so
// the features are bucketed into a coarse lat/lon grid once and a query
// touches only the handful that can possibly reach its own cell. Baking the
// field onto a grid instead was the other option and is wrong here: the
// patches are 0.02 rad across and the existing FIELD_W=384 cell is 0.016,
// so a bake would smear every city into its neighbourhood and lose the
// ragged edge entirely.
const URBAN_BUCKET_LAT = 36;
const URBAN_BUCKET_LON = 72;
const buildUrbanBuckets = (): Int32Array[] => {
  const lists: number[][] = Array.from(
    { length: URBAN_BUCKET_LAT * URBAN_BUCKET_LON },
    () => [],
  );
  const dir = new THREE.Vector3();
  // A 5-degree cell is 0.087 rad across, an order of magnitude wider than
  // any patch, so testing the cell centre with a generous slack is exact
  // enough: half the cell diagonal plus the feature's own reach.
  const cellSlack = 0.087 * Math.SQRT2 * 0.5 + 1e-3;
  for (let iy = 0; iy < URBAN_BUCKET_LAT; iy++) {
    const lat = 90 - (iy + 0.5) * (180 / URBAN_BUCKET_LAT);
    for (let ix = 0; ix < URBAN_BUCKET_LON; ix++) {
      const lon = -180 + (ix + 0.5) * (360 / URBAN_BUCKET_LON);
      dir.copy(latLonToDir(lat, lon));
      const bucket = lists[iy * URBAN_BUCKET_LON + ix];
      for (let i = 0; i < URBAN_FEATURES.length; i++) {
        const f = URBAN_FEATURES[i];
        if (urbanDistance(dir, f) < f.radius + cellSlack) bucket.push(i);
      }
    }
  }
  return lists.map((l) => Int32Array.from(l));
};

const URBAN_BUCKETS = buildUrbanBuckets();

/** Angular distance from `dir` to a feature's centre point or centre line. */
function urbanDistance(dir: THREE.Vector3, f: UrbanFeature): number {
  if (!f.b || !f.n) return dir.angleTo(f.a);
  // Inside the span, the distance to the great circle is asin of the
  // component along its normal; outside it, the nearer endpoint. The span
  // test compares the projected point's dots against the endpoints with the
  // endpoints' own dot, which is the standard spherical "between" test.
  const along = dir.dot(f.n);
  const px = dir.x - f.n.x * along;
  const py = dir.y - f.n.y * along;
  const pz = dir.z - f.n.z * along;
  const len = Math.hypot(px, py, pz);
  if (len > 1e-9) {
    const inv = 1 / len;
    const da = (px * f.a.x + py * f.a.y + pz * f.a.z) * inv;
    const db = (px * f.b.x + py * f.b.y + pz * f.b.z) * inv;
    if (da >= f.cosSpan && db >= f.cosSpan) {
      return Math.asin(THREE.MathUtils.clamp(Math.abs(along), 0, 1));
    }
  }
  return Math.min(dir.angleTo(f.a), dir.angleTo(f.b));
}

function bucketIndex(dir: THREE.Vector3): number {
  const theta = Math.acos(THREE.MathUtils.clamp(dir.y, -1, 1));
  let phi = Math.atan2(dir.z, -dir.x);
  if (phi < 0) phi += Math.PI * 2;
  const iy = Math.min(URBAN_BUCKET_LAT - 1, Math.floor((theta / Math.PI) * URBAN_BUCKET_LAT));
  const ix = Math.min(
    URBAN_BUCKET_LON - 1,
    Math.floor((phi / (Math.PI * 2)) * URBAN_BUCKET_LON),
  );
  return iy * URBAN_BUCKET_LON + ix;
}

function urbanBucketFor(dir: THREE.Vector3): Int32Array {
  return URBAN_BUCKETS[bucketIndex(dir)];
}

/**
 * How built-up this point is: 0 anywhere away from a city and over water,
 * rising smoothly to ~1 at a large city's centre.
 *
 * Exported because two things need it and they must not disagree: the paint
 * below, and the vegetation scatter, which has to stop flocking trees where
 * the city is — a grey smudge laid over ground that is still fully forested
 * reads as a decal on the greenery rather than as cleared land. Two systems
 * computing "where the cities are" from two different expressions is exactly
 * how the snow line and the snow flecks ended up disagreeing.
 *
 * Cheap enough for the scatter's 900k candidates: one bucket lookup, then a
 * few distance tests, and the noise lookup only for the handful of points
 * that are actually inside a patch. The vast majority of the sphere lands in
 * an empty bucket and returns on the first line.
 */
export function urbanAt(dir: THREE.Vector3): number {
  const bucket = urbanBucketFor(dir);
  if (bucket.length === 0) return 0;
  let best = 0;
  for (let i = 0; i < bucket.length; i++) {
    const f = URBAN_FEATURES[bucket[i]];
    const dist = urbanDistance(dir, f);
    if (dist >= f.radius) continue;
    // Dense core, ragged suburbs: the falloff is steep near the middle and
    // long in the tail, which is what a conurbation actually looks like from
    // altitude and also stops the patch having a visible rim.
    const t = Math.pow(1 - dist / f.radius, 1.9) * f.peak;
    if (t > best) best = t;
  }
  if (best <= 0) return 0;
  // Never over water. A harbour city painted onto its own bay would put grey
  // in the resin, and the vegetation side wants the same answer.
  if (sampledHeight(dir).raw < SEA_LEVEL) return 0;
  // Break the disc. Without this every city is a perfect circle, which is
  // the sticker read again — a city grows along its valleys and its
  // coastline, so its outline is torn.
  const ragged = fbm3(dir.x * 70 + 1212, dir.y * 70 + 1212, dir.z * 70 + 1212, 2);
  return THREE.MathUtils.clamp(best * (1 + ragged * 1.6), 0, 1);
}


function drawGlow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  alpha: number,
): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
  // sodium-lamp amber in the core falling off through white to nothing —
  // a flat white dot reads as a star, not as a city
  g.addColorStop(0, `rgba(255, 244, 214, ${alpha})`);
  g.addColorStop(0.35, `rgba(255, 206, 128, ${alpha * 0.55})`);
  g.addColorStop(1, 'rgba(255, 170, 80, 0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

// How thickly the country around a point is settled, at the scale of a
// region rather than of a town: the same URBAN_FEATURES table the paint and
// the vegetation cull already read, blurred out to a few hundred kilometres.
//
// This is what tells the scatter that the Ganges plain, the North China
// plain, the Rhine and the Nile are full of people while the Amazon and
// central Siberia are not. The climate table above says which climates are
// habitable; this says which of them humanity actually filled. Deliberately
// the *same* source as the city dots, because two systems computing "where
// the people are" from two different expressions is precisely how the snow
// line and the snow flecks came to disagree.
//
// Baked coarse (192×96, a 1.9° cell) on purpose. The urban buckets cannot
// serve this — they are built for a 0.02 rad patch and reject anything
// further away — and at this scale smearing is the point, so the objection
// that killed a bake for `urbanAt` does not apply.
const SETTLEMENT_W = 192;
const SETTLEMENT_H = 96;
// ~0.13 rad ≈ 800 km: wide enough that the Ganges corridor and the North
// China plain merge into single lit regions, narrow enough that Manaus
// stays a dot in the dark rather than lighting the whole Amazon.
const SETTLEMENT_REACH = 0.13;
let settlementHaloGrid: Float32Array | null = null;

function settlementHaloAt(dir: THREE.Vector3): number {
  settlementHaloGrid ??= bakeField(SETTLEMENT_W, SETTLEMENT_H, (d) => {
    // Combined as independent probabilities rather than a max, so a dense
    // cluster of medium cities (the Rhine–Ruhr, the Kansai) reads brighter
    // than one isolated large one, which is the actual difference between
    // Europe and, say, Buenos Aires.
    let miss = 1;
    for (const f of URBAN_FEATURES) {
      const dist = urbanDistance(d, f);
      const reach = SETTLEMENT_REACH + f.radius * 2;
      if (dist > reach * 2.2) continue;
      const w = f.peak * Math.exp(-Math.pow(dist / reach, 2));
      miss *= 1 - THREE.MathUtils.clamp(w, 0, 0.97);
    }
    return 1 - miss;
  });
  return sampleGrid(settlementHaloGrid, SETTLEMENT_W, SETTLEMENT_H, dir);
}

let settlementClimateGrid: Float32Array | null = null;

/**
 * How plausible it is that anyone lives at this point, 0..1.
 *
 * Exported because the vegetation scatter thins the forest by it (see
 * species.ts): people do not only build cities, they clear the country
 * around them, and this — climate, elevation, and a halo round the city
 * list — is already this project's one answer to "is this settled land".
 * Inventing a second one for the trees is the split this codebase keeps
 * having to undo.
 */
export function habitabilityAt(dir: THREE.Vector3, height: number): number {
  if (height < SEA_LEVEL) return 0;
  const temperature = temperatureAt(dir, height);
  if (temperature < 0.02) return 0; // nobody lights up the ice caps
  // High country is thin country — the Tibetan plateau, the altiplano and
  // the high Andes are dark on every night image.
  const elevationPenalty = smoothstep(height - SEA_LEVEL, 0.05, 0.22);
  // Which climates people fill, and which of those they actually filled.
  // Warmth used to stand in for both, which is why the wettest, hottest,
  // emptiest places on the planet were the brightest ones here.
  settlementClimateGrid ??= bakeField(FIELD_W, FIELD_H, (d) => KOPPEN_SETTLEMENT[climateClassAt(d)]);
  const climate = sampleField(settlementClimateGrid, dir);
  const halo = settlementHaloAt(dir);
  // Population is clustered, not uniform: a low-frequency field breaks the
  // scatter into towns and empty country instead of an even dusting, but it
  // only modulates now — it is texture on top of geography, not geography.
  const settled = 0.3 + 0.7 * smoothstep(clumpDensity(dir, 8123, 2.2), 0.3, 0.62);
  // The floor on the halo keeps genuinely remote settlement alive (the
  // Siberian rail towns, the Australian coast) instead of making the world
  // outside the city table perfectly black.
  return climate * (0.14 + 0.86 * halo) * (1 - elevationPenalty) * settled;
}


export function buildCityLightsTexture(width = 1024, height = 512): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);
  // lights add to each other where towns run together into one conurbation
  ctx.globalCompositeOperation = 'lighter';

  const rand = mulberry32(60607);
  const dir = new THREE.Vector3();

  const attempts = width * height * 0.12;
  for (let i = 0; i < attempts; i++) {
    // area-preserving: uniform in longitude and in sin(latitude), so the
    // scatter is not piled up at the poles the way uniform-in-pixel is
    const u = rand();
    const v = Math.acos(1 - 2 * rand()) / Math.PI;
    dirForPixel(u * width, v * height, width, height, dir);
    const h = sampledHeight(dir).raw;
    const score = habitabilityAt(dir, h);
    if (score <= 0 || rand() > score * score) continue;
    drawGlow(ctx, u * width, v * height, 0.9 + rand() * 2.0, 0.05 + score * 0.17);
  }

  // Both consumers read the same table. The paint samples URBAN_FEATURES as
  // a field; this pass walks the same features and lays glows along them, so
  // a city that is grey at noon is lit at midnight and a corridor cannot
  // exist in one and not the other.
  const scale = width / 1024;
  const lit = (d: THREE.Vector3, size: number, gain: number): void => {
    let phi = Math.atan2(d.z, -d.x);
    if (phi < 0) phi += Math.PI * 2;
    const x = (phi / (Math.PI * 2)) * width;
    const y = (Math.acos(THREE.MathUtils.clamp(d.y, -1, 1)) / Math.PI) * height;
    // The sprawl around the core, then the core itself — both a good deal
    // tighter than they started. A metropolis drawn as a wide soft disc
    // reads as a glowing ball hovering over the country rather than as a
    // city: what makes it a city is that it is *small and very bright*,
    // with a faint halo, not big and bright.
    drawGlow(ctx, x, y, (2.6 + size * 4.5) * scale, 0.22 * size * gain);
    drawGlow(ctx, x, y, (0.9 + size * 1.4) * scale, 0.8 * size * gain);
  };

  const step = new THREE.Vector3();
  for (const f of URBAN_FEATURES) {
    if (!f.b) {
      lit(f.a, (f.peak - 0.55) / 0.45, 1);
      continue;
    }
    // A corridor is drawn as a run of overlapping glows rather than as a
    // stroked line: additive sprites are what the scattered pass already
    // uses, so the belt joins its own cities' halos instead of sitting on
    // top of them as a drawn stripe. Spacing is a fraction of the width, so
    // the run reads as one continuous thread.
    const span = Math.acos(THREE.MathUtils.clamp(f.cosSpan, -1, 1));
    const steps = Math.max(2, Math.ceil(span / (f.radius * 0.6)));
    for (let i = 0; i <= steps; i++) {
      step.copy(f.a).lerp(f.b, i / steps).normalize();
      // Dark ground between towns still exists — the thread flickers in
      // brightness along its length instead of being an even bar of light.
      const jitter = 0.65 + 0.35 * fbm3(step.x * 90, step.y * 90, step.z * 90, 2);
      // Fade the last few glows at each end, or a corridor terminates in a
      // hard bright full stop out in open country and reads as a drawn
      // stroke rather than as towns running together.
      const t = i / steps;
      const taper = smoothstep(Math.min(t, 1 - t), 0, 0.18);
      lit(step, f.peak * 0.5, jitter * 0.55 * (0.35 + 0.65 * taper));
    }
  }

  ctx.globalCompositeOperation = 'source-over';
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
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

  // Sampled, not sharedHeightField: this texture is not necessarily built at
  // the same size as the terrain paint, and taking the shared field at a
  // second resolution would throw away the cache the rest of the build is
  // still using.
  const heights = new Float32Array(width * height);
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      heights[py * width + px] = sampledHeight(dirForPixel(px, py, width, height, dir)).raw;
    }
  }
  const coastDist = coastDistanceField(heights, width, height);
  const texelScale = width / 1536;

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      dirForPixel(px, py, width, height, dir);
      const h = heights[py * width + px];
      // The jitter the paint's own coastline uses, in texels, so the surf
      // wanders with the shore it belongs to instead of tracing a
      // mathematically clean offset curve beside it.
      // Land texels are never surf — the jitter below is applied only once a
      // texel is already on the water side, or a shore-adjacent inland pixel
      // picks up a positive distance out of nothing and the whole interior of
      // every continent foams.
      const d = coastDist[py * width + px];
      const jittered = d > 0 ? d + coastlineJitter(dir) * 220 * texelScale : 0;
      const surf = d > 0 ? surfAt(dir, jittered, texelScale) : 0;
      const occlusion = d > 0 ? shoreOcclusion(dir, jittered, texelScale) : 0;
      const c = oceanColor(dir, h, surf, occlusion);

      const idx = (py * width + px) * 4;
      writeSRGBPixel(image.data, idx, c);
      // Depth-driven opacity: this is the whole trick. Water is not a
      // colored surface, it is a colored *volume*, so a hand's depth of it
      // over a sandbar hides almost nothing while the same pigment over the
      // shelf edge hides everything. Baking that into the shell's alpha
      // gives the poured-resin read without paying for real transmission.
      const depth = 1 - smoothstep(h, -0.13, SEA_LEVEL);
      // ...except where it is breaking. Foam is air in water: it is the one
      // part of the sea that is not see-through, so the shallows' low alpha
      // (which is what lets the seabed read) has to be overridden there or
      // the white simply washes out against the sand underneath it.
      const clarity = THREE.MathUtils.lerp(0.26, 0.93, depth);
      image.data[idx + 3] = Math.round(Math.max(clarity, surf * 0.96) * 255);
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
export { orogenyBeltAt };
