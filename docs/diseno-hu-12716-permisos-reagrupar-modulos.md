# Diseño slim — HU #12716 · Permisos: reagrupar cada pantalla con las acciones de su módulo

Feature #12072 · rama `HU/12716-davidchica-permisos-reagrupar-pantallas-por-modulo` (base `origin/develop` 117c9fb).
Alcance: **BACKEND** (catálogo, migración, seed, tests) + delta mínimo en `apps/web/src/pages/roles-permisos/modulos.ts`.
Las decisiones de producto (qué va a qué módulo) están cerradas en la HU; aquí solo se fija **cómo** se materializan.

## Patrón reutilizado

- `apps/api/src/modules/permisos/catalogo.ts` — el catálogo se construye desde el código y el seed es su
  SALIDA (`npm run permisos:seed -w apps/api`). Se conserva ese principio: el reagrupamiento es **un
  mapa más del catálogo**, no una edición de SQL a mano ni una tabla nueva.
- `apps/api/src/db/migrations/0182_tarifas_vigencias.sql` + `__tests__/helpers/permisos-seed-sql.ts` —
  la paridad ya «pliega» migraciones posteriores sobre la 0179 (INSERT suma, DELETE resta). Se extiende
  con un tercer verbo: **UPDATE de `modulo` resta-y-suma**.
- `__tests__/db/migracion-0188.test.ts` / `migracion-0193.test.ts` — la forma de test de migración
  DML-only («la anterior es NNNN-1», nunca «es la última»).
- `__tests__/helpers/orden-sql.ts` — cómo se asierta un `orderBy` con el mock (SQL renderizado).

## Contrato delta

- `GET /api/permisos/funciones` → mismo `GrupoDeFunciones[]` (`{ modulo, funciones[] }`). Cambian:
  - las **claves** `modulo` de 46 funciones (lista en §4); desaparecen los grupos
    `flito_soat_e_impuestos`, `parametrizacion` y `sync`; nacen `clientes`, `tarifas`,
    `servicios_adicionales` y `catalogos_compartidos`;
  - el **orden** dentro de cada grupo: primero `tipo = 'pagina'`, luego `'operacion'`; por `codigo`
    dentro de cada tipo. Los grupos siguen por `modulo` ascendente.
- `PUT /permisos/roles/:codigo/funciones`, códigos de función, reparto rol×función: **sin cambio**.
- 403 de `exigirFuncion` (`motivo: sin_modulo`): el texto «No tiene acceso a este módulo («<modulo>»)»
  pasa a nombrar el módulo de agrupación (p. ej. `catalogos_compartidos` en vez de `parametrizacion`).
  No cambia el discriminador ni la forma del cuerpo.
- `packages/shared-types`: **sin cambio** (`PAGE_GROUPS` no se toca; ver §5-R4).

## 1. Delta por archivo

### Backend (`apps/api`)

