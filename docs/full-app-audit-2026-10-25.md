# Auditoría integral de oLooper — 2026-10-25

> Registro histórico. DOC-A01–DOC-A06 se corrigieron antes de v0.8.0 con
> regresiones permanentes; véase [el cierre de release](release-0.8.0.md).
> DOC-A07 y validaciones nativas/dispositivos siguen separados de las pruebas CI.

## 1. Resumen ejecutivo

La aplicación supera las pruebas automatizadas actuales y la compilación del
frontend. La revisión adicional detecta problemas que esas pruebas no cubren:
escrituras concurrentes de metadatos, recuperación tras interrupciones,
presupuestos de memoria fuera de las cachés y coherencia de estado asíncrono.

Se registran **31 hallazgos: 4 P1, 22 P2 y 5 P3**. La prioridad expresa el impacto
en esta aplicación, no una puntuación CVSS. No se ha confirmado una ejecución
remota de código en la aplicación distribuida.

Los cuatro asuntos prioritarios de aquella pasada eran:

1. Pérdida de modificaciones de CUE al escribir simultáneamente sobre un archivo.
2. Audio gestionado que queda en cuarentena sin recuperación al reabrir la biblioteca.
3. Picos de memoria de importación/decodificación que no quedan limitados por las cachés.
4. Incompatibilidad entre el Rust mínimo declarado y las dependencias bloqueadas.

El informe inicial revisó el **árbol de trabajo de 2026-10-25**, incluidos los cambios
locales de las mejoras anteriores, sobre el commit base `a06afd5`. No equivale
a auditar únicamente el último release publicado. El diagnóstico y el plan de
corrección se completaron después en el mismo árbol de trabajo; el estado por
hallazgo, las pruebas añadidas y la verificación original están en la sección 10.
La revisión documental/técnica del 2026-10-26 encontró hallazgos adicionales
posteriores a A01–A31; véase la sección 11 y
[`documentation-review-2026-10-26.md`](documentation-review-2026-10-26.md) antes
de considerar cerrada la auditoría.

### Tipos de evidencia

- **R:** reproducido con una prueba de ensayo.
- **E:** resultado directo de una herramienta o metadatos de dependencias.
- **C:** recorrido estático del código; se explica la condición que lo activa.
- Las recomendaciones de carga, hardware y accesibilidad requieren además
  validación interactiva. No se atribuyen mejoras porcentuales ni tiempos de
  respuesta que no se hayan medido.

## 2. Alcance y cobertura

| Área | Elementos revisados | Validación realizada |
| --- | --- | --- |
| Audio | Región de loop, carga/descarga, generaciones, salidas CPAL, remuestreo, pitch lock, metrónomo, errores | Lectura del motor y pruebas Rust sin hardware |
| Importación | SWF FWS/CWS, EXE, ADPCM, MP3, audio personalizado, carpeta, cola, cancelación, reportes | Revisión de parsers, límites y worker; suite Rust |
| Persistencia | SQLite/WAL/migraciones, playlists, favoritos, metadatos, exportación, conversión, borrado y cuarentena | Suite Rust y ensayos de concurrencia/reapertura |
| Serato | Lectura/escritura de CUE, preservación de loops, temporales, validación y reemplazo | Suite y ensayo concurrente real sobre WAV de prueba |
| Memoria | PCM, contenedores, lecturas, lotes, análisis, WSOLA, carátulas y caché de ondas | Revisión de propietarios y límites; pruebas existentes |
| Frontend | Cargas, selección, Random manual/temporizado/MIDI, efectos, suscripciones, sondeo, drag/drop, formularios | Typecheck, pruebas de utilidades y build |
| Red/IPC | Hosts permitidos, redirects, HTTPS, WebView remoto, comandos, DTO y validación | Revisión y ensayos de entrada IPC |
| Distribución | Tauri, capabilities/CSP, scripts, iconos, versiones, CI Windows/macOS | Revisión de configuración y sintaxis Bash |
| Dependencias | pnpm, lockfiles, Rust declarado, advisories JS y Clippy | `pnpm audit`, metadatos Cargo y análisis estático |

### Límites concretos de esta ejecución

- Host: macOS Intel; Rust `1.98.1`, Node `22.23.2`, pnpm `12.4.2`.
  CI declara Node 24 y pnpm 12.9.1.
- No se ejecutaron Windows, Linux, macOS 11, Apple Silicon ni hardware MIDI/audio
  externo. Tampoco se generó ni instaló un nuevo DMG/NSIS.
- No se midieron RSS, CPU o latencias con una biblioteca real grande ni se
  realizaron pruebas de duración de varias horas.
- Cuatro pruebas Rust dependen de fixtures externos y permanecieron ignoradas.
- `cargo-audit` no está instalado. Como alternativa se consultó OSV, incluyendo
  sus entradas RustSec, con los nombres y versiones de las 373 dependencias de
  registro resueltas para macOS. Esto no reemplaza una matriz de auditoría de
  dependencias para todas las plataformas/feature sets.
- El inventario Cargo multiplataforma offline no pudo completarse por no tener
  `alsa 0.9.1` descargado. Sí se obtuvo el inventario filtrado del host macOS.

## 3. Resultados de herramientas

Resultados del diagnóstico inicial, anteriores a la corrección. La verificación
posterior está en la sección 10.

| Comprobación | Resultado |
| --- | --- |
| `pnpm run typecheck` | Correcto |
| `pnpm test` | 40 pruebas correctas, 10 archivos |
| `pnpm run build` | Correcto; JS principal 325,43 kB / 96,16 kB gzip |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 196 correctas, 4 ignoradas |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | Correcto |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | Falla: 17 diagnósticos, principalmente estilo/estructura |
| `pnpm audit --json` | 7 advisories: 1 alto, 5 moderados, 1 bajo; todos de desarrollo |
| `cargo audit --version` | Comando no instalado |
| OSV `querybatch`, ecosistema crates.io, inventario Cargo del host | 373 paquetes consultados; 9 señalados: rustls, webpki, Tokio y 6 sin mantenimiento; 12 IDs RustSec |
| Metadatos Cargo `--locked --filter-platform x86_64-apple-darwin --offline` | Dependencias que declaran Rust superior a 1.87 |
| `bash -n scripts/build.sh scripts/package-dmg.sh` | Correcto |
| `git diff --check` | Correcto |

