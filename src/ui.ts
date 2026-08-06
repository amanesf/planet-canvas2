import * as THREE from 'three';
import { SEA_LEVEL, climateFactsAt, latLonToDir, sampledHeight } from './terrain';

// The caption and the index.
//
// Everything on this screen is pretending to be a photograph of a
// hand-made object on a workbench, and on-screen chrome is the fastest way
// to lose that: a labelled toolbar across the bottom turns the photograph
// into a web page with a picture in it. So the two things this file adds
// are shaped like the two things a museum actually puts next to an object —
// a small printed caption off to one side, and an index you have to go and
// open. Neither of them is present unless it has something to say.
//
// The caption sits bottom-left. That is the one corner of this composition
// with nothing in it: the globe is centre-frame, the pedestal and its brass
// plate occupy the bottom centre, the pause control is bottom-right, and
// the page background puts only a dim cutting-mat wash down at the left.
// It is also diagonally opposite the controls, so the thing that *reads*
// and the things that are *pressed* never share a corner.

/**
 * Somewhere with a name.
 *
 * This deliberately does not carry the data. The landmark table lives in
 * landmarks.ts and the city table lives in terrain.ts, and this project has
 * already had to undo one split where two modules each kept their own idea
 * of where the cities were (gap-analysis 2-11). main.ts passes the places
 * in from those two tables; nothing here is a second copy of them.
 */
export interface Place {
  name: string;
  lat: number;
  lon: number;
  kind: 'landmark' | 'city';
}

export interface UiHandle {
  /** call once per frame from the render loop */
  tick(): void;
  dispose(): void;
}

export interface UiOptions {
  /** where the UI elements are appended — #app */
  container: HTMLElement;
  /** the canvas, for pointer tracking; the UI never swallows its events */
  domElement: HTMLElement;
  camera: THREE.Camera;
  /** the turning globe. Read for its transform, written only by a jump. */
  globeGroup: THREE.Object3D;
  /** the sphere's radius, for the pick against it */
  radius: number;
  places: Place[];
  /**
   * The idle spin, owned by main.ts. A jump has to stop it (a place that
   * drifts back off the disc two seconds after you asked for it was not
   * really jumped to), and the pause button below is the same switch, so
   * both go through one accessor rather than through a second copy of the
   * flag here.
   */
  spin: { get(): boolean; set(on: boolean): void };
}

// ---------------------------------------------------------------------
// Where things are, in words
// ---------------------------------------------------------------------
// A caption that could only say "35.7N 139.7E" would be a readout, not a
// caption. Naming a region needs a table of regions, and there is no such
// table anywhere in this project to reuse — the city and landmark tables
// name points, not areas, and the climate raster classifies without
// locating. So this is new data rather than a duplicate of existing data:
// one anchor per region, nearest anchor wins.
//
// The granularity is a souvenir globe's, not an atlas's (gap-analysis 0):
// what the caption owes the reader is "you are looking at the Sahara", not
// a border-accurate country. Sea anchors are only ever matched at sea and
// land anchors only on land, which is what keeps "北大西洋" off Ireland
// and "西ヨーロッパ" off the Bay of Biscay without either list needing to
// know where the coastline runs.
interface Region {
  name: string;
  lat: number;
  lon: number;
  sea: boolean;
}

