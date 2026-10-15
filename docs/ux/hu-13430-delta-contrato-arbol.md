# UX slim — Panel en tres niveles: delta por el contrato del árbol (HU #13430)

Feature #13416 · Épica #13411 · Modo **slim** · 2026-10-15.
Actualiza `docs/ux/hu-13430-panel-tres-niveles.md` (full, 2026-10-09) con el contrato que cerró la
HU #13429 (`docs/arquitectura/feature-13416-catalogo-tres-niveles.md` §5-quater.5 y §5-quater.10) y
con las decisiones de David del 2026-10-13 (P-24 A1, P-25 A, P-26, P-29). **Donde este delta y la
ficha full digan cosas distintas, manda este delta.** Lo que no se nombra aquí sigue igual:
disposición A, tri-estado con `aria-checked="mixed"`, regla de conservación (desmarcar no borra),
4 estados, solo lectura (AC6), `admin` editable sin trato especial (AC7), barra «Sin guardar»
sticky abajo en < lg, disclosure + `fieldset` (no `role="tree"`), tono **tú**.

Público: administrador de FLITO (operador interno). Análoga: el panel actual de Roles y permisos.

---

## Superficie tocada

- **Pantalla 1** — árbol del rol en Roles y permisos (`pages/roles-permisos/`).
- **Pantalla 2** — «Permisos de este usuario» en el modal Editar / Nuevo usuario (mismo árbol, modo usuario).
- **Delta #13431** (shell) — solo la corrección de «Ayuda» (ver el final).

Datos, ahora reales (sustituyen a R1–R5 de la ficha full):

| Para qué | Ruta | Forma |
|---|---|---|
| Árbol del rol | `GET /api/permisos/roles/:codigo/arbol` | `{ rol, arbol: NodoArbolRol[], transversales: NodoArbolRol[] }` |
| Árbol del usuario | `GET /api/users/:id/arbol` (no `/permisos/usuarios/…`) | `{ userId, rol, arbol: NodoArbolUsuario[], transversales: NodoArbolUsuario[] }` |
| Guardar rol | `PUT /api/permisos/roles/:codigo/funciones` | sin cambio: `{ funciones }` = **todos** los marcados, incluidos los inactivos; **nunca** `menu.ayuda` (daría 400) |
| Guardar usuario | `PATCH /api/users/:id` | sin cambio |
| 409 anti-bloqueo | `PUT` y `PATCH` | `{ error, funcion, nodo? }` |

Campos que pinta la web: `nombre`, `descripcion`, `tipo`, `nivel` (sangría), `legado`, `derivado`,
`opcional`, `marcado`, `efectivo`, `sinAcciones`, `hijos` y, en modo usuario, `heredado` y `excepcion`.
Los códigos siguen solo en `data-codigo`.

---

## Delta de claridad (qué se ve / qué se calla), punto por punto

### 1. Ayuda — derivada, sin casilla

«Ayuda» llega con `derivado: true`, sin hijos y sin `marcado`. Se pinta **en su sitio del menú**
(entre Administración y Perfil) como una fila **sin casilla, sin chevron y sin cuenta**; el hueco de
la casilla se reserva para que el nombre quede alineado con los demás elementos. Nombre en
`--flit-text-primary`; debajo, en `--flit-text-secondary`:

> «Ayuda no se marca: cada usuario la ve sola, con los capítulos de lo que puede usar.»

- No es un control: `<li>` con texto, sin `input`, sin hover (no hay nada que pulsar).
- No cuenta en «k de n» de ningún sitio, «Marcar todo / Desmarcar todo» no la toca, y el `PUT` no
  la manda nunca.
- Modo usuario: igual, sin etiqueta de origen.

Se calla: por qué es derivada (≥1 capítulo visible) y el código.

### 2. Operaciones opcionales (P-26)

Son hijos `tipo: 'operacion'` con `opcional: true` bajo su acción (nivel visual 4) o bajo su ítem
antiguo (nivel visual 3): p. ej. «Ver el documento del propietario» bajo **Vehículos**, «Firmar el
manual» bajo **Manual SARLAFT**, «Operar» bajo **SOAT (antiguo)**, o las descargas/reintentos bajo
su acción FLITO (los nombres reales son los `nombre` del API). Lo que el administrador tiene que
entender: **no vienen con el padre; se marcan aparte**.

