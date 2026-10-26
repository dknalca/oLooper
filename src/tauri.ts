import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { copySourcePreference } from "./importFlow";

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
  generation: number;
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
  /** Prepared automatic Random target awaiting the current loop's endpoint. */
  boundary_pending?: boolean;
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
  output_error: string | null;
}

export function playerLoad(path: string): Promise<PlayerStatus> {
  return invoke<PlayerStatus>("player_load", { path });
}

export function playerLoadTrack(trackId: number, atLoopEnd = false): Promise<PlayerStatus> {
  return invoke<PlayerStatus>("player_load_library_track", { id: trackId, atLoopEnd });
}

export function playerCancelBoundaryLoad(): Promise<PlayerStatus> {
  return invoke("player_cancel_boundary_load");
}

/** Decode a likely next track into the audio cache without switching playback. */
export function playerPrefetch(trackId: number): Promise<boolean> {
  return invoke<boolean>("player_prefetch", { id: trackId });
}

export function playerUnload(): Promise<PlayerStatus> {
  return invoke<PlayerStatus>("player_unload");
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

export function playerSetMetronome(enabled: boolean, bpm: number): Promise<PlayerStatus> {
  return invoke<PlayerStatus>("player_set_metronome", { enabled, bpm });
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

export function playerSetLoopSnapped(startMs: number, endMs: number, generation: number | null = null): Promise<PlayerStatus> {
  return invoke<PlayerStatus>("player_set_loop_snapped", { startMs, endMs, generation });
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
  playback_path: string;
  exists: boolean;
  audio_storage: "extracted" | "embedded";
  source_type: string;
  source_path: string;
  source_managed: boolean;
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

export class ImportJobError extends Error {
  readonly report: ImportReport | null;
  readonly customReport: CustomReport[] | null;
  constructor(readonly progress: ImportProgress) {
    const added = progress.report?.added ?? progress.custom_report?.filter((report) => report.added).length ?? 0;
    const summary = progress.report || progress.custom_report ? ` (${added} track(s) imported before failure)` : "";
    super(`${progress.error ?? "Import failed"}${summary}`);
    this.name = "ImportJobError";
    this.report = progress.report;
    this.customReport = progress.custom_report;
  }
}

export function partialImportCounts(cause: unknown): { added: number; existing: number; failed: number } {
  if (!(cause instanceof ImportJobError)) return { added: 0, existing: 0, failed: 0 };
  return {
    added: cause.report?.added ?? cause.customReport?.filter((item) => item.added).length ?? 0,
    existing: cause.report?.already_there ?? cause.customReport?.filter((item) => item.error === "already in library").length ?? 0,
    failed: cause.report?.failed.length ?? cause.customReport?.filter((item) => !item.added && item.error !== "already in library").length ?? 0,
  };
}

let importJobSequence = 0;

export function newImportJobId(): string {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  importJobSequence += 1;
  return `job-${Date.now().toString(36)}-${importJobSequence.toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const importJobId = newImportJobId;

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

export function libraryDragTrackOut(id: number): Promise<void> {
  return invoke<void>("library_drag_track_out", { id });
}

export function libraryConvertWavToMp3_320(id: number): Promise<Track> {
  return invoke<Track>("library_convert_wav_to_mp3_320", { id });
}

export function libraryLooperOrder(): Promise<string[]> {
  return invoke<string[]>("library_looper_order");
}

export function libraryReorderLoopers(sourceHashes: string[]): Promise<void> {
  return invoke<void>("library_reorder_loopers", { sourceHashes });
}

export interface Playlist {
  id: number;
  name: string;
  track_ids: number[];
}

export function libraryPlaylists(): Promise<Playlist[]> {
  return invoke<Playlist[]>("library_playlists");
}

export function libraryCreatePlaylist(name: string): Promise<Playlist> {
  return invoke<Playlist>("library_create_playlist", { name });
}

export function libraryRenamePlaylist(id: number, name: string): Promise<void> {
  return invoke<void>("library_rename_playlist", { id, name });
}

export function libraryRemovePlaylist(id: number): Promise<boolean> {
  return invoke<boolean>("library_remove_playlist", { id });
}

export function libraryAddTrackToPlaylist(playlistId: number, trackId: number): Promise<boolean> {
  return invoke<boolean>("library_add_track_to_playlist", { playlistId, trackId });
}

export function libraryRemoveTrackFromPlaylist(playlistId: number, trackId: number): Promise<boolean> {
  return invoke<boolean>("library_remove_track_from_playlist", { playlistId, trackId });
}

export function libraryReorderPlaylist(playlistId: number, trackIds: number[]): Promise<void> {
  return invoke<void>("library_reorder_playlist", { playlistId, trackIds });
}

export function libraryRandomTrack(excludeId: number | null, sourceHash: string | null): Promise<Track | null> {
  return invoke<Track | null>("library_random_track", { excludeId, sourceHash });
}

export type BpmReanalysisScope =
  | { kind: "library" }
  | { kind: "looper"; source_hash: string }
  | { kind: "playlist"; playlist_id: number };

export interface BpmReanalysisReport {
  total: number;
  processed: number;
  updated: number;
  protected: number;
  changed_since_start: number;
  no_estimate: number;
  failed: number;
  unprocessed: number;
  errors: string[];
}

export interface BpmReanalysisProgress {
  job_id: string;
  library_root: string;
  state: "running" | "completed" | "cancelled" | "failed";
  report: BpmReanalysisReport;
  current_track_id: number | null;
  updated_track: Track | null;
  error: string | null;
}

export function reanalyzeBpm(scope: BpmReanalysisScope, jobId: string): Promise<string> {
  return invoke<string>("reanalyze_bpm", { scope, jobId });
}

export function cancelBpmReanalysis(jobId: string): Promise<void> {
  return invoke<void>("cancel_bpm_reanalysis", { jobId });
}

export function bpmReanalysisStatus(): Promise<BpmReanalysisProgress | null> {
  return invoke<BpmReanalysisProgress | null>("bpm_reanalysis_status");
}

export function listenBpmReanalysisProgress(handler: (progress: BpmReanalysisProgress) => void): Promise<UnlistenFn> {
  return listen<BpmReanalysisProgress>("olooper:bpm-reanalysis-progress", (event) => handler(event.payload));
}

function copyContainerOnImport(): boolean {
  return copySourcePreference(localStorage.getItem("olooper.import.copy-source"));
}

export function scanLooperFolder(path: string): Promise<string[]> {
  return invoke<string[]>("scan_looper_folder", { path });
}

export interface LinkedFolder {
  id: number;
  path: string;
  extract_audio: boolean;
  copy_source: boolean;
  library_root: string;
}

export interface FolderScan {
  folder: LinkedFolder;
  paths: string[];
  removed: number;
  unchanged: number;
}

export const libraryLinkFolder = (path: string, extractAudio: boolean, copySource: boolean): Promise<LinkedFolder> =>
  invoke("library_link_folder", { path, extractAudio, copySource });
export const libraryLinkedFolders = (): Promise<LinkedFolder[]> => invoke("library_linked_folders");
export const librarySourceFolders = (sourceHash: string): Promise<LinkedFolder[]> => invoke("library_source_folders", { sourceHash });
export const libraryRescanFolder = (folder: LinkedFolder): Promise<FolderScan> =>
  invoke("library_rescan_folder", { id: folder.id, libraryRoot: folder.library_root });

export async function importLinkedFileAndWait(folder: LinkedFolder, path: string, jobId: string): Promise<ImportReport> {
  const waiter = waitForImportDone(jobId);
  try {
    await waiter.ready;
    await invoke("import_linked_file", { id: folder.id, libraryRoot: folder.library_root, path, jobId });
    const done = await waiter.done;
    if (done.error) throw new ImportJobError(done);
    if (!done.report) throw new Error("import finished without a report");
    return done.report;
  } finally { waiter.cancel(); }
}

export function importSwf(path: string, jobId = importJobId(), extractAudio = false, copySource = copyContainerOnImport()): Promise<string> {
  return invoke<string>("import_swf", { path, jobId, extractAudio, copySource });
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
export async function importSwfAndWait(
  path: string,
  jobId = importJobId(),
  extractAudio = false,
  copySource = copyContainerOnImport(),
): Promise<ImportReport> {
  const waiter = waitForImportDone(jobId);
  await waiter.ready;
  let done: ImportProgress;
  try {
    await importSwf(path, jobId, extractAudio, copySource);
    done = await waiter.done;
  } catch (error) {
    waiter.cancel();
    throw error;
  }
  if (done.error) throw new ImportJobError(done);
  if (done.report) return done.report;
  throw new Error("import finished without a report");
}

export function importExe(path: string, jobId = importJobId(), extractAudio = false, copySource = copyContainerOnImport()): Promise<string> {
  return invoke<string>("import_exe", { path, jobId, extractAudio, copySource });
}

/**
 * Enqueue an EXE import on the background worker and await its final report.
 * Keeps the `Promise<ImportReport>` shape so existing call sites don't change.
 */
export async function importExeAndWait(
  path: string,
  jobId = importJobId(),
  extractAudio = false,
  copySource = copyContainerOnImport(),
): Promise<ImportReport> {
  const waiter = waitForImportDone(jobId);
  await waiter.ready;
  let done: ImportProgress;
  try {
    await importExe(path, jobId, extractAudio, copySource);
    done = await waiter.done;
  } catch (error) {
    waiter.cancel();
    throw error;
  }
  if (done.error) throw new ImportJobError(done);
  if (done.report) return done.report;
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
  | "import-loopers"
  | "import-folder"
  | "import-audio"
  | "choose-library"
  | "show-shortcuts"
  | "audio-options"
  | "preferences"
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
  | "random-loop"
  | "volume-down"
  | "volume-up"
  | "metronome-toggle"
  | "cue-1"
  | "cue-2"
  | "cue-3"
  | "cue-4"
  | "clear-cue-2"
  | "clear-cue-3"
  | "clear-cue-4"
  | "library-encoder"
  | "library-up"
  | "library-down"
  | "library-intro"
  | "library-back";

export interface MidiInputInfo {
  id: string;
  name: string;
}

export type MidiOutputInfo = MidiInputInfo;

export interface MidiLedBinding {
  kind: "note" | "cc";
  channel: number;
  number: number;
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

export function midiListOutputs(): Promise<MidiOutputInfo[]> {
  return invoke<MidiOutputInfo[]>("midi_list_outputs");
}

export function midiConnectedInput(): Promise<MidiInputInfo | null> {
  return invoke<MidiInputInfo | null>("midi_connected_input");
}

export function midiConnectedOutput(): Promise<MidiOutputInfo | null> {
  return invoke<MidiOutputInfo | null>("midi_connected_output");
}

export function midiConnect(inputId: string): Promise<MidiInputInfo> {
  return invoke<MidiInputInfo>("midi_connect", { inputId });
}

export function midiConnectOutput(outputId: string): Promise<MidiOutputInfo> {
  return invoke<MidiOutputInfo>("midi_connect_output", { outputId });
}

export function midiDisconnectOutput(): Promise<void> {
  return invoke<void>("midi_disconnect_output");
}

export function midiSetLed(binding: MidiLedBinding, enabled: boolean): Promise<void> {
  return invoke<void>("midi_set_led", { binding, enabled });
}

export function midiDisconnect(): Promise<void> {
  return invoke<void>("midi_disconnect");
}

export function midiImportMapFile(): Promise<string | null> {
  return invoke<string | null>("midi_import_map_file");
}

export function midiExportMapFile(filename: string, contents: string): Promise<boolean> {
  return invoke<boolean>("midi_export_map_file", { filename, contents });
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
  if (done.error) throw new ImportJobError(done);
  if (done.custom_report) return done.custom_report;
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
  if (done.error) throw new ImportJobError(done);
  if (done.custom_report) return done.custom_report;
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
  bpm_source?: string | null;
  bpm_confidence?: number | null;
  cues: SeratoCue[];
  loops: SeratoLoop[];
  bpm: number | null;
}

export interface TrackBpmUpdate {
  trackId: number;
  bpm: number;
  source?: string | null;
  confidence?: number | null;
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

export interface TempoSuggestion {
  track_id: number;
  bpm: number | null;
  confidence: number | null;
  duration_frames: number;
  sample_rate: number;
  assumed_meter: "4/4" | null;
  bars: number | null;
}

/** Preview only: no catalog/tag writes and no player commands. */
export function libraryAnalyzeBpm(trackId: number): Promise<TempoSuggestion> {
  return invoke<TempoSuggestion>("library_analyze_bpm", { id: trackId });
}

export function libraryRemove(trackId: number): Promise<boolean> {
  return invoke<boolean>("library_remove", { id: trackId });
}

export function librarySetFavorite(trackId: number, favorite: boolean): Promise<Track> {
  return invoke<Track>("library_set_favorite", { id: trackId, favorite });
}

/** Without explicit BPM confirmation, keep the latest catalog tempo (not a stale draft). */
export function libraryUpdateMetadata(
  trackId: number,
  title: string,
  bpm: number | null,
  tags: string,
  confirmManualBpm: boolean,
): Promise<Track> {
  return invoke<Track>("library_update_metadata", { id: trackId, title, bpm, tags, confirmManualBpm });
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
