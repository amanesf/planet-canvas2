import * as THREE from 'three';
import { mulberry32 } from './spatialHash';

// ---------------------------------------------------------------------
// Aurora (G50)
// ---------------------------------------------------------------------
// The night side of this globe has had lights on it for a while — cities,
// ships' lamps, aircraft strobes, the vents of an erupting volcano — but
// nothing in the *sky* over the dark half. The aurora is the one thing
// that belongs there, and it is the one atmospheric feature a viewer will
// forgive being large, because in life it genuinely is: the curtains run
// from about 100 km to 400 km up, which is thirty to a hundred times the
// height of the cloud deck they stand above.
//
// It is built as curtains and not as a glow, deliberately. §2-21 is the
// record of a shaped feature (lightning) that was built, measured and
// deleted because at this scale it came out 0.3 px wide, and the standing
// conclusion from that section is that "not drawn" and "too small to have
// a shape" are the same picture. A soft coloured haze over the pole is the
// other half of that same failure: it has no shape to be too small,
// because it has no shape at all. So this is sheets — a band of vertical
// ribbons hung round the magnetic pole, brightest along their bottom edge,
// ragged along the top, folding slowly along their length.
//
// ---------------------------------------------------------------------
// The pixel arithmetic, done before any of it was built (§3 of handover)
// ---------------------------------------------------------------------
// One world unit is about 108 px at the shipped camera, so the globe's
// disc is about 430 px across.
//
//   - The auroral oval sits at about 23° from the magnetic pole. Its
//     circle has world radius 2·sin23° = 0.78, i.e. a circumference of
//     4.9 units ≈ 530 px. Split into 30 curtains that is about 18 px of
//     arc each — a sheet, not a hair.
//   - Each curtain stands from 0.36 to 0.92 above the surface: 0.56 units
//     ≈ 60 px tall. That number is *conservative* against the rest of the
//     scene rather than generous. The cloud deck already hovers at
//     0.14–0.34, i.e. 450–1100 km at true scale — this planet's atmosphere
//     is exaggerated about 45× already — and a curtain drawn at the same
//     exaggeration as the clouds it stands over would be several globe
//     radii tall. Making it only 1.6× the height of the cloud deck is
//     under-scaling it, which is the direction §2-21 says to err in.
//   - The fine vertical striations run 55 cycles round the oval ≈ 9.6 px
//     per ray, sampled by 360 columns of geometry (1.5 px per column), so
//     the rays are resolved by the mesh rather than aliased by it.
//
// ---------------------------------------------------------------------
// Where the night actually is (§2-12), and why only one pole lights up
// ---------------------------------------------------------------------
// The terminator does not sweep this disc. The key light is fixed at
// (-5.0, 4.4, 3.2), so the sun sits 36° above the world equator and stays
// there; the globe spins under it about y. Two consequences, both of which
// decided the design:
//
//   1. The north pole has sun·n = +0.59 permanently and the south pole
//      -0.59 permanently. The northern curtains are therefore built and
//      then gated off by their own night term every frame, and the
//      *southern* aurora is the one that shows. That is not a bug to work
//      around — it is what this room's lighting means — and building both
//      ovals costs nothing extra because they share one mesh.
//   2. The camera sits 17° above the equatorial plane, so the south pole
//      is just over the bottom limb. The visible part of the oval is the
//      arc within about ±44° of the camera-facing meridian, which lands it
//      right on the rim of the disc. That is the best possible place for
//      this feature: on the rim the curtains are seen end-on against the
//      dark room, standing up off the edge of the planet, instead of being
//      squashed flat against the paint the way a polar cap ornament is.
//
// The oval is anchored to the geomagnetic axis (80.6°N, 72.6°W, ~11° off
// the spin axis), so as the globe turns the whole band wobbles round the
// pole and the arc leans toward and away from the camera once per
// rotation. That wobble is free motion of exactly the kind the fixed
// terminator cannot give.
//
// One thing that could not be baked: the real auroral oval is offset and
// widened toward magnetic midnight. That offset is fixed relative to the
// *sun*, while the geometry here is fixed relative to the *planet*, so it
// cannot live in the vertex buffer. It is done in the shader instead, off
// the same `uSunDir` the city lights and the volcano vents read — the
// curtains grow taller, brighter and push a little equatorward on the
// anti-solar side. Since that is also the only side anyone can see, it
// mostly reads as the visible arc being the strong part of the band.
//
// ---------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------
// One mesh, one draw call, both poles, for 3,600 vertices and 5,280
// triangles. Geometry is built once; every frame writes a single float.
// Additive blending, which is the right thing for light and avoids the
// `MultiplyBlending`/`premultipliedAlpha` trap that once put a white sheet
// of paper on the desk (§2-18).

