import 'express-async-errors';
import express from 'express';
import crypto from 'crypto';
import cors from 'cors';
import helmet from 'helmet';
import { sql } from 'drizzle-orm';
import { env, corsOrigins } from './config/env.js';
import { db, getPoolStats } from './db/client.js';
import { errorHandler } from './shared/middleware/errorHandler.js';
import { registry } from './shared/metrics.js';
import { apiLimiter, authLimiter } from './shared/middleware/rateLimiter.js';
import authRoutes from './modules/auth/auth.routes.js';
import usersRoutes from './modules/users/users.routes.js';
import vehiclesRoutes from './modules/vehicles/vehicles.routes.js';
import soatRoutes from './modules/soat/soat.routes.js';
import runtRoutes from './modules/runt/runt.routes.js';
import integracionesRoutes from './modules/integraciones/integraciones.routes.js';
import ocrRoutes from './modules/vehicles/ocr.routes.js';
import clientsRoutes from './modules/clients/clients.routes.js';
import flitoParametrizacionRoutes from './modules/flito-parametrizacion/flito-parametrizacion.routes.js';
import flitoSyncRoutes from './modules/flito-sync/flito-sync.routes.js';
import flitoDemoRoutes from './modules/flito-demo/flito-demo.routes.js';
import batchRoutes from './modules/soat/batch.routes.js';
import tramitesRoutes from './modules/tramites/tramites.routes.js';
import identidadRoutes from './modules/tramites/identidad.routes.js';
import ocrDocsRoutes from './modules/tramites/ocr-docs.routes.js';
import transitoRoutes from './modules/tramites/transito.routes.js';
import transitoConfigRoutes from './modules/tramites/transito-config.routes.js';
import tramiteVerifyPublicRoutes from './modules/tramites/verify.public.routes.js';
import tramitePortalPublicRoutes from './modules/tramites/portal.public.routes.js';
import firmaRoutes from './modules/firma/firma.routes.js';
import firmaWebhookRoutes from './modules/firma/webhook.routes.js';
import driveRoutes from './modules/drive/drive.routes.js';
import procesadorRoutes, { publicRouter as procesadorPublicRoutes } from './modules/drive/procesador.routes.js';
import rumRoutes from './modules/rum/rum.routes.js';
import laftCounterpartiesRoutes from './modules/laft/counterparties.routes.js';
import laftAuditRoutes from './modules/laft/audit.routes.js';
import laftListsRoutes from './modules/laft/lists.routes.js';
import laftUnusualRoutes from './modules/laft/unusual.routes.js';
import laftRosRoutes from './modules/laft/ros.routes.js';
import laftRosExportRoutes from './modules/laft/sirel/ros-export.routes.js';
import laftTrainingsRoutes from './modules/laft/trainings.routes.js';
import laftEmployeesRoutes from './modules/laft/employees/employees.routes.js';
import laftSyncRoutes from './modules/laft/sync/sync.routes.js';
import laftManualRoutes from './modules/laft/manual/manual.routes.js';
import laftOfficerRoutes from './modules/laft/officer/officer.routes.js';
import laftAuditPlanRoutes from './modules/laft/audit-plan/audit-plan.routes.js';
import laftDashboardRoutes from './modules/laft/dashboard/dashboard.routes.js';
import laftRetencionRoutes from './modules/laft/retencion/retencion.routes.js';
import laftCashRoutes from './modules/laft/cash/cash.routes.js';
import laftRteRoutes from './modules/laft/cash/rte.routes.js';
import laftArosRoutes from './modules/laft/cash/aros.routes.js';
import privacyRoutes from './modules/privacy/privacy.routes.js';
import fleetVehiclesRoutes from './modules/fleet/vehicles.routes.js';
import fleetLinksRoutes from './modules/fleet/links.routes.js';
import fleetMeasurementsRoutes from './modules/fleet/measurements.routes.js';
import fleetDocumentsRoutes from './modules/fleet/documents.routes.js';
import maintCatalogRoutes from './modules/maintenance/catalog.routes.js';
import maintPartsRoutes from './modules/maintenance/parts.routes.js';
import maintRoutinesRoutes from './modules/maintenance/routines.routes.js';
import maintScheduleRoutes from './modules/maintenance/schedule.routes.js';
import maintPreOrdersRoutes from './modules/maintenance/preorders.routes.js';
import maintWorkOrdersRoutes from './modules/maintenance/workorders.routes.js';
import maintIndicatorsRoutes from './modules/maintenance/indicators.routes.js';
import liquidacionRoutes from './modules/liquidacion/liquidacion.routes.js';
import driversRoutes from './modules/drivers/drivers.routes.js';
import driverDocumentsRoutes from './modules/drivers/documents.routes.js';
import driverTrainingsRoutes from './modules/drivers/trainings.routes.js';
import driverIncidentsRoutes from './modules/drivers/incidents.routes.js';
import pesvIndicatorsRoutes from './modules/drivers/indicators.routes.js';
import driverChecklistsRoutes from './modules/drivers/checklists.routes.js';
import driverAlcoholRoutes from './modules/drivers/alcohol.routes.js';
import driverEmergencyRoutes from './modules/drivers/emergency.routes.js';
import driverOpIndicatorsRoutes from './modules/drivers/operational-indicators.routes.js';
import rndcCatalogosRoutes from './modules/rndc/catalogos.routes.js';
import rndcMaestrosRoutes from './modules/rndc/maestros.routes.js';
import rndcRemesasRoutes from './modules/rndc/remesas.routes.js';
import rndcManifiestosRoutes from './modules/rndc/manifiestos.routes.js';
import rndcIndicadoresRoutes from './modules/rndc/indicadores.routes.js';
import rndcQrPublicRoutes from './modules/rndc/qr.routes.js';
import rndcCredencialesRoutes from './modules/rndc/credenciales.routes.js';
import rndcPdfRoutes from './modules/rndc/pdf.routes.js';
import pesvPolicyRoutes from './modules/pesv/policy.routes.js';
import pesvComiteRoutes from './modules/pesv/comite.routes.js';
import pesvPlanRoutes from './modules/pesv/plan.routes.js';
import pesvDiagnosticoRoutes, { estandaresRouter as pesvEstandaresRoutes } from './modules/pesv/diagnostico.routes.js';
import pesvTableroRoutes from './modules/pesv/tablero.routes.js';
import pesvExportRoutes from './modules/pesv/export.routes.js';
import pesvHuerfanosRoutes from './modules/pesv/huerfanos.routes.js';
import pesvRaciRoutes from './modules/pesv/raci.routes.js';
import pesvNormativaRoutes from './modules/pesv/normativa.routes.js';
import pesvRetencionRoutes from './modules/pesv/retencion.routes.js';
import piiAccessRoutes from './modules/privacy/pii-access.routes.js';
import jornadasRoutes from './modules/jornadas/jornadas.routes.js';
import rutasRoutes from './modules/rutas/routes.routes.js';
import rutasRiskRoutes from './modules/rutas/risk.routes.js';
import rutasPernoctaRoutes from './modules/rutas/pernocta.routes.js';

