'use client';

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

type Point = [number, number, number];
type Finish = 'alloy' | 'polished' | 'frame' | 'graphite' | 'rubber' | 'glass' | 'reflection';

/** Presentation geometry only. Neither assembly claims a measured defect location. */
function buildAssembly(kind: 'door' | 'structure') {
  const surfaces: Record<Finish, THREE.MeshStandardMaterial> = {
    alloy: new THREE.MeshStandardMaterial({ color: '#bdccd8', metalness: .68, roughness: .32 }),
    polished: new THREE.MeshStandardMaterial({ color: '#dce6ef', metalness: .9, roughness: .22 }),
    frame: new THREE.MeshStandardMaterial({ color: '#526c86', metalness: .65, roughness: .4 }),
    graphite: new THREE.MeshStandardMaterial({ color: '#28394d', metalness: .48, roughness: .52 }),
    rubber: new THREE.MeshStandardMaterial({ color: '#101925', metalness: .03, roughness: .89 }),
    glass: new THREE.MeshPhysicalMaterial({ color: '#142e48', metalness: .4, roughness: .13, clearcoat: 1, clearcoatRoughness: .1 }),
    reflection: new THREE.MeshStandardMaterial({ color: '#9abdd7', metalness: .8, roughness: .2 }),
  };
  const buckets = new Map<Finish, THREE.BufferGeometry[]>();
  const add = (finish: Finish, geometry: THREE.BufferGeometry, at: Point, rotation: Point = [0, 0, 0]) => {
    geometry.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...at), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)), new THREE.Vector3(1, 1, 1)));
    const normalized = geometry.index ? geometry.toNonIndexed() : geometry;
    if (geometry !== normalized) geometry.dispose();
    normalized.deleteAttribute('uv');
    const bucket = buckets.get(finish) ?? [];
    bucket.push(normalized);
    buckets.set(finish, bucket);
  };
  const box = (finish: Finish, size: Point, at: Point, bevel = .012, rotation: Point = [0, 0, 0]) => {
    add(finish, bevel ? new RoundedBoxGeometry(...size, 2, Math.min(bevel, Math.min(...size) * .22)) : new THREE.BoxGeometry(...size), at, rotation);
  };
  const cylinder = (finish: Finish, radius: number, length: number, at: Point, rotation: Point = [Math.PI / 2, 0, 0], segments = 20) => {
    add(finish, new THREE.CylinderGeometry(radius, radius, length, segments), at, rotation);
  };
  const bolt = (at: Point, rotation: Point = [Math.PI / 2, 0, 0], radius = .035) => cylinder('polished', radius, .027, at, rotation, 6);
  const tube = (finish: Finish, points: Point[], radius: number) => {
    add(finish, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(point => new THREE.Vector3(...point))), 32, radius, 7, false), [0, 0, 0]);
  };

  if (kind === 'door') {
    // Two sealed leaves within the aperture, with an exposed drive cassette.
    box('graphite', [4.76, 4.58, .16], [0, 2.33, -.27]);
    for (const side of [-1, 1]) {
      box('alloy', [.23, 4.46, .46], [side * 2.25, 2.26, .06]);
      box('graphite', [.027, 4.13, .08], [side * 2.105, 2.16, .27], 0);
      const x = side * 1.038;
      box('alloy', [2, 4.10, .17], [x, 2.16, .09], .032);
      box('rubber', [1.54, 1.95, .071], [x, 2.92, .20], .045);
      box('glass', [1.385, 1.80, .025], [x, 2.93, .245], .035);
      box('reflection', [.019, 1.63, .008], [x - .56, 2.94, .26], .003);
      box('reflection', [1.25, .022, .009], [x, 3.73, .26], .003);
      box('polished', [1.83, .57, .035], [x, .55, .196]);
      box('rubber', [.051, 4.07, .05], [side * .035, 2.16, .2], .008);
      box('graphite', [.035, .48, .04], [side * .19, 1.96, .205]);
      // Small screw heads, lower guide shoe and brushed kick plate seams.
      for (const dx of [-.88, .88]) for (const y of [.31, 1.02, 4.02]) bolt([x + dx, y, .20], undefined, .022);
      for (const y of [.35, .39, .43]) box('frame', [1.7, .008, .006], [x, y, .219], 0);
      box('frame', [.42, .1, .26], [x, .25, .04]);
      box('frame', [1.38, .11, .32], [x, 4.28, .02]);
      for (const dx of [-.52, .52]) {
        box('alloy', [.12, .30, .06], [x + dx, 4.41, .13]);
        cylinder('rubber', .107, .1, [x + dx, 4.50, .13]);
        cylinder('polished', .060, .118, [x + dx, 4.50, .14]);
        bolt([x + dx, 4.50, .213]);
      }
      for (const y of [.44, 1.65, 2.85, 4.02]) bolt([side * 2.25, y, .305]);
      box('frame', [.58, .16, .8], [side * 2.16, .02, 0]);
    }
    box('alloy', [4.67, .18, .85], [0, .13, .05]);
    for (let i = 0; i < 12; i++) box('frame', [4.39, .012, .014], [0, .226, -.3 + i * .055], 0);
    box('frame', [4.70, .08, .58], [0, 4.51, -.08]);
    box('alloy', [4.70, .48, .09], [0, 4.77, -.205]);
    box('polished', [4.64, .065, .14], [0, 4.58, .18], .008);
    box('polished', [4.64, .055, .12], [0, 4.89, -.015], .008);
    // Continuous synchronous belt around two pulleys, without implying motion.
    for (const x of [-1.87, 1.87]) {
      cylinder('graphite', .167, .085, [x, 4.82, .105]);
      cylinder('polished', .10, .105, [x, 4.82, .12]);
      bolt([x, 4.82, .186]);
    }
    for (const y of [4.657, 4.983]) box('rubber', [3.73, .037, .065], [0, y, .106], .009);
    for (let i = 0; i < 52; i++) box('frame', [.019, .041, .07], [-1.82 + i * .071, 4.981, .105], 0);
    cylinder('frame', .195, .69, [1.62, 5.15, -.035], [0, 0, Math.PI / 2], 28);
    cylinder('alloy', .198, .08, [1.23, 5.15, -.035], [0, 0, Math.PI / 2], 28);
    for (let i = 0; i < 7; i++) cylinder('graphite', .213, .022, [1.39 + i * .07, 5.15, -.035], [0, 0, Math.PI / 2], 24);
    box('graphite', [.4, .43, .32], [2.00, 5.01, -.03]);
    box('alloy', [.66, .27, .18], [-1.3, 5.14, -.025]);
    for (const x of [-1.57, -1.05]) bolt([x, 5.14, .08], undefined, .022);
    tube('rubber', [[-.95, 5.14, -.03], [-.75, 5.30, -.1], [.4, 5.29, -.1], [.8, 5.15, -.07], [1.15, 5.15, -.05]], .028);
    tube('frame', [[-.48, 4.52, .04], [-.48, 4.84, -.01], [.03, 5.11, -.08], [.54, 5.1, -.07]], .015);
  } else {
    // A neutral bolted structural test assembly: uniform finish, no damage heatmap.
    const longBeam = (x: number, y: number, z: number, length: number, height: number, width: number, rotate = false) => {
      const rotation: Point = rotate ? [0, Math.PI / 2, 0] : [0, 0, 0];
      box('frame', [length, height - .065, .055], [x, y, z], .004, rotation);
      for (const sign of [-1, 1]) box('alloy', [length, .047, width], [x, y + sign * (height / 2 - .024), z], .006, rotation);
    };
    const columns = [-5.72, -2.86, 0, 2.86, 5.72];
    for (const z of [-1.7, 1.7]) {
      longBeam(0, .55, z, 12, .38, .32);
      longBeam(0, 3.18, z, 12, .25, .26);
      for (const x of columns) {
        box('frame', [.07, 2.43, .22], [x, 1.89, z], .005);
        for (const side of [-1, 1]) box('alloy', [.22, 2.43, .045], [x, 1.89, z + side * .12], .005);
        for (const y of [.83, 2.95]) {
          box('frame', [.47, .39, .029], [x, y, z + Math.sign(z) * .161], .01);
          for (const dx of [-.15, .15]) for (const dy of [-.10, .10]) bolt([x + dx, y + dy, z + Math.sign(z) * .184]);
        }
      }
      for (let i = 0; i < 4; i++) {
        const x = (columns[i] + columns[i + 1]) / 2;
        box('frame', [.105, 3.63, .12], [x, 1.88, z], .007, [0, 0, i % 2 ? .84 : -.84]);
        box('polished', [.033, 3.58, .035], [x, 1.88, z + .063], .004, [0, 0, i % 2 ? .84 : -.84]);
      }
      for (const x of [-5.55, 5.55]) {
        box('graphite', [.76, .11, .65], [x, .14, z]);
        box('alloy', [.86, .07, .74], [x, .21, z]);
        cylinder('frame', .23, .17, [x, .29, z], [0, 0, 0], 24);
        box('polished', [.62, .055, .47], [x, .37, z]);
        for (const dx of [-.31, .31]) for (const dz of [-.25, .25]) bolt([x + dx, .26, z + dz], [0, 0, 0], .042);
      }
    }
    for (const x of columns) {
      longBeam(x, .54, 0, 3.62, .29, .21, true);
      longBeam(x, 3.18, 0, 3.52, .18, .18, true);
      for (const z of [-1.5, 1.5]) for (const dx of [-.08, .08]) bolt([x + dx, 3.3, z], [0, 0, 0], .028);
    }
    for (let i = 0; i < 16; i++) {
      box('graphite', [.705, .045, 3.12], [-5.57 + i * .743, .77, 0], .006);
      for (const z of [-1.37, 1.37]) bolt([-5.57 + i * .743, .806, z], [0, 0, 0], .022);
    }
    for (const z of [-.88, .88]) longBeam(0, .52, z, 11.75, .21, .14);
  }

  const pieces = [...buckets].map(([finish, parts]) => {
    const geometry = mergeGeometries(parts, false)!;
    parts.forEach(part => part.dispose());
    geometry.computeBoundingSphere();
    return { finish, geometry, material: surfaces[finish] };
  });
  let owners = 0, disposed = false;
  return {
    pieces,
    retain() { owners++; },
    release() {
      owners--;
      queueMicrotask(() => {
        if (owners || disposed) return;
        disposed = true;
        pieces.forEach(piece => piece.geometry.dispose());
        Object.values(surfaces).forEach(material => material.dispose());
      });
    },
  };
}

export function EngineeringAssembly({ kind }: { kind: 'door' | 'structure' }) {
  const asset = useMemo(() => buildAssembly(kind), [kind]);
  useEffect(() => { asset.retain(); return () => asset.release(); }, [asset]);
  return <group dispose={null}>{asset.pieces.map(piece => <mesh key={piece.finish} geometry={piece.geometry} material={piece.material} castShadow receiveShadow />)}</group>;
}
