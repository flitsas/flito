-- HU #11161/#11210 (ajuste de modelo) — la bolsa de tránsito deja de ser una por secretaría.
--
-- El modelo original ató una bolsa a UNA secretaría (UNIQUE sobre organismo_codigo) y a UN concepto
-- implícito, el derecho de trámite. La realidad del negocio es otra: FLIT transfiere dinero a una
-- bolsa que puede cubrir VARIAS secretarías y VARIOS conceptos —«Bolsa de mi sector» con Medellín,
-- Envigado y Sabaneta, cobrando solo impuestos—, y quien la gasta es un tercero que gestiona pagos.
--
-- La regla que hace esto operable es que el par (secretaría, concepto) pertenezca como mucho a UNA
-- bolsa. Va como índice único y no como validación de servicio: es lo que permite que al sellar una
-- liquidación el sistema sepa a qué bolsa descontar sin preguntarle a nadie. Sin esa garantía en la
-- base, dos bolsas solapadas dejarían el destino del dinero a merced del orden de las filas.
--
-- La migración NO destruye: renombra y convierte. Una bolsa preexistente se vuelve una bolsa de una
-- sola secretaría que cubre 'derecho', que es exactamente lo que era.

ALTER TABLE flito_organismo_bolsas RENAME TO flito_bolsas_transito;
ALTER TABLE flito_bolsas_transito RENAME CONSTRAINT flito_org_bolsa_ultima_carga_coherente TO flito_bolsa_transito_ultima_carga_coherente;

ALTER TABLE flito_bolsas_transito ADD COLUMN IF NOT EXISTS nombre varchar(120);

CREATE TABLE IF NOT EXISTS flito_bolsa_transito_cobertura (
  bolsa_id          uuid        NOT NULL REFERENCES flito_bolsas_transito(id) ON DELETE CASCADE,
  organismo_codigo  varchar(5)  NOT NULL REFERENCES organismos_transito_config(codigo) ON DELETE RESTRICT,
  concepto          varchar(20) NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bolsa_id, organismo_codigo, concepto),
  CONSTRAINT flito_bolsa_transito_concepto_valido
    CHECK (concepto IN ('derecho', 'soat', 'impuesto'))
);

-- La regla de oro: un (secretaría, concepto) no puede estar en dos bolsas.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bolsa_transito_cobertura
  ON flito_bolsa_transito_cobertura (organismo_codigo, concepto);

CREATE INDEX IF NOT EXISTS idx_bolsa_transito_cobertura_bolsa
  ON flito_bolsa_transito_cobertura (bolsa_id);

-- Conversión de lo que hubiera: cada bolsa 1:1 se vuelve una bolsa de una secretaría sobre 'derecho'.
UPDATE flito_bolsas_transito b
   SET nombre = coalesce(o.alias, 'Bolsa ' || b.organismo_codigo)
  FROM organismos_transito_config o
 WHERE o.codigo = b.organismo_codigo
   AND b.nombre IS NULL;

INSERT INTO flito_bolsa_transito_cobertura (bolsa_id, organismo_codigo, concepto)
SELECT id, organismo_codigo, 'derecho' FROM flito_bolsas_transito
ON CONFLICT DO NOTHING;

ALTER TABLE flito_bolsas_transito ALTER COLUMN nombre SET NOT NULL;
ALTER TABLE flito_bolsas_transito ADD CONSTRAINT flito_bolsas_transito_nombre_key UNIQUE (nombre);
ALTER TABLE flito_bolsas_transito DROP COLUMN organismo_codigo;

-- El libro pasa a colgar de la BOLSA. La secretaría y el concepto siguen en cada asiento —son el
-- desglose del extracto— pero dejan de identificar la bolsa, y una carga no tiene ninguno de los
-- dos: el dinero entra a la bolsa entera, no a una secretaría.
ALTER TABLE flito_organismo_movimientos RENAME TO flito_bolsa_transito_movimientos;
ALTER TABLE flito_bolsa_transito_movimientos ALTER COLUMN organismo_codigo DROP NOT NULL;
ALTER TABLE flito_bolsa_transito_movimientos ADD COLUMN IF NOT EXISTS concepto varchar(20);

ALTER TABLE flito_bolsa_transito_movimientos
  DROP CONSTRAINT IF EXISTS flito_org_mov_carga_coherente;
-- Una carga no lleva trámite, ni secretaría, ni concepto; una salida automática los lleva los tres.
ALTER TABLE flito_bolsa_transito_movimientos
  ADD CONSTRAINT flito_bolsa_transito_mov_carga_coherente
  CHECK (
    (origen <> 'carga' OR (tipo = 'entrada' AND tramite_id IS NULL AND concepto IS NULL))
  );

-- Las salidas preexistentes son todas del derecho de trámite: se etiquetan como tales.
UPDATE flito_bolsa_transito_movimientos
   SET concepto = 'derecho'
 WHERE concepto IS NULL AND origen = 'automatico';

-- El interruptor por organismo (`flito_lleva_bolsa`) queda sin lectores con este cambio: cualquier
-- secretaría puede entrar en una bolsa y la cobertura es quien lo decide. La columna se deja en la
-- base a propósito —mismo criterio que con flito_reglas_proveedor_soat— y su DROP irá aparte.
