-- 0175_flito_soat_gestor_por_defecto_compania.sql
-- Feature #12074 — SOAT canal Cliente sin paso de revision. HU #12078 (el alta despacha al gestor).
-- Autor: equipo FLITO. Diseno y tradeoffs: docs/diseno-hu-12078-alta-despacha-gestor.md
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo con `sql.begin()`).
-- Idempotente: `ADD COLUMN IF NOT EXISTS` + `DROP CONSTRAINT IF EXISTS` / `ADD CONSTRAINT`. La
-- segunda pasada reescribe la misma definicion; el UPDATE del paso 2 no encuentra ninguna fila
-- porque el CHECK del paso 3 ya hace imposible el estado que corrige.
--
-- ============================================================================
-- QUE TRAE (una columna y un CHECK, las dos caras del mismo hecho)
-- ============================================================================
--
-- 1. `clients.flito_proveedor_soat_sin_tramite_id uuid` — el gestor por defecto AL QUE VAN las
--    solicitudes que un usuario `cliente` de esta compania radica por el canal SIN TRAMITE. Desde
--    la HU #12078 el alta ya no nace en `pendiente_revision` esperando a que Operaciones elija
--    destino: nace en `solicitado` con el destino ya escrito, y ese destino sale de aqui.
--
-- 2. `clients_sin_tramite_gestor_chk` — «canal encendido ⇒ gestor configurado». Es el AC2c: el
--    estado «canal abierto sin destinatario» no puede EXISTIR, no solo «no puede crearse desde la
--    pantalla».
--
-- ============================================================================
-- POR QUE EL NOMBRE LLEVA EL CANAL DENTRO
-- ============================================================================
--
-- `flito_proveedor_soat_sin_tramite_id` y no `flito_proveedor_soat_id`, por dos motivos y el
-- segundo es el que importa:
--
--   (a) El sufijo transporta el limite del PO (AC2e): quien vea la columna en un `\d clients` sabe
--       que el SOAT POR TRAMITE no la lee — ese elige gestor en cada `POST /flito/soat/enviar`,
--       una persona y una decision cada vez.
--   (b) `CLIENTS_COLUMNAS_SIN_PII` (shared-types/siigo-terceros.ts) YA contenia la cadena
--       'flitoProveedorSoatId', huerfana: esa columna vive en `users`, no en `clients`. Llamarla
--       asi habria hecho pasar en verde el canario de PII sin que nadie la clasificara. La entrada
--       huerfana se borra en el mismo cambio.
--
-- ============================================================================
-- POR QUE `ON DELETE RESTRICT`, EXPLICITO, Y POR QUE NO `SET NULL`
-- ============================================================================
--
-- ADR-0005 regla 1: la clausula nunca se omite. `NO ACTION` por omision es RESTRICT disfrazado de
-- descuido, y quien lea la tabla no puede distinguir «se decidio» de «se olvido».
--
-- `SET NULL` esta descartado por el MISMO argumento literal que ya escribio `users.compania_id`
-- (ADR-0008 §3): crearia por la puerta de atras justo el estado que el AC2c declara imposible
-- —canal encendido, destino vacio— y lo haria EN SILENCIO, sin que ninguna consulta lo delatara.
-- Borrar un proveedor que es el destino por defecto de una compania tiene que fallar con un error
-- nombrado y obligar a reasignar. Hoy ademas no hay `DELETE /proveedores-soat`: se apaga con
-- `activo = false`, y eso NO dispara la FK (ver el paso 4 y `resolverDestinoCanalCliente`).
--
-- SIN INDICE, y es deliberado. El precedente (`idx_users_compania`) lo anade para que el RESTRICT
-- no escanee la tabla al borrar; aqui la tabla referenciante es `clients` —cientos de filas— y no
-- existe endpoint de borrado de proveedores, asi que el escaneo cuesta menos que el indice. La
-- lectura del resolutor filtra por `clients.id`, que es la PK. Si algun dia nace ese DELETE, el
-- indice entra con el.
--
-- ============================================================================
-- POR QUE EL CHECK, SI LA RUTA YA VALIDA
-- ============================================================================
--
-- Tres razones, y ninguna es «por si acaso»:
--
--   1. El PATCH es LEER-Y-LUEGO-ESCRIBIR. Dos peticiones concurrentes —una que enciende el flag,
--      otra que quita el gestor— pasan las dos por Zod contra el estado previo y confirman ENTRE
--      LAS DOS el estado ilegal. El CHECK es la unica capa que ve las dos escrituras.
--   2. La ruta no es el unico escritor: `scripts/flito-seed.ts` y un `psql` de soporte escriben
--      `clients` sin pasar por ella. Es el argumento textual de la 0168.
--   3. La forma del predicado es la MISMA implicacion material de `users_cliente_compania_chk`, y
--      no dice nada de la direccion contraria: APAGAR el flag NO obliga a quitar el gestor, que se
--      conserva por si el canal se vuelve a abrir (AC2c, segunda mitad).
--
-- ============================================================================
-- LO QUE LA 0168 PODIA DAR POR HECHO Y ESTA NO: EL APAGADO DEL PASO 2
-- ============================================================================
--
-- Alli no habia ni una fila `cliente` cuando el CHECK entro. Aqui SI puede haber companias con
-- `soat_sin_tramite = true` desde el Feature #11912, y NINGUNA tiene gestor porque la columna acaba
-- de nacer. Por eso el orden es: columna → apagar el flag donde no hay destino → CHECK sobre datos
-- ya limpios.
--
-- **Consecuencia operativa que se anuncia, no se esconde:** en el entorno donde haya una compania
-- con el canal abierto, esta migracion la deja con el canal CERRADO hasta que Operaciones le
-- configure un gestor por `PATCH /api/flito/parametrizacion/companias/:id`. Sus usuarios `cliente`
-- reciben mientras tanto el `403 CANAL_DESACTIVADO` que ya existe. Los ids afectados salen por
-- RAISE NOTICE y se leen en el log del CD. Sin nombre: el id basta para reconfigurarlas y no es
-- dato personal (mismo criterio que los NOTICE de la 0173).
--
-- **`NOT VALID` queda descartado por escrito**: dejaria vivas exactamente las filas que la
-- constraint existe para impedir. El AC2c dice «no puede existir», no «no puede crearse a partir
-- de ahora».

