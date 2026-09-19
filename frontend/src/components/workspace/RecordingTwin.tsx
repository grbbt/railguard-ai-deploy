'use client';

import { Component, Suspense, useEffect, useMemo, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Environment, Html, Lightformer, Line, OrbitControls } from '@react-three/drei';
import { Box, ChevronDown, Focus, Layers3, Minus, Move, Plus, RotateCcw, ScanLine, ArrowRight, CircleAlert } from 'lucide-react';
import * as THREE from 'three';
import type { Evidence, PredictionReport, SubsystemId } from '@/lib/ps3-types';
import { createRecordingTrainResources } from '../train/R151Model';
import { makeRecordingMapping, recordingSelection, recordingAttention, recordingCarTarget, RECORDING_COLORS, type RecordingMapping, type RecordingTarget } from './recording-mapping';
import CoolingUnit from './CoolingUnit';
import TelemetryChart from '../ps3/TelemetryChart';
import { telemetrySignalIndex, telemetrySignalKey } from '../ps3/telemetry-chart';
import { RailTrackScene } from './RailTrackScene';
import { EngineeringAssembly } from './EngineeringAssemblies';
import './recording-twin.css';
import './recording-focus.css';
import './engineering-twin.css';

export type RecordingSelectionSummary = { fileId: string; id: string; label: string; status: string };
type Props = { report: PredictionReport | null; subsystem: SubsystemId; embedded?: boolean; onSelectionChange?: (value: RecordingSelectionSummary | null) => void };
type Point = [number, number, number];
type Resources = ReturnType<typeof createRecordingTrainResources>;
type SceneProps = { mapping: RecordingMapping; selected: RecordingTarget | null; onSelect: (id: string) => void; focused: boolean; findingView: boolean; carIndex: number; reset: number; zoom: number };

class SceneBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function valueText(value: Evidence['value']): string {
  if (value === null || typeof value === 'number' && !Number.isFinite(value)) return 'Unavailable';
  return typeof value === 'number' ? new Intl.NumberFormat('en', { maximumSignificantDigits: 5 }).format(value) : value;
}

function Batch({ pieces, resources }: { pieces: Resources['cab']['body']; resources: Resources }) {
  return <>{pieces.map(piece => <mesh key={piece.material} geometry={piece.geometry} material={resources.materials[piece.material]} dispose={null} castShadow receiveShadow />)}</>;
}

function TrainGeometry({ resources, index }: { resources: Resources; index: number }) {
  const asset = index === 0 || index === 7 ? resources.cab : resources.middle;
  return <group rotation={[0, index === 0 ? Math.PI : 0, 0]}>
    <Batch pieces={asset.body} resources={resources} />
    <Batch pieces={asset.doorsLeft} resources={resources} />
    <Batch pieces={asset.doorsRight} resources={resources} />
    {[-7.8, 7.8].map(x => <group key={x} position={[x, 0, 0]}>
      <Batch pieces={resources.bogie.bogies} resources={resources} />
      <Batch pieces={resources.bogie.motors} resources={resources} />
      <Batch pieces={resources.bogie.brakes} resources={resources} />
    </group>)}
  </group>;
}

function RailFindingScene({ mapping, selected, onSelect }: Pick<SceneProps, 'mapping' | 'selected' | 'onSelect'>) {
  const flaggedSide = mapping.primary.find(item => item.tone === 'flagged')?.side;
  return <>
    <RailTrackScene flaggedSide={flaggedSide === 1 || flaggedSide === 2 ? flaggedSide : null} selectedSide={selected?.side === 1 || selected?.side === 2 ? selected.side : undefined} onSelectSide={side => onSelect(`side-${side}`)}/>
    {mapping.primary.map(target => {
      const sign = target.side === 1 ? 1 : -1, x = sign * -2.5;
      const flagged = target.tone === 'flagged';
      return <group key={target.id}>
        <Line points={[[x,.48,sign*.758],[x,1.15,sign*1.5]]} color={flagged ? '#ffc064' : '#c1d1d9'} lineWidth={1}/>
        <mesh position={[x,.48,sign*.758]}><sphereGeometry args={[.05,10,8]}/><meshBasicMaterial color={flagged ? '#ffc064' : '#c1d1d9'}/></mesh>
        <Html center position={[x,1.36,sign*1.65]} style={{pointerEvents:'none'}}><span className={`rt-scene-callout ${flagged ? 'needs-review' : ''}`}><b>{target.label}</b><small>{flagged ? 'Corrugation predicted' : target.tone === 'unknown' ? 'No prediction' : 'No corrugation predicted'}</small></span></Html>
      </group>;
    })}
  </>;
}

