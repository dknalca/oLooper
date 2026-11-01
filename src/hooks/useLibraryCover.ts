import { useEffect, useState } from "react";
import type { CoverScope, LibraryCoverCache } from "../libraryCoverCache";

/** Share reads while publishing only the image owned by this consumer. */
export function useLibraryCover(cache: LibraryCoverCache, scope: CoverScope, sourceHash: string | null) {
  const [image, setImage] = useState<{ generation: number; revision: number; sourceHash: string; src: string | null } | null>(null);
  useEffect(() => {
    setImage(null);
    if (sourceHash === null) return;
    let cancelled = false;
    const owner = { generation: scope.generation, revision: scope.revision, sourceHash };
    cache.get(scope, sourceHash)
      .then((src) => { if (!cancelled) setImage({ ...owner, src }); })
      .catch(() => { if (!cancelled) setImage({ ...owner, src: null }); });
    return () => { cancelled = true; };
  }, [cache, scope.generation, scope.revision, sourceHash]);
  if (sourceHash === null) return null;
  if (image?.sourceHash === sourceHash && image.generation === scope.generation && image.revision === scope.revision) return { ...image, pending: false };
  return { sourceHash, generation: scope.generation, revision: scope.revision, src: null, pending: true };
}
