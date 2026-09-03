# UX slim — El ZIP se abre en el navegador (HU #12056)

> **Qué es este documento.** Entrada del `frontend-agent` para la HU #12056 (Feature #12049).
> Modo **slim**: los dos modales de carga masiva no se rediseñan. Lo que cambia es que el
> **ZIP deja de viajar entero**: el navegador lo abre antes de enviar nada y sus entradas
> salen por las **mismas tandas de 5** de la HU #12051.
>
> Base que **no** se reescribe:
> [`flito-soat-impuestos-carga-topes.md`](./flito-soat-impuestos-carga-topes.md) (HU #12050 —
> contador, 50 / 15 MB / 200–250 MB, 413/504) y
> [`flito-soat-impuestos-carga-tandas.md`](./flito-soat-impuestos-carga-tandas.md) (HU #12051 —
> envío de 5 en 5, fusión, fallo parcial). Esta HU **levanta** el «ZIP grande: documentar, no
> partir» de aquel AC7, y por eso hay una lista corta de cosas que **sí** cambian respecto a
> esos dos documentos: está al final, en «Qué no cambia y qué sí».

---

## Superficie tocada

| | SOAT | Impuestos |
|---|---|---|
| Página | `/flito/soat` | `/flito/impuestos` |
| Modal | `CargaMasiva` en `FlitoSoat.tsx` (~975) | `CargaRecibos` en `FlitoImpuestos.tsx` (~929) |
| Picker (`accept`, `multiple`) | **no cambia** | **no cambia** |
| Checkbox «sin marca de agua» | no existe | sitio y valor **no cambian**; ver §8 |
| Primaria | **Subir y procesar** / **Procesando…** → **Listo** | la misma |
| Slug / permiso | `flito_soat` — admin, proveedor | `flito_impuestos` — admin, gestor_impuestos |
| Endpoints (sin ruta nueva) | `POST /flito/soat/facturas` | `POST /flito/impuestos/recibos` |
| Librería | `jszip` (ya está en el repo; hoy solo la usa el API) | la misma |

**Cero componentes visuales nuevos.** Todo lo de esta HU cabe en los `text-xs` / `text-sm`
que ya existen bajo el `input`. Sin barra, sin spinner, sin acordeón, sin lista de archivos.

**PII:** sin cambio. Nada en la URL. Las rutas internas del ZIP (`sin marca/QTP701.pdf`)
pueden llevar placa y aparecen en los mensajes de tope: es el mismo criterio que la tabla de
resultado OCR, que ya muestra el nombre de cada archivo.

---

## Qué vino a hacer / delta de claridad

Quien abre el modal vino a **subir comprobantes y pulsar una vez**. Sigue pulsando una vez.
Lo que cambia es que ahora, **antes de pulsar**, FLITO ya sabe qué hay dentro del ZIP — y por
tanto puede decir la verdad sobre lo que se va a subir en vez de decirle «1 archivo».

| Siempre visible (esta visita) | Se calla |
|---|---|
| Mientras se abre: **`Abriendo «x.zip»…`** | «descomprimiendo», «entradas», «JSZip», %, barra |
| El contador, ahora contando **lo que se va a subir** (90, no 1) | La lista de los 90 nombres |
| Una línea muted si el ZIP traía basura: **cuántas** se ignoraron y hasta 3 nombres | Carpetas, `__MACOSX/`, ocultos: nunca se nombran ni se cuentan |
| Un tope pasado: **cuál archivo, por cuánto y qué hacer** | El árbol del ZIP, el log de la lectura |
| Mientras envía: **`enviando 46 de 90 archivos`** | `tanda k de n` con n = 18 (ver §7) |
| Chips + tabla fusionados, **Listo** | Columna «tanda», columna «vino del ZIP» |

**El contador cambia de sujeto, no de sitio.** Deja de contar lo que el operador señaló en el
disco y pasa a contar **lo que va a salir del navegador**. Consecuencia que hay que decir en
voz alta porque el operador la va a ver: *un ZIP de 40 MB puede mostrar 118.4 MB*. Ese es el
peso real de lo que sube; el peso del `.zip` comprimido no vuelve a aparecer en pantalla.

