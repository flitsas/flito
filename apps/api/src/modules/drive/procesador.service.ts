// Núcleo del procesamiento de los PDF consolidados del Drive del organismo (HU #11010).
//
// Se extrae de `procesador.routes.ts` porque ahora tiene DOS consumidores con necesidades distintas:
//
//   · Administración → Google Drive: además de registrar los derechos, genera el Excel, los PDF por
//     placa en disco y el ZIP de «REINTEGROS CLIENTES». Alguien usa esos artefactos hoy.
//   · Derechos de tránsito → pestaña del Drive: solo necesita leer y asociar. Ni Excel ni disco.
//
// Lo común es lo caro y lo delicado: bajar el PDF, leer cada página con OCR y agrupar por placa.
// Eso vive aquí; qué se hace después con el resultado lo decide cada consumidor.

import https from 'https';
import { CampoDerechoTramite, type ExtraccionDerechoTramite } from '@operaciones/shared-types';
import { downloadFile } from '../../services/googleDrive.js';
import { env } from '../../config/env.js';

/** Tope de páginas por PDF: por encima, el coste de OCR se dispara sin aviso. */
export const MAX_PAGINAS = 150;

/**
 * Cuentas individuales en Colombia están en el rango de decenas a centenares de miles. Un valor por
 * encima de este techo casi siempre es una página de resumen que el OCR leyó como si fuera una
 * cuenta: se descarta antes de convertirla en un derecho con un valor inventado.
 */
const VALOR_MAX_INDIVIDUAL = 5_000_000;

export type TipoTramiteCuenta = 'PRENDA' | 'MATRICULA_INICIAL' | 'OTRO' | '';

export interface CuentaCobro {
  pagina: number;
  placa: string;
  propietario: string;
  cedula: string;
  vehiculo: string;
  tipoTramite: TipoTramiteCuenta;
  fechaTramite: string;
  organismo: string;
  marca: string;
  valorTotal: number;
  radicado: string;
}

export function normalizarTipoTramite(raw: unknown): TipoTramiteCuenta {
  const t = String(raw ?? '').toUpperCase().replace(/\s+/g, '_');
  if (t.includes('PRENDA') || t.includes('GRAVAMEN') || t.includes('GARANTIA')) return 'PRENDA';
  if (t.includes('MATRICULA_INICIAL') || t === 'MATRICULA_INICIAL' || t === 'MI') return 'MATRICULA_INICIAL';
  if (t === 'OTRO') return 'OTRO';
  return '';
}

export function etiquetaTipoTramite(t: TipoTramiteCuenta): string {
  if (t === 'PRENDA') return 'PRENDA';
  if (t === 'MATRICULA_INICIAL') return 'MATRICULA INICIAL';
  if (t === 'OTRO') return 'OTRO';
  return '';
}

/**
 * Traduce una cuenta de cobro ya leída al contrato de extracción de derechos de tránsito.
 *
 * La confianza se fija en 0.9 y no en 1: el dato viene de un OCR, no de una persona. Ese 0.9 supera
 * el umbral por defecto (0.85) porque el prompt ya descarta páginas de resumen y valida el rango del
 * total y el formato de la placa; pero un organismo con el umbral subido por encima de 0.9 mandará
 * estas lecturas a revisión, que es justo lo que debe pasar donde no confiamos.
 */
export function extraccionDeCuenta(c: CuentaCobro): ExtraccionDerechoTramite {
  const campo = (valor: string | null) => ({ valor, confianza: valor ? 0.9 : 0, confiable: !!valor });
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(c.fechaTramite) ? c.fechaTramite : null;
  return {
    [CampoDerechoTramite.PLACA]: campo(c.placa || null),
    [CampoDerechoTramite.VALOR_TOTAL]: campo(c.valorTotal > 0 ? String(c.valorTotal) : null),
    [CampoDerechoTramite.FECHA_PAGO]: campo(fecha),
    [CampoDerechoTramite.NUMERO_RADICADO]: campo(c.radicado || null),
    [CampoDerechoTramite.ORGANISMO]: campo(c.organismo || null),
    [CampoDerechoTramite.TIPO_TRAMITE]: campo(etiquetaTipoTramite(c.tipoTramite) || null),
  };
}

