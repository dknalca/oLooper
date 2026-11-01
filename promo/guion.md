# oLooper — FreeScratch Edition

Promo horizontal de **1920 × 1080, 30 fps**, ajustada a la pista completa
`FreeScratch.mp3`: **79,47 segundos decodificados**. No se recorta la canción,
no se cambia su velocidad y no se añade el antiguo beat sintético.

## Abrir y exportar

Desde la raíz del proyecto:

```sh
node promo/serve.mjs
```

Abre **http://localhost:4173/promo/** en Chrome, Edge, Firefox o Safari actualizado.
No requiere instalar paquetes. El servidor solo escucha en la máquina local y
sirve la promo, las capturas y los iconos necesarios.

- **Reproducir / Pausar:** escucha la pista y revisa el montaje.
- **Barra de posición:** inspecciona cualquier plano; continuar reproduce desde ese punto.
- **Reiniciar:** vuelve al inicio; durante una exportación, la cancela.
- **Silenciar escucha:** silencia los altavoces, sin quitar la música del video exportado.
- **Pantalla completa:** muestra solo el lienzo del video.
- **Exportar video:** comienza desde cero y descarga el montaje con su audio integrado.
  Usa MP4/H.264 cuando el navegador lo admite; en caso contrario, WebM/VP8 o VP9.
- La grabación se realiza en tiempo real: mantén visible la pestaña hasta terminar.
  Si se oculta, se cancela para evitar un archivo con fotogramas congelados.
- Tras exportar queda un enlace de descarga, por si el navegador bloquea la automática.

Si abres `index.html` directamente, puedes seleccionar el MP3 con **Cargar música**
para la vista previa. Usa el servidor local para exportar sin restricciones de
origen del navegador sobre las capturas de pantalla.

## Dirección visual

- Tipografía grande y mensajes cortos, con composición editorial.
- Negro tinta, azul eléctrico y verde lima; un capítulo claro para variar el ritmo visual.
- Capturas **reales** en perspectiva de la biblioteca, importación, transporte y MIDI.
- Movimiento de cámara, acercamientos y revelados de texto; el producto ocupa el plano.
- Sin cabecera, pie, contador de capítulos ni créditos persistentes dentro del video.
- La app aparece desde el primer fotograma y acompaña también el bloque
  «Importa. Encuentra. Dale play.» para presentar el producto inmediatamente.
- Las etiquetas de forma de onda, BPM y cues comparten ancho, alineación y
  separación, en una fila centrada bajo la visualización.
- Espectro circular, medidor y pads reactivos al audio; forma de onda calculada a partir del MP3.
- Sin voz superpuesta, para dejar espacio al scratch de la pista.

Las capturas proceden de `docs/screenshots/` y conservan sus valores y textos
originales; son planos del producto, no una grabación interactiva de una sesión.

## Sincronización

Al iniciar por primera vez, el navegador decodifica y analiza la pista completa:

1. Mide energía y graves en ventanas de 10 ms.
2. Detecta ataques mediante diferencias positivas de energía y filtra los picos demasiado próximos.
3. Estima el tempo por autocorrelación y busca una fase de pulsación. Para este archivo,
   el análisis devuelve aproximadamente **92 BPM**; es una estimación automática.
4. Desplaza cada corte narrativo al ataque cercano más adecuado (ventana de ±0,55 s).
5. Usa el reloj de `AudioContext` tanto para la música como para el montaje,
   evitando la deriva de un temporizador independiente.

Los acentos de cámara responden a los ataques medidos; el espectro se calcula con
FFT a 30 ventanas por segundo y se reutiliza tanto en la vista previa como en el
máster. El cierre visual ocupa los últimos 0,8 s y el audio solo
suaviza sus últimos 150 ms, conservando el final musical completo.

## Exportación máster, fotograma a fotograma

El archivo preparado para visualizar/compartir está en
**`dist/oLooper-FreeScratch.mp4`**: H.264, 1080p, 30 fps, AAC estéreo y 79,47 s.
Se codifica a CRF 22 para mantener buena calidad con un tamaño razonable para
descargar desde el README y la publicación v0.7.1.
Los archivos de `dist/` son locales y están excluidos de Git.

Para regenerar el máster existe `promo/render.mjs`. Renderiza cada instante
`frame / 30` sin depender de la velocidad de reproducción del navegador, y mezcla
directamente el MP3 original con FFmpeg. Así se evitan saltos de captura en equipos
que no consiguen codificar 1080p en tiempo real.

Requiere **Playwright con Chromium** y **ffmpeg-static** como herramientas de
producción. Se pueden instalar fuera del proyecto, sin modificar sus dependencias:

```sh
npm install --prefix /tmp/olooper-promo-tools playwright ffmpeg-static
/tmp/olooper-promo-tools/node_modules/.bin/playwright install chromium
```

Con `node promo/serve.mjs` ejecutándose en otra terminal:

```sh
OLOOPER_RENDER_TOOLS=/tmp/olooper-promo-tools node promo/render.mjs
```

Acepta una ruta de salida como primer argumento. La carpeta de salida debe existir;
la ruta predeterminada es `dist/oLooper-FreeScratch.mp4` y se sobrescribe al renderizar.
`OLOOPER_CHROMIUM_EXECUTABLE` permite indicar un Chromium compatible con el sistema
cuando no se usa el instalado por Playwright. Esta instalación adicional solo es
necesaria para generar el máster, no para reproducir ni exportar desde la página.

## Montaje

Los tiempos siguientes corresponden al análisis de `FreeScratch.mp3` en Chromium;
el navegador puede variar ligeramente la duración decodificada y la estimación.

| Tiempo aproximado | Plano | Mensaje |
| --- | --- | --- |
| 0–4,33 s | Plano de la app desde el inicio y texto de entrada | **Todo empieza con un loop.** |
| 4,33–9,84 s | Tipografía cinética al pulso junto a una captura grande de la app | **IMPORTA. ENCUENTRA. DALE PLAY.** |
| 9,84–20,77 s | Ventana de biblioteca y diálogo de importación en profundidad | **Tus loopers. Nueva vida.** |
| 20,77–32 s | Cambio a fondo claro; acercamiento a la biblioteca | **Menos buscar. Más tocar.** |
| 32–44,07 s | Gran forma de onda del MP3, playhead y acentos | **Siente cada detalle.** |
| 44,07–55,02 s | Dial de pitch, transporte y pulsación del metrónomo | **Tu tempo. Tu progreso.** |
| 55,02–65,90 s | Configuración MIDI real y pads reactivos | **Tus manos. El control.** |
| 65,90–73,75 s | Plano general del producto | **Prepara tu próxima sesión.** |
| 73,75–79,47 s | Marca y cierre | **oLooper. Tu colección. Tu ritmo.** |

## Comprobaciones

```sh
node --check promo/promo.js
node --check promo/audio-analysis.js
node --test promo/audio-analysis.test.mjs
```

`window.promo.draw(segundos)` permite inspeccionar un fotograma mientras la
reproducción está detenida. `window.promo.analysis` expone el tempo estimado,
los ataques y los tiempos de corte para revisar la sincronización.
