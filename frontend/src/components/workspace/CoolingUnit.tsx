'use client';

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/** Illustrative roof equipment; no individual unit diagnosis is implied. */
export default function CoolingUnit({ priority, raised }: { priority: boolean; raised: boolean }) {
  const asset = useMemo(() => {
    const groups: Record<string, THREE.BufferGeometry[]> = { shell: [], dark: [], metal: [], blades: [] };
    const box = (part: string, size: [number, number, number], at: [number, number, number], rounded = false) => {
      const geometry = rounded ? new RoundedBoxGeometry(...size, 2, Math.min(.045, Math.min(...size) * .18)) : new THREE.BoxGeometry(...size);
      geometry.translate(...at); groups[part].push(geometry);
    };
    box('shell', [3.96, .4, 1.88], [0, 0, 0], true);
    box('metal', [4.02, .045, 1.92], [0, -.2, 0], true);
    box('dark', [3.72, .02, 1.64], [0, .211, 0], true);
    box('metal', [.12, .032, 1.72], [0, .23, 0]);
    for (const side of [-1, 1]) {
      // Recessed condenser fins, flange seams and service fasteners.
      box('dark', [3.67, .235, .015], [0, -.015, side * .946]);
      for (let i = 0; i < 36; i++) box('blades', [.031, .21, .025], [-1.75 + i * .1, -.015, side * .957]);
      for (const y of [-.13, .10]) box('metal', [3.72, .015, .026], [0, y, side * .965]);
      box('metal', [3.63, .11, .13], [0, -.29, side * .7], true);
      for (const x of [-1.55, 1.55]) box('dark', [.38, .08, .30], [x, -.23, side * .7], true);
      for (const x of [-1.86, 0, 1.86]) {
        const screw = new THREE.CylinderGeometry(.028, .028, .02, 6);
        screw.translate(x, .222, side * .82); groups.metal.push(screw);
      }
    }
    for (const end of [-1, 1]) {
      box('dark', [.013, .25, 1.42], [end * 1.981, .01, 0]);
      box('shell', [.022, .219, 1.35], [end * 1.992, .01, 0], true);
      for (const z of [-.61, .61]) for (const y of [-.07, .09]) {
        const screw = new THREE.CylinderGeometry(.021, .021, .019, 6);
        screw.rotateZ(Math.PI / 2); screw.translate(end * 2.01, y, z); groups.metal.push(screw);
      }
      for (const z of [-.39, .39]) box('metal', [.03, .04, .21], [end * 2.02, -.10, z], true);
    }
    for (const x of [-1.04, 1.04]) {
      const inset = new THREE.CylinderGeometry(.65, .65, .05, 36); inset.translate(x, .23, 0); groups.dark.push(inset);
      const hub = new THREE.CylinderGeometry(.13, .13, .08, 18); hub.translate(x, .285, 0); groups.metal.push(hub);
      for (let i = 0; i < 7; i++) {
        const blade = new THREE.BoxGeometry(.49, .035, .17);
        blade.rotateX(.25); blade.translate(.33, 0, 0); blade.rotateY(i * Math.PI * 2 / 7); blade.translate(x, .27, 0); groups.blades.push(blade);
      }
      for (const radius of [.25, .39, .53, .65]) {
        const guard = new THREE.TorusGeometry(radius, .012, 4, 36);
        guard.rotateX(-Math.PI / 2); guard.translate(x, .33, 0); groups.metal.push(guard);
      }
      for (let i = 0; i < 6; i++) {
        const strut = new THREE.BoxGeometry(1.3, .016, .014);
        strut.rotateY(i * Math.PI / 6); strut.translate(x, .34, 0); groups.metal.push(strut);
      }
    }
    const materials: Record<string, THREE.MeshStandardMaterial> = {
      shell: new THREE.MeshStandardMaterial({ color: '#aabacb', metalness: .7, roughness: .35 }),
      dark: new THREE.MeshStandardMaterial({ color: '#142134', metalness: .28, roughness: .76 }),
      metal: new THREE.MeshStandardMaterial({ color: '#d5e3ef', metalness: .88, roughness: .23 }),
      blades: new THREE.MeshStandardMaterial({ color: '#526b85', metalness: .67, roughness: .39 }),
    };
    const pieces = Object.entries(groups).map(([part, geometries]) => {
      // RoundedBoxGeometry is non-indexed; normalize every shape before batching.
      const normalized = geometries.map(item => { if (!item.index) return item; const copy = item.toNonIndexed(); item.dispose(); return copy; });
      const geometry = mergeGeometries(normalized)!; normalized.forEach(item => item.dispose());
      geometry.computeBoundingSphere();
      return { part, geometry, material: materials[part] };
    });
    let owners = 0, disposed = false;
    return { pieces, retain() { owners++; }, release() { owners--; queueMicrotask(() => { if (!owners && !disposed) { disposed = true; pieces.forEach(item => { item.geometry.dispose(); item.material.dispose(); }); } }); } };
  }, []);
  useEffect(() => { asset.retain(); return () => asset.release(); }, [asset]);
  return <group>
    {asset.pieces.map(piece => <mesh key={piece.part} geometry={piece.geometry} material={piece.material} castShadow receiveShadow dispose={null}/>)}
    {priority && [-.99, .99].map(z => <mesh key={z} position={[0, -.19, z]}><boxGeometry args={[4.12, .025, .025]}/><meshBasicMaterial color="#f3b25f"/></mesh>)}
    {raised && [-1.8, 1.8].map(x => <mesh key={x} position={[x, -.69, 0]}><cylinderGeometry args={[.012, .012, 1, 6]}/><meshStandardMaterial color="#9eb3bd" transparent opacity={.55}/></mesh>)}
  </group>;
}
