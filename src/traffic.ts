import * as THREE from 'three';
import { mulberry32 } from './spatialHash';
import { SEA_LEVEL, latLonToDir, sampledHeight, seaLevelRadius } from './terrain';

// ---------------------------------------------------------------------
// Things that are going somewhere
// ---------------------------------------------------------------------
// Everything on this globe so far either sits still (terrain, trees,
// landmarks) or is weather. What it has never had is *traffic* — objects
// with an origin, a destination and a reason to be crossing the frame.
// That is a surprisingly large part of why a model of a world reads as
// inhabited rather than as scenery, and all three kinds here are cheap:
// a handful of small meshes on closed-form paths, no simulation.
//
//   satellites  circular orbits above the globe, tilted every which way,
//               and pointedly *not* parented to the spinning globe — an
//               orbit that turned with the planet under it would be a
//               geostationary ring, which is not what these look like.
//   aircraft    great-circle routes between real cities, climbing out and
//               descending in, each dragging a contrail that thins and
//               fades behind it.
//   ships       crossings between real ports, kept only where walking the
//               raster proves open water the whole way, so no vessel is
//               ever sailing over a continent or calling nowhere.

const UP = new THREE.Vector3(0, 1, 0);

// Souvenir-globe scale, the same joke the landmarks are built on.
//
// These were modelled at something close to their real size relative to a
// two-unit Earth, which is the correct number and the wrong decision: a
// container ship came out a couple of pixels long, so the most alive thing
// in the scene was invisible unless you already knew where to look. On a
// model, the ship is a ship-shaped bead you can actually see.
//
// Then five times over-corrected. Surface traffic keeps a third of that —
// still unmistakably a boat and a plane, no longer a barge the size of
// Ireland. Satellites go all the way back: they are the one thing here
// that is *not* pinned to the surface, so they cross the empty space in
// front of the globe where nothing hides an oversized model, and at 5x
// they were reading as spacecraft flying past the camera rather than as
// specks in orbit.
const SURFACE_TRAFFIC_SCALE = 5 / 3;
const SATELLITE_SCALE = 1;

/** An orthonormal pair spanning the plane through two directions. */
function planeBasis(a: THREE.Vector3, b: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const u = a.clone().normalize();
  const v = b.clone().addScaledVector(u, -b.dot(u));
  if (v.lengthSq() < 1e-8) {
    // degenerate (the two directions are collinear) — any perpendicular will do
    v.copy(Math.abs(u.y) < 0.9 ? UP : new THREE.Vector3(1, 0, 0)).addScaledVector(u, -u.y);
  }
  return [u, v.normalize()];
}

/** Point at angle `angle` along the great circle spanned by u, v. */
function onGreatCircle(
  u: THREE.Vector3,
  v: THREE.Vector3,
  angle: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  return out.copy(u).multiplyScalar(Math.cos(angle)).addScaledVector(v, Math.sin(angle));
}

/** Sit an object on the sphere at `dir`, nose pointed along `heading`. */
function orient(object: THREE.Object3D, dir: THREE.Vector3, heading: THREE.Vector3): void {
  const up = dir.clone().normalize();
  const forward = heading.clone().addScaledVector(up, -heading.dot(up)).normalize();
  const right = new THREE.Vector3().crossVectors(up, forward);
  object.matrix.makeBasis(right, up, forward);
  object.quaternion.setFromRotationMatrix(object.matrix);
}

export interface Traffic {
  group: THREE.Group;
  tick: (t: number) => void;
}

// ---------------------------------------------------------------------
// Satellites
// ---------------------------------------------------------------------

