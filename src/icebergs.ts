import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SEA_LEVEL, latLonToDir, sampledHeight, seaLevelRadius } from './terrain';
import { mulberry32 } from './spatialHash';

// ---------------------------------------------------------------------
// Icebergs (G30 continuation)
// ---------------------------------------------------------------------
// The pack itself (§2-49) is a shader term on the sea shell — right for a
// solid ice field, but a real polar sea also carries individual bergs
// calved off a coastal glacier, drifting well clear of the pack proper.
// Those need actual geometry, not a texture term, because they stand
// alone against open water rather than tiling across a shell.
//
// Real calving grounds, not a climate field: an iceberg is not a function
// of temperature the way sea ice is, it is a function of which coasts have
// glaciers reaching the sea. Six named regions, the same "real coordinates
// cost nothing, only the geometry has to be built" logic landmarks.ts and
// the ocean currents (§2-48) already run on.
interface IcebergRegion {
  lat: number;
  lon: number;
  spread: number;
  count: number;
}
const ICEBERG_REGIONS: IcebergRegion[] = [
  { lat: 70, lon: -60, spread: 4, count: 8 }, // Baffin Bay / Davis Strait
  { lat: 68, lon: -25, spread: 3, count: 6 }, // East Greenland Current
  { lat: 52, lon: -52, spread: 3, count: 6 }, // Labrador Sea, "Iceberg Alley"
  { lat: -75, lon: -170, spread: 5, count: 8 }, // Ross Sea
  { lat: -70, lon: -45, spread: 4, count: 7 }, // Weddell Sea
  { lat: -73, lon: -105, spread: 4, count: 6 }, // Amundsen Sea
];

// Same ice/crevasse read as the pack's own colours (terrain.ts's iceColor
// #dce8ee and crevasseColor #5d7888) — a close match rather than a shared
// constant, the way traffic.ts and eruptions.ts each keep their own small
// palettes instead of reaching into terrain.ts's unexported one for a
// different object with a different purpose.
const bergTopColor = new THREE.Color('#e4edf1');
const bergShadowColor = new THREE.Color('#7f96a6');

/**
 * One faceted, jagged ice chunk: an icosahedron pulled flatter and jittered
 * per-vertex so no two look alike, with a baked vertical gradient (bright
 * sunlit top, cool shadowed waterline) the same way the clouds bake a
 * top-lit/underside-shaded gradient into their own vertex colours.
 */
function buildBergGeometry(rand: () => number, size: number): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(size, 0);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const jitter = 0.72 + rand() * 0.56;
    const x = pos.getX(i) * jitter;
    // flattened vertically and sat low: a berg is mostly waterline-hugging
    // bulk with the visible tip well below a sphere's proportions
    const y = pos.getY(i) * jitter * 0.42 - size * 0.32;
    const z = pos.getZ(i) * jitter;
    pos.setXYZ(i, x, y, z);
    const lit = THREE.MathUtils.clamp(y / (size * 0.4) * 0.5 + 0.5, 0, 1);
    const c = bergShadowColor.clone().lerp(bergTopColor, lit);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

export function buildIcebergs(radius: number, bumpHeight: number): THREE.Group {
  const group = new THREE.Group();
  const rand = mulberry32(90210);
  const seaRadius = seaLevelRadius(radius, bumpHeight);
  const isOcean = (dir: THREE.Vector3) => sampledHeight(dir).raw < SEA_LEVEL - 0.01;

  const dir = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const quat = new THREE.Quaternion();
  const geometries: THREE.BufferGeometry[] = [];

  ICEBERG_REGIONS.forEach((region) => {
    let placed = 0;
    let attempts = 0;
    while (placed < region.count && attempts < region.count * 25) {
      attempts++;
      const lat = region.lat + (rand() - 0.5) * 2 * region.spread;
      const lon = region.lon + (rand() - 0.5) * 2 * region.spread;
      dir.copy(latLonToDir(lat, lon));
      if (!isOcean(dir)) continue; // stay off land and clear of the coast

      const size = (0.014 + rand() * 0.024) * radius * 0.5;
      const geo = buildBergGeometry(rand, size);
      quat.setFromUnitVectors(up, dir);
      geo.applyQuaternion(quat);
      // Sat right at the waterline rather than balanced on top of it — the
      // flattened, downward-biased shape above already put most of the
      // bulk below the geometric centre, so the centre itself belongs on
      // the sea surface, not floating above it.
      geo.translate(dir.x * seaRadius, dir.y * seaRadius, dir.z * seaRadius);
      geometries.push(geo);
      placed++;
    }
  });

  if (geometries.length > 0) {
    const merged = mergeGeometries(geometries, false);
    geometries.forEach((g) => g.dispose());
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.85, // weathered ice, not the ocean's poured-resin gloss
      metalness: 0,
      envMapIntensity: 0.2,
    });
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  return group;
}
