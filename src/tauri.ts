import { invoke } from "@tauri-apps/api/core";

// Typed Tauri command contracts. All backend access goes through here;
// components must not import @tauri-apps/api directly.

export interface AppStatus {
  version: string;
  platform: string;
  library_set: boolean;
}

export function getAppStatus(): Promise<AppStatus> {
  return invoke<AppStatus>("get_app_status");
}

export function greet(name: string): Promise<string> {
  return invoke<string>("greet", { name });
}

export interface SoundReport {
  id: number;
  format: number;
  sample_count: number;
  bytes: number;
}

export interface SwfReport {
  version: number;
  sounds: SoundReport[];
  skipped: SoundReport[];
}

export interface ExeReport {
  swf_offset: number;
  swf_length: number;
  inner: SwfReport;
}

export function inspectSwf(path: string): Promise<SwfReport> {
  return invoke<SwfReport>("inspect_swf", { path });
}

export function inspectExe(path: string): Promise<ExeReport> {
  return invoke<ExeReport>("inspect_exe", { path });
}

export interface PlayerStatus {
  loaded: boolean;
  path: string | null;
  playing: boolean;
  position_ms: number;
  duration_ms: number;
  loop_start_ms: number;
  loop_end_ms: number;
  loop_enabled: boolean;
  volume_pct: number;
}

export function playerLoad(path: string): Promise<PlayerStatus> {
  return invoke<PlayerStatus>("player_load", { path });
}

export function playerPlay(): Promise<PlayerStatus> {
  return invoke<PlayerStatus>("player_play");
}

export function playerPause(): Promise<PlayerStatus> {
  return invoke<PlayerStatus>("player_pause");
}

export function playerStop(): Promise<PlayerStatus> {
  return invoke<PlayerStatus>("player_stop");
}

export function playerSetVolume(volumePct: number): Promise<PlayerStatus> {
  return invoke<PlayerStatus>("player_set_volume", { volumePct });
}

export function playerSetLoop(startMs: number, endMs: number): Promise<PlayerStatus> {
  return invoke<PlayerStatus>("player_set_loop", { startMs, endMs });
}

export function playerSetLoopEnabled(enabled: boolean): Promise<PlayerStatus> {
  return invoke<PlayerStatus>("player_set_loop_enabled", { enabled });
}

export function playerStatus(): Promise<PlayerStatus> {
  return invoke<PlayerStatus>("player_status");
}

export function playerSeek(positionMs: number): Promise<PlayerStatus> {
  return invoke<PlayerStatus>("player_seek", { positionMs });
}

export interface WaveformData {
  peaks: number[];
  duration_ms: number;
  buckets: number;
}

export function waveformPeaks(path: string, buckets: number): Promise<WaveformData> {
  return invoke<WaveformData>("waveform_peaks", { path, buckets });
}

export interface Track {
  id: number;
  title: string;
  file_path: string;
  exists: boolean;
  source_type: string;
  source_path: string;
  source_hash: string;
  source_sound_id: number;
  codec: string;
  sample_rate: number;
  channels: number;
  duration_ms: number;
  bpm: number | null;
  bpm_confidence: number | null;
  bpm_source: string | null;
  primary_cue_ms: number;
  loop_start_ms: number;
  loop_end_ms: number;
  loop_enabled: boolean;
  imported_at: number;
  updated_at: number;
}

export interface ImportReport {
  looper: string;
  added: number;
  already_there: number;
  failed: { id: number; reason: string }[];
  track_ids: number[];
}

export function libraryInit(root: string): Promise<string> {
  return invoke<string>("library_init", { root });
}

export function libraryList(): Promise<Track[]> {
  return invoke<Track[]>("library_list");
}

export function importSwf(path: string): Promise<ImportReport> {
  return invoke<ImportReport>("import_swf", { path });
}

export function importExe(path: string): Promise<ImportReport> {
  return invoke<ImportReport>("import_exe", { path });
}

export interface CustomReport {
  file: string;
  added: boolean;
  track_id: number | null;
  bpm: number | null;
  bpm_confidence: number | null;
  error: string | null;
}

export function importCustom(paths: string[]): Promise<CustomReport[]> {
  return invoke<CustomReport[]>("import_custom", { paths });
}
