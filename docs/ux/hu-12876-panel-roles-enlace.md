# UX slim — Panel de roles: sin tipo y con enlace único de cuatro opciones (HU #12876)

Feature #12871 · Épica #13411 · Público: administrador de FLITO (operador interno), **no** canal Cliente.
Tono: **tú**, el que ya usa el panel de roles («Escribe el nombre del rol», «Cambia el nombre»). No se unifica con usted.

## Superficie tocada

| Superficie | Archivo hoy | Qué cambia |
|---|---|---|
| Modal Nuevo rol / Editar el rol | `apps/web/src/pages/roles-permisos/RolFormModal.tsx` | Se quita el fieldset «Tipo de acceso». El `FlitSelect` «Ámbito de sus usuarios» pasa a un grupo de radios **Enlace** con 4 opciones y su ayuda |
| Cabecera del cuadro del rol | `roles-permisos/CuadroRol.tsx` (l. 105, 109, 115-126, 236, 332) | Fuera el chip «Externo», el «Interno · / Externo ·» de la línea de metadatos, el aviso naranja de canal externo y el «No aplica a roles externos» por función |
| Lista de roles | `roles-permisos/ListaRoles.tsx` (l. 32, 61) | Fuera el chip «Externo» y la nota «externo» del selector móvil |
| Textos compartidos | `roles-permisos/modulos.ts` (l. 182-208, 230-233) | `ETIQUETA_ENLACE`, `AYUDA_ENLACE` y `ENLACE_EN_CABECERA` con el copy nuevo; `ETIQUETA_ACCESO` y `funcionesFueraDelCanal` dejan de usarse |
| Editor de usuarios (campo de proveedor) | `pages/users/AtaduraFields.tsx` (l. 25-33) | «Proveedor SOAT» → «Proveedor» en la etiqueta y en todos sus estados |
| Historial de permisos | `pages/users/HistorialPermisos.tsx` (l. 290, 292, 374) | Etiquetas del enlace y del valor del proveedor; se quita la traducción de tipo interno/externo para cambios nuevos (ver Notas) |

**Dónde se escoge la compañía, el proveedor o las secretarías concretas: en el usuario, no en el rol.** Así está hoy (`users/Ambito.tsx` + `AtaduraFields.tsx`: `companiaId`, `flitoProveedorSoatId`, `organismosCodigos`). El rol solo dice **qué tipo** de enlace exige; esta HU **no** añade ningún selector al rol.

## Delta de claridad (qué se ve / qué se calla)

**Qué vino a hacer el administrador:** dar de alta o ajustar un rol y decidir qué parte de los datos ven sus usuarios. Lo que desbloquea esa decisión es el **Enlace**; antes competía con «Tipo de acceso», que era la elección «con más consecuencias» y ya no existe.

**Densidad: aliviada.** Se va un bloque entero (tipo de acceso + nota + aviso de cambio) y el aviso naranja permanente del cuadro de roles externos. Entra la ayuda de las 4 opciones, pero visible a la vez (hoy solo se veía la de la opción elegida en el select). El formulario queda: Nombre → Descripción → Enlace → (al editar) «Se puede asignar a usuarios nuevos».

