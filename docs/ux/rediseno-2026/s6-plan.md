# S6 — Administración y transversales · plan de migración (Épica #14560)

Rama `FEATURE/14560-davidchica-rediseno-ui-kit-2026-s6`. Fase 1: inventario y plan; no toca código de producto.
Molde: `flit` rama `propuesta-2`, `docs/design/propuesta-ui-kit-2026/` (`propuesta.js`, `datos.js`, `ui-kit-2026.css`).
Implementación de referencia: `flit` rama `develop`, `packages/ui/src/*`. Los nombres de componente de abajo son los de
`packages/ui` (CabeceraModulo, Miga, TarjetaMetrica, DataTable, ChipsFiltro, Pestanas, Modal, StatusBadge, Interruptor,
Loader, InlineAlert, UiStateBoundary, ActionsMenu, Pagination, Icono); al llegar «S0 LISTO» se cambian por sus
equivalentes del catálogo `components/flit/` de `docs/ux/rediseno-2026/README.md`.

## Piezas comunes del molde que usan todas mis páginas

- **Cabecera** (`cabecera()`): ilustración del módulo + miga de pan (Inicio › sección › actual en azul con línea) + `h1` +
  texto + acciones a la derecha (primaria píldora azul, el resto secundarias).
- **Tarjeta** (`section.card` + `card__cabeza` con `h2`, texto y botón `sm secondary`): borde `#A9C9FC` 1 px, radio 9 px, sin sombra.
- **Lista** (`lista()`): panel de filtros + chips de estado con conteo (`embudo`) + barra de acción del filtro + tabla con
  borde, encabezado `#A9C9FC`, columna «Acciones» con menú, paginación de 10; bajo 900 px la tabla pasa a tarjetas
  (`data-etiqueta`). Vacío: ilustración + «No hay resultados con ese filtro» + «Quitar filtros».
- **Estados**: `badge--icono` (etiqueta con punta, ícono de estado, color semántico al 10 %).
- **Cargando**: pista azul + vehículo + línea turquesa (`cargandoHtml`), esqueletos en cifras. **Error**: `errorCarga()` con reintento.
- **Modal** (formularios `form:*`): contenedor blanco, ícono centrado, fondo azul 50 % con desenfoque.
- **Aviso** (`#aviso`): toast inferior que se cierra solo; en FLITO, ToastFlito cerrable (regla 13).

## Por página

