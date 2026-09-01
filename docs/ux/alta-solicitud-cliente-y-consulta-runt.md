# UX — Alta de la solicitud de SOAT del canal Cliente y consulta al RUNT (HU #11914)

> **Qué es este documento.** La entrada del `frontend-agent` que implemente la HU
> [#11914](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/11914), eslabón **2 de 4**
> del Feature #11912. Modo **full**: hay pantalla nueva.
>
> **Continúa** a `docs/ux/identidad-rol-cliente-y-soat-sin-tramite.md` (#11913, que dio identidad, menú
> y aterrizaje) y se apoya en `docs/adr/ADR-0008-flito-soat-canal-cliente.md`, que ya decidió el
> modelo de datos, los estados y los ocho endpoints. **Donde el ADR y el doc de la #11913 discrepan,
> manda el ADR** —el slug es `flito_soat`, no `soat`, y la redirección `/soat → /flito/soat` no
> existe— y así está ya en el código de la rama (`App.tsx:198`).
>
> **Fuera de alcance, escrito para que nadie lo amplíe de paso:** la revisión del admin (validar,
> rechazar con causal) es la **#11915**; lo que ve el gestor y la descarga de la póliza es la
> **#11916**; no hay correos ni notificaciones en todo el Feature; no se diseña multipropietario; no
> se toca el legado `/soat`; no se rediseña la cola más allá de los tres deltas del §1.

---

## Contexto y roles

| | |
|---|---|
| **Rol** | `cliente` — usuario externo de una compañía. Único rol del producto que no es de FLIT |
| **Slug / permiso** | `flito_soat`. **Ninguno nuevo.** El alta no estrena permiso: quien puede ver la cola de su compañía es quien puede pedir un SOAT para ella |
| **Menú** | Sigue teniendo **un** ítem: «SOAT» → `/flito/soat`. El alta **no** añade entrada |
| **Rutas** | `/flito/soat` (cola, ya existe) · `/flito/soat/solicitud` (alta, **nueva**) · `/flito/soat/solicitud/:id` (subsanación, **nueva**; el cuerpo editable lo habilita la #11915) |
| **Pantallas** | 2: la cola (delta) y el formulario (nueva). Más 2 modales de bloqueo |
| **Endpoints** | `POST /flito/soat/cliente/preconsulta` y `POST /flito/soat/cliente` (multipart) — ADR §6, **nuevos, los escribe esta HU**. Más **dos requerimientos de datos** del §7 |
| **PII** | Placa, VIN y documento del propietario **solo en cuerpo de `POST`**. La única PII que la URL toca es el UUID opaco de `/solicitud/:id`, que AGENTS.md §14 permite |

**Lo que el Cliente sigue sin ver, y este documento no debe romper:** proveedor, ANS, valor pagado,
quién despachó y el historial interno. La #11913 los quitó **en el servidor**
(`flito-soat.service.ts:159-188`, `sinCamposInternos`), y `FlitoSoat.tsx` ya los pinta detrás de
`!esCliente`. Nada de lo que se añade aquí los reintroduce: el formulario no muestra ningún campo de
la trastienda y el resultado del envío es un estado, no un precio.

---

## Flujo de usuario (Mermaid)

```mermaid
flowchart TD
    A([Cliente entra a /flito/soat]) --> B{¿La compañía tiene<br/>«SOAT sin trámite»?}
    B -- No --> B1[Cola normal + tarjeta<br/>«Este canal no está habilitado»<br/>SIN botón de solicitar]
    B -- Sí --> C[Cola + botón «Solicitar SOAT»]
    C --> D[/flito/soat/solicitud<br/>Bloque 1 · Vehículo]
    D --> E[Escribe placa + VIN<br/>«Consultar el RUNT»]
    E --> F{POST /cliente/preconsulta}

    F -- 503 · timeout · sin registro --> G[Banda de error<br/>+ «Volver a consultar»<br/>AC2]
    G --> E
    F -- 422 organismo fuera de catálogo --> H[Banda de error propia<br/>NO avanza · AC2]
    H --> E
    F -- 409 SOAT vigente --> I[[Modal «Ya tiene SOAT vigente»<br/>AC3]]
    F -- 409 VIN ya en la cola --> J[[Modal «Ya está en la cola»<br/>AC4]]
    F -- 200 --> K[Ficha «Datos del RUNT» no editable<br/>+ se abren bloques 2 y 3]

    I --> I1[Consultar otro vehículo] --> D
    J --> J1{¿Es de su compañía<br/>y está Rechazada?}
    J1 -- Sí --> S[/flito/soat/solicitud/:id<br/>Subsanar · #11915]
    J1 -- No --> C

    K --> L[Bloque 2 · Propietario<br/>tipo doc, número, nombre, contacto]
    L --> M[Bloque 3 · Factura de venta PDF]
    M --> N{¿Todo válido?}
    N -- No --> N1[role=alert por campo<br/>+ foco al primero] --> L
    N -- Sí --> O[«Enviar la solicitud»<br/>POST /flito/soat/cliente]
    O -- 201 --> P[Vuelve a la cola<br/>toast + fila «Pendiente de revisión»]
    O -- 403 flag apagado --> Q[Tarjeta AC5 sustituye el formulario]
    O -- 409 / 422 --> R[Mismo modal que en la preconsulta]
    O -- 400 PDF inválido --> M

    P --> T([FLITO revisa · HU #11915])
    T -- Rechazada --> U[La fila aparece «Rechazada» en su cola]
    U --> V[«Ver» → «Corregir y reenviar»] --> S
    S --> P
```

**Una lectura del diagrama que conviene no perder:** hay **cuatro** desenlaces distintos de la misma
consulta al RUNT y los cuatro se ven diferentes. Ese es el AC2 entero. Un único «no se pudo
consultar» los colapsaría, y tres de los cuatro tienen arreglos opuestos: reintentar, corregir lo
tecleado, escribirle a FLIT, o no hacer nada porque el vehículo ya está cubierto.

---

## Pantalla 1 — Cola del Cliente (`/flito/soat`) · **delta**

`FlitoSoat.tsx` ya funciona para el rol `cliente` desde la #11913. Esta HU le toca **tres cosas** y
ninguna más. Las tres son necesarias para el AC1 y el AC4: sin la primera no hay puerta de entrada al
alta, sin la segunda la pantalla vacía le da una instrucción imposible, y sin la tercera **no hay
forma de encontrar una solicitud rechazada**, que es por donde pasa la subsanación.

### 1.1 Wireframe

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ SOAT                                             [ + Solicitar SOAT ]   ← Δ1 │
│ Sus solicitudes de SOAT y las pólizas de su compañía.             ← subtítulo│
└──────────────────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────────────────┐
│ (Todos)(Pendiente de revisión)(Rechazada)(Pendiente)(Solicitado)              │
│ (Con novedad)(Pagado)                                                   ← Δ3 │
│                                        [ Buscar placa, VIN, propietario… ]   │
│  Compañía▾   Organismo▾   [Solicitado ⌄]  [Pagado ⌄]  ☐ Solo sin gestión     │
│  (sin «Proveedor», sin «Gestiona» — ya oculto desde la #11913)               │
└──────────────────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────────────────┐
│ VEHÍCULO        FECHAS      COMPAÑÍA     ESTADO              SOLIC.  PAGADO  │
│ ABC123          …           Transp. X    ⬤ Pendiente de rev.   —      —   Ver│
│ 9BW…17          …                                                            │
│ Cil. 1600 · Carr. SEDAN · Serv. Particular                                   │
│ ─────────────────────────────────────────────────────────────────────────────│
│ XYZ789          …           Transp. X    ⬤ Rechazada           —      —   Ver│
└──────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Δ1 — El botón «Solicitar SOAT»

En el slot `actions` de `PageHeaderCard`, que hoy solo pinta «Cargar facturas (masivo)» para
Operaciones y gestor. Es `flitBtnPrimary` y es **la única acción primaria que el Cliente tiene en todo
el producto**.

- Se pinta **solo si** `esCliente && puedeSolicitar` (§7, requerimiento 1).
- Navega a `/flito/soat/solicitud`. Es un `<Link>` con aspecto de botón, no un `onClick`: tiene que
  poder abrirse en otra pestaña y salir en el historial.
- El subtítulo de la cabecera cambia **solo para el cliente**: el actual («Cola de adquisición del
  SOAT. El SOAT se ancla al VIN y solo pasa a Pagado con una factura validada.») es vocabulario de
  Operaciones —«cola de adquisición», «RN-01»— y le habla de un proceso que no ejecuta.

### 1.3 Δ2 — El vacío de la cola le da hoy una instrucción imposible

Medido, `FlitoSoat.tsx:291`: cuando no hay filas y no hay filtros, la pantalla dice

> «No hay SOAT en esta vista. **Sincroniza desde el Tablero** para traer trámites nuevos.»

El Cliente **no tiene Tablero** (la #11913 se lo quitó a propósito) y no puede sincronizar nada. Es la
primera frase que lee el primer usuario del rol nuevo, y le manda a un sitio que no existe para él.
Se ramifica por rol; el texto de Operaciones no se toca.

### 1.4 Δ3 — Las pills de estado no incluyen los dos estados del canal

Medido, `FlitoSoat.tsx:82` y `:96`: `estadosDisponibles` es `ESTADOS_GESTOR` para el gestor y
`ESTADOS_OPERACIONES` —`[pendiente, solicitado, pagado, con_novedad]`— para todos los demás,
**incluido `cliente`**. Es decir: hoy el Cliente no puede filtrar por **Pendiente de revisión** ni por
**Rechazada**, que son precisamente sus dos estados propios. Con la cola paginada, encontrar una
rechazada entre las páginas es cuestión de suerte, y el AC4 exige que llegue a ella.

**Decisión:** una tercera lista, `ESTADOS_CLIENTE`, con los **seis** en orden de recorrido:

```ts
[PENDIENTE_REVISION, RECHAZADA, PENDIENTE, SOLICITADO, CON_NOVEDAD, PAGADO]
```

Los seis y no los dos suyos: el aislamiento del Cliente es **por compañía, no por origen**
(`condicionesCola`, `flito-soat.service.ts:325`), así que en su cola conviven los SOAT que nacieron de
trámites de FLIT con los que él radica. Ofrecerle solo dos filtros dejaría fuera la mayoría de sus
filas.

**Y un hallazgo que ahorra una columna:** no hace falta enseñarle el `origen`. `pendiente_revision` y
`rechazada` **solo existen** en el canal Cliente (ADR §8), así que el estado ya dice de dónde viene
cada fila. Pedir `origen` en el DTO sería un dato de más para no decir nada nuevo.

### 1.5 Los 4 estados — cola del Cliente

| Estado | Qué se ve | Copy |
|---|---|---|
| **1 · Cargando** | `data === null` y sin error: la tabla no está montada. **Deuda preexistente: hoy no hay skeleton** y la pantalla se ve vacía un instante. Se **recomienda** montar `PageContentSkeleton`, que ya existe y trae `role="status"` + `aria-busy` | — |
| **2 · Error** | Banda roja de `FlitCard` (ya existe, `:279`) **+ botón «Reintentar»**, que hoy **no existe**: el único camino es recargar la página. Para un rol externo eso es un callejón | **«No pudimos cargar sus solicitudes.»** · botón **«Reintentar»** |
| **3 · Vacío (sin filtros)** | `FlitEmpty` + el botón primario repetido dentro, cuando `puedeSolicitar` | **«Todavía no hay ningún SOAT de su compañía en FLITO.»** + (si puede) **«Solicite el primero con la placa y el VIN del vehículo.»** |
| **3b · Vacío (con filtros)** | `FlitEmpty` | **«Ningún SOAT coincide con los filtros.»** *(el actual sirve tal cual)* |
| **4 · Lleno** | Tabla de 8 columnas (el Cliente ya no ve «Gestiona» ni «Valor») + paginación | — |

> El estado 2 es el que más importa arreglar y el más barato: un `setRecarga(n => n + 1)` ya existe
> en la página (`refrescar`, `:200`). Sin botón, un 500 pasajero deja al Cliente mirando una banda
> roja sin salida.

---

## Pantalla 2 — Formulario de solicitud (`/flito/soat/solicitud`) · **nueva**

### 2.1 Dónde vive, y por qué es una sub-ruta y no un modal

**Decisión: sub-ruta bajo el mismo slug**, en `apps/web/src/pages/FlitoSoatSolicitud.tsx` (ADR §7),
montada con `<ProtectedRoute page="flito_soat">`. **Ninguna entrada de menú nueva, ningún `PageSlug`
nuevo.**

Y esto es lo que hace que «el Cliente tiene una sola página» siga siendo verdad en la pantalla y no
solo en el papel — medido, `FlitSidebar.tsx:145`: el `NavLink` lleva `end={it.to === '/'}`, o sea que
para `/flito/soat` **`end` es `false`** y cualquier sub-ruta mantiene el ítem «SOAT» con
`aria-current="page"`. El menú sigue teniendo un ítem y ese ítem sigue marcado mientras se llena el
formulario. Con una ruta hermana (`/flito/solicitud`) se apagaría, y el Cliente estaría «en ninguna
parte» de su propio menú.

| Alternativa | Por qué se descarta |
|---|---|
| **Modal sobre la cola** | Tres bloques, una ficha de datos del RUNT y dos modales de bloqueo **encima** del modal. `FlitModal` ya sufre el apilamiento (su `useEscape` tuvo que aprender a cerrar solo el de arriba, `FlitModal.tsx:43`). Además F5 pierde todo y no hay dirección a la que volver desde la cola |
| **Cambio de vista por estado, sin URL** | La subsanación del AC4 necesita **dirección**: «abra la solicitud rechazada» sin URL es «búsquela usted». Y un `history.back()` desde el formulario saldría del portal |
| **Wizard con `FlitWizardSidebar`** | Un stepper promete pasos que se guardan, y el AC1 dice lo contrario: **no hay borrador, crear es enviar**. Sería la interfaz mintiendo sobre el modelo |
| **Ruta de primer nivel `/flito/solicitud`** | Apaga el ítem del menú (arriba) y parte en dos un slug que el ADR §4 acaba de unificar |

**Sobre el presupuesto de líneas, con el dato correcto:** `max-lines` es `error` y bloquea CI, pero
cuenta **sin líneas en blanco ni comentarios** (`eslint.config.mjs:69`), y `FlitoSoat.tsx` **no** está
en `FROZEN_CEILINGS`: le aplica el tope global de 800. Así que sus 795 líneas físicas de hoy **no** son
la medida y hay más margen del que ese número sugiere. El que no hay es el que haría falta: el
formulario, con tres bloques, la ficha del RUNT y dos modales, no cabe ahí ni con ese margen —de ahí
la página propia que el ADR §7 ya reparte—. Los tres deltas del §1 sí caben.

### 2.2 Wireframe — bloque 1, antes de consultar (estado inicial)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ← Volver a mis SOAT                                                          │
│ Solicitud de SOAT                                                            │
│ Consultamos el RUNT con la placa y el VIN, usted completa el propietario y   │
│ adjunta la factura de venta. Al enviarla queda en revisión de FLITO.         │
└──────────────────────────────────────────────────────────────────────────────┘

┌─ 1 · Vehículo ───────────────────────────────────────────────────────────────┐
│                                                                              │
│  Placa *                          VIN (número de chasis) *                   │
│  [ ABC123            ]            [ 9BWZZZ377VT004251        ]               │
│  Sin espacios ni guiones.         17 caracteres. Está en la tarjeta de       │
│                                   propiedad.                                 │
│                                                                              │
│  [ Consultar el RUNT ]                                                       │
│  La marca, la línea, el modelo, la clase, el servicio, el cilindraje y el    │
│  organismo de tránsito los trae el RUNT. Usted no tiene que escribirlos.     │
└──────────────────────────────────────────────────────────────────────────────┘

┌─ 2 · Propietario ────────────────────────────────────────────────────────────┐
│  ○ Se habilita cuando el RUNT responda.                                      │
└──────────────────────────────────────────────────────────────────────────────┘

┌─ 3 · Factura de venta ───────────────────────────────────────────────────────┐
│  ○ Se habilita cuando el RUNT responda.                                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

Los bloques 2 y 3 **se pintan desde el principio, con encabezado y una línea de espera, pero sin
montar sus controles**. Las dos alternativas son peores: esconderlos deja al usuario sin saber qué le
van a pedir (y la factura de venta hay que ir a buscarla, no está a mano); pintarlos `disabled`
mete doce controles grises que no reciben foco y que parecen una pantalla rota — que es exactamente
lo que el AC1 pide evitar en la ficha del RUNT y vale igual aquí.

### 2.3 Wireframe — bloque 1 resuelto + bloques 2 y 3 abiertos

```
┌─ 1 · Vehículo ──────────────────────────────────────────── ✓ Consultado ─────┐
│  Placa *  [ ABC123 ]   VIN *  [ 9BWZZZ377VT004251 ]  [ Consultar de nuevo ]  │
│                                                                              │
│  ┌ Datos del RUNT ────────────────────── Traídos el 29/08/2026 10:14 ──────┐ │
│  │  MARCA            LÍNEA              MODELO           CLASE             │ │
│  │  RENAULT          LOGAN              2019             AUTOMOVIL         │ │
│  │                                                                         │ │
│  │  SERVICIO         CILINDRAJE         ORGANISMO DE TRÁNSITO              │ │
│  │  Particular       1600               STRIA TTEyTTO MEDELLIN             │ │
│  │                                                                         │ │
│  │  Estos datos los trae el RUNT y no se editan. Si alguno no coincide con │ │
│  │  su vehículo, corríjalo ante su organismo de tránsito antes de pedir el │ │
│  │  SOAT.                                                                  │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘

┌─ 2 · Propietario ────────────────────────────────────────────────────────────┐
│  Tipo de documento *              Número de documento *                      │
│  [ Cédula de ciudadanía  ▾]       [ 1020304050          ]                    │
│                                                                              │
│  Nombre completo o razón social *                                            │
│  [ MARÍA FERNANDA GÓMEZ RUIZ                                     ]           │
│  Como aparece en la factura de venta.                                        │
│                                                                              │
│  Correo electrónico (opcional)    Teléfono (opcional)                        │
│  [ ______________________ ]       [ ______________ ]                         │
│                                                                              │
│  Dirección (opcional)                                                        │
│  [ ______________________________________________ ]                          │
└──────────────────────────────────────────────────────────────────────────────┘

┌─ 3 · Factura de venta ───────────────────────────────────────────────────────┐
│      ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐             │
│                              ⬆                                               │
│        Factura de venta del vehículo *                                       │
│        Un solo archivo PDF · máximo 15 MB                                    │
│      └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘             │
└──────────────────────────────────────────────────────────────────────────────┘

  Al enviarla, la solicitud pasa a revisión de FLITO. No se guarda como borrador.
                                       [ Cancelar ]  [ Enviar la solicitud ]
```

### 2.4 Los datos del RUNT: **una ficha, no campos deshabilitados** (el corazón del AC1)

**Decisión: `<dl>` dentro de una tarjeta con encabezado propio, con el patrón `Dato` que
`FlitoSoat.tsx:677` ya usa en el detalle.** No hay `<input disabled>` en ninguna parte.

Por qué, en orden de peso:

1. Un `<input disabled>` **no recibe foco**: quien navega con teclado o con lector nunca llega al
   valor. Siete datos que el usuario no puede leer con su herramienta habitual.
2. Gris + borde + rectángulo es el vocabulario de «esto se edita, pero ahora no puedes» —el mismo que
   usa un campo bloqueado por un error—, y el AC1 pide justo que **no parezca deshabilitado por
   error**. Un dato que nunca se va a editar no debe llevar la forma de un control.
3. Un `<dl>` se copia, se lee, y el lector lo anuncia como par etiqueta–valor, que es lo que es.
4. Ya existe en el producto y esta misma pantalla lo hereda del detalle del SOAT: **regla 3**, no se
   inventa un patrón que el kit resuelve.

Y el matiz que lo cierra: la ficha lleva **un sello de procedencia visible** —«Datos del RUNT ·
Traídos el {fecha} {hora}»— y una frase que dice **qué hacer si están mal** (corregirlos ante el
organismo, no aquí). Sin esa frase, un dato incorrecto y no editable es una pared; con ella, es una
instrucción.

**Lo que la ficha NO puede incluir: la placa ni el VIN.** Está medido en
`certificacion-runt.ts:100-109`: la pasarela **devuelve el identificador con el que se consultó**
aunque no encuentre nada, y una consulta por VIN devuelve ese mismo VIN aunque el chasis real sea
otro. Pintarlos bajo el rótulo «Datos del RUNT» los presentaría como confirmados por el RUNT cuando
son el eco de lo que el usuario tecleó. Se quedan arriba, en el bloque 1, como lo que son: lo que él
escribió.

**El organismo se muestra por su nombre, nunca por el código DIVIPOLA.** El código es la clave que
viaja al backend (`resolverCodigoOrganismoFlit`, `organismos-transito.ts:160`); «05001» no le dice
nada a nadie.

### 2.5 Los 4 estados — **consulta al RUNT** (bloque 1). Es el AC2

Esta es la superficie con datos de red del formulario y la que peor suele quedar. Cinco desenlaces,
no dos, y ninguno se ve como otro.

| Estado | Disparo | Qué se ve | Copy | ¿Avanza? |
|---|---|---|---|---|
| **1 · Cargando** | Se pulsó «Consultar el RUNT» | Botón en `disabled` con texto propio; los dos campos quedan `readOnly` (no `disabled`: no deben perder el foco ni el valor visible); mensaje bajo el botón en `role="status"` | Botón: **«Consultando el RUNT…»** · mensaje: **«La consulta puede tardar hasta un minuto. No cierre esta página.»** | — |
| **2a · Error de servicio** (`503`, timeout, `500`) | El RUNT no respondió | Banda `role="alert"` en tinta `--flit-danger-ink` dentro del bloque 1, **con botón de reintento**. Lo tecleado **no se borra** | **«No pudimos consultar el RUNT.»** / **«El servicio no respondió. Vuelva a intentarlo en unos minutos; la placa y el VIN siguen escritos aquí.»** · botón **«Volver a consultar»** | No |
| **2b · El RUNT no conoce el vehículo** (`404` / `runtSinRegistro`) | Respondió, pero sin registro | Misma banda, **otro texto**: aquí el arreglo es del usuario, no del tiempo | **«El RUNT no tiene registrado ningún vehículo con esa placa y ese VIN.»** / **«Verifique los dos datos en la tarjeta de propiedad. Si son correctos y el vehículo es nuevo, es posible que el RUNT todavía no lo haya indexado.»** · botón **«Volver a consultar»** | No |
| **2c · Organismo fuera del catálogo** (`422`) | El RUNT respondió bien, pero su organismo no está en `ORGANISMOS_TRANSITO` (o no lo reporta) | Misma banda, **tercer texto**, y **sin promesa de que reintentar sirva**: reintentar no cambia el catálogo | **«Todavía no atendemos el organismo de tránsito de este vehículo.»** / **«El RUNT lo reporta en {organismo}, que aún no está habilitado en FLITO. Escríbale a su contacto en FLIT con la placa {placa}.»** · Variante sin organismo: **«El RUNT no reporta el organismo de tránsito de este vehículo, y sin ese dato no podemos radicar la solicitud.»** · botón **«Volver a consultar»** (secundario, no primario) | **No — AC2** |
| **3 · Vacío** | Nada consultado todavía | Bloque 1 con los dos campos y el botón; bloques 2 y 3 en espera | La ayuda del wireframe §2.2 | — |
| **4 · Lleno** | `200` | Ficha «Datos del RUNT» + chip **✓ Consultado** en el encabezado + botón **«Consultar de nuevo»** (secundario). Se abren los bloques 2 y 3 | — | Sí |

**Cambiar la placa o el VIN después de una consulta buena invalida el resultado.** La ficha se retira,
los bloques 2 y 3 vuelven a «en espera» **conservando lo que ya se hubiera escrito**, y el chip pasa
a un aviso: **«Cambió la placa o el VIN: vuelva a consultar el RUNT antes de enviar.»** Sin esto se
puede enviar una solicitud con los datos técnicos de un vehículo y la placa de otro, y el servidor
—que consulta de nuevo— la rechazaría con un error que el usuario no sabría explicar.

**Los tres textos de error son distintos a propósito.** Un solo «no se pudo consultar el RUNT» deja al
usuario eligiendo entre esperar, revisar lo que escribió y escribir a FLIT, que son tres acciones
opuestas. Es el mismo criterio que `CertificacionRunt.tsx` ya aplicó con sus cinco desenlaces y su
columna «Qué hacer».

### 2.6 Los 4 estados — bloque 2 (Propietario)

El catálogo de tipo de documento es **estático** (los ocho del AC1, ya mapeados en
`runt-tipo-doc.ts:7`): no viaja por red, así que no tiene «cargando» ni «error de carga». Se dice aquí
para que nadie invente un `onReintentar` que no reintentaría nada.

| Estado | Qué se ve |
|---|---|
| **1 · Cargando** | **No existe**, y es correcto: el bloque se monta ya resuelto tras la preconsulta. Los datos que pudieran venir del RUNT llegan **en la misma respuesta** que abrió el bloque |
| **2 · Error** | Por campo: `<p role="alert">` bajo el control, `aria-invalid="true"` y foco al primero que falle (§5) |
| **3 · Vacío** | El RUNT no devolvió propietario: los campos salen en blanco, sin marca de procedencia. **Es el caso normal, no un fallo**, y no se muestra ningún aviso |
| **4 · Lleno (prellenado)** | El RUNT sí devolvió nombre y/o documento: se prellenan, **siguen siendo editables**, y bajo el bloque aparece **«Los datos que trajo el RUNT están marcados. Corríjalos si no coinciden con la factura de venta.»** con una marca discreta por campo prellenado |

**Por qué el propietario sí se edita y el vehículo no** —y hay que poder decirlo en una frase: lo no
editable es lo que decide **qué vehículo es y a qué organismo pertenece**, que es lo que fija el
trámite y el precio; lo editable es **quién es la persona**, que es lo que va en la factura y lo que
el RUNT puede tener desactualizado tras una compraventa reciente. Justo el caso en el que este canal
se usa.

> ⚠ **Riesgo abierto 2 del ADR, y esta pantalla es la que lo paga.** `certificacion-runt.ts:11`
> afirma por escrito que «el RUNT no devuelve al propietario», mientras que
> `soat/refresh.service.ts:111` **sí** lee `runt.data.vehiculo.nombrePropietario`. Correo, teléfono y
> dirección casi con seguridad no vienen. **El diseño de arriba funciona en los dos mundos** —el
> bloque se llena a mano y el prellenado es un extra— y por eso no bloquea la HU. Lo que **no** debe
> hacerse es un diseño que dé por hecho el prellenado: si el RUNT no lo trae, quedaría un bloque
> vacío que la pantalla presenta como «traído».

### 2.7 Los 4 estados — bloque 3 (Factura de venta)

`FlitUploadBox` ya tiene exactamente estos cuatro (`idle | uploading | verified | rejected`), con su
color, su icono y su texto. Se usa tal cual, con `accept=".pdf"` (el defecto incluye imágenes y aquí
solo vale PDF) y `hint`.

| Estado | `state` | Qué se ve | Copy |
|---|---|---|---|
| **1 · Cargando** | `uploading` | Caja atenuada, sin puntero | **«Analizando...»** *(del componente)* |
| **2 · Error** | `rejected` | Caja en `--flit-danger` + **`<p role="alert">` debajo con el motivo concreto** | Ver §2.9. El «Rechazado — cargar otro» del componente **no basta**: no dice por qué |
| **3 · Vacío** | `idle` | Caja punteada azul con etiqueta y `hint` | **«Factura de venta del vehículo»** / **«Un solo archivo PDF · máximo 15 MB»** |
| **4 · Lleno** | `verified` | Caja verde + **nombre del archivo** y botón «Quitar» | **«{nombre}.pdf · {n} MB»** · botón **«Quitar el archivo»** |

**Un solo archivo**, aunque el endpoint de facturas de la cola acepte 50 (`flito-soat.routes.ts:29`):
lo garantiza el índice único parcial que el ADR §1.5 pone sobre `flito_soportes`. Dos facturas vivas
para el mismo SOAT y la pantalla enseñaría la que ordenara primero.

**El PDF no se previsualiza en el formulario.** `VisorPdf` existe y funciona, pero abrirlo aquí
significa montar el worker de pdfjs en una pantalla cuyo trabajo es enviar, no leer; y el archivo
acaba de salir del disco del usuario. Se muestra el nombre y el tamaño, que es lo que responde a «¿es
el que quería?».

### 2.8 Acciones y validaciones

| Acción | Habilitada cuando | Qué hace |
|---|---|---|
| **«Consultar el RUNT»** | Placa y VIN pasan la validación de formato | `POST /flito/soat/cliente/preconsulta` `{ placa, vin }` |
| **«Consultar de nuevo»** | Siempre, tras una consulta buena | Lo mismo. **No borra** lo escrito en los bloques 2 y 3 |
| **«Enviar la solicitud»** | RUNT resuelto **y** bloque 2 completo **y** archivo adjunto | `POST /flito/soat/cliente` (multipart). Texto durante el envío: **«Enviando…»**, botón `disabled` |
| **«Cancelar»** | Siempre | Vuelve a `/flito/soat`. **Con datos escritos, pide confirmación** (§2.9) |
| **«← Volver a mis SOAT»** | Siempre | Igual que Cancelar, misma confirmación |

**Validación en el cliente, campo a campo** (todas se ejecutan en `submit` y al salir del campo; el
servidor las repite, y la que manda es la suya):

| Campo | Regla | Por qué |
|---|---|---|
| Placa | Obligatoria · se normaliza a mayúsculas sin espacios ni guiones · alfanumérica · máx. 10 | `vehicles.plate` es `varchar(10)`; la normalización es la misma de `runt.service.ts:72` |
| VIN | Obligatorio · mayúsculas alfanuméricas · **máx. 17** · sin `I`, `O`, `Q` | `flito_soat.vin` es `varchar(17)` (`schema.ts:2601`). **No se exige exactamente 17**: hay chasis antiguos y de motos más cortos, y bloquearlos dejaría fuera vehículos reales. La longitud rara se avisa, no se bloquea |
| Tipo de documento | Obligatorio · uno de los ocho del catálogo RUNT | `flito_compradores.tipo_documento` es `varchar(5)` |
| Número de documento | Obligatorio · alfanumérico · máx. 30 | `varchar(30)`. **Alfanumérico y no solo dígitos**: pasaporte, CE y PPT llevan letras (`siigo.terceros.service.ts:917`) |
| Nombre o razón social | Obligatorio · máx. 200 | `NOT NULL` en la base |
| Correo | Opcional · formato de correo · máx. 150 | Nullable en la base |
| Teléfono | Opcional · máx. 30 | Nullable |
| Dirección | Opcional · máx. 300 | Nullable |
| Factura | Obligatoria · extensión `.pdf` · ≤ 15 MB | El servidor decide de verdad, por los **bytes** (`%PDF-`, patrón de `flito-impuestos.routes.ts:76`) |

> **Pregunta al PO, y es la única de producto que queda abierta:** ¿correo y teléfono del propietario
> son **obligatorios**? Por defecto van opcionales, que es lo que dice la base (`flito_compradores`
> los tiene nullable) y lo que evita inventar una obligación que ningún AC pide. Si FLITO necesita
> poder contactar al propietario para gestionar la póliza, se marcan obligatorios y esta tabla cambia
> en dos filas. **Un solo propietario**: `orden = 0`, sin porcentajes. Multipropietario es del flujo
> de trámites y no lo pide ningún AC de esta HU.

### 2.9 Copy literal — mensajes de error por campo y de envío

**Bloque 1**

| Situación | Texto |
|---|---|
| Placa vacía | **«Escriba la placa del vehículo.»** |
| Placa mal formada | **«La placa se escribe con letras y números, sin espacios ni guiones. Ejemplo: ABC123.»** |
| VIN vacío | **«Escriba el VIN del vehículo.»** |
| VIN de más de 17 | **«El VIN no puede tener más de 17 caracteres.»** |
| VIN con I, O o Q | **«El VIN no lleva las letras I, O ni Q. Revise si son unos o ceros.»** |
| VIN con longitud rara *(aviso, no bloquea)* | **«El VIN suele tener 17 caracteres y este tiene {n}. Revíselo en la tarjeta de propiedad.»** |
| Se cambió placa o VIN tras consultar | **«Cambió la placa o el VIN: vuelva a consultar el RUNT antes de enviar.»** |

**Bloque 2**

| Situación | Texto |
|---|---|
| Tipo de documento sin elegir | **«Elija el tipo de documento del propietario.»** |
| Número vacío | **«Escriba el número de documento del propietario.»** |
| Número con caracteres raros | **«El número de documento solo lleva letras y números, sin puntos ni espacios.»** |
| Nombre vacío | **«Escriba el nombre completo o la razón social del propietario.»** |
| Correo mal formado | **«Ese correo no parece válido. Revíselo o déjelo vacío.»** |
| Ayuda del selector | **«Como aparece en el documento del propietario.»** |

Opciones del selector, en este orden (valor → etiqueta):

```
''    → Seleccione el tipo…            NIT   → NIT
CC    → Cédula de ciudadanía           PAS   → Pasaporte
CE    → Cédula de extranjería          PPT   → Permiso por protección temporal (PPT)
TI    → Tarjeta de identidad           RC    → Registro civil
                                       PT    → Permiso temporal
```

Los cinco primeros rótulos son los que el producto ya usa (`siigo-terceros.ts:26-36`,
`CounterpartyForm.tsx:10`): un mismo documento no puede llamarse de dos maneras en dos pantallas del
mismo sistema.

**Bloque 3**

| Situación | Texto |
|---|---|
| Sin archivo al enviar | **«Adjunte la factura de venta en PDF.»** |
| Extensión distinta de `.pdf` *(cliente)* | **«El archivo debe ser un PDF y este es un {ext}.»** |
| No es un PDF de verdad *(servidor, `%PDF-`)* — **AC5** | **«Ese archivo no es un PDF válido, aunque se llame así. Si lo exportó desde el celular, vuelva a guardarlo como PDF y súbalo otra vez.»** |
| Supera 15 MB | **«El archivo pesa {n} MB y el máximo es 15 MB.»** |
| Falló la subida | **«No se pudo subir el archivo. Inténtelo otra vez.»** |

**Envío**

| Situación | Texto |
|---|---|
| Nota permanente sobre el botón | **«Al enviarla, la solicitud pasa a revisión de FLITO. No se guarda como borrador.»** |
| Éxito *(toast en la cola)* | **«Solicitud enviada. FLITO la va a revisar.»** |
| Hay errores al pulsar Enviar | **«Revise los datos marcados antes de enviar.»** *(banda `role="alert"` sobre el botón, además del error por campo)* |
| Cancelar con datos escritos | Título **«¿Descartar la solicitud?»** · cuerpo **«Lo que escribió no se guarda: no hay borradores.»** · botones **«Seguir llenando»** / **«Descartar»** |
| **Fallo de red durante el envío** | **«No sabemos si la solicitud llegó a FLITO. Vuelva a sus SOAT y busque la placa {placa} antes de volver a enviarla.»** + botón **«Volver a mis SOAT»** |

> Ese último es el que suele faltar y el que más daño hace. Con `flito_soat.vin` `UNIQUE`, un segundo
> envío a ciegas produce el modal de «ya está en la cola» y el usuario cree que hizo algo mal cuando
> la primera sí entró. Decirle dónde mirar cuesta una frase.

### 2.10 Permiso y comportamiento por rol

| Rol | `/flito/soat/solicitud` |
|---|---|
| `cliente` **con** el flag | El formulario |
| `cliente` **sin** el flag | La tarjeta del §4 (AC5). **No** `NoAccess`: tiene el permiso, lo que no tiene su compañía es el canal |
| `admin`, `auditor`, `proveedor` | Tienen el slug `flito_soat`, así que la ruta **abre**. Se les muestra una tarjeta neutra: **«Este formulario es del canal Cliente.»** / **«Las solicitudes que llegan por aquí se revisan desde la cola de SOAT.»** + botón **«Ir a la cola de SOAT»**. Ni error ni formulario: el alta es del Cliente y la revisión es de la #11915 |
| Cualquier otro rol | `NoAccess` de siempre, con el botón ya arreglado por la #11913 |

**La regla se escribe por capacidad (`puedeSolicitar`), no por rol.** Un `if (role !== 'cliente')`
sería la lista negra que el ADR §4 acaba de quitar del router.

### 2.11 Datos — endpoints

| # | Llamada | Cuándo | Cuerpo | Respuestas que la pantalla distingue |
|---|---|---|---|---|
| 1 | `POST /api/flito/soat/cliente/preconsulta` | Al pulsar «Consultar el RUNT» | `{ placa, vin }` | `200 {vehiculo, propietario, organismoCodigo, organismoNombre}` · `409 soat_vigente` · `409 vin_en_cola` · `422 organismo_fuera_catalogo` · `404 sin_registro_runt` · `503 runt_no_disponible` · `403 canal_deshabilitado` |
| 2 | `POST /api/flito/soat/cliente` | Al enviar | multipart: campos + `facturaVenta` | `201 {id, estado}` · `400 pdf_invalido` · `400 validacion` · `409` (los dos) · `422` · `403` |

**Los códigos de la columna derecha no son decorativos: son el contrato de esta pantalla.** Cinco
desenlaces distintos comparten hoy el mismo `409`/`400` si nadie los nombra, y la interfaz no puede
adivinar cuál es cuál leyendo un mensaje en prosa. Se pide **un discriminador estable en el cuerpo**
(`{ error: { code: 'soat_vigente', … } }`), que es lo que ya hace `ResultadoCertificacion` en el
módulo de impuestos.

---

## Pantalla 3 — Modal AC3 · «Ya tiene SOAT vigente»

```
╔══════════════════════════════════════════════════════════════════╗
║  Este vehículo ya tiene SOAT vigente                        [X]  ║
╟──────────────────────────────────────────────────────────────────╢
║  ⬤ No hace falta comprar otro                                    ║
║                                                                  ║
║  Según el RUNT, la póliza del vehículo ABC123 está vigente       ║
║  hasta el 14/03/2027.                                            ║
║                                                                  ║
║  FLITO no radica solicitudes de vehículos con SOAT vigente.      ║
║  Puede volver cuando la póliza esté por vencerse.                ║
║                                                                  ║
║          [ Consultar otro vehículo ]   [ Volver a mis SOAT ]     ║
╚══════════════════════════════════════════════════════════════════╝
```

- **Chip:** `StatusChip tone="success"` con **«No hace falta comprar otro»**. Verde y no rojo, y esto
  es una decisión: para el usuario **esto es una buena noticia**, no un fallo. Su vehículo está
  cubierto. Un modal rojo le diría que hizo algo mal.
- **Variante sin fecha** (el RUNT reporta vigencia por estado y no por `fechaVencimSoat`, que es un
  caso real — `preflight.ts:121-128` contempla los dos): **«Según el RUNT, el vehículo ABC123 tiene
  una póliza SOAT vigente.»** El resto igual. **No se inventa una fecha ni se escribe «—» en medio de
  una frase.**
- **«Consultar otro vehículo»** (primario) cierra el modal, **limpia placa y VIN** y deja el foco en
  Placa. **«Volver a mis SOAT»** navega a la cola.
- **No se muestran** la aseguradora ni el número de póliza aunque el RUNT los traiga
  (`refresh.service.ts:106-108`): no hacen falta para la decisión y son datos de un contrato con un
  tercero que el canal no necesita persistir ni enseñar (ADR §1.6).

---

## Pantalla 4 — Modal AC4 · «Ya está en la cola de FLITO»

```
╔══════════════════════════════════════════════════════════════════╗
║  Ese vehículo ya está en la cola de FLITO                   [X]  ║
╟──────────────────────────────────────────────────────────────────╢
║  ⬤ No se puede crear otra solicitud                              ║
║                                                                  ║
║  El vehículo ABC123 ya tiene una solicitud de SOAT en FLITO,     ║
║  en estado Rechazada. Cada vehículo puede tener una sola.        ║
║                                                                  ║
║  Esa solicitud fue rechazada. Para volver a enviarla, corrija    ║
║  lo que se le indica en ella; no cree una nueva.                 ║
║                                                                  ║
║       [ Abrir la solicitud rechazada ]   [ Volver a mis SOAT ]   ║
╚══════════════════════════════════════════════════════════════════╝
```

**Tres variantes, y las tres hacen falta:**

| Caso | Segundo párrafo | Botón primario |
|---|---|---|
| Es de su compañía y está **Rechazada** | **«Esa solicitud fue rechazada. Para volver a enviarla, corrija lo que se le indica en ella; no cree una nueva.»** | **«Abrir la solicitud rechazada»** → `/flito/soat/solicitud/:id` |
| Es de su compañía, **otro estado** | **«Puede seguir su estado desde sus SOAT.»** | **«Ver la solicitud»** → cola con el detalle abierto |
| **No es de su compañía** | **«Escríbale a su contacto en FLIT si cree que es un error.»** | *(ninguno; solo «Volver a mis SOAT»)* |

> 🔒 **La tercera variante es una frontera, no una cortesía.** `flito_soat.vin` es único **en toda la
> tabla**, así que el choque puede ser contra un SOAT de **otra compañía**. Si el modal dijera el
> estado, la fecha o el nombre de esa solicitud, un Cliente podría sondear VINs y deducir con quién
> más trabaja FLIT. **Requerimiento de contrato:** el `409` solo lleva `{ code, propia: boolean }`, y
> `id` y `estado` **únicamente cuando `propia === true`**. Sin ese recorte en el servidor, la interfaz
> no puede protegerlo.

### Por qué los dos modales son **distintos**, y no una plantilla con el texto cambiado

| | AC3 · SOAT vigente | AC4 · VIN ya en la cola |
|---|---|---|
| **Quién lo dice** | El RUNT | FLITO (RN-01, `vin UNIQUE`) |
| **Qué significa** | El vehículo **está cubierto** | El vehículo **ya está en trámite con nosotros** |
| **Es buena noticia** | Sí | Depende: si es suya y está rechazada, hay trabajo por hacer |
| **Tono / chip** | `success` | `warning` |
| **Qué puede hacer** | Nada, y está bien | Abrir la que ya existe, o hablar con FLIT |
| **Vuelve a poder pedirlo** | Cuando la póliza venza | Cuando esa solicitud termine su ciclo |

Fundirlos en «este vehículo no se puede solicitar» es lo que el AC4 prohíbe con estas palabras: el
usuario tiene que entender **por qué** se le detiene, y las dos causas no tienen nada que ver.

### Los 4 estados de los modales

Un modal es en sí mismo el **desenlace** de la consulta, así que sus estados no son los de una
superficie con datos propios; se declaran igualmente para que nadie los dé por resueltos:

| Estado | AC3 | AC4 |
|---|---|---|
| **Cargando** | **No existe**: se abre con los datos ya en la mano, en la misma respuesta de la preconsulta. **Ningún modal de este documento dispara una segunda llamada** | Igual |
| **Error** | **No existe por construcción**, y por eso importa: cerrar el modal devuelve al bloque 1 con lo tecleado intacto | Igual. «Abrir la solicitud rechazada» sí puede fallar → si el `GET` de esa solicitud da error, se aterriza en la vista del §6 con su banda de error y reintento |
| **Vacío** | El RUNT dice «vigente» pero sin fecha → variante sin fecha, arriba | El `409` viene sin `id` (no es de su compañía) → tercera variante, sin botón primario |
| **Lleno** | Con fecha de vencimiento | De su compañía, con estado y con destino |

---

## Pantalla 5 — AC5 · La compañía no tiene el canal habilitado

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ SOAT                                                                         │
│ Sus solicitudes de SOAT y las pólizas de su compañía.                        │
└──────────────────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────────────────┐
│  Solicitud de SOAT sin trámite                                               │
│                                                                              │
│  Su compañía todavía no tiene habilitado este canal, así que por ahora aquí  │
│  solo puede consultar sus SOAT.                                              │
│                                                                              │
│  Para pedirle un SOAT a FLIT sin un trámite abierto, escríbale a su contacto │
│  comercial y pídale que lo habilite.                                         │
└──────────────────────────────────────────────────────────────────────────────┘
        (y debajo, la cola normal — que sí funciona)
```

- **`FlitCard` neutra, no una banda de error.** No es un fallo del usuario ni del sistema: es una
  opción comercial de su compañía. Tinta `--flit-text-secondary`, cero rojo, cero icono de alerta.
- **No hay botón «Solicitar SOAT»** en ningún sitio. Ofrecer un botón que abre una pantalla que
  explica que no se puede es el patrón que el AC5 pide evitar.
- **El vacío de la cola cambia**: **«Todavía no hay ningún SOAT de su compañía en FLITO.»** sin la
  segunda frase que invita a solicitar.
- **Entrando por URL directa** a `/flito/soat/solicitud`: la misma tarjeta ocupando la pantalla, con
  **«Volver a mis SOAT»**. Ni `NoAccess` ni 403 crudo.
- **Si el flag se apaga mientras llena el formulario** (el `POST` responde `403`): el formulario se
  sustituye por la tarjeta con una primera línea añadida — **«El canal se deshabilitó mientras
  llenaba el formulario, así que no se envió nada.»** Es una frase incómoda y es la verdad; el
  silencio aquí se lee como «se perdió mi trabajo por un error».

### Los 4 estados

| Estado | Qué se ve |
|---|---|
| **Cargando** | Mientras `/me` no ha resuelto **no se pinta ni el botón ni la tarjeta**. Es lo que evita el parpadeo «puedo → no puedo», que es peor que esperar |
| **Error** | Si `/me` falla, la sesión entera cae por el camino que ya existe (`lib/api.ts`). Esta pantalla no inventa uno propio |
| **Vacío** | Flag apagado → la tarjeta |
| **Lleno** | Flag encendido → el botón, sin tarjeta |

---

## Pantalla 6 — Solicitud **Rechazada** y su subsanación (AC4, segunda mitad)

**El camino, entero, y es lo que el AC4 pide que exista:**

```
Cola → pill «Rechazada» → fila con chip rojo → [Ver] → detalle
                                                   ↓
                                    [ Corregir y reenviar ]
                                                   ↓
                              /flito/soat/solicitud/:id  (mismo formulario, modo edición)
                                                   ↓
                                    [ Reenviar la solicitud ]  → Pendiente de revisión
```

Y la **segunda puerta**, que es la que de verdad se usa: desde el modal del AC4, cuando el Cliente
intenta dar de alta un vehículo que ya tiene una solicitud rechazada. Las dos llevan a la misma URL.

### 6.1 Wireframe — el detalle de una Rechazada (dentro del modal de la cola)

```
╔══════════════════════════════════════════════════════════════════╗
║  SOAT · ABC123                                              [X]  ║
╟──────────────────────────────────────────────────────────────────╢
║  ⬤ Rechazada                                                     ║
║                                                                  ║
║  VIN                    VEHÍCULO                                 ║
║  9BWZZZ377VT004251      RENAULT LOGAN                            ║
║  COMPAÑÍA               ORGANISMO                                ║
║  Transportes X          STRIA TTEyTTO MEDELLIN                   ║
║                                                                  ║
║  ┌ Por qué se rechazó ──────────────────────────────────────────┐║
║  │ Factura de venta ilegible                                    │║
║  │ «La factura está cortada y no se ve el número del chasis.    │║
║  │  Vuelva a escanearla completa.»                              │║
║  │ 14/08/2026                                                   │║
║  └──────────────────────────────────────────────────────────────┘║
║                                                                  ║
║  Soporte  ▸ Ver soporte                                          ║
║                                                                  ║
║                              [ Corregir y reenviar ]             ║
╚══════════════════════════════════════════════════════════════════╝
```

**Lo que este modal NO muestra**, y hay que comprobarlo fila por fila: proveedor, «Gestiona»,
«Enviado por», «Valor pagado» y el `HistorialEstados`. Los cuatro primeros ya están detrás de
`!esCliente` (`FlitoSoat.tsx:542-549`). **El historial no**: `<HistorialEstados concepto="soat" …>`
se pinta hoy para todo el mundo, y es el registro interno de la operación —quién movió qué y con qué
motivo—. **Requerimiento: envolverlo en `!esCliente`.** El Cliente no necesita el historial; necesita
la causal de su rechazo, que es otra cosa y va en su propio bloque.

**«Por qué se rechazó» ≠ «Motivo de rechazo».** El modal ya pinta `soat.motivoRechazo`
(`FlitoSoat.tsx:584`), pero eso es el rechazo **del gestor** que manda a `con_novedad`
(`flito-soat.service.ts:575`) — otro actor, otro estado, otra audiencia. La causal y la observación
de la solicitud viven en la tabla satélite (ADR §1.2) y hay que traerlas (§7, requerimiento 2). Si se
reutiliza `motivoRechazo`, se mezclan dos rechazos distintos en un mismo párrafo.

### 6.2 El formulario en modo edición

El **mismo** `FlitoSoatSolicitud.tsx`, con cuatro diferencias y ninguna más:

1. **Título:** «Corregir la solicitud» en vez de «Solicitud de SOAT».
2. **Arriba del todo**, el bloque «Por qué se rechazó» repetido, en tarjeta y **no** en modal: es lo
   que hay que corregir y tiene que estar a la vista mientras se corrige, no dos clics atrás.
3. **Placa y VIN de solo lectura**, en la ficha del §2.4 con el resto de datos del RUNT. Cambiar el
   VIN convertiría la subsanación en un alta encubierta sobre otro vehículo, con la fila equivocada.
   Si el vehículo era otro, lo correcto es un alta nueva — y este es el único punto donde la placa y
   el VIN sí entran a la ficha, porque aquí no son el eco de una consulta: son lo que ya está
   guardado.
4. **Botón «Reenviar la solicitud»** y nota: **«Al reenviarla vuelve a revisión de FLITO.»**

**El adjunto es opcional en la subsanación:** si no se sube otro, se conserva el que había. La caja
arranca en `verified` con el nombre del archivo actual y el rótulo **«Factura de venta ya cargada.
Suba otra solo si la va a cambiar.»**

> **Reparto honesto entre HUs.** El `PATCH /:id/solicitud`, las causales y la escritura del rechazo
> son de la **#11915** (ADR §6-§7). Lo que la **#11914** entrega es la ruta `/solicitud/:id`, el
> formulario que la sirve y el enlace desde el modal del AC4. Si la #11915 se recorta, este camino se
> queda sin destino: conviene que en el PR de la #11914 se diga con esas palabras.

### 6.3 Los 4 estados — vista de subsanación

| Estado | Qué se ve | Copy |
|---|---|---|
| **1 · Cargando** | `PageContentSkeleton` mientras resuelve el `GET` de la solicitud. Es la única pantalla del Feature que carga por id y **no** puede pintar nada antes | *(el `aria-label` del skeleton)* |
| **2 · Error** | Banda `role="alert"` + botón **«Reintentar»** + enlace de salida | **«No pudimos cargar esta solicitud.»** · **«Reintentar»** · **«Volver a mis SOAT»** |
| **3 · Vacío / ajena** | `404` (el aislamiento por compañía de `buscarConAcceso` devuelve 404, no 403) | **«Esta solicitud no existe o no es de su compañía.»** + **«Volver a mis SOAT»** |
| **3b · No está rechazada** | `409` — ya la revisaron mientras tanto | **«Esta solicitud ya no está rechazada: FLITO la está revisando. No hay nada que corregir por ahora.»** + **«Volver a mis SOAT»** |
| **4 · Lleno** | El formulario en modo edición | — |

El **3b** es el caso real que se olvida: entre que el Cliente abre el enlace y lo edita, un admin
pudo reactivarla. Sin ese texto, se ve un `409` crudo tras rellenar el formulario entero.

---

## Accesibilidad

**Orden de tabulación del formulario** — sigue el orden visual, sin `tabindex` positivos en ninguna
parte:

```
[← Volver a mis SOAT] → Placa → VIN → [Consultar el RUNT]
  → (tras el 200) → Tipo de documento → Número → Nombre → Correo → Teléfono → Dirección
  → caja de la factura → [Cancelar] → [Enviar la solicitud]
```

- **La ficha «Datos del RUNT» no está en el recorrido de tabulación** y eso es correcto: es texto, no
  controles. Se alcanza con la navegación por encabezados y por regiones del lector, para lo cual la
  tarjeta lleva un `<h3>` real («Datos del RUNT»), no un `<p>` en negrita.
- **Cada bloque es una `<section>` con `<h2>`** («1 · Vehículo», «2 · Propietario», «3 · Factura de
  venta»). Es lo que permite saltar de bloque a bloque con un lector, y lo que hace que «se habilita
  cuando el RUNT responda» se lea dentro de su sección y no suelto.

**Foco**

| Momento | Dónde va el foco |
|---|---|
| Al entrar en el formulario | Al `<h1>` (`titleRef` de `PageHeaderCard`, que ya existe para esto) |
| Al terminar la consulta con éxito | Al `<h3>` «Datos del RUNT», que es lo nuevo que apareció. **No** al primer campo del bloque 2: saltarse la ficha es saltarse el resultado |
| Al fallar la consulta (2a/2b/2c) | Al **botón «Volver a consultar»**, que es la salida. La banda es `role="alert"` y se anuncia sola |
| Al fallar la validación en Enviar | **Al primer campo inválido**, no al mensaje. Al enfocar el control, el lector anuncia etiqueta + inválido + descripción de una vez. Es el criterio que `FlitSelect` ya implementa (`FlitSelect.tsx:135`) |
| Al abrir un modal | `useFocusTrap` de `FlitModal` lo lleva al diálogo y lo atrapa |
| Al cerrar un modal | Al disparador, si sigue vivo. **«Consultar otro vehículo»** limpia los campos, así que se pasa `restoreFocusRef` apuntando al campo Placa: sin él, el foco cae a `<body>` (`FlitModal.tsx:30`) |
| Tras enviar con éxito | Se navega a la cola y el foco va a su `<h1>` |

**`aria` y anuncios**

- Campo inválido: `aria-invalid="true"` + `aria-describedby` apuntando al `<p role="alert">` de su
  mensaje. El `aria-invalid` se **quita** en cuanto el campo se corrige; dejarlo puesto convierte la
  marca en ruido.
- **`role="alert"` solo para lo que impide continuar**: los errores por campo, la banda de la consulta
  fallida y el aviso de «revise los datos marcados». **`role="status"`** para lo que solo informa:
  «Consultando el RUNT…», «Analizando...» del adjunto, y el sello de la ficha.
- **Una sola región viva por mensaje.** Los toasts de `react-hot-toast` ya montan `role="status"`: el
  éxito del envío se anuncia por el toast **o** por la pantalla de destino, no por los dos.
- **Modales:** `FlitModal` ya pone `role="dialog"`, `aria-modal="true"` y `aria-label={title}`. El
  título de los dos modales de bloqueo **es la frase que explica el bloqueo** —«Este vehículo ya
  tiene SOAT vigente», «Ese vehículo ya está en la cola de FLITO»— precisamente porque es lo primero
  que anuncia el lector al entrar. Un título genérico («Aviso») gastaría ese anuncio en no decir nada.
- **El chip del modal lleva texto**, no solo color: `StatusChip` ya lo hace, y aquí es lo que carga la
  diferencia entre «no hace falta comprar otro» y «no se puede crear otra solicitud».

**PII y a11y a la vez**

- **Prohibido meter el VIN o el documento del propietario en un `aria-label`, en un `title` o en un
  `data-*`.** Los selectores de axe arrastran valores de atributo hasta 31 caracteres y acabarían en
  el informe de accesibilidad. La placa basta para nombrar una fila.
- Recordar `QA_AXE_CDN=1` al correr los E2E de accesibilidad, o salen ~10 rojos que no son regresión
  de nada.

**Contraste y tema**

- Cero tokens nuevos. `--flit-danger-ink`, `--flit-text-secondary`, `--flit-blue-ink` y los de
  `FlitUploadBox` ya están en uso. Tinta (`-ink`) y no superficie para todo lo que sea **texto**: es
  lo que el Bug #11604 dejó escrito.
- `npm run check:contraste` **no acredita nada de esto**: su alcance real es la ⌘K y los gradientes.
  El argumento es que los tokens ya se usan aquí, no el gate.

---

## Notas para QA — qué debe poder afirmar un Playwright de cada estado

Sesión `CLIENTE_USER` (ya existe, `e2e/helpers/auth.ts:86`, **con `companiaId`**). El RUNT se
intercepta con `page.route` sobre `**/flito/soat/cliente/preconsulta`: **nunca** contra el servicio
real, que tarda hasta un minuto y no se puede llamar desde CI.

| # | Estado / AC | Aserto | Mutante que debe matar |
|---|---|---|---|
| 1 | **Cola vacía · AC1** | La cola sin filas muestra «Todavía no hay ningún SOAT de su compañía en FLITO.» **y** `getByText(/Sincroniza desde el Tablero/)` → `toHaveCount(0)` | Dejar el vacío de Operaciones. El aserto negativo es el único que lo mata: el positivo pasaría si alguien concatena los dos textos |
| 2 | **Puerta de entrada · AC1** | Con el flag encendido, `getByRole('link', {name:'Solicitar SOAT'})` visible y `href="/flito/soat/solicitud"`. Ir ahí y comprobar que la nav **sigue teniendo 1 solo enlace** y que «SOAT» conserva `aria-current="page"` | Colgar el formulario de `/flito/solicitud`: el ítem del menú se apaga y el conteo sigue en 1, así que **hace falta el aserto de `aria-current`** |
| 3 | **RUNT cargando** | Con la ruta demorada: el botón dice «Consultando el RUNT…», está `disabled`, y existe un `role="status"` con «puede tardar hasta un minuto» | Quitar el `disabled`: dos consultas en vuelo y el resultado que gana es el que llegue último |
| 4 | **AC2 · 503** | Banda `role="alert"` con «No pudimos consultar el RUNT.», botón «Volver a consultar» **enfocado**, y **el VIN sigue escrito en su campo** | Limpiar el formulario al fallar. El aserto del valor conservado es el que lo caza |
| 5 | **AC2 · sin registro** | Con `404`: el texto es el de «El RUNT no tiene registrado ningún vehículo…» y **no** el de «No pudimos consultar el RUNT.» | Colapsar 2a y 2b en un solo mensaje — el fallo más probable de esta HU |
| 6 | **AC2 · organismo fuera de catálogo** | Con `422`: se ve el texto del organismo **y** los bloques 2 y 3 **siguen sin montar sus controles**: `getByLabel('Número de documento')` → `toHaveCount(0)` | Pintar la ficha igual y dejar avanzar. Afirmar solo el mensaje deja vivo el mutante que **sí** deja enviar |
| 7 | **AC2 · el reintento funciona** | Primera llamada `503`, segunda `200`: pulsar «Volver a consultar» pinta la ficha del RUNT | Un botón que solo limpia el error sin volver a llamar |
| 8 | **AC1 · los datos no se teclean** | Tras el `200`: los siete valores están en la página y **no hay ningún control de formulario que los contenga**: `getByRole('textbox', {name:/Marca|Cilindraje|Organismo/})` → `toHaveCount(0)`, y `locator('input[disabled]')` → `toHaveCount(0)` | Resolverlo con `<input disabled>`: el primer aserto solo no lo mata (un input deshabilitado sigue teniendo rol `textbox` en varios motores), por eso van los dos |
| 9 | **AC1 · la ficha no miente sobre placa y VIN** | Dentro de la región «Datos del RUNT», `getByText('ABC123')` → `toHaveCount(0)` | Meter el eco de la consulta en la ficha |
| 10 | **AC1 · invalidar al cambiar** | Consultar OK, cambiar un carácter del VIN: aparece «vuelva a consultar el RUNT antes de enviar», la ficha desaparece y «Enviar la solicitud» queda `disabled` | Dejar la ficha vieja: se envía una solicitud con datos de otro vehículo |
| 11 | **AC3 · modal** | Con `409 soat_vigente`: `role="dialog"` con nombre accesible «Este vehículo ya tiene SOAT vigente», el texto trae la fecha, **no** aparece «cola» en ningún sitio del modal, y **no se disparó `POST /flito/soat/cliente`** | Reusar el modal del AC4 cambiando el título. El aserto de la palabra «cola» y el de la petición no enviada son los que separan los dos |
| 12 | **AC3 · variante sin fecha** | `409` sin `fechaVencimiento`: el cuerpo **no** contiene «hasta el» ni «—» | Interpolar una fecha vacía: «vigente hasta el .» |
| 13 | **AC4 · propia y rechazada** | `409 vin_en_cola` con `propia:true, estado:'rechazada'`: botón «Abrir la solicitud rechazada» que navega a `/flito/soat/solicitud/{uuid}`, y **la URL no contiene la placa ni el VIN** | Pasar la placa por query para «ahorrar una llamada» |
| 14 | **AC4 · ajena** | `409` con `propia:false`: **no** hay botón primario, y el cuerpo del modal **no** contiene ningún estado ni ninguna fecha | Devolver el mismo payload en los dos casos. Es la fuga entre compañías, y solo la mata el aserto negativo |
| 15 | **AC4 · el camino desde la cola** | Filtrar por la pill «Rechazada» (que hoy **no existe**), abrir «Ver» y encontrar «Corregir y reenviar» | No añadir `ESTADOS_CLIENTE`: sin la pill no hay forma de llegar y el test no compila el recorrido |
| 16 | **AC4 · el detalle no filtra la trastienda** | En el detalle de un SOAT del Cliente: `getByText(/Gestiona|Enviado por|Valor pagado/)` → `toHaveCount(0)` **y** el historial de estados no está montado | Olvidar el `!esCliente` del `HistorialEstados`, que hoy se pinta para todos |
| 17 | **AC5 · flag apagado** | `/me` con `puedeSolicitarSoat:false`: no hay enlace «Solicitar SOAT», se ve la tarjeta «Su compañía todavía no tiene habilitado este canal…», y entrando por URL directa a `/solicitud` **no** aparece «No tienes acceso» | Resolverlo con `NoAccess`: el aserto negativo del texto de permisos es el que lo distingue |
| 18 | **AC5 · carrera del flag** | `/me` dice `true` y el `POST` responde `403`: el formulario se sustituye por la tarjeta con «no se envió nada» | Mostrar un `toast.error` genérico y dejar el formulario, que invita a reintentar en bucle |
| 19 | **AC5 · PDF falso** | Subir un `.pdf` cuyos bytes no empiezan por `%PDF-` → `400`: la caja queda en estado `rejected` **y** hay un `role="alert"` con «no es un PDF válido, aunque se llame así» | Confiar en `accept=".pdf"`: se salta arrastrando el archivo, y el «Rechazado — cargar otro» del componente no dice por qué |
| 20 | **Envío feliz** | Con todo lleno: **una sola** petición a `POST /flito/soat/cliente`, se aterriza en `/flito/soat`, hay toast «Solicitud enviada…» y la fila nueva sale con el chip «Pendiente de revisión» | Botón sin `disabled` durante el envío: doble clic = dos solicitudes (la segunda la para el `UNIQUE`, pero el usuario ve un error inexplicable) |
| 21 | **Foco tras validar** | Enviar con el nombre vacío: `expect(campoNombre).toBeFocused()`, `aria-invalid="true"` y un `role="alert"` con el texto exacto | Pintar el error y no mover el foco: en una pantalla larga, el mensaje queda fuera de la vista |
| 22 | **Subsanación · 409 no rechazada** | `GET` de la solicitud con `409`: se ve «FLITO la está revisando» y **no** se monta el formulario | Montar el formulario igual y dejar que falle al reenviar |
| 23 | **PII fuera de la URL** | En todo el recorrido, `page.url()` nunca contiene la placa, el VIN ni el documento; y `preconsulta` lleva los datos en el **cuerpo** | «Compartir el enlace del formulario prellenado» con query params |

> **Infraestructura, que no es un detalle:** el CI corre **un** spec E2E (el visor de PDF). Cualquier
> spec de esta HU hay que **añadirlo a la lista fija del nocturno** y correrlo a mano antes de cerrar;
> verde en el PR no significa que nadie lo haya ejecutado. Y comprobar el `cwd` del dev server: con
> varios worktrees, `reuseExistingServer` puede estar certificando otra rama.

---

## Requerimientos de datos (para `architecture-agent` / `backend-agent`)

**Dos nuevos, y un recorte de contrato.** Ninguno inventa un endpoint: uno amplía una respuesta que ya
existe, otro amplía la que traerá la #11915 y el tercero acota una que va a nacer.

### 1 · `GET /api/auth/me` gana `puedeSolicitarSoat: boolean`

Es lo que decide si se pinta el botón «Solicitar SOAT» y la tarjeta del AC5. Se calcula en el
servidor: `role === 'cliente' && clients.soat_sin_tramite = true` vía la `compania_id` del usuario;
`false` para todos los demás roles, sin JOIN.

- **Por qué en `/me` y no en la respuesta de la cola:** `/me` resuelve antes de que la cola termine,
  así que el botón no parpadea de «puedo» a «no puedo»; y hay precedente exacto —`transitoCodigo` ya
  viaja ahí (`auth.routes.ts:116`) por ser un dato de ámbito de un solo rol.
- **No es la frontera de seguridad y no debe tratarse como tal.** Es una capacidad de interfaz. Los
  dos endpoints del canal la vuelven a comprobar y responden `403`, que es lo que cubre el caso de un
  `/me` viejo (§5).
- **Un booleano derivado, no el DTO de la compañía.** No entra el NIT ni ningún otro campo de
  `clients`.
- Alternativa considerada y descartada: colgarlo del sobre de la cola (`{items, total, …}`). Es una
  capacidad del usuario, no una propiedad de una página de resultados, y llegaría tarde.

### 2 · El detalle de un SOAT `rechazada` debe traer su causal y su observación

Viven en la satélite `flito_soat_solicitud` (ADR §1.2) y hoy no salen por ninguna parte. Forma
mínima, solo cuando `origen = 'cliente'` y solo para el dueño y para `admin`:

```
solicitud: { causalNombre: string | null, observacion: string | null, revisadoEn: string | null, reenvios: number } | null
```

**No** se reutiliza `flito_soat.motivo_rechazo`: es el rechazo del gestor, que va a `con_novedad` y
tiene otro actor y otra audiencia (ADR §6). **Lo escribe la #11915**; se declara aquí porque el camino
del AC4 lo atraviesa y sin él la pantalla de subsanación no puede decir qué corregir.

### 3 · Recorte del `409` de VIN duplicado — **es una frontera entre compañías**

```
409 → { error: { code: 'vin_en_cola', propia: boolean, id?: uuid, estado?: EstadoSoat } }
```

`id` y `estado` **solo** cuando `propia === true`. Ver el recuadro del §4: sin este recorte, un
Cliente puede sondear VINs y deducir la cartera de FLIT. Es del `security-agent`, no solo del de UX.

### Y un hallazgo de seguridad que esta HU **no** puede resolver sola

`POST /api/runt/consulta-vehiculo` (`runt.routes.ts:18`) está protegido por `authMiddleware` **y por
nada más**: no lleva `requireRole`. Un `cliente` autenticado puede llamarlo directo con cualquier
placa o VIN y recibir el payload crudo del RUNT —propietario incluido— **saltándose el flag de la
compañía, la RN-01 y el bloqueo por SOAT vigente**. El diseño de esta pantalla no lo usa (usa
`/flito/soat/cliente/preconsulta`, que sí aplica las tres puertas), pero la ruta sigue ahí. Y el
`audit()` de la línea 37 escribe la **placa en claro** en el detalle, que es justo el patrón que el
ADR le pide al `security-agent` no copiar. **Para el `security-agent`, no para este documento.**

---

## Decisiones y descartes (resumen citable en el PR)

| # | Decisión | Descarte principal |
|---|---|---|
| 1 | El alta vive en **sub-ruta** `/flito/soat/solicitud`, mismo slug `flito_soat`, sin entrada de menú. El `NavLink` sin `end` mantiene «SOAT» marcado | Modal (no cabe y pierde la dirección), vista sin URL (la subsanación necesita enlace), wizard (promete borradores que no existen) |
| 2 | Los datos del RUNT son una **ficha `<dl>` con sello de procedencia**, no campos | `<input disabled>`: no recibe foco y usa el vocabulario de «bloqueado por error», que es lo que el AC1 prohíbe |
| 3 | **Placa y VIN fuera de la ficha del RUNT** en el alta (dentro, en la subsanación) | Pintarlos como confirmados: son el eco de la consulta (`certificacion-runt.ts:100`) |
| 4 | **Cinco desenlaces** de la consulta, con tres textos de error distintos y un botón de reintento en cada uno | Un solo «no se pudo consultar el RUNT»: colapsa tres arreglos opuestos |
| 5 | Los bloques 2 y 3 se pintan **en espera**, sin montar controles | Esconderlos (el usuario no sabe qué le van a pedir) o pintarlos `disabled` (doce controles muertos sin foco) |
| 6 | **Dos modales distintos**, con tono, chip, texto y salidas distintas | Una plantilla con el texto cambiado: el AC4 exige que se entienda **por qué** se detiene |
| 7 | El `409` del VIN **no revela** solicitudes de otra compañía | Devolver el mismo payload siempre: sondeo de VINs |
| 8 | AC5 se resuelve con **tarjeta neutra + ausencia del botón** | `NoAccess` («No tienes acceso a SOAT» es falso: sí lo tiene) y el botón que abre una pantalla que dice que no se puede |
| 9 | La cola gana **`ESTADOS_CLIENTE`** con los seis estados | Dejar `ESTADOS_OPERACIONES`: el Cliente no puede filtrar sus dos estados propios y no llega a su Rechazada |
| 10 | El propietario es **editable** aunque el RUNT lo prellene; el vehículo, no | Bloquear el propietario: el RUNT va detrás en una compraventa reciente, que es el caso de uso del canal |
| 11 | El adjunto es **un solo PDF**, sin previsualización, validado por bytes en el servidor | Reusar el multi-archivo de la carga masiva (rompe el índice único parcial del ADR §1.5) |
| 12 | El `HistorialEstados` se oculta al Cliente | Dejarlo: es el registro interno de la operación |
| 13 | **Tono usted** en todo lo que ve el Cliente | Tutear como el resto del producto — ver la nota de abajo |

> **Sobre el tuteo, que es una inconsistencia declarada y no un olvido.** El producto tutea
> («Sincroniza desde el Tablero», «No tienes acceso a…»). El Cliente es el primer usuario **externo a
> FLIT**, y este documento escribe todo lo suyo en **usted**. Quedan tres cadenas fuera de esta HU
> que él sí ve y que siguen tuteando: el `NoAccess` («Tu rol actual no incluye esta sección…»), el
> vacío filtrado de la cola y algún toast de `lib/api.ts`. **Decisión del PO**: o se pasan esas tres
> a usted, o se tutea también aquí. Lo que no debe quedar es media pantalla de cada forma; y si hay
> que elegir una sola, usted es la que corresponde a un tercero al que se le está prestando un
> servicio.
