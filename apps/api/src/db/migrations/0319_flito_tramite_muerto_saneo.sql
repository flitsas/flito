-- 0319_flito_tramite_muerto_saneo.sql
-- Épica #14707 «Un trámite anulado, abortado o revocado no existe en FLITO» — ADR-0049 §3 («Saneo único») y
-- «Decisiones de producto cerradas» n.º 2, diseño docs/diseno/epica-14707-tramite-muerto.md §5.2. Autor: equipo FLITO.
-- Depende de la 0317 (valor `descartado`) y de la 0318 (columnas, CHECK, trigger, backfill D1 y del originador).
--
-- Saneo HISTÓRICO de los trámites que ya estaban muertos (`estado = 'anulado'`) antes del código nuevo. Una sola vez:
--   - Solo DESCARTA y REASIGNA compañía/organismo (D9). NO desliga vivos (no aplica D3a), NO libera comprobantes ni
--     bolsa (no aplica D11), NO crea avisos y NO mueve dinero. El orquestador en caliente
--     (`flito-sync/descarte-tramite-muerto.ts`) es quien hace todo eso para las transiciones nuevas.
--   - motivo(t) := abortado | revocado según `flit_estado`; cualquier otro muerto, `anulado`.
--   A. Impuestos de muertos → `descartado` (cualquier estado, D5) + fila en `flito_estado_historial` (origen sistema).
--   B. SOAT del canal trámite (`origen = 'tramite'`; el canal Cliente no se toca, decisión cerrada 4), no descartados
--      y ligados a ≥ 1 muerto:
--      B1. abierto y sin vivos ligados → `descartado` (motivo y `descartado_por_tramite_id` = el muerto más reciente).
--      B2. `pagado`, sin vivos ligados y originado por un muerto → `descartado`.
--      B3. abierto con vivos ligados → D9: `compania_id`/`organismo_codigo` ← los del vivo más antiguo si difieren
--          (cada uno solo si el del vivo no es NULL). Rastro en `audit_logs` con el formato de `auditSistema`.
--      B4. `pagado` con vivos ligados → NO se toca (histórico conservador); solo se cuenta.
--   C. RAISE NOTICE con los conteos (se leen en el log del initContainer `db-apply`).
-- Los textos de historial y bitácora llevan el radicado FLIT y los ids: nunca VIN, placa ni PII.
-- Sin BEGIN/COMMIT propio (ADR-DB-001). Idempotente: solo actúa sobre lo que no está `descartado` y la D9 solo
-- escribe si difiere; en la 2.ª corrida impuestos = soat_descartados = soat_heredados = 0 (el conteo de pagados
-- compartidos conservados es informativo: no es una acción y se repite).

DO $$
DECLARE
  n_impuestos integer := 0;
  n_soat_descartados integer := 0;
  n_soat_heredados integer := 0;
  n_pagados_conservados integer := 0;
