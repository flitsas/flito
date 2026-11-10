-- Bug #14414 — BACKPORT A PDN de la 0291 (`0291_flito_reparar_arranque_empresa_vinculada.sql` de staging).
-- Reparación de los trámites que quedaron sin SOAT ni impuesto al vincularles la empresa.
--
-- `crearEmpresaDesdeTramite` re-vinculaba `compania_id` sin arrancar SOAT/impuesto, y FLIT 2 solo reprocesa
-- con un `syncVersion` mayor, así que un trámite `Asignado` podía quedarse así para siempre.
--
-- POR QUÉ OTRO ARCHIVO: PDN no tiene la columna `flito_tramites.retenido` (la trae la HU #13946, aún no
-- promovida) y la 0291 de staging la lee. Este archivo es la 0291 con UN solo cambio de lógica en el SQL:
--   · Se quitó `AND NOT tr.retenido` (en PDN no hay trámites retenidos: la columna no existe).
-- (Además, los RAISE WARNING/NOTICE se identifican como `0253_pdn` en lugar de `0291`.)
-- Lo demás es idéntico, con dos diferencias conscientes frente al sync de PDN (más conservadoras):
--   · Se conserva `c.active IS DISTINCT FROM false`: no se crean registros para clientes inactivos, aunque
--     el sync de release no filtra por `clients.active`. Una reparación de datos no debe ser más laxa.
--   · El SOAT existente del VIN se elige con el orden de `soatActualDelVin` (ADR-0031: primero el abierto; si
--     no, el más reciente). El `resolverSoat` de release toma uno cualquiera (`limit 1`); el orden solo usa
--     `estado`, `created_at` e `id`, que existen en PDN.
-- El sufijo `_pdn` evita que el chequeo de deriva lo empareje por nombre con la 0291. Cuando la 0291
-- original llegue a PDN con la promoción completa, será idempotente sobre lo que este archivo ya reparó:
-- no vuelve a crear SOAT/impuestos existentes ni repite un aviso de bloqueo igual (mismo `detail`).
--
-- ALCANCE ESTRECHO: solo trámites con una fila en `flito_tramite_historial` con `campo='compania_id'` y
-- `origen='usuario'`, la huella de ese flujo. No se barren todos los `Asignado` con empresa: una compañía pudo
-- cambiar su autogestión después y se crearían registros indebidos.
--
-- Dentro de ese alcance replica, trámite a trámite y en orden, para que un SOAT recién creado se vincule al
-- siguiente trámite del mismo VIN (igual que en el servicio):
--   · Condiciones: `arrancarTramiteGuardado` (flito-sync/arrancar-tramite-guardado.ts).
--   · SOAT: `resolverSoat` + orden de `soatActualDelVin` (ADR-0031) + `soatBloqueaReencolado`.
--   · Impuesto: `resolverImpuesto` + `modalidadVigente` + `flitoGestionaImpuesto` + `impuestoBloqueantePorVehiculo`.
--   · Rastro: `registrarCambio` y `auditSistema` (origen sistema), con motivo que cita el Bug #14414.
--
-- Idempotente: lo creado no se vuelve a crear y un aviso de bloqueo igual no se repite.
-- Si un trámite choca con un índice único (p. ej. el sync de un pod viejo creó el SOAT a la vez), SOLO ese
-- trámite se revierte y se avisa con WARNING: el resto sigue y el rollout no queda sin Ready por él.
DO $$
DECLARE
  -- String.prototype.trim de JS (`esAsignado`): `btrim` a secas solo quita espacios.
  c_blancos CONSTANT text := E' \t\n\r\f\x0B                 　﻿';
  -- `anioGravableEnCurso`: el huso importa, el 31 de diciembre a las 7 p.m. aún es el año viejo.
  c_anio CONSTANT integer := extract(year FROM now() AT TIME ZONE 'America/Bogota')::integer;
  c_nota CONSTANT text := 'Reparación Bug #14414: empresa vinculada al trámite sin arrancarlo.';
  t record;
  v_soat_id uuid;
  v_soat_estado text;
  v_impuesto_id uuid;
  v_impuesto_valor numeric;
  v_modalidad text;
  v_bloqueante record;
  v_detalle text;
  n_tramites integer := 0;
  n_soat_creados integer := 0;
  n_soat_vinculados integer := 0;
  n_soat_bloqueados integer := 0;
  n_impuestos_creados integer := 0;
  n_impuestos_completados integer := 0;
  n_impuestos_bloqueados integer := 0;
  n_fallidos integer := 0;
