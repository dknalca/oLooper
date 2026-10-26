# 260 — BPM de loops por duración y corrección mitad/doble

- Estado: implementado; procedencia/persistencia BPM corregidas antes de v0.8.0
  (véase `docs/release-0.8.0.md`). Pendiente calibración con loops reales del
  usuario y validación manual en dispositivos.
- Fecha: 2026-10-25.
- Relacionado: specs 010 (biblioteca), 020 (SWF), 095 (importación), 130 (Serato),
  190 (Tap tempo) y 200 (hardening).

## 1. Petición y objetivo

El detector actual funciona mal con algunos loops. Son fragmentos preparados
para repetir perfectamente y normalmente están en **4/4**: su duración debe ser
la base del cálculo del tempo, en lugar de depender solo de los golpes detectados.

Al abrir **Edit metadata**, el usuario debe poder escoger entre:

- El tempo sugerido: **×1**.
- Su mitad: **÷2**.
- Su doble: **×2**.

Un **doble clic sobre la celda BPM de la biblioteca** abrirá este mismo editor,
enfocado en el tempo, sin iniciar reproducción. Además habrá reanálisis por
looper, lista o biblioteca completa, detallado en la
[spec 270](270-batch-bpm-reanalysis.md).

Solo se ofrecerán valores que tengan sentido musical y estén dentro del rango
admitido. La elección se confirma al guardar y no cambia la velocidad del audio.

### Estado de esta pasada

- `analysis::estimate_with_context` distingue `GeneralAudio` y `PerfectLoop4_4`.
- `analysis_loop.rs` genera candidatos exactos por duración entre 20 y 300 BPM,
  agrupa familias mitad/doble y usa evidencia rítmica centrada por canal.
- Tres ventanas de hasta 16 segundos acotan memoria y trabajo de correlación;
  la duración para generar candidatos sigue siendo la del loop completo.
- La preferencia por compases potencia de dos es 0,08 de puntuación, sin elevar
  confianza. La ambigüedad de octava limita la confianza a 0,49. Son heurísticas
  probadas con señales sintéticas, todavía no calibradas con una colección real.
- Un loop no silencioso sin ataques periódicos todavía puede recibir una
  sugerencia por duración con confianza máxima 0,2; el silencio no genera BPM.
- SWF/EXE usan el modo de loop después del recorte canónico. Tablist lo utiliza
  cuando falta BPM de catálogo; un valor conocido se conserva sin analizarlo.
- Las importaciones custom y AUTO sin BPM conocido conservan el modo genérico;
  el reanálisis explícito de biblioteca sí aplica la hipótesis de loop 4/4 a las
  pistas custom incluidas.
- La matriz sintética cubre 100 combinaciones de tempo, sample rate y número de
  compases, además de estéreo en oposición de fase, frases de tres/cinco compases,
  ruido, silencio y ambigüedad. Falta comparación con loops reales del usuario.
- `library_analyze_bpm` y `libraryAnalyzeBpm` consultan el detector por ID sin
  modificar catálogo, tags, región de práctica ni reproducción. Solo una
  previsualización puede retener PCM a la vez; si está ocupada se ofrece reintento.
- El DTO incluye `bars`, derivado del candidato de duración antes de redondear la
  presentación. `bpmOptions.ts` filtra 20–300 antes de redondear y comprueba
  compases completos usando ese conteo, evitando rechazar tempos decimales por
  el redondeo de una décima del detector.
- El editor ofrece Half/Detected/Double (o Current/Entered/Tapped), con base
  estable. Una respuesta tardía no cambia el borrador ni una base ya elegida.
- Doble clic sobre BPM o `--` abre el editor enfocado en BPM; clic simple conserva
  selección y Enter/Espacio en el control dan acceso equivalente. Doble clic en
  el título mantiene la reproducción habitual; el BPM no inicia arrastre.
- Elegir una opción, incluso ×1 sin cambio numérico, confirma manualmente al
  guardar. Cancelar y consultar no escriben nada. Un guardado sin confirmación de
  BPM conserva el valor más reciente del catálogo, aunque el borrador sea anterior
  a un reanálisis concurrente, y no dispara sincronización Serato de BPM.
