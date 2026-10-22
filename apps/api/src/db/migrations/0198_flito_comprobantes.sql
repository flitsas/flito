-- 0198_flito_comprobantes.sql
-- Epica #12245 — Modulo universal de comprobantes (ADR-0018). F1 (HU #12611): la tabla, sus indices y
--   CHECKs (declarados tambien en db/schema/flito-comprobantes.ts), la pagina
--   `pagina.flito_comprobantes` (grupo Finanzas) y las cinco operaciones del modulo `comprobantes`.
-- Autor: equipo FLITO. Antecedentes: 0193 (tabla + siembra en un archivo), 0192/0197 (calco literal
--   de la siembra pagina/operacion + reparto), 0157 (CHECK en base y en Drizzle), ADR-0005 (FK a
--   users RESTRICT en parejas quien+cuando), ADR-DB-001 (sin control de transaccion propio).
--
-- Reglas de este archivo:
--   - Sin BEGIN/COMMIT: el runner envuelve el archivo. Los bloques DO llevan dollar-quoting etiquetado.
--   - Idempotente: IF NOT EXISTS / ON CONFLICT DO NOTHING; la 2a pasada no toca una fila.
--   - flito_soportes NO se toca: ni FK nueva, ni tramite_id, ni CHECK sobre tipo (no lo tiene).

-- ── Paso 1 — La tabla ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS flito_comprobantes (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lote_id                     UUID NOT NULL,
  soporte_id                  UUID NOT NULL REFERENCES flito_soportes(id) ON DELETE CASCADE,
  soporte_aplicado_id         UUID REFERENCES flito_soportes(id) ON DELETE SET NULL,
  paginas                     JSONB,
  estado                      VARCHAR(20) NOT NULL DEFAULT 'pendiente',
  motivo_pendiente            VARCHAR(40),
  detalle_pendiente           TEXT,
  tipo_documento              VARCHAR(40),
  es_pago                     BOOLEAN,
  concepto                    VARCHAR(30),
  tramite_id                  UUID REFERENCES flito_tramites(id) ON DELETE CASCADE,
  cruce                       VARCHAR(10),
  placa_leida                 VARCHAR(10),
  vin_leido                   VARCHAR(30),
  id_flit_leido               VARCHAR(60),
  extraccion                  JSONB NOT NULL,
  extraccion_destino          JSONB,
  valor                       NUMERIC(14,2),
  fecha_documento             DATE,
  numero_documento            VARCHAR(60),
  emisor                      VARCHAR(150),
  tarifa_referencia           NUMERIC(14,2),
  diferencia_tarifa           NUMERIC(14,2),
  marcado_por_diferencia      BOOLEAN NOT NULL DEFAULT false,
  diferencia_aceptada_por_id  INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  diferencia_aceptada_en      TIMESTAMPTZ,
  diferencia_aceptada_motivo  TEXT,
  aplicado_automaticamente    BOOLEAN NOT NULL DEFAULT false,
  aplicado_por_id             INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  aplicado_en                 TIMESTAMPTZ,
  aplicado_motivo             TEXT,
  descartado_por_id           INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  descartado_en               TIMESTAMPTZ,
  descartado_motivo           TEXT,
  subido_por_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  subido_por_nombre           VARCHAR(150) NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT flito_comprobantes_estado_chk CHECK (estado IN ('pendiente', 'aplicado', 'descartado')),
  CONSTRAINT flito_comprobantes_concepto_chk CHECK (concepto IS NULL OR concepto IN
    ('soat', 'impuesto', 'derecho', 'tramite_digital', 'logistica', 'servicios_adicionales')),
  CONSTRAINT flito_comprobantes_cruce_chk CHECK (cruce IS NULL OR cruce IN ('id_flit', 'vin', 'placa', 'manual')),
  CONSTRAINT flito_comprobantes_aplicado_chk CHECK (estado <> 'aplicado' OR (
    tramite_id IS NOT NULL AND concepto IS NOT NULL AND es_pago IS NOT NULL AND aplicado_en IS NOT NULL
    AND (aplicado_automaticamente OR aplicado_por_id IS NOT NULL))),
  CONSTRAINT flito_comprobantes_valor_pago_chk CHECK (NOT (estado = 'aplicado' AND es_pago = true) OR valor IS NOT NULL),
  CONSTRAINT flito_comprobantes_descartado_chk CHECK (estado <> 'descartado' OR (
    descartado_por_id IS NOT NULL AND descartado_en IS NOT NULL AND descartado_motivo IS NOT NULL)),
  CONSTRAINT flito_comprobantes_pendiente_chk CHECK (estado <> 'pendiente' OR motivo_pendiente IS NOT NULL),
  CONSTRAINT flito_comprobantes_diferencia_chk CHECK (
    (diferencia_aceptada_por_id IS NULL) = (diferencia_aceptada_en IS NULL)
    AND (diferencia_aceptada_por_id IS NULL) = (diferencia_aceptada_motivo IS NULL)),
  CONSTRAINT flito_comprobantes_paginas_chk CHECK (paginas IS NULL OR jsonb_typeof(paginas) = 'array')
);

