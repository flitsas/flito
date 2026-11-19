# UX slim — Selector Inicial / Renovación en la solicitud de SOAT (HU #14019)

Feature #14012 · Épica #13760 · módulo `flito-soat`, canal Cliente. Modo **slim**: no hay ruta ni `PageSlug`
nuevos. Se extienden pantallas y patrones que ya existen; **no se inventa ningún componente de aviso**.

**Mockup aprobado por el humano:** https://claude.ai/artifact/45RgBrmbF8r26cyFJjyziD
Estado del doc: **v3, listo para `frontend-agent`**. Si el mockup y este doc difieren, manda este doc.

> Contrato leído en `packages/shared-types/src/flito-estados.ts`. El doc `docs/diseno-feature-14012-...` vive en
> `origin/develop` y no se pudo leer; si contradice algo de UI, el hilo me lo pasa.
> v2: §3.4, §5–§7, §10, §13 contra el código real. v3 (decisiones finales del humano tras el mockup): barra de envío
> (§3.5), rótulo «Enviar solicitud» (§3.6), subtítulos por tipo (§3.1), vacío de la cola (§6), posición del selector,
> cierre de preguntas (§14).

**Análogas del mismo público (Cliente):** `docs/ux/flito-soat-factura-leida-y-propietario-prellenado.md` (#12094),
`docs/ux/flito-soat-solicitud-incompleta-runt.md` (#12841), `docs/ux/soat-cliente-tarjeta-soat-activo.md` (#12844).
Tratamiento: **usted** en solicitud, modales y cola Cliente. En la cola vista por operador se calca su tono.

---

## 1. Superficie tocada

| Superficie | Archivo | Cambio |
|---|---|---|
| A · Solicitud `/flito/soat/solicitud` | `pages/FlitoSoatSolicitud.tsx` (779/800: solo cablear; el rótulo y la barra se mueven a archivos nuevos si no caben) | Selector entre «Compañía» y «1 · Vehículo»; bloque 1 según tipo; bloque 2 opcional en renovación; subtítulo por tipo; **barra de envío anclada** y rótulo «Enviar solicitud» |
| B · Vehículo ya en FLITO | `TarjetaSoatActivo.tsx` (variantes nuevas), `ModalesBloqueo.tsx` (`ModalVinEnCola` gana «Renovar») | Mismos patrones que hoy, con días y «Renovar» |
| C · Cola real `/flito/soat` | `pages/FlitoSoat.tsx` + tabla | Pastilla de tipo en la fila; copy del vacío del Cliente |
| D · Por validar | `DetalleIncompletaSoat.tsx`, `TarjetaSolicitudGuardada.tsx` | Tipo, placa y motivo |

Slug/permiso: `flito_soat`, `puedeSolicitarSoat(user)`. Rol: `cliente` con canal. PII: placa y documento solo en
cuerpo de `POST`; nunca en URL, `aria-label` ni título de modal. Datos nuevos: ninguno.

## 2. Delta de claridad

**Qué vino a hacer:** pedir o renovar el SOAT de un vehículo. Primero decide *qué clase*: el selector va primero y
lo demás espera (sin tipo no se pintan los bloques 1–3 ni la barra de envío).

**Una sola primaria por estado:**

| Estado | Primaria | Secundarias |
|---|---|---|
| Sin tipo | ninguna (el selector es el foco) | — |
| Tipo elegido, sin consultar | «Consultar» (la de hoy en el bloque 1) | — |
| Consultado, vehículo nuevo en FLITO | **«Enviar solicitud»** (barra anclada) | «Volver a consultar», «Cancelar» |
| Ya en FLITO, renovable (tarjeta) | «Renovar» | «Consultar otro vehículo» |
| Ya en FLITO, fuera de ventana (tarjeta) | ninguna | «Consultar otro vehículo» |
| Vehículo en proceso (modal) | «Ver la solicitud» (hoy) | «Volver a mis SOAT» |
| 409 de Inicial, renovable (modal) | «Renovar» | «Ver la solicitud», «Volver a mis SOAT» |
| 422 / error de consulta (banda) | «Consultar» (la banda no lleva botón) | — |
| RUNT caído, formulario completo | «Guardar pendiente de validar» (#12841) | «Cancelar» |

**Se calla:** `soatId`, `fuenteVigencia`, `modalidadConsulta`, códigos y motivos técnicos; el VIN del RUNT en
renovación no se muestra antes de continuar. **Densidad:** la solicitud mejora (renovación = menos campos y factura
opcional); la cola solo suma una pastilla en la fila.

---

## 3. Superficie A — selector y formulario (en `/flito/soat/solicitud`)

### 3.1 Wireframe (≥ lg) y subtítulo por tipo

Orden de la página: cabecera → tarjeta **«Compañía»** (sin cambio) → **selector de tipo** → «1 · Vehículo» → … → barra de envío.

```
PageHeaderCard «Solicitud de SOAT»   subtítulo (cambia según el tipo, ver tabla)
┌─ Compañía ─ (sin cambio) ──────────────────────────────────────────────────┐
┌─ Tipo de SOAT ─────────────────────────────────────────────────────────────┐
│ ( ) SOAT inicial                         ( ) Renovación                     │  radiogroup
│     Vehículo nuevo o que nunca               El vehículo ya tuvo SOAT.      │
│     ha tenido SOAT. Se consulta              Se consulta por placa y        │
│     por el VIN.                              documento del propietario.     │
└─────────────────────────────────────────────────────────────────────────────┘
— Renovación —
┌─ 1 · Vehículo ─────────────────────────────────────────────────────────────┐
│ Placa *              Documento del propietario *                            │
│ [XYZ123      ]       [1234567890            ]   [ Consultar ]               │
│ «Sin tipo de documento: el RUNT valida el número contra la placa.»          │
│ (bajo el renglón: BandaDesenlace | TarjetaSoatActivo | EsqueletoFicha)       │
└─────────────────────────────────────────────────────────────────────────────┘
┌─ 2 · Factura de venta (opcional) ──────────────────────────────── Opcional ─┐
│ [ zona de carga PDF ]  «Si la adjunta, FLITO lee el propietario y lo llena. │
│                         Si no, escríbalo.»                                   │
└─────────────────────────────────────────────────────────────────────────────┘
┌─ 3 · Propietario ───────────────────────────────────────────────────────────┐
│ #12094. El número de documento del bloque 1 prellena SOLO el número,         │
│ editable; el resto, de la factura o a mano.                                  │
└─────────────────────────────────────────────────────────────────────────────┘
(espacio reservado al pie para que la barra nunca tape un campo)
═ Barra de envío anclada (ver §3.5) ═════════════════════════════════════════
```

**Subtítulo de la cabecera (reemplaza al fijo de hoy):**

| Estado | Subtítulo |
|---|---|
| Sin tipo | «Elija el tipo de SOAT para empezar.» |
| SOAT inicial | «Escriba el VIN, adjunte la factura de venta y complete el propietario.» (el de hoy) |
| Renovación | «Escriba la placa y el documento del propietario, adjunte la factura si la tiene y complete el propietario.» |

El subtítulo cambia con el tipo y anuncia nada más (no `aria-live`; el anuncio lo hace el selector, §4).

### 3.2 Estados del selector (los 4)

| Estado | Qué se ve |
|---|---|
| Cargando | Sin carga propia: lo cubre el esqueleto actual de la página mientras llegan permisos/compañía. |
| Error | No aplica al selector (es local); los errores son de la consulta (§3.3). |
| Vacío (sin tipo) | Dos tarjetas sin marcar; nada debajo (ni bloques ni barra). Sin valor por defecto (AC1). |
| Lleno | Una marcada; aparecen los bloques de ese tipo y la barra. |

Si algún camino intentara consultar sin tipo: `<p role="alert">` bajo el selector «Elija el tipo de SOAT antes de consultar.».

### 3.3 Estados de la consulta del bloque 1

| Estado | Comportamiento / copy |
|---|---|
| Cargando | Botón `disabled` con `Loader2` y «Consultando…»; `EsqueletoFicha` debajo (el de hoy). |
| Error | `BandaDesenlace` (503 `runt_no_disponible`, sin red, genérico): copy de #12841 sin cambio, con «Volver a consultar». En renovación, «completar» pide solo el propietario (factura opcional). |
| Vacío | Campos vacíos; `VacioVin` adaptado en renovación: «Con la placa y el documento del propietario, el RUNT le trae la marca, la línea, el modelo y la ficha técnica. Usted no tiene que escribirlos.» |
| Lleno | Ficha del RUNT + chip «✓ Consultado», y según contexto, la tarjeta o el modal de §5. |

### 3.4 ESTÁNDAR de mensajes en esta pantalla (hoy en el código) y dónde cae cada mensaje nuevo

| Tipo de mensaje | Canal existente | Estructura | Ejemplo vigente |
|---|---|---|---|
| Resultado de la consulta al RUNT (falla, no cuadra, sin registro, sin red) | **`BandaDesenlace`** bajo el renglón del bloque 1 (`role="alert"`, tono `warning`/`danger`) | **Título** corto (`text-primary`, semibold) + **detalle** de una frase con el siguiente paso (`text-secondary`). Sin botón propio | «El RUNT no está respondiendo en este momento.» + detalle |
| Error de un campo (validación local) | **`<p role="alert">`** bajo el campo, `--flit-danger-text`, `aria-describedby` | Una frase que dice qué corregir | «Para enviar falta: …» |
| Resultado de una acción (guardó, envió, reintentó) | **Toast** (`toastOk` / `toastError` de `ToastFlito`), cerrable, una frase | Qué pasó y qué sigue | `TOAST_ENVIADA` |
| Bloqueo por vehículo ya existente (RN-01) | **`FlitModal`** (`ModalVinEnCola`, `ModalIncompletaExistente`) | Título = la frase del bloqueo + `StatusChip warning` + 2 frases + acciones | «Ese vehículo ya está en la cola de FLITO» |
| Estado persistente del vehículo (SOAT activo / vigencia) | **`TarjetaSoatActivo`** en el bloque 1 | Título + chip + fechas + acción | «Este vehículo todavía tiene SOAT activo» |
| Pregunta de confirmación (cambiar de tipo) | `FlitModal` | Título-pregunta + frase + botones | §4 |

**Mapeo de los mensajes nuevos (AC8; nunca `e.message` ni códigos):**

| Origen | Canal | Título | Detalle (siguiente paso) |
|---|---|---|---|
| 422 `SOAT_SIN_ANTERIOR` | `BandaDesenlace` tono `warning` | «El RUNT no registra un SOAT anterior para esta placa» | «Si este vehículo nunca ha tenido SOAT, elija «SOAT inicial» arriba para solicitarlo.» |
| 422 `runt_no_cuadra` (campo `placa` o `vin`) | `BandaDesenlace` tono `warning` | el de hoy para ese campo | el de hoy; en renovación habla de la placa, no del VIN |
| «Documento que no corresponde» | `BandaDesenlace` tono `warning`; foco a «Documento del propietario» | «El documento no corresponde al propietario de esta placa» | «Revise el número del documento y vuelva a consultar.» No dice cuál es el real |
| **Cualquier código no mapeado** | `BandaDesenlace` tono `warning`, el `GENERICO` existente | «No pudimos consultar el vehículo» | «Revise la placa y el documento, o inténtelo de nuevo en unos minutos.» **Nunca** el texto ni el código crudo |
| Placa mal formada / documento vacío | `<p role="alert">` bajo el campo | — | «Escriba la placa sin espacios, por ejemplo ABC123.» / «Escriba el documento del propietario.» |
| 409 `VIN_YA_TIENE_SOAT` (Inicial) | `FlitModal` (`ModalVinEnCola`) | ver §5 | ver §5 |
| Vehículo en FLITO tras consultar (renovación) | `TarjetaSoatActivo` o `ModalVinEnCola` | ver §5 | ver §5 |
| Desenlace del reintento en «Por validar» | Toast (el actual de `useReintentoRunt`) | — | textos existentes; descarte `sin_soat_anterior`: sección de descarte del detalle con `MOTIVO_DESCARTE_TEXTO` (ya existe) |

**Riesgo conocido (antes P3):** el backend (`campoQueNoCuadra`) solo devuelve `'vin' | 'placa'`; un RUNT `ok:false`
por documento llega por otra vía. El `frontend-agent` **mapea los códigos reales de `CodigoErrorSolicitudSoat`**
(shared-types) a la tabla de arriba y cae en el mensaje genérico para todo código sin mapear. Si se confirma un código
propio para «documento», se añade la fila sin cambiar el canal.

### 3.5 Barra de envío (decisión final: opción A, anclada al borde inferior)

**Problema de hoy:** `sticky bottom-2 lg:bottom-[5.5rem]` al final del formulario flota y tapa contenido al entrar.
**Nuevo:**
- Banda de **ancho completo** del área de contenido, **anclada al borde inferior del viewport** (`fixed`/`sticky` al borde), con su borde inferior **por encima del menú flotante del shell** (mismo respeto de `lg:bottom-[5.5rem]` que hoy; verificar contra el shell en móvil) y por encima del contenido (z-index del kit).
- **Padding inferior reservado** en el formulario igual a la altura de la banda (+ el offset del menú) para que nunca tape un campo.
- Al llegar al final del formulario, **es la misma barra en su sitio** (no aparece una segunda).
- Disposición ≥ lg: frase **«Para enviar falta: …»** a la izquierda (con `role="status"`/descripción como hoy); a la derecha **«Cancelar»** (secundaria) y la **primaria**.
- Móvil (<lg): apilada, **la primaria arriba**, luego «Cancelar», luego la frase. Botones `w-full`.
- Solo se pinta con tipo elegido. Sin tipo, no hay barra.
- Descartada: opción B (pegada arriba).

```
≥ lg  ═══════════════════════════════════════════════════════════════════════
      Para enviar falta: la consulta del RUNT y la factura.     [Cancelar] [ Enviar solicitud ]
      ═══════════════════════════════════════════════════════════════════════
< lg  [ Enviar solicitud ]   (primaria, ancho completo)
      [ Cancelar ]
      Para enviar falta: la consulta del RUNT y la factura.
```

Estados de la barra: cargando = «Enviando…»/«Guardando…» con `Loader2`, botones `disabled`; error = toast `toastError` y la banda sigue (aviso de campo en su campo); vacío = botón `aria-disabled` (no `disabled`) con la frase de faltantes; lleno = primaria activa con la frase de completo. Hover sutil y `flit-focus` en ambos botones.

### 3.6 Rótulo del botón: «Enviar solicitud» (solo esta pantalla)

- `ROTULO_ENVIAR` de `FlitoSoatSolicitud.tsx` pasa de «Enviar al gestor» a **«Enviar solicitud»** (sentence case).
- Se actualizan el `aria-describedby`/anuncio accesible y la frase de faltantes que nombran el botón (la plantilla «Para enviar falta: …» no cambia; el anuncio del foco «…Enviar al gestor, no disponible, Para enviar falta…» pasa a «Enviar solicitud, no disponible, …»).
- **NO cambian:** «Enviar al gestor (N de M)» de la cola (`BarraEnvioSoat`), el de Impuestos, «Enviar a Operaciones», ni `ROTULO_GUARDAR` («Guardar pendiente de validar»).
- Por qué: el Cliente no «envía al gestor» (jerga interna del proceso); envía una solicitud. Coherente con la regla del canal Cliente.

**Impactos para QA/E2E (solo los que apuntan al botón de la SOLICITUD; cambiar `name: 'Enviar al gestor'` → `'Enviar solicitud'` en el localizador `btnEnviar`):**

| Archivo | Línea (hoy) | Acción |
|---|---|---|
| `apps/web/e2e/tests/soat-cliente-compania.spec.ts` | 104 | actualizar `btnEnviar` |
| `apps/web/e2e/tests/soat-vin-unico-ficha-runt.spec.ts` | 124 | actualizar `btnEnviar` |
| `apps/web/e2e/tests/soat-documentos-adicionales.spec.ts` | 58 | actualizar `btnEnviar` |
| `apps/web/e2e/tests/soat-cliente-solicitud.spec.ts` | 17, 232–233, 287 | actualizar `btnEnviar` y los títulos/comentarios que nombran el rótulo |
| `apps/web/e2e/tests/soat-factura-ocr-propietario.spec.ts` | 141 | actualizar `btnEnviar` (no listado por el pedido; usa la solicitud) |
| `apps/web/e2e/tests/soat-envio-directo-gestor-a11y.spec.ts` | 118 | visita `/flito/soat/solicitud`: actualizar |
| `apps/web/e2e/tests/soat-envio-directo-gestor.spec.ts` | 90, 286 | **verificar** si el localizador apunta a la solicitud o a la cola antes de cambiar |
| `flito-soat.spec.ts`, `flito-soportes-zip.spec.ts`, `flito-impuestos*.spec.ts`, `proveedores-inactivos-desplegables.spec.ts`, `ayuda-capturas.capturas.spec.ts:1348` | — | **no tocar**: son la cola/Impuestos |

**Ficha de ayuda `apps/web/src/content/ayuda/soat.md`:** cambiar a «Enviar solicitud» las menciones del botón de la solicitud: línea 36 (texto «**Enviar al gestor** no envía nada hasta…» y el alt de la captura `04-solicitar-soat.png`), 38 (dos veces: botón fijo al pie y «Pulse **Enviar al gestor**»), 39 («Los documentos viajan… al pulsar»), 41 («hasta **Enviar al gestor**») y 71 («cuando pulse **Enviar al gestor**»). **No tocar** la línea 32 (cola de selección: «Enviar al gestor (3 de 8)») ni la 60 (permiso de la cola). La captura `04-solicitar-soat.png` muestra el botón: se regenera (`flit-ayuda-flito`, gate de ayuda). `public/ayuda/soat/ciclo-soat.svg` «Enviar al gestor» es el ciclo, no la solicitud: no cambia.

## 4. Cambiar de tipo (AC6)

- Limpia todo lo dependiente: campos del bloque 1, resultado/ficha/banda/tarjeta de la consulta, factura, lectura y propietario; el subtítulo y la barra se adaptan al tipo nuevo.
- **Con datos escritos o consultados:** `FlitModal` título «¿Cambiar el tipo de SOAT?», texto «Se borrarán los datos que ya escribió o consultó.», botones «Cambiar el tipo» (primaria) y «Mantener» (secundaria). Sin datos: cambia directo.
- Cambio programático (**«Renovar» del modal 409**): sin confirmación; limpia igual y deja el foco en «Placa» (el usuario la teclea).
- Tras el cambio manual el foco queda en la tarjeta de tipo; `aria-live="polite"` anuncia «Formulario de renovación» / «Formulario de SOAT inicial». Sin toast.

## 5. Superficie B — «Ya está en FLITO»: dónde y tras qué acción

**Patrón real hoy en `/flito/soat/solicitud`, tras pulsar «Consultar»:** el estado persistente del vehículo es una
**tarjeta en línea en el bloque 1** (`TarjetaSoatActivo`, #12844) y el bloqueo por solicitud ya existente (RN-01) es
un **`FlitModal`**. Se respetan ambos. **No hay tarjeta nueva ni pantalla aparte.**

| Variante | Cuándo aparece | Pantalla/patrón | Contenido exacto |
|---|---|---|---|
| **Renovable, vigente (0–30 días)** | Renovación, tras «Consultar», `yaEnFlito && renovable && diasVigencia ≥ 0` | `TarjetaSoatActivo` variante nueva `renovar`, en el bloque 1, `role="status"`, sin mover foco | Título «Ya está en FLITO · quedan N días» (N=1 «queda 1 día»; 0 «Ya está en FLITO · vence hoy»). Chip `active` «Puede renovarlo ya». «Vence el {fecha larga}.» Primaria «Renovar»; sec. «Consultar otro vehículo» |
| **Renovable, vencido** | `diasVigencia < 0` | misma tarjeta, tono `warning` | Título «Ya está en FLITO · venció». Chip «Renuévelo para dejarlo vigente». «Venció el {fecha larga}.» Mismos botones |
| **Fuera de ventana (>30 días, sin proceso abierto)** | `yaEnFlito && !abierto && !renovable` | misma tarjeta, **sin botón primario** | Título «Ya está en FLITO · quedan N días». «Podrá renovarlo cuando falten 30 días o menos.» Solo «Consultar otro vehículo» |
| **En proceso** | Renovación, tras «Consultar», `abierto` | **`ModalVinEnCola`** (`propia`, `estado` del contexto, `id`=`soatId`) | Título «Ese vehículo ya está en la cola de FLITO»; chip «No se puede crear otra solicitud»; «Este vehículo ya tiene una solicitud de SOAT en FLITO, en estado {Estado}. Cada vehículo puede tener una sola.» «Puede seguir su estado desde sus SOAT.» Primaria «Ver la solicitud»; sec. «Volver a mis SOAT». Cero copy nuevo |
| **409 de Inicial, renovable** | Inicial, tras «Consultar»/«Enviar solicitud», 409 `vin_ya_tiene_soat` con contexto `renovable` | `ModalVinEnCola` con una frase más y botón nuevo | Mismo título y chip. «Este vehículo ya tiene SOAT en FLITO. Para un SOAT nuevo no hace falta pedir uno inicial: renueve el que tiene.» Primaria **«Renovar»** (pasa a Renovación, limpia, foco en «Placa»; el usuario la teclea); «Ver la solicitud» y «Volver a mis SOAT» secundarias |
| **409 de Inicial, no renovable o abierto** | contexto sin `renovable` | `ModalVinEnCola` **sin cambio** | Copy y botones de hoy |
| **409 ajeno (sin contexto)** | `propia:false` | `ModalVinEnCola` **sin cambio** | Frontera de no-sondeo intacta: ni días ni «Renovar» |

Notas:
- «Renovar» de la tarjeta **continúa el flujo** en la misma pantalla: la tarjeta se contrae a chip «✓ Consultado» y se muestran bloques 2–3 y la barra. No consulta de nuevo.
- Tarjeta y no modal para renovable: es un estado que sigue cierto mientras la placa no cambie (justificación de #12844) y lleva la acción de la visita. El modal se reserva para el bloqueo duro (RN-01).
- Estados: la tarjeta/modal no hacen petición (usan el contexto devuelto); **cargando** = «Consultando…»/`EsqueletoFicha`; **error** = `BandaDesenlace`; **vacío** = no existe sin contexto; **lleno** = la tabla.
- En la variante `renovar` solo se muestran fecha y días (no hay póliza ni aseguradora en `SoatFlitoContexto`).
- Notificación: sin toast (tarjeta persistente; modal de bloqueo). A11y: tarjeta `role="status"` sin robar foco; modal `FlitModal` con focus trap y `restoreFocusRef` al campo «Placa».

## 6. Superficie C — la cola real (`/flito/soat`), dibujada como es hoy

Cómo se llega: **menú SOAT → cola «SOAT» → pastilla «Por validar» de la barra de filtros → abrir la fila**
(abre `DetalleIncompletaSoat`).

```
PageHeaderCard «SOAT»                           [ + Solicitar SOAT ]  ← primaria (Cliente)
  subtítulo Cliente: «Sus solicitudes de SOAT y las pólizas de su compañía.»
BarraFiltrosSoat:  [Todos] [Solicitado] [Pagado] … [Por validar] [Descartadas]   (+ búsqueda)
Tabla (kit) — columnas actuales, sin columna nueva:
 Identificador            Estado                    … Acciones
 XYZ123  (Renovación)     [🛡 Por validar]          [Ver] [Reintentar consulta]
 ▲ DELTA 1                ▲ DELTA 2: bajo el chip, línea tenue «El RUNT no respondió»
```

- **Chips de estado:** los de hoy; «Por validar» sigue con su **ícono de escudo naranja**. La pastilla de tipo es **neutra y sin ícono** para no competir con el chip.
- **Delta 1:** pastilla neutra «Inicial» / «Renovación» junto al identificador (VIN en Inicial; **placa** en Renovación con RUNT caído, `vin = null`). En todas las filas del canal; filas de trámite (`tipoSoat = null`): sin pastilla.
- **Delta 2:** en «Por validar», línea tenue bajo el chip: solo **«El RUNT no respondió»**.
- **Delta 3 (vacío del Cliente):** copy hoy «Todavía no hay ningún SOAT de su compañía en FLITO. Solicite el primero con la placa y el VIN del vehículo.» → **«Todavía no hay ningún SOAT de su compañía en FLITO. Solicite el primero con el VIN del vehículo, o con la placa si es una renovación.»** Con el siguiente paso de siempre: botón «Solicitar SOAT».
- **Sin** filtro por tipo, columna nueva ni pastilla de estado nueva.
- Estados de la cola (cargando, error con Reintentar, vacío, lleno): sin cambio salvo el copy del vacío.
- Móvil: la pastilla envuelve bajo el identificador; chip y motivo apilados; tabla con scroll del kit.

## 7. Superficie D — Por validar (detalle y tarjeta de guardado)

- `DetalleIncompletaSoat` (FlitModal, `wide`): hoy el título es `Solicitud · ${fila.vin}`; con `vin = null` quedaría vacío.
  **Delta:** «Solicitud · {placa}» en Renovación y pastilla de tipo junto al chip de estado. Texto de la sección pendiente: «la placa y el documento del propietario» en lugar del VIN en Renovación.
- «Reintentar consulta» (acción principal, como hoy): en Renovación consulta con placa y documento guardados; no pide nada. Desenlaces: toasts y secciones existentes de `useReintentoRunt`.
- `TarjetaSolicitudGuardada`: en Renovación «Placa {placa}» en lugar de «VIN»; copy y primaria («Ir a mis SOAT») sin cambio.
- Estados del detalle: cargando/error (con reintento)/lleno sin cambio; el vacío no aplica.

## 8. Responsive (<lg) y feedback

- Selector: `grid-cols-1 sm:grid-cols-2`, tarjetas apiladas en 375 px, objetivo táctil ≥ 44 px.
- Bloque 1 renovación: placa y documento `grid-cols-1 sm:grid-cols-2`; «Consultar» `w-full sm:w-auto`.
- Tarjeta `renovar` y modales: botones en `flex-wrap`, primaria primero en móvil.
- Barra de envío: apilada con la primaria arriba (§3.5).
- Hover/foco: tarjetas del selector con hover `--flit-bg-hover` y `flit-focus`; seleccionada = borde del token + punto del radio. Claro y oscuro solo con tokens `--flit-*`.

## 9. Accesibilidad

- `role="radiogroup"` con `aria-labelledby`; radios reales con `<label>`; flechas cambian opción; el cambio con datos abre el `FlitModal` (Escape = «Mantener»).
- Cada input con `<label>` y `aria-describedby` a ayuda y error; errores de campo `role="alert"`.
- `BandaDesenlace` es `role="alert"`; la tarjeta `renovar`, `role="status"`; placa y documento nunca en `aria-label` ni título de modal.
- Barra anclada: el botón `aria-disabled` conserva su `aria-describedby` a la frase de faltantes (ahora con «Enviar solicitud»); el padding reservado evita que el foco por teclado quede oculto tras la banda (`scroll-padding-bottom`).
- «Opcional» del bloque 2 es texto. Contraste ≥ 4,5:1 en ambos temas.

## 10. Componentes: extender, no crear avisos

| Cambio | Archivo | Tipo |
|---|---|---|
| Selector de tipo + confirmación | `components/flito/soat-cliente/SelectorTipoSoat.tsx` | **nuevo** (control de formulario) |
| Bloque 1 de renovación | `components/flito/soat-cliente/BloqueVehiculoRenovacion.tsx` | **nuevo** (campos) |
| Barra de envío anclada (si no cabe en la página) | `components/flito/soat-cliente/BarraEnvioSolicitud.tsx` | **nuevo**, reubica la barra actual; mismos botones del kit |
| Variante `renovar` | `components/flito/soat-cliente/TarjetaSoatActivo.tsx` | **extiende**; días/fechas a `lib/soatCliente.ts` si crece |
| «Renovar» y frase en 409 | `components/flito/soat-cliente/ModalesBloqueo.tsx` (`ModalVinEnCola`) | **extiende** (prop opcional `contexto`) |
| Copy de los 422 y genérico | `lib/soatCliente.ts` / `DesenlaceRunt` | **extiende** → `BandaDesenlace` |
| Pastilla de tipo | `components/flito/soat/EtiquetaTipoSoat.tsx` | **nuevo** (pastilla neutra; no es aviso) |

`FlitoSoatSolicitud.tsx` (779/800) solo importa y cablea.

## 11. Notas para QA (≤10)

1. Sin tipo no hay bloques, ni barra, ni consulta; subtítulo «Elija el tipo de SOAT para empezar.» (AC1).
2. Renovación: placa + documento, sin tipo de documento; nada en URL; subtítulo de renovación (AC2).
3. Con factura se llena el propietario; sin factura queda vacío y editable; el número del bloque 1 prellena solo el número (AC2).
4. Renovable con 30, 1 y 0 días: «quedan 30 días», «queda 1 día», «vence hoy»; vencido «venció»; «Renovar» continúa el flujo (AC3).
5. Fuera de ventana: tarjeta «quedan N días» sin botón (AC3 negativo). En proceso: `ModalVinEnCola` con estado, sin «Renovar» (AC4).
6. 409 de Inicial: con contexto renovable → «Renovar» primaria; sin contexto/ajeno → modal de hoy (AC5).
7. Cambiar de tipo con datos pide confirmación y limpia todo (AC6).
8. RUNT caído en renovación: «Por validar» con pastilla de tipo y «El RUNT no respondió»; reintento sin pedir datos (AC7). Un código no mapeado muestra el genérico, nunca el crudo (AC8). Pastilla en toda fila del canal (AC9).
9. Botón «Enviar solicitud» en la solicitud; «Enviar al gestor (N de M)» sigue igual en la cola. La barra nunca tapa un campo, ni al entrar ni al hacer scroll; móvil con primaria arriba. Specs a actualizar: §3.6.
10. 375 px sin desborde, foco visible, claro y oscuro (AC10). Vacío de la cola con el copy nuevo.

## 12. Decisiones y descartes

- Selector entre «Compañía» y «1 · Vehículo», sin renumerar. Radiogroup y no pestañas.
- «Ya está en FLITO» extiende `TarjetaSoatActivo` y `ModalVinEnCola`; **descartadas** una tarjeta de página nueva y cualquier componente de aviso nuevo. `BandaDesenlace` sin botón.
- Barra de envío: opción A (anclada abajo, ancho completo). **Descartada** la B (pegada arriba).
- «Enviar solicitud» solo en esta pantalla; la cola de Operaciones no cambia.
- Descartado: columna o filtro de tipo, VIN del RUNT en renovación, animaciones entre tipos.

## 13. Brief de mockup (referencia; mockup APROBADO)

Mockup aprobado: https://claude.ai/artifact/45RgBrmbF8r26cyFJjyziD. Si hay que republicar, misma URL, con el Design System FLITO, claro/oscuro, 1366 y 375 px, datos ficticios. Pantallas reales dibujadas como hoy, con el delta señalado:
solicitud sin tipo · renovación (vacío/con factura) · consulta cargando/error · tarjeta `renovar` (12 días, venció, vence hoy, 90 días sin botón) · modal de proceso · modal 409 con «Renovar» · bandas 422/genérico · confirmación de cambio de tipo · **barra de envío anclada (≥ lg y móvil)** · cola real con pastilla «Por validar», pastilla de tipo y vacío del Cliente · `DetalleIncompletaSoat` con placa · `TarjetaSolicitudGuardada`.
No mostrar: pantallas nuevas de «Ya está en FLITO», columna/filtro de tipo, códigos de error, VIN del RUNT en renovación.

## 14. Preguntas: todas cerradas

| # | Decisión |
|---|---|
| P1 | Fuera de ventana (>30 días, sin proceso abierto): aviso «quedan N días» **sin botón**. |
| P2 | «Renovar» desde el 409 de Inicial: el usuario **teclea la placa**. |
| P3 | **Riesgo conocido, no bloquea:** backend (`campoQueNoCuadra`) solo da `'vin'|'placa'`; el frontend mapea por `runt_no_cuadra` y los códigos de `CodigoErrorSolicitudSoat`, y cae al mensaje genérico pulido para cualquier código sin mapear (§3.4). |
| P4 | Sin filtro por tipo en la cola. |
| P5 | Copy de motivos solo para «El RUNT no respondió». |
| P6 | 0 días = «vence hoy». |
| P7 | El documento del bloque 1 prellena **solo el número** en el bloque 3 (editable). |
| P8 | En la variante `renovar` solo fecha y días. |
