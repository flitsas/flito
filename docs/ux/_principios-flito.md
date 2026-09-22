# Principios de UI · FLITO

Fuente de oficio para `ux-agent` y `frontend-agent`. No es una spec de pantalla: es el listón
cuando se diseña o se pinta **este** producto.

**Esto es FLITO**, no FLIT. El prefijo `flit/` y los tokens `--flit-*` son el **kit de este
repo** (nombre histórico en CSS). No se importan estética, guardianes ni prototipos de otro
proyecto. Hasta que el PO entregue marca adicional, **mandan este documento y el kit en
código** (`apps/web/src/styles/flit-tokens.css`, `components/flit/`, `components/shell/`).

---

## Carácter

Minimalista y claro. Distintivo por **orden y contraste del kit**, no por adorno.

| Sí | No |
|---|---|
| Una idea dominante por superficie | Varias primarias compitiendo |
| El dato que el usuario vino a ver, a la vista | Todo el payload en la primera fila «por si acaso» |
| Tokens, pills, `PageHeaderCard`, `FlitTable`, `StatusChip` | HEX suelto, `bg-white`, componente nuevo «más bonito» |
| Copy corto que dice qué hacer | Vacío «No hay datos» / error «Ocurrió un problema» |
| Aire, agrupación, rótulos que se leen | Sombras extra, animaciones, ilustraciones, confetti, glass, hover teatrales |
| Hover **sutil** en todo control interactivo | Controles planos que parecen deshabilitados |

**Efectos vistosos: no.** Sin transiciones de página, sin microinteracciones de «wow», sin
gradientes decorativos fuera de los tokens de CTA/shell que ya existen. El carácter de FLITO
es una pantalla que se entiende en un vistazo. **Ojo:** «sin efectos vistosos» nunca quiso decir
«sin respuesta» — el feedback de interacción es claridad, no adorno (ver la sección siguiente).

---

## Qué se ve (jerarquía)

Antes de dibujar, nombra **qué vino a hacer** quien abre la pantalla (el trabajo de esa visita,
no el rol en abstracto). Todo lo demás es secundario o se va al detalle.

1. **Siempre visible:** el identificador de la fila o del caso, el estado, y la acción de esa
   visita. En una cola: lo que decide «abro esta fila / no». En un formulario: el bloque que
   desbloquea el envío.
2. **A un clic (detalle, modal, acordeón):** lo que se consulta, no lo que se opera. Historial,
   metadatos, PII extra, columnas que solo importan a veces.
3. **No está:** jerga de trastienda en el canal Cliente (ANS, bolsa, proveedor, valor pagado,
   quién despachó) salvo que el AC lo pida. En operador, no está lo que no responde a esa visita.

Si no puedes decir en una frase *qué se ve primero*, la spec no está lista.

**Densidad.** Añadir una columna, un filtro o un botón no es gratis. Si la superficie ya está
apretada, el dato nuevo va al detalle o se pregunta al PO — no se apila. Copiar al vecino no
autoriza copiarle la saturación.

---

## Una primaria

Por superficie, **una** acción con peso de `flitBtnPrimary` / `GradientButton`. El resto es
secundario (`flitBtnSecondary`) o está en la fila.

Excepción escrita: un wizard con «Siguiente» y «Cancelar» (Cancelar no es primaria). Dos
primarias en el mismo encabezado es un fallo de oficio, no una preferencia.

---

## Feedback de interacción (affordance)

Un control que no reacciona al puntero parece deshabilitado. El feedback sutil **es** claridad:
dice «esto se puede pulsar» antes de pulsarlo. No confundir con el adorno, que sigue prohibido.

| Adorno (prohibido) | Feedback (obligatorio) |
|---|---|
| Escalas, rebotes, rotaciones, «wow» | Hover sutil: velo `--flit-bg-hover`, o cambio de tono de fondo/borde del token propio |
| Sombras o gradientes nuevos por moda | `transition-colors` corta (≤ `--flit-duration-base`) |
| Animación que retrasa la acción | `active` / `disabled` distinguibles; foco del kit (`flit-focus`) |

**Todo** control interactivo (botón, pill, fila clicable, ✕, ítem de menú, casilla) tiene hover
visible al puntero y foco visible al teclado. Si el kit no lo da en ese control, la spec lo dice
y se añade con tokens — no se entrega plano. La medida de «sutil»: quien lo mira nota que el
control está vivo; quien no lo busca no lo ve.

---

## Responsive — la pantalla también existe en móvil

Toda superficie se especifica y se implementa para **dos anchos**: escritorio (≥ `lg`) y móvil
(360–390 px). «Que quepa» no basta: tiene que poder **usarse**.

- Grids de varias columnas llevan breakpoints (`grid-cols-1` en móvil, `sm:`/`md:` al subir);
  ninguna rejilla de 3–4 columnas fijas.
- Barras de filtros y de acciones **envuelven** (`flex-wrap`); ningún control lleva `min-w` que
  desborde un móvil.
- Tablas: scroll horizontal del kit (`FlitTable`) — nunca desborde de página ni `<table>` suelta
  sin contenedor.
- Las acciones del encabezado se apilan bajo el título cuando no caben a su lado.
- La spec escribe el comportamiento <lg aunque sea una línea («la barra envuelve; el detalle pasa
  a acordeón»). Lo que no se escribe, quien implementa no lo adivina.

---