const PROMPT = `Analiza esta pagina de un PDF de tramites vehiculares colombianos.

PRIMERO determina que tipo de pagina es:
- TIPO A: "CUENTA DE COBRO" individual — tiene encabezado "CUENTA DE COBRO", logo de alcaldia, UN solo vehiculo con su placa, conceptos desglosados (matricula, expedicion, etc), y un TOTAL A PAGAR al final.
- TIPO B: Pagina de RESUMEN o PORTADA — tiene una LISTA o TABLA con MULTIPLES placas, o dice "TOTAL PAGOS", "CONCESIONARIO", o es un listado tipo Excel con columnas FECHA/PLACA/VALOR.
- TIPO C: Pagina en blanco, indice, o cualquier otra cosa que NO sea una cuenta de cobro individual.

Si es TIPO B o TIPO C, responde inmediatamente: {"placa":"","valorTotal":0}
NO extraigas datos de paginas de resumen aunque tengan placas listadas.

Si es TIPO A (cuenta de cobro individual), extrae CARACTER POR CARACTER:

1. PLACA: formato colombiano 3 letras + 3 numeros (ej: QTP701). Aparece junto a la descripcion del vehiculo en la seccion de datos, o en el campo CEDULA/NIT seguido del numero. NO es el radicado.
2. PROPIETARIO: campo "NOMBRE O RAZON SOCIAL".
3. CEDULA: numero de documento del propietario (solo digitos).
4. VEHICULO: descripcion del vehiculo (marca, clase, tipo, modelo).
5. VALOR TOTAL: el numero en "TOTAL A PAGAR" al final de la cuenta. Numero entero sin puntos ni comas.
6. RADICADO: "RADICADO DE TRAMITE" en la parte superior.
7. TIPO TRAMITE: lee las LINEAS DE CONCEPTOS / desglose de cobro:
   - Si hay PRENDA, INSCRIPCION DE PRENDA, GARANTIA MOBILIARIA o GRAVAMEN (prenda) → "PRENDA"
   - Si solo MATRICULA INICIAL (sin prenda en conceptos) → "MATRICULA_INICIAL"
   - Si ninguno aplica claramente → "OTRO" o ""
8. FECHA TRAMITE: la fecha del tramite / fecha de la cuenta de cobro, en formato YYYY-MM-DD (ej: 2026-05-23). Si solo hay fecha de expedicion, usa esa.
9. ORGANISMO: el organismo o secretaria de transito (municipio) que emite la cuenta — aparece junto al logo de la alcaldia o en el encabezado (ej: PALMIRA, MEDELLIN, BELLO). Solo el nombre del municipio en MAYUSCULAS.
10. MARCA: la marca del vehiculo en MAYUSCULAS (ej: TESLA, CHEVROLET, RENAULT). Extraela de la descripcion del vehiculo.

PRECISION:
- Placa = exactamente 6 caracteres: 3 letras + 3 numeros
- NO confundir O con 0, I con 1, S con 5, B con 8
- El TOTAL A PAGAR es de UNA sola cuenta, NO de un lote completo. Valores tipicos: 100.000 a 500.000 pesos
- Si el valor supera 1.000.000, probablemente es una pagina de resumen → responder {"placa":"","valorTotal":0}

Responde SOLO JSON sin markdown:
{"placa":"ABC123","propietario":"NOMBRE","cedula":"123456","vehiculo":"CAMIONETA MARCA 2026","valorTotal":236700,"radicado":"1005504347","tipoTramite":"MATRICULA_INICIAL","fechaTramite":"2026-05-23","organismo":"PALMIRA","marca":"TESLA"}`;

export class ProcesadorError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface PdfAnalizado {
  /** Nombre del archivo en Drive, tal cual. */
  name: string;
  /** El documento cargado, para que quien llame separe las páginas que necesite. */
  srcDoc: import('pdf-lib').PDFDocument;
  totalPaginas: number;
  /** Una por cada página que resultó ser una cuenta de cobro individual, ordenadas por página. */
  cuentas: CuentaCobro[];
  /** Placa → índices de página (0-based) que le pertenecen. */
  paginasPorPlaca: Map<string, number[]>;
}

/**
 * Baja el PDF del Drive y lo lee página a página con OCR.
 *
 * Es la parte cara: una llamada de OCR por página, en tandas de 5 con pausa entre ellas para no
 * disparar el límite de tasa del proveedor. Una página que falla no tumba el lote — simplemente no
 * produce cuenta, y la página se queda fuera sin ruido.
 */
