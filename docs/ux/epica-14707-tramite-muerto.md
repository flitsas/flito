# UX slim — Trámite anulado, abortado o revocado en FLIT (Épica #14707)

Mockup: `docs/ux/mockups/epica-14707-tramite-muerto.html` (lo genera el hilo con el brief del final; requiere «ok» humano antes de `frontend-agent`).

Regla de la Épica: un trámite FLITO **anulado, abortado o revocado** en FLIT se trata como si **no existiera** para operar. Se sigue viendo (consulta e histórico); no se acciona. Módulos: **FLITO** (`flito-tramites`, `flito-soat`, `flito-impuestos` y finanzas FLITO). No toca los módulos legacy sin prefijo.

Vocabulario visible (dos chips, no tres):

| Estado en FLIT | Chip en FLITO | Tono kit | Ícono |
|---|---|---|---|
| Anulado | **Anulado** | `tono="anulado"` | `/kit/estado-anulado.svg` |
| Abortado | **Anulado** (el estado real de FLIT queda en el historial) | `tono="anulado"` | `/kit/estado-anulado.svg` |
| Revocado (se completó y dejó de valer) | **Revocado** | `tono="revocado"` | `/kit/estado-revocado.svg` |

Ambos tonos e íconos ya existen en `components/flit/kit/tonos.ts` (`ICONO_ESTADO_KIT`). Se pintan con `<StatusChip tono=… icono={<img … className={ETIQUETA_ICONO_CLS} alt="" aria-hidden />}>`. Sin patrón nuevo.

---

## 1. Superficies tocadas

| # | Superficie | Archivo | Público | Tono del copy |
|---|---|---|---|---|
| S1 | Fila de Gestión Trámites | `components/flito/tramites/FilaTramite.tsx` (+ casilla «Seleccionar todos» de `pages/FlitoTramites.tsx`) | Operador | Tú (calca la pantalla) |
| S2 | Detalle del trámite (modal) | `components/flito/tramites/detalle/ModalDetalleTramite.tsx` | Operador | Tú / impersonal |
| S3 | Aviso «retiros» en cola SOAT | `pages/FlitoSoat.tsx` | Operador **y** Cliente | Tú (operador) · usted (Cliente) |
| S4 | Aviso «retiros» en cola Impuestos | `pages/FlitoImpuestos.tsx` | Operador | Tú |
| S5 | Rechazo 409 `TRAMITE_NO_VIGENTE` | Trámites, modal, colas SOAT/Impuestos | Todos | Impersonal |
| S6 | Finanzas: reporte de costos, liquidación, facturación | páginas FLITO de finanzas (rutas a confirmar por `frontend-agent`) | `financiera`, `admin` | Calca la pantalla |

---

## 2. Delta de claridad (qué se ve / qué se calla)

**Qué vino a hacer quien abre cada superficie y qué cambia:**

- **Gestión Trámites:** el operador barre la bandeja para decidir qué fila trabaja. Un trámite muerto **no es trabajo**: lo dice el chip en la columna Trámite, que es lo primero que ya se lee. Se calla todo lo que invita a operarlo (casilla accionable, Solicitar, Desbloquear, Crear empresa, «Listo para entregar»). Se conserva lo que es **consulta**: Ver, historial (clic en el chip), factura de venta, Ver soportes.
- **Detalle:** quien abre un trámite muerto quiere saber **por qué no puede hacer nada**. Primero se ve el aviso (arriba del Resumen); el pie de acciones desaparece.
- **Colas SOAT / Impuestos:** el usuario viene a trabajar su cola. Lo nuevo solo aparece si **a él** le retiraron algo que había solicitado; se lee, se pulsa «Entendido» y desaparece. En el estado normal la pantalla no cambia.
- **Finanzas:** el revocado sigue en el reporte como histórico, con chip «Revocado»; no ofrece acciones nuevas.

**Densidad:** sin cambio en el estado normal. En Trámites se **alivia** (las filas muertas pierden botones). En las colas, el aviso es transitorio y se va con «Entendido».

**No se atenúa la fila muerta** (opacidad, gris): bajaría el contraste por debajo de 4.5:1 y es adorno. El chip lleva el estado; basta.

**Primaria:** no cambia en ninguna superficie. En las colas, la primaria del encabezado (`primariaCabecera`) sigue siendo la única; «Entendido» es **secundaria**. En el detalle de un trámite muerto **no hay primaria** (no hay acción que hacer; es correcto, y lo explica el aviso).

