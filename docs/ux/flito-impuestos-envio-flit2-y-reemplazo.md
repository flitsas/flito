# UX slim — Envío del comprobante a FLIT 2 y reemplazo del comprobante de pago (HU #13270)

Feature #13267 · Épica #12741 · módulo **`flito-impuestos`** (no el legacy `impuestos`).
Contrato ya implementado (HUs #13268 y #13269): `envioFlit2` en el `GET /api/flito/impuestos/:id`
(`ImpuestoDetalle`) y `POST /api/flito/impuestos/:id/recibos/reemplazar-pago`; tipos
`EnvioComprobanteFlit2`, `ReprogramacionEnvioFlit2`, `RespuestaReemplazoComprobante`,
`CodigoErrorReemplazoComprobante` de `packages/shared-types/src/flito-envio-flit2.ts`.
Sin endpoint nuevo ni requerimiento de datos nuevo.

## Superficie tocada

- `components/flito/DetalleImpuesto.tsx`
  - una celda nueva en el `<dl>`, **«Comprobante en FLIT 2»**, justo después de **Soporte**;
  - un botón secundario más en la celda **Soporte**: **«Reemplazar comprobante»**.
- `components/flito/ModalReemplazoComprobante.tsx` — **nuevo**, hermano de `ModalCargaReciboFase.tsx`
  (misma estructura: `FlitModal` apilado sobre el detalle, `FlitUploadBox`, fases
  inicial / cargando / resultado / error, error decidido por `codigo` del cuerpo y nunca por el texto).
  Reutiliza la validación local de archivo del vecino (`esReciboCajaValido`: mismos tipos y tope);
  no la copia.
- `ModalCargaReciboFase` y `ModalReciboCaja` **no se tocan**.

**Qué vino a hacer quien abre esto:** el analista de Operaciones consulta *este* impuesto y quiere
saber, sin preguntarle a nadie, **si el gestor ya tiene el comprobante en FLIT 2**; si el archivo
estaba mal, corregirlo ahí mismo. Lo que se ve primero en la celda nueva es el **estado del envío**
(un chip); la fecha y la ayuda van debajo, en letra secundaria.

Tono: **tú**, calcado del detalle y de sus modales («Cárgala primero», «Elige otro archivo»).

## Delta de claridad (qué se ve / qué se calla)

### En el detalle

```
┌ Impuesto · ABC123 ─────────────────────────────────────────────── ✕ ┐
│ [Pagado] [Pago]                                                      │
│ VIN …                    Trámite FLIT …                              │
│ …                                                                    │
│ VALOR PAGADO             FACTURA DE VENTA                            │
│                          En FLIT · Ver / descargar                   │
│ SOPORTE                  COMPROBANTE EN FLIT 2                       │
│ Ver soporte              [En espera de FLIT 2]                       │
│ [Reemplazar comprobante] Último intento: 05/10/2026 10:32            │
│                          El trámite aún no admite el comprobante en  │
│                          FLIT 2. FLITO lo enviará solo.              │
│ ENVIADO POR              ENVIADO                                     │
│ …  (validación, dirección, historial, acciones de gestión)           │
└──────────────────────────────────────────────────────────────────────┘
```

**Indicador «Comprobante en FLIT 2»**

- **Dónde:** celda propia del `<dl>`, **inmediatamente después de Soporte**. Es el mismo tema (la
  evidencia del pago) y, en la rejilla de 2 columnas, queda al lado de Soporte: el `<dl>` pasa de
  terminar en una fila impar a dos filas parejas. No va a los chips de cabecera (allí manda el
  estado del impuesto; un segundo chip de estado competiría con él) ni a la sección de validación
  (otra cosa: RUNT).
- **Contenido, en este orden:** `StatusChip` con el texto del estado → línea de fecha (si
  `ultimoIntentoEn` no es `null`) → **una** línea de ayuda solo en los estados que no se explican
  solos (`en_espera`, `error`, `sin_comprobante`). Fecha y ayuda en `text-xs`,
  `color: var(--flit-text-secondary)`. Fecha con el mismo formateador `fecha()` del detalle.
- **Solo lectura:** sin botón de reintentar en ningún estado (AC2), sin enlace, sin hover. No es
  interactivo y no se pinta como si lo fuera.
- **`envioFlit2 === null`** (trámite que no es de FLIT 2, o sin envío programado): **la celda no
  existe**; el `<dl>` queda como hoy. No hay «No aplica».
- **Se calla:** el número de intentos (solo aparece dentro del copy de `error`), el motivo técnico del
  error (el contrato no lo expone: va a auditoría, D-4) y cualquier id de FLIT 2.
- **Quién lo ve:** todo el que ve el detalle (incluida Auditoría en solo lectura y el gestor del
  organismo dentro de su frontera). Es lectura; no tiene función propia.

**Botón «Reemplazar comprobante»**

- **Dónde:** celda **Soporte**, después de «Ver soporte» y de «Cargar comprobante» si este también
  aparece. Orden fijo: `Ver soporte` (enlace) · `Cargar comprobante` · `Reemplazar comprobante`.
  (`Cargar recibo de caja` no coincide nunca con este: el de caja exige impuesto en gestión y el
  reemplazo exige Pagado.)
- **Peso:** `flitBtnSecondary` + `flitBtnSecondaryStyle`, igual que sus vecinos. El detalle **sigue
  sin primaria**; no se promueve.
- **Cuándo se pinta** (ni en gris si no aplica):
  `puedeReemplazarComprobante && !soloLectura && imp.estado === pagado && tienePagoVigente`.
  - `puedeReemplazarComprobante = hasFuncion('impuestos.recibos.reemplazar')`, prop nueva que monta
    la página igual que `puedeCargarComprobante`.
  - `tienePagoVigente`: el impuesto tiene comprobante de pago (`recibo_impuesto`) no descartado.
    Proxy en la UI: `imp.documentos` es `'pago'` o `'ambos'`. **Frontend: verificar** que
    `documentos` no cuenta el recibo de caja como «pago» (el reemplazo no toca el de caja). Si el
    proxy falla, el 409 `sin_comprobante_vigente` lo ataja con el copy de la tabla de abajo.
- **Densidad:** sin columnas nuevas; en la celda Soporte, a lo sumo tres controles que ya envuelven
  (`flex-wrap`).

### En el diálogo

```
┌ Reemplazar comprobante de pago · ABC123 ───────────────────── ✕ ┐
│ Organismo Bogotá                                                 │
│                                                                  │
│ ┌ (aviso, borde de advertencia) ──────────────────────────────┐ │
│ │ El comprobante de pago actual se descarta y queda el nuevo.  │ │
│ │ El valor pagado y la fecha de pago no cambian.               │ │
│ └──────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ ┌ Nuevo comprobante de pago * ──────────────────────────────┐   │
│ │   PDF, JPG o PNG · máximo 15 MB                            │   │
│ └────────────────────────────────────────────────────────────┘   │
│ recibo-bogota.pdf · 1,2 MB                                       │
│                                                                  │
│ [Reemplazar comprobante]  [Cancelar]                             │
│ Elige el archivo del nuevo comprobante.      (solo si falta)     │
└──────────────────────────────────────────────────────────────────┘
```

- **Siempre visible:** placa (título), organismo y el **aviso de descarte**. Es el texto de
  confirmación: va **antes** del archivo, para que se lea antes de elegirlo, y la primaria repite el
  verbo («Reemplazar comprobante», no «Enviar» ni «Cargar»). No hay segundo paso «¿Estás seguro?»
  (ver Decisiones).
- **Línea condicional del aviso** (solo si `envioFlit2?.estado === 'ya_cargado_gestor'`, que es
  final): «El gestor ya cargó su comprobante en FLIT 2: el nuevo queda solo en FLITO.» Así lo sabe
  *antes* de reemplazar. En los demás estados no se predice nada: el resultado lo dice.
- **Aviso:** bloque estático (no `role="alert"`: no es un error), borde
  `var(--flit-warning)` y texto `var(--flit-text-primary)`; sin icono nuevo.
- **Archivo:** `FlitUploadBox` con `label="Nuevo comprobante de pago"`, `required`, hint
  «PDF, JPG o PNG · máximo 15 MB». Tras elegir: nombre · tamaño, como el vecino.
- **Una primaria:** `Reemplazar comprobante` (`flitBtnPrimary`), deshabilitada hasta tener archivo,
  con `aria-describedby` a la línea «Elige el archivo del nuevo comprobante.» (visible solo mientras
  falte). `Cancelar` secundaria.
- **Se calla:** valores, VIN, comprador, el comprobante actual (está en «Ver soporte»).

## Estados (4) + copy

### Indicador (sección del envío)

Lee del detalle que el componente ya pide **una vez** (`useDetalleValidacion` → `GET /flito/impuestos/:id`).
No se añade otra petición.

| Estado | Qué se ve | Salida |
|---|---|---|
| **Cargando** | Celda con su rótulo y una barra de esqueleto del alto del chip (`aria-busy="true"` en el `<dd>`). Si al llegar `envioFlit2` es `null`, la celda desaparece. | — |
| **Error** | Bajo el rótulo: «No se pudo consultar el envío a FLIT 2.» (`--flit-text-secondary`) + botón-enlace **`Reintentar`** que llama al mismo `recargar` del detalle. | Reintentar |
| **Vacío** | `envioFlit2 === null` → **no hay celda** (AC2). Es el vacío correcto: el trámite no es de FLIT 2 y no hay nada que esperar. | — |
| **Lleno** | Chip + fecha + ayuda según la tabla siguiente. | Ver tabla |

| `estado` | Chip (tono) | Línea de fecha | Ayuda (una línea) |
|---|---|---|---|
| `pendiente` | «Pendiente» (`active`) | «Último intento: {fecha}» si hay | — |
| `en_espera` | «En espera de FLIT 2» (`neutral`) | «Último intento: {fecha}» si hay | «El trámite aún no admite el comprobante en FLIT 2. FLITO lo enviará solo.» |
| `enviado` | «Enviado a FLIT 2» (`success`) | «Enviado el {fecha}» | — |
| `ya_cargado_gestor` | «Ya lo cargó el gestor» (`success`) | «Último intento: {fecha}» si hay | — |
| `error` | «Error de envío» (`danger`) | «Último intento: {fecha}» | «FLITO no pudo enviarlo tras {intentos} intentos. El motivo quedó registrado; si el archivo estaba mal, reemplázalo.» (con `intentos` 0 o ausente: «FLITO no pudo enviarlo. El motivo quedó registrado; si el archivo estaba mal, reemplázalo.») |
| `sin_comprobante` | «Sin comprobante» (`warning`) | — | Con «Cargar comprobante» a la vista: «Se enviará cuando cargues el comprobante de pago con «Cargar comprobante».» · Sin él: «Se enviará cuando se cargue el comprobante de pago.» |

La pantalla decide por `estado`; un valor desconocido cae a chip `neutral` «Estado desconocido» sin
ayuda (no rompe el detalle).

`ya_cargado_gestor` es `success` a propósito: responde «sí, el gestor lo tiene», que es la pregunta
de la visita.

### Diálogo de reemplazo

| Estado | Qué se ve | Salida |
|---|---|---|
| **Vacío** (inicial) | Aviso + caja de archivo sin archivo; primaria deshabilitada con «Elige el archivo del nuevo comprobante.» | Elegir archivo |
| **Cargando** | `aria-busy`, caja bloqueada, primaria «Validando el comprobante…» deshabilitada, `Cancelar` deshabilitada. **Escape y ✕ no cierran** (calco del vecino: la petición no se aborta y cerrar escondería el desenlace). | Llega resultado o error |
| **Error** (no 200) | `<p role="alert">` con `color: var(--flit-danger-text)` + **un** botón primario con la salida. Debajo, siempre: «El comprobante anterior sigue vigente.» | Tabla de errores |
| **Lleno** (200) | `reemplazado` → se cierra el diálogo y sale el toast (ver Notificación). Rechazos 200 → resultado dentro del diálogo. | Tablas siguientes |

#### 200 `reemplazado` → toast de éxito según `envioFlit2`

| `envioFlit2` | Copy del toast |
|---|---|
| `{ reenviado: true }` | «Comprobante reemplazado. FLITO enviará el nuevo a FLIT 2.» |
| `{ reenviado: false, motivo: 'ya_cargado_gestor' }` | «Comprobante reemplazado en FLITO. No se envía a FLIT 2: el gestor ya cargó el suyo allá.» |
| `{ reenviado: false, motivo: 'no_flit2' }` | «Comprobante reemplazado. Este trámite no es de FLIT 2, así que no hay nada que enviar.» |
| `{ reenviado: false, motivo: 'sin_envio_previo' }` | «Comprobante reemplazado en FLITO. No se envía a FLIT 2 porque el impuesto se pagó antes del envío automático.» |
| ausente / forma desconocida | «Comprobante reemplazado.» |

El reemplazo **sí** se hizo en los cuatro casos: el copy nunca usa «error» ni tono de fallo.

#### 200 de rechazo — no se reemplazó nada

Chip `warning` «No se reemplazó» + frase fija por `resultado` + `detalle` del servidor como segunda
línea en `--flit-text-secondary` (si viene vacío no se pinta; nunca la placa leída) + línea fija
«El comprobante anterior sigue vigente.» La UI decide por `resultado`, no por `detalle`.

| `resultado` | Frase | Primaria | Secundaria |
|---|---|---|---|
| `duplicado` | «Este archivo ya estaba cargado en FLITO.» | `Elegir otro archivo` (vuelve al formulario, limpia el archivo) | `Cerrar` |
| `fase_no_coincide` | «El documento no es un comprobante de pago. Elige el recibo con el sello PAGADO.» | `Elegir otro archivo` | `Cerrar` |
| `placa_no_coincide` | «El comprobante es de otro vehículo: la placa del documento no es la de este impuesto. Verifica que elegiste el archivo correcto.» | `Elegir otro archivo` | `Cerrar` |

Estos no refrescan nada al cerrar (no hubo escritura).

#### Errores (4xx / 5xx / red)

| Clave (por `codigo`; si no, por status) | Copy | Botón |
|---|---|---|
| `archivo_invalido` (local o 400) | «El archivo debe ser PDF, JPG o PNG de máximo 15 MB. Elige otro archivo.» | `Elegir otro` |
| `sin_funcion` / 403 | «Tu usuario no tiene la función para reemplazar comprobantes. Pídela al administrador.» | `Cerrar` |
| `no_encontrado` (404) | «Este impuesto ya no está disponible para tu usuario. Cierra y actualiza la cola.» | `Cerrar` (+ refrescar) |
| `sin_comprobante_vigente` (409) | «Este impuesto no tiene un comprobante de pago que reemplazar. Cárgalo con «Cargar comprobante».» | `Cerrar` (+ refrescar; el foco va a «Cargar comprobante» si existe) |
| `estado_no_permitido` (409) | «Solo se reemplaza el comprobante de un impuesto Pagado, y este ya no lo está. Cierra y revisa su estado.» | `Cerrar` (+ refrescar) |
| `limite` (429) | «Hiciste muchos reemplazos seguidos. Espera unos minutos y reintenta.» | `Reintentar` (conserva el archivo) |
| `servicio` (503) | «El lector de comprobantes no respondió. No se reemplazó nada; reintenta en unos minutos.» | `Reintentar` (conserva el archivo) |
| `red` (resto) | «No se pudo completar el reemplazo. Revisa tu conexión y reintenta.» | `Reintentar` (conserva el archivo) |

Nunca `e.message`, códigos ni el cuerpo crudo. En todos: «El comprobante anterior sigue vigente.»
debajo del mensaje (AC5). `Reintentar` vuelve al formulario con el archivo elegido.

## Refresco y foco (AC4)

- `reemplazado` → cierra el diálogo, `toastOk(copy)`, y luego **dos** refrescos sin cerrar el detalle:
  `recargar()` del detalle (el indicador pasa al estado que devuelva el API; mientras llega, la
  celda muestra su esqueleto) y `onTraspaso()` (la fila y sus chips). «Ver soporte» pide la lista al
  abrir: ya muestra el comprobante nuevo.
- **Foco** al cerrar (éxito, Cerrar, Cancelar, ✕, Escape): vuelve a «Reemplazar comprobante»; si ese
  botón ya no existe tras el refresco, a «Ver soporte» (`restoreFocusRef={verSoporteRef}`, mismo
  respaldo que los vecinos).
- Al pasar a resultado o error dentro del diálogo, el foco va a la primaria de ese estado.

## Notificación

| Acción | Patrón | Por qué |
|---|---|---|
| Reemplazo exitoso | **Toast** `toastOk` de `components/flit/ToastFlito` (cerrable, `role="status"`). 4 s con `reenviado: true`; **8 s** (`duracionMs: 8_000`) en los tres `reenviado: false`, que llevan dos frases. | Es el resultado puntual de una acción; el diálogo ya se cerró (AC4: «aviso cerrable»). Lo que sigue siendo cierto queda **en página**: el indicador. |
| Rechazo 200 / error | **En el diálogo** (`role="status"` / `role="alert"`), no toast. | Error de un modal: va dentro, con su salida. |
| Estado del envío | **Aviso en página**: el indicador. | Es persistente; nunca un toast. |

Un solo toast por reemplazo; no se suma otro al terminar el refresco.

## Responsive (<lg) + feedback + tema oscuro

- **Detalle <sm:** la celda «Comprobante en FLIT 2» lleva `col-span-2 sm:col-span-1`, igual que
  Soporte: en 360 px cada una ocupa la fila entera y el chip + fecha + ayuda no se aprietan en media
  columna. Chip y fecha envuelven (`flex-wrap`); la ayuda es texto corrido. ≥sm: al lado de Soporte.
- **Celda Soporte:** sin cambio de comportamiento; con tres controles envuelve (`flex-wrap`, sin `min-w`).
- **Diálogo <lg:** `FlitModal` normal (no `wide`); aviso y `FlitUploadBox` a ancho completo; barra de
  botones con `flex-wrap`; nombre de archivo largo con `break-all`.
- **Feedback:** «Reemplazar comprobante» y los botones del diálogo son del kit (hover + `flit-focus`
  incluidos). El botón-enlace `Reintentar` del indicador en error: `underline`,
  `color: var(--flit-blue-text)`, hover `var(--flit-bg-hover)` con `rounded` y `transition-colors`,
  foco `flit-focus` — no plano. El chip del indicador **no** lleva hover ni cursor de puntero: no es
  interactivo.
- **Tema oscuro:** solo tokens con par oscuro (`--flit-text-secondary`, `--flit-text-primary`,
  `--flit-warning`, `--flit-blue-text`, `--flit-bg-hover`, `StatusChip`). Error con
  **`--flit-danger-text`**, no `text-red-600` ni `--flit-danger-ink`. Verificar que `--flit-warning`
  como **borde** del aviso tenga contraste ≥ 3:1 en los dos temas; si no, usar el token de borde de
  advertencia que ya exista — no un HEX.
- Sin animaciones, sombras, iconos ni componentes nuevos de kit.

## Accesibilidad

- Indicador: `<dt>` «Comprobante en FLIT 2» + `<dd>`; el chip lleva texto (no solo color). El `<dd>`
  con `aria-busy` al cargar. **Sin `aria-live`** en el indicador: el toast ya anuncia el resultado y
  un live más lo duplicaría.
- Diálogo: `FlitModal` (focus trap, título como nombre accesible). `FlitUploadBox` con `<label>`
  asociado al input «Nuevo comprobante de pago»; el aviso de descarte enlazado al input con
  `aria-describedby` para que se lea al llegar al campo.
- Primaria deshabilitada con `aria-describedby` al motivo. Errores con `role="alert"`, resultados con
  `role="status"`.
- Contraste ≥ 4.5:1 en texto y ≥ 3:1 en foco y bordes, en claro y oscuro.

## Permiso/slug

- Sin página ni `PageSlug` nuevos; todo vive en la página de Impuestos existente.
- Función **`impuestos.recibos.reemplazar`** (migración 0220, ya sembrada). **Ningún rol la trae de
  partida, ni admin**: hay que concederla en el panel de permisos para verla. Sin ella el botón no
  está en el DOM.
- `soloLectura` (Auditoría) ve el indicador y nunca el botón.
- Frontera del gestor: la aplica el API (404); la UI no la recalcula.

## Notas para QA (≤10)

1. Trámite que no es de FLIT 2 (`envioFlit2: null`): no hay celda «Comprobante en FLIT 2» y el `<dl>` queda como antes.
2. Los seis estados muestran el chip, la fecha y la ayuda de la tabla; `enviado` dice «Enviado el …»; sin `ultimoIntentoEn` no hay línea de fecha. En ningún estado hay botón de reintentar envío.
3. Detalle con fallo de red: el indicador dice «No se pudo consultar el envío a FLIT 2.» y `Reintentar` lo recupera.
4. «Reemplazar comprobante» solo con la función **y** Pagado **y** comprobante de pago; sin cualquiera de los tres, o en Auditoría, no está en el DOM. Recordar conceder la función (ningún rol la trae).
5. El diálogo muestra el aviso de descarte antes del archivo; con `ya_cargado_gestor` añade la línea del gestor. La primaria está deshabilitada sin archivo.
6. Reemplazo exitoso: el diálogo se cierra, sale un toast cerrable con el copy de su `envioFlit2` (cuatro variantes), el detalle sigue abierto y el indicador cambia al estado que devuelve el API; «Ver soporte» lista el comprobante nuevo.
7. Rechazos 200 (`duplicado`, `fase_no_coincide`, `placa_no_coincide`) y errores 400/403/404/409×2/429/503/red: copy de las tablas + «El comprobante anterior sigue vigente.»; nunca el mensaje crudo; `Reintentar` conserva el archivo.
8. Durante el envío, Escape y ✕ no cierran; al cerrar, el foco vuelve a «Reemplazar comprobante» (o a «Ver soporte»).
9. 360 px: indicador y Soporte a ancho completo, sin scroll horizontal; diálogo usable.
10. Tema oscuro: chips, aviso, error (`--flit-danger-text`) y foco legibles.

## Decisiones y descartes

- **Indicador como celda del `<dl>`, no como chip de cabecera:** la cabecera responde «en qué estado
  está el impuesto»; un segundo chip de estado competiría. Al lado de Soporte se lee como lo que es:
  qué pasó con esa evidencia.
- **Ayuda solo en tres estados:** «Pendiente», «Enviado a FLIT 2» y «Ya lo cargó el gestor» se
  explican solos; una línea bajo cada uno sería ruido.
- **Sin paso de confirmación aparte:** el aviso de descarte está antes del archivo y la primaria dice
  el verbo completo; un «¿Estás seguro?» tras elegir archivo es un clic más que no añade
  información. El reemplazo además es reversible por otro reemplazo.
- **Botón `Reintentar` en el error del indicador** aunque la sección de validación tenga el suyo
  sobre la misma petición: AC6 pide reintento en *esta* sección y quien mira el envío no tiene por
  qué buscarlo en otra. Los dos llaman al mismo `recargar`; es enlace, no primaria.
- **Toast y no aviso tras el reemplazo:** el diálogo se cierra y el estado persistente ya lo dice el
  indicador; un aviso fijo duplicaría el indicador.
- **Descartado** mostrar el número de intentos fuera de `error`, y cualquier motivo técnico: el
  contrato no lo expone (D-4) y no es de esta visita.
- **Descartado** fusionar reemplazo con «Cargar comprobante»: otro permiso, otra precondición
  (Pagado con pago vigente) y otra consecuencia (descarta el anterior).
- **Pregunta para el PO (no bloquea):** con `sin_envio_previo` el toast solo informa que no se envía
  a FLIT 2. ¿Hay un siguiente paso que el analista deba dar (p. ej. avisar al gestor) para incluirlo
  en el copy? Sin respuesta, queda solo informativo.
- **Ayuda in-app:** `content/ayuda/flito_impuestos.md` dice hoy que la carga «no reemplaza un
  documento ya cargado»; con esta HU existe el reemplazo y el indicador → `flit-ayuda-flito` aplica
  antes del PR.