- Van **al final** del panel de su padre, después de las acciones normales, bajo un rótulo de grupo
  en `text-xs font-semibold --flit-text-secondary`: **«Opcional: no viene con {padre}, se marca
  aparte»**. Un rótulo por padre, no una etiqueta por fila (hay padres con 3 opcionales).
- La casilla y la fila son **las mismas** que las de una acción: misma tinta, mismo hover, mismo
  foco. Lo que las distingue es el rótulo de grupo y su posición, no un color.
- **Tri-estado y cuentas:** los opcionales **no cuentan** en el «k de n» ni en el parcial de su
  padre ni de sus ancestros. Un padre con todas sus acciones marcadas se ve **Marcada** `[✓]`
  aunque sus opcionales estén vacíos; si no fuera así, el estado «completo» sería inalcanzable sin
  regalar lo opcional. Un padre cuyos **únicos** hijos son opcionales (Vehículos, Manual SARLAFT,
  SOAT (antiguo)) se comporta como una hoja: marcada o desmarcada, sin «k de n». Si el padre tiene
  opcionales marcados, su cuenta lo dice aparte: «4 de 6 · 1 opcional» (o solo «1 opcional»).
- **Conservación:** misma regla que el resto. Un opcional cuyo padre (o ancestro) está desmarcado
  se ve inactivo, `disabled`, con su marca, cubierto por la explicación del padre desmarcado.
- **Marcar todo / Desmarcar todo** (global y por elemento): ver **Pregunta 1**. Recomendación de
  diseño: «Marcar todo» **no** marca opcionales (para eso son opcionales; entre ellos hay uno con
  PII, el documento del propietario sin enmascarar); «Desmarcar todo» **sí** los desmarca.
- Opcional declarado por **dos acciones** (p. ej. la confirmación de conceptos de Siigo): el API lo
  cuelga de la primera y vale si **cualquiera** de las dos está activa. El cliente no sabe cuál es
  la otra → ver **Requerimiento R6**. Mientras no llegue, al cargar se usa el `efectivo` del
  servidor para esos códigos, y tras una edición local se recalcula con su único padre (puede decir
  «inactivo» de algo que sigue valiendo hasta guardar y recargar).

### 3. Transversales (P-29)

El contrato los entrega en `transversales`, fuera del árbol, sin padre y **sin cadena**: valen
aunque el rol no tenga ningún elemento marcado. En el panel son **la última fila de la tarjeta del
árbol** (después de Perfil, separada por `border-t` como un elemento más), con forma de elemento
pero **sin casilla propia** (no es un nodo que se guarde):

```
│ ───────────────────────────────────────────────────────────────── │
│ ▾     Permisos que no dependen del menú                 2 de 5     │
│   │ Se usan desde varias pantallas, por ejemplo al buscar un      │
│   │ vehículo por placa. Valen aunque el rol no tenga ningún       │
│   │ elemento del menú marcado.                                    │
│   │ [✓] Consultar un vehículo por placa                           │
│   │ [ ] Consultar una persona en el RUNT                          │
│   │ [ ] Leer la cédula en el RUNT                                 │
│   │ [✓] Buscar en Fasecolda                                       │
│   │ [ ] Ver el resumen RUM                                        │
```

(Los nombres de las filas son los `nombre` que trae el API; los de arriba ilustran.)

- Plegada al montar, como los elementos. Chevron y cuenta «k de n»; el hueco de la casilla
  reservado (alineación).
- Sus filas son casillas planas: nunca inactivas por un padre, nunca parciales.
- Sin «Marcar todo / Desmarcar todo» propios (son 5); los globales **sí** las tocan (no son
  opcionales; ver Pregunta 1 si el PO las quiere fuera).
- Modo usuario: mismas etiquetas de origen que el árbol (Del rol / Añadido / Quitado).
- Sustituye, para estos códigos, al bloque de defensa «Sin elemento del menú» de R4: ese bloque
  sigue existiendo **solo** para un nodo del árbol con padre desconocido (fallo del catálogo).

### 4. Ítems antiguos y la excepción PESV (P-28, P-24 A1)

Los ítems antiguos (`legado: true`) están mezclados con los FLITO dentro del mismo elemento
(Gestión tiene SOAT, Comparendos… y también Vehículos, Trámite Digital, SOAT (antiguo)). La regla
de la ficha full («un aviso por elemento antiguo») **se reemplaza** por una por tipo de ítem:

| Ítem antiguo | Chevron | Qué se explica (bajo el nombre, `--flit-text-secondary`, por `aria-describedby`) |
|---|---|---|
| Sin hijos | No | «Este ítem no se divide en acciones: marcarlo da acceso a todo lo de la pantalla.» |
| Solo con opcionales (Vehículos, Manual SARLAFT, SOAT (antiguo)) | Sí | «Marcarlo da acceso a todo lo de la pantalla, menos lo opcional que se marca aparte.» |
| PESV con «Administrar» (20 ítems) | Sí | Ninguna por ítem: la explica el elemento (abajo) |

En los elementos donde **todos** los ítems son antiguos (Flota, Mantenimiento, PESV, RNDC, LAFT),
la explicación de los ítems sin hijos va **una vez**, como primera línea del panel del elemento,
y no se repite por ítem (20+ frases iguales son ruido). Para PESV la línea dice las dos cosas:

> «En PESV, marcar un ítem da su pantalla. Donde aparece «Administrar», hace falta marcarla para
> crear y editar los registros de esa pantalla.»

```
│ ▾ [▬] PESV                                            25 de 45    │
│   │ En PESV, marcar un ítem da su pantalla. Donde aparece         │
│   │ «Administrar», hace falta marcarla para crear y editar los    │
│   │ registros de esa pantalla.                                    │
│   │   [✓] Tablero PESV                                            │
│   │ ▾ [▬] Conductores                                 1 de 2      │
│   │   │ [ ] Administrar                                           │
│   │   │     Crear, editar y gestionar los registros de esta…      │
│   │ ▸ [✓] Capacitaciones                              2 de 2      │
│   │   [✓] Estadística siniestros                                  │
│ ───────────────────────────────────────────────────────────────── │
│ ▾ [▬] Gestión                                          9 de 20    │
│   │ ▸ [▬] SOAT                                         4 de 6     │
│   │ …                                                             │
│   │ ▾ [✓] Vehículos                                               │
│   │   │ Marcarlo da acceso a todo lo de la pantalla, menos lo     │
│   │   │ opcional que se marca aparte.                             │
│   │   │ Opcional: no viene con Vehículos, se marca aparte         │
│   │   │ [ ] Ver el documento del propietario                      │
│   │   [✓] Trámite Digital                                         │
│   │       Este ítem no se divide en acciones: marcarlo da acceso  │
│   │       a todo lo de la pantalla.                               │
```

(Vehículos no lleva «k de n»: sus únicos hijos son opcionales, que no cuentan; si tuviera alguno
marcado diría «1 opcional». Las cifras de PESV y Gestión ilustran.)
Tri-estado: un ítem PESV marcado con «Administrar» sin marcar es **Parcial** (es el caso normal del
conductor) — correcto y sin aviso: `sinAcciones` del API es siempre `false` en antiguos.

Sin chip «antiguo»/«FLITO»: el origen no responde a esta visita (decisión 2 de la ficha full). Lo
que cambia el comportamiento lo dice la frase.

### 5. Excepciones por usuario: la cadena del rol manda (P-25 A, AC4)

La casilla sigue mostrando lo que el usuario **tendrá**; con P-25 A eso puede no coincidir con
«tiene la excepción». Se añade un estado de origen a la tabla de la ficha full:

| Origen | Cuándo (datos del API) | Casilla | Etiqueta | Tinta |
|---|---|---|---|---|
| **Añadido, sin efecto** | `excepcion: 'conceder'`, `marcado: true`, `efectivo: false` | ✓ inactiva (`disabled`) | «Añadido · sin efecto» | `--flit-blue-text font-semibold` en «Añadido»; «· sin efecto» en `--flit-text-secondary` |

Debajo de la fila, en `--flit-text-secondary`, enlazada por `aria-describedby`, nombrando el
**ancestro más alto que le falta al usuario** (el primero de arriba abajo con `marcado: false`):

> «No tiene efecto: a este usuario le falta «{ancestro}». Añádeselo también para que valga.»

- Sustituye, **en esa fila**, a la explicación genérica del padre desmarcado (que sigue en el
  panel del padre para el resto de hijos). Solo para `conceder`: un «Quitado» bajo un padre
  inactivo se ve como hoy, «Quitado», porque vuelve a importar en cuanto el padre se active.
