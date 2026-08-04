-- Baseline faltante: objetos que la cadena de migraciones NUNCA creó.
--
-- Origen del hueco: durante el desarrollo inicial estas tablas se materializaron con
-- `drizzle-kit push` (que aplica schema.ts directo, sin generar archivo). Las migraciones
-- 0000-0004 son las únicas generadas por `drizzle-kit generate`, y de 0005 en adelante el
-- SQL es escrito a mano asumiendo que estas tablas YA existían. Resultado: una BD limpia
-- rompía en 0005 con `type "tramite_estado" does not exist`, y `docker compose up` sobre
-- un volumen nuevo fallaba en el servicio `migrate`.
--
-- Falta cubierto:
--   enum  tramite_estado           ← primer uso 0005_transito_role.sql
--   tabla tramites_digitales       ← primer uso 0005_transito_role.sql
--   tabla tramites_validaciones    ← primer uso 0050_serial_to_bigserial.sql
--   tabla procesamiento_cuentas    ← primer uso 0108_flito_derechos_drive.sql
--   tabla tramites_documentos      ← NINGUNA migración la nombra
--   tabla tramites_historial       ← NINGUNA migración la nombra
--
-- Las dos últimas no rompen la cadena (ninguna migración las toca), así que no aparecen
-- como error al migrar: aparecen en runtime, cuando el código las consulta contra una BD
-- que no las tiene. Se detectaron diffeando el esquema construido por migraciones contra
-- el de schema.ts, no leyendo el SQL.
--
-- IDEMPOTENTE A PROPÓSITO. db-apply.ts calcula `pending` solo por nombre de archivo, así
-- que en entornos que ya tienen las 126 aplicadas (PDN/QA) este archivo se ejecutará una
-- vez: cada sentencia debe ser un no-op ahí. Por eso IF NOT EXISTS y el guard de
-- duplicate_object. Se numera 0004a para caer entre 0004 y 0005 en el sort de archivos.
--
-- Las columnas reflejan el estado FINAL del objeto en schema.ts. Las migraciones
-- posteriores que las agregan usan ADD COLUMN IF NOT EXISTS, así que quedan en no-op.
-- Los índices que SÍ tienen dueño en una migración posterior (idx_tramites_estado y
-- idx_tramites_estado_organismo en 0086, idx_tramites_vin en 0085) NO se crean aquí:
-- son de ellas. Solo se crean los que ningún archivo declara.

