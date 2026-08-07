import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from './spatialHash';

// The globe is not photographed against nothing. It sits on a desk, in a
// room, and everything here exists to establish that the subject is a
// physical object of a particular *size* standing somewhere real.
//
// That somewhere used to be a workshop — a scratched bench, paint bottles,
// a jar of brushes, a spare model conifer. It is a study now: stacks of
// books, a plant, and a wall of bookcases behind. The globe itself is
// unchanged; what changed is whether you are looking at the place it was
// made or the place it ended up.
//
// A *dark* study, and that is a lighting decision rather than a taste one.
// The scene is lit by one warm key with very little ambient, which is what
// gives the globe its modelled, photographed-object look. A bright airy
// room was tried here and it fought that setup on every axis: a pale wall
// with its own diffuse daylight sat behind a subject lit by a hard warm
// lamp, and the two read as two different photographs composited together.
// Deep walnut and low light let the same key light explain the whole
// frame.
//
// A CSS gradient behind the canvas cannot participate in that, because it
// is not in the scene — it takes no light, sits at no depth, and so the
// depth-of-field pass has nothing to do with it. Building the surroundings
// as real geometry costs a handful of draw calls and gives the whole frame
// something the globe can be *in*. The far wall is the one exception, and
// for the opposite reason: see buildWorkshop.

/**
 * Where the one key light is.
 *
 * Exported because two things now need to agree about it — the light itself
 * in main.ts, and the shadow the globe throws across the desk below. Having
 * each of them state the direction separately is the exact failure this
 * project keeps rediscovering: the snow line and the snowflakes computed
 * "where is it cold" twice and disagreed, the plume and the clouds computed
 * the wind twice and disagreed. A cast shadow that does not point away from
 * the lamp is worse than no cast shadow, because it reads as a stain.
 */
// Mirrored from (-5.0, 4.4, 3.2): the key now rakes in from the front-right
// instead of the front-left, so the day side sits front-right and the night
// side sits back-left, per request. Only the X sign changed — the height and
// depth that made this a raking, not frontal, light (see the note by
// keyLight in main.ts) are untouched.
export const KEY_LIGHT_POSITION = new THREE.Vector3(5.0, 4.4, 3.2);

/** Top of the desk, in world units. */
const DESK_Y = -2.08;

/**
 * How big the subject is and how high it sits. Exported for the same reason
 * as the light position: the shadow's shape is a projection of this sphere,
 * so it has to be *this* sphere and not a second copy of its numbers that
 * can drift out of step with main.ts's.
 */
export const GLOBE_RADIUS = 2;
/**
 * Raised from 0.6 when the sphere stopped resting in a brass collar and
 * went up onto an axis. 0.26 of a world unit is 3cm at this model's scale
 * — the props are the ruler: book covers 0.17-0.36 thick, standing books
 * 1.57-2.52 tall, pot mouths 0.85-1.02 across and a 1.15 nameplate all
 * agree on about 11.5cm to the unit, which makes the globe itself a 46cm
 * library piece. On screen the lift is 30px (114.5 px/unit at a
 * 800px-tall viewport), and it opens 0.385 units — 4.4cm, 44px — of air
 * between the south pole and the top of the wood.
 */
export const GLOBE_CENTRE_Y = 0.86;

/**
 * The obliquity, and the one number the globe, its mount and the
 * satellites all have to agree on.
 *
 * It was 0.04 radians — a 2.3 degree lean that was never meant as an axial
 * tilt, only as a hint that the model was set down by hand. A globe with a
 * rod through it has to commit: the rod points somewhere, and the only
 * defensible somewhere is 23.4 degrees. Stated here rather than in main.ts
 * because three separate objects read it (the sphere, the brass mount, and
 * the satellite orbits, which share the seat and the tilt but not the
 * spin), and this project has twice been bitten by two places computing
 * the same physical fact and disagreeing.
 *
 * Negated from the sign 0.04 originally had, alongside the key light's move
 * to the front-right: a rotation about +Z used to lean the north pole
 * toward -X (the viewer's left) to keep it tipped toward the lamp; now that
 * the lamp is at +X, the sign flips too so that relationship still holds —
 * a rotation about +Z now leans the north pole toward +X. The northern
 * hemisphere stays the one tipped into the lamp, just on the other side.
 */
