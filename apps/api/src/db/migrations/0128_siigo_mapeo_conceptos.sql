-- 0128_siigo_mapeo_conceptos.sql
-- Feature #11240 — Facturación electrónica. HU #11282: mapeo de conceptos a productos de Siigo.
-- Autor: equipo FLITO. Motivo: que la factura se arme leyendo configuración y no reglas escritas
-- en el código.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente.
--
-- ───────────────────────────── Por qué la llave lleva `ambiente` ─────────────────────────────
--
-- DECISIÓN: sí, `ambiente` forma parte de la identidad de la fila y entra en el índice único.
--
-- Lo que se guarda aquí no es doctrina tributaria abstracta: son IDENTIFICADORES DE UNA EMPRESA DE
-- SIIGO. El `codigo_producto` es el `code` de `POST /v1/products`, único dentro de la empresa; cada
-- `impuestos[].id` sale de `GET /v1/taxes` de esa misma empresa; la unidad de medida se valida
-- contra su catálogo. La propia documentación de la integración lo dice sin rodeos
-- (docs/integraciones/siigo-api.md, «Notas para la integración», punto 6): «los ids no son
-- constantes entre empresas». Pruebas y producción SON empresas distintas en Siigo.
--
-- Sin `ambiente` en la llave pasarían tres cosas, todas malas y ninguna ruidosa:
--   1. Configurar el mapeo contra la empresa de pruebas dejaría escrito un `codigo_producto` que en
--      producción o no existe (la factura se rechaza) o existe y es OTRO producto (se factura mal,
--      y eso ya es un documento ante la DIAN).
--   2. La confirmación de contabilidad se heredaría entre ambientes. La HU #11285 (compuerta) exige
--      justo lo contrario: al cambiar de ambiente no se heredan confirmaciones de otro ambiente.
--      Con una sola fila por concepto ese AC no se puede cumplir, ni siquiera con código encima.
--   3. Sería la misma trampa que la HU #11281 ya pagó en los catálogos, donde una sincronización de
--      un ambiente pisaba la del otro. Repetirla a sabiendas en la tabla que decide qué se factura
--      sería el peor sitio para repetirla.
--
-- Se consideró y se descartó partir la tabla en dos (tratamiento tributario sin ambiente + código
-- de producto por ambiente): la clasificación tributaria es, en efecto, un hecho de la ley y no de
-- la empresa, pero el AC4 ata la confirmación al conjunto —clasificación, impuestos, ingreso para
-- terceros Y código de producto— y esa confirmación no se puede revertir de forma atómica si vive
-- repartida entre dos tablas. Una fila por (ambiente, concepto, tipo_trámite) mantiene el AC4 en un
-- solo UPDATE. El costo es duplicar la clasificación en dos filas; es un costo aceptable y visible.
--
-- Alineado, además, con `siigo_credenciales` (0125) y con `siigo_operaciones` (0126), que ya tratan
-- el ambiente como parte de la identidad y no como una variable de entorno.
--
-- ───────────────────────────── Lo que esta migración NO modela ───────────────────────────────
--
-- RETENCIONES (AC7): no hay columnas de ReteICA, ReteIVA ni autorretención porque NO está
-- confirmado por contabilidad si aplican a las facturas de FLIT. Modelarlas «por si acaso» sería
-- inventar la respuesta. Incorporarlas el día que se confirme es AÑADIR COLUMNAS a esta tabla
-- (p. ej. `retenciones jsonb`, con los ids de `GET /v1/taxes` igual que `impuestos`) y leerlas en
-- el armado: no exige rehacer el modelo, ni la llave, ni el flujo de confirmación.

