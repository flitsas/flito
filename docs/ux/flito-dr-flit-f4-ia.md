# Anexo F4 — Dr. Flit responde con IA (Feature #13696 · HU #13857 IA-5 + copy de HU #13858 IA-6)

> Modo **slim**. Continúa `docs/ux/flito-dr-flit.md` (F3 y anexo F5) y `docs/ux/flito-dr-flit-f6.md` (F6). Mismo
> panel, mismo público (operador interno con ≥1 ficha de la Ayuda; el enlace de cliente no ve a Dr. Flit), mismo
> tratamiento (**usted**), Dr. Flit en primera persona. **No hay panel nuevo ni patrón visual nuevo**: burbujas de
> `DrFlitMensaje`, citas de F3, autorización de F5 (parametrizada por `finalidad`), oferta y bloque de F6.
> Habla con el módulo **nuevo** `flito-dr-flit` (`/api/flito/dr-flit`), no con ningún módulo legacy.
> Fuentes: AC de IA-5/IA-6 (`docs/ado-drafts/epic-12756-12757/HUS-F4-13696.md`), diseño
> `docs/diseno/feature-13696-dr-flit-ia.md`, contrato real en `packages/shared-types/src/flito-dr-flit.ts`.
>
> **Contrato contra el que se diseña (el de shared-types, no el resumen del encargo):** `intent` ∈ `duda | soporte |
> gestion | no_claro`; `enManuales`; `citas: { clave, ancla | null, tituloFicha, tituloSeccion | null }[]` (≤3);
> `gestionTarget` ∈ `placa | vin | tramite | cliente` y `gestionRef` planos (no un objeto `gestion`); `cupo` o
> `null`; `degradado` con `intent: null`. 428 `autorizacion-requerida`; 429 `demasiados-mensajes`.

---

## IA.1 Superficie tocada

| Pieza | Cambio |
|---|---|
| Cuerpo del panel | Paso nuevo **«Antes de usar la IA»**: el componente de autorización de F5 con `finalidad="ia"`. Como en F5, **sustituye** la conversación y el pie mientras está a la vista; el marco no cambia |
| Pie (sobre/bajo la caja) | Una línea de ayuda de privacidad bajo la caja (solo con la IA en uso); la cuenta de cupo cuando quedan ≤ 5; el aviso persistente de cupo agotado; el enlace para activar la IA (tras «Ahora no» o un 428). **Nunca más de dos de estas a la vez** (IA.3) |
| Conversación | Mensaje nuevo **`respuestaIa`**: texto plano + (si hay) «En sus manuales:» + hasta 3 citas con el render de F3 + una línea «Respondido con IA…». Variantes: no está en los manuales, pregunta de seguimiento, oferta de soporte, oferta de gestión (la de F6), gestión sin valor, gestión por documento |
| Espera | «Dr. Flit está pensando…» en lugar de «Dr. Flit está buscando…» cuando la pregunta va a la IA |

**No cambian:** el botón flotante, la cabecera (título «Dr. Flit», subtítulo «Le respondo con la Ayuda FLITO.»,
«Terminar chat», «Cerrar»), el saludo, «Explícame un módulo», la caja (300 caracteres, contador desde 250), el
asistente de soporte de F5, el bloque de resultados de F6 y todos los estados de F3. **Con la IA apagada
(`ia.disponible=false`) no cambia nada de lo que se ve hoy** (AC10): ni autorización, ni línea de privacidad, ni
cupo, ni «pensando», ni la marca «Respondido con IA».

## IA.2 Delta de claridad (qué se ve / qué se calla)

**Qué vino a hacer:** preguntar en sus palabras y salir con la respuesta y el enlace a la sección del manual que
la respalda, sin salir de la pantalla. Igual que en F3; lo que cambia es que la respuesta llega redactada.

**Qué se ve primero:** la respuesta en texto y, debajo, las fuentes. En una frase: **la respuesta, y de dónde
sale.**

