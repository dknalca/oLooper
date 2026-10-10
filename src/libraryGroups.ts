export const IMPORTED_AUDIO_GROUP_KEY = "__olooper_custom_audio__";

export interface LibraryGroupTrack {
  source_type: string;
  source_hash: string;
  looper_name: string;
}

export function libraryGroupKey(track: Pick<LibraryGroupTrack, "source_type" | "source_hash">): string {
  return track.source_type === "custom" ? IMPORTED_AUDIO_GROUP_KEY : track.source_hash;
}

export function libraryGroupName(track: Pick<LibraryGroupTrack, "source_type" | "looper_name">): string {
  return track.source_type === "custom" ? "Audios importados" : track.looper_name;
}
