import * as THREE from 'three';
import { mulberry32 } from './spatialHash';
import {
  DESERT_ARIDITY_THRESHOLD,
  SEA_LEVEL,
  VOLCANOES,
  aridityAt,
  climateClassAt,
  precipitationAtSeason,
  sampledHeight,
} from './terrain';
import { zonalWind } from './clouds';

// ---------------------------------------------------------------------
// Eruptions
// ---------------------------------------------------------------------
// Four volcanoes have been standing on this globe since the terrain was
// first sculpted — Kilauea, Vesuvius, Cotopaxi and Fuji, each at its real
// coordinates, two of them marked in the data as active. Being "active"
// showed up as a glowing pool of lava in the crater and nothing else: a
// static detail you have to already be looking at the right spot to find.
//
// An eruption is the opposite kind of thing. It is an *event* — it starts
// somewhere on the globe, draws the eye there, runs for a while and stops
// — and a diorama with events in it is watched differently from one with
// only details in it. So each volcano now keeps a schedule: long quiet
// spells, then a build-up, a peak, and a decay, with the two active cones
// erupting several times as often as the two dormant ones (which do still
// go off occasionally, because a dormant volcano is not an extinct one).
//
// The plume is one Points draw call for all four. Each particle owns which
// volcano it belongs to as a one-hot vec4, so a single vec4 uniform
// carries all four intensities and the shader picks its own with a dot
// product — no dynamic indexing, no per-particle CPU work, and a volcano
// that is not erupting simply scales its particles to nothing.
//
// ---------------------------------------------------------------------
// Dust storms (G51) live in this file too, as a second population
// ---------------------------------------------------------------------
// A haboob is the same object as an ash plume seen from a hundred
// kilometres away: loose material lifted off the ground, carried up in a
// column, leaned over by the wind and dissipating as it goes. The only
// things that differ are the colour, the proportions (a dust wall is wide
// and low where an ash column is narrow and tall) and — the part that
// makes it worth doing at all — *where and when* it is allowed to happen.
// Everything below the schedule is shared with the eruptions above, which
// is why this is a second population in one file rather than a new module
// re-deriving a particle system that already exists here.
//
// Siting and timing both come from fields the globe already has, never
// from hand-placed coordinates: `climateClassAt` picks the Köppen B
// classes (BWh/BWk/BSh/BSk — the Sahara, Arabia, the Gobi, the Kalahari,
// the Australian interior and the Atacama fall out of that on their own),
// `aridityAt` rejects the fringes, and `precipitationAtSeason` is read at
// the moment a storm is scheduled so that a monsoon-fringe desert simply
// does not raise dust during its wet half of the year. Drift is
// `zonalWind` from clouds.ts — the same profile the sky and the ash use.

const PARTICLES_PER_VOLCANO = 260;

interface Schedule {
  /** seconds between eruptions, and the random spread on top of that */
  gap: number;
  spread: number;
  /** how long one eruption lasts */
  duration: number;
  nextAt: number;
  startedAt: number;
}

export interface Eruptions {
  group: THREE.Group;
  tick: (t: number) => void;
}

/** How many desert sites keep a dust-storm schedule. See buildDustStorms. */
const DUST_SITES = 28;
const PARTICLES_PER_STORM = 90;

/**
 * The globe's season clock, −1 northern midwinter .. +1 northern midsummer.
 *
 * Shared by reference from main.ts, the same way the falling snow and the
 * cloud deck take it. The first version of the dust storms recomputed it
 * from elapsed time against a local copy of the 60-second year, which was
 * one constant in two places waiting to drift — and the storms' own
 * schedule had already aliased against that year once (see the cycle
 * length below), so a second copy of it was the last thing this file
 * needed.
 */
let seasonClock: { uSeasonTilt: { value: number } } | null = null;

function northernSummerAt(t: number): number {
  // The fallback keeps the module standing alone if no clock is passed;
  // main.ts always passes one.
  return seasonClock ? seasonClock.uSeasonTilt.value : Math.sin((t * Math.PI * 2) / 60);
}

interface DustSite {
  centre: THREE.Vector3;
  /** −1..1, normalised against the strongest zonal wind on the planet */
  wind: number;
  schedule: Schedule;
}

