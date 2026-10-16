# ADR-0024 — Frontera por enlace declarada en el montaje (sustituye el canal interno/externo)

- **Estado:** Propuesto (lo aprueba el Líder Técnico humano; ningún agente lo marca Aceptado)
- **Fecha:** 2026-10-09
- **Feature:** #12871 (F2 de la Épica #13411) · **HU:** #12875 (BACKEND) · consume el contrato: #12876 (FRONTEND)
- **Deja enganche para:** HU #13426 (filtrado de datos por enlace dentro de cada módulo)
- **Relación:**
  - Sustituye la decisión de diseño de `apps/api/src/shared/middleware/canal-cliente.ts` (Feature #11912,
    HU #11913/#12082/#12084): la lista blanca por ruta del principal **externo**. No hay ADR previo
    aceptado que la fije, así que no aplica `Supersedes` formal.
  - **Modifica ADR-0022 (Propuesto)** en un punto: la «población administradora» del seguro
    anti-bloqueo deja de ser `tipo_principal = 'interno'` y pasa a ser `tipo_enlace = 'ninguno'`.
    Todo lo demás de ADR-0022 sigue igual.
  - Convive con ADR-0016 (`exigirFuncion` a nivel de ruta) y ADR-0023: la frontera es una capa
    **anterior** al permiso. Las dos se suman y ninguna sustituye a la otra.
- **Módulos afectados:** `flito-*` (SOAT en esta HU) + motor `permisos` + `auth` + `users` (transversales).
  No toca la lógica de los módulos legacy: quedan **cerrados** para usuarios con enlace porque no se
  declaran.

## Contexto

Hoy dos atributos del rol deciden qué alcanza un usuario:

| Atributo | Qué decide hoy | Dónde |
|---|---|---|
| `permisos_roles.tipo_principal` (`interno`/`externo`) | **Qué rutas** alcanza: un externo solo las 17 de `RUTAS_PERMITIDAS_CLIENTE`; un interno, todas. También: la proyección de campos de SOAT, el indicador del canal de radicación, la contraseña ajena y la población del anti-bloqueo | `canal-cliente.ts`, `flito-soat.service.ts`, `soportes-consulta.ts`, `auth.routes.ts`, `users.routes.ts`, `permisos-anti-bloqueo.ts` |
| `permisos_roles.tipo_enlace` (`ninguno`/`compania`/`proveedor_soat`/`organismos_transito`) | **Qué filas** ve en SOAT (Bug #12869) y qué ámbito exige al crear el usuario (triggers 0178/0189) | `permisos-efectivos.ts`, `flito-soat.service.ts`, `users.routes.ts` |

Las decisiones del PO, cerradas, eliminan el primero: **un solo enlace por rol** decide el alcance;
interno/externo desaparece del panel y de los datos; los permisos dominan sobre los roles; ningún
nombre de rol en el código. Además, la frontera tiene que estar **cerrada por defecto**: un usuario con
enlace que pida algo que nadie declaró recibe 403, también para las rutas que se escriban en el futuro
(AC3).

La restricción técnica que decide el diseño ya la documentó `canal-cliente.ts`: la autenticación **no
está en `app.ts`**. 115 de 121 routers montan `authMiddleware` por su cuenta, así que la frontera solo
puede correr al final de `authMiddleware`, **antes del enrutado del router**. En ese punto no hay forma
de saber qué opciones le pasó la ruta a `exigirFuncion`: ese middleware todavía no ha corrido.

## Decisión

1. **El enlace es la única frontera.** `ninguno` → la frontera no interviene (decide el permiso,
   AC4). `compania` / `proveedor` / `organismos_transito` → solo alcanzan los **módulos declarados**
   abiertos a ese enlace más una lista corta de **rutas transversales** (sesión, permisos propios,
   cerrar sesión, contraseña propia). Todo lo demás → 403. Un enlace desconocido o un resolutor que
   no decide (`ok:false`) → solo las transversales (fallo cerrado, igual que hoy).
2. **La declaración vive en el montaje**, en `app.ts`:
   `app.use('/api/flito/soat', conAlcance('soat', flitoSoatRoutes))`. `conAlcance` marca la petición
   con el módulo mientras recorre ese router y **restaura el valor previo si el router la deja pasar**
   (para que dos montajes sobre el mismo prefijo no se hereden la marca). La guarda, al final de
   `authMiddleware`, consulta esa marca. Un montaje sin `conAlcance` no marca nada → cerrado. Así
   nace cerrado todo router futuro, sin que nadie tenga que acordarse.
3. **Qué enlace abre qué módulo** es UNA tabla de código, congelada, en `packages/shared-types`
   (`FRONTERA_POR_ENLACE`), la importa el API (que decide) y la lee el panel (que la explica). En
   #12875 solo `soat` está abierto (a `compania` y `proveedor`), porque es el único módulo que **ya
   filtra filas por enlace** (Bug #12869). Los demás módulos de compañía/organismos quedan con lista
   vacía y la anotación de la HU que los abre (#13426): abrirlos antes sería una fuga.
4. **Punto de enganche para #13426:** la guarda deja en `req.frontera = { enlace, modulo }` y expone
   `alcanceDe(req)` (resuelve con memo por petición el id de compañía / proveedor / organismos, leído
   de la base en cada petición como hoy hace `contextoSoat`, §9.3). #13426 abre un módulo añadiendo
   el enlace a la tabla **en el mismo PR** que hace que su servicio filtre con `alcanceDe(req)`.
5. **`tipo_principal` se retira en dos tiempos (expand/contract).** #12875 deja de leerlo y escribirlo
   en todo el código, lo quita del contrato API (AC6) y lo marca retirado en la base; la columna se
   borra en una migración posterior, **cuando la versión sin lectores esté en PDN**. Motivo: un
   rollback de la imagen con la columna ya borrada deja el resolutor del código viejo fallando →
   `ok:false` → 403 para **todos** los usuarios. Ver «Pendiente».
6. **`proveedor_soat` → `proveedor`** en `tipo_enlace` por migración idempotente que no nombra roles
   (lección de la 0227: un literal de rol rompió el CD por la FK a `permisos_roles`).
7. **Lo que decidía `tipo_principal` y no era la frontera** pasa al enlace:
   - proyección de campos del canal Cliente en SOAT → `alcance === 'compania'` (ya lo hace a medias
     `flito-soat.routes.ts:535`);
   - indicador «puede radicar por el canal» (`puedeSolicitarSoat`) → función `soat.solicitud.crear` +
     enlace `compania` + flag de la compañía;
   - contraseña ajena vedada → enlace ≠ `ninguno` (o resolutor `ok:false`);
   - población administradora del anti-bloqueo (ADR-0022) → `tipo_enlace = 'ninguno'` (un enlace no
     alcanza configuración por esta misma frontera, así que no puede administrar).

## Alternativas consideradas

| | A. Lista central por ruta (evolución literal de `canal-cliente.ts`) | B. `exigirFuncion(codigo, { enlaces })` + tabla derivada del stack de Express al arrancar | **C. Declaración en el montaje (`conAlcance`) + tabla por módulo + transversales (elegida)** |
|---|---|---|---|
| Cierre por defecto (AC3) | Sí, por construcción (lo no listado → 403 antes del enrutado) | Sí si la derivación es correcta; un fallo de derivación cierra todo (outage, no fuga) | Sí, por construcción (montaje sin marca → 403) |
| Dónde se lee la declaración | Lejos de la ruta (patrón duplicado) | Junto a la ruta | En `app.ts`, junto al montaje; la tabla, en un archivo de ~20 líneas |
| Tamaño | 25 entradas en esta HU; ~200 tras #13426 | Toca cada ruta abierta (~25 hoy, cientos tras #13426) + derivador ~100 líneas | 4 montajes + tabla; #13426 suma ~10 montajes |
| Dependencias frágiles | Ninguna | Internals de Express 4 (`app._router.stack`, `Layer.match`); rompe en Express 5 | Ninguna en runtime (los internals solo en el test centinela) |
| Granularidad | Por ruta | Por ruta | **Por router.** Una ruta de configuración dentro de un router abierto quedaría abierta → mitigado con `soloSinEnlace()` por ruta y snapshot de rutas del módulo abierto en el centinela |
| Riesgos | Deriva entre la lista y los routers; fricción alta en #13426 | Rutas sin `exigirFuncion` (legacy, `requirePage`) necesitan otra marca; complejidad del derivador | Marca heredada entre dos montajes del mismo prefijo → mitigado restaurando en el `next` del envoltorio + test |
| Esfuerzo | S | L | **M** |

Se elige C porque la decisión de producto **es por módulo** («compañía ve SOAT, Impuestos, Bolsas…»),
porque un router nuevo nace cerrado sin depender de internals de Express y porque deja a #13426 con un
cambio de una línea por módulo en lugar de cientos de patrones.

## Consecuencias

- `canal-cliente.ts` (335 líneas) desaparece; lo sustituye `shared/middleware/frontera-enlace.ts`.
- Un rol hoy `externo` **sin** enlace pasa a verlo todo (AC4). El reporte en seco (AC9) los marca como
  BLOQUEANTE y el PO les asigna enlace **antes del merge** y antes de cada promoción.
- Usuarios de enlace `proveedor` (hoy internos) pierden todo lo que no es SOAT. Usuarios de enlace
  `organismos_transito` pierden todo hasta #13426 (Impuestos y Derechos se abren allí). Usuarios de
  enlace `compania` en roles internos quedan acotados a SOAT de su compañía hasta #13426 (AC7).
  **El Feature #12871 no se promueve a `staging` sin #13426.**
- El 403 de la frontera conserva el cuerpo `{ error: 'Sin permisos' }`: indistinguible del de otras capas.

## Pendiente (decide el Líder Técnico)

1. Aprobar C frente a A/B.
2. Expand/contract de `tipo_principal`: borrar la columna en un WI posterior a la promoción a PDN (recomendado), o en la 0231 aceptando que el rollback de imagen deja la API en 403 total.
3. Corte del contrato entre #12875 y #12876 (ver diseño §9): la parte mecánica de `apps/web` que exige el cambio de `shared-types` viaja en el PR de #12875.
