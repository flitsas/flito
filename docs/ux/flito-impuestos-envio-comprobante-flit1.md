# UX slim — Envío del comprobante a FLIT 1 en el detalle del impuesto (HU #13312)

Feature #13309 · Épica #12741 · módulo **`flito-impuestos`** (no el legacy `impuestos`).
Delta sobre `docs/ux/flito-impuestos-envio-flit2-y-reemplazo.md` (HU #13270): lo que no se nombra
aquí **no cambia** (posición de la celda, diálogo de reemplazo, rechazos 200, errores, foco,
permisos).

Contrato ya implementado, sin endpoint ni dato nuevo:

- `GET /api/flito/impuestos/:id` → `envioComprobante: EnvioComprobante | null` (HU #13310;
  `{ destino: 'flit1'|'flit2', estado, intentos, ultimoIntentoEn }`).
- `POST /api/flito/impuestos/:id/recibos/reemplazar-pago` → `envio: ReprogramacionEnvioComprobante`
  (HU #13311). Tipos en `packages/shared-types/src/flito-envio-comprobante.ts`.
- `envioFlit2` (detalle) y `envioFlit2` (reemplazo) siguen en el contrato, pero **la UI deja de
  leerlos**: todo sale de `envioComprobante` / `envio`.

Público: operador interno (Operaciones, Financiera, Auditoría en solo lectura). Tono **tú**, calcado
del detalle y de la HU #13270.

## Superficie tocada

- `components/flito/EnvioFlit2.tsx` → se **generaliza** a `components/flito/EnvioComprobante.tsx`:
  `CeldaEnvioComprobante` + `textoToastReemplazo`. Misma estructura y mismo JSX; solo cambia de dónde
  salen el rótulo, los chips y el copy: un mapa **por destino**. El archivo `EnvioFlit2.tsx` se
  elimina (no quedan dos componentes ni dos versiones visuales).
- `components/flito/DetalleImpuesto.tsx`: monta `CeldaEnvioComprobante` en el mismo sitio (después de
  **Soporte**) y pasa `envio` (no `envioFlit2`) a `textoToastReemplazo`.
- `components/flito/ModalReemplazoComprobante.tsx`: `onReemplazado(r.envio)`; la prop `envioActual`
  pasa a ser `envioComprobante`. La línea condicional del aviso («El gestor ya cargó su comprobante
  en FLIT 2: el nuevo queda solo en FLITO.») sale **solo** con `destino === 'flit2'` y
  `estado === 'ya_cargado_gestor'` — copy sin cambio. Con FLIT 1 nunca sale (ese estado no existe).

**Qué vino a hacer quien abre esto:** igual que en #13270 — saber si el comprobante de pago ya llegó
al sistema del que vino el trámite, ahora también cuando ese sistema es **FLIT 1**. Lo primero que se
ve en la celda sigue siendo el **chip de estado**; el rótulo dice a qué sistema.

## Delta de claridad (qué se ve / qué se calla)

```
SOPORTE                  COMPROBANTE EN FLIT 1
Ver soporte              [Enviado a FLIT 1]
[Reemplazar comprobante] Enviado el 05/10/2026 10:32
```

- **Qué cambia a la vista:** el rótulo y los textos nombran el destino real (`FLIT 1` o `FLIT 2`).
  Hoy un trámite FLIT 1 no tiene celda o, al reemplazar, oye «Este trámite no es de FLIT 2» — eso
  desaparece.
- **Densidad:** sin cambio. Una sola celda como hoy; nunca dos (un impuesto tiene un solo destino).
  Sin columnas, chips de cabecera ni botones nuevos.
- **FLIT 2 (AC4):** rótulo, chips, fechas, ayudas, error de consulta y toasts **idénticos carácter por
  carácter** a la tabla de #13270. El mapa por destino se escribe con los textos completos de cada
  uno, **no** interpolando `{destino}` en una plantilla común (eso cambiaría frases de FLIT 2).
- **Se calla** (igual que en FLIT 2): número de intentos fuera de `error`, motivo técnico del error,
  ids externos. Sigue siendo **solo lectura**: sin reintentar envío, sin enlace, sin hover en el chip.
- **Sin envío (AC5):** `envioComprobante === null` → la celda **no existe**. Sin «No aplica».

### Tabla FLIT 1 (`destino === 'flit1'`)

Rótulo (`<dt>`): **«Comprobante en FLIT 1»**.

| `estado` | Chip (tono) | Línea de fecha | Ayuda (una línea, `text-xs`, `--flit-text-secondary`) |
|---|---|---|---|
| `pendiente` | «Pendiente» (`active`) | «Último intento: {fecha}» si hay | «FLITO lo enviará solo a FLIT 1; no tienes que hacer nada.» |
| `enviado` | «Enviado a FLIT 1» (`success`) | «Enviado el {fecha}» | — |
| `error` | «Error de envío» (`danger`) | «Último intento: {fecha}» | «FLITO no pudo enviarlo a FLIT 1 tras {intentos} intentos. El motivo quedó registrado; si el archivo estaba mal, reemplázalo.» · con `intentos` 0/ausente: «FLITO no pudo enviarlo a FLIT 1. El motivo quedó registrado; si el archivo estaba mal, reemplázalo.» |
| `sin_comprobante` | «Sin comprobante» (`warning`) | — | Con «Cargar comprobante» a la vista: «Se enviará a FLIT 1 cuando cargues el comprobante de pago con «Cargar comprobante».» · Sin él: «Se enviará a FLIT 1 cuando se cargue el comprobante de pago.» |
| `en_espera`, `ya_cargado_gestor` u otro | «Estado desconocido» (`neutral`) | — | — |

- `en_espera` y `ya_cargado_gestor` **no existen** en FLIT 1 (CHECK de la base). Si llegaran, caen al
  chip neutro: nunca se pinta «En espera de FLIT 2» ni «Ya lo cargó el gestor» bajo un rótulo FLIT 1.
- `pendiente` lleva ayuda en FLIT 1 (AC3) y **no** en FLIT 2 (AC4: se queda como está). Asimetría
  aceptada a propósito: el operador conoce el flujo FLIT 2 desde #13270; el de FLIT 1 es nuevo.
- Fecha con el mismo `fecha()` del detalle. `{intentos}` en número (tope 3, `MAX_INTENTOS_ENVIO_FLIT1`).

### Tabla FLIT 2 (`destino === 'flit2'`) — sin cambio

Exactamente la de `flito-impuestos-envio-flit2-y-reemplazo.md` §Estados (rótulo «Comprobante en
FLIT 2», seis estados, mismas ayudas).

## Estados (4) + copy

| Estado | Qué se ve | Salida |
|---|---|---|
| **Cargando** | Rótulo + barra esqueleto del alto del chip, `aria-busy="true"` en el `<dd>`. Rótulo: el del **último destino conocido** de este impuesto (ver abajo); si aún no se conoce, **«Envío del comprobante»**. Si al llegar `envioComprobante` es `null`, la celda desaparece. | — |
| **Error de consulta** | «No se pudo consultar el envío a FLIT 1.» (o «… a FLIT 2.», igual que hoy) + botón-enlace **`Reintentar`** → mismo `recargar`. Si el destino aún no se conoce: rótulo «Envío del comprobante» y «No se pudo consultar el envío del comprobante.» + `Reintentar`. | Reintentar |
| **Vacío** | `envioComprobante === null` → sin celda (AC5). | — |
| **Lleno** | Chip + fecha + ayuda por la tabla de su destino. | — |

**Último destino conocido (AC6).** El destino solo viaja en el detalle, y la fila de la cola no lo
trae. El componente recuerda el `destino` de la última respuesta `listo` **de este impuesto** (se
olvida al cambiar de impuesto) y lo usa en cargando y error. Caso real que lo exige: tras un
reemplazo, `recargar()` pone la celda en cargando; sin memoria pasaría de «Comprobante en FLIT 1» a
un rótulo genérico y de vuelta. Solo en la **primera** carga, sin dato previo, el rótulo es neutro: no
se adivina el destino ni se nombra FLIT 2 por defecto (ese es justamente el engaño que corrige esta
HU). Ver pregunta 1 en Decisiones.

## Toast del reemplazo — por cada combinación de `envio`

El reemplazo **sí** se hizo en todas: ningún copy dice «error» ni usa tono de fallo. `toastOk` de
`components/flit/ToastFlito`, cerrable, `role="status"`. Duración: **4 s** con `reenviado: true`;
**8 s** (`duracionMs: 8_000`) con `reenviado: false` (dos frases).

| `envio` | Copy | Duración |
|---|---|---|
| `{ destino: 'flit1', reenviado: true }` | «Comprobante reemplazado. FLITO enviará el nuevo a FLIT 1.» | 4 s |
| `{ destino: 'flit1', reenviado: false, motivo: 'sin_envio_previo' }` | «Comprobante reemplazado en FLITO. No se envía a FLIT 1 porque el impuesto se pagó antes del envío automático.» | 8 s |
| `{ destino: 'flit1', reenviado: false, motivo: 'ya_cargado_gestor' }` (no debería ocurrir) | «Comprobante reemplazado en FLITO. No se envía a FLIT 1.» | 8 s |
| `{ destino: 'flit2', reenviado: true }` | «Comprobante reemplazado. FLITO enviará el nuevo a FLIT 2.» (igual que hoy) | 4 s |
| `{ destino: 'flit2', reenviado: false, motivo: 'ya_cargado_gestor' }` | «Comprobante reemplazado en FLITO. No se envía a FLIT 2: el gestor ya cargó el suyo allá.» (igual que hoy) | 8 s |
| `{ destino: 'flit2', reenviado: false, motivo: 'sin_envio_previo' }` | «Comprobante reemplazado en FLITO. No se envía a FLIT 2 porque el impuesto se pagó antes del envío automático.» (igual que hoy) | 8 s |
| `{ destino: null, reenviado: false, motivo: 'no_aplica' }` | «Comprobante reemplazado. Este trámite no envía el comprobante a otro sistema: queda solo en FLITO.» | 8 s |
| `envio` ausente o forma desconocida | «Comprobante reemplazado.» | 4 s |

- **Se retira** el copy «Este trámite no es de FLIT 2, así que no hay nada que enviar.» (`motivo:
  'no_flit2'` del contrato viejo): era el que mentía a un trámite FLIT 1. La UI ya no lee
  `envioFlit2`, así que no hay respaldo a él.
- El toast decide por `destino` + `reenviado` + `motivo`, nunca por texto del servidor.
- `no_aplica` no nombra FLIT 1 ni FLIT 2: el trámite no tiene ninguno de los dos, y nombrar uno
  repetiría el error que corrige la HU.
- Un solo toast por reemplazo (sin cambio). El estado persistente lo dice la celda tras el refresco.

## Decisión de componente

- **Un componente, un mapa por destino.** `COPY_POR_DESTINO: Record<DestinoEnvioComprobante, { rotulo,
  chips, ayuda(envio, hayCargarComprobante), errorConsulta }>` + la entrada neutra (rótulo «Envío del
  comprobante», error «No se pudo consultar el envío del comprobante.») para destino desconocido.
  El JSX (`<dt>`, `<dd>`, `StatusChip`, línea de fecha, línea de ayuda, botón Reintentar) es **uno
  solo** para ambos destinos.
- `data-testid="envio-comprobante"` + `data-destino="flit1|flit2"` (ausente si desconocido). El spec
  E2E de #13270 que usa `envio-flit2` se actualiza en esta HU (selector, no aserto).
- **Descartado** `if (destino === 'flit1') <CeldaEnvioFlit1/>`: dos componentes divergen al primer
  cambio. **Descartado** plantilla «a {destino}» compartida: rompe AC4.

## Responsive + feedback del delta

- **<sm (360 px, AC8):** sin cambio de layout: la celda sigue `col-span-2 sm:col-span-1` (fila
  entera), chip y fecha con `flex-wrap`, ayuda en texto corrido. Las ayudas FLIT 1 son algo más largas
  que las de FLIT 2: envuelven, sin `truncate`, sin `min-w`, sin scroll horizontal. El toast de 8 s
  envuelve dentro del ancho del contenedor de toasts.
- **≥sm:** al lado de Soporte, como hoy.
- **Feedback:** el único control del delta es `Reintentar` del error de consulta, ya especificado en
  #13270 (subrayado, `--flit-blue-text`, hover `--flit-bg-hover` + `rounded` + `transition-colors`,
  `flit-focus`). El chip no es interactivo: sin hover ni puntero.
- **Notificación:** toast cerrable para el resultado del reemplazo (tabla arriba); estado del envío
  en página (la celda), nunca toast.
- **Tema oscuro:** solo tokens ya usados (`--flit-text-muted`, `--flit-text-secondary`,
  `--flit-blue-text`, `--flit-bg-hover`, `StatusChip`). Sin tokens nuevos, sin animación, sombra ni
  icono.

## Accesibilidad

- `<dt>` con el destino («Comprobante en FLIT 1») + `<dd>`; el chip lleva texto, no solo color.
- `aria-busy` en el `<dd>` al cargar. Sin `aria-live` en la celda (el toast ya anuncia el
  reemplazo).
- `Reintentar` es `<button type="button">` con texto; su contexto lo da la frase previa, que nombra el
  destino.
- Contraste ≥ 4.5:1 texto, ≥ 3:1 foco, en claro y oscuro (mismos tokens que #13270).

## Permiso/slug

Sin cambio: sin página ni `PageSlug` nuevos. La celda la ve todo el que ve el detalle (incluida
Auditoría); «Reemplazar comprobante» sigue con `impuestos.recibos.reemplazar` (ningún rol la trae de
partida). Ayuda in-app: `content/ayuda/flito_impuestos.md` habla hoy solo de FLIT 2 →
`flit-ayuda-flito` aplica antes del PR.

## Notas para QA (≤10)

1. Trámite FLIT 1 enviado: rótulo «Comprobante en FLIT 1», chip «Enviado a FLIT 1» y «Enviado el {fecha}» (AC1).
2. FLIT 1 en `error`: chip «Error de envío», «Último intento», ayuda con «a FLIT 1» y «reemplázalo»; la palabra «FLIT 2» no aparece en la celda (AC2).
3. FLIT 1 `pendiente` y `sin_comprobante` (con y sin «Cargar comprobante» visible): ayuda de la tabla FLIT 1 (AC3).
4. Trámite FLIT 2: los seis estados, la ayuda y los toasts idénticos a #13270 (AC4); comparar contra la tabla de esa spec, no de memoria.
5. `envioComprobante: null`: no hay celda (AC5).
6. Fallo del detalle: en la primera carga, «Envío del comprobante» + «No se pudo consultar el envío del comprobante.» + Reintentar; tras un reemplazo en un FLIT 1, el esqueleto y el error dicen FLIT 1 (AC6).
7. Reemplazo: un toast por cada fila de la tabla de toasts (FLIT 1 sí/no, FLIT 2 tres casos, `no_aplica`, ausente); ninguno dice «Este trámite no es de FLIT 2» (AC7).
8. Diálogo de reemplazo en FLIT 1: nunca sale la línea del gestor; en FLIT 2 con `ya_cargado_gestor` sí.
9. 360 px, claro y oscuro: celda a ancho completo, ayudas envueltas, sin scroll horizontal (AC8).

## Decisiones y descartes

- **Generalizar, no duplicar:** un componente con copy por destino; FLIT 2 no se toca visualmente.
- **Ayuda en `pendiente` solo para FLIT 1:** lo pide AC3 y AC4 congela FLIT 2. Si el PO prefiere
  simetría, se añade a FLIT 2 en otra HU (no en esta).
- **Sin respaldo a `envioFlit2`:** leer dos campos para lo mismo es la puerta a que vuelva el copy
  engañoso.
- **Nombre «FLIT 1»:** lo fijan los AC. En Gestión Trámites la fuente se rotula «FLIT»
  (`ETIQUETA_FUENTE_TRAMITE`); no se unifica en esta HU (Nota, no alcance).
- **Pregunta 1 para el PO (no bloquea):** AC6 pide que cargando/error nombren FLIT 1, pero en la
  **primera** carga el destino aún no se conoce (solo viaja en el detalle que está fallando). Se
  resolvió con rótulo neutro en ese caso y con el último destino conocido en los refrescos. Si el PO
  quiere el destino también en la primera carga, hace falta que la fila de la cola traiga la fuente
  del trámite → requerimiento de datos para architecture/backend, fuera de esta HU.
- Sin efectos, iconos, tokens ni componentes de kit nuevos.
