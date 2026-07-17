// Export PESV diagnóstico — endpoints específicos del rediseño UX:
//   - GET /diagnostico/:id/estandar/:codigo  (export por estándar individual)
//   - GET /diagnostico/:id                   (expediente completo)
//
// Separado de `export.routes.ts` (SISI) por cap 400 líneas (memoria 27001).
// Se monta con `router.use('/', diagnosticoExportRouter)` desde export.routes.ts
// para que ambas familias compartan el prefijo `/api/pesv/export`.
//
// El auth + requirePage('pesv') ya se aplica en el padre.

import { Router, Request, Response } from 'express';
import { eq, sql } from 'drizzle-orm';
import archiver from 'archiver';
import crypto from 'crypto';
import { db } from '../../db/client.js';
import { pesvDiagnosticos } from '../../db/schema.js';
import { requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { logPiiAccess } from '../../shared/pii-audit.js';
import { buildDiagnosticoPdf } from './pdf-builder.js';
import { getEntityDocumentStream } from '../../services/storage.js';
import { loggerFor } from '../../shared/logger.js';

const KYVERUM = 'Kyverum LLC';
const exportLog = loggerFor('pesv.export.diagnostico');

const router = Router();

// Helper compartido: descarga evidencias originales desde MinIO (best-effort).
async function downloadEvidencias(
  keys: string[],
  ctx: Record<string, unknown>,
): Promise<Array<{ filename: string; buf: Buffer; sha256: string; key: string }>> {
  const out: Array<{ filename: string; buf: Buffer; sha256: string; key: string }> = [];
  for (const key of keys) {
    try {
      const stream = await getEntityDocumentStream(key);
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => resolve());
        stream.on('error', reject);
      });
      const buf = Buffer.concat(chunks);
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      const filename = key.split('/').pop()?.replace(/^\d+_[0-9a-f]+_/, '') ?? 'evidencia';
      out.push({ filename, buf, sha256, key });
    } catch (e) {
      exportLog.warn({ err: (e as Error).message, key, ...ctx }, 'evidencia inaccesible — incluida como nota');
    }
  }
  return out;
}