- Sigue abierto el conflicto entre BPM automático/protegido y etiquetas file-authored
  descrito en el follow-up de auditoría; validar y corregir esa precedencia antes
  de considerar cerrado el flujo Serato/reanálisis.
- Regresiones de editor y foco en `SidebarBpmEditor.test.tsx`,
  `bpmOptions.test.ts` y `useModalFocus.test.tsx`; la prueba IPC verifica duración
  completa, DTO, ausencia de escrituras y reproducción intacta al previsualizar.

## 2. Matemática que debe entenderse antes de programar

En 4/4 cada compás contiene cuatro pulsos de negra. Si conocemos el número de
compases del loop y su duración:

```text
duración_segundos = frames_PCM / sample_rate
pulsos = compases * 4
BPM = 60 * pulsos / duración_segundos
    = 240 * compases / duración_segundos
```

`frames` no significa número total de muestras intercaladas: en estéreo, dos
muestras, una por canal, forman un frame. Usar `LoopBuffer::frames()`.

Ejemplos exactos:

| Duración | Compases | Pulsos | BPM | Mitad / doble |
| --- | ---: | ---: | ---: | --- |
| 2 s | 1 | 4 | 120 | 60 / 240 |
| 4 s | 2 | 8 | 120 | 60 / 240 |
| 8 s | 4 | 16 | 120 | 60 / 240 |
| 9,6 s | 4 | 16 | 100 | 50 / 200 |
| 10⅔ s | 4 | 16 | 90 | 45 / 180 |
| 7,5 s | 4 | 16 | 128 | 64 / 256 |

La última columna muestra las variantes numéricas; antes de ofrecerlas en el
editor hay que filtrar rango y compatibilidad de compases según la sección 7.

### Límite de lo que permite deducir la duración

La duración **no identifica por sí sola el número de compases**. Ocho segundos
también pueden ser dos compases a 60 BPM o ocho a 240 BPM. Además, si admitimos
frases de tres o cinco compases, pueden ser 90 o 150 BPM. No prometer que toda
ambigüedad posible es exclusivamente mitad/doble.

Para la primera versión se propone priorizar frases habituales de
`1, 2, 4, 8, 16, 32, ...` compases, manteniendo evidencia rítmica para distinguir
familias no relacionadas por octavas. Esto es una hipótesis musical, no una
prueba. Si faltan evidencias, mostrar baja confianza y permitir corrección manual.

## 3. Estado actual y archivos que hay que leer

| Archivo | Responsabilidad actual / cambio previsto |
| --- | --- |
| `src-tauri/src/analysis.rs` | `estimate(&LoopBuffer) -> Option<BpmEstimate>` calcula envolvente de energía y autocorrelación. Busca 60–200 BPM y normaliza después a 65–150. Añadir el modo de loop 4/4 sin romper el análisis genérico. |
| `src-tauri/src/analysis_tests.rs` | Pruebas sintéticas del detector. Añadir loops con duración exacta y casos ambiguos. |
| `src-tauri/src/library/mod.rs` | `prepare_sound` analiza SWF/EXE después del recorte MP3; otros caminos analizan audio custom y Tablist. Integra estimación y persistencia. |
| `src-tauri/src/library/tests.rs` | Regresiones de importación, BPM manual y persistencia. |
| `src-tauri/src/autoloop.rs` | `suggest` usa `analysis::estimate` cuando no hay BPM conocido. No debe asumir que cualquier audio completo es ya un loop perfecto. |
| `src-tauri/src/lib.rs` | Registro de comandos y captura de biblioteca para trabajo pesado fuera del hilo IPC. |
| `src/tauri.ts` | DTO `Track`, `libraryUpdateMetadata` y wrappers IPC. Aquí se añade cualquier nuevo contrato de análisis. |
| `src/components/Sidebar.tsx` | `editTrack`, `metadataDraft`, `bpmConfirmed`, `saveTrackMetadata`, diálogo de metadatos y Tap tempo. Aquí van las opciones ×1/÷2/×2. |
| `src/components/Sidebar.test.tsx` | Pruebas del editor y de respuestas tardías. |
| `src/tapTempo.ts` | Mantener el funcionamiento existente de Tap tempo. |

