# ADR-0031 — `flito_soat`: varios SOAT por vehículo con a lo sumo uno abierto (RN-01 reformulada)

## Estado

**Propuesto** — 2026-10-27 por architecture-agent. Pendiente de aprobación del Líder Técnico. Feature [#14012](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/14012) (Épica #13760). Módulo `flito-soat` (no el legacy `soat/`).

**Reformula** la regla RN-01 («un SOAT por VIN», `flito_soat.vin` y `vehiculo_id` `UNIQUE`, migración `0096`) y la lectura que de ella hicieron ADR-0008 §2 y el comentario de `schema.ts` (`flitoSoat`). No contradice ningún ADR aceptado en lo que decide (ADR-0008 conserva la separación canal/satélite; ADR-0010 y ADR-0019 conservan compuerta e incompletas); **sustituye solo la cardinalidad de RN-01**. Complementa [ADR-0030](./ADR-0030-flito-soat-renovacion-runt-por-placa-e-incompletas-multimodalidad.md), cuyo «No resuelve …» sobre RN-01 queda resuelto aquí.

Diseño: [`docs/diseno-feature-14012-modelo-varios-soat-por-vehiculo.md`](../diseno-feature-14012-modelo-varios-soat-por-vehiculo.md).

## Contexto

La renovación de la Épica #13760 debe cubrir SOAT ya gestionados por FLITO. Con `UNIQUE (vin)` y `UNIQUE (vehiculo_id)` incondicionales, renovar da `409 vin_ya_tiene_soat`. Decisión del humano (27-oct): varios SOAT por vehículo, uno abierto a la vez; los anteriores son historial; con uno abierto la consulta dice «ya está en un proceso»; con uno terminal/vigente la preconsulta informa «ya en FLITO + días de vigencia + renovable» (ventana 30 d, vencido = renovable).

Estados del SOAT: `pendiente`, `solicitado`, `con_novedad`, `pagado`. Cada fila es además el hecho contable de una póliza (`pagado_en`, `valor_pagado`, `numero_poliza`, soportes, historial); ~20 módulos leen `flito_soat` por `id`.

## Alternativas

- **A. Índice único parcial «abierto»** (una fila por póliza). Esfuerzo M. Contabilidad y consumidores por `id` intactos; la base garantiza «uno abierto». Coste: volver conscientes del estado los lookups por VIN (sync, excepciones, reintento, RN-01) y el censo del cron.
- **B. Expediente 1:1 por vehículo + tabla hija de ciclos.** Esfuerzo L. Obliga a mover o duplicar estado/pago/póliza/soportes que leen finanzas, liquidación, conciliación, bolsas, tablero y export. Riesgo contable alto.
- **C. Reabrir la misma fila + snapshots de historial.** Esfuerzo S en esquema, pero borra el pago anterior de los agregados y mezcla historiales de estado de dos pólizas.

## Decisión

**A.** Terminal = `pagado` (único); abierto = `estado <> 'pagado'`.
1. Quitar los dos `UNIQUE`; `UNIQUE (vin) WHERE estado <> 'pagado'` y `UNIQUE (vehiculo_id) WHERE estado <> 'pagado'`; índices no únicos de lookup (migración `0267`, sin backfill).
2. «SOAT actual de un vehículo» = el abierto, o el último terminal; una sola función (`soatActualDelVin`) y el censo del cron se alinea (solo la fila actual por vehículo, para no consultar el RUNT por cada póliza histórica).
3. El antecesor de una renovación se guarda en `flito_soat_solicitud.soat_anterior_id` (satélite, no en `flito_soat`: ADR-0008 §1.2).
4. `reversar` no puede reabrir un `pagado` si ya hay otro abierto (409).
5. La preconsulta devuelve `SoatFlitoContexto` (`yaEnFlito`, `abierto`, `diasVigencia`, `renovable`…); al ajeno se le recorta como hasta hoy.
6. Despliegue en dos tiempos: HU0 (modelo + lookups) sola y primero; la creación de la 2.ª fila llega después (HU1).

## Consecuencias

- RN-01 pasa a decir «a lo sumo un SOAT **abierto** por vehículo»; el copy y los comentarios que dicen «un vehículo no puede tener dos» se corrigen.
- La cola muestra una fila por póliza (dos del mismo vehículo si hay renovación y la anterior `pagado`).
- Cualquier `select … where vin = ? limit 1` nuevo sobre `flito_soat` es un defecto: debe usar `soatActualDelVin` (lo cubre un test).
- Rollback de **esquema** solo es posible mientras ningún vehículo tenga >1 fila; después, el rollback es el de código (GitOps) con el esquema relajado, que es compatible con el código viejo.
- No hay estado de anulación: un SOAT abierto atascado bloquea la renovación (pregunta Q2 al humano).
- Coste operativo: ninguna dependencia nueva.

## Relación con otros ADR

- ADR-0006 §8 (índices no únicos para datos viejos): aquí los parciales no pueden fallar en despliegue porque el `UNIQUE` previo garantiza ≤1 fila por vin.
- ADR-0008: sin cambio (`origen`, satélite 1:1).
- ADR-0010 / ADR-0019: sin cambio; el RN-01 que usan se evalúa con el SOAT abierto.
- ADR-0012: tokens HMAC del acceso PII cubren placa/VIN de la consulta.
- ADR-0030: coherente tras este cambio (migraciones renumeradas a 0268/0269).
