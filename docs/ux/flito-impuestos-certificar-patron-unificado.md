# UX slim — «Certificar sin trámite» al patrón unificado de colas (HU #14665)

> Modo **slim**: extiende una pantalla existente. Hereda el patrón de
> `docs/ux/flito-soat-impuestos-patron-unificado.md` (Épica #14560, PRs #825 y #827), que dejó esta
> pestaña fuera a propósito (§11 y §12). **Solo frontend: la API no cambia.** El estado, las reglas
> de eliminar y descargar y el editor siguen igual. Cambia la piel y la composición.
> Mockup: `docs/ux/mockups/flito-impuestos-certificar-patron-unificado.html`
> (`?vista=lista | filtro | vacio | cargando | error`, `&tema=oscuro`).

---

## 1. Superficie tocada

| Archivo | Qué cambia |
|---|---|
| `pages/FlitoImpuestosShell.tsx` | La cabecera también deja el hueco de acciones (`data-hueco`) en `vista === 'certificar'`, y el subtítulo depende de la vista |
| `pages/FlitoImpuestosCertificar.tsx` | Se quita el bloque propio de título, subtítulo y botón. La acción pasa al hueco de la cabecera con `AccionesCabecera`. Se añade `BarraFiltrosCola` (embudo + buscador) y se filtra en cliente |
| `components/flito/impuestos/CertificarColumnas.tsx` (nuevo, solo columnas) | `ColumnaTabla<Fila>[]` en el orden canónico (§3), igual que `ImpuestosColumnas.tsx`. Así la página se queda lejos de las 800 líneas |
| `components/flito/impuestos/ChipEstadoCertificacion.tsx` (nuevo, solo presentación) | Chip con glifo, igual que `ChipEstadoImpuesto`. Mismos textos y tonos que el mapa `ESTADO` de hoy |
| `components/flito/EmbudoEstadoCola.tsx` | `modulo` acepta un tercer prefijo, `'certificacion'`, y registra `certificacion-todos` |
| `components/flito/BarraFiltrosCola.tsx` | `panel` pasa a ser **opcional**. Sin panel no se pinta el botón «Filtros» ni el panel (ver §4) |
| `pages/FlitoImpuestosCertificarEditor.tsx` | **Editor: sin cambio.** El patrón de detalle (las 8 zonas del §4 de la spec madre) es para la gestión de un trámite en modal. Esta vista es un formulario de alta y edición, y no se fuerza a ese molde |

Permiso y slug: **sin cambio**. Es la página `flito_impuestos`, la pestaña cuelga de la función
`impuestos.certificacion_directa.gestionar` (`FUNCION_CERTIFICAR`) y la ruta es `/flito/impuestos/certificar`.

---

## 2. Delta de claridad (qué se ve y qué se calla)

**Quién llega y a qué:** operador con la función de certificar. Viene a **crear una certificación**
o a **encontrar un registro** (por placa, VIN o propietario) para volver a consultar el RUNT,
descargar el certificado o limpiarlo.

**Qué se ve primero:** el vehículo (placa, o VIN si no tiene) y el estado. Después, quién es el
propietario y cuándo se registró.

**Única primaria:** «Nueva certificación», dentro de la cabecera del módulo, en el mismo sitio que la
carga masiva de la cola. En las vistas de alta y detalle ese hueco muestra «Volver al listado»
(secundaria). La primaria de esas vistas sigue siendo la del editor, que no cambia.

| Antes | Después |
|---|---|
| `h2` «Certificar sin trámite» + subtítulo de dos frases + botón, dentro de la pestaña | La cabecera del módulo cambia el subtítulo con la pestaña: **«Certifica ante el RUNT los vehículos que no tienen trámite en FLITO.»** El `h2` se queda como `sr-only`: sostiene la jerarquía h1→h2 del lector de pantalla y el E2E `getByRole('heading', { name: 'Certificar sin trámite' })` |
| «Quien tiene el permiso ve los registros de esta pantalla.» | **Sale.** Es mecánica interna y no ayuda a operar |
| Sin embudo ni búsqueda: 100 filas sin filtro | Tarjeta `BarraFiltrosCola` con el embudo de estado y el buscador, que filtran **en vivo, sobre las filas ya cargadas** |
| Columnas Placa · VIN · Propietario · Estado · Acciones | sel · **Vehículo** · **Estado** · Propietario · Registrado · acciones (§3). Placa y VIN se funden en una celda y entra la fecha. **Sigue habiendo 4 columnas de datos: la densidad no cambia** |
| Encabezado visible «Acciones» | `sr-only`, como en la cola |
| Chip de estado sin glifo | `ChipEstadoCertificacion` con glifo, en la lista y en la tarjeta de estado del detalle (`debajo`) |

**Qué se calla:** el organismo de la fila (`organismoNombre`). Viene del modelo viejo, el editor ya no lo
pide y aquí no decide nada. Tampoco se muestra el documento del propietario (PII; no está hoy y no entra).
Compañía, Gestiona, Solicitado, Pagado y Valor del orden canónico **no existen** en este modelo: son
huecos del patrón y no se rellenan con datos inventados.

---

## 3. Orden de columnas (canónico del §3.3, adaptado)

| # | Columna | Contenido | Pieza |
|---|---|---|---|
| — | casilla | Encabezado «Seleccionar las filas de esta página» (marca las **visibles**) y por fila «Seleccionar certificación {placa o VIN}» (el literal de hoy) | `seleccion` de `DataTable` |
| 1 | **Vehículo** | Placa en negrita (si no tiene, «Sin placa» en tinta terciaria), VIN en mono pequeño y una línea «Marca Línea · Año». Es la misma forma que la celda Vehículo de la cola | celda pila, como en `ImpuestosColumnas` |
| 2 | **Estado** | `ChipEstadoCertificacion`. Solo en `sin_coincidencia`, debajo en pequeño: «{n} dato(s) no coinciden», con `n` = filas `difiere` de `comparacion`, que ya llega en la lista | igual que las señales de la celda Estado de la cola |
| 3 | Propietario | `nombrePropietario` o «—» (sin cambio) | — |
| 4 | Registrado | `createdAt` (dd/mm/aaaa) y, si existe `certificadoEn`, una 2.ª línea pequeña «Certificado dd/mm/aaaa» | `tabular-nums` |
| 5 | acciones | `[Eliminar]` (solo si no está certificado, como hoy) `[Abrir]`. **Se conservan las etiquetas**: el E2E usa «Abrir» | sin cambio de lógica |

Estados del chip: los textos y tonos de hoy, con un glifo para que el estado no dependa solo del color.

| Estado | Texto | Tono | Glifo propuesto (se verifica contra `kit/tonos`) |
|---|---|---|---|
| `radicado` | Guardado | draft / neutro | `pausa` |
| `sin_respuesta` | Sin respuesta | warning | `reloj` |
| `sin_vehiculo` | Sin vehículo | warning | `alerta` |
| `sin_coincidencia` | No coincide | danger | `alerta` |
| `certificado` | Certificado | success | `doble-check` |

---

## 4. Embudo y filtros

**Embudo** (`EmbudoEstadoCola modulo="certificacion"`, `ariaLabel="Estados de la certificación"`):
`Todos · Guardado · Sin respuesta · Sin vehículo · No coincide · Certificado`. Arranca en «Todos» y
**va sin cifras**, como en las colas. Aquí además hay una razón propia: el listado trae como máximo
100 filas, así que una cifra «Todos 100» se leería como el total y no lo es.

**Buscador:** placeholder y `aria-label` «Buscar placa, VIN o propietario». Busca dentro de la placa,
el VIN y el nombre del propietario, sin distinguir mayúsculas ni tildes e ignorando espacios y guiones.
Se combina con el embudo (Y lógico). El texto vive **solo en el estado de React**, nunca en la URL
ni en la query (Ley 1581). No busca por documento.

**Panel «Filtros» (Quién · Cuándo · Riesgo):** **no se pone.** Este modelo no tiene compañía, gestor ni
señal de riesgo. Solo cabría «Registrado desde–hasta», y sobre un máximo de 100 filas que ya vienen de
la más reciente a la más antigua aporta poco. Por eso `BarraFiltrosCola` acepta `panel` opcional: sin
panel no aparece el botón «Filtros», que abriría un panel vacío o con un solo campo. **Vistas rápidas:**
ninguna (`vistas=[]`; el componente ya las oculta). «Limpiar filtros» aparece, como hoy en el
componente, con texto en el buscador o con el embudo fuera de «Todos», y deja los dos en su valor inicial.

**Tope de 100 filas (decisión de cliente).** El backend devuelve las 100 más recientes
(`createdAt DESC`, `TOPE_LISTA`), sin filtros de servidor. Con `filas.length >= 100`:
- Al pie de la tarjeta de filtros, en tinta terciaria y con `role="status"`: **«Se muestran las 100
  certificaciones más recientes.»**
- El vacío por filtro añade: **«La búsqueda solo cubre las 100 certificaciones más recientes.»**

Buscar en todo el histórico requiere backend: es la pregunta P-1, no se diseña aquí.

**Selección con filtro:** al cambiar el embudo o el texto, la selección **se recorta a las filas
visibles**. Ni «Eliminar seleccionados (n)» ni la descarga ZIP actúan sobre filas que no se ven
(pregunta P-2; es el default aplicado).

---

## 5. Composición (orden de arriba abajo, §3.1 del patrón)

1. Cabecera del módulo, compartida (`PageHeaderCard` del shell), con el subtítulo de la pestaña y
   **[Nueva certificación]** en el hueco.
2. Pestañas del shell (sin cambio).
3. `h2` sr-only «Certificar sin trámite».
4. Avisos persistentes, **en este orden y en este sitio**: `aviso` (`InlineAlert`, p. ej.
   «Certificación eliminada.»), `AvisoCertificadosZip`, `avisoLote`. Hoy `avisoLote` y el ZIP están
   entre la barra de selección y la tabla; suben aquí, como en la cola. No cambia el tipo de
   notificación.
5. Tarjeta `BarraFiltrosCola`: embudo, buscador, «Limpiar filtros» y la nota del tope.
6. `BarraAccion`, solo con selección > 0, con los mismos dos botones de hoy.
7. `DataTable` sobre las filas filtradas.

### Wireframe — lista llena, ≥ lg (1366 px)

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ Impuestos y SOAT ›                                                                          │
│ (icono) Impuestos                                                    [＋ Nueva certificación]│ ← única primaria
│ Certifica ante el RUNT los vehículos que no tienen trámite en FLITO.                        │
└────────────────────────────────────────────────────────────────────────────────────────────┘
  [ Impuestos ] [▔Certificar sin trámite▔]                                    ← pestañas (sin cambio)
  (h2 sr-only «Certificar sin trámite»)
  [aviso persistente si hay: «Certificación eliminada.» / ZIP en curso / resultado del lote]
┌─ tarjeta de filtros (BarraFiltrosCola, sin panel) ─────────────────────────────────────────┐
│ (●Todos) (●Guardado) (●Sin respuesta) (●Sin vehículo) (●No coincide) (●Certificado)        │
│ [🔍 Buscar placa, VIN o propietario                          ]  [✕ Limpiar filtros]*         │
│ Se muestran las 100 certificaciones más recientes.**                                        │
└────────────────────────────────────────────────────────────────────────────────────────────┘
┌─ BarraAccion (solo con selección) ─────────────────────────────────────────────────────────┐
│ 2 seleccionado(s)                  [Eliminar seleccionados (2)] [Descargar certificados]    │
└────────────────────────────────────────────────────────────────────────────────────────────┘
┌─ DataTable ────────────────────────────────────────────────────────────────────────────────┐
│ ☐ │ VEHÍCULO               │ ESTADO                 │ PROPIETARIO        │ REGISTRADO   │   │
│▌☑ │ ZZA101                 │ ⏸ Guardado             │ Ana Ejemplo Ruiz   │ 20/11/2026   │[Eliminar][Abrir]
│   │ 9ZZDEMO0000000101      │                        │                    │              │   │
│   │ Chevrolet Onix · 2026  │                        │                    │              │   │
│   │ ZZB202 …               │ ⚠ No coincide          │ Carlos Demo Pardo  │ 19/11/2026   │[Eliminar][Abrir]
│   │                        │ 2 datos no coinciden   │                    │              │   │
│   │ ZZC303 …               │ ✔✔ Certificado         │ …                  │ 18/11/2026   │        [Abrir]
│   │                        │                        │                    │ Certificado 18/11/2026 │
│   │ Sin placa · 9ZZDEMO…   │ ⧗ Sin respuesta        │ —                  │ 17/11/2026   │[Eliminar][Abrir]
└────────────────────────────────────────────────────────────────────────────────────────────┘
 * solo con filtro puesto   ** solo con filas.length >= 100   ▌ fila marcada
```

### Wireframe — móvil (375 px)

```
┌───────────────────────────────┐
│ Impuestos y SOAT ›            │
│ Impuestos                     │
│ Certifica ante el RUNT los    │
│ vehículos que no tienen …     │
│ [＋ Nueva certificación     ] │ ← ancho completo, bajo el título
└───────────────────────────────┘
 [Impuestos][Certificar sin trá…]  ← scroll del kit
┌───────────────────────────────┐
│ (Todos)(Guardado)(Sin res… →  │ ← embudo con scroll horizontal
│ [🔍 Buscar placa, VIN o…    ] │
│ [✕ Limpiar filtros]           │ ← envuelve debajo
└───────────────────────────────┘
┌ BarraAccion ──────────────────┐
│ 2 seleccionado(s)             │
│ [Eliminar seleccionados (2) ] │ ← ancho completo
│ [Descargar certificados     ] │
└───────────────────────────────┘
┌ tarjeta (DataTable <900px) ───┐
│ ☑ ZZA101                      │ ← Vehículo como título
│   9ZZDEMO0000000101           │
│   Chevrolet Onix · 2026       │
│ Estado       ⏸ Guardado       │
│ Propietario  Ana Ejemplo Ruiz │
│ Registrado   20/11/2026       │
│ [Eliminar]          [Abrir]   │
└───────────────────────────────┘
```

---

## 6. Estados (4 + vacío por filtro) y copy

Trato de **tú**, como en el resto de la pantalla («Carga la factura…», «Puedes consultar de nuevo»).

| Estado | Qué se ve | Copy |
|---|---|---|
| Cargando | La tarjeta de filtros ya pintada y el esqueleto de `DataTable` con las columnas de §3 | — |
| Error con reintento | Estado de error de `DataTable` + **Reintentar** (`cargarLista`) | «No se pudieron cargar las certificaciones. Revisa tu conexión e intenta de nuevo.» (mismo molde que la cola; nunca `e.message` crudo) |
| Vacío real (0 filas, sin filtro) | Vacío de `DataTable`. El siguiente paso es la primaria de la cabecera | «Todavía no hay certificaciones. Carga una factura de venta para empezar.» (**literal de hoy**, está en E2E) |
| **Vacío por filtro** | Vacío de `DataTable` con la tarjeta de filtros intacta y «Limpiar filtros» a la vista | «Ninguna certificación coincide con los filtros. Quita algún filtro o usa «Limpiar filtros».». Con el tope alcanzado, además: «La búsqueda solo cubre las 100 certificaciones más recientes.» |
| Lleno | §5 | — |

## 7. Responsive y feedback

- **<`lg`:** la cabecera apila «Nueva certificación» bajo el título, a ancho completo en <`sm`. Las
  pestañas usan el scroll del kit. El embudo hace scroll horizontal dentro de su contenedor (ya lo hace
  `BarraFiltrosCola`). Buscador y «Limpiar filtros» envuelven. Los botones de `BarraAccion` van a ancho
  completo en <`sm` (`llenaEnMovil`, como hoy). Por debajo de 900 px, `DataTable` pasa a tarjeta, con
  Vehículo de título y el resto con `data-etiqueta`; por debajo de 380 px, a una columna.
- **Feedback:** chips del embudo (`.chip` + `aria-pressed`), `.btn` y `.control` traen hover y foco
  del kit. Las casillas usan `accent-[var(--kit-azul)]` y el foco del kit. Nada queda plano y no se
  añaden efectos.
- **Notificaciones:** sin cambio de tipo. Los resultados de eliminar, del lote y del ZIP siguen como
  aviso en página (`InlineAlert` / `AvisoCertificadosZip`), ahora juntos en el sitio de avisos del
  patrón (§5.4). El filtro aplicado no lanza toast: se ve en el chip activo y en el buscador.

## 8. Qué NO cambia

Estados y transiciones; el `window.confirm` de eliminar (uno y lote) y su texto; la regla de que lo
certificado no se elimina (el botón ni se ofrece); la descarga ZIP y su aviso; el endpoint
`GET /flito/impuestos/certificacion-directa` y su tope; el editor (alta y edición), la lectura de la
factura y la tarjeta de detalle (`debajo`), salvo que su chip pasa a `ChipEstadoCertificacion`.
Tampoco cambian las etiquetas «Nueva certificación», «Volver al listado», «Abrir» y «Eliminar
seleccionados (n)», que el E2E usa por rol y nombre: se mueven, no se renombran.

## 9. Preguntas abiertas (cambian comportamiento; hay un default aplicado)

- **P-1. Búsqueda sobre las 100 más recientes.** ¿Se acepta que la búsqueda y el embudo trabajen solo
  sobre las 100 filas que ya trae la lista (con la nota del §4), o hay que buscar en todo el histórico?
  Lo segundo es **backend** (búsqueda por cuerpo `POST …/buscar`, por PII, regla 14) y queda fuera de
  esta HU. **Default: en cliente, con la nota.**
- **P-2. Selección al filtrar.** ¿Se recorta a lo visible al cambiar el filtro, o se conserva oculta?
  **Default: se recorta.** Una acción destructiva en lote nunca toca filas que no se ven.
- **P-3. Peso de «Eliminar» por fila.** Hoy es `alerta sm` (naranja) en cada fila no certificada. Con
  100 filas compite con la primaria. ¿Se baja a `secondary sm`, y el naranja queda para el lote y el
  detalle? **Default: sin cambio (`alerta sm`)**, porque el pedido es no tocar comportamiento ni peso
  de acciones. El PO puede aliviarlo.
- **P-4 (no bloquea).** ¿Falta un filtro «Registrado desde–hasta»? **Default: no**, por el §4. Si se
  pide, entra como único grupo «Cuándo» de `BarraFiltrosCola` y vuelve el botón «Filtros».

## 10. Notas para QA (≤10)

1. No cambia ninguna llamada de red. La búsqueda **no** dispara peticiones y **no** aparece en la URL
   (`page.url()` sin placa, VIN ni nombre tras escribir).
2. «Nueva certificación» está dentro de la cabecera del módulo (`.page-header`) y ya no en el cuerpo
   de la pestaña. Hay un solo botón con ese nombre.
3. En alta y detalle, el hueco de la cabecera muestra «Volver al listado»; en la pestaña Impuestos,
   las acciones de la cola, sin cambio.
4. Encabezados por nombre (no por índice): Vehículo, Estado, Propietario, Registrado. Ya no existen
   «Placa» ni «VIN».
5. El embudo filtra por estado exacto y el buscador encuentra por placa parcial, VIN parcial y nombre
   sin tildes. Combinados, Y lógico.
6. Vacío por filtro con su copy; «Limpiar filtros» devuelve las filas. El vacío real conserva el
   literal de E2E.
7. Selección: marcar 2, filtrar para ocultar 1, y «Eliminar seleccionados (1)» (P-2).
8. Con 100 filas aparece «Se muestran las 100 certificaciones más recientes.»; con menos, no.
9. <900 px: modo tarjeta, con «Abrir» y «Eliminar» alcanzables. Tema oscuro sin colores crudos.
10. `heading` «Certificar sin trámite» sigue presente en la pestaña (sr-only), como pide el E2E actual.

## 11. Decisiones y descartes

| Decisión | Descartado |
|---|---|
| Primaria en el hueco de la cabecera, como en la cola | Dejar su propia fila de título y botón: dos cabeceras en la misma pantalla |
| Sin panel «Filtros» (panel opcional en `BarraFiltrosCola`) | Un panel Quién · Cuándo · Riesgo vacío o con un solo campo, «por paridad»: densidad sin trabajo detrás |
| Embudo sin cifras | Cifras calculadas sobre 100 filas, que se leerían como el total |
| Placa y VIN en una celda Vehículo + columna Registrado | Agregar la fecha como 5.ª columna de datos (empeoraría la densidad) |
| Editor sin cambio | Forzar el formulario a las 8 zonas del detalle de gestión |
| Señal «n datos no coinciden» en la celda Estado, con datos ya cargados | Una columna de comparación en la lista: el detalle ya trae la tabla Factura/RUNT |

## 12. Brief de mockup

Archivo: `docs/ux/mockups/flito-impuestos-certificar-patron-unificado.html`, junto a la maqueta madre
para reutilizar sus rutas relativas al CSS real del kit y `torre-maqueta.css`. Es autocontenido, abre
con `file://` sin red y no tiene JS de negocio (solo el conmutador `?vista=` / `&tema=oscuro`). Vistas:
`lista` (llena, 2 filas marcadas, BarraAccion), `filtro` (vacío por filtro con la nota del tope),
`vacio`, `cargando` y `error`. Móvil: las mismas vistas a 375×812 (el kit pasa a tarjeta solo). Datos
ficticios: placas `ZZA101`… `ZZE505`, VIN `9ZZDEMO…` y nombres ficticios. No mostrar: panel de
filtros, organismo, documento del propietario ni cifras en el embudo. Capturas en
`docs/ux/mockups/flito-impuestos-certificar-patron-unificado-<vista>[-movil|-oscuro].png`, a 1366×768
y 375×812, y esperar el «ok» humano antes de lanzar `frontend-agent`.
