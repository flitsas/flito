-- 0143_siigo_terceros.sql
-- Feature #11241 — Sincronización de clientes FLITO → terceros Siigo. HU #11297.
-- Autor: equipo FLITO. Motivo: vínculo entre un cliente de FLITO y su tercero en Siigo.
--
-- Sin BEGIN/COMMIT propio (ADR-DB-001: el runner ya envuelve cada archivo). Idempotente.
--
-- (La HU decía «migración 0134»; ese número lo ocupó `clients_ciudad_confirmada`. Se usa el
--  siguiente libre. El número no significa nada salvo el orden en que se aplican.)
--
-- ============================================================================
-- LA CLAVE ES LA PAREJA, NO LA IDENTIFICACIÓN
-- ============================================================================
--
-- `docs/integraciones/siigo-api.md` §2 lo dice sin ambigüedad: una identificación **puede repetirse**
-- en Siigo Nube si la sucursal es distinta. Es decir, el NIT no identifica un tercero — lo identifica
-- la pareja `(identification, branch_office)`.
--
-- Por eso el índice único es sobre las dos columnas. Ponerlo solo sobre la identificación habría
-- parecido más simple y habría hecho imposible registrar la segunda sucursal de un cliente que sí
-- existe en Siigo, con un error de índice único que nadie relacionaría con «sucursales».
--
-- La pareja es también la unidad de la CONSULTA: buscar por identificación a secas puede devolver
-- varios terceros, y quedarse con el primero vincularía el cliente al tercero de otra sucursal —una
-- factura emitida contra el tercero equivocado, que es un documento fiscal mal dirigido.
--
-- ============================================================================
-- POR QUÉ SE GUARDA UNA HUELLA Y NO LOS DATOS
-- ============================================================================
--
-- El AC4 pide no llamar a Siigo cuando nada cambió. Para saberlo hay que comparar lo que se envió la
-- última vez con lo que se enviaría ahora. Guardar una COPIA de los datos serviría, y sería una
-- segunda copia de datos personales —nombre, dirección, teléfono, correo— en una tabla más, que
-- habría que sumar al flujo de olvido y mantener sincronizada.
--
-- La huella es un hash: permite responder «¿cambió?» sin conservar el qué, y se calcula sobre el
-- objeto EXACTO que se envió — no sobre la fila del cliente. La diferencia importa: dos filas
-- distintas del cliente pueden producir el mismo objeto para Siigo (un espacio de más en el nombre,
-- una mayúscula), y en ese caso no hay nada que actualizar allá.
--
-- **Pero la tabla NO guarda solo un hash.** `identificacion` es la cédula o el NIT del titular, en
-- claro, y eso es dato personal bajo la Ley 1581. La primera redacción de este encabezado decía que
-- aquí «no hay que purgar nada»: era cierto de la columna `huella` y falso de la tabla. El flujo de
-- olvido de `privacy.routes.ts` anonimiza `clients.document` pero no borra la fila, así que el
-- `ON DELETE CASCADE` no cubre nada — sin tocar esta tabla, la identificación del titular
-- sobreviviría a su propia supresión. Por eso `siigo_terceros` entra en ese flujo.

CREATE TABLE IF NOT EXISTS siigo_terceros (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       integer NOT NULL REFERENCES clients(id) ON DELETE CASCADE,

  -- El identificador del tercero en Siigo. Es lo que hace falta para el `PUT` y para referenciarlo
  -- desde una factura, y es lo único que no podemos reconstruir por nuestra cuenta si se pierde.
  siigo_customer_id varchar(60) NOT NULL,

  -- Copia de la pareja que identifica al tercero EN SIIGO, en el momento del vínculo. No es
  -- redundante con `clients`: si mañana alguien corrige la identificación del cliente en FLITO, esta
  -- columna sigue diciendo contra qué tercero se vinculó, que es lo que permite detectar la
  -- discrepancia en vez de arrastrarla en silencio.
  identificacion  varchar(50) NOT NULL,
  sucursal        integer NOT NULL DEFAULT 0,

  -- Huella del objeto exacto enviado a Siigo la última vez. Ver el encabezado.
  huella          varchar(64) NOT NULL,
  sincronizado_en timestamptz NOT NULL DEFAULT now(),

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT siigo_terceros_sucursal_chk CHECK (sucursal BETWEEN 0 AND 999),
  CONSTRAINT siigo_terceros_identificacion_chk CHECK (length(btrim(identificacion)) >= 1)
);

-- AC8 — la concurrencia la resuelve la BASE, no un candado de la aplicación. Dos peticiones que
-- aseguran el mismo cliente a la vez llegan las dos a este índice; una gana y la otra recibe una
-- violación de unicidad que el servicio traduce a «ya estaba vinculado». Un `SELECT` seguido de un
-- `INSERT` sin esta garantía deja hueco entre los dos, y el hueco produce dos vínculos.
CREATE UNIQUE INDEX IF NOT EXISTS idx_siigo_terceros_identificacion_sucursal
    ON siigo_terceros (identificacion, sucursal);

-- Un cliente de FLITO tiene UN tercero.
CREATE UNIQUE INDEX IF NOT EXISTS idx_siigo_terceros_cliente
    ON siigo_terceros (client_id);

-- Y un tercero de Siigo tiene UN cliente.
--
-- Hacen falta los tres índices, y este es el que casi se queda fuera. La pareja
-- (identificación, sucursal) NO impide que dos clientes apunten al mismo tercero: solo impide que
-- dos filas declaren la misma pareja. Si alguien corrige la identificación de un cliente ya
-- vinculado, la fila local sigue con la vieja mientras el tercero en Siigo cambia a la nueva; a
-- partir de ahí, un segundo cliente con la identificación nueva no encuentra conflicto local, la
-- busca en Siigo, encuentra el tercero ya renombrado y se vincula. Dos clientes de FLITO facturando
-- contra el MISMO tercero, cada factura contra la contabilidad del otro.
--
-- Esto es lo que de verdad lo impide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_siigo_terceros_customer
    ON siigo_terceros (siigo_customer_id);

COMMENT ON TABLE siigo_terceros IS
  'Vínculo entre un cliente de FLITO y su tercero en Siigo (HU #11297). La clave del tercero es '
  'la pareja (identificación, sucursal): en Siigo una identificación puede repetirse entre sucursales.';
COMMENT ON COLUMN siigo_terceros.huella IS
  'Hash del objeto EXACTO enviado a Siigo la última vez. Permite responder «¿cambió?» sin guardar '
  'una segunda copia de los datos personales del cliente.';
COMMENT ON COLUMN siigo_terceros.sucursal IS
  'Sucursal contra la que se vinculó. Pregunta abierta: si en Siigo Nube ya existen terceros con '
  'sucursal distinta de 0, hay que confirmarlo antes de emitir en el ambiente real.';
