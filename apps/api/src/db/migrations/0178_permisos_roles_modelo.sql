-- 0178_permisos_roles_modelo.sql
-- Feature #12072 — Roles y permisos configurables: la lista de roles deja de ser un tipo cerrado.
-- HU #12169 (el modelo de datos: la tabla, la FK, el backfill y los dos triggers de ambito).
-- Autor: equipo FLITO. Antecedentes: ADR-0015 (aprobado el 9/09/2026 — PK textual e inmutable, el
--   tipo `user_role` se declara obsoleto pero NO se borra, dos triggers y `es_sistema` como candado
--   de borrado), docs/diseno-hu-12169-roles-catalogo-editable.md (el contrato de datos), migracion
--   0168 (el CHECK literal `users_cliente_compania_chk` que esta sustituye, y el 55P04 que obligo a
--   partirla de la 0167) y 0173 (`flito_gestor_organismos`, la OTRA forma del ambito de organismos).
-- Oleada 0 del Feature: la #12081 (0179) y la #12086 (0180) no pueden crear sus claves foraneas sin
--   la tabla que crea esta. El orden relativo 0178 → 0179 → 0180 no es negociable.
--
-- Hasta aquí `users.role` era el enum `user_role`. Sobre un enum de Postgres no se puede borrar un
-- valor y añadir uno exige publicar una versión: por eso CF-03 (crear un rol) y CF-05 (borrarlo) no
-- eran difíciles, eran imposibles. Esta migración mueve la lista de roles a una TABLA.
--
-- ADR-0015 (Aprobado) y docs/diseno-hu-12169-roles-catalogo-editable.md tienen el porqué. Aquí, el
-- qué, en nueve pasos cuyo orden NO es negociable.
--
-- Reglas de este archivo:
--   · Sin BEGIN/COMMIT propios (ADR-DB-001): el runner (`src/scripts/db-apply.ts`) envuelve cada
--     archivo en su propia transacción y rechaza con exit 2 cualquier migración >= 0071 que traiga
--     control de transacción. Los bloques DO van con dollar-quoting ETIQUETADO (guard, conv, fk, fn)
--     y nunca con el par pelado de dos dólares, para que el escáner empareje bien.
--     Y OJO, medido aquí: ese escáner (`scanForTxControl`) corre ANTES de quitar los comentarios,
--     así que NOMBRAR una etiqueta con sus dólares en un comentario la empareja con la apertura real
--     del bloque, deja el cuerpo sin tapar y reporta su BEGIN como si fuera top-level. Por eso en
--     este archivo las etiquetas se citan SIN dólares fuera del SQL. No es cosmética: costó un exit 2.
--   · NINGÚN `ALTER TYPE ... ADD VALUE`: el enum se ABANDONA, no se extiende. Esta migración no
--     repite el 55P04 que obligó a partir la 0167 y la 0168.
--   · Idempotente en sentido fuerte (AC1): la segunda pasada no cambia ni una fila. Las guardas de
--     los pasos 3, 4-5 y 6 no son cosmética — sin la del 4-5 la segunda pasada FALLA con
--     «cannot alter type of a column used in a trigger definition».

-- ── Paso 1 — La tabla (AC1) ─────────────────────────────────────────────────────────────────────
-- `codigo` es la PK y es INMUTABLE: 276 `requireRole('…')` lo comparan como literal, así que
-- renombrarlo no es editar un rol, es cambiar el sistema. Lo editable es `nombre`.
-- Los dos DEFAULT no están en el AC1 y se añaden a propósito: el CRUD de la #12084 va a nacer sin
-- ellos, y el default seguro de un rol nuevo es «no se ata a nada» e «interno» — uno que naciera
-- `externo` por descuido quedaría fuera del canal, y uno que exigiera compañía rompería su primer alta.
CREATE TABLE IF NOT EXISTS permisos_roles (
  codigo         varchar(40)  PRIMARY KEY,
  nombre         varchar(80)  NOT NULL,
  descripcion    text,
  tipo_enlace    varchar(24)  NOT NULL DEFAULT 'ninguno',
  tipo_principal varchar(10)  NOT NULL DEFAULT 'interno',
  es_sistema     boolean      NOT NULL DEFAULT false,
  activo         boolean      NOT NULL DEFAULT true,
  created_at     timestamptz  NOT NULL DEFAULT now(),
  updated_at     timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT permisos_roles_tipo_enlace_chk
    CHECK (tipo_enlace IN ('ninguno','compania','proveedor_soat','organismos_transito')),
  CONSTRAINT permisos_roles_tipo_principal_chk
    CHECK (tipo_principal IN ('interno','externo'))
);

