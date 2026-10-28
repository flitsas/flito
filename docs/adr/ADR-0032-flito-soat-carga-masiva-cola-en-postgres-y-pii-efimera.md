# ADR-0032 — FLITO SOAT: carga masiva sin trámite con cola en Postgres (`FOR UPDATE SKIP LOCKED`) y PII de las filas efímera

- **Estado:** Propuesto (lo aprueba el Líder Técnico humano; no se marca Aceptado aquí)
- **Fecha:** 2026-10-27
- **Contexto de trabajo:** Épica #13760, Features #14013 (renovaciones) y #14014 (Inicial con factura pendiente), HU #14131–#14137
- **Relacionado:** ADR-0012 (tokens HMAC en la auditoría PII), ADR-0019 (incompletas / «Por validar»), ADR-0030 (renovación por placa e incompletas multimodalidad), ADR-0031 (varios SOAT por vehículo, uno abierto)
- **Supersedes:** ninguno. **No contradice** ningún ADR aceptado.
- **Diseño completo:** [`docs/diseno-feature-14013-14014-carga-masiva-soat.md`](../diseno-feature-14013-14014-carga-masiva-soat.md)
- **Módulo:** `flito-soat` canal Cliente (no el `soat/` legacy)

## Contexto

La carga masiva sube hasta 200 filas (XLSX, 1 MB) y cada fila exige una consulta RUNT vía la pasarela Kyverum (segundos por llamada, con 429 posibles y caídas). Eso no cabe en una petición HTTP: hace falta un trabajo asíncrono que **sobreviva al reinicio del pod y a que el usuario cierre la vista**. El repo no tiene cola de trabajos: los trabajos de fondo son `setInterval` por módulo con candado (`withLock`, `system_locks`) y puerta positiva por variable de entorno (`flito-soat-retencion.cron.ts`, `flito-soat-vigencia.cron.ts`). Redis existe (`shared/redis.ts`: rate limiting, caché), pero **no** se usa como almacén durable de trabajo.

Además las filas llevan PII (placa, documento, nombre, correo, celular del propietario) que solo se necesita mientras la fila se resuelve (Ley 1581, principio de finalidad y supresión; AGENTS.md §14 y §16).

## Decisión

1. **Cola = tablas en Postgres.** `flito_soat_masivo_lotes` y `flito_soat_masivo_filas`. El worker corre **en la misma API** (cron `setInterval`, puerta positiva `SOAT_MASIVO_WORKER_ENABLED=1`) y reclama filas con `FOR UPDATE SKIP LOCKED`. Sin Redis/BullMQ ni dependencia nueva.
2. **Concurrencia:** 2 filas en vuelo por proceso; tope **por compañía aplicado en la base** (el reclamo bloquea primero la fila del lote con `FOR UPDATE SKIP LOCKED`, cuenta las `consultando` de la compañía y reclama solo el cupo libre), de modo que el tope vale aunque haya varias réplicas. Si la pasarela responde 429, el proceso entra en pausa con backoff exponencial y las filas vuelven a `pendiente` **sin gastar su reintento**.
3. **Recuperación:** una fila `consultando` cuyo arrendamiento (`reclamada_en`) venció se devuelve a `pendiente` sumando un intento (una fila que mata el pod no puede ciclar para siempre). Cada fila usa un `soat_id_reservado` fijado al reclamarla, de modo que repetir el efecto tras una caída a mitad es **idempotente** (se detecta la incompleta/SOAT con ese id en lugar de rechazar por duplicado).
4. **Un lote activo por compañía:** índice único parcial sobre `compania_id` donde `estado IN ('en_cola','procesando')`.
5. **PII de filas efímera:** al terminar el lote se anonimiza (se nulifican las columnas con PII de las filas aceptadas y por validar, que ya viven en `flito_compradores` / `flito_soat_incompletas` con su tratamiento normal). Las **rechazadas** conservan la PII solo para armar al vuelo el Excel de «Descargar rechazadas»; se borra tras la descarga (con una gracia corta para repetirla) o a las 24 h desde que terminó el lote, lo primero. Ningún archivo subido se guarda (solo se procesa en memoria; no se persiste el XLSX ni su nombre).
6. **Auditoría:** un `logPiiAccess` por lote en el alta y uno por cada descarga de rechazadas; placa/documento solo como HMAC (ADR-0012) y logs solo con ids.
7. **Polling** del avance cada 2–3 s; solo XLSX con `exceljs` (ya en `apps/api/package.json`).

## Alternativas consideradas

| | Descripción | Veredicto |
|---|---|---|
| **A. Postgres + `SKIP LOCKED`, worker en la API (elegida)** | Sin infraestructura nueva; el estado es durable y consultable; transaccional con las tablas de dominio; el reclamo es atómico entre réplicas | Elegida (decisión del humano, validada contra B y C) |
| B. BullMQ + Redis | Reintentos/backoff/rate limiting maduros | Descartada: dependencia nueva (la barra es alta, AGENTS.md), Redis no es durable en esta infra (el lote se perdería con un reinicio de Redis), el estado de negocio (aceptada/por validar/rechazada) igual hay que persistirlo en Postgres → doble fuente de verdad |
| C. Bucle en memoria dentro de la petición/proceso (fire-and-forget) | Lo más simple | Descartada: no sobrevive al reinicio del pod ni a un rollout GitOps; sin tope entre réplicas; sin recuperación |
| D. Worker en Deployment separado | Aísla carga del tráfico web | Descartada por ahora: otro manifiesto en `flit-gitops` y otra imagen/entrypoint; la carga es baja (≤200 filas, concurrencia 2). Se revisa si la medición en DEV muestra contención |

## Consecuencias y límites declarados

- **Réplicas:** el reclamo es seguro con N pods (cada fila la toma un solo pod), y el tope por compañía es exacto. La capacidad total contra Kyverum es `2 × réplicas`; el cron corriendo en dos pods **no duplica trabajo**, lo reparte. La purga y la recuperación son idempotentes y van bajo `withLock`.
- **Rollout GitOps:** el pod saliente deja de reclamar al recibir SIGTERM y espera sus filas en vuelo hasta el `terminationGracePeriodSeconds` (debe superar el timeout de una llamada RUNT); lo que no alcance se recupera por vencimiento del arrendamiento en otro pod. Con el initContainer `db-apply` el pod nuevo no arranca sin esquema.
- **Transacciones:** el reclamo es una transacción de milisegundos; la llamada a Kyverum va **fuera** de toda transacción; cada resultado se escribe en su propia transacción corta. El cierre del lote es un `UPDATE` condicional idempotente.
- **Ritmo contra Kyverum:** comparte cuota con la preconsulta interactiva; por eso el worker llama a los servicios directamente (no a la ruta limitada a 15/15 min) pero con tope propio y backoff. Hay que **medirlo en DEV** antes de subir la concurrencia.
- **Polling vs Postgres:** una consulta agregada sobre ≤200 filas por sondeo (índice por `lote_id`); acotada por un limiter de lectura.
- **Sin pantalla/Excel de resultados persistente:** el resumen vive mientras el lote vive; después solo quedan contadores congelados en el lote (sin PII).
- **Un lote atascado bloquea la compañía** (única activa): ver «Pendiente humano» sobre un vigilante de lotes huérfanos.
- **Política de retención:** actualizar `docs/privacy/retencion-flito-soat.md` con la PII efímera de las filas (24 h / gracia tras descarga).

## Pendiente de aprobación

Aprobar este ADR; confirmar la gracia de repetición de la descarga (propuesta 15 min), el origen de las 24 h (propuesta: desde `terminado_en`) y la política del lote atascado.