---

## 3. S1 — Fila de Gestión Trámites

### Wireframe (escritorio, columnas relevantes; las demás no cambian)

```
┌───┬──────┬──────────────────────────┬─────────┬──────────────────────┬───────────────┬──────────────────┬──────────────┐
│ ☐ │ Ver  │ Trámite                  │ Creado  │ Vehículo             │ SOAT          │ Impuestos        │ Soportes     │
├───┼──────┼──────────────────────────┼─────────┼──────────────────────┼───────────────┼──────────────────┼──────────────┤
│ ☐ │[Ver] │ 2026-000812              │ 12 nov  │ [KLM 482]            │ [Solicitar]   │ [Solicitar]      │ Ver soportes │  ← vigente (sin cambio)
│   │      │ Traspaso                 │         │ Mazda 3 · Automóvil  │               │                  │              │
│   │      │ (● Asignado)             │         │                      │               │                  │              │
├───┼──────┼──────────────────────────┼─────────┼──────────────────────┼───────────────┼──────────────────┼──────────────┤
│ ▫ │[Ver] │ 2026-000815              │ 13 nov  │ [RTX 019]            │ Descartado    │ Descartado       │ Ver soportes │  ← anulado / abortado
│   │      │ Traspaso                 │         │ Renault Logan        │ (texto tenue) │ (texto tenue)    │              │
│   │      │ (⊘ Anulado)              │         │                      │               │                  │              │
├───┼──────┼──────────────────────────┼─────────┼──────────────────────┼───────────────┼──────────────────┼──────────────┤
│ ▫ │[Ver] │ 2026-000790              │ 02 nov  │ [JHU 773]            │ (● Pagado)    │ (● Pagado)       │ Ver soportes │  ← revocado
│   │      │ Matrícula inicial        │         │ Kia Picanto          │ solo lectura  │ solo lectura     │              │
│   │      │ (⊘ Revocado)             │         │                      │               │                  │              │
└───┴──────┴──────────────────────────┴─────────┴──────────────────────┴───────────────┴──────────────────┴──────────────┘
 ▫ = casilla deshabilitada
```

### Reglas de la fila muerta

| Elemento | Vigente | Muerta (Anulado / Revocado) |
|---|---|---|
| Chip de estado (columna Trámite) | `StatusChip tone=active|neutral` con `f.estado` | `StatusChip tono="anulado"|"revocado"` + ícono del kit, texto **«Anulado»** / **«Revocado»** |
| Clic en el chip → historial | Sí | **Sí** (consulta; el historial muestra el estado literal de FLIT, p. ej. «Abortado») |
| «Listo para entregar» | Si aplica | **Nunca** |
| Casilla de selección | Activa | `disabled`, `aria-label="No se puede seleccionar {placa}: el trámite está anulado en FLIT"` (o «revocado»), mismo texto en `title` |
| «Seleccionar todos» (cabecera) | Marca todas | **Salta** las muertas; su conteo no las incluye |
| SOAT / Impuestos | Botón «Solicitar» o estado | **Sin botón.** Anulado: texto tenue «Descartado». Revocado: el último estado como chip de solo lectura si llegó a Pagado (histórico); si no, «Descartado» |
| Desbloquear / Crear empresa | Si aplica | **Ocultos** |
| Ver, factura de venta, Ver soportes | Sí | **Sí** (consulta) |
| Opacidad / color de la fila | — | **Sin cambio** |

«Descartado» usa la misma clase tenue que «Sin aprobar» / «Sin recibo» (`text-xs italic` + `--color-text-tertiary`); verificar ≥ 4.5:1 en claro y oscuro (es texto de 12 px).

### Estados (4)

No hay petición nueva: la vigencia viaja en la fila. Cargando, error, vacío y lleno de la bandeja **no cambian**. Ningún filtro nuevo (no se pidió; no se apila densidad).

---

## 4. S2 — Detalle del trámite (modal)