export interface Aurora {
  mesh: THREE.Mesh;
  tick: (t: number) => void;
}

/** curtains per pole; 30 gives about 18 px of arc each (see above) */
const CURTAINS_PER_POLE = 30;
/** columns of geometry along one curtain */
const SEGMENTS = 11;
/** rows up one curtain. Four is enough: the sheet is only 60 px tall, but
 * it needs to bend along its height because the fold sways more at the top
 * than at the anchored foot. */
const ROWS = 4;

/** mean angle from the magnetic pole to the band, radians (≈23°) */
const OVAL_COLATITUDE = 0.40;
/** how far the band departs from a circle. Without this it is a ring. */
const OVAL_ELLIPTICITY = 0.055;
/** bottom and top of a curtain, in world units above the surface */
const BASE_ALTITUDE = 0.36;
const TOP_ALTITUDE = 0.92;

export function buildAurora(
  radius: number,
  dayNightUniforms: { uSunDir: { value: THREE.Vector3 } },
): Aurora {
  const rand = mulberry32(5077);

  const COLUMNS = SEGMENTS + 1;
  const VERTS_PER_CURTAIN = COLUMNS * (ROWS + 1);
  const CURTAINS = CURTAINS_PER_POLE * 2;
  const VERTEX_COUNT = CURTAINS * VERTS_PER_CURTAIN;

  const positions = new Float32Array(VERTEX_COUNT * 3);
  /** the foot of the curtain on the sphere, unit length */
  const dirs = new Float32Array(VERTEX_COUNT * 3);
  /**
   * d(foot)/d(arc angle) — the tangent along the oval, deliberately *not*
   * normalised. Carrying the true derivative means the shader can add the
   * derivative of the fold to it and get the folded sheet's real facing
   * direction, which is what the edge-on brightening below needs.
   */
  const tangents = new Float32Array(VERTEX_COUNT * 3);
  /** unit vector pointing away from the magnetic pole along the surface */
  const outwards = new Float32Array(VERTEX_COUNT * 3);
  /** absolute angle round the oval, so a fold runs across curtain seams */
  const arcs = new Float32Array(VERTEX_COUNT);
  /** 0 at the bright bottom edge, 1 at the ragged top */
  const ups = new Float32Array(VERTEX_COUNT);
  /** 0..1 across one curtain, used to fade its two ends out */
  const cols = new Float32Array(VERTEX_COUNT);
  /** per-curtain random, so the sheets do not fold in unison */
  const seeds = new Float32Array(VERTEX_COUNT);
  /** per-column random: this is what makes the top edge ragged */
  const jags = new Float32Array(VERTEX_COUNT);

  const indices: number[] = [];

  // The geomagnetic axis. Same lat/lon convention as terrain's
  // latLonToDir: x = -sinθcosφ, y = cosθ, z = sinθsinφ with
  // θ = (90-lat)π/180 and φ = (lon+180)π/180. 80.6°N 72.6°W is the north
  // geomagnetic pole; the southern oval uses the exact antipode, because a
  // dipole has one axis and not two.
  const theta = ((90 - 80.6) * Math.PI) / 180;
  const phi = ((-72.6 + 180) * Math.PI) / 180;
  const dipole = new THREE.Vector3(
    -Math.sin(theta) * Math.cos(phi),
    Math.cos(theta),
    Math.sin(theta) * Math.sin(phi),
  ).normalize();

  const axis = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const foot = new THREE.Vector3();
  const outward = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const ring = new THREE.Vector3();
  const ringTangent = new THREE.Vector3();

  let v = 0;
  for (let hemi = 0; hemi < 2; hemi++) {
    axis.copy(dipole).multiplyScalar(hemi === 0 ? 1 : -1);
    // any pair of axes perpendicular to the pole will do; the oval is a
    // closed band, so where its zero of longitude sits is arbitrary
    e1.set(0, 0, 1).cross(axis).normalize();
    e2.copy(axis).cross(e1).normalize();

    for (let c = 0; c < CURTAINS_PER_POLE; c++) {
      const seed = rand();
      const base = v;
      // Each curtain covers a little more than its fair share of the band,
      // so neighbours overlap instead of leaving 30 gaps at the seams.
      const centre = (Math.PI * 2 * (c + 0.5)) / CURTAINS_PER_POLE;
      const span = ((Math.PI * 2) / CURTAINS_PER_POLE) * 1.22;

      for (let j = 0; j <= SEGMENTS; j++) {
        const u = j / SEGMENTS;
        const a = centre + (u - 0.5) * span;
        const colat = OVAL_COLATITUDE + OVAL_ELLIPTICITY * Math.cos(2 * a - 0.9);
        const sinC = Math.sin(colat);
        const cosC = Math.cos(colat);

        ring.copy(e1).multiplyScalar(Math.cos(a)).addScaledVector(e2, Math.sin(a));
        ringTangent
          .copy(e1)
          .multiplyScalar(-Math.sin(a))
          .addScaledVector(e2, Math.cos(a));

        foot.copy(axis).multiplyScalar(cosC).addScaledVector(ring, sinC);
        // the equatorward direction along the surface, which is the axis a
        // fold swings along and the direction the field lines lean as they
        // rise
        outward.copy(axis).multiplyScalar(-sinC).addScaledVector(ring, cosC);
        // true derivative of the foot with respect to `a` (the ellipse's
        // own d(colat)/da term is small enough to drop; the point of this
        // vector is its magnitude ≈ the oval's radius, so that the fold
        // derivative added in the shader is in the same units)
        tangent.copy(ringTangent).multiplyScalar(sinC * radius);

        const jag = rand();

        for (let r = 0; r <= ROWS; r++) {
          const up = r / ROWS;
          const i3 = v * 3;
          // The shader places every vertex; `position` only has to be
          // somewhere sane for three's own plumbing (frustum culling is
          // off, but the bounding sphere is still computed).
          const alt = radius + BASE_ALTITUDE + (TOP_ALTITUDE - BASE_ALTITUDE) * up;
          positions[i3] = foot.x * alt;
          positions[i3 + 1] = foot.y * alt;
          positions[i3 + 2] = foot.z * alt;
          dirs[i3] = foot.x;
          dirs[i3 + 1] = foot.y;
          dirs[i3 + 2] = foot.z;
          tangents[i3] = tangent.x;
          tangents[i3 + 1] = tangent.y;
          tangents[i3 + 2] = tangent.z;
          outwards[i3] = outward.x;
          outwards[i3 + 1] = outward.y;
          outwards[i3 + 2] = outward.z;
          arcs[v] = a;
          ups[v] = up;
          cols[v] = u;
          seeds[v] = seed;
          jags[v] = jag;
          v++;
        }
      }

      for (let j = 0; j < SEGMENTS; j++) {
        for (let r = 0; r < ROWS; r++) {
          const a0 = base + j * (ROWS + 1) + r;
          const a1 = a0 + 1;
          const b0 = a0 + (ROWS + 1);
          const b1 = b0 + 1;
          indices.push(a0, b0, a1, a1, b0, b1);
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aDir', new THREE.BufferAttribute(dirs, 3));
  geometry.setAttribute('aTan', new THREE.BufferAttribute(tangents, 3));
  geometry.setAttribute('aOut', new THREE.BufferAttribute(outwards, 3));
  geometry.setAttribute('aArc', new THREE.BufferAttribute(arcs, 1));
  geometry.setAttribute('aUp', new THREE.BufferAttribute(ups, 1));
  geometry.setAttribute('aCol', new THREE.BufferAttribute(cols, 1));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  geometry.setAttribute('aJag', new THREE.BufferAttribute(jags, 1));
  geometry.setIndex(indices);

  const uniforms = {
    uTime: { value: 0 },
    // shared, not copied: one object owns "which way the sun is" and every
    // system that fades at the terminator reads that one object
    uSunDir: dayNightUniforms.uSunDir,
    uRadius: { value: radius },
    uBase: { value: BASE_ALTITUDE },
    uTop: { value: TOP_ALTITUDE },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    // the far half of the oval must be hidden by the planet it is behind
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute vec3 aDir;
      attribute vec3 aTan;
      attribute vec3 aOut;
      attribute float aArc;
      attribute float aUp;
      attribute float aCol;
      attribute float aSeed;
      attribute float aJag;

      uniform float uTime;
      uniform vec3 uSunDir;
      uniform float uRadius;
      uniform float uBase;
      uniform float uTop;

      varying vec3 vColor;
      varying float vAlpha;

      void main() {
        float s = aArc;
        float ph = aSeed * 6.2831;

        // Is this foot on the night side? The identical soft terminator
        // the city lights and the volcano vents use, so the curtains do
        // not come up a beat before or after the lights under them. The
        // globe only spins about y, so a mat3 of the model matrix is the
        // whole transform into the room's frame.
        vec3 nWorld = normalize(mat3(modelMatrix) * aDir);
        float night = clamp((0.16 - dot(nWorld, uSunDir)) / 0.28, 0.0, 1.0);

        // The folds. Three harmonics along the band, each drifting at its
        // own rate, so the band never repeats within a viewing; the
        // amplitudes total about 0.10 world units ≈ 11 px of swing in
        // plan, which at the limb reads mostly as the sheet turning
        // toward and away from the camera. The tops sway more than the
        // feet, which is the difference between a hanging curtain and a
        // corrugated fence.
        float sway = 0.32 + 0.68 * aUp;
        float f =
            sin(s * 9.0 + ph - uTime * 0.33) * 0.055
          + sin(s * 17.0 - uTime * 0.21 + ph * 0.5) * 0.028
          + sin(s * 31.0 + uTime * 0.47) * 0.013;
        // and its exact derivative, which the facing direction below needs
        float df =
            cos(s * 9.0 + ph - uTime * 0.33) * 0.495
          + cos(s * 17.0 - uTime * 0.21 + ph * 0.5) * 0.476
          + cos(s * 31.0 + uTime * 0.47) * 0.403;
        f *= sway;
        df *= sway;

        // The oval widens and brightens toward magnetic midnight. It
        // cannot be baked (see the header), so it is done here against the
        // same sun direction.
        float midnight = smoothstep(0.15, 0.85, night);

        // The top of a curtain is ragged: each column stops at its own
        // height. This is per-column noise baked at build time, so the
        // silhouette is fixed while the folds move — which is what real
        // rays do, they keep their identity and drift.
        float reach = mix(0.58, 1.0, aJag) * (0.85 + 0.30 * midnight);
        float height = uBase + (uTop - uBase) * aUp * reach;

        vec3 dir = normalize(
          aDir
          + aOut * (f + 0.16 * aUp + 0.05 * midnight)
        );
        // 0.16·aUp is the lean of the field line: a dipole's lines arch
        // equatorward as they rise, about 16° from vertical at 67°
        // magnetic latitude, and a curtain that stands perfectly radial
        // instead looks like a fence post.

        vec4 mvPosition = modelViewMatrix * vec4(dir * (uRadius + height), 1.0);
        gl_Position = projectionMatrix * mvPosition;

        // Edge-on brightening. A curtain is a sheet of emitting gas, so a
        // line of sight that runs along the sheet gathers far more of it
        // than one that crosses it; that is why real folds show as bright
        // vertical creases. The facing direction is the true one after
        // folding, which is why aTan carries the derivative rather than a
        // unit vector.
        vec3 fold = normalize(aTan + aOut * df);
        vec3 sheetNormal = normalize(normalMatrix * normalize(cross(fold, aDir)));
        vec3 viewDir = normalize(-mvPosition.xyz);
        float grazing = clamp(1.0 / max(abs(dot(sheetNormal, viewDir)), 0.2), 1.0, 2.4);

        // Brightest along the bottom edge, with a crisp rim in the lowest
        // sixth. Aurora is lit from the bottom up because that is where
        // the atmosphere is dense enough to be excited; a sheet that is
        // uniform, or brightest in the middle, reads as a decal.
        float bottom = pow(1.0 - aUp, 1.8) * 0.7 + smoothstep(0.16, 0.0, aUp) * 0.45;
        // and it dies out below its own ragged ceiling
        float ceiling = 1.0 - smoothstep(mix(0.30, 0.92, aJag), 1.05, aUp);
        // each sheet fades at its two ends so the band is a set of
        // overlapping curtains rather than one continuous tube
        float ends = smoothstep(0.0, 0.16, aCol) * (1.0 - smoothstep(0.84, 1.0, aCol));
        // fine vertical rays: 55 round the oval ≈ 9.6 px apart, resolved
        // by 360 columns of geometry
        float rays = 0.58 + 0.42 * sin(s * 55.0 + ph * 3.0 + uTime * 0.11);
        // and a surge running along the arc, because an aurora brightens
        // in waves that travel rather than pulsing all at once
        float surge = 0.42 + 0.85 * pow(max(0.0, sin(s * 2.0 - uTime * 0.25)), 3.0);

        vAlpha = night * bottom * ceiling * ends * rays * surge * grazing
               * (0.55 + 0.55 * midnight) * 0.34;

        // Green low (the 557.7 nm oxygen line, which is what everybody has
        // seen), violet and a little crimson high up where the emission
        // thins out.
        vColor = mix(vec3(0.18, 1.0, 0.46), vec3(0.42, 0.34, 1.0),
                     smoothstep(0.22, 0.95, aUp));
        vColor += vec3(1.0, 0.22, 0.30) * smoothstep(0.62, 1.0, aUp) * 0.35;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        if (vAlpha <= 0.002) discard;
        gl_FragColor = vec4(vColor, vAlpha);
      }
    `,
  });

  const mesh = new THREE.Mesh(geometry, material);
  // the shader places every vertex, so the bounding sphere three computes
  // from `position` would not describe what is drawn
  mesh.frustumCulled = false;
  // drawn after the globe and the clouds, and it writes no depth
  mesh.renderOrder = 3;

  return {
    mesh,
    tick: (t: number) => {
      uniforms.uTime.value = t;
    },
  };
}
