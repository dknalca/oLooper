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
  /** A WSOLA stretch worker is running; current audio plays untouched. */
  pitch_preparing: boolean;
  pitch_error: string | null;
  /** A background decode is running; previous audio (if any) still live. */
  loading: boolean;
  load_error: string | null;
  /** Frame-precise values for internal use. */
  position_frame: number;
  loop_start_frame: number;
  loop_end_frame: number;
  total_frames: number;
  /** Loop origin: "manual" or "automatic". */
  loop_origin: string;
  /** Loop quality score 0.0–1.0. */
  loop_quality: number;
  /** Digital peak sent to the selected left/right output channels (%). */
  output_left_level_pct: number;
  output_right_level_pct: number;
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

export function playerSetLoopSnapped(startMs: number, endMs: number): Promise<PlayerStatus> {
  return invoke<PlayerStatus>("player_set_loop_snapped", { startMs, endMs });
}

export function playerSetLoopEnabled(enabled: boolean): Promise<PlayerStatus> {
  return invoke<PlayerStatus>("player_set_loop_enabled", { enabled });
}

export function playerStatus(): Promise<PlayerStatus> {
  return invoke<PlayerStatus>("player_status");
}

export interface AudioOutputDevice {
  id: string;
  name: string;
  channels: number;
  sample_rates: number[];
  buffer_size_min: number | null;
  buffer_size_max: number | null;
  is_default: boolean;
}

export interface AudioOutputSelection {
  deviceName: string | null;
  firstChannel: number;
  sampleRate: number | null;
  bufferFrames: number | null;
}

export function audioOutputDevices(): Promise<AudioOutputDevice[]> {
  return invoke<AudioOutputDevice[]>("audio_output_devices");
}

export function audioSetOutput(selection: AudioOutputSelection): Promise<PlayerStatus> {
  return invoke<PlayerStatus>("audio_set_output", {
    deviceName: selection.deviceName,
    firstChannel: selection.firstChannel,
    sampleRate: selection.sampleRate,
    bufferFrames: selection.bufferFrames,
  });
}

export function audioTestOutput(selection: AudioOutputSelection): Promise<PlayerStatus> {
  return invoke<PlayerStatus>("audio_test_output", {
    deviceName: selection.deviceName,
    firstChannel: selection.firstChannel,
    sampleRate: selection.sampleRate,
    bufferFrames: selection.bufferFrames,
  });
}

export function playerSeek(positionMs: number): Promise<PlayerStatus> {
  return invoke<PlayerStatus>("player_seek", { positionMs });
}

export interface SampleWindow {
  start_frame: number;
  end_frame: number;
  sample_rate: number;
  channels: number;
  samples: number[];
}

export function playerSampleWindow(
  centerFrame: number,
  radiusFrames: number,
  maxPoints: number,
): Promise<SampleWindow> {
  return invoke<SampleWindow>("player_sample_window", {
    centerFrame,
    radiusFrames,
    maxPoints,
  });
}

export interface SnappedBoundary {
  frame: number;
  ms: number;
  discontinuity: number;
  zero_crossing_found: boolean;
}

export function playerSnapLoopBoundary(
  boundary: "start" | "end",
  requestedFrame: number,
  otherBoundaryFrame: number,
): Promise<SnappedBoundary> {
  return invoke<SnappedBoundary>("player_snap_loop_boundary", {
    boundary,
    requestedFrame,
    otherBoundaryFrame,
  });
}

export interface AutoLoopCandidate {
  start_frame: number;
  end_frame: number;
  quality: number;
  discontinuity: number;
  zero_crossing_start: boolean;
  zero_crossing_end: boolean;
  bpm_aligned: boolean;
  onset_frame: number;
  duration_frames: number;
}

export interface AutoLoopResult {
  candidate: AutoLoopCandidate | null;
  bpm: number | null;
  bpm_confidence: number | null;
  total_frames: number;
  sample_rate: number;
  all_candidates: AutoLoopCandidate[];
}

export function playerAutoLoop(
  bpm?: number,
): Promise<AutoLoopResult> {
  return invoke<AutoLoopResult>("player_auto_loop", { bpm: bpm ?? null });
}

export function playerSetDiagnostics(
  loopOrigin: string,
  loopQuality: number,
): Promise<PlayerStatus> {
  return invoke<PlayerStatus>("player_set_diagnostics", { loopOrigin, loopQuality });
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
  seek_samples: number;
  trimmed_leading: number;
  bpm: number | null;
  bpm_confidence: number | null;
  bpm_source: string | null;
  primary_cue_ms: number;
  loop_start_ms: number;
  loop_end_ms: number;
  loop_enabled: boolean;
  loop_start_frame: number;
  loop_end_frame: number;
  loop_origin: string;
  loop_quality: number;
  loop_needs_review: boolean;
  total_frames: number;
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
  /** Present only on the final `done` event of worker-run imports. */
  report: ImportReport | null;
  /** Same, for custom-audio jobs (per-file results). */
  custom_report: CustomReport[] | null;
}