### Se quita (AC1)
- Fieldset «Tipo de acceso» completo: las dos opciones (`Interno — trabaja dentro de FLITO` / `Externo — solo el canal de cliente`), sus ayudas, la nota «El tipo de acceso no se deduce del nombre…» y el aviso «Al guardar, dejan de entrar a las pantallas internas…».
- `tipoPrincipal` en el cuerpo de crear y de editar (lo que acepte el API lo cierra #12875; si el API aún lo exige, es bloqueante de backend, no se rellena desde la UI).
- En el cuadro: `COPY_EXTERNO_GENERAL`, el aviso «Tiene N funciones marcadas fuera del canal…», la lista de funciones fuera del canal, la marca «No aplica a roles externos» y el chip «Externo» (cuadro y lista).
- En la línea de metadatos del cuadro: el prefijo `Interno ·` / `Externo ·`.

### Se agrega (AC2) — copy exacto

Grupo de radios (fieldset + legend), mismo marcado que el fieldset de «Tipo de acceso» que se retira: `input type="radio"` con `flit-focus`, etiqueta en `text-sm` `--flit-text-primary`, ayuda en `text-xs` `--flit-text-secondary` enlazada con `aria-describedby`.

- **Legend:** `Enlace`
- **Ayuda del grupo (debajo de la legend, antes de las opciones):** `Decide qué datos ven las personas con este rol. La compañía, el proveedor o las secretarías de cada una se eligen en Usuarios.`

| Valor (`TipoEnlace`) | Opción (`ETIQUETA_ENLACE`) | Ayuda breve (`AYUDA_ENLACE`) |
|---|---|---|
| `ninguno` | **Ninguno** | Ve todos los datos de los módulos que este rol tenga marcados. |
| `compania` | **Compañía** | Ve solo lo de su compañía en Gestión Trámites, SOAT, Impuestos, su bolsa, Comprobantes y Logística. No ve catálogos ni configuración; el resto le queda cerrado. |
| `proveedor_soat` | **Proveedor** | Ve solo lo asignado a su proveedor. Hoy aplica a SOAT. |
| `organismos_transito` | **Organismos** | Ve solo lo de sus secretarías de tránsito en Impuestos y Derechos de tránsito. El resto le queda cerrado. |

Orden fijo: Ninguno, Compañía, Proveedor, Organismos (el de `TIPOS_ENLACE`; si el arreglo trae otro orden, se pinta en este). Default al crear: **Ninguno**. Ninguna opción menciona nombres de rol.

Se **mantiene** el aviso de bloqueo al editar un rol con usuarios (409 del API), solo con el nombre nuevo del campo, debajo del grupo, `--flit-warning-ink`:
`{1 usuario ya tiene | N usuarios ya tienen} este rol: FLITO no deja cambiar el enlace mientras alguien lo tenga. Cámbiales el rol en Usuarios y vuelve aquí.`

### Cabecera del cuadro (`ENLACE_EN_CABECERA`)
Línea de metadatos: `Enlace: {Ninguno | Compañía | Proveedor | Organismos} · {N usuarios}`. Se reusa `ETIQUETA_ENLACE`; `ENLACE_EN_CABECERA` puede retirarse.

### Control recomendado: radio group, no select
Cuatro opciones con ayuda de una o dos frases que **cambian lo que ve el usuario**. En un select la ayuda solo se lee de la opción ya elegida: para comparar hay que abrir, elegir y leer cuatro veces. Con radios las cuatro se leen de un vistazo y la elección queda a un clic/flecha. Cuatro es el techo cómodo de un grupo de radios; no hay riesgo de crecer (el AC fija cuatro). No es patrón nuevo: el propio modal ya usaba este fieldset para «Tipo de acceso».

### Proveedor en el editor de usuarios y en el historial (AC3)
- Etiqueta del campo: `Proveedor` (era «Proveedor SOAT»). Resto del campo, mismo tono que tiene hoy:
  - Placeholder: `Seleccione proveedor…` (sin cambio)
  - Ayuda: `Define qué cola de SOAT ve este usuario: solo los trámites de ese proveedor.` (sin cambio; nombra el módulo, no el enlace)
  - Cargando: `Cargando proveedores…`
  - Error: `No se pudieron cargar los proveedores.` + botón `Volver a cargar proveedores`
  - Vacío: `No hay proveedores activos. Crea uno en Clientes y proveedores antes de asignar este enlace.`
  - Requerido: `Selecciona el proveedor para este rol.`
  - Relogin: sin cambio.
- Historial: enlace → `Ninguno`, `Compañía`, `Proveedor`, `Organismos`; valor → `Proveedor {nombre/id}` (era «Gestor SOAT …»).

## Textos «gestor SOAT» / «proveedor SOAT» visibles en `apps/web` (grep)

Solo copy que se pinta. Identificadores (`flitoProveedorSoatId`, `ProveedorSoatField`, `proveedor_soat`, `gestorSoatSinTramite`, rutas `/proveedores-soat`) **no** se renombran: no son pantalla.

| Archivo:línea | Texto hoy | Texto nuevo |
|---|---|---|
| `pages/roles-permisos/modulos.ts:185` | `Un gestor SOAT` | `Proveedor` |
| `pages/roles-permisos/modulos.ts:193` | `…elegirle un gestor SOAT, y solo verá los trámites de ese gestor.` | ayuda de la tabla de arriba |
| `pages/roles-permisos/modulos.ts:201` | `Se atan a un gestor SOAT` | `Enlace: Proveedor` |
| `pages/users/HistorialPermisos.tsx:290` | `Un gestor SOAT` | `Proveedor` (y el resto del mapa: `Ninguno`, `Compañía`, `Organismos`) |
| `pages/users/HistorialPermisos.tsx:374` | `Gestor SOAT ${v}` | `Proveedor ${v}` |
| `pages/users/AtaduraFields.tsx:25` | `Proveedor SOAT` (label) | `Proveedor` |
| `pages/users/AtaduraFields.tsx:28` | `Cargando proveedores SOAT…` | `Cargando proveedores…` |
| `pages/users/AtaduraFields.tsx:29` | `No se pudieron cargar los proveedores SOAT.` | `No se pudieron cargar los proveedores.` |
| `pages/users/AtaduraFields.tsx:30` | `No hay proveedores SOAT activos. …este ámbito.` | `No hay proveedores activos. …este enlace.` |
| `pages/users/AtaduraFields.tsx:32` | `Selecciona el proveedor SOAT para este rol.` | `Selecciona el proveedor para este rol.` |
| `pages/Clients.tsx:590` | `No hay proveedores SOAT.` | `No hay proveedores. Crea el primero con «Nuevo proveedor».` |
| `pages/Clients.tsx:645` | `Nuevo proveedor SOAT` (título del modal) | `Nuevo proveedor` |
| `content/ayuda/clients.md:26` | `No hay proveedores SOAT.` | alinear con Clients.tsx:590 |

Ayuda in-app, también afectada (no lleva «SOAT» pero describe lo que se quita): `content/ayuda/roles_permisos.md:20` («**Ámbito de sus usuarios** y **Tipo de acceso** (interno o externo)») → `nombre, descripción y **Enlace** (Ninguno, Compañía, Proveedor u Organismos)`. Va por la skill `flit-ayuda-flito`.

Comentarios de código con «proveedor SOAT» (`Clients.tsx:35, 351`, `AtaduraFields.tsx:1, 161`, `Perfil.tsx:12`, `Soat.tsx:29`, `users/types.ts:33`) no se pintan: fuera del AC.

**Pregunta abierta (no bloquea el panel):** `Clients.tsx:590/645` son la pantalla Clientes y proveedores, no roles ni usuarios. El AC3 dice «en ninguna pantalla», así que la spec los incluye. Si el PO solo quiso decir roles y usuarios, se sacan de esta HU y no se tocan.

## Estados (4) + copy

| Superficie | Cargando | Error | Vacío | Lleno |
|---|---|---|---|---|
| Modal de rol | No carga datos (las opciones son fijas). Al enviar: botones deshabilitados, primaria con su texto | Validación en línea, sin cambios. 409 de código duplicado: sin cambios. 409 por enlace con usuarios: el aviso de arriba ya avisa antes. **Otro error:** `role="alert"` con `No se pudo guardar el rol. Inténtalo de nuevo; si se repite, recarga la página.`, **no** `errorMessage(err)` crudo | No aplica | Formulario con Enlace preseleccionado (Ninguno al crear; el del rol al editar) |
| Cuadro del rol | Sin cambio | Sin cambio | Sin cambio (`COPY_VACIO_ROL_SIN_FUNCIONES`) | Cabecera más corta: nombre (+ «Inactivo» si aplica), `Enlace: X · N usuarios`, descripción. Sin aviso naranja |
| Lista de roles | Sin cambio | Sin cambio | Sin cambio | Sin chip «Externo» |
| Campo Proveedor en Usuarios | `Cargando proveedores…` | `No se pudieron cargar los proveedores.` + `Volver a cargar proveedores` | `No hay proveedores activos. Crea uno en Clientes y proveedores antes de asignar este enlace.` | Select con la etiqueta `Proveedor` |

**Primaria:** sin cambio, `Crear rol` / `Guardar cambios` (`GradientButton`); `Cancelar` secundaria. En el cuadro, `Guardar` sigue igual.

## Responsive + feedback del delta

- **Móvil (<`lg`):** el grupo de radios ya es una columna (`flex flex-col gap-2`); cada ayuda envuelve bajo su opción y no se trunca. El modal hace scroll con su `overflow-y-auto` de `FlitModal`. En el cuadro, la línea de metadatos envuelve (`flex-wrap` del contenedor existente).
- **Feedback:** toda la `<label>` de cada opción es zona de clic (radio + texto + ayuda), con hover sutil de fondo `--flit-bg-hover` y `transition-colors`, radio `rounded` y padding `px-2 py-1.5` para que el velo no quede pegado al texto. Foco: `flit-focus` en el radio. La opción elegida: solo el radio marcado y la etiqueta en `font-semibold`; sin borde ni fondo de acento.
- **Notificación:** sin cambio en éxito (el panel ya cierra el modal y refresca el rol). Error al guardar: en el modal, `role="alert"` (no toast), con el copy pulido de arriba.
- **Tema oscuro:** solo tokens con par oscuro (`--flit-text-primary`, `--flit-text-secondary`, `--flit-bg-hover`, `--flit-warning-ink`).

## Permiso/slug

Sin cambio: misma página de roles y permisos (`RolesPermisos.tsx`) y mismo `PageSlug`/funciones que hoy; esta HU no crea ruta ni función. El editor de usuarios conserva su permiso.

## Accesibilidad (AC4)

- `<fieldset>` + `<legend>Enlace</legend>`; la ayuda del grupo con `id` y `aria-describedby` en el fieldset.
- Cada radio: `name="rol-enlace"`, `<label>` que lo envuelve, `aria-describedby="rol-enlace-<valor>-ayuda"`. Flechas cambian de opción (comportamiento nativo).
- El aviso de bloqueo por usuarios, si aparece, también va en el `aria-describedby` del fieldset.
- Contraste ≥ 4.5:1 de la ayuda en claro y oscuro (`--flit-text-secondary` ya lo cumple en el modal hoy).

## Notas para QA (≤10)

1. Crear rol: no existe «Tipo de acceso» ni la palabra «Interno»/«Externo» en el modal; el POST no lleva `tipoPrincipal`.
2. El grupo Enlace muestra las 4 opciones con su ayuda a la vez, en el orden Ninguno, Compañía, Proveedor, Organismos; al crear viene Ninguno.
3. Editar un rol con usuarios y cambiar el enlace: aparece el aviso «FLITO no deja cambiar el enlace…».
4. Cuadro de un rol que antes era externo: sin chip «Externo», sin aviso naranja, sin «No aplica a roles externos».
5. `Enlace: Proveedor` en la cabecera del cuadro de un rol con `proveedor_soat`.
6. Editor de usuarios con rol de enlace Proveedor: la etiqueta dice «Proveedor»; cargando/error/vacío/requerido sin la palabra «SOAT» tras «proveedor».
7. Historial de permisos: un cambio de enlace se lee «Proveedor»; ningún «Gestor SOAT».
8. Grep de pantalla: `rg -i "gestor soat|proveedor(es)? soat" apps/web/src` solo debe dejar comentarios e identificadores (ver tabla).
9. Teclado: Tab llega al grupo, flechas recorren las 4, foco visible en claro y oscuro; móvil 360 px sin desborde.
10. Error de red al guardar: copy pulido en el modal, no el mensaje crudo del API.

Historial con registros viejos que traen `tipo_principal`: se siguen pintando como hoy (es pasado auditado); solo deja de generarse.
