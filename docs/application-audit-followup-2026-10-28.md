# Auditoría ampliada de la aplicación — 2026-10-28

## Alcance y método

Seguimiento de los informes de [2026-10-27](audit-2026-10-27.md) y
[2026-10-28](audit-2026-10-28.md). Se revisaron los recorridos de recuperación,
reconciliación de carpetas, diagnósticos, URLs/redirects Tablist, BPM,
cancelación, preferencias, foco modal, MIDI, límites de memoria, parsers y
configuración/CI. La profundidad no fue uniforme: los cambios y ensayos se
concentraron en los hallazgos indicados abajo; no se inspeccionaron todas las
líneas ni dependencias transitivas. Por tanto, este informe no certifica que no
queden fallos ni sustituye una auditoría externa o validación de dispositivos.

El árbol incluía cambios preexistentes y correcciones de pasadas anteriores; no
equivale al último commit. Host: macOS Intel, Rust 1.98.1, Node 22.23.2 y pnpm
12.9.1. Node local es inferior al Node 24 requerido por el proyecto.

## Hallazgos corregidos

### F01 — Limpieza recursiva de cuarentena podía borrar contenido ajeno

**Evidencia:** `src-tauri/src/library/recovery.rs` y `library/mod.rs`. La
limpieza normal y de recuperación usaba `remove_dir_all` sobre la carpeta de
cuarentena; si dentro aparecía un archivo/directorio no registrado, también se
borraba. Es una condición local de filesystem, no una ejecución remota probada.

**Corrección:** validar que solo hay `manifest.json` y los `asset-N` registrados,
rechazar subdirectorios y retirar únicamente archivos conocidos, sin recursión.
Si hay contenido inesperado, se conserva la cuarentena y se devuelve un error;
el usuario puede mover ese contenido a otro lugar y volver a abrir la biblioteca.
Esto puede impedir temporalmente la apertura: es preferible a borrar datos
desconocidos. Las pruebas incluyen una eliminación ya confirmada y una operación
sin confirmar, verifican que el contenido y los originales sobreviven y que la
recuperación termina al retirar manualmente el contenido ajeno.

### F02 — Reconciliación basada en un inventario obsoleto

**Evidencia:** `library/folders.rs`. La segunda enumeración comprobaba errores,
pero se descartaba su resultado. Un archivo añadido o retirado durante el hash
podía dejar obsoletas las decisiones de relocalización/eliminación. Un cambio de
contenido con el mismo nombre tampoco se detectaba antes de confirmar.

**Corrección:** comparar ambas listas y comprobar identidad alrededor del hash y
antes de la transacción: tamaño y fecha de modificación, además de dispositivo e
inode en Unix. Si se detecta un cambio, abortar antes de eliminar y pedir un
reintento. Dos pruebas fuerzan cambios entre ambas enumeraciones y verifican que
la pista sobrevive; una comprueba su posterior relocalización. No se prueba ni se
garantiza la detección de cambios que preserven esos atributos, ni una protección
atómica ante modificaciones externas posteriores a la última comprobación.

### F03 — El log de audio podía seguir enlaces fuera de la biblioteca

**Evidencia:** `audio_log.rs`. Un directorio `log` o archivo `audio-output.log`
preexistente y enlazado a otra ubicación podía dirigir escrituras de diagnóstico
fuera de la biblioteca elegida.

**Corrección:** exigir que el directorio resuelva dentro del root, rechazar logs
que no sean archivos regulares y revalidar el directorio antes de escribir. En
Unix la apertura también usa `O_NOFOLLOW` y `O_NONBLOCK` para el último componente.
Los tests comprueban enlaces de directorio y archivo y sustitución del directorio
después de iniciar; los archivos externos de prueba permanecen intactos. Las
comprobaciones no eliminan todas las carreras entre validación y apertura, ni
se ha validado en ejecución la semántica de enlaces en Windows.

### F04 — Endurecimiento preventivo de destinos HTTP

**Evidencia:** `tablist.rs`. La comprobación anterior de host y HTTPS no restringía
puertos alternativos en URLs/redirects; la política custom tampoco especificaba
un máximo explícito de saltos. No se ha demostrado una explotación ni que el
servicio real exponga un servicio sensible en otro puerto.

