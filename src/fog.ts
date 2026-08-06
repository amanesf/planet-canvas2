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
// Fog
// ---------------------------------------------------------------------
// The globe has had a cloud deck for a long time and it hangs *above* the
// ground: nodules on a shell at r + 0.16, casting a baked shade down onto
// the paint. Fog is the opposite object. It lies ON the surface and it
// hides what is under it — that occlusion is the whole read. A low white
// lump floating a little above a valley is a cloud that has drifted too
// low; the same white sitting in the valley with the ridges either side of
// it standing out of the top is fog, and the only difference between the
// two pictures is whether the ground underneath still shows through.
//
// So this system is not a lower copy of clouds.ts. Three deliberate
// differences:
//
// - It is a *surface* — one disc per patch, tangent to the sphere at the
//   patch's own point and curved to follow it, sitting a few thousandths
//   of a unit above the local ground. Not a cluster of nodules. A fog
//   bank has no lumps in silhouette; it has a flat top, which is what a
//   temperature inversion physically is.
// - It writes no depth but it *tests* depth, so anything the terrain
//   pushes up through the disc's plane — a ridge round a basin, a headland
//   on a fog coast — occludes it. That is where the "filling a hollow"
//   read comes from, and it is free: the depth buffer already has the
//   relief in it.
// - Its opacity goes high (0.90 at the core). Cloud nodules are opaque
//   solids seen from outside; fog is a translucent volume seen from above,
//   and 0.9 over the paint is what "you can just make out that there is
//   land under this" looks like.
//
// SIZE, BEFORE ANYTHING WAS BUILT (§2-21: "not drawn" and "0.3 px wide"
// are the same picture). The globe is radius 2 and the shipped camera puts
// about 108 px on one world unit. A patch of radius 0.10–0.22 units is
// 22–48 px across on screen. Real valley fog in the Po basin is ~200 km
// wide, which on a 2-unit globe would be 0.031 units = 6.7 px across: too
// small to have an interior, so it would read as a white dot, i.e. as
// dirt. The patches here are exaggerated by about 4x, the same bargain the
// dust storms took (§2-27, real size 0.03 px, drawn at 55 px).
//
// COST: one InstancedMesh, one draw call, for both kinds of fog together.
// The budget is about 157 draw calls and one instanced mesh per system is
// the standard here.
//
// WHERE IT COMES FROM: nothing in this file invents weather. Siting reads
// `sampledHeight`, `climateClassAt`, `aridityAt`, `temperatureAt` and
// `precipitationAtSeason` from terrain.ts, and the drift reads `zonalWind`
// from clouds.ts. A second wind profile or a second climate rule is the
// split §3 of the gap analysis is about and that this project keeps having
// to undo — the ash plumes and the falling snow both had to be walked back
// into these same functions.

/** The two things that make ground-level fog, and they are not the same. */
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
  /** how foggy this place is at its best, 0..1 */
  strength: number;
  /** radius the disc sits at (ground level here, plus a hair) */
  height: number;
  /** mean rainfall here and how hard the year swings it (hemisphere folded) */
  wet: number;
  swing: number;
  /** longitude, and how fast longitude runs under the shared zonal wind */
  lon: number;
  omega: number;
  /** measurement only: what the ground under this patch is like */
  elevation: number;
  aridity: number;
}

/**
 * How much lower this point sits than the ground that surrounds it.
 *
 * Valley fog is not a property of *low* ground, it is a property of
 * *enclosed* ground: cold air is denser than warm air, so on a still clear
 * night it drains downhill and ponds in whatever hollow has no outlet,
 * and the fog forms on top of that pond. The Po valley and the Central
 * Valley are famous for it while the Atlantic coastal plain at the same
 * elevation is not, and the difference is entirely the ring of mountains.
 *
 * Measured against display height rather than raw height on purpose: the
 * display field is the one the mesh is actually built from (LAND_BOOST,
 * orogeny, terraces), so a ring that the *viewer* sees as standing above
 * the floor is a ring this returns a number for. Two radii because one is
 * ambiguous: a point on a uniform slope has a high ring on one side and a
 * low ring on the other and averages to zero, which is correct, but a
 * point in a narrow gorge only reads as enclosed at the near radius.
 */
