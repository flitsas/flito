# Rediseño 2026 de FLITO con el UI Kit 2026 de FLIT — guía para las sesiones S1–S6

Épica ADO #14560 · Fundación S0 (rama `FEATURE/14560-davidchica-rediseno-ui-kit-2026`).

**Fuente de verdad visual:** repo `flit`, rama `propuesta-2`, carpeta `docs/design/propuesta-ui-kit-2026/`
(orden de carga `tokens.css → propuesta.css → ui-kit-2026.css`; **gana el último, incluido su bloque final de
contraste**) + briefing de la diseñadora (`/home/david/flit/rediseno-2026/BRIEFING-KIT-flit-de.md`).
**Fuente de verdad de implementación:** repo `flit`, rama `develop`, `packages/ui/src/*` y `packages/shell/src/styles/shell.css`.

Ver la propuesta servida:

```bash
S=$(mktemp -d); git -C /home/david/flit/flit archive propuesta-2 docs/design/propuesta-ui-kit-2026 | tar -x -C "$S"
cd "$S/docs/design/propuesta-ui-kit-2026" && python3 -m http.server 8733   # http://localhost:8733/#inicio
```

Capturas de S0 (claro/oscuro, 1280 y 375): `docs/ux/rediseno-2026/s0/` (incluye `propuesta-*.png` de referencia).

---

## 1. Qué dejó S0 y cómo está montado

| Capa | Archivo | Qué es |
|---|---|---|
| Variables del kit | `apps/web/src/styles/kit/kit-variables.css` | **Generado** de la propuesta (tokens + bloques de variables de propuesta.css y ui-kit-2026.css, en orden). Sin capa: gana. No se edita a mano. |
| Base | `apps/web/src/styles/tokens.css` | Fuentes autohospedadas (Poppins 300–800, JetBrains Mono 700, Barlow Condensed 600/700), oscuro sin JS, roles derivados (`--kit-azul-relleno`, `--kit-naranja-boton`, `--kit-*-texto`, `--kit-velo`…) y **alias de compatibilidad** (`--flit-*`, `--aura-*`, `--glass-*`). |
| Componentes de la propuesta | `styles/kit/kit-propuesta.css`, `styles/kit/kit-ui.css` | **Generados** de propuesta.css y ui-kit-2026.css en `@layer components` (las utilidades de Tailwind ganan). `table/th/td` acotados a `.tabla-wrap`; `main` → `.kit-main`; sin cursor de marca. |
| Piezas React | `styles/kit/kit-react.css` | Lo que la propuesta resuelve con JS o que viene de flit `packages/ui` (etiqueta con punta, pestañas, interruptor, pasos, modal, aviso, esqueleto, FlitTable…). Solo tokens. |
| Tailwind | `apps/web/src/index.css` (`@theme inline`) | Las utilidades viejas (`bg-surface`, `text-text-primary`, `border-border`, `bg-accent`, `text-success`, `bg-flit-card`, `text-flit-ink`, `rounded-xl`…) apuntan a los roles del kit: **todas las páginas ya cambiaron de piel**. Radios a 9 px. |
| Tema | `index.html` (bootstrap) + `src/lib/theme.tsx` | Clave **`flit-tema`** (`aura-theme` se lee como respaldo). Atributo `data-theme` siempre resuelto. |
| Íconos | `public/kit/*.svg`, `components/flit/kit/` | 101 glifos del kit sin `innerHTML` (árbol de nodos generado). |

Regenerar los CSS/íconos generados si la propuesta cambia: `docs/ux/rediseno-2026/generadores/` (`node gen-css.cjs <carpeta-propuesta> apps/web/src/styles/kit`, `node gen-iconos.cjs <flit>/packages/ui/src/iconos-kit.ts apps/web/src/components/flit/kit/iconos-kit.generated.ts`);
si se vuelven a correr, revisar el diff completo.

---

## 2. Mapeo «patrón viejo → kit nuevo»

### 2.1 Tokens (para `style={{}}` y `[color:var(--…)]`)

Los `--flit-*` **siguen funcionando** (alias), pero código nuevo usa los roles del kit.

