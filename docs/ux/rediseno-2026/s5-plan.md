# S5 — Cumplimiento (PESV, LAFT, RNDC, Privacidad) · plan de migración al UI Kit 2026

Épica ADO #14560 · rama `FEATURE/14560-davidchica-rediseno-ui-kit-2026-s5` · fase 1 (preparación, sin código de producto).

Fuente del diseño: `flit` rama `propuesta-2`, `docs/design/propuesta-ui-kit-2026/` (README, `propuesta.js`,
`ui-kit-2026.css`). Implementación de referencia: `flit` rama `develop`, `packages/ui/src/*`.

## Moldes de la propuesta que aplican

La propuesta no trae pantallas de PESV, LAFT, RNDC ni privacidad (es FLIT 2.0). Se aplican sus **moldes genéricos**:

| Molde | Dónde está en la propuesta | Qué fija |
|---|---|---|
| **M-LISTA** | `lista()` + `vModulo()` (p. ej. `#auditoria`, `#usuarios`, `#quipux`) | Cabecera con miga de pan (niveles anteriores en gris, actual en azul con línea) + acciones píldora; `card` «Listado» con panel de filtros (texto, select, rango con presets Hoy/7 d/Mes/Año, sí/no) que viven en la URL; chips de estado con conteo («embudo»); `barra-accion`; tabla en contenedor con borde, encabezado `#A9C9FC`, columna «Acciones» con menú; paginador de 10; vacío con ilustración + «Quitar filtros». Bajo 900 px la tabla pasa a tarjetas (`data-etiqueta`) |
| **M-PESTAÑAS** | `vModulo()` con `m.pestanas` | Pestañas de línea inferior, activa en azul, `?tab=` en la URL; cada pestaña es un M-LISTA o un render propio |
| **M-TABLERO** | `vReportes()` / `vInicio()` | Fila de `metricas` (etiqueta, cifra, ícono del kit, pie «Ver el detalle»); `rejilla--3` de `card` con dona por estado; `card` con barras/tendencia; selector de periodo en línea |
| **M-DETALLE** | `vTramite()` | Cabecera con «volver», `barra-accion` con lo que falta, `card` resumen con `dl` de fichas, `linea` de avance horizontal + píldora de datos (ID, tipo, identificador, estado), `rejilla--2` con `lista-fila` (documentos/partes con badge y acción `sm`) y `actividad-linea` |
| **M-ASISTENTE** | `vTraspaso()` | Línea de progreso horizontal con la píldora de datos del trámite; `pie-acciones` |
| **M-FORM** | `vConfigForm()` / `vConfigTramite()` / `abrirForm()` | `formulario` en `card` con `campo` (label + `control`), `pie-acciones` con primaria a la derecha; interruptores verde ON / gris OFF (`firmantes`) |
| **M-MODAL** | `abrirForm()` / `abrirDetalle()` | Contenedor blanco, ícono centrado, fondo azul al 50 % con desenfoque; sin sombra |
| **M-AYUDA** | `vAyuda()` | Buscador en `card` + `accesos` (tarjetas con ilustración) — para documentos/manuales descargables |

Comunes a todas: estados con etiqueta con punta + ícono de estado + color semántico al 10 %; botones píldora (azul avanza,
verde confirma, azul oscuro navega, naranja alerta); bordes `#A9C9FC` 1 px radio 9; sin sombras en tarjetas; carga = pista
azul con vehículo y línea turquesa (no aro); separaciones 4/8/16/24/32; cortes 1100/900/760/640/380.

## Por página

Componentes nombrados con el vocabulario de la propuesta; el nombre real en `components/flit/` lo fijo con el catálogo de
`docs/ux/rediseno-2026/README.md` al recibir «S0 LISTO». Hoy todas usan `PageHeaderCard`, `GradientButton`, `StatusChip`,
`FlitModal` (piezas viejas que salen).

### PESV (16)

