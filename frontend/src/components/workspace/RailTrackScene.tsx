'use client';

import { useEffect, useMemo } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

type Side = 1 | 2;
export type RailTrackSceneProps = {
  flaggedSide: Side | null;
  selectedSide?: Side;
  onSelectSide: (side: Side) => void;
};

/** Illustrative track, not a reconstruction of a measured defect.
 * X is the running direction. Side I is +Z, Side II is -Z.
 * Bounds: X ±6.35 m, Z ±1.90 m, Y 0–0.46 m; rail centres Z ±0.758 m.
 * Uses 13–14 draw calls before shadow passes, including selection hit areas.
 */
export const RAIL_TRACK_BOUNDS = {
  halfLength: 6.35,
  halfWidth: 1.9,
  railHeight: .46,
  railOffset: .758,
} as const;

function randomSource(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function shapeGeometry(points: [number, number][], length: number, bevel = 0) {
  const shape = new THREE.Shape();
  points.forEach(([x, y], i) => i ? shape.lineTo(x, y) : shape.moveTo(x, y));
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: length, steps: 1, curveSegments: 3,
    bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2,
  });
  geometry.translate(0, 0, -length / 2);
  geometry.rotateY(Math.PI / 2);
  return geometry;
}

function aggregate(geometries: THREE.BufferGeometry[]) {
  const result = mergeGeometries(geometries, false)!;
  geometries.forEach(geometry => geometry.dispose());
  return result;
}

