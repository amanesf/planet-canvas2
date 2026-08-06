import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SEA_LEVEL, latLonToDir, sampledHeight } from './terrain';
import { AIR_ROUTES, PORTS } from './traffic';

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

type MaterialKey = 'stone' | 'steel' | 'copper' | 'roof' | 'glass' | 'tarmac' | 'crate';

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

// A second continent-spanning batch, so the globe rewards turning it round
// rather than having everything worth finding on the Europe/Japan face.
// Same rules as above: real coordinates, primitives only, and each one
// built around whatever single feature makes it recognisable in silhouette.
LANDMARKS.push(
  {
    name: 'ピサの斜塔',
    lat: 43.723,
    lon: 10.3966,
    build: () => {
      const parts: Part[] = [];
      for (let i = 0; i < 7; i++) {
        const drum = new THREE.CylinderGeometry(0.011, 0.011, 0.008, 14).translate(0, 0.006 + i * 0.009, 0);
        parts.push({ geometry: drum, material: 'stone' });
      }
      // the whole point of it: everything above tilts together
      parts.forEach((p) => p.geometry.rotateZ(0.11));
      return parts;
    },
  },
  {
    name: 'ストーンヘンジ',
    lat: 51.1789,
    lon: -1.8262,
    build: () => {
      const parts: Part[] = [];
      const ring = 0.026;
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        const x = Math.cos(a) * ring;
        const z = Math.sin(a) * ring;
        [-0.005, 0.005].forEach((d) => {
          parts.push({
            geometry: new THREE.BoxGeometry(0.006, 0.024, 0.004)
              .translate(x + Math.sin(a) * d, 0.012, z - Math.cos(a) * d),
            material: 'stone',
          });
        });
        // the lintel across the top, which is what makes it Stonehenge
        // rather than a circle of stones
        const lintel = new THREE.BoxGeometry(0.006, 0.004, 0.016);
        lintel.rotateY(-a);
        lintel.translate(x, 0.026, z);
        parts.push({ geometry: lintel, material: 'stone' });
      }
      return parts;
    },
  },
  {
    name: 'アンコール・ワット',
    lat: 13.4125,
    lon: 103.867,
    build: () => {
      const parts: Part[] = [box(0.06, 0.008, 0.06, 0, 'stone')];
      // a quincunx of corn-cob towers, the tallest in the middle
      const towers: [number, number, number][] = [
        [0, 0, 1],
        [-0.02, -0.02, 0.68],
        [0.02, -0.02, 0.68],
        [-0.02, 0.02, 0.68],
        [0.02, 0.02, 0.68],
      ];
      towers.forEach(([x, z, s]) => {
        const t = new THREE.CylinderGeometry(0.002, 0.011, 0.05 * s, 8).translate(x, 0.008 + 0.025 * s, z);
        parts.push({ geometry: t, material: 'stone' });
      });
      return parts;
    },
  },
  {
    name: '凱旋門',
    lat: 48.8738,
    lon: 2.295,
    build: () => [
      // two piers and a lintel: an arch, from three boxes
      { geometry: new THREE.BoxGeometry(0.008, 0.03, 0.016).translate(-0.014, 0.015, 0), material: 'stone' },
      { geometry: new THREE.BoxGeometry(0.008, 0.03, 0.016).translate(0.014, 0.015, 0), material: 'stone' },
      box(0.036, 0.014, 0.016, 0.03, 'stone'),
    ],
  },
  {
    name: 'ゴールデンゲートブリッジ',
    lat: 37.8199,
    lon: -122.4783,
    build: () => {
      const parts: Part[] = [];
      [-0.03, 0.03].forEach((x) => {
        parts.push({
          geometry: new THREE.BoxGeometry(0.005, 0.058, 0.005).translate(x, 0.029, 0),
          material: 'steel',
        });
        parts.push({
          geometry: new THREE.BoxGeometry(0.008, 0.004, 0.008).translate(x, 0.05, 0),
          material: 'steel',
        });
      });
      // the deck, and the two cables sagging between the towers
      parts.push({ geometry: new THREE.BoxGeometry(0.09, 0.003, 0.01).translate(0, 0.022, 0), material: 'steel' });
      for (let i = 0; i < 9; i++) {
        const t = i / 8;
        const x = -0.03 + t * 0.06;
        const y = 0.05 - Math.sin(t * Math.PI) * 0.024;
        parts.push({ geometry: new THREE.BoxGeometry(0.008, 0.0025, 0.0025).translate(x, y, 0), material: 'steel' });
      }
      return parts;
    },
  },
  {
    name: 'マチュ・ピチュ',
    lat: -13.1631,
    lon: -72.545,
    build: () => {
      const parts: Part[] = [];
      // terraces stepping up a ridge, with a scatter of small stone huts
      for (let i = 0; i < 5; i++) {
        parts.push({
          geometry: new THREE.BoxGeometry(0.05 - i * 0.007, 0.006, 0.03 - i * 0.004).translate(
            0,
            0.003 + i * 0.006,
            i * 0.004,
          ),
          material: 'stone',
        });
      }
      [-0.014, 0, 0.013].forEach((x, i) => {
        parts.push({
          geometry: new THREE.BoxGeometry(0.008, 0.008, 0.007).translate(x, 0.034, -0.004 + i * 0.003),
          material: 'roof',
        });
      });
      return parts;
    },
  },
  {
    name: 'ペトラ遺跡',
    lat: 30.3285,
    lon: 35.4444,
    build: () => [
      // a facade carved into a cliff: a slab with columns cut in front of it
      box(0.04, 0.05, 0.012, 0, 'stone'),
      { geometry: new THREE.CylinderGeometry(0.004, 0.004, 0.03, 8).translate(-0.012, 0.015, 0.009), material: 'roof' },
      { geometry: new THREE.CylinderGeometry(0.004, 0.004, 0.03, 8).translate(0.012, 0.015, 0.009), material: 'roof' },
      { geometry: new THREE.ConeGeometry(0.016, 0.014, 4).translate(0, 0.05, 0.004), material: 'roof' },
    ],
  },
  {
    name: '聖ワシリイ大聖堂',
    lat: 55.7525,
    lon: 37.6231,
    build: () => {
      const parts: Part[] = [box(0.034, 0.018, 0.034, 0, 'stone')];
      // onion domes: a sphere pinched to a point on top of a drum
      const spots: [number, number, number][] = [
        [0, 0, 1],
        [-0.012, -0.012, 0.6],
        [0.012, -0.012, 0.6],
        [-0.012, 0.012, 0.6],
        [0.012, 0.012, 0.6],
      ];
      spots.forEach(([x, z, s]) => {
        parts.push({
          geometry: new THREE.CylinderGeometry(0.005 * s, 0.005 * s, 0.02 * s, 8).translate(x, 0.018 + 0.01 * s, z),
          material: 'stone',
        });
        const onion = new THREE.SphereGeometry(0.008 * s, 10, 8);
        onion.scale(1, 1.35, 1);
        onion.translate(x, 0.018 + 0.024 * s, z);
        parts.push({ geometry: onion, material: 'copper' });
        parts.push({
          geometry: new THREE.ConeGeometry(0.002 * s, 0.008 * s, 5).translate(x, 0.018 + 0.036 * s, z),
          material: 'copper',
        });
      });
      return parts;
    },
  },
  {
    name: 'ブルジュ・ハリファ',
    lat: 25.1972,
    lon: 55.2744,
    build: () => {
      const parts: Part[] = [];
      // a setback tower: each stage narrower than the one under it, which
      // is the entire silhouette
      let y = 0;
      for (let i = 0; i < 5; i++) {
        const h = 0.026 - i * 0.003;
        const r = 0.013 - i * 0.0022;
        parts.push({ geometry: new THREE.CylinderGeometry(r * 0.85, r, h, 6).translate(0, y + h / 2, 0), material: 'glass' });
        y += h;
      }
      parts.push({ geometry: new THREE.CylinderGeometry(0.0003, 0.0014, 0.016, 5).translate(0, y + 0.008, 0), material: 'glass' });
      return parts;
    },
  },
  {
    name: 'ウルル',
    lat: -25.3444,
    lon: 131.0369,
    build: () => {
      // a single long weathered dome, not a mountain: much wider than tall,
      // with steeply rounded ends
      const rock = new THREE.SphereGeometry(0.03, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      rock.scale(1.5, 0.42, 0.75);
      return [{ geometry: rock, material: 'roof' }];
    },
  },
  {
    name: '姫路城',
    lat: 34.8394,
    lon: 134.6939,
    build: () => {
      const parts: Part[] = [box(0.04, 0.014, 0.04, 0, 'stone')];
      // a five-storey keep: each floor smaller, each with a flared roof
      for (let i = 0; i < 4; i++) {
        const w = 0.03 - i * 0.005;
        const y = 0.014 + i * 0.012;
        parts.push({ geometry: new THREE.BoxGeometry(w, 0.009, w).translate(0, y + 0.0045, 0), material: 'stone' });
        parts.push({
          geometry: new THREE.ConeGeometry(w * 0.85, 0.006, 4).translate(0, y + 0.012, 0),
          material: 'roof',
        });
      }
      return parts;
    },
  },
  {
    name: 'ナスカの地上絵',
    lat: -14.7392,
    lon: -75.1301,
    build: () => {
      // drawn, not built: shallow pale lines scratched into the desert, so
      // it is a set of thin slabs lying almost flat on the ground
      const parts: Part[] = [];
      const line = (x: number, z: number, len: number, angle: number) => {
        const g = new THREE.BoxGeometry(len, 0.0012, 0.003);
        g.rotateY(angle);
        g.translate(x, 0.0006, z);
        parts.push({ geometry: g, material: 'stone' });
      };
      for (let i = 0; i < 7; i++) line(0, 0, 0.1, (i / 7) * Math.PI);
      line(0.03, 0.02, 0.05, 0.6);
      line(-0.035, -0.02, 0.06, -0.4);
      return parts;
    },
  },
);

