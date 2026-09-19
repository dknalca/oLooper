export type ImportKind = "swf" | "exe" | "audio";

export function importKindForPath(path: string): ImportKind {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "swf") return "swf";
  if (extension === "exe") return "exe";
  return "audio";
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function elapsedLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