export async function analizarPdfDeDrive(fileId: string): Promise<PdfAnalizado> {
  const { buffer, name } = await downloadFile(fileId);
  if (!name?.toLowerCase().endsWith('.pdf')) {
    throw new ProcesadorError(400, 'El archivo debe ser PDF');
  }

  const { PDFDocument } = await import('pdf-lib');
  const srcDoc = await PDFDocument.load(buffer);
  const totalPaginas = srcDoc.getPageCount();

  if (totalPaginas > MAX_PAGINAS) {
    throw new ProcesadorError(400, `El PDF tiene ${totalPaginas} páginas. Máximo soportado: ${MAX_PAGINAS}`);
  }

  const cuentas: CuentaCobro[] = [];
  const paginasPorPlaca = new Map<string, number[]>();
  if (totalPaginas === 0) return { name, srcDoc, totalPaginas, cuentas, paginasPorPlaca };

  const procesarPagina = async (i: number): Promise<void> => {
    const singleDoc = await PDFDocument.create();
    const [copiedPage] = await singleDoc.copyPages(srcDoc, [i]);
    singleDoc.addPage(copiedPage);
    const b64 = Buffer.from(await singleDoc.save()).toString('base64');

    const ocrBody = JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: 500,
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
        { type: 'text', text: PROMPT },
      ] }],
    });

    const ocrResult: any = await new Promise((resolve, reject) => {
      const rq = https.request({
        method: 'POST', hostname: 'api.anthropic.com', path: '/v1/messages',
        headers: {
          'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY || '',
          'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(ocrBody),
        },
      }, (r2) => { let d = ''; r2.on('data', (c: string) => d += c); r2.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } }); });
      rq.setTimeout(60000, () => rq.destroy(new Error('Timeout')));
      rq.on('error', reject); rq.write(ocrBody); rq.end();
    });

    const ocrText = ocrResult?.content?.[0]?.text || '';
    let datos: any = null;
    try { datos = JSON.parse(ocrText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()); } catch { /* página ilegible */ }

    const valor = Number(datos?.valorTotal) || 0;
    if (datos?.placa && valor > 0 && valor <= VALOR_MAX_INDIVIDUAL) {
      const placa = String(datos.placa).toUpperCase().replace(/[^A-Z0-9]/g, '');
      cuentas.push({
        pagina: i + 1, placa, propietario: datos.propietario || '', cedula: datos.cedula || '',
        vehiculo: datos.vehiculo || '', tipoTramite: normalizarTipoTramite(datos.tipoTramite),
        fechaTramite: String(datos.fechaTramite || '').trim(),
        organismo: String(datos.organismo || '').trim(),
        marca: String(datos.marca || '').trim(),
        valorTotal: valor, radicado: datos.radicado || '',
      });
      if (!paginasPorPlaca.has(placa)) paginasPorPlaca.set(placa, []);
      paginasPorPlaca.get(placa)!.push(i);
    }
  };

  const CONCURRENCIA = 5;
  for (let inicio = 0; inicio < totalPaginas; inicio += CONCURRENCIA) {
    const fin = Math.min(inicio + CONCURRENCIA, totalPaginas);
    const tareas: Promise<void>[] = [];
    for (let i = inicio; i < fin; i++) tareas.push(procesarPagina(i));
    await Promise.all(tareas);
    if (fin < totalPaginas) await new Promise((r) => setTimeout(r, 500));
  }

  cuentas.sort((a, b) => a.pagina - b.pagina);
  return { name, srcDoc, totalPaginas, cuentas, paginasPorPlaca };
}

/**
 * Separa el consolidado en un PDF por placa, EN MEMORIA.
 *
 * El consumidor de Administración los escribe a disco porque además arma el ZIP; el de derechos solo
 * los necesita para archivarlos en el almacenamiento, y pasar por disco ahí sería un rodeo.
 */
export async function separarPorPlaca(
  srcDoc: import('pdf-lib').PDFDocument,
  paginasPorPlaca: Map<string, number[]>,
): Promise<Map<string, Buffer>> {
  const { PDFDocument } = await import('pdf-lib');
  const salida = new Map<string, Buffer>();
  for (const [placa, paginas] of paginasPorPlaca) {
    const doc = await PDFDocument.create();
    for (const idx of paginas) {
      const [copiada] = await doc.copyPages(srcDoc, [idx]);
      doc.addPage(copiada);
    }
    salida.set(placa, Buffer.from(await doc.save()));
  }
  return salida;
}
