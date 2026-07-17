// FUR / ftrunt — port transitos.cjs POST /ftrunt-internal (overlay plantilla Mintransporte).

import fs from 'fs';
import path from 'path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { ORGANISMOS_TRANSITO } from '@operaciones/shared-types';
import { sanWinAnsi, parseNombreParts } from './pdf-utils.js';

export interface FurInput {
  tramiteId?: number;
  firmantes?: unknown[];
  vehiculo?: Record<string, unknown>;
  vendedor?: Record<string, unknown>;
  comprador?: Record<string, unknown>;
  orgNombre?: string; orgCiudad?: string; orgCodigo?: string;
  orgVehiculoNombre?: string; orgVehiculoCiudad?: string; orgVehiculoCodigo?: string;
  regrabado?: { motor?: string; chasis?: string; serie?: string };
}

function resolveOrgVehiculo(data: FurInput): { nombre: string; ciudad: string; codigo: string } {
  let orgVehN = (data.orgVehiculoNombre || data.orgNombre || '').trim();
  let orgVehCiudad = (data.orgVehiculoCiudad || data.orgCiudad || '').trim();
  let orgVehCod = String(data.orgVehiculoCodigo || data.orgCodigo || '').trim();
  if (orgVehN && !orgVehCiudad) {
    const upperOrg = orgVehN.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const sorted = [...ORGANISMOS_TRANSITO].sort((a, b) => b.nombre.length - a.nombre.length);
    for (const o of sorted) {
      const key = o.nombre.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (key.length >= 4 && upperOrg.includes(key.slice(-Math.min(key.length, 12)))) {
        orgVehCiudad = o.ciudad; orgVehCod = o.codigo; break;
      }
      if (upperOrg.includes(o.ciudad.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''))) {
        orgVehCiudad = o.ciudad; orgVehCod = o.codigo; break;
      }
    }
  }
  if (orgVehCiudad && !orgVehCod) {
    const match = ORGANISMOS_TRANSITO.find((o) => o.ciudad.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') === orgVehCiudad.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
    if (match) orgVehCod = match.codigo;
  }
  return { nombre: orgVehN, ciudad: orgVehCiudad, codigo: orgVehCod };
}

