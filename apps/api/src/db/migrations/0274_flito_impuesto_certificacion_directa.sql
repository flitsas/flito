-- Certificación de impuesto sin trámite: registro propio (la cola exige trámite) y acción de permiso.
-- La operación la absorbe la acción (no se siembra). La acción nace sin otros roles: solo admin, que la reparte.
-- Retención (Ley 1581): datos personales del propietario (documento, nombre), placa, VIN y la factura de venta en el
-- bucket se conservan 10 años desde la creación del registro, igual que la cédula histórica de logística. Hoy NO hay
-- purga automática: la purga y el cifrado en reposo de estos campos quedan como deuda declarada hasta que se defina el
-- mecanismo. El acceso a la lectura se registra en pii-audit.
-- Idempotente. Sin BEGIN/COMMIT: el runner envuelve el archivo.

CREATE TABLE IF NOT EXISTS flito_impuesto_certificacion_directa (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organismo_codigo varchar(5) NOT NULL REFERENCES organismos_transito_config(codigo),
  placa varchar(10) NOT NULL,
  placa_norm varchar(10) NOT NULL,
  documento_propietario varchar(30) NOT NULL,
  nombre_propietario varchar(200) NOT NULL,
  vin varchar(17) NOT NULL,
  vin_norm varchar(17) NOT NULL,
  marca varchar(60) NOT NULL,
  linea varchar(80) NOT NULL,
  anio varchar(4) NOT NULL,
  color varchar(60) NOT NULL,
  cilindrada varchar(20) NOT NULL,
  factura_storage_key text NOT NULL,
  factura_nombre varchar(200) NOT NULL,
  factura_mime varchar(80) NOT NULL,
  factura_bytes integer NOT NULL,
  estado varchar(20) NOT NULL DEFAULT 'radicado',
  comparacion jsonb,
  snapshot jsonb,
  certificado_en timestamptz,
  certificado_por_id integer REFERENCES users(id),
  certificado_por_nombre varchar(200),
  creado_por_id integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_flito_imp_cert_dir_estado CHECK (estado IN ('radicado','sin_respuesta','sin_vehiculo','sin_coincidencia','certificado')),
  CONSTRAINT ck_flito_imp_cert_dir_mime CHECK (factura_mime = 'application/pdf'),
  CONSTRAINT ck_flito_imp_cert_dir_bytes CHECK (factura_bytes > 0 AND factura_bytes <= 15728640),
  CONSTRAINT ck_flito_imp_cert_dir_cert CHECK ((estado = 'certificado') = (certificado_en IS NOT NULL AND snapshot IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_imp_cert_dir_vin
  ON flito_impuesto_certificacion_directa (vin_norm) WHERE estado = 'certificado';
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_imp_cert_dir_placa
  ON flito_impuesto_certificacion_directa (placa_norm) WHERE estado = 'certificado';
CREATE INDEX IF NOT EXISTS idx_flito_imp_cert_dir_creado
  ON flito_impuesto_certificacion_directa (created_at);

INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo, padre_codigo, nivel, orden) VALUES
  ('accion.impuestos.certificar_sin_tramite', 'impuestos', 'Certificar sin trámite', 'Cargar la factura de venta, consultar el RUNT por VIN y descargar el certificado.', 'accion', 'pagina.flito_impuestos', '3', '120')
ON CONFLICT (codigo) DO UPDATE SET modulo = EXCLUDED.modulo, nombre_negocio = EXCLUDED.nombre_negocio,
  descripcion = EXCLUDED.descripcion, tipo = EXCLUDED.tipo, padre_codigo = EXCLUDED.padre_codigo,
  nivel = EXCLUDED.nivel, orden = EXCLUDED.orden
  WHERE (permisos_funciones.modulo, permisos_funciones.nombre_negocio, permisos_funciones.descripcion,
         permisos_funciones.tipo, permisos_funciones.padre_codigo, permisos_funciones.nivel, permisos_funciones.orden)
    IS DISTINCT FROM (EXCLUDED.modulo, EXCLUDED.nombre_negocio, EXCLUDED.descripcion,
         EXCLUDED.tipo, EXCLUDED.padre_codigo, EXCLUDED.nivel, EXCLUDED.orden);

INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)
SELECT v.rol, v.fn FROM (VALUES ('admin', 'accion.impuestos.certificar_sin_tramite')) AS v(rol, fn)
JOIN permisos_roles r ON r.codigo = v.rol
ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;
