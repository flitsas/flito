-- 0172_flito_soat_canal_datos_persistidos.sql
-- Feature #11912 — Solicitud de SOAT sin trámite (canal Cliente). HU #11966 (el RUNT vuelve a ser
-- compuerta del alta, y el Excel del canal lee lo persistido).
-- Autor: equipo FLITO. Diseño: docs/diseno-hu-11966-runt-compuerta-excel-cliente.md
-- ADR: docs/adr/ADR-0010-flito-soat-runt-compuerta-alta.md (Propuesto)
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo con `sql.begin()`).
-- Idempotente en el sentido fuerte: la segunda pasada NO CAMBIA NI UNA FILA.
--
-- ============================================================================
-- QUE TRAE
-- ============================================================================
--
-- 1. `vehicles`: `pasajeros_sentados` y `puertas`. Alimentan las columnas
--    `CapacidadCargaOPasajeros` y `Puertas` del Excel para las filas `origen='cliente'` (AC6).
--
-- 2. `flito_compradores`: `nombres`, `apellidos`, `razon_social`, `municipio`, `departamento`.
--    El propietario del canal se guarda PARTIDO (AC5); `nombre_completo` pasa a ser un derivado
--    para la busqueda de la cola, no la fuente.
--
-- 3. Un CHECK: `flito_compradores_titular_chk` — nunca razon social Y nombres/apellidos a la vez.
--
-- ============================================================================
-- POR QUE TODO NULLABLE Y SIN DEFAULT (deliberado, es el AC6)
-- ============================================================================
--
-- `vehicles` es la tabla COMPARTIDA del pipeline entero (`upsertVehiculo()` del sync corre para
-- todos los tramites). Un NOT NULL exigiria un DEFAULT para las filas existentes, y el unico
-- candidato de `puertas` seria '4' — es decir, escribir en la base la constante de la plantilla
-- como si fuera un dato medido, que es justo la mentira que el AC6 viene a quitar del archivo.
-- `carroceria` (migracion 0166) sienta el precedente: nullable.
--
-- `flito_compradores` tiene ~7 052 filas escritas por el sync de tramites con `nombre_completo`
-- fundido en una sola cadena (`flit-http.adapter.ts:74`). Un NOT NULL obligaria a un backfill que
-- partiera el nombre por el espacio — la heuristica que `COLUMNAS_COMPRADOR` rechaza por escrito
-- porque falla en cada nombre compuesto y en cada razon social. Las filas de tramite SIGUEN
-- leyendo `flit_raw` y no necesitan estas columnas jamas.
--
-- TEXTO y no integer en `pasajeros_sentados`/`puertas`, por la misma razon escrita en la 0166 para
-- `cilindraje`/`carroceria`/`tipo_servicio`: el origen es texto de un tercero y '0', '05' y ''
-- son valores distinguibles que un integer colapsa o rechaza con un 22P02 a mitad de un alta.
--
-- ============================================================================
-- SIN BACKFILL (deliberado)
-- ============================================================================
--
-- No hay nada que rellenar: las filas de tramite no usan estas columnas, y las del canal radicadas
-- antes de esta HU NO SE REESCRIBEN (AC6, y es la mitad del acuerdo con el PO). Cero UPDATE en
-- este archivo. La segunda pasada no cambia ni una fila porque la primera tampoco cambio ninguna.
--
-- Idempotencia: `ADD COLUMN IF NOT EXISTS` (x7) y el CHECK reciclado con `DROP CONSTRAINT IF
-- EXISTS` + `ADD` — PostgreSQL no admite `ADD CONSTRAINT IF NOT EXISTS`, el mismo patron de la
-- 0167 y la 0171. `COMMENT ON COLUMN` es idempotente por definicion.

-- ── 1. vehicles: los dos datos tecnicos que solo trae el RUNT ────────────────

ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS pasajeros_sentados varchar(10);

ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS puertas varchar(5);

COMMENT ON COLUMN vehicles.pasajeros_sentados IS
  'HU #11966: capacidad de pasajeros sentados segun el RUNT (texto: el origen es texto de un '
  'tercero). Alimenta CapacidadCargaOPasajeros del Excel SOLO en filas origen=cliente; la fila de '
  'tramite sigue leyendo flit_raw->>capacidad.';

COMMENT ON COLUMN vehicles.puertas IS
  'HU #11966: numero de puertas segun el RUNT (texto). La escribe SOLO el canal Cliente — es una '
  'regla de servicio, no de esquema: vehicles no conoce el origen del SOAT. El export la lee solo '
  'para filas origen=cliente; la fila de tramite conserva la constante 4 de la plantilla.';

-- ── 2. flito_compradores: el titular PARTIDO y su domicilio ─────────────────

ALTER TABLE flito_compradores
  ADD COLUMN IF NOT EXISTS nombres varchar(200);

ALTER TABLE flito_compradores
  ADD COLUMN IF NOT EXISTS apellidos varchar(200);

ALTER TABLE flito_compradores
  ADD COLUMN IF NOT EXISTS razon_social varchar(200);

ALTER TABLE flito_compradores
  ADD COLUMN IF NOT EXISTS municipio varchar(100);

ALTER TABLE flito_compradores
  ADD COLUMN IF NOT EXISTS departamento varchar(100);

COMMENT ON COLUMN flito_compradores.nombres IS
  'HU #11966: nombre(s) de pila del titular, solo persona natural. NULL en las filas del sync, que '
  'traen el nombre fundido en nombre_completo y siguen leyendose desde flit_raw.';

COMMENT ON COLUMN flito_compradores.apellidos IS
  'HU #11966: apellido(s) del titular, solo persona natural. NULL en las filas del sync.';

COMMENT ON COLUMN flito_compradores.razon_social IS
  'HU #11966: razon social del titular cuando tipo_documento = NIT. Excluyente con nombres y '
  'apellidos (flito_compradores_titular_chk).';

COMMENT ON COLUMN flito_compradores.municipio IS
  'HU #11966: municipio del DOMICILIO del titular (canal Cliente). No es la ciudad del tramite ni '
  'la jurisdiccion del organismo. Es dato personal: declarado en CAMPOS_PII_COLA_EXPORT.';

COMMENT ON COLUMN flito_compradores.departamento IS
  'HU #11966: departamento del DOMICILIO del titular (canal Cliente). Ojo: para las filas de '
  'tramite la columna Departamento del Excel sigue siendo la jurisdiccion del organismo '
  '(flit_raw->>departamentoTransito), que es otra cosa. Es dato personal.';

-- ── 3. El CHECK, y solo uno ─────────────────────────────────────────────────
--
-- «Nunca las dos cosas a la vez». Las ~7 052 filas legacy lo cumplen: los tres campos NULL.
--
-- NO se añade el reciproco (`tipo_documento='NIT' => razon_social IS NOT NULL`): bloquearia a un
-- futuro escritor del sync que rellene tipo_documento sin razon social, y la mitad positiva ya la
-- exige Zod en la unica ruta que escribe estas columnas.
--
-- Se declara TAMBIEN en schema.ts, por la leccion que dejo escrita la 0157: un CHECK que solo vive
-- en la base convence a quien lee schema.ts de que no hace falta migracion, y el primer INSERT
-- nuevo muere con 23514.
ALTER TABLE flito_compradores
  DROP CONSTRAINT IF EXISTS flito_compradores_titular_chk;
ALTER TABLE flito_compradores
  ADD CONSTRAINT flito_compradores_titular_chk
  CHECK (razon_social IS NULL OR (nombres IS NULL AND apellidos IS NULL));
