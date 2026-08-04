import * as THREE from 'three';
import { mulberry32 } from './spatialHash';
import { VOLCANOES, sampledHeight } from './terrain';

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

export function buildEruptions(radius: number, bumpHeight: number, pixelRatio: number): Eruptions {
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

  let p = 0;
  VOLCANOES.forEach((v, vi) => {
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
      sizes[p] = 2.0 + rand() * 4.0;
      // where in the column this particle sits, so the plume has width and
      // billows to one side rather than rising as a needle
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand());
      jitter[p * 2] = Math.cos(a) * r;
      jitter[p * 2 + 1] = Math.sin(a) * r;
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

  const uniforms = {
    uTime: { value: 0 },
    uIntensity: { value: new THREE.Vector4() },
    uRadius: { value: radius },
    uPixelRatio: { value: pixelRatio },
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
        vec3 side = normalize(cross(up, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0));
        vec3 other = cross(up, side);

        // Rise fast, then slow and spread: the column loses its momentum
        // and the ash flattens out against the top of the troposphere,
        // which is what gives a real eruption its anvil.
        float rise = (1.0 - pow(1.0 - life, 2.2)) * 0.42 * power;
        float spread = (0.012 + pow(life, 1.8) * 0.11) * power;
        // and it leans downwind as it climbs
        float lean = pow(life, 1.6) * 0.09 * power;

        vec3 lateral = side * (aJitter.x * spread + lean) + other * (aJitter.y * spread);
        vec3 pos = normalize(aOrigin + lateral) * (uRadius + rise + 0.004);

        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        // ash particles grow as the cloud dissipates
        gl_PointSize = aSize * (0.5 + life * 1.6) * power * uPixelRatio * (60.0 / -mvPosition.z);
        vAlpha = power * (1.0 - smoothstep(0.45, 1.0, life)) * smoothstep(0.0, 0.05, life);
      }
    `,
    fragmentShader: `
      varying float vLife;
      varying float vAlpha;
      void main() {
        vec2 d = gl_PointCoord - vec2(0.5);
        float mask = 1.0 - smoothstep(0.15, 0.5, length(d));
        if (vAlpha <= 0.002 || mask <= 0.002) discard;
        // incandescent at the vent, cooling to grey ash within the first
        // fraction of the climb
        vec3 hot = vec3(1.0, 0.55, 0.17);
        vec3 ash = vec3(0.34, 0.31, 0.30);
        vec3 color = mix(hot, ash, smoothstep(0.0, 0.16, vLife));
        gl_FragColor = vec4(color, vAlpha * mask * 0.75);
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
  VOLCANOES.forEach((_, vi) => {
    const mat = new THREE.MeshBasicMaterial({
      color: '#ff7a24',
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    ventMaterials.push(mat);
    const bead = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 6), mat);
    bead.position.copy(summits[vi]).multiplyScalar(1.001);
    bead.frustumCulled = false;
    group.add(bead);
  });

  // Active cones erupt often; dormant ones are rare events, not never.
  const schedules: Schedule[] = VOLCANOES.map((v) =>
    v.active
      ? { gap: 14, spread: 18, duration: 11, nextAt: 3 + rand() * 12, startedAt: -1e9 }
      : { gap: 70, spread: 60, duration: 8, nextAt: 30 + rand() * 60, startedAt: -1e9 },
  );

  const intensity = uniforms.uIntensity.value;

  const tick = (t: number) => {
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
      ventMaterials[i].opacity = Math.min(1, power * 1.6);
    }
    uniforms.uTime.value = t;
  };

  return { group, tick };
}
