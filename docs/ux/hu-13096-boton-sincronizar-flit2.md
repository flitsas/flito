# UX slim: botón «Sincronizar FLIT 2» en Gestión Trámites (HU #13096)

Feature #13059 · Épica #12736. Público: administradores y Operaciones, en una pantalla interna de
operador. Módulo: `flito-sync`, con la ruta `POST /api/flito/sync/flit2/sincronizar`. No es el legacy
`tramites`.
Contrato: `Flit2LecturaResultado` (`packages/shared-types/src/flito-flit2.ts`). Los errores están en
`apps/api/src/modules/flito-sync/flit2.errors.ts` y el diseño en
`docs/diseno/hu-13091-lectura-incremental-flit2.md` y `hu-13092-lectura-programada-flit2.md`.
Análogas: el botón «Sincronizar FLIT» de `FlitoTramites.tsx` y el panel «Acceso a FLIT 2»
(`docs/ux/hu-13064-13069-acceso-flit2.md`).

> **Los AC no se leyeron de ADO.** Este agente no tiene MCP `ado` ni shell para `az`. La spec se
> basa en el contrato del prompt, contrastado con el código del worktree. Antes de implementar, el
> hilo debe comparar los AC Gherkin con las tablas de abajo. Si algún AC pide algo distinto, por
> ejemplo mostrar los totales en un aviso de página en vez de un toast, manda el AC y hay que
> avisar al ux-agent.

---

## Superficie tocada

- `FlitoTramites.tsx`, en las acciones del `PageHeaderCard`: se monta **un** botón nuevo y se le pasa
  `onTerminado={refrescar}`. Nada más, porque la página tiene el techo de líneas congelado.
- Componente nuevo: `components/flito/tramites/SincronizarFlit2.tsx`, hermano de `AccesoFlit2.tsx`.
  Contiene el botón, la llamada, el guardia contra el doble clic, el mapeo de las respuestas a copy y
  los toasts. La página no lleva lógica de FLIT 2.

### Dónde va y jerarquía (decisión)

