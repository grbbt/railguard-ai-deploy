"use client";

import { useEffect, useMemo, useRef, type ComponentRef } from "react";
import { useThree, type ThreeEvent } from "@react-three/fiber";
import { Environment, Lightformer, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

export type TrainView = "assembled" | "trainset" | "bogie" | "exploded";
type Part = "bogies" | "doors" | "brakes" | "motors";
type Status = "healthy" | "warning" | "critical" | "unknown";
type Point = [number, number, number];
type Piece = { geometry: THREE.BufferGeometry; material: string };
type Section = "body" | "doorsLeft" | "doorsRight" | "bogies" | "brakes" | "motors";
type Asset = Record<Section, Piece[]>;
const COLORS: Record<Status, string> = { healthy: "#55d6b0", warning: "#efba62", critical: "#f57d78", unknown: "#708797" };
const PARTS: Part[] = ["bogies", "doors", "brakes", "motors"];
const DOORS = [-7.95, -2.65, 2.65, 7.95];
const BOGIE_CENTERS = [-7.8, 7.8];
const CAR_PITCH = 23.42;

/** Metre-based presentation geometry, visually referenced to LTA/SMRT R151 imagery.
 * Neither the exterior dimensions nor the concealed mechanisms are engineering CAD. */
function createTrainResources(neutral = false, includeCoolingModules = true) {
  const box = new THREE.BoxGeometry(1, 1, 1);
  const round = new RoundedBoxGeometry(1, 1, 1, 2, .08);
  const cylinder = new THREE.CylinderGeometry(1, 1, 1, 28);
  const ring = new THREE.TorusGeometry(1, .033, 7, 32);
  const bolt = new THREE.CylinderGeometry(1, 1, 1, 6);
  const materials: Record<string, THREE.Material> = {};
  const standard = (name: string, color: string, metalness: number, roughness: number) => {
    materials[name] = new THREE.MeshStandardMaterial({ color, metalness, roughness });
  };
  standard("shell", "#dce2e5", .5, .29);
  standard("silver", "#bdc8ce", .74, .25);
  standard("trim", "#79878f", .85, .3);
  standard("black", "#0c141a", .35, .31);
  standard("glass", "#152934", .7, .16);
  standard("reflection", "#718c9b", .68, .18);
  standard("rubber", "#11171a", .04, .9);
  standard("frame", "#303c43", .7, .49);
  standard("steel", "#8f9ca5", .85, .28);
  standard("wheel", "#52616c", .88, .33);
  standard("red", neutral ? "#387a7d" : "#c72c37", .32, .36);
  standard("green", neutral ? "#617f85" : "#268859", .28, .39);
  standard("copper", "#9c7251", .75, .35);
  standard("rail", "#71818e", .88, .3);
  standard("sleeper", "#263540", .07, .88);
  if (neutral) {
    materials.glass.dispose();
    materials.glass = new THREE.MeshPhysicalMaterial({ color: "#172b46", metalness: .4, roughness: .12, clearcoat: 1, clearcoatRoughness: .09 });
  }
  materials.light = new THREE.MeshStandardMaterial({ color: "#eafaff", emissive: "#c0eaff", emissiveIntensity: 1.4, roughness: .19 });
  materials.marker = new THREE.MeshStandardMaterial({ color: "#ffada0", emissive: "#df4433", emissiveIntensity: .8, roughness: .25 });

  // An original, local texture gives the cab display readable context without any
  // external font, image request or claim that this is a live destination feed.
  const displayCanvas = document.createElement("canvas");
  displayCanvas.width = 512;
  displayCanvas.height = 96;
  const displayContext = displayCanvas.getContext("2d");
  if (displayContext) {
    displayContext.fillStyle = "#071413";
    displayContext.fillRect(0, 0, 512, 96);
    displayContext.font = "500 42px 'Segoe UI', sans-serif";
    displayContext.fillStyle = "#afd9ad";
    displayContext.textAlign = "center";
    displayContext.fillText(neutral ? "" : "SINGAPORE", 256, 63);
  }
  const display = new THREE.CanvasTexture(displayCanvas);
  display.colorSpace = THREE.SRGBColorSpace;
  materials.display = new THREE.MeshBasicMaterial({ map: display, toneMapped: false });

  class SpringCurve extends THREE.Curve<THREE.Vector3> {
    constructor() { super(); }
    getPoint(t: number, target = new THREE.Vector3()) {
      const a = t * Math.PI * 11;
      return target.set(Math.cos(a) * .105, t * .28, Math.sin(a) * .105);
    }
  }
  const spring = new THREE.TubeGeometry(new SpringCurve(), 70, .021, 6, false);
  const base = { box, round, cylinder, ring, bolt, spring };

  class Builder {
    buckets = new Map<string, THREE.BufferGeometry[]>();
    add(material: string, geometry: THREE.BufferGeometry, position: Point = [0, 0, 0], scale: Point = [1, 1, 1], rotation: Point = [0, 0, 0]) {
      const copy = geometry.clone();
      copy.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...position), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)), new THREE.Vector3(...scale)));
      const normalized = copy.index ? copy.toNonIndexed() : copy;
      if (normalized !== copy) copy.dispose();
      // UVs are only required for the destination panel, which is rendered alone.
      normalized.deleteAttribute("uv");
      const bucket = this.buckets.get(material) ?? [];
      bucket.push(normalized);
      this.buckets.set(material, bucket);
    }
    box(material: string, p: Point, s: Point, rounded = false, r: Point = [0, 0, 0]) { this.add(material, rounded ? round : box, p, s, r); }
    cylinder(material: string, p: Point, s: Point, r: Point = [Math.PI / 2, 0, 0]) { this.add(material, cylinder, p, s, r); }
    finish(): Piece[] {
      return [...this.buckets].map(([material, geometries]) => {
        const geometry = mergeGeometries(geometries, false)!;
        geometries.forEach(g => g.dispose());
        geometry.computeBoundingSphere();
        return { material, geometry };
      });
    }
  }

  function surface(rows: Point[][], caps = false) {
    const vertices: number[] = [];
    const indices: number[] = [];
    const width = rows[0].length;
    rows.forEach(row => row.forEach(p => vertices.push(...p)));
    for (let i = 0; i < rows.length - 1; i++) for (let j = 0; j < width - (caps ? 0 : 1); j++) {
      const a = i * width + j, b = i * width + (j + 1) % width, c = a + width, d = b + width;
      indices.push(a, b, d, a, d, c);
    }
    if (caps) for (let j = 1; j < width - 1; j++) {
      indices.push(0, j + 1, j);
      const o = (rows.length - 1) * width;
      indices.push(o, o + j, o + j + 1);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }

  function buildCar(cab: boolean): Asset {
    const body = new Builder(), doorsLeft = new Builder(), doorsRight = new Builder();
    // Rounded shoulder/roof and a slightly tucked-under sill; the nose is lofted
    // into this continuous body rather than attached as a rectangular block.
    const section: [number, number][] = [
      [1.10, -1.37], [1.20, -1.51], [1.45, -1.59], [2.98, -1.60],
      [3.24, -1.54], [3.44, -1.37], [3.61, -1.05], [3.71, -.55], [3.74, 0],
      [3.71, .55], [3.61, 1.05], [3.44, 1.37], [3.24, 1.54], [2.98, 1.60],
      [1.45, 1.59], [1.20, 1.51], [1.10, 1.37],
    ];
    const rows: Point[][] = [-11.25, -10.9, 8.9, cab ? 9.6 : 11.25].map(x => section.map(([y, z]) => [x, y, z]));
    if (cab) {
      rows.push(section.map(([y, z]) => [10.45 - Math.max(0, y - 2.5) * .1, y - .03, z * .97]));
      rows.push(section.map(([y, z]) => [11.57 - (y - 1.25) * .34 - Math.abs(z) * .09, y - .06, z * .86]));
    }
    const shell = surface(rows, true);
    body.add("shell", shell);
    shell.dispose();
    // Continuous metal solebar with genuine-looking fine longitudinal seams.
    body.box("frame", [0, 1.08, 0], [22.4, .18, 2.85]);
    body.box("silver", [0, 1.20, 0], [22.25, .14, 3.03], true);
    for (const side of [-1, 1]) {
      body.box("trim", [cab ? -.7 : 0, 1.34, side * 1.566], [cab ? 21.1 : 22.45, .025, .028]);
      body.box("red", [cab ? -.52 : 0, 3.245, side * 1.548], [cab ? 21.45 : 22.5, .105, .025]);
      body.box("silver", [cab ? -.52 : 0, 3.324, side * 1.487], [cab ? 21.45 : 22.5, .045, .028]);
      // Panoramic bays alternate with four paired, flush plug/sliding doors.
      const bays = [{ x: -10.12, width: 1.14 }, { x: -5.30, width: 3.50 }, { x: 0, width: 3.50 }, { x: 5.30, width: 3.50 }, ...(!cab ? [{ x: 10.12, width: 1.14 }] : [])];
      for (const { x, width } of bays) {
        body.box("black", [x, 2.64, side * 1.607], [width + .12, 1.14, .028], true);
        body.box("glass", [x, 2.66, side * 1.626], [width, 1.025, .015], true);
        body.box("reflection", [x, 3.11, side * 1.637], [width - .14, .018, .006]);
        body.box("green", [x, 2.007, side * 1.607], [width + .25, .105, .027]);
      }
      // Low-profile equipment/identification plates are deliberately unnumbered:
      // a component-level dataset does not identify a real R151 carriage.
      body.box("trim", [-9.78, 1.64, side * 1.594], [.38, .105, .012], true);
      body.box("red", [-9.77, 1.80, side * 1.596], [.29, .035, .013]);
      const doors = side < 0 ? doorsLeft : doorsRight;
      for (const x of DOORS) {
        doors.box("black", [x, 2.23, side * 1.61], [1.67, 1.99, .027], true);
        for (const leaf of [-1, 1]) {
          const dx = x + leaf * .389;
          doors.box("silver", [dx, 2.22, side * 1.637], [.756, 1.93, .03], true);
          doors.box("black", [dx, 2.765, side * 1.658], [.52, .775, .018], true);
          doors.box("glass", [dx, 2.777, side * 1.672], [.455, .70, .012], true);
          doors.box("reflection", [dx - .15, 2.78, side * 1.681], [.012, .60, .004]);
          doors.box("green", [dx, 1.949, side * 1.66], [.75, .106, .023]);
          doors.box("trim", [x + leaf * .075, 2.14, side * 1.668], [.018, .25, .024], true);
        }
        doors.box("black", [x, 2.24, side * 1.676], [.015, 1.91, .01]);
        doors.box("silver", [x, 1.241, side * 1.66], [1.71, .045, .22]);
        doors.box("doorsAccent", [x, 3.23, side * 1.654], [1.64, .019, .015]);
        for (const dx of [-.815, .815]) doors.box("doorsAccent", [x + dx, 2.24, side * 1.647], [.017, 1.96, .013]);
      }
      if (cab) {
        body.box("black", [9.43, 2.60, side * 1.612], [.78, 1.05, .034], true, [0, side * .02, 0]);
        body.box("glass", [9.44, 2.63, side * 1.637], [.64, .90, .02], true, [0, side * .02, 0]);
        body.box("green", [9.38, 2.0, side * 1.611], [.86, .105, .026]);
      }
    }

    // Roof HVAC: two gently faired units with condenser grids and fans.
    for (const x of [-5.2, 4.5]) {
      body.box("silver", [x, 3.79, 0], [4.3, .19, 1.85], true);
      // ACV supplies a detailed removable housing; keep its mounting plinth only.
      if (!includeCoolingModules) continue;
      body.box("shell", [x, 3.94, 0], [3.95, .22, 1.72], true);
      for (const offset of [-1.04, 1.04]) {
        body.box("black", [x + offset, 4.057, 0], [1.55, .025, 1.24], true);
        for (let k = 0; k < 13; k++) body.box("trim", [x + offset - .65 + k * .107, 4.077, 0], [.032, .026, 1.16]);
      }
      for (const side of [-1, 1]) for (let k = 0; k < 16; k++) body.box("trim", [x - 1.72 + k * .23, 3.925, side * .864], [.125, .09, .01]);
    }
    body.box("trim", [-.32, 3.78, 0], [3.8, .075, .63], true);
    body.box("black", [9.65, 3.60, 0], [.29, .19, .16], true);

    // Underframe housings, ventilation, reservoirs and cable runs.
    for (const [x, length, z] of [[-3.8, 2.4, .48], [-.8, 2.55, -.30], [2.23, 2.25, .45], [4.6, 1.35, -.4]]) {
      body.box("frame", [x, .77, z], [length, .53, 1.30], true);
      body.box("trim", [x, .78, z + .66], [length - .12, .38, .018]);
      for (let k = 0; k < 12; k++) body.box("black", [x - length * .42 + k * length * .076, .79, z + .675], [.034, .30, .014]);
      for (const dx of [-length * .4, length * .4]) body.box("steel", [x + dx, .95, z], [.06, .23, 1.36]);
    }
    for (const z of [-.45, .1]) body.cylinder("frame", [3.8, .65, z], [.20, 1.4, .20], [0, 0, Math.PI / 2]);
    for (const z of [-1.05, 1.05]) body.cylinder("rubber", [0, .95, z], [.034, 11.5, .034], [0, 0, Math.PI / 2]);

    // Bellows at the inner end; only the end driving cars have a sculpted cab.
    for (const end of cab ? [-1] : [-1, 1]) {
      body.box("black", [end * 11.29, 2.27, 0], [.15, 2.15, 1.76], true);
      for (let i = 0; i < 5; i++) body.box("rubber", [end * (11.34 + i * .048), 2.28, 0], [.025, 2.23 - i * .017, 1.87 - i * .013], true);
      body.box("frame", [end * 11.52, .83, 0], [.6, .17, .34], true);
    }
    if (cab) {
      // The broad dark face tapers to a chin between the white swept cheeks.
      const frontX = (y: number, z: number) => 11.64 - (y - 1.25) * .34 - Math.abs(z) * .10;
      const maskRows = [[1.44, .78], [1.66, .99], [2.13, 1.21], [2.9, 1.24], [3.30, 1.15], [3.49, .91], [3.56, .54]].map(([y, w]) => [-1, -.75, -.35, 0, .35, .75, 1].map(t => [frontX(y, w * t), y, w * t] as Point));
      const mask = surface(maskRows.reverse()); body.add("black", mask); mask.dispose();
      const windRows = [[1.90, .86], [2.90, .94], [3.19, .84]].map(([y, w]) => [-1, -.5, 0, .5, 1].map(t => [frontX(y, w * t) + .017, y, w * t] as Point));
      const windshield = surface(windRows.reverse()); body.add("glass", windshield); windshield.dispose();
      const reflectionRows = [[2.79, .914], [2.85, .919]].map(([y, w]) => [-1, 0, 1].map(t => [frontX(y, w * t) + .027, y, w * t] as Point));
      const reflection = surface(reflectionRows.reverse()); body.add("reflection", reflection); reflection.dispose();
      for (const side of [-1, 1]) {
        // Narrow teardrop headlamp pods follow the swept edge of the nose.
        const lampRows = [[1.62, 1.00, .015], [1.78, 1.085, .095], [2.02, 1.16, .082], [2.16, 1.17, .012]].map(([y, z, width]) => [-1, 0, 1].map(t => [frontX(y, side * (z + t * width)) + .035, y, side * (z + t * width)] as Point));
        const pod = surface(side > 0 ? lampRows.reverse() : lampRows);
        body.add("black", pod); pod.dispose();
        const lensRows = [[1.73, 1.052, .011], [1.82, 1.091, .047], [1.98, 1.144, .041], [2.045, 1.155, .010]].map(([y, z, width]) => [-1, 0, 1].map(t => [frontX(y, side * (z + t * width)) + .046, y, side * (z + t * width)] as Point));
        const lens = surface(side > 0 ? lensRows.reverse() : lensRows);
        body.add("light", lens); lens.dispose();
        body.box("marker", [frontX(2.085, 1.17) + .047, 2.085, side * 1.17], [.019, .037, .048], true);
        body.box("rubber", [11.29, 1.025, side * .94], [.19, .32, .66], true);
        for (let i = 0; i < 5; i++) body.box("trim", [11.39, .91 + i * .051, side * .94], [.025, .018, .60]);
        // Wiper arms and their sweep pivots, resting at the windshield edges.
        body.box("black", [11.14, 2.61, side * .84], [.036, .92, .025], false, [0, 0, .31]);
        body.cylinder("trim", [11.28, 2.15, side * .84], [.035, .03, .035], [0, 0, Math.PI / 2]);
      }
      body.box("frame", [11.65, .78, 0], [.68, .23, .35], true);
      body.box("steel", [11.97, .80, 0], [.16, .31, .54], true);
      body.box("black", [12.06, .80, 0], [.04, .18, .28], true);
      body.cylinder("rubber", [11.77, .53, .26], [.051, .42, .051], [0, 0, -.25]);
    }
    return { body: body.finish(), doorsLeft: doorsLeft.finish(), doorsRight: doorsRight.finish(), bogies: [], motors: [], brakes: [] };
  }

  function buildBogie(): Asset {
    const frame = new Builder(), motors = new Builder(), brakes = new Builder();
    for (const axle of [-1.18, 1.18]) {
      frame.cylinder("steel", [axle, .55, 0], [.09, 2.25, .09]);
      for (const side of [-1, 1]) {
        const z = side * .78;
        frame.cylinder("wheel", [axle, .55, z], [.435, .16, .435]);
        frame.cylinder("steel", [axle, .55, z - side * .085], [.456, .027, .456]);
        frame.cylinder("frame", [axle, .55, z + side * .092], [.332, .026, .332]);
        frame.cylinder("wheel", [axle, .55, z + side * .111], [.257, .025, .257]);
        frame.add("steel", ring, [axle, .55, z + side * .13], [.33, .33, .35]);
        frame.cylinder("steel", [axle, .55, side * 1.02], [.137, .36, .137]);
        frame.box("frame", [axle, .56, side * 1.12], [.37, .30, .28], true);
        frame.cylinder("bogiesAccent", [axle, .55, side * 1.27], [.108, .033, .108]);
        for (let k = 0; k < 6; k++) {
          const a = k * Math.PI / 3;
          frame.add("steel", bolt, [axle + Math.cos(a) * .082, .55 + Math.sin(a) * .082, side * 1.293], [.018, .025, .018], [Math.PI / 2, 0, 0]);
        }
        frame.add("steel", spring, [axle, .70, side * 1.08]);
        frame.cylinder("frame", [axle, 1.0, side * 1.08], [.15, .06, .15], [0, 0, 0]);
        frame.cylinder("steel", [axle + .22, .87, side * 1.07], [.036, .36, .036], [0, 0, -.14]);
        // Discs/calipers are exposed in the running-gear view. Their topology is
        // illustrative; no supplier-specific mechanism is inferred from photos.
        brakes.cylinder("steel", [axle, .55, side * .49], [.31, .049, .31]);
        brakes.add("trim", ring, [axle, .55, side * .524], [.276, .276, .4]);
        brakes.add("trim", ring, [axle, .55, side * .525], [.225, .225, .4]);
        brakes.box("brakesAccent", [axle - .19, .74, side * .49], [.21, .31, .15], true, [0, 0, -.37]);
        brakes.cylinder("frame", [axle - .28, .68, side * .48], [.091, .27, .091]);
      }
    }
    for (const side of [-1, 1]) {
      frame.box("frame", [0, .94, side * 1.045], [3.18, .21, .29], true);
      frame.box("bogiesAccent", [0, 1.064, side * 1.05], [3.15, .037, .30]);
      frame.box("steel", [0, .811, side * 1.05], [3.20, .045, .34]);
      frame.cylinder("rubber", [0, 1.18, side * .92], [.31, .24, .31], [0, 0, 0]);
      for (const y of [1.11, 1.18, 1.25]) frame.add("frame", ring, [0, y, side * .92], [.312, .312, .8], [Math.PI / 2, 0, 0]);
      frame.cylinder("steel", [0, 1.315, side * .92], [.322, .045, .322], [0, 0, 0]);
    }
    for (const x of [-.72, .72]) frame.box("frame", [x, .95, 0], [.20, .20, 1.94], true);
    frame.box("frame", [0, 1.37, 0], [.55, .13, 2.12], true);
    frame.cylinder("steel", [0, 1.48, 0], [.235, .095, .235], [0, 0, 0]);
    for (const x of [-.65, .65]) {
      motors.cylinder("motorsAccent", [x, .76, 0], [.237, .82, .237]);
      for (let k = 0; k < 12; k++) motors.cylinder("frame", [x, .76, -.36 + k * .066], [.254, .02, .254]);
      motors.cylinder("steel", [x, .76, .443], [.207, .065, .207]);
      motors.box("motorsAccent", [x, 1.0, .08], [.27, .11, .24], true);
      motors.box("frame", [x + .27, .65, -.43], [.36, .34, .36], true);
      motors.cylinder("copper", [x + .30, .65, -.625], [.115, .045, .115]);
    }
    return { body: [], doorsLeft: [], doorsRight: [], bogies: frame.finish(), motors: motors.finish(), brakes: brakes.finish() };
  }
  const cab = buildCar(true), middle = buildCar(false), bogie = buildBogie();
  const trackBuilder = new Builder();
  for (let i = 0; i < 45; i++) trackBuilder.box("sleeper", [-13.2 + i * .60, .015, 0], [.23, .12, 2.65], true);
  for (const z of [-.758, .758]) {
    trackBuilder.box("rail", [0, .08, z], [27, .045, .15]);
    trackBuilder.box("frame", [0, .12, z], [27, .09, .043]);
    trackBuilder.box("steel", [0, .168, z], [27, .035, .073]);
  }
  const track = trackBuilder.finish();
  Object.values(base).forEach(g => g.dispose());
  return { cab, middle, bogie, track, materials, display,
    dispose() {
      [cab, middle, bogie].forEach(asset => Object.values(asset).flat().forEach(p => p.geometry.dispose()));
      track.forEach(p => p.geometry.dispose());
      Object.values(materials).forEach(m => m.dispose());
      display.dispose();
    },
  };
}

