# ADR-0044 — Explorador flexible de la Torre: fecha base, agrupación doble y sugerencias de placa

- **Estado:** Aceptado — 2026-11-18, «ok» de David Chica (Líder Técnico) a la maqueta y a este diseño en la sesión de la Épica #14590.
- **Fecha:** 2026-11-18
- **Work item:** Épica ADO #14590 «Torre de Control Gerencial». Es el único WI: no hay HUs, por
  decisión del responsable. Rama `FEATURE/14590-davidchica-torre-explorador-flexible`, creada desde
  `develop` en `a04b0f3c`.
- **Módulo:** **FLITO**, `apps/api/src/modules/flito-torre/` (`/api/flito/torre`). No toca el legacy.
- **Relación con ADR-0043:** lo **extiende**, no lo sustituye (`Supersedes: ninguno`). Amplía su D1
  (el contrato del motor) y su checklist de seguridad §3 y §5. Lo demás sigue igual: el catálogo
  cerrado, el constructor único de condiciones, la consulta en vivo con Redis de 60 s, la zona
  horaria de Bogotá y RN-TOR-M1.
- **Diseño operativo:** contrato, reglas, archivos por bloque y riesgos en
  [`docs/diseno/epica-14590-torre-explorador-flexible.md`](../diseno/epica-14590-torre-explorador-flexible.md).

## Contexto

El humano pidió, textualmente: «El Explorador debe ser muy flexible: que a través de seleccionar
diferentes filtros y agrupaciones yo pueda saber, por ejemplo, trámites realizados en los últimos 6
meses por compañía (trámites en estado Aprobado + fecha de aprobación desde junio + agrupar por
compañía). También en la búsqueda de placa, al escribirla, mostrar coincidencias mientras se escribe.»

Decisiones del humano en la sesión. Están cerradas y este ADR no las reabre:

- **D1.** El modelo es un «constructor libre». El usuario elige qué medir (trámites, tiempo o
  dinero), qué fecha manda (la fecha base es elegible), filtros con **selección múltiple** y
  agrupaciones. Sigue siendo un **catálogo cerrado**: ningún identificador SQL viaja desde el
  navegador.
- **D2.** Se admiten hasta **2 agrupaciones**: una principal y una secundaria opcional. Con dos, el
  resultado es una tabla cruzada (filas × columnas). Si una de ellas es temporal, también hay una
  gráfica por series. El Excel exporta la tabla cruzada.
- **D3.** «Aprobado» = `fecha_aprobacion` dentro del rango, sin importar el estado actual (sigue
  RN-TOR-M1). «Siguen en Aprobado» se obtiene combinando con el filtro Estado.
- **D4.** Las sugerencias de placa arrancan con 3 caracteres, muestran hasta 8 y buscan la
  coincidencia en **cualquier parte** de la placa. Cada sugerencia trae placa, compañía y estado;
  nada del comprador. Solo salen placas del alcance del rol, con el alcance en el `WHERE`. Van por
  `POST` con el texto en el body, con `rateLimiter` y con `logPiiAccess`.

Segunda ronda de cierre (2026-11-18), también cerrada:

- **D5 (P-2).** Las fechas base elegibles son **exactamente** creación, aprobación, pago y
  **facturación**. La liquidación (`liquidado_en`) queda fuera del diseño. La radicación, también.
- **D6 (P-3).** Las liquidaciones «anuladas» se excluyen en **toda** la Torre: el Explorador, los
  tableros y el export. **El esquema no tiene ese estado**; el criterio exacto queda pendiente
  (§(f)). El humano eligió después L-β (§(f)).
- **D7.** «Últimos 6 meses» se alinea al mes: va del día 1 del mes de hace 5 meses hasta hoy (con hoy
  = 18-nov, del 1-jun al 18-nov).
- **D8 (P-5).** Una sugerencia por placa, con la compañía y el estado del trámite más reciente dentro
  del alcance, y sin conteo de trámites. Elegirla abre la ficha como hoy. El endpoint se llama
  `POST /api/flito/torre/placa/sugerencias`.
- **D9.** P-1 = no: el tiempo de ciclo solo se mide por aprobación. P-4 = sí: los tableros reciben
  varias compañías. P-6 = sí: el ejemplo del pedido entra como pregunta frecuente.