function TrainScene({ mapping, selected, onSelect, focused, findingView, carIndex }: SceneProps) {
  const resources = useMemo(() => createRecordingTrainResources(mapping.subsystem !== 'acv'), [mapping.subsystem]);
  useEffect(() => () => resources.dispose(), [resources]);
  const rail = mapping.subsystem === 'rail';
  const visible = focused ? mapping.cars.filter(car => car.index === carIndex) : mapping.cars;
  const length = focused ? 27 : 193;
  const choose = (event: ThreeEvent<MouseEvent>, id: string) => { event.stopPropagation(); onSelect(id); };
  return <>
    <group scale={[focused ? 1 : 7.12, 1, 1]}><Batch pieces={resources.track} resources={resources} /></group>
    {rail && ([1, 2] as const).map(side => {
      const target = mapping.targets.find(item => item.id === `side-${side}`)!;
      const color = target.tone === 'flagged' ? RECORDING_COLORS.flagged : selected?.side === side ? RECORDING_COLORS.context : '#536773';
      return <group key={side} position={[0, .24, side === 1 ? .758 : -.758]} onClick={event => choose(event, target.id)}>
        <mesh><boxGeometry args={[length, .045, .11]} /><meshStandardMaterial color={color} emissive={color} emissiveIntensity={target.tone === 'flagged' ? .55 : .1} metalness={.6} roughness={.32} /></mesh>
        <mesh><boxGeometry args={[length, .18, .5]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} /></mesh>
      </group>;
    })}
    {visible.map(car => {
      const x = focused ? 0 : (car.index - 3.5) * 23.42;
      const active = selected?.carIndex === car.index;
      const color = RECORDING_COLORS[car.tone];
      return <group key={car.id} position={[x, 0, 0]} onClick={event => choose(event, recordingCarTarget(mapping, selected, car.index))}>
        <TrainGeometry resources={resources} index={car.index} />
        {!rail && [-5.2, 4.5].map(rooftop => <group key={rooftop} position={[rooftop, findingView ? 5.15 : 4.11, 0]}>
          <CoolingUnit priority={car.tone === 'priority'} raised={findingView}/>
        </group>)}
        {!rail && findingView && <Html center position={[0, 7, 0]} style={{pointerEvents:'none'}}><span className={`rt-scene-callout ${car.tone === 'priority' ? 'needs-review' : ''}`}><b>{car.sourceId ? `Car ${car.sourceId} cooling system` : 'Cooling layout'}</b><small>{car.tone === 'priority' ? 'Inspection priority 1' : car.tone === 'unknown' ? 'Evidence unavailable' : 'Car-level cooling assessment'}</small></span></Html>}
        {active && <mesh position={[0, .34, 0]} rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[22.9, 4.1]} /><meshBasicMaterial color="#85d8c9" transparent opacity={.09} depthWrite={false} /></mesh>}
        <Html center position={[0, focused ? (findingView ? .1 : 5.2) : 12, focused && findingView ? 3 : 0]} distanceFactor={focused ? 40 : 135} style={{ pointerEvents: 'none' }}>
          <span className={`rt-car-label ${focused ? '' : 'rt-overview-label'} ${active ? 'is-active' : ''}`}><i style={{ background: rail ? '#80bdd8' : color }} />{focused ? car.sourceId ? `CAR ${car.sourceId}` : `POSITION ${car.index + 1}` : car.sourceId ?? '—'}</span>
        </Html>
        {rail && Array.from({ length: 8 }, (_, index) => {
          const position = index + 1, side = position % 2 ? 1 : 2;
          const axleX = [-9.01, -6.59, 6.59, 9.01][Math.floor(index / 2)];
          const id = `sensor-${car.index + 1}-${position}`;
          const chosen = selected?.id === id;
          return <group key={id} position={[axleX, .72, side === 1 ? 1.54 : -1.54]} onClick={event => choose(event, id)}>
            <mesh><sphereGeometry args={[chosen ? .32 : .24, 12, 10]} /><meshStandardMaterial color={chosen ? '#d9fcf1' : '#75a7b9'} emissive={chosen ? '#73d9be' : '#447184'} emissiveIntensity={chosen ? .75 : .2} metalness={.45} roughness={.35} /></mesh>
            {focused && <Html center position={[0, -.55, side === 1 ? .25 : -.25]} distanceFactor={35} style={{ pointerEvents: 'none' }}><span className={`rt-sensor-label ${chosen ? 'is-active' : ''}`}>{position}</span></Html>}
          </group>;
        })}
      </group>;
    })}
    {!focused && Array.from({ length: 7 }, (_, i) => <group key={i} position={[(i - 3) * 23.42, 1.95, 0]}>
      <mesh><boxGeometry args={[.72, 2.2, 2.25]} /><meshStandardMaterial color="#23333c" roughness={.9} /></mesh>
      {[-.25, -.125, 0, .125, .25].map(x => <mesh key={x} position={[x, 0, 0]}><boxGeometry args={[.035, 2.25, 2.3]} /><meshStandardMaterial color="#56666d" metalness={.4} roughness={.6} /></mesh>)}
    </group>)}
  </>;
}