function basinDepth(dir: THREE.Vector3, ownDisplay: number): number {
  const east = new THREE.Vector3(0, 1, 0).cross(dir);
  if (east.lengthSq() < 1e-8) east.set(1, 0, 0);
  east.normalize();
  const north = dir.clone().cross(east).normalize();
  const probe = new THREE.Vector3();
  let sum = 0;
  let n = 0;
  // 0.030 rad is 0.060 units at radius 2, about 6.5 px on screen; 0.060 rad
  // is twice that. Together they cover the scale a drawn patch occupies, so
  // "enclosed" means enclosed at the size the fog is going to be drawn at
  // rather than at some geological scale the viewer cannot see.
  for (const r of [0.03, 0.06]) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      probe.copy(dir)
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
 * Sea fog is a coastal object — advection fog forms when warm moist air
 * runs over a cold current, and it is only *visible as an event* where it
 * comes ashore. But the direction matters as much as the distance, because
 * the direction is how this file identifies a cold current without a
 * current field to read (see `seaFogAt`).
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
      probe.copy(dir)
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
  // Patches are big (22–48 px), so two of them within a patch-width of each
  // other are one blob with a seam down it rather than two banks. 0.075 rad
  // is 0.15 units, which is one large patch diameter.
  const MIN_SEPARATION = 0.075;
  const MAX_SITES = 200;

  const probe = new THREE.Vector3();
  const east = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  /**
   * Valley fog: cold, still, enclosed low ground that is not dry.
   *
   * Every one of these clauses is a rejection that was needed, and the
   * measurement harness reports the mean elevation and mean aridity under
   * the live patches precisely because the failure mode here is silent —
   * fog over the Sahara at noon is a bug, and it is a bug that looks
   * perfectly nice until you notice what is underneath it.
   */
  function valleyFogAt(dir: THREE.Vector3): { strength: number; height: number } | null {
    const h = sampledHeight(dir);
    if (h.raw < SEA_LEVEL) return null;

    // Aridity, with margin. DESERT_ARIDITY_THRESHOLD is 0.52 — the value
    // the paint turns to sand at and the dust storms fire above — so a
    // patch admitted at 0.51 would be sitting on drawn desert. Radiation
    // fog needs the air to be near saturation to begin with; the deserts
    // that do get fog (the Namib) get it off the sea, which is the other
    // kind, below.
    const arid = aridityAt(dir);
    if (arid > DESERT_ARIDITY_THRESHOLD - 0.10) return null;

    // Köppen class 0 is "no data", which the raster returns over open
    // water. A land pixel whose nearest class is no-data is a speck of an
    // island and has no basin worth the name.
    if (climateClassAt(dir) === 0) return null;

    // Cold enough for the night to reach the dew point, warm enough not to
    // be the ice cap. `temperatureAt` is 1 at the equator at sea level and
    // falls with latitude and with elevation, so this window is roughly the
    // temperate belt plus the cooler subtropical highlands — and because
    // the elevation term is in there, a high basin qualifies at a latitude
    // where the lowland does not. That is the Anatolian and Iranian
    // plateaux and the Andean altiplano, which are real fog basins.
    const temperature = temperatureAt(dir, h.raw);
    if (temperature < 0.10 || temperature > 0.62) return null;

    // The pond of cold air. Threshold picked off the measured distribution
    // of `basinDepth` over accepted-climate land: the median is near zero
    // (most land is a slope, and a slope averages out), and 0.010 in
    // display-height units is about the 88th percentile — the genuinely
    // enclosed ground.
    const basin = basinDepth(dir, h.display);
    if (basin < 0.010) return null;

    // Moisture. Averaging the two solstices gives the mean of what
    // `precipitationAtSeason` will hand the shader; the seasonal half is
    // baked separately below and finished in the shader.
    const wet = 0.5 * (precipitationAtSeason(dir, 1) + precipitationAtSeason(dir, -1));
    if (wet < 0.22) return null;

    // Deeper basin, damper air, colder night: all three make it thicker.
    // Nothing here is allowed to reach 1 — a fog that hid its valley
    // completely would just be a white disc, and the point of the effect is
    // that you can still tell there is a valley under it.
    const enclosure = THREE.MathUtils.smoothstep(basin, 0.010, 0.045);
    const damp = THREE.MathUtils.smoothstep(wet, 0.22, 0.55);
    const cool = THREE.MathUtils.smoothstep(temperature, 0.66, 0.30);
    const strength = 0.45 + 0.55 * (enclosure * 0.5 + damp * 0.25 + cool * 0.25);

    // Where the top of the fog sits. The floor of the basin plus a
    // fraction of the way up to the surrounding ridge, so the ridge stands
    // out of it and the depth test does the rest. Capped: a patch in a
    // 3000 m walled basin should not become a dome.
    const fill = Math.min(basin * 0.45, 0.02) + 0.004;
    return { strength, height: radius + (h.display + fill) * bumpHeight };
  }

  /**
   * Sea fog: a cold sea under warmer air, coming ashore.
   *
   * There is no ocean-current field on this globe and adding one for this
   * would be exactly the duplication the header refuses. But the cold
   * currents that make the world's fog coasts are not scattered at random:
   * they are a consequence of the same zonal wind the clouds already ride,
   * and they land in two recognisable geometries, both of which are
   * readable from the elevation raster plus the Köppen aridity that is
   * already loaded.
   *
   * (a) Eastern boundary upwelling. On the east side of every ocean basin
   *     — i.e. the WEST coast of a continent, so the land lies to the east
   *     of the water — the subtropical gyre drags surface water toward the
   *     equator and cold water comes up to replace it. This is why every
   *     one of these coasts has a desert on it: Namib (Benguela), Atacama
   *     and Peru (Humboldt), Baja and California, Western Sahara
   *     (Canary), and the Western Australian coast (Leeuwin's cool
   *     season). The desert IS the tell, so the rule can use the aridity
   *     of the adjoining land as its evidence — and it means this rule
   *     puts fog on the seaward side of the same sand the valley rule is
   *     carefully kept off. Both readings are correct; that contrast is
   *     the most interesting thing this file does.
   * (b) Cold high-latitude coasts where a polar current runs down a west
   *     side of a basin, i.e. the land lies to the WEST of the water:
   *     Labrador off Newfoundland, Oyashio off Hokkaido and the Kurils,
   *     and the Falklands current off Patagonia. The Grand Banks is the
   *     foggiest water on earth. The mirror case — land to the east at
   *     these latitudes, i.e. the west coasts of Europe and Alaska — is a
   *     WARM current and is excluded, which is correct: Ireland is not a
   *     fog coast in this sense.
   */
  function seaFogAt(dir: THREE.Vector3): { strength: number; height: number } | null {
    if (sampledHeight(dir).raw >= SEA_LEVEL) return null;
    const coast = coastFrom(dir);
    if (!coast) return null;

    east.copy(up).cross(dir);
    if (east.lengthSq() < 1e-8) return null;
    east.normalize();
    // +1 when the land lies east of this water, −1 when it lies west.
    const eastward = coast.toLand.dot(east);
    const latitude = Math.abs(Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1))) * (180 / Math.PI);

    // What the adjoining land is like — the class raster's ring search
    // already resolves a water pixel to its nearest land class, but read
    // the land point itself so the evidence is unambiguous.
    const shore = dir.clone().addScaledVector(coast.toLand, coast.distance * 1.15).normalize();
    const shoreArid = aridityAt(shore);
    const temperature = temperatureAt(dir, 0);

    let strength = 0;
    if (eastward > 0.35 && latitude > 11 && latitude < 46 && shoreArid > 0.44) {
      // (a) upwelling coast. Strongest where the desert is driest, which is
      // where the upwelling is strongest — Namibia and northern Chile.
      strength = 0.55 + 0.45 * THREE.MathUtils.smoothstep(shoreArid, 0.44, 0.72);
    } else if (eastward < -0.30 && latitude > 38 && latitude < 62 && temperature < 0.42) {
      // (b) cold polar current. Colder water, thicker fog.
      strength = 0.5 + 0.5 * THREE.MathUtils.smoothstep(temperature, 0.42, 0.16);
    } else {
      return null;
    }

    // Thin it out with distance from the shore. A fog bank a long way out
    // to sea is invisible as an event; it is the one that has the coast
    // under one half of it that reads.
    strength *= 1 - THREE.MathUtils.smoothstep(coast.distance, 0.03, 0.075);
    if (strength < 0.2) return null;

    // On the water, a hair above the glass sea shell so it does not z-fight
    // with it. It genuinely is at sea level; that is the difference between
    // this and a stratus deck.
    return { strength, height: radius + GLASS_SEA_HEIGHT * bumpHeight + 0.006 };
  }

  function tooClose(dir: THREE.Vector3): boolean {
    for (const s of sites) {
      if (s.dir.dot(dir) > Math.cos(MIN_SEPARATION)) return true;
    }
    return false;
  }

  // Equal-area rejection sampling, the same way the dust storms pick their
  // 28 sites: uniform in sin(latitude) so the poles are not oversampled.
  let attempts = 0;
  while (sites.length < MAX_SITES && attempts < 90000) {
    attempts++;
    const sinLat = rand() * 2 - 1;
    const lon = rand() * Math.PI * 2;
    const c = Math.sqrt(Math.max(0, 1 - sinLat * sinLat));
    probe.set(c * Math.cos(lon), sinLat, c * Math.sin(lon));

    // Sea fog is tried first only because it is the cheaper test to fail.
    const kind = sampledHeight(probe).raw >= SEA_LEVEL ? VALLEY : SEA;
    const found = kind === VALLEY ? valleyFogAt(probe) : seaFogAt(probe);
    if (!found) continue;
    if (tooClose(probe)) continue;

    const dir = probe.clone();
    let centre = dir;
    if (kind === SEA) {
      // Slide the centre toward the shore so the disc straddles the
      // coastline: half of it on the water, half of it over the first few
      // kilometres of land. Fog that stops dead at the waterline is a
      // texture; fog that has swallowed the headland is weather.
      const coast = coastFrom(dir);
      if (coast) centre = dir.clone().addScaledVector(coast.toLand, coast.distance * 0.55).normalize();
    }

    const wet = 0.5 * (precipitationAtSeason(centre, 1) + precipitationAtSeason(centre, -1));
    const swingRaw = 0.5 * (precipitationAtSeason(centre, 1) - precipitationAtSeason(centre, -1));
    const lat = Math.asin(THREE.MathUtils.clamp(centre.y, -1, 1));

    sites.push({
      dir: centre,
      kind,
      // Sea fog banks are the bigger object in nature and the bigger object
      // here: 0.13–0.22 units is 28–48 px, valley fog 0.10–0.16 is 22–35 px.
      size: kind === SEA ? 0.13 + rand() * 0.09 : 0.10 + rand() * 0.06,
      strength: found.strength,
      height: found.height,
      wet,
      // `precipitationAtSeason` already folds the hemisphere into its own
      // answer, so taking the difference of the two solstices carries the
      // sign out with it; the shader only has to multiply by the tilt.
      swing: swingRaw,
      // Same convention as terrain's latLonToDir, so a front here runs the
      // same way round the planet as the cloud bands do.
      lon: Math.atan2(centre.z, -centre.x) - Math.PI,
      // The wind is `zonalWind`, imported. All that is done to it here is
      // the conversion to a rate of change of longitude, clamped exactly as
      // clouds.ts clamps it so 1/cos does not run away at the pole.
      omega: zonalWind(lat) / Math.max(Math.cos(lat), 0.22),
      elevation: sampledHeight(centre).display,
      aridity: aridityAt(centre),
    });
  }

  const COUNT = sites.length;

  // -------------------------------------------------------------------
  // The disc
  // -------------------------------------------------------------------
  // Built once, in the XZ plane, and bent down into the sphere's own
  // curvature so that a patch 0.22 units across does not have its rim
  // 0.012 units underground. Rings rather than a single fan because the
  // bend needs interior vertices to bend; the alpha ramp itself is
  // computed in the fragment shader from the local coordinate, so the
  // tessellation is not what makes the edge soft.
  //
  // HOW THE SOFT EDGE IS MADE, AND WHAT IT DELIBERATELY IS NOT. The cloud
  // deck's fringe took several attempts and its worst failure was a grey
  // ring round every lump (see the top of clouds.ts): a second, larger,
  // fainter copy of each nodule, lit by the same shading as the core, so
  // the part of the halo that showed past the core's silhouette was the
  // halo's own *underside* — the darkest part of it — and every cloud got
  // outlined in grey. Nothing here repeats that scheme. There is exactly
  // one layer, it is unlit, and its alpha falls off from the middle to
  // nothing; because the colour is constant across the disc the fringe
  // physically cannot come out darker than the core. The edge is where the
  // alpha runs out, not where a second object sticks out.
  const RINGS = 4;
  const SEGMENTS = 40;
  const positions: number[] = [];
  const indices: number[] = [];
  positions.push(0, 0, 0);
  for (let ring = 1; ring <= RINGS; ring++) {
    const r = ring / RINGS;
    for (let s = 0; s < SEGMENTS; s++) {
      const a = (s / SEGMENTS) * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      // A unit disc is scaled by `size` and laid on a sphere of `radius`;
      // the sagitta at fraction r of it is (size*r)^2 / (2*radius). Written
      // in unit-disc space it is r^2 * size / (2*radius) — but `size` is
      // per instance, so the mean patch size is used and the residual is
      // under a thousandth of a unit, a tenth of a pixel.
      positions.push(x, -(r * r) * (0.15 / (2 * radius)), z);
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
  const matrices = new Float32Array(COUNT * 16);

  const m = new THREE.Matrix4();
  const north = new THREE.Vector3();
  for (let i = 0; i < COUNT; i++) {
    const s = sites[i];
    // The disc's own +Y is the local outward normal; the other two axes
    // are the compass frame, which is why the shader can shift a bank
    // "onshore" and "downwind" by writing into x and z.
    east.copy(up).cross(s.dir);
    if (east.lengthSq() < 1e-8) east.set(1, 0, 0);
    east.normalize();
    north.copy(s.dir).cross(east).normalize();
    m.makeBasis(east.multiplyScalar(s.size), s.dir.clone().multiplyScalar(s.size), north.multiplyScalar(s.size));
    m.setPosition(s.dir.x * s.height, s.dir.y * s.height, s.dir.z * s.height);
    m.toArray(matrices, i * 16);

    aStrength[i] = s.strength;
    aKind[i] = s.kind;
    aSeed[i] = rand() * 100;
    aWet[i] = s.wet;
    aSwing[i] = s.swing;
    aLon[i] = s.lon;
    aOmega[i] = s.omega;
  }
  geometry.setAttribute('aStrength', new THREE.InstancedBufferAttribute(aStrength, 1));
  geometry.setAttribute('aKind', new THREE.InstancedBufferAttribute(aKind, 1));
  geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(aSeed, 1));
  geometry.setAttribute('aWet', new THREE.InstancedBufferAttribute(aWet, 1));
  geometry.setAttribute('aSwing', new THREE.InstancedBufferAttribute(aSwing, 1));
  geometry.setAttribute('aLon', new THREE.InstancedBufferAttribute(aLon, 1));
  geometry.setAttribute('aOmega', new THREE.InstancedBufferAttribute(aOmega, 1));

  const uniforms = {
    uTime: { value: 0 },
    uSeasonTilt: seasonUniforms.uSeasonTilt,
    uSunDir: { value: sunDirection },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    // Both faces: a disc tangent to the sphere is seen from its outside
    // face near the centre of the globe's disc and very nearly edge-on at
    // the limb, and a backface-culled patch at the limb flickers out.
    side: THREE.DoubleSide,
    vertexShader: `
      attribute float aStrength;
      attribute float aKind;
      attribute float aSeed;
      attribute float aWet;
      attribute float aSwing;
      attribute float aLon;
      attribute float aOmega;
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

        vec3 local = position;
        // Motion, in the shader, as everything that moves on this globe is.
        // A sea fog bank does not sit still off the coast; it comes in and
        // it goes back out, and the swing here is in the disc's own local
        // frame so "in" is toward the land for every bank on the planet
        // without a single per-instance direction being stored. 0.35 of a
        // patch radius is 0.05 units, about 5 px of travel — small, but a
        // patch edge crossing a headland is legible where the patch moving
        // bodily would just look like the mesh sliding.
        float roll = sin(uTime * 0.09 + aSeed) * 0.35;
        local.xz += vec2(0.0, roll) * step(0.5, aKind);

        vec4 world = instanceMatrix * vec4(local, 1.0);
        vec3 worldNormal = normalize(mat3(modelMatrix) * normalize((instanceMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz));
        gl_Position = projectionMatrix * modelViewMatrix * world;

        float sun = dot(worldNormal, uSunDir);
        // Which side of the terminator this is: the globe turns about its
        // own +Y under a fixed key light, so a point's velocity is
        // ŷ × p, and a point moving *toward* the sun is one where dawn is
        // either just past or about to happen. Without this test the fog
        // would be symmetric about noon and would form at dusk, which is
        // backwards — radiation fog needs a whole night of cooling behind
        // it, so it is a dawn object and not an evening one.
        float morning = smoothstep(-0.25, 0.10, dot(normalize(cross(vec3(0.0, 1.0, 0.0), worldNormal)), uSunDir));

        // Unlit, but not un-darkened: the night side of this globe is very
        // dark and a fog bank glowing white on it would read as a hole in
        // the planet. This is the same soft terminator width the globe's
        // own shader uses.
        vLight = 0.16 + 0.84 * smoothstep(-0.18, 0.30, sun);

        // Is it foggy here, now.
        //
        // Valley fog: forms through the second half of the night and burns
        // off within an hour or two of sunrise, which is exactly what
        // everyone who has driven through the Central Valley in January has
        // seen. The globe turns once in about 40 s, so the whole life of a
        // patch — thickening in the dark, standing at sunrise, gone by
        // mid-morning — plays out in about 10 s and comes round again.
        float dawn = (1.0 - smoothstep(0.04, 0.34, sun)) * morning;
        // Season: fog is a cold-half-year object at these latitudes. Local
        // winter is where the season tilt and the latitude disagree in
        // sign, the same expression the falling snow uses.
        float winter = clamp(-uSeasonTilt * worldNormal.y, -1.0, 1.0);
        float valley = dawn * (0.55 + 0.45 * winter);

        // Sea fog: not a dawn object at all — the Grand Banks and the
        // Namib coast are fogged in at any hour, because the cooling is
        // done by the water and not by the night. What makes it come and
        // go is the passage of air over the cold water, so it is gated on
        // a wave in longitude carried by the shared `zonalWind`, the same
        // front mechanism the snow uses. Three fronts round the planet,
        // and the tilt on the latitude keeps them from reading as rings.
        float front = 0.5 + 0.5 * sin(3.0 * (aLon - aOmega * uTime) + 2.2 * worldNormal.y);
        // Rainfall at this instant of the year, finishing
        // precipitationAtSeason from the baked profile. An upwelling coast
        // is bone dry, so this must not be able to switch it off; it only
        // decides how much of a front's passage the place is open for.
        float wetNow = clamp(aWet + aSwing * uSeasonTilt, 0.0, 1.0);
        float gate = 0.52 - 0.30 * smoothstep(0.05, 0.45, wetNow);
        float sea = smoothstep(gate, gate + 0.22, front) * (0.75 + 0.25 * (1.0 - smoothstep(0.0, 0.5, sun)));

        float live = mix(valley, sea, step(0.5, aKind));
        // 0.90 at the core. Fog hides the ground — that is the whole
        // difference between this and a low cloud — but not completely:
        // at 1.0 a patch is a white hole and the viewer loses the fact
        // that there is a valley under it.
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
        // The rim, breathing. A circle is the one shape fog never has, and
        // a fog bank's edge is also the part of it that moves most: three
        // low harmonics at different rates make an outline that is never
        // twice the same and never resolves into a polygon. This is done
        // per fragment against the *radius*, so it costs no geometry and
        // no second layer — the lesson of the grey halo ring is that a
        // fringe must not be a separate object.
        float warp = 1.0
          + 0.16 * sin(3.0 * a + vSeed + uTime * 0.22)
          + 0.10 * sin(5.0 * a - vSeed * 1.7 - uTime * 0.15)
          + 0.06 * sin(8.0 * a + vSeed * 0.4 + uTime * 0.31);
        float rr = r / max(warp, 0.4);
        // Flat-topped: solid across the middle two thirds, then out. A
        // gaussian-looking patch reads as a puff of smoke; fog has a body
        // with a definite extent and a fraying edge.
        float body = 1.0 - smoothstep(0.55, 1.0, rr);
        if (body <= 0.003) discard;

        // Sea fog is a touch bluer and valley fog a touch warmer, because
        // one of them is lit by a cold sea under an overcast and the other
        // is lit by a low orange sun. Both stay very desaturated: this is
        // water in air, not paint.
        vec3 tint = mix(vec3(0.965, 0.955, 0.935), vec3(0.925, 0.945, 0.965), step(0.5, vKind));
        gl_FragColor = vec4(tint * vLight, vAlpha * body);
      }
    `,
  });

  const mesh = new THREE.InstancedMesh(geometry, material, COUNT);
  mesh.instanceMatrix = new THREE.InstancedBufferAttribute(matrices, 16);
  mesh.instanceMatrix.needsUpdate = true;
  // The discs are placed by their instance matrices and moved by the
  // shader, so the bounding sphere three would compute from the unit disc
  // in `position` is meaningless; the whole system is on screen whenever
  // the globe is.
  mesh.frustumCulled = false;
  // Fog sits under the cloud deck and over the ground. Both are drawn with
  // depth testing, so ordering only matters against the other transparent
  // systems; leaving this at the default put fog above the rain veils,
  // which is wrong — a veil hangs from a cloud down through this height.
  mesh.renderOrder = 1;

  return {
    mesh,
    tick: (t: number) => {
      uniforms.uTime.value = t;
    },
  };
}
