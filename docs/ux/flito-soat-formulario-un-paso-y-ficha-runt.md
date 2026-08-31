# UX slim — Formulario en un paso y ficha RUNT en revisión (HU #11936)

> **Qué es este documento.** Entrada del `frontend-agent` para la
> [#11936](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/11936).
> Modo **slim**: no hay ruta ni `PageSlug` nuevos. Extiende dos superficies que ya existen.
>
> **Continúa** a `docs/ux/alta-solicitud-cliente-y-consulta-runt.md` (#11914) y
> `docs/ux/revision-rechazo-y-subsanacion.md` (#11915). **No los repite.** Lo que cambia es
> el **gate del RUNT**: deja de ser un paso del Cliente y pasa a ser una ficha de lectura
> en la revisión de Operaciones. El contrato lo entregó la #11935 (`POST /cliente` 201 sin
> esperar al RUNT; `GET /flito/soat/:id` proyecta `solicitud.verificacionEstado`,
> `soatVigente`, `soatVigenteHasta`, `verificacionCodigo`).
>
> **Fuera de alcance:** cola (pills, columnas, filtros); catálogo de causales; panel de
> Validar/Rechazar (XOR y copy de #11915 se quedan); legado `/soat`; correos.

---

## Superficies tocadas

| | |
|---|---|
| **A · Alta Cliente** | `apps/web/src/pages/FlitoSoatSolicitud.tsx` (`Alta`) + `bloques.tsx` (`EnEspera`) |
| **B · Revisión admin** | `BloqueRevision.tsx` dentro del modal `DetalleSoat` en `FlitoSoat.tsx` |
| **C · Subsanar** | `CorreccionSolicitud.tsx` (delta: no reintroduce «Consultar el RUNT») |
| **Slug / permiso** | `flito_soat`. Ninguno nuevo. Rutas iguales: `/flito/soat/solicitud` y `/flito/soat/solicitud/:id` |
| **Roles** | `cliente` radica y subsana. `admin` revisa (ficha + Validar XOR Rechazar). `auditor` ve la ficha en solo lectura. `proveedor`: la fila en `pendiente_revision` sigue sin existirle (`404`) |
| **Endpoints** | `POST /api/flito/soat/cliente` (multipart) · `PATCH /api/flito/soat/:id/solicitud` · `GET /api/flito/soat/:id`. **Se deja de llamar** `POST /cliente/preconsulta` desde estas pantallas |
| **PII** | Placa, VIN y documento **solo en el body**. URL: uuid opaco. El Cliente **no** ve `verificacionEstado` / `soatVigente` (datos de la operación) |
| **Patrón visual** | `FichaRunt` (`<dl>` + `StatusChip`), `FlitCard`, `flitBtn*`, `BloqueRevision`. Cero tokens nuevos |

---

## Copy de botones (canónico)

| Superficie | Control | Texto |
|---|---|---|
| Alta | Primario | **«Enviar la solicitud»** / en vuelo **«Enviando…»** |
| Alta | Secundario | **«Cancelar»** |
| Alta | Salida | **«← Volver a mis SOAT»** |
| Alta | — | **No existe** «Consultar el RUNT», «Consultar de nuevo» ni «Volver a consultar» |
| Subsanar | Primario | **«Reenviar la solicitud»** / **«Enviando…»** (ya existe) |
| Revisión | Primario / secundario | **«Validar»** · **«Rechazar la solicitud»** (XOR de paneles, #11915) |
| Ficha RUNT `pendiente` | Secundario | **«Actualizar verificación»** |

---

## Superficie A — Alta: un envío, sin Consultar el RUNT (AC1, AC2, AC3, AC5)

### Qué se quita

1. El botón **«Consultar el RUNT»** / **«Consultar de nuevo»** y toda la llamada a
   `POST /flito/soat/cliente/preconsulta`.
2. El gate `disabled={!runtListo}` de **«Enviar la solicitud»**. El primario se deshabilita
   **solo** mientras `enviando`.
3. `EnEspera` en los bloques 2 y 3: los tres bloques montan sus controles **desde el primer
   paint**.
4. La ficha «Datos del RUNT» en el alta. El Cliente **no** ve marca/línea/organismo: **no los
   teclea y no los espera**.
5. `ModalSoatVigente`. Un SOAT vigente **no impide crear** (AC3). El 409 `soat_vigente` **ya no
   es un desenlace de esta pantalla**; si el servidor lo devolviera sería una regresión de la
   #11935, no un modal.

### Qué se queda

- Validación de placa, VIN, tipo+número+nombre, PDF (`FlitUploadBox`, un solo PDF ≤ 15 MB).
- Contacto opcional (correo, teléfono, dirección).
- Confirmación al salir con datos escritos (`¿Descartar la solicitud?` / **«Seguir llenando»** /
  **«Descartar»**).
- **RN-01 (AC5):** `ModalVinEnCola` ante `409 vin_en_cola` / `VIN_YA_TIENE_SOAT`. Tres variantes
  intactas (propia rechazada → **«Abrir la solicitud rechazada»**; propia otra → **«Ver la
  solicitud»**; ajena → solo **«Volver a mis SOAT»**, sin estado ni id).
- Tarjetas de canal deshabilitado / canal ajeno (#11914).

### Wireframe (estado inicial = llenable)

```
┌  ← Volver a mis SOAT
│  Solicitud de SOAT
│  Escriba la placa, el VIN y los datos del propietario, y adjunte
│  la factura de venta. Al enviarla queda en revisión de FLITO.
│
┌─ 1 · Vehículo ─────────────────────────────────────────────────┐
│  Placa *          VIN (número de chasis) *                     │
│  [ ABC123    ]    [ 9BWZZZ377VT004251        ]                 │
│  La marca, la línea, el modelo y el organismo los consulta     │
│  FLITO después. Usted no tiene que escribirlos.                │
└────────────────────────────────────────────────────────────────┘
┌─ 2 · Propietario ──────────────────────────────────────────────┐
│  Tipo * · Número * · Nombre o razón social *                   │
│  Correo, teléfono, dirección (opcionales)                      │
└────────────────────────────────────────────────────────────────┘
┌─ 3 · Factura de venta ─────────────────────────────────────────┐
│  Un solo archivo PDF · máximo 15 MB                            │
└────────────────────────────────────────────────────────────────┘
  Al enviarla, la solicitud pasa a revisión de FLITO. No se guarda
  como borrador.
                         [ Cancelar ]  [ Enviar la solicitud ]
```

**Documento vuelve al bloque 2.** Hoy `CamposDocumento` está en el bloque 1 porque la
preconsulta lo exigía (Bug #11927). Sin preconsulta, tipo+número viven con el propietario,
que es el orden del AC1.

### Los 4 estados — alta

Esta superficie **ya no tiene red hacia el RUNT**. Los cuatro estados son los del
formulario y del `POST /cliente`.

| Estado | Cuándo | Qué se ve | Copy |
|---|---|---|---|
| **1 · Cargando** | Se pulsó Enviar | Primario `disabled`, texto **«Enviando…»**; el resto de la página no se borra | `role="status"` sr-only: **«Enviando…»** |
| **2 · Error de campo** | Validación al enviar o al salir del campo | `aria-invalid` + `<p role="alert">` por campo; foco al primero; banda sobre los botones | **«Revise los datos marcados antes de enviar.»** · errores por campo **iguales** a #11914 §2.9 (placa, VIN, documento, nombre, correo, PDF) |
| **2b · Error de envío** | `400` PDF, `403` canal, red incierta, `409` VIN | PDF: caja `rejected` + alerta. Canal: sustituye el form por `TarjetaCanalDeshabilitado avisoCarrera`. Red incierta: **no** reenviar a ciegas. VIN: `ModalVinEnCola` | PDF / canal / red: copy #11914. VIN: copy de `ModalVinEnCola` **sin cambiar** |
| **3 · Vacío** | Primer paint, sin datos | Tres bloques abiertos, primario visible (no muerto) | Subtítulo de arriba · ayuda del bloque 1 · nota: **«Al enviarla, la solicitud pasa a revisión de FLITO. No se guarda como borrador.»** |
| **4 · Lleno / éxito** | `201` | Navega a `/flito/soat`; toast | **«Solicitud enviada. FLITO la va a revisar.»** · la fila nueva sale **Pendiente de revisión** |

**AC2 en una frase:** un RUNT caído o sin registro **no existe en esta pantalla**. No hay
banda, no hay reintento, no hay aborto. El job de la #11935 corre después del 201; Operaciones
lo ve en la ficha (superficie B).

**AC3 en una frase:** no hay modal «Ya tiene SOAT vigente» ni copy que diga «FLITO no radica».
El Cliente envía igual.

### Acciones

| Acción | Habilitada cuando | Qué hace |
|---|---|---|
| **«Enviar la solicitud»** | Siempre, salvo `enviando` | Valida en cliente → `POST /flito/soat/cliente` (multipart: placa, VIN, tipo, número, nombre, contacto, `facturaVenta`) |
| **«Cancelar»** / **«← Volver…»** | Siempre | Cola; con datos, pide confirmación |

No hay invalidación por cambio de placa/VIN: no hay resultado de RUNT que invalidar.

---

## Superficie B — Ficha RUNT en la revisión (AC3, AC4)

Vive **dentro** de `BloqueRevision`, **encima** de los botones Validar / Rechazar (el revisor
lee factura + RUNT antes de actuar). **Solo lectores internos** (`admin`, `auditor`). El
`cliente` no la ve: su bloque sigue siendo «Por qué se rechazó» + **«Corregir y reenviar»**.

Los datos salen del **mismo** `GET /flito/soat/:id` que el bloque ya hace:

- Chip y aviso: `solicitud.verificacionEstado`, `soatVigente`, `soatVigenteHasta`, `verificacionCodigo`.
- `<dl>`: `marca`, `linea`, `organismoNombre` del SOAT (ya en el detalle). **Modelo** (`vehicles.year`)
  no viaja hoy en el DTO → se pinta **«—»**. No hay endpoint nuevo.

**«vigente» no es un valor de `verificacionEstado`.** Es `verificacionEstado === 'ok'` **y**
`soatVigente === true`. Los otros cinco chips mapean 1:1 el enum.

### Los 6 desenlaces (chip + cuerpo)

Todos reusan `StatusChip` (texto, no solo color) + el `<dl>` de `FichaRunt`. Hueco en marca /
línea / modelo / organismo = **«—»**, nunca banda roja de carga.

| Desenlace | Condición | Chip (`tone`) | Cuerpo |
|---|---|---|---|
| **pendiente** | `verificacionEstado === 'pendiente'` | **«Esperando al RUNT»** (`draft`) | **«La marca, la línea, el modelo y el organismo los trae el RUNT. Mientras responde, los verá vacíos: no es un error.»** + **«Actualizar verificación»** (re-GET). **No** es estado 2 de la superficie |
| **caído** | `'caido'` | **«RUNT no disponible»** (`warning`) | **«El RUNT no respondió. Puede validar o rechazar con la factura de venta y los datos que tecleó el cliente.»** |
| **sin registro** | `'sin_registro'` | **«Sin registro en el RUNT»** (`warning`) | **«El RUNT no tiene un vehículo con esa placa y ese VIN. Revise la factura de venta.»** |
| **no cuadra** | `'no_cuadra'` | **«No cuadra con el RUNT»** (`danger`) | **«La placa o el VIN no coinciden con el registro del RUNT. Revise la factura de venta.»** |
| **ok** | `'ok'` y no vigente | **«Coincide con el RUNT»** (`success`) | `<dl>` Marca / Línea / Modelo / Organismo de tránsito (nombre, nunca DIVIPOLA). Pie: **«Estos datos los trajo el RUNT y no se editan.»** |
| **vigente** (AC3) | `'ok'` y `soatVigente === true` | **«SOAT vigente»** (`warning`) | Banda `role="alert"` **además** del `<dl>`: **«Este vehículo tiene SOAT vigente.»** / Con fecha: **«Según el RUNT, la póliza está vigente hasta el {fecha larga}.* Lo habitual es rechazar la solicitud. Puede validarla si es una excepción.»** / Sin fecha: **«Según el RUNT, este vehículo tiene una póliza SOAT vigente.»** + la misma segunda frase. **No** se inventa fecha ni se escribe «hasta el —» |

\*Misma construcción de fecha que `ModalSoatVigente` (`new Date(año, mes - 1, día)`, no
`new Date('yyyy-mm-dd')` UTC).

**Variante de `ok` con `verificacionCodigo === 'organismo_no_catalogado'`:** el chip sigue
siendo **«Coincide con el RUNT»**. Bajo el organismo (probablemente «—»): **«El RUNT reportó
un organismo que aún no está en el catálogo de FLITO. No impide validar ni rechazar.»** No es
un séptimo desenlace.

### Los 4 estados — ficha / bloque de revisión

El bloque **ya** tenía carga, error, vacío de trámite y lleno. La ficha se inserta en el
**lleno** de `pendiente_revision` (y, en solo lectura, en `rechazada` interna: el desenlace
del RUNT sigue siendo útil para saber por qué se rechazó o se validó).

| Estado | Cuándo | Qué se ve | Copy |
|---|---|---|---|
| **1 · Cargando** | `GET /:id` en vuelo | Texto existente del bloque | **«Cargando la solicitud…»** (`role="status"`) |
| **2 · Error** | El GET falló | Banda + reintento existentes | **«No pudimos cargar los datos de la revisión.»** · **«Volver a cargar la revisión»** |
| **3 · Vacío** | `solicitud === null` (fila de trámite) | El bloque **no se monta** | — |
| **3b · Espera (AC4)** | Canal + `verificacionEstado === 'pendiente'` | Chip draft + «—» en el `<dl>` + **«Actualizar verificación»**. **No** es error | Copy de **pendiente** arriba |
| **4 · Lleno** | Cualquiera de caído / sin registro / no cuadra / ok / vigente | Chip + cuerpo de la tabla | Ver desenlaces |

**Validar XOR Rechazar (AC4):** se conserva el panel `idle | validar | rechazar` de la
#11915. **Ningún desenlace del RUNT deshabilita un botón.** Incluido vigente: lo habitual es
rechazar, la excepción es validar, y las dos acciones siguen ahí. Un `disabled` en Validar
convertiría la excepción en imposible.

No hay poll automático: el revisor pulsa **«Actualizar verificación»** o cierra y vuelve a
abrir. El job de la #11935 es corto; un poll inventaría red que el AC no pide.

**Cola:** no se añade columna ni chip de vigente. El aviso claro es **esta** ficha, con los
campos que el `GET` de detalle ya proyecta. La lista no los trae.

---

## Superficie C — Subsanar sin Consultar el RUNT (AC5)

`CorreccionSolicitud.tsx` **ya** no llama a preconsulta. El delta es de **no reintroducirla**:

- Placa y VIN siguen de solo lectura (`identificadoresGuardados`).
- No hay botón «Consultar el RUNT».
- No hay `ModalSoatVigente`.
- El `<dl>` de vehículo (marca/línea/organismo si el job los rellenó) se queda como identidad
  guardada. Si están en «—», es que el RUNT no llenó: **no** es un error de esta pantalla y
  **no** se exige una consulta para reenviar.
- Primario sigue **«Reenviar la solicitud»** → `PATCH /:id/solicitud`.

Los 4 estados de esta vista (skeleton / error+reintento / 404 o ya no rechazada / form) **no
cambian** respecto de #11914 §6.3.

---

## Permiso / slug

Sin cambios. `puedeSolicitarSoat` sigue gobernando el alta. `puedeRevisar` sigue siendo
`esOperaciones && !soloLectura && estado === pendiente_revision`. La ficha RUNT se pinta
cuando el bloque se pinta para un lector interno; **nunca** con `!esCliente` como única
guarda (le daría el chip de vigente al Cliente).

---

## Accesibilidad (delta)

- Orden de tabulación del alta: Volver → Placa → VIN → Tipo → Número → Nombre → Correo →
  Teléfono → Dirección → factura → Cancelar → Enviar. **Sin** el hueco que dejaba «Consultar
  el RUNT».
- Cada input con `<label>` asociado (los `Campo` / `FlitSelect` / `FlitUploadBox` ya lo
  hacen).
- Ficha RUNT: `<h3>` real, `<dl>` fuera del tab order (texto, no controles). Chip con
  texto. Banda de vigente: `role="alert"`. Espera: `role="status"`.
- Foco al enviar con error: primer campo inválido (`useFocoPrimerError`).
- Prohibido cédula, VIN o placa en `aria-label` / query / path (salvo uuid).

---

## Notas para QA (≤10)

Sesión `CLIENTE_USER` (1–5) y `ADMIN` (6–10). Interceptar `POST /flito/soat/cliente` y
`GET /flito/soat/:id`. **No** hay ruta de preconsulta que mockear.

1. **AC1 · un envío.** Con placa, VIN, tipo+número+nombre y PDF: **una** petición a
   `POST /cliente`, aterrizaje en la cola, toast «Solicitud enviada…», chip «Pendiente de
   revisión». `getByRole('button', {name:/Consultar el RUNT/})` → `toHaveCount(0)`.
2. **AC1 · no teclea el vehículo.** `getByRole('textbox', {name:/Marca|Línea|Organismo/})` →
   `toHaveCount(0)` y ningún `input[disabled]` de esos campos.
3. **AC2 · el form no aborta.** El `POST` responde 201 aunque el GET de detalle posterior
   traiga `verificacionEstado: 'caido'` o `'sin_registro'`. En el alta **no** hay
   `role="alert"` de RUNT ni botón «Volver a consultar».
4. **AC3 · vigente no bloquea al Cliente.** Tras enviar, **ningún** `role="dialog"` con
   «SOAT vigente». `POST /cliente` se disparó.
5. **AC5 · RN-01 y subsanar.** `409` VIN propia rechazada: modal «Ese vehículo ya está en la
   cola…» y **«Abrir la solicitud rechazada»**. En `/solicitud/:id` **no** hay «Consultar el
   RUNT»; **«Reenviar la solicitud»** hace `PATCH` sin preconsulta.
6. **AC4 · espera ≠ error.** Detalle `pendiente_revision` + `verificacionEstado: 'pendiente'`:
   chip «Esperando al RUNT», `<dl>` con «—», **sin** `role="alert"` de carga fallida,
   **«Actualizar verificación»** visible. Validar y Rechazar **siguen** en el DOM.
7. **AC4 · seis desenlaces.** Caído / sin registro / no cuadra / ok / vigente pintan el chip
   de la tabla (no se colapsan en un solo «RUNT»). Ok **sin** `soatVigente` **no** muestra la
   banda de vigente.
8. **AC3 · aviso en Operaciones.** `ok` + `soatVigente: true`: banda `role="alert"` con
   «SOAT vigente» y «Lo habitual es rechazar». **«Validar»** **no** está `disabled`.
9. **AC4 · XOR humano.** En `idle` hay los dos botones; al abrir Validar no está el formulario
   de rechazo, y al revés. El Cliente en su `pendiente_revision`:
   `getByRole('button', {name:/Validar|Rechazar/})` → `toHaveCount(0)` y **sin** chip
   «Esperando al RUNT».
10. **PII.** En el recorrido, `page.url()` no contiene placa, VIN ni documento.

---

## Decisiones y descartes

| # | Decisión | Descarte |
|---|---|---|
| 1 | Alta de **un paso**, tres bloques abiertos, un `POST` | Wizard / `EnEspera` / gate `runtListo` |
| 2 | **Cero** «Consultar el RUNT» en alta y subsanación | Dejar el botón «opcional»: seguiría pareciendo un requisito |
| 3 | `ModalVinEnCola` **sí**; `ModalSoatVigente` **no** | Fundirlos: RN-01 y vigencia son causas distintas y ahora una no bloquea |
| 4 | Ficha RUNT **solo** en revisión interna, con 6 desenlaces | Pintarla en la cola o al Cliente |
| 5 | Vacío de `pendiente` = **espera** (`role="status"`) | Banda roja «no se pudo cargar» |
| 6 | Vigente: banda clara + Validar **sigue activo** | Deshabilitar Validar o reabrir el modal de bloqueo |
| 7 | Reusar `FichaRunt` + `StatusChip` | Inputs `disabled` o un patrón nuevo |
| 8 | Sin poll; **«Actualizar verificación»** | Auto-refresh que el AC no pide |
| 9 | Sin endpoint nuevo: modelo ausente = **«—»** | Pedir `year` al API en esta HU |

**Requerimientos nuevos de datos: ninguno.** El contrato de la #11935 basta.
