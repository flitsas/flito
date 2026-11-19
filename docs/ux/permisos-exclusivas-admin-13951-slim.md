# UX slim — Roles y permisos: funciones exclusivas del Administrador (HU #13951)

> Delta sobre el panel del árbol (`apps/web/src/pages/RolesPermisos.tsx` → `roles-permisos/CuadroRol.tsx`
> → `ArbolPermisos` → `NodoArbol.tsx`). Diseño base: `docs/ux/roles-y-permisos-panel.md` y las fichas
> de la #13430. Público: administrador (operador interno). Sin pantalla nueva, sin componente nuevo,
> sin token nuevo. **Molde que se calca:** los nodos «cerrados por el enlace» de la #13452 (casilla
> bloqueada + nota de una línea + `aria-describedby`), que ya viven en el mismo `FilaNodo`.

## Superficie tocada

- `FilaNodo` (casilla de **un** nodo con `exclusivaAdmin: true`) — solo en **modo `rol`**.
- «Marcar todo» / «Desmarcar todo» (los del rol en `CuadroRol` y los de cada elemento en `PanelNodo`).
- La cuenta «k de n» y el tri-estado del ancestro.
- El aviso de error de la barra de guardado (409).
- **No se tocan:** cabecera del rol, lista de roles, modales, modo `usuario` (`PermissionsPicker`).

Requisito previo en el modelo: `normalizar()` (`arbol.ts`) hoy **descarta** `exclusivaAdmin`. Hay que
copiarlo al `Nodo`; sin eso no hay nada que pintar. El dato ya llega del API: no hay requerimiento de
backend.

«¿Es el rol Administrador?» = `rol.codigo === 'admin'` (código canónico de `USER_ROLES`; el servidor
decide con el mismo literal). No se infiere de `marcado`.

## Delta de claridad (qué se ve / qué se calla)

**Qué vino a hacer:** ajustar lo que puede hacer un rol. El delta solo responde una pregunta que hoy la
pantalla contesta mal: *«¿por qué no puedo darle esto al Coordinador?»* — hoy la casilla se deja marcar
y el guardado revienta con un 409. Se adelanta la respuesta a la propia casilla.

**Se ve, en la fila de la función exclusiva** (y solo ahí):

```
Otro rol (Coordinador)                         Administrador
──────────────────────────────────────         ──────────────────────────────────────
  ☐ Eliminar clientes          (gris)            ☑ Eliminar clientes
     Borra el cliente y su historial.               Borra el cliente y su historial.
     Exclusiva del Administrador: no se             Exclusiva del Administrador: este
     puede dar a otro rol.                          rol siempre la tiene.
```

| | Otro rol | Administrador |
|---|---|---|
| Casilla | Desmarcada, bloqueada | Marcada, bloqueada |
| Nombre de la función | `--flit-text-secondary` (igual que un nodo cerrado por enlace) | Color normal del nivel (`--flit-text-primary`): **sí** la tiene, no es una función apagada |
| Nota (línea propia, bajo la descripción, `ml-8 text-sm`, `--flit-text-secondary`, `data-aviso="exclusiva-admin"`) | **«Exclusiva del Administrador: no se puede dar a otro rol.»** | **«Exclusiva del Administrador: este rol siempre la tiene.»** |
| Hover de la fila (`label`) | Ninguno; `cursor-not-allowed` | Ninguno; `cursor-not-allowed` |

- La nota empieza **siempre** por el literal del AC («Exclusiva del Administrador»). Las dos frases son
  impersonales: no meten ni «tú» ni «usted», así que no rompen el tuteo que ya tiene el panel
  («Marca al menos una acción…», «Tus cambios siguen aquí»).
- **Se calla:** ningún chip, candado, icono ni contador «n exclusivas» en el elemento o en la cabecera.
  Son 4 funciones en todo el árbol; un rótulo por encima convertiría una excepción en decorado. El
  código técnico sigue solo en `data-codigo`.
