/** Geographic coordinates use Leaflet order: [latitude, longitude]. */
export type GeoPoint = [number, number];
export type NetworkStation = { id: string; name: string; lat: number; lng: number; lines: string[] };
export type NetworkLine = { id: string; name: string; color: string; path: GeoPoint[]; paths?: GeoPoint[][]; station_ids: string[] };
export type NetworkData = {
  source: string;
  source_url: string;
  fetched_at: string;
  attribution: string;
  stations: NetworkStation[];
  lines: NetworkLine[];
  warnings: string[];
};
export type PositionSource = 'demo' | 'telemetry' | 'unavailable';
export type TrainPosition = {
  train_id: string;
  lat: number;
  lng: number;
  line: string | null;
  station_id?: string | null;
  direction?: string | null;
  position_source: PositionSource;
  timestamp: string | null;
};
export type NetworkPositions = {
  dataset_id: string;
  source: PositionSource;
  timestamp: string | null;
  positions: TrainPosition[];
  note: string;
};
