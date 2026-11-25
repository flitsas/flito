# UX slim — Logística: Enviar a cliente, Anular viaje, pestañas por función (Épica #13758)

Tono: Viajes y Entregas ya hablan de **usted**; todo el copy nuevo de esas dos pestañas va de usted. Producto: FLITO.

## Superficie tocada

| # | Superficie | Componente a reutilizar | Cambio |
|---|---|---|---|
| 1 | Pestaña **Viajes** (`ViajesACliente.tsx`) | `TarjetaGrupo`, `FlitModal`, `FlitPillButton`, `toastOk` | LT `en_flit` visibles junto a las clasificadas + acción «Enviar a cliente» |
| 2 | Pestaña **Entregas** (`TabEntregas.tsx`) | `FlitTable`, `FlitModal`, `FlitField`, `toastOk` | Columna «Acciones» con «Anular viaje» (solo `registrado`) |
| 3 | Shell `FlitoLogistica.tsx` | `TABS`, pantalla de acceso denegado existente | Pestañas y cargas según función |
| 4 | Microajustes (a) a (d) | ver al final | — |

## 1. Enviar a cliente (LT que ya están en FLIT)

**Trabajo de la visita:** el operador ve qué LT llegaron a FLIT y las manda al cliente. Se ve primero: compañía + cuántas LT, separadas en «Clasificadas» y «En FLIT».

**Ubicación:** misma tarjeta por compañía de Viajes. Cada tarjeta lista dos bloques con rótulo pequeño (`text-xs`, `--flit-text-muted`): «Clasificadas (n)» y «En FLIT (n)». Bloque vacío no se pinta. Cada LT en FLIT lleva un `StatusChip` tono `active` «En FLIT». Se mantiene el «+ n más» actual por bloque.

**Indicador de origen:** campo que añade backend a `LtClasificadaCerrable` (propuesto `origen: 'clasificado' | 'en_flit'`). El nombre lo fija backend-agent; la UI solo lo lee.

**Una primaria por tarjeta (excepción escrita: la tarjeta se repite por compañía):**
- Si hay clasificadas: «Registrar viaje» sigue siendo la primaria (sin cambio, con tarifa como hoy). «Enviar a cliente» es **secundaria** (`flitBtnSecondary`).
- Si solo hay LT en FLIT: «Enviar a cliente» pasa a ser la primaria de esa tarjeta, y no se muestra la línea de precios ni el aviso «Pídale a Finanzas que fije el precio» (no cobra).

**Modal «Enviar a cliente · {Compañía}»** (`FlitModal`, mismo patrón de `ModalConfirmarViaje`, sin selector de destino ni de motivo de llegada):
1. Texto fijo: «Estas LT ya están en FLIT. Se enviarán al cliente.» y debajo, destacado (`font-medium`): «Este tramo no tiene costo.»
2. Lista de LT en FLIT con casilla por LT (todas marcadas), `<label>` = «{placa} · LT {n}». Máx. alto `max-h-60 overflow-y-auto` como el modal actual. Atajo «Desmarcar todas / Marcar todas» como botón de texto.
3. Botones: «Cancelar» (secundario) y «Enviar a cliente» (primaria; deshabilitada con 0 marcadas o mientras `busy`, texto «Enviando…»).
4. Registra el viaje (`POST /traslados`, destino cliente, Idempotency-Key como hoy). El viaje queda `registrado`; **el mensajero se elige al despachar, en Actas («Firmar y despachar»), igual que hoy**.
- Éxito: toast cerrable «Viaje a cliente de {Compañía} registrado ({n} LT). Despáchelo desde Actas.» Cierra el modal y recarga la lista.
- Error en el modal (`role="alert"`, copy fijo por causa, nunca el texto del API):
  - LT ya no disponible / cambió de estado (409): «Alguna LT ya no está en FLIT. Se actualizó la lista; revise y vuelva a intentar.» (recarga al cerrar).
  - Sin permiso (403): «No tiene permiso para registrar viajes.»
  - Otro: «No se pudo registrar el viaje. Inténtelo de nuevo.»

**Quién NO tiene el permiso (`logistica.traslado.registrar`):** la pestaña Viajes no existe, así que el botón tampoco. No hay botón deshabilitado.

**4 estados (hereda los de Viajes, delta):**
- Cargando: esqueleto actual de tarjetas (sin cambio).
- Error + Reintentar: sin cambio («No se pudieron cargar las LT listas para viaje.»).
- Vacío (cambia el copy): «No hay LT listas para un viaje. Las clasificadas y las que ya llegaron a FLIT aparecen aquí.» (hoy solo menciona clasificadas).
- Lleno: tarjetas con los dos bloques.