**Densidad:** una línea muted más (los descartes), y solo cuando el ZIP traía basura. El resto
son las mismas ranuras de hoy. Orden fijo, de arriba abajo:

```
picker → (checkbox, solo Impuestos) → contador  ‖  «Abriendo…»
                                    → descartes (muted, opcional)
                                    → error (rojo, role=alert)
                                    → progreso (muted, solo enviando)
                                    → [ Subir y procesar ] [ Cancelar ]
```

---

## Oficio

- **Primaria única:** **Subir y procesar**. Cancelar sigue secundario. **No** se añade
  «Cancelar la apertura», ni «Ver los archivos del ZIP», ni «Reintentar».
- **Jerarquía:** el contador es la línea que responde «¿esto cabe y qué es?». Todo lo nuevo
  cuelga de esa misma ranura.
- **Vacío y error con siguiente paso:** ver §Estados. Ningún mensaje termina sin decir qué
  hacer, y cuando la acción **no** se puede hacer desde el modal, se dice así (el >15 MB).
- **Sin efectos:** ni barra de descompresión, ni porcentaje, ni animación entre tandas.
- **Voz:** el modal **tutea** (`Sube varios PDF/imágenes o un ZIP…`). El copy nuevo tutea.
  Las fichas de Ayuda siguen en **usted**.

---

## Constantes

| Constante | Valor | Sujeto |
|---|---|---|
| `CARGA_MASIVA_MAX_ARCHIVOS` | 50 | **archivos sueltos** que el operador señala en el picker |
| Tope de entradas de ZIP (nuevo) | **300** | suma de entradas útiles de **todos** los ZIP elegidos |
| `CARGA_MASIVA_MAX_BYTES_ARCHIVO` | 15 MB | **cada** archivo que se va a subir: suelto **o** entrada |
| `CARGA_MASIVA_MAX_BYTES_CRUDOS` | 200 MB | suma de **lo que se va a subir** (entradas descomprimidas + sueltos) |
| `CARGA_MASIVA_MAX_BYTES_CUERPO` | 250 MB | denominador del contador (sin cambio) |

Dos presupuestos con dos sujetos distintos: 50 es lo que se señala a mano, 300 es lo que trae
el ZIP. No se suman ni se mezclan, porque el remedio de cada uno es distinto («quita archivos»
vs. «divide el ZIP»).

**Qué cuenta como entrada útil.** Todo lo que no sea: `entrada.dir`, algo bajo `__MACOSX/`,
o un nombre base que empiece por `.`. Esas tres cosas **nunca** se cuentan, nunca se nombran y
nunca se mencionan: no son documentos, son ruido del sistema de archivos. Lo que sí se cuenta
pero **no** se puede subir (un `.txt`, un `.docx`) va a la línea de descartes.

Extensiones aceptadas dentro del ZIP: las mismas del `accept` de hoy — `.pdf`, `.png`,
`.jpg`, `.jpeg`. **No** se acepta un ZIP dentro de un ZIP (cuenta como descarte).

---

## Momento nuevo: abrir el ZIP

Sucede al soltar el picker, **antes** de que exista contador. Puede tardar en un ZIP de 120 MB.

**Regla de oficio para el frontend:** al elegir se lee el **índice** del ZIP (nombres y pesos
descomprimidos) — con eso ya se puede contar, validar los 15 MB por entrada y nombrar los
descartes. La descompresión de cada entrada se hace **en su tanda**, dentro del
`Procesando…` que el operador ya sabe que es una espera. Así «Abriendo…» dura segundos y no
se convierte en una espera muda de un minuto.

Copy (ocupa la ranura del contador, `text-xs` muted):

```
Abriendo «facturas-agosto.zip»…
```

Varios ZIP a la vez:

```
Abriendo 2 ZIP…
```

Si la implementación **no** puede leer pesos sin descomprimir y la lectura recorre entradas,
la línea lleva el conteo que ya lleva, para que no parezca colgada:

