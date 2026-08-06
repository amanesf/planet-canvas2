import * as THREE from 'three';
import { zonalWind } from './clouds';
import { mulberry32 } from './spatialHash';
import {
  DESERT_ARIDITY_THRESHOLD,
  GLASS_SEA_HEIGHT,
  SEA_LEVEL,
  aridityAt,
  climateClassAt,
  precipitationAtSeason,
  sampledHeight,
  temperatureAt,
} from './terrain';

// ---------------------------------------------------------------------
// Fog — G49
// ---------------------------------------------------------------------
// The globe has had a cloud deck for a long time and it hangs *above* the
// ground: nodules on a shell well clear of the paint, casting a baked
// shade down onto it. Fog is the opposite object. It lies ON the surface
// and it hides what is under it, and that occlusion is the entire read. A
// white lump floating a little above a valley is a cloud that has drifted
// too low; the same white sitting in the valley with the trees and the
// ridge standing out of the top of it is fog. The only difference between
// the two pictures is whether the ground underneath still shows through.
//
// So this is deliberately not a lower copy of clouds.ts:
//
// - One disc per patch, tangent to the sphere at the patch's own point and
//   bent to follow its curvature, sitting a few thousandths of a unit over
//   the local ground. Not a cluster of nodules. A fog bank has no lumps in
//   silhouette; it has a flat top, which is what a temperature inversion
//   physically is.
// - It writes no depth but it does test depth, so anything the relief
//   pushes up through the disc's plane occludes it for free — the depth
//   buffer already has the terrain and the vegetation in it.
// - Its alpha runs to 0.90 in the middle. Cloud nodules are opaque solids
//   seen from outside; fog is a translucent volume seen from above, and
//   0.90 over the paint is what "you can only just make out that there is
//   land under this" looks like. Not 1.0 — a patch that hid its valley
//   completely would read as a hole cut in the planet.
//
// PIXEL ARITHMETIC, DONE BEFORE ANY OF THIS WAS BUILT (§2-21: "not drawn"
// and "0.3 px wide" are the same picture on screen).
//
//   The globe is radius 2 and the shipped camera puts about 108 px on one
//   world unit (760 / (2 * 9.6 * tan 20°)), so the globe is about 432 px
//   across.
//   - Real valley fog — the Po basin, the Central Valley — is of order
//     200 km wide. On a 2-unit globe (40,000 km ↔ 12.57 units) that is
//     0.063 units = 6.8 px across: a white dot with no interior, which
//     reads as dirt on the paint rather than as weather. So the patches
//     here are exaggerated about 4x, the same bargain the dust storms took
//     in §2-27, and the drawn sizes are 22–35 px (valley) and 28–48 px
//     (sea) across.
//   - The other number this arithmetic settled is one the effect must NOT
//     lean on. The fog top sits `fill` above the basin floor, and `fill`
//     is at most 0.024 in height units, i.e. 0.024 * BUMP_HEIGHT = 0.0086
//     world units = 0.93 px. The enclosing ridge is 0.4–1.8 px above the
//     floor at the thresholds below. So "the ridge stands proud of the fog
//     surface" is worth under two pixels and cannot be the read. What
//     carries the effect is (a) the paint, the fields and the coastline
//     going out underneath the patch, and (b) the vegetation instances,
//     which are metres tall in this scale's terms and therefore stick up
//     through a fog surface laid this close to the ground. That is the
//     right way round anyway: you know it is fog because the treetops are
//     above it.
//
// COST: one InstancedMesh, one draw call, for both kinds together, against
// a budget of about 157.
//
// WHERE IT COMES FROM: nothing in this file invents weather. Siting reads
// `sampledHeight`, `climateClassAt`, `aridityAt`, `temperatureAt` and
// `precipitationAtSeason` from terrain.ts; the drift reads `zonalWind`
// from clouds.ts. A second wind profile or a second climate rule is
// exactly the split §3 of the gap analysis is about, and which the ash
// plumes and the falling snow both had to be walked back into these same
// functions to undo.

/** The two things that make fog on the ground, and they are not the same. */
const VALLEY = 0;
const SEA = 1;

export interface Fog {
  mesh: THREE.InstancedMesh;
  tick: (t: number) => void;
}