### Wireframe (escritorio)

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Gestión Trámites · 4 de 128                                                                  │
│ 2026-000815  [Fuente FLIT]  (⊘ Anulado)              [‹ Anterior] [Siguiente ›] [Cerrar]     │
├────────────────┬─────────────────────────────────────────────────────────────────────────────┤
│ Resumen        │ ┌─ ⚠ Trámite anulado en FLIT ─────────────────────────────────────────────┐ │
│ Vehículo       │ │ Este trámite se anuló en FLIT, por eso en FLITO ya no tiene acciones:   │ │
│ Propietario…   │ │ no se puede solicitar SOAT ni impuestos, ni entregar. Si tenía un SOAT  │ │
│ Soportes (3)   │ │ o un impuesto en curso, se descartó y salió de su cola.                 │ │
│ Costos y fact. │ └─────────────────────────────────────────────────────────────────────────┘ │
│ Historial      │ Resumen                                                                     │
│                │ …(secciones sin cambio)…                                                    │
├────────────────┴─────────────────────────────────────────────────────────────────────────────┤
│ (sin pie: no hay botones de acción)                                                          │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Aviso: `InlineAlert tono="warn"` (decisión)

`warn`, no `danger`: el trámite muerto es un estado terminal legítimo, no un fallo del sistema ni del usuario; `danger` se reserva para errores de carga y competiría con ellos. Va **primero dentro del cuerpo**, antes de la sección Resumen, y se pinta a partir de la **fila** (no espera al detalle): aparece en el mismo render que la cabecera, sin parpadeo, y sigue ahí aunque el detalle falle.

| | Título | Texto |
|---|---|---|
| **Anulado** (y Abortado) | Trámite anulado en FLIT | Este trámite se anuló en FLIT, por eso en FLITO ya no tiene acciones: no se puede solicitar SOAT ni impuestos, ni entregar. Si tenía un SOAT o un impuesto en curso, se descartó y salió de su cola. |
| **Revocado** | Trámite revocado en FLIT | Este trámite se completó, pero FLIT lo revocó y dejó de valer. En FLITO ya no tiene acciones. Su cobro y su liquidación se conservan como histórico: puedes consultarlos en Costos y facturación, pero no generan cobros nuevos. |

- Cabecera: el chip de estado pasa al de la tabla (mismo tono, ícono y texto).
- Pie: **no se pinta** (como hoy cuando `botonesPie` queda vacío). No se muestran botones deshabilitados: el aviso ya explica por qué no los hay y cuatro botones grises son ruido.
- ‹ Anterior / Siguiente › / Cerrar: sin cambio. Al navegar a otro trámite, el aviso aparece o desaparece según la fila.

### Estados (4)

Cada sección conserva sus 4 estados. El aviso no tiene estados propios: depende de la fila, que ya está en memoria.

---

## 5. S3 / S4 — Aviso de retiros en las colas SOAT e Impuestos

Quien **solicitó** un SOAT o un impuesto que ya estaba **enviado al gestor** se entera de que se retiró. Lo pendiente que nunca salió no genera aviso: se descarta y desaparece en silencio (nadie esperaba nada). El gestor, por su parte, ve la fila salir de su cola sin aviso (ver «Preguntas abiertas»).

Cada cola muestra **solo los retiros de su concepto**: en SOAT, los SOAT; en Impuestos, los impuestos. El concepto va en el título y no repite columna. Un «Solicitar ambos» retirado deja un aviso en cada cola, y cada «Entendido» marca solo el de su cola.

### Ubicación

Justo debajo de `PageHeaderCard` y antes de `AvisoExportCola`, la barra de filtros y la tabla. Es lo nuevo que el usuario no sabe. No va en toast (es un estado que sigue siendo cierto hasta que lo marca visto) ni en una campana o un badge del menú (patrón nuevo; no se pidió).

### Wireframe — lleno (escritorio, Operaciones, cola SOAT)

```
┌─ SOAT ───────────────────────────────────────────────────────────────── [primaria existente] ┐
│ Cola de adquisición del SOAT: de Pendiente a Pagado.                                         │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
┌─ ⚠ Se retiraron 3 SOAT que solicitaste ──────────────────────────────────────────────────────┐
│ Sus trámites se anularon o se revocaron en FLIT: ya no se tramitan y salieron de la cola.     │
│ No tienes que hacer nada más.                                                                 │
│                                                                                               │
│   [RTX 019]   2026-000815   Trámite anulado en FLIT    24 nov 2026                            │
│   [JHU 773]   2026-000790   Trámite revocado en FLIT   24 nov 2026                            │
│   [PQA 310]   2026-000801   Trámite anulado en FLIT    23 nov 2026                            │
│                                                                                               │
│                                                                              [ Entendido ]    │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
[Filtros…]
[Tabla de la cola…]
```