```
Abriendo «facturas-agosto.zip»… 120 archivos
```

Mientras abre:

- **Primaria apagada** (no hay nada que enviar todavía).
- **Picker encendido**: elegir otro archivo es el escape natural; la lectura anterior se
  descarta y no pinta su resultado tarde.
- **Cancelar encendido**: cierra el modal. No se ha enviado nada, no hay nada que abortar.
- **No** hay botón «Cancelar la apertura». Sería una segunda acción para deshacer algo que
  no dejó rastro.
- El modal tiene que seguir respondiendo al clic mientras lee: si la lectura bloquea el hilo,
  Cancelar deja de ser verdad.

---

## Copy exacto

Formato de MB: el de hoy, `(bytes / 1024 / 1024).toFixed(1)` → `118.4 MB`.

### Contador (misma ranura, mismo `text-xs`)

Cuenta **lo que se va a subir**. Cuatro formas, según lo elegido:

```
{n} archivos · {x} MB de 250 MB                              ← solo sueltos (hoy, sin cambio)
{e} archivos de «{zip}» · {x} MB de 250 MB                   ← un ZIP y nada suelto
{t} archivos ({e} de «{zip}») · {x} MB de 250 MB             ← un ZIP + sueltos
{t} archivos ({e} de {z} ZIP) · {x} MB de 250 MB             ← varios ZIP
```

Singular donde toque: `1 archivo de «facturas-agosto.zip» · 2.1 MB de 250 MB`.

Ejemplos: `90 archivos de «facturas-agosto.zip» · 118.4 MB de 250 MB` ·
`92 archivos (90 de «facturas-agosto.zip») · 120.0 MB de 250 MB`.

Muted si cabe; `text-red-600` si falla **cualquier** tope, igual que hoy.

### Descartes (línea nueva, muted, **no** es un error)

Solo si hubo entradas de tipo no soportado. Hasta **3** nombres, luego `y {k} más` —
el mismo patrón de `fraseVariosArchivosGrandes`. Nombre base, sin ruta: aquí la carpeta no
ayuda a nada.

```
Del ZIP se ignoró 1 archivo que no es PDF ni imagen: «notas.txt».
Del ZIP se ignoraron {m} archivos que no son PDF ni imagen: «{a}», «{b}», «{c}» y {k} más.
```

Con varios ZIP: `De los ZIP se ignoraron …`.

Carpetas, `__MACOSX/` y ocultos **no** entran en `{m}` ni se nombran. Un ZIP de macOS con 90
PDF dice «90 archivos» y **no** dice nada de descartes: eso es lo que separa un aviso de un log.

### Validación (el cliente **no** llama al POST)

Mismo `<p role="alert" className="text-sm text-red-600">` de hoy, una sola caja. Si fallan
varios topes, todas las frases en este orden:

1. cantidad de sueltos (50) · 2. entradas del ZIP (300) · 3. sueltos > 15 MB ·
4. entradas > 15 MB · 5. peso (200 MB)

**1 y 3 no se tocan**: son `fraseCantidad`, `fraseUnArchivoGrande` y
`fraseVariosArchivosGrandes` de `carga-masiva.ts`, palabra por palabra.

**2 — entradas del ZIP (nueva)**

```
«{zip}» trae {e} archivos y el máximo son 300 ({exceso} de más). Divide el ZIP en partes y sube una por una.
```

Varios ZIP: `Los ZIP traen {e} archivos y el máximo son 300 ({exceso} de más). Sube menos ZIP a la vez o divídelos.`

Ejemplo: `«facturas-agosto.zip» trae 412 archivos y el máximo son 300 (112 de más). Divide el ZIP en partes y sube una por una.`

**4 — una entrada pesa más de 15 MB (nueva)**

El nombre es la **ruta dentro del ZIP**, que es lo que le permite encontrarlo. Y el remedio
dice la verdad: desde el modal no se puede quitar, y «súbelo aparte» tampoco sirve porque
suelto tampoco cabría.

