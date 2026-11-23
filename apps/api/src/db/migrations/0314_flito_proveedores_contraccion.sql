-- 0314_flito_proveedores_contraccion.sql
-- Autor: David Chica
-- Feature #14327, HU #14355 (ADR-0039 §5.2, F5 E2) — contracción: se retiran la sincronización y las columnas
-- duplicadas de los perfiles de proveedor. IRREVERSIBLE: exige `pg_dump` de PDN previo a la promoción, y no viaja
-- en la misma promoción que la #14354 ni que la #14673 (la imagen anterior lee y escribe estas columnas).
--
-- Desde aquí el padre `flito_proveedores` es la única copia de `nombre`, `activo`, `nit`, `contacto` y `telefono`.
-- Se retiran:
--   · los triggers de transición de la 0292 y la 0313 (`perfil_crea_padre`, `perfil_a_padre`, `padre_a_perfil`,
--     `perfil_borrado`, `perfil_espejo_baja`, `users_proveedor_sync`) y sus funciones;
--   · las columnas `nombre` y `activo` de los dos perfiles; `estrategia`, `nit`, `contacto` y `telefono` de
--     Logística; `users.flito_proveedor_soat_id`, con sus índices.
-- SOAT conserva `estrategia`, `umbral_ocr` y `sla_horas`. `permisos_auditoria_campo_lista_chk` (0295) conserva
-- `'flito_proveedor_soat_id'`: la auditoría histórica lo nombra.
--
-- Sin BEGIN/COMMIT (ADR-DB-001): el runner envuelve el archivo y su registro en la misma transacción, así que la
-- guarda deja la BD intacta y la migración sin registrar. Idempotente: la segunda corrida no encuentra columnas
-- que comparar ni nada que retirar.

-- Con `strategy: Recreate` en PDN la API ya está caída: sin un límite, un lock ajeno la dejaría esperando sin
-- ningún error en el log. Así falla a los 30 s y queda visible en el initContainer. ACCESS EXCLUSIVE: nadie lee
-- un perfil a medio retirar ni escribe uno entre la guarda y el DROP.
SET LOCAL lock_timeout = '30s';
LOCK TABLE flito_proveedores, flito_proveedores_soat, flito_proveedores_logistica, users IN ACCESS EXCLUSIVE MODE;

-- ── Paso 1. Guarda: ningún perfil vigente difiere de su padre (AC3) ─────────────────────────────────────
-- El mensaje solo lleva UUIDs, ids de usuario y nombres de campo, nunca valores: el NIT de una persona natural
-- equivale a su cédula y este texto termina en el log del initContainer.
DO $guarda$
DECLARE
  casos text[] := ARRAY[]::text[];
  fila record;
  sin_pwa bigint;