| Viejo | Nuevo | Claro / oscuro |
|---|---|---|
| `--flit-blue-text`, `--flit-blue-ink`, `--flit-pill-active-ink`, `--flit-chip-active-ink` | `--color-action` (texto y trazos azules) | #1D53FF / #8FB0FF |
| `--flit-blue` | `--kit-azul` (rellenos de ícono, bordes de foco y activo) | #1D53FF / #8FB0FF |
| `--flit-gradient-primary` (botón) | `--kit-azul-relleno` (relleno plano con texto blanco) | #1D53FF / #1D53FF |
| `--flit-blue-dark` | `--kit-tinta-fija` (botón secundario, franjas) | #162744 / #162744 |
| `--flit-text-primary` / `-secondary` | `--color-text-primary` / `--color-text-secondary` | #162744 / #E6F0FF |
| `--flit-text-muted` | `--color-text-tertiary` (texto gris AA) | #546B7D / #A9B8D4 |
| `--flit-border-soft`, `--flit-border-input` | `--color-border` / `--color-border-control` | #A9C9FC / #3A5688 |
| `--flit-bg-app`, `--flit-bg-modal` | `--color-surface` (fondo de página) | #E6F0FF / #0D1A30 |
| `--flit-bg-card` | `--color-surface-elevated` | #FFFFFF / #162744 |
| `--flit-bg-hover` | `--kit-hover` | #E1EBFB / #22385E |
| `--flit-bg-table-header` | `--kit-linea` | #A9C9FC / #3A5688 |
| `--flit-success-ink`, `--flit-chip-success-ink` | `--kit-verde-texto` | #4F7121 / #A6D95F |
| `--flit-warning-ink`, `--flit-chip-warning-ink` | `--kit-naranja-texto` | #BD3A00 / #FF7A40 |
| `--flit-danger-ink`, `--flit-danger-text` | `--kit-rojo-texto` | #C10000 / #FF6B6B |
| `--flit-cyan-ink` | `--kit-turquesa-texto` | #00736B / #2FD6C9 |
| `--flit-success` / `--flit-warning` / `--flit-danger` (rellenos, puntos) | `--kit-verde` / `--kit-naranja` / `--kit-rojo` | color del manual |
| `--flit-shadow-card`, `--shadow-card` | **ninguna** (el kit no da sombra a tarjetas, botones ni modal) | — |
| `--flit-shadow-modal`, `--shadow-floating` | `--kit-sombra` (solo dock, menús, avisos, foco) | 3px 3px 3px |
| `--flit-radius-card/-lg/-xl/-input` | `9px` (`rounded-[9px]`, o `rounded-lg`, que ya es 9) | — |
| `rgba(22,39,68,.45)` (velos) | `--kit-velo` + `backdrop-blur-[5px]` (`.kit-velo`) | #557EFF80 / #0D1A30A6 |

### 2.2 Clases y componentes