| Archivo | Qué cambia |
|---|---|
| `src/modules/permisos/catalogo-agrupacion.ts` **(nuevo)** | Los dos mapas (§2) + `moduloAgrupado(codigo, moduloEstructural)` + `reagrupaciones()` (pares `[codigo, modulo]` ordenados por código; única fuente para generador, migración y tests). |
| `src/modules/permisos/catalogo.ts` | `catalogoDePaginas()`: `modulo: moduloAgrupado(codigo, moduloDeGrupo(label))`. `catalogoDeOperaciones()`: la comprobación `decl.codigo.startsWith(g.modulo + '.')` se **conserva tal cual** (estructural, contra `g.modulo` del fichero) y **después** se asigna `modulo: moduloAgrupado(decl.codigo, g.modulo)`. `catalogoCompleto()`: nueva comprobación → toda clave de los mapas debe existir en el catálogo; si no, `CatalogoIncoherenteError('Agrupación declarada para un código que no existe: …')`. Cabecera: dos líneas explicando que `modulo` es el de AGRUPACIÓN (pantalla de permisos, bitácora del 403) y que el prefijo del código sigue siendo el módulo del fichero. |
| `src/modules/permisos/permisos.service.ts` | `catalogoAgrupado()`: `.orderBy(asc(modulo), desc(tipo), asc(codigo))` con comentario: `'pagina' > 'operacion'` alfabéticamente y el CHECK `permisos_funciones_tipo_chk` solo admite esos dos valores, así que `desc(tipo)` pone las páginas primero sin CASE. `verificarCatalogoAlArrancar()`: el `select` trae también `modulo`; tras la comparación de códigos, compara `modulo` fila a fila y lanza `ArranquePermisosError` con la lista `«<codigo>»: base «<modulo_base>» → código «<modulo_codigo>»` (n primeras + «… y N más» si > 10) y remite a `0205_permisos_reagrupar_modulos.sql` / `npm run permisos:seed -w apps/api -- --reagrupar`. |
| `src/shared/middleware/exigir-funcion.ts` | **Sin código nuevo.** Solo se corrige el comentario de cabecera («para las operaciones coincide con el primer segmento del código» → «es el módulo de agrupación del catálogo; para las operaciones coincide con el prefijo del código salvo las reagrupadas en `catalogo-agrupacion.ts`»). Ya lee `catalogoCompleto()`, así que la bitácora de intentos denegados y el `sin_modulo` siguen la nueva agrupación sin tocarlo. |
| `src/scripts/generar-seed-permisos.ts` | Modo nuevo `--reagrupar`: emite por stdout el bloque `UPDATE … FROM (VALUES …)` (forma canónica en §3) con `reagrupaciones()`, precedido de `-- N funciones cambian de módulo. Generado: no editar a mano.` Sin flag, sigue emitiendo el seed completo (que ya sale con los módulos nuevos). |
| `src/db/migrations/0205_permisos_reagrupar_modulos.sql` **(nuevo)** | Cabecera convención 5 del README (archivo, motivo con Feature #12072 / HU #12716, autor) + el bloque generado por `--reagrupar` pegado entre marcas `-- REAGRUPACIÓN GENERADA (inicio|fin)`. Solo DML; sin control de transacción. La **0179 no se toca**. |

### Tests (`apps/api/__tests__`)

| Archivo | Qué cambia |
|---|---|
| `helpers/permisos-seed-sql.ts` | `MIGRACIONES_CON_REPARTO` += `'0205_permisos_reagrupar_modulos.sql'` (comentario: «siembran, retiran o reagrupan»). Nueva `bloquesUpdateModulo(sql)` que reconoce SOLO la forma canónica de §3 y reutiliza `tuplas()`. `funcionesDeSql()` la pliega: `funciones.get(codigo).modulo = modulo` (si el código no existe aún, lanza: un UPDATE sobre una función no sembrada es un error de orden). Nueva `leerReagrupacionesSembradas(archivos)` → `Map<codigo, modulo>` de los UPDATE (contraparte de `leerRetirosSembrados`). |
| `services/permisos-catalogo.test.ts` | (a) «el de las operaciones prefija su código» → pasa a: prefija su código **o** está en `AGRUPACION_DE_OPERACION` con ese módulo, y el prefijo sigue siendo un módulo de `FICHEROS_EN_ALCANCE`. (b) Bloque «se agrupa por su grupo de PAGE_GROUPS» → «se agrupa con las acciones de su módulo»: `pagina.transito → transito`, `pagina.drive → derechos`, `pagina.clients → clientes`, `pagina.dashboard → general` (sin acciones: conserva el grupo), `pagina.transito_organismos → transito`. (c) Nuevos: el catálogo no contiene `flito_soat_e_impuestos`, `parametrizacion` ni `sync` como módulo; cada uno de los 46 códigos de §4 lleva el módulo esperado (tabla literal en el test, es la afirmación de la HU); `reagrupaciones()` tiene exactamente 47 pares y, de ellos, 46 cambian el valor respecto a `moduloDeGrupo(label)` / `g.modulo` (el par de `transito_organismos` es no-op); una clave de mapa inexistente revienta con `CatalogoIncoherenteError`. |
| `db/migracion-0179.test.ts` | En el caso «el seed pegado … es lo que el generador produce HOY»: el bucle «cada fila de la 0179 SOLA sigue en lo generado» compara `{ ...f, modulo: reagrupadas.get(codigo) ?? f.modulo }` (con `leerReagrupacionesSembradas()`), y se asierta `reagrupadas.size === 47` (47 tuplas en la 0205; el bucle solo reemplaza el módulo en las 46 que difieren, la de `transito_organismos` deja el valor igual). El resto no cambia: al plegar la 0205, `leerFuncionesSembradas()` ya coincide campo a campo con lo generado. |
| `db/migracion-0205.test.ts` **(nuevo)** | Estática (siempre): cabecera; `scanForTxControl` vacío; «la anterior es `0204_`» (NO «es la última»); solo DML (sin `CREATE/ALTER/DROP/INSERT/DELETE`); las tuplas del archivo == `reagrupaciones()` (conjunto y valores); las tuplas == salida de `npx tsx src/scripts/generar-seed-permisos.ts --reagrupar` (mismo `execFileSync` que la 0179). Contra PostgreSQL (`skipIf(!TEST_DATABASE_URL)`): huella md5 de `permisos_funciones` antes/después de aplicar el SQL por segunda vez (P6) y `SELECT codigo, modulo` de los 47 códigos del mapa == mapa. |
| `services/permisos-arranque.test.ts` | Caso nuevo: base con los códigos correctos pero `pagina.flito_soat` en `flito_soat_e_impuestos` → `ArranquePermisosError` cuyo mensaje contiene `pagina.flito_soat`, `flito_soat_e_impuestos → soat` y `0205`. Mutante nombrado: quitar la comparación de `modulo` → el test cae. |
| `services/permisos.routes.test.ts` (o el que cubra `GET /funciones`) | Orden: con `helpers/orden-sql.ts`, el `orderBy` renderizado es `"modulo" asc, "tipo" desc, "codigo" asc`. Además, con filas del mock en orden mezclado, cada grupo sale con las `pagina` delante (el mock ignora `orderBy`, así que este segundo aserto solo vale si `catalogoAgrupado()` **no** reordena en memoria — no debe: el orden lo pone el SQL; el aserto de memoria se omite y queda el del SQL renderizado). |
| `services/permisos-exigir-funcion.test.ts` | Revisar si algún caso `sin_modulo`/`sin_funcion` usa un código reagrupado (`parametrizacion.*`, `sync.*`, `finanzas.servicios_adicionales.*`, `pagina.flito_*`) con el módulo viejo en el aserto; si sí, actualizar el módulo esperado. Sin código nuevo. |

### Web (`apps/web`, delta mínimo)

| Archivo | Qué cambia |
|---|---|
| `src/pages/roles-permisos/modulos.ts` | `ETIQUETAS_MODULO`: quitar `flito_soat_e_impuestos`, `parametrizacion`, `sync`; añadir `clientes: 'Clientes'`, `tarifas: 'Tarifas'`, `servicios_adicionales: 'Servicios adicionales'`, `catalogos_compartidos: 'Catálogos compartidos'`. `SECCION_DE_MODULO`: quitar las tres claves muertas; añadir las cuatro nuevas en `'flito'` (explícito aunque sea el default). `REUBICACIONES`: queda solo `'pagina.privacy': 'privacidad'` (transito y drive ya llegan agrupados del API). Comentario de cabecera: el API ya agrupa pantalla+acciones por módulo (HU #12716). |
| `src/lib/api.ts` | Sin cambio (`GrupoDeFunciones` igual). |

## 2. Forma de los mapas

`apps/api/src/modules/permisos/catalogo-agrupacion.ts`:

```ts
// HU #12716 — El módulo con el que se AGRUPA cada función en la pantalla de permisos (y en la bitácora
// del 403). No cambia códigos ni reparto: solo la columna `modulo`. El prefijo del código sigue siendo
// el módulo del FICHERO (lo comprueba catalogoDeOperaciones); esto se aplica después.
import type { PageSlug } from '@operaciones/shared-types';

/** Página → módulo de sus acciones. Una página sin acciones NO va aquí: conserva su grupo. */
export const AGRUPACION_DE_PAGINA: Readonly<Partial<Record<PageSlug, string>>> = {
  flito_tramites: 'tramites', flito_soat: 'soat', flito_impuestos: 'impuestos',
  flito_derechos: 'derechos', drive: 'derechos', flito_revisiones: 'revisiones',
  flito_compuerta: 'compuerta', flito_tablero: 'tablero', flito_bitacora: 'bitacora',
  flito_logistica: 'logistica', flito_logistica_ruta: 'logistica', flito_bolsas: 'bolsas',
  flito_comparendos: 'comparendos', flito_conciliacion: 'conciliacion',
  flito_comprobantes: 'comprobantes', finanzas_reporte_costos: 'liquidacion',
  users: 'usuarios', roles_permisos: 'permisos', tramite: 'tramite',
  transito: 'transito', transito_organismos: 'transito',
  clients: 'clientes', flito_tarifas: 'tarifas',
  flito_servicios_adicionales: 'servicios_adicionales',
};

/** Código de operación (exacto, no prefijo) → módulo de agrupación. */
export const AGRUPACION_DE_OPERACION: Readonly<Record<string, string>> = {
  'sync.sync.lanzar': 'tramites', 'sync.sync.ver_estado': 'tramites',
  'parametrizacion.companias.editar': 'clientes',
  'parametrizacion.proveedores.crear': 'clientes', 'parametrizacion.proveedores.editar': 'clientes',
  'parametrizacion.tarifas.crear': 'tarifas', /* …editar, historial, listar, ver_por_cliente */
  'parametrizacion.servicios_adicionales.crear': 'servicios_adicionales', /* …dar_de_baja, editar, listar */
  'finanzas.servicios_adicionales.asignar': 'servicios_adicionales', /* …quitar, ver */
  'parametrizacion.organismos.editar': 'transito', /* …fijar_modalidad, ver_vigencias */
  'parametrizacion.companias.listar': 'catalogos_compartidos',
  'parametrizacion.proveedores.listar': 'catalogos_compartidos',
  'parametrizacion.organismos.listar': 'catalogos_compartidos',
};

export function moduloAgrupado(codigo: string, moduloEstructural: string): string;
/** Los pares [codigo, modulo] de los dos mapas, ordenados por código: lo que la 0205 escribe. */
export function reagrupaciones(): readonly [string, string][];
```

Decisiones de forma:
- **Códigos exactos, no prefijos** en operaciones: 23 entradas caben, y una entrada que apunte a un
  código inexistente revienta en `catalogoCompleto()` (entrada muerta = error, igual que «función
  declarada sin guarda viva»). Un prefijo (`parametrizacion.tarifas.`) absorbería en silencio una
  operación futura sin que nadie decidiera su módulo.
- `transito_organismos: 'transito'` va en el mapa aunque hoy ya cae en `transito` por `PAGE_GROUPS`:
  el mapa declara la intención completa del PO y no depende de cómo esté `PAGE_GROUPS` mañana.
  `reagrupaciones()` devuelve **todos** los pares del mapa (47), en orden de código, y el
  `UPDATE … WHERE f.modulo IS DISTINCT FROM v.modulo` es no-op sobre ese. Los tests distinguen las dos
  cuentas: **47 pares** en el mapa y **46 filas que cambian de valor** (calculadas comparando el
  catálogo con y sin mapa, es decir, contra `moduloDeGrupo(label)` / `g.modulo`).
- Los mapas viven en un archivo propio (no en `catalogo-operaciones.ts`) porque mezclan páginas y
  operaciones y porque el generador, la migración y los tests los importan sin arrastrar el snapshot.
- Ningún módulo nuevo se declara en `USER_ROLES`, `PAGE_GROUPS` ni `shared-types`: `clientes`,
  `tarifas`, `servicios_adicionales`, `catalogos_compartidos` son claves de agrupación, cadenas de
  `varchar(40)` (la más larga, `catalogos_compartidos`, mide 21).

## 3. Mecanismo de seed / paridad elegido

**Opción (a) refinada: el generador emite el overlay desde el mismo catálogo; la paridad pliega 0179…0205.**

Justificación (3 líneas):
1. Una sola fuente: `catalogoCompleto()` ya sale con los módulos nuevos, así que el seed «completo»
   sigue siendo byte-estable y la paridad (`leerFuncionesSembradas()` vs generado) cuadra en cuanto el
   helper pliega el UPDATE de la 0205, sin excepciones por código.
2. No se toca la 0179 ni se cambia su lector; el overlay es un tercer verbo (UPDATE) del mismo plegado
   que ya hace INSERT/DELETE, y el «cada fila de la 0179 sola sigue en lo generado» conserva su fuerza
   comparando nombre/descripcion/tipo y el módulo **con nombre de migración** que lo cambió.
3. La migración no se teclea: `--reagrupar` emite 47 tuplas ordenadas; si alguien edita el mapa y no
   la migración (o al revés), la paridad estática (CI) se pone roja antes de que el arranque lo haga.

Comando y archivo:

```bash
cd apps/api && npx tsx src/scripts/generar-seed-permisos.ts --reagrupar \
  > /tmp/…/reagrupacion.sql        # se pega en src/db/migrations/0205_permisos_reagrupar_modulos.sql
npm run permisos:seed -w apps/api  # sin flag: seed completo, para diff contra 0179+…+0205 (paridad)
```

Forma canónica del bloque (la única que el helper reconoce; el test de la 0205 la fija):

```sql
UPDATE permisos_funciones AS f
   SET modulo = v.modulo
  FROM (VALUES
    ('finanzas.servicios_adicionales.asignar', 'servicios_adicionales'),
    …
    ('sync.sync.ver_estado', 'tramites')
  ) AS v(codigo, modulo)
 WHERE f.codigo = v.codigo
   AND f.modulo IS DISTINCT FROM v.modulo;
```

Idempotencia (P6): segunda pasada afecta 0 filas; huella md5 idéntica. Sin `session_invalidated_at`
ni bump de token: los permisos ya no viajan en el JWT (HU #12082) y `modulo` no interviene en la
decisión de acceso, solo en la agrupación y en el texto del 403.

Aplicación en local antes del PR: `set -a; source apps/api/.env; set +a` y aplicar **solo** la 0205
dos veces con `docker exec -i flito-postgres psql …` (avisar de que se tocó la BD local). Luego
`TEST_DATABASE_URL=… npm test -w apps/api -- __tests__/db/migracion-0205.test.ts __tests__/db/migracion-0179.test.ts`.

## 4. Códigos cuyo `modulo` cambia — 46 (23 páginas + 23 operaciones)

Formato `codigo: antes → después`. Verificado contra la salida real de `generar-seed-permisos.ts` en 117c9fb (310 funciones).

Páginas (23):
```
pagina.flito_tramites:            flito_soat_e_impuestos → tramites
pagina.flito_soat:                flito_soat_e_impuestos → soat
pagina.flito_impuestos:           flito_soat_e_impuestos → impuestos
pagina.flito_derechos:            flito_soat_e_impuestos → derechos
pagina.drive:                     operaciones            → derechos
pagina.flito_revisiones:          flito_soat_e_impuestos → revisiones
pagina.flito_compuerta:           flito_soat_e_impuestos → compuerta
pagina.flito_tablero:             flito_soat_e_impuestos → tablero
pagina.flito_bitacora:            flito_soat_e_impuestos → bitacora
pagina.flito_logistica:           flito_soat_e_impuestos → logistica
pagina.flito_logistica_ruta:      flito_soat_e_impuestos → logistica
pagina.flito_bolsas:              flito_soat_e_impuestos → bolsas
pagina.flito_comparendos:         flito_soat_e_impuestos → comparendos
pagina.flito_conciliacion:        flito_soat_e_impuestos → conciliacion
pagina.flito_comprobantes:        finanzas               → comprobantes
pagina.finanzas_reporte_costos:   finanzas               → liquidacion
pagina.users:                     administracion         → usuarios
pagina.roles_permisos:            administracion         → permisos
pagina.tramite:                   operaciones            → tramite
pagina.transito:                  operaciones            → transito
pagina.clients:                   flito_soat_e_impuestos → clientes
pagina.flito_tarifas:             finanzas               → tarifas
pagina.flito_servicios_adicionales: finanzas             → servicios_adicionales
```
`pagina.transito_organismos` ya está en `transito`: en el mapa, **no** cambia (por eso 47 pares / 46 cambios).

Operaciones (23):
```
sync.sync.lanzar, sync.sync.ver_estado                                  sync → tramites            (2)
parametrizacion.companias.editar                                        parametrizacion → clientes (1)
parametrizacion.proveedores.crear, .editar                              parametrizacion → clientes (2)
parametrizacion.tarifas.crear, .editar, .historial, .listar, .ver_por_cliente
                                                                        parametrizacion → tarifas  (5)
parametrizacion.servicios_adicionales.crear, .dar_de_baja, .editar, .listar
                                                                        parametrizacion → servicios_adicionales (4)
finanzas.servicios_adicionales.asignar, .quitar, .ver                   finanzas → servicios_adicionales (3)
parametrizacion.organismos.editar, .fijar_modalidad, .ver_vigencias     parametrizacion → transito (3)
parametrizacion.companias.listar, parametrizacion.proveedores.listar, parametrizacion.organismos.listar
                                                                        parametrizacion → catalogos_compartidos (3)
```

Módulos resultantes (31): `administracion` (privacy, siigo_credenciales), `bitacora`, `bolsas`,
`catalogos_compartidos` (3 op., sin pantalla), `clientes`, `comparendos`, `comprobantes`, `compuerta`,
`conciliacion`, `cumplimiento_laft`, `derechos`, `finanzas` (finanzas_gastos_diarios, siigo_operacion,
siigo_parametrizacion), `flota`, `general`, `impuestos`, `liquidacion`, `logistica`, `mantenimiento`,
`operaciones` (soat, tax_reader, vehicles), `permisos`, `pesv`, `revisiones`, `rndc`,
`servicios_adicionales`, `soat`, `tablero`, `tarifas`, `tramite`, `tramites`, `transito`, `usuarios`.
Desaparecen: `flito_soat_e_impuestos`, `parametrizacion`, `sync`.

## 5. Riesgos

- **R1 — Test que exija «es la última».** `migracion-0205.test.ts` afirma «la anterior es `0204_`» y
  nunca el tip (precedente 0188/0193). Antes del PR: `grep -rn "0205\|sqls.length - 1" apps/api/__tests__`
  para comprobar que ningún test ajeno congela la 0204 como última.
- **R2 — Deriva 0179 vs 0205.** El helper solo reconoce la forma canónica de §3; un `UPDATE` escrito
  de otra manera (sin alias `v(codigo, modulo)`, con `SET modulo = CASE …`) no se plegaría y la paridad
  saldría **verde falso** en el bucle de la 0179 y **rojo** en `leerFuncionesSembradas` vs generado.
  Mitigación: el test de la 0205 compara sus tuplas contra `reagrupaciones()`, y QA muta una tupla del
  SQL (p. ej. `'soat'` → `'soatx'`) para ver caer los dos asertos.
- **R3 — Arranque en DEV/QA sin aplicar la 0205.** La comparación de `modulo` nueva tumba el API al
  arrancar si la base sigue con los módulos viejos. Es lo deseado (AGENTS.md §6 «la app queda esperando
  un esquema que nadie creó» se convierte en un mensaje con nombre de archivo). El CD de DEV aplica
  migraciones; staging/producción las aplican a mano tras el deploy — declararlo en el PR.
- **R4 — `PAGE_GROUPS` con otros consumidores.** No se toca: `NoAccess`, `navItems.ts` y el catálogo
  de fichas siguen leyéndolo. La agrupación vive **solo** en el catálogo del API (`modulo`), así que el
  menú y la pantalla de «sin acceso» no cambian. El bloque del test «`PAGE_GROUPS` trae 49 entradas
  para 48 slugs» sigue verde.
- **R5 — Consumidores del módulo viejo fuera de `modulos.ts`.** Antes del PR: `grep -rn
  "flito_soat_e_impuestos\|SOAT e Impuestos" apps/web/src apps/web/e2e apps/api/src docs/ux` — la
  ficha de ayuda de roles-permisos (`apps/web/src/content/ayuda/`) y algún spec E2E pueden citar la
  etiqueta. La ficha es gate `flit-ayuda-flito` (delta o N/A declarado); el spec se ajusta en esta HU
  si asierta la etiqueta.
- **R6 — 403 `sin_modulo` con clave nueva.** Un usuario con funciones de `parametrizacion` que pida
  `parametrizacion.companias.listar` recibirá «No tiene acceso a este módulo («catalogos_compartidos»)»
  en vez de `sin_funcion`. Es consecuencia directa de la decisión del PO; el texto ya mostraba la clave
  cruda antes (`parametrizacion`). Nota en el PR, no bloqueante.
- **R7 — `catalogoAgrupado()` que reordene en memoria.** Si el backend-agent «ayuda» con un `sort` en
  JS, el aserto del SQL renderizado seguiría verde y el orden real dependería de dos sitios. El orden
  lo pone el `orderBy`; nada más.

## ADR: no aplica

Extensión de patrón (mapa aplicado sobre el catálogo existente, mismo mecanismo de seed/paridad,
migración DML como la 0182/0188). No hay tabla, contrato ni dependencia nuevos.

## Notas operativas

**backend-agent**
- Orden sugerido: `catalogo-agrupacion.ts` → `catalogo.ts` → `--reagrupar` en el generador → generar y
  pegar la 0205 → helper de paridad → tests (0179, 0205, catálogo, arranque, orden) → `service.ts`
  (orderBy + arranque) → `modulos.ts` web → comentario de `exigir-funcion.ts`.
- P1: `npm test -w apps/api -- __tests__/services/permisos-catalogo.test.ts __tests__/services/permisos-arranque.test.ts __tests__/services/permisos.routes.test.ts __tests__/services/permisos-exigir-funcion.test.ts __tests__/db/migracion-0179.test.ts __tests__/db/migracion-0205.test.ts` (los `db/` con `TEST_DATABASE_URL` apuntando al 5434; sin ella se saltan y se declara).
- `NODE_OPTIONS=--max-old-space-size=8192 npm run build:api` (se tocan tipos exportados) y
  `npm run typecheck -w apps/web` por `modulos.ts`.
- `npx eslint apps/api/src/modules/permisos/catalogo.ts` — el archivo crece poco, pero leer el número.

**db-review-agent**
- Solo DML sobre `permisos_funciones.modulo` (varchar 40); sin índice ni FK implicados; idempotente por
  `IS DISTINCT FROM`. Verificar las 46 filas de §4 contra el `VALUES` de la 0205 y que `transito_organismos`
  sea no-op.

**frontend-agent** (si el hilo separa el delta web): solo `modulos.ts`; nada de `PAGE_GROUPS`;
`REUBICACIONES` queda con `pagina.privacy` únicamente.

**qa-agent (B)**: mutantes candidatos — (1) quitar la comparación de `modulo` en
`verificarCatalogoAlArrancar` → cae `permisos-arranque`; (2) cambiar una tupla de la 0205 → cae
`migracion-0205` estático y el plegado de la 0179; (3) `desc(tipo)` → `asc(tipo)` → cae el aserto del
SQL renderizado.

---

```
HANDOFF
  Modo: slim
  Resultado: OK
  Decisión recomendada: mapa de agrupación aplicado sobre el catálogo (catalogo-agrupacion.ts) +
    migración 0205 generada por `generar-seed-permisos.ts --reagrupar` + paridad que pliega el UPDATE
    (helpers/permisos-seed-sql.ts); orderBy(asc modulo, desc tipo, asc codigo); arranque compara modulo.
  ADR: no aplica
  Archivos:
    nuevos: apps/api/src/modules/permisos/catalogo-agrupacion.ts ·
            apps/api/src/db/migrations/0205_permisos_reagrupar_modulos.sql ·
            apps/api/__tests__/db/migracion-0205.test.ts
    modificados: apps/api/src/modules/permisos/catalogo.ts · apps/api/src/modules/permisos/permisos.service.ts ·
            apps/api/src/scripts/generar-seed-permisos.ts · apps/api/src/shared/middleware/exigir-funcion.ts (comentario) ·
            apps/api/__tests__/helpers/permisos-seed-sql.ts · apps/api/__tests__/services/permisos-catalogo.test.ts ·
            apps/api/__tests__/db/migracion-0179.test.ts · apps/api/__tests__/services/permisos-arranque.test.ts ·
            apps/api/__tests__/services/permisos.routes.test.ts · (revisar) apps/api/__tests__/services/permisos-exigir-funcion.test.ts ·
            apps/web/src/pages/roles-permisos/modulos.ts
  Siguiente: backend-agent
  Pendiente humano: ninguno de producto. Operativo: aplicar la 0205 a mano en staging/producción tras
    el deploy (el arranque la exige); confirmar en el PR el gate flit-ayuda-flito (ficha de roles-permisos
    cita o no «FLITO (SOAT e Impuestos)»).
```
