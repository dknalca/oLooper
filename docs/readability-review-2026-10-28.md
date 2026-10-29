# Revisión de estructura y documentación — 2026-10-28

## Alcance

Inventario de los archivos TypeScript/React y Rust, su distribución por módulos,
contratos IPC y documentación de desarrollo; lectura focalizada de los módulos
más grandes y de los recorridos de importación, biblioteca, reproducción,
preferencias y persistencia. Se revisaron las instrucciones de build y los
enlaces Markdown relativos de README, `docs/` y `specs/`. No es una verificación
manual línea por línea de todos los archivos ni una nueva auditoría de seguridad.
Los cambios anteriores sin confirmar formaban parte del árbol y se conservaron.

## Cambios realizados

- [Guía de mantenimiento](codebase-guide.md): mapa de responsabilidades,
  recorridos UI/IPC, importación, biblioteca y audio, invariantes y comprobaciones.
- Comentarios corregidos en biblioteca, reproductor, parser SWF, waveform,
  importación e IPC: explican el comportamiento actual, incluidas fuentes
  embebidas y copia opcional, sin afirmar que todo audio está en archivos.
- README: versión correcta del instalador Windows, instalación reproducible,
  requisitos de desarrollo y enlace a la guía. Se aclara que la reproducción
  embebida puede usar el original, no solo una copia.
- `readAudioSelection` se trasladó de `App.tsx` a `audioOutputPreferences.ts`,
  junto a la lógica relacionada; se añadieron pruebas para preferencias válidas,
  inválidas y almacenamiento no disponible.

## Deuda de legibilidad identificada

La existencia de archivos largos no demuestra un error funcional, pero dificulta
seguir dependencias y revisar cambios. El inventario inicial encontró, entre
otros, `player/mod.rs` (3.967 líneas), `library/mod.rs` (3.412), `serato.rs`
(2.711), `lib.rs` (2.385) y `Sidebar.tsx` (1.742). Sus tamaños incluyen tipos y
funciones auxiliares; los tests principales de Rust están en archivos separados.

Se recomienda dividirlos gradualmente por responsabilidad, no aplicar un
formateo masivo o movimiento mecánico que oscurezca la historia y las regresiones:

1. Extraer de `Sidebar` la edición de metadatos/BPM y las interacciones de
   arrastre como unidades con contratos y pruebas de propiedad de biblioteca.
2. Separar en `lib.rs` los comandos y el ciclo de vida del worker de importación,
   conservando el registro IPC y los reportes parciales.
3. Revisar límites de `player/` entre salida, decodificación y motor antes de
   mover código que comparte estado y sincronización en tiempo real.
4. Aislar en `library/` persistencia, importación y migraciones por etapas;
   preservar transacciones, recuperación y serialización de operaciones.
5. Evaluar modularizar `serato.rs` por contenedor y codificación de marcadores,
   con fixtures/regresiones que protejan los metadatos existentes.

TypeScript tiene comprobación estricta y de símbolos no usados, pero no hay un
formatter ni lint configurado. Rustfmt y Clippy sí están disponibles. Adoptar una
política automática de estilo de frontend sería una decisión independiente;
esta pasada no introduce herramientas ni reformatea masivamente archivos ajenos.
Los pendientes de seguridad de la revisión anterior permanecen en
[la auditoría del 27 de octubre](audit-2026-10-27.md).

## Verificación y límites

- `pnpm run typecheck`, `pnpm run build`, `pnpm test`: correctos; 116 pruebas.
  Una primera ejecución simultánea con compilaciones y otras suites agotó los
  cinco segundos de una prueba de Sidebar; la suite completa pasó al repetirla
  sin esa carga. Esto no prueba que no haya problemas de temporización en CI.
- `cargo test --locked`: 247 correctas y cuatro ignoradas por fixtures externos.
  Rustfmt, Clippy estricto y `cargo doc --no-deps` con enlaces intra-doc rotos
  tratados como error: correctos.
- `git diff --check`, sintaxis Bash de scripts macOS y comprobación de enlaces
  Markdown relativos: correctos. La comprobación de enlaces no valida URLs
  remotas, anchors ni contenido enlazado.
- Host macOS Intel con Node 22.23.2, pnpm 12.9.1 y Rust 1.98.1. Node es inferior
  al 24 requerido; no se ejecutaron Windows, Apple Silicon, equipos físicos ni
  pruebas manuales de accesibilidad o sesiones largas.
