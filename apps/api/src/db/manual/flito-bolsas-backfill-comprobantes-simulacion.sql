-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- FLITO — backfill de comprobantes antes del corte, vía SQL — SIMULACIÓN (no escribe nada)
-- HU #13972 (Feature #13887), versión SQL del script de la HU #13910:
--   apps/api/src/scripts/flito-bolsas-backfill-comprobantes.ts
-- Runbook: docs/arquitectura/runbook-hu-13910-backfill-corte.md (sección «Vía SQL»).
--
-- Mismo resultado que el script TS (lo prueba __tests__/scripts/flito-bolsas-backfill-comprobantes-sql.test.ts):
-- mismas llaves (`salida:…` compañía, `consumo:…` tránsito), mismas omisiones, mismo orden, mismo periodo
-- imputable y mismo saldo_resultante. Corre TODO dentro de BEGIN … ROLLBACK: el reporte es exactamente lo
-- que el archivo «-aplicar.sql» escribiría.
--
-- Cómo se ejecuta: en DBeaver o pgAdmin, como SCRIPT COMPLETO (DBeaver: Alt+X; pgAdmin: F5). No usa
-- metacomandos de psql. Lo único que se edita es el id del usuario, unas líneas más abajo.
-- El reporte sale en el resultado del SELECT final y, línea a línea, en los mensajes (NOTICE).
--
-- Ley 1581: el reporte lleva solo ids (comprobante, bolsa), concepto, valor y motivo. Nunca placa, VIN,
-- NIT ni nombres.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ▼▼▼ ÚNICO VALOR A EDITAR: id del usuario que ejecuta (users.id), entre las comillas. Ej.: '17' ▼▼▼
SET LOCAL flito.backfill_usuario = '';
-- ▲▲▲ Queda como registrado_por de los movimientos (el mismo que --usuario del script TS). ▲▲▲

-- >>> FUNCIONES DEL BACKFILL (idénticas en -simulacion.sql y -aplicar.sql; el test de paridad lo exige)
-- Funciones temporales (pg_temp): viven solo en esta sesión; no quedan en el esquema.
--
-- RN-A5 / RN-A1 del libro (`asentarEnBolsa`): periodo imputable. Si el periodo natural está cerrado se corre
-- al primero abierto, sin pasar del periodo de hoy (Colombia).
CREATE OR REPLACE FUNCTION pg_temp.fb_periodo_imputable(p_bolsa uuid, p_natural text, p_tope text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_p text := p_natural;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM flito_bolsas_unicas_cierres ci WHERE ci.bolsa_id = p_bolsa AND ci.periodo = p_natural) THEN
    RETURN p_natural;
  END IF;
  WHILE EXISTS (SELECT 1 FROM flito_bolsas_unicas_cierres ci WHERE ci.bolsa_id = p_bolsa AND ci.periodo = v_p)
        AND v_p COLLATE "C" < p_tope COLLATE "C" LOOP
    v_p := to_char(to_date(v_p || '-01', 'YYYY-MM-DD') + interval '1 month', 'YYYY-MM');
  END LOOP;
  RETURN v_p;
END $$;
--
-- RN-C5 / RN-T4: de quién es una llave ya ocupada. NULL = de este mismo comprobante (idempotencia).
CREATE OR REPLACE FUNCTION pg_temp.fb_motivo_llave(p_origen text, p_mov_comprobante uuid, p_comprobante uuid)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_origen = 'automatico' THEN RETURN 'cubierto_por_liquidacion'; END IF;
  IF p_origen = 'comprobante' AND p_mov_comprobante = p_comprobante THEN RETURN NULL; END IF;
  RETURN 'cubierto_por_conciliacion';
