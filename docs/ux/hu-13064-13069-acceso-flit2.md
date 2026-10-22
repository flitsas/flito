# UX slim: acceso a FLIT 2 en Gestión Trámites (HU #13064 + HU #13069)

Feature #13057 · Épica #12736. Público: administrador de FLITO (operador interno).
Módulo: `flito-sync` (rutas `/api/flito/sync/flit2/acceso`), no el legacy `tramites`.
Contrato: `packages/shared-types/src/flito-flit2.ts` y `docs/diseno/hu-13061-13063-acceso-flit2.md`.
Análoga: `components/flito/comparendos/TokenSimitComparendos.tsx`. De ahí se toman la forma del bloque
y sus reglas del secreto; **no** se toman sus pestañas, porque Gestión Trámites no las tiene.

---

## Superficie tocada

- `FlitoTramites.tsx`: **un** botón secundario en las acciones del `PageHeaderCard` y el montaje
  del panel. Nada más, porque la página tiene techo de líneas congelado.
- Componente nuevo (sugerido `components/flito/tramites/AccesoFlit2.tsx`, o el nombre que el frontend
  prefiera dentro de `flito/tramites/`). Lleva el panel entero: estado, formulario, «Probar conexión»
  y el aviso con el resultado.

### Dónde va (decisión)

**Botón secundario «Acceso a FLIT 2» en la cabecera, que abre `FlitModal lateral`.**

| Opción | Por qué no / por qué sí |
|---|---|
| Pestañas Cola / Configuración (como Comparendos) | Comparendos ya nació con tres pestañas. Aquí habría que partir en vistas una página de techo congelado solo por un bloque que se toca pocas veces al año. Es una reestructuración fuera del alcance. |
| Acordeón plegado encima de la cola | Queda siempre visible sobre lo que el operador vino a ver, y además desplaza la tabla. |
| Acordeón al final de la página | Quedaría detrás de la tabla y de la paginación, donde nadie lo encuentra. |
| **Botón en la cabecera → panel lateral** | La cola no cambia. Es una tarea de configuración a un clic. `FlitModal lateral` ya trae el foco atrapado, Esc, restauración de foco y `cierreBloqueado`. No hace falta un patrón nuevo. **Elegida.** |

- El GET se hace **al abrir el panel**, no al cargar la página. La cola no paga una petición que no
  necesita.
- El botón depende **solo** de `hasFuncion('tramites.flit2.ver_acceso')`. Va **fuera** del bloque
  `esOperaciones` de la cabecera y al final del grupo, después de «+ Trámite demo».
- Título del panel: «Acceso a FLIT 2».

---

## Delta de claridad (qué se ve / qué se calla)

**Qué vino a hacer:** saber si FLITO puede entrar a FLIT 2 en este ambiente y, si no puede, dejarlo
listo.

**Qué se ve primero:** el estado del acceso (chip) y, si hay acceso, quién lo guardó y desde cuándo.

**Qué se calla:**
- La contraseña y el pase no se muestran nunca, ni enmascarados ni recortados. El contrato tampoco
  los trae.
- `scope` y `mensaje` de la respuesta de `probar` no se pintan. El copy lo pone la pantalla (ver
  Estados).
- No se muestra una versión de llave, porque el contrato no la tiene.

**Densidad de la página:** sin cambio. La cabecera suma un botón secundario y el resto de la página
queda igual.

### Wireframe: con acceso y con permiso de guardar (≥ lg, panel lateral)