| Nivel | Qué |
|---|---|
| **Siempre visible** | La conversación y la caja con **Enviar** (como F3). Con la IA en uso, una línea de privacidad bajo la caja |
| **Cuando importa** | Cupo: solo cuando quedan ≤ 5 («Le quedan 3 preguntas con IA hoy.»). Aviso de límite: solo con cupo 0. Enlace «Activar respuestas con IA»: solo si el usuario no la ha aceptado |
| **A un clic** | El texto completo de la autorización (paso propio); la ficha citada (enlace) |
| **No está** | La palabra «degradado», motivos técnicos (timeout, error del modelo, respuesta inválida), «tokens», el nombre del modelo, `usados/tope` como fracción, el contador cuando sobra cupo, el `intent`, los tokens de máscara en claro (`[PLACA_1]`), Markdown sin interpretar (se pinta texto plano), enlaces que no vengan de `citas`, cualquier mención a la IA con la IA apagada |

**Densidad:** el pie gana una línea fija (privacidad) y, en casos puntuales, una segunda. La conversación no gana
nada: la respuesta IA ocupa lo que ocupaba «Esto es lo que encontré en sus manuales:» más un párrafo. **Densidad
ligeramente mayor en el pie; aceptada** porque la línea de privacidad es la que exige IA-3 (el usuario debe saber
qué se oculta *donde escribe*) y el resto aparece solo cuando es cierto.

**Una primaria:** **Enviar**, sin cambio. En el paso de autorización, **«Aceptar»** (como «Acepto» en F5). En la
oferta de gestión, la de F6. El enlace «Activar respuestas con IA», la oferta de soporte y Reintentar son
secundarios.

## IA.3 Pie del panel con la IA (orden y reglas)

```
├───────────────────────────────────┤
│ [Explícame un módulo]             │  ← F3, sin cambio
│ (aviso o enlace, una sola línea)  │  ← A: cupo agotado | B: activar IA | C: condiciones cambiaron (excluyentes)
│ Escriba su pregunta               │
│ ┌─────────────────────┐ [Enviar]  │
│ └─────────────────────┘           │
│ No envío a la IA placas, VIN,     │  ← privacidad (text-xs, text-flit-secondary), solo con IA en uso
│ documentos ni correos; nombres y  │
│ direcciones, sí.                  │
│ Le quedan 3 preguntas con IA hoy. │  ← solo con 1 ≤ restantes ≤ 5
│ 251/300                           │  ← contador de F3, desde 250
└───────────────────────────────────┘
```

| Situación | Sobre la caja | Bajo la caja |
|---|---|---|
| IA en uso, cupo > 5 | — | Privacidad |
| IA en uso, 1–5 restantes | — | Privacidad + «Le quedan N preguntas con IA hoy.» (singular: «Le queda 1 pregunta con IA hoy.») |
| Cupo agotado (AC8) | **A:** aviso persistente con el texto de AC8 | — (no hay IA en uso) |
| «Ahora no» o sin aceptar (AC3) | **B:** «Le respondo con la búsqueda en los manuales.» + enlace **«Activar respuestas con IA»** | — |
| 428 por versión nueva (AC3) | **C:** «Cambiaron las condiciones de uso de la IA.» + enlace **«Revisar y aceptar»** | — |
| IA apagada (AC10) | — | — (exactamente como hoy) |

A, B y C son la misma pieza: tarjeta de aviso de página (`role="status"`, `bg-flit-app`, borde
`border-flit-soft`, `rounded-flit`, `text-sm text-flit-secondary`), sin icono, sin ✕ (es estado, no
notificación). El enlace usa el estilo de «Abrir la ficha →» de F3 sin flecha. Precedencia si coinciden: C > A > B
(sin autorización vigente el cupo no importa).

## IA.4 Autorización `ia` (AC1–AC4)

Reutiliza la vista de autorización de F5 (wireframe C del anexo F5) con `finalidad="ia"`. **Un solo componente.**

