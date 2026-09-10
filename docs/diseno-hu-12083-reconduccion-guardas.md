# Diseño slim — HU #12083: reconducir al motor las guardas de rol de los módulos FLITO, trámites incluidos

**Feature** [#12072](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12072) · **HU** [#12083](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12083) (8 SP, eslabón 3 de la cadena #12081 → #12082 → #12083)
**Modo**: slim. Extiende `exigirFuncion` (HU #12082) sobre 21 ficheros de rutas; no hay tabla nueva ni contrato nuevo.
**ADR**: no aplica. La única regla nueva de esta HU —«`exigirFuncion` se monta a nivel de ruta, nunca con `router.use`»— ya está escrita y fijada para esta HU en [ADR-0016 §2](./adr/ADR-0016-bitacora-intentos-denegados-contador-por-ventana.md). Lo demás es extensión de patrón (ADR-0015, ADR-0016).
**Migración**: **sí hace falta una, la `0181_permisos_reconduccion.sql`**, y solo porque el catálogo de la #12081 tiene 11 huecos que esta HU destapa (§5). Sin ellos, esta HU no tocaría la base. La escribe `backend-agent`.
**Correcciones que mandan sobre el texto de los AC** (medidas hoy en el worktree `HU/12083-davidchica-reconducir-guardas-motor` @ `b6d4c62`): 57 apariciones de `requireRole(` en los 19 directorios (no 56); 43 comparaciones `role ===/!==` (no 40); de esas 43 **solo 2 deciden un permiso** (§1.3); `users/` **no está en el catálogo** de la #12081 (§5); el lector de guardas queda ciego al terminar (§3).

---

## Contexto medido

| Hecho | Dónde |
|---|---|
| **57** `requireRole(` en alcance = **29** alias (`const LECTURA = requireRole(…)`) + **5** `router.use` + **19** en línea + **4** menciones en comentarios | `grep -rn "requireRole(" <19 dirs>`; la lista está en §4 |
| Esas 57 protegen **217 rutas** (la foto) + **2 rutas que el lector no vio** (`flito-impuestos.routes.ts:606-610`, un `for` con template literal) = **219 rutas guardadas** en 21 ficheros | `inventario.generado.ts` (217) contra `grep -cE "router\.(get\|post\|…)\("` fichero a fichero: solo impuestos difiere (17 declaradas, 16 en la foto) |
| 217 rutas ↔ 217 códigos de operación, **1:1, sin código repetido** | `OPERACIONES_DECLARADAS` (217), `new Set(codigo).size` = 217 |
| La foto y el seed de la 0179 **coinciden exactamente**: 378 pares (rol, operación) en ambos, cero diferencias | parse del bloque `INSERT INTO permisos_rol_funcion` de la 0179 contra `GUARDAS_MEDIDAS` |
| 5 `router.use` con `requireRole`: `tramites/tramites.routes.ts:49` (admin, transito → 39 rutas heredadas + 3 en línea `admin`), `tramites/transito.routes.ts:21` (admin, transito → 8), `tramites/ocr-docs.routes.ts:21` (admin → 2), `flito-comparendos/flito-comparendos.routes.ts:113` (admin → 21; el `authMiddleware` va aparte en `:112`), `users/users.routes.ts:116` (admin → 7; `PATCH /:id/password` en `:34` va ANTES y no hereda) | los cinco ficheros |
| `users/users.routes.ts` tiene **8 rutas y 0 códigos** en el catálogo: no figura en `FICHEROS_EN_ALCANCE` de la #12081 y no hay ninguna `usuarios.*` en la 0179 | `inventario-guardas.ts:55-77`; `grep -c "'usuarios\." 0179` = 0 |
| `auditor` tiene **41** operaciones en la foto, **las 41 son `GET`**; ninguna no-GET. Los tres `GET` sin auditor en módulos donde sí está: `impuestos.factura.ver`, `impuestos.certificado.descargar`, `logistica.ruta.ver` | script sobre la foto |
| `requireRole(...roles: string[])` en `auth.ts:185-193` (no `:181`); `req.user.role` es `RoleCode` = `UserRole \| (string & {})` — **tipar a `RoleCode[]` no protege nada** (`'admn'` compila); tipar a `UserRole[]` sí | `auth.ts:26`, `shared-types/permissions.ts:75` |
| Fuera de alcance, los 205 `requireRole` de los 11 directorios usan **solo literales de `USER_ROLES`** (`admin` 186, `lider_pesv` 26, `compliance` 24, `financiera` 11, `auditor` 10, `proveedor` 3, `supervisor_flota` 2) y un único spread, `...ADMIN_OR_LIDER`, declarado `as const` en 4 ficheros de `pesv/` | `grep -rhoE "requireRole\([^)]*\)" <11 dirs>` |
| Total en `apps/api/src/modules`: **284** `requireRole(` (el AC decía 276; la #12082 añadió 7 en `permisos/` y hay 22 en directorios que no están ni en alcance ni en la valla: `permisos` 7, `clients` 5, `privacy` 3, `firma` 2, `drive` 2, `rum` 1, `liquidacion` 1, `finanzas` 1) | conteo por directorio |
| `exigirFuncion` decide con `p.ok && p.funciones.has(codigo)` y nada más; `rutaDe` guarda la plantilla solo cuando `req.route.path` es string (guarda a nivel de ruta) | `exigir-funcion.ts:150`, `:125-131` |
| El helper de tests da a cada rol `paginasPorDefecto(rol)` y **ninguna `operacion.*`** salvo `opts.funciones`; **81 specs** montan routers de los 19 módulos con ese helper; solo **2** pasan `funciones:` a mano | `__tests__/helpers/auth.ts:95-100`; `grep -rlE "modules/(flito-…\|tramites\|users)/…routes"` |
| Specs que afirman el **cuerpo** del 403 antiguo en rutas que se reconducen: **2 asertos** (`flito-soat.cliente-lectura-factura.test.ts:305,313`, admin y «gestor» contra `POST /cliente/factura/lectura`). Los otros dos `toEqual({ error:'Sin permisos' })` son de la frontera del canal, que no cambia | grep `Sin permisos` en los 81 |
| Specs con un 403 esperado **y** un `insert…not.toHaveBeenCalled` en el mismo fichero (la bitácora del 403 podría consumir el `insertMock`): **12 candidatos** | `flito-comparendos-catalogos`, `flito-bolsas.routes`, `flito-compuerta`, `flito-comparendos-token`, `flito-comparendos-registros`, `flito-impuestos.certificado.routes`, `flito-comparendos-sync`, `flito-derechos`, `flito-logistica`, `tramites.lote`, `tramites.routes`, `users.routes` |
| E2E de Playwright: los 9 specs que mencionan 403 lo hacen con `route.fulfill` (mock) o en comentarios; la SPA traduce el 403 **por status** (`web/src/lib/api.ts:134`) y ningún componente lee `error` del cuerpo | `grep -rn 403 web/e2e/tests`; `grep -rn "status === 403" web/src` |
| `siigo-facturacion.routes.test.ts:155-160` importa `ROLES_LIQUIDACION_ESCRITURA` de `flito-liquidacion.routes.ts` para compararla con `ROLES_POR_ACCION.emitir` de Siigo | ese spec |
| Techos de `max-lines`: `tramites.routes.ts` 711/860, `identidad.routes.ts` 925/1130; el resto de ficheros de rutas < 600. `schema.ts` **no se toca** (3353/3400) | `npx eslint <f> --rule max-lines:1` |
| Última migración `0180_permisos_motor.sql`; primera libre **0181** | `ls src/db/migrations \| tail` |

### Premisas del encargo que no se sostienen

1. **«Esta HU no debería necesitar migración»** — sí la necesita: 11 funciones que el catálogo no tiene y que hoy protege un `requireRole('admin')` (§5). Sin ellas, `exigirFuncion('usuarios.usuario.listar')` respondería `no_reconocida` y `verificarCatalogoAlArrancar` no puede exigirlas.
2. **«Las 40 comparaciones `role ===` de esos directorios que deciden un permiso también se reconducen»** — de las 43, **14 son ámbito** (AC3: `contextoSoat`, `contextoImpuesto`, `resolveTransitoScope`, el organismo del `transito` en `transito-config`, el mensajero y sus actas en logística), **27 son el `superRefine` y el armado del usuario editado** en `users.routes.ts` (#12088) y **2 deciden un permiso**: `tramites.routes.ts:615` (`_forzarContinuar` solo `admin`) y `users.routes.ts:38` (contraseña ajena solo `admin`). Se reconducen esas 2 (§1.3), en línea, no como middleware.
3. **«`requireRole(...roles: string[])` … queda tipado como `UserRole[]`»** — el AC lo dice bien; la nota del encargo («`RoleCode[]`») no: `RoleCode` es abierto a propósito (HU #12169) y no detecta un literal mal escrito. Se tipa a `UserRole[]` (§1.5): los 205 de fuera compilan porque todos son literales de `USER_ROLES` o el spread `as const` de `pesv/`.
4. **«El lector pasa a leer `exigirFuncion` y la foto se regenera»** — la foto **no se vuelve a generar**: es la fuente de «lo que había antes» del AC7 y regenerarla desde el código nuevo la haría circular (§3).

---

## 1. Decisiones, una por punto del encargo

| # | Punto | Decisión |
|---|---|---|
| 1 | Tabla ruta → código | §4: 219 rutas + 2 guardas en línea. Las 5 de nivel router se reparten **ruta a ruta**, un `exigirFuncion('<codigo>')` por línea, sin helper local: cada ruta tiene su propio código (1:1), así que un alias no ahorra nada y `rutaDe` solo guarda la plantilla si la guarda está en la ruta (ADR-0016 §2). `router.use(authMiddleware)` se conserva en los cinco |
| 2 | Paridad (AC7) | Cuatro fuentes independientes: lista explícita en el test (qué ruta lleva qué código), **lector de montajes** sobre el fuente (que ese código está montado de verdad), **foto congelada** `inventario.generado.ts` (roles de antes) y **el SQL de las migraciones 0179 + 0181** parseado (lo que el motor sabe). Motor = `resolverPermisos` real con `fijarFuenteDePermisos` alimentado desde el SQL. Quitar una fila del seed rompe solo el lado del motor → rojo con ruta y rol (§6) |
| 3 | Valla (AC4) | 11 directorios enumerados; por directorio, `requireRole(` sin comentarios **≥ el medido hoy** y **cero importaciones de `exigir-funcion.js`**. No exacto, para no ponerse rojo con merges ajenos a `pesv/` (§7) |
| 4 | Auditor (AC6) | «Lectura» = método `GET` de la foto; «ejecución» = todo lo demás. El test fija los 41 códigos GET del auditor y afirma que en el seed tiene exactamente esos y ninguno no-GET; el sufijo del código es aserto secundario (§8) |
| 5 | `requireRole` (AC2) | Se **tipa** a `UserRole[]` en `auth.ts` y se conserva para los 205 de fuera; en los 19 directorios queda **cero** (test de §9). No se retira: lo usan 227 sitios fuera |
| 6 | Orden y tamaño | Seis oleadas en **un solo PR** con un commit por oleada (§10). ≈ 1 300 líneas: cabe, y la cadena 1 → 2 → 3 se promueve junta |
| 7 | Specs y E2E | `testToken` carga **automáticamente** las operaciones del rol desde `repartoDePartida()` (§11.1); 2 asertos de cuerpo se actualizan; la bitácora del 403 se apaga en tests con una bandera leída en caliente, patrón de `AUTH_SKIP_*` (§11.2); E2E: nada que tocar |
| — | Lector y foto | El lector aprende a leer `exigirFuncion('<codigo>')` y `tieneFuncion(req, '<codigo>')`; la foto queda **congelada como reparto de partida**; la comprobación de doble sentido pasa a ser sobre códigos (§3) |
| — | Huecos del catálogo | 11 funciones nuevas en `catalogo-operaciones.ts` + foto + **0181** (§5) |

### 1.3 Las dos guardas en línea

No son middleware: dependen del cuerpo (`_forzarContinuar`) o de la identidad (`sub !== id`). Se reconducen con un helper nuevo y pequeño en `exigir-funcion.ts`:

```ts
/** La misma decisión que `exigirFuncion`, para usarla DENTRO de un handler. Registra el intento denegado. */
export async function tieneFuncion(req: Request, codigo: string): Promise<boolean>
```

- `tramites.routes.ts:615`: `if (req.user!.role !== 'admin')` → `if (!(await tieneFuncion(req, 'tramite.tramite.forzar_continuar')))`. El 403 conserva su cuerpo (`code: 'forzar_admin'`): nadie lo lee hoy, pero no es esta HU quien lo cambia.
- `users.routes.ts:38`: `if (req.user!.sub !== id && req.user!.role !== 'admin')` → `if (req.user!.sub !== id && !(await tieneFuncion(req, 'usuarios.contrasena.cambiar_ajena')))`.

Las 14 comparaciones de ámbito **no se tocan** (AC3) y el test de §9 las lista una a una como «comparaciones que quedan y por qué», para que el próximo `grep` no las cuente como deuda.

---

## 2. Patrón reutilizado, archivo por archivo

- **La guarda**: `exigirFuncion(codigo)` de `apps/api/src/shared/middleware/exigir-funcion.ts:143-161`. Se monta **exactamente donde estaba el alias o el `requireRole`** de cada ruta: `router.get('/', LECTURA, h)` → `router.get('/', exigirFuncion('soat.cola.ver'), h)`. Ni una ruta cambia de posición ni pierde `authMiddleware`.
- **El lector de texto**: `leerGuardas` de `apps/api/src/modules/permisos/inventario-guardas.ts:115-172`. La regex de rutas (`:140`) se reutiliza tal cual; solo cambia qué se busca en el trozo entre la ruta y el handler.
- **La comprobación de doble sentido**: `catalogoDeOperaciones` (`catalogo.ts:104-140`) sigue cruzando foto ↔ `OPERACIONES_DECLARADAS` por llave. La segunda comprobación (montado ↔ declarado) vive en `permisos-catalogo.test.ts`, como hoy vive «la foto es fiel».
- **El seam de pruebas**: `fijarFuenteDePermisos` (`permisos-efectivos.ts:140`) y `registrarUsuarioDePrueba` (`helpers/auth.ts:68`). El test de paridad los usa sin añadir nada.
- **La bandera en caliente**: `AUTH_SKIP_SESSION_INVAL_CHECK` (`auth.ts:89`, `__tests__/setup.ts`). Se copia el mecanismo para la bitácora de intentos.

---

## 3. El lector queda ciego: qué se hace con él y con la foto

Al sustituir `requireRole` por `exigirFuncion`, `leerGuardas` devuelve `[]` para cada fichero reconducido, `inventarioDeGuardas()` deja de coincidir con `GUARDAS_MEDIDAS` y el caso «el snapshot compilado sigue siendo fiel» de `permisos-catalogo.test.ts:145` se pone rojo en la primera ruta migrada. El runtime **no se entera**: `catalogoCompleto()` lee la foto, no el fuente. Se decide (a) + (b), juntas:

**(a) El lector aprende la forma nueva.** `inventario-guardas.ts` gana:

```ts
export interface MontajeLeido {
  fichero: string;
  /** Nulos cuando el código se pide en línea con `tieneFuncion(req, …)`. */
  metodo: GuardaLeida['metodo'] | null;
  ruta: string | null;
  codigo: string;
}
export function leerMontajes(f: FicheroEnAlcance, raiz = RAIZ_MODULOS): MontajeLeido[]
export function montajesDeFunciones(raiz = RAIZ_MODULOS): MontajeLeido[]
```

Misma regex de rutas que `leerGuardas`; en el trozo entre ruta y handler busca `exigirFuncion\('([a-z_.]+)'\)`. Un `exigirFuncion(` **sin literal** (una variable, un template) **lanza**, como hoy lanza `rolesDe` ante un spread desconocido: adivinar un código monta una guarda que el catálogo no conoce. `tieneFuncion\(\s*req\s*,\s*'([a-z_.]+)'\)` se lee en cualquier parte del fichero y produce una entrada con `metodo`/`ruta` nulos. `leerGuardas` **se conserva** mientras dure la reconducción (§10) y se elimina en la última oleada junto con `CONSTANTES_ROLES`.

**(b) La foto se congela como reparto de partida.** `inventario.generado.ts` deja de ser «generado»: su cabecera pasa a decir que es la **foto histórica pre-reconducción** (qué roles exigía cada `requireRole` el día que dejó de decidir), que es la fuente de «antes» del AC7 y de `repartoDePartida()`, y que **se edita a mano solo para añadir funciones nuevas junto con su migración** (las 11 de §5 son la primera edición). `npm run permisos:generar` y `--inventario` se retiran del script (`generar-seed-permisos.ts`): regenerar la foto desde un código sin `requireRole` la vaciaría, y desde el código nuevo la haría circular. `npm run permisos:seed` se queda: sigue produciendo el SQL de siembra desde la foto, y es como se escriben las 22 filas de la 0181.

`GuardaLeida` gana `condicion?: string` y `llaveDe` la añade entre corchetes (`tramites/tramites.routes.ts PATCH /:id [_forzarContinuar]`): así las 2 guardas en línea entran en la foto y en `OPERACIONES_DECLARADAS` sin colisionar con la llave de la ruta que las contiene.

**La comprobación de doble sentido, sobre códigos.** En `permisos-catalogo.test.ts`, el caso de la foto fiel se sustituye por el invariante transitorio:

> Para cada fichero en alcance, `leerGuardas(f)` ∪ `leerMontajes(f)` cubre **exactamente** las rutas de la foto de ese fichero: las que siguen con `requireRole` llevan los mismos roles que la foto, y las ya reconducidas llevan el código que `OPERACIONES_DECLARADAS` declara para esa llave. Nada guardado que no esté en la foto; nada de la foto sin guarda.

Verde en cualquier punto intermedio; al cerrar la HU, `leerGuardas` devuelve `[]` para los 21 ficheros y el test de §9 lo exige. Las entradas con `condicion` se comprueban por código («`tieneFuncion(req, '<codigo>')` aparece en su fichero»).

Qué tests de la #12081 cambian y cómo:

| Test | Cambio |
|---|---|
| `permisos-catalogo.test.ts` «el snapshot compilado sigue siendo fiel» | se sustituye por el invariante de arriba |
| `permisos-catalogo.test.ts` «hay exactamente una función por ruta guardada» y «los roles … son LITERALMENTE los de su guarda» | pasan a comparar contra `GUARDAS_MEDIDAS` (la foto) en vez de `inventarioDeGuardas()`; afirman lo mismo sobre la fuente que sigue existiendo |
| `permisos-catalogo.test.ts` «una guarda sin nombre revienta» / «un nombre sin guarda viva revienta» | sin cambio: siguen probando `catalogoDeOperaciones` con listas construidas a mano |
| `permisos-catalogo.test.ts` «`admin` tiene todas las operaciones salvo las tres del canal» | sin cambio; las 11 nuevas son de `admin` |
| `db/migracion-0179.test.ts` «el reparto entero de la base es el que el generador produce» | sin cambio de código; **con la 0181 aplicada el reparto de la base son 484 + 22 filas y el generador (foto ampliada) produce las mismas**. Solo corre con `TEST_DATABASE_URL` |
| `permisos-arranque.test.ts` | sin cambio: compara catálogo del código con la base; el catálogo del código crece en 11 y la 0181 siembra esas 11 |

---

## 4. Tabla ruta → código

Convenciones: «Guarda de hoy» es el alias del fichero, `inline` (un `requireRole(...)` en la propia ruta) o `router.use` (heredada). Los roles salen de `inventario.generado.ts`; el código, de `catalogo-operaciones.ts`. Todas las filas de la tabla tienen código salvo las marcadas **0181**.

**Cómo se reparten las 5 de nivel router.** En los cinco ficheros se deja `router.use(authMiddleware)` y se quita el `requireRole` del `use`; cada ruta de debajo recibe su `exigirFuncion('<codigo>')`. En `tramites.routes.ts` las 3 rutas que ya llevaban `requireRole('admin')` en línea además del `use` (`/metrics/summary`, `/lote/:id/reprocesar-errores`, `/lote/:id/resultados.csv`) quedan con un único `exigirFuncion` (su código de la foto ya recoge `admin` a secas). El comentario de `flito-comparendos.routes.ts:108-111` («la próxima ruta que alguien añada nace protegida») deja de ser cierto en los cinco: lo sustituye el invariante de §3, que se pone rojo ante una ruta nueva sin guarda ni entrada en la foto.

#### `flito-soat/flito-soat.routes.ts` — 16 rutas

| Método | Ruta | Guarda de hoy | Roles de hoy | Código (`exigirFuncion`) |
|---|---|---|---|---|
| GET | `/` | `LECTURA` | admin, auditor, cliente, proveedor | `soat.cola.ver` |
| POST | `/export` | `OPS_O_GESTOR` | admin, proveedor | `soat.excel.exportar` |
| POST | `/soportes/zip` | `OPS_O_GESTOR` | admin, proveedor | `soat.soportes.descargar` |
| GET | `/facetas` | `LECTURA` | admin, auditor, cliente, proveedor | `soat.cola.filtrar` |
| GET | `/:id` | `LECTURA` | admin, auditor, cliente, proveedor | `soat.solicitud.ver` |
| GET | `/:id/historial` | `LECTURA` | admin, auditor, cliente, proveedor | `soat.solicitud.ver_historial` |
| GET | `/:id/soportes` | `LECTURA` | admin, auditor, cliente, proveedor | `soat.solicitud.ver_soportes` |
| POST | `/enviar` | `OPERACIONES` | admin | `soat.solicitud.enviar` |
| POST | `/:id/rechazar` | `OPS_O_GESTOR` | admin, proveedor | `soat.solicitud.rechazar` |
| POST | `/:id/reactivar` | `OPERACIONES` | admin | `soat.solicitud.reactivar` |
| POST | `/:id/reversar` | `OPERACIONES` | admin | `soat.solicitud.reversar` |
| POST | `/:id/proveedor` | `OPERACIONES` | admin | `soat.proveedor.cambiar` |
| POST | `/:id/asumir-operaciones` | `OPERACIONES` | admin | `soat.solicitud.asumir` |
| POST | `/:id/devolver-gestor` | `OPERACIONES` | admin | `soat.solicitud.devolver` |
| POST | `/:id/factura` | `OPS_O_GESTOR` | admin, proveedor | `soat.comprobante.cargar` |
| POST | `/facturas` | `OPS_O_GESTOR` | admin, proveedor | `soat.masiva.cargar` |

#### `flito-soat/flito-soat-cliente.routes.ts` — 3 rutas

| Método | Ruta | Guarda de hoy | Roles de hoy | Código (`exigirFuncion`) |
|---|---|---|---|---|
| POST | `/cliente/preconsulta` | `CANAL_CLIENTE` | cliente | `soat.runt.preconsultar` |
| POST | `/cliente` | `CANAL_CLIENTE` | cliente | `soat.solicitud.crear` |
| POST | `/cliente/factura/lectura` | `CANAL_CLIENTE` | cliente | `soat.factura.leer` |

#### `flito-impuestos/flito-impuestos.routes.ts` — 16 rutas

| Método | Ruta | Guarda de hoy | Roles de hoy | Código (`exigirFuncion`) |
|---|---|---|---|---|
| GET | `/:id/factura-venta` | `OPS_O_GESTOR` | admin, gestor_impuestos | `impuestos.factura.ver` |
| POST | `/soportes/zip` | `OPS_O_GESTOR` | admin, gestor_impuestos | `impuestos.soportes.descargar` |
| GET | `/` | `LECTURA` | admin, auditor, gestor_impuestos | `impuestos.cola.ver` |
| POST | `/export` | `OPS_O_GESTOR` | admin, gestor_impuestos | `impuestos.excel.exportar` |
| GET | `/facetas` | `LECTURA` | admin, auditor, gestor_impuestos | `impuestos.cola.filtrar` |
| GET | `/:id` | `LECTURA` | admin, auditor, gestor_impuestos | `impuestos.tramite.ver` |
| GET | `/:id/historial` | `LECTURA` | admin, auditor, gestor_impuestos | `impuestos.tramite.ver_historial` |
| GET | `/:id/soportes` | `LECTURA` | admin, auditor, gestor_impuestos | `impuestos.tramite.ver_soportes` |
| POST | `/:id/certificar` | `OPS_O_GESTOR` | admin, gestor_impuestos | `impuestos.tramite.certificar` |
| POST | `/certificar` | `OPS_O_GESTOR` | admin, gestor_impuestos | `impuestos.tramite.certificar_lote` |
| GET | `/:id/certificado` | `OPS_O_GESTOR` | admin, gestor_impuestos | `impuestos.certificado.descargar` |
| POST | `/enviar` | `OPERACIONES` | admin | `impuestos.tramite.enviar` |
| POST | `/:id/rechazar` | `OPS_O_GESTOR` | admin, gestor_impuestos | `impuestos.tramite.rechazar` |
| POST | `/:id/reactivar` | `OPERACIONES` | admin | `impuestos.tramite.reactivar` |
| POST | `/:id/reversar` | `OPERACIONES` | admin | `impuestos.tramite.reversar` |
| POST | `/recibos` | `OPS_O_GESTOR` | admin, gestor_impuestos | `impuestos.recibos.cargar` |

#### `flito-derechos/flito-derechos.routes.ts` — 8 rutas

| Método | Ruta | Guarda de hoy | Roles de hoy | Código (`exigirFuncion`) |
|---|---|---|---|---|
| POST | `/cargar` | `OPERACIONES` | admin | `derechos.recibos.cargar` |
| GET | `/` | `LECTURA` | admin, auditor | `derechos.cola.ver` |
| GET | `/facetas` | `LECTURA` | admin, auditor | `derechos.cola.filtrar` |
| GET | `/drive/archivos` | `LECTURA` | admin, auditor | `derechos.drive.listar` |
| GET | `/drive/registro` | `LECTURA` | admin, auditor | `derechos.drive.ver_registro` |
| POST | `/drive/procesar` | `OPERACIONES` | admin | `derechos.drive.procesar` |
| GET | `/candidatos/:placa` | `LECTURA` | admin, auditor | `derechos.candidatos.ver` |
| GET | `/soporte/:id` | `LECTURA` | admin, auditor | `derechos.soporte.descargar` |

#### `flito-revisiones/flito-revisiones.routes.ts` — 5 rutas

| Método | Ruta | Guarda de hoy | Roles de hoy | Código (`exigirFuncion`) |
|---|---|---|---|---|
| GET | `/` | `LECTURA` | admin, auditor | `revisiones.cola.ver` |
| GET | `/campos/:modulo` | `LECTURA` | admin, auditor | `revisiones.campos.ver` |
| GET | `/soporte/:soporteId/archivo` | `LECTURA` | admin, auditor | `revisiones.soporte.descargar` |
| POST | `/:id/resolver` | `OPERACIONES` | admin | `revisiones.revision.resolver` |
| POST | `/:id/descartar` | `OPERACIONES` | admin | `revisiones.revision.descartar` |

#### `flito-compuerta/flito-compuerta.routes.ts` — 3 rutas

| Método | Ruta | Guarda de hoy | Roles de hoy | Código (`exigirFuncion`) |
|---|---|---|---|---|
| GET | `/` | `LECTURA` | admin, auditor | `compuerta.cola.ver` |
| GET | `/:tramiteId` | `LECTURA` | admin, auditor | `compuerta.tramite.ver` |
| POST | `/:tramiteId/entregar` | `OPERACIONES` | admin | `compuerta.tramite.entregar` |

#### `flito-tramites/flito-tramites.routes.ts` — 13 rutas

| Método | Ruta | Guarda de hoy | Roles de hoy | Código (`exigirFuncion`) |
|---|---|---|---|---|
| GET | `/` | `LECTURA` | admin, auditor | `tramites.cola.ver` |
| GET | `/facetas` | `LECTURA` | admin, auditor | `tramites.cola.filtrar` |
| GET | `/:id/historial` | `LECTURA` | admin, auditor | `tramites.tramite.ver_historial` |
| GET | `/:id/soportes` | `LECTURA` | admin, auditor | `tramites.tramite.ver_soportes` |
| POST | `/soportes/zip` | `OPERACIONES` | admin | `tramites.soportes.descargar` |
| POST | `/crear-empresa` | `OPERACIONES` | admin | `tramites.empresa.crear` |
| POST | `/demo` | `OPERACIONES` | admin | `tramites.demo.sembrar` |
| POST | `/solicitar-soat` | `OPERACIONES` | admin | `tramites.solicitud.pedir_soat` |
| POST | `/solicitar-impuestos` | `OPERACIONES` | admin | `tramites.solicitud.pedir_impuestos` |
| POST | `/solicitar-ambos` | `OPERACIONES` | admin | `tramites.solicitud.pedir_ambos` |
| POST | `/entregar` | `OPERACIONES` | admin | `tramites.tramite.entregar` |
| POST | `/:id/desbloquear-autogestion` | `OPERACIONES` | admin | `tramites.autogestion.desbloquear` |
| POST | `/:id/revocar-autogestion` | `OPERACIONES` | admin | `tramites.autogestion.revocar` |

#### `flito-tablero/flito-tablero.routes.ts` — 1 rutas

| Método | Ruta | Guarda de hoy | Roles de hoy | Código (`exigirFuncion`) |
|---|---|---|---|---|
| GET | `/` | `LECTURA` | admin, auditor | `tablero.tablero.ver` |

#### `flito-bitacora/flito-bitacora.routes.ts` — 2 rutas

| Método | Ruta | Guarda de hoy | Roles de hoy | Código (`exigirFuncion`) |
|---|---|---|---|---|
| GET | `/` | `LECTURA` | admin, auditor | `bitacora.bitacora.ver` |
| GET | `/:resource/:resourceId` | `LECTURA` | admin, auditor | `bitacora.bitacora.ver_recurso` |

#### `flito-logistica/flito-logistica.routes.ts` — 15 rutas

| Método | Ruta | Guarda de hoy | Roles de hoy | Código (`exigirFuncion`) |
|---|---|---|---|---|
| GET | `/` | `LECTURA` | admin, auditor | `logistica.consola.ver` |
| GET | `/facetas` | `LECTURA` | admin, auditor | `logistica.consola.filtrar` |
| GET | `/mi-ruta` | `CAMPO` | admin, mensajero | `logistica.ruta.ver` |
| GET | `/actas` | `LECTURA` | admin, auditor | `logistica.actas.listar` |
| GET | `/actas/:id` | `LECTURA` | admin, auditor | `logistica.actas.ver` |
| GET | `/actas/:id/pdf` | `LECTURA` | admin, auditor | `logistica.actas.descargar` |
| GET | `/:id` | `LECTURA` | admin, auditor | `logistica.documento.ver` |
| POST | `/validar-lt` | `CAMPO` | admin, mensajero | `logistica.lt.validar` |
| POST | `/escanear` | `CAMPO` | admin, mensajero | `logistica.documento.escanear` |
| POST | `/documentos/:id/novedad` | `CAMPO` | admin, mensajero | `logistica.documento.reportar_novedad` |
| POST | `/cerrar-lote` | `OPERACIONES` | admin | `logistica.lote.cerrar` |
| POST | `/actas/:id/despachar` | `OPERACIONES` | admin | `logistica.actas.despachar` |
| POST | `/actas/:id/entregar` | `CAMPO` | admin, mensajero | `logistica.actas.entregar` |
| POST | `/actas/:id/devolucion` | `CAMPO` | admin, mensajero | `logistica.actas.devolver` |
| POST | `/documentos/:id/reversar` | `OPERACIONES` | admin | `logistica.documento.reversar` |

#### `flito-bolsas/flito-bolsas.routes.ts` — 18 rutas

| Método | Ruta | Guarda de hoy | Roles de hoy | Código (`exigirFuncion`) |
|---|---|---|---|---|
| GET | `/consolidado` | `BOLSAS` | admin, financiera | `bolsas.consolidado.ver` |
| GET | `/riesgo` | `BOLSAS` | admin, financiera | `bolsas.riesgo.ver` |
| GET | `/alertas` | `BOLSAS` | admin, financiera | `bolsas.alertas.ver` |
| GET | `/transito` | `BOLSAS` | admin, financiera | `bolsas.transito.listar` |
| POST | `/transito` | `BOLSAS` | admin, financiera | `bolsas.transito.crear` |
| GET | `/:companiaId` | `BOLSAS` | admin, financiera | `bolsas.bolsa.ver` |
| GET | `/:companiaId/movimientos` | `BOLSAS` | admin, financiera | `bolsas.movimientos.ver` |
| POST | `/:companiaId/recargas` | `BOLSAS` | admin, financiera | `bolsas.recarga.registrar` |
| GET | `/soportes/:soporteId` | `BOLSAS` | admin, financiera | `bolsas.soporte.descargar` |
| GET | `/transito/:bolsaId` | `BOLSAS` | admin, financiera | `bolsas.transito.ver` |
| PATCH | `/transito/:bolsaId` | `BOLSAS` | admin, financiera | `bolsas.transito.editar` |
| GET | `/transito/:bolsaId/movimientos` | `BOLSAS` | admin, financiera | `bolsas.transito.ver_movimientos` |
| POST | `/transito/:bolsaId/cargas` | `BOLSAS` | admin, financiera | `bolsas.transito.cargar` |
| GET | `/:companiaId/extracto` | `BOLSAS` | admin, financiera | `bolsas.extracto.descargar` |
| POST | `/:companiaId/movimientos-manuales` | `BOLSAS` | admin, financiera | `bolsas.movimiento.registrar` |
| POST | `/:companiaId/movimientos/:movimientoId/correccion` | `BOLSAS` | admin, financiera | `bolsas.movimiento.corregir` |
| GET | `/:companiaId/cierres` | `BOLSAS` | admin, financiera | `bolsas.cierres.ver` |
| POST | `/:companiaId/cierres` | `BOLSAS` | admin, financiera | `bolsas.cierre.crear` |

#### `flito-conciliacion/flito-conciliacion.routes.ts` — 9 rutas

| Método | Ruta | Guarda de hoy | Roles de hoy | Código (`exigirFuncion`) |
|---|---|---|---|---|
| POST | `/boletas` | `CONCILIACION` | admin, financiera | `conciliacion.boleta.cargar` |
| GET | `/boletas` | `CONCILIACION` | admin, financiera | `conciliacion.boletas.listar` |
| GET | `/boletas/:id` | `CONCILIACION` | admin, financiera | `conciliacion.boleta.ver` |
| POST | `/boletas/:id/recruzar` | `CONCILIACION` | admin, financiera | `conciliacion.boleta.recruzar` |
| POST | `/boletas/:id/conciliar` | `CONCILIACION` | admin, financiera | `conciliacion.boleta.conciliar` |
| POST | `/boletas/:id/descartar` | `CONCILIACION` | admin, financiera | `conciliacion.boleta.descartar` |
| POST | `/boletas/:id/comprobante` | `CONCILIACION` | admin, financiera | `conciliacion.comprobante.cargar` |
| PUT | `/boletas/:id/comprobante` | `CONCILIACION` | admin, financiera | `conciliacion.comprobante.reemplazar` |
| GET | `/boletas/:id/comprobante` | `CONCILIACION` | admin, financiera | `conciliacion.comprobante.descargar` |

#### `flito-comparendos/flito-comparendos.routes.ts` — 21 rutas

| Método | Ruta | Guarda de hoy | Roles de hoy | Código (`exigirFuncion`) |
|---|---|---|---|---|
| GET | `/nits` | `router.use` | admin | `comparendos.nits.listar` |
| POST | `/nits` | `router.use` | admin | `comparendos.nits.crear` |
| PATCH | `/nits/:id` | `router.use` | admin | `comparendos.nits.editar` |
| DELETE | `/nits/:id` | `router.use` | admin | `comparendos.nits.borrar` |
| GET | `/municipios` | `router.use` | admin | `comparendos.municipios.listar` |
| POST | `/municipios` | `router.use` | admin | `comparendos.municipios.crear` |
| PATCH | `/municipios/:id` | `router.use` | admin | `comparendos.municipios.editar` |
| GET | `/causales` | `router.use` | admin | `comparendos.causales.listar` |
| POST | `/causales` | `router.use` | admin | `comparendos.causales.crear` |
| PATCH | `/causales/:id` | `router.use` | admin | `comparendos.causales.editar` |
| GET | `/config/token-simit` | `router.use` | admin | `comparendos.simit.ver_token` |
| PUT | `/config/token-simit` | `router.use` | admin | `comparendos.simit.guardar_token` |
| POST | `/sync` | `router.use` | admin | `comparendos.sync.lanzar` |
| GET | `/sync/runs` | `router.use` | admin | `comparendos.sync.ver_corridas` |
| GET | `/sync/runs/:id` | `router.use` | admin | `comparendos.sync.ver_corrida` |
| GET | `/registros` | `router.use` | admin | `comparendos.registros.listar` |
| POST | `/registros/buscar` | `router.use` | admin | `comparendos.registros.buscar` |
| POST | `/registros/export` | `router.use` | admin | `comparendos.registros.exportar` |
| GET | `/registros/:id` | `router.use` | admin | `comparendos.registro.ver` |
| GET | `/registros/:id/eventos` | `router.use` | admin | `comparendos.registro.ver_eventos` |
| PATCH | `/registros/:id/gestion` | `router.use` | admin | `comparendos.registro.gestionar` |

#### `flito-liquidacion/flito-liquidacion.routes.ts` — 6 rutas

| Método | Ruta | Guarda de hoy | Roles de hoy | Código (`exigirFuncion`) |
|---|---|---|---|---|
| GET | `/:tramiteId` | `LECTURA` | admin, auditor, financiera | `liquidacion.liquidacion.ver` |
| GET | `/:tramiteId/eventos` | `LECTURA` | admin, auditor, financiera | `liquidacion.liquidacion.ver_eventos` |
| POST | `/:tramiteId/liquidar` | `ESCRITURA` | admin, financiera | `liquidacion.liquidacion.liquidar` |
| POST | `/lote/liquidar` | `ESCRITURA` | admin, financiera | `liquidacion.liquidacion.liquidar_lote` |
| POST | `/:tramiteId/reversar` | `REVERSO` | admin | `liquidacion.liquidacion.reversar` |
| POST | `/:tramiteId/facturar` | `ESCRITURA` | admin, financiera | `liquidacion.liquidacion.facturar` |

#### `flito-parametrizacion/flito-parametrizacion.routes.ts` — 13 rutas

| Método | Ruta | Guarda de hoy | Roles de hoy | Código (`exigirFuncion`) |
|---|---|---|---|---|
| GET | `/companias` | `LECTURA` | admin, auditor | `parametrizacion.companias.listar` |
| PATCH | `/companias/:id` | `ESCRITURA` | admin | `parametrizacion.companias.editar` |
| GET | `/proveedores-soat` | `LECTURA` | admin, auditor | `parametrizacion.proveedores.listar` |
| POST | `/proveedores-soat` | `ESCRITURA` | admin | `parametrizacion.proveedores.crear` |
| PATCH | `/proveedores-soat/:id` | `ESCRITURA` | admin | `parametrizacion.proveedores.editar` |
| GET | `/organismos` | `LECTURA` | admin, auditor | `parametrizacion.organismos.listar` |
| GET | `/organismos/:codigo/vigencias` | `LECTURA` | admin, auditor | `parametrizacion.organismos.ver_vigencias` |
| POST | `/organismos/:codigo/modalidad` | `ESCRITURA` | admin | `parametrizacion.organismos.fijar_modalidad` |
| PATCH | `/organismos/:codigo` | `ESCRITURA` | admin | `parametrizacion.organismos.editar` |
| GET | `/tarifas` | `LECTURA_TARIFAS` | admin, auditor, financiera | `parametrizacion.tarifas.listar` |
| POST | `/tarifas` | `ESCRITURA_TARIFAS` | admin, financiera | `parametrizacion.tarifas.crear` |
| PATCH | `/tarifas/:id` | `ESCRITURA_TARIFAS` | admin, financiera | `parametrizacion.tarifas.editar` |
| DELETE | `/tarifas/:id` | `ESCRITURA_TARIFAS` | admin, financiera | `parametrizacion.tarifas.borrar` |

#### `flito-sync/flito-sync.routes.ts` — 2 rutas

| Método | Ruta | Guarda de hoy | Roles de hoy | Código (`exigirFuncion`) |
|---|---|---|---|---|
| GET | `/estado` | inline | admin | `sync.sync.ver_estado` |
| POST | `/sincronizar` | inline | admin | `sync.sync.lanzar` |

#### `tramites/tramites.routes.ts` — 42 rutas

| Método | Ruta | Guarda de hoy | Roles de hoy | Código (`exigirFuncion`) |
|---|---|---|---|---|
| GET | `/tipologias` | `router.use` | admin, transito | `tramite.tipologias.ver` |
| GET | `/motivos-rechazo-ot` | `router.use` | admin, transito | `tramite.motivos_rechazo.ver` |
| GET | `/embudo` | `router.use` | admin, transito | `tramite.embudo.ver` |
| GET | `/notif-config` | `router.use` | admin, transito | `tramite.notificaciones.ver_config` |
| GET | `/metrics/summary` | inline | admin | `tramite.metricas.ver_resumen` |
| GET | `/metrics/gestor` | `router.use` | admin, transito | `tramite.metricas.ver_gestor` |
| GET | `/lote/plantilla.csv` | `router.use` | admin, transito | `tramite.lote.descargar_plantilla` |
| POST | `/lote/preview` | `router.use` | admin, transito | `tramite.lote.previsualizar` |
| GET | `/lote` | `router.use` | admin, transito | `tramite.lote.listar` |
| POST | `/lote/async` | `router.use` | admin, transito | `tramite.lote.procesar_async` |
| POST | `/lote/confirm` | `router.use` | admin, transito | `tramite.lote.confirmar` |
| POST | `/lote` | `router.use` | admin, transito | `tramite.lote.crear` |
| GET | `/lote/:id/estado` | `router.use` | admin, transito | `tramite.lote.ver_estado` |
| GET | `/lote/:id` | `router.use` | admin, transito | `tramite.lote.ver` |
| POST | `/lote/:id/reprocesar-errores` | inline | admin | `tramite.lote.reprocesar` |
| GET | `/lote/:id/resultados.csv` | inline | admin | `tramite.lote.descargar_resultados` |
| POST | `/preflight` | `router.use` | admin, transito | `tramite.preflight.evaluar` |
| POST | `/impuesto-vehicular/consultar` | `router.use` | admin, transito | `tramite.impuesto.consultar` |
| GET | `/stats/metricas` | `router.use` | admin, transito | `tramite.estadisticas.ver_metricas` |
| GET | `/stats/resumen` | `router.use` | admin, transito | `tramite.estadisticas.ver_resumen` |
| GET | `/` | `router.use` | admin, transito | `tramite.cola.ver` |
| GET | `/:id` | `router.use` | admin, transito | `tramite.tramite.ver` |
| GET | `/:id/checklist` | `router.use` | admin, transito | `tramite.checklist.ver` |
| POST | `/:id/checklist/sugerir` | `router.use` | admin, transito | `tramite.checklist.sugerir` |
| GET | `/:id/preflight` | `router.use` | admin, transito | `tramite.preflight.ver` |
| POST | `/:id/preflight/cta` | `router.use` | admin, transito | `tramite.preflight.accionar` |
| POST | `/:id/rechazar-ot` | `router.use` | admin, transito | `tramite.tramite.rechazar_ot` |
| GET | `/:id/timeline` | `router.use` | admin, transito | `tramite.tramite.ver_historial` |
| POST | `/:id/invitar` | `router.use` | admin, transito | `tramite.participantes.invitar` |
| GET | `/:id/participantes-pendientes` | `router.use` | admin, transito | `tramite.participantes.ver_pendientes` |
| GET | `/:id/expediente.pdf` | `router.use` | admin, transito | `tramite.expediente.descargar` |
| POST | `/:id/verify-token` | `router.use` | admin, transito | `tramite.participantes.verificar_enlace` |
| POST | `/` | `router.use` | admin, transito | `tramite.tramite.crear` |
| PATCH | `/:id/estado` | `router.use` | admin, transito | `tramite.tramite.cambiar_estado` |
| PATCH | `/:id` | `router.use` | admin, transito | `tramite.tramite.editar` |
| POST | `/:id/documentos` | `router.use` | admin, transito | `tramite.documentos.cargar` |
| GET | `/:id/documentos` | `router.use` | admin, transito | `tramite.documentos.listar` |
| GET | `/:tramiteId/documentos/:docId/archivo` | `router.use` | admin, transito | `tramite.documentos.descargar` |
| DELETE | `/:tramiteId/documentos/:docId` | `router.use` | admin, transito | `tramite.documentos.borrar` |
| POST | `/:id/generar-fur` | `router.use` | admin, transito | `tramite.fur.generar` |
| POST | `/:id/generar-contrato` | `router.use` | admin, transito | `tramite.contrato.generar` |
| POST | `/:id/generar-improntas` | `router.use` | admin, transito | `tramite.improntas.generar` |

#### `tramites/ocr-docs.routes.ts` — 2 rutas

| Método | Ruta | Guarda de hoy | Roles de hoy | Código (`exigirFuncion`) |
|---|---|---|---|---|
| POST | `/ocr/:tipo` | `router.use` | admin | `tramite.ocr.leer` |
| GET | `/ocr-extracted/:filename` | `router.use` | admin | `tramite.ocr.descargar` |

#### `tramites/identidad.routes.ts` — 6 rutas

| Método | Ruta | Guarda de hoy | Roles de hoy | Código (`exigirFuncion`) |
|---|---|---|---|---|
| GET | `/sse` | inline | admin | `tramite.identidad.seguir` |
| POST | `/iniciar` | inline | admin | `tramite.identidad.iniciar` |
| POST | `/iniciar-partes` | inline | admin | `tramite.identidad.iniciar_partes` |
| GET | `/estado/:tramiteId` | inline | admin | `tramite.identidad.ver_estado` |
| GET | `/documentos/:tramiteId` | inline | admin | `tramite.identidad.ver_documentos` |
| POST | `/certificado/:tramiteId` | inline | admin | `tramite.identidad.certificar` |

#### `tramites/transito.routes.ts` — 8 rutas

| Método | Ruta | Guarda de hoy | Roles de hoy | Código (`exigirFuncion`) |
|---|---|---|---|---|
| GET | `/organismos` | `router.use` | admin, transito | `transito.organismos.listar` |
| GET | `/pendientes` | `router.use` | admin, transito | `transito.bandeja.ver_pendientes` |
| GET | `/mis-tramites` | `router.use` | admin, transito | `transito.bandeja.ver_propios` |
| GET | `/traspasos` | `router.use` | admin, transito | `transito.traspasos.listar` |
| GET | `/traspasos/:id` | `router.use` | admin, transito | `transito.traspasos.ver` |
| POST | `/tomar/:id` | `router.use` | admin, transito | `transito.tramite.tomar` |
| POST | `/asignar-placa/:id` | `router.use` | admin, transito | `transito.placa.asignar` |
| POST | `/confirmar-placa/:id` | `router.use` | admin, transito | `transito.placa.confirmar` |

#### `tramites/transito-config.routes.ts` — 8 rutas

| Método | Ruta | Guarda de hoy | Roles de hoy | Código (`exigirFuncion`) |
|---|---|---|---|---|
| GET | `/organismos-config` | inline | admin | `transito.config.listar` |
| GET | `/organismos-config/:codigo` | inline | admin, transito | `transito.config.ver` |
| GET | `/organismos-config/:codigo/checklist/:tipologia` | inline | admin, transito | `transito.checklist.ver` |
| PUT | `/organismos-config/:codigo/checklist/:tipologia` | inline | admin | `transito.checklist.editar` |
| PUT | `/organismos-config/:codigo` | inline | admin | `transito.config.editar` |
| GET | `/organismos-config/:codigo/logo` | inline | admin, transito | `transito.logo.ver` |
| POST | `/organismos-config/:codigo/logo` | inline | admin | `transito.logo.cargar` |
| DELETE | `/organismos-config/:codigo/logo` | inline | admin | `transito.logo.borrar` |

#### Rutas que la foto NO tiene y esta HU debe guardar con código (→ §5, migración 0181)

| Fichero | Método | Ruta | Guarda de hoy | Roles de hoy | Código propuesto |
|---|---|---|---|---|---|
| `flito-impuestos/flito-impuestos.routes.ts` | POST | `/:id/asumir-operaciones` | `OPERACIONES` (en un `for`, `:606-610`) | admin | `impuestos.tramite.asumir` |
| `flito-impuestos/flito-impuestos.routes.ts` | POST | `/:id/devolver-gestor` | `OPERACIONES` (mismo `for`) | admin | `impuestos.tramite.devolver` |
| `users/users.routes.ts` | GET | `/export` | `router.use` | admin | `usuarios.usuario.exportar` |
| `users/users.routes.ts` | GET | `/resumen` | `router.use` | admin | `usuarios.usuario.ver_resumen` |
| `users/users.routes.ts` | GET | `/` | `router.use` | admin | `usuarios.usuario.listar` |
| `users/users.routes.ts` | POST | `/` | `router.use` | admin | `usuarios.usuario.crear` |
| `users/users.routes.ts` | PATCH | `/:id` | `router.use` | admin | `usuarios.usuario.editar` |
| `users/users.routes.ts` | PATCH | `/:id/toggle` | `router.use` | admin | `usuarios.usuario.activar` |
| `users/users.routes.ts` | POST | `/:id/invalidate-sessions` | `router.use` | admin | `usuarios.sesiones.invalidar` |
| `users/users.routes.ts` | PATCH | `/:id/password` **[ajena]** | `role !== 'admin'` en línea (`:38`) | admin (o el propio usuario, que no es permiso) | `usuarios.contrasena.cambiar_ajena` |
| `tramites/tramites.routes.ts` | PATCH | `/:id` **[_forzarContinuar]** | `role !== 'admin'` en línea (`:615`) | admin | `tramite.tramite.forzar_continuar` |

El `for` de impuestos se **desenrolla** en dos `router.post` explícitos: el lector exige literal (§3) y `rutaDe` necesita la plantilla. Los nombres de negocio de las 11 los confirma el producto (§14); los códigos siguen el objeto que cada módulo ya usa (`impuestos.tramite.*`, `tramite.tramite.*`).

#### Rutas de los 21 ficheros que NO llevan guarda de rol y siguen igual

`tramites/identidad.routes.ts` `GET /info/:token` y `POST /completar/:token` (públicas con limitador) y `POST /recortar-cedula` (solo `authMiddleware`); `users/users.routes.ts` `PATCH /:id/password` cuando `sub === id`. No son operaciones del catálogo (la #12081 lo decidió así) y esta HU no les añade guarda: reconducir no es endurecer. El test de §9 las enumera como lista blanca para que una ruta nueva sin guarda no pase por «una de estas».

---

## 5. Los 11 huecos del catálogo y la migración 0181

Dos orígenes, ambos de la #12081: (1) `users/` no estaba en `FICHEROS_EN_ALCANCE` aunque el Feature lo nombra; (2) el lector no ve rutas declaradas con template literal (las 2 de impuestos) ni comparaciones en línea (las 2 de §1.3). Los 11 códigos van a `catalogo-operaciones.ts` (con `USR = 'users/users.routes.ts'` y un nuevo `{ modulo: 'usuarios', fichero: USR }` en `FICHEROS_EN_ALCANCE`), a la foto (11 entradas a mano, las 2 en línea con `condicion`) y a la base:

`0181_permisos_reconduccion.sql` — sin BEGIN/COMMIT, idempotente en sentido fuerte, `ON CONFLICT DO NOTHING`, como la 0179:
- `INSERT INTO permisos_funciones` × 11 (`modulo` = `impuestos`, `usuarios`, `tramite`; `tipo = 'operacion'`), líneas producidas con `npm run permisos:seed` y recortadas a las 11 nuevas.
- `INSERT INTO permisos_rol_funcion ('admin', …)` × 11. Ningún otro rol: hoy todas son `requireRole('admin')` o `role === 'admin'`.
- Sin `DELETE`, sin `UPDATE`, sin bump de sesiones: `resolverPermisos` cachea 60 s y el CD reinicia el API al desplegar.
- `COMMENT ON` no aplica (no hay tabla nueva). `schema.ts` **no cambia**.

Dependencia: 0179 → 0180 → 0181. La #12086 pasa a la 0182.

---

## 6. Test de paridad — `apps/api/__tests__/services/permisos.paridad-reconduccion.test.ts` (AC7, AC8)

Cuatro fuentes, ninguna derivada de otra:

| Lado | Fuente | Qué aporta |
|---|---|---|
| Qué rutas se reconducen | `RUTAS_RECONDUCIDAS` en `apps/api/__tests__/fixtures/permisos-rutas-reconducidas.ts`: `{ fichero, metodo, ruta, condicion?, codigo }[]`, **escrita a mano, sin glob**, en bloques por oleada. Al cerrar la HU son 219 + 2 | la enumeración explícita del AC |
| Que el código está montado | `montajesDeFunciones()` sobre el fuente (§3) | una fila de la lista sin `exigirFuncion` en el código → rojo; un `exigirFuncion` sin fila → rojo |
| Decisión de ANTES | `GUARDAS_MEDIDAS` (foto congelada) por llave: `roles.includes(rol)` | una fila sin foto → rojo («ruta sin historial») |
| Decisión del MOTOR | `resolverPermisos(sub)` **real**, con `fijarFuenteDePermisos` devolviendo por cada rol `{ rol, tipoPrincipal, allowedPages: [], funcionesDelRol: <pares del SQL>, excepciones: [] }`; los pares salen de **parsear el bloque `INSERT INTO permisos_rol_funcion` de `0179` y `0181`** con un helper `__tests__/helpers/permisos-seed-sql.ts` (`leerRepartoSembrado(): Map<rol, Set<codigo>>`) | `p.ok && p.funciones.has(codigo)`, la misma línea que `exigir-funcion.ts:150` |

Matriz: los 12 roles de `USER_ROLES` × cada fila = 2 652 decisiones al cierre. Un caso de Vitest **por ruta** (no uno gigante) que recorre los 12 roles y falla con `«${fichero} ${metodo} ${ruta} · rol ${rol}: antes ${SÍ|NO}, motor ${SÍ|NO}»`. Con `TEST_DATABASE_URL` presente, un segundo `describe.skipIf` repite la matriz leyendo `permisos_rol_funcion` de la base real en vez del SQL; en CI (sin Postgres) solo corre el primero.

Por qué no es circular: la foto da «antes», el SQL da «motor», la lista da «qué», el lector da «dónde». Regenerar la foto desde el código nuevo (lo que el encargo llamaba opción (a) a secas) habría unido «antes» y «qué» en una sola fuente.

**Mutaciones del AC8, y dónde caen:**
- Borrar `('auditor', 'soat.cola.ver')` de la 0179 → el SQL ya no lo da → motor NO, foto SÍ → rojo en el caso `flito-soat/flito-soat.routes.ts GET /` con `rol auditor`. Se revierte el SQL después.
- Devolver `requireRole('admin')` a `POST /enviar` de SOAT → `leerMontajes` ya no ve `exigirFuncion` en esa ruta → rojo aquí («fila sin montaje») **y** en el test de §9 (AC1).
- Mutante de control que **debe sobrevivir**: cambiar el nombre de negocio de una función en `catalogo-operaciones.ts`. La paridad no mira nombres.

Por qué a nivel de resolutor y no por HTTP: montar los 21 routers reales exige los mocks de base de cada módulo (81 specs distintos); la equivalencia «`exigirFuncion` decide con `has(codigo)`» ya la fija el laboratorio de la #12082 (`permisos-exigir-funcion.test.ts`). Este test prueba lo que la #12082 no podía: que el conjunto sembrado reproduce el `requireRole`.

---

## 7. Test valla — `apps/api/__tests__/services/permisos.valla-legacy.test.ts` (AC4, AC5)

Enumera los 11 directorios con el número medido el día en que se escribe (hoy: `pesv` 48, `maintenance` 33, `laft` 28, `drivers` 24, `siigo` 19, `rutas` 16, `soat` 11, `vehicles` 10, `fleet` 10, `rndc` 3, `jornadas` 3 — el backend vuelve a medir con `sinComentarios`, que se exporta del lector, y escribe los suyos con el comando en el comentario). Dos asertos por directorio:

1. `requireRole(` (sin comentarios) **≥ el medido**. No exacto: `pesv/` recibe merges de otras sesiones (memoria: «el tip de la ráfaga no son solo tus merges») y un número exacto convertiría cada HU legacy en un rojo de esta valla. Lo que el AC pide es que nadie **pierda** guardas, y «≥ por directorio» lo cubre sin que el crecimiento de uno tape la pérdida de otro.
2. **Ningún fichero del directorio importa `exigir-funcion.js`.** Esta es la valla real: reconducir «de paso» es exactamente cambiar un import, y se ve aunque el conteo no baje (alguien podría añadir un `requireRole` y reconducir otro).

`soat/` (AC5) es una fila más de la misma tabla. `siigo/` conserva su `puedeEjecutar` compilado (AC4: «referencia, no se mueve»); la única costura entre Siigo y un módulo reconducido es `siigo-facturacion.routes.test.ts:155-160`, que pasa a comparar `ROLES_POR_ACCION.emitir` con los roles de la foto para `liquidacion.liquidacion.facturar` (`['admin','financiera']`), y `ROLES_LIQUIDACION_ESCRITURA` desaparece de `flito-liquidacion.routes.ts` con su alias.

Los 22 `requireRole` de `permisos/`, `clients/`, `privacy/`, `firma/`, `drive/`, `rum/`, `liquidacion/`, `finanzas/` no están en ninguna de las dos listas del AC. **No se tocan ni se vallan**: el AC4 nombra 11 directorios y 205 apariciones y esta HU no amplía alcance. Queda como observación en el PR (igual que el AC5 pide para `soat/`), con una nota aparte: `permisos/permisos.routes.ts:17` guarda el panel de permisos con un `requireRole('admin')` cableado por decisión escrita en su cabecera.

---

## 8. Test del auditor — `apps/api/__tests__/services/permisos.auditor-observa.test.ts` (AC6)

«Lectura» y «ejecución» se derivan del **método HTTP de la foto**, no del sufijo del código: es lo que había (`LECTURA = requireRole('admin','auditor')` protege solo `GET` en los 11 módulos donde el auditor existe) y lo único medible sin interpretar nombres. Medido: 41 rutas GET con `auditor`, 0 no-GET. Tres asertos, rol por rol contra el seed parseado (§6):

1. `auditor` tiene en el seed **exactamente** los 41 códigos de las rutas `GET` que la foto le concede (lista explícita en el test, agrupada por módulo: soat 5, impuestos 5, derechos 6, revisiones 3, compuerta 2, tramites 4, tablero 1, bitácora 2, logística 6, liquidación 2, parametrización 5 — el backend la escribe desde la foto y la fija). Un código de más o de menos → rojo con el código.
2. Ningún código del `auditor` corresponde a una ruta **no-GET** de la foto ni a una guarda en línea.
3. Secundario: ningún código del `auditor` termina en verbo de ejecución (`crear|editar|borrar|enviar|cargar|certificar|liquidar|facturar|reversar|…`, la lista de sufijos no-GET medida hoy). Es redundante con 2 a propósito: si mañana un `GET` ejecuta algo, este es el que lo cuenta.

Y para los otros 11 roles, el mismo esquema en una sola tabla: `{ rol → códigos de operación en el seed }` comparado con la foto (`roles.includes(rol)` por ruta). Es la vista por rol de la paridad de §6, sin el motor en medio: si §6 está verde, esto lo está; si esto se pone rojo, dice **qué rol** ganó o perdió.

---

## 9. Test de cierre — `apps/api/__tests__/services/permisos.reconduccion-cierre.test.ts` (AC1, AC2, AC3)

- Los 19 directorios: **cero** `requireRole(` fuera de comentarios (`sinComentarios` del lector) y cero `import … requireRole`.
- Los 21 ficheros de rutas: importan `exigirFuncion`; conservan `router.use(authMiddleware)` o, en `identidad.routes.ts`, `authMiddleware` en cada ruta que lo llevaba (lista explícita de 7).
- Cada `router.(get|post|…)` de los 21 ficheros lleva `exigirFuncion('…')` **o** está en la lista blanca de §4 (4 rutas). Es la red que sustituye a los `router.use` retirados.
- `leerGuardas(f)` devuelve `[]` para los 21 (el lector viejo ya no ve nada) y `leerMontajes(f)` cubre la foto entera (219 + 2).
- Las **14 comparaciones de ámbito** (AC3) siguen existiendo, enumeradas por fichero y línea aproximada (regex por contenido, no por número de línea): `contextoSoat` (`flito-soat.service.ts` ×4), `contextoImpuesto` (`flito-impuestos.routes.ts` ×1, `flito-impuestos.service.ts` ×1, `flito-recibos.service.ts` ×1), `resolveTransitoScope` (`transito-scope.ts` ×2), organismo del `transito` (`transito-config.routes.ts` ×3), actas del mensajero (`flito-logistica.service.ts` ×3). Que sigan ahí es el AC3 en forma de test; que un `cliente` siga viendo solo su compañía lo prueban los specs de aislamiento que ya existen (`flito-soat.cliente-aislamiento.test.ts`, `flito-impuestos.frontera-organismos.test.ts`).
- Mutación del AC8: devolver `requireRole('admin')` a una ruta → rojo en el primer aserto **y** en el tercero.

---

## 10. Orden de reconducción y tamaño

Un PR, seis commits, cada uno verde en `permisos-catalogo` (invariante transitorio) y `paridad` (lista parcial). Las oleadas se ordenan de menor a mayor acoplamiento con specs y con el `users/` al final porque necesita la 0181 y una decisión de producto (§14):

| Oleada | Ficheros | Rutas | Qué más |
|---|---|---|---|
| 0 — andamio | `inventario-guardas.ts` (+`leerMontajes`, `condicion`, `sinComentarios` exportado), `exigir-funcion.ts` (+`tieneFuncion`), `auth.ts` (tipado), `helpers/auth.ts` (§11.1), bandera de bitácora (§11.2), `helpers/permisos-seed-sql.ts`, fixture vacía, 4 tests nuevos (verdes con lista vacía; el de cierre en `describe.skip` hasta la oleada 5), ajuste de `permisos-catalogo.test.ts` | 0 | Sin tocar rutas: este commit prueba que el andamio no rompe los 81 specs |
| 1 — cadena SOAT | `flito-soat` (16), `flito-soat-cliente` (3), `flito-parametrizacion` (13), `flito-compuerta` (3), `flito-bolsas` (18), `flito-revisiones` (5), `flito-sync` (2) | 60 | 2 asertos de cuerpo en `cliente-lectura-factura` |
| 2 — FLITO sin router.use | `flito-impuestos` (16 + 2 desenrolladas), `flito-derechos` (8), `flito-tramites` (13), `flito-tablero` (1), `flito-bitacora` (2), `flito-logistica` (15), `flito-conciliacion` (9), `flito-liquidacion` (6) | 72 | 0181 entra aquí (impuestos); `siigo-facturacion.routes.test.ts` |
| 3 — router.use de FLITO y tránsito | `flito-comparendos` (21), `tramites/transito` (8), `tramites/transito-config` (8), `tramites/ocr-docs` (2), `tramites/identidad` (6) | 45 | Primeras rutas con `:token`/`:tramiteId`: comprobar en un spec que la bitácora guarda la plantilla |
| 4 — tramites.routes.ts | 42 + `_forzarContinuar` en línea | 43 | El fichero más grande (711 sloc, techo 860): los `exigirFuncion` van en la misma línea de la ruta, +0 líneas |
| 5 — users/ y cierre | `users.routes.ts` (7 + contraseña ajena en línea), retirar `leerGuardas`/`CONSTANTES_ROLES`/`--snapshot`, activar el test de cierre, reescribir los 4 comentarios que mencionan `requireRole(` | 8 | Exige la decisión de §14 sobre los 8 nombres |

Tamaño estimado: producción ≈ 330 líneas tocadas en 21 ficheros de rutas (una por ruta, más imports y alias retirados) + ≈ 120 en `permisos/` y `shared/` + ≈ 50 de migración; tests ≈ 750 (fixture 230, paridad 150, valla 60, auditor 90, cierre 100, catálogo 60, helpers 60). **≈ 1 300 líneas: un PR.** Partirlo por oleadas en PRs separados no es posible sin romper la promesa del AC («la cadena se promueve junta») y, apilado sobre la #12082, cada PR intermedio correría con cero checks de CI (memoria: «PR apilado = cero checks»).

---

## 11. Riesgos y su mitigación

### 11.1 Los 81 specs: el rol de prueba no tiene operaciones

Con el double de la #12082, `testToken({ role: 'proveedor' })` resuelve `pagina.*` y **ninguna `operacion.*`**: reconducir una ruta pone en 403 a todos los specs que la llaman con el token por defecto (`admin`), que son casi los 81. Mecanismo: `testToken` carga automáticamente las operaciones del rol desde `repartoDePartida()` —la foto, que es lo que la base tiene sembrado— y `opts.funciones` sigue siendo aditivo:

```ts
const REPARTO_POR_ROL = new Map<string, string[]>();   // se llena una vez, en diferido
funcionesDelRol: [...operacionesDePartida(role), ...paginasPorDefecto(role).map(s => `pagina.${s}`), ...(opts.funciones ?? [])]
```

`helpers/auth.ts` ya importa `catalogo.js` (`PAGINAS_NO_CONCEDIBLES`), así que no entra ninguna dependencia nueva en la cadena de imports. Un rol inventado por un spec (`auth('gestor', …)` en `cliente-lectura-factura`) no está en la foto → sin operaciones → 403, como hoy. Los 2 specs que ya pasan `funciones:` (laboratorio de la #12082) no cambian.

Lo que **sí** cambia y hay que tocar: los 2 asertos `toEqual({ error: 'Sin permisos' })` de `flito-soat.cliente-lectura-factura.test.ts:305,313` pasan a `expect(r.body).toMatchObject({ funcion: 'soat.factura.leer', motivo: 'sin_funcion' })` (admin tiene otras `soat.*`) y `'sin_modulo'` para «gestor». El comentario «indistinguible» de ese spec describía `requireRole`; el 403 explicado es decisión de la #12082 (AC5), no de esta.

### 11.2 La bitácora del 403 consume mocks de `insert`

`registrarIntentoDenegado` hace `db.insert(...)` en cuanto se deniega; en un spec cuyo mock de `db/client.js` expone `insert`, el `insertMock` cuenta una llamada y un aserto `not.toHaveBeenCalled` del mismo caso se pone rojo. 12 ficheros son candidatos (contexto medido); cuántos casos reales, lo mide la oleada 0. Mitigación con el patrón que ya existe: `registrarIntentoDenegado` sale sin escribir cuando `PERMISOS_SKIP_BITACORA_INTENTOS === '1'` (leído en caliente, como `AUTH_SKIP_SESSION_INVAL_CHECK` en `auth.ts:89`), la bandera se pone en `__tests__/setup.ts`, y `permisos-exigir-funcion.test.ts` (que sí prueba la bitácora) la borra en su `beforeAll`. Tres líneas y cero specs tocados. La alternativa —ajustar los 12— es más honesta pero se paga en cada spec futuro que pruebe un 403.

### 11.3 E2E de Playwright

Nada que tocar: ningún spec de `web/e2e` afirma el cuerpo del 403 contra el API real (los 9 que mencionan 403 usan `route.fulfill` o son comentarios) y la SPA decide por status. Riesgo residual: el nocturno contra el servidor de otro worktree (memoria) — no es de esta HU.

### 11.4 Rutas con dato en el path

`flito-derechos /candidatos/:placa`, los `:tramiteId`/`:token` de identidad y los `:id` de comparendos entran por primera vez en `exigirFuncion`. Al ir a nivel de ruta, `rutaDe` guarda `req.baseUrl + req.route.path` (la plantilla). La oleada 3 lo comprueba con un aserto en un spec existente de derechos: el `insertMock` de la bitácora recibe `ruta: '/api/flito/derechos/candidatos/:placa'` y no la placa. Ese es el único spec donde la bandera de §11.2 se desactiva a propósito.

### 11.5 Sesiones vivas

Ninguna. El JWT no lleva permisos desde la #12082; un `admin` con sesión abierta resuelve las 11 funciones nuevas en cuanto la 0181 esté aplicada y el reinicio del deploy vacíe la caché de 60 s.

### 11.6 `permisos:seed` reproducible

`db/migracion-0179.test.ts` afirma que el reparto de la base es el que produce el generador; con la foto ampliada en 11 y la 0181 aplicada, ambos lados crecen igual. Si se aplica la 0181 sin ampliar la foto (o al revés), ese test —y `verificarCatalogoAlArrancar`— lo dicen.

---

## 12. Archivos a crear/modificar

**Producción (`apps/api/src`)**
- `shared/middleware/auth.ts` — `requireRole(...roles: UserRole[])`; el `includes` pasa a `(roles as readonly string[]).includes(req.user.role)` porque `req.user.role` es `RoleCode`. Import de `UserRole` desde shared-types. (+2 líneas)
- `shared/middleware/exigir-funcion.ts` — `tieneFuncion(req, codigo)`: mismo cuerpo que el middleware sin `res`; devuelve `boolean` y registra el intento. (+≈15)
- `shared/historial/permisos-intentos-denegados.ts` — salida temprana por bandera `PERMISOS_SKIP_BITACORA_INTENTOS`. (+3)
- `modules/permisos/inventario-guardas.ts` — `MontajeLeido`, `leerMontajes`, `montajesDeFunciones`; `condicion?` en `GuardaLeida` y en `llaveDe`; `export` de `sinComentarios`; `{ modulo: 'usuarios', fichero: 'users/users.routes.ts' }` en `FICHEROS_EN_ALCANCE`; cabecera. En la oleada 5: retirar `leerGuardas`, `rolesDe`, `CONSTANTES_ROLES` e `inventarioDeGuardas`. (+≈45, −≈60 al cierre)
- `modules/permisos/inventario.generado.ts` — cabecera nueva (foto histórica; edición manual solo con migración); +11 entradas (2 con `condicion`). No se regenera.
- `modules/permisos/catalogo-operaciones.ts` — `USR`; 11 `op(...)`; cabecera (ya no dice «si alguien cambia un requireRole…»). (+≈15)
- `scripts/generar-seed-permisos.ts` — retirar `--snapshot` y `--inventario`; `package.json` pierde `permisos:generar` y `permisos:inventario`.
- `db/migrations/0181_permisos_reconduccion.sql` — §5.
- Los **21 ficheros de rutas** de §4: import de `exigirFuncion` (y `tieneFuncion` en 2), retirada de `requireRole` del import, de los 29 alias y de los 5 `router.use`; un `exigirFuncion('<codigo>')` por ruta; `for` de impuestos desenrollado; 2 comparaciones en línea reconducidas; 4 comentarios reescritos. `flito-liquidacion.routes.ts` pierde `ROLES_LIQUIDACION_ESCRITURA`.

**Tests (`apps/api/__tests__`)**
- `helpers/auth.ts` — carga de operaciones por rol desde `repartoDePartida()`.
- `helpers/permisos-seed-sql.ts` — nuevo: `leerRepartoSembrado()`.
- `fixtures/permisos-rutas-reconducidas.ts` — nuevo: `RUTAS_RECONDUCIDAS`.
- `setup.ts` — bandera de §11.2.
- `services/permisos.paridad-reconduccion.test.ts` — nuevo (§6).
- `services/permisos.valla-legacy.test.ts` — nuevo (§7).
- `services/permisos.auditor-observa.test.ts` — nuevo (§8).
- `services/permisos.reconduccion-cierre.test.ts` — nuevo (§9).
- `services/permisos-catalogo.test.ts` — 3 casos cambian (§3).
- `services/permisos-exigir-funcion.test.ts` — borra la bandera en `beforeAll`; +2 casos de `tieneFuncion`.
- `services/flito-soat.cliente-lectura-factura.test.ts` — 2 asertos.
- `services/siigo-facturacion.routes.test.ts` — 1 caso (§7).
- `services/flito-derechos.test.ts` — 1 aserto de plantilla en la bitácora (§11.4).
- Los que la oleada 0 mida entre los 12 candidatos de §11.2, si la bandera no bastara.

**No se tocan**: `schema.ts`, `catalogo.ts`, `permisos.service.ts`, `permisos-efectivos.ts`, `canal-cliente.ts`, `apps/web`, `packages/shared-types`, los 11 directorios de la valla, `soat/`, `permisos.routes.ts`.

---

## 13. Notas operativas

**backend-agent**
- Receta por ruta: localizar el alias o el `requireRole(...)` en la línea del `router.<m>('<ruta>', …)`, sustituirlo por `exigirFuncion('<codigo de §4>')` **en esa misma posición**. Ni antes de `authMiddleware` ni después de otros middlewares que hoy vayan tras la guarda (limitadores, `upload.single`, `contextoSoat`).
- Los 5 `router.use(authMiddleware, requireRole(...))` → `router.use(authMiddleware)`. En comparendos, `:113` se borra y `:112` se queda.
- Tras cada oleada: `npx vitest run __tests__/services/permisos-catalogo.test.ts __tests__/services/permisos.paridad-reconduccion.test.ts` antes que la suite entera; y `npx eslint` con `max-lines` sobre `tramites.routes.ts` e `identidad.routes.ts`.
- El typecheck del tipado de `requireRole` es la prueba de que los 205 compilan; si algún literal fuera de `USER_ROLES` apareciera en los 11 directorios, **no se corrige ahí** (AC4): se anota en el PR y se decide.
- Los tests de `__tests__` no los typechequea `build:api` (memoria): correr `npx tsc -p apps/api/tsconfig.json --noEmit` con los tests incluidos o `vitest typecheck` sobre los 4 nuevos.
- La 0181 se produce con `npm run permisos:seed -w apps/api` **después** de ampliar la foto, tomando solo las 22 líneas nuevas; `npm run db:apply` exige superusuario y `operaciones_app` (memoria).
- Las mutaciones del AC8 se ejecutan y se adjuntan las tres salidas (dos rojas, una verde de control), con `git diff` antes de leer el test (memoria: «comprobar dónde cayó»).

**frontend-agent**: nada en esta HU. El `motivo` del 403 lo consume la pantalla en la HU del navegador.

**qa-agent**: la evidencia del AC7 es la salida completa de `permisos.paridad-reconduccion.test.ts` (219 + 2 casos) más las tres mutaciones. Para el AC3, los specs de aislamiento existentes son la prueba; no se piden nuevos.

---

## 14. Riesgos abiertos y qué falta decidir

**Resuelto en este diseño (no requiere humano):** lector + foto congelada (§3); reparto de las 5 guardas de router ruta a ruta; paridad con cuatro fuentes y SQL parseado (§6); valla por «≥» e import (§7); auditor por método (§8); tipado a `UserRole[]` (§1.5); seis oleadas en un PR (§10); carga automática del reparto en `testToken` y bandera de bitácora (§11).

**Solo lo puede decidir una persona:**

1. **Los 8 nombres de negocio de `usuarios.*`** (y los 2 de impuestos y el de `_forzarContinuar`): aparecen como casillas en el panel de permisos. Propuestos en §4; el producto los confirma o los cambia antes de la oleada 2 (impuestos) y la 5 (users).
2. **Que `users/` entre al catálogo en esta HU y no en la #12088.** El AC2 lo nombra y exige «código del catálogo»; la #12081 lo dejó fuera. Recomendación: aquí, porque sin la 0181 no hay forma de reconducir `users/` y el AC2 quedaría incumplido. Si el Líder Técnico prefiere diferirlo, la oleada 5 se recorta a «retirar `leerGuardas` y cerrar» y `users/` se declara en el PR como el segundo `soat/`.
3. **Retirar `permisos:generar`** del `package.json` frente a dejarlo fallando con mensaje. Recomendación: retirarlo; un script que solo sabe fallar es deuda.
4. **Los 22 `requireRole` fuera de las dos listas** (`permisos`, `clients`, `privacy`, `firma`, `drive`, `rum`, `liquidacion`, `finanzas`): esta HU los deja como observación en el PR. Si el producto quiere vallarlos también, son 8 filas más en el test de §7 (sin código de producción).