**Estado actual, verificado en el código.** `FiltroTorre` ya admite arreglos (`companiaIds[]`,
`organismos[]`, …) y `condicionesTorre()` ya los compone con `IN`. La selección múltiple, por tanto,
es una brecha **solo de la web**: `FiltrosTorre` en `lib/torreFiltros.ts` guarda escalares y
`aFiltroTorre` los envuelve en arreglos de un elemento. En cambio, cada métrica tiene **una sola**
fecha fija (`CATALOGO_SQL[m].fecha`), la consulta admite una sola `agrupacion` y la búsqueda de
placa es por igualdad sobre `upper(plate_complete)`, con el índice btree de la 0303. `pg_trgm` se
crea en las migraciones 0012 y 0041. No se asume que esté instalada en todos los ambientes (hay un
precedente de `unaccent` ausente en DEV pese a la 0012).

## Decisiones

### (a) Cómo se modela «medida × fecha base»

| Opción | Pros | Contras | Esfuerzo | Riesgos |
|---|---|---|---|---|
| **A1. `fechaBase` opcional en la consulta, una lista `fechasBase` por métrica (la primera es la de defecto) y una métrica neutra `tramites`** | Aditivo: una consulta sin `fechaBase` responde lo mismo que hoy. La matriz de compatibilidad vive en el mismo catálogo que ya decide el permiso de dinero y las agrupaciones. Zod la valida con un `refine` | Conviven ids legados (`tramites_creados`, `tramites_aprobados`) y el neutro `tramites`, que con su fecha correspondiente dan lo mismo | M | Que alguien vuelva a ofrecer los ids legados en el selector. Mitigación: la bandera `enConstructor: false` |
| A2. Descomponer el catálogo en `medida` × `fechaBase` y derivar los ids actuales como alias | Es el modelo más puro, sin duplicados | Reescribe el catálogo, el contrato y los tests del motor. Los alias complican la caché y el export. Rompe a quien manda `metrica` | L | Regresiones en los tableros, que reutilizan las expresiones del catálogo |
| A3. Más métricas fusionadas (`tramites_por_aprobacion`, `costo_logistica_por_liquidacion`, …) | Cero cambios de forma en el contrato | Explosión combinatoria: el selector deja de ser un constructor | S→L | El catálogo crece sin control y se pierde la idea de «fecha base» |

**Decisión: A1.** La fecha base es **una variante declarada por métrica**, no un campo libre. Cada
entrada del catálogo SQL lista sus variantes (`fechas: { creacion?, aprobacion?, facturacion?, pago? }`),
cada una con su expresión de fecha, su campo para `baseFecha`, sus condiciones fijas, su `sync` y,
si hace falta, un `desde` propio (la facturación añade su JOIN, §(a2)).
Una combinación que no está en la matriz es un 400. La métrica neutra `tramites` es la que ofrece el
constructor. Los dos ids legados siguen aceptándose (tests, export, pestañas abiertas) con una sola
fecha cada uno, y no se ofrecen en «Medir».

Matriz de compatibilidad (✔ admitida, ● la de defecto):

| Métrica | creación | aprobación | facturación | pago | Por qué no admite las demás |
|---|---|---|---|---|---|
| `tramites` (nueva) | ● | ✔ | ✔ | — | El pago no es un evento del trámite: es de un impuesto o de un derecho, y un trámite puede tener varios o ninguno |
| `tramites_creados` (legado) | ● | — | — | — | Id fijo |
| `tramites_aprobados` (legado) | — | ● | — | — | Id fijo |
| `tiempo_creacion_aprobacion` | — | ● | — | — | D9 (P-1 = no): por creación hay sesgo de supervivencia. Por facturación mezclaría el ciclo de la OT con la demora administrativa de facturar. Por pago no tiene sentido |
| `costo_logistica` | — | ● | ✔ | — | La creación no es un evento contable: aún no hay costo. El pago no es del trámite |
| `ingreso_liquidado` | — | ● | ✔ | — | Igual. Con facturación se lee como «ingreso facturado en el periodo» |
| `impuestos_pagados` | — | — | — | ● | El hecho es el pago (`pagado_en`). Fecharlo por la factura del trámite contaría impuestos pagados en otro periodo |
| `derechos_pagados` | — | — | — | ● | Igual, con `fecha_pago` (tipo `date`) |
| `tasa_aprobacion` | ● | — | — | — | Por aprobación sería siempre 100 %. Por facturación, también: todo lo facturado está aprobado |
| `sin_facturar` | — | ● | — | — | Por definición no tiene factura, así que no puede fecharse por ella |
| `wip_activo` | foto | foto | foto | foto | No tiene rango: `fechaBase` es un 400 |

