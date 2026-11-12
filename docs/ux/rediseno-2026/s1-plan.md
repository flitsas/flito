# S1 — Trámites y tránsito: plan de migración al UI Kit 2026 (Épica #14560)

Fase 1 (preparación). Fuente del diseño: `flit` rama `propuesta-2`, `docs/design/propuesta-ui-kit-2026/`
(`propuesta.js`, `datos.js`, `ui-kit-2026.css`). Aún no se toca código de producto; la migración arranca con «S0 LISTO»
y el catálogo de `components/flit/` en `docs/ux/rediseno-2026/README.md`.

## Moldes de la propuesta que aplican

| Molde (hash de la propuesta) | Función en `propuesta.js` | Piezas del kit |
|---|---|---|
| `#tramites` | `vTramites` + `lista()` | Cabecera con miga de pan + acciones píldora, pestañas de estado con línea inferior y conteo, barra de acción («N trámites esperan…»), panel de filtros, tabla con borde `#A9C9FC` (pasa a tarjetas <900 px), placa amarilla, etiqueta de estado con punta, paginador |
| `#traspaso` | `vTraspaso` + `vehiculo()` | Asistente: línea de progreso horizontal (`ol.pasos`, `aria-current="step"`), píldora de datos del trámite (ID / tipo / identificador / estado), tarjeta de vehículo (placa grande + badges), `dl` de fichas, formulario `.campo` con label, cuadro de carga, pie con Anterior / Guardar borrador / acción primaria |
| `#tramite` | `vTramite` | Barra de acción «Faltan N cosas», resumen vehículo + fichas, línea de avance, rejilla 2 col (documentos en `lista-fila` con badge y acción, partes y firmas con avatar de iniciales, actividad en línea de tiempo) |
| `#seguimiento` | `vSeguimiento` | Tarjeta pública: placa, pasos `seg__pasos`, bloques «Qué falta / Qué sigue», nota de privacidad (iniciales, sin documentos) |
| `#organismos` / `#organismo` | `vModulo` (lista + pestañas) | Lista con columna `personas` (nombre + código), estado de radicación (En FLIT / Quipux / Inactivo); detalle con pestañas Trámites (bandeja), Reglas, Requisitos, Preasignación, Usuarios, Configuración (`vConfigForm`) |
| `form:nuevo-tramite`, `form:crear-organismo` | `abrirForm` | Modal blanco con ícono centrado, fondo azul 50 % con desenfoque, tarjetas de modalidad |
| `abrir:consulta` | consulta de placa | Modal de consulta con campo de placa y resultado |

## Por página