| Página / ruta | Molde de la propuesta | Componentes del kit | Specs E2E |
|---|---|---|---|
| `Dashboard.tsx` (`/`) | `vInicio()` (`#inicio`): banner en carrusel + 4 cifras a la derecha, rejilla 2 con dona «Distribución» y barras «Seguimiento», rejilla 2 con Accesos rápidos y Actividad reciente, tarjeta «Módulos» (lanzador por grupos) | Banner carrusel, TarjetaMetrica ×4 (Vehículos, SOAT vigentes, Por vencer 60 d, RNDC errores; `metrica--pendiente` si >0), Dona, BarrasGrupo, Accesos (atajos Mantenimiento/RNDC/PESV/Tablero ejecutivo), lista de actividad con StatusBadge | `dashboard.spec.ts` |
| `admin/RumSummary.tsx` (`/admin/rendimiento`) | `vReportes()` (cifras + tarjetas + barras) | CabeceraModulo, TarjetaMetrica, tarjeta con `ul.barras`, DataTable, StatusBadge, Loader/InlineAlert | (sin spec propio; se cubre en `permisos-*` si aplica) |
| `admin/TramitesMetricas.tsx` (`/admin/tramites-metricas`) | `vReportes()`: pestañas o rejilla de tarjetas por métrica (Adopción, Notificaciones por canal, Portal externo, Pre-vuelo, Rechazos OT), dona por categoría y barras | CabeceraModulo, Pestanas (si se separan las 5 métricas), Dona, barras, TarjetaMetrica | — |
| `Users.tsx` + `users/*` (`/users`) | `MODULOS.usuarios` pestaña «Usuarios» (`lista()` con estados activo/invitado/…, barra «invitaciones sin aceptar», acción «Invitar colaborador») + formulario `invitar-usuario` (modal ancho, rol como tarjetas) | CabeceraModulo (acción primaria «Crear usuario»), ChipsFiltro de estado, panel de filtros (UsersToolbar), DataTable + ActionsMenu (UsersTable), Pagination, Modal para Create/Edit/Password, campos del kit (Ambito, AtaduraFields, CompaniaField, PermissionsPicker con Interruptor/checkbox), HistorialPermisos como tarjeta con tabla | `users-permisos.spec.ts`, `permisos-menu-sin-rol`, `permisos-exclusivas-admin`, `permisos-botones-funcion` |
| `RolesPermisos.tsx` + `roles-permisos/*` (`/roles-permisos`) | `vRbac()`: rejilla 2 — tarjeta «Roles» (lista de botones `rol` con `aria-pressed`, ámbito en `small`, «Nuevo rol» secundario ancho) + tarjeta «Permisos del rol X» con «Guardar permisos» primario y matriz | ListaRoles → lista `rol`; CuadroRol → tarjeta cabeza; ArbolPermisos/NodoArbol → **se conserva el árbol** (FLITO tiene permisos por página/función, no matriz Ver/Crear/Editar/Eliminar) vestido como tabla-matriz del kit; RolFormModal/BorrarRolModal → Modal | `roles-permisos.spec.ts`, `permisos-arbol.spec.ts`, `permisos-rendimiento.spec.ts` |
| `Perfil.tsx` (`/perfil`) | `vPerfil()`: cabecera «Mi perfil» (texto: nombre · rol · compañía) con acción «Cambiar contraseña» → `form:contrasena` (modal) + `vConfigForm()` con los datos | CabeceraModulo, tarjeta de formulario (solo lectura donde hoy lo es), Modal de contraseña, ToastFlito | `perfil.spec.ts` (cambia: la contraseña pasa de sección en página a modal) |
| `FlitoAyuda.tsx` + `components/ayuda/*` (`/ayuda`) | `vAyuda()`: cabecera «Ayuda» + «Escribir a soporte», tarjeta con buscador con ícono, rejilla `accesos` (ilustración + título + descripción) | AyudaIndice/AyudaArbolFichas → buscador + `accesos` por grupo; AyudaFicha → cabecera con miga (Ayuda › ficha) + tarjeta con tipografía del manual (32/24/16/12), AyudaTablaContenido lateral que pasa arriba bajo `lg`; AyudaEstados → StatusBadge; AyudaImagen con borde del kit | `flito-ayuda-*` (10 specs), `ayuda-capturas.capturas.spec.ts` |
| `components/drflit/*` (asistente flotante) | Sin molde propio. Derivar de Modal + panel desplegable de notificaciones (único lugar con sombra: menú y sus menús) e ícono `asistente` de `kit-iconos.js` | Botón flotante redondo azul con ícono `asistente`, panel tipo menú (sombra 3,3,3 `#557EFF` 30 %), mensajes como tarjetas, Loader, InlineAlert para aviso IA, botones píldora | `dr-flit-*` (10 specs) |
| `ErrorBoundary`, `NoAccess`, `AvisoPermisosNoComprobados` | Vacío/error del molde (`div.vacio` con ilustración + texto + botón) | UiStateBoundary / InlineAlert, Button | `permisos-menu-sin-rol`, `auth.spec.ts` |
| `ExpedienteVisor`, `OcrUpload`, `Pipeline`, `RuntLookup`, `BatchValidator` | `carga carga--lista` (zona de carga), `PasosHorizontal` (Pipeline), consulta de placa (`#consulta`, Placa) | Placa, PasosHorizontal, Loader, InlineAlert, DataTable, StatusBadge, Button | specs de los módulos que los usan (otras sesiones); `api-tope-y-descargas.spec.ts` |

Fichas de ayuda: `content/ayuda/users.md`, `roles_permisos.md`, `dashboard.md` se reescriben con la UI nueva (skill `flit-ayuda-flito`).
Specs del shell (`auth`, `command-palette-claro/oscuro`, `kit-flit-tema-oscuro`, `modales-encima-del-menu`): se actualizan cuando el integrador entregue el shell nuevo.

## Orden de trabajo (fase 2)

