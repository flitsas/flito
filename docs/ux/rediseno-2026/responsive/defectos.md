# Barrido responsive — defectos por página y ancho

Épica #14560, sesión B. Generado 2026-11-13 con un spec temporal (Playwright, `/api` mockeado con las fixtures demo de `e2e/helpers/datos-demo.ts`; lo que no tiene fixture responde `[]`). Viewport de 900 px de alto, sesión admin E2E.

Leyenda: **+Npx** = desborde horizontal del documento (`scrollWidth − clientWidth`); *N fuera* = controles con borde fuera del viewport sin un contenedor con scroll que los acoja; *recort.* = controles con texto cortado (`overflow-x: hidden` y `scrollWidth > clientWidth`); *err* = excepción JS; *redir* = la ruta redirigió (permiso/parámetro demo). Columnas oscuro: 390 y 1280.

**Resumen:** 103 rutas × 8 variantes = 824 capturas. Con desborde horizontal: 3. Con controles fuera del viewport: 7. Con controles recortados: 0.

> **Medidas no válidas en 45 rutas.** Flota, mantenimiento, repuestos, PESV, RNDC, `/laft/unusual`, `/flito/conciliacion/:id` y `/admin/tramites-metricas` lanzaron una excepción JS en las 8 variantes (columna *err*): el mock respondió `[]` donde la pantalla espera un objeto y quedó en la pantalla de error. Su «ok» en la tabla **no** certifica nada; se re-barren con fixtures propias (`pesv-fixtures`, `laft-fixtures`…) en la recaptura final. Bolsas, SOAT e Impuestos salieron en estado vacío por falta de fixture de lista.

## Revisión a ojo (lo que la métrica no mide)

Páginas de más uso revisadas a 390, 768 y 1024 (claro): Tablero, Gestión Trámites, SOAT, Impuestos, Logística, Comprobantes, Comparendos, Reporte de costos, Usuarios, Bolsas. Agrupado por pieza del kit, que es donde va el arreglo:

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