CREATE TABLE IF NOT EXISTS siigo_mapeo_conceptos (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ambiente                  varchar(12) NOT NULL,
  concepto                  varchar(30) NOT NULL,
  -- NULL = configuración GENÉRICA del concepto. Una fila con tipo de trámite tiene precedencia
  -- sobre ella (AC5). Se guarda normalizado (mayúsculas, sin espacios sobrantes) porque en
  -- `flito_tramites.tipo_tramite` es texto libre de FLIT: misma convención que
  -- `flito_tarifas_compania` (0110).
  tipo_tramite              varchar(60),

  -- ── Qué es el concepto en Siigo (AC2) ──
  -- `code` de POST /v1/products: alfanumérico, sin espacios, ≤30. NULL = todavía sin mapear (AC1).
  codigo_producto           varchar(30),
  -- Nombre del producto en Siigo. Descriptivo: sirve para que la pantalla no muestre solo un código
  -- y para detectar a ojo un mapeo pegado del ambiente equivocado. Lo que viaja en la factura es el
  -- código, nunca este texto.
  nombre_producto           varchar(200),
  -- gravado | exento | excluido (tax_classification: Taxed | Exempt | Excluded).
  -- NULL a propósito = SIN DECLARAR. No se pone un valor por defecto porque cualquiera de los tres
  -- sería una afirmación tributaria que nadie ha hecho todavía.
  clasificacion_tributaria  varchar(12),
  -- Impuestos aplicables: [{ "id": 13156, "nombre": "IVA 19%", "porcentaje": 19 }]. Los ids son de
  -- GET /v1/taxes de ESTA empresa de Siigo (de ahí el `ambiente` en la llave).
  impuestos                 jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Código de unidad de medida para factura electrónica (`unit`). Siigo usa '94' = unidad, pero se
  -- deja NULL hasta que alguien lo declare: rellenarlo en silencio es decidir por contabilidad.
  unidad_medida             varchar(20),
  -- Ingreso recibido para terceros: el SOAT, el impuesto y el derecho de tránsito son dinero que
  -- FLIT recauda y traslada, no ingreso propio. Se declara como dato porque el tratamiento contable
  -- de la línea cambia por completo.
  ingreso_para_terceros     boolean NOT NULL DEFAULT false,

  -- ── AC6: GMF como línea propia, PENDIENTE DE CONFIRMACIÓN CONTABLE ──
  -- No está confirmado si el gravamen a los movimientos financieros se factura como una línea
  -- propia o se absorbe dentro de otro concepto. La semilla deja el indicador APAGADO para GMF y
  -- marca la decisión como pendiente; cambiarla es editar configuración, no desplegar código.
  -- Quien arme la factura debe mirar `linea_propia_pendiente` antes de actuar: un `false` con
  -- pendiente=true significa «sin decidir», NO «se absorbe».
  factura_linea_propia      boolean NOT NULL DEFAULT false,
  linea_propia_pendiente    boolean NOT NULL DEFAULT false,

  -- ── AC4: confirmación de contabilidad, frágil a propósito ──
  confirmado_contabilidad   boolean NOT NULL DEFAULT false,
  -- Quién y cuándo confirmó. NO se limpian al revertir: el AC pide que quede registrado quién
  -- confirmó y cuándo, incluso —sobre todo— después de que un cambio tumbara esa confirmación.
  confirmado_por_id         integer REFERENCES users(id),
  confirmado_en             timestamptz,
  -- Cuándo se cayó la confirmación y QUÉ campo la tumbó. Guarda NOMBRES DE CAMPO, nunca valores:
  -- la trazabilidad de los valores es de `audit_logs`, y duplicarlos aquí solo multiplica sitios
  -- donde revisar qué se está guardando.
  confirmacion_revertida_en timestamptz,
  confirmacion_revertida_por varchar(300),

  activo                    boolean NOT NULL DEFAULT true,
  notas                     text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                integer REFERENCES users(id),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                integer REFERENCES users(id),

  CONSTRAINT siigo_mapeo_ambiente_chk CHECK (ambiente IN ('pruebas', 'produccion')),
  CONSTRAINT siigo_mapeo_clasificacion_chk
    CHECK (clasificacion_tributaria IS NULL
           OR clasificacion_tributaria IN ('gravado', 'exento', 'excluido')),
  CONSTRAINT siigo_mapeo_impuestos_es_arreglo CHECK (jsonb_typeof(impuestos) = 'array'),
  -- Confirmar exige dejar rastro. Sin esto, un UPDATE directo en la base podría marcar
  -- `confirmado_contabilidad` sin decir quién ni cuándo, que es exactamente lo que el AC4 impide.
  CONSTRAINT siigo_mapeo_confirmacion_trazada
    CHECK (NOT confirmado_contabilidad
           OR (confirmado_por_id IS NOT NULL AND confirmado_en IS NOT NULL))
);

