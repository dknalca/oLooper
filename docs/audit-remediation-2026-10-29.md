# Correcciones de seguimiento — 2026-10-29

## Selección simultánea de biblioteca

Se resolvió la hipótesis descrita en
[`application-audit-followup-2026-10-28.md`](application-audit-followup-2026-10-28.md):
las solicitudes init/restore reciben una generación al entrar en el backend;
solo la última admitida puede activar biblioteca, log y descarga de audio. La
preparación del log ya no cambia su destino global. Si la última petición falla,
la biblioteca activa anterior no se sustituye por una petición anterior tardía.
La interfaz también descarta respuestas y errores obsoletos.

Hay pruebas del coordinador con un hilo retrasado y fallo de la petición más
reciente, de preparación de logs y de React con promesas resueltas en orden
inverso. La garantía es sobre **orden de admisión del backend**, no una prueba de
que un transporte IPC arbitrario mantenga el orden de envío. Véase
[ADR 0027](adr/0027-library-selection-admission.md).

## Movimientos sin sobrescritura

La cuarentena y la recuperación, incluida la restauración de backups Serato,
utilizan movimientos que fallan si el destino ya existe; también se protege el
rollback. Las pruebas verifican archivos y enlaces rotos existentes y que los
assets y originales se conserven ante conflictos. Véase
[ADR 0028](adr/0028-no-replace-recovery-moves.md). El reemplazo Unix de Serato y
la rotación del log aún no son una transacción atómica frente a un tercero que
modifique rutas concurrentemente: no se declaran cerradas todas las carreras.

## SHA-256 y aviso transitivo

La aplicación usa `sha2 0.11.1`, `digest 0.11.3` y `block-buffer 0.12.1` para
sus propios hashes. Se conservaron el formato hexadecimal y las identidades de
catálogo/caché; hay vectores SHA-256 y pruebas de importación/reapertura. El MSRV
1.89 se comprobó en macOS Intel.

La copia `block-buffer 0.10.4` sigue en el grafo de **compilación** a través de
`tauri-codegen 2.6.3 → sha2 0.10.9`. La consulta de crates.io del 2026-10-29
indicaba que incluso `tauri-codegen 2.7.4` seguía requiriendo `sha2 ^0.10` y
declaraba Rust 1.90. No se ha introducido un fork criptográfico ni se ha
silenciado el advisory: el escáner y el job de CI seguirán fallando hasta una
solución compatible upstream o una decisión explícita de mantenimiento. La
presencia del advisory no demuestra explotación en oLooper.

## Informes parciales de importación

El bucle de importación de sonidos conserva sus contadores ante un pánico y
registra inmediatamente una pista insertada, incluso si falla después su BPM.
El worker conserva los resultados terminados de audio personalizado y Tablist,
y el último informe disponible de SWF/EXE, para el evento final de error.
La pista en curso puede haberse confirmado antes de alcanzar el checkpoint y no
figurar en el informe; el mensaje advierte de ello. Las pruebas inyectan pánicos
y un fallo SQLite tras la inserción, y verifican el evento serializado.
Tras esta corrección: 270 pruebas Rust correctas y cuatro ignoradas; 119 pruebas
frontend, build, typecheck, Rustfmt, Clippy y comprobación con Rust 1.89
correctos en este host.

La sustitución Serato Unix y la rotación del log siguen teniendo ventanas ante
modificaciones externas simultáneas. Evitar una sustitución destructiva sin
perder actualizaciones ni romper la recuperación exige un protocolo específico
de plataforma; no se ha declarado resuelto con una comprobación previa de ruta.

## Verificación y límites de la pasada anterior

- `cargo test --locked`: 267 pruebas correctas y cuatro ignoradas; Rustfmt,
  Clippy y `cargo +1.89.0 check --locked --all-targets` correctos en Intel.
- `pnpm run typecheck`, `pnpm test`: correctos; 119 pruebas frontend.
- `cargo check --locked --target aarch64-apple-darwin`: correcto desde el host
  Intel; es comprobación de compilación, no ejecución en Apple Silicon.
- OSV: 375 paquetes del host, un advisory accionable (la copia de build indicada)
  y seis avisos de mantenimiento. El comando conserva su exit 1.
- No se han ejecutado Windows ni los fixtures ignorados, ni hardware o pruebas
  prolongadas. Node local 22.23.2 no sustituye el Node 24 requerido por CI.
