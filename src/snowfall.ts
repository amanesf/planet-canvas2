import * as THREE from 'three';
import { mulberry32 } from './spatialHash';

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
// Where they are *visible* is decided in the same shader, from the same
// two quantities the globe's own snow line uses: the season tilt and the
// flake's own latitude. That way the flakes are always falling exactly
// over the hemisphere that is currently white, and stop when it thaws —
// rather than being a separate effect that has to be kept in step by hand.

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
  const COUNT = 5200;

  const dirs = new Float32Array(COUNT * 3);
  const phases = new Float32Array(COUNT);
  const speeds = new Float32Array(COUNT);
  const sizes = new Float32Array(COUNT);

  for (let i = 0; i < COUNT; i++) {
    // Snow only ever falls in the cold latitudes, so there is no point
    // spending flakes on the tropics — they would be invisible every
    // frame of the year. Sampled uniformly in sin(latitude) *within* the
    // cold band, which keeps the density even over the area it covers.
    const sign = rand() < 0.5 ? 1 : -1;
    const sinLat = sign * (0.34 + rand() * 0.66);
    const lon = rand() * Math.PI * 2;
    const c = Math.sqrt(Math.max(0, 1 - sinLat * sinLat));
    dirs[i * 3] = c * Math.cos(lon);
    dirs[i * 3 + 1] = sinLat;
    dirs[i * 3 + 2] = c * Math.sin(lon);
    phases[i] = rand();
    speeds[i] = 0.05 + rand() * 0.05;
    sizes[i] = 1.4 + rand() * 2.2;
  }

  const geometry = new THREE.BufferGeometry();
  // position is required by three's frustum culling and by the point
  // material's own plumbing; the shader below ignores it and uses aDir, so
  // it is filled with the base direction scaled to the top of the fall.
  const positions = new Float32Array(COUNT * 3);
  for (let i = 0; i < COUNT * 3; i++) positions[i] = dirs[i] * (radius + 0.2);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aDir', new THREE.BufferAttribute(dirs, 3));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

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
      uniform float uTime;
      uniform float uSeasonTilt;
      uniform float uRadius;
      uniform float uPixelRatio;
      varying float vAlpha;

      void main() {
        float fall = fract(aPhase + uTime * aSpeed);
        // from just under the cloud deck down to the ground
        float height = mix(0.30, 0.005, fall);

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

        // The same test the globe's painted snow line makes: local winter
        // is where the season tilt and this latitude disagree in sign, and
        // the line itself moves toward the equator the deeper into winter
        // it gets.
        float lat = dir.y;
        float winter = clamp(-uSeasonTilt * lat, 0.0, 1.0);
        float snowLine = mix(0.82, 0.5, winter);
        float inZone = smoothstep(snowLine, snowLine + 0.14, abs(lat));
        // fade in as it leaves the cloud and out as it reaches the ground,
        // so flakes neither pop into existence nor pile up as a bright ring
        float ends = smoothstep(0.0, 0.12, fall) * (1.0 - smoothstep(0.82, 1.0, fall));
        vAlpha = inZone * winter * ends * 0.85;
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