-- AC5 — Una sola fila VIVA por ambiente + concepto + tipo de trámite. El COALESCE es imprescindible:
-- en un índice único normal NULL no colisiona con NULL, y se podrían crear varias configuraciones
-- genéricas del mismo concepto compitiendo entre sí. Parcial sobre `activo` por la misma razón que
-- en `siigo_credenciales`: las desactivadas son historial y pueden repetirse.
CREATE UNIQUE INDEX IF NOT EXISTS idx_siigo_mapeo_unico_activo
  ON siigo_mapeo_conceptos (ambiente, concepto, COALESCE(tipo_tramite, ''))
  WHERE activo;

-- Resolver el mapeo de una línea es siempre «este ambiente, este concepto».
CREATE INDEX IF NOT EXISTS idx_siigo_mapeo_ambiente_concepto
  ON siigo_mapeo_conceptos (ambiente, concepto);

COMMENT ON TABLE siigo_mapeo_conceptos IS
  'Mapeo de conceptos facturables a productos de Siigo, por ambiente (HU #11282). El tratamiento '
  'tributario de la factura se lee de aquí; no hay condiciones por concepto en el código de armado.';
COMMENT ON COLUMN siigo_mapeo_conceptos.ambiente IS
  'Empresa de Siigo a la que pertenecen el código de producto y los ids de impuesto. Pruebas y '
  'producción son empresas distintas: sus ids no son intercambiables.';
COMMENT ON COLUMN siigo_mapeo_conceptos.tipo_tramite IS
  'NULL = configuración genérica del concepto. Una fila con tipo de trámite tiene precedencia.';
COMMENT ON COLUMN siigo_mapeo_conceptos.clasificacion_tributaria IS
  'NULL = sin declarar por contabilidad. No es lo mismo que excluido.';
COMMENT ON COLUMN siigo_mapeo_conceptos.linea_propia_pendiente IS
  'true = la decisión de facturar como línea propia NO está confirmada por contabilidad (AC6). '
  'Con este indicador en true, factura_linea_propia=false significa «sin decidir», no «se absorbe».';
COMMENT ON COLUMN siigo_mapeo_conceptos.confirmacion_revertida_por IS
  'Nombres de los campos cuyo cambio tumbó la última confirmación. Nunca valores.';

-- ───────────────────────────── AC1 — Semilla de los seis conceptos ────────────────────────────
--
-- Los seis salen uno a uno de las columnas de valor de `flito_liquidaciones`: valor_soat,
-- valor_impuesto, valor_derecho, valor_tramite_digital, valor_logistica y valor_gmf. Todos nacen
-- SIN código de producto y SIN confirmación de contabilidad — la fila existe para que la pantalla
-- muestre el trabajo pendiente, no para fingir que ya está hecho.
--
-- Se siembran los DOS ambientes: un ambiente recién migrado tiene que poder configurarse sin que
-- nadie recuerde insertar filas a mano, y la copia de producción no puede depender de que alguien
-- «promueva» lo de pruebas.
--
-- `ingreso_para_terceros` NO se presiembra en true para SOAT, impuesto ni derecho, aunque sea lo
-- previsible: el AC4 hace que ese campo tumbe la confirmación, y una semilla con criterio propio
-- sería una afirmación contable que nadie firmó. Lo declara quien configura.
--
-- ON CONFLICT DO NOTHING sobre el índice único parcial: reejecutar la migración no duplica filas ni
-- pisa una configuración ya hecha.
INSERT INTO siigo_mapeo_conceptos (ambiente, concepto, factura_linea_propia, linea_propia_pendiente, notas)
SELECT a.ambiente, c.concepto, c.linea_propia, c.pendiente, c.notas
FROM (VALUES ('pruebas'), ('produccion')) AS a(ambiente)
CROSS JOIN (VALUES
  ('soat',               true,  false, NULL),
  ('impuesto_vehicular', true,  false, NULL),
  ('derecho_transito',   true,  false, NULL),
  ('tramite_digital',    true,  false, NULL),
  ('logistica',          true,  false, NULL),
  -- AC6: el único con la decisión abierta. Apagado y marcado como pendiente.
  ('gmf',                false, true,
   'Pendiente de confirmación contable: no está definido si el GMF se factura como línea propia o '
   'se absorbe dentro de otro concepto. El indicador apagado NO significa que se absorba.')
) AS c(concepto, linea_propia, pendiente, notas)
ON CONFLICT DO NOTHING;