```
┌───────────────────────────────────┐
│ Dr. Flit                       [✕]│
│ Le respondo con la Ayuda FLITO.   │
├───────────────────────────────────┤
│ Antes de usar la IA               │  ← h3, tabIndex -1, recibe el foco
│ Para responderle con sus propias  │  ← entradilla fija (text-sm, text-flit-secondary)
│ palabras, Dr. Flit puede usar     │
│ inteligencia artificial. Lea las  │
│ condiciones:                      │
│                                   │
│ <textoVigente de GET              │  ← texto del servidor, tal cual (texto plano, párrafos)
│  /autorizacion?finalidad=ia>      │     el cuerpo hace scroll; sin caja con scroll propio
│                                   │
│ (!) No pude registrar su          │  ← solo en error (AC4), role="alert", --flit-danger-text
│     autorización. … [Reintentar]  │
├───────────────────────────────────┤
│                [Ahora no] [Aceptar]│  ← Aceptar = primaria
└───────────────────────────────────┘
```

| Momento | Comportamiento |
|---|---|
| Cuándo aparece | Al abrir el panel, si `GET /autorizacion?finalidad=ia` dice `ia.disponible=true` y `autorizado=false`. Una vez por sesión: tras «Ahora no» no vuelve a abrirse sola hasta la próxima sesión (el enlace B queda en el pie). Si llega con una conversación restaurada, la tapa como el asistente de F5; al salir, la conversación está igual |
| Cargando el estado | El panel funciona como F3 mientras llega el GET; no se pinta nada de IA. Si el GET falla: sin IA y sin aviso en esta apertura (se reintenta al volver a abrir). Nunca un error visible por el GET |
| **Aceptar** | `POST /autorizacion` con `finalidad: "ia"` y la versión **mostrada**. Botón deshabilitado + texto «Registrando…» mientras dura. Éxito: vuelve la conversación (o el saludo), foco a la caja, el `log` anuncia «Respuestas con IA activadas.». Sin toast |
| **Ahora no** / Esc | Vuelve a la conversación sin registrar nada; foco a la caja; aparece el enlace B. Las preguntas van a la búsqueda de F3 sin error (AC3) |
| Falla el POST (red/5xx) (AC4) | Aviso en la vista: «No pude registrar su autorización. Revise su conexión e intente de nuevo.» + **Reintentar** (repite el POST). «Ahora no» sigue disponible. Mientras tanto, nada va a la IA |
| 400 `version-no-vigente` (AC4) | Aviso: «Las condiciones cambiaron mientras las leía. Revise el texto actualizado y vuelva a aceptar.» + **Reintentar**, que recarga el texto vigente (GET); el usuario vuelve a pulsar Aceptar |
| 428 en el chat | La pregunta se responde con F3 sin error (AC3) y aparece el aviso C. «Revisar y aceptar» abre esta vista con el texto nuevo. La vista **no** se abre sola en medio de una respuesta |
| «Activar respuestas con IA» / «Revisar y aceptar» | Abre esta vista. No envía nada por sí solo |

La entradilla es copy de producto (no legal) y no repite el texto vigente. **No** hay casilla «He leído»: pulsar
Aceptar es el consentimiento (igual que F5).

## IA.5 Respuestas en la conversación

### Wireframe — duda con citas (AC5)

```
│              ┌──────────────────┐ │
│              │ ¿cómo hago para  │ │  ← burbuja del usuario (F3)
│              │ certificar un    │ │
│              │ SOAT?            │ │
│              └──────────────────┘ │
│ ┌───────────────────────────────┐ │
│ │ Entre a SOAT, busque la póliza│ │  ← reply: texto plano, saltos de línea respetados
│ │ por placa y pulse «Certificar»│ │     (whitespace-pre-line, break-words), text-flit-ink
│ │ …                             │ │
│ │ En sus manuales:              │ │  ← text-xs, text-flit-muted
│ │ ┌───────────────────────────┐ │ │
│ │ │ SOAT                      │ │ │  ← cita de F3: ficha (muted) + sección (ink) + →
│ │ │ Certificar una póliza   → │ │ │
│ │ ├───────────────────────────┤ │ │
│ │ │ SOAT                      │ │ │
│ │ │ Estados                 → │ │ │
│ │ └───────────────────────────┘ │ │
│ │ Respondido con IA; confirme en│ │  ← text-xs, text-flit-secondary, sin icono
│ │ la ficha citada.              │ │
│ └───────────────────────────────┘ │
```

