# Barrido responsive — defectos por página y ancho

Épica #14560, sesión B. Generado 2026-11-13 con un spec temporal (Playwright, `/api` mockeado con las fixtures demo de `e2e/helpers/datos-demo.ts`; lo que no tiene fixture responde `[]`). Viewport de 900 px de alto, sesión admin E2E.

Leyenda: **+Npx** = desborde horizontal del documento (`scrollWidth − clientWidth`); *N fuera* = controles con borde fuera del viewport sin un contenedor con scroll que los acoja; *recort.* = controles con texto cortado (`overflow-x: hidden` y `scrollWidth > clientWidth`); *err* = excepción JS; *redir* = la ruta redirigió (permiso/parámetro demo). Columnas oscuro: 390 y 1280.

**Resumen:** 103 rutas × 8 variantes = 824 capturas. Con desborde horizontal: 3. Con controles fuera del viewport: 7. Con controles recortados: 0.

> **Re-barrido con fixtures propias.** En la primera pasada, 44 rutas de flota, mantenimiento, repuestos, PESV, RNDC, `/laft/unusual`, `/flito/conciliacion/:id` y `/admin/tramites-metricas` cayeron en la pantalla de error porque el mock no tenía sus datos. Se añadieron fixtures demo para ellas (64 endpoints) y se re-barrieron: ahora cargan con datos en las 8 variantes y la tabla de abajo ya refleja esa segunda pasada. Bolsas, SOAT e Impuestos siguen en estado vacío por falta de fixture de lista.

## Revisión a ojo (lo que la métrica no mide)

Páginas de más uso revisadas a 390, 768 y 1024 (claro): Tablero, Gestión Trámites, SOAT, Impuestos, Logística, Comprobantes, Comparendos, Reporte de costos, Usuarios, Bolsas; y tras el re-barrido Flota, detalle de vehículo, Órdenes de trabajo, Conductores y Tablero PESV, Nuevo checklist, Manifiestos y Nueva remesa. Agrupado por pieza del kit, que es donde va el arreglo:

| # | Pieza | Defecto | Dónde se ve | Ancho |
|---|---|---|---|---|
| V1 | `FiltroSegmentado` (grupo de píldoras) | El contenedor `rounded-full` envuelve a 2–3 filas y queda un óvalo deforme; en otras pantallas no envuelve y corta la última opción sin scroll visible («Incomplet…») | Logística, Comprobantes, Reporte de costos, Usuarios (Usuarios/Historial bien) | 360–768 |
| V2 | `DataTable` modo matriz en tablet | A 768 y 1024 varias tablas siguen en matriz con 7–9 columnas: textos partidos palabra por palabra («Secretaría / de / Movilidad / de / Manizales»), columna Acciones/Comprador cortada a la derecha | Trámites (768/1024), Logística (1024), Comprobantes (768), Usuarios (1024, Acciones cortadas), Comparendos (1024) | 768–1024 |
| V3 | `DataTable` matriz en teléfono | Comprobantes y Reporte de costos muestran la matriz con scroll lateral a 390 en vez de tarjetas | Comprobantes, Reporte de costos | 360–390 |
| V4 | Tarjetas en tablet | En modo tarjetas a 768 cada tarjeta ocupa el ancho entero (una columna) con mucho aire; Usuarios ya usa 2 columnas y se ve mejor | Logística, Trámites (390→768) | 768 |
| V5 | Cabecera + acción secundaria con nota | «Exportar a Excel» + su nota + casilla quedan en un bloque suelto, alineado a la derecha y desconectado de la primaria; a 390 la primaria de Impuestos no ocupa el ancho (SOAT sí) | SOAT, Impuestos, Comparendos (768: botón centrado bajo la descripción) | 390–1024 |
| V6 | `Pestanas` | En teléfono la última pestaña sale cortada («ACT…», «CONFIG…») sin pista de que hay scroll | Logística, Comparendos | 360–390 |
| V7 | Barra de filtros en teléfono | Cada filtro ocupa una fila: 4–6 filas de controles antes del primer dato (Trámites: buscador, Vista, Creado, Aprobado, Todas/Autogestionadas, Fuente, Orden) | Trámites, Comparendos, Comprobantes | 360–390 |
| V8 | Calendario de `RangoFechas` | El desplegable mide 441 px y se sale a la derecha | Trámites (390), Reporte de costos (360–768) | 360–768 |
| V9 | Objetivos táctiles | Por debajo de 1024, 60–75 % de los controles miden <44 px (chips, enlaces de tabla, paginación) | Todas | <1024 |
| V10 | Fila de KPIs | 5 `KpiCard` en una sola fila a 768: cifras partidas («80.0 / %») y etiquetas cortadas a mitad de palabra («VERIFICA / R») | Tablero ejecutivo PESV | 768 |
| V11 | Ancho del contenedor | En formularios (Nueva remesa, Nuevo checklist) la cabecera y el formulario usan un ancho máximo distinto del resto de páginas y quedan desalineados con la barra a 1024 | RNDC remesa nueva, PESV checklist nuevo | 1024+ |