function DoorScene({ selected, onSelect }: Pick<SceneProps, 'selected' | 'onSelect'>) {
  const color = selected ? RECORDING_COLORS[selected.tone] : RECORDING_COLORS.unknown;
  return <group position={[0, .02, 0]} onClick={event => { event.stopPropagation(); if (selected) onSelect(selected.id); }}>
    <EngineeringAssembly kind="door" />
    {/* The outline refers to the complete classified action, never a local defect. */}
    {selected?.tone === 'flagged' && <group>
      {[-2.43, 2.43].map(x => <mesh key={x} position={[x, 2.66, .42]}><boxGeometry args={[.035, 5.40, .035]}/><meshBasicMaterial color={color}/></mesh>)}
      {[0, 5.36].map(y => <mesh key={y} position={[0, y, .42]}><boxGeometry args={[4.86, .035, .035]}/><meshBasicMaterial color={color}/></mesh>)}
    </group>}
    <Html center position={[0, 5.85, 0]} style={{ pointerEvents: 'none' }}><span className={`rt-scene-callout ${selected?.tone === 'flagged' ? 'needs-review' : ''}`}><b>{selected?.label ?? 'Door assembly'}</b><small>{selected?.status ?? 'Illustrative mechanism'}</small></span></Html>
  </group>;
}

function StructureScene() {
  return <EngineeringAssembly kind="structure" />;
}

export function recordingCameraFrame(subsystem: SubsystemId, focused: boolean, width: number, height: number, fov: number, zoom: number, findingView = false) {
  const train = subsystem === 'acv' || subsystem === 'rail';
  const half: Point = findingView && subsystem === 'rail' ? [6.4, 1.15, 2.05] : train ? [focused ? 12.9 : 96.5, findingView ? 4.7 : 3.8, 2.2] : subsystem === 'door' ? [2.8, 3.2, 1] : [6.5, 1.85, 2.2];
  const target = new THREE.Vector3(0, findingView && subsystem === 'rail' ? .45 : subsystem === 'door' ? 2.65 : subsystem === 'shm' ? 1.65 : findingView ? 3.1 : 2.2, 0);
  const direction = new THREE.Vector3(...(train && !focused ? [.78, .66, 1.8] : subsystem === 'door' ? [.42, .21, 1.6] : findingView && subsystem === 'rail' ? [1.9, .9, 1.15] : subsystem === 'shm' ? [1.2, .9, 1.8] : findingView ? [.6, 1.2, 1.8] : [1.15, .7, 1.75])).normalize();
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), direction).normalize();
  const up = new THREE.Vector3().crossVectors(direction, right).normalize();
  const vertical = Math.tan(THREE.MathUtils.degToRad(fov / 2));
  const horizontal = vertical * Math.max(.05, width / Math.max(height, 1));
  // Fit every corner in camera space, reserving room for the source label and
  // controls. This handles tall/narrow canvases without relying on window size.
  let distance = 0;
  for (const x of [-half[0], half[0]]) for (const y of [-half[1], half[1]]) for (const z of [-half[2], half[2]]) {
    const corner = new THREE.Vector3(x, y, z);
    const depth = corner.dot(direction);
    distance = Math.max(distance, Math.abs(corner.dot(right)) / (.82 * horizontal) + depth, Math.abs(corner.dot(up)) / (.72 * vertical) + depth);
  }
  return { target, position: target.clone().addScaledVector(direction, distance * (findingView && subsystem === 'rail' ? .7 : 1) * Math.pow(.82, zoom)), half };
}