```
┌──────────────────────────────────────── Acceso a FLIT 2 ─ ✕ ┐
│ Con qué usuario entra FLITO a FLIT 2 para leer sus trámites.│
│ La contraseña se cifra al guardar y no vuelve a mostrarse.  │
│                                                             │
│ Estado             [● Vigente]                              │
│ Usuario de servicio  flito-dev                              │
│ Guardado por       Ana Pérez                                │
│ Desde              29 sep. 2026, 10:42 a. m.                │
│                                        [ Probar conexión ]  │  ← secundario
│ ┌─ aviso (solo tras probar) ─────────────────────────────┐  │
│ │ ✓ Conectado. FLITO puede leer los trámites de FLIT 2.  │  │
│ └────────────────────────────────────────────────────────┘  │
│ ─────────────────────────────────────────────────────────── │
│ Reemplazar acceso                                           │
│ Usuario de servicio  [______________________]               │
│ Contraseña           [______________________]               │
│ Los campos se vacían al guardar. No pegues la contraseña    │
│ en chats ni la dejes en capturas.                           │
│ [error del formulario, si lo hay]                           │
│                                          [ Guardar acceso ] │  ← primaria
└─────────────────────────────────────────────────────────────┘
```

Sin acceso: la ficha es solo `Estado [○ Sin acceso]` más el aviso del AC3. No se muestra «Probar
conexión», y el formulario se titula «Configurar acceso». Con solo «ver»: la ficha, o el aviso, y
nada más, sin formulario ni «Probar».

### Primaria

**«Guardar acceso» es la primaria** (`flitBtnPrimary`). Es la única acción que cambia algo y la que
desbloquea todo lo demás. «Probar conexión» es **secundaria** (`flitBtnSecondary`) y va junto a la
ficha que comprueba, no junto al formulario. Así no quedan dos botones en la misma fila. Dentro del
panel hay una sola primaria. La primaria de la página («Sincronizar FLIT») no cambia.

### Ficha (`<dl>`, mismo patrón `Dato` que la análoga)

| Fila | Valor | Cuándo |
|---|---|---|
| Estado | `StatusChip`, siempre con texto (ver tabla) | siempre |
| Usuario de servicio | `clientId` | `configurado` |
| Guardado por | `actualizadoPor.nombre` o «—» | `configurado` |
| Desde | `actualizadoEn` en hora de Colombia | `configurado` |

| `configurado` / `estado` | Chip |
|---|---|
| `false` | neutral · «Sin acceso» |
| `true` / `null` | neutral · «Sin probar» |
| `true` / `vigente` | success · «Vigente» |
| `true` / `rechazado` | danger · «Rechazado por FLIT 2» |
| `true` / `bloqueado` | warning · «En espera hasta las 10:57 a. m.» (`bloqueadoHasta`) |

---

## Estados (4) + copy

Tono: **tú**, calcado de Gestión Trámites («Selecciona…», «Elige…»).

| Estado | Qué se ve |
|---|---|
| **Cargando** | Esqueleto de la ficha (4 filas) dentro del panel, con `aria-busy` y la etiqueta «Cargando el acceso a FLIT 2». Nada de spinner genérico. |
| **Error (AC6)** | Aviso `role="alert"` (tinta `--flit-danger-ink`): «No se pudo consultar el acceso a FLIT 2. Vuelve a intentarlo.» y el botón **[Reintentar]**. La meta se borra: no queda en pantalla un «Vigente» que nadie puede confirmar. |
| **Vacío (AC3)** = `configurado: false` | Chip «Sin acceso» y aviso `role="status"`: «FLITO aún no tiene acceso a FLIT 2 en este ambiente.» Siguiente paso: con «guardar», «Escribe el usuario de servicio y la contraseña que entregó FLIT 2.» y debajo el formulario abierto. Solo con «ver», «Pídele a un administrador con permiso de guardar el acceso que lo configure.» |
| **Lleno (AC2)** | Ficha completa. Con «guardar», además «Probar conexión» y el formulario «Reemplazar acceso». |

### Guardar (AC4 y AC6 de #13064)

- Validación al enviar: los dos campos son obligatorios. «Escribe el usuario de servicio.» y
  «Escribe la contraseña.» van en línea, junto a su campo. Topes que replican el servidor para
  ahorrar un 400: usuario hasta 120 y contraseña hasta 512. **Sin `maxLength` en la contraseña**,
  por la misma razón que en la análoga: el recorte no se ve con el campo en puntos. El largo se
  comprueba al enviar.
