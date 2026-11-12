# S2 — Plan de migración al UI Kit 2026 (Épica #14560)

Alcance: Impuestos, SOAT, Derechos, Comparendos, Revisiones, Compuerta y Lectura de impuestos.
Rama `FEATURE/14560-davidchica-rediseno-ui-kit-2026-s2`. Fase 1: solo inventario y plan; no se toca producto.

Fuente del diseño: `/home/david/flit/rediseno-2026/BRIEFING-KIT-flit-de.md` (manda) y `flit` rama `propuesta-2`,
`docs/design/propuesta-ui-kit-2026/`. Los valores salen de **`ui-kit-2026.css`** (se carga último y gana, incluido su
bloque final de contraste), **no** de `tokens.css` (propuesta vieja). Por eso: botones = píldoras planas (sin degradado),
modal blanco con ícono centrado (sin franja de color), cabecera de módulo sin círculo turquesa; sombra solo en dock,
menús flotantes, avisos y foco.

**Regla k — solo visual:** no se cambian textos, `aria-*`, handlers, hooks, `fetch` ni estado. Tests E2E: se actualiza
el valor visual, nunca la lógica (regla j). La propuesta es de FLIT (trámites), así que ninguna pantalla nuestra
tiene molde 1:1: se usa el **molde más cercano** por patrón, nombrado por su ruta `#id` en la propuesta.

## Moldes de la propuesta que aplican

| Molde | Dónde está | Qué aporta |
|---|---|---|
| **M-LISTA** `#tramites` (bandeja; simples `#usuarios`, `#log-qx`), datos de `#comparendos` | `datos.js` MODULOS + `lista()` en `propuesta.js` | Cabecera con miga + h1 + texto + acciones; `card` «Listado» con panel de filtros, embudo de chips por estado (ícono de estado + conteo, «Todos»), `barra-accion` del estado pendiente, tabla en contenedor con borde (pasa a tarjetas <900 px), menú «Acciones» por fila, paginador de 10, vacío con ilustración y «Quitar filtros» |
| **M-PESTANAS** `#usuarios` / `#compania` | `pestanas()` | Pestañas de línea inferior, activa en azul, bajo la cabecera |
| **M-DETALLE** `#tramite` | `vTramite()` | Píldora/placa del vehículo, `dl` de datos, `card` por bloque, línea de actividad |
| **M-ASISTENTE** `#traspaso` | `vTraspaso()` | Línea de progreso horizontal (`PasosHorizontal`) con píldora de datos, una primaria por paso |
| **M-CARGA** paso de documentos de `#traspaso` | `.carga` → `.carga--lista` | Zona dashed 1,5 azul → borde verde + fondo verde 10 % (`FileDrop` de S0) |
| **M-FORM** «Nuevo trámite» / «Invitar colaborador» | `abrirForm()` | Modal blanco, ícono centrado, fondo azul 50 % con desenfoque, campos con label, primaria a la derecha |
| **M-SIMULADOR** `#simulador` | `vSimulador()` | Formulario a la izquierda + desglose a la derecha (dos columnas que colapsan <760 px) |
| **M-CONFIG** `vConfigForm()` | config de compañía | Formularios de ajustes en `card`, interruptor verde/gris |
| Estados transversales | `cargandoHtml`, `errorCarga`, `.vacio` | Cargador pista azul + carro + línea turquesa; error con reintento; vacío ilustrado |

## Por página

| Página (ruta) | Molde | Componentes del kit previstos* | Specs E2E | Dudas |
|---|---|---|---|---|
| `FlitoImpuestosShell` (`/flito/impuestos`) | M-PESTANAS | **Una** CabeceraModulo en el shell + Pestanas debajo (D1) | `flito-impuestos.spec` | D1 |
| `FlitoImpuestos` (cola, 825 l., techo 870) | M-LISTA | CabeceraModulo, ChipsFiltro (embudo por fase/semáforo), DataTable, Paginación, StatusBadge, ActionsMenu, InlineAlert (barra-accion), Loader, UiStateBoundary | `flito-impuestos*.spec` (9), `flito-soat-impuestos-*` (3), `flito-soportes-zip` | D2, D3 |
| `FlitoImpuestosCertificar` | M-LISTA (registros) | CabeceraModulo, DataTable, StatusBadge, Button | `flito-impuestos-certificar-sin-tramite` | — |
| `FlitoImpuestosCertificarEditor` | M-SIMULADOR (factura izq. + formulario der.) | Ingreso (campos), Card, Button, InlineAlert, visor PDF existente | ídem | D4 |
| `FlitoSoat` (cola operador) | M-LISTA | CabeceraModulo, ChipsFiltro, DataTable, Paginación, StatusBadge, ActionsMenu, Modal (detalle), Loader | `flito-soat*.spec` (3) | D2 |
| `FlitoSoatSolicitud` (1160 l. brutas) | M-ASISTENTE | PasosHorizontal, Placa, Ingreso, SearchableSelect, Button, InlineAlert, Modal | `flito-soat.spec` | D5 |
| `Soat` (legacy `/soat`) | M-LISTA + M-FORM | idem M-LISTA, Modal | (sin spec propio) | D6 |
| `FlitoDerechos` | M-LISTA + panel de resultado de carga | CabeceraModulo, zona de carga, DataTable, StatusBadge (6 canastas), Pestañas (registrados / sin cruzar) | `flito-derechos` | D7 |
| `FlitoComparendos` + `components/flito/comparendos/` | M-LISTA `#comparendos` (molde directo) + M-PESTANAS (registros/sync/config) + M-DETALLE (panel) + M-CONFIG | ChipsFiltro, DataTable, StatusBadge, Pestañas, Modal/panel, Interruptor | `flito-comparendos*` (11) | D8 |
| `FlitoRevisiones` | M-LISTA + M-DETALLE (confirmación) | DataTable, StatusBadge, Ingreso, InlineAlert («no confiable») | `flito-revisiones` | — |
| `FlitoCompuerta` | M-DETALLE (evaluación de un trámite) | Ingreso (buscar), Card, StatusBadge, InlineAlert | `flito-compuerta` | — |
| `TaxReader` (`/tax-reader`) | M-CARGA | CabeceraModulo, zona de carga | — | — |

