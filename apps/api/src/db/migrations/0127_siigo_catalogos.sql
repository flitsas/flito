-- 0127_siigo_catalogos.sql
-- Feature #11239 — Integración con Siigo API. HU #11281: copia local de los catálogos.
-- Autor: equipo FLITO. Motivo: cachear tipos de comprobante, vendedores, formas de pago,
-- impuestos, grupos de inventario y centros de costo para parametrizar sin llamar a Siigo.
--
-- Siigo permite 100 peticiones por minuto POR EMPRESA. Resolver estos catálogos en cada pintado de
-- pantalla agotaría la cuota con consultas que devuelven siempre lo mismo.
--
-- LA COPIA ES POR AMBIENTE. `pruebas` y `produccion` son empresas DISTINTAS en Siigo, con
-- identificadores propios: el id 24446 es un tipo de comprobante en una y puede ser otro —o no
-- existir— en la otra. Sin la columna `ambiente`, sincronizar producción tras haber sincronizado
-- pruebas sobrescribiría los códigos que coincidieran y, por la regla de «lo que no vino se
-- inactiva», dejaría inactivo TODO el catálogo del otro ambiente. La copia local dejaría de
-- significar nada. Por eso la unicidad y todas las lecturas van por (ambiente, tipo, codigo).
--
-- SIN borrado: un elemento que deja de venir se marca activo = false y conserva su fila. Una factura
-- emitida hace un año referencia un centro de costo que quizá ya no existe; sin la fila no habría
-- forma de explicar esa parametrización.
--
-- Idempotente: se puede correr dos veces sin efecto adicional.

CREATE TABLE IF NOT EXISTS siigo_catalogos (
  id              bigserial PRIMARY KEY,
  -- Empresa de Siigo a la que pertenece el elemento. Mismo dominio y mismo estilo de guarda que
  -- `siigo_credenciales.ambiente` (0125): los dos describen el mismo eje.
  ambiente        varchar(12) NOT NULL,
  -- Catálogo al que pertenece el elemento. Texto y no enum: un enum es un TIPO compartido por todo
  -- el esquema, sus valores no se pueden retirar (solo añadir) y drizzle tendría que declararlo en
  -- `schema.ts` para cualquier consulta. El CHECK de abajo da la misma garantía sin nada de eso, y
  -- ampliarlo cuando lleguen bodegas o listas de precio (Features 11 a 15) es un ALTER de solo
  -- metadatos sobre esta tabla. El CHECK se mantiene a propósito: `tipo` es el filtro de TODAS las
  -- lecturas, así que un valor mal escrito no daría error — crearía un catálogo fantasma invisible.
  tipo            varchar(30) NOT NULL,
  -- Identificador de Siigo como texto: hay catálogos con código alfanumérico.
  codigo          varchar(60) NOT NULL,
  nombre          varchar(200) NOT NULL,
  descripcion     varchar(300),
  activo          boolean NOT NULL DEFAULT true,
  -- Atributos propios de cada catálogo (porcentaje del impuesto, si la forma de pago maneja
  -- vencimiento, si el comprobante exige centro de costo…). NUNCA datos personales.
  atributos       jsonb,
  sincronizado_en timestamptz NOT NULL DEFAULT now(),
  -- Momento en que el elemento dejó de venir de Siigo. Null mientras siga activo.
  inactivado_en   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT siigo_catalogos_ambiente_chk CHECK (ambiente IN ('pruebas', 'produccion')),
  CONSTRAINT siigo_catalogos_tipo_chk CHECK (tipo IN (
    'document_type', 'user', 'payment_type', 'tax', 'account_group', 'cost_center'
  ))
);

-- Garantía real de la unicidad por catálogo Y ambiente. Sin este índice, una sincronización con una
-- respuesta repetida duplicaría elementos y la lista de parametrización mostraría el mismo vendedor
-- dos veces; y sin `ambiente` en la llave, el id de una empresa pisaría el de la otra.
-- Es también el índice contra el que resuelve el ON CONFLICT del upsert: cambiar sus columnas sin
-- cambiar el `target` del upsert haría fallar la sincronización entera.
CREATE UNIQUE INDEX IF NOT EXISTS idx_siigo_catalogos_ambiente_tipo_codigo
  ON siigo_catalogos (ambiente, tipo, codigo);

-- La lectura real de la parametrización: «los elementos activos de este catálogo en este ambiente,
-- por nombre».
CREATE INDEX IF NOT EXISTS idx_siigo_catalogos_ambiente_tipo_activo
  ON siigo_catalogos (ambiente, tipo, activo, nombre);

COMMENT ON TABLE siigo_catalogos IS
  'Copia local de los catálogos de Siigo. Única por (ambiente, tipo, codigo); sin borrado (HU #11281).';
COMMENT ON COLUMN siigo_catalogos.ambiente IS
  'Empresa de Siigo: pruebas o produccion. Son empresas distintas con identificadores propios; la copia local no se mezcla entre ambientes.';
COMMENT ON COLUMN siigo_catalogos.codigo IS
  'Identificador de Siigo en texto. Único dentro del tipo y del ambiente, no entre ellos.';
COMMENT ON COLUMN siigo_catalogos.activo IS
  'false = dejó de venir de Siigo o vino inactivo. La fila se conserva para explicar parametrizaciones antiguas.';
COMMENT ON COLUMN siigo_catalogos.atributos IS
  'Atributos propios del catálogo. Sin datos personales: del catálogo de vendedores solo se guarda el nombre (Ley 1581).';
