# UX slim — SOAT FLITO: consultar el RUNT como compuerta y propietario completo (HU #11967)

> **Qué es este documento.** Entrada del `frontend-agent` para la
> [#11967](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/11967) (5 SP, Feature
> #11912). Modo **slim**: no hay ruta ni `PageSlug` nuevos y no se inventa un patrón visual. Extiende
> una pantalla que existe (`FlitoSoatSolicitud.tsx`) y reusa dos componentes que existen
> (`ModalSoatVigente`, `FichaRunt`).
>
> **Contrato:** `docs/diseno-hu-11966-runt-compuerta-excel-cliente.md` §2 (ADR-0010, `Propuesto`).
> **Supersede**, párrafo a párrafo, partes de `docs/ux/flito-soat-formulario-un-paso-y-ficha-runt.md`
> y de `docs/ux/alta-solicitud-cliente-y-consulta-runt.md` — ver §9. Las HU #11935/#11936 **no se
> reescriben**: siguen Resolved y las solicitudes radicadas bajo su regla no se tocan desde aquí.
>
> **Fuera de alcance, escrito para que nadie lo amplíe de paso:** la cola (`FlitoSoat.tsx`), la ficha
> RUNT de la revisión de Operaciones (`BloqueRevision`), el catálogo de causales, el legado `/soat`,
> los correos y cualquier catálogo DIVIPOLA para municipio/departamento.

---

## 1. Superficies tocadas

| | |
|---|---|
| **A · Bloque 1 · Vehículo y documento** | `FlitoSoatSolicitud.tsx` (`Alta`) — vuelve el botón **«Consultar el RUNT»** y vuelven a él tipo y número de documento |
| **B · Bloque 2 · Propietario** | `components/flito/soat-cliente/bloques.tsx` (`BloquePropietario`) — nombre partido por tipo de documento, contacto y ubicación obligatorios |
| **C · Tarjeta de envío** | `FlitoSoatSolicitud.tsx` — la compuerta vive **solo** en el botón «Enviar la solicitud» |
| **D · Reusos sin cambio de forma** | `ModalSoatVigente` (vuelve a abrirse), `ModalVinEnCola`, `FichaRunt`, `FlitUploadBox`, `FlitSelect`, `flitBtn*`, `StatusChip` |
| **E · Ficha de ayuda** | `apps/web/src/content/ayuda/soat.md` — delta en §8 |
| **No se toca** | `CorreccionSolicitud.tsx` **no** reintroduce la consulta (§6); `BloqueRevision`/`FichaRunt` de la revisión de Operaciones se quedan con sus seis desenlaces (sirven a las filas históricas) |
| **Slug / permiso** | `flito_soat`. **Ninguno nuevo.** Rutas iguales: `/flito/soat/solicitud` y `/flito/soat/solicitud/:id`. Gate por capacidad (`puedeSolicitarSoat`), no por rol |
| **Roles** | `cliente` radica y subsana. `admin`/`auditor`/`proveedor` siguen viendo `TarjetaCanalAjeno` en esta ruta |
| **Endpoints** | `POST /api/flito/soat/cliente/preconsulta` (**vuelve a usarse**) · `POST /api/flito/soat/cliente` (multipart) · `PATCH /api/flito/soat/:id/solicitud` |
| **PII** | Placa, VIN, documento, correo, celular, dirección, municipio y departamento viajan **siempre** en el cuerpo de un `POST`/`PATCH`. La única PII de la URL es el uuid opaco de `/solicitud/:id` (AGENTS.md §14) |
| **Patrón visual** | Cero tokens nuevos. `--flit-danger-ink` (algo que corregir) y `--flit-warning-ink` (el servicio falló) ya existen (`flit-tokens.css:92-93`) |

### 1.1 Orden de entrada, literal del AC1

```
┌  ← Volver a mis SOAT
│  Solicitud de SOAT
│  Consultamos el RUNT con la placa y el documento del propietario. Usted completa
│  el propietario y adjunta la factura de venta. Al enviarla queda en revisión de FLITO.
│
┌─ 1 · Vehículo ──────────────────────────────────── (chip: ✓ Consultado) ──┐
│  Placa *                        Tipo de documento *                       │
│  [ ABC123        ]              [ Cédula de ciudadanía ▾ ]                │
│  Sin espacios ni guiones.       Del propietario del vehículo.             │
│                                                                           │
│  Número de documento *          VIN (número de chasis) — opcional         │
│  [ 1020304050    ]              [                          ]              │
│                                 Si lo escribe, el RUNT lo compara con el  │
│                                 del registro. Si lo deja vacío, FLITO usa │
│                                 el que traiga el RUNT.                    │
│                                                                           │
│  [ Consultar el RUNT ]                                                    │
│  La marca, la línea, el modelo, la clase, el servicio, el cilindraje y el │
│  organismo los trae el RUNT. Usted no tiene que escribirlos.              │
│                                                                           │
│  ┌ Datos del RUNT ─────────────── Traídos el 01/09/2026 10:14 ──────────┐ │
│  │ MARCA · LÍNEA · MODELO · CLASE · SERVICIO · CILINDRAJE · CARROCERÍA  │ │
│  │ ORGANISMO DE TRÁNSITO                                                │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────┘
┌─ 2 · Propietario ─────────────────────────────────────────────────────────┐
│  Documento: Cédula de ciudadanía 1020304050  (se cambia en el bloque 1)    │
│  El RUNT reporta como propietario: MARÍA F. GÓMEZ — solo de referencia.    │
│                                                                           │
│  Nombre/s *            Apellido/s *          ← si NO es NIT               │
│  Razón social *                              ← si es NIT                  │
│  Correo * · Celular * · Dirección * · Municipio * · Departamento *        │
└───────────────────────────────────────────────────────────────────────────┘
┌─ 3 · Factura de venta ────────────────────────────────────────────────────┐
│  Un solo archivo PDF · máximo 15 MB                                       │
└───────────────────────────────────────────────────────────────────────────┘
  Consulte el RUNT antes de enviar.        [ Cancelar ]  [ Enviar la solicitud ]
```

**Tipo y número vuelven al bloque 1** porque son entrada de la consulta, no del formulario: la
compuerta se dispara con placa + tipo + número (+ VIN si lo hay). Es exactamente lo que el Bug #11927
había resuelto y la #11936 deshizo al quitar la preconsulta; el AC1 lo vuelve a fijar por escrito
(«el orden de entrada es placa, tipo y número de documento, y VIN opcional»). El bloque 2 **no los
repite**: los enseña como una línea de texto con la indicación de dónde se cambian. Dos controles
para el mismo dato es la forma más barata de radicar una solicitud consultada con un documento y
enviada con otro.

**Los tres bloques se montan desde el primer paint.** No vuelve `EnEspera`: la compuerta es del
**envío**, no del tecleo, y doce controles grises que no reciben foco es lo que la #11936 quitó con
razón. Lo que el Cliente escriba antes de consultar no se pierde (§3).

---

## 2. Los 4 estados, por superficie

### 2.1 Superficie A — Bloque 1 · consulta al RUNT (AC1, AC2, AC3)

| Estado | Cuándo | Qué se ve | Copy |
|---|---|---|---|
| **3 · Vacío** | Primer paint | Los cuatro campos + botón **«Consultar el RUNT»**. Sin ficha, sin chip, sin banda | Ayuda de cada campo (§1.1) |
| **1 · Cargando** | Se pulsó consultar | El botón queda `disabled` con texto propio; los cuatro campos pasan a `readOnly` (**no** `disabled`: no deben perder el foco ni el valor visible); `role="status"` bajo el botón | Botón: **«Consultando el RUNT…»** · estado: **«La consulta puede tardar hasta un minuto. No cierre esta página.»** |
| **2 · Error** | Los tres desenlaces + los preexistentes | Ver §2.2 — es el corazón de la HU | Ver §2.2 |
| **4 · Lleno** | `200` de la preconsulta | Chip **«✓ Consultado»** en el encabezado de la sección + `FichaRunt` + el botón pasa a secundario con **«Consultar de nuevo»**. El envío queda habilitado | Pie de la ficha, ya existente: «Estos datos los trae el RUNT y no se editan…» |

**Un solo control, cuatro rótulos.** No se añade un segundo botón de reintento: el del bloque 1 es
el mismo y su rótulo dice en qué punto está — **«Consultar el RUNT»** (nunca consultado) ·
**«Consultando el RUNT…»** (`disabled`, en vuelo) · **«Volver a consultar»** (tras cualquier
desenlace que no sea `ok`) · **«Consultar de nuevo»** (secundario, tras un `ok`). El AC3 pide que el
Cliente lea «vuelva a consultar»: el rótulo del botón al que apunta esa frase **es** esa frase.

**Qué enseña la ficha.** Los siete datos de hoy más **carrocería**, que ayuda a reconocer el
vehículo. `pasajerosSentados` y `puertas` llegan en la respuesta pero **no se pintan**: son datos del
archivo de Operaciones y no responden a la pregunta «¿es mi vehículo?». **Ni la placa ni el VIN
entran a la ficha en el alta** (siguen siendo el eco de lo tecleado; la regla ya está escrita en
`FichaRunt.tsx:36-45` y en `soatCliente.ts:47-56`). Si `organismo.nombre` viene vacío, se pinta
**«—»** y **no pasa nada más**: el `422 organismo_no_catalogado` desaparece de los dos endpoints
(AC5 de la #11966), así que la rama de copy que hoy vive en `FalloCanal.organismoNombre` queda
muerta y se retira.

### 2.2 Los tres desenlaces, discriminados por `codigo` y nunca por el texto

`leerFallo` (`soatCliente.ts:130`) ya devuelve `codigo` leído del cuerpo y validado contra el enum.
**La pantalla ramifica por ese `codigo`** (y por `CODIGOS_REVISE_LOS_DATOS`, que shared-types exporta
en la #11966), jamás comparando `mensaje`. Los tres desenlaces llegan **por los dos endpoints**: el
backend los sirve desde una sola función (`verificarRuntCompuerta`), así que el mismo `switch`
atiende la consulta y el envío.

| # | `codigo` / HTTP | Qué ve el Cliente | Dónde | Qué puede hacer |
|---|---|---|---|---|
| **1a** | `runt_no_cuadra` · 422, sin `campo` | **«Revise los datos: el RUNT no encuentra ese vehículo a nombre de ese documento.»** / **«Compruebe la placa y el documento del propietario en la tarjeta de propiedad, y vuelva a consultar.»** | Banda `role="alert"` en `--flit-danger-ink`, **dentro del bloque 1, bajo el botón** | Corregir y **«Volver a consultar»**. Foco al botón |
| **1b** | `runt_no_cuadra` · 422, `campo: "vin"` | **«Revise los datos: el VIN que escribió no es el que el RUNT tiene para esa placa.»** / **«Compruébelo en la tarjeta de propiedad, o déjelo vacío para que FLITO use el del registro.»** | Misma banda **y** `aria-invalid` en el campo VIN | Corregir el VIN o vaciarlo. **Foco al campo VIN**, no al botón |
| **1c** | `runt_sin_registro` · 422 | **«Revise los datos: el RUNT no tiene ningún vehículo registrado con esa placa.»** / **«Compruebe la placa en la tarjeta de propiedad. Si el vehículo es nuevo, puede que el RUNT todavía no lo haya indexado.»** | Misma banda | Corregir y volver a consultar |
| **1d** | `runt_sin_vin` · 422 | **«El RUNT no publica el número de chasis (VIN) de este vehículo, y sin ese dato FLITO no puede radicar la solicitud.»** / **«No es un error suyo. Escríbale a su contacto en FLIT con la placa del vehículo.»** | Misma banda, **sin** promesa de que reintentar sirva | Nada que corregir. El botón sigue ahí por si tecleó mal la placa, pero el texto no lo empuja |
| **2** | `soat_vigente` · 409 (`fechaVencimiento?`) | `ModalSoatVigente` **tal cual está** (`ModalesBloqueo.tsx:52`), con sus dos redacciones (con fecha / sin fecha) y su chip `success` | Modal | **«Consultar otro vehículo»** (§3) o **«Volver a mis SOAT»**. **No se envía y no se compra** |
| **3** | `runt_no_disponible` · 503 | **«El RUNT no está disponible, vuelva a consultar.»** / **«No es un problema de sus datos: el servicio del RUNT no respondió. Espere un momento y pulse Volver a consultar.»** | Banda `role="alert"` en `--flit-warning-ink`, mismo sitio | Reintentar. Lo tecleado **no se borra** |

**Preexistentes, sin cambio de copy:** `409 vin_ya_tiene_soat` → `ModalVinEnCola` con sus tres
variantes (**puede llegar también en la consulta**, no solo en el envío: RN-01 corre antes del RUNT
cuando hay VIN tecleado — si llega ahí, el modal se abre y la compuerta **sigue cerrada**) ·
`403 canal_desactivado`/`sin_compania` → `TarjetaCanalDeshabilitado avisoCarrera` sustituye el
formulario · `400 archivo_no_pdf` → caja `rejected` + `role="alert"` con el motivo · `status === 0`
(red) → «No sabemos si la solicitud llegó a FLITO…».

**Rama por defecto, obligatoria.** Cualquier `codigo` desconocido o ya retirado (p. ej. un
`organismo_no_catalogado` servido por una API vieja en DEV, que es un escenario real porque el merge
es el deploy) cae en una banda genérica con el `mensaje` del servidor + **«Volver a consultar»**.
Sin esa rama, un despliegue desfasado deja una pantalla muda con el envío bloqueado y sin explicación.

**Las tres redacciones son distintas a propósito, y el AC3 lo exige con estas palabras: «son dos
estados distintos y no se pueden ver iguales».** «Revise los datos» le dice al usuario que corrija
algo suyo; «el RUNT no está disponible» le dice que espere. Colapsarlos manda al Cliente a revisar
una placa que está bien, o a esperar por un dato que nunca se va a arreglar solo.

### 2.3 Superficie B — Bloque 2 · propietario partido (AC4)

| Estado | Qué se ve | Copy |
|---|---|---|
| **1 · Cargando** | **No existe, y es correcto.** El catálogo de tipos de documento es estático y la partición NIT/natural es local. Nadie debe inventarle un `onReintentar` que no reintentaría nada | — |
| **3 · Vacío** | Los campos en blanco, con la línea de documento y —si el RUNT trajo propietario— la línea de referencia. El bloque está montado desde el primer paint | «Documento: {etiqueta} {número} · se cambia en el bloque 1» |
| **2 · Error** | Por campo: `<p role="alert">` bajo el control, `aria-invalid="true"` mientras el error viva, y foco al primero al pulsar Enviar. Banda sobre los botones: **«Revise los datos marcados antes de enviar.»** | §2.4 |
| **4 · Lleno** | Los cinco de contacto/ubicación y el nombre en la forma que toca | — |

**Los ocho campos, y lo que cambia en cada uno:**

| Campo | Antes | Ahora |
|---|---|---|
| `nombreCompleto` | obligatorio, único | **Desaparece del formulario y del cuerpo.** Lo deriva el servidor |
| `nombres` / `apellidos` | — | **Obligatorios si el tipo NO es NIT** (`CC, CE, TI, PAS, PPT, RC, PT`). ≤200 cada uno |
| `razonSocial` | — | **Obligatorio si el tipo es NIT.** ≤200. Nunca junto a nombres/apellidos |
| `correo` | opcional | **Obligatorio.** Misma validación de formato de hoy, con el «vacío es válido» retirado |
| `celular` | opcional | **Obligatorio.** ≤30 |
| `direccion` | opcional | **Obligatoria.** ≤300 |
| `municipio` | no existía | **Obligatorio.** Texto libre ≤100 |
| `departamento` | no existía | **Obligatorio.** Texto libre ≤100 |

Copy de los campos nuevos y de los que cambian de estado:

| Situación | Texto |
|---|---|
| Rótulo NIT | **«Razón social \*»** · ayuda **«Como aparece en el RUT y en la factura de venta.»** |
| Rótulo natural | **«Nombre/s \*»** y **«Apellido/s \*»** · ayuda del primero **«Como aparecen en el documento del propietario.»** |
| Razón social vacía | **«Escriba la razón social del propietario.»** |
| Nombres vacíos | **«Escriba el nombre o los nombres del propietario.»** |
| Apellidos vacíos | **«Escriba el apellido o los apellidos del propietario.»** |
| Correo vacío | **«Escriba el correo del propietario.»** *(el de formato mal escrito se conserva, sin la coletilla «o déjelo vacío»)* |
| Celular vacío | **«Escriba el celular del propietario.»** |
| Dirección vacía | **«Escriba la dirección del propietario.»** |
| Municipio vacío | **«Escriba el municipio del propietario.»** · ayuda **«Donde vive el propietario. No es el del organismo de tránsito.»** |
| Departamento vacío | **«Escriba el departamento del propietario.»** |
| Línea de referencia del RUNT *(solo si vino)* | **«El RUNT reporta como propietario: {nombre}. Escríbalo como aparece en la factura de venta.»** |

**El propietario del RUNT NO se prellena: se enseña como referencia.** La respuesta trae
`propietario.nombreCompleto` fundido en una cadena y la partición por el espacio es la heurística
que el propio backend rechaza por escrito (`flito-soat.export.service.ts:92-99`, y §3.2 del diseño de
la #11966: falla en cada nombre compuesto y en cada razón social). Prellenar `nombres` con la cadena
entera sería guardar «MARÍA FERNANDA GÓMEZ RUIZ» como nombre de pila. Una línea de referencia dice
la verdad y no obliga a nadie a corregir un reparto inventado. **Consecuencia:** en el alta,
`prellenados` es siempre el conjunto vacío y la marca «Lo trajo el RUNT» no aparece.

**Municipio y departamento son texto libre.** El AC solo pide que sean obligatorios y no hay
catálogo DIVIPOLA en el producto; dos altas de la misma ciudad podrán escribir «Bogotá» y
«BOGOTA D.C.». Es lo que ya pasa con `flito_tramites.ciudad` (riesgo 5 del diseño de la #11966): no
empeora nada y **un catálogo es otra HU**, no una improvisación de esta pantalla.

### 2.4 Superficie C — la tarjeta de envío y la compuerta (AC1)

| Estado | Cuándo | Qué se ve | Copy |
|---|---|---|---|
| **3 · Vacío (compuerta cerrada)** | No hay consulta `ok` vigente | **«Enviar la solicitud»** con `aria-disabled="true"` y el aspecto atenuado del `disabled`. Al pulsarlo **no se envía nada**: lleva el foco al botón «Consultar el RUNT» | Junto al botón: **«Consulte el RUNT antes de enviar.»**; tras un desenlace de vigente cerrado con la X: **«Este vehículo tiene SOAT vigente según el RUNT: no se puede radicar la solicitud.»** |
| **1 · Cargando** | Se pulsó Enviar | Botón `disabled` con **«Enviando…»** + `role="status"` sr-only. El resto de la página no se borra | **«Enviando…»** |
| **2 · Error** | Los tres desenlaces (§2.2), PDF, canal, red incierta, RN-01 | Cada uno en su sitio. **Los desenlaces del RUNT se pintan en el bloque 1 y no en la tarjeta de envío**, y además **retiran la ficha y vuelven a cerrar la compuerta** (§3) | Los de §2.2 |
| **4 · Lleno** | `201` | Navega a `/flito/soat` + toast. La fila nueva sale **Pendiente de revisión** | **«Solicitud enviada. FLITO la va a revisar.»** |

**`aria-disabled` y no `disabled`, y es una decisión de accesibilidad.** Un botón `disabled` sale del
recorrido de tabulación: quien navega con teclado llega al final del formulario y **el primario
simplemente no existe**, sin ninguna explicación. Con `aria-disabled="true"` el lector anuncia «no
disponible», el foco lo alcanza y al pulsarlo la pantalla lo lleva a la acción que sí toca. El AC1
—«no está habilitado»— se cumple igual: **no se envía nada**. Lo que el impl no puede olvidar es el
aspecto: `aria-disabled` no dispara las variantes `disabled:` de Tailwind, así que la atenuación va
explícita o el botón parecerá activo.

**Qué manda el envío**, para que nadie lo deduzca del formulario viejo: `placa`, `tipoDocumento`,
`numeroDocumento`, `nombres`+`apellidos` **XOR** `razonSocial`, `correo`, `celular`, `direccion`,
`municipio`, `departamento`, `facturaVenta`. `vin` **solo si el Cliente lo escribió** — la clave se
omite, no se manda vacía (el esquema pide 5–17 «si viene»). `nombreCompleto` **ya no viaja**. Marca,
línea, modelo, clase, cilindraje, carrocería, pasajeros, puertas y organismo **no viajan nunca**: los
resuelve el servidor consultando otra vez. La pantalla no reenvía lo que le mostró la preconsulta.

---

## 3. Transición: qué pasa al cambiar placa o documento después de una consulta buena

**La regla, en una frase: se retira todo lo que trajo el RUNT; no se borra nada de lo que tecleó el
Cliente.**

Disparadores — cualquier cambio en **placa, tipo de documento, número de documento o VIN** (los
cuatro identificadores de la consulta), en el mismo render del cambio, sin esperar al `blur`:

| Se retira | Se conserva |
|---|---|
| `FichaRunt` entera y el chip **«✓ Consultado»** | Nombre/s, apellido/s o razón social |
| La línea de referencia del propietario del RUNT | Correo, celular, dirección, municipio, departamento |
| El permiso de enviar (la compuerta se cierra) | El archivo ya adjunto y su estado `verified` |
| Cualquier banda de desenlace anterior | Los errores de campo del bloque 2 que sigan siendo ciertos |

Y aparece, en el bloque 1, un aviso `role="status"` (no `alert`: no es un fallo, es una consecuencia
de lo que el usuario acaba de hacer): **«Cambió la placa o el documento: vuelva a consultar el RUNT
antes de enviar.»** El botón vuelve a primario con **«Volver a consultar»**.

**Por qué así.** Un formulario que conserva la ficha de otro vehículo deja radicar una solicitud con
los datos técnicos de un carro y la placa de otro; el servidor la rechazaría con un error que el
Cliente no sabe explicar. Y al revés: borrar el propietario y la factura porque se corrigió una letra
de la placa castiga al usuario por el error que acaba de arreglar. Lo que trajo el RUNT depende de
los identificadores; lo que escribió el Cliente, no.

**Lo mismo vale para «Consultar otro vehículo»** (primario de `ModalSoatVigente`): limpia los
**cuatro** identificadores —hoy limpia dos—, retira lo del RUNT, **conserva** propietario y archivo,
y devuelve el foco al campo Placa vía `restoreFocusRef` (si no, el foco cae a `<body>`,
`FlitModal.tsx:30`).

**Y el caso que se olvida: un desenlace que llega en el ENVÍO también invalida.** Entre la consulta
y el envío pasa tiempo: el RUNT puede caerse, o el vehículo puede aparecer con SOAT vigente. Como el
alta vuelve a consultar en el servidor, un 422/409/503 en el `POST` significa que el «✓ Consultado»
de la pantalla **ya no es verdad**. Regla única, sin excepciones: cualquier desenlace del RUNT
devuelto por el envío **retira la ficha y cierra la compuerta**, y el mensaje se pinta en el bloque 1.
La excepción tentadora —«el 503 del envío no invalida, que reintente Enviar»— deja en pantalla un
«consultado» que nadie ha vuelto a comprobar y hace subir el PDF de 15 MB otra vez a ciegas.

---

## 4. El VIN opcional: cómo se rotula y qué pasa si no cuadra

**Rótulo:** `VIN (número de chasis) — opcional`. La palabra «opcional» va **en el rótulo** y no en un
asterisco ausente: `Campo` ya distingue `label *` de `label (opcional)` (`bloques.tsx:91`) y aquí se
usa el mismo mecanismo con el guion largo porque el rótulo ya lleva paréntesis.

**Ayuda, que es lo que evita las dos lecturas malas:** **«Si lo escribe, el RUNT lo compara con el
del registro. Si lo deja vacío, FLITO usa el que traiga el RUNT.»** Sin esa segunda frase, «opcional»
se lee como «da igual» y el Cliente se pregunta para qué está el campo; sin la primera, no entiende
por qué escribirlo puede frenarle la solicitud.

**Validaciones que se quedan y la que se va.** Se van: «Escriba el VIN del vehículo» (ya no es
obligatorio). Se quedan tal cual: máximo 17, sin `I`/`O`/`Q`, y el **aviso** no bloqueante de
longitud rara (`avisoVin`), que sigue teniendo sentido —un VIN corto puede ser legítimo— y ahora
además ayuda a decidir si vale la pena escribirlo.

**Si el VIN tecleado no cuadra con el del RUNT:** desenlace **1b** de §2.2 — misma familia «revise los
datos», foco al campo VIN, y la salida explícita de vaciarlo. **La pantalla nunca enseña el VIN que
trajo el RUNT**, ni en el mensaje ni en la ficha ni en un `title`: el 422 no lo trae a propósito
(§2.3 del diseño de la #11966), porque un Cliente que puede sondear placas ajenas convertiría el
endpoint en un lector de VIN por placa. Si alguien «mejora» el copy con el VIN correcto, ha abierto
una fuga.

---

## 5. NIT vs persona natural: conmutar sin perder lo escrito

**Modelo de estado: tres campos, no uno.** El formulario guarda `nombres`, `apellidos` y
`razonSocial` como tres valores **independientes y permanentes**. El tipo de documento decide cuáles
se **montan** y cuáles se **envían**; nunca cuáles existen.

| Acción del Cliente | Qué pasa |
|---|---|
| Escribe «MARÍA» / «GÓMEZ» con `CC` y luego cambia a `NIT` | Los dos controles se desmontan; sus valores **siguen guardados**. Aparece Razón social vacío |
| Escribe «TRANSPORTES X SAS» y vuelve a `CC` | Razón social se desmonta con su valor guardado; **reaparecen «MARÍA» y «GÓMEZ»** tal como estaban |
| Envía con `NIT` | Viaja `razonSocial`. `nombres`/`apellidos` **no viajan** aunque tengan valor (el esquema los prohíbe con NIT, y el CHECK de la base también) |

**Dos detalles que se hacen mal y no los ve nadie hasta el E2E:**

1. **Los errores de los campos ocultos se limpian al conmutar.** Si queda un error de «Apellido/s»
   con NIT elegido, `useFocoPrimerError` intentará enfocar un `id` que ya no está en el DOM y el foco
   se cae a `<body>` — la pantalla se queda sin foco y sin mensaje visible. Al cambiar el tipo, los
   errores de los tres campos de nombre se descartan.
2. **El cambio de tipo también invalida la consulta** (§3), porque el tipo es entrada del RUNT. Es la
   misma acción con dos efectos y hay que verlos los dos en la pantalla: se retira la ficha **y** se
   conmutan los campos de nombre conservando lo escrito.

**No se avisa de que se guardó lo oculto.** Un «lo que escribió sigue guardado» sería ruido para el
99 % de los casos, que conmutan una vez y por error. Lo que importa es que al volver esté ahí.

---

## 6. Subsanación de una Rechazada: qué ve el Cliente (AC5, y qué NO se hace)

`CorreccionSolicitud.tsx` **no reintroduce «Consultar el RUNT»**: no está pedido en ningún AC y las
solicitudes ya radicadas no se reescriben desde esta pantalla. Lo declaro campo a campo para que
nadie lo invente ni lo recorte:

| | Qué se ve |
|---|---|
| Botón «Consultar el RUNT» | **No existe.** Tampoco `ModalSoatVigente` ni banda de desenlace |
| Placa y VIN | **Solo lectura**, dentro de `FichaRunt` con `identificadoresGuardados` — es el único punto donde entran a la ficha, porque aquí son lo persistido y no el eco de una consulta |
| Bloque 1 | Chip **«No se puede cambiar»** (ya existe). Si marca/línea/organismo están en «—», **no es un error de esta pantalla** y no exige consultar nada |
| Tipo y número de documento | **Se quedan en el bloque 2**, editables, como hoy. Aquí no son entrada de una consulta, así que cambiarlos **no** invalida nada |
| Nombre del propietario | **Partido igual que en el alta** (NIT → razón social; natural → nombre/s y apellido/s), porque el `subsanacionSchema` del backend cambia igual. Misma conmutación del §5 |
| Contacto y ubicación | **Obligatorios igual que en el alta**: correo, celular, dirección, municipio, departamento |
| Primario | **«Reenviar la solicitud»** → `PATCH /:id/solicitud`. Vuelve a **Pendiente de revisión** |
| Los 4 estados de la vista | **Sin cambio**: skeleton / error+reintento / 404-o-ya-no-rechazada / formulario (#11914 §6.3) |

> ⚠ **Requerimiento de datos, y es el único de esta HU.** El `GET /flito/soat/:id` proyecta hoy
> `compradores: [{ nombreCompleto, numeroDocumento, orden }]` (`CorreccionSolicitud.tsx:60`). Con el
> propietario partido y con municipio/departamento obligatorios en el `PATCH`, esa proyección deja la
> subsanación en un callejón: el Cliente tendría que **volver a teclear** el nombre repartido, el
> municipio y el departamento que **ya están guardados**, a ciegas, para poder reenviar. Se pide
> ampliar el `compradores` del detalle —solo para el dueño de la fila y solo en `origen='cliente'`—
> con `tipoDocumento`, `nombres`, `apellidos`, `razonSocial`, `correo`, `celular`, `direccion`,
> `municipio`, `departamento`.
> **Mientras no llegue** (p. ej. si la #11966 entra sin este delta): los campos nuevos salen vacíos y
> el bloque muestra **«Complete los datos del propietario para poder reenviar la solicitud.»** Es
> honesto y no bloquea la HU, pero es peor producto y hay que decirlo en el PR, no descubrirlo en QA.
> Para las filas radicadas antes de la #11966 el nombre solo existe fundido: **no se reparte por el
> espacio** ni aquí ni en ningún sitio.

---

## 7. Notas para QA (10) — qué debe poder afirmar un E2E, y el mutante que mata

Sesión `CLIENTE_USER`. Se interceptan `**/flito/soat/cliente/preconsulta` y `**/flito/soat/cliente`
con `page.route`; **nunca** el RUNT real (tarda hasta un minuto y no se llama desde CI). Los mocks
devuelven `{ error, codigo }` **con el `codigo` correcto y un `mensaje` deliberadamente engañoso**
(p. ej. un 503 cuyo texto diga «revise los datos»): es la única forma de comprobar que la pantalla
ramifica por el código y no por la prosa.

| # | AC / estado | Aserto | Mutante que debe morir |
|---|---|---|---|
| 1 | **AC1 · la compuerta existe** | Al abrir: `getByRole('button', { name: 'Consultar el RUNT' })` visible, y `getByRole('button', { name: 'Enviar la solicitud' })` con `toHaveAttribute('aria-disabled','true')`. Pulsarlo → **cero** peticiones a `POST /flito/soat/cliente` | Quitar la compuerta y confiar en el 4xx del servidor: solo el aserto de «no hubo petición» lo mata |
| 2 | **AC1 · orden de entrada** | Con `page.keyboard.press('Tab')` desde el `<h1>`: Placa → Tipo de documento → Número de documento → VIN → «Consultar el RUNT». Y `getByRole('textbox', { name: /Marca\|Línea\|Modelo\|Organismo/ })` → `toHaveCount(0)` **y** `locator('input[disabled]')` → `toHaveCount(0)` | Resolver los datos del RUNT con `<input disabled>`: el primer aserto solo no lo mata (un input deshabilitado conserva rol `textbox` en varios motores) |
| 3 | **AC3 · 503 ≠ revise los datos** | Con `503 runt_no_disponible`: `getByRole('alert')` contiene **«El RUNT no está disponible, vuelva a consultar»** **y** `getByText(/Revise los datos/)` → `toHaveCount(0)`. El botón dice «Volver a consultar» | Colapsar los dos desenlaces en una banda genérica. **El aserto negativo es el único que lo caza**, y es el fallo más probable de la HU |
| 4 | **AC3 · 422 ≠ RUNT caído** | Con `422 runt_no_cuadra`: la banda dice **«Revise los datos…»** **y** `getByText(/no está disponible/)` → `toHaveCount(0)`. Repetir con `runt_sin_registro` y `runt_sin_vin`: los **tres textos son distintos entre sí** | Mapear los tres códigos al mismo mensaje «revise los datos», que pasa el aserto positivo de los tres |
| 5 | **AC3 · se ramifica por código y no por texto** | `503` cuyo `error` diga literalmente «Los datos no corresponden»: la pantalla enseña igualmente el texto de **no disponible** | Un `if (/revise/i.test(mensaje))`: verde con mocks realistas, rojo aquí |
| 6 | **AC2 · vigente** | `409 soat_vigente`: `getByRole('dialog', { name: 'Este vehículo ya tiene SOAT vigente' })`, **cero** peticiones a `POST /flito/soat/cliente`, y con `fechaVencimiento` ausente el cuerpo **no** contiene «hasta el» ni «—» | Reusar `ModalVinEnCola` cambiando el título; interpolar una fecha vacía |
| 7 | **AC1 · la transición** | Consulta `200` → «✓ Consultado» y Enviar habilitado. Cambiar **un carácter de la placa**: la región «Datos del RUNT» → `toHaveCount(0)`, Enviar vuelve a `aria-disabled="true"`, aparece «vuelva a consultar el RUNT antes de enviar» **y el correo que se había tecleado sigue en su campo** | Dos mutantes de un tiro: dejar la ficha vieja (se radica otro vehículo) y limpiar el formulario entero (castiga al que corrige). Repetir el aserto cambiando el **tipo de documento**, que es el disparador que se olvida |
| 8 | **AC1 · VIN opcional** | Sin escribir VIN, con la consulta `200`, se puede enviar: **una** petición y en su `FormData` **no** existe la clave `vin`. Con `422 runt_no_cuadra` + `campo:'vin'`: el campo VIN queda `aria-invalid="true"` y **enfocado**, y el cuerpo de la banda **no** contiene ningún VIN de 17 caracteres | Mandar `vin: ''` (el servidor responde 400 y el usuario no entiende nada); y «ayudar» enseñando el VIN del RUNT, que es la fuga |
| 9 | **AC4 · partición sin pérdida** | Con `CC`, escribir nombres y apellidos; cambiar a `NIT` → los dos controles **no existen** y aparece «Razón social»; volver a `CC` → **los dos valores siguen ahí**. Enviar con `NIT` → el `FormData` trae `razonSocial` y **no** trae `nombres`, `apellidos` ni `nombreCompleto`. Enviar sin municipio → `role="alert"` de municipio, campo enfocado, **cero** peticiones | Guardar el nombre en un solo campo y renombrarlo al conmutar: se pierde lo escrito y se manda un apellido como razón social |
| 10 | **PII, en la URL y en los selectores** | En todo el recorrido `page.url()` no contiene placa, VIN, documento, correo ni dirección. **Y los selectores del propio spec no los llevan**: se localiza por rol y por etiqueta (`getByLabel('Municipio')`), nunca por `[data-placa="ABC123"]` ni por un `aria-label` con el documento | «Compartir el enlace prellenado» con query params. Y el selector con PII: `node.target` de axe arrastra valores de atributo hasta 31 caracteres, así que una placa o un NIT metidos en un atributo acaban **dentro del informe de accesibilidad** |

> **Infraestructura.** El CI corre **un** spec E2E (el visor de PDF): cualquier spec de esta HU hay
> que añadirlo a la lista fija del nocturno y correrlo a mano antes de cerrar. Verde en el PR no
> significa que alguien lo haya ejecutado. Y con varios worktrees, comprobar el `cwd` del dev server:
> `reuseExistingServer` puede estar certificando otra rama. Para los E2E de accesibilidad,
> `QA_AXE_CDN=1` o salen ~10 rojos que no son regresión.

---

## 8. Delta de la ficha de ayuda in-app (`apps/web/src/content/ayuda/soat.md`)

Insumo para el gate `flit-ayuda-flito` en el pre-PR. **Cuatro puntos**, y tres de ellos son
correcciones de frases que esta HU vuelve **falsas**.

**8.1 · Paso 9 (el Cliente solicita) — se reescribe entero.** Hoy dice «No hay paso Consultar el RUNT
y usted no escribe marca, línea…». La primera mitad pasa a ser mentira. Texto propuesto:

> 9. Como Cliente, si su compañía tiene el canal abierto, pulse **Solicitar SOAT** en el encabezado:
>    se abre el formulario. Escriba la **placa**, el **tipo y número de documento** del propietario y,
>    si lo tiene a mano, el **VIN** —es opcional: si lo deja vacío, FLITO usa el que traiga el
>    registro—. Pulse **Consultar el RUNT**: hasta que el RUNT responda bien, **Enviar la solicitud**
>    no se habilita. Si el RUNT dice que el vehículo **ya tiene SOAT vigente**, verá un aviso y la
>    solicitud no se radica. Si dice que los datos no corresponden, verá **Revise los datos** y podrá
>    corregir la placa, el documento o el VIN. Si el servicio no responde, verá **El RUNT no está
>    disponible, vuelva a consultar** — que es otra cosa: ahí no hay nada que corregir, solo volver a
>    intentarlo. Con la consulta resuelta, complete el propietario: **razón social** si es NIT, o
>    **nombre/s y apellido/s** si es persona natural, y **correo, celular, dirección, municipio y
>    departamento**, que son obligatorios. Adjunte la factura de venta en PDF y pulse **Enviar la
>    solicitud**: queda en **Pendiente de revisión**. Usted no escribe marca, línea, modelo ni
>    organismo: los trae el RUNT.

**8.2 · «Qué no hace» — la viñeta del RUNT se invierte.** Hoy: «El RUNT no bloquea el alta del canal
SOAT sin trámite: un servicio caído, un vehículo sin registro o un SOAT vigente no impiden enviar…».
Se sustituye por:

> - El RUNT **sí** es requisito para radicar en el canal **SOAT sin trámite**: sin una consulta
>   resuelta no se puede enviar la solicitud, y un vehículo con **SOAT vigente** no se radica. Un
>   servicio caído no es lo mismo que unos datos que no corresponden, y la pantalla lo dice con
>   palabras distintas.

**8.3 · Paso 8 (revisión del Administrador) — se le añade una frase, no se reescribe.** La ficha del
detalle y sus seis desenlaces **siguen existiendo** para las solicitudes antiguas:

> …las solicitudes nuevas llegan con el RUNT ya verificado, así que verá **Coincide con el RUNT**.
> **Esperando al RUNT** y **SOAT vigente** solo aparecen en solicitudes radicadas antes de este
> cambio: desde ahora esas dos situaciones se resuelven en el formulario del Cliente y no llegan a
> revisión.

**8.4 · Paso 10 (subsanación) — una frase.** «Tampoco aquí se pide Consultar el RUNT» **se conserva
tal cual** (sigue siendo verdad, §6) y se le añade: «al corregir, el propietario se pide con la misma
forma que en el alta: razón social si es NIT, o nombre/s y apellido/s, más correo, celular,
dirección, municipio y departamento».

**No se toca** la sección **Estados** (habla de la cola, no del formulario) ni las viñetas de
exportación, póliza, auditor o proveedor.

---

## 9. Qué queda superado de los tres documentos UX previos

Ninguno se reescribe: los tres describen HUs entregadas. Lo que sigue es el mapa de **qué párrafo
deja de regir** y por qué, para que el impl no diseñe contra el documento equivocado.

### 9.1 `docs/ux/flito-soat-formulario-un-paso-y-ficha-runt.md` (#11936) — es el más afectado

| Párrafo | Qué decía | Estado |
|---|---|---|
| §«Superficie A · Qué se quita», puntos **1, 2 y 5** | Quitar «Consultar el RUNT» y la llamada a la preconsulta; quitar el gate `disabled={!runtListo}`; quitar `ModalSoatVigente` porque «el 409 ya no es un desenlace de esta pantalla» | **Superado.** Vuelven los tres: la compuerta, el gate del primario (ahora `aria-disabled`) y el modal de vigente |
| §«Superficie A · Qué se quita», punto **4** | «La ficha Datos del RUNT en el alta… el Cliente no los espera» | **Superado en parte.** El Cliente **no los teclea** (sigue vigente) pero **sí los ve**: la ficha vuelve como confirmación de que la compuerta abrió |
| §«Superficie A · Qué se quita», punto **3** (`EnEspera`) | Los tres bloques montan sus controles desde el primer paint | **Vigente.** No se reintroduce `EnEspera` (§1.1) |
| §«Copy de botones», fila «**No existe** «Consultar el RUNT»…» | — | **Superado.** El rótulo canónico vuelve, con los cuatro estados del §2.1 |
| §«Los 4 estados — alta», cabecera «esta superficie **ya no tiene red hacia el RUNT**» y las cinco filas | — | **Superada.** La reemplazan §2.1–§2.4 de este documento |
| §«AC2 en una frase» y §«AC3 en una frase» | «Un RUNT caído no existe en esta pantalla»; «no hay modal de vigente, el Cliente envía igual» | **Superados, y son el punto exacto del giro del PO** |
| §«Acciones»: «No hay invalidación por cambio de placa/VIN: no hay resultado de RUNT que invalidar» | — | **Superado.** §3 restituye la invalidación y la amplía a los cuatro identificadores |
| §«Accesibilidad», orden de tabulación «**sin** el hueco que dejaba Consultar el RUNT» | — | **Superado.** Nuevo orden en §1.1 y nota 2 de QA |
| §«Notas para QA» **1, 3, 4** | «Consultar el RUNT → `toHaveCount(0)`»; el form no aborta con RUNT caído; vigente no bloquea | **Superadas.** Las sustituyen las notas 1, 3, 4 y 6 del §7 |
| §«Decisiones y descartes» **1, 2, 3** | Alta de un paso sin gate; cero «Consultar el RUNT»; `ModalSoatVigente` **no** | **Superadas** |
| **Superficie B** (ficha RUNT en la revisión) y **Superficie C** (subsanar sin consultar) | — | **Vigentes íntegras.** La ficha de revisión no se toca en esta HU; la subsanación sigue sin consulta (§6). Único matiz: dos de sus seis desenlaces pasan a ser históricos (§8.3) |

### 9.2 `docs/ux/alta-solicitud-cliente-y-consulta-runt.md` (#11914) — vuelve a regir casi entero

Este documento **revive** como referencia del flujo (la #11936 lo había dejado a medias). Lo que
**no** revive:

| Párrafo | Estado |
|---|---|
| §2.5, estado **2c · Organismo fuera del catálogo** (`422`), y la rama `422 organismo` del Mermaid | **Superado y suprimido.** El AC5 de la #11966 quita el organismo como compuerta: `organismo.codigo` es `string \| null` y el `422 organismo_no_catalogado` desaparece de los dos endpoints. Si el organismo no cruza, la ficha pinta «—» y **se puede enviar igual** |
| §2.5, cabecera «**Cinco desenlaces**» y §«Decisiones» **4** | **Superados** por los **tres** desenlaces discriminados de §2.2 (más los preexistentes de RN-01, canal, PDF y red) |
| §2.8, «**Consultar el RUNT** habilitado cuando placa y VIN pasan la validación» | **Superado.** Ahora: placa + tipo + número válidos; el VIN es opcional y solo se valida si está escrito |
| §2.9, filas «**VIN vacío** → Escriba el VIN del vehículo» y «Nombre vacío → Escriba el nombre completo o la razón social» | **Superadas** por §4 (VIN opcional) y por la tabla de copy de §2.3 (nombre partido) |
| §2.8, tabla de validación, filas de **correo, teléfono y dirección «Opcional»**, y la **pregunta abierta al PO** del recuadro | **Superadas y respondidas:** los tres son **obligatorios**, y se suman **municipio** y **departamento** (AC4). La pregunta al PO queda cerrada |
| §2.6, estado **4 · Lleno (prellenado)** y la marca «Lo trajo el RUNT» por campo | **Superado.** El propietario del RUNT se enseña como **línea de referencia**, no como prellenado (§2.3) |
| §2.11, tabla de endpoints y sus códigos | **Superada** por §2 del diseño de la #11966 (códigos, `CODIGOS_REVISE_LOS_DATOS`, `runt_sin_vin`, VIN opcional, organismo nullable) |
| §«Notas para QA» **5, 6, 11, 12** | **5** (sin registro ≠ no pudimos consultar) sobrevive en espíritu y la reemplaza la nota 4 del §7; **6** (organismo fuera de catálogo) **muere**; **11 y 12** (modal de vigente) **reviven** y las recoge la nota 6 del §7 |
| §6.2, punto 3 y §6.3 (subsanación) | **Vigentes.** Solo se les suma la forma partida del propietario (§6) |
| §2.4 (ficha `<dl>` y no inputs), §«Pantalla 3 y 4» (los dos modales), §2.10 (permisos), §«Accesibilidad», §«Pantalla 5» (canal apagado) | **Vigentes íntegras.** Nada de esta HU los toca |

### 9.3 `docs/ux/identidad-rol-cliente-y-soat-sin-tramite.md` (#11913)

**Nada queda superado.** Ese documento resuelve identidad, menú, aterrizaje y la frontera con el
legado `/soat`; no dice nada del gate del RUNT. Su única mención (nota 6 de QA:
`getByText('Verificar RUNT')` → `toHaveCount(0)`) es un aserto **sobre la pantalla legada `Soat.tsx`**
y **sigue siendo válido**: «Verificar RUNT» es cadena del legado y no debe confundirse con
«Consultar el RUNT», que es el botón del canal Cliente. Un E2E que las mezcle dará un rojo falso o,
peor, un verde falso.

---

## 10. Decisiones y descartes (citables en el PR)

| # | Decisión | Descarte |
|---|---|---|
| 1 | La compuerta se expresa en **un solo sitio**: `aria-disabled` en «Enviar la solicitud» + la razón al lado | `disabled` (saca el primario del tab order sin explicación) y volver a `EnEspera` en los bloques 2 y 3 |
| 2 | **Un control de consulta con cuatro rótulos**, no un botón + un «Volver a consultar» aparte | Dos botones: duplican la acción y dejan uno huérfano tras el `ok` |
| 3 | Ramificar por `codigo` y `CODIGOS_REVISE_LOS_DATOS`; **rama por defecto** para códigos desconocidos | `if (/revise/i.test(mensaje))`: se rompe con la primera corrección de una tilde, y con un despliegue desfasado deja la pantalla muda |
| 4 | **Tres redacciones distintas** y dos tintas distintas (`danger` para «corrija», `warning` para «el servicio falló») | Una banda genérica «no se pudo consultar el RUNT»: manda a revisar una placa correcta |
| 5 | Tipo y número **vuelven al bloque 1**; el bloque 2 los enseña como texto | Duplicar los controles: se consulta con un documento y se envía con otro |
| 6 | Se retira **lo del RUNT**, se conserva **lo del Cliente**, ante cualquier cambio de los cuatro identificadores — y también cuando el desenlace llega en el envío | Conservar la ficha (radica otro vehículo) · limpiar el formulario (castiga al que corrige) · «el 503 del envío no invalida» (deja un «consultado» falso y resube el PDF) |
| 7 | El propietario del RUNT es **referencia**, no prellenado | Partir `nombreCompleto` por el espacio: falla en cada nombre compuesto y en cada razón social, y el backend ya lo rechazó por escrito |
| 8 | Tres campos de nombre **permanentes**; el tipo decide cuáles se montan y cuáles viajan | Un campo que se renombra al conmutar: pierde lo escrito y manda un apellido como razón social |
| 9 | Municipio y departamento, **texto libre** | Inventar un catálogo DIVIPOLA que ningún AC pide |
| 10 | La ficha enseña **8 datos** (los 7 de hoy + carrocería) | Pintar también pasajeros y puertas: son del archivo de Operaciones y no ayudan a reconocer el vehículo |
| 11 | El **VIN del RUNT nunca se enseña** en un desenlace 422 | «Ayudar» diciendo cuál era el bueno: convierte el endpoint en un lector de VIN por placa |
| 12 | La ficha de revisión de Operaciones **no se toca** | Reescribir sus seis desenlaces «ya que estamos»: sirven a las filas históricas, que no se reconsultan |

**Requerimientos nuevos de datos: 1** — el `compradores` del `GET /flito/soat/:id` (§6). Todo lo
demás lo cubre el contrato de la #11966.