BEGIN
  -- A. Impuestos de muertos ────────────────────────────────────────────────────────────────────────────────
  WITH obj AS (
    SELECT i.id, i.estado::text AS anterior, t.id_flit,
           CASE lower(trim(t.flit_estado)) WHEN 'abortado' THEN 'abortado' WHEN 'revocado' THEN 'revocado' ELSE 'anulado' END AS motivo
      FROM flito_impuestos i
      JOIN flito_tramites t ON t.id = i.tramite_id
     WHERE t.estado = 'anulado' AND i.estado <> 'descartado'
       FOR UPDATE OF i
  ), upd AS (
    UPDATE flito_impuestos i
       SET estado = 'descartado', descartado_en = now(), motivo_descarte = obj.motivo, updated_at = now()
      FROM obj
     WHERE i.id = obj.id
    RETURNING i.id
  ), his AS (
    INSERT INTO flito_estado_historial (concepto, registro_id, estado_anterior, estado_nuevo, motivo, origen)
    SELECT 'impuesto', obj.id, obj.anterior, 'descartado',
           'Saneo Épica 14707: trámite ' || obj.id_flit || ' ' || obj.motivo || ' en FLIT (histórico, sin aviso).', 'sistema'
      FROM obj JOIN upd ON upd.id = obj.id
    RETURNING 1
  )
  SELECT count(*) INTO n_impuestos FROM his;

  -- B. SOAT ligados a ≥ 1 muerto ───────────────────────────────────────────────────────────────────────────
  DROP TABLE IF EXISTS _saneo_soat;
  CREATE TEMP TABLE _saneo_soat ON COMMIT DROP AS
  SELECT s.id, s.estado::text AS anterior, s.compania_id, s.organismo_codigo,
         (vivo.existe IS TRUE) AS hay_vivo,
         vivo.compania_id AS vivo_compania_id, vivo.organismo_codigo AS vivo_organismo,
         muerto.id AS muerto_id, muerto.id_flit AS muerto_id_flit, muerto.motivo AS muerto_motivo,
         EXISTS (SELECT 1 FROM flito_tramites o WHERE o.id = s.tramite_origen_id AND o.estado = 'anulado') AS origen_muerto
    FROM flito_soat s
    JOIN LATERAL (
      SELECT t.id, t.id_flit,
             CASE lower(trim(t.flit_estado)) WHEN 'abortado' THEN 'abortado' WHEN 'revocado' THEN 'revocado' ELSE 'anulado' END AS motivo
        FROM flito_tramites t
       WHERE t.soat_id = s.id AND t.estado = 'anulado'
       ORDER BY t.updated_at DESC, t.id DESC
       LIMIT 1
    ) muerto ON true
    LEFT JOIN LATERAL (
      SELECT true AS existe, t.compania_id, t.organismo_codigo
        FROM flito_tramites t
       WHERE t.soat_id = s.id AND t.estado IS DISTINCT FROM 'anulado'
       ORDER BY t.created_at, t.id
       LIMIT 1
    ) vivo ON true
   WHERE s.origen = 'tramite' AND s.estado <> 'descartado';

  PERFORM 1 FROM flito_soat s WHERE s.id IN (SELECT id FROM _saneo_soat) FOR UPDATE;

  -- B1 + B2: descarte.
  WITH d AS (
    UPDATE flito_soat s
       SET estado = 'descartado', descartado_en = now(), motivo_descarte = x.muerto_motivo,
           descartado_por_tramite_id = x.muerto_id, updated_at = now()
      FROM _saneo_soat x
     WHERE s.id = x.id AND NOT x.hay_vivo AND (x.anterior <> 'pagado' OR x.origen_muerto)
    RETURNING s.id
  ), his AS (
    INSERT INTO flito_estado_historial (concepto, registro_id, estado_anterior, estado_nuevo, motivo, origen)
    SELECT 'soat', x.id, x.anterior, 'descartado',
           'Saneo Épica 14707: trámite ' || x.muerto_id_flit || ' ' || x.muerto_motivo || ' en FLIT (histórico, sin aviso).', 'sistema'
      FROM _saneo_soat x JOIN d ON d.id = x.id
    RETURNING 1
  )
  SELECT count(*) INTO n_soat_descartados FROM his;

  -- B3: D9, el SOAT abierto compartido hereda compañía/organismo del vivo más antiguo.
  WITH h AS (
    UPDATE flito_soat s
       SET compania_id = coalesce(x.vivo_compania_id, s.compania_id),
           organismo_codigo = coalesce(x.vivo_organismo, s.organismo_codigo),
           updated_at = now()
      FROM _saneo_soat x
     WHERE s.id = x.id AND x.hay_vivo AND x.anterior <> 'pagado'
       AND (   (x.vivo_compania_id IS NOT NULL AND x.vivo_compania_id IS DISTINCT FROM s.compania_id)
            OR (x.vivo_organismo IS NOT NULL AND x.vivo_organismo IS DISTINCT FROM s.organismo_codigo))
    RETURNING s.id
  ), a AS (
    INSERT INTO audit_logs (user_id, user_email, action, resource, resource_id, detail)
    SELECT NULL, 'sistema', 'update', 'flito_soat', x.id::text,
           'Saneo Épica 14707 (D9): el SOAT hereda compañía/organismo del trámite vivo más antiguo; el trámite '
             || x.muerto_id_flit || ' ' || x.muerto_motivo || ' en FLIT (histórico, sin aviso).'
      FROM _saneo_soat x JOIN h ON h.id = x.id
    RETURNING 1
  )
  SELECT count(*) INTO n_soat_heredados FROM a;

  -- B4: pagado compartido con un vivo, conservado (solo se cuenta).
  SELECT count(*) INTO n_pagados_conservados FROM _saneo_soat WHERE hay_vivo AND anterior = 'pagado';

  -- C. Conteos.
  RAISE NOTICE 'saneo 14707: impuestos=% soat_descartados=% soat_heredados=% pagados_compartidos_conservados=%',
    n_impuestos, n_soat_descartados, n_soat_heredados, n_pagados_conservados;

  DROP TABLE IF EXISTS _saneo_soat;
END $$;