## Tema oscuro — toda superficie se revisa en los dos temas

El oscuro no es una variante opcional: es la mitad de las sesiones. Las reglas:

- Todo color por **token `--flit-*` con par oscuro**. Prohibido en superficies: `'white'`, `#fff`,
  `bg-white`, `slate-*` / `gray-*` / `red-*` crudos — en oscuro quedan ilegibles o fosforescentes.
  (Excepción legítima: el lienzo de un PDF, que es blanco como el papel.)
- Error/peligro sobre tarjeta: `--flit-danger-ink`. `text-red-600` da ~2,3:1 en oscuro: no cumple.
- Activo/seleccionado: velo `--flit-bg-app` / `--flit-bg-hover` o tinta `--flit-blue-text` (ambos
  con par oscuro). Un fondo de acento claro sin par queda fosforescente en oscuro.
- Referenciar un token que **no existe** (`var(--flit-x)` sin definir) deja el fondo sin pintar en
  los dos temas: antes de usarlo, verificar que está definido en `flit-tokens.css`.
- La verificación visual cubre **los dos temas**, no solo el claro. Un token de color nuevo exige
  su par oscuro y pasar `check:contraste` en ambos.

---

## Notificaciones — toast o aviso, nunca los dos por costumbre

| Situación | Patrón |
|---|---|
| Resultado de una acción puntual (guardó, falló, se envió) | **Toast**: cerrable (✕ o clic), una frase; éxito ~4 s, error hasta cerrarlo o ≥ 6 s |
| Estado que sigue siendo cierto al mirar la página (filtro aplicado, registro actualizado, borrador) | **Aviso en página** (`role="status"` / tarjeta), no toast |
| Error de un campo o de un modal | En línea junto al campo, o `role="alert"` en el modal — no toast |

El mensaje se escribe para quien opera: qué pasó y qué sigue. **Nunca** el error crudo del API
(`e.message`, códigos, volcados de variables) ni telemetría interna («3 insertados de 10 (2s)»).
Un toast por acción, no uno por paso del flujo.

---

## Vacío, error, lleno

Los 4 estados (`AGENTS.md` regla 9) siguen siendo bloqueantes. El oficio añade **siguiente paso**:

| Estado | Qué debe decir |
|---|---|
| Vacío | Por qué no hay nada **y** qué hacer (filtro, crear, esperar, pedir permiso). Nunca solo «No hay datos». |
| Error | Qué falló, si se puede reintentar, y el botón **Reintentar** (o la acción real). |
| Lleno | Lo que se vino a ver, sin competir con banners, KPIs de adorno ni ayudas que duplican el título. |
| Cargando | Esqueleto de **esa** estructura (mismas columnas/bloques), no un spinner genérico si el kit ya tiene `PageContentSkeleton`. |

---

## Voz

- El producto se llama **FLITO**. En copy de UI no se usa «FLIT» como nombre de esta app.
- Glosario: `docs/dominio.md`. No inventar sinónimos (Facturar ≠ emisión DIAN, etc.).
- Español colombiano de producto. Frases cortas. El botón dice la acción (`Solicitar SOAT`, no
  `Enviar`).
- **No mezclar usted y tú en la misma pantalla.**
- Canal Cliente y fichas de Ayuda: **usted** (ya asentado).
- Colas de Operaciones: muchas **tutean** hoy. En un delta, **calca el tono de esa pantalla**.
  No unificar el producto entero en una HU.

---

## Kit: componer, no clonar

Reusar `components/flit/` y `shell/` es obligatorio (`AGENTS.md` regla 13). Eso no es pegar la
página análoga entera.

- Misma **familia** (cabecera + filtros + tabla + detalle).
- Distinto **peso**: menos columnas, un subtítulo que oriente, vacío útil, primaria única.
- Un patrón nuevo solo si el kit **no** cubre el caso, y se justifica en Decisiones y descartes.
- Colores y radios: tokens. Contraste ≥ 4.5:1 texto, ≥ 3:1 foco/gráficos, en claro y oscuro.

---

## Audiencia

| Quién | Listón |
|---|---|
| Operador interno (`admin`, `financiera`, `proveedor`, …) | Densidad justificada. Cada columna visible responde al trabajo de esa visita. |
| Cliente (compañía, rol `cliente`) | Menos columnas, cero jerga interna, copy que no asume que conoce FLITO. Mismo kit, menos ruido. |

No diseñes la pantalla del Cliente calcando la cola de Operaciones.

---

## Checklist de oficio (HANDOFF)

Una spec o una implementación **no** está OK si falla alguno:

- [ ] Se nombra qué vino a hacer el usuario y qué se ve primero
- [ ] Hay **una** primaria (o la excepción del wizard está escrita)
- [ ] Lo que no es de esa visita está en detalle o fuera
- [ ] Vacío y error tienen siguiente paso
- [ ] Sin efectos vistosos ni patrón visual nuevo injustificado
- [ ] Dicho qué pasa en móvil (<`lg`), aunque sea una línea
- [ ] Todo control interactivo con feedback (hover sutil + foco); ninguno plano
- [ ] Notificación elegida: toast cerrable vs aviso en página, con copy pulido (sin errores crudos)
- [ ] Copy: FLITO, glosario, un solo tratamiento (usted o tú) en la pantalla; subtítulo de cabecera de una frase, sin mecánica interna
- [ ] Canal Cliente ≠ cola interna si el público no es el mismo