Puntos delicados del código actual:

- `BpmEstimate` tiene `bpm` y `confidence`.
- El rango de BPM que aceptan metadatos y backend es **20–300**, distinto del
  rango preferente automático 65–150. Un 60 o un 240 elegido manualmente es válido.
- La advertencia de revisión usa confianza `< 0.5` en Sidebar.
- `bpm_source = 'manual'` protege una elección confirmada; no debe desaparecer por
  reanalizar, importar, cambiar el título o sincronizar metadatos.
- El editor ya envía `confirmManualBpm`; Tap tempo ya marca `bpmConfirmed`.
- Las pistas embebidas no admiten escrituras de tags en el SWF/EXE.

## 4. Duración de entrada: usar la que realmente se repite

1. Trabajar con el buffer PCM canónico que se reproduce, a velocidad 100 %.
2. Calcular segundos desde frames y sample rate, no desde `duration_ms` redondeado
   ni desde el tamaño del MP3 o la duración del contenedor SWF/EXE.
3. Para SWF/EXE, analizar después del recorte MP3 existente, respetando
   `seek_samples` firmado y `sample_count`. Mantener la misma duración en modo
   extraído y embebido.
4. Para M4A/AAC, comprobar el tratamiento actual de padding/recorte: importación,
   reanálisis y reproducción deben usar los mismos límites canónicos. Añadir una
   regresión si actualmente divergen. No recortar silencios arbitrariamente.
5. No usar la selección AUTO/manual de práctica como duración del archivo original
   ni recalcular el BPM guardado al cambiar esa región.
6. Cambiar la velocidad del reproductor no modifica el BPM de metadatos.

Rechazar entradas sin frames, sample rate cero, duración no finita, silencio y
buffers inválidos. Mantener límites de duración/PCM, cancelación y compuerta de
memoria existentes; no decodificar el mismo audio varias veces para comparar BPM.

## 5. Detector, por etapas

### 5.1 Separar contexto de loop y audio genérico

Mantener el análisis genérico para audios que podrían ser canciones o fragmentos
no cerrados. Propuesta de API interna nueva:

```rust
enum TempoContext {
    GeneralAudio,
    PerfectLoop4_4,
}

// API implementada; estimate conserva el envoltorio de análisis genérico.
fn estimate_with_context(
    buffer: &LoopBuffer,
    context: TempoContext,
) -> Option<BpmEstimate>;
```

Conservar `estimate` como envoltorio del modo genérico para los consumidores que
no garanticen un loop. Pasar contexto de loop en SWF/EXE y loops de Tablist;
para custom audio, proponer el modo de loop si el flujo lo garantiza y dejar el
genérico cuando no lo garantice. Confirmar esta política antes de implementar;
no inferir el compás únicamente por la extensión del archivo.

### 5.2 Generar candidatos a partir de la duración

Para un loop 4/4:

```text
D = frames / sample_rate
compases_min = max(1, ceil(20 * D / 240))
compases_max = floor(300 * D / 240)

para cada entero M en ese intervalo:
    candidato.bpm = 240 * M / D
    candidato.compases = M
    candidato.frase_habitual = M es potencia de dos
```

Acotar el número de candidatos usando la duración máxima admitida de la app. No
aceptar una longitud arbitraria que produzca un bucle o reserva sin límite.
Rechazar candidatos no finitos o fuera de 20–300 **antes** de redondear.

Conservar precisión `f64` durante el cálculo. Redondear a una décima al presentar
o al construir el resultado público, no convertir todo a un entero. No forzar un
BPM entero solo porque los loops suelen estar bien cortados.

### 5.3 Clasificar con el ritmo, sin devolver el valor impreciso anterior

Reutilizar la envolvente de ataques y la autocorrelación como evidencia para
**elegir entre los candidatos exactos por duración**. No devolver sin más el BPM
interpolado anterior después de haber calculado los candidatos.

Guía para implementar la clasificación:

1. Evaluar la periodicidad en los periodos de pulso que propone cada candidato,
   incluyendo su relación mitad/doble. Evitar depender solo del máximo global
   actual, que puede corresponder a la caja, al hi-hat o al inicio de compás.
2. Agrupar candidatos relacionados por factores de dos. Comparar primero familias
   de tempo; después elegir la representación más útil de la familia ganadora.
3. Priorizar frases de potencia de dos si la evidencia no distingue las familias.
   Permitir que una evidencia claramente superior seleccione frases de tres,
   seis u otro número de compases; de lo contrario, mantener baja confianza.
4. Si dentro de una familia hay un representante entre **65 y 150**, preferirlo
   como sugerencia inicial. Esto es una preferencia automática, nunca una
   validación de las elecciones manuales.
5. Si todavía hay empate, usar una regla determinista documentada (por ejemplo,
   proximidad a 100 BPM y después menor número de compases), con confianza baja.
   No escoger un resultado distinto según el orden de un mapa/hash.
6. Comparar también consistencia temporal entre partes del audio. No considerar
   fiable un pico apoyado solo en el principio o final de la envolvente.

**Importante:** todos los candidatos construidos con `240 * M / D` encajan por
definición en la duración. Ese encaje no sirve como puntuación para elegirlos ni
como evidencia independiente de alta confianza.

Separar generación de candidatos, puntuación y elección en funciones pequeñas.
Los pesos/márgenes de la puntuación deben ajustarse con el conjunto de fixtures,
quedar como constantes con explicación y probarse antes de dar por mejorado el
detector; esta spec no afirma que exista una calibración validada todavía.

### 5.4 Confianza y fallback

- Mantener `confidence` finita y dentro de `[0, 1]`.
- Solo duración, empates o evidencia débil: confianza `< 0.5`, para activar la
  revisión existente; no presentar el resultado como seguro.
- Si dos familias no relacionadas por octavas tienen apoyo similar, conservar
  la advertencia: los botones mitad/doble no resuelven ese caso por sí solos.
- Ruido no periódico: `None` o confianza baja; silencio: `None`.
- Material no compatible con compases completos 4/4: usar análisis genérico o
  indicar falta de estimación, en lugar de inventar un valor de alta confianza.

## 6. Datos existentes y análisis desde el editor

La mejora debe servir también para loops **ya importados**, no solo para nuevas
importaciones. No reescribir todo el catálogo al arrancar ni obligar a reimportar.

Propuesta de flujo:

1. Abrir metadatos mantiene el BPM actual en el campo editable.
2. Para un BPM automático o ausente, pedir en segundo plano una sugerencia con el
   nuevo detector; mostrar `Analyzing tempo…` sin bloquear reproducción o edición.
3. La respuesta actualiza las opciones sugeridas, **no el borrador ni SQLite**.
   El usuario elige una y guarda si quiere aplicarla.
4. Para valores manuales/Serato conocidos, conservarlos como base de corrección y
   etiquetar `Current`, no `Detected`. No reanalizar ni sustituirlos de forma
   automática al abrir. Una nueva acción explícita de reanálisis puede añadirse
   posteriormente si se solicita.
   Aplicar la misma protección a datos históricos `analyzed` con BPM pero sin
   confianza cuando no se pueda distinguir un valor de catálogo de uno calculado;
   ver la política conservadora de la spec 270.
5. Si falla el análisis, conservar edición manual, Tap tempo y variantes del
   valor existente; mostrar el error sin borrar datos.

Para soportar el punto 2 existe el comando **de solo lectura**
`library_analyze_bpm(id)`, registrado en `lib.rs`, y el wrapper `libraryAnalyzeBpm`
en `src/tauri.ts`.

Contrato de respuesta:

```ts
interface TempoSuggestion {
  track_id: number;
  bpm: number | null;
  confidence: number | null;
  duration_frames: number;
  sample_rate: number;
  assumed_meter: "4/4" | null;
  bars: number | null;
}
```

Capturar la raíz de biblioteca antes de `spawn_blocking`. Cargar por ID y usar
el decodificador canónico correspondiente; para `embedded:<id>`, leer el sonido
del contenedor sin materializar audio. Respetar la compuerta de trabajo y límites.
El comando no escribe tags, BPM ni regiones de práctica.

