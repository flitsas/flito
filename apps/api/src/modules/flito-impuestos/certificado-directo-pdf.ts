// PDF de la certificación sin trámite. Se arma al descargar y no se archiva.
// El documento del propietario es dato de FLITO: la consulta fue por VIN y el RUNT no lo validó.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { CAMPO_COMPARACION_FACTURA_RUNT_LABEL, type ComparacionCampoFacturaRunt } from '@operaciones/shared-types';
import type { RegistroRuntGuardado } from '../../db/schema/flito-impuesto-certificacion-directa.js';
import { fechaHoraColombia, sanitize } from './certificado-pdf.js';

const ETIQUETA_REGISTRO: Record<keyof RegistroRuntGuardado, string> = {
  clasificacion: 'Clasificacion',
  color: 'Color',
  cilindraje: 'Cilindraje',
  tipoServicio: 'Tipo de servicio',
  organismoTransito: 'Organismo de transito',
  estadoAutomotor: 'Estado del automotor',
  fechaMatricula: 'Fecha de matricula',
  numMotor: 'Numero de motor',
  numChasis: 'Numero de chasis',
  numSerie: 'Numero de serie',
};

export interface CertificadoDirectoPdfDatos {
  placa: string;
  vin: string;
  documento: string;
  nombrePropietario: string;
  organismo: string;
  campos: ComparacionCampoFacturaRunt[];
  registroRunt: RegistroRuntGuardado;
  certificadoPorNombre: string;
  certificadoEn: Date;
  generadoPor: string;
  generadoEn: Date;
}

const RESULTADO: Record<ComparacionCampoFacturaRunt['resultado'], string> = {
  coincide: 'Coincide',
  difiere: 'Difiere',
  no_verificable: 'No reportado por el RUNT',
};

/** Líneas que el PDF imprime. El documento no se rotula como validado ante el RUNT. */
export function lineasDatoFlito(d: Pick<CertificadoDirectoPdfDatos, 'nombrePropietario' | 'documento' | 'vin' | 'placa' | 'organismo'>): [string, string][] {
  return [
    ['Nombre (dato de FLITO)', d.nombrePropietario],
    ['Documento (dato de FLITO)', d.documento],
    ['VIN consultado', d.vin],
    ['Placa (dato de FLITO)', d.placa],
    ['Organismo (dato de FLITO)', d.organismo],
  ];
}

export async function construirCertificadoDirectoPdf(d: CertificadoDirectoPdfDatos): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Certificado RUNT ${sanitize(d.placa)}`);
  doc.setAuthor('FLITO');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595.28, 841.89]);
  let y = 780;
  const texto = (s: string, x: number, size: number, f = font) => {
    page.drawText(sanitize(s).slice(0, 110), { x, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
  };
  texto('FLITO', 50, 16, bold);
  y -= 22;
  texto('Certificado de verificacion ante el RUNT', 50, 12, bold);
  y -= 28;
  texto(`Generado el: ${fechaHoraColombia(d.generadoEn)}`, 50, 9);
  y -= 14;
  texto(`Generado por: ${d.generadoPor}`, 50, 9);
  y -= 14;
  texto(`Certificado el: ${fechaHoraColombia(d.certificadoEn)}`, 50, 9);
  y -= 14;
  texto(`Certificado por: ${d.certificadoPorNombre}`, 50, 9);
  y -= 24;
  texto('DATOS DE FLITO', 50, 10, bold);
  y -= 16;
  for (const [k, v] of lineasDatoFlito(d)) {
    texto(`${k}: ${v}`, 50, 9);
    y -= 14;
  }
  y -= 10;
  texto('DATOS DEL VEHICULO VERIFICADOS', 50, 10, bold);
  y -= 16;
  for (const c of d.campos) {
    const etiqueta = CAMPO_COMPARACION_FACTURA_RUNT_LABEL[c.campo] ?? c.campo;
    texto(`${etiqueta}: ${c.valorFactura ?? '—'} / RUNT ${c.valorRunt ?? '—'} / ${RESULTADO[c.resultado]}`, 50, 8);
    y -= 13;
  }
  y -= 10;
  texto('REGISTRO DEL VEHICULO (RUNT)', 50, 10, bold);
  y -= 16;
  for (const clave of Object.keys(ETIQUETA_REGISTRO) as (keyof RegistroRuntGuardado)[]) {
    const valor = d.registroRunt[clave]?.trim() || 'No reportado por el RUNT';
    texto(`${ETIQUETA_REGISTRO[clave]}: ${valor}`, 50, 8);
    y -= 13;
  }
  return Buffer.from(await doc.save());
}