function buildSatelliteMesh(): THREE.Group {
  const satellite = new THREE.Group();

  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: '#d8d2c4',
    roughness: 0.45,
    metalness: 0.5,
    // gold foil is the one instantly recognisable thing about a spacecraft
    emissive: '#3a2a10',
    emissiveIntensity: 0.4,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.03, 0.045), bodyMaterial);
  satellite.add(body);

  // Solar panels: dark blue, and long enough to be the thing you actually
  // see at this scale. A satellite silhouette is two wings and a speck.
  const panelMaterial = new THREE.MeshStandardMaterial({
    color: '#1b2f6b',
    roughness: 0.25,
    metalness: 0.7,
    emissive: '#0a1330',
    emissiveIntensity: 0.6,
    side: THREE.DoubleSide,
  });
  [-1, 1].forEach((s) => {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.003, 0.036), panelMaterial);
    panel.position.x = s * 0.052;
    satellite.add(panel);
  });

  // and the dish, always pointed back down at the planet
  const dish = new THREE.Mesh(
    new THREE.SphereGeometry(0.014, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.45),
    bodyMaterial,
  );
  dish.rotation.x = Math.PI;
  dish.position.y = -0.022;
  satellite.add(dish);

  return satellite;
}

export function buildSatellites(radius: number): Traffic {
  const group = new THREE.Group();
  const rand = mulberry32(778);
  const template = buildSatelliteMesh();

  interface Orbit {
    object: THREE.Group;
    u: THREE.Vector3;
    v: THREE.Vector3;
    height: number;
    omega: number;
    phase: number;
  }
  const orbits: Orbit[] = [];

  for (let i = 0; i < 5; i++) {
    const object = template.clone();
    object.scale.setScalar(SATELLITE_SCALE);
    group.add(object);

    // a random orbital plane: a normal picked off the sphere, and any two
    // perpendiculars to it
    const normal = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
    const seed = Math.abs(normal.y) < 0.9 ? UP : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(normal, seed).normalize();
    const v = new THREE.Vector3().crossVectors(normal, u).normalize();
    const height = 0.52 + rand() * 0.55;
    orbits.push({
      object,
      u,
      v,
      height,
      // lower orbits go round faster, the way they really do
      omega: (0.16 + rand() * 0.05) / Math.pow(1 + height, 1.5) * 2.2 * (rand() < 0.5 ? 1 : -1),
      phase: rand() * Math.PI * 2,
    });
  }

  const pos = new THREE.Vector3();
  const ahead = new THREE.Vector3();

  const tick = (t: number) => {
    orbits.forEach((o) => {
      const angle = o.phase + t * o.omega;
      onGreatCircle(o.u, o.v, angle, pos);
      onGreatCircle(o.u, o.v, angle + 0.01 * Math.sign(o.omega), ahead);
      o.object.position.copy(pos).multiplyScalar(radius + o.height);
      // "up" for a satellite is away from the planet, so the dish under it
      // points down at the ground it is photographing
      orient(o.object, pos, ahead.sub(pos));
    });
  };

  return { group, tick };
}

// ---------------------------------------------------------------------
// Aircraft
// ---------------------------------------------------------------------

// Real airports, so a flight is between two places that exist rather than
// between two arbitrary points on the paint.
/**
 * Exported so the ground can agree with the air: the airfields in
 * landmarks.ts are built at these endpoints rather than from a second list
 * of the same airports, which is the split §2-11 exists to prevent.
 */
export const AIR_ROUTES: [string, [number, number], [number, number]][] = [
  ['羽田 → ホノルル', [35.55, 139.78], [21.32, -157.92]],
  ['ロンドン → ニューヨーク', [51.47, -0.45], [40.64, -73.78]],
  ['ドバイ → シンガポール', [25.25, 55.36], [1.36, 103.99]],
  ['パリ → サンパウロ', [49.01, 2.55], [-23.43, -46.47]],
  ['シドニー → ロサンゼルス', [-33.94, 151.18], [33.94, -118.41]],
  ['北京 → モスクワ', [40.08, 116.58], [55.97, 37.41]],
];

