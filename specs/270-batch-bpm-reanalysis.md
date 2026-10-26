# 270 — Reanalizar BPM de un looper, una lista o toda la biblioteca

- Estado: implementado inicialmente; validación con bibliotecas reales pendiente.
- DOC-A03/DOC-A05 corregidos antes de v0.8.0: validar propietario root/generación
  antes del cleanup pasivo y emitir progreso cada 150 ms más el terminal exacto.
  Véase [el cierre de release](../docs/release-0.8.0.md).
- Fecha: 2026-10-25.
- Depende de [spec 260 — detector por duración y editor BPM](260-loop-duration-bpm.md).

## 1. Requisito del usuario

Añadir una opción para volver a analizar el tempo de:

1. Todos los loops de **un looper**.
2. Los loops incluidos en **una lista/playlist**.
3. **Toda la biblioteca**.

La operación usa el nuevo detector de la spec 260 y sirve para corregir análisis
de pistas ya importadas. No requiere reimportar, recargar ni parar la reproducción.

Esta funcionalidad es distinta de la sugerencia de solo lectura del editor:
el usuario inicia explícitamente un trabajo por lotes que guarda los nuevos
resultados automáticos elegibles en el catálogo.

### Implementación actual

- Backend: `bpm_jobs.rs` y `library/bpm.rs`, sin migración de esquema.
- Un job activo global, sin cola de trabajos BPM; snapshot limitado a 100.000 IDs.
- Comandos `reanalyze_bpm`, `cancel_bpm_reanalysis`, `bpm_reanalysis_status` y evento
  `olooper:bpm-reanalysis-progress`; DTOs/wrappers en `src/tauri.ts`.
- `BpmReanalysisPanel` permanece en `App` al cambiar entre Library y Discover,
  registra la escucha antes de admitir y muestra contadores, errores y cancelación.
- Acciones `Reanalyze all BPM`, `Reanalyze looper BPM` y `Reanalyze playlist BPM`
  en la barra de la biblioteca; también reanálisis desde el menú de looper.
- Además de los valores protegidos del catálogo, se preserva cualquier BPM ya
  escrito en tags: el lote no modifica audio y no permite que un tag antiguo
  revierta de inmediato su nuevo cálculo. Se contabiliza como `protected`.
- Cada actualización revalida procedencia, valor e identidad de archivo bajo el
  mutex de operaciones. Cambiar de biblioteca cancela el root anterior.
- El DTO real añade `errors` (hasta 20 mensajes de 500 caracteres) al reporte y
  `updated_track` al evento para actualizar la pista activa sin recargar audio.
- Pruebas: selección por ámbito, protección manual/externa, persistencia sin
  alterar bytes, edición concurrente en el mismo segundo, cancelación, errores
  acotados, suscripción previa y cambio de root en la UI.
- Optimización pendiente: actualmente se emiten dos snapshots completos de
  progreso por pista. En una prueba artificial de 1.000 IDs fallidos serializó
  1.826.898 bytes en 2.000 eventos/355 ms, antes del coste de Tauri/WebView. La
  prueba cuantitativa y propuesta están en el seguimiento de auditoría.

Las secciones siguientes conservan el diseño y la matriz de aceptación; los
ensayos con hardware/colecciones reales y fallos de proceso requieren validación
manual adicional. El acceso por doble clic y el editor individual de la spec 260
también están implementados.

## 2. Accesos y significado de cada ámbito

| Ámbito | Acceso implementado | Pistas incluidas |
| --- | --- | --- |
| Looper | Menú contextual del looper o botón de la colección: `Reanalyze BPM` | IDs con el mismo `source_hash`, no con el mismo nombre visible. |
| Playlist | Botón de acciones de la playlist seleccionada: `Reanalyze playlist BPM` | IDs referenciados por esa playlist, sin copiar ni mover audio. |
| Toda la biblioteca | Botón del toolbar: `Reanalyze all BPM` | Todos los IDs del catálogo de la biblioteca seleccionada. |

La acción de todos debe estar accesible desde All aunque no haya un looper
seleccionado. No colgarla exclusivamente del menú contextual de una fila.

Reglas de selección:

- Los filtros de texto, BPM o duración no reducen silenciosamente el ámbito.
  Un looper significa el looper completo; todos significa el catálogo completo.
- La selección de checkboxes de filas tampoco cambia estos tres ámbitos.
- Si se ofrece el acceso desde Favorites, tratarlo como colección explícita de
  favoritos y etiquetarlo; no llamarlo todos. Esto es una extensión opcional, no
  necesaria para entregar los tres ámbitos pedidos.
