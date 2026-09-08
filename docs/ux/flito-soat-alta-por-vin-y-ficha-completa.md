# UX slim — Alta del canal Cliente: un solo dato del vehículo y ficha RUNT completa (HU #12091)

> **Qué es este documento.** Entrada del `frontend-agent` para la
> [#12091](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12091) (Feature #12073).
> Modo **slim**: no hay ruta nueva, ni `PageSlug` nuevo, ni pantalla nueva. Es la **siguiente
> iteración** de una pantalla que ya existe.
>
> **Continúa** a `docs/ux/alta-solicitud-cliente-y-consulta-runt.md` (#11914),
> `docs/ux/flito-soat-formulario-un-paso-y-ficha-runt.md` (#11936),
> `docs/ux/flito-soat-consulta-runt-compuerta-y-propietario.md` (#11967) y
> `docs/ux/soat-envio-directo-al-gestor-y-gestor-por-defecto.md` (#12079). **Donde este documento y
> los anteriores discrepen, manda este** — y discrepan en un punto y solo en uno: **la placa deja de
> ser un dato que el Cliente teclea**. Todo lo que aquellos documentos decidieron sobre la placa como
> entrada (orden de campos, invalidación, copy de los modales, foco) queda superado aquí.
>
> **Canal Cliente: se habla de usted** (#11914, #11913). La cola de Operaciones tutea; esta pantalla
> no, y eso incluye el copy que llega del servidor (§7, decisión 6).
>
> **Fuera de alcance, escrito para que nadie lo amplíe de paso:** la lectura automática de la factura
> por OCR y el propietario prellenado editable son la **HU #12094** — aquí solo se deja el sitio
> (§4). La procedencia de cada dato es la #12093. La cola, el detalle, la ayuda y los correos no se
> tocan. **No** se introduce asistente por pasos ni borrador (AC2): crear sigue siendo enviar.

---

## 1 · Superficie tocada

| | |
|---|---|
| **Página** | `apps/web/src/pages/FlitoSoatSolicitud.tsx` (`Alta`), ruta `/flito/soat/solicitud` |
| **Componentes** | `components/flito/soat-cliente/FichaRunt.tsx` · `bloques.tsx` (`ID_CAMPO`, `BloquePropietario`) · `ModalesBloqueo.tsx` (`ModalSoatVigente`, `ModalVinEnCola`) · `lib/soatCliente.ts` (validación y copy de desenlaces) |
| **Slug / permiso** | `flito_soat`. **Ninguno nuevo.** Gate por capacidad: `puedeSolicitarSoat(user)` |
| **Roles** | `cliente` con canal habilitado ve el formulario · `cliente` sin canal, `TarjetaCanalDeshabilitado` · `admin`/`auditor`/`proveedor`, `TarjetaCanalAjeno`. **Sin cambios** |
| **Endpoints** | `POST /api/flito/soat/cliente/preconsulta` — cuerpo **`{ vin }`** y nada más (HU #12090, ya en DEV) · `POST /api/flito/soat/cliente` (multipart, **sin `placa`**: `EntradaSolicitud` la perdió) |
| **Requerimientos nuevos de datos** | **Ninguno.** Los once datos del AC3 ya viajan en `Preconsulta.vehiculo`; `pasajerosSentados` y `puertas` estaban llegando y se estaban tirando |
| **PII** | VIN, documento, correo, celular, dirección: **solo en el cuerpo del `POST`**. La URL de esta pantalla no lleva parámetros. El VIN **no** entra a `aria-label`, ni a la query, ni al texto de los modales (§5) |
| **Patrón visual** | `Seccion`, `Campo`, `FlitSelect`, `FlitUploadBox`, `StatusChip`, `FlitCard`, `flitBtn*`, `<dl>` + `Dato`. **Cero componentes nuevos, cero tokens nuevos, cero efectos** |

---

## 2 · Delta de claridad — qué se ve, qué se calla

**Qué vino a hacer quien abre esto:** pedirle a FLITO el SOAT de **un** vehículo que acaba de
comprar, con la factura de venta en la mano.

**Qué se ve primero:** un bloque con **un solo campo** —el VIN— y el botón que consulta el RUNT. Es
lo que desbloquea todo lo demás, y ahora se ve entero de un vistazo.

**Lo que gana el Cliente, en frases cortas:**

1. **De cuatro datos a uno.** El bloque 1 pedía placa, tipo de documento, número de documento y VIN,
   y **tres de los cuatro ya no sirven para nada**: desde la #12090 el RUNT se interroga por VIN. Un
   campo que no cambia el resultado es un campo que sobra.
2. **Se acaba la pregunta «¿y por qué me pide el documento aquí?».** El documento del propietario
   estaba arriba solo porque la consulta por placa lo exigía (Bug #11927). Vuelve a donde se entiende:
   con el propietario.
3. **Un dato en un sitio.** El documento deja de tener dos apariciones (control arriba, eco abajo).
   Se acaba el eco y se acaba la línea «se cambia en el bloque 1».
4. **La factura antes del propietario.** El propietario es el bloque más largo (once campos) y es el
   que la #12094 va a precargar leyendo la factura. Ponerlo detrás del adjunto es el orden en el que
   el trabajo se va a hacer de verdad — y, mientras la #12094 no exista, sigue siendo el orden natural:
   primero se sube el papel, después se copia lo que dice.
5. **La ficha ya responde «¿es mi vehículo?».** Con la placa que devuelve el RUNT, y ya no con el eco
   de lo que él tecleó. Antes la ficha confirmaba siete datos; ahora confirma once, y el primero es la
   placa que él **no** escribió: es la única prueba visible de que el registro habla de su carro.

**Qué se calla, y dónde vive:**

| Se calla | Dónde vive |
|---|---|
| Marca, línea, modelo, clase, carrocería, cilindraje, servicio, capacidad, puertas, placa | En la **ficha de solo lectura**, después de consultar. No se teclean nunca |
| El VIN que el RUNT tiene cuando no cuadra con el tecleado | **En ninguna parte.** El servidor lo omite a propósito; el copy no lo reintroduce (§7, decisión 5) |
| Aseguradora y número de póliza del SOAT vigente | Fuera. No hacen falta para la decisión (#11914) |
| `verificacionEstado`, proveedor, ANS, valor pagado, quién despachó | Fuera del canal Cliente. Nada de esta HU los reintroduce |

**La única primaria: «Enviar al gestor».** Y por eso **«Consultar el RUNT» pasa a ser secundario
siempre** (hoy es `flitBtnPrimary` hasta que la consulta sale bien). Con el bloque 1 reducido a un
campo, el botón de consulta es el único control junto al único campo: no necesita peso de gradiente
para encontrarse, y dos gradientes en pantalla —uno de ellos al 50 % de opacidad— son dos primarias
compitiendo. El puente que lleva de un botón al otro ya existe y se conserva: **«Para enviar falta:
consultar el RUNT.»** bajo el primario. *Si el PO prefiere conservar el peso actual, se conserva y se
declara la excepción por escrito; la recomendación de este documento es que no.*

**Densidad: sin cambio neto.** El bloque 1 pierde tres controles y el bloque de propietario recupera
esos mismos dos (tipo y número) más su línea de eco borrada: el formulario tiene **los mismos
controles que hoy**, mejor repartidos. La ficha crece cuatro datos de solo lectura, y crece **porque
el AC3 lo pide**; se compensa agrupándola (§4) en vez de alargar la lista plana.

---

## 3 · Orden, wireframe y recorrido del tabulador

### 3.1 Wireframe — estado inicial (nada consultado)

```
  ← Volver a mis SOAT
┌──────────────────────────────────────────────────────────────────────────────┐
│ Solicitud de SOAT                                                            │
│ Escriba el VIN y FLITO consulta el RUNT. Usted adjunta la factura de venta   │
│ y completa el propietario. Al enviarla, su SOAT entra en gestión de inmediato│
└──────────────────────────────────────────────────────────────────────────────┘
┌─ 1 · Vehículo ───────────────────────────────────────────────────────────────┐
│  VIN (número de chasis) *                                                    │
│  [ 9BWZZZ377VT004251                    ]                                    │
│  Está en la tarjeta de propiedad y en la factura de venta. Suele tener 17    │
│  caracteres.                                                                 │
│                                                                              │
│  [ Consultar el RUNT ]   ← secundario                                        │
│                                                                              │
│  Con el VIN, el RUNT nos dice la placa, la marca, la línea, el modelo y la   │
│  ficha técnica del vehículo. Usted no tiene que escribirlos.                 │
└──────────────────────────────────────────────────────────────────────────────┘
┌─ 2 · Factura de venta ───────────────────────────────────────────────────────┐
│      ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐                       │
│                      ⬆  Factura de venta del vehículo *                      │
│                         Un solo archivo PDF · máximo 15 MB                   │
│      └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘                       │
│  ▸ (anclaje de la HU #12094 — hoy NO se pinta nada aquí. Ver §4.3)           │
└──────────────────────────────────────────────────────────────────────────────┘
┌─ 3 · Propietario ────────────────────────────────────────────────────────────┐
│  Escriba el propietario como aparece en la factura de venta: son los datos   │
│  que van en la póliza.                                                       │
│                                                                              │
│  Tipo de documento *            Número de documento *                        │
│  [ Seleccione el tipo…  ▾]      [                    ]                       │
│  Nombre/s *  ·  Apellido/s *      (o Razón social * si el tipo es NIT)       │
│  Correo electrónico *  ·  Celular *                                          │
│  Dirección *                                                                 │
│  Municipio *  ·  Departamento *                                              │
└──────────────────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────────────────┐
│  Al enviarla, su SOAT entra en gestión de inmediato. No se guarda como       │
│  borrador.                                                                   │
│  Para enviar falta: consultar el RUNT, VIN y 11 datos más.                   │
│                                    [ Cancelar ]  [ Enviar al gestor ]        │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Wireframe — bloque 1 resuelto

```
┌─ 1 · Vehículo ────────────────────────────────────────────── ✓ Consultado ───┐
│  VIN (número de chasis) *   [ 9BWZZZ377VT004251 ]   [ Consultar de nuevo ]   │
│                                                                              │
│  ┌ Datos del RUNT ──────────────────────── Traídos el 07/09/2026 10:14 ────┐ │
│  │ IDENTIFICACIÓN                                                          │ │
│  │   PLACA            VIN                                                  │ │
│  │   ABC123           9BWZZZ377VT004251                                    │ │
│  │ VEHÍCULO                                                                │ │
│  │   MARCA      LÍNEA        MODELO      CLASE        CARROCERÍA           │ │
│  │   RENAULT    LOGAN        2019        AUTOMOVIL    SEDAN                │ │
│  │ FICHA TÉCNICA                                                           │ │
│  │   SERVICIO   CILINDRAJE   CAPACIDAD (PASAJEROS)    PUERTAS              │ │
│  │   Particular 1600         5                        —                    │ │
│  │                                                                         │ │
│  │   ORGANISMO DE TRÁNSITO                                                 │ │
│  │   STRIA TTEyTTO MEDELLIN                                                │ │
│  │                                                                         │ │
│  │ Un dato en «—» es un dato que el RUNT no publica. No impide enviar la   │ │
│  │ solicitud.                                                              │ │
│  │ Estos datos los trae el RUNT y no se editan. Si alguno no coincide con  │ │
│  │ su vehículo, corríjalo ante su organismo de tránsito antes de pedir el  │ │
│  │ SOAT.                                                                   │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Orden del DOM = orden visual = orden del tabulador (AC2)

```
← Volver a mis SOAT
 → [1] VIN → «Consultar el RUNT»
 → [2] caja de la factura (+ «Quitar el archivo», solo si hay archivo)
 → [3] Tipo de documento → Número de documento
      → Razón social            (si tipo = NIT)
      → Nombre/s → Apellido/s   (en cualquier otro caso)
      → Correo electrónico → Celular → Dirección → Municipio → Departamento
 → «Cancelar» → «Enviar al gestor»
```

- **La ficha del RUNT no está en el recorrido** y eso es correcto: es texto, no controles. Se alcanza
  por encabezados (`<h3>` real; ver §4.2).
- **El primario sigue con `aria-disabled` y no `disabled`** (#12079): el foco lo alcanza, el lector
  anuncia «no disponible» y al pulsarlo la pantalla lleva a la acción que sí toca.
- **Tres listas ordenadas tienen que cambiar a la vez** en `FlitoSoatSolicitud.tsx`, o el foco y la
  frase de faltantes apuntarán al orden viejo: `ORDEN_FOCO_BASE`, `ORDEN_FALTANTES` y
  `primerErrorEnfocable`. El orden nuevo es el del recorrido de arriba, con `archivo` **entre** `vin`
  y `tipoDocumento` — ya no al final.

### 3.4 A dónde va el foco

| Suceso | Foco |
|---|---|
| Montaje de la pantalla | Título (`tituloRef`), como hoy |
| `runt_no_cuadra` con `campo: 'vin'` (**AC4**) | **Campo VIN**, con `aria-invalid` y `aria-describedby` a la banda |
| `runt_sin_registro` | **Campo VIN.** Su copy dice «compruebe el VIN» y hay exactamente un campo que comprobar; mandar el foco al botón contradiría la instrucción. *Delta menor sobre el AC, que solo obliga en `no_cuadra`* |
| `caido` (`runt_no_disponible`), `runt_sin_vin`, rama por defecto | Botón **«Volver a consultar»**: no hay nada suyo que corregir |
| Cerrar `ModalSoatVigente` con la X o Esc (**AC4**) | **Campo VIN** (`restoreFocusRef = vinRef`; hoy es `placaRef`, que deja de existir) |
| «Consultar otro vehículo» en `ModalSoatVigente` | Limpia el VIN —**y solo el VIN**: el propietario y la factura se conservan— y deja el foco en el campo VIN |
| Cerrar `ModalVinEnCola` | **Campo VIN**, por el mismo motivo |
| Enviar con errores | Primer campo inválido en el orden nuevo (`useFocoPrimerError`) |

---

## 4 · La ficha de once datos

### 4.1 Cómo se agrupan (y por qué no son once líneas planas)

Once pares etiqueta–valor en una rejilla uniforme se leen como un volcado de payload: nadie sabe cuál
mirar primero y la pregunta que el Cliente se hace —**«¿este es mi carro?»**— se responde en dos de
ellos. Se agrupan en **tres bloques con rótulo**, en orden de utilidad decreciente:

| Grupo | Datos | Por qué |
|---|---|---|
| **Identificación** | Placa · VIN | Los dos que responden «¿es mi vehículo?». **La placa va primera**: es el dato que él **no** tecleó, el que el RUNT aporta y el que reconoce de un vistazo |
| **Vehículo** | Marca · Línea · Modelo · Clase · Carrocería | Lo que se reconoce mirando el carro |
| **Ficha técnica** | Servicio · Cilindraje · Capacidad (pasajeros) · Puertas | Lo que decide la tarifa del SOAT y lo que el Cliente casi nunca sabe de memoria. Va al final porque no se verifica, se comprueba |

Y **el organismo de tránsito se queda** como está hoy, en una línea ancha bajo los tres grupos. **No
es uno de los once**: no es un dato del vehículo sino de dónde está matriculado, viaja en otra rama
de la respuesta (`organismo.nombre`) y ningún AC pide retirarlo. Se enseña por su **nombre**, jamás
por el código DIVIPOLA.

**Implementación sin patrón nuevo:** el `<dl>` de hoy se parte en tres, cada uno precedido de un
`<h4>` real con el mismo token que ya usan los `<dt>` (`--flit-text-muted`, 11 px, versalitas). Mismo
componente `Dato`, mismo `<section aria-labelledby="ficha-runt-titulo">`, mismo `<h3>`. Cero colores,
cero bordes y cero separadores nuevos: el aire de la rejilla es la separación.

**Descartado:** una tabla; un acordeón por grupo (esconde detrás de un clic lo que el usuario vino a
comprobar); y dejar los once en una sola rejilla de cuatro columnas, que es exactamente la lista plana
que el AC quiere evitar.

### 4.2 Reglas de la ficha que no cambian

- **Texto de solo lectura, nunca `<input disabled>`** (AC3). El razonamiento entero está escrito en la
  cabecera de `FichaRunt.tsx` y sigue vigente: un control deshabilitado no recibe foco y parece roto.
- **Sello de procedencia** «Traídos el {fecha} {hora}» en `role="status"`, y el pie «Estos datos los
  trae el RUNT y no se editan…».
- **Hueco = «—»**, con el helper `dato()` que ya existe. `pasajerosSentados` y `puertas` **dejan de
  omitirse**: se pintan siempre, con «—» cuando el RUNT no los trajo. Una línea nueva bajo la rejilla
  lo explica: **«Un dato en «—» es un dato que el RUNT no publica. No impide enviar la solicitud.»**
  Sin ella, cuatro guiones seguidos se leen como una carga a medias.

### 4.3 Lo que cambia de raíz: placa y VIN **sí** entran a la ficha

`FichaRunt.tsx` documenta hoy, con razón, por qué no los pinta: se consultaba **por placa**, la
pasarela devolvía el identificador consultado aunque no reconociera el vehículo, y enseñar el VIN
habría convertido la pantalla en un lector de VIN por placa. **Con la #12090 la dirección se invirtió**
y las dos premisas caen:

- El **VIN** es lo que el Cliente acaba de teclear: no es un dato que se le revele, es su propio dato.
- La **placa** ya no es eco: `Preconsulta.vehiculo.placa` es lo que devuelve el registro (#12090, AC3)
  y es el valor que se persiste en `vehicles.plate`. Es **la** confirmación de que el RUNT habla de su
  vehículo, y por eso encabeza la ficha.

`identificadoresGuardados` —el prop que existía para el único caso en que los dos entraban a la ficha,
la subsanación retirada en la #12079— **desaparece**: la ficha pinta placa y VIN de `datos.vehiculo`
siempre. Los comentarios de cabecera del componente hay que reescribirlos: dejarlos diciendo lo
contrario de lo que hace el código es la clase de frase que después nadie audita.

> **Riesgo residual, ya asumido aguas arriba y no reabierto aquí.** Devolver la placa a partir de un
> VIN es un intercambio de identificadores, y los VIN de una flota son consecutivos. La decisión es
> del contrato de la #12090, que además corre las guardas de RN-01 y de tenencia **antes** de llamar a
> Kyverum. Esta pantalla pinta lo que ese contrato devuelve; si el `security-agent` quiere recortarlo,
> se recorta en el endpoint, no en la ficha.

### 4.4 El sitio reservado para la HU #12094 (no se implementa aquí)

El bloque **«2 · Factura de venta»** queda preparado, y «preparado» significa **estructura, no
código**:

- El bloque es ya una `<Seccion>` propia con su `<h2>`, delante del propietario. La #12094 no tendrá
  que reordenar nada.
- Bajo `BloqueFactura` queda **un solo punto de inserción** para lo que aquella HU añada: el estado de
  lectura del OCR (`leyendo | leído | no se pudo leer`) y el aviso de que el propietario se precargó.
  **Hoy no se pinta nada ahí**: ni una línea, ni un espacio reservado, ni un texto que prometa una
  lectura que todavía no ocurre.
- `BloquePropietario` pasa a `documento: { modo: 'editable' }`, que es exactamente la forma que la
  #12094 necesita para prellenar campos que se puedan corregir. **Con esta HU los campos nacen
  vacíos**; el prellenado, la marca de procedencia (#12093) y su copy son de aquella.

---

## 5 · Los 4 estados de la vista, con copy

### 5.1 Vacío — primer paint, nada consultado

Los tres bloques montan sus controles desde el primer paint (decisión de la #11936, se conserva: la
compuerta es del **envío**, no del tecleo). El vacío útil no es un `FlitEmpty`, es lo que cada bloque
dice de sí mismo:

| Superficie | Copy |
|---|---|
| Subtítulo de la cabecera | **«Escriba el VIN y FLITO consulta el RUNT. Usted adjunta la factura de venta y completa el propietario. Al enviarla, su SOAT entra en gestión de inmediato.»** |
| Ayuda del VIN | **«Está en la tarjeta de propiedad y en la factura de venta. Suele tener 17 caracteres.»** |
| Pie del bloque 1 | **«Con el VIN, el RUNT nos dice la placa, la marca, la línea, el modelo y la ficha técnica del vehículo. Usted no tiene que escribirlos.»** |
| Bloque 2 | Los de `FlitUploadBox`, sin cambios: **«Factura de venta del vehículo»** / **«Un solo archivo PDF · máximo 15 MB»** |
| **Bloque 3, línea de encabezado (nueva)** | **«Escriba el propietario como aparece en la factura de venta: son los datos que van en la póliza.»** |
| Nota sobre el primario | **«Al enviarla, su SOAT entra en gestión de inmediato. No se guarda como borrador.»** |
| Motivo del primario bloqueado | **«Para enviar falta: consultar el RUNT, VIN y 11 datos más.»** *(plantilla de la #12079, sin cambios: dos nombres y «y N datos más»)* |

El bloque 3 **no** dice que la factura vaya a precargarlo: eso todavía no es verdad (§4.4).

### 5.2 Cargando

| Cuándo | Qué se ve | Copy |
|---|---|---|
| Consulta en vuelo | El campo VIN en `readOnly` (**nunca `disabled`**: perdería el foco), botón `disabled` con rótulo propio, mensaje al lado en `role="status"` | Botón: **«Consultando el RUNT…»** · **«La consulta puede tardar hasta un minuto. No cierre esta página.»** |
| Envío en vuelo | Primario `disabled` con **«Enviando…»**; el resto de la página no se borra | `role="status"` sr-only: **«Enviando…»** |

No hay esqueleto porque no hay `GET` al montar.

**Mientras la consulta está en vuelo el VIN NO se puede corregir**, y conviene decirlo sin rodeos
porque este documento decía lo contrario en su primera redacción: `readOnly` significa exactamente
eso. Lo que `readOnly` preserva —y por lo que no es `disabled`— es el foco y el recorrido de
tabulación, no la edición. La consulta dura hasta un minuto y en ese minuto el único control del
bloque 1 está congelado; el botón lo dice (**«Consultando el RUNT…»**) y el `role="status"` de al
lado también.

El contador `turno` que descarta respuestas tardías **se conserva igualmente**, y no es redundante:
son dos cerraduras contra el mismo daño —una ficha de otro vehículo pintada sobre el VIN ya
cambiado, con la compuerta abierta— y cada una tapa lo que la otra no ve. El `readOnly` cierra la
vía del teclado y solo mientras esa prop siga puesta; `turno` cubre un cambio de valor que no venga
del teclado y sobrevive a que alguien retire el `readOnly` en una iteración futura. Quien toque esto
después: no se borra `turno` porque «ya está el `readOnly`», ni se quita el `readOnly` porque «ya
está `turno`».

### 5.3 Error — los desenlaces del AC4, más los que ya existían

Todos se ramifican **por `codigo`** (`reaccionA`), jamás por el texto del mensaje. La banda vive en el
bloque 1, junto al campo que hay que corregir, en `role="alert"`. **Ninguno crea la solicitud**, y en
todos la compuerta vuelve a cerrarse: el primario queda bloqueado con su motivo.

| Desenlace | Dónde | Tono | Copy |
|---|---|---|---|
| **`runt_no_cuadra`** (siempre con `campo: 'vin'`) | Banda + foco al VIN | `danger` | **«Revise el VIN: no coincide con el que el RUNT tiene registrado.»** / **«Compruébelo en la tarjeta de propiedad o en la factura de venta, y vuelva a consultar.»** |
| **`runt_sin_registro`** | Banda + foco al VIN | `danger` | **«El RUNT no tiene registrado ningún vehículo con ese VIN.»** / **«Compruébelo en la tarjeta de propiedad. Si el vehículo es nuevo, puede que el RUNT todavía no lo haya indexado.»** |
| **`caido`** (`runt_no_disponible`) | Banda + foco al botón | `warning` | **«El RUNT no está disponible, vuelva a consultar.»** / **«No es un problema de sus datos: el servicio del RUNT no respondió. Espere un momento y pulse Volver a consultar.»** *(sin cambios)* |
| **`vigente`** (`soat_vigente`) | **`ModalSoatVigente`**, sin banda | `success` en el chip | Título **«Este vehículo ya tiene SOAT vigente»** · chip **«No hace falta comprar otro»** · con fecha: **«Según el RUNT, este vehículo tiene la póliza vigente hasta el {fecha larga}.»** · sin fecha: **«Según el RUNT, este vehículo tiene una póliza SOAT vigente.»** · **«FLITO no radica solicitudes de vehículos con SOAT vigente. Puede volver cuando la póliza esté por vencerse.»** · botones **«Consultar otro vehículo»** / **«Volver a mis SOAT»** |
| `runt_sin_vin` *(se conserva)* | Banda + foco al botón | `danger` | **«El RUNT respondió sin el número de chasis, y sin ese dato FLITO no puede radicar la solicitud.»** / **«No es un error suyo. Escríbale a su contacto en FLIT.»** |
| `vin_ya_tiene_soat` *(RN-01, se conserva)* | **`ModalVinEnCola`** | `warning` | **«Este vehículo ya tiene una solicitud de SOAT en FLITO, en estado {estado}. Cada vehículo puede tener una sola.»** · sin estado (fila ajena): la misma frase **sin** el inciso · segunda línea propia/ajena y botones **sin cambios** |
| Rama por defecto (código desconocido) | Banda + foco al botón | `warning` | **«No pudimos consultar el RUNT en este momento.»** / **«Vuelva a consultar. Si sigue pasando, escríbale a su contacto en FLIT.»** — ver §7, decisión 6 |
| Sin red, en la consulta | Banda + foco al botón | `warning` | **«No pudimos comunicarnos con FLITO para consultar el RUNT.»** / **«Compruebe su conexión y pulse Volver a consultar.»** *(sin cambios)* |
| Sin red, en el **envío** | Sustituye la tarjeta de envío | `danger` | **«No sabemos si la solicitud llegó a FLITO. Vuelva a sus SOAT y busque ese VIN antes de volver a enviarla.»** + **«Volver a mis SOAT»** |
| `403` del canal | Sustituye el formulario | neutro | `TarjetaCanalDeshabilitado avisoCarrera`, sin cambios |
| PDF inválido por bytes | Caja `rejected` + `role="alert"` | `danger` | Sin cambios (#11914 §2.9) |

**Errores de campo** (al salir del campo y al enviar), `aria-invalid` + `<p role="alert">`:

| Campo | Copy |
|---|---|
| VIN vacío — **ahora obligatorio (AC1)** | **«Escriba el VIN del vehículo.»** |
| VIN de más de 17 | **«El VIN no puede tener más de 17 caracteres.»** *(sin cambios)* |
| VIN con I, O o Q | **«El VIN no lleva las letras I, O ni Q. Revise si son unos o ceros.»** *(sin cambios)* |
| VIN de longitud rara — **aviso, no bloquea** | **«El VIN suele tener 17 caracteres y este tiene {n}. Revíselo en la tarjeta de propiedad.»** *(sin cambios)* |
| Los once del propietario y el adjunto | Sin cambios respecto de la #11966 / #12079 |
| Al pulsar Enviar con errores | **«Revise los datos marcados antes de enviar.»** |

**Ni el copy de los modales ni el del envío incierto nombran ya la placa** — el Cliente no la teclea y
la pantalla no la tiene cuando esos dos desenlaces se disparan: la RN-01 corre **antes** de Kyverum.
Tampoco se sustituye por el VIN: en una pantalla que trata de un solo vehículo, «este vehículo» dice
lo mismo sin poner un identificador de 17 caracteres dentro de una frase —y sin meterlo en el
`aria-label` del diálogo, que es donde los selectores de axe lo arrastrarían.

### 5.4 Lleno

Ficha del RUNT con sus once datos agrupados + chip **«✓ Consultado»** en el encabezado del bloque 1 +
botón secundario **«Consultar de nuevo»**. Con el propietario completo y el PDF adjunto, el primario
**«Enviar al gestor»** queda activo y la frase de faltantes desaparece. Al `201`: toast **«Solicitud
enviada. Ya está en gestión.»** y navegación a `/flito/soat`.

### 5.5 AC5 — la consulta invalidada

Al editar el VIN después de una consulta hecha (`fase !== 'inicial'`), la ficha se retira, el chip
«✓ Consultado» desaparece y bajo el campo aparece, en `role="status"` —**no** `alert`: es la
consecuencia de lo que el usuario acaba de hacer, no un fallo—:

> **«Cambió el VIN: vuelva a consultar el RUNT antes de enviar.»**

Y el primario vuelve a bloquearse **con su motivo**: **«Para enviar falta: volver a consultar el
RUNT.»** — el rótulo del ítem calca el del botón al que apunta (`ROTULO_CONSULTA.invalidada` =
«Volver a consultar»).

**No se borra nada de lo que el Cliente escribió**: propietario y factura se conservan. Y **editar el
tipo o el número de documento ya NO invalida la consulta**: desde la #12090 dejaron de ser entrada del
RUNT. El tipo `Identificador` se colapsa a `'vin'`; `cambiarIdentificador` se aplica solo al VIN y el
documento pasa por `cambiarPropietario` como cualquier otro campo del bloque 3. Dejar la invalidación
atada al documento haría repetir una consulta que no depende de él — y el Cliente no entendería por
qué corregir una tilde del número le tumba la ficha.

---

## 6 · Permiso y slug

Sin cambios. `flito_soat`, `<ProtectedRoute page="flito_soat">`, gate por capacidad
`puedeSolicitarSoat(user)` y **nunca** por `role !== 'cliente'`. Las dos tarjetas de salida
(`TarjetaCanalDeshabilitado`, `TarjetaCanalAjeno`) se conservan igual.

**Precisión sobre el literal del AC1** («desaparecen … de `ID_CAMPO`»): lo que se retira de `ID_CAMPO`
es **`placa`** y solo eso. `tipoDocumento` nunca estuvo ahí —`FlitSelect` genera su id con `useId()` y
se enfoca solo— y `numeroDocumento` **tiene que quedarse**: es el ancla con la que
`useFocoPrimerError` alcanza ese campo, ahora en el bloque 3. Retirarlo dejaría el foco cayendo a
`<body>` en el error más común del formulario.

---

## 7 · Decisiones y descartes

| # | Decisión | Descarte |
|---|---|---|
| 1 | Bloque 1 con **un** campo y sin ningún control más | Dejar la placa «de solo lectura» o «opcional»: un campo que no cambia el resultado |
| 2 | Orden **Vehículo → Factura → Propietario** | Mantener el propietario en medio: la #12094 tendría que reordenar la pantalla otra vez |
| 3 | «Consultar el RUNT» **secundario siempre**; una sola primaria | Dos gradientes en pantalla, uno al 50 % de opacidad |
| 4 | Ficha en **tres grupos** con rótulo | Once líneas planas · acordeón · tabla |
| 5 | El copy **nunca** nombra el VIN que el RUNT tiene | «El bueno es este»: convertiría el 422 en un lector de VIN |
| 6 | La rama por defecto deja de **pintar el mensaje del servidor** y usa copy propio en *usted* | Interpolarlo: los mensajes del API **tutean** («Revisa el VIN que escribiste») y los de una API desfasada nombran campos que esta pantalla ya no tiene («revisa la placa»). Un solo tratamiento por pantalla (`_principios-flito.md`) |
| 7 | Los modales y el aviso de envío incierto dicen **«este vehículo»** | La placa (ya no existe) o el VIN (17 caracteres dentro de una frase y dentro del `aria-label` del diálogo) |
| 8 | Editar el documento **no** invalida la consulta | Conservar la invalidación de la #11967: ataba la ficha a un dato que ya no interroga al RUNT |
| 9 | Sitio de la #12094 = estructura, **cero copy** | Una línea «Vamos a leer su factura» que hoy sería mentira |
| 10 | Cero animaciones, cero sombras nuevas, cero ilustraciones | — |

---

## 8 · Notas para QA (≤10)

Sesión `CLIENTE_USER` con canal habilitado. Interceptar `POST /flito/soat/cliente/preconsulta` y
`POST /flito/soat/cliente`.

1. **AC1 · un solo dato del vehículo.** En el bloque 1, `getByRole('textbox')` → **1** control, con
   `<label>` asociado a «VIN (número de chasis)». `getByLabelText(/Placa/)` → `toHaveCount(0)` en toda
   la página. El cuerpo de la preconsulta es exactamente `{ vin }`.
2. **AC1 · el documento se edita abajo.** Tipo y número son controles **dentro** del bloque
   «3 · Propietario»; no queda ninguna línea «Documento: … · se cambia en el bloque 1».
3. **AC2 · orden y tabulador.** Los `<h2>` salen en el orden «1 · Vehículo», «2 · Factura de venta»,
   «3 · Propietario». Tabulando desde el VIN se llega a la caja de la factura **antes** que al tipo de
   documento.
4. **AC3 · once datos.** Con `200`, la ficha muestra los once `<dt>`; con `pasajerosSentados: null` y
   `puertas: null` en la respuesta, esos dos pintan **«—»** y siguen presentes. Ningún
   `input[disabled]` ni `[readonly]` dentro de la ficha.
5. **AC4 · cada desenlace distinto.** Los cuatro (`runt_no_disponible`, `runt_sin_registro`,
   `runt_no_cuadra`, `soat_vigente`) producen **cuatro textos distintos**; en ninguno se dispara
   `POST /flito/soat/cliente`. Comprobar que ningún texto contiene la palabra «placa».
6. **AC4 · foco.** `422 runt_no_cuadra` + `campo: 'vin'` → `document.activeElement` es el input del
   VIN, con `aria-invalid="true"`. Al cerrar `ModalSoatVigente` con Esc → el foco es el input del VIN
   (no `<body>`).
7. **AC5 · invalidación, literal.** Tras un `200`, teclear una letra en el VIN: la ficha desaparece,
   se lee **«Cambió el VIN: vuelva a consultar el RUNT antes de enviar.»** en `role="status"`, y el
   primario queda `aria-disabled="true"` con **«Para enviar falta: volver a consultar el RUNT.»**.
   Cambiar el **número de documento** tras un `200` **no** retira la ficha.
8. **AC5 · no se castiga al usuario.** Al invalidar, el archivo adjunto y los campos del propietario
   siguen con su valor.
9. **AC6 · una primaria.** En cualquier fase hay **un** botón con la clase de primario a plena
   opacidad; «Consultar el RUNT» no la lleva. Cuatro estados recorridos (vacío, consultando,
   desenlace de error, ficha) sin violaciones nuevas de axe — recordar `QA_AXE_CDN=1`, o salen 10
   rojos que no son regresión.
10. **PII.** En todo el recorrido `page.url()` no contiene VIN ni documento; el VIN no aparece en
    ningún `aria-label` ni en el título de los dos modales.

---

## 9 · Oficio (checklist de `_principios-flito.md`)

| Pregunta | Respuesta |
|---|---|
| ¿Qué vino a hacer? | Pedir el SOAT de un vehículo recién comprado, con la factura en la mano |
| ¿Qué se ve primero? | Un campo —el VIN— y el botón que consulta el RUNT |
| ¿Qué se calla y dónde vive? | Los once datos técnicos: en la ficha de solo lectura, después de consultar. Nunca se teclean |
| ¿Cuál es la única primaria? | **«Enviar al gestor»**. «Consultar el RUNT» pasa a secundario |
| ¿Vacío y error dicen el siguiente paso? | Sí: el vacío dice qué escribir y qué trae el RUNT; cada desenlace dice si hay que corregir, esperar o escribirle a FLIT |
| ¿Efectos o patrón nuevo? | Ninguno. Tres `<dl>` con `<h4>` donde había uno |
| ¿Tono? | **Usted** en toda la pantalla, incluida la rama por defecto (decisión 6) |
| ¿Densidad? | Sin cambio neto: el bloque 1 pierde tres controles, la ficha gana cuatro datos de lectura por AC explícito |
