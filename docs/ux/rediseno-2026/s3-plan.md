# S3 — Plan de migración al UI Kit 2026 (Épica #14560)

Sesión S3: Logística, tarifas, bolsas, conciliación, finanzas, Siigo y clientes.
Rama `FEATURE/14560-davidchica-rediseno-ui-kit-2026-s3`, worktree `/home/david/flit/flito-rediseno-s3`.
Fase 1 (preparación): este plan, sin tocar código de producto.

Fuente del diseño: `flit` rama `propuesta-2`, `docs/design/propuesta-ui-kit-2026/`
(`propuesta.js`, `ui-kit-2026.css`, `datos.js`). Implementación de referencia: `flit` rama `develop`, `packages/ui/src/*`.

## Moldes de la propuesta (referencia para el mapeo)

| Molde | Dónde está en la propuesta | Piezas |
|---|---|---|
| **M-LISTA** | `lista()` + `vModulo()` (p. ej. `#companias`, `#auditoria`, `#log-qx`) | Cabecera con miga + h1 + texto + acciones (1 primaria, resto secundarias) · `card` con `card__cabeza` · barra de filtros (buscar + botón «Filtros» con conteo, panel con rango de fechas/selects/«Mostrar solo», chips de filtros activos) · **embudo** de chips de estado con conteo (`chip--pendiente` en el estado a atender) · **barra-accion** («N registros … · acción») · tabla en `tabla-wrap` (encabezado `#A9C9FC`, filas con línea, columna «Acciones» con menú) que pasa a tarjetas < 900 px · paginador de 10 · vacío con ilustración + «Quitar filtros» |
| **M-PESTANAS** | `vModulo()` con `pestanas` (`#usuarios`, `#improntas`) | Cabecera + pestañas de línea inferior (activa en azul) + cuerpo M-LISTA o render propio por pestaña |
| **M-TABLERO** | `vInicio()` | Fila de **métricas** (etiqueta, cifra, ícono, pie-enlace; `metrica--pendiente`) · rejilla 2 con **dona** por estado y **barras agrupadas** · tarjetas de accesos y actividad |
| **M-REPORTE** | `vReportes()`, `vReportesIct()` | Pestañas por reporte + métricas + donas + barras horizontales (`barras`) + selector de periodo en `card__cabeza` |
| **M-DETALLE** | `vTramite()` | Cabecera con miga «volver» + acciones · barra-accion «Faltan N cosas…» · card resumen con `dl.detalle__fichas` · `linea` de avance horizontal + píldora de datos · rejilla 2: `lista-fila` (doc/estado/acción) y `actividad-linea` |
| **M-CONFIG** | `vConfigTramite()`, `vProcesos()`, `vConfigForm()` | Card con lista `firmantes` (texto + small + estado + interruptor verde/gris) · formulario en card con `pie-acciones` «Guardar cambios» |
| **M-MODAL-FORM** | `abrirForm()` / `#formulario` | Modal blanco, ícono centrado, fondo azul 50 % con desenfoque, campos con error bajo el campo, pie «Cancelar» (ghost) + primaria; `modal--ancho` para formularios largos |
| **M-MODAL-DETALLE** | `abrirDetalle()` / `#detalle` | Resumen (avatar/placa/ícono + nombre + estado a la derecha) + fichas cielo + pie Cerrar/Editar |
| **M-ASISTENTE** | `vTraspaso()` | Pasos horizontales con línea de progreso + píldora de datos |
| **M-SEGUIMIENTO** | `vSeguimiento()` | Vista móvil sin adornos: avance + datos mínimos |

Componentes del kit (referencia `flit/packages/ui`): `CabeceraModulo`, `Miga`, `Pestanas`, `DataTable`/`table-styles`,
`ChipsFiltro`, `TarjetaMetrica`, `Modal`, `Button`, `StatusBadge`/`statusTones`, `InlineAlert`, `Interruptor`, `Loader`,
`Pagination`/`usePaginacion`, `PasosHorizontal`, `Placa`, `SearchableSelect`, `ActionsMenu`, `UiStateBoundary`, `Icono`.
Los nombres reales en FLITO son los del port del integrador en `components/flit/` (catálogo en `docs/ux/rediseno-2026/README.md`
tras «S0 LISTO»); el mapeo de abajo se ajusta a ese catálogo en la fase 2.

## Inventario y mapeo por página

Tamaños: páginas ~6,5 k líneas; componentes ~30 k (logística 3,7 k · ruta 1,6 k · conciliación 1,1 k · finanzas 7,3 k ·
siigo 6,5 k · clientes 2,6 k · bolsas-documentos 1,0 k · servicios-adicionales 0,4 k · `flito/Bolsa*`+comprobantes+autogestión 5,7 k).