END $$;
--
-- El INSERT del movimiento (las mismas columnas que `asentarEnBolsa`).
CREATE OR REPLACE FUNCTION pg_temp.fb_insertar(
  p_bolsa uuid, p_concepto text, p_organismo text, p_tramite uuid, p_valor numeric, p_saldo numeric,
  p_periodo text, p_fecha date, p_observacion text, p_usuario_id integer, p_usuario_nombre text,
  p_llave text, p_comprobante uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO flito_bolsas_unicas_movimientos (
    bolsa_id, tipo, origen, concepto, organismo_codigo, tramite_id, valor, saldo_resultante, periodo, fecha,
    observacion, soporte_id, registrado_por_id, registrado_por_nombre, llave_idempotencia,
    corrige_movimiento_id, comprobante_id, revierte_movimiento_id)
  VALUES (
    p_bolsa, 'salida', 'comprobante', p_concepto, p_organismo, p_tramite, p_valor, p_saldo, p_periodo, p_fecha,
    p_observacion, NULL, p_usuario_id, p_usuario_nombre, p_llave,
    NULL, p_comprobante, NULL)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
--
-- `asentarEnBolsa` sobre una bolsa YA bloqueada: valida el valor, relee la llave, imputa el periodo, inserta
-- y deja el saldo. `p_savepoint` (lado tránsito, Bug #11685): un 23505 se relee como duplicado; sin él
-- (lado compañía) el 23505 aborta, igual que en el TS.
CREATE OR REPLACE FUNCTION pg_temp.fb_asentar(
  p_bolsa uuid, p_valor numeric, p_fecha date, p_hoy date, p_concepto text, p_organismo text, p_tramite uuid,
  p_comprobante uuid, p_llave text, p_observacion text, p_usuario_id integer, p_usuario_nombre text,
  p_savepoint boolean,
  OUT o_bolsa uuid, OUT o_valor numeric, OUT o_saldo numeric, OUT o_origen text, OUT o_comprobante uuid,
  OUT o_duplicado boolean)
LANGUAGE plpgsql AS $$
DECLARE
  v_valor numeric := round(p_valor, 2);
  v_saldo numeric;
  v_periodo text;
BEGIN
  IF NOT (v_valor > 0) THEN
    RAISE EXCEPTION 'Comprobante %: el valor de la salida debe ser mayor que cero', p_comprobante;
  END IF;
  IF v_valor > 999999999999.99 THEN
    RAISE EXCEPTION 'Comprobante %: el valor de la salida excede el máximo admitido', p_comprobante;
  END IF;
  -- RN-A5: relectura de la llave dentro del lock.
  SELECT m.bolsa_id, m.valor, m.saldo_resultante, m.origen, m.comprobante_id
    INTO o_bolsa, o_valor, o_saldo, o_origen, o_comprobante
    FROM flito_bolsas_unicas_movimientos m JOIN flito_bolsas_unicas b ON b.id = m.bolsa_id
   WHERE m.llave_idempotencia = p_llave LIMIT 1;
  IF FOUND THEN
    o_duplicado := true;
    RETURN;
  END IF;
  SELECT b.saldo INTO v_saldo FROM flito_bolsas_unicas b WHERE b.id = p_bolsa;
  v_periodo := pg_temp.fb_periodo_imputable(p_bolsa, to_char(p_fecha, 'YYYY-MM'), to_char(p_hoy, 'YYYY-MM'));
  o_saldo := round(v_saldo - v_valor, 2);
  IF p_savepoint THEN
    BEGIN
      PERFORM pg_temp.fb_insertar(p_bolsa, p_concepto, p_organismo, p_tramite, v_valor, o_saldo, v_periodo, p_fecha,
        p_observacion, p_usuario_id, p_usuario_nombre, p_llave, p_comprobante);
    EXCEPTION WHEN unique_violation THEN
      SELECT m.bolsa_id, m.valor, m.saldo_resultante, m.origen, m.comprobante_id
        INTO o_bolsa, o_valor, o_saldo, o_origen, o_comprobante
        FROM flito_bolsas_unicas_movimientos m JOIN flito_bolsas_unicas b ON b.id = m.bolsa_id
       WHERE m.llave_idempotencia = p_llave LIMIT 1;
      IF NOT FOUND THEN RAISE; END IF;
      o_duplicado := true;
      RETURN;
    END;
  ELSE
    PERFORM pg_temp.fb_insertar(p_bolsa, p_concepto, p_organismo, p_tramite, v_valor, o_saldo, v_periodo, p_fecha,
      p_observacion, p_usuario_id, p_usuario_nombre, p_llave, p_comprobante);
  END IF;
  UPDATE flito_bolsas_unicas b SET saldo = o_saldo, updated_at = now() WHERE b.id = p_bolsa;
  o_bolsa := p_bolsa;
  o_valor := v_valor;
  o_origen := 'comprobante';
  o_comprobante := p_comprobante;
  o_duplicado := false;
END $$;
--
-- Una línea del reporte (tabla temporal + NOTICE). Devuelve el número de la siguiente línea.
CREATE OR REPLACE FUNCTION pg_temp.fb_linea(
  p_n integer, p_comprobante uuid, p_alcance text, p_bolsa uuid, p_concepto text, p_valor numeric,
  p_resultado text, p_motivo text, p_negativo boolean)
RETURNS integer LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO fb_reporte VALUES (p_n, p_comprobante, p_alcance, p_bolsa, p_concepto, p_valor, p_resultado, p_motivo, p_negativo);
  RAISE NOTICE 'comprobante % | % | bolsa % | % | % | %', p_comprobante, p_alcance, coalesce(p_bolsa::text, '-'),
    p_concepto, p_valor,
    CASE WHEN p_resultado = 'omitido' THEN 'omitido: ' || p_motivo
         ELSE p_resultado || CASE WHEN p_negativo THEN ' (saldo negativo)' ELSE '' END END;
  RETURN p_n + 1;
END $$;
--
-- El backfill: RN-B1 (corte), usuario, RN-B2 (candidatos), y por comprobante el gancho
-- `descontarComprobante(..., { backfill: true })`: lado compañía (RN-C3..C8) y lado tránsito (RN-T1..T7),
-- con el orden de locks RN-C9: comprobante → trámite → bolsa compañía → bolsa tránsito.
CREATE OR REPLACE FUNCTION pg_temp.flito_backfill_comprobantes(p_usuario text)
RETURNS TABLE (linea integer, comprobante_id uuid, alcance text, bolsa_id uuid, concepto text, valor numeric,
               resultado text, motivo text, saldo_negativo boolean)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  c_nota CONSTANT text := 'Backfill corte comprobantes (ADR-0029)';
  -- `hoyIso()`: el día de ejecución en Colombia (RN-B4).
  v_hoy date := (now() AT TIME ZONE 'America/Bogota')::date;
  v_corte timestamptz;
  v_usuario text := btrim(coalesce(p_usuario, ''));
  v_uid integer;
  v_unombre text;
  v_ids uuid[];
  v_id uuid;
  v_n integer := 1;
  v_encontrado boolean;
  k record;
  tc record;
  prev record;
  bo record;
  mv record;
  v_valor numeric;
  v_llave text;
  v_gestiona boolean;
  v_org text;
  v_soat uuid;
  v_ocupada boolean;
  v_motivo_ocupada text;
  v_cob_bolsa uuid;
  cm_bolsa uuid; cm_valor numeric; cm_saldo numeric; cm_ya boolean; cm_motivo text;
  tm_bolsa uuid; tm_valor numeric; tm_saldo numeric; tm_ya boolean; tm_motivo text;
BEGIN
  -- RN-B1 / AC5: sin corte (sin tabla o sin fila) no se lee ni se escribe nada más.
  IF to_regclass('flito_bolsas_corte') IS NULL THEN
    RAISE EXCEPTION 'Falta el corte: aplique la migración 0260 antes del backfill';
  END IF;
  EXECUTE 'SELECT corte_en FROM flito_bolsas_corte WHERE id = 1' INTO v_corte;
  IF v_corte IS NULL THEN
    RAISE EXCEPTION 'Falta el corte: aplique la migración 0260 antes del backfill';
  END IF;
  -- AC6: usuario vacío, no numérico o inexistente.
  IF v_usuario !~ '^[0-9]{1,9}$' THEN
    RAISE EXCEPTION 'Falta el id del usuario: escríbalo (users.id) entre las comillas de SET LOCAL flito.backfill_usuario, al inicio del archivo';
  END IF;
  SELECT u.id, u.username INTO v_uid, v_unombre FROM users u WHERE u.id = v_usuario::integer;
  IF NOT FOUND OR v_uid <= 0 THEN
    RAISE EXCEPTION 'El usuario % no existe: escriba el id (users.id) de quien ejecuta en SET LOCAL flito.backfill_usuario', v_usuario;
  END IF;
  CREATE TEMP TABLE IF NOT EXISTS fb_reporte (
    linea integer, comprobante_id uuid, alcance text, bolsa_id uuid, concepto text, valor numeric,
    resultado text, motivo text, saldo_negativo boolean) ON COMMIT DROP;
  TRUNCATE fb_reporte;
  -- RN-B2: candidatos en orden de aplicación (el mismo que el TS).
  v_ids := ARRAY(
    SELECT c.id FROM flito_comprobantes c
     WHERE c.estado = 'aplicado' AND c.es_pago = true AND c.tramite_id IS NOT NULL AND c.concepto IS NOT NULL
       AND c.aplicado_en IS NOT NULL AND c.aplicado_en < v_corte
     ORDER BY c.aplicado_en, c.id);
  RAISE NOTICE 'Backfill de comprobantes antes del corte %: % candidatos', v_corte, cardinality(v_ids);
  FOREACH v_id IN ARRAY v_ids LOOP
    -- RN-C9: lock del comprobante y re-comprobación (pudo dejar de ser candidato).
    SELECT c.id, c.tramite_id, c.concepto, c.es_pago, c.valor, c.estado, c.aplicado_en INTO k
      FROM flito_comprobantes c WHERE c.id = v_id LIMIT 1 FOR UPDATE;
    v_encontrado := FOUND;
    IF NOT v_encontrado THEN
      v_n := pg_temp.fb_linea(v_n, v_id, '-', NULL, '', 0, 'omitido', 'ya_no_es_candidato', false);
      CONTINUE;
    END IF;
    IF k.estado IS DISTINCT FROM 'aplicado' OR k.es_pago IS NOT TRUE OR k.tramite_id IS NULL
       OR coalesce(k.concepto, '') = '' OR k.aplicado_en IS NULL OR k.aplicado_en >= v_corte THEN
      v_n := pg_temp.fb_linea(v_n, v_id, '-', NULL, coalesce(k.concepto, ''), coalesce(k.valor, 0), 'omitido', 'ya_no_es_candidato', false);
      CONTINUE;
    END IF;
    PERFORM 1 FROM flito_tramites t WHERE t.id = k.tramite_id LIMIT 1 FOR UPDATE;
    v_valor := coalesce(k.valor, 0);
    IF NOT (v_valor > 0) THEN
      v_n := pg_temp.fb_linea(v_n, v_id, '-', NULL, k.concepto, v_valor, 'omitido', 'sin_valor', false);
      CONTINUE;
    END IF;
    cm_bolsa := NULL; cm_valor := NULL; cm_saldo := NULL; cm_ya := NULL; cm_motivo := NULL;
    tm_bolsa := NULL; tm_valor := NULL; tm_saldo := NULL; tm_ya := NULL; tm_motivo := NULL;
    --
    -- ── Lado COMPAÑÍA (RN-C3..RN-C8) ──
    SELECT t.compania_id, t.soat_id,
           cl.soat_autogestionable AS soat_autog, cl.impuestos_autogestionable AS imp_autog,
           cl.logistica_autogestionable AS log_autog,
           s.excepcion_autogestion AS soat_exc, s.origen AS soat_origen,
           i.excepcion_autogestion AS imp_exc, e.id AS log_exc
      INTO tc
      FROM flito_tramites t
      LEFT JOIN clients cl ON cl.id = t.compania_id
      LEFT JOIN flito_soat s ON s.id = t.soat_id
      LEFT JOIN flito_impuestos i ON i.tramite_id = t.id
      LEFT JOIN flito_excepciones_autogestion e
             ON e.tramite_id = t.id AND e.concepto = 'logistica' AND e.revocado_en IS NULL
     WHERE t.id = k.tramite_id LIMIT 1;
    IF NOT FOUND OR tc.compania_id IS NULL THEN
      cm_motivo := 'sin_compania';                                                -- RN-C3
    ELSE
      v_gestiona := CASE k.concepto                                               -- RN-C4
        WHEN 'soat' THEN coalesce(tc.soat_origen = 'cliente', false) OR NOT coalesce(tc.soat_autog, false)
                         OR coalesce(tc.soat_exc, false)
        WHEN 'impuesto' THEN NOT coalesce(tc.imp_autog, false) OR coalesce(tc.imp_exc, false)
        WHEN 'logistica' THEN NOT coalesce(tc.log_autog, false) OR tc.log_exc IS NOT NULL
        ELSE true END;
      IF NOT v_gestiona THEN
        cm_motivo := 'autogestionado';
      ELSE
        v_llave := CASE WHEN k.concepto = 'soat' AND tc.soat_id IS NOT NULL       -- RN-C5
                        THEN 'salida:soat:' || tc.soat_id ELSE 'salida:comprobante:' || k.id END;
        SELECT m.bolsa_id, m.valor, m.saldo_resultante, m.origen, m.comprobante_id INTO prev
          FROM flito_bolsas_unicas_movimientos m JOIN flito_bolsas_unicas b ON b.id = m.bolsa_id
         WHERE m.llave_idempotencia = v_llave LIMIT 1;
        IF FOUND THEN
          cm_motivo := pg_temp.fb_motivo_llave(prev.origen, prev.comprobante_id, k.id);
          IF cm_motivo IS NULL THEN
            cm_bolsa := prev.bolsa_id; cm_valor := prev.valor; cm_saldo := prev.saldo_resultante; cm_ya := true;
          END IF;
        ELSE
          -- RN-C6 (`bolsaCompaniaPara`): la bolsa sale bloqueada.
          SELECT b.id, b.activa INTO bo FROM flito_bolsas_unicas b
           WHERE b.alcance = 'compania' AND b.compania_id = tc.compania_id LIMIT 1 FOR UPDATE;
          IF NOT FOUND THEN
            cm_motivo := 'sin_bolsa';
          ELSIF NOT bo.activa THEN
            cm_motivo := 'inactiva';
          ELSIF NOT EXISTS (SELECT 1 FROM flito_bolsas_unicas_conceptos bc
                             WHERE bc.bolsa_id = bo.id AND bc.concepto = k.concepto) THEN
            cm_motivo := 'concepto_no_cubierto';
          ELSIF EXISTS (SELECT 1 FROM flito_bolsas_unicas_movimientos m          -- RN-C7
                         WHERE m.bolsa_id = bo.id AND m.tramite_id = k.tramite_id AND m.concepto = k.concepto
                           AND m.origen = 'automatico' AND m.tipo = 'salida'
                           AND m.llave_idempotencia LIKE 'salida:%') THEN
            cm_motivo := 'cubierto_por_liquidacion';
          ELSE
            SELECT * INTO mv FROM pg_temp.fb_asentar(bo.id, v_valor, v_hoy, v_hoy, k.concepto, NULL, k.tramite_id,
              k.id, v_llave, c_nota, v_uid, v_unombre, false);
            IF mv.o_duplicado THEN
              cm_motivo := pg_temp.fb_motivo_llave(mv.o_origen, mv.o_comprobante, k.id);
              IF cm_motivo IS NULL THEN
                cm_bolsa := mv.o_bolsa; cm_valor := mv.o_valor; cm_saldo := mv.o_saldo; cm_ya := true;
              END IF;
            ELSE
              cm_bolsa := mv.o_bolsa; cm_valor := mv.o_valor; cm_saldo := mv.o_saldo; cm_ya := false;
            END IF;
          END IF;
        END IF;
      END IF;
    END IF;
    --
    -- ── Lado TRÁNSITO (RN-T1..RN-T7) ──
    IF k.concepto NOT IN ('soat', 'impuesto', 'derecho') THEN
      tm_motivo := 'concepto_no_cubierto';                                        -- RN-T1
    ELSE
      -- RN-T2: secretaría del registro dueño del pago.
      v_org := NULL; v_soat := NULL;
      IF k.concepto = 'soat' THEN
        SELECT s.id, s.organismo_codigo INTO v_soat, v_org
          FROM flito_tramites t JOIN flito_soat s ON s.id = t.soat_id WHERE t.id = k.tramite_id LIMIT 1;
      ELSIF k.concepto = 'impuesto' THEN
        SELECT i.organismo_codigo INTO v_org FROM flito_impuestos i WHERE i.tramite_id = k.tramite_id LIMIT 1;
      ELSE
        SELECT d.organismo_codigo INTO v_org FROM flito_derechos_tramite d WHERE d.tramite_id = k.tramite_id LIMIT 1;
        IF NOT FOUND THEN
          -- HU #13969: derecho sin fila de dueño → la secretaría del trámite.
          SELECT t.organismo_codigo INTO v_org FROM flito_tramites t WHERE t.id = k.tramite_id LIMIT 1;
        END IF;
      END IF;
      IF coalesce(v_org, '') = '' THEN
        tm_motivo := 'sin_organismo';
      ELSE
        v_llave := CASE WHEN v_soat IS NOT NULL THEN 'consumo:soat:' || v_soat      -- RN-T4
                        ELSE 'consumo:comprobante:' || k.id END;
        SELECT m.bolsa_id, m.valor, m.saldo_resultante, m.origen, m.comprobante_id INTO prev
          FROM flito_bolsas_unicas_movimientos m JOIN flito_bolsas_unicas b ON b.id = m.bolsa_id
         WHERE m.llave_idempotencia = v_llave LIMIT 1;
        v_ocupada := FOUND;
        v_motivo_ocupada := CASE WHEN v_ocupada THEN pg_temp.fb_motivo_llave(prev.origen, prev.comprobante_id, k.id) END;
        IF v_motivo_ocupada IS NOT NULL THEN
          tm_motivo := v_motivo_ocupada;
        ELSE
          -- RN-T5 (`bolsaTransitoPara`): cobertura del par, bolsa bloqueada y re-comprobada activa.
          SELECT co.bolsa_id INTO v_cob_bolsa
            FROM flito_bolsas_unicas_cobertura co JOIN flito_bolsas_unicas b ON b.id = co.bolsa_id
           WHERE b.alcance = 'transito' AND co.organismo_codigo = v_org AND co.concepto = k.concepto
           ORDER BY co.activa DESC LIMIT 1;
          IF NOT FOUND THEN
            tm_motivo := 'sin_bolsa';
          ELSE
            SELECT b.id, b.activa INTO bo FROM flito_bolsas_unicas b WHERE b.id = v_cob_bolsa LIMIT 1 FOR UPDATE;
            IF NOT FOUND THEN
              tm_motivo := 'sin_bolsa';
            ELSIF NOT bo.activa THEN
              tm_motivo := 'inactiva';
            ELSIF v_ocupada THEN
              -- Reintento de este mismo comprobante.
              tm_bolsa := prev.bolsa_id; tm_valor := prev.valor; tm_saldo := prev.saldo_resultante; tm_ya := true;
            ELSIF EXISTS (SELECT 1 FROM flito_bolsas_unicas_movimientos m        -- RN-T6
                           WHERE m.bolsa_id = bo.id AND m.tramite_id = k.tramite_id AND m.concepto = k.concepto
                             AND m.origen = 'automatico' AND m.tipo = 'salida'
                             AND m.llave_idempotencia LIKE 'consumo:%') THEN
              tm_motivo := 'cubierto_por_liquidacion';
            ELSE
              SELECT * INTO mv FROM pg_temp.fb_asentar(bo.id, v_valor, v_hoy, v_hoy, k.concepto, v_org, k.tramite_id,
                k.id, v_llave, c_nota, v_uid, v_unombre, true);
              IF mv.o_duplicado THEN
                tm_motivo := pg_temp.fb_motivo_llave(mv.o_origen, mv.o_comprobante, k.id);
                IF tm_motivo IS NULL THEN
                  tm_bolsa := mv.o_bolsa; tm_valor := mv.o_valor; tm_saldo := mv.o_saldo; tm_ya := true;
                END IF;
              ELSE
                tm_bolsa := mv.o_bolsa; tm_valor := mv.o_valor; tm_saldo := mv.o_saldo; tm_ya := false;
              END IF;
            END IF;
          END IF;
        END IF;
      END IF;
    END IF;
    --
    -- Reporte en el orden del TS: movimientos (compañía, tránsito) y después omisiones (compañía, tránsito).
    IF cm_bolsa IS NOT NULL THEN
      v_n := pg_temp.fb_linea(v_n, v_id, 'compania', cm_bolsa, k.concepto, cm_valor,
        CASE WHEN cm_ya THEN 'ya_descontado' ELSE 'descontado' END, NULL, cm_saldo < 0);
    END IF;
    IF tm_bolsa IS NOT NULL THEN
      v_n := pg_temp.fb_linea(v_n, v_id, 'transito', tm_bolsa, k.concepto, tm_valor,
        CASE WHEN tm_ya THEN 'ya_descontado' ELSE 'descontado' END, NULL, tm_saldo < 0);
    END IF;
    IF cm_motivo IS NOT NULL THEN
      v_n := pg_temp.fb_linea(v_n, v_id, 'compania', NULL, k.concepto, v_valor, 'omitido', cm_motivo, false);
    END IF;
    IF tm_motivo IS NOT NULL THEN
      v_n := pg_temp.fb_linea(v_n, v_id, 'transito', NULL, k.concepto, v_valor, 'omitido', tm_motivo, false);
    END IF;
  END LOOP;
  RAISE NOTICE 'Comprobantes candidatos: %. Descuentos nuevos: % por %', cardinality(v_ids),
    (SELECT count(*) FROM fb_reporte r WHERE r.resultado = 'descontado'),
    (SELECT coalesce(sum(r.valor), 0) FROM fb_reporte r WHERE r.resultado = 'descontado');
  RETURN QUERY
    SELECT r.linea, r.comprobante_id, r.alcance, r.bolsa_id, r.concepto, r.valor, r.resultado, r.motivo, r.saldo_negativo
      FROM fb_reporte r ORDER BY r.linea;
END $$;
-- <<< FUNCIONES DEL BACKFILL

-- El reporte: una fila por comprobante × alcance. resultado = descontado (se asentaría) | ya_descontado | omitido.
SELECT * FROM pg_temp.flito_backfill_comprobantes(current_setting('flito.backfill_usuario', true));

-- SIMULACIÓN: se deshace todo. Para escribir, use flito-bolsas-backfill-comprobantes-aplicar.sql.
ROLLBACK;