| Patrón viejo en páginas | Nuevo |
|---|---|
| `style={{ background: 'var(--flit-gradient-primary)' }}` + `text-white` | `<GradientButton>` o `className={flitBtnPrimary}` (ya plano) o `className="btn"` |
| Botón contorno «Cancelar/Exportar» | `GradientButton variant="secondary"` (tinta) — **destructivo** (cancelar, anular, eliminar, rechazar, revocar, salir) → `variant="alerta"`; confirmar/aprobar → `variant="success"` |
| Acción secundaria **de fila** de tabla («Ver», «Editar», «Descargar» en la celda de acciones) | **Contorno**: `className={flitBtnSecondarySm}` (32 px, borde línea, texto azul; `flitBtnIconoSm` si es solo ícono). **No** `claseBoton('secondary', 'sm')`: ese es el secundario **tinta** compacto (36 px) de pies de modal, diálogos, Dr. Flit y barras, y se queda así. Regla: en la fila, contorno; fuera de la fila, tinta. |
| Chip de estado propio (`rounded-full px-2 … bg-…`) | `<StatusChip>`, `<EtiquetaEstado estado>` o `{...etiquetaKit('warn')}` |
| `animate-pulse` / esqueleto propio | `<PageContentSkeleton>` o `<div className="kit-esqueleto h-4 w-40" />` |
| `Loader2 animate-spin` | `<Girador />` (16 px) o `<Cargador texto>` (132 px) |
| Modal propio con velo negro | `<FlitModal>` (o `<Drawer>` lateral). Si un diálogo propio no puede migrar: `kit-velo` + `kit-modal` + `kit-modal__cabeza/__titulo/__cerrar/__cuerpo` |
| `<table>` suelta | `<DataTable>` (tarjetas ≤900 px; `matriz` para ~20 columnas) o `<FlitTable>` (scroll) |
| Pills de pestañas `FlitPillGroup role="tablist"` | `<Pestanas>` (línea inferior) — las pills quedan para **segmentados** (filtro de 2–4 opciones) |
| Input con clases propias | `className={flitInp}` o `className="control"` dentro de `.campo` |
| Íconos `lucide-react` | `<Icono nombre="…" />` (glifo del kit, `currentColor`) o `iconoComo('…')` donde se espera un componente |
| `bg-white`, `text-gray-*`, `slate-*`, `red-*`, HEX | tokens de la tabla 2.1 (barrido obligatorio, «restos en 0») |
| Cabecera de página propia | `<PageHeaderCard title icono="flito-…" miga={[…]} actions>` |

---

## 3. Catálogo de `components/flit/`

Todo import es `../components/flit/<Archivo>` (o `../../`). Las props existentes **no cambiaron**; lo nuevo es opcional.