\* Nombres del kit de referencia (`flit` develop `packages/ui/src`). El equivalente real en FLITO lo fija
el catálogo `components/flit/` de `docs/ux/rediseno-2026/README.md` (llega con «S0 LISTO»); este plan se
ajusta a él sin inventar componentes propios.

Componentes de dominio en alcance (`components/flito/`): `BarraEnvioSoat`, `CeldaVehiculoSoat`,
`VigenciaSoat`, `DescargarComprobanteSoat`, `CargaRecibosImpuestos`, `DescargarSoporteImpuesto`,
`DetalleImpuesto` (389), `ImpuestoCola`, `ExportarCola` (526), `DescargarCertificadosZip` (351),
`DescargarSoportesZip` (669), `ModalCargaReciboFase`, `RanuraCargaMasiva`, `CorregirAplicado` (396),
`useSondeoAnalisis.ts`, y las carpetas `comparendos/` (26), `soat/` (19), `soat-cliente/` (13 + `masivo/` 9).
~13,8 k líneas en las carpetas. Restos de HEX/Aura detectados en 3 archivos (a limpiar).

## Orden de migración

1. Comparendos (molde directo `#comparendos`, valida ChipsFiltro + DataTable + barra-accion).
2. Cola de Impuestos + shell de pestañas, luego Certificar y su editor.
3. Cola SOAT y `Soat` legacy; luego la solicitud SOAT (asistente).
4. Derechos, Revisiones, Compuerta, TaxReader.
5. Fichas de ayuda (`flit-ayuda-flito`), specs E2E, capturas 1280 / 375 / oscuro en `docs/ux/rediseno-2026/s2/`.

Delegación prevista: `frontend-agent` por bloque (1–4) dentro del worktree, archivos disjuntos.

## Riesgos de tamaño

- `FlitoImpuestos.tsx` tiene techo congelado 870: la migración debe **bajar** líneas; si no cabe, se
  extraen subcomponentes a `components/flito/` (archivo nuevo → consulta al integrador).
- `FlitoSoatSolicitud.tsx` 1160 líneas brutas sin techo propio: vigilar que no pase de 800 netas.

## Dudas — resueltas por el integrador (2026-11-12)

- **D1** Una sola cabecera de módulo en el shell de Impuestos, `Pestanas` debajo (molde `#usuarios`/`#compania`).
- **D2** Embudo de chips por **fase** (estado del flujo); el semáforo va como etiqueta con punta en su columna.
- **D3** `FiltrosInteligentes` / `ThFiltroMulti` pasan al panel de Filtros del kit (lo hace S0); estado en memoria, nunca en URL.
- **D4** S0 trae `FileDrop` (`.carga` → `.carga--lista`) y `VisorPdf`.
- **D5** Sin respuesta explícita: se aplica `PasosHorizontal` solo si la página ya tiene pasos; si es formulario por bloques, se viste por bloques (regla k: no se cambia el flujo).
- **D6** `Soat.tsx` entra completo.
- **D7** Tonos del kit para las 6 canastas: info, warn, ok, radicado, neutro, danger. El orden choca con el sentido actual
  del código (`Registrados=success`, `Sin trámite asociado=active`); propuesta semántica en consulta con `flit-de`:
  Registrados=ok, En revisión=warn, Sin trámite asociado=info, Duplicados=radicado, Páginas omitidas=neutro, Fallidos=danger.
- **D8** El integrador pidió modo cursor para la Paginación del kit.
- Extraer subcomponentes nuevos con prefijo del módulo en `components/flito/` para bajar `FlitoImpuestos.tsx`: aprobado; su
  techo en `eslint.config.mjs` se ajusta **hacia abajo** (solo esa línea).
