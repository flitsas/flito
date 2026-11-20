# UX slim — Dr. Flit según sus funciones (HU #13942)

Delta sobre el panel de Dr. Flit que ya existe (`apps/web/src/components/drflit/`). No es un rediseño:
no hay controles nuevos, solo se ocultan los que el usuario no tiene habilitados y se añaden cuatro
mensajes en burbuja. Depende de la HU BACKEND #13941 (permiso «Dr. Flit», `FUNCIONES_DRFLIT`, 403
`drflit-funcion-no-habilitada`, degradado `sin-manuales`).

Público: cualquier usuario de FLITO, interno u operador, o con enlace (Cliente/compañía, Corredor SOAT,
Corredor Impuestos). El panel ya trata de **usted** y se queda así.

Abreviaturas de este doc:

| Abrev. | Función | Llega en `funciones` (`useAuth().hasFuncion`) |
|---|---|---|
| **M** | Ver manuales | `drflit.manuales.ver` |
| **I** | Usar la IA | `drflit.ia.usar` |
| **G** | Consulta de gestión (placa, VIN, id FLIT, trámite) | `drflit.gestion.consultar` |
| **S** | Radicar soporte | `drflit.soporte.radicar` |

Reparto inicial: todos los roles tienen el permiso de la página + **M**; `admin` tiene las cuatro.

---

## Superficie tocada

