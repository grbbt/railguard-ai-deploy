"use client";

import { Component, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Canvas } from "@react-three/fiber";
import R151Scene, { type TrainView } from "./train/R151Model";
import { Boxes, RotateCcw, RotateCw, Pause, ScanLine, TrainFront, UnfoldVertical, GalleryHorizontalEnd } from "lucide-react";
import * as THREE from "three";

type Status = "healthy" | "warning" | "critical" | "unknown";
type Part = "bogies" | "doors" | "brakes" | "motors";
type View = TrainView;
export type DigitalTwinComponent = { component: string; status: Status; risk: number | null };
type Props = { components: DigitalTwinComponent[]; selected: string; onSelect: (component: string) => void; compact?: boolean };

const PARTS: { key: Part; label: string; detail: string }[] = [
  { key: "bogies", label: "Bogies", detail: "Wheelsets & suspension" },
  { key: "doors", label: "Doors", detail: "Passenger access" },
  { key: "brakes", label: "Brakes", detail: "Discs & calipers" },
  { key: "motors", label: "Motors", detail: "Traction assembly" },
];
const COLORS: Record<Status, string> = { healthy: "#55d6b0", warning: "#efba62", critical: "#f57d78", unknown: "#708797" };
const STATUS_LABEL: Record<Status, string> = { healthy: "Healthy", warning: "Warning", critical: "Critical", unknown: "No data" };
const GREEN = "#55d6b0";

class TwinBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function FallbackDiagram({ states, selected, onSelect }: { states: Record<Part, DigitalTwinComponent>; selected: string; onSelect: (part: Part) => void }) {
  const interactive = (key: Part) => ({ role: "button", tabIndex: 0, "aria-label": `${key}: ${STATUS_LABEL[states[key].status]}. Select component.`, onClick: () => onSelect(key), onKeyDown: (e: React.KeyboardEvent<SVGGElement>) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(key); } }, style: { cursor: "pointer", outlineOffset: 4 }, stroke: selected === key ? GREEN : COLORS[states[key].status] });
  return <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "44px 24px 100px" }}>
    <svg viewBox="0 0 620 250" style={{ width: "100%", maxWidth: 680, maxHeight: 260 }} aria-label="Conceptual railway component diagram">
      <defs><linearGradient id="twin-shell" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#76909e" /><stop offset="1" stopColor="#2b4353" /></linearGradient></defs>
      <path d="M72 165V84Q72 57 104 57H510Q547 57 553 92V165Z" fill="url(#twin-shell)" stroke="#8dabb7" />
      {[107, 244, 371, 450].map(x => <rect key={x} x={x} y={77} width={57} height={43} rx={5} fill="#102733" />)}
      <path d="M76 145H550" stroke="#4e9b9a" strokeWidth="5" />
      <g {...interactive("doors")} fill="#385563" strokeWidth="2">
        {[179, 310].map(x => <g key={x}><rect x={x} y={72} width={43} height={88} rx={3} /><path d={`M${x + 21} 74v83`} /><rect x={x + 8} y={85} width={26} height={34} fill="#152e3b" strokeWidth="1" /></g>)}
      </g>
      <g {...interactive("bogies")} fill="#243d4b" strokeWidth="3">
        {[160, 445].map(x => <g key={x}><rect x={x - 63} y={169} width={126} height={23} rx={5} /><circle cx={x - 35} cy={192} r={24} /><circle cx={x + 35} cy={192} r={24} /></g>)}
      </g>
      <g {...interactive("brakes")} fill="#a4b5bd" strokeWidth="3">{[125, 195, 410, 480].map(x => <circle key={x} cx={x} cy={192} r={12} />)}</g>
      <g {...interactive("motors")} fill="#365e61" strokeWidth="3">{[160, 445].map(x => <rect key={x} x={x - 16} y={172} width={32} height={31} rx={6} />)}</g>
      <path d="M43 221H578M43 228H578" stroke="#395666" strokeWidth="2" />
    </svg>
    <div style={{ fontSize: 12, color: "#b4c7d1", textAlign: "center", marginTop: 6 }}>Interactive component diagram. Select a part here or use the component controls.</div>
  </div>;
}