Las tres pruebas de reproducción añadidas temporalmente para esta auditoría se
ejecutaron por separado y se retiraron después. No forman parte de las 196
pruebas permanentes ni modifican el comportamiento de producción.

## 4. Hallazgos prioritarios — P1

### A01 — Pérdida de CUEs por escrituras concurrentes [R]

**Evidencia:** `src-tauri/src/lib.rs:762-769,1089-1107`,
`src-tauri/src/library/mod.rs:1884-1934`,
`src-tauri/src/library/serato.rs:562-574,722-768`.

Cada comando de metadatos abre su propia conexión en `spawn_blocking`. Cambiar
un CUE lee los metadatos completos, los modifica y reemplaza el archivo, pero no
existe una exclusión mutua por archivo que cubra toda esa secuencia. Dos cambios
en slots distintos pueden leer el mismo estado inicial y escribir dos versiones
que no incluyen la modificación del otro.

**Reproducción:** WAV importado en biblioteca temporal; dos conexiones y una
barrera para iniciar a la vez `set_serato_cue(id, 2, Some(200))` y
`set_serato_cue(id, 3, Some(300))`. Ambas operaciones devolvieron éxito, pero al
releer faltó uno de los CUEs en **12 de 12 iteraciones**.

**Impacto:** pérdida silenciosa de metadatos guardados. SQLite WAL no protege las
operaciones de lectura/modificación/reemplazo sobre el archivo de audio.

**Acción:** serializar por ruta canónica la operación completa de metadatos,
incluidos migración, normalización, sincronización y conversión. Coordinar
también borrado/reemplazo del mismo archivo. Añadir una regresión que exija que
ambos CUEs sobrevivan, no solo que cada llamada termine correctamente.

### A02 — Cuarentena sin recuperación persistente tras una interrupción [R]

**Evidencia:** `src-tauri/src/library/mod.rs:306-309,316-334,1541-1620` y
`remove_track`, `remove_looper`, `convert_wav_to_mp3_320`.

Los archivos se mueven a `.olooper-trash-<pid>-<secuencia>/asset-<n>` antes de
actualizar SQLite. El mapa entre la ruta original y `asset-<n>` vive solamente
en `QuarantinedFiles.moved`, en memoria. La apertura de biblioteca no recupera
estas operaciones interrumpidas.

**Reproducción:** importar un WAV, moverlo a cuarentena mediante la operación
real, abandonar la instancia antes de modificar el catálogo y reabrir. La fila
seguía existiendo con `exists=false`; el audio permanecía en la carpeta de
cuarentena. Es una simulación determinista de ese punto de interrupción, no una
prueba de corte eléctrico.

**Impacto:** audio gestionado inaccesible tras cierre inesperado y recuperación
manual difícil por ausencia del mapa duradero. Los originales externos no fueron
eliminados en el ensayo.

**Acción:** diario/manifest persistente y sincronizado antes del primer movimiento,
con fases y recuperación al arrancar según el estado confirmado del catálogo.
Probar interrupciones antes/después de cada movimiento, UPDATE/DELETE y purge.

### A03 — Las cachés no limitan la memoria total de importación/decodificación [C]

**Evidencia:** `src-tauri/src/import/swf.rs:260-349,352-413,500-615`,
`src-tauri/src/library/mod.rs:2323-2414`,
`src-tauri/src/player/mod.rs:958-966,1025-1122,1720-1741`,
`src-tauri/src/analysis.rs:24-35,88-104`.

El parser completo retiene todos los sonidos y materializa ADPCM como WAV antes
de entrar en los lotes de importación. Después pueden coexistir cuatro PCM, sus
bytes de salida y los buffers de análisis. La duración máxima no constituye un
tope de bytes PCM: el límite depende de la frecuencia y los canales, sin un
máximo independiente de memoria decodificada.

Como referencia aritmética, 15 minutos de PCM16 estéreo a 44,1 kHz ocupan
151,4 MiB; cuatro ya suman aproximadamente 606 MiB antes de otras copias. A mayor
frecuencia/canales el consumo aumenta. El original del contenedor y las cachés
pueden seguir residentes simultáneamente.

**Impacto:** picos capaces de provocar swap intenso u OOM con entradas válidas
grandes o especialmente expansivas. No se indujo un OOM durante la auditoría.

**Acción:** límite absoluto de bytes PCM y de audio materializado por contenedor;
presupuesto compartido para trabajos en curso; ajustar lotes por memoria y
procesar ADPCM/sonidos progresivamente. Medir antes de elegir los nuevos topes.

### A04 — El Rust mínimo declarado no puede compilar el lockfile actual [E]

**Evidencia:** `src-tauri/Cargo.toml:5,17-21` y metadatos del lockfile del host.

El paquete declara `rust-version = "1.87"`. Entre las dependencias bloqueadas:

| Dependencia | Versión | Rust mínimo declarado |
| --- | --- | --- |
| `image` | 0.25.10 | 1.88.0 |
| `lofty` | 0.25.4 | 1.89 |
| `lofty_attr` | 0.13.0 | 1.89 |
| `ogg_pager` | 0.7.2 | 1.89 |
| `time` | 0.3.55 | 1.88.0 |
| `serde_with` | 3.23.0 | 1.88 |

**Impacto:** falla el entorno mínimo prometido aunque CI con `stable` y el host
con Rust 1.98.1 pasen. No se ejecutó un build con toolchain 1.87; la incompatibilidad
se establece por los requisitos explícitos de dependencias directas.

**Acción:** fijar dependencias compatibles con 1.87 o elevar el MSRV documentado
y añadir un job que compile exactamente con el mínimo elegido y `--locked`.

## 5. Estabilidad, seguridad y coherencia — P2

### A31 — Advisories en dependencias TLS de producción y Tokio [E/C]

**Evidencia:** consulta de versiones bloqueadas a `https://api.osv.dev/v1/querybatch`,
detalles de los IDs a `https://api.osv.dev/v1/vulns/<ID>` y features obtenidas de
`cargo metadata --locked --filter-platform x86_64-apple-darwin`.