-- == 1. La columna =============================================================

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS flito_proveedor_soat_sin_tramite_id uuid
  REFERENCES flito_proveedores_soat(id) ON DELETE RESTRICT;

COMMENT ON COLUMN clients.flito_proveedor_soat_sin_tramite_id IS
  'HU #12078: gestor por defecto al que se despachan las solicitudes del canal SIN TRAMITE de esta '
  'compania. SOLO de ese canal: el SOAT POR TRAMITE no la lee nunca — alli Operaciones elige gestor '
  'en cada POST /flito/soat/enviar, que es cuando alguien mira la carga de cada uno (HU #10979). '
  'NULL = la compania no tiene el canal abierto; el CHECK clients_sin_tramite_gestor_chk impide que '
  'este NULL con soat_sin_tramite = true. Un gestor con activo = false NO rompe el alta: la '
  'solicitud se crea igual y la asume Operaciones por contingencia (AC2d), porque un problema de '
  'configuracion no puede impedir que un cliente radique. ON DELETE RESTRICT explicito: SET NULL '
  'abriria en silencio el estado que el CHECK prohibe.';

-- == 2. Las companias que ya tenian el canal abierto y no tienen destino =======
-- Se apagan ANTES del CHECK, que si no abortaria la cadena entera de migraciones con 23514.

DO $$
DECLARE afectadas text;
BEGIN
  SELECT string_agg(id::text, ', ' ORDER BY id) INTO afectadas
    FROM clients
   WHERE soat_sin_tramite = true AND flito_proveedor_soat_sin_tramite_id IS NULL;
  IF afectadas IS NOT NULL THEN
    RAISE NOTICE '[0175] Companias con «SOAT sin tramite» encendido y SIN gestor por defecto (%). El canal les queda CERRADO: sus usuarios cliente reciben 403 CANAL_DESACTIVADO hasta que Operaciones configure el gestor con PATCH /api/flito/parametrizacion/companias/:id.', afectadas;
  END IF;
END $$;

UPDATE clients
   SET soat_sin_tramite = false
 WHERE soat_sin_tramite = true
   AND flito_proveedor_soat_sin_tramite_id IS NULL;

-- == 3. La invariante en la base ===============================================

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_sin_tramite_gestor_chk;
ALTER TABLE clients ADD CONSTRAINT clients_sin_tramite_gestor_chk
  CHECK (soat_sin_tramite = false OR flito_proveedor_soat_sin_tramite_id IS NOT NULL);

COMMENT ON CONSTRAINT clients_sin_tramite_gestor_chk ON clients IS
  'AC2c de la HU #12078: una compania no puede tener el canal «SOAT sin tramite» abierto sin decir a '
  'donde van sus solicitudes. Implicacion material en UN solo sentido, calcada de '
  'users_cliente_compania_chk (0168): apagar el flag NO obliga a quitar el gestor, que se conserva '
  'por si el canal se vuelve a abrir. Es la capa de la BASE de las tres que sostienen la regla (Zod '
  'en flito-parametrizacion.routes.ts, este CHECK, y resolverDestinoCanalCliente, cuyo fallo por '
  'defecto es la contingencia de Operaciones y nunca un alta caida), y la unica que sigue siendo '
  'cierta cuando la escritura viene de un seed o de un psql de soporte, o cuando dos PATCH '
  'concurrentes confirman entre los dos un estado que ninguno de los dos leyo.';