type Resources = ReturnType<typeof createTrainResources>;

/** Reuse presentation geometry without a destination, service identity or livery claim. */
export function createRecordingTrainResources(includeCoolingModules = true) {
  const resources = createTrainResources(true, includeCoolingModules);
  for (const part of PARTS) resources.materials[`${part}Accent`] = new THREE.MeshStandardMaterial({ color: "#789497", metalness: .65, roughness: .38 });
  return resources;
}
type Props = {
  states: Record<Part, { status: Status; risk: number | null }>;
  selected: string; hovered: Part | null; onSelect: (part: Part) => void; onHover: (part: Part | null) => void;
  view: TrainView; rotating: boolean; compact: boolean; reset: number; carIndex: number;
};

function Batch({ pieces, materials }: { pieces: Piece[]; materials: Record<string, THREE.Material> }) {
  return <>{pieces.map(piece => <mesh key={piece.material} geometry={piece.geometry} material={materials[piece.material]} castShadow receiveShadow dispose={null} />)}</>;
}

function CameraRig({ view, compact, reset, rotating, carIndex }: Pick<Props, "view" | "compact" | "reset" | "rotating" | "carIndex">) {
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const { camera, invalidate, size } = useThree();
  const framing = useMemo(() => {
    const bogie = view === "bogie", trainset = view === "trainset", exploded = view === "exploded";
    const target = new THREE.Vector3(0, bogie ? .81 : exploded ? 3.10 : 1.72, 0);
    const direction = new THREE.Vector3(...(bogie ? [1.28, .78, 1.55] : trainset ? [2.1, .44, 1] : [carIndex === 5 ? -1.17 : 1.17, .64, 1.60]) as Point).normalize();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right).normalize();
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera instanceof THREE.PerspectiveCamera ? camera.fov : 32) / 2);
    const tanH = tanV * Math.max(.1, size.width / Math.max(1, size.height));
    const halfLength = bogie ? 1.85 : trainset ? 71.0 : 12.15;
    const halfWidth = bogie ? 1.42 : exploded ? 2.60 : 1.70;
    const height = bogie ? 1.62 : exploded ? 7 : 4.15;
    let distance = bogie ? 5.6 : trainset ? 75 : compact ? 23 : 25;
    // Project all eight corners, so portrait layouts retain the whole model.
    for (const x of [-halfLength, halfLength]) for (const y of [0, height]) for (const z of [-halfWidth, halfWidth]) {
      const corner = new THREE.Vector3(x, y, z).sub(target);
      distance = Math.max(distance, Math.abs(corner.dot(right)) * 1.1 / tanH + corner.dot(direction), Math.abs(corner.dot(up)) * (compact ? 1.35 : 1.43) / tanV + corner.dot(direction));
    }
    return { target, distance, position: target.clone().addScaledVector(direction, distance) };
  }, [camera, compact, carIndex, size.width, size.height, view]);
  useEffect(() => {
    camera.position.copy(framing.position);
    camera.lookAt(framing.target);
    controls.current?.target.copy(framing.target);
    controls.current?.update();
    invalidate();
  }, [camera, framing, reset, carIndex, invalidate]);
  return <OrbitControls ref={controls} makeDefault enablePan={false} enableZoom={!compact} enableDamping dampingFactor={.085} autoRotate={rotating} autoRotateSpeed={.24}
    minDistance={view === "bogie" ? 3.6 : view === "trainset" ? 28 : 12} maxDistance={framing.distance * 1.8} minPolarAngle={.22} maxPolarAngle={Math.PI / 2.035} />;
}