const MATERIALS: Record<MaterialKey, THREE.MeshStandardMaterial> = {
  // weathered limestone, the default for anything old and built of blocks
  stone: new THREE.MeshStandardMaterial({ color: '#d6cdb8', roughness: 0.85, metalness: 0.03 }),
  // the international-orange of Tokyo Tower
  steel: new THREE.MeshStandardMaterial({ color: '#c4472c', roughness: 0.55, metalness: 0.3 }),
  // oxidised copper — the one colour on this list nobody mistakes
  copper: new THREE.MeshStandardMaterial({ color: '#5fa08b', roughness: 0.7, metalness: 0.25 }),
  roof: new THREE.MeshStandardMaterial({ color: '#7a6249', roughness: 0.7, metalness: 0.15 }),
  // the one modern tower on the list: glass curtain wall, not painted steel
  glass: new THREE.MeshStandardMaterial({ color: '#aebfcc', roughness: 0.25, metalness: 0.6 }),
  // Asphalt for the runway strips. Deliberately *darker* than the apron it
  // lies on, which is the opposite of the obvious choice — a pale strip on
  // pale concrete is two nearly equal greys meeting along a two-pixel edge,
  // and at that width the edge is the only thing carrying the shape. The
  // contrast has to do the work the size cannot.
  tarmac: new THREE.MeshStandardMaterial({ color: '#4c4c50', roughness: 0.9, metalness: 0.02 }),
  // Container stacks, in the same blue as the boxes on the ships in
  // traffic.ts — the quay and the vessel calling at it should obviously be
  // carrying the same cargo.
  crate: new THREE.MeshStandardMaterial({ color: '#3f6f8c', roughness: 0.75, metalness: 0.05 }),
};