| Ruta | 360 | 390 | 768 | 1024 | 1280 | 1440 | 390 osc. | 1280 osc. | táctil <44px (390) |
|---|---|---|---|---|---|---|---|---|---|
| `/` | ok | ok | ok | ok | ok | ok | ok | ok | 13/21 |
| `/admin/rendimiento` | ok | ok | ok | ok | ok | ok | ok | ok | 17/22 |
| `/admin/tramites-metricas` | err | err | err | err | err | err | err | err | 13/18 |
| `/clients` | ok | ok | ok | ok | ok | ok | ok | ok | 22/27 |
| `/drive` | ok | ok | ok | ok | ok | ok | ok | ok | 14/20 |
| `/finanzas/gastos-diarios` | ok | **+17px** | ok | ok | ok | ok | **+17px** | ok | 66/70 |
| `/finanzas/reporte-costos` | 2 fuera | 2 fuera | 8 fuera | ok | ok | 8 fuera | 2 fuera | ok | 155/177 |
| `/fleet` | err | err | err | err | err | err | err | err | 13/18 |
| `/fleet/demo-1` | err | err | err | err | err | err | err | err | 13/18 |
| `/flito/ayuda` | ok | ok | ok | ok | ok | ok | ok | ok | 15/47 |
| `/flito/ayuda/demo-1` | ok | ok | ok | ok | ok | ok | ok | ok | 15/20 |
| `/flito/bitacora` | ok | ok | ok | ok | ok | ok | ok | ok | 21/25 |
| `/flito/bolsas` | ok | ok | ok | ok | ok | ok | ok | ok | 13/17 |
| `/flito/comparendos` | ok | ok | ok | ok | ok | ok | ok | ok | 27/37 |
| `/flito/comprobantes` | ok | ok | ok | ok | ok | ok | ok | ok | 22/36 |
| `/flito/compuerta` | ok | ok | ok | ok | ok | ok | ok | ok | 14/18 |
| `/flito/conciliacion` | ok | ok | ok | ok | ok | ok | ok | ok | 58/66 |
| `/flito/conciliacion/demo-1` | err | err | err | err | err | err | err | err | 13/18 |
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
| `/laft/unusual` | err | err | err | err | err | err | err | err | 13/18 |
| `/login` | ok | ok | ok | ok | ok | ok | ok | ok | 1/4 |
| `/maintenance` | err | err | err | err | err | err | err | err | 13/18 |
| `/maintenance/indicators` | err | err | err | err | err | err | err | err | 13/18 |
| `/maintenance/routines` | err | err | err | err | err | err | err | err | 13/18 |
| `/maintenance/schedule` | err | err | err | err | err | err | err | err | 13/18 |
| `/maintenance/work-orders` | err | err | err | err | err | err | err | err | 13/18 |
| `/maintenance/work-orders/demo-1` | err | err | err | err | err | err | err | err | 13/18 |
| `/parts` | err | err | err | err | err | err | err | err | 13/18 |
| `/perfil` | ok | ok | ok | ok | ok | ok | ok | ok | 14/19 |
| `/pesv` | err | err | err | err | err | err | err | err | 13/18 |
| `/pesv/alcoholimetria` | err | err | err | err | err | err | err | err | 13/18 |
| `/pesv/auditorias` | err | err | err | err | err | err | err | err | 13/18 |
| `/pesv/capacitaciones` | err | err | err | err | err | err | err | err | 13/18 |
| `/pesv/checklists` | err | err | err | err | err | err | err | err | 13/18 |
| `/pesv/checklists/nuevo` | err | err | err | err | err | err | err | err | 13/18 |
| `/pesv/comite` | err | err | err | err | err | err | err | err | 13/18 |
| `/pesv/comunicaciones` | err | err | err | err | err | err | err | err | 13/18 |
| `/pesv/conductores` | err | err | err | err | err | err | err | err | 13/18 |
| `/pesv/conductores/demo-1` | err | err | err | err | err | err | err | err | 13/18 |
| `/pesv/contratistas` | err | err | err | err | err | err | err | err | 13/18 |
| `/pesv/diagnostico` | ok | ok | ok | ok | ok | ok | ok | ok | 15/21 |
| `/pesv/diagnostico/demo-1` | err | err | err | err | err | err | err | err | 13/18 |
| `/pesv/diagnostico/demo-1/auditoria` | ok | ok | ok | ok | ok | ok | ok | ok | 13/17 |
| `/pesv/emergencias` | err | err | err | err | err | err | err | err | 13/18 |
| `/pesv/incidentes` | err | err | err | err | err | err | err | err | 13/18 |
| `/pesv/incidentes/stats` | err | err | err | err | err | err | err | err | 13/18 |
| `/pesv/jornadas` | err | err | err | err | err | err | err | err | 13/18 |
| `/pesv/mi-jornada` | err | err | err | err | err | err | err | err | 13/18 |
| `/pesv/normativa` | err | err | err | err | err | err | err | err | 13/18 |
| `/pesv/operacion-indicadores` | err | err | err | err | err | err | err | err | 13/18 |
| `/pesv/pernocta` | err | err | err | err | err | err | err | err | 13/18 |
| `/pesv/plan` | err | err | err | err | err | err | err | err | 13/18 |
| `/pesv/politica` | err | err | err | err | err | err | err | err | 13/18 |
| `/pesv/raci` | ok | ok | ok | ok | ok | ok | ok | ok | 15/21 |
| `/pesv/reportar` | ok | ok | ok | ok | ok | ok | ok | ok | 15/25 |
| `/pesv/retencion` | err | err | err | err | err | err | err | err | 13/18 |
| `/pesv/rutas` | err | err | err | err | err | err | err | err | 13/18 |
| `/pesv/tablero` | err | err | err | err | err | err | err | err | 13/18 |
| `/privacy` | ok | ok | ok | ok | ok | ok | ok | ok | 15/20 |
| `/privacy/log-pii` | ok | ok | ok | ok | ok | ok | ok | ok | 20/25 |
| `/rndc` | err | err | err | err | err | err | err | err | 13/18 |
| `/rndc/admin/credenciales` | ok | ok | ok | ok | ok | ok | ok | ok | 15/20 |
| `/rndc/maestros` | err | err | err | err | err | err | err | err | 13/18 |
| `/rndc/manifiestos` | err | err | err | err | err | err | err | err | 13/18 |
| `/rndc/manifiestos/demo-1` | ok | ok | ok | ok | ok | ok | ok | ok | 13/17 |
| `/rndc/manifiestos/nuevo` | err | err | err | err | err | err | err | err | 13/18 |
| `/rndc/remesas` | err | err | err | err | err | err | err | err | 13/18 |
| `/rndc/remesas/demo-1` | err | err | err | err | err | err | err | err | 13/18 |
| `/rndc/remesas/nueva` | err | err | err | err | err | err | err | err | 13/18 |
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