interface FogSite {
  /** unit direction of the patch centre on the sphere */
  dir: THREE.Vector3;
  kind: number;
  /** world-space radius of the disc */
  size: number;
  /** how foggy this place is at its very best, 0..1 */
  strength: number;
  /** the radius the disc is placed at: local ground, plus a hair */
  height: number;
  /** mean rainfall here, and how far the year swings it (hemisphere folded) */
  wet: number;
  swing: number;
  /** longitude, and how fast longitude runs here under the shared zonal wind */
  lon: number;
  omega: number;
  /** which way "onshore" is, in the disc's own local (east, north) frame */
  onshore: THREE.Vector2;
}

/**
 * How much higher the ground around this point stands than the point does.
 *
 * Valley fog is not a property of *low* ground, it is a property of
 * *enclosed* ground. Cold air is denser than warm air, so on a still clear
 * night it drains downhill and ponds in whatever hollow has no outlet, and
 * the fog forms on top of that pond. The Po valley and the Central Valley
 * are famous for it and the Atlantic coastal plain at the same elevation is
 * not; the difference is entirely the ring of mountains.
 *
 * Measured against display height rather than raw height on purpose: the
 * display field is the one the globe mesh is actually built from (terraces,
 * orogeny, LAND_BOOST, the coastal step), so a wall the *viewer* can see
 * standing over the floor is a wall this returns a number for.
 *
 * Two radii because one is ambiguous. A point halfway down a uniform slope
 * has high ground on one side and low on the other and averages to zero,
 * which is the right answer; but a point in a narrow gorge only reads as
 * enclosed at the near radius, and a point on a wide plain ringed by
 * distant mountains only at the far one.
 */
function basinDepth(dir: THREE.Vector3, ownDisplay: number): number {
  const east = new THREE.Vector3(0, 1, 0).cross(dir);
  if (east.lengthSq() < 1e-8) return 0;
  east.normalize();
  const north = dir.clone().cross(east).normalize();
  const probe = new THREE.Vector3();
  let sum = 0;
  let n = 0;
  // 0.030 rad is 0.060 world units at radius 2, about 6.5 px on screen;
  // 0.060 rad is twice that. Together they span the scale a drawn patch
  // occupies, so "enclosed" here means enclosed at the size the fog will
  // actually be drawn at, not at some geological scale nobody can see.
  for (const r of [0.03, 0.06]) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      probe
        .copy(dir)
        .addScaledVector(east, Math.cos(a) * r)
        .addScaledVector(north, Math.sin(a) * r)
        .normalize();
      sum += sampledHeight(probe).display;
      n++;
    }
  }
  return sum / n - ownDisplay;
}

/**
 * Which way the nearest coast lies from a point at sea, and how far.
 *
 * Sea fog is a coastal object. Advection fog forms out over the cold water,
 * but it is only *an event* where it comes ashore and swallows something,
 * and the direction matters as much as the distance because the direction
 * is how this file identifies a cold current without having a current field
 * to read (see `seaFogAt`).
 */
function coastFrom(dir: THREE.Vector3): { toLand: THREE.Vector3; distance: number } | null {
  const east = new THREE.Vector3(0, 1, 0).cross(dir);
  if (east.lengthSq() < 1e-8) return null;
  east.normalize();
  const north = dir.clone().cross(east).normalize();
  const probe = new THREE.Vector3();
  for (const r of [0.015, 0.03, 0.045, 0.06]) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      probe
        .copy(dir)
        .addScaledVector(east, Math.cos(a) * r)
        .addScaledVector(north, Math.sin(a) * r)
        .normalize();
      if (sampledHeight(probe).raw >= SEA_LEVEL) {
        return { toLand: probe.clone().sub(dir).normalize(), distance: r };
      }
    }
  }
  return null;
}

