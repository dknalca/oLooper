# Revisión de rendimiento: prioridad al audio

Fecha: 2026-10-29. Revisión estática del árbol de trabajo, incluidos los
refactors locales sin commit. No es una medición en dispositivos ni una
certificación de ausencia de cortes. En la revisión inicial no se aplicaron
optimizaciones ni se ejecutaron compilaciones nativas o pruebas de carga.
Los hallazgos siguientes describen ese estado inicial; el seguimiento al final
identifica las tandas implementadas después.

## Conclusión

La mejor primera intervención no es cambiar el motor ni seguir dividiendo
componentes: es evitar trabajo duplicado de catálogo, imágenes, consultas de
estado, búsquedas web y dibujo. Después conviene mejorar la admisión del trabajo
pesado, sin aumentar indiscriminadamente la concurrencia.

Conviene distinguir tres objetivos:

1. **Continuidad:** el callback entrega cada bloque de audio dentro de su plazo.
2. **Respuesta:** play, CUE, seek y cambios de pista no esperan tareas accesorias.
3. **Ligereza:** menos CPU, memoria, IPC, disco y consumo energético.

Una interfaz que responde tarde no prueba un corte de audio; tampoco una
interfaz fluida demuestra que el callback cumple sus plazos.

## Protecciones existentes que deben conservarse

- Audio decodificado en memoria y looping por índices, sin reabrir archivos en
  cada vuelta: `src-tauri/src/player/mod.rs:65`.
- Callback de salida separado del bucle de comandos del motor. No aparece
  acceso directo a SQLite o al sistema de archivos en `render_routed_output`
  (`src-tauri/src/player/mod.rs:256`). Esto no certifica todas las rutas internas
  de Rodio/CPAL como libres de bloqueos o asignaciones.
- Decodificación y WSOLA fuera del bucle de control; se conserva el audio actual
  hasta disponer del reemplazo. Solicitudes supersedidas se descartan.
- Límite de trabajo transitorio, cachés acotadas y adaptadas a memoria disponible
  (`src-tauri/src/memory.rs`). No retirarlos para ganar velocidad aparente.
- WAL y busy timeout, worker de importación con cola limitada y conexión propia.
- Lista de pistas virtualizada, transformaciones memorizadas y `memo(Sidebar)`.
- Sondeo secuencial, eventos de BPM acotados y suscripción antes de admitir
  importaciones/reanálisis. Conservar eventos terminales y propiedad de biblioteca.
- Validación de rutas, identidad de archivos, hashes de fuentes y escrituras
  atómicas. Reducir comprobaciones redundantes no autoriza a eliminar controles.

## Primer bloque: reducir carga sin cambiar las muestras

### 1. Catálogo: menos recargas completas y comprobaciones de archivos

**Evidencia:** `Sidebar.refresh` pide pistas, playlists y orden de loopers
(`src/components/Sidebar.tsx:192`). La consulta de pistas hace `is_file()` por
fila (`src-tauri/src/library/mod.rs:423`). Random también construye todas las
pistas de su ámbito antes de elegir una (`src-tauri/src/library/mod.rs:922`).

**Propuesta:** notificar cambios incrementales y recuperar filas por ID; separar
el cambio de `last_played_at` de una recarga completa. Memorizar disponibilidad
con invalidación y comprobación real al reproducir; deduplicar comprobaciones
del mismo contenedor. Para Random, evaluar candidatos indexados y validados
sin materializar toda la biblioteca cada vez.

**Beneficio esperado:** menos disco y serialización, sobre todo con bibliotecas
grandes, fuentes embebidas compartidas y unidades externas. **Riesgo medio:** no
confundir disponibilidad desconocida con archivo desaparecido, no borrar
entradas por una caché y preservar ámbito, distribución y exclusión de Random.

### 2. Portadas: cargar solo lo necesario y acotar su memoria

