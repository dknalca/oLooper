# Auditoría de estabilidad y consumo — 2026-10-25

## Alcance

Revisión del motor de reproducción, importación y preparación de audio, consultas
SQLite, cachés de PCM/contenedores, ciclo de vida de recursos macOS, consultas IPC,
carátulas y dibujo de la onda. Se revisó el código y se ejecutaron pruebas
automatizadas en macOS. No se midieron porcentajes de ahorro de RAM/CPU ni
latencias de reproducción en una sesión de interfaz real.

## Hallazgos corregidos

| Prioridad | Hallazgo | Corrección |
| --- | --- | --- |
| Alta | `get_track` cargaba todas las filas y comprobaba todos los archivos para buscar un solo ID. Este coste se repetía en carga y edición de pistas. | Consulta por clave primaria con la misma proyección de datos; Random de un looper filtra por `source_hash` en SQLite. |
| Alta | Los IDs virtuales `embedded:<id>` podían sobrevivir en la caché PCM al cambiar de catálogo. | Vaciar la caché decodificada al descargar la biblioteca, conservando la invalidación de trabajos pendientes. |
| Alta | Cada consulta macOS de memoria adquiría un derecho Mach del host sin liberarlo. | Liberar el derecho también cuando falla la consulta. Compartir la muestra durante un segundo y evitar contabilizar dos veces las páginas especulativas. |
| Media | Las cachés solo se ajustaban al usarlas, y una inserción demasiado grande podía dejar entradas antiguas por encima del presupuesto. | Mantenimiento cada segundo, incluso sin cambios de pista; recorte antes de rechazar una inserción. Si no hay datos de memoria, presupuesto conservador de 16 MiB como máximo por caché. |
| Media | Importar sin extracción generaba bytes WAV o copiaba audio comprimido que nunca se iba a guardar. | Preparar únicamente PCM y BPM en ese modo. Conservar el recorte MP3 y la equivalencia de muestras. |
| Media | `setInterval` podía iniciar más consultas IPC de estado mientras las anteriores seguían pendientes. | Sondeo serial, recuperación tras errores y cancelación de próximos sondeos; ignorar respuestas de efectos ya desmontados. |
| Media | La onda se repintaba continuamente en pausa y podía reasignar el canvas con escalas fraccionales. | Máximo 30 FPS, omitir estados sin cambios y documentos ocultos, dimensiones físicas redondeadas e interpolación ajustada a velocidad. |
| Media | Las carátulas se solicitaban todas a la vez; una respuesta cancelada podía volver a poblar la caché de otra biblioteca. | Hasta cuatro solicitudes por lote, comprobación de cancelación antes de guardar y eliminación de carátulas de grupos retirados. |
| Media | Random desde All revelaba la pista cambiando de colección; la siguiente elección quedaba limitada al looper elegido. | Revelar la pista aleatoria sin cambiar la colección seleccionada. |
| Baja | Vitest recogía un archivo de pruebas Node del material promocional y fallaba sin suite. | Configuración explícita de las pruebas de aplicación en `src/**/*.test.{ts,tsx}`. |

## Comportamiento de memoria

- PCM: hasta 32 pistas y `min(RAM disponible / 8, 512 MiB)`.
- Contenedores: hasta dos archivos y `min(RAM disponible / 8, 256 MiB)`.
- Esos valores limitan las referencias retenidas en las cachés. El audio activo,
  la decodificación en curso, los lotes de importación y el WebView también
  consumen memoria; 768 MiB no es un límite de RAM total del proceso.
- El recorte no interrumpe la pista activa: sus referencias compartidas siguen
  siendo válidas aunque se retire su entrada de la caché.
- Una consulta fallida usa `min(tope, 16 MiB)`; una disponibilidad cero permite
  vaciar las cachés.

## Verificación inicial (histórica)

- Rust: 196 pruebas correctas y cuatro ignoradas, incluidas regresiones de invalidación de biblioteca,
  recorte de PCM sin perder el buffer activo, inserción de contenedor por encima
  del presupuesto y equivalencia de PCM entre importación extraída/embebida.
- TypeScript: comprobación de tipos y compilación de producción (`pnpm run build`).
- Frontend: `pnpm test`, 35 pruebas correctas, incluidas solicitudes lentas sin solapamiento,
  cancelación durante una solicitud y recuperación tras errores transitorios.
- La verificación ejecutada corresponde al host macOS; las ramas de consulta de
  memoria Windows/Linux no se ejecutaron en este entorno.

## Seguimiento

- Medir RSS, CPU y latencia con bibliotecas grandes, un SWF comprimido real y
  cambios rápidos, tanto en pausa como durante reproducción y pitch lock.
- Resuelto en la auditoría completa: la preparación de importación se limita a un
  sonido, con compuerta compartida para el trabajo intensivo (ADR 0022). Los
  buffers activos siguen sin formar parte del presupuesto de caché; falta medir
  el pico con muestras largas en ejecución real.
- Resuelto en la auditoría completa: la caché persistente de ondas dispone de
  cuota LRU agregada por bytes y entradas, con pruebas de regresión.

## Verificación de cierre

La pasada final reúne 216 pruebas Rust correctas (cuatro ignoradas por falta de
fixtures), 53 pruebas frontend, clippy limpio, MSRV 1.89 y auditorías de
dependencias sin vulnerabilidades accionables. Se compiló y empaquetó Universal 2
y se comprobó el arranque Intel en macOS 12.7.6. Las muestras de reposo no equivalen
a medidas de reproducción ni de una sesión larga. Evidencias, artefacto y matriz
de validaciones externas en [el registro de cierre](audit-validation-2026-10-25.md).

La revisión posterior repitió typecheck, 89 pruebas frontend (23 archivos),
Clippy y 231 pruebas Rust (4 ignoradas). También midió 2.000 eventos y 1.826.898
bytes JSON para 1.000 pistas de BPM fallidas en un harness sin Tauri/WebView. La
revisión identificó carreras de BPM/tag y aislamiento visual por root; véase
[`documentation-review-2026-10-26.md`](documentation-review-2026-10-26.md).