| Paquete | Versión | Avisos | Versión corregida indicada |
| --- | --- | --- | --- |
| `rustls` | 0.23.45 | RUSTSEC-2026-0346, -0347, -0348, -0349 | 0.23.46 |
| `rustls-webpki` | 0.103.15 | RUSTSEC-2026-0382 / CVE-2026-111943 | 0.103.16 |
| `tokio` | 1.53.1 | RUSTSEC-2026-0386 | 1.53.3 en esa rama |

**Aplicabilidad, sin equiparar presencia con explotación:**

- **webpki:** el advisory describe aceptación de cadenas con intermediarios
  emSign desconfiados cuyas claves privadas son conocidas, si los trust anchors
  configurados permiten esas cadenas. Se comprobó además el código de reqwest
  0.13.5: la configuración por defecto usa `rustls-platform-verifier`, que en
  macOS delega la cadena a `SecTrust` y en Windows al verificador del sistema.
  Por ello, la presencia del crate no demuestra que ese bypass de cadenas se
  active en los escritorios principales. Las otras plataformas/rutas deben
  revisarse. No se ensayó una conexión falsificada ni los trust stores de usuarios.
- **rustls -0348:** exige la feature `brotli`; el inventario activado es
  `ring,std,tls12`, de modo que ese ataque de reserva de 1 GiB **no aplica** al
  feature set auditado.
- **rustls -0346:** exige un almacén de sesión personalizado que haga Debug de
  valores secretos. No se encontró ese uso en oLooper; el advisory excluye los
  caches integrados ordinarios.
- **rustls -0347:** exige ECH habilitado explícitamente y datos previos al
  handshake. La app no configura ECH explícitamente; no hay una ruta afectada
  demostrada.
- **rustls -0349:** afecta predicción de key share y confidencialidad poscuántica,
  sin bypass de autenticación. No se demostró que las condiciones de grupos
  híbridos/servidor apliquen al provider `ring` utilizado.
- **Tokio:** el aviso es de unsoundness de constructores `AsyncFd` con descriptores
  que no permanecen válidos. El código propio no construye esos `AsyncFd`; no se
  ha demostrado un uso explotable a través de transitivas.

También se señalaron seis paquetes **sin mantenimiento**, no seis CVE adicionales:
`paste 1.0.15` (RUSTSEC-2024-0436) y `unic-char-property`, `unic-char-range`,
`unic-common`, `unic-ucd-ident`, `unic-ucd-version` 0.9.0
(RUSTSEC-2025-0081, -0075, -0080, -0100, -0098).

**Acción:** actualizar parches TLS/Tokio, regenerar el lockfile, comprobar MSRV y
repetir tests/build, OSV y un smoke de HTTPS/Tablist. Revisar sustitución de los
paquetes sin mantenimiento mediante sus dependientes. No se modificaron las
dependencias durante esta auditoría.

### A05 — `max_points=0` provoca un pánico en un comando IPC [R]

**Evidencia:** `src-tauri/src/lib.rs:698-705`,
`src-tauri/src/player/mod.rs:3295-3322`.

Con audio cargado, `sample_window(center=1, radius=1, max_points=0)` divide por
cero en `frame_count / max_points`. El ensayo capturó el pánico real con
`catch_unwind`. No se ha demostrado un cierre completo del proceso: lo confirmado
es que una entrada admitida por el DTO causa un pánico en vez de un error.

**Acción:** validar `max_points` en un rango explícito, limitar radio/tamaño y
probar cero, extremos y audio multicanal. Revisar también la indexación de muestras
de `snap_loop_boundary`, que usa índices de frame como índices de sample al
calcular métricas estéreo (`3357-3365`).

### A06 — Auto-loop mantiene un lock de lectura durante el análisis completo [C]

**Evidencia:** `src-tauri/src/player/mod.rs:3385-3392` y
`src/components/Player.tsx:266-273`.

`auto_loop` conserva el guard de `loaded_buffer` mientras ejecuta `suggest`, que
mezcla y analiza el buffer. Aplicar otra carga necesita escribir ese mismo
snapshot. Además, el resultado del análisis no se revalida por generación antes
de que el frontend aplique sus límites a la pista que esté activa entonces.

**Impacto:** cambio de pista retenido por un análisis largo y límites obsoletos
aplicables a otra pista. **Acción:** clonar el `Arc` bajo lock breve, analizar
fuera, llevar path/generación hasta la aplicación de límites y descartar resultados
obsoletos.

### A07 — El límite de WSOLA es por pista, no global [C]

**Evidencia:** `src-tauri/src/player/mod.rs:2055-2103,2960-3000`.

El gate `pitch_pending` vive en `Loaded`. Al cambiar de pista se crea otro
`Loaded` sin ese gate activo, mientras el worker anterior continúa. Cambiar de
pista y activar pitch lock repetidamente puede mantener varios trabajos WSOLA
simultáneos; descartar resultados viejos no cancela su CPU ni sus buffers.

**Acción:** un gate/worker global al motor, cola de último pedido y cancelación
cooperativa cuando sea posible. La reproducción pone pitch lock a false al cargar:
la condición requiere volver a activarlo, no cualquier cambio normal de pista.

### A08 — Varias lecturas comprueban tamaño antes, pero no acotan la lectura [C]

**Evidencia:** `src-tauri/src/lib.rs:290-296`,
`src-tauri/src/player/mod.rs:1782-1796`,
`src-tauri/src/library/mod.rs:1292-1300,2619-2627`.

`metadata()` seguido de `std::fs::read()` no impide que un archivo crezca o sea
reemplazado entre ambas operaciones. Tampoco exige siempre archivo regular. El
lector de audio embebido sí usa `take(MAX+1)`, mostrando una protección que no
está generalizada.

**Acción:** abrir una vez, comprobar tipo/tamaño en el descriptor, usar lectura
limitada y validar la longitud realmente obtenida. No se han utilizado entradas
infinitas ni archivos de gran tamaño para provocar agotamiento en el ensayo.

### A09 — Hay trabajo pesado en comandos Tauri síncronos [C]

**Evidencia:** `src-tauri/src/lib.rs:324-343,1052-1075,1193-1210,726-732`.

Inspección, análisis de ondas, algunas operaciones de grupos y auto-loop son
comandos síncronos que realizan lectura, parsing, escaneos o CPU. Pueden retener
el procesamiento de comandos/UI y se suman a la contención del mutex compartido
de biblioteca. El proyecto ya dispone de `run_library_blocking` para otras rutas.