**Evidencia:** `useLibraryCovers` recorre todos los grupos, aunque solo sean
visibles algunos, y guarda únicamente respuestas con portada. Los grupos sin
imagen se vuelven a consultar al cambiar `tracks`
(`src/hooks/useLibraryCovers.ts:13`). `App` solicita por separado la portada
activa (`src/App.tsx:190`). El backend devuelve base64, con un límite individual
de 2 MiB (`src-tauri/src/library/mod.rs:1669`), no un presupuesto global del
frontend. La colección de loopers no está virtualizada.

**Propuesta:** priorizar portada activa y grupos visibles; caché compartida LRU
por biblioteca/fuente, con respuestas negativas de duración limitada e
invalidación por importación o cambio de portada. Miniaturas para filas y
decodificación diferida de imágenes. Evaluar URLs locales autorizadas en lugar
de base64 si las medidas justifican cambiar el contrato.

**Beneficio esperado:** menor RAM, IPC y trabajo de imágenes. **Riesgo bajo/medio:**
conservar aislamiento por raíz/generación y restricciones de lectura de archivos.
La reducción real de memoria debe incluir imágenes decodificadas, no solo cadenas.

### 3. Unificar consultas de estado sin propagar cada muestra a toda la app

**Evidencia:** `Player` consulta nominalmente cada 250 ms mientras reproduce,
carga o prepara pitch (`src/components/Player.tsx:84`). El diálogo de audio
consulta cada 100 ms (`src/hooks/useAudioRoutingSession.ts:40`). Las esperas de
carga consultan cada 150 ms (`src/randomTrackLoad.ts`, `src/libraryTrackLoad.ts`
y el arranque MIDI en `App`). Algunas de estas rutas pueden coincidir. Las
respuestas actualizan el estado situado en `App`.

**Propuesta:** un coordinador de estado con una sola solicitud pendiente,
cadencia según consumidores y notificaciones selectivas. Mantener fuera de los
renders generales la posición y los niveles de alta frecuencia; estabilizar
props/callbacks y memorizar solo los subárboles cuyo coste se haya medido.

**Beneficio esperado:** menos IPC y renders. **Riesgo medio:** no perder errores
asíncronos, finalizaciones, cambios de generación ni respuesta inmediata a
comandos. No basta con bajar todas las frecuencias o suspenderlas al minimizar.

### 4. Evitar recalcular picos por cambios ajenos al audio

**Evidencia:** `useWaveformPeaks` depende del `refreshKey` general
(`src/hooks/useWaveformPeaks.ts:52`); zoom cambia el número de buckets. La caché
de disco incorpora una ruta canonicalizada y el número exacto de buckets
(`src-tauri/src/waveform.rs:74`). `embedded:<id>` no es un archivo canonicalizable,
de modo que esa ruta no obtiene el beneficio de dicha caché persistente. Un
miss escanea el PCM y solo comprueba obsolescencia al acabar
(`src-tauri/src/player/mod.rs:3869`).

**Propuesta:** invalidar por identidad/revisión del audio, no por cualquier
cambio del catálogo; reutilizar resoluciones de picos o agrupar buckets en
niveles. Para fuentes embebidas, clave que incluya biblioteca, fuente verificada,
sonido y versión del algoritmo. No materializar audio para lograr cachearlo.
Mantener solo la petición más reciente cuando se cambia rápidamente de zoom.

**Beneficio esperado:** menos CPU y E/S al editar metadatos, navegar y hacer
zoom. **Riesgo medio:** evitar cachés de otra biblioteca o audio sustituido y
conservar identidad/generación. La cancelación lógica del frontend no detiene
un cálculo ya invocado en Rust.

### 5. Dibujo de waveform bajo demanda

**Evidencia:** la animación programa un `requestAnimationFrame` continuo y
limita los dibujos a 30 Hz; mientras reproduce se vuelven a dibujar barras,
loop, CUEs y cursor (`src/components/Waveform.tsx:106`, `src/waveformRender.ts`).
Ya evita pintar si no cambian entradas y omite el dibujo cuando el documento
está oculto, pero mantiene la programación del bucle. Una portada superpuesta
no implica `document.hidden`.

