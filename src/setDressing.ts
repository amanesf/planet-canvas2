import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from './spatialHash';

// The reference image is not a globe photographed against nothing. It is a
// finished model sitting on a scratched wooden bench, with paint bottles
// and tools behind it and loose cotton and a spare tree in front of the
// lens, all thrown well out of focus. Every one of those elements is doing
// the same job: establishing that the subject is a physical object of a
// particular *size*, sitting in a place where such objects get made.
//
// A CSS gradient behind the canvas cannot participate in that, because it
// is not in the scene — it takes no light, sits at no depth, and so the
// depth-of-field pass has nothing to do with it. Building the surroundings
// as real geometry costs a handful of draw calls and gives the whole frame
// something the globe can be *in*.

function buildDeskTexture(): THREE.CanvasTexture {
  const w = 512;
  const h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const rand = mulberry32(90210);

  const base = ctx.createLinearGradient(0, 0, 0, h);
  base.addColorStop(0, '#6b4a30');
  base.addColorStop(0.55, '#53341f');
  base.addColorStop(1, '#3a2216');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  // plank seams and long grain — barely resolvable once defocused, but
  // they keep the surface from reading as a flat brown card in the
  // narrow strip that stays near enough to focus
  for (let i = 0; i < 5; i++) {
    const y = (i + 0.5) * (h / 5) + (rand() - 0.5) * 30;
    ctx.strokeStyle = 'rgba(20, 11, 7, 0.55)';
    ctx.lineWidth = 3 + rand() * 3;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  for (let i = 0; i < 70; i++) {
    const y = rand() * h;
    ctx.strokeStyle = `rgba(${rand() < 0.5 ? '18, 10, 6' : '92, 66, 44'}, ${0.05 + rand() * 0.12})`;
    ctx.lineWidth = 1 + rand() * 3;
    ctx.beginPath();
    let x = 0;
    let yy = y;
    ctx.moveTo(x, yy);
    while (x < w) {
      x += 60 + rand() * 120;
      yy += (rand() - 0.5) * 10;
      ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 2);
  return texture;
}

/** A paint bottle: squat body, screw cap, paper label. */
function buildPaintBottle(rand: () => number): THREE.Group {
  const group = new THREE.Group();

  const bodyHeight = 0.5 + rand() * 0.22;
  const radius = 0.17 + rand() * 0.05;

  // the pigment inside reads through the glass as a dark saturated core
  const paintHue = rand();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius * 0.96, bodyHeight, 18),
    new THREE.MeshPhysicalMaterial({
      color: new THREE.Color().setHSL(paintHue, 0.45, 0.14, THREE.SRGBColorSpace),
      roughness: 0.25,
      metalness: 0,
      clearcoat: 0.7,
      clearcoatRoughness: 0.15,
    }),
  );
  body.position.y = bodyHeight / 2;
  body.castShadow = true;
  group.add(body);

  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.72, radius * 0.78, 0.16, 18),
    new THREE.MeshStandardMaterial({ color: '#26262a', roughness: 0.55 }),
  );
  cap.position.y = bodyHeight + 0.08;
  cap.castShadow = true;
  group.add(cap);

  const label = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 1.015, radius * 1.015, bodyHeight * 0.45, 18, 1, true),
    new THREE.MeshStandardMaterial({
      color: '#d8d2c6',
      roughness: 0.9,
      side: THREE.DoubleSide,
    }),
  );
  label.position.y = bodyHeight * 0.45;
  group.add(label);

  return group;
}

/** A loose ball of the same cotton the clouds are made of. */
function buildCottonWad(rand: () => number): THREE.Mesh {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 14; i++) {
    const r = 0.12 + rand() * 0.2;
    const g = new THREE.SphereGeometry(r, 8, 6);
    g.translate((rand() - 0.5) * 0.5, (rand() - 0.5) * 0.35, (rand() - 0.5) * 0.5);
    parts.push(g);
  }
  const merged = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  return new THREE.Mesh(
    merged,
    new THREE.MeshStandardMaterial({ color: '#e8e6e4', roughness: 0.95 }),
  );
}