/**
 * Seasonal dust storms over the real deserts.
 *
 * ### Where
 *
 * Sites are found by rejection sampling in equal-area coordinates and kept
 * only where all three of these agree: the elevation raster says land, the
 * Köppen class is one of the four B classes, and the baked aridity field is
 * past `DESERT_ARIDITY_THRESHOLD` — the same number the paint uses to start
 * blending toward desert, so a storm can never stand on ground that does
 * not already look like desert. The class test is what keeps the ice caps
 * out: by rainfall they are deserts too (§2-19), and an aridity test alone
 * would eventually put a tan dust wall on Antarctica.
 *
 * Sites are also held a minimum angle apart, because rejection sampling
 * with no spacing rule puts most of its hits in the largest desert and the
 * Sahara ends up owning two thirds of the planet's dust.
 *
 * ### When
 *
 * At the moment a site's schedule comes round, `precipitationAtSeason` is
 * read *then*, for that site, at the current season, and the storm is only
 * allowed to start in proportion to how dry the ground is right now. A
 * steppe on a monsoon fringe (the Sahel, the Gobi, the Kalahari) shuts down
 * completely in its wet half. The hyper-arid cores never get wet, so they
 * are additionally weighted toward their own local summer, which is when
 * they really do blow: the point is that the dry season is a cause here,
 * not a schedule that happens to look seasonal.
 *
 * ### How big
 *
 * At the shipped camera one world unit is about 108 px, so proportions had
 * to be chosen before anything was built (§2-21). A real haboob is ~1 km
 * tall and ~100 km wide; on a globe of radius 2 that is 0.0003 and 0.03
 * units, i.e. 0.03 px and 3 px — invisible, and invisible in the specific
 * way that is indistinguishable from not being drawn. So the wall is drawn
 * at the scale the rest of this diorama uses: a rise of 0.10 units (≈ 11 px
 * tall) against a downwind reach of about 0.21 units (≈ 23 px), which with
 * the ~30 device-px particle sprites reads as a low tan smear roughly
 * 60 px across — flatter and wider than the ash column above it, which is
 * the one silhouette difference that tells the two apart at this size.
 *
 * One extra Points draw call for every storm on the planet.
 */