**Propuesta:** detener la animación cuando no hay cambios y reactivarla por
estado/resize; suspender la vista cubierta u oculta, sin suspender audio ni
Random. Separar capas estáticas y cursor; al hacer zoom, trasladar/reusar la
imagen donde sea correcto. Medir antes de introducir workers u OffscreenCanvas.

**Beneficio esperado:** menor CPU/GPU y energía durante sesiones largas.
**Riesgo bajo/medio:** preservar posición visual, zoom, edición y actualización
al volver a mostrar la ventana; revisar interpolación también con pitch lock.

### 6. Tablist: no crear una webview por cada búsqueda obsoleta

**Evidencia:** cada consulta entra en `evaluate_in_tablist_webview`, crea una
ventana oculta, espera la página y consulta el resultado por eval
(`src-tauri/src/tablist.rs:157,207`). El debounce de 300 ms y el descarte de
resultados antiguos en `useTablistSearch` no cancelan esas ventanas ya iniciadas.

**Propuesta:** cola de búsqueda acotada, reemplazo de consultas pendientes,
caché breve por consulta/página y cancelación efectiva al abandonar la vista.
Evaluar una sesión web aislada reutilizable con límite e inactividad, o un
transporte autorizado más barato donde el servicio lo permita.

**Beneficio esperado:** menos procesos/CPU/memoria y carga de red durante la
búsqueda. **Riesgo medio:** no dar IPC Tauri a contenido remoto ni eliminar
App Check/reCAPTCHA o validación de respuestas y URLs.

### 7. Eventos de progreso y listas largas

**Evidencia:** BPM ya limita emisiones a 150 ms, con terminales siempre admitidos
(`src-tauri/src/bpm_jobs.rs:14`). Importación emite por etapa/archivo sin ese
filtro general (`src-tauri/src/lib.rs:255`). `useImportJobs` recorre el array de
archivos por evento y el panel los monta todos, aunque el área visible es corta.

**Propuesta:** agrupar actualizaciones intermedias de UI, mantener finales y
errores sin retrasos; indexar archivos y virtualizar el progreso cuando sea
grande. No aplicar un throttle que oculte los eventos usados por los wait helpers.

**Beneficio esperado:** menos renders y DOM durante lotes. **Riesgo bajo/medio.**

### 8. Navegación y observadores de interfaz

**Evidencia:** filtrado y ordenación se recalculan al escribir; el scroll actualiza
estado por evento y los loopers/playlists se montan completos. `useModalFocus`
y `useIdleCover` observan el subárbol del documento y buscan diálogos
(`src/hooks/useModalFocus.ts:60`, `src/hooks/useIdleCover.ts:111`).

**Propuesta:** diferir cálculo de búsquedas extensas, normalizar textos cuando
cambie la pista, actualizar viewport a lo sumo una vez por frame y virtualizar
colecciones si se mide coste. Evitar búsquedas globales de diálogos en mutaciones
irrelevantes o usar un registro común. Mantener foco, inert, accesibilidad,
arrastre y navegación MIDI. Parar solo animaciones decorativas en segundo plano.

**Beneficio esperado:** mejor respuesta de UI; impacto dependiente del catálogo.
**Riesgo bajo/medio.** No volver a virtualizar la lista de pistas: ya lo está.

## Segundo bloque: proteger la respuesta del motor y la memoria

### 9. Prioridad explícita para trabajo interactivo

**Evidencia:** `memory::work_guard` es un mutex global sin clases de prioridad
(`src-tauri/src/memory.rs:17`). Lo usan decode, materialización SWF y WSOLA.
El análisis posterior a decode y el cálculo de picos tienen otros límites y
pueden competir entre sí. El prefetech secuencial y Random se preparan aunque
el temporizador Random no esté habilitado (`src/App.tsx:232`,
`src/components/Sidebar.tsx:371`).

