# Diseño slim: Épica #14707, bloque 4. Rediseño de Gestión Trámites y detalles apaisados

- **Modo:** slim (extensión de patrón). Un tradeoff real, el waiver de contraste, va en [ADR-0050](../adr/ADR-0050-azul-557eff-waiver-contraste.md) (Propuesto).
- **UX aprobada:** [`docs/ux/flito-tramites-rediseno.md`](../ux/flito-tramites-rediseno.md). Si el documento y la maqueta `docs/ux/mockups/flito-tramites-rediseno.html` no coinciden, manda la maqueta.
- **Contexto de la Épica:** [ADR-0049](../adr/ADR-0049-tramite-muerto-no-existe.md), [`epica-14707-tramite-muerto.md`](epica-14707-tramite-muerto.md) (§8, bloques 1 a 3) y [`docs/ux/epica-14707-tramite-muerto.md`](../ux/epica-14707-tramite-muerto.md).
- **Módulos:** FLITO (`flito-tramites`, `flito-soat`, `flito-impuestos`) y el kit común (`components/flit/`, `styles/`). No toca ningún módulo legacy. La placa y el azul **se ven** en el legacy porque son piezas comunes.
- **API:** sin cambios en este bloque. Lo que necesita ya lo trae el bloque 2 (§2).

---

## Patrón reutilizado

| Pieza | Vecino que se copia |
|---|---|
| `FlitModalHorizontal` | `apps/web/src/components/flito/tramites/detalle/ModalDetalleTramite.tsx:16-134`: `ModalPortal` + `useEscape` + `useFocusTrap` + `kit-modal` con `aria-labelledby`. Y `components/flit/FlitModal.tsx` para `useBackdropClose`, `restoreFocusRef` y `wide` |
| Acordeón de Filtros | `components/flito/tramites/SincronizacionTramites.tsx`, con las clases `acordeon` y `acordeon__cuenta` |
| `CampoFiltro` (multi) | `components/flit/ThFiltroMulti.tsx` (`OpcionFiltro`, apertura, Escape y clic fuera). **No se modifica**: lo usan otros 11 archivos |
| `CampoFiltro` (fechas) | `components/flit/RangoFechas.tsx` sin cambios, montado dentro de un popover |
| Tabla sin tarjeta | `pages/FlitoSoat.tsx:591-602` → `TablaColaSoat` → `DataTable` (`tabla-wrap kit-matriz`) |
| Función pura en shared-types + test | `packages/shared-types/__tests__/` (`npm run test:shared-types`) |
| Estado de filtros → query | `queryTramites(...)` de `pages/FlitoTramites.tsx:152`. **Se conserva tal cual** |

---

## 1. Azul `#557eff` (R3)

Lo decide el [ADR-0050](../adr/ADR-0050-azul-557eff-waiver-contraste.md). Este es el resumen operativo.

- **Generados:** se cambian con el parche determinista del generador `docs/ux/rediseno-2026/generadores/gen-css.cjs` (tabla `MARCA_FLITO`, con conteos y aborto). Después se regenera `kit-variables.css` y `kit-ui.css`.
  - Lo comprobé el 2026-11-26: regenerar sin parche desde `flit@propuesta-2` (`89fbacc78`) reproduce el repo byte a byte. La única diferencia es el cursor de `.kit-cuerpo` en `kit-ui.css`, y la tabla también lo recoge.
  - Comando: `S=$(mktemp -d); git -C /home/david/flit/flit archive propuesta-2 docs/design/propuesta-ui-kit-2026 | tar -x -C "$S"; node docs/ux/rediseno-2026/generadores/gen-css.cjs "$S/docs/design/propuesta-ui-kit-2026" apps/web/src/styles/kit`.
  - **El diff tiene que contener solo las líneas de la tabla.**
- **A mano:** `tokens.css:35, 49` (`--kit-azul-relleno: #557eff`, **literal**, ver ADR §Decisión 1) y `kit-react.css:29` (`--c: var(--kit-azul); --ct: var(--color-action)`). En `kit-react.css:184` se reescribe el comentario.
- **Gate:**
  - `scripts/check-contraste-paleta.mjs`: clave estable por caso, lectura de `scripts/contraste-waivers.json`, `WAIVER` visible y trinquete de obsolescencia.
  - `apps/web/e2e/helpers/axe.ts`: filtro por nodo con piso de 3,0, que lee el mismo JSON.
