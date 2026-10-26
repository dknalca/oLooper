# Revisión de documentación y follow-up de auditoría — 2026-10-26

> Seguimiento de release: DOC-A01–DOC-A06 se corrigieron antes de v0.8.0, con
> regresiones permanentes. El texto siguiente conserva los hallazgos originales;
> estado actual y decisiones en [release-0.8.0.md](release-0.8.0.md). DOC-A07
> continúa sujeto a validación nativa.

## Resultado general

Se inventariaron los 66 Markdown del proyecto (excluyendo `node_modules` y
artefactos de build) y se contrastaron sus enlaces locales. Se revisaron a detalle
las guías, specs y ADRs de usuario/código actual, auditorías históricas, README,
changelog e instrucciones de agente. Se alinearon BPM, reanálisis, importación,
schema SQLite, salvapantallas, release y estado de validación. Las auditorías
anteriores se conservan como snapshots fechados, no como descripciones actuales.

**La primera pasada cerró A01–A31; esta revisión encontró defectos nuevos. Por eso
la auditoría integral actual sigue abierta para DOC-A01–DOC-A06.** DOC-A07 necesita
confirmación en WebKit real. Este informe no implica que el código se haya
corregido.

## Documentos revisados/actualizados

- `README.md`, `CHANGELOG.md` y `AGENTS.md`.
- `specs/010-library.md`, `020-swf-extraction.md`, `095-background-import.md`,
  `130-serato-cue-sync.md`, `140-library-layout-060.md`, `190-tap-tempo.md`,
  `200-audit-hardening.md`, `250-idle-looper-cover.md`,
  `260-loop-duration-bpm.md` y `270-batch-bpm-reanalysis.md`.
- `docs/full-app-audit-2026-10-25.md`, `audit-validation-2026-10-25.md`,
  `stability-resource-audit-2026-10-25.md`, además de `project-audit-2026-10-06.md`
  y `windows-audit-2026-10-07.md` rotulados explícitamente como históricos.
- `docs/adr/0010-bounded-parallel-audio-import.md` y
  `0018-persist-looper-sidebar-order.md` mantienen sus decisiones originales,
  pero sus notas de worker/schema quedan contextualizadas por fecha y decisiones
  posteriores.

El changelog incluye las funciones posteriores a v0.7.1 bajo **Unreleased**; no
se presentan como incluidas en el release publicado. Las métricas antiguas se
conservan rotuladas como cierre inicial; el registro de validación señala la
compilación, pruebas y artefacto más recientes.

## Hallazgos nuevos reproducidos

Las sondas usadas para reproducir carreras se añadieron temporalmente a pruebas
locales y se retiraron al terminar; no quedan en el árbol. P1/P2/P3 expresan
impacto relativo en la aplicación, no una clasificación CVSS.

### DOC-A01 — Un tag BPM anterior puede revertir una corrección manual — P1

**Ruta:** `library_update_metadata` confirma el nuevo BPM en SQLite y la UI llama
después a `library_sync_serato_metadata` como operación separada. Si un `get_serato_metadata`
intermedio (por ejemplo, al abrir la pista o guardar un CUE) lee el `TBPM` antiguo,
el código actualiza la fila con `bpm_source='serato'`. El sync posterior deja de
dar prioridad a la confirmación `manual` y puede volver a escribir el valor viejo.

**Reproducción:** tag WAV 100 BPM → confirmar manualmente 120 en catálogo → leer
metadata Serato antes del sync → ejecutar sync. Se observó catálogo y archivo con
100 BPM y procedencia `serato`. Reproducido con una prueba Rust temporal contra
una biblioteca y WAV de prueba; no se conservó la sonda.

**Recomendación:** serializar en una única operación la confirmación manual, la
lectura/fusión de tags y el reemplazo del archivo; nunca degradar una fila manual
por una lectura de tag atrasada. Añadir regresión para el interleaving completo.

### DOC-A02 — Guardar CUE convierte un BPM automático en un tag que luego queda protegido — P2

**Ruta:** `save_serato_metadata` rellena `metadata.bpm` desde el BPM del catálogo
si la metadata no incluye uno. Así, guardar o cambiar un CUE puede escribir en el
audio un BPM cuya procedencia de catálogo es `analyzed`. El batch reanalysis
protege cualquier BPM encontrado en tags, por lo que esa pista ya no se
reanaliza aunque el tag fuera creado por oLooper a partir del resultado automático.

**Reproducción:** pista con BPM analizado → guardar CUE 2 → comprobar que el tag
recibió el BPM automático → reanalizar. El resultado es `Protected`. Reproducido
con una prueba Rust temporal.

**Recomendación:** no escribir BPM `analyzed` al guardar CUE, o guardar procedencia
suficiente para distinguir un tag generado por oLooper de uno externo/manual.
Verificar que el batch reanalysis puede recalcular automáticos aunque se haya
guardado un CUE, sin sobrescribir valores externos o confirmados.

### DOC-A03 — Progreso del root anterior puede actualizar la UI del root nuevo — P2

