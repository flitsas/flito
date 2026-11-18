# Diseño slim — Torre de Control: vistas flexibles (rango visible, eje legible, Top N, %, comparar)

Épica #14590 · módulo FLITO `flito-torre` (`/api/flito/torre`), no el legacy · 2026-11-18 · estado: **Propuesto**
Extiende [ADR-0044](../adr/ADR-0044-flito-torre-explorador-flexible.md) y
[epica-14590-torre-explorador-flexible.md](epica-14590-torre-explorador-flexible.md). No los reescribe: todo lo de
aquí es **opcional y aditivo**. Una consulta sin los campos nuevos responde lo mismo que hoy.

Origen: decisiones de David Chica en la sesión de evidencias (F1, G1, V, fecha-rango) y los defaults del hilo
P-7…P-10. Los conservo tal cual. Lo que marco como **Nota** es un matiz técnico, no un cambio.

## Patrón reutilizado

| Pieza | Patrón vecino (path real) |
|---|---|
| Campos nuevos de la consulta + Zod `.strict()` + 400 por combinación inválida | `fechaBase` / `agrupacionColumnas` en `apps/api/src/modules/flito-torre/flito-torre.esquemas.ts` (RN-TOR-M11, RN-TOR-C1) |
| Periodo anterior de igual duración | `flito-torre.comercial.service.ts:153` (`sumarDias(desde, -dias)` … `sumarDias(desde, -1)`) |
| Segunda pasada con el mismo `WHERE` en la misma transacción y la misma caché | `consultarCruce` dentro de `enTorre` en `flito-torre.metricas.service.ts` (RN-TOR-C5) |
| Topes que dependen del modo (pantalla/exportar) | `topesCruce(modo, limite)` en `flito-torre.cruce.ts` |
| Límite `timestamp AT TIME ZONE` independiente de la zona de la sesión | `condicionRango` en `flito-torre.filtro.ts` (#805) |
| Barra de fechas | `components/flit/RangoFechas.tsx` (kit) dentro de `components/torre/BarraFiltrosTorre.tsx` |

## Contrato delta (`packages/shared-types/src/flito-torre.ts` + `flito-torre.esquemas.ts`)

```ts
// TOPES_TORRE (añadir)
TOP_GRUPOS: [5, 10, 20, 50] as const,  TOP_GRUPOS_DEFECTO: 10,   // P-10
export type TopGruposTorre = (typeof TOPES_TORRE.TOP_GRUPOS)[number];

// ConsultaMetrica (añadir)
top?: TopGruposTorre;    // RN-TOR-K4. Ausente = comportamiento de hoy (cruce 50 × 12, simple hasta `limite`)
comparar?: boolean;      // RN-TOR-K1..K3. Ausente/false = sin `anterior`

// ResultadoMetrica (añadir)
anterior?: {
  rango: { desde: string; hasta: string };            // ya resuelto, ambos inclusive
  total: { valor: number; n: number };
  variacion: number | null;                            // del total; null si no hay base (RN-TOR-K3)
  en: 'relativa' | 'puntos';                           // 'puntos' solo si unidad = 'pct'
  filas: { clave: string; valor: number | null; variacion: number | null }[]; // [] con agrupación temporal
};
```
Zod (`consultaMetricaSchema`): `top: z.number().int().refine(v => TOPES_TORRE.TOP_GRUPOS.includes(v))`,
`comparar: z.boolean()`. Dos `.refine` nuevos, con el mismo estilo de mensaje (sin repetir el valor):
`comparar` con métrica de foto da **400** en `path: ['comparar']`; `comparar` con `agrupacionColumnas` da **400**.
`exportarMetricaSchema` hereda los dos campos, porque envuelve `consulta`.

**Clave de caché** (RN-TOR-K6): al objeto `normalizada` se le suman
`top: (c.agrupacionColumnas && modo === 'pantalla') ? (c.top ?? null) : null` y `comparar: c.comparar === true`.
El `top` solo cuenta donde cambia el resultado: un `top` de la agrupación simple o del Excel no parte la caché.
Las entradas viejas (TTL de 60 s) cambian de hash y no se leen nunca.

## Reglas nuevas (cabecera de `flito-torre.metricas.service.ts` y `flito-torre.esquemas.ts`)

- **RN-TOR-K1. Periodo anterior.** `periodoAnterior(r) = { desde: r.desde − d, hasta: r.desde − 1 }`, con
  `d = diasDeRango(r)` (P-8). Es la misma fórmula del tablero Comercial. Se calcula sobre el rango **ya resuelto**:
  «Hoy» 18-nov da 17-nov; «Ayer» da el día anterior; «Este mes» 1–18 nov da **14–31 oct**; «Esta semana» lun–mié
  da vie–dom; «6 meses» 1-jun–18-nov (171 días) da 12-dic-2025–31-may-2026; 1–29 feb-2028 da 3–31 ene. Hereda
  la fecha base de la consulta. No se re-validan los topes, porque la duración es la misma.
- **RN-TOR-K2. Dónde aplica.** Aplica al total y a la agrupación simple **por dimensión**. Con agrupación simple
  **temporal**, `anterior.filas = []` y solo se compara el total, porque las claves (`2026-11` contra `2026-10`) no
  se pueden emparejar sin inventar una alineación por posición. En el cruce no hay comparación (400, P-8). En
  las métricas de foto (`wip_activo`) tampoco (400), porque no hay rango. Es el mismo criterio que RN-TOR-M11.
- **RN-TOR-K3. Variación.** Para unidades `conteo`, `cop` y `horas`: `variacion = r1((actual − anterior) / anterior × 100)`.
  Si la base es 0 o el grupo no existía en el periodo anterior, vale `null` y la UI pinta «Nuevo» o «—», nunca
  «+∞» ni «0 %». Para la unidad `pct` (tasas): `variacion = r1(actual − anterior)` en **puntos**, con `en: 'puntos'`.
  En tiempos se compara la mediana, que es `total.valor` (`excluidos` y `maximo` no se calculan en `anterior`).
  `anterior.filas` trae exactamente las claves de `filas`, en el mismo orden. Un grupo sin registros en el periodo
  anterior lleva `valor: null`.
- **RN-TOR-K4. Top N.** Solo en el **cruce en pantalla**, `top` sustituye al tope del eje de **dimensión**: con
  la dimensión en filas, `topeFilas = min(limite, top, 50)`; con la dimensión en columnas (temporal en filas),
  `topeColumnas = min(top, 12)`; con dos dimensiones, aplica a las filas y las columnas quedan en 12. El resto se
  pliega en «Otros» en el servidor, que es lo único correcto para tasas y medianas. Un eje temporal nunca se
  corta (RN-TOR-C3). En la agrupación simple el servidor **ignora** `top`: la web corta el ranking o la gráfica
  y pliega «Los demás» como hoy, mientras la tabla sigue paginando todos los grupos. **El Excel ignora `top`**
  (2.000 × 100) y `comparar`: `exportarMetrica` llama con `{ ...c, limite: undefined, top: undefined, comparar: undefined }`.
- **RN-TOR-K5 (web). Absoluto o %.** No toca el contrato. En el cruce, la celda vale `celda.valor / columnas[j].valor × 100`,
  así que cada corte suma 100 % porque el marginal incluye «Otros» (P-9). En la agrupación simple se usa
  `participacion`. Solo existe para las unidades aditivas (`conteo`, `cop`): en tasas y tiempos el interruptor
  no se ofrece. El Excel sale siempre en absolutos.
- **RN-TOR-K6.** Clave de caché, como se definió arriba.
- **RN-TOR-W2 (web). Rango visible.** Desde y Hasta están siempre a la vista en las 5 pestañas. Los presets son
  atajos. Lo que muestran los campos es el rango **resuelto por la API** (`res.rango` / `tablero.rango`,
  RN-TOR-F5), no una cuenta de la web. Si se edita un campo, la consulta pasa a `periodo = 'personalizado'`.

## Cómo se calcula `anterior` (`consultarMetrica`)

Va dentro del **mismo** `enTorre(...)`, después del bloque actual y solo si `c.comparar` (ya validado por K2):

1. `ant = periodoAnterior(rango)`. Es un helper nuevo, exportado desde `flito-torre.filtro.ts`, al lado de `mesAnterior`.
2. `condsAnt = [...def.fijas, ...condicionesTorre(c.filtro, alcance, def.dims, { rango: ant, fecha: def.fecha })]`.
   Sigue el constructor único (RN-TOR-F1): mismo alcance y mismos filtros, solo cambia el rango.
   `baseAnt = donde(def.requiere ? [...condsAnt, def.requiere] : condsAnt)`.
3. Total: el mismo `SELECT count(*)::int AS n, ${agregados(def)} FROM ${def.desde} WHERE ${baseAnt}`.
4. Con agrupación por dimensión: el mismo `GROUP BY` de `claveAgrupacion`, sin `ORDER` y con `LIMIT GRUPOS_MAX`.
   El emparejamiento con las claves visibles se hace en JS (`'sin'` ↔ `null`). Cuesta lo mismo que la consulta
   principal y no hay que armar el `IN` con nulos.
5. Hay 2 sentencias más en la misma transacción, cada una con sus 15 s (RN-TOR-M7). El resultado, con `anterior`,
   se guarda en la misma entrada de caché. `conRango` no toca `anterior`.

Para no pasar de 800 líneas ni engordar `consultarMetrica` (293 líneas hoy), los pasos 2–4 y K3 van en un
archivo nuevo, `flito-torre.comparar.ts` (`calcularAnterior(q, def, c, alcance, rango, filas, totalActual)`).

## Corrección de `apps/api/src/shared/utils/fecha-rango.ts` (pedido: «corrígelo aquí»)

Línea 47, el único cambio:
```ts
if (rango.desde) parts.push(sql`${column} >= (${rango.desde}::date::timestamp AT TIME ZONE ${TZ_COLOMBIA})`);
```
La línea 48 ya está bien: `date + interval` da `timestamp`. Se añade al JSDoc el mismo comentario de
`condicionRango` (por qué `date AT TIME ZONE` no sirve) y la precondición: **la columna es `timestamptz`**. Todos
los consumidores de hoy cumplen la precondición. Con una columna `date`, la conversión desplazaría un día.

**Test (nuevo) `apps/api/__tests__/utils/fecha-rango.test.ts`**, con el patrón `describe.skipIf(!URL_BASE)` de
`flito-torre-metricas.test.ts:374`. Para cada zona de sesión en `['UTC', 'America/Bogota']`: `SET LOCAL TimeZone`
en una transacción con ROLLBACK, y luego evaluar `createdInRangeCondition` sobre una tabla temporal con
`timestamptz` y rango 2026-06-01…2026-11-18. Debe dejar fuera 31-may 20:00 Bogotá y 19-nov 00:00 Bogotá, y dentro
1-jun 00:00 y 18-nov 23:59. Más un caso unitario sin base de datos: el SQL del límite `desde` contiene
`::date::timestamp AT TIME ZONE`.

**Consumidores de `createdInRangeCondition`.** El grep acotado a `shared/utils/fecha-rango` en `apps/api/src`
da 37 archivos, y solo 5 usan esta función. Los demás importan `hoyColombia`, `parseFecha*` o `aIso` y no
cambian.

| Consumidor | Columna (`timestamptz`) | Cifra que se mueve |
|---|---|---|
| `finanzas/finanzas.gastos-diarios.ts:105` (`enRango`, reporte Gastos diarios HU #12623) | `flito_soat.pagado_en`, `flito_impuestos.pagado_en`, `flito_tramite_servicios_adicionales.asignado_en`, `flito_tramites.fecha_aprobacion` | Totales por categoría y GMF estimado. Salen los eventos de 14:00–23:59 del día anterior al `desde`, y la serie pierde ese día de más |
| `tramites/tramites.service.ts:83` (legacy `tramites`, lista) | `tramites_digitales.created_at` | Conteo y filas de la lista filtrada por fecha |
| `tramites/embudo.ts:68` (legacy, embudo TRAM-OPS-01) | `tramites_digitales.created_at` | Conteos por etapa del embudo |
| `vehicles/vehicles.routes.ts:153` y `:431` (legacy, lista y export) | `vehicles.created_at` | Vehículos listados y exportados |
| `flito-parametrizacion/flito-tarifas.service.ts:288` (historial de vigencias) | `flito_tarifas_vigencias.vigente_desde` | Vigencias del historial con inicio en ese tramo |

El efecto se ve solo donde la sesión de PostgreSQL **no** está en `America/Bogota` (DEV está en UTC, confirmado
por el humano). Con la sesión en Bogotá, el SQL viejo y el nuevo dan lo mismo. Cambia solo el límite inferior,
y siempre hacia menos: sale la tarde del día anterior que se contaba de más. **Nota:** el `TimeZone` de la
sesión en QA y PDN lo verifica `devops-agent` (`SHOW TimeZone`) para anunciar si allá se mueven cifras. No es
bloqueante. Las expresiones `::date AT TIME ZONE` escritas en línea fuera del helper quedan fuera del alcance
pedido (Nota, sin barrido).

## Frontend (F1, G1, V)

- **F1, la barra.** En `BarraFiltrosTorre.tsx`, el `FlitSelect` «Periodo» y el `RangoFechas` condicional dan paso
  a `RangoFechas` **siempre visible** más una fila de atajos (`RangoAtajosTorre.tsx`, botones del kit,
  `flex-wrap`, el activo con `aria-pressed`): Hoy, Ayer, Últimos 7 días, Este mes, Mes anterior, 6 meses, Este
  año. Con un atajo activo, los campos muestran el rango resuelto que devuelve la API (`PaginaTorre` /
  `useTorre` lo pasan a la barra); mientras carga, muestran el último conocido. Los `m:YYYY-MM` guardados se
  siguen leyendo en `normalizarFiltrosTorre`, pero ya no se ofrecen como atajo. En el Explorador, el selector
  de fecha base (que ya existe en `TorreExplorador.tsx:74`) va pegado a la barra de fechas. Los tableros no lo
  tienen. Nada de esto va en la URL (RN-TOR-W1).
- **G1, el kit.** `components/flit/Graficos.tsx` se usa también en 5 páginas que no son de la Torre (PESV, RNDC,
  RoadIncidents, FlitoTablero, TramitesMetricas), así que el cambio es **opt-in**: una prop `fluido` en
  `LineaTendencia` y `BarrasGrupo`. Con ella, el ancho del `viewBox` se mide con `ResizeObserver` (con 560 como
  respaldo) y vale `max(contenedor, cortes × 32 px)`. Si sobrepasa el contenedor, el SVG va en un envoltorio con
  el scroll horizontal del kit. Las etiquetas se pintan cada `ceil(56 px / px_por_corte)`, lo que reemplaza la
  alternancia `useAnchoAngosto` solo en modo `fluido`. Una prop nueva, `titulosTip?: string[]`, lleva la
  etiqueta larga al tip y al `aria-label`, mientras el eje usa la corta. Las etiquetas cortas («1 jun»,
  «jun 26», «T2 26») salen de `etiquetaCorteTorre(agrupacion, clave)` en `formatoTorre.ts`. **Causa del «solo la
  mitad derecha»:** en `ResultadoExplorador.tsx:121-126`, la gráfica de series cae en la columna `1fr` de la
  rejilla `18rem | 1fr` junto a la KPI. Con eje temporal, la KPI va en su propia fila y la gráfica a todo el
  ancho. Los tableros pasan `fluido` en sus `LineaTendencia` y `BarrasGrupo`.
- **V, solo en el Explorador (P-7).** Un componente nuevo, `OpcionesVistaTorre.tsx`, con «Grupos» (`FlitSelect`
  5/10/20/50, defecto 10, que se manda como `top`), «Ver en» Absoluto o % (oculto en tasas y tiempos) y la
  casilla «Comparar con el periodo anterior» (oculta en la foto y en el cruce). Con `comparar`, la KPI lleva en
  el hint «vs 14–31 oct: +12,3 %» (o «+2,1 pts»), y la tabla simple suma las columnas «Periodo anterior» y
  «Variación». `TablaCruzadaTorre` aplica el modo % (K5). Las líneas de la gráfica son `min(top, 5)`, porque la
  paleta `COLORES` tiene 5; el resto va a «Los demás». En `avisosCruce`, los «50» y «12» fijos pasan a usar el
  tope efectivo.

## Archivos por bloque (en serie: backend y luego frontend)

**Bloque 1, `backend-agent`** (contract-first dentro del bloque):
- M `packages/shared-types/src/flito-torre.ts`: `TOPES_TORRE.TOP_GRUPOS*`, `TopGruposTorre`, `top`, `comparar`, `anterior`. **Compartido**: lo lee el bloque 2
- M `apps/api/src/modules/flito-torre/flito-torre.esquemas.ts`: `top`, `comparar` y 2 refines (K2)
- M `apps/api/src/modules/flito-torre/flito-torre.filtro.ts`: `periodoAnterior()` (K1)
- C `apps/api/src/modules/flito-torre/flito-torre.comparar.ts`: `calcularAnterior` (K1–K3)
- M `apps/api/src/modules/flito-torre/flito-torre.metricas.service.ts`: llamada a `comparar`, clave de caché (K6), cabecera RN-TOR-K*
- M `apps/api/src/modules/flito-torre/flito-torre.cruce.ts`: `topesCruce(modo, limite, top?, ejeDimension)` (K4)
- M `apps/api/src/modules/flito-torre/flito-torre.export.ts`: quita `top` y `comparar` (K4)
- M `apps/api/src/shared/utils/fecha-rango.ts`: línea 47 y JSDoc
- C `apps/api/__tests__/utils/fecha-rango.test.ts`
- M `apps/api/__tests__/services/flito-torre/flito-torre-explorador-contrato.test.ts`, `flito-torre-metricas.test.ts`, `flito-torre-cruce.test.ts`, y el test que hoy cubre `exportarMetrica` (localizarlo con grep `exportar` en `__tests__/services/flito-torre/`)

**Bloque 2, `frontend-agent`** (arranca con el bloque 1 integrado, porque importa los tipos nuevos):
- M `apps/web/src/components/flit/Graficos.tsx`: `fluido`, `titulosTip` y eje automático (G1). **Compartido con 5 páginas que no son de la Torre**: opt-in, sin cambio visual por defecto
- M `apps/web/src/components/torre/BarraFiltrosTorre.tsx`, y C `apps/web/src/components/torre/RangoAtajosTorre.tsx` (F1)
- M `apps/web/src/components/torre/PaginaTorre.tsx`: pasa el rango resuelto a la barra
- M `apps/web/src/lib/torreFiltros.ts`: solo si hace falta para los `m:` heredados. Va en el chunk de `/login`, así que hay que correr `check:bundle`
- M `apps/web/src/components/torre/formatoTorre.ts`: `etiquetaCorteTorre`, y `rangoTorre` sin cambios de semántica
- M `apps/web/src/components/torre/ResultadoExplorador.tsx` (rejilla, columnas de comparación, %), `TablaCruzadaTorre.tsx` (%, top, avisos)
- C `apps/web/src/components/torre/OpcionesVistaTorre.tsx`; M `apps/web/src/pages/torre/TorreExplorador.tsx` (estado y armado de `top` y `comparar`)
- M `apps/web/src/pages/torre/Torre360.tsx`, `TorreComercial.tsx`, `TorreFinanciera.tsx`: `fluido` en sus gráficas (`TorreOperativa` solo usa `Dona`, así que no se toca)
- M `apps/web/e2e/tests/flito-torre-explorador-flexible.spec.ts`, `flito-torre-tableros.spec.ts`

Archivos compartidos entre bloques: solo `packages/shared-types/src/flito-torre.ts`. Lo escribe el bloque 1 y
el bloque 2 solo lo lee. No se toca `src/db/schema/`, `schema.ts`, migraciones, `App.tsx` ni `PageSlug`. Por
eso **db-review: no aplica**. Para security, el disparo lo decide el hilo: no hay PII nueva ni auth nueva, solo
dos campos de consulta validados con enum o booleano.

## Tests P1 por bloque

- **Bloque 1:** `npm run build -w packages/shared-types && npm run test:shared-types` ·
  `npm test -w apps/api -- __tests__/utils/fecha-rango.test.ts __tests__/services/flito-torre/flito-torre-explorador-contrato.test.ts __tests__/services/flito-torre/flito-torre-metricas.test.ts __tests__/services/flito-torre/flito-torre-cruce.test.ts <test de exportarMetrica>` ·
  `NODE_OPTIONS=--max-old-space-size=8192 npm run build:api`. Antes, `grep -rln "AT TIME ZONE" apps/api/__tests__`:
  si el test de algún consumidor (gastos-diarios, tarifas, vehicles, tramites) comprueba el texto del SQL, se suma a la lista.
  Casos mínimos: K1 (hoy, este mes → 14–31 oct, 6 meses, cambio de año, bisiesto); K2 (400 en foto y en cruce;
  temporal con `filas: []`); K3 (base 0 da `null`; tasa en puntos; grupo nuevo con `valor: null`); K4 (top 5
  acota filas, dimensión en columnas da `min(top, 12)`, el eje temporal no se corta, el Excel ignora `top`); K6
  (con y sin `comparar`, claves distintas; `top` en la agrupación simple, misma clave); fecha-rango en las dos zonas.
- **Bloque 2:** `npm run typecheck -w apps/web` · `npm run check:bundle` (si se tocó `torreFiltros.ts`) ·
  `npx playwright test e2e/tests/flito-torre-explorador-flexible.spec.ts e2e/tests/flito-torre-tableros.spec.ts`.
  Debe cubrir: Desde y Hasta visibles en las 5 pestañas; un atajo los llena con el rango de la respuesta; editar
  un campo da «personalizado»; compañía × semana en 6 meses con el eje sin encimarse (etiquetas visibles
  espaciadas) y la gráfica al ancho de la tarjeta; Top 5 da 5 filas más «Otros»; el % suma 100 por columna; la
  comparación muestra el periodo y la variación.

## ADR: no aplica

Es una extensión aditiva de ADR-0044: los mismos endpoints, sin tabla nueva y sin contrato que rompa. Las
reglas nuevas viven en las cabeceras del módulo (RN-TOR-K1…K6, W2) y en este documento.
`contrato:generar` regenera `contracts/openapi/flito-api.v1.yaml` con los campos nuevos.

## Notas (no bloqueantes; el default se mantiene)

1. **P-8 con «Este mes».** 1–18 nov se compara con 14–31 oct, como fijó el hilo. El Resumen 360° (ejecutivo) ya
   compara contra el **mes calendario anterior** (`mesAnterior`). Son dos nociones de «anterior» en la misma
   Torre, pero no se tocan porque P-7 deja los tableros sin comparación. «Esta semana» en lunes compara 1 día
   contra el domingo, un efecto de estacionalidad que conviene decir en el copy del hint.
2. **K2 temporal.** P-8 dice «agrupación simple». Por diseño la limito a dimensión porque las claves temporales
   no se emparejan. Si producto quiere la serie anterior superpuesta (línea punteada), es un cambio aditivo
   posterior: alinear por índice de corte.
3. **K4.** Top 20 y 50 con la dimensión en columnas quedan en 12, por el ancho de la tabla en pantalla.
   `OpcionesVistaTorre` lo avisa en línea.
4. **Gate UX.** Por la matriz, la barra F1 y los controles V son una extensión de pantalla, así que va `ux-agent`
   slim con maqueta y el «ok» humano antes del bloque 2, salvo que el hilo dé por cubierta la decisión de la
   sesión de evidencias.

## Preguntas abiertas

Ninguna bloqueante. Las decisiones de producto (F1, G1, V, P-7…P-10) cubren todo lo que cambia el comportamiento.