**Propuesta:** admisión acotada por CPU y memoria que favorezca carga explícita
y pitch interactivo frente a precarga y análisis masivo. Comprobar obsolescencia
antes de adquirir el turno y después de esperarlo; cancelación cooperativa donde
el algoritmo la permita. QoS menor para trabajo accesorio, validada por plataforma.

**Beneficio esperado:** controles más predecibles bajo carga. **Riesgo medio/alto:**
no retirar el límite global ni lanzar más workers por defecto. WSOLA no se
interrumpe en mitad de su llamada; no prometer cancelación instantánea. Conservar
la preparación anticipada necesaria para Random en límite de loop.

### 10. Presupuesto total y copias de audio

**Evidencia:** el archivo de entrada puede llegar a 512 MiB. `read_and_decode`
lo retiene en un `Vec`, y `decode_bytes` crea otro con `data.to_vec()` para la
ruta Rodio (`src-tauri/src/player/mod.rs:982,1891`). Pueden coexistir ambos con
PCM. Los topes de caché son independientes: 512 MiB de decodificados, 256 MiB
de contenedores, además de buffers activos, trabajo transitorio e imágenes.
Los topes no equivalen a consumo real ni a reserva global.

**Propuesta:** trasladar propiedad de bytes al decodificador cuando sea posible;
presupuestar antes de leer y contabilizar memoria retenida por trabajos en
espera y `Arc` activos. Un presupuesto global con margen, no sumar cachés como
si fuesen el único uso de RAM. Evitar recortes que provoquen thrashing y recarga
continua de los dos candidatos útiles.

**Beneficio esperado:** menos picos de RAM/swap. **Riesgo medio:** conservar caps,
decodificación completa/gapless, validación de entradas y precisión de recortes.

### 11. Aperturas de base de datos y mantenimiento repetido

**Evidencia:** cada `run_library_blocking` abre `Library::open`
(`src-tauri/src/lib.rs:995`), que adquiere el lock de operaciones, prepara WAL,
comprueba migraciones y recuperaciones (`src-tauri/src/library/mod.rs:347`).
También ocurre al pedir una portada. Algunas operaciones pequeñas de SQLite y
consultas/esperas del motor siguen siendo comandos síncronos.

**Propuesta:** conexiones de worker reutilizables y acotadas por raíz/generación;
separar inicialización/recuperación de lectura ordinaria y agrupar metadatos que
se consultan juntos. Auditar comandos síncronos antes de trasladarlos: el cliente
del motor espera respuesta hasta 30 s (`player/mod.rs:3607`).

**Beneficio esperado:** menos locks, apertura de archivos y latencia de comandos.
**Riesgo medio/alto:** no compartir una conexión SQLite sin su contrato de hilo,
ni saltarse recuperación, WAL, timeout o protección contra cambio de biblioteca.

### 12. Evitar inundar el motor con seek y ajustes de controles

**Evidencia:** cada `mousemove` del scrub puede emitir `playerSeek`
(`src/hooks/usePlayerScrub.ts:25`). Un seek durante reproducción crea un nuevo
sink (`src-tauri/src/player/mod.rs:2374`). Volumen también envía cada cambio del
slider. Los comandos del motor usan un canal no acotado.

**Propuesta:** coalescer movimientos continuos con una sola operación pendiente
y conservar siempre el último valor al soltar. Deduplicar ajustes iguales y
mantener comandos discretos/CUEs inmediatos. La cadencia debe medirse para no
empeorar la sensación de scrub; no convertirlo en un seek solo al soltar.

**Beneficio esperado:** menos colas, recreación de fuentes y E/S de logs.
**Riesgo medio/alto:** sí afecta a la aplicación de controles de audio y necesita
validación nativa, no solo DOM.

## Tercer bloque: cambios delicados, solo con medidas

### 13. Handoff en límite de loop y trabajo del callback

`LoopRegion::next` envía `LoopBoundaryReached` por `std::mpsc` desde la ruta de
generación de muestras (`player/mod.rs:123`); no es una garantía de tiempo real.
El motor completa el intercambio después. No se ha demostrado un corte.

