-- 0250_flito_bolsas_unicas_datos_cliente.sql
-- HU #13899 (Feature #13886) — copia el libro de CLIENTES al modelo único (ADR-0029, D5, Q5).
-- Diseño: docs/arquitectura/feature-13886-13887-bolsa-unica.md («0250 — esqueleto», «Pre-flight», «Runbook»).
--
-- Qué hace, TODO dentro de UN solo bloque DO (una sentencia = atómica también fuera del runner):
--   0. LOCK EXCLUSIVE de los tres libros viejos: nadie escribe en ellos mientras se copia.
--   1. Verificación PREVIA (Q5): cada bolsa vieja debe cumplir saldo = Σ entradas − Σ salidas. Si alguna
--      no cuadra, RAISE y no se copia NADA. El mensaje da solo el NÚMERO de bolsas (sin NIT ni nombres).
--   2. Copia las bolsas CON historia (movimientos o cierres) con alcance 'compania', MISMO id, compañía
--      y saldo. Las autocreadas vacías NO se migran (D5). Por cada bolsa nueva: los seis conceptos (hoy
--      descontaba todo lo liquidado) y un evento 'migrar' en la bitácora.
--   3. Copia movimientos y cierres con sus ids y valores (compania_id se descarta: la da la bolsa).
--   4. Verificación POSTERIOR: ningún movimiento ni cierre viejo sin su copia.
--   5. `flito_conciliacion_lineas.movimiento_bolsa_id` pasa a apuntar al libro único (mismos UUID: solo DDL).
--
-- Idempotente: `ON CONFLICT (id) DO NOTHING`; conceptos y evento solo para las bolsas insertadas en ESTA
-- corrida (CTE con RETURNING), así que re-ejecutarla no duplica nada ni reescribe la configuración.
-- Antes de desplegar: pre-flight + ajuste manual auditado del runbook
--   docs/arquitectura/runbook-hu-13899-migracion-0250-bolsa-unica.md
-- Autor: backend-agent (HU #13899), revisión humana en el PR.
-- Sin control de transacción propio (ADR-DB-001).

DO $m0250$
DECLARE
  n integer;
  fk text;
BEGIN
  LOCK TABLE flito_bolsas, flito_bolsa_movimientos, flito_bolsa_cierres IN EXCLUSIVE MODE;

  -- 1) Pre-flight dentro de la migración: la deriva saldo ≠ libro NO se corrige en silencio (Q5).
  SELECT count(*) INTO n
  FROM flito_bolsas b
  WHERE b.saldo <> COALESCE((
    SELECT sum(CASE WHEN m.tipo = 'entrada' THEN m.valor ELSE -m.valor END)
    FROM flito_bolsa_movimientos m WHERE m.bolsa_id = b.id), 0);
  IF n > 0 THEN
    RAISE EXCEPTION 'flito_bolsas_unicas: % bolsas de cliente no cuadran (saldo distinto de la suma del libro). Corre el pre-flight y el ajuste auditado del runbook (ADR-0029, Q5)', n;
  END IF;

  -- 2) Bolsas con historia → modelo único (UUID preservado) + conceptos + evento 'migrar'.
  WITH nuevas AS (
    INSERT INTO flito_bolsas_unicas
      (id, alcance, compania_id, activa, saldo, ultima_entrada_valor, ultima_entrada_en, created_at, updated_at)
    SELECT b.id, 'compania', b.compania_id, true, b.saldo, b.ultima_recarga_valor, b.ultima_recarga_en,
           b.created_at, b.updated_at
    FROM flito_bolsas b
    WHERE EXISTS (SELECT 1 FROM flito_bolsa_movimientos m WHERE m.bolsa_id = b.id)
       OR EXISTS (SELECT 1 FROM flito_bolsa_cierres c WHERE c.bolsa_id = b.id)
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  ), conceptos AS (
    INSERT INTO flito_bolsas_unicas_conceptos (bolsa_id, concepto)
    SELECT nuevas.id, c.concepto
    FROM nuevas
    CROSS JOIN (VALUES ('soat'), ('impuesto'), ('derecho'), ('tramite_digital'), ('logistica'),
                       ('servicios_adicionales')) AS c(concepto)
    ON CONFLICT DO NOTHING
    RETURNING bolsa_id
  )
  INSERT INTO flito_bolsas_unicas_eventos (bolsa_id, accion, motivo, snapshot, usuario_id, usuario_nombre)
  SELECT nuevas.id, 'migrar', 'Migración del libro de clientes al modelo único (ADR-0029)',
         jsonb_build_object('alcance', 'compania', 'conceptos',
           jsonb_build_array('soat', 'impuesto', 'derecho', 'tramite_digital', 'logistica', 'servicios_adicionales'),
           'origen', 'flito_bolsas'),
         NULL, 'migración 0250'
  FROM nuevas;

  -- 3) Movimientos y cierres, ids y valores preservados.
  INSERT INTO flito_bolsas_unicas_movimientos
    (id, bolsa_id, tipo, origen, concepto, organismo_codigo, tramite_id, valor, saldo_resultante, periodo,
     fecha, observacion, soporte_id, registrado_por_id, registrado_por_nombre, llave_idempotencia,
     corrige_movimiento_id, created_at)
  SELECT m.id, m.bolsa_id, m.tipo, m.origen, m.concepto, m.organismo_codigo, m.tramite_id, m.valor,
         m.saldo_resultante, m.periodo, m.fecha, m.observacion, m.soporte_id, m.registrado_por_id,
         m.registrado_por_nombre, m.llave_idempotencia, m.corrige_movimiento_id, m.created_at
  FROM flito_bolsa_movimientos m
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO flito_bolsas_unicas_cierres
    (id, bolsa_id, periodo, saldo_inicial, total_entradas, total_salidas, saldo_final, movimientos,
     observaciones, cerrado_por_id, cerrado_por_nombre, cerrado_en)
  SELECT c.id, c.bolsa_id, c.periodo, c.saldo_inicial, c.total_entradas, c.total_salidas, c.saldo_final,
         c.movimientos, c.observaciones, c.cerrado_por_id, c.cerrado_por_nombre, c.cerrado_en
  FROM flito_bolsa_cierres c
  ON CONFLICT (id) DO NOTHING;

  -- 4) Nada viejo sin copia. Solo conteos en el mensaje.
  SELECT count(*) INTO n FROM flito_bolsa_movimientos m
  WHERE NOT EXISTS (SELECT 1 FROM flito_bolsas_unicas_movimientos x WHERE x.id = m.id AND x.valor = m.valor);
  IF n > 0 THEN RAISE EXCEPTION 'flito_bolsas_unicas: % movimientos de cliente sin migrar', n; END IF;
  SELECT count(*) INTO n FROM flito_bolsa_cierres c
  WHERE NOT EXISTS (SELECT 1 FROM flito_bolsas_unicas_cierres x WHERE x.id = c.id);
  IF n > 0 THEN RAISE EXCEPTION 'flito_bolsas_unicas: % cierres de cliente sin migrar', n; END IF;

  -- 5) Conciliación → libro único. El nombre de la FK vieja lo puso drizzle-kit: se busca por destino.
  FOR fk IN
    SELECT con.conname FROM pg_constraint con
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
    WHERE con.contype = 'f'
      AND con.conrelid = 'flito_conciliacion_lineas'::regclass
      AND con.confrelid = 'flito_bolsa_movimientos'::regclass
      AND a.attname = 'movimiento_bolsa_id'
  LOOP
    EXECUTE format('ALTER TABLE flito_conciliacion_lineas DROP CONSTRAINT %I', fk);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flito_conciliacion_lineas_mov_bolsa_unica_fk') THEN
    ALTER TABLE flito_conciliacion_lineas ADD CONSTRAINT flito_conciliacion_lineas_mov_bolsa_unica_fk
      FOREIGN KEY (movimiento_bolsa_id) REFERENCES flito_bolsas_unicas_movimientos(id) ON DELETE RESTRICT;
  END IF;
END $m0250$;
