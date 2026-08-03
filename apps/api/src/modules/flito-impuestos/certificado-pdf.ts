/**
 * Certificado PDF de la verificación contra el RUNT (HU #11167).
 *
 * En caliente y sin persistir (RN-11): no se crea fila en `flito_soportes` ni objeto en S3. Lo que se
 * guarda es la CERTIFICACIÓN (migración 0121), y el PDF se vuelve a armar desde ese snapshot cada vez
 * que alguien lo descarga. Almacenarlo obligaría a versionarlo, a limpiarlo y a decidir qué pasa
 * cuando el registro se recertifica; regenerarlo cuesta milisegundos y siempre refleja la
 * certificación vigente.
 *
 * PURO: recibe los datos ya leídos y devuelve bytes. No toca la base ni el RUNT — de hecho el RUNT no
 * se vuelve a consultar NUNCA al descargar (AC4), y tenerlo aquí sin acceso a red lo hace imposible
 * por construcción, no por disciplina.
 *
 * Honestidad del documento: el certificado no puede afirmar más de lo que se verificó. El RUNT no
 * devuelve al propietario (RN-02), así que el nombre se presenta como dato de FLITO y solo el
 * documento se presenta como validado — porque la consulta se autenticó con él. Ver `armarPropietario`.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import {
  CAMPO_CERTIFICACION_LABEL,
  ResultadoCampo,
  type ComparacionCampo,
} from '@operaciones/shared-types';
import { TZ_COLOMBIA } from '../../shared/utils/fecha-rango.js';

const ORIGEN = 'FLITO';
const A4_W = 595.28;
const A4_H = 841.89;
const MARGEN = 50;
const ANCHO_UTIL = A4_W - MARGEN * 2;

const GRIS = rgb(0.42, 0.42, 0.42);
const GRIS_CLARO = rgb(0.88, 0.88, 0.88);
const NEGRO = rgb(0.1, 0.1, 0.1);

/**
 * Puntuación tipográfica que sí tiene equivalente ASCII.
 *
 * Sin esto el catch-all de `sanitize` las convierte en '?', y un '?' en una celda del certificado se
 * lee como un dato dudoso, no como un guion. Pasó con el guion de «valor ausente»: el documento
 * acababa diciendo que el RUNT había respondido «?». Estos caracteres llegan también en los DATOS
 * —una línea de vehículo con comillas, un nombre con guion largo—, así que no es solo cosa del texto
 * fijo del certificado.
 */
const EQUIVALENTES: Record<string, string> = {
  '\u2014': '-', '\u2013': '-', '\u2212': '-',
  '\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"',
  '\u00ab': '"', '\u00bb': '"', '\u2026': '...', '\u00a0': ' ',
};

/**
 * pdf-lib escribe con codificación WinAnsi y LANZA ante un carácter que no puede representar.
 *
 * Un nombre con tilde o eñe no puede tumbar la descarga (AC6), así que se normaliza NFKD y se
 * descartan los diacríticos: «MUÑOZ PEÑA» sale «MUNOZ PENA», que es legible y correcto de leer en voz
 * alta. Lo que no sea ASCII imprimible tras eso se sustituye por '?' en vez de reventar. Mismo
 * criterio que `pesv/pdf-builder.ts:70` y `tramites/expediente-pdf.ts:36`.
 */
export function sanitize(s: string): string {
  return s
    .replace(/[\u2014\u2013\u2212\u2018\u2019\u201c\u201d\u00ab\u00bb\u2026\u00a0]/g, (c) => EQUIVALENTES[c])
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '?');
}

/**
 * Fecha y hora en huso de Colombia, no en UTC (AC1).
 *
 * Un certificado descargado a las 8 p.m. de Bogotá lleva fecha del día siguiente si se formatea en
 * UTC. En un documento que sirve de evidencia frente al cliente, la fecha equivocada no es un detalle
 * cosmético.
 */