**Acción:** llevar el trabajo pesado a ejecución bloqueante controlada, limitar
concurrencia y conservar únicamente la toma del snapshot/root bajo el lock.

### A10 — Una respuesta tardía de CUE puede contaminar la interfaz de otra pista [C]

**Evidencia:** `src/components/Player.tsx:203-220,246-253`.

La lectura inicial de metadatos sí dispone de cancelación. Guardar o borrar un
CUE no comprueba pista/generación al resolver; ejecuta `setCues` y cambia el slot
activo aunque entretanto se haya cargado otra pista. Con un orden de resolución
desfavorable, las acciones de CUE posteriores pueden usar posiciones de la pista
anterior sobre la nueva.

**Acción:** comprobar ID y generación tras cada `await`/respuesta, serializar
mutaciones y limpiar su estado al cambiar de pista. Añadir prueba con respuestas
de A/B resueltas en orden inverso.

### A11 — Las recargas de catálogo no tienen generación ni cancelación [C]

**Evidencia:** `src/components/Sidebar.tsx:161-204`.

`refresh()` aplica siempre sus tres respuestas. Una recarga de la biblioteca A
puede terminar después de la recarga de B y reponer pistas/playlists antiguas,
incluso tras el vaciado por `libraryGeneration`. Los IDs son locales al catálogo,
por lo que presentar IDs de A mientras los comandos operan sobre B es especialmente
problemático.

**Acción:** token por catálogo/petición y comprobación antes de cualquier
actualización de estado; incluir el origen de biblioteca en las respuestas o
en el contexto de la operación.

### A12 — Random MIDI puede usar un ámbito antiguo y evita el controlador común [C]

**Evidencia:** `src/App.tsx:230-258,318-320,345` y `src/randomPlayback.ts`.

`executeMidiAction` captura `playRandomTrack`, pero no lo declara en sus
dependencias. Cambiar de All a un looper sin cambiar los demás valores puede
mantener en MIDI la función con el ámbito anterior. Además, MIDI llama directamente
a esa función: no participa en la exclusión de cambios ni en el reinicio del
temporizador del controlador que comparten botón y reloj.

**Acción:** incluir la dependencia correcta y conectar botón, temporizador y MIDI
a la misma acción de alto nivel. Probar cambios de ámbito sin que cambie el
estado de reproducción.

### A13 — Fugas de suscripciones cuando el alta asíncrona termina tras cleanup [C]

**Evidencia:** `src/components/ImportBar.tsx:130-141,170-244`,
`src/components/TablistCatalog.tsx:107-113`, `src/App.tsx:488-505`.

El cleanup ejecuta `off?.()`, pero si el promise de `listen` aún no resolvió,
`off` es undefined. Al resolver después, se conserva una suscripción sin cleanup.
StrictMode fuerza esa secuencia en desarrollo; cambiar rápidamente de vista
también puede producirla. La suscripción MIDI ya implementa correctamente un
flag de cancelación y liberación tardía.

**Acción:** reutilizar ese patrón en todas las altas, incluidos eventos de
drag/drop y menús. Probar desmontaje antes de que `listen` resuelva.

### A14 — Copias SWF/EXE huérfanas si falla el parsing o la importación [C]

**Evidencia:** `src-tauri/src/lib.rs:1295-1367`.

La copia administrada se crea antes de localizar/parsear y de confirmar pistas.
Las salidas por error o ausencia de sonidos no retiran una copia recién creada.
Reintentar archivos diferentes inválidos puede acumular datos sin filas que
permitan borrarlos desde la biblioteca.

**Acción:** distinguir copia nueva/reutilizada, validar antes de persistir o
usar staging, y retirar solamente la copia nueva sin referencias en los caminos
de fallo/cancelación.

### A15 — Los wrappers descartan reportes parciales cuando hay un error final [C]

**Evidencia:** `src-tauri/src/lib.rs:1447-1461`, `src/tauri.ts:445-463,474-492`.

El worker entrega `report` parcial junto con `error`. El wrapper comprueba el
error primero y lanza un `Error` de texto, perdiendo para el consumidor los IDs y
conteos de pistas que ya se importaron. Los resúmenes de lotes pueden no reflejar
la biblioteca resultante.

**Acción:** devolver un resultado con reporte y estado final, o un error tipado
que conserve el reporte. Cubrir una cancelación después de insertar varias pistas.

### A16 — Una excepción de parsing/decodificación puede terminar el worker de importación [C]

**Evidencia:** `src-tauri/src/lib.rs:1466-1475`,
`src-tauri/src/library/mod.rs:2631-2635`,
`src-tauri/src/player/mod.rs:1774-1777`.

La reproducción convierte panics del decoder en errores. El bucle de importación
no tiene aislamiento por job, y el audio personalizado llama directamente al
decoder. Si un decoder u otra operación entra en pánico, el hilo termina sin
evento final y las siguientes encolaciones fallan; el frontend puede esperar
hasta su timeout de 30 minutos.

No se afirma que un fixture concreto cause ese panic: lo constatado es la
ausencia del mecanismo de contención en esa ruta.

**Acción:** frontera de error por trabajo, evento terminal garantizado y estado
de salud/reinicio del worker. Una reserva fallida por OOM no se resuelve solamente
con `catch_unwind`; también necesita A03.

### A17 — SeekSamples de MP3 SWF se interpreta sin signo [C]

**Evidencia:** `src-tauri/src/import/swf.rs:410,416-420,560-565`,
`src-tauri/src/library/mod.rs:2063-2099`.

El campo SWF SeekSamples es de 16 bits con signo. Se almacena y lee como `u16`,
por lo que un valor negativo pasa a ser un recorte positivo muy grande. Puede
dejar un inicio incorrecto o invalidar el recorte gapless. Los ensayos existentes
cubren valores positivos, no el caso negativo.

**Acción:** mantener el signo desde el parser, definir la compensación/padding
correctos y validar con un SWF real o fixture de SeekSamples negativo, tanto
DefineSound como streaming.

### A18 — El cuerpo de error HTTP se lee entero antes de truncar el texto [C]

**Evidencia:** `src-tauri/src/tablist.rs:487-495`.

Las descargas exitosas están acotadas mediante `take`. En una respuesta no exitosa
se llama a `response.text()` sin límite y solo después se toman 2.000 caracteres.
Un error con cuerpo grande elude la protección de memoria de esa ruta.