COMMENT ON TABLE permisos_roles IS
  'Catalogo editable de roles (HU #12169). Sustituye al enum user_role como fuente de verdad de que '
  'roles existen. codigo es PK e INMUTABLE (lo comparan 276 requireRole); lo editable es nombre.';
COMMENT ON COLUMN permisos_roles.tipo_enlace IS
  'Que ambito exige el rol: ninguno | compania | proveedor_soat | organismos_transito. Lo hacen '
  'cumplir users_ambito_trg y users_ambito_organismos_trg, no un CHECK.';
COMMENT ON COLUMN permisos_roles.tipo_principal IS
  'interno | externo. Persistido por esta HU; lo consume el motor de la #12082/#12083. Hasta '
  'entonces la frontera del canal Cliente sigue disparandose por el literal de canal-cliente.ts.';
COMMENT ON COLUMN permisos_roles.es_sistema IS
  'CANDADO DE BORRADO (ADR-0015 Decision 5), no marca de origen: true => el rol no se borra. Solo '
  'admin (permanente) y cliente (temporal, hasta la #12082 AC8). Editar nombre/descripcion sigue '
  'permitido en los doce (CF-04).';
COMMENT ON COLUMN permisos_roles.activo IS
  'Gobierna la ASIGNACION, no la autenticacion: un usuario con rol inactivo sigue entrando y '
  'trabajando; lo que se bloquea son asignaciones nuevas (AC6).';

-- ── Paso 2 — Backfill de los doce (AC3) ─────────────────────────────────────────────────────────
-- Los doce `nombre` son LITERALMENTE ROLE_LABELS (packages/shared-types/src/permissions.ts:49-63),
-- tildes incluidas: si divergen, la pantalla muestra dos etiquetas para el mismo rol segun de donde
-- las lea. `descripcion` queda NULL a proposito — el texto de negocio es CF-01/#12084.
--
-- `operaciones` NO entra: se fusiono en `admin`, tiene cero usuarios, y crear su fila lo resucitaria
-- como asignable desde el panel de la #12084 el dia que se encienda.
--
-- ON CONFLICT DO NOTHING y NO `DO UPDATE`: con DO UPDATE la segunda pasada moveria `updated_at` en
-- doce filas y el AC1 («no cambia ni una fila») quedaria incumplido por la propia migracion.
INSERT INTO permisos_roles (codigo, nombre, tipo_enlace, tipo_principal, es_sistema) VALUES
  ('admin',            'Administrador',            'ninguno',             'interno', true),
  ('proveedor',        'Proveedor',                'proveedor_soat',      'interno', false),
  ('transito',         'Tránsito',                 'organismos_transito', 'interno', false),
  ('compliance',       'Cumplimiento (LAFT)',      'ninguno',             'interno', false),
  ('lider_pesv',       'Líder PESV',               'ninguno',             'interno', false),
  ('supervisor_flota', 'Supervisor de flota',      'ninguno',             'interno', false),
  ('conductor',        'Conductor',                'ninguno',             'interno', false),
  ('auditor',          'Auditor (revisor fiscal)', 'ninguno',             'interno', false),
  ('gestor_impuestos', 'Gestor de Impuestos',      'organismos_transito', 'interno', false),
  ('mensajero',        'Mensajero',                'ninguno',             'interno', false),
  ('financiera',       'Financiera',               'ninguno',             'interno', false),
  ('cliente',          'Cliente',                  'compania',            'externo', true)
ON CONFLICT (codigo) DO NOTHING;

-- ── Paso 3 — Guarda antes de tocar `users` ──────────────────────────────────────────────────────
-- Si en PDN hubiera un usuario con `operaciones` —o con cualquier etiqueta que aqui no se
-- contempla—, el paso 6 fallaria con un 23503 opaco a mitad de la conversion. Esto lo convierte en
-- un mensaje que NOMBRA el rol culpable, y el runner aborta el archivo entero: la base queda igual.
DO $guard$
DECLARE huerfanos text;
BEGIN
  SELECT string_agg(DISTINCT u.role::text, ', ') INTO huerfanos
    FROM users u LEFT JOIN permisos_roles p ON p.codigo = u.role::text
   WHERE p.codigo IS NULL;
  IF huerfanos IS NOT NULL THEN
    RAISE EXCEPTION '0178: hay usuarios con un rol que no tiene fila en permisos_roles (%)', huerfanos;
  END IF;
  RAISE NOTICE '0178: los % usuarios tienen todos su fila de rol', (SELECT count(*) FROM users);
END $guard$;

