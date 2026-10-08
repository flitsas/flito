# Diseño — Envío automático del comprobante de pago del impuesto a FLIT 2

**Modo:** full · **HU** #13268 (Feature #13267, Épica #12741) · delta slim de la HU #13269 en §12
**Estado:** Propuesto (architecture-agent, 2026-10-02; revisado 2026-10-05 con las decisiones cerradas de §13) · **ADR:** [ADR-0020](../adr/ADR-0020-flito-outbox-envio-comprobante-flit2.md) (Propuesto)
**Base medida:** `develop` 5feaf229 (worktree `flito-13268`).
**Módulos:** `flito-impuestos` (FLITO, no el legacy `liquidacion/`/`tramites/`) + `flito-sync` (adaptador FLIT 2). Solo trámites `flito_tramites.fuente = 'flit2'`.
**Contrato FLIT 2:** repo `flitsas/flit` @ `c2b7f68db` (PR flitsas/flit#513, **aún sin mergear**) — `contracts/openapi/external-api.v1.json`, operationId `enviarAdjunto` (lleva `x-estado: anunciada`), schemas `AdjuntoEnvio` / `AdjuntoRecibido` / `Problem`, y `docs/integraciones/external-api-tramites-sync.md` §7. Cuando la PR se mergee, la referencia pasa a `main`. El servidor lo expone con la HU #13263 de FLIT 2 (que también da de alta el scope `external.tramites.attachments.write`); hasta entonces la ruta responde **404 sin cuerpo**.

---

## 1. Contexto (medido)

| Hecho | Dónde |
|---|---|
| `conciliar(tx, cand, extraccion, soporteId, ctx, pagadoEn)` es «la ÚNICA vía a `pagado` de un impuesto por documento» (ADR-0018 §4). La usan la **carga masiva** (`escribirPorFase` ← `procesarRecibo`), la **carga por fase** (`cargarReciboPorFase` → `escribirPorFase`), el **recibo de caja** (`cargarReciboCaja`, l. ~808) y los **comprobantes universales** (`flito-comprobantes.duenos.ts:140`). | `flito-impuestos/flito-recibos.service.ts:604` |
| Dos caminos a `pagado` **no** pasan por `conciliar`: la revisión OCR (`resolverImpuesto`, UPDATE directo dentro de su `db.transaction`) y la reversa manual (`reversar`, cuando `estadoDestino = pagado`). | `flito-revisiones/flito-revisiones.service.ts:260-290`; `flito-impuestos/flito-impuestos.service.ts:810` |
| `adjuntarAPagado` añade la copia de otra fase a un impuesto **ya** pagado, en su propia `db.transaction`. Es el camino del AC4 («se carga el recibo después»). | `flito-recibos.service.ts:546` |
| Tamaño (ESLint, sin blancos ni comentarios): `flito-recibos.service.ts` **558**, `flito-impuestos.service.ts` **522**, `flito-revisiones.service.ts` **224**. Hay margen, pero la lógica nueva va en archivos nuevos y en los existentes solo entra **una línea de llamada** por camino. | `npx eslint` medido |
| Puerto FLIT 2 con `verificarAcceso`, `leerPagina`, `obtenerUrlAdjunto`; adaptador HTTP con `conPase` (renueva el pase UNA vez ante 401), `codigoDeProblema`, `segundosRetryAfter`, `Flit2RespuestaError(status, codigo, reintentarEnS)`. Fake en memoria. Selector `getFlit2SyncAdapter()`. | `flito-sync/flit2-sync.port.ts`, `flit2-sync-http.adapter.ts`, `flit2-sync-fake.adapter.ts`, `flit2-sync.adapter.ts` |
| `obtenerPase()` cachea el JWT por acceso, coalesce peticiones en vuelo y lanza `Flit2NoConfigurado/SinAcceso/Rechazado/Bloqueado/NoResponde`. El 429/423 **del endpoint de token** ya se guarda como pausa (`bloqueado_hasta`) en la fila del acceso — esa pausa bloquea **todo** el pase (feed incluido), así que **no** sirve para pausar solo el envío. | `flito-sync/flit2-pase.service.ts:132-238` |
| Interruptor por fuente en base, sin caché (`fuenteHabilitada('flit2')`), y maestro de lectura `FLIT2_SYNC_CRON` (`habilitacionDe`). | `flito-sync/flito-sync-interruptor.service.ts` |
| Patrón de **cola en tabla** con cerrojo de ciclo (`withLock`, tabla `system_locks`, vale entre procesos) + **toma en una sola sentencia** (CTE `FOR UPDATE SKIP LOCKED` + `UPDATE … RETURNING`, arrendamiento `tomado_en`) + fechas como texto ISO con cast. | `siigo/facturacion.cola.service.ts:480-540` (`tomarLote`), `siigo/siigo.cola.cron.ts` |
| Patrón de cron simple (intervalo, arranque diferido, `*_ENABLED`). | `flito-impuestos/flito-impuestos-analisis.cron.ts` |
| Lectura de PII por un proceso sin `Request`: `registrarAccesoSistema(impuestoId, campos, detalle)` fabrica la petición mínima (sin usuario, sin IP). | `flito-impuestos/flito-impuestos.extraccion.ts:237` |
| Binario en MinIO/S3: `getEntityDocumentStream(storageKey)`; tipo real por bytes: `tipoPorBytes(buf)`. `flito_soportes.hash` es `varchar(64)`. | `services/storage.ts:225`, `shared/soportes/soportes-zip.ts:303`, `db/schema.ts:3370` |
| `flito_tramites.fuente` + `id_flit2` con CHECK `(fuente='flit2') = (id_flit2 IS NOT NULL)`; `sync_version bigint` (CHECK: no nula si `id_flit2` lo es). | `db/schema.ts:3092-3109` |
| **FLITO sí persiste el estado FLIT 2 del trámite**: el feed lo escribe en `flito_tramites.flit_estado` con la grafía capitalizada de `TEXTO_FLIT` (`'Preasignacion'`, `'Asignado'`, `'Entregado'`, `'Rechazado'`, `'Borrador'`, `'Preparado'`, `'Aprobado'`, `'Anulado'`, `'Revocado'`; desconocido → primera letra en mayúscula). `estadoDesdeFlit2(codigo).flitEstado` es la función que lo produce. | `flito-sync/flit2-mapeo.ts:17-54`, `flito-sync/flit2-lectura.service.ts:331` |
| Última migración: `0218_pagina_perfil.sql`. | `apps/api/src/db/migrations/` |

**Hallazgo para el AC1:** el AC enumera 4 caminos; en código son **seis** entradas a `pagado` (masiva, fase, recibo de caja, comprobante universal, revisión OCR, reversa). Engancharse en `conciliar` cubre las cuatro primeras con una sola línea, y «CUALQUIERA» del AC las incluye. No amplía el alcance: es el mismo evento.

**Estados de FLIT 2 que importan al envío** (contrato §7, decisión 2026-10-05):

| Estado FLIT 2 | ¿Admite el adjunto? | Respuesta si no |
|---|---|---|
| `preasignacion`, `asignado` (solo 4 de 96 tipos) | sí | — |
| `entregado` (los traspasos entran directo aquí; el adjunto se archiva con `pagadoMarcado:false`) | sí | — |
| `rechazado` con subsanación activa | sí | — |
| `borrador`, `preparado`, `rechazado` sin subsanación activa | no, **todavía** | 409 `not_allowed_in_state` `terminal:false` |
| `aprobado`, `anulado`, `revocado` | no, **nunca** | 409 `not_allowed_in_state` `terminal:true` |

«radicado» **no** es un estado de FLIT 2.

---

## 2. Alternativas

### Decisión 1 + 2 — Mecanismo de cola y punto de disparo

#### Opción A — Outbox transaccional en tabla + cron con cerrojo de ciclo y toma `SKIP LOCKED` (RECOMENDADA)

`programarEnvioFlit2(tx, impuestoId)` se llama **dentro** de la transacción del pago y solo hace un `INSERT … ON CONFLICT` de una fila `pendiente` (o `sin_comprobante`). Un cron (`flito-impuestos-envio-flit2.cron.ts`) cada 60 s toma `withLock` de ciclo, lee la habilitación, toma ≤ 50 filas con la CTE `SKIP LOCKED` y las envía con `conConcurrencia(…, 4, …)`.

| | |
|---|---|
| **Pros** | Atómico con el pago: si el pago hace rollback no hay fila; si confirma, la fila existe aunque el proceso muera un milisegundo después (el AC1 «sin esperar el envío» sale gratis: la red nunca está dentro de la `tx`). «Sin retroactivo» es estructural: los pagados previos no tienen fila. Sobrevive a reinicios y despliegues. Ritmo y concurrencia **globales** (el cerrojo de ciclo es de base, vale con PM2 en cluster o varias réplicas). Calco del patrón Siigo que ya está en producción. El estado del AC10 se lee de la misma fila. |
| **Contras** | Latencia de hasta ~60 s entre pago y envío. Una tabla y una migración nuevas. |
| **Esfuerzo** | **M** |
| **Riesgos** | Olvidar la llamada en un séptimo camino futuro a `pagado` (mitigado: la mayoría pasa por `conciliar`; test de contrato que recorre los caminos conocidos). |

#### Opción B — Hook post-commit + cola en memoria (como el análisis post-envío, HU #12825)

Tras el `COMMIT`, `setImmediate` encola el id en un array en memoria; un barrido periódico recoge huérfanos.

| | |
|---|---|
| **Pros** | Envío casi inmediato. Ya existe el patrón (`encolarAnalisis`). |
| **Contras** | Hay que poner el «después del commit» en seis sitios con formas distintas de transacción (`conciliar` recibe la `tx` de otro; no sabe cuándo confirma). El estado del envío necesita persistir igual (AC5/AC10), así que la tabla no se ahorra. El ritmo ≤ 60/min y la concurrencia ≤ 4 son por proceso, no globales. Un reinicio pierde la cola y depende del barrido. |
| **Esfuerzo** | **M** |
| **Riesgos** | Doble envío entre el job vivo y el barrido si no hay arrendamiento: acaba reimplementando la opción A. |

#### Opción C — Envío síncrono tras el commit, en la misma petición HTTP

| | |
|---|---|
| **Pros** | Lo más simple de leer. |
| **Contras** | La carga masiva paga N llamadas a FLIT 2 en el request (timeout del cliente web: 90 s). Sin cuota global ni reintento diferido: el AC5/AC7 obliga a persistir y reintentar igual. |
| **Esfuerzo** | **S** al principio, **L** al cumplir AC5-AC7 |
| **Riesgos** | Frena la sincronización (cuota compartida de 120/min) en una carga masiva. Descartada. |

### Decisión 3 — Modelo de datos

| Opción | Pros | Contras | Esfuerzo |
|---|---|---|---|
| **A1. Una fila por impuesto** (`UNIQUE impuesto_id`), estado vigente + contadores; historial de intentos en `audit_logs` (RECOMENDADA) | La #13269 reprograma **la misma fila** (nuevo soporte, intentos a 0, `version + 1`). El detalle (AC10) es un join 1:1. La unicidad impide dos envíos vivos del mismo impuesto. | El historial no es consultable como tabla, sino como auditoría (suficiente para AC9). | S |
| A2. Una fila por envío (historial) | Historial nativo. | «Vigente» exige `DISTINCT ON`/índice parcial; el reemplazo y el detalle se complican; dos filas vivas posibles sin índice parcial. | M |

### Decisión 4 — Puerto: método nuevo en `Flit2SyncPort` vs puerto aparte

Se **extiende** `Flit2SyncPort` con `enviarAdjunto` (mismo cliente, mismo pase, mismo selector fake/http). Un puerto aparte duplicaría selector y fake sin ganar nada. El método **no lanza** por respuestas de FLIT 2: devuelve un resultado tipado (el cron necesita ramificar, no capturar). Solo lanza los `Flit2Error` del pase (sin acceso, rechazado, bloqueado, no configurado), que el cron trata como pausa global.

### Decisión 5 — Bitácora

`audit_logs` (`resource='flito_impuesto'`, `resourceId=impuestoId`, `userId=null`) por intento, más `registrarAccesoSistema` (pii_access_log) por cada lectura del PDF. La tabla de envíos guarda solo el **último** resultado. Nada de una tabla de historial nueva (AC9 pide «la existente»).

### Decisión 6 — Exposición

Campo nuevo `envioFlit2: EnvioComprobanteFlit2 | null` en `ImpuestoDetalle` (`detalleImpuesto`), con el tipo en `packages/shared-types`. Sin endpoint nuevo.

### Decisión 7 — Trámite que aún no admite el adjunto (409 `terminal:false`) — cerrada 2026-10-05

| Opción | Pros | Contras |
|---|---|---|
| Reintento con backoff largo (1 h / 6 h), sin mirar el feed (default de la v1) | Sin columnas nuevas. | Gasta los 3 intentos en un trámite que puede tardar días; sondea a ciegas. |
| **Estacionar en `en_espera` y despertar con el feed** (`sync_version` > la guardada ∧ `flit_estado` que admite envío) + red de seguridad 24 h / 30 días (ELEGIDA) | No gasta intento; reintenta justo cuando el trámite cambia; FLITO ya persiste `sync_version` y `flit_estado`. | Dos columnas nuevas y una rama más en la toma. |

### Decisión 8 — Dónde vive la pausa global — cerrada en este diseño

La pausa del pase (`bloqueado_hasta` del acceso) frena también el feed: no sirve. En memoria del proceso no basta: con PM2 en cluster otro proceso gana el cerrojo del ciclo siguiente y vuelve a pegarle a la ruta 404 cada minuto, gastando cuota. Se persiste como **clave propia en `system_locks`** (`flito-impuestos-envio-flit2:pausa`, con vencimiento = fin de la pausa); ver RN-05. Sin tabla nueva.

---

## 3. Decisión

**Opción A** (outbox en tabla + cron con cerrojo de ciclo y toma `SKIP LOCKED`), **A1** (una fila por impuesto), extensión de `Flit2SyncPort`, bitácora en `audit_logs` + `pii_access_log`, campo en el detalle, **estacionamiento `en_espera` guiado por el feed** para el 409 `terminal:false`, y **pausa global persistida** en `system_locks`. Justificación: es el único diseño en el que el pago y la intención de envío son atómicos, el ritmo es global entre procesos y la #13269 cabe como «reprogramar la fila», y reutiliza piezas ya probadas en el repo (`tomarLote` de Siigo, `withLock`/`system_locks`, `conPase`, `sync_version`/`flit_estado` del feed).

**Interruptor de despliegue:** variable `FLIT2_ADJUNTOS_ENVIO_HABILITADO` (default **apagada** en todos los ambientes). Apagada, `programarEnvioFlit2` **sigue escribiendo** filas (el pago post-despliegue queda registrado y saldrá al encender) y el cron no toma nada ni gasta intentos. FLITO puede mergear y desplegar antes que FLIT 2 con ella apagada. Se enciende por ambiente cuando FLIT 2 tenga la HU #13263 (ruta + scope) desplegada allí; en **PDN**, además, cuando la HU #13265 de FLIT 2 (bloqueo del gestor) esté allí (§13, D-9). Por si se enciende antes de tiempo: un **404 sin cuerpo** (ruta inexistente, no problem+json) se clasifica `no_disponible` → pausa global **sin consumir intento**, con sondeo de **una** petición cada 20 min (ese 404 sí gasta cuota). Solo el 404 problem+json `procedure_not_found` es definitivo.

**Cuota (contrato):** 120 req/min por `client_id` en **ventana deslizante**, compartida con el feed y con la URL de factura; el token, 10/min por IP. Lote 50/ciclo de 60 s con concurrencia 4 cabe y deja ≥ 70/min al resto; el envío reutiliza el JWT cacheado de `obtenerPase()`, sin token por envío.

---

## 4. Diagrama de secuencia

```mermaid
sequenceDiagram
    autonumber
    actor U as Operaciones / OCR
    participant S as Servicio de pago<br/>(conciliar · resolverImpuesto · reversar)
    participant P as programarEnvioFlit2(tx)
    participant DB as PostgreSQL<br/>flito_impuesto_envios_flit2
    participant FD as Feed FLIT 2<br/>(flito_tramites.sync_version · flit_estado)
    participant C as Cron envío FLIT 2<br/>(withLock de ciclo)
    participant S3 as MinIO/S3
    participant A as Flit2SyncPort.enviarAdjunto
    participant F2 as FLIT 2 /tramites/{id}/adjuntos

    U->>S: pago (cualquiera de los 6 caminos)
    S->>S: BEGIN · UPDATE estado=pagado · audit · historial
    S->>P: programarEnvioFlit2(tx, impuestoId)
    P->>DB: ¿trámite fuente=flit2? elegir soporte (AC2)
    P->>DB: INSERT … ON CONFLICT (pendiente | sin_comprobante)
    S->>S: COMMIT (respuesta al usuario sin esperar a FLIT 2)

    FD-->>DB: (en paralelo) el feed sube sync_version y escribe flit_estado

    loop cada 60 s
        C->>C: habilitado? (FLAG ∧ interruptor flit2 ∧ sin pausa en system_locks)
        alt pausa global vencida tras pausa (sondeo)
            C->>DB: toma lote = 1
        else normal
            C->>DB: CTE SKIP LOCKED: ≤50 pendientes vencidas<br/>∪ en_espera despertadas (sync_version > sync_version_espera ∧ flit_estado admite envío, o sondeo 24 h)
        end
        par concurrencia ≤4
            C->>DB: soporte vigente (no descartado) → storageKey
            C->>S3: stat (tamaño) + getEntityDocumentStream(storageKey)
            C->>C: pre-validación local (MIME por bytes, 0 < tamaño ≤ 20 MB) — fuera → error, sin llamada
            C->>DB: pii_access_log (registrarAccesoSistema)
            C->>A: enviarAdjunto(idFlit2, {bytes, contentType, nombre})
            A->>F2: POST multipart tipo=liquidacion_impuesto (JWT cacheado; 401 invalid_token → renueva 1 vez)
            F2-->>A: 201/200 · 4xx/5xx problem+json · 404 sin cuerpo · 429 Retry-After
            A-->>C: ResultadoEnvioAdjunto (enviado | reintentable | espera | estacionar | pausa | definitivo)
            alt estacionar (409 terminal:false)
                C->>DB: estado=en_espera, sync_version_espera = sync_version actual, próximo = +24 h (sin intento)
            else resto
                C->>DB: UPDATE … WHERE id AND version = tomada (estado, intentos, próximo intento)
            end
            C->>DB: audit_logs (intento N, resultado, adjuntoId)
        end
        Note over C: espera/pausa → corta el ciclo y libera lo no enviado; pausa se persiste en system_locks
    end
```

---

## 5. Contrato del puerto (`flit2-sync.port.ts`)

```ts
/** HU #13268. Lo que FLITO envía. Los bytes ya leídos de S3; nunca van a un log. */
export interface ArchivoAdjuntoFlit2 {
  bytes: Buffer;
  /**
   * Tipo real por bytes (`tipoPorBytes`): application/pdf | image/jpeg | image/png | image/webp.
   * Va como Content-Type de la parte `file`: es lo que FLIT 2 usa para decidir el MIME.
   */
  contentType: string;
  /** Nombre genérico (`comprobante-impuesto.pdf`): el original puede llevar placa o nombre. */
  nombreArchivo: string;
}

/** `AdjuntoRecibido` del contrato (201 y 200 tienen el mismo cuerpo). */
export interface AdjuntoRecibidoFlit2 {
  adjuntoId: string; tipo: string; sha256: string;
  /** No nulo cuando FLIT 2 reemplazó el adjunto vigente de FLITO (aceptado en todo estado que admite envío, incluido `entregado`). */
  reemplazoDe: string | null;
  enMatriz: boolean;
  /** Solo se guarda. FLITO NO decide nada con este valor (semántica tras un reemplazo abierta en FLIT 2 #13263). */
  pagadoMarcado: boolean;
}

export type ResultadoEnvioAdjunto =
  /** 201 (nuevo: true) o 200 idempotente (nuevo: false; mismo sha256 que el adjunto vigente DE FLITO) — AC1, AC8. */
  | { tipo: 'enviado'; nuevo: boolean; recibido: AdjuntoRecibidoFlit2 }
  /** Consume intento (AC5): red/timeout, 5xx, 503 storage_unavailable, 401 tras la renovación, 200 ilegible, 4xx no listado. */
  | { tipo: 'reintentable'; codigo: string; status: number | null }
  /** NO consume intento (AC7): 429 rate_limited. `segundos` = Retry-After (entero; 60 solo como defensa si faltara). Corta el ciclo. */
  | { tipo: 'espera'; segundos: number }
  /** NO consume intento: 409 not_allowed_in_state terminal:false. La fila pasa a `en_espera`. No corta el ciclo. */
  | { tipo: 'estacionar'; estadoFlit2: string }
  /**
   * NO consume intento, pausa TODA la cola: 403 insufficient_scope (config), 404 sin cuerpo
   * (ruta aún no desplegada, HU #13263), 400 invalid_tipo (catálogo desalineado). Corta el ciclo.
   */
  | { tipo: 'pausa'; codigo: 'insufficient_scope' | 'no_disponible' | 'invalid_tipo'; status: number }
  /** Final del ítem, sin reintento (AC6). */
  | { tipo: 'definitivo'; motivo: 'attachment_exists' | 'not_allowed_in_state' | 'procedure_not_found'
      | 'missing_file' | 'invalid_mime' | 'file_too_large'; status: number; estadoFlit2?: string };

export interface Flit2SyncPort {
  // … los tres métodos actuales …
  /**
   * HU #13268. `POST /api/v1/external/tramites/{idFlit2}/adjuntos`, `tipo=liquidacion_impuesto`.
   * No lanza por respuestas de FLIT 2 (las devuelve clasificadas). Lanza solo los `Flit2Error` del
   * pase (`NoConfigurado`, `SinAcceso`, `Rechazado`, `Bloqueado`), que el cron trata como pausa global.
   */
  enviarAdjunto(idFlit2: string, archivo: ArchivoAdjuntoFlit2): Promise<ResultadoEnvioAdjunto>;
}
```

**Tabla de clasificación (decidir por `code`, nunca por `detail`)** — función pura exportada `clasificarRespuestaAdjunto(status, problema, retryAfter)` en `flit2-adjuntos.ts`, testeable sin red. `problema` es `null` cuando no hay cuerpo problem+json:

| Respuesta FLIT 2 | Resultado | Estado de la fila | ¿Intento? |
|---|---|---|---|
| 201 / 200 con cuerpo `AdjuntoRecibido` válido (Zod) y `sha256` = sha256 local | `enviado` | `enviado` (guarda `adjunto_id`, `sha256`, `reemplazo_de`, `en_matriz`, `pagado_marcado`) | sí cuenta como intento (exitoso) |
| 200/201 con cuerpo fuera de contrato o `sha256` ≠ local | `reintentable` (`respuesta_invalida` / `sha256_distinto`) | `pendiente` → `error` al 3.º | sí |
| 401 `invalid_token` (con `WWW-Authenticate: Bearer`) | `conPase` renueva el token **una vez** y reintenta la misma petición; si vuelve 401 → `reintentable` (`invalid_token`) | `pendiente` → `error` al 3.º | sí (solo si persiste tras renovar) |
| 403 `insufficient_scope` | `pausa` | sin cambio (`pendiente`/`en_espera`); pausa global + `log.error` | no |
| 404 problem+json `procedure_not_found` | `definitivo` | `error` | sí (final) |
| **404 sin cuerpo** (ruta inexistente, no hay problem+json) | `pausa` (`no_disponible`) | sin cambio; pausa global con sondeo de 1 petición cada 20 min (el 404 gasta cuota) | no |
| 400 `missing_file` / `invalid_mime` / `file_too_large` | `definitivo` | `error` | sí (final) |
| 400 `invalid_tipo` | `pausa` (catálogo desalineado: falla igual para todos) | sin cambio | no |
| 409 `attachment_exists` (sin extensiones). La idempotencia compara contra el adjunto vigente **del consumidor**: si el gestor cargó primero, sale 409 aunque el sha256 coincida | `definitivo` | `ya_cargado_gestor` | sí (final) |
| 409 `not_allowed_in_state` `terminal: true` (`aprobado`/`anulado`/`revocado`) | `definitivo` | `error` (guarda `estado` de FLIT 2 en `estado_flit2`) | sí (final) |
| 409 `not_allowed_in_state` `terminal: false` (`borrador`/`preparado`/`rechazado` sin subsanación) | `estacionar` | `en_espera` (guarda `estado_flit2`, `sync_version_espera`; `en_espera_desde` si entra por primera vez) | **no** |
| 409 `not_allowed_in_state` sin `terminal` booleano (fuera de contrato) | `reintentable` (`respuesta_invalida`) | `pendiente` → `error` al 3.º | sí |
| 429 `rate_limited` | `espera` (`Retry-After`, segundos enteros; siempre viene) | sin cambio de estado, `proximo_intento_en = ahora + s` | no |
| 503 `storage_unavailable`, otros 5xx, timeout, red | `reintentable` | `pendiente` → `error` al 3.º | sí |
| Otro 4xx no listado | `reintentable` (`inesperado_<status>`) | idem | sí |

Las extensiones `estado` y `terminal` **solo** se leen en `not_allowed_in_state`; `attachment_exists` no trae extensiones (no se esperan ni se exigen).

**Pre-validación local antes de llamar (no gasta llamada ni cuota):** límites del contrato — MIME `application/pdf` | `image/jpeg` | `image/png` | `image/webp` (por bytes con `tipoPorBytes`; es el que viaja como `Content-Type` de la parte `file`), tamaño ≤ 20 MB (`20 971 520` bytes, medido con `statEntityDocument` **antes** de bajar el objeto) y no vacío. Fuera de límite → estado `error` con `ultimo_resultado` = `invalid_mime` | `file_too_large` | `missing_file` y `ultimo_status = null`, **sin** incrementar `intentos` (no hubo intento contra FLIT 2), auditado (RN-08). Objeto ausente en S3 → `reintentable` (`almacen_no_disponible`).

**Implementación HTTP:** `FormData` + `Blob` nativos de Node 22 (sin dependencia nueva), `redirect: 'error'`, `AbortSignal.timeout(60_000)`, URL por `urlDeEnvioAdjunto(base, idFlit2)` con la misma guarda de segmento que `urlDeAdjunto` (vacío, `.`, `..` → `definitivo procedure_not_found` sin llamar). Usa el JWT cacheado de `obtenerPase()` vía `conPase` (que ya renueva una vez ante 401). `codigoDeProblema` se generaliza para devolver también `terminal` y `estado` (un `leerProblema(res)` que devuelve `{ code, terminal, estado } | null` — `null` cuando el cuerpo no es problem+json, que es lo que distingue el 404 de ruta inexistente); `codigoDeProblema` queda como envoltorio. El adaptador **nunca** loguea la URL, el cuerpo ni el nombre de archivo: solo `idFlit2`, `status`, `codigo`.

**Fake:** `enviarAdjunto` con un guion en memoria por `idFlit2` (`programarRespuestaAdjunto(idFlit2, resultado[])`), por defecto `enviado` con `adjuntoId` determinista y `sha256` real de los bytes; segunda llamada con el mismo sha → `nuevo: false` (AC8).

---

## 6. Modelo de datos (Drizzle) y migración

`apps/api/src/db/schema.ts`, junto a `flitoImpuestos`:

```ts
/** HU #13268 (migración 0219): outbox del envío del comprobante de pago a FLIT 2. Una fila por impuesto. */
export const flitoImpuestoEnviosFlit2 = pgTable('flito_impuesto_envios_flit2', {
  id: uuid('id').primaryKey().defaultRandom(),
  impuestoId: uuid('impuesto_id').notNull().references(() => flitoImpuestos.id, { onDelete: 'cascade' }),
  estado: varchar('estado', { length: 20 }).$type<EstadoEnvioFlit2>().notNull(),
  /** Soporte elegido para enviar (AC2). null solo en `sin_comprobante`. Sin FK dura (como factura_venta_soporte_id). */
  soporteId: uuid('soporte_id'),
  intentos: smallint('intentos').notNull().default(0),
  proximoIntentoEn: timestamp('proximo_intento_en', { withTimezone: true }),
  ultimoIntentoEn: timestamp('ultimo_intento_en', { withTimezone: true }),
  /** Código del último desenlace (`code` de FLIT 2 o propio: `red`, `sha256_distinto`, `espera_vencida`…). Sin PII. */
  ultimoResultado: varchar('ultimo_resultado', { length: 40 }),
  ultimoStatus: smallint('ultimo_status'),
  /** Estado del trámite en FLIT 2 informado en 409 not_allowed_in_state (terminal o no). */
  estadoFlit2: varchar('estado_flit2', { length: 30 }),
  /** `flito_tramites.sync_version` al estacionar (409 terminal:false). La toma despierta la fila cuando el feed la supera. */
  syncVersionEspera: bigint('sync_version_espera', { mode: 'number' }),
  /** Primera entrada a `en_espera` (no se mueve al re-estacionar). A los 30 días → `error`. */
  enEsperaDesde: timestamp('en_espera_desde', { withTimezone: true }),
  adjuntoId: uuid('adjunto_id'),
  sha256: varchar('sha256', { length: 64 }),
  /** Soporte que realmente salió (≠ soporteId tras un reemplazo #13269 aún sin enviar). */
  soporteEnviadoId: uuid('soporte_enviado_id'),
  reemplazoDe: uuid('reemplazo_de'),
  enMatriz: boolean('en_matriz'),
  /** Solo se guarda; FLITO no ramifica con él (D-5). */
  pagadoMarcado: boolean('pagado_marcado'),
  enviadoEn: timestamp('enviado_en', { withTimezone: true }),
  /** Generación: la #13269 la sube; el worker solo escribe si no cambió desde que tomó la fila. */
  version: integer('version').notNull().default(1),
  tomadoPor: varchar('tomado_por', { length: 100 }),
  tomadoEn: timestamp('tomado_en', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  impuestoUq: uniqueIndex('uq_flito_impuesto_envios_flit2_impuesto').on(t.impuestoId),
  colaIdx: index('idx_flito_impuesto_envios_flit2_cola').on(t.estado, t.proximoIntentoEn)
    .where(sql`${t.estado} IN ('pendiente','en_espera')`),
  estadoCk: check('ck_flito_impuesto_envios_flit2_estado',
    sql`${t.estado} IN ('pendiente','en_espera','enviado','ya_cargado_gestor','error','sin_comprobante')`),
  soporteCk: check('ck_flito_impuesto_envios_flit2_soporte',
    sql`(${t.estado} = 'sin_comprobante') = (${t.soporteId} IS NULL)`),
  esperaCk: check('ck_flito_impuesto_envios_flit2_espera',
    sql`(${t.estado} = 'en_espera') = (${t.syncVersionEspera} IS NOT NULL AND ${t.enEsperaDesde} IS NOT NULL)`),
  intentosCk: check('ck_flito_impuesto_envios_flit2_intentos', sql`${t.intentos} BETWEEN 0 AND 10`),
}));
```

Notas de modelo:
- `estado` como `varchar` + CHECK, no enum de Postgres: evita la trampa `55P04` de ampliar enums que este dominio ya pagó (0101, 0176) — `en_espera` entra así desde el nacimiento, y una futura `cancelado` es un `ALTER … DROP/ADD CONSTRAINT`.
- `ck_…_espera` es bicondicional: al salir de `en_espera` (a `pendiente`, `enviado`, `error`…) el `UPDATE` **debe** poner `sync_version_espera` y `en_espera_desde` a `NULL`. Si el backend lo olvida, la base lo rechaza (es la red que queremos).
- `en_matriz` y `pagado_marcado` se guardan del `AdjuntoRecibido` sin lógica (D-5). (En la v1 del diseño la RN-07 ya los nombraba pero faltaban en el modelo.)
- `soporte_id` sin FK: un soporte borrado en cascada se re-resuelve en el envío (ver §7). `impuesto_id` sí con FK `ON DELETE CASCADE`.
- `id_flit2` **no** se copia: se lee por join `flito_impuestos → flito_tramites` en la toma (el CHECK de `flito_tramites` garantiza que existe con `fuente='flit2'`). Tampoco se copia `flit_estado`: se lee del trámite en la toma.

**Migración** `apps/api/src/db/migrations/0219_flito_impuesto_envios_flit2.sql` (o el siguiente número libre al rebasear sobre `develop`; con sesiones en paralelo, comprobar antes del PR). Aún no aplicada en ningún ambiente, así que nace ya con `en_espera`, `sync_version_espera`, `en_espera_desde`, `en_matriz`, `pagado_marcado`, el CHECK `ck_…_espera` y el índice parcial `(estado, proximo_intento_en) WHERE estado IN ('pendiente','en_espera')` — **no** hay migración de ampliación. SQL plano, sin `BEGIN/COMMIT` (el runner envuelve), idempotente: `CREATE TABLE IF NOT EXISTS` (CHECKs dentro), `CREATE UNIQUE INDEX IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS … WHERE estado IN ('pendiente','en_espera')`. **Sin backfill** (AC3: sin retroactivo). Verificación P6: aplicar ese archivo dos veces sobre la BD local ya migrada. Requiere `db-review-agent`. Si el backend ya hubiera escrito una versión anterior del SQL **sin aplicarla en ningún lado**, se edita ese mismo archivo (seguro antes de aplicar).

---

## 7. Reglas del servicio (`flito-impuestos.envio-flit2.service.ts`)

Cabecera con RN numeradas; resumen:

- **RN-01 Disparo (outbox).** `programarEnvioFlit2(tx, impuestoId, ahora)`:
  1. Lee en la `tx` el trámite del impuesto; si `fuente ≠ 'flit2'` → no hace nada (AC3).
  2. Elige soporte con `elegirComprobante(tx, impuestoId)`: el `recibo_impuesto` no descartado más reciente; si no hay, el `recibo_caja_impuesto` no descartado más reciente; `recibo_impuesto_sin_marca_agua` nunca (AC2). Función pura de orden + consulta, exportada para el test.
  3. `INSERT … ON CONFLICT (impuesto_id) DO UPDATE` con estas reglas de transición (el `DO UPDATE … WHERE` las hace atómicas):

     | Fila previa | Soporte elegido | Resultado |
     |---|---|---|
     | no existe | sí | `pendiente`, `intentos=0`, `proximo_intento_en=ahora` |
     | no existe | no | `sin_comprobante` (AC4: sin error ni intentos) |
     | `sin_comprobante` | sí | → `pendiente` (AC4) |
     | `pendiente` | sí, distinto | actualiza `soporte_id` (intentos se conservan) |
     | `en_espera` | sí, distinto | actualiza `soporte_id`; sigue `en_espera` (sale con el feed o el sondeo de 24 h) |
     | `enviado` | sí, **distinto** de `soporte_enviado_id` | → `pendiente`, `intentos=0`, `version+1` (reversa + repago con otro recibo: FLIT 2 lo reemplaza y devuelve `reemplazoDe`) — D-2 |
     | `enviado` mismo soporte · `ya_cargado_gestor` · `error` | — | no toca |

- **RN-02 Sin retroactivo.** Solo `programarEnvioFlit2` **crea** filas, y solo desde un camino a `pagado`. `completarComprobanteFlit2(tx, impuestoId)` —el de `adjuntarAPagado`— **solo** promueve una fila **existente** en `sin_comprobante` (o refresca la de `pendiente`/`en_espera`); si no hay fila no crea nada. Sin esta separación, cargar la copia de otra fase sobre un impuesto pagado antes del despliegue lo enviaría (violaría el AC3).
- **RN-03 Toma.** CTE en una sola sentencia (calco de `tomarLote` de Siigo), con join a `flito_impuestos.estado = 'pagado'` y `flito_tramites t` (`t.fuente='flit2'`) y arrendamiento `(e.tomado_en IS NULL OR e.tomado_en < ahora - 5 min)`; elegibles:

  ```sql
  (e.estado = 'pendiente' AND e.proximo_intento_en <= $ahora)
  OR (e.estado = 'en_espera' AND (
        e.proximo_intento_en <= $ahora                                -- red de seguridad: sondeo 24 h
     OR (t.sync_version > e.sync_version_espera                       -- el feed movió el trámite…
         AND t.flit_estado IN ($admiten))))                           -- …a un estado que admite el adjunto
  ```

  `$admiten` = `ESTADOS_FLIT2_ADMITEN_ADJUNTO` mapeado con `estadoDesdeFlit2(c).flitEstado` (hoy `'Preasignacion','Asignado','Entregado','Rechazado'`): se deriva de `flit2-mapeo.ts`, **no** se escribe el literal capitalizado a mano, para no desalinearse de la grafía que escribe el feed. `rechazado` entra aunque no se sepa si tiene subsanación activa (FLITO no lo persiste): si FLIT 2 vuelve a responder `terminal:false`, la fila se re-estaciona con la versión nueva, sin gastar intento. `ORDER BY e.proximo_intento_en, e.created_at LIMIT $lote FOR UPDATE OF e SKIP LOCKED`; `UPDATE … SET tomado_por, tomado_en RETURNING id, impuesto_id, soporte_id, intentos, version, estado, en_espera_desde, id_flit2, t.sync_version`. Fechas como texto ISO con `::timestamptz` (postgres.js no serializa `Date` en `db.execute`). `$lote` = 50, o **1** en ciclo de sondeo (RN-05). Un impuesto reversado fuera de `pagado` no se toma: su fila espera sin gastar intentos y sale si se vuelve a pagar. (Las filas `en_espera` despertadas por versión tienen `proximo_intento_en` futuro y ordenan detrás de las `pendiente`; con lote 50 no es problema.)
- **RN-04 Ritmo y concurrencia (AC7).** Ciclo cada 60 s bajo `withLock('flito-impuestos-envio-flit2', 5 min)`; lote ≤ 50 por ciclo (≤ 50/min global frente a 120/min por `client_id` en ventana deslizante, compartidos con el feed y la URL de factura); `conConcurrencia(filas, 4, enviarUna)`; plazo del ciclo 50 s: lo no empezado se libera (`tomado_en = NULL`). Un `espera` o `pausa` corta el ciclo: las filas no empezadas se liberan sin tocar intentos. `estacionar` **no** corta el ciclo (es del trámite, no de la cola). Reutiliza el JWT cacheado: el token (10/min por IP) no se pide por envío.
- **RN-05 Habilitación y pausa global (AC7).** Al inicio de cada ciclo: `env.FLIT2_ADJUNTOS_ENVIO_HABILITADO` ∧ `fuenteHabilitada('flit2')` ∧ sin pausa vigente. Si no → el ciclo no toma nada (las filas siguen como están, intentos intactos) y sale al reactivarse. **La pausa se persiste** en `system_locks` con la clave `flito-impuestos-envio-flit2:pausa`, vencimiento = fin de la pausa y el `codigo` como dueño/metadato (global entre procesos; sin tabla nueva). Si `withLock` no expone «adquirir con TTL sin liberar», se añade una función hermana en el mismo archivo de `system_locks`, no una tabla. Duración: `pausa` (`no_disponible`, `insufficient_scope`, `invalid_tipo`) → **20 min** (constante `PAUSA_ENVIO_FLIT2_MS`, comentada con el rango acordado 15-30 min: el 404 sin cuerpo gasta cuota); error del pase → `Flit2BloqueadoError.hasta` o 15 min. **Sondeo:** el primer ciclo tras vencer una pausa toma **lote = 1**; si vuelve a dar `pausa`, se renueva la pausa (una sola petición cada 20 min); si da cualquier otro desenlace, se borra la marca y el ciclo siguiente vuelve al lote normal. (`FLIT2_SYNC_CRON` **no** gobierna el envío — D-3.)
- **RN-06 Envío de una fila.** Re-valida el soporte (si `soporte_id` quedó descartado o ya no existe → re-elige con RN-01.2; sin soporte → `sin_comprobante`). `statEntityDocument` → pre-validación de tamaño (0 < tamaño ≤ 20 MB); lee bytes de S3; `tipoPorBytes` → pre-validación de MIME; fuera de límite → `error` sin llamada (§5). `registrarAccesoSistema(impuestoId, ['comprobante_pago_impuesto'], 'envio_flit2 intento N')`, calcula sha256 local, nombre genérico, llama `enviarAdjunto`.
- **RN-07 Escritura del desenlace.** `UPDATE … WHERE id = $1 AND version = $tomada` (si la #13269 reprogramó mientras tanto, el desenlace viejo no pisa la fila nueva: se audita como «desenlace descartado por reprogramación»). Siempre limpia `tomado_por/tomado_en`, escribe `ultimo_intento_en`, `ultimo_resultado`, `ultimo_status`. Toda salida de `en_espera` pone `sync_version_espera` y `en_espera_desde` a `NULL` (CHECK `ck_…_espera`).
  - `enviado` → `estado='enviado'`, `intentos+1`, `adjunto_id`, `sha256`, `reemplazo_de`, `en_matriz`, `pagado_marcado` (solo se guardan), `soporte_enviado_id=soporte_id`, `enviado_en`. 200 idempotente: igual, sin contarlo como fallo (AC8).
  - `reintentable` → `intentos+1`; si `intentos+1 >= 3` → `estado='error'`; si no → `estado='pendiente'`, `proximo_intento_en = ahora + [5 min, 30 min][intentos]`.
  - `estacionar` → intentos **sin** tocar, `estado_flit2`; si `en_espera_desde` (de la fila tomada) es `<= ahora - 30 días` → `estado='error'`, `ultimo_resultado='espera_vencida'`; si no → `estado='en_espera'`, `sync_version_espera = t.sync_version` (la leída en la toma), `en_espera_desde = COALESCE(en_espera_desde, ahora)`, `proximo_intento_en = ahora + 24 h`.
  - `espera` (429) → `proximo_intento_en = ahora + segundos`, intentos y estado **sin** tocar.
  - `pausa` / error del pase → intentos y estado sin tocar, `proximo_intento_en` sin tocar (la pausa la gobierna RN-05, no la fila); marca de pausa en `system_locks`.
  - `definitivo` (FLIT 2) → `intentos+1`, estado `ya_cargado_gestor` (attachment_exists) o `error` (con `estado_flit2` si es `terminal:true`). `definitivo` local (pre-validación) → `error`, intentos sin tocar.
- **RN-08 Bitácora (AC9).** Por cada intento que llegó a FLIT 2, por cada estacionamiento y por cada `error` local (pre-validación, `espera_vencida`): `audit_logs` `{ userId: null, userEmail: 'sistema', action: 'update', resource: 'flito_impuesto', resourceId: impuestoId, detail: 'Envío a FLIT 2 · intento N · <resultado> · estado FLIT 2 <estado|—> · adjunto <uuid|—> · soporte <uuid>' }`. El **motivo** del `error` vive aquí (D-4), no en el DTO. Las esperas (429) y pausas no se auditan por fila (serían ruido); van a `log.info` con contadores. Logs: solo `impuestoId`, `idFlit2`, `status`, `codigo`. Nunca nombre de archivo, URL, `detail` de FLIT 2 ni placa.
- **RN-09 Lectura (AC10).** `envioFlit2DeImpuesto(impuestoId, fuente)` → `null` si el trámite no es `flit2` **o** no hay fila; si no, `{ estado, intentos, ultimoIntentoEn }` (incluye `en_espera` como estado visible del indicador).

---

## 8. Contrato de endpoints

Sin endpoints nuevos. Delta en `GET /api/flito/impuestos/:id` (detalle, `detalleImpuesto`):

```jsonc
{
  // … campos actuales …
  "envioFlit2": {                     // null si el trámite no es FLIT 2 o no hay envío programado
    "estado": "pendiente" | "en_espera" | "enviado" | "ya_cargado_gestor" | "error" | "sin_comprobante",
    "intentos": 2,                    // solo los que consumen intento (no 429, ni pausas, ni en_espera, ni pre-validación local)
    "ultimoIntentoEn": "2026-10-02T15:04:05.000Z" | null
  }
}
```

Mismas guardas que hoy (`authMiddleware` + frontera `buscarConAcceso`). No expone `adjuntoId`, `pagadoMarcado` ni códigos/motivos de error (D-4: el motivo va a auditoría).

## 9. Impacto en `shared-types`

Archivo nuevo `packages/shared-types/src/flito-envio-flit2.ts` (re-exportado en el `index`):

```ts
export const EstadoEnvioFlit2 = {
  PENDIENTE: 'pendiente', EN_ESPERA: 'en_espera', ENVIADO: 'enviado',
  YA_CARGADO_GESTOR: 'ya_cargado_gestor', ERROR: 'error', SIN_COMPROBANTE: 'sin_comprobante',
} as const;
export type EstadoEnvioFlit2 = typeof EstadoEnvioFlit2[keyof typeof EstadoEnvioFlit2];
export interface EnvioComprobanteFlit2 { estado: EstadoEnvioFlit2; intentos: number; ultimoIntentoEn: string | null }
export const MAX_INTENTOS_ENVIO_FLIT2 = 3;
```

Tipo **nuevo**: no cambia ninguno existente; `ImpuestoDetalle` vive en el servicio y gana un campo opcional para el web. `grep` obligatorio en `apps/web` de `ImpuestoDetalle`/consumidor del detalle solo para confirmar que el campo nuevo no rompe (es aditivo). Si el web pinta el indicador, `en_espera` necesita su etiqueta («Esperando a FLIT 2» o la que defina `ux-agent`). Build de shared-types en la verificación. El CHECK de la migración y este objeto deben listar los mismos seis valores (test de paridad sugerido en §10).

## 10. Archivos a crear / modificar

**Crear**
| Archivo | Contenido |
|---|---|
| `apps/api/src/db/migrations/0219_flito_impuesto_envios_flit2.sql` | Tabla + índices + CHECKs (incluye `en_espera`, `ck_…_espera`, índice parcial de cola sobre `pendiente`/`en_espera`), idempotente |
| `apps/api/src/modules/flito-sync/flit2-adjuntos.ts` | `clasificarRespuestaAdjunto` (pura), `leerProblema`, `urlDeEnvioAdjunto`, schema Zod de `AdjuntoRecibido`, constantes (`TIPO_LIQUIDACION_IMPUESTO`, `MAX_BYTES_ADJUNTO = 20 971 520`, MIME permitidos, `ESTADOS_FLIT2_ADMITEN_ADJUNTO`). Mantiene `flit2-sync-http.adapter.ts` (321 líneas) delgado |
| `apps/api/src/modules/flito-impuestos/flito-impuestos.envio-flit2.service.ts` | RN-01..RN-09: `programarEnvioFlit2`, `completarComprobanteFlit2`, `elegirComprobante`, `tomarLoteEnvios`, `procesarCicloEnvioFlit2`, `envioFlit2DeImpuesto`, pausa global (`leerPausaEnvio`/`pausarEnvio`), `EnvioFlit2Error`. Si se acerca a 800 líneas, la toma y la pausa se separan en `flito-impuestos.envio-flit2.cola.ts` |
| `apps/api/src/modules/flito-impuestos/flito-impuestos-envio-flit2.cron.ts` | `start/stopImpuestosEnvioFlit2Cron` (60 s, arranque a 30 s, `IMPUESTOS_ENVIO_FLIT2_CRON_ENABLED=0` lo apaga) |
| `packages/shared-types/src/flito-envio-flit2.ts` | §9 |
| Tests (`apps/api/src/__tests__/…`, ubicación del módulo): `flit2-adjuntos.test.ts` (tabla §5 fila a fila: 404 sin cuerpo vs `procedure_not_found`, 409 `terminal` true/false/ausente, `attachment_exists` sin extensiones, 429 con `Retry-After`), `flito-impuestos.envio-flit2.test.ts` (transiciones RN-01/02/07, `estacionar` sin intento + re-estacionar con versión nueva + 30 días → `error`, sin retroactivo, version guard, ritmo/corte de ciclo, sondeo de lote 1 tras pausa, pre-validación sin llamada), `flit2-sync-http.adapter.enviar-adjunto.test.ts` (multipart con `Content-Type` de la parte `file`, 401 → renovación única, 404 sin cuerpo), test estático de la 0219 (idempotencia textual, paridad del CHECK con `EstadoEnvioFlit2`; **no** asertar «es la última migración») | |

**Modificar (una llamada por camino; lógica fuera)**
| Archivo | Cambio |
|---|---|
| `apps/api/src/db/schema.ts` | `flitoImpuestoEnviosFlit2` (§6) |
| `apps/api/src/config/env.ts` | `FLIT2_ADJUNTOS_ENVIO_HABILITADO` (booleano, default `false`, mismo `transform` que `FLIT2_SYNC_CRON` pero invertido) |
| `apps/api/src/modules/flito-sync/flit2-sync.port.ts` | tipos §5 + método |
| `apps/api/src/modules/flito-sync/flit2-sync-http.adapter.ts` | `enviarAdjunto` (usa `flit2-adjuntos.ts`, `conPase`) |
| `apps/api/src/modules/flito-sync/flit2-sync-fake.adapter.ts` | `enviarAdjunto` con guion |
| `apps/api/src/modules/flito-impuestos/flito-recibos.service.ts` | `conciliar`: `await programarEnvioFlit2(tx, cand.impuestoId)` al final (cubre masiva, fase, recibo de caja, comprobantes universales). `adjuntarAPagado`: `await completarComprobanteFlit2(tx, pagado.impuestoId)` dentro de su `tx` |
| `apps/api/src/modules/flito-revisiones/flito-revisiones.service.ts` | `resolverImpuesto`: `await programarEnvioFlit2(tx, impuestoId)` tras el UPDATE a pagado |
| `apps/api/src/modules/flito-impuestos/flito-impuestos.service.ts` | `reversar`: si `estadoDestino === PAGADO` → `programarEnvioFlit2(tx, id)`. `detalleImpuesto`: `envioFlit2` (RN-09) y el campo en `ImpuestoDetalle` |
| `apps/api/src/server.ts` | `startImpuestosEnvioFlit2Cron()` junto a `startImpuestosAnalisisCron()`; stop en el apagado |
| `packages/shared-types/src/index.ts` | re-export |
| `.env.example` / `docs/integraciones/flit2-api.md` | variable nueva y §7 del contrato con la referencia `flitsas/flit@c2b7f68db` (sin hosts) |

`apps/web`: fuera de la #13268 salvo que la HU pida pintarlo (el AC10 dice «expone»). Si se pinta, es un `frontend-agent` con `ux-agent` slim (chip de estado en el detalle del impuesto, con `en_espera` incluido).

## 11. Notas operativas por agente

- **backend-agent:** P1 = los 4 archivos de test de §10. No tocar la lógica de `conciliar` más allá de la línea de llamada. Imports con `.js`. `db.execute` con fechas ISO + cast. `FormData`/`Blob` nativos (Node 22): **sin dependencias nuevas**. `$admiten` de RN-03 se deriva de `estadoDesdeFlit2`, no con literales capitalizados. El mock `chain` devuelve filas enteras e ignora `orderBy`: la elección AC2 (recibo antes que caja; sin marca jamás) y la condición de despertar de RN-03 se prueban con la función pura **y** leyendo el SQL renderizado, no confiando en el mock. El stub pelado de `transaction` en specs vecinos: `programarEnvioFlit2` dentro de `conciliar` hará `select` en la `tx`; revisar que los specs de recibos/comprobantes/revisiones que mockean `tx` no revienten (añadir el método al stub si hace falta, no cambiar producción). Fijar `TZ=UTC` en los tests de 24 h / 30 días.
- **db-review-agent:** tabla nueva, CHECKs (incluido el bicondicional `ck_…_espera`), índice parcial de cola `(estado, proximo_intento_en) WHERE estado IN ('pendiente','en_espera')`, FK cascade a `flito_impuestos`, `soporte_id` sin FK (justificado). La toma de `en_espera` lee `flito_tramites.sync_version`/`flit_estado` por join (sin índice nuevo: las filas `en_espera` son pocas). Número de migración contra el tip de `develop`.
- **security-agent:** dispara (integración externa, lectura de PII documental, credencial). Revisar: nada de URL/nombre/`detail` en logs; `pii_access_log` por lectura; nombre de archivo genérico hacia FLIT 2; `redirect: 'error'`; tamaño validado con `statEntityDocument` antes de leer todo a memoria.
- **devops-agent / despliegue:** la migración la aplica el CD en DEV; FLITO puede mergear con la variable apagada. En cada ambiente `FLIT2_ADJUNTOS_ENVIO_HABILITADO` queda apagada hasta que FLIT 2 confirme la HU #13263 desplegada **en ese ambiente** y el scope `external.tramites.attachments.write` esté en el cliente. **En PDN**, además, la HU #13265 de FLIT 2 (bloqueo del gestor) tiene que estar allí antes o a la vez.
- **qa-agent:** matriz AC→TC sobre la tabla §5 y la de RN-01. Mutantes sugeridos: (1) `programarEnvioFlit2` sin la guarda `fuente='flit2'` → debe matar el TC del AC3; (2) `estacionar` que sume intento (o `espera` que sume intento) → mata AC7 / D-1; (3) `completarComprobanteFlit2` que cree fila → mata «sin retroactivo».

## 12. HU #13269 — Reemplazar comprobante (delta SLIM)

**Patrón reutilizado:** la misma fila de `flito_impuesto_envios_flit2` y el mismo cron (§6-§7); FLIT 2 reemplaza el adjunto anterior de FLITO al recibir otro y devuelve `reemplazoDe`. El reemplazo se acepta en **todos** los estados de FLIT 2 que admiten envío, **incluido `entregado`**. FLITO **no** decide nada con `pagadoMarcado` (solo lo guarda). Semántica decidida por David el 2026-10-05: refleja la marca vigente del consumidor sobre el trámite (marcado en `preasignacion` y reemplazado en `entregado` → `true`; primer envío en `entregado` → `false`).

**Contrato delta:** función `reprogramarEnvioFlit2(tx, impuestoId, soporteNuevoId, ctx)` llamada desde el flujo de reemplazo de comprobante de la #13269 (dentro de su transacción, después de descartar el soporte viejo e insertar el nuevo):
- Fila `enviado` | `error` | `pendiente` | `en_espera` | `sin_comprobante` → `estado='pendiente'`, `soporte_id = nuevo`, `intentos=0`, `proximo_intento_en=ahora`, `version = version + 1`, limpia `tomado_*`, `ultimo_resultado`, `sync_version_espera` y `en_espera_desde`. Audita «reprogramado por reemplazo». (Si el trámite sigue sin admitir el adjunto, el envío lo re-estaciona en `en_espera` sin gastar intento.)
- Fila `ya_cargado_gestor` → no se reenvía (gana el gestor, contrato §7): devuelve `{ reenviado: false, motivo: 'ya_cargado_gestor' }` para que la UI lo diga.
- Sin fila (trámite pagado antes del despliegue o no FLIT 2) → no se envía (D-5).
- El guard `version` de RN-07 garantiza que un envío en vuelo del soporte viejo no pisa la reprogramación.
- Al confirmar el 201, `reemplazo_de` queda con el `adjuntoId` anterior (trazabilidad del reemplazo en FLIT 2).

**Archivos:** solo `flito-impuestos.envio-flit2.service.ts` (+ su test) y el servicio del reemplazo que diseñe la #13269. **Sin migración nueva**: `version`, `reemplazo_de`, `soporte_enviado_id` y las columnas de espera ya nacen en la 0219.
**ADR:** no aplica (cubierto por ADR-0020).

## 13. Decisiones cerradas (2026-10-05)

Acordadas por David con la sesión FLIT 2 sobre el contrato `flitsas/flit@c2b7f68db` (PR #513).

| # | Pregunta | Decisión |
|---|---|---|
| **D-1** (ex P-1) | ¿Qué hacer con 409 `not_allowed_in_state terminal:false`? | **Resuelta por el feed + red de seguridad**: no gasta intento; la fila pasa a `en_espera` con `sync_version_espera`; se despierta cuando `flito_tramites.sync_version` la supera y `flit_estado` ∈ {preasignación, asignado, entregado, rechazado} (FLITO **sí** persiste el estado del feed en `flit_estado`); si vuelve `terminal:false`, se re-estaciona con la versión nueva sin gastar intento; sondeo cada 24 h; a los 30 días → `error` (`espera_vencida`). RN-03, RN-07, §4, §6, §8, §9. |
| **D-2** (ex P-2) | Reversa + repago con **otro** recibo cuando ya estaba `enviado`. | Reenviar (RN-01, regla «enviado + soporte distinto»). |
| **D-3** (ex P-3) | ¿`FLIT2_SYNC_CRON` apaga también el envío? | No: el envío lo gobiernan `FLIT2_ADJUNTOS_ENVIO_HABILITADO` + interruptor `flit2`. |
| **D-4** (ex P-4) | ¿El detalle muestra el motivo del `error`? | No: solo estado/intentos/fecha; el motivo va a auditoría (RN-08). El indicador incluye `en_espera`. |
| **D-5** (ex P-5) | (#13269) Reemplazo de un impuesto pagado antes del despliegue (sin fila). | No se envía. |
| **D-6** (ex P-6) | Pagos entre el despliegue y el encendido de la variable. | Correcto: quedan `pendiente` y salen al encender. |
| **D-7** | Catálogo de respuestas. | 401 `invalid_token` (+ `WWW-Authenticate: Bearer`) → renovar una vez y reintentar; 429 siempre con `Retry-After` entero; `estado`/`terminal` solo en `not_allowed_in_state`; `attachment_exists` sin extensiones; idempotencia contra el adjunto vigente **del consumidor** (gestor primero → 409 aunque el sha coincida → `ya_cargado_gestor`); 404 sin cuerpo → pausa con sondeo de 1 petición cada 15-30 min (aquí 20). §5, RN-05. |
| **D-8** | Límites y cuota. | MIME pdf/jpeg/png/webp por `Content-Type` de la parte `file`; ≤ 20 MB; vacío = `missing_file`; FLITO pre-valida y no gasta llamada. Scope `external.tramites.attachments.write` (alta en FLIT 2 #13263). 120 req/min por `client_id` en ventana deslizante compartida con feed y URL de factura; token 10/min por IP; JWT cacheado. |
| **D-9** | Plazos. | FLITO puede mergear antes con la variable apagada. **Precondición del encendido en PDN:** FLIT 2 #13265 (bloqueo del gestor) en PDN con las HUs #13263 (endpoint) y #13264 (marca de pagado) o antes. |

Riesgos:
- **Contrato sin mergear** (PR flitsas/flit#513, `x-estado: anunciada`): si cambia un `code`, cambia solo `flit2-adjuntos.ts`. La variable apagada evita que DEV/QA quemen cuota contra la ruta 404; y si se enciende antes, la pausa con sondeo de lote 1 cada 20 min limita el gasto.
- **Encendido en PDN sin la #13265 de FLIT 2:** el gestor podría pisar o quedar bloqueado de forma inconsistente frente al adjunto de FLITO. Mitigación: precondición explícita (D-9) en el checklist de `devops-agent`/`flit-release`.
- **Cuota compartida**: 50/min + feed + URL de factura ≤ 120/min (ventana deslizante); un 429 corta el ciclo y no consume intento. Si el feed se acelera, bajar el lote (constante con su cuenta comentada, como `SIIGO_COLA_LOTE_DEFECTO`).
- **`rechazado` sin dato de subsanación en FLITO:** la toma despierta las filas de trámites `rechazado` aunque no tengan subsanación activa; el costo es una petición que vuelve a `terminal:false` y re-estaciona (sin intento) por cada cambio de versión del trámite. Aceptable.
- **Séptimo camino a pagado** futuro sin la llamada: mitigado por la centralización en `conciliar`; el test de RN-01 enumera los caminos conocidos.
- **Memoria**: hasta 4 × 20 MB en vuelo por ciclo; aceptable. Leer el tamaño con `statEntityDocument` antes de bajar el objeto.

Abiertas (no bloquean la #13268):