- Mientras guarda: el botón pasa a «Guardando…», queda `disabled` + `aria-busy` y el panel usa
  `cierreBloqueado`.
- Éxito: **primero se vacían los dos campos** y después se parcha la meta con la respuesta del PUT.
  No hace falta otro GET. Se borra el aviso de la última prueba, que era del acceso anterior. Sale el
  **toast** `success` cerrable «Acceso a FLIT 2 guardado.» (~4 s). El chip queda en «Sin probar», y
  eso ya empuja a probar.
- Error: **aviso en línea en el formulario** (`ErrorFormulario` / `role="alert"`), no un toast. Los
  campos **se conservan**. El copy es propio y no incluye nunca nada derivado de lo escrito:

| Respuesta | Copy |
|---|---|
| 400 | «Revisa los datos: el usuario admite hasta 120 caracteres y la contraseña hasta 512.» |
| 409 | «Alguien más guardó el acceso en este momento. Actualiza el estado y vuelve a intentarlo.» + botón [Actualizar estado], que recarga la meta |
| 503 `llave_maestra` | «El servidor no puede cifrar la contraseña: falta la llave de cifrado. Avísale a quien administra el ambiente.» |
| otro | «No se pudo guardar el acceso a FLIT 2. Vuelve a intentarlo.» |

### Probar conexión (#13069)

- Solo aparece con «guardar» **y** `configurado: true` (AC1 y AC4). Sin acceso no se pinta. No se
  pinta deshabilitado, porque un botón que no puede actuar sobre nada es peor que su ausencia.
- Al pulsar: «Probando…», `disabled` + `aria-busy` y `cierreBloqueado` en el panel (AC3). El timeout
  del servidor es de 10 s.
- El resultado va en un **aviso en la sección** bajo el botón (AC2), no en un toast. Sigue siendo
  cierto mientras se mira el panel. Ese aviso reemplaza al anterior, desaparece al guardar un acceso
  nuevo y se pierde al cerrar el panel. Tras cada prueba se **recarga la meta sin esqueleto**, porque
  el chip puede cambiar a rechazado o bloqueado.
- La pantalla **no pinta `mensaje` del API**. Hace el mapeo por `resultado`:

| Resultado | Tono | Copy |
|---|---|---|
| `conectado` | ok (`success`) | «Conectado. FLITO puede leer los trámites de FLIT 2.» |
| `conectado_sin_pii` | advertencia | «Conectado, pero sin permiso de datos personales. Los trámites se leen; el SOAT y los impuestos de los trámites de FLIT 2 quedarán en espera hasta que FLIT 2 conceda ese permiso.» |
| `rechazado` (usuario o contraseña) | error | «FLIT 2 rechazó el usuario o la contraseña. Revísalos y guarda el acceso de nuevo.» |
| cambio de contraseña (ver R1) | error | «FLIT 2 exige cambiar la contraseña de este usuario. Pide la nueva a quien administra FLIT 2 y guárdala aquí.» |
| `bloqueado` (423) | advertencia | «FLIT 2 bloqueó el acceso 15 minutos por intentos fallidos. Prueba de nuevo después de las {hh:mm}.» |
| FLIT 2 pidió esperar (429 de FLIT 2, ver R1) | advertencia | «FLIT 2 pidió esperar antes de otro intento. Prueba de nuevo después de las {hh:mm}.» |
| `no_responde` | error | «FLIT 2 no responde. Puede ser una caída momentánea: prueba de nuevo en unos minutos.» |
| `no_configurado` | error | «FLIT 2 no está configurado en este ambiente. Avísale a quien administra el servidor.» |
| `sin_acceso` (carrera: se borró el acceso) | error | «FLITO ya no tiene acceso guardado. Guárdalo antes de probar.» y se recarga la meta |
| HTTP 429 (limitador propio, 5/min) | advertencia | «Ya probaste la conexión varias veces en el último minuto. Espera un minuto.» |
| HTTP 503 `llave_maestra` | error | «El servidor no puede leer el acceso guardado: falta la llave de cifrado. Avísale a quien administra el ambiente.» |
| otro fallo | error | «No se pudo probar la conexión. Vuelve a intentarlo.» |

