-- 0150_flito_comparendos_ingesta.sql
-- Feature #11492 (17a) — Monitoreo de comparendos. HU #11496 (esquema, seeds y retención).
-- Autor: equipo FLITO. Motivo: dar persistencia propia al módulo `flito-comparendos` — catálogos,
-- registros consolidados, token cifrado, mapa de homologación y corridas de sync— sin tocar una
-- sola tabla de traspaso, integraciones o PESV.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente.
--
-- Diseño: docs/features/flito-comparendos-ingesta-parametrizacion.md
-- Decisiones: ADR-0001 (módulo y sync), ADR-0002 (token), ADR-0003 (homologación).
--
-- El número: la 0149 la ocupó el corte histórico de Siigo. Este archivo es 0150 por eso y no por
-- otra razón; el diseño lo dice explícito para que nadie lo renumere de vuelta.
--
-- ============================================================================
-- POR QUÉ TABLAS PROPIAS Y NO LAS DE SIMIT QUE YA EXISTEN
-- ============================================================================
--
-- En el repo ya se consulta SIMIT: `integraciones/simit.direct.ts` (FCM directo), el proxy CEA y el
-- gate de traspaso. Ninguno sirve aquí, y no por capricho de dominio:
--
--   · Aquellos responden «¿este VEHÍCULO puede traspasarse hoy?» — una consulta puntual, por placa,
--     cuyo resultado caduca en minutos y no se guarda como histórico.
--   · Este módulo responde «¿qué comparendos tienen HOY las empresas que monitoreo, y desde cuándo?»
--     — un inventario multi-NIT que se compara consigo mismo entre corridas para detectar que algo
--     apareció o desapareció. Sin persistencia propia no hay comparación posible.
--
-- Mezclarlos acoplaría el rate limit y las credenciales de Verifik al pre-vuelo de traspaso, y una
-- caída del monitoreo tumbaría el traspaso. Son dominios distintos que comparten proveedor.

-- ── Enums del dominio (idempotentes) ────────────────────────────────────────
--
-- Locales al módulo. En particular NO se reutiliza el tipo de incidente PESV `comparendo`: allí un
-- comparendo es un evento de la operación propia; aquí es una deuda de un tercero ante el Estado.

