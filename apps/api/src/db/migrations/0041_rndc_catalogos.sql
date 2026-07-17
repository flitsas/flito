-- Sprint 4 Fase 4.1 — Catálogos RNDC (códigos oficiales Mintransporte/DANE).
-- Seed mínimo para arrancar; la importación completa de los 1.122 municipios DANE
-- se hace desde el panel admin con POST /api/rndc/catalogos/sync (Fase 4.2).

DO $$ BEGIN
  CREATE TYPE naturaleza_carga AS ENUM (
    'carga_normal', 'carga_peligrosa', 'carga_refrigerada',
    'carga_extradimensionada', 'carga_extrapesada'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE moneda_rndc AS ENUM ('COP', 'USD');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS rndc_municipios (
  codigo_dane varchar(5) PRIMARY KEY,
  nombre varchar(120) NOT NULL,
  departamento_codigo varchar(2) NOT NULL,
  departamento_nombre varchar(80) NOT NULL,
  vigente boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_municipios_depto ON rndc_municipios(departamento_codigo) WHERE vigente = true;
CREATE INDEX IF NOT EXISTS idx_municipios_nombre ON rndc_municipios USING gin (nombre gin_trgm_ops);

CREATE TABLE IF NOT EXISTS rndc_productos_transportar (
  codigo varchar(10) PRIMARY KEY,
  nombre varchar(200) NOT NULL,
  naturaleza naturaleza_carga NOT NULL DEFAULT 'carga_normal',
  unidad_medida_default varchar(10),
  vigente boolean NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_productos_nombre ON rndc_productos_transportar USING gin (nombre gin_trgm_ops);

CREATE TABLE IF NOT EXISTS rndc_empaques (
  codigo varchar(10) PRIMARY KEY,
  nombre varchar(80) NOT NULL,
  vigente boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS rndc_unidades_medida (
  codigo varchar(10) PRIMARY KEY,
  nombre varchar(80) NOT NULL,
  factor_conversion_kg numeric(14, 6),
  vigente boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS rndc_modos_pago (
  codigo varchar(10) PRIMARY KEY,
  nombre varchar(80) NOT NULL,
  vigente boolean NOT NULL DEFAULT true
);

-- Habilitar pg_trgm para búsqueda fuzzy de municipios y productos.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ===========================================================
-- SEEDS — datos mínimos para operar Fase 4.1.
-- Los 1.122 municipios DANE completos se importan vía panel admin.
-- ===========================================================

-- Unidades de medida estándar RNDC.
INSERT INTO rndc_unidades_medida (codigo, nombre, factor_conversion_kg) VALUES
  ('KG',  'Kilogramos',         1),
  ('TON', 'Toneladas',          1000),
  ('GL',  'Galones',            NULL),
  ('LT',  'Litros',             NULL),
  ('M3',  'Metros cúbicos',     NULL),
  ('UND', 'Unidades',           NULL)
ON CONFLICT (codigo) DO NOTHING;

-- Empaques estándar RNDC.
INSERT INTO rndc_empaques (codigo, nombre) VALUES
  ('SAC', 'Sacos'),
  ('CAJ', 'Cajas'),
  ('BUL', 'Bultos'),
  ('CIL', 'Cilindros'),
  ('TAM', 'Tambores'),
  ('PAL', 'Paletas'),
  ('GRA', 'Granel'),
  ('TQE', 'Tanque cisterna'),
  ('CON', 'Contenedor'),
  ('NIN', 'Sin empaque')
ON CONFLICT (codigo) DO NOTHING;

-- Modos de pago RNDC.
INSERT INTO rndc_modos_pago (codigo, nombre) VALUES
  ('CTD', 'Contado'),
  ('CRE', 'Crédito'),
  ('ANT', 'Anticipo'),
  ('MIX', 'Mixto')
ON CONFLICT (codigo) DO NOTHING;

-- Productos top transportados — semilla mínima.
INSERT INTO rndc_productos_transportar (codigo, nombre, naturaleza, unidad_medida_default) VALUES
  ('1001', 'Carga general',                    'carga_normal',          'KG'),
  ('1002', 'Mercancía general',                'carga_normal',          'KG'),
  ('2001', 'Productos alimenticios',           'carga_normal',          'KG'),
  ('2002', 'Productos perecederos refrigerados', 'carga_refrigerada',  'KG'),
  ('3001', 'Materiales de construcción',       'carga_normal',          'TON'),
  ('3002', 'Cemento',                          'carga_normal',          'TON'),
  ('3003', 'Arena, gravilla, agregados',       'carga_normal',          'TON'),
  ('4001', 'Combustibles líquidos',            'carga_peligrosa',       'GL'),
  ('4002', 'Gas licuado',                      'carga_peligrosa',       'GL'),
  ('4003', 'Sustancias químicas',              'carga_peligrosa',       'KG'),
  ('5001', 'Maquinaria y equipos',             'carga_extradimensionada','UND'),
  ('5002', 'Vehículos',                        'carga_normal',          'UND'),
  ('6001', 'Productos textiles',               'carga_normal',          'KG'),
  ('6002', 'Electrodomésticos',                'carga_normal',          'UND'),
  ('7001', 'Granos y cereales',                'carga_normal',          'TON'),
  ('7002', 'Café',                             'carga_normal',          'KG'),
  ('8001', 'Mudanzas',                         'carga_normal',          'M3'),
  ('9999', 'Otros',                            'carga_normal',          'KG')
ON CONFLICT (codigo) DO NOTHING;

-- Municipios principales (capitales departamentales + ciudades top de carga).
-- Esquema: codigo_dane = depto(2) + muni(3). Lista oficial DANE 2024.
INSERT INTO rndc_municipios (codigo_dane, nombre, departamento_codigo, departamento_nombre) VALUES
  ('05001', 'MEDELLÍN',         '05', 'ANTIOQUIA'),
  ('05088', 'BELLO',            '05', 'ANTIOQUIA'),
  ('05266', 'ENVIGADO',         '05', 'ANTIOQUIA'),
  ('05360', 'ITAGÜÍ',           '05', 'ANTIOQUIA'),
  ('05129', 'CALDAS',           '05', 'ANTIOQUIA'),
  ('05380', 'LA ESTRELLA',      '05', 'ANTIOQUIA'),
  ('05631', 'SABANETA',         '05', 'ANTIOQUIA'),
  ('05079', 'BARBOSA',          '05', 'ANTIOQUIA'),
  ('05308', 'GIRARDOTA',        '05', 'ANTIOQUIA'),
  ('05212', 'COPACABANA',       '05', 'ANTIOQUIA'),
  ('05154', 'CAUCASIA',         '05', 'ANTIOQUIA'),
  ('05895', 'TURBO',            '05', 'ANTIOQUIA'),
  ('05045', 'APARTADÓ',         '05', 'ANTIOQUIA'),
  ('08001', 'BARRANQUILLA',     '08', 'ATLÁNTICO'),
  ('08758', 'SOLEDAD',          '08', 'ATLÁNTICO'),
  ('08433', 'MALAMBO',          '08', 'ATLÁNTICO'),
  ('08573', 'PUERTO COLOMBIA',  '08', 'ATLÁNTICO'),
  ('11001', 'BOGOTÁ D.C.',      '11', 'BOGOTÁ D.C.'),
  ('13001', 'CARTAGENA',        '13', 'BOLÍVAR'),
  ('13430', 'MAGANGUÉ',         '13', 'BOLÍVAR'),
  ('13836', 'TURBACO',          '13', 'BOLÍVAR'),
  ('13688', 'SANTA ROSA',       '13', 'BOLÍVAR'),
  ('15001', 'TUNJA',            '15', 'BOYACÁ'),
  ('15759', 'SOGAMOSO',         '15', 'BOYACÁ'),
  ('15238', 'DUITAMA',          '15', 'BOYACÁ'),
  ('17001', 'MANIZALES',        '17', 'CALDAS'),
  ('17873', 'VILLAMARÍA',       '17', 'CALDAS'),
  ('17380', 'LA DORADA',        '17', 'CALDAS'),
  ('17050', 'ARANZAZU',         '17', 'CALDAS'),
  ('18001', 'FLORENCIA',        '18', 'CAQUETÁ'),
  ('19001', 'POPAYÁN',          '19', 'CAUCA'),
  ('19318', 'GUAPI',            '19', 'CAUCA'),
  ('20001', 'VALLEDUPAR',       '20', 'CESAR'),
  ('20011', 'AGUACHICA',        '20', 'CESAR'),
  ('23001', 'MONTERÍA',         '23', 'CÓRDOBA'),
  ('23162', 'CERETÉ',           '23', 'CÓRDOBA'),
  ('23686', 'SAN ANDRÉS DE SOTAVENTO','23', 'CÓRDOBA'),
  ('25754', 'SOACHA',           '25', 'CUNDINAMARCA'),
  ('25430', 'MADRID',           '25', 'CUNDINAMARCA'),
  ('25473', 'MOSQUERA',         '25', 'CUNDINAMARCA'),
  ('25214', 'COTA',             '25', 'CUNDINAMARCA'),
  ('25899', 'ZIPAQUIRÁ',        '25', 'CUNDINAMARCA'),
  ('25307', 'GIRARDOT',         '25', 'CUNDINAMARCA'),
  ('25269', 'FACATATIVÁ',       '25', 'CUNDINAMARCA'),
  ('25286', 'FUNZA',            '25', 'CUNDINAMARCA'),
  ('25175', 'CHÍA',             '25', 'CUNDINAMARCA'),
  ('27001', 'QUIBDÓ',           '27', 'CHOCÓ'),
  ('41001', 'NEIVA',            '41', 'HUILA'),
  ('41551', 'PITALITO',         '41', 'HUILA'),
  ('44001', 'RIOHACHA',         '44', 'LA GUAJIRA'),
  ('44430', 'MAICAO',           '44', 'LA GUAJIRA'),
  ('47001', 'SANTA MARTA',      '47', 'MAGDALENA'),
  ('47189', 'CIÉNAGA',          '47', 'MAGDALENA'),
  ('50001', 'VILLAVICENCIO',    '50', 'META'),
  ('50313', 'GRANADA',          '50', 'META'),
  ('50573', 'PUERTO LÓPEZ',     '50', 'META'),
  ('50450', 'PUERTO GAITÁN',    '50', 'META'),
  ('52001', 'PASTO',            '52', 'NARIÑO'),
  ('52356', 'IPIALES',          '52', 'NARIÑO'),
  ('52835', 'TUMACO',           '52', 'NARIÑO'),
  ('54001', 'CÚCUTA',           '54', 'NORTE DE SANTANDER'),
  ('54405', 'LOS PATIOS',       '54', 'NORTE DE SANTANDER'),
  ('54874', 'VILLA DEL ROSARIO','54', 'NORTE DE SANTANDER'),
  ('54498', 'OCAÑA',            '54', 'NORTE DE SANTANDER'),
  ('63001', 'ARMENIA',          '63', 'QUINDÍO'),
  ('63302', 'CALARCÁ',          '63', 'QUINDÍO'),
  ('66001', 'PEREIRA',          '66', 'RISARALDA'),
  ('66170', 'DOSQUEBRADAS',     '66', 'RISARALDA'),
  ('66682', 'SANTA ROSA DE CABAL','66', 'RISARALDA'),
  ('68001', 'BUCARAMANGA',      '68', 'SANTANDER'),
  ('68276', 'FLORIDABLANCA',    '68', 'SANTANDER'),
  ('68307', 'GIRÓN',            '68', 'SANTANDER'),
  ('68547', 'PIEDECUESTA',      '68', 'SANTANDER'),
  ('68081', 'BARRANCABERMEJA',  '68', 'SANTANDER'),
  ('70001', 'SINCELEJO',        '70', 'SUCRE'),
  ('70215', 'COROZAL',          '70', 'SUCRE'),
  ('73001', 'IBAGUÉ',           '73', 'TOLIMA'),
  ('73268', 'ESPINAL',          '73', 'TOLIMA'),
  ('73411', 'LÍBANO',           '73', 'TOLIMA'),
  ('76001', 'CALI',             '76', 'VALLE DEL CAUCA'),
  ('76520', 'PALMIRA',          '76', 'VALLE DEL CAUCA'),
  ('76834', 'TULUÁ',            '76', 'VALLE DEL CAUCA'),
  ('76109', 'BUENAVENTURA',     '76', 'VALLE DEL CAUCA'),
  ('76147', 'CARTAGO',          '76', 'VALLE DEL CAUCA'),
  ('76622', 'ROLDANILLO',       '76', 'VALLE DEL CAUCA'),
  ('76892', 'YUMBO',            '76', 'VALLE DEL CAUCA'),
  ('76130', 'CANDELARIA',       '76', 'VALLE DEL CAUCA'),
  ('76364', 'JAMUNDÍ',          '76', 'VALLE DEL CAUCA'),
  ('81001', 'ARAUCA',           '81', 'ARAUCA'),
  ('85001', 'YOPAL',            '85', 'CASANARE'),
  ('85162', 'AGUAZUL',          '85', 'CASANARE'),
  ('86001', 'MOCOA',            '86', 'PUTUMAYO'),
  ('86568', 'PUERTO ASÍS',      '86', 'PUTUMAYO'),
  ('88001', 'SAN ANDRÉS',       '88', 'ARCHIPIÉLAGO DE SAN ANDRÉS'),
  ('91001', 'LETICIA',          '91', 'AMAZONAS'),
  ('94001', 'INÍRIDA',          '94', 'GUAINÍA'),
  ('95001', 'SAN JOSÉ DEL GUAVIARE','95', 'GUAVIARE'),
  ('97001', 'MITÚ',             '97', 'VAUPÉS'),
  ('99001', 'PUERTO CARREÑO',   '99', 'VICHADA')
ON CONFLICT (codigo_dane) DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  rndc_municipios, rndc_productos_transportar, rndc_empaques,
  rndc_unidades_medida, rndc_modos_pago
  TO operaciones_app;
