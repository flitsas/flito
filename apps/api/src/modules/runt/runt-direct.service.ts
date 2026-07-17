// RUNT directo — port externalApis.cjs (captcha Anthropic + consulta vehículo/persona).

import { env } from '../../config/env.js';
import { httpsJson, type HttpResponse } from '../integraciones/http.js';
import { loggerFor } from '../../shared/logger.js';
import { tiposPersonaAIntentar, tiposVehiculoAIntentar } from './runt-tipo-doc.js';

const log = loggerFor('runt-direct');

const RUNT_BASE = 'https://runtproapi.runt.gov.co/CYRConsultaCiudadanoMS';
const RUNT_HDRS = { Accept: 'application/json', Origin: 'https://portalpublico.runt.gov.co', Referer: 'https://portalpublico.runt.gov.co/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36' };
const RUNT_VEH_BASE = 'https://runtproapi.runt.gov.co/CYRConsultaVehiculoMS';
const RUNT_VEH_HDRS = { ...RUNT_HDRS, 'Content-Type': 'application/json', 'x-funcionalidad': 'consulta-vehiculo' };

async function solveImageCaptcha(base64Image: string): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY requerida para captcha RUNT');
  const rawB64 = base64Image.replace(/^data:image\/[a-z]+;base64,/, '');
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await httpsJson('POST', 'https://api.anthropic.com/v1/messages', {
      model: env.ANTHROPIC_MODEL_HAIKU, max_tokens: 16,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: rawB64 } },
        { type: 'text', text: 'Responde SOLO con el texto exacto del captcha, sin espacios ni explicaciones. Preserva exactamente las mayúsculas y minúsculas.' },
      ] }],
    }, { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' });
    const errType = r.data?.error?.type;
    if (errType === 'overloaded_error' || errType === 'rate_limit_error') {
      if (attempt < 4) { await new Promise((res) => setTimeout(res, 1000 * attempt)); continue; }
    }
    const text = r.data?.content?.[0]?.text?.trim();
    if (text && text.length >= 3) return text;
    if (attempt < 4) await new Promise((res) => setTimeout(res, 800 * attempt));
  }
  throw new Error('No se pudo resolver captcha RUNT');
}

async function runtAuthWithType(documento: string, tipoDoc: string): Promise<{ ok: boolean; authR?: HttpResponse; notFound?: boolean }> {
  const captchaR = await httpsJson('GET', `${RUNT_BASE}/captcha/libre-captcha/generar`, null, RUNT_HDRS);
  if (!captchaR.data?.imagen || !captchaR.data?.id) return { ok: false };
  let captchaId = captchaR.data.id;
  let captchaImg = captchaR.data.imagen;
  const setCookieHdr = captchaR.headers?.['set-cookie'];
  let runtCookie = setCookieHdr ? (Array.isArray(setCookieHdr) ? setCookieHdr : [setCookieHdr]).map((c) => String(c).split(';')[0]).join('; ') : null;
  let authR: HttpResponse | null = null;
  let lastDescripcion: string | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      const retryR = await httpsJson('GET', `${RUNT_BASE}/captcha/libre-captcha/generar`, null, RUNT_HDRS);
      if (!retryR.data?.imagen || !retryR.data?.id) break;
      captchaId = retryR.data.id; captchaImg = retryR.data.imagen;
      const sc2 = retryR.headers?.['set-cookie'];
      runtCookie = sc2 ? (Array.isArray(sc2) ? sc2 : [sc2]).map((c) => String(c).split(';')[0]).join('; ') : null;
    }
    const captchaText = await solveImageCaptcha(captchaImg);
    const authHdrs: Record<string, string> = { ...RUNT_HDRS, 'Content-Type': 'application/json' };
    if (runtCookie) authHdrs.Cookie = runtCookie;
    authR = await httpsJson('POST', `${RUNT_BASE}/auth`, {
      tipoDocumento: tipoDoc, noDocumento: documento, captcha: captchaText, idLibreCaptcha: captchaId,
      valueCaptchaEncripted: '', reCaptcha: null,
    }, authHdrs);
    if (authR.status === 200 && !authR.data?.error) return { ok: true, authR };
    lastDescripcion = authR.data?.descripcionRespuesta || lastDescripcion;
    if (!authR.data?.descripcionRespuesta?.toLowerCase().includes('captcha')) break;
  }
  const desc = String(lastDescripcion || '').toLowerCase();
  const isNotFound = authR && authR.status === 200 && (desc.includes('no se encontr') || desc.includes('no existe') || desc.includes('no registr'));
  if (isNotFound) return { ok: false, notFound: true };
  return { ok: false, authR: authR || undefined };
}

