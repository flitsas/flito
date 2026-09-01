-- 0167_flito_soat_canal_cliente.sql
-- Feature #11912 — Solicitud de SOAT sin trámite (canal Cliente). HU #11913 (identidad: rol
-- `cliente`, compañía obligatoria y flag «SOAT sin trámite»).
-- Autor: equipo FLITO. Diseño y tradeoffs: docs/adr/ADR-0008-flito-soat-canal-cliente.md
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo con `sql.begin()`).
-- Idempotente en el sentido fuerte: la segunda pasada no cambia NI UNA FILA.
--
-- Ningún comentario de este archivo escribe el par de dólares que abre un bloque: el guarda de
-- ADR-DB-001 (`scanForTxControl`) tapa los bloques citados con dólares ANTES de quitar los
-- comentarios, así que un par suelto dentro de un `--` emparejaría con el que abre el bloque de
-- GRANTs del final, dejaría su BEGIN a la intemperie y abortaría el `db:apply` con exit 2 por una
-- migración que está bien. Lección de la 0156.
--
-- ============================================================================
-- POR QUÉ ESTA MIGRACIÓN TIENE UNA HERMANA (LA 0168) Y NO SE PUEDE FUSIONAR
-- ============================================================================
--
-- Aquí se AÑADEN valores a dos enums (`user_role` ← 'cliente'; `flito_soat_estado` ←
-- 'pendiente_revision', 'rechazada'). PostgreSQL admite `ALTER TYPE ... ADD VALUE` dentro de una
-- transacción desde la 12, pero PROHÍBE **usar** el valor nuevo en esa misma transacción:
--
--     ERROR:  55P04: unsafe use of new value "cliente" of enum type user_role
--
-- «Usarlo» incluye escribirlo en un CHECK, en un DEFAULT o en un UPDATE. Y el runner envuelve CADA
-- ARCHIVO en su propia transacción, así que el único statement que nombra un valor nuevo —el CHECK
-- de `users` que sostiene el AC2 en la base— vive en la 0168 y no aquí.
--
-- Existe el atajo de comparar texto (`CHECK (role::text <> 'cliente' OR …)`), que no toca el enum y
-- cabría en un solo archivo. Se descartó a propósito: es correcto y es ilegible, y el día que
-- alguien lo «limpie» quitando el cast, la migración deja de aplicar en un entorno nuevo y sigue
-- funcionando en los que ya la tienen — un fallo que solo aparece donde nadie está mirando. Dos
-- archivos cuestan un número y no esconden nada.
--
-- ============================================================================
-- QUÉ TRAE, Y POR QUÉ, EN UNA FRASE CADA COSA
-- ============================================================================
--
--   1. `user_role` ← 'cliente'                     — el rol del usuario de una compañía cliente.
--   2. `flito_soat_estado` ← dos estados           — el ciclo del canal (los escribe la #11914/#11915).
--   3. `users.compania_id`                         — la atadura de visibilidad de ese rol.
--   4. `clients.soat_sin_tramite`                  — el flag que habilita el canal por compañía.
--   5. `flito_soat.origen`                         — de qué puerta salió la fila.
--   6. `flito_soat_causales_rechazo`               — catálogo del rechazo del admin.
--   7. `flito_soat_solicitud`                      — satélite 1:1 con lo demás del canal.
--   8. `flito_compradores` con DOS padres          — el propietario sigue donde la cola lo busca.
--   9. Índice parcial de la factura de venta       — una sola factura VIVA por SOAT.
--  10. `users.allowed_pages` ← 'flito_soat'        — nadie pierde la pantalla que ya podía abrir.
--
-- ============================================================================
-- SOBRE EL VALOR 'operaciones' QUE SIGUE EN `user_role`
-- ============================================================================
--
-- Está y se queda. Se fusionó en `admin` hace tiempo y `permissions.ts` lo omite de `USER_ROLES`,
-- pero PostgreSQL no permite quitar un valor de un enum en uso sin recrear el tipo (lo que la 0101
-- pudo hacer solo porque la base estaba en datos de seed). No es un incumplimiento del AC4 de la
-- HU #11913: ese AC habla del catálogo que el PRODUCTO ofrece —`ALL_ROLES`, de donde salen el
-- `z.enum(ALL_ROLES)` del alta de usuarios y el selector de la pantalla—, y ahí `operaciones` ya no
-- está. Un valor huérfano en el tipo de Postgres no es asignable por ninguna vía del producto.
-- Queda escrito aquí para que nadie lo confunda con una regresión de este Feature.
--
-- ============================================================================
-- NO HAY `NOT VALID` + `VALIDATE` EN NINGUNA PARTE
-- ============================================================================
--
-- Medido: `clients` tiene 4 filas y `users` el puñado de esta instalación. El patrón diferido es
-- para no escanear una tabla grande bajo ACCESS EXCLUSIVE; aquí solo añadiría dos pasos y la
-- ilusión de que el `ALTER TABLE` es peligroso. Se dice explícitamente para que nadie lo añada «por
-- si acaso» y complique dos migraciones que no lo necesitan.

-- ── 1. Los valores nuevos de los dos enums ──────────────────────────────────
--
-- `IF NOT EXISTS` es lo que hace idempotente la segunda pasada; sin él sería un 42710. Es el patrón
-- de las migraciones 0095, 0106 y 0154.
--
-- Van al FINAL de cada enum, que es lo único que `ADD VALUE` sin `BEFORE`/`AFTER` puede hacer, y no
-- estorba: nada en el código hace `ORDER BY estado` (la cola ordena por `created_at`), así que la
-- posición no altera ningún resultado.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'cliente';

ALTER TYPE flito_soat_estado ADD VALUE IF NOT EXISTS 'pendiente_revision';
ALTER TYPE flito_soat_estado ADD VALUE IF NOT EXISTS 'rechazada';

-- ── 2. `users.compania_id` — la atadura de visibilidad del rol `cliente` ────
--
-- NULLABLE en la base, y no es una concesión: 11 de los 12 roles no tienen compañía, así que un
-- NOT NULL obligaría a inventarle una a cada admin. La obligatoriedad es CONDICIONAL al rol, y una
-- condición no se expresa con NOT NULL: la expresa el CHECK de la 0168.
--
-- `ON DELETE RESTRICT` explícito. Las tres opciones y por qué pierden las otras dos: CASCADE
-- borraría usuarios al borrar una compañía, en silencio y sin rastro de por qué desaparecieron;
-- SET NULL dejaría un usuario `cliente` SIN compañía, que es exactamente el estado que el AC2
-- declara imposible, y lo crearía por la puerta de atrás saltándose las tres capas que lo
-- defienden. RESTRICT convierte el borrado de una compañía con usuarios en un error nombrado, que
-- es lo correcto: alguien tiene que decidir qué pasa con esas personas.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS compania_id integer REFERENCES clients(id) ON DELETE RESTRICT;

-- El índice no es para una consulta: es para el RESTRICT. Sin él, borrar una compañía escanea
-- `users` entera para comprobar que nadie la referencia.
CREATE INDEX IF NOT EXISTS idx_users_compania ON users (compania_id);

COMMENT ON COLUMN users.compania_id IS
  'Compania de la que es este usuario (Feature #11912). Es la atadura de visibilidad del rol '
  'cliente, igual que flito_proveedor_soat_id lo es del gestor: contextoSoat() la lee de la BD y NO '
  'del JWT, para que un cambio de compania surta efecto sin re-emitir el token. Nullable a proposito '
  '(11 de los 12 roles no tienen compania); la obligatoriedad condicional al rol la sostiene el '
  'CHECK users_cliente_compania_chk de la migracion 0168. ON DELETE RESTRICT: borrar una compania '
  'con usuarios tiene que ser un error nombrado, no un borrado en cascada ni un cliente huerfano.';

-- ── 3. `clients.soat_sin_tramite` — el flag por compañía ────────────────────
--
-- Nace APAGADO para las 4 compañías que ya existen y para las que vengan (AC3): el canal no se abre
-- solo. `NOT NULL DEFAULT false` y no nullable como `soat_autogestionable`, que sí lo era en su
-- primera versión y obliga a un COALESCE en cada consulta que la mira.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS soat_sin_tramite boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN clients.soat_sin_tramite IS
  'La compania puede pedirle a FLITO el SOAT de un vehiculo que NO tiene tramite digital abierto '
  '(Feature #11912). INDEPENDIENTE de soat_autogestionable y no una sub-opcion suya: aquella dice '
  'que la compania se compra el SOAT por su cuenta y FLITO no lo gestiona; esta dice que sus '
  'usuarios cliente pueden pedirselo a FLITO sin tramite de por medio. Las dos encendidas a la vez '
  'es una combinacion valida y esperada, y es la que obliga a que la frontera de autogestion de '
  'flito-soat.service.ts deje pasar lo que nace con origen = cliente. Nace apagada (AC3).';

-- ── 4. `flito_soat.origen` — de qué puerta salió la fila ────────────────────
--
-- Una sola columna nueva en la tabla caliente, y es lo unico del canal que las consultas existentes
-- necesitan mirar sin un JOIN: la frontera de autogestión, la cola y el tablero. Todo lo demás vive
-- en la satélite de más abajo, porque `buscarConAcceso()` hace `select` de esta fila ENTERA y la
-- sirve a las rutas del gestor del proveedor.
--
-- `DEFAULT 'tramite'` rellena las filas existentes sin un UPDATE aparte: hasta hoy la única puerta
-- a esta tabla era `resolverSoat()`, dentro del sync de trámites de FLIT.
ALTER TABLE flito_soat
  ADD COLUMN IF NOT EXISTS origen varchar(10) NOT NULL DEFAULT 'tramite';

-- DROP + ADD y no un bloque DO: PostgreSQL no admite `ADD CONSTRAINT IF NOT EXISTS`, y esta forma
-- —la que usó la 0157 tres veces— además reescribe la definición si alguien la cambió a mano.
-- El CHECK nombra valores de un varchar, no de un enum: no hay 55P04 que temer aquí.
ALTER TABLE flito_soat DROP CONSTRAINT IF EXISTS flito_soat_origen_chk;
ALTER TABLE flito_soat ADD CONSTRAINT flito_soat_origen_chk
  CHECK (origen IN ('tramite', 'cliente'));

COMMENT ON COLUMN flito_soat.origen IS
  'De que puerta salio esta fila (Feature #11912): tramite = el sync de FLIT (la unica que existia '
  'hasta hoy, y de ahi el DEFAULT); cliente = una compania la pidio sin tramite digital. Es la UNICA '
  'columna del canal Cliente en esta tabla, a proposito: buscarConAcceso() hace select de la fila '
  'entera y la sirve a las rutas del gestor del proveedor, asi que la PII del propietario y el '
  'detalle del rechazo viven fuera (flito_compradores y flito_soat_solicitud). varchar + CHECK y no '
  'un enum: ampliarlo es un DROP/ADD CONSTRAINT barato, mientras que un enum arrastraria a cada '
  'migracion futura la trampa del 55P04 que este Feature ya paga dos veces.';

-- ── 5. Catálogo de causales de rechazo ──────────────────────────────────────
--
-- General y no por compañía, como pide la HU #11915 y como ya hace `flito_comparendos_causales`,
-- de la que esta tabla es copia. Nace VACÍA: quien la puebla y la consume es la #11915. Está aquí
-- porque la 0167 es la única migración de la cadena de cuatro HU, y partirla en cuatro archivos por
-- fidelidad al reparto no ayudaría a nadie.
CREATE TABLE IF NOT EXISTS flito_soat_causales_rechazo (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre     varchar(120) NOT NULL,
  activo     boolean NOT NULL DEFAULT true,
  orden      smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_soat_causales_nombre
  ON flito_soat_causales_rechazo (nombre);

COMMENT ON TABLE flito_soat_causales_rechazo IS
  'Causales del rechazo que el ADMIN aplica a una solicitud del canal Cliente (Feature #11912). '
  'Catalogo general, no por compania, calcado de flito_comparendos_causales. Nace vacio: lo puebla '
  'la HU #11915.';

-- ── 6. Satélite 1:1 con el resto del canal ──────────────────────────────────
--
-- `soat_id` es la PRIMARY KEY: eso da el 1:1 gratis, sin un índice único aparte que alguien pueda
-- olvidar. `ON DELETE CASCADE` porque estos datos no significan nada sin su SOAT.
--
-- Por qué una tabla aparte y no doce columnas en `flito_soat`: `buscarConAcceso()` selecciona la
-- fila entera de `flito_soat` y ese objeto alimenta el detalle, el rechazo, la reversa, el traspaso
-- y la carga de factura — las rutas del GESTOR DEL PROVEEDOR. Hoy esa fila es inocua; con la
-- observación del rechazo dentro dejaría de serlo, y la regresión sería invisible porque ningún
-- test compara la forma de una fila.
--
-- El PROPIETARIO no está aquí: va a `flito_compradores` (punto 7), que es donde el término de
-- búsqueda de la cola ya lo interroga.
CREATE TABLE IF NOT EXISTS flito_soat_solicitud (
  soat_id                uuid PRIMARY KEY REFERENCES flito_soat(id) ON DELETE CASCADE,
  -- El id puede quedar NULL si el usuario se borra; el nombre es el rastro durable. Mismo patrón
  -- que flito_soportes.subido_por_nombre.
  solicitado_por_id      integer REFERENCES users(id),
  solicitado_por_nombre  varchar(150) NOT NULL,
  solicitado_en          timestamptz NOT NULL DEFAULT now(),
  revisado_por_id        integer REFERENCES users(id),
  revisado_por_nombre    varchar(150),
  revisado_en            timestamptz,
  -- Causal + observación del rechazo del ADMIN (estado `rechazada`). NO se reutiliza
  -- flito_soat.motivo_rechazo, que es el del GESTOR (`con_novedad`): otro actor, otro estado
  -- destino y otra audiencia.
  causal_rechazo_id      uuid REFERENCES flito_soat_causales_rechazo(id),
  observacion_rechazo    text,
  -- Cuántas veces el cliente subsanó y volvió a enviar: la solicitud que va y viene sin resolverse
  -- es la que hay que llamar por teléfono.
  reenvios               smallint NOT NULL DEFAULT 0,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flito_soat_solicitud_causal
  ON flito_soat_solicitud (causal_rechazo_id);

COMMENT ON TABLE flito_soat_solicitud IS
  'Satelite 1:1 de flito_soat con lo que solo existe cuando el SOAT nacio del canal Cliente '
  '(Feature #11912): quien lo radico, quien lo reviso, la causal y la observacion del rechazo del '
  'admin, y cuantas veces se reenvio tras subsanar. Vive aparte para que la PII y el detalle del '
  'rechazo NO entren en el select de fila entera que buscarConAcceso() sirve al gestor del '
  'proveedor. La escriben las HU #11914 y #11915.';

-- ── 7. `flito_compradores` pasa a colgar de DOS padres ──────────────────────
--
-- El propietario del vehículo del canal Cliente va AQUÍ y no a una tabla nueva, por una consulta
-- concreta: el término de búsqueda de la cola (`condicionesCola`) busca el nombre y el documento del
-- propietario con un EXISTS sobre `flito_tramites` × `flito_compradores`. Si el canal Cliente
-- guardara su propietario en otro sitio, el admin no podría buscar por propietario justo las
-- solicitudes que tiene que revisar — y el filtro seguiría verde, devolviendo menos filas de las que
-- hay. Es el peor modo de fallo de una pantalla de revisión.
--
-- El precio es que el nombre de la tabla ya no cuenta toda la verdad (`tramite_id` deja de ser
-- obligatorio). El CHECK lo hace verificable.
ALTER TABLE flito_compradores
  ADD COLUMN IF NOT EXISTS soat_id uuid REFERENCES flito_soat(id) ON DELETE CASCADE;

-- Catálogo RUNT (CC, CE, TI, PAS, PPT, NIT, RC, PT). Sin CHECK y nullable: las filas que ya existen
-- vinieron del sync sin tipo, y un valor inesperado del RUNT no debe tumbar un alta.
ALTER TABLE flito_compradores
  ADD COLUMN IF NOT EXISTS tipo_documento varchar(5);

-- Idempotente por definición: quitar una restricción que ya no está es un no-op.
ALTER TABLE flito_compradores
  ALTER COLUMN tramite_id DROP NOT NULL;

-- «Uno y solo uno», el patrón literal que flito_soportes ya usa con sus FK. La igualdad negada de
-- dos predicados dice lo mismo que un OR de dos ramas, cabe en una línea y no tiene una rama que
-- alguien pueda editar a medias. Sin él, una fila podría colgar de los dos padres —y desaparecer
-- con el CASCADE del que no la creó— o de ninguno, que es un propietario huérfano.
--
-- Se aplica sobre las filas que ya existen sin `NOT VALID`: todas tienen `tramite_id` y ninguna
-- tiene `soat_id` (la columna nace en esta migración), así que ninguna puede violarlo.
ALTER TABLE flito_compradores DROP CONSTRAINT IF EXISTS flito_compradores_padre_chk;
ALTER TABLE flito_compradores ADD CONSTRAINT flito_compradores_padre_chk
  CHECK ((tramite_id IS NOT NULL) <> (soat_id IS NOT NULL));

CREATE INDEX IF NOT EXISTS idx_flito_compradores_soat
  ON flito_compradores (soat_id);

COMMENT ON COLUMN flito_compradores.soat_id IS
  'El SEGUNDO padre de esta tabla (Feature #11912): el SOAT del canal Cliente, que no tiene tramite. '
  'Uno y solo uno de tramite_id / soat_id, garantizado por flito_compradores_padre_chk. El '
  'propietario vive aqui y no en una tabla nueva porque es donde el termino de busqueda de la cola '
  'ya lo interroga; guardarlo en otro sitio dejaria al admin sin poder buscar por propietario las '
  'solicitudes que tiene que revisar, con el filtro en verde.';

-- ── 8. Una sola factura de venta VIVA por SOAT ──────────────────────────────
--
-- Tercero de la familia de índices parciales de `flito_soportes` (0139 y 0157 pusieron los suyos por
-- el mismo motivo). La subsanación de la HU #11915 vuelve a subir el archivo: sin el índice se
-- acumularían dos facturas de venta vivas y la pantalla mostraría la que ordenara primero.
--
-- `descartado = false` no es decoración: sin esa condición, una factura descartada bloquearía para
-- siempre la subsanación de esa solicitud.
CREATE UNIQUE INDEX IF NOT EXISTS idx_flito_soportes_soat_factura_venta
  ON flito_soportes (soat_id)
  WHERE soat_id IS NOT NULL AND tipo = 'factura_venta' AND descartado = false;

-- ── 9. `allowed_pages` ← 'flito_soat' ───────────────────────────────────────
--
-- El portal `/flito/soat` estrena slug propio (`flito_soat`) porque `cliente` es el primer rol para
-- el que el portal y el módulo SOAT legacy tienen respuestas opuestas. El cambio es ADITIVO en el
-- catálogo —`proveedor` y `auditor` reciben la llave nueva ADEMÁS de `soat`, así que su
-- comportamiento no cambia—, pero lo que el código NO puede hacer solo es reparar lo que alguien
-- concedió A MANO: un usuario con `soat` en `allowed_pages` perdería el portal.
--
-- Esta es la ÚNICA parte de la migración que toca datos. Conserva EXACTAMENTE lo que hoy puede
-- hacer quien tenga `soat` concedido: no se le quita nada, se le suma la llave nueva.
--
-- `array_append` y no `array_agg(DISTINCT …)`: es lo que zanjó la 0155 y repitió la 0159. El
-- segundo predicado es lo que la hace idempotente de verdad — en la segunda pasada el WHERE no
-- selecciona ninguna fila y el UPDATE reporta `UPDATE 0`, en vez de duplicar el slug.
--
-- El slug literal tiene que coincidir EXACTAMENTE con la clave de PAGES en
-- packages/shared-types/src/permissions.ts. Un error de tecleo aquí no falla: concede en silencio un
-- permiso que no existe y nadie se entera hasta que alguien abre la pantalla y no la ve.
UPDATE users
   SET allowed_pages = array_append(COALESCE(allowed_pages, ARRAY[]::text[]), 'flito_soat')
 WHERE 'soat' = ANY(COALESCE(allowed_pages, ARRAY[]::text[]))
   AND NOT ('flito_soat' = ANY(COALESCE(allowed_pages, ARRAY[]::text[])));

-- ── 10. Permisos ────────────────────────────────────────────────────────────
--
-- El guard existe porque en docker-compose el POSTGRES_USER es `operaciones_app` y en otras
-- instalaciones no: sin él la cadena moriría con `role ... does not exist`.
--
-- Las columnas nuevas de `users`, `clients`, `flito_soat` y `flito_compradores` no necesitan GRANT:
-- en PostgreSQL los privilegios de tabla cubren las columnas nuevas sin re-concederlos.
--
-- Sin DELETE sobre la satélite: una solicitud no se borra, se resuelve. Desaparece únicamente con
-- su SOAT, por el CASCADE. El catálogo de causales sí lo lleva, porque una causal tecleada mal en
-- una pantalla de administración tiene que poder desaparecer antes de que alguien la use.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'operaciones_app') THEN
    GRANT SELECT, INSERT, UPDATE         ON flito_soat_solicitud        TO operaciones_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON flito_soat_causales_rechazo TO operaciones_app;
  END IF;
END $$;