COMMENT ON TABLE flito_comprobantes IS
  'Epica #12245: un renglon por documento leido por la puerta universal. El archivo vive en flito_soportes (soporte_id); el hecho documental, aqui. Para tramite_digital/logistica/servicios_adicionales la fila aplicada ES el valor (indice unico parcial); para soat/impuesto/derecho `valor` es copia de la columna del destino.';
COMMENT ON COLUMN flito_comprobantes.extraccion IS
  'Lectura universal con confianza por campo. Sin datos de persona (el prompt no los pide). NUNCA se sirve en listados (ADR-0008 s1.2).';

-- ── Paso 2 — Indices ──────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_flito_comprobantes_lote ON flito_comprobantes (lote_id);
CREATE INDEX IF NOT EXISTS idx_flito_comprobantes_pendientes ON flito_comprobantes (created_at)
  WHERE estado = 'pendiente';
CREATE INDEX IF NOT EXISTS idx_flito_comprobantes_tramite ON flito_comprobantes (tramite_id, concepto)
  WHERE tramite_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_flito_comprobantes_soporte ON flito_comprobantes (soporte_id);
-- D2: una verdad documental viva por (tramite, concepto) en los tres honorarios.
CREATE UNIQUE INDEX IF NOT EXISTS idx_flito_comprobantes_valor_documental
  ON flito_comprobantes (tramite_id, concepto)
  WHERE estado = 'aplicado' AND es_pago = true
    AND concepto IN ('tramite_digital', 'logistica', 'servicios_adicionales');

-- ── Paso 3 — La pagina (calco de 0192) ────────────────────────────────────────────────────────────
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('pagina.flito_comprobantes', 'finanzas', 'Finanzas — Comprobantes', 'Entrar a la pantalla «Finanzas — Comprobantes».', 'pagina')
ON CONFLICT (codigo) DO NOTHING;
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'pagina.flito_comprobantes'),
  ('financiera', 'pagina.flito_comprobantes')
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- ── Paso 4 — Las operaciones del modulo `comprobantes` (calco de 0197; una tupla por linea, byte a
--   byte con catalogo-operaciones.ts). Las CINCO de F1 #12605 (F1 solo carga, lee y relee: buscar
--   tramites, aplicar y descartar van en la 0199 de F2 #12606; aceptar diferencia en la 0200 de F3
--   #12607). El reparto de partida es admin + financiera; cualquier otro rol se ajusta desde Roles y
--   permisos.
INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES
  ('comprobantes.lote.cargar',            'comprobantes', 'Cargar comprobantes',                 'Subir documentos (PDF/imagen) para leerlos y asociarlos a un trámite y concepto.', 'operacion'),
  ('comprobantes.cola.ver',               'comprobantes', 'Ver la cola de comprobantes',         'Listar los comprobantes pendientes, aplicados y descartados.', 'operacion'),
  ('comprobantes.comprobante.ver',        'comprobantes', 'Ver un comprobante',                  'Abrir el detalle de un comprobante con lo que el OCR leyó y sus candidatos.', 'operacion'),
  ('comprobantes.archivo.descargar',      'comprobantes', 'Abrir el archivo de un comprobante',  'Ver el documento original del que salió la lectura.', 'operacion'),
  ('comprobantes.comprobante.releer',     'comprobantes', 'Releer un comprobante',               'Volver a pasar por el OCR un comprobante que quedó pendiente de lectura porque el servicio no estuvo disponible.', 'operacion')
