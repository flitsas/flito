# UX slim — Topes de la carga masiva SOAT e Impuestos (HU #12050)

> **Qué es este documento.** Entrada del `frontend-agent` para la HU #12050 (Feature #12049).
> Modo **slim**: los dos modales que ya existen ganan un **contador de peso**, un **corte
> en el cliente** y **copy FLITO** cuando nginx contesta 413/504. No se rediseña el modal.
>
> **Fuera de alcance (HU #12051, no documentar ni pintar):** tandas automáticas de 5,
> cola de envíos, progreso por tanda, «faltan N tandas». Esta HU no parte sola la carga.

---

## Superficie tocada

| | SOAT | Impuestos |
|---|---|---|
| Página | `/flito/soat` | `/flito/impuestos` |
| Modal | `CargaMasiva` en `FlitoSoat.tsx` (~974) | `CargaRecibos` en `FlitoImpuestos.tsx` (~928) |
| Línea que se **sustituye** | `{n} archivo(s) listos.` (~1001) | la misma (~961) |
| Título del modal | Carga masiva de facturas SOAT | Carga masiva de recibos de impuesto |
| Primaria (sin cambio) | **Subir y procesar** / **Procesando…** | la misma |
| Checkbox «sin marca de agua» | no existe | **no se toca** (copy, sitio, comportamiento) |
| Ficha ayuda | `apps/web/src/content/ayuda/soat.md` paso 6 | `apps/web/src/content/ayuda/flito_impuestos.md` paso 6 |
| Slug / permiso | `flito_soat` — admin, proveedor | `flito_impuestos` — admin, gestor_impuestos |
| Endpoints | `POST /flito/soat/facturas` (ya existe) | `POST /flito/impuestos/recibos` (ya existe) |

**Cero componentes visuales nuevos.** El error sigue en el `<p className="text-sm text-red-600">`
que ya está. El contador sigue siendo un `text-xs` bajo el `input`. `FlitModal`, `flitInp`,
`flitBtnPrimary` / `flitBtnSecondary`: los de hoy.

**PII:** sin cambio. Nada de cédula/placa en la URL. El nombre del archivo que el operador
acaba de elegir puede aparecer en el error de 15 MB; no se redacta (es el mismo criterio
que la tabla de resultado OCR).

---

## Qué vino a hacer / qué se ve primero

Quien abre el modal vino a **subir comprobantes y pulsar una vez**. Lo que tiene que ver
antes de pulsar es si **esta selección cabe**. Por eso la línea nueva sustituye a
«N archivo(s) listos»: no añade una fila, **cambia lo que esa fila dice**.

| Siempre visible (esta visita) | Se calla |
|---|---|
| El `input` de archivos | Nginx, multipart, «margen», «bytes crudos» |
| `N archivo(s) · X MB de 250 MB` | Un segundo presupuesto «200» en el contador |
| Un error, si lo hay: **qué tope y por cuánto** | Tandas de 5, cola, progreso |
| **Subir y procesar** | Un botón «Reintentar» extra |

El 200 MB es umbral de **envío**, no el número del contador. El operador ve **250 MB**
(techo del canal). Si la suma cruda cruza ~200 MB se corta **antes** de mandar, para no
chocar el 413. El error nombra los **200 MB** (el tope que sí tocó) y el excedente.

---

## Oficio

- **Primaria única:** **Subir y procesar**. Cancelar sigue secundario. No se añade
  Reintentar: reintentar **es** volver a pulsar la primaria.
- **Jerarquía:** picker → contador → (error) → primaria. El intro del modal no se toca.
- **Vacío y error con siguiente paso:** ver estados. Nunca «Ocurrió un problema» ni HTML.
- **Sin efectos:** no hay barra de peso, no hay semáforo, no hay animación. Si la
  selección no cabe, el contador pasa a `text-red-600` (el mismo token de error de hoy).
- **Voz:** el modal **tutea** (el intro ya dice «Sube varios…»). Las fichas de Ayuda
  siguen en **usted**. No se unifica.
- **ZIP:** cuenta como **un** archivo (cantidad y 15 MB). El peso es `file.size` del
  ZIP, no lo que lleva dentro. El cliente **no** descomprime.

---

## Copy exacto

Constantes de producto (el cálculo va contra bytes, no contra el MB redondeado):

| Constante | Valor | Dónde se ve |
|---|---|---|
| Tope de cantidad | 50 archivos | error de validación |
| Tope por archivo | 15 MB (`15 × 1024²` bytes) | error de validación |
| Cupo del contador | 250 MB | `de 250 MB` |
| Tope de envío | 200 × 1024² bytes crudos (`sum(file.size)`) | error de validación, **no** en el contador |

**MB en pantalla:** `(bytes / 1024 / 1024).toFixed(1)` — el mismo criterio que
`soatCliente.ts` y el comprobante PSE (`12.3 MB`, punto, un decimal).

### Contador (sustituye `N archivo(s) listos.`)

Solo si `n > 0`. Misma posición, `text-xs`. Muted si cabe; `text-red-600` si **cualquier**
tope de validación falla (aunque el peso siga bajo 250).

```
{n} archivo · {x} MB de 250 MB      ← n === 1
{n} archivos · {x} MB de 250 MB     ← n !== 1
```

Ejemplos: `1 archivo · 3.2 MB de 250 MB` · `12 archivos · 48.2 MB de 250 MB`.

### Validación (el cliente **no** llama al POST)

Un bloque `role="alert"`, el `<p>` rojo de hoy. Si fallan varios topes, **todas** las
frases, en este orden: cantidad → por archivo → peso. No tres banners.

**Cantidad**

```
Seleccionaste {n} archivos y el máximo son 50 ({exceso} de más). Quite archivos.
```

`{exceso}` = `n − 50`. Ejemplo: `Seleccionaste 62 archivos y el máximo son 50 (12 de más). Quite archivos.`

**Por archivo** (un solo pasadero)

```
«{nombre}» pesa {x} MB y el máximo por archivo son 15 MB ({exceso} MB de más). Quite ese archivo o súbelo aparte.
```

Varios pasaderos: hasta **3** nombres; si hay más, `y {k} más`.

```
{m} archivos pesan más de 15 MB: «{a}» ({xa} MB), «{b}» ({xb} MB), «{c}» ({xc} MB). El máximo por archivo son 15 MB. Quítalos o súbelos aparte.
{m} archivos pesan más de 15 MB: «{a}» ({xa} MB), «{b}» ({xb} MB), «{c}» ({xc} MB) y {k} más. El máximo por archivo son 15 MB. Quítalos o súbelos aparte.
```

**Peso de envío** (suma cruda > 200 × 1024²)

```
Esta carga pesa {x} MB y el máximo de un envío son 200 MB ({exceso} MB de más). Quite archivos.
```

Ejemplo: `Esta carga pesa 218.0 MB y el máximo de un envío son 200 MB (18.0 MB de más). Quite archivos.`

No hay copy aparte para «pasó de 250»: el corte de 200 dispara primero.

### Error de red (sí se envió; nginx / proxy)

Mapear **por status** en el `catch` de `subir` de **estos dos** modales. No cambiar
`statusToMessage` de `api.ts` (retocaría todos los 5xx de la app).

Si el cuerpo o `errorMessage(e)` trae HTML (`<!DOCTYPE`, `<html`, `413 Request Entity`,
`504 Gateway`), **se descarta**. Nunca se pinta.

**413**

```
Esta carga pesa más de lo que el servidor admite. Pártala: quite archivos y sube el resto en otra carga.
```

**504**

```
El servidor no terminó a tiempo. Esta carga no se alcanzó a procesar. Espera un momento y vuelve a intentar, o súbela más liviana.
```

Cualquier otro error: `errorMessage(e)` como hoy, **salvo** que el texto parezca HTML
→ entonces: `No se pudo completar la carga. Vuelve a intentar.`

Tras 413/504 la primaria **sigue habilitada** (pueden quitar archivos y pulsar de nuevo).
Cambiar la selección **borra** el error de red. Un error de validación **impide** el POST.

### Primaria (sin cambio de rótulo)

| Estado | Rótulo | `disabled` |
|---|---|---|
| Vacío | Subir y procesar | sí (`n === 0`) |
| Validación | Subir y procesar | sí |
| Lleno | Subir y procesar | no |
| Enviando | Procesando… | sí |
| Error 413/504 | Subir y procesar | no |

---

## Estados (4) + cargando

El pedido nombra vacío / validación / error / lleno. **Cargando** ya existe
(`Procesando…`) y no se inventa un esqueleto: el modal es tres controles, no una tabla.

| Estado | Qué se ve | Siguiente paso |
|---|---|---|
| **Vacío** | Intro + `input`. Sin contador. Sin error. Primaria apagada. | Elegir PDF, imágenes o un ZIP. |
| **Validación** | Contador en rojo + frases de tope (qué y por cuánto). Primaria apagada. **No hay red.** | Quitar archivos hasta que el contador vuelva a muted. |
| **Error** | Contador (muted si la selección ahora cabe) + 413 o 504 FLITO, o el `errorMessage` no-HTML. Primaria encendida. | 413: partir la carga. 504: esperar y reintentar, o aligerar. |
| **Lleno** | Contador muted `N archivos · X MB de 250 MB`. Primaria encendida. | **Subir y procesar**. |
| *Cargando* (dentro de lleno) | Misma estructura. Primaria: **Procesando…**. | Esperar. No cerrar a ciegas: el `onClose` del modal con resultado sigue siendo el de hoy. |

El resultado OCR (chips + tabla + **Listo**) **no cambia**.

Wireframe del delta (SOAT; Impuestos es igual + el checkbox intacto **entre** el `input`
y el contador):

```
┌ Carga masiva de facturas SOAT                         ✕ ┐
│                                                          │
│  Sube varios PDF/imágenes o un ZIP. …                    │
│                                                          │
│  [ elegir archivos ]                                     │
│                                                          │
│  12 archivos · 48.2 MB de 250 MB                         │
│                                                          │
│  [ Subir y procesar ]   [ Cancelar ]                     │
└──────────────────────────────────────────────────────────┘

Validación (cantidad + peso):
│  62 archivos · 218.0 MB de 250 MB          ← rojo        │
│  Seleccionaste 62 archivos y el máximo son 50            │
│  (12 de más). Quite archivos.                            │
│  Esta carga pesa 218.0 MB y el máximo de un envío son    │
│  200 MB (18.0 MB de más). Quite archivos.                │
│  [ Subir y procesar ] apagado                            │
```

---

## Permiso / slug

Sin cambio. El modal lo abren quienes ya ven **Cargar facturas (masivo)** /
**Cargar recibos (masivo)** (`admin` + `proveedor` / `gestor_impuestos`). Auditor y
Cliente no entran. No hay `PageSlug` nuevo.

---

## Fichas de ayuda (usted; sin tandas de 5)

Sustituir el paso 6. No añadir un paso nuevo. No escribir «tandas», «de a 5» ni
«automático».

**`soat.md` paso 6 — texto completo:**

> 6. En una fila, pulse **Ver**. En adquisición, **Cargar factura** (un archivo) o, desde el encabezado, **Cargar facturas (masivo)**. En el masivo caben **hasta 50 archivos**, cada uno de **hasta 15 MB**. El modal le muestra el peso (**N archivos · X MB de 250 MB**). Si se pasa de la cantidad, del peso por archivo o del peso de la carga, FLITO se lo dice y no envía nada: quite archivos y vuelva a intentar.

**`flito_impuestos.md` paso 6 — texto completo:**

> 6. En el encabezado, **Cargar recibos (masivo)** sube los PDF, las imágenes o un ZIP del organismo. En una sola carga caben **hasta 50 archivos**, cada uno de **hasta 15 MB**. El modal le muestra el peso (**N archivos · X MB de 250 MB**). Si se pasa de la cantidad, del peso por archivo o del peso de la carga, FLITO se lo dice y no envía nada: quite archivos y vuelva a intentar.

No hace falta un bullet en «Qué no hace»: el paso ya dice que no envía si se pasa.

---

## Accesibilidad (delta)

- Contador: texto visible; si está en rojo, el `role="alert"` del error es el que
  anuncia el problema (no `aria-live` extra).
- El `input` ya tiene `accept`; no se le inventa un `<label>` nuevo si el modal no
  lo tenía — el intro cumple de contexto. Si el frontend-agent puede asociar un
  `label` sin cambiar el layout, mejor; no es el trabajo de esta HU.
- Primaria apagada en validación: el alert explica por qué.
- Contraste del rojo: el `text-red-600` de hoy, claro y oscuro.

---

## Notas para QA (≤10)

1. Ambos modales: `0` archivos → sin línea de contador; primaria apagada.
2. `1 archivo · X.X MB de 250 MB` (singular) y `2 archivos · …` (plural).
3. 51 archivos de 1 KB: error de cantidad con «(1 de más)»; **no** hay POST.
4. Un archivo de 15.1 MB: error de 15 MB con nombre, peso y excedente; **no** hay POST.
5. Suma cruda > 200 MB y < 250 MB: contador «de 250 MB» en rojo + copy de 200 MB; **no** hay POST.
6. Impuestos: el checkbox «sin marca de agua» sigue igual (sitio, copy, valor enviado).
7. 413 (HTML de nginx): se ve el copy FLITO de partir la carga; **cero** `<html>` / «Request Entity».
8. 504 (HTML de nginx): copy de «no terminó a tiempo»; primaria sigue usable.
9. Ayuda SOAT e Impuestos mencionan 50 / 15 MB / 250 MB y **no** mencionan tandas de 5.
10. Éxito OCR (chips + tabla + Listo) y el intro del modal no cambian.

---

## Decisiones y descartes

- **Contador a 250, corte a 200.** El pedido pide las dos cifras. Meter 200 en el
  contador mentiría el techo del canal; meter 250 en el error mentiría el tope que
  cortó. El rojo en el contador cuando `suma > 200` cierra el «218 de 250 y aun así
  no deja».
- **Sin botón Reintentar.** La primaria ya es esa acción. Dos primarias sería fallo
  de oficio.
- **Sin barra / chip de cupo.** El dato cabe en la línea que ya existía.
- **413 dice «carga», no «tanda».** «Tanda» es el vocabulario de la HU #12051.
- **Mapa 413/504 solo en estos `subir`.** Un cambio global en `api.ts` reescribe
  todos los 5xx.
- **No se toca el timeout de 90 s** de `api.ts`. Si el cliente aborta antes que
  nginx, el copy sigue siendo el de hoy («La consulta tardó demasiado…»). No es
  esta HU.
- **No se listan más de 3 nombres** en el error de 15 MB: un ZIP de 40 pasaderos
  no puede volverse una columna de texto.
