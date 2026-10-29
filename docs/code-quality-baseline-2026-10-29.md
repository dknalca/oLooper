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

## Verificación y límites

- 271 pruebas Rust correctas y cuatro ignoradas por fixtures; 119 frontend.
- Typecheck, Clippy estricto y ejecución del inventario correctos en macOS Intel.
- Las pruebas con fixtures opcionales pueden retornar sin ejercitar el fixture.
  Las pruebas locales no verifican Windows, Apple Silicon nativo, WebKit real,
  dispositivos, accesibilidad ni sesiones largas. Node local 22 no cumple el
  requisito Node 24 del proyecto.
- Las carreras externas de Serato/log y el aviso de compilación de Tauri siguen
  abiertos según [la remediación anterior](audit-remediation-2026-10-29.md).