**Corrección:** exigir host esperado, HTTPS, puerto predeterminado y ausencia de
credenciales; máximo diez redirects. Las pruebas son unitarias de validación y
construcción del cliente, no un ensayo con red o un servidor HTTPS adversario.

### F05 — Recuperación de enlaces simbólicos en cuarentena

**Evidencia:** `quarantine_files` acepta archivos o enlaces, pero la recuperación
exigía un archivo regular y usaba `exists()`, que devuelve falso para enlaces
rotos. Un enlace staged roto podía omitirse y después eliminarse al purgar la
cuarentena aunque el catálogo siguiera apuntando a su ruta. Además, un enlace
roto en la ruta de destino no se detectaba como existente.

**Corrección:** inspeccionar con `symlink_metadata`, restaurar el enlace en sí
sin seguir su destino y rechazar cualquier destino preexistente, incluidos
enlaces rotos. Un test con enlaces válidos y rotos comprueba preservación de
destinos externos y rechazo de una colisión. La comprobación y el `rename` no
son una operación indivisible ante un tercero modificando rutas concurrentemente.

Se actualizaron las especificaciones 100, 120, 200 y 280. La spec 200 también
aclara que un pánico inesperado del worker puede emitir error sin informe
parcial; no se considera resuelto ese caso con esta pasada.

## Pendientes y límites relevantes

1. **Dependencia Cargo:** OSV señala `GHSA-qwgh-2vcv-g2f7` en `block-buffer
   0.10.4` por `sha2 0.10.9`, usado por la aplicación y por `tauri-codegen`.
   Su explotación requiere condiciones adicionales de pánico capturado y
   reutilización del buffer, no demostradas aquí. El script devuelve error y el
   job CI que lo ejecuta quedará rojo mientras siga ese advisory. La revisión
   de actualización compatible con MSRV y upstream de Tauri sigue pendiente;
   no se ha cambiado el lockfile.
2. **Carreras externas de filesystem:** la comparación de identidad, la
   validación de directorios y las operaciones de Serato reducen riesgos, pero
   no constituyen una garantía atómica frente a sustituciones concurrentes. La
   verificación/reemplazo final de Serato y la rotación del log siguen usando
   rutas. Revisar soluciones por plataforma antes de afirmar confinamiento total.
3. **Cambios de biblioteca concurrentes:** `library_init`/`library_restore`
   preparan la biblioteca y seleccionan el log antes de tomar el estado `Db`.
   Peticiones solapadas podrían desordenar la propiedad del log o la selección;
   es una hipótesis de lectura estática, no un fallo reproducido. Requiere
   pruebas con IPC diferido y una decisión sobre cuál solicitud debe ganar.
4. **Experiencia y plataformas:** DOC-A07 (click tardío al despertar), drag-out,
   accesibilidad nativa, desconexión de volúmenes, Windows/Apple Silicon/Big Sur,
   hardware audio/MIDI y pruebas prolongadas/RSS/CPU siguen sin validación aquí.
   No se hizo fuzzing, ensayo de corte eléctrico ni revisión exhaustiva de las
   bibliotecas o del WebView remoto.

## Verificación ejecutada

| Comprobación | Resultado |
| --- | --- |
| `pnpm run typecheck`, `pnpm test`, `pnpm run build` | Correctos; 117 tests frontend |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 259 correctos, cuatro ignorados por fixtures |
| Rustfmt y Clippy `--locked --all-targets -- -D warnings` | Correctos |
| `cargo +1.89.0 check --locked --all-targets` | Correcto en el host macOS Intel |
| `pnpm audit` | Sin vulnerabilidades conocidas |
| `scripts/audit-rust-dependencies.py` | 368 paquetes del host; un advisory accionable y seis avisos de mantenimiento; exit 1 |
| `git diff --check` | Correcto |

Algunas pruebas que buscan fixtures reales de Serato retornan sin ejercitarlos
cuando las variables de entorno no están definidas, aun si aparecen como
correctas; las cuatro pruebas marcadas `ignored` tampoco se ejecutaron. Las
pruebas y builds locales no equivalen a la matriz de plataformas de CI ni a una
prueba con equipos físicos.