- **Citas:** el mismo componente de F3. Destino `/flito/ayuda/<clave>#<ancla>` si `ancla` existe y `anclaExiste`
  la confirma; si no, `/flito/ayuda/<clave>`, y la cita pinta **una sola línea** con `tituloFicha` en `text-flit-ink`
  (sin la línea de sección). Ficha sin permiso al restaurar: «Esta referencia ya no está disponible» (F3).
- **Texto:** nunca HTML ni Markdown: si llegan `**` o `#` se ven tal cual (el prompt pide texto plano). Ningún
  enlace se construye desde el `reply`.

### Valores ocultos dentro de la respuesta (nota heredada de IA-3)

| Caso | Cómo se ve |
|---|---|
| Token con valor en el mapa del envío (`[PLACA_1]` → `ABC123`) | **El valor, como texto normal**, idéntico a como lo escribió el usuario. Sin resaltado, sin chip, sin corchetes: es su propio dato y marcarlo solo lo haría llamativo |
| Token sin valor (respuesta restaurada tras recargar, o token que el mapa no conoce) | Una palabra legible en su lugar, mismo estilo del texto: «(placa oculta)», «(VIN oculto)», «(documento oculto)», «(correo oculto)», «(id FLIT oculto)». Nunca `[PLACA_1]` |

Por eso `sessionStorage` guarda el `reply` **tal como llegó** (con tokens) y la pantalla lo restaura solo mientras
el mapa vive en memoria (AC9). Tras recargar, se ve la variante «(… oculta)».

### Variantes de respuesta

| Respuesta | Qué se ve | Acciones |
|---|---|---|
| `duda`, `enManuales=true` (AC5) | `reply` + «En sus manuales:» + 1–3 citas + «Respondido con IA; confirme en la ficha citada.» | Citas |
| `duda`, `enManuales=false` (AC6) | `reply` (si viene `null`: «No encontré eso en sus manuales.») + «Respondido con IA.» | Fila `flex-wrap` de F3/F5: **[Abrir la Ayuda FLITO] [Necesito soporte]** (`flitBtnSecondarySm`; «Necesito soporte» solo si `soporteDisponible`) |
| `no_claro` (AC6) | `reply` como mensaje normal (es la pregunta de seguimiento), sin citas, sin marca IA | Ninguna: se contesta en la caja |
| `soporte` (IA-6 AC1) | «Para eso le conviene hablar con soporte. Puedo ayudarle a radicar su caso desde aquí.» | **[Necesito soporte]** (`flitBtnSecondarySm`), que abre el asistente de F5 como hoy. Sin soporte disponible: el mensaje no se muestra y la pregunta se responde con F3 |
| `gestion` con valor (IA-6 AC2, AC4 con `gestionRef`) | **La oferta de F6, idéntica** («Encontré la placa ABC123. ¿Quiere ver en qué va?» + «Consultar ABC123 en sus módulos» primaria + «Buscar en los manuales»). El valor sale del mapa local, no del modelo | Las de F6; nada se consulta sin el clic |
| `gestion`, varios valores y `gestionRef=null` (IA-6 AC4) | «Encontré varias placas en su mensaje. ¿Cuál quiere consultar?» y un botón por valor, hasta 3: **[Consultar ABC123] [Consultar XYZ789]** (`flitBtnSecondarySm`, todos iguales: ninguno pesa más) + «Buscar en los manuales» | Al pulsar uno, ese botón desaparece y debajo aparece el bloque de F6; los otros siguen vivos hasta el siguiente mensaje del usuario (entonces la burbuja queda como «No consulté XYZ789.», regla de F6). Más de 3: «Escriba las demás en otro mensaje.» |
| `gestion` sin valor del tipo pedido (IA-6 AC5) | «Para consultarlo necesito la placa, el VIN o el id FLIT.» | Ninguna: no se consulta nada |
| `gestion` con `gestionTarget=cliente` (IA-6 AC6) | «Por documento no consulto desde aquí. Búsquelo en la pantalla del módulo:» + enlaces a los que el usuario ve, en este orden: **Abrir Trámites · Abrir SOAT · Abrir Impuestos** (estilo de enlace de F6, rutas sin query). Si no ve ninguno: «Por documento no consulto desde aquí. Pídale a quien administra su cuenta acceso a Trámites, SOAT o Impuestos.» | Enlaces. El documento no va en la URL ni se consulta |
| Degradado `ia-timeout` / `ia-error` / `respuesta-invalida`, red caída, 429 `demasiados-mensajes` (AC7) | **La respuesta de hoy**, sin ningún aviso: búsqueda F3 y, si el detector de F6 encuentra un valor, la oferta de F6 | Las de F3/F6 |
| Degradado `cupo-agotado` (AC8) | Respuesta F3 + aviso A en el pie. Las siguientes preguntas del día van directo a F3 sin llamar al chat | Las de F3 |
| Degradado `ia-apagada` en mitad de la sesión | Respuesta F3; desaparecen la línea de privacidad y el cupo; no se vuelve a llamar al chat en la sesión. Sin aviso (AC10) | Las de F3 |

