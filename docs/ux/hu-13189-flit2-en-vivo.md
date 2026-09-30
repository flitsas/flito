# UX slim: lectura de FLIT 2 en vivo, sin el botón «Sincronizar FLIT 2» (HU #13189)

Feature #13060 · Épica #12736. Público: operador interno (administradores) en Gestión Trámites.
Módulo `flito-sync` (`GET /api/flito/sync/flit2/estado`), no el legacy `tramites`.
HU backend hermana: #13188, que añade `automatica` al contrato del estado.
Base: `docs/ux/hu-13098-estado-conexion-flit2.md`. Este doc es el **delta** sobre ella; lo que no
se nombra aquí no cambia (4 estados de la línea, tarjeta de aviso, frases de `fraseProblema`,
PII, permisos, 403).

> Los AC salen del prompt del hilo (refinamiento del tech-lead). Si el Gherkin de ADO dice otra
> cosa, manda el AC y hay que avisar al ux-agent.

Contrato que usa esta spec (HU #13188), dentro de `Flit2EstadoConexion`:

```ts
automatica: {
  activa: boolean;
  intervaloMs: number | null;   // null si activa=false
  proximaEn: string | null;     // ISO; null si activa=false; puede quedar unos ms en el pasado
  enCurso: boolean;
  generadoEn: string;           // ISO, reloj del servidor al responder
}
```

---

## Superficie tocada

1. **Cabecera de Gestión Trámites, grupo FLIT 2** (`FlitoTramites.tsx` líneas ~412-415): sale
   `<SincronizarFlit2 …/>`. El grupo queda solo con `<LineaEstadoFlit2 />`, que gana una
   **tercera línea**: el indicador en vivo (punto + texto).
2. **`EstadoFlit2.tsx`:**
   - la línea de cabecera suma el indicador;
   - el hook suma el reloj de la cuenta y el refresco rápido de AC4;
   - la tarjeta de aviso cambia **una** frase: la de «alerta sin problema», que hoy manda a pulsar
     un botón que deja de existir.
3. **`AccesoFlit2.tsx`:** cambia el toast de «guardado» (dos variantes, abajo). La página le pasa
   dos props nuevas: `automaticaActiva` (del estado) y `onGuardado={estadoFlit2.refrescar}`.
4. **Se elimina** `SincronizarFlit2.tsx` y su import. El grupo de FLIT 1 («Última actualización»,
   «Elegir fecha», **Sincronizar FLIT**) no cambia.
5. **Ficha de ayuda** `flito_tramites.md`: delta al final.

### Wireframe (≥ lg)

```
┌ Gestión Trámites ──────────────────────────────────────────────────────────────────────────────┐
│ Centro de gestión…                                                                             │
│  Última actualización  [☐ Elegir fecha] [ Sincronizar FLIT ]   Última lectura FLIT 2           │
│  29 sep. 2026, 9:10                                            30 sep. 2026, 9:40              │
│                                                                ● Lectura automática cada 5 min │
│                                                                  · próxima en 3:12             │
│                                                      ( + Trámite demo ) ( Acceso a FLIT 2 )    │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
[ tarjeta de aviso FLIT 2: solo si hay algo que contar (sin cambios salvo la frase de AC7) ]
[ tabla de la cola, sin cambios ]
```

---

## Delta de claridad (qué se ve / qué se calla)

**Qué vino a hacer:** trabajar la cola. De FLIT 2 solo necesita saber, de un vistazo, que FLITO la
está leyendo sola y cuándo vuelve a leer. Si no está leyendo, por qué y qué hacer. Ya no hay nada
que *pulsar*: esto es una señal de estado, no una acción.

**Qué ocupa el lugar del botón:** nada con peso de control. El bloque de texto «Última lectura
FLIT 2» gana una tercera línea, el indicador. El hueco del botón se cierra y la cabecera queda **más
liviana** que hoy: pierde un secundario que competía con «Sincronizar FLIT».

| Línea | Contenido | Estilo |
|---|---|---|
| 1 | «Última lectura FLIT 2» (sin cambio) | 11 px, `--flit-text-muted` |
| 2 | Fecha y hora de la **última lectura exitosa**, + «· lectura atrasada» si aplica (sin cambio) | 11 px semibold, `--flit-text-secondary` |
| 3 (nueva) | Punto de estado + frase del indicador (tabla siguiente) | 11 px, `--flit-text-secondary`; punto `h-2 w-2 rounded-full`, color por token; la cuenta `m:ss` con `tabular-nums whitespace-nowrap` para que no baile |

- **Qué se calla:** `intervaloMs` en crudo, `generadoEn`, la hora absoluta de `proximaEn` en la vista
  (solo en el texto para lector de pantalla), segundos de deriva, códigos.
- **Densidad:** aliviada. Sale un botón y entran ~40 caracteres de texto de 11 px en un bloque que ya
  existía.
- **Primaria:** no cambia, sigue siendo **Sincronizar FLIT** (FLIT 1). El grupo de FLIT 2 no tiene
  controles, salvo **[Reintentar]** en el estado de error, que ya existía.
- **Una sola altura de control:** en la barra solo quedan los botones `h-10` del kit (Sincronizar
  FLIT, + Trámite demo, Acceso a FLIT 2). El bloque de FLIT 2 es texto, centrado verticalmente
  (`items-center`). Tres líneas de 11 px ocupan ~40 px, lo mismo que un botón, así que la fila no
  crece.
- **Sin animación.** El punto no pulsa ni parpadea. La cuenta cambia el número cada segundo y nada
  más: sin transición ni fundido. El `animate-pulse` del esqueleto de carga se queda, porque ya es el
  patrón del kit para cargar y no es un indicador en vivo.

---

## Estados (4) + copy — tabla de textos exactos

Tono: **tú**, como el resto de la pantalla. `{m:ss}` es la cuenta visible. `{hora}` es una hora de
Bogotá con el formateo ya existente (`aLas`/`momento`).

**Cuenta:** `restante = proximaEn − ahoraServidor`, con `ahoraServidor = Date.now() + (generadoEn −
horaLocalAlRecibir)`. Así se corrige el reloj del equipo (AC2). Si `restante ≤ 0` se muestra
**«en unos segundos»** en lugar de `m:ss`, sin negativos ni «0:00» congelado. Ejemplo: «próxima en
unos segundos». Ese mismo texto cubre la deriva de unos ms del `setInterval`.

Precedencia de la línea 3, de arriba abajo; gana la primera que aplique:

| # | Estado | Condición | Punto (token) | Línea 3 visible | `role="status"` (sr-only, sin cuenta) |
|---|---|---|---|---|---|
| — | **Cargando** | primer GET | sin punto | Segunda barra de esqueleto `h-3 w-32` bajo la de la línea 2, `aria-hidden`. El bloque lleva `aria-busy="true"` (ya existe). | vacío |
| — | **Error** | primer GET o [Reintentar] falla | sin punto | No hay línea 3. La línea 2 sigue siendo «No se pudo consultar **[Reintentar]**» (sin cambio). | vacío |
| — | **Sin configurar** | `configurado: false` | **sin punto** | No hay línea 3. La línea 2 sigue siendo «Sin configurar» y la tarjeta da el siguiente paso (sin cambio). | vacío |
| 1 | **En curso** | `automatica.enCurso` | `--flit-blue-text` | «Leyendo FLIT 2 ahora…» | «Leyendo FLIT 2 ahora.» |
| 2 | **Apagada** | `!automatica.activa` | `--flit-text-muted` | «La lectura automática está apagada en este ambiente» | «La lectura automática de FLIT 2 está apagada en este ambiente.» |
| 3 | **Rechazado** | `problema.tipo === 'rechazado'` | `--flit-danger-text` | «Acceso rechazado · revisa **Acceso a FLIT 2**» (sin cuenta) | «FLIT 2 rechazó el acceso guardado.» |
| 4 | **Bloqueado** (con `hasta` futuro) | `problema.tipo === 'bloqueado'` | `--flit-warning-text` | «Acceso bloqueado · vuelve a leer después de las {hora}» (sin cuenta: manda el `hasta`) | «FLIT 2 bloqueó el acceso por un tiempo.» |
| 4b | **Bloqueado** (`hasta` pasado o nulo) | idem | `--flit-warning-text` | «Acceso bloqueado · reintenta en {m:ss}» | idem |
| 5 | **Falló por lectura** | `problema.tipo === 'lectura'` | `--flit-warning-text` | «Falló la última lectura · reintenta en {m:ss}» | «La última lectura de FLIT 2 falló.» |
| 6 | **Alerta sin problema** | `alerta` sin `problema` | `--flit-danger-text` | «Sin leer hace más de 30 min · reintenta en {m:ss}» | «FLIT 2 lleva más de 30 minutos sin leer.» |
| 7 | **Encendida** (incluye atrasada sin alerta) | resto | `--flit-success-text` | «Lectura automática cada 5 min · próxima en {m:ss}» | «Lectura automática de FLIT 2 encendida.» |

Notas de la tabla:

- **«cada 5 min»** sale de `intervaloMs` (`Math.round(intervaloMs / 60000)`). Si no da un entero
  ≥ 1, se omite el tramo («Lectura automática · próxima en {m:ss}»).
- **Atrasada** (sin alerta): la línea 2 conserva «· lectura atrasada» y la línea 3 es la del estado
  7. «Próxima en» es justo el «sigue donde quedó». No lleva otro color: atrasada es normal.
- **Rechazado:** la línea 3 no lleva cuenta (AC6), porque esperar no lo arregla. «Acceso a FLIT 2» va
  en `<strong>` (texto, no enlace: el botón está a la derecha en la misma barra).
- **«reintenta en»** va en minúscula tras «·», y su sujeto es la lectura, no el usuario. Si el PO
  prefiere evitar que se lea como imperativo, la alternativa es «nuevo intento en {m:ss}». Esto es
  Nota, no bloquea: el AC dice «Reintenta en m:ss».
- **Lleno sin ninguna lectura exitosa:** la línea 2 sigue siendo «Aún sin lecturas» y la línea 3 la
  que toque (normalmente 7 o 1).
- **Refresco silencioso fallido:** se conservan las tres líneas y la cuenta sigue corriendo contra el
  último `proximaEn`. Al llegar a 0 muestra «en unos segundos» hasta que un refresco traiga dato
  nuevo (AC8). No se pinta error.

### Tarjeta de aviso: una frase cambia (AC7)

Fila «prioridad 2 · `alerta` sin `problema`» de la spec #13098. Hoy dice «Pulsa **Sincronizar FLIT
2**…», que deja de ser posible. Pasa a decir:

| Condición | Cuerpo nuevo |
|---|---|
| `alerta`, sin `problema`, `automatica.activa` | «La lectura automática vuelve a intentarlo en <span aria-hidden>{m:ss}</span><span class="sr-only">unos minutos</span>; si no lee, revisa **Acceso a FLIT 2**.» (con `restante ≤ 0`: «…vuelve a intentarlo en unos segundos; …», igual para los dos) |
| `alerta`, sin `problema`, `!automatica.activa` | «La lectura automática está apagada en este ambiente. Avísale a quien administra el ambiente.» |

Todo lo demás de la tarjeta queda igual: título de 30 minutos, línea de fecha, frases de
`fraseProblema`, párrafo PII, `role="alert"`/`"status"` y `key` estable. Las frases de
`fraseProblema` **no** llevan cuenta, porque ya está en la línea 3 de la cabecera. Así no se repite
el mismo reloj en dos sitios.

---

## Refresco (AC4)

| Momento | Qué pasa |
|---|---|
| Base | Polling silencioso cada 2 min con la pestaña visible (sin cambio). |
| La cuenta llega a 0 | Un GET silencioso **~10 s después**. |
| Respuesta con `enCurso: true` | GET silencioso **cada 15 s** hasta que `enCurso` sea `false`. Luego se vuelve al ciclo de 2 min. |
| Tras guardar un acceso válido | `onGuardado` hace un GET silencioso. El ciclo de 15 s se encarga si la primera lectura arranca. |
| Pestaña oculta | Se pausan el polling **y** el tic de 1 s. Al volver hay un GET inmediato (sin cambio). |
| Sin `sync.sync.ver_estado` / 403 | Ni GET, ni tic, ni línea (sin cambio). |

Tic de 1 s: solo existe si la línea visible lleva `{m:ss}` (estados 4b, 5, 6, 7 y la frase de AC7).
En curso, apagada, rechazado y bloqueado con `hasta` no hay tic.

---

## Accesibilidad (AC9)

Estructura de la línea 3:

```html
<div data-testid="indicador-flit2">
  <span aria-hidden="true" class="inline-block h-2 w-2 rounded-full" style="background: var(--flit-…)"></span>
  <span aria-hidden="true">Lectura automática cada 5 min · próxima en <span class="tabular-nums whitespace-nowrap">3:12</span></span>
  <span role="status" class="sr-only">Lectura automática de FLIT 2 encendida.</span>
  <span class="sr-only">Próxima lectura a las 9:45.</span>   <!-- NO es región viva -->
</div>
```

- **`role="status"` solo lleva la frase de estado** de la última columna de la tabla. Cambia cuando
  cambia el estado (encendida → en curso → encendida, → falló…), y ahí se anuncia. No cambia con la
  cuenta ni con cada ciclo de 5 min.
- **La cuenta nunca se anuncia:** la línea visible entera es `aria-hidden`. La información equivalente
  para el lector va en un `sr-only` **fuera** de la región viva, con la hora absoluta («Próxima lectura
  a las {hora}.» o «Nuevo intento a las {hora}.»). Se lee al recorrer la página, pero no se anuncia.
  Si `restante ≤ 0`: «Próxima lectura en unos segundos.»
- **Primer render:** la región viva nace ya con su texto, sin anuncio de carga. Durante el esqueleto
  va vacía.
- **El punto nunca es la única señal:** va `aria-hidden` y cada estado tiene su frase distinta. Un
  daltónico lee la frase, no el color.
- **Contraste:**
  - La frase va en `--flit-text-secondary` (texto ≥ 4.5:1).
  - Los puntos (gráfico, ≥ 3:1) usan tokens `-text`, que tienen par oscuro: `--flit-success-text`,
    `--flit-warning-text`, `--flit-danger-text`, `--flit-blue-text` y `--flit-text-muted`. **No**
    `-ink`, que no tiene par oscuro legible, ni `--flit-success`/`-warning` base, ni HEX.
  - Hay que verificar los dos temas, sobre todo `--flit-success-text` claro (#3C7C17) sobre el fondo
    de la cabecera.
- **Tarjeta con AC7:** el `{m:ss}` va en `aria-hidden` y el sr-only dice «unos minutos». Así el texto
  accesible de la tarjeta (`role="alert"`) no cambia cada segundo y no se re-anuncia. El implementador
  lo comprueba en el árbol de accesibilidad, no solo en el DOM.

---

## Confirmación al guardar el acceso (AC10)

Es un toast, porque es el resultado de una acción puntual. Mismo `toastOk` e `id`
`flit2-acceso-guardado`, cerrable, **~6 s**: con dos frases, 4 s no alcanzan para leerlo. La
variante la decide la prop `automaticaActiva`, que la página saca de `estadoFlit2`:

| `automaticaActiva` | Texto |
|---|---|
| `true` | «Acceso guardado. La primera lectura empieza en unos segundos; el resultado se ve en el panel de Gestión Trámites.» (texto de David) |
| `false` | «Acceso guardado. La lectura automática está apagada en este ambiente, así que FLITO no leerá FLIT 2 hasta que quien administra el ambiente la encienda.» |
| `null` (sin `sync.sync.ver_estado` o estado aún sin cargar/en error) | «Acceso a FLIT 2 guardado.» (el actual: no promete lo que no sabe) |

- **Supuesto R1 (frontend, antes de pintar):** la variante `true` promete una lectura «en unos
  segundos». Eso exige que la HU #13188 dispare una lectura al guardar el acceso, o que el
  programador la adelante. Si no la dispara, la variante `true` pasa a «Acceso guardado. FLITO lo
  usa en la próxima lectura automática, en menos de 5 minutos; el resultado se ve en el panel de
  Gestión Trámites.», y hay que avisarlo al PO porque cambia su texto.
- El error al guardar sigue en línea dentro del panel (sin cambio). No hay toast de error.

---

## Responsive + feedback del delta

- **< lg:** la barra de acciones ya envuelve (`flex-wrap gap-3`). El grupo FLIT 2 queda con un solo
  hijo, el bloque de texto, y baja como una pieza. La línea 3 puede partir en dos («· próxima en 3:12»
  baja), porque no lleva `min-w` ni `whitespace-nowrap` salvo en el `m:ss`. Por debajo de `sm`, el
  texto se alinea a la izquierda (`text-left sm:text-right`, ya existe) y el punto va delante de la
  frase en los dos anchos. A 360 px no desborda: la frase más larga es la de apagada, ~50 caracteres
  que envuelven.
- **Feedback:** el delta no trae controles nuevos. Sale un botón. [Reintentar] conserva su hover y
  foco. El indicador **no** es clicable, así que no lleva hover ni cursor de mano, y «Acceso a FLIT
  2» dentro de la línea 3 va en `<strong>`, no como enlace falso.
- **Notificación:**
  - estado → línea de cabecera + tarjeta de aviso (página, nunca toast);
  - guardar acceso → toast cerrable.
  - Desaparece el toast de «Sincronizar FLIT 2» (HU #13096) con el botón.

---

## Permiso/slug

- No hay página ni slug nuevos: la ruta y el `PageSlug` de Gestión Trámites no cambian.
- Línea, indicador, tick y polling solo con `hasFuncion('sync.sync.ver_estado')` (sin cambio).
- Se deja de usar la función del botón manual (la de `SincronizarFlit2`). **No** se retira del
  catálogo en esta HU: sería una migración y pertenece a la #13188 o a otra aparte. Si el backend
  retira el endpoint, eso lo decide su HU.
- La prop `automaticaActiva` de `AccesoFlit2` es `null` cuando falta `ver_estado`. El panel sigue
  con su propio permiso.

---

## Delta de la ficha de ayuda (`apps/web/src/content/ayuda/flito_tramites.md`, en **usted**)

1. Quitar toda mención del botón **Sincronizar FLIT 2**, tanto en los pasos como en «Error» (la frase
   «Si falla **Sincronizar FLIT 2**, un aviso breve…»).
2. En Pasos, donde hoy se explica FLIT 2:
   > FLITO lee FLIT 2 solo, cada 5 minutos. Junto a **Última lectura FLIT 2** verá la hora de la última lectura que salió bien y, debajo, cuándo es la próxima («próxima en 3:12») o «Leyendo FLIT 2 ahora…» mientras lee. Si dice **lectura atrasada**, quedan trámites por leer y la siguiente lectura sigue donde quedó. Si la lectura automática está apagada en este ambiente, lo dice ahí mismo.
3. En Estados, el ítem del aviso de FLIT 2 se conserva y se añade:
   > Si una lectura falla, la línea dice cuándo se reintenta; si FLIT 2 rechazó el acceso, revíselo en **Acceso a FLIT 2**.

---

## Notas para QA (≤10)

1. No existe el botón «Sincronizar FLIT 2» en el DOM, con ningún permiso. «Sincronizar FLIT» y su
   grupo están igual, y «Última lectura FLIT 2» muestra la última lectura exitosa.
2. Encendida: «Lectura automática cada 5 min · próxima en m:ss». La cuenta baja cada segundo. Con el
   reloj del equipo adelantado 10 min, la cuenta es la misma (corrección con `generadoEn`). Con
   `proximaEn` unos ms en el pasado muestra «en unos segundos», nunca negativo.
3. `enCurso: true` → «Leyendo FLIT 2 ahora…» y un GET cada ~15 s. Con `enCurso: false` vuelve la
   cuenta. Al llegar a 0 sale un GET ~10 s después.
4. `activa: false` → texto de apagada, sin cuenta y sin tic. Con `alerta` además, la tarjeta dice
   «…está apagada en este ambiente. Avísale a quien administra el ambiente.»
5. Problema de lectura → «Falló la última lectura · reintenta en m:ss» + frase mapeada en la tarjeta.
   Bloqueado con `hasta` futuro → «vuelve a leer después de las {hora}». Rechazado → remite a Acceso
   a FLIT 2, **sin** cuenta.
6. `alerta` sin problema → la tarjeta dice «La lectura automática vuelve a intentarlo en m:ss; si no
   lee, revisa Acceso a FLIT 2.» Ya no aparece «Pulsa Sincronizar FLIT 2».
7. Cuatro estados: esqueleto de dos barras; error + [Reintentar]; sin configurar **sin punto ni
   cuenta**; lleno. Un refresco silencioso que falla conserva las tres líneas.
8. A11y:
   - el `m:ss` no está dentro de ningún `role="status"`/`"alert"` ni en el texto accesible;
   - la región viva solo cambia al cambiar de estado (se comprueba con la cuenta corriendo: sin
     anuncios);
   - el punto es `aria-hidden`;
   - hay que revisar contraste en claro y oscuro.
9. Al guardar un acceso válido, el toast dice el texto de la variante según `automatica.activa`
   (encendida / apagada / sin permiso de estado) y sale un GET de estado. El error de guardado sigue
   en línea.
10. A 360 px la cabecera envuelve sin desbordar y la línea 3 parte en dos. Hay que revisarlo en tema
    claro y oscuro, y comprobar el delta de la ficha (`flit-ayuda-flito`) y el E2E del spec de
    trámites.

---

## Oficio

| Pregunta | Respuesta |
|---|---|
| ¿Qué vino a hacer? | Trabajar la cola, sabiendo que FLIT 2 se lee sola y cuándo vuelve a leer. |
| ¿Qué se ve primero y qué se calla? | Primero, la última lectura exitosa y, debajo, el indicador (punto + frase + cuenta). Se callan `intervaloMs`, `generadoEn`, la deriva y los códigos. |
| ¿Primaria única? | Sigue siendo «Sincronizar FLIT». El grupo FLIT 2 ya no tiene botón. |
| ¿Vacío y error con siguiente paso? | Sin configurar remite a Acceso a FLIT 2 o a un administrador (tarjeta). El error de consulta tiene [Reintentar]. Rechazado remite a Acceso a FLIT 2. Apagada remite a quien administra el ambiente. |
| ¿Efectos o patrón nuevo? | Ninguno. El punto es estático, sin pulso ni transición. Es texto de 11 px en el bloque que ya existía. |
| ¿Móvil? | El bloque envuelve como una pieza, la línea 3 parte en dos y el texto va a la izquierda bajo `sm`. |
| ¿Feedback? | No hay controles nuevos. [Reintentar] conserva hover y foco. El indicador no es clicable. |
| ¿Notificación? | El estado va en la página (línea + tarjeta). Guardar el acceso da un toast cerrable con dos variantes, más una neutra. |

## Decisiones y descartes

- **Nada ocupa el hueco del botón:** poner un chip o un botón «Actualizar» devolvería el control que
  David quitó. El texto basta, porque la acción ya no es del usuario.
- **La cuenta vive en la cabecera, no en la tarjeta:** un solo reloj visible. La única excepción es la
  frase de AC7, que el AC pide literal y que sustituye a la frase que nombraba el botón.
- **Color solo en el punto:** la frase sigue en `--flit-text-secondary`. Teñir el texto de verde o
  ámbar competiría con la cola y bajaría el contraste en oscuro.
- **Sin pulso ni «latido» en el punto:** decisión de David y de los principios.
- **La hora absoluta, solo para el lector de pantalla:** la cuenta es más útil a la vista y la hora
  fija es más útil al oído, porque no caduca mientras se escucha.
