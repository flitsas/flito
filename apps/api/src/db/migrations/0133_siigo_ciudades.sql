-- 0133_siigo_ciudades.sql
-- Feature #11241 — Sincronización de clientes con terceros de Siigo. HU #11293.
-- Autor: equipo FLITO. Motivo: Siigo exige códigos de país, departamento y ciudad, y la ciudad en
-- texto libre de `clients.city` no es convertible a código de forma confiable.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente.
--
-- **Por qué esta tabla existe aparte de `siigo_catalogos`.** Los seis catálogos de la HU #11281 se
-- sincronizan llamando a la API. Este no: Siigo publica las ciudades como un archivo .xlsx, no como
-- un servicio. Meterlo en `siigo_catalogos` obligaría a mentir sobre su origen —diría
-- «sincronizado» cuando nadie llamó a Siigo— y a compartir con él la fecha de sincronización y el
-- ambiente, que aquí no significan nada: el listado de ciudades es el mismo en pruebas y en
-- producción porque no depende de la cuenta.
--
-- La carga la hace `siigo.ciudades.service.ts` desde `src/db/data/siigo-ciudades.json`.

CREATE TABLE IF NOT EXISTS siigo_ciudades (
  id             bigserial PRIMARY KEY,
  country_code   varchar(2)  NOT NULL,
  country_name   varchar(80) NOT NULL,
  state_code     varchar(5)  NOT NULL,
  state_name     varchar(80) NOT NULL,
  city_code      varchar(10) NOT NULL,
  city_name      varchar(80) NOT NULL,
  -- Búsqueda sin tildes ni mayúsculas (AC2). Se guarda calculada en vez de normalizar en cada
  -- consulta: un LIKE sobre unaccent(lower(city_name)) no puede usar índice.
  city_busqueda  varchar(80) NOT NULL,
  activo         boolean     NOT NULL DEFAULT true,
  version        varchar(20),
  cargado_en     timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now()
);

-- La clave es la TERNA, no el código de ciudad (AC3). El listado oficial trae `05001` dos veces:
-- Medellín en Colombia y Chachapollas en Perú. Un único sobre `city_code` habría perdido una.
CREATE UNIQUE INDEX IF NOT EXISTS idx_siigo_ciudades_terna
    ON siigo_ciudades (country_code, state_code, city_code);

-- Consulta en cascada (AC2): país → departamentos, departamento → ciudades.
CREATE INDEX IF NOT EXISTS idx_siigo_ciudades_cascada
    ON siigo_ciudades (country_code, state_code) WHERE activo;

-- Búsqueda por nombre normalizado. `text_pattern_ops` para que un LIKE 'medellin%' use el índice.
CREATE INDEX IF NOT EXISTS idx_siigo_ciudades_busqueda
    ON siigo_ciudades (city_busqueda varchar_pattern_ops) WHERE activo;

COMMENT ON TABLE siigo_ciudades IS
  'Catálogo oficial de ubicaciones de Siigo. NO se sincroniza por API: Siigo lo publica como .xlsx. Ver docs/runbook/siigo-catalogo-ciudades.md.';
COMMENT ON COLUMN siigo_ciudades.activo IS
  'false = ya no viene en el listado publicado. No se borra: un cliente antiguo puede referenciarla.';
COMMENT ON COLUMN siigo_ciudades.city_busqueda IS
  'city_name sin tildes y en minúsculas, para buscar sin que el acento importe.';