**Facturación** = la fecha de la **primera factura Siigo ACTIVA** del trámite:
`min(siigo_factura_tramites.created_at) WHERE tramite_id = T.id AND activo = true`. Es la misma
definición del paso «Facturado» de la ficha (RN-TOR-P4) y la misma condición del `FACTURADO` del
catálogo, que alimenta `sin_facturar`, el bloque financiero y el embudo comercial. No se usa
`flito_liquidaciones.facturado_en`, porque es otra marca y podría discrepar de la factura real. Si un
trámite tiene varias facturas activas (una por concepto, desde A1), manda la primera.

### (a2) Coste de la fecha de facturación

| Opción | Pros | Contras | Esfuerzo | Riesgos |
|---|---|---|---|---|
| F1. Subconsulta correlacionada en el `WHERE` y en la clave temporal | Lo más corto de escribir | Se evalúa por cada trámite que pasa los demás filtros; sobre `flito_tramites` no hay ninguna fecha que acote antes | S | Recorre la tabla de trámites completa en rangos largos |
| **F2. Tabla derivada `INNER JOIN (SELECT tramite_id, min(created_at) AS facturado_en FROM siigo_factura_tramites WHERE activo GROUP BY tramite_id) F ON F.tramite_id = T.id`, con el rango sobre `F.facturado_en`** | Una agregación por consulta sobre una tabla pequeña (solo filas facturadas), y el `JOIN` reduce los trámites antes de los demás filtros. `F.facturado_en` sirve como `FechaBase.expr` para el rango y para `date_trunc` sin repetir la subconsulta | La agregación barre todas las filas activas de la tabla en cada consulta | S | Que la tabla crezca mucho (hoy está acotada por lo facturado desde la integración con Siigo) |
| F3. `LEFT JOIN LATERAL (SELECT min(created_at) …)` | Expone el valor por fila | El mismo coste por fila que F1 | S | Igual que F1 |

**Decisión: F2**, con un índice nuevo en la misma migración:
`siigo_factura_tramites (tramite_id, created_at) WHERE activo`. Le permite al `GROUP BY tramite_id`
+ `min(created_at)` resolverse con un recorrido solo de índice, y acelera además las subconsultas que
ya existen (`FACTURADO` y RN-TOR-P4). El único índice que hay hoy sobre activas
(`idx_siigo_factura_tramites_vivo`, `(tramite_id, COALESCE(concepto,'*')) WHERE activo`) no incluye
`created_at`. El coste de escritura es bajo: la tabla casi solo recibe altas.

El btree propuesto antes para `flito_liquidaciones(liquidado_en)` **sale del diseño**, porque ninguna
otra consulta de la Torre filtra ni agrupa por `liquidado_en` (la comercial, la operativa y la
financiera fechan por la aprobación o la creación del trámite). Con él sale también el cambio a
`schema/finanzas.ts`.

### (b) Agrupación doble en SQL

| Opción | Pros | Contras | Esfuerzo | Riesgos |
|---|---|---|---|---|
| B1. `GROUP BY 1, 2` de todas las celdas y plegar «Otros» en TypeScript | Una consulta simple | **Inexacto** para la mediana y el p90: no son aditivos, así que «Otros» y los totales por fila no salen de sumar celdas. Además trae hasta compañías × organismos celdas antes de recortar | S | Cifras de tiempo erróneas; memoria |
| **B2. Una sentencia: CTE `base` materializada con `(k1, k2, v)` → top-N por eje → `GROUPING SETS ((f, c), (f), (c))` sobre las claves ya mapeadas a «Otros»** | Exacto para toda forma (conteo, suma, tasa, tiempo), porque el agregado corre sobre las filas crudas. Los marginales salen en la misma pasada. Un solo `statement_timeout` | SQL más largo; el agregado debe leer columnas de la CTE | M | Coste en rangos de 24 meses con muchas filas (lo acotan el timeout de 15 s y los índices) |
| B3. Una consulta por fila del eje principal | Lógica trivial | N+1 consultas y latencia lineal | M | Tumba el `rateLimiter` y el timeout |