export function fechaHoraColombia(d: Date): string {
  const f = new Intl.DateTimeFormat('es-CO', {
    timeZone: TZ_COLOMBIA,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const p = (t: string) => f.find((x) => x.type === t)?.value ?? '';
  return `${p('day')}/${p('month')}/${p('year')} ${p('hour')}:${p('minute')}:${p('second')} (hora de Colombia)`;
}

const RESULTADO_LABEL: Record<ResultadoCampo, string> = {
  coincide: 'Coincide',
  difiere: 'Difiere',
  no_verificable: 'No reportado por el RUNT',
  sin_dato_flito: 'Sin dato en FLITO',
};

export interface CertificadoPdfDatos {
  /** Datos de la certificación persistida — congelados, iguales en toda descarga (AC4). */
  placaConsultada: string;
  documentoConsultado: string;
  tipoDocPropietario: string | null;
  propietarioNombre: string | null;
  campos: ComparacionCampo[];
  certificadoPorNombre: string;
  certificadoEn: Date;
  /** Datos de ESTA descarga. Cambian entre una y otra: son metadatos de generación, no evidencia. */
  generadoPor: string;
  generadoEn: Date;
}

function texto(page: PDFPage, s: string, x: number, y: number, size: number, font: PDFFont, color = NEGRO): void {
  page.drawText(sanitize(s), { x, y, size, font, color });
}

/** Corta a lo que quepa en `ancho` y marca el recorte, para que ninguna celda invada la vecina. */
function recortar(s: string, font: PDFFont, size: number, ancho: number): string {
  const limpio = sanitize(s);
  if (font.widthOfTextAtSize(limpio, size) <= ancho) return limpio;
  let corte = limpio;
  while (corte.length > 1 && font.widthOfTextAtSize(`${corte}...`, size) > ancho) corte = corte.slice(0, -1);
  return `${corte}...`;
}

/**
 * Bloque de propietario (AC2).
 *
 * El reparto de responsabilidad es el punto entero de este bloque: el DOCUMENTO quedó validado
 * —el RUNT solo responde si esa pareja placa+documento es la del propietario registrado (RN-02)— y el
 * NOMBRE no lo verificó nadie, porque la consulta de vehículo no lo devuelve. Presentar el nombre
 * como «verificado contra el RUNT» sería falsear la evidencia, que es exactamente lo que este
 * documento existe para no hacer.
 */
function armarPropietario(datos: CertificadoPdfDatos): { etiqueta: string; valor: string }[] {
  return [
    { etiqueta: 'Nombre (dato de FLITO)', valor: datos.propietarioNombre || 'No registrado en FLITO' },
    { etiqueta: 'Documento (validado ante el RUNT)', valor: datos.documentoConsultado },
    ...(datos.tipoDocPropietario ? [{ etiqueta: 'Tipo de documento (RUNT)', valor: datos.tipoDocPropietario }] : []),
  ];
}

export async function construirCertificadoPdf(datos: CertificadoPdfDatos): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Certificado RUNT ${sanitize(datos.placaConsultada)}`);
  doc.setAuthor(ORIGEN);
  doc.setProducer(ORIGEN);
  doc.setCreationDate(datos.generadoEn);

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([A4_W, A4_H]);

  let y = A4_H - MARGEN;

  // --- Cabecera -------------------------------------------------------------------------------
  texto(page, ORIGEN, MARGEN, y, 16, bold);
  texto(page, 'Certificado de verificacion ante el RUNT', MARGEN, y - 20, 13, bold);
  texto(page, `Placa ${datos.placaConsultada}`, MARGEN, y - 38, 11, font, GRIS);
  page.drawLine({
    start: { x: MARGEN, y: y - 50 }, end: { x: A4_W - MARGEN, y: y - 50 },
    thickness: 1, color: GRIS_CLARO,
  });
  y -= 72;

  // --- Metadatos de generación ----------------------------------------------------------------
  // Separados a propósito de los datos certificados: estos cambian en cada descarga (AC4).
  const meta: [string, string][] = [
    ['Origen', ORIGEN],
    ['Generado el', fechaHoraColombia(datos.generadoEn)],
    ['Generado por', datos.generadoPor],
    ['Certificado el', fechaHoraColombia(datos.certificadoEn)],
    ['Certificado por', datos.certificadoPorNombre],
  ];
  for (const [k, v] of meta) {
    texto(page, `${k}:`, MARGEN, y, 9, bold, GRIS);
    texto(page, recortar(v, font, 9, ANCHO_UTIL - 130), MARGEN + 130, y, 9, font);
    y -= 14;
  }
  y -= 14;

  // --- Tabla de comparación del vehículo ------------------------------------------------------
  texto(page, 'DATOS DEL VEHICULO VERIFICADOS', MARGEN, y, 10, bold);
  y -= 16;

  const COLS = [
    { titulo: 'Campo', x: MARGEN, ancho: 70 },
    { titulo: 'Dato en FLITO', x: MARGEN + 70, ancho: 145 },
    { titulo: 'Dato en el RUNT', x: MARGEN + 215, ancho: 145 },
    { titulo: 'Resultado', x: MARGEN + 360, ancho: ANCHO_UTIL - 360 },
  ];

  page.drawRectangle({ x: MARGEN, y: y - 4, width: ANCHO_UTIL, height: 16, color: rgb(0.95, 0.95, 0.95) });
  for (const c of COLS) texto(page, c.titulo, c.x + 4, y, 8.5, bold, GRIS);
  y -= 20;

  for (const campo of datos.campos) {
    const celdas = [
      CAMPO_CERTIFICACION_LABEL[campo.campo] ?? campo.campo,
      campo.valorFlito ?? '—',
      campo.valorRunt ?? '—',
      RESULTADO_LABEL[campo.resultado] ?? campo.resultado,
    ];
    // Solo se resalta lo que impidió o pudo impedir certificar. Pintar de color los seis campos
    // haría que el que importa dejara de saltar a la vista.
    const color = campo.resultado === ResultadoCampo.DIFIERE && campo.bloqueante ? rgb(0.7, 0.1, 0.1) : NEGRO;
    COLS.forEach((c, i) => texto(page, recortar(celdas[i], font, 8.5, c.ancho - 8), c.x + 4, y, 8.5, font, color));
    page.drawLine({
      start: { x: MARGEN, y: y - 5 }, end: { x: A4_W - MARGEN, y: y - 5 },
      thickness: 0.4, color: GRIS_CLARO,
    });
    y -= 18;
  }
  y -= 12;

  // --- Propietario ----------------------------------------------------------------------------
  texto(page, 'PROPIETARIO', MARGEN, y, 10, bold);
  y -= 16;
  for (const { etiqueta, valor } of armarPropietario(datos)) {
    texto(page, `${etiqueta}:`, MARGEN, y, 9, bold, GRIS);
    texto(page, recortar(valor, font, 9, ANCHO_UTIL - 200), MARGEN + 200, y, 9, font);
    y -= 14;
  }
  y -= 6;

  const NOTA_PROPIETARIO = 'El documento del propietario quedo validado contra el RUNT: la consulta se '
    + 'autentica con placa y documento, y el RUNT solo responde si corresponden al propietario '
    + 'registrado. El nombre proviene de los registros de FLITO y no fue verificado contra el RUNT, '
    + 'porque la consulta de vehiculo no lo devuelve.';
  y = parrafo(page, NOTA_PROPIETARIO, MARGEN, y, 7.5, font, GRIS, ANCHO_UTIL);

  // --- Pie ------------------------------------------------------------------------------------
  const pie = 'Documento generado en caliente por FLITO a partir de la consulta al RUNT registrada en la '
    + 'fecha de certificacion. No se almacena copia: cada descarga lo reconstruye desde esa misma consulta.';
  parrafo(page, pie, MARGEN, MARGEN + 24, 7, font, GRIS, ANCHO_UTIL);

  return Buffer.from(await doc.save());
}

/** Escribe `text` ajustado a `ancho` y devuelve la `y` libre debajo. */
function parrafo(
  page: PDFPage, text: string, x: number, y: number, size: number, font: PDFFont, color: ReturnType<typeof rgb>, ancho: number,
): number {
  const palabras = sanitize(text).split(/\s+/);
  let linea = '';
  let cursor = y;
  for (const p of palabras) {
    const tentativa = linea ? `${linea} ${p}` : p;
    if (font.widthOfTextAtSize(tentativa, size) > ancho) {
      page.drawText(linea, { x, y: cursor, size, font, color });
      cursor -= size + 3;
      linea = p;
    } else {
      linea = tentativa;
    }
  }
  if (linea) {
    page.drawText(linea, { x, y: cursor, size, font, color });
    cursor -= size + 3;
  }
  return cursor;
}
