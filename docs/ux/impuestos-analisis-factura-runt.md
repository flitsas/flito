# UX slim: validación factura ↔ RUNT y dirección del comprador en Impuestos (HUs #12830 · #12831 · #12832 · #12834)

Épica #12809 · módulo `flito-impuestos` (`/api/flito/impuestos`) · pantalla `apps/web/src/pages/FlitoImpuestos.tsx`
y su modal `components/flito/DetalleImpuesto.tsx`. Público: **operador interno** (gestor del organismo, admin).
Tono de la pantalla: **tú** (lo usa hoy: «Sincroniza desde el Tablero», «Quita el filtro»). Se mantiene.

## Superficie tocada

| Qué | Dónde | HU |
|---|---|---|
| Línea de validación (semáforo o «Analizando») | Celda **Trámite**, en el hueco `accion` de `CeldaTramite`, junto a `AccionCertificacion` | 12830, 12832 |
| Aviso tras envío masivo + preset «Con alertas» | Banda bajo la cabecera · `FiltrosInteligentes` | 12830 |
| Modal comparativo | `FlitModal` nuevo, abierto desde el semáforo, sin salir de la cola | 12831, 12832 |
| Sección «Validación factura ↔ RUNT» + dirección editable | `DetalleImpuesto`, entre el `<dl>` y `HistorialEstados` | 12831, 12832, 12834 |
| Aviso de direcciones sin confirmar en el Excel | Banda de `AvisoExportCola` (ya existe) | 12834 |

**Quien abre esto viene a** mover su cola (enviar, certificar, cargar recibos) y ver **de un vistazo cuáles
no cuadran con el RUNT**. Lo que se ve primero es el mismo estado de siempre más **un icono** por fila. La
tabla comparativa y la dirección quedan a un clic.

**Reparto de archivos (bloqueante para el implementador).** `FlitoImpuestos.tsx` ya ronda el techo de
`max-lines`. Todo lo nuevo va a `components/flito/ValidacionRunt.tsx` (`LineaValidacion`,
`ModalValidacion`, `TablaFacturaRunt`) y a `components/flito/DireccionComprador.tsx`. La página solo
los monta. Antes del PR se corre `npx eslint` sobre los dos archivos que se tocan.

---

## HU #12830: semáforo y estado en la cola

### Delta de claridad
- **No se añade ninguna columna.** A 1366 px la tabla ya lleva 13 columnas y scroll del kit. El semáforo
  va en la celda Trámite, en la misma línea que la certificación: los dos responden a «¿cuadra con el
  RUNT?». La columna Estado (4 chips apilados) no recibe nada.
- Una sola marca de validación por fila, según este orden:

| `analisisEstado` / `semaforo` | Qué se pinta |
|---|---|
| `null` (nunca analizado) | Nada. Sin guion, igual que `AccionCertificacion` |
| `en_curso` | `StatusChip tone="active"` con `icono` = `LoaderCircle` de lucide (`animate-spin motion-reduce:animate-none`), texto **«Analizando»**. Si había un semáforo viejo, no se pinta |
| `completado` + `verde` | Icono `CircleCheck` en `--flit-success` |
| `completado` + `naranja` | Icono `TriangleAlert` en `--flit-warning` |
| `completado` + `rojo` | Icono `CircleX` en `--flit-danger` |
| `error_analisis` | Icono `CircleX` en `--flit-danger`: es el mismo caso para quien opera, porque no está validado |

Cada estado tiene su propia forma (✓ △ ✕), así que no depende solo del color. Los tokens base (no los
`-ink`) tienen par oscuro, y los `-ink` no (`flit-tokens.css` l.108).

### Wireframe (celda Trámite)
```
│ 4471208 · Traspaso                 │   verde + certificado automático
│ (✓) [Certificado ⤓]                │
│ 4471209 · Traspaso                 │   naranja, sin certificar
│ (△) [Certificar]                   │
│ 4471210 · Traspaso                 │   en análisis
│ [◌ Analizando]                     │
```
`flex flex-wrap items-center gap-1.5`: si la columna se estrecha, el chip baja de línea.

