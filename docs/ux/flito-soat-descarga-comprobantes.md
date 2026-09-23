# UX slim — SOAT FLITO: descarga de comprobantes masiva e individual (HU #12815 · HU #12816)

Feature #12814 · Épica #12810 · Pantalla `apps/web/src/pages/FlitoSoat.tsx` (cola + modal `DetalleSoat`)
Módulo: **FLITO** (`/api/flito/soat`), no el legacy `soat`.
Análoga: Trámites FLITO con `DescargarSoportesZip` tal como quedó en la HU #12817 (altura única, `hoverSecundario`, tarjeta «Preparando…», aviso persistente).

---

## Superficie tocada

| Zona | HU | Qué cambia |
|---|---|---|
| Columna de casillas + barra de selección | #12815 | La columna y el botón ZIP pasan a colgar del permiso `soat.soportes.descargar` (hoy cuelgan de `esOperaciones \|\| esGestor`). El botón se habilita desde 2 marcadas, cuenta solo pagadas y gana el peso primario cuando es la única acción de la barra. |
| Última celda de cada fila (la de «Ver») | #12816 | Botón de icono «Descargar comprobante» junto a «Ver». **Sin columna nueva.** |
| Modal de detalle | #12816 | Botón «Descargar comprobante» en la fila de acciones, al final. «Ver soporte» se queda donde está. |

Qué vino a hacer quien abre la pantalla:
- **Cliente (Davivienda):** ver en qué va su SOAT y, si está pagado, **llevarse el comprobante**. Hoy no puede descargarlo: solo verlo en el visor, si acaso.
- **Operador / gestor:** trabajar la cola (enviar, cargar facturas) y, a veces, reunir comprobantes de varios SOAT para conciliar o reenviarlos.

Qué se ve primero no cambia: placa/VIN, estado y la acción del día. La descarga se ve en la fila del SOAT pagado sin robarle el sitio a nada.

---

## Delta de claridad (qué se ve / qué se calla)