-- ── enum tramite_estado ────────────────────────────────────────────────────────
-- Todos los valores finales. Las migraciones que los agregan (0005, 0092…) usan
-- ADD VALUE IF NOT EXISTS → no-op. El orden es el de pg_enum en una BD sana.
DO $$ BEGIN
  CREATE TYPE "public"."tramite_estado" AS ENUM(
    'borrador', 'radicado', 'en_validacion', 'documentos', 'identidad', 'aprobado',
    'rechazado', 'enviado_transito', 'recibido_transito', 'placa_preasignada',
    'solicitud_soat', 'soat_comprado', 'soat_verificado', 'completado', 'subsanacion',
    'en_tramite', 'entregado', 'anulado'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- ── tramites_digitales ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "tramites_digitales" (
	"id" serial PRIMARY KEY NOT NULL,
	"tipo" varchar(10) DEFAULT 'B01' NOT NULL,
	"estado" "tramite_estado" DEFAULT 'borrador' NOT NULL,
	"paso" integer DEFAULT 1 NOT NULL,
	"modalidad_entrada" varchar(20) DEFAULT 'matricula_inicial' NOT NULL,
	"numero_radicado" varchar(20),
	"workflow" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tipologia_codigo" varchar(40),
	"checklist_estado" jsonb,
	"verify_token" varchar(64),
	"verify_token_expires" timestamp with time zone,
	"vin" varchar(17),
	"placa" varchar(10),
	"vehiculo" jsonb,
	"comprador" jsonb,
	"documentos" jsonb,
	"validacion_identidad" jsonb,
	"fur_generado" boolean DEFAULT false NOT NULL,
	"fur_error" text,
	"fur_error_at" timestamp with time zone,
	"notas" text,
	"motivo_rechazo_codigo" varchar(40),
	"organismo_codigo" varchar(5),
	"creado_por" integer NOT NULL,
	"recibido_por" integer,
	"recibido_at" timestamp with time zone,
	"placa_asignada_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "tramites_digitales" ADD CONSTRAINT "tramites_digitales_creado_por_users_id_fk"
    FOREIGN KEY ("creado_por") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "tramites_digitales" ADD CONSTRAINT "tramites_digitales_recibido_por_users_id_fk"
    FOREIGN KEY ("recibido_por") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "idx_tramites_creado_por" ON "tramites_digitales" USING btree ("creado_por");

-- ── tramites_validaciones ──────────────────────────────────────────────────────
-- `id` se crea como serial (int4) A PROPÓSITO: 0050_serial_to_bigserial.sql lo migra a
-- bigint. Crearlo ya en bigserial dejaría a 0050 sin efecto y la BD limpia divergiría del
-- camino que recorrió producción.
CREATE TABLE IF NOT EXISTS "tramites_validaciones" (
	"id" serial PRIMARY KEY NOT NULL,
	"tramite_id" integer NOT NULL,
	"token" varchar(64) NOT NULL,
	"nombre" varchar(200),
	"tipo_doc" varchar(10),
	"documento" varchar(20),
	"email" varchar(150),
	"placa" varchar(10),
	"vehiculo_info" varchar(200),
	"estado" varchar(20) DEFAULT 'enviado' NOT NULL,
	"parte" varchar(20),
	"firma_serie" varchar(60),
	"firma_hash" varchar(64),
	"firma_timestamp" timestamp with time zone,
	"score" integer,
	"detalle" jsonb,
	"intentos" integer DEFAULT 0 NOT NULL,
	"ip_address" varchar(45),
	"foto_rostro" text,
	"foto_cedula_frontal" text,
	"foto_cedula_reverso" text,
	"ciudad_geo" varchar(200),
	"lat" varchar(15),
	"lng" varchar(15),
	"user_agent" varchar(500),
	"enviado_at" timestamp with time zone,
	"procesando_desde" timestamp with time zone,
	"validado_at" timestamp with time zone,
	"expira_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tramites_validaciones_token_unique" UNIQUE("token")
);

DO $$ BEGIN
  ALTER TABLE "tramites_validaciones" ADD CONSTRAINT "tramites_validaciones_tramite_id_tramites_digitales_id_fk"
    FOREIGN KEY ("tramite_id") REFERENCES "public"."tramites_digitales"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "idx_tramites_val_token" ON "tramites_validaciones" USING btree ("token");
CREATE INDEX IF NOT EXISTS "idx_tramites_val_tramite_id" ON "tramites_validaciones" USING btree ("tramite_id");

-- ── tramites_documentos ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "tramites_documentos" (
	"id" serial PRIMARY KEY NOT NULL,
	"tramite_id" integer NOT NULL,
	"tipo" varchar(30) NOT NULL,
	"filename" varchar(300) NOT NULL,
	"original_name" varchar(300),
	"mimetype" varchar(100),
	"size" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "tramites_documentos" ADD CONSTRAINT "tramites_documentos_tramite_id_tramites_digitales_id_fk"
    FOREIGN KEY ("tramite_id") REFERENCES "public"."tramites_digitales"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- ── tramites_historial ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "tramites_historial" (
	"id" serial PRIMARY KEY NOT NULL,
	"tramite_id" integer NOT NULL,
	"estado_anterior" varchar(30) NOT NULL,
	"estado_nuevo" varchar(30) NOT NULL,
	"usuario_id" integer,
	"detalle" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "tramites_historial" ADD CONSTRAINT "tramites_historial_tramite_id_tramites_digitales_id_fk"
    FOREIGN KEY ("tramite_id") REFERENCES "public"."tramites_digitales"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "tramites_historial" ADD CONSTRAINT "tramites_historial_usuario_id_users_id_fk"
    FOREIGN KEY ("usuario_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- ── procesamiento_cuentas ──────────────────────────────────────────────────────
-- organismo_codigo y drive_modified_time las agrega 0108 con ADD COLUMN IF NOT EXISTS;
-- se declaran aquí porque el estado final de schema.ts las tiene y 0108 queda en no-op.
CREATE TABLE IF NOT EXISTS "procesamiento_cuentas" (
	"id" serial PRIMARY KEY NOT NULL,
	"usuario_id" integer,
	"drive_file_id" varchar(100),
	"nombre_archivo" varchar(255),
	"total_paginas" integer,
	"cuentas_detectadas" integer,
	"placas_unicas" integer,
	"valor_total" numeric(20, 2),
	"directorio_salida" varchar(255),
	"estado" varchar(20) DEFAULT 'procesando' NOT NULL,
	"error" text,
	"organismo_codigo" varchar(5),
	"drive_modified_time" timestamp with time zone,
	"modificado_por" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "procesamiento_cuentas" ADD CONSTRAINT "procesamiento_cuentas_usuario_id_users_id_fk"
    FOREIGN KEY ("usuario_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