**Decisión: B2.** Un eje **de dimensión** se recorta a top-N por su marginal (`valor` o `n`, según
la forma, igual que hoy) y el resto va a una fila o columna «Otros» calculada en SQL. Un eje
**temporal** no se recorta: trae todos sus cortes en orden cronológico, sin «Otros», y el número de
cortes se valida **antes** de consultar (los topes están en el diseño, RN-TOR-C3). No se admiten
dos agrupaciones temporales ni la misma dos veces.

### (c) Forma del resultado cruzado

| Opción | Pros | Contras | Esfuerzo | Riesgos |
|---|---|---|---|---|
| **C1. Aditivo: `ResultadoMetrica.cruce?` con `columnas` y una matriz densa `celdas[i][j]` (`null` si no hay registros). `filas` pasa a ser el marginal por fila** | Quien hoy consume `filas` (el ranking, la gráfica, el export simple y los tests) sigue igual. Con una sola agrupación la respuesta es idéntica a la de hoy | `truncado` cambia de matiz en el cruce («se plegó en Otros» en vez de «se cortó») | S | Confundir el marginal con la suma de las celdas (RN-TOR-C4 lo prohíbe) |
| C2. Unión discriminada `ResultadoSimple \| ResultadoCruzado` | Tipos más estrictos | Rompe a todos los consumidores actuales, que deben estrechar el tipo | M | Regresión de tipos en la web y el export |
| C3. Formato largo `celdas: { fila, columna, valor }[]` | Disperso y compacto | La UI y el export deben pivotar; ordenar y rellenar huecos queda en el cliente | M | Pivotes divergentes entre la web y el Excel |

**Decisión: C1.** Con los topes, la matriz densa más grande en pantalla ronda las 51 × 63 celdas y en el
export, 2.001 × 101 (unas 200.000): no compensa el formato disperso.

### (d) Búsqueda «contiene» de placa

| Opción | Pros | Contras | Esfuerzo | Riesgos |
|---|---|---|---|---|
| D-a. `upper(plate_complete) LIKE '%' \|\| $1 \|\| '%'` sin índice | Cero migración | Recorre `flito_tramites` entera en cada tecla (con debounce) | S | Latencia que crece con la tabla, multiplicada por usuarios tecleando |
| **D-b. Índice GIN `gin (upper(plate_complete) gin_trgm_ops)`, creado SOLO si `pg_trgm` está instalada (bloque `DO` con guarda y `EXCEPTION`)** | `LIKE '%abc%'` usa el índice desde 3 caracteres, que es justo el mínimo de D4. La migración nunca falla por la extensión; sin ella, la consulta funciona igual con un recorrido completo | El GIN cuesta escritura en cada alta o cambio de placa (la sincronización masiva) y algo de disco | S | Que el ambiente no tenga `pg_trgm` y quede en D-a sin que nadie lo note (la migración lo deja en `NOTICE` y devops lo comprueba) |
| D-c. btree `text_pattern_ops` (solo prefijo) | Índice barato | **Incumple D4** («en cualquier parte») | S | — |

**Decisión: D-b.** La consulta no depende de la extensión, solo el índice. **No** se hace
`CREATE EXTENSION`: no se asume que el rol de la migración pueda crearla. La consulta de
sugerencias no usa caché Redis, porque el texto parcial no debe vivir en la clave ni en el valor.

### (e) Compatibilidad hacia atrás

