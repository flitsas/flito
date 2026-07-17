// TRAM-TRASPASO-P1 — consulta impuesto vehicular directa (sin proxy CEA).
// Caldas: API pública rentas.caldas.gov.co. Antioquia: manual hasta integración headless.

import https from 'node:https';
import { loggerFor } from '../../shared/logger.js';
import {
  departamentoKeyFromOrganismoCodigo,
  type ImpuestoConsultaDatosLike,
} from '@operaciones/shared-types';

const log = loggerFor('impuesto-vehicular-direct');

export type ImpuestoConsultaDatos = ImpuestoConsultaDatosLike & Record<string, unknown>;

export interface ImpuestoConsultaInput {
  placa: string;
  docNumber?: string;
  organismoCodigo?: string | null;
  departamento?: string;
}

export type ImpuestoConsultaResult =
  | { ok: true; fuente: string; datos: ImpuestoConsultaDatos; advertencia?: string | null }
  | { ok: false; code: 'invalid_input' | 'upstream_error' | 'upstream_timeout' | 'upstream_network'; status: number; error: string };

type DeptKey = 'caldas' | 'antioquia';

const TARIFAS_DEPT = {
  caldas: {
    nombre: 'Caldas',
    rangos: [
      { hasta: 57_349_000, tarifa: 1.5 },
      { hasta: 129_032_000, tarifa: 2.5 },
      { hasta: 999_999_999, tarifa: 3.5 },
    ],
    moto: 1.5,
    descuentoProntoPago: { pct: 10, hastaFecha: '04-06' },
    interesMoraMensual: 1.5,
    vencimiento: '06-30',
    apiPublica: 'caldas' as const,
  },
  antioquia: {
    nombre: 'Antioquia',
    rangos: [
      { hasta: 57_349_000, tarifa: 1.5 },
      { hasta: 129_032_000, tarifa: 2.5 },
      { hasta: 999_999_999, tarifa: 3.5 },
    ],
    moto: 1.5,
    descuentoProntoPago: { pct: 10, hastaFecha: '04-30' },
    interesMoraMensual: 1.5,
    vencimiento: '07-31',
    apiPublica: 'antioquia' as const,
  },
} satisfies Record<DeptKey, {
  nombre: string;
  rangos: { hasta: number; tarifa: number }[];
  moto: number;
  descuentoProntoPago: { pct: number; hastaFecha: string };
  interesMoraMensual: number;
  vencimiento: string;
  apiPublica: 'caldas' | 'antioquia';
}>;

function calcularImpuestoDept(avaluo: number, tipoVehiculo: string, vigencia: number, deptKey: DeptKey) {
  const dept = TARIFAS_DEPT[deptKey];
  let tarifa: number;
  if (tipoVehiculo === 'moto') {
    tarifa = dept.moto;
  } else {
    tarifa = dept.rangos[dept.rangos.length - 1].tarifa;
    for (const r of dept.rangos) {
      if (avaluo <= r.hasta) { tarifa = r.tarifa; break; }
    }
  }
  const valorBase = Math.round(Math.round(avaluo * tarifa / 100) / 1000) * 1000;
  const hoy = new Date();
  const [mm, dd] = dept.descuentoProntoPago.hastaFecha.split('-').map(Number);
  const limPronto = new Date(vigencia, mm - 1, dd, 23, 59, 59);
  const descuento = hoy <= limPronto ? Math.round(valorBase * dept.descuentoProntoPago.pct / 100 / 1000) * 1000 : 0;
  const [vmm, vdd] = dept.vencimiento.split('-').map(Number);
  const venc = new Date(vigencia, vmm - 1, vdd);
  let mesesMora = 0;
  let intereses = 0;
  if (hoy > venc) {
    mesesMora = Math.max(1, Math.floor((hoy.getTime() - venc.getTime()) / (1000 * 60 * 60 * 24 * 30)));
    intereses = Math.round(valorBase * dept.interesMoraMensual / 100 * mesesMora / 1000) * 1000;
  }
  return { tarifa, valorBase, descuento, intereses, mesesMora, total: valorBase - descuento + intereses };
}