**Acción:** leer un máximo pequeño de bytes también en errores, con tratamiento
UTF-8 tolerante. Mantener timeout y validación de host/HTTPS.

### A19 — Las carátulas repiten escaneos completos del catálogo y del filesystem [C]

**Evidencia:** `src-tauri/src/library/mod.rs:1437-1450,1478-1513`,
`src-tauri/src/lib.rs:1072-1075`.

`group_tracks` llama a `list_tracks` y filtra después. Buscar cada carátula puede
recorrer/chequear la biblioteca completa, incluso varias veces al resolver el
directorio. Con G grupos y N pistas el coste tiende a G×N, pese a que el frontend
ya limita la concurrencia a cuatro solicitudes.

**Acción:** usar la consulta filtrada por hash ya disponible y tomar una sola fila
para rutas de grupo. No hacer I/O derivado mientras se mantiene un lock global
durante más tiempo del necesario.

### A20 — El estado de reproducción provoca trabajo de biblioteca y DOM sin virtualizar [C]

**Evidencia:** `src/App.tsx:516-585`,
`src/components/Sidebar.tsx:305-367,1212-1292`.

Cada actualización del estado en App vuelve a renderizar Sidebar. Allí se
reconstruyen grupos, ordenaciones y colecciones; todas las filas seleccionadas se
materializan con `map`, sin virtualización. Esto escala con el catálogo aunque
solo cambie la posición del reproductor.

**Acción:** separar las suscripciones de reproducción, memoizar proyecciones y
virtualizar filas. Validar con 1.000/10.000 pistas y medir commits de React antes
y después; no se ha cuantificado el coste en esta ejecución.

### A21 — La caché de ondas carece de cuota y su lectura JSON no está acotada [C]

**Evidencia:** `src-tauri/src/waveform.rs:113-145`.

El bucket count se valida después de leer y deserializar el archivo completo.
Una entrada local corrupta o excesiva puede consumir memoria antes del rechazo.
La caché tampoco tiene una cuota global o retirada por antigüedad; cambios de
archivo/buckets generan nuevas claves. El nombre temporal fijo añade contención
entre procesos que utilicen la misma biblioteca.

**Acción:** límite de bytes por entrada, validación de duración/valores, temporales
únicos y cuota global LRU/por edad. Definir limpieza para archivos eliminados.

### A22 — Referencias Objective-C de drag-out sin balance completo [C]

**Evidencia:** `src-tauri/src/drag_out.rs:99-105,113-135,241-247,250-256`.

`path_ns` se crea con `alloc/init` y recibe un `retain` adicional, pero el cleanup
solo hace un `release` del path. También se crean objetos con `alloc/init`
(`provider`, `item` y cadenas auxiliares) sin un balance explícito visible en
los caminos de éxito/error. El autorelease pool no libera automáticamente
referencias que fueron adquiridas como owned.

**Acción:** revisar propiedad según las convenciones de AppKit y usar wrappers
RAII/owned; validar con Instruments en arrastres repetidos y cancelados. Revisar
además el lifetime del delegate mientras se resuelve la promesa de archivo; ese
posible problema requiere una prueba de AppKit y no se declara un use-after-free
confirmado.

### A23 — Diálogos y scrubbing no ofrecen un contrato de teclado consistente [C]

**Evidencia:** `src/components/AudioSettingsDialog.tsx:219-230`,
`src/components/MidiSettingsDialog.tsx:121-126,185-195`,
`src/components/Player.tsx:174-201,307-336`,
`src/hooks/useKeyboardShortcuts.ts:59-68`.

Varios diálogos tienen `aria-modal`, pero no establecen/restauran foco ni
encierran Tab. El bloqueo de atajos depende de que el elemento enfocado esté
dentro del diálogo: si el foco queda detrás, Space/atajos pueden actuar sobre la
reproducción. La barra de scrubbing es un `div` manejado mediante ratón, sin
semántica de slider ni manejo equivalente de teclado. El diálogo de importación
sí contiene parte del patrón de foco que falta en otros.

**Acción:** componente modal común con foco inicial, trap, restauración, Escape e
inert del fondo; slider accesible para seek. Validar con teclado y VoiceOver.

### A24 — Advisories conocidos en Vite y Vitest del lockfile [E]

`pnpm audit --json` detectó:

| Paquete afectado | Versión | Advisory | Severidad de la fuente |
| --- | --- | --- | --- |
| Vite | 6.4.3 | GHSA-698v-4r3x-3vcv | Moderada |
| Vite | 6.4.3 | GHSA-r825-w8mm-5pxw | Moderada |
| Vite | 6.4.3 | GHSA-587h-7wmj-h5pm | Alta |
| Vite | 6.4.3 | GHSA-9jrq-w75r-8gcw | Baja |
| Vite | 6.4.3 | GHSA-rq7h-c2jc-7f22 | Moderada |
| `@vitest/mocker` | 5.0.1 | GHSA-qxg6-89mg-rqv8 | Moderada |
| `@vitest/mocker` | 5.0.1 | GHSA-xp26-3454-mjgp | Moderada |

Las versiones corregidas indicadas por el escáner son Vite ≥6.4.4 y
`@vitest/mocker` ≥5.0.3. Son dependencias de desarrollo; los hallazgos de servidor
Vite/editor no prueban una vulnerabilidad equivalente en el bundle estático
distribuido. La prioridad de aplicación aquí es P2, manteniendo el dato de
severidad alta comunicado por el advisory.

**Acción:** actualizar y regenerar el lockfile pnpm, revisar la compatibilidad del
árbol Vite/Vitest y repetir audit/tests/build. Las URL de los advisories son
`https://github.com/advisories/<ID>`.

### A25 — Faltan pruebas de integración y una matriz continua del contrato soportado [E/C]

**Evidencia:** `src/**/*.test.ts`, `.github/workflows/check-windows.yml`,
`.github/workflows/release-macos.yml`, `.github/workflows/release-windows.yml`.

Las 40 pruebas frontend verifican utilidades; no montan los componentes ni
ejercitan el flujo React→IPC→motor. Por eso no detectan las respuestas tardías,
el cierre de diálogos ni dependencias omitidas de hooks. El CI de PR existente es
Windows; el flujo macOS es manual de release. Todos los flujos usan Rust stable,
sin comprobar el MSRV prometido.