BEGIN
  FOR t IN
    SELECT tr.id, tr.id_flit, tr.soat_id, tr.vehiculo_id, tr.organismo_codigo, tr.valor_impuesto_liquidado,
           c.id AS compania_id, c.soat_autogestionable, c.impuestos_autogestionable, v.vin
    FROM flito_tramites tr
    JOIN clients c ON c.id = tr.compania_id
    JOIN vehicles v ON v.id = tr.vehiculo_id
    WHERE EXISTS (
            SELECT 1 FROM flito_tramite_historial h
            WHERE h.tramite_id = tr.id AND h.campo = 'compania_id' AND h.origen = 'usuario'
          )
      AND lower(btrim(coalesce(tr.flit_estado, ''), c_blancos)) = 'asignado'
      AND coalesce(tr.organismo_codigo, '') <> ''
      AND coalesce(v.vin, '') <> ''
      AND c.active IS DISTINCT FROM false -- cliente inactivo: no se repara (más estricto que el sync de PDN)
      AND (
        tr.fuente IS DISTINCT FROM 'flit2'
        OR (
          NOT tr.flit2_pii_enmascarada -- RN-19
          AND EXISTS (SELECT 1 FROM flito_compradores cp WHERE cp.tramite_id = tr.id AND cp.orden = 0) -- RN-17
        )
      )
    ORDER BY tr.created_at, tr.id
    FOR UPDATE OF tr
  LOOP
    n_tramites := n_tramites + 1;
    BEGIN
      -- ── SOAT (`resolverSoat`) ────────────────────────────────────────────────────────────────
      IF NOT t.soat_autogestionable THEN
        v_soat_id := NULL;
        -- `soatActualDelVin`: primero el abierto; si no, el más reciente.
        SELECT s.id, s.estado::text INTO v_soat_id, v_soat_estado
        FROM flito_soat s
        WHERE s.vin = t.vin
        ORDER BY (s.estado::text <> 'pagado') DESC, s.created_at DESC, s.id DESC
        LIMIT 1;

        IF v_soat_id IS NOT NULL THEN
          IF t.soat_id IS DISTINCT FROM v_soat_id THEN
            UPDATE flito_tramites SET soat_id = v_soat_id, updated_at = now() WHERE id = t.id;
            n_soat_vinculados := n_soat_vinculados + 1;
          END IF;
          IF v_soat_estado IN ('solicitado', 'pagado') THEN -- `soatBloqueaReencolado`
            v_detalle := format('Reencolado bloqueado (RN-01): el VIN %s ya tiene SOAT en "%s". Trámite %s. %s', t.vin, v_soat_estado, t.id_flit, c_nota);
            IF NOT EXISTS (
              SELECT 1 FROM audit_logs a
              WHERE a.resource = 'flito_soat' AND a.resource_id = v_soat_id::text AND a.detail = v_detalle
            ) THEN
              INSERT INTO audit_logs (user_id, user_email, action, resource, resource_id, detail)
              VALUES (NULL, 'sistema', 'update', 'flito_soat', v_soat_id::text, v_detalle);
              n_soat_bloqueados := n_soat_bloqueados + 1;
            END IF;
          END IF;
        ELSE
          -- Nace sin proveedor (HU #10979): se asigna al enviarlo al gestor.
          INSERT INTO flito_soat (vin, vehiculo_id, estado, compania_id, organismo_codigo, proveedor_soat_id, proveedor_sobrescrito)
          VALUES (t.vin, t.vehiculo_id, 'pendiente', t.compania_id, t.organismo_codigo, NULL, false)
          RETURNING id INTO v_soat_id;
          UPDATE flito_tramites SET soat_id = v_soat_id, updated_at = now() WHERE id = t.id;
          INSERT INTO audit_logs (user_id, user_email, action, resource, resource_id, detail)
          VALUES (NULL, 'sistema', 'create', 'flito_soat', v_soat_id::text,
                  format('SOAT creado para VIN %s (trámite %s). El proveedor se asigna al enviarlo al gestor. %s', t.vin, t.id_flit, c_nota));
          INSERT INTO flito_estado_historial (concepto, registro_id, estado_anterior, estado_nuevo, motivo, origen)
          VALUES ('soat', v_soat_id, NULL, 'pendiente', format('%s Alta del trámite %s.', c_nota, t.id_flit), 'sistema');
          n_soat_creados := n_soat_creados + 1;
        END IF;
      END IF;

      -- ── Impuesto (`resolverImpuesto`) ────────────────────────────────────────────────────────
      v_impuesto_id := NULL;
      SELECT i.id, i.valor_liquidado INTO v_impuesto_id, v_impuesto_valor
      FROM flito_impuestos i WHERE i.tramite_id = t.id LIMIT 1;

      IF v_impuesto_id IS NOT NULL THEN
        -- El estado es del módulo. Solo se completa el valor liquidado si falta.
        IF v_impuesto_valor IS NULL AND t.valor_impuesto_liquidado IS NOT NULL THEN
          UPDATE flito_impuestos SET valor_liquidado = t.valor_impuesto_liquidado, updated_at = now() WHERE id = v_impuesto_id;
          n_impuestos_completados := n_impuestos_completados + 1;
        END IF;
      ELSE
        -- `modalidadVigente`: sin vigencia abierta = autogestionado. `uq_flito_vig_vigente` garantiza una sola.
        SELECT coalesce(
          (SELECT vg.modalidad::text FROM flito_organismo_vigencias vg WHERE vg.organismo_codigo = t.organismo_codigo AND vg.hasta IS NULL LIMIT 1),
          'autogestionado'
        ) INTO v_modalidad;

        -- `flitoGestionaImpuesto`
        IF NOT t.impuestos_autogestionable AND v_modalidad = 'requiere_gestion' THEN
          -- `impuestoBloqueantePorVehiculo`: otro trámite del vehículo, `solicitado`/`pagado`, del año en curso.
          -- Año efectivo: `anioDe` (extracción OCR → año de `pagado_en`) y, si no hay, un `solicitado` cuenta
          -- como del año en curso y un `pagado` no bloquea. `solicitado` en trámite anulado/rechazado no bloquea.
          v_bloqueante := NULL;
          SELECT i.id, i.tramite_id, i.estado::text AS estado INTO v_bloqueante
          FROM flito_impuestos i
          JOIN flito_tramites o ON o.id = i.tramite_id
          CROSS JOIN LATERAL (SELECT i.extraccion -> 'anioGravable' -> 'valor' AS j) x
          WHERE o.vehiculo_id = t.vehiculo_id
            AND i.tramite_id <> t.id
            AND i.estado::text IN ('solicitado', 'pagado')
            AND NOT (coalesce(o.estado::text IN ('anulado', 'rechazado'), false) AND i.estado::text <> 'pagado')
            AND coalesce(
              CASE jsonb_typeof(x.j)
                WHEN 'string' THEN CASE WHEN (x.j #>> '{}') ~ '^[0-9]{4}$' THEN (x.j #>> '{}')::integer END
                WHEN 'number' THEN CASE
                  WHEN (x.j #>> '{}')::numeric BETWEEN 1000 AND 9999
                   AND (x.j #>> '{}')::numeric = trunc((x.j #>> '{}')::numeric)
                  THEN (x.j #>> '{}')::numeric::integer
                END
              END,
              extract(year FROM i.pagado_en AT TIME ZONE 'America/Bogota')::integer,
              CASE WHEN i.estado::text = 'solicitado' THEN c_anio END
            ) = c_anio
          ORDER BY i.created_at, i.id
          LIMIT 1;

          IF v_bloqueante.id IS NOT NULL THEN
            v_detalle := format('Alta bloqueada (impuesto por vehículo): el vehículo del trámite %s ya tiene impuesto en "%s" para %s en el trámite %s. %s',
                                t.id_flit, v_bloqueante.estado, c_anio, v_bloqueante.tramite_id, c_nota);
            IF NOT EXISTS (
              SELECT 1 FROM audit_logs a
              WHERE a.resource = 'flito_impuesto' AND a.resource_id = v_bloqueante.id::text AND a.detail = v_detalle
            ) THEN
              INSERT INTO audit_logs (user_id, user_email, action, resource, resource_id, detail)
              VALUES (NULL, 'sistema', 'update', 'flito_impuesto', v_bloqueante.id::text, v_detalle);
              n_impuestos_bloqueados := n_impuestos_bloqueados + 1;
            END IF;
          ELSE
            INSERT INTO flito_impuestos (tramite_id, estado, organismo_codigo, compania_id, modalidad_aplicada, valor_liquidado)
            VALUES (t.id, 'pendiente', t.organismo_codigo, t.compania_id, 'requiere_gestion', t.valor_impuesto_liquidado)
            RETURNING id INTO v_impuesto_id;
            INSERT INTO audit_logs (user_id, user_email, action, resource, resource_id, detail)
            VALUES (NULL, 'sistema', 'create', 'flito_impuesto', v_impuesto_id::text,
                    format('Impuesto creado en "pendiente" (trámite %s, organismo %s). %s', t.id_flit, t.organismo_codigo, c_nota));
            INSERT INTO flito_estado_historial (concepto, registro_id, estado_anterior, estado_nuevo, motivo, origen)
            VALUES ('impuesto', v_impuesto_id, NULL, 'pendiente',
                    format('%s Alta del trámite %s, organismo %s.', c_nota, t.id_flit, t.organismo_codigo), 'sistema');
            n_impuestos_creados := n_impuestos_creados + 1;
          END IF;
        END IF;
      END IF;
    EXCEPTION WHEN unique_violation THEN
      n_fallidos := n_fallidos + 1;
      RAISE WARNING '0253_pdn: trámite % sin reparar (índice único): %', t.id, SQLERRM;
    END;
  END LOOP;

  RAISE NOTICE '0253_pdn (Bug #14414): en alcance=%, soat creados=%, soat vinculados=%, soat bloqueados=%, impuestos creados=%, impuestos completados=%, impuestos bloqueados=%, fallidos=%',
    n_tramites, n_soat_creados, n_soat_vinculados, n_soat_bloqueados, n_impuestos_creados, n_impuestos_completados, n_impuestos_bloqueados, n_fallidos;
END $$;