function buildAircraftMesh(): THREE.Group {
  const plane = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: '#eef1f4',
    roughness: 0.35,
    metalness: 0.35,
    emissive: '#ffffff',
    emissiveIntensity: 0.25,
    // faded down on approach and after take-off, see the tick below
    transparent: true,
  });

  const fuselage = new THREE.Mesh(new THREE.CapsuleGeometry(0.006, 0.036, 3, 8), material);
  fuselage.rotation.x = Math.PI / 2; // the local +Z is "forward", see orient()
  plane.add(fuselage);

  // A swept wing, not a straight plank: swept is the shape people read as
  // "airliner" even at four pixels across.
  const wing = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.0025, 0.012), material);
  wing.rotation.y = -0.22;
  plane.add(wing);

  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.002, 0.008), material);
  tail.position.z = -0.021;
  plane.add(tail);

  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.002, 0.012, 0.01), material);
  fin.position.set(0, 0.006, -0.021);
  plane.add(fin);

  return plane;
}

export function buildAircraft(radius: number): Traffic {
  const group = new THREE.Group();
  const rand = mulberry32(2024);

  const TRAIL_POINTS = 42;
  const CRUISE = 0.115;

  interface Flight {
    object: THREE.Group;
    u: THREE.Vector3;
    v: THREE.Vector3;
    /** total angular length of the route */
    span: number;
    duration: number;
    phase: number;
    trail: THREE.Line;
    trailPositions: Float32Array;
    trailAlpha: Float32Array;
    material: THREE.MeshStandardMaterial;
  }
  const flights: Flight[] = [];

  AIR_ROUTES.forEach(([, from, to], i) => {
    const a = latLonToDir(from[0], from[1]);
    const b = latLonToDir(to[0], to[1]);
    const [u, v] = planeBasis(a, b);
    const span = a.angleTo(b);

    const object = buildAircraftMesh();
    object.scale.setScalar(SURFACE_TRAFFIC_SCALE);
    group.add(object);

    // The contrail. A line with per-vertex alpha, rewritten each frame from
    // the aircraft's own path — which is analytic, so "where was it twenty
    // seconds ago" is just the same formula at a smaller angle. No history
    // buffer, and no drift when the frame rate changes.
    const trailPositions = new Float32Array(TRAIL_POINTS * 3);
    const trailAlpha = new Float32Array(TRAIL_POINTS);
    const trailGeometry = new THREE.BufferGeometry();
    trailGeometry.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
    trailGeometry.setAttribute('aAlpha', new THREE.BufferAttribute(trailAlpha, 1));
    const trailMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexShader: `
        attribute float aAlpha;
        varying float vAlpha;
        void main() {
          vAlpha = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying float vAlpha;
        void main() {
          gl_FragColor = vec4(vec3(1.0), vAlpha * 0.5);
        }
      `,
    });
    const trail = new THREE.Line(trailGeometry, trailMaterial);
    trail.frustumCulled = false;
    group.add(trail);

    flights.push({
      object,
      u,
      v,
      span,
      duration: 26 + rand() * 16,
      phase: rand(),
      trail,
      trailPositions,
      trailAlpha,
      material: (object.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial,
    });
    void i;
  });

  const pos = new THREE.Vector3();
  const ahead = new THREE.Vector3();

  /** Altitude at a fraction of the way along the route. */
  const altitudeAt = (f: number) =>
    f < 0 || f > 1 ? 0 : Math.sin(Math.min(1, Math.max(0, f)) * Math.PI) ** 0.35 * CRUISE;

  const tick = (t: number) => {
    flights.forEach((flight) => {
      const progress = ((t / flight.duration + flight.phase) % 1 + 1) % 1;

      onGreatCircle(flight.u, flight.v, progress * flight.span, pos);
      onGreatCircle(flight.u, flight.v, (progress + 0.004) * flight.span, ahead);
      const altitude = altitudeAt(progress);
      flight.object.position.copy(pos).multiplyScalar(radius + altitude);
      orient(flight.object, pos, ahead.sub(pos));

      // fade in on the climb-out and back down on approach, so the wrap
      // from the end of the route to the start of the next one reads as a
      // landing and a take-off rather than as a teleport
      const visible = Math.min(1, progress * 14) * Math.min(1, (1 - progress) * 14);
      flight.object.scale.setScalar(SURFACE_TRAFFIC_SCALE * (0.6 + visible * 0.4));
      flight.material.opacity = visible;

      for (let i = 0; i < TRAIL_POINTS; i++) {
        // each step back is a fixed fraction of the route, so the trail is
        // the same length in the air whatever the flight's duration is
        const back = progress - (i / (TRAIL_POINTS - 1)) * 0.16;
        const clamped = Math.max(0, back);
        onGreatCircle(flight.u, flight.v, clamped * flight.span, pos);
        pos.multiplyScalar(radius + altitudeAt(clamped) - 0.002);
        flight.trailPositions[i * 3] = pos.x;
        flight.trailPositions[i * 3 + 1] = pos.y;
        flight.trailPositions[i * 3 + 2] = pos.z;
        // Thinning with age *and* cut off before the runway: contrails only
        // form in the cold air up at cruise, never down at the airport.
        const age = 1 - i / (TRAIL_POINTS - 1);
        flight.trailAlpha[i] =
          back < 0 ? 0 : age * visible * Math.min(1, altitudeAt(clamped) / (CRUISE * 0.6));
      }
      flight.trail.geometry.attributes.position.needsUpdate = true;
      flight.trail.geometry.attributes.aAlpha.needsUpdate = true;
    });
  };

  return { group, tick };
}