El `{hh:mm}` sale de `bloqueadoHasta` en hora de Colombia. Si viene `null`, se dice «en unos
minutos». Para pintar el aviso se usan los tonos del kit, con fondo y tinta `--flit-*` que tengan par
oscuro y un icono decorativo `aria-hidden`: el tono no se puede transmitir solo con el color. Si es
error, `role="alert"`. Si es ok o advertencia, `role="status"`.

### Reglas del secreto (heredadas de la análoga, obligatorias)

La contraseña va en un input **no controlado** (`ref`, sin `value`/`defaultValue`), sin `name`, con
`type="password"` y `autoComplete="new-password"`. El formulario lleva `preventDefault`. El valor no
se escribe en `console`, en storage, en la URL, en el toast ni en ningún copy de error. El usuario de
servicio no es secreto, así que puede ser controlado, pero también se vacía al guardar (AC4).

---

## Responsive + feedback del delta

- **< lg:** la cabecera ya envuelve (`flex-wrap`), así que «Acceso a FLIT 2» baja con las demás
  acciones. El panel lateral ocupa todo el ancho en móvil. Si `FlitModal lateral` no lo hace hoy a
  360 px, el frontend lo comprueba y lo resuelve en el componente, no en el kit. La ficha pasa a
  etiqueta sobre valor (`grid` de una columna, `sm:grid-cols-[13rem_1fr]` como `Dato`). Los botones
  van a ancho completo y apilados: primero «Probar conexión», después, al pie del formulario,
  «Guardar acceso». Los dos a la misma altura.
- **Feedback:** «Acceso a FLIT 2», «Probar conexión», «Guardar acceso», [Reintentar], [Actualizar
  estado] y el ✕ usan hover del kit (`flitBtn*` o velo `--flit-bg-hover`, `transition-colors`) y foco
  `flit-focus`. `disabled` se distingue durante «Probando…» y «Guardando…». Los inputs usan `flitInp`
  con foco del kit.
- **Notificación:** guardar bien da **toast** cerrable. Guardar mal da **aviso en línea**. Probar da
  **aviso en la sección** siempre, y nunca toast. La carga fallida da **aviso con Reintentar**.
- **Tema oscuro:** chips, avisos y ficha solo con tokens `--flit-*` con par oscuro. Error con
  `--flit-danger-ink`. Sin `bg-white` ni `red-*`.

---

## Permiso/slug

