import * as THREE from 'three';
import { mulberry32 } from './spatialHash';
import { sampledHeight, snowinessAt } from './terrain';

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
        vAlpha = aSnow * season * ends * 0.42;
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
