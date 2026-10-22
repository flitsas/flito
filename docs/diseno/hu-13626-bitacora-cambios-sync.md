# Diseño slim — HU #13626 · Bitácora de trámites creados o cambiados por FLIT 1 y FLIT 2

Feature #13611 · Épica #13576 · módulo FLITO `flito-sync` (no el legacy). Decisiones de David del
2026-10-16: `audit_logs` con `detail` en texto, sin migración, sin tipo «eliminación», la placa cuenta como PII,
y el vehículo y su titular (`upsertVehiculo`) quedan fuera.

## Patrón reutilizado

- Escritura de audit del sistema dentro de la tx del trámite: `auditSistema(tx, …)` en
  `apps/api/src/modules/flito-sync/flito-sync.service.ts` (`userId: null`, `userEmail: 'sistema'`).
  Hoy `escribirTramite` ya la llama con el `tx` («Estado FLIT: …»). **No** se usa
  `shared/middleware/audit.ts`, porque exige `req` y el sync no tiene request.
- Comparación de compradores contra los guardados en la misma tx: `escribirCompradoresFlit2` + `huella`
  + `pct` en `flit2-lectura.service.ts` (RN-14/RN-16). FLIT 1 copia ese mismo patrón.
- Formateador puro y exportable, probado sin BD: `detalleAuditoriaInterruptor`
  (`flito-sync-interruptor.service.ts`).

## Contrato delta

Cada trámite deja como máximo una fila en `audit_logs` por escritura (por transacción de `sincronizarUno` o de `aplicarItem`):
`resource='flito_tramite'`, `resourceId=<flito_tramites.id>`, `action='create'` (creación) o `'update'`, `userEmail='sistema'`.

`detail` = `[<fuente>] <tipo> · radicado <radicado> · <diferencias> · aplicado`

| Tipo | Ejemplo exacto |
|---|---|
| creación (AC4) | `[FLIT 1] creación · radicado 2026-000123 · aplicado` |
| cambio de estado (AC1) | `[FLIT 1] cambio de estado · radicado 2026-000123 · estado: Asignado → Aprobado · aplicado` |
| cambio de datos, PII (AC2) | `[FLIT 2] cambio de datos · radicado R-5512 · cambió celular (comprador 1); cambió placa · aplicado` |
| cambio de datos, no PII (AC3) | `[FLIT 2] cambio de datos · radicado R-5512 · ciudad: Medellín → Bogotá · aplicado` |
| combinado | `[FLIT 1] cambio de estado · radicado … · estado: Asignado → Aprobado; ciudad: Medellín → Bogotá; cambió correo (comprador 2) · aplicado` |

- El tipo es `cambio de estado` si `flit_estado` cambió (aunque cambien otros campos también), y `cambio de datos` en el resto de casos. Los null se escriben como `—`.
- Orden fijo: estado → campos del trámite (orden de la tabla de abajo) → placa → compradores por `orden`.
- Sin diferencias en una actualización, la función devuelve `null` y no se inserta nada (AC5/AC6: `sincronizadoEn`, `flitRaw`,
  `syncVersion`, `flit2PiiEnmascarada`, `processStatus` y el resto de columnas no se comparan).

**Campos comparados (lista cerrada):**

| Clave | Etiqueta | PII |
|---|---|---|
| `flit_estado` | estado | no |
| `factura_venta_flit_id` | factura | no |
| `fecha_aprobacion` | fecha de aprobación | no |
| `compania_id` | compañía | no |
| `organismo_codigo` | organismo | no |
| `tipo_tramite` | tipo de trámite | no |
| `ciudad` | ciudad | no |
| `plate_complete` | placa | **sí** |
| comprador `numeroDocumento` / `nombreCompleto` / `correo` / `celular` / `direccion` | documento / nombre / correo / celular / dirección | **sí** |
| comprador `porcentajeParticipacion` | participación (comprador N) | no |
| número de compradores | `compradores: 1 → 2` | no (solo el conteo) |

Los compradores se emparejan por `orden`. `comprador N` es `orden + 1`. Un comprador que entra o sale solo se refleja en el conteo:
nunca se escriben sus datos.

## Diseño

### `bitacora-sync.ts` (archivo nuevo, una sola función común, AC7)

`apps/api/src/modules/flito-sync/bitacora-sync.ts`, sin importar de `flito-sync.service.ts` para no crear un ciclo:

- `CAMPOS_TRAMITE_BITACORA` (las 7 claves de la tabla más `plate_complete`, con su etiqueta) y `CAMPOS_PII`, que es un `Set`
  exportado para que el test lo fije.
- `vistaTramite(fila | valores): Record<string, string | null>`: la misma normalización que hoy hace
  `escribirTramite` (`fechaIso`, `String(companiaId)`) más `plate_complete`. Se usa para alimentar
  `registrarDiferencias` (con las 7 claves de siempre, sin `plate_complete`: AC8) y para la bitácora.