| Página | Molde | Componentes del kit | Specs E2E | Dudas / notas |
|---|---|---|---|---|
| PesvDashboard | M-TABLERO | Cabecera, Métricas, Card+Dona, Barras, Tabla, Etiqueta | `pesv-stats-siniestros`, `pesv-s9-menores` | Tiene 1 tabla y secciones: ¿donas por estándar o barras? → barras horizontales (`barras`) para % de cumplimiento |
| PesvTablero | M-TABLERO | Métricas, Card (Documentos, Jornadas, Rutas, detalle estándares), Etiqueta, Botón | `pesv-s9-menores` | Solapa con Dashboard; se mantienen las dos (no se unifica) |
| PesvDiagnostico | M-DETALLE (+ M-MODAL) | Cabecera con acciones, barra-acción, lista-fila por ítem, Modal (crear, cierre), Drawer evaluación | `pesv-diagnostico-*` (7 specs), `pesv-permiso-por-item` | El drawer de evaluación no tiene molde: ¿el kit trae panel lateral? → pedir al integrador o usar Modal ancho |
| PesvDiagnosticoAuditoria | M-DETALLE | Cabecera con volver, `actividad-linea`, Tabla, Modal | `pesv-diagnostico-auditor-readonly` | Usa `ModalPortal` directo |
| PesvAuditorias | M-LISTA | Cabecera, Filtros, Chips de estado, Tabla, Modal form | `pesv-auditorias` | — |
| PesvContratistas | M-LISTA | ídem | — | — |
| PesvNormativa | M-LISTA | ídem | — | — |
| PesvPolicy | M-LISTA + M-FORM | Tabla de versiones, Modal | — | — |
| PesvRaci | M-LISTA (2 tablas) | Tabla matriz, Modal | — | Matriz RACI ancha: scroll del kit en tabla o tarjetas bajo 900 px |
| PesvRetencion | M-PESTAÑAS → M-LISTA | Pestañas, Tabla ×2, Modal | — | — |
| PesvRoutes | M-LISTA + M-FORM | Tabla, Modal form largo (12 controles), íconos `flit/icons` | — | Íconos viejos → `kit-iconos` vía el kit |
| PesvLogPii | M-LISTA | Filtro rango con presets, Tabla, Paginador | `privacy-log-pii-rango` | Filtros con PII nunca en la URL de la web (regla 14): el patrón «filtros en la dirección» de la propuesta **no** se aplica a filtros con PII; sí a fechas |
| PesvComite | M-LISTA (tarjetas) | Card por comité + lista-fila de actas, Modal | — | — |
| PesvComunicaciones | M-LISTA (tarjetas) | Card, lista-fila, Modal | — | — |
| PesvPernocta | M-FORM + M-LISTA | Form, Etiqueta, Modal | — | — |
| PesvPlan | M-LISTA (tarjetas) | Card, Modal | — | — |

Componentes `components/pesv/`: `DiagnosticoCierreModal`, `DiagnosticoCrearModal` → M-MODAL; `DiagnosticoEvaluacionDrawer` →
ver duda; `EvidenciaUploader` → zona de carga del kit (ícono `archivo-subir`/`nube-subir`); `RubricaRadioGroup` → radios del kit
con foco visible; `DriverDocumentsPanel` → `lista-fila`; `diagnostico-helpers`, `shared`, `icons` → cambiar tonos e íconos al kit.

### LAFT (7)

| Página | Molde | Componentes | Specs | Dudas |
|---|---|---|---|---|
| Laft | M-PESTAÑAS → M-LISTA + M-DETALLE | Tabla contrapartes, Filtros, `CounterpartyDetail` (M-DETALLE), `CounterpartyForm` (M-FORM), `ListsPanel` (M-LISTA) | `laft-smoke-vistas`, `laft-listados-error`, `laft-acceso` | Usa `flitPageKit` (pieza vieja) |
| LaftDashboard | M-TABLERO | Métricas, Card | `laft-smoke-vistas` | — |
| LaftUnusual | M-LISTA + M-MODAL | Chips de estado, Tabla, Modal | `laft-unusual-error` | 2 HEX en un comentario (tokens `--flit-danger*`); se van con los tokens nuevos |
| LaftTrainings | M-LISTA + M-MODAL | Tabla, Modal | `laft-smoke-vistas` | — |
| LaftAuditPlan | M-LISTA | Tabla, Etiqueta | `laft-smoke-vistas` | — |
| LaftOfficer | M-LISTA | Tabla, Etiqueta | `laft-smoke-vistas` | — |
| LaftManual | M-AYUDA / M-LISTA | Accesos o Tabla con descarga | `laft-manual-descarga` | ¿tarjetas `accesos` o tabla de versiones? → tabla (es versionado) |

### Privacidad (1)

| Página | Molde | Componentes | Specs | Dudas |
|---|---|---|---|---|
| Privacy | M-PESTAÑAS → M-LISTA + M-MODAL | Pestañas, Tabla, Modal, Form | `privacy-smoke-vistas`, `privacy-acceso` | Ayuda: `privacy.md`, `privacy_log_pii.md` |

### RNDC (8)