| Componente | Uso | Notas |
|---|---|---|
| `GradientButton` | `<GradientButton variant="primary\|secondary\|success\|alerta\|ghost" size="sm" ocupado>` | Píldora plana. `ocupado` = girador + deshabilitado. `claseBoton(variante, tamaño)` para `<Link>`. |
| `flitPageKit` | `flitInp`, `flitBtnPrimary/Secondary/Danger/SecondarySm/IconoSm`, `FlitTable/FlitTh/FlitTr`, `FlitCard`, `FlitField`, `FlitPillGroup/FlitPillButton`, `FlitEmpty` | Reestilados al kit; los `*Style` quedan vacíos (compatibles). |
| `FlitModal` | `<FlitModal title onClose icono="lapiz" antetitulo="Detalle" wide>` | Blanco, ícono 52 centrado, X 36. `lateral` = panel. |
| `Drawer` | `<Drawer title onClose>` | Panel lateral con el estilo del modal. |
| `StatusChip` | `<StatusChip tone="success\|active\|warning\|danger\|draft\|neutral" tono?>` | Etiqueta con punta. `tono` acepta los del kit (`revocado`, `radicado`, `anulado`, `preasignacion`, `tinta`). |
| `kit/tonos` | `etiquetaKit(tono)`, `registrarEstados({...})`, `estadoKit(e)` | Registro ESTADO→{tono, glifo\|icono} extensible por módulo. |
| `Bloques` → `EtiquetaEstado` | `registrarEstados({ 'en-ruta': { tono: 'info', glifo: 'ruta' } })` y `<EtiquetaEstado estado="en-ruta">En ruta</EtiquetaEstado>` | Un ícono por estado. |
| `KpiCard` | `<KpiCard label value hint to icono="flito-soat" pendiente>` | `.metrica`: cifra azul, disco a la derecha; `pendiente` en naranja. |
| `PageHeaderCard` | `<PageHeaderCard title subtitle icono="flito-logistica" miga={[{etiqueta:'Logística', to:'/flito/logistica'}]} actions>` | Una h1; sin ícono ≤640 px. |
| `Miga` | `<Miga pasos actual>` | Empieza siempre en Inicio. |
| `Pestanas` | `<Pestanas etiqueta pestanas={[{id,etiqueta,to?,cuenta?}]} activa onElegir?>` | Con `to` son enlaces; con `onElegir`, `role=tablist`. Se deslizan en 375 px. |
| `PanelFiltros` | `<PanelFiltros busqueda onBusqueda placeholder campos={…} aplicados onQuitar onLimpiar onAplicar>` | Buscador + «Filtros» + panel + chips aplicados. **Estado en memoria/localStorage, nunca en la URL** (regla 14). |
| `RangoFechas`, `FiltroSegmentado`, `FiltrosInteligentes`, `ThFiltroMulti` | igual que antes | Chips del kit (`.chip--sm`), activo borde azul. |
| `DataTable` | `<DataTable ariaLabel columnas filas getKey status onRetry matriz seleccion paginacion>` | 4 estados dentro; columnas con `etiqueta` (modo tarjeta), `acciones`, `soloEscritorio`. |
| `Paginacion` | igual + modo cursor: omitir `total`/`totalPaginas` y pasar `hayAnterior/haySiguiente` | Página actual en círculo azul. |
| `MenuFila` | igual | Menú contextual del kit (sombra kit, hover azul). |
| `Cargador` → `Cargador`, `Girador`, `Vacio`, `ErrorVista`, `EstadoVista` (= `UiStateBoundary`) | `<EstadoVista status emptyMessage emptyCta onRetry>{lleno}</EstadoVista>` | Vacío con disco 72 y siguiente paso; error con reintento. |
| `InlineAlert` | `<InlineAlert tono="info\|ok\|warn\|danger" titulo>texto</InlineAlert>` | Estado persistente en página (no toast). |
| `ToastFlito` | `toastOk(texto)`, `toastError(texto, reintentar?)` | Aviso del kit arriba a la derecha, cerrable. |
| `FlitSwitch` | igual + `alerta` | Interruptor SVG 68×36. |
| `FlitUploadBox` | igual | `.carga` → `.carga--lista` (verde) / rechazada (naranja). |
| `FlitWizardSidebar` | igual (`steps`, `current`) | Ahora es el **avance horizontal** del kit. |
| `Bloques` → `PildoraTramite` | `<PildoraTramite datos={[{etiqueta:'Placa', valor:'KLM 482'}]} estado="En firma" />` | Bajo los pasos del asistente. |
| `Bloques` → `LineaAvance`, `AvanceBarra` | `<LineaAvance pasos actual />`, `<AvanceBarra valor etiqueta />` | Línea del detalle y barra de progreso. |
| `Bloques` → `ActividadLinea`, `ListaFila`, `Fichas` | línea de tiempo, filas con avatar/acción, fichas `dt/dd` | Molde `#tramite`. |
| `Bloques` → `BarraAccion` | `<BarraAccion accion={<GradientButton size="sm">Enviar</GradientButton>}>5 esperan firma</BarraAccion>` | Azul al 10 % con borde azul. |
| `Bloques` → `Embudo`, `Accesos` | chips de estado con conteo que filtran; tarjetas de acceso rápido | Molde `#tramites` / `#inicio`. |
| `Placa` | `<Placa placa="KLM482" ciudad="Medellín" size="lg" />`, `<Vehiculo placa nombre meta etiquetas />` | Barlow Condensed; texto real. |
| `Graficos` | `<Dona partes={[{t,v,c:SERIE_KIT.azul}]} etiqueta />`, `<BarrasGrupo etiquetas series titulo />` | Paleta del manual por `SERIE_KIT`. |
| `BannerInicio` | `<BannerInicio laminas={[{titulo,texto,icono,fondo:'degradado'}]} />` | Carrusel; la primera lámina es la h1. |
| `CampoClave` | `<CampoClave id … />` | Contraseña con «ver». |
| `LayoutPublico` | `<LayoutPublico>…</LayoutPublico>` | Portales públicos y seguimiento por enlace (sin shell). |
| `kit/Icono` | `<Icono nombre="campana" />`, `<Icono nombre="reportes" disco size={40} />`, `<IconoModulo clave="flito-soat" />`, `iconoComo('lapiz')` | Mapa de módulos FLITO en `kit/iconos-mapas.ts` (`flito-*`), inyectivo. |
| `icons.tsx` | igual (`IconHome`…) | Ahora sirven glifos del kit. |
| Shell | `AppShell`, `FlitTopbar`, `FlitNavBar`, `FlitSidebar`, `CommandPalette` | Barra (marca, buscador, tema y menú de usuario: sin notificaciones ni rejilla de productos), dock y buscador del kit. **El dock no reagrupa:** un botón por sección del catálogo de permisos, en `SECTION_ORDER` (General, Gestión, Tránsito, Flota, Mantenimiento, PESV, RNDC, LAFT, Finanzas, Administración, Ayuda) con los nombres de `SECTION_LABEL` y los ítems en el orden de `NAV_ENTRADAS` — lo que se ve en el menú es lo que se lee en Roles y permisos. Sin isotipo central: el Tablero es la sección General (enlace directo con el nombre del ítem). **Menú por ancho:** desde 1024 px, dock con «Más»: las secciones que caben van con nombre, en `SECTION_ORDER`, y las que no van al botón «Más» del final, cuyo panel las lista en el mismo orden (lo mide `FlitNavBar`; no hay modo solo-íconos). Por debajo de 1024 px no hay dock: el ☰ del topbar abre el menú lateral (`FlitSidebar`, piel del modal lateral del kit, anclado a la izquierda) con las mismas secciones e ítems en el orden de `useNavSections`; Escape, «Cerrar menú» o navegar lo cierran y el foco vuelve al ☰. `useDesdeLg` (`shell/useDesdeLg.ts`) es el único corte de 1024 px. Solo los glifos viven en `shell/iconosNav.ts`. |