- Una pista que aparece varias veces en una playlist se procesa una sola vez.
- Congelar el conjunto de IDs al iniciar. Cambiar la vista, filtros o miembros de
  playlist después no modifica el trabajo ya admitido.
- La playlist solo contiene referencias: guardar el BPM actualiza la pista común
  y se refleja también en All y en otras listas donde aparece.
- Para ámbito vacío, mostrar `No tracks to analyze`; no crear un trabajo vacío.

## 3. Qué se guarda y qué se protege

Política implementada para la primera versión, conservando BPM manual y Serato:

| Estado de la pista | Comportamiento |
| --- | --- |
| Sin BPM | Analizar y guardar si hay estimación válida. |
| BPM automático anterior (`analyzed` con confianza no nula) | Reanalizar con el nuevo detector y actualizar BPM/confianza si procede. |
| BPM confirmado manualmente | Omitir y contabilizar como protegido. |
| BPM Serato o de catálogo externo conocido | Preservar y contabilizar como protegido. No confundir con un análisis automático solo por tener un número. |
| Sin archivo o fuente accesible | Registrar error individual; continuar con las demás. |
| Sin estimación válida | Conservar valor previo y registrar `no_estimate`; no reemplazarlo por cero o `null`. Una estimación válida pero de baja confianza puede guardarse con su advertencia, según spec 260. |

El texto de la acción debe explicar que se actualizarán BPM automáticos/ausentes
y se conservarán los confirmados. No añadir por defecto una opción para forzar
sobrescritura de valores manuales. Si se desea esa opción, requerirá una decisión
de producto separada.

Un resultado automático mantiene `bpm_source='analyzed'`; no marcarlo manual ni
tratar una confianza baja como una confirmación del usuario. Mantener el aviso de
revisión de la biblioteca y las opciones ×1/½/×2 del editor.

En Tablist u otras fuentes puede existir un BPM conocido con `bpm_confidence=null`
y fuente histórica `analyzed`. No asumir que todo `analyzed` representa un cálculo
local. Para esta primera versión, **un BPM existente `analyzed` sin confianza se
protege por defecto** si no hay procedencia que demuestre lo contrario. Contarlo
en `protected` y explicarlo en el resumen; la corrección individual del editor
sigue disponible. No es necesario inventar su origen ni migrar datos a ciegas.
Si en el futuro se añade procedencia explícita, cualquier nueva columna exige
migración en `library/mod.rs` y regresiones.

El reanálisis no cambia tags de audio, CUEs, loops Serato, audio gestionado,
contenedores originales, BPM manual, velocidad ni región de práctica. No llamar
a la sincronización Serato automática por cada resultado del lote: la confirmación
manual desde el editor conserva su flujo existente. Verificar que una lectura
posterior de tags antiguos no anula inmediatamente el nuevo análisis del catálogo;
respetar la política de procedencia existente y cubrirla con una regresión.

## 4. Trabajo en segundo plano

### Arquitectura implementada

El worker backend está en `src-tauri/src/bpm_jobs.rs` y el análisis/commit por
pista en `src-tauri/src/library/bpm.rs`:

- Admite un trabajo activo global (no un trabajo concurrente por cada
  biblioteca); un job anterior debe quedar terminal antes de iniciar otro.
- Analice secuencialmente, una pista cada vez. No crear un hilo por pista ni
  lanzar todas las decodificaciones con `Promise.all`.
- Reutilice el detector y decodificador canónicos de la spec 260.
- Use la compuerta global de trabajo intensivo y límites de memoria existentes.
- Abra su conexión SQLite para el root capturado al admitir el trabajo, con WAL,
  busy timeout y el contrato de lease/mutex de `library/operations.rs`.
- No mantenga una transacción ni un lock de escritura durante toda la
  decodificación del lote. Leer/comprobar y escribir con secciones breves.
- Valide la existencia de la biblioteca/ámbito en backend. No confiar solo en IDs
  y nombres suministrados por el frontend.
- Mantiene snapshot de IDs limitado a 100.000 pistas y hasta 20 mensajes de error
  de 500 caracteres. El coste de publicar snapshots de progreso dos veces por
  pista es un follow-up pendiente DOC-A05.

Los jobs de importación ya tienen un worker y contrato de eventos. Revisarlos
como patrón para suscripción previa, cancelación e informes parciales, pero no
emitir un `ImportReport` para una operación que no importa pistas. Si se reutiliza
el worker, introducir un tipo de job explícito de BPM y su propio contrato.