### `/admin/tramites-metricas`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'reduce') / Cannot read properties of undefined (reading 'reduce')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'reduce') / Cannot read properties of undefined (reading 'reduce')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'reduce') / Cannot read properties of undefined (reading 'reduce')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'reduce') / Cannot read properties of undefined (reading 'reduce')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'reduce') / Cannot read properties of undefined (reading 'reduce')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'reduce') / Cannot read properties of undefined (reading 'reduce')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'reduce') / Cannot read properties of undefined (reading 'reduce')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'reduce') / Cannot read properties of undefined (reading 'reduce')

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

### `/fleet`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')

### `/fleet/demo-1`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'alias') / Cannot read properties of undefined (reading 'alias')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'alias') / Cannot read properties of undefined (reading 'alias')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'alias') / Cannot read properties of undefined (reading 'alias')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'alias') / Cannot read properties of undefined (reading 'alias')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'alias') / Cannot read properties of undefined (reading 'alias')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'alias') / Cannot read properties of undefined (reading 'alias')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'alias') / Cannot read properties of undefined (reading 'alias')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'alias') / Cannot read properties of undefined (reading 'alias')

### `/flito/conciliacion/demo-1`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'toLocaleString') / Cannot read properties of undefined (reading 'toLocaleString')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'toLocaleString') / Cannot read properties of undefined (reading 'toLocaleString')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'toLocaleString') / Cannot read properties of undefined (reading 'toLocaleString')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'toLocaleString') / Cannot read properties of undefined (reading 'toLocaleString')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'toLocaleString') / Cannot read properties of undefined (reading 'toLocaleString')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'toLocaleString') / Cannot read properties of undefined (reading 'toLocaleString')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'toLocaleString') / Cannot read properties of undefined (reading 'toLocaleString')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'toLocaleString') / Cannot read properties of undefined (reading 'toLocaleString')

### `/flito/logistica`

- **360 claro** — desborde +7px

### `/flito/tramites`

- **390 claro**
  - más anchos que el viewport: `div.absolute.z-30.mt-1 (441px)`
  - fuera: button«BUTTON», button«Mes siguiente», button«2026-11-01», button«2026-11-08», button«2026-11-15», button«2026-11-22», button«2026-11-29»
- **390 oscuro**
  - más anchos que el viewport: `div.absolute.z-30.mt-1 (441px)`
  - fuera: button«BUTTON», button«Mes siguiente», button«2026-11-01», button«2026-11-08», button«2026-11-15», button«2026-11-22», button«2026-11-29»

### `/laft/unusual`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')

### `/maintenance`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')

### `/maintenance/indicators`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')

### `/maintenance/routines`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')

### `/maintenance/schedule`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')

### `/maintenance/work-orders`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')

### `/maintenance/work-orders/demo-1`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'estado') / Cannot read properties of undefined (reading 'estado')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'estado') / Cannot read properties of undefined (reading 'estado')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'estado') / Cannot read properties of undefined (reading 'estado')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'estado') / Cannot read properties of undefined (reading 'estado')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'estado') / Cannot read properties of undefined (reading 'estado')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'estado') / Cannot read properties of undefined (reading 'estado')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'estado') / Cannot read properties of undefined (reading 'estado')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'estado') / Cannot read properties of undefined (reading 'estado')

### `/parts`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')

### `/pesv`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'toLocaleString') / Cannot read properties of undefined (reading 'toLocaleString')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'toLocaleString') / Cannot read properties of undefined (reading 'toLocaleString')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'toLocaleString') / Cannot read properties of undefined (reading 'toLocaleString')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'toLocaleString') / Cannot read properties of undefined (reading 'toLocaleString')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'toLocaleString') / Cannot read properties of undefined (reading 'toLocaleString')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'toLocaleString') / Cannot read properties of undefined (reading 'toLocaleString')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'toLocaleString') / Cannot read properties of undefined (reading 'toLocaleString')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'toLocaleString') / Cannot read properties of undefined (reading 'toLocaleString')

### `/pesv/alcoholimetria`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')

### `/pesv/auditorias`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')

### `/pesv/capacitaciones`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')

### `/pesv/checklists`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')

### `/pesv/checklists/nuevo`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')

### `/pesv/comite`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')

### `/pesv/comunicaciones`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')

### `/pesv/conductores`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')

### `/pesv/conductores/demo-1`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'username') / Cannot read properties of undefined (reading 'username')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'username') / Cannot read properties of undefined (reading 'username')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'username') / Cannot read properties of undefined (reading 'username')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'username') / Cannot read properties of undefined (reading 'username')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'username') / Cannot read properties of undefined (reading 'username')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'username') / Cannot read properties of undefined (reading 'username')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'username') / Cannot read properties of undefined (reading 'username')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'username') / Cannot read properties of undefined (reading 'username')

