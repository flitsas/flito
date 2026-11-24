# ADR-0047 — Conjuntos de la Torre: la cifra y su detalle salen del mismo SQL

- **Estado:** Aceptado — «ok» del Líder Técnico humano (David Chica) en la sesión del 2026-11-19.
- **Fecha:** 2026-11-19
- **Work item:** Épica ADO #14590 «Torre de Control». Por decisión del humano **no hay Features ni HUs** en ADO:
  la entrega va en bloques (un PR `FEATURE/14590-davidchica-<desc>` por bloque) y los AC viven en el diseño y en
  el cuerpo de cada PR.
- **Módulo:** **FLITO**, `apps/api/src/modules/flito-torre/` (`/api/flito/torre`). Lee tablas de otros módulos
  FLITO (`flito-soat`, `flito-impuestos`, `flito-derechos`, `flito-logistica*`, `siigo`, `flito-bolsas*`,
  `finanzas`). **No** lee ni toca los legacy sin prefijo (`soat`, `tramites`, `liquidacion`, `pagos`,
  `liquidaciones`).
- **Relación con ADRs previos:** **extiende** ADR-0043 (motor de métricas) y ADR-0044 (Explorador flexible).
  `Supersedes: ninguno`. Se mantienen: el catálogo cerrado (ningún identificador SQL viaja desde el navegador),
  el constructor único de condiciones `condicionesTorre()` (RN-TOR-F1), la consulta en vivo dentro de `enTorre`
  (`statement_timeout` de 15 s), la caché Redis de 60 s, la zona horaria de Bogotá y RN-TOR-M1/L1.
- **Diseño operativo:** [`docs/diseno/epica-14590-torre-detalle-universal.md`](../diseno/epica-14590-torre-detalle-universal.md).

## Contexto

Las KPI de los tableros Comercial, Operativa y Financiera muestran cifras que no dicen qué son ni dejan ver qué
registros las forman. Tres casos concretos:

- «Concentración en el Top 3: 98 %» no aclara que se calcula sobre los trámites creados en el periodo y agrupados
  por compañía, ni nombra a esas 3 compañías (`flito-torre.comercial.service.ts`, `concentracion()`). Encima, la
  pista de la tarjeta habla del Top 5.
- «Borradores abandonados» se calcula con un `count(*) FILTER` dentro de `calcularRadar()`. La alerta
  `borrador_5d` de Trámites usa otra regla, así que las dos cifras no coinciden.
- «Soportes completos 3/3» suma puntos por trámite en `conciliacion()` sin mostrar a qué trámite le falta qué.

El humano pidió tres cosas para cada cifra: que diga qué es, que explique cómo se calcula y que abra sus
registros (filtrables, paginados y exportables) dentro de la Torre. También pidió extender la Torre a todo el
sistema. El riesgo central es que **la lista y la cifra no coincidan**. Si cada lista se escribe aparte, se
repite el caso de los borradores en cada KPI nueva.

**Invariante que este ADR fija:** para todo conjunto `c` y todo filtro `f`, la cifra que muestra el tablero o el
Explorador es igual al `total` que devuelve `POST /detalle/consultar` con el mismo `c` y el mismo `f`. En las
métricas de suma, también es igual a la suma de la columna de valor. Las dos consultas comparten el mismo `FROM`,
la misma condición del conjunto y el mismo `condicionesTorre()`, como **valores `SQL` de Drizzle**, no como
texto copiado.

## Alternativas

### Opción 1 — Registro de conjuntos: un fragmento SQL por conjunto que consumen el contador y el listador (elegida)

Se crea un catálogo cerrado `CONJUNTOS_TORRE` en shared-types, con id, entidad, definición, columnas, segmentos
admitidos y si requiere dinero, más su SQL fijo `CONJUNTOS_SQL` en la API (`flito-torre.conjuntos.ts`). Cada
entrada declara el `desde`, las `dims` para `condicionesTorre`, las condiciones fijas, la fecha que la ancla (o
`null` si es foto del momento) y los filtros que ignora. Hay dos consumidores:

- `contarConjuntos()` hace `count(*)` o `count(*) FILTER (WHERE …)`. Se usa cuando varios conjuntos comparten el
  mismo `desde` y la misma base, y así el radar sigue costando una sola consulta.
- `listarConjunto()` hace `SELECT <columnas> … ORDER BY … LIMIT/OFFSET`.