// Was -(23.4°) — a real axial tilt, meant to be read against the brass
// rod through the poles. On request the globe now stands upright with no
// rod at all (see the mount removal in main.ts), so a lean with nothing to
// visually justify it would just read as the model sitting crooked on its
// cyber base. 0 until this project mounts the globe on something that
// makes a tilt make sense again.
export const AXIAL_TILT = 0;

// ---------------------------------------------------------------------
// The shadow the globe throws on the desk
// ---------------------------------------------------------------------
// The last of the shadows this scene was missing. Shadow maps are off for
// mobile stability and are not coming back, so the globe — a two-unit
// sphere sitting under a hard warm lamp, on a polished desk — threw nothing
// at all, and an object that lights the surface under it but never darkens
// it does not read as being on that surface. It reads as pasted over it,
// which is the whole thing the framing is trying to argue against.
//
// It cannot be painted into the desk texture, which was the cheap idea and
// is wrong for a specific reason worth writing down: that texture is tiled
// (`repeat.set(2, 2)`) across a 60-unit plane, so the world origin — where
// the globe stands — lands exactly on the corner where four tiles meet.
// Anything drawn at the centre of that canvas appears four times, fifteen
// units away in each diagonal, and never underneath the globe.
//
// So it is one quad with a soft gradient. It costs one draw call and writes
// no depth.
//
// The first version of it multiply-blended a white-surround texture, on the
// reasoning that multiplying keeps the desk's own grain reading through the
// shade instead of covering it with a grey fill. That reasoning is sound and
// it rendered as a *white sheet lying on the desk*, because MultiplyBlending
// in three requires premultiplied alpha and silently does nothing useful
// without it — the console says so in as many words. Rather than turn that
// on for one quad, this uses the ordinary way to lay a contact shadow: a
// dark fill whose *alpha* falls off. At these opacities the grain still
// reads through it, which was the only thing multiply was buying.
//
// The geometry is the real projection, not a guess (and needs no separate
// update when the lamp moves — `toSubject` below reads KEY_LIGHT_POSITION
// live). The lamp is up and to the right and behind the subject, so the
// shadow is thrown to the left and toward the viewer, and it is long — the
// globe's centre stands 2.68 above the desk and the light is only about 40
// degrees up, so the far end of it lands three and a half units out. That
// length is most of the effect: a neat circular pool under an object reads
// as an overhead studio light, which is not the light this room has.
function buildContactShadow(): THREE.Mesh {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  // Two gradients, because a shadow is not evenly dark along its length.
  // A single blob centred on the quad puts its darkest point halfway down
  // the throw, hanging in the middle of the desk with lighter wood between
  // it and the thing casting it — which reads as a smudge rather than as
  // contact. What sells contact is the near end: an occlusion pool right
  // where the stand meets the wood, darker and much tighter than the rest,
  // with the cast throw fading away from it. Canvas +X is the throw
  // direction (see the mesh rotation below), so the pool sits at 0.3 along
  // it and the throw runs out past the far edge.
  //
  // Never fully opaque even at the core: this is a shadow cast into a room
  // with bounce in it, and a hole of pure black in a walnut desktop reads as
  // a gap in the desk rather than as shade on it. The tint is the desk's own
  // deep brown rather than neutral black, which is what stops it going grey.
  const throwGradient = ctx.createRadialGradient(
    size * 0.42, size / 2, 0,
    size * 0.42, size / 2, size * 0.5,
  );
  throwGradient.addColorStop(0, 'rgba(18, 10, 6, 0.5)');
  throwGradient.addColorStop(0.45, 'rgba(19, 11, 6, 0.33)');
  throwGradient.addColorStop(0.78, 'rgba(20, 12, 7, 0.1)');
  throwGradient.addColorStop(1, 'rgba(20, 12, 7, 0)');
  ctx.fillStyle = throwGradient;
  ctx.fillRect(0, 0, size, size);

  const pool = ctx.createRadialGradient(
    size * 0.3, size / 2, 0,
    size * 0.3, size / 2, size * 0.26,
  );
  pool.addColorStop(0, 'rgba(14, 8, 4, 0.62)');
  pool.addColorStop(0.55, 'rgba(15, 9, 5, 0.34)');
  pool.addColorStop(1, 'rgba(16, 9, 5, 0)');
  ctx.fillStyle = pool;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  // Project the globe's centre onto the desk along the light direction.
  const height = GLOBE_CENTRE_Y - DESK_Y;
  const toSubject = new THREE.Vector3(0, 0, 0).sub(KEY_LIGHT_POSITION);
  const perUnit = -1 / toSubject.y;
  const tipX = toSubject.x * perUnit * height;
  const tipZ = toSubject.z * perUnit * height;
  const throwLength = Math.hypot(tipX, tipZ);

  // The blob spans from roughly under the pedestal to the projected tip,
  // plus the globe's own width at each end, and it is centred halfway along.
  const long = throwLength + GLOBE_RADIUS * 2.6;
  const wide = GLOBE_RADIUS * 2.3;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(long, wide),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
    }),
  );
  // YXZ so the Y turn is applied after the plane has been laid flat: with
  // the default XYZ order the two rotations fight and the ellipse points
  // somewhere else entirely.
  mesh.rotation.set(-Math.PI / 2, Math.atan2(-tipZ, tipX), 0, 'YXZ');
  // A whisker above the desk, or it z-fights with it.
  mesh.position.set(tipX * 0.5, DESK_Y + 0.004, tipZ * 0.5);
  mesh.renderOrder = 1;
  return mesh;
}