Lo que sí está bien y sirve de referencia: Flota, Órdenes de trabajo y Manifiestos pasan a tarjetas en 2 columnas a 768 y a matriz a 1024 sin cortes. V2 también se ve en Conductores PESV a 1024 (columna Contrato cortada, «LIC-DEMO-1» partido); V5 en Manifiestos a 390 (primaria sin ancho completo); V6 en el detalle de vehículo a 390 (Documentos y Pasaporte ocultas).

| Ruta | 360 | 390 | 768 | 1024 | 1280 | 1440 | 390 osc. | 1280 osc. | táctil <44px (390) |
|---|---|---|---|---|---|---|---|---|---|
| `/` | ok | ok | ok | ok | ok | ok | ok | ok | 13/21 |
| `/admin/rendimiento` | ok | ok | ok | ok | ok | ok | ok | ok | 17/22 |
| `/admin/tramites-metricas` | ok | ok | ok | ok | ok | ok | ok | ok | 17/22 |
| `/clients` | ok | ok | ok | ok | ok | ok | ok | ok | 22/27 |
| `/drive` | ok | ok | ok | ok | ok | ok | ok | ok | 14/20 |
| `/finanzas/gastos-diarios` | ok | **+17px** | ok | ok | ok | ok | **+17px** | ok | 66/70 |
| `/finanzas/reporte-costos` | 2 fuera | 2 fuera | 8 fuera | ok | ok | 8 fuera | 2 fuera | ok | 155/177 |
| `/fleet` | ok | ok | ok | ok | ok | ok | ok | ok | 20/27 |
| `/fleet/demo-1` | ok | ok | ok | ok | ok | ok | ok | ok | 15/24 |
| `/flito/ayuda` | ok | ok | ok | ok | ok | ok | ok | ok | 15/47 |
| `/flito/ayuda/demo-1` | ok | ok | ok | ok | ok | ok | ok | ok | 15/20 |
| `/flito/bitacora` | ok | ok | ok | ok | ok | ok | ok | ok | 21/25 |
| `/flito/bolsas` | ok | ok | ok | ok | ok | ok | ok | ok | 13/17 |
| `/flito/comparendos` | ok | ok | ok | ok | ok | ok | ok | ok | 27/37 |
| `/flito/comprobantes` | ok | ok | ok | ok | ok | ok | ok | ok | 22/36 |
| `/flito/compuerta` | ok | ok | ok | ok | ok | ok | ok | ok | 14/18 |
| `/flito/conciliacion` | ok | ok | ok | ok | ok | ok | ok | ok | 58/66 |
| `/flito/conciliacion/demo-1` | ok | ok | ok | ok | ok | ok | ok | ok | 16/25 |
| `/flito/derechos` | ok | ok | ok | ok | ok | ok | ok | ok | 20/33 |
| `/flito/impuestos` | ok | ok | ok | ok | ok | ok | ok | ok | 15/27 |
| `/flito/impuestos/certificar` | ok | ok | ok | ok | ok | ok | ok | ok | 13/18 |
| `/flito/logistica` | **+7px** | ok | ok | ok | ok | ok | ok | ok | 25/37 |
| `/flito/revisiones` | ok | ok | ok | ok | ok | ok | ok | ok | 14/21 |
| `/flito/ruta` | ok | ok | ok | ok | ok | ok | ok | ok | 14/22 |
| `/flito/servicios-adicionales` | ok | ok | ok | ok | ok | ok | ok | ok | 16/22 |
| `/flito/soat` | ok | ok | ok | ok | ok | ok | ok | ok | 25/32 |
| `/flito/soat/solicitud` | ok | ok | ok | ok | ok | ok | ok | ok | 14/18 |
| `/flito/tablero` | ok | ok | ok | ok | ok | ok | ok | ok | 13/21 |
| `/flito/tarifas` | ok | ok | ok | ok | ok | ok | ok | ok | 22/26 |
| `/flito/tarifas/demo-1` | ok | ok | ok | ok | ok | ok | ok | ok | 22/26 |
| `/flito/tarifas/proveedores` | ok | ok | ok | ok | ok | ok | ok | ok | 18/22 |
| `/flito/tarifas/proveedores/demo-1` | ok | ok | ok | ok | ok | ok | ok | ok | 20/24 |
| `/flito/tramites` | ok | 7 fuera | ok | ok | ok | ok | 7 fuera | ok | 93/132 |
| `/laft` | ok | ok | ok | ok | ok | ok | ok | ok | 14/23 |
| `/laft/manual` | ok | ok | ok | ok | ok | ok | ok | ok | 15/19 |
| `/laft/oficial` | ok | ok | ok | ok | ok | ok | ok | ok | 15/19 |
| `/laft/plan-auditorias` | ok | ok | ok | ok | ok | ok | ok | ok | 15/19 |
| `/laft/tablero` | ok | ok | ok | ok | ok | ok | ok | ok | 15/19 |
| `/laft/trainings` | ok | ok | ok | ok | ok | ok | ok | ok | 15/20 |
| `/laft/unusual` | ok | ok | ok | ok | ok | ok | ok | ok | 18/24 |
| `/login` | ok | ok | ok | ok | ok | ok | ok | ok | 1/4 |
| `/maintenance` | ok | ok | ok | ok | ok | ok | ok | ok | 21/29 |
| `/maintenance/indicators` | ok | ok | ok | ok | ok | ok | ok | ok | 21/28 |
| `/maintenance/routines` | ok | ok | ok | ok | ok | ok | ok | ok | 15/20 |
| `/maintenance/schedule` | ok | ok | ok | ok | ok | ok | ok | ok | 25/30 |
| `/maintenance/work-orders` | ok | ok | ok | ok | ok | ok | ok | ok | 24/29 |
| `/maintenance/work-orders/demo-1` | ok | ok | ok | ok | ok | ok | ok | ok | 21/27 |
| `/parts` | ok | ok | ok | ok | ok | ok | ok | ok | 19/26 |
| `/perfil` | ok | ok | ok | ok | ok | ok | ok | ok | 14/19 |
| `/pesv` | ok | ok | ok | ok | ok | ok | ok | ok | 19/24 |
| `/pesv/alcoholimetria` | ok | ok | ok | ok | ok | ok | ok | ok | 15/20 |
| `/pesv/auditorias` | ok | ok | ok | ok | ok | ok | ok | ok | 18/23 |
| `/pesv/capacitaciones` | ok | ok | ok | ok | ok | ok | ok | ok | 15/20 |
| `/pesv/checklists` | ok | ok | ok | ok | ok | ok | ok | ok | 27/32 |
| `/pesv/checklists/nuevo` | ok | ok | ok | ok | ok | ok | ok | ok | 18/27 |
| `/pesv/comite` | ok | ok | ok | ok | ok | ok | ok | ok | 15/22 |
| `/pesv/comunicaciones` | ok | ok | ok | ok | ok | ok | ok | ok | 21/26 |
| `/pesv/conductores` | ok | ok | ok | ok | ok | ok | ok | ok | 23/30 |
| `/pesv/conductores/demo-1` | ok | ok | ok | ok | ok | ok | ok | ok | 16/24 |
| `/pesv/contratistas` | ok | ok | ok | ok | ok | ok | ok | ok | 15/20 |
| `/pesv/diagnostico` | ok | ok | ok | ok | ok | ok | ok | ok | 15/21 |
| `/pesv/diagnostico/demo-1` | ok | ok | ok | ok | ok | ok | ok | ok | 22/53 |
| `/pesv/diagnostico/demo-1/auditoria` | ok | ok | ok | ok | ok | ok | ok | ok | 13/17 |
| `/pesv/emergencias` | ok | ok | ok | ok | ok | ok | ok | ok | 18/26 |
| `/pesv/incidentes` | ok | ok | ok | ok | ok | ok | ok | ok | 27/36 |
| `/pesv/incidentes/stats` | ok | ok | ok | ok | ok | ok | ok | ok | 16/22 |
| `/pesv/jornadas` | ok | ok | ok | ok | ok | ok | ok | ok | 18/24 |
| `/pesv/mi-jornada` | ok | ok | ok | ok | ok | ok | ok | ok | 13/19 |
| `/pesv/normativa` | ok | ok | ok | ok | ok | ok | ok | ok | 16/21 |
| `/pesv/operacion-indicadores` | ok | ok | ok | ok | ok | ok | ok | ok | 21/28 |
| `/pesv/pernocta` | ok | ok | ok | ok | ok | ok | ok | ok | 18/23 |
| `/pesv/plan` | ok | ok | ok | ok | ok | ok | ok | ok | 16/21 |
| `/pesv/politica` | ok | ok | ok | ok | ok | ok | ok | ok | 16/21 |
| `/pesv/raci` | ok | ok | ok | ok | ok | ok | ok | ok | 15/21 |
| `/pesv/reportar` | ok | ok | ok | ok | ok | ok | ok | ok | 15/25 |
| `/pesv/retencion` | ok | ok | ok | ok | ok | ok | ok | ok | 20/25 |
| `/pesv/rutas` | ok | ok | ok | ok | ok | ok | ok | ok | 19/24 |
| `/pesv/tablero` | ok | ok | ok | ok | ok | ok | ok | ok | 15/20 |
| `/privacy` | ok | ok | ok | ok | ok | ok | ok | ok | 15/20 |
| `/privacy/log-pii` | ok | ok | ok | ok | ok | ok | ok | ok | 20/25 |
| `/rndc` | ok | ok | ok | ok | ok | ok | ok | ok | 14/21 |
| `/rndc/admin/credenciales` | ok | ok | ok | ok | ok | ok | ok | ok | 15/20 |
| `/rndc/maestros` | ok | ok | ok | ok | ok | ok | ok | ok | 23/31 |
| `/rndc/manifiestos` | ok | ok | ok | ok | ok | ok | ok | ok | 28/32 |
| `/rndc/manifiestos/demo-1` | ok | ok | ok | ok | ok | ok | ok | ok | 13/17 |
| `/rndc/manifiestos/nuevo` | ok | ok | ok | ok | ok | ok | ok | ok | 16/25 |
| `/rndc/remesas` | ok | ok | ok | ok | ok | ok | ok | ok | 26/30 |
| `/rndc/remesas/demo-1` | ok | ok | ok | ok | ok | ok | ok | ok | 16/40 |
| `/rndc/remesas/nueva` | ok | ok | ok | ok | ok | ok | ok | ok | 16/40 |
| `/roles-permisos` | ok | ok | ok | ok | ok | ok | ok | ok | 16/22 |
| `/siigo/credenciales` | ok | ok | ok | ok | ok | ok | ok | ok | 17/24 |
| `/siigo/operacion` | ok | ok | ok | ok | ok | ok | ok | ok | 25/37 |
| `/siigo/parametrizacion` | ok | ok | ok | ok | ok | ok | ok | ok | 16/28 |
| `/soat` | ok | ok | ok | ok | ok | ok | ok | ok | 16/23 |
| `/tax-reader` | ok | ok | ok | ok | ok | ok | ok | ok | 13/17 |
| `/tramite` | ok | ok | ok | ok | ok | ok | ok | ok | 33/41 |
| `/tramite/traspaso` | ok | ok | ok | ok | ok | ok | ok | ok | 17/22 |
| `/tramite/verificar` | ok | ok | ok | ok | ok | ok | ok | ok | 0/1 |
| `/transito` | ok | ok | ok | ok | ok | ok | ok | ok | 17/21 |
| `/transito/organismos` | ok | ok | ok | ok | ok | ok | ok | ok | 17/21 |
| `/transito/traspaso` | ok | ok | ok | ok | ok | ok | ok | ok | 14/18 |
| `/users` | ok | ok | ok | ok | ok | ok | ok | ok | 37/42 |
| `/vehicles` | ok | ok | ok | ok | ok | ok | ok | ok | 30/37 |

