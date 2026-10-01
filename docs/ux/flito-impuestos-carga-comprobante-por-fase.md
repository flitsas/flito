# UX slim — Cargar comprobante (liquidación o pago) desde el detalle del impuesto (HU #13209)

Feature #12955 · Épica #12683 · módulo **`flito-impuestos`** (no el legacy `impuestos`).
Contrato: `POST /api/flito/impuestos/:id/recibos` (HU #13208, `docs/diseno/hu-13208-carga-comprobante-por-fase.md`),
tipos `RespuestaCargaPorFase` / `CodigoErrorCargaPorFase` / `FASES_RECIBO` de `@operaciones/shared-types`.
Sin endpoint nuevo ni requerimiento de datos nuevo.

## Superficie tocada

- `components/flito/DetalleImpuesto.tsx` — un botón secundario más en la celda **Soporte** del `<dl>`.
- `components/flito/ModalCargaReciboFase.tsx` — **nuevo**, hermano de `ModalReciboCaja.tsx` (misma
  estructura: `FlitModal` apilado sobre el detalle, `FlitUploadBox`, fases inicial / cargando /
  resultado / error, error decidido por `codigo` del cuerpo, nunca por el texto).
- `ModalReciboCaja.tsx` **no se toca**: conserva su botón, su permiso (`impuestos.recibos.cargar_caja`)
  y su copy.

Qué vino a hacer quien abre esto: **resolver un vehículo puntual** — subir la liquidación o el pago
que le falta a *este* impuesto y saber en un vistazo si quedó guardado y en qué estado quedó. Lo que
se ve primero en el modal es la **fase** (la única decisión) y luego el archivo.

Público: operador interno (Operaciones/admin y gestor del organismo dentro de su frontera). Tono:
**tú**, calcado del detalle y de `ModalReciboCaja` («Elige otro archivo», «reintenta»).

## Delta de claridad (qué se ve / qué se calla)

### En el detalle

```
┌ Impuesto · ABC123 ─────────────────────────────────────────── ✕ ┐
│ [Solicitado] [Solo liquidación]                                  │
│ VIN …               Trámite FLIT …                               │
│ …                                                                │
│ VALOR LIQUIDADO     LIQUIDADO EL                                 │
│ VALOR PAGADO        FACTURA DE VENTA                             │
│                     SOPORTE                                      │
│                     Ver soporte  [Cargar comprobante]            │
│                                  [Cargar recibo de caja]         │
│ ENVIADO POR         ENVIADO                                      │
│ …  (validación, dirección, historial, acciones de gestión)       │
└──────────────────────────────────────────────────────────────────┘
```

- **Dónde:** celda **Soporte**, entre «Ver soporte» y «Cargar recibo de caja». Es el sitio donde ya
  vive la evidencia y la otra carga puntual; **no** va a la fila de acciones de gestión
  (Rechazar / Asumir / Reversar), que es otra visita — mismo criterio escrito en el comentario de
  `:169-172`.
- **Orden fijo:** `Ver soporte` (enlace) · `Cargar comprobante` · `Cargar recibo de caja`. El
  comprobante de la hacienda va antes porque el recibo de caja **depende** de la liquidación.
- **Peso:** `flitBtnSecondary`, igual que el de caja. El detalle hoy **no tiene primaria** y sigue sin
  tenerla; no se promueve ninguno de los dos.
- **Cómo no se confunde con «Recibo de caja»:** el rótulo dice «comprobante» (glosario de la
  hacienda: liquidación/pago), el modal se titula por la fase y nombra las dos opciones; el de caja
  sigue diciendo «recibo de caja». No se añade texto de ayuda permanente bajo el botón (densidad).
- **Cuándo se pinta** (ni en gris si no aplica — calco de `ofreceCaja`):
  `puedeCargarComprobante && !soloLectura && (enGestion || estado === pagado) && documentos !== 'ambos'`.
  - `puedeCargarComprobante = hasFuncion('impuestos.recibos.cargar')`, prop nueva que monta la página
    igual que `puedeCargarCaja`.
  - Con `documentos === 'ambos'` no queda fase por cargar: todo daría `duplicado`. No se ofrece.
  - `pendiente` / `con_novedad`: no se pinta (el API respondería 409).
- **Hint del recibo de caja sin liquidación** (`#recibo-caja-motivo`): si el usuario **también** ve
  «Cargar comprobante», el texto pasa a: «Este impuesto no tiene liquidación cargada. Cárgala primero
  con «Cargar comprobante».» Sin la función, queda el texto actual. Es la misma visita y evita mandar
  al operador a la masiva.
- **Densidad:** sin cambio en la tabla ni en el `<dl>`; un control más en una celda que ya envuelve
  (`flex-wrap`).

### En el modal

```
┌ Cargar comprobante · ABC123 ───────────────────────────── ✕ ┐
│ Organismo Bogotá · Documentos: Solo liquidación               │
│                                                               │
│ Fase del comprobante *                                        │
│ ( ) Liquidación   El documento que fija el valor a pagar.     │
│                   Ya cargada                    (deshabilitada)│
│ ( ) Pago          El recibo con el sello PAGADO.               │
│                                                               │
│ ┌ Archivo * ──────────────────────────────────────────────┐  │
│ │   PDF, JPG o PNG · máximo 15 MB                          │  │
│ └──────────────────────────────────────────────────────────┘  │
│ recibo-bogota.pdf · 1,2 MB                                    │
│                                                               │
│ [Cargar]  [Cancelar]                                          │
│ Elige la fase y el archivo para cargar.   (solo si falta algo)│
└───────────────────────────────────────────────────────────────┘
```

- **Siempre visible:** placa (título), organismo y qué documentos tiene ya (texto del chip de
  documentos; con `documentos === null`: «Sin documentos cargados»). **Se calla:** valor liquidado,
  VIN, comprador — están en el detalle de abajo y no deciden la carga.
- **Fase:** `<fieldset>` + `<legend>` «Fase del comprobante *» con **dos radios nativos** (no
  `<select>`: son dos opciones y la diferencia hay que leerla). **Sin valor por defecto**: es
  obligatoria (AC5) y elegir por el operador es la defensa contra `fase_no_coincide`. Cada opción es
  un `<label>` que envuelve radio + nombre + una línea de ayuda.
  - La fase que **ya** tiene comprobante (`documentos` = `liquidacion` | `pago`) va `disabled` con la
    nota «Ya cargada». Si el servidor igual responde `duplicado` (dato viejo), se trata como abajo.
- **Archivo:** `FlitUploadBox` (`label="Archivo"`, `required`, hint «PDF, JPG o PNG · máximo 15 MB»);
  validación local con la misma función que el vecino (`esReciboCajaValido`, mismo tope y tipos —
  reutilizarla, no copiarla). Tras elegir: nombre · tamaño, como el vecino.
- **Una primaria:** `Cargar` (`flitBtnPrimary`), deshabilitada hasta tener fase **y** archivo, con
  `aria-describedby` a la línea «Elige la fase y el archivo para cargar.» (solo visible mientras
  falte algo). `Cancelar` secundaria.

## Estados (4) + copy

| Estado | Qué se ve | Salida |
|---|---|---|
| **Vacío** (inicial) | Formulario sin fase ni archivo; `Cargar` deshabilitada con la línea «Elige la fase y el archivo para cargar.» | Elegir fase + archivo |
| **Cargando** | `aria-busy`, radios y caja bloqueados, primaria «Leyendo el comprobante…» deshabilitada, `Cancelar` deshabilitada. **Escape y ✕ no cierran** (calco del vecino: la petición no se aborta y cerrar escondería el desenlace) | Llega resultado o error |
| **Error** (no 200) | `<p role="alert">` con `color: var(--flit-danger-text)` + **un** botón primario con la salida | Ver tabla de errores |
| **Resultado** (200) | `StatusChip` + 1–2 frases en un bloque `role="status"` + salida | Ver tabla de resultados |

### Resultados 200 — se guardó

Primaria única: **`Listo`** → cierra y refresca (ver «Refresco y foco»).

| `resultado` | Chip | Copy |
|---|---|---|
| `liquidado` | `success` «Liquidación cargada» | Con valor: «Valor liquidado {pesos}. El impuesto sigue Solicitado; falta el pago.» · Con `valorLiquidado === null`: «La liquidación quedó guardada, pero el valor no se leyó con claridad y no se registró. Revísalo en «Ver soporte».» |
| `pagado` | `success` «Pagado» (+ `warning` «Diferencia de valor» si `marcadoPorDiferencia`) | «Valor pagado {pesos}. El impuesto pasó a Pagado.» · Con diferencia, segunda línea: «El valor pagado difiere del liquidado por encima de la tolerancia. Queda marcado para revisión.» (texto del vecino) |
| `en_revision` | `warning` «En revisión» | «El pago quedó guardado, pero el sello PAGADO o el valor no se leyó con claridad. Pasó a la cola de revisión; el impuesto sigue Solicitado hasta que se apruebe.» |
| `complemento` | `success` «Comprobante agregado» | «Quedó guardado junto a los soportes. El impuesto sigue Pagado.» |

`complemento` no está en el AC2 pero sí en el contrato (impuesto `pagado` al que le faltaba una
fase): se cubre para no caer en un default mudo.

### Resultados 200 — no se guardó nada

Chip `warning` «No se guardó» + frase fija por `resultado` + `detalle` del servidor como segunda línea
en `--flit-text-secondary` (es copy de negocio y no trae la placa leída, D-2 de la #13208; si viene
vacío no se pinta). La pantalla decide por `resultado`, nunca por el texto de `detalle`. **No** se
muestra la placa leída del documento.

| `resultado` | Frase | Primaria | Secundaria |
|---|---|---|---|
| `duplicado` | «Este comprobante ya estaba registrado.» | `Elegir otro archivo` (vuelve al formulario, **conserva la fase**, limpia el archivo) | `Cerrar` |
| `fase_no_coincide` | «El documento no corresponde a la fase que elegiste. Revisa si es la liquidación o el pago.» | `Cambiar fase` (vuelve al formulario, **conserva el archivo**, limpia la fase y pone el foco en el primer radio habilitado) | `Cerrar` |
| `placa_no_coincide` | «El comprobante es de otro vehículo: la placa del documento no es la de este impuesto. Verifica que elegiste el archivo correcto.» | `Elegir otro archivo` (conserva la fase) | `Cerrar` |

Estos tres **no** refrescan nada al cerrar (no hubo escritura).

### Errores (4xx / 5xx / red)

| Clave (por `codigo` del cuerpo; si no, por status) | Copy | Botón |
|---|---|---|
| `archivo_invalido` (local o 400) | «El archivo debe ser PDF, JPG o PNG de máximo 15 MB. Elige otro archivo.» | `Elegir otro` (conserva la fase) |
| `fase_invalida` (400) | «Falta la fase del comprobante. Elígela y vuelve a cargar.» | `Elegir fase` (conserva el archivo) |
| `no_encontrado` (404) | «Este impuesto ya no está disponible para tu usuario. Cierra y actualiza la cola.» | `Cerrar` (+ refrescar) |
| `estado_no_permitido` (409) | «El impuesto ya no está en gestión ni pagado. Cierra y revisa su estado.» | `Cerrar` (+ refrescar) |
| `permiso` (403) | «Tu usuario no tiene la función para cargar comprobantes. Pídela al administrador.» | `Cerrar` |
| `limite` (429) | «Hiciste muchas cargas seguidas. Espera unos minutos y reintenta.» | `Reintentar` (conserva fase y archivo) |
| `servicio` (503) | «El lector de comprobantes no respondió. No se guardó nada; reintenta en unos minutos.» | `Reintentar` (conserva fase y archivo) |
| `red` (resto) | «No se pudo completar la carga. Revisa tu conexión y reintenta.» | `Reintentar` (conserva fase y archivo) |

Nunca `e.message`, códigos ni el cuerpo crudo. `Reintentar` vuelve al formulario con todo elegido (un
clic más en `Cargar`), igual que el vecino.

## Refresco y foco (AC4, AC5)

- `Listo` (solo tras resultado **con escritura**) → cierra el modal y llama a `onTraspaso()`: la cola
  se refresca **sin cerrar el detalle**, que se repinta desde la fila nueva (chip de estado, chip de
  documentos, valor liquidado/pagado, «Liquidado el»). «Ver soporte» abre `VisorSoportes`, que pide
  la lista al abrir: ya trae el comprobante nuevo. Sin recargar la página.
- Tras `pagado`, el botón «Cargar recibo de caja» se apaga **en el mismo commit** en que se cierra el
  modal (generalizar `pagadoDesdeCaja` a «pagado desde cualquiera de las dos cargas»), por la misma
  razón que hoy.
- **Foco:** al cerrar (Listo, Cerrar, Cancelar, ✕, Escape) vuelve a «Cargar comprobante». Si ese botón
  ya no existe tras el refresco (p. ej. quedó `documentos === 'ambos'`), vuelve a «Ver soporte»
  (`restoreFocusRef={verSoporteRef}`, mismo respaldo que el vecino).
- Al pasar a resultado o error, el foco va a la primaria de ese estado (el texto se anuncia por
  `role="status"` / `role="alert"`).

## Notificación

**Sin toast.** El desenlace se lee dentro del modal (es el resultado de *esa* acción, con su salida),
y lo que sigue siendo cierto después (estado, documentos, valores) se ve en el detalle refrescado.
Un toast al cerrar duplicaría lo que el operador acaba de leer.

## Responsive (<lg) + feedback + tema oscuro

- **Detalle <sm:** la celda **Soporte** pasa a `col-span-2` (`col-span-2 sm:col-span-1`) para que los
  tres controles no queden en media columna de ~160 px; envuelven con `flex-wrap` y ninguno lleva
  `min-w`. ≥sm no cambia.
- **Modal <lg:** `FlitModal` normal (no `wide`); radios apilados, una opción por línea (también en
  escritorio); `FlitUploadBox` a ancho completo; barra `Cargar` / `Cancelar` y la de resultado con
  `flex-wrap`. Nombre de archivo largo con `break-all` para no forzar scroll horizontal.
- **Feedback:** botones del kit (hover + `flit-focus` ya incluidos). Cada opción de fase (el `<label>`
  que envuelve el radio): `cursor-pointer`, `rounded-md`, hover con velo `var(--flit-bg-hover)` y
  `transition-colors`; el radio con foco visible (`flit-focus` o `outline` con
  `var(--flit-border-focus)`) y `accent-color: var(--flit-blue)`. Opción deshabilitada: sin hover,
  `cursor-default`, texto `var(--flit-text-muted)`.
- **Tema oscuro:** solo tokens con par oscuro: `--flit-text-secondary`, `--flit-text-muted`,
  `--flit-bg-hover`, `--flit-border-focus`, `--flit-blue-text`, `StatusChip`. Error con
  **`--flit-danger-text`** (no `text-red-600` ni `--flit-danger-ink`, que no tiene par oscuro —
  ver `flit-tokens.css:108-112`). **No** calcar el `text-red-600` de `ModalReciboCaja.tsx:169`.
- Sin animaciones, sombras ni iconos nuevos.

## Permiso/slug

- Sin página ni `PageSlug` nuevos; vive dentro de la página de Impuestos existente.
- Función existente `impuestos.recibos.cargar` (`hasFuncion`), sin migración. Sin la función el botón
  no se pinta; el de caja sigue con `impuestos.recibos.cargar_caja`, independiente.
- `soloLectura` (Auditoría) nunca lo ve.
- Gestor: el API aplica la frontera (404 fuera de ella); la UI no la recalcula.

## Notas para QA (≤10)

1. Con `impuestos.recibos.cargar` y estado Solicitado/Pagado (sin `ambos`) aparece «Cargar comprobante»; sin la función, en Pendiente/Con novedad, en solo lectura o con `ambos`, no está en el DOM. «Cargar recibo de caja» no cambia de condición.
2. `Cargar` deshabilitada hasta tener fase **y** archivo; ninguna fase preseleccionada; la fase ya cargada sale deshabilitada con «Ya cargada».
3. Los 7 resultados 200 (`liquidado` con y sin valor, `pagado` con y sin diferencia, `en_revision`, `complemento`, `duplicado`, `fase_no_coincide`, `placa_no_coincide`) muestran el copy de la tabla; ninguno pinta la placa leída.
4. Errores 400/403/404/409/429/503 y fallo de red: copy de la tabla, nunca el mensaje crudo; `Reintentar` conserva fase y archivo.
5. Durante la carga, Escape y ✕ no cierran.
6. `Listo` tras escritura: el detalle sigue abierto y muestra estado, chip de documentos y valores nuevos; «Ver soporte» lista el comprobante nuevo; tras `pagado` desaparece «Cargar recibo de caja». Los resultados sin escritura no refrescan.
7. El foco vuelve a «Cargar comprobante» (o a «Ver soporte» si el botón desapareció).
8. Teclado: Tab llega a los radios (flechas cambian de opción), a la caja de archivo y a los botones; foco visible en todos.
9. 360 px: detalle y modal sin scroll horizontal; los tres controles de Soporte envuelven.
10. Tema oscuro: error legible (`--flit-danger-text`), hover de opción visible, chips con contraste.

## Decisiones y descartes

- **Radios y no `<select>`** para la fase: dos opciones con una línea de ayuda cada una; el error que
  se quiere evitar (`fase_no_coincide`) es de lectura, no de espacio.
- **Sin fase por defecto**, ni deducida de `documentos`: el AC5 la pide obligatoria y adivinarla
  convierte un error del operador en un rechazo del OCR.
- **No se ofrece el botón con `ambos`**: pintarlo para que siempre conteste `duplicado` es ruido.
- **`detalle` del servidor como segunda línea**, no como copy principal: la UI decide por
  `resultado` y pone su propia frase; `detalle` aporta la causa concreta del duplicado sin eco del
  documento.
- **Descartado** un aviso fijo bajo el botón explicando la diferencia con el recibo de caja: añade
  densidad a una celda ya cargada; el rótulo y el título del modal bastan.
- **Descartado** fusionar los dos modales en uno con tres opciones (liquidación / pago / caja): el
  recibo de caja tiene otro permiso, otra precondición (exige liquidación) y otro endpoint; el AC1 los
  quiere separados.
- **Nota (preexistente, fuera de alcance):** `ModalReciboCaja` usa `text-red-600` y el detalle
  `bg-red-50` / `bg-blue-50` / `text-red-600` (`DetalleImpuesto.tsx:226-228`); fallan en oscuro. No
  se corrigen en esta HU. El error de `ModalReciboCaja` para `sin_liquidacion` sigue mandando a la
  masiva; con esta HU podría mandar a «Cargar comprobante» — pregunta para el PO, no se cuela aquí.
- **Ayuda in-app:** la HU cambia lo que se ve en un módulo con ficha (`content/ayuda/flito_impuestos.md`)
  → `flit-ayuda-flito` aplica antes del PR.