| Página (líneas) | Molde | Kit que usará | Componentes propios que se migran | Specs E2E | Dudas |
|---|---|---|---|---|---|
| `FlitoLogistica` (400) | M-PESTANAS (Viajes · Trámites · Actas · Entregas · Motivos de llegada · En FLIT · Masivo) + M-LISTA por pestaña; bandeja «LT pendientes» como embudo + barra-accion | Cabecera, Pestanas, DataTable, ChipsFiltro, ActionsMenu, StatusBadge, Modal, Toast | `flito/logistica/*` (Tab*, bandeja/, FilaViajeLogistica, LineaTiempoDetalle → `actividad-linea`, ModalAnular/Despachar/Enviar → M-MODAL-FORM, ViajesMasivo, ViajesACliente), `flito/ruta/LlegadaFlit` | `flito-logistica*.spec.ts` (9), `flito-viajes-masivo`, `logistica-bandeja-lt-pendientes` | D1, D2 |
| `FlitoRuta` (224) | M-SEGUIMIENTO / M-ASISTENTE (paso a paso del mensajero, móvil primero) | PasosHorizontal, StatusBadge, Button, Modal | `flito/ruta/*` (PanelRecogida, MisRecogidas, PasoEntrega) | `flito-ruta*.spec.ts` (3) | D3 |
| `FlitoTarifas` (422) + `pages/tarifas/` (1 776) | M-PESTANAS: Matriz · Proveedores · Logística · Historial; matriz como tabla del kit con edición en celda; historial → `actividad-linea` | Pestanas, DataTable, SearchableSelect (sustituye `FlitSelect`), Modal, InlineAlert | `MatrizTarifas`, `TarifasProveedores`, `CostosProveedor`, `HistorialTarifas`, `HistorialCostosProveedor`, `PanelLogistica` | `flito-tarifas*.spec.ts` (3) | D4 |
| `FlitoBolsas` (121) | M-TABLERO (métricas de saldo + lista de bolsas) → M-DETALLE para la compañía | TarjetaMetrica, DataTable, StatusBadge, Modal | `flito/BolsasTablero`, `BolsaDetalleCompania`, `BolsaForm`, `BolsaTransito`, `Bolsa*`, `flito-bolsas-documentos/*` (expediente → `lista-fila`, historial → `actividad-linea`) | `flito-bolsas-*.spec.ts` (6) | — |
| `FlitoComprobantes` (396) | M-LISTA con embudo de estados + M-MODAL-FORM (carga) + M-MODAL-DETALLE | DataTable, ChipsFiltro, Pagination, Modal, StatusBadge, Loader | `CargaComprobantes`, `DetalleComprobante`, `EnvioComprobante`, `ModalReciboCaja`, `ModalReemplazoComprobante` | `flito-comprobantes*.spec.ts` (2) | — |
| `FlitoConciliacion` (290) | M-LISTA (bandeja de boletas, filtro de rango de fechas del panel) + M-MODAL-FORM carga | DataTable, filtros con rango, ChipsFiltro, Modal | `conciliacion/BandejaBoletas`, `CargarBoletaModal` | `flito-conciliacion` | — |
| `FlitoConciliacionBoleta` (233) | M-DETALLE (miga «Conciliación ›», barra-accion de lo que falta, fichas, tabla de cuadre) | Cabecera/Miga, DataTable, StatusBadge, InlineAlert | `AccionesBoleta`, `AvisoConciliada`, `BloqueConciliar`, `ComprobantePse`, `TablaCuadre` | `flito-conciliacion` | — |
| `FlitoBitacora` (100) | M-LISTA (molde `#auditoria`) | DataTable, filtros, Pagination | — | `flito-bitacora` | — |
| `FlitoTablero` (135) | M-TABLERO (métricas + donas «SOAT por estado», «Impuestos por estado») | TarjetaMetrica, dona/barras del kit | — (sustituye `KpiCard`) | `flito-tablero` | D5 |
| `FlitoServiciosAdicionales` (218) | M-LISTA (molde `#tipos-tramite`) + M-MODAL-FORM + confirmación | DataTable, Modal, StatusBadge, Interruptor | `servicios-adicionales/*` | `flito-servicios-adicionales` | — |
| `SiigoCredenciales` (195) | M-CONFIG: una card por ambiente con formulario y estado de conexión | Card/Formulario, Interruptor, StatusBadge, InlineAlert | `siigo/credenciales/*`, `siigo/estilos` (se elimina) | `siigo-credenciales*.spec.ts` (2) | D6 |
| `SiigoOperacion` (335) | M-LISTA (molde `#log-qx`: embudo con «Con error» pendiente + barra-accion «Reintentar los fallidos») + M-MODAL-DETALLE + diálogos | DataTable, ChipsFiltro, ActionsMenu, Modal, InlineAlert (BannerFreno → aviso de página) | `siigo/operacion/*` | `siigo-operacion*.spec.ts` (2) | — |
| `SiigoParametrizacion` (284) | M-PESTANAS: Mapeo de conceptos · Terceros; M-CONFIG / M-LISTA | Pestanas, DataTable, SearchableSelect | `siigo/MapeoConceptos`, `siigo/PanelTerceros` | `siigo-parametrizacion`, `siigo-terceros` | — |
| `FinanzasGastosDiarios` (136) | M-REPORTE (métricas de total + barras por día + lista de tarjetas) | TarjetaMetrica, barras, filtros con rango | `finanzas/gastos-diarios/*` | `finanzas-gastos-diarios` | — |
| `FinanzasReporteCostos` (658) | M-LISTA pesada: métricas (totales/contadores) + filtros + tabla con columnas configurables + exportar; detalle de facturación → M-MODAL-DETALLE; envío → M-MODAL-FORM | TarjetaMetrica, DataTable, filtros, ActionsMenu, Modal, Pagination | `finanzas/*` (35 archivos) | `finanzas-reporte-costos`, `finanzas-envio-facturacion` | D7 |
| `Clients` (392) | M-PESTANAS: Clientes · Proveedores; M-LISTA (molde `#companias`) + M-MODAL-FORM ancho (crear/editar con ficha fiscal) + menú de fila con estado/eliminar | Pestanas, DataTable, ChipsFiltro (activos/inactivos), ActionsMenu, Modal, Toast | `clientes/*` (sustituye `GradientButton`, `MenuFila`) | `clientes-*.spec.ts` (8), `clients-autogestion` | — |