DO $$ BEGIN
  CREATE TYPE flito_comparendos_estado AS ENUM ('activo', 'inactivo');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE flito_comparendos_sync_estado AS ENUM ('running', 'completed', 'partial', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE flito_comparendos_evento_tipo AS ENUM ('primera_llegada', 'inactivacion', 'reaparicion');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE flito_comparendos_origen_merge AS ENUM ('simit', 'municipal', 'ambos');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Catálogo: NITs monitoreados (CF-01) ─────────────────────────────────────
--
-- Catálogo propio y no una vista de `clients`: se monitorean NITs de empresas que pueden no ser
-- clientes nuestros —y un cliente puede no monitorearse—. El día que coincidan, coinciden por dato,
-- no por llave foránea.

CREATE TABLE IF NOT EXISTS flito_comparendos_nits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nit VARCHAR(20) NOT NULL,
  alias VARCHAR(120),
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by INTEGER REFERENCES users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_comparendos_nits_nit
  ON flito_comparendos_nits (nit);

-- ── Catálogo: municipios fuente (CF-02) ─────────────────────────────────────
--
-- `codigo_fuente` es el valor literal que viaja en `?fuente=` a UTS; `nombre` es para la pantalla de
-- 17b. Se separan porque el proveedor espera 'ITAGUI' sin tilde y a un humano hay que mostrarle
-- 'Itagüí': si fueran la misma columna, arreglar la ortografía rompería la integración.

CREATE TABLE IF NOT EXISTS flito_comparendos_municipios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo_fuente VARCHAR(40) NOT NULL,
  nombre VARCHAR(80) NOT NULL,
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_comparendos_municipios_fuente
  ON flito_comparendos_municipios (codigo_fuente);

-- ── Catálogo: causales de gestión (CF-04) ───────────────────────────────────
--
-- Se crea en 17a aunque quien las escribe en un comparendo es 17b: el catálogo es parametrización,
-- y dejarlo para después obligaría a una segunda migración sobre `registros` para colgar la FK.

CREATE TABLE IF NOT EXISTS flito_comparendos_causales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre VARCHAR(120) NOT NULL,
  activo BOOLEAN NOT NULL DEFAULT true,
  orden SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_comparendos_causales_nombre
  ON flito_comparendos_causales (nombre);

-- ── Token SIMIT de Verifik, cifrado en reposo (CF-03, ADR-0002) ─────────────
--
-- Mismo esquema que `siigo_credenciales`: AES-256-GCM con AAD, y en la tabla solo cipher, iv,
-- auth_tag, el nonce del AAD y la versión de llave. El texto plano no existe en la base ni en la
-- respuesta de ningún endpoint — el GET devuelve metadatos («¿hay token? ¿quién lo puso y cuándo?»).
--
-- Singleton lógico: una sola fila activa. El índice único PARCIAL lo garantiza en la base y no por
-- convención, porque con dos activas el token usado dependería del orden de las filas. Las
-- desactivadas son el historial de rotación —de ahí sale el «quién/cuándo» que pide el CF-03—.

CREATE TABLE IF NOT EXISTS flito_comparendos_token_simit (
  id SMALLSERIAL PRIMARY KEY,
  token_cipher BYTEA NOT NULL,
  token_iv BYTEA NOT NULL,
  token_auth_tag BYTEA NOT NULL,
  aad_nonce UUID NOT NULL,
  key_version SMALLINT NOT NULL DEFAULT 1,
  activo BOOLEAN NOT NULL DEFAULT true,
  -- Rastro durable del descifrado fallido, igual que en `siigo_credenciales` (0125). Un log se rota
  -- y se pierde; estas dos columnas sobreviven y explican en la propia pantalla por qué el token
  -- dejó de servir —llave rotada, llave de otro ambiente—, que es la avería más probable de una
  -- tabla que guarda un secreto. Van desde ya porque la tabla nace vacía: añadirlas cuando la HU
  -- #11498 las necesite costaría otra migración.
  descifrado_fallido_en TIMESTAMPTZ,
  descifrado_fallido_motivo VARCHAR(200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by INTEGER REFERENCES users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_comparendos_token_activo
  ON flito_comparendos_token_simit (activo)
  WHERE activo;

-- ── Mapa de homologación versionable (ADR-0003) ─────────────────────────────
--
-- Traduce las claves que devuelven Verifik y UTS a las columnas canónicas de `registros`. Es una
-- tabla y no un if/else en el servicio porque el día que el proveedor renombre un campo, la
-- corrección es una fila —con su fecha y su nota— y no un despliegue.
--
-- `version` + `provisional`: la v1 que siembra esta migración se dedujo de `SimitComparendo` y de
-- alias habituales, SIN payloads reales a la vista; por eso nace `provisional=true`. El spike
-- (HU #11501) captura respuestas reales y sube la v2 con `provisional=false`. El merge lee siempre
-- la versión máxima, así que subir versión es el mecanismo de corte, sin migrar datos.
--
-- `prioridad` NO está en el sketch del diseño y se añade a propósito: la tabla del diseño lista
-- varios candidatos por campo («numeroComparendo, comparendo, numero, numeroMulta») en un orden que
-- es información —el primero manda—, y sin una columna que lo guarde ese orden se perdía al
-- insertar. Un payload con dos candidatos presentes habría resuelto según el orden físico de las
-- filas, que es decir «al azar». Menor = gana.

CREATE TABLE IF NOT EXISTS flito_comparendos_field_map (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version INTEGER NOT NULL,
  origen VARCHAR(20) NOT NULL,
  source_path VARCHAR(120) NOT NULL,
  target_field VARCHAR(60) NOT NULL,
  prioridad SMALLINT NOT NULL DEFAULT 0,
  provisional BOOLEAN NOT NULL DEFAULT true,
  notas TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_comparendos_field_map
  ON flito_comparendos_field_map (version, origen, source_path);

-- ── Registros consolidados ──────────────────────────────────────────────────
--
-- Canónico tipado + payload crudo de cada fuente. Las dos cosas, y por motivos distintos:
--
--   · Las columnas canónicas son las que 17b filtra, ordena y exporta. Sacarlas de un JSONB en cada
--     consulta haría el visor lento e impediría los índices de abajo.
--   · Los JSONB son la red: si la homologación v1 resultó equivocada, se sube el mapa a v2 y se
--     re-mergea DESDE `payload_*` sin volver a llamar al proveedor. Sin ellos, un mapa mal deducido
--     sería pérdida de datos irrecuperable.
--
-- Unicidad por `numero_comparendo` y no por (nit, numero) (CF-07): el número lo asigna el Estado y
-- es único en el país. Si el mismo comparendo apareciera bajo dos NITs monitoreados, son la misma
-- deuda vista dos veces, no dos filas.
--
-- La placa NO es llave: un vehículo acumula comparendos, y hacerla única fundiría infracciones
-- distintas en una sola fila.

CREATE TABLE IF NOT EXISTS flito_comparendos_registros (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  numero_comparendo VARCHAR(60) NOT NULL,
  nit_monitoreado VARCHAR(20) NOT NULL,
  -- Campos de FUENTE: los escribe el sync y nadie más. No hay ni habrá endpoint que los edite (CF-09).
  placa VARCHAR(10),
  codigo_infraccion VARCHAR(20),
  descripcion_infraccion TEXT,
  fecha_comparendo DATE,
  organismo VARCHAR(120),
  municipio_fuente VARCHAR(40),
  monto NUMERIC(14, 2),
  estado_fuente VARCHAR(80),
  origen_merge flito_comparendos_origen_merge NOT NULL,
  visto_en_simit BOOLEAN NOT NULL DEFAULT false,
  visto_en_municipal BOOLEAN NOT NULL DEFAULT false,
  payload_simit JSONB,
  payload_municipal JSONB,
  -- Estado de monitoreo: lo mantiene el sync comparando corridas.
  estado flito_comparendos_estado NOT NULL DEFAULT 'activo',
  primera_visto_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultimo_visto_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  inactivado_en TIMESTAMPTZ,
  ultimo_sync_run_id UUID,
  -- Gestión operativa: columnas de 17a, escritura de 17b. Existen desde ya para que el visor no
  -- necesite otra migración sobre una tabla que para entonces ya tendrá volumen.
  causal_id UUID REFERENCES flito_comparendos_causales(id),
  observacion TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_comparendos_numero
  ON flito_comparendos_registros (numero_comparendo);

-- Los tres filtros del visor (17b) y del propio sync, que recorre por NIT en cada corrida.
CREATE INDEX IF NOT EXISTS idx_flito_comparendos_nit
  ON flito_comparendos_registros (nit_monitoreado);
CREATE INDEX IF NOT EXISTS idx_flito_comparendos_placa
  ON flito_comparendos_registros (placa);
CREATE INDEX IF NOT EXISTS idx_flito_comparendos_estado
  ON flito_comparendos_registros (estado);

-- ── Timeline de eventos (CF-11) ─────────────────────────────────────────────
--
-- Append-only por uso: llegada, desaparición y reaparición. Responde «¿desde cuándo arrastramos
-- esto?» y «¿esto ya había desaparecido antes?», que es lo que el estado actual no puede contar.
--
-- El índice único (registro, tipo, run) es el anti-spam del CF-11, y es un candado de base porque
-- la regla «sin eventos redundantes» aplicada solo en el servicio se rompe con el primer reintento
-- de una corrida. Ojo: en PostgreSQL dos NULL son distintos, así que eventos sin `sync_run_id`
-- (altas manuales, backfills) no quedan bloqueados por él.

CREATE TABLE IF NOT EXISTS flito_comparendos_eventos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registro_id UUID NOT NULL REFERENCES flito_comparendos_registros(id) ON DELETE CASCADE,
  tipo flito_comparendos_evento_tipo NOT NULL,
  sync_run_id UUID,
  detalle JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flito_comparendos_eventos_reg
  ON flito_comparendos_eventos (registro_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_comparendos_evento_reg_tipo_run
  ON flito_comparendos_eventos (registro_id, tipo, sync_run_id);

-- ── Corridas de sync y sus pasos ────────────────────────────────────────────
--
-- Una corrida por disparo; un paso por cada par (NIT, fuente). Los pasos no son telemetría: son la
-- condición del CF-10. Solo se inactiva por ausencia cuando ese NIT tuvo SIMIT ok Y todos sus
-- municipios activos ok en la corrida — sin el detalle por paso, un timeout de un municipio se
-- leería como «el comparendo ya no existe» y produciría inactivaciones falsas.

CREATE TABLE IF NOT EXISTS flito_comparendos_sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  estado flito_comparendos_sync_estado NOT NULL DEFAULT 'running',
  scope_nits JSONB NOT NULL,
  resumen JSONB,
  iniciado_por INTEGER REFERENCES users(id),
  iniciado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalizado_en TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS flito_comparendos_sync_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES flito_comparendos_sync_runs(id) ON DELETE CASCADE,
  nit VARCHAR(20) NOT NULL,
  fuente VARCHAR(40) NOT NULL,
  ok BOOLEAN NOT NULL,
  http_status SMALLINT,
  error_code VARCHAR(60),
  mensaje TEXT,
  items_leidos INTEGER,
  duracion_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flito_comparendos_sync_steps_run
  ON flito_comparendos_sync_steps (run_id);

-- ============================================================================
-- SEEDS
-- ============================================================================
--
-- Todos con ON CONFLICT DO NOTHING: la segunda aplicación no falla, y —más importante— no pisa lo
-- que un humano haya cambiado después. Un municipio desactivado a mano sigue desactivado tras
-- re-aplicar; sembrar no es reconfigurar (mismo criterio que la 0149).

-- ── Los 8 municipios del CF-02, activos ─────────────────────────────────────
--
-- `codigo_fuente` va como lo espera UTS: mayúsculas y sin tildes. `nombre` va como se escribe.

INSERT INTO flito_comparendos_municipios (codigo_fuente, nombre, activo) VALUES
  ('BELLO',     'Bello',     true),
  ('ITAGUI',    'Itagüí',    true),
  ('CALI',      'Cali',      true),
  ('ENVIGADO',  'Envigado',  true),
  ('MANIZALES', 'Manizales', true),
  ('MEDELLIN',  'Medellín',  true),
  ('RIONEGRO',  'Rionegro',  true),
  ('SABANETA',  'Sabaneta',  true)
ON CONFLICT (codigo_fuente) DO NOTHING;

-- ── Causales sugeridas por el Feature ───────────────────────────────────────
--
-- Son una sugerencia, no un enum: el CRUD las cambia. Van con `orden` para que 17b las presente en
-- la secuencia natural de la gestión y no alfabéticamente.

INSERT INTO flito_comparendos_causales (nombre, activo, orden) VALUES
  ('Registrado',                  true, 1),
  ('Contactado cliente',          true, 2),
  ('Pago gestionado',             true, 3),
  ('En proceso de validación',    true, 4),
  ('Observación operativa',       true, 5)
ON CONFLICT (nombre) DO NOTHING;

-- ── Mapa de homologación v1, PROVISIONAL ────────────────────────────────────
--
-- Deducido de `SimitComparendo` (`integraciones/simit.direct.ts`, referencia de nombres — NO de
-- transporte) y de alias municipales habituales. `prioridad` conserva el orden de candidatos del
-- diseño: 1 es el nombre que se espera de verdad, los siguientes son respaldos.
--
-- Nace `provisional=true` a propósito. Mientras esta fila diga true, nadie debería dar por buena la
-- homologación: es una hipótesis razonada, no una verificación. La HU #11501 la confirma contra
-- payloads reales y siembra la v2.

INSERT INTO flito_comparendos_field_map (version, origen, source_path, target_field, prioridad, provisional, notas) VALUES
  -- SIMIT (Verifik)
  (1, 'simit', 'numeroComparendo',       'numeroComparendo',       1, true, 'Clave de negocio (CF-07)'),
  (1, 'simit', 'comparendo',             'numeroComparendo',       2, true, NULL),
  (1, 'simit', 'numero',                 'numeroComparendo',       3, true, NULL),
  (1, 'simit', 'numeroMulta',            'numeroComparendo',       4, true, NULL),
  (1, 'simit', 'placa',                  'placa',                  1, true, 'PII: enmascarar en logs'),
  (1, 'simit', 'codigoInfraccion',       'codigoInfraccion',       1, true, NULL),
  (1, 'simit', 'codigo',                 'codigoInfraccion',       2, true, NULL),
  (1, 'simit', 'descripcionInfraccion',  'descripcionInfraccion',  1, true, NULL),
  (1, 'simit', 'fechaComparendo',        'fechaComparendo',        1, true, NULL),
  (1, 'simit', 'fechaImposicion',        'fechaComparendo',        2, true, NULL),
  (1, 'simit', 'secretariaNombre',       'organismo',              1, true, NULL),
  (1, 'simit', 'organismoTransito',      'organismo',              2, true, NULL),
  (1, 'simit', 'valorAPagar',            'monto',                  1, true, NULL),
  (1, 'simit', 'valor',                  'monto',                  2, true, NULL),
  (1, 'simit', 'monto',                  'monto',                  3, true, NULL),
  (1, 'simit', 'estado',                 'estadoFuente',           1, true, 'Texto crudo del proveedor; no se normaliza'),
  (1, 'simit', 'estadoCartera',          'estadoFuente',           2, true, NULL),
  -- Municipal (UTS)
  (1, 'municipal', 'numero',                'numeroComparendo',      1, true, NULL),
  (1, 'municipal', 'numeroComparendo',      'numeroComparendo',      2, true, NULL),
  (1, 'municipal', 'comparendo',            'numeroComparendo',      3, true, NULL),
  (1, 'municipal', 'placa',                 'placa',                 1, true, 'PII: enmascarar en logs'),
  (1, 'municipal', 'codigo',                'codigoInfraccion',      1, true, NULL),
  (1, 'municipal', 'infraccion',            'codigoInfraccion',      2, true, NULL),
  (1, 'municipal', 'descripcion',           'descripcionInfraccion', 1, true, NULL),
  (1, 'municipal', 'descripcionInfraccion', 'descripcionInfraccion', 2, true, NULL),
  (1, 'municipal', 'fecha',                 'fechaComparendo',       1, true, NULL),
  (1, 'municipal', 'fechaComparendo',       'fechaComparendo',       2, true, NULL),
  (1, 'municipal', 'organismo',             'organismo',             1, true, NULL),
  (1, 'municipal', 'secretaria',            'organismo',             2, true, NULL),
  (1, 'municipal', 'valor',                 'monto',                 1, true, NULL),
  (1, 'municipal', 'monto',                 'monto',                 2, true, NULL),
  (1, 'municipal', 'estado',                'estadoFuente',          1, true, NULL)
ON CONFLICT (version, origen, source_path) DO NOTHING;

-- ============================================================================
-- COMENTARIOS DE ESQUEMA
-- ============================================================================
--
-- Van en la base y no solo en el diseño porque quien abra estas tablas con un cliente SQL dentro de
-- un año no va a tener el documento delante, y la confusión que hay que evitar —«¿esto es el SIMIT
-- del traspaso?»— se resuelve justo ahí.

COMMENT ON TABLE flito_comparendos_registros IS
  'Monitoreo operativo de comparendos multi-NIT (Feature #11492, 17a). NO es el gate SIMIT de '
  'traspaso ni el incidente PESV comparendo: aqui se lleva el inventario de deudas de terceros que '
  'se compara entre corridas de sync. Campos de fuente inmutables: solo el sync escribe.';

COMMENT ON COLUMN flito_comparendos_registros.numero_comparendo IS
  'Clave de negocio unica (CF-07). La placa NO es llave: un vehiculo acumula comparendos.';

COMMENT ON COLUMN flito_comparendos_registros.payload_simit IS
  'Respuesta cruda de la fuente. Es la red de la homologacion: permite re-mergear a un field_map '
  'de version mayor sin volver a llamar al proveedor. DATOS PERSONALES DE TERCEROS (Ley 1581): el '
  'proveedor suele devolver nombre y documento del infractor, que el canonico NO mapea. Finalidad: '
  're-homologacion sin re-consultar. Retencion: COMPARENDOS_RETENTION_MONTHS. Prohibido exponerla '
  'cruda por API o log.';

COMMENT ON COLUMN flito_comparendos_registros.payload_municipal IS
  'Respuesta cruda del municipio (UTS). Mismo tratamiento que payload_simit: DATOS PERSONALES DE '
  'TERCEROS (Ley 1581), finalidad re-homologacion, retencion COMPARENDOS_RETENTION_MONTHS, '
  'prohibido exponerla cruda por API o log.';

COMMENT ON COLUMN flito_comparendos_registros.placa IS
  'PII (Ley 1581): identifica indirectamente al propietario. Enmascarar en logs; no ponerla en '
  'querystrings de navegacion.';

COMMENT ON COLUMN flito_comparendos_registros.nit_monitoreado IS
  'PII (Ley 1581) cuando el NIT es de persona natural. Enmascarar en logs.';

COMMENT ON COLUMN flito_comparendos_registros.causal_id IS
  'Gestion operativa: la escribe el Feature 17b. En 17a la columna existe y nadie la toca.';

COMMENT ON TABLE flito_comparendos_token_simit IS
  'Token Verifik SIMIT cifrado AES-256-GCM (ADR-0002). Una sola fila activa (indice unico parcial); '
  'las inactivas son el historial de rotacion. El texto plano no se persiste ni se devuelve por API.';

COMMENT ON TABLE flito_comparendos_field_map IS
  'Homologacion versionable fuente -> canonico (ADR-0003). El merge lee la version MAXIMA. La v1 es '
  'provisional (deducida sin payloads reales); la HU #11501 siembra la v2 verificada.';

COMMENT ON COLUMN flito_comparendos_field_map.prioridad IS
  'Orden entre candidatos del mismo target_field dentro de un mismo origen. Menor gana. Sin esto, '
  'un payload con dos candidatos presentes se resolveria por el orden fisico de las filas.';

COMMENT ON TABLE flito_comparendos_sync_steps IS
  'Un paso por par (NIT, fuente) de cada corrida. Condicion del CF-10: solo se inactiva por ausencia '
  'a los NIT con SIMIT ok y TODOS sus municipios activos ok. Sin esto, un timeout produciria '
  'inactivaciones falsas.';

-- ── Permisos ────────────────────────────────────────────────────────────────
--
-- SELECT, INSERT y UPDATE en catálogos, registros, token y corridas. **Sin DELETE en ninguna**:
--
--   · Un comparendo que desaparece de la fuente se INACTIVA, no se borra — el histórico es el
--     producto (CF-10, CF-11), y la retención la fija COMPARENDOS_RETENTION_MONTHS (24 meses por
--     defecto), no un DELETE suelto de la aplicación.
--
--     **Y esto tiene una consecuencia que hay que dejar dicha, porque estorba a la retención en vez
--     de encajar con ella:** sin DELETE, la purga que exige esa política NO podrá borrar nada bajo
--     `operaciones_app`. La HU que la implemente necesitará su propia migración —GRANT DELETE
--     acotado sobre los dos padres, o una función SECURITY DEFINER—. Basta con los padres:
--     `eventos` y `sync_steps` caen por los ON DELETE CASCADE de arriba, y las acciones de
--     integridad referencial se ejecutan con privilegios del dueño de la tabla.
--   · Los eventos y los pasos de sync son el rastro de lo que pasó; borrarlos es borrar la prueba.
--   · El token se rota desactivando e insertando, para conservar el «quién/cuándo» del CF-03.
--
-- Los eventos y los pasos van sin UPDATE además de sin DELETE: se escriben una vez y describen un
-- hecho pasado. Editar un evento de inactivación es reescribir la historia.
--
-- El guard existe porque en docker-compose el POSTGRES_USER es `operaciones_app` y en otras
-- instalaciones no: sin él la cadena moriría con `role ... does not exist`.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'operaciones_app') THEN
    GRANT SELECT, INSERT, UPDATE ON flito_comparendos_nits         TO operaciones_app;
    GRANT SELECT, INSERT, UPDATE ON flito_comparendos_municipios   TO operaciones_app;
    GRANT SELECT, INSERT, UPDATE ON flito_comparendos_causales     TO operaciones_app;
    GRANT SELECT, INSERT, UPDATE ON flito_comparendos_token_simit  TO operaciones_app;
    GRANT SELECT, INSERT, UPDATE ON flito_comparendos_field_map    TO operaciones_app;
    GRANT SELECT, INSERT, UPDATE ON flito_comparendos_registros    TO operaciones_app;
    GRANT SELECT, INSERT, UPDATE ON flito_comparendos_sync_runs    TO operaciones_app;
    GRANT SELECT, INSERT         ON flito_comparendos_eventos      TO operaciones_app;
    GRANT SELECT, INSERT         ON flito_comparendos_sync_steps   TO operaciones_app;
    -- El SMALLSERIAL del token necesita su secuencia; las demás tablas usan gen_random_uuid().
    GRANT USAGE, SELECT ON SEQUENCE flito_comparendos_token_simit_id_seq TO operaciones_app;
  END IF;
END $$;