- Página: sin página nueva. La ruta y el `PageSlug` de Gestión Trámites no cambian.
- `tramites.flit2.ver_acceso`: ve el botón de la cabecera, el panel y la ficha (AC1 y AC5 de
  #13064).
- `tramites.flit2.guardar_acceso`: además el formulario y «Probar conexión» (AC4 de #13064 y AC1 de
  #13069). En el backend, `probar` reutiliza este código, según el diseño de #13063.
- Sembradas en la `0214`, repartidas solo a `admin`. Si `FUNCIONES_POR_ROL` del helper e2e no las
  tiene, van al helper, no al spec.

### Requerimiento de datos

- **R1 (bloquea 2 de los 8 mensajes del AC2 de #13069).** El `resultado` del contrato
  (`conectado | conectado_sin_pii | rechazado | bloqueado | no_responde | no_configurado |
  sin_acceso`) junta 401 `invalid_client` con 403 `secret_rotation_required` en `rechazado`, y
  423 con 429 de FLIT 2 en `bloqueado`. Con ese contrato la pantalla no puede distinguir «FLIT exige
  cambiar la contraseña» de «usuario o contraseña rechazados», ni «bloqueado 15 min» de «FLIT 2
  pidió esperar». Hay dos maneras de resolverlo, a elegir por `architecture-agent` o `backend-agent`
  en #13063:
  - (a) dos valores más: `cambio_clave` y `espera`;
  - (b) un campo `motivo` (`client_locked | rate_limited`, que ya existe como `bloqueo_motivo`, más el
    análogo para el rechazo).

  Sin eso, el frontend pinta el copy genérico de `rechazado` o `bloqueado` y los AC quedan sin
  cumplirse.
- El prompt nombraba los campos `guardadoPor`/`desde`. Los nombres reales son
  `actualizadoPor`/`actualizadoEn` (`Flit2AccesoMeta`), más `bloqueadoHasta`. Manda shared-types.

---

## Notas para QA (≤10)

1. Solo con `ver_acceso`: aparece el botón y el panel muestra la ficha, sin formulario ni «Probar».
   Sin `ver_acceso`: no hay botón.
2. `configurado: false`: se ven el aviso del AC3 y el formulario «Configurar acceso». «Probar
   conexión» no está en el DOM.
3. Tras guardar bien: los campos quedan vacíos (incluida la propiedad `value` del input), la ficha
   muestra el nuevo usuario, quién y cuándo, sale el toast y desaparece el aviso de la prueba
   anterior.
4. La contraseña no aparece en `page.content()` mientras está escrita, ni en la URL, el toast o los
   errores (mismo control que el TC30 de Comparendos).
5. Con los errores 400, 409 y 503 del PUT se ve el copy propio en línea y los campos se conservan.
   El 409 ofrece «Actualizar estado».
6. GET fallido: se ve el aviso con Reintentar y ningún «Vigente» residual. Reintentar recupera.
7. Probar: el doble clic hace una sola petición y el botón queda en «Probando…» y deshabilitado. Esc
   y el velo no cierran el panel mientras prueba.
8. Cada `resultado` muestra su copy y su tono, sin texto de `mensaje` ni de `scope`. Los errores
   usan `role="alert"`.
9. Después de probar se refresca el chip: un `rechazado` o `bloqueado` cambia la ficha sin mostrar el
   esqueleto.
10. La cola de Gestión Trámites no hace el GET del acceso al cargar (red). Revisar el móvil a 360 px
    y los dos temas.

---

## Oficio

| Pregunta | Respuesta |
|---|---|
| ¿Qué vino a hacer? | Ver si FLITO entra a FLIT 2 y dejarlo listo si no entra. |
| ¿Qué se ve primero? | El chip de estado y la ficha. La contraseña y el pase no están nunca, y la sección entera vive a un clic de la cola. |
| ¿Primaria única? | «Guardar acceso». «Probar conexión» es secundaria. |
| ¿Vacío y error con siguiente paso? | Sí: configurar o pedir al administrador, y Reintentar o Actualizar estado. |
| ¿Efectos o patrón nuevo? | Ninguno: `FlitModal lateral`, `StatusChip`, `FlitField` y `flitBtn*`. |
| ¿Móvil? | El panel a todo el ancho, la ficha en una columna y los botones apilados a ancho completo. |
| ¿Feedback? | Hover y foco del kit en todos los controles, y `disabled` visible mientras trabaja. |
| ¿Notificación? | Guardar da toast. Probar y los errores dan aviso en la sección. |

## Decisiones y descartes

- **No se hacen pestañas:** partir en vistas una página de techo congelado por un bloque de
  configuración es desproporcionado. Comparendos las tenía por tres trabajos de peso parecido.
- **La cabecera no avisa del estado** (por ejemplo, un chip «Rechazado» en el botón). Exigiría el GET
  en cada carga de la cola y el AC no lo pide. Si el PO quiere que la cola avise de un acceso caído,
  es una pregunta aparte y no entra en esta ráfaga.
- **El formulario de reemplazo va siempre abierto (con «guardar»), no detrás de otro clic.** Son dos
  campos y el panel ya es una superficie de configuración. Esconderlo sumaría un paso sin quitar
  ruido de la cola.
- **No se reutiliza `BloqueConfig` de Comparendos por import:** acoplaría el módulo de trámites al de
  comparendos. Se compone la misma forma con el kit.
