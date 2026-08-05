import * as THREE from 'three';
import { zonalWind } from './clouds';
import { mulberry32 } from './spatialHash';
import { precipitationProfileAt, sampledHeight, snowinessAt } from './terrain';

// ---------------------------------------------------------------------
// Falling snow
// ---------------------------------------------------------------------
// The globe already changes colour with the seasons — a snow line that
// creeps down toward the equator in local winter and retreats in local
// summer, painted into the terrain shader. That is the *result* of winter;
// this is winter happening. Actual flakes drifting down over the ground
// that is turning white is a very different read from the ground simply
// being white, and it costs one draw call to add.
//
// Every flake is a point, and all the motion is in the vertex shader:
// there is no per-frame CPU work here at all beyond writing the clock into
// a uniform. Each one owns a base direction on the sphere, a phase, and a
// fall speed; its height is the fractional part of (phase + time × speed)
// mapped from the cloud deck down to the ground, so a flake that lands
// immediately reappears at the top, and the field never needs restocking.
//
// Where they fall used to be decided by latitude alone — the flake's own
// `dir.y` against a snow line, a copy of the expression the globe's paint
// uses. That is only half a climate. Latitude cannot know that the
// Himalaya, the Andes, the Alps and the Rockies are white all year at
// latitudes where the lowlands never see a flake, and it cannot know that
// a maritime temperate ocean at 55° is not snowy at all. So it snowed on
// the North Atlantic and never on Everest.
//
// The flakes each own a *fixed* base direction, which is the thing that
// makes the fix cheap: a fixed point on the sphere can be classified once,
// at build time, by the same `snowinessAt` the terrain paint reads —
// climate and elevation, not a latitude band — and the answer baked into a
// vertex attribute. The shader then has real climate available to it
// without being able to call into any of it. Sites are rejection-sampled
// against that same field, so all 2600 flakes land somewhere it actually
// snows instead of being spread evenly over a band that is mostly not
// snowing; the visible density goes up without the count going up.
//
// Two systems computing "where is it snowy" from two different expressions
// is exactly the split this project keeps having to undo (see §2-6 and the
// urbanAt unification in the doc), so the falling snow reads the paint's
// field rather than re-deriving one.
//
// Fixed sites are the right answer to *where snow belongs*; they were the
// wrong answer to *where it is snowing now*. Measured before this change:
// of 2600 flakes, 2390 were falling at any given instant and the set barely
// moved — 10.7% of it turned over in ten seconds, and all of that churn was
// the fade at the top and bottom of a flake's own fall, not weather. The
// planet's snow was therefore a fixture: a viewer could watch for a minute
// and see nothing begin and nothing end.
//
// What decides "now" is the same pair the rain uses — the season clock and
// `precipitationAtSeason` — plus a front that drifts. The first two are
// cheap to keep honest without touching the CPU each frame: the site is
// fixed, so its rainfall *profile* can be baked (mean amount, and how hard
// the year swings it), and the shader replays `precipitationAtSeason`'s own
// arithmetic against the season uniform. That gives a Mediterranean coast
// that snows in the winter half and a monsoon slope that does not, from the
// same numbers the clouds and the rain veils read.
//
// The drift is a wave in longitude carried by `zonalWind(lat)`, the wind
// the clouds and the ash plumes already share — a second wind field here
// would be the same duplication the paragraph above is about. Four fronts
// around the planet make each band about 1.6 world units wide, roughly
// 170 px at the shipped camera, so an edge is a thing you can watch cross a
// mountain range rather than a flicker; they come round every 30–90 s
// depending on the latitude's wind, against a 60 s year.
//
// Rainfall sets how much of that cycle is open: a genuinely wet snow
// climate snows through most of the passage of a front, a dry one only at
// its very crest. Note it is rainfall, not cloud cover, that does the
// gating. Gating on the actual clouds is settled as impossible at this
// cloud budget — mean cover is 5.5% of the globe and 1.0% over the snow
// sites, so it deletes the snow (§2-19, G36). Do not re-try it.

export interface Snowfall {
  points: THREE.Points;
  tick: (t: number) => void;
}