Medir el cambio de fuente y las dependencias Rodio/CPAL antes de considerar
notificación preasignada/no bloqueante, cola de fuentes preparada y liberación
de buffers fuera del callback. No reescribir el motor por una cifra de complejidad.
Es una intervención de **riesgo alto**: preservar sample rate, pares de salida,
gapless, pitch y timing exacto en cada plataforma.

### 14. Logs y mantenimiento fuera del camino urgente

El log realiza canonicalización, apertura, metadatos, escritura y posible rotación
sincrónicas (`src-tauri/src/audio_log.rs:75`). Se usa en rutas de control, no en
el callback normal. El hilo de control comprueba dispositivos y mantiene cachés
aproximadamente cada segundo (`player/mod.rs:2725,2902,3481`).

Evaluar logger acotado y mantenimiento accesorio fuera de comandos urgentes,
conservando fallos críticos y detección de desconexión. No simplemente espaciar
la detección ni eliminar validaciones. Las carreras externas de rotación Unix
documentadas anteriormente no se dan por resueltas. **Riesgo medio/alto.**

## Qué no priorizaría

- Seguir extrayendo funciones solo para bajar la heurística: no reduce por sí
  mismo CPU, RAM o latencia.
- Cambiar React/Tauri o comprimir más un bundle frontend pequeño frente al coste
  observado potencial de imágenes, PCM y webviews. Medir carga inicial antes de
  introducir lazy loading; no desmontar sesiones activas por ocultar un diálogo.
- Bajar calidad de audio, sample rate o precisión de los loops; aumentar buffers
  por defecto para ocultar una regresión; eliminar cachés, prefetch o validaciones
  en bloque; dar prioridad extrema a todos los threads.
- Introducir workers gráficos, índices adicionales o nuevos pools sin demostrar
  primero el cuello de botella y acotar sus recursos.

## Plan de validación antes de afirmar que no afecta al audio

1. Baseline del mismo binario y arquitectura: reposo, playback estable, ventana
   oculta, portada visible, navegación rápida, zoom, scrub, Random, pitch lock,
   importación/reanálisis y búsqueda Tablist. Medir CPU de procesos de app y
   webviews, RAM total, disco, peticiones IPC y renders, no solo el proceso Rust.
2. Catálogos sintéticos pequeños y grandes y fuentes embebidas compartidas;
   archivos reales solo desde fixtures autorizados y nunca en commits. Registrar
   operaciones por acción y latencia p50/p95/p99, además del tiempo medio.
3. Audio: duración máxima y percentiles del callback frente a frames/rate,
   errores/underruns que exponga la plataforma y captura/listening loopback para
   cortes y clicks. A 48 kHz, 128 frames son 2,67 ms y 256 son 5,33 ms: son plazos
   del bloque, no mediciones de oLooper. No hacer logs ni asignar memoria por
   callback para instrumentarlo.
4. Validar mismo contenido/timing, CUE 1, vueltas de loop, cambio Random en
   límite, cancelación, pitch lock, sample rate y canal de salida. Desconexión y
   reconexión de dispositivo, unidades lentas y sesiones largas. Escuchar con
   dispositivo real además de comparar señales: un contador de errores a cero
   no prueba por sí solo ausencia de discontinuidades.
5. Aplicar una familia de cambios cada vez, con pruebas frontend/backend según
   el código afectado y comparación nativa A/B. Ante regresión de continuidad,
   desactivar o revertir solo la optimización propia, no relajar el criterio.

Primera tanda recomendada: **recargas de catálogo, portadas y Tablist acotados,
invalidación correcta de picos y render bajo demanda**. Después unificar estado
y admisión de tareas. El callback y el handoff de audio se revisan al final,
salvo que las mediciones demuestren que son el problema principal.

Comprobación ligera del árbol durante esta revisión: `pnpm run typecheck` y
20 pruebas focalizadas de mapas MIDI/reanálisis BPM pasan. Se corrigió una
comprobación de nulabilidad del refactor MIDI que estaba en curso. No se ha
repetido aquí la suite completa ni se ha validado rendimiento nativo.