Con más de 5 retiros se ven los 5 más recientes y, a la izquierda de «Entendido», un botón `ghost` «Ver los 12» / «Ver menos» (`aria-expanded`, `aria-controls` a la lista). «Entendido» marca vistos **todos** los del aviso, también los plegados.

### Componentes y piezas

- Contenedor: `InlineAlert tono="warn"` con `titulo` y `accion` (el bloque de botones).
- Lista: `<ul>` sin viñetas; cada `<li>` en rejilla `grid grid-cols-1 sm:grid-cols-[auto_auto_1fr_auto] gap-x-4`. Placa con `<Placa>` del kit; ID FLIT con `tabular-nums`; motivo en texto (no chip: cinco chips en un aviso hacen ruido); fecha con el helper `fecha()` existente.
- «Entendido»: `claseBoton('secondary','sm')`. «Ver los N»: `claseBoton('ghost','sm')`. Ninguno es primaria.

### Copy exacto

| Pieza | Operaciones (tú) — SOAT | Operaciones (tú) — Impuestos | Cliente (usted) — SOAT |
|---|---|---|---|
| Título (1) | Se retiró 1 SOAT que solicitaste | Se retiró 1 impuesto que solicitaste | Se retiró 1 SOAT que usted solicitó |
| Título (n) | Se retiraron {n} SOAT que solicitaste | Se retiraron {n} impuestos que solicitaste | Se retiraron {n} SOAT que usted solicitó |
| Texto | Sus trámites se anularon o se revocaron en FLIT: ya no se tramitan y salieron de la cola. No tienes que hacer nada más. | (igual) | Sus trámites se anularon o se revocaron en FLIT: ya no se tramitan y salieron de esta lista. No tiene que hacer nada más. |
| Motivo por fila | Trámite anulado en FLIT · Trámite revocado en FLIT | (igual) | (igual) |
| Botón | Entendido (`aria-label="Entendido, ocultar el aviso de SOAT retirados"`; en Impuestos «…de impuestos retirados») | | Entendido |
| Plegar | Ver los {n} · Ver menos | | Ver los {n} · Ver menos |

Con un solo retiro: «Su trámite se anuló…» / «se revocó…» según el motivo («Sus trámites…» solo en plural).

### Estados (4)

| Estado | Qué se ve | Copy |
|---|---|---|
| **Cargando** | **Nada.** Sin esqueleto ni espinner. La petición sale en paralelo con la de la cola; si ya resolvió cuando la cola se pinta, el aviso entra en ese mismo render; si resuelve después, entra una sola vez. Al `refrescar` la cola se conserva el aviso ya pintado mientras se vuelve a pedir (no se oculta y reaparece). | — |
| **Error** | Una línea discreta en el mismo lugar, texto `--color-text-secondary` 14 px, con un enlace-botón «Reintentar» (clase `enlace` del kit: subrayado, hover de tono, `flit-focus`). `role="status"`. **No** es `InlineAlert danger` ni bloquea la cola, que funciona igual debajo. | Operaciones: «No pudimos revisar si se retiró algún SOAT que solicitaste. [Reintentar]» · Impuestos: «…algún impuesto que solicitaste.» · Cliente: «No pudimos revisar si se retiró algún SOAT que usted solicitó. [Reintentar]» |
| **Vacío** | **Nada** (sin retiros sin ver = pantalla idéntica a hoy). | — |
| **Lleno** | El aviso del wireframe. | Ver tabla de copy |

### Acción «Entendido»

| Resultado | Qué pasa | Notificación |
|---|---|---|
| Éxito | El aviso desaparece. El foco pasa al título de la página (`h1` de `PageHeaderCard` con `tabIndex={-1}`) para no perderse en el vacío. | **Ninguna**: la desaparición del aviso es el resultado. Un toast «listo» sería duplicar. |
| Error | El aviso **se queda** tal cual; el botón vuelve a estar disponible. | `toastError` con reintento. Operaciones: «No se pudo ocultar el aviso. Intenta de nuevo.» · Cliente: «No pudimos ocultar el aviso. Intente de nuevo.» |
| En curso | «Entendido» `disabled` + `aria-busy`, sin espinner. | — |

Un retiro que llega con el usuario ya dentro de la página aparece en el siguiente `refrescar` de la cola. Sin sondeo (*polling*) propio.

---

