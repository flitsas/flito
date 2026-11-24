-- HU #13889 (Feature #13888, Épica #13407) — ADR-0028 §7.2. Expediente documental de la COMPAÑÍA (bolsas).
-- Escrita a mano e idempotente. NO drizzle-kit (AGENTS.md regla 6).
--
-- 1. La tabla nace COMPLETA, incluidas las columnas del OCR (#13890) y de la purga (#13891), para no
--    tener que editar esta migración después de aplicada (D11). Espejo: `src/db/schema/flito-bolsas-documentos.ts`.
-- 2. Catálogo de permisos (ADR-0025): las dos ACCIONES concedibles bajo la página de bolsas. Las operaciones
--    `bolsas.documentos.ver` / `.cargar` que piden las rutas NO se siembran: nacen absorbidas por su acción
--    (`catalogoCompleto()` las excluye) y sembrarlas haría fallar `verificarCatalogoAlArrancar` («la base
--    declara y el código no usa»). Las filas son la salida literal de
--    `npm run permisos:seed -w apps/api -- --arbol finanzas`.
-- 3. Reparto: a ningún rol de negocio (ADR-0028 §1); se conceden a mano desde la pantalla de permisos. La
--    ÚNICA marca es a `admin`, por la invariante del repo «toda siembra se le marca a `admin`» (HU #13424,
--    ADR-0022) y «`admin` recibe TODAS las acciones» (HU #12873 AC8, PO 2026-10-13), que vigila
--    `permisos-siembra-admin.test.ts`. Sin ella el reparto de la base divergiría del que calcula el código.

CREATE TABLE IF NOT EXISTS flito_bolsas_documentos (
  id uuid PRIMARY KEY,
  compania_id integer NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  tipo varchar(30) NOT NULL,
  version smallint NOT NULL,
  vigente boolean NOT NULL,
  storage_key text,
  mime varchar(30) NOT NULL,
  tamano_bytes integer NOT NULL,
  cifrado_iv bytea NOT NULL,
  cifrado_tag bytea NOT NULL,
  cifrado_key_version smallint NOT NULL,
  aad_nonce uuid NOT NULL,
  fecha_expedicion date,
  fecha_origen varchar(10),
  fecha_manual_por integer REFERENCES users(id) ON DELETE SET NULL,
  fecha_manual_en timestamptz,
  ocr_estado varchar(12) NOT NULL,
  ocr_intentos smallint NOT NULL DEFAULT 0,
  ocr_actualizado_en timestamptz NOT NULL DEFAULT now(),
  cargado_por integer REFERENCES users(id) ON DELETE SET NULL,
  cargado_en timestamptz NOT NULL DEFAULT now(),
  reemplazado_en timestamptz,
  purgado_en timestamptz,
  CONSTRAINT ck_flito_bolsas_documentos_tipo CHECK (tipo IN ('camara_comercio','rut','cedula_representante','certificado_bancario','adicional')),
  CONSTRAINT ck_flito_bolsas_documentos_mime CHECK (mime IN ('application/pdf','image/jpeg','image/png')),
  CONSTRAINT ck_flito_bolsas_documentos_tamano CHECK (tamano_bytes > 0 AND tamano_bytes <= 15728640),
  CONSTRAINT ck_flito_bolsas_documentos_version CHECK (version >= 1),
  CONSTRAINT ck_flito_bolsas_documentos_origen CHECK ((fecha_origen IS NULL) = (fecha_expedicion IS NULL) AND (fecha_origen IS NULL OR fecha_origen IN ('ocr','manual'))),
  CONSTRAINT ck_flito_bolsas_documentos_manual CHECK ((fecha_origen = 'manual') = (fecha_manual_en IS NOT NULL)),
  CONSTRAINT ck_flito_bolsas_documentos_ocr CHECK (ocr_estado IN ('no_aplica','validando','leido','sin_fecha','fallido')),
  CONSTRAINT ck_flito_bolsas_documentos_ocr_tipo CHECK ((tipo IN ('cedula_representante','adicional')) = (ocr_estado = 'no_aplica')),
  CONSTRAINT ck_flito_bolsas_documentos_vigencia CHECK (vigente = (reemplazado_en IS NULL)),
  CONSTRAINT ck_flito_bolsas_documentos_purga CHECK ((purgado_en IS NULL) = (storage_key IS NOT NULL) AND (purgado_en IS NULL OR NOT vigente))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_bolsas_documentos_vigente ON flito_bolsas_documentos (compania_id, tipo) WHERE vigente;
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_bolsas_documentos_version ON flito_bolsas_documentos (compania_id, tipo, version);
CREATE INDEX IF NOT EXISTS idx_flito_bolsas_documentos_purga ON flito_bolsas_documentos (reemplazado_en) WHERE NOT vigente AND purgado_en IS NULL;
CREATE INDEX IF NOT EXISTS idx_flito_bolsas_documentos_ocr ON flito_bolsas_documentos (ocr_actualizado_en) WHERE ocr_estado = 'validando';

-- Acciones (nivel 3) bajo el ítem «Bolsas». Generado por `npm run permisos:seed -w apps/api -- --arbol finanzas`.
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, padre_codigo, nivel, orden) VALUES
  ('accion.bolsas.cargar_documentos', 'bolsas', 'Cargar documentos del expediente', 'Subir o reemplazar documentos de la compañía y fijar su fecha de expedición.', 'accion', 'pagina.flito_bolsas', '3', '100'),
  ('accion.bolsas.ver_documentos', 'bolsas', 'Ver el expediente documental', 'Consultar y descargar los documentos de vinculación de la compañía.', 'accion', 'pagina.flito_bolsas', '3', '90')
ON CONFLICT (codigo) DO UPDATE SET modulo = EXCLUDED.modulo, nombre_negocio = EXCLUDED.nombre_negocio,
  descripcion = EXCLUDED.descripcion, tipo = EXCLUDED.tipo, padre_codigo = EXCLUDED.padre_codigo,
  nivel = EXCLUDED.nivel, orden = EXCLUDED.orden
  WHERE (permisos_funciones.modulo, permisos_funciones.nombre_negocio, permisos_funciones.descripcion,
         permisos_funciones.tipo, permisos_funciones.padre_codigo, permisos_funciones.nivel, permisos_funciones.orden)
    IS DISTINCT FROM (EXCLUDED.modulo, EXCLUDED.nombre_negocio, EXCLUDED.descripcion,
         EXCLUDED.tipo, EXCLUDED.padre_codigo, EXCLUDED.nivel, EXCLUDED.orden);

-- `admin` recibe las dos acciones (HU #13424: toda siembra se le marca a `admin`). Ningún otro rol.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT v.rol, v.fn FROM (VALUES ('admin', 'accion.bolsas.cargar_documentos'), ('admin', 'accion.bolsas.ver_documentos')) AS v(rol, fn)
JOIN permisos_roles r ON r.codigo = v.rol
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;
