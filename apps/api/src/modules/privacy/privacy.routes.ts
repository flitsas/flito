import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, inArray, sql } from 'drizzle-orm';
import rateLimit from 'express-rate-limit';
import { db } from '../../db/client.js';
import {
  clients, vehicles, soatRequests,
  laftCounterparties, laftBeneficialOwners,
  driverProfile, tramitesValidaciones, alcoholTests, roadIncidents,
  manifiestos, tenedores, propietariosCarga, destinatariosCarga,
} from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { userOrIpKey } from '../../shared/middleware/rateLimiter.js';
import { audit } from '../../shared/middleware/audit.js';
import { hmacCedula, normalizeDocument } from '../../shared/utils/crypto.js';
import { deletePhoto } from '../../services/storage.js';
import { logger } from '../../shared/logger.js';
import crypto from 'crypto';

const router = Router();
router.use(authMiddleware, requireRole('admin', 'compliance'));
const log = logger.child({ component: 'privacy-forget' });

// Preview es read-only pero expone existencia de docs en BD — limit estricto contra enumeración.
const previewLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('priv-preview'),
  message: { error: 'Demasiadas consultas de preview, espere 1 minuto' },
});

// Forget es operación destructiva crítica — solo admin (compliance puede previsualizar pero no ejecutar).
// Rate limit muy estricto: 10 anonimizaciones por hora por usuario.
const forgetLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('priv-forget'),
  message: { error: 'Demasiadas anonimizaciones, máximo 10 por hora' },
});

// Endpoint para ejercer el derecho al olvido (Ley 1581 Colombia, art. 16, decreto 1377/2013).
//
// IMPORTANTE: NO borra los registros — los anonimiza.
// Razones:
//  1. Auditoría LAFT exige conservación 5 años (sección 16 de la política, ISO 27001 A.8.34).
//  2. Trazabilidad de SOAT y trámites de tránsito requiere historial vehículo.
//  3. Los audit logs son append-only (REVOKE UPDATE/DELETE en BD) y no pueden modificarse.
//
// Lo que hace: reemplaza nombre, email, teléfono, dirección con valores tipo "[ANONIMIZADO]"
// y un hash determinístico del doc original para mantener relaciones referenciales.
//
// Cobertura (Ola D 2026-05-06): 14 tablas — clients, vehicles, soat_requests, tramites_digitales,
// laft_counterparties, laft_beneficial_owners, driver_profile, tramites_validaciones, alcohol_tests,
// road_incidents, manifiestos (titular_pago_*), tenedores, propietarios_carga, destinatarios_carga.
// Borra adicionalmente objetos S3 asociados (foto_storage_key, foto_rostro/cedula_*, foto_evidencia_keys, fotos_keys).

const requestSchema = z.object({
  docNumber: z.string().min(3).max(20),
  reason: z.string().min(10).max(500),
});

const ANON_NAME = '[ANONIMIZADO - LEY 1581]';
const ANON_EMAIL = null;
const ANON_PHONE = null;
const ANON_ADDRESS = null;

function hashDoc(doc: string): string {
  // Hash determinístico del documento — preserva relaciones para auditoría sin exponer doc original.
  return 'ANON-' + crypto.createHash('sha256').update(doc.toUpperCase()).digest('hex').slice(0, 16);
}