## 6. S5 — Rechazo 409 `TRAMITE_NO_VIGENTE`

Ocurre cuando la pantalla aún mostraba el trámite como vigente y FLIT lo anuló o revocó entre la carga y el clic. Nunca se muestra el mensaje ni el código del API. Sin botón de reintento (reintentar volvería a fallar). Después de cualquier 409 se **refresca** la vista para que el estado real aparezca solo.

| Dónde | Patrón | Copy exacto |
|---|---|---|
| Fila de Trámites: Solicitar SOAT | `toastError` (sin reintento) + refrescar la bandeja | No se pudo solicitar el SOAT: el trámite {idFlit} se anuló o se revocó en FLIT. La tabla ya se actualizó. |
| Fila de Trámites: Solicitar impuesto | ídem | No se pudo solicitar el impuesto: el trámite {idFlit} se anuló o se revocó en FLIT. La tabla ya se actualizó. |
| Barra de selección (lote), rechazo total | ídem | No se envió nada: los trámites seleccionados se anularon o se revocaron en FLIT. La tabla ya se actualizó. |
| Barra de selección (lote), parcial | `toastOk` con el resumen de siempre + una frase | {n} SOAT enviados al gestor. {m} no se enviaron porque su trámite se anuló o se revocó en FLIT. (Impuestos y Entregar: misma segunda frase.) |
| **Modal de detalle** (Solicitar SOAT/Impuestos/ambos/Entregar) | **Sin toast** (regla: error de un modal va en el modal). Se refrescan fila y detalle: el pie desaparece y aparece el aviso `warn` de S2, que ya es `role="alert"` y lo anuncia. El foco pasa al aviso (`tabIndex={-1}`) porque el botón pulsado deja de existir. | El del aviso de S2 |
| Colas SOAT / Impuestos (enviar, certificar, pagar una fila retirada) | `toastError` (sin reintento) + refrescar la cola | Este SOAT ya no está en la cola: su trámite se anuló o se revocó en FLIT. La lista ya se actualizó. · Impuestos: «Este impuesto ya no está en la cola: …». Lote: «{m} de los seleccionados ya no están en la cola: su trámite se anuló o se revocó en FLIT. La lista ya se actualizó.» |

El copy es impersonal, así que vale para pantallas que tutean y para el Cliente. `toastError` es cerrable y dura 10 s (`ToastFlito.tsx`).

---

## 7. S6 — Finanzas (reporte de costos, liquidación, facturación)

- En la celda donde cada pantalla ya muestra el estado o el identificador del trámite: `StatusChip tono="revocado"` + ícono, texto **«Revocado»**. Si llegara un anulado con cobro, el mismo tratamiento con «Anulado».
- Los valores (cobro, liquidación, factura) **se siguen viendo** como histórico, con su formato de siempre. Sin tachado ni atenuado.
- **Sin acciones nuevas** en esa fila: no entra en selecciones de lote (casilla `disabled` con `aria-label="No se puede seleccionar {idFlit}: el trámite está revocado en FLIT"`), y no ofrece Liquidar, Facturar, Incluir ni equivalente. Lo que ya se hizo (factura emitida, liquidación cerrada) se consulta igual que hoy.
- Sin filtro ni columna nueva. Los 4 estados de cada pantalla no cambian.
- Si el revocado suma o no en los totales del reporte es una decisión de negocio que esta spec no toma (ver «Preguntas abiertas»).

---

## 8. Responsive (< `lg`)

- **Trámites (S1):** la tabla sigue con el scroll horizontal de `FlitTable`; el chip «Anulado»/«Revocado» cabe en la columna Trámite sin cambiar su ancho.
- **Detalle (S2):** el índice pasa a tira superior (como hoy) y el aviso va a ancho completo, primero en el cuerpo. Sin pie.
- **Aviso de retiros (S3/S4):** cada `<li>` se apila (línea 1: placa + ID FLIT; línea 2: motivo · fecha). Los botones envuelven bajo la lista (`flex flex-wrap justify-end gap-2`); bajo `sm`, «Entendido» a ancho completo. El estado de error es una línea que envuelve.
- **Toasts (S5):** los del kit, sin cambio.
- **Finanzas (S6):** la tabla de cada pantalla conserva su scroll; el chip no ensancha la columna.

## 9. Feedback de controles (hover / foco)