**Marca «Respondido con IA»:** solo en `duda`. Dice de dónde sale el texto sin alarmar y empuja a la cita. No es
icono ni chip.

## IA.6 Estados (4) de lo tocado

| Estado | Qué se ve | Copy | Control |
|---|---|---|---|
| **Cargando / escribiendo** | Mensaje del usuario + burbuja de Dr. Flit con una línea, sin animación (como F3) | «Dr. Flit está pensando…» (en el `log`, se anuncia una vez). Si cae a F3 y F3 necesita cargar fichas, la línea pasa a «Dr. Flit está buscando…» | Enviar deshabilitado hasta la respuesta, Enter no envía (no hay doble envío, AC5); la caja sigue editable |
| **Error con reintento** | Solo si **también** falla el respaldo F3: el error de F3 | «No pude revisar sus manuales en este momento.» / «Revise su conexión e intente de nuevo.» | **Reintentar** reenvía la misma pregunta por el camino completo (IA si está en uso; si falla, F3) sin duplicar el mensaje del usuario. Una falla solo de la IA **no** es error visible (AC7) |
| **Vacío / inicial** | Saludo de F3 sin cambios; con la IA en uso, la línea de privacidad bajo la caja. La primera vez, el paso «Antes de usar la IA» | Ver IA.4 / IA.9 | Las de F3 |
| **Lleno** | Respuesta IA con texto, citas y marca (IA.5) | — | Citas, acciones de la variante |

Cerrar el panel mientras piensa: la petición sigue y la respuesta está al reabrir. «Terminar chat» mientras piensa:
la respuesta se descarta.

## IA.7 Responsive (<lg) y feedback

**Móvil (panel a ancho completo, geometría F3):**
- La línea de privacidad y la de cupo envuelven (2–3 líneas a 360 px); el pie no lleva `min-w`.
- Avisos A/B/C a ancho completo; el enlace baja a su línea si no cabe.
- Paso de autorización: el texto hace scroll en el cuerpo; «Ahora no» y «Aceptar» en el pie, que envuelve (Aceptar
  arriba/derecha); objetivos ≥ 44 px.
- Botones de la oferta de varios valores y de «sin respuesta en los manuales»: `flex-wrap`, a ancho completo si no
  caben. Las citas, una columna (F3).
- Seguir una cita o un enlace de módulo cierra el panel en <lg (regla de F3); la conversación se conserva.

**Feedback (ningún control plano):**

| Control | Hover | Foco | Otros |
|---|---|---|---|
| Aceptar | velo de pulsación de `flitBtnPrimary` | `flit-focus` | `disabled` del kit con «Registrando…» |
| Ahora no / Reintentar / Necesito soporte / Abrir la Ayuda FLITO / Consultar <valor> (varios) | `HOVER_SECUNDARIO` (`flitBtnSecondarySm`) | `flit-focus` | — |
| Activar respuestas con IA / Revisar y aceptar / Abrir Trámites·SOAT·Impuestos | `text-flit-blue-text` + subrayado, `transition-colors` (enlace de F3) | `flit-focus` | Son `<button>` los dos primeros (abren una vista), `Link` los de módulo |
| Cita | velo `--flit-bg-hover` + subrayado de la sección (F3) | `flit-focus` | — |
| Avisos, líneas de privacidad y cupo, marca IA | **Ninguno**: no son interactivos y no lo aparentan | — | — |

