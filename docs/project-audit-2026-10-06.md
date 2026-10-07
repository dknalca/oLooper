# Auditoría integral — 2026-10-06

## Alcance y método

Base: commit `720822b` (v0.6.2), más Tap Tempo y la opción source-backed
añadidos localmente durante la sesión.
Revisión de los flujos frontend/IPC/Rust, comandos, scripts y workflows.
Los hallazgos siguientes proceden de lectura de código; sus escenarios son
pasos para una regresión, no pruebas de interfaz/hardware ejecutadas.

En la verificación de las correcciones locales se ejecutaron:

- `pnpm test`: 18 pruebas, 5 archivos, todas pasaron.
- `pnpm run typecheck` y `pnpm run build`: pasaron.
- `cargo test --manifest-path src-tauri/Cargo.toml`: 175 pasaron, 3 ignoradas.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` y
  `git diff --check`: pasaron.
- `pnpm audit --prod`: sin vulnerabilidades conocidas reportadas.
- `pnpm audit`: queda un aviso alto en `braces <=3.0.3`, dependencia de
  desarrollo de Tailwind 3 sin versión corregida publicada. `sharp` y
  `source-map-js` se actualizaron.
- `scripts/build.ps1 -Dev`: construyó el ejecutable Windows para
  `x86_64-pc-windows-msvc` y verificó el encabezado PE x64.

No se construyó el instalador NSIS porque `makensis.exe` no está instalado.
No se hicieron pruebas físicas de audio/MIDI ni de ejecución sobre macOS 11.
No se publicaron commits, tags ni releases. La revisión no certifica ausencia
de defectos ni sustituye las pruebas físicas pendientes.

Prioridades: **Alta** = pérdida/corrupción de datos, funcionamiento principal o
estado incoherente relevante; **Media** = funcionamiento secundario, recuperación,
rendimiento o compatibilidad; **Baja** = mantenimiento/presentación.

## Hallazgos de prioridad alta

### A01 — La sincronización de BPM puede deshacer la corrección manual

Fuentes: `src/components/Sidebar.tsx` (`saveTrackMetadata`),
`src-tauri/src/library/mod.rs:1443–1502,1556–1563`.

El editor guarda primero el nuevo BPM en SQLite y luego llama a
`sync_serato_metadata`. Esta función llama a `get_serato_metadata`, que lee el
BPM antiguo de los tags y lo vuelve a escribir en SQLite si difiere. Después
se escribe ese valor antiguo en el archivo. La UI puede conservar el nuevo
valor hasta el próximo refresh y dar una impresión falsa de guardado.

Regresión: archivo con tag 100 BPM → editar a 120 → guardar/sincronizar →
reabrir/consultar DB y tags. Ambos deberían seguir en 120 y la DB en `manual`.
Corregir separando lectura de tags de sincronización desde el catálogo; decidir
explícitamente la precedencia sin perder los CUEs ni saved loops.
**Afecta directamente a Tap Tempo.**

### A02 — El seguimiento del dispositivo predeterminado se bloquea por el polling

Fuentes: `src-tauri/src/player/mod.rs:2216–2225,2324–2377`,
`src/components/Player.tsx:144–151`, `AudioSettingsDialog.tsx:120–139`.

El motor solo llama a `follow_system_default_output` si no recibe comandos en
un segundo. La UI consulta Status cada 250 ms mientras reproduce y cada 100 ms
con el diálogo de audio abierto. En esas condiciones el timeout no llega y no
se revisa el dispositivo predeterminado.

Regresión: reproducir con System default, cambiar la salida de Windows y
comprobar que se abre la nueva sin pausar/reabrir la app. Usar una fecha límite
independiente del tráfico de comandos o notificaciones de dispositivo.

### A03 — Cambiar de biblioteca conserva tracks e IDs de la biblioteca anterior

Fuentes: `src/components/TopBar.tsx:154–164`, `src/App.tsx`
(`onLibraryReady`, estado de track activo), `src/components/Sidebar.tsx:147–153`.

El backend sustituye la conexión de biblioteca, pero App solo cambia
`libraryReady` a true. Si ya era true, no hay nueva raíz/generación que fuerce
refresh o reinicie tracks, playlists, covers, player y selección. Los IDs de
tracks son locales a cada SQLite: una operación posterior sobre un ID antiguo
puede afectar un track diferente en la biblioteca nueva.

Regresión: A y B con track ID 1 distinto; cargar A, cambiar a B y comprobar que
ningún control de CUE, metadata, delete o playlist utiliza el ID de A. Propagar
raíz/generación y anular trabajos/selecciones anteriores.

### A04 — SWF/EXE pueden sobrescribir audio de otro grupo

Fuentes: `src-tauri/src/lib.rs:197–204`,
`src-tauri/src/library/mod.rs:153–155,1751–1754,1910–1912,1585–1603`.

Las copias fuente distinguen colisiones añadiendo ` (2)` después de un stem
sanitizado de hasta 80 caracteres. El nombre de su carpeta se vuelve a sanitizar
y truncar a 80: el sufijo puede desaparecer. Dos fuentes distintas acabarían en
la misma carpeta con destinos como `01_<sound-id>.wav`. `atomic_write` usa
`persist`, que permite reemplazar destinos, sin comprobar propiedad/hash.

Regresión: dos SWFs distintos con el mismo stem de 80 caracteres y el mismo
sound ID. El segundo import nunca debe cambiar bytes del primero. Identificar
carpetas por grupo/hash y usar persistencia sin clobber con resolución de
colisiones. También hay que probar reimport tras renombrar el looper.

### A05 — Pitch Lock puede quedarse en preparación indefinida

Fuentes: `src-tauri/src/player/mod.rs:1118–1124,1654–1671,1728–1738,2607–2615`.

Cambiar velocidad durante un job modifica `track.speed` y el pedido siguiente,
pero no inicia otro job mientras `pitch_pending` es true. La respuesta anterior
se descarta porque `pitch_job_current` exige igualdad con la velocidad actual,
antes de alcanzar la rama que reinicia el job supersedido. `pitch_pending`
queda true y las siguientes solicitudes tampoco arrancan.

Regresión: Pitch Lock activado; pasar de 80% a 120% antes de terminar WSOLA.
Debe finalizar usando 120%, no quedar preparando. Separar identidad de job
vigente de aplicabilidad de su resultado.

### A06 — Una decodificación antigua puede ganar a una selección en caché

Fuentes: `src-tauri/src/player/mod.rs:2425–2452`, `cmd_load_ready`,
`load_ready_current`.

El cache hit aplica una pista pero no invalida `pending_load` de una
decodificación en curso. La respuesta antigua se valida contra ese pending
load, no contra la última generación global. Puede sustituir después la pista
que el usuario acaba de seleccionar desde la caché.

Regresión: cargar A (cachearla), empezar B y seleccionar A antes de que B
termine. B nunca debe aplicarse. Incluir cache hits en el protocolo newest-wins.

### A07 — Los atajos de transporte no publican el nuevo estado de reproducción

Fuentes: `src/hooks/useKeyboardShortcuts.ts:40–43,61–99`,
`src/components/Player.tsx:144–164`.

El hook ejecuta Play/Pause/Stop/Seek pero descarta los PlayerStatus devueltos.
Al pulsar Espacio desde pausa, el audio puede empezar mientras React continúa
con `playing=false`; como el polling depende de ese estado, no se activa.
Los siguientes Espacios pueden seguir llamando Play en lugar de Pause.

Regresión: track cargado y pausado → Space → estado visible playing → Space →
paused. Publicar respuestas al mismo propietario de estado que los botones UI.

## Hallazgos de prioridad media

### M01 — Desactivar Pitch Lock no reconstruye la fuente que está sonando

Fuente: `src-tauri/src/player/mod.rs:1678–1697,2622–2665`.

Tras completar WSOLA, la fuente del Sink retiene el buffer estirado. Desactivar
Pitch Lock solo cambia `track.buf` al original y modifica Sink speed; no remapea
cursor/bounds ni sustituye la fuente. El estado y los samples realmente sonando
pueden diferir. Probar 50% con lock, desactivarlo durante reproducción y tras
pausa; remapear y reconstruir con el buffer correcto.

### M02 — Cancel y progreso de imports no son consistentes

Fuentes: `src/components/ImportBar.tsx:61–84,113–180,182–224`,
`src-tauri/src/lib.rs:1238–1264,1301–1338`, `src/tauri.ts:414–451`.

- El bucle de SWF/EXE desde los botones no comprueba cancelQueue entre archivos.
- Los drops externos no tienen guard de import en curso; otro drop reemplaza
  archivos/progreso y comparte el estado de cancelación.
- El listener de progreso recoge todos los jobs, incluidos los de Tablist,
  y asocia entradas por basename, no por job/path.
- SWF cancelado devuelve un report parcial en evento `complete` sin error; los
  wrappers devuelven report antes de comprobar errores. El usuario puede ver
  una cancelación como import completado.
- Audio cancelado durante un batch abandona los reports acumulados aunque las
  pistas ya se hayan insertado.

Regresiones: cancelar dos SWFs seleccionados; dos drops consecutivos; importar
Tablist mientras se importa local; dos archivos del mismo nombre en carpetas
distintas. Unificar job ownership y report final de cancelación parcial.

### M03 — Cancelación SWF puede dejar un archivo sin fila de catálogo

Fuente: `src-tauri/src/library/mod.rs:1910–1950`.

El archivo se persiste y etiqueta antes de `progress("inserting in library")`.
Si ese callback devuelve cancelación, se sale antes del insert sin borrar el
archivo. Mantener cada unidad atómica o limpiar la salida que aún no tiene fila.

### M04 — Recuperación de dispositivo desconectado o stream fallido incompleta

Fuentes: `src-tauri/src/player/mod.rs:580–582,2324–2377,2382–2404,1197–1294`.

El callback de stream solo escribe un log. No marca salida inválida ni solicita
recreación. La comparación usa nombres: reconectar un endpoint del mismo nombre
no fuerza reapertura; un fallo del default queda bloqueado por
`last_default_output_failure` hasta otro cambio/aplicación. Además el metrónomo
no se pausa antes de intentar abrir otro stream y puede seguir en el anterior
si la apertura falla. Probar unplug/replug, suspensión y cambio fallido con
metrónomo activado; definir recuperación, reintentos y estado visible de error.

### M05 — Conversión, export y metadata bloquean el manejador síncrono de Tauri

Fuentes: `src-tauri/src/lib.rs:833–836,963–970,999–1005`,
`library/mod.rs:986–1147`, `player/mod.rs:2706–2711`.

Los comandos no son async y realizan CPU/I/O prolongados con el mutex del
catálogo. La conversión procesa y verifica archivos de hasta 512 MiB sin worker
dedicado ni progreso. EngineClient espera respuestas sin timeout. Esto puede
bloquear UI/otros comandos y amplifica esperas por drivers. Mover operaciones
largas a workers con conexión propia y respuestas/progreso acotados.

### M06 — La onda anterior se puede usar para seek de la pista nueva

Fuente: `src/components/Waveform.tsx:90–127,134–162`.

Al cambiar de path no se limpia `waveRef`; hasta que llegan nuevos peaks se
dibuja/usa la duración de la onda antigua con el PlayerStatus nuevo. Un clic
rápido puede pedir un seek calculado sobre la duración equivocada. Asociar
peaks a path/generación y deshabilitar seek/edición si no corresponden.

### M07 — Caché PCM no comprueba si el archivo cambió

Fuentes: `src-tauri/src/player/mod.rs:2428–2441` y `cache_decoded`;
`src-tauri/src/waveform.rs:71–96`.

La caché de audio solo identifica por path; la caché de onda sí incluye tamaño
y mtime. Sustituir audio en la misma ruta puede reproducir samples antiguos y
mostrar datos calculados a partir de otra versión. Probar reemplazo externo de
un track cacheado; compartir una identidad coherente de archivo.

### M08 — Guardar título/tags marca como manual un BPM no corregido

Fuentes: `src/components/Sidebar.tsx` (`saveTrackMetadata`),
`src-tauri/src/library/mod.rs:903–927`.

El editor envía el BPM actual aunque no se edite; cualquier BPM no nulo se marca
`manual` en SQL. Cambiar solo título elimina la indicación de BPM dudoso y
parece confirmar el análisis. Distinguir BPM cambiado/confirmado de metadata
general y tratar explícitamente confirmar por Tap Tempo el mismo valor numérico.

### M09 — Soporte macOS 11 no cubre el runtime WebKit original

Fuentes: `src/tauri.ts:286`, `src/components/TablistCatalog.tsx:133`,
`vite.config.ts`, `package.json` (Tailwind 4).

`crypto.randomUUID()` no tiene fallback. En un WebKit sin esa API, las
importaciones fallan antes del IPC. Tailwind 4 depende de características CSS
modernas; el deployment target nativo no polyfillea JavaScript/CSS. Necesita
prueba sobre la versión concreta de Safari/WebKit soportada, fallback de UUID
y requisitos de WebKit explícitos. No confundir metadata 11.0 con ejecución
certificada en Big Sur sin actualizar.

### M10 — Export no garantiza no sobrescribir bajo concurrencia

Fuente: `src-tauri/src/library/mod.rs:944–983`.

Comprueba exists y después usa fs::copy, que permite reemplazar. Otro proceso
puede crear el destino en ese intervalo. Un copy fallido puede dejar parcial.
Reservar destino con create_new, limpiar errores y verificar/atomicizar la copia.

### M11 — Reemplazo Serato Windows no es resistente a cierre inesperado

Fuente: `src-tauri/src/library/serato.rs:1709–1732`.

Se mueve destination a backup y luego temporary a destination. Un cierre entre
ambos deja el path del catálogo ausente; no hay recuperación del backup al
arrancar. Si la restauración falla se ignora su error. Implementar reemplazo
nativo seguro/recuperación y fault injection en los puntos de transición.

## Dependencias y entrega

### D01 — Dos avisos altos en herramientas de desarrollo

`pnpm audit` reportó:

- `source-map-js <1.2.2`: GHSA-68fv-2mgg-jv7q.
- `sharp <0.35.5`: GHSA-wq5f-xc86-pv6w.

No se reportaron avisos en `pnpm audit --prod`. `sharp` genera el SVG local de
iconos; ese aviso no demuestra que el instalador exponga un parser SVG remoto.
Actualizar herramientas/lockfile y volver a verificar. No se ejecutó auditoría
RustSec ni se inspeccionaron todas las transitivas Rust individualmente.

### D02 — Build Windows etiqueta x64 sin fijar/verificar el target

Fuente: `scripts/build.ps1:32–54`.

La CLI compila el target por defecto, luego el script elige el setup con mtime
más reciente y lo renombra x64. Con un toolchain diferente/CARGO_BUILD_TARGET o
target dir custom puede elegir/marcar un artefacto equivocado. Fijar x86_64 MSVC,
resolver sus paths y comprobar versión/arquitectura del setup esperado.

### D03 — CI de release no ejecuta suites de pruebas

Fuentes: `.github/workflows/release-macos.yml`, `release-windows.yml`.

Compilan/empaquetan/suben, pero no ejecutan `pnpm test` ni `cargo test`.
Separar comprobaciones de release y publicación y fallar antes del upload si
hay regresiones. Los scripts regeneran PNGs en Windows con bytes diferentes
de los committed: conviene separar regeneración deliberada de build reproducible.

## Cobertura y garantías revisadas

- SWF y EXE se parsean como datos, no se ejecutan. FWS/CWS tienen validación de
  límites/longitud; ZWS se rechaza; EXE limita candidatos.
- Descargas de audio/covers usan HTTPS, validación de host, timeouts y lectura
  limitada. Los decoders de covers imponen dimensiones y memoria máximas.
- SQLite activa foreign keys, WAL, busy timeout y migraciones hasta v9. La v9
  marca las pistas como extraídas o reproducidas desde el contenedor; playlists
  siguen siendo referencias ordenadas y sus operaciones principales usan transacciones.
- Eliminaciones validan archivos gestionados y los ponen en cuarentena para
  permitir rollback ante error SQL. No se vio una orden para borrar originales.
- La capability del frontend se limita a `main`; la webview remota de Tablist no
  recibe esa capability. CSP restringe scripts y recursos locales.
- Arrastres internos usan pointer events compartidos. Drag-out al escritorio
  sigue exclusivamente implementado para macOS: Windows no tiene equivalencia
  nativa en esta versión, como declara la spec.
- MIDI procesa Note On y CC discretos. Reconexión, dispositivos con nombres
  duplicados y Bluetooth según driver quedan como pruebas físicas pendientes;
  los IDs se basan en nombre + ocurrencia, no identificadores estables.
- Tap Tempo local tiene seis pruebas de cálculo; el origen BPM manual ahora se
  conserva en UI, catálogo y sincronización Serato.

## Validación de integración pendiente antes de otra release

1. E2E de cambio de biblioteca con IDs repetidos y operaciones de CUE/delete.
2. Imports desde WebView: modo extraído vs. source-backed, drops concurrentes,
   cancelación en cada etapa y dos fuentes con el mismo basename.
3. E2E WebView2 de source-backed SWF/EXE: elegir/seek, waveform, CUE 1 fijo,
   ausencia de CUE 2–4/tag sync, export WAV y eliminación que preserve la copia.
4. E2E WebView2 general: click looper, reorder, playlists, Favorites, drop en
   waveform y atajos de transporte desde pausa.
5. Hardware: cambio de salida default durante audio, unplug/replug, suspensión,
   endpoints de mismo nombre, metrónomo y test L/R.
6. Big Sur Intel/ARM para validar WebKit 14.1, CSS, UUID, imports, Finder drag-out,
   clipboard y arranque desde DMG.
7. Fault injection para export, sync de tags y transición de backup Serato.
8. Ejecutar el build NSIS de release y los workflows completos en CI.

## Estado de los cambios

Las correcciones A01–A07 y M01–M11 están implementadas localmente con cobertura
de regresión para BPM/Serato, imports atómicos, reemplazo de archivos, identidad
del cache, unload y reintentos de salida. Se añadió además la opción de importar
SWF/EXE como source-backed sin archivos por loop; está especificada en
`specs/210-source-backed-swf-playback.md` y `docs/adr/0020-source-backed-swf-playback.md`.
D02 fija y verifica el target Windows; D03 añade pruebas frontend/Rust antes de
empaquetar. El build Windows `-Dev` pasó.

Quedan validaciones de integración antes de release: cambiar de biblioteca con
IDs repetidos, import mode/cancelación desde WebView, source-backed playback,
transporte por atajos, desconectar/reconectar salidas y ejecutar el frontend en
Big Sur. El instalador NSIS y los workflows de release tampoco se ejecutaron localmente.

D01 está mitigado para `sharp` y `source-map-js`; `pnpm audit --prod` está limpio.
El único aviso restante es `braces`, una dependencia de desarrollo que Tailwind
3 necesita para mantener el target documentado de macOS 11. NPM informa que aún
no hay versión corregida upstream. No se publicó una release nueva.