const REGIONS: Region[] = [
  // --- land ---
  { name: '北極', lat: 84, lon: 0, sea: false },
  { name: 'グリーンランド', lat: 72, lon: -40, sea: false },
  { name: 'アラスカ', lat: 64, lon: -152, sea: false },
  { name: 'カナダ北部', lat: 64, lon: -100, sea: false },
  { name: '五大湖', lat: 45, lon: -84, sea: false },
  { name: '北アメリカ東部', lat: 38, lon: -78, sea: false },
  { name: 'グレートプレーンズ', lat: 41, lon: -100, sea: false },
  { name: 'ロッキー山脈', lat: 43, lon: -112, sea: false },
  { name: '北アメリカ西海岸', lat: 38, lon: -121, sea: false },
  { name: 'メキシコ', lat: 22, lon: -102, sea: false },
  { name: '中央アメリカ', lat: 14, lon: -87, sea: false },
  { name: 'カリブ海諸島', lat: 19, lon: -73, sea: false },
  { name: 'アンデス山脈', lat: -18, lon: -68, sea: false },
  { name: 'アマゾン', lat: -4, lon: -62, sea: false },
  { name: 'ブラジル高原', lat: -16, lon: -47, sea: false },
  { name: 'パンパ', lat: -34, lon: -62, sea: false },
  { name: 'パタゴニア', lat: -46, lon: -69, sea: false },
  { name: 'アイスランド', lat: 65, lon: -19, sea: false },
  { name: 'ブリテン諸島', lat: 54, lon: -3, sea: false },
  { name: 'スカンジナビア', lat: 63, lon: 15, sea: false },
  { name: '西ヨーロッパ', lat: 47, lon: 4, sea: false },
  { name: '中央ヨーロッパ', lat: 50, lon: 18, sea: false },
  { name: 'イベリア半島', lat: 40, lon: -4, sea: false },
  { name: 'イタリア', lat: 42, lon: 13, sea: false },
  { name: 'バルカン半島', lat: 42, lon: 22, sea: false },
  { name: 'ロシア西部', lat: 56, lon: 42, sea: false },
  { name: '西シベリア', lat: 62, lon: 72, sea: false },
  { name: '東シベリア', lat: 64, lon: 128, sea: false },
  { name: 'カムチャツカ', lat: 56, lon: 159, sea: false },
  { name: '中央アジア', lat: 45, lon: 66, sea: false },
  { name: 'アナトリア', lat: 39, lon: 33, sea: false },
  { name: 'アラビア半島', lat: 23, lon: 45, sea: false },
  { name: 'イラン高原', lat: 32, lon: 55, sea: false },
  { name: 'サハラ', lat: 23, lon: 12, sea: false },
  { name: 'マグレブ', lat: 33, lon: 2, sea: false },
  { name: 'ナイル川流域', lat: 26, lon: 31, sea: false },
  { name: 'サヘル', lat: 14, lon: 5, sea: false },
  { name: '西アフリカ', lat: 8, lon: -6, sea: false },
  { name: 'コンゴ盆地', lat: -2, lon: 22, sea: false },
  { name: '東アフリカ', lat: 2, lon: 37, sea: false },
  { name: 'アフリカ南部', lat: -24, lon: 25, sea: false },
  { name: 'マダガスカル', lat: -19, lon: 46, sea: false },
  { name: 'インド', lat: 22, lon: 78, sea: false },
  { name: 'ヒマラヤ', lat: 30, lon: 84, sea: false },
  { name: 'チベット高原', lat: 33, lon: 88, sea: false },
  { name: 'インドシナ半島', lat: 16, lon: 103, sea: false },
  { name: '中国南部', lat: 25, lon: 111, sea: false },
  { name: '中国北部', lat: 38, lon: 114, sea: false },
  { name: 'モンゴル', lat: 46, lon: 104, sea: false },
  { name: '朝鮮半島', lat: 37, lon: 128, sea: false },
  { name: '日本', lat: 36, lon: 138, sea: false },
  { name: 'フィリピン', lat: 12, lon: 122, sea: false },
  { name: 'インドネシア', lat: -2, lon: 114, sea: false },
  { name: 'ニューギニア', lat: -5, lon: 141, sea: false },
  { name: 'オーストラリア内陸', lat: -24, lon: 133, sea: false },
  { name: 'オーストラリア東海岸', lat: -30, lon: 151, sea: false },
  { name: 'ニュージーランド', lat: -42, lon: 172, sea: false },
  { name: '南極大陸', lat: -82, lon: 0, sea: false },
  // --- sea ---
  { name: '北極海', lat: 84, lon: 60, sea: true },
  { name: '北大西洋', lat: 45, lon: -35, sea: true },
  { name: '南大西洋', lat: -25, lon: -18, sea: true },
  { name: '地中海', lat: 36, lon: 16, sea: true },
  { name: '北海', lat: 57, lon: 3, sea: true },
  { name: 'バルト海', lat: 58, lon: 20, sea: true },
  { name: '黒海', lat: 43, lon: 34, sea: true },
  { name: 'カリブ海', lat: 15, lon: -75, sea: true },
  { name: 'メキシコ湾', lat: 25, lon: -90, sea: true },
  { name: '紅海', lat: 20, lon: 38, sea: true },
  { name: 'ペルシア湾', lat: 27, lon: 51, sea: true },
  { name: 'インド洋', lat: -20, lon: 75, sea: true },
  { name: 'アラビア海', lat: 14, lon: 63, sea: true },
  { name: 'ベンガル湾', lat: 15, lon: 89, sea: true },
  { name: '南シナ海', lat: 14, lon: 114, sea: true },
  { name: '東シナ海', lat: 29, lon: 125, sea: true },
  { name: '日本海', lat: 40, lon: 135, sea: true },
  { name: '北太平洋', lat: 35, lon: -170, sea: true },
  { name: '南太平洋', lat: -25, lon: -140, sea: true },
  { name: '珊瑚海', lat: -17, lon: 155, sea: true },
  { name: 'ベーリング海', lat: 58, lon: -178, sea: true },
  { name: '南極海', lat: -60, lon: 90, sea: true },
];