BEGIN
  -- >>> DIFERENCIAS (idéntico en 0314 y en manual/flito-proveedores-contraccion-preflight.sql; el test exige la igualdad)
  -- `to_jsonb` lee cada columna vieja solo si existe: tras la 0314 no queda ninguna y no hay nada que comparar.
  -- La guarda protege lo que se va a eliminar, así que el padre de baja también se mira solo mientras exista.
  FOR fila IN
    SELECT 'SOAT'::text AS origen, s.id,
           array_to_string(array_remove(ARRAY[
             CASE WHEN p.deleted_at IS NOT NULL THEN 'padre de baja' END,
             CASE WHEN (x.j ->> 'nombre') IS DISTINCT FROM p.nombre THEN 'nombre' END,
             CASE WHEN (x.j ->> 'activo') IS DISTINCT FROM p.activo::text THEN 'activo' END
           ], NULL), ', ') AS campos
    FROM flito_proveedores_soat s
    JOIN flito_proveedores p ON p.id = s.id
    CROSS JOIN LATERAL (SELECT to_jsonb(s) AS j) x
    WHERE s.deleted_at IS NULL AND x.j ? 'nombre'
    UNION ALL
    SELECT 'Logística', l.id,
           array_to_string(array_remove(ARRAY[
             CASE WHEN p.deleted_at IS NOT NULL THEN 'padre de baja' END,
             CASE WHEN (x.j ->> 'nombre') IS DISTINCT FROM p.nombre THEN 'nombre' END,
             CASE WHEN (x.j ->> 'activo') IS DISTINCT FROM p.activo::text THEN 'activo' END,
             CASE WHEN NULLIF(btrim(x.j ->> 'nit'), '') IS DISTINCT FROM NULLIF(btrim(p.nit), '') THEN 'nit' END,
             CASE WHEN (x.j ->> 'contacto') IS DISTINCT FROM p.contacto THEN 'contacto' END,
             CASE WHEN (x.j ->> 'telefono') IS DISTINCT FROM p.telefono THEN 'telefono' END
           ], NULL), ', ')
    FROM flito_proveedores_logistica l
    JOIN flito_proveedores p ON p.id = l.id
    CROSS JOIN LATERAL (SELECT to_jsonb(l) AS j) x
    WHERE l.deleted_at IS NULL AND x.j ? 'nombre'
    ORDER BY 1, 2
  LOOP
    IF fila.campos <> '' THEN
      casos := casos || format('PERFIL DISTINTO: %s %s difiere de su proveedor padre en: %s.', fila.origen, fila.id, fila.campos);
    END IF;
  END LOOP;

  -- Usuario cuya pertenencia vieja no coincide con la nueva: al retirar la vieja cambiaría de proveedor sin aviso.
  FOR fila IN
    SELECT u.id
    FROM users u
    CROSS JOIN LATERAL (SELECT to_jsonb(u) ->> 'flito_proveedor_soat_id' AS vieja) x
    WHERE x.vieja IS NOT NULL AND x.vieja::uuid IS DISTINCT FROM u.flito_proveedor_id
    ORDER BY u.id
  LOOP
    casos := casos || format('USUARIO DISTINTO: el usuario %s tiene flito_proveedor_soat_id distinto de flito_proveedor_id.', fila.id);
  END LOOP;
  -- <<< DIFERENCIAS

  IF cardinality(casos) > 0 THEN
    RAISE EXCEPTION '%', format(
      E'0314 detenida: %s caso(s) de proveedores por corregir. No se eliminó nada.\n- %s\nEjecute apps/api/src/db/manual/flito-proveedores-contraccion-preflight.sql, corrija los datos y reintente el despliegue.',
      cardinality(casos), array_to_string(casos, E'\n- '));
  END IF;

  -- La estrategia de Logística se pierde (decisión aceptada en la #14355): solo se informa cuántas no eran la de defecto.
  SELECT count(*) INTO sin_pwa
  FROM flito_proveedores_logistica l
  WHERE to_jsonb(l) ? 'estrategia' AND (to_jsonb(l) ->> 'estrategia') IS DISTINCT FROM 'pwa_propia';
  IF sin_pwa > 0 THEN
    RAISE NOTICE '0314: % perfil(es) de Logística tenían estrategia distinta de pwa_propia; el dato se elimina.', sin_pwa;
  END IF;
END
$guarda$;

-- ── Paso 2. Triggers y funciones de transición (AC4) ────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS perfil_crea_padre ON flito_proveedores_soat;
DROP TRIGGER IF EXISTS perfil_crea_padre ON flito_proveedores_logistica;
DROP TRIGGER IF EXISTS perfil_a_padre ON flito_proveedores_soat;
DROP TRIGGER IF EXISTS perfil_a_padre ON flito_proveedores_logistica;
DROP TRIGGER IF EXISTS perfil_espejo_baja ON flito_proveedores_soat;
DROP TRIGGER IF EXISTS perfil_espejo_baja ON flito_proveedores_logistica;
DROP TRIGGER IF EXISTS padre_a_perfil ON flito_proveedores;
DROP TRIGGER IF EXISTS perfil_borrado ON flito_proveedores_logistica;
DROP TRIGGER IF EXISTS users_proveedor_sync ON users;

-- Sin CASCADE: si algo más dependiera de ellas, la migración falla en lugar de llevárselo en silencio.
DROP FUNCTION IF EXISTS flito_proveedor_perfil_crea_padre();
DROP FUNCTION IF EXISTS flito_proveedor_perfil_a_padre();
DROP FUNCTION IF EXISTS flito_proveedor_padre_a_perfil();
DROP FUNCTION IF EXISTS flito_proveedor_perfil_borrado();
DROP FUNCTION IF EXISTS flito_proveedor_perfil_espejo_baja();
DROP FUNCTION IF EXISTS flito_proveedor_restriccion_del_perfil(text, text);
DROP FUNCTION IF EXISTS users_proveedor_sincroniza();

-- ── Paso 3. Ámbito del usuario sin la columna vieja (AC6) ───────────────────────────────────────────────
-- `users_ambito_trg` nombra `flito_proveedor_soat_id` en su `UPDATE OF`: el DROP COLUMN sin CASCADE fallaría y con
-- CASCADE se lo llevaría. Se recrea igual que en la 0292 sin esa columna; `users_ambito_requerido()` ya solo lee
-- `flito_proveedor_id` y no cambia.
DROP TRIGGER IF EXISTS users_ambito_trg ON users;
CREATE CONSTRAINT TRIGGER users_ambito_trg
  AFTER INSERT OR UPDATE OF role, compania_id, flito_proveedor_id ON users
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION users_ambito_requerido();

-- ── Paso 4. Índices y columnas (AC5) ────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS idx_users_flito_proveedor_soat;
DROP INDEX IF EXISTS uq_flito_proveedores_soat_nombre_vivo;
DROP INDEX IF EXISTS uq_flito_proveedores_logistica_nombre_vivo;
DROP INDEX IF EXISTS uq_flito_proveedores_logistica_nit;

ALTER TABLE users DROP COLUMN IF EXISTS flito_proveedor_soat_id;

ALTER TABLE flito_proveedores_soat DROP COLUMN IF EXISTS nombre;
ALTER TABLE flito_proveedores_soat DROP COLUMN IF EXISTS activo;

ALTER TABLE flito_proveedores_logistica DROP COLUMN IF EXISTS nombre;
ALTER TABLE flito_proveedores_logistica DROP COLUMN IF EXISTS estrategia;
ALTER TABLE flito_proveedores_logistica DROP COLUMN IF EXISTS activo;
ALTER TABLE flito_proveedores_logistica DROP COLUMN IF EXISTS nit;
ALTER TABLE flito_proveedores_logistica DROP COLUMN IF EXISTS contacto;
ALTER TABLE flito_proveedores_logistica DROP COLUMN IF EXISTS telefono;