const pill: CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 32, padding: "6px 9px", borderRadius: 8, border: "1px solid transparent", color: "#a0b3bf", background: "transparent", font: "inherit", fontSize: 11, fontWeight: 500, cursor: "pointer", whiteSpace: "nowrap" };
const glass: CSSProperties = { background: "rgba(10,23,33,.89)", border: "1px solid rgba(113,151,169,.18)", backdropFilter: "blur(14px)", boxShadow: "0 8px 28px rgba(0,0,0,.17)" };

export default function DigitalTwin({ components, selected, onSelect, compact = false }: Props) {
  const [requestedView, setView] = useState<View>("assembled");
  const view = requestedView === "bogie" && selected === "doors" ? "assembled" : requestedView;
  const [rotating, setRotating] = useState(false);
  const [carIndex, setCarIndex] = useState(0);
  const [hovered, setHovered] = useState<Part | null>(null);
  const [reset, setReset] = useState(0);
  const [contextLost, setContextLost] = useState(false);
  const canvasCleanup = useRef<() => void>(() => {});
  const states = useMemo(() => Object.fromEntries(PARTS.map(p => [p.key, components.find(c => c.component === p.key) ?? { component: p.key, status: "unknown" as Status, risk: null }])) as Record<Part, DigitalTwinComponent>, [components]);
  const currentPart = PARTS.find(p => p.key === (hovered ?? selected));
  const current = currentPart ? states[currentPart.key] : undefined;
  const selectPart = (key: Part) => { onSelect(key); if (key === "doors" && view === "bogie") setView("assembled"); };
  useEffect(() => () => canvasCleanup.current(), []);
  const fallback = <FallbackDiagram states={states} selected={selected} onSelect={selectPart} />;
  const riskLabel = current?.risk != null && Number.isFinite(current.risk) ? `${Math.round(current.risk)} / 100 risk indicator` : "Risk indicator unavailable";

  return <div className="railguard-twin" style={{ position: "relative", height: "100%", width: "100%", minHeight: compact ? 240 : 410, overflow: "hidden", isolation: "isolate", containerType: "inline-size", color: "#d4e1e8", background: "radial-gradient(ellipse at 50% 43%, #18313b 0%, #0d1c27 47%, #0a151f 85%)", borderRadius: 16 }}>
    <style>{`.railguard-twin button:focus-visible,.railguard-twin [role="button"]:focus-visible{outline:2px solid #75eac6;outline-offset:3px}.railguard-twin button:hover{filter:brightness(1.2)}.railguard-twin canvas{touch-action:none}.railguard-twin button:disabled{cursor:default;opacity:.45}.railguard-twin .twin-bottom{position:absolute;bottom:12px;left:12px;right:12px;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}.railguard-twin .twin-part-label{display:inline}@container(max-width:480px){.railguard-twin .twin-header-helper{display:none}.railguard-twin .twin-car-picker{top:45px!important;left:18px!important;right:auto!important}.railguard-twin .twin-evidence-hud{top:88px!important}.railguard-twin .twin-car-picker-label{display:none}.railguard-twin .twin-scene-kind{font-size:9px!important}}@media(max-width:650px){.railguard-twin .twin-bottom{bottom:9px;left:8px;right:8px;justify-content:center}.railguard-twin .twin-view-label{display:none}.railguard-twin .twin-part-button{padding:6px!important;font-size:10px!important}.railguard-twin .twin-scene-label{font-size:8px!important}}`}</style>

    {contextLost ? fallback : <TwinBoundary key={reset} fallback={fallback}>
      <Canvas shadows={{ type: THREE.PCFShadowMap }} dpr={[1, 1.5]} frameloop={rotating ? "always" : "demand"} camera={{ position: [24, 12, 30], fov: 32, near: .1, far: 1200 }}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }} fallback={fallback}
        onCreated={({ gl }) => {
          canvasCleanup.current();
          const element = gl.domElement;
          const onLost = (event: Event) => { event.preventDefault(); setContextLost(true); };
          element.addEventListener("webglcontextlost", onLost);
          canvasCleanup.current = () => element.removeEventListener("webglcontextlost", onLost);
          gl.setClearColor("#071017", 0);
        }}
        style={{ cursor: hovered ? "pointer" : "grab" }}>
        <Suspense fallback={null}>
          <R151Scene carIndex={carIndex} states={states} selected={selected} hovered={hovered} onSelect={selectPart} onHover={setHovered} view={view} rotating={rotating} compact={compact} reset={reset} />
        </Suspense>
      </Canvas>
    </TwinBoundary>}

    <div style={{ position: "absolute", inset: "0 0 auto", height: 92, pointerEvents: "none", background: "linear-gradient(180deg,rgba(7,16,23,.52),transparent)" }} />
    <div style={{ position: "absolute", left: compact ? 14 : 18, top: compact ? 13 : 17, pointerEvents: "none" }}>
      <div className="twin-scene-label" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 9, letterSpacing: ".13em", fontWeight: 600, color: "#87a6b6", textTransform: "uppercase" }}><ScanLine size={12} color={GREEN} />Singapore · R151 inspired</div>
      {!compact && <div className="twin-header-helper" style={{ marginTop: 7, fontSize: 11, color: "#637f91" }}>Conceptual model · component-level evidence</div>}
      {compact && currentPart && current && <div style={{ marginTop: 7, fontSize: 10, color: "#92a9b6" }}>{currentPart.label} <span style={{ color: COLORS[current.status] }}>· {STATUS_LABEL[current.status]}</span></div>}
    </div>
    <div style={{ position: "absolute", right: compact ? 14 : 18, top: compact ? 13 : 17, pointerEvents: "none", textAlign: "right" }}>
      <div className="twin-scene-kind" style={{ fontSize: 10, fontWeight: 600, color: "#9fb5c1" }}>{view === "bogie" ? "RUNNING GEAR" : view === "exploded" ? "EXPLODED ASSEMBLY" : view === "trainset" ? "SIX-CAR TRAINSET" : `CARRIAGE ${carIndex + 1} / 6`}</div>
      <div className="twin-header-helper" style={{ marginTop: 4, color: "#5f7d8f", fontSize: 9 }}>{compact ? "Drag to orbit" : "Drag to orbit · scroll to zoom"}</div>
    </div>

    {!compact && currentPart && current && <div className="twin-evidence-hud" aria-live="polite" style={{ position: "absolute", top: 72, left: 18, maxWidth: 210, padding: "7px 10px", borderLeft: `2px solid ${COLORS[current.status]}`, background: "linear-gradient(90deg,rgba(10,25,35,.93),rgba(10,25,35,.12))", pointerEvents: "none" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, fontWeight: 600 }}>{currentPart.label}<span style={{ fontSize: 9, color: COLORS[current.status], fontWeight: 500 }}>{STATUS_LABEL[current.status]}</span></div>
      <div style={{ fontSize: 10, color: "#86a0af", marginTop: 4 }}>{currentPart.detail}</div>
      <div style={{ fontSize: 9, color: "#617f91", marginTop: 7 }}>{riskLabel}</div>
    </div>}

    {!compact && view !== "bogie" && <div className="twin-car-picker" style={{ position: "absolute", right: 18, top: 68, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
      <div className="twin-car-picker-label" style={{ fontSize: 9, color: "#758e9e", letterSpacing: ".04em" }}>VISUAL CARRIAGE · SHARED COMPONENT DATA</div>
      <div role="group" aria-label="Choose visual carriage. Telemetry is shared across the model." style={{ ...glass, display: "flex", padding: 3, borderRadius: 9, gap: 2 }}>
        {[0, 1, 2, 3, 4, 5].map(index => <button key={index} type="button" aria-label={`Inspect visual carriage ${index + 1}${index === 0 || index === 5 ? ", driving cab" : ""}. Component evidence is train-level.`} aria-pressed={carIndex === index && view !== "trainset"} title={`Car ${index + 1}${index === 0 || index === 5 ? " · Driving cab" : ""}`} onClick={() => { setCarIndex(index); if (view === "trainset") setView("assembled"); setHovered(null); }} style={{ ...pill, minHeight: 27, minWidth: 27, padding: "3px 6px", fontSize: 10, color: carIndex === index && view !== "trainset" ? GREEN : "#7e95a4", background: carIndex === index && view !== "trainset" ? "rgba(85,214,176,.10)" : "transparent" }}>{String(index + 1).padStart(2, "0")}</button>)}
      </div>
    </div>}

    <div className="twin-bottom">
      <div role="group" aria-label="Select railway component" style={{ ...glass, display: "flex", gap: 1, borderRadius: 11, padding: 3 }}>
        {PARTS.map(part => {
          const active = selected === part.key;
          const s = states[part.key];
          return <button className="twin-part-button" key={part.key} type="button" aria-pressed={active} aria-label={`${part.label}: ${STATUS_LABEL[s.status]}. ${s.risk != null && Number.isFinite(s.risk) ? `Risk indicator ${Math.round(s.risk)} of 100.` : "No risk score available."}`} title={`${part.detail} · ${STATUS_LABEL[s.status]}`} onClick={() => selectPart(part.key)}
            style={{ ...pill, background: active ? "rgba(85,214,176,.10)" : "transparent", borderColor: active ? "rgba(85,214,176,.22)" : "transparent", color: active ? "#caeae0" : "#849baa", padding: compact ? "6px 7px" : "6px 9px" }}>
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: COLORS[s.status], boxShadow: s.status !== "unknown" ? `0 0 7px ${COLORS[s.status]}44` : "none" }} />
            <span className="twin-part-label">{part.label}</span>
          </button>;
        })}
      </div>

      {!compact && <div style={{ ...glass, display: "flex", alignItems: "center", gap: 1, borderRadius: 11, padding: 3 }}>
        <div role="group" aria-label="Model view" style={{ display: "flex", gap: 1 }}>
          {([{ key: "assembled", label: "Car", Icon: TrainFront }, { key: "trainset", label: "Trainset", Icon: GalleryHorizontalEnd }, { key: "bogie", label: "Bogie", Icon: Boxes }, { key: "exploded", label: "Exploded", Icon: UnfoldVertical }] as const).map(({ key, label, Icon }) => <button key={key} type="button" aria-pressed={view === key} aria-label={`${label} view`} title={`${label} view`} onClick={() => { setView(key); setHovered(null); if (key === "bogie" && selected === "doors") onSelect("bogies"); }} style={{ ...pill, color: view === key ? GREEN : "#849baa", background: view === key ? "rgba(85,214,176,.08)" : "transparent" }}><Icon size={13} /><span className="twin-view-label">{label}</span></button>)}
        </div>
        <span style={{ width: 1, height: 18, background: "rgba(112,147,165,.2)", margin: "0 3px" }} />
        <button type="button" aria-label={rotating ? "Pause automatic rotation" : "Start automatic rotation"} aria-pressed={rotating} title={rotating ? "Pause rotation" : "Rotate model"} onClick={() => setRotating(value => !value)} style={{ ...pill, color: rotating ? GREEN : "#849baa", padding: 7 }}>{rotating ? <Pause size={13} /> : <RotateCw size={13} />}</button>
        <button type="button" aria-label="Reset camera and retry 3D view" title="Reset view" onClick={() => { setReset(n => n + 1); setContextLost(false); setRotating(false); setHovered(null); }} style={{ ...pill, padding: 7 }}><RotateCcw size={13} /></button>
      </div>}
    </div>
  </div>;
}
