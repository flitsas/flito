# UX slim — Revisión de Operaciones: validar, rechazar con causal y subsanar (HU #11915)

> **Qué es este documento.** La entrada del `frontend-agent` que implemente la
> [#11915](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/11915), eslabón **3 de 4**
> del Feature #11912. Modo **slim**: no hay pantalla nueva ni ruta nueva. Todo lo de esta HU cabe en
> superficies que ya existen —la cola `/flito/soat` y su modal de detalle— y en un bloque que la
> #11914 dejó escrito y hoy se pinta vacío.
>
> **Continúa** a `docs/ux/alta-solicitud-cliente-y-consulta-runt.md` (#11914) y **no lo repite**. Allí
> ya está diseñada la vista del Cliente que subsana (`CorreccionSolicitud.tsx`), incluido el bloque
> «Por qué se rechazó». Lo que falta y entrega este documento es **el otro lado**: cómo Operaciones
> escribe esa causal, y qué ven exactamente los otros tres roles.
>
> **Fuera de alcance, escrito para que nadie lo amplíe de paso:** no hay correos ni notificaciones en
> todo el Feature; no hay pantalla de administración del catálogo de causales (se siembra por
> migración, §6); no se toca el rechazo del gestor (`POST /:id/rechazar` → `con_novedad`); lo que ve
> el gestor y la descarga de la póliza son la **#11916**.

---

## 0. Contexto en una tabla

| | |
|---|---|
| **Rol que actúa** | `admin` (Operaciones). `auditor` mira, `proveedor` y `cliente` no llegan |
| **Slug / permiso** | `flito_soat`. **Ninguno nuevo, ninguna ruta nueva, ninguna entrada de menú** |
| **Superficies tocadas** | 3: pills de estado de la cola (delta) · modal de detalle (bloque nuevo) · el bloque «Por qué se rechazó» del Cliente (hoy vacío) |
| **Endpoints** | `POST /:id/validar`, `POST /:id/rechazar-solicitud`, `GET /causales-rechazo` (ADR §6 #6, #7, #4) |
| **PII** | Ninguna nueva en pantalla. La **observación** es texto libre que escribe un empleado de FLIT y **lee una empresa tercera**: es el riesgo de esta HU y §3.3 es lo que lo contiene |

---

## 1. Los dos tipos de fila conviven en la misma cola — y esto es la mitad del AC1

El AC1 lo pide con estas palabras: *un SOAT de trámite en `pendiente` **no** usa este botón, y el
admin no tiene que adivinar cuál acción aplica a cuál*. Se resuelve con **cuatro señales
encadenadas**, ninguna de las cuales es un cartel explicativo:

| # | Señal | Estado hoy |
|---|---|---|
| 1 | **El chip ya lo dice.** «Pendiente» (`draft`) vs «Pendiente de revisión» (`warning`). Y `pendiente_revision` / `rechazada` **solo existen en el canal Cliente** (ADR §8): el estado ya es el origen, no hace falta una columna «Origen» | ✅ Ya existe (`TONO`, `FlitoSoat.tsx:74`) |
| 2 | **La casilla de selección.** `seleccionables` filtra `estado === PENDIENTE` (`:235`), así que una solicitud del canal **nunca** tiene checkbox y la barra de envío masivo no puede alcanzarla | ✅ Ya existe, sin tocar nada |
| 3 | **Las acciones del detalle se gobiernan por ESTADO, no por rol** (§1.2). Es lo único que hay que arreglar, y no es cosmético | ❌ Hay que hacerlo |
| 4 | **Una línea de contexto** en el bloque de revisión que nombra el origen con palabras: «Solicitud del canal Cliente · radicada el {fecha}» | ❌ Nuevo |

### 1.1 Delta de la cola: la pill que falta, y la trampa de reusar la lista de al lado

Medido, `FlitoSoat.tsx:85`: `ESTADOS_OPERACIONES` es `[pendiente, solicitado, pagado, con_novedad]`.
**El admin no puede filtrar «Pendiente de revisión»** — es decir, hoy no hay forma de encontrar lo que
esta HU le manda revisar salvo paginar. La #11914 le dio esa pill al Cliente (`ESTADOS_CLIENTE`) y
dejó al revisor sin ella.

> ⚠ **Y la trampa: `ESTADOS_OPERACIONES` alimenta DOS cosas.** Las pills (`:123`) **y el selector
> «Estado destino» de la Reversa** (`:731`). Añadirle los dos estados nuevos le da al admin la
> posibilidad de reversar cualquier SOAT a `pendiente_revision` o a `rechazada`, que es exactamente lo
> que el ADR §8 prohíbe por escrito («devolver un SOAT ya validado a `pendiente_revision` dejaría al
> gestor sin cola y al cliente con una solicitud que creía resuelta»). Un cambio de una línea, con un
> efecto en otra pantalla, que ningún test mira.
>
> **Decisión: una constante nueva `ESTADOS_ADMIN` para las pills, con los seis en orden de recorrido
> —`pendiente_revision` primero, que es el trabajo del día—; `ESTADOS_OPERACIONES` se queda literal
> como está y pasa a servir SOLO al selector de reversa.** Y se le cambia el comentario para que diga
> eso, o dentro de tres meses alguien vuelve a fundirlas.

**Segundo delta, en el servidor, y sin él la pill miente:** `flito-soat.routes.ts:53` declara
`ESTADOS` —los valores que el filtro de la cola acepta— sin los dos nuevos, y un estado desconocido
**se ignora, no da 400** (comentario de `:52`). Es decir: el admin pulsa «Pendiente de revisión», el
filtro se cae por el camino y **la cola le devuelve todo**, presentándoselo como el resultado del
filtro. Es el peor modo de fallo posible en una pantalla de revisión y es silencioso. La propia línea
`:51` ya dice que quien los añade es esta HU.

Nada más en la cola: cero columnas nuevas, cero filtros nuevos, cero cambios en la tabla.

### 1.2 Delta del detalle: las acciones que hoy se pintan sobre una fila que no las admite

Medido en el bloque de acciones (`FlitoSoat.tsx:691-718`), sobre una fila en `pendiente_revision`
o `rechazada` un `admin` ve hoy:

| Botón | Condición actual | Qué pasa si lo pulsa |
|---|---|---|
| **Reversar** | `esOperaciones` — **sin ninguna condición de estado** | `reversar()` (`flito-soat.service.ts:867`) **no valida el estado de origen**: solo exige motivo ≥5 y que el destino sea distinto. Reversar una `pendiente_revision` a `pendiente` la mete en el alcance de `POST /enviar`, que filtra `estado = pendiente` → **se despacha al gestor una solicitud que nadie validó**, saltándose el AC1 entero |
| **Cambiar proveedor** | `esOperaciones && !enAdquisicion` | Se ofrece elegir gestor para una solicitud que todavía no ha entrado en gestión. No rompe nada, pero es una acción sin sentido en ese punto del ciclo |
| **Cargar factura / Rechazar** | `enAdquisicion` | Correcto por casualidad: no se pintan. Se dejan como están |

**Requisito:** las acciones heredadas se condicionan además a que el estado **no** sea uno de los dos
del canal. La forma correcta es una guarda nombrada —`enRevision = estado === PENDIENTE_REVISION`,
`rechazadaCliente = estado === RECHAZADA`— y no un `!esCliente`, que sería preguntar por el lector
cuando la pregunta es por la fila.

---

## 2. Superficie A — Bloque «Revisión de la solicitud» en el detalle (AC1)

### 2.1 Wireframe — `pendiente_revision`, visto por `admin`

```
╔══════════════════════════════════════════════════════════════════════════╗
║  SOAT · ABC123                                                      [X]  ║
╟──────────────────────────────────────────────────────────────────────────╢
║  ⬤ Pendiente de revisión                                                 ║
║                                                                          ║
║  VIN 9BWZZZ377VT004251        VEHÍCULO  RENAULT LOGAN                    ║
║  COMPAÑÍA Transportes X       ORGANISMO STRIA TTEyTTO MEDELLIN           ║
║  GESTIONA —                   ENVIADO POR —                              ║
║                                                                          ║
║  Soporte  ▸ Ver soporte          ← la factura de venta se lee AQUÍ       ║
║                                                                          ║
║  ── Historial de estados ────────────────────────────────────────        ║
║                                                                          ║
║  ┌ Revisión de la solicitud ────────────────────────────────────────────┐║
║  │ Solicitud del canal Cliente · radicada el 28/08/2026                 │║
║  │ Revise la factura de venta y los datos del propietario antes de      │║
║  │ validarla.                                                           │║
║  │                                                                      │║
║  │            [ Validar ]   [ Rechazar la solicitud ]                   │║
║  └──────────────────────────────────────────────────────────────────────┘║
╚══════════════════════════════════════════════════════════════════════════╝
```

Con **reenvíos > 0**, una línea más bajo la primera:

```
│ Es el 2.º reenvío de esta solicitud. Lo que se le pidió corregir antes    │
│ está en el historial de estados, más arriba.                             │
```

**Dónde vive el bloque: al final del detalle, después del historial, en un `<section>` con `<h3>`.**
No arriba: lo primero que hay que hacer es **leer la factura**, y poner los dos botones antes que el
soporte invita a validar sin abrirlo. Y no en un modal aparte: `FlitModal` ya sufre el apilamiento
(su `useEscape` tuvo que aprender a cerrar solo el de arriba, `FlitModal.tsx:43`), y el visor de
soportes ya se abre encima de este modal — un tercer nivel es el que rompe la pila.

### 2.2 «Validar» no es un botón de un clic, y hay una razón dura

`POST /:id/validar` recibe `{ proveedorSoatId }` **o** `{ gestionOperaciones: true }` (ADR §6 #6) y
reusa el efecto de `enviarAlGestor()`, que fija destino y estado **en el mismo movimiento**
(`flito-soat.service.ts:781-797`). Un `solicitado` sin destino es un SOAT en la cola de nadie y sin
ANS con el que medirlo — es literalmente por lo que la barra de envío masivo deshabilita su botón sin
destino (`:521`).

**Decisión: «Validar» abre un panel en línea con el selector de destino, y el botón de confirmar dice
a dónde va.** Mismo control único que la barra masiva —la contingencia entra como una opción **más**
de la misma lista, no como una casilla aparte—, para que sea imposible construir el `400` de destino
ambiguo que el servidor rechaza.

```
│  ┌ Validar la solicitud ────────────────────────────────────────────────┐│
│  │ Al validarla pasa a Solicitado y entra en la cola del gestor.        ││
│  │                                                                      ││
│  │ Destino *                                                            ││
│  │ [ Elija el destino…                                             ▾ ]  ││
│  │   · Gestionado por Operaciones                                       ││
│  │   · Proveedores ▸ …                                                  ││
│  │                                                                      ││
│  │        [ Validar y enviar al gestor ]   [ Cancelar ]                 ││
│  └──────────────────────────────────────────────────────────────────────┘│
```

**Y no hay validación en lote.** La casilla de selección sigue siendo solo de los `pendiente`
(§1, señal 2) y no se le añade `pendiente_revision`. Revisar es leer una factura de venta y comparar
un nombre; una casilla que valida diez a la vez es una casilla que aprueba sin leer, y entonces esta
HU no sirve para nada. Se declara aquí para que no se «mejore» después.

### 2.3 Los 4 estados — superficie A

| Estado | Cuándo | Qué se ve | Copy |
|---|---|---|---|
| **1 · Cargando** | Mientras `validar` o `rechazar` está en vuelo. **No hay carga de datos**: el detalle se pinta de una fila que ya está en memoria (`filas.find`, `:236`), así que este es el único «cargando» que existe | El botón primario cambia de texto y queda `disabled`; los demás botones del bloque, también | **«Validando…»** · **«Rechazando…»** |
| **2 · Error** | El `POST` falló | Banda `role="alert"` **dentro del bloque**, el panel **no se cierra** y **lo escrito se conserva**. El error de la acción no puede borrar una observación de tres líneas | Ver §3.4 |
| **3 · Vacío** | El estado no es `pendiente_revision` | El bloque **no se monta**. Y su variante que sí se pinta: en `rechazada`, el bloque sale **en solo lectura, sin botones** (§2.4) | — |
| **4 · Lleno** | `pendiente_revision` y `admin` | Los dos botones | — |

### 2.4 La variante `rechazada` vista por Operaciones — y por qué NO lleva botones

```
│  ┌ Revisión de la solicitud ────────────────────────────────────────────┐│
│  │ ⬤ Rechazada · a la espera de que el cliente corrija                   ││
│  │ Factura de venta ilegible                                            ││
│  │ «La factura está cortada y no se ve el número del chasis. Vuelva a    ││
│  │  escanearla completa.»                                               ││
│  │ Rechazada el 28/08/2026 por Ana Gómez                                ││
│  └──────────────────────────────────────────────────────────────────────┘│
```

En `rechazada` **la pelota es del Cliente** y el único camino de vuelta es que él reenvíe
(`rechazada → pendiente_revision`, ADR §8). Ninguna acción de Operaciones aplica ahí, y ofrecer una
—un «reactivar», un «validar de todos modos»— crearía un segundo camino de salida que el diagrama de
estados no tiene. **Aquí sí se muestra `revisado_por_nombre`**: el lector es interno, y saber a quién
preguntar por un rechazo de hace tres días es la mitad del valor del registro. Ese nombre **no** viaja
al DTO del `cliente` (§4.1).

---

## 3. Superficie B — Formulario de rechazo (AC2)

### 3.1 Wireframe

```
│  ┌ Rechazar la solicitud ───────────────────────────────────────────────┐│
│  │ El cliente verá la causal y la observación, y podrá corregir y       ││
│  │ volver a enviarla.                                                   ││
│  │                                                                      ││
│  │ Causal del rechazo *                                                 ││
│  │ [ Elija la causal…                                              ▾ ]  ││
│  │ El cliente ve esta causal, tal cual, junto con su observación.       ││
│  │                                                                      ││
│  │ Observación para el cliente *                                        ││
│  │ ┌──────────────────────────────────────────────────────────────────┐ ││
│  │ │                                                                  │ ││
│  │ └──────────────────────────────────────────────────────────────────┘ ││
│  │ La lee la empresa cliente tal como la escriba. Dígale qué tiene      ││
│  │ que corregir. No escriba notas internas ni nombres de compañeros.    ││
│  │                                                             0/500    ││
│  │                                                                      ││
│  │        [ Confirmar el rechazo ]   [ Cancelar ]                       ││
│  └──────────────────────────────────────────────────────────────────────┘│
```

### 3.2 Las dos divergencias respecto de `FormMotivo`, y por qué se pagan

`FormMotivo` (`FlitoSoat.tsx:789`) es el patrón de las otras seis acciones del modal y **no sirve tal
cual** aquí. Dos diferencias, las dos deliberadas:

1. **Son dos campos obligatorios, uno de ellos un catálogo por red.** `FormMotivo` tiene uno solo, de
   texto, sin `aria-invalid`, sin mensaje por campo y sin estados de carga. Reusarlo obligaría a
   ensancharlo para un caso, que es como se rompen los seis que ya funcionan. **Componente propio**,
   en `components/flito/soat-cliente/` junto a los de la #11914, no dentro de `FlitoSoat.tsx` (que
   mide ~795 físicas contra el tope global de 800).
2. **El botón de confirmar NO se deshabilita: valida al pulsar.** `FormMotivo` deshabilita mientras
   `motivo.trim().length < minLen`. Con **dos** campos, un botón muerto no dice cuál de los dos falta;
   y «demasiado corta» no es lo mismo que «vacía», así que un `disabled` no puede expresarlo. El AC2
   —«sin causal o sin observación, el estado no cambia»— se cumple igual por las dos vías, y esta
   además **explica cuál falta**.

### 3.3 La observación la lee una empresa tercera — y eso es una decisión de diseño, no un aviso

Es la única cadena de todo el Feature que un empleado de FLIT **escribe** y una compañía cliente
**lee entera y literal**. Tres cosas la contienen, y ninguna es un tooltip:

- **El rótulo lo dice: «Observación para el cliente»**, no «Motivo» ni «Observación». La etiqueta es
  lo que el revisor lee antes de escribir; el tooltip es lo que lee después de haber escrito.
- **La ayuda va debajo del campo, siempre visible**, enlazada por `aria-describedby`, y nombra lo que
  no se escribe: notas internas y nombres de compañeros.
- **Contador visible** (`0/500`). No es un adorno: un texto largo en un campo pequeño es un texto que
  su autor no relee, y este lo lee un cliente.

Está alineado con lo que ya hizo la #11913 con el historial: allí el `motivo` de los cambios de estado
se le **calla** al lector externo (`estado-historial.ts:120-124`, «lo que un gestor escribe a mano en
un rechazo no lo sanea ninguna plantilla»). La observación de esta HU es la excepción a esa regla, y
por eso es la que tiene que llevar el aviso encima.

### 3.4 Los 4 estados — superficie B

El catálogo de causales **es una superficie con datos por red**, y esta HU es la que la estrena: la
tabla nace vacía (`0167`, comentario del `CREATE TABLE`). Los cuatro estados no son un formalismo.

| Estado | Cuándo | Qué se ve | Copy |
|---|---|---|---|
| **1 · Cargando** | `GET /causales-rechazo` en vuelo, al **abrir el formulario** (no al montar la cola: casi ninguna apertura del detalle acaba en rechazo) | Selector con una única opción inerte y `role="status"`; «Confirmar el rechazo» `disabled` | **«Cargando causales…»** |
| **2a · Error de catálogo** | El `GET` falló | Banda `role="alert"` + botón de reintento. Sin causal no se puede rechazar, así que el confirmar sigue `disabled` | **«No se pudieron cargar las causales de rechazo.»** · botón **«Volver a cargar las causales»** *(copy ya en uso en comparendos)* |
| **2b · Error por campo** | Se pulsó confirmar con algo mal | `aria-invalid` + `<p role="alert">` bajo cada control, foco al primero, y banda resumen sobre los botones | §3.5 |
| **2c · Error de la acción** | El `POST` falló | Banda `role="alert"`; el formulario **no se cierra** y conserva lo escrito | §3.5 |
| **3 · Vacío** | El catálogo respondió `200` con **cero causales activas** — el caso del día 1 si la siembra de §6 no corrió | El selector **no se monta**; en su lugar, un párrafo y el confirmar ausente. **El botón «Rechazar la solicitud» del bloque de revisión sigue existiendo**: esconderlo haría creer que el rechazo no existe en el producto | **«Todavía no hay causales de rechazo configuradas, y sin una causal no se puede rechazar una solicitud. Avísele al equipo que administra el catálogo de FLITO.»** |
| **4 · Lleno** | N causales activas | Selector + textarea | — |

### 3.5 Copy literal — todo lo que esta HU escribe en pantalla

**Botones**

| Dónde | Texto |
|---|---|
| Bloque de revisión, primario | **«Validar»** |
| Bloque de revisión, secundario | **«Rechazar la solicitud»** — y no «Rechazar» a secas: el detalle ya tiene un «Rechazar» que es el del gestor y va a `con_novedad`. Nunca coinciden en pantalla (son estados distintos), pero sí coinciden en el archivo y en el localizador de un test |
| Confirmar la validación | **«Validar y enviar al gestor»** / **«Validar y enviar a Operaciones»** *(según el destino elegido, como ya hace la barra masiva)* |
| Confirmar el rechazo | **«Confirmar el rechazo»** |
| Cancelar, en los dos paneles | **«Cancelar»** |
| En vuelo | **«Validando…»** · **«Rechazando…»** |

**Etiquetas y ayudas**

| Dónde | Texto |
|---|---|
| Cabecera del bloque | **«Revisión de la solicitud»** |
| Línea de contexto | **«Solicitud del canal Cliente · radicada el {fecha}»** |
| Instrucción | **«Revise la factura de venta y los datos del propietario antes de validarla.»** |
| Reenvíos > 0 | **«Es el {n}.º reenvío de esta solicitud. Lo que se le pidió corregir antes está en el historial de estados, más arriba.»** |
| Cabecera del panel de validar | **«Validar la solicitud»** · nota: **«Al validarla pasa a Solicitado y entra en la cola del gestor.»** |
| Destino | **«Destino»** · vacío: **«Elija el destino…»** · opciones: **«Gestionado por Operaciones»** y el grupo **«Proveedores»** |
| Cabecera del panel de rechazo | **«Rechazar la solicitud»** · nota: **«El cliente verá la causal y la observación, y podrá corregir y volver a enviarla.»** |
| Causal | **«Causal del rechazo»** · vacío: **«Elija la causal…»** · ayuda: **«El cliente ve esta causal, tal cual, junto con su observación.»** |
| Observación | **«Observación para el cliente»** · ayuda: **«La lee la empresa cliente tal como la escriba. Dígale qué tiene que corregir. No escriba notas internas ni nombres de compañeros.»** |
| Estado de solo lectura en `rechazada` | **«Rechazada · a la espera de que el cliente corrija»** · pie: **«Rechazada el {fecha} por {nombre}»** |

**Errores por campo (AC2)**

| Situación | Texto |
|---|---|
| Causal sin elegir | **«Elija la causal del rechazo.»** |
| Observación vacía | **«Escriba la observación que va a leer el cliente.»** |
| Observación demasiado corta | **«La observación es demasiado corta. Dígale al cliente qué tiene que corregir, en una frase.»** |
| Se pulsó confirmar con errores *(banda resumen)* | **«Falta la causal o la observación. Sin las dos, la solicitud no cambia de estado.»** |

**Errores de la acción**

| Situación | Texto |
|---|---|
| `409` — ya no está en `pendiente_revision` | **«Esta solicitud ya no está pendiente de revisión: alguien la revisó mientras usted la tenía abierta.»** + botón **«Actualizar la cola»** |
| `400` — la causal ya no existe o se desactivó | **«Esa causal ya no está disponible. Vuelva a cargar las causales y elija otra.»** *(copy calcado del que comparendos ya usa para el mismo caso)* |
| Fallo genérico al validar | **«No se pudo validar la solicitud. Vuelva a intentarlo.»** |
| Fallo genérico al rechazar | **«No se pudo rechazar la solicitud. Vuelva a intentarlo.»** |

**Éxito (toast; `react-hot-toast` ya monta `role="status"`)**

| Acción | Texto |
|---|---|
| Validar | **«Solicitud validada y enviada al gestor.»** / **«Solicitud validada y enviada a Operaciones.»** |
| Rechazar | **«Solicitud rechazada. El cliente ya puede ver la causal y corregirla.»** |

> **Sobre el tono.** Todo lo de arriba va en **usted**, que es lo que pidió el hilo y lo que la #11914
> fijó para el canal. Deja una costura visible: la barra de envío masivo, dos tarjetas más arriba en
> la misma pantalla, dice **«Elige destino…»** y **«Selecciona…»**. **No se toca en esta HU** —es la
> cola de Operaciones, no del canal— y por eso el panel de validar escribe su propio **«Elija el
> destino…»** en vez de reusar la cadena de la barra. Es una divergencia consciente de dos palabras;
> unificar el tuteo del producto entero sigue siendo la decisión de PO que la #11914 dejó abierta.

---

## 4. Lo que ve el Cliente (AC3) y lo que ven los otros dos roles (AC4)

### 4.1 El Cliente: qué texto exacto, y cómo se compone

El bloque ya está escrito y montado (`CorreccionSolicitud.tsx:200-211`); se pinta **solo si llega
`causalNombre`**, y hoy no llega. Esta HU **no cambia una línea de esa vista**: lo único que hace es
llenar el dato. La composición, que es lo que faltaba especificar:

```
Por qué se rechazó                       ← <h2>, ya existe
Factura de venta ilegible                ← el `nombre` de la causal, LITERAL, en negrita
«La factura está cortada y no se ve el   ← la observación, entre comillas angulares
 número del chasis. Vuelva a escanearla
 completa.»
28/08/2026                               ← revisadoEn, formato corto
```

Cuatro precisiones sobre esa composición, y las cuatro importan:

1. **La causal se pinta literal, sin prefijo.** Nada de «Causal: …» ni «Motivo del rechazo: …». El
   `<h2>` ya hizo esa pregunta; repetirla en cada línea es ruido. **Consecuencia directa: el `nombre`
   del catálogo tiene que estar escrito para que lo lea el cliente**, y de ahí el criterio del §6.
2. **La observación va entre comillas angulares** (ya en el código). Las comillas la marcan como
   *palabras de alguien*, no como un mensaje del sistema — que es la diferencia entre «FLITO no acepta
   su factura» y «alguien miró su factura y le dice qué pasa».
3. **No aparece quién rechazó.** La #11913 le quitó al Cliente los nombres de los empleados de FLIT.
   El DTO que él recibe lleva **exactamente** `{ causalNombre, observacion, revisadoEn }` y **no**
   `revisadoPorNombre` (§5.1). Esa forma ya está declarada en `CorreccionSolicitud.tsx:60`.
4. **No se añade una línea de «qué hacer».** El subtítulo de la página ya dice «Corrija lo que se le
   indica y vuelva a enviarla»; una segunda frase con el mismo contenido es la que hace que no se lea
   ninguna de las dos.

**Y falta una puerta, que es arrastre de la #11914.** El camino diseñado allí es
`Cola → pill «Rechazada» → [Ver] → [Corregir y reenviar] → /solicitud/:id`. Medido: **«Corregir y
reenviar» no existe en el código** —el bloque de acciones del detalle (`FlitoSoat.tsx:691-718`) no
pinta nada para `esCliente`—, así que hoy la única forma de llegar a subsanar es el modal de bloqueo
del alta, es decir, intentar radicar otra vez el mismo VIN. **Delta de esta HU**, porque es la que
hace verdadero el AC3:

- En el detalle del Cliente, con `estado === rechazada`: el **mismo bloque «Por qué se rechazó»**
  (para que no tenga que navegar a otra pantalla solo para saber por qué) y un `<Link>` con aspecto de
  botón primario: **«Corregir y reenviar»** → `/flito/soat/solicitud/{id}`.

### 4.2 Qué pasa al reenviar con lo ya escrito (la otra mitad del AC3)

**Decisión: al reenviar, la causal y la observación se borran** (`causal_rechazo_id = NULL`,
`observacion_rechazo = NULL`) y `reenvios` sube en uno. La fila es la misma —mismo `id`, mismo VIN, el
`UNIQUE` lo garantiza—; lo que cambia es que la razón del rechazo **ya no describe nada vigente**.

Si no se borran, el siguiente revisor abre una solicitud en `pendiente_revision` con un bloque que le
dice por qué se rechazó **la versión anterior**, y no tiene forma de saber si eso sigue pasando: es un
dato correcto en el momento equivocado, que es la peor clase de dato en una pantalla de revisión.

**Lo que no se pierde:** el rastro va a `flito_estado_historial`, que ya existe, ya está montado en el
detalle y **ya está oculto al Cliente** (`!esCliente`, `:671`). El rechazo escribe ahí su `motivo`
compuesto —causal + observación—, y el lector externo lo recibe en `null` por el recorte que la #11913
dejó puesto (`estado-historial.ts:143`, `lectorExterno`). Las columnas de la satélite guardan **el
rechazo vigente**; el historial guarda **lo que pasó**. Son dos preguntas y cada una tiene su sitio.

Lo demás no cambia: la placa y el VIN no viajan en el `PATCH` (ya decidido en la #11914), el adjunto
es opcional y si no se sube otro se conserva el que había.

### 4.3 `proveedor` y `cliente` no validan ni rechazan — y la ausencia es estructural

| Rol | Qué ve en el detalle de una solicitud del canal | Por qué |
|---|---|---|
| **`proveedor`** (gestor) | **Nada: la fila no existe para él.** `ESTADOS_SOAT_VISIBLES_GESTOR` es `['solicitado','pagado']` y es una **lista blanca** aplicada en `condicionesCola()`; el detalle pasa por `buscarConAcceso()`, que devuelve `404`. No hay botón que ocultar porque no hay pantalla | Estructural, ya existe. **Esta HU no añade ninguna regla sobre el rol `proveedor`** |
| **`proveedor`, después de validar** | La fila entra en su cola en `solicitado`, con las acciones que ya tenía (cargar factura, rechazar a `con_novedad`). Nada nuevo | Es el punto de confluencia del ADR §8: desde `solicitado` los dos orígenes son el mismo flujo |
| **`auditor`** | El bloque de revisión **en solo lectura**: la causal y la observación de una `rechazada`, sin ningún botón. Ya se lo garantiza el `!soloLectura` que envuelve las acciones (`:691`), más el cartel «Solo lectura · Auditoría observa, no ejecuta acciones» que ya se pinta | Es interno y su trabajo es leer |
| **`cliente`** | El estado, y si es `rechazada` el bloque «Por qué se rechazó» + «Corregir y reenviar» (§4.1). **Ningún botón de validar ni de rechazar, ni siquiera deshabilitado** | Un botón `disabled` sin explicación es peor que su ausencia; y uno que da `403` es la interfaz prometiendo lo que el servidor niega |

**La guarda que hace todo esto verdadero es una sola**, y hay que escribirla así y no de otra forma:

```
esOperaciones && !soloLectura && estado === PENDIENTE_REVISION   → los dos botones
```

**Nunca `!esCliente`**, que es la forma tentadora: se la daría al gestor y al auditor. Y nunca un
`if (role === 'proveedor') return null`, que es la lista negra que el ADR §4 acaba de sacar del router.

---

## 5. Datos: lo que hay que pedir, y lo que hay que NO pedir

### 5.1 El detalle gana `solicitud`, con proyección por rol

Forma mínima, ya anticipada por la #11914 (requerimiento 2 de su §7) y por
`CorreccionSolicitud.tsx:60`:

```
solicitud: {
  causalNombre: string | null,
  observacion: string | null,
  revisadoEn: string | null,
  reenvios: number,
  solicitadoEn: string,
  revisadoPorNombre?: string | null,   // SOLO admin y auditor
} | null
```

- **`revisadoPorNombre` nunca para el `cliente`.** Es el nombre de un empleado de FLIT y es
  exactamente lo que la #11913 retiró del historial. Se sirve a `admin` y `auditor` porque el lector
  es interno y necesita saber a quién preguntar.
- **Nada de esto para el `proveedor`**, en ningún estado. Es la razón entera de que el ADR §1.2 sacara
  estos campos de `flito_soat`: `buscarConAcceso()` selecciona la fila **entera** y se la sirve a las
  rutas del gestor.
- `solicitud` es `null` cuando `origen = 'tramite'`. No se inventa un objeto vacío: la ausencia
  distingue los dos tipos de fila sin una columna `origen` en el DTO.

### 5.2 `GET /flito/soat/causales-rechazo` — y por qué el Cliente NO lo necesita

`[{ id, nombre }]`, solo las activas, ordenadas por `orden` y, **a igualdad, por `nombre`**: `orden`
no es único —dos causales pueden compartir el 3— y sin el desempate el selector cambia de orden entre
peticiones (el mismo detalle que comparendos ya documenta en `CausalesComparendos.tsx:116`).

**Solo `admin`.** El ADR §6 #4 lo abría también a `cliente`; con este diseño **no hace falta y no debe
abrirse**: el Cliente recibe el `causalNombre` ya resuelto dentro de su detalle, así que el catálogo
completo —qué otras cosas rechaza FLITO— es información de la operación que él no necesita para nada.
Una entrada menos en la allowlist es una decisión de exposición menos que justificar.

### 5.3 Los tres cambios sin los cuales algo de esta HU no funciona

| # | Cambio | Qué se rompe sin él |
|---|---|---|
| 1 | `ESTADOS` de `flito-soat.routes.ts:53` gana `pendiente_revision` y `rechazada` | La pill nueva se ignora **en silencio** y la cola devuelve todo, presentándolo como el resultado del filtro (§1.1) |
| 2 | `canal-cliente.ts` gana `{ PATCH, '/api/flito/soat/:id/solicitud' }` con su `porque` | El AC3 es un `403`: el botón «Reenviar la solicitud» ya está escrito contra ese endpoint (`CorreccionSolicitud.tsx:181`) y la allowlist lo niega antes de llegar al router |
| 3 | Discriminadores estables en los cuerpos de error (`{ error: { code: 'estado_invalido' \| 'causal_desconocida' \| … } }`) | La pantalla no puede distinguir el `409` de «ya la revisaron» del `400` de «esa causal se desactivó» leyendo prosa, y los dos tienen arreglos distintos (§3.5) |

> ⚠ **Una frase del repo que miente y que puede desviar la implementación.**
> `estado-historial.ts:137-138` dice: *«el motivo del rechazo del gestor le sigue llegando por
> `motivoRechazo` en el DTO del detalle, que es decisión de producto tomada (lo necesita la #11915
> para subsanar)»*. **La #11915 no necesita `motivoRechazo` para nada.** `motivoRechazo` es el rechazo
> del **gestor**, el que va a `con_novedad` (`flito-soat.service.ts:821-838`); la subsanación se apoya
> en la causal y la observación de la satélite. Quien implemente esto leyendo ese comentario puede
> acabar escribiendo el rechazo del canal en `motivoRechazo` — y entonces el Cliente vería el párrafo
> rojo crudo de `FlitoSoat.tsx:687` («Motivo de rechazo: …»), sin causal, en vez de su bloque. **No se
> escribe ni se lee `motivo_rechazo` en ninguna parte de esta HU.**

*(La migración de `GET /?buscar=` a `POST /buscar` que el ADR §6 asigna a esta HU es un cambio de
transporte: retira cuasi-PII de la query y **no cambia nada de la interfaz** —mismo cuadro de
búsqueda, mismo `useDebounce`, mismo resultado—. No tiene diseño y por eso no ocupa más que esta
línea.)*

---

## 6. PROPUESTA DE NEGOCIO — la lista de causales · **para que David la ajuste**

> 🟡 **Esto es contenido de negocio, no de diseño.** La tabla `flito_soat_causales_rechazo` existe
> desde la `0167` y está **vacía**; esta HU la siembra. Lo de abajo es una propuesta razonada a partir
> de lo que de verdad entra en el alta, **no** una decisión tomada. Cámbiela entera si hace falta: lo
> único que el diseño necesita es que sean **pocas**, que **no se solapen** y que cada una **le diga
> al Cliente qué hacer**.

### 6.1 De dónde sale: lo que el Cliente aporta, y lo que puede estar mal

| Lo que entra en el alta | ¿Puede estar mal? |
|---|---|
| **Placa y VIN** | **No, a efectos de rechazo.** Los valida el RUNT en la preconsulta: si no cuadran, la solicitud **ni se crea**. Una causal sobre esto sería para un caso que la pantalla anterior ya impide |
| **Marca, línea, modelo, clase, servicio, cilindraje, organismo** | **No.** Los trae el RUNT, no se teclean, y el propio formulario ya dice qué hacer si están mal: corregirlos ante el organismo de tránsito |
| **Tipo y número de documento del propietario** | **Sí.** Los teclea el Cliente y tienen que cuadrar con la factura de venta |
| **Nombre o razón social** | **Sí.** Igual |
| **Correo, teléfono, dirección** | **Sí, por ausencia.** Son opcionales en el alta (así lo tiene la base) |
| **Factura de venta (PDF)** | **Sí, y es lo que más falla.** Ilegible, cortada, de otro vehículo, o directamente otro documento |

### 6.2 Las cinco propuestas

| `orden` | `nombre` (así, literal, es lo que lee el Cliente) | Cuándo se usa | Qué le dice que haga |
|---|---|---|---|
| 1 | **Factura de venta ilegible** | El PDF está borroso, cortado, torcido o incompleto | Volver a escanearla y subirla |
| 2 | **La factura de venta no corresponde al vehículo** | Se lee bien, pero es de otro vehículo o es otro documento (una cotización, la tarjeta de propiedad) | Adjuntar la factura de **ese** vehículo |
| 3 | **Los datos del propietario no coinciden con la factura de venta** | El nombre o el documento que tecleó no son los de la factura | Corregir el propietario, o adjuntar la factura correcta |
| 4 | **Faltan datos de contacto del propietario** | Hace falta correo o teléfono para gestionar la póliza y vinieron vacíos | Añadir correo y teléfono |
| 5 | **Se necesita otro documento** | El caso previsto que no cabe en las cuatro anteriores: un soporte adicional que ese vehículo o ese servicio exige | Lo dice la observación |

Sembradas con `INSERT … ON CONFLICT (nombre) DO NOTHING`, patrón exacto de la `0150` con las causales
de comparendos. `activo = true`, `orden` 1..5. **Sin pantalla de administración en esta HU**: si más
adelante hay que mantenerlas, `CausalesComparendos.tsx` es el precedente y es otra HU.

### 6.3 El criterio con el que se escribieron, por si hay que añadir una sexta

**Si no se puede leer en voz alta por teléfono a la empresa cliente, no es un nombre de causal
válido.** Es la consecuencia directa de que el `nombre` se le pinte literal (§4.1): estas cadenas no
son etiquetas de clasificación interna, son **la primera frase que el Cliente lee sobre su rechazo**.
Por eso ninguna es un sustantivo suelto («Documentación», «Datos») ni una abreviatura operativa: cada
una es una **afirmación completa sobre su solicitud**.

Los ejes son disjuntos a propósito: **1 y 2** hablan del archivo (¿se lee? / ¿es el de este
vehículo?), **3 y 4** hablan de lo tecleado (¿coincide? / ¿está completo?), y **5** es el desagüe.
Sin esa separación, un revisor con prisa mete todo en la primera de la lista y el catálogo deja de
medir nada.

### 6.4 Lo que se descartó, y por qué — que es la mitad de la propuesta

| Causal descartada | Motivo |
|---|---|
| **«Solicitud duplicada»** | Imposible por construcción: `flito_soat.vin` es `NOT NULL UNIQUE` (RN-01) y el modal del AC4 la para en el alta. Una causal para un caso que la base no permite es una causal que solo se usa por error |
| **«El vehículo ya tiene SOAT vigente»** | Lo bloquea la preconsulta contra el RUNT con su propio modal, antes de que exista la solicitud |
| **«Datos del vehículo incorrectos»** | Los trae el RUNT y no se editan; el arreglo no está en FLITO sino en el organismo de tránsito, y el formulario ya lo dice. Ponerla mandaría al Cliente a corregir un campo que no existe |
| **«La solicitud no procede» / «Rechazo definitivo»** | 🔴 **La más importante de las descartadas.** El canal **no tiene estado terminal de negación**: `rechazada` significa «corrija y reenvíe» y el único camino de salida es `rechazada → pendiente_revision` (ADR §8). Una causal así deja la solicitud en un bucle —el Cliente corrige algo que no tiene arreglo, reenvía, se le vuelve a rechazar—. **Si FLITO necesita poder negar en firme, es un estado nuevo y otra HU**, y conviene decidirlo antes de que pase la primera vez |
| **«Otro motivo»** | Un desagüe sin dirección se lleva todo y el catálogo deja de medir. La n.º 5 es el desagüe, pero **acotado a una acción** («se necesita otro documento»), así que la observación tiene que decir cuál |

### 6.5 Lo que esta propuesta resuelve de paso

La #11914 dejó abierta una pregunta al PO: *¿correo y teléfono del propietario son obligatorios?* La
causal n.º 4 la responde sin cerrar ninguna puerta: **siguen opcionales en el alta** —que es lo que
dice la base— y, cuando en un caso concreto hagan falta, se piden por rechazo. Hacerlos obligatorios
para todos por un caso que quizá sea el 5% es cobrarle a todos los clientes el peaje de una minoría.

---

## 7. Accesibilidad

**Foco**

| Momento | Dónde va |
|---|---|
| Al abrir el panel de **validar** o el de **rechazar** | Al `<h3>` del panel (`tabIndex={-1}`), que es **lo nuevo que apareció**. Es el mismo criterio que la #11914 aplicó con la ficha «Datos del RUNT», y aquí además hace que el lector anuncie el nombre del bloque antes de que el usuario tabule a los campos — donde encontrará el aviso de «la lee la empresa cliente» como descripción del textarea. **Sin esto el foco cae a `<body>`**: el botón que se pulsó desaparece al montarse el panel |
| Al fallar la validación de campos | **Al primer campo inválido**, no al mensaje. Al enfocar el control, el lector anuncia etiqueta + inválido + descripción de una vez (criterio ya implementado en `FlitSelect.tsx:135` y en `useFocoPrimerError`, que se puede reusar tal cual) |
| Al cancelar un panel | Al botón que lo abrió, que vuelve a existir |
| **Tras validar o rechazar con éxito** | El modal se cierra y la cola se refresca. **El foco no puede quedar en `<body>`.** Si la fila sigue en la página, `FlitModal` lo devuelve a su botón «Ver» (las filas llevan `key={f.id}`, así que el nodo sobrevive al refresco). Si la fila **sale de la vista** —el caso normal: el revisor está filtrando por «Pendiente de revisión»— hay que pasar `restoreFocusRef` apuntando al grupo de pills de estado, que es donde sigue trabajando |

**`aria` y anuncios**

- `aria-invalid="true"` en la causal y en la observación **solo mientras hay error**, con
  `aria-describedby` al `<p role="alert">` del mensaje. Se quita en cuanto el campo se corrige:
  dejarlo puesto convierte la marca en ruido.
- **`role="alert"` para lo que impide continuar**: los errores por campo, la banda resumen, el fallo
  del `POST` y el fallo del catálogo. **`role="status"` para lo que solo informa**: «Cargando
  causales…», «Validando…», «Rechazando…».
- **El cambio de estado se anuncia por el toast y solo por el toast.** `react-hot-toast` ya monta
  `role="status"`; la cola refrescada **no** añade una segunda región viva con el mismo contenido
  (regla de la #11914: una sola región por mensaje).
- **El contador `0/500` no es una región viva.** Un `aria-live` que se dispare en cada tecla es la
  forma más rápida de que alguien apague el lector. Va como texto normal, enlazado por
  `aria-describedby` junto con la ayuda.
- **El chip lleva texto, no solo color** — «Rechazada · a la espera de que el cliente corrija» ya lo
  cumple; `StatusChip` lo hace por defecto.

**PII y a11y a la vez**

- **Prohibido meter el VIN, el documento del propietario o la observación en un `aria-label`, un
  `title` o un `data-*`.** Los selectores de axe arrastran valores de atributo hasta 31 caracteres y
  acabarían en el informe de accesibilidad. La placa basta para nombrar una fila.
- `QA_AXE_CDN=1` al correr los E2E de accesibilidad, o salen ~10 rojos que no son regresión.

**Contraste y tema**: cero tokens nuevos. `--flit-danger-ink`, `--flit-text-secondary` y
`--flit-blue-text` ya están en uso en esta pantalla. `npm run check:contraste` **no acredita nada de
esto**: su alcance real es la ⌘K y los gradientes.

---

## 8. Notas para QA — 10 asertos, cada uno con su mutante

Sesión `ADMIN` para 1-7 y `CLIENTE_USER` para 8-10 (ya existen, `e2e/helpers/auth.ts`).

| # | AC | Aserto | Mutante que debe matar |
|---|---|---|---|
| 1 | AC1 · encontrar el trabajo | Pulsar la pill «Pendiente de revisión» y comprobar que **la petición lleva `estado=pendiente_revision`** y que **todas** las filas devueltas tienen ese chip | No añadir el estado al `ESTADOS` del servidor: la pill se pinta, el filtro se cae en silencio y la cola devuelve todo. **Afirmar solo que la pill existe no lo mata**; hay que afirmar el resultado |
| 2 | AC1 · qué acción aplica a cuál | En una fila `pendiente`: hay checkbox y **no** hay «Validar». En una `pendiente_revision`: hay «Validar» y **`getByRole('checkbox')` → `toHaveCount(0)`** en esa fila | Habilitar la selección en lote para el canal: se aprobarían diez solicitudes sin abrir una sola factura |
| 3 | AC1 · la puerta trasera | En el detalle de una `pendiente_revision`, `getByRole('button', {name:/Reversar\|Cambiar proveedor/})` → `toHaveCount(0)` | Dejar «Reversar» como está hoy (sin condición de estado): reversar a `pendiente` mete en `POST /enviar` una solicitud que nadie validó, y `reversar()` no valida el estado de origen |
| 4 | AC1 · validar | Elegir destino, confirmar: **una sola** petición a `/validar` con el destino en el cuerpo, la fila pasa a «Solicitado» y hay toast. Y el botón queda `disabled` mientras está en vuelo | Botón sin `disabled`: doble clic = dos validaciones; la segunda da `409` y el admin ve un error inexplicable tras un éxito |
| 5 | AC2 · las dos obligatorias | Confirmar el rechazo con causal y **sin** observación → `role="alert"` con «Escriba la observación…», `aria-invalid="true"` en el textarea, **el foco en el textarea**, y **ninguna petición a `/rechazar-solicitud`** | Validar solo la causal. El aserto de la **petición no enviada** es el que lo caza: sin él, un servidor permisivo dejaría pasar el test |
| 6 | AC2 · catálogo vacío | `GET /causales-rechazo` → `[]`: se ve «Todavía no hay causales de rechazo configuradas…», **no hay selector** y **no hay «Confirmar el rechazo»** | Pintar un selector vacío: el admin elige nada, confirma, y come un `400` que no puede arreglar |
| 7 | AC2 · el aviso de que lo lee un tercero | El textarea tiene `aria-describedby` apuntando a un texto **visible** que contiene «la lee la empresa cliente» | Mover el aviso a un `title` o quitarlo: es la única contención de la fuga de lenguaje interno hacia una empresa tercera |
| 8 | AC3 · qué ve el Cliente | Tras el rechazo, en la vista de subsanación: se ve el `nombre` **exacto** de la causal y la observación **entre comillas**, y `getByText(/{nombre del revisor}/)` → `toHaveCount(0)` | Servir `revisadoPorNombre` al `cliente`. Solo lo mata el aserto **negativo** |
| 9 | AC3 · el reenvío limpia | Reenviar y volver a abrir la solicitud como **admin**: el bloque de revisión **no** muestra la causal anterior, dice «Es el 1.º reenvío», y esa causal **sí** sigue en el historial de estados | No borrar las columnas al reenviar: el revisor lee una razón vigente que ya no lo es |
| 10 | AC4 · la ausencia | Como `cliente` en el detalle de su `pendiente_revision`: `getByRole('button', {name:/Validar\|Rechazar/})` → `toHaveCount(0)`, **incluidos los deshabilitados** (`{includeHidden:true}` no basta: hay que afirmar sobre el DOM entero del modal). Como `proveedor`, el `GET /:id` de esa solicitud → **404** | Gobernar el bloque con `!esCliente`: se lo daría al gestor y al auditor. El aserto del `404` del gestor es el que prueba que la frontera está en el servidor y no en la pantalla |

> **Infraestructura, que no es un detalle:** el CI corre **un** spec E2E (el visor de PDF). Cualquier
> spec de esta HU hay que **añadirlo a la lista fija del nocturno** y correrlo a mano antes de cerrar;
> verde en el PR no significa que nadie lo haya ejecutado. Y comprobar el `cwd` del dev server: con
> varios worktrees, `reuseExistingServer` puede estar certificando otra rama.

---

## 9. Decisiones y descartes (resumen citable en el PR)

| # | Decisión | Descarte principal |
|---|---|---|
| 1 | **`ESTADOS_ADMIN` aparte** para las pills; `ESTADOS_OPERACIONES` se queda solo como destinos de la reversa | Añadirle los dos estados: habilita reversar a `pendiente_revision`, que el ADR §8 prohíbe, y ningún test lo mira |
| 2 | Las acciones heredadas del detalle se condicionan **por estado**, no por rol | Dejar «Reversar» sin condición: es un camino real que salta la revisión entera |
| 3 | «Validar» abre un **panel con el destino obligatorio**; el confirmar dice a dónde va | Un botón de un clic: dejaría el SOAT en la cola de nadie y sin ANS |
| 4 | **Sin validación en lote** | Casilla para `pendiente_revision`: aprobar diez facturas sin leer ninguna |
| 5 | El rechazo es un **componente propio** con dos campos y **valida al pulsar**, no un `FormMotivo` con el botón muerto | Reusar `FormMotivo`: con dos campos, un `disabled` no dice cuál falta, y «corta» no es «vacía» |
| 6 | El aviso de que **lo lee una empresa tercera** va en el rótulo + ayuda visible + contador | Un tooltip: se lee después de haber escrito, que es tarde |
| 7 | El catálogo se carga **al abrir el formulario**, con sus 4 estados, **incluido el vacío** | Cargarlo al montar la cola (casi ninguna apertura acaba en rechazo) o darlo por lleno (nace vacío) |
| 8 | **Al reenviar se borran causal y observación**; el rastro queda en el historial | Conservarlas: el siguiente revisor lee una razón que ya no describe nada |
| 9 | `GET /causales-rechazo` **solo para `admin`** | Abrirlo al `cliente` como decía el ADR §6: no lo necesita, y sería una entrada más en la allowlist sin uso |
| 10 | **Cinco causales**, sin «no procede» ni «otro motivo» | «No procede» deja la solicitud en bucle: el canal no tiene estado terminal de negación (§6.4) |
| 11 | Se añade **«Corregir y reenviar»** al detalle del Cliente | Dejar el único camino por el modal de bloqueo del alta, es decir, obligarle a intentar radicar dos veces |

---

## 10. Preguntas abiertas (dos, y las dos son de producto)

1. **La lista de causales del §6.** Es una propuesta. Los cinco nombres son lo que el Cliente lee
   literal, así que cambiarlos después de la primera solicitud rechazada cambia lo que ya se le dijo a
   alguien. Conviene cerrarla **antes** del merge, no después.
2. **¿Hace falta poder negar una solicitud en firme?** Hoy no existe: `rechazada` significa «corrija y
   reenvíe» y no hay salida terminal (§6.4). Es una carencia del **Feature**, no de esta HU, y esta HU
   funciona sin resolverla — pero se va a notar la primera vez que alguien pida un SOAT que FLITO no
   puede tramitar.