1. Componentes transversales (ErrorBoundary, NoAccess, AvisoPermisosNoComprobados) — los usan todas las páginas.
2. Perfil y Ayuda (moldes directos y pequeños).
3. Usuarios y Roles y permisos (subagentes `frontend-agent` en paralelo; no comparten archivos).
4. Dashboard + admin (RUM, Métricas).
5. Dr. Flit.
6. ExpedienteVisor, OcrUpload, Pipeline, RuntLookup, BatchValidator.
7. Fichas de ayuda, specs, capturas 1280 / 375 / oscuro en `docs/ux/rediseno-2026/s6/`, typecheck + lint.

## Dudas y pedidos al integrador

1. **Kit**: ¿`components/flit/` traerá banner en carrusel, dona, barras agrupadas, `accesos` (tarjeta de acceso con
   ilustración) y lista de actividad? Si no, los pido como piezas del kit (Dashboard, Reportes y Ayuda los necesitan).
2. **Usuarios y Roles**: en el molde son dos pestañas de un mismo módulo `#usuarios`; en FLITO son dos rutas (`/users`,
   `/roles-permisos`). Propuesta: mantener las rutas (no toco `App.tsx`) y mostrar en ambas una `Pestanas` que enlace a la otra. ¿Ok?
3. **Matriz RBAC**: el molde es módulo × Ver/Crear/Editar/Eliminar; FLITO tiene árbol de páginas y funciones. Conservo el
   árbol con el lenguaje visual de la matriz (no cambio el modelo de permisos).
4. **Perfil**: el molde abre «Cambiar contraseña» en modal; hoy es una sección de la página. Lo paso a modal y ajusto `perfil.spec.ts`.
5. **Dr. Flit** no tiene molde; consulto a `flit-de` el tratamiento del asistente flotante.
6. **`/admin/tramites-metricas`** está montada en `App.tsx` sin `ProtectedRoute` (`/admin/rendimiento` sí la tiene). Es del
   integrador; lo aviso por si se quiere corregir en el shell (regla 10).
7. **Specs `permisos*`**: interpreto que `flito-logistica-permisos-enviar-anular.spec.ts` es de la sesión de logística, y que
   `roles-permisos.spec.ts` y `users-permisos.spec.ts` son míos. Confirmar.

## Respuestas del integrador y briefing de flit-de (2026-11-12)

- La fuente de valores es `ui-kit-2026.css` (gana el último), **no** `tokens.css`. No hay botón con degradado, ni modal con
  franja de color, ni círculo turquesa en la cabecera. El degradado queda solo para identidad (banner de Inicio, isotipo).
- **Regla k: solo cambios visuales.** No se tocan textos, aria, handlers, hooks, fetch ni estado. Las excepciones aprobadas
  son: las `Pestanas` que enlazan `/users` con `/roles-permisos` y el modal de contraseña en Perfil (molde `#perfil`).
- Cerradas: (1) S0 entrega banner carrusel, Dona, BarrasGrupo, tarjeta de accesos y lista de actividad; (2) las rutas
  quedan como están, unidas con Pestanas; (3) `/admin/tramites-metricas` sin `ProtectedRoute` es un hallazgo fuera de
  alcance: **no se toca**, el integrador lo reporta; (4) `roles-permisos.spec` y `users-permisos.spec` son de S6, y
  `flito-logistica-permisos-enviar-anular` es de S3.
- Botón naranja (`#D44100`) para lo destructivo: Borrar rol, desactivar o suspender usuario, retirar acceso.
- Menú de usuario (lo arma S0): Perfil [persona], Cambiar contraseña [ojo], Ayuda [ayuda], Salir en naranja.
- Para no repetir los errores del briefing: c) chips propios con `etiquetaKit`; e) todos los velos van por las clases del
  Modal (RolFormModal, BorrarRolModal, formularios de usuario, Dr. Flit); g) los íconos lucide pasan a `<Icono>`;
  j) en los tests de aspecto se cambia el valor visual, nunca la lógica.
- **Contrato con el menú de usuario (aprobado):** «Cambiar contraseña» navega a `/perfil?accion=contrasena` (sin PII).
  Perfil abre el modal de contraseña al leer el parámetro y, al cerrarlo, lo limpia con `navigate(..., { replace: true })`
  para que «atrás» no lo reabra. Lo cubre `perfil.spec.ts`.