```
«{ruta}», dentro de «{zip}», pesa {x} MB y el máximo por archivo son 15 MB ({exceso} MB de más). Desde aquí no se puede quitar: sácalo del ZIP, vuelve a comprimir y elige el ZIP otra vez.
```

Varias (hasta 3 rutas + `y {k} más`):

```
{m} archivos del ZIP pesan más de 15 MB: «{a}» ({xa} MB), «{b}» ({xb} MB), «{c}» ({xc} MB) y {k} más. El máximo por archivo son 15 MB. Desde aquí no se pueden quitar: sácalos del ZIP, vuelve a comprimir y elige el ZIP otra vez.
```

Ejemplo: `«sin marca/QTP701.pdf», dentro de «facturas-agosto.zip», pesa 18.4 MB y el máximo por archivo son 15 MB (3.4 MB de más). Desde aquí no se puede quitar: sácalo del ZIP, vuelve a comprimir y elige el ZIP otra vez.`

**No se salta la entrada gorda para subir el resto.** Se bloquea la carga entera, como con un
suelto de 16 MB. Saltarla en silencio deja al operador creyendo que ese comprobante se
procesó; saltarla con aviso obliga a repetir el aviso en el resultado y a que nadie lo lea.

**5 — peso (200 MB): la frase de hoy con la cola correcta**

Si en la selección hay al menos un ZIP, `frasePesoEnvio` cambia **solo** la última frase
(«Quite archivos.» no es accionable sobre un ZIP):

```
Esta carga pesa {x} MB y el máximo de un envío son 200 MB ({exceso} MB de más). Divide el ZIP en partes y sube una por una.
```

Sin ZIP: la frase de hoy, intacta.

### ZIP que no se puede abrir (nuevo; no hay contador, no hay envío)

Caja roja `role="alert"`, primaria apagada, picker encendido.

```
No se pudo abrir «{zip}»: está dañado o no es un ZIP. Vuelve a comprimirlo y elígelo otra vez.
```

```
«{zip}» está protegido con contraseña y FLITO no puede abrirlo. Comprímelo sin contraseña y elígelo otra vez.
```

```
«{zip}» no trae PDF ni imágenes. Revisa el ZIP o elige los archivos sueltos.
```

La tercera cubre los dos casos que se ven igual: ZIP vacío y ZIP en el que **todo** era
descarte (solo `.txt`, solo carpetas). No hay dos copys para «no hay nada que subir».

Si la librería no distingue contraseña de corrupción, se usa la primera: dice «no se pudo
abrir» y el siguiente paso sirve igual. Nunca se pinta el mensaje crudo de la librería.

Con varios ZIP elegidos y uno ilegible: se nombra **ese** y no se envía nada. No se sube «lo
que sí se pudo».

### ZIP cuyo índice miente (nuevo; ocurre A MITAD del envío, no al elegir)

Los tres copys de arriba se pintan al elegir, antes de mandar nada. Este es de otra familia: la
selección ya pasó —el ZIP declaraba tamaños que cabían— y el desajuste aparece cuando a esa
entrada le toca su tanda y se descomprime de verdad.

Caja roja `role="alert"` en la ranura de siempre, junto a los resultados de las tandas que sí
entraron. La carga se detiene ahí; lo ya subido se queda y se ve.

```
«{ruta}», dentro de «{zip}», trae más de 15 MB descomprimido y el índice del ZIP no lo
declaraba así. FLITO paró de descomprimirlo ahí: ese ZIP no es de fiar. Vuelve a comprimirlo y
elígelo otra vez, o sube los archivos sueltos.
```

Se nombra por la **ruta interna**, igual que la entrada que no cabe (§ tope por archivo): es lo
que deja encontrarla dentro del ZIP.

Por qué el copy dice «ese ZIP no es de fiar» y no «está dañado»: un archivo cuyo índice declara
un tamaño y trae otro no es un ZIP roto por accidente —el índice es lo que un ZIP fabricado a
mano miente primero—. El operador no tiene que saber qué es una bomba de descompresión, pero sí
merece saber que el archivo que le pasaron no dice la verdad, porque eso cambia a quién le
reclama. Las dos salidas que se le ofrecen son ciertas en los dos casos que llegan aquí (índice
que declara de menos, e índice que no declara nada).

