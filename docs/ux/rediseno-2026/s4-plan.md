# S4 — Flota, mantenimiento y conductores: plan de migración al UI Kit 2026

Épica ADO #14560. Rama `FEATURE/14560-davidchica-rediseno-ui-kit-2026-s4`. Fase 1 (preparación): este plan no toca código de producto.

Fuente del diseño: `flit` rama `propuesta-2`, `docs/design/propuesta-ui-kit-2026/` (`propuesta.js`, `ui-kit-2026.css`, `tokens.css`).
Implementación de referencia: `flit` rama `develop`, `packages/ui/src/*`.

## Moldes de la propuesta que aplican

La propuesta es de FLIT (trámites), así que no hay pantallas de flota. Cada página de S4 se viste con uno de estos moldes genéricos:

| Molde | Función en `propuesta.js` | Anatomía |
|---|---|---|
| **M-Lista** | `vModulo` + `lista()` + `panelFiltros()` | Cabecera con miga de pan, ícono de módulo y acciones (primaria azul y secundarias) → card «Listado» → barra de búsqueda + botón Filtros (panel plegable, filtros activos como chips que se quitan) → embudo de chips por estado con conteo → `barra-accion` contextual → tabla con borde `#A9C9FC` (pasa a tarjetas por debajo de 900 px) con columna «Acciones» (menú) → paginador de 10 → vacío con ilustración y «Quitar filtros» |
| **M-Pestañas** | `vModulo` con `m.pestanas` | M-Lista con pestañas de línea inferior bajo la cabecera, una lista por pestaña (`?tab=`) |
| **M-Detalle** | `vTramite` | Cabecera con miga «Módulo › Registro» y acciones → `barra-accion` «Qué falta» → card resumen (bloque `vehiculo`: placa grande + nombre + meta + etiquetas de estado; `dl` de fichas) → avance en `linea` → rejilla 2 columnas con cards `lista-fila` (documentos, partes) y `actividad-linea` |
| **M-Asistente** | `vTraspaso` | Pasos horizontales (`PasosHorizontal`) + píldora de datos → card con el bloque vehículo → card del paso con formulario `formulario`/`campo` → `pie-acciones` (Anterior · Guardar borrador · Continuar) |
| **M-Reportes** | `vReportes` | Cabecera con «Descargar» → pestañas → fila de `TarjetaMetrica` (cifra + ícono por lo que mide) → rejilla de donas → barras agrupadas (tendencia) → barras horizontales con selector de periodo |
| **M-Config** | `vConfigTramite` / `vConfigForm` | Card con `firmantes` + `Interruptor`, o formulario de campos con `pie-acciones` «Guardar cambios» |
| **Modal** | `abrirForm` / `abrirDetalle` | Contenedor blanco, ícono centrado, fondo azul 50 % con desenfoque; formularios `campo` en rejilla |

Componentes del kit esperados (nombres de `packages/ui` de flit; los reales salen del catálogo `components/flit/` que entregue S0): `CabeceraModulo`, `Miga`, `Button`, `ChipsFiltro` (embudo), `DataTable`, `Pagination`/`usePaginacion`, `ActionsMenu`, `Pestanas`, `TarjetaMetrica`, `StatusBadge` + `statusTones`, `Placa`, `Modal`, `PasosHorizontal`, `Interruptor`, `Ingreso` (campos), `InlineAlert`, `Loader`, `UiStateBoundary` (4 estados), `Icono`.

## Estado actual del alcance (inventario 2026-11-12)

Todas las páginas usan el kit viejo: `PageHeaderCard` (24 usos), `GradientButton` (15), `StatusChip` (13), `FlitModal` (11), `flitPageKit` (6), `icons`, `ModalPortal`, `RangoFechaFilter`. Restos Aura/gradiente en 18 de 25 páginas (clases `gradient-primary|success|danger`, `glass`). HEX sueltos: `Parts.tsx` (1), `Schedule.tsx` (1). Ninguna pasa de 500 líneas.

## Plan por página

