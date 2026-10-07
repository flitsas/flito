# Diseño slim — HU #13410: borrados pendientes del almacenamiento (documentos adicionales SOAT)

- **Work item:** HU #13410 (BACKEND) · Feature #13408 · Épica #13201
- **Módulo:** `flito-soat` (FLITO, montado en `/api/flito/soat`). No toca el legacy `soat`.
- **Rama:** `HU/13410-davidchica-borrados-pendientes-storage-soat`, apilada sobre HU #13409 (`d15f5e77`), base `develop` `29d3461e`.
- **Estado:** Propuesto (diseño; no es ADR).
- **Modo:** slim — extiende el borrado de la HU #13364 y copia el patrón del cron de la HU #13409. La tabla es nueva, pero no hay contrato HTTP nuevo ni tradeoff abierto: Security ya fijó la opción (tabla escrita en la misma transacción que el DELETE; la conciliación del prefijo del bucket queda descartada).

## Patrón reutilizado

| Pieza | Vecino que se copia |
|---|---|
| Borrado con reintento + log `objeto_huerfano` con `claveHash` | `apps/api/src/modules/flito-soat/flito-soat-documentos.service.ts` (`borrarObjetoConReintento`, `eliminarDocumentoAdicional`, HU #13364) |
| Cron con puerta positiva, `withLock`, `enVuelo`, lote, logs sin PII, `start/stop` | `apps/api/src/modules/flito-soat/flito-soat-retencion.cron.ts` + `flito-soat-retencion.service.ts` (HU #13409) |
| Bitácora de sistema (`userId: null`, `userEmail: 'sistema'`, `action: 'delete'`, `resource` = código del evento) | `purgarIncompleta` en `flito-soat-retencion.service.ts` |
| «El objeto no existe» = borrado; error solo por `code`/`name` | `esObjetoInexistente` / `nombreDeError` de `flito-soat-retencion.service.ts` |
| Gauge de prom-client | `pesvEvidenciaUploadInflight` en `apps/api/src/shared/metrics.ts` |
| Migración SQL a mano, idempotente, sin BEGIN/COMMIT, con test de migración | `0224_flito_soat_incompletas_archivos_purgados_en.sql` + `__tests__/services/flito-soat-migracion-0224-archivos-purgados.test.ts` |
| Tabla Drizzle fuera de `schema.ts` (techo de max-lines) y re-exportada | `apps/api/src/db/schema/flito-soat-incompletas.ts` |

Sin dependencias nuevas.

## Decisiones

### D1 — Tabla `flito_storage_borrados_pendientes` (migración `0225`)

Numeración: `origin/develop` llega a `0223`; esta rama trae `0224` (HU #13409). Siguiente número libre: **`0225_flito_storage_borrados_pendientes.sql`**. Si `develop` recibe otra `0225` antes del merge, se renumera **antes** de aplicarla en cualquier ambiente.

```sql
CREATE TABLE IF NOT EXISTS flito_storage_borrados_pendientes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key       text        NOT NULL,           -- PII (NIT de la carpeta + nombre de archivo): SOLO aquí
  origen            varchar(50) NOT NULL,           -- 'soat.documento_adicional'
  intentos          integer     NOT NULL DEFAULT 0 CHECK (intentos >= 0),
  ultimo_intento_en timestamptz,
  ultimo_error      varchar(100),                   -- code/name del error, NUNCA el mensaje
  creado_en         timestamptz NOT NULL DEFAULT now(),
  resuelto_en       timestamptz,
  motivo_cierre     varchar(20) CHECK (motivo_cierre IN ('borrado','inexistente','referenciada')),
  ultima_alerta_en  timestamptz,
  CONSTRAINT ck_flito_storage_borrados_pendientes_cierre
    CHECK ((resuelto_en IS NULL) = (motivo_cierre IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_flito_storage_borrados_pendientes_abiertos
  ON flito_storage_borrados_pendientes (creado_en)
  WHERE resuelto_en IS NULL;
```

- Más `COMMENT ON TABLE/COLUMN` (sobre todo en `storage_key`: «PII; nunca a logs ni Bitácora») y el bloque `DO $$ … RAISE EXCEPTION` de verificación que usan `0210`/`0224`. `0210` no lleva `GRANT`: no se añade.
- Para el CHECK con nombre se usa `DO $$ … IF NOT EXISTS (SELECT 1 FROM pg_constraint …)` solo si se separa del `CREATE TABLE`; dentro del `CREATE TABLE IF NOT EXISTS` ya es idempotente.
- Nombre **genérico** (`flito_storage_…`) con `origen`: hoy solo escribe `soat.documento_adicional`; otro módulo podrá reutilizarla sin migrar. No se generaliza nada más en esta HU.
- **¿`storage_key` único entre abiertos? No.** Un índice único parcial haría fallar el INSERT dentro de la transacción del DELETE (y con él el borrado del documento que pidió el usuario) si quedara un pendiente abierto con la misma clave, y no aporta nada: un segundo pendiente de la misma clave se cierra solo como `inexistente` en la corrida siguiente. Las claves de los adicionales son únicas por subida, así que en la práctica no se repiten.
- Índice parcial sobre `creado_en`: el cron lee solo abiertos ordenados por antigüedad, y el umbral de 72 h también usa `creado_en`. Los resueltos salen del índice.
- **Retención de las filas resueltas:** se conservan como constancia. **Corregido en D8:** `storage_key` es nullable, se vacía en el UPDATE de cierre y queda `clave_hash`; el SQL de arriba es el del diseño original, el definitivo está en `0225`.

Drizzle: nuevo `apps/api/src/db/schema/flito-storage-borrados-pendientes.ts` (`flitoStorageBorradosPendientes`), re-exportado desde `schema.ts` igual que `flitoSoatIncompletas` (una línea de import/export: `schema.ts` está en su techo de max-lines).

### D2 — Inserción en la misma transacción que el DELETE (AC1, AC2)

`eliminarDocumentoAdicional` pasa a:

1. `buscarConAcceso` igual que hoy (404 si no hay acceso).
2. `db.transaction(tx => …)`: `tx.delete(flitoSoportes)…returning(...)`. Sin fila → la transacción devuelve `null` (se lanza el 404 fuera, sin insertar nada). Con fila → `tx.insert(flitoStorageBorradosPendientes).values({ storageKey, origen: ORIGEN_ADICIONAL_SOAT }).returning({ id })`. Commit: la fila del soporte se borró **y** el pendiente existe; si el proceso muere después, el pendiente sigue (AC1).
3. Fuera de la transacción: `borrarObjetoConReintento(fila.id, storageKey, esperas)`.
4. Se cierra el ciclo del pendiente con un `UPDATE … WHERE id = $pendienteId AND resuelto_en IS NULL`:
   - éxito → `resuelto_en = now()`, `motivo_cierre = 'borrado'` (o `'inexistente'` si el storage dijo NoSuchKey), `intentos`, `ultimo_intento_en`;
   - 3 fallos → `intentos = 3` (`esperas.length`), `ultimo_intento_en = now()`, `ultimo_error = <code|name>`; sigue abierto (AC2).
   Ese UPDATE va en `try/catch`: si falla, se loguea `{ evento: 'soat.storage.borrado_pendiente_no_actualizado', pendienteId, err: <name> }` y **no** se lanza. El pendiente queda abierto con `intentos = 0` y el cron lo resuelve (si el objeto ya se borró, como `inexistente`). La respuesta al usuario no cambia (AC2).
5. Sin Bitácora nueva en el camino inmediato: la ruta de la HU #13364 ya registra la eliminación. AC3 pide Bitácora solo en la resolución por cron.

Cambio de contrato interno: `borrarObjetoConReintento` devuelve `{ borrado: boolean; motivo: 'borrado' | 'inexistente' | null; intentos: number; error: string | null }` en vez de `boolean`. Además, `esObjetoInexistente` cuenta como éxito en el primer intento (hoy reintentaría un NoSuchKey). El log `soat.adicional.objeto_huerfano` se queda **exactamente** como está (`soporteId` + `claveHash`, AC2). `objetoPendiente` de `AdicionalEliminado` = `!borrado`. Hay que ajustar sus tests en `flito-soat-documentos.service.test.ts`.

Helpers compartidos: `esObjetoInexistente` y `huellaClave` se **mueven** a `apps/api/src/services/storage.ts` (exportados), porque los usan documentos, retención, el nuevo cron y el propio `deleteEntityDocument` (D6). `flito-soat-retencion.service.ts` los re-exporta (`export { esObjetoInexistente, huellaClave } from '../../services/storage.js'`) para no tocar sus tests. `nombreDeError` (code/name) se exporta desde `storage.ts` con el mismo criterio, o se duplica si el backend prefiere no tocar más la retención. Con eso se evita que documentos dependa de retención.

### D3 — Cron propio, horario (AC3, AC4, AC8)

**Cron nuevo** `flito-soat-borrados-pendientes.cron.ts` + servicio `flito-soat-borrados-pendientes.service.ts`, en vez de colgarlo de `flito-soat-retencion.cron.ts`:

- la retención corre **una vez al día en la ventana de las 03:00**; esta HU pide reintento **cada hora**. Meter las dos cadencias en un latido mezcla dos programaciones y dos candados en un archivo de reglas RN-RET;
- encender o apagar cada uno por separado es útil: la retención borra datos vivos por política, y este cron solo termina borrados que ya se decidieron.

| Elemento | Valor |
|---|---|
| Puerta | **Variable nueva** `SOAT_BORRADOS_PENDIENTES_CRON_ENABLED` (`=== '1'`, mismo `transform` que `SOAT_RETENCION_CRON_ENABLED`). Sin ella: `log.info(... 'DESHABILITADO (SOAT_BORRADOS_PENDIENTES_CRON_ENABLED!=1)')` y no arranca (AC8) |
| Cadencia | `setInterval(INTERVALO_BORRADOS_MS = 60 * 60_000)`, `unref()`. Sin ventana horaria ni reloj Bogotá. Guarda `enVuelo` por proceso |
| Candado | `withLock(NOMBRE_LOCK_BORRADOS = 'flito-storage-borrados-pendientes', LOCK_TTL_BORRADOS_MS = 15 * 60_000, …)`. `null` → log «otra instancia» y no lee nada (AC8) |
| Lote | `LOTE_BORRADOS = 100` por corrida, `ORDER BY creado_en ASC` |
| Backoff | Lineal, implícito en la cadencia horaria, más una guarda `ultimo_intento_en IS NULL OR ultimo_intento_en <= ahora − 55 min` (`MIN_ENTRE_INTENTOS_MS`), para que el cron no repita en el mismo minuto un pendiente que el borrado inmediato acaba de fallar. Sin exponencial: con 1 intento por hora el bucket no recibe presión, y la alerta de 72 h ya cubre lo crónico |
| Sin pendientes | La consulta devuelve 0 filas → no se llama al storage, no hay Bitácora y solo se refresca el gauge (AC8) |

Firma del servicio: `ejecutarBorradosPendientes(opts?: { ahora?: Date; limite?: number }): Promise<ResultadoBorrados>` con `{ leidos, borrados, inexistentes, referenciados, fallidos, alertados, abiertos }` (solo conteos, para el log de la corrida).

### D4 — «Clave aún referenciada» (AC6)

Por lote, **una** consulta antes de tocar el storage:

```ts
// claves = pendientes.map(p => p.storageKey)
SELECT storage_key FROM flito_soportes WHERE storage_key IN (…claves)
UNION
SELECT factura_storage_key FROM flito_soat_incompletas WHERE factura_storage_key IN (…claves)
```

Con el query builder de Drizzle (`inArray`) o `sql` parametrizado; nunca con strings concatenados. Cada pendiente cuya clave aparezca **no se borra**: `UPDATE … SET resuelto_en = ahora, motivo_cierre = 'referenciada' WHERE id = $id AND resuelto_en IS NULL` y `log.warn({ evento: 'soat.storage.borrado_pendiente_referenciada', pendienteId, origen }, …)`, sin clave. No escribe en la Bitácora (AC6 pide solo log).

- Incluye las incompletas ya purgadas (que conservan `factura_storage_key` como histórico): cerrar como `referenciada` es conservador (no borra) e inocuo.
- Índice: no se crea en `0225`. Son ≤100 claves por hora; `db-review-agent` valida con `EXPLAIN` si `flito_soportes.storage_key` necesita índice y, si lo pide, va en esta misma migración.
- Carrera «se referencia entre la comprobación y el borrado»: las claves llevan un identificador único por subida, así que es inalcanzable en la práctica. Se declara y no se cubre con un candado de fila.

### D5 — Por pendiente: borrar, fallar, alertar (AC3, AC4, AC5, AC7)

- **Éxito o `esObjetoInexistente`** → `db.transaction`: `UPDATE … SET resuelto_en = ahora, motivo_cierre = 'borrado' | 'inexistente', intentos = intentos + 1, ultimo_intento_en = ahora WHERE id = $id AND resuelto_en IS NULL RETURNING id`. Si devuelve 0 filas, no hay Bitácora (idempotencia). Con 1 fila → `tx.insert(auditLogs)` (D6). AC5: `inexistente` se resuelve igual, sin error y con Bitácora.
- **Fallo** → `UPDATE … SET intentos = intentos + 1, ultimo_intento_en = ahora, ultimo_error = <code|name, máx 100>` (AC4). Si `creado_en <= ahora − HORAS_ALERTA (72 h)` y (`ultima_alerta_en IS NULL` o `<= ahora − HORAS_ENTRE_ALERTAS (24 h)`), en **el mismo UPDATE** `ultima_alerta_en = ahora` y `log.error({ evento: 'soat.storage.borrado_pendiente_persistente', pendienteId, origen, intentos }, …)` (AC7: una vez al día por pendiente, sin clave).
- Al final de la corrida (dentro del candado): `SELECT origen, count(*) … WHERE resuelto_en IS NULL GROUP BY origen` → `flitoStorageBorradosPendientesAbiertos.set({ origen }, n)`. Antes se hace `reset()` para que un origen que llega a 0 no quede con su último valor.

**Métrica** (`apps/api/src/shared/metrics.ts`):

```ts
export const flitoStorageBorradosPendientesAbiertos = new Gauge({
  name: 'flito_storage_borrados_pendientes_abiertos',
  help: 'Borrados de objetos de storage pendientes (abiertos) tras la última corrida del cron (HU #13410).',
  labelNames: ['origen'] as const,
  registers: [registry],
});
```

Es un gauge por proceso: solo lo actualiza la instancia que gana el candado, y las demás exponen su último valor (o nada). Es aceptable con un solo servidor (AC8); si se escala, el alertado se configura con `max()` en Prometheus. Se declara aquí y no se resuelve con un `collect()` asíncrono contra la BD, que no tiene precedente en el repo.

### D6 — Bitácora y errores sin PII

```ts
await tx.insert(auditLogs).values({
  userId: null, userEmail: 'sistema',
  action: 'delete',                                         // pgEnum: no se añade valor
  resource: ACCION_BITACORA_BORRADO = 'soat.storage.borrado_pendiente_resuelto', // 39 ≤ 50
  resourceId: pendiente.id,
  detail: `${ACCION_BITACORA_BORRADO}: origen ${origen}; motivo ${motivo}; intentos ${n}.`,
});
```

Sin `storage_key`, sin hash de clave, sin `soporteId` ni NIT. `ultimo_error` y `err` de los logs: solo `code`/`name` (`nombreDeError`), nunca `message` (el SDK puede repetir la clave en el mensaje). Los logs del cron solo llevan host, conteos, `pendienteId`, `origen` y el nombre del error.

### D6 bis — `deleteEntityDocument` (AC9)

Nuevo contrato en `apps/api/src/services/storage.ts`:

```ts
/** Borrado best-effort. `true` si quedó borrado (incluido «no existía»); `false` si falló. Nunca lanza por el borrado. */
export async function deleteEntityDocument(key: string): Promise<boolean>
//   catch (e) → esObjetoInexistente(e) ? true
//             : (log.warn({ clave: huellaClave(key), err: nombreDeError(e) }, 'delete entity doc failed'), false)
```

- **Devolver en vez de propagar.** Hay 11 llamadores (`drivers/documents.routes.ts`, 4 en `flito-bolsas.routes.ts`, `flito-conciliacion.routes.ts`, `compensarAdicionales` en `flito-soat-documentos.service.ts`, 2 en `pesv/diagnostico-evidencias.routes.ts`, 2 en `tramites/transito-config.routes.ts`), y todos lo usan como best-effort **después** de haber hecho su trabajo. Si propagara, `drivers` y `transito-config` (que hacen `await` sin `.catch`) pasarían a responder 5xx tras un borrado de fila ya hecho, lo que sería una regresión. Con el `boolean` los 11 compilan y se comportan igual (ignoran el valor), y el fallo **llega** a quien lo quiera leer, como pide AC9.
- **Llamadores (11) y efecto** (confirmado con el insumo de qa-agent). **Ninguno cambia en esta HU:**

  | Llamador | Forma hoy | Si el helper lanzara | Con `boolean` |
  |---|---|---|---|
  | `modules/drivers/documents.routes.ts:146` | `await` sin `.catch` | 2xx → **500** (tests mockean el helper: no lo verían) | igual que hoy |
  | `modules/tramites/transito-config.routes.ts:278` | `await` sin `.catch` | 2xx → **500** | igual que hoy |
  | `modules/tramites/transito-config.routes.ts:308` | `await` sin `.catch` | 2xx → **500** | igual que hoy |
  | `modules/flito-bolsas/flito-bolsas.routes.ts:237, 250, 376, 448` | `.catch(() => undefined)` | igual | igual |
  | `modules/flito-conciliacion/flito-conciliacion.routes.ts:571` | `.catch(() => undefined)` | igual | igual |
  | `modules/pesv/diagnostico-evidencias.routes.ts:216, 272` | `.catch(...)` | igual (el de :272 loguea `storageKey`) | igual; `.catch` muerto |
  | `modules/flito-soat/flito-soat-documentos.service.ts:180` (`compensarAdicionales`) | `Promise.allSettled` | igual | igual |

  El código nuevo de #13410 (borrado inmediato y cron) usa **`removeEntityDocument`**, que sí lanza, porque necesita saber si el borrado falló.
- **Sin clave en el log**: solo `huellaClave(key)` (sha256 de 16 hex), como `claveHash`.
- `getClient()` antes del `try` se mantiene (un cliente mal configurado sigue rechazando).
- Esta HU no cambia ningún llamador. El nuevo flujo de SOAT usa `removeEntityDocument` (que propaga) dentro de `borrarObjetoConReintento` y del cron, así que no depende de `deleteEntityDocument`.
- Nota de deuda ajena: el `.catch` de `pesv/diagnostico-evidencias.routes.ts:272` loguea `storageKey` en claro, pero con este contrato (y ya con el de hoy) ese `.catch` es código muerto porque `deleteEntityDocument` no rechaza por el borrado. Va como Nota en el PR, no se corrige aquí (P9).

### D7 — ¿La purga de la HU #13409 debería usar la tabla de pendientes?

**No; queda fuera de alcance.** La retención ya es durable por construcción: si el storage falla, la **fila** del adicional (o la marca `archivos_purgados_en IS NULL` de la factura) se queda y la corrida del día siguiente reintenta solo lo que falta. Nada se olvida, y por eso no hay huérfano que perseguir. Pasarla a la tabla obligaría a reordenar su transacción (borrar fila + insertar pendiente) sin ganar garantía. El único cambio que toca a la retención es el traslado de `esObjetoInexistente`/`huellaClave` a `storage.ts` con re-export (D2), que no cambia su comportamiento.

### D8 — Corrección de R1 en la implementación: la clave se borra al cerrar (Ley 1581)

Decisión del hilo durante la implementación, porque R1 dejaba un defecto del propio diseño: las filas cerradas conservaban `storage_key` (NIT de la carpeta + nombre del archivo) para siempre.

- `storage_key` pasa a **nullable** y se añade `clave_hash varchar(16) NOT NULL` (`huellaClave`, sha256 de 16 hex), que se rellena en el INSERT del pendiente.
- **Todo** UPDATE de cierre (`borrado`, `inexistente`, `referenciada`) escribe `storage_key = NULL` en la misma sentencia. Se construye con un único helper, `valoresCierre(motivo, ahora)`, que usan el cierre inmediato y el cron.
- CHECK `ck_flito_storage_borrados_pendientes_clave`: `(resuelto_en IS NULL) = (storage_key IS NOT NULL)`. Exige clave a los abiertos y, además, impide que un cierre la conserve: la garantía queda en la base y no depende de que el código se acuerde.
- La fila cerrada queda como constancia sin PII: `clave_hash` permite correlacionarla con los logs `objeto_huerfano`.
- R1 queda resuelto. Purgar las filas cerradas sigue fuera de alcance, pero ya no hay PII que proteger en ellas.

**Otras desviaciones de la implementación**

- Los helpers `huellaClave`/`esObjetoInexistente`/`nombreDeError` viven en `apps/api/src/services/storage-errores.ts` (módulo puro), no dentro de `storage.ts`. `storage.ts` y `flito-soat-retencion.service.ts` los re-exportan. Motivo: muchos specs mockean `storage.js` con una fábrica cerrada, y un módulo que importara los helpers desde ahí recibiría `undefined` en esos tests.
- `ResultadoBorradoObjeto` y `cerrarPendienteTrasBorrado` viven en `flito-soat-borrados-pendientes.service.ts` para que el cierre (inmediato y del cron) tenga un solo dueño.
- AC6 usa dos SELECT parametrizados con `inArray` (soportes y facturas de incompletas) en `Promise.all`, en vez de un `UNION`.

## Contrato delta

- HTTP: **sin cambios**. `DELETE` del adicional (HU #13364) responde igual, incluido `objetoPendiente`.
- BD: tabla nueva `flito_storage_borrados_pendientes` (D1).
- `services/storage.ts`: `deleteEntityDocument(key): Promise<boolean>` (antes `void`). Se exportan `esObjetoInexistente`, `huellaClave` y `nombreDeError`.
- `flito-soat-documentos.service.ts`: `borrarObjetoConReintento` devuelve `ResultadoBorradoObjeto` (D2). Nueva constante `ORIGEN_ADICIONAL_SOAT = 'soat.documento_adicional'`.
- Env: `SOAT_BORRADOS_PENDIENTES_CRON_ENABLED` (opcional, `'1'` para encender).
- Métrica: `flito_storage_borrados_pendientes_abiertos{origen}` (gauge).
- Logs: `soat.storage.borrado_pendiente_persistente` (error), `soat.storage.borrado_pendiente_referenciada` (warn), `soat.storage.borrado_pendiente_no_actualizado` (warn). Bitácora: `soat.storage.borrado_pendiente_resuelto`.
- `packages/shared-types`: **sin impacto**.

## Archivos a crear/modificar

**Crear**
- `apps/api/src/db/migrations/0225_flito_storage_borrados_pendientes.sql`
- `apps/api/src/db/schema/flito-storage-borrados-pendientes.ts`
- `apps/api/src/modules/flito-soat/flito-soat-borrados-pendientes.service.ts`: cabecera con reglas `RN-BP1…RN-BP4` (durabilidad, referenciada, alerta, puerta + candado), constantes exportadas (`LOTE_BORRADOS`, `HORAS_ALERTA`, `HORAS_ENTRE_ALERTAS`, `MIN_ENTRE_INTENTOS_MS`, `ACCION_BITACORA_BORRADO`), `ejecutarBorradosPendientes`
- `apps/api/src/modules/flito-soat/flito-soat-borrados-pendientes.cron.ts`: `latidoBorradosPendientes`, `start/stopSoatBorradosPendientesCron`, `reiniciarEstadoBorrados` (tests)
- `apps/api/__tests__/services/flito-soat-borrados-pendientes.service.test.ts`: AC3, AC4, AC5, AC6, AC7 (umbral 72 h + una vez al día + gauge), AC8 (sin pendientes no llama al storage ni a la Bitácora). Asertar sobre el SQL o las condiciones leídas (filtro `resuelto_en IS NULL`, guarda de `ultimo_intento_en`), no solo sobre el mock `chain`
- `apps/api/__tests__/services/flito-soat-borrados-pendientes.cron.test.ts`: puerta cerrada (log, sin timer), `withLock` → `null` = otra instancia, `enVuelo`
- `apps/api/__tests__/services/flito-soat-migracion-0225-borrados-pendientes.test.ts`: patrón del de `0224`; asertar «la anterior es `0224`», no «es la última»

**Modificar**
- `apps/api/src/db/schema.ts`: import + re-export de `flitoStorageBorradosPendientes` (1–2 líneas, techo)
- `apps/api/src/modules/flito-soat/flito-soat-documentos.service.ts`: `eliminarDocumentoAdicional` en transacción + cierre del pendiente; `borrarObjetoConReintento` con resultado y `inexistente` = éxito; `ORIGEN_ADICIONAL_SOAT`. Hoy está en ~393 líneas efectivas, con holgura frente a 800
- `apps/api/src/modules/flito-soat/flito-soat-retencion.service.ts`: `esObjetoInexistente`/`huellaClave` pasan a re-export desde `storage.ts`
- `apps/api/src/services/storage.ts`: `deleteEntityDocument` → `boolean`, sin clave en el log; exportar `esObjetoInexistente`, `huellaClave`, `nombreDeError`
- `apps/api/src/shared/metrics.ts`: gauge `flitoStorageBorradosPendientesAbiertos`
- `apps/api/src/config/env.ts`: `SOAT_BORRADOS_PENDIENTES_CRON_ENABLED` junto a `SOAT_RETENCION_CRON_ENABLED`
- `apps/api/src/server.ts`: import + `startSoatBorradosPendientesCron()` junto a `startSoatRetencionCron()` y `stop…` en el apagado
- `apps/api/.env.example`: la variable nueva, comentada y apagada
- `docs/privacy/retencion-flito-soat.md`: párrafo «borrados pendientes» (durabilidad del borrado de adicionales, alerta 72 h)
- `apps/api/__tests__/services/storage.test.ts`: `deleteEntityDocument` → `resolves.toBe(false)` al fallar, `true` al borrar, `true` con NoSuchKey, y el log **sin** la clave (aserto sobre el payload del `warn`)
- `apps/api/__tests__/services/flito-soat-documentos.service.test.ts` y `flito-soat-documentos.eliminar.routes.test.ts`: AC1 (insert del pendiente dentro de la misma `transaction`; fila inexistente → 404 sin insert), AC2 (3 fallos → `intentos = 3`, abierto, log con `soporteId` + `claveHash` y sin clave, respuesta igual). Revisar el stub de `db.transaction`: si la ruta empieza a transaccionar y el stub está pelado, se rompen otros specs

**Centinelas** (comprobar con grep en el impl, no a ciegas): las parejas `start/stop` de crons en `server.ts`; cualquier test que enumere variables de `env.ts` o métricas de `metrics.ts`; el test de la `0224` si asertaba «es la última» (no debería). Los mocks de `deleteEntityDocument` en otros specs (`mockResolvedValue(undefined)`) siguen sirviendo porque los llamadores ignoran el valor, y `build:api` no typechequea tests.

**P1 (verificación local):** `npm test -w apps/api -- __tests__/services/flito-soat-borrados-pendientes.service.test.ts __tests__/services/flito-soat-borrados-pendientes.cron.test.ts __tests__/services/flito-soat-migracion-0225-borrados-pendientes.test.ts __tests__/services/storage.test.ts __tests__/services/flito-soat-documentos.service.test.ts __tests__/services/flito-soat-documentos.eliminar.routes.test.ts __tests__/services/flito-soat-retencion.service.test.ts` + `NODE_OPTIONS=--max-old-space-size=8192 npm run build:api` + `npx eslint` de los archivos tocados. Migración: aplicar **solo** la `0225` dos veces sobre la BD local (P6, puerto 5434).

## ADR: no aplica

Extiende el patrón de la HU #13364/#13409 y Security ya fijó la opción en las notas de la HU. La tabla genérica `flito_storage_…` con `origen` no sienta precedente obligatorio para otros módulos; si otro módulo la adopta, entonces conviene un ADR.

## Notas operativas

**backend-agent**
- No usar `drizzle-kit`. SQL a mano, sin `BEGIN/COMMIT`.
- La clave solo vive en `storage_key`. Ni en logs, ni en Bitácora, ni en `ultimo_error` (`code`/`name`, nunca `message`). Tampoco el hash de la clave en la Bitácora.
- Todo `UPDATE` de cierre lleva `AND resuelto_en IS NULL`; la Bitácora solo se escribe si el `RETURNING` devolvió fila.
- El cierre del pendiente tras el borrado inmediato nunca cambia la respuesta HTTP.
- Fuera del alcance: cambiar los llamadores de `deleteEntityDocument`, migrar la retención a la tabla y purgar las filas resueltas.

**frontend-agent:** no aplica.

**Gates:** `db-review-agent` (migración `0225`, índice parcial y si hace falta índice en `flito_soportes.storage_key`) ∥ `security-agent` (borrado/PII y contrato de `deleteEntityDocument`). `flit-ayuda-flito`: N/A (BACKEND-only, sin cambio visible).

**Despliegue:** la `0225` la aplica el CD en DEV. El cron queda **apagado** hasta que alguien ponga `SOAT_BORRADOS_PENDIENTES_CRON_ENABLED=1` en cada ambiente. Mientras tanto los pendientes se acumulan sin perderse.

## Riesgos abiertos y qué falta decidir (humano)

- **R1 — Retención de la propia tabla.** ~~Las filas resueltas conservan `storage_key` (PII) para siempre.~~ **Resuelto en la implementación (D8):** `storage_key` se pone a NULL al cerrar y un CHECK lo exige.
- **R2 — Encendido por ambiente.** Quién pone la variable en DEV/QA/PDN y cuándo. Hasta entonces la garantía depende del borrado inmediato y los pendientes se acumulan sin alerta.
- **R3 — Gauge por proceso** (D5): válido con un servidor; con varios, alertar con `max()`.