function importJobId(): string {
  return crypto.randomUUID();
}

export function libraryDefaultRoot(): Promise<string> {
  return invoke<string>("library_default_root");
}

export function libraryInit(root: string): Promise<string> {
  return invoke<string>("library_init", { root });
}

export function libraryRestore(root: string | null): Promise<string | null> {
  return invoke<string | null>("library_restore", { root });
}

export function libraryList(): Promise<Track[]> {
  return invoke<Track[]>("library_list");
}

export function libraryRandomTrack(excludeId: number | null): Promise<Track | null> {
  return invoke<Track | null>("library_random_track", { excludeId });
}

export function importSwf(path: string, jobId = importJobId()): Promise<string> {
  return invoke<string>("import_swf", { path, jobId });
}

/** Register before enqueueing to avoid missing a fast worker completion. */
function waitForImportDone(jobId: string, timeoutMs = 30 * 60 * 1000): {
  ready: Promise<void>;
  done: Promise<ImportProgress>;
  cancel: () => void;
} {
  let unlisten: UnlistenFn | undefined;
  let timeout: number | undefined;
  let settled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  let resolveDone!: (progress: ImportProgress) => void;
  let rejectDone!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const done = new Promise<ImportProgress>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const cancel = () => {
    if (timeout !== undefined) window.clearTimeout(timeout);
    unlisten?.();
  };
  listenImportProgress((progress) => {
    if (progress.job_id !== jobId || !progress.done || settled) return;
    settled = true;
    cancel();
    resolveDone(progress);
  }).then((off) => {
    unlisten = off;
    resolveReady();
    if (settled) off();
    else timeout = window.setTimeout(() => {
      settled = true;
      cancel();
      rejectDone(new Error("import timed out"));
    }, timeoutMs);
  }).catch((error) => {
    rejectReady(error);
  });
  return { ready, done, cancel };
}

/**
 * Enqueue an SWF import on the background worker and await its final report.
 * Keeps the `Promise<ImportReport>` shape so existing call sites don't change.
 * The listener is registered before the IPC call to avoid a race where the
 * worker finishes before `waitForImportDone` starts listening.
 */
export async function importSwfAndWait(path: string, jobId = importJobId()): Promise<ImportReport> {
  const waiter = waitForImportDone(jobId);
  await waiter.ready;
  let done: ImportProgress;
  try {
    await importSwf(path, jobId);
    done = await waiter.done;
  } catch (error) {
    waiter.cancel();
    throw error;
  }
  if (done.report) return done.report;
  if (done.error) throw new Error(done.error);
  throw new Error("import finished without a report");
}

export function importExe(path: string, jobId = importJobId()): Promise<string> {
  return invoke<string>("import_exe", { path, jobId });
}

/**
 * Enqueue an EXE import on the background worker and await its final report.
 * Keeps the `Promise<ImportReport>` shape so existing call sites don't change.
 */
export async function importExeAndWait(path: string, jobId = importJobId()): Promise<ImportReport> {
  const waiter = waitForImportDone(jobId);
  await waiter.ready;
  let done: ImportProgress;
  try {
    await importExe(path, jobId);
    done = await waiter.done;
  } catch (error) {
    waiter.cancel();
    throw error;
  }
  if (done.report) return done.report;
  if (done.error) throw new Error(done.error);
  throw new Error("import finished without a report");
}

export function cancelImport(jobId: string): Promise<void> {
  return invoke<void>("cancel_import", { jobId });
}

export function listenImportProgress(
  handler: (progress: ImportProgress) => void,
): Promise<UnlistenFn> {
  return listen<ImportProgress>("olooper:import-progress", (event) => handler(event.payload));
}

export type AppMenuCommand =
  | "import-files"
  | "open-swf"
  | "open-exe"
  | "import-audio"
  | "choose-library"
  | "show-shortcuts"
  | "audio-options"
  | "midi-options";

export function listenAppMenuCommand(
  handler: (command: AppMenuCommand) => void,
): Promise<UnlistenFn> {
  return listen<AppMenuCommand>("olooper:menu-command", (event) => handler(event.payload));
}

export type MidiAction =
  | "play-pause"
  | "stop"
  | "previous"
  | "next"
  | "toggle-loop"
  | "auto-loop"
  | "speed-up"
  | "speed-down"
  | "cue-1"
  | "cue-2"
  | "cue-3"
  | "cue-4"
  | "clear-cue-2"
  | "clear-cue-3"
  | "clear-cue-4";