**Acción:** pruebas de componentes con IPC diferido/controlado; E2E de cambio de
biblioteca, CUEs y Random; CI macOS/Windows por PR y job MSRV. Incorporar fixtures
legales pequeños para las rutas hoy ignoradas y ensayos de fallos de disco/crash.

## 6. Deuda y comportamiento a clarificar — P3

### A26 — Persistencia de límites de práctica no conectada al flujo UI [C]

**Evidencia:** `src-tauri/src/lib.rs:559-570,653-677`,
`src-tauri/src/player/mod.rs:2960-3000`, `src/components/Player.tsx:256-273`,
`specs/210-source-backed-swf-playback.md`.

El catálogo contiene límites/estado de loop y las especificaciones mencionan
metadatos de loop por pista. La carga aplica la pista completa y los cambios UI
se envían al motor sin persistirlos en el catálogo. Si se espera recuperar esos
ajustes al volver a la pista, ese contrato no está implementado; si son de sesión,
debe quedar explícito en producto y documentación.

**Acción:** decidir y probar el contrato antes de reactivar APIs antiguas de
slots; no introducir edición de Serato saved loops.

### A27 — Cancelación poco responsiva en fases largas [C]

**Evidencia:** `src-tauri/src/lib.rs:1288-1341,1501-1517,1562-1618`,
`src-tauri/src/tablist.rs:231-265,405-433`.

Se comprueba cancelación entre fases/pistas, pero no durante descompresión,
decodificación o descargas/autorizar WebView. La interfaz puede permanecer en
cancelación durante los timeouts de esas operaciones.

**Acción:** token cooperativo para I/O y fases largas; indicar claramente la
etapa no interrumpible y garantizar un evento final coherente con reporte parcial.

### A28 — Cola de importación y registro de cancelaciones sin límites de admisión [C]

**Evidencia:** `src-tauri/src/lib.rs:6-23,459-464,1220-1253,1660-1686`.

Se usa un canal no acotado y cualquier `job_id` puede insertarse en el HashSet de
cancelaciones; solo se retiran IDs al terminar un job. No hay registro de trabajos
activos que descarte cancelaciones desconocidas. La UI limita algunas entradas,
pero sus dos superficies de importación no constituyen un límite del servicio.

**Acción:** admisión acotada con error ocupado, IDs únicos/estado por job y
cancelación limitada a trabajos conocidos; mantener el procesamiento serial.

### A29 — Lockfiles y versiones de herramientas ambiguos [C]

**Evidencia:** `package.json`, `pnpm-lock.yaml`, `package-lock.json`, workflows.

El repositorio mantiene dos lockfiles y `package.json` no fija `packageManager`,
aunque CI y AGENTS requieren una versión concreta de pnpm. Esto facilita ejecutar
otra resolución de dependencias localmente. El host auditado tampoco coincidía
con las versiones de CI.

**Acción:** declarar la herramienta y sus versiones soportadas, unificar el
lockfile cuando se confirme su uso histórico y comprobar installs frozen en CI.

### A30 — El análisis estático estricto no está limpio [E]

Clippy con `-D warnings` produjo 17 diagnósticos: referencias innecesarias,
`return` innecesario, bloques iguales, demasiados argumentos, `clone` de Copy,
iteración `last` de un iterador doblemente terminado y estilo en tests. Son deuda
de calidad, **no 17 fallos funcionales confirmados**. También Cargo informa de
incompatibilidad futura de `block 0.1.6`.

**Acción:** corregir los diagnósticos compatibles con el MSRV elegido, justificar
excepciones y activar la comprobación en CI. Revisar la dependencia futura sin
atribuirle una CVE no comprobada.

## 7. Protecciones comprobadas que conviene conservar

- SWF/EXE se tratan como datos: no se ejecutan projectors.
- Límites declarados de SWF, descompresión acotada por longitud, comprobación de
  tags y rechazo de ADPCM truncado antes de reservar su PCM.
- Generaciones para descartar cargas antiguas; una decodificación de reproducción
  activa y selección pendiente de último pedido.
- Audio compartido por `Arc`, loop por índices y lectura de ondas fuera del lock
  del snapshot en la ruta normal de waveform.
- SQLite con WAL, foreign keys, busy timeout y migraciones; consultas con
  parámetros para los datos introducidos por el usuario.
- Temporales y `persist_noclobber` para importación/exportación, validación de
  tags antes de reemplazo y pruebas de preservación de Serato saved loops.
- Confinamiento de rutas gestionadas y comprobaciones contra borrar originales
  externos; sanitización de nombres y nombres reservados Windows.
- HTTPS y allowlist de hosts/redirects para Tablist. La capability por defecto
  se limita a la ventana `main`; las ventanas remotas Tablist no reciben esa
  capability. Las claves web públicas de Tablist no se clasifican como secretos
  privados filtrados por esta auditoría.
- CSP restringida para scripts y carátulas locales/data; importación de mapas
  MIDI limitada a 64 KiB y validación de asignaciones en el frontend.
- Botón Random, temporizador y MIDI comparten controlador y ámbito; la corrección
  de A12 se registró en la pasada original de la sección 10.

## 8. Plan de corrección recomendado

### Primera fase — Datos y estabilidad

1. A01: exclusión por archivo y regresión concurrente obligatoria.
2. A02: diario duradero de cuarentena y recuperación al abrir.
3. A03/A08: presupuesto de trabajos y lecturas realmente limitadas.
4. A04: alinear MSRV/lockfile y añadir su job de CI.
5. A05: validar límites de todos los comandos de análisis/ventanas.

### Segunda fase — Concurrencia y respuesta

6. A06/A07/A09: tareas fuera de locks/UI y gate global WSOLA.
7. A10/A11/A12/A13: generaciones para efectos, subscripciones y acciones.
8. A14/A15/A16: ciclo de vida de importación con staging, reportes parciales y
   contención de fallo por job.
9. A17/A18: corrección de formato SWF y límites también en cuerpos HTTP de error.
10. A24/A31: actualizar parches de dependencias JS/TLS/Tokio y revalidar HTTPS.

### Tercera fase — Escala y calidad de entrega

