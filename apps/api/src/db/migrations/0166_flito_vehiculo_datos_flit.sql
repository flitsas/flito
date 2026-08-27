-- 0166_flito_vehiculo_datos_flit.sql
-- Feature #11904 — Datos del vehiculo que trae FLIT. HU #11906 (cilindraje, carroceria y tipo de
-- servicio guardados en BD al sincronizar, visibles en la fila de la cola de SOAT).
-- Autor: equipo FLITO.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo con sql.begin()).
-- Idempotente: tres ADD COLUMN IF NOT EXISTS y tres COMMENT ON. La segunda pasada no cambia nada.
--
-- ============================================================================
-- QUE HACE ESTA MIGRACION
-- ============================================================================
--
-- Anade tres columnas a `vehicles`. Nada mas. NO hay backfill, NO hay indices, NO hay enum y NO se
-- escribe ni una fila. Cada una de esas cuatro ausencias es una decision, y esta escrita abajo.
--
-- ============================================================================
-- POR QUE EN `vehicles` Y NO EN `flito_soat`
-- ============================================================================
--
-- El dato llega por el reporte de FLIT y lo consume la cola de SOAT, asi que el sitio "obvio" seria
-- `flito_soat`. Seria el sitio equivocado, y el motivo es mecanico, no de gusto:
--
--   · `resolverSoat()` (flito-sync.service.ts) hace `return` en cuanto encuentra que el SOAT ya
--     existe: no actualiza campos. Y ademas solo corre para tramites en estado `Asignado` y con
--     compania y organismo emparejados.
--   · `upsertVehiculo()` corre para TODOS los tramites y en TODAS las corridas.
--
-- El AC3 de la HU pide que un SOAT ya sincronizado ANTES de esta HU se complete en el proximo sync.
-- Con las columnas en `flito_soat` ese AC seria inalcanzable para siempre (no en "casi todos los
-- casos": nunca). Con las columnas en `vehicles` se cumple solo, sin backfill.
--
-- Coste de salida cero: la cola de SOAT ya hace `innerJoin(vehicles)` para sacar placa, marca y
-- linea. Las tres columnas viajan en ese mismo JOIN.
--
-- ============================================================================
-- POR QUE TEXTO Y NO ENTERO EN `cilindraje`
-- ============================================================================
--
-- `integer` es la primera idea y es una perdida de informacion:
--
--   · El repo ya documenta que **`0` significa vehiculo electrico** (ver el comentario de
--     `apps/api/src/modules/vehicles/ocr.routes.ts`). Con `integer`, el cero electrico y el cero
--     "no se sabe" serian el mismo valor, o habria que perder uno de los dos.
--   · Medido hoy contra el reporte real (reportTypeId=18, 2733 items): `cilindraje` llega SIEMPRE
--     como string, la clave nunca falta, 10 vienen vacios, 116 valores distintos y la longitud
--     maxima es 5. El valor mas frecuente es "220" (917 filas: motos).
--   · Un futuro "1.598" o "220 CC" daria 1 y 220 con `parseInt`, en silencio y sin error. Guardar el
--     texto tal como lo dijo la fuente deja el problema visible en pantalla en vez de enterrarlo.
--
-- Es un dato para MOSTRAR, no para calcular: no hay ninguna consulta que sume, ordene ni compare
-- cilindrajes. El dia que la haya, se convierte en la consulta y se decide alli que hacer con el 0.
--
-- ============================================================================
-- POR QUE `tipo_servicio` NO ES UN ENUM (NI UN CHECK)
-- ============================================================================
--
-- Medido: hoy son exactamente DOS valores ("Particular", "Publico") y cero vacios. Tentador.
--
-- Pero el sync envuelve UN TRAMITE POR TRANSACCION con try/catch. Un tercer valor que FLIT decida
-- mandar manana ("Oficial", "Diplomatico") abortaria esa transaccion con un `22P02 invalid input
-- value for enum` y ese tramite quedaria sin sincronizar en ESA corrida y en TODAS las siguientes,
-- con el unico rastro en un `log.error`. El precio de aceptar un valor inesperado es que la cola
-- muestre una palabra rara; el precio de rechazarlo es un tramite que desaparece del sistema.
--
-- Tampoco se reutiliza `vehicles.tipo_vehiculo` (enum de flota propia) ni `vehicles.vehicle_class`:
-- son otra pregunta. `tipo_vehiculo` dice que ES el vehiculo (auto, moto, cabezote) y `tipo_servicio`
-- dice para que SE USA. Meterlos en la misma columna perderia una de las dos.
--
-- ============================================================================
-- ANCHOS: 2-3x LO MEDIDO, A PROPOSITO
-- ============================================================================
--
--   columna         medido (max)   declarado    razon del margen
--   cilindraje      5              10           cabe "1.598 CC" si FLIT cambia el formato
--   carroceria      23             60           26 valores distintos hoy; el catalogo puede crecer
--   tipo_servicio   10             30           2 valores hoy; un tercero mas largo cabe igual
--
-- El margen NO es generosidad: es la misma mecanica del parrafo anterior. Un valor mas largo que la
-- columna es un `22001 value too long`, que dentro de la transaccion del tramite lo deja fuera del
-- sync para siempre. Como segunda linea de defensa, el adaptador (`flit-http.adapter.ts`) descarta a
-- NULL con un `log.warn` cualquier valor que exceda el ancho, en vez de truncarlo: un cilindraje
-- recortado es OTRO cilindraje. Es el mismo argumento que ya esta escrito para `owner_document` en
-- `titularDe()`.
--
-- ============================================================================
-- NULLABLE Y SIN DEFAULT
-- ============================================================================
--
-- NULL significa "FLIT no lo trajo" y es lo que el frontend pinta como guion (AC2). Un
-- `NOT NULL DEFAULT ''` crearia un TERCER valor para la misma idea (vacio, NULL y "no se sabe") y
-- obligaria a inventarle valor a los 6422 vehiculos que ya existen. Un ADD COLUMN nullable y sin
-- default es un cambio de metadatos en PostgreSQL: no reescribe la tabla ni toma la tabla mucho rato.
--
-- ============================================================================
-- SIN BACKFILL (AC3 lo pide asi, explicitamente)
-- ============================================================================
--
-- El `flit_raw` de `flito_tramites` guarda el payload crudo y ahi estan los tres campos de los
-- tramites ya ingeridos: tecnicamente se podria rellenar el historico con un UPDATE. NO SE HACE.
--
-- El AC3 dice "el PROXIMO sync los completa. Sin backfill desde el raw ya guardado". Y hay una razon
-- ademas del AC: el `raw` es una FOTO de la ultima vez que el sync vio ese tramite, con la antiguedad
-- que tenga; el proximo sync trae el dato de ahora. Rellenar desde el raw daria valores "ya
-- guardados" sin manera de distinguir los frescos de los viejos, y —peor— haria que el AC3 se viera
-- verde sin que la ruta del sync funcione.
--
-- Esa ausencia esta vigilada: `flito-sync-migracion-0166-paridad.test.ts` afirma que este archivo NO
-- contiene ningun `UPDATE vehicles`.
--
-- ============================================================================
-- SIN INDICES
-- ============================================================================
--
-- Decision, no olvido. Ninguna consulta filtra ni ordena por estas tres columnas: salen por el JOIN
-- que la cola ya hace por `flito_soat.vehiculo_id`. `tipo_servicio` tiene cardinalidad 2, donde un
-- indice no serviria ni aunque se filtrara. Y `vehicles` recibe un UPDATE por tramite y por corrida:
-- cada indice de mas es escritura pagada en cada sync a cambio de un plan que nadie pide.
--
-- ============================================================================
-- PII (Ley 1581)
-- ============================================================================
--
-- Ninguno de los tres identifica a una persona: describen al vehiculo. El mismo reporte de FLIT trae
-- celular, correoelectronico y cedulanit; esta migracion NO los toca y la HU no los persiste ni los
-- expone (AC4). Siguen viajando solo dentro de `flito_tramites.flit_raw`, como hasta hoy.
--
-- ============================================================================
-- GRANTS
-- ============================================================================
--
-- No hacen falta: `operaciones_app` ya tiene los privilegios sobre `vehicles`, y en PostgreSQL los
-- privilegios de tabla cubren las columnas nuevas sin re-concederlos.

ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS cilindraje VARCHAR(10);

COMMENT ON COLUMN vehicles.cilindraje IS
  'Cilindraje tal como lo dice FLIT en el reporte de tramites (HU #11906). TEXTO y no entero a '
  'proposito: el repo ya usa 0 con el significado "vehiculo electrico" (ocr.routes.ts), asi que con '
  'integer el cero electrico y el cero "no se sabe" serian indistinguibles; y un "1.598" o un '
  '"220 CC" futuros darian 1 y 220 en silencio con parseInt. Es un dato para MOSTRAR, no para '
  'calcular. Lo escribe upsertVehiculo() en cada corrida del sync, y solo cuando FLIT trae valor: un '
  'reporte con el campo vacio NO borra lo que ya se sabia. NULL = FLIT no lo trajo (la cola pinta un '
  'guion). Sin backfill desde flit_raw: el historico se completa en el proximo sync (AC3).';

ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS carroceria VARCHAR(60);

COMMENT ON COLUMN vehicles.carroceria IS
  'Carroceria segun FLIT (HU #11906): SUV, SEDAN, WAGON, DOBLE CABINA CON PLATON, SIN CARROCERIA... '
  'Texto libre del proveedor, sin catalogo ni CHECK: 26 valores distintos medidos y el catalogo es '
  'suyo, no nuestro. varchar(60) contra 23 medidos, porque un 22001 dentro de la transaccion del '
  'tramite lo dejaria fuera del sync en todas las corridas siguientes. Vive en vehicles y no en '
  'flito_soat porque resolverSoat() no actualiza un SOAT que ya existe. NULL = no vino.';

ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS tipo_servicio VARCHAR(30);

COMMENT ON COLUMN vehicles.tipo_servicio IS
  'Para que SE USA el vehiculo segun FLIT (HU #11906): hoy "Particular" o "Publico". NO es un enum '
  'ni lleva CHECK aunque hoy sean dos valores: un tercero que FLIT mandara abortaria la transaccion '
  'de ese tramite con 22P02 y lo dejaria sin sincronizar para siempre, con el unico rastro en un '
  'log.error. Distinto de vehicles.tipo_vehiculo (que ES el vehiculo: auto, moto, cabezote) y de '
  'vehicles.vehicle_class; no se reutiliza ninguna de las dos. NULL = no vino.';
