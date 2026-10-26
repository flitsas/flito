-- 0257_flito_bolsas_unicas_datos_transito.sql
-- HU #13906 (Feature #13887) — copia el libro de TRÁNSITO al modelo único (ADR-0029, D3, D5, Q5).
-- Diseño: docs/arquitectura/feature-13886-13887-bolsa-unica.md («Plan de migración SQL», fila HU-F).
-- Hermana de la 0250 (lado cliente); mismo esqueleto con las diferencias del diseño:
--
--   0. LOCK EXCLUSIVE de los tres libros viejos de tránsito: nadie escribe en ellos mientras se copia.
--   1. Verificación PREVIA (Q5): cada bolsa vieja debe cumplir saldo = Σ entradas − Σ salidas. Si alguna
--      no cuadra, RAISE y no se copia NADA. El mensaje da solo el NÚMERO de bolsas (sin nombres ni ids).
--   2. Copia TODAS las bolsas de tránsito, tengan o no movimientos (D5 solo excluye las de cliente):
--      alcance 'transito', MISMO id, nombre y saldo; `ultima_carga_*` → `ultima_entrada_*`. Por cada bolsa
--      nueva: su cobertura con `activa = true` y un evento 'migrar' en la bitácora.
--      La pareja (secretaría, concepto) única entre activas la impone `uq_flito_bolsas_unicas_cobertura_activa`
--      (0249). El `uq_bolsa_transito_cobertura` viejo no tenía condición, así que la copia no puede violarlo.
--   3. Copia los movimientos con sus ids, valores y llaves; el origen 'carga' pasa a 'recarga'.
--   4. Verificación POSTERIOR: saldo = Σ libro único, mismos conteos de movimientos y de cobertura por bolsa,
--      y ningún movimiento viejo sin su copia. Solo conteos en los mensajes.
--   5. `flito_conciliacion_lineas.movimiento_transito_id` pasa a apuntar al libro único (mismos UUID: solo DDL).
--
-- Idempotente: `ON CONFLICT DO NOTHING`; cobertura y evento solo para las bolsas insertadas en ESTA corrida
-- (CTE con RETURNING); la FK se busca por destino y se crea solo si no existe.
-- Antes de desplegar: pre-flight + ajuste del runbook
--   docs/arquitectura/runbook-hu-13906-migracion-0257-bolsa-transito.md
-- Autor: backend-agent (HU #13906), revisión humana en el PR.
-- Sin control de transacción propio (ADR-DB-001).

DO $m0257$
DECLARE
  n integer;
  fk text;
BEGIN
  LOCK TABLE flito_bolsas_transito, flito_bolsa_transito_cobertura, flito_bolsa_transito_movimientos
    IN EXCLUSIVE MODE;

  -- 1) Pre-flight dentro de la migración: la deriva saldo ≠ libro NO se corrige en silencio (Q5).
  SELECT count(*) INTO n
  FROM flito_bolsas_transito b
  WHERE b.saldo <> COALESCE((
    SELECT sum(CASE WHEN m.tipo = 'entrada' THEN m.valor ELSE -m.valor END)
    FROM flito_bolsa_transito_movimientos m WHERE m.bolsa_id = b.id), 0);
  IF n > 0 THEN
    RAISE EXCEPTION 'flito_bolsas_unicas: % bolsas de tránsito no cuadran (saldo distinto de la suma del libro). Corre el pre-flight y el ajuste auditado del runbook (ADR-0029, Q5)', n;
  END IF;

  -- 2) Todas las bolsas → modelo único (UUID preservado) + cobertura activa + evento 'migrar'.
  WITH nuevas AS (
    INSERT INTO flito_bolsas_unicas
      (id, alcance, nombre, compania_id, activa, saldo, ultima_entrada_valor, ultima_entrada_en, created_at, updated_at)
    SELECT b.id, 'transito', b.nombre, NULL, true, b.saldo, b.ultima_carga_valor, b.ultima_carga_en,
           b.created_at, b.updated_at
    FROM flito_bolsas_transito b
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  ), cobertura AS (
    INSERT INTO flito_bolsas_unicas_cobertura (bolsa_id, organismo_codigo, concepto, activa, created_at)
    SELECT c.bolsa_id, c.organismo_codigo, c.concepto, true, c.created_at
    FROM flito_bolsa_transito_cobertura c
    JOIN nuevas ON nuevas.id = c.bolsa_id
    ON CONFLICT DO NOTHING
    RETURNING bolsa_id
  )
  INSERT INTO flito_bolsas_unicas_eventos (bolsa_id, accion, motivo, snapshot, usuario_id, usuario_nombre)
  SELECT nuevas.id, 'migrar', 'Migración del libro de tránsito al modelo único (ADR-0029)',
         jsonb_build_object(
           'alcance', 'transito',
           'cobertura', COALESCE((
             SELECT jsonb_agg(jsonb_build_object('organismoCodigo', c.organismo_codigo, 'concepto', c.concepto)
                              ORDER BY c.organismo_codigo, c.concepto)
             FROM flito_bolsa_transito_cobertura c WHERE c.bolsa_id = nuevas.id), '[]'::jsonb),
           'origen', 'flito_bolsas_transito'),
         NULL, 'migración 0257'
  FROM nuevas;

  -- 3) Movimientos, ids y valores preservados; 'carga' → 'recarga' (el libro único no conoce 'carga').
  INSERT INTO flito_bolsas_unicas_movimientos
    (id, bolsa_id, tipo, origen, concepto, organismo_codigo, tramite_id, valor, saldo_resultante, periodo,
     fecha, observacion, soporte_id, registrado_por_id, registrado_por_nombre, llave_idempotencia, created_at)
  SELECT m.id, m.bolsa_id, m.tipo, CASE WHEN m.origen = 'carga' THEN 'recarga' ELSE m.origen END,
         m.concepto, m.organismo_codigo, m.tramite_id, m.valor, m.saldo_resultante, m.periodo, m.fecha,
         m.observacion, m.soporte_id, m.registrado_por_id, m.registrado_por_nombre, m.llave_idempotencia,
         m.created_at
  FROM flito_bolsa_transito_movimientos m
  ON CONFLICT (id) DO NOTHING;

  -- 4) Verificación posterior. Solo conteos en el mensaje.
  SELECT count(*) INTO n
  FROM flito_bolsas_transito o
  LEFT JOIN flito_bolsas_unicas u ON u.id = o.id AND u.alcance = 'transito'
  WHERE u.id IS NULL
     OR u.saldo <> o.saldo
     OR u.saldo <> COALESCE((SELECT sum(CASE WHEN x.tipo = 'entrada' THEN x.valor ELSE -x.valor END)
                             FROM flito_bolsas_unicas_movimientos x WHERE x.bolsa_id = u.id), 0)
     OR (SELECT count(*) FROM flito_bolsas_unicas_movimientos x WHERE x.bolsa_id = u.id)
        <> (SELECT count(*) FROM flito_bolsa_transito_movimientos m WHERE m.bolsa_id = o.id)
     OR (SELECT count(*) FROM flito_bolsas_unicas_cobertura x WHERE x.bolsa_id = u.id)
        <> (SELECT count(*) FROM flito_bolsa_transito_cobertura c WHERE c.bolsa_id = o.id);
  IF n > 0 THEN
    RAISE EXCEPTION 'flito_bolsas_unicas: % bolsas de tránsito no cuadran tras la copia (saldo, libro, conteo o cobertura)', n;
  END IF;
  SELECT count(*) INTO n FROM flito_bolsa_transito_movimientos m
  WHERE NOT EXISTS (SELECT 1 FROM flito_bolsas_unicas_movimientos x WHERE x.id = m.id AND x.valor = m.valor);
  IF n > 0 THEN RAISE EXCEPTION 'flito_bolsas_unicas: % movimientos de tránsito sin migrar', n; END IF;

  -- 5) Conciliación → libro único. El nombre de la FK vieja lo puso drizzle-kit: se busca por destino.
  FOR fk IN
    SELECT con.conname FROM pg_constraint con
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
    WHERE con.contype = 'f'
      AND con.conrelid = 'flito_conciliacion_lineas'::regclass
      AND con.confrelid = 'flito_bolsa_transito_movimientos'::regclass
      AND a.attname = 'movimiento_transito_id'
  LOOP
    EXECUTE format('ALTER TABLE flito_conciliacion_lineas DROP CONSTRAINT %I', fk);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_conciliacion_lineas_mov_transito_unica_fk') THEN
    ALTER TABLE flito_conciliacion_lineas ADD CONSTRAINT flito_conciliacion_lineas_mov_transito_unica_fk
      FOREIGN KEY (movimiento_transito_id) REFERENCES flito_bolsas_unicas_movimientos(id) ON DELETE RESTRICT;
  END IF;
END $m0257$;