// Souvenir-globe scale, not map scale. At their first size the landmarks
// were smaller than the trees standing next to them, which is both wrong
// (a pine is not taller than the Eiffel Tower) and useless — you could not
// tell what any of them were. A souvenir globe solves this by making the
// building absurdly too big, and so does this.
const LANDMARK_SCALE = 3.8;

// ---------------------------------------------------------------------
// Airfields and ports (G45, G44)
// ---------------------------------------------------------------------
// These are the first things built here that are not famous buildings.
// They are infrastructure — the marks a working population leaves on a
// coastline — and the reason to put them in this file rather than a new
// one is that they need exactly what the landmarks already have: a real
// coordinate, a local compass, and a merge down to one mesh per material.
//
// Neither of them owns its coordinates. The airfields are built at the
// endpoints of `AIR_ROUTES` and the quays at `PORTS`, both from
// traffic.ts, so an aircraft descends towards a runway that exists and a
// ship calls at a quay that is really there. Two lists of the same places
// is the split §2-11 was written to stop happening again.
//
// THE SCALE, WHICH IS A BIGGER LIE THAN ANY OTHER OBJECT ON THIS GLOBE.
// Measured before anything was modelled, per §2-21. At the shipped camera
// one world unit is about 108px and the globe's disc is 432px across. A
// real 4,000 x 45m runway on a radius-2 Earth is 4000 * 2/6,371,000 =
// 0.00126 units: 0.136px long and 0.0015px wide. LANDMARK_SCALE takes
// that to 0.52 x 0.006px, which is still nothing — §2-21 established that
// 0.3px and "not drawn at all" are the same picture.
//
// Working backwards from what can be seen instead: 2px is the width floor,
// so 0.0185 units wide. Held at a runway's true 89:1 that forces a length
// of 1.65 units — 178px, 41% of the globe's disc, a strip 5,250km long.
// So the aspect has to give as well as the size. At 12:1 the strip is
// 0.222 x 0.0185 units, 24 x 2.0px, which reads. That is 177x real scale:
// 46x beyond LANDMARK_SCALE, and the largest deliberate exaggeration in
// the scene.
//
// It is built as an *airfield* rather than a bare bar for the same reason.
// A lone 24px rectangle on open ground is an artefact; a pale apron with a
// darker strip laid on it is a place, and the apron is the part that reads
// first. The strip alone was tried and looked like a scratch in the paint.
const RUNWAY_LENGTH = 0.222;
const RUNWAY_WIDTH = 0.0185;
const APRON_LENGTH = 0.285;
// The apron's width was decided by measurement, not by looks. At the first
// value tried (0.114 units, 12.3px) the footprint is 708 x 285km, and Tokyo
// could not be given an airfield at all: the strip alone fits on Honshu in
// 71 of the sampled position-and-orientation combinations, and the strip
// plus that apron fits in *none* of them. The apron was the part that did
// not fit, not the runway. Narrowing it recovers the site — measured over
// the same search: 0.09 -> 0 fits, 0.07 -> 1, 0.055 -> 9, 0.045 -> 20.
// 0.055 is 5.9px, which still leaves about 2px of pale ground either side
// of the 2px strip, so it reads as an apron rather than as a fringe.
// Honolulu fits at no width whatever, because the *strip* does not fit: a
// 708km runway does not go on Oahu at any angle. That site is dropped, and
// dropping it is the correct answer rather than a failure to work around.
const APRON_WIDTH = 0.055;