**Responsive <lg:** tarjetas ya apiladas; los dos botones de la tarjeta se apilan a ancho completo (`w-full lg:w-auto`, primaria arriba); el modal usa botones a ancho completo bajo `sm`, como el actual.
**Foco/aria:** casilla con `<label>` asociado; grupo con `role="group" aria-label="LT en FLIT"`; el contador «n marcadas» en `aria-live="polite"`; error del modal `role="alert"`; foco inicial en la primera casilla, al cerrar vuelve al botón «Enviar a cliente». Hover: `hover:bg-[var(--flit-bg-hover)]` en botón de texto y fila de casilla; foco `flit-focus`. Chip «En FLIT» usa tono `active` del kit (contraste del kit ≥4.5:1).

## 2. Anular viaje

**Trabajo de la visita:** corregir un viaje `registrado` por error. Se ve primero (sin cambio): la tabla de viajes con su estado.

**Ubicación:** `TabEntregas`, nueva última columna «Acciones» (`FlitTh`). En filas con estado `registrado` y función `logistica.traslado.anular`: botón de texto «Anular viaje» (`text-xs font-semibold`, color `--flit-danger-ink`, `flit-focus rounded-lg px-2 py-1 transition-colors hover:bg-[var(--flit-bg-hover)]`, `aria-label="Anular viaje de {Compañía}, {n} LT"`). Otros estados: celda vacía (no «—»). Sin la función la columna **no se pinta**. La pestaña sigue sin primaria (es de consulta); la única primaria del flujo vive en el modal.

**Modal «Anular viaje» (`FlitModal`, copia el patrón de `MotivoModal` de Logística):**
- Resumen (solo lectura): «{Compañía} · {Destino} · {n} LT · registrado el {fecha}».
- Advertencia: «Las LT volverán a estar disponibles en Viajes. Esta acción no se puede deshacer.»
- Campo `FlitField` label **«Motivo de la anulación (obligatorio)»**, `textarea` rows 3, `maxLength` 300, contador «n/300», placeholder «Por ejemplo: viaje registrado por error».
- Validación: motivo vacío tras `trim()` → botón deshabilitado y, tras tocar el campo, mensaje en línea «Escriba el motivo de la anulación.» (`aria-describedby`).
- Botones: «Volver» (secundario) y «Anular viaje» (**variante destructiva**, ver microajuste b; es la acción primaria del modal; deshabilitada sin motivo o `busy`, texto «Anulando…»).
- Éxito: toast cerrable «Viaje anulado. Las LT quedaron disponibles de nuevo.» Cierra y recarga la lista (la fila queda «Anulado», sin acción).
- Errores en el modal (`role="alert"`):
  - 409 (ya despachado o anulado): «Este viaje ya no se puede anular porque cambió de estado.» + recarga la lista al cerrar.
  - 403: «No tiene permiso para anular viajes.» y se oculta la columna.
  - Otro: «No se pudo anular el viaje. Inténtelo de nuevo.»

**4 estados de la tabla:** sin cambio (esqueleto, error con Reintentar, vacío con/sin filtro, lleno). Delta de vacío: el copy «Aún no hay viajes. Regístrelos en Viajes…» no cambia. Estado del botón dentro de fila: tras éxito se recarga con el esqueleto actual.

**Responsive <lg:** la tabla ya hace scroll horizontal (`overflow-x-auto`); la columna Acciones queda al final (el botón no se pierde porque el scroll es del kit). Modal: botones a ancho completo bajo `sm`.
**Foco/aria:** foco inicial en el textarea; label asociado; `aria-live="polite"` en el contador y en «Anulando…»; al cerrar, foco vuelve al botón de la fila (o a la tabla si la fila cambió). Contraste: texto `--flit-danger-ink` ≥4.5:1 en claro y oscuro; verificar con `check:contraste`.

## 3. Pestañas por función

Regla: una pestaña se pinta solo si el usuario tiene la función que **la sirve**; la carga inicial pide solo lo que esa función permite (hoy `cargar()` pide `/`, `/facetas` y `/actas` siempre, y por eso un mensajero ve alertas rojas).

| Pestaña | Se muestra con | Cargas que dispara (endpoint → función) |
|---|---|---|
| Trámites | `logistica.consola.ver` | `GET /` → `consola.ver`; detalle `GET /:id` → `documento.ver`; filtros `GET /facetas` → `consola.filtrar` |
| Viajes | `logistica.traslado.registrar` | `GET /facetas` (`companiasCerrables`) → `consola.filtrar`; `POST /traslados` → `traslado.registrar` |
| Entregas | `logistica.consola.ver` | `POST /traslados/buscar` → `consola.ver`; anular → `traslado.anular` |
| Actas | `logistica.actas.listar` (hoy sin guarda: siempre visible) | `GET /actas` → `actas.listar`; ver → `actas.ver`; PDF → `actas.descargar` |
| Viajes adicionales | `logistica.viajes.registrar` | sin cambio |
| LT pendientes | `logistica.documento.resolver_tramite` | sin cambio |
| Motivos de llegada | `logistica.motivos.gestionar` | sin cambio |

