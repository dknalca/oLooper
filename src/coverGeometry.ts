export interface CoverSize {
  width: number;
  height: number;
}

export interface CoverFrame extends CoverSize {
  left: number;
  top: number;
}

/** Fit the image into the viewport without changing its aspect ratio. */
export function fitCover(viewport: CoverSize, image: CoverSize): CoverFrame {
  const scale = Math.min(viewport.width / image.width, viewport.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return { width, height, left: (viewport.width - width) / 2, top: (viewport.height - height) / 2 };
}

/** Return transform toward the sidebar cover, or null if no origin is usable. */
export function coverOriginTransform(frame: CoverFrame, origin: CoverFrame | null | undefined): string | null {
  const scale = origin ? Math.min(origin.width / frame.width, origin.height / frame.height) : 0;
  if (!origin || !(scale > 0)) return null;
  const x = origin.left + (origin.width - frame.width * scale) / 2 - frame.left;
  const y = origin.top + (origin.height - frame.height * scale) / 2 - frame.top;
  return `translate(${x}px, ${y}px) scale(${scale})`;
}