function buildDeskTexture(): THREE.CanvasTexture {
  const w = 512;
  const h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const rand = mulberry32(90210);

  // Dark polished walnut: a writing desk, not a scratched workbench and not
  // the pale oak of a bright modern study. It has to sit under the same one
  // warm key light as the globe and the bookcases behind, and a light
  // desktop bounced far too much of it back up into the frame.
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

// ---------------------------------------------------------------------
// One batch per material, not one mesh per part
// ---------------------------------------------------------------------
// Every prop here used to be a small Group of meshes, and every mesh is a
// draw call. Measured back when the clutter was bottles and brush jars, it
// accounted for most of the frame's hundred-odd draw calls — spent on
// objects that are never in focus. None of them move, so they can all be
// baked into one merged geometry per material and drawn a handful of times
// in total. The books make that matter more, not less: a stack is six or
// seven separate volumes and each volume is two boxes.
//
// Materials are shared rather than constructed per object for the same
// reason: each distinct material compiles its own shader program, and
// those compile in a block before the first frame can be presented.

const props = {
  glass: [] as THREE.BufferGeometry[],
  plastic: [] as THREE.BufferGeometry[],
  paper: [] as THREE.BufferGeometry[],
  wood: [] as THREE.BufferGeometry[],
  foliage: [] as THREE.BufferGeometry[],
  cotton: [] as THREE.BufferGeometry[],
  cloth: [] as THREE.BufferGeometry[],
  ceramic: [] as THREE.BufferGeometry[],
};
type PropMaterial = keyof typeof props;

function emit(
  material: PropMaterial,
  geometry: THREE.BufferGeometry,
  place: (g: THREE.BufferGeometry) => void,
): void {
  place(geometry);
  props[material].push(geometry);
}

/**
 * A stack of books lying flat.
 *
 * Deliberately not uniform: real stacks are made of different books, so
 * each one gets its own thickness, its own footprint and its own small
 * rotation. A tidy stack of identical slabs reads as a 3D primitive, which
 * is exactly what the old prop row was accused of.
 */
function buildBookStack(rand: () => number, at: THREE.Matrix4): void {
  const n = 3 + Math.floor(rand() * 4);
  let y = 0;
  for (let i = 0; i < n; i++) {
    const thickness = 0.1 + rand() * 0.11;
    const w = 0.78 + rand() * 0.22;
    const d = 0.56 + rand() * 0.16;
    const spin = (rand() - 0.5) * 0.35;
    // the cover
    emit('cloth', new THREE.BoxGeometry(w, thickness, d), (g) => {
      g.rotateY(spin);
      g.translate((rand() - 0.5) * 0.1, y + thickness / 2, (rand() - 0.5) * 0.1);
      g.applyMatrix4(at);
    });
    // the page block, inset so a sliver of white shows under the cover —
    // the one detail that stops a book being a coloured brick
    emit('paper', new THREE.BoxGeometry(w * 0.94, thickness * 0.62, d * 0.93), (g) => {
      g.rotateY(spin);
      g.translate((rand() - 0.5) * 0.1, y + thickness / 2, (rand() - 0.5) * 0.1);
      g.applyMatrix4(at);
    });
    y += thickness;
  }
}

/** A short run of books stood upright, a couple of them leaning over. */
function buildStandingBooks(rand: () => number, at: THREE.Matrix4): void {
  let x = 0;
  const n = 4 + Math.floor(rand() * 4);
  for (let i = 0; i < n; i++) {
    const thickness = 0.11 + rand() * 0.1;
    const height = 0.95 + rand() * 0.4;
    // books lean once there is a gap beside them, and the lean grows along
    // the run rather than being random per book
    const lean = i > n - 3 ? 0.16 + rand() * 0.3 : (rand() - 0.5) * 0.06;
    emit('cloth', new THREE.BoxGeometry(thickness, height, 0.62), (g) => {
      g.translate(0, height / 2, 0);
      g.rotateZ(lean);
      g.translate(x, 0, (rand() - 0.5) * 0.06);
      g.applyMatrix4(at);
    });
    x += thickness + 0.015 + rand() * 0.02;
  }
}

/**
 * A houseplant in a ceramic pot.
 *
 * The leaves are flattened, tapered boxes rather than cones: a cone reads
 * as a conifer, and a conifer in a study reads as the model tree that used
 * to stand here. Broad drooping leaves on visible stems are what say
 * "houseplant" at a glance, which is all this has to do from behind the
 * subject and well out of focus.
 */
function buildPottedPlant(rand: () => number, at: THREE.Matrix4): void {
  const potH = 0.5 + rand() * 0.16;
  emit('ceramic', new THREE.CylinderGeometry(0.34, 0.26, potH, 16), (g) => {
    g.translate(0, potH / 2, 0);
    g.applyMatrix4(at);
  });
  emit('ceramic', new THREE.TorusGeometry(0.34, 0.035, 6, 18), (g) => {
    g.rotateX(Math.PI / 2);
    g.translate(0, potH, 0);
    g.applyMatrix4(at);
  });

  // The leaves were flat boxes 0.02 thick, and a flat box lit face-on by a
  // hard key light is a green card. Two changes fix that: a lathe profile
  // that is widest a third of the way along and tapers to a point, so the
  // silhouette is a leaf rather than a rectangle, and a roll about the leaf's
  // own axis so no two of them catch the light at the same angle. Nothing
  // here is ever in focus, but "a shape that is never side-on to the light"
  // survives blur, and "a rectangle" does not.
  const leaves = 9 + Math.floor(rand() * 5);
  for (let i = 0; i < leaves; i++) {
    const a = (i / leaves) * Math.PI * 2 + rand() * 0.5;
    const len = 0.55 + rand() * 0.5;
    const droop = 0.45 + rand() * 0.7;
    const stem = 0.3 + rand() * 0.45;
    const roll = (rand() - 0.5) * 1.4;

    emit('foliage', new THREE.CylinderGeometry(0.016, 0.024, stem, 4), (g) => {
      g.translate(0, stem / 2, 0);
      g.rotateZ(droop * 0.35);
      g.rotateY(a);
      g.translate(0, potH, 0);
      g.applyMatrix4(at);
    });

    const halfWidth = 0.14 + rand() * 0.07;
    const profile: THREE.Vector2[] = [];
    for (let k = 0; k <= 6; k++) {
      const t = k / 6;
      // 0 at the stem, widest at a third, back to 0 at the tip
      profile.push(new THREE.Vector2(Math.sin(Math.pow(t, 0.55) * Math.PI) * halfWidth, t * len));
    }
    emit('foliage', new THREE.LatheGeometry(profile, 5), (g) => {
      g.scale(1, 1, 0.28); // flattened, but with a curved cross-section
      g.rotateZ(Math.PI / 2 - droop);
      g.rotateX(roll);
      g.rotateY(a);
      g.translate(
        Math.cos(a) * stem * 0.4,
        potH + stem * 0.85,
        -Math.sin(a) * stem * 0.4,
      );
      g.applyMatrix4(at);
    });
  }
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

  group.add(buildContactShadow());

  // The far wall of the room, so the frame doesn't open onto void above
  // the desk.
  //
  // This was a flat brown plane, and a flat plane is the one thing a
  // depth-of-field pass cannot help: blur needs detail to destroy. It read
  // as a painted backdrop precisely because it had nothing in it. A
  // photograph does the job instead — at thirteen units back it is well
  // outside the focal plane, so it is never seen sharp, which is also why
  // a single image is enough and geometry would be waste. Shelves of books
  // are what say "study" rather than "workbench" faster than any prop on
  // the desk can.
  //
  const wallTexture = new THREE.TextureLoader().load(
    `${import.meta.env.BASE_URL}study-wall.jpg`,
  );
  wallTexture.colorSpace = THREE.SRGBColorSpace;
  // Sized to what the lens actually sees, not to "big enough to cover".
  // The plane it replaced was 80 across, and at thirteen units back with a
  // 40 degree lens only about nineteen units of that is ever in frame — so
  // a photograph mapped across the full 80 showed its middle 23% and
  // nothing else. Every shelf in the picture sat off-screen and the
  // backdrop read as one flat wash, which is precisely what the photograph
  // was brought in to stop. 34 across leaves margin for the widest
  // viewport without wasting most of the image, and keeps the image's own
  // 16:9 so the books are not stretched into the wrong shape — visible
  // even through the blur.
  const wall = new THREE.Mesh(
    // Widened from 34 x 19.1 when the camera pulled back to get the desk
    // into shot. The rule §9 states is that this plane has to be as big as
    // the frame can see at its own depth, and the new distance broke it:
    // anything wider than about 1.97:1 ran past the old plane's edges at
    // z = -13 and showed page background beside the bookcases. 44 restores
    // headroom to ~2.55:1, which covers 21:9. The 16:9 proportion of the
    // source image is kept so the photograph is not stretched.
    new THREE.PlaneGeometry(44, 24.7),
    // Unlit on purpose. The photograph already contains its own lamplight,
    // its own shadows and its own exposure; running it through the scene's
    // key light would light the room a second time and lay a contradictory
    // highlight across a wall that already has one. A backdrop should show
    // as captured. The colour multiplier is the one dial — it sets how far
    // back the room sits behind the subject, and it is pulled well down
    // here so the bookcases stay a dim presence rather than competing with
    // the lit sphere in front of them.
    new THREE.MeshBasicMaterial({ map: wallTexture, color: '#b3a795' }),
  );
  wall.position.set(0, 6.2, -13);
  group.add(wall);

  const at = (x: number, y: number, z: number, s: number | [number, number, number], spin = 0) => {
    const scale = typeof s === 'number' ? new THREE.Vector3(s, s, s) : new THREE.Vector3(...s);
    return new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spin),
      scale,
    );
  };

  // Books in loose piles behind the subject, where the paint bottles used
  // to stand. A row of identical bottles was the single most "workshop"
  // thing in the frame; piles of books of assorted heights are what a desk
  // in a study actually has on it, and they break the horizon line at
  // varying heights instead of at one.
  (
    [
      [-5.2, -6.2],
      [-3.6, -7.1],
      [-2.0, -6.4],
      [2.8, -6.8],
      [4.3, -6.0],
      [5.7, -7.2],
    ] as [number, number][]
  ).forEach(([x, z]) => {
    buildBookStack(rand, at(x, -2.08, z, 1.7, rand() * Math.PI * 2));
  });

  // A couple of taller items further back. The upper part of a portrait
  // frame was opening onto flat black; the reference fills the same space
  // with defocused shelf clutter.
  (
    [
      [-2.9, -5.0, 3.4],
      [3.4, -5.4, 3.0],
    ] as [number, number, number][]
  ).forEach(([x, z, h]) => {
    buildStandingBooks(rand, at(x, -2.08, z, [1.5, h * 0.55, 1.5], rand() * Math.PI * 2));
  });

  // These three used to stand between the lens and the globe, as a
  // deliberate depth cue — a defocused object in the near foreground is
  // the classic signal that a photograph was taken of something small.
  // In practice they were simply in the way: they occupied a third of the
  // frame's width, they sat across the part of the globe you most want to
  // look at, and no amount of blur makes an obstruction stop obstructing.
  // Moved round behind the subject, where they still establish the bench
  // and still take the same light, but the globe is unobstructed.
  // A plant on each side of the subject. The one thing the backdrop
  // photograph cannot do is sit at the same depth as the globe, and a
  // leaf that overlaps the sphere's outline is what stops the room being
  // a picture hanging behind it.
  // Scaled down hard from a first pass that put them at 2.6: a plant that
  // tall stood level with the globe itself and read as two green shapes
  // flanking the subject at exactly the height you least want competition.
  // They belong on the desk, below the sphere's equator.
  buildPottedPlant(rand, at(-5.1, -2.08, -4.2, 1.5, rand() * Math.PI * 2));
  buildPottedPlant(rand, at(5.3, -2.08, -3.9, 1.25, rand() * Math.PI * 2));
  buildBookStack(rand, at(-6.4, -2.08, -2.6, 1.9, rand() * Math.PI * 2));

  // One mesh per material for the whole of the above.
  const propMaterials: Record<PropMaterial, THREE.Material> = {
    glass: new THREE.MeshStandardMaterial({
      color: '#9fb0ad',
      roughness: 0.18,
      metalness: 0,
      transparent: true,
      opacity: 0.55,
    }),
    plastic: new THREE.MeshStandardMaterial({ color: '#26262a', roughness: 0.55 }),
    paper: new THREE.MeshStandardMaterial({
      color: '#d8d2c6',
      roughness: 0.9,
      side: THREE.DoubleSide,
    }),
    wood: new THREE.MeshStandardMaterial({ color: '#6b4a33', roughness: 0.8 }),
    foliage: new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(0.27, 0.38, 0.26, THREE.SRGBColorSpace),
      roughness: 0.95,
      flatShading: true,
    }),
    cotton: new THREE.MeshStandardMaterial({ color: '#e8e6e4', roughness: 0.95 }),
    // One cloth colour for every book, which sounds wrong and is not: a
    // shelf of books in a photograph this far out of focus resolves to a
    // single warm mass, and giving each book its own material would cost a
    // shader compile per colour for a difference no viewer can see. The
    // variety that does read comes from the sizes and the leaning.
    cloth: new THREE.MeshStandardMaterial({ color: '#9c7256', roughness: 0.88 }),
    ceramic: new THREE.MeshStandardMaterial({
      // Knocked well back from a first pass at #d9cdbb, where the pots were
      // the brightest objects in the frame after the globe itself. Glazed
      // stoneware in a dim room, not white porcelain under a spotlight.
      color: '#9c8e7c',
      roughness: 0.6,
      metalness: 0,
    }),
  };

  (Object.keys(props) as PropMaterial[]).forEach((key) => {
    const parts = props[key];
    if (parts.length === 0) return;
    const merged = mergeGeometries(parts, false);
    parts.forEach((g) => g.dispose());
    parts.length = 0;
    const mesh = new THREE.Mesh(merged, propMaterials[key]);
    mesh.castShadow = true;
    group.add(mesh);
  });

  return group;
}
