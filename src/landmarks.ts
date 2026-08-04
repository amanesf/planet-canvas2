import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { latLonToDir, sampledHeight } from './terrain';

// ---------------------------------------------------------------------
// Landmarks
// ---------------------------------------------------------------------
// A souvenir globe has famous buildings modelled onto it, hugely out of
// scale, standing where they really stand. That is not an accident of
// cheap manufacturing — it is the whole appeal of the object: it tells you
// where you are by showing you something you recognise, and the wrongness
// of the scale is the joke. This globe already places its mountains, its
// volcanoes and its cities at their real coordinates, so the coordinates
// for these cost nothing; only the little models had to be built.
//
// Each is assembled from a handful of primitives in a local frame (origin
// on the ground, +Y up), then transformed onto the sphere at its real
// latitude and longitude, at whatever height the terrain there turns out
// to be. Nothing here moves or is looked up per frame, so once every
// landmark is placed they are all merged down to one mesh per material —
// eleven buildings for four draw calls.

type MaterialKey = 'stone' | 'steel' | 'copper' | 'roof';

interface Part {
  geometry: THREE.BufferGeometry;
  material: MaterialKey;
}

const box = (w: number, h: number, d: number, y: number, material: MaterialKey): Part => ({
  geometry: new THREE.BoxGeometry(w, h, d).translate(0, y + h / 2, 0),
  material,
});

const tapered = (
  bottom: number,
  top: number,
  h: number,
  y: number,
  sides: number,
  material: MaterialKey,
): Part => ({
  geometry: new THREE.CylinderGeometry(top, bottom, h, sides).translate(0, y + h / 2, 0),
  material,
});

const cone = (r: number, h: number, y: number, sides: number, material: MaterialKey): Part => ({
  geometry: new THREE.ConeGeometry(r, h, sides).translate(0, y + h / 2, 0),
  material,
});

const dome = (r: number, y: number, material: MaterialKey): Part => ({
  geometry: new THREE.SphereGeometry(r, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, y, 0),
  material,
});

interface Landmark {
  name: string;
  lat: number;
  lon: number;
  build: () => Part[];
}

// A lattice tower cannot be modelled as a lattice at this size — the gaps
// would be smaller than a pixel and it would read as a solid spike anyway.
// What does survive is the *profile*: a steep flare at the feet easing into
// a near-vertical shaft, which is the silhouette both of these towers are
// recognised by.
function latticeTower(height: number, material: MaterialKey, mast: boolean): Part[] {
  const parts: Part[] = [
    tapered(0.02, 0.009, height * 0.32, 0, 4, material),
    tapered(0.009, 0.0045, height * 0.42, height * 0.32, 4, material),
  ];
  // the observation deck, the one horizontal in an otherwise vertical shape
  parts.push(box(0.016, 0.005, 0.016, height * 0.42, material));
  if (mast) parts.push(tapered(0.0025, 0.0008, height * 0.26, height * 0.74, 4, material));
  else parts.push(tapered(0.004, 0.001, height * 0.26, height * 0.74, 4, material));
  return parts;
}