| Opción | Pros | Contras | Esfuerzo | Riesgos |
|---|---|---|---|---|
| **E1. Campos opcionales nuevos (`agrupacionColumnas`, `fechaBase`) sobre `ConsultaMetrica`; en la web, la misma clave de `sessionStorage`, con una lectura que acepta la forma escalar vieja y una escritura que solo produce arreglos** | Ninguna consulta ni pestaña abierta se rompe; los tests actuales siguen valiendo | `normalizarFiltrosTorre` carga con la lectura legada hasta que se retire | S | Ninguno relevante |
| E2. `agrupaciones: [principal, secundaria?]` y normalizar `agrupacion` → arreglo | Forma más regular | Dos formas para lo mismo en el contrato y en la clave de caché | M | Que la misma consulta use dos claves de caché |
| E3. Endpoint nuevo `/metricas/consultar-v2` y clave `flito-torre-filtros.v2` | Corte limpio | Duplica la ruta, el limiter, el inventario de guardas y el OpenAPI | M | Deriva entre v1 y v2 |

**Decisión: E1.** La clave de caché del motor incluye la `fechaBase` **resuelta** (la explícita o la
de defecto). Así, al desplegar, ninguna entrada vieja de Redis (sin `baseFecha.fechaBase`) se sirve a
la web nueva: el TTL de 60 s no llega a cruzarse con el cambio de forma.

### (f) Liquidaciones anuladas: el esquema no tiene ese estado

Esto está verificado en el esquema, no se supone:

- `flito_liquidaciones.estado` es `varchar(20)` con `CONSTRAINT flito_liq_estado_valido CHECK (estado
  IN ('liquidado', 'facturado'))` (migración 0111). Ninguna migración posterior cambia ese CHECK (la
  0194 solo añade una columna). En el código, `ESTADO_LIQUIDACION = { LIQUIDADO, FACTURADO }`
  (`flito-liquidacion.service.ts`).
- Reversar una liquidación **borra la fila** (`tx.delete(flitoLiquidaciones)` en
  `flito-liquidacion.service.ts`, tras registrar el evento `accion: 'reversar'` en
  `flito_liquidacion_eventos`). Una liquidación reversada, por tanto, ya no entra hoy en ninguna
  cifra de la Torre.
- Sí existen otras dos «anulaciones»: el **trámite** anulado en FLIT (`flit_estado` = «Anulado»;
  `ESTADOS_FLIT_CERRADOS` también lista abortado, rechazado y revocado) y la **factura** anulada ante
  la DIAN (`SIIGO_ESTADOS_DIAN` incluye `'anulada'`, en el historial de estados DIAN de la factura).
  `anulada` en `liquidacion.service.ts` es del módulo **legacy** `liquidacion`, que la Torre no lee.

**Decisión del humano (L-β, 2026-11-18).** Una liquidación «anulada» es la de un trámite cuyo
`flit_estado` es anulado, abortado o revocado. **No** se excluye «Rechazado», y la factura anulada
ante la DIAN (L-γ) **no** aplica. Se implementa como **un único fragmento** en
`flito-torre.catalogo.ts`:

```ts
/** RN-TOR-L1: la liquidación cuenta salvo que FLIT haya anulado, abortado o revocado su trámite. */
export const LIQUIDACION_VIGENTE = sql`COALESCE(lower(${T.flitEstado}), '') NOT IN ${['anulado', 'abortado', 'revocado']}`;
```

Equivale a `COALESCE(lower(flito_tramites.flit_estado), '') NOT IN ('anulado', 'abortado', 'revocado')`. Lo usan todas las consultas de la Torre que leen `flito_liquidaciones`; la lista
está en el diseño, § 4 bis.

**Verificación de los valores** (contra el catálogo y la sincronización, no supuestos):

- `'anulado'` **existe**. FLIT 1 y FLIT 2 escriben `flit_estado = 'Anulado'` (`flit2-mapeo.ts`,
  `TEXTO_FLIT`). En `shared-types/src/flito-estados.ts` es `EstadoTramiteFlito.ANULADO = 'anulado'`;
  ojo, ese catálogo es el estado **FLITO** (`flito_tramites.estado`), no el `flit_estado`.
- `'revocado'` **existe**, solo en FLIT 2: `flit_estado = 'Revocado'`, con estado FLITO `anulado`
  (`flit2-mapeo.ts`, AC7). No está en `EstadoTramiteFlito`, porque allí se pliega en `anulado`.
