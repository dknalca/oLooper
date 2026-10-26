# 250 — Salvapantallas de carátula por inactividad

- Estado: implementado; pruebas automatizadas disponibles, validación visual en
  dispositivos pendiente. DOC-A06 corregido en v0.8.0: observers/listeners de
  actividad solo se instalan mientras la opción está activada.
- Fecha: 2026-10-25.

## Objetivo

Mostrar la carátula del looper que está sonando como salvapantallas dentro de la
ventana de oLooper, sin interrumpir la reproducción.

## Comportamiento solicitado

1. Si la opción está activada y transcurre el **retraso elegido en minutos** sin
   interacción dentro de la ventana (cinco minutos por defecto), la carátula del
   looper que está sonando se amplía hasta ocupar toda la ventana de la app.
2. Al mover el ratón dentro de la ventana, la carátula se encoge y vuelve a su
   posición habitual, recuperando la vista normal.
3. Preferencias de la app permite **activar/desactivar** esta función y elegir
   un retraso de 1 a 60 minutos.
4. El efecto ocupa la ventana de oLooper; no requiere poner la aplicación en
   pantalla completa del sistema.

## Estado de implementación

- Preferencias generales en el menú macOS (`Preferences…`, `⌘,`), `TopBar` y
  `AppPreferencesDialog`, desactivado por defecto y persistido con `appPreferences.ts`.
- Contador configurable en minutos (cinco por defecto) en `useIdleCover`, con estados de transición,
  actividad local, foco, modales y protección frente a gestos de despertar.
- `IdleCoverScreensaver` precarga y valida la imagen, conserva la última portada
  mientras llega una nueva y descarta respuestas de otro looper/biblioteca.
- Overlay mediante portal, transición de 240 ms, geometría tomada de la carátula
  de `Waveform`, ajuste sin deformación y movimiento reducido.
- Pruebas de contador, pausa/reanudación, foco, cambio de biblioteca, gestos,
  persistencia, transición y respuestas tardías. La fluidez y compatibilidad del
  WebKit mínimo siguen requiriendo la matriz manual de la sección 10.

## 1. Alcance y decisiones de la implementación

Este documento conserva la guía de implementación y su matriz de validación.
Los cuatro comportamientos anteriores son requisitos del usuario. La versión
implementada utiliza estas decisiones:

| Tema | Propuesta para la primera versión |
| --- | --- |
| Estado inicial | Desactivado, para que la nueva vista sea optativa. |
| Preferencia | Global para la app, persistente entre reinicios y cambios de biblioteca. |
| Tiempo | Persistir 1, 2, 3, 5, 10, 15, 20, 30, 45 o 60 minutos. Predeterminado: 5 minutos (`300000` ms). |
| Cuándo puede aparecer | App visible y con foco, reproducción activa, biblioteca lista y carátula válida de la pista que realmente suena. |
| Pausa o stop | Cerrar la vista y cancelar el contador. Al reanudar, comenzar el retraso elegido de nuevo. |
| Sin carátula | Conservar la vista normal; no ampliar el logotipo ni el placeholder `No cover`. |
| Pérdida de foco o minimización | Cerrar y cancelar el contador. Al volver, empezar el retraso elegido de nuevo; no descontar tiempo en segundo plano. |
| Diálogos | No entrar mientras haya otro diálogo modal. Si se abre uno, cerrar el salvapantallas. |
| Imagen | Completa, sin recorte ni deformación (`object-fit: contain`), sobre fondo de la app. Puede haber bandas. |
| Movimiento reducido | Respetar `prefers-reduced-motion`: mostrar/ocultar sin desplazamiento ni escala animados. |
| MIDI | No cuenta como interacción dentro de la ventana. Los controles MIDI siguen funcionando y la portada sigue al looper que suena. |
| Random automático | No reinicia el contador ni despierta la vista. Si cambia de looper, actualizar su carátula. |

La capa cubre el contenido de la ventana, incluidos cabecera y controles; no
oculta la barra de título nativa ni modifica el tamaño de la ventana del sistema.

## 2. Dónde está cada pieza en el código actual