### Interacción
- El icono es un `<button type="button">` de 28×28 (`grid place-items-center rounded flit-focus
  transition-colors hover:bg-[var(--flit-bg-hover)]`). Es el mismo patrón que la ✕ de `ToastFlito.tsx`. Abre `ModalValidacion` (#12831).
- `aria-label` y `title` (tooltip nativo, sin componente nuevo) con el mismo texto:
  - verde: «Coincide con el RUNT. Ver comparación»
  - naranja: «Con diferencias frente al RUNT. Ver comparación»
  - rojo `runt_sin_respuesta`: «Sin validar: El RUNT no respondió o no tiene registro del vehículo»
  - rojo `error_lectura_factura`: «Sin validar: No se pudo leer la factura»
  - `error_analisis`: «Sin validar: la validación no terminó. Ver opciones»
- «Analizando» **no** es clicable y no bloquea la fila: casilla, «Ver» y Certificar siguen activos.

### Aviso tras envío masivo (AC3)
Es un estado que sigue siendo cierto mientras se mira la página, así que va como **aviso en página** y no
como toast. Tarjeta `role="status"` bajo la cabecera, del mismo tipo que `AvisoVisible` de `ExportarCola.tsx`, cerrable con ✕ («Cerrar aviso»):
> **8 impuestos enviados al gestor. 8 quedan en análisis contra el RUNT; el semáforo aparece en cada fila al terminar.** [Actualizar la cola]

- «Actualizar la cola» es `flitBtnSecondarySm` y llama a `refrescar()`: es el siguiente paso. No hay
  polling (el AC dice «al refrescar»).
- Con «Gestionar en Operaciones» el copy es el mismo, sin «al gestor»: «8 impuestos enviados a Operaciones. …»
- El conteo sale de la respuesta de `POST /enviar` (o de `ids.length` si el backend no lo devuelve).
  Si es 0, no se pinta aviso.

### Preset «Con alertas»
Se añade a `PRESETS` después de «Sin gestión»: `{ nombre: 'Con alertas', descripcion: 'Semáforo naranja o
rojo: la factura no cuadra con el RUNT o no se pudo validar.' }`. Lo ven Operaciones y el gestor.
**Requerimiento de datos:** filtro de servidor `semaforo=naranja,rojo` en `GET /flito/impuestos` y en el
cuerpo del export. Si no existe en el PR de la 12833, lo pide backend. `hayFiltros` lo incluye.
Vacío con el preset: «Ningún impuesto tiene alertas con estos filtros. Quita el preset para ver toda la cola.»

### Estados
Cargando, error, vacío y lleno de la cola **no cambian**. Los propios del análisis son los de la tabla de arriba.

---

## HU #12831: modal comparativo y sección en el detalle

### Modal (`FlitModal` con `wide`), título «Validación factura ↔ RUNT · {placa}»
```
┌ Validación factura ↔ RUNT · ABC123                               ✕ ┐
│ [△ Con diferencias]  2 datos no coinciden: Color, Cilindraje       │
│ ┌──────────────┬──────────────────┬──────────────────┬─────┐       │
│ │ Dato         │ En factura       │ En RUNT          │     │       │
│ │ VIN          │ 9FB…12           │ 9FB…12           │ (✓) │       │
│ │ Marca        │ RENAULT          │ RENAULT          │ (✓) │       │
│ │ Modelo (línea)│ DUSTER          │ DUSTER           │ (✓) │       │
│ │ Año          │ 2025             │ 2025             │ (✓) │       │
│ │ Color        │ GRIS ESTRELLA    │ GRIS CASSIOPEE   │ (△) │       │
│ │ Cilindraje   │ 1598             │ 1600             │ (△) │       │
│ │ Dirección del│ CL 10 # 4-21,    │ No aplica        │  —  │       │
│ │ comprador    │ Bogotá D.C.      │                  │     │       │
│ └──────────────┴──────────────────┴──────────────────┴─────┘       │
│                                      [Ver detalle]  [Cerrar]       │
└────────────────────────────────────────────────────────────────────┘
```
- Resumen: verde «Los 6 datos coinciden con el RUNT.» · naranja «{n} dato(s) no coinciden: {lista}.»
  (singular «1 dato no coincide: Color.»). La dirección **no cuenta**: no se compara.
- La tabla es `FlitTable`/`FlitTh`/`FlitTr` de `flitPageKit.tsx` (tiene el scroll del kit). La celda de
  resultado lleva el icono y un texto `sr-only`: «Coincide» o «No coincide». La fila de dirección no
  tiene icono: lleva «—» con `aria-label="No se compara"`. «No aplica» va en `--flit-text-secondary`.
- Un dato que falta en un lado se pinta «Sin dato» y no se da como coincidente.
- Si la dirección está `pendienteRevision`, en la misma celda va `StatusChip tone="warning"` «Sin confirmar» (enlaza con #12834).
- El pie **no lleva primaria**: esta visita es de consulta. «Ver detalle» (`flitBtnSecondary`) cierra este
  modal y abre `DetalleImpuesto`. «Cerrar» (`flitBtnSecondary`) también se cierra con Esc y con ✕.

### Rojo y `error_analisis` (AC3): mismo modal, otro cuerpo
```
┌ Validación factura ↔ RUNT · ABC123                               ✕ ┐
│ [✕ Sin validar]                                                    │
│ El RUNT no respondió o no tiene registro del vehículo. Puede ser   │
│ una caída momentánea o un traspaso que aún sincroniza.             │
│                         [Cerrar]  [↻ Reintentar validación] ← 1ª   │
└────────────────────────────────────────────────────────────────────┘
```
| Motivo | Texto (sin error crudo, nunca `e.message`) |
|---|---|
| `runt_sin_respuesta` | «El RUNT no respondió o no tiene registro del vehículo. Puede ser una caída momentánea o un traspaso que aún sincroniza. Reintenta la validación en unos minutos.» |
| `error_lectura_factura` | «No se pudo leer la factura. Revisa que la factura de venta en FLIT sea legible y reintenta la validación.» |
| `error_analisis` | «La validación no terminó por un error técnico. Reintenta en unos minutos.» |

- Si hay comparación parcial en rojo (por ejemplo la factura se leyó y el RUNT no respondió), la tabla se
  muestra bajo el texto con «Sin dato» en la columna RUNT.
- «Reintentar validación» es la **única primaria** del modal y viene de #12832. Sin el permiso no aparece, y
  la última frase se sustituye por «Pide a quien certifica en tu equipo que reintente la validación.».

### Sección en el detalle (AC2)
Va en `DetalleImpuesto`, justo después del `<dl>` y antes de `HistorialEstados`. Encabezado
«Validación factura ↔ RUNT» en el mismo estilo que los rótulos del detalle, con el mismo resumen y
`TablaFacturaRunt` (el mismo componente del modal, **no** una copia). En rojo o error lleva el texto por
motivo y el botón de #12832. Con `null` (nunca analizado): «Este impuesto aún no se ha validado contra el
RUNT. Se valida al enviarlo al gestor.». Con `en_curso`: el chip «Analizando» y «La validación está en
curso. Cierra y actualiza la cola en unos minutos.».

---

## HU #12832: reintentar la validación

### Delta
- **Certificado automático (AC1):** esto ya lo hace `AccionCertificacion` (`CertificacionRunt.tsx`). Si
  `certificacion` no es nula, pinta el chip «Certificado ⤓» que descarga el PDF y no pinta «Certificar».
  Lo que se requiere es que la fila traiga en `certificacion` **también** la automática. El tooltip dice
  «Certificado automáticamente el {fecha}» cuando no hay persona.
- **Reintentar (AC2):** no se añade un botón a la fila. Vive en el modal del semáforo rojo y en la
  sección del detalle, y el semáforo rojo ya es clicable (#12830 AC2). Así la fila se queda en **una**
  acción (Certificar o el chip), ninguna fila compite entre «Certificar» y «Reintentar validación», y
  cabe a 1366. Condición: `!certificacion && (semaforo === 'rojo' || analisisEstado === 'error_analisis')
  && hasFuncion('impuestos.tramite.certificar')`. Estilo: `flitBtnPrimary` en el modal (única acción de esa
  visita) y `flitBtnSecondary` en el detalle (allí las acciones de gestión son secundarias). Lleva el icono
  `RotateCw`, como `ToastFlito`.
- **Pregunta al PO:** si «el botón deshabilitado» del AC3 se refiere a un botón **en la fila**, este
  reparto no lo cumple a la letra. En ese caso, en la fila se pinta «Reintentar validación» en lugar de
  «Certificar» (nunca los dos) y se pierde la certificación manual desde la fila en rojo.

### Estados del reintento (AC3)
| Momento | Modal | Detalle | Fila |
|---|---|---|---|
| Pulsado | Botón deshabilitado con «Reintentando…» y `aria-busy` | ídem | sin cambio |
| 202 `ENCOLADO` | Se cierra el modal | La sección pasa a «Analizando» y el botón se oculta | Se parchea `analisisEstado: 'en_curso'` sin recargar (como `certificar()`): chip «Analizando» |
| Éxito | `toastOk('Validación en cola. El semáforo nuevo aparece al actualizar la cola.')` | ídem | |
| Error | `role="alert"` **dentro** del modal o la sección, el botón se reactiva, **no** toast | ídem | sin cambio |

Copy de los 409 (`ResultadoReanalisis`, se lee `code` del cuerpo, como hace `aResultadoIntento`):
- `ANALISIS_EN_CURSO`: «Esta validación ya está en curso. Actualiza la cola en unos minutos.» (con el mismo parche a «Analizando»)
- `YA_CERTIFICADO`: «Este impuesto ya está certificado; no hace falta validarlo de nuevo.» (y `refrescar()`)
- `NO_SOLICITADO`: «Solo se valida un impuesto enviado al gestor.»
- `SIN_ANALISIS`: «Este impuesto no tiene una validación que reintentar.»
- `NO_ENCONTRADO`: «Este impuesto ya no está en la cola. Actualízala.»
- 403: «No tienes permiso para reintentar la validación.»
- Red, 5xx o sin `code`: «No se pudo reintentar la validación. Inténtalo de nuevo en unos minutos.» (el mismo botón hace de reintento)

---

## HU #12834: dirección del comprador en el detalle

### Wireframe (dentro de la sección de validación, bajo la tabla)
```
┌ Impuesto · ABC123 ─────────────────────────────────────────────── ✕ ┐
│ [Solicitado] [Ambos documentos]                                    │
│ ┌ ⚠ Dirección sin confirmar — revísala y guárdala. [Revisar dirección] ┐ │  aviso role="status"
│ …datos (dl)…                                                       │
│ VALIDACIÓN FACTURA ↔ RUNT   [△ Con diferencias] 2 datos no coinciden│
│ [tabla comparativa]                                                │
│ DIRECCIÓN DEL COMPRADOR · Propuesta leída de la factura            │
│ Dirección [CL 10 # 4-21__________]                                 │
│ Municipio [Bogotá D.C.___]  Departamento [Bogotá D.C.___]          │
│                                         [Guardar dirección] ← 1ª   │
│ Historial…                                                         │
```
- **Aviso (AC1).** Va arriba, bajo los chips, porque es persistente. Es una tarjeta `role="status"` con borde y
  tinta de `StatusChip tone="warning"` (sin `bg-*-50` crudo). «Revisar dirección» es un enlace-botón del
  kit (`underline`, `--flit-blue-text`, `flit-focus`, `hover:bg-[var(--flit-bg-hover)]`) que lleva el foco al campo Dirección.
- **Campos (AC1).** Van con `FlitField` + `flitInp` y `<label>` asociado. Vienen prellenados con `propuesta`.
  Rejilla `grid grid-cols-1 sm:grid-cols-2`, con Dirección a ancho completo. Los tres son obligatorios.
  En línea: «Escribe la dirección.» · «Escribe el municipio.» · «Escribe el departamento.».
- **Origen.** Una línea en `--flit-text-secondary`: `factura` «Propuesta leída de la factura», `flit`
  «Tomada de FLIT», `manual` o confirmada «Confirmada por {confirmadaPor} el {fecha}».
- **Guardar (AC2).** «Guardar dirección» es `flitBtnPrimary` y es la **única** primaria del detalle mientras
  está a la vista. Mientras un `FormMotivo` está abierto (Rechazar, Reversar…), el bloque pasa a solo
  lectura con «Termina o cancela la acción en curso para editar la dirección.». Así no hay dos primarias ni
  dos ediciones a la vez.
  - Guardando: el botón pasa a «Guardando…» deshabilitado.
  - Éxito: `toastOk('Dirección guardada.')`, se quita el aviso, los campos pasan a texto con «Confirmada
    por…», la fila Dirección de la tabla se actualiza y `onTraspaso()` refresca la cola sin cerrar el detalle.
  - Error: `role="alert"` bajo el botón. 400: el error va en el campo. 403: «No tienes permiso para
    corregir la dirección.». Otro: «No se pudo guardar la dirección. Revisa tu conexión e inténtalo de
    nuevo.». El botón sigue activo y es el reintento.
- **Sin el permiso `impuestos.tramite.corregir_direccion` (AC3).** Se ve la dirección como texto y un aviso con
  otro copy: «Dirección sin confirmar. Debe revisarla alguien con permiso para corregir direcciones.».
  Sin campos ni botón.
- **AC5.** Si `analisisEstado` es `null` o `en_curso`, no hay aviso ni chip «Sin confirmar». La dirección
  se muestra como texto si existe y, si no, «Sin dirección registrada».

### Excel ampliado (AC4)
Va en la banda de `AvisoExportCola` (`ExportarCola.tsx`), que ya es el sitio del resultado del export.
Tono advertencia, cerrable, `role="status"`:
> «El archivo incluye {N} impuesto(s) con dirección sin confirmar. Revísalos en su detalle antes de usar el archivo.»
Singular: «1 impuesto con dirección sin confirmar». Con N=0 o sin la cabecera, la banda no cambia.
**Requerimiento para el frontend:** `useExportCola` hoy no lee cabeceras. Hay que leer
`X-Direcciones-Sin-Confirmar` de la respuesta y ampliar `AvisoExport.tono` con `'aviso'`, que es un cambio
de kit compartido con SOAT (hay que revisar su render). Además, CORS/proxy tiene que exponer la cabecera.

---

## Conflictos de jerarquía entre las 4 HUs

1. **Acciones en la fila a 1366 px.** Máximo una marca de validación (icono o «Analizando») y una acción
   de certificación (chip o «Certificar») en la celda Trámite. «Reintentar» no entra en la fila (ver la
   pregunta de #12832). No se añade ninguna columna.
2. **Primaria del detalle.** «Guardar dirección» es la primaria cuando hay dirección pendiente, el
   reintento del detalle es secundario y los `FormMotivo` bloquean la edición de la dirección mientras están abiertos.
3. **Copy frente a shared-types.** `ANALISIS_ESTADO_IMPUESTO_LABEL.en_curso` = «Validando factura» y el AC pide
   «Analizando». `MOTIVO_SEMAFORO_ROJO_LABEL.error_lectura_factura` dice «…de venta» y el AC no. En la
   pantalla manda el AC. **Pregunta al PO:** unificar la constante (cambio en shared-types con grep) o
   dejar la constante para Excel y otras superficies.
4. **Dos avisos arriba.** El del envío masivo y el del export pueden coincidir. Van apilados, cada uno con
   su ✕ y en el orden en que llegaron. No se fusionan.
5. **Datos de la dirección.** El detalle se pinta desde la fila de la cola (`imp`) y no desde un GET
   propio. `direccionComprador` tiene que venir en el item o hace falta `GET /:id`: hay que confirmarlo contra el PR 12833.

## Responsive (<lg)
- La celda Trámite envuelve: el icono y el chip bajan de línea. La tabla usa el scroll horizontal del kit.
- Los modales de `FlitModal` ya ocupan el ancho útil y la tabla comparativa hace scroll dentro. Los
  botones del pie envuelven y la primaria queda al final (`flex flex-wrap justify-end gap-2`).
- La dirección cae a una columna (`grid-cols-1`). Las bandas de aviso envuelven y el botón baja bajo el texto.
- Deuda que no toca este delta: el `<dl>` del detalle es `grid-cols-2` fijo.

## Feedback y tema oscuro
Todos los controles nuevos (icono, enlace «Revisar dirección», «Actualizar la cola», botones) llevan
`flit-focus` y `transition-colors hover:bg-[var(--flit-bg-hover)]`, o el hover propio del botón del kit.
Los colores van con tokens que tienen par oscuro: `--flit-success`, `--flit-warning`, `--flit-danger`,
`--flit-danger-text` para errores y `--flit-text-secondary`. No se usan `-ink` sueltos, `bg-red-50` ni
`text-red-600` en el código nuevo. Se revisa en claro y en oscuro.

## Permisos
Todo sale de slugs existentes: `impuestos.cola.ver` para ver el semáforo, el modal y la sección,
`impuestos.tramite.certificar` para reintentar y `impuestos.tramite.corregir_direccion` para editar la
dirección. No hay página nueva.

## Notas para QA (≤10)
1. Un verde, un naranja, un rojo por cada motivo, un `error_analisis`, un `en_curso` y un `null`: cada uno tiene su forma, su `aria-label` y su tooltip, y el `null` no pinta nada.
2. «Analizando» no bloquea la casilla, «Ver» ni «Certificar» de la fila.
3. Con naranja, el resumen nombra exactamente los campos que difieren y no cuenta la dirección.
4. Con rojo y el permiso, «Reintentar» pasa la fila a «Analizando» sin recargar, cierra el modal y saca un toast cerrable. Sin el permiso no aparece el botón.
5. Con cada 409 de reanálisis se ve el copy de la tabla, nunca `e.message`.
6. Con certificado automático se ve el chip «Certificado» que descarga y no «Certificar».
7. Con dirección pendiente y el permiso: el aviso, los campos prellenados y Guardar, y después desaparecen el aviso y el chip «Sin confirmar» del modal. Sin el permiso: el aviso con otro copy y sin campos.
8. Con `null` o `en_curso` no aparece el aviso de dirección.
9. En el export ampliado: con N>0 aparece la banda con N y la palabra en singular o plural según N; con N=0 no aparece.
10. Todo lo anterior a 390 px y en tema oscuro, más el recorrido con teclado: Tab al icono, Enter abre el modal, Esc lo cierra y el foco vuelve al icono.

```
HANDOFF
  Modo: slim (4 HUs, una pantalla)
  Resultado: OK (con 2 preguntas al PO que no bloquean el diseño por defecto)
  Entrega: /tmp/claude-1000/-home-david-flit-flito/d9dd28fc-5434-4e1e-80df-bcccb56f3cc4/scratchpad/ux-impuestos-analisis-12830-12834.md
  Oficio: primaria única (modal rojo: Reintentar; detalle: Guardar dirección; cola: sin cambio) | jerarquía dicha | vacío con siguiente paso | responsive dicho | feedback dicho | notificación elegida | sin efectos
  Densidad: sin cambio en columnas (+1 icono en la celda Trámite)
  Pantallas: 1 cola + 1 modal nuevo + 1 detalle | Requerimientos nuevos de datos: 3 (filtro `semaforo` en la cola y el export; `direccionComprador` en el item o un GET /:id; lectura de la cabecera en useExportCola + exponerla en CORS)
  Preguntas al PO: (a) ¿«Reintentar validación» también en la fila? (b) ¿unificar el copy de shared-types con el de los AC?
  Siguiente: frontend-agent (confirmar con backend los 3 requerimientos)
```