// Solo admin ejecuta forget; compliance puede revisar pero no anonimizar (segregation of duties).
router.post('/forget', forgetLimiter, requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const { docNumber, reason } = parsed.data;
  const docUpper = docNumber.toUpperCase().trim();
  const docHash = hashDoc(docUpper);
  const docNormalized = normalizeDocument(docUpper);
  const docHashHmac = hmacCedula(docNormalized); // Buffer 32 bytes — match para driver_profile.cedula_hash

  // Helper: match por documento aceptando cualquier formato de escritura ("1.036.640.908", " 1036640908 ", "CC1036640908").
  // Aplica el mismo `normalizeDocument` (solo dígitos) en SQL para no fallar silenciosamente el derecho al olvido.
  // Excluye registros ya anonimizados (NOT LIKE 'ANON-%') para idempotencia segura.
  const matchByDoc = (col: any) => sql`regexp_replace(${col}, '\D', '', 'g') = ${docNormalized} AND ${col} NOT LIKE 'ANON-%'`;

  // ===== Pre-tx: capturar driverUserIds + S3 keys (necesarios para tx en alcohol/incidents y para cleanup). =====
  const driverRows = await db.select({
    userId: driverProfile.userId,
    fotoStorageKey: driverProfile.fotoStorageKey,
  }).from(driverProfile).where(eq(driverProfile.cedulaHash, docHashHmac));
  const driverUserIds = driverRows.map((r) => r.userId);

  const tramitesPhotos = await db.select({
    rostro: tramitesValidaciones.fotoRostro,
    frontal: tramitesValidaciones.fotoCedulaFrontal,
    reverso: tramitesValidaciones.fotoCedulaReverso,
  }).from(tramitesValidaciones).where(matchByDoc(tramitesValidaciones.documento));

  let alcoholKeysFlat: string[] = [];
  let incidentKeysFlat: string[] = [];
  if (driverUserIds.length > 0) {
    const alcRows = await db.select({ keys: alcoholTests.fotoEvidenciaKeys })
      .from(alcoholTests).where(inArray(alcoholTests.conductorId, driverUserIds));
    alcoholKeysFlat = alcRows.flatMap((r) => r.keys ?? []);

    const incRows = await db.select({ keys: roadIncidents.fotosKeys })
      .from(roadIncidents).where(inArray(roadIncidents.conductorId, driverUserIds));
    incidentKeysFlat = incRows.flatMap((r) => r.keys ?? []);
  }

  // ===== S3 cleanup best-effort (fuera de tx — Drizzle no rollback de S3). =====
  // Tolerar fallos individuales: log.warn y seguir, igual que retention.cron.ts. La fila sigue
  // anonimizada en BD aunque queden objetos huérfanos en MinIO (la lifecycle 120d los recoge).
  const allKeys: string[] = [
    ...driverRows.map((r) => r.fotoStorageKey).filter((k): k is string => !!k),
    ...tramitesPhotos.flatMap((p) => [p.rostro, p.frontal, p.reverso]).filter((k): k is string => !!k),
    ...alcoholKeysFlat,
    ...incidentKeysFlat,
  ];
  let s3Deleted = 0;
  let s3Failed = 0;
  for (const key of allKeys) {
    // Solo intentar borrar si parece una key S3 (no base64 legacy, no encrypted legacy).
    if (key && /^[a-z]+\//.test(key) && !key.includes(':')) {
      try { await deletePhoto(key); s3Deleted++; }
      catch (e) { s3Failed++; log.warn({ key, err: (e as Error).message }, 'forget: deletePhoto falló (continúa)'); }
    }
  }

  // ===== Transacción: anonimización BD =====
  const summary = await db.transaction(async (tx) => {
    const stats: Record<string, number> = {};

    // 1. clients: por documento
    const cli = await tx.update(clients).set({
      name: ANON_NAME,
      email: ANON_EMAIL,
      phone: ANON_PHONE,
      address: ANON_ADDRESS,
      document: docHash,
      notes: null,
    }).where(matchByDoc(clients.document)).returning({ id: clients.id });
    stats.clients = cli.length;

    // 2. vehicles: capturar IDs ANTES de anonimizar para usarlos en soat_requests.
    const affectedVehicles = await tx.select({ id: vehicles.id }).from(vehicles).where(matchByDoc(vehicles.ownerDocument));
    const vehicleIds = affectedVehicles.map((v) => v.id);

    // 3. soat_requests: anonimizamos el campo string `soat_holder` para los vehicles afectados.
    if (vehicleIds.length > 0) {
      const soat = await tx.update(soatRequests).set({
        soatHolder: ANON_NAME,
      }).where(inArray(soatRequests.vehicleId, vehicleIds)).returning({ id: soatRequests.id });
      stats.soat_requests = soat.length;
    } else {
      stats.soat_requests = 0;
    }

    // 4. vehicles: anonimizar después de capturar IDs.
    const veh = await tx.update(vehicles).set({
      ownerName: ANON_NAME,
      ownerDocument: docHash,
    }).where(matchByDoc(vehicles.ownerDocument)).returning({ id: vehicles.id });
    stats.vehicles = veh.length;

    // 5. tramites_digitales: comprador es JSONB con campos PII anidados. Match por documento normalizado.
    const tram = await tx.execute(sql`
      UPDATE tramites_digitales
      SET comprador = jsonb_set(
            jsonb_set(
              jsonb_set(
                jsonb_set(
                  COALESCE(comprador, '{}'::jsonb),
                  '{nombre}', to_jsonb(${ANON_NAME}::text)
                ),
                '{documento}', to_jsonb(${docHash}::text)
              ),
              '{email}', 'null'::jsonb
            ),
            '{telefono}', 'null'::jsonb
          )
      WHERE regexp_replace(comprador->>'documento', '\D', '', 'g') = ${docNormalized}
        AND (comprador->>'documento') NOT LIKE 'ANON-%'
      RETURNING id
    `);
    stats.tramites_digitales = (tram as unknown as Array<unknown>).length;

    // 6. laft_counterparties: doc_number directo
    const cp = await tx.update(laftCounterparties).set({
      fullName: ANON_NAME,
      email: null,
      phone: null,
      address: null,
      docNumber: docHash,
      fundOrigin: '[ANONIMIZADO]',
      pepRole: null,
      pepKinship: null,
    }).where(matchByDoc(laftCounterparties.docNumber)).returning({ id: laftCounterparties.id });
    stats.laft_counterparties = cp.length;

    // 7. laft_beneficial_owners: doc_number
    const bo = await tx.update(laftBeneficialOwners).set({
      fullName: ANON_NAME,
      docNumber: docHash,
    }).where(matchByDoc(laftBeneficialOwners.docNumber)).returning({ id: laftBeneficialOwners.id });
    stats.laft_beneficial_owners = bo.length;

    // ===== Ola D (2026-05-06): tablas adicionales =====

    // 8. driver_profile: match por cedula_hash (HMAC). Anonimiza cipher+legacy+hash+licencia+runt+foto.
    if (driverUserIds.length > 0) {
      const drv = await tx.update(driverProfile).set({
        cedulaCipher: null,
        cedulaIv: null,
        cedulaAuthTag: null,
        cedulaAadNonce: null,
        cedulaKeyVersion: null,
        cedulaHash: null,
        licenciaNumeroCipher: null,
        licenciaNumeroIv: null,
        licenciaNumeroAuthTag: null,
        licenciaNumeroAadNonce: null,
        licenciaNumeroKeyVersion: null,
        runtPayloadCipher: null,
        runtPayloadIv: null,
        runtPayloadAuthTag: null,
        runtPayloadAadNonce: null,
        runtPayloadKeyVersion: null,
        fotoStorageKey: null,
      }).where(inArray(driverProfile.userId, driverUserIds)).returning({ userId: driverProfile.userId });
      stats.driver_profile = drv.length;
    } else {
      stats.driver_profile = 0;
    }

    // 9. tramites_validaciones: PII de identidad capturada durante validación (selfie + cédula).
    const trv = await tx.update(tramitesValidaciones).set({
      nombre: ANON_NAME,
      documento: docHash,
      email: null,
      fotoRostro: null,
      fotoCedulaFrontal: null,
      fotoCedulaReverso: null,
      ipAddress: null,
      lat: null,
      lng: null,
      userAgent: null,
    }).where(matchByDoc(tramitesValidaciones.documento)).returning({ id: tramitesValidaciones.id });
    stats.tramites_validaciones = trv.length;

    // 10. alcohol_tests: solo limpia foto_evidencia_keys; el conductor ya quedó anonimizado en driver_profile.
    if (driverUserIds.length > 0) {
      const alc = await tx.update(alcoholTests).set({
        fotoEvidenciaKeys: sql`'{}'::text[]`,
      }).where(inArray(alcoholTests.conductorId, driverUserIds)).returning({ id: alcoholTests.id });
      stats.alcohol_tests = alc.length;
    } else {
      stats.alcohol_tests = 0;
    }

    // 11. road_incidents: descripción puede mencionar PII libre, fotos contienen rostros, conductor_id apunta al usuario.
    if (driverUserIds.length > 0) {
      const inc = await tx.update(roadIncidents).set({
        conductorId: null,
        fotosKeys: sql`'{}'::text[]`,
        descripcion: null,
      }).where(inArray(roadIncidents.conductorId, driverUserIds)).returning({ id: roadIncidents.id });
      stats.road_incidents = inc.length;
    } else {
      stats.road_incidents = 0;
    }

    // 12. manifiestos: titular_pago_doc/nombre + cuenta cifrada (Ola C-1).
    const man = await tx.update(manifiestos).set({
      titularPagoDoc: docHash,
      titularPagoNombre: ANON_NAME,
      titularPagoCuentaCipher: null,
      titularPagoCuentaIv: null,
      titularPagoCuentaAuthTag: null,
      titularPagoCuentaAadNonce: null,
      titularPagoCuentaKeyVersion: null,
    }).where(sql`regexp_replace(${manifiestos.titularPagoDoc}, '\D', '', 'g') = ${docNormalized} AND ${manifiestos.titularPagoDoc} NOT LIKE 'ANON-%'`).returning({ id: manifiestos.id });
    stats.manifiestos = man.length;

    // 13. tenedores: documento + nombre + dirección + telefono + email + notas.
    const ten = await tx.update(tenedores).set({
      documento: docHash,
      nombre: ANON_NAME,
      direccion: null,
      telefono: null,
      email: null,
      notas: null,
    }).where(matchByDoc(tenedores.documento)).returning({ id: tenedores.id });
    stats.tenedores = ten.length;

    // 14. propietarios_carga
    const prop = await tx.update(propietariosCarga).set({
      documento: docHash,
      nombre: ANON_NAME,
      direccion: null,
      telefono: null,
      email: null,
      notas: null,
    }).where(matchByDoc(propietariosCarga.documento)).returning({ id: propietariosCarga.id });
    stats.propietarios_carga = prop.length;

    // 15. destinatarios_carga
    const dest = await tx.update(destinatariosCarga).set({
      documento: docHash,
      nombre: ANON_NAME,
      direccion: null,
      telefono: null,
      email: null,
      notas: null,
    }).where(matchByDoc(destinatariosCarga.documento)).returning({ id: destinatariosCarga.id });
    stats.destinatarios_carga = dest.length;

    return stats;
  });

  const totalAffected = Object.values(summary).reduce((a, b) => a + b, 0);
  const tablesAffected = Object.entries(summary).filter(([, n]) => n > 0).map(([t]) => t).join(',');

  await audit(req, {
    action: 'delete', // mejor 'export' o 'update' — Drizzle enum acepta ambas. 'delete' refleja la intención legal.
    resource: 'pii_erasure',
    resourceId: docHash,
    detail: `Anonimización Ley 1581: doc ${docNumber.slice(0, 2)}***${docNumber.slice(-2)}, motivo: ${reason.slice(0, 200)}, afectados: ${totalAffected}, tablas: [${tablesAffected}], s3_deleted: ${s3Deleted}/${allKeys.length}, s3_failed: ${s3Failed}`,
  });

  res.json({
    ok: true,
    docHash,
    summary,
    totalAffected,
    s3Deleted,
    s3Failed,
    s3Total: allKeys.length,
    note: 'Los registros fueron anonimizados (no eliminados) para preservar auditoría LAFT/ISO 27001. Audit logs y otros campos no-PII se mantienen intactos.',
  });
});

