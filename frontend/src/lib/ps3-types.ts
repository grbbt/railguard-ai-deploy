export type SubsystemId = 'door' | 'acv' | 'rail' | 'shm';
export type PerClassValidation = {
  precision?: number | null;
  recall?: number | null;
  'f1-score'?: number | null;
  support?: number | null;
};
export type RankingMetrics = {
  cases: number;
  top1_correct: number;
  top2_correct: number;
  mean_rank?: number | null;
};
export type ModelSelectionAudit = {
  metric: string;
  score: number | null;
  method: string;
  ranking_metrics?: RankingMetrics | null;
  limitations: string[];
};
export type Validation = {
  metric: string;
  score: number | null;
  method: string;
  candidates: { name: string; score: number | null; ranking_metrics?: RankingMetrics | null; per_class?: Record<string, PerClassValidation | number | null> }[];
  limitations: string[];
  ranking_metrics?: RankingMetrics | null;
  nested_validation?: ModelSelectionAudit | null;
};
export type ModelMetadata = {
  subsystem: SubsystemId;
  model_name: string;
  trained_at: string;
  training_files: number;
  training_rows: number;
  validation: Validation;
  limitations?: string[];
};
export type SubsystemStatus = {
  id: SubsystemId;
  title: string;
  task: string;
  metric: string;
  available: boolean;
  model: ModelMetadata | null;
  example_files: number;
};
export type Ps3Status = {
  subsystems: SubsystemStatus[];
  assistant: { available: boolean; provider: string | null; model: string | null; message: string };
  source: { repository: string; commit: string };
  limits: { file_mb: number; batch_files: number; batch_mb: number; upload_encodings?: string[] };
};
export type Evidence = { id: string; label: string; value: number | string | null; unit?: string; detail?: string; source?: string };
export type Trace = { name: string; x_label: string; y_label: string; points: { x: number | string; y: number | null }[] };
export type PredictionReport = {
  subsystem: SubsystemId;
  file_id: string;
  model_name: string;
  summary: string;
  prediction_rows: Record<string, string | number | null>[];
  evidence: Evidence[];
  warnings: string[];
  series?: Trace[];
  entities?: { id: string; label: string; value: number | string | null; status: string; detail: string }[];
};
export type Ps3Job = {
  id: string;
  subsystem: SubsystemId;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: { completed: number; total: number; filename: string | null };
  created_at: string;
  finished_at?: string | null;
  reports: PredictionReport[];
  error?: string | null;
  source: 'uploaded' | 'organiser_test';
  validation?: Validation;
};
export type Investigation = {
  mode: 'agent' | 'local';
  answer: string;
  tools: { name: string; label: string; source_id?: string; status?: string }[];
  sources: { id: string; label: string; location?: string; details?: string }[];
  warning?: string;
  scope?: 'project' | 'run' | 'file';
  context?: Record<string, unknown>;
  elapsed_ms?: number;
};
export type RecentJob = { id: string; subsystem: SubsystemId; created_at: string };