Leer estos archivos antes de editar:

| Archivo existente | Qué interesa |
| --- | --- |
| `src/App.tsx` | Mantiene `activeTrack`, `activeCoverState`, estado de reproducción, preferencia y generación de biblioteca; integra el overlay. |
| `src/components/Waveform.tsx` | Renderiza la carátula pequeña, conserva el arrastre a playlists y expone su ref como origen de transición. |
| `src/components/TopBar.tsx` | Incluye el acceso a Preferencias generales junto a Audio, MIDI y atajos. |
| `src/components/AudioSettingsDialog.tsx` | Referencia visual para un diálogo de opciones. No colocar esta opción visual dentro de ajustes de salida de audio. |
| `src/hooks/useModalFocus.ts` | Contrato común de foco, `inert`, Escape y restauración del foco para diálogos. `App` ya lo utiliza. |
| `src/hooks/useKeyboardShortcuts.ts` | Atajos globales, como Espacio y R. La acción de despertar no debe ejecutar además uno de estos atajos. |
| `src/tauri.ts` | Contratos `Track` y `PlayerStatus`, y wrapper `libraryGroupCover(sourceHash)`. No llamar a Tauri directamente desde el componente nuevo. |
| `src/index.css` | Estilos globales y clases de diálogos; añadir estilos de la capa si hacen falta. |
| `vitest.config.ts` | Configuración existente de pruebas React/TypeScript. |

Se ha añadido un diálogo de Preferencias generales manteniendo los accesos
existentes de Audio y MIDI.

### Archivos añadidos

Archivos principales introducidos por esta funcionalidad:

- `src/appPreferences.ts`: valores por defecto, lectura y guardado.
- `src/components/AppPreferencesDialog.tsx`: opción de activar/desactivar y selector de espera.
- `src/hooks/useIdleCover.ts`: contador, eventos de actividad y estados.
- `src/components/IdleCoverScreensaver.tsx`: elegibilidad, precarga de portada, portal y transición.
- Pruebas de preferencias, hook y componente junto a los archivos correspondientes.

La funcionalidad es visual y no necesita comandos Rust, cambios en SQLite,
paquetes nuevos ni permisos de entrada global del sistema operativo.

## 3. Preferencia persistente

La opción usa una clave específica de `localStorage`:

```ts
const IDLE_COVER_KEY = "olooper.appearance.idle-cover-enabled";
const IDLE_COVER_DELAY_KEY = "olooper.appearance.idle-cover-delay-minutes";
const DEFAULT_IDLE_COVER_DELAY_MINUTES = 5;
const IDLE_COVER_DELAY_OPTIONS_MINUTES = [1, 2, 3, 5, 10, 15, 20, 30, 45, 60];
```

Reglas:

1. Guardar exclusivamente `"true"` o `"false"`.
2. Si falta la clave o el contenido es inválido, usar `false`.
3. Leer y escribir con `try/catch`: un almacenamiento no disponible no debe
   impedir arrancar la app ni cambiar la opción durante la sesión.
4. Mantener el valor efectivo en un único estado de `App`; el diálogo lo recibe
   mediante props. Cambiarlo actualiza ese estado y después intenta persistirlo.
5. Si falla el guardado, conservar la elección de sesión e informar en Preferencias
   de que no se pudo guardar para el siguiente inicio.
6. No guardar el contador, la fase de animación ni las coordenadas de la carátula.

Texto actual de la interfaz, en inglés:

- Acceso: menú de aplicación `Preferences…` con `⌘,` en macOS; acceso adicional en TopBar.
- Sección: `Appearance`.
- Checkbox: `Show looper cover after inactivity`.
- A wait-time selector offers 1, 2, 3, 5, 10, 15, 20, 30, 45, or 60 minutes;
  default is five minutes. The selector is disabled when the cover is off.
- Ayuda: `Move the pointer inside the window to return to the player.`

El checkbox debe tener un `<label>` asociado. El diálogo debe usar
`role="dialog"`, `aria-modal="true"`, nombre accesible y un botón de cierre con
clase `dialog-close`, siguiendo el contrato existente.

## 4. Estados y reglas del contador