### Progreso durante el envío (sustituye `tanda k de n`)

```
enviando {i} de {t} archivos
```

`{i}` = primer archivo de la tanda en curso = `(k − 1) × 5 + 1`. `{t}` = total a subir.
Solo si `{t} > 5` (misma regla que hoy: con una sola tanda no se pinta nada).
Ejemplos: `enviando 1 de 90 archivos` → `enviando 46 de 90 archivos` → `enviando 86 de 90 archivos`.

Prohibido en UI: `tanda`, `batch`, `lote`, `%`, `46/90`.

---

## §7 — Por qué muere `tanda k de n`

Con 90 comprobantes salen **18** tandas; con 300, **60**. `tanda 14 de 18` obliga al operador
a multiplicar por 5 para saber si va por la mitad, y «tanda» es vocabulario de trastienda que
solo se aguantaba cuando el número era 2 o 3. La unidad que él trajo son **archivos**.

Recomendación: **una sola forma**, la de archivos, también para la selección manual de 12
(`enviando 6 de 12 archivos`). Dos formas según el tamaño serían dos modelos mentales para el
mismo momento, y la línea de 3 tandas no mejora por decir «tanda».

Es un cambio deliberado de copy sobre la HU #12051, no un olvido: está en «Qué no cambia y
qué sí» y en las notas de QA.

---

## §8 — Impuestos: el checkbox y las carpetas

Etiqueta de hoy: **«Archivos sueltos sin marca de agua (en ZIP se deduce por carpeta)»**.

El comportamiento que promete se conserva: la casilla es el defecto de lo suelto y dentro del
ZIP manda la carpeta. **La etiqueta sigue siendo verdadera y no se cambia** — pero hoy, con
el ZIP abriéndose en el navegador, **deja de cumplirse sola**, y esto es lo más delicado de
la HU:

`esSinMarcaDeAgua(ruta, defecto)` vive en `flito-recibos.service.ts` y solo se ejecuta sobre
entradas de un ZIP que **el API** abrió (`expandir`). Si el navegador manda las entradas como
archivos sueltos, `expandir` les aplica `defectoSinMarca` a **todas** y la deducción por
carpeta desaparece **en silencio**: las copias con marca de agua se archivan como si no la
tuvieran. Nadie ve un error; se ve mal el documento tres días después.

**Requerimiento para `architecture-agent` / backend** (no es decisión de UX). Dos caminos:

| | Cómo | Costo |
|---|---|---|
| **A (recomendado)** | El navegador manda cada entrada con su **ruta interna** como nombre, y `expandir` aplica `esSinMarcaDeAgua(originalname, defecto)` también a los sueltos | Toca el API; hay que seguir guardando/mostrando el **nombre base** (el `split('/').pop()` de hoy) y sanear la ruta antes de usarla en storage |
| **B** | El navegador deduce por ruta y **agrupa las tandas** por valor, mandando `sinMarcaDeAgua` distinto en cada petición | No toca el contrato, pero duplica la regla (una regex en dos repos que se van a separar sin que nadie se entere) |

Se recomienda **A**: una sola regla, en el sitio que ya la tiene. Sea cual sea, el nombre que
se ve en la **tabla de resultado** sigue siendo el nombre base, como hoy.

Si no se resuelve ninguno de los dos, la etiqueta pasa a mentir y habría que dejarla en
«Archivos sin marca de agua» — pero eso ya no es un cambio de copy, es una regresión
funcional, y esta HU no debería cerrarse así.

Lo demás del checkbox no se toca: sitio (entre el `input` y el contador), valor, y viaja en
**cada** tanda.

---

## Estados (4) + copy

