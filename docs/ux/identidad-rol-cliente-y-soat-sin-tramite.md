# UX slim — Rol `cliente`, compañía obligatoria y flag «SOAT sin trámite» (HU #11913)

> **Qué es este documento.** La entrada del `frontend-agent` que implemente la HU
> [#11913](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/11913), eslabón 1 de 4
> del Feature #11912 (canal de solicitud de SOAT sin trámite para compañías cliente).
>
> Modo **slim**: no hay pantalla nueva. Se especifica **solo lo que cambia** de tres superficies
> —el formulario de usuario, la tabla de compañías y el recorte del menú/rutas— y **las cuatro
> trampas que la HU no nombra** y que, sin arreglarlas, dejan el AC1 y el AC4 sin cumplir aunque el
> backend esté perfecto. El formulario de solicitud llega en la #11914 y ese pedirá `full`.
>
> **Fuera de alcance, escrito para que nadie lo amplíe de paso:** no se diseña el formulario de
> solicitud; no se toca el resto de `Users.tsx` (permisos individuales, contraseña, activar) ni el
> resto de `Clients.tsx` (tarifas, ficha fiscal, pestaña de proveedores); no se tocan tokens ni
> estilos globales; **no se rediseña `FlitoSoat.tsx`** más allá de la puerta de entrada del §3.4.

---

## Superficies tocadas

| | |
|---|---|
| Superficie 1 | `apps/web/src/pages/Users.tsx` — el `<select>` de «Rol base» gana **Cliente**, y con ese rol aparece el campo **Compañía** (obligatorio, una sola) |
| Superficie 2 | `apps/web/src/pages/Clients.tsx` → `TabClientes` — la tabla gana la columna **«SOAT sin trámite»** con el mismo `CeldaFlag` |
| Superficie 3 | `components/shell/navItems.ts` + `App.tsx` + `components/NoAccess.tsx` + `lib/ayudaFlito.ts` — el recorte del menú y las rutas del rol |
| Slug / permiso | **Ninguno nuevo.** `cliente` recibe una fila en `ROLE_DEFAULT_PAGES` con **un solo slug: `soat`**. Ninguna clave nueva en `PAGES` |
| Endpoints | `GET /flito/parametrizacion/companias` (ya existe, `admin`+`auditor`, devuelve `{id, nombre, nit, …}`) para el selector. `POST`/`PATCH /users` deben aceptar `companiaId`; `PATCH /flito/parametrizacion/companias/:id` debe aceptar el flag nuevo. **Cero endpoints nuevos** |
| PII | El selector de compañía **no** mete nada en la URL. Ver §5 sobre el NIT y sobre `Soat.tsx` legado |

---

## 1. Superficie 1 — `Users.tsx`: el rol Cliente y su compañía

### 1.1 Lo que hay que calcar de `transitoCodigo` **no es el widget, es el mecanismo**

El refinamiento dice «usa el patrón del selector `transitoCodigo`». Ese patrón son **cinco piezas**,
y solo una es el desplegable:

| # | Pieza | Dónde está hoy | Qué se calca |
|---|---|---|---|
| 1 | El campo **aparece condicionado al rol** | `Users.tsx:265` y `329`: `{f.role === 'transito' && <TransitoOrganismoField … required />}` | `{f.role === 'cliente' && <CompaniaField … required />}`, en **los dos** formularios (crear y editar) |
| 2 | Cambiar de rol **limpia el campo** | `Users.tsx:260` y `325`: el `onChange` del `<select>` resetea `transitoCodigo` | El mismo reset para `companiaId`. Sin esto, cambiar Cliente → Proveedor y guardar manda una compañía que el backend rechaza |
| 3 | El `PATCH` **borra el dato al salir del rol** | `Users.tsx:301`: `if (f.role !== 'transito' && user.transitoCodigo) body.transitoCodigo = null` | Igual con `companiaId`. Un ex-Cliente no puede quedarse atado a una compañía |
| 4 | El backend valida **en los dos sentidos** | `users.routes.ts:74-81`, `superRefine` | Requerida si el rol es `cliente`; prohibida si no lo es |
| 5 | Cambiar el dato **invalida la sesión** y se avisa | `users.routes.ts:183` + toast de `Users.tsx:306-308` | La compañía es scope: si cambia, la sesión del usuario tiene que caer y el admin tiene que enterarse |

**La pieza 5 tiene copy propio.** El toast de tránsito dice *«El usuario debe volver a iniciar sesión
para aplicar el nuevo organismo.»* El de aquí:

> **«El usuario debe volver a iniciar sesión para aplicar la nueva compañía.»** *(6 s, `toast(...)`
> neutro, igual que el de tránsito)*

### 1.2 El widget: `FlitSelect`, **no** un combobox nuevo

`FlitOrganismoCombobox` resuelve un catálogo **estático de cientos de municipios**; la lista de
compañías llega **por red** y puede estar cargando, fallar o estar vacía. Para eso el kit ya tiene
`components/flit/FlitSelect.tsx` (HU #11561, AC7), construido literalmente para esto: etiqueta
asociada con `htmlFor`, región `role="status"` **montada siempre**, `aria-describedby` y botón
`onReintentar` obligatorio cuando el control queda inhabilitado. **Regla 3: no se inventa un patrón
que el kit ya resuelve.**

Añade además lo que el AC2 necesita de verdad: un `<select required>` **nativo y enfocable**. El
`required` de `FlitOrganismoCombobox` es un `<input required>` de 0×0 con `opacity-0` y
`tabIndex={-1}` (`FlitOrganismoCombobox.tsx:151-161`) — un mecanismo que ni se puede enfocar de forma
fiable ni se puede afirmar en un test. Calcarlo sería calcar la parte mala del patrón.

**Delta necesario en el kit:** `FlitSelect` gana **un** prop aditivo, `required?: boolean`, que baja
tal cual al `<select>`. Sus 5 usos actuales (`FlitoConciliacion`, `BarraFiltrosBandeja`,
`DialogoDescartar`, `CargarBoletaModal`, `BarraFiltrosComparendos`) no lo pasan y quedan idénticos.

> **Pregunta única al PO / tech-lead, y es la que puede cambiar esta decisión:** ¿cuántas compañías
> hay en producción? Un `<select>` nativo se lee bien hasta ~40 opciones. Por encima de eso hace
> falta buscador y entonces sí toca un `FlitCompaniaCombobox` local calcado del de organismos —
> **con las piezas 1-5 idénticas y el `required` resuelto con un `<select>` oculto real, no con el
> input de 0×0**. Mientras nadie responda, se implementa `FlitSelect`.
>
> **Descartado en firme:** generalizar `FlitOrganismoCombobox` con un prop de opciones. Lo usan
> `TransitoBandeja`, `BolsaAcciones` y este mismo formulario; abrirlo para un caso mueve tres
> pantallas por una.

### 1.3 Wireframe del formulario (lo único que cambia)

```
┌─ Nuevo usuario ───────────────────────────────────────────┐
│ Username (login)   [___________________________]          │
│ Nombre completo    [___________________________]          │
│ Email (opcional)   [___________________________]          │
│ Contraseña         [___________________________]          │
│ Rol base           [ Cliente                  ▾]          │
│   Define los permisos por defecto. Puede ampliar…         │
│                                                            │
│ Compañía                                    ← APARECE      │
│                    [ Seleccione compañía…     ▾]           │
│   Define de qué compañía es este usuario: solo verá y     │
│   solicitará el SOAT de esa compañía.                     │
│                                                            │
│ Permisos individuales  [ SOAT ✔ ROL ] …                   │
│                                  [Cancelar] [Crear usuario]│
└────────────────────────────────────────────────────────────┘
```

El campo va **inmediatamente debajo de «Rol base»**, exactamente donde va hoy el de tránsito. No se
reordena nada más.

### 1.4 Copy exacto — Superficie 1

| Elemento | Texto |
|---|---|
| Etiqueta del rol (`ROLE_LABELS.cliente`) | **Cliente** |
| Etiqueta del campo | **Compañía** |
| Opción vacía inicial | **Seleccione compañía…** *(`valor: ''`)* |
| Ayuda bajo el campo | **Define de qué compañía es este usuario: solo verá y solicitará el SOAT de esa compañía.** |
| Rechazo en cliente (AC2) | **Selecciona la compañía del usuario Cliente.** |
| Rechazo del servidor (AC2, mensaje del backend) | **Compañía requerida para el rol Cliente** |
| Rechazo inverso del servidor | **Solo los usuarios Cliente pueden tener compañía asignada** |
| Tras cambiar la compañía | **El usuario debe volver a iniciar sesión para aplicar la nueva compañía.** |

> ⚠ **El toast del servidor NO se lee limpio, y hay que saberlo antes de escribir el test.**
> `ApiError.toUserMessage()` (`lib/api.ts:112-119`) antepone el nombre del campo cuando el 400 trae
> `details.fieldErrors`. Lo que el admin ve literalmente es
> **`companiaId: Compañía requerida para el rol Cliente`**. Es el comportamiento que ya tiene
> `transitoCodigo` y **no se arregla en esta HU** (tocaría el formateador de errores de todo el
> producto). Se declara aquí para que (a) el aserto de QA use `toContainText` y no igualdad, y
> (b) nadie lo reporte como bug de la #11913.
>
> Por eso el AC2 **no puede depender solo del servidor**: el mensaje comprobable, en español y con
> foco es el del cliente.

### 1.5 Los 4 estados — **del campo Compañía**, que es la única superficie con datos nueva

La lista sale de `GET /flito/parametrizacion/companias`, que `Users.tsx` pide **una vez al montar la
página** (no por formulario) y reutiliza para el selector y para la celda del §1.6.

| Estado | Qué se ve | Copy | Submit |
|---|---|---|---|
| **1 · Cargando** | `<select disabled>` con la opción vacía; mensaje en la región `role="status"` | **«Cargando compañías…»** | Bloqueado (valor `''` + `required`) |
| **2 · Error** | `<select disabled>`, mensaje en `--flit-danger-ink` (`fallo`) **y botón de reintento** | **«No se pudieron cargar las compañías.»** · botón: **«Volver a cargar compañías»** | Bloqueado |
| **3 · Vacío** | `<select disabled>`, mensaje neutro, **sin** botón de reintento (reintentar no crea compañías) | **«No hay compañías registradas. Crea una en Clientes y proveedores antes de crear un usuario Cliente.»** | Bloqueado |
| **4 · Lleno** | `<select>` habilitado: opción vacía + una opción por compañía, ordenadas por nombre (el endpoint ya lo hace) | Ayuda del §1.4 | Permitido con una compañía elegida |

El botón de reintento del estado 2 **no es opcional**: `FlitSelect` lo documenta como obligatorio
para todo selector que pueda quedar inhabilitado, porque un `<select disabled>` no recibe foco y su
`aria-describedby` queda inalcanzable por teclado. El botón es la única salida del callejón.

### 1.6 La tabla de usuarios: **la columna «Organismo STT» se renombra, no se añade una**

Hoy la fila de un `cliente` mostraría `—` en «Organismo STT» y el admin no podría saber a qué
compañía pertenece sin abrir «Editar» — justo el dato que el AC2 vuelve obligatorio.

**Decisión:** el encabezado pasa a **«Organismo / Compañía»** y la celda —que **ya** ramifica por rol
(`Users.tsx:126-141`)— gana una rama:

```
u.role === 'transito' → ciudad del organismo | «Sin asignar» (naranja)
u.role === 'cliente'  → nombre de la compañía | «Sin asignar» (naranja)   ← nuevo
resto                 → «—»
```

El nombre sale del mapa `id → nombre` que la página ya cargó; si la carga falló o el id no está en
el mapa, la celda muestra el id en `font-mono` — exactamente lo que hace hoy la rama de tránsito
cuando el código no está en el catálogo (`Users.tsx:133`).

**Descarte:** una columna nueva. Serían 8 columnas, y estaría vacía para 10 de los 12 roles. La celda
que ya existe para «el ámbito al que está atado este usuario» es esta.

**Requerimiento al backend (mínimo):** `userSelect` (`users.routes.ts:91-101`) debe devolver
`companiaId`. **No** hace falta `companiaNombre`: el front ya tiene el catálogo.

---

## 2. Superficie 2 — `Clients.tsx`: la columna «SOAT sin trámite»

### 2.1 Qué cambia, exactamente

`CeldaFlag` **sí admite un flag más**: es genérico sobre el union `FlagCampo` (`Clients.tsx:57`) y
`toggleFlag` manda `{ [campo]: valor }` al `PATCH` (`Clients.tsx:131`). El cambio en el front son
cuatro líneas:

1. `FlagCampo` gana `| 'soatSinTramite'`.
2. `interface Client` gana `soatSinTramite: boolean`.
3. Un `<FlitTh center>SOAT sin trámite</FlitTh>` **al final del bloque de flags**, entre «Parcial» y
   «Facturación».
4. `<CeldaFlag c={c} campo="soatSinTramite" label="SOAT sin trámite" aria={…} />` en la misma
   posición.

> ⚠ **El `aria` explícito es obligatorio, no un detalle.** El nombre accesible por defecto de
> `CeldaFlag` es `` `Autogestión ${label} de ${c.name}` `` (`Clients.tsx:145`). Con el label nuevo
> saldría **«Autogestión SOAT sin trámite de Transportes X»** — una frase que afirma justo lo
> contrario de lo que la casilla significa, y que además la confunde con la casilla de al lado. Se
> pasa `aria` como ya se hace con «Parcial» (`Clients.tsx:206`):
> **`aria={`SOAT sin trámite de ${c.name}`}`**.

**Conteo que QA va a medir:** la tabla de clientes pasa de **11 a 12** `columnheader`.

### 2.2 El orden de las columnas y por qué esta va la última de los flags

```
… Email │ SOAT │ Impuestos │ Logística │ Parcial │ SOAT sin trámite │ Facturación │ (acciones)
          └────── autogestión ──────┘   └ CA-08 ┘  └─── esta HU ───┘
```

Va **después** de «Parcial» y no pegada a «SOAT». Pegarla a «SOAT» las haría leerse como dos
variantes del mismo interruptor —que es exactamente el malentendido que el AC3 quiere evitar— y
además rompería la contigüidad de los tres flags de autogestión. Al final del bloque, separada, se
lee como lo que es: otra cosa.

**Descartado:** una columna con dos casillas, un tri-estado o un chip de énfasis. `CeldaFlag` es el
patrón y no admite matices; inventar énfasis aquí es regla 3.

### 2.3 Copy exacto — Superficie 2

| Elemento | Texto |
|---|---|
| Encabezado | **SOAT sin trámite** |
| Nombre accesible de la casilla | **SOAT sin trámite de {nombre de la compañía}** |
| Nota al pie *(se AÑADE un párrafo; el existente no se toca)* | **«SOAT» marca que la compañía compra su SOAT por su cuenta y FLITO no lo gestiona. «SOAT sin trámite» dice otra cosa: que sus usuarios Cliente pueden pedirle un SOAT a FLITO sin que haya un trámite abierto. Son independientes — marcar una no cambia la otra.** |

Ese párrafo es lo que hace el AC3 comprensible sin leer la HU, y va bajo la condición
`{editaAutogestion && …}` que ya envuelve la nota de al lado: quien no puede tocar los flags no
necesita que se le explique la diferencia entre dos casillas que ve grises.

### 2.4 Los 4 estados — y la deuda que esta HU **debería** pagar

Estado real hoy de `TabClientes` (`Clients.tsx:99`):

```ts
const load = () => { api.get<Client[]>('/clients').then(setClients).catch(() => setClients([])); };
```

`clients` arranca en `[]`, así que **no hay estado de carga**, y el `catch` **convierte el error en
vacío**: un fallo del servidor se ve idéntico a «no hay clientes». Tres de los cuatro estados están
colapsados en uno.

| Estado | Hoy | Qué se especifica |
|---|---|---|
| **1 · Cargando** | No existe: se pinta `FlitEmpty` «No hay clientes.» durante el vuelo | `clients: Client[] \| null`; con `null` → **«Cargando compañías…»**, mismo tratamiento que `TabProveedores` (`Clients.tsx:409`) |
| **2 · Error** | No existe: se ve «No hay clientes.» | `FlitCard` con el mensaje del servidor en rojo **y botón «Reintentar»**, calcado de `TabProveedores` (`Clients.tsx:408`) más el reintento |
| **3 · Vacío** | `FlitEmpty` «No hay clientes.» | **Sin cambios.** El texto sigue siendo verdad |
| **4 · Lleno** | Tabla de 11 columnas | Tabla de **12**, con la casilla nueva apagada por defecto |

> **Esto es deuda preexistente y aquí sí se recomienda pagarla** (~6 líneas), a diferencia del
> criterio que la HU #11905 aplicó a la cola SOAT. El motivo no es purismo: **el AC3 se verifica
> sobre esta tabla**. «Activar el flag persiste» se comprueba recargando y mirando la casilla; si la
> recarga falla y la pantalla dice «No hay clientes.», el admin no distingue *«se perdió lo que
> marqué»* de *«no cargó»*. Un flag que decide si un cliente puede o no pedir SOAT no puede vivir en
> una tabla que miente cuando falla.
>
> Si el tech-lead prefiere no ampliar el diff, el fallback aceptable es **solo el estado 2** (error
> distinguible del vacío). El estado 1 puede esperar.

### 2.5 Comportamiento del toggle (sin cambios, se hereda)

Optimista: la casilla cambia al instante, y si el `PATCH` falla se revierte y sale un `toast.error`
con el mensaje del servidor (`Clients.tsx:127-136`). **No hay estado ocupado por casilla** y no se
añade. Para `financiera` y `auditor` la casilla nace `disabled` como las otras cuatro
(`editaAutogestion = puedeOperar(role)` = solo `admin`).

**La independencia del AC3 es por construcción y hay que decirlo en el PR:** el `PATCH` manda **una
sola clave** y `actualizarCompaniaSchema` (`flito-parametrizacion.routes.ts:67-74`) copia al `set`
únicamente las claves `!== undefined`. Tocar un flag no puede escribir el otro salvo que alguien
introduzca lógica cruzada a propósito. El aserto de QA existe para matar a ese alguien.

---

## 3. Superficie 3 — el menú y las rutas: **cuatro trampas**, no una

El AC1 («solo SOAT en `/flito/soat`») y el AC4 («no cae en el legado») **no se cumplen** añadiendo la
fila `cliente: ['soat']` a `ROLE_DEFAULT_PAGES`. Verificado contra el código, pasa esto:

### 3.1 Trampa A — con `['soat']` el menú del Cliente sale **vacío**

`NAV_ITEMS` restringe la entrada de SOAT **dos veces**: por slug y por rol.

```ts
{ page: 'soat', to: '/flito/soat', …, roles: ['proveedor', 'admin'], … }   // navItems.ts:81
```

`navItemPermitido` exige `allowed.has(page) && roles.includes(user.role)` (`navItems.ts:52`). Sin
tocar ese array, el Cliente tiene el permiso y **no ve la entrada**: menú vacío, AC1 rojo.

**Arreglo:** `roles: ['proveedor', 'admin', 'cliente']`. La `CommandPalette` usa el mismo helper
(`CommandPalette.tsx:39`), así que hereda el arreglo sin tocarla.

### 3.2 Trampa B — el Cliente ve **«Ayuda FLITO»**, y son dos ítems, no uno

`flito_ayuda` no se filtra por slug sino por `puedeVerAyudaFlito`: basta con tener **≥1 ficha** del
catálogo. La ficha `soat` está atada a `permiso: 'soat'` (`content/ayuda/catalogo.ts:58`), así que el
Cliente la tiene → le aparece «Ayuda FLITO» en la sección General. **Dos entradas en el menú
incumplen el AC1**, y la ficha que se le ofrece describe *«Cola de pólizas del proveedor»*: una
pantalla que él no usa.

**Arreglo (una línea, con precedente literal):** en `puedeVerEntradaAyuda` (`lib/ayudaFlito.ts:10`),
junto al caso especial que ya existe para `siigo_credenciales`:

```ts
if (user.role === 'cliente') return false;
```

Cae el ítem de menú, cae la entrada de la ⌘K y el gate de `/flito/ayuda` responde `NoAccess` — los
tres pasan por el mismo helper. La #11914 decidirá si el Cliente merece ficha propia.

### 3.3 Trampa C — el Cliente aterriza en un **callejón sin salida**, y es la peor

Encadenado, verificado:

1. `Login.tsx:98` navega a `consumeRedirectPath()`, cuyo **valor por defecto es `/`**
   (`lib/api.ts:91`).
2. `/` es `<ProtectedRoute page="dashboard">` (`App.tsx:164`). El Cliente **no tiene** `dashboard`
   (el AC1 lo prohíbe) → `NoAccess`.
3. `NoAccess` ofrece **una sola salida: un `<Link to="/">` que dice «Volver al tablero»**
   (`NoAccess.tsx:60-65`) → vuelve a `/` → `NoAccess`. **Bucle.**
4. Y el comodín `<Route path="*" element={<Navigate to="/" />} />` (`App.tsx:265`) mete en ese mismo
   bucle cualquier URL que el Cliente escriba mal.

Es decir: **el Cliente inicia sesión y lo primero que ve es «No tienes acceso a Tablero de
control»**, con un botón que no lo saca de ahí. Todos los demás roles tienen `dashboard`, por eso
nadie se lo ha encontrado.

**Arreglo — un helper y dos usos, nada más:**

```ts
// lib/permissions.ts
export function rutaInicio(user): string        // '/flito/soat' si el rol es cliente; '/' si no
```

- **`App.tsx`, ruta `/`:** un `InicioGate` que, **si el usuario no tiene `dashboard`**, hace
  `<Navigate to={rutaInicio(user)} replace />`; si lo tiene, pinta `<Dashboard />` como hoy. Como
  todos los demás roles tienen `dashboard`, **su comportamiento no cambia ni un píxel** — y eso es lo
  que hace seguro el cambio. El login y el comodín `*` heredan el arreglo sin tocarlos: los dos
  pasan por `/`.
- **`NoAccess.tsx`:** el enlace apunta a `rutaInicio(user)`. Si el usuario tiene `dashboard`, sigue
  diciendo **«Volver al tablero»** (cero regresión); si no, dice **«Ir a SOAT»** — derivado de
  `PAGES[slug]`, no escrito a mano.

### 3.4 Trampa D — `/soat` legado: qué ve el Cliente (AC4)

El slug `soat` sirve a **dos** rutas con el mismo gate:

```tsx
<Route path="/soat"       element={<ProtectedRoute page="soat"><Soat /></ProtectedRoute>} />        // App.tsx:167
<Route path="/flito/soat" element={<ProtectedRoute page="soat"><FlitoSoat /></ProtectedRoute>} />   // App.tsx:173
```

**El gate de ruta NO distingue las dos.** Un Cliente que escriba `/soat` **entra** al legado
`Soat.tsx`.

*Lo que no pasa:* no hay fuga de PII. `GET /soat` es `requireRole('admin','proveedor')`
(`soat.routes.ts:149`) → 403, y los `ownerName` / `ownerDocument` que esa pantalla pinta nunca
llegan. **Lo que sí pasa:** el Cliente ve el armazón de una pantalla operativa ajena con un toast de
error. AC4 rojo por lo que se ve, no por lo que se filtra.

**Decisión — redirección, no `NoAccess`:**

```tsx
<Route path="/soat" element={<ProtectedRoute page="soat">{ esCliente ? <Navigate to="/flito/soat" replace /> : <Soat /> }</ProtectedRoute>} />
```

**Qué ve el Cliente:** su propia pantalla de SOAT, sin mensaje de error, con la URL ya corregida a
`/flito/soat` (`replace`, para que «atrás» no lo devuelva al legado).

**Descarte, y es el que la HU insinúa:** `NoAccess`. Diría **«No tienes acceso a SOAT»**
—porque `PAGES.soat` es literalmente `'SOAT'`— mientras «SOAT» es lo **único** que hay en su menú.
Es una frase falsa sobre sus permisos, y no hay manera de arreglar el texto sin partir el slug en
dos, que es alcance de arquitectura y no de esta HU.

**Y para todo lo demás** (`/clients`, `/users`, `/flito/impuestos`…): el Cliente ve el `NoAccess`
estándar —**«No tienes acceso a {página}»** + *«Tu rol actual no incluye esta sección. Si crees que
deberías tener acceso, pídele a un administrador que la habilite.»*— con el botón ya arreglado por
§3.3, que ahora dice **«Ir a SOAT»**. Ese es el comportamiento que el shell ya tiene con cualquier
rol sin la página; lo único que faltaba era la salida.

### 3.5 Lo que el Cliente ve al llegar a `/flito/soat` — **el hueco que deja esta HU**

Con el eslabón 1 solo, el AC1 se cumple hasta la puerta y falla al cruzarla: `/flito/soat` monta
`FlitoSoat.tsx`, la cola de adquisición de Operaciones, y **`GET /flito/soat` es
`requireRole('admin','proveedor','auditor')`** (`flito-soat.routes.ts:41`) → 403. El Cliente ve la
cabecera, los filtros y una banda roja. La única entrada de su menú lleva a una pantalla rota.

**Recomendación:** `FlitoSoat.tsx` ramifica **una vez, arriba del todo**, y para `role === 'cliente'`
pinta un `FlitCard` de un solo estado, sin llamadas al API:

> **«Solicitud de SOAT»**
> **«Desde aquí vas a poder pedirle a FLIT el SOAT de tus vehículos. Estamos terminando esta
> pantalla; te avisamos en cuanto esté disponible.»**

Cuesta ~8 líneas, evita el 403, evita que un rol externo vea el armazón de una pantalla interna, y
la #11914 sustituye el cuerpo de esa rama por el formulario sin mover el andamiaje.

> **Requiere el sí del tech-lead/PO**: es alcance que el AC1 no pide con estas palabras. La
> alternativa —dejarlo como está y acotar el AC1 al **menú**— es defendible, pero entonces hay que
> escribirlo en el PR: *«el AC1 se verifica sobre la navegación; la pantalla de destino llega en la
> #11914»*. Lo que no vale es cerrar la HU diciendo que el Cliente «ve SOAT» cuando lo que ve es un
> error 403.

### 3.6 Lo que el Cliente ve — resumen para QA

```
┌─────────────────────────────────────────────────────────────┐
│  ☰ FLITO                                          usuario ▾ │
├──────────────┬──────────────────────────────────────────────┤
│ GESTIÓN      │                                              │
│  › SOAT      │      (contenido de /flito/soat)              │
│              │                                              │
│  ← y NADA    │                                              │
│    más:      │                                              │
│    sin       │                                              │
│    Tablero,  │                                              │
│    sin Ayuda │                                              │
│    FLITO,    │                                              │
│    sin       │                                              │
│    Clientes, │                                              │
│    sin       │                                              │
│    Usuarios  │                                              │
└──────────────┴──────────────────────────────────────────────┘
```

`useNavSections` elimina solas las secciones vacías (`useNavSections.ts:39-43`): al Cliente le queda
**un** grupo, «Gestión», con **un** ítem.

---

## 4. Accesibilidad — solo lo que se añade

**Selector de compañía**
- Etiqueta **asociada por `htmlFor`/`id`**, que `FlitSelect` ya hace. No se usa el envoltorio
  `<Field>` de `Users.tsx`, que asocia un `<label>` a un control que a veces no es etiquetable.
- Los tres mensajes (cargando / error / vacío) viven en la **misma región `role="status"` montada
  siempre**; solo cambia el texto. Una región que aparece ya rellena no dispara anuncio en varios
  lectores.
- Error de carga → `role="status"`, **no** `role="alert"`: no interrumpe. Error de **validación**
  (AC2) → sí interrumpe, ver abajo.
- `<select disabled>` no recibe foco: por eso el **botón «Volver a cargar compañías» es la parada de
  tabulador que salva el estado 2**. No se elimina «porque el mensaje ya se lee».

**Foco tras el error del AC2**
- Al rechazar el envío: `preventDefault`, se pinta el mensaje **«Selecciona la compañía del usuario
  Cliente.»** en un `<p role="alert">` bajo el campo, el `<select>` recibe `aria-invalid="true"` y
  `aria-describedby` apuntando a ese `<p>`, y **el foco se mueve al `<select>`**.
- El foco al control y no al mensaje: es donde se corrige el problema, y al enfocarlo el lector
  anuncia etiqueta + estado inválido + descripción de una vez.
- El mensaje se limpia en cuanto se elige una compañía.

**Casilla «SOAT sin trámite»**
- Es un `<input type="checkbox">` nativo: marcado/desmarcado lo anuncia el propio rol. Lo único que
  hay que acertar es el **nombre accesible**, y por eso el `aria` explícito del §2.1 no es opcional.
- La reversión optimista solo se anuncia por el toast (`react-hot-toast` monta `role="status"`).
  **No** se añade `aria-live` propio a la celda: dos regiones vivas anunciando el mismo cambio se
  leen dos veces.
- **Prohibido meter el NIT en el `aria-label`** de la casilla o de la opción del selector: los
  selectores de axe arrastran valores de atributo hasta 31 caracteres y acabarían en el informe de
  a11y. El nombre de la compañía basta para distinguir la fila.

**General**
- Cero paradas de tabulador nuevas en la tabla de clientes: una casilla más por fila, del mismo tipo
  que las cuatro que ya hay.
- Cero tokens nuevos: `--flit-danger-ink`, `--flit-text-secondary` y `--flit-warning` ya están en uso
  en estas dos pantallas. `npm run check:contraste` **no acredita nada de esto** (su alcance real es
  la ⌘K y los gradientes); el argumento es que los tokens ya se usan aquí, no el gate.
- axe: recordar `QA_AXE_CDN=1` o salen ~10 rojos que no son regresión de nada.

---

## 5. PII y permisos — lo que hay que mirar antes del PR

1. **El selector NO usa `GET /clients`.** Ese endpoint devuelve 26 columnas con teléfono, correo y
   dirección de cada compañía. Se usa `GET /flito/parametrizacion/companias`, que devuelve
   `{id, nombre, nit, flags…}` y nada más. Es la lista mínima para el trabajo.
2. **El NIT en la opción: se puede, con un límite.** `companiaDto` expone `nit: c.document`, y
   `clients.document` puede contener la **cédula de una persona natural**. Si se pinta para
   desambiguar homónimas, va **solo en el texto de la opción** —nunca en el `aria-label`, nunca en la
   URL, nunca en un `data-*`—. Si el PO no necesita desambiguar, se pinta **solo el nombre**: es la
   opción por defecto de este documento.
3. **Nada entra en la query del SPA.** Ni `companiaId` ni el NIT viajan por la URL en ninguna de las
   tres superficies (`AGENTS.md` §14).
4. **`cliente` no se añade a ningún `requireRole` de esta HU.** Su única página es `soat`, y los dos
   routers de SOAT ya lo excluyen. Ampliar eso es la #11914.

---

## 6. Notas para QA (10) — cada una con el mutante que debe matar

1. **AC1 — el menú, contado y luego nombrado.** Con sesión `cliente`:
   `expect(nav.getByRole('link')).toHaveCount(1)` y **después**
   `expect(nav.getByRole('link', { name: 'SOAT' })).toHaveVisibleText…` con `href="/flito/soat"`.
   *Mutante:* quitar `'cliente'` de `roles` en `navItems.ts:81` → el conteo cae a 0 (o a 1 si sigue
   colada la Ayuda). **Sin el conteo previo, el aserto de presencia pasa también con «Ayuda FLITO»
   al lado**: es el falso verde más barato de esta HU.
2. **AC1 — las ausencias, una por una y por nombre.** `Tablero`, `Ayuda FLITO`, `Usuarios`,
   `Clientes y proveedores` → `toHaveCount(0)` en la nav **y** en la ⌘K.
   *Mutante:* dar `dashboard` a la fila `cliente` «para que tenga inicio» — es la reparación
   equivocada de la trampa C y este aserto la mata.
3. **AC1 — el aterrizaje, que es lo que la trampa C rompe.** Login como `cliente` sin ruta previa →
   `await expect(page).toHaveURL(/\/flito\/soat$/)`. *Mutante:* revertir `InicioGate` → la URL se
   queda en `/` y la pantalla dice «No tienes acceso a Tablero de control».
4. **AC4 — `/soat` no llega al legado, medido por contenido y no solo por URL.** Ir a `/soat` →
   URL `/flito/soat` **y** `expect(page.getByText('Verificar RUNT')).toHaveCount(0)` (o cualquier
   cadena exclusiva de `Soat.tsx`). *Mutante:* dejar la ruta como está — la URL sola no lo detecta si
   alguien «arregla» el problema pintando el legado bajo la ruta nueva.
5. **AC4 — el callejón, en las dos direcciones.** Ir a `/users` → `NoAccess`; el enlace de salida
   dice **«Ir a SOAT»** y lleva a `/flito/soat`. Repetir con una URL inexistente (`/no-existe`), que
   pasa por el comodín `*`. *Mutante:* dejar `<Link to="/">` fijo → el botón vuelve al bucle.
6. **AC2 — el rechazo se ve, y se ve donde el usuario mira.** Rol Cliente + compañía sin elegir +
   «Crear usuario»: `expect(getByRole('alert')).toHaveText('Selecciona la compañía del usuario Cliente.')`,
   `expect(select).toBeFocused()` y **`expect(peticionPOST).not.toHaveBeenCalled()`**.
   *Mutante:* quitar el `preventDefault` y confiar solo en el 400 del servidor — el tercer aserto es
   el único que lo mata.
7. **AC2 — la puerta del servidor también, por si alguien salta el front.** `POST /users` con
   `role:'cliente'` sin `companiaId` → 400. Y el inverso: `role:'proveedor'` **con** `companiaId` →
   400. *Mutante:* validar solo un sentido, que es como se cuela un ex-Cliente con compañía pegada.
8. **AC3 — la independencia, en los cuatro cruces, y no en dos.** Encender «SOAT sin trámite» →
   recargar → sigue encendida **y** «SOAT» sigue como estaba. Después: encender «SOAT» → «SOAT sin
   trámite» no se mueve. Luego apagar cada una y repetir. *Mutante:* un `if` cruzado en `toggleFlag`
   o en el servicio; probar solo el sentido A→B lo deja vivo.
9. **AC3 — la compañía nueva nace apagada, comprobado en la fila recién creada.** Crear cliente por
   la UI y afirmar `not.toBeChecked()` en la casilla de esa fila, localizada **por el `aria-label`
   con el nombre de la compañía**, no por índice de columna. *Mutante:* `default true` en la
   migración; y localizar por índice deja pasar además cualquier reordenación de columnas.
10. **La casilla se llama como debe.** `expect(getByLabel('SOAT sin trámite de Transportes X')).toBeVisible()`
    y `expect(getByLabel(/Autogestión SOAT sin trámite/)).toHaveCount(0)`. *Mutante:* olvidar el prop
    `aria` y quedarse con el nombre por defecto — el aserto positivo solo, sin el negativo, pasa por
    `toBeVisible` en algunos matchers laxos.

> **Recordatorio de infraestructura:** el CI **solo corre un spec E2E** (el visor de PDF). Cualquier
> spec que se escriba aquí hay que **añadirlo a la lista fija del nocturno** y, aun así, correrlo a
> mano antes de cerrar: verde en el PR no significa que nadie lo haya ejecutado.
>
> **El fixture del rol:** `e2e/helpers/auth.ts` tiene un usuario por rol (`ADMIN_USER`,
> `PROVEEDOR_USER`, …). Hace falta un `CLIENTE_USER` **con `companiaId`**; sin ese campo, media
> pantalla de la #11914 se probará contra un Cliente que no existe en producción.

---

## 7. Lo que el compilador va a exigir (para que no sorprenda a mitad del PR)

Añadir `'cliente'` a `USER_ROLES` rompe **dos `Record<UserRole, …>` exhaustivos**, y eso es bueno:
son los dos sitios que había que tocar y TypeScript los señala solo.

| Archivo | Qué falta | Valor |
|---|---|---|
| `packages/shared-types/src/permissions.ts` | `ROLE_LABELS.cliente` | `'Cliente'` |
| `packages/shared-types/src/permissions.ts` | fila en `ROLE_DEFAULT_PAGES` | `cliente: ['soat']` — **y nada más**; `dashboard` NO |
| `apps/web/src/pages/Users.tsx:29` | `ROLE_TONE.cliente` | `'neutral'` |

`ROLE_TONE` en **neutral**, como `proveedor`, `conductor` y `gestor_impuestos`: el gris es el tono de
«perfil acotado, sin autoridad». `active` (azul) y `success` (verde) están reservados a perfiles
internos con mando, y el Cliente es el primer rol **externo a FLIT** del sistema.

`ALL_ROLES = USER_ROLES`, así que el rol queda asignable en el formulario sin tocar nada más
(`Users.tsx:26` deriva la lista) y `z.enum(ALL_ROLES)` lo acepta en el API.

Revisar además `apps/api/__tests__/services/permissions.authz.test.ts`: es el test de paridad
API↔web sobre estas tablas y va a exigir la fila nueva en los dos lados.

---

## 8. Decisiones y descartes (resumen citable en el PR)

| # | Decisión | Descarte principal |
|---|---|---|
| 1 | El selector de compañía es **`FlitSelect`** (kit, 4 estados + reintento + `role="status"`) con un prop `required` aditivo | Calcar `FlitOrganismoCombobox`, cuyo `required` es un input de 0×0 que no se puede afirmar. Y generalizarlo con opciones: lo usan tres pantallas |
| 2 | Del patrón `transitoCodigo` se calcan **las cinco piezas** (campo condicionado, reset al cambiar rol, borrado al salir del rol, validación en ambos sentidos, invalidación de sesión) | Calcar solo el desplegable y dejar el mecanismo a medias |
| 3 | «Organismo STT» se **renombra** a «Organismo / Compañía» y su celda gana una rama | Una columna nueva, vacía para 10 de 12 roles |
| 4 | «SOAT sin trámite» va **al final del bloque de flags**, tras «Parcial» | Pegarla a «SOAT», que es exactamente el malentendido que el AC3 quiere evitar |
| 5 | `CeldaFlag` con **`aria` explícito**; el nombre por defecto afirmaría lo contrario | Confiar en el `aria-label` por defecto de la celda |
| 6 | `/soat` para el Cliente **redirige** a `/flito/soat` con `replace` | `NoAccess`, que diría «No tienes acceso a SOAT» siendo SOAT lo único de su menú |
| 7 | `rutaInicio(user)` en **un** helper, consumido por la ruta `/` y por `NoAccess`; login y comodín `*` lo heredan | Parchear el `NoAccess` a mano, o dar `dashboard` al Cliente para que `/` funcione |
| 8 | «Ayuda FLITO» se apaga para `cliente` en `puedeVerEntradaAyuda`, con el precedente de `siigo_credenciales` | Dejarla: son dos ítems en un menú que el AC1 limita a uno, y la ficha habla de la cola del proveedor |
| 9 | `TabClientes` gana estado de **error distinguible del vacío** (y de carga, si cabe) | Dejar que un fallo se lea «No hay clientes.» en la pantalla donde se verifica el AC3 |
| 10 | `/flito/soat` pinta un **placeholder** para `cliente` en vez de 403 — *pendiente del sí del PO* | Cerrar la HU diciendo que el Cliente «ve SOAT» cuando lo que ve es una banda roja |