Ayuda a actualizar (skill `flit-ayuda-flito`, fase 2): `flito_logistica.md`, `flito_logistica_ruta.md`, `flito_tarifas.md`,
`flito_bolsas.md`, `flito_bitacora.md`, `flito_tablero.md`, `flito_servicios_adicionales.md`, `flito_comprobantes.md`,
`flito_conciliacion.md`, `finanzas_gastos_diarios.md`, `finanzas_reporte_costos.md`, `siigo_credenciales.md`,
`siigo_operacion.md`, `siigo_parametrizacion.md`, `clients.md`. Solo cambian textos que nombran piezas de la UI
(«pestaña», «botón», ubicación de filtros); el comportamiento no cambia.

## Orden de trabajo (fase 2)

Bloques sin archivos compartidos, delegables en paralelo a `frontend-agent` dentro del worktree:

1. **Logística + Ruta** (`FlitoLogistica`, `FlitoRuta`, `flito/logistica`, `flito/ruta`) — el más grande.
2. **Finanzas** (`FinanzasReporteCostos`, `FinanzasGastosDiarios`, `components/finanzas`).
3. **Siigo** (3 páginas, `components/siigo`).
4. **Bolsas + Comprobantes + Conciliación** (`FlitoBolsas`, `FlitoComprobantes`, `FlitoConciliacion*`, `flito/Bolsa*`, comprobantes, `flito/conciliacion`, `flito-bolsas-documentos`).
5. **Tarifas + Clientes + Bitácora + Tablero + Servicios adicionales**.

Cada bloque: migrar → typecheck → specs E2E del bloque → capturas 1280/375/oscuro en `docs/ux/rediseno-2026/s3/` → ficha de ayuda → commit propio.
Al final: `npm run typecheck -w apps/web` y `npm run lint` sobre el conjunto y HANDOFF al integrador.

## Reglas que se mantienen

- 4 estados por vista; a11y AA; sin HEX sueltos ni restos Aura/`flit-blue-text`/`GradientButton`/`KpiCard`/`PageHeaderCard` viejos.
- No se toca lógica de datos (`lib/api.ts`, hooks de datos): solo presentación. Los `data-testid` y textos accesibles que usan los specs se conservan cuando el diseño lo permite; si cambian, se actualiza el spec en el mismo commit.
- `components/flit/`, `components/shell/`, `App.tsx`, `index.css`, `styles/`, `lib/` → pedidos al integrador.

## Respuestas del integrador y briefing `flit-de` (2026-11-12)

Fuente de valores: **`ui-kit-2026.css`** (gana sobre `tokens.css`). Botones píldora planos (azul avanza, tinta secundario,
verde confirma con texto tinta, naranja `#D44100` en anular/eliminar/rechazar/desactivar), modal blanco con ícono centrado
(sin franja), cabecera sin círculo turquesa, sombra solo en dock/menús/avisos/foco. **Regla k: solo visual.** No se tocan
textos, aria, handlers, hooks, fetch ni estado. Chips propios → `etiquetaKit(tono)`; velos de diálogos propios →
`MODAL_VELO_CLS`/`MODAL_PANEL_CLS`; íconos lucide → `<Icono>`; barrido de HEX/`bg-white`/degradados/sombras a 0.