// ---------------------------------------------------------------------
// Ships
// ---------------------------------------------------------------------

/**
 * Real ports, and the single truth about where ships call.
 *
 * Until now the crossings below were found by dropping a random point in
 * the sea, picking a random heading and walking until land stopped it. The
 * lanes that produced are genuinely good — they follow the real shape of
 * the oceans, because they were found against the actual raster — but they
 * began and ended nowhere, at whichever pixel the walk happened to run
 * aground on. That was invisible while nothing was built on the coast; the
 * moment quays exist it becomes a ship sailing past a harbour it never
 * calls at, so the endpoints have to be real and both consumers have to
 * read the same list. `landmarks.ts` builds its quays from this table.
 *
 * The walk itself is kept — see `buildShips`. A great circle between two
 * ports is a straight line that sails through Panama, Africa and the
 * Himalaya; only walking the raster tells you which pairs are actually
 * connected by open water.
 */
export const PORTS: [string, number, number][] = [
  ['上海', 31.23, 121.5],
  ['シンガポール', 1.26, 103.83],
  ['ロッテルダム', 51.95, 4.14],
  ['ハンブルク', 53.54, 9.97],
  ['ロサンゼルス', 33.73, -118.26],
  ['ニューヨーク', 40.67, -74.04],
  ['サントス', -23.98, -46.3],
  ['ダーバン', -29.87, 31.03],
  ['ケープタウン', -33.91, 18.42],
  ['シドニー', -33.86, 151.2],
  ['ジェベル・アリ', 25.01, 55.06],
  ['ムンバイ', 18.94, 72.84],
  ['コロン', 9.36, -79.9],
  ['ポートサイド', 31.25, 32.3],
  ['バルパライソ', -33.03, -71.63],
  ['横浜', 35.45, 139.65],
  ['バンクーバー', 49.29, -123.11],
  ['ラゴス', 6.44, 3.4],
];

function buildShipMesh(): THREE.Group {
  const ship = new THREE.Group();

  const hullMaterial = new THREE.MeshStandardMaterial({
    color: '#8a2f28',
    roughness: 0.6,
    metalness: 0.15,
  });
  // A hull is pointed at one end. A box is not a boat; a box with a wedge
  // on the front is, even at this size.
  const hull = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.009, 0.05), hullMaterial);
  ship.add(hull);
  const bow = new THREE.Mesh(new THREE.ConeGeometry(0.009, 0.022, 4), hullMaterial);
  bow.rotation.x = Math.PI / 2;
  bow.rotation.z = Math.PI / 4;
  bow.position.z = 0.033;
  ship.add(bow);

  const deckMaterial = new THREE.MeshStandardMaterial({
    color: '#e8e4dc',
    roughness: 0.5,
  });
  const house = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.012, 0.016), deckMaterial);
  house.position.set(0, 0.01, -0.014);
  ship.add(house);

  // stacked containers — the giveaway that this is a working ship
  const boxMaterial = new THREE.MeshStandardMaterial({ color: '#3f6f8c', roughness: 0.7 });
  const containers = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.009, 0.03), boxMaterial);
  containers.position.set(0, 0.009, 0.008);
  ship.add(containers);

  return ship;
}