## Detalle

### `/finanzas/gastos-diarios`

- **390 claro** — desborde +17px
  - más anchos que el viewport: `span. (407px)`
- **390 oscuro** — desborde +17px
  - más anchos que el viewport: `span. (407px)`

### `/finanzas/reporte-costos`

- **360 claro**
  - fuera: input«INPUT», button«BUTTON»
- **390 claro**
  - fuera: input«INPUT», button«BUTTON»
- **390 oscuro**
  - fuera: input«INPUT», button«BUTTON»
- **768 claro**
  - más anchos que el viewport: `div.absolute.z-30.mt-1 (780px)`, `div.absolute.z-30.mt-1 (815px)`, `div.absolute.z-30.mt-1 (844px)`
  - fuera: button«BUTTON», button«Mes siguiente», button«2026-11-01», button«2026-11-07», button«2026-11-08», button«2026-11-14», button«2026-11-15», button«2026-11-21»
- **1440 claro**
  - más anchos que el viewport: `div.absolute.z-30.mt-1 (1494px)`, `div.absolute.z-30.mt-1 (1448px)`, `div.absolute.z-30.mt-1 (1535px)`
  - fuera: button«BUTTON», button«Mes siguiente», button«2026-11-01», button«2026-11-06», button«2026-11-07», button«2026-11-08», button«2026-11-13», button«2026-11-14»