// A quay is allowed to be thinner than the runway because it is not asked
// to read on its own: it is a line with container blocks and a crane
// standing on it, and the blocks are what the eye finds. 0.16 units is
// 17px of waterfront, the blocks are 1.5px cubes and the crane is 5px tall.
const QUAY_LENGTH = 0.16;
const QUAY_WIDTH = 0.02;
const YARD_DEPTH = 0.05;

/** Geometry is authored in final world units and divided back out here. */
const U = 1 / LANDMARK_SCALE;

/** One candidate orientation for a flat object, and the ground it would cover. */
interface Variant {
  bearing: [number, number];
  footprint: [number, number][];
}

interface Site {
  name: string;
  /** degrees the layout had to be turned off its preferred bearing */
  turned: number;
  lat: number;
  lon: number;
  /** how far the site had to be moved to get its whole footprint onto land */
  moved: number;
  /** east/north components of the direction the object is laid out along */
  bearing: [number, number];
  /** tangent offsets (east, north; radians) at which to sample the ground */
  footprint: [number, number][];
}

/** A local compass at `dir`: which way is up, east and north on the ground. */
function localFrame(dir: THREE.Vector3): {
  up: THREE.Vector3;
  east: THREE.Vector3;
  north: THREE.Vector3;
} {
  const up = dir.clone().normalize();
  const east = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), up);
  if (east.lengthSq() < 1e-8) east.set(1, 0, 0);
  east.normalize();
  const north = new THREE.Vector3().crossVectors(up, east).normalize();
  return { up, east, north };
}

/** Step off `dir` by a tangent offset in radians. */
function offsetDir(
  dir: THREE.Vector3,
  east: THREE.Vector3,
  north: THREE.Vector3,
  de: number,
  dn: number,
): THREE.Vector3 {
  return dir.clone().addScaledVector(east, de).addScaledVector(north, dn).normalize();
}

const isLand = (dir: THREE.Vector3) => sampledHeight(dir).raw >= SEA_LEVEL;

