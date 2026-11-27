# UX slim — Bolsas: la rama de tránsito en el listado, el formulario y el detalle (HU #13908)

- **Modo:** slim · **Feature:** #13887 · **Producto:** FLITO, módulo `flito-bolsas` (`/api/flito/bolsas`, catálogo único).
- **Base:** `docs/ux/flito-bolsas.md` (HU #13901). Este doc es **solo el delta**: lo que no se nombra aquí no cambia.
- **Público:** operador interno de Financiera / admin (sin enlace). La proyección Cliente no cambia: tránsito no existe para el Cliente.
- **Tono:** **tú**, como ya usan `BolsaForm.tsx` y `BolsaDetalleCompania.tsx` («Elige», «Marca», «Reactiva»).

---

## Superficie tocada

| Superficie | Qué cambia |
|---|---|
| `BolsasTablero.tsx` (listado) | Filtro **Alcance** nuevo. El acordeón Tránsitos deja las tarjetas y pasa a ser una `FlitTable` alimentada por el mismo `POST /buscar` |
| `BolsaForm.tsx` (alta y edición) | `RamaTransitoProvisional` se sustituye por `RamaTransito` (nombre, cobros y secretarías). Edición de tránsito |
| Detalle de tránsito (modal `full`) | Se recompone como `BolsaDetalleTransito`, con la misma familia que `BolsaDetalleCompania`: tarjeta Bolsa, estado, inactivar o reactivar, cobertura, movimientos y **cierres** |
| Se retira | `BolsaTransitoForm.tsx` y las llamadas a `/api/flito/bolsas/transito/*` (AC7). Lo único visible es que el formulario de tránsito pasa a ser la rama del formulario único: **no** hay segundo modal ni botón «Continuar» |

**No cambia:** la cabecera de la página ni su única primaria («Crear bolsa»), los KPIs, las alertas de saldo, el buscador, el segmentado Estado, la tabla de Compañías (**incluida la celda de expediente #13407, que no se toca ni se mueve**), el detalle de compañía, la proyección Cliente y el patrón `RegionDesplazable`.

---

## Delta de claridad (qué se ve / qué se calla)

**Qué vino a hacer:** encontrar la bolsa de tránsito, ver si está viva y cuánto le queda (o cuánto se debe si está en préstamo), cargarle saldo, ajustar su cobertura, inactivarla o reactivarla, y cerrar el mes.

**Qué se ve primero:** en el listado, la fila con **nombre, estado, saldo y nivel**; en el detalle, **saldo y estado** con la acción de esa visita (cargar saldo, o reactivar si está inactiva).

| Nivel | Listado (fila de tránsito) | Detalle de tránsito |
|---|---|---|
| Siempre visible | Bolsa (nombre), Estado, Saldo, Nivel (escala de tránsito, con «En préstamo»), «Ver detalle» | Estado + Nivel, Saldo, la deuda si está en préstamo, cobertura (secretarías × cobros), avisos de inactiva y de autogestión, la primaria del estado |
| A un clic | Cobertura, deuda, totales, movimientos, cierres → **detalle** | Libro de movimientos y cierres (más abajo en la misma región desplazable). Motivo de la inactivación (dentro del aviso) |
| No está | Deuda, Total cargado y Total consumido **como columnas**. Columna de expediente (#13407 es solo de compañía: la fila de tránsito no tiene esa celda, ni siquiera vacía) | Los 3 `KpiCard` de hoy: pasan a una línea de totales para que el saldo sea la única cifra grande |

**Densidad:** **se alivia.** La rejilla de tarjetas (cuatro cifras y la cobertura por tarjeta) pasa a una tabla de cuatro columnas. Se añade un control (el segmentado Alcance), que cabe en la barra que ya existe y envuelve.

### Listado — wireframe del delta (≥ lg)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Buscar [ Compañía, bolsa o NIT…   ]  Alcance (Todas|Compañías|Tránsito)  Estado (Todas|Activas|Inactivas)
└──────────────────────────────────────────────────────────────────────────────┘
▼ Compañías (24) · …                          ← SIN CAMBIO (se oculta con Alcance = Tránsito)
▼ Tránsitos (6) · Saldo que FLIT precarga para pagar ante las secretarías.
  ┌──────────────────────────┬────────────┬──────────────┬────────────────┬──────────────┐
  │ Bolsa                    │ Estado     │        Saldo │ Nivel          │              │
  ├──────────────────────────┼────────────┼──────────────┼────────────────┼──────────────┤
  │ Bolsa Centro             │ ● Activa   │ $ 12.400.000 │ ● Normal       │ [Ver detalle]│
  │ Bolsa Occidente          │ ● Activa   │  − $ 850.000 │ ● En préstamo  │ [Ver detalle]│
  │ Bolsa Costa              │ ● Inactiva │       $ 0    │ ● Agotada      │ [Ver detalle]│
  └──────────────────────────┴────────────┴──────────────┴────────────────┴──────────────┘
```

- **Alcance:** `FiltroSegmentado` del kit, rótulo «Alcance», opciones **Todas · Compañías · Tránsito**, por defecto **Todas**. Viaja en el body de `POST /buscar` como `alcance` (undefined, `'compania'`, `'transito'`). Con un alcance elegido se pinta **solo** su acordeón; con Todas, los dos. Una sola llamada a `/buscar`: las filas se reparten por `alcance`.
- **Estado:** el segmentado de hoy, sin cambio. «Inactivas» + «Tránsito» = las bolsas de tránsito inactivas (AC3).
- **Columnas de tránsito:** Bolsa (`nombre`, `truncate` + `title`) · Estado (`StatusChip` «Activa» `success` / «Inactiva» `draft`) · Saldo (derecha, `tabular-nums`, negativo con «−» y `--flit-danger-ink`) · Nivel (`StatusChip` con `NIVEL_BOLSA_TRANSITO_LABEL[fila.transito.nivel]` y su tono; **no** el `nivel` de compañía) · acción `flitBtnSecondarySm` «Ver detalle» con `aria-label="Ver el detalle de la bolsa <nombre> (tránsito)"`.
- **Celda #13407:** la tabla de tránsito **no** declara esa columna. La de Compañías no se toca.

### Formulario — rama Tránsito (alta)

```
┌ Crear bolsa ─────────────────────────────────────────────── ✕ ┐
│ ¿De quién es la bolsa?   ( ) Compañía   (●) Tránsito           │  ← sin cambio
│                                                                │
│ Nombre *                                                       │
│ [ Ej. Bolsa Centro                                         ]   │
│                                                                │
│ ¿Qué cobros descuenta? *                                       │  ← fieldset
│ [■] Derechos de tránsito   [ ] SOAT   [■] Impuestos            │
│                                                                │
│ Secretarías a las que aplica *  (2 seleccionadas)              │  ← fieldset
│ [ Buscar secretaría…                                       ]   │
│ ┌──────────────────────────────────────────────────────────┐   │  ← lista con scroll propio (max-h)
│ │ [■] Secretaría de Movilidad de Bogotá                     │   │
│ │     Ya la cubre «Bolsa Centro» para Impuestos.            │   │  ← solo tras 409, danger-ink
│ │ [■] Secretaría de Tránsito de Cali                        │   │
│ │ [ ] Secretaría de Tránsito de Medellín                    │   │
│ └──────────────────────────────────────────────────────────┘   │
│ ┌ (409 cobertura_ocupada) ─────────────────────────────────┐   │  role="alert"
│ │ Estas secretarías ya las cubre otra bolsa activa para el  │   │
│ │ mismo cobro. Quítalas o desmarca ese cobro para guardar:  │   │
│ │ • Secretaría de Movilidad de Bogotá · Impuestos —         │   │
│ │   en «Bolsa Centro»                                       │   │
│ └──────────────────────────────────────────────────────────┘   │
│ ⓘ (AC9, solo en edición) Este organismo es autogestionado…    │  role="note"
│                               [ Cancelar ]  [ Crear bolsa ]    │  ← una primaria
└────────────────────────────────────────────────────────────────┘
```

- **Orden de los campos:** nombre → cobros → secretarías (el de `BolsaTransitoForm` hoy). Cobros: `CONCEPTOS_BOLSA_TRANSITO` con `CONCEPTO_BOLSA_TRANSITO_LABEL`, **ninguno marcado** de entrada (misma razón que en compañía). Catálogo de secretarías: la fuente que ya usa `BolsaTransitoForm` (`/transito/organismos-config`, que no es una ruta `/flito/bolsas/transito/*`).
- **Pie:** «Cancelar» + **«Crear bolsa»** («Creando…» mientras envía). Desaparece «Continuar» y la nota provisional.
- **Habilitado** con nombre `trim` ≥ 3, ≥ 1 cobro y ≥ 1 secretaría. Errores en línea al perder el foco: «Escribe un nombre de al menos 3 caracteres.», «Marca al menos un cobro.», «Elige al menos una secretaría.».
- **Edición** (desde el detalle, «Editar cobertura»): título «Editar la bolsa {nombre}», alcance como texto fijo («Alcance Tránsito»), los mismos tres campos ya rellenos y el primario «Guardar cambios», deshabilitado si nada cambió.

### Detalle de tránsito — wireframe (≥ lg)

```
┌ Bolsa Occidente ─────────────────────────────────────────────────────── ✕ ┐  ← cabecera fija
│ ╔ RegionDesplazable (AC8) ═══════════════════════════════════════════════╗│
│ ║ ┌ Bolsa ─────────────────────────────────────────────────────────────┐ ║│
│ ║ │ ● Activa  ● En préstamo        [Editar cobertura] [Inactivar] [Cargar saldo]│
│ ║ │ − $ 850.000                                                        │ ║│
│ ║ │ Se debe $ 850.000 a quien opera la bolsa. La próxima carga lo neta.│ ║│  ← solo en préstamo
│ ║ │ Cargado $ 40.000.000 · Consumido $ 40.850.000                      │ ║│  ← línea muted, no KPIs
│ ║ │ Cobertura: Derechos de tránsito, Impuestos en 3 secretarías  [Ver] │ ║│  ← lista plegable
│ ║ │ ⓘ Este organismo es autogestionado para impuestos: …               │ ║│  ← solo si paresAutogestionados
│ ║ └────────────────────────────────────────────────────────────────────┘ ║│
│ ║ ┌ Movimientos (128) ───────────────────────────────────────────────┐  ║│
│ ║ │ FlitTable: Fecha · Tipo · Secretaría · Trámite · Valor · Saldo resultante · Registrado por │
│ ║ └──────────────────────────────────────────────────────────────────┘  ║│
│ ║ ┌ Cierres del mes ────────────────────────────── [Cerrar un mes] ─┐  ║│  ← secundario
│ ║ │ FlitTable: Mes · Saldo inicial · Entradas · Salidas · Saldo final · Movimientos · Cerrado por / el │
│ ║ └──────────────────────────────────────────────────────────────────┘  ║│
│ ╚════════════════════════════════════════════════════════════════════════╝│
└───────────────────────────────────────────────────────────────────────────┘
```

**Una primaria por estado** (mismo patrón que compañía):

| Estado | Primaria | Secundarias |
|---|---|---|
| Activa | **«Cargar saldo»** (con `bolsas.transito.cargar`) | «Editar cobertura» (`…editar`), «Inactivar» (`…inactivar`), «Cerrar un mes» (`…cierre.crear`) |
| Inactiva | **«Reactivar bolsa»** (con `…inactivar`) | «Cerrar un mes». **«Cargar saldo» y «Editar cobertura» no se pintan**; el aviso dice por qué |

- **Bolsa inactiva (AC4):** el aviso `role="status"` es el de compañía, con su copy: «Inactiva desde el {fecha} por {nombre}. Motivo: «{motivo}». No recibe descuentos ni cargas de saldo. **Reactiva la bolsa primero.**» Sin `…inactivar`: «Para cargarla, alguien con permiso tiene que reactivarla primero.»
- **Inactivar y reactivar:** el `ModalEstadoBolsa` de compañía, sin cambio (motivo ≥ 5, contador, «Inactivar bolsa» / «Reactivar bolsa»). Cambia el texto: «Mientras esté inactiva no recibe descuentos ni cargas de saldo, y sus secretarías quedan libres para otra bolsa. Lo ya asentado no cambia.» Ojo: «sus secretarías quedan libres» es la consecuencia que explica el 409 al reactivar. **Confirmar con backend que es así antes de pintarlo**; si no lo es, se quita esa cláusula.
- **Reactivar con la pareja tomada (409 `cobertura_ocupada`):** se cierra el modal y en la tarjeta Bolsa, bajo el aviso de inactiva, aparece un **aviso de página** `role="alert"`: «No pudimos reactivarla: otra bolsa activa ya cubre estas secretarías para el mismo cobro.» + la lista «{secretaría} · {cobro} — en «{bolsaNombre}»» + por cada bolsa distinta, el enlace **«Ver «{bolsaNombre}»»**, que cambia el detalle a esa bolsa (para quitarle la secretaría o inactivarla). El aviso dura hasta el siguiente intento o hasta cerrar el detalle.
- **Cerrar un mes (AC5)** — `FlitModal` compacto «Cerrar un mes de {nombre}»: selector «Mes *» con los últimos 12 meses **sin cierre** (por defecto el anterior al actual; uno ya cerrado no se ofrece) + el texto «Se guardan el saldo inicial, las entradas, las salidas y el saldo final de {noviembre de 2026} tal como están hoy.» Pie: «Cancelar» + **«Cerrar {noviembre de 2026}»** («Cerrando…»). Éxito: se cierra el modal, se relee la tabla de cierres (la fila nueva sale con sus totales) y toast. 409 `periodo_cerrado` (carrera): `role="alert"` en el modal: «{Noviembre de 2026} ya estaba cerrado. Lo verás en la lista de cierres.», se relee la lista y el selector deja de ofrecer ese mes.
- **Sin `bolsas.transito.cierre.crear`:** «Cerrar un mes» **no existe** en el DOM. Sin `bolsas.transito.cierres.ver`, la sección de cierres no se pinta.
- **Cargar saldo:** el `ModalCargaTransito` de hoy, sin cambio de forma; solo pasa a `POST /bolsa/:id/recargas`. Si la bolsa se inactivó entre medias (409 `bolsa_inactiva`): `role="alert"` en el modal, «Reactiva la bolsa primero.», sin cerrarlo, y el detalle se relee por debajo.

### Autogestión de impuestos (AC9)

- Fuente: `bolsa.paresAutogestionados` del detalle (pares secretaría + impuesto). No bloquea guardar.
- **Copy** (`role="note"`, el mismo bloque visual de `AvisoAutogestion`, **sin** enlace a Clientes y proveedores, porque eso es de compañía):
  - Una secretaría: «**{Secretaría X}**: este organismo es autogestionado para impuestos: no llegarán movimientos de impuesto a la bolsa salvo excepciones.»
  - Varias: «Estos organismos son autogestionados para impuestos: {A}, {B}. No llegarán movimientos de impuesto a la bolsa salvo excepciones.»
  - El texto del AC se conserva literal desde «este organismo es autogestionado…».
- **Dónde:** en el **detalle** (tarjeta Bolsa) y en el **formulario de edición**, filtrado a las parejas que siguen marcadas. En el **alta**, el formulario no puede saberlo antes de guardar (el catálogo de secretarías no trae la modalidad): se guarda y el aviso aparece en el detalle que se abre a continuación. Ver «Pregunta abierta».

---

## Estados (4) + copy

| Sección | Cargando | Error (con siguiente paso) | Vacío (con siguiente paso) | Lleno |
|---|---|---|---|---|
| **Acordeón Tránsitos** | El esqueleto de la página (sin cambio) | «No pudimos cargar las bolsas. Revisa tu conexión e intenta de nuevo.» + **Reintentar** (el mismo error del listado: una sola llamada) | Sin filtro: «Todavía no hay bolsas de tránsito. Pulsa «Crear bolsa» y elige Tránsito.» (copy actual). Con filtro: «Ninguna bolsa de tránsito coincide con «{texto}»{ en las inactivas}.» + **Limpiar filtros** | La tabla |
| **Formulario: secretarías** | La lista `disabled` con «Cargando secretarías…» | «No pudimos cargar las secretarías.» + **Reintentar** en línea; el primario queda deshabilitado | Catálogo vacío: «No hay secretarías configuradas. Configúralas en Tránsito.» (enlace solo con `hasPage` de la configuración de tránsito). Búsqueda sin resultados: «Ninguna secretaría coincide con «{texto}».» | La lista |
| **Detalle (tarjeta)** | `EsqueletoBolsa` (reutilizado) | «No pudimos cargar la bolsa. Intenta de nuevo.» + **Reintentar**. 404: «Esta bolsa ya no existe o no tienes acceso a ella.» + **Volver al listado** | — (una bolsa siempre tiene tarjeta) | Wireframe |
| **Movimientos** (AC6) | Esqueleto de 5 filas de la tabla, no «Consultando…» | «No pudimos cargar los movimientos de la bolsa. Intenta de nuevo.» + **Reintentar** (solo esta sección) | Activa con `cargar`: «Esta bolsa todavía no tiene movimientos. Empieza con «Cargar saldo».» Inactiva, o sin permiso: «Esta bolsa todavía no tiene movimientos.» | `FlitTable` |
| **Cierres** (AC6) | Esqueleto de 3 filas | «No pudimos cargar los cierres. Intenta de nuevo.» + **Reintentar** (solo esta sección) | Con `cierre.crear`: «Todavía no se ha cerrado ningún mes. Usa «Cerrar un mes» cuando termine el periodo.» Sin él: «Todavía no se ha cerrado ningún mes.» | `FlitTable`, el más reciente primero |

**Errores de guardar el formulario (nunca crudos):**

| Respuesta | Dónde | Copy |
|---|---|---|
| 409 `cobertura_ocupada` (AC2) | Aviso `role="alert"` sobre el pie + marca en cada secretaría afectada | Ver wireframe. **Se conserva todo lo escrito.** La lista se recalcula contra la selección actual: la pareja que el usuario desmarca sale del aviso, y cuando no queda ninguna, el aviso desaparece |
| 409 `nombre_en_uso` | En línea bajo Nombre | «Ya hay una bolsa con ese nombre. Elige otro.» |
| 400 `datos_invalidos` | `role="alert"` en el modal | «Revisa el nombre, los cobros y las secretarías e intenta de nuevo.» |
| 409 `bolsa_inactiva` (edición) | `role="alert"` en el modal | «Reactiva la bolsa primero para cambiar su cobertura.» |
| Otro | `role="alert"` en el modal | «No pudimos crear la bolsa. Intenta de nuevo.» / «No pudimos guardar los cambios. Intenta de nuevo.» |

**Toasts (cerrables, una frase, unos 4 s):**

| Acción | Toast |
|---|---|
| Crear bolsa de tránsito (AC1) | «Bolsa {nombre} creada.» → se cierra el formulario, se relee el listado y **se abre el detalle** de la bolsa nueva (activa) |
| Guardar cobertura | «Cobertura de la bolsa actualizada.» |
| Inactivar / reactivar | «Bolsa inactivada.» / «Bolsa reactivada.» (sin cambio) |
| Cerrar un mes | «{Noviembre de 2026} cerrado.» |
| Cargar saldo | El de hoy, sin cambio |

El conflicto de reactivar, la bolsa inactiva y la autogestión son **avisos de página o del modal**, no toasts: siguen siendo ciertos mientras se mira.

---

## Responsive + feedback del delta

**< lg:**
- La barra de filtros envuelve: Buscar a ancho completo, y Alcance y Estado cada uno en su línea. Los segmentados no llevan `min-w`.
- La tabla de tránsito usa el scroll horizontal de `FlitTable`, con «Bolsa» como primera columna.
- Formulario: los cobros en `grid-cols-1 sm:grid-cols-3`, la lista de secretarías a ancho completo con `max-h` y su propio scroll, y el pie envuelve.
- **Detalle (AC8):** en `RegionDesplazable` (`overflow-x-hidden`, `overscroll-contain`, `100dvh`). Se llega al último movimiento y a los cierres con la rueda, el teclado (Tab a la región, luego Av Pág o Fin) y el gesto táctil. Título y ✕ fijos. Los botones de la tarjeta envuelven, con la primaria la primera de su línea. Las dos tablas, con su propio scroll y **sin scroll horizontal del modal**: todo hijo `flex` lleva `min-w-0`.
- Los modales «Cerrar un mes» e inactivar/reactivar, a ancho completo con `p-4`.

**Feedback:**
- Segmentado Alcance y botones: los del kit (hover, `active`, `disabled`, `flit-focus`).
- Filas de secretaría y casillas de cobro: `<label>` clicable completo, con `hover:bg-[var(--flit-bg-hover)] transition-colors` y casilla con `flit-focus`, como en la rama compañía.
- Enlaces «Ver «{bolsa}»» y «Ver» de la cobertura: `ENLACE` de `BolsaForm` (subrayado, `--flit-blue-text`, hover `--flit-blue-ink`, `flit-focus`).
- Sin animaciones, sin sombras nuevas.
- **Tokens:** los avisos de nivel del detalle de hoy usan `TONO_NIVEL` local con `fondo`/`texto`. Pasan a `StatusChip` con tono de tokens (`en_prestamo` y `critico` → `danger`, `bajo` → `warning`, `agotada` → `danger`, `sin_cargas` → `draft`, `normal` → `success`). El error del detalle pasa de `--flit-danger` a `--flit-danger-ink`. Revisar en claro y en oscuro.

---

## Permiso/slug

Ruta y `PageSlug` **existentes**: `/flito/bolsas`, `flito_bolsas`. Sin página nueva. Funciones, todas ya en el catálogo:

| Control | Función | Sin ella |
|---|---|---|
| Filas de tránsito en `/buscar` | `bolsas.transito.listar` | El acordeón Tránsitos no se pinta y Alcance no ofrece «Tránsito» |
| Opción «Tránsito» del formulario | `bolsas.transito.crear` | Sin cambio respecto a la HU #13901 |
| Ver detalle / movimientos | `bolsas.transito.ver` / `…ver_movimientos` | Sin «Ver detalle» / sección de movimientos no pintada |
| Editar cobertura | `bolsas.transito.editar` | No se pinta |
| Inactivar / Reactivar | `bolsas.transito.inactivar` | No se pinta (y cambia el copy del aviso) |
| Cargar saldo | `bolsas.transito.cargar` | No se pinta |
| Ver cierres / Cerrar un mes | `bolsas.transito.cierres.ver` / `bolsas.transito.cierre.crear` | Sección no pintada / botón inexistente en el DOM (AC5) |

Datos: `POST /buscar` (`transito.nivel`, `deuda`, `totalCargado`, `totalConsumido`), `GET /bolsa/:id` (`cobertura`, `paresAutogestionados`), `POST /` · `PATCH /bolsa/:id`, `POST /bolsa/:id/inactivar|reactivar`, `GET /bolsa/:id/movimientos`, `POST /bolsa/:id/recargas`, `GET|POST /bolsa/:id/cierres`. **Ningún endpoint nuevo.** La cobertura muestra el nombre de la secretaría (alias del catálogo), nunca el código DIVIPOLA solo.

---

## Notas para QA (≤10)

1. **AC1:** crear con Tránsito, nombre, 1–2 cobros y 2 secretarías → toast cerrable «Bolsa {nombre} creada.» y el detalle de esa bolsa abierto, en «Activa». Ya no hay botón «Continuar» ni un segundo modal.
2. **AC2:** forzar el 409 `cobertura_ocupada` → aviso con «{secretaría} · {cobro} — en «{bolsa}»» y la marca en la secretaría. Nombre, cobros y secretarías siguen como estaban. Al desmarcar la pareja, sale del aviso. Ningún texto crudo.
3. **AC3:** Alcance «Tránsito» + Estado «Inactivas» muestra solo las de tránsito inactivas, con el filtro en el body de `/buscar` (la URL no cambia). Las filas de tránsito **no** tienen celda de expediente. La tabla de Compañías la conserva igual que antes.
4. **AC4:** inactivar con 4 caracteres → deshabilitado; con 5 → «Inactiva», sin «Cargar saldo» y con el aviso «Reactiva la bolsa primero.». Reactivar con la pareja tomada → aviso de página con la pareja y «Ver «{bolsa}»».
5. **AC5:** cerrar 2026-11 → modal «Cerrar noviembre de 2026» → la fila aparece en Cierres con sus totales. Forzar un 409 `periodo_cerrado` → aviso en el modal, sin error crudo. Sin `cierre.crear`, el botón no existe en el DOM.
6. **AC6:** movimientos y cierres, cada uno con esqueleto, error + «Reintentar» independiente (forzar 500 en una sola de las dos rutas), vacío con siguiente paso, y lleno.
7. **AC7:** en la pestaña de red, ninguna petición a `/api/flito/bolsas/transito/`. `BolsaTransitoForm.tsx` ya no existe.
8. **AC8:** detalle con más de 50 movimientos y algún cierre, a 1440 px y a 375 px: se llega a los cierres con la rueda, con el teclado y con el gesto; la cabecera y la ✕ siguen visibles; no hay scroll horizontal del modal.
9. **AC9:** una bolsa con una secretaría autogestionada para impuestos → el aviso con el texto literal en el detalle y en la edición, y «Guardar cambios» sigue habilitado.
10. Las bolsas «En préstamo» llevan «−» y la deuda escrita, no solo color. Revisar listado y detalle en **tema oscuro**.

---

## Decisiones y pregunta abierta

- **Alcance como segmentado que oculta un acordeón**, no una tabla mezclada: se mantiene la disposición A de la HU #13901 (las escalas de nivel distintas y la celda #13407 solo de compañía siguen siendo la razón) y se cumple el «filtro por alcance» del AC3.
- **«Cargar saldo» se oculta (no se deshabilita) con la bolsa inactiva**, por paridad con compañía (AC6 de #13901, ya validado), con el aviso como explicación. El AC4 dice «deshabilitada». Si el PO lo quiere visible y deshabilitado, es un cambio de una línea: `disabled` + `aria-describedby` al aviso, y nunca con peso de primaria junto a «Reactivar bolsa».
- **Pregunta abierta (no bloquea):** el aviso del AC9 en el **alta**, antes de guardar, necesita conocer la modalidad de impuesto de cada secretaría, y `/transito/organismos-config` no la trae. Hoy se cumple en la edición y en el detalle que se abre justo después del alta. Si el PO lo exige antes del primer guardado → requerimiento a architecture/backend (exponer la modalidad en el catálogo), no un endpoint inventado.
- **A confirmar con backend:** que inactivar libera la cobertura (lo da a entender el 409 al reactivar). Condiciona una cláusula del texto de inactivar.
