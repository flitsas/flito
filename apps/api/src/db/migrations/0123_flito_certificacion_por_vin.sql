-- HU #11165 (ajuste) — la certificación contra el RUNT puede identificar el vehículo por VIN.
--
-- El RUNT admite dos formas de consulta: placa + documento del propietario, o VIN. La tabla se
-- diseñó asumiendo solo la primera y dejó `documento_consultado` obligatorio. Cuando FLITO no
-- conoce el documento del titular, la consulta va por VIN y no hay documento que registrar:
-- guardar ahí la placa o el propio VIN convertiría la evidencia en una mentira, así que la columna
-- pasa a admitir NULL y se añade `vin_consultado` al lado.
--
-- Exactamente uno de los dos queda siempre poblado: es lo que hace auditable el certificado, porque
-- dice con qué identificador se le preguntó al RUNT. Las certificaciones anteriores a este cambio
-- son todas por documento y cumplen la restricción sin tocarlas.

ALTER TABLE flito_impuesto_certificaciones
  ALTER COLUMN documento_consultado DROP NOT NULL;

ALTER TABLE flito_impuesto_certificaciones
  ADD COLUMN IF NOT EXISTS vin_consultado varchar(17);

ALTER TABLE flito_impuesto_certificaciones
  ADD CONSTRAINT flito_imp_cert_identificador_presente
  CHECK (documento_consultado IS NOT NULL OR vin_consultado IS NOT NULL);