- Chip-botón del historial: conserva su `hover:opacity-80` + `flit-focus`.
- Casilla deshabilitada: `cursor-not-allowed`, sin hover; el motivo en `title` y `aria-label`.
- «Entendido» y «Ver los N»: `claseBoton` del kit (hover de tono + `flit-focus`); `disabled` distinguible mientras se guarda.
- «Reintentar» del error discreto: clase `enlace` (subrayado, hover de tono, `flit-focus`).
- Ningún control nuevo se queda plano; ninguna animación nueva.

## 10. Permiso / slug

Sin `PageSlug` ni función nueva. Las páginas y funciones son las de hoy (Gestión Trámites, SOAT, Impuestos, finanzas). El aviso de retiros solo lo ve **quien solicitó** el ítem retirado: lo filtra el backend por el usuario del token; el SPA no manda identificadores ni filtros. Roles: los que ya tienen cada página (`USER_ROLES`; nada de `operaciones`, fusionado en `admin`).

## 11. Datos — requerimientos para architecture/backend (no inventados aquí; nombres finales los fija `architecture-agent`)

1. **Vigencia normalizada** en la fila del listado de trámites, en el detalle y en las filas de finanzas: un campo con `vigente | anulado | revocado` (Abortado → `anulado`, mapeado en el backend). La UI no debe deducirlo parseando el texto libre de `estado`.
2. **Estado de solo lectura de SOAT/impuesto de un muerto:** que la fila diga si quedó `descartado` o conserva un estado histórico (p. ej. Pagado en un revocado).
3. **Retiros sin ver por concepto** (SOAT, impuesto) para el usuario autenticado: por ítem, id opaco, placa, ID FLIT, motivo (`anulado | revocado`) y fecha del retiro. Lectura **sin query string** (usuario del token). Placa en el **body** de la respuesta, nunca en la URL (`AGENTS.md` §14); si proyecta datos del titular, `logPiiAccess` lo decide `security-agent`.
4. **Marcar vistos:** escritura con la **lista de ids mostrados** (no «todos»), para no ocultar un retiro que llegó después de pintar el aviso.
5. **409 `TRAMITE_NO_VIGENTE`** con código estable en el cuerpo y el `idFlit` cuando es una sola fila. En lotes, el resultado trae el conteo de no vigentes (para la frase parcial de S5).

## 12. Accesibilidad

- Chip: el texto «Anulado»/«Revocado» lleva el significado; el ícono va `alt=""` `aria-hidden`. El color no es la única señal.
- Casilla deshabilitada con `aria-label` y `title` que dicen el motivo. Como `disabled` no recibe foco, el chip de la misma fila es la señal para el teclado.
- `InlineAlert warn` → `role="alert"`: en el modal se anuncia al abrir o al navegar a un trámite muerto (es información nueva). En la cola se anuncia al aparecer; la lista plegada a 5 acota lo que se lee.
- Error discreto del aviso: `role="status"` (cortés), no `alert`.
- «Ver los N» con `aria-expanded` + `aria-controls`. «Entendido» con `aria-label` que dice qué oculta.
- Foco tras «Entendido» → `h1` de la página; tras 409 en el modal → el aviso.
- Contraste ≥ 4.5:1 en claro y oscuro para «Descartado» (12 px, tenue), el texto del aviso y los chips `anulado`/`revocado` (verificar con `check:contraste`).

## 13. Notas para QA (≤ 10)

1. Fila anulada, abortada y revocada: chip correcto (Abortado → «Anulado»), sin Solicitar/Desbloquear/Crear empresa/«Listo para entregar», casilla deshabilitada con `aria-label`; Ver, historial y soportes funcionan.
2. «Seleccionar todos» no marca filas muertas y el conteo no las incluye.
3. Detalle de un muerto: aviso `warn` arriba del Resumen con el copy de su caso, sin pie; aparece aunque el detalle falle o tarde.
4. 409 desde la fila → toast sin el error crudo y la tabla refrescada; desde el modal → sin toast, aparece el aviso y el foco va a él.
5. Lote con mezcla vigente/muerto → toast parcial con las dos frases.
6. Cola SOAT con retiros del usuario → aviso con placa, ID FLIT, motivo y fecha; otro usuario que no los solicitó **no** lo ve.
7. «Entendido» oculta el aviso y no vuelve tras recargar; con fallo, toast de error y el aviso se queda.
8. Aviso: sin parpadeo al cargar ni al refrescar; con error, una línea con Reintentar y la cola usable.
9. Más de 5 retiros: plegado, «Ver los N», y «Entendido» marca todos.
10. Cliente en SOAT: copy en usted; Operaciones e Impuestos en tú. Revisar los dos temas y 375 px.