function Camera({ subsystem, focused, findingView, reset, zoom }: Pick<SceneProps, 'focused' | 'findingView' | 'reset' | 'zoom'> & { subsystem: SubsystemId }) {
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const lastFit = useRef('');
  const { camera, size, invalidate } = useThree();
  useEffect(() => { invalidate(); }, [focused, findingView, invalidate, reset, size.height, size.width, subsystem, zoom]);
  // OrbitControls updates at priority -1. Apply a requested fit immediately
  // afterwards, before rendering, so initialization cannot overwrite it.
  useFrame(({ camera: frameCamera, gl, size: frameSize }) => {
    if (!(frameCamera instanceof THREE.PerspectiveCamera) || !controls.current) return;
    const width = gl.domElement.clientWidth || frameSize.width;
    const height = gl.domElement.clientHeight || frameSize.height;
    if (width <= 0 || height <= 0) return;
    const key = `${frameCamera.uuid}:${subsystem}:${focused}:${findingView}:${reset}:${zoom}:${width}:${height}`;
    if (lastFit.current === key) return;
    lastFit.current = key;
    frameCamera.aspect = width / height;
    frameCamera.zoom = 1;
    frameCamera.updateProjectionMatrix();
    const frame = recordingCameraFrame(subsystem, focused, width, height, frameCamera.fov, zoom, findingView);
    frameCamera.position.copy(frame.position);
    frameCamera.lookAt(frame.target);
    controls.current.target.copy(frame.target);
    controls.current.update();
    controls.current.saveState();
    frameCamera.updateMatrixWorld();
    invalidate();
  });
  return <OrbitControls ref={controls} camera={camera} makeDefault enableDamping dampingFactor={.1} minDistance={subsystem === 'door' ? 4 : 8} maxDistance={1400} minPolarAngle={.1} maxPolarAngle={Math.PI / 2 - .02} />;
}

function Scene(props: SceneProps) {
  const train = props.mapping.subsystem === 'acv' || props.mapping.subsystem === 'rail';
  const wide = train && !props.focused;
  return <>
    <ambientLight intensity={.22} />
    <hemisphereLight args={['#dbe9ff', '#172041', .8]} />
    <directionalLight position={[6, 12, 8]} intensity={2.65} color="#f1f5ff" castShadow={!wide}
      shadow-mapSize={[2048, 2048]} shadow-camera-left={-18} shadow-camera-right={18} shadow-camera-top={14} shadow-camera-bottom={-14}
      shadow-camera-near={.1} shadow-camera-far={60} shadow-bias={-.0003} shadow-normalBias={.018} shadow-radius={4} />
    <directionalLight position={[-9, 5, -8]} intensity={1.1} color="#94a6ff" />
    <directionalLight position={[-12, 4, 6]} intensity={.55} color="#a4e8f0" />
    <Environment resolution={128} frames={1} environmentIntensity={.85}>
      <Lightformer form="rect" position={[0, 10, 2]} rotation={[Math.PI / 2, 0, 0]} scale={[26, 8]} intensity={3} color="#f1f5ff" />
      <Lightformer form="rect" position={[0, 4, 9]} rotation={[0, Math.PI, 0]} scale={[23, 2]} intensity={2} color="#d5e4fa" />
      <Lightformer form="rect" position={[-9, 5, -5]} rotation={[0, .6, 0]} scale={[3, 12]} intensity={2.2} color="#b6b5ff" />
      <Lightformer form="rect" position={[8, 3, -5]} rotation={[0, -.7, 0]} scale={[2, 8]} intensity={1.7} color="#b0ebf1" />
    </Environment>
    {/* The stage is a continuous CSS gradient; only grounded shadows render here. */}
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -.14, 0]} receiveShadow><planeGeometry args={[wide ? 1800 : 500, wide ? 1800 : 500]}/><shadowMaterial transparent opacity={.37} color="#060b21" depthWrite={false}/></mesh>
    {wide && <gridHelper args={[260, 100, '#4b5982', '#293655']} position={[0, -.12, 0]} />}
    {props.mapping.subsystem === 'rail' && props.findingView ? <RailFindingScene {...props}/> : train ? <TrainScene {...props} /> : props.mapping.subsystem === 'door' ? <DoorScene selected={props.selected} onSelect={props.onSelect} /> : <StructureScene />}
    <Camera subsystem={props.mapping.subsystem} focused={props.focused} findingView={props.findingView} reset={props.reset} zoom={props.zoom} />
  </>;
}