- **D1** → `Pestanas` con scroll horizontal en 375 px (lo hace S0).
- **D2** → `DataTable` con selección múltiple (lo hace S0).
- **D3** → `FlitoRuta`: molde `#seguimiento` (una columna, para teléfono) con tarjetas `lista-fila`.
- **D4** → matriz de tarifas en **modo «matriz»** del `DataTable` (scroll horizontal en su cuadro por debajo de 900 px). La edición dentro de la celda queda en mi página, con los controles del kit (borde `#A9C9FC`, radio 9, foco azul).
- **D5** → `Dona`/`BarrasGrupo` como componentes (lo hace S0).
- **D6** → campo de clave con «ver» (lo hace S0).
- **D7** → Reporte de costos: modo «matriz» (scroll en su cuadro), no tarjetas.

Íconos del dock para mis módulos (para la cabecera): Logística [ruta], Ruta [marcador], Tarifas [porcentaje], Bolsas [carpeta],
Bitácora [portapapeles], Servicios adicionales [asterisco], Comprobantes [documento], Conciliación [intercambio],
Gastos diarios [calendario], Reporte de costos [reportes], Siigo [integraciones], Clientes [empresas].

## Dudas (resueltas arriba, conservadas como registro)

- **D1.** Logística tiene 7 pestañas: en 375 px la propuesta desliza las pestañas dentro de su cuadro (corte 640 px). ¿El `Pestanas` del port ya trae ese desplazamiento horizontal?
- **D2.** La propuesta no tiene tablas con selección múltiple (viajes masivo, envío de facturación). ¿Hay variante de `DataTable` con casillas y barra-accion de selección, o la pido?
- **D3.** `FlitoRuta` es para el mensajero en celular. ¿Se usa el molde de seguimiento (sin dock) o la página va dentro del shell normal con el menú inferior?
- **D4.** La matriz de tarifas necesita edición en celda (input numérico dentro de la tabla). La propuesta no la define: ¿control `control` del kit dentro de `td`, con la misma altura de fila?
- **D5.** Donas y barras: ¿el port incluye `dona`/`barrasGrupo` como componentes, o los dibujo en la página con los tokens?
- **D6.** Campos secretos (credenciales Siigo): ¿hay variante de campo clave con botón «ver» (`i-ojo` existe en la propuesta)?
- **D7.** Reporte de costos tiene ~20 columnas configurables: en < 900 px la propuesta pasa la tabla a tarjetas. Con tantas columnas, ¿tarjetas con solo las columnas visibles o scroll horizontal del kit?

## Alcance estricto (regla del humano, 2026-11-12)

Aquí solo se hace el rediseño. Un defecto de permisos, lógica o datos que aparezca durante la migración **no se corrige ni se
radica**: se anota en «Hallazgos funcionales (no corregidos)» del HANDOFF al integrador. Los prompts a `frontend-agent` lo llevan.

## Cierre de S3 (2026-11-12)

Capturas de las 15 pantallas a 1280/375 en claro y oscuro (60, datos demo de las fichas de ayuda) en `docs/ux/rediseno-2026/s3/`,
`<pantalla>-<ancho>-<tema>.png`. Fichas de ayuda de las 15 claves con capturas regeneradas y «Cómo se entra» por el dock.

### Defectos del kit S0 vistos (no tocados: los corrige el integrador)

- **`PageHeaderCard` < lg:** el disco del ícono se monta sobre la miga y el h1 en 375 (todas las páginas; p. ej. `clientes-375-claro.png`, `tarifas-375-claro.png`).
- **`.kit-etiqueta` con `nowrap`:** en modo tarjetas, los chips largos de Servicios en Clientes («SOAT · FLITO gestiona · Proveedor…») salen del cuadro y dan desborde horizontal en 375 (`clientes-375-claro.png`).
- **`.card + .card { margin-top }`** también aplica dentro de rejillas de Tailwind: la segunda tarjeta de una fila baja 16–24 px. En Tablero lo resolví con `rejilla rejilla--2` (la clase del kit que lo anula); otras páginas con `FlitCard` hermanas en `grid` pueden tenerlo.
- **Dock flotante** tapa la última fila / la nota al pie en 1280×800 (Clientes · Proveedores, Tablero). En las capturas de ayuda se oculta con `sinBarraFlotante`.

### Fuera de alcance (anotado, no corregido)

- `flito-ayuda-artefactos.spec.ts`: 2 rojos ajenos a S3 — `soat · version` (espera 1.9, la ficha está en 1.10) y `users · version` (espera 1.5, está en 1.6). Son fichas de S2/S6.
- Hallazgos funcionales (permisos, lógica, datos): ninguno nuevo en el bloque 5 (Clientes).
