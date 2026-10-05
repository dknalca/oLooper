/** Windows canonical paths use the Win32 extended-length prefix internally. */
export function displayLibraryPath(path: string): string {
  const uncPrefix = "\\\\?\\UNC\\";
  if (path.startsWith(uncPrefix)) return `\\\\${path.slice(uncPrefix.length)}`;

  const extendedPrefix = "\\\\?\\";
  return path.startsWith(extendedPrefix) ? path.slice(extendedPrefix.length) : path;
}
