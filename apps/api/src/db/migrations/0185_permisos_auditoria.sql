-- 0185_permisos_auditoria.sql
-- Feature #12072 — Roles y permisos configurables. HU #12171: historial consultable de cambios de
--   usuarios, roles y permisos (CF-19, RN-A10). Tabla propia `permisos_auditoria` + funciones
--   `usuarios.auditoria.ver` / `usuarios.auditoria.filtrar` (admin y auditor) + `pagina.users` para `auditor`.
-- Autor: equipo FLITO. Antecedentes: ADR-0014 (aprobado 9/09/2026: tabla propia, no columnas en
--   audit_logs), ADR-0005 (clausula ON DELETE explicita hacia users), 0179-0181 (catalogo, motor,
--   reconduccion) y 0180 (estilo: FK RESTRICT, retencion declarada, resumen en el log del CD).
--
-- Depende de la 0178 (permisos_roles), la 0179 (permisos_funciones) y la 0181 (funciones `usuarios.*`).
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT (ADR-DB-001): el runner envuelve el archivo en su propia transaccion.
--   - Idempotente en sentido FUERTE: la segunda pasada no toca una fila (users, permisos_funciones,
--     permisos_rol_funcion ni pesv_retencion_politicas). Lo comprueba __tests__/db/migracion-0185.test.ts.
--   - Nada de ALTER TYPE ni de ADD COLUMN: lo que crea es una tabla nueva.
--   - Dollar-quoting ETIQUETADO en los bloques DO, y la etiqueta no se nombra en ningun comentario.
--   - Ninguna linea del archivo empieza por «(» + comilla salvo las tuplas de siembra: el test de la 0179
--     compara esas lineas (0179 + 0181 + 0182 + 0184 + 0185) con lo que produce generar-seed-permisos.ts.
--
-- Por que una tabla propia y no `before_state`/`after_state` en `audit_logs`: ADR-0014. En corto:
-- `audit_logs` la escriben ~312 llamadas en ~80 archivos que manejan conductores, propietarios y
-- cedulas; un jsonb libre ahi es una invitacion permanente a meter PII en una tabla sin REVOKE y sin
-- purga ejecutada. Aqui el escritor es uno y los campos son una lista blanca cerrada.
--
-- RN-A10: del ACTOR se guarda el correo (es el autor del acto); del TITULAR solo su id interno y su
-- rol. El nombre visible se resuelve por JOIN al leer, nunca se copia.

-- ── Paso 1 — La tabla ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS permisos_auditoria (
  id                    bigserial PRIMARY KEY,

  -- Agrupa las N filas de un mismo acto administrativo (un PATCH que toca 3 campos = 3 filas,
  -- 1 lote). Es lo que permite que la pantalla muestre un cambio y no tres.
  lote_id               uuid        NOT NULL,

  -- QUE entidad. Discriminador, como flito_estado_historial.concepto.
  entidad               varchar(20) NOT NULL,
  accion                varchar(12) NOT NULL,
  -- NULL solo en 'borrar' (un rol borrado no tiene campos que valorar).
  campo                 varchar(40),

  -- EL PAR. Un solo campo por fila; nunca el documento entero. La forma admitida esta acotada por
  -- el tipo `ValorAuditable` de shared-types y por el CHECK de `campo`.
  valor_antes           jsonb,
  valor_despues         jsonb,

  -- SOBRE QUIEN. Exactamente uno de los dos, nunca los dos ni ninguno.
  -- ON DELETE RESTRICT (ADR-0005, categoria «auditoria/prueba», y ADR-0014 §5): con SET NULL la fila
  -- diria «a alguien le quitaron un permiso el 3 de marzo» —un cambio sin sujeto—, y ademas se
  -- romperia el JOIN del que depende todo el diseño de PII.
  usuario_afectado_id   integer     REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- El rol del titular EN EL MOMENTO. Es lo unico que RN-A10 permite guardar de el, junto al id.
  usuario_afectado_rol  varchar(40),
  -- El rol AFECTADO (entidad 'rol'/'rol_funcion'). SIN FK a proposito: con RESTRICT ningun rol con
  -- historia podria borrarse nunca y CF-05 quedaria en codigo muerto; con CASCADE se borraria justo
  -- la historia que el auditor va a buscar. Integridad por discriminador + filtro del lector.
  rol_afectado_codigo   varchar(40),

  -- QUIEN. NULL = sistema (seed, migracion, arranque), NO «se desconoce»: lo distingue `origen`.
  actor_user_id         integer     REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Se copia ademas del id, mismo criterio que flito_estado_historial.usuario_email: si el usuario
  -- se borra, el historial debe seguir diciendo quien lo hizo. RN-A10 lo autoriza: es el autor.
  actor_email           varchar(150),
  actor_rol             varchar(40),
  ip_address            varchar(45),
  user_agent            varchar(500),

  -- 'usuario' | 'sistema' | 'auditoria'. El tercero queda declarado y SIN USAR: marcaria filas
  -- reconstruidas si algun dia se hace backfill (ADR-0014 lo descarta hoy).
  origen                varchar(20) NOT NULL DEFAULT 'usuario',
  motivo                text,
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT permisos_auditoria_entidad_chk
    CHECK (entidad IN ('usuario','rol','rol_funcion','usuario_funcion')),
  CONSTRAINT permisos_auditoria_accion_chk
    CHECK (accion IN ('crear','editar','borrar','baja','reactivar','activar','desactivar')),
  CONSTRAINT permisos_auditoria_origen_chk
    CHECK (origen IN ('usuario','sistema','auditoria')),

  -- El sujeto es uno y solo uno.
  CONSTRAINT permisos_auditoria_sujeto_chk
    CHECK ((usuario_afectado_id IS NOT NULL) <> (rol_afectado_codigo IS NOT NULL)),
  -- El rol del titular viaja emparejado con su id: uno sin el otro deja la fila a medias.
  CONSTRAINT permisos_auditoria_titular_rol_chk
    CHECK ((usuario_afectado_id IS NULL) = (usuario_afectado_rol IS NULL)),
  -- NULL en el actor significa «sistema», no «se desconoce».
  CONSTRAINT permisos_auditoria_actor_chk
    CHECK ((origen = 'usuario') = (actor_user_id IS NOT NULL)),
  -- Solo un borrado puede no nombrar campo.
  CONSTRAINT permisos_auditoria_campo_chk
    CHECK (campo IS NOT NULL OR accion = 'borrar'),

  -- El cierre de PII en base (ADR-0014 §4, cierre 3). Lista blanca: ni un INSERT crudo puede
  -- inventarse 'email', 'name' o 'username'. Misma lista que CAMPOS_AUDITABLES (shared-types).
  CONSTRAINT permisos_auditoria_campo_lista_chk CHECK (
    campo IS NULL OR campo IN (
      'role','active','deleted_at','password','funciones','allowed_pages',
      'organismos_codigos','compania_id','flito_proveedor_soat_id','transito_codigo',
      'nombre','descripcion','tipo_enlace','tipo_principal','activo',
      'conjunto'
    )
  ),
  -- El restablecimiento de contraseña es un HECHO auditable SIN VALOR. Ni el hash ni un fragmento.
  CONSTRAINT permisos_auditoria_password_sin_valor_chk
    CHECK (campo <> 'password' OR (valor_antes IS NULL AND valor_despues IS NULL))
);

-- ── Indices. Cuatro se pueden pagar aqui porque la escriben ACTOS DE ADMINISTRACION, no trafico
--    de producto — que es justo lo contrario de audit_logs.

-- «Que le paso a Fulano» — la consulta del AC2 y la de la pantalla.
CREATE INDEX IF NOT EXISTS idx_permisos_auditoria_titular
  ON permisos_auditoria (usuario_afectado_id, created_at DESC)
  WHERE usuario_afectado_id IS NOT NULL;

-- «Que le paso a este rol» (CF-19, filtro por recurso).
CREATE INDEX IF NOT EXISTS idx_permisos_auditoria_rol
  ON permisos_auditoria (rol_afectado_codigo, created_at DESC)
  WHERE rol_afectado_codigo IS NOT NULL;

-- Filtro por tipo de entidad + rango de fechas.
CREATE INDEX IF NOT EXISTS idx_permisos_auditoria_entidad
  ON permisos_auditoria (entidad, created_at DESC);

-- Listado sin filtro y paginacion. NO lo cubre el anterior: sin restringir `entidad` (su columna
-- guia) PostgreSQL no puede recorrerlo ordenado y acabaria en scan + sort.
CREATE INDEX IF NOT EXISTS idx_permisos_auditoria_created
  ON permisos_auditoria (created_at DESC);

-- ── Paso 2 — Inmutabilidad: REVOKE, NO disparador WORM ─────────────────────────────────────────
-- Copia el patron de laft_audit_log (0011). NO se copia el de siigo_operaciones (0126), que es WORM
-- por disparador: ese haria IMPOSIBLE ejecutar la retencion de 6 años que se declara mas abajo.
-- TRUNCATE tambien se revoca: el propietario lo conserva por defecto y vaciaria la tabla entera.
-- Idempotente: REVOKE y GRANT no fallan si ya estan aplicados.
REVOKE UPDATE, DELETE, TRUNCATE ON permisos_auditoria FROM PUBLIC;
DO $revoke0185$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'operaciones_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON permisos_auditoria FROM operaciones_app;
    GRANT SELECT, INSERT ON permisos_auditoria TO operaciones_app;
    GRANT USAGE, SELECT ON SEQUENCE permisos_auditoria_id_seq TO operaciones_app;
  END IF;
END $revoke0185$;

COMMENT ON TABLE permisos_auditoria IS
  'CF-19: historial consultable de cambios de usuarios, roles y permisos (HU #12171, ADR-0014). '
  'audit_logs sigue siendo la bitacora de cumplimiento transversal; esta es la que se consulta desde '
  'el producto. Del titular solo id y rol (RN-A10). Retencion declarada: 6 anios, archivar_offline '
  '(pesv_retencion_politicas.tipo_documento = permisos_auditoria); mecanismo en la HU #12215.';
COMMENT ON COLUMN permisos_auditoria.usuario_afectado_id IS
  'Titular del cambio. ON DELETE RESTRICT (ADR-0005, auditoria): con SET NULL la fila afirmaria un cambio sin sujeto y se romperia el JOIN que resuelve su nombre sin persistir PII.';
COMMENT ON COLUMN permisos_auditoria.rol_afectado_codigo IS
  'Rol afectado. SIN FK a proposito: RESTRICT impediria para siempre borrar un rol con historia (rompe CF-05) y CASCADE borraria justo lo que el auditor busca.';
COMMENT ON COLUMN permisos_auditoria.actor_email IS
  'Correo del AUTOR del acto. RN-A10 lo autoriza expresamente. El correo del TITULAR nunca se guarda aqui.';
COMMENT ON COLUMN permisos_auditoria.origen IS
  'usuario | sistema | auditoria. "sistema" es actor NULL con intencion; "auditoria" queda reservado para un backfill futuro y hoy no se usa.';

-- ── Paso 3 — Retencion declarada (AC5). El plazo se fija; el mecanismo NO se construye aqui ─────
-- 6 años y no 10 para no divergir de la fila ('audit_log', 6, 'ISO 27001 A.12.4', …) que la 0060 ya
-- sembro: un auditor que compare las dos bitacoras a traves del corte no debe encontrar una purgada
-- y la otra intacta. `archivar_offline`, no `purgar`: es evidencia (ADR-0014 §Retencion).
-- OJO: pesv/retencion.cron.ts es DRY-RUN por diseño. Esta fila DECLARA el plazo; el mecanismo es la
-- HU #12215. created_by es NOT NULL con FK a users: la siembra queda condicionada a que exista un
-- admin (guard de la 0180, no users.id = 1); por eso la politica va TAMBIEN en el COMMENT ON TABLE.
INSERT INTO pesv_retencion_politicas
  (tipo_documento, retencion_anios, base_legal, accion, notas_md, created_by)
SELECT 'permisos_auditoria', 6, 'Ley 1581/2012 art. 11 + ISO 27001 A.12.4',
       'archivar_offline'::pesv_retencion_accion,
       'Historial de cambios de usuarios, roles y permisos (CF-19, HU #12171). Alineado con la '
       'politica de audit_log para que las dos bitacoras no divergan. Mecanismo: HU #12215.',
       (SELECT min(id) FROM users WHERE role = 'admin')
 WHERE EXISTS (SELECT 1 FROM users WHERE role = 'admin')
ON CONFLICT (tipo_documento) DO NOTHING;

-- ── Paso 4 — Las dos funciones que guardan el lector, su reparto, y la pagina para el auditor ───
-- Formato del generador (generar-seed-permisos.ts): una tupla por linea. Es lo que lee el test de la
-- 0179 al comparar «lo sembrado en 0179 + 0181 + 0182 + 0184 + 0185» con «lo que produce la foto ampliada».
-- Textos de negocio fijados el 10/09/2026; si cambian, cambian aqui y en catalogo-operaciones.ts.
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('usuarios.auditoria.filtrar', 'usuarios', 'Listar los usuarios para filtrar el historial', 'Leer la lista de usuarios que tienen cambios registrados, para acotar el historial a uno.', 'operacion'),
  ('usuarios.auditoria.ver', 'usuarios', 'Ver el historial de cambios de usuarios y permisos', 'Leer quién cambió qué en usuarios, roles y permisos, con el valor anterior y el posterior.', 'operacion')
ON CONFLICT (codigo) DO NOTHING;

-- `pagina.users` para `auditor`: la pantalla del historial vive en el modulo de usuarios (AC3) y el
-- auditor no la tenia (0179 solo se la dio a admin). NO se le dan listar/ver_resumen: son PII de
-- todo el censo (AC4). Su pantalla monta solo el historial.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'usuarios.auditoria.filtrar'),
  ('admin', 'usuarios.auditoria.ver'),
  ('auditor', 'pagina.users'),
  ('auditor', 'usuarios.auditoria.filtrar'),
  ('auditor', 'usuarios.auditoria.ver')
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- ── Paso 5 — La cuenta, en el log del CD ────────────────────────────────────────────────────────
DO $resumen0185$
DECLARE n_politica int; n_reparto int;
BEGIN
  SELECT count(*) INTO n_politica FROM pesv_retencion_politicas WHERE tipo_documento = 'permisos_auditoria';
  SELECT count(*) INTO n_reparto FROM permisos_rol_funcion
   WHERE funcion_codigo IN ('usuarios.auditoria.ver', 'usuarios.auditoria.filtrar')
      OR (rol_codigo = 'auditor' AND funcion_codigo = 'pagina.users');
  RAISE NOTICE '0185: permisos_auditoria lista; politica de retencion sembrada = %; filas de reparto = % (esperadas 5)',
    n_politica, n_reparto;
END $resumen0185$;
