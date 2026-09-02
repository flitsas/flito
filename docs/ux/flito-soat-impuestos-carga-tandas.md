# UX slim — Tandas de la carga masiva SOAT e Impuestos (HU #12051)

> **Qué es este documento.** Entrada del `frontend-agent` para la HU #12051 (Feature #12049).
> Modo **slim**: los dos modales de HU #12050 siguen iguales en picker, topes, checkbox y
> resultado OCR. Lo que cambia es el **envío**: deja de ser un POST único y pasa a tandas
> de 5, con progreso `tanda k de n`, fusión de resultados y un estado de fallo parcial.
>
> **No se rediseña el modal.** Contador, cortes de 50 / 15 MB / 200–250 MB y copy 413/504
> viven en [`flito-soat-impuestos-carga-topes.md`](./flito-soat-impuestos-carga-topes.md)
> y en `apps/web/src/lib/carga-masiva.ts`. Esta HU no los reescribe.

---

## Superficie tocada

| | SOAT | Impuestos |
|---|---|---|
| Página | `/flito/soat` | `/flito/impuestos` |
| Modal | `CargaMasiva` | `CargaRecibos` |
| Primaria (sin cambio de rótulo) | **Subir y procesar** / **Procesando…** → **Listo** | la misma |
| Checkbox «sin marca de agua» | no existe | **no se toca** (sitio, copy, valor; viaja en **cada** tanda) |
| Ficha ayuda (AC7) | `apps/web/src/content/ayuda/soat.md` paso 6 | `apps/web/src/content/ayuda/flito_impuestos.md` paso 6 |
| Slug / permiso | `flito_soat` — admin, proveedor | `flito_impuestos` — admin, gestor_impuestos |
| Endpoints (sin ruta nueva) | `POST /flito/soat/facturas` | `POST /flito/impuestos/recibos` |
| Tamaño de tanda | `CARGA_MASIVA_ARCHIVOS_POR_PETICION` = **5** (`@operaciones/shared-types`) | el mismo |

**Cero componentes visuales nuevos.** La línea de progreso es un `text-xs` muted, la misma
familia que el contador. El error sigue en el `<p role="alert" className="text-sm text-red-600">`
de hoy. Chips + `TablaResultadoOcr` + **Listo** no ganan columnas ni barra.

**PII:** sin cambio. Nada de cédula/placa en la URL. El ZIP **no se abre ni se descomprime**
en el navegador: viaja como **un** `File` en **una** tanda.

---

## Qué vino a hacer / delta de claridad

Quien abre el modal vino a **subir comprobantes y pulsar una vez**. Sigue pulsando una vez.
Las tandas no son una decisión suya: son el envío. Lo que tiene que ver de nuevo es
**en qué tanda va** (si hay más de una) y, si una falla a mitad, **qué sí quedó** junto
al error.

| Siempre visible (esta visita) | Se calla |
|---|---|
| El picker, el contador de HU #12050, **Subir y procesar** | «batch», «lote», barra, %, «faltan N» |
| Mientras envía y `n > 1`: **`tanda k de n`** | Número de PDF **dentro** de un ZIP |
| Al terminar bien: chips + tabla fusionados (como hoy) | Columna «tanda» en la tabla |
| Fallo parcial: el 413/504 (o el error no-HTML) **y** chips/tabla de las tandas que sí contestaron | Un segundo CTA «Reintentar el resto» |
| Checkbox de Impuestos | Explosión del ZIP, lista de archivos no enviados |

