// Fasecolda directo — port CEA services.cjs (token OAuth + buscar scoring).

import { env } from '../../config/env.js';
import { httpsFormPost, httpsJson } from './http.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('fasecolda-direct');
const FASECOLDA_TOKEN_URL = 'https://guiadevalores.fasecolda.com/apifasecolda/token';
const FASECOLDA_API_BASE = 'https://guiadevalores.fasecolda.com/apifasecolda/api';

let _token: string | null = null;
let _tokenExp = 0;

async function getToken(): Promise<string> {
  const now = Date.now();
  if (_token && now < _tokenExp) return _token;
  const user = env.FASECOLDA_USER;
  const pass = env.FASECOLDA_PASS;
  if (!user || !pass) throw new Error('FASECOLDA_USER/FASECOLDA_PASS no configuradas');
  const body = `grant_type=password&username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;
  const r = await httpsFormPost(FASECOLDA_TOKEN_URL, body);
  if (r.status !== 200 || !r.data?.access_token) {
    throw new Error(`Fasecolda token falló: HTTP ${r.status}`);
  }
  const tok = String(r.data.access_token);
  _token = tok;
  _tokenExp = now + ((r.data.expires_in || 86399) - 3600) * 1000;
  return tok;
}

async function fasecoldaApi(path: string): Promise<any> {
  const token = await getToken();
  let r = await httpsJson('GET', FASECOLDA_API_BASE + path, null, { Authorization: `bearer ${token}`, Accept: 'application/json' });
  if (r.status === 401) {
    _token = null;
    const t2 = await getToken();
    r = await httpsJson('GET', FASECOLDA_API_BASE + path, null, { Authorization: `bearer ${t2}`, Accept: 'application/json' });
  }
  return r.data;
}

export interface FasecoldaQuery {
  marca: string; linea?: string; anio: string; cilindraje?: string; combustible?: string; puertas?: string; clase?: string;
}

export async function buscarFasecoldaDirect(q: FasecoldaQuery): Promise<any> {
  if (!q.marca || !q.anio) return { ok: false, message: 'marca y anio requeridos' };
  try {
    const marca = q.marca.trim().toUpperCase();
    const linea = (q.linea || '').trim().toUpperCase();
    const anio = q.anio.trim();
    const cilindrajeRunt = parseInt(q.cilindraje || '0', 10) || 0;
    const combustibleRunt = (q.combustible || '').toUpperCase();
    const puertasRunt = parseInt(q.puertas || '0', 10) || 0;
    const claseRunt = (q.clase || '').toUpperCase();
    const categoriasPorClase = (() => {
      if (/MOTO/.test(claseRunt)) return [3];
      if (/CAMION|TRACTOC|VOLQU/.test(claseRunt)) return [2, 4];
      if (/BUS|MICROB|BUSETA/.test(claseRunt)) return [5];
      if (/CAMIONETA|CAMPERO/.test(claseRunt)) return [1, 2];
      return [1, 2];
    })();
    const idEstado = 0;
    const upper = (s: string) => String(s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const combRuntNorm = combustibleRunt.replace(/[ÁÀÄÂ]/g, 'A').replace(/[ÉÈËÊ]/g, 'E').replace(/[ÍÌÏÎ]/g, 'I').replace(/[ÓÒÖÔ]/g, 'O').replace(/[ÚÙÜÛ]/g, 'U');
    const runtTieneGasolina = /GASOLIN/.test(combRuntNorm);
    const runtTieneDiesel = /DIESEL|DIES\b|ACPM/.test(combRuntNorm);
    const runtTieneElec = /ELEC/.test(combRuntNorm);
    const runtTieneGas = /\bGAS\b|GNV|GLP/.test(combRuntNorm);
    const runtEsHibrido = (runtTieneElec && (runtTieneGasolina || runtTieneDiesel)) || (runtTieneGas && runtTieneGasolina);

    let todasVersiones: any[] = [];
    let mMarcaDet: string | null = null, mRefDet: string | null = null, idCategoriaUsada: number | null = null;

    for (const idCategoria of categoriasPorClase) {
      try {
        const modelos = await fasecoldaApi(`/modelo/getmodelo/${idCategoria}/${idEstado}`);
        const mAnio = (modelos || []).find((m: any) => String(m.nombre || m.modelo || '') === anio);
        if (!mAnio) continue;
        const idModelo = mAnio.id;
        const marcas = await fasecoldaApi(`/marca/getmarca/${idCategoria}/${idEstado}/${idModelo}`);
        const mMarca = (marcas || []).find((m: any) => upper(m.nombre).includes(upper(marca)) || upper(marca).includes(upper(m.nombre)));
        if (!mMarca) continue;
        const idMarca = mMarca.id;
        const refs = await fasecoldaApi(`/referenciauno/getgeferenciauno/${idCategoria}/${idEstado}/${idModelo}/${idMarca}`);
        if (!refs?.length) continue;
        const upLinea = upper(linea);
        const palabraClave = upLinea.split(/\s+/).filter((w) => w.length >= 3)[0] || upLinea;
        let refsCandidatas = refs.filter((r: any) => upper(r.nombre).includes(palabraClave));
        if (refsCandidatas.length === 0 && upLinea) {
          refsCandidatas = refs.filter((r: any) => {
            const rN = upper(r.nombre);
            return upLinea.length >= 4 && (rN.startsWith(upLinea.slice(0, 4)) || upLinea.startsWith(rN.split(' ')[0]));
          });
        }
        if (refsCandidatas.length === 0) refsCandidatas = [refs[0]];
        for (const mRef of refsCandidatas) {
          const codigos = await fasecoldaApi(`/listacodigos/getbuscabasica/${idCategoria}/${idEstado}/${idModelo}/${idMarca}/${encodeURIComponent(mRef.id)}/1`);
          if (Array.isArray(codigos) && codigos.length) {
            codigos.forEach((c: any) => {
              todasVersiones.push({
                codigo: c.codigo,
                descripcion: [c.referenciaUno, c.referenciaDos, c.referenciaTres].filter(Boolean).join(' '),
                valorCOP: Math.round((c.valor || 0) * 1000),
                cilindraje: c.cilindraje || 0, combustible: c.combustible || '',
                tipoCaja: c.tipoCaja || '', puertas: c.puertas || 0, _ref: mRef.nombre,
              });
            });
            if (!mMarcaDet) { mMarcaDet = mMarca.nombre; mRefDet = mRef.nombre; idCategoriaUsada = idCategoria; }
          }
        }
        if (todasVersiones.length > 0) break;
      } catch (e: any) { log.warn({ cat: idCategoria, err: e?.message }, 'fasecolda cat'); }
    }

    if (todasVersiones.length === 0) {
      return { ok: false, message: `Sin códigos Fasecolda para ${marca} ${linea} ${anio}` };
    }

    const scorear = (v: any) => {
      let pts = 0;
      if (cilindrajeRunt > 0 && v.cilindraje > 0) {
        const pct = Math.abs(v.cilindraje - cilindrajeRunt) / cilindrajeRunt;
        if (pct <= 0.03) pts += 100; else if (pct <= 0.07) pts += 70; else if (pct <= 0.15) pts += 30;
      } else if (cilindrajeRunt === 0 && v.cilindraje === 0 && runtTieneElec) pts += 100;
      const combFC = upper(v.combustible);
      if (combFC) {
        let combMatch = false;
        if (runtEsHibrido && /HIBRID|MIXTO/.test(combFC)) { pts += 80; combMatch = true; }
        else if (runtTieneElec && /ELECTRIC/.test(combFC) && !runtTieneGasolina && !runtTieneDiesel) { pts += 80; combMatch = true; }
        else if (runtTieneGasolina && /GASOLIN/.test(combFC)) { pts += 80; combMatch = true; }
        else if (runtTieneDiesel && /DIESEL/.test(combFC)) { pts += 80; combMatch = true; }
        else if (runtTieneGas && /\bGAS\b/.test(combFC)) { pts += 80; combMatch = true; }
        if (!combMatch) pts -= 40;
      }
      if (puertasRunt > 0 && v.puertas > 0) pts += v.puertas === puertasRunt ? 30 : -10;
      if (linea) {
        const palabrasLinea = upper(linea).split(/\s+/).filter((w) => w.length >= 2 && w !== 'DE');
        const hits = palabrasLinea.filter((w) => upper(v.descripcion).includes(w)).length;
        if (hits > 0) pts += hits * 5;
      }
      return pts;
    };

    todasVersiones.forEach((v) => { v._score = scorear(v); });
    todasVersiones.sort((a, b) => b._score - a._score);
    const mejor = todasVersiones[0];
    log.info({ marca, anio, versiones: todasVersiones.length, via: 'direct' }, 'fasecolda buscar');
    return {
      ok: true, marcaDetectada: mMarcaDet, referenciaDetectada: mRefDet, categoriaUsada: idCategoriaUsada, anio,
      mejorMatch: {
        codigo: mejor.codigo, descripcion: mejor.descripcion, valorCOP: mejor.valorCOP,
        cilindraje: mejor.cilindraje, combustible: mejor.combustible, tipoCaja: mejor.tipoCaja,
        puertas: mejor.puertas, score: mejor._score,
      },
      versiones: todasVersiones,
    };
  } catch (e: any) {
    log.warn({ err: e?.message }, 'fasecolda direct');
    return { ok: false, message: e?.message || 'Fasecolda no disponible' };
  }
}