- `diferenciasTramite(antes, despues): Diferencia[]`
- `diferenciasCompradores(guardados, nuevos): Diferencia[]`, que normaliza igual que `huella`
  (`pct()` para el numeric `'60.00'` frente a `60`, y `null` frente a `''`), para no dejar un falso «cambió» en cada corrida.
- `detalleBitacora({ fuente, radicado, esNuevo, diferencias }): string | null`. Es el **único** formateador y no recibe valores de
  los campos PII: las diferencias PII llevan solo `campo` y `comprador`. El valor no llega al formateador, así que no puede filtrarse.
- `registrarBitacoraSync(tx, { fuente, radicado, tramiteId, esNuevo, diferencias })`: llama a `detalleBitacora`. Si devuelve
  `null`, retorna sin escribir. Si no, hace un `insert(auditLogs)` con el `tx` recibido, con la misma forma que `auditSistema`.

### FLIT 1 (`flito-sync.service.ts`)

1. `escribirTramite` deja de escribir el audit «Estado FLIT: …» (AC1: lo reemplaza la nueva entrada, no se duplica). Construye
   `antes` y `despues` con `vistaTramite`, llama a `registrarDiferencias` con las mismas 7 claves (sin cambios en esa función ni
   en el historial) y devuelve además `diferencias: diferenciasTramite(antes, despues)`. Si `!existente`, devuelve `[]`.
   `huboCambios` mantiene su semántica actual.
2. `upsertTramite`: si `!esNuevo`, antes de `reemplazarCompradores` lee los guardados **en el mismo `tx`**, con la misma
   proyección que `escribirCompradoresFlit2` (orden, documento, nombre, correo, celular, dirección, porcentaje). Después reemplaza,
   como hoy, y al final llama
   `registrarBitacoraSync(tx, { fuente: 'FLIT 1', radicado: tf.idFlit, tramiteId: row.id, esNuevo, diferencias: [...dTramite, ...diferenciasCompradores(guardados, nuevos)] })`.