function buildDustStorms(
  radius: number,
  bumpHeight: number,
  pixelRatio: number,
  windAt: (lat: number) => number,
): { points: THREE.Points; tick: (t: number) => void } {
  const rand = mulberry32(90210);
  const probe = new THREE.Vector3();
  const sites: DustSite[] = [];

  // The trades and the westerlies differ by a factor of three, so the raw
  // profile is normalised against its own peak (the mid-latitude
  // westerlies) exactly as the volcano plumes above do. The shader's drift
  // constant then means "how far a storm in the fastest wind on the planet
  // travels", which is a number that can be judged by eye.
  const peakWind = Math.max(1e-6, Math.abs(windAt(Math.PI / 4)));

  // ~0.15 rad ≈ 950 km at this globe's implied scale: close enough that the
  // Sahara still gets several sites, far enough that it cannot get them all.
  const MIN_SEPARATION = Math.cos(0.15);
  for (let attempt = 0; attempt < 24000 && sites.length < DUST_SITES; attempt++) {
    // uniform in sin(latitude), i.e. uniform per unit area — the same
    // sampling the cloud and flake seeders use
    const sinLat = rand() * 2 - 1;
    const c = Math.sqrt(Math.max(0, 1 - sinLat * sinLat));
    const lon = rand() * Math.PI * 2;
    probe.set(c * Math.cos(lon), sinLat, c * Math.sin(lon));

    if (sampledHeight(probe).raw < SEA_LEVEL) continue;
    const climate = climateClassAt(probe);
    // 4..7 are BWh, BWk, BSh, BSk — the deserts and the steppes
    if (climate < 4 || climate > 7) continue;
    if (aridityAt(probe) <= DESERT_ARIDITY_THRESHOLD) continue;
    if (sites.some((s) => s.centre.dot(probe) > MIN_SEPARATION)) continue;

    const lat = Math.asin(THREE.MathUtils.clamp(probe.y, -1, 1));
    sites.push({
      centre: probe.clone(),
      wind: windAt(lat) / peakWind,
      // About two storms per site per year. The first schedule tried had a
      // 49 second cycle against this globe's 60 second year, which aliased:
      // every site kept coming round at nearly the same point of its own
      // calendar, so a season gate that works could not show up in the
      // measurement at all (the Sahara's summer/winter split came out
      // 342/363 with a rule that should give roughly 1.6:1). The cycle is
      // now about half the year, which both fixes the beat and gets the
      // sample count up.
      schedule: {
        gap: 14,
        spread: 16,
        duration: 9,
        nextAt: rand() * 40,
        startedAt: -1e9,
      },
    });
  }

  const count = sites.length * PARTICLES_PER_STORM;
  const positions = new Float32Array(count * 3);
  const origins = new Float32Array(count * 3);
  const ground = new Float32Array(count);
  const power = new Float32Array(count);
  const wind = new Float32Array(count);
  const phases = new Float32Array(count);
  const speeds = new Float32Array(count);
  const sizes = new Float32Array(count);
  const jitter = new Float32Array(count * 2);

  let p = 0;
  sites.forEach((site) => {
    // Deserts are not at sea level — the Gobi sits above 1000 m and the
    // Atacama higher still — and a storm anchored at `radius` would be
    // buried in its own ground there, which is the mistake the volcano
    // summits above already had to be sampled to avoid.
    const lift = sampledHeight(site.centre).display * bumpHeight;
    for (let i = 0; i < PARTICLES_PER_STORM; i++, p++) {
      positions[p * 3] = site.centre.x * (radius + lift);
      positions[p * 3 + 1] = site.centre.y * (radius + lift);
      positions[p * 3 + 2] = site.centre.z * (radius + lift);
      origins[p * 3] = site.centre.x;
      origins[p * 3 + 1] = site.centre.y;
      origins[p * 3 + 2] = site.centre.z;
      ground[p] = lift;
      wind[p] = site.wind;
      phases[p] = rand();
      // A slower turnover than the ash: dust hangs, it does not jet.
      speeds[p] = 0.10 + rand() * 0.10;
      // Deliberately smaller sprites than the ash column's 4..11. The
      // storm's whole shape is a 4:1 downwind streak, and at 3.5..8 the
      // sprites are wide enough to blur that back into a round blob — the
      // first render came out 60x35 px when the geometry underneath it was
      // more like 60x15.
      // Scaled by 0.45, same reasoning as the ash column's sprite cut: the
      // world-space footprint below drops to 1/5, and cutting sprite size
      // by the same amount would just pack the old sprites five times
      // tighter rather than actually shrinking the wall.
      sizes[p] = (2.6 + rand() * 3.4) * 0.45;
      const a = rand() * Math.PI * 2;
      // sqrt for a disc, then flattened on the across-wind axis in the
      // shader — a haboob is a front, not a puff
      const r = Math.sqrt(rand());
      jitter[p * 2] = Math.cos(a) * r;
      jitter[p * 2 + 1] = Math.sin(a) * r;
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aOrigin', new THREE.BufferAttribute(origins, 3));
  geometry.setAttribute('aGround', new THREE.BufferAttribute(ground, 1));
  const powerAttribute = new THREE.BufferAttribute(power, 1);
  powerAttribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aPower', powerAttribute);
  geometry.setAttribute('aWind', new THREE.BufferAttribute(wind, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aJitter', new THREE.BufferAttribute(jitter, 2));

  const uniforms = {
    uTime: { value: 0 },
    uRadius: { value: radius },
    uPixelRatio: { value: pixelRatio },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: `
      attribute vec3 aOrigin;
      attribute float aGround;
      attribute float aPower;
      attribute float aWind;
      attribute float aPhase;
      attribute float aSpeed;
      attribute float aSize;
      attribute vec2 aJitter;
      uniform float uTime;
      uniform float uRadius;
      uniform float uPixelRatio;
      varying float vLife;
      varying float vAlpha;

      void main() {
        // There are far too many sites for the one-hot vec4 the eruptions
        // use, and indexing a uniform array by a per-vertex value is the
        // thing that comment warns about, so the storm's strength is an
        // attribute the tick writes — a couple of thousand floats a frame,
        // and only when a strength actually changed.
        float power = aPower;
        float life = fract(aPhase + uTime * aSpeed);
        vLife = life;

        vec3 up = normalize(aOrigin);
        // same handedness note as the ash column: +Z is *decreasing*
        // longitude under this project's convention, so east is -side
        vec3 side = normalize(cross(up, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0));
        vec3 other = cross(up, side);
        vec3 east = -side;

        // Low and quick, where the ash is tall and slow. Dust is lifted by
        // the gust front rather than thrown by a vent, so it reaches its
        // ceiling almost at once and then just spreads along it.
        // Cut to 1/5 scale on request, same as the ash column.
        float rise = (1.0 - pow(1.0 - life, 1.5)) * 0.02 * power;
        float spread = (0.002 + pow(life, 1.2) * 0.011) * power;

        // The whole wall travels downwind — this scales with age, not with
        // height. That is the difference from the ash column, where drift
        // scales with height because shear bends a standing column; a
        // haboob is not standing anywhere, it is the front itself moving.
        // Also cut by 1/5 (0.155 -> 0.031) to match.
        float drift = aWind * life * 0.031 * power;

        float along = spread * (1.0 + abs(aWind) * 1.8);
        float across = spread * (1.0 - abs(aWind) * 0.35);

        vec3 lateral = east * (aJitter.x * along + drift) + other * (aJitter.y * across);
        vec3 pos = normalize(aOrigin + lateral) * (uRadius + aGround + rise + 0.002);

        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        gl_PointSize = aSize * (0.6 + life * 1.5) * power * uPixelRatio * (60.0 / -mvPosition.z);
        // held translucent throughout: a dust wall this size on this globe
        // is a stain on the ground, and at full opacity it turns into a
        // second, tan cloud deck
        vAlpha = power * (1.0 - smoothstep(0.35, 1.0, life)) * smoothstep(0.0, 0.08, life) * 0.55;
      }
    `,
    fragmentShader: `
      varying float vLife;
      varying float vAlpha;
      void main() {
        vec2 d = gl_PointCoord - vec2(0.5);
        float mask = 1.0 - smoothstep(0.12, 0.5, length(d));
        if (vAlpha <= 0.002 || mask <= 0.002) discard;
        // The dense leading edge is the sand the desert is actually made
        // of; what stays behind is the fine pale fraction that hangs. Both
        // are sampled from the desert paint's own family so the storm reads
        // as the ground getting up rather than as a brown cloud arriving.
        vec3 near = vec3(0.62, 0.45, 0.27);
        vec3 haze = vec3(0.80, 0.69, 0.53);
        vec3 color = mix(near, haze, smoothstep(0.05, 0.6, vLife));
        gl_FragColor = vec4(color, vAlpha * mask * 0.7);
      }
    `,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;

  const tick = (t: number) => {
    const northernSummer = northernSummerAt(t);
    let changed = false;
    for (let i = 0; i < sites.length; i++) {
      const site = sites[i];
      const s = site.schedule;
      if (t >= s.nextAt) {
        // The season is read here, at this site, at this instant — not
        // baked at build time. A storm therefore cannot outlive the
        // conditions that started it, which is the causal direction §3
        // keeps asking for: the wet season does not stop the dust, there
        // simply is no loose dry dust to lift.
        const rainNow = precipitationAtSeason(site.centre, northernSummer);
        const dryness = 1 - THREE.MathUtils.smoothstep(rainNow, 0.10, 0.34);
        // The hyper-arid cores are dry all year, so dryness alone would
        // make them storm year-round. Their real season is thermal — the
        // Saharan haboob season is the hot half, and so is Australia's —
        // so the local summer carries the rest of the weighting.
        const localSummer = site.centre.y >= 0 ? northernSummer : -northernSummer;
        const warm = 0.35 + 0.65 * (0.5 + 0.5 * localSummer);
        if (rand() < dryness * warm) {
          s.startedAt = t;
        }
        s.nextAt = t + s.duration + s.gap + rand() * s.spread;
      }
      const age = (t - s.startedAt) / s.duration;
      // A gust front arrives quickly and the haze it leaves takes a long
      // time to settle — the same asymmetry as the eruptions, drawn out
      // further because settling dust is slower than a vent going quiet.
      const value =
        age < 0 || age > 1 ? 0 : Math.min(1, age * 5) * Math.pow(1 - age, 0.9);
      const base = i * PARTICLES_PER_STORM;
      if (power[base] !== value) {
        power.fill(value, base, base + PARTICLES_PER_STORM);
        changed = true;
      }
    }
    if (changed) powerAttribute.needsUpdate = true;
    uniforms.uTime.value = t;
  };

  return { points, tick };
}

export function buildEruptions(
  radius: number,
  bumpHeight: number,
  pixelRatio: number,
  /**
   * The fixed key light's direction, if the caller wants the vents to know
   * about night. Optional so the module still stands alone.
   */
  sunDirection?: THREE.Vector3,
  /**
   * The same zonal wind profile the clouds ride, in radians of longitude
   * per second, positive eastward. Optional for the same reason, but
   * passing it is what stops the ash and the clouds directly above it
   * disagreeing about which way the air is moving.
   */
  windAt?: (lat: number) => number,
  /**
   * The globe's own season clock, shared by reference (see seasonClock).
   * Optional only so the module still stands alone.
   */
  season?: { uSeasonTilt: { value: number } },
): Eruptions {
  seasonClock = season ?? null;
  const group = new THREE.Group();
  const rand = mulberry32(31337);
  const count = VOLCANOES.length * PARTICLES_PER_VOLCANO;

  const positions = new Float32Array(count * 3);
  const origins = new Float32Array(count * 3);
  const owner = new Float32Array(count * 4);
  const phases = new Float32Array(count);
  const speeds = new Float32Array(count);
  const sizes = new Float32Array(count);
  const jitter = new Float32Array(count * 2);

  // Where each cone's summit actually is. The crater sits on displaced
  // terrain that the volcano itself pushed up (see displayHeight's volcano
  // boost), so this has to be sampled rather than assumed to be at sea
  // level plus a guess — a plume starting a few hundredths of a unit too
  // low comes out of the mountain's flank.
  const summits = VOLCANOES.map((v) => {
    const surface = radius + sampledHeight(v.center).display * bumpHeight;
    return v.center.clone().multiplyScalar(surface);
  });

  // How many separate billows a column is built from, and how far each
  // one's own particles scatter around its centre.
  //
  // Sampling `jitter` uniformly over the whole disc (the previous scheme)
  // put a particle anywhere with equal likelihood, which is exactly what a
  // single smoothly-filled disc looks like once a few hundred soft round
  // sprites overlap — a column that balloons out as one uniform, edgeless
  // "poof" rather than the lumpy, cauliflower-textured mass a real ash
  // column is. Grouping particles into a handful of off-centre sub-clumps
  // first, then scattering tightly *within* each clump, gives the
  // cross-section internal structure — several billows jostling for room —
  // instead of one gradient. The same idea as the ranked lumps clouds.ts
  // builds real geometry for, done cheaply here with points because a
  // point-sprite plume cannot afford per-lump meshes.
  const CLUMPS_PER_VOLCANO = 6;
  // Pulled in from 0.36, alongside the clump centres below moving in from
  // 0.28-0.78 to 0.2-0.5: a wide scatter was most of what read as a big
  // grey spread rather than a column — every clump reached far enough
  // toward the rim that the six of them tiled the whole disc back into one
  // shape again, just with lumpy edges. Keeping both tighter leaves the
  // cross-section a narrower core, which is what the elongation below
  // (`aJitter` doubling as a stretch axis, see the vertex shader) needs
  // to actually read as a rising stream instead of a fattened smudge.
  const clumpSpread = 0.22;

  let p = 0;
  VOLCANOES.forEach((v, vi) => {
    const clumps = Array.from({ length: CLUMPS_PER_VOLCANO }, () => {
      const a = rand() * Math.PI * 2;
      // Kept off the very centre and short of the rim: a clump centred at
      // the column's axis would just recreate the uniform disc at a smaller
      // radius, and one right at the edge would clip against the mask below.
      const r = 0.2 + rand() * 0.3;
      return { x: Math.cos(a) * r, y: Math.sin(a) * r };
    });
    for (let i = 0; i < PARTICLES_PER_VOLCANO; i++, p++) {
      const s = summits[vi];
      positions[p * 3] = s.x;
      positions[p * 3 + 1] = s.y;
      positions[p * 3 + 2] = s.z;
      origins[p * 3] = v.center.x;
      origins[p * 3 + 1] = v.center.y;
      origins[p * 3 + 2] = v.center.z;
      owner[p * 4 + vi] = 1;
      phases[p] = rand();
      speeds[p] = 0.16 + rand() * 0.14;
      // Cut from 4.0 + rand()*7.0, but only partway: on request, the whole
      // column shrinks — see the spread cut in the vertex shader below,
      // which this pairs with — but the sprites still have to overlap
      // enough to cover their own gaps, or the column stops looking like
      // smoke and starts looking like a faint scatter of grey dots (see the
      // note by gl_PointSize for the same trade-off measured too far the
      // other way).
      // Scaled by 0.45 alongside the 1/5 cut to the column's world-space
      // footprint below (rise/spread/drift): shrinking the footprint alone
      // would have packed the same size sprites five times tighter, which
      // reads as a denser small blob rather than a smaller plume. Cutting
      // sprite size less than the footprint (0.45 vs 0.2) keeps individual
      // puffs visible instead of the column collapsing into one dot.
      sizes[p] = (3.2 + rand() * 4.6) * 0.45;
      // where in the column this particle sits, so the plume has width and
      // billows to one side rather than rising as a needle
      const clump = clumps[i % CLUMPS_PER_VOLCANO];
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * clumpSpread;
      jitter[p * 2] = THREE.MathUtils.clamp(clump.x + Math.cos(a) * r, -1, 1);
      jitter[p * 2 + 1] = THREE.MathUtils.clamp(clump.y + Math.sin(a) * r, -1, 1);
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aOrigin', new THREE.BufferAttribute(origins, 3));
  geometry.setAttribute('aOwner', new THREE.BufferAttribute(owner, 4));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aJitter', new THREE.BufferAttribute(jitter, 2));

  // Each cone stands at a fixed latitude, so the wind over it is a
  // constant — four numbers decided once, not a field to sample per
  // particle. Normalised against the strongest wind the profile produces
  // (the mid-latitude westerlies) so the shader's drift constant means
  // "how far a plume in the fastest wind on the planet gets blown", which
  // is a number that can be tuned by eye.
  //
  // With no profile supplied this degrades to a single modest easterly
  // drift shared by every cone — which is what the old hardcoded lean was.
  // The module keeps working standalone, and wiring the real wind in is
  // then strictly an improvement rather than the difference between a
  // plume that bends and one that stands straight up.
  const windPerVolcano = new THREE.Vector4(0.45, 0.45, 0.45, 0.45);
  if (windAt) {
    const peak = Math.max(1e-6, Math.abs(windAt(Math.PI / 4)));
    VOLCANOES.forEach((_, vi) => {
      const lat = Math.asin(THREE.MathUtils.clamp(summits[vi].clone().normalize().y, -1, 1));
      windPerVolcano.setComponent(vi, windAt(lat) / peak);
    });
  }

  const uniforms = {
    uTime: { value: 0 },
    uIntensity: { value: new THREE.Vector4() },
    uRadius: { value: radius },
    uPixelRatio: { value: pixelRatio },
    uWind: { value: windPerVolcano },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: `
      attribute vec3 aOrigin;
      attribute vec4 aOwner;
      attribute float aPhase;
      attribute float aSpeed;
      attribute float aSize;
      attribute vec2 aJitter;
      uniform float uTime;
      uniform vec4 uIntensity;
      uniform vec4 uWind;
      uniform float uRadius;
      uniform float uPixelRatio;
      varying float vLife;
      varying float vAlpha;

      void main() {
        // one dot product instead of indexing a uniform array by a
        // per-vertex value, which not every driver is happy about
        float power = dot(aOwner, uIntensity);
        float life = fract(aPhase + uTime * aSpeed);
        vLife = life;

        vec3 up = normalize(aOrigin);
        // cross(up, +Y) points along the parallel. At up = +X it is +Z, and
        // +Z is *decreasing* longitude under this project's convention
        // (lon = atan2(z,-x)*180/PI - 180), so east is -side. Getting this
        // backwards is invisible on a still frame and obvious the moment
        // the plume is compared with the clouds passing over it.
        vec3 side = normalize(cross(up, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0));
        vec3 other = cross(up, side);
        vec3 east = -side;

        // Rise fast, then slow and spread: the column loses its momentum
        // and the ash flattens out against the top of the troposphere,
        // which is what gives a real eruption its anvil.
        //
        // Both cut hard on request, alongside the smaller sprites and
        // tighter clumps above: even the first cut here (0.012 base spread
        // -> 0.007, 0.42 max rise unchanged) still read from above — which
        // is mostly how this globe is seen — as a round grey dome sitting
        // on the vent, because a column's own *height* barely shows in a
        // near-overhead view. Cutting the footprint (both of these) rather
        // than only the height is what actually shrinks the dome as seen
        // from where it is actually seen.
        // Rise cut hard on request: "the smoke plume is unsatisfying, a
        // small cloud-like puff that streams sideways would read better."
        // A tall anvil column is a texture-book ash eruption, but from the
        // near-overhead angle this globe is mostly seen at, height barely
        // shows — what showed instead was a fat grey dome sitting on the
        // vent. Lowering the rise and leaning harder on downwind streaking
        // (below) turns that dome into something that reads as a small
        // cloud being blown off the summit, which is both more legible at
        // this scale and closer to what the user actually asked for.
        // Cut to 1/5 scale on request (0.12 -> 0.024, 0.005/0.026 ->
        // 0.001/0.0052): the whole plume as a feature on the globe, not
        // just its sprites or its lean.
        float rise = (1.0 - pow(1.0 - life, 2.2)) * 0.024 * power;
        float spread = (0.001 + pow(life, 1.8) * 0.0052) * power;

        // Downwind drift, with shear.
        //
        // This used to be a single hardcoded lean, in one fixed direction,
        // identical at every volcano on the planet — so a cone in the
        // trades leaned the same way as one in the westerlies while the
        // clouds directly above them drifted opposite ways. The wind now
        // comes from the same profile the clouds ride, per volcano.
        //
        // It scales with height rather than with age because that is what
        // shear means: air moves faster the higher you go, so the top of a
        // column is dragged much further than its base, and the column
        // ends up bent rather than tilted. Squaring the height ratio is
        // what turns a straight lean into the hockey-stick profile a real
        // ash column has.
        float wind = dot(aOwner, uWind);
        float heightFrac = rise / max(0.024 * power, 1e-4);
        // heightFrac is a 0..1 ratio, so this constant is itself a
        // world-space distance and gets the same 1/5 cut as rise/spread
        // (0.85 -> 0.17) — otherwise a five-times-smaller column would
        // have kept leaning just as far as the old full-size one and come
        // out looking like a wind-blown streak longer than the plume
        // itself is tall.
        float drift = wind * heightFrac * heightFrac * 0.17 * power;

        // The spread goes with the wind too: a plume in still air puffs out
        // as a circle, one in a wind is drawn out into a streak that is far
        // longer downwind than it is wide. Without this the anvil stayed a
        // round blob that had merely been moved sideways. Widened further
        // (2.6 -> 3.4) to match the flatter, more wind-drawn cloud shape.
        float along = spread * (1.0 + abs(wind) * 3.4);
        float across = spread * (1.0 - abs(wind) * 0.55);

        vec3 lateral = east * (aJitter.x * along + drift) + other * (aJitter.y * across);
        vec3 pos = normalize(aOrigin + lateral) * (uRadius + rise + 0.004);

        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mvPosition;

        // ash particles grow as the cloud dissipates. Trimmed on request
        // alongside the tighter spread above, but kept well short of the
        // cut that made the very first pass at this nearly disappear: this
        // system reads as solid smoke through the *overlap* of a few
        // hundred sprites, not through any one sprite's own opacity, so a
        // sprite shrunk too far stops contributing enough coverage for the
        // column to still look like a body of smoke rather than a haze.
        gl_PointSize = aSize * (0.5 + life * 1.0) * power * uPixelRatio * (60.0 / -mvPosition.z);
        vAlpha = power * (1.0 - smoothstep(0.45, 1.0, life)) * smoothstep(0.0, 0.05, life);
      }
    `,
    fragmentShader: `
      varying float vLife;
      varying float vAlpha;
      void main() {
        vec2 d = gl_PointCoord - vec2(0.5);
        // A tight core: the wide, gentle falloff the very first version of
        // this had was most of what made overlapping sprites melt into one
        // grey fog instead of reading as a body of smoke with an edge.
        float mask = 1.0 - smoothstep(0.24, 0.46, length(d));
        if (vAlpha <= 0.002 || mask <= 0.002) discard;
        // incandescent at the vent, cooling within the first fraction of
        // the climb to a pale grey — lightened from a dark sooty ash
        // (0.34/0.31/0.30) toward something that reads as a small cloud
        // being blown off the summit rather than a chimney's smoke, to
        // match the shape change above.
        vec3 hot = vec3(1.0, 0.55, 0.17);
        vec3 ash = vec3(0.62, 0.60, 0.58);
        vec3 color = mix(hot, ash, smoothstep(0.0, 0.16, vLife));
        // Raised from 0.75, alongside the trim above: the streak/flow shape
        // this is meant to read as needs its sprites to actually cover the
        // pixels they sit on rather than half-showing the ocean through
        // them — a plume that is mostly see-through does not look "too
        // big", it looks like it is not there at all, which is worse.
        gl_FragColor = vec4(color, vAlpha * mask * 0.9);
      }
    `,
  });

  const plume = new THREE.Points(geometry, material);
  plume.frustumCulled = false;
  group.add(plume);

  // The vent itself: a small emissive bead sitting in the crater that
  // brightens with the eruption. The ash column above it is grey almost
  // immediately, so without this there is nothing actually glowing at the
  // bottom of it and the whole thing reads as smoke from a chimney.
  const ventMaterials: THREE.MeshBasicMaterial[] = [];
  const ventBeads: THREE.Mesh[] = [];
  VOLCANOES.forEach((_, vi) => {
    const mat = new THREE.MeshBasicMaterial({
      color: '#ff7a24',
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    ventMaterials.push(mat);
    const bead = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), mat);
    bead.position.copy(summits[vi]).multiplyScalar(1.001);
    bead.frustumCulled = false;
    ventBeads.push(bead);
    group.add(bead);
  });

  // Hot rock is the one thing in this scene whose brightness is not the
  // sun's to give. Everything else here — the ash, the sea, the paint —
  // goes dark when the globe turns away from the light, and the vents used
  // to go with it, so a volcano erupting on the night side was a grey
  // smudge on black. In life it is the opposite: daylight washes a vent
  // out to a dull orange smear, and darkness is when it reads as molten.
  // The vent is emissive already; all that was missing was letting it know
  // which side of the terminator it is on.
  const ventWorld = new THREE.Vector3();
  const ventQuat = new THREE.Quaternion();
  const nightAtVent = (vi: number): number => {
    if (!sunDirection) return 0;
    group.getWorldQuaternion(ventQuat);
    ventWorld.copy(summits[vi]).normalize().applyQuaternion(ventQuat);
    // the same soft terminator the globe's own city lights use, so a vent
    // does not brighten a beat before or after the lights around it
    const sun = ventWorld.dot(sunDirection);
    return THREE.MathUtils.clamp((0.16 - sun) / 0.28, 0, 1);
  };

  // Active cones erupt often; dormant ones are rare events, not never.
  //
  // The active schedule used to be gap 14 ± 18, duration 11 — against a
  // ~14-32s gap and an 11s eruption, the two active cones (Kilauea,
  // Cotopaxi) were live close to half the time each, so on a planet with
  // only four volcanoes there was very rarely a moment with nothing
  // erupting. Widened the gap and trimmed the duration so an eruption
  // reads as an event you catch happening, not a standing feature of the
  // globe.
  const schedules: Schedule[] = VOLCANOES.map((v) =>
    v.active
      ? { gap: 55, spread: 40, duration: 8, nextAt: 8 + rand() * 40, startedAt: -1e9 }
      : { gap: 70, spread: 60, duration: 8, nextAt: 30 + rand() * 60, startedAt: -1e9 },
  );

  const intensity = uniforms.uIntensity.value;

  // The deserts' own weather, sharing this file's particle machinery. It is
  // added to the same group so it inherits the globe's spin, and driven
  // from the same tick so there is one clock for everything in here.
  //
  // `windAt` is defaulted rather than left optional for this one: the ash
  // plume can stand straight up without a profile and still be an ash
  // plume, but a dust storm that does not lean is just a brown circle, and
  // the profile it should lean by already exists in clouds.ts. Writing a
  // second one here is the split this codebase keeps having to undo.
  const dust = buildDustStorms(radius, bumpHeight, pixelRatio, windAt ?? zonalWind);
  group.add(dust.points);

  const tick = (t: number) => {
    dust.tick(t);
    for (let i = 0; i < schedules.length; i++) {
      const s = schedules[i];
      if (t >= s.nextAt) {
        s.startedAt = t;
        s.nextAt = t + s.duration + s.gap + rand() * s.spread;
      }
      const age = (t - s.startedAt) / s.duration;
      // a fast build-up and a long tail-off, rather than a symmetric bump:
      // eruptions start suddenly and subside slowly
      const power =
        age < 0 || age > 1 ? 0 : Math.min(1, age * 6) * Math.pow(1 - age, 0.7);
      intensity.setComponent(i, power);
      // Kept clearly visible by day — the vent is what stops the ash column
      // reading as smoke from a chimney, which is why it was put here — but
      // given room to become the brightest thing on that side of the globe
      // once the sun is off it. The bead grows a little too: a glow throws
      // light around itself in the dark, and a bead that only brightens
      // without spreading reads as a decal being turned up.
      const night = nightAtVent(i);
      ventMaterials[i].opacity = Math.min(1, power * 1.6 * (0.7 + 0.75 * night));
      ventBeads[i].scale.setScalar(1 + night * 0.55);
    }
    uniforms.uTime.value = t;
  };

  return { group, tick };
}