export function buildShips(radius: number, bumpHeight: number): Traffic {
  const group = new THREE.Group();
  const rand = mulberry32(5150);
  const seaRadius = seaLevelRadius(radius, bumpHeight);

  const isOcean = (dir: THREE.Vector3) => sampledHeight(dir).raw < SEA_LEVEL;

  interface Route {
    object: THREE.Group;
    u: THREE.Vector3;
    v: THREE.Vector3;
    /** angle at which the sailed leg begins, measured from the first port */
    start: number;
    span: number;
    duration: number;
    phase: number;
    wake: THREE.Line;
    wakePositions: Float32Array;
    wakeAlpha: Float32Array;
  }
  const routes: Route[] = [];

  // Finding a crossing: take two real ports and walk the great circle
  // between them, one raster sample at a time, keeping the pair only if
  // open water runs the whole way. Walking is not decoration — most pairs
  // in `PORTS` fail, and they fail for the right reasons: Shanghai to
  // Rotterdam goes overland across Asia, Los Angeles to New York walks
  // straight into Kansas. The lanes that survive are the ones that really
  // are connected by sea, found against the actual elevation data rather
  // than assumed.
  const step = 0.02;
  const probe = new THREE.Vector3();

  // A port sits *on* the coastline, so the first and last few samples of
  // any honest route are over land or over the raster's idea of a delta.
  // Ships are therefore picked up and set down a little offshore; 0.05rad
  // is about 320km, which is roughly the width of one raster pixel's worth
  // of slop at the mouths the elevation data reads as sea anyway (§2-11).
  const APPROACH = 0.05;

  interface Candidate {
    u: THREE.Vector3;
    v: THREE.Vector3;
    start: number;
    span: number;
    a: number;
    b: number;
  }
  const candidates: Candidate[] = [];
  const dirs = PORTS.map(([, lat, lon]) => latLonToDir(lat, lon));

  for (let i = 0; i < PORTS.length; i++) {
    for (let j = i + 1; j < PORTS.length; j++) {
      const total = dirs[i].angleTo(dirs[j]);
      // too short to read as a crossing, or so long the ship is mostly
      // round the back of the globe where nobody sees it
      if (total < 0.35 || total > 2.7) continue;
      const [u, v] = planeBasis(dirs[i], dirs[j]);

      // walk in from each end until the water starts
      let s0 = 0;
      while (s0 < APPROACH && (onGreatCircle(u, v, s0, probe), !isOcean(probe))) s0 += step;
      let s1 = total;
      while (total - s1 < APPROACH && (onGreatCircle(u, v, s1, probe), !isOcean(probe))) s1 -= step;
      if (s1 - s0 < 0.3) continue;

      let clear = true;
      for (let s = s0; s <= s1 && clear; s += step) {
        onGreatCircle(u, v, s, probe);
        // land in the way, or up in the pack ice where nothing sails
        if (!isOcean(probe) || Math.abs(probe.y) > 0.85) clear = false;
      }
      if (!clear) continue;

      candidates.push({ u, v, start: s0, span: s1 - s0, a: i, b: j });
    }
  }

  // Spread the fleet over the world rather than filling it with the longest
  // legs, which all turn out to be the same South Atlantic corner, and cap
  // the ships per port so the quays are not all on one coast.
  //
  // Measured: of the 153 pairs in `PORTS`, 9 are out of range and **139 are
  // blocked by land**, leaving 5 clear sea lanes. The cap never binds — the
  // walk does. That is the honest number and it is what ships: 5 crossings
  // that really are open water, against the 7 the old random walk produced
  // between two places that were not anywhere. If more are ever wanted, the
  // fix is a dogleg through a third port (which is how real shipping gets
  // through Panama, Suez and the Cape) and not a looser test, because a
  // looser test is just a ship sailing over Asia again.
  const PER_PORT = 3;
  const used = new Array(PORTS.length).fill(0);
  const order = candidates.map((c) => ({ c, k: rand() + c.span * 0.35 }));
  order.sort((p, q) => q.k - p.k);

  const WANTED = 7;
  for (const { c } of order) {
    if (routes.length >= WANTED) break;
    if (used[c.a] >= PER_PORT || used[c.b] >= PER_PORT) continue;
    used[c.a]++;
    used[c.b]++;
    const { u, v, start, span } = c;

    const object = buildShipMesh();
    object.scale.setScalar(SURFACE_TRAFFIC_SCALE);
    group.add(object);

    const WAKE_POINTS = 26;
    const wakePositions = new Float32Array(WAKE_POINTS * 3);
    const wakeAlpha = new Float32Array(WAKE_POINTS);
    const wakeGeometry = new THREE.BufferGeometry();
    wakeGeometry.setAttribute('position', new THREE.BufferAttribute(wakePositions, 3));
    wakeGeometry.setAttribute('aAlpha', new THREE.BufferAttribute(wakeAlpha, 1));
    const wake = new THREE.Line(
      wakeGeometry,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        vertexShader: `
          attribute float aAlpha;
          varying float vAlpha;
          void main() {
            vAlpha = aAlpha;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          varying float vAlpha;
          void main() {
            gl_FragColor = vec4(vec3(0.92, 0.97, 1.0), vAlpha * 0.55);
          }
        `,
      }),
    );
    wake.frustumCulled = false;
    group.add(wake);

    routes.push({
      object,
      u,
      v,
      start,
      span,
      // a ship is the slowest thing in the scene, and should look it
      duration: 90 + rand() * 60,
      phase: rand(),
      wake,
      wakePositions,
      wakeAlpha,
    });
  }

  const pos = new THREE.Vector3();
  const ahead = new THREE.Vector3();

  const tick = (t: number) => {
    routes.forEach((route) => {
      // Ping-pong rather than wrap: a ship reaching the far end of its
      // crossing turns round and sails back, which is both what a real
      // route does and the only option that does not need a second arc
      // found for the return leg.
      const cycle = ((t / route.duration + route.phase) % 1 + 1) % 1;
      const forward = cycle < 0.5;
      const progress = forward ? cycle * 2 : (1 - cycle) * 2;
      const direction = forward ? 1 : -1;

      onGreatCircle(route.u, route.v, route.start + progress * route.span, pos);
      onGreatCircle(route.u, route.v, route.start + (progress + 0.004 * direction) * route.span, ahead);
      // sitting *in* the resin, not on top of it
      route.object.position.copy(pos).multiplyScalar(seaRadius + 0.006);
      orient(route.object, pos, ahead.sub(pos));

      for (let i = 0; i < route.wakeAlpha.length; i++) {
        const back = progress - direction * (i / (route.wakeAlpha.length - 1)) * 0.09;
        const clamped = Math.min(1, Math.max(0, back));
        onGreatCircle(route.u, route.v, route.start + clamped * route.span, pos);
        pos.multiplyScalar(seaRadius + 0.0015);
        route.wakePositions[i * 3] = pos.x;
        route.wakePositions[i * 3 + 1] = pos.y;
        route.wakePositions[i * 3 + 2] = pos.z;
        route.wakeAlpha[i] = Math.pow(1 - i / (route.wakeAlpha.length - 1), 1.5);
      }
      route.wake.geometry.attributes.position.needsUpdate = true;
      route.wake.geometry.attributes.aAlpha.needsUpdate = true;
    });
  };

  return { group, tick };
}