1. **Densidad de la tabla: sin cambio en columnas.** El icono entra en la celda de «Ver», que ya existe. La tabla de Operaciones ya está al límite de 1366 (comentarios de las HU #11905/#12097), y una columna «Comprobante» la devolvería al desborde.
2. **Siempre visible en la fila:** que el comprobante se puede descargar (icono azul) o que todavía no (icono gris). El motivo del gris se lee al pasar el puntero o con el foco, no ocupa la fila.
3. **Barra de selección:** deja de mentir con la cifra. Hoy «Descargar soportes (8)» manda 8 ids y el aviso posterior dice «3 de las 8 tenían comprobante». En SOAT la pantalla **sí sabe** qué filas tienen comprobante: RN-03 dice que solo se llega a Pagado con factura. Así que el desajuste se dice **antes** del clic, como ya lo hace «Enviar al gestor (3 de 8)».
4. **Detalle:** la descarga va con las acciones y no dentro del `<dl>`. Es una acción, no un dato. «Ver soporte» se queda como dato, porque consulta sin llevarse nada.
5. **Canal Cliente:** no gana ninguna columna ni jerga. Gana la casilla, el icono y el botón **solo si su rol tiene el permiso**. Todo el copy nuevo es neutro o de usted (ver Voz).

### Decisión: ¿casillas de filas no pagadas deshabilitadas, o marcables con aviso?

**Marcables, con aviso de cuántas no tienen comprobante.** Por qué:
- La casilla **también sirve para «Enviar al gestor»**, que solo actúa sobre las Pendiente, y una Pendiente nunca está pagada. Si se deshabilitara la casilla de las no pagadas, Operaciones perdería el envío masivo.
- Deshabilitarla solo para quien no envía (Cliente, gestor) daría dos comportamientos de la misma columna según el rol, y habría que explicar por qué una casilla gris no se marca.
- El patrón ya existe en la barra y se lee bien: `Enviar al gestor (3 de 8)` más una línea que explica el desajuste. La descarga lo calca.
- **Lo que viaja en el POST son solo los ids pagados.** Así el servidor no trabaja de balde, el aviso de éxito no repite un «parcial» que ya se dijo y nunca se pinta «(8)» sobre una petición de 3, que es la regla escrita en `BarraEnvioSoat`.

---

## Wireframes

### Listado — 1366 px (operador con pendientes y pagados marcados)

```
┌ SOAT ─────────────────────────────────────────────────────────────────────────────────┐
│ Cola de adquisición del SOAT. …           [Cargar facturas (masivo)] [Exportar Excel] │
└───────────────────────────────────────────────────────────────────────────────────────┘
┌ Filtros (sin cambio) ─────────────────────────────────────────────────────────────────┐
└───────────────────────────────────────────────────────────────────────────────────────┘
┌ Barra de selección ───────────────────────────────────────────────────────────────────┐
│ 8 seleccionados   Enviar a [Elige destino… ▾] [■ Enviar al gestor (2 de 8)]            │
│                   [ ⬇ Descargar soportes (3 de 8) ]   ← secundario: Enviar es la primaria │
│ De las 8 filas marcadas, 2 están Pendientes y son las únicas que se envían.            │
│ 3 están pagadas: el ZIP trae sus 3 comprobantes.                                       │
└───────────────────────────────────────────────────────────────────────────────────────┘
(tarjeta «Preparando el ZIP de 3 registros…» / aviso de resultado: sin cambio, aquí)
┌ Tabla ────────────────────────────────────────────────────────────────────────────────┐
│ [☐] Vehículo     Fechas  Compañía  Gestiona  Estado      Solicitado Pagado  Valor      │
│ [☑] ABC123 …     …       Davivienda Prov X   ● Pagado    12/09      14/09   $…  [⬇][Ver]│  ⬇ azul
│ [☑] DEF456 …     …       Davivienda Prov X   ● Solicit.  12/09      —       —   [⬇][Ver]│  ⬇ gris
│ [☐] GHI789 …     …       …                   ● Pendiente —          —       —   [⬇][Ver]│  ⬇ gris
└───────────────────────────────────────────────────────────────────────────────────────┘
```

### Listado — 1366 px (Cliente o gestor: la barra no ofrece «Enviar»)

```
┌ Barra de selección ───────────────────────────────────────────────────────────────────┐
│ 4 seleccionados   [■ ⬇ Descargar soportes (3 de 4)]   ← primaria: es la única acción  │
│ Solo los SOAT pagados tienen comprobante: el ZIP trae 3 de las 4 filas marcadas.       │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

Con 1 marcada:
```
│ 1 seleccionado    [ ⬇ Descargar soportes (1) ]  (deshabilitado)                        │
│ Marque al menos 2 filas. Para un solo SOAT, use el botón ⬇ de su fila.                 │
```
Con ≥2 marcadas y ninguna pagada:
```
│ 3 seleccionados   [ ⬇ Descargar soportes (0 de 3) ]  (deshabilitado)                   │
│ Ninguna de las filas marcadas está pagada. Solo los SOAT pagados tienen comprobante.   │
```

### Listado — 375 px

```
┌ SOAT ───────────────────────┐
│ Sus solicitudes de SOAT …   │
│ [Solicitar SOAT]            │  ← las acciones de la cabecera bajan bajo el título (sin cambio)
└─────────────────────────────┘
┌ Barra ──────────────────────┐
│ 4 seleccionados             │
│ [■ ⬇ Descargar soportes     │
│      (3 de 4)             ] │  ← envuelve; el botón ocupa todo el ancho (w-full sm:w-auto)
│ Solo los SOAT pagados …     │
└─────────────────────────────┘
┌ Tabla (scroll horizontal ⇆) ┐
│ [☑] ABC123 · VIN… | Fechas …│  ← casilla y vehículo a la vista; [⬇][Ver] al final del scroll
└─────────────────────────────┘
```

### Detalle (modal) — SOAT pagado

```
┌ SOAT · ABC123 ─────────────────────────────────────────── ✕ ┐
│ ● Pagado                                                    │
│ VIN …            Vehículo …                                 │
│ Compañía …       Organismo …                                │
│ Enviado …        Soporte: Ver soporte                       │  ← sin cambio (visor)
│ (historial, compradores: sin cambio)                        │
│                                                             │
│ [Reversar] [Cambiar proveedor] … [⬇ Descargar comprobante]  │  ← al final, secundario
└─────────────────────────────────────────────────────────────┘
```
SOAT no pagado (p. ej. Solicitado, gestor):
```
│ [■ Cargar factura] [Rechazar]  [⬇ Descargar comprobante] (gris)│
│                                Disponible cuando el SOAT esté pagado. │  ← línea visible bajo el botón
```
Cliente con un SOAT pagado: la fila de acciones solo tiene `[⬇ Descargar comprobante]`.

A 375 px el modal ya ocupa el ancho, la fila de acciones envuelve (`flex-wrap`) y «Descargar comprobante» cae a su propia línea sin forzar ancho.

---

## Dónde va cada acción y por qué (una primaria por zona)

| Zona | Primaria | Secundarias | Por qué |
|---|---|---|---|
| Cabecera | Sin cambio: «Cargar facturas (masivo)» (operador) / «Solicitar SOAT» (Cliente) | Exportar | La descarga actúa sobre la **selección**, no sobre el filtro. No sube a la cabecera. |
| Barra de selección | «Enviar al gestor» **si se ofrece** (operador con Pendientes marcadas). **Si no, «Descargar soportes»**, y así se cumple el «botón primario» de la Épica. | La otra | Las dos no coinciden en la práctica: una Pendiente nunca está pagada. La regla es mecánica: `descargaPrimaria = !seOfreceEnviar`. |
| Fila | «Ver» (texto) sigue siendo la entrada al caso | Icono ⬇ | El icono es un atajo. No compite: no lleva texto y es del mismo alto. |
| Detalle | La acción operativa del estado («Cargar factura» en Solicitado); en Pagado no hay primaria | «Descargar comprobante» al final | Descargar es consultar, no operar. Por eso va detrás de las operativas y nunca pesa como primaria dentro del modal. |

**Traducción de la Épica a tokens (sin HEX):**
- «Azul activo»: el icono y el texto usan la tinta `--flit-blue-text`, borde y fondo de `flitBtnSecondary`. En la barra, cuando es primaria, `flitBtnPrimary` + `flitBtnPrimaryStyle`.
- «Gris no disponible»: icono en `--flit-text-muted`, borde `--flit-border-soft`, sin velo de hover, `cursor-not-allowed`. Los dos tokens tienen par oscuro.

---

## Estados (4) + copy

### Columna de casillas y tabla (#12815)
| Estado | Comportamiento |
|---|---|
| Cargando | `PageContentSkeleton`, sin cambio |
| Error | Tarjeta con «Reintentar», sin cambio |
| Vacío | `FlitEmpty` con los textos de hoy, sin cambio. Sin tabla no hay casillas. |
| Lleno | Casilla en cada fila, marcable **en cualquier estado**. La casilla de la cabecera selecciona la página, sin cambio. |

### Barra de selección (#12815)
| Estado | Copy / comportamiento |
|---|---|
| 0 marcadas | La barra no se pinta (sin cambio) |
| 1 marcada | Botón deshabilitado. La línea visible, atada por `aria-describedby`, dice: «Marque al menos 2 filas. Para un solo SOAT, use el botón de descarga de su fila.» |
| ≥2, ninguna pagada | Botón deshabilitado, `(0 de N)`. «Ninguna de las filas marcadas está pagada. Solo los SOAT pagados tienen comprobante.» |
| ≥2, k pagadas < N | Habilitado, `Descargar soportes (k de N)`. «Solo los SOAT pagados tienen comprobante: el ZIP trae k de las N filas marcadas.» Si también se ofrece Enviar, las dos frases van en el mismo párrafo de desajuste que ya existe. |
| ≥2, todas pagadas | Habilitado, `Descargar soportes (N)`. Sin línea de desajuste. |
| Ocupado | Rótulo «Preparando el archivo…», `aria-busy`. La tarjeta «Preparando el ZIP de k registros…» es la de #12817, sin cambio. Candado por `ref`, sin cambio. |
| Éxito / error / tope | `AvisoSoportesZip`, **aviso persistente en página**, sin cambio. Es el patrón de la análoga, y el ZIP parcial o los omitidos se tienen que poder leer después de abrir el archivo. |

La línea fija `lineaAyuda` de `ZIP_SOAT` («Se descargan los comprobantes de pago cargados en las filas marcadas.») **se retira en SOAT**, porque la línea de desajuste la sustituye con cifras. Si no hay desajuste, no hace falta explicar nada.

### Botón por fila (#12816)
| Estado | Comportamiento |
|---|---|
| Pagado | Activo, tinta azul. `aria-label="Descargar comprobante ABC123"` (placa; si no hay, el VIN). `title` con el mismo texto. |
| No pagado | **`aria-disabled="true"`, no `disabled`**, para que siga siendo enfocable y el motivo se pueda leer. El clic no hace nada. `aria-label="Descargar comprobante ABC123"` + `aria-describedby` hacia un texto `sr-only` («Disponible cuando el SOAT esté pagado.»). `title` con ese mismo texto para el puntero. |
| Ocupado | `aria-busy="true"`, icono al 60 % de opacidad, `cursor-progress`. Candado por `ref` **por id**, como en `useDescargaZip`: el doble clic produce una sola descarga. Las demás filas siguen operables. |
| Error | Toast cerrable (ver Notificaciones). El botón vuelve a activo. |
| Éxito | Sin toast: la descarga del navegador **es** el resultado, y un «Descargado» encima sería ruido. El archivo se llama `ABC123.pdf` (nombre que da el servidor; respaldo en el cliente: `<placa ?? vin>.pdf`). |

### Botón del detalle (#12816)
Los mismos cuatro estados que la fila, con rótulo de texto «Descargar comprobante» (con icono delante). En no pagado, además del `aria-describedby`, la explicación **se ve** en una línea bajo el botón («Disponible cuando el SOAT esté pagado.», `--flit-text-secondary`, `text-xs`): en el modal hay sitio y el Cliente no tiene por qué descubrir un tooltip. Error: el mismo toast que la fila. **No** va a la línea `error` del modal, que es de las acciones de estado.

---

## Notificaciones

| Acción | Patrón | Copy |
|---|---|---|
| ZIP (masiva): éxito, parcial, omitidos, error, tope | **Aviso en página** (`AvisoSoportesZip`), sin cambio | Los textos existentes |
| Individual: error de red / 5xx / tiempo | **Toast cerrable** (✕ con `aria-label="Cerrar aviso"`) con botón «Reintentar», duración ≥ 8 s | «No se pudo descargar el comprobante de ABC123. Intente de nuevo.» |
| Individual: 404 / sin archivo | Toast cerrable **sin** Reintentar | «El comprobante de ABC123 no está disponible. Si el SOAT figura como pagado, avise a FLITO.» |
| Individual: 403 | Toast cerrable sin Reintentar | «Su usuario no tiene permiso para descargar comprobantes.» |
| Individual: 429 | Toast cerrable con Reintentar | «Se hicieron demasiadas descargas seguidas. Espere un momento e intente de nuevo.» |

Nunca `e.message` ni el cuerpo del API. Un toast por clic: si se reintenta desde el toast, se cierra el anterior (`toast.dismiss(id)`) antes de lanzar. El proyecto usa `react-hot-toast`, pero **no hay helper de toast cerrable**. Se compone con `toast.error((t) => …)` + botón ✕ que llama `toast.dismiss(t.id)`, sin componente nuevo del kit, y con tokens de color (verificar el `Toaster` en tema oscuro).

---

## Feedback de interacción

- Casillas (fila y cabecera): `flit-focus` al teclado y `cursor-pointer`. El hover va en la celda (`hover:bg-[var(--flit-bg-hover)]` en el `<td>` de la casilla) para que el área de clic se note. Hoy es un `<input>` pelado.
- Icono por fila activo: mismo alto que «Ver» (`flitBtnSecondary`, cuadrado), `hoverSecundario` de `DescargarSoportesZip.tsx` (reutilizarlo, no redeclararlo), `flit-focus`.
- Icono gris: sin hover (el velo sugeriría que se puede pulsar), pero **con** foco visible, porque es enfocable.
- «Ver»: se le añade `hoverSecundario`, que hoy no tiene. Es el vecino inmediato del icono, y si uno reacciona y el otro no, «Ver» parece muerto.
- Botón de la barra: `hoverSecundario` si es secundario, `hoverPrimario` (opacidad 90) si es primario. **Una sola altura** en la barra: `h-10` para el select «Enviar a», «Enviar al gestor» y «Descargar soportes», igual que la análoga #12817.
- Detalle: «Descargar comprobante» con `hoverSecundario`. Mientras se toca el modal, las demás acciones secundarias del detalle ganan el mismo `hoverSecundario` (solo clase, ningún cambio de comportamiento).

## Responsive (<lg)

- Barra: `flex-wrap` (ya lo tiene). A <`sm` el botón de descarga pasa a `w-full sm:w-auto` y la línea de desajuste cae debajo.
- Tabla: scroll horizontal de `FlitTable`, sin cambio. Casilla y vehículo quedan a la vista y el par `[⬇][Ver]` queda al final del scroll. No se fija la última columna: sería un patrón nuevo.
- Celda de acciones: `flex items-center gap-2 whitespace-nowrap`, para que icono y «Ver» no se partan en dos líneas.
- Detalle: la fila de acciones envuelve. El `<dl>` de `grid-cols-2` pasa a `grid-cols-1 sm:grid-cols-2` (a 375 los valores largos del VIN y la compañía se cortan hoy).

## Tema oscuro

- Todo lo nuevo sale de tokens con par oscuro: `--flit-blue-text`, `--flit-text-muted`, `--flit-border-soft`, `--flit-bg-hover`, `--flit-text-secondary`, `--flit-danger-ink`.
- El toast va con fondo y tinta de tokens (`--flit-bg-card`/`--flit-text-primary`), no con el blanco por defecto de `react-hot-toast`.
- **Mejora incluida en #12816, porque se toca el modal:** el detalle tiene tres superficies que en oscuro no cumplen: `bg-red-50 text-red-700` (motivo de rechazo), `bg-blue-50 text-blue-800` (solo lectura) y `text-red-600` (error). Van a `--flit-danger-ink` sobre `--flit-bg-app` y a `--flit-blue-text` sobre `--flit-bg-app`. Solo cambian las clases, no el comportamiento.
- Verificación visual en los dos temas: fila con icono activo y gris, barra con primaria, y detalle pagado y no pagado.

## Permiso / slug

- Página: `pagina.flito-soat` (sin cambio). Función: **`soat.soportes.descargar`** (ya existe; la exige `POST /flito/soat/soportes/zip`).
- En web: `const puedeDescargar = hasFuncion('soat.soportes.descargar')` **sustituye** a `puedeDescargarSoportes = esOperaciones || esGestor`. Sin la función, ni el botón de la barra, ni el icono por fila, ni el botón del detalle están en el DOM (no deshabilitados: **ausentes**).
- **Columna de casillas:** se pinta si `puedeDescargar || esOperaciones`, porque también sirve para «Enviar al gestor». Sin ninguna de las dos, no hay columna. ⚠ **Por confirmar con el PO:** el AC dice «sin el permiso, ni columna ni botón». Un rol configurado con `soat.solicitud.enviar` y **sin** `soat.soportes.descargar` conservaría la columna para enviar. El admin por defecto tiene las dos, así que el caso solo existe con roles configurables.
- Datos:
  - Masiva: `POST /api/flito/soat/soportes/zip` `{ ids }` (existente). Los ids van en el cuerpo y solo los pagados.
  - Individual: **requiere un endpoint por uuid en path** que devuelva el PDF con `Content-Disposition: <placa>.pdf`, protegido por la misma función (p. ej. `GET /api/flito/soat/:id/comprobante`). No lo verifiqué en `flito-soat.routes.ts`. Si la parte backend de #12816 no lo trae, es requerimiento para `architecture-agent`/`backend-agent`. La placa va en el **nombre del archivo**, nunca en la URL (§14).
  - El estado de pago sale del `estado` que ya trae la cola (`EstadoSoat.PAGADO`). No hace falta ningún campo nuevo.

## Voz

La pantalla la comparten el Cliente (usted) y el operador (la cola tutea). El copy **nuevo** es neutro o de usted, porque lo lee el Cliente. **Nota para el PO (no bloquea):** `AvisoSoportesZip` y `avisoDeZip` (compartidos con Trámites) tutean («Puedes seguir en la cola», «Marca menos filas»). Si el Cliente recibe el permiso, los leerá así. Propuesta neutra, de bajo riesgo, en el mismo componente: «La cola sigue disponible mientras tanto.» / «Hay que marcar menos filas para volver a intentarlo.»

## Qué NO cambiar

- Columnas, filtros, cabecera y sus primarias, paginación, vacíos y error de la cola.
- «Ver soporte» y el `VisorSoportes`: siguen siendo la vía de *ver*. La descarga no se mete en el visor.
- `useDescargaZip`: candado, tope de cantidad y texto de avisos. `DialogoTipos` (SOAT tiene un tipo y no abre diálogo).
- El nombre del ZIP sin placa (`soportes-….zip`).
- El envío al gestor y su `(k de N)`.

---

## Lista de cambios para `frontend-agent`

### HU #12815 — barra y casillas
1. `puedeDescargar = hasFuncion('soat.soportes.descargar')` sustituye a `puedeDescargarSoportes`. La columna de casillas se pinta con `puedeDescargar || esOperaciones`, y la barra con `seleccion.size > 0 && (puedeDescargar || esOperaciones)`.
2. Derivar `descargables = filas marcadas con estado === PAGADO` (mismo patrón `useMemo` que `enviables`).
3. `DescargarSoportesZip` recibe `ids={descargables}` y dos props opcionales nuevas (Trámites e Impuestos no cambian): `marcadas: number` para el rótulo `(k de N)` y `minMarcadas = 2`. Se deshabilita si `marcadas < 2 || ids.length === 0`, con el motivo en una línea atada por `aria-describedby`.
4. Prop `primaria: boolean`. En SOAT vale `!seOfreceEnviar` y, cuando es `true`, el botón usa `flitBtnPrimary` + `hoverPrimario`.
5. `BarraEnvioSoat`: el párrafo de desajuste suma la frase de pagadas. Se retira de SOAT la `lineaAyuda` fija.
6. Altura única `h-10` en los controles de la barra. En la casilla, `flit-focus` y hover de celda.
7. A <`sm`, el botón de descarga lleva `w-full sm:w-auto`.

### HU #12816 — fila y detalle
8. Botón de icono en la última celda, antes de «Ver», con los estados de arriba (`aria-disabled` en no pagados, `aria-busy` al descargar, candado `ref` por id). Icono de descarga del set ya usado en `apps/web` (sin dependencia nueva; si no hay set, SVG inline de 16 px con `currentColor`).
9. Un hook `useDescargaComprobante()` (en `components/flito/`, junto a `DescargarSoportesZip`) con `descargar(id, placa)`, `ocupados: Set<string>` y toast cerrable con Reintentar. Lo usan la fila y el detalle.
10. En el detalle, «Descargar comprobante» al final de la fila de acciones. La fila se pinta cuando `accion === 'idle' && (puedeDescargar || hay acciones operativas)`, así que el Cliente y el auditor con permiso también la ven. En no pagado lleva la línea visible «Disponible cuando el SOAT esté pagado.».
11. `hoverSecundario` en «Ver» y en las secundarias del detalle.
12. Tokens de tema oscuro en motivo de rechazo, solo lectura y error del detalle. `<dl>` a `grid-cols-1 sm:grid-cols-2`.
13. ⚠ `FlitoSoat.tsx` ya tiene 1081 líneas físicas: vigilar `max-lines` (800 sin blancos ni comentarios, con `npx eslint`). Lo nuevo va en `components/flito/` y no en la página.

## Notas para QA (≤10)
1. Sin `soat.soportes.descargar`: ni botón ZIP, ni icono, ni botón del detalle en el DOM (`toHaveCount(0)`). El admin con enviar conserva la casilla.
2. 1 marcada: botón deshabilitado con su motivo. 2 marcadas y pagadas: habilitado con `(2)`.
3. 3 pagadas + 2 no pagadas: rótulo `(3 de 5)` y el cuerpo del POST lleva **solo** los 3 ids.
4. Marcadas sin ninguna pagada: deshabilitado con `(0 de N)` y ninguna petición.
5. Operador con Pendientes marcadas: «Enviar al gestor» es la primaria y «Descargar soportes» la secundaria. Cliente: «Descargar soportes» es la primaria.
6. Fila no pagada: el icono se enfoca con Tab, anuncia «Descargar comprobante ABC123» y el motivo, y el clic no lanza petición.
7. Doble clic en el icono de una fila pagada: **una** petición. El archivo se llama `ABC123.pdf`.
8. Error simulado (500) en la individual: toast con el copy pulido, ✕ que cierra, Reintentar que relanza; nada de `e.message`.
9. La URL de la descarga individual lleva uuid y ni placa ni VIN.
10. Los dos temas: icono activo y gris, barra y detalle legibles (contraste ≥ 4.5:1 en texto y ≥ 3:1 en el icono).

## Decisiones y descartes
- **Columna «Comprobante» (descartada):** vuelve a desbordar 1366. El icono entra en la celda de «Ver».
- **Casilla deshabilitada en no pagados (descartada):** rompe el envío masivo de Operaciones y crea dos columnas distintas según el rol.
- **Descarga en la cabecera (descartada):** actúa sobre la selección, no sobre el filtro. Además la cabecera ya tiene su primaria.
- **Descarga dentro del visor (descartada por AC):** ver y llevarse son dos gestos, y el visor ya carga lo suyo.
- **Toast de éxito individual (descartado):** el navegador ya muestra la descarga.
- **Barra y fila fija de acciones en móvil (descartadas):** serían patrones nuevos. Basta el scroll del kit.
- **«Limpiar selección» en la barra (descartado):** es funcionalidad fuera de las HUs.
- Sin animaciones, sin spinner giratorio, sin sombras nuevas: el estado ocupado se dice con rótulo, opacidad y `aria-busy`.