// Resolved once, at module load: the table is fixed, and turning it into
// unit vectors here means the per-frame lookup is a dot product per entry
// and no trigonometry at all.
const REGION_DIRS = REGIONS.map((r) => ({ region: r, dir: latLonToDir(r.lat, r.lon) }));

const CLIMATE_NAMES: Record<string, string> = {
  none: '',
  Af: '熱帯雨林',
  Am: '熱帯モンスーン',
  Aw: 'サバンナ',
  BW: '砂漠',
  BS: 'ステップ',
  Cs: '地中海性',
  Cw: '温暖冬季少雨',
  Cf: '温暖湿潤',
  Ds: '亜寒帯',
  Dw: '亜寒帯',
  Df: '亜寒帯',
  ET: 'ツンドラ',
  EF: '氷雪',
};

/**
 * The landform word.
 *
 * Deliberately not a number of metres. The elevation raster is decoded
 * through a gamma and a linear blend chosen to make the *shape* read
 * (terrain.ts's decodeRealElevation), so the height field is not
 * proportional to real altitude and any figure printed from it would be an
 * invented one. A caption may say "highland"; it may not say "1,240 m".
 */
function landformFor(raw: number): string {
  if (raw < SEA_LEVEL - 0.12) return '外洋';
  if (raw < SEA_LEVEL) return '浅海';
  if (raw < SEA_LEVEL + 0.045) return '低地';
  if (raw < SEA_LEVEL + 0.11) return '丘陵';
  if (raw < SEA_LEVEL + 0.19) return '高地';
  return '山岳';
}

