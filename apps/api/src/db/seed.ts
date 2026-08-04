import { sql } from 'drizzle-orm';
import { db } from './client.js';
import { users } from './schema.js';
import argon2 from 'argon2';

async function seed() {
  console.log('Seeding database...');

  const passwordHash = await argon2.hash('Admin2026!');

  await db.insert(users).values({
    username: 'admin',
    name: 'Johan Jimenez',
    email: 'info@kyverum.com',
    passwordHash,
    role: 'admin',
  }).onConflictDoNothing();

  console.log('Admin user created: info@kyverum.com / Admin2026!');

  // Políticas de retención LAFT (Ley 1121/2006, Circular UIAF, Resolución UIAF 122/2021).
  // Vivían en la migración 0067 con created_by=1 hardcodeado, lo que reventaba en una BD
  // limpia: las migraciones corren antes de que exista ningún usuario. El dato referencia
  // a users, así que su lugar es el seed, después de crear el admin. Idempotente.
  const [admin] = await db.select({ id: users.id }).from(users).orderBy(users.id).limit(1);
  if (admin) {
    await db.execute(sql`
      INSERT INTO pesv_retencion_politicas
        (tipo_documento, retencion_anios, base_legal, accion, habilitado, notas_md, created_by)
      SELECT * FROM (VALUES
        ('laft_counterparty'::varchar(60), 10::smallint,
         'Ley 1121/2006 + Circular UIAF — SARLAFT'::varchar(200),
         'anonimizar'::pesv_retencion_accion, true,
         'Anonimiza PII (nombre, doc, email, phone) preservando id+riesgo+timestamps para reportería histórica.'::text,
         ${admin.id}::integer),
        ('laft_cash_txn'::varchar(60), 10::smallint,
         'Circular UIAF + Decreto 1497/2002 — SARLAFT'::varchar(200),
         'anonimizar'::pesv_retencion_accion, true,
         'Anonimiza datos del titular en transacciones en efectivo. Mantiene monto/fecha para indicadores agregados.'::text,
         ${admin.id}::integer),
        ('laft_ros_draft'::varchar(60), 10::smallint,
         'Resolución UIAF 122/2021 — Archivo SIREL'::varchar(200),
         'archivar_offline'::pesv_retencion_accion, true,
         'Borrador ROS no se anonimiza — se archiva offline. Investigación UIAF puede requerir consulta posterior.'::text,
         ${admin.id}::integer)
      ) AS v(tipo_documento, retencion_anios, base_legal, accion, habilitado, notas_md, created_by)
      ON CONFLICT (tipo_documento) DO NOTHING
    `);
    console.log('Políticas de retención LAFT sembradas (3).');
  }

  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