### `/flito/logistica`

- **360 claro** — desborde +7px

### `/flito/tramites`

- **390 claro**
  - más anchos que el viewport: `div.absolute.z-30.mt-1 (441px)`
  - fuera: button«BUTTON», button«Mes siguiente», button«2026-11-01», button«2026-11-08», button«2026-11-15», button«2026-11-22», button«2026-11-29»
- **390 oscuro**
  - más anchos que el viewport: `div.absolute.z-30.mt-1 (441px)`
  - fuera: button«BUTTON», button«Mes siguiente», button«2026-11-01», button«2026-11-08», button«2026-11-15», button«2026-11-22», button«2026-11-29»


## Estado tras los arreglos (sesión B, antes de integrar la navegación nueva)

Commits 15dbcd6c → este cierre. Verificado con pasadas cortas del mismo barrido sobre Trámites, Logística, Comprobantes, Comparendos, Bolsas, Gastos diarios, Siigo Operación y Reporte de costos en los 8 tamaños: **0 desbordes, 0 controles fuera del viewport, 0 errores JS**. El barrido final de las 103 rutas lo corre la sesión A una vez sobre la base integrada (conteo global de táctiles y capturas seleccionadas).

| # | Estado | Dónde |
|---|---|---|
| V1 | Resuelto: tiras de píldoras sin envolver, con scroll y desvanecido; la caja no ensancha la página (`contain: inline-size`) | `FlitPillGroup`, `FiltroSegmentado`, kit-responsive.css |
| V2 / V4 | Resuelto: DataTable y FlitTable en tarjetas (1 columna <640, 2 hasta 1023), tabla desde 1024 con acciones fijas; FlitTable toma el rótulo de cada celda del encabezado (`data-etiqueta` automático). Tablas anchas (Reporte de costos, tarifas, RACI) quedan en matriz con scroll | `DataTable`, `FlitTable` (`matriz`), kit-responsive.css V12 |
| V3 | Resuelto en Comprobantes (tarjetas); Reporte de costos sigue en matriz a propósito | — |
| V5 | Resuelto: acciones de cabecera a la derecha desde 768, a ancho completo y apiladas <640 | kit-responsive.css, `VistaRegistrosComparendos` |
| V6 | Resuelto: pestañas con desvanecido; el `.sr-only` del contador ya no desborda | `Pestanas`, kit-responsive.css |
| V7 | Resuelto (solo visual): filtros plegados tras «Filtros (n)» <640 en Trámites, Comparendos y Comprobantes; se aplican igual que antes | `FiltrosPlegables` |
| V8 | Resuelto: el calendario solo se monta abierto; <640 va en el flujo con un mes | `RangoFechas` |
| V9 | Mejorado: 44 px bajo 1024 en botones, enlaces de control, chips, acciones de fila, íconos y campos (Trámites a 390: 93/132 → 14/55 por debajo de 44 px). Sin área ampliada: casillas y radios | kit-responsive.css V9 |
| V10 | Resuelto: KPIs del tablero PESV en 1/2/3/5 columnas; cifras sin partir | `PesvTablero`, kit-responsive.css |
| V11 | Resuelto: Nueva remesa y Nuevo checklist con el contenedor de las demás páginas | `RndcRemesaForm`, `ChecklistRun` |

Pendiente de mirar en la integración: el menú de los filtros por columna en tarjetas (`ThFiltroMulti`) es `position: fixed` sin coordenadas; queda en su sitio y visible (comprobado abierto a 390 y 768), pero no acompaña al filtro si la página se desplaza con el menú abierto.
