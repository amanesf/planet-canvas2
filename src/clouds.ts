import * as THREE from 'three';
import { fbm3 } from './noise';
import { displaceWithNoise, mulberry32 } from './spatialHash';
import { precipitationAtSeason, sampledHeight, zonalPrecipitationAt } from './terrain';

// Low-frequency "weather system" noise — clouds cluster into patches
// instead of scattering uniformly, like real cloud cover does.
function cloudDensityAt(dir: THREE.Vector3): number {
  return fbm3(dir.x * 1.1 + 150, dir.y * 1.1 + 150, dir.z * 1.1 + 150, 2);
}

// ---------------------------------------------------------------------
// Where the weather is, and where it merely happens to be
// ---------------------------------------------------------------------
// The sky used to be laid out by that noise alone: patches of cotton in
// places the noise happened to like, with the *type* picked off a latitude
// ladder. Nothing in it had ever read the rainfall the ground is painted
// from, which is the split §3 of the gap analysis is about — the globe knew
// the Sahara was a desert and the sky did not, so a cloud deck sat over it
// as readily as over the Congo.
//
// Two couplings, because a cloud is a thing that *moves* and the two halves
// of "where does it rain" behave completely differently under that:
//
// - Latitude is invariant under the zonal wind. A band seeded at 8° is
//   still at 8° an hour later, so the structural decision — how much cloud
//   exists at all at this latitude, and what kind — is taken against
//   `zonalPrecipitationAt`: the ITCZ gets bands, the subtropical highs at
//   ±25° get very few, the storm tracks get them back.
// - Longitude is not. So the local half is read *live*, every frame, at
//   wherever each nodule has drifted to: cloud swells crossing the Amazon
//   and thins to a fray crossing the Sahara. Baking that at build time
//   would have been the baked-bearing mistake again (§2-17) — right for
//   one minute, wrong afterwards.
//
// Which is also why this is per nodule rather than per band. A band is
// thousands of kilometres long; over the Sahel one end of it is in the
// monsoon and the other is over sand, and thinning only the dry end is the
// whole point.

/**
 * How cloudy a sky with this much rain falling out of it, at this latitude,
 * ought to be — 0 clear, 1 overcast.
 *
 * Not the rainfall itself, which was the first version of this and was
 * wrong in a way that only showed up when the falling snow was measured
 * against it: at the rate the Köppen table gives them, the polar caps are
 * deserts (an ice sheet gets less water than the Sahel), so the sky over
 * them emptied out and 2600 flakes were left falling through clear air over
 * Antarctica — the exact "clear sky snows" fault this coupling exists to
 * end, recreated from the other side.
 *
 * Cloud cover is not annual millimetres, it is millimetres against what the
 * air could hold. Cold air holds almost nothing, so a polar sky is overcast
 * on a rainfall total that would be a drought in the tropics, while the
 * genuinely cloudless places on this planet are the warm dry ones — the
 * subtropical highs, which is where every desert on the globe underneath
 * is. Dividing by a capacity that falls off with the cold says both at
 * once, off one number that is already to hand.
 *
 * The relief is confined to the high latitudes on purpose. Letting the
 * capacity fall smoothly all the way from the equator (cos²(lat), which is
 * what this was first) softens the threshold under the subtropics too, and
 * measurably puts cloud back over the Sahara — the hot deserts went from
 * 1.35x their fair share of the sky to 1.55x for it. Everything below 38° is
 * left reading raw rainfall, exactly as it did before this function
 * existed.
 */
function cloudinessFor(precipitation: number, y: number): number {
  // 1 up to about 38°, a fifth of that by 68° — how much water this air can
  // carry, as a fraction of what tropical air can.
  const capacity = 1 - 0.8 * THREE.MathUtils.smoothstep(Math.abs(y), 0.62, 0.93);
  return THREE.MathUtils.smoothstep(precipitation / capacity, 0.16, 0.46);
}

/**
 * ...and how big a nodule that makes.
 *
 * Bounded, and deliberately not bounded at zero. The deck's shade is a
 * texture baked once from the nodule positions (`buildCloudShadowTexture`),
 * which cannot know about this modulation — so a nodule allowed to vanish
 * would leave its own shadow lying on the desert underneath it with nothing
 * overhead to cast it. A third size and full size is as far as that can be
 * pushed while every shadow still has some visible cloud over it.
 */
function coverageFor(precipitation: number, y: number): number {
  return 0.35 + 0.8 * cloudinessFor(precipitation, y);
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
  /**
   * 'band': a chain of nodules walked along a great-circle arc (real
   * stratus sheets and cirrus streaks are genuinely elongated by the wind
   * that combed them, so a line-like footprint is *correct* for these
   * two). 'cluster': nodules scattered in a 2D disc around a centre
   * instead — real cumulus and cumulonimbus are separate individual
   * cells, not one continuous streak, and building every type as a band
   * (as this used to) is what made the whole sky read as "clouds always
   * form in a line" regardless of type. See buildCloudCluster.
   */
  layout: 'band' | 'cluster';
  /**
   * 'band': min/max arc length in radians. 'cluster': min/max footprint
   * radius in radians — a different quantity, reusing the field because
   * both are "how far this system's own geometry reaches."
   */
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
  /**
   * How much of the band's grain survives all the way to its tips, 0..1.
   * 1 is what this used to do — the last nodule of a band was the same
   * *kind* of lump as the ones in the middle, only fed a smaller `bulk`, so
   * a band ended in a recognisable ball. Pulled cotton does not end in a
   * smaller ball, it ends in nothing, so the tips get an extra multiplier
   * on top of the bulk taper and bottom out here. The same number also sets
   * how readily the tips drop masses outright: a low floor means the last
   * of the band is detached specks with sky between them.
   */
  tipFloor: number;
  /**
   * How strongly this type's nodules line up with the band they were laid
   * along, 0..1. 0 is the uniform random spin every nodule used to get,
   * which is fine while every nodule is a round blob and worthless the
   * moment they are drawn out into lozenges — combed fibre only reads as
   * fibre if the fibres agree on a direction. 1 is exactly along the band.
   */
  comb: number;
  /**
   * Ceiling on how far a nodule of this type is drawn out along its own
   * long axis. 1 would be the sphere this used to place. The width shrinks
   * as the length grows (see the `drawnOut` helper), because a wad of
   * batting pulled longer gets *thinner*, it does not gain material.
   */
  drawOut: number;
  /**
   * Expected number of specks laid per step, on top of the masses. These
   * are the fibres that came away when the wad was torn: much smaller than
   * the masses, not scaled by the local bulk at all, and laid wide of the
   * spine so they fringe the band instead of filling it.
   */
  tuft: number;
}