```
Cabecera · acciones (≥ lg, una sola fila si cabe)
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Última actualización   [☐ Elegir fecha]  [ Sincronizar FLIT ]  ( Sincronizar FLIT 2 )        │
│ 29 sep. 2026, 9:10                                  primaria         secundaria              │
│                                           ( + Trámite demo )  ( Acceso a FLIT 2 )            │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

- «Sincronizar FLIT» **sigue siendo la única primaria** (`flitBtnPrimary`), y «Sincronizar FLIT 2» va
  como **secundaria** (`flitBtnSecondary`) justo a su derecha. Queda antes de «+ Trámite demo» y de
  «Acceso a FLIT 2».
  - Motivo: hoy casi todo el volumen de la cola llega de FLIT, y FLIT 2 tiene su lectura automática
    cada 5 minutos, así que el botón de FLIT 2 es para forzar una lectura, no el gesto diario.
    Tampoco puede haber dos primarias en la cabecera.
  - Al estar pegados, se lee que son hermanos. El «2» en el rótulo basta para distinguirlos.
- **Sin fecha, sin casilla y sin selector.** La lectura continúa donde quedó (`modo` `since` o
  `cursor` lo decide el backend). «Elegir fecha» y «Desde» siguen siendo solo de FLIT 1 y quedan a la
  izquierda de su botón, como hoy.
- Rótulo: **«Sincronizar FLIT 2»**, en paralelo con «Sincronizar FLIT». Tooltip (`title`): «Lee lo
  nuevo de FLIT 2 desde la última lectura».
- Si el PO quiere algún día que FLIT 2 sea el gesto principal, se cambian los pesos entre los dos
  botones y no se añade una segunda primaria. Queda fuera de esta HU.

---

## Delta de claridad (qué se ve / qué se calla)

**Qué vino a hacer:** traer ya los trámites de FLIT 2, sin esperar la lectura automática, y saber
cuántos llegaron.

**Qué se ve primero:** el botón junto al de FLIT 1. Tras pulsarlo, **una frase** con lo que entró.

**Qué se muestra (menos es más):**

| Dato | Se muestra | Por qué |
|---|---|---|
| `nuevos`, `actualizados` | Sí, en la frase | Es lo que cambia la cola. |
| `leidos` | Sí, pero solo como sujeto de la frase cuando es > 0 | Da la escala; sin él «0 nuevos» parece un fallo. |
| `companiasFaltantes + organismosSinEmparejar` | Solo si la suma es > 0, en una segunda frase | Es la única cifra que pide acción al operador: crear la empresa o emparejar la secretaría. Se suma porque el paso siguiente es el mismo, revisar la fila. |
| `sinCambios`, `conflictos`, `sinVehiculo`, `eliminadosIgnorados`, `invalidos`, `paginas`, `modo`, `ejecutadoEn` | **No** | Son telemetría de la lectura. No responden a esta visita y el operador no puede actuar sobre ellos desde aquí. Quedan en la auditoría y en la fila de lectura. |

**Densidad:** la cabecera suma un botón secundario y la tabla no cambia. **No** se añade la tarjeta
de resumen que usa FLIT 1 (`resumenSync`): el resultado va en un toast (ver Notificaciones).

**«Última actualización»** sigue siendo la de FLIT 1. Esta HU no añade la hora de FLIT 2, porque el
contrato no la trae en un GET y pintarla exigiría un endpoint nuevo. Ver Decisiones.

---

## Estados (4) + copy

Tono: **tú**, igual que en la pantalla («sincroniza» en el subtítulo) y en el panel Acceso a FLIT 2.
El nombre del producto es FLITO. FLIT y FLIT 2 son los sistemas de origen.

| Estado | Qué se ve |
|---|---|
| **Cargando** (puede durar ~60 s) | El botón cambia a «Sincronizando FLIT 2…», con `disabled` y `aria-busy="true"`, y mantiene su ancho. No se pone esqueleto en la tabla ni overlay, y la cola se puede seguir usando. Hay un guardia `useRef` contra el doble clic, porque dos clics en el mismo tick salen antes del repintado (patrón de `usePruebaConexion`). «Sincronizar FLIT» **no** se deshabilita: son fuentes y candados distintos. |
| **Lleno** (200, `leidos > 0`, `hasMore=false`) | Toast de éxito: «FLIT 2: {leidos} trámites leídos, {nuevos} nuevos y {actualizados} actualizados.» Si hay faltantes, se añade: «{n} quedaron sin empresa o sin secretaría: revísalos en la cola.» Después se llama a `onTerminado()` para refrescar la cola. |
| **Lleno parcial** (200, `hasMore=true`) | Toast de éxito con la segunda frase fija: «FLIT 2: {leidos} trámites leídos, {nuevos} nuevos y {actualizados} actualizados. Quedan más: la lectura automática sigue donde quedó.» Si hay faltantes, la frase de faltantes va antes de «Quedan más». Luego se llama a `onTerminado()`. |
| **Vacío** (200, `leidos = 0`) | Toast de éxito: «FLIT 2 no tiene trámites nuevos ni con cambios desde la última lectura.» No hace falta refrescar la cola, aunque hacerlo no hace daño. |
| **Error** | Toast de error con copy propio por código (tabla siguiente). **Nunca** se pinta `error` ni `e.message` del API, ni el código, ni el `status`. No se usa la tarjeta `error` de la página, que es la de la carga de la cola: si se escribiera ahí, un fallo de FLIT 2 parecería un fallo del listado. |

Plural: con 1, «1 trámite leído», «1 nuevo» y «1 actualizado». Con 0 en `nuevos` o `actualizados` se
escribe el cero («0 nuevos»), porque es la respuesta a «¿llegó algo?».

### Errores → copy

La ramificación se hace con `status` y con `rawDetails.codigo` (el mismo helper `codigoDeError` de
`AccesoFlit2.tsx`; muévelo a un util compartido de `flito/tramites/` o duplícalo en 3 líneas). Si el
cuerpo trae `parcial`, se **antepone** «Se alcanzaron a leer {parcial.leidos} trámites ({nuevos}
nuevos). » y se llama a `onTerminado()`.

| Respuesta | Toast | Copy | [Reintentar] en el toast |
|---|---|---|---|
| 409 `lectura_concurrente` | error | «Ya hay una lectura de FLIT 2 en marcha. Espera a que termine y actualiza la cola.» | No: reintentar choca otra vez. |
| 429 (limitador, 6/min) | error | «Ya sincronizaste FLIT 2 varias veces en el último minuto. Espera un minuto.» | No |
| 503 `no_configurado` | error | «FLIT 2 no está configurado en este ambiente. Avísale a quien administra el servidor.» | No |
| 503 `sin_acceso` | error | «FLITO no tiene acceso a FLIT 2. Configúralo en Acceso a FLIT 2.» | No |
| 503 `rechazado` | error | «FLIT 2 rechazó el acceso guardado. Revísalo en Acceso a FLIT 2.» | No |
| 503 `bloqueado` | error | «FLIT 2 bloqueó el acceso por intentos fallidos. Prueba de nuevo en unos minutos.» | No |
| 503 `espera` (sin `parcial`) | error | «FLIT 2 pidió esperar antes de seguir. La lectura automática continúa donde quedó.» | No |
| 503 `espera` con `parcial` | **éxito** | «Se alcanzaron a leer {leidos} trámites ({nuevos} nuevos). FLIT 2 pidió esperar: la lectura automática sigue donde quedó.» | — |
| 503 `no_responde` | error | «FLIT 2 no responde. Puede ser una caída momentánea: vuelve a intentarlo en unos minutos.» | **Sí** |
| 503 `llave_maestra` / `acceso_descifrado` | error | «El servidor no puede leer el acceso a FLIT 2. Revísalo en Acceso a FLIT 2 o avísale a quien administra el ambiente.» | No |
| 502 `flit2_respuesta` | error | «FLIT 2 respondió de forma inesperada. Vuelve a intentarlo; si se repite, avísale a soporte.» | **Sí** |
| Otro (red, 500, timeout del cliente) | error | «No se pudo sincronizar FLIT 2. Vuelve a intentarlo.» | **Sí** |

Notas sobre los errores:

- **Hora del bloqueo:** el cuerpo del 503 no trae `bloqueadoHasta` (la ruta solo responde
  `{ error, codigo, parcial? }`), así que el copy dice «en unos minutos» y no una hora. Si el PO
  quiere la hora exacta, el backend tendría que añadirla al cuerpo. Es un requerimiento aparte y no
  bloquea esta HU.
- **Cambio de contraseña:** el `rechazado` del botón tampoco distingue «usuario o contraseña» de
  «exige cambio de contraseña». Por eso el copy manda a «Acceso a FLIT 2», donde «Probar conexión»
  sí los distingue.
- **Espera con parcial:** un `503 espera` con `parcial` usa toast de **éxito** porque sí entraron
  trámites. Para quien opera eso es un resultado, no un fallo.
- **Enlace a «Acceso a FLIT 2»:** en el copy es texto, no un enlace. El botón está en la misma
  cabecera, y un enlace dentro de un toast que desaparece es mala affordance.

---

## Responsive + feedback del delta

- **< lg (375 px):** las acciones de la cabecera ya envuelven (`flex-wrap gap-3`), así que el botón
  baja en el flujo justo después de «Sincronizar FLIT». No lleva `min-w`. El rótulo ocupado
  («Sincronizando FLIT 2…») cabe en una línea a 375 px con el padding de `flitBtnSecondary`; si no
  cabe, envuelve la barra, nunca el texto del botón (`whitespace-nowrap`). Usa la misma altura `h-10`
  que el resto de la barra. El toast del kit (`ToastFlito`) ya se ajusta al ancho del móvil.
- **Feedback:**
  - El botón toma el hover de `flitBtnSecondary` (velo `--flit-bg-hover`, `transition-colors`) y el
    foco `flit-focus`.
  - Mientras está `disabled` se distingue (opacidad y cursor del kit) y el hover no reacciona.
  - La ✕ y el [Reintentar] del toast ya traen hover y foco del kit.
- **Foco:** tras el clic el foco **se queda en el botón**. Al terminar, el foco no se mueve a ningún
  sitio. El toast no roba el foco.
- **Anuncio al lector de pantalla:**
  - `aria-busy` y el cambio de texto del botón anuncian el inicio.
  - El resultado lo anuncia el toast, que ya lleva su región viva en `ToastFlito` (el frontend lo
    comprueba: `role="status"` para éxito y `alert` para error). Si no la lleva, se añade en el
    componente del botón una región `role="status"` visualmente oculta con la misma frase. No se
    cambia el kit.
- **Notificación:** es **toast**, porque es el resultado de una acción puntual. Éxito, vacío y
  parcial usan `toastOk` (~4 s, cerrable). Los errores usan `toastError` (10 s, cerrable, con
  [Reintentar] solo donde la tabla lo marca). Hay **un toast por pulsación**. Con `id: 'flit2-sync'`
  una pulsación nueva reemplaza el toast anterior en vez de apilar otro.
- **Tema oscuro:** no hay colores nuevos. El kit del botón y del toast ya tiene su par oscuro.

---

## Permiso/slug

- Página: no hay página nueva. La ruta y el `PageSlug` de Gestión Trámites no cambian.
- El botón existe solo con `hasFuncion('sync.sync.lanzar')`, la misma función que exige el endpoint
  y que usa el «Sincronizar desde FLIT» del Tablero. Va en su propia guarda, **fuera** de
  `esOperaciones` (`tramites.solicitud.pedir_soat`), para que la visibilidad dependa del permiso que
  valida el backend. Si hoy alguien tiene `sync.sync.lanzar` sin `pedir_soat`, verá este botón y no
  el de FLIT 1. Es coherente con el permiso real.
- Sin `sync.sync.lanzar` el botón no se pinta, ni siquiera deshabilitado. Auditoría no lo ve.
- La función ya está sembrada, porque es la del Tablero. No hace falta migración. Si
  `FUNCIONES_POR_ROL` del helper e2e no la tiene para el rol del spec, va al helper, no al spec.

---

## Delta de la ficha de ayuda (`apps/web/src/content/ayuda/flito_tramites.md`)

La ficha va en **usted**, así que el tono de la ayuda no cambia. Cambios:

1. **Pasos, 1:** tras la frase actual se añade:
   > Pulse **Sincronizar FLIT 2** para traer lo nuevo de FLIT 2. No pide fecha: sigue donde quedó la lectura anterior. FLIT 2 también se lee solo cada pocos minutos, así que este botón sirve cuando no quiere esperar. Si hay mucho por leer, trae lo que alcanza en un minuto y el resto llega con la lectura automática. El resultado aparece en un aviso breve con cuántos trámites llegaron nuevos o con cambios.
2. **Estados, Error:** se cambia por:
   > Error: el mensaje en rojo sobre la tarjeta si falla el listado o la sincronización de FLIT. Si falla **Sincronizar FLIT 2**, un aviso breve dice por qué (por ejemplo, que ya hay una lectura en marcha o que FLIT 2 no responde) y, si sirve, ofrece **Reintentar**. Si el aviso habla del acceso, revíselo en **Acceso a FLIT 2**.
3. **Para quién:** no cambia. El Administrador ya «sincroniza». Si el AC nombra otro rol con
   `sync.sync.lanzar`, se añade ahí.

---

## Notas para QA (≤10)

1. Con `sync.sync.lanzar`: «Sincronizar FLIT 2» aparece a la derecha de «Sincronizar FLIT», con peso
   secundario. Hay **una** sola primaria en la cabecera. Sin la función, el botón no está en el DOM.
2. No hay fecha ni casilla asociadas: marcar «Elegir fecha» no cambia la llamada de FLIT 2, que va
   sin cuerpo.
3. El doble clic rápido produce **una** sola petición. Mientras corre, el botón muestra
   «Sincronizando FLIT 2…» con `disabled` y `aria-busy`, y la tabla y «Sincronizar FLIT» siguen
   usables.
4. 200 lleno: el toast muestra leídos, nuevos y actualizados, y la cola se refresca. La frase de
   faltantes solo aparece si la suma es > 0. No aparecen sinCambios, conflictos, inválidos, páginas
   ni modo.
5. 200 con `hasMore=true`: el toast de éxito incluye «Quedan más: la lectura automática sigue donde
   quedó.»
6. 200 con `leidos=0`: sale el copy de vacío y no un «0 trámites leídos, 0 nuevos…».
7. Cada código de la tabla de errores muestra su copy exacto. Nunca aparece el texto del campo
   `error` del API, el código ni el status. Solo `no_responde`, 502 y los genéricos ofrecen
   [Reintentar], y reintentar vuelve a llamar.
8. 503 `espera` con `parcial`: sale un toast de éxito con los totales parciales y la cola se
   refresca. Sin `parcial`, sale un toast de error.
9. Dos pulsaciones seguidas dejan un solo toast visible (reemplazo por `id`). Todos los toasts se
   cierran con ✕.
10. A 375 px la barra envuelve sin desbordar y el botón mantiene `h-10`. El foco se ve en claro y en
    oscuro. Queda por revisar el delta de la ficha de ayuda (`flit-ayuda-flito`).

---

## Oficio

| Pregunta | Respuesta |
|---|---|
| ¿Qué vino a hacer? | Traer ya lo nuevo de FLIT 2 y saber cuánto entró. |
| ¿Qué se ve primero y qué se calla? | El botón junto a FLIT 1 y, al terminar, una frase con leídos, nuevos, actualizados y, si hay, los faltantes. La telemetría (conflictos, inválidos, páginas, modo) se calla y queda en la auditoría. |
| ¿Primaria única? | «Sincronizar FLIT». FLIT 2 es secundaria. |
| ¿Vacío y error con siguiente paso? | Sí. El vacío dice «no hay nada nuevo desde la última lectura». Cada error dice si hay que esperar, reintentar o ir a Acceso a FLIT 2. |
| ¿Efectos o patrón nuevo? | Ninguno: `flitBtnSecondary`, `toastOk` y `toastError` del kit. |
| ¿Móvil? | La barra envuelve, el botón queda con `h-10` y sin `min-w`, y el texto no se parte. |
| ¿Feedback? | Hover y foco del kit, `disabled` y `aria-busy` visibles mientras lee. |
| ¿Notificación? | Toast. Éxito, vacío y parcial usan `toastOk`; los errores, `toastError`, con Reintentar solo donde sirve. |

## Decisiones y descartes

- **Toast y no la tarjeta `resumenSync` de FLIT 1:** los principios mandan un toast para el
  resultado de una acción puntual. La tarjeta de FLIT 1 es deuda preexistente (además pinta
  telemetría como «0 sin cambios»). No se toca en esta HU, pero tampoco se copia.
- **Sin hora de «Última lectura de FLIT 2» en la cabecera:** pintarla exige un GET nuevo y la
  cabecera ya está cargada. Si el PO la quiere, es una pregunta aparte. La etiqueta «Última
  actualización» sigue siendo la de FLIT 1 y **no** se renombra aquí, porque el e2e existente la usa.
  Queda como riesgo de ambigüedad para el PO.
- **Sin deshabilitar FLIT 1 mientras corre FLIT 2:** son fuentes y candados distintos, y bloquear uno
  por el otro no evita ningún error.
- **Sin barra de progreso ni contador de segundos:** el backend no emite progreso, y un contador
  inventado sería adorno. El texto del botón ocupado basta para ~60 s.
- **Los faltantes suman empresa y secretaría en una cifra:** el siguiente paso es el mismo (revisar la
  fila) y dos cifras harían el toast demasiado largo.