## Seguimiento: primera tanda implementada

Se aplicó `specs/300-lightweight-derived-ui.md` y ADR 0029 sin modificar Rust:

- Sidebar persiste historial sin recargar todo el catálogo al reproducir.
- Portadas compartidas, lecturas coalescidas y hasta cuatro IPC activos;
  miniaturas por visibilidad, caché LRU limitada por entradas/caracteres,
  resultados negativos y propiedad de generación/revisión.
- Picos independientes del refresh general, cuatro resoluciones retenidas por
  generación, niveles de buckets estables y una solicitud nativa activa por
  waveform; las vistas en cola sustituidas no llegan a invocarse.
- Dibujo bajo demanda al pausar y suspensión visual al ocultar/cubrir la vista;
  reactivación por estado, CUE, preview, zoom, tamaño y visibilidad. Se corrigió
  solo la interpolación visual respecto a pausa y pitch lock.
- Caché de ocho páginas públicas Tablist durante 30 segundos. No se implementó
  cancelación nativa ni reutilización de la webview de autorización.

Las pruebas cuentan llamadas, límites y frames programados. No se han medido
porcentajes de ahorro ni demostrado continuidad en hardware. Continúan pendientes
la caché persistente para picos embebidos, las capas de dibujo, los cambios de
base de datos/sondeo, las copias PCM y las prioridades del motor, entre los demás
puntos de la revisión. Las extracciones MIDI/BPM previas siguen siendo cambios
de organización, no optimizaciones medidas.

Validación de esta tanda: pasan `pnpm run typecheck`, `pnpm test` (325 pruebas
en 63 archivos), `pnpm run build` y `git diff --check`. No se modificó ni compiló
Rust, no se reconstruyó la app Intel y no se ejecutó una prueba física de audio.
Entre los contratos comprobados con mocks:

- Una reproducción desde Sidebar deja el total de consultas `libraryList` en
  una (la inicial), sin una segunda consulta por guardar historial.
- Dos lectores de la misma portada en vuelo comparten una solicitud.
- Zoom 1→2→1 en una fuente embebida usa dos peticiones nativas; cambiar la
  generación vuelve a solicitar los picos.
- Una vista estática consume un frame y no mantiene otro programado; ocultarla
  o cubrirla cancela el siguiente sin cambiar el estado de reproducción.
- Visitar las páginas Tablist 0→1→0 dentro del TTL hace dos búsquedas, no tres.

## Seguimiento: copias nativas sin cambiar DSP ni callback

Se implementó `specs/310-owned-audio-decode.md` y ADR 0030:

- Los jobs de reproducción/precarga y los sonidos embebidos transfieren el
  vector de bytes al decodificador; la ruta M4A también consume ese vector.
- La API prestada sigue existiendo para importaciones que necesitan conservar
  los bytes; ambas APIs mantienen el guard global y comprueban cancelación antes
  y después de esperar el turno.
- El recorte AAC conserva índices y muestras, pero reutiliza la asignación PCM.
- La caché PCM contabiliza la capacidad del vector, incluida la parte reservada
  tras el recorte, para mantener sus límites sin invalidar el audio activo.
- La conversión MP3 a la misma frecuencia soportada presta las muestras al
  encoder, sin la copia explícita anterior. El remuestreo no se cambia.

Las lecturas ya tenían presupuesto dinámico y validación regular/tamaño antes
de esta tanda; se conservan. No se introdujo un presupuesto global nuevo, ni
prioridad de hilos, ni cambios en el callback, la latencia o los buffers de salida.
Esto elimina copias identificadas, pero no demuestra ahorro total de RAM ni
continuidad en hardware; todavía existen asignaciones internas de codecs y
buffers que deben permanecer vivos.

