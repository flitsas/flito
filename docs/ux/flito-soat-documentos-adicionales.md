# UX slim: Documentos adicionales del SOAT, alta del Cliente y detalle (HU #13363)

Feature #13360 · Épica #13201 · Módulo **FLITO** `flito-soat` (`/api/flito/soat`), no el legacy `soat`.
Modo **slim**: no hay ruta, `PageSlug` ni pantalla nueva. Se extienden dos superficies que ya existen.
Contrato de datos: HU #13362 (`docs/arquitectura/hu-13362-documentos-adicionales-soat.md`). **No hace falta ningún endpoint nuevo.**

Análogas del mismo público:
- Alta (Cliente): bloque «2 · Factura de venta» de `FlitoSoatSolicitud.tsx` (`docs/ux/flito-soat-factura-leida-y-propietario-prellenado.md`).
- Detalle (operación FLIT / proveedor): sección «Comprobante» de `DetalleSoat.tsx` y la descarga individual (`docs/ux/flito-soat-descarga-comprobantes.md`).

**Fuera de alcance:** cargar o eliminar desde el detalle (HU #13365), la cola, la ayuda y los correos. Los componentes se diseñan para que la #13365 los reutilice (ver «Componentes»), pero aquí no se diseña esa HU.

---

## 1 · Superficie tocada

| Zona | Qué cambia |
|---|---|
| `pages/FlitoSoatSolicitud.tsx` (alta del Cliente) | Nuevo bloque **«4 · Documentos adicionales (opcional)»** debajo de «3 · Propietario» y encima de la barra de envío pegajosa. El `FormData` del alta suma `documentosAdicionales` (archivos) y `etiquetasDocumentosAdicionales` (alineadas por índice, ver `archivosDelAlta` en `flito-soat-documentos.upload.ts`). Se manejan dos desenlaces nuevos: descartes en el 201 y en el 202. |
| `components/flito/soat/DetalleSoat.tsx` (modal de detalle) | Nueva `Seccion titulo="Documentos adicionales"` **justo después de «Comprobante»**, solo con `hasFuncion('soat.documentos_adicionales.ver')`. |
| Componentes nuevos (en `components/flito/soat/`, **no** en la página, que ya tiene 1305 líneas) | `DocumentosAdicionalesSelector` (elegir, etiquetar, validar, quitar) · `DocumentosAdicionalesLista` (lectura con 4 estados y descarga) · función pura `validarAdicionales(archivos)` exportada aparte. |

---

## 2 · Delta de claridad

**Qué vino a hacer quien abre el alta:** lo de siempre, pedir el SOAT de un vehículo recién comprado. Los adicionales son un **extra opcional** (p. ej. un poder o la cédula de quien firma). Por eso no compiten con nada:

- **Qué se ve primero no cambia:** el VIN (bloque 1).
- **La única primaria sigue siendo «Enviar al gestor».** «Elegir archivos» y «Quitar» son secundarios.
- **Los adicionales nunca bloquean el envío ni suman pendientes** a la frase de faltantes (`#sol-falta`). Ni vacíos, ni con inválidos.
- **Posición: bloque 4, después de Propietario.** El AC pide «debajo del de factura»; va debajo, pero no pegado. Si se metiera entre la factura (2) y el propietario (3), separaría la factura de los datos que esa misma factura prellena, y algo opcional quedaría en medio de lo obligatorio. Al final del formulario, un bloque opcional se lee como opcional. **Decidido por David (2026-10-07): bloque 4, al final del formulario, después de Propietario.**
- **Mismo patrón visual que la factura:** `Seccion` con número e icono (`Paperclip` del set `lucide` que ya usa la página) y la misma caja de carga (`FlitUploadBox`). Si la caja no admite `multiple`, se le añade la prop. No se crea otra caja.
- **Qué se calla:** el «máximo técnico» de 100 archivos del servidor, los códigos (`supera_tamano`…), los MIME (`image/heic`) y los hash. El Cliente lee «PDF», «Imagen JPG», «15 MB».

**Qué vino a hacer quien abre el detalle (operador):** revisar el caso. Los adicionales son **soporte que se consulta**, como el comprobante. Por eso van a continuación de él y con el mismo peso: una lista corta, sin primaria. **La descarga no es primaria** (consultar no es operar; misma regla que en `flito-soat-descarga-comprobantes.md`).

**Densidad:** en el alta, sin cambio en lo obligatorio: el bloque vacío es una caja y una línea. En el detalle se suma una sección corta que solo existe con la función.

---

## 3 · Alta: wireframes y copy (canal Cliente, **usted**)

### 3.1 Vacío (estado inicial; se puede enviar así, AC1)

```
┌─ 📎 4 · Documentos adicionales (opcional) ───────────────────────────────────┐
│      ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐                        │
│               ⬆  Elegir archivos                                              │
│         PDF, JPG, PNG, WEBP o HEIC · hasta 15 MB cada uno                     │
│      └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘                        │
│  Si tiene otros documentos que ayuden con la solicitud, adjúntelos aquí.      │
│  Hasta 20 archivos y 250 MB en total. No son obligatorios.                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Título: **«4 · Documentos adicionales (opcional)»**. Sin chip en el vacío.
- Texto de la caja: **«Elegir archivos»** / **«PDF, JPG, PNG, WEBP o HEIC · hasta 15 MB cada uno»**.
- Línea de ayuda: **«Si tiene otros documentos que ayuden con la solicitud, adjúntelos aquí. Hasta 20 archivos y 250 MB en total. No son obligatorios.»**
- `<input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif">`. El `accept` es una ayuda y no una validación: la validación real es la de §3.3.

### 3.2 Con archivos (lleno)

```
┌─ 📎 4 · Documentos adicionales (opcional) ──────────────── 3 para adjuntar ──┐
│  [ ⬆ Elegir más archivos ]                       3 archivos · 4,8 MB de 250 MB │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ poder-notaria.pdf                                   PDF · 1,2 MB  [✕] │   │
│  │ Etiqueta (opcional)                                                    │   │
│  │ [ Poder autenticado                                              ]    │   │
│  ├──────────────────────────────────────────────────────────────────────┤   │
│  │ IMG_2041.HEIC                                       HEIC · 3,1 MB [✕] │   │
│  │ Etiqueta (opcional)                                                    │   │
│  │ [                                                                ]    │   │
│  ├──────────────────────────────────────────────────────────────────────┤   │
│  │ rut.png                                         Imagen PNG · 0,5 MB [✕]│   │
│  │ Etiqueta (opcional)                                                    │   │
│  │ [ RUT                                                            ]    │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│  Si no les pone etiqueta, se guardan con el nombre del archivo.              │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Chip `tone="neutral"`: **«{n} para adjuntar»** (singular: **«1 para adjuntar»**). Cuenta **solo los válidos**.
- Con archivos, la caja grande se sustituye por un botón secundario **«Elegir más archivos»** (`flitBtnSecondary`) y, a su derecha, el contador **«{n} archivos · {x} MB de 250 MB»**, en `--flit-text-secondary`. Elegir más **suma** a la lista y no la reemplaza.
- Cada fila: **nombre del archivo** (tal cual, truncado con `…` y `title` completo), **tipo legible** y **tamaño** a la derecha, y el botón de icono ✕.
  - Tipos legibles: `PDF`, `Imagen JPG`, `Imagen PNG`, `Imagen WEBP`, `HEIC`, `HEIF`.
  - Tamaño: en MB con un decimal y coma (`1,2 MB`); por debajo de 0,1 MB, en KB (`85 KB`).
- **Etiqueta (opcional):** un `flitInp` por archivo con su `<label>` visible **«Etiqueta (opcional)»**. Placeholder **«Ej.: Poder autenticado»** solo en la primera fila. `maxLength` = el límite que acepte el backend de #13362 (si no hay, 80). Al escribir, la etiqueta **no reemplaza** el nombre en la fila: el nombre sigue arriba para que se sepa de qué archivo se habla.
- Lo que el AC2 llama «lista con etiqueta (o nombre)» se cumple en el **resultado** (detalle, avisos): la etiqueta, o el nombre si no la hay. En la lista de elección mandan el nombre y la etiqueta editable debajo.
- Nota de pie: **«Si no les pone etiqueta, se guardan con el nombre del archivo.»**
- **Quitar (✕):** quita la fila sin confirmar, porque se puede volver a elegir. `aria-label="Quitar {nombreArchivo}"`. Al quitar, el foco pasa al ✕ de la fila siguiente; si no la hay, al de la anterior; si la lista queda vacía, a la caja «Elegir archivos». **No** hay «Quitar todos».

### 3.3 Con inválidos (AC3: se marcan, no se adjuntan, no bloquean)

```
┌─ 📎 4 · Documentos adicionales (opcional) ──────────────── 2 para adjuntar ──┐
│  [ ⬆ Elegir más archivos ]                       2 archivos · 1,7 MB de 250 MB │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ poder-notaria.pdf                                   PDF · 1,2 MB  [✕] │   │
│  │ Etiqueta (opcional)  [ Poder autenticado                       ]      │   │
│  ├──────────────────────────────────────────────────────────────────────┤   │
│  │ rut.png                                         Imagen PNG · 0,5 MB [✕]│   │
│  │ Etiqueta (opcional)  [                                         ]      │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  No se van a adjuntar (2)                                                    │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ ⚠ planilla.xlsx                                                   [✕] │   │
│  │   Formato no permitido. Use PDF, JPG, PNG, WEBP o HEIC.               │   │
│  ├──────────────────────────────────────────────────────────────────────┤   │
│  │ ⚠ video-placa.mp4 · 48,0 MB                                        [✕] │   │
│  │   Pesa más de 15 MB.                                                  │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│  Puede enviar la solicitud igual: estos archivos no viajan.                  │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Los inválidos van **en un grupo aparte, debajo de los válidos**, con el encabezado **«No se van a adjuntar ({n})»**. No van mezclados: así se ve de un vistazo qué se envía y qué no.
- Cada inválido: ⚠ + nombre (+ tamaño si el motivo es de peso), el motivo debajo en `--flit-danger-ink` y un ✕ para descartarlo de la vista (`aria-label="Descartar {nombreArchivo}"`). **No tienen campo de etiqueta**: no viajan.
- Línea final en `role="status"`: **«Puede enviar la solicitud igual: estos archivos no viajan.»**
- **Nada se deshabilita** y `#sol-falta` no cambia.
- Ningún inválido lleva `aria-invalid`: no es un campo con error, es un archivo que no entra.

**Motivos (copy exacto; los mismos para la validación en pantalla y para los descartes del servidor):**

| Regla | Código del servidor (`MotivoDescarteDocumentoAdicional`) | Copy |
|---|---|---|
| Formato no permitido (por extensión y tipo; el servidor revisa el contenido real) | `formato_no_permitido` | **«Formato no permitido. Use PDF, JPG, PNG, WEBP o HEIC.»** |
| Más de 15 MB | `supera_tamano` | **«Pesa más de 15 MB.»** |
| El archivo 21 en adelante | (el del máximo de cantidad) | **«Ya hay 20 archivos, que es el máximo.»** |
| Con él se superan los 250 MB en total | `supera_total` | **«Con este archivo se superarían los 250 MB en total.»** |
| Repetido (mismo nombre y mismo tamaño que uno ya elegido; el servidor lo detecta por contenido) | (el de repetido) | **«Ya lo eligió.»** |
| Código desconocido (rama por defecto) | otro | **«No se pudo adjuntar este archivo.»** |

Reglas de la validación en pantalla (función pura `validarAdicionales`, reutilizable por la #13365):
- Se evalúa **en el orden de elección**. Los cupos de 20 y de 250 MB los consumen los válidos que llegaron antes; el que no cabe queda inválido y los anteriores no se tocan.
- Quitar un válido **no reactiva** solo a un inválido: el usuario lo vuelve a elegir. Es más predecible que ver aparecer un archivo en la lista sin haber hecho nada.
- El frontend mapea **por `codigo`, nunca por el `motivo` de texto del servidor**. Los literales salen de `MotivoDescarteDocumentoAdicional` de `@operaciones/shared-types`, sin cadenas sueltas.

### 3.4 Envío: los desenlaces (AC4 y AC5)

| Desenlace | Patrón | Copy |
|---|---|---|
| **201 sin descartes** (o sin adicionales) | Sin cambio: `toastOk(TOAST_ENVIADA)` y navegación a la cola. | El de hoy. |
| **201 con descartes** | **Un solo toast**, que **sustituye** al de éxito (no se suman dos). Cerrable con ✕ (`aria-label="Cerrar aviso"`), no se cierra solo antes de **10 s**, tono de aviso y no de error. Navega a la cola igual que hoy. | **«Su solicitud se envió.»** + **«No se adjuntaron {n} documentos:»** + lista agrupada por motivo, p. ej. **«— planilla.xlsx: formato no permitido.»** / **«— foto.jpg: ya estaba en la solicitud.»** Máximo 3 nombres; si hay más, **«y {k} más.»** Cierre: **«La solicitud sigue su curso sin ellos.»** |
| **202 «por validar»** (RUNT caído; los adicionales **sí** se guardan) | La tarjeta de confirmación que ya reemplaza al formulario (`setGuardada`) gana **una línea** y, si hay descartes, el **mismo bloque de descartes en la página**. Aquí no hay toast, porque la tarjeta ya es un aviso que se queda. | Con aceptados: **«Junto con la solicitud guardamos {n} documentos adicionales.»** (singular: **«…guardamos 1 documento adicional.»**). Con descartes: **«No se adjuntaron:»** + la lista completa, un renglón por archivo **«{nombre}: {motivo en minúscula, sin punto}»**. Sin adicionales: no se añade nada. |
| **Error que bloquea el alta** (4xx/5xx/red) | Sin cambio en el copy de hoy (`encajarFallo`). **Los adicionales elegidos, sus etiquetas y los inválidos siguen en el bloque 4 tal como estaban** (AC5): no se vacía la lista en el `catch` ni en el `finally`. | El de hoy. |

- En el toast, los motivos van en minúscula y sin punto final dentro de la frase («formato no permitido», «pesa más de 15 MB», «ya estaba en la solicitud»). El de **repetido** del servidor dice **«ya estaba en la solicitud»** y no «ya lo eligió», porque el servidor lo detectó por contenido aunque el nombre fuera distinto.
- Nunca `e.message`, nunca el `motivo` crudo del servidor, nunca el código.
- **Enviando:** el rótulo del primario ya cambia durante el envío. Si hay adicionales válidos, la línea de estado de la barra dice **«Enviando la solicitud y {n} documentos… puede tardar si son pesados.»** (`role="status"`). Ver la decisión de tiempo de espera en §7.

---

## 4 · Detalle: sección «Documentos adicionales» (operador; copy neutro)

`DetalleSoat` lo abre también el Cliente (`esCliente`). La sección solo aparece con la función, y su copy es **neutro** (sin tú ni usted), para que se lea bien en los dos públicos.

### 4.1 Lleno

```
┌ Documentos adicionales ─────────────────────────────────────────────────┐
│ Poder autenticado                                        [ Ver ] [⬇]   │
│ PDF · 1,2 MB · 07/10/2026 14:32 · Ana Pérez                             │
│ ─────────────────────────────────────────────────────────────────────── │
│ IMG_2041.HEIC                                                    [⬇]   │
│ HEIC · 3,1 MB · 07/10/2026 14:32 · Ana Pérez · Sin vista previa        │
│ ─────────────────────────────────────────────────────────────────────── │
│ RUT                                                      [ Ver ] [⬇]   │
│ Imagen PNG · 0,5 MB · 07/10/2026 14:32 · Ana Pérez                      │
└─────────────────────────────────────────────────────────────────────────┘
```

- Lista (`<ul>`) y no tabla: en el modal no caben columnas, y son pocas filas.
- Línea 1: **etiqueta** (el servidor ya guarda el nombre del archivo cuando no hubo etiqueta), en `--flit-text-primary`, con truncado y `title`.
- Línea 2: **tipo · tamaño · fecha y hora · quién cargó**, en `--flit-text-secondary`, `text-xs`. Fecha `dd/mm/aaaa hh:mm` en hora de Colombia, con el formateador que ya use el detalle. Quién cargó = `subidoPorNombre` tal como llega (el servidor ya lo proyecta).
- Orden: el de la API (no se reordena en el cliente).
- **«Ver»** (`flitBtnSecondary`, texto) para PDF/JPG/PNG/WEBP: abre la vista previa con `VisorSoportes` si acepta una URL o lista; si no, la abre en una pestaña nueva con la `url` (`target="_blank" rel="noopener"`). **No se crea un visor nuevo.**
- **HEIC/HEIF:** sin «Ver», y al final de la línea 2 **«Sin vista previa»**. Así no queda un hueco que parezca un fallo.
- **Descargar** (botón de icono ⬇, mismo alto que «Ver»): `aria-label="Descargar {etiqueta}"` y `title` igual. Descarga con `url`. Candado por id contra el doble clic, como en `useDescargaComprobante`. Éxito: sin toast (la descarga del navegador es el resultado). Error: toast cerrable **«No se pudo descargar «{etiqueta}». Intente de nuevo.»** con «Reintentar». Si la `url` caducó (403/404 de almacenamiento), el reintento vuelve a pedir la lista antes de descargar.

### 4.2 Los 4 estados (AC8)

| Estado | Qué se ve |
|---|---|
| Cargando | Esqueleto de **2 filas** con la misma forma (línea larga + línea corta + dos cajas de botón), con el esqueleto del kit. Sin spinner. El resto del modal no espera a esta sección. |
| Error | **«No se pudieron cargar los documentos adicionales.»** + botón secundario **«Reintentar»**, en `role="alert"` y tinta `--flit-danger-ink`. Solo esta sección: el resto del detalle sigue usable. |
| Vacío | **«Sin documentos adicionales.»** + debajo, en `--flit-text-secondary`: **«Aquí aparecen los que se adjunten en la solicitud.»** |
| Lleno | §4.1. |

### 4.3 Permiso (AC6/AC7)

- `hasFuncion('soat.documentos_adicionales.ver')`. Sin la función, la sección **no está en el DOM** (ni título ni petición): `GET /api/flito/soat/:id/documentos-adicionales` **no se llama**.
- El alta no lleva permiso nuevo: el gate sigue siendo `puedeSolicitarSoat(user)`. Página `pagina.flito-soat` / `flito_soat`, sin cambio.
- PII: los archivos y las etiquetas viajan solo en el **cuerpo** del `POST` multipart. La lectura va por uuid en el path. Ningún nombre de archivo ni etiqueta va a una URL del router.

---

## 5 · Componentes y reutilización (para la #13365)

- `validarAdicionales(elegidos, yaPresentes?)`: función pura con las reglas de §3.3. Recibe opcionalmente lo que ya existe (en el detalle de la #13365, los documentos ya guardados cuentan para los cupos de 20 y 250 MB y para «repetido»).
- `DocumentosAdicionalesSelector`: **controlado** (`value`, `onChange` con `{archivo, etiqueta, motivo?}[]`). No sabe nada del alta ni del envío. La #13365 lo monta en el detalle con su propio botón de enviar.
- `DocumentosAdicionalesLista`: recibe el `soatId` y pinta los 4 estados. Deja un hueco opcional de acciones por fila (`accionesExtra?`) donde la #13365 pondrá «Eliminar», sin rediseñar la fila. **Esta HU no pinta eliminar.**
- Mapa `codigo → copy` y formateadores de tipo y tamaño en un solo módulo, compartido por el selector, el toast y la tarjeta 202.

---

## 6 · Responsive (<`lg`) y feedback

**360 px:**
- Alta: la `Seccion` ocupa el ancho. La fila de archivo se apila: nombre (truncado) + ✕ arriba, `tipo · tamaño` debajo y el campo de etiqueta a ancho completo. «Elegir más archivos» pasa a `w-full sm:w-auto` y el contador cae a la línea siguiente (`flex-wrap`). Los nombres largos sin espacios llevan `min-w-0` + `truncate` (o `break-all` en el título): **sin desborde horizontal**.
- Detalle: la línea de metadatos envuelve; «Ver» y ⬇ quedan a la derecha de la etiqueta, en `flex-wrap`, y si no caben bajan debajo, alineados a la izquierda. Sin tabla, sin scroll horizontal.
- Toast de descartes: ancho del `Toaster` del kit, la lista envuelve y se recorta en 3 nombres.

**Feedback (hover sutil + foco) en todo lo nuevo:**
- Caja de carga: el hover y el foco que ya tiene `FlitUploadBox`. Si no los tiene, borde `--flit-border` → tinta `--flit-blue-text` al hover y `flit-focus` en el foco del input.
- «Elegir más archivos», «Ver», «Reintentar»: `flitBtnSecondary` + `hoverSecundario` (el de `DescargarSoportesZip`, reutilizado y no redeclarado) + `flit-focus`.
- ✕ y ⬇: botones cuadrados del mismo alto que su vecino, velo `--flit-bg-hover` al hover, `transition-colors`, `flit-focus`. Área de toque ≥ 32 px en móvil.
- Inputs de etiqueta: `flitInp`, con su foco.
- Una sola altura de control por fila.
- Sin animaciones, sin barra de progreso, sin sombras nuevas. Tema oscuro: solo tokens con par (`--flit-danger-ink`, `--flit-text-secondary`, `--flit-bg-hover`, `--flit-blue-text`, `--flit-border`). Sin HEX ni `red-*`/`gray-*`.

---

## 7 · Accesibilidad y notas para el implementador

- Cada etiqueta tiene `<label htmlFor>` con «Etiqueta (opcional)» + `aria-describedby` hacia el nombre del archivo de su fila. Así el lector anuncia «Etiqueta (opcional), poder-notaria.pdf».
- ✕ = `aria-label="Quitar {nombre}"` (válidos) o `"Descartar {nombre}"` (inválidos). ⬇ = `"Descargar {etiqueta}"`. «Ver» con texto visible.
- La lista de inválidos y su línea final se anuncian con `role="status"` al aparecer. El error de la sección del detalle va en `role="alert"`.
- Al elegir archivos el foco **no se mueve** (sigue en la caja o en el botón). Al quitar, sigue la regla de §3.2.
- Contraste ≥ 4.5:1 en texto en los dos temas. Para axe: `QA_AXE_CDN=1`.
- **Tiempo de espera (decidido por David, 2026-10-07):** `api.ts` corta a 90 s por defecto y ese default no cambia. Solo la llamada de alta (`POST /api/flito/soat/cliente`) **cuando lleva adicionales** pide 10 minutos con `api.postConTimeout` (opción por llamada del cliente HTTP único, con el techo `TIMEOUT_MAX_MS` de 600 s, por debajo del `proxy_read_timeout` de 900 s). Sin adicionales, el alta sigue con los 90 s de siempre.
- ⚠ `FlitoSoatSolicitud.tsx` está en 1305 líneas físicas: vigilar `max-lines` con `npx eslint`. Todo lo nuevo va en componentes; en la página solo entran el montaje del bloque, el estado y el `append` al `FormData`.

---

## 8 · Notas para QA (≤10)

1. **AC1:** sin elegir nada, el alta se envía y el `FormData` no lleva `documentosAdicionales`. `#sol-falta` nunca menciona documentos adicionales.
2. **AC2:** elegir 3 archivos → 3 filas con nombre, tipo y tamaño; escribir etiqueta en 2. El `FormData` lleva 3 archivos y `etiquetasDocumentosAdicionales` **alineadas por índice** (la vacía, vacía). Quitar la del medio realinea las etiquetas.
3. **AC3:** elegir a la vez `.xlsx`, un PDF de 16 MB y el mismo PDF válido dos veces → 3 en «No se van a adjuntar» con sus motivos exactos, 1 válido, y el envío habilitado. El `FormData` lleva solo el válido.
4. **AC3 (cupos):** 22 archivos válidos → 20 para adjuntar y 2 con «Ya hay 20 archivos, que es el máximo.» Archivos de 14 MB hasta pasar de 250 MB → el que excede lleva el motivo del total.
5. **AC4 (201):** interceptar un 201 con `descartados` → **un** toast con «Su solicitud se envió.», los nombres y los motivos pulidos (no el `motivo` del servidor ni el código), cerrable con ✕, y navegación a la cola.
6. **AC4 (202):** un 202 con aceptados y descartes → la tarjeta «por validar» dice «guardamos {n} documentos adicionales» y lista los descartados. Sin toast.
7. **AC5:** forzar un 500 en el alta → el copy de hoy, y el bloque 4 conserva archivos, etiquetas e inválidos.
8. **AC6/AC7:** con la función, la sección muestra etiqueta, tipo, fecha y hora, y quién cargó; un HEIC no tiene «Ver» y dice «Sin vista previa»; ⬇ descarga. Sin la función: `toHaveCount(0)` en la sección y **ninguna** petición a `/documentos-adicionales`.
9. **AC8:** demorar la lectura (esqueleto), responder 500 (mensaje + «Reintentar», que relanza), responder `{documentos: []}` («Sin documentos adicionales.»).
10. **AC9:** a 360 px, sin scroll horizontal de página en el alta ni en el modal con un nombre de 80 caracteres sin espacios. Tab llega a cada ✕, etiqueta, «Ver» y ⬇ con foco visible. Probar los dos temas. `page.url()` nunca contiene nombres de archivo ni etiquetas.

---

## 9 · Decisiones y descartes

| Decisión | Descarte |
|---|---|
| Bloque 4 al final del formulario | Entre factura y propietario: corta el flujo factura → prellenado y pone algo opcional en medio de lo obligatorio |
| Inválidos en un grupo aparte, con su motivo | Mezclados con los válidos y en rojo: no se ve de un vistazo qué viaja |
| No bloquear el envío por inválidos | Exigir que se quiten antes de enviar: contradice el AC3 y convierte un extra en un peaje |
| 201 con descartes = un toast que sustituye al de éxito | Dos toasts · aviso en la cola (exigiría pasar estado por la navegación y es un patrón nuevo) |
| 202 = descartes dentro de la tarjeta que ya existe | Toast encima de una tarjeta que ya es un aviso persistente |
| Etiqueta opcional, con el nombre siempre visible | Que la etiqueta reemplace el nombre en la fila (se pierde de qué archivo se habla) |
| Lista en el detalle, no tabla | `FlitTable` en un modal con 3 o 4 columnas: scroll horizontal para 3 filas |
| Sin visor nuevo; HEIC sin vista previa y dicho en texto | Conversión de HEIC en el navegador (dependencia nueva, fuera del AC) |
| Cero animaciones, barra de progreso, sombras o ilustraciones | — |

## 10 · Oficio

| Pregunta | Respuesta |
|---|---|
| ¿Qué vino a hacer? | Alta: pedir el SOAT y, si quiere, sumar soportes. Detalle: revisar el caso y consultar sus soportes |
| ¿Qué se ve primero? | Alta: el VIN, sin cambio. Detalle: lo de hoy; la sección va después de «Comprobante» |
| ¿Única primaria? | «Enviar al gestor» (sin cambio). En el detalle, la sección no tiene primaria |
| ¿Vacío y error con siguiente paso? | Sí: el vacío del alta dice qué adjuntar y los límites; los inválidos dicen «puede enviar igual»; el error del detalle tiene «Reintentar»; el vacío del detalle dice de dónde llegan |
| ¿Efectos o patrón nuevo? | Ninguno: `Seccion`, `FlitUploadBox` (`multiple`), `flitInp`, `flitBtnSecondary`, `hoverSecundario`, toast cerrable ya usado |
| ¿Móvil? | §6: filas apiladas, botones a ancho completo, sin desborde a 360 px |
| ¿Feedback? | §6: hover sutil + `flit-focus` en caja, ✕, ⬇, «Ver», «Reintentar» y «Elegir más» |
| ¿Notificación? | 201 limpio: toast de hoy · 201 con descartes: un toast cerrable ≥10 s · 202: dentro de la tarjeta · error de alta: copy de hoy · error de descarga: toast con «Reintentar» |
| ¿Tono? | Alta: **usted**. Detalle: neutro (lo comparten Cliente y operador) |