**Notificaciones: sin toasts** (decisión de F3/F5/F6). Aceptar la autorización se confirma por el cambio de vista y
el anuncio del `log`; el límite y la autorización pendiente son **avisos persistentes en el pie** (estado que sigue
siendo cierto); las fallas de la IA no se notifican (cae a F3). Ningún texto muestra el error crudo, el código ni
el motivo de degradación.

## IA.8 Accesibilidad

- **Respuesta (AC5):** entra en el `role="log" aria-live="polite"` de F3, con el prefijo `sr-only` «Dr. Flit:». Se
  anuncia el `reply` y, si hay citas, la frase `sr-only` «Con 2 referencias a sus manuales.»; la lista de citas va
  en un contenedor `aria-live="off"` para no dictar los enlaces. El foco **no** se mueve.
- «Dr. Flit está pensando…» se anuncia una vez (dentro del `log`); no `aria-busy` en el panel.
- **Autorización:** vista con `h3` «Antes de usar la IA» (`tabIndex={-1}`, recibe el foco); botones con texto
  («Aceptar», «Ahora no»); Esc = «Ahora no» (AC1); el error en `role="alert"` junto a su Reintentar; al salir, foco a
  la caja. El manejador de Esc es el del panel (precedencia de F3: primero cierra lo transitorio).
- **Avisos A/B/C:** `role="status"` (se anuncian al aparecer, sin robar el foco). El de cupo agotado no se repite en
  cada pregunta.
- **Caja:** la línea de privacidad y la de cupo se ligan por `aria-describedby` a la caja junto al contador de F3.
- **Oferta de varios valores:** `role="group"` con `aria-labelledby` a la pregunta «¿Cuál quiere consultar?»;
  botones con el valor en el texto.
- **Valores ocultos:** «(placa oculta)» es texto normal (lo lee el lector); los tokens crudos nunca llegan al DOM.
- Contraste y tema oscuro: solo tokens con par oscuro (`text-flit-ink`, `text-flit-secondary`, `text-flit-muted`,
  `bg-flit-app`, `border-flit-soft`, `--flit-danger-text` para errores, como F6). **Ningún token nuevo.**

## IA.9 Copy final (usted)

| Lugar | Texto |
|---|---|
| Espera (IA) | Dr. Flit está pensando… |
| Título del paso | Antes de usar la IA |
| Entradilla | Para responderle con sus propias palabras, Dr. Flit puede usar inteligencia artificial. Lea las condiciones: |
| Botones | [Ahora no] [Aceptar] · registrando: Registrando… |
| Aceptó (anuncio `log`) | Respuestas con IA activadas. |
| Error al registrar | No pude registrar su autorización. Revise su conexión e intente de nuevo. · [Reintentar] |
| Versión cambió al aceptar | Las condiciones cambiaron mientras las leía. Revise el texto actualizado y vuelva a aceptar. · [Reintentar] |
| Aviso B (sin aceptar) | Le respondo con la búsqueda en los manuales. · Activar respuestas con IA |
| Aviso C (428) | Cambiaron las condiciones de uso de la IA. · Revisar y aceptar |
| Aviso A (cupo agotado, AC8 literal) | Por hoy alcanzó el límite de preguntas con IA. Sigo ayudándole con la búsqueda en los manuales; el cupo se renueva a la medianoche. |
| Privacidad bajo la caja | No envío a la IA placas, VIN, documentos ni correos; nombres y direcciones, sí. |
| Cupo bajo (1–5) | Le quedan {N} preguntas con IA hoy. · Le queda 1 pregunta con IA hoy. |
| Rótulo de citas | En sus manuales: |
| Marca (duda con citas) | Respondido con IA; confirme en la ficha citada. |
| Marca (duda sin manuales) | Respondido con IA. |
| No está en los manuales (`reply` null) | No encontré eso en sus manuales. |
| Soporte (IA-6 AC1) | Para eso le conviene hablar con soporte. Puedo ayudarle a radicar su caso desde aquí. · [Necesito soporte] |
| Gestión con valor | (copy de F6) Encontré la placa {valor}. ¿Quiere ver en qué va? · [Consultar {valor} en sus módulos] · [Buscar en los manuales] |
| Gestión, varios valores | Encontré varias placas en su mensaje. ¿Cuál quiere consultar? · [Consultar {valor}] … · [Buscar en los manuales] · (más de 3) Escriba las demás en otro mensaje. («varios VIN» / «varios id FLIT» según el tipo) |
| Gestión sin valor | Para consultarlo necesito la placa, el VIN o el id FLIT. |
| Gestión por documento | Por documento no consulto desde aquí. Búsquelo en la pantalla del módulo: · Abrir Trámites · Abrir SOAT · Abrir Impuestos |
| …sin módulos | Por documento no consulto desde aquí. Pídale a quien administra su cuenta acceso a Trámites, SOAT o Impuestos. |
| Valores sin mapa | (placa oculta) · (VIN oculto) · (documento oculto) · (correo oculto) · (id FLIT oculto) |