export function buildFog(
  radius: number,
  bumpHeight: number,
  seasonUniforms: { uSeasonTilt: { value: number } },
  sunDirection: THREE.Vector3,
): Fog {
  const rand = mulberry32(4907);

  const sites: FogSite[] = [];
  // The patches are large (22–48 px), so two centres within a patch width
  // of each other are one blob with a seam down it rather than two banks.
  // 0.09 rad is 0.18 units, a bit over one large patch diameter.
  //
  // Sea banks are kept further apart than that, and there is a hard cap on
  // how many of them there may be, because of what the first two
  // measurements showed: a fog *coast* is thousands of kilometres long, so
  // rejection sampling hands it as many sites as it is offered and the
  // system came out two-thirds sea fog with 53 patches alive at once — an
  // unbroken white hem round a third of the world's coastline, which is a
  // material on the sea rather than weather on it. Discrete banks with
  // water showing between them is both the truer picture and the cheaper
  // one.
  const MIN_SEPARATION = 0.09;
  const SEA_MIN_SEPARATION = 0.13;
  const MAX_SITES = 120;
  const MAX_SEA_SITES = 44;

  const probe = new THREE.Vector3();
  const east = new THREE.Vector3();
  const north = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  /**
   * Valley fog: cold, still, enclosed low ground that is not dry.
   *
   * Every clause below is a rejection that the measurement harness was
   * built to check, because the failure mode here is silent: fog over the
   * Sahara at noon is a bug, and it is a bug that looks perfectly pretty
   * until you notice what is underneath it. Measured over 240 frames
   * spanning two of this globe's years and 46 valley sites, the ground
   * under the live valley patches came out at alpha-weighted mean aridity
   * 0.282 against a whole-land mean of 0.434, and mean raw elevation 0.095
   * against a whole-land 0.099 — the same height as the land in general,
   * which is the point: these are basins, not lowlands. Zero patch-frames
   * landed on ground drier than DESERT_ARIDITY_THRESHOLD, zero over water,
   * and zero in full daylight.
   */
  function valleyFogAt(dir: THREE.Vector3): { strength: number; height: number } | null {
    const h = sampledHeight(dir);
    if (h.raw < SEA_LEVEL) return null;

    // Aridity, with margin. DESERT_ARIDITY_THRESHOLD is 0.52 — the value
    // the paint turns to sand at and the dust storms fire above — so a
    // patch admitted at 0.51 would be sitting on drawn desert. Radiation
    // fog needs air already near saturation. The deserts that genuinely do
    // get fog (the Namib) get it off the sea, which is the other kind.
    if (aridityAt(dir) > DESERT_ARIDITY_THRESHOLD - 0.1) return null;

    // Köppen class 0 is "no data", which the raster gives over open water.
    // A land pixel whose nearest class is no-data is a speck of an island
    // and has no basin worth the name.
    if (climateClassAt(dir) === 0) return null;

    // Cold enough for a night to reach the dew point, warm enough not to be
    // the ice cap. `temperatureAt` is ~1 at the equator at sea level and
    // falls with both latitude and elevation, so this window is roughly the
    // temperate belt plus the cooler subtropical highlands — and because
    // the elevation term is in there, a high basin qualifies at a latitude
    // where the lowland beside it does not. That is Anatolia, the Iranian
    // plateau and the altiplano, which are real fog basins.
    const temperature = temperatureAt(dir, h.raw);
    if (temperature < 0.1 || temperature > 0.62) return null;

    // The pond of cold air. Threshold taken off the measured distribution
    // of `basinDepth` over the land that passes the climate clauses above
    // (7,145 sampled points): median −0.018 — most land is a slope or a
    // rise, and both come out at or below zero — with 0.010 at about the
    // 83rd percentile and 0.0158 at the 87th. 16.7% of eligible land is
    // enclosed by this measure, which is the population the sampler then
    // draws its basins from.
    const basin = basinDepth(dir, h.display);
    if (basin < 0.01) return null;

    // Moisture. Averaging the two solstices is the mean of what
    // `precipitationAtSeason` will hand the shader; the seasonal half of
    // the same expression is baked separately below and finished there.
    const wet = 0.5 * (precipitationAtSeason(dir, 1) + precipitationAtSeason(dir, -1));
    if (wet < 0.22) return null;

    // A deeper basin, damper air and a colder night each make it thicker.
    const enclosure = THREE.MathUtils.smoothstep(basin, 0.01, 0.045);
    const damp = THREE.MathUtils.smoothstep(wet, 0.22, 0.55);
    const cool = THREE.MathUtils.smoothstep(temperature, 0.66, 0.3);
    const strength = 0.45 + 0.55 * (enclosure * 0.5 + damp * 0.25 + cool * 0.25);

    // Where the top of the fog sits: the floor of the basin plus a fraction
    // of the way up towards the surrounding ridge, capped so that a patch in
    // a deeply walled basin does not become a dome. As the header notes this
    // is worth under a pixel of parallax; it exists so the disc is above the
    // ground rather than z-fighting with it, and below the treetops.
    const fill = Math.min(basin * 0.45, 0.02) + 0.004;
    return { strength, height: radius + (h.display + fill) * bumpHeight };
  }

  /**
   * Sea fog: warmer air over a cold sea, coming ashore.
   *
   * There is no ocean-current field on this globe, and adding one for this
   * alone would be exactly the duplication the header refuses. But the cold
   * currents that make the world's fog coasts are not scattered at random.
   * They fall into two geometries, and both are readable from the elevation
   * raster plus the Köppen aridity that is already loaded:
   *
   * (a) Eastern-boundary upwelling. On the east side of an ocean basin —
   *     i.e. the WEST coast of a continent, so the land lies to the east of
   *     the water — the subtropical gyre drags surface water equatorward
   *     and cold water rises to replace it. This is why every one of those
   *     coasts has a desert on it: Namib/Benguela, Atacama–Peru/Humboldt,
   *     Baja and California, Western Sahara/Canary. The desert IS the tell,
   *     so the rule takes the aridity of the adjoining land as its
   *     evidence — which means this rule lays fog on the seaward side of
   *     the very sand the valley rule is carefully kept off. Both readings
   *     are right, and that contrast is the most interesting thing here.
   * (b) Cold high-latitude coasts where a polar current runs down the west
   *     side of a basin, i.e. the land lies to the WEST of the water:
   *     Labrador off Newfoundland (the Grand Banks is the foggiest water on
   *     earth), Oyashio off Hokkaido and the Kurils, the Falklands current
   *     off Patagonia. The mirror case — land to the east at those
   *     latitudes, so the west coasts of Ireland and Alaska — is a *warm*
   *     current and is excluded, which is correct.
   */
  function seaFogAt(dir: THREE.Vector3): { strength: number; height: number } | null {
    if (sampledHeight(dir).raw >= SEA_LEVEL) return null;
    const coast = coastFrom(dir);
    if (!coast) return null;

    // Is this an ocean, or a puddle between two continents?
    //
    // This test is here because of what the first measurement said. Without
    // it the two clauses below fired on 142 sites and the list read
    // Mediterranean, Black Sea, Red Sea, Persian Gulf, Adriatic — every
    // enclosed warm sea on the planet, because "there is land to the east of
    // me" is trivially true in a basin that has land on all four sides. An
    // upwelling current needs a basin to upwell in. Three samples straight
    // out to sea, at 0.12, 0.24 and 0.36 rad (roughly 750, 1500 and 2300 km),
    // and all three must still be water. No sea on this planet that is
    // narrower than about 2000 km survives it, and no ocean fails it.
    const offshore = new THREE.Vector3();
    for (const d of [0.12, 0.24, 0.36]) {
      offshore.copy(dir).addScaledVector(coast.toLand, -d).normalize();
      if (sampledHeight(offshore).raw >= SEA_LEVEL) return null;
    }

    east.copy(up).cross(dir);
    if (east.lengthSq() < 1e-8) return null;
    east.normalize();
    // Positive when the land lies east of this water, negative when west.
    const eastward = coast.toLand.dot(east);
    const latitude = Math.abs(Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1))) * (180 / Math.PI);

    // What the adjoining land is like. The climate raster resolves a water
    // pixel to its nearest land class anyway, but reading the shore point
    // itself keeps the evidence unambiguous.
    const shore = dir.clone().addScaledVector(coast.toLand, coast.distance * 1.15).normalize();
    const shoreArid = aridityAt(shore);
    const temperature = temperatureAt(dir, 0);

    let strength: number;
    if (eastward > 0.4 && latitude > 12 && latitude < 42 && shoreArid > 0.5) {
      // (a) upwelling coast — thickest where the desert behind it is
      // driest, which is where the upwelling is strongest. The aridity bar
      // is at 0.5 rather than at the 0.44 this was first written with: 0.44
      // let in the merely summer-dry Mediterranean-climate coasts, which are
      // warm-current coasts and not fog coasts.
      strength = 0.55 + 0.45 * THREE.MathUtils.smoothstep(shoreArid, 0.5, 0.72);
    } else if (eastward < -0.4 && latitude > 40 && latitude < 58 && temperature < 0.34) {
      // (b) cold polar current — colder water, thicker fog. The window is
      // narrow on purpose. `temperatureAt` over water is essentially
      // 1 - |sin(lat)| plus the climate wobble, so a loose bound here is a
      // latitude band and nothing more, and a latitude band put fog on every
      // stretch of 40-60° coastline on the planet.
      strength = 0.5 + 0.5 * THREE.MathUtils.smoothstep(temperature, 0.34, 0.16);
    } else {
      return null;
    }

    // Thinned with distance offshore. A bank far out to sea is not an
    // event; the one with the coastline under half of it is.
    strength *= 1 - THREE.MathUtils.smoothstep(coast.distance, 0.03, 0.075);
    if (strength < 0.3) return null;

    // Sat on the water, a hair above the glass sea shell so it cannot
    // z-fight with it. It genuinely is at sea level, and that is the
    // difference between this and a stratus deck.
    return { strength, height: radius + GLASS_SEA_HEIGHT * bumpHeight + 0.006 };
  }

  function tooClose(dir: THREE.Vector3, kind: number): boolean {
    const limit = Math.cos(kind === SEA ? SEA_MIN_SEPARATION : MIN_SEPARATION);
    for (const s of sites) {
      if (s.dir.dot(dir) > limit) return true;
    }
    return false;
  }

  // Equal-area rejection sampling — uniform in sin(latitude), so the poles
  // are not oversampled the way uniform-in-degrees would.
  let attempts = 0;
  let seaCount = 0;
  while (sites.length < MAX_SITES && attempts < 160000) {
    attempts++;
    const sinLat = rand() * 2 - 1;
    const lon = rand() * Math.PI * 2;
    const c = Math.sqrt(Math.max(0, 1 - sinLat * sinLat));
    probe.set(c * Math.cos(lon), sinLat, c * Math.sin(lon));

    const overLand = sampledHeight(probe).raw >= SEA_LEVEL;
    const kind = overLand ? VALLEY : SEA;
    if (kind === SEA && seaCount >= MAX_SEA_SITES) continue;
    const found = overLand ? valleyFogAt(probe) : seaFogAt(probe);
    if (!found) continue;
    if (tooClose(probe, kind)) continue;
    if (kind === SEA) seaCount++;

    let centre = probe.clone();
    // Which way the shore is, kept for both the placement nudge and the
    // per-frame roll.
    let toLand: THREE.Vector3 | null = null;
    if (kind === SEA) {
      const coast = coastFrom(centre);
      if (coast) {
        toLand = coast.toLand;
        // Slide the centre towards the shore so the disc straddles the
        // coastline: most of it on the water, its inner edge over the first
        // few kilometres of land. Fog that stops dead at the waterline is a
        // texture; fog that has swallowed the headland is weather.
        centre = centre.clone().addScaledVector(coast.toLand, coast.distance * 0.55).normalize();
      }
    }

    const wet = 0.5 * (precipitationAtSeason(centre, 1) + precipitationAtSeason(centre, -1));
    // `precipitationAtSeason` already folds the hemisphere into its answer,
    // so the difference of the two solstices carries the sign out with it
    // and the shader only has to multiply it by the season tilt.
    const swing = 0.5 * (precipitationAtSeason(centre, 1) - precipitationAtSeason(centre, -1));
    const lat = Math.asin(THREE.MathUtils.clamp(centre.y, -1, 1));

    // Resolve "onshore" into the disc's own frame now, at build time. This
    // is safe to bake where a *bearing* would not be (§2-17: baked
    // orientations rot as the advection carries a thing round the planet),
    // because a fog bank is anchored to its own coastline and never
    // travels: only its edge moves, in and out.
    east.copy(up).cross(centre);
    if (east.lengthSq() < 1e-8) east.set(1, 0, 0);
    east.normalize();
    north.copy(centre).cross(east).normalize();
    const onshore = toLand
      ? new THREE.Vector2(toLand.dot(east), toLand.dot(north)).normalize()
      : new THREE.Vector2(0, 0);

    sites.push({
      dir: centre,
      kind,
      // Sea fog banks are the bigger object in nature and the bigger object
      // here: 0.13–0.22 units of radius is 28–48 px across, valley fog's
      // 0.10–0.16 is 22–35 px.
      size: kind === SEA ? 0.13 + rand() * 0.09 : 0.1 + rand() * 0.06,
      strength: found.strength,
      height: found.height,
      wet,
      swing,
      // Same convention as terrain's latLonToDir, so a front here runs the
      // same way round the planet as the cloud bands overhead.
      lon: Math.atan2(centre.z, -centre.x) - Math.PI,
      // The wind is `zonalWind`, imported. The only thing done to it here
      // is the conversion from a speed along the great circle to a rate of
      // change of longitude, clamped exactly as clouds.ts clamps it so the
      // 1/cos does not run away at the pole.
      omega: zonalWind(lat) / Math.max(Math.cos(lat), 0.22),
      onshore,
    });
  }

  const COUNT = Math.max(sites.length, 1);

  // -------------------------------------------------------------------
  // The disc
  // -------------------------------------------------------------------
  // Built once, in the XZ plane, and bent down into the sphere's own
  // curvature so that a patch 0.44 units across does not have its rim
  // buried. Rings rather than a single triangle fan because the bend needs
  // interior vertices to bend with; the alpha ramp is computed per fragment
  // from the local coordinate, so the tessellation is not what makes the
  // edge soft.
  //
  // HOW THE SOFT EDGE IS MADE, AND WHAT IT DELIBERATELY IS NOT. The cloud
  // deck's fringe took several attempts, and its worst failure — recorded
  // at the top of clouds.ts — was a grey ring round every lump: the fringe
  // was a second, larger, fainter copy of each nodule lit by the same
  // shading as the core, so the only part of it that showed past the core's
  // silhouette was the fringe's own *underside*, the darkest part of it,
  // and every cloud came out outlined in grey. Nothing here repeats that.
  // There is exactly one layer; it is unlit and flat-coloured, and its
  // alpha falls from the middle to nothing. Because the colour is constant
  // across the disc, the edge physically cannot come out darker than the
  // middle — it is where the alpha runs out, not where a second object
  // sticks out.
  const RINGS = 4;
  const SEGMENTS = 40;
  const positions: number[] = [];
  const indices: number[] = [];
  positions.push(0, 0, 0);
  // The mean patch radius. The disc is a unit disc scaled per instance, so
  // the sagitta it should be given differs slightly per instance; using the
  // mean leaves a residual under 0.001 units, a tenth of a pixel, which is
  // far below the point at which it could show.
  const MEAN_SIZE = 0.15;
  for (let ring = 1; ring <= RINGS; ring++) {
    const r = ring / RINGS;
    for (let s = 0; s < SEGMENTS; s++) {
      const a = (s / SEGMENTS) * Math.PI * 2;
      // Sagitta of a chord at fraction r of a disc of radius `size` laid on
      // a sphere of `radius` is (size*r)^2 / (2*radius); in unit-disc space,
      // where the whole thing is later multiplied by `size`, that is
      // r^2 * size / (2*radius).
      positions.push(Math.cos(a) * r, -(r * r) * (MEAN_SIZE / (2 * radius)), Math.sin(a) * r);
    }
  }
  const idx = (ring: number, s: number) => 1 + (ring - 1) * SEGMENTS + (s % SEGMENTS);
  for (let s = 0; s < SEGMENTS; s++) indices.push(0, idx(1, s + 1), idx(1, s));
  for (let ring = 1; ring < RINGS; ring++) {
    for (let s = 0; s < SEGMENTS; s++) {
      indices.push(idx(ring, s), idx(ring, s + 1), idx(ring + 1, s));
      indices.push(idx(ring, s + 1), idx(ring + 1, s + 1), idx(ring + 1, s));
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);

  const aStrength = new Float32Array(COUNT);
  const aKind = new Float32Array(COUNT);
  const aSeed = new Float32Array(COUNT);
  const aWet = new Float32Array(COUNT);
  const aSwing = new Float32Array(COUNT);
  const aLon = new Float32Array(COUNT);
  const aOmega = new Float32Array(COUNT);
  const aOnshore = new Float32Array(COUNT * 2);
  const matrices = new Float32Array(COUNT * 16);

  const m = new THREE.Matrix4();
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    // The disc's own +Y is the local outward normal and the other two axes
    // are the compass frame, which is what lets the shader push a bank
    // "onshore" by writing into local x and z.
    east.copy(up).cross(s.dir);
    if (east.lengthSq() < 1e-8) east.set(1, 0, 0);
    east.normalize();
    north.copy(s.dir).cross(east).normalize();
    m.makeBasis(
      east.clone().multiplyScalar(s.size),
      s.dir.clone().multiplyScalar(s.size),
      north.clone().multiplyScalar(s.size),
    );
    m.setPosition(s.dir.x * s.height, s.dir.y * s.height, s.dir.z * s.height);
    m.toArray(matrices, i * 16);

    aStrength[i] = s.strength;
    aKind[i] = s.kind;
    aSeed[i] = rand() * 100;
    aWet[i] = s.wet;
    aSwing[i] = s.swing;
    aLon[i] = s.lon;
    aOmega[i] = s.omega;
    aOnshore[i * 2] = s.onshore.x;
    aOnshore[i * 2 + 1] = s.onshore.y;
  }
  geometry.setAttribute('aStrength', new THREE.InstancedBufferAttribute(aStrength, 1));
  geometry.setAttribute('aKind', new THREE.InstancedBufferAttribute(aKind, 1));
  geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(aSeed, 1));
  geometry.setAttribute('aWet', new THREE.InstancedBufferAttribute(aWet, 1));
  geometry.setAttribute('aSwing', new THREE.InstancedBufferAttribute(aSwing, 1));
  geometry.setAttribute('aLon', new THREE.InstancedBufferAttribute(aLon, 1));
  geometry.setAttribute('aOmega', new THREE.InstancedBufferAttribute(aOmega, 1));
  geometry.setAttribute('aOnshore', new THREE.InstancedBufferAttribute(aOnshore, 2));

  const uniforms = {
    uTime: { value: 0 },
    uSeasonTilt: seasonUniforms.uSeasonTilt,
    uSunDir: { value: sunDirection },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    // Tests depth, does not write it. Testing is what makes the relief and
    // the trees occlude the fog; not writing is what keeps two overlapping
    // patches from punching each other out.
    depthWrite: false,
    // Both faces: a tangent disc is seen from its outer face near the
    // middle of the globe's silhouette and very nearly edge-on at the limb,
    // and a back-face-culled patch flickers out there.
    side: THREE.DoubleSide,
    vertexShader: `
      attribute float aStrength;
      attribute float aKind;
      attribute float aSeed;
      attribute float aWet;
      attribute float aSwing;
      attribute float aLon;
      attribute float aOmega;
      attribute vec2 aOnshore;
      uniform float uTime;
      uniform float uSeasonTilt;
      uniform vec3 uSunDir;
      varying vec2 vLocal;
      varying float vAlpha;
      varying float vKind;
      varying float vSeed;
      varying float vLight;

      void main() {
        vLocal = position.xz;
        vKind = aKind;
        vSeed = aSeed;

        // Motion lives here, as it does in every other system on this
        // globe. A sea fog bank does not sit still off its coast: it comes
        // in and it goes back out, and aOnshore is that direction already
        // resolved into this disc's own frame, so every bank on the planet
        // breathes towards its own land without one of them needing a
        // separate rule. 0.3 of a patch radius is about 0.05 units, near
        // enough 5 px of travel — small, but an edge crossing a headland is
        // legible where a whole patch sliding would just look like the mesh
        // moving.
        vec3 local = position;
        float roll = sin(uTime * 0.09 + aSeed) * 0.3;
        local.xz += aOnshore * roll * step(0.5, aKind);

        vec4 world = instanceMatrix * vec4(local, 1.0);
        vec3 worldNormal = normalize(mat3(modelMatrix) * normalize((instanceMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz));
        gl_Position = projectionMatrix * modelViewMatrix * world;

        float sun = dot(worldNormal, uSunDir);

        // Unlit, but not un-darkened. The night side of this globe is very
        // dark, and a fog bank glowing white on it would read as a hole in
        // the planet rather than as weather.
        vLight = 0.16 + 0.84 * smoothstep(-0.18, 0.30, sun);

        // Which side of the terminator this is on. The globe turns about
        // its own +Y under a fixed key light, so a point's velocity is
        // ŷ × p, and a point moving *towards* the sun is one where dawn has
        // just happened or is about to. Without this test the fog would be
        // symmetric about noon and would form at dusk, which is backwards:
        // radiation fog needs a whole night of cooling behind it, so it is
        // a dawn object and not an evening one.
        float morning = smoothstep(-0.25, 0.10, dot(normalize(cross(vec3(0.0, 1.0, 0.0), worldNormal)), uSunDir));

        // VALLEY. Thickens through the second half of the night, stands at
        // sunrise, and burns off within an hour or two of it — which is
        // exactly what anyone who has driven the Central Valley in January
        // has watched happen. The globe turns once in about 42 s, so the
        // whole life of a patch plays out over about 10 s and comes round
        // again.
        float dawn = (1.0 - smoothstep(0.04, 0.34, sun)) * morning;
        // And it is a cold-half-year object at these latitudes. Local
        // winter is where the season tilt and the latitude disagree in
        // sign, the same expression the falling snow uses.
        float winter = clamp(-uSeasonTilt * worldNormal.y, -1.0, 1.0);
        float valley = dawn * (0.55 + 0.45 * winter);

        // SEA. Not a dawn object at all: the Grand Banks and the Namib
        // coast are fogged in at any hour, because the cooling is done by
        // the water and not by the night. What makes it come and go is the
        // passage of air over that cold water, so it is gated on a wave in
        // longitude carried by the shared zonalWind — the same front
        // mechanism the snow uses. Three fronts round the planet, tilted
        // with latitude so they do not read as rings.
        float front = 0.5 + 0.5 * sin(3.0 * (aLon - aOmega * uTime) + 2.2 * worldNormal.y);
        // Rainfall at this instant of the year, finishing
        // precipitationAtSeason off the baked profile. An upwelling coast
        // is bone dry, so this must not be able to switch it off; all it
        // decides is how much of a front's passage the place is open for.
        float wetNow = clamp(aWet + aSwing * uSeasonTilt, 0.0, 1.0);
        float gate = 0.68 - 0.26 * smoothstep(0.05, 0.45, wetNow);
        // ...and the diurnal swing, which after measurement is the *main*
        // switch here rather than a trim on the front.
        //
        // Two measurements drove this. First, gating on the wind alone
        // leaves banks stuck on: zonalWind passes through zero at 0, 30 and
        // 60 degrees, so a bank sitting on one of those latitudes has
        // omega ~ 0, its front never advances, and it is switched on for
        // ever — 36 of 44 sea banks were alive at every instant. Second,
        // the obvious repair, gating it on night, is worse than useless
        // here: vLight below darkens everything on the unlit side to 0.16,
        // so a system that is only on at night is a system that is never
        // seen. This globe's fog has to be a morning object to exist at all.
        //
        // Which is also the true one. The bank lies offshore overnight, it
        // is over the coast at first light, and high sun burns it back to
        // the water — May gray and June gloom. Here lit is the daylight side,
        // burn takes it down under a high sun, and the morning term
        // weights the dawn half of the lit crescent over the dusk half.
        float lit = smoothstep(-0.20, 0.10, sun);
        float burn = 1.0 - 0.75 * smoothstep(0.30, 0.75, sun);
        float sea = (0.30 + 0.70 * smoothstep(gate, gate + 0.22, front))
                  * lit * burn * (0.55 + 0.45 * morning);

        float live = mix(valley, sea, step(0.5, aKind));
        // 0.90 in the middle. Fog hides the ground — that is the whole
        // difference between this and a low cloud — but never completely.
        vAlpha = aStrength * live * 0.90;
      }
    `,
    fragmentShader: `
      varying vec2 vLocal;
      varying float vAlpha;
      varying float vKind;
      varying float vSeed;
      varying float vLight;
      uniform float uTime;

      void main() {
        if (vAlpha <= 0.004) discard;
        float r = length(vLocal);
        float a = atan(vLocal.y, vLocal.x);
        // The rim, breathing. A circle is the one outline fog never has,
        // and the edge is also the part of a bank that moves most: three
        // low harmonics running at different rates give a boundary that is
        // never twice the same and never resolves into a polygon. Done per
        // fragment against the radius, so it costs no geometry and, more to
        // the point, no second layer — the lesson of the grey ring is that
        // a fringe must not be a separate object.
        float warp = 1.0
          + 0.16 * sin(3.0 * a + vSeed + uTime * 0.22)
          + 0.10 * sin(5.0 * a - vSeed * 1.7 - uTime * 0.15)
          + 0.06 * sin(8.0 * a + vSeed * 0.4 + uTime * 0.31);
        float rr = r / max(warp, 0.4);
        // Flat-topped: solid across the middle half, then out. A Gaussian
        // patch reads as a puff of smoke; fog has a body of definite extent
        // and a fraying edge.
        float body = 1.0 - smoothstep(0.5, 1.0, rr);
        if (body <= 0.003) discard;

        // Sea fog a touch bluer and valley fog a touch warmer — one is lit
        // by cold water under an overcast, the other by a low orange sun.
        // Both stay almost colourless: this is water in air, not paint.
        vec3 tint = mix(vec3(0.965, 0.955, 0.935), vec3(0.925, 0.945, 0.965), step(0.5, vKind));
        gl_FragColor = vec4(tint * vLight, vAlpha * body);
      }
    `,
  });

  const mesh = new THREE.InstancedMesh(geometry, material, COUNT);
  mesh.instanceMatrix = new THREE.InstancedBufferAttribute(matrices, 16);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.count = sites.length;
  // The discs are placed by their instance matrices and nudged by the
  // shader, so the bounding sphere three would compute from the unit disc
  // in `position` describes nothing; the system is on screen whenever the
  // globe is.
  mesh.frustumCulled = false;
  // Fog is under the cloud deck and over the ground. Both of those are
  // depth-tested, so this only orders against the other transparent
  // systems — and it must be drawn before the rain veils, which hang from a
  // cloud down through this height.
  mesh.renderOrder = 1;

  return {
    mesh,
    tick: (t: number) => {
      uniforms.uTime.value = t;
    },
  };
}