export function buildUi(options: UiOptions): UiHandle {
  const { container, domElement, camera, globeGroup, radius, places, spin } = options;

  // ---------- the caption ----------

  const plate = document.createElement('figcaption');
  plate.className = 'plate';
  const plateName = document.createElement('div');
  plateName.className = 'plate-name';
  const plateSub = document.createElement('div');
  plateSub.className = 'plate-sub';
  plate.append(plateName, plateSub);
  container.appendChild(plate);

  // ---------- the controls, one cluster ----------
  //
  // The pause button already existed and already had the right manners for
  // this frame — 38px, round, warm, four-tenths opaque until you go near
  // it. Rather than invent a second look for the index, it is the same
  // button with a different glyph, and both are rebuilt here so the two
  // can never drift apart.

  const cluster = document.createElement('div');
  cluster.className = 'ui';

  const makeButton = (glyph: string, label: string) => {
    const button = document.createElement('button');
    button.className = 'mode-button';
    button.type = 'button';
    button.textContent = glyph;
    button.title = label;
    button.setAttribute('aria-label', label);
    return button;
  };

  const indexButton = makeButton('◎', '場所を探す');
  indexButton.setAttribute('aria-expanded', 'false');
  const spinButton = makeButton(spin.get() ? '⏸' : '▶', spin.get() ? '回転を止める' : '回転を再開する');

  const setSpin = (on: boolean) => {
    spin.set(on);
    spinButton.textContent = on ? '⏸' : '▶';
    const label = on ? '回転を止める' : '回転を再開する';
    spinButton.title = label;
    spinButton.setAttribute('aria-label', label);
  };
  spinButton.addEventListener('click', () => setSpin(!spin.get()));

  // ---------- the index ----------
  //
  // Two hundred cities cannot be a list you scroll on a phone, so there is
  // a filter — but a bordered search box with a magnifier in it is exactly
  // the web-app furniture this frame cannot carry. It is a single line of
  // warm text on a hairline rule, the way a form is ruled on a printed
  // card, and it is only ever on screen while the index is open.

  const index = document.createElement('div');
  index.className = 'index';
  index.hidden = true;

  const filter = document.createElement('input');
  filter.className = 'index-filter';
  filter.type = 'text';
  filter.placeholder = '場所';
  filter.setAttribute('aria-label', '場所を絞り込む');
  filter.autocomplete = 'off';

  const list = document.createElement('div');
  list.className = 'index-list';
  list.setAttribute('role', 'listbox');

  index.append(filter, list);
  cluster.append(index, indexButton, spinButton);
  container.appendChild(cluster);

  // Landmarks first: they are the named, modelled objects, and someone
  // opening the index cold is far likelier to want the Pyramids than the
  // ninetieth-largest city. Within each kind, the tables' own order is
  // kept — it is grouped by region already.
  const ordered = [...places].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'landmark' ? -1 : 1));

  let rows: HTMLButtonElement[] = [];

  function renderList(): void {
    const query = filter.value.trim().toLowerCase();
    const matches = query
      ? ordered.filter((p) => p.name.toLowerCase().includes(query))
      : ordered;
    list.textContent = '';
    rows = matches.map((place) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = place.kind === 'landmark' ? 'index-row index-row-landmark' : 'index-row';
      row.textContent = place.name;
      row.addEventListener('click', () => {
        jumpTo(place);
        closeIndex();
      });
      list.appendChild(row);
      return row;
    });
  }

  function openIndex(): void {
    index.hidden = false;
    indexButton.setAttribute('aria-expanded', 'true');
    filter.value = '';
    renderList();
    list.scrollTop = 0;
    filter.focus();
  }

  function closeIndex(): void {
    index.hidden = true;
    indexButton.setAttribute('aria-expanded', 'false');
  }

  indexButton.addEventListener('click', () => (index.hidden ? openIndex() : closeIndex()));
  filter.addEventListener('input', renderList);
  filter.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && rows.length > 0) rows[0].click();
    if (event.key === 'Escape') closeIndex();
  });
  const onDocumentPointerDown = (event: PointerEvent) => {
    if (index.hidden) return;
    if (!cluster.contains(event.target as Node)) closeIndex();
  };
  document.addEventListener('pointerdown', onDocumentPointerDown);

  // ---------- picking ----------

  const pointer = new THREE.Vector2();
  let pointerInside = false;
  const raycaster = new THREE.Raycaster();
  // Picked against a plain sphere rather than against the real displaced
  // mesh. The mesh is 384x216 quads of heavily displaced geometry and a
  // per-frame raycast into it is not free, while the answer this caption
  // needs is only ever "which region", which a sphere at the mean radius
  // gets right to well inside a degree everywhere but the steepest limb.
  const pickSphere = new THREE.Sphere(new THREE.Vector3(), radius);
  const hit = new THREE.Vector3();
  const localDir = new THREE.Vector3();

  /** The direction from the globe's centre toward the camera. */
  function subCameraDirection(target: THREE.Vector3): THREE.Vector3 {
    globeGroup.getWorldPosition(target);
    return target.subVectors(camera.position, target).normalize();
  }

  const scratch = new THREE.Vector3();

  /**
   * The surface point the reader is looking at, in the globe's own frame.
   *
   * With the pointer over the canvas that is whatever it is over; with no
   * pointer it is the centre of the disc — the point facing the lens —
   * which is the only other place a caption could honestly be describing.
   */
  function currentDir(): THREE.Vector3 | null {
    if (pointerInside) {
      raycaster.setFromCamera(pointer, camera as THREE.PerspectiveCamera);
      pickSphere.center.copy(globeGroup.getWorldPosition(scratch));
      if (!raycaster.ray.intersectSphere(pickSphere, hit)) return null;
      globeGroup.worldToLocal(hit);
      return localDir.copy(hit).normalize();
    }
    const centre = subCameraDirection(scratch);
    hit.copy(centre).multiplyScalar(radius).add(globeGroup.getWorldPosition(new THREE.Vector3()));
    globeGroup.worldToLocal(hit);
    return localDir.copy(hit).normalize();
  }

  // ---------- what to say about it ----------

  const placeDirs = places.map((p) => ({ place: p, dir: latLonToDir(p.lat, p.lon) }));

  function describe(dir: THREE.Vector3): { name: string; sub: string } {
    const raw = sampledHeight(dir).raw;
    const atSea = raw < SEA_LEVEL;

    let region = '';
    let best = -2;
    for (const entry of REGION_DIRS) {
      if (entry.region.sea !== atSea) continue;
      const d = entry.dir.dot(dir);
      if (d > best) {
        best = d;
        region = entry.region.name;
      }
    }

    // A named place only claims the caption when the reader is actually on
    // it. At this framing a degree of arc is roughly two pixels, so a
    // generous radius would have the plate announcing Cairo while the
    // pointer is out in the Western Desert; two and a half degrees is
    // about the size of the painted urban patch itself.
    let nearest: Place | null = null;
    let nearestDot = Math.cos((2.5 * Math.PI) / 180);
    for (const entry of placeDirs) {
      const d = entry.dir.dot(dir);
      if (d > nearestDot) {
        nearestDot = d;
        nearest = entry.place;
      }
    }

    const landform = landformFor(raw);
    const climate = atSea ? '' : CLIMATE_NAMES[climateFactsAt(dir).group] ?? '';
    const facts = [climate, landform].filter(Boolean).join('・');

    if (nearest) return { name: nearest.name, sub: [region, facts].filter(Boolean).join(' · ') };
    return { name: region, sub: facts };
  }

  // ---------- when the caption is on screen ----------
  //
  // The globe turns all the time, so a caption tied only to what is at the
  // centre would be a ticker running through region names forever, which is
  // both noisy and a lie about what the reader is attending to. It appears
  // while the pointer is on the globe, for a moment after the reader stops
  // dragging or zooming, and after a jump — and otherwise the frame is a
  // photograph with nothing written on it.
  let visibleUntil = 0;
  const HOLD_AFTER_INTERACTION = 2.2;
  const HOLD_AFTER_JUMP = 4;

  const clock = new THREE.Clock();
  let now = 0;

  const show = (seconds: number) => {
    visibleUntil = Math.max(visibleUntil, now + seconds);
  };

  const onPointerMove = (event: PointerEvent) => {
    const rect = domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    pointerInside = true;
    show(0.4);
  };
  const onPointerLeave = () => {
    pointerInside = false;
  };
  const onInteract = () => {
    show(HOLD_AFTER_INTERACTION);
  };
  domElement.addEventListener('pointermove', onPointerMove);
  domElement.addEventListener('pointerleave', onPointerLeave);
  domElement.addEventListener('pointerdown', onInteract);
  domElement.addEventListener('pointerup', onInteract);
  domElement.addEventListener('wheel', onInteract, { passive: true });

  // ---------- the jump ----------
  //
  // Spinning the globe, and nothing else.
  //
  // The obvious implementation — fly the camera round to the place — is
  // the one this composition cannot have. The key light is fixed and the
  // camera is fixed, and between them they pin the terminator at 0.567 of
  // the disc radius on the anti-sun side (gap-analysis 2-12, 2-18); the
  // polar angle is a tuned constant that was moved by four degrees purely
  // to put that number back where it was after the camera pulled out. Any
  // jump that swings the lens moves the daylight boundary across the disc
  // and takes the whole lighting design with it.
  //
  // Turning the globe on its own axis moves nothing: the light, the lens,
  // the terminator, the depth of field and the desk shadow are all exactly
  // where they were. It is also what a person does to a globe on a stand.
  // The cost is that only longitude can be aimed — a place's latitude puts
  // it where it puts it on the disc — and that is the correct behaviour
  // for a mounted globe rather than a limitation to work around.
  // The place being flown to, or null when the globe is where it was asked
  // to be. The *angle* is not stored: it is recomputed from this place
  // every frame, because the camera can be orbited mid-flight and a target
  // captured once would then aim at where the lens used to be.
  let jumpPlace: Place | null = null;
  const AXIS_Z = new THREE.Vector3(0, 0, 1);
  const q = new THREE.Vector3();

  function desiredRotationY(place: Place): number {
    // The group's own tilt (rotation.z, set every frame in main.ts) is
    // applied *before* the spin in three's default XYZ order, so the
    // azimuth that the spin has to line up is the tilted vector's, not the
    // raw one's. Getting this wrong is a fraction of a degree here, but it
    // is a fraction of a degree that grows with the tilt.
    q.copy(latLonToDir(place.lat, place.lon)).applyAxisAngle(AXIS_Z, globeGroup.rotation.z);
    const towardCamera = subCameraDirection(scratch);
    return Math.atan2(towardCamera.x, towardCamera.z) - Math.atan2(q.x, q.z);
  }

  function jumpTo(place: Place): void {
    setSpin(false);
    jumpPlace = place;
    plateName.textContent = place.name;
    plateSub.textContent = '';
    lastText = place.name;
    lastSub = '';
    show(HOLD_AFTER_JUMP);
  }

  function advanceJump(dt: number): void {
    if (!jumpPlace) return;
    let delta = desiredRotationY(jumpPlace) - globeGroup.rotation.y;
    delta = ((((delta + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
    if (Math.abs(delta) < 0.0015) {
      globeGroup.rotation.y += delta;
      jumpPlace = null;
      return;
    }
    // Exponential ease rather than a timed tween: it starts fast, arrives
    // without a stop, and a half-turn and a nudge take visibly different
    // amounts of time — which is how a weighted object behaves and how a
    // fixed-duration tween conspicuously does not.
    globeGroup.rotation.y += delta * (1 - Math.exp(-dt * 3.6));
  }

  // ---------- per frame ----------

  let lastText = '';
  let lastSub = '';

  function tick(): void {
    const dt = clock.getDelta();
    now += dt;

    advanceJump(dt);

    const visible = now < visibleUntil;
    plate.classList.toggle('is-visible', visible);
    if (!visible) return;

    // While a jump is in flight the caption keeps the name that was asked
    // for. Letting it track the surface would have it read out every
    // region between here and there, which is a ticker again.
    if (jumpPlace) return;

    const dir = currentDir();
    if (!dir) return;
    const { name, sub } = describe(dir);
    if (name !== lastText) {
      plateName.textContent = name;
      lastText = name;
    }
    if (sub !== lastSub) {
      plateSub.textContent = sub;
      lastSub = sub;
    }
  }

  function dispose(): void {
    domElement.removeEventListener('pointermove', onPointerMove);
    domElement.removeEventListener('pointerleave', onPointerLeave);
    domElement.removeEventListener('pointerdown', onInteract);
    domElement.removeEventListener('pointerup', onInteract);
    domElement.removeEventListener('wheel', onInteract);
    document.removeEventListener('pointerdown', onDocumentPointerDown);
    plate.remove();
    cluster.remove();
  }

  return { tick, dispose };
}