En frontend, asociar la petición al ID de pista, generación de biblioteca y
apertura del editor. Ignorar respuestas si el diálogo se cerró, cambió de pista o
de biblioteca. Si el usuario ya editó/tapeó/seleccionó un BPM, la respuesta tampoco
debe sustituir su borrador ni la base sobre la que está trabajando.

La primera versión puede mantener `{ bpm, bpm_confidence, bpm_source }` actuales
sin migración, calculando las sugerencias a demanda. Si se decide persistir el
número de compases o versión de análisis, requiere DTOs y migración explícitos;
no añadir columnas de forma ad hoc.

## 7. Editor: botones de tempo, mitad y doble

Ejemplo con sugerencia base de 100 BPM:

```text
BPM  [100.0                ]

Tempo options
[Half · 50 BPM]  [Detected · 100 BPM]  [Double · 200 BPM]

4/4 loop · 9.600 s · 4 bars at the suggested tempo
[Tap tempo] ...
```

### Base estable

- Guardar una base de sugerencia por apertura del diálogo; no derivar los botones
  continuamente del valor que ellos mismos escriben en `metadataDraft.bpm`.
- Con base 100, pulsar Half diez veces debe seguir seleccionando 50, no 25, 12,5…
- Pulsar Detected devuelve a 100 y Double a 200.
- Si el usuario escribe un valor o obtiene Tap tempo, ese valor válido puede
  convertirse en una nueva base explícita etiquetada `Entered` o `Tapped`.
  No recalcular la base en cada pulsación que deja un texto incompleto/inválido.
- Al abrir otra pista, reiniciar la base y todos los estados de la anterior.

Propuesta: extraer la generación de opciones a `src/bpmOptions.ts`, función pura
que reciba una base válida y devuelva valores y etiquetas. No duplicar fórmulas
de mitad/doble en varios handlers JSX.

### Cuándo tiene sentido ofrecer una opción

1. Debe ser finita y estar entre **20 y 300 BPM**, ambos incluidos.
2. La validación se realiza antes del redondeo visual.
3. Para sugerencias basadas en 4/4, comprobar que la variante mantiene un número
   entero de compases sobre el mismo loop, dentro de una tolerancia por precisión
   de muestras (propuesta: `max(2 frames, 1 ms)` de error temporal).
4. Ejemplo: un loop de un compás a 120 no justifica medio compás a 60 bajo la
   hipótesis de compases completos. Esa variante puede ocultarse o deshabilitarse
   con explicación. Un loop de dos compases a 120 sí permite uno a 60.
5. Para bases manuales/Serato sin hipótesis de compases confirmada, no fingir esa
   certeza: aplicar el rango numérico y conservar entrada libre para corregir.
6. Si falta BPM, no ofrecer `0`, `NaN` ni valores inventados. Esperar la sugerencia
   o permitir introducir/Tap tempo.

Rango y compatibilidad de compases son conceptos distintos. Un 60 BPM puede
estar fuera del rango preferente automático y seguir siendo una opción válida.
Mantener el campo libre como vía de corrección, también para material no 4/4.

### Interacción y guardado

- Cada opción usa `type="button"`, nombre accesible con valor y selección visible
  (`aria-pressed` si son botones). No enviar el formulario al seleccionarla.
- La selección cambia solo el borrador, llama a `setBpmConfirmed(true)`, limpia
  errores de BPM y reinicia los taps previos para evitar mezclar sesiones.
- Pulsar ×1 también es confirmación explícita aunque el número no cambie.
- Desactivar las opciones mientras `metadataBusy` es cierto.
- Cancelar no escribe nada. Editar solo título/tags no convierte un análisis en
  BPM manual ni aplica una sugerencia recién calculada.
- Guardar una selección utiliza `libraryUpdateMetadata(..., confirmManualBpm=true)`;
  el resultado queda `bpm_source='manual'` y sin confianza automática obsoleta.
- Conservar `olooper:track-bpm`, actualización de la fila y propietario/generación
  de la operación existentes. Los consumidores reciben el valor actualizado.