Los servicios de tablero se refactorizan para contar con `contarConjuntos()`. Las métricas del Explorador abren su
detalle a partir de `resolverDef()`, el mismo SQL del motor, y el segmento usa la misma expresión
`claveAgrupacion()` del `GROUP BY`.

- **Pros:** la invariante se cumple por construcción y un test la comprueba por conjunto. Reutiliza
  `condicionesTorre`, `enTorre`, la caché, `sendExcel` y `textoSeguro`, y la definición de «¿Cómo se calcula?»
  tiene una sola fuente. Los dominios nuevos (B3–B5) entran como filas del registro, no como pantallas a medida.
- **Contras:** hay que refactorizar los cuatro servicios de tablero y `contarSinGestion()` de `flito-tablero`.
  Los cálculos que hoy se hacen en JS, como la severidad de las bolsas o la variación de la fuga, tienen que
  pasar a SQL para poder abrirse.
- **Esfuerzo:** L (B1), y después M por dominio.
- **Riesgos:** una regresión en las cifras actuales durante el refactor. Se mitiga con los tests actuales de
  `flito-torre-tableros.test.ts` y con el nuevo test de invariante, que compara la cifra del tablero con el
  `total` del detalle. Hay riesgo de rendimiento en `OFFSET` profundo, que se acota con un tope de
  paginación (ver el diseño).

### Opción 2 — Endpoint de detalle por KPI, escrito a mano junto a cada tablero

Cada KPI tiene su propia consulta de lista (`/tableros/operativa/borradores`, etc.), escrita al lado de su
contador.

- **Pros:** es lo más rápido para los tres ejemplos (S) y no obliga a refactorizar.
- **Contras:** dos SQL por cifra que divergen con el tiempo, que es justo el defecto que motivó el pedido (los
  borradores). Hace falta un endpoint y una guarda por KPI (más de 40 rutas al terminar B5) y la definición
  vive en tres sitios.
- **Esfuerzo:** S para B1 y L acumulado.
- **Riesgos:** la deriva silenciosa entre la cifra y la lista. La inventario de guardas y el contrato OpenAPI
  crecen en lineal.

### Opción 3 — Tabla de hechos materializada (`flito_torre_hechos`) refrescada por cron

Un cron materializa, por cada trámite, gestión o factura, las banderas de cada conjunto (`es_borrador_abandonado`,
`soportes_n`, …). El tablero cuenta banderas y el detalle filtra por ellas.

- **Pros:** la cifra y la lista son consistentes y las consultas son baratas.
- **Contras:** la información queda desfasada (lo contrario del ADR-0043 D2, «consulta en vivo»). Necesita
  migración, cron, monitoreo y reconstrucción. Y duplica en otra tabla datos ligados a la placa, lo que añade
  una superficie de Ley 1581 con su política de retención.
- **Esfuerzo:** L+.
- **Riesgos:** un cron que falla deja cifras viejas sin aviso. Habría que contradecir ADR-0043 con un ADR nuevo.

## Decisión

**Opción 1.** Es la única que cumple la invariante por construcción sin contradecir ADR-0043/0044. Además
reutiliza piezas que ya existen en el módulo (`CATALOGO_SQL` + `resolverDef`, `condicionesTorre`, `enTorre`,
`conCacheTablero`, `claveAgrupacion`) y no agrega dependencias.

Decisiones derivadas que este ADR fija (el detalle está en el diseño):

- **D1. Catálogo cerrado de conjuntos.** El cliente solo manda claves de `CONJUNTOS_TORRE` (o una métrica del
  Explorador) y segmentos con dimensión cerrada. Un conjunto o segmento desconocido es 400 (Zod `.strict()`) y el
  servicio lo vuelve a comprobar.
- **D2. El segmento es la misma expresión que agrupa.** Un segmento `{ dimension: 'compania', valores: [..] }` se
  traduce a `claveAgrupacion(dimension, dims, fecha) IN (...)`, la misma expresión que usa el `GROUP BY` del
  motor. Los segmentos propios de un conjunto (p. ej. `nivel` de soportes) los declara el conjunto como fragmento.
- **D3. Prohibido contar «al lado».** Una KPI que ofrece «Ver cuáles» debe contarse con `contarConjuntos()`. Si
  una cifra no se puede expresar como conjunto (p. ej. «Clientes en caída», que es una lista de compañías y no de
  registros), su destino es el bloque del tablero que ya la lista (`destino.tipo = 'bloque'`), nunca una lista
  aproximada.
