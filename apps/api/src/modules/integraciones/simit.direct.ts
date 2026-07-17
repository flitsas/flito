// SIMIT directo — port de CEA services.cjs + consulta-internal (F2).

import { Worker } from 'worker_threads';
import https from 'https';
import { httpsJson } from './http.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('simit-direct');

export interface SimitComparendo {
  numero: string; codigo: string; codigoInfraccion: string; descripcionInfraccion: string | null;
  fechaComparendo: string | null; organismo: string | null; monto: number; estado: string | null; placa: string | null;
}

function simitSolvePow(question: string, t: number, difficulty: number): Promise<Array<{ question: string; time: number; nonce: number }>> {
  return new Promise((resolve, reject) => {
    const workerCode = `
      const { parentPort, workerData } = require("worker_threads");
      const crypto = require("crypto");
      function isPrime(n) { if(n<2)return false; if(n===2)return true; if(n%2===0)return false; for(let i=3;i*i<=n;i+=2)if(n%i===0)return false; return true; }
      const { question, t, difficulty } = workerData;
      let nonce = 1; const verification = [];
      for (let d = 0; d < difficulty; d++) {
        nonce++;
        while (true) {
          const obj = { question, time: t, nonce };
          const hash = crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex");
          if (hash.startsWith("0000") && isPrime(nonce)) { verification.push(obj); break; }
          nonce++;
        }
      }
      parentPort.postMessage(verification);
    `;
    const worker = new Worker(workerCode, { eval: true, workerData: { question, t, difficulty } });
    const timeout = setTimeout(() => { worker.terminate(); reject(new Error('SIMIT PoW timeout (30s)')); }, 30_000);
    worker.on('message', (result) => { clearTimeout(timeout); resolve(result); });
    worker.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

async function simitChallenge(): Promise<any> {
  const boundary = `----SimitBoundary${Date.now()}`;
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="endpoint"\r\n\r\nquestion\r\n--${boundary}--\r\n`;
  return new Promise((resolve, reject) => {
    const u = new URL('https://qxcaptcha.fcm.org.co/api.php');
    const rq = https.request({
      method: 'POST', hostname: u.hostname, path: u.pathname,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/121 Safari/537.36',
        Referer: 'https://www.fcm.org.co/simit/', Origin: 'https://www.fcm.org.co',
      },
    }, (r2) => {
      let d = '';
      r2.on('data', (c) => (d += c));
      r2.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); } });
    });
    rq.on('error', reject);
    rq.write(body);
    rq.end();
  });
}

function normalizeComparendos(raw: any): SimitComparendo[] {
  const d = raw || {};
  const fuentes = []
    .concat(Array.isArray(d.comparendos) ? d.comparendos : [])
    .concat(Array.isArray(d.multas) ? d.multas : []);
  return fuentes.flatMap((c: any) => {
    const infs = Array.isArray(c.infracciones) && c.infracciones.length ? c.infracciones : [null];
    const numero = c.numeroComparendo || c.comparendo || c.numero || c.numeroMulta || c.consecutivo || '';
    const organismo = c.secretariaNombre || c.secretaria || c.organismoTransito || c.organismo || null;
    const fecha = c.fechaComparendo || c.fechaImposicion || c.fecha || null;
    const estado = c.estado || c.estadoCartera || c.estadoComparendo || null;
    return infs.map((inf: any) => {
      const cod = (inf && (inf.codigoInfraccion || inf.codigo)) || c.codigoInfraccion || c.codigo || '';
      return {
        numero, codigo: cod, codigoInfraccion: cod,
        descripcionInfraccion: (inf && inf.descripcionInfraccion) || c.descripcionInfraccion || null,
        fechaComparendo: fecha, organismo,
        monto: Number((inf && inf.valorInfraccion) ?? c.valorAPagar ?? c.valor ?? c.monto ?? 0) || 0,
        estado, placa: c.placa || null,
      };
    });
  });
}

export async function consultarSimitDirect(filtro: string): Promise<{
  ok: boolean; total: number; totalMonto: number; comparendos: SimitComparendo[]; message?: string;
}> {
  if (!filtro) return { ok: false, total: 0, totalMonto: 0, comparendos: [], message: 'Documento o placa requerido' };
  try {
    const t = Math.floor(Date.now() / 1000);
    const challenge = await simitChallenge();
    if (challenge.error || !challenge.data?.question) {
      return { ok: false, total: 0, totalMonto: 0, comparendos: [], message: 'No se pudo obtener challenge SIMIT' };
    }
    const { question, recommended_difficulty } = challenge.data;
    const verification = await simitSolvePow(question, t, recommended_difficulty || 2);
    const r = await httpsJson('POST',
      'https://consultasimit.fcm.org.co/simit/microservices/estado-cuenta-simit/estadocuenta/consulta',
      { filtro, reCaptchaDTO: { response: JSON.stringify(verification), consumidor: '2' } },
      {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/121 Safari/537.36',
        Referer: 'https://www.fcm.org.co/simit/', Origin: 'https://www.fcm.org.co',
      },
    );
    if (r.status !== 200) {
      return { ok: false, total: 0, totalMonto: 0, comparendos: [], message: 'SIMIT no respondió' };
    }
    const comparendos = normalizeComparendos(r.data);
    const totalMonto = comparendos.reduce((s, c) => s + (Number(c.monto) || 0), 0);
    log.info({ total: comparendos.length, via: 'direct' }, 'consulta simit');
    return { ok: true, total: comparendos.length, totalMonto, comparendos };
  } catch (e: any) {
    log.warn({ err: e?.message }, 'simit direct');
    return { ok: false, total: 0, totalMonto: 0, comparendos: [], message: e?.message || 'SIMIT no disponible' };
  }
}
