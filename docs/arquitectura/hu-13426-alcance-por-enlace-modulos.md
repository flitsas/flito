# Diseño slim — HU #13426: alcance por enlace en los módulos FLITO

- **Modo:** slim · **ADR:** no aplica (extiende [ADR-0024](../adr/ADR-0024-frontera-por-enlace-declarada-en-el-montaje.md) §4.4 «enganche para #13426», sin tradeoff nuevo)
- **Feature:** #12871 · **HU:** #13426 (BACKEND) · **base:** rama apilada sobre #12876 (2fdc1d5e, contiene #12875)
- **Módulos:** los `flito-*` (`flito-tramites`, `flito-impuestos`, `flito-derechos`, `flito-bolsas`, `flito-comprobantes`, `flito-logistica`, `flito-tablero`) **y un legacy**: `tramites/transito*` (`/api/transito`). Esto último lo decidió el PO el 2026-10-09 (AC6). No se toca ningún otro legacy.
- **Sin cambio de esquema** (AC9). `db-review-agent`: no aplica.

## 1. Patrón reutilizado

| Pieza | Dónde está | Uso en #13426 |
|---|---|---|
| `conAlcance(modulo, router)` | `apps/api/src/shared/middleware/frontera-enlace.ts:136`, montajes en `apps/api/src/app.ts:264-268` | Envolver los montajes de los módulos que se abren |
| `FRONTERA_POR_ENLACE` | `packages/shared-types/src/permisos-roles.ts:41` | Abrir cada módulo **en el mismo PR** en que su servicio filtra |
| `alcanceDe(req)` | `frontera-enlace.ts:214` (memo por petición, lee BD) | Única fuente del alcance. Sustituye a `user.role` y a `contextoImpuesto` |
| `soloSinEnlace()` | `frontera-enlace.ts:186` | Cerrar catálogo, configuración y operación interna dentro de un router abierto |
| Filtro de filas por enlace | `flito-soat.service.ts` (`alcanceSoatDe`, `condicionesCola`, `buscarConAcceso`, Bug #12869) | Patrón vecino: una condición Drizzle por enlace que se aplica igual en lista, conteo, export y detalle |

**Pieza nueva y pequeña (no es patrón nuevo):** `apps/api/src/shared/alcance-filas.ts` (~60 líneas). Saca de SOAT la forma «condición por enlace» para que los 8 consumidores no la copien:

```ts
// Un id ausente (companiaId null, organismos []) → sql`false`: CERO filas, nunca «todo» (ADR-0024 §4.4).
export function condicionPorCompania(col: AnyColumn, a: AlcanceResuelto): SQL | undefined;   // ninguno → undefined
export function condicionPorOrganismos(col: AnyColumn, a: AlcanceResuelto): SQL | undefined; // ninguno → undefined
export function condicionPorProveedor(col: AnyColumn, a: AlcanceResuelto): SQL | undefined;
/** Escritura sobre un dueño concreto: lanza AlcanceAjenoError (403) si no es el suyo. No consulta si existe. */
export function exigirPropio(a: AlcanceResuelto, dueno: { companiaId?: number | null; organismo?: string | null }): void;
export class AlcanceAjenoError extends Error { status = 403 }
```

Un enlace que el módulo no contempla (p. ej. `proveedor` llamando a una condición de compañía) devuelve `sql\`false\``. No pasa en runtime porque la frontera lo corta antes, pero así un error de montaje falla cerrado. `flito-soat` **no se migra** a este helper en esta HU (funciona y está probado). Es una Nota para después.

## 2. Contrato delta

`FRONTERA_POR_ENLACE` al cierre de la HU (y `MODULOS_FRONTERA` gana `transito`; el código de módulo `transito` ya existe en el catálogo porque las funciones son `transito.*`):

```ts
soat:         ['compania', 'proveedor'],              // sin cambio
impuestos:    ['compania', 'organismos_transito'],
derechos:     ['organismos_transito'],
tramites:     ['compania'],      // Gestión Trámites
bolsas:       ['compania'],
comprobantes: ['compania'],
logistica:    ['compania'],
tablero:      ['compania'],      // AC4: solo bloques de su compañía
transito:     ['organismos_transito'],                // NUEVO (AC6, decisión PO 2026-10-09)
```

Semántica HTTP, igual en todos los módulos:

- **Lectura** (lista, facetas, conteo, export o zip) → solo filas del alcance. Si el alcance está vacío, la respuesta va vacía (200).
- **Detalle por id** ajeno → **404**, con el mismo cuerpo que el de un id inexistente (AC2). La condición de alcance va **en el WHERE** del detalle, no se comprueba después de leer.
- **Escritura** sobre un registro o dueño ajeno → **403** antes de tocar nada (AC3). `exigirPropio` va antes de la transacción o primero dentro de ella. Para no abrir un oráculo de existencia con ids enumerables (`companiaId` es un entero), el 403 se da **sin comprobar si el registro existe**: cualquier id distinto del propio da 403.
- **Ruta de catálogo, configuración u operación interna** → `soloSinEnlace()` → 403 (AC4).

Ningún endpoint ni DTO cambia de forma. Los tipos de shared-types que cambian son `MODULOS_FRONTERA` y `FRONTERA_POR_ENLACE`.

## 3. Inventario por módulo

Los números de línea están medidos sobre 2fdc1d5e. «Filtro hoy» describe lo que acota filas en ese momento.

### 3.1 Gestión Trámites — `flito-tramites` → `['compania']`

- **Filtro hoy:** ninguno por usuario. `routes.ts:31` arma el ctx con `role`. `service.ts:32-33` reenvía el `role` a los ctx de SOAT e Impuestos, con `organismos: []` y `proyeccionCliente: false` fijo.
- **Enganche:** el ctx de la ruta pasa a llevar `alcance: await alcanceDe(req)`. La condición `condicionPorCompania(flitoTramites.companiaId, alcance)` se añade a la función de condiciones del listado (`service.ts` ~564-602), que usan juntas el listado, el conteo y `facetas`. Lo mismo en `:id/historial` y `:id/soportes`, con 404 si el trámite es ajeno, y en `POST /soportes/zip`, que filtra los ids pedidos (un id ajeno se omite sin avisar, como en `certificados-zip.ts:68`, para no hacer de oráculo).
- **`soatCtx`/`impuestoCtx`** (`service.ts:32-33`): reenvían el `alcance`. Para una compañía, `proyeccionCliente` pasa a ser `alcance.enlace === 'compania'` (la proyección T3 de #12875). **Riesgo de fuga si se olvida:** el detalle mostraría los nombres de empleados internos.
- **Escrituras:** `solicitar-soat`, `solicitar-impuestos`, `solicitar-ambos`, `entregar`, `:id/desbloquear-autogestion` y `:id/revocar-autogestion` hacen `exigirPropio` sobre el `companiaId` de cada trámite tocado. Un lote mixto (uno ajeno) da 403 y no guarda nada.
- **`soloSinEnlace`:** `POST /crear-empresa` (crea una compañía, es catálogo) y `POST /demo`.

### 3.2 Impuestos — `flito-impuestos` → `['compania', 'organismos_transito']`

- **Filtro hoy (por nombre de rol, AC9):**
  - `flito-impuestos.routes.ts:121`: `contextoImpuesto` carga los organismos solo si `role === 'gestor_impuestos'`.
  - `flito-impuestos.service.ts:59`: `esGestor`, usado en `:256` (cola) y `:569` (detalle).
  - `flito-recibos.service.ts:324`: `esGestor` del lote, usado en `:340` (umbral) y `:507`.
  - `certificacion.service.ts:504`: consume `conds === null`.
- **Enganche:** `contextoImpuesto(req)` pasa a firmar con `req` y devuelve `ImpuestoCtx` con `alcance` en lugar de `organismos`/`role` para decidir. `esGestor(ctx)` se sustituye por `ctx.alcance.enlace === 'organismos_transito'`, y la condición se arma con `condicionPorOrganismos(flitoImpuestos.organismoCodigo, a) ?? condicionPorCompania(flitoImpuestos.companiaId, a)`. Los 5 sub-routers (`direccion`, `analisis`, `certificados`, `recibo-fase`, `recibo-reemplazo`) ya reciben `contextoImpuesto` por inyección, así que heredan el cambio sin tocar su firma más allá del parámetro.
- **Umbral de recibos** (`flito-recibos.service.ts:340`): hoy usa el umbral por organismo «si es gestor». Pasa a usarlo «si el enlace es `organismos_transito`». El comportamiento es idéntico para el gestor actual. **El backend debe leer `:256`, `:507` y `:569` antes de editar:** no las leí completas por presupuesto y pueden decidir algo más que filas (contingencia, «asumido por Operaciones»).
- **Export** (`POST /export`, `export.service.ts:204`) y zips (`/soportes/zip`, `/certificados/zip`): ya reciben el ctx real, así que heredan la condición.
- **`soloSinEnlace`:** `POST /:id/asumir-operaciones` (contingencia de Operaciones, HU #11155). Pendiente de confirmar en P-3: `devolver-gestor`, `reactivar`, `reversar`.
- **Escrituras con alcance** (`certificar`, `enviar`, `rechazar`, `recibos`, `recibo-caja`, `:id/direccion`, `:id/reanalizar`, `:id/recibos/reemplazar-pago`): leen el impuesto **con** la condición. Si no aparece, 403 vía `exigirPropio` (sin distinguir de inexistente).

### 3.3 Derechos — `flito-derechos` → `['organismos_transito']`

- **Filtro hoy:** ninguno. `routes.ts:48` arma el ctx con `role`. `facetasDerechos()` (`service.ts:676`) y el listado (`:698`) no acotan.
- **Enganche:** `condicionPorOrganismos(flitoDerechosTramite.organismoCodigo, a)` en el listado y en `facetasDerechos(alcance)` (las facetas pasan a recibir alcance). En `soporte/:id`, 404 si es ajeno. En `candidatos/:placa`, la consulta de `service.ts:163-178` se filtra por `flitoTramites.organismoCodigo`.
- **Escritura:** en `POST /cargar` (`routes.ts:59`), con enlace `organismos_transito` el `organismoCodigo` del body pasa a ser **obligatorio y estar en su lista**. Si no, 403 y no se sube nada a storage. La comprobación va antes de `cargarDerechos`.
- **`soloSinEnlace`:** `GET /drive/archivos`, `GET /drive/registro` y `POST /drive/procesar` (integración Drive de FLIT).
- **Nota (preexistente, no se corrige aquí, P9):** `GET /candidatos/:placa` lleva una placa (cuasi-PII, §14) en el path.

### 3.4 Bolsas — `flito-bolsas` → `['compania']`

- **Filtro hoy:** ninguno. `/:companiaId` toma el id del path sin contrastarlo (`routes.ts:79` `companiaIdDe`).
- **Enganche:** `companiaIdDe(req)` pasa a recibir el alcance. Con enlace `compania` y un id distinto del suyo, da **404** en las lecturas (`GET /:companiaId`, `/movimientos`, `/extracto`, `/cierres`) y **403** en las escrituras (`POST /:companiaId/recargas`, `/movimientos-manuales`, `/movimientos/:id/correccion`, `/cierres`). La comprobación va **antes** de `recibirSoporte`/`subirComprobante`, para no dejar un archivo huérfano en storage. Hoy multer corre antes del handler, así que hace falta un middleware de ruta `companiaPropia('leer'|'escribir')` antes de `recibirSoporte`.
- **Agregados, «solo la bolsa de C»:** `GET /consolidado` (`saldoConsolidado`, `service.ts:1291`), `/riesgo` (`bolsasConRiesgo`, `:1071`) y `/alertas` (`alertasDeSaldo`, `:1138`, y `alertasDeConciliacion`, `:1184`) reciben `companiaId?`. Así los totales y conteos solo cuentan su bolsa (AC9).
- **`GET /soportes/:soporteId`:** `storageKeySoporteDeBolsa` (`:1255`) se filtra por compañía. Si el soporte es ajeno, 404.
- **`soloSinEnlace`:** las 6 rutas `/transito*` (bolsas de tránsito por secretaría, que son de FLIT y no de una compañía).

### 3.5 Comprobantes — `flito-comprobantes` → `['compania']`

- **Filtro hoy:** ninguno. `routes.ts:35` arma el ctx con `role`. `listar(f)` (`service.ts:296`) y `detalle(id)` (`:323`) no acotan.
- **Enganche:** `condicionesListado(f, alcance)` (`:192`) añade «comprobante asociado a un trámite o impuesto de C», por la misma asociación que `condicionAsociacion` (`:167`) y el join de `flito-comprobantes.cruce.ts:140` (`flitoTramites.companiaId`). Un comprobante **sin dueño todavía** queda invisible para la compañía. `detalle` y `/:id/archivo` dan 404 si es ajeno. `POST /tramites/buscar` (body) filtra por C.
- **Escrituras** (`POST /`, `/:id/releer`, `/:id/aplicar`, `/:id/descartar`, `/:id/diferencia/aceptar`): la recomendación es `soloSinEnlace` (conciliación interna de FLIT). Ver P-2.

### 3.6 Logística — `flito-logistica` → `['compania']`

- **Filtro hoy:** ninguno por compañía. `routes.ts:26` arma el ctx con `role` y `operaAjenas` (función `logistica.actas.operar_ajenas`, #13425, que se queda como está: es permiso y no enlace).
- **Enganche:** `condicionPorCompania(flitoTramites.companiaId, a)` en el listado y las facetas (`service.ts` ~241-316) y en `actas` / `actas/:id` / `actas/:id/pdf` / `/:id` (404 si es ajeno). `GET /tramites/:tramiteId/viajes` usa `contextoLogisticaDe` (`viajes.service.ts:98`), que ya devuelve `companiaId`: si es ajeno, 404.
- **Escrituras:** `POST /cerrar-lote` compara el `companiaId` del body con el suyo y da 403 si no coincide. `actas/:id/despachar`, `entregar` y `devolucion`, `documentos/:id/novedad` y `reversar`, y `POST|DELETE /tramites/:tramiteId/viajes*` hacen `exigirPropio` sobre el `companiaId` del acta o trámite.
- **`soloSinEnlace`:** `POST /validar-lt` y `POST /escanear`, que buscan por placa o VIN entre **todos** los trámites (`service.ts:105-128`, `:193-204`). Abiertos a una compañía serían un oráculo de trámites de otra. También `GET /mi-ruta` (ruta del mensajero, que es sin enlace por AC1). Ver P-2.

### 3.7 Tablero — `flito-tablero` → `['compania']`

- **Filtro hoy:** ninguno. `resumen()` (`flito-tablero.service.ts:116`) no recibe argumentos, y los bloques cruzan `clients` por `companiaId` (`:44`, `:58`, `:67`, `:95`, `:104`).
- **Enganche:** `resumen(alcance)` aplica `condicionPorCompania` a cada bloque (SOAT, Impuestos, Trámites, ANS). Si el tablero tiene bloques que no son de compañía, deben salir **vacíos u omitidos** para una compañía, no con el total global. El backend lo enumera al leer el archivo completo (101 líneas).

### 3.8 Tránsito legacy — `tramites/transito.routes.ts` y `transito-scope.ts` → `['organismos_transito']`

- **Filtro hoy (por nombre de rol, AC9):**
  - `transito-scope.ts`: `user.role === 'admin'` (todo, más el `?organismo=` opcional) y `user.role !== 'transito'` (403).
  - Para el rol `transito`, **un solo** código: `primerOrganismoPuente`, más el fallback a `users.transitoCodigo`.
  - Consumido en `transito.routes.ts:37, 54, 74, 109, 148, 189, 231`.
- **Enganche:** `resolveTransitoScope(req)` pasa a usar `alcanceDe(req)`.
  - `ninguno`: todo, y se conserva el `?organismo=` (un código de organismo no es PII).
  - `organismos_transito`: **la lista completa** `organismos` (AC6: S1 **y** S2). `TransitoScope.codigo: string | null` pasa a `codigos: string[] | null`, y las 7 consultas de `transito.routes.ts` cambian `eq(…, codigo)` por `inArray(…, codigos)`.
  - Lista vacía: 403 con el mensaje actual «Su cuenta no tiene organismo de tránsito asignado…», que es el comportamiento de hoy para el rol `transito` sin organismo.
  - **El fallback a `users.transitoCodigo` se elimina**, porque `alcanceDe` lee solo `flito_gestor_organismos` (ver P-4).
- **`GET /organismos`** (`:30`): lista estática que se filtra a sus organismos (AC7).
- **Escrituras** `tomar/:id`, `asignar-placa/:id` y `confirmar-placa/:id`: si el trámite es de otro organismo, 403.
- **Montaje** (`app.ts:326-327`): `app.use('/api/transito', conAlcance('transito', transitoRoutes))`. `transitoConfigRoutes` **queda sin envolver** y por tanto cerrado (configuración, AC4). Que el segundo montaje sobre el mismo prefijo quede cerrado lo cubre el caso 3 del centinela de #12875.

## 4. Listas de apoyo (AC7)

Las listas de compañías, secretarías y proveedores viven hoy en `/api/flito/parametrizacion/{companias,organismos,proveedores-soat}` (`flito-parametrizacion.routes.ts:109, 386, 302`). Ese módulo es catálogo, **no** está en `MODULOS_FRONTERA` y queda cerrado a todo enlace (AC4). La web las pide desde `FlitoTramites.tsx:222`, `FlitoSoat.tsx:244` y `users/AtaduraFields.tsx:115`.

**Recomendación:** no abrir parametrización. Cada módulo abierto ya expone su `GET /facetas` (tramites, impuestos, derechos, logística, SOAT), y AC7 se cumple filtrando las facetas por alcance, con la misma condición que el listado. Así la compañía solo ve su compañía y el gestor solo sus secretarías. Para Tránsito se usa `GET /api/transito/organismos` filtrado (§3.8). La llamada de la web a `/parametrizacion/*` con un enlace dará 403, y la página debe tolerarlo (ocultar el filtro). Ese ajuste es **frontend** y queda fuera de esta HU BACKEND (ver P-1).

## 5. Conteos, totales y export

Regla única: **la condición de alcance vive en la función que arma las condiciones**, no en el handler. Así lista, `COUNT`, facetas, export y zip la heredan:

| Módulo | Función que arma condiciones y la heredan |
|---|---|
| Trámites | condiciones del listado → lista + total + `facetas` + `soportes/zip` |
| Impuestos | conds de la cola (`service.ts:256`) → cola + semáforo + facetas + `export` + zips + `certificacion.service.ts:504` |
| Derechos | `:698` → lista + total; `facetasDerechos(alcance)` |
| Bolsas | `bolsasConRiesgo`, `alertas*` y `saldoConsolidado` reciben `companiaId?` |
| Comprobantes | `condicionesListado` → lista + total |
| Logística | condiciones del listado → lista + total + facetas |
| Tablero | `resumen(alcance)` → todos los bloques |
| Tránsito | las 7 consultas de `transito.routes.ts` |

Test por módulo: con un usuario `compania` C, el total o conteo devuelto es igual al número de filas de C y no al global. Para que el mutante «quitar la condición del COUNT» muera, el aserto debe ir sobre el SQL capturado o con base real (no con un mock `chain`, que devuelve la fila entera).

## 6. `PENDIENTES_12871` (AC9)

`apps/api/__tests__/services/permisos.nombres-de-rol.test.ts:71` contiene hoy 3 entradas, tope `TOPE_13425 = 3`:

| Fichero | Veces | Qué es | Sale por |
|---|---|---|---|
| `flito-impuestos/flito-impuestos.routes.ts` | 1 | `:121` `contextoImpuesto` | §3.2 |
| `flito-impuestos/flito-impuestos.service.ts` | 1 | `:59` `esGestor` | §3.2 |
| `flito-impuestos/flito-recibos.service.ts` | 1 | `:324` `esGestor` del lote | §3.2 |

Al cerrar: `PENDIENTES_12871 = []` y `TOPE_13425 = 0` (el ratchet baja).

**Ámbito ampliado:** el test solo recorre `auth`, `users`, `flito-*`, `jornadas`, `pesv` y `drivers`. `transito-scope.ts` vive en `tramites/` y **no se mide**. AC9 lo nombra, así que el test debe añadir ese **fichero concreto** (`tramites/transito-scope.ts`, no la carpeta `tramites/`, que es legacy con reglas propias) y comprobar que tiene 0 comparaciones.

**Tests con fixtures por nombre de rol** (`gestor_impuestos` / `role: 'transito'`): son 17 y deben pasar a enlace (`fijarFuenteDePermisos` con `tipoEnlace: 'organismos_transito'`):

- `flito-impuestos.{cola-fases, certificado.routes, frontera-organismos, workflow, cola-semaforo, certificar.routes, direccion.routes, contingencia, certificados-zip.routes}`
- `flito-impuestos-export`
- `flito-recibos.{carga-por-fase.routes, reemplazo.routes, test, sello}`
- `flito-recibo-caja.routes`
- `transito.routes`
- `transito-config.routes` (este solo debe comprobar que queda cerrado con enlace)

**Test de AC9 «rol renombrado»:** un rol `xyz_renombrado` con enlace `organismos_transito` y organismos `[S1, S2]` ve exactamente lo mismo que el antiguo `gestor_impuestos`, y un `admin` **con** enlace `compania` ve solo C (prueba de que el filtro no mira el nombre).

## 7. Riesgos de fuga

1. **Detalle por id con comprobación posterior** (leer y luego comparar): introduce un oráculo por tiempos o errores. La condición va en el WHERE, y si no hay fila, 404 idéntico al de inexistente.
2. **Escrituras multer** (`bolsas/:companiaId/recargas` y `movimientos-manuales`): el archivo se sube antes de validar. La validación del alcance va **antes** de multer (middleware de ruta).
3. **Búsqueda por placa o VIN** (`logistica/escanear`, `validar-lt`, `derechos/candidatos/:placa`, `comprobantes/tramites/buscar`): toda consulta «por llave natural» lleva la condición de alcance o queda `soloSinEnlace`.
4. **Ctx reenviado entre módulos** (`flito-tramites.service.ts:32-33` hacia SOAT e Impuestos): si el alcance no viaja, Gestión Trámites abre por la puerta de atrás lo que SOAT e Impuestos cierran.
5. **Agregados de Bolsas y Tablero**: el total global filtrado a una compañía es la fuga más fácil de pasar por alto, y el test de AC9 la cubre (§5).
6. **Módulo abierto sin filtrar**: el centinela de #12875 hace un snapshot de `[{prefijo, modulo}]` y de las rutas de cada router abierto. Cada ruta nueva de un router recién abierto obliga a decidir en ese snapshot: filtra o `soloSinEnlace`. **No regenerar el snapshot a ciegas.** Cada línea nueva del snapshot debe tener su fila en §3.
7. **Admin con enlace**: el filtro nunca mira el rol (AC8/AC9). Un admin con enlace `compania` queda acotado, y es correcto.

## 8. Tamaño

Recuento de líneas no vacías y sin comentarios (equivale a `max-lines` con `skipBlankLines` y `skipComments`) sobre 2fdc1d5e:

| Archivo | Líneas | Techo | Margen |
|---|---|---|---|
| `flito-bolsas/flito-bolsas.service.ts` | 830 | **congelado 1120** | 290; no puede subir del techo |
| `flito-logistica/flito-logistica.service.ts` | 668 | congelado 840 | 172 |
| `flito-derechos/flito-derechos.service.ts` | 586 | congelado 820 | 234 |
| `flito-impuestos/flito-recibos.service.ts` | 570 | 800 | 230 |
| `flito-tramites/flito-tramites.service.ts` | 547 | 800 | 253 |
| `flito-impuestos/flito-impuestos.service.ts` | 529 | 800 | 271 |
| `flito-impuestos/flito-impuestos.routes.ts` | 499 | 800 | 301 |
| `flito-bolsas/flito-bolsas.routes.ts` | 389 | 800 | 411 |
| `tramites/transito.routes.ts` | 257 | 800 | 543 |
| `flito-tablero/flito-tablero.service.ts` | 101 | 800 | 699 |

Ningún archivo corre riesgo con este delta (+5 a +30 líneas por archivo), porque el helper `alcance-filas.ts` absorbe la lógica. Antes del PR hay que pasar `npx eslint` sobre cada archivo tocado: es el gate que P1 no ve.

## 9. Archivos a crear o modificar

**Crear**

- `apps/api/src/shared/alcance-filas.ts`
- `apps/api/__tests__/services/alcance-filas.test.ts`
- Un test de alcance por módulo: `flito-tramites.alcance-enlace.test.ts`, `flito-impuestos.alcance-enlace.test.ts`, `flito-derechos.alcance-enlace.test.ts`, `flito-bolsas.alcance-enlace.test.ts`, `flito-comprobantes.alcance-enlace.test.ts`, `flito-logistica.alcance-enlace.test.ts`, `flito-tablero.alcance-enlace.test.ts`, `transito.alcance-enlace.test.ts`, todos en `apps/api/__tests__/services/`

**Modificar**

- `packages/shared-types/src/permisos-roles.ts`: `MODULOS_FRONTERA` + `transito`, y `FRONTERA_POR_ENLACE` (§2). Exige grep en `apps/web` (regla 7: lo usa el panel de #12876).
- `apps/api/src/app.ts:269-288, 326`: `conAlcance` en impuestos, derechos, tramites, tablero, logística (los 2 montajes), bolsas, comprobantes y tránsito (solo `transitoRoutes`).
- `flito-tramites/flito-tramites.{routes,service}.ts`
- `flito-impuestos/flito-impuestos.{routes,service}.ts`, `flito-recibos.service.ts`, `flito-factura-venta.service.ts` (tipo `ImpuestoCtx`), `certificacion.service.ts`, `flito-impuestos.export.service.ts` y los 5 sub-routers (solo si cambia la firma de `contextoImpuesto`)
- `flito-derechos/flito-derechos.{routes,service}.ts`
- `flito-bolsas/flito-bolsas.{routes,service}.ts`
- `flito-comprobantes/flito-comprobantes.{routes,service}.ts`
- `flito-logistica/flito-logistica.{routes,service}.ts`, `flito-logistica-viajes.routes.ts`
- `flito-tablero/flito-tablero.{routes,service}.ts`
- `tramites/transito-scope.ts`, `tramites/transito.routes.ts`
- Tests: `permisos.nombres-de-rol.test.ts` (§6), el centinela de frontera de #12875 (snapshots de montajes y rutas) y los 17 de fixtures por rol (§6)

## 10. Propuesta de corte (la decisión es del hilo)

La HU toca 9 superficies, unos 25 archivos de producción y unos 27 de test. Cabe en un PR, pero es grande para revisar. Si se parte, el corte es **por módulo** y cada PR abre en `FRONTERA_POR_ENLACE` solo lo que filtra (regla de ADR-0024). Mientras tanto, lo no abierto sigue en 403, es decir, falla cerrado y no hay fuga:

| PR | Contenido | AC que cierra | Dependencia |
|---|---|---|---|
| **A** | `alcance-filas.ts` + Impuestos + Derechos + Tránsito legacy | AC6, AC9 (`PENDIENTES_12871` vacío, `transito-scope`), parte de AC7 | — |
| **B** | Gestión Trámites + Tablero + Logística | AC2/AC3/AC4 de esos módulos | A (helper) |
| **C** | Bolsas + Comprobantes | AC2/AC3 de esos módulos | A |

AC1, AC5 y AC8 se prueban en cada PR sobre lo que abre. Cómo partir en ADO es decisión del hilo o del tech-lead, con «sí» del PO: o tres PRs apilados de la misma HU (la convención es una rama por WI, así que implicaría ramas `…-parte-a/b/c` que `check-naming` puede rechazar), o tres HUs hijas del Feature #12871. **Recomendación:** un solo PR si el backend lo entrega en una pasada. Si no, HUs A/B/C por `tech-lead-agent`. En ambos casos, el #12871 **no se promueve a `staging` sin las tres** (condición ya fijada en #12875 §4.5).

## 11. Notas operativas

**Backend**

- Leer completos `flito-impuestos.service.ts:240-280` y `:560-590`, `flito-recibos.service.ts:500-520` y `flito-tablero.service.ts`. Este diseño no los recorrió línea a línea (presupuesto) y pueden contener decisiones de contingencia que no son de filas.
- P1: los `*.alcance-enlace.test.ts` nuevos, más los 17 de fixtures, más `permisos.nombres-de-rol.test.ts` y el centinela de frontera. **No** el glob del directorio.
- `build:api` con `NODE_OPTIONS=--max-old-space-size=8192`, y `npm run build -w packages/shared-types`.

**QA (mutantes sugeridos, tope 3)**

1. Quitar la condición de alcance del `COUNT` de impuestos: debe morir en el test del total.
2. `companiaPropia` de bolsas devuelve `next()` para un id ajeno: debe morir en el test de 403 sin storage.
3. `transito-scope` usa solo `codigos[0]`: debe morir en el test de S1+S2.

**Security:** dispara (auth y frontera, PII por enlace). Modo diff-scoped.

**Frontend:** fuera de esta HU (ver P-1).

## 12. Preguntas para el PO (con recomendación)

- **P-1 (AC7, alcance de la HU):** las pantallas piden las listas a `/parametrizacion/*`, que queda cerrado con enlace. *Recomendación:* servir las listas desde las `facetas` de cada módulo, filtradas, y que una HU o Bug FRONTERA aparte ajuste `FlitoTramites.tsx:222` y `FlitoSoat.tsx:244`. Si el PO quiere que la pantalla ya funcione en esta HU, se convierte en FULLSTACK o se añade una HU de front al Feature.
- **P-2 (escrituras de la compañía):** ¿una compañía **opera** algo en Comprobantes (subir, aplicar, descartar) y en Logística (despachar, entregar, escanear)? *Recomendación:* Comprobantes y el escaneo y validación de Logística, `soloSinEnlace` (operación interna de FLIT; abrirlo crea un oráculo por placa). Las escrituras de Logística sobre sus propias actas, permitidas si su rol tiene la función, con 403 en las ajenas.
- **P-3 (contingencia de Impuestos):** con enlace `organismos_transito`, ¿se permiten `devolver-gestor`, `reactivar` y `reversar`, o son de Operaciones? *Recomendación:* `asumir-operaciones` y `devolver-gestor`, `soloSinEnlace`. `reactivar` y `reversar`, según la función, acotadas a sus organismos.
- **P-4 (Tránsito legacy):** hoy un usuario `transito` sin filas en `flito_gestor_organismos` cae al fallback `users.transitoCodigo`. *Recomendación:* eliminar el fallback (la fuente única del enlace es la puente, HU #12088) y confirmar con una consulta en DEV, QA y PDN que no quedan usuarios con solo la columna. Si quedan, hace falta una migración de datos (con lo que dejaría de ser «sin cambio de esquema», aunque solo sería DML) o mantener el fallback dentro de `alcanceDeUsuario`.
- **P-5 (Tablero):** ¿la compañía ve en el Tablero solo los bloques que tienen compañía (SOAT, Impuestos, Trámites) o también los ANS agregados? *Recomendación:* solo los bloques con filas de su compañía. Los indicadores globales de operación se omiten.