/** A jar of brushes — tall enough to reach into the frame from the bench. */
function buildBrushJar(rand: () => number): THREE.Group {
  const group = new THREE.Group();
  const jar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.3, 0.95, 20),
    new THREE.MeshStandardMaterial({
      color: '#cfd8d6',
      roughness: 0.15,
      metalness: 0,
      transparent: true,
      opacity: 0.5,
    }),
  );
  jar.position.y = 0.475;
  group.add(jar);

  for (let i = 0; i < 7; i++) {
    const len = 1.5 + rand() * 0.9;
    const handle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.035, len, 6),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(0.07 + rand() * 0.05, 0.4, 0.18 + rand() * 0.2, THREE.SRGBColorSpace),
        roughness: 0.5,
      }),
    );
    handle.position.set((rand() - 0.5) * 0.34, 0.6 + len / 2, (rand() - 0.5) * 0.34);
    handle.rotation.z = (rand() - 0.5) * 0.5;
    handle.rotation.x = (rand() - 0.5) * 0.5;
    group.add(handle);
  }
  return group;
}

/** A spare model conifer, the kind that gets glued onto layouts. */
function buildSpareTree(rand: () => number): THREE.Group {
  const group = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.03, 0.05, 0.35, 6),
    new THREE.MeshStandardMaterial({ color: '#6b4a33', roughness: 0.95 }),
  );
  trunk.position.y = 0.175;
  group.add(trunk);

  for (let i = 0; i < 4; i++) {
    const t = i / 4;
    const tier = new THREE.Mesh(
      new THREE.ConeGeometry(0.34 * (1 - t * 0.62), 0.42, 9),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(0.27, 0.38, 0.24 + rand() * 0.08, THREE.SRGBColorSpace),
        roughness: 0.95,
        flatShading: true,
      }),
    );
    tier.position.y = 0.35 + t * 0.68;
    group.add(tier);
  }
  return group;
}

/**
 * Bench surface, backdrop, and the clutter around the subject. Everything
 * here sits well outside the focal plane on purpose — it is context, and
 * context that competes for attention with the subject is set dressing
 * that has stopped doing its job.
 */
export function buildWorkshop(): THREE.Group {
  const group = new THREE.Group();
  const rand = mulberry32(777);

  const deskMaterial = new THREE.MeshStandardMaterial({
    map: buildDeskTexture(),
    roughness: 0.62,
    metalness: 0,
  });

  const desk = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), deskMaterial);
  desk.rotation.x = -Math.PI / 2;
  desk.position.y = -2.08;
  desk.receiveShadow = true;
  group.add(desk);

  // the dim far wall of the room, so the frame doesn't open onto void
  // above the bench
  const wall = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 40),
    new THREE.MeshStandardMaterial({ color: '#42322a', roughness: 1 }),
  );
  wall.position.set(0, 9, -16);
  group.add(wall);

  // paint bottles in a loose row behind the subject
  const bottlePositions: [number, number][] = [
    [-5.2, -6.2],
    [-3.6, -7.1],
    [-2.0, -6.4],
    [2.8, -6.8],
    [4.3, -6.0],
    [5.7, -7.2],
  ];
  bottlePositions.forEach(([x, z]) => {
    const bottle = buildPaintBottle(rand);
    bottle.position.set(x, -2.08, z);
    bottle.rotation.y = rand() * Math.PI * 2;
    bottle.scale.setScalar(1.7);
    group.add(bottle);
  });

  // Foreground clutter, close enough to the lens to be pure soft shape —
  // the strongest single cue that this is a photograph of something small.
  //
  // These have to be *tall*. The lens sits about six units above the bench
  // and looks slightly down, so anything standing on the bench between it
  // and the subject projects well below the bottom of the frame — measured
  // at roughly y = -2.4 in clip space, where the frame ends at -1. Only
  // objects that reach up toward the globe's own height get into shot at a
  // distance short enough to be properly out of focus.
  const tree = buildSpareTree(rand);
  tree.position.set(-1.95, -2.08, 6.3);
  tree.scale.setScalar(3.1);
  group.add(tree);

  const jar = buildBrushJar(rand);
  jar.position.set(2.35, -2.08, 5.6);
  jar.scale.setScalar(1.7);
  group.add(jar);

  // a wad of the cloud cotton left on the bench beside the stand
  const wad = buildCottonWad(rand);
  wad.position.set(2.9, -1.85, 2.4);
  wad.scale.setScalar(1.6);
  group.add(wad);

  return group;
}