async function runtVehWithType(placaNorm: string | null, documento: string, tipoDoc: string, configuracion: any, vinNorm: string | null) {
  const capR = await httpsJson('GET', `${RUNT_VEH_BASE}/captcha/libre-captcha/generar`, null, RUNT_VEH_HDRS);
  if (capR.status !== 200 || !capR.data?.imagen) return { ok: false, error: 'No se pudo generar captcha' };
  let captchaId = capR.data.id;
  let captchaImg = capR.data.imagen;
  const setCookieHdr = capR.headers?.['set-cookie'];
  let cookie = setCookieHdr ? (Array.isArray(setCookieHdr) ? setCookieHdr : [setCookieHdr]).map((c) => String(c).split(';')[0]).join('; ') : null;
  let lastR: HttpResponse | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      const retryR = await httpsJson('GET', `${RUNT_VEH_BASE}/captcha/libre-captcha/generar`, null, RUNT_VEH_HDRS);
      if (!retryR.data?.imagen || !retryR.data?.id) break;
      captchaId = retryR.data.id; captchaImg = retryR.data.imagen;
      const sc2 = retryR.headers?.['set-cookie'];
      cookie = sc2 ? (Array.isArray(sc2) ? sc2 : [sc2]).map((c) => String(c).split(';')[0]).join('; ') : null;
    }
    const captchaText = await solveImageCaptcha(captchaImg);
    const hdrs: Record<string, string> = { ...RUNT_VEH_HDRS };
    if (cookie) hdrs.Cookie = cookie;
    const body = {
      procedencia: 'NACIONAL', tipoConsulta: vinNorm ? '2' : '1', aseguradora: '', captcha: captchaText,
      configuracion, documento: vinNorm ? '' : documento, idLibreCaptcha: captchaId,
      placa: vinNorm ? '' : placaNorm, reCaptcha: null, rtm: null, soat: null,
      tipoDocumento: vinNorm ? '' : tipoDoc, valueCaptchaEncripted: '', verBannerSoat: true, vin: vinNorm || null,
    };
    const r = await httpsJson('POST', `${RUNT_VEH_BASE}/auth`, body, hdrs);
    if (r.data?.codigoResultado === 'OK' || (r.data?.error === false && r.data?.infoVehiculo)) {
      return { ok: true, vehiculo: r.data?.infoVehiculo || r.data?.result || r.data, token: r.data?.token || null };
    }
    lastR = r;
    if (!r.data?.descripcionRespuesta?.toLowerCase().includes('captcha')) break;
  }
  return { ok: false, resp: lastR };
}

export async function consultarVehiculoRuntDirect(placa?: string, vin?: string, documento?: string, tipoDocumento?: string) {
  if (!placa && !vin) throw new Error('Placa o VIN requerido');
  if (!vin && !documento) throw new Error('Documento del propietario requerido para consulta por placa');
  const placaNorm = placa ? placa.toUpperCase().replace(/[^A-Z0-9]/g, '') : null;
  const vinNorm = (!placa && vin) ? vin.toUpperCase().replace(/[^A-Z0-9]/g, '') : null;
  let configuracion = { tiempoInactividad: '900', tiempoCuentaRegresiva: '10' };
  try {
    const cfgR = await httpsJson('GET', `${RUNT_VEH_BASE}/configuracion-sesion`, null, RUNT_VEH_HDRS);
    if (cfgR.status === 200 && cfgR.data) configuracion = cfgR.data;
  } catch { /* default */ }
  const tiposAIntentar = vinNorm ? ['C'] : tiposVehiculoAIntentar(tipoDocumento);
  let lastError = '';
  for (const tipo of tiposAIntentar) {
    const docToSend = vinNorm ? (documento || '') : (documento || '');
    const result = await runtVehWithType(placaNorm, docToSend, tipo, configuracion, vinNorm);
    if (result.ok) {
      let extras: Record<string, unknown> = {};
      if (result.token) {
        const h: Record<string, string> = { ...RUNT_VEH_HDRS, 'Auth-Token': `Bearer ${result.token}` };
        const safe = (r: PromiseSettledResult<HttpResponse>) => r.status === 'fulfilled' ? (r.value?.data ?? null) : null;
        const noErr = (d: any) => (d && !d.statusCode && d.message !== 'Resource not found') ? d : null;
        const hRtm: Record<string, string> = { ...h, 'x-funcionalidad': 'SHELL' };
        const rtmResults = await Promise.allSettled(['N', '0'].map((t) => httpsJson('GET', `${RUNT_VEH_BASE}/rtms?tipo=${t}`, null, hRtm)));
        const rtmAll: any[] = [];
        rtmResults.forEach((r) => {
          const d = safe(r);
          if (d && !d.statusCode && d.error === false && Array.isArray(d.revisiones)) d.revisiones.forEach((rev: any) => { if (rev) rtmAll.push(rev); });
        });
        if (rtmAll.length) extras.rtm = rtmAll;
        const endpoints: [string, string][] = [['soat', '/soat'], ['datosTecnicos', '/datos-tecnicos'], ['solicitudes', '/solicitudes']];
        const results = await Promise.allSettled(endpoints.map(([, ep]) => httpsJson('GET', `${RUNT_VEH_BASE}${ep}`, null, h)));
        endpoints.forEach(([key], i) => { const val = noErr(safe(results[i])); if (val) extras[key] = val; });
      }
      log.info({ placa: placaNorm, via: 'direct' }, 'runt vehiculo');
      return { ok: true, data: { vehiculo: result.vehiculo, tipoDocPropietario: tipo, ...extras } };
    }
    if (result.resp) lastError = result.resp.data?.descripcionRespuesta || result.resp.data?.message || '';
  }
  return { ok: false, message: lastError || 'No se pudo obtener datos del vehiculo.' };
}