- Pestaña inicial = la primera visible (no «Trámites» a ciegas). `cargar()`: `/` solo con `consola.ver`; `/actas` solo con `actas.listar`; `/facetas` con `consola.filtrar`.
- Sin ninguna pestaña visible: una sola pantalla de acceso denegado existente «No tienes acceso a FLITO — Logística» (se respeta su tono tuteo actual; es una pantalla ya hecha, no se reescribe).
- **Pierde la función con la página abierta (403):** esa pestaña muestra aviso `role="alert"` «Ya no tiene acceso a esta sección. Vuelva a iniciar sesión si cree que es un error.» sin botón Reintentar; se quita la pestaña de la barra y se pasa a la primera visible; si no queda ninguna, pantalla de acceso denegado. Sin toast (el estado persiste).
- Responsive/feedback: la barra de pestañas ya envuelve (`flex-wrap`) y tiene hover/foco; no cambia.

## Microajustes aprobados

- **(a) Tarifa «Desde 31 dic 1999»:** donde se formatea la vigencia (Tarifas), si la fecha es el centinela `2000-01-01` UTC mostrar **«Desde el inicio»**. Formatear en UTC para que no caiga al 31 dic 1999 por zona horaria. Cualquier otra fecha, igual que hoy.
- **(b) «Desactivar» en el modal de motivos:** hoy texto rojo sobre degradado azul-verde. Pasa a variante destructiva única del kit: fondo `--flit-bg-card`, borde y texto `--flit-danger-ink`, hover `--flit-bg-hover`, foco `flit-focus`, sin degradado; contraste ≥4.5:1 en los dos temas. Si el kit aún no tiene `flitBtnDanger`, se crea con esos tokens y también la usan «Anular viaje» y las acciones «Devolver»/«Novedad» futuras. No es patrón nuevo de adorno: resuelve un caso que `flitBtnPrimary` no cubre.
- **(c) Línea de tiempo:** eventos que no cambian de estado dejan de reusar la etiqueta del estado. `acta_organismo` → «Acta de organismo firmada»; `acta_cliente` → «Acta a cliente generada». «Clasificado» y «En acta» quedan solo para cambios reales de estado.
- **(d) Refresco al volver a Viajes:** al activar la pestaña Viajes (y Trámites) se recarga (`recargarFacetas`/`cargar`). Si ya hay datos, el refresco es silencioso (sin volver al esqueleto) y un fallo del refresco no borra lo que se ve: aviso en la pestaña «No se pudo actualizar. Reintentar». Entregas ya se refresca porque monta con la pestaña.

## Notas para QA (≤10)

1. Mensajero sin `consola.ver`/`actas.listar`: no ve Trámites/Actas, no hay alertas rojas ni 403 en red; sin ninguna función ve el acceso denegado.
2. LT `en_flit` aparece en Viajes bajo «En FLIT»; modal sin precio y con «Este tramo no tiene costo.»; el viaje creado es destino cliente y no genera cobro.
3. Tarjeta solo con LT en FLIT: «Enviar a cliente» es la primaria, sin aviso de tarifa.
4. Anular: solo filas `registrado`; sin `traslado.anular` la columna no existe.
5. Motivo vacío o solo espacios no habilita «Anular viaje»; 300 máx.
6. Tras anular, las LT reaparecen en Viajes (clasificado o en_flit según origen) sin recargar manual.
7. 409 al anular un viaje ya despachado: mensaje fijo, lista recargada.
8. Tarifa con vigencia 2000-01-01 muestra «Desde el inicio» en zona horaria Bogotá.
9. «Desactivar» legible (≥4.5:1) en claro y oscuro; línea de tiempo muestra etiquetas nuevas.
10. 360 px: botones apilados, tabla con scroll, sin desborde; teclado: foco visible en todos los controles nuevos.

## Dudas abiertas

- ¿«Enviar a cliente» debe elegir mensajero en el mismo modal? Se asumió que no: registra el viaje y el despacho se hace en Actas como hoy.
- Contrato del `POST /traslados/:id/anular`: se asumió cuerpo `{ motivo }` (máx. 300); backend debe confirmarlo, y si un viaje cliente puede mezclar LT clasificadas y en FLIT (se asumió que no: viajes separados por origen).
- Un usuario con `traslado.registrar` pero sin `consola.filtrar` no podría cargar Viajes (las tarjetas salen de `/facetas`); conviene que backend exponga `companiasCerrables` bajo la función de Viajes.