3. `reemplazarCompradores` no cambia. `sincronizarUno` y `upsertVehiculo(..., { soloAlta: anulado })` tampoco se tocan (Bug #13585).

### FLIT 2 (`flit2-lectura.service.ts`)

1. `escribirCompradoresFlit2` devuelve además `diferencias: Diferencia[]`. Si `cambiaron`, son
   `diferenciasCompradores(guardados, nuevos)`; si no, `[]`. RN-15, RN-16 y RN-19 quedan igual: con la PII enmascarada no hay
   compradores nuevos y no hay diferencias.
2. En `aplicarItem`, después de `escribirCompradoresFlit2` y antes del arranque, se llama
   `registrarBitacoraSync(tx, { fuente: 'FLIT 2', radicado: it.radicado, tramiteId: row.id, esNuevo, diferencias: [...dTramite, ...dCompradores] })`.
   Los ítems eliminados, en conflicto, sin vehículo o con versión ≤ guardada salen antes y no dejan entrada.
3. AC5: se retiran `debeAuditarse`, `detalleAuditoria` y `auditarLecturaProgramada`, el import de `auditLogs` si queda sin uso,
   y la cabecera RN-13 se reescribe así: «la corrida no se audita; cada trámite creado o cambiado deja su entrada (HU #13626)».
   También se quitan sus llamadas en `flito-sync.cron.ts:64` y `flit2-lectura-acceso.ts:32`, junto con sus imports y comentarios.
   Hay que revisar `npx eslint` por imports sin uso.
4. El archivo tiene 700 líneas en bruto (muchas son comentarios) y pierde unas 30 netas, así que no hay riesgo de max-lines 800.

### Transacción

El audit va **dentro** del `tx` de su trámite: `db.transaction` por trámite en FLIT 1 (`sincronizar`) y por página en FLIT 2.
Ya es así hoy para «Estado FLIT», `flito_soat` y `flito_impuesto`. Si falla la escritura del trámite, de los compradores o del
audit, se revierte todo junto. Es coherente: no puede haber una bitácora de algo que no quedó, ni un cambio sin su entrada.

## Archivos a crear/modificar

| Archivo | Cambio |
|---|---|
| `apps/api/src/modules/flito-sync/bitacora-sync.ts` | **nuevo**: formateador, diferencias, clasificación PII, `registrarBitacoraSync` |
| `apps/api/src/modules/flito-sync/flito-sync.service.ts` | `escribirTramite` (quita «Estado FLIT», devuelve `diferencias`) y `upsertTramite` (lee compradores, llama a la bitácora); cabecera con la nueva regla |
| `apps/api/src/modules/flito-sync/flit2-lectura.service.ts` | `escribirCompradoresFlit2` devuelve diferencias; `aplicarItem` llama a la bitácora; se retira RN-13 y sus 3 exports |
| `apps/api/src/modules/flito-sync/flito-sync.cron.ts` | quitar `auditarLecturaProgramada` |
| `apps/api/src/modules/flito-sync/flit2-lectura-acceso.ts` | quitar `auditarLecturaProgramada` |
| `apps/api/__tests__/services/flito-sync.bitacora-sync.test.ts` | **nuevo**, puro: AC2, AC3, AC4, AC6 y AC7 (misma salida para las dos fuentes salvo la etiqueta), y que el `detail` no contiene ningún valor PII sembrado |
| `apps/api/__tests__/services/flito-sync.bitacora-flit1.test.ts` | **nuevo** (keyed-db): FLIT 1 AC1 (una entrada, sin «Estado FLIT»), AC2 (compradores leídos antes del reemplazo), AC4 (creación) |
| `apps/api/__tests__/services/flito-sync.flit2-lectura.test.ts` | TC-16 aserta el `detail`; nuevo AC2 FLIT 2 (celular); AC5 con 566 ítems sin cambios y 0 filas `audit_logs`; AC6 (solo `raw` o versión cambia → 0); se retira el bloque `auditarLecturaProgramada` (~l. 970-1000 y l. 1375); en l. 1055, `['flito_impuesto','flito_soat','flito_tramite']` |
| `apps/api/__tests__/services/flito-sync.flit2-cron.test.ts`, `flito-sync.flit2-acceso-lectura.routes.test.ts` | quitar el mock y los `expect` de `auditarMock` |
| `apps/api/__tests__/services/flito-sync.anulado-vehiculo-bug13585.test.ts` y el bloque «Bug #13585 · RN-26» de `flit2-lectura.test.ts` | **se corren sin editar** (invariante `soloAlta`). Si un conteo de inserts en `audit_logs` cambia, solo se ajusta ese conteo y se declara |

P1: `npm test -w apps/api -- __tests__/services/flito-sync.bitacora-sync.test.ts __tests__/services/flito-sync.bitacora-flit1.test.ts __tests__/services/flito-sync.flit2-lectura.test.ts __tests__/services/flito-sync.flit2-cron.test.ts __tests__/services/flito-sync.flit2-acceso-lectura.routes.test.ts __tests__/services/flito-sync.anulado-vehiculo-bug13585.test.ts __tests__/services/flito-sync.test.ts __tests__/services/flito-sync.fuente.test.ts`.
Antes del PR: `grep -ln "auditLogs\|Estado FLIT\|flito_sincronizacion_flit2" apps/api/__tests__/services/flito-sync*` (memoria «P1 no ve tests que vigilan lo quitado»).

## ADR: no aplica

Extiende el audit del sistema que ya existe en `flito-sync`. No hay tabla, columna, endpoint ni dependencia nueva, y la UI de Bitácora no cambia.

## Notas operativas (backend)

- **keyed-db (`__tests__/helpers/keyed-db.ts`)**: la nueva lectura de `flito_compradores` en FLIT 1 necesita un `when` explícito
  en los tests de FLIT 1. Además, la memoria «Mock chain inventa columnas» advierte que el mock devuelve la fila entera e ignora la
  proyección: hay que asertar sobre el `detail` insertado (espía de `.values()` de `audit_logs`), no sobre lo que devuelve el select.
  `transaction` ya ejecuta el callback con el mismo `db` (no es un «stub pelado»), pero si algún test usa `{ transaction: 'manual' }`,
  la llamada del audit queda fuera de la tx simulada: hay que revisarlo en `flito-sync.test.ts`.
- **memDb de `flit2-lectura.test.ts`**: evalúa el WHERE, así que las aserciones de `filas(S.auditLogs)` sí son reales. TC-16 ya
  espera 1 fila, que pasa de «Estado FLIT» a la nueva, y el test de PII de l. 1376 queda como guardia AC2 sin cambios.
- Un mutante útil para QA es quitar el `CAMPOS_PII.has` en `detalleBitacora`: el test puro de PII debe caer.
- `security-agent` **aplica** (PII en `audit_logs`). `db-review-agent` no aplica (sin `schema.ts` ni migraciones).

## Riesgos abiertos

1. **Combinado estado + datos**: el diseño usa el tipo «cambio de estado» y lista también los datos. Fue una elección del agente,
   no una decisión de David. Que lo confirme o lo corrija; no bloquea la implementación.
2. **Placa sin historial**: `plate_complete` entra en la bitácora pero no en `registrarDiferencias` (AC8) ni en `huboCambios`.
   Un cambio que solo toque la placa deja una entrada en la bitácora y en los contadores cuenta como «sin cambios». Se acepta para
   no tocar AC8 y se declara como Nota en el PR.
3. **Ruido de FLIT 1**: FLIT 1 relee todo el rango en cada corrida. Si la normalización de compradores (porcentaje numeric/number,
   `''`/`null`) no es idéntica a la escritura, quedaría un «cambió …» en cada corrida. El test de FLIT 1 debe cubrir «mismo
   comprador releído → 0 entradas».
4. **Volumen**: la primera corrida de FLIT 2 o de FLIT 1 sobre la BD vacía deja una «creación» por trámite, cientos de filas en
   `audit_logs`. Es el comportamiento pedido (AC4) y se declara.
