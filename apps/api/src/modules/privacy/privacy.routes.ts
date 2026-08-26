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
import { purgarDestinatariosDeClientes } from '../siigo/siigo.envio-correo.service.js';
import { purgarDestinatariosDeLotes } from '../siigo/facturacion.lote.repo.js';
import { anonimizarTercerosDeClientes } from '../siigo/siigo.terceros.service.js';
import { hmacCedula, normalizeDocument } from '../../shared/utils/crypto.js';
import { matchDocumentoCompradorJsonb, matchDocumentoNormalizado } from './privacy.match-doc.js';
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
// Cobertura (HU #11334, 2026-08-10): 15 tablas — se suma siigo_factura_envios, que guarda a qué
// direcciones se envió cada factura electrónica. Ahí NO se anonimiza la fila: se REDACTAN las
// direcciones y se conserva el hecho del envío (cuándo, con qué resultado), porque ese hecho es la
// prueba de entrega ante una glosa de la DIAN y no es un dato del titular. La tabla es append-only
// y su disparador solo admite esa transición exacta; ver la migración 0141.
//
// Cobertura (HU #11297, 2026-08-10): 16 tablas — se suma `siigo_terceros`, que guarda la
// identificación del titular EN CLARO porque hace falta para reencontrar su tercero en Siigo. Este
// flujo anonimiza `clients.document` y NO borra la fila del cliente, así que el `ON DELETE CASCADE`
// de esa tabla no alcanzaba: sin esto, la cédula sobreviviría a su propia supresión en una tabla que
// nadie recuerda. Se anonimiza con el MISMO hash que recibe `clients.document`, para que el vínculo
// siga siendo rastreable como pareja.
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
  // Aplica el mismo `normalizeDocument` (solo dígitos) en SQL. La clase es `'[^0-9]'`, no `'\D'`:
  // en `sql\`...\`` `\D` se cocina a `D` y el olvido solo alcanzaría dígitos puros (Bug #11776).
  // Excluye registros ya anonimizados (NOT LIKE 'ANON-%') para idempotencia segura.
  const matchByDoc = (col: Parameters<typeof matchDocumentoNormalizado>[0]) =>
    matchDocumentoNormalizado(col, docNormalized);

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

    // ===== Las direcciones del titular, ANTES de anonimizar nada =====
    //
    // Las purgas del módulo Siigo (pasos 15 y 15b) buscan por dos caminos, y el segundo es la
    // dirección: es el único que alcanza los correos escritos a mano en la factura de OTRA empresa
    // —los que la búsqueda por compañía no ve, porque está indexada por el dueño de la factura y no
    // por el titular del dato—. Ese camino vale exactamente lo que valga esta lista.
    //
    // **Se leen TODAS las tablas donde este mismo flujo reconoce que el titular tiene correo**, no
    // solo su ficha de cliente. El titular que ejerce el derecho puede no ser cliente de nadie —es
    // justo el caso que motiva el segundo camino— y entonces `clients` no devuelve ni una fila: la
    // rama por dirección se apagaba entera y sus direcciones sobrevivían en las dos tablas del
    // módulo mientras el resumen decía que se le había olvidado. Que este flujo anonimice el correo
    // de esas otras tablas (pasos 5, 6, 9, 13, 14 y 15) y a la vez no lo use para buscar era la
    // contradicción: se reconocía el dato como suyo para borrarlo aquí y no para alcanzarlo allá.
    //
    // **El orden no es estilo, es la corrección entera.** `matchByDoc` compara contra el documento
    // CRUDO y excluye `NOT LIKE 'ANON-%'`; en cuanto cada UPDATE escribe `docHash`, ese mismo SELECT
    // devuelve cero filas. Capturar debajo de cualquiera de esos UPDATE es capturar nada, y no se
    // nota: el resumen no cambia ni una cifra porque la rama por compañía sigue devolviendo lo suyo.
    // Por eso van todas aquí arriba, juntas, y hay un caso de prueba por cada tabla.
    const fichaDelTitular = await tx.select({
      email: clients.email, contactEmail: clients.contactEmail,
    }).from(clients).where(matchByDoc(clients.document));

    const correosLaft = await tx.select({ email: laftCounterparties.email })
      .from(laftCounterparties).where(matchByDoc(laftCounterparties.docNumber));
    const correosValidaciones = await tx.select({ email: tramitesValidaciones.email })
      .from(tramitesValidaciones).where(matchByDoc(tramitesValidaciones.documento));
    const correosTenedores = await tx.select({ email: tenedores.email })
      .from(tenedores).where(matchByDoc(tenedores.documento));
    const correosPropietarios = await tx.select({ email: propietariosCarga.email })
      .from(propietariosCarga).where(matchByDoc(propietariosCarga.documento));
    const correosDestinatarios = await tx.select({ email: destinatariosCarga.email })
      .from(destinatariosCarga).where(matchByDoc(destinatariosCarga.documento));

    // El comprador del trámite digital vive en JSONB, con el mismo filtro que usa su UPDATE (paso 5).
    const correosComprador = await tx.execute(sql`
      SELECT comprador->>'email' AS email
        FROM tramites_digitales
       WHERE ${matchDocumentoCompradorJsonb(docNormalized)}
    `) as unknown as Array<{ email: string | null }>;

    // `correosDeBusqueda` normaliza y descarta vacíos y repetidos al otro lado; aquí basta con no
    // colar nulos ni cadenas en blanco. Con la lista vacía las dos purgas dejan el predicado por
    // dirección en `false` —nunca en «todo»—, que es lo que impide que un titular sin ningún correo
    // convierta el olvido en una purga sin criterio.
    const correosDelTitular = [
      ...fichaDelTitular.flatMap((c) => [c.email, c.contactEmail]),
      ...correosLaft.map((r) => r.email),
      ...correosValidaciones.map((r) => r.email),
      ...correosTenedores.map((r) => r.email),
      ...correosPropietarios.map((r) => r.email),
      ...correosDestinatarios.map((r) => r.email),
      ...correosComprador.map((r) => r.email),
    ].filter((c): c is string => typeof c === 'string' && c.trim() !== '');

    // 1. clients: por documento
    const cli = await tx.update(clients).set({
      name: ANON_NAME,
      email: ANON_EMAIL,
      phone: ANON_PHONE,
      address: ANON_ADDRESS,
      document: docHash,
      notes: null,
      // Datos fiscales de Siigo (HU #11292): el nombre comercial y el contacto son datos
      // personales igual que los de arriba. Olvidarlos aquí dejaría el correo y el teléfono de
      // una persona en columnas nuevas mientras el resto de su ficha queda anonimizada — el
      // borrado sería aparente, y esa es exactamente la falla que la Ley 1581 castiga.
      // Los códigos fiscales (`personType`, `idType`, ciudad, sucursal) NO se tocan: no
      // identifican a nadie por sí solos y borrarlos rompería la trazabilidad contable.
      commercialName: null,
      contactFirstName: null,
      contactLastName: null,
      contactEmail: null,
      phoneIndicative: null,
      phoneNumber: null,
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
      WHERE ${matchDocumentoCompradorJsonb(docNormalized)}
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
    }).where(matchByDoc(manifiestos.titularPagoDoc)).returning({ id: manifiestos.id });
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

    // 15. siigo_factura_envios: se redactan las direcciones, se conserva el acta. Se busca por la
    // compañía Y por la dirección: solo por compañía quedarían fuera las actas de trámites sin
    // empresa resuelta y los destinatarios escritos a mano en facturas de terceros.
    stats.siigo_factura_envios = await purgarDestinatariosDeClientes(
      cli.map((c) => c.id), correosDelTitular, tx,
    );

    // 15b. siigo_lotes_facturacion: las direcciones ELEGIDAS al enviar (HU #11708). Desde esa
    // historia el lote puede guardar direcciones para que la emisión —que ocurre después y en otro
    // proceso— sepa a quién mandar la factura. Es el segundo sitio del módulo con datos personales y
    // el olvido tiene que alcanzarlo: una copia fuera de la purga convertiría esta respuesta en
    // mentira. Se busca igual que las actas, por compañía Y por dirección.
    stats.siigo_lotes_facturacion = await purgarDestinatariosDeLotes(
      cli.map((c) => c.id), correosDelTitular, tx,
    );

    // 16. siigo_terceros: la identificación del titular, en la tabla del vínculo con Siigo.
    stats.siigo_terceros = await anonimizarTercerosDeClientes(cli.map((c) => c.id), docHash, tx);

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
  // Una sola definición (`matchDocumentoNormalizado`): si preview y forget divergieran, uno
  // contaría filas que el otro no anonimiza (Bug #11776).
  const matchByDocPreview = (col: Parameters<typeof matchDocumentoNormalizado>[0]) =>
    matchDocumentoNormalizado(col, docNormalized);

  // Conteos paralelos por tabla (14 SELECT count).
  const [cli, veh, soat, tram, cp, bo, drv, trv, man, ten, prop, dest] = await Promise.all([
    db.select({ c: sql<number>`count(*)::int` }).from(clients).where(matchByDocPreview(clients.document)),
    db.select({ c: sql<number>`count(*)::int` }).from(vehicles).where(matchByDocPreview(vehicles.ownerDocument)),
    db.execute(sql`SELECT count(*)::int AS c FROM soat_requests s INNER JOIN vehicles v ON s.vehicle_id = v.id WHERE ${matchDocumentoNormalizado(sql`v.owner_document`, docNormalized)}`),
    db.execute(sql`SELECT count(*)::int AS c FROM tramites_digitales WHERE ${matchDocumentoCompradorJsonb(docNormalized)}`),
    db.select({ c: sql<number>`count(*)::int` }).from(laftCounterparties).where(matchByDocPreview(laftCounterparties.docNumber)),
    db.select({ c: sql<number>`count(*)::int` }).from(laftBeneficialOwners).where(matchByDocPreview(laftBeneficialOwners.docNumber)),
    db.select({ c: sql<number>`count(*)::int` }).from(driverProfile).where(eq(driverProfile.cedulaHash, docHashHmac)),
    db.select({ c: sql<number>`count(*)::int` }).from(tramitesValidaciones).where(matchByDocPreview(tramitesValidaciones.documento)),
    db.select({ c: sql<number>`count(*)::int` }).from(manifiestos).where(matchByDocPreview(manifiestos.titularPagoDoc)),
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