- Cómo se llega a ver: al abrir el modal (excepciones que ya existían, p. ej. del modelo anterior),
  o al quitar un padre después de añadir el hijo. La UI no deja **crearla** directamente: la
  casilla de un hijo bajo un padre inactivo está `disabled` (regla de conservación), así que el
  orden natural (primero el ítem, después la acción) nunca produce una excepción sin efecto.
- Es lo que el administrador vino a revisar, así que se ve sin desplegar: el resumen de cabecera
  y el de cada padre plegado lo cuentan:
  > «Lo que trae del rol Gestor de trámites, con 3 excepciones: 2 añadidas (1 sin efecto) y 1 quitada.»
  > Padre plegado: «Del rol · 2 excepciones (1 sin efecto)».
- Al abrir el modal se siguen desplegando los ancestros de cada excepción (ficha full), así que la
  sin efecto queda a la vista con su frase.
- Recalcular en cliente tras cada clic con la misma regla que el rol (cadena sobre
  `(rol ∪ añadidos) \ quitados`), para que «sin efecto» aparezca o se vaya al tocar el ancestro.
- Transversales: sin cadena, nunca «sin efecto».

```
│ ▾ [ ] Tránsito                                      No lo trae      │
│   │ ▾ [ ] Organismos STT          (inactivo)                         │
│   │   │ [✓] Ver                            Añadido · sin efecto      │
│   │   │     No tiene efecto: a este usuario le falta «Tránsito».     │
│   │   │     Añádeselo también para que valga.                        │
```

### 6. 409 con `nodo` (AC5)

El aviso nombra **el nodo que hay que volver a marcar**, con su nombre de pantalla, en vez de una
operación técnica. Resolución del nombre (en este orden, contra el árbol ya cargado):

1. `nodo` presente y en el árbol → su `nombre` (p. ej. «Administración», «Usuarios»,
   «Roles y permisos»).
2. Si no, `funcion` si es un nodo del árbol (`pagina.users`, `pagina.roles_permisos`) → su `nombre`.
3. Si no → copy sin nombre y **sin** «Mostrar dónde está».

Copy exacto (sustituye al de la ficha full):

- **Rol** (aviso en la barra «Sin guardar», `role="alert"`, `--flit-danger-ink`, nunca toast):
  > «No se guardó: con este cambio FLITO se quedaría sin ningún usuario activo que pueda administrar Usuarios y Roles y permisos. Deja marcado «{nodo}» en este rol o dáselo antes a otro rol con usuarios activos. Tus cambios siguen aquí, sin guardar.»  [Mostrar dónde está]
- **Usuario** (`role="alert"` en el modal, sobre el pie, foco al aviso, modal abierto):
  > «No se guardó: con este cambio FLITO se quedaría sin ningún usuario activo que pueda administrar Usuarios y Roles y permisos. Deja «{nodo}» a este usuario o dáselo antes a otro usuario activo. Tus cambios siguen aquí, sin guardar.»  [Mostrar dónde está]
- **Sin nombre** (caso 3): «…Usuarios y Roles y permisos. Revisa Administración, Usuarios y Roles
  y permisos en este rol (o a este usuario) antes de guardar. Tus cambios siguen aquí, sin guardar.»

«Mostrar dónde está» despliega los ancestros de `nodo` y pone el foco **en su casilla**: como
`nodo` ya es el más alto desmarcado de la cadena, es justo el que hay que tocar (se simplifica la
regla de la ficha full, que lo buscaba a mano). El borrador no se toca; el aviso se limpia al
volver a guardar, al descartar o al cambiar de rol. Guardado OK: toast cerrable sin cambio.

### 7. `sinAcciones` (AC3) tal como lo da el API

El API cambia el sentido de AC3 respecto de la ficha full: `sinAcciones` **no** es «el ítem no
tiene acciones en el catálogo» (todos los ítems FLITO tienen ≥1); es **«ítem FLITO marcado sin
ninguna acción marcada»**. Es una **configuración probablemente incompleta**, no una descripción
del ítem. Lo de «no se divide en acciones» pasa a ser cosa de los ítems antiguos (punto 4).

