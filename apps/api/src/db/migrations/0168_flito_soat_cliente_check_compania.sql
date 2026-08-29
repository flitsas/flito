-- 0168_flito_soat_cliente_check_compania.sql
-- Feature #11912 — Solicitud de SOAT sin trámite (canal Cliente). HU #11913, AC2:
-- «un usuario con rol cliente sin compañía no queda creado ni usable».
-- Autor: equipo FLITO. Diseño y tradeoffs: docs/adr/ADR-0008-flito-soat-canal-cliente.md
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo con `sql.begin()`).
-- Idempotente: DROP IF EXISTS + ADD. La segunda pasada reescribe la misma definición y no toca
-- ninguna fila.
--
-- ============================================================================
-- POR QUÉ ESTE ARCHIVO EXISTE SEPARADO DE LA 0167
-- ============================================================================
--
-- Por una restricción de PostgreSQL, no por el dominio, y quien lea las dos migraciones en seis
-- meses no lo va a adivinar: `ALTER TYPE ... ADD VALUE` está permitido dentro de una transacción,
-- pero USAR el valor nuevo en esa MISMA transacción no —falla con `55P04 unsafe use of new value`—.
-- El runner (`db-apply.ts`) envuelve cada archivo en su propia `sql.begin()`, así que el único
-- statement de todo el Feature que nombra un valor nuevo del enum tiene que ir en el archivo
-- siguiente. Las migraciones se aplican en orden alfabético y en transacciones separadas: cuando
-- este archivo corre, 'cliente' ya está confirmado en `user_role`.
--
-- NO fusionar este CHECK dentro de la 0167. Si alguien lo intenta, el `db:apply` de un entorno
-- nuevo aborta con 55P04 y la cadena entera se para — y en los entornos donde la 0167 ya está
-- aplicada no se reproduce, que es lo que vuelve traicionero el error.
--
-- ============================================================================
-- POR QUÉ EL AC2 NECESITA UN CHECK Y NO LE BASTA CON ZOD
-- ============================================================================
--
-- El AC2 no dice «la pantalla lo rechaza», dice «no queda un usuario cliente usable». Eso es una
-- afirmación sobre la BASE, y solo la base la puede sostener. La validación de `users.routes.ts`
-- —calcada de la de `transito_codigo`, que NO tiene CHECK y por eso hay que justificar este—
-- protege únicamente la ruta que la lleva escrita: un seed (`flito-seed.ts` ya inserta usuarios con
-- `flito_proveedor_soat_id` directo), un `psql` de soporte o un PATCH futuro que olvide la regla
-- producen el usuario imposible sin que nada avise.
--
-- Es la segunda de las tres capas del AC2. La tercera es `contextoSoat()`: si aun así existiera un
-- `cliente` sin compañía, la cola le sale vacía y el detalle 404. El fallo por defecto es «no ve
-- nada», nunca «lo ve todo».
--
-- ============================================================================
-- LA FORMA DEL PREDICADO
-- ============================================================================
--
-- `role <> 'cliente' OR compania_id IS NOT NULL` — implicación material: si el rol es cliente,
-- entonces hay compañía. NO dice nada sobre los otros 11 roles: un admin con `compania_id` puesto
-- es raro pero no ilegal para la base, y eso es deliberado. Lo prohíbe Zod (mensaje «Solo los
-- usuarios Cliente pueden tener compañía asignada»), que es donde la regla puede explicarse; un
-- CHECK bidireccional convertiría cualquier corrección de datos en un 23514 sin pista de qué hacer.
--
-- Se aplica sobre las filas existentes sin `NOT VALID`: hoy no hay ningún usuario `cliente` —el
-- valor del enum acaba de nacer en la 0167— así que el escaneo no puede fallar y `users` es una
-- tabla del tamaño de esta instalación.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_cliente_compania_chk;
ALTER TABLE users ADD CONSTRAINT users_cliente_compania_chk
  CHECK (role <> 'cliente' OR compania_id IS NOT NULL);

COMMENT ON CONSTRAINT users_cliente_compania_chk ON users IS
  'AC2 de la HU #11913: un usuario con rol cliente SIEMPRE tiene compania. Es la capa de la BASE de '
  'las tres que sostienen esa regla (Zod en users.routes.ts, este CHECK, y el return null de '
  'contextoSoat), y la unica que sigue siendo cierta cuando el usuario lo crea un seed o un psql de '
  'soporte. Implicacion en un solo sentido a proposito: no prohibe que otro rol tenga compania '
  'puesta, eso lo rechaza Zod, que si puede explicar por que. Vive en la migracion 0168 y no en la '
  '0167 porque nombra un valor de enum anadido alli, y PostgreSQL no deja usarlo en la misma '
  'transaccion (55P04).';