11. A19/A20/A21: consultas de grupo, renderizado/virtualización y cuota de cachés.
12. A22/A23: lifetime AppKit y accesibilidad de interacción.
13. A24/A25/A29/A30: dependencias y pruebas/matriz continua reproducibles.
14. A26/A27/A28: contrato de persistencia y experiencia de importación/cancelación.

## 9. Criterios para cerrar la auditoría

- Las operaciones simultáneas de CUE conservan ambas modificaciones en todas las
  iteraciones y no alteran audio ni saved loops.
- Una prueba de interrupción por cada frontera filesystem/SQLite recupera un
  estado utilizable sin archivos huérfanos ni borrado de originales.
- Entradas inválidas o excesivas retornan errores antes de división por cero,
  reservas desmedidas o lecturas completas fuera de presupuesto.
- Cambios rápidos A→B→A no aplican metadatos, listas ni límites de otra generación.
- Random de botón, timer y MIDI utiliza el mismo ámbito y la misma exclusión.
- Se obtienen mediciones de RSS/CPU/latencia con pistas largas, ADPCM, EXE, pitch
  lock, catálogos grandes y dispositivos reales.
- Compilan las plataformas soportadas con la versión mínima documentada;
  advisories y pruebas de integración se revisan como parte del release.

Las pruebas unitarias verdes constituyen una base útil; los ensayos reproducidos
demuestran que no sustituyen la cobertura de concurrencia, recuperación y GUI.

## 10. Estado de corrección — cierre original de A01–A31 (2026-10-25)

Los 31 hallazgos se corrigieron en el árbol de trabajo (sin commit) con pruebas
de regresión asociadas. La columna de verificación cita la prueba o el control
que impide la reaparición; los cambios de documentación de comportamiento están
en `specs/200-audit-hardening.md` y `specs/130-serato-cue-sync.md`.

| ID | Estado | Corrección | Verificación |
| --- | --- | --- | --- |
| A01 | Corregido | Arriendo exclusivo por biblioteca (`fs2`) + mutex reentrante que serializa todas las escrituras de metadatos, borrados y conversión (`library/operations.rs`). | `concurrent_cue_writes_preserve_both_slots`; prueba IPC con dos invocaciones simultáneas. |
| A02 | Corregido | Manifiesto duradero en la cuarentena, recuperación al abrir tras un cierre limpio y validación de rutas (`library/recovery.rs`). | Pruebas de recuperación, purga y rechazo de rutas fuera de la biblioteca. |
| A03 | Corregido | Presupuesto dinámico compartido (`memory.rs`), tope PCM, un worker de importación, presupuesto de materialización SWF/EXE y rechazo antes de reservar. | Pruebas de presupuesto y de límite PCM. |
| A04 | Corregido | MSRV alineado a Rust 1.89 (aprobado por el usuario) y job de CI que compila con esa versión. | `cargo +1.89.0 check --locked --all-targets`. |
| A05 | Corregido | Validación de `max_points`/radio antes de dividir o reservar en `sample_window`. | Regresión de entrada IPC inválida. |
| A06 | Corregido | Auto-loop copia el buffer bajo lock breve y revalida generación, ejecución única y BPM. | Pruebas de generación y BPM inválido. |
| A07 | Corregido | Compuerta global de WSOLA además del límite por pista. | Pruebas del motor sin hardware. |
| A08 | Corregido | `bounded_io` con límites y comprobación de cancelación en lectura/copia. | Pruebas unitarias de límite y cancelación. |
| A09 | Corregido | Comandos pesados pasan a `async` + `spawn_blocking`; la UI no espera análisis en el hilo IPC. | Typecheck, pruebas y revisión de registro de comandos. |
| A10 | Corregido | Las respuestas de CUE solo aplican si coinciden pista, ruta y generación (`Player.tsx`). | Prueba de componente con respuesta tardía. |
| A11 | Corregido | Secuencia de recarga con cancelación lógica y selección propiedad del efecto (`Sidebar.tsx`). | Prueba de recargas rápidas. |
| A12 | Corregido | Random de botón, temporizador y MIDI comparten controlador y ámbito de looper. | `randomPlayback` y prueba de ámbito. |
| A13 | Corregido | `ownSubscription` libera suscripciones tardías sin filtrar eventos de otra pista. | `subscription.test.ts`. |
| A14 | Corregido | Copias SWF/EXE con limpieza por `Drop`, conteo de referencias y commits sin pisar destinos. | Pruebas de importación y cancelación. |
| A15 | Corregido | `ImportJobError` conserva `report`/`custom_report`; la UI suma los parciales antes de mostrar el error. | `importJobError.test.ts`. |
| A16 | Corregido | Cada job importa con contención de pánico y emite un evento terminal aunque falle. | Pruebas del worker de importación. |
| A17 | Corregido | `seek_samples` firmado de 16 bits con recorte de relleno MP3. | Prueba de seek negativo. |
| A18 | Corregido | Cuerpo de error HTTP acotado (8 KiB) con timeouts de conexión/lectura. | Revisión y pruebas de red acotada. |
| A19 | Corregido | Consultas puntuales por ID y `source_hash`; selectores memoizados. | Typecheck y pruebas de Sidebar. |
| A20 | Corregido | Lista virtualizada (filas fijas) y waveform limitada a 30 fps. | Pruebas de componente y build. |
| A21 | Corregido | Cuota LRU por bytes/número de entradas, lectura acotada y validación del JSON de caché. | Pruebas de cuota y reutilización. |
| A22 | Corregido | Drag-out ObjC sin `cocoa`: tipos manuales, pool RAII, delegado retenido y liberación balanceada. | Compilación macOS y revisión de ARC. |
| A23 | Corregido | Trampa de foco en diálogos, `role="slider"` con teclado y atajos bloqueados con modal/slider activo. | `useModalFocus.test.tsx` y pruebas de Player. |
| A24 | Corregido | Vite 6.4.5, Vitest 5.0.5, Testing Library 16.3.3 y jsdom 27. | `pnpm audit`: 0 advisories. |
| A25 | Corregido | CI macOS + MSRV, prueba IPC de extremo a extremo y suite de componentes. | Workflow `check-app.yml`. |
| A26 | Corregido | La región de práctica se persiste y se aplica con generación de reproducción. | Pruebas de persistencia. |
| A27 | Corregido | Cancelación comprobada en parsers, IO y fases largas; lecturas acotadas. | Pruebas de cancelación por fase. |
| A28 | Corregido | Cola con capacidad fija, validación de trabajos y tombstones de cancelación acotados/expirables. | Pruebas de admisión y cancelación. |
| A29 | Corregido | Un único `pnpm-lock.yaml`, `packageManager`/`engines` y eliminación de `package-lock.json`. | `pnpm install --frozen-lockfile` en CI. |
| A30 | Corregido | `cargo clippy --all-targets -- -D warnings` limpio; formato aplicado. | CI y ejecución local. |
| A31 | Corregido | Dependencias TLS/Tokio/quick-xml/time/serde_with/lofty/image actualizadas según RustSec/OSV. | Script de auditoría: 0 advisories accionables. |