export async function consultarPersonaRuntDirect(documento: string, tipoDocumento?: string) {
  if (!documento) throw new Error('Documento requerido');
  const tiposAIntentar = tiposPersonaAIntentar(tipoDocumento);
  let authResult: HttpResponse | null = null;
  let tipoExitoso: string | null = null;
  let lastError = '';
  for (const tipo of tiposAIntentar) {
    const result = await runtAuthWithType(documento, tipo);
    if (result.ok && result.authR) { authResult = result.authR; tipoExitoso = tipo; break; }
    if (result.authR?.data?.descripcionRespuesta) lastError = String(result.authR.data.descripcionRespuesta);
    if (result.notFound) continue;
    const desc = lastError.toLowerCase();
    const isNotFound = desc.includes('no se encuentra') || desc.includes('no encontr') || desc.includes('no existe') || desc.includes('no registr');
    if (!isNotFound && (desc.includes('servicio no disponible') || desc.includes('error del sistema'))) break;
  }
  if (!authResult || !tipoExitoso) {
    const err = lastError.toLowerCase();
    if (err.includes('captcha')) return { ok: false, message: 'No se pudo validar el captcha RUNT. Intente de nuevo.' };
    if (err.includes('anthropic') || err.includes('api key')) return { ok: false, message: 'Servicio RUNT temporalmente no disponible (captcha).' };
    return { ok: false, message: lastError || 'Persona no encontrada en el RUNT' };
  }
  const d = authResult.data || {};
  const token = d.token;
  const persona = {
    nombres: d.nombres || '', apellidos: d.apellidos || '',
    tipoDocumento: tipoExitoso, documento: d.numeroDocumento || documento,
    estadoPersona: d.estadoPersona || '', estadoConductor: d.estadoConductor || '',
    tieneLicencias: d.tieneLicencias || false, idPersona: d.idPersona || '',
    fechaInscripcion: d.fechaInscripcion || '',
  };
  let licencias = null, multas = null, solicitudes = null;
  if (token) {
    const h: Record<string, string> = { ...RUNT_HDRS, 'Auth-Token': `Bearer ${token}` };
    const safe = (r: PromiseSettledResult<HttpResponse>) => r.status === 'fulfilled' ? (r.value?.data || null) : null;
    const [licR, mulR, solR] = await Promise.allSettled([
      persona.tieneLicencias ? httpsJson('GET', `${RUNT_BASE}/consulta-ciudadano/licencias`, null, h) : Promise.resolve({ data: [] } as HttpResponse),
      httpsJson('GET', `${RUNT_BASE}/consulta-ciudadano/multas`, null, h),
      httpsJson('GET', `${RUNT_BASE}/consulta-ciudadano/solicitudes`, null, h),
    ]);
    licencias = safe(licR); multas = safe(mulR); solicitudes = safe(solR);
  }
  log.info({ docPrefix: documento.slice(0, 4), via: 'direct' }, 'runt persona');
  return { ok: true, persona, licencias, multas, solicitudes };
}