/**
 * Move a site until its whole footprint is on land.
 *
 * §2-11 measured that 26 of the 186 city coordinates land on water in the
 * elevation raster, and the endpoints in traffic.ts have the same problem
 * for the same reason: an airport is built on flat ground by the coast and
 * a port is on the coast by definition, which is exactly where a
 * downsampled raster gives up. Testing the centre alone is not enough
 * here. These footprints are hundreds of kilometres across at the scale
 * above, so a centre that passes can still have half its strip lying on
 * the resin — which is why the endpoints reading exactly SEA_LEVEL (the
 * coastal clamp) are treated as failures too, not just the ones below it.
 *
 * The search is a spiral outwards in whole rings, so a site that does not
 * need moving is not moved, and one that does takes the shortest way out.
 */
function nudgeToLand(
  lat: number,
  lon: number,
  variants: Variant[],
): { lat: number; lon: number; moved: number; variant: Variant } | null {
  const fits = (la: number, lo: number) => {
    const dir = latLonToDir(la, lo);
    if (!isLand(dir)) return null;
    const { east, north } = localFrame(dir);
    // variants are in preference order, so the first that fits is the one
    // closest to the orientation the object would rather have had
    return (
      variants.find((v) => v.footprint.every(([de, dn]) => isLand(offsetDir(dir, east, north, de, dn)))) ??
      null
    );
  };

  const here = fits(lat, lon);
  if (here) return { lat, lon, moved: 0, variant: here };
  // longitude degrees shrink towards the poles, so a ring in degrees is an
  // ellipse on the ground unless the east step is divided by cos(lat)
  const lonScale = 1 / Math.max(0.15, Math.cos((lat * Math.PI) / 180));
  for (let ring = 0.35; ring <= 7.01; ring += 0.35) {
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2;
      const la = lat + Math.sin(a) * ring;
      const lo = lon + Math.cos(a) * ring * lonScale;
      if (Math.abs(la) > 84) continue;
      const variant = fits(la, lo);
      if (variant) return { lat: la, lon: lo, moved: ring, variant };
    }
  }
  return null;
}

/**
 * The airfields, one per distinct endpoint in `AIR_ROUTES`.
 *
 * The runway heading is not invented and is not looked up: it is the
 * initial great-circle bearing of the route that uses this airport, which
 * is the direction aircraft in this scene actually arrive from and leave
 * on. Aligning the strip with it means the aeroplanes land along the
 * runway instead of across it, and it costs no new data.
 */
export function resolveAirfields(radius: number): Site[] {
  const half = RUNWAY_LENGTH / 2 / radius;
  const wide = APRON_WIDTH / 2 / radius;
  const sites: Site[] = [];
  const seen = new Set<string>();

  AIR_ROUTES.forEach(([label, from, to]) => {
    const names = label.split(' → ');
    ([[from, to], [to, from]] as [[number, number], [number, number]][]).forEach(
      ([here, there], i) => {
        const key = `${here[0]},${here[1]}`;
        if (seen.has(key)) return;
        seen.add(key);

        const dir = latLonToDir(here[0], here[1]);
        const { east, north } = localFrame(dir);
        const other = latLonToDir(there[0], there[1]);
        // the tangent at this end of the great circle, resolved onto the
        // local compass — this is the bearing, and it is unaffected by how
        // far away the far end is
        const tangent = other.clone().addScaledVector(dir, -other.dot(dir));
        if (tangent.lengthSq() < 1e-8) return;
        tangent.normalize();
        const bearing: [number, number] = [tangent.dot(east), tangent.dot(north)];

        // The flight bearing is what this airfield *wants*, but it does not
        // always get it. Measured: at the scale above the footprint is
        // 708 x 285km, and holding Haneda to the Honolulu bearing lays the
        // strip straight out into the Pacific — no position within 7deg of
        // Tokyo puts that footprint on land, because Honshu is not that
        // wide in that direction. Dropping Tokyo, the one place on this
        // globe that already has a landmark on it, to preserve a bearing
        // nobody can read at 24px is the wrong trade. So the strip is
        // allowed to turn, in preference order, and real airports do the
        // same thing: they are laid out along the prevailing wind and the
        // flat ground available, not along any one route.
        const variants: Variant[] = [];
        [0, 15, -15, 30, -30, 45, -45, 60, -60, 75, -75, 90].forEach((deg) => {
          const t = (deg * Math.PI) / 180;
          const b: [number, number] = [
            bearing[0] * Math.cos(t) - bearing[1] * Math.sin(t),
            bearing[0] * Math.sin(t) + bearing[1] * Math.cos(t),
          ];
          // sampled along the strip and out to the apron's four corners: the
          // strip is the part that must not hang over water, and the corners
          // catch a site sitting on a peninsula narrower than the apron
          const footprint: [number, number][] = [];
          for (let s = -1; s <= 1.001; s += 0.25) {
            footprint.push([b[0] * half * s, b[1] * half * s]);
          }
          [-1, 1].forEach((p) =>
            [-1, 1].forEach((q) => {
              footprint.push([
                b[0] * half * 0.9 * p - b[1] * wide * q,
                b[1] * half * 0.9 * p + b[0] * wide * q,
              ]);
            }),
          );
          variants.push({ bearing: b, footprint });
        });

        const moved = nudgeToLand(here[0], here[1], variants);
        if (!moved) return;
        sites.push({
          name: names[i] ?? label,
          turned: Math.round(
            (Math.acos(
              Math.min(1, Math.abs(moved.variant.bearing[0] * bearing[0] + moved.variant.bearing[1] * bearing[1])),
            ) *
              180) /
              Math.PI,
          ),
          lat: moved.lat,
          lon: moved.lon,
          moved: moved.moved,
          bearing: moved.variant.bearing,
          footprint: moved.variant.footprint,
        });
      },
    );
  });

  return sites;
}