const LANDMARKS: Landmark[] = [
  {
    name: '東京タワー',
    lat: 35.6586,
    lon: 139.7454,
    build: () => latticeTower(0.1, 'steel', true),
  },
  {
    name: 'エッフェル塔',
    lat: 48.8584,
    lon: 2.2945,
    build: () => latticeTower(0.095, 'roof', false),
  },
  {
    name: 'ギザの大ピラミッド',
    lat: 29.9792,
    lon: 31.1342,
    build: () => [
      // three of them, the way the site actually is — one pyramid alone
      // reads as a generic cone
      { geometry: new THREE.ConeGeometry(0.034, 0.036, 4).translate(0, 0.018, 0), material: 'stone' },
      { geometry: new THREE.ConeGeometry(0.026, 0.028, 4).translate(0.05, 0.014, 0.03), material: 'stone' },
      { geometry: new THREE.ConeGeometry(0.016, 0.018, 4).translate(0.085, 0.009, 0.05), material: 'stone' },
    ],
  },
  {
    name: '自由の女神',
    lat: 40.6892,
    lon: -74.0445,
    build: () => [
      box(0.03, 0.03, 0.03, 0, 'stone'),
      tapered(0.014, 0.007, 0.05, 0.03, 10, 'copper'), // the robe
      { geometry: new THREE.SphereGeometry(0.006, 8, 6).translate(0, 0.086, 0), material: 'copper' },
      // the raised arm and the torch, which is the whole silhouette
      { geometry: new THREE.BoxGeometry(0.004, 0.03, 0.004).translate(0.011, 0.092, 0), material: 'copper' },
      { geometry: new THREE.ConeGeometry(0.006, 0.012, 6).translate(0.011, 0.112, 0), material: 'copper' },
    ],
  },
  {
    name: 'ビッグ・ベン',
    lat: 51.5007,
    lon: -0.1246,
    build: () => [
      tapered(0.014, 0.011, 0.07, 0, 4, 'stone'),
      box(0.017, 0.014, 0.017, 0.07, 'stone'), // the clock stage
      cone(0.013, 0.03, 0.084, 4, 'roof'),
    ],
  },
  {
    name: 'コロッセオ',
    lat: 41.8902,
    lon: 12.4922,
    build: () => [
      {
        geometry: new THREE.CylinderGeometry(0.03, 0.032, 0.026, 24, 1, true).translate(0, 0.013, 0),
        material: 'stone',
      },
      // the collapsed side is what makes it a ruin rather than a drum
      { geometry: new THREE.CylinderGeometry(0.03, 0.032, 0.014, 24, 1, true).translate(0, 0.033, 0), material: 'stone' },
      { geometry: new THREE.CylinderGeometry(0.024, 0.024, 0.004, 20).translate(0, 0.002, 0), material: 'stone' },
    ],
  },
  {
    name: 'タージ・マハル',
    lat: 27.1751,
    lon: 78.0421,
    build: () => {
      const parts: Part[] = [
        box(0.05, 0.006, 0.05, 0, 'stone'),
        box(0.034, 0.022, 0.034, 0.006, 'stone'),
        dome(0.017, 0.028, 'stone'),
        { geometry: new THREE.ConeGeometry(0.003, 0.01, 6).translate(0, 0.05, 0), material: 'roof' },
      ];
      // the four minarets on the corners of the plinth
      [-1, 1].forEach((sx) =>
        [-1, 1].forEach((sz) => {
          parts.push({
            geometry: new THREE.CylinderGeometry(0.003, 0.004, 0.038, 8).translate(sx * 0.022, 0.025, sz * 0.022),
            material: 'stone',
          });
        }),
      );
      return parts;
    },
  },
  {
    name: 'シドニー・オペラハウス',
    lat: -33.8568,
    lon: 151.2153,
    build: () => {
      const parts: Part[] = [box(0.06, 0.006, 0.04, 0, 'stone')];
      // the shells: quarter-spheres, each a bit smaller and leaning further
      // back than the last, which is what makes the sail cluster read
      [0, 1, 2].forEach((i) => {
        const r = 0.024 - i * 0.005;
        const shell = new THREE.SphereGeometry(r, 12, 8, 0, Math.PI, 0, Math.PI / 2);
        shell.scale(1, 1.5, 0.55);
        shell.rotateY(-0.5 - i * 0.18);
        shell.translate(-0.016 + i * 0.017, 0.006, i * 0.004);
        parts.push({ geometry: shell, material: 'stone' });
      });
      return parts;
    },
  },
  {
    name: 'コルコバードのキリスト像',
    lat: -22.9519,
    lon: -43.2105,
    build: () => [
      box(0.018, 0.024, 0.018, 0, 'stone'),
      tapered(0.006, 0.005, 0.036, 0.024, 8, 'stone'),
      { geometry: new THREE.BoxGeometry(0.044, 0.004, 0.004).translate(0, 0.05, 0), material: 'stone' },
      { geometry: new THREE.SphereGeometry(0.005, 8, 6).translate(0, 0.064, 0), material: 'stone' },
    ],
  },
  {
    name: 'モアイ',
    lat: -27.1127,
    lon: -109.3497,
    build: () => {
      const parts: Part[] = [];
      // a row of them facing the same way, which is how they stand
      [-0.03, 0, 0.03].forEach((x, i) => {
        const scale = 0.85 + i * 0.12;
        parts.push({
          geometry: new THREE.BoxGeometry(0.016, 0.03, 0.012)
            .scale(scale, scale, scale)
            .translate(x, 0.015 * scale, 0),
          material: 'stone',
        });
        parts.push({
          geometry: new THREE.BoxGeometry(0.02, 0.024, 0.016)
            .scale(scale, scale, scale)
            .translate(x, 0.042 * scale, 0.002),
          material: 'stone',
        });
      });
      return parts;
    },
  },
  {
    name: '万里の長城',
    lat: 40.4319,
    lon: 116.5704,
    build: () => {
      const parts: Part[] = [];
      // a snaking run of wall with watchtowers on it — the wall's whole
      // character is that it follows the ridgeline instead of running straight
      for (let i = 0; i < 9; i++) {
        const x = (i - 4) * 0.026;
        const z = Math.sin(i * 0.9) * 0.02;
        const segment = new THREE.BoxGeometry(0.028, 0.012, 0.008);
        segment.rotateY(Math.cos(i * 0.9) * 0.6);
        segment.translate(x, 0.006, z);
        parts.push({ geometry: segment, material: 'stone' });
        if (i % 3 === 1) {
          parts.push({
            geometry: new THREE.BoxGeometry(0.014, 0.022, 0.014).translate(x, 0.011, z),
            material: 'stone',
          });
        }
      }
      return parts;
    },
  },
];