Separar la lógica de inactividad de la lógica de reproducción. El hook recibe
datos y emite cambios visuales; no ejecuta `playerPlay`, `playerPause`,
`playerLoadTrack`, seek ni cambios de volumen.

Estados conceptuales:

| Estado | Significado | Cómo sale |
| --- | --- | --- |
| `disabled` | Preferencia apagada. Sin timeout de inactividad. | Activar la opción. |
| `waiting` | Vista normal; contando el retraso elegido si se cumplen las condiciones. | Actividad reinicia; bloqueo cancela; vencimiento muestra. |
| `entering` | La imagen se está ampliando. | Fin de animación o actividad que pide salir. |
| `visible` | Carátula ocupando la ventana. | Actividad, pausa, falta de imagen, cambio de biblioteca o bloqueo. |
| `leaving` | La imagen vuelve a su posición. | Limpieza y nuevo periodo completo si procede. |

`waiting` puede estar sin timeout si no hay reproducción elegible. Un esquema
orientativo de entradas es:

```ts
interface IdleCoverInputs {
  enabled: boolean;
  canEnter: boolean;
  canRemainVisible: boolean;
  libraryGeneration: number;
  delayMs?: number; // configurable; 300000 ms por defecto; injectable en pruebas.
}
```

`canEnter` exige una carátula cargada y coherente con la reproducción. La distinción
con `canRemainVisible` permite conservar la portada anterior durante un cambio
automático de pista cuya nueva carátula todavía se está resolviendo.

### Implementación del tiempo

- Usar un único `setTimeout`, no un `setInterval` de un segundo.
- Guardar en refs la última actividad, la fecha límite y el ID del timeout.
- Usar `performance.now()` para medir el tiempo transcurrido en la sesión.
- Cada evento de actividad actualiza la referencia temporal, sin provocar un
  render React por movimiento de ratón.
- El timeout comprueba la fecha límite actual: si hubo actividad, reprograma solo
  el tiempo restante; si venció y `canEnter` sigue siendo cierto, solicita entrar.
- Revisar las condiciones al ejecutar el callback; no utilizar valores antiguos
  capturados por una closure.
- Al activar la opción, reanudar reproducción, cerrar un diálogo o recuperar el
  foco, iniciar el retraso elegido completo.
- Los sondeos de posición y picos de audio no reinician el contador. Evitar un
  efecto que dependa del objeto `playerStatus` completo, que cambia continuamente.
- Cancelar timeout, listeners y callbacks de animación al desmontar y al cambiar
  de biblioteca. Debe funcionar también con el doble montaje de React StrictMode.

### Qué se considera actividad

Con la ventana visible y enfocada:

- Movimiento del ratón/puntero **dentro del contenido** y entrada del puntero en él.
- `pointerdown`, rueda y teclado dentro de la app.
- Mientras haya un puntero pulsado, una composición de texto o un arrastre activo,
  impedir que entre el salvapantallas aunque transcurra el retraso elegido.

Usar eventos de puntero para no registrar además listeners de ratón duplicados.
La rueda puede registrarse como pasiva si solo se observa. No instalar captura
global del ratón fuera de la ventana. Los movimientos programáticos del foco,
eventos de progreso, polling, Random automático y MIDI no son actividad local.

En `blur` y `visibilitychange` a oculto: salir y cancelar. En `focus`/vuelta a
visible: revalidar y reiniciar. Así, una suspensión del equipo no provoca que la
imagen aparezca inmediatamente al despertar.

## 5. Carátula correcta y cambios de pista

La selección de una fila o de un looper en Sidebar no determina la imagen: usar
la pista **realmente cargada en el motor**.

Para entrar, comprobar al menos:

- `libraryReady` y `startupIntroDone`.
- `playerStatus.loaded && playerStatus.playing && !playerStatus.loading`.
- `activeTrack` no nulo y
  `playerStatus.path === activeTrack.playback_path`.
- Imagen cargada correctamente y perteneciente al mismo `source_hash` y generación
  de biblioteca que la pista activa.
- Sin otro modal, arrastre o interacción sostenida en curso.