/**
 * The ports, one per entry in `PORTS`.
 *
 * A quay has to know which way the water is, and there is no need to store
 * that: the raster already knows. Sampling a ring of directions around the
 * site and averaging the ones that come back as sea gives a seaward normal
 * that is correct by construction, including for the ports (Vancouver,
 * Rotterdam) where the open water is not in the direction the map suggests.
 * The quay then runs *along* the shore, at right angles to it, with the
 * container yard and the crane standing behind it on the land.
 */
export function resolvePorts(radius: number): Site[] {
  const half = QUAY_LENGTH / 2 / radius;
  const back = YARD_DEPTH / radius;
  const sites: Site[] = [];

  PORTS.forEach(([name, lat, lon]) => {
    // The seaward direction is read at the *original* coordinate, before
    // any nudge: that is the real harbour, and the nudge only exists to
    // find ground solid enough to stand the yard on nearby.
    const home = latLonToDir(lat, lon);
    const { east, north } = localFrame(home);
    const sea = new THREE.Vector2();
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const de = Math.cos(a) * 0.03;
      const dn = Math.sin(a) * 0.03;
      if (!isLand(offsetDir(home, east, north, de, dn))) sea.add(new THREE.Vector2(de, dn));
    }
    // landlocked in the raster — no quay, rather than a quay facing nothing
    if (sea.lengthSq() < 1e-9) return;
    sea.normalize();
    const bearing: [number, number] = [sea.x, sea.y];

    // The quay line runs perpendicular to the water, and everything that
    // has to stand on solid ground is behind it. Only the landward strip is
    // tested: a quay whose seaward edge is over water is correct.
    const footprint: [number, number][] = [];
    for (let s = -1; s <= 1.001; s += 0.5) {
      const alongE = -sea.y * half * s;
      const alongN = sea.x * half * s;
      [0.25, 0.75].forEach((d) => {
        footprint.push([alongE - sea.x * back * d, alongN - sea.y * back * d]);
      });
    }

    // A quay does not get to turn: it faces the water or it is not a quay.
    const moved = nudgeToLand(lat, lon, [{ bearing, footprint }]);
    if (!moved) return;
    sites.push({
      name,
      turned: 0,
      lat: moved.lat,
      lon: moved.lon,
      moved: moved.moved,
      bearing,
      footprint,
    });
  });

  return sites;
}

/** The apron, and the strip lying on it. */
function airfieldParts(): Part[] {
  return [
    // laid almost flat, like the Nazca lines: this is ground marking, not
    // a building, and any real thickness would show as a plinth in profile
    {
      geometry: new THREE.BoxGeometry(APRON_LENGTH * U, 0.0035 * U, APRON_WIDTH * U).translate(
        0,
        0.0017 * U,
        0,
      ),
      material: 'stone',
    },
    {
      geometry: new THREE.BoxGeometry(RUNWAY_LENGTH * U, 0.0035 * U, RUNWAY_WIDTH * U).translate(
        0,
        0.0032 * U,
        0,
      ),
      material: 'tarmac',
    },
  ];
}

