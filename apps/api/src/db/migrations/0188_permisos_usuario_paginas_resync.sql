-- 0188_permisos_usuario_paginas_resync.sql
-- Feature #12072 — Roles y permisos configurables. HU #12087 (permisos por usuario, anadir y QUITAR):
--   desde esta HU el resolutor lee las paginas por usuario de `permisos_usuario_funcion` y deja de
--   leer `users.allowed_pages`. La 0179 (paso 5) copio la columna a la tabla UNA vez y dejo escrito
--   que el alta y la edicion seguian escribiendo la columna; desde entonces la columna y la tabla se
--   han separado. Sin re-sincronizar, los usuarios editados despues de la 0179 perderian o ganarian
--   paginas el dia del deploy — justo lo que el AC6 prohibe. Solo datos: sin CREATE/ALTER/DROP.
-- Autor: equipo FLITO. Antecedentes: 0179 (tabla y backfill inicial), ADR-DB-001 (sin control de
--   transaccion propio), ADR-0015 (permisos en base), docs/diseno-hu-12087-permisos-por-usuario.md §5.
--
-- Depende de la 0179 (permisos_funciones, permisos_usuario_funcion).
--
-- Idempotente fuerte: la segunda pasada no borra ni inserta una fila (la columna queda congelada y la
-- tabla ya coincide con ella). Las filas `revocar` y las `operacion.*` no se tocan: son de la HU.
--
-- ── Paso 1 — Las paginas que el admin QUITO de la columna despues de la 0179 ────────────────────
-- Solo `conceder pagina.%` cuyo slug ya no esta en `users.allowed_pages` del titular.
--
-- ── Paso 2 — Las paginas que el admin ANADIO a la columna despues de la 0179 ────────────────────
-- El mismo INSERT ... SELECT DISTINCT de la 0179 paso 5: una fila ('conceder', pagina.<slug>) por cada
-- entrada VALIDA (existe en el catalogo) de la columna que aun no este en la tabla.
--
-- ── Paso 3 — El aviso donde lo ve quien abre psql ───────────────────────────────────────────────
-- El AC6 pide el aviso en schema.ts (esta) y este COMMENT es su espejo en la base, como la 0179 hizo
-- con la tabla. No es DDL de estructura: no cambia tipo, nulabilidad ni default.
--
-- ── Paso 4 — La cuenta, en el log del CD ────────────────────────────────────────────────────────
-- Borradas, insertadas y total, y una comprobacion que REVIENTA si tras el resync queda un usuario
-- cuya columna (valida) y su tabla no coinciden: sin ella un verde silencioso esconderia el AC6 roto.

DO $resumen0188$
DECLARE n_borradas int; n_insertadas int; n_total int; n_desviados int;
BEGIN
  DELETE FROM permisos_usuario_funcion uf
   WHERE uf.efecto = 'conceder'
     AND uf.funcion_codigo LIKE 'pagina.%'
     AND NOT EXISTS (
       SELECT 1 FROM users u
        WHERE u.id = uf.user_id
          AND substr(uf.funcion_codigo, 8) = ANY (u.allowed_pages)
     );
  GET DIAGNOSTICS n_borradas = ROW_COUNT;

  INSERT INTO permisos_usuario_funcion (user_id, funcion_codigo, efecto)
  SELECT DISTINCT u.id, 'pagina.' || s.slug, 'conceder'
    FROM users u
    CROSS JOIN LATERAL unnest(u.allowed_pages) AS s(slug)
   WHERE EXISTS (SELECT 1 FROM permisos_funciones f WHERE f.codigo = 'pagina.' || s.slug)
  ON CONFLICT (user_id, funcion_codigo) DO NOTHING;
  GET DIAGNOSTICS n_insertadas = ROW_COUNT;

  SELECT count(*) INTO n_total FROM permisos_usuario_funcion
   WHERE efecto = 'conceder' AND funcion_codigo LIKE 'pagina.%';

  -- Usuarios cuya columna (solo slugs del catalogo) y su tabla (`conceder pagina.*`) NO coinciden.
  -- Un `revocar pagina.X` sobre un slug que tambien esta en la columna no cuenta como desvio: la PK
  -- impide la fila `conceder` y el revocar es una decision de la HU, no un resto de la 0179.
  SELECT count(*) INTO n_desviados FROM users u
   WHERE EXISTS (
           SELECT 1 FROM unnest(u.allowed_pages) AS s(slug)
            WHERE EXISTS (SELECT 1 FROM permisos_funciones f WHERE f.codigo = 'pagina.' || s.slug)
              AND NOT EXISTS (SELECT 1 FROM permisos_usuario_funcion uf
                               WHERE uf.user_id = u.id AND uf.funcion_codigo = 'pagina.' || s.slug))
      OR EXISTS (
           SELECT 1 FROM permisos_usuario_funcion uf
            WHERE uf.user_id = u.id AND uf.efecto = 'conceder' AND uf.funcion_codigo LIKE 'pagina.%'
              AND NOT (substr(uf.funcion_codigo, 8) = ANY (u.allowed_pages)));
  IF n_desviados <> 0 THEN
    RAISE EXCEPTION '0188: % usuario(s) con allowed_pages y permisos_usuario_funcion distintos tras el resync', n_desviados;
  END IF;

  RAISE NOTICE '0188: permisos_usuario_funcion re-sincronizada con users.allowed_pages (% borradas, % insertadas, % conceder pagina.* en total)',
    n_borradas, n_insertadas, n_total;
END $resumen0188$;

COMMENT ON COLUMN users.allowed_pages IS
  'OBSOLETA (HU #12087): congelada en la foto de la 0188; la fuente de las paginas por usuario es permisos_usuario_funcion';