- **D4. Detalle con cuasi-PII y `logPiiAccess`.** El detalle proyecta la **placa** (cuasi-PII, AGENTS §14), la
  compañía y el estado, nunca el nombre ni la cédula del titular. Se registra `logPiiAccess` en toda consulta o
  exportación válida cuyo resultado incluye la columna placa, en modo *fail-open* con el fallo en el log (regla 16:
  colas y bandejas fallan abierto). La placa solo viaja en el body y nunca en la URL de la web ni de la API.
- **D5. Caché solo del conteo.** El `total` del detalle se cachea 60 s (la misma clave y TTL de RN-TOR-M8). Las
  filas no se cachean, para no replicar placas en Redis.
- **D6. Permisos.** Se crean las operaciones `torre.detalle.ver` y `torre.detalle.exportar`, con el ítem
  `pagina.torre_detalle` y el PageSlug `torre_detalle`. Ver un conjunto exige además **alguna** de sus
  `funcionesOrigen` (la del tablero o el Explorador que lo muestra). El dinero sigue con `torre.metricas.dinero`:
  sin él, las columnas de dinero salen `null` y los conjuntos `requiereDinero` responden 403. El auditor ve el
  detalle pero no lo exporta.
- **D7. Sin migración de datos.** Solo hay una migración de siembra de permisos (B1) e índices puntuales
  verificados con `EXPLAIN`, cada uno en su bloque y con `db-review-agent`.

## Consecuencias

- Los servicios de tablero dejan de escribir `count(*) FILTER` a mano para las cifras que ofrecen «Ver cuáles».
  `flito-tablero.service.ts` exporta las condiciones de «sin gestión» y `contarSinGestion()` las consume, así que
  el cambio toca un módulo vecino (FLITO, no legacy) con sus tests.
- Las cifras actuales no cambian, salvo donde la definición estaba oculta y se hace explícita. Se exceptúa la
  regla de borrador abandonado, que se decide en B2 (pendiente humano) y, si cambia, se anuncia en el PR.
- `RN-TOR-D1..D8` (detalle) se documentan en la cabecera de `flito-torre.conjuntos.ts` y
  `flito-torre.detalle.service.ts`.
- El contrato OpenAPI (`contracts/openapi/flito-api.v1.yaml`) se regenera con `npm run contrato:generar` en B1 por
  las 2 rutas nuevas.

## Checklist de seguridad (para `security-agent`)

1. Las dos rutas usan `authMiddleware`, `exigirFuncion('torre.detalle.ver')` (más `torre.detalle.exportar` y
   `torreExportLimiter` en el export) y `torreConsultaLimiter` en consultar. Las literales se pueden leer en
   `inventario-guardas`.
2. Se comprueba `funcionesOrigen` en el servicio con `tieneFuncion`, y hay un test que niega el detalle de la
   Financiera a quien solo tiene la Comercial.
3. Se llama a `logPiiAccess(req, { resourceTipo: <tabla de la entidad>, accion: 'read' | 'export', camposAccedidos: ['placa'], motivo })`
   y ni el servicio ni la ruta loguean el body.
4. Sin nombre ni cédula del titular, sin VIN completo (solo los 4 últimos, RN-TOR-P3) y sin las columnas
   personales de actas (`direccion_entrega`, `contacto_nombre`, `receptor_nombre`, `entrega_nombre`,
   `entregado_lat`, `*_storage_key`) ni de impuestos (`direccion_*`). En el equipo (B5) se usa el nombre del
   funcionario, nunca `usuario_email`.
5. El Excel pasa por `textoSeguro` (inyección de fórmulas), con el tope `FILAS_DETALLE_EXPORTAR_MAX` y un nombre
   de archivo sin la placa.
6. La URL de la web solo lleva ids opacos: la clave del conjunto, ids de compañía, códigos DIVIPOLA y estados.

## Pendiente de decidir por una persona

- Aprobación de este ADR (Líder Técnico).
- B2: unificar «borrador abandonado» con la alerta `borrador_5d` de Trámites (recomendación en el diseño §11).
- B4: definición de «cartera» (hoy no hay en FLITO un registro de pago de la factura de Siigo).
- B5: qué roles ven «Equipo» (propuesta: `gerencia_general` y `admin`).
