import * as THREE from 'three';

// A spatial hash over the (small) 3D direction space so a minimum-spacing
// rejection test is ~O(1) per candidate instead of checking against every
// point placed so far.
export class SpatialHash {
  private cellSize: number;
  private cells = new Map<string, THREE.Vector3[]>();

  constructor(cellSize: number) {
    this.cellSize = cellSize;
  }

  private key(x: number, y: number, z: number) {
    const s = this.cellSize;
    return `${Math.floor(x / s)},${Math.floor(y / s)},${Math.floor(z / s)}`;
  }

  hasNeighborWithin(p: THREE.Vector3, minDistSq: number): boolean {
    const s = this.cellSize;
    const cx = Math.floor(p.x / s);
    const cy = Math.floor(p.y / s);
    const cz = Math.floor(p.z / s);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = this.cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!bucket) continue;
          for (const q of bucket) {
            if (p.distanceToSquared(q) < minDistSq) return true;
          }
        }
      }
    }
    return false;
  }

  add(p: THREE.Vector3) {
    const k = this.key(p.x, p.y, p.z);
    let bucket = this.cells.get(k);
    if (!bucket) {
      bucket = [];
      this.cells.set(k, bucket);
    }
    bucket.push(p);
  }
}

// deterministic RNG so scatter patterns look the same every reload
export function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