| Estado | Qué se ve | Siguiente paso |
|---|---|---|
| **Vacío** | Intro + picker (+ checkbox). Sin contador, sin descartes, sin error. Primaria apagada. | Elegir PDF, imágenes o un ZIP. |
| **Cargando · abriendo** (nuevo) | `Abriendo «x.zip»…` en la ranura del contador. Primaria apagada. Picker y Cancelar **encendidos**. | Esperar, o elegir otro archivo, o cerrar. |
| **Cargando · enviando** | Formulario intacto; picker y checkbox apagados. Primaria **Procesando…**. Si `t > 5`, `enviando i de t archivos`. | Esperar. Lo ya enviado ya quedó en el servidor. |
| **Con datos** | Contador con el sujeto correcto (+ descartes si los hubo). Primaria encendida. | **Subir y procesar**. |
| **Error · validación** | Contador en rojo + las frases de tope (300 / 15 MB / 200 MB / 50). **Cero** POST. | Quitar archivos, o dividir/rehacer el ZIP y volver a elegirlo. |
| **Error · ZIP ilegible** | Solo la caja roja (dañado / con contraseña / sin PDF ni imágenes). Sin contador. **Cero** POST. | Rehacer el ZIP, o elegir los archivos sueltos. |
| **Error · red** | 413 / 504 / error no-HTML de la HU #12050, palabra por palabra. Primaria encendida. | 413: partir. 504: esperar y reintentar, o aligerar. |
| **Error · parcial** | El de la HU #12051: alert + chips/tabla de lo que sí entró + **Listo**. | Leer qué quedó y volver a subir el resto. |

Wireframes del delta (SOAT; Impuestos es igual con el checkbox intacto entre picker y contador):

```
Abriendo:
┌ Carga masiva de facturas SOAT                          ✕ ┐
│  Sube varios PDF/imágenes o un ZIP. …                     │
│  [ elegir archivos ]                                      │
│  Abriendo «facturas-agosto.zip»…                          │
│  [ Subir y procesar ] apagado    [ Cancelar ]             │
└───────────────────────────────────────────────────────────┘

Con datos (ZIP de 94 entradas, 4 descartadas):
│  90 archivos de «facturas-agosto.zip» · 118.4 MB de 250 MB│
│  Del ZIP se ignoraron 4 archivos que no son PDF ni imagen:│
│  «notas.txt», «lista.docx», «plantilla.xlsx» y 1 más.     │
│  [ Subir y procesar ]   [ Cancelar ]                      │

Error de tope (entrada gorda):
│  90 archivos de «facturas-agosto.zip» · 118.4 MB …  ← rojo│
│  «sin marca/QTP701.pdf», dentro de «facturas-agosto.zip», │
│  pesa 18.4 MB y el máximo por archivo son 15 MB (3.4 MB   │
│  de más). Desde aquí no se puede quitar: sácalo del ZIP,  │
│  vuelve a comprimir y elige el ZIP otra vez.              │
│  [ Subir y procesar ] apagado    [ Cancelar ]             │

Enviando:
│  90 archivos de «facturas-agosto.zip» · 118.4 MB de 250 MB│
│  enviando 46 de 90 archivos                               │
│  [ Procesando… ]   [ Cancelar ]  ← los dos apagados       │
```

---

## Permiso / slug

Sin cambio. Lo abren quienes ya ven **Cargar facturas (masivo)** / **Cargar recibos
(masivo)** (`admin` + `proveedor` / `gestor_impuestos`). Auditor y Cliente no entran. No hay
`PageSlug` nuevo.

---

## Accesibilidad (delta)

- **Una sola ranura viva.** El contador pasa a `role="status" aria-live="polite"` y aloja,
  en este orden de vida: `Abriendo…` → contador (+ línea de descartes **dentro del mismo**
  contenedor, para que el descarte se anuncie con el conteo y no se pierda).
- El progreso mantiene su `role="status" aria-live="polite"`. Nunca coexiste con
  `Abriendo…`, así que no hay dos regiones hablando.
- El anuncio de progreso cambia una vez por tanda y esas tandas las marca la red, no un
  temporizador: con 18 tandas no es una ráfaga. Si alguna vez se paraleliza, hay que
  espaciarlo.