| Página | Molde | Componentes | Specs | Dudas |
|---|---|---|---|---|
| RndcDashboard | M-TABLERO | Métricas, Card, Dona por estado | — | — |
| RndcManifiestos | M-LISTA | Filtros, Chips de estado, Tabla, Paginador | `rndc-manifiestos` | — |
| RndcManifiestoDetail | M-DETALLE | Cabecera con volver, `linea` de avance (borrador→enviado→aceptado), píldora (consecutivo, tipo, placa), lista-fila de remesas | `rndc-manifiestos` | Placa en la píldora sí (dato del manifiesto, no PII en URL) |
| RndcManifiestoWizard | M-ASISTENTE | Línea de progreso horizontal, Form, pie-acciones | `rndc-manifiestos` | — |
| RndcRemesas | M-LISTA | ídem | `rndc-remesas` | — |
| RndcRemesaForm | M-FORM | Form, Select con estado (`opcionesConEstado`), pie-acciones | `rndc-remesas` | — |
| RndcMaestros | M-PESTAÑAS → M-LISTA | Pestañas (muchas), Tabla, Modal | — | Muchas pestañas: en teléfono se deslizan dentro de su cuadro |
| RndcAdminCredenciales | M-FORM + M-LISTA | Tabla, Form, interruptor verde/gris | — | Nunca mostrar el secreto en claro |

## Specs E2E que tocaré (21)

`laft-acceso`, `laft-listados-error`, `laft-manual-descarga`, `laft-smoke-vistas`, `laft-unusual-error`, `pesv-auditorias`,
`pesv-diagnostico-a11y`, `pesv-diagnostico-auditor-readonly`, `pesv-diagnostico-cierre-preflight`, `pesv-diagnostico-crear`,
`pesv-diagnostico-evidencia-upload`, `pesv-diagnostico-optimistic-conflict`, `pesv-diagnostico-rubrica`,
`pesv-permiso-por-item`, `pesv-s9-menores`, `pesv-stats-siniestros`, `privacy-acceso`, `privacy-log-pii-rango`,
`privacy-smoke-vistas`, `rndc-manifiestos`, `rndc-remesas`. Criterio: se conservan selectores por rol/label; los que
dependan de clases o textos de Aura se ajustan a la UI nueva.

## Decisiones fijadas (integrador + briefing `flit-de`, 2026-11-12)

Fuente: `/home/david/flit/rediseno-2026/BRIEFING-KIT-flit-de.md`. Manda sobre lo anterior de este plan.

- **Valores del kit:** salen de `ui-kit-2026.css` (gana sobre `tokens.css`/`propuesta.css`). Sin botón degradado (píldoras
  planas), modal blanco con ícono centrado (sin franja de color), sin círculo turquesa en la cabecera de módulo.
- **Regla k — solo visual:** no se cambian textos, `aria-*`, handlers, hooks, `fetch` ni estado. Los specs E2E se ajustan
  solo en el valor visual que comprueben, nunca en la lógica (regla j).
- **Íconos:** grupo Cumplimiento [escudo]; PESV [medidor], LAFT [identidad], RNDC [fuentes-oficiales], Privacidad
  [candado]. Subpáginas con glifos existentes de `kit-iconos.js` sin repetir los de módulo ni usar check/flechas/punto; si
  ninguno sirve, se le pregunta a `flit-de`.
- **Drawer:** S0 lo provee con el estilo del modal → `DiagnosticoEvaluacionDrawer` lo usa (duda 1 cerrada).
- **Carga de archivos:** `FileDrop` del kit → `EvidenciaUploader` (duda 2 cerrada).
- **Filtros:** el panel guarda estado en memoria/local, **nunca** en la URL (duda 3 cerrada).
- **Matrices anchas** (RACI, maestros RNDC si aplica): modo «matriz» del `DataTable`, scroll horizontal dentro de su
  cuadro. Listas normales → tarjetas bajo 900 px (duda 5 cerrada).
- **Pantallas molde** (rutas hash de la propuesta): tablero → `#inicio`/`#reportes`; lista → `#tramites` (simples
  `#usuarios`, `#log-qx`); detalle → `#tramite`; asistente → `#traspaso`; formulario en modal → «Nuevo trámite» de
  `#tramites`; carga → paso de documentos de `#traspaso`; estados vacío/error/cargando → `.vacio` / `UiStateBoundary`.
- **Errores típicos a evitar:** chips propios → `etiquetaKit(tono)`; velos de diálogos propios → `MODAL_VELO_CLS` /
  `MODAL_PANEL_CLS`; pasos con la línea por el centro de los círculos; barrido final de HEX, `bg-white`, degradados y
  sombras = 0 en la zona.

## Dudas abiertas

Ninguna bloqueante. Glifos de subpáginas: se eligen al migrar y, si alguno no encaja, se consulta a `flit-de`.

## Puertos y capturas

App local en el puerto **515** (`npm run dev -w apps/web -- --port 515`; si el SO lo rechaza por ser <1024, uso 5155 y lo
declaro). Capturas en `docs/ux/rediseno-2026/s5/` a 1280 px, 375 px y tema oscuro, contra el molde de la propuesta.

## Hallazgos funcionales (no corregidos)

Regla del humano (2026-11-12): aquí solo se rediseña. Un defecto de permisos, lógica o datos no se corrige ni se radica;
se anota aquí y pasa a la sección del mismo nombre del HANDOFF.

- (ninguno aún)