- Sin `opacity` (decisión 30 de #12717): el gris es tinta de token, no transparencia.

**«Marcar todo» / «Desmarcar todo» con una exclusiva dentro:**

| Rol | «Marcar todo» (rol o elemento) | «Desmarcar todo» (rol o elemento) |
|---|---|---|
| Otro rol | **Se salta** las exclusivas (mismo `.filter` que ya aplica a `cerrados`) | Sin cambio |
| Administrador | Sin cambio (ya están marcadas) | **Se salta** las exclusivas: quedan marcadas |

Sin aviso extra por haberlas saltado: la nota de la fila ya explica por qué esa casilla no cambió.

**Contador «k de n» y tri-estado:**

- **Otro rol:** las exclusivas **no cuentan** en `n` ni impiden el estado «marcada» del ancestro. Si
  contaran, un elemento con «Marcar todo» se quedaría en «11 de 12» y en parcial para siempre, y el
  administrador buscaría la casilla que le falta sin poder marcarla. La cuenta tiene que poder llegar
  a `n`.
- **Administrador:** cuentan con normalidad (las tiene).
- **Lista de roles (`k/total` a la izquierda): sin cambio.** El total es único para todos los roles;
  hacerlo por rol se sale del alcance. Nota para el PO, no bloquea.
- **`PUT`:** para otro rol, `funcionesParaGuardar` **nunca** envía una exclusiva; para el
  Administrador, **siempre** la envía. Así el 409 queda como red de seguridad (carrera, dato
  heredado), no como camino normal.

**Dato heredado:** si un rol que no es el Administrador llega del API con una exclusiva `marcado: true`
(no debería, tras la #13944), se pinta **desmarcada** con su nota y el siguiente guardado la quita (por
la regla del `PUT`). Contará como «1 desmarcada» en la barra de guardado, que es la verdad.

**Primaria:** sin cambio — «Guardar cambios» (solo con cambios). El delta no añade botones.

**Densidad:** sin cambio (una línea de nota en 4 filas del árbol, todas plegadas por defecto).

## Estados (4) + copy

| Estado | Cambio |
|---|---|
| Cargando | **No cambia** (esqueleto actual) |
| Error de carga | **No cambia** (mensaje + «Reintentar» actual) |
| Vacío | **No cambia.** El vacío «rol sin ninguna función» sigue igual; una exclusiva bloqueada no cuenta como marcada en otro rol |
| Lleno | Delta de arriba |

**Error al guardar — 409 `FuncionExclusivaAdmin` (AC3).** Mismo canal que el 409 anti-bloqueo:
**aviso en página** (`role="alert"` sobre la barra de guardado, foco al mensaje, los cambios no se
pierden), **no toast** — el estado «sin guardar» sigue siendo cierto mientras se mira la página.

Hoy `cuerpoAntiBloqueo` trata **todo** 409 como anti-bloqueo y pintaría «FLITO se quedaría sin ningún
usuario…», que es falso. Discriminación: si `funcion` (o `nodo`) del cuerpo resuelve en el índice a un
nodo con `exclusivaAdmin` → copy de exclusiva; si no → el anti-bloqueo actual. **Nunca** se pinta
`error` del cuerpo (el texto del API).

| Caso | Copy exacto |
|---|---|
| Otro rol | **«No se guardó: «{nombre}» es exclusiva del Administrador y no se puede dar a otro rol. Desmárcala y vuelve a guardar. Tus cambios siguen aquí, sin guardar.»** |
| Administrador | **«No se guardó: «{nombre}» es exclusiva del Administrador y este rol no la puede perder. Vuelve a marcarla y guarda de nuevo. Tus cambios siguen aquí, sin guardar.»** |
| `funcion` no resuelve en el índice | Cae al anti-bloqueo genérico actual (sin nombre ni «Mostrar dónde está») — no se inventa un nombre |

Con nombre resuelto se mantiene **«Mostrar dónde está»** (despliega los ancestros y lleva el foco a la
casilla), igual que en el anti-bloqueo. Tono: tuteo, el de la barra de guardado de esta pantalla.

## Responsive + feedback del delta

- **<`lg`:** la nota es un `<p>` de bloque bajo la descripción y envuelve como las demás notas del
  árbol (`break-words`); nada nuevo en línea con la cuenta. El aviso 409 ya envuelve
  (`flex-wrap`, botón debajo del texto).
- **Feedback:** la casilla bloqueada **no** lleva hover (no es un control activo) y lleva
  `cursor-not-allowed`; **sí** conserva el foco visible del kit (`flit-focus`), porque con
  `aria-disabled` sigue en el orden de tabulación (ver a11y). «Marcar/Desmarcar todo» y «Mostrar
  dónde está» no cambian (ya tienen hover + foco).
- **Notificación:** guardado OK → toast actual, sin cambio. 409 exclusiva → aviso en página
  (arriba). Marcar todo que se salta exclusivas → sin notificación.

## Accesibilidad (AC4)

- La casilla exclusiva usa **`aria-disabled="true"`** y **no** el atributo `disabled` nativo: así sigue
  enfocable y el lector de pantalla lee la nota al llegar a ella. El `onChange` no hace nada (el
  `checked` controlado no cambia); `Espacio` tampoco la altera.
- La nota lleva `id` propio (`idDe(idBase, 'excl', codigo)`) y entra en el `aria-describedby` de la
  casilla **justo después de la descripción** (orden: descripción → nota exclusiva → cuenta → resto).
- `aria-checked` sigue la regla actual (solo `mixed` en parcial); una exclusiva es hoja.
- Contraste: la nota y el nombre en gris usan `--flit-text-secondary`, ya validado ≥ 4.5:1 en ambos temas.

## Permiso/slug

Sin cambio: página `roles`, guardas actuales del router de `/api/permisos/*`. El bloqueo es de
presentación; quien manda es el 409 del `PUT /api/permisos/roles/:codigo/funciones`.

## Notas para QA (≤10)

1. Coordinador → «Eliminar clientes»: desmarcada, `aria-disabled="true"`, nota visible que contiene «Exclusiva del Administrador» (usar `toContainText`, no igualdad exacta), y está en su `aria-describedby`.
2. Clic y `Espacio` sobre esa casilla: no cambia, no aparece la barra «Sin guardar».
3. Administrador → las 4 exclusivas marcadas; clic no las desmarca; nota «…este rol siempre la tiene.»
4. Coordinador → «Marcar todo» del rol y del elemento: todo marcado menos las exclusivas; el elemento llega a «n de n» y a estado «marcada» (no parcial).
5. Administrador → «Desmarcar todo»: las exclusivas siguen marcadas.
6. `PUT` interceptado: otro rol nunca lleva una exclusiva; Administrador siempre la lleva.
7. 409 simulado con `{ error, funcion: '<código exclusiva>' }`: aviso `role="alert"` con el copy de la tabla, foco en el aviso, cambios intactos, «Mostrar dónde está» enfoca la casilla; el texto de `error` del API **no** aparece.
8. 409 anti-bloqueo (función no exclusiva) sigue mostrando su copy de siempre.
9. Modo usuario (`PermissionsPicker`): sin cambio en esta HU.
10. Ambos temas y 390 px: la nota envuelve y se lee; sin chip ni icono nuevo.

## Pregunta abierta (no bloquea)

¿Las exclusivas deben bloquearse también en **permisos por usuario** (excepción «Añadido» a un usuario
que no es Administrador)? Los AC solo hablan del rol; este delta lo deja fuera. Si el API lo rechaza
igual, hoy ese caso daría el 409 genérico en el modal de usuario.