const CLOUD_TYPE_PARAMS: Record<CloudType, CloudTypeParams> = {
  // Real fair-weather cumulus is a handful of separate, roughly round
  // puffs, not one drawn-out streak — 'cluster' (see CloudTypeParams.layout)
  // and a footprint radius an order of magnitude smaller than the old
  // 0.3-0.64 rad *arc length* this used to have, which alone was up to a
  // third of the visible globe's diameter and is exactly what "oddly huge
  // clouds" was describing.
  cumulus: {
    layout: 'cluster',
    arc: [0.05, 0.095],
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
    tipFloor: 0.42,
    comb: 0.34,
    drawOut: 1.85,
    tuft: 0.85,
  },
  // A flat, low, wide overcast sheet — few tall lumps, lots of shallow
  // wide ones packed close together so the gaps between nodules close up
  // into one hazy layer instead of reading as a string of puffs.
  // Kept as a band — a real overcast sheet genuinely is elongated along
  // the front that made it — but the old 0.55-0.95 rad arc length was
  // enormous (a single sheet could span half the visible globe). Shortened
  // so a stratus deck reads as one patch of overcast among others, not the
  // one shape the whole sky is made of.
  stratus: {
    layout: 'band',
    arc: [0.22, 0.4],
    hoverBase: 0.09,
    hoverBulk: 0.03,
    sizeBase: 0.05,
    sizeBulk: 0.02,
    // clusterBase trimmed from 2: even after fixing steps to scale with
    // arc (see the note by `const steps` in buildCloudBand), a sheet still
    // legitimately carries more nodules per step than a puffy type — this
    // just keeps that ratio from being as extreme as it measured.
    clusterBulk: 1.1,
    clusterBase: 1,
    flatten: 0.45,
    haloOpacity: 0.16,
    haloScale: 1.5,
    undersideFloor: 0.62,
    // A sheet is the one type that must not open up at its ends — the whole
    // point of it is that the nodules close into one hazy layer — so its
    // tips are only mildly drawn out and it keeps nearly all of its masses.
    tipFloor: 0.68,
    comb: 0.55,
    drawOut: 2.1,
    tuft: 0.6,
  },
  // Thin, sparse, high wisps — the opposite instinct from every other
  // type: fewer nodules, not more, each one small and stretched long
  // along the band so it reads as combed rather than piled.
  // Also a real band — cirrus streaks are wind-drawn ice, the most
  // legitimately line-shaped cloud in the sky — but 0.75-1.25 rad was
  // 43-72°, i.e. it alone could stretch most of the way across the visible
  // disc. Shortened so there can be several separate streaks at different
  // latitudes instead of one dominating swoop.
  cirrus: {
    layout: 'band',
    arc: [0.32, 0.55],
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
    // The type that is *made* of grain: nearly all combed, drawn out further
    // than anything else on the planet, and ending in nothing at all.
    tipFloor: 0.3,
    comb: 0.9,
    drawOut: 3.0,
    tuft: 0.75,
  },
  // A tropical cyclone. Not laid along a band like every other type — its
  // nodules are placed in spiral coordinates around a moving centre (see
  // buildTyphoon) — so `arc` is unused here; the rest of the numbers are
  // what the eyewall's cotton is made of: dense, tall, dark underneath.
  typhoon: {
    layout: 'band', // unused — see the comment above, placement is bespoke
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
    // A cyclone is not laid along a band, so it has neither tips to draw out
    // nor tuft fringes to hang off a spine, and its grain direction is
    // resolved every frame from the arm it sits on rather than baked (see
    // pushSpiralNodule and the spiral branch of advect). Only drawOut is
    // read here.
    tipFloor: 1,
    comb: 1,
    drawOut: 2.0,
    tuft: 0,
  },
  // Tall and dense with a dark, heavy underside — a cumulonimbus cell,
  // the only type that gets its own material (see buildClouds) so it can
  // flicker with lightning independently of the calm weather around it.
  // A thunderhead is a discrete cell, not a streak — 'cluster', and a much
  // smaller footprint than the old 0.22-0.4 rad arc length, so it reads as
  // one compact tall tower rather than a smeared line of storm cells.
  storm: {
    layout: 'cluster',
    arc: [0.045, 0.075],
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
    // A thunderhead is piled, not combed — it is the one type whose lumps
    // are allowed to stay nearly round, because vertical development is what
    // reads as a storm and a drawn-out cell reads as a smear.
    tipFloor: 0.5,
    comb: 0.2,
    drawOut: 1.5,
    tuft: 0.9,
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
  /**
   * Which way this nodule's long axis points, as a compass bearing in
   * radians: 0 is local north, +π/2 is local east.
   *
   * This replaced a plain `spin` about the surface normal, and the reason is
   * worth writing down because "just store the angle" looks obviously
   * sufficient and is not. The old rotation was `spinQ * align`, where
   * `align` was the *minimal* rotation carrying +Y onto the surface normal.
   * That frame has a twist in it that varies with position, so a nodule set
   * up to point along its band at t = 0 slowly rotates out of alignment as
   * the wind carries it east: at 0.027 rad/s the westerlies move a band more
   * than a radian of longitude a minute, and any combing baked at build time
   * has visibly decayed into the old uniform random spin before you have
   * finished watching one cloud cross the face. A bearing is invariant under
   * the rotation about the polar axis that the drift *is*, so it stays true.
   */
  bearing: number;
  /** cos/sin of `bearing`, so the per-frame pass does no trigonometry */
  bearingCos: number;
  bearingSin: number;
  /**
   * Per-instance non-uniform scale, multiplied into `size` when the matrix
   * is composed. The nodule geometry is shared — three variants for the
   * whole planet, because a fourth would be a fourth draw call — so this is
   * the only place a nodule can stop being the same shape as its
   * neighbours. `sx` runs along `bearing`, i.e. along the band when the type
   * combs (see CloudTypeParams.comb), so >1 draws the lump out into a fibre
   * rather than just making it a bigger ball.
   */
  sx: number;
  sy: number;
  sz: number;
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
  /**
   * The unit world-space direction its long axis points *this frame*,
   * perpendicular to `live`. Resolved once per nodule per frame in advect
   * from `bearing` (or, for cyclone nodules, from whichever arm they sit on
   * at the moment) so that the core layer and the halo layer over it agree
   * without either recomputing it.
   */
  grain: THREE.Vector3;
  /** and how big it is this frame (breathing, storm intensity) */
  liveScale: number;
}

type NoduleSpec = Omit<Nodule, 'lat' | 'lon' | 'live' | 'liveScale' | 'grain' | 'bearingCos' | 'bearingSin'>;

function makeNodule(dir: THREE.Vector3, rest: NoduleSpec): Nodule {
  return {
    ...rest,
    lat: latOf(dir),
    lon: lonOf(dir),
    live: dir.clone(),
    grain: new THREE.Vector3(1, 0, 0),
    bearingCos: Math.cos(rest.bearing),
    bearingSin: Math.sin(rest.bearing),
    liveScale: 1,
  };
}

/**
 * How wide a nodule is once it has been drawn out to `long` times its own
 * length. Pulling a wad of batting longer does not create material: it takes
 * it from the width. Not area-preserving on purpose — at `long^-0.42` the
 * footprint still grows with the pull, and that surplus is what closes the
 * gaps *along* a band, which is the difference between a row of separate
 * lumps and one torn strip.
 *
 * The height is deliberately *not* reduced along with the width, and the
 * first version of this got that wrong in a way that was obvious the moment
 * it was on screen. Taking `long^-0.34` off the height as well, on top of
 * the 0.72 already baked into the nodule geometry and the 0.8 applied in
 * tick, left every lump a pancake — and a stretched low-poly pancake lit
 * from one side is not cotton, it is a flake of torn paper or a chip of ice.
 * The whole deck read as white shards scattered on the sea. Cotton pulled
 * apart stays *domed*; it is fluff, it does not compact when you stretch it.
 */
function drawnOut(long: number): number {
  return Math.pow(long, -0.42);
}

// Local east/north at a point on the sphere. East is the direction of
// increasing longitude under lonOf's convention (`atan2(z, -x)`), which is
// the same convention the terrain is painted in — getting this backwards
// would comb every cloud on the planet across the flow instead of along it.
// Returns false at the poles, where a compass bearing has no meaning.
function tangentFrame(dir: THREE.Vector3, east: THREE.Vector3, north: THREE.Vector3): boolean {
  const c = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
  if (c < 1e-4) return false;
  east.set(dir.z / c, 0, -dir.x / c);
  north.crossVectors(dir, east);
  return true;
}

// Build-time scratch for bearingOf.
const bearEast = new THREE.Vector3();
const bearNorth = new THREE.Vector3();

/** The compass bearing of a tangent direction at a point. */
function bearingOf(dir: THREE.Vector3, tangent: THREE.Vector3): number {
  if (!tangentFrame(dir, bearEast, bearNorth)) return 0;
  return Math.atan2(tangent.dot(bearEast), tangent.dot(bearNorth));
}

/**
 * One cloud: a chain of nodules walked along a great-circle arc, thick in
 * the middle and tapering to wisps at both ends.
 *
 * ---------------------------------------------------------------------
 * Grain
 * ---------------------------------------------------------------------
 * The band *shape* was right and the reading was still "a bag of identical
 * lumps", for a reason that is about statistics rather than about shape.
 * Every nodule was drawn from `(sizeBase + bulk*sizeBulk) * (0.55 + U*0.8)`,
 * a uniform ±42% around a mean that itself only moves by a factor of 2.6
 * from the middle of a band to its end. Measured over the whole sky
 * (temporary hook, `?debugclouds`) that put 63% of the planet's nodules
 * inside ±30% of the median and the 90th/10th percentile ratio at 2.6. One
 * grain size means one material, and a material made of same-sized balls is
 * polystyrene, not batting.
 *
 * Torn cotton has the opposite statistics: a few big masses, a few medium
 * shoulders leaning on them, and a lot of specks pulled off the edges and
 * the ends. Four things here produce that, all of them build-time only, so
 * none of it costs a draw call or a frame:
 *
 * 1. Masses are *ranked* within their step. The first lump laid at a step is
 *    the mass and sits on the spine; each one after it is a shoulder at
 *    0.72x of the one before, pushed progressively further off the spine.
 *    Rank alone spans a factor of 2.7 within a single step, where before the
 *    members of a cluster were interchangeable draws from one distribution.
 * 2. Every nodule is *drawn out* along its own long axis by a per-instance
 *    non-uniform scale, and combed so that a band's fibres agree about which
 *    way they run. This is the half of the fix that stops them being round;
 *    the size hierarchy is the half that stops them being the same.
 * 3. Tufts: a second, much smaller population that is not scaled by the
 *    local bulk at all — specks of a roughly fixed small size, so that where
 *    the band is fat they are a fifth of the mass beside them and where it
 *    is thin they are all that is left. They are laid wide of the spine, and
 *    at the ends they are thrown *past* the last step, so a band frays out
 *    into open sky rather than stopping.
 * 4. The tips both shrink harder (`tipFloor`) and start dropping masses
 *    outright, so the last of a band is detached specks with sky between
 *    them instead of one final smaller ball.
 */
function buildCloudBand(
  start: THREE.Vector3,
  band: number,
  params: CloudTypeParams,
  rand: () => number,
  out: Nodule[],
): void {
  // a tangent direction to walk along, and a second tangent to spread across
  const along = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5);
  // orthogonalize against the surface normal
  along.addScaledVector(start, -along.dot(start)).normalize();
  const across = new THREE.Vector3().crossVectors(start, along).normalize();

  // Arc length in radians. On a two-unit globe, half a radian is a band
  // spanning about a quarter of the visible face — which is the scale the
  // reference's cloud masses actually sit at, and several times bigger
  // than the popcorn puffs this replaced.
  const arc = params.arc[0] + rand() * (params.arc[1] - params.arc[0]);
  // Was a flat 14-23 regardless of `arc`. Measured (see the per-band nodule
  // counts a Node-side harness dumped: `npx tsx` importing buildClouds
  // directly, no browser needed since none of this touches the DOM) that
  // this was a real bug, not a rendering nuance: shortening stratus/cirrus's
  // arc range to stop a single system spanning most of the visible globe
  // (done in a previous pass) left step *count* untouched, which packed the
  // same 14-23 steps into a third of the space — density per degree went
  // up exactly as total footprint went down, so total nodule count barely
  // moved. Measured result: 5 stratus bands carried 289 of 406 non-typhoon
  // nodules (71%), while cumulus/storm clusters averaged 6 nodules each.
  // Scaling steps with arc keeps density roughly constant instead, so a
  // shorter band actually is a smaller amount of cloud, not just a
  // smaller-looking one at the same mass.
  const steps = THREE.MathUtils.clamp(Math.round(arc / 0.028), 6, 26);
  // how far the band wanders off a clean great circle, so it isn't a ruler line
  const wander = (rand() - 0.5) * 0.5;

  const point = new THREE.Vector3();
  const tangent = new THREE.Vector3();
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

    // Which way the band is running here — the derivative of the walk above
    // with respect to `angle` — reprojected onto the tangent plane at the
    // point actually reached. Everything laid at this step is combed toward
    // it, by as much as the type's `comb` asks for.
    tangent
      .copy(start)
      .multiplyScalar(-Math.sin(angle))
      .addScaledVector(along, Math.cos(angle));
    tangent.addScaledVector(point, -tangent.dot(point)).normalize();
    const spine = bearingOf(point, tangent);
    const jitter = (1 - params.comb) * Math.PI;

    // The tips. `bulk` alone still leaves a recognisable lump at t = 0 and
    // t = 1, because `sizeBase` is a flat floor under it; this multiplies
    // that floor away as well, and `open` is the matching chance of laying
    // nothing at all there.
    const taper = params.tipFloor + (1 - params.tipFloor) * Math.pow(bulk, 0.55);
    const open = (1 - bulk) * (1 - bulk) * (1 - params.tipFloor) * 1.6;

    // more nodules where the band is thickest; the tapering ends thin out
    // to one or two, which is what reads as a wisp
    const clusterSize = params.clusterBase + Math.floor(bulk * params.clusterBulk + rand() * 1.0);
    // The spine is narrow and only the fringe is wide. It used to be one
    // uniform ±(0.06 + bulk*0.13) rad for everything, which at a nodule's
    // angular radius of ~0.024 rad scattered the members of a cluster four
    // radii apart — so a "band" was a loose sprinkle of separate balls with
    // sky between them, and that, more than the shape of any one nodule, is
    // why it never read as one torn strip. Torn batting is a *connected*
    // mass with a frayed edge; separate lumps at even spacing are a
    // sprinkle, whatever shape you make the lumps.
    const halfWidth = 0.014 + bulk * 0.03;

    for (let c = 0; c < clusterSize; c++) {
      if (rand() < open) continue; // the band has already ended here
      // rank 0 is the mass, on the spine; every one after it is a smaller
      // shoulder leaning on it and set a little further out
      const rankSize = Math.pow(0.72, c);
      const lateral =
        (rand() - 0.5) * halfWidth * 1.3 +
        (c === 0 ? 0 : (rand() < 0.5 ? -1 : 1) * halfWidth * c * 0.85);
      // Was ±0.05 rad, against a step spacing of about 0.025 — so the
      // members of a cluster were scattered further along the band than the
      // distance to the next cluster, and the ordering that makes a spine a
      // spine was lost in the noise.
      const forward = (rand() - 0.5) * 0.022;
      const dir = point
        .clone()
        .addScaledVector(across, lateral)
        .addScaledVector(along, forward)
        .normalize();

      // Squared rather than uniform: the point is a long tail, not a wider
      // band of the same middling size. Most masses sit near 0.95 and about
      // one in ten runs past 1.6.
      const grain = 0.85 + rand() * rand() * 1.5;
      // Skewed toward 1 with a long tail, for the same reason the size is:
      // a uniform draw between two elongations gives every lump the same
      // rounded-rectangle outline and simply trades "identical balls" for
      // "identical lozenges". Skewed, most masses stay nearly round and the
      // few that run out to two and a half times their width are the ones
      // that read as having been pulled.
      const long = 1 + Math.pow(rand(), 1.5) * (params.drawOut * 1.35 - 1);

      out.push(makeNodule(dir, {
        // Standing clear of the surface rather than lying on it: pinned
        // this tightly they read as frost on the shell, and the gap is what
        // lets their shadows land on the terrain where you can see them.
        // Shoulders sit slightly lower than the mass they lean on, which is
        // what stops a cluster reading as one level shelf of lumps. The
        // random part used to be 0.05, which is a whole nodule radius of
        // vertical scatter — every lump floating at its own altitude, none
        // of them merging into the one beside it, all of them separately
        // silhouetted against the sea. A wad of batting is laid on a
        // surface; it does not hover in layers.
        hover: params.hoverBase + bulk * params.hoverBulk + rand() * 0.022 - c * 0.013,
        size: (params.sizeBase + bulk * params.sizeBulk) * taper * rankSize * grain,
        // The half-turn is free shape variety and it matters most exactly
        // where the combing is strongest. A nodule is a lump with its bulge
        // off to one side, so turning it end for end gives a different
        // silhouette without a second geometry; for cirrus, which is combed
        // 90% and would otherwise lay every fibre with its fat end the same
        // way round, it is the only asymmetry left.
        bearing: spine + (rand() - 0.5) * 2 * jitter + (rand() < 0.5 ? Math.PI : 0),
        sx: long,
        sy: 0.92 + rand() * 0.34,
        sz: drawnOut(long) * (0.9 + rand() * 0.26),
        band,
      }));
    }

    // Tufts. Deliberately *not* multiplied by `bulk`: a speck torn off the
    // edge of a wad is the same size wherever it came from, and it is that
    // fixed small size next to a mass five times its width that gives the
    // deck a hierarchy the eye can read at a glance.
    const tufts = Math.floor(params.tuft + rand());
    for (let c = 0; c < tufts; c++) {
      // Just off the shoulders, not out in open sky: a fibre that has come
      // away from the wad is still touching it.
      const lateral = (rand() < 0.5 ? -1 : 1) * halfWidth * (1.3 + rand() * 1.5);
      // At the ends, throw them *past* the last step along the band's own
      // direction. A band that stops at its final step stops at a line; one
      // that keeps shedding specks beyond it frays.
      const overrun = (1 - bulk) * (1 - bulk) * (t < 0.5 ? -1 : 1) * rand() * 0.11;
      const forward = (rand() - 0.5) * 0.04 + overrun;
      const dir = point
        .clone()
        .addScaledVector(across, lateral)
        .addScaledVector(along, forward)
        .normalize();

      const long = 1.35 + rand() * (params.drawOut * 1.2 - 1.35);
      out.push(makeNodule(dir, {
        hover: params.hoverBase + bulk * params.hoverBulk * 0.6 + rand() * 0.03,
        // Based on the type's floor plus a slice of its bulk rather than on
        // the floor alone: cirrus, whose floor is 0.018, was otherwise
        // shedding specks two pixels across that no viewer could resolve.
        size: (params.sizeBase + params.sizeBulk * 0.3) * (0.3 + rand() * rand() * 0.55),
        // Specks are the most strongly combed thing in the sky — they are
        // literally the fibres the pull left behind — so they ignore all but
        // a little of the type's jitter.
        bearing: spine + (rand() - 0.5) * jitter * 0.5 + (rand() < 0.5 ? Math.PI : 0),
        sx: long,
        sy: 0.85 + rand() * 0.25,
        sz: drawnOut(long) * (0.82 + rand() * 0.26),
        band,
      }));
    }
  }
}