### Comandos y DTOs implementados

```ts
type BpmReanalysisScope =
  | { kind: "looper"; source_hash: string }
  | { kind: "playlist"; playlist_id: number }
  | { kind: "library" };

interface BpmReanalysisReport {
  total: number;
  processed: number;
  updated: number;
  protected: number;
  changed_since_start: number;
  no_estimate: number;
  failed: number;
  unprocessed: number;
  errors: string[];
}

interface BpmReanalysisProgress {
  job_id: string;
  library_root: string;
  current_track_id: number | null;
  updated_track: Track | null;
  state: "running" | "completed" | "cancelled" | "failed";
  report: BpmReanalysisReport;
  error: string | null;
}
```

- Comando `reanalyze_bpm(scope, jobId)` devuelve el ID una vez admitido; eso no
  significa que haya terminado.
- Comando `cancel_bpm_reanalysis(jobId)` solicita cancelación idempotente.
- Comando `bpm_reanalysis_status()` permite recuperar el estado actual o terminal
  del último job BPM para la biblioteca activa.
- Evento `olooper:bpm-reanalysis-progress` comunica progreso y resultado terminal.
- Añadir wrappers/DTOs en `src/tauri.ts` y registro de comandos en `lib.rs`.
- Suscribirse **antes de encolar**. Reutilizar los patrones de espera existentes
  para no perder un trabajo que termine inmediatamente.
- Un fallo de admisión se devuelve como error del comando, sin dejar spinner.
- Emitir un resultado terminal por trabajo admitido, también al cancelar, fallar
  o contener un pánico. Los eventos identifican job y root; el follow-up DOC-A03
  debe añadir la validación de generación al último consumidor frontend.

Invariantes de contadores al terminar:

```text
processed = updated + protected + changed_since_start + no_estimate + failed
total = processed + unprocessed
```

En ejecución, `processed` cuenta pistas terminadas; la actual no se cuenta dos
veces. `unprocessed` incluye las aún pendientes y la actual sin resolver. En una
finalización completa es cero. Al cancelar o fallar globalmente, conserva cuántas
quedaron sin procesar y el estado terminal indica la causa. Mantener estas
invariantes y un contrato único frontend/backend.

## 5. Cancelación, conflictos y cambio de biblioteca

### Cancelar

- Botón `Cancel analysis` visible mientras esté activo.
- Comprobar cancelación antes de abrir cada pista, en fases largas y antes de
  guardar, utilizando la infraestructura existente cuando sea reutilizable.
- Los resultados ya guardados se conservan. No hacer rollback de todo el lote
  ni presentar el trabajo como completado si se canceló a mitad.
- Si la pista actual terminó pero se solicitó cancelar antes del commit, no
  guardarla. Devolver contadores exactos y liberar buffers/locks/suscripciones.

### El usuario edita un BPM mientras se analiza

1. Leer y capturar BPM, procedencia, confianza e identidad de audio al empezar la
   pista; guardar además una revisión/fingerprint de los metadatos relevantes.
2. Decodificar y analizar sin retener el lock de escritura.
3. Justo antes del commit, tomar el lock de operaciones y volver a leer el estado.
4. Si ahora es manual/protegido, la fuente cambió, desapareció la pista o los
   metadatos relevantes difieren, omitir el resultado y contabilizarlo como
   `changed_since_start` (o fallo de archivo según corresponda).
5. No usar solo `updated_at` en segundos como prueba de igualdad: pueden darse dos
   cambios en el mismo segundo. Verificar también los valores/procedencia y la
   identidad del audio, o una revisión con granularidad adecuada.

La comprobación y escritura deben ser atómicas respecto al editor. Una elección
manual guardada durante el análisis siempre prevalece sobre el resultado tardío.

### Cambiar la biblioteca o cerrar la app

- Un trabajo nunca resuelve IDs contra la nueva biblioteca seleccionada.
- Solicitar cancelación al cambiar de root; el worker mantiene su root capturado
  y verifica cancelación antes de cada escritura pendiente.
- La nueva UI ignora eventos de otra raíz/generación aunque coincidan los IDs.
- Si hay una escritura ya confirmándose al pedir el cambio, queda asociada solo
  a la biblioteca original y se contabiliza; no afirmar cancelación retroactiva.
- Al cerrar la app, no iniciar nuevas pistas; conservar commits ya terminados y
  garantizar que SQLite/archivos quedan consistentes.