| Página (líneas) | Molde | Componentes del kit | Notas |
|---|---|---|---|
| `Fleet.tsx` (359) | M-Pestañas | Cabecera, Pestanas, DataTable, ChipsFiltro, StatusBadge, Placa, Modal (alta vehículo), ActionsMenu | 2 tablas + 3 modales; placa con `Placa` |
| `FleetVehicleDetail.tsx` (122) | M-Detalle | Cabecera+Miga, bloque vehículo (Placa grande), Pestanas, StatusBadge | Paneles de `components/fleet/*` en pestañas |
| `components/fleet/DocumentsPanel.tsx` (164) | M-Detalle `lista-fila` | StatusBadge (vigente/por vencer/vencido), Button sm, Loader | Carga de archivo con el patrón `carga` |
| `components/fleet/LinksPanel.tsx` (121) | M-Detalle `lista-fila` | Button, StatusBadge | |
| `components/fleet/MeasurementsPanel.tsx` (107) | M-Detalle tabla corta | DataTable, Ingreso | |
| `components/fleet/shared.tsx` (60) | utilidades | — | Revisar si sobra frente al kit |
| `Vehicles.tsx` (283) | M-Lista | Cabecera (Exportar secundaria), ChipsFiltro, DataTable, Placa, Modal ×3 | Tiene gráficos SVG propios → paleta de gráficos del manual |
| `vehiculo/PasaporteVehiculo.tsx` (120) | M-Detalle | bloque vehículo, `dl`, Button «Descargar certificado» | |
| `Drivers.tsx` (231) | M-Lista | DataTable, StatusBadge, Modal ×3, ChipsFiltro | Avatar con iniciales (`persona__avatar`) |
| `DriverDetail.tsx` (204) | M-Detalle + Pestanas | Cabecera+Miga, `dl`, Pestanas, DataTable, StatusBadge | Datos personales: sin PII en URL (regla 14) |
| `Maintenance.tsx` (154) | Inicio de módulo (tarjetas de acceso) | TarjetaMetrica/mapa de módulos de `vInicio` | Hub hacia OT, rutinas, programación, repuestos |
| `MaintenanceIndicators.tsx` (180) | M-Reportes | TarjetaMetrica, Pestanas, barras, DataTable, filtro de periodo | |
| `Parts.tsx` (229) | M-Lista | DataTable, Modal ×5 (repuesto, movimiento), StatusBadge stock | Quitar HEX suelto |
| `WorkOrders.tsx` (174) | M-Lista | ChipsFiltro por estado de OT, DataTable, Modal (nueva OT) | |
| `WorkOrderDetail.tsx` (380) | M-Detalle | Cabecera+acciones (cierre técnico), `linea` de avance por estado, cards `lista-fila` trabajos/repuestos, Modal ×3, `actividad-linea` | Cuidar orden de acciones: una primaria |
| `components/maintenance/LiquidacionPanel.tsx` (125) | M-Detalle card | DataTable, cifras con `pesos` | |
| `Checklists.tsx` (93) | M-Lista | ChipsFiltro (apto/condicional/no apto), DataTable, StatusBadge | Spec `checklists.spec.ts` |
| `ChecklistRun.tsx` (219) | M-Asistente (o formulario único) | PasosHorizontal si el flujo tiene secciones, Ingreso, Interruptor/sí-no, pie-acciones | |
| `Schedule.tsx` (113) | M-Lista | DataTable, StatusBadge, ActionsMenu (cancelar) | Quitar HEX suelto |
| `Routines.tsx` (94) | M-Lista | DataTable, Modal (nueva rutina) | |
| `JornadasConductor.tsx` (176) | M-Lista | ChipsFiltro, DataTable, StatusBadge alarmas, Button «Reconocer» | Spec `jornadas.spec.ts` |
| `MiJornada.tsx` (163) | M-Detalle simplificado (móvil primero) | `barra-accion` con la acción del momento (abrir / pausar / cerrar), StatusBadge, `linea` | Uso del conductor en celular: 375 px es el ancho principal |
| `AlcoholTests.tsx` (194) | M-Lista | ChipsFiltro (resultado), DataTable, Modal | |
| `Emergency.tsx` (299) | M-Pestañas | Pestanas (contactos, protocolos, simulacros), DataTable ×2, Modal ×7 | Muchas modales: un solo `Modal` del kit |
| `RoadIncidents.tsx` (475) | M-Pestañas/M-Lista | ChipsFiltro, DataTable, Modal ×3 (incidente, causa raíz), RangoFecha → panel Filtros con rango | La página más grande; respetar ≤800 |
| `RoadIncidentsStats.tsx` (197) | M-Reportes | TarjetaMetrica, dona, barras, DataTable | |
| `ReportarIncidente.tsx` (181) | M-Asistente / formulario | Ingreso, carga de archivo, pie-acciones | Público conductor, móvil |
| `SafetyTrainings.tsx` (132) | M-Lista | DataTable, Modal | |
| `OperationalIndicators.tsx` (169) | M-Reportes | TarjetaMetrica, DataTable ×2, selector de periodo | |
| `DriveViewer.tsx` (484) | M-Lista (explorador) | Miga como ruta de carpetas, DataTable, íconos de tipo de archivo del kit, Loader | 7 SVG/íconos propios → `Icono` del kit |

## Specs E2E que tocaré

- `apps/web/e2e/tests/checklists.spec.ts` (3 tests) — selectores de heading/píldoras de decisión.
- `apps/web/e2e/tests/jornadas.spec.ts` (8 tests).
- `apps/web/e2e/tests/vehicles-pipeline.spec.ts` (4 tests).
- No hay specs propios de flota, conductores, mantenimiento ni incidentes: no los invento; si cambia un selector compartido lo ajusto donde exista.

