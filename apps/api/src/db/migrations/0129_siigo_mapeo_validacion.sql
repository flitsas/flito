-- 0129_siigo_mapeo_validacion.sql
-- Feature #11240 — Facturación electrónica. HU #11283: validar el mapeo en vivo contra Siigo.
-- Autor: equipo FLITO. Motivo: que un producto inexistente o inactivo se descubra al parametrizar
-- y no al emitir, y que la parametrización SEÑALE los conceptos que dejaron de ser válidos (AC7).
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente.
--
-- ─────────────────────── Por qué el resultado de la validación se PERSISTE ───────────────────────
--
-- La validación de guardado (AC1-AC6) es sincrónica y no necesitaría columnas: se rechaza y ya. Lo
-- que sí las necesita es el AC7, la revalidación de lo ya configurado: «esos conceptos quedan
-- señalados en la parametrización». Señalados significa que la pantalla los distingue al abrirla,
-- no que alguien tenga que volver a lanzar la revalidación para enterarse.
--
-- Y hay una segunda razón, más importante: un producto que hoy es válido puede dejar de serlo
-- mañana sin que nadie toque FLITO. Alguien inactiva el producto en Siigo Nube y la parametrización
-- sigue diciendo «listo para facturar» hasta que la primera factura se cae. El estado de validación
-- es, por tanto, un dato con fecha —`validado_en`—, no una propiedad permanente de la fila.
--
-- `validacion_estado` NO se mezcla con `confirmado_contabilidad`. Son dos afirmaciones distintas y
-- de dos responsables distintos: contabilidad firma que el tratamiento tributario es el correcto;
-- la validación comprueba que el producto existe en Siigo. Un producto puede existir y estar mal
-- clasificado, y una clasificación correcta puede apuntar a un producto borrado. Colapsarlas en un
-- solo indicador haría que resincronizar tumbara firmas contables, que es justo lo que el AC4 de la
-- HU #11282 se esfuerza en acotar a cuatro campos concretos.

ALTER TABLE siigo_mapeo_conceptos
  ADD COLUMN IF NOT EXISTS validacion_estado  varchar(20) NOT NULL DEFAULT 'sin_validar',
  ADD COLUMN IF NOT EXISTS validacion_mensaje varchar(300),
  ADD COLUMN IF NOT EXISTS validado_en        timestamptz;

-- Los estados posibles. `sin_validar` es el de las filas que ya existían cuando llegó esta HU y el
-- de las que no tienen código de producto: no es un fallo, es que no hay nada que verificar.
--
-- Se añade con NOT VALID + VALIDATE en dos pasos para no bloquear la tabla mientras se revisan las
-- filas existentes. Con el DEFAULT de arriba todas cumplen, pero la migración no debe apoyarse en
-- que la tabla sea pequeña hoy.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'siigo_mapeo_validacion_estado_chk'
  ) THEN
    ALTER TABLE siigo_mapeo_conceptos
      ADD CONSTRAINT siigo_mapeo_validacion_estado_chk
      CHECK (validacion_estado IN ('sin_validar', 'valido', 'no_existe', 'inactivo', 'no_verificable'))
      NOT VALID;
    ALTER TABLE siigo_mapeo_conceptos VALIDATE CONSTRAINT siigo_mapeo_validacion_estado_chk;
  END IF;
END $$;

-- Un estado distinto de `sin_validar` afirma que ALGUIEN LO INTENTÓ, y eso tiene fecha. Sin esta
-- restricción, un UPDATE directo podría dejar `valido` sin decir cuándo se comprobó, y una
-- validación sin fecha no sirve para nada: lo que se quiere saber es si sigue vigente.
--
-- `validado_en` es la fecha del último INTENTO, no la de la última comprobación con respuesta. La
-- diferencia importa en `no_verificable`: ahí Siigo no contestó, así que no hubo verificación, pero
-- sí hubo un intento y su fecha es justo lo que responde «¿cuándo se miró esto por última vez?».
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'siigo_mapeo_validacion_fechada'
  ) THEN
    ALTER TABLE siigo_mapeo_conceptos
      ADD CONSTRAINT siigo_mapeo_validacion_fechada
      CHECK (validacion_estado = 'sin_validar' OR validado_en IS NOT NULL)
      NOT VALID;
    ALTER TABLE siigo_mapeo_conceptos VALIDATE CONSTRAINT siigo_mapeo_validacion_fechada;
  END IF;
END $$;

-- La lectura de la pantalla tras una revalidación: «qué conceptos de este ambiente tienen novedad».
-- Parcial porque las filas en `valido` y `sin_validar` son la inmensa mayoría y no se consultan por
-- este camino: lo que se busca son las excepciones.
CREATE INDEX IF NOT EXISTS idx_siigo_mapeo_validacion_novedad
  ON siigo_mapeo_conceptos (ambiente, validacion_estado)
  WHERE validacion_estado IN ('no_existe', 'inactivo', 'no_verificable');

COMMENT ON COLUMN siigo_mapeo_conceptos.validacion_estado IS
  'Resultado de la última comprobación del código de producto contra Siigo (HU #11283). '
  'sin_validar = nunca se comprobó o no hay código que comprobar. no_verificable = Siigo no '
  'respondió, el dato puede estar bien.';
COMMENT ON COLUMN siigo_mapeo_conceptos.validacion_mensaje IS
  'Texto accionable de la última validación. Nunca el mensaje crudo de Siigo ni una sentencia SQL.';
COMMENT ON COLUMN siigo_mapeo_conceptos.validado_en IS
  'Momento del último INTENTO de comprobación, no necesariamente de una respuesta de Siigo: con '
  'validacion_estado = no_verificable hubo intento y no hubo respuesta. Un estado sin fecha no '
  'dice si sigue vigente.';