### `/pesv/contratistas`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')

### `/pesv/diagnostico/demo-1`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')

### `/pesv/emergencias`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')

### `/pesv/incidentes`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')

### `/pesv/incidentes/stats`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')

### `/pesv/jornadas`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')

### `/pesv/mi-jornada`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'replace') / Cannot read properties of undefined (reading 'replace')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'replace') / Cannot read properties of undefined (reading 'replace')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'replace') / Cannot read properties of undefined (reading 'replace')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'replace') / Cannot read properties of undefined (reading 'replace')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'replace') / Cannot read properties of undefined (reading 'replace')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'replace') / Cannot read properties of undefined (reading 'replace')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'replace') / Cannot read properties of undefined (reading 'replace')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'replace') / Cannot read properties of undefined (reading 'replace')

### `/pesv/normativa`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')

### `/pesv/operacion-indicadores`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'realizadas') / Cannot read properties of undefined (reading 'realizadas')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'realizadas') / Cannot read properties of undefined (reading 'realizadas')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'realizadas') / Cannot read properties of undefined (reading 'realizadas')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'realizadas') / Cannot read properties of undefined (reading 'realizadas')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'realizadas') / Cannot read properties of undefined (reading 'realizadas')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'realizadas') / Cannot read properties of undefined (reading 'realizadas')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'realizadas') / Cannot read properties of undefined (reading 'realizadas')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'realizadas') / Cannot read properties of undefined (reading 'realizadas')

### `/pesv/pernocta`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')

### `/pesv/plan`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')

### `/pesv/politica`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'find') / Cannot read properties of undefined (reading 'find')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'find') / Cannot read properties of undefined (reading 'find')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'find') / Cannot read properties of undefined (reading 'find')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'find') / Cannot read properties of undefined (reading 'find')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'find') / Cannot read properties of undefined (reading 'find')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'find') / Cannot read properties of undefined (reading 'find')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'find') / Cannot read properties of undefined (reading 'find')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'find') / Cannot read properties of undefined (reading 'find')

### `/pesv/retencion`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')

### `/pesv/rutas`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')

### `/pesv/tablero`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'scoresPorFase') / Cannot read properties of undefined (reading 'scoresPorFase')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'scoresPorFase') / Cannot read properties of undefined (reading 'scoresPorFase')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'scoresPorFase') / Cannot read properties of undefined (reading 'scoresPorFase')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'scoresPorFase') / Cannot read properties of undefined (reading 'scoresPorFase')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'scoresPorFase') / Cannot read properties of undefined (reading 'scoresPorFase')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'scoresPorFase') / Cannot read properties of undefined (reading 'scoresPorFase')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'scoresPorFase') / Cannot read properties of undefined (reading 'scoresPorFase')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'scoresPorFase') / Cannot read properties of undefined (reading 'scoresPorFase')

### `/rndc`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'desde') / Cannot read properties of undefined (reading 'desde')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'desde') / Cannot read properties of undefined (reading 'desde')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'desde') / Cannot read properties of undefined (reading 'desde')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'desde') / Cannot read properties of undefined (reading 'desde')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'desde') / Cannot read properties of undefined (reading 'desde')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'desde') / Cannot read properties of undefined (reading 'desde')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'desde') / Cannot read properties of undefined (reading 'desde')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'desde') / Cannot read properties of undefined (reading 'desde')

### `/rndc/maestros`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')

### `/rndc/manifiestos`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'replace') / Cannot read properties of undefined (reading 'replace')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'replace') / Cannot read properties of undefined (reading 'replace')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'replace') / Cannot read properties of undefined (reading 'replace')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'replace') / Cannot read properties of undefined (reading 'replace')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'replace') / Cannot read properties of undefined (reading 'replace')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'replace') / Cannot read properties of undefined (reading 'replace')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'replace') / Cannot read properties of undefined (reading 'replace')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'replace') / Cannot read properties of undefined (reading 'replace')

### `/rndc/manifiestos/nuevo`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'filter') / Cannot read properties of undefined (reading 'filter')

### `/rndc/remesas`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'length') / Cannot read properties of undefined (reading 'length')

### `/rndc/remesas/demo-1`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')

### `/rndc/remesas/nueva`

- **360 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **390 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **390 oscuro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **768 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **1024 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **1280 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **1280 oscuro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')
- **1440 claro**
  - errores: Cannot read properties of undefined (reading 'map') / Cannot read properties of undefined (reading 'map')