- Mantener la sincronización Serato existente para audio extraído, conservando
  CUEs y loops guardados. Para pistas embebidas, guardar BPM en catálogo sin
  intentar escribir el SWF/EXE ni extraer audio.
- Si fallan tags después del guardado en catálogo, distinguir ese error del
  guardado de metadatos; no mostrar un éxito completo falso.

### Acceso directo: doble clic en BPM

El requisito se aplica a las filas de All, Favorites, un looper y playlists,
tanto al valor numérico como a `--` cuando no existe BPM.

Implementación en `Sidebar.tsx`:

1. Añadir a la celda BPM un handler `onDoubleClick` que llame a
   `event.stopPropagation()` y `editTrack(track)`. Reutilizar el diálogo existente,
   no crear un segundo editor de BPM con otra ruta de guardado.
2. El handler de fila actual hace `onDoubleClick={() => void playTrack(track)}`.
   El doble clic del BPM **no debe llegar a él**. Añadir una regresión que confirme
   que no se invocó carga ni reproducción.
3. En la celda, impedir también que `pointerdown` inicie el arrastre de la fila;
   no bloquear el foco normal del control. Un clic simple puede conservar la
   selección de fila existente, pero nunca abrir el diálogo ni reproducir.
4. Los botones `Set` y de revisión de baja confianza siguen abriendo el mismo
   editor con un clic. Evitar doble apertura por burbujeo si se pulsa sobre ellos.
5. Tras montar el diálogo, enfocar el campo BPM, sin competir con `useModalFocus`:
   ampliar su contrato con un objetivo inicial explícito si hace falta, en vez de
   encadenar varios `setTimeout` para robar el foco. El resto de accesos a metadatos
   puede mantener su foco inicial habitual.
6. Mostrar un tooltip como `Double-click to edit BPM`. Conservar un acceso por
   teclado equivalente con nombre `Edit BPM for <title>` y Enter/Espacio. Evitar
   anidar botones, ya que la celda también contiene `Set`/aviso: puede separarse
   el control accesible del valor de esos botones hermanos.
7. No interpretar doble clic en título, duración u otra zona como edición de BPM;
   esas zonas mantienen el comportamiento de fila.
8. La apertura no cambia pista activa, posición, pausa/play ni velocidad.

## 8. Orden de implementación

1. **Fixtures y línea base.** Reunir loops reales con BPM conocido y permisos de
   uso. Registrar duración canónica, BPM actual y valor esperado. Los archivos
   privados permanecen en directorios ignorados, nunca en commits.
2. **Matemática pura.** Implementar duración exacta, candidatos 4/4 y filtros, con
   pruebas sintéticas antes de tocar importación o UI.
3. **Clasificación.** Reutilizar señal rítmica, agrupar familias y calibrar
   confianza. Comparar con el detector anterior usando el mismo conjunto.
4. **Integración.** Aplicar contexto correcto en importación y añadir análisis
   de solo lectura para pistas existentes. Verificar paridad extraído/embebido.
5. **Opciones del editor.** Implementar helper puro, base estable, labels y
   confirmación manual, y acceso por doble clic en la celda BPM. Mantener Tap
   tempo y entrada libre.
6. **Persistencia e IPC.** Probar guardar, cancelar, reabrir, respuestas tardías,
   cambio de biblioteca y Serato; no perder protecciones de la auditoría.
7. **Revisión real.** Escuchar y verificar los loops del conjunto, registrar
   resultados y actualizar esta spec a implementada solo con evidencia.

## 9. Plan de pruebas

### Backend: `analysis_tests.rs`

- Generar buffers con un número entero de compases, usando
  `frames = round(sample_rate * 240 * compases / bpm)` y amplitudes realistas.
  No reutilizar sin revisar todos los fixtures anteriores de 8/12 segundos:
  algunos no representan compases completos al BPM que se está probando.
- Cubrir 90, 100, 120, 128 y un tempo decimal; 1/2/4/8/16 compases y varias tasas.
- Verificar candidatos con la fórmula y tolerancia derivada de frames. Para el
  resultado a una décima, tolerar el redondeo correspondiente, no ±5 BPM.