- Con `sinAcciones: true`, bajo el nombre del ítem, en `--flit-text-secondary`, por
  `aria-describedby`:
  > «Marcado sin ninguna acción: quien tenga este rol verá {ítem} en el menú, pero no tendrá ninguna acción dentro. Marca al menos una acción o desmarca el ítem.»
  (Modo usuario: «Marcado sin ninguna acción: este usuario verá {ítem} en el menú, pero no tendrá ninguna acción dentro.»)
- Se ve aunque el elemento esté desmarcado (el API lo calcula sobre `marcado`, no sobre
  `efectivo`): el aviso vale para cuando se vuelva a marcar.
- Para que se encuentre sin desplegar, la cuenta del elemento plegado lo suma:
  «9 de 20 · 1 ítem sin acciones». Solo cuando ocurre; si no, no hay texto extra.
- Al cargar se usa el del API; tras cada clic se recalcula en cliente con la misma definición
  (ítem no antiguo, marcado, sin ningún descendiente `tipo: 'accion'` marcado; los opcionales no
  cuentan).
- No bloquea guardar: es un aviso, no una validación.

**Densidad:** sin empeorar. Se añaden una fila plegada (transversales), los opcionales dentro de
paneles que ya se despliegan a mano, y textos que solo aparecen cuando el caso existe (sin
efecto, sin acciones). En reposo, la tarjeta sigue mostrando 12 filas + 1.

---

## Estados (4) + copy

No cambian (ficha full). Ajustes:

- **Cargando:** el esqueleto de la tarjeta del árbol pasa de 8 a **9** barras (la última, la de
  transversales).
- **Vacío — rol sin nada marcado:** se calcula sobre el árbol **y** los transversales. Un rol con
  solo transversales no está vacío, pero no verá nada en el menú: «Este rol no tiene ningún
  elemento del menú marcado: quien lo tenga no verá nada en el menú al entrar, aunque conserve los
  permisos que no dependen de él. Marca los elementos que deba usar.»
- **Error de carga del árbol del usuario** (`GET /api/users/:id/arbol`): mismo copy y Reintentar
  de la ficha full; un 404 (usuario inexistente) se trata como error de carga, sin texto del API.

---

## Responsive + feedback del delta

- **< lg:** la fila de transversales, la de Ayuda y los rótulos de opcionales siguen las reglas de
  la ficha full (sangría `pl-4` bajo `sm`, cuentas y etiquetas caen bajo el nombre con `flex-wrap`,
  nombres envuelven, nunca truncan). «Añadido · sin efecto» cae bajo el nombre como el resto de
  etiquetas; la frase de «sin efecto» envuelve. Sin scroll horizontal.
- **Hover / foco:** chevron de transversales y casillas de opcionales/transversales = los de la
  ficha full (velo `--flit-bg-hover` en la fila, `flit-focus`). La fila de Ayuda **no** tiene
  hover (no es control). Casillas inactivas (incluida la de «sin efecto»): sin hover,
  `cursor-not-allowed`. Nada se anima.
- **Notificaciones:** sin cambio de patrón. 409 → aviso (barra o modal), con el copy del punto 6;
  guardado OK → toast cerrable; sin acciones, sin efecto, Ayuda, opcionales → texto en página.

## Accesibilidad (delta)

- Ayuda: `<li>` sin control; su frase es texto normal.
- Opcionales: el rótulo de grupo es texto visible en su propio `<li>`, y va además en el
  `aria-describedby` de cada casilla opcional, para que el lector diga «opcional» al llegar.
- Transversales: `fieldset` con `legend` sr-only «Permisos que no dependen del menú · rol {rol}».
  El botón de desplegar lleva `aria-label="Contenido de Permisos que no dependen del menú"`.
- «Sin efecto»: la etiqueta y su frase van en el `aria-describedby` de la casilla, en el orden de
  la ficha full (descripción → cuenta → explicación → origen).
- `aria-checked="mixed"` solo en nodos con hijos **no opcionales** parcialmente marcados (los
  opcionales no cuentan para el parcial).

## Permiso / slug

Sin cambio: `roles_permisos`; botones por su operación (`permisos.cuadro.guardar`,
`permisos.rol.crear|editar|borrar`, ver §9 R5 de arquitectura). El árbol del usuario usa la guarda
del módulo `usuarios` (§5-quater.10); el bloque se ve con quien hoy edita el usuario.

---