**Ruta:** `BpmReanalysisPanel` cierra la suscripción en un efecto pasivo y conserva
la última función de `App` en `callbacks.current`. En un cambio de root, una
notificación puede ejecutarse entre el render nuevo y el cleanup del efecto
anterior. El callback de la suscripción antigua valida contra el root antiguo,
pero `callbacks.current` ya apunta a `onUpdated` de la vista nueva. `App` aplica el
track si coincide el ID, sin comprobar la generación/root de la notificación.

**Reproducción:** harness React con root `/a`→`/b` y publicación desde un
`useLayoutEffect`, anterior al cleanup pasivo. El callback de `/b` recibió el
track de `/a`. No se observó escritura en la base B; el riesgo probado es un BPM
visual incorrecto si los IDs coinciden.

**Recomendación:** transportar `library_root` + generación de biblioteca hasta el
callback de `App` y validarlos antes de aplicar estado o emitir `olooper:track-bpm`.
Añadir regresión con IDs coincidentes y publicación durante el cambio de root.

### DOC-A04 — El evento BPM del reproductor pierde procedencia/confianza — P2

`Player.tsx` publica `{trackId, bpm}` al leer tags. Sidebar asigna por defecto
`source='serato'` y `confidence=null`. Una pista analizada con confianza baja
pierde en la vista la marca de revisión; al abrir metadatos puede ser tratada como
BPM externo conocido y no pedir la sugerencia individual.

**Reproducción:** pista `analyzed` con confianza inferior a 0,5 → publicar el
payload actual de Player → desaparece el indicador y no se llama a
`libraryAnalyzeBpm`. Reproducido con harness frontend temporal.

**Recomendación:** definir un DTO tipado para el evento que incluya procedencia y
confianza, o no modificar la procedencia de catálogo a partir de una lectura de
player que no tenga esa información. Mantener el contrato sincronizado en
`src/tauri.ts`, Player, Sidebar y App.

### DOC-A05 — Dos snapshots IPC completos por track en reanálisis — P2, rendimiento

`process_tracks` publica un progreso antes y después de cada pista. Cada mensaje
contiene el reporte entero y su lista de errores, y se serializa/se emite aunque
los contadores apenas cambien.

**Medición focalizada:** 1.000 IDs inexistentes → 2.000 snapshots, 1.826.898 bytes
JSON serializados y 355 ms en el harness Rust local. No incluye Tauri, WebView ni
renderizado del frontend. Extrapolación lineal a 100.000 pistas fallidas sería
aproximadamente 183 MB JSON; es una señal de coste evitable, no una medición de
red real.

**Recomendación:** agrupar progreso por N pistas o intervalo de 100–250 ms,
mantener siempre un reporte terminal exacto, y enviar un cambio de BPM activo por
un mensaje pequeño si se necesita actualización inmediata. Medir la carga en la
frontera IPC con un catálogo grande.

### DOC-A06 — Observers globales permanecen activos con el screensaver apagado — P3

`useIdleCover` siempre instala un `MutationObserver` en `document.body` y
listeners globales de pointer, teclado, wheel (no pasivo), foco y visibilidad.
`enabled=false` desactiva la aparición pero no evita esos recursos por sesión.

**Reproducción:** montar el hook desactivado y comprobar que se registran tanto
MutationObserver como listener de wheel no pasivo. Reproducido con jsdom.

**Recomendación:** instalar observers/listeners solo mientras la preferencia está
activada. Hacer wheel pasivo donde no se bloquee y separar el handler mínimo de
despertar de la escucha general de actividad.

### DOC-A07 — Click de compatibilidad retrasado tras despertar — P3 condicional

La supresión del gesto se elimina con `setTimeout(0)` tras `pointerup`. Un click
de compatibilidad sintetizado después de ese límite podría alcanzar un control
que estaba oculto. Una secuencia retrasada se reprodujo en jsdom; **no** se ha
confirmado que WebKit entregue así un click físico normal.

**Recomendación:** validar puntero, touch y tecnologías de asistencia en WebKit.
Si el comportamiento se reproduce, mantener una barrera asociada a la secuencia
de entrada hasta consumir el click correspondiente.

## Validación ejecutada durante esta revisión

- Se retiraron las pruebas temporales de auditoría tras capturar la evidencia.
- `pnpm run typecheck` y `pnpm test`: correctos, 89 pruebas en 23 archivos.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings`: limpio.
- `cargo test --manifest-path src-tauri/Cargo.toml --locked`: 231 correctas,
  cuatro ignoradas.
- Formato Rust y `git diff --check`: correctos.
- Las mediciones de DOC-A05 son microbenchmark local; no se midió WebView ni
  dispositivos físicos. DOC-A07 espera validación WebKit nativa.

## Pendiente de cierre

1. Corregir DOC-A01, DOC-A02 y DOC-A03 antes de considerar seguro el flujo de BPM.
2. Preservar procedencia/confianza en DOC-A04.
3. Reducir/throttlear el coste de DOC-A05 y hacer inactivo DOC-A06 cuando la opción
   esté apagada.
4. Validar DOC-A07 en WebKit antes de decidir si se requiere una modificación.
5. Repetir las regresiones y actualizar este documento y §11 de
   `docs/full-app-audit-2026-10-25.md` tras cada corrección.