| Página / ruta | Molde | Componentes del kit previstos | Specs E2E | Dudas |
|---|---|---|---|---|
| `FlitoTramites` `/flito/tramites` (1226 líneas; techo congelado 1190) | `#tramites` | PageHeader+miga, Tabs de estado, barra de acción, filtros, DataTable→tarjetas, StatusBadge, placa, Pagination, Modal | `flito-tramites.spec`, `-acceso-flit2`, `-estado-flit2`, `-fuente(.mobile)`, `-novedades`, `-sincronizacion` | Partirlo para bajar del techo (subcomponentes en `components/flito/tramites/`); la entrega en lote / sincronización FLIT2 no tiene molde → derivar de barra de acción + modal |
| `TramiteDigital` `/tramite` + `pages/tramite/*` (lista, embudo, dashboard gestor, wizard matrícula, firma, preflight, rechazo OT) | `#tramites` (lista/embudo) y `#traspaso` (wizard de matrícula `steps/`) | Igual que arriba + asistente horizontal | `tramite-wizard.spec`, `tramite-embudo.spec` | Embudo/dashboard gestor: ¿cifras del banner de Inicio o pestañas de estado? Propongo pestañas con conteo + cifras en fila (≥1100 px) |
| `TramiteTraspaso` `/tramite/traspaso` + `components/tramite-traspaso/*` | `#traspaso` | Asistente horizontal (sustituye `TraspasoPasosNav`/`ProgresoTraspasoPills`), píldora del trámite, tarjeta de vehículo, formularios `.campo`, carga de documento, pie de acciones | `tramite-traspaso.spec`, `-f2`, `-f3-paridad`, `-preflight`, `-identidad-sondeo-visor` | Nuestro asistente tiene 6 pasos distintos (Vehículo → Validación legal → Vendedor → Comprador → Comercial → Documentos): se mantienen nuestros pasos con la forma del molde |
| `TransitoBandeja` `/transito` (795 líneas) | `#organismo` pestaña «Trámites» (bandeja) | Lista con barra «N trámites esperan revisión del organismo», selector de secretaría, StatusBadge, tabla→tarjetas | `transito-bandeja.spec` | Selector de secretaría (HU #13426) no está en el molde → control `select` en la barra de filtros |
| `TransitoTraspasoExpediente` `/transito/traspaso?id=` | `#tramite` | Resumen vehículo + fichas, línea de avance, documentos en `lista-fila`, partes, actividad; acciones STT (pago, N° RUNT, cargues) como acciones de cabecera + modales | (cubierto en `tramite-traspaso-f3-paridad` / `transito-bandeja`) | Regeneración de documentos legales: botón `sm` por fila de documento |
| `TransitoOrganismos` `/transito/organismos` | `#organismos` (+ modal `crear-organismo`) | Lista con logo/nombre/código, estado de modalidad (badge), modal de edición con `vConfigForm` | `transito-organismos.spec` | Logo del organismo en la columna `personas`: ¿avatar o iniciales? Propongo logo si existe, iniciales si no |
| `PublicTramitePortal` `/tramite/portal/:token` | `#seguimiento` + formulario/carga de `#traspaso` | Tarjeta pública, pasos, aceptación Ley 1581, cuadro de carga, FirmaCanvas | `public*` (no hay spec propio del portal; ver `enlace-frontera-web.spec`) | Sin shell (pública): fondo y logo del kit; confirmar con integrador si hay `PublicLayout` en S0 |
| `PublicTramiteVerify` `/tramite/verificar` | `#seguimiento` | Tarjeta pública, estado de integridad (badge), eventos en `actividad-linea` | `enlace-frontera-web.spec` | — |
| `PublicManifiesto` `/m/:token` | `#seguimiento` | Tarjeta pública con datos mínimos | `public-manifiesto.spec` | Es RNDC, no trámite: solo forma de tarjeta pública |

## Componentes compartidos del alcance

- `components/flito/{ComboboxTramite,DireccionComprador,FirmaCanvas,Escaner,ValidacionRunt,PanelAsociacion}.tsx`: controles `.control` / `.campo` del kit (label, error con `role="alert"`, radio 9 px, borde 1 px), foco visible.
- `components/flito/tramites/*` (acceso / estado / sincronización FLIT2, novedades): avisos de página (`InlineAlert` del kit), interruptor verde ON / gris OFF, indicadores como etiqueta de estado.
- `components/flito-tramites/FuenteTramite.tsx`: etiqueta de estado.
- `components/identidad/CedulaCaptureOverlay.tsx`: modal del kit (fondo azul 50 % + desenfoque).
- Carga: el cargador del kit (pista + vehículo), no aros.

## Ayuda

`content/ayuda/flito_tramites.md` y `transito_organismos.md`: reescribir los textos que nombran ubicaciones visuales (pestañas, botones, columnas) al terminar cada página (skill `flit-ayuda-flito`).

## Pedidos previsibles al integrador (confirmar contra el catálogo de S0)

1. Asistente de pasos horizontal (`Pasos` con `aria-current="step"`) y píldora de datos del trámite.
2. Tarjeta de vehículo + placa amarilla (normal y grande).
3. Barra de acción («N trámites esperan…» + botón).
4. `lista-fila`, línea de avance y `actividad-linea`.
5. Layout público sin shell (portal, verificar, manifiesto).
6. Cargador del kit y cuadro de carga de archivo.

## Verificación prevista

`npm run typecheck -w apps/web`, `npm run lint`, specs E2E listados arriba (puerto 511), capturas Playwright MCP a 1280 px, 375 px y oscuro en `docs/ux/rediseno-2026/s1/`.