- `useDrFlitVisible.ts`: la visibilidad pasa a depender de `pagina.flito_dr_flit` (con o sin enlace).
  **Se quita la exclusión de `tipoEnlace`** (HU #13914) y deja de bastar `puedeVerAyudaFlito`. El
  fail-closed se queda como está: `funciones === null` o `permisosError` → no se pinta (AC1, AC7).
- `DrFlitPanel.tsx`: el saludo, el pie, la caja y el ruteo de la IA (`rutearIa`) se condicionan por
  función.
- `DrFlitMensaje` / `DrFlitRespuestaIa`: el «Necesito soporte» que va dentro de las burbujas
  (`sinResultados`, `respuestaIa` de soporte) se condiciona por **S**.
- Tres burbujas nuevas en la conversación (sin soporte, sin gestión, sin manuales con IA) y una de
  función retirada (403). El estado vacío del saludo cuando no hay fichas es la cuarta pieza de copy.

Pantallas no tocadas: el asistente de soporte (`DrFlitSoporte`), la vista «Antes de usar la IA», las
tarjetas de gestión. Solo cambia **si se llega** a ellas.

---

## Delta de claridad (qué se ve / qué se calla)

**Qué vino a hacer quien abre el panel:** entender un módulo que usa. Para la mayoría de usuarios
(solo **M**) esa es la única visita posible, así que el panel tiene que llevar a los manuales
(«Explícame un módulo» y la búsqueda por texto en las fichas) y callar todo lo demás, sin dejar a la
vista botones que luego no funcionan.

**La densidad mejora:** con solo **M**, el saludo pasa de 4 controles a 2 y la caja del pie se queda,
pero rotulada «Buscar en los manuales» y sin notas de IA (decisión del PO, 2026-10-25). Ninguna
combinación muestra más de lo que se ve hoy.

### Regla por elemento

| Elemento | Se pinta si | Notas |
|---|---|---|
| Panel / botón «Abrir Dr. Flit» | `pagina.flito_dr_flit` **y** `funciones !== null` **y** sin `permisosError` | AC1, AC7. Nunca `hasPage` (ciclo de imports, ver el hook) |
| «Explícame un módulo» (saludo y pie) | **M** y ≥1 ficha visible | Con **M** y 0 fichas: no se pinta, va el vacío (abajo) |
| «Abrir la Ayuda FLITO →» | **M** y ≥1 ficha visible | El mismo criterio de la Ayuda: sin fichas, la Ayuda no le muestra nada |
| «Tengo una pregunta» + caja «Escriba su pregunta» | **I** o **G** | Ver «Ruteo» |
| Caja «Buscar en los manuales» (sin «Tengo una pregunta») | **M**, ≥1 ficha visible, sin **I** ni **G** | Decisión del PO (2026-10-25): busca en las fichas sin IA (F3, `buscarSecciones`). Ajusta el AC2 |
| Notas bajo la caja (privacidad IA, cupo) | **I** y la IA en uso | Igual que hoy (AC3) |
| Vista «Antes de usar la IA» | **I** | Sin **I** no se ofrece nunca |
| «Necesito soporte» (saludo, `sinResultados`, `respuestaIa` de soporte) | **S** y (`soporte.disponible` o la consulta falló) | Hoy basta lo segundo; ahora **S** va primero (AC4) |
| Oferta «Consultar … en sus módulos» | **G** y algún módulo de consulta (`gestion.modulosPara`) | AC5 |
| «Terminar chat» | Hay mensajes | Sin cambio |

### Combinaciones que hay que ver

| Combinación | Saludo | Pie | Primaria | Llamadas al abrir |
|---|---|---|---|---|
| **M** (reparto inicial) | Texto de bienvenida + «Explícame un módulo» + «Abrir la Ayuda FLITO» | «Explícame» + caja «Buscar en los manuales» | «Enviar» | Ninguna a `/autorizacion` |
| **M**, 0 fichas visibles | Vacío sin fichas (copy 1), sin botones | Vacío (sin barra) | Ninguna (no hay nada que hacer en el panel) | Ninguna |
| **M + I** | Como hoy, sin «Necesito soporte» | «Explícame» + caja | «Enviar» (como hoy) | `GET /autorizacion?finalidad=ia` |
| **M + I + G + S** (admin) | Como hoy | Como hoy | «Enviar» (como hoy) | `finalidad=ia` y `finalidad=soporte` (como hoy) |
| **M + S** | Bienvenida + «Explícame» + «Ayuda» + «Necesito soporte» | «Explícame» + caja «Buscar en los manuales» | «Enviar» | `finalidad=soporte` |
| **M + G** (sin I) | Bienvenida + «Explícame» + «Tengo una pregunta» + «Ayuda» | «Explícame» + caja | «Enviar» | Ninguna a `/autorizacion` |
| **I** sin **M** | Bienvenida + «Tengo una pregunta» | caja | «Enviar» | `finalidad=ia` (el servidor responde `sin-manuales`, copy 4) |
| Sin ninguna función (solo la página) | Vacío sin funciones (copy 2), sin botones | Vacío | Ninguna | Ninguna |

### Primaria en «solo manuales»

**Decisión del PO (2026-10-25), sustituye al default anterior:** con solo **M** la caja se queda,
rotulada «Buscar en los manuales» y sin notas de IA, y busca en las fichas visibles sin IA (el mismo
camino de F3). Por eso **«Enviar» sigue siendo la única primaria** en todas las combinaciones con caja, y
«Explícame un módulo» (saludo y pie) se queda secundario (`flitBtnSecondarySm`). No hay primaria nueva.
Sin caja (vacíos 1 y 2) no hay primaria.

### Ruteo de la caja por función (lo que cambia en `respaldo` / `rutearIa`)

| Qué detecta Dr. Flit | Con la función | Sin la función |
|---|---|---|
| IA → intención `soporte` | Oferta de F5 (como hoy) | Burbuja **sin soporte** (copy 3). Hoy cae en silencio a F3: eso cambia (AC4) |
| IA → intención `gestion` (con valor, sin valor o por documento) | Oferta de F6 / mensajes de hoy | Burbuja **sin gestión** (copy 5) (AC5) |
| Placa/VIN/id FLIT detectado en local (sin IA) | Oferta de F6 (como hoy) | Pasa a los manuales, como hoy (sin **M**: copy 4b) |
| Pregunta normal sin IA en uso | Búsqueda en los manuales (F3, como hoy) | Sin **M**: copy 4b |
| IA responde `sin-manuales` | — | Burbuja copy 4 |

Que la IA tenga soporte, pero que `soporte.disponible` sea `false` porque el ambiente no está
declarado, **no** es «sin función». Ese caso sigue igual que hoy (cae a F3, sin mensaje de
administrador), porque no lo resuelve el administrador.

### Llamadas al API (cero llamadas de finalidades que el usuario no tiene)

- `GET /flito/dr-flit/autorizacion?finalidad=soporte` (`consultarEstadoSoporte` al montar, y al
  reintentar): **solo con S**. Sin **S**, el panel no lo llama nunca, y `soporteVisible` queda en
  `false` sin consultar. Hoy la consulta fallida *pinta* el botón (F5.8), y eso tiene que seguir detrás
  de **S**.
- `GET /flito/dr-flit/autorizacion?finalidad=ia` (`useIaDrFlit` al montar y al recargar el texto) y
  `POST /autorizacion` con `finalidad: 'ia'`: **solo con I**. Sin **I**, el hook queda en `sin-ia`
  sin pedir nada.
- `POST /flito/dr-flit/chat`: solo con **I** (ya depende de `enUso`).
- `POST /casos-soporte`: no se alcanza sin **S** (no hay cómo abrir el asistente).
- Consultas de gestión: no se alcanzan sin **G** (no hay oferta).
- Fichas: solo las visibles, como hoy, y solo con **M**.

---

## Estados (4) + copy

El panel ya tiene sus 4 estados (marco: cargando/error; conversación: buscando, error con
«Reintentar», lleno). Lo que añade este delta:

| Estado | Qué se ve |
|---|---|
| **Cargando** `/permisos/mios` | Dr. Flit no se pinta (fail-closed, AC7). No hay esqueleto: el botón aparece cuando se sabe |
| **Error** de `/permisos/mios` | Dr. Flit no se pinta. Sin aviso propio: el shell ya maneja ese error |
| **Vacío** | Copy 1 (M sin fichas) o copy 2 (sin funciones), en la burbuja de saludo, en lugar de «¿Por dónde empezamos?» y sus botones |
| **Lleno** | La combinación de la tabla |

### Copy exacto (usted, una frase: qué pasó y qué hacer)

1. **Vacío sin fichas** (M, 0 fichas visibles). Sustituye el párrafo de bienvenida y el «¿Por dónde
   empezamos?»:
   > Todavía no hay manuales de los módulos que usted usa; cuando su administrador le dé acceso a un módulo, aquí podrá consultar cómo funciona.
2. **Vacío sin funciones** (solo la página, ninguna función):
   > Dr. Flit aún no tiene funciones habilitadas para usted; pídale a su administrador que le active al menos los manuales.
3. **Sin soporte** (la IA detecta que quiere un caso y no tiene **S**):
   > Usted no tiene habilitado radicar casos de soporte en Dr. Flit; pídale a su administrador que se lo active.
4. **Degradado `sin-manuales`** (la IA no tiene manuales con qué responderle):
   > No puedo responderle porque usted aún no tiene manuales disponibles; pídale a su administrador que le dé acceso a los manuales de sus módulos.

   4b. **Sin M, pregunta sin IA en uso** (respaldo sin manuales): el mismo texto del 4. Para el
   usuario es la misma situación.
5. **Sin consulta de gestión** (la IA detecta placa, VIN, trámite o documento y no tiene **G**):
   > Usted no tiene habilitada la consulta de placas y trámites en Dr. Flit; pídale a su administrador que se la active.
6. **403 `drflit-funcion-no-habilitada` inesperado** (el permiso cambió con el panel abierto):
   > Esta función ya no está habilitada para usted; si la necesita, pídale a su administrador que se la active.

Dónde va cada uno:

- 1 y 2 van en la burbuja de saludo. No se guardan como mensaje (son el saludo).
- 3, 4, 4b y 5 van como burbuja de Dr. Flit que **responde a la pregunta** (`respondeA`), dentro del
  `role="log"`. Se guardan en la conversación como cualquier respuesta. Llevan solo el texto: sin
  enlaces, sin «Reintentar» (reintentar daría lo mismo) y sin «Necesito soporte».
- 6 depende de dónde ocurra:
  - En la conversación (chat, gestión, ficha): burbuja de Dr. Flit, en el lugar donde iría la
    respuesta o el error de esa acción.
  - En el asistente de soporte (al aceptar la autorización o al radicar): sustituye la pantalla del
    paso con el texto 6 y un solo botón secundario, «Volver al chat». Así se deja sin efecto el
    borrador, que ya no se puede enviar.
  - En los dos casos la función queda **apagada en esa sesión del panel**: se oculta su botón o su
    caja, y si la función es **I**, el hook pasa a `sin-ia`. Sin «Reintentar».
- **Nunca** se pinta `e.message`, el código `drflit-funcion-no-habilitada` ni `sin-manuales`.

---

## Responsive + feedback del delta

- **Móvil (<`lg`):** no cambia nada. El panel ya ocupa el ancho y su barra de botones envuelve
  (`flex-wrap`). «Enviar» (también en «Buscar en los manuales») va a ancho completo por debajo de
  340 px (`max-[340px]:w-full`, como hoy). Las burbujas nuevas usan `break-words` como las demás.
- **Feedback:** no hay controles nuevos. «Volver al chat» (caso 6 en el asistente) es el de la cabecera
  del asistente, con hover y `flit-focus` del kit.
- **Notificación:** **aviso en la conversación** (burbuja en el `role="log"`, que se anuncia sola).
  **Ningún toast**: el panel ya da todos sus resultados en la conversación, y un mensaje de «pídale a
  su administrador» sigue siendo cierto mientras el usuario mira el panel, así que es estado, no
  resultado puntual.
- Sin efectos, sin iconos nuevos, sin colores nuevos: las burbujas usan `BurbujaDrFlit` tal cual, sin
  tono de error, porque no es una falla.

---

## Permiso/slug

- Página: `pagina.flito_dr_flit` (HU #13941). Roles: **todos** los de `USER_ROLES`, con o sin enlace,
  según la matriz de permisos. No se diseña para `operaciones`.
- Funciones: las cuatro de `FUNCIONES_DRFLIT`, leídas con `hasFuncion` desde el arreglo `funciones`
  de `/permisos/mios`. La web no decide por el nombre del rol.
- PII: sin cambios. Nada nuevo va en la URL, y los mensajes 3, 5 y 6 no repiten el valor detectado
  (placa, VIN, documento).

---

## Notas para QA (≤10)

1. Con solo **M**, abrir el panel: caja «Buscar en los manuales» (sin notas de IA), sin «Tengo una
   pregunta», sin «Necesito soporte»; la primaria es «Enviar» y la búsqueda cita fichas. En Network no
   hay `GET /autorizacion` (ni `ia` ni `soporte`) ni `POST /chat`.
2. **M** con 0 fichas visibles: copy 1 en el saludo, sin botones, sin pie de acciones.
3. Usuario con enlace (Cliente, Corredor SOAT, Corredor Impuestos) con la página → ve Dr. Flit (AC1).
   Sin la página → no lo ve, ni con fichas de Ayuda visibles.
4. Fail-closed (AC7): con `/permisos/mios` lento o en 500, el botón «Abrir Dr. Flit» no aparece.
5. **M + I** (sin **S**): una pregunta con intención de soporte da el copy 3 y ningún botón de soporte.
   Con `soporte.disponible=false` y **S**, el comportamiento es el de hoy.
6. **M + I** (sin **G**): una pregunta por placa/trámite con IA da el copy 5; no hay oferta de
   consulta, y el valor no aparece en la burbuja.
7. IA que responde `sin-manuales` → copy 4, sin código crudo.
8. Retirar una función con el panel abierto (403 `drflit-funcion-no-habilitada`): copy 6 donde ocurrió
   y la función desaparece del panel; en el asistente de soporte, «Volver al chat».
9. Admin (las cuatro): sin diferencias con el comportamiento actual (AC3: caja, notas y cupo como hoy).
10. Teclado y lector: las burbujas nuevas se anuncian por el `log` una vez; el foco no salta. Tema
    oscuro: las burbujas son `BurbujaDrFlit`, sin colores nuevos.

---

## Decisiones del PO (David, 2026-10-25)

- **«Su administrador»** en todos los mensajes, también para usuarios con enlace (Cliente, Corredor).
- **Búsqueda en los manuales sin IA:** con solo **M** la caja se queda, rotulada «Buscar en los
  manuales», sin notas de IA, y busca en las fichas visibles (F3, `buscarSecciones`). «Enviar» vuelve a
  ser la primaria y «Explícame un módulo» queda secundario. Ajusta el AC2, que decía «sin caja».