Prohibido en copy: «degradado», «timeout», «modelo», «tokens», «Anthropic» (fuera del texto legal), «cupo-agotado»,
«428», «intent», `e.message`.

**Desviaciones de literal de AC (QA debe esperar el de esta tabla; conviene ajustar el AC al publicar):**
1. IA-5 AC6 dice «Contactar a soporte»; el botón es **«Necesito soporte»**, el mismo nombre que ya tiene el flujo de
   F5 en el saludo y en «sin resultados». Dos nombres para el mismo flujo confunden.
2. IA-6 AC5 dice «…la placa, el VIN o el radicado»; aquí **«…o el id FLIT»**, el término de F6 (pista y oferta).
   «Radicado» en Dr. Flit ya significa el caso de soporte de F5.

## IA.10 Permiso/slug

Ninguno nuevo; no es una ruta. Visibilidad del panel: la de F3 (`puedeVerAyudaFlito`, sin enlace de cliente).
Rama IA: `ia.disponible` del GET + autorización `ia` vigente + `cupo.restantes > 0`. Enlaces de módulo (gestión por
documento) y grupos de F6: `hasPage('flito_<modulo>')` como F6. Soporte: `soporteDisponible` de F5. El servidor
vuelve a exigir todo.

## IA.11 Notas para QA (≤ 10)

1. `ia.disponible=false`: el DOM del panel no contiene «IA», ni la autorización, ni la línea de privacidad, ni el
   cupo; las preguntas usan F3 como hoy (AC10).
2. Primera apertura con IA disponible y sin autorización: vista «Antes de usar la IA» con el texto del GET; Esc =
   Ahora no; foco al `h3`; tras Ahora no, aviso B en el pie y ninguna llamada a `/chat` (interceptada).
3. Aceptar envía `{ finalidad: "ia", version: "2026-11-v1" }` (la mostrada); POST 500 → aviso + Reintentar; 400
   `version-no-vigente` → texto recargado tras Reintentar; en ningún caso aparece el mensaje del API.
4. Pregunta con IA: «Dr. Flit está pensando…» anunciado; doble Enter/clic = una sola petición; respuesta con ≤ 3 citas,
   `href` con `#ancla` o sin ella si `anclaExiste` falla; un `<a>` o `**` dentro de `reply` se ve como texto.
5. `[PLACA_1]` en `reply` con «ABC123» en el mensaje: se ve «ABC123»; tras recargar, «(placa oculta)»;
   `sessionStorage` no contiene «ABC123» ni el mapa.
6. Degradados `ia-timeout`, `ia-error`, `respuesta-invalida`, red abortada y 429: respuesta F3 (y oferta F6 si hay
   placa) sin ningún aviso; ninguna palabra «degradado»/«error».