`activeCoverState` conserva la identidad y situación de la solicitud, distinguiendo
la imagen pendiente de la ausencia/error. Su forma actual es:

```ts
type ActiveCoverState = {
  sourceHash: string;
  libraryGeneration: number;
  src: string | null;
  pending: boolean;
};
```

La petición existente a `libraryGroupCover` mantiene protección contra respuestas
tardías. El overlay precarga la imagen y valida `naturalWidth`/`naturalHeight`; una
cadena no vacía no basta para considerarla disponible.

Reglas mientras la vista está ampliada:

1. Al cambiar de pista dentro del mismo looper, conservar la imagen sin cerrar ni
   reiniciar el contador.
2. En un cambio automático/MIDI a otro looper, mantener la última imagen válida
   mientras se resuelve la nueva. Cuando esté lista y corresponda a la pista que
   suena, sustituirla. Esto es una instantánea visual, no otra caché de audio.
3. Si la nueva pista no tiene portada o la imagen falla, cerrar y conservar la
   vista normal. No mantener indefinidamente la portada del looper anterior.
4. Al cambiar de biblioteca, borrar inmediatamente la instantánea anterior.
5. Si la nueva carga de audio falla y la pista anterior sigue sonando, no mostrar
   la portada de la pista fallida ni modificar el estado del reproductor para
   resolver la discrepancia. Conservar solo la instantánea anterior si su ruta
   sigue coincidiendo con la ruta del motor; en caso contrario, salir.

## 6. Capa visual y animación de vuelta

### Estructura

- Mantener montados `Waveform`, `Player` y el resto de la app: no sustituir el
  árbol principal por una pantalla alternativa.
- Renderizar la capa con un portal en `document.body` para evitar recortes por
  `overflow` y contextos de apilamiento de sus padres.
- Contenedor `position: fixed; inset: 0`, fondo opaco y nivel de apilamiento
  coherente con los diálogos. No resolver la convivencia solo subiendo el z-index:
  la regla funcional impide coexistir con otro modal.
- La carátula original permanece en el layout. El overlay usa la misma imagen y
  puede ocultar visualmente la original durante la transición sin quitar su hueco.
- Desactivar arrastre nativo de la imagen ampliada (`draggable={false}`). El
  arrastre normal de la carátula pequeña debe seguir funcionando al salir.

### Geometría

1. Añadir una referencia al contenedor de carátula en `Waveform` y exponerla a
   `App` mediante una prop tipada; no buscar una imagen cualquiera por su `src`.
2. Antes de ampliar, obtener `getBoundingClientRect()` de ese contenedor.
3. Calcular el rectángulo centrado que contiene la imagen dentro del viewport,
   respetando su relación de aspecto natural.
4. Animar la imagen desde el rectángulo pequeño al grande con `transform` y un
   fondo con `opacity`. Duración propuesta: 240 ms, curva suave.
5. Al salir, volver a medir el rectángulo pequeño: la ventana pudo cambiar de
   tamaño y la carátula ya no estará en las mismas coordenadas.
6. Si el destino desapareció, es invisible o tiene tamaño cero, hacer un fundido
   de salida en vez de animar hacia coordenadas inválidas.

Puede usarse CSS o Web Animations API compatible con Safari 14.1. No depender de
View Transitions API ni añadir una librería de animación para este efecto.
Cancelar la animación anterior cuando se solicita la contraria y limpiar todos
sus callbacks. En `resize`, recalcular el destino grande si está visible; si
ocurre durante una transición, terminarla de forma coherente sin saltos de estado.
Con movimiento reducido, resolver la transición inmediatamente y ejecutar la
misma limpieza y restauración de foco.

## 7. Salir sin activar controles ocultos

Mover el ratón tiene que solicitar la salida tanto en `entering` como en
`visible`. No esperar a que termine la ampliación para escuchar la actividad.

Propuesta adicional de accesibilidad: permitir salir con Escape, teclado, clic o
rueda. **La primera interacción solo despierta la vista**:

- Un clic no puede pulsar Play, borrar una pista o iniciar un arrastre que estaba
  debajo de la imagen.