---

## 4. Moldes: qué pantalla de la propuesta copia cada tipo de página

| Tipo de página FLITO | Molde (hash de la propuesta) | Piezas |
|---|---|---|
| Tablero / KPIs | `#inicio`, `#reportes` | `BannerInicio` (2fr) + `KpiCard` 2×2 (1fr), `Dona`, `BarrasGrupo`, `Accesos` |
| Bandeja + filtros + tabla | `#tramites` (simples: `#usuarios` con pestañas, `#log-qx`) | `PageHeaderCard` con miga · `Embudo` · `PanelFiltros` · `DataTable` con «Acciones» (`MenuFila`) · `Paginacion` · `BarraAccion` |
| Detalle | `#tramite` | `Vehiculo`/`Placa` grande · `LineaAvance` + `PildoraTramite` · `Fichas` · `ActividadLinea` · `ListaFila` (firmantes) |
| Wizard | `#traspaso` | `FlitWizardSidebar` (pasos) · `PildoraTramite` · pie Atrás (`secondary`) / Continuar (`primary`) |
| Formulario en modal | «Nuevo trámite» de `#tramites`, «Invitar colaborador» de `#usuarios` | `FlitModal icono` · `.campo` + `.control` · error naranja por campo con `aria-describedby` |
| Carga de archivos | paso de documentos de `#traspaso` | `FlitUploadBox` (`.carga` → `.carga--lista`), `VisorPdf` |
| Perfil | `#perfil` (+ modal contraseña) | `/perfil?accion=contrasena` abre el modal (contrato con S6) |
| Vacío / error / cargando | `.vacio`, `.grafico-vacio`, `.cargador` | `EstadoVista` / `Vacio` / `ErrorVista` / `Cargador` |
| Público sin cuenta | `#seguimiento`, `#simulador` | `LayoutPublico` |
| Ingreso | `#ingreso` (versión sobria) | ya hecho en `pages/Login.tsx` |

---

## 5. Reglas (además de AGENTS.md 8–13)

1. **Sin HEX** en páginas ni componentes; color solo por token con par oscuro. Sin `bg-white`, `slate-*`, `gray-*`, `red-*`.
2. **Sin restos Aura** (`aura-*`, `glass-*`, degradados, `shadow-card`, `Inter`). Cierre de cada zona = «restos en 0»:
   `grep -rnE "bg-white|#[0-9a-fA-F]{3,6}\b|gradient|aura-|shadow-\[|lucide-react|animate-pulse" <archivos de la zona>`.
