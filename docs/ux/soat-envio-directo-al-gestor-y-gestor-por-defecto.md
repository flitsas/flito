# UX slim — Gestor por defecto, envío directo al gestor y retirada de la revisión (HU #12079, Feature #12074)

> **Qué es este documento.** La entrada del `frontend-agent` que implemente la HU #12079. Modo
> **slim**: no hay ruta nueva ni `PageSlug` nuevo. Se especifica **solo el delta** de tres
> superficies que ya existen, **dos públicos distintos** —Operaciones en la ficha de la compañía y
> la cola; el Cliente en el formulario—, y las trampas que el AC no nombra.
>
> **Fuera de alcance, escrito para que nadie lo amplíe de paso:** no se toca el resto de
> `Clients.tsx` (tarifas, ficha fiscal, las otras cuatro casillas, pestaña de proveedores); no se
> reordenan los bloques del formulario del Cliente (eso es la HU #12083, orden 5); no se toca la
> consulta al RUNT ni la ficha (HU #12082/#12083); no se rediseña la cola de SOAT más allá de lo que
> la retirada obliga; no se crea ni se modifica nada en `components/flit/`.

---

## Superficies tocadas

| | |
|---|---|
| **S1 · Ficha de la compañía** | `apps/web/src/pages/Clients.tsx` → `TabClientes`. Público **Operaciones** (`admin`; `financiera` y `auditor` la ven en solo lectura). La casilla «SOAT sin trámite» y el gestor por defecto pasan a decidirse juntos |
| **S2 · Formulario de solicitud** | `apps/web/src/pages/FlitoSoatSolicitud.tsx` → `Alta`, tarjeta de envío (:531-579). Público **Cliente**, compañía externa |
| **S3 · Cola de SOAT** | `apps/web/src/pages/FlitoSoat.tsx` + los cuatro componentes que se borran. Públicos **Operaciones y gestor**; el Cliente comparte la cola |
| Slug / permiso | **Ninguno nuevo.** S1 sigue bajo `clients`; S2 y S3 bajo `flito_soat`. Ningún `requireRole` cambia |
| Endpoints | `GET /flito/parametrizacion/proveedores-soat` (ya existe, `admin`+`auditor`) para el selector. **Dos requerimientos** sobre endpoints existentes, §1.7. Cero endpoints nuevos |
| PII | Ninguna nueva. El nombre comercial de una aseguradora no es dato personal. La enumeración del §2.2 nombra **etiquetas de campo, nunca valores** |
| Densidad | S1 **sin cambio** (12 columnas antes y después). S2 **aliviada** (el botón deja de callarse). S3 **aliviada** (dos pastillas menos, un bloque menos en el detalle) |

---

## Oficio, respondido antes de dibujar

| Pregunta | S1 · Ficha compañía | S2 · Formulario Cliente | S3 · Cola |
|---|---|---|---|
| **¿Qué vino a hacer?** | Abrir o cerrar el canal de una compañía y decir a dónde salen sus solicitudes | Radicar el SOAT de un vehículo: consultar, completar, enviar | Trabajar la cola: cargar facturas, despachar, resolver novedades |
| **¿Qué se ve primero?** | La fila de la compañía y si su canal está **Abierto** o **Cerrado**, con su gestor | Los tres bloques y el botón de envío con **qué le falta** | Las pastillas de estado y la tabla |
| **¿Qué se calla?** | El catálogo de gestores, el estado de cada uno, la advertencia del cambio: viven en el modal, a un clic | Nada nuevo se añade a la pantalla; se retira una frase falsa | Se retira el bloque de revisión entero |
| **¿Cuál es la única primaria?** | «Guardar» en el modal. En la página sigue siendo «Nuevo cliente» | «Enviar al gestor», la de siempre, con rótulo nuevo | Sin cambio («Cargar facturas (masivo)» / «Solicitar SOAT») |
| **¿Vacío y error dicen el siguiente paso?** | Sí, §1.6 | Sí: el botón bloqueado **es** el mensaje de qué falta | Sí, sin cambio |
| **¿Efectos o patrón nuevo?** | Un modal por fila, que es el patrón que la fila ya usa dos veces («Tarifas», «Datos fiscales»). Cero animaciones, cero tokens nuevos | Ninguno | Ninguno |

---

# 1 · Ficha de la compañía — el interruptor y su gestor

## 1.1 La decisión de arquitectura: **el par vive en un modal**, no en una columna nueva

La «ficha de la compañía» **no es un formulario**: es una **fila de una tabla de 12 columnas**, la
más saturada del producto (`Clients.tsx:207-257`). Eso condiciona todo lo demás.

**Disposición A (descartada) — 13.ª columna con un `FlitSelect` por fila, junto a la casilla.**

```
… │ Parcial │ SOAT sin trámite │ Gestor por defecto      │ Facturación │ …    ← 13 columnas
      ☑             ☑            [ SURA              ▾]      ● Sí
      ☐             ☐            [ Seleccione gestor…▾]      ● No
```

Es lo que el AC0 describe al pie de la letra, y por eso se escribe aquí por qué no se hace:

- **Un catálogo por red, replicado N veces.** `FlitSelect` monta una región `role="status"` **por
  instancia**. Con 200 compañías en la tabla —el listado de clientes se pide sin paginar, y el
  informe de facturables ya viene con `limit=500`— son 200 regiones vivas anunciando el mismo
  «Cargando proveedores SOAT…», 200 botones «Volver a cargar proveedores» y una parada de tabulador
  más por fila.
- **El orden de los dos controles se vuelve un problema irresoluble.** Sin botón de guardar, cada
  control hace su propio `PATCH` optimista: encender primero es un 400 seguro, y elegir gestor
  primero funciona. La pantalla obliga al usuario a **adivinar la secuencia correcta**, que es
  exactamente la trampa que el pedido manda evitar.
- **Densidad.** «Añadir una columna no es gratis; si la superficie ya está apretada, el dato nuevo
  va al detalle» (`_principios-flito.md`). 12 columnas es apretado.

**Disposición B (recomendada) — la celda abre un modal con los dos controles y un solo «Guardar».**

La fila ya tiene dos modales propios («Tarifas», «Datos fiscales») y el patrón está asentado en esta
misma pantalla. En el modal, el orden de los controles **deja de importar**: el par se valida y se
guarda de una vez, y ninguna combinación imposible llega a existir ni en la pantalla ni en la base.

**Divergencia con la letra del AC0, declarada para que el PO decida y nadie la descubra en el PR:**
el AC dice *«intentar encender el interruptor sin gestor deja el interruptor apagado y muestra el
motivo que devuelve el servidor»*. Con la disposición B se cumple **el efecto** (el canal no se abre,
el interruptor queda apagado, el motivo se lee) pero el mensaje que se ve primero es **el del
cliente**, no el del servidor —§1.4—, y el del servidor sigue apareciendo literal cuando la petición
sí sale y la rechaza. Los dos documentos análogos tomaron esta misma decisión por escrito
(`identidad-rol-cliente-y-soat-sin-tramite.md` §1.4, `usuarios-ambito-proveedor-y-gestor-impuestos.md`
§5.2) y el motivo es medible: `ApiError.toUserMessage()` antepone el nombre del campo cuando el 400
trae `fieldErrors`, así que lo que el admin leería literalmente sería
**`soatSinTramite: <mensaje>`**. Un mensaje con un nombre de columna delante no es «el motivo, no un
mensaje genérico»: es peor que el genérico.

## 1.2 La celda — wireframe y comportamiento

```
… │ Parcial │ SOAT sin trámite            │ Facturación │ (acciones)
      ☑        [ Abierto · SURA ]              ● Sí        [Tarifas][Datos fiscales]
      ☐        [ Cerrado ]                     ● No        [Tarifas][Datos fiscales]
      ☑        [ Abierto · SURA (inactivo) ]   ● Sí        [Tarifas][Datos fiscales]
                    ↑ en --flit-warning-ink (NO --flit-warning: ver 1.2)
```

- **Un solo control por celda**, `flitBtnSecondary` como los dos botones de la misma fila. Misma
  cuenta de paradas de tabulador que hoy (la casilla se va, el botón llega). La tabla sigue teniendo
  **12 `columnheader`**.
- **`editaAutogestion === false`** (`financiera`, `auditor`): **no hay botón**, se pinta el mismo
  texto en un `<span>`. Hoy ven una casilla gris que no dice cuál es el gestor; con esto ven el
  estado completo y no ganan una parada de tabulador inútil.
- **`(inactivo)`** va en el **texto**, y el color es refuerzo, no portador único. Es el aviso de que
  esa compañía está radicando en contingencia de Operaciones (AC2d del backend) sin que nadie se
  haya enterado.
- **El token es `--flit-warning-ink` (`#B94120`), NO `--flit-warning` (`#F05A35`).** Medido sobre la
  tarjeta blanca: `--flit-warning` da **3,38:1** e **incumple** el 4,5:1 del SC 1.4.3; el `-ink` da
  **5,47:1** y cumple. `--flit-warning` es un token de **relleno y borde** (ver `.flit-warning-bg`,
  que lo usa al 12 % de opacidad), no de texto. Este documento decía `--flit-warning` en tres sitios
  y la implementación hizo bien en no obedecerle: quien lea esto después **no** debe «arreglarlo» de
  vuelta.

> ⚠ **Trampa de accesibilidad que el `aria-label` de hoy no anticipa (WCAG 2.5.3, «Label in Name»).**
> Si el botón lleva `aria-label="Configurar SOAT sin trámite de Transportes X"` mientras su texto
> visible dice «Abierto · SURA», el nombre accesible **no contiene** el texto visible: quien maneja
> el producto por voz dice «Abierto» y no pasa nada. El nombre accesible tiene que contener el
> visible:
>
> `aria-label={`SOAT sin trámite de ${c.name}: ${textoVisible}`}` → **«SOAT sin trámite de
> Transportes X: Abierto · SURA»**.

## 1.3 El modal

```
┌─ SOAT sin trámite · Transportes X ──────────────────── ✕ ─┐
│                                                           │
│  ☑ Canal abierto                                          │
│     Sus usuarios Cliente pueden pedirle un SOAT a FLITO   │
│     sin que haya un trámite abierto.                      │
│                                                           │
│  Gestor por defecto                                       │
│  [ SURA                                                ▾] │
│     A este gestor salen las solicitudes NUEVAS del canal. │
│     Las ya radicadas conservan el gestor que tienen.      │
│                                                           │
│                              [Cancelar]     [Guardar]     │
└───────────────────────────────────────────────────────────┘
```

Rechazo del cliente (canal abierto sin gestor):

```
│  Gestor por defecto                                       │
│  [ Seleccione gestor…                                  ▾] │
│     A este gestor salen las solicitudes NUEVAS del canal… │
│  Elija el gestor por defecto antes de abrir el canal.     │   ← role="alert", foco al <select>
```

- Es un `<form onSubmit>` dentro de `FlitModal`. El `<select>` lleva `required={borrador.abierto}` y
  `onInvalido`: los dos props aditivos que `FlitSelect` ya tiene (HU #11913). Validación **nativa**,
  con el globo del navegador suprimido y el texto en español puesto por nosotros.
- **Una primaria: «Guardar»** (`GradientButton`). «Cancelar» es secundario. El botón de reintento del
  catálogo vive dentro del campo y no compite.
- **Sin `confirm` de confirmación** al cambiar el gestor: la consecuencia no es destructiva (las
  radicadas no se mueven) y la pantalla ya lo dice **antes**, en la ayuda del campo. Es la misma
  decisión, con el mismo argumento, que la HU #12053 (§5.4 de su doc).

## 1.4 Orden y dependencia de los dos controles — **la decisión pedida**

> **El interruptor NUNCA se deshabilita, y el gestor NUNCA se pide en un segundo paso. Los dos son
> un borrador local que se valida y se guarda con una sola pulsación.**

Al abrir el modal se copia lo guardado a un borrador. Dentro del modal el usuario puede encender el
interruptor con el gestor vacío: **eso no es un estado inválido, es un borrador a medias**. Lo que se
valida es **«Guardar»**:

| Borrador | Al pulsar «Guardar» |
|---|---|
| Canal **abierto** + gestor elegido | `PATCH` con **las dos claves**. Toast de éxito |
| Canal **abierto** + gestor vacío | `preventDefault` · `error` en el `FlitSelect` · **foco al `<select>`** (lo hace el propio componente) · **cero peticiones**. El interruptor del borrador **no se toca**: se queda encendido para que el usuario solo tenga que elegir el gestor y volver a guardar |
| Canal **cerrado** + gestor elegido | Válido y se guarda: apagar no obliga a quitar el gestor (AC2c) |
| Canal **cerrado** + gestor vacío | Válido y se guarda |
| El servidor rechaza igual (carrera: alguien desactivó el gestor, otra pestaña cambió la compañía) | El mensaje del servidor, **literal**, en un `<p role="alert">` sobre la botonera. El modal **no se cierra** y el borrador **no se pierde** |

**Por qué no las otras dos.** Un interruptor deshabilitado no recibe foco: quien navega con teclado
llega a la fila y el control **no existe**, sin explicación —es el mismo argumento por el que el
primario del formulario del Cliente lleva `aria-disabled` y no `disabled`—. Y «pedir el gestor al
intentar encender» es un segundo nivel de diálogo sobre un modal: la pila que ya rompió el visor de
soportes del detalle de SOAT (`FlitoSoat.tsx:910-913`).

**Ninguno de los cuatro flags restantes cambia:** siguen siendo casillas con `PATCH` optimista
inmediato. La razón de que este no lo sea se escribe en el PR: **es el único que dejó de ser un
booleano suelto para ser una decisión con un parámetro obligatorio**, y un `PATCH` por control no
puede expresar «abre el canal y manda a SURA» de una sola vez.

## 1.5 Copy exacto — S1

| Elemento | Texto |
|---|---|
| Encabezado de la columna | **SOAT sin trámite** *(sin cambio)* |
| Texto de la celda, canal abierto | **Abierto · {gestor}** |
| Texto de la celda, gestor desactivado | **Abierto · {gestor} (inactivo)** *(en `--flit-warning-ink`, 5,47:1 sobre blanco; `--flit-warning` daría 3,38:1 y no cumple el 4,5:1 — ver 1.2)* |
| Texto de la celda, canal cerrado | **Cerrado** |
| Nombre accesible del botón | **SOAT sin trámite de {compañía}: {texto de la celda}** |
| Título del modal | **SOAT sin trámite · {compañía}** |
| Etiqueta del interruptor | **Canal abierto** |
| Ayuda del interruptor | **Sus usuarios Cliente pueden pedirle un SOAT a FLITO sin que haya un trámite abierto.** |
| Etiqueta del selector | **Gestor por defecto** |
| Opción vacía | **Seleccione gestor…** *(valor `''`)* |
| Ayuda del selector | **A este gestor salen las solicitudes NUEVAS del canal. Las ya radicadas conservan el gestor que tienen.** |
| Matiz del gestor desactivado en la opción | **(inactivo)** — el `nota` de `FlitSelectOpcion` |
| Rechazo en cliente | **Elija el gestor por defecto antes de abrir el canal.** |
| Primaria del modal | **Guardar** |
| Secundaria | **Cancelar** |
| Toast tras guardar con cambio de gestor | **Gestor por defecto actualizado. Las solicitudes ya radicadas conservan el suyo.** |
| Toast tras guardar sin cambio de gestor | **Compañía actualizada.** |
| Nota al pie, párrafo existente **ampliado en una frase** | *(…tras «Son independientes — marcar una no cambia la otra.»)* **Para abrir «SOAT sin trámite» hay que decir a qué gestor salen las solicitudes de esa compañía.** |

**Tratamiento.** `Clients.tsx` es pantalla de Operaciones y su copy actual **tutea** («Marca
"Autogestiona"…»). La ayuda del interruptor y la del selector se escriben **impersonales** («Sus
usuarios Cliente pueden…», «A este gestor salen…») y el único imperativo, el del rechazo, va en
**usted** («Elija…») para no chocar con «Seleccione gestor…». No se reescribe ni una línea del copy
que ya está en la pantalla: unificar `Clients.tsx` es otra HU.

## 1.6 Los cuatro estados — del catálogo de gestores

El catálogo se pide **una vez al montar `TabClientes` y solo si `editaAutogestion`** —igual que
`FlitoSoat.tsx:281-284` ya hace con `esOperaciones`—, no al abrir cada modal. Así `financiera` no
dispara un `GET` que le responde 403.

| Estado | Qué se ve en el modal | Copy | ¿Se puede guardar? |
|---|---|---|---|
| **1 · Cargando** | `<select disabled>` con la opción vacía | **«Cargando gestores…»** | Con el canal **cerrado**, sí. Con el canal abierto, no (valor `''` + `required`) |
| **2 · Error** | `<select disabled>`, mensaje en `--flit-danger-ink` **y botón de reintento** | **«No se pudieron cargar los gestores.»** · botón **«Volver a cargar gestores»** | Igual que arriba |
| **3 · Vacío** | `<select disabled>`, mensaje neutro, **sin** botón de reintento | **«No hay gestores de SOAT activos. Cree uno en la pestaña Proveedores antes de abrir el canal de esta compañía.»** | Igual que arriba |
| **4 · Lleno** | Opción vacía + un `<option>` por gestor **activo**, ordenados por nombre (el endpoint ya ordena) | La ayuda del §1.5 | Sí |

- El vacío **nombra la pantalla exacta** («la pestaña Proveedores», que está a un clic en esta misma
  página) y no lleva reintento: volver a pedir la lista no crea gestores.
- **El gestor asignado desactivado se reinyecta.** Las opciones son *los activos* **más** el asignado
  actual si no está entre ellos, pintado con `nota: 'inactivo'`. Sin esto el `<select>` se pinta en
  blanco y **guardar cualquier otra cosa le quita el gestor a la compañía por la espalda** —el mismo
  fallo que la HU #12053 documentó para el proveedor de un usuario—.
- Los cuatro estados de la **tabla** (`clients === null` / `errorCarga` / `[]` / lleno) **no cambian**:
  la HU #11913 ya los pagó.

## 1.7 Datos — dos requerimientos sobre endpoints que ya existen

1. **`GET /clients` debe devolver el gestor por defecto resuelto**, no solo su id:
   `soatGestorPorDefecto: { id, nombre, activo } | null`. Sin `nombre` la celda no puede pintar
   «Abierto · SURA» para `financiera`/`auditor`, que **no** pueden leer el catálogo
   (`GET /flito/parametrizacion/proveedores-soat` es `admin`+`auditor`); y sin `activo` no hay forma
   de avisar del caso de contingencia del AC2d. Es un `join` sobre una tabla de cuatro filas.
2. **`PATCH /flito/parametrizacion/companias/:id` debe aceptar las dos claves en la MISMA petición y
   validar el par como un todo.** El `set` de hoy copia clave por clave lo que no sea `undefined`
   (`flito-parametrizacion.routes.ts`); si la regla de AC2c se implementa mirando solo el valor
   guardado en la base, `{ soatSinTramite: true, soatGestorPorDefectoId: 'X' }` sobre una compañía sin
   gestor daría **400 aunque el gestor viaje en el mismo cuerpo**, y la disposición B entera dejaría
   de funcionar. La regla es sobre el **estado resultante**, no sobre el previo.

→ Los dos son backend de esta misma HU (el 2 depende de cómo la HU #12078 haya escrito la validación).
Si el gate ya está implementado sobre el estado previo, **es un bug a corregir aquí**, no un límite de
diseño.

---

# 2 · Formulario del Cliente — el botón que dice qué falta

## 2.1 Delta de claridad

**Se ve primero, y es lo nuevo:** el botón bloqueado deja de decir una sola cosa («Consulte el RUNT
antes de enviar.») y pasa a decir **todo lo que falta, por nombre**. Hoy el Cliente puede tener el
RUNT en verde, ver el botón activo, pulsarlo y solo entonces enterarse de que le faltan cinco campos
—la pantalla lo sabía desde antes y se lo callaba—.

**Se calla:** nada nuevo. No se añade ningún bloque, ninguna barra de progreso, ningún contador de
completitud. La enumeración es **una línea de texto** en el hueco `mr-auto` que ya existe a la
izquierda de la botonera (`FlitoSoatSolicitud.tsx:551-557`).

**Se retira:** tres frases que dejan de ser verdad. La solicitud ya no pasa por revisión de FLITO.

## 2.2 La enumeración — la regla, no un ejemplo

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Al enviarla, su SOAT entra en gestión de inmediato. No se guarda como   │
│  borrador.                                                               │
│                                                                          │
│  Para enviar falta: consultar el RUNT,        [Cancelar]  [Enviar al     │
│  Nombre/s y 7 datos más.                                   gestor]       │
│  ↑ id="sol-falta", texto plano                             ↑ aria-disabled│
└──────────────────────────────────────────────────────────────────────────┘
```

| Regla | Detalle |
|---|---|
| **De dónde sale la lista** | De **`validarTodo(...)`**, la función que ya bloquea el envío, mapeando cada clave a la etiqueta visible del campo. **Nunca** de un `if (campo === '')` paralelo: un correo escrito mal no está vacío, y con dos fuentes de verdad el botón se vería activo, la pulsación no enviaría y el usuario no sabría por qué |
| **Orden** | `ORDEN_FOCO` + `'archivo'` al final — el orden visual y el del tabulador. Es lo que hace la frase afirmable en un test |
| **El ítem del RUNT** | Va **primero** y se redacta según la fase: `inicial`/`fallo`/`sin-banda` → **«consultar el RUNT»**; `invalidada` → **«volver a consultar el RUNT»**. Calca `ROTULO_CONSULTA`, que es el rótulo del botón al que la frase apunta |
| **Tope** | **3 segmentos**: hasta 3 pendientes se nombran los 3; a partir de 4 son **2 nombres + «y N datos más»**. Con el formulario en blanco faltan 12 cosas y enumerarlas todas es un párrafo que nadie lee. El corte va en 2 y no en 3 a propósito: con 4 pendientes, «A, B, C y 1 datos más» obligaría a la variante de singular que la plantilla única existe para no tener. Es lo que escriben los ejemplos de abajo, lo implementado en `frasePendientes` y lo que afirma el test |
| **Plantilla única** | **«Para enviar falta: A, B y C.»** — una sola plantilla, sin variantes de singular/plural, para que exista **un** localizador |
| **Etiquetas, no valores** | Los nombres son los `label` de la pantalla: Placa, Tipo de documento, Número de documento, VIN, Razón social, Nombre/s, Apellido/s, Correo electrónico, Celular, Dirección, Municipio, Departamento, **Factura de venta** |
| **Excepción que se conserva** | Con `vigenteCerrado`, la frase **no** es una lista: sigue siendo **«Este vehículo tiene SOAT vigente según el RUNT: no se puede radicar la solicitud.»**. No falta nada; está prohibido |

**Ejemplos, para fijar la forma:**

| Situación | Texto |
|---|---|
| Formulario en blanco | **Para enviar falta: consultar el RUNT, Placa y 10 datos más.** |
| RUNT en verde, faltan correo y celular | **Para enviar falta: Correo electrónico y Celular.** |
| RUNT en verde, falta la factura | **Para enviar falta: Factura de venta.** |
| Se cambió la placa después de consultar | **Para enviar falta: volver a consultar el RUNT.** |
| Nada falta | *(la línea no se pinta y el botón queda activo)* |

## 2.3 Copy exacto — S2, incluidas las **tres** frases falsas (el AC solo nombra una)

| Dónde | Hoy | Nuevo |
|---|---|---|
| Tarjeta de envío (:546-548) | «Al enviarla, la solicitud pasa a revisión de FLITO. No se guarda como borrador.» | **«Al enviarla, su SOAT entra en gestión de inmediato. No se guarda como borrador.»** |
| Rótulo del primario (:574) | «Enviar la solicitud» | **«Enviar al gestor»** *(AC2, literal)* |
| Rótulo mientras envía (:574) | «Enviando…» | *(sin cambio)* |
| **Subtítulo de la página (:399)** | «…Al enviarla queda en revisión de FLITO.» | **«…Al enviarla, su SOAT entra en gestión de inmediato.»** |
| **Toast de éxito (:338)** | «Solicitud enviada. FLITO la va a revisar.» | **«Solicitud enviada. Ya está en gestión.»** |
| Frase de bloqueo (:552-556) | «Consulte el RUNT antes de enviar.» | La enumeración del §2.2 |
| Aviso tras un envío rechazado (:308) | «Revise los datos marcados antes de enviar.» | *(sin cambio)* |

> El subtítulo y el toast **no** están en el AC2 y son igual de falsos que la frase que sí está. Un
> toast que dice «FLITO la va a revisar» inmediatamente antes de aterrizar en una cola donde la fila
> aparece en **Solicitado** es la contradicción más visible de la HU.

**Tratamiento:** **usted**, sin excepción — es el canal Cliente y la pantalla entera ya lo usa
(«Usted no tiene que escribirlos», «vuelva a consultar»). «Para enviar falta:» es impersonal y no
rompe nada.

> **«Gestor» pasa a ser vocabulario que el Cliente lee.** El AC2 fija el rótulo y se respeta, pero es
> la primera vez que un rol externo ve esa palabra. **Requiere una línea en `docs/dominio.md` y en la
> ficha de ayuda** (§4); si el PO prefiere «Enviar la solicitud», es cambiar un literal, no la
> estructura.

## 2.4 La trampa que el `frontend-agent` no vería solo

`puedeEnviar` hoy significa **una** cosa —`consulta.fase === 'ok'`, la compuerta del RUNT— y la usan
**dos**: el aspecto del botón (:569-572) y el enrutado del foco al pulsarlo (`intentarEnviar`, :353).
Si se redefine `puedeEnviar = compuertaAbierta && sinFaltantes`, pulsar el botón con el RUNT en verde
y el correo vacío **manda el foco al botón «Consultar el RUNT»** — a un control que no tiene nada de
malo. El usuario queda dando vueltas.

**Lo que hay que hacer, y es lo único de esta superficie que no es copy:**

```
compuertaAbierta = consulta.fase === 'ok'            ← lo que hoy se llama puedeEnviar
faltantes        = [ítem del RUNT si !compuertaAbierta] + claves de validarTodo() → etiquetas

aria-disabled    = faltantes.length > 0              ← lo que decide el aspecto y el anuncio
intentarEnviar() = !compuertaAbierta ? focoEn(consultarRef) : void enviar()
                                                     ← enviar() ya valida, pinta y enfoca el 1.er error
```

`enviar()` **no se toca**: su primera mitad ya hace `validarTodo` → `setErrores` → `setIntento+1`, y
`useFocoPrimerError` ya lleva el foco al primer campo inválido. El botón bloqueado sigue siendo
**alcanzable con el teclado y pulsable**, y pulsarlo sigue llevando a la acción que toca — que ahora
es la correcta de las dos.

## 2.5 Accesibilidad

- La línea de faltantes es **texto plano con `id`**, no una región viva. El botón la referencia con
  `aria-describedby` **solo mientras está bloqueado**. Así el lector anuncia «Enviar al gestor, no
  disponible, Para enviar falta: …» **cuando el foco llega al botón**, que es cuando importa. Una
  `role="status"` ahí se reanunciaría con **cada pulsación de tecla** del formulario: doce campos
  interrumpiendo a quien escribe.
- `aria-disabled` y **no** `disabled`: decisión ya tomada en esta pantalla (:561-567) y que esta HU
  **conserva**, con la atenuación explícita porque `aria-disabled` no dispara las variantes
  `disabled:` de Tailwind.
- La lista **no marca los campos en rojo mientras se escribe**. `errores` se sigue poblando en `blur`
  y al enviar; la enumeración calcula, no pinta. Un formulario que se pone rojo mientras se teclea es
  el efecto secundario clásico de esta funcionalidad.
- Cada campo conserva su `label` asociado y su `aria-describedby` — no se toca `bloques.tsx`.
- axe con `QA_AXE_CDN=1`, o salen ~10 rojos que no son regresión.

## 2.6 Los cuatro estados

**No cambian.** La pantalla no incorpora ninguna superficie de datos nueva: la enumeración se calcula
del estado local. Los estados de la consulta al RUNT (`cargando` / `fallo` con su banda y su «Volver
a consultar» / `ok` con la ficha / `inicial`) y las dos tarjetas de canal (`TarjetaCanalAjeno`,
`TarjetaCanalDeshabilitado`) se conservan **tal cual**. Lo que sí se declara para QA es que la
enumeración tiene que ser correcta **en los cuatro**, incluida la fase `cargando` (donde el ítem del
RUNT sigue presente porque la compuerta sigue cerrada).

---

# 3 · Cola de SOAT y retirada de la revisión

## 3.1 Qué desaparece y **qué queda en su lugar**

| Quién | Qué tenía | Qué ve ahora |
|---|---|---|
| **Cliente** con una solicitud rechazada | `rechazada` → detalle con «Por qué se rechazó» + primaria **«Corregir y reenviar»** → `/flito/soat/solicitud/:id` | **El estado deja de existir** (la migración de la HU #12081 aborta si queda alguna fila). No hay hueco que rellenar: el camino entero se retira porque su origen —la revisión— se retira |
| **Cliente** cuyo SOAT vuelve con novedad | `con_novedad` con «Motivo de rechazo: …» (`FlitoSoat.tsx:827`), **sin siguiente paso** | Lo mismo **más una línea**, §3.3. Es la única vía por la que hoy le devuelven algo, y hasta ahora la caja roja lo dejaba sin saber qué hacer |
| **Operaciones** en una fila del canal | Bloque «Revisión de la solicitud»: ficha RUNT de solo lectura, «radicada el …», reenvíos, **Validar** / **Rechazar la solicitud**. Y **sin** «Reversar» ni «Cambiar proveedor» | **El bloque no se sustituye por nada.** La fila nace en `solicitado` y es un SOAT **en gestión como cualquier otro**: el detalle le ofrece las acciones que ya tenía para ese estado —**Cargar factura**, **Rechazar**, **Asumir en Operaciones** / **Devolver al proveedor**— y, al caer `esFilaDelCanal`, recupera **Reversar** |
| **Gestor** | Nada: los dos estados estaban fuera de su lista blanca | Sin cambio. Ve la solicitud en `solicitado` desde que se radica (AC5 del backend) |
| **Auditor** | Veía el bloque en solo lectura | Deja de verlo; el resto del detalle no cambia |

> **Lo que se pierde y hay que decir en voz alta: después de esta HU nada distingue en pantalla una
> solicitud del canal Cliente de un SOAT nacido de un trámite.** El comentario de `ESTADOS_CLIENTE`
> (`FlitoSoat.tsx:142-143`) lo decía literalmente: *«no hace falta una columna Origen: los dos
> estados solo existen en el canal Cliente, así que el estado ya dice de dónde viene cada fila»*. Ese
> argumento **muere aquí**.
>
> **No se añade columna** —la cola ya es densa y el gestor trabaja igual las dos—. Si Operaciones lo
> echa en falta, lo barato es **una línea en el detalle**, no una columna: `soat.tramitesFlit` ya
> viaja al front y viene **vacío** exactamente en las filas del canal.
> **Pregunta al PO, sin implementarla en esta HU.**

## 3.2 Rutas, enlaces y estados muertos — la lista para el grep

| Qué | Dónde | Qué pasa si se olvida |
|---|---|---|
| `App.tsx:212` — ruta `/flito/soat/solicitud/:id` | **se borra** | Con el componente retirado, `FlitoSoatSolicitud` caería en la rama `<Alta />`: una URL guardada en marcadores que promete una solicitud existente pintaría **un formulario nuevo en blanco**. Borrada la ruta, el comodín `*` la manda a `/` y el `InicioGate` de la HU #11913 deja al Cliente en su cola: destino correcto y sin error |
| `FlitoSoatSolicitud.tsx:69` y `:135` | import y rama `id ? <CorreccionSolicitud/> : <Alta/>` | El componente `FlitoSoatSolicitud` se queda **sin `useParams`**: `Alta` pasa a ser el único cuerpo |
| `FlitoSoat.tsx:17`, `:914-923` | import y montaje de `BloqueRevision` | — |
| `FlitoSoat.tsx:743-750` | `enRevision`, `rechazadaCliente`, `esFilaDelCanal`, `verRevision` | Sin quitarlas quedan cuatro constantes que evalúan a `false` y dos guardas que ya no guardan nada |
| `FlitoSoat.tsx:854`, `:857` | `&& !esFilaDelCanal` | Se retiran: la condición ya no existe |
| `FlitoSoat.tsx:89-92`, `:126-148` | `TONO`, `ESTADOS_ADMIN`, `ESTADOS_CLIENTE` | El `Record<EstadoSoat, ChipTone>` lo señala el typecheck; los arrays **no** |
| `FlitoTramites.tsx:97` | tono del chip | Igual |
| `lib/api.ts` | `/:id/validar`, `/:id/rechazar-solicitud`, `/causales-rechazo`, `PATCH /:id/solicitud` | AC3 |
| `e2e/tests/soat-revision-rechazo.spec.ts` | se borra | AC6 |

> ⚠ **Los comentarios que se quedan mintiendo.** `ESTADOS_ADMIN` (:116-125) y `ESTADOS_CLIENTE`
> (:130-148) llevan encima **diez y dieciocho líneas de docblock** que justifican pastillas que dejan
> de existir («va primero porque es el trabajo del día que esta HU le crea», «sin esta pastilla no hay
> camino desde la cola hasta la subsanación»). Quitar dos elementos del array y dejar el comentario es
> el fallo más probable de esta HU: la siguiente persona lee que hay un camino a la subsanación y lo
> busca. **Se reescriben los dos docblocks o se borran.** Lo mismo con `ESTADOS_DESTINO_REVERSA`
> (:100-113), cuya razón de ser —*no ofrecer `pendiente_revision` como destino de reversa*— se
> evapora: si al retirarla queda idéntica a `ESTADOS_ADMIN`, **eso hay que decidirlo a propósito**,
> no fundirlas «porque ahora son iguales».

## 3.3 Copy — S3

| Elemento | Texto |
|---|---|
| Pastillas de Operaciones, orden nuevo | **Todos · Pendiente · Solicitado · Pagado · Con novedad** |
| Pastillas del Cliente, orden nuevo | **Todos · Pendiente · Solicitado · Con novedad · Pagado** |
| Caja del motivo (`:827`), **solo `esCliente`**, línea añadida bajo el motivo | **Su solicitud sigue abierta: FLITO está resolviendo esta novedad con el gestor. No tiene que hacer nada por ahora.** |
| Vacíos y errores de la cola | **Sin cambio** |

> La línea del Cliente es lo único que se **añade** en S3, y es lo que impide que retirar «Corregir y
> reenviar» deje una caja roja sin siguiente paso. Dice la verdad —Operaciones puede **Reactivar** o
> **Devolver al proveedor**— y no promete un canal de contacto que el producto no tiene.
> **Si el PO quiere otro siguiente paso (un correo, un teléfono), es cambiar esta frase.**

## 3.4 Los cuatro estados

**No cambian.** La cola conserva cargando, error con reintento (`:494`), vacío con y sin filtros, y
lleno. Lo único que se mide es que **el vacío con filtros sigue siendo alcanzable**: con dos pastillas
menos, ningún filtro debe quedar sin su mensaje.

> **Efecto lateral que hay que anticipar en el ANS:** una solicitud del canal ahora nace con
> `enviadoEn` puesto (AC1 del backend), así que **el reloj de «Sin gestión» arranca en la radicación**
> y no en la validación. El preset «Sin gestión» y el `ChipSinGestion` empezarán a marcar solicitudes
> del canal que Operaciones nunca tocó. Es el comportamiento correcto —el gestor las tiene desde el
> minuto uno— pero es un cambio visible en la cola que nadie pidió y conviene que no sorprenda.

---

# 4 · La ficha de ayuda `soat.md` — **queda mucho más que «la parte del estado»**

La HU #12078 corrigió el párrafo de **Estados** (`:34`). Lo que sigue describiendo un circuito que
esta HU borra:

| Línea | Qué dice hoy | Qué hay que hacer |
|---|---|---|
| `:15` | «El Administrador y el Cliente ven además **Pendiente de revisión** y **Rechazada**» | Retirar la frase entera |
| `:21` | «En una solicitud del canal no aparecen **Reversar** ni **Cambiar proveedor**: esas filas se resuelven validándolas o rechazándolas» | Retirar: ya **sí** aparecen, y no hay validación |
| `:22` (paso 8, párrafo entero) | Ficha del RUNT, **Validar**, **Rechazar** con causal y observación, **Actualizar verificación** | **Se borra el paso completo** y se renumeran los siguientes |
| `:23-24` | «**Enviar la solicitud** … le dice **Consulte el RUNT antes de enviar.**» · «la solicitud queda en **Pendiente de revisión**» | Rótulo **Enviar al gestor**, la frase nueva de faltantes y **«queda en Solicitado y sale al gestor de su compañía»** |
| `:26` (paso 12 entero) | «**Corregir y reenviar**… vuelve a **Pendiente de revisión**» | **Se borra el paso completo** |
| `:42`, `:43`, `:44`, `:48` | Los cuatro «Qué no hace» sobre rechazo, corrección y **Validar/Rechazar** | Se borran; solo sobrevive la distinción de que **Rechazar** del gestor deja el SOAT en **Con novedad**, que sigue siendo verdad |

Falta además, en **Para quién** (`:7`) y en **Estados** (`:34`), la frase de la ficha de la compañía:
**«El gestor por defecto de cada compañía se configura en Clientes y proveedores, en la columna SOAT
sin trámite.»** Sin eso, el admin lee que el gestor «es el que la compañía tenga configurado» y no
hay ninguna pantalla que le diga dónde se configura.

---

# 5 · PII y permisos

1. **Nada nuevo en la URL.** El gestor viaja en el cuerpo del `PATCH`; la enumeración de faltantes
   nombra **etiquetas**, nunca valores; la cola sigue sin identificadores en el query
   (`AGENTS.md` §14).
2. **El `aria-label` del botón de la celda lleva el nombre de la compañía, nunca el NIT.** Los
   selectores de axe arrastran valores de atributo hasta 31 caracteres y acabarían en el informe.
3. **Ningún `requireRole` cambia.** El catálogo de gestores es `admin`+`auditor` y solo lo pide
   `admin`; la ficha sigue bajo `clients`.
4. **Lo que la retirada se lleva por delante en materia de datos personales:** las observaciones de
   rechazo eran **texto libre escrito por Operaciones sobre los datos de un tercero**. Su supresión
   está declarada en el AC4 de la HU #12081; desde UX **no se propone conservarlas en pantalla**.

---

# 6 · Notas para QA — cada una con el mutante que debe matar

1. **S1 — la tabla no engorda.** `expect(columnheader).toHaveCount(12)` y
   `expect(getByRole('checkbox', { name: /SOAT sin trámite de/ })).toHaveCount(0)`.
   *Mutante:* la disposición A (13.ª columna con un select por fila) — el conteo la mata.
2. **S1 — el nombre accesible contiene el visible (WCAG 2.5.3).** El botón de la fila:
   `toHaveAccessibleName('SOAT sin trámite de Transportes X: Abierto · SURA')` **y**
   `toHaveText('Abierto · SURA')`. *Mutante:* un `aria-label` que empiece por «Configurar» — el
   segundo aserto pasa y el primero no.
3. **S1 — el orden de los dos controles no importa, que es toda la decisión.** En el modal:
   (a) encender el interruptor **primero** y luego elegir gestor → guarda; (b) elegir gestor primero
   y luego encender → guarda. Los dos con **una sola** petición `PATCH`.
   *Mutante:* un `PATCH` por control (vuelve la trampa del orden) — el conteo de peticiones lo mata.
4. **S1 — el rechazo se ve, se enfoca y NO viaja.** Canal encendido + gestor vacío + «Guardar»:
   `getByRole('alert')` con **«Elija el gestor por defecto antes de abrir el canal.»**,
   `expect(select).toBeFocused()`, **`expect(patchSpy).not.toHaveBeenCalled()`** y el interruptor del
   borrador **sigue encendido**. *Mutante:* delegar en el 400 del servidor — solo el tercer aserto lo
   mata; y apagar el interruptor al fallar, que obliga a rehacer dos clics.
5. **S1 — el gestor desactivado no se pierde por la espalda.** Compañía atada a un gestor
   `activo:false`: abrir el modal → la opción sale **seleccionada** y con **«(inactivo)»**; guardar
   sin tocarla → el `PATCH` manda **el mismo id**. Y en la celda: **«Abierto · SURA (inactivo)»**.
   *Mutante:* filtrar el catálogo por `activo` sin reinyectar el asignado.
6. **S1 — los cuatro estados del catálogo.** Interceptar el `GET`: pendiente → «Cargando gestores…»;
   500 → mensaje + **botón** que dispara un segundo `GET`; `[]` → el texto que nombra **la pestaña
   Proveedores** y **sin** botón; lleno → las opciones. *Mutante:* colapsar error y vacío en el mismo
   texto.
7. **S2 — la enumeración nombra, y nombra lo que toca.** RUNT en verde + todo lleno menos correo y
   celular → **«Para enviar falta: Correo electrónico y Celular.»** exacto. Con el formulario en
   blanco → `toHaveText(/^Para enviar falta: consultar el RUNT,.* y \d+ datos más\.$/)`.
   *Mutante:* un mensaje genérico («Complete los datos obligatorios») — el primer aserto lo mata; y
   enumerar sin tope, que el segundo detecta.
8. **S2 — el botón bloqueado sigue siendo del teclado y lleva al sitio correcto.** Con el RUNT en
   verde y el correo vacío: el botón es **alcanzable con Tab**, tiene `aria-disabled="true"`, y al
   pulsarlo el foco cae **en el campo Correo electrónico** —no en «Consultar el RUNT»—.
   *Mutante:* meter los faltantes dentro de `puedeEnviar` sin tocar `intentarEnviar` (§2.4): el foco
   se va al botón de consulta y el aserto lo caza. *Mutante 2:* poner `disabled` — Tab no lo alcanza.
9. **S2 — un valor inválido no desaparece de la lista.** Escribir `hola@` en el correo (no vacío,
   inválido): el botón **sigue** bloqueado **y** la lista **sigue** nombrando «Correo electrónico».
   *Mutante:* calcular los faltantes con `campo === ''` en vez de con `validarTodo` — botón activo,
   pulsación sin efecto visible.
10. **S2 — las tres frases falsas, las tres.** `queryByText(/revisión de FLITO/)` → **0** en la
    tarjeta, en el subtítulo de la página y en el toast de éxito. Y el toast dice **«Solicitud
    enviada. Ya está en gestión.»**. *Mutante:* cambiar solo la frase que el AC nombra.
11. **S3 — el circuito no es alcanzable ni por URL.** `grep` vacío de los cuatro componentes;
    navegar a `/flito/soat/solicitud/<uuid>` como `cliente` → aterriza en `/flito/soat` **y**
    `queryByText('Enviar al gestor')` es 0 (no se pintó el alta bajo esa URL).
    *Mutante:* borrar el componente y dejar la ruta de `App.tsx:212`.
12. **S3 — las pastillas y el historial.** Como `admin` y como `cliente`:
    `queryByRole('button', { name: 'Pendiente de revisión' })` y `'Rechazada'` → **0**, en las
    pastillas **y** en el selector «Estado destino» de la reversa. Y abrir el detalle de una solicitud
    **antigua** que sí pasó por revisión: el historial muestra sus hitos **con fecha y hora**, sin
    etiquetas en blanco. *Mutante:* resolver la etiqueta del historial contra `ESTADO_SOAT_LABEL`
    después de quitarle las dos claves → `undefined` pintado como hueco.

> **Infraestructura, para que nadie se confíe:** el CI corre **un** spec E2E (el visor de PDF). El
> spec nuevo del AC6 hay que **añadirlo a la lista fija del nocturno** y correrlo a mano antes de
> cerrar. Y `QA_AXE_CDN=1` en todo lo que use axe.
>
> **Fixture:** la compañía de `CLIENTE_USER` necesita **gestor por defecto configurado**, o el envío
> directo se prueba contra el camino de contingencia (AC2d) creyendo que se prueba el normal.

---

# 7 · Decisiones y descartes (resumen citable en el PR)

| # | Decisión | Descarte principal |
|---|---|---|
| 1 | El interruptor y el gestor viven en **un modal por compañía**, abierto desde la celda que hoy tiene la casilla | Una 13.ª columna con un `FlitSelect` por fila: 200 regiones vivas, una parada de tabulador más por fila y el orden de los controles convertido en adivinanza |
| 2 | **El interruptor nunca se deshabilita**; el par es un borrador que se valida al **Guardar**, con mensaje propio, foco al control y **cero peticiones** | Deshabilitar el interruptor hasta que haya gestor (un control que no recibe foco y no explica nada) y pedir el gestor en un segundo diálogo sobre el modal |
| 3 | El mensaje del servidor se muestra **literal** en el modal cuando la petición sale y la rechazan; el que se ve **primero** es el del cliente | Depender solo del 400: `ApiError.toUserMessage()` lo entregaría como `soatSinTramite: …` |
| 4 | La advertencia del cambio de gestor va **en la ayuda del campo (antes)** + **toast (después)** | Un `confirm`: la consecuencia no es destructiva y hay dos precedentes en el producto que avisan así |
| 5 | La celda muestra **«Abierto · {gestor}»**, con **(inactivo)** en el texto, y su nombre accesible **contiene** el texto visible | Un `aria-label` que empiece por «Configurar»: rompe WCAG 2.5.3 para quien maneja el producto por voz |
| 6 | La enumeración de faltantes se deriva de **`validarTodo`**, en `ORDEN_FOCO`, con tope de **3 segmentos** (a partir de 4 pendientes, **2 nombres + «y N datos más»**) y una **plantilla única** | Un chequeo de vacíos en paralelo (dos verdades) y enumerar los 12 (un párrafo que nadie lee) |
| 7 | La línea de faltantes es **texto plano** referenciado por `aria-describedby` del botón | Una `role="status"`: se reanuncia con cada tecla de un formulario de doce campos |
| 8 | `puedeEnviar` se **parte en dos** (`compuertaAbierta` para el enrutado del foco, `faltantes` para el aspecto) | Redefinir `puedeEnviar` y dejar `intentarEnviar` como está: el foco acaba en el botón equivocado |
| 9 | Se corrigen **las tres** frases que prometen revisión, no solo la que nombra el AC2 | Cerrar la HU con un toast que dice «FLITO la va a revisar» justo antes de mostrar la fila en **Solicitado** |
| 10 | El bloque de revisión **no se sustituye por nada**: la fila del canal es un SOAT en gestión y usa las acciones que ya existían para `solicitado` | Inventar un bloque «Solicitud del canal» para que el detalle no se vea vacío |
| 11 | Al Cliente con un SOAT **Con novedad** se le añade **una línea** con el siguiente paso | Dejar la caja roja del motivo sin siguiente paso, que es lo que queda al retirar «Corregir y reenviar» |
| 12 | **No** se añade columna ni chip de «Origen» a la cola, aunque el argumento que lo hacía innecesario muera con esta HU | Añadirla de paso: la cola es densa y ningún AC la pide. Queda **preguntado al PO**, con `tramitesFlit` vacío como señal ya disponible |
| 13 | Los **docblocks** de `ESTADOS_ADMIN`, `ESTADOS_CLIENTE` y `ESTADOS_DESTINO_REVERSA` se reescriben, no solo sus arrays | Dejar dieciocho líneas explicando un camino a la subsanación que ya no existe |