- Los errores siguen en `role="alert"`. Primaria apagada + alert que explica por qué.
- Contraste: muted del kit y `text-red-600` de hoy, claro y oscuro. Sin color nuevo.

---

## Fichas de ayuda (usted)

**`soat.md` — sustituir el paso 6 completo:**

> 6. En una fila, pulse **Ver**. En adquisición, **Cargar factura** (un archivo) o, desde el encabezado, **Cargar facturas (masivo)**. Sueltos caben **hasta 50 archivos**; dentro de un ZIP, **hasta 300**, y cada archivo puede pesar **hasta 15 MB**. Al elegir un ZIP, FLITO lo abre en su computador y le dice cuántos comprobantes trae: el peso que ve (**N archivos · X MB de 250 MB**) es el de lo que va a subir, no el del ZIP comprimido. Lo que no sea PDF ni imagen se ignora y se lo dice. Si el ZIP está dañado, tiene contraseña o no trae comprobantes, no se envía nada. FLITO sube los comprobantes **de 5 en 5** y le muestra por cuál va.

**`flito_impuestos.md` — sustituir el paso 6 completo:**

> 6. En el encabezado, **Cargar recibos (masivo)** sube los PDF, las imágenes o un ZIP del organismo. Sueltos caben **hasta 50 archivos**; dentro de un ZIP, **hasta 300**, y cada archivo puede pesar **hasta 15 MB**. Al elegir un ZIP, FLITO lo abre en su computador y le dice cuántos recibos trae: el peso que ve (**N archivos · X MB de 250 MB**) es el de lo que va a subir, no el del ZIP comprimido. Lo que no sea PDF ni imagen se ignora y se lo dice. La casilla **Archivos sueltos sin marca de agua** sigue aplicando a lo suelto; dentro del ZIP, la copia se deduce por la carpeta. Si el ZIP está dañado, tiene contraseña o no trae recibos, no se envía nada. FLITO sube los recibos **de 5 en 5** y le muestra por cuál va.

**Sustituir** (no añadir) el bullet de «Qué no hace» que dejó la HU #12051 en las dos fichas:

> - La carga masiva no arregla un ZIP: si trae un archivo de más de 15 MB, hay que sacarlo del ZIP, comprimirlo de nuevo y volver a elegirlo. Desde el modal no se puede quitar.

El bullet viejo («El ZIP de la carga masiva no se descomprime en el navegador…») queda falso
y **se borra**.

---

## Notas para QA (≤10)

1. ZIP con 90 PDF: contador `90 archivos de «x.zip» · X MB de 250 MB`; **18** POST de 5; un solo resultado fusionado.
2. El peso del contador es el de las **entradas descomprimidas**: un ZIP de 40 MB que expande a 118 MB muestra 118, no 40.
3. ZIP de macOS (carpetas + `__MACOSX/` + `.DS_Store`) con 90 PDF: dice «90 archivos» y **no** aparece la línea de descartes.
4. ZIP con 4 `.txt`/`.docx`: línea muted con «se ignoraron 4», 3 nombres + «y 1 más»; sigue siendo posible enviar; los 4 **no** viajan.
5. ZIP con 412 entradas: frase de 300 con «(112 de más)» y **cero** POST. 51 sueltos siguen dando la frase de 50.
6. ZIP con una entrada de 18.4 MB: la frase nombra la **ruta interna** y el ZIP, dice «desde aquí no se puede quitar», y **no** hay POST ni se salta esa entrada.
7. ZIP dañado, con contraseña y vacío (o solo con descartes): tres copys distintos salvo los dos últimos casos, que comparten «no trae PDF ni imágenes»; sin contador; **cero** POST; nunca sale el texto crudo de la librería.
8. Mientras dice `Abriendo «x.zip»…`: primaria apagada, picker y Cancelar **usables**; elegir otro archivo descarta la lectura anterior y no la pinta después.
9. Progreso: `enviando 46 de 90 archivos`; **no** aparece la palabra `tanda` en ninguna parte de la UI, tampoco con 12 archivos sueltos.
10. Impuestos: el checkbox no se mueve y **la copia se sigue archivando por carpeta** — comprobar con un ZIP de `sin marca/` + `con marca/`; si eso no se sostiene, la HU no está.

