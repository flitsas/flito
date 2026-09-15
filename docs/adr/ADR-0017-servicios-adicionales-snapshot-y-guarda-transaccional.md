# ADR-0017 — Servicios adicionales por trámite: puente viva con snapshot, sello en la liquidación (columna + `detalle` jsonb), serialización por `FOR UPDATE` del trámite y módulo de rutas propio

## Estado

**Propuesto** — 2026-09-14. Autor: architecture-agent. Feature [#12544](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12544) (épica #12246), HUs #12545 → #12548. Pendiente de aprobación del Líder Técnico (David Chica).

Diseño detallado: [`docs/diseno-feature-12544-servicios-adicionales-por-tramite.md`](../diseno-feature-12544-servicios-adicionales-por-tramite.md).

## Contexto medido (worktree `flito-serv-adic`, develop `e61b6dfe`)

- La liquidación (`flito-liquidacion.service.ts`) sella cinco conceptos como **columna `valor_*` + entrada en `detalle` jsonb**; `reversar()` borra la fila y deja `{...detalle, total}` en `flito_liquidacion_eventos`; `aDto()` lee `detalle[k] ?? columna`. Siigo decide qué conceptos aplican leyendo las columnas (`conceptosAplicables` sobre `ValoresLiquidacion`), y el reporte de costos elige `CASE WHEN liq.id IS NOT NULL THEN columna ELSE estimado END`.
- El Feature #12540 dejó el catálogo `flito_servicios_adicionales_tipos` con baja lógica y valor editable: un trámite tiene que **congelar** nombre/descripción/valor al asignar (CF-03) y otra vez al sellar (CF-07).
- `liquidar()` calcula **fuera** de su transacción y sella dentro. Una asignación que entre entre la lectura y el `COMMIT` del sello deja una liquidación que no la incluye y una fila puente que ya no se puede quitar (409). El repo serializa carreras así con `SELECT … FOR UPDATE` sobre la fila padre (`flito-comparendos.gestion.service.ts:160`, `flito-bolsas.service.ts:234`).
- Permisos: `finanzas/` es un directorio **vallado** (`permisos.valla-legacy.test.ts`: `finanzas: 1`, prohibido importar `exigir-funcion.js`), no está en `FICHEROS_EN_ALCANCE`, y el cierre de la reconducción (`permisos.reconduccion-cierre.test.ts`) exige cero `requireRole(` en todo directorio en alcance. Una función sembrada que el catálogo no monte hace que `verificarCatalogoAlArrancar` **impida arrancar el API**. No existe la figura «fichero mixto».

## Decisión

### 1. La asignación es una fila VIVA con snapshot; el sello es columna + `detalle`, sin tabla hija

- `flito_tramite_servicios_adicionales (id, tramite_id → flito_tramites CASCADE, tipo_id → tipos RESTRICT, nombre, descripcion, valor, asignado_por_id → users RESTRICT, asignado_en; UNIQUE (tramite_id, tipo_id); índice por tramite_id; CHECK valor >= 0)`. Se borra físicamente al quitar: mientras el trámite no está liquidado ninguna liquidación la referencia.
- `flito_liquidaciones.valor_servicios_adicionales numeric(14,2) NULL` (`NULL` = ninguno / sellada antes) + `detalle.serviciosAdicionales = { valor, origen, bloquea, items: [{ tipoId, nombre, valor }] }`. Es el **mismo patrón** de los otros cinco conceptos, así que `aDto`, `reversar`, la elegibilidad y la compuerta de Siigo y el reporte lo absorben sin joins nuevos. La factura lee `items` del jsonb y valida `Σ items.valor == columna` antes de armar (`servicios_no_cuadran`).
- Sexto `ConceptoLiquidado` `serviciosAdicionales`: `valor: null` sin servicios, nunca bloquea, entra en `baseGmf` por `sumar()`.

### 2. La guarda «trámite liquidado» se serializa con `FOR UPDATE` sobre `flito_tramites`

`asignar`, `quitar` y `liquidar` abren transacción, toman `SELECT id FROM flito_tramites WHERE id = $1 FOR UPDATE` y **después** comprueban/leen: asignar y quitar comprueban `flito_liquidaciones`; `liquidar` lee la puente y recompone base/GMF/total con una función pura (`conServiciosAdicionales`) antes de insertar. La fila del trámite siempre existe (la de liquidación es justo lo que se está creando o no), y el sync la actualiza en transacciones por trámite, así que la espera es de milisegundos.

### 3. Las rutas nuevas viven en un módulo propio reconducido, no en `finanzas/`

`apps/api/src/modules/finanzas-servicios-adicionales/` (routes + service), montado en `/api/finanzas` desde `app.ts`, con GET/POST/DELETE por `exigirFuncion` y **tres** funciones: `finanzas.servicios_adicionales.ver` (admin, financiera, auditor), `.asignar` y `.quitar` (admin, financiera). El directorio entra en `DIRECTORIOS_RECONDUCIDOS` y su fichero en `FICHEROS_EN_ALCANCE` con `modulo: 'finanzas'`. `finanzas/finanzas.routes.ts` y la valla no se tocan.

**Regla que sienta precedente:** cuando una HU añade operaciones a un directorio vallado, se crea un módulo hermano reconducido en lugar de reconducir «de paso» el directorio o de partir el recurso entre dos modelos de guarda. Reconducir el directorio vallado sigue siendo una decisión de producto aparte.

## Alternativas consideradas

| Alternativa | Por qué no |
|---|---|
| **Tabla hija de la liquidación** para la lista sellada | La columna `valor_*` haría falta igual (Siigo/ reporte); el reverso borra la liquidación y arrastraría la hija, que el snapshot del evento tendría que reconstruir; un join más en `cargarTramites`; dos verdades que pueden descuadrar. |
| **Sin columna**, congelar marcando filas de la puente (`sellado_en`) | Prohíbe el DELETE físico (CF-04), obliga a `UPDATE` masivos al sellar/reversar y hace que lo «sellado» se recalcule desde filas vivas. |
| **`pg_advisory_xact_lock`** en vez de `FOR UPDATE` | Patrón inexistente en el repo; invisible en el esquema; el mock no lo conoce. Queda como plan B si el sync pasara a transacciones largas. |
| **Solo comprobar dentro de la transacción**, sin bloqueo | READ COMMITTED no serializa dos lecturas: la carrera «asignar entre la lectura del sello y su COMMIT» sigue abierta. |
| **GET en `finanzas.routes.ts` bajo `LECTURA`** + escrituras en módulo nuevo (literal de AC2/AC3) | Un recurso partido en dos directorios y dos modelos de permiso; el «solo lectura» del auditor no aparece en el panel de roles; si mañana se reconduce finanzas, el GET se muda otra vez. |
| **Reconducir `finanzas/` entero** en la HU 1 | Acopla el Feature a una decisión de producto que la valla exige explícita; +7 funciones y +21 filas de reparto sin relación con el Feature. |
| **LEFT JOIN agregado / LATERAL** en el reporte | Modifica `conJoins`, compartido por conteo, página, totales, export, consolidado y la elegibilidad Siigo; la subconsulta correlacionada es el patrón del módulo y no multiplica filas. |

## Consecuencias

- **Desvío declarado de los AC de la HU #12545**: tres funciones y GET por el motor (AC2/AC3 hablaban de dos funciones y de reutilizar `LECTURA`). La intención —auditor lee, cliente 403, admin/financiera escriben— se conserva y la prueba de paridad la fija.
- `liquidar()` pasa a leer la puente **dentro** de su transacción; `salidasDe()` se calcula ahí. Los specs que mockean `transaction: vi.fn()` y ejercen `liquidar` necesitan ejecutar el callback (`mockImplementation(async (fn) => fn(tx))`).
- `finanzas.service.ts` crece ≈12 líneas; las expresiones nuevas viven en `finanzas.servicios-adicionales.expr.ts` (leaf, dueño de `SE_LIQUIDO`).
- Contadores de los tests de permisos: 21 directorios, 24 ficheros, 247 montajes.
- **Abierto (no lo cubre ningún AC)**: la bolsa del cliente no descontaría los servicios aunque sí el GMF calculado sobre ellos. Recomendación: salida `servicios_adicionales` (suma, llave `tramite:{id}:servicios_adicionales`) en la HU 2; no requiere migración (sin CHECK en `flito_bolsa_movimientos.concepto`). Decisión humana.

## Cómo verificar que quedó como dice este ADR

```bash
# 1. Puente y columna
grep -n "flito_tramite_servicios_adicionales\|UNIQUE (tramite_id, tipo_id)" apps/api/src/db/migrations/0193_*.sql
grep -n "valor_servicios_adicionales" apps/api/src/db/migrations/0194_*.sql apps/api/src/db/schema.ts
# 2. FOR UPDATE antes de leer la puente / comprobar la liquidación
grep -n "for('update')" apps/api/src/modules/finanzas-servicios-adicionales/*.service.ts apps/api/src/modules/flito-liquidacion/flito-liquidacion.service.ts
# 3. finanzas/ sigue vallado; el módulo nuevo está reconducido
grep -c "requireRole(" apps/api/src/modules/finanzas/*.ts            # suma == 1
grep -rn "exigir-funcion" apps/api/src/modules/finanzas/               # vacío
grep -n "finanzas-servicios-adicionales" apps/api/src/modules/permisos/inventario-guardas.ts apps/api/__tests__/services/permisos.reconduccion-cierre.test.ts
npx vitest run apps/api/__tests__/services/permisos*.test.ts
```

## Notas operativas por agente

- **backend-agent**: migración + schema + catálogo + foto + fixture + tests de cierre en el mismo commit (el arranque compara base y código). Tuplas de la semilla con `npm run permisos:seed -w apps/api`.
- **db-review-agent**: FKs con cláusula explícita (ADR-0005), `IF NOT EXISTS`, sin backfill en 0194, `ON CONFLICT DO NOTHING` en 0195.
- **qa-agent**: mutantes nombrados en el diseño (quitar la guarda de liquidado; leer el valor por join; quitar el sumando de `baseGmf`/`totalServicio`; quitar el bucle de líneas; leer la puente con `db` en vez de `tx`).

## Relación con otros ADR

- ADR-0005 (FK a `users`): `asignado_por_id` RESTRICT, en pareja con `asignado_en`.
- ADR-0014 / ADR-0016 §2 (motor de permisos, `exigirFuncion` a nivel de ruta): el módulo nuevo nace reconducido; ninguna guarda a nivel de router.
- ADR-DB-001 (migraciones sin `BEGIN/COMMIT`).