- Los cambios de filtros o de pestaña dentro de la misma biblioteca no cancelan
  por sí solos; mantener visible un indicador de progreso para ese trabajo.

## 6. Interfaz de progreso y actualización de resultados

Mostrar el nombre y el alcance real, por ejemplo:

```text
Reanalyzing BPM — Looper “Nombre”
12 / 40 tracks processed
Updated: 8 · Protected: 2 · No estimate: 1 · Failed: 1
[Cancel analysis]
```

- El denominador corresponde al snapshot inicial, no a las filas filtradas o
  virtualizadas visibles.
- Impedir el lanzamiento duplicado mientras el mismo ámbito/biblioteca tenga un
  trabajo activo; backend también aplica la regla aunque falle la UI.
- Permitir seguir usando reproducción y navegación. El progreso no debe ser un
  modal que bloquee toda la ventana durante el lote.
- Actualizar la biblioteca por lotes o al terminar, conservando selección,
  colección y scroll. Evitar una recarga completa por cada evento.
- Si cambió el BPM de la pista activa, publicar el valor nuevo con el contrato
  de estado/metadatos actual; no recargar audio ni cambiar su velocidad.
- Al terminar, mostrar resumen diferenciado: completado, cancelado o fallido, con
  resultados parciales y errores individuales consultables de forma acotada.
- Un fallo en una pista no impide analizar las siguientes. Un error global de
  biblioteca/worker sí termina con estado fallido e informe parcial.

## 7. Archivos y orden de trabajo

1. Leer `analysis.rs`, los caminos de decode/importación de `library/mod.rs`,
   `library/operations.rs`, `lib.rs`, `src/tauri.ts` y `Sidebar.tsx`.
2. Implementar/probar primero el detector de la spec 260 y su análisis de solo
   lectura por ID. Reutilizar esa lógica en lugar de crear otro detector.
3. Implementar resolución de ámbito y snapshot deduplicado. Probar que looper usa
   `source_hash`, playlist usa referencias y todos ignora filtros de pantalla.
4. Crear el worker acotado, estados, contadores, cancelación y commit con relectura.
5. Añadir comandos, DTOs y suscripción antes de enqueue; probar trabajo muy rápido.
6. Añadir acciones de UI y progreso no bloqueante; conectar refresh y errores.
7. Verificar persistencia, edición concurrente, cambio de biblioteca y casos
   embebidos, sin regresiones sobre los hallazgos de la auditoría.

## 8. Pruebas y criterios de aceptación

- [x] Looper A con un nombre igual al de B: solo se analizan IDs de su hash.
- [x] Playlist con IDs repetidos: cada pista se analiza una vez y su BPM se ve en
  todas las listas que la referencian; orden y pertenencia no se alteran.
- [x] Todos con búsqueda/filtros activos: se procesa el catálogo completo.
- [ ] Snapshot vacío no genera job; cambios de playlist posteriores no alteran el
  lote admitido.
- [x] BPM automático/ausente se actualiza; manual/Serato/conocido permanece intacto.
- [x] Ruido, falta de estimación, archivo perdido o corrupto no borra el BPM previo
  ni aborta las demás pistas.
- [ ] Trabajo muy rápido no pierde el evento final; doble solicitud no crea dos
  lotes activos; un pánico produce terminal fallido con parcial.
- [ ] Cancelar antes de empezar, durante decode y antes de commit libera recursos
  y conserva exactamente los resultados ya guardados.
- [x] Guardar un BPM manual durante el análisis impide que el resultado antiguo lo
  pise, también si ambas operaciones ocurren en el mismo segundo.
- [ ] Cambiar de biblioteca con IDs coincidentes no escribe ni aplica eventos en
  el nuevo catálogo.
- [ ] Progreso y contadores cumplen invariantes en éxito, cancelación y fallo.
- [x] Audio activo no se recarga ni cambia de velocidad y no hay crecimiento de
  workers/buffers por número de pistas.
- [x] Extracción y modo embebido producen el mismo análisis, sin materializar audio
  de SWF/EXE ni escribir tags durante el lote.
- [x] Doble clic en la celda BPM abre la edición individual de la spec 260 sin
  interferir con el job ni iniciar reproducción accidental.

Usar bibliotecas temporales para las pruebas de persistencia/concurrencia y
temporizadores/control de tareas para los eventos. Ejecutar los comandos finales
de la spec 260 y comparar también loops reales con el detector anterior.