`n = ceil(archivos.length / 5)`. Un ZIP cuenta **1**. Con 1–5 archivos no hay línea de
progreso: el botón **Procesando…** basta (es el mismo wait de HU #12050).

---

## Oficio

- **Primaria única:** **Subir y procesar**. Durante el envío, **Procesando…** (apagada).
  Al resultado (éxito o parcial), **Listo**. Cancelar sigue secundario y **se apaga**
  mientras hay tandas en vuelo — no es un aborto. No se añade Reintentar: reintentar
  **es** cerrar, volver a elegir lo que faltó y pulsar la primaria.
- **Jerarquía:** picker → (checkbox Impuestos) → contador → (error) → (progreso) → primaria.
  El intro del modal no se toca.
- **Vacío y error con siguiente paso:** ver estados. El 413/504 es **el de HU #12050**,
  palabra por palabra — no se cambia «carga» por «tanda».
- **Sin efectos:** no hay barra, no hay semáforo, no hay animación entre tandas. Solo
  cambia el número de la línea.
- **Voz:** el modal **tutea**. Las fichas de Ayuda siguen en **usted**. No se unifica.
- **ZIP:** un archivo. El cliente **no** lo explota. El aviso de «muchos PDF» vive en
  Ayuda, no en un banner extra del modal.

---

## Copy exacto

### Progreso (solo con `enviando && n > 1`)

Misma posición de familia que el contador: `text-xs`, muted, **debajo** del contador.
`role="status"` + `aria-live="polite"` (un solo live: este; el `role="alert"` del error
no corre en paralelo porque durante el envío no hay error pintado).

```
tanda {k} de {n}
```

`k` es 1-based y avanza cuando arranca cada POST. Ejemplos: `tanda 1 de 3` ·
`tanda 3 de 3`. Doce archivos → `n = 3`. Cincuenta → `n = 10`. Un ZIP solo → no se
pinta la línea (`n = 1`).

Prohibido en UI: `batch`, `lote`, `faltan N tandas`, `2/3`, `tanda 2/3`.

### 413 / 504 / HTML (reuso HU #12050 — no reescribir)

```
Esta carga pesa más de lo que el servidor admite. Pártala: quite archivos y sube el resto en otra carga.
```

```
El servidor no terminó a tiempo. Esta carga no se alcanzó a procesar. Espera un momento y vuelve a intentar, o súbela más liviana.
```

HTML de nginx → se descarta. Otro error no-HTML → `errorMessage(e)` como hoy. Mismo
`mensajeErrorCargaMasiva`.

### Primaria (rótulos)

| Estado | Rótulo | `disabled` |
|---|---|---|
| Vacío / validación | Subir y procesar | sí |
| Lleno | Subir y procesar | no |
| Enviando | Procesando… | sí |
| Error de red **sin** tandas ok | Subir y procesar | no |
| Éxito o fallo **parcial** | Listo | no |

---

## Estados (4) + copy

Vacío, validación y lleno **antes de pulsar** no cambian (spec de topes). Cargando y
el desenlace sí.

| Estado | Qué se ve | Siguiente paso |
|---|---|---|
| **Vacío** | Como HU #12050. | Elegir PDF, imágenes o un ZIP. |
| **Validación** | Como HU #12050. **Cero** POST. | Quitar archivos hasta que el contador vuelva a muted. |
| **Error** (0 tandas ok) | Formulario + contador + 413/504/error. Primaria encendida. Picker usable. | 413: partir. 504: esperar y reintentar, o aligerar. |
| **Lleno** (éxito) | Chips + tabla **fusionados** (concatenar cada arreglo de cada 200). **Listo**. | **Listo** (cierra y refresca la cola). |
| *Cargando* | Formulario intacto. Picker y checkbox apagados. Primaria: **Procesando…**. Si `n > 1`, línea `tanda k de n`. | Esperar. No cerrar a ciegas: las tandas ya enviadas ya quedaron en el servidor. |
| *Parcial* (nueva; es **Error** con datos) | **No** se vuelve al picker. Alert con el 413/504/error de la tanda que falló + chips/tabla de las tandas que sí contestaron. **Listo**. | Leer qué quedó. **Listo**. Lo que no salió en la tabla se vuelve a subir en otra carga. |

**Parada:** la primera tanda que no sea 200 **detiene** el envío. Las siguientes no
salen. No se inventa un segundo error por tanda ni se sigue «por si las otras pasan».

**Fusión:** mismos campos de hoy (`pagados` / `enRevision` / `duplicados` / `noAsociados`
en SOAT; más `conciliados` / `complementos` en Impuestos). Sin columna de tanda. Si
todas las tandas ok devuelven vacío, se queda el copy de hoy: `No se procesó ningún archivo.`

**Cierre a mitad (X / Esc / backdrop):** no se rediseña `FlitModal`. Si cierran con
tandas ya ok y sin haber visto resultado, esas filas ya están en la cola al refrescar.
No hay CTA «Abortar».

Wireframe del delta (SOAT; Impuestos es igual + checkbox intacto **entre** el `input`
y el contador):

```
Enviando (12 archivos → 3 tandas):
┌ Carga masiva de facturas SOAT                         ✕ ┐
│  Sube varios PDF/imágenes o un ZIP. …                    │
│  [ elegir archivos ]          ← apagado                  │
│  12 archivos · 48.2 MB de 250 MB                         │
│  tanda 2 de 3                                            │
│  [ Procesando… ]   [ Cancelar ]  ← los dos apagados      │
└──────────────────────────────────────────────────────────┘

Fallo parcial (tanda 1 ok, tanda 2 → 504):
┌ Carga masiva de facturas SOAT                         ✕ ┐
│  El servidor no terminó a tiempo. Esta carga no se       │
│  alcanzó a procesar. Espera un momento y vuelve a        │
│  intentar, o súbela más liviana.                         │
│  [Pagados 3] [En revisión 1] [Duplicados 0] [Sin asociar 1] │
│  ┌ Archivo │ Resultado │ Detalle …                       │
│  [ Listo ]                                               │
└──────────────────────────────────────────────────────────┘
```

---

## Permiso / slug

Sin cambio. El modal lo abren quienes ya ven **Cargar facturas (masivo)** /
**Cargar recibos (masivo)**. Auditor y Cliente no entran. No hay `PageSlug` nuevo.

---

## Fichas de ayuda (usted; AC7)

Sustituir el **paso 6**. No añadir un paso nuevo. No escribir «batch».

**`soat.md` paso 6 — texto completo:**

> 6. En una fila, pulse **Ver**. En adquisición, **Cargar factura** (un archivo) o, desde el encabezado, **Cargar facturas (masivo)**. En el masivo caben **hasta 50 archivos**, cada uno de **hasta 15 MB**. El modal le muestra el peso (**N archivos · X MB de 250 MB**). Si se pasa de la cantidad, del peso por archivo o del peso de la carga, FLITO se lo dice y no envía nada: quite archivos y vuelva a intentar. FLITO envía la carga **de 5 en 5**. Un ZIP cuenta como **un** archivo: el navegador no lo abre. Si el ZIP trae muchos PDF, el envío puede no terminar a tiempo; en ese caso suba los PDF sueltos.

**`flito_impuestos.md` paso 6 — texto completo:**

> 6. En el encabezado, **Cargar recibos (masivo)** sube los PDF, las imágenes o un ZIP del organismo. En una sola carga caben **hasta 50 archivos**, cada uno de **hasta 15 MB**. El modal le muestra el peso (**N archivos · X MB de 250 MB**). Si se pasa de la cantidad, del peso por archivo o del peso de la carga, FLITO se lo dice y no envía nada: quite archivos y vuelva a intentar. FLITO envía la carga **de 5 en 5**. Un ZIP cuenta como **un** archivo: el navegador no lo abre. Si el ZIP trae muchos PDF, el envío puede no terminar a tiempo; en ese caso suba los PDF sueltos.

Añadir **un** bullet al final de **Qué no hace** en ambas fichas (no reescribir el resto):

> - El ZIP de la carga masiva no se descomprime en el navegador: entra como un solo archivo. Si trae muchos PDF y el envío no termina a tiempo, suba los PDF sueltos.

---

## Accesibilidad (delta)

- `tanda k de n`: texto visible + `role="status"` `aria-live="polite"`. Sin `aria-live`
  extra en el contador.
- Picker y checkbox `disabled` mientras `enviando` (además de la primaria).
- Contraste: muted del kit y `text-red-600` de hoy.
- El estado parcial anuncia primero el `role="alert"`; la tabla no necesita live.

---

## Notas para QA (≤10)

1. 1–5 archivos: un POST; **Procesando…**; **no** aparece `tanda k de n`.
2. 6 archivos: `tanda 1 de 2` y luego `tanda 2 de 2`; dos POST al mismo endpoint; un solo resultado fusionado.
3. 1 ZIP (aunque pese poco y traiga muchos PDF): **una** tanda, **un** POST; el cliente no lista ni extrae entradas del ZIP.
4. Impuestos: el checkbox no se mueve; `sinMarcaDeAgua` viaja en cada tanda con el mismo valor.
5. Tanda 1 = 200 y tanda 2 = 504: se ve el copy de 504 de HU #12050 **y** chips/tabla de la tanda 1; **Listo**; no hay tercer POST.
6. Tanda 1 = 413 (HTML nginx): copy de partir la carga; **cero** `<html>`; si no hubo tanda ok, se queda el formulario (no una tabla vacía).
7. Éxito de todas las tandas: chips = suma de arreglos; sin columna «tanda»; primaria **Listo**.
8. Validación de topes (50 / 15 MB / 200 MB) sigue cortando **antes** de la primera tanda.
9. Ayuda SOAT e Impuestos: paso 6 dice «de 5 en 5», ZIP = un archivo, aviso de muchos PDF; no dice «batch».
10. Cancelar está apagado durante el envío. No hay barra ni segunda primaria.

---

## Decisiones y descartes

- **Línea solo si `n > 1`.** Con cinco archivos o un ZIP el wait es el de siempre;
  «tanda 1 de 1» no responde a esa visita.
- **Parada en el primer no-200.** Seguir enviando tras un 504 alarga el timeout y
  mezcla dos errores. El parcial ya enseña lo que sí quedó.
- **Sin «Reintentar el resto».** Dos primarias. El operador vuelve a elegir lo que
  no está en la tabla.
- **413/504 sin la palabra tanda.** El copy de HU #12050 ya dice el siguiente paso.
- **Sin explotar el ZIP.** AC7 + timeout de 90 s por petición: un ZIP gordo es una
  sola tanda a propósito. El aviso vive en Ayuda, no en un banner del modal.
- **Sin extraer un modal compartido.** Impuestos sigue teniendo el checkbox.
- **No se toca el timeout de 90 s** de `api.ts`. Cada tanda es una petición.
