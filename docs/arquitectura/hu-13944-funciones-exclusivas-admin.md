# Diseño slim — HU #13944 · Funciones exclusivas del Administrador

Feature #13939 · Épica #13671 · módulo **legacy `permisos`** (no `flito-`) · estado: Propuesto (sin ADR).

## Patrón reutilizado

- **Fuente de verdad en código, la BD como copia comprobada al arrancar.** Es el patrón de `modulo`
  en `verificarCatalogoAlArrancar` (`apps/api/src/modules/permisos/permisos.service.ts`, HU #12716 AC7):
  el catálogo lo declara el producto en `catalogo*.ts`; la columna lo refleja; si difieren, el arranque
  falla con la migración que falta en el mensaje.
- **Validación antes de la tx + error de dominio exportado y mapeado en la ruta:** como
  `funcionesInexistentes` / `FuncionesInexistentesError` (`permisos-roles.service.ts`), que
  `users.routes.ts:551,706` ya importa para las excepciones por usuario.

## Decisiones

1. **Fuente única = código.** Constante `FUNCIONES_EXCLUSIVAS_ADMIN: readonly string[]` en
   `catalogo-operaciones.ts` (junto a las demás declaraciones de operación) y campo opcional
   `exclusivaAdmin?: true` en `FuncionCatalogo` (`catalogo.ts`), que `catalogoCompleto()` rellena.
   `permisos_funciones.exclusiva_admin` es su proyección: `verificarCatalogoAlArrancar` añade un tercer
   bloque (después del de `modulo`) que compara el conjunto de códigos con `exclusiva_admin = true` en la
   base contra el del código y lanza `ArranquePermisosError` nombrando la `0253`. En ejecución:
   - Las comprobaciones de escritura y `catalogoAgrupado` leen la **columna** (ya consultan la tabla).
   - `arbolDef()` / `arbolDeRol` son estáticos (`ARBOL_ITEMS_Y_ACCIONES`) y marcan con la **constante**.
   Como el arranque garantiza que las dos coinciden, el resultado es el mismo.
   `inventario.generado.ts` no cambia: refleja guardas, no esta marca.
2. **«Rol admin» = el literal `'admin'`** de `USER_ROLES`. Se exporta `ROL_ADMIN = 'admin' as const`
   desde `permisos-roles.service.ts`, tipado contra `UserRole`. **No** se usa `es_sistema`: hoy coincide,
   pero significa «no se puede borrar», no «tiene las exclusivas». `RESERVADOS` (`['operaciones']`) no
   se ve afectado: bloquea códigos que se crean, y `operaciones` no puede existir como rol. Ningún caso
   cae en los dos a la vez.
3. **Comprobaciones** (helper `funcionesExclusivas(codigos): Promise<{codigo,nombre}[]>`, una sola lectura
   fuera de la tx):
   - `guardarCuadro(codigo ≠ admin)`: si lo pedido incluye alguna exclusiva → 409 `FuncionExclusivaAdminError`
     (`motivo: 'asignar'`).
   - `guardarCuadro('admin')`: si a lo pedido le falta alguna exclusiva → 409 (`motivo: 'quitar'`). Corre
     **antes** que `conSeguroAntiBloqueo`.
   - `crearRol`: aplica la misma regla de `'asignar'` (si no, es una puerta trasera de la misma escritura,
     y un rol nuevo nunca es `admin`).
   - Usuarios (`users.routes.ts` en crear y editar, junto a `funcionesInexistentes`): una excepción
     `conceder` sobre una exclusiva → 409 `'asignar'`. **Por defecto también se rechaza `revocar`**, para
     que un admin no pueda perderla por la vía del usuario (pendiente de confirmar, ver abajo).
   - Clase: `FuncionExclusivaAdminError(funcion, nombre, motivo)`. Mensaje: «La función {nombre} es
     exclusiva del Administrador y no se puede asignar a otro rol.» / «… y no se puede quitar.» Las
     rutas responden 409 `{ error, funcion }`.
4. **Datos existentes.** Las dos funciones son nuevas, así que ningún rol ni usuario las tiene. Aun así,
   la 0253 hace `DELETE` idempotente de las filas que haya en roles distintos de `admin` y de las filas
   `conceder` en `permisos_usuario_funcion` (cero filas esperadas), para que el invariante quede cierto
   desde la migración. Sin trigger en BD: la regla vive en el servicio, igual que el antibloqueo.
5. **shared-types: sí.** `NodoArbolDef` (`packages/shared-types/src/permisos-arbol/index.ts`) gana
   `exclusivaAdmin?: boolean` (opcional, no rompe). `FuncionDeGrupo` es una interfaz local de
   `permisos.service.ts`: se le añade `exclusivaAdmin: boolean` ahí mismo. Regla 7: grep obligatorio
   `grep -rn "NodoArbolDef\|NodoArbolRol\|NodoArbolUsuario" apps/web/src` y del tipo del catálogo en web.

## Contrato delta

- `GET /api/permisos/catalogo` → cada función lleva `exclusivaAdmin: boolean`.
- `GET /api/permisos/roles/:codigo/arbol` (y `/usuarios/:id/arbol`, que hereda el mismo nodo) → `exclusivaAdmin?: true` en el nodo.
- `PUT` del cuadro de un rol / `POST` de rol / alta o edición de usuario con `funciones` → nuevo **409** `{ error, funcion }`.

## Archivos a crear/modificar

- `apps/api/src/db/schema/permisos.ts`: `exclusivaAdmin: boolean('exclusiva_admin').notNull().default(false)`.
- `apps/api/src/db/migrations/0253_permisos_funciones_exclusiva_admin.sql` (nuevo): `ADD COLUMN IF NOT EXISTS`;
  `INSERT … ON CONFLICT DO NOTHING` de `clients.clientes.estado` / `.eliminar` (módulo, `padre_codigo`,
  `nivel` y `orden` según lo que emita `npm run permisos:seed`); `UPDATE … SET exclusiva_admin = true`;
  `INSERT permisos_rol_funcion ('admin', …) ON CONFLICT DO NOTHING`; los `DELETE` del punto 4.
- `apps/api/src/modules/permisos/catalogo-operaciones.ts`: declarar las 2 funciones y `FUNCIONES_EXCLUSIVAS_ADMIN`.
- `apps/api/src/modules/permisos/catalogo.ts`: `exclusivaAdmin` en `FuncionCatalogo`; validar que cada exclusiva exista en el catálogo y que sus `roles` sean `['admin']` (`CatalogoIncoherenteError`).
- `apps/api/src/modules/permisos/arbol/acciones-administracion.ts` (+ el nodo en `ARBOL_ITEMS_Y_ACCIONES` de shared-types): colgar las 2 operaciones del nodo de clientes.
- `apps/api/src/modules/permisos/permisos.service.ts`: `catalogoAgrupado` y el bloque nuevo de `verificarCatalogoAlArrancar`.
- `apps/api/src/modules/permisos/permisos-roles.service.ts`: `ROL_ADMIN`, `FuncionExclusivaAdminError`, `funcionesExclusivas`, las comprobaciones en `guardarCuadro` y `crearRol`.
- `apps/api/src/modules/permisos/permisos-arbol.service.ts`: marcar `exclusivaAdmin` en `arbolDef()`.
- `apps/api/src/modules/permisos/permisos.routes.ts`: mapear el 409 en `responderErrorDeDominio`.
- `apps/api/src/modules/users/users.routes.ts`: la comprobación y el 409 en crear y editar.
- `packages/shared-types/src/permisos-arbol/index.ts`: el campo opcional.

**Tests P1** (`apps/api/__tests__/`):

| Archivo | Qué cubre |
|---|---|
| `services/permisos-roles.routes.test.ts` | Cuadro de otro rol con una exclusiva → 409; cuadro de admin sin ella → 409; `crearRol` → 409 |
| `services/users.routes.test.ts` | Excepción de usuario `conceder` y `revocar` → 409 |
| `services/permisos-catalogo.test.ts` | El catálogo expone `exclusivaAdmin` |
| `services/permisos-arbol.routes.test.ts` | El nodo lleva `exclusivaAdmin` |
| `services/permisos-arranque.test.ts` | El arranque falla si la base y el código difieren en las exclusivas |
| `services/permisos-siembra-admin.test.ts` | `admin` queda sembrado |
| `db/migracion-0253.test.ts` (nuevo) | Copia el patrón de `db/migracion-0179.test.ts`: idempotencia y filas resultantes |

## ADR: no aplica

La HU extiende el catálogo y el cuadro existentes con el patrón de `modulo`. No añade tabla, dependencia ni actor.

## Notas operativas

- **Backend — BLOQUEANTE antes de codear:** el catálogo de operaciones sale de guardas (`exigirFuncion`
  → `inventario.generado.ts` → `catalogoDeOperaciones`), y `clients.routes.ts` no tiene hoy ninguna ruta
  para activar, desactivar ni eliminar (solo `PATCH /:id`). Si la 0253 inserta las dos funciones sin
  guarda en el código, `verificarCatalogoAlArrancar` lanza «la base declara y el código no usa» y **la API
  no arranca**. Hay que elegir una de estas salidas: (a) las rutas o guardas de estado y eliminar entran
  en esta misma HU; (b) se declaran como operaciones nacidas en el árbol (mecanismo de la HU #13889,
  `OPERACIONES_NACIDAS_EN_EL_ARBOL`), si ese mecanismo admite una operación sin guarda; (c) esta HU entrega
  solo el mecanismo y la columna, y las dos filas las inserta la migración de la HU que crea los
  endpoints. Hay que confirmarlo con `permisos-arranque.test.ts` antes de escribir la migración.
- Mantener `permisos-roles.service.ts` ≤ 800 líneas; si se acerca, los helpers de exclusividad van a `permisos-exclusivas.ts` en el mismo módulo.
- Gates: `db-review-agent` (schema + migración) y `security-agent` (authz) aplican.
- Frontend (otra HU): deshabilitar la casilla y mostrar el aviso cuando `exclusivaAdmin`; el 409 es la red de seguridad.

## Pendiente humano

1. ¿Salida (a), (b) o (c) para el bloqueante anterior?
2. ¿También se rechaza una excepción `revocar` de una exclusiva (sea cual sea el rol del usuario, o solo para admin)? Por defecto: se rechaza siempre.