-- ── Pasos 4-5 — Quitar el CHECK de la 0168 y convertir la columna (AC2), CONDICIONADOS ──────────
-- La condicion NO es cosmetica: sin ella la SEGUNDA pasada falla con
--   ERROR: cannot alter type of a column used in a trigger definition
--   DETAIL: trigger users_ambito_trg on table users depends on column "role"
-- porque el trigger del paso 8 se declara `AFTER … UPDATE OF role, …`.
--
-- El DROP CONSTRAINT va DENTRO del mismo IF: el CHECK nombra 'cliente'::user_role y no sobrevive al
-- cambio de tipo, asi que las dos operaciones son indivisibles.
--
-- `USING role::text` es una conversion total y sin perdida (la etiqueta mas larga, `supervisor_flota`,
-- tiene 16 de 40). NINGUN usuario cambia de rol: el valor guardado es byte por byte el mismo texto.
DO $conv$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
     WHERE a.attrelid = 'users'::regclass AND a.attname = 'role' AND t.typname = 'user_role'
  ) THEN
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_cliente_compania_chk;
    ALTER TABLE users ALTER COLUMN role TYPE varchar(40) USING role::text;
    RAISE NOTICE '0178: users.role convertido de user_role a varchar(40)';
  ELSE
    RAISE NOTICE '0178: users.role ya es varchar — conversion omitida (segunda pasada)';
  END IF;
END $conv$;

-- ── Paso 6 — La FK (AC2), condicionada ──────────────────────────────────────────────────────────
-- ON DELETE RESTRICT es lo que sostiene CF-05 y RN-A8: un rol con usuarios asignados no se borra y
-- lo impide la BASE. ON UPDATE RESTRICT es adicion del diseño: el codigo es inmutable y que lo diga
-- la definicion vale mas que un comentario. Sin NOT VALID: el paso 3 ya probo que todas las filas casan.
DO $fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'users_role_fkey' AND conrelid = 'users'::regclass) THEN
    ALTER TABLE users ADD CONSTRAINT users_role_fkey
      FOREIGN KEY (role) REFERENCES permisos_roles(codigo)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
END $fk$;

