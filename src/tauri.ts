import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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
  speed_pct: number;
  pitch_lock: boolean;
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

export function playerSetSpeed(speedPct: number): Promise<PlayerStatus> {
  return invoke<PlayerStatus>("player_set_speed", { speedPct });
}

export function playerSetPitchLock(enabled: boolean): Promise<PlayerStatus> {
  return invoke<PlayerStatus>("player_set_pitch_lock", { enabled });
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

export function playerWaveformPeaks(path: string, buckets: number): Promise<WaveformData> {
  return invoke<WaveformData>("player_waveform_peaks", { path, buckets });
}

export interface Track {
  id: number;
  title: string;
  looper_name: string;
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
  favorite: boolean;
  tags: string;
  last_played_at: number | null;
}

export interface ImportReport {
  looper: string;
  added: number;
  already_there: number;
  failed: { id: number; reason: string }[];
  track_ids: number[];
}

export interface ImportProgress {
  job_id: string;
  stage: string;
  current: number;
  total: number;
  detail: string;
  done: boolean;
  error: string | null;
}

function importJobId(): string {
  return crypto.randomUUID();
}

export function libraryPortableInit(): Promise<string> {
  return invoke<string>("library_portable_init");
}

export function libraryDefaultRoot(): Promise<string> {
  return invoke<string>("library_default_root");
}

export function libraryInit(root: string): Promise<string> {
  return invoke<string>("library_init", { root });
}

export function libraryRestore(): Promise<string | null> {
  return invoke<string | null>("library_restore");
}

export function libraryList(): Promise<Track[]> {
  return invoke<Track[]>("library_list");
}

export function importSwf(path: string, jobId = importJobId()): Promise<ImportReport> {
  return invoke<ImportReport>("import_swf", { path, jobId });
}

export function importExe(path: string, jobId = importJobId()): Promise<ImportReport> {
  return invoke<ImportReport>("import_exe", { path, jobId });
}

export function cancelImport(jobId: string): Promise<void> {
  return invoke<void>("cancel_import", { jobId });
}

export function listenImportProgress(
  handler: (progress: ImportProgress) => void,
): Promise<UnlistenFn> {
  return listen<ImportProgress>("olooper:import-progress", (event) => handler(event.payload));
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

// --- File dialog wrappers ---

import { open } from "@tauri-apps/plugin-dialog";

export async function pickFiles(
  filters?: { name: string; extensions: string[] }[],
): Promise<string[]> {
  const result = await open({ multiple: true, directory: false, filters });
  if (result === null) return [];
  return Array.isArray(result) ? result : [result];
}

export async function pickDirectory(): Promise<string | null> {
  const result = await open({ directory: true, multiple: false });
  if (result === null) return null;
  return Array.isArray(result) ? result[0] : result;
}

// --- Loop slots ---

export interface LoopSlot {
  id: number;
  track_id: number;
  slot: number;
  label: string;
  cue_ms: number;
  loop_start_ms: number;
  loop_end_ms: number;
  enabled: boolean;
}

export function libraryGetSlots(trackId: number): Promise<LoopSlot[]> {
  return invoke<LoopSlot[]>("library_get_slots", { trackId });
}

export function librarySetSlot(
  trackId: number,
  slot: number,
  label: string,
  cueMs: number,
  loopStartMs: number,
  loopEndMs: number,
  enabled: boolean,
): Promise<LoopSlot> {
  return invoke<LoopSlot>("library_set_slot", {
    trackId, slot, label, cueMs, loopStartMs, loopEndMs, enabled,
  });
}

export function libraryDeleteSlot(trackId: number, slot: number): Promise<boolean> {
  return invoke<boolean>("library_delete_slot", { trackId, slot });
}

// --- Library management ---

export function libraryRemove(trackId: number): Promise<boolean> {
  return invoke<boolean>("library_remove", { id: trackId });
}

export function librarySetFavorite(trackId: number, favorite: boolean): Promise<Track> {
  return invoke<Track>("library_set_favorite", { id: trackId, favorite });
}

export function libraryUpdateMetadata(trackId: number, title: string, bpm: number | null, tags: string): Promise<Track> {
  return invoke<Track>("library_update_metadata", { id: trackId, title, bpm, tags });
}

export function libraryMarkPlayed(trackId: number): Promise<void> {
  return invoke<void>("library_mark_played", { id: trackId });
}

export function libraryExportTracks(trackIds: number[], destination: string): Promise<number> {
  return invoke<number>("library_export_tracks", { ids: trackIds, destination });
}

export function libraryRenameLooper(sourceHash: string, name: string): Promise<void> {
  return invoke<void>("library_rename_looper", { sourceHash, name });
}

export function libraryRemoveLooper(sourceHash: string): Promise<number> {
  return invoke<number>("library_remove_looper", { sourceHash });
}

export function libraryGroupDirectory(sourceHash: string): Promise<string> {
  return invoke<string>("library_group_directory", { sourceHash });
}

export function revealInFileManager(path: string): Promise<void> {
  return invoke<void>("reveal_in_file_manager", { path });
}