El recorte AAC evita una segunda asignación PCM completa, pero conserva la
capacidad sobrante del decodificador: puede retener más memoria que el vector
ajustado anterior. La caché cuenta esa reserva y puede conservar menos pistas;
no se fuerza `shrink_to_fit`, que podría realojar el vector. El audio activo
mantiene su propietario independiente de la caché.

Validación final de esta tanda:

- `CARGO_BUILD_JOBS=1 cargo test --offline --manifest-path src-tauri/Cargo.toml -- --test-threads=2`:
  **276 pruebas pasan, cero fallos y cuatro ignoradas** por fixtures externos.
- Las regresiones comprueban PCM exacto WAV mono/estéreo y MP3, cancelación con
  el guard ocupado, límites, orden de muestras AAC y capacidad retenida/evicción
  de caché sin perder el snapshot activo.
- `rustfmt --check --edition 2021 --config skip_children=true` sobre los cuatro
  archivos Rust modificados y `git diff --check` pasan.
- Sin instalaciones, cambios de dependencias ni reconstrucción de la app Intel.
  Las pruebas condicionales sin muestras externas y las ignoradas no acreditan
  validación de esos archivos. No se validó continuidad física de audio.

## Seguimiento: lecturas ligeras de catálogo y Random

Se implementó la tanda de `specs/320-lightweight-catalog-reads.md` y ADR 0031:

- Los listados comparten observaciones positivas/negativas por ruta dentro de
  una sola operación, con 4096 entradas y 512 KiB de texto de rutas como topes.
  Al llenarse se comprueban las rutas no retenidas normalmente. No hay caché de
  disponibilidad entre llamadas ni cambios en la admisión real de reproducción.
- Random consulta pares ID/ruta en su ámbito, sortea candidatos sin reemplazo y
  solo hidrata metadatos después de comprobar una ruta. Las rutas compartidas se
  comprueban una vez mientras quepan en los límites temporales.
- Se conservan exclusión/fallback de la pista actual, peso por pista (no por
  contenedor), rutas virtuales y validación de la fila/ámbito antes de devolverla.
  Las entradas ausentes no se borran y no se toca el handoff de audio.

Los candidatos aún ocupan O(N) IDs/cadenas; con muchas pistas ausentes se puede
recorrer todo el ámbito y consultar entropía por cada intento. No se afirma coste
constante ni mejora universal del peor caso. No se reutilizan conexiones SQLite
ni se cambia el esquema; tampoco se alteran los sondeos, el callback o las
prioridades.

Validación final de esta tanda:

- Suite Rust completa offline, un proceso de compilación y dos hilos de pruebas:
  **291 pasan, cero fallos y cuatro ignoradas** por fixtures externos.
- Quince regresiones nuevas: once de catálogo/Random y cuatro de límites de las
  observaciones temporales. Se comprueban frescura entre llamadas, selección por
  pista, ámbito, fallback, filas cambiadas desde otra conexión y errores.
- Conteos con datos sintéticos: 64 pistas con dos rutas compartidas requieren
  dos comprobaciones; Random entre 256 pistas disponibles comprueba una ruta.
  Treinta y dos pistas de una fuente ausente más la pista actual disponible
  requieren dos comprobaciones y conservan el fallback.
- `rustfmt --check --edition 2021 --config skip_children=true` sobre los tres
  archivos Rust de esta tanda y `git diff --check` pasan. No se reconstruyó la
  app Intel ni se instalaron dependencias; no hay medición nativa A/B de ahorro
  o latencia, ni validación física de continuidad de audio.

## Seguimiento: coordinación de sondeos periódicos de estado

Se implementó la tanda de `specs/330-shared-player-status-polling.md` y ADR 0032:

- Player y el diálogo de audio comparten un flujo de estado sin caché, con una
  sola petición periódica pendiente y sin acumular ticks mientras espera.
- Se conserva el primer sondeo diferido de Player (250 ms) y el inmediato del
  diálogo (100 ms). Después, los consumidores activos reciben el mismo objeto a
  la cadencia más rápida; al cerrar el diálogo queda la cadencia de Player.