## 14. Decisiones y descartes

- **`warn` y no `danger` en el detalle:** estado terminal, no fallo. `danger` queda para errores de carga.
- **Sin botones deshabilitados en el pie del detalle:** el aviso explica; cuatro botones grises son ruido.
- **Casilla deshabilitada en vez de celda vacía:** conserva la alineación de la columna y lleva el motivo accesible.
- **Sin atenuar la fila:** bajaría el contraste y es adorno; el chip basta.
- **Motivo en texto, no en chip, dentro del aviso:** varios chips en un aviso compiten con el título.
- **Un aviso por cola y por concepto**, sin campana ni badge global: no se pidió y sería un patrón nuevo.
- **Sin toast al acertar «Entendido»:** la desaparición es el resultado.
- **Error del aviso discreto:** no tumba ni tapa la cola, que es lo que se vino a hacer.
- **Sin filtro «Anulados/Revocados»** en la bandeja: no se pidió; sumaría densidad.

### Preguntas abiertas al PO (no bloquean esta spec)

1. ¿El **gestor** (proveedor) que tenía el SOAT/impuesto en su cola debe recibir también un aviso, o le basta con que la fila desaparezca? Hoy la spec solo avisa a quien solicitó.
2. Finanzas: ¿el revocado **suma** en los totales del reporte de costos/liquidación, o se excluye y solo se lista? Cambia cifras, no la UI del chip.

---

## Brief de mockup

Archivo: `docs/ux/mockups/epica-14707-tramite-muerto.html`, autocontenido, con clases Tailwind y del kit (`kit-etiqueta` + `data-tono="anulado"|"revocado"`, `kit-alerta` + `data-tono="warn"`, `kit-modal`, tokens `--flit-*` / `--color-*`; sin HEX sueltos). Sin JS de negocio ni red; un conmutador de tema claro/oscuro es opcional pero recomendado. Capturas a 1366×768 y 375×812.

**Vistas (una sección cada una):**

1. **Gestión Trámites: bandeja**, tres filas (vigente, anulado, revocado) como en el wireframe de S1. Casilla de cabecera visible.
2. **Detalle, anulado:** modal con el aviso `warn` de S2 (copy de Anulado), sin pie.
3. **Detalle, revocado:** el mismo modal con el copy de Revocado.
4. **Cola SOAT, Operaciones, lleno:** cabecera con su primaria + aviso con 3 retiros + filtros y 3 filas de cola de ejemplo.
5. **Cola SOAT, lleno con más de 5:** 5 visibles + «Ver los 8» + «Entendido».
6. **Cola SOAT, error del aviso:** la línea discreta con «Reintentar» sobre la cola normal.
7. **Cola SOAT, cargando y vacío:** la cola con `PageContentSkeleton` y **sin** aviso; y la cola normal sin aviso (idénticas a hoy: rotular la sección «el aviso no se pinta»).
8. **Cola SOAT, Cliente:** el aviso con copy en usted.
9. **Toast 409** (`ToastFlito` de error) con «No se pudo solicitar el SOAT: el trámite 2026-000815 se anuló o se revocó en FLIT. La tabla ya se actualizó.»
10. **Móvil (375 px):** vistas 1, 2 y 4.

Impuestos no necesita vista propia: es el mismo aviso con «impuestos» en el título.

**Datos ficticios** (inventados; nada real): placas `RTX 019`, `JHU 773`, `PQA 310`, `KLM 482`, `ZZB 105`, `MNO 640`, `WQE 221`, `HFD 908`; IDs FLIT `2026-000815`, `2026-000790`, `2026-000801`, `2026-000812`…; vehículos genéricos (Mazda 3, Renault Logan, Kia Picanto); fechas del 20 al 24 nov 2026. **Sin** nombres de compradores, cédulas, correos ni teléfonos: en la bandeja, las columnas Comprador y Correo con «Comprador de ejemplo» o se omiten.

**No mostrar:** botones Solicitar/Desbloquear/Crear empresa/Entregar en filas muertas; pie de acciones en el detalle de un muerto; filas atenuadas; badges o campanas de notificación; espinner del aviso; el texto crudo del 409 ni su código.