-- ── Paso 7 — Indice sobre users.role ────────────────────────────────────────────────────────────
-- Hoy no existe. Lo pide el propio ON DELETE RESTRICT: sin el, borrar un rol escanea `users` entera
-- —el mismo argumento, palabra por palabra, que schema.ts escribio para idx_users_compania—.
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- ── Paso 8 — La funcion y los DOS triggers (AC4) ────────────────────────────────────────────────
-- El CHECK de la 0168 nombraba un literal ('cliente') y, siendo un CHECK, no podia consultar otra
-- tabla: jamas habria cubierto un rol NUEVO con tipo_enlace='compania'. Eso, y no el estilo, es la
-- razon del cambio.
--
-- Cada trigger vigila su rol Y las columnas donde vive el ambito que exige. Eso es lo que hace que
-- la garantia sea de la BASE y no del codigo de rutas: quitarle la compania a un `cliente` o el
-- organismo a un `transito` desde un psql de soporte falla igual que un alta mal formada. Medido, no
-- deducido: sin `transito_codigo` en la lista, `UPDATE users SET transito_codigo = NULL` sobre un
-- `transito` valido NO dispara nada y la fila incumplidora queda confirmada.
--
-- Lo que estos triggers NO hacen, y hay que saberlo:
--   · No validan las filas EN REPOSO (los triggers no corren sobre datos quietos).
--   · No se disparan al cambiar `active` — deliberado: `PATCH /:id/toggle` no debe fallar por una
--     atadura heredada que ese endpoint no toco. Por eso el `UPDATE OF <columnas>` y no `UPDATE`.
--   · No cubren que la tabla puente se toque por fuera: ese ambito vive en OTRA tabla y un trigger
--     sobre `users` no la ve. Y no es solo el DELETE — la PK de `flito_gestor_organismos` es
--     (user_id, organismo_codigo), asi que un `UPDATE ... SET user_id = <otro>` deja al gestor sin
--     ninguna fila exactamente igual que un borrado, y tampoco lo ve nadie. Las dos formas producen
--     el mismo estado y las dos siguen abiertas. El tercer trigger que las cierra va en la #12088,
--     que es quien se lleva esa atadura.
--   · No comprueban que `users.transito_codigo` APUNTE A ALGO. Y hay que decirlo aqui porque es la
--     puerta que sostiene la garantia nueva: el brazo diferido acepta `transito_codigo IS NOT NULL`
--     como prueba de ambito satisfecho, y esa columna NO tiene clave foranea (schema.ts la declara
--     varchar(5) pelado; cero constraints de tipo `f` sobre ella, medido). Un '99999' escrito desde
--     un psql satisface el trigger, y borrar una fila de `organismos_transito_config` deja al
--     `transito` apuntando a la nada sin que nada lo impida. A un `gestor_impuestos` eso SI se lo
--     impide su FK `ON DELETE RESTRICT` en la tabla puente: de las dos formas del mismo ambito, solo
--     una esta declarada. Ponerle la FK a `transito_codigo` es alcance de la #12088, que unifica las
--     dos formas; esta HU no la anade para no meter una migracion de datos ajena a su AC.
--   · No reaccionan a que el admin cambie el tipo_enlace de un rol YA asignado (eso es la #12084).
CREATE OR REPLACE FUNCTION users_ambito_requerido() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE te text;
BEGIN
  SELECT tipo_enlace INTO te FROM permisos_roles WHERE codigo = NEW.role;
  IF te IS NULL THEN
    RAISE EXCEPTION 'El rol % no existe en permisos_roles (usuario %)', NEW.role, NEW.id
      USING ERRCODE = '23503';
  END IF;
  IF te = 'compania' AND NEW.compania_id IS NULL THEN
    RAISE EXCEPTION 'El rol % exige compañía y el usuario % no la tiene', NEW.role, NEW.id
      USING ERRCODE = '23514';
  END IF;
  IF te = 'proveedor_soat' AND NEW.flito_proveedor_soat_id IS NULL THEN
    RAISE EXCEPTION 'El rol % exige proveedor SOAT y el usuario % no lo tiene', NEW.role, NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;  -- AFTER trigger: el valor de retorno se ignora
END $fn$;

-- El ambito que vive en OTRA tabla, escrita DESPUES del usuario. INITIALLY DEFERRED y no IMMEDIATE:
-- users.service.ts:161-163 inserta `users` y despues sus organismos, asi que un trigger inmediato se
-- evalua con la tabla puente todavia vacia y hace fallar el alta de TODO gestor_impuestos. Invertir
-- el orden no es posible: la PK de la puente es user_id, que no existe hasta despues del INSERT.
-- Lo que se pierde con el diferido es el MOMENTO del error, no la garantia.
--
-- El predicado acepta las DOS formas —transito_codigo o >=1 fila puente— porque el AC3 da el mismo
-- tipo_enlace a `transito` (que guarda su organismo en users.transito_codigo) y a `gestor_impuestos`
-- (que lo guarda en la puente). Un predicado que mirase solo la puente rechaza el alta de todo
-- usuario `transito`. Unificar las dos formas es la HU #12088, no esta.
CREATE OR REPLACE FUNCTION users_ambito_organismos_requerido() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE te text;
BEGIN
  SELECT tipo_enlace INTO te FROM permisos_roles WHERE codigo = NEW.role;
  IF te = 'organismos_transito'
     AND NEW.transito_codigo IS NULL
     AND NOT EXISTS (SELECT 1 FROM flito_gestor_organismos g WHERE g.user_id = NEW.id) THEN
    RAISE EXCEPTION 'El rol % exige al menos un organismo y el usuario % no tiene ninguno',
      NEW.role, NEW.id USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS users_ambito_trg ON users;
CREATE CONSTRAINT TRIGGER users_ambito_trg
  AFTER INSERT OR UPDATE OF role, compania_id, flito_proveedor_soat_id ON users
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION users_ambito_requerido();

DROP TRIGGER IF EXISTS users_ambito_organismos_trg ON users;
CREATE CONSTRAINT TRIGGER users_ambito_organismos_trg
  AFTER INSERT OR UPDATE OF role, transito_codigo ON users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION users_ambito_organismos_requerido();

-- ── Paso 9 — El tipo queda obsoleto, y NO se borra (AC2) ────────────────────────────────────────
-- Un DROP TYPE no aporta nada —no ocupa, no se usa, no se puede asignar— y quita la unica via de
-- vuelta barata de esta HU. Esa via se cierra sola el dia que el primer usuario tenga un rol creado
-- por el administrador; entonces borrar el tipo sera una migracion de una linea que no arriesga nada.
COMMENT ON TYPE user_role IS
  'OBSOLETO desde la migracion 0178 (HU #12169). Ninguna columna lo usa: users.role paso a '
  'varchar(40) con FK a permisos_roles.codigo. NO se borra a proposito: es la unica via de vuelta '
  'si hubiera que revertir la 0178, y esa via solo existe mientras todos los users.role sean '
  'etiquetas de este tipo. No anadirle valores: el catalogo editable es permisos_roles.';
