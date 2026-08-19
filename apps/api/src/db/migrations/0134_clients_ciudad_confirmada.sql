-- 0134_clients_ciudad_confirmada.sql
-- Feature #11241 — Sincronización de clientes con terceros de Siigo. HU #11294.
-- Autor: equipo FLITO. Motivo: dejar rastro de QUIÉN convirtió la ciudad en texto libre a códigos.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente.
--
-- La conversión de `clients.city` a los códigos de Siigo **no es una actualización masiva**: es
-- propuesta más confirmación humana. Estas columnas son la mitad «confirmación»: sin ellas, dentro
-- de seis meses nadie puede distinguir una ciudad que alguien verificó de una que adivinó un
-- algoritmo de distancia de edición, y la diferencia importa cuando la DIAN pregunte por qué una
-- factura salió con el municipio equivocado.
--
-- **El texto libre original NO se toca** (AC4). `clients.city` se conserva tal cual: es la prueba
-- de qué decía la ficha cuando alguien decidió la equivalencia.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS city_texto_origen  varchar(100);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS city_confirmada_por integer REFERENCES users(id);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS city_confirmada_en  timestamptz;

COMMENT ON COLUMN clients.city_texto_origen IS
  'El texto libre de clients.city con el que se confirmó la equivalencia. Si city cambia después y esto no, la equivalencia quedó obsoleta.';
COMMENT ON COLUMN clients.city_confirmada_por IS
  'Quién confirmó la equivalencia. NULL = los códigos se capturaron a mano, no vienen de una propuesta.';

-- Los tres van juntos o no van: una confirmación sin autor o sin fecha no es trazable, y una fecha
-- sin códigos no significa nada. Se afirma en la base porque estas columnas las va a escribir más
-- de un camino a medida que crezca la Feature.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_ciudad_confirmacion_chk') THEN
    ALTER TABLE clients ADD CONSTRAINT clients_ciudad_confirmacion_chk
      CHECK (
        (city_confirmada_por IS NULL AND city_confirmada_en IS NULL AND city_texto_origen IS NULL)
        OR (city_confirmada_por IS NOT NULL AND city_confirmada_en IS NOT NULL AND city_code IS NOT NULL)
      );
  END IF;
END $$;

-- Los pendientes se buscan por «tiene texto y no tiene código»: es la consulta del informe.
CREATE INDEX IF NOT EXISTS idx_clients_ciudad_pendiente
    ON clients (city) WHERE city_code IS NULL AND city IS NOT NULL;
