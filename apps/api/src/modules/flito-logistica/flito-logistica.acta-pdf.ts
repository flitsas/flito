// FLITO Logística — PDF del acta (tabla + dos firmas) (HU #14108, ADR-0030 §11).

import { eq } from 'drizzle-orm';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { db } from '../../db/client.js';
import { clients, flitoLogisticaActas, flitoLogisticaDocumentos, organismosTransitoConfig, vehicles } from '../../db/schema.js';
import { getEntityDocumentStream, presignedGetEntityDocument, uploadEntityDocument } from '../../services/storage.js';
import { LogisticaError } from './flito-logistica.base.js';

async function embeberFirma(pdf: PDFDocument, key: string): Promise<Awaited<ReturnType<PDFDocument['embedPng']>> | null> {
  try {
    const chunks: Buffer[] = [];
    for await (const c of await getEntityDocumentStream(key)) chunks.push(c as Buffer);
    return await pdf.embedPng(Buffer.concat(chunks));
  } catch { return null; }
}

/** Genera el PDF del acta (empresa, tabla de LT, dos firmas), lo sube y fija pdfStorageKey (CA-13). */
export async function generarActaPdf(actaId: string): Promise<string> {
  const [cab] = await db.select({
    companiaNombre: clients.name, direccion: flitoLogisticaActas.direccionEntrega,
    contactoNombre: flitoLogisticaActas.contactoNombre, creadoEn: flitoLogisticaActas.createdAt,
    firmaEntregaKey: flitoLogisticaActas.firmaEntregaStorageKey, entregaNombre: flitoLogisticaActas.entregaNombre,
    firmaRecibeKey: flitoLogisticaActas.firmaStorageKey, receptorNombre: flitoLogisticaActas.receptorNombre,
    receptorDocumento: flitoLogisticaActas.receptorDocumento, entregadoEn: flitoLogisticaActas.entregadoEn,
  }).from(flitoLogisticaActas)
    .leftJoin(clients, eq(flitoLogisticaActas.companiaId, clients.id))
    .where(eq(flitoLogisticaActas.id, actaId)).limit(1);
  if (!cab) throw new LogisticaError('Acta no encontrada', 404);

  const docs = await db.select({
    placa: vehicles.plate, secretaria: organismosTransitoConfig.alias, organismoCodigo: flitoLogisticaDocumentos.organismoCodigo,
    propietario: flitoLogisticaDocumentos.propietarioNombre, numeroLicencia: flitoLogisticaDocumentos.numeroLicencia,
    numeroLt: flitoLogisticaDocumentos.numeroLt,
  }).from(flitoLogisticaDocumentos)
    .innerJoin(vehicles, eq(flitoLogisticaDocumentos.vehiculoId, vehicles.id))
    .leftJoin(organismosTransitoConfig, eq(flitoLogisticaDocumentos.organismoCodigo, organismosTransitoConfig.codigo))
    .where(eq(flitoLogisticaDocumentos.actaId, actaId));

  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]); // A4
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const azul = rgb(0.086, 0.153, 0.267);
  const gris = rgb(0.5, 0.55, 0.6);
  let y = 800;
  const linea = (text: string, opts: { x?: number; size?: number; negrita?: boolean; color?: ReturnType<typeof rgb> } = {}) => {
    page.drawText(text, { x: opts.x ?? 40, y, size: opts.size ?? 10, font: opts.negrita ? bold : font, color: opts.color ?? azul });
    y -= (opts.size ?? 10) + 6;
  };
  const clip = (s: string | null, max: number) => { const v = s ?? '—'; return v.length > max ? `${v.slice(0, max - 1)}…` : v; };

  linea('Acta de entrega de licencias de tránsito', { size: 16, negrita: true });
  linea(`Para: ${cab.companiaNombre ?? '—'}`, { size: 12, negrita: true });
  if (cab.direccion) linea(`Dirección de entrega: ${cab.direccion}`, { size: 9 });
  linea(`Acta N.º ${actaId}`, { size: 8, color: gris });
  linea(`Generada: ${cab.creadoEn.toISOString().slice(0, 16).replace('T', ' ')}  ·  ${docs.length} licencia(s)`, { size: 8, color: gris });
  y -= 6;
  linea(`Placas: ${clip(docs.map((d) => d.placa ?? '—').join(', '), 110)}`, { size: 9 });
  y -= 6;

  // Tabla: Placa | Secretaría | Propietario | N.º licencia | N.º LT.
  const cols = [
    { t: 'Placa', x: 40, w: 60 }, { t: 'Secretaría', x: 100, w: 110 }, { t: 'Propietario', x: 210, w: 150 },
    { t: 'N.º licencia', x: 360, w: 100 }, { t: 'N.º LT', x: 460, w: 95 },
  ];
  const filaAlto = 16;
  const dibujarEncabezado = () => {
    page.drawRectangle({ x: 38, y: y - 3, width: 519, height: filaAlto, color: rgb(0.93, 0.95, 0.98) });
    cols.forEach((c) => page.drawText(c.t, { x: c.x + 2, y: y, size: 8, font: bold, color: azul }));
    y -= filaAlto;
  };
  dibujarEncabezado();
  const maxFilas = Math.max(0, Math.floor((y - 150) / filaAlto));
  docs.slice(0, maxFilas).forEach((d) => {
    const vals = [clip(d.placa, 10), clip(d.secretaria ?? d.organismoCodigo, 18), clip(d.propietario, 26), clip(d.numeroLicencia, 15), clip(d.numeroLt, 14)];
    vals.forEach((v, i) => page.drawText(v, { x: cols[i].x + 2, y, size: 8, font, color: azul }));
    page.drawLine({ start: { x: 38, y: y - 3 }, end: { x: 557, y: y - 3 }, thickness: 0.3, color: rgb(0.85, 0.87, 0.9) });
    y -= filaAlto;
  });
  if (docs.length > maxFilas) linea(`… y ${docs.length - maxFilas} licencia(s) más (ver detalle en la consola)`, { x: 40, size: 8, color: gris });

  // Dos firmas: ENTREGA (Operaciones, en consola) y RECIBE (receptor, en campo).
  const firmaEntrega = cab.firmaEntregaKey ? await embeberFirma(pdf, cab.firmaEntregaKey) : null;
  const firmaRecibe = cab.firmaRecibeKey ? await embeberFirma(pdf, cab.firmaRecibeKey) : null;
  const bloqueFirma = async (titulo: string, x: number, img: typeof firmaEntrega, l1: string, l2: string) => {
    if (img) { const dims = img.scale(Math.min(180 / img.width, 46 / img.height)); page.drawImage(img, { x: x + 4, y: 96, width: dims.width, height: dims.height }); }
    page.drawLine({ start: { x, y: 92 }, end: { x: x + 235, y: 92 }, thickness: 0.6, color: azul });
    page.drawText(titulo, { x, y: 78, size: 9, font: bold, color: azul });
    page.drawText(l1, { x, y: 64, size: 8, font, color: azul });
    if (l2) page.drawText(l2, { x, y: 52, size: 8, font, color: gris });
  };
  await bloqueFirma('Entrega (Operaciones)', 40, firmaEntrega,
    cab.entregaNombre ?? '—', firmaEntrega ? '' : 'Pendiente de firma');
  await bloqueFirma('Recibe (cliente)', 320, firmaRecibe,
    cab.receptorNombre ? `${cab.receptorNombre}  C.C. ${cab.receptorDocumento ?? '—'}` : '—',
    cab.entregadoEn ? `Recibido: ${cab.entregadoEn.toISOString().slice(0, 16).replace('T', ' ')}` : (firmaRecibe ? '' : 'Pendiente de firma'));

  const bytes = await pdf.save();
  const key = await uploadEntityDocument('flito-logistica-actas', actaId, `acta-${actaId}.pdf`, Buffer.from(bytes), 'application/pdf');
  await db.update(flitoLogisticaActas).set({ pdfStorageKey: key, updatedAt: new Date() }).where(eq(flitoLogisticaActas.id, actaId));
  return key;
}

/** URL prefirmada para ver/descargar el PDF del acta; lo genera si aún no existe. */
export async function urlActaPdf(actaId: string): Promise<string> {
  const [a] = await db.select({ key: flitoLogisticaActas.pdfStorageKey }).from(flitoLogisticaActas)
    .where(eq(flitoLogisticaActas.id, actaId)).limit(1);
  if (!a) throw new LogisticaError('Acta no encontrada', 404);
  const key = a.key ?? await generarActaPdf(actaId);
  return presignedGetEntityDocument(key, 300);
}