7. `cupo-agotado`: aviso A con el literal de AC8, no toast; la siguiente pregunta no llama a `/chat`. Con
   `restantes` 3: «Le quedan 3 preguntas con IA hoy.»; con 6: no hay línea de cupo.
8. 428: respuesta F3 + aviso C; «Revisar y aceptar» abre la vista con el texto nuevo.
9. IA-6: `soporte` → «Necesito soporte» abre F5; `gestion` + `[PLACA_2]` → oferta de «XYZ789» sin `POST …/buscar`
   hasta el clic; `gestionRef` null con dos placas → dos botones; sin valor → copy fijo; `cliente` → enlaces sin
   query solo a los módulos visibles. Los resultados de F6 no aparecen en el `historial` de la siguiente petición.
10. 360 × 740 y lg, claro y oscuro: pie sin desborde con privacidad + cupo + contador; foco visible en Aceptar, Ahora
    no, enlaces de aviso y botones de la oferta; ningún toast en todo el flujo.

## IA.12 Decisiones y descartes

| Decisión | Por qué | Descartado |
|---|---|---|
| Autorización = vista de F5 con `finalidad="ia"` | AC: un solo componente; mismo lenguaje que el usuario ya vio | Modal o banner con el texto legal; casilla «He leído» |
| Privacidad en una línea bajo la caja | IA-3: saber qué se oculta donde se escribe; frase neutra, sin «advertencia» ni icono | Solo en el texto legal (se olvida); banner de alerta (alarma); repetirla en cada respuesta |
| Valor restaurado como texto normal | Es el dato del propio usuario; resaltarlo lo vuelve llamativo | Chip, subrayado o corchetes visibles |
| «(placa oculta)» si no hay mapa | Legible y honesto tras recargar; nunca un token crudo | Mostrar `[PLACA_1]`; borrar la palabra (frase rota) |
| Cupo solo con ≤ 5 restantes | «Visible sin ruido»: el número importa cuando se acaba | Contador permanente «12/30»; barra de progreso |
| Degradación silenciosa (incluido 429) | AC7: el usuario recibe respuesta y no ve error; el 429 es transitorio | Aviso «La IA no respondió»; toast |
| Marca «Respondido con IA» solo en `duda` | Transparencia y empuje a la fuente, una línea | Icono/chip de IA; marca también en preguntas de seguimiento |
| «Necesito soporte» y «id FLIT» | Un nombre por flujo y por término (F5, F6) | Literales de AC «Contactar a soporte», «radicado» |
| Varios valores: botones secundarios iguales | Elección entre pares, ninguno pesa más; consultar exige clic (IA-6 AC4) | Una primaria por valor (varias primarias); consultar todos a la vez |
| Sin animación de «pensando», sin avatar animado | Principios; F3 ya lo decidió | Puntos animados, efecto de máquina de escribir |

## IA.13 Oficio (respuestas)

| Pregunta | Respuesta |
|---|---|
| ¿Qué vino a hacer? | Preguntar en sus palabras y salir con la respuesta y la sección que la respalda |
| ¿Qué se ve primero / qué se calla? | La respuesta y sus fuentes. Se callan motivos técnicos, tokens, contador con cupo holgado y toda mención a la IA si está apagada |
| ¿Única primaria? | Enviar (panel); Aceptar (autorización); la de F6 en la oferta de un valor |
| ¿Vacío y error con siguiente paso? | Vacío = saludo de F3; error solo si F3 también falla, con Reintentar; sin manuales → Ayuda o soporte; límite → sigue con la búsqueda y dice cuándo se renueva |
| ¿Efectos o patrón nuevo? | Ninguno. Lo único «nuevo» es la oferta de varios valores, armada con botones del kit |
| ¿Móvil? | IA.7: líneas y avisos envuelven, botones a ancho completo, autorización con scroll del cuerpo |
| ¿Feedback? | IA.7: todos los controles con hover y foco; avisos y marcas no lo aparentan |
| ¿Notificación? | Sin toasts: avisos persistentes en el pie para estados; anuncio del `log` para aceptar |