- Cada receptor captura propiedad antes de iniciar la petición. Un consumidor
  nuevo no hereda una petición iniciada antes de suscribirse; cierres, reaperturas
  y desmontajes no reciben resultados de suscripciones anteriores.
- Se entregan completos los estados de carga/pitch/salida y sus errores. Los
  fallos transitorios de IPC no detienen los intentos posteriores y no se repite
  un estado anterior como si fuese fresco. No se suspende el sondeo por ocultar
  la ventana y no se cambian los controles ni el handoff de Random.

Alcance deliberadamente parcial: las consultas puntuales, incluida la apertura
del diálogo y las esperas de carga a 150 ms, siguen independientes. No se añadió
un árbitro global de respuestas/comandos ni se separaron posición/niveles de los
renders generales de App. Los conteos de peticiones no prueban ahorro total de
CPU/RAM ni continuidad física de audio.

Validación final de esta tanda: **347 pruebas frontend en 66 archivos** pasan con
`pnpm exec vitest run --maxWorkers=2`, incluidas 22 regresiones nuevas. También
pasan `pnpm run typecheck`, `pnpm run build` y `git diff --check`. La integración
React con IPC simulado comprueba diez lecturas en un segundo de estado compartido,
cuatro tras cerrar el diálogo y cero tras desmontar los consumidores. No se
modificó ni compiló Rust ni se reconstruyó la app Intel. No hubo validación física.

## Seguimiento: cancelación cooperativa de waveform obsoleto

Se implementó la tanda de `specs/340-cooperative-waveform-cancellation.md` y ADR 0033:

- Los misses capturan ruta/generación antes de esperar el mutex de cálculo, sin
  fijar un `Arc` del PCM mientras esperan. Se revalida la propiedad al obtener
  turno y antes de clonar el buffer; una recarga de la misma ruta no se adopta
  silenciosamente como si fuese la petición anterior.
- El cálculo comprueba obsolescencia antes, durante y después del recorrido.
  Entre oportunidades de comprobación hay hasta 65.536 frames visitados, con
  presupuesto compartido entre buckets y sin locks por muestra/bucket.
- Las comprobaciones intermedias usan `try_read`: no esperan a un escritor del
  snapshot ni confunden contención con cambio de pista. La validación final
  estricta antes de guardar/devolver permanece.
- Se conserva el algoritmo de picos, sus límites y versión de caché, y el hit de
  disco sin lock del motor. No se materializan fuentes embebidas ni se cambia el
  audio, el callback, el handoff o las prioridades.

No es cancelación instantánea: se observa el snapshot publicado, no la mera
petición de cargar otra pista; las comprobaciones contencionadas pueden saltarse
y la espera del mutex no se interrumpe. Tampoco se cancela nativamente por zoom
o desmontaje de vista. La caché persistente embebida y los riesgos de identidad/
filesystem de la caché siguen aparte. Los checks añaden coste a los cálculos que
siguen vigentes; no se afirma ahorro porcentual ni continuidad física.

Validación final de esta tanda:

- El primer intento offline focalizado agotó 240 segundos durante la compilación,
  sin ejecutar pruebas. No se atribuye ningún resultado de pruebas a ese intento.
  No quedaron compiladores activos ni hubo falta de espacio (unos 27 GiB libres).
- El reintento completo con un proceso de compilación y dos hilos de pruebas
  terminó correctamente: **301 pruebas pasan, cero fallos y cuatro ignoradas**
  por fixtures externos. Pasan las diez regresiones nuevas.
- Se comparan los bits de los picos con una referencia independiente del algoritmo
  v2, incluidos layouts y resoluciones extremas y recorridos entre checkpoints.
  Se comprueban cancelación, propiedad sin retener PCM en cola, contención y el
  hit de caché sin lock del snapshot.
- Formato de los cuatro archivos Rust y `git diff --check` correctos. Sin nuevas
  dependencias, instalaciones ni reconstrucción de la app Intel. No hay validación
  física de audio ni medición de porcentajes de ahorro.