function httpsPostJson(hostname: string, path: string, bodyObj: unknown, timeoutMs = 12_000): Promise<{ status: number; json: any }> {
  const body = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Origin: `https://${hostname}`,
        Referer: `https://${hostname}/`,
        'User-Agent': 'Kyverum-Operaciones/1.0',
      },
      rejectUnauthorized: false,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) }); }
        catch (e) {
          reject(new Error(`JSON parse: ${(e as Error).message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

function parsearValor(v: unknown): number {
  return Math.round(parseFloat(String(v ?? '0').replace(/[^0-9.]/g, '')) || 0);
}

async function consultarRentasCaldas(placa: string) {
  const r = await httpsPostJson('rentas.caldas.gov.co', '/api-caldas/vehicle/consultVehicle', {
    idempr: 2,
    countryId: 18,
    plate: placa,
    ownerDocument: null,
    validationRules: { sodo_f: 'N' },
    idsesi: 0,
  });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const j = r.json;
  if (!j.status) return null;
  const d = j.data || {};
  const liqResp = (j.liquitadion || {}).response || '';
  const estadoPago = liqResp === 'S' ? 'Pendiente' : liqResp === 'N' ? 'Pagado' : 'Pendiente';
  let totalLiquidado = 0;
  let avaluoLiquidado = 0;
  if (d.secuen) {
    try {
      const lr = await httpsPostJson('rentas.caldas.gov.co', '/api-caldas/vehicle/liquidatePlate', {
        idempr: 2,
        secuen: d.secuen,
        idsesi: 0,
      });
      if (lr.json?.status && lr.json.data) {
        const ld = lr.json.data;
        totalLiquidado = parsearValor(ld.totl_m || ld.total || ld.vliq_m || ld.valo_m || '0');
        avaluoLiquidado = parsearValor(ld.aval_m || ld.vlco_m || ld.vlrf_m || '0');
      }
    } catch (e) {
      log.warn({ err: (e as Error).message, placa }, 'Caldas liquidatePlate falló');
    }
  }
  const esMotos = String(d.clas_m || '').toLowerCase().includes('moto') || String(d.tive_m || '').toLowerCase().includes('moto');
  const avaluo = avaluoLiquidado || parsearValor(d.vlrf_m || d.vlco_m || d.vaco_m || '0');
  const dt = j.dataTercero || {};
  return {
    placa: String(d.vehi_m || placa).toUpperCase(),
    propietario: d.nomb_m || '',
    docNumber: d.docu_m || '',
    marca: d.marc_m || '',
    linea: d.line_m || '',
    modelo: d.mode_m || '',
    cilindraje: parseInt(String(d.cili_m || '0'), 10) || 0,
    tipoVehiculo: esMotos ? 'moto' : 'auto',
    clase: d.clas_m || '',
    carroceria: d.carr_m || '',
    servicio: d.serv_m || '',
    avaluo,
    totalLiquidado,
    estadoVehiculo: d.vest_m || '',
    estadoPago,
    liquidacionResponse: liqResp,
    secuencia: d.secuen || '',
    direccion: d.dire_m || dt.dire_m || '',
    municipio: dt.muni_m || 'VILLAMARIA',
    codigoDANE: String(dt.muni_f || '17873').padStart(6, '0'),
    telefono: d.tele_m || dt.tele_m || '',
  };
}

function manualFallback(placa: string, deptKey: DeptKey, advertencia: string): ImpuestoConsultaResult {
  const dept = TARIFAS_DEPT[deptKey];
  return {
    ok: true,
    fuente: 'Manual',
    datos: { placa, vigencia: new Date().getFullYear(), departamento: dept.nombre },
    advertencia,
  };
}

export async function consultarImpuestoVehicularDirect(input: ImpuestoConsultaInput): Promise<ImpuestoConsultaResult> {
  const placa = input.placa?.trim().toUpperCase();
  if (!placa || placa.length < 4) {
    return { ok: false, code: 'invalid_input', status: 400, error: 'Placa requerida (mínimo 4 caracteres)' };
  }

  const deptKey = (input.departamento || departamentoKeyFromOrganismoCodigo(input.organismoCodigo)).toLowerCase() as DeptKey;
  const dept = TARIFAS_DEPT[deptKey] ?? TARIFAS_DEPT.caldas;
  const vigencia = new Date().getFullYear();
  const reqDocNumber = input.docNumber?.trim() || '';

  if (dept.apiPublica === 'caldas') {
    try {
      const datos = await consultarRentasCaldas(placa);
      if (datos) {
        const calc = calcularImpuestoDept(datos.avaluo, datos.tipoVehiculo, vigencia, 'caldas');
        const totalFinal = datos.totalLiquidado > 0 ? datos.totalLiquidado : calc.total;
        return {
          ok: true,
          fuente: 'Gobernación Caldas',
          datos: {
            placa: datos.placa,
            propietario: datos.propietario,
            docNumber: datos.docNumber,
            marca: datos.marca,
            linea: datos.linea,
            modelo: datos.modelo,
            cilindraje: datos.cilindraje,
            tipoVehiculo: datos.tipoVehiculo,
            clase: datos.clase,
            carroceria: datos.carroceria,
            servicio: datos.servicio,
            avaluo: datos.avaluo,
            vigencia,
            departamento: dept.nombre,
            valorImpuesto: calc.valorBase,
            descuentoProntoPago: calc.descuento,
            intereses: calc.intereses,
            mesesMora: calc.mesesMora,
            totalPagar: totalFinal,
            estadoVehiculo: datos.estadoVehiculo,
            estadoPago: datos.estadoPago,
            liquidacionResponse: datos.liquidacionResponse,
            secuencia: datos.secuencia,
            direccion: datos.direccion,
            municipio: datos.municipio,
            codigoDANE: datos.codigoDANE,
            telefono: datos.telefono,
          },
          advertencia: datos.avaluo === 0 ? 'Avalúo no disponible — ingrese manualmente para calcular' : null,
        };
      }
    } catch (e) {
      const msg = (e as Error).message || '';
      log.warn({ placa, err: msg }, 'Caldas API falló');
      if (msg.includes('timeout')) {
        return { ok: false, code: 'upstream_timeout', status: 504, error: 'La consulta de impuesto superó el tiempo de espera. Reintenta.' };
      }
      return { ok: false, code: 'upstream_network', status: 502, error: 'No se pudo contactar la API de impuesto vehicular (Caldas). Reintenta o registre paz y salvo manual.' };
    }
  }

  if (dept.apiPublica === 'antioquia') {
    if (!reqDocNumber) {
      return manualFallback(placa, 'antioquia', 'Ingrese la cédula del propietario para consultar en Antioquia');
    }
    return manualFallback(
      placa,
      'antioquia',
      'Consulta automática Antioquia no disponible en Operaciones. Registre paz y salvo manualmente o adjunte soporte.',
    );
  }

  return manualFallback(placa, deptKey in TARIFAS_DEPT ? deptKey : 'caldas', 'No se encontraron datos automáticos. Complete manualmente.');
}
