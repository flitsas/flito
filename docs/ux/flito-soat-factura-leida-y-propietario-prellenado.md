# UX slim — La factura se lee sola y el propietario llega prellenado (HU #12094)

> **Qué es este documento.** Entrada del `frontend-agent` para la
> [#12094](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12094) (Feature #12073).
> Modo **slim**: no hay ruta nueva, ni `PageSlug` nuevo, ni pantalla nueva. Rellena el **bloque 2** que
> la #12091 dejó preparado y vacío a propósito.
>
> **Continúa a `docs/ux/flito-soat-alta-por-vin-y-ficha-completa.md` (#12091), y no lo revisa.** El
> orden de los tres bloques, el foco, la ficha del RUNT, los desenlaces de la consulta, la primaria
> única y el copy de los modales quedan **tal como están**. Aquí solo se añade lo que aquel documento
> nombró como «el sitio reservado para la #12094» (§4.4).
>
> **Canal Cliente: se habla de usted.** Todo el copy nuevo de este documento está en usted, igual que
> el resto de la pantalla.
>
> **Fuera de alcance, escrito para que nadie lo amplíe de paso:** la cola, el detalle de Operaciones,
> la ayuda y los correos no se tocan. **No** se pinta la procedencia campo a campo (§6). **No** se
> muestra el porcentaje de confianza del OCR (§4, decisión 3). **No** se crea endpoint alguno: los dos
> que hacen falta ya están en `develop` y verificados en este worktree (§7).

---

## 1 · Superficie tocada

| | |
|---|---|
| **Página** | `apps/web/src/pages/FlitoSoatSolicitud.tsx` (`Alta`) — **bloques 2 y 3**, y la frase de faltantes (`#sol-falta`) |
| **Componentes** | `components/flito/soat-cliente/bloques.tsx`: `BloqueFactura`, `BloquePropietario`, `CamposDocumento`, `Campo` |
| **Patrón calcado** | `pages/FlitoRevisiones.tsx` — chip de confianza sobre la etiqueta + input editable debajo (líneas 172–193) y la rejilla de contraste «Campo · Trámite · Leído del PDF» (líneas 152–170). Se calca la **estructura**, no el copy interno (§4) |
| **Slug / permiso** | `flito_soat`. **Ninguno nuevo.** Gate por capacidad `puedeSolicitarSoat(user)`, sin cambios |
| **Roles** | `cliente` con canal habilitado. Las dos tarjetas de salida no se tocan |
| **Endpoints** | `POST /api/flito/soat/cliente/factura/lectura` (HU #12092) · `POST /api/flito/soat/cliente` con el campo `procedencia` (HU #12093). **Los dos existen ya** — ver §7 |
| **Requerimientos nuevos de datos** | **Ninguno.** Nada que pedirle a `architecture-agent` ni a `backend-agent` |
| **PII** | El PDF y los nueve datos del comprador viajan **solo en el cuerpo de dos `POST`**. La URL sigue sin parámetros. Ningún valor leído entra a un `aria-label`, a un chip ni a la frase de faltantes: ahí van **etiquetas**, como ya manda `ETIQUETA_CAMPO` |
| **Patrón visual** | `Seccion` + `chip`, `StatusChip`, `Campo`, `flitBtnSecondary`, `FlitUploadBox`. **Cero componentes nuevos, cero tokens nuevos, cero animaciones** |

---

## 2 · Delta de claridad — de digitar a revisar

**Qué vino a hacer quien abre esto:** lo mismo que ayer — pedir el SOAT de un vehículo recién
comprado. Lo que cambia no es el objetivo, es **el verbo del bloque 3**: pasa de *escribir diez
campos* a *revisar ocho que ya están escritos y teclear el correo*.

**Qué se ve primero: sigue siendo el VIN.** Esta HU no toca el bloque 1 y no le disputa la apertura.

**La única primaria sigue siendo «Enviar al gestor».** Ni la lectura ni el reintento ni la banda de
sobrescritura llevan peso de primario: **todos sus botones son `flitBtnSecondary`**. La lectura
arranca sola (AC1), así que ni siquiera hay un botón «Leer la factura» que pudiera competir.

### La pregunta difícil: cómo se ve *prellenado por la factura* sin parecer deshabilitado ni error

**Con el campo tal cual, sin ninguna marca propia.** Un campo prellenado por lectura confiable se
pinta **exactamente igual** que uno tecleado: mismo `Campo`, mismo `flitInp`, sin fondo gris, sin
candado, sin `readOnly`, sin borde de color, sin etiqueta «de la factura». Todo lo que diferencie
visualmente ese input de sus vecinos se lee como «no lo toque», y el AC2 pide justo lo contrario:
**todos editables, tipo y número incluidos**.

Lo que dice de dónde salieron esos valores es el **contexto, no cada campo**, en tres sitios y solo
tres:

1. El chip **«✓ Factura leída»** en el encabezado del bloque 2, hermano del «✓ Consultado» del
   bloque 1 — la pantalla ya tiene ese vocabulario.
2. La **línea de encabezado del bloque 3**, que cambia de «Escriba el propietario…» a «Estos datos los
   tomamos de su factura de venta…» (§3.4). Es una línea, no nueve.
3. El **momento**: los valores aparecen a la vez que el chip, delante del usuario, como consecuencia
   visible de haber adjuntado el PDF.

Y el color se reserva: **ámbar significa «haga algo aquí»** y lo llevan únicamente los campos de baja
confianza (§4). Si los ocho prellenados llevaran también una marca, la de los dos que sí piden
revisión dejaría de distinguirse — que es exactamente lo que el AC3 necesita que se distinga.

**Qué se calla, y dónde vive:**

| Se calla | Dónde vive |
|---|---|
| El porcentaje de confianza del OCR (`68 % · no confiable`) | En ninguna parte del canal Cliente. Es la métrica del umbral, no una instrucción; el Cliente no puede hacer nada distinto con un 68 que con un 84 (§4, decisión 3) |
| La procedencia campo a campo (`factura` / `manual` / `runt`) | **Viaja en el envío, no se pinta** (§6). Quien la necesita es Operaciones |
| Que hubo dos pasadas de modelo, escalación, umbral, motor caído | Fuera. El Cliente lee «no pudimos leerla» y qué hacer |
| El nombre del propietario que reporta el RUNT | Donde ya estaba: la línea de referencia del bloque 3, **jamás prellenado** (#12091). Esta HU **no** la cambia |

**Densidad: el trabajo se alivia, la tinta se contiene.** El bloque 3 pasa de diez campos vacíos a
ocho escritos y uno por teclear (el correo). Lo que se añade es una capa de revisión que **solo
aparece donde hay algo que revisar**: ningún adorno en el caso confiable, un chip y un botón en el
caso dudoso. Sin esa contención, esta HU convierte el formulario en un cuestionario de nueve
confirmaciones — ver la pregunta abierta de §9.

---

## 3 · Los 4 estados del bloque 2, con copy exacto

El bloque 2 es una `<Seccion titulo="2 · Factura de venta">` con `chip`, como el bloque 1. Los cuatro
estados son de **la lectura**, no del archivo: el archivo ya tenía los suyos en `FlitUploadBox`
(`idle | uploading | verified | rejected`) y **no se tocan**.

### 3.1 Sin factura (vacío)

```
┌─ 2 · Factura de venta ───────────────────────────────────────────────────────┐
│      ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐                       │
│                      ⬆  Factura de venta del vehículo *                      │
│                         Un solo archivo PDF · máximo 15 MB                   │
│      └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘                       │
│  Al adjuntarla, FLITO la lee y llena los datos del propietario. Usted los     │
│  revisa y corrige lo que no cuadre.                                          │
└──────────────────────────────────────────────────────────────────────────────┘
```

Esa línea **ya se puede escribir**: la #12091 la prohibió porque entonces habría sido mentira (su
decisión 9). Hoy es verdad y hace falta, porque explica por qué el bloque 2 va delante del 3.

**Bloque 3:** como hoy. Diez campos vacíos y su línea «Escriba el propietario como aparece en la
factura de venta: son los datos que van en la póliza.»

### 3.2 Leyendo (cargando)

```
┌─ 2 · Factura de venta ─────────────────────────────── Leyendo la factura… ───┐
│  [ caja con el archivo · factura-1234.pdf · 1,2 MB ]   [ Quitar el archivo ] │
│  ⟳ Leyendo la factura… Puede tardar hasta un minuto. Mientras tanto puede    │
│    seguir llenando el formulario.                                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Chip `tone="active"`: **«Leyendo la factura…»**.
- Aviso en **`role="status"`** (AC1, literal): **«Leyendo la factura… Puede tardar hasta un minuto.
  Mientras tanto puede seguir llenando el formulario.»**
- **Nada se deshabilita.** Ni el bloque 3, ni «Quitar el archivo», ni el primario. La lectura es una
  ayuda; bloquear el formulario mientras dura la convertiría en un peaje (AC5).
- **No hay esqueleto en el bloque 3** y es deliberado: sus campos ya están montados y el usuario puede
  estar escribiendo en ellos. Un esqueleto se llevaría por delante lo que acaba de teclear.
- ⟳ es el carácter del aviso, **no una animación**. Sin spinner, sin barra de progreso.

**Bloque 3:** intacto y utilizable. Si el usuario tecleó algo mientras se leía, ese valor **no se
pisa**: entra por la banda de §5, que es el mismo mecanismo del AC6 y no un segundo camino.

### 3.3 No se pudo leer (error + reintento)

```
┌─ 2 · Factura de venta ──────────────────────────── No se pudo leer ──────────┐
│  [ caja con el archivo · factura-1234.pdf · 1,2 MB ]   [ Quitar el archivo ] │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ No pudimos leer la factura.                                            │  │
│  │ No es un problema de su archivo: el lector no respondió. Puede volver   │  │
│  │ a leerla, o escribir los datos del propietario a mano y enviar igual.   │  │
│  │ [ Volver a leer la factura ]                                            │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

Chip `tone="warning"`: **«No se pudo leer»**. La banda va en `role="alert"`, dentro del bloque 2, con
el botón secundario **«Volver a leer la factura»**. Se ramifica **por código**, como todo en esta
pantalla:

| Caso | Copy |
|---|---|
| `503` (OCR no disponible) | **«No pudimos leer la factura.»** / **«No es un problema de su archivo: el lector no respondió. Puede volver a leerla, o escribir los datos del propietario a mano y enviar igual.»** |
| Sin red | **«No pudimos comunicarnos con FLITO para leer la factura.»** / **«Compruebe su conexión y pulse Volver a leer la factura. También puede escribir los datos a mano y enviar igual.»** |
| `429` (límite del canal) | **«Ha hecho varias lecturas seguidas y toca esperar unos minutos.»** / **«Puede escribir los datos del propietario a mano y enviar la solicitud igual.»** |
| `413` (archivo demasiado grande) | **No es de aquí**: lo atrapa `errorArchivo` antes de subir nada, con el copy que ya existe. La lectura ni se lanza |
| `400 archivo_no_pdf` | **No es de aquí**: es el `rejected` de `FlitUploadBox` con su `role="alert"` de siempre. Si el PDF no es PDF, no hay archivo adjunto **ni** lectura que reintentar |
| Rama por defecto | **«No pudimos leer la factura en este momento.»** / **«Vuelva a leerla, o escriba los datos del propietario a mano y envíe igual.»** |

Las cuatro frases dicen la **misma salida**: se puede seguir sin lectura. Es el AC5 escrito en el
copy y no solo en el comportamiento.

**Bloque 3:** intacto, vacío, con su línea de «Escriba el propietario…». **La lectura fallida no añade
ni un solo pendiente** a `#sol-falta`: lo que bloquea el envío es lo de siempre.

### 3.4 Leída (lleno)

```
┌─ 2 · Factura de venta ─────────────────────────────── ✓ Factura leída ───────┐
│  [ caja con el archivo · factura-1234.pdf · 1,2 MB ]   [ Quitar el archivo ] │
│  Tomamos 8 datos del propietario de esta factura y los escribimos abajo.      │
│  Revíselos antes de enviar.                        [ Volver a leer ]          │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Chip `tone="success"`: **«✓ Factura leída»**.
- Línea en `role="status"`: **«Tomamos {n} datos del propietario de esta factura y los escribimos
  abajo. Revíselos antes de enviar.»** — plural fijo; el caso `n = 1` se redacta **«Tomamos 1 dato del
  propietario de esta factura y lo escribimos abajo. Revíselo antes de enviar.»**
- **Lectura vacía (0 datos): sigue siendo «leída», y el copy no miente.** Sin chip, y la línea dice:
  **«No pudimos sacar los datos del propietario de esta factura. Escríbalos a mano: la solicitud se
  puede enviar igual.»** en `role="status"` (no `alert`: no falló nada). Es el otro medio AC5 — el
  caso que el propio diseño del backend anticipa cuando el motor local devuelve las nueve claves
  vacías.
- **«Volver a leer»**, secundario, siempre visible con archivo adjunto. Es lo que dispara el AC6.

**Bloque 3:** los valores aparecen escritos y **su línea de encabezado cambia**:

> **«Estos datos los tomamos de su factura de venta. Revíselos y corrija lo que no cuadre: son los que
> van en la póliza. El correo electrónico sí lo tiene que escribir usted.»**

Esa última frase no es relleno: tras una lectura perfecta, **el correo es el único campo que queda
vacío entre nueve llenos** (el OCR no lo extrae, AC2), y sin decirlo se lee como un fallo de la
lectura.

---

## 4 · Baja confianza: cómo se marca y cómo se confirma «uno a uno»

### 4.1 La marca (patrón de `FlitoRevisiones`, copy de canal Cliente)

```
│  Municipio *                          [ ⚠ Revise este dato ]  [ Confirmar ]  │
│  [ MEDELLIN                        ]                                         │
│  Lo leímos de la factura y no quedamos seguros. Compruébelo y confírmelo.    │
```

Se calca de `FlitoRevisiones.tsx` (172–193) **la estructura exacta**: fila de etiqueta con
`StatusChip` a la derecha, input normal debajo. Lo que **no** se calca es el interior del chip.

| | Revisiones (operador) | Aquí (Cliente) |
|---|---|---|
| Chip | `68% · no confiable` | **`⚠ Revise este dato`**, `tone="warning"` |
| Confirmado | — (el operador firma el conjunto con un motivo) | **`✓ Revisado`**, `tone="success"`, y el botón desaparece |
| Sin lectura | `Sin lectura`, `tone="neutral"` | **Nada.** Un campo que no se leyó es un campo vacío normal |

**Un campo solo lleva la marca si tiene valor.** `confiable: false` con `valor: null` es «no se leyó»,
y marcarlo sería pedirle al usuario que revise un campo en blanco. Es además la trampa que rompería
la pantalla entera: con una factura ilegible, el backend devuelve las nueve claves en
`{valor: null, confianza: 0, confiable: false}` y una marca por `confiable` a secas pondría **nueve
avisos ámbar y un envío bloqueado sin nada que confirmar** — el AC3 tumbando al AC5.

### 4.2 La confirmación, uno a uno, sin cuestionario

Dos gestos, y los dos cuentan como revisar:

1. **Pulsar «Confirmar»**, un `flitBtnSecondary` pequeño junto al chip. Nombre accesible
   **«Confirmar municipio»** — la **etiqueta** del campo, nunca su valor.
2. **Editar el campo.** Corregir *es* revisar; obligar a corregir y además confirmar sería cobrar dos
   veces por el mismo trabajo.

Y uno que **no** cuenta: **pasar por encima con el tabulador**. Un `blur` sin tocar nada no es una
revisión, y tomarlo por tal vaciaría la compuerta en un solo recorrido de teclado.

**Confirmar no cambia la procedencia.** Un campo confirmado sin editar sigue siendo `'factura'`: lo
leído y no tocado (AC7). Solo la edición lo pasa a `'manual'`. Es lo más fácil de invertir sin
enterarse, y convertiría la afirmación «esto lo puso el concesionario» en falsa para Operaciones.

**Lo que se descartó, para que nadie lo rehaga:**

- **Un botón «Confirmar todos».** Es la línea literal del AC3 («los confirma uno a uno») y además el
  botón que nadie leería antes de pulsar.
- **Una casilla «Lo revisé» por campo.** Es el cuestionario que este documento existe para evitar: en
  el caso confiable no habría nada que marcar y en el dudoso son la misma acción con más ruido.
- **El porcentaje del chip.** No es accionable para un Cliente y abre una pregunta que la pantalla no
  puede contestar («¿por qué 68?»). El umbral es una decisión de FLITO, no información del titular.
- **`aria-invalid` en el campo dudoso.** No es un error: es un dato correcto que quizá no lo sea. El
  aviso llega por `aria-describedby` (§8), no marcando el control como inválido.

### 4.3 El contador: encaja en la frase que ya existe

La revisión pendiente **es un ítem más de `frasePendientes`**, en `#sol-falta`, con su plantilla y su
tope de tres segmentos intactos. No hay una segunda frase compitiendo con la del envío.

| n | Ítem |
|---|---|
| 1 | **`revisar 1 dato leído`** |
| ≥ 2 | **`revisar {n} datos leídos`** |

Frases completas:

> **«Para enviar falta: revisar 2 datos leídos.»**
> **«Para enviar falta: revisar 1 dato leído y Correo electrónico.»**
> **«Para enviar falta: consultar el RUNT, revisar 3 datos leídos y 9 datos más.»**

**Posición: siempre el segundo ítem, justo detrás del del RUNT** (y el primero cuando el RUNT ya está
resuelto). No es una preferencia de redacción: el tope de `frasePendientes` conserva **los dos
primeros** segmentos y resume el resto, así que esa posición es la única que **garantiza** que el
número de campos por revisar nunca caiga dentro del «y N datos más». El AC3 pide que el botón indique
cuántos faltan por revisar; con el ítem al final, en el caso más común —formulario a medias y dos
lecturas dudosas— dejaría de indicarlo.

Es la **única** variante de singular/plural de esta plantilla, y viene con su localizador único para
QA: `/revisar \d+ datos? leídos?/`.

**Al pulsar el primario bloqueado**, si no hay errores de campo pero sí revisiones pendientes, el foco
va **al primer campo pendiente en el orden visual** (`ORDEN_FOCO_BASE`). Es la doctrina que esta
pantalla ya aplica: el botón bloqueado lleva a la acción que sí toca. Con errores y revisiones a la
vez, mandan los errores: un campo con valor inválido no se puede dar por revisado.

---

## 5 · El aviso de sobrescritura (AC6)

**Forma: una banda dentro del bloque 2, con una lista de casillas. No un modal.**

Un modal taparía justo el bloque 3, que es donde están los datos sobre los que se decide, y
convertiría una elección reversible en una interrupción a pantalla completa. Una banda sin detalle
(«se van a sobrescribir 3 datos, ¿acepta?») incumple el AC, que pide **qué campos**.

```
┌─ 2 · Factura de venta ─────────────────────────────── ✓ Factura leída ───────┐
│  [ caja con el archivo · factura-nueva.pdf · 0,9 MB ]  [ Quitar el archivo ] │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ Esta factura dice otra cosa en 3 datos que usted escribió.              │  │
│  │ Marque los que quiere reemplazar. Lo que deje sin marcar se queda como  │  │
│  │ está.                                                                   │  │
│  │                                                                         │  │
│  │  Campo              Usted escribió        La factura dice               │  │
│  │  ☑ Municipio        BOGOTA                MEDELLÍN                      │  │
│  │  ☑ Dirección        CRA 7 # 1-2           CL 30 # 5-10                  │  │
│  │  ☐ Celular          3001234567            3009999999                    │  │
│  │                                                                         │  │
│  │  [ Reemplazar 2 datos ]     [ Conservar lo que escribí ]                │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Qué nombra:** el campo por su **etiqueta**, el valor actual y el valor leído, en la rejilla de tres
columnas que `FlitoRevisiones` ya usa para contrastar («Campo · Trámite · Leído del PDF»). Los valores
sí se pintan aquí —son los datos del propio usuario, en su propia pantalla, y sin ellos la decisión es
a ciegas—; lo que no ocurre nunca es que salgan de ahí hacia una URL, un `aria-label` o un chip.

**Cómo se acepta:** casillas **marcadas por omisión**. El gesto que abrió la banda fue cambiar la
factura, y la intención de ese gesto es «lea esta otra»; desmarcar es para la excepción. Nada se
escribe hasta pulsar **«Reemplazar {n} datos»**, cuyo número se actualiza al marcar y desmarcar —es
la confirmación de lo que va a pasar—. **«Conservar lo que escribí»** cierra la banda sin tocar nada.
Los dos son secundarios: la primaria de la pantalla no se mueve.

**Las cinco reglas de qué entra en la banda.** Sin ellas, «sobrescribir» se implementa de cinco formas
distintas:

1. Campo del formulario **vacío** + valor leído → **se escribe directo**, sin preguntar. No se pierde
   nada de nadie. (Es el camino de la primera lectura: la banda ni aparece.)
2. Campo con valor **que puso la persona** (`'manual'`) y que **difiere** del leído → **a la banda**.
   Es lo único que el AC6 protege.
3. Campo con valor de una **lectura anterior** (`'factura'`, sin tocar) → se reemplaza directo. No hay
   trabajo humano que defender y preguntar por él enterraría en ruido las filas del punto 2.
4. Valor leído **igual** al que ya está → no es conflicto, no se toca nada, y la procedencia **no
   cambia**: si el usuario lo tecleó, sigue siendo `'manual'`.
5. Valor leído **nulo** → **nunca borra** lo que hay. Una lectura peor que la anterior no puede dejar
   el formulario más vacío que antes.

**Lo que no se acepta conserva valor y procedencia `'manual'`** (AC6, literal) — y también conserva su
estado de revisado: un campo que el usuario defendió no vuelve a la cola de pendientes.

**La banda no roba el foco.** Aparece tras una lectura que pudo tardar un minuto, y el usuario puede
estar escribiendo en el bloque 3; mover el foco ahí sería la trampa de teclado que esta pantalla ya
documentó. Va en `role="status"` e inmediatamente después de la caja del archivo en el DOM, que es
donde el tabulador la encuentra.

**Quitar el archivo no borra nada.** Se descarta la lectura en vuelo, cae el chip y desaparece la
banda; los valores que ya estaban en el bloque 3 se quedan con su valor y su procedencia. Es el mismo
criterio con el que la #12091 conserva el propietario al invalidar la consulta del RUNT.

**Dos lecturas en vuelo.** Cambiar de archivo dos veces seguidas tiene la misma carrera que la
consulta al RUNT y se cierra igual: un contador de turno propio para la lectura, con la respuesta
tardía descartada. No se reusa el `turno` del RUNT: son dos peticiones distintas y compartir el
contador haría que consultar el RUNT cancelara una lectura sana.

---

## 6 · Procedencia: viaja, no se pinta

**Recomendación: no mostrarla campo a campo.** Motivo, en orden:

1. **No es el trabajo de esta visita.** El Cliente vino a pedir un SOAT. Quien tiene que poder decir
   «este nombre lo puso el concesionario y esta dirección la tecleó el cliente» es Operaciones, y lo
   dice el propio archivo que define el vocabulario (`flito-soat-procedencia.ts`).
2. **Compite con la única marca accionable.** Nueve etiquetas «de la factura» junto a los dos chips
   «Revise este dato» dejan la pantalla sin jerarquía: el usuario tiene que distinguir el adorno del
   aviso.
3. **Ya está dicho donde importa.** El bloque 2 dice cuántos datos vinieron de la factura; el bloque 3
   dice que vinieron de ahí; y la banda de §5 nombra, campo por campo y solo cuando hay conflicto,
   qué escribió él y qué dice la factura. Eso es toda la procedencia que el titular necesita para
   decidir.

**Qué viaja en el envío** (`POST /flito/soat/cliente`, campo `procedencia`, **cadena JSON** en el
multipart):

| Valor | Cuándo lo pone el formulario |
|---|---|
| `'factura'` | La lectura lo escribió y la persona **no tocó el campo** (confirmarlo no es tocarlo) |
| `'manual'` | Lo tecleó, lo corrigió, o nunca vino de la lectura |
| `'runt'` | **Hoy, nunca.** Ningún campo del propietario se prellena desde el RUNT: la #12091 lo prohíbe expresamente para `nombreCompleto`, que es lo único que el registro devuelve. El valor sigue en el vocabulario porque el backend lo acepta y porque el día que el RUNT prellene algo, el mapa ya sabe nombrarlo |

Se declaran **solo las claves de los campos que viajan en el alta**: 8 con persona natural
(`nombres`, `apellidos`, `tipoDocumento`, `numeroDocumento`, `direccion`, `municipio`, `departamento`,
`celular`) y 7 con NIT (`razonSocial` en lugar de los dos de nombre). Lo que no se declara lo completa
el servidor con `'manual'`, que es su defecto documentado. **`correo` no va en el mapa**: no es uno de
los nueve campos del comprador y el esquema del borde es `.strict()` — declararlo es un `400`.

**Nada de esto se persiste desde el navegador ni existe endpoint de confirmación**: `confirmadoPor` /
`confirmadoEn` de `CampoExtraido` son de la cola de revisión de Operaciones. Aquí la confirmación vive
en la pantalla y lo que llega al servidor es el mapa.

---

## 7 · Datos: los dos endpoints ya existen (verificado en este worktree)

```
POST /api/flito/soat/cliente/factura/lectura          (HU #12092, en develop)
  multipart: facturaVenta (PDF ≤15 MB)                 ← solicitudId NO se envía: no hay subsanación
  200 { extraccion }  · 14 claves { valor, confianza, confiable }
  400 archivo_no_pdf · 413 · 429 · 503

POST /api/flito/soat/cliente                           (HU #12093, en develop)
  multipart: … + procedencia = JSON string de hasta 9 claves con 'factura'|'runt'|'manual'
  400 si una clave o un valor no está en el vocabulario (.strict())
```

Del `200` el formulario usa **las nueve del comprador** y **descarta las cinco documentales**
(`placa`, `vin`, `numeroFactura`, `fechaFactura`, `valorVehiculo`): son de la cola de Operaciones y
ninguna tiene campo en esta pantalla. El VIN leído **no** se compara con el tecleado ni prellena el
bloque 1 — el AC no lo pide y sería reabrir la compuerta del RUNT desde un PDF.

`tipoDocumento` llega ya cruzado contra el catálogo del RUNT o en `null`, así que el `FlitSelect` del
bloque 3 recibe siempre un valor que existe entre sus opciones o cadena vacía. Y con `tipoDocumento`
leído como `NIT`, el bloque conmuta a jurídica **solo con escribir el valor**: `esNit` ya lo deriva.
**El AC4 no necesita código nuevo**; lo que necesita es que la lectura escriba `razonSocial` **o**
`nombres`+`apellidos` según el tipo, que es la excluyencia que el backend ya garantiza.

---

## 8 · Accesibilidad

- Aviso de lectura, línea de «leída», línea de lectura vacía y banda de sobrescritura: **`role="status"`**.
  Banda de fallo de lectura: **`role="alert"`** (AC1).
- El chip de baja confianza tiene que llegar a la **descripción accesible del campo**: sin eso, la
  marca es solo visual y quien usa lector de pantalla no sabe cuál revisar. **Restricción para la
  implementación:** `Campo` hoy solo enlaza `describedByExtra` cuando `invalido` es `true`, y aquí
  `invalido` **no** debe ponerse (no es un error, §4.2). Hace falta describir sin marcar inválido; no
  es un rediseño del componente, es desacoplar dos props que hoy van juntas.
- «Confirmar» y «Reemplazar» llevan nombre accesible con la **etiqueta** del campo, nunca el valor.
- Las casillas de la banda son `<input type="checkbox">` con `<label>` propio; la rejilla de tres
  columnas se lee por filas y cada fila nombra su campo.
- Ningún foco se mueve solo: ni al terminar la lectura, ni al aparecer la banda, ni al confirmar un
  campo. El único movimiento de foco nuevo es el del primario bloqueado (§4.3), que lo pide el usuario
  al pulsar.
- Contraste: `warning` 4,64 y `success` 4,66 medidos en `StatusChip`. Sin hex sueltos.
- Ejecutar axe con **`QA_AXE_CDN=1`** o salen 10 rojos que no son de esta HU.

---

## 9 · Notas para QA (≤10)

Sesión `CLIENTE_USER` con canal habilitado. Interceptar `POST /flito/soat/cliente/factura/lectura` y
`POST /flito/soat/cliente`.

1. **AC1 · arranca sola.** Al elegir el PDF, la lectura sale **sin pulsar nada**; mientras dura hay un
   `role="status"` con «Leyendo la factura…» y **el bloque 3 sigue tecleable** (escribir en «Correo
   electrónico» durante la lectura funciona).
2. **AC1 · error con reintento.** Con `503`, se lee «No pudimos leer la factura.» en `role="alert"`,
   existe «Volver a leer la factura», y la frase de `#sol-falta` es **la misma** que sin lectura: el
   fallo no añade pendientes.
3. **AC2 · prellenado y editable.** Con un `200` de las nueve claves confiables, los ocho campos
   traen valor, **«Correo electrónico» queda vacío**, y ninguno tiene `disabled` ni `readonly` —
   incluidos el `FlitSelect` de tipo y el input de número de documento.
4. **AC3 · la marca exige valor.** Con las nueve claves en `{valor: null, confianza: 0, confiable:
   false}` (factura ilegible) **no aparece ningún chip «Revise este dato»** y el primario se comporta
   como en un formulario tecleado a mano.
5. **AC3 · contador y confirmación.** Con dos campos `confiable: false` **con valor**, `#sol-falta`
   casa `/revisar 2 datos leídos/`; al pulsar «Confirmar» en uno pasa a `/revisar 1 dato leído/`; al
   **editar** el otro, el ítem desaparece. Con nueve campos vacíos además de las dos revisiones, la
   frase **sigue nombrando** «revisar 2 datos leídos» (no se lo come el «y N datos más»).
6. **AC4 · natural o jurídica.** Lectura con `tipoDocumento: 'NIT'` + `razonSocial` → hay «Razón
   social» y **no** hay «Nombre/s» ni «Apellido/s»; con `CC` + nombres/apellidos, al revés. En los dos
   casos, borrar el campo visible bloquea el envío.
7. **AC5 · se envía igual.** Con `503` en la lectura y todo tecleado a mano, el `POST` de alta se
   dispara y responde `201`. Mismo caso con lectura vacía.
8. **AC6 · qué se sobrescribe.** Tras la primera lectura, corregir «Municipio» y volver a leer con un
   valor distinto: aparece la banda nombrando **«Municipio»**, y **hasta pulsar «Reemplazar» el campo
   conserva el valor tecleado**. Con la casilla desmarcada + «Reemplazar», el valor no cambia. Un
   campo que la segunda lectura trae `null` **no se vacía**.
9. **AC7 · procedencia.** En el `FormData` del alta, `procedencia` es un JSON donde un campo leído y
   no tocado va `'factura'`, uno corregido va `'manual'`, uno **confirmado sin editar sigue
   `'factura'`**, y **ninguno** va `'runt'`. No aparece la clave `correo`, ni claves de campos que no
   viajan (`razonSocial` con persona natural).
10. **AC8 · estados y PII.** Los cuatro estados del bloque 2 (sin factura, leyendo, fallo, leída) sin
    violaciones nuevas de axe (`QA_AXE_CDN=1`). En todo el recorrido, `page.url()` no contiene
    documento, celular ni dirección; ningún valor leído aparece en un `aria-label`, en un chip ni en
    `#sol-falta`.

---

## 10 · Decisiones y descartes

| # | Decisión | Descarte |
|---|---|---|
| 1 | El campo prellenado se ve **idéntico** a uno tecleado; la procedencia se dice en el contexto | Fondo gris, candado, borde de color o etiqueta «de la factura» en cada campo: se lee «no lo toque» y contradice el AC2 |
| 2 | Ámbar **solo** en baja confianza | Marcar los ocho: la marca que sí pide acción deja de distinguirse |
| 3 | Chip **«⚠ Revise este dato»**, sin porcentaje | `68% · no confiable` de Revisiones: métrica interna, no accionable para un Cliente |
| 4 | La marca exige **valor no vacío** | Marcar por `confiable: false` a secas: con factura ilegible bloquea el envío sin nada que confirmar (AC3 contra AC5) |
| 5 | Confirmar por botón **o** editando; el `blur` no cuenta | «Confirmar todos» (viola el literal del AC3) · casilla por campo (cuestionario) |
| 6 | Confirmar **no** cambia la procedencia | Marcar `'manual'` al confirmar: convertiría en falsa la afirmación que Operaciones va a leer |
| 7 | El contador es **un ítem más** de `frasePendientes`, en posición 2 | Una segunda frase junto al primario · ponerlo al final, donde el tope de tres segmentos se lo come |
| 8 | Sobrescritura: **banda con casillas**, marcadas por omisión, dentro del bloque 2 | Modal (tapa el bloque sobre el que se decide) · banda sin detalle (no dice «qué campos») · casillas desmarcadas (cuatro clics para el caso normal) |
| 9 | Solo entra a la banda lo que puso **la persona**; una lectura anterior se reemplaza sin preguntar | Preguntar por todo: entierra en ruido las filas que sí importan |
| 10 | La lectura **nunca borra** y **nunca roba el foco** | Vaciar campos con una lectura peor · mover el foco a la banda mientras el usuario escribe |
| 11 | La procedencia **viaja, no se pinta** (§6) | Nueve etiquetas de origen en el bloque 3 |
| 12 | Cero animaciones, cero sombras nuevas, cero ilustraciones, cero componentes nuevos | — |

**Pregunta abierta al PO (no bloquea la implementación).** El umbral de la lectura es 0,85 y el diseño
del backend anticipa que la escalación se disparará casi siempre. Si en DEV la mayoría de facturas
vuelven con seis o siete campos por debajo del umbral, el AC3 —confirmación uno a uno— convierte el
bloque 3 en un cuestionario de siete pulsaciones y la HU habrá empeorado el trabajo que venía a
aliviar. **La medida está en el umbral, no en la UI**, y la UI no debería recortarla por su cuenta.
Recomendación: medirlo con facturas reales antes de cerrar el Feature.

---

## 11 · Oficio (checklist de `_principios-flito.md`)

| Pregunta | Respuesta |
|---|---|
| ¿Qué vino a hacer? | Pedir el SOAT de un vehículo recién comprado. Lo que cambia es el verbo del bloque 3: de escribir a revisar |
| ¿Qué se ve primero? | El VIN, como ayer. Esta HU no le disputa la apertura al bloque 1 |
| ¿Qué se calla y dónde vive? | El porcentaje de confianza (en ninguna parte del canal) y la procedencia campo a campo (viaja en el envío, la lee Operaciones) |
| ¿Cuál es la única primaria? | **«Enviar al gestor»**. Reintento, «Volver a leer», «Confirmar» y «Reemplazar» son secundarios |
| ¿Vacío y error dicen el siguiente paso? | Sí: el vacío dice qué pasa al adjuntar; los cuatro fallos de lectura dicen «vuelva a leerla **o** escriba a mano y envíe igual» |
| ¿Efectos o patrón nuevo? | Ninguno. Chip + input de `FlitoRevisiones`, rejilla de contraste de `FlitoRevisiones`, chip de sección del bloque 1 |
| ¿Tono? | **Usted** en todo el copy nuevo |
| ¿Densidad? | Aliviada en el trabajo (ocho campos ya escritos); la tinta se contiene marcando **solo** lo que pide acción |