/**
 * One cloud: a handful of puffs scattered in a disc around a centre point,
 * instead of walked along a great-circle arc like buildCloudBand.
 *
 * This exists because making *every* cloud type a band was the real bug
 * behind "clouds always form in a line" — latitude diversity (see the
 * seed quota in buildClouds) fixes where systems appear, but every system
 * was still individually shaped like a stretched-out streak, cumulus and
 * thunderheads included, which is not what those look like in life. A
 * cumulus field is a scatter of separate rounded puffs; a cumulonimbus is
 * one compact tall cell. Both want a *disc* footprint, not a *line* one.
 *
 * Reuses the same statistics buildCloudBand uses for texture — ranked
 * masses with shoulders, plus a fringe of small unscaled tufts — just
 * arranged radially around a centre instead of along a spine, so the two
 * layouts still read as the same material.
 */
function buildCloudCluster(
  center: THREE.Vector3,
  band: number,
  params: CloudTypeParams,
  rand: () => number,
  out: Nodule[],
): void {
  const east = new THREE.Vector3();
  const north = new THREE.Vector3();
  if (!tangentFrame(center, east, north)) {
    // Pole fallback: tangentFrame only fails within ~0.01 rad of the axis,
    // far closer than any weather-zone quota ever samples, but a cluster
    // still needs *some* orthonormal basis to scatter puffs in.
    const arbitrary = Math.abs(center.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    east.crossVectors(arbitrary, center).normalize();
    north.crossVectors(center, east).normalize();
  }

  const radius = params.arc[0] + rand() * (params.arc[1] - params.arc[0]);
  const puffCount = params.clusterBase + 2 + Math.floor(rand() * 3);

  // Puff centres, area-uniform (sqrt) but biased inward (extra pow) so the
  // scatter still reads as one cluster with satellites rather than an even
  // sprinkle — the disc equivalent of buildCloudBand's rank-by-position.
  const puffs: { x: number; y: number }[] = [];
  for (let i = 0; i < puffCount; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.pow(rand(), 0.6) * radius;
    puffs.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  // Guarantee a core mass at the true centre rather than leaving it to
  // chance — without this a cluster could roll every puff out toward its
  // rim and end up a hollow ring instead of a mass with satellites.
  puffs[0].x *= 0.25;
  puffs[0].y *= 0.25;
  puffs.sort((a, b) => a.x * a.x + a.y * a.y - (b.x * b.x + b.y * b.y));

  const point = new THREE.Vector3();
  puffs.forEach((puff, pi) => {
    const dist = Math.sqrt(puff.x * puff.x + puff.y * puff.y) / Math.max(radius, 1e-4);
    const rankSize = Math.pow(0.75, pi);
    const bulk = 1 - dist * 0.6; // masses taper outward, same shape as a band's sin(t*PI) peak

    point.copy(center).addScaledVector(east, puff.x).addScaledVector(north, puff.y).normalize();

    // One or two lumps per puff for internal texture, same as a band step.
    const massesHere = 1 + Math.floor(rand() * 2);
    for (let m = 0; m < massesHere; m++) {
      const grain = 0.85 + rand() * rand() * 1.5;
      // Less elongation ceiling than a band gets: cumulus and thunderheads
      // stay rounder lumps, they are not fibres pulled out by shear.
      const long = 1 + Math.pow(rand(), 1.5) * (params.drawOut * 0.75 - 1);
      const dir = point
        .clone()
        .addScaledVector(east, (rand() - 0.5) * 0.012)
        .addScaledVector(north, (rand() - 0.5) * 0.012)
        .normalize();
      out.push(makeNodule(dir, {
        hover: params.hoverBase + bulk * params.hoverBulk + rand() * 0.022,
        size: (params.sizeBase + bulk * params.sizeBulk) * rankSize * grain * (0.75 + rand() * 0.4),
        // No spine to comb along, so bearing is free — a puffy lump does
        // not need to agree with its neighbours about which way it leans.
        bearing: rand() * Math.PI * 2,
        sx: long,
        sy: 0.92 + rand() * 0.34,
        sz: drawnOut(long) * (0.9 + rand() * 0.26),
        band,
      }));
    }
  });

  // A light fringe of tufts just outside the puffs, same role as a band's:
  // stops the cluster's edge from being a hard cutoff.
  const tufts = Math.floor(params.tuft * 1.2 + rand());
  for (let c = 0; c < tufts; c++) {
    const a = rand() * Math.PI * 2;
    const r = radius * (1.05 + rand() * 0.55);
    const dir = center
      .clone()
      .addScaledVector(east, Math.cos(a) * r)
      .addScaledVector(north, Math.sin(a) * r)
      .normalize();
    const long = 1.2 + rand() * Math.max(0.1, params.drawOut * 0.7 - 1.2);
    out.push(makeNodule(dir, {
      hover: params.hoverBase + rand() * 0.03,
      size: (params.sizeBase + params.sizeBulk * 0.25) * (0.3 + rand() * rand() * 0.5),
      bearing: rand() * Math.PI * 2,
      sx: long,
      sy: 0.85 + rand() * 0.25,
      sz: drawnOut(long) * (0.82 + rand() * 0.26),
      band,
    }));
  }
}

/** A single lumpy nodule — the unit the whole sky is built from. */
function buildNoduleGeometry(rand: () => number, flatten: number, undersideFloor: number): THREE.BufferGeometry {
  // 12 segments round, 5 rings. Costs 96 triangles against the 80 of the
  // 8x6 this replaced — a fifth more, and it buys the thing that actually
  // shows. What you see of a nodule is almost entirely its *horizontal*
  // outline: it is squashed to 0.72 by the line below and to 0.8 again in
  // tick, and it is looked at from above the horizon. Eight segments round
  // meant that outline was an octagon with 45-degree corners, and once the
  // nodules were drawn out along one axis (see Nodule.sx) those corners
  // stopped being hidden by the roundness and the deck read as white shards.
  // Twelve round and five up is the same triangle budget spent where the
  // silhouette is instead of on rings nothing looks at edge-on.
  const g = new THREE.SphereGeometry(1, 12, 5);
  // 3.2 was past the point where this geometry can carry the noise: at 45
  // degrees between vertices the sample spacing was 2.5 noise units, so
  // neighbouring vertices got uncorrelated values and the "lumpiness" was
  // really aliasing — which is invisible while the shape is a ball, because
  // a ball's outline is a circle whatever you do to its middle, and turns
  // into faceted gemstones the moment the ball is stretched.
  //
  // Both ends of the range were tried and both are wrong in their own way.
  // At 1.5 the displacement is one coherent bulge per nodule and the deck
  // reads as a scatter of smooth white pebbles — soap, not fibre. 2.6 is
  // about two vertices per noise feature at the 30-degree spacing this
  // geometry now has: enough for a ragged outline, not so much that
  // neighbouring vertices disagree. Deeper than the original as well, since
  // depth is what is left doing the work once the frequency is bounded.
  // Build-time only.
  displaceWithNoise(g, 0.46, 2.6, rand() * 500);
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

/**
 * Peak wind speed, in radians of great circle per second.
 *
 * The globe itself spins at roughly 0.15 rad/s (a full day in ~42s), so the
 * old 0.02 here — a peak drift of ~0.027 rad/s in the westerlies — was 5-7x
 * slower than the globe's own rotation. `clouds.group` is a child of the
 * globe, so with the wind that faint the dominant visible motion was always
 * the sphere spinning under a nearly-static cloud deck: the drift was real
 * (the per-frame advection math was correct) but too small a fraction of
 * the total motion on screen to read as clouds moving *relative to the
 * ground*. Raised so the westerlies are a clearly separate, slower-than-
 * rotation motion instead of visually merging into it.
 */
const WIND_SCALE = 0.05;

/**
 * Eastward wind speed at a latitude, in radians of great circle per second.
 * Negative is an easterly (blowing toward the west).
 *
 * Exported because the volcanic ash plumes need the same answer. They used
 * to lean by a hardcoded constant in one fixed direction at every volcano
 * on the planet, while the clouds passing overhead reverse three times
 * between the equator and the pole — so in the trades the ash and the sky
 * above it visibly disagreed about which way the air was moving. Copying
 * the profile into eruptions.ts would have fixed the picture and recreated
 * the "two systems, two expressions" split this codebase keeps having to
 * undo, so it is read from here instead.
 */
export function zonalWind(lat: number): number {
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

// terrain.ts's latLonToDir takes real degrees with the prime meridian at the
// texture's horizontal centre: phi = (lonDeg + 180) in radians. This module's
// own `lon` (used by dirFromLatLon/lonOf above) is exactly that phi — the two
// conventions agree once the +180 shift is applied, which is what lets a real
// coordinate (e.g. "140°E, off the Philippines") be dropped straight into the
// typhoon track math below instead of being reverse-engineered by eye.
function lonFromRealDeg(lonDeg: number): number {
  return ((lonDeg + 180) * Math.PI) / 180;
}

/**
 * Real genesis point (degrees) + hemisphere for each basin a cyclone is
 * allowed to spin up in. `typhoonCentre`'s track runs west then recurves
 * east across roughly lon0-16° to lon0+43° while climbing from ~12° to ~34°
 * of the given hemisphere's latitude, so each entry was chosen by checking
 * that whole swept band stays over ocean, not just the genesis point:
 *  - Western Pacific: Philippine Sea genesis, recurving toward Japan.
 *  - Atlantic: mid-ocean genesis (the real "Cape Verde" storms' nursery),
 *    tracking into the Caribbean and recurving up into the open Atlantic.
 *  - South Pacific: Coral Sea genesis, recurving away from Australia.
 *  - South Indian Ocean: Mascarene basin genesis east of Madagascar.
 */
const TYPHOON_BASINS: { lonDeg: number; hemi: 1 | -1 }[] = [
  { lonDeg: 132, hemi: 1 },
  { lonDeg: -52, hemi: 1 },
  { lonDeg: 168, hemi: -1 },
  { lonDeg: 63, hemi: -1 },
];

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

function typhoonCentre(sys: TyphoonSystem, rawAge: number, out: THREE.Vector3): THREE.Vector3 {
  // `typhoonAge` returns −1 for "no storm right now", and a negative base
  // under a fractional exponent is NaN — which put every one of this
  // cyclone's 256 instance matrices at NaN for the whole quiet half of the
  // cycle. It never showed because a NaN matrix draws nothing, i.e. the
  // gaps between storms were working by accident; `advect` now folds the
  // storm away explicitly (liveScale 0) and this only has to stay finite.
  const age = Math.max(rawAge, 0);
  // 12°N-ish at formation, recurving out to about 34°
  const lat = (0.21 + 0.38 * Math.pow(age, 1.7)) * sys.hemi;
  // carried west by the trades, then east again once it is in the westerlies
  const lon = sys.lon0 - 0.95 * age + 1.7 * Math.pow(age, 3);
  return dirFromLatLon(lat, lon, out);
}

/**
 * How tightly the rainbands are wound: `theta = base - hemi * WIND * ln(r/eye)`.
 * Hoisted out of buildTyphoon because advect needs the same number to work
 * out which way an arm is running at a nodule, and two copies of a shape
 * constant is how the cotton ends up combed across its own arms.
 */
const CYCLONE_WIND = 3.1;

function buildTyphoon(sys: TyphoonSystem, rand: () => number, out: Nodule[]): void {
  const arms = 5;
  const params = CLOUD_TYPE_PARAMS.typhoon;

  // The eyewall: a dense, unbroken ring right at the eye's edge. This is
  // the single feature that makes the whole thing read as a cyclone rather
  // than as a patch of bad weather, so it is packed tight enough that the
  // nodules touch and the hole in the middle stays a clean hole.
  const wallCount = 56;
  for (let i = 0; i < wallCount; i++) {
    const theta = (i / wallCount) * Math.PI * 2;
    const r = sys.eye * (1.0 + rand() * 0.16);
    out.push(pushSpiralNodule(sys, r, theta, 1, 0, rand, params));
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
      const theta = base - sys.hemi * CYCLONE_WIND * Math.log(r / sys.eye);
      if (f > 0.8 && rand() < (f - 0.8) * 2.6) continue;
      const across = 3 - Math.floor(f * 2);
      for (let c = 0; c < across; c++) {
        // An arm is a ridge with a crest, not a rope of equal beads: the
        // nodule on the centreline of the arm is the mass and the ones
        // flanking it are shoulders, exactly as in a band (buildCloudBand).
        // Ranking them costs nothing and is most of what stops 500 eyewall
        // and rainband nodules — two thirds of every nodule on the planet —
        // reading as one grain size.
        const rank = Math.abs(c - (across - 1) / 2);
        out.push(
          pushSpiralNodule(
            sys,
            r * (1 + ((c - (across - 1) / 2) * 0.05 + (rand() - 0.5) * 0.03)),
            theta + (rand() - 0.5) * 0.12,
            1 - f * 0.6,
            rank,
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
  rank: number,
  rand: () => number,
  params: CloudTypeParams,
): Nodule {
  const long = 1.2 + rand() * (params.drawOut - 1.2);
  const n = makeNodule(new THREE.Vector3(0, 1, 0), {
    hover: params.hoverBase + bulk * params.hoverBulk + rand() * 0.03 - rank * 0.012,
    size:
      (params.sizeBase + bulk * params.sizeBulk) *
      Math.pow(0.72, rank) *
      (0.78 + rand() * rand() * 1.0),
    // A cyclone nodule's grain direction is resolved every frame from the
    // arm it is sitting on (the whole system rotates and travels, so no
    // baked bearing survives), and all this field carries for it is which
    // way round to lay the lump: `bearingCos` comes out as exactly +1 or -1
    // and advect multiplies the arm tangent by it. Without that every fibre
    // in the storm points its fat end the same way round the eye.
    bearing: rand() < 0.5 ? 0 : Math.PI,
    sx: long,
    sy: 0.9 + rand() * 0.3,
    sz: drawnOut(long) * (0.88 + rand() * 0.26),
    band: sys.band,
  });
  n.spiral = { radius: r, theta };
  return n;
}

export interface CloudSystem {
  group: THREE.Group;
  tick: (t: number) => void;
  /**
   * Cloud cover at t = 0 as an equirectangular map, for casting shadows on
   * the globe without a shadow map. Red is coverage. Green carries this
   * row's drift rate, so the shader can advect the lookup by the same law
   * the nodules themselves move under (see buildCloudShadowTexture).
   */
  shadowTexture: THREE.DataTexture;
  /** decodes the green channel: omega = (g - 0.5) * omegaScale */
  omegaScale: number;
}

/**
 * GLSL shared by every surface that reads the baked cloud-shadow map:
 * the globe, the ocean, and (G55) the cloud deck's own self-shading —
 * moved here rather than left beside the globe material in main.ts so
 * the deck that owns the texture also owns the one function that decodes
 * it, and nothing downstream re-derives the encoding by hand.
 */
export const CLOUD_SHADOW_GLSL = `
  // Raw coverage, 0..1, at this point right now — same lookup cloudShade
  // itself uses, pulled out so a caller that wants the coverage number
  // (G38's fresh snow, below) rather than a pre-shaded multiplier does
  // not have to hand-transcribe the lat/lon/drift decode a third time.
  float cloudCoverAt(vec3 objNormal) {
    float lat = asin(clamp(objNormal.y, -1.0, 1.0));
    float v = lat / 3.14159265 + 0.5;
    // green is row-constant: this latitude's drift rate, encoded
    float omega = (texture2D(uCloudShadow, vec2(0.5, v)).g - 0.5) * uOmegaScale;
    float lon = atan(objNormal.z, -objNormal.x);
    // a nodule now at this longitude started at lon - omega*t
    float u = (lon - omega * uCloudTime) / 6.28318530718 + 0.5;
    return texture2D(uCloudShadow, vec2(fract(u), v)).r;
  }

  float cloudShade(vec3 objNormal, float strength) {
    return 1.0 - cloudCoverAt(objNormal) * strength;
  }

  // How wet the ground here is, 0..1.
  //
  // The blue channel of the same map marks the cells that have rain
  // falling out of them, so this is one more fetch of a texture already
  // being sampled and no new state anywhere. Read a little *ahead* of
  // where the cell is now — the lookup is offset against the drift — so
  // the dark patch trails out from under the storm rather than sitting
  // exactly beneath it: ground that has just been rained on, which is
  // what is actually visible from outside. Under the cell itself the
  // shade is doing the work anyway.
  float rainWet(vec3 objNormal) {
    float lat = asin(clamp(objNormal.y, -1.0, 1.0));
    float v = lat / 3.14159265 + 0.5;
    float omega = (texture2D(uCloudShadow, vec2(0.5, v)).g - 0.5) * uOmegaScale;
    float lon = atan(objNormal.z, -objNormal.x);
    float u = (lon - omega * uCloudTime) / 6.28318530718 + 0.5;
    // one and a half cell-widths downwind, in the direction the deck came
    // from — sign carried by omega so it works in both wind belts
    float trail = sign(omega) * 0.022;
    return texture2D(uCloudShadow, vec2(fract(u + trail), v)).b;
  }
`;

/**
 * Bake the cloud deck into a map the globe can read as shade.
 *
 * Shadow mapping is off in this project and staying off — it was the
 * isolated cause of a crash on a real device (see renderer.shadowMap in
 * main.ts). But a sky with no shadow under it is the single loudest
 * "this is a render" cue left in the frame: the sea is lit identically
 * whether there is a cloud over it or not.
 *
 * What makes a cheap fake work here is that the clouds move by a closed
 * form rather than by simulation. A nodule's longitude at time t is just
 * `lon + zonalOmega(lat) * t`, and the cloud group is a child of the globe,
 * so in the globe's own object space that is the entire motion. Bake the
 * deck once, then offset the lookup per-latitude by the same expression,
 * and the shade tracks the cotton above it for free — no render target, no
 * second pass, one texture fetch.
 *
 * The drift rate goes in the green channel rather than into a uniform array
 * or a re-implementation of the wind profile in GLSL, because a second copy
 * of that profile is exactly the split this file already had to undo for
 * the ash plumes. It varies only with latitude, so a row-constant channel
 * carries it exactly.
 */
function buildCloudShadowTexture(
  nodules: Nodule[],
  isRaining: (n: Nodule) => boolean,
  radius: number,
  width: number,
  height: number,
): { texture: THREE.DataTexture; omegaScale: number } {
  const data = new Uint8Array(width * height * 4);

  let maxOmega = 1e-6;
  for (let py = 0; py < height; py++) {
    const lat = ((py + 0.5) / height - 0.5) * Math.PI;
    maxOmega = Math.max(maxOmega, Math.abs(zonalOmega(lat)));
  }
  const omegaScale = maxOmega * 2;

  for (let py = 0; py < height; py++) {
    const lat = ((py + 0.5) / height - 0.5) * Math.PI;
    const g = Math.round((zonalOmega(lat) / omegaScale + 0.5) * 255);
    for (let px = 0; px < width; px++) {
      data[(py * width + px) * 4 + 1] = g;
      data[(py * width + px) * 4 + 3] = 255;
    }
  }

  nodules.forEach((n) => {
    // Cyclone nodules live in their storm's own moving frame, not at a
    // fixed lon/lat drifting with the band, so the closed form above does
    // not describe them and they are left out. One typhoon's missing
    // shadow is a far smaller error than a shadow sliding across the sea
    // with no cloud over it.
    if (n.spiral) return;

    // The blob is stamped round, so a drawn-out nodule is credited with the
    // radius of a circle of the same footprint area rather than with its
    // length. Stamping the length would put a shadow on the sea wider than
    // anything above it in three quarters of the directions you could look
    // from; stamping `size` unchanged, now that the average nodule covers
    // more ground than the sphere it replaced, would leave the deck's shade
    // visibly lighter than the deck.
    const raining = isRaining(n);
    const angular = (n.size * Math.sqrt(n.sx * n.sz)) / radius;
    const v = (n.lat / Math.PI + 0.5) * height;
    const u = (n.lon / (Math.PI * 2) + 0.5) * width;
    const rY = (angular / Math.PI) * height;
    // equirectangular stretches longitude toward the poles
    const rX = rY * (width / height) / Math.max(Math.cos(n.lat), 0.12);

    const y0 = Math.max(0, Math.floor(v - rY));
    const y1 = Math.min(height - 1, Math.ceil(v + rY));
    const x0 = Math.floor(u - rX);
    const x1 = Math.ceil(u + rX);

    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const dx = (px + 0.5 - u) / rX;
        const dy = (py + 0.5 - v) / rY;
        const d2 = dx * dx + dy * dy;
        if (d2 >= 1) continue;
        // soft-edged: a hard disc reads as a paper cut-out, and the cotton
        // casting it does not have a hard edge either
        const fall = (1 - d2) * (1 - d2);
        const wrapped = ((px % width) + width) % width;
        const i = (py * width + wrapped) * 4;
        data[i] = Math.min(255, data[i] + fall * 190);
        // Blue: the same stamp again, but only for the cells that have
        // rain falling out of them. The globe reads it as wet ground (see
        // the map_fragment patch in main.ts) — the shade says "there is a
        // cloud over this", the third channel says "and it is raining on
        // it", off one texture fetch the sky was already paying for.
        if (raining) data[i + 2] = Math.min(255, data[i + 2] + fall * 210);
      }
    }
  });

  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return { texture, omegaScale };
}

/**
 * @param season the globe's own season clock, −1 northern midwinter ..
 *   +1 northern midsummer — shared by reference, exactly as the falling
 *   snow takes it, so the sky cannot drift out of step with the paint.
 * @param sunDirection world-space direction to the key light, read live
 *   each frame for G41's rainbow (a sunlit shaft gets one, a shaft rained
 *   on under an overcast sky does not) — same optional-parameter shape as
 *   traffic.ts's running lights, which need the identical day/night test.
 * @param bumpHeight the same terrain displacement scale species.ts and
 *   eruptions.ts use (main.ts's BUMP_HEIGHT) — every nodule's hover is a
 *   clearance *above the actual ground* under it, not above the idealised
 *   sea-level sphere `radius` alone describes, or a low-hovering type over
 *   a mountain range or the tall forest standing on it sat inside/below
 *   the terrain and the canopy instead of above both.
 */
export function buildClouds(
  radius: number,
  season: { uSeasonTilt: { value: number } },
  sunDirection?: THREE.Vector3,
  bumpHeight = 0,
): CloudSystem {
  const group = new THREE.Group();
  const rand = mulberry32(4242);

  // where the weather systems sit
  //
  // Was cut to 6 chasing a crash that turned out to be shadow mapping,
  // not scene weight (see SETTINGS/shadowMap.enabled in main.ts) —
  // restored most of the way back now that shadows are off there.
  const seeds: { dir: THREE.Vector3; type: CloudType }[] = [];
  const dir = new THREE.Vector3();

  // Latitude *quota*, not a flat rejection roll over the whole sphere.
  //
  // The previous version sampled a direction uniformly (fine — that is
  // area-correct) and then kept it with probability `cloudinessFor(zonal,
  // y)`, i.e. the raw wetness at that latitude, checked against a single
  // shared budget of 10 seeds. That reads as "fair" but is not: wetness is
  // sharply peaked at the ITCZ (`zonalPrecipitationAt` — see its own
  // comment), so the equator's acceptance odds are several times the
  // storm track's and the better part of an order of magnitude the polar
  // cirrus belt's. With one shared pool of attempts, the equatorial ring
  // fills up (bands there only need to clear each other by ~47°, so a
  // dozen fit around it) long before enough low-probability high-latitude
  // draws land — the visible result was every band strung around the
  // equator in a single ring, i.e. "clouds form in one line".
  //
  // Fixing it means the thing that was implicit (how many seeds does each
  // latitude regime get) has to become explicit. Six zones, mirrored across
  // the equator, each with its own attempt budget and slot count — the
  // wetness roll still decides *whether* a given candidate in a zone is
  // kept (so a bone-dry stretch of storm track can still come up emptier
  // than a wet one), but a dry zone can no longer be crowded out of
  // existing at all by a wetter one elsewhere on the planet.
  // Raised again now that most types are small clusters rather than huge
  // bands (see CloudTypeParams.layout below): the old counts were sized
  // for a sky made of a handful of enormous systems, and produced a
  // visibly sparse, empty-looking sky once cumulus/storm shrank to their
  // real proportions. More, smaller systems is the actual fix for "clouds
  // form in one line" reading as one shape everywhere — a scattered field
  // needs enough members to look like a field.
  // Roughly tripled on request ("雲の数3倍くらいにできないか"), but not
  // uniformly: a flat 3x on every zone would have tripled the polar cap
  // too, and a follow-up request ("雲は高緯度で多くなりすぎるならバラン
  // ス考えて") asked for exactly the opposite there. The multiplier tapers
  // from 3x at the equator down to 2x at the poles, so the increase is
  // felt most where cloud cover is naturally densest on a real planet
  // (the ITCZ, the mid-latitude storm track) and least where a thin,
  // sparse deck is the realistic look to keep (the polar cap).
  const LATITUDE_ZONES: { loDeg: number; hiDeg: number; slots: number }[] = [
    { loDeg: 0, hiDeg: 12, slots: 9 }, // ITCZ core (3 -> 9, 3x)
    { loDeg: 12, hiDeg: 30, slots: 9 }, // tropics / subtropical fringe (3 -> 9, 3x)
    { loDeg: 30, hiDeg: 55, slots: 8 }, // mid-latitude storm track (3 -> 8, ~2.7x)
    { loDeg: 55, hiDeg: 78, slots: 4 }, // sub-polar (2 -> 4, 2x)
    { loDeg: 78, hiDeg: 90, slots: 2 }, // polar cap (1 -> 2, 2x)
  ];
  // Tightened from 0.68 (~47°): that spacing was sized to keep the old
  // huge bands (up to 72° of arc) from overlapping, but it also capped how
  // many systems could ever fit on the planet at once — at 47° apart, a
  // single latitude circle can hold at most seven or eight. Now that most
  // types are compact clusters and the remaining bands are a third their
  // old length, systems can sit closer without touching.
  const MIN_SEPARATION_DOT = 0.9; // ~26°

  for (const zone of LATITUDE_ZONES) {
    for (const hemi of [1, -1]) {
      let placed = 0;
      for (let attempt = 0; attempt < 400 && placed < zone.slots; attempt++) {
        // uniform in sin(latitude) within this zone's band, so the zone
        // itself is not biased toward its own equatorward edge
        const sinLo = Math.sin((zone.loDeg * Math.PI) / 180);
        const sinHi = Math.sin((zone.hiDeg * Math.PI) / 180);
        const z = hemi * (sinLo + rand() * (sinHi - sinLo));
        const t = rand() * Math.PI * 2;
        const r = Math.sqrt(Math.max(0, 1 - z * z));
        dir.set(r * Math.cos(t), z, r * Math.sin(t));
        if (cloudDensityAt(dir) < 0.16) continue; // only inside a weather patch

        // Wetness still gates *within* the zone, so a parched stretch of an
        // otherwise-wet zone (e.g. the Sahara's own latitude band) is less
        // likely to draw a seed than a monsoon stretch at the same
        // latitude — the last third of the attempt budget relaxes the
        // gate so a truly dry zone still ends up with *something* rather
        // than standing empty for lack of a lucky roll, matching the
        // original design note that the horse latitudes should get "very
        // few" bands, not zero.
        const zonal = zonalPrecipitationAt(dir.y);
        const wet = cloudinessFor(zonal, dir.y);
        const relaxed = attempt > 260;
        if (!relaxed && rand() > wet) continue;
        if (seeds.some((s) => s.dir.dot(dir) > MIN_SEPARATION_DOT)) continue;

        // Type follows the climate the band lives in rather than a
        // latitude ladder, so the same rainfall field decides both how
        // much cloud there is and what it is made of. Thunderheads need
        // heat *and* water, so they are the tropics' wet bands only; the
        // mid-latitude storm track is where sheets of stratus belong; the
        // dry, cold, high latitudes get cirrus, which is the one type that
        // is ice rather than rain.
        const lat = Math.abs(dir.y);
        let type: CloudType;
        const roll = rand();
        if (lat < 0.35) type = roll < 0.15 + 0.5 * wet ? 'storm' : 'cumulus';
        else if (lat < 0.72) type = roll < 0.2 + 0.4 * wet ? 'stratus' : 'cumulus';
        else type = roll < 0.7 - 0.4 * wet ? 'cirrus' : 'stratus';

        seeds.push({ dir: dir.clone(), type });
        placed++;
      }
    }
  }

  const nodules: Nodule[] = [];
  const bandType: CloudType[] = [];
  seeds.forEach((seed, band) => {
    bandType.push(seed.type);
    const params = CLOUD_TYPE_PARAMS[seed.type];
    if (params.layout === 'cluster') {
      buildCloudCluster(seed.dir, band, params, rand, nodules);
    } else {
      buildCloudBand(seed.dir, band, params, rand, nodules);
    }
  });

  // One cyclone, not two. A pair (one per hemisphere) meant that at almost
  // any moment there was a hurricane somewhere on the planet, and a storm
  // that is always present is scenery rather than an event — which is the
  // opposite of the reason for building it. One, with long quiet gaps
  // between its lives, is a thing you notice when it happens.
  //
  // `lon0` used to be a free `rand() * TAU`, i.e. genesis anywhere on the
  // planet — which is how a cyclone ended up parked over Egypt. Real
  // tropical cyclones only spin up over warm open ocean, and `typhoonCentre`
  // carries the system west then recurves it east over the back half of its
  // life (see the -0.95*age + 1.7*age^3 term there), so it is not just the
  // genesis point that has to be water: the whole swept longitude range —
  // roughly [lon0-16°, lon0+43°] — needs to be. Picking from a short table
  // of the real basins (genesis point + hemisphere) is the same fix already
  // used for the erg placement (G6, ergAt) and the ocean currents (G18):
  // tie a field to real coordinates instead of leaving it free.
  const basin = TYPHOON_BASINS[Math.floor(rand() * TYPHOON_BASINS.length)];
  const typhoons: TyphoonSystem[] = [basin].map((b) => ({
    band: seeds.length,
    lon0: lonFromRealDeg(b.lonDeg) + (rand() - 0.5) * 0.3,
    hemi: b.hemi,
    period: 210 + rand() * 60,
    phase: rand() * 0.15,
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

  // Ground clearance, on request ("雲が低すぎて木にかぶる"). Every hover
  // value above was set as a clearance over the idealised sea-level sphere
  // (`radius` alone) — fine over open ocean, where the ground really is at
  // that radius, but stratus's hoverBase (0.09) and even cumulus's (0.16)
  // sit well *below* a real mountain range or a tall forest canopy, both of
  // which push the actual ground surface up by as much as bumpHeight
  // (0.36 in main.ts's own units). A cloud's hover has to clear the ground
  // *under* it, not the sphere the ground is displaced from, so every
  // nodule's hover is raised here by that same local displacement —
  // exactly the number species.ts and eruptions.ts already add to `radius`
  // for the same reason when seating a tree or a volcano vent.
  if (bumpHeight > 0) {
    const groundDir = new THREE.Vector3();
    for (const n of nodules) {
      dirFromLatLon(n.lat, n.lon, groundDir);
      n.hover += sampledHeight(groundDir).display * bumpHeight;
    }
  }

  // each band breathes (grows/shrinks) on its own slow cycle, standing in
  // for forming and dissipating without ever changing instance counts
  const bandBreathPhase = bandType.map(() => rand() * Math.PI * 2);
  const bandBreathSpeed = bandType.map(() => 0.06 + rand() * 0.05);
  // how far this band's flow is displaced by the current meander, and where
  // in that meander it sits — a per-band phase keeps neighbouring bands from
  // snaking in lockstep
  const bandMeanderPhase = bandType.map(() => rand() * Math.PI * 2);

  // Two, not three, and the change is a draw-call ledger rather than a taste
  // one. Variants used to be handed out by band (`n.band % count`), which
  // meant a cloud was sixty copies of one mesh and — because the three
  // buckets were indexed by band number and there were never bands to fill
  // all three — only two of the three geometries were ever used anyway. The
  // planet was measurably paying for three shapes and rendering two, in
  // twelve draw calls. Interleaving the buckets per nodule (see below) puts
  // a different silhouette next to every lump, but it also *fills* the third
  // bucket, and a filled bucket is a fourteenth draw call. Two shapes with
  // both of them inside every cloud beats three shapes with one per cloud,
  // and it costs exactly what the old arrangement cost.
  //
  // If a third is ever wanted back, the way to pay for it is to give all the
  // regular nodules one shared *halo* geometry — the halo is a 1.32x blob at
  // 0.13 opacity and cannot be told apart between variants — which frees two
  // calls. It is not done here because the halo scheme is tuned and the
  // failure it fixed (a grey ring round every lump) is the worst artifact
  // this sky has had; it is not something to disturb for a third potato.
  const regularVariantCount = 2;
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

  const instanceMatrix = new THREE.Matrix4();
  const binormal = new THREE.Vector3();
  const rainAxis = new THREE.Vector3();
  const rainSide = new THREE.Vector3();

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

  // The variant a nodule gets is chosen per *nodule*, not per band.
  //
  // It used to be `n.band % regularVariantCount`, which meant every lump in
  // a given cloud was literally the same mesh, repeated sixty times with
  // nothing but a rotation and a scale between the copies. That is a large
  // part of why the deck read as manufactured however the sizes were
  // distributed: the repetition is visible at a glance even when you cannot
  // say what it is you are seeing.
  let variantCursor = 0;
  nodules.forEach((n) => {
    const type = bandType[n.band];
    if (type === 'storm' || type === 'typhoon') {
      // Storm cells stay grouped by band, and have to: each band owns a
      // material so its lightning can flicker alone (see stormBands below),
      // so splitting one across three geometries would cost three draw calls
      // per storm instead of one.
      const list = stormNodulesByBand.get(n.band) ?? [];
      list.push(n);
      stormNodulesByBand.set(n.band, list);
    } else if (type === 'stratus') {
      stratusNodules.push(n);
    } else if (type === 'cirrus') {
      cirrusNodules.push(n);
    } else {
      regularByVariant[variantCursor++ % regularVariantCount].push(n);
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

  // ---- rain ----
  //
  // Until now nothing on this planet has ever fallen out of a cloud. The
  // storm cells flickered with lightning over ground that stayed dry, and
  // §2-6's complaint — "there is not one line of rain in this project" —
  // outlived every other item on its list.
  //
  // A shaft, not drops. At this scale individual drops are invisible and
  // drawing them as streaks would be the most CG thing in the frame; what
  // reads from across a room is the *veil* under a cell, a hank of fine
  // fibre hanging off the cloud base and splaying as it falls. That is one
  // open-ended cone per cell and one draw call for the whole planet.
  //
  // Only storm and cyclone cells get one, and only where the rainfall map
  // says rain belongs, read at the cell's drifted position exactly as the
  // cotton above it is: a thunderhead crossing the Sahara arrives with its
  // veil already shut. Which is the causal direction §3 asks for — the
  // same field decides the cloud, its type, its size, and now what falls
  // out of it, instead of five systems each guessing.
  const rainAnchors: Nodule[] = [];
  {
    // Every fifth storm nodule, and each veil narrower than the lump it
    // hangs from. Both numbers were set by looking: a veil per nodule at
    // the lump's own width (the first attempt) is sixty overlapping cones
    // whose alpha builds into one flat grey wash lying on the sea — the
    // storm looked like it had spilled something rather than like it was
    // raining. Rain reads as rain when you can see between the shafts.
    let cursor = 0;
    nodules.forEach((n) => {
      const type = bandType[n.band];
      if (type !== 'storm' && type !== 'typhoon') return;
      if (cursor++ % 5 !== 0) return;
      rainAnchors.push(n);
    });
  }

  const rainStrength = new Float32Array(rainAnchors.length);
  // G41: 0 in shadow, 1 in direct sun — a rainbow needs both the rain and
  // the sun at once, so this is what gates the tint in the fragment shader
  // below. Updated every frame in tick() the same way traffic.ts's running
  // lights are (a live dot product against the world-space sun direction),
  // not baked, because a cell drifts across the whole day/night cycle over
  // its lifetime.
  const rainSunlit = new Float32Array(rainAnchors.length);
  const rainGeometry = new THREE.CylinderGeometry(0.42, 1, 1, 6, 1, true);
  rainGeometry.setAttribute(
    'aStrength',
    new THREE.InstancedBufferAttribute(rainStrength, 1),
  );
  rainGeometry.setAttribute(
    'aSunlit',
    new THREE.InstancedBufferAttribute(rainSunlit, 1),
  );
  const rainMaterial = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    transparent: true,
    depthWrite: false,
    // Both faces: a cone this thin is seen through, and culling its back
    // wall makes the near side of the veil noticeably lighter than the far
    // side of the one next to it.
    side: THREE.DoubleSide,
    vertexShader: `
      attribute float aStrength;
      attribute float aSunlit;
      uniform float uTime;
      varying float vStrength;
      varying float vSunlit;
      varying vec2 vFall;
      varying float vY;
      void main() {
        vStrength = aStrength;
        vSunlit = aSunlit;
        // uv.y runs 0 at the bottom of the cone to 1 at the top; uv.x goes
        // round it. The fall is a scroll in y, so the fibres read as
        // moving water rather than as a static cone — kept separate from
        // vY, which has to stay put because it says where on the shaft
        // this fragment is.
        vY = uv.y;
        vFall = vec2(uv.x, uv.y + uTime * 0.55);
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying float vStrength;
      varying float vSunlit;
      varying vec2 vFall;
      varying float vY;
      void main() {
        if (vStrength <= 0.002) discard;
        // Vertical striation. Two frequencies that do not divide into each
        // other, so the veil never resolves into a comb of even stripes —
        // the failure the cloud grain had to be rescued from.
        float streak =
          0.55 +
          0.3 * sin(vFall.x * 44.0 + vFall.y * 9.0) +
          0.15 * sin(vFall.x * 17.0 - vFall.y * 21.0);
        // Attached at the top, gone before the bottom. Rain that arrives
        // at the ground in a hard line reads as a rod holding the cloud
        // up, which is the one thing a globe on a stand cannot afford.
        float fade = smoothstep(0.04, 0.45, vY);
        vec3 rainColor = vec3(0.62, 0.66, 0.72);
        // G41: a rainbow, simplified rather than chasing the real 42-
        // degree antisolar geometry — on a shaft this small that cone
        // would almost never land in the camera's current view, which is
        // exactly the "shipped an effect nobody ever sees" failure
        // gap-analysis §2-21 hit chasing real lightning bolts at this
        // scale. Instead: any sunlit shaft gets a faint spectrum band
        // low in the veil, which is where backlit rain actually shows
        // color from outside — a stylised but always-visible stand-in
        // for the real optics, the same trade this file already makes
        // for the shaft itself (a cone standing in for individual drops).
        float bowBand = smoothstep(0.1, 0.24, vY) * (1.0 - smoothstep(0.3, 0.5, vY)) * vSunlit;
        vec3 spectrum = 0.5 + 0.5 * cos(6.2831 * (vFall.x * 2.0 + vec3(0.0, 0.33, 0.67)));
        rainColor = mix(rainColor, spectrum, bowBand * 0.55);
        gl_FragColor = vec4(rainColor, vStrength * streak * 0.3 * fade);
      }
    `,
  });
  const rainMesh = new THREE.InstancedMesh(rainGeometry, rainMaterial, Math.max(1, rainAnchors.length));
  rainMesh.count = rainAnchors.length;
  rainMesh.frustumCulled = false;
  if (rainAnchors.length > 0) group.add(rainMesh);

  // Scratch objects for the per-frame advection, hoisted out of the loop:
  // this runs over every nodule on the planet each frame, and allocating a
  // vector per nodule per frame is exactly the kind of thing that turns a
  // free update into garbage-collection stutter.
  const centre = new THREE.Vector3();
  const east = new THREE.Vector3();
  const north = new THREE.Vector3();
  const frameEast = new THREE.Vector3();
  const frameNorth = new THREE.Vector3();

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
        const r = n.spiral!.radius * (0.4 + sys.intensity * 0.6);
        // Differential rotation: the eyewall goes round several times for
        // each turn of the outer rainbands, which is what winds the arms
        // tighter over time instead of spinning a rigid pinwheel. A
        // cyclone turns anticlockwise seen from above in the north and
        // clockwise in the south, hence the hemisphere sign.
        const omega = (sys.spin / (0.45 + r / sys.reach)) * -sys.hemi;
        const theta = n.spiral!.theta + omega * t;
        const tangentX = Math.cos(theta);
        const tangentZ = Math.sin(theta);
        const sr = Math.sin(r);
        const cr = Math.cos(r);
        n.live
          .copy(centre)
          .multiplyScalar(cr)
          .addScaledVector(north, sr * tangentX)
          .addScaledVector(east, sr * tangentZ)
          .normalize();
        // Which way the arm is running here.
        //
        // A cyclone's cotton has to be combed *along its own arms*, and no
        // bearing baked at build time can say that: the system rotates
        // differentially and its centre travels, so an arm sweeps through
        // every compass direction over a storm's life. It is closed form
        // though. Differentiating the logarithmic spiral
        // `theta = base - hemi*CYCLONE_WIND*ln(r/eye)` gives
        // `r * dtheta/dr = -hemi*CYCLONE_WIND`, so the tangent is one part
        // radial to CYCLONE_WIND parts azimuthal — about 18 degrees off
        // circular, which is exactly the shallow lean a real rainband has.
        // The eyewall ring comes out of the same expression as very nearly
        // azimuthal, which is what turns 56 separate lumps into a wall.
        const w = -sys.hemi * CYCLONE_WIND;
        n.grain
          .copy(centre)
          .multiplyScalar(-sr)
          .addScaledVector(north, cr * tangentX - w * tangentZ)
          .addScaledVector(east, cr * tangentZ + w * tangentX)
          .normalize()
          // +1 or -1: which end of the lump leads (see pushSpiralNodule)
          .multiplyScalar(n.bearingCos);
        // Forming and dissipating are changes in *organisation*, not in
        // the size of the cloud a storm is made of.
        //
        // Scaling every nodule straight down by intensity was the obvious
        // thing and it looked wrong in a very specific way: the arms
        // stayed exactly where they were and simply got thin, so a
        // weak storm was a set of long skinny blades radiating from a
        // hub — a desk fan. What actually happens is that a cyclone
        // starts as a compact disorganised cluster and *spreads* as it
        // spins up, opening its eye on the way. Pulling the spiral in
        // toward its own centre at low intensity, while keeping the
        // cotton nearly full size, gets that.
        // Between lives the storm is not there at all. Intensity 0 left it
        // at 0.6 of full size, which only stayed off screen because the
        // centre was NaN (see typhoonCentre); with that fixed it has to be
        // folded away here instead.
        n.liveScale = age < 0 ? 0 : 0.6 + sys.intensity * 0.4;
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
      // Resolve the stored compass bearing into a world direction here, at
      // wherever the nodule has drifted to. Two cos/sin were already spent
      // on this bearing at build time (Nodule.bearingCos), so this is four
      // multiplies and no trigonometry — cheaper than the setFromAxisAngle
      // the old per-instance spin cost, and done once per nodule instead of
      // once per nodule per layer.
      if (tangentFrame(n.live, frameEast, frameNorth)) {
        n.grain
          .copy(frameNorth)
          .multiplyScalar(n.bearingCos)
          .addScaledVector(frameEast, n.bearingSin);
      } else {
        // directly over a pole, where a bearing means nothing; any tangent
        n.grain.set(1, 0, 0).addScaledVector(n.live, -n.live.x).normalize();
      }
      // Breathing, times what the ground below is entitled to (see
      // coverageFor). Read at `n.live`, i.e. after the drift, and against
      // the season the rest of the globe is in — so a monsoon band over
      // the Sahel is cotton in July and a fray in January, out of phase
      // with the Mediterranean band at the same longitude, because
      // `precipitationAtSeason` carries the Köppen second letter.
      const breath = 1 + Math.sin(t * bandBreathSpeed[n.band] + bandBreathPhase[n.band]) * 0.09;
      n.liveScale = breath * coverageFor(precipitationAtSeason(n.live, season.uSeasonTilt.value), n.live.y);
    });
  };

  // G41: same construction as traffic.ts's running lights — this group's
  // own world quaternion, fetched once a frame, turns a cell's object-
  // space direction into the world-space one the (world-space) sun
  // direction can be dotted against.
  const cloudsQuat = new THREE.Quaternion();
  const rainWorldPos = new THREE.Vector3();

  // G55: layers. coreMaterial's own self-shadow reads uCloudTime the same
  // way the globe and ocean already do, but it is this uniform's own
  // object rather than main.ts's cloudShadowUniforms — the deck knows its
  // own clock before main.ts has anywhere to plug it in (buildClouds has
  // not returned yet), and there is no reason for two different systems
  // to share one mutable value when each already owns the time it ticks on.
  const selfShadowTime = { value: 0 };

  const tick = (t: number) => {
    selfShadowTime.value = t;
    advect(t);

    // Rain, hung under whichever storm cells are currently over ground the
    // rainfall map says gets rain.
    //
    // Trailing downwind of its cell rather than hanging from the middle of
    // it, which is the difference between rain that can be seen and rain
    // that cannot. From outside a globe the cotton is directly between the
    // eye and its own rain in every view except at the limb, so a shaft
    // under the centre of a cell is occluded by that cell nearly all the
    // time — the first version of this was invisible everywhere but the
    // edge of the disc, and only a debug pass in flat magenta showed that
    // it had been drawing correctly the whole time. Real rain trails
    // downwind under shear anyway, so leaning the shaft along the cell's
    // own grain and setting its foot out past the lump's skirt is both the
    // truer picture and the visible one.
    if (rainAnchors.length > 0) {
      rainMaterial.uniforms.uTime.value = t;
      if (sunDirection) group.getWorldQuaternion(cloudsQuat);
      rainAnchors.forEach((n, i) => {
        const wet = precipitationAtSeason(n.live, season.uSeasonTilt.value);
        // Rain needs a cloud *and* a reason. `liveScale` already carries
        // both the cell's breathing and, for a cyclone, whether the storm
        // exists at all this minute — a dissipated system stops raining
        // because its cotton has gone, not because of a second rule.
        const strength = THREE.MathUtils.smoothstep(wet, 0.3, 0.72) * Math.min(1, n.liveScale);
        rainStrength[i] = strength;
        if (sunDirection) {
          rainWorldPos.copy(n.live).applyQuaternion(cloudsQuat);
          const sun = rainWorldPos.dot(sunDirection);
          rainSunlit[i] = THREE.MathUtils.clamp((sun - 0.05) / 0.2, 0, 1);
        }
        if (strength <= 0.002) {
          instanceMatrix.makeScale(0, 0, 0);
          rainMesh.setMatrixAt(i, instanceMatrix);
          return;
        }
        const d = n.live;
        // Leaning downwind, and its own orthonormal frame around that
        // lean. The cone is radially symmetric, so any two axes across it
        // will do as long as they are perpendicular to the lean.
        rainAxis.copy(d).addScaledVector(n.grain, 0.4).normalize();
        rainSide.crossVectors(rainAxis, n.grain).normalize();
        binormal.crossVectors(rainSide, rainAxis);
        // From the cloud base to the ground, splaying out past the lump
        // it falls from.
        //
        // Wider at the foot than the cotton above it is the only way a
        // veil is ever seen at all: looking at a globe from outside, the
        // cloud is directly between the eye and its own rain everywhere
        // except at the limb, and a shaft narrower than its cloud is
        // occluded by it in every view. Splayed, it reads in profile at
        // the edge of the disc — which is exactly where rain is visible
        // on a real globe too.
        const top = radius + n.hover;
        const length = n.hover;
        const width = n.size * n.liveScale * 1.25;
        const p = top - length * 0.5;
        // out from under its own cloud, downwind
        const off = n.size * n.liveScale * 1.15;
        const cx = d.x * p + n.grain.x * off;
        const cy = d.y * p + n.grain.y * off;
        const cz = d.z * p + n.grain.z * off;
        instanceMatrix.set(
          rainSide.x * width, rainAxis.x * length, binormal.x * width, cx,
          rainSide.y * width, rainAxis.y * length, binormal.y * width, cy,
          rainSide.z * width, rainAxis.z * length, binormal.z * width, cz,
          0, 0, 0, 1,
        );
        rainMesh.setMatrixAt(i, instanceMatrix);
      });
      rainMesh.instanceMatrix.needsUpdate = true;
      rainGeometry.getAttribute('aStrength').needsUpdate = true;
      if (sunDirection) rainGeometry.getAttribute('aSunlit').needsUpdate = true;
    }

    liveMeshes.forEach(({ mesh, list, sizeScale }) => {
      list.forEach((n, i) => {
        // The instance basis, written straight out rather than composed from
        // a pair of quaternions.
        //
        // This used to be `setFromUnitVectors(up, dir)` for the standing-up
        // and `setFromAxisAngle(dir, spin)` for the twist, multiplied
        // together and run through Object3D.compose. That is two quaternion
        // constructions, a quaternion product and a full TRS compose per
        // instance per frame — and, worse, the frame it produced had a
        // position-dependent twist baked into it, which is what made
        // build-time combing decay as clouds drifted (see Nodule.bearing).
        // The three axes are known directly: local +Y is the surface normal,
        // local +X is the grain advect already resolved, and +Z closes the
        // right-handed set. Both are unit and perpendicular by construction,
        // so one cross product finishes it.
        const d = n.live;
        const g = n.grain;
        binormal.crossVectors(g, d);
        const s = n.size * sizeScale * n.liveScale;
        const ex = s * n.sx;
        // the 0.8 is the squash every nodule has always had on top of the
        // one already baked into its geometry; sy is the per-instance part
        const ey = s * 0.8 * n.sy;
        const ez = s * n.sz;
        const p = radius + n.hover;
        instanceMatrix.set(
          g.x * ex, d.x * ey, binormal.x * ez, d.x * p,
          g.y * ex, d.y * ey, binormal.y * ez, d.y * p,
          g.z * ex, d.z * ey, binormal.z * ez, d.z * p,
          0, 0, 0, 1,
        );
        mesh.setMatrixAt(i, instanceMatrix);
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

  // 512x256 is plenty: this is soft shade cast by objects that are
  // themselves soft, and it is sampled on a sphere that never fills more
  // than half the frame. One megabyte of RGBA, built once.
  // Which cells the wet-ground channel is stamped from: the storm types,
  // and only where the rainfall map says rain belongs at the position the
  // deck was baked at. Same test the veils apply every frame, taken once.
  const rainingAtBake = (n: Nodule): boolean => {
    const type = bandType[n.band];
    if (type !== 'storm' && type !== 'typhoon') return false;
    return precipitationAtSeason(n.live, 0) > 0.4;
  };
  const { texture: shadowTexture, omegaScale } = buildCloudShadowTexture(
    nodules,
    rainingAtBake,
    radius,
    512,
    256,
  );

  // G55: layers. Altitude was already there (hoverBase differs by type —
  // cirrus rides well above cumulus/stratus) but nothing made that
  // altitude *read*: a deck with no visible interaction between its bands
  // is flat regardless of how many metres apart they actually sit. Rather
  // than invent a second field, feed the coverage/drift map this material
  // just baked for the *ground's* shadow back into coreMaterial itself —
  // the one material shared by every regular-type instance (cumulus,
  // stratus, and cirrus's core alike, see buildLayer above) — so a lump
  // sitting under the combined weight of the deck above and around it
  // reads a little darker than one standing alone. Self-shadowing a lone
  // cirrus wisp from its own faint coverage is the one place this over-
  // reaches physically; at cirrus's low opacity it does not read.
  coreMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.uCloudShadow = { value: shadowTexture };
    shader.uniforms.uCloudTime = selfShadowTime;
    shader.uniforms.uOmegaScale = { value: omegaScale };
    // Same live-mutated Vector3 the rain sunlit test already reads (see
    // this function's own JSDoc) — a plain reference, not a copy, so the
    // shading below tracks the key light without this material needing
    // its own per-frame update call.
    shader.uniforms.uSunDir = { value: sunDirection ?? new THREE.Vector3(0, 1, 0) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vNoduleDir;\nvarying vec3 vCloudWorldDir;')
      .replace(
        '#include <begin_vertex>',
        // transformed already carries the instance transform at this point
        // (see three's begin_vertex chunk under USE_INSTANCING), so this is
        // the nodule's own placed position in the globe's object space —
        // the same frame buildCloudShadowTexture baked lon/lat against.
        `#include <begin_vertex>
        vNoduleDir = normalize(transformed);
        // World-space version of the same direction, the way the globe
        // material's vGlobeNormal is derived from its own local position —
        // this group sits under the same rotating parent as the terrain,
        // so this is directly comparable to uSunDir for a per-nodule
        // "local sun elevation", the same day/night test the ground uses.
        vCloudWorldDir = normalize(mat3(modelMatrix) * transformed);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform sampler2D uCloudShadow;\nuniform float uCloudTime;\nuniform float uOmegaScale;\nuniform vec3 uSunDir;\nvarying vec3 vNoduleDir;\nvarying vec3 vCloudWorldDir;' +
          CLOUD_SHADOW_GLSL,
      )
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n      diffuseColor.rgb *= cloudShade(vNoduleDir, 0.3);',
      )
      // G60: on request ("新海誠的な" -- his cumulus always reads as a lit
      // object with weight and drama, not a flat cotton lump). Two terms,
      // both reusing state this material already computes rather than
      // adding new per-nodule data:
      //  - a grazing-angle rim (the same Fresnel trick the globe/ocean rim
      //    glow uses) brightens the thin, backlit edge of every nodule,
      //    which is exactly the "sun coming through the fringe" look real
      //    cotton-ball cumulus has and this material's flat matte roughness
      //    alone cannot produce.
      //  - a warm bounce on the underside specifically during this
      //    nodule's own local dusk/dawn (vCloudWorldDir vs uSunDir, same
      //    band shape the globe's terminator uses), weighted by how dark
      //    the baked underside gradient already made this fragment -- so
      //    it only lights up the shadowed underside, not the sunlit crown,
      //    which is where a sunset's underlight actually shows on a cloud.
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          float cloudRim = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 2.0);
          totalEmissiveRadiance += vec3(1.0, 0.97, 0.9) * cloudRim * 0.22;

          float cloudSun = dot(vCloudWorldDir, uSunDir);
          float duskBand = smoothstep(0.35, 0.0, abs(cloudSun));
          float underside = 1.0 - clamp(dot(diffuseColor.rgb, vec3(0.333)), 0.0, 1.0);
          totalEmissiveRadiance += vec3(1.0, 0.55, 0.22) * duskBand * underside * 0.35;
        }`,
      );
  };

  return { group, tick, shadowTexture, omegaScale };
}