- `'abortado'` **no aparece** en ningún catálogo ni mapeo del código: ni en `EstadoTramiteFlito`,
  ni en `TEXTO_FLIT` de FLIT 2, ni en la sincronización de FLIT 1. Solo figura en la lista propia de
  la Torre `ESTADOS_FLIT_CERRADOS` (`flito-torre.catalogo.ts`). FLIT 1 guarda el texto del reporte
  tal cual, así que podría llegar, pero el código no lo demuestra. **No lo invento:** queda en el
  fragmento porque lo decidió el humano (si nunca llega, la condición es inocua) y se marca como
  **dato por verificar** en DEV y PDN con
  `SELECT lower(flit_estado), count(*) FROM flito_tramites GROUP BY 1`. Si no existe, se puede quitar
  sin cambiar ninguna cifra.
- La comparación se hace en minúsculas (FLIT escribe los valores capitalizados), igual que
  `EN_CURSO`. El `COALESCE(…, '')` es **obligatorio**: sin él, un `flit_estado` nulo da `NULL` y
  la liquidación se excluiría por error.

### (g) «Últimos 6 meses» en un solo sitio

Hoy lo calcula la web (`rangoDe` en `formatoTorre.ts`, `case 'ultimos_6m'`) y ya está alineado al
mes: `new Date(y, m-1-5, 1)` → con hoy = 18-nov da el 1-jun. **Decisión:** el cálculo pasa a la
**API** como preset `ultimos_6m` de `PRESETS_RANGO_TORRE`, resuelto en `resolverRango()` con el
`hoy` de Bogotá del servidor, y la web manda `{ preset: 'ultimos_6m' }`. Así hay un solo cálculo
(con test), sin depender del reloj ni de la zona del navegador, y la clave de caché se estabiliza
por día. Los demás periodos que hoy calcula la web (`ultimos_7`, `m:YYYY-MM`) quedan como están: no
forman parte del pedido.

## Seguridad (checklist, añade a ADR-0043 §3 y §5)

1. `fechaBase` y `agrupacionColumnas` son `z.enum` del catálogo, y la matriz se valida con `refine`
   en Zod **y** de nuevo en el servicio (defensa en profundidad para llamadas internas).
2. La agrupación doble pasa por `condicionesTorre()` (RN-TOR-F1) y `claveAgrupacion()`, ambos sin
   cambios. Las claves del top-N se calculan dentro de la misma sentencia; no vuelven del cliente.
3. `POST /flito/torre/placa/sugerencias`:
   - texto en el body, entre 3 y 7 caracteres `[A-Za-z0-9]`;
   - `exigirFuncion('torre.placa.buscar')`, la misma función que la ficha, así que no hay permiso nuevo;
   - limiter **propio** de 60/min por usuario, `frenoConRastro` y sin registrar el cuerpo;
   - `logPiiAccess` en **toda** petición;
   - alcance en el `WHERE`;
   - lista vacía = `200 []` (no 404): una lista vacía no distingue «no existe» de «fuera de alcance»;
   - sin caché y `Cache-Control: no-store`;
   - nada de `flito_compradores`.
4. El texto parcial de la placa nunca va a la URL, a `sessionStorage`, al logger ni a los mensajes
   de error.
5. Pasa por `security-agent` (ruta nueva con cuasi-PII) y por `db-review-agent` (migración nueva).

## Consecuencias

- El selector «Medir» de la web deja de listar `tramites_creados` y `tramites_aprobados`, y ofrece
  `tramites` con la fecha base. Las preguntas frecuentes migran al id neutro.
- La barra de filtros es compartida por las 5 páginas, así que los **tableros heredan la selección
  múltiple** (D9, P-4 = sí). El backend de los tableros ya la admite (`IN`).
- Al excluir las liquidaciones de trámites anulados, abortados o revocados (D6, L-β), las cifras de
  dinero del Explorador y de los tableros **bajan** frente a lo que muestran hoy. Se avisa en el PR y
  en la sesión de evidencias.
- `flito-torre.metricas.service.ts` no crece: el cruce va en un archivo propio
  (`flito-torre.cruce.ts`).
- En la web, el kit `PanelFiltros` recibe props **aditivas** para el combobox del buscador. Es un
  archivo compartido con otras pantallas: lo verifican el grep de usos y los E2E.