// Endpoint de consulta previa: ¿qué se afectaría si se anonimiza este documento?
router.get('/preview/:docNumber', previewLimiter, async (req: Request, res: Response) => {
  const docUpper = req.params.docNumber.toUpperCase().trim();
  if (docUpper.length < 3 || docUpper.length > 20) { res.status(400).json({ error: 'Documento inválido' }); return; }

  const docNormalized = normalizeDocument(docUpper);
  const docHashHmac = hmacCedula(docNormalized);

  // Mismo helper que en POST /forget — match por documento normalizado, excluye ya anonimizados.
  const matchByDocPreview = (col: any) => sql`regexp_replace(${col}, '\D', '', 'g') = ${docNormalized} AND ${col} NOT LIKE 'ANON-%'`;

  // Conteos paralelos por tabla (14 SELECT count).
  const [cli, veh, soat, tram, cp, bo, drv, trv, man, ten, prop, dest] = await Promise.all([
    db.select({ c: sql<number>`count(*)::int` }).from(clients).where(matchByDocPreview(clients.document)),
    db.select({ c: sql<number>`count(*)::int` }).from(vehicles).where(matchByDocPreview(vehicles.ownerDocument)),
    db.execute(sql`SELECT count(*)::int AS c FROM soat_requests s INNER JOIN vehicles v ON s.vehicle_id = v.id WHERE regexp_replace(v.owner_document, '\D', '', 'g') = ${docNormalized} AND v.owner_document NOT LIKE 'ANON-%'`),
    db.execute(sql`SELECT count(*)::int AS c FROM tramites_digitales WHERE regexp_replace(comprador->>'documento', '\D', '', 'g') = ${docNormalized} AND (comprador->>'documento') NOT LIKE 'ANON-%'`),
    db.select({ c: sql<number>`count(*)::int` }).from(laftCounterparties).where(matchByDocPreview(laftCounterparties.docNumber)),
    db.select({ c: sql<number>`count(*)::int` }).from(laftBeneficialOwners).where(matchByDocPreview(laftBeneficialOwners.docNumber)),
    db.select({ c: sql<number>`count(*)::int` }).from(driverProfile).where(eq(driverProfile.cedulaHash, docHashHmac)),
    db.select({ c: sql<number>`count(*)::int` }).from(tramitesValidaciones).where(matchByDocPreview(tramitesValidaciones.documento)),
    db.select({ c: sql<number>`count(*)::int` }).from(manifiestos).where(sql`regexp_replace(${manifiestos.titularPagoDoc}, '\D', '', 'g') = ${docNormalized} AND ${manifiestos.titularPagoDoc} NOT LIKE 'ANON-%'`),
    db.select({ c: sql<number>`count(*)::int` }).from(tenedores).where(matchByDocPreview(tenedores.documento)),
    db.select({ c: sql<number>`count(*)::int` }).from(propietariosCarga).where(matchByDocPreview(propietariosCarga.documento)),
    db.select({ c: sql<number>`count(*)::int` }).from(destinatariosCarga).where(matchByDocPreview(destinatariosCarga.documento)),
  ]);

  const tramRow = (tram as unknown as Array<{ c: number }>)[0];
  const soatRow = (soat as unknown as Array<{ c: number }>)[0];

  // alcohol_tests y road_incidents dependen de driverUserIds resolvidos en runtime — solo conteo si match.
  let alcoholCount = 0;
  let incidentsCount = 0;
  if ((drv[0]?.c ?? 0) > 0) {
    const driverUserIds = await db.select({ userId: driverProfile.userId })
      .from(driverProfile).where(eq(driverProfile.cedulaHash, docHashHmac));
    const ids = driverUserIds.map((r) => r.userId);
    if (ids.length > 0) {
      const [a, i] = await Promise.all([
        db.select({ c: sql<number>`count(*)::int` }).from(alcoholTests).where(inArray(alcoholTests.conductorId, ids)),
        db.select({ c: sql<number>`count(*)::int` }).from(roadIncidents).where(inArray(roadIncidents.conductorId, ids)),
      ]);
      alcoholCount = a[0]?.c ?? 0;
      incidentsCount = i[0]?.c ?? 0;
    }
  }

  res.json({
    docNumber: docUpper,
    affected: {
      clients: cli[0]?.c ?? 0,
      vehicles: veh[0]?.c ?? 0,
      soat_requests: soatRow?.c ?? 0,
      tramites_digitales: tramRow?.c ?? 0,
      laft_counterparties: cp[0]?.c ?? 0,
      laft_beneficial_owners: bo[0]?.c ?? 0,
      driver_profile: drv[0]?.c ?? 0,
      tramites_validaciones: trv[0]?.c ?? 0,
      alcohol_tests: alcoholCount,
      road_incidents: incidentsCount,
      manifiestos: man[0]?.c ?? 0,
      tenedores: ten[0]?.c ?? 0,
      propietarios_carga: prop[0]?.c ?? 0,
      destinatarios_carga: dest[0]?.c ?? 0,
    },
  });
});

export default router;