- Espacio/R no deben pausar ni elegir otro loop además de cerrar la vista.
- Interceptar los eventos de despertar en fase de captura, antes de los atajos
  de la app; usar `preventDefault`/`stopPropagation` cuando corresponda.
- No desmontar la capa en `pointerdown` dejando que el `pointerup`/`click` de ese
  mismo gesto llegue a los controles inferiores. Conservar la barrera o suprimir
  explícitamente el resto de ese gesto, incluyendo cancelación de puntero.
- También evitar que autorepeticiones de la tecla usada para despertar ejecuten
  atajos antes de soltarla. No secuestrar atajos reservados del sistema operativo.
- El siguiente gesto independiente, con la vista normal recuperada, ya funciona
  con normalidad.

### Foco y modales

El overlay puede seguir el contrato existente `role="dialog" aria-modal="true"`
con un nombre como `Looper cover` y un botón accesible `Return to player` con
clase `dialog-close`. El texto de ayuda puede ser discreto pero visible y debe
tener contraste suficiente. La imagen debe tener texto alternativo descriptivo.

Reutilizar `useModalFocus`, sin llamar de nuevo al hook por cada overlay. No crear
un segundo sistema independiente de foco/inert. Al salir, restaurar el foco al
control anterior si todavía existe.

Para detectar otros modales, observar la apertura/cierre real y excluir
explícitamente el propio overlay (por ejemplo con `data-idle-cover-overlay`).
Puede usarse un `MutationObserver` acotado a cambios relevantes, con cleanup.
Comprobar que el observer y el hook de foco no se retroalimentan ni confunden el
overlay con un diálogo que impide su propia apertura.

## 8. Orden de trabajo para el programador

Realizar las tareas en este orden, revisando cada bloque antes del siguiente:

1. **Preparar preferencias.** Crear helpers de lectura/escritura, estado en `App`
   retraso y diálogo; abrirlo también desde el menú macOS con `⌘,`. Comprobar
   persistencia tras reiniciar y al cambiar de biblioteca.
2. **Aislar la lógica temporal.** Crear el hook con tiempo configurable en pruebas.
   Implementar primero activación, actividad, foco, visibilidad y cleanup, sin
    animación. El hook admite retrasos cortos inyectados en pruebas; verifica
    también que el retraso elegido se respeta.
3. **Conectar la elegibilidad.** Derivar booleanos e identidades estables desde
   `App`; integrar estado de carátula, modales y arrastres sin reiniciar el timeout
   con cada sondeo del reproductor.
4. **Mostrar la capa estática.** Portal, carátula, bloqueo de controles inferiores,
   foco y salida por ratón/teclado. Verificar que el audio continúa intacto.
5. **Añadir ampliación/encogimiento.** Ref de origen en `Waveform`, geometría,
   cancelación de animación, resize y movimiento reducido.
6. **Resolver cambios en vivo.** Random, MIDI, ausencia de carátula, error de carga,
   pausa, stop y cambio de biblioteca durante la vista ampliada.
7. **Ejecutar pruebas y revisión manual.** Utilizar la matriz siguiente. Actualizar
   el estado de esta spec solo cuando exista implementación verificada.

## 9. Pruebas automatizadas necesarias

Usar Vitest, React Testing Library y temporizadores falsos (`vi.useFakeTimers`),
restaurándolos al terminar. Las pruebas de comportamiento deben cubrir:

