-- 0298_flito_logistica_corte_proveedor.sql
-- Autor: David Chica
-- HU #14349 (Feature #14326, ADR-0039 §6.3, R17). Fecha de corte de la operación por proveedor en este ambiente y reparto de las licencias anteriores.
--
-- El corte queda solo: `db-apply` corre esta migración en el rollout de cada ambiente, sin paso manual ni variable de entorno.
-- Sin BEGIN/COMMIT (ADR-DB-001): lo pone el runner. Idempotente: se puede aplicar dos veces.
--
-- Costo con `strategy: Recreate` en PDN (la API está caída mientras corre): una pasada sobre las LT, con dos consultas
-- de acta abierta por fila, que entran por la PK del acta y por el `documento_id` de las líneas. Sin un límite, un lock
-- ajeno dejaría esperando la migración sin ningún error en el log: así falla a los 30 s y queda visible en el initContainer.
SET LOCAL lock_timeout = '30s';

-- ── Una sola fila: la PK es `unica` y el CHECK solo admite true. ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS flito_logistica_corte_proveedor (
  unica boolean PRIMARY KEY DEFAULT true CONSTRAINT ck_flito_log_corte_proveedor_unica CHECK (unica),
  corte_en timestamptz NOT NULL DEFAULT now()
);

-- ── Registro del corte y normalización de dueños, en UNA sola sentencia (#14349 AC2, AC5, AC6) ──────────
-- La normalización cuelga del `RETURNING`: corre solo si esta ejecución registró la fecha. Si ya había corte, el INSERT
-- no devuelve filas y no se toca ninguna licencia. Las condiciones por sí solas no bastan en una segunda corrida en un
-- despliegue posterior (`--allow-drift` reejecuta un pendiente): borrarían el dueño de una licencia que el proveedor
-- entregó después del corte, y el de una cuya compañía se quedó sin proveedor, que conserva el suyo (ADR §6.3).
--
-- Entre el PR 1 y el PR 2 una licencia con dueño pudo entrar a un acta o entregarse: el backfill de la 0296 no basta.
--   · Anterior al corte y entregada, o en un acta abierta anterior → sin dueño. Al cerrarse esa acta,
--     `pasarAlProveedorVigente` lleva lo no entregado al proveedor vigente.
--   · Anterior al corte, no entregada y sin acta abierta → proveedor de su compañía, o sin dueño si no tiene. Una licencia
--     pendiente de trámite (`compania_id` NULL) queda sin dueño.
--   · Compañía autogestionada → sin dueño, aunque conserve un proveedor asignado (decisión del agente en F4.2, declarada al
--     humano): ningún tercero ve las licencias de una compañía cuya logística no gestiona FLITO.
--   · Solo en un acta abierta posterior al corte (la creó el pod viejo durante el rollout) → no se toca.
-- Acta abierta por las dos vías que usa el módulo: `documentos.acta_id` (actas sin viaje) y las líneas del acta.
-- `updated_at` no cambia: es un reparto interno, no actividad de la licencia.
WITH registro AS (
  INSERT INTO flito_logistica_corte_proveedor (unica, corte_en)
  VALUES (true, now())
  ON CONFLICT (unica) DO NOTHING
  RETURNING corte_en
), anteriores AS (
  SELECT d.id, d.estado, d.proveedor_logistica_id, r.corte_en,
         (SELECT c.flito_proveedor_logistica_id FROM clients c WHERE c.id = d.compania_id AND NOT c.logistica_autogestionable) AS proveedor_compania,
         (SELECT min(abierta.created_at) FROM (
            SELECT a.created_at FROM flito_logistica_actas a
             WHERE a.id = d.acta_id AND a.estado IN ('generada', 'despachada')
            UNION ALL
            SELECT a.created_at FROM flito_logistica_acta_lineas l
              JOIN flito_logistica_actas a ON a.id = l.acta_id
             WHERE l.documento_id = d.id AND a.estado IN ('generada', 'despachada')
          ) abierta) AS acta_abierta_en
    FROM flito_logistica_documentos d
   CROSS JOIN registro r
   WHERE d.tipo = 'licencia_transito'
     AND d.created_at < r.corte_en
), reparto AS (
  SELECT id, proveedor_logistica_id,
         CASE WHEN estado = 'entregado' OR acta_abierta_en < corte_en THEN NULL ELSE proveedor_compania END AS dueno
    FROM anteriores
   WHERE acta_abierta_en IS NULL OR acta_abierta_en < corte_en
)
UPDATE flito_logistica_documentos d
   SET proveedor_logistica_id = reparto.dueno
  FROM reparto
 WHERE d.id = reparto.id
   AND reparto.proveedor_logistica_id IS DISTINCT FROM reparto.dueno;