// ============================================================================
// GET /diagnostico/:id/estandar/:codigo — export por estándar individual
// ============================================================================
router.get(
  '/diagnostico/:id/estandar/:codigo',
  requireRole('admin', 'lider_pesv', 'compliance'),
  async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    const codigo = String(req.params.codigo || '').trim();
    if (!Number.isFinite(id) || id <= 0 || !codigo) {
      res.status(400).json({ error: 'parámetros inválidos' }); return;
    }

    const [diag] = await db.select().from(pesvDiagnosticos).where(eq(pesvDiagnosticos.id, id)).limit(1);
    if (!diag) { res.status(404).json({ error: 'diagnóstico no encontrado' }); return; }

    const itemRows = await db.execute(sql`
      SELECT i.estandar_id, i.score_pct::float AS score, i.nivel_rubrica,
             i.evidencia_keys, i.comentarios,
             c.codigo, c.paso, c.fase, c.nombre, c.descripcion
        FROM pesv_diagnostico_items i
        JOIN pesv_estandares_catalogo c ON c.id = i.estandar_id
       WHERE i.diagnostico_id = ${id} AND c.codigo = ${codigo}
       LIMIT 1
    ` as any) as any;
    const item = (itemRows?.rows?.[0] ?? itemRows?.[0]) as any;
    if (!item) { res.status(404).json({ error: 'estándar no encontrado en el diagnóstico' }); return; }

    const evidenciaKeys = ((item.evidencia_keys ?? []) as string[]);
    const evidencias = await downloadEvidencias(evidenciaKeys, { id, codigo });

    const estandarPdf = await buildDiagnosticoPdf({
      anio: diag.anio,
      fecha: String(diag.fecha),
      scoreGlobal: Number(diag.scoreGlobal),
      estado: diag.estado,
      estandares: [{
        codigo: item.codigo,
        fase: item.fase,
        nombre: `${item.nombre} — ${item.nivel_rubrica} · ${Number(item.score).toFixed(0)}%`,
        scorePct: Number(item.score),
      }],
    });

    const manifestLines = [
      `Empresa: ${KYVERUM}`,
      `Diagnóstico: anio=${diag.anio} id=${diag.id} nivel=${diag.nivelEmpresa} estado=${diag.estado}`,
      `Estándar: ${item.codigo} fase=${item.fase} paso=${item.paso}`,
      `Score: ${Number(item.score).toFixed(2)}% (${item.nivel_rubrica})`,
      `Comentarios: ${item.comentarios ?? '(sin comentarios)'}`,
      `Generado: ${new Date().toISOString()} por userId=${req.user!.sub} rol=${req.user!.role}`,
      `Total evidencias: ${evidenciaKeys.length} (descargadas ${evidencias.length})`,
      '',
      'Hashes SHA-256 por evidencia:',
      ...evidencias.map((e) => `  ${e.sha256}  ${e.filename}`),
      ...evidenciaKeys.filter((k) => !evidencias.find((e) => e.key === k)).map((k) => `  [inaccesible]  ${k.split('/').pop() ?? k}`),
      '',
      'Fuente normativa: Res. 40595/2022 (MinTransporte) — Anexo metodológico PHVA.',
    ].join('\n');

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeCodigo = item.codigo.replace(/[^A-Za-z0-9._-]+/g, '_');
    const filename = `pesv-${diag.anio}-${safeCodigo}-${ts}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');

    const zip = archiver('zip', { zlib: { level: 9 } });
    zip.on('error', (err) => { res.status(500).end(`zip error: ${err.message}`); });
    zip.pipe(res);
    zip.append(estandarPdf, { name: `01-estandar-${safeCodigo}.pdf` });
    zip.append(manifestLines, { name: `00-manifiesto.txt` });
    for (const e of evidencias) {
      zip.append(e.buf, { name: `evidencias/${e.filename}` });
    }

    await audit(req, {
      action: 'export', resource: 'pesv_diag_estandar',
      resourceId: `${id}/${codigo}`,
      detail: `evidencias=${evidencias.length}/${evidenciaKeys.length}`,
    });
    if (req.user?.role === 'compliance') {
      await logPiiAccess(req, {
        resourceTipo: 'pesv_evidence',
        resourceId: id,
        accion: 'export',
        camposAccedidos: ['evidencia_documental'],
        motivo: `export estandar=${codigo}`,
      });
    }

    await zip.finalize();
  },
);

// ============================================================================
// GET /diagnostico/:id — expediente completo (PDF consolidado + ZIP evidencias)
// ============================================================================
router.get(
  '/diagnostico/:id',
  requireRole('admin', 'lider_pesv', 'compliance'),
  async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: 'id inválido' }); return;
    }

    const [diag] = await db.select().from(pesvDiagnosticos).where(eq(pesvDiagnosticos.id, id)).limit(1);
    if (!diag) { res.status(404).json({ error: 'diagnóstico no encontrado' }); return; }

    const itemRows = await db.execute(sql`
      SELECT i.estandar_id, i.score_pct::float AS score, i.nivel_rubrica,
             i.evidencia_keys, i.comentarios,
             c.codigo, c.paso, c.fase, c.nombre
        FROM pesv_diagnostico_items i
        JOIN pesv_estandares_catalogo c ON c.id = i.estandar_id
       WHERE i.diagnostico_id = ${id}
       ORDER BY c.paso, c.orden
    ` as any) as any;
    const items = ((itemRows?.rows ?? itemRows ?? []) as any[]);

    type EvPlus = { codigo: string; filename: string; buf: Buffer; sha256: string; key: string };
    const evidencias: EvPlus[] = [];
    let totalKeys = 0;
    for (const it of items) {
      const keys = ((it.evidencia_keys ?? []) as string[]);
      totalKeys += keys.length;
      const downloaded = await downloadEvidencias(keys, { id, codigo: it.codigo });
      for (const d of downloaded) evidencias.push({ codigo: it.codigo, ...d });
    }

    const expedientePdf = await buildDiagnosticoPdf({
      anio: diag.anio,
      fecha: String(diag.fecha),
      scoreGlobal: Number(diag.scoreGlobal),
      estado: diag.estado,
      estandares: items.map((it: any) => ({
        codigo: it.codigo,
        fase: it.fase,
        nombre: `${it.nombre} — ${it.nivel_rubrica} · ${Number(it.score).toFixed(0)}%`,
        scorePct: Number(it.score),
      })),
    });

    const manifestLines = [
      `Empresa: ${KYVERUM}`,
      `Diagnóstico: anio=${diag.anio} id=${diag.id} nivel=${diag.nivelEmpresa} estado=${diag.estado}`,
      `Score global: ${Number(diag.scoreGlobal).toFixed(2)}%`,
      `Cerrado: ${diag.cerradoAt ? new Date(diag.cerradoAt).toISOString() : '(en borrador)'}`,
      `Generado: ${new Date().toISOString()} por userId=${req.user!.sub} rol=${req.user!.role}`,
      `Estándares: ${items.length} · Evidencias: ${totalKeys} (descargadas ${evidencias.length})`,
      '',
      'Hashes SHA-256 por evidencia:',
      ...evidencias.map((e) => `  ${e.sha256}  ${e.codigo}/${e.filename}`),
      '',
      'Fuente normativa: Res. 40595/2022 (MinTransporte) — Anexo metodológico PHVA.',
    ].join('\n');

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `pesv-expediente-${diag.anio}-${ts}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');

    const zip = archiver('zip', { zlib: { level: 9 } });
    zip.on('error', (err) => { res.status(500).end(`zip error: ${err.message}`); });
    zip.pipe(res);
    zip.append(expedientePdf, { name: `01-expediente.pdf` });
    zip.append(manifestLines, { name: `00-manifiesto.txt` });
    for (const e of evidencias) {
      const safeCodigo = e.codigo.replace(/[^A-Za-z0-9._-]+/g, '_');
      zip.append(e.buf, { name: `evidencias/${safeCodigo}/${e.filename}` });
    }

    await audit(req, {
      action: 'export', resource: 'pesv_diag',
      resourceId: String(id),
      detail: `expediente completo evidencias=${evidencias.length}/${totalKeys}`,
    });
    if (req.user?.role === 'compliance') {
      await logPiiAccess(req, {
        resourceTipo: 'pesv_evidence',
        resourceId: id,
        accion: 'export',
        camposAccedidos: ['evidencia_documental'],
        motivo: 'export expediente completo',
      });
    }

    await zip.finalize();
  },
);

export default router;