function Fallback({ mapping, selected, onSelect }: Pick<SceneProps, 'mapping' | 'selected' | 'onSelect'>) {
  return <div className="rt-fallback">
    <Box size={32} /><strong>Recording schematic</strong><p>3D is unavailable on this device. The same selections and measured evidence remain available.</p>
    {mapping.cars.length > 0 ? <div className="rt-fallback-cars">{mapping.cars.map(car => <button type="button" key={car.id} aria-pressed={selected?.carIndex === car.index} onClick={() => onSelect(recordingCarTarget(mapping, selected, car.index))}><svg viewBox="0 0 100 70" aria-hidden="true"><rect x="8" y="13" width="84" height="40" rx="9" fill="#526e7c" stroke={RECORDING_COLORS[car.tone]} strokeWidth="2" />{[18, 39, 60].map(x => <rect key={x} x={x} y="21" width="14" height="15" rx="2" fill="#102935" />)}<circle cx="26" cy="55" r="7" fill="#9baeb6"/><circle cx="73" cy="55" r="7" fill="#9baeb6"/></svg><span>{car.label}</span></button>)}</div> : <div className="rt-fallback-mechanism" aria-hidden="true"><svg viewBox="0 0 320 190">{mapping.subsystem === 'door' ? <g fill="#46626f" stroke="#a5b8bf" strokeWidth="2"><rect x="65" y="15" width="190" height="160" rx="5"/><path d="M160 16v158"/><rect x="83" y="35" width="58" height="70" fill="#142f3c"/><rect x="179" y="35" width="58" height="70" fill="#142f3c"/></g> : <g fill="none" stroke="#819ca8" strokeWidth="4"><path d="M22 45h276v100H22ZM22 145l69-100 69 100 69-100 69 100M22 160h276M91 45v100M160 45v100M229 45v100"/></g>}</svg></div>}
  </div>;
}