## Delta #13431 (shell) — corrección

La ficha full decía que «Ayuda» se ve **por permiso (elemento Ayuda + su ítem)**: queda **anulado**.
Decisión del PO: Ayuda es **derivada**, sin permiso propio; su visibilidad sigue en
`puedeVerAyudaFlito` (≥1 capítulo visible). Lo demás del delta (Ayuda como último elemento del
menú, enlace directo, misma posición en drawer y ⌘K) sigue. En las notas de QA de #13431, el
punto «sin el elemento Ayuda no aparece en barra ni en ⌘K» pasa a «un usuario sin ningún capítulo
visible no ve Ayuda en barra ni en ⌘K». La pregunta «Cumplimiento» vs «LAFT» quedó cerrada por el
catálogo (P-13: **LAFT**).

---

## Requerimiento de datos

- **R6 — Opcional con más de un padre.** `NodoArbolDef` trae un solo `padre`; el API decide la
  efectividad con todos (`PADRES_DE_OPCIONAL`). Para que la web recalcule «inactivo» sin mentir,
  el nodo opcional debería traer sus otros padres (p. ej. `padresAlternos?: string[]`, aditivo). Si
  no se añade, se acepta la limitación del punto 2 (el inactivo de esos códigos solo es fiable
  tras recargar). Dueño: architecture/backend.

## Preguntas abiertas (producto, no diseño)

1. **«Marcar todo» y lo opcional.** ¿«Marcar todo» (global y por elemento) marca también los
   opcionales y los transversales? Recomendación: opcionales **no** (el sentido de P-26 es que no
   vienen solos, y uno es PII); transversales **sí**. «Desmarcar todo» quita todo en ambos casos.
   Afecta solo a esos botones; el resto del delta no depende de esto.
2. **Ítem antiguo con opcional y `sinAcciones`.** Confirmar que un ítem antiguo marcado sin su
   opcional (p. ej. Vehículos sin «Ver el documento del propietario») **no** avisa: el API da
   `false` y el diseño no avisa. Si el PO quiere aviso, cambia el contrato, no la UI.

## Notas para QA (≤ 10)

1. Ayuda: sin casilla ni chevron, con su frase; el `PUT` nunca lleva `menu.ayuda` (si lo llevara, 400).
2. Opcionales al final del panel de su padre con el rótulo «Opcional: no viene con…»; un padre
   con todas sus acciones y sin opcionales se ve `[✓]`, sin `aria-checked`.
3. Transversales: última fila plegada; marcar uno con el rol sin ningún elemento marcado se guarda
   y recarga marcado; nunca se ve inactivo.
4. Antiguos: Trámite Digital sin chevron con su frase; PESV con una sola frase en el panel; un ítem
   PESV marcado sin «Administrar» se ve parcial y sin aviso.
5. AC3: marcar SOAT y desmarcar todas sus acciones → aparece el aviso exacto y la cuenta del
   elemento plegado dice «· 1 ítem sin acciones»; marcar una acción lo quita.
6. AC4 / P-25: usuario cuyo rol no tiene Organismos STT con «Ver» concedido → «Añadido · sin
   efecto» + frase con «Tránsito» (o el ancestro más alto que falte); añadir ese ancestro y el ítem
   → pasa a «Añadido» activo; el resumen cuenta «(1 sin efecto)».
7. AC5: desmarcar «Administración» en el único rol administrador con usuarios activos → aviso con
   «Administración» (de `nodo`), sin texto del API, sin toast; «Mostrar dónde está» enfoca la
   casilla de Administración. Sin `nodo` → cae a `funcion` o al copy sin nombre.
8. Modal de usuario: 409 en `role="alert"`, modal abierto, foco al aviso.
9. 360 px: «Añadido · sin efecto», rótulos de opcionales y la fila de transversales envuelven sin
   scroll horizontal, en claro y oscuro.
10. Mutante sugerido: contar los opcionales en el parcial del padre — debe caer el aserto del punto 2.

## Decisiones de David (2026-10-15) sobre las preguntas abiertas

- **P-31.** «Marcar todo» (global y por elemento) marca las **transversales** pero **no** los opcionales. «Desmarcar todo» quita todo.
- **P-32.** Un ítem antiguo marcado sin su opcional **no** muestra aviso (contrato sin cambios: `sinAcciones: false`).