function buildTrackResources() {
  const random = randomSource(42831);
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const instances: THREE.InstancedMesh[] = [];
  const textures: THREE.Texture[] = [];
  const own = <T extends THREE.BufferGeometry>(geometry: T) => { geometries.push(geometry); return geometry; };
  const material = (parameters: THREE.MeshStandardMaterialParameters) => {
    const item = new THREE.MeshStandardMaterial(parameters);
    materials.push(item);
    return item;
  };

  // Procedural surface grain is decorative material detail, never telemetry.
  const textureSize = 128;
  const pixels = new Uint8Array(textureSize * textureSize * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    const grain = Math.round(112 + random() * 72 + (random() > .97 ? 48 : 0));
    pixels[i] = pixels[i + 1] = pixels[i + 2] = grain;
    pixels[i + 3] = 255;
  }
  const grain = new THREE.DataTexture(pixels, textureSize, textureSize, THREE.RGBAFormat);
  grain.wrapS = grain.wrapT = THREE.RepeatWrapping;
  grain.repeat.set(5, 5);
  grain.magFilter = THREE.LinearFilter;
  grain.minFilter = THREE.LinearMipmapLinearFilter;
  grain.generateMipmaps = true;
  grain.needsUpdate = true;
  textures.push(grain);

  const concrete = material({ color: '#9aabbd', roughness: .92, map: grain, bumpMap: grain, bumpScale: .012 });
  const ballast = material({ color: '#ffffff', roughness: .99, flatShading: true, map: grain, bumpMap: grain, bumpScale: .008 });
  const bedMaterial = material({ color: '#27364b', roughness: 1, bumpMap: grain, bumpScale: .025 });
  const railSteel = material({ color: '#718396', metalness: .86, roughness: .34 });
  const runningSteel = material({ color: '#cedde9', metalness: .98, roughness: .17 });
  const selectedSteel = material({ color: '#e4f1ff', metalness: .94, roughness: .19 });
  const fastener = material({ color: '#565452', metalness: .78, roughness: .49 });
  const springSteel = material({ color: '#746452', metalness: .76, roughness: .48 });
  const boltSteel = material({ color: '#929b9d', metalness: .91, roughness: .32 });
  const rubber = material({ color: '#20272a', roughness: .93 });
  const finding = new THREE.MeshBasicMaterial({ color: '#f5b14f', toneMapped: false });
  materials.push(finding);
  const hitMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
  materials.push(hitMaterial);

  // A recognisable flat-bottom rail section: broad foot, narrow web and rounded head.
  const railProfile = own(shapeGeometry([
    [-.075, 0], [.075, 0], [.075, .015], [.044, .026], [.014, .036],
    [.011, .125], [.028, .137], [.036, .148], [.036, .173], [.027, .184],
    [-.027, .184], [-.036, .173], [-.036, .148], [-.028, .137], [-.011, .125],
    [-.014, .036], [-.044, .026], [-.075, .015],
  ], 12.2, .002));
  const railTop = own(shapeGeometry([
    [-.028, 0], [.028, 0], [.032, .004], [.028, .008], [-.028, .008], [-.032, .004],
  ], 12.2, .001));
  const findingLine = own(new THREE.BoxGeometry(12.18, .012, .062));
  const hitGeometry = own(new THREE.BoxGeometry(12.25, .42, .35));
  const bed = own(shapeGeometry([[-1.9, 0], [1.9, 0], [1.55, .095], [-1.55, .095]], 12.6));
  const sleeper = own(shapeGeometry([
    [-1.32, 0], [1.32, 0], [1.30, .13], [1.04, .166], [.65, .166],
    [.45, .123], [-.45, .123], [-.65, .166], [-1.04, .166], [-1.30, .13],
  ], .255, .012));
  const pad = own(new THREE.BoxGeometry(.29, .013, .33));
  const plate = own(new THREE.BoxGeometry(.31, .018, .315));
  const spring = own(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
    new THREE.Vector3(.092, 0, .052), new THREE.Vector3(.114, .030, .016),
    new THREE.Vector3(.080, .052, -.045), new THREE.Vector3(.018, .051, -.064),
    new THREE.Vector3(-.065, .046, -.040), new THREE.Vector3(-.090, .018, .015),
    new THREE.Vector3(-.045, .004, .055),
  ]), 22, .011, 6, false));
  const bolt = own(aggregate([
    new THREE.CylinderGeometry(.011, .011, .055, 10).translate(0, -.012, 0),
    new THREE.CylinderGeometry(.026, .026, .023, 6).translate(0, .013, 0),
    new THREE.CylinderGeometry(.033, .033, .006, 16),
  ]));
  const stone = own(new THREE.IcosahedronGeometry(1, 0));
  const stonePosition = stone.getAttribute('position');
  // All stones share one angular shape; instance rotation/scale/colour vary.
  for (let i = 0; i < stonePosition.count; i++) {
    const x = stonePosition.getX(i), y = stonePosition.getY(i), z = stonePosition.getZ(i);
    const distortion = 1 + .15 * Math.sin(x * 12.3 + y * 18.9 + z * 8.1);
    stonePosition.setXYZ(i, x * distortion, y * distortion, z * distortion);
  }
  stone.computeVertexNormals();

  const staticGroup = new THREE.Group();
  const bedMesh = new THREE.Mesh(bed, bedMaterial);
  bedMesh.receiveShadow = true;
  staticGroup.add(bedMesh);
  const transform = new THREE.Object3D();
  const color = new THREE.Color();
  const instance = (geometry: THREE.BufferGeometry, surface: THREE.Material, count: number, shadows = true) => {
    const mesh = new THREE.InstancedMesh(geometry, surface, count);
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    instances.push(mesh);
    staticGroup.add(mesh);
    return mesh;
  };
  const stamp = (mesh: THREE.InstancedMesh, index: number, x: number, y: number, z: number, rotation = 0) => {
    transform.position.set(x, y, z);
    transform.rotation.set(0, rotation, 0);
    transform.scale.set(1, 1, 1);
    transform.updateMatrix();
    mesh.setMatrixAt(index, transform.matrix);
  };
  const sleeperCount = 21;
  const sleepers = instance(sleeper, concrete, sleeperCount);
  const pads = instance(pad, rubber, sleeperCount * 2);
  const plates = instance(plate, fastener, sleeperCount * 2);
  const clips = instance(spring, springSteel, sleeperCount * 4);
  const bolts = instance(bolt, boltSteel, sleeperCount * 8);
  for (let i = 0; i < sleeperCount; i++) {
    const x = (i - (sleeperCount - 1) / 2) * .586;
    stamp(sleepers, i, x, .074, 0);
    sleepers.setColorAt(i, color.setScalar(.85 + random() * .15));
    for (let side = 0; side < 2; side++) {
      const z = side === 0 ? .758 : -.758;
      const seat = i * 2 + side;
      stamp(pads, seat, x, .244, z);
      stamp(plates, seat, x, .258, z);
      for (let edge = 0; edge < 2; edge++) {
        const sign = edge === 0 ? 1 : -1;
        const assembly = seat * 2 + edge;
        stamp(clips, assembly, x, .285, z + sign * .104, sign < 0 ? Math.PI : 0);
        for (let end = 0; end < 2; end++) {
          stamp(bolts, assembly * 2 + end, x + (end ? -.109 : .109), .275, z + sign * .116);
        }
      }
    }
  }

  const stoneColumns = 135, stoneRows = 36;
  const stones = instance(stone, ballast, stoneColumns * stoneRows, true);
  for (let x = 0; x < stoneColumns; x++) for (let z = 0; z < stoneRows; z++) {
    const index = x * stoneRows + z;
    const longitudinal = ((x + random()) / stoneColumns - .5) * 12.65;
    const transverse = ((z + random()) / stoneRows - .5) * 3.73;
    const slope = Math.max(0, Math.abs(transverse) - 1.42) * .16;
    transform.position.set(longitudinal, .068 - slope + random() * .028, transverse);
    transform.rotation.set(random() * Math.PI, random() * Math.PI, random() * Math.PI);
    transform.scale.set(.045 + random() * .044, .031 + random() * .026, .044 + random() * .039);
    transform.updateMatrix();
    stones.setMatrixAt(index, transform.matrix);
    stones.setColorAt(index, color.setHSL(.58 + random() * .05, .06 + random() * .06, .09 + random() * .08));
  }
  instances.forEach(mesh => {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  });

  // Deferring disposal by one microtask lets React StrictMode replay effects
  // without destroying the resources that the immediate second mount retains.
  let owners = 0, disposed = false;
  return {
    staticGroup, railProfile, railTop, findingLine, hitGeometry,
    railSteel, runningSteel, selectedSteel, finding, hitMaterial,
    retain() { owners++; },
    release() {
      owners--;
      queueMicrotask(() => {
        if (owners !== 0 || disposed) return;
        disposed = true;
        instances.forEach(mesh => mesh.dispose());
        geometries.forEach(geometry => geometry.dispose());
        materials.forEach(item => item.dispose());
        textures.forEach(texture => texture.dispose());
      });
    },
  };
}

export function RailTrackScene({ flaggedSide, selectedSide, onSelectSide }: RailTrackSceneProps) {
  const resources = useMemo(() => buildTrackResources(), []);
  useEffect(() => {
    resources.retain();
    return () => resources.release();
  }, [resources]);
  const choose = (event: ThreeEvent<MouseEvent>, side: Side) => {
    event.stopPropagation();
    onSelectSide(side);
  };
  return <group dispose={null}>
    <primitive object={resources.staticGroup} />
    {([1, 2] as const).map(side => <group key={side} position={[0, .27, side === 1 ? .758 : -.758]} onClick={event => choose(event, side)}>
      <mesh geometry={resources.railProfile} material={resources.railSteel} castShadow receiveShadow />
      <mesh geometry={resources.railTop} material={side === selectedSide ? resources.selectedSteel : resources.runningSteel} position={[0, .181, 0]} castShadow receiveShadow />
      {/* Finding overlay sits just above the running surface so either side is visible. */}
      {flaggedSide === side && <mesh geometry={resources.findingLine} material={resources.finding} position={[0, .195, 0]} />}
      <mesh geometry={resources.hitGeometry} material={resources.hitMaterial} position={[0, .065, 0]} />
    </group>)}
  </group>;
}