- **Criterios de aceptación:**
  - `grep -rni "1d53ff\|1746e0" apps/web/src` vacío;
  - `npm run check:contraste` en verde, con 10 líneas `WAIVER`;
  - los dos temas, revisados en la maqueta.
- **Texto azul sobre tinte azul** (barra de selección 2,84:1, `chip[aria-pressed]`): no lo cubre el waiver. Por defecto va en tinta, a la espera de la pregunta 2 del ADR.

## 2. `tipoServicio`: de dónde sale y dónde se normaliza

**El dato ya existe y se sincroniza.** La UX §7.4 suponía que «probablemente no lo trae», pero no es así.

- `vehicles.tipo_servicio` (`apps/api/src/db/schema/flota.ts:71`, migración 0166, HU #11906) lo escribe `upsertVehiculo()` en **todos** los trámites, en los dos sync:
  - FLIT 1: `flit-http.adapter.ts:126` (`it.tipoServicio`);
  - FLIT 2: `flit2-sync-http.adapter.ts:142` (`tipoServicio.nombre`).
- En la 0166 se midieron dos valores, «Particular» y «Publico» (sin tilde, aunque FLIT 2 puede mandarla).
- La 0166 explica por qué la columna es **texto y no enum**: un valor nuevo abortaría el sync del trámite. **Sin migración, y no se toca el sync.**

**Lo que ya expone el bloque 2** (diff del árbol de trabajo, en crudo `string | null`):

| Lectura | Campo | Archivo |
|---|---|---|
| Fila de Gestión Trámites | `TramiteFila.vehiculo.tipoServicio` | `flito-tramites.service.ts` (`proyeccion`, `aFila`) |
| Detalle del trámite | `TramiteDetalleVehiculo.tipoServicio` | `packages/shared-types/src/flito-tramites-detalle.ts:48`, `flito-tramites-detalle.service.ts:77` |
| Detalle del impuesto | `ImpuestoDetalle.tipoServicio` | `flito-impuestos.service.ts` (`SELECT_COLA`, `detalleImpuesto`) |
| Cola y detalle SOAT | `tipoServicio` | **Ya existía** (HU #11906, `flito-soat.service.ts:1018`; web `components/flito/soat/tipos.ts:15`) |

Con eso queda resuelta R-2 (pregunta 4 de la UX §16): los dos detalles tienen el dato. **El backend no hace nada más en este bloque.**

**Decisión: se normaliza al leer, en `packages/shared-types`, con una función pura. No hay campo normalizado en la API.**

- El contrato no crece con un segundo campo que diga lo mismo que el crudo.
- El crudo sigue haciendo falta para el texto visible («Serv. Público» de la cola SOAT).
- Hay un único punto de interpretación del texto libre, y **lo llama `Placa`**, no cada pantalla. Así se cumple la intención de la UX («la UI no interpreta texto libre»): ninguna pantalla compara strings.
- Si mañana la API necesita el valor normalizado (filtro, export), importa la misma función.
- Web no tiene Vitest, y shared-types sí tiene tests.

Archivo nuevo: `packages/shared-types/src/vehiculo-placa.ts`, exportado desde `index.ts`.

```ts
export type TipoServicioVehiculo = 'particular' | 'publico' | 'oficial' | 'diplomatico' | 'otro';
/** null/vacío → null. Sin tildes, minúsculas, espacios colapsados. «Público»/«PUBLICO»/«Servicio público» → 'publico'. Desconocido no vacío → 'otro'. */
export function normalizarTipoServicio(crudo: string | null | undefined): TipoServicioVehiculo | null;
/** Placa de moto colombiana: sin espacios ni guiones, ^[A-Z]{3}\d{2}[A-Z]$ (MNB22F). El formato viejo AAA45 NO es moto. */
export function esPlacaMoto(placa: string | null | undefined): boolean;
export type VariantePlaca = 'particular' | 'moto' | 'publico' | 'moto-publico';
export function variantePlaca(placa: string | null | undefined, tipoServicio: string | null | undefined): VariantePlaca;
```

Solo `'publico'` cambia el color. Oficial, diplomático y otro quedan amarillos, como define la UX §7.1 («Particular u otro»). No es PII. **Contrato HTTP y OpenAPI: sin cambio.**

## 3. `Placa.tsx` (componente común, 12 archivos con `<Placa`)

```ts
export interface PlacaProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  placa: string;
  ciudad?: string | null;
  size?: 'md' | 'lg';
  formatear?: boolean;
  /** NUEVO. Texto crudo de `vehicles.tipo_servicio`. Lo interpreta `variantePlaca`; sin dato → amarilla. */
  tipoServicio?: string | null;
  /** NUEVO. sr-only «, servicio público» + `title`. Default true; false donde la línea del vehículo ya lo dice en texto. */
  anunciarServicio?: boolean;
}
```

- **Salida:** clase `placa--moto` o `placa--publico` (en moto pública, las dos) y `data-variante="moto|publico|moto-publico"`, que sirve de gancho estable para E2E. En la variante por defecto no lleva atributo.
- **Retrocompatibilidad:** las 12 llamadas compilan sin cambios. El único efecto global es que **la moto cambia de color en todas las pantallas** (aceptado en la UX §7.2). El blanco de servicio público solo aparece donde se pase `tipoServicio`.
- **`Vehiculo`** (mismo archivo) gana `tipoServicio?` y `anunciarServicio?`, y los pasa a la placa grande.
- **CSS:**
  - Va en **`kit-react.css`** y no en `kit-propuesta.css`, como decía la UX §7.2, porque `kit-propuesta.css` es **generado**. `kit-react.css` carga después en la misma capa y gana por orden.
  - Clases: `.placa--moto`, `.placa--publico` y la combinación doble (filetes de la UX §7.1).
  - Tokens `--placa-fondo-moto: color-mix(in srgb, var(--placa-fondo) 72%, var(--kit-naranja))` y `--placa-fondo-publico: #ffffff` en `tokens.css` §3, iguales en los dos temas.
  - Las variantes llevan `background-image: none`.
- **Quién pasa `tipoServicio` en este bloque:**
  - fila de Trámites (con `anunciarServicio={false}`);
  - los tres detalles (`Vehiculo`, con `anunciarServicio={false}`).
  - El resto de usos no tiene el dato y queda como está.

## 4. Componentes nuevos del kit y piezas existentes

| Pieza | Decisión |
|---|---|
| **`components/flit/FlitModalHorizontal.tsx`** (nuevo) | API de la UX §8.2, sin cambios: `nombreAccesible`, `titulo` + `tituloId?`, `antetitulo?`, `chips?`, `navegacion?`, `lateral` + `etiquetaLateral`, `indice?`, `children` + `etiquetaContenido`, `contenidoRef?`, `onScrollContenido?`, `onClose`, `restoreFocusRef?`, `cierreBloqueado?`, `trampaActiva?`. Estructura: `kit-modal kit-modal--horizontal`, `kit-modal__cabeza` en fila, `kit-modal__columnas` (lateral, índice y contenido como `role="region"` con `tabIndex={0}`). **No incluye el pie de acciones**: las acciones viven en el `bloque-cabeza`/`acciones-fila` del contenido, que pinta quien lo usa. Si `kit-modal__acciones` hace falta, es solo para submodales, que siguen en `FlitModal`. `FlitModal` no cambia |
| CSS del modal | En `kit-react.css`: `.kit-modal--horizontal`, `__columnas`, `__lateral`, `__indice`, `__contenido`, `.bloque-cabeza`, `.acciones-fila`, `.lateral-bloque`, `.lateral-titulo`, `.enlace-btn` (UX §8.1). Solo tokens; los valores oscuros heredan |
| **`components/flit/CampoFiltro.tsx`** (nuevo, del kit) | Unión discriminada: `{ tipo: 'multi', rotulo, opciones: OpcionFiltro[], seleccion: string[], onCambio, todos: 'Todos'\|'Todas', nombreGrupo }` · `{ tipo: 'unica', rotulo, opciones, valor, onCambio, ariaLabel?: (valorTexto) => string }` · `{ tipo: 'fechas', rotulo, valor: Rango, onCambio }`. Control de 40 px con chevron y `data-puesto`, menú `menu-flotante` + `opcion-filtro` con casillas y `<label>`, Escape que devuelve el foco. Reutiliza el tipo `OpcionFiltro` de `ThFiltroMulti`; la mecánica del menú se copia en un hook local del archivo, **sin tocar `ThFiltroMulti`** |
| **`components/flito/tramites/FiltrosTramites.tsx`** (nuevo) | Fila del encabezado (botón con burbuja, buscador y vistas rápidas), rejilla de 10 `CampoFiltro` en el orden de R10 y pie con los chips aplicados y «Limpiar filtros». Estado local: solo `abierto` (`useState(false)`, que se pliega en cada visita). Sin `empresasOpc` (usuario con enlace) no se pinta la celda Empresa gestora |
| **`components/flito/tramites/useFiltrosTramites.ts`** (nuevo) | Recibe **tal cual** el estado de filtros de la página (`FlitoTramites.tsx:74-146`: texto/`buscar` con debounce, `estadosSel`, `soatSel`, `impSel`, `ciudadesSel`, `transitosSel`, `empresasSel`, `autogestionSel`, `fuenteSel`, `creado`, `aprobado`, `ordenSel`, `preset`, `alertaSel`), y suma `cuenta` (filtros activos + alerta, **sin** el texto), `chipsAplicados`, `limpiar()` y `aplicarPreset()`. Devuelve los argumentos de `queryTramites` sin cambios |
| **`components/flito/tramites/BarraTablaTramites.tsx`** (nuevo) | Dos modos (UX §5.2 y §5.5), sticky y opaca. En modo selección, el texto sobre el tinte va en tinta (ADR-0050, pregunta 2) |
| **`components/flito/tramites/detalle/PanelEstadoTramite.tsx`** (nuevo) | El lateral «Estado de la gestión» (`dl` desde la fila) con el índice debajo. Sin botones |
| `CabeceraTramites.tsx` | **Pierde** los 6 `ThFiltroMulti`, `conDetalle` y todas las props de filtro (`facetas`, `estados`, `ciudades`, `transitos`, `soat`, `imp`, `empresas`). Quedan `ver` y `seleccionPagina`. Se corrige su comentario de cabecera, que dice que la página tiene techo congelado y ya no lo tiene |
| `ThFiltroMulti` | **Se queda**: 11 archivos más lo usan |
| `FiltroSegmentado` | **Se queda** (13 archivos lo usan); solo sale de `FlitoTramites.tsx` |
| `RangoFechas` | Sin cambio de API. Se usa dentro del popover de `CampoFiltro` |
| `BarraFiltrosCola` / `BarraFiltrosSoat` / `ImpuestosFiltros` | **No se tocan**, así que las colas no cambian |
| `ModalHistorial` (`ModalesTramite.tsx:131`) | Se retira, porque su único uso es `FlitoTramites.tsx:470`. Con él salen también el estado `historial` y el `GET …/historial` de la página. El chip abre el detalle en la sección Historial (respuesta por defecto a la pregunta 2 de la UX) |

## 5. Estado de filtros y contrato

- **Mismo contrato de API:** `GET /flito/tramites?<queryTramites(...)>` y `GET /flito/tramites/facetas`, con los mismos parámetros. **No hay filtros nuevos.** Lo único que cambia es dónde se pinta el control: del encabezado de columna y la barra pasa al panel.
- **AGENTS.md §14 (deuda previa, Nota; no se amplía):**
  - `buscar` (placa, VIN o nombre) y `empresas` (NIT) viajan hoy en la query del GET;
  - la página acepta `?buscar=`/`?placa=` (HU #12635).
  - Prohibido en este bloque:
    - añadir parámetros con PII o cuasi-PII a la query;
    - **serializar los filtros del panel en la URL de la página** (Empresa = NIT en el router);
    - hacer que `CampoFiltro` o `FiltrosTramites` escriban en `window.location`.
  - La lectura existente de `?buscar`/`?placa`/alerta se conserva sin cambio.
  - Moverlo a `POST …/buscar` sería un Bug o una HU aparte, y no está en el pedido.

## Contrato delta

```
HTTP / OpenAPI .......... sin cambio (lo consume del bloque 2: vehiculo.tipoServicio, vigenciaTramite, noVigentes, /api/flito/avisos)
shared-types ............ + vehiculo-placa.ts (TipoServicioVehiculo, normalizarTipoServicio, esPlacaMoto, variantePlaca); index.ts +1 export
web tipos locales ....... tiposTramites.ts: TramiteFila.vehiculo.tipoServicio + vigenciaTramite (bloque 3);
                          tipo local del detalle de impuesto: tipoServicio
Placa ................... + tipoServicio?, anunciarServicio? (opcionales; retrocompatible)
kit ..................... + FlitModalHorizontal, CampoFiltro; tokens --placa-fondo-moto/-publico; azul ADR-0050
gate .................... scripts/contraste-waivers.json (nuevo); check-contraste y helper axe lo leen
```

---

## 6. Orden y reparto con el bloque 3: se fusionan

**Recomendación: fusionar los bloques 3 y 4 en un solo frontend, en 2 PRs en serie, repartidos por dueño de archivo.**

- **Por qué no «3 antes que 4»:** el bloque 3 toca `FilaTramite`, `CeldasTramite` y `ModalDetalleTramite` sobre el layout viejo, y el 4 los reescribe justo después. Se pagaría dos veces el código, las fichas de ayuda y el spec `flito-tramite-muerto.spec.ts`, que habría que escribir sobre un layout que muere en el PR siguiente.
- **Encaje con la UX:** la del rediseño ya integra la de 14707 «sin contradecirla» (fila muerta, aviso primero, sin fila de acciones). Fusionar no cambia ningún comportamiento aprobado.
- **Regla del reparto:** lo de 14707 que vive en un archivo que el PR reescribe va **en ese PR**. Así ningún archivo se toca dos veces, salvo `kit-react.css`, `api.ts`, `FlitoTramites.tsx` y `content/ayuda/flito_tramites.md`, que se tocan **en serie** en A y en B.

**Dependencias:**
- Los dos PRs se apilan **sobre el bloque 2 commiteado**. Consumen `tipoServicio`, `vigenciaTramite` y `noVigentes`, y el B, además, `/api/flito/avisos`.
- El paso A1 (solo azul) **no comparte ningún archivo** con el bloque 2 (CSS, `scripts/`, `e2e/helpers/`, `docs/`). Puede arrancar en paralelo al `backend-agent` en su propio worktree, dentro del tope de 2 agentes de código. Por defecto, en serie.
- **No hay nada más en paralelo:** `packages/shared-types/src/index.ts` lo modifica el bloque 2.

### Archivos por bloque

**PR A: kit, azul, placas y detalles apaisados (≈ 1050 líneas de producto, sin contar el CSS regenerado)**

| Paso | Archivo | Acción | ~Líneas |
|---|---|---|---|
| A1 | `docs/ux/rediseno-2026/generadores/gen-css.cjs` | Tabla `MARCA_FLITO` + aborto por conteo + aserción sin `1d53ff` | +45 |
| A1 | `apps/web/src/styles/kit/kit-variables.css`, `kit-ui.css` | **Regenerar** (el diff = solo la tabla) | ~12 cambiadas |
| A1 | `apps/web/src/styles/tokens.css` | Relleno `#557eff` (:35, :49) + tokens de placa | +4 |
| A1 | `apps/web/src/styles/kit/kit-react.css` | `info` (:29), comentario (:184) | ~3 |
| A1 | `scripts/contraste-waivers.json` | crear | 25 |
| A1 | `scripts/check-contraste-paleta.mjs` | `clave` por caso, waiver, trinquete, salida `WAIVER` | +60 |
| A1 | `apps/web/e2e/helpers/axe.ts` | Filtro por nodo con piso, impresión de lo excluido | +45 |
| A1 | `docs/ux/rediseno-2026/README.md` | §1 y §2.1: valores nuevos y nota del generador | docs |
| A2 | `packages/shared-types/src/vehiculo-placa.ts` + `index.ts` | crear / +1 export | 45 |
| A2 | `packages/shared-types/__tests__/vehiculo-placa.test.ts` | crear (tildes, mayúsculas, vacío, desconocido, moto, `AAA45`, guiones, precedencia) | test |
| A2 | `apps/web/src/components/flit/Placa.tsx` | Props nuevas, variante, sr-only | +30 |
| A2 | `apps/web/src/styles/kit/kit-react.css` | `.placa--moto` / `.placa--publico` / doble filete | +12 |
| A3 | `apps/web/src/components/flit/FlitModalHorizontal.tsx` | crear | 130 |
| A3 | `apps/web/src/styles/kit/kit-react.css` | Patrón apaisado (UX §8.1) | +45 |
| A4 | `components/flito/tramites/tiposTramites.ts` | `vehiculo.tipoServicio`; `vigenciaTramite`; `esAccionable` exige `'vigente'` (bloque 3) | +6 |
| A4 | `components/flito/tramites/detalle/ModalDetalleTramite.tsx` | `FlitModalHorizontal`; cabecera sin placa; el chip Anulado/Revocado de 14707; aviso 14707 primero; error de acción `role="alert"` al pie del bloque Vehículo | ±140 |
| A4 | `components/flito/tramites/detalle/SeccionesDetalle.tsx` | Vehículo primero con `bloque-cabeza` + `acciones-fila`; Resumen sin estado ni fuente; liquidación y factura marcadas «Revocado» (14707) | ±80 |
| A4 | `components/flito/tramites/detalle/PanelEstadoTramite.tsx` | crear | 70 |
| A4 | `apps/web/src/pages/FlitoTramites.tsx` | Solo pasar el error de la acción al modal (corrige D4) | +8 |
| A4 | `apps/web/src/lib/api.ts` | Error tipado `TRAMITE_NO_VIGENTE` (409) (bloque 3) | +12 |
| A5 | `components/flito/soat/DetalleSoat.tsx` | `FlitModalHorizontal`; título «SOAT» con `nombreAccesible` «SOAT · {placa}»; lateral (aviso, comprobante con enlaces, documentos); fila en «Datos»; «Corregir» en `ghost sm` | ±90 |
| A5 | `components/flito/DetalleImpuesto.tsx` | Igual (UX §10.2) + `tipoServicio` en el tipo local | ±90 |
| A6 | `content/ayuda/flito_soat.md`, `flito_impuestos.md`, `flito_tramites.md` (sección detalle) | skill `flit-ayuda-flito` | docs |

**PR B: bandeja, trámite muerto y avisos (≈ 1250 líneas de producto)**

| Paso | Archivo | Acción | ~Líneas |
|---|---|---|---|
| B1 | `apps/web/src/components/flit/CampoFiltro.tsx` | crear | 160 |
| B1 | `apps/web/src/styles/kit/kit-react.css` | `acordeon-fila`, `filtros-rejilla`, `campo-filtro`, `control-filtro`, `filtros-pie` | +50 |
| B2 | `components/flito/tramites/useFiltrosTramites.ts` | crear (estado movido desde la página) | 130 |
| B2 | `components/flito/tramites/FiltrosTramites.tsx` | crear | 170 |
| B2 | `components/flito/tramites/BarraTablaTramites.tsx` | crear | 90 |
| B2 | `apps/web/src/pages/FlitoTramites.tsx` | Fila de Filtros, avisos, barra, tabla sin `FlitCard`, paginación abajo, 4 estados y `toastError`; fuera el error pegajoso, la columna Ver y `ModalHistorial`. **Neto negativo, meta ≤ 400** | −150 / +70 |
| B2 | `components/flito/tramites/CabeceraTramites.tsx` | Sin filtros (§4) | −35 |
| B3 | `components/flito/tramites/FilaTramite.tsx` | ID como botón; vehículo (`Placa` + tipo y servicio en texto); soportes; chip Anulado/Abortado/Revocado sin acciones y con la casilla deshabilitada (14707) | ±70 |
| B3 | `components/flito/tramites/CeldasTramite.tsx` | Celdas mínimas (R5); «Solicitar» secundario; «Descartado» en tenue (14707) | ±60 |
| B3 | `components/flito/tramites/ModalesTramite.tsx` | Fuera `ModalHistorial` | −40 |
| B4 | `apps/web/src/lib/api.ts` | `avisos.listar`, `avisos.marcarVisto` (bloque 3) | +15 |
| B4 | `apps/web/src/components/flit/AvisosUsuario.tsx` + `FlitTopbar.tsx` | crear / montar (bloque 3) | 140 / +4 |
| B4 | `components/flito/soat/ChipEstadoSoat.tsx`, `ImpuestoCola.tsx` | `descartado` (bloque 3) | +15 |
| B4 | `pages/FlitoSoat.tsx`, `pages/FlitoImpuestos.tsx` | Copy del 409 en un toast cerrable y refresco (bloque 3) | +20 |
| B4 | `pages/SiigoOperacion.tsx`, `pages/FlitoLogistica.tsx` | Chip «Revocado» en el histórico (bloque 3) | +30 |
| B5 | `content/ayuda/flito_tramites.md` (bandeja) + capturas | skill `flit-ayuda-flito` | docs |
| B5 | `apps/web/e2e/tests/flito-tramite-muerto.spec.ts` | crear **sobre el layout nuevo** (bloque 3) | test |

Si el PR B pasa de 1500 líneas al medirlo, el paso B4 (avisos y 14707 fuera de Trámites) sale a un PR C en serie. No se parte de otra forma.

## 7. E2E afectados

| Spec | PR | Qué cambia |
|---|---|---|
| `flito-tramites-detalle.spec.ts` | A | Sección inicial «Vehículo»; acciones en el encabezado del bloque; «FLIT 1» solo en la cabecera |
| `flito-soat*.spec.ts`, `flito-impuestos*.spec.ts` (9 con nombre de diálogo «SOAT · / Impuesto ·») | A | El nombre del diálogo se conserva. Verificar «Ver soporte»/«Descargar» en el lateral, `kit-modal__cuerpo` (desaparece en el apaisado) y `toBeInViewport`. No hay `heading` con «SOAT ·» (grep: 0) |
| Specs con axe (27; en el alcance: `soat-vin-unico-ficha-runt-a11y`, `flito-impuestos-fases-a11y`, `soat-envio-directo-gestor-a11y`, `flito-impuestos-envio-flit2`, `flito-soat-vigencia-a11y`, `soat-documentos-adicionales(-edicion)`, `flito-comprobantes`) | A | Los cubre el filtro del helper. Si alguno falla, es un par fuera del waiver: se corrige el color, **no el spec** |
| `users-ambito.spec.ts:866`, `finanzas-gastos-diarios.spec.ts:378` | A | Resuelven el token en tiempo de ejecución y no deberían romper. Verificar |
| `flito-tramites-fuente.spec.ts` + `.mobile.spec.ts` | B | Fuente y Autogestión pasan a desplegables (`/^Filtrar por fuente/`); «Limpiar filtros» en el pie del panel; «3 trámites» |
| `flito-tramites.spec.ts` | B | Sin `ThFiltroMulti`, sin columna Ver, sin documento y con celdas mínimas |
| `flito-tramites-novedades.spec.ts` | B | «seleccionados»; paginación abajo; «Solicitar SOAT (1)» se conserva (sin los `aria-label` de la maqueta, como recomienda la UX §5.2) |
| `flito-tramites-vistas-columnas.spec.ts` | B | «Columnas» se oculta durante la selección |
| `flito-tramites-sincronizacion`, `-estado-flit2`, `-acceso-flit2` | — | Sin cambio (riesgo bajo) |
| `ayuda-capturas.capturas.spec.ts` | A y B | Regenerar las capturas (azul, placa de moto, layout) |
| `flito-tramite-muerto.spec.ts` | B | Nuevo |

P1: los specs de esta tabla, filtrados por archivo. `typecheck -w apps/web`, `npm run check:contraste`, `npm run test:shared-types` y `npm run lint`.

## 8. Riesgos

- **Techo de 800 líneas:**
  - Ningún archivo de `apps/web` tiene techo congelado en `eslint.config.mjs`; los 5 de la lista son de `apps/api`.
  - En el alcance, los más grandes son `FlitoTramites.tsx` (496, tiene que **bajar**), `DetalleImpuesto.tsx` (481) y `DetalleSoat.tsx` (430); los dos detalles crecen como mucho ~50 cada uno (mueven JSX sin tocar lógica).
  - Ninguno se acerca a 800.
  - El CSS no lo mide ESLint.
- **El azul es global** (FLITO, legacy y canal Cliente): ver ADR-0050, Consecuencias y preguntas. **La placa de moto también** (12 archivos), así que hay que revisar Flota, Torre y Vehículos en la sesión de evidencias.
- **Texto azul sobre tinte azul** por debajo de 3:1 (barra de selección y chip pulsado): el filtro de axe lo detectaría. El default va en tinta (ADR-0050, pregunta 2).
- **Si se regenera con una propuesta que se movió,** el generador aborta por conteo. Es lo esperado: se revisa el diff de la propuesta, no se fuerza.
- **`IntersectionObserver` del índice:** la raíz cambia según el ancho. Desde `lg` desplaza `.kit-modal__contenido`; por debajo, `.kit-modal__columnas`. La sección inicial pasa a ser Vehículo.
- **Barra sticky opaca** con `top-[calc(var(--kit-alto-barra)+0.5rem)]`: hay que verificarla a 375 px con el teclado táctil (44 px).
- **Gates P5:**
  - `security-agent`: no aplica en A (CSS, `scripts/`, helper de E2E, componentes sin auth ni PII) ni en B (lo mismo que el bloque 3), salvo que el diff toque auth.
  - `db-review-agent`: no aplica (sin esquema).
  - `flit-ayuda-flito`: aplica en A y en B.
  - `ux-agent`: ya está hecho (aprobado).

## ADR

Sí: [ADR-0050](../adr/ADR-0050-azul-557eff-waiver-contraste.md) (Propuesto), solo para el waiver. El resto es extensión de patrón y no necesita ADR.

## Notas operativas

**frontend-agent**
- **El PR A empieza por A1:** regenerar y comprobar que el diff de los generados son solo las líneas de la tabla. Pegar la salida de `npm run check:contraste`, con las 10 líneas `WAIVER` y 0 `FALLA`.
- **No editar a mano** `kit-variables.css`, `kit-ui.css` ni `kit-propuesta.css`. Todo lo nuevo del kit va en `kit-react.css`.
- **El relleno `#557eff` va literal en `tokens.css` `:root`.** Con `var(--kit-azul)`, el oscuro sale `#8fb0ff` (ADR §Decisión 1).
- **`Placa`:** la variante se decide **solo** con `variantePlaca` de shared-types. Ninguna pantalla compara `tipoServicio` con strings.
- **Mover JSX sin tocar la lógica** de `DetalleSoat` y `DetalleImpuesto`: permisos, `accion`, `pagadoDesde`, `verSoporteRef`, `restoreFocusRef`. Los nombres accesibles «SOAT · {placa}» e «Impuesto · {placa}» se conservan.
- **Sin URL de filtros** (§5). **Sin `aria-label`** en la barra de selección (UX §5.2).
- **Reconocimiento:** P8, como mucho 8 llamadas. Los paths están en las tablas de §6.

**backend-agent:** nada en el bloque 4. El bloque 2 ya expone `tipoServicio` crudo en la fila, en el detalle del trámite y en el detalle del impuesto. **No** añadir un campo normalizado.

**qa-agent B**
- **Matriz:** UX §14 (10 puntos) + los AC del bloque 3.
- **Mutantes:** hasta 3, solo sobre lógica condicional:
  - `variantePlaca`, con la precedencia público > moto;
  - el trinquete del waiver (una entrada obsoleta tiene que dar `exit 1`);
  - el piso del filtro de axe (un nodo azul con 2,9 no se excluye).
- La UI y la maquetación van sin mutantes.
