// HU #14280: la ruta y los mensajes que se escriben en el log, sin el dato que venga en la URL.
//
// `rutaDe` (exigir-funcion.ts) sirve dentro de la cadena de la ruta, pero aquí no alcanza por dos
// motivos: tras `next(err)` Express restaura `req.baseUrl` y `req.params` a los del nivel superior, y
// en un 413 del body-parser no hay `req.route`, así que caería en una heurística que no reconoce un
// token de 16 caracteres ni `<placa>.pdf`. Por eso, sin plantilla no se adivina qué segmento es dato:
// se conserva solo el prefijo del módulo y se descarta el resto.
import type { Request } from 'express';

/** Nombre de recurso: letras en minúscula y separadores. Lo demás (`abc123`, `a.pdf`, `%40`) no pasa. */
const SEGMENTO_RECURSO = /^[a-z]+(?:[-_][a-z0-9]+)*$/;

/** Menos que esto no se reemplaza en un mensaje: un id corto borraría números de línea del stack. */
const MIN_VALOR = 4;
const MIN_VALOR_NUMERICO = 5;

const LARGO_MAX = 300;

function segmentosDe(req: Request): string[] {
  const crudo = req.originalUrl || req.url || req.path || '';
  return crudo.split('?')[0]!.split('/').filter(Boolean);
}

/** La plantilla en segmentos, si es literal y encaja con la URL. Si no (`*`, `?`, RegExp), `null`. */
function plantillaQueEncaja(req: Request, segmentos: string[]): string[] | null {
  const plantilla: unknown = req.route?.path;
  if (typeof plantilla !== 'string' || /[*?()+]/.test(plantilla)) return null;
  const partes = plantilla.split('/').filter(Boolean);
  if (partes.length > segmentos.length) return null;
  const finales = segmentos.slice(segmentos.length - partes.length);
  const encaja = partes.every((p, i) => p.startsWith(':') || p.toLowerCase() === finales[i]!.toLowerCase());
  return encaja ? partes : null;
}

function enmascararSegmento(seg: string): string {
  return SEGMENTO_RECURSO.test(seg) ? seg : '*';
}

/** Cuántos segmentos del prefijo se conservan sin plantilla: `/api/<modulo>` o `/api/flito/<modulo>`. */
function largoPrefijoModulo(segmentos: string[]): number {
  return segmentos[0] === 'api' && segmentos[1] === 'flito' ? 3 : 2;
}

/**
 * La ruta para el log: la plantilla con su prefijo real (`/api/drivers/checklists/qr/:token`) o, sin
 * plantilla fiable, el prefijo del módulo y `*` (`/api/validacion-identidad/*`). Nunca la query.
 */
export function rutaSinDato(req: Request): string {
  const segmentos = segmentosDe(req);
  const partes = plantillaQueEncaja(req, segmentos);
  if (partes) {
    const prefijo = segmentos.slice(0, segmentos.length - partes.length).map(enmascararSegmento);
    return `/${[...prefijo, ...partes].join('/')}`.slice(0, LARGO_MAX);
  }
  const largo = largoPrefijoModulo(segmentos);
  const conservados = segmentos.slice(0, largo).map(enmascararSegmento);
  const resto = segmentos.length > largo ? ['*'] : [];
  return `/${[...conservados, ...resto].join('/')}`.slice(0, LARGO_MAX);
}

function decodificar(valor: string): string {
  try {
    return decodeURIComponent(valor);
  } catch {
    return valor;
  }
}

function valoresDeQuery(query: unknown): string[] {
  if (typeof query === 'string') return [query];
  if (Array.isArray(query)) return query.flatMap(valoresDeQuery);
  if (query && typeof query === 'object') return Object.values(query).flatMap(valoresDeQuery);
  return [];
}

/** Los valores que la petición trae en la URL: segmentos que no son literales de la ruta y query. */
function valoresDeUrl(req: Request): string[] {
  const segmentos = segmentosDe(req);
  const partes = plantillaQueEncaja(req, segmentos);
  const inicio = partes ? segmentos.length - partes.length : largoPrefijoModulo(segmentos);
  const deRuta = segmentos.slice(inicio).filter((_, i) => !partes || partes[i]!.startsWith(':'));
  const prefijoOpaco = segmentos.slice(0, inicio).filter((s) => !SEGMENTO_RECURSO.test(s));
  const crudos = [...deRuta, ...prefijoOpaco, ...valoresDeQuery(req.query)];
  // `<placa>.pdf`: el mensaje puede traer solo la placa.
  const conVariantes = crudos.flatMap((v) => {
    const texto = decodificar(v);
    return [v, texto, texto.replace(/\.[A-Za-z0-9]{1,5}$/, '')];
  });
  const validos = conVariantes.filter((v) => (
    /^\d+$/.test(v) ? v.length >= MIN_VALOR_NUMERICO : v.length >= MIN_VALOR
  ));
  // De más largo a más corto: `ABC123.pdf` se reemplaza entero antes que `ABC123`.
  return [...new Set(validos)].sort((a, b) => b.length - a.length);
}

/** Quita de un texto (mensaje o stack) los valores de la URL, sin distinguir mayúsculas. */
export function textoSinDatoDeUrl(req: Request, texto: string): string {
  return valoresDeUrl(req).reduce((acc, valor) => {
    const escapado = valor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return acc.replace(new RegExp(escapado, 'gi'), '*');
  }, texto);
}