- Probar mono/estéreo con igual duración; contar muestras en vez de frames no
  debe duplicar o dividir el tempo.
- Incluir caja a medio tiempo, hi-hat al doble, síncopas y acentos de compás.
- Separar acierto de familia (`B`, `B/2`, `2B`) de acierto exacto. No contar como
  éxito cualquier múltiplo entero o normalización arbitraria.
- Probar frase no habitual, loop no 4/4, audio no cerrado, ruido y silencio; no
  conceder confianza alta por el mero ajuste de duración.
- Probar cero frames, rate cero, cancelación y límites de recursos.

### Integración: `library/tests.rs` e IPC

- Igual audio SWF/EXE, extraído y embebido: misma duración canónica y familia BPM.
- MP3 con seek/padding, y M4A cuando haya fixtures: respetar límites de playback.
- Nuevo análisis disponible para una pista existente sin reimportarla.
- Abrir/analizar/cancelar no cambia BPM, fuente, tags ni audio.
- Guardar ½, ×1 confirmado o ×2 persiste manual tras reabrir la biblioteca.
- Cambiar solo título/tags conserva BPM/source/confidence previos.
- BPM manual, Serato o de catálogo conocido no se reemplaza por análisis casual.
- Tags Serato conservan CUEs y loops; pistas embebidas no generan audio ni escriben
  contenedores. Repetir la regresión de CUEs concurrentes.

### Frontend: helper y `Sidebar.test.tsx`

- Base 100: 50/100/200; ½ repetido sigue dando 50.
- Base 160: 80/160; 320 no seleccionable. Base 30: 15 no seleccionable.
- Rechazar `NaN`, infinito, valores ≤0 y valores fuera del rango antes de redondear.
- Filtrar variantes incompatibles con compases completos cuando se conoce 4/4.
- ×1 con mismo número marca confirmación; guardar solo título no lo hace.
- Botones no envían el formulario; Cancel conserva datos; Save usa la ruta manual.
- Doble clic en BPM/`--` abre el editor de esa pista y enfoca BPM, sin cargar,
  reproducir ni arrastrar; doble clic en el título sigue reproduciendo.
- Clic simple en BPM no abre; los accesos por teclado, Set y aviso funcionan sin
  aperturas duplicadas ni interferencia con el foco modal.
- Respuestas de análisis tardías no pisan edición, Tap tempo, otra pista o biblioteca.
- Análisis fallido deja utilizables el campo manual y Tap tempo.
- Guardado pendiente desactiva controles; error conserva el borrador para corregir.

## 10. Criterios de entrega y comandos

- [x] Candidatos basados en la duración PCM canónica y compases 4/4.
- [ ] Mejora medida sobre loops reales con BPM conocido, indicando número de
  muestras, aciertos exactos, de familia y fallos respecto al detector anterior.
- [x] Regresiones sintéticas: sin confianza alta por duración sola en ruido,
  silencio y pulsos de octava ambigua; pendiente evaluación con audio real.
- [x] Pistas ya importadas pueden recibir el análisis nuevo por lotes sin reimportación.
- [x] Editor ofrece ×1/½/×2 válidos, con base estable y entrada manual/Tap tempo.
- [x] Doble clic en BPM abre ese editor enfocado en tempo sin reproducir la fila.
- [x] Reanálisis de looper, lista y todos implementado según spec 270.
- [x] Guardar confirma manualmente; abrir y cancelar no modifican nada.
- [ ] BPM manual y metadatos Serato protegidos también ante lecturas/tag-sync
  concurrentes; follow-up audit finding pendiente.
- [x] Casos extraídos/embebidos, límites y generaciones cubiertos por regresiones.

Ejecutar desde la raíz con Node 24, pnpm 12.9.1 y el MSRV documentado:

```sh
pnpm run typecheck
pnpm test
pnpm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo +1.89.0 check --manifest-path src-tauri/Cargo.toml --locked --all-targets
git diff --check
```

Además de los tests sintéticos, entregar una tabla de comparación con los loops
reales. No declarar resuelto el problema solo porque se cumplen las fórmulas:
elegir el número de compases correcto es precisamente la parte que debe validarse.