| Caso | Resultado esperado |
| --- | --- |
| Preferencia ausente, inválida o almacenamiento inaccesible | Estado inicial desactivado y app utilizable. |
| Preferencia guardada | Se restaura; si falla el guardado, el cambio de sesión sigue aplicado. |
| Opción apagada | No aparece aunque se avance más de 60 minutos. |
| Opción encendida y reproducción elegible | No aparece antes del retraso elegido; aparece al alcanzarlo. |
| Movimiento/tecla/rueda justo antes del plazo | Reinicia el retraso completo; no aparece al cumplirse el plazo anterior. |
| Polling frecuente de posición | No posterga la entrada indefinidamente ni crea múltiples timeouts. |
| Sin audio, pausa, carga inicial o sin portada | No entra. |
| Pausa, blur, ocultación o modal durante la espera | Cancela; volver a ser elegible inicia el retraso elegido de nuevo. |
| Drag o puntero sostenido | No entra en mitad del gesto. |
| Actividad durante `entering` o `visible` | Sale y restaura el foco. |
| Primer clic o Espacio/R con overlay visible | Sale sin activar controles ni comandos de reproducción inferiores. |
| Random automático o MIDI cambia el looper | Conserva la vista y muestra la nueva imagen válida; no reinicia por actividad local ficticia. |
| Respuesta de portada de pista/biblioteca anterior | No sustituye la imagen actual. |
| Nueva portada ausente o fallida | Sale sin imagen rota ni portada ajena persistente. |
| Biblioteca cambia o componente se desmonta | No queda portada antigua, listener ni timeout que reaparezca después. |
| React StrictMode | No hay listeners duplicados ni dos aperturas. |
| Movimiento reducido | Misma funcionalidad sin transición de escala. |

En jsdom simular `getBoundingClientRect`, dimensiones de imagen, foco/visibilidad
y animaciones donde sea necesario. La geometría y fluidez reales se validan en
WebKit: una prueba de DOM no garantiza que la animación se vea correctamente.

## 10. Comprobación manual y entrega

Las casillas siguientes son validación manual de release y no se marcan por
pasar Vitest o por iniciar el bundle; el estado de cobertura automatizada está
resumido en `Estado de implementación` y en la revisión de auditoría enlazada.

- [ ] Elegir un retraso corto (por ejemplo, un minuto), activarlo, reproducir un
  looper con portada y verificar el momento de entrada; comprobar también el
  valor predeterminado de cinco minutos.
- [ ] Mover el ratón dentro de la ventana: se encoge hacia la carátula original.
- [ ] Repetir con ventana redimensionada y con el puntero inicialmente fuera.
- [ ] Probar clic, rueda, Escape, Espacio y R: el primer gesto solo sale; el
  siguiente controla la app normalmente.
- [ ] Verificar que las acciones de MIDI y Random automático siguen funcionando
  y que la imagen corresponde a la pista que suena.
- [ ] Probar pista sin portada, imagen fallida, pausa/stop y cambio de biblioteca.
- [ ] Probar Preferencias y otros diálogos; nunca quedan tapados o sin foco.
- [ ] Abrir Preferencias desde el menú de la aplicación y comprobar el atajo `⌘,`.
- [ ] Probar Alt/Command-Tab, minimizar/restaurar y suspensión/reanudación.
- [ ] Activar movimiento reducido y verificar salida sin escala animada.
- [ ] Desactivar la opción, reiniciar la app y comprobar persistencia.
- [ ] Confirmar que el arrastre de la carátula pequeña a playlists sigue intacto.
- [ ] Comprobar en el WebKit mínimo soportado además del entorno de desarrollo.

Comandos de entrega desde la raíz del proyecto:

```sh
pnpm run typecheck
pnpm test
pnpm run build
git diff --check
```

Usar Node 24 y pnpm 12.9.1, como indica `AGENTS.md`. Para probar la app completa:
`pnpm tauri dev`. No hace falta alterar la versión de release por redactar esta
spec ni añadir dependencias para implementar el contador.

## 11. Criterios de aceptación finales

- [ ] Preferencia accesible, activable/desactivable y persistente.
- [ ] El retraso seleccionado exacto de inactividad elegible muestra la portada correcta.
- [ ] El menú nativo de macOS abre Preferencias con `⌘,`.
- [ ] Mover el ratón dentro de la ventana la devuelve a su posición habitual.
- [ ] Ninguna entrada, salida ni animación modifica el audio o los datos de biblioteca.
- [ ] No hay acciones accidentales sobre controles ocultos.
- [ ] Cambios de looper/biblioteca y respuestas tardías no muestran una portada ajena.
- [ ] Foco, teclado, movimiento reducido y redimensionado funcionan correctamente.
- [ ] Temporizadores/listeners quedan limpios y las pruebas anteriores pasan.