export default function R151Scene(props: Props) {
  const { states, selected, hovered, onSelect, onHover, view, carIndex } = props;
  const r = useMemo(() => createTrainResources(), []);
  useEffect(() => () => r.dispose(), [r]);
  const accents = useMemo(() => Object.fromEntries(PARTS.map(part => {
    const status = states[part].status;
    const active = selected === part || hovered === part;
    const color = new THREE.Color(part === "doors" ? "#a6b6be" : "#566974");
    if (status !== "unknown") color.lerp(new THREE.Color(COLORS[status]), status === "healthy" ? .23 : .55);
    // Selection increases luminance without replacing the evidence's status hue.
    if (active) color.lerp(new THREE.Color("#e7f0f3"), .13);
    return [`${part}Accent`, new THREE.MeshStandardMaterial({ color, metalness: .65, roughness: .32, emissive: status === "unknown" ? active ? "#718c9b" : "#000000" : COLORS[status], emissiveIntensity: active ? .42 : status === "critical" ? .17 : .035 })];
  })), [states, selected, hovered]);
  useEffect(() => () => Object.values(accents).forEach(m => m.dispose()), [accents]);
  const materials = { ...r.materials, ...accents };
  const events = (part: Part) => ({
    onClick: (e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onSelect(part); },
    onPointerOver: (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); onHover(part); },
    onPointerOut: (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); onHover(null); },
  });
  const bogie = (x: number, exploded = false) => <group key={x} position={[x, 0, 0]}>
    <group {...events("bogies")}><Batch pieces={r.bogie.bogies} materials={materials} /></group>
    <group {...events("motors")} position={[0, exploded ? .9 : 0, 0]}><Batch pieces={r.bogie.motors} materials={materials} /></group>
    <group {...events("brakes")} position={[0, exploded ? .15 : 0, exploded ? .62 : 0]}><Batch pieces={r.bogie.brakes} materials={materials} /></group>
  </group>;
  const car = (index: number, x = 0, exploded = false) => {
    const driving = index === 0 || index === 5;
    const asset = driving ? r.cab : r.middle;
    return <group key={index} position={[x, 0, 0]} rotation={[0, index === 5 ? Math.PI : 0, 0]}>
      <group position={[0, exploded ? 2.8 : 0, 0]}>
        <Batch pieces={asset.body} materials={materials} />
        <group {...events("doors")} position={[0, 0, exploded ? -1 : 0]}><Batch pieces={asset.doorsLeft} materials={materials} /></group>
        <group {...events("doors")} position={[0, 0, exploded ? 1 : 0]}><Batch pieces={asset.doorsRight} materials={materials} /></group>
        {driving && <mesh position={[10.957, 3.30, 0]} rotation={[0, Math.PI / 2, .325]} material={r.materials.display} dispose={null}><planeGeometry args={[1.05, .19]} /></mesh>}
      </group>
      {BOGIE_CENTERS.map(x => bogie(x, exploded))}
    </group>;
  };
  const wholeTrain = view === "trainset";
  return <>
    <ambientLight intensity={.7} />
    <hemisphereLight args={["#e3f0ff", "#2a3944", 1.65]} />
    <Environment resolution={128} frames={1} environmentIntensity={.45}>
      <color attach="background" args={["#253541"]} />
      <Lightformer form="rect" position={[0, 7, 0]} rotation={[Math.PI / 2, 0, 0]} scale={[18, 5]} intensity={2.5} color="#f0f4f7" />
      <Lightformer form="rect" position={[0, 2, 7]} rotation={[0, Math.PI, 0]} scale={[18, 1.7]} intensity={1.8} color="#bed3e3" />
      <Lightformer form="rect" position={[-8, 4, -5]} target={[0, 0, 0]} scale={[8, 2.5]} intensity={1.2} color="#d8e5f0" />
    </Environment>
    <directionalLight position={[8, 18, 12]} intensity={3.1} color="#fff3e3" castShadow={!wholeTrain} shadow-mapSize-width={2048} shadow-mapSize-height={1024} shadow-camera-left={-18} shadow-camera-right={18} shadow-camera-top={12} shadow-camera-bottom={-12} shadow-bias={-.0001} shadow-normalBias={.028} />
    <directionalLight position={[-12, 10, -8]} intensity={2.7} color="#a9c7ed" />
    <directionalLight position={[0, 4, -12]} intensity={1.35} color="#65bcae" />
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -.064, 0]} receiveShadow>
      <planeGeometry args={[250, 250]} /><shadowMaterial transparent opacity={.29} />
    </mesh>
    <gridHelper args={[wholeTrain ? 200 : 60, wholeTrain ? 100 : 60, "#263b47", "#192c38"]} position={[0, -.068, 0]} />
    {view === "bogie" ? <>
      <group scale={[.19, 1, 1]}><Batch pieces={r.track} materials={materials} /></group>{bogie(0)}
    </> : wholeTrain ? <>
      <group scale={[5.4, 1, 1]}><Batch pieces={r.track.filter(p => p.material !== "sleeper")} materials={materials} /></group>
      {[0, 1, 2, 3, 4, 5].map(index => car(index, (2.5 - index) * CAR_PITCH))}
    </> : <><Batch pieces={r.track} materials={materials} />{car(carIndex, 0, view === "exploded")}</>}
    <CameraRig {...props} />
  </>;
}