export default function RecordingTwin({ report, subsystem, embedded = false, onSelectionChange }: Props) {
  const mapping = useMemo(() => makeRecordingMapping(report, subsystem), [report, subsystem]);
  const viewCamera = useMemo(() => {
    const camera = new THREE.PerspectiveCamera(35, 1, .1, 2400);
    camera.position.set(28, 15, 40);
    return camera;
  }, []);
  const [requested, setRequested] = useState('');
  const [requestedCar, setRequestedCar] = useState(0);
  const [preferredSignal, setPreferredSignal] = useState('');
  const [focused, setFocused] = useState(true);
  const [findingView, setFindingView] = useState(true);
  const [reset, setReset] = useState(0), [zoom, setZoom] = useState(0);
  const [contextLost, setContextLost] = useState(false);
  const cleanup = useRef<() => void>(() => {});
  const selected = recordingSelection(mapping, requested);
  const assignedEvidence = new Set(mapping.targets.flatMap(target => target.evidence.map(item => item.id)));
  const recordingEvidence = mapping.hasReport ? (report?.evidence ?? []).filter(item => !assignedEvidence.has(item.id)) : [];
  const signalTraces = selected?.traces ?? [];
  const signalIndex = telemetrySignalIndex(signalTraces, preferredSignal);
  const selectedTrace = signalTraces[signalIndex];
  useEffect(() => {
    onSelectionChange?.(selected && report ? { fileId: report.file_id, id: selected.id, label: selected.label, status: selected.status } : null);
  }, [onSelectionChange, selected, report]);
  const attention = recordingAttention(mapping);
  const carIndex = selected?.carIndex ?? requestedCar;
  const train = subsystem === 'acv' || subsystem === 'rail';
  const selectedColor = RECORDING_COLORS[selected?.tone ?? 'unknown'];
  useEffect(() => () => cleanup.current(), []);
  const select = (id: string) => { setRequested(id); const target = mapping.targets.find(item => item.id === id); if (target?.carIndex !== undefined) setRequestedCar(target.carIndex); };
  const focusFinding = (id = mapping.defaultId) => { select(id); setFocused(true); setFindingView(true); setZoom(0); setReset(value => value + 1); };
  const sceneProps = { mapping, selected, onSelect: select, focused, findingView, carIndex, reset, zoom };
  const fallback = <Fallback mapping={mapping} selected={selected} onSelect={select} />;
  const railSensors = subsystem === 'rail' ? mapping.targets.filter(target => target.carIndex === carIndex && target.position !== undefined) : [];
  const outputLabel = { door: 'Door action classification', acv: 'Car inspection ranking', rail: 'Rail-side classification', shm: 'Cumulative fatigue damage' }[subsystem];
  return <section className={`recording-twin ${embedded ? 'is-embedded' : ''}`} aria-label={`${mapping.title} recording visualization`}>
    <header className={`rt-heading ${embedded ? 'rt-embedded-heading' : ''}`}><div><div className="rt-eyebrow"><ScanLine size={13} /> COMPONENT ANALYSIS · {report?.file_id ?? 'SELECT RECORDING'}</div><h3>{embedded ? '3D finding & recorded evidence' : attention.headline}</h3><p>{mapping.scope}</p></div><button type="button" className="rt-focus-result" disabled={!mapping.hasReport} onClick={() => focusFinding()}><Focus size={16}/>Focus result</button></header>
    <div className="rt-view-toolbar"><div role="group" aria-label="3D view mode">{train ? <><button type="button" aria-pressed={findingView} onClick={() => { if (subsystem === 'rail') select(selected?.side ? `side-${selected.side}` : mapping.defaultId); setFocused(true); setFindingView(true); setZoom(0); }}><Focus size={15}/>{subsystem === 'rail' ? 'Rail-side view' : 'Cooling view'}</button><button type="button" aria-pressed={focused && !findingView} onClick={() => { setFocused(true); setFindingView(false); setZoom(0); }}><Box size={15}/>Car layout</button><button type="button" aria-pressed={!focused} onClick={() => { setFocused(false); setFindingView(false); setZoom(0); }}><Layers3 size={15}/>8 cars</button></> : <span>{mapping.title}</span>}</div><div className="rt-view-tools"><button type="button" aria-label="Zoom in" disabled={zoom >= 3} onClick={() => setZoom(value => Math.min(3, value + 1))}><Plus size={16}/></button><button type="button" aria-label="Zoom out" disabled={zoom <= -2} onClick={() => setZoom(value => Math.max(-2, value - 1))}><Minus size={16}/></button><button type="button" aria-label="Reset camera and retry 3D" onClick={() => { setReset(value => value + 1); setZoom(0); setContextLost(false); }}><RotateCcw size={15}/>Reset</button></div></div>
    <div className="rt-layout">
      <div className="rt-visual">
        <div className="rt-source-strip"><span className="rt-source-dot" />{outputLabel}<span>{findingView && subsystem === 'rail' ? 'RAIL-SIDE RESULT' : train ? focused ? `CAR ${mapping.cars[carIndex]?.sourceId ?? 'LAYOUT'}` : 'EIGHT-CAR LAYOUT' : 'RECORDING VIEW'}</span></div>
        {subsystem === 'shm' && <div className="rt-structure-annotation"><strong>Stress recording</strong><span>{selected?.status ?? 'Select a recording'}</span></div>}
        <div className="rt-canvas">
          {contextLost ? fallback : <SceneBoundary key={`${subsystem}-${reset}`} fallback={fallback}>
            <Canvas camera={viewCamera} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} resize={{ scroll: false, debounce: 0, offsetSize: true }} shadows="percentage" dpr={[1, 1.5]} frameloop="demand" gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }} fallback={fallback}
              onCreated={({ gl }) => { cleanup.current(); const element = gl.domElement; const lost = (event: Event) => { event.preventDefault(); setContextLost(true); }; element.addEventListener('webglcontextlost', lost); cleanup.current = () => element.removeEventListener('webglcontextlost', lost); gl.setClearColor('#10171c', 0); gl.toneMapping = THREE.ACESFilmicToneMapping; gl.toneMappingExposure = 1.05; }}>
              <Suspense fallback={null}><Scene {...sceneProps} /></Suspense>
            </Canvas>
          </SceneBoundary>}
        </div>
        <div className="rt-scene-caption"><span><Move size={12} /> Drag to orbit · scroll to zoom</span><span>{attention.flagged ? 'Amber · model finding' : 'Source-linked engineering view'}</span></div>
        {train && !(subsystem === 'rail' && findingView) && <div className="rt-car-navigation" role="group" aria-label="Choose source car or layout position">{mapping.cars.map(car => <button type="button" key={car.id} aria-pressed={carIndex === car.index} onClick={() => { setRequestedCar(car.index); select(recordingCarTarget(mapping, selected, car.index)); }} title={`${car.label}${car.sourceId ? '' : '; source identity unavailable'}`}><i style={{ background: RECORDING_COLORS[car.tone] }} /><span>{car.sourceId ?? `—${car.index + 1}`}</span>{car.tone === 'priority' && <small>1st</small>}</button>)}</div>}
        <div className="rt-selection-controls">
          {subsystem === 'rail' ? <><div className="rt-sides" role="group" aria-label="Select rail side">{mapping.primary.map(target => <button type="button" key={target.id} aria-pressed={selected?.id === target.id} onClick={() => select(target.id)}><i style={{ background: RECORDING_COLORS[target.tone] }} />{target.label}<small>{target.side === 1 ? 'Odd positions' : 'Even positions'}</small></button>)}</div>{!findingView && <div className="rt-sensor-navigation" role="group" aria-label={`Select axle-box position in car ${carIndex + 1}`}><span>Position</span>{railSensors.map(target => <button type="button" key={target.id} aria-label={`${target.label}, Side ${target.side === 1 ? 'I' : 'II'}. Layout only.`} aria-pressed={selected?.id === target.id} onClick={() => select(target.id)}>{target.position}</button>)}</div>}</> : subsystem === 'door' && mapping.primary.length > 0 ? <label className="rt-action-select"><span>Detected action</span><select value={selected?.id ?? ''} onChange={event => select(event.target.value)}>{mapping.primary.map(target => <option key={target.id} value={target.id}>{target.label} · {target.status}</option>)}</select><ChevronDown size={14} /></label> : <div className="rt-legend">{subsystem === 'acv' ? <><span><i style={{ background: RECORDING_COLORS.priority }} />First inspection rank</span><span><i style={{ background: RECORDING_COLORS.ranked }} />Ranked</span><span><i style={{ background: RECORDING_COLORS.unknown }} />Unavailable</span></> : <span>Complete recording · stress response</span>}</div>}
        </div>
      </div>
      <aside className="rt-inspector" aria-label="Selected recording evidence">
        <div className="rt-inspector-header"><div className="rt-eyebrow">SELECTED RESULT</div><h4>{selected?.label ?? 'No action selected'}</h4><span className="rt-status" style={{ color: selectedColor }}><i style={{ background: selectedColor }} />{selected?.status ?? 'Upload a recording to begin'}</span></div>
        {!!selected?.evidence.length && <dl className="rt-measurements rt-key-measurements">{selected.evidence.slice(0,2).map(item => <div key={item.id}><dt title={item.label}>{item.label.replace(/^(?:Side (?:II|I) median |Car [^:]+: |Action \d+ )/, '')}</dt><dd>{valueText(item.value)}{item.unit && item.value !== null && <small>{item.unit}</small>}</dd></div>)}</dl>}
        {!!attention.targets.length && <section className="rt-findings" aria-label="Model findings to review"><div><CircleAlert size={16}/><strong>Review first</strong><span>{attention.targets.length}</span></div><div className="rt-finding-list">{attention.targets.map(target => <button type="button" key={target.id} aria-pressed={selected?.id === target.id} onClick={() => focusFinding(target.id)}><span><strong>{target.label}</strong><small>{target.status}</small></span><ArrowRight size={15}/></button>)}</div></section>}
        <div className="rt-evidence-inventory"><span><strong>{selected?.evidence.length ?? 0}</strong> measurements</span><span><strong>{signalTraces.length}</strong> selectable signals</span><small>Full evidence follows below</small></div>
      </aside>
    </div>
    <section className="rt-data-section" aria-label="All selected measurements and sources">
      <div className="rt-section-heading"><div><span className="rt-eyebrow">MEASURED EVIDENCE</span><h4>{selected?.label ?? mapping.title} · measurements</h4></div><span>{selected?.evidence.length ?? 0} returned</span></div>
      {selected && <p className="rt-detail">{selected.detail}</p>}
      {selected?.evidence.length ? <dl className="rt-measurements rt-all-measurements">{selected.evidence.map(item => <div key={item.id}><dt>{item.label}</dt><dd>{valueText(item.value)}{item.unit && item.value !== null && <small>{item.unit}</small>}</dd>{item.detail && <p>{item.detail}</p>}{item.source && <span className="rt-evidence-source"><strong>Source</strong> {item.source}</span>}</div>)}</dl> : <div className="rt-no-evidence">{mapping.hasReport ? subsystem === 'door' ? 'No per-action measurements were returned for this action. Any available traces describe the complete recording.' : 'No measured evidence is available for this selection.' : 'Upload and process a source recording to populate this view.'}</div>}
      {!!recordingEvidence.length && <section className="rt-recording-context" aria-label="Recording-level measurements"><div className="rt-section-heading"><div><span className="rt-eyebrow">COMPLETE SOURCE FILE</span><h4>Recording context</h4></div><span>{recordingEvidence.length} returned</span></div><dl className="rt-measurements rt-all-measurements">{recordingEvidence.map(item => <div key={item.id}><dt>{item.label}</dt><dd>{valueText(item.value)}{item.unit && item.value !== null && <small>{item.unit}</small>}</dd>{item.detail && <p>{item.detail}</p>}{item.source && <span className="rt-evidence-source"><strong>Source</strong> {item.source}</span>}</div>)}</dl></section>}
    </section>
    <section className="rt-data-section rt-signal-section" aria-label="Recorded signal analysis">
      <div className="rt-section-heading rt-signal-heading"><div><span className="rt-eyebrow">SIGNAL ANALYSIS</span><h4>Recorded signal</h4></div>{selectedTrace && <label className="rt-signal-picker"><span>Signal<small>{signalIndex + 1} / {signalTraces.length}</small></span><select aria-label="Signal" value={signalIndex} onChange={event => setPreferredSignal(telemetrySignalKey(signalTraces[Number(event.target.value)].name))}>{signalTraces.map((trace, index) => <option key={`${trace.name}-${index}`} value={index}>{trace.name}</option>)}</select></label>}</div>
      <p className="rt-detail">{subsystem === 'door' ? 'Complete-recording signals accompany the selected action and its start/end times above.' : subsystem === 'rail' ? 'Side-level channel examples retain their source car and sensor position in each chart title.' : 'Choose a signal, then use the slider to inspect its measured points.'}</p>
      {selectedTrace ? <div className="rt-selected-trace"><TelemetryChart series={selectedTrace} subsystem={subsystem}/></div> : <p className="rt-no-trace">No source trace is available for this selection.</p>}
    </section>
    <footer className="rt-provenance"><ScanLine size={16} /><div><strong>Method & interpretation</strong><p>{mapping.note}</p><p className="rt-model-source"><span>Source file: <b>{report?.file_id ?? 'Not selected'}</b></span><span>Model: <b>{report?.model_name ?? 'Awaiting result'}</b></span></p></div></footer>
  </section>;
}
