# ADR 0004 — UI Redesign: Tailwind CSS v4

- Status: accepted
- Date: 2026-09-19

## Context

The original UI used inline `style={}` props on raw HTML elements with no
design system. This made the app look like an unstyled prototype: no
consistent spacing, typography, hover states, or visual hierarchy.

## Decision

- Replace all inline styles with Tailwind CSS v4 utility classes.
- Add `@tailwindcss/vite` plugin (zero-config, purged CSS).
- Define design tokens as CSS custom properties in `src/index.css`.
- No component library (shadcn, Radix, etc.) — pure Tailwind utilities.

## Design tokens

```css
--color-app: #0a0a0a;
--color-surface: #141414;
--color-surface-hover: #1e1e1e;
--color-elevated: #1a1a1a;
--color-border: #2a2a2a;
--color-text: #e8e8e8;
--color-text-secondary: #888;
--color-accent: #4aa3ff;
--color-success: #34d399;
--color-warning: #fbbf24;
--color-danger: #f87171;
```

## Consequences

- CSS bundle is ~20 KB (purged), zero runtime overhead.
- All components use `className` instead of `style` props.
- New components inherit the design system automatically.
- Custom scrollbar, range input, and focus ring styles in `index.css`.
- Layout uses CSS Grid (sidebar + main) instead of vertical flex stack.

## Alternatives considered

- **Inline styles (status quo)**: rejected — no hover states, no
  consistency, no responsive design.
- **styled-components / Emotion**: rejected — runtime overhead, harder
  to debug, not needed for Tauri desktop app.
- **shadcn/ui**: rejected — adds Radix dependency, more than needed for
  a practice tool.