3. **Sombra solo** en dock, menús flotantes, avisos y foco. Tarjetas, botones y modal sin sombra. Radio 9.
4. **Botones por función:** azul avanza · tinta secundario/navega · verde confirma (texto tinta) · naranja #D44100 destructivo.
5. **4 estados** en toda vista con datos (`EstadoVista`). Vacío con siguiente paso.
6. **A11y AA** en claro y oscuro; foco 2 px azul; `<label>` en cada campo; un `h1` por página.
7. **Responsive 320–1920** sin desborde: tablas → tarjetas ≤900 (o `matriz`), filtros en una columna ≤640, pestañas deslizables.
8. **Solo visual:** sin cambios de textos, aria, handlers, hooks, fetch ni estado (briefing k). Tests de aspecto: se actualiza el valor visual, nunca la lógica.
9. No portar el cursor de marca. Poppins única (también `.mono`).
10. Nada en la URL del SPA que sea PII (filtros en memoria).

---

## 6. Contrato para tests E2E (marcadores estables, no de piel)

Los tests no deben depender de clases de color ni de tamaños. Marcadores que S0 garantiza:

| Pieza | Marcador |
|---|---|
| Variante de botón | `data-variante="primario\|secundario\|confirmar\|alerta\|ghost"` en `GradientButton` (y en el botón de ingreso). |
| Cargador | `data-kit="cargador"` + `role="status"` + `aria-busy="true"` (texto visible del cargador). |
| Esqueleto (antes `.animate-pulse`) | `data-kit="esqueleto"` + `role="status"` + `aria-busy="true"` + `aria-label="Cargando página"`. |
| Etiqueta de estado | `data-tono="ok\|warn\|danger\|info\|neutro\|tinta\|radicado\|entregado\|revocado\|anulado\|preasignacion"`; `StatusChip` conserva `data-flit-chip`; `EtiquetaEstado` añade `data-estado`. |
| 4 estados | `data-testid="ui-loading\|ui-empty\|ui-error"` (`EstadoVista`); `data-kit="vacio\|error"`. |
| Tabla | `data-kit="tabla"` + `data-modo="tarjetas\|matriz"`; celdas con `data-etiqueta`. |
| Aviso (toast) | `data-kit="aviso"` + `data-tono`; botón «Cerrar aviso». En página: `data-kit="alerta"`. |
| Shell | `header[role=banner][data-kit=barra]`, `nav[aria-label="Navegación principal"]` (dock), triggers `#flit-navbar-trigger-<sección>` / paneles `#flit-navbar-panel-<sección>` (el «Más»: `#flit-navbar-trigger-mas` / `#flit-navbar-panel-mas`, cada sección en `.dock__seccion[data-seccion]`); <1024 px, ☰ `button[aria-label="Abrir menú de navegación"]` y menú lateral `role=dialog aria-label="Menú de navegación"` (`#flit-menu-lateral`, secciones en `li[data-seccion]`, paneles `#flit-menu-lateral-<sección>`) con `<sección>` ∈ `SECTION_ORDER` (`general, gestion, transito, flota, mantenimiento, pesv, rndc, laft, finanzas, admin, ayuda`); una sección con una sola página es enlace directo con el nombre del ítem (General → Tablero), como en el menú original; buscador `role=dialog aria-label="Paleta de comandos"` (`data-kit="buscador"`), input `role=combobox`; menú de usuario `button[aria-label^="Menú de usuario"]` + `role=menu "Opciones de usuario"`. |
| Tema | `localStorage['flit-tema']` = `light\|dark` (`aura-theme` sigue leyéndose como respaldo). Interruptor: `button.tema-kit[aria-pressed]`. |
| Pasos | `data-kit="pasos"`, cada `li` con `data-estado="hecho\|actual\|pendiente"` y `aria-current="step"`. |

Los `data-testid` que ya existían en componentes se conservaron.

---

## 7. Verificación

```bash
npm run typecheck -w apps/web
npm run lint
npm run build:web
npm run check:bundle                 # entry /login ≤ 32 KB gzip (S0: 26,4 KB)
npx playwright test e2e/tests/<spec>.spec.ts   # el spec de la zona tocada
```

Visual (obligatorio por pantalla): 1280 y 375, claro y oscuro (`localStorage.setItem('flit-tema','dark')` antes del
goto), comparando con la propuesta servida. Revisar: una altura de control por barra, hover en controles, sin
desborde horizontal, cabecera que envuelve, 4 estados, nada ilegible en oscuro.