export async function generarFurPdf(data: FurInput): Promise<Buffer> {
  const tplPath = path.join(process.cwd(), 'apps/api/templates/ftrunt.pdf');
  if (!fs.existsSync(tplPath)) {
    throw new Error(
      'Plantilla FTRUNT no encontrada en apps/api/templates/ftrunt.pdf. '
      + 'Copie la plantilla al deploy o configure PDF_MODE=cea-proxy. Ver apps/api/templates/README.md',
    );
  }
  const v = data.vehiculo || {};
  const com = data.comprador || {};
  const placa = String(v.placa || '').toUpperCase();

  const pdfDoc = await PDFDocument.load(fs.readFileSync(tplPath));
  const page = pdfDoc.getPages()[0];
  const { width: PW, height: PH } = page.getSize();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const BLACK = rgb(0, 0, 0);
  const san = sanWinAnsi;

  const text = (t: unknown, xt: number, yt: number, opts: { size?: number; bold?: boolean } = {}) => {
    if (!t) return;
    const size = opts.size || 8;
    const f = opts.bold ? fontBold : font;
    page.drawText(san(t), { x: xt, y: PH - yt - size, size, font: f, color: BLACK });
  };
  const textC = (t: unknown, cx: number, yt: number, opts: { size?: number; bold?: boolean } = {}) => {
    if (!t) return;
    const size = opts.size || 8;
    const f = opts.bold ? fontBold : font;
    const safe = san(t);
    const w = f.widthOfTextAtSize(safe, size);
    page.drawText(safe, { x: cx - w / 2, y: PH - yt - size, size, font: f, color: BLACK });
  };
  const checkX = (xt: number, yt: number, w: number, h: number) => {
    const size = Math.min(w, h) * 0.85;
    const tw = fontBold.widthOfTextAtSize('X', size);
    page.drawText('X', { x: xt + (w - tw) / 2, y: PH - yt - h + (h - size) / 2 + 1, size, font: fontBold, color: BLACK });
  };
  const fitText = (txt: unknown, maxW: number, sz: number, useBold: boolean) => {
    if (!txt) return '';
    const f = useBold ? fontBold : font;
    let s = String(txt);
    while (s.length > 0 && f.widthOfTextAtSize(san(s), sz) > maxW) s = s.slice(0, -1);
    return s;
  };

  const fecha = new Date();
  textC(String(fecha.getDate()).padStart(2, '0'), 609, 90, { size: 9, bold: true });
  textC(String(fecha.getMonth() + 1).padStart(2, '0'), 635, 90, { size: 9, bold: true });
  textC(String(fecha.getFullYear()), 664, 90, { size: 9, bold: true });

  const placaClean = placa.replace(/[^A-Z0-9]/g, '');
  const mEst = placaClean.match(/^([A-Z]{3})(\d{3})$/);
  if (mEst) { textC(mEst[1], 717, 85, { size: 11, bold: true }); textC(mEst[2], 744, 85, { size: 11, bold: true }); }

  checkX(30, 119, 12, 9);

  const claseStr = String(v.clase || v.claseVehiculo || '').toUpperCase().replace(/\s+/g, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const clasesMap: Record<string, [number, number]> = { AUTOMOVIL: [55, 219], BUS: [105, 219], BUSETA: [148, 219], CAMION: [191, 219], CAMIONETA: [233, 219], CAMPERO: [280, 219], MICROBUS: [338, 219], TRACTOCAMION: [55, 244], MOTOCICLETA: [105, 244], MOTOCARRO: [148, 244], MOTOTRICICLO: [191, 244], CUATRIMOTO: [233, 244], VOLQUETA: [280, 244], OTRO: [338, 244] };
  if (clasesMap[claseStr]) checkX(clasesMap[claseStr][0], clasesMap[claseStr][1], 9, 8);

  text(fitText(v.marca, 78, 9, true), 376, 132, { size: 9, bold: true });
  text(fitText(v.linea, 78, 9, true), 457, 132, { size: 9, bold: true });

  const combXs: Record<string, number> = { GASOLINA: 552, DIESEL: 580, GAS: 607, MIXTO: 635, ELECTRICO: 662, HIDROGENO: 689, ETANOL: 716, BIODIESEL: 744 };
  const combNorm = String(v.combustible || v.tipoCombustible || 'GASOLINA').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  let combKey = 'GASOLINA';
  for (const k of Object.keys(combXs)) { if (combNorm.includes(k.slice(0, 4))) { combKey = k; break; } }
  checkX((combXs[combKey] || 552) - 4, 130, 8, 12);

  text(fitText(v.color, 240, 9, true), 376, 154, { size: 9, bold: true });
  textC(fitText(v.modelo, 53, 9, true), 649, 154, { size: 9, bold: true });
  textC(fitText(String(v.cilindraje || ''), 76, 8, true), 718, 154, { size: 8, bold: true });
  text(fitText(v.carroceria || v.tipoCarroceria, 145, 9, true), 425, 252, { size: 9, bold: true });
  text(fitText(v.numMotor, 145, 8, false), 572, 224, { size: 8 });
  text(fitText(v.numChasis, 145, 8, false), 572, 250, { size: 8 });
  text(fitText(v.vin || v.numSerie, 145, 8, false), 572, 278, { size: 8 });

  checkX(537.7, 170.4, 4.9, 5.0);
  checkX(668.9, 170.4, 5.0, 5.0);

  const regr = data.regrabado || {};
  const regrYs: Record<string, number> = { motor: 226, chasis: 254, serie: 282 };
  Object.entries(regrYs).forEach(([k, ry]) => {
    const isSi = String((regr as Record<string, string>)[k] || 'NO').toUpperCase() === 'SI';
    checkX(isSi ? 712.5 : 737.6, ry, 7.8, 7.9);
  });

  const { nombre: orgVehN, ciudad: orgVehCiudad, codigo: orgVehCod } = resolveOrgVehiculo(data);
  if (orgVehN) {
    page.drawRectangle({ x: 522, y: PH - 73, width: 155, height: 10, color: rgb(1, 1, 1) });
    let szN = 6;
    while (font.widthOfTextAtSize(san(orgVehN), szN) > 152 && szN > 4) szN -= 0.5;
    text(orgVehN, 524, 65, { size: szN, bold: true });
    if (orgVehCiudad) {
      page.drawRectangle({ x: 484, y: PH - 96, width: 53, height: 9, color: rgb(1, 1, 1) });
      let szC = 7;
      while (font.widthOfTextAtSize(san(orgVehCiudad), szC) > 50 && szC > 4.5) szC -= 0.5;
      textC(orgVehCiudad, 510, 89, { size: szC, bold: true });
    }
    if (orgVehCod) {
      page.drawRectangle({ x: 540, y: PH - 96, width: 54, height: 9, color: rgb(1, 1, 1) });
      textC(String(orgVehCod), 567, 89, { size: 8, bold: true });
    }
  }

  const servMap: Record<string, number> = { PARTICULAR: 568, PUBLICO: 609, OFICIAL: 636, DIPLOMATICO: 664, ESPECIAL: 691 };
  const servNorm = String(v.tipoServicio || v.servicio || 'PARTICULAR').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const [k, x] of Object.entries(servMap)) { if (servNorm.includes(k.slice(0, 4))) { checkX(x, 365, 14, 8); break; } }

  page.drawRectangle({ x: 452, y: PH - 434, width: 80, height: 8, color: rgb(1, 1, 1) });

  const cn = parseNombreParts(com.nombre || com.nombres);
  text(fitText(cn.ap1, 90, 8, false), 33, 446, { size: 8 });
  text(fitText(cn.ap2, 90, 8, false), 132, 446, { size: 8 });
  text(fitText(cn.nom, 110, 8, false), 259, 446, { size: 8 });
  const comDocMap: Record<string, number> = { CC: 30, NIT: 86, PASAPORTE: 142, CE: 200, TI: 256 };
  const comTd = String(com.tipoDoc || 'CC').toUpperCase();
  if (comDocMap[comTd] != null) checkX(comDocMap[comTd], 474, 12, 8);
  text(String(com.documento || ''), 309, 480, { size: 8, bold: true });
  text(fitText(com.direccion, 155, 7, false), 33, 506, { size: 7 });
  text(fitText(com.ciudad, 110, 7, false), 196, 506, { size: 7 });
  text(fitText(com.telefono, 70, 7, false), 309, 506, { size: 7 });

  return Buffer.from(await pdfDoc.save());
}