export function buildSnowfall(
  radius: number,
  seasonUniforms: { uSeasonTilt: { value: number } },
  pixelRatio: number,
): Snowfall {
  const rand = mulberry32(9911);
  // Enough to read as weather, not as fog. This started at 5200 and the
  // polar cap came out as a solid white hood: the flakes live on a shell,
  // and at the limb the line of sight runs the long way through that
  // shell, so any density that looks right face-on stacks up into an
  // opaque rind at the edge. Fewer, smaller, fainter flakes in a thinner
  // shell fixes all of that at once.
  const COUNT = 2600;

  const dirs = new Float32Array(COUNT * 3);
  const phases = new Float32Array(COUNT);
  const speeds = new Float32Array(COUNT);
  const sizes = new Float32Array(COUNT);
  /** how snowy this flake's own patch of ground is, all year round */
  const snowiness = new Float32Array(COUNT);
  /** how much this flake needs local winter before it may fall */
  const seasonality = new Float32Array(COUNT);
  /** mean annual rainfall at this site, the `amount` of its profile */
  const wetness = new Float32Array(COUNT);
  /** how far the year swings that rainfall, already folded for hemisphere */
  const swing = new Float32Array(COUNT);
  /** the site's longitude, which is what a front sweeps along */
  const lons = new Float32Array(COUNT);
  /** and how fast longitude runs under the wind at its latitude */
  const omegas = new Float32Array(COUNT);

  const probe = new THREE.Vector3();

  /**
   * How much snow belongs at this point, 0..1.
   *
   * Over land this is the terrain's own field, so the flakes agree with
   * the paint by construction. Over water `snowinessAt` returns 0 — the
   * paint has nothing to whiten there — but the polar seas are a real and
   * large part of what reads as "winter" on a globe, and losing the
   * Arctic Ocean entirely was a worse picture than the bug being fixed.
   * They get their own, weaker allowance, gated hard on latitude so it
   * cannot leak into the temperate oceans that were the original
   * complaint.
   */
  function snowWeight(dir: THREE.Vector3): number {
    const h = sampledHeight(dir).raw;
    const land = snowinessAt(dir, h);
    if (land > 0) return land;
    // sin(latitude), not degrees: 0.84 is about 57°, 0.93 about 68°. The
    // first pass opened this at 0.72 (≈46°) and measured 82 flakes over the
    // open North Atlantic at 55° — the temperate-ocean snow that was the
    // original complaint, reintroduced by the exemption meant to save the
    // Arctic. It has to start where the sea itself starts reading as ice.
    const lat = Math.abs(dir.y);
    return lat <= 0.84 ? 0 : Math.min(1, (lat - 0.84) / 0.09) * 0.5;
  }

  // Rejection sampling against that field. Capped: if the climate data
  // somehow yields almost nothing snowy, this must not spin forever — it
  // falls back to placing the flake wherever the last candidate landed,
  // where its baked weight will simply keep it invisible.
  let accepted = 0;
  let attempts = 0;
  const MAX_ATTEMPTS = COUNT * 200;
  while (accepted < COUNT && attempts < MAX_ATTEMPTS) {
    attempts++;
    const sinLat = rand() * 2 - 1;
    const lon = rand() * Math.PI * 2;
    const c = Math.sqrt(Math.max(0, 1 - sinLat * sinLat));
    probe.set(c * Math.cos(lon), sinLat, c * Math.sin(lon));

    const w = snowWeight(probe);
    if (w <= 0.02 || rand() > w) continue;

    const i = accepted++;
    dirs[i * 3] = probe.x;
    dirs[i * 3 + 1] = probe.y;
    dirs[i * 3 + 2] = probe.z;
    snowiness[i] = w;
    // Somewhere permanently white — a deep polar cap, a high summit — snows
    // whatever the season. Somewhere only marginally snowy is snowy
    // *because* it is winter there, and should stop when it thaws. One
    // number carries both: the less reliably snowy the site, the more it
    // has to wait for its own winter.
    seasonality[i] = 1 - Math.min(1, w);

    // The weather half, baked once because the site never moves. This is
    // `precipitationAtSeason` taken apart: it is
    // `amount * (1 + seasonality * summerBias * localSummer)`, and the only
    // term in it that changes with the clock is `localSummer`, which is the
    // season uniform with the hemisphere sign folded in. Everything else is
    // a property of this point, so the shader can finish the expression for
    // the cost of one multiply-add and still agree exactly with what the
    // clouds and the rain veils compute on the CPU.
    const profile = precipitationProfileAt(probe);
    wetness[i] = profile.amount;
    swing[i] = profile.seasonality * profile.summerBias * (probe.y >= 0 ? 1 : -1);
    // Same convention as terrain's latLonToDir, so a front here runs the
    // same way round the planet as the cloud bands overhead.
    lons[i] = Math.atan2(probe.z, -probe.x) - Math.PI;
    // The wind is `zonalWind`, shared; what is done to it here is only the
    // conversion from a speed along the great circle to a rate of change of
    // longitude, clamped exactly as clouds.ts clamps it so the 1/cos does
    // not run away at the pole itself.
    const lat = Math.asin(THREE.MathUtils.clamp(probe.y, -1, 1));
    omegas[i] = zonalWind(lat) / Math.max(Math.cos(lat), 0.22);

    phases[i] = rand();
    speeds[i] = 0.05 + rand() * 0.05;
    sizes[i] = 1.0 + rand() * 1.5;
  }
  // Any shortfall keeps its zeroed weight and never draws.
  for (let i = accepted; i < COUNT; i++) {
    dirs[i * 3 + 1] = 1;
    phases[i] = rand();
    speeds[i] = 0.05;
    sizes[i] = 1;
  }

  const geometry = new THREE.BufferGeometry();
  // position is required by three's frustum culling and by the point
  // material's own plumbing; the shader below ignores it and uses aDir, so
  // it is filled with the base direction scaled to the top of the fall.
  const positions = new Float32Array(COUNT * 3);
  for (let i = 0; i < COUNT * 3; i++) positions[i] = dirs[i] * (radius + 0.1);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aDir', new THREE.BufferAttribute(dirs, 3));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aSnow', new THREE.BufferAttribute(snowiness, 1));
  geometry.setAttribute('aSeasonal', new THREE.BufferAttribute(seasonality, 1));
  geometry.setAttribute('aWet', new THREE.BufferAttribute(wetness, 1));
  geometry.setAttribute('aSwing', new THREE.BufferAttribute(swing, 1));
  geometry.setAttribute('aLon', new THREE.BufferAttribute(lons, 1));
  geometry.setAttribute('aOmega', new THREE.BufferAttribute(omegas, 1));

  const uniforms = {
    uTime: { value: 0 },
    uSeasonTilt: seasonUniforms.uSeasonTilt,
    uRadius: { value: radius },
    uPixelRatio: { value: pixelRatio },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: `
      attribute vec3 aDir;
      attribute float aPhase;
      attribute float aSpeed;
      attribute float aSize;
      attribute float aSnow;
      attribute float aSeasonal;
      attribute float aWet;
      attribute float aSwing;
      attribute float aLon;
      attribute float aOmega;
      uniform float uTime;
      uniform float uSeasonTilt;
      uniform float uRadius;
      uniform float uPixelRatio;
      varying float vAlpha;

      void main() {
        float fall = fract(aPhase + uTime * aSpeed);
        // from just under the cloud deck down to the ground
        float height = mix(0.16, 0.005, fall);

        // Snow does not come straight down. A slow swirl about the axis,
        // plus a small sideways wobble at each flake's own phase, is the
        // difference between falling snow and a descending grid of dots.
        float swirl = uTime * 0.02 + aPhase * 6.2831;
        float wobble = sin(uTime * 1.7 + aPhase * 40.0) * 0.004;
        vec3 axis = vec3(0.0, 1.0, 0.0);
        vec3 tangent = normalize(cross(axis, aDir) + vec3(1e-5));
        vec3 dir = normalize(aDir + tangent * (wobble + sin(swirl) * 0.006));

        vec3 worldish = dir * (uRadius + height);
        vec4 mvPosition = modelViewMatrix * vec4(worldish, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        gl_PointSize = aSize * uPixelRatio * (60.0 / -mvPosition.z);

        // Where it snows is baked (aSnow, from the terrain's own field).
        // All that is left for the shader is *when*: local winter is where
        // the season tilt and this latitude disagree in sign. A site that
        // is reliably white all year ignores that almost entirely; a
        // marginal one waits for its winter and thaws out of the picture
        // afterwards.
        float winter = clamp(-uSeasonTilt * dir.y, 0.0, 1.0);
        float season = mix(1.0, winter, aSeasonal);
        // fade in as it leaves the cloud and out as it reaches the ground,
        // so flakes neither pop into existence nor pile up as a bright ring
        float ends = smoothstep(0.0, 0.12, fall) * (1.0 - smoothstep(0.82, 1.0, fall));

        // Is it snowing *here, now*. Rainfall at this instant of the year,
        // finishing precipitationAtSeason from the baked profile.
        float wetNow = clamp(aWet * (1.0 + aSwing * uSeasonTilt), 0.0, 1.0);
        // The front: one wave in longitude drifting at this latitude's own
        // wind. The tilt on aDir.y is what stops it reading as a set of
        // rings around the axis — the band crosses a coastline at an angle,
        // the way a front does.
        float front = 0.5 + 0.5 * sin(4.0 * (aLon - aOmega * uTime) + 2.6 * aDir.y);
        // How much of the front's passage this place is open for. Measured
        // over the snow sites the mean rainfall is 0.196 against a planet
        // mean of 0.393 — snow country is dry country — so the edges are
        // set low: at 0.42 a site snows through most of a front, at 0.06 it
        // only catches the crest, and the difference between the two is
        // what makes the snow arrive in one place while it stops in
        // another instead of the whole field pulsing together.
        float openness = smoothstep(0.10, 0.32, wetNow);
        float gate = 0.85 - 0.80 * openness;
        float live = smoothstep(gate, gate + 0.16, front);
        vAlpha = aSnow * season * ends * live * 0.42;
      }
    `,
    fragmentShader: `
      varying float vAlpha;
      void main() {
        // a round, soft flake rather than the hard square a point defaults to
        vec2 d = gl_PointCoord - vec2(0.5);
        float mask = 1.0 - smoothstep(0.2, 0.5, length(d));
        if (vAlpha <= 0.001 || mask <= 0.001) discard;
        gl_FragColor = vec4(vec3(0.97, 0.98, 1.0), vAlpha * mask);
      }
    `,
  });

  const points = new THREE.Points(geometry, material);
  // the whole shell of flakes is always "in view" when the globe is
  // (they are placed by the shader, so the bounding sphere three computes
  // from the position attribute would be wrong anyway)
  points.frustumCulled = false;

  return {
    points,
    tick: (t: number) => {
      uniforms.uTime.value = t;
    },
  };
}