export interface MidiInputInfo {
  id: string;
  name: string;
}

export interface MidiBinding {
  inputId: string;
  inputName: string;
  kind: "note" | "cc";
  channel: number;
  number: number;
}

export interface MidiMessage extends MidiBinding {
  value: number;
}

export function midiListInputs(): Promise<MidiInputInfo[]> {
  return invoke<MidiInputInfo[]>("midi_list_inputs");
}

export function midiConnectedInput(): Promise<MidiInputInfo | null> {
  return invoke<MidiInputInfo | null>("midi_connected_input");
}

export function midiConnect(inputId: string): Promise<MidiInputInfo> {
  return invoke<MidiInputInfo>("midi_connect", { inputId });
}

export function midiDisconnect(): Promise<void> {
  return invoke<void>("midi_disconnect");
}

export function listenMidiMessage(handler: (message: MidiMessage) => void): Promise<UnlistenFn> {
  return listen<MidiMessage>("olooper:midi-message", (event) => handler(event.payload));
}

export interface CustomReport {
  file: string;
  added: boolean;
  track_id: number | null;
  bpm: number | null;
  bpm_confidence: number | null;
  error: string | null;
}

export interface TablistCatalogLooper {
  nid: string;
  title: string;
  tags: string[];
  loops: string[];
  image: string;
  path: string;
  date: string;
}

export interface TablistCatalogPage {
  hits: TablistCatalogLooper[];
  estimatedTotalHits: number;
  limit: number;
  offset: number;
  skippedInvalidPaths: number;
}

export interface TablistImportCount {
  source_path: string;
  tracks: number;
}

export function tablistSearch(query: string, offset: number, limit = 24): Promise<TablistCatalogPage> {
  return invoke<TablistCatalogPage>("tablist_search", { query, offset, limit });
}

export function libraryTablistImportCounts(): Promise<TablistImportCount[]> {
  return invoke<TablistImportCount[]>("library_tablist_import_counts");
}

export function importCustom(paths: string[], jobId = importJobId()): Promise<string> {
  return invoke<string>("import_custom", { paths, jobId });
}

/**
 * Enqueue a custom-audio import on the background worker and await the
 * per-file results. Keeps the `Promise<CustomReport[]>` shape so existing
 * call sites don't change.
 */
export async function importCustomAndWait(paths: string[], jobId = importJobId()): Promise<CustomReport[]> {
  const waiter = waitForImportDone(jobId);
  await waiter.ready;
  let done: ImportProgress;
  try {
    await importCustom(paths, jobId);
    done = await waiter.done;
  } catch (error) {
    waiter.cancel();
    throw error;
  }
  if (done.custom_report) return done.custom_report;
  if (done.error) throw new Error(done.error);
  throw new Error("import finished without a report");
}

export function importTablist(
  url: string,
  jobId = importJobId(),
  coverPath: string | null = null,
): Promise<string> {
  return invoke<string>("import_tablist", { url, jobId, coverPath });
}

/** Import every audio loop exposed by a Tablist looper page. */
export async function importTablistAndWait(
  url: string,
  jobId = importJobId(),
  coverPath: string | null = null,
): Promise<CustomReport[]> {
  const waiter = waitForImportDone(jobId);
  await waiter.ready;
  let done: ImportProgress;
  try {
    await importTablist(url, jobId, coverPath);
    done = await waiter.done;
  } catch (error) {
    waiter.cancel();
    throw error;
  }
  if (done.custom_report) return done.custom_report;
  if (done.error) throw new Error(done.error);
  throw new Error("Tablist import finished without a report");
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

// --- Audio-file CUE metadata ---

export interface SeratoCue {
  slot: number;
  label: string;
  position_ms: number;
}

export interface SeratoLoop {
  slot: number;
  label: string;
  start_ms: number;
  end_ms: number;
}

export interface SeratoMetadata {
  cues: SeratoCue[];
  loops: SeratoLoop[];
  bpm: number | null;
}

export function libraryGetSeratoMetadata(trackId: number): Promise<SeratoMetadata> {
  return invoke<SeratoMetadata>("library_get_serato_metadata", { trackId });
}

export function librarySetSeratoCue(
  trackId: number,
  slot: number,
  positionMs: number | null,
): Promise<SeratoMetadata> {
  return invoke<SeratoMetadata>("library_set_serato_cue", { trackId, slot, positionMs });
}

export function librarySyncSeratoMetadata(trackId: number): Promise<void> {
  return invoke<void>("library_sync_serato_metadata", { trackId });
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

export function libraryGroupCover(sourceHash: string): Promise<string | null> {
  return invoke<string | null>("library_group_cover", { sourceHash });
}

export function revealInFileManager(path: string): Promise<void> {
  return invoke<void>("reveal_in_file_manager", { path });
}