ON CONFLICT (codigo) DO NOTHING;
--   Reparto en VALUES explicitos (no CROSS JOIN): es la forma que parsea
--   __tests__/helpers/permisos-seed-sql.ts (MIGRACIONES_CON_REPARTO) para la paridad de la 0179.
INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES
  ('admin', 'comprobantes.lote.cargar'),
  ('admin', 'comprobantes.cola.ver'),
  ('admin', 'comprobantes.comprobante.ver'),
  ('admin', 'comprobantes.archivo.descargar'),
  ('admin', 'comprobantes.comprobante.releer'),
  ('financiera', 'comprobantes.lote.cargar'),
  ('financiera', 'comprobantes.cola.ver'),
  ('financiera', 'comprobantes.comprobante.ver'),
  ('financiera', 'comprobantes.archivo.descargar'),
  ('financiera', 'comprobantes.comprobante.releer')
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;

-- ── Resumen, para el log del CD ──────────────────────────────────────────────────────────────────
DO $resumen0198$
DECLARE n_tabla int; n_idx int; n_chk int; n_pagina int; n_ops int; n_reparto int;
BEGIN
  SELECT count(*) INTO n_tabla FROM information_schema.tables WHERE table_name = 'flito_comprobantes';
  SELECT count(*) INTO n_idx FROM pg_indexes WHERE tablename = 'flito_comprobantes' AND indexname LIKE 'idx_flito_comprobantes_%';
  SELECT count(*) INTO n_chk FROM pg_constraint WHERE conrelid = 'flito_comprobantes'::regclass AND contype = 'c';
  SELECT count(*) INTO n_pagina FROM permisos_funciones WHERE codigo = 'pagina.flito_comprobantes' AND tipo = 'pagina';
  -- Por codigo exacto y NO por modulo/prefijo: la 0199 (F2) sembrara mas `comprobantes.*` y una re-pasada de esta contaria 8 y lanzaria.
  SELECT count(*) INTO n_ops FROM permisos_funciones WHERE tipo = 'operacion' AND codigo IN
    ('comprobantes.lote.cargar', 'comprobantes.cola.ver', 'comprobantes.comprobante.ver', 'comprobantes.archivo.descargar', 'comprobantes.comprobante.releer');
  SELECT count(*) INTO n_reparto FROM permisos_rol_funcion WHERE rol_codigo IN ('admin', 'financiera') AND funcion_codigo IN
    ('pagina.flito_comprobantes', 'comprobantes.lote.cargar', 'comprobantes.cola.ver', 'comprobantes.comprobante.ver', 'comprobantes.archivo.descargar', 'comprobantes.comprobante.releer');
  IF n_tabla <> 1 OR n_idx <> 5 OR n_chk <> 9 OR n_pagina <> 1 OR n_ops <> 5 OR n_reparto <> 12 THEN
    RAISE EXCEPTION '0198: flito_comprobantes inconsistente (tabla=%, idx=%, chk=%, pagina=%, ops=%, reparto=%)', n_tabla, n_idx, n_chk, n_pagina, n_ops, n_reparto;
  END IF;
  RAISE NOTICE '0198: flito_comprobantes lista (% indices, % CHECKs); pagina + 5 operaciones del modulo comprobantes sembradas (% filas de reparto: admin y financiera)', n_idx, n_chk, n_reparto;
END $resumen0198$;