---

## Qué no cambia y qué sí

**No cambia** (de las HU #12050 y #12051):

- Picker, `accept`, `multiple`, intro del modal, título, `FlitModal`, tokens.
- `fraseCantidad` (50), `fraseUnArchivoGrande`, `fraseVariosArchivosGrandes` para **sueltos**.
- Denominador `de 250 MB` y el corte de 200 MB (solo cambia el sujeto que se mide, y la cola
  de la frase cuando hay ZIP).
- COPY 413 / 504 / HTML, palabra por palabra. La palabra «tanda» no entra ahí.
- Tandas de 5, parada en el primer no-200, fusión de resultados, estado parcial, chips y
  `TablaResultadoOcr` (sin columnas nuevas; los nombres siguen siendo el nombre base).
- Checkbox de Impuestos: sitio, valor y viaje en cada tanda.
- Primaria única, Cancelar secundario, permisos, slugs, endpoints.
- La expansión de ZIP del API (`expandir` en los dos servicios) **no se pide borrar**: deja de
  usarse desde estos dos modales, pero eso es decisión de backend, no de esta ficha.

**Sí cambia** respecto a esos dos documentos:

1. `tanda k de n` → `enviando i de t archivos` (§7). Deroga esa línea de la HU #12051.
2. «Un ZIP cuenta como un archivo» y «el navegador no lo abre» dejan de ser ciertos: caen del
   copy del modal, de las dos fichas de Ayuda y del bullet de «Qué no hace».
3. El contador cuenta lo que se va a subir, no lo que se señaló en el disco.
4. El tope de 15 MB se mide contra las **entradas**, no contra el `.zip`.

---

## Decisiones y descartes

- **Sin lista de archivos del ZIP.** Sería la pantalla más cargada del módulo por un dato que
  el operador ya conoce (él armó el ZIP). El conteo, los descartes y los topes con nombre
  cubren lo que sí necesita antes de pulsar.
- **Carpetas, `__MACOSX/` y ocultos no se cuentan ni se nombran.** Contarlos convertiría todo
  ZIP hecho en macOS en un aviso de basura que no dice nada. Es la línea entre aviso y log.
- **Descartes en muted, no en rojo.** Nada está mal: se puede enviar. El rojo se reserva para
  lo que impide el envío.
- **La entrada de más de 15 MB bloquea, no se salta.** Un documento que se cae en silencio es
  peor que una carga que no sale; y saltarlo con aviso obliga a repetir el aviso en el
  resultado, donde ya nadie lo lee. Además el mensaje evita el consejo falso de «súbelo
  aparte»: suelto tampoco cabe.
- **Un solo copy para ZIP vacío y ZIP todo-descartes.** El operador ve lo mismo («no hay nada
  que subir») y hace lo mismo.
- **Sin «Cancelar la apertura».** Segunda acción para deshacer algo que no dejó rastro; el
  picker y Cancelar ya son el escape.
- **Sin barra ni porcentaje** en «Abriendo…» ni en el envío. El conteo, cuando hace falta, se
  dice con números.
- **Índice primero, descompresión por tanda.** No es una decisión de implementación de
  adorno: es lo que hace que «Abriendo…» sea un momento corto y que el contador sea exacto
  desde el principio.
- **Pendiente de PO (no bloquea el desarrollo).** Con tandas, ninguna petición pasa de 5 × 15
  = 75 MB, así que los **200 MB** ya no son la pared de nginx sino un presupuesto de sesión.
  Un ZIP de 300 recibos de 1 MB da 300 MB y se bloquearía con «divide el ZIP», que es
  justamente el trabajo que esta HU vino a quitar. Se **mantienen los 200 MB** en esta
  entrega; queda la pregunta de si el tope real debe ser el de 300 entradas y no el peso.