/** The quay line, the container yard behind it, and one gantry crane. */
function portParts(): Part[] {
  const parts: Part[] = [
    // +X is seaward; the quay sits at the waterline, running across it
    {
      geometry: new THREE.BoxGeometry(QUAY_WIDTH * U, 0.008 * U, QUAY_LENGTH * U).translate(
        0,
        0.004 * U,
        0,
      ),
      material: 'stone',
    },
  ];

  // Container blocks: stacks, not one slab. Six of them at slightly
  // different heights is what makes a yard read as full of boxes at 1.5px
  // rather than as a second quay.
  const heights = [0.016, 0.026, 0.02, 0.03, 0.018, 0.024];
  heights.forEach((h, i) => {
    const z = (i - 2.5) * 0.026;
    parts.push({
      geometry: new THREE.BoxGeometry(0.026 * U, h * U, 0.02 * U).translate(
        -0.03 * U,
        (h / 2) * U,
        z * U,
      ),
      material: 'crate',
    });
  });

  // The crane. Its legs would be sub-pixel if modelled as legs, so it is a
  // portal: two posts thick enough to survive, a beam across them, and a
  // jib reaching out over the water. The jib is the silhouette — a gantry
  // crane is recognised by the arm hanging over the ship, not by the frame.
  [-0.03, 0.03].forEach((z) => {
    parts.push({
      geometry: new THREE.BoxGeometry(0.008 * U, 0.05 * U, 0.008 * U).translate(
        0,
        0.025 * U,
        z * U,
      ),
      material: 'steel',
    });
  });
  parts.push({
    geometry: new THREE.BoxGeometry(0.01 * U, 0.008 * U, 0.075 * U).translate(0, 0.052 * U, 0),
    material: 'steel',
  });
  parts.push({
    geometry: new THREE.BoxGeometry(0.075 * U, 0.006 * U, 0.01 * U).translate(
      0.03 * U,
      0.05 * U,
      0,
    ),
    material: 'steel',
  });

  return parts;
}

export function buildLandmarks(radius: number, bumpHeight: number): THREE.Group {
  const group = new THREE.Group();
  const buckets: Record<MaterialKey, THREE.BufferGeometry[]> = {
    stone: [],
    steel: [],
    copper: [],
    roof: [],
    glass: [],
    tarmac: [],
    crate: [],
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

  // The airfields and the quays. Same merge, same materials bucket, but
  // they are placed here rather than in LANDMARKS because they need two
  // things no famous building does: an orientation taken from the traffic
  // that uses them, and a ground height taken from the *lowest* point under
  // their footprint. A slab this long laid at the height of its own centre
  // floats at one end wherever the terrain falls away, and 0.222 units of
  // runway crosses a lot of terrain.
  const placeFlat = (site: Site, parts: Part[]) => {
    const dir = latLonToDir(site.lat, site.lon);
    const { up, east, north } = localFrame(dir);

    let lowest = sampledHeight(dir).display;
    site.footprint.forEach(([de, dn]) => {
      lowest = Math.min(lowest, sampledHeight(offsetDir(dir, east, north, de, dn)).display);
    });

    // local +X is east and +Z is north (see the basis below), and rotateY
    // takes +X to (cos, 0, -sin), so this points +X along the bearing
    const angle = Math.atan2(-site.bearing[1], site.bearing[0]);
    const surface = radius + lowest * bumpHeight - 0.004;
    basis.makeBasis(east, up, north);
    basis.setPosition(up.x * surface, up.y * surface, up.z * surface);

    parts.forEach((part) => {
      part.geometry.rotateY(angle);
      part.geometry.scale(LANDMARK_SCALE, LANDMARK_SCALE, LANDMARK_SCALE);
      part.geometry.applyMatrix4(basis);
      buckets[part.material].push(part.geometry);
    });
  };

  resolveAirfields(radius).forEach((site) => placeFlat(site, airfieldParts()));
  resolvePorts(radius).forEach((site) => placeFlat(site, portParts()));

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
