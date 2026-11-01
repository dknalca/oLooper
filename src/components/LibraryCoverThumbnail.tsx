import { useEffect, useRef, useState } from "react";
import { useLibraryCover } from "../hooks/useLibraryCover";
import type { CoverScope, LibraryCoverCache } from "../libraryCoverCache";

export default function LibraryCoverThumbnail({ cache, scope, sourceHash }: { cache: LibraryCoverCache; scope: CoverScope; sourceHash: string | null }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (!ref.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "100px" });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const image = useLibraryCover(cache, scope, visible ? sourceHash : null);
  return <span ref={ref} className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-border text-sm text-text-secondary" aria-hidden="true">
    {image?.src ? <img src={image.src} alt="" decoding="async" className="h-8 w-8 rounded object-cover" /> : "♫"}
  </span>;
}