const MATERIALS: Record<MaterialKey, THREE.MeshStandardMaterial> = {
  // weathered limestone, the default for anything old and built of blocks
  stone: new THREE.MeshStandardMaterial({ color: '#d6cdb8', roughness: 0.85, metalness: 0.03 }),
  // the international-orange of Tokyo Tower
  steel: new THREE.MeshStandardMaterial({ color: '#c4472c', roughness: 0.55, metalness: 0.3 }),
  // oxidised copper — the one colour on this list nobody mistakes
  copper: new THREE.MeshStandardMaterial({ color: '#5fa08b', roughness: 0.7, metalness: 0.25 }),
  roof: new THREE.MeshStandardMaterial({ color: '#7a6249', roughness: 0.7, metalness: 0.15 }),
};

// Souvenir-globe scale, not map scale. At their first size the landmarks
// were smaller than the trees standing next to them, which is both wrong
// (a pine is not taller than the Eiffel Tower) and useless — you could not
// tell what any of them were. A souvenir globe solves this by making the
// building absurdly too big, and so does this.
const LANDMARK_SCALE = 1.9;

export function buildLandmarks(radius: number, bumpHeight: number): THREE.Group {
  const group = new THREE.Group();
  const buckets: Record<MaterialKey, THREE.BufferGeometry[]> = {
    stone: [],
    steel: [],
    copper: [],
    roof: [],
  };

  const basis = new THREE.Matrix4();
  const up = new THREE.Vector3();
  const east = new THREE.Vector3();
  const north = new THREE.Vector3();
  const worldUp = new THREE.Vector3(0, 1, 0);

  LANDMARKS.forEach((landmark) => {
    const dir = latLonToDir(landmark.lat, landmark.lon);
    up.copy(dir).normalize();
    // A local compass at the site, so a building that has an orientation
    // (the Great Wall's run, the Moai's row) is laid out along the ground
    // rather than at whatever angle the maths happened to produce.
    east.crossVectors(worldUp, up);
    if (east.lengthSq() < 1e-8) east.set(1, 0, 0);
    east.normalize();
    north.crossVectors(up, east).normalize();

    // Sunk very slightly into the ground: a building placed exactly on the
    // sampled surface floats wherever the displaced geometry dips below
    // the height field between samples.
    const surface = radius + sampledHeight(dir).display * bumpHeight - 0.004;
    basis.makeBasis(east, up, north);
    basis.setPosition(up.x * surface, up.y * surface, up.z * surface);

    landmark.build().forEach((part) => {
      part.geometry.scale(LANDMARK_SCALE, LANDMARK_SCALE, LANDMARK_SCALE);
      part.geometry.applyMatrix4(basis);
      buckets[part.material].push(part.geometry);
    });
  });

  (Object.keys(buckets) as MaterialKey[]).forEach((key) => {
    const parts = buckets[key];
    if (parts.length === 0) return;
    const merged = mergeGeometries(parts, false);
    parts.forEach((g) => g.dispose());
    const mesh = new THREE.Mesh(merged, MATERIALS[key]);
    mesh.receiveShadow = true;
    group.add(mesh);
  });

  return group;
}