export function createApp() {
  const app = express();

  // Trust proxy (behind Nginx)
  app.set('trust proxy', 1);

  // ISO 27001 A.8.9 — Security headers
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }));

  // S6: CORS restringido. En producción superRefine(env) bloquea '*'. Aquí: whitelist explícita.
  // Pattern estándar de librería `cors`: cb(null, false) si no autorizado — la respuesta sale
  // sin headers Access-Control-* y el navegador bloquea silenciosamente. Evita 500s ruidosos.
  app.use(cors({
    origin: (origin, cb) => {
      // Permite requests same-origin (sin header Origin) y herramientas tipo curl/Postman.
      if (!origin) return cb(null, true);
      if (corsOrigins.includes(origin)) return cb(null, true);
      // En dev permitimos '*' explícito para localhost.
      if (env.NODE_ENV !== 'production' && corsOrigins.includes('*')) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  }));

  // F6: Limite mayor para validacion biometrica (3 fotos base64) — debe ir ANTES del global
  app.use('/api/validacion-identidad/completar', express.json({ limit: '15mb' }));
  // TRAM-INNOV-B3: el webhook de firma necesita el body RAW para validar HMAC.
  app.use('/api/webhooks/firma', express.raw({ type: '*/*', limit: '2mb' }));
  app.use(express.json({ limit: '5mb' }));

  // Request ID for traceability (ISO 27001 A.8.15)
  app.use((req, _res, next) => {
    req.headers['x-request-id'] = req.headers['x-request-id'] || crypto.randomUUID();
    next();
  });

  // ISO 27001 A.8.6 — Rate limiting (capacity management)
  app.use('/api/auth/login', authLimiter);
  app.use('/api', apiLimiter);

  // Routes
  app.use('/api/rum', rumRoutes); // RUM Web Vitals — público (se reporta pre-login)
  app.use('/api/auth', authRoutes);
  app.use('/api/users', usersRoutes);
  app.use('/api/vehicles', vehiclesRoutes);
  app.use('/api/soat', soatRoutes);
  app.use('/api/runt', runtRoutes);
  app.use('/api', integracionesRoutes); // TRAM-F3: /simit/consulta, /fasecolda/buscar, /mercadolibre/precio
  app.use('/api/vehicles', ocrRoutes);
  app.use('/api/clients', clientsRoutes);
  app.use('/api/flito/parametrizacion', flitoParametrizacionRoutes);
  app.use('/api/flito/sync', flitoSyncRoutes);
  app.use('/api/flito/demo', flitoDemoRoutes);
  app.use('/api/soat', batchRoutes);
  app.use('/api/tramites', tramitesRoutes);
  app.use('/api/tramites', firmaRoutes); // TRAM-INNOV-B3: /:id/firma/solicitar + /:id/firma
  app.use('/api/webhooks/firma', firmaWebhookRoutes); // TRAM-INNOV-B3: webhook HMAC (body raw)
  app.use('/api/validacion-identidad', identidadRoutes);
  app.use('/api/tramites', ocrDocsRoutes);
  app.use('/api/transito', transitoRoutes);
  app.use('/api/transito', transitoConfigRoutes);
  app.use('/api/public/tramite-verificar', tramiteVerifyPublicRoutes); // Público — verificación QR sin auth
  app.use('/api/tramite-portal', tramitePortalPublicRoutes); // Público — portal participantes (magic link)
  app.use('/api/public/drive', procesadorPublicRoutes); // Público — descarga archivos (hyperlinks Excel)
  app.use('/api/drive', driveRoutes);
  app.use('/api/drive', procesadorRoutes);
  app.use('/api/laft/counterparties', laftCounterpartiesRoutes);
  app.use('/api/laft/audit', laftAuditRoutes);
  app.use('/api/laft/lists', laftListsRoutes);
  app.use('/api/laft/unusual', laftUnusualRoutes);
  app.use('/api/laft/ros', laftRosRoutes);
  // Export ROS para SIREL (PDF + CSV) — montado bajo el mismo prefijo /api/laft/ros.
  app.use('/api/laft/ros', laftRosExportRoutes);
  app.use('/api/laft/trainings', laftTrainingsRoutes);
  app.use('/api/laft/employees', laftEmployeesRoutes);
  app.use('/api/laft/sync', laftSyncRoutes);
  // LAFT/SARLAFT v2 — F5: Manual SARLAFT, oficial cumplimiento, auditorías, dashboard
  app.use('/api/laft/manual', laftManualRoutes);
  app.use('/api/laft/officer', laftOfficerRoutes);
  app.use('/api/laft/audit-plan', laftAuditPlanRoutes);
  app.use('/api/laft/dashboard', laftDashboardRoutes);
  app.use('/api/laft/retencion', laftRetencionRoutes);
  // LAFT/SARLAFT v2 — F3: Transacciones en efectivo + RTE/AROS (Dec. 1497/2002, Res. UIAF 122/2021)
  app.use('/api/laft/cash', laftCashRoutes);
  app.use('/api/laft/rte', laftRteRoutes);
  app.use('/api/laft/aros', laftArosRoutes);
  app.use('/api/privacy', privacyRoutes);
  app.use('/api/fleet/vehicles', fleetVehiclesRoutes);
  app.use('/api/fleet/links', fleetLinksRoutes);
  app.use('/api/fleet/measurements', fleetMeasurementsRoutes);
  app.use('/api/fleet/documents', fleetDocumentsRoutes);
  app.use('/api/maintenance', maintCatalogRoutes);
  app.use('/api/maintenance/routines', maintRoutinesRoutes);
  app.use('/api/maintenance/schedule', maintScheduleRoutes);
  app.use('/api/parts', maintPartsRoutes);
  app.use('/api/maintenance/pre-orders', maintPreOrdersRoutes);
  app.use('/api/maintenance/work-orders', maintWorkOrdersRoutes);
  app.use('/api/maintenance/indicators', maintIndicatorsRoutes);
  app.use('/api/liquidaciones', liquidacionRoutes); // TRAM-INNOV-B5-MVP: liquidación/pago manual
  app.use('/api/drivers/documents', driverDocumentsRoutes);
  app.use('/api/drivers/trainings', driverTrainingsRoutes);
  app.use('/api/drivers/incidents', driverIncidentsRoutes);
  app.use('/api/drivers/pesv-indicators', pesvIndicatorsRoutes);
  app.use('/api/drivers/checklists', driverChecklistsRoutes);
  app.use('/api/drivers/alcohol-tests', driverAlcoholRoutes);
  app.use('/api/drivers/emergency', driverEmergencyRoutes);
  app.use('/api/drivers/operational-indicators', driverOpIndicatorsRoutes);
  app.use('/api/drivers', driversRoutes);
  app.use('/api/rndc/public/manifiestos', rndcQrPublicRoutes); // Público — QR sin auth
  app.use('/api/rndc/credenciales', rndcCredencialesRoutes);   // Admin — credenciales cifradas
  app.use('/api/rndc/catalogos', rndcCatalogosRoutes);
  app.use('/api/rndc', rndcMaestrosRoutes);
  app.use('/api/rndc/remesas', rndcRemesasRoutes);
  app.use('/api/rndc/manifiestos', rndcManifiestosRoutes);
  app.use('/api/rndc', rndcPdfRoutes); // PDF manifiestos (path: /manifiestos/:id/pdf)
  app.use('/api/rndc/indicadores', rndcIndicadoresRoutes);
  // PESV Compliance Fase 1 — Paso 1 (Res. 40595/2022 + Res. 45295)
  app.use('/api/pesv/policy', pesvPolicyRoutes);
  app.use('/api/pesv/comite', pesvComiteRoutes);
  app.use('/api/pesv/plan', pesvPlanRoutes);
  app.use('/api/pesv/diagnostico', pesvDiagnosticoRoutes);
  app.use('/api/pesv/estandares', pesvEstandaresRoutes);
  app.use('/api/pesv', pesvTableroRoutes);          // /tablero
  app.use('/api/pesv/export', pesvExportRoutes);    // /sisi (ZIP)
  app.use('/api/pesv', pesvHuerfanosRoutes);        // /auditorias /comunicaciones /contratistas /incidents/:id/causa-raiz
  app.use('/api/pesv/raci', pesvRaciRoutes);        // S9 Paso 1.5
  app.use('/api/pesv/normativa', pesvNormativaRoutes); // S9 Paso 1.7
  app.use('/api/pesv/retencion', pesvRetencionRoutes); // S9 Paso 19
  app.use('/api/privacy/pii-access-log', piiAccessRoutes);
  // PESV Compliance Fase 3 — Control de jornada (Decreto 1079/2015)
  app.use('/api/jornadas', jornadasRoutes);
  // PESV Compliance Fase 2 — Paso 4 (Res. 40595/2022)
  app.use('/api/rutas/risk', rutasRiskRoutes);
  app.use('/api/rutas', rutasPernoctaRoutes); // expone /pernocta y /assignments
  app.use('/api/rutas', rutasRoutes); // último — rutas básicas en /api/rutas

  // Health check — valida BD también (load balancer debe saber si algo real falla)
  app.get('/api/health', async (_req, res) => {
    try {
      await db.execute(sql`SELECT 1`);
      res.json({ status: 'ok', db: 'up', timestamp: new Date().toISOString() });
    } catch (e: any) {
      res.status(503).json({ status: 'degraded', db: 'down', error: e?.message, timestamp: new Date().toISOString() });
    }
  });

  // Pool stats — público (no expone secretos, solo métricas operativas). Usar para
  // monitoreo externo (UptimeRobot, Grafana). Si utilization > 0.8 sostenido → escalar pool.
  app.get('/api/health/pool', async (_req, res) => {
    try {
      const stats = await getPoolStats();
      const status = stats.utilization > 0.9 ? 'critical' : stats.utilization > 0.75 ? 'warning' : 'ok';
      res.json({ status, ...stats, timestamp: new Date().toISOString() });
    } catch (e: any) {
      res.status(503).json({ status: 'error', error: e?.message });
    }
  });

  // Anthropic model probe — detecta deprecación de modelos OCR (INC-OCR-2026-05-12).
  app.get('/api/health/anthropic', async (_req, res) => {
    try {
      const { runAnthropicHealthCheckOnce } = await import('./modules/ai/anthropic-health.js');
      const report = await runAnthropicHealthCheckOnce();
      const code = report.status === 'degraded' ? 503 : 200;
      res.status(code).json(report);
    } catch (e: any) {
      res.status(503).json({ status: 'error', error: e?.message });
    }
  });

  // FLOTA-01: salud del reconciler SOAT — público (no expone secretos, solo estado
  // operativo). `stale` (>4h sin corrida con backlog pendiente) → 503 para que el
  // monitoreo externo alerte sin SSH. Ver docs/runbook/SOAT-RECONCILER-HEALTH.md.
  app.get('/api/health/soat-reconciler', async (_req, res) => {
    try {
      const { getReconcilerHealth } = await import('./modules/soat/reconciler-health.js');
      const report = await getReconcilerHealth();
      res.status(report.status === 'stale' ? 503 : 200).json(report);
    } catch (e: any) {
      res.status(503).json({ status: 'error', error: e?.message });
    }
  });

  // PESV-07: métricas Prometheus. FUERA de /api a propósito → nginx solo proxya
  // /api/ al dominio público, así que /metrics queda accesible solo en el host
  // (Prometheus scrapea localhost:3005/metrics). No expone secretos.
  app.get('/metrics', async (_req, res) => {
    try {
      res.setHeader('Content-Type', registry.contentType);
      res.send(await registry.metrics());
    } catch (e: any) {
      res.status(500).json({ error: e?.message });
    }
  });

  app.use(errorHandler);

  return app;
}