### Verificación de la pasada de corrección

| Comprobación | Resultado |
| --- | --- |
| `pnpm run typecheck` | Correcto |
| `pnpm test` | 53 pruebas correctas, 17 archivos (cierre inicial) |
| `pnpm run build` | Correcto; JS 334,13 kB / 98,74 kB gzip (cierre inicial) |
| `pnpm audit` | 0 advisories (info/low/moderate/high/critical) |
| `cargo test --locked` | 216 correctas, 4 ignoradas (cierre inicial) |
| `cargo clippy --all-targets -- -D warnings` | Limpio |
| `cargo +1.89.0 check --locked --all-targets` | Correcto |
| `scripts/audit-rust-dependencies.py` | 368 paquetes; 0 advisories accionables; 6 solo sin mantenimiento (`paste` y `unic-*`, transitivas de Tauri/wry) |

La tabla anterior conserva la evidencia del cierre de A01–A31 y no incorpora
hallazgos reproducidos el 2026-10-26. Las cifras y el artefacto más recientes
están en [`audit-validation-2026-10-25.md`](audit-validation-2026-10-25.md).

Pruebas nuevas destacadas: contrato IPC con SQLite/archivos reales y dos
escrituras de CUE simultáneas (`src-tauri/src/ipc_tests.rs`), IO acotado,
presupuesto de memoria, caché de ondas con cuota, seek firmado, reportes
parciales de importación, suscripciones, polling, Random compartido, foco modal,
y componentes `Player`/`Sidebar`.

### Pendiente de validación (no bloquea el cierre del código)

La [pasada final de cierre](audit-validation-2026-10-25.md) repitió las suites,
compiló release Universal 2 (`x86_64` + `arm64`), generó y verificó
`dist/oLooper-0.7.1-unsigned.dmg` y comprobó el arranque Intel durante 30 segundos
con un directorio de usuario temporal. La matriz enlazada contiene el checksum,
las evidencias y los pasos pendientes; no se declara validación de release completa.

- Hardware real de audio/MIDI, RSS/CPU/latencia con bibliotecas grandes y sesiones
  de varias horas.
- Windows, Linux, macOS 11 y Apple Silicon en ejecución; se compilaron ambas
  arquitecturas macOS y solo se ejecutó Intel en macOS 12.7.6.
- Instalación de distribución firmada/notarizada y NSIS Windows. El DMG local
  Universal sin firma ya se generó y pasó la verificación de integridad.
- Fixtures reales SWF/EXE/M4A/Serato: no están disponibles en este checkout.
- La matriz de accesibilidad y la experiencia de arrastre nativo requieren prueba
  manual en las plataformas soportadas.

## 11. Follow-up documental/técnico — 2026-10-26

Una revisión integral de documentación y código del 2026-10-26 añadió problemas
que no pertenecen al cierre original A01–A31. Se reprodujeron con pruebas
temporales y mediciones focalizadas; las sondas se retiraron después. Detalle,
pasos, impacto, límites de evidencia y recomendaciones:
[`documentation-review-2026-10-26.md`](documentation-review-2026-10-26.md).

| ID | Prioridad | Estado | Resumen |
| --- | --- | --- | --- |
| DOC-A01 | P1 | Reproducido; pendiente de corrección | Una lectura de `TBPM` antiguo puede reemplazar un BPM recién confirmado manualmente antes de sincronizarlo. |
| DOC-A02 | P2 | Reproducido; pendiente de corrección | Guardar un CUE puede copiar el BPM automático del catálogo a tags; batch reanalysis después interpreta ese tag como externo y protege la pista permanentemente. |
| DOC-A03 | P2 | Reproducido; pendiente de corrección | Un evento de progreso del root anterior puede pasar el filtro de la suscripción antigua y llamar a callbacks actuales durante el cleanup pasivo de React, actualizando BPM visual de una pista con ID coincidente. |
| DOC-A04 | P2 | Reproducido; pendiente de corrección | El evento de BPM de Player omite `source`/`confidence`; Sidebar lo interpreta como `serato`, oculta la advertencia y omite el análisis individual automático. |
| DOC-A05 | P2 | Medición reproducida; optimización pendiente | El worker emite dos snapshots serializados completos por track: 1.000 fallos produjeron 2.000 eventos y 1.826.898 bytes JSON / 355 ms en el harness, sin contar Tauri/WebView. |
| DOC-A06 | P3 | Inspección reproducida; optimización pendiente | El salvapantallas instala MutationObserver y listeners globales, incluido wheel no pasivo, aun cuando la preferencia está desactivada. |
| DOC-A07 | P3 | Edge sintético reproducido; validación nativa pendiente | La barrera que suprime el click al despertar caduca en `setTimeout(0)`; un click de compatibilidad sintetizado más tarde podría activar un control oculto. Probar temporalidad en WebKit/táctil antes de elevarlo. |

Los resultados automáticos, editor, batch reanalysis y salvapantallas pasan sus
pruebas actuales, pero DOC-A01–A04 afectan integridad/procedencia BPM o aislamiento
de bibliotecas y requieren corrección antes de cerrar la auditoría actual.

### Verificación después de retirar las sondas de auditoría

- `pnpm run typecheck`: correcto; `pnpm test`: 89 pruebas, 23 archivos.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: correcto;
  `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings`: limpio.
- `cargo test --manifest-path src-tauri/Cargo.toml --locked`: 231 correctas,
  cuatro ignoradas. MSRV 1.89 correcto en la pasada de implementación anterior.
- Siguen abiertos DOC-A01 a DOC-A06; DOC-A07 requiere validar WebKit real. No se
  regeneró instalador en esta revisión documental.
