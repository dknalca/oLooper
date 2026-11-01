# Línea base de calidad de código — 2026-10-29

## Alcance y criterios

Esta es una línea base exploratoria del árbol de trabajo, con cambios sin commit;
no es una puntuación global, una comparación frente a otros productos ni una
auditoría exhaustiva línea por línea. Combina inventario, complejidad orientativa,
pruebas existentes y lectura focalizada de importación y persistencia. Un tamaño
o complejidad altos indican dónde revisar, no demuestran por sí mismos un defecto.

Como referencias se pueden utilizar las [métricas de SonarQube](https://docs.sonarsource.com/sonarqube-server/user-guide/code-metrics/metrics-definition/)
y el modelo de calidad de producto [ISO/IEC 25010:2023](https://www.iso.org/standard/78176.html).
No se ejecutó SonarQube ni se evaluó conformidad con ISO; esta medición no produce
una calificación Sonar ni certifica seguridad, fiabilidad o accesibilidad.

## Inventario reproducible

Ejecutar `pnpm run quality:baseline` después de instalar las dependencias del
proyecto. `scripts/quality-baseline.mjs` usa TypeScript 5.9.3 del lockfile y
analiza 37 archivos `.ts`/`.tsx` de producción en `src/`, excluyendo archivos
`.test`, `.spec` y `.d`. Cuenta líneas físicas, incluso comentarios y espacios.
Lista también 36 archivos Rust y su tamaño, incluidas pruebas. El cálculo de
frontend es **una heurística propia**, no complejidad cognitiva Sonar: parte de 1
y suma `if`, ternarios, bucles, `case`, `catch` y operadores `&&`, `||` y `??`.
Cada función o callback se cuenta por separado; sus funciones anidadas no se
agregan al padre. La presencia de JSX, lógica de presentación, callbacks y
guardas puede inflar o dividir artificialmente las cifras. Un umbral de 15 se
usa solo para localizar candidatos, no como regla de aprobado.

- 1.153 funciones/callbacks reconocidos; 28 con más de 15 según esa heurística.
- `Sidebar.tsx`: 1.742 líneas físicas; función principal, 96 decisiones
  estimadas. `Player.tsx`: 648 líneas; componente principal, 56. Son puntos de
  inspección, no errores ni valores comparables entre sí sin leerlos.
- Rust: `player/mod.rs` 3.968 líneas, `library/mod.rs` 3.475 y `serato.rs` 2.800;
  algunas pruebas viven dentro de archivos de producción.

Para un segundo indicador se ejecutó **Lizard 1.24.3** temporalmente, sin añadirlo
como dependencia del proyecto:

```sh
python3 -m pip install --target /ruta/temporal/lizard 'lizard==1.24.3'
PYTHONPATH=/ruta/temporal/lizard python3 -m lizard -l rust -x '*test*' --csv src-tauri/src > rust-quality.csv
```

La ejecución identificó 701 funciones y 37 con complejidad ciclomática superior
a 15. El filtro excluye rutas que contienen `test`, pero **no** módulos de test
embebidos; macros y sintaxis Rust pueden no reflejarse perfectamente. Entre los
primeros resultados: `import_sounds_with_cover_and_progress_mode` (50),
`convert_wav_to_mp3_320` (46) y `rewrite_wave_id3_tag` (40). Son estimaciones de
Lizard, no comparables directamente con la heurística TS. La cifra de importación
aumentó al añadir explícitamente gestión de fallos: una puntuación menor no debe
incentivar la eliminación de protecciones.

La misma versión de Lizard falló al analizar `src/components/TopBar.tsx`, por lo
que no se utilizan sus cifras para TypeScript/TSX ni se activa como puerta CI.
La cobertura de líneas/ramas y la duplicación global **no se han medido**; el
número de tests no es un porcentaje de cobertura. No se instala un servicio de
terceros ni se sube código. No hay pruebas de rendimiento, fuzzing o de ejecución
de sistemas externos en esta medición.

## Hallazgo y corrección focalizada

En la función Rust de importación se revisaron los límites entre creación del
audio y confirmación en SQLite. Si el callback de progreso entraba en pánico
después de crear el archivo, pero antes de iniciar la inserción, el informe de
error se generaba sin retirar ese archivo sin registrar. Se intenta limpiar ahora
en ese punto tanto para errores como para pánicos; una regresión comprueba que el
catálogo queda vacío y no se deja audio en la carpeta gestionada cuando el
filesystem permite retirarlo. Un error de limpieza aún podría dejar el archivo.
Después de
iniciar la inserción no se presume que la pista no se haya confirmado.

El código de `ImportBar.tsx` repite ramificaciones de importación por menú y
arrastre; es una oportunidad de extracción con pruebas de cancelación, reportes
parciales y propiedad de biblioteca antes de modificar ese flujo. También se
recomienda separar gradualmente responsabilidades de `Sidebar`, del worker y de
Serato; no mover código de audio o recuperación solo para bajar el contador.

### Seguimiento: importación mixta

Se extrajo a `src/mixedImport.ts` el recorrido compartido por menú y arrastre:
selección de importador, procesamiento secuencial, contadores, errores y
cancelación. El componente mantiene la propiedad del job, la presentación y las
opciones de importación; se preservan los mensajes específicos de ambas entradas.
Pruebas unitarias y de interfaz cubren SWF/EXE/audio, selección de opciones,
errores parciales y cancelación con pistas ya guardadas. El inventario posterior
sitúa `ImportBar.tsx` en 644 líneas frente a 713 en la medición anterior; parte
de esa lógica se trasladó a un módulo nuevo, no desapareció. La heurística ya no
señala `importFromMenu` entre sus 20 funciones con más decisiones. No implica
que se hayan reducido todas las rutas de ejecución o eliminado todos los riesgos.

### Seguimiento: atajos y Random temporizado

En `src/hooks/useKeyboardShortcuts.ts` se separaron el bloqueo por foco o
modificadores, los CUEs, la navegación y el transporte. Las pruebas verifican
eventos, límites del seek, estado descargado, foco, serialización y recuperación
ante errores. En `src/randomPlayback.ts` se aisló la comprobación de cambios que
invalidan una transición preparada; las regresiones prueban cada ajuste del
loop, cambios de pista y consultas de posición. No cambia la propiedad del
endpoint nativo ni las decisiones de cancelación.

En el inventario posterior, el manejador de teclado y `updatePlayback` ya no
aparecen entre los 20 primeros resultados (antes marcaban 30 y 19 decisiones
respectivamente); el total de funciones/callbacks por encima del umbral
orientativo pasó de 26 a 24. La lógica se distribuyó en unidades más enfocadas:
no se afirma que el número de rutas totales haya disminuido.

### Seguimiento: contenedores y reescaneo

Se extrajeron a `src/containerImport.ts` la acumulación de resultados para
importaciones de contenedores y la del reescaneo de carpetas. Ambas conservan
procesamiento secuencial, cancelación y parada ante cambio de biblioteca cuando
corresponde. Sus reglas de recuento de fallos siguen siendo distintas; no se
unificaron para evitar modificar los mensajes de la interfaz. Las pruebas cubren
resultados parciales, parada y continuidad, además de ambos flujos en la UI.

La heurística de `browseAndImport` baja de 28 a 22 decisiones y `ImportBar.tsx`
pasa de 644 a 611 líneas; parte del código reside ahora en el nuevo módulo. El
total de funciones por encima del umbral sigue en 22: se ha aislado lógica, no
se ha demostrado una reducción equivalente de todas las rutas posibles.

### Seguimiento: metadatos y preferencias de audio

La preparación del borrador de metadatos se separó del guardado asíncrono en
`src/trackMetadata.ts`, conservando la distinción entre BPM sin cambios y BPM
confirmado manualmente. Se añadieron pruebas de límites, campos vacíos y
resultados tardíos tras cambiar de biblioteca, tanto para éxito como para error.
En `src/audioOutputPreferences.ts` se separó la lectura de almacenamiento de la
validación de la selección y sus valores opcionales; se cubren pares y entradas
inválidas. Ambas funciones originales salen de los 20 primeros resultados del
inventario; el número por encima del umbral orientativo baja de 24 a 22. Estas
medidas no equivalen a cobertura ni a una evaluación formal de calidad.

### Seguimiento: catálogo Tablist

`src/tablistCatalog.ts` reúne la normalización de rutas para recuentos, la
comprobación de descarga completa y la búsqueda de un looper aleatorio a través
de páginas. El componente sigue gestionando la interfaz, el estado ocupado y el
job de importación. Nuevas pruebas cubren rutas, recuentos, páginas con vuelta
al inicio, catálogo vacío, errores y descarga aleatoria mediante la interfaz,
sin acceder a red. La normalización es solo para comparar recuentos, no una
validación de seguridad de URL.

`TablistCatalog.tsx` pasa de 385 a 344 líneas, con lógica trasladada al módulo
nuevo. La heurística del componente principal permanece en 33 y el total de
funciones por encima del umbral sigue en 22; no se atribuye a esta extracción una
mejora global de complejidad ni una reducción demostrada de riesgos de red.

### Seguimiento: mapas MIDI

En `src/midiMaps.ts` se separaron la validación de cada asignación, la detección
de controles duplicados, la lectura de presets guardados y la recuperación del
formato anterior. Las pruebas cubren colisiones de controles, límites de canal y
número, campos de dispositivo, recuperación desde almacenamiento corrupto y el
límite del archivo medido en bytes UTF-8. Los mapas portátiles siguen sin guardar
identificadores locales; estas pruebas no sustituyen la ejecución con hardware.

El analizador local ya no sitúa `parseBindings` entre los 20 primeros; el número
de funciones sobre el umbral orientativo pasa de 22 a 20. La validación se ha
distribuido en funciones más pequeñas: la cifra no demuestra ausencia de fallos.

### Seguimiento: geometría de portada y mensajes de importación

`src/coverGeometry.ts` separa el ajuste de la imagen al viewport y el cálculo
del destino de animación; el overlay mantiene la secuencia y la limpieza de
animaciones. Se prueban proporciones horizontales y verticales, centrado y
ausencia de origen válido. Esto no valida la animación ni el click tardío en
WebKit real.

`containerImportMessages` aísla la prioridad de fallos, sonidos omitidos y
cancelación al presentar un informe parcial. Hay pruebas de las combinaciones y
las pruebas existentes de interfaz siguen cubriendo la importación. La heurística
de `browseAndImport` pasa de 22 a 16 decisiones; el total sobre el umbral sigue
en 20. Las rutas y mensajes se conservan, no se han eliminado las condiciones.

### Seguimiento: carga de pistas de biblioteca

`src/libraryTrackLoad.ts` aísla la espera de carga, el timeout y la validación de
ruta respecto de las actualizaciones visuales de `Sidebar`. La selección comprueba
tanto su secuencia como la biblioteca propietaria, incluido el paso asíncrono de
entrega del resultado. Las pruebas cubren polling, timeout, fallo de decodificación,
selecciones superadas y cambio de biblioteca con ID y ruta iguales. No cambia el
protocolo del motor ni demuestra ejecución en dispositivos físicos.

La función `playTrack` deja de aparecer entre los 20 primeros resultados de la
heurística y el número por encima del umbral orientativo baja de 20 a 19; la
espera extraída sigue conteniendo las comprobaciones necesarias.

### Seguimiento: los tres componentes de mayor tamaño decisional

- `Sidebar`: los estados vacíos y la confirmación visual de eliminación se
  movieron a `LibraryEmptyState` y `DeleteLooperDialog`. El catálogo, arrastre,
  estado de selección y eliminación real siguen en `Sidebar`. Las pruebas
  verifican mensajes, acciones y que la eliminación requiere confirmación.
- `Player`: `CueControls` y `PlayerAudioControls` presentan los controles de
  CUE, volumen y velocidad. Las operaciones nativas, comprobaciones de propiedad
  y gestión de errores permanecen en `Player`. Se prueban límites de pitch,
  CUE 1 fijo, fuentes embebidas, sincronización y llamadas del componente padre.
- `AudioSettingsDialog`: `audioDeviceOptions` calcula capacidades y
  `AudioOutputControls` presenta frecuencia, buffer, pares y disponibilidad. El
  diálogo conserva el cambio real de ruta, la persistencia y el control del test
  L/R. Las pruebas cubren aplicación, fallo, cambio de dispositivo y valores
  guardados no admitidos.

La heurística de las funciones principales pasó de 96/56/50 a 82/48/27,
respectivamente. El número total de funciones por encima del umbral pasó de 19
a 20 porque la lógica se ha repartido en nuevas unidades; no se deduce que se
hayan reducido todas las rutas ni que estén revisados todos los comportamientos.
Las pruebas DOM simuladas no prueban WebKit, hardware de audio o MIDI.

### Seguimiento: segunda pasada de componentes principales

Se separaron las opciones de filtrado/reanálisis de biblioteca en
`LibraryTrackToolbar`, los controles visuales de Random en
`RandomPlaybackControls`, y la cabecera y filas del catálogo en
`TablistCatalogHeader`/`TablistLooperRow`. `Sidebar` conserva los filtros y el
catálogo; `Player` conserva el temporizador; `TablistCatalog` conserva búsquedas,
cancelación y propiedad de importaciones. Las pruebas cubren ámbitos de BPM,
intervalos Random, selección de catálogo, eventos y resultados asíncronos
obsoletos. Las comprobaciones no sustituyen pruebas en WebKit o dispositivos.

En la heurística local las funciones principales `Sidebar`, `Player` y
`TablistCatalog` pasan de 82/48/33 a 77/41/20 decisiones, respectivamente, y
el número de funciones/callbacks sobre el umbral orientativo pasa de 20 a 19.
Son comparaciones de componentes individuales; parte de la lógica se ha movido,
no se ha demostrado una reducción equivalente de las rutas totales.

### Seguimiento: cabecera, editor de loop y estado de portada

`LibraryTrackHeader` presenta las columnas y delega la ordenación a `Sidebar`;
se comprueban orden alfabético, BPM ascendente/descendente y orden de playlist.
`LoopEditingControls` presenta el editor sin asumir la propiedad de sus refs,
el borrador ni los comandos nativos, que permanecen en `Player`. Las pruebas
comprueban también que un campo con foco conserve su borrador al llegar estado.

`src/idleCoverState.ts` separa la pertenencia de la portada y las reglas de
entrada/permanencia del hook y de la animación. Se probaron biblioteca y ruta
propietarias, carga, error, pausa y cambio pendiente con datos sintéticos; no se
modificaron los eventos de despertar ni se validó WebKit nativo.

La heurística de `Sidebar` y `Player` pasa de 77/41 a 68/38. La condición de
portada, antes incluida en `IdleCoverScreensaver` (33), está ahora en funciones
separadas; `idleCoverEligibility` marca 21. El número de funciones/callbacks
por encima del umbral orientativo sigue en 19, no es evidencia de una reducción
equivalente del número total de rutas ni de ausencia de errores.

### Seguimiento: ciclos de vida de biblioteca y reproducción

`useLibraryFilters` conserva y persiste las opciones de filtrado;
`useLibraryCovers` agrupa la caché, los límites de concurrencia y la cancelación
de cargas de portadas. `useRandomPlayback` reúne el temporizador Random y su
suscripción; `PlayerScrubBar` y `usePlayerScrub` agrupan el control de posición,
el teclado y el ciclo de vida del arrastre. Las pruebas comprueban la limpieza
de eventos, el cambio de propietario durante el arrastre, los límites de teclado,
la persistencia de filtros y las cargas de portada canceladas o fallidas.

En esta pasada la heurística de `Sidebar`/`Player` pasa de 68/38 a 65/28.
**El objetivo de menos de 20 en cada función sigue pendiente**. El medidor
excluye funciones anidadas: extraer un efecto completo puede mejorar su
organización sin cambiar la cifra del componente. Tampoco suma la complejidad
trasladada a los nuevos hooks o componentes.

### Seguimiento: CUEs, editor de loop y vista del catálogo

`usePlayerCues` reúne lectura y escritura de marcadores, sincronización Serato y
atajos; `usePlayerLoopEditor` reúne el borrador y el análisis de loop. Ambos
utilizan la misma propiedad de pista/generación que el reproductor. Se añadieron
pruebas para lecturas y sincronizaciones tardías, restricciones de CUEs
embebidos y análisis de loop al cambiar de pista.

`src/libraryTrackView.ts` reúne filtrado, ordenación y agrupación del catálogo;
las pruebas fijan el orden de playlists, el orden guardado de loopers y los
límites existentes de filtros. En particular, los filtros «mid» actuales usan
un límite superior, no un intervalo exclusivo: este refactor no lo cambia.

La heurística local de las funciones principales continúa en 65/28, ya que
excluye las funciones y efectos anidados extraídos; su longitud pasa de
1526/331 a 1491/173 líneas. El objetivo orientativo de menos de 20 sigue sin
alcanzarse y estas cifras no representan la complejidad total de los flujos.

### Seguimiento: opciones de audio e importación

`AudioSettingsDialog` delega la sesión de enrutamiento y el sondeo de niveles a
`useAudioRoutingSession`, la prueba de canales a `useAudioOutputTest` y la
presentación de niveles a `AudioOutputMeter`. La aplicación de la configuración
permanece en el diálogo. Las pruebas cubren parada/reanudación, errores de prueba,
temporizadores y sondeos que terminan tras cerrar.

`ImportBar` comparte el procesamiento de selecciones mixtas y delega identidad,
cancelación, suscripción y progreso a `useImportJobs`; `ImportProgressPanel` es
solo presentación. Las pruebas cubren eventos de otros trabajos, finalizaciones
fuera de orden, cancelación, liberación tardía de suscripciones y cancelación del
diálogo. La espera de los trabajos sigue usando los helpers que se suscriben
antes de encolar. El foco se comprobó en DOM simulado, no en WebKit nativo.

La heurística local de `AudioSettingsDialog` pasa de 27 a 23 decisiones y la de
`ImportBar` de 24 a 18; sus funciones pasan de 291/542 a 184/421 líneas. Parte
de la lógica se ha trasladado a hooks y vistas con sus propias decisiones; estas
cifras no miden la complejidad total ni garantizan comportamiento en hardware.

### Seguimiento: App y forma de onda

El despacho MIDI vive en `src/midiActions.ts`; `src/randomTrackLoad.ts` reúne la
selección Random y la espera de carga, conservando la generación compartida y
la cancelación de cambios en el límite del loop. `App` sigue siendo responsable
de las suscripciones MIDI, la precarga y la confirmación de la pista activa.
Las pruebas cubren acciones MIDI, candidatos precargados, selecciones obsoletas,
cancelación y rutas de reproducción que no coinciden.

`useWaveformPeaks` conserva la carga demorada y el descarte de resultados
obsoletos; `src/waveformRender.ts` aísla el dibujo y la geometría de zoom.
`Waveform` sigue controlando la interacción y la pertenencia de los picos a la
pista. Se añadieron pruebas de respuestas tardías, posición de CUEs y límites de
loop, además de arrastre de bordes sobre DOM simulado.

El archivo `App.tsx` pasa de 761 a 667 líneas y `Waveform` de 379 a 337 líneas
en su función principal. La heurística de `Waveform` sigue en 20; las funciones
extraídas de MIDI, carga Random y dibujo marcan 25, 24 y 21. Se han separado
responsabilidades, no eliminado sus decisiones. Estas pruebas no validan MIDI,
audio o renderizado con hardware ni WebKit nativo.

### Seguimiento: TopBar y catálogo Tablist

`MetronomeControls` reúne los controles, comandos, evento MIDI y temporizador
visual del metrónomo, sin asumir la inicialización de biblioteca ni el reloj de
práctica. Las pruebas cubren validación de BPM, cambios de pista, errores nativos
y limpieza del evento. `useTablistSearch` separa búsquedas y recuentos del
catálogo; `useTablistImport` mantiene la propiedad, progreso y cancelación de los
trabajos, conservando el helper de espera que se suscribe antes de encolar. Las
pruebas incluyen recuentos obsoletos y eventos de otros trabajos.

La heurística local de `TopBar` pasa de 20 a 10 decisiones y la de
`TablistCatalog` permanece en 20; sus funciones pasan de 298/236 a 193/122
líneas. Los efectos y callbacks anidados no se incluyen en la cifra del padre y
las decisiones extraídas siguen existiendo. La cobertura simulada no sustituye
pruebas en WebKit, con dispositivos MIDI ni con audio real.

## Verificación y límites

- 271 pruebas Rust correctas y cuatro ignoradas por fixtures; 119 frontend.
- Typecheck, Clippy estricto y ejecución del inventario correctos en macOS Intel.
- Las pruebas con fixtures opcionales pueden retornar sin ejercitar el fixture.
  Las pruebas locales no verifican Windows, Apple Silicon nativo, WebKit real,
  dispositivos, accesibilidad ni sesiones largas. Node local 22 no cumple el
  requisito Node 24 del proyecto.
- Las carreras externas de Serato/log y el aviso de compilación de Tauri siguen
  abiertos según [la remediación anterior](audit-remediation-2026-10-29.md).