## Ayuda

- `apps/web/src/content/ayuda/drive.md` → al día con la UI nueva (skill `flit-ayuda-flito`). Ninguna otra ficha de S4 existe hoy.

## Orden de trabajo (fase 2)

1. Piezas compartidas: `components/fleet/*`, `components/maintenance/*`.
2. Listas simples (Checklists, Routines, Schedule, SafetyTrainings, AlcoholTests, Parts, WorkOrders, Drivers, Vehicles) — patrón M-Lista repetible, delegable en `frontend-agent` en paralelo por grupos sin archivos compartidos.
3. Detalles (FleetVehicleDetail, DriverDetail, WorkOrderDetail, PasaporteVehiculo) y pestañas (Fleet, Emergency, RoadIncidents).
4. Reportes (MaintenanceIndicators, OperationalIndicators, RoadIncidentsStats).
5. Flujos de conductor en móvil (MiJornada, ChecklistRun, ReportarIncidente), DriveViewer, Maintenance (hub).
6. Specs, ficha de ayuda, capturas 1280/375/oscuro en `docs/ux/rediseno-2026/s4/`, typecheck + lint.

## Dudas para el integrador / la diseñadora

1. **Gráficos:** ¿el kit de S0 trae `Dona` y `BarrasGrupo` (de `propuesta.js`) como componentes, o cada sesión los compone? Los necesitan 3 páginas de S4 (indicadores) y probablemente S-otros.
2. **Bloque vehículo** (`vehiculo()`: placa grande + nombre + meta + etiquetas): ¿entra en `components/flit/` como componente? Lo usarían FleetVehicleDetail, PasaporteVehiculo, WorkOrderDetail y ChecklistRun.
3. **Íconos de módulo** para flota, mantenimiento, conductores, jornada, alcoholimetría, emergencias, incidentes, capacitaciones, Drive: `kit-iconos.js` no los trae con esos nombres. ¿Se dibujan (pedido a `flit-de`) o se mapea a existentes (`ruta`, `calendario`, `escudo`, `cronometro`…)?
4. **Estados de dominio** (apto / condicional / no apto; OT abierta / en curso / cerrada; stock bajo; documento vigente / por vencer / vencido): ¿hay tabla de tono → glifo (`GLIFO_ESTADO`) en el kit para estados nuevos, o se usa solo el tono (`ok`/`warn`/`error`/`info`)?
5. **Hub `Maintenance.tsx`:** ¿molde de mapa de módulos de Inicio (`mapaModulos`) o lista? Propongo el mapa.
6. **Rango de fechas:** `RangoFechaFilter` actual → ¿lo reemplaza el panel Filtros con rango y presets de la propuesta (componente del kit) o se conserva?

## Respuestas del integrador (2026-11-12) y decisiones

- **Fuente de valores:** `ui-kit-2026.css` (se carga al final y gana), no `tokens.css`. Briefing de la diseñadora en `rediseno-2026/BRIEFING-KIT-flit-de.md`: botones planos tipo píldora (sin degradado), modal blanco con ícono centrado (sin franja de color), sin círculo turquesa en la cabecera.
- **Regla k (manda sobre todo este plan):** el cambio es solo visual. No se tocan textos, `aria`, handlers, hooks, `fetch` ni estado. Donde arriba dice «molde M-Asistente», eso significa *vestir* el flujo existente; no cambia su lógica ni el número de pasos.
- **Dona, BarrasGrupo y bloque de vehículo:** los entrega S0 como componentes del kit.
- **Estados de dominio:** van en un mapa del módulo sobre el registro ESTADO→{tono, glifo} de S0: apto=ok, condicional=warn, no apto=danger, vigente=ok, por vencer=warn, vencido=danger, stock bajo=warn, con glifos `estado-*`. Los chips propios que no son StatusBadge pasan a `etiquetaKit(tono)` (error típico c).
- **Filtros:** el panel de Filtros con rango de fechas y presets reemplaza a `RangoFechaFilter`.
- **Íconos fijados por la diseñadora:** Flota [carro], Vehículos [carro], Conductores [credencial], Jornadas [reloj], Mantenimiento [reintento], Órdenes de trabajo [lista], Repuestos [procesos], Checklists [doble-check], Incidentes [alerta].
- **Íconos elegidos por S4** (glifos de `kit-iconos.js` que no usa ningún otro módulo del reparto FLITO):
  - Alcoholimetría [biometria]: confirmado por `flit-de`. Resultado de la prueba en etiquetas: negativa = ok [check], positiva = danger [alerta], pendiente = warn [espera].
  - Plan de emergencias [megafono].
  - Capacitaciones de seguridad vial [asistente].
  - Google Drive [nube-bajar].
