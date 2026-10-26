# Validación de cierre de auditoría — 2026-10-25

## Estado

Las correcciones A01–A31 están implementadas y las comprobaciones locales pasan.
Este registro distingue las evidencias ejecutadas de las pruebas de dispositivo
que todavía requieren otros entornos. No se declara validación completa de release.

## Entorno y comprobaciones ejecutadas — cierre de auditoría inicial

- Host: Intel x86_64, macOS 12.7.6 (21H1320).
- Pasada final de frontend y empaquetado: Node 24.22.1 y pnpm 12.9.1. Node 24 se
  utilizó mediante `npm exec --yes --package=node@24 -- sh -c '<comando>'`.
- `pnpm install --frozen-lockfile`: correcto.
- `pnpm run typecheck`: correcto.
- `pnpm test`: 53 correctas, 17 archivos.
- `pnpm run build`: correcto; JS 334,13 kB / 98,74 kB gzip.
- `pnpm audit`: ninguna vulnerabilidad conocida.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: correcto.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings`: correcto.
- `cargo test --manifest-path src-tauri/Cargo.toml --locked`: 216 correctas,
  cuatro ignoradas. Incluye IPC con SQLite real, CUEs concurrentes, recuperación,
  cancelación, límites, identidad de caché y precarga sin modificar reproducción.
- `cargo +1.89.0 check --manifest-path src-tauri/Cargo.toml --locked --all-targets`: correcto.
- `python3 scripts/audit-rust-dependencies.py`: 368 paquetes del host, ninguna
  vulnerabilidad accionable; seis avisos de mantenimiento (`paste` y `unic-*`).
- `git diff --check`: correcto.

Las pruebas con archivos reales opcionales no se contabilizan como validación de
fixtures: este checkout no contiene `loopersFlash/` ni se proporcionaron los
archivos de entorno M4A/Serato. Las cuatro pruebas ignoradas permanecen pendientes.

## Artefacto generado — cierre inicial

Este primer artefacto se sustituyó posteriormente en la misma ruta por el bundle
con detección BPM y salvapantallas. Su checksum se conserva como evidencia
histórica; el checksum del paquete actual figura al final de este documento.

- Versión: 0.7.1, sin incremento de versión.
- Compilación: `./scripts/build.sh`, release Universal 2.
- Paquete: `./scripts/package-dmg.sh`.
- Aplicación: `oLooper.app`.
- Imagen: `dist/oLooper-0.7.1-unsigned.dmg`.
- `lipo -archs oLooper.app/Contents/MacOS/olooper`: `x86_64 arm64`.
- `LSMinimumSystemVersion`: `11.0`; es el mínimo declarado, no una prueba en Big Sur.
- `hdiutil verify dist/oLooper-0.7.1-unsigned.dmg`: integridad correcta.
- SHA-256 del DMG:
  `70b808077298d6d10093724c8ca296770695bbd42300ebefb16fb64c16948c4a`.

El DMG es local y sin firma de distribución/notarización. No se publicó ni se
generó un NSIS en este host. Los artefactos permanecen ignorados por Git.

### Arranque del ejecutable release

Se lanzó el ejecutable del bundle durante 30 segundos con `HOME` y
`CFFIXED_USER_HOME` temporales y se terminó únicamente ese proceso. Permaneció
activo, detectó `Built-in Output` y seleccionó estéreo a 44.100 Hz sin error fatal
en la consola. No se importó ni reprodujo audio en esta comprobación.

Muestras `ps` del proceso principal (RSS en KiB; CPU informada por `ps`):

| Tiempo | RSS | CPU |
| --- | ---: | ---: |
| 5 s | 47.632 | 7,1 % |
| 15 s | 44.668 | 0,7 % |
| 30 s | 45.788 | 0,7 % |

Estas muestras no incluyen el conjunto de procesos WebKit y no demuestran el
consumo durante reproducción, la latencia ni la ausencia de fugas a largo plazo.

## Matriz pendiente de dispositivo/release

| Prueba | Ejecución y resultado esperado |
| --- | --- |
| Audio, Next y Random | Importar pistas reales; probar botón, R, temporizador y MIDI tras la precarga. La pista anterior sigue sonando si falla otra carga; no hay cambios de ámbito ni errores ocultos. Medir la latencia, no inferirla de la caché. |
| CUEs y recuperación | Usar copias de audio; guardar CUEs 2–4, reabrir y verificar en Serato que CUE 1 y loops guardados se conservan. Probar cancelación y reinicio durante importación/borrado sin alterar originales externos. |
| Hardware y rutas | Probar salida estéreo/multicanal, desconexión/reconexión y MIDI físico; verificar canales y que eventos de dispositivos anteriores no invaliden la ruta actual. |
| Sesión larga | Con catálogo grande, SWF comprimido, ADPCM, EXE y pitch lock, medir durante varias horas RSS de app + WebKit, CPU, picos de importación y latencia de cambios. Registrar hardware, tamaños y duración. |
| Accesibilidad | Recorrer diálogos con Tab/Shift+Tab/Escape, sliders con teclado y lector de pantalla; no deben escaparse el foco ni activarse atajos de transporte desde un modal. |
| Arrastre nativo | Arrastrar audio gestionado a Finder/otra app, cancelar y repetir; no sobrescribir destinos ni ofrecer extracción nativa de pistas embebidas. |
| macOS 11 / Apple Silicon | Ejecutar el bundle en ambos dispositivos/sistemas; verificar WebKit, audio, permisos y arrastre. La compilación arm64 ya pasó; su ejecución sigue pendiente. |
| Windows / Linux | Ejecutar las suites y la aplicación en los hosts correspondientes. Windows dispone de `check-windows.yml` con build NSIS; no se ejecutó ese workflow en esta pasada local. |
| Distribución firmada | Firmar/notarizar con credenciales de release y probar la instalación del artefacto final. Procedimiento macOS en `macos-release.md`. |

Las muestras privadas SWF/EXE/M4A necesarias deben proporcionarse fuera de Git.
La ejecución de los workflows remotos requiere publicar los cambios; no se ha
hecho commit ni push en esta pasada.

## Actualización posterior: detector BPM, reanálisis y salvapantallas

Se implementaron el detector 4/4 por duración, reanálisis explícito de biblioteca,
looper y playlist, salvapantallas configurable de carátula y editor BPM con
sugerencia individual, mitad/doble y doble clic (specs 250–270).

### Verificación del estado actual

- Rust: **231 pruebas correctas y cuatro ignoradas**; formato, clippy con
  `-D warnings` y `cargo +1.89.0 check --locked --all-targets` correctos.
- Frontend: **89 pruebas correctas en 23 archivos**, typecheck correcto con Node
  24 y pnpm 12.9.1.
- Producción: JS 352,93 kB / 104,55 kB gzip.
- Detector: matriz sintética de 100 combinaciones y casos de frases no habituales,
  estéreo, ruido, silencio, energía sostenida sin ataques y ambigüedad de octava.
- Reanálisis: persistencia y protección concurrente de BPM manual, selección por
  ámbito, cancelación, errores acotados y suscripción previa a la admisión.
- Salvapantallas: contador de cinco minutos, foco/modales, gestos de despertar,
  persistencia, transiciones, movimiento reducido y cambios de imagen tardíos.
- Editor BPM: consulta IPC de solo lectura que analiza el audio completo aunque
  exista una región de práctica, base estable de opciones, confirmación ×1,
  guardado de Tap tempo, entrada manual, errores, foco inicial y doble clic sin
  reproducción/arrastre. Cancelar o recibir una respuesta tardía no modifica el
  borrador. Un guardado de título/etiquetas conserva un BPM concurrente más reciente.
- Bundle release recompilado para `x86_64 arm64`; DMG verificado por `hdiutil`.
- Arranque Intel del bundle final durante 30 segundos con home temporal: proceso
  activo y salida integrada estéreo a 44.100 Hz detectada, sin error fatal de
  consola. Este smoke no reproduce audio ni verifica visualmente la interfaz.

### Paquete actual y prueba manual

- App: `oLooper.app`.
- DMG sin firma: `dist/oLooper-0.7.1-unsigned.dmg`.
- SHA-256 actual:
  `50f1a1a9111dcea599af1136a64b17265a887e5a75de96a2aab2b227ca5ecbb8`.

Para probar BPM, abrir My Library y usar `Reanalyze all BPM`, o seleccionar un
looper/playlist y usar su acción de reanálisis. Los filtros no reducen el ámbito;
los BPM confirmados, conocidos o presentes en tags se conservan y se cuentan como
protegidos. Los errores y resultados parciales aparecen en el panel de progreso.

Para editar individualmente, hacer doble clic sobre el valor BPM o `--` de una
fila. El foco va al campo BPM sin reproducir la pista. Si el tempo era automático
o faltaba, aparecen las opciones sugeridas cuando termina el análisis; el campo
conserva su valor hasta que se elige una opción. Half/Detected/Double siempre son
relativos a la misma base y se filtran por rango y compases completos. Confirmar
con `Save metadata`; `Cancel` no guarda. Para tempos conocidos/manuales se ofrecen
las variantes de `Current` sin reanalizar automáticamente.

Para la carátula, abrir `Preferences`, activar `Show looper cover after 5 minutes
of inactivity`, reproducir un looper con portada y dejar la ventana enfocada cinco
minutos sin interacción. Mover el ratón dentro devuelve la imagen a su sitio.
La opción está desactivada por defecto y se conserva entre inicios.

Sigue pendiente la comparación del detector con loops reales del usuario y la
validación visual/hardware en los dispositivos de la matriz anterior. Los tres
pendientes de desarrollo del editor descritos en la spec 260 están implementados.
La revisión documental/código del 2026-10-26 identificó DOC-A01–A06 abiertos y
DOC-A07 sujeto a validación WebKit; consulta
[`documentation-review-2026-10-26.md`](documentation-review-2026-10-26.md). Las
cifras de validación arriba corresponden al estado posterior a las features y
anterior a probes temporales, ya retirados.
