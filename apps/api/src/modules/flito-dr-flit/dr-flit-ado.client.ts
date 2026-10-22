// Dr. Flit — cliente de FLIT - SOPORTE en Azure DevOps (HU #13804, Feature #13695). Diseño F5,
// «ClienteSoporteAdo», y ADR-0026. Dos adaptadores detrás de una interfaz, elegidos por env:
//
//   · real      `fetch` nativo (sin SDK, sin `shared/upstream.ts` porque ese reintenta).
//   · simulado  sin red; números `900000+`. Prohibido en PDN por el `superRefine` de `env.ts` (AC10):
//               con `DEPLOY_ENVIRONMENT=PDN` la API no arranca, así que aquí no hace falta otra guarda.
//
// RN-DRF-C1  Create: `POST {org}/{proyecto}/_apis/wit/workitems/${tipo}?api-version=7.1`, json-patch.
//            `redirect: 'error'` y `AbortSignal.timeout(DRFLIT_ADO_TIMEOUT_MS)`. Sin reintentos.
// RN-DRF-C2  De la respuesta solo se lee `id` (entero > 0). ADO responde 203 con la página de inicio de
//            sesión cuando el PAT no vale: un 203, un 401/403 o una respuesta que no es JSON con `id`
//            es `AdoRechazoError('ado-auth')`.
// RN-DRF-C3  TF401289 (el tag no existe y no se puede crear con esos permisos): un SEGUNDO create, uno
//            solo, sin la operación `System.Tags`; `tagOmitido=true` y el servicio lo registra como
//            `tag-rechazado`. El caso queda radicado igual.
// RN-DRF-C4  NUNCA se loguean ni viajan en un error: cabeceras (el PAT), URL, cuerpo enviado ni cuerpo
//            recibido. Los mensajes de los errores son fijos y sin `cause`. La URL de ADO no sale de
//            este archivo (la respuesta de la API no lleva URLs ni `_links`).
import { env } from '../../config/env.js';
import { RUTA_TAGS, RUTA_TITULO, type OperacionAdo } from './dr-flit-ado.mapeo.js';

export interface BugSoporteAdo { operaciones: ReadonlyArray<OperacionAdo> }

export interface ClienteSoporteAdo {
  readonly modo: 'real' | 'simulado';
  crearBug(b: BugSoporteAdo): Promise<{ numero: number; tagOmitido: boolean }>;
}

export type ClaseNoDisponible = 'timeout' | 'red' | 'ado-5xx' | 'ado-429';
export type ClaseRechazo = 'ado-4xx' | 'ado-auth';

/** ADO no respondió o está caído: 503 `ado-no-disponible` (reintentable). */
export class AdoNoDisponibleError extends Error {
  constructor(readonly clase: ClaseNoDisponible) {
    super(clase === 'timeout' ? 'ADO no respondió a tiempo' : 'ADO no está disponible');
    this.name = 'AdoNoDisponibleError';
  }
}

/** ADO rechazó la petición (credenciales o contenido): 502 `ado-error`. */
export class AdoRechazoError extends Error {
  constructor(readonly clase: ClaseRechazo) {
    super(clase === 'ado-auth' ? 'ADO rechazó las credenciales' : 'ADO rechazó la petición');
    this.name = 'AdoRechazoError';
  }
}

export interface ConfigClienteAdoReal {
  orgUrl: string;
  proyecto: string;
  pat: string;
  tipo: string;
  timeoutMs: number;
}

/** URL del create. `encodeURIComponent` del proyecto (lleva espacios) y del tipo. */
export function urlCrearBug(c: Pick<ConfigClienteAdoReal, 'orgUrl' | 'proyecto' | 'tipo'>): URL {
  const base = c.orgUrl.endsWith('/') ? c.orgUrl : `${c.orgUrl}/`;
  const u = new URL(`${encodeURIComponent(c.proyecto)}/_apis/wit/workitems/$${encodeURIComponent(c.tipo)}`, base);
  u.searchParams.set('api-version', '7.1');
  return u;
}

const esTimeout = (e: unknown) => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');

export class ClienteSoporteAdoReal implements ClienteSoporteAdo {
  readonly modo = 'real' as const;
  readonly #c: ConfigClienteAdoReal;

  constructor(c: ConfigClienteAdoReal) {
    this.#c = c;
  }

  async crearBug(b: BugSoporteAdo): Promise<{ numero: number; tagOmitido: boolean }> {
    const primera = await this.#crear(b.operaciones);
    if (primera.tipo === 'ok') return { numero: primera.numero, tagOmitido: false };
    const sinTags = b.operaciones.filter((o) => o.path !== RUTA_TAGS);
    if (sinTags.length === b.operaciones.length) throw new AdoRechazoError('ado-4xx');
    const segunda = await this.#crear(sinTags);
    if (segunda.tipo === 'ok') return { numero: segunda.numero, tagOmitido: true };
    throw new AdoRechazoError('ado-4xx');
  }

  async #crear(ops: ReadonlyArray<OperacionAdo>): Promise<{ tipo: 'ok'; numero: number } | { tipo: 'tag' }> {
    let res: Response;
    try {
      res = await fetch(urlCrearBug(this.#c), {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`:${this.#c.pat}`).toString('base64')}`,
          'Content-Type': 'application/json-patch+json',
          Accept: 'application/json',
        },
        body: JSON.stringify(ops),
        redirect: 'error',
        signal: AbortSignal.timeout(this.#c.timeoutMs),
      });
    } catch (e) {
      throw new AdoNoDisponibleError(esTimeout(e) ? 'timeout' : 'red');
    }
    let cuerpo: string;
    try {
      cuerpo = await res.text();
    } catch (e) {
      throw new AdoNoDisponibleError(esTimeout(e) ? 'timeout' : 'red');
    }
    if (res.status === 203 || res.status === 401 || res.status === 403) throw new AdoRechazoError('ado-auth');
    if (res.status === 429) throw new AdoNoDisponibleError('ado-429');
    if (res.status >= 500) throw new AdoNoDisponibleError('ado-5xx');
    if (res.status === 400 && cuerpo.includes('TF401289')) return { tipo: 'tag' };
    if (res.status < 200 || res.status >= 300) throw new AdoRechazoError('ado-4xx');
    const numero = leerId(cuerpo);
    if (numero === null) throw new AdoRechazoError('ado-auth');
    return { tipo: 'ok', numero };
  }
}

/** Solo `id` (entero > 0). Cualquier otra cosa (HTML de inicio de sesión, JSON sin id) → `null`. */
function leerId(cuerpo: string): number | null {
  try {
    const json: unknown = JSON.parse(cuerpo);
    const id = (json as { id?: unknown } | null)?.id;
    return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

/** Primer número del simulado: fuera del rango real de FLIT - SOPORTE, reconocible a simple vista. */
export const PRIMER_NUMERO_SIMULADO = 900_000;

export class ClienteSoporteAdoSimulado implements ClienteSoporteAdo {
  readonly modo = 'simulado' as const;
  #siguiente = PRIMER_NUMERO_SIMULADO;

  constructor(private readonly campoDetalle: string) {}

  async crearBug(b: BugSoporteAdo): Promise<{ numero: number; tagOmitido: boolean }> {
    // Contrato mínimo: sin título o sin detalle, ADO real lo rechazaría.
    const tiene = (p: string) => b.operaciones.some((o) => o.path === p && typeof o.value === 'string' && o.value !== '');
    if (!tiene(RUTA_TITULO) || !tiene(`/fields/${this.campoDetalle}`)) throw new AdoRechazoError('ado-4xx');
    const numero = this.#siguiente;
    this.#siguiente += 1;
    return { numero, tagOmitido: false };
  }
}

let memo: ClienteSoporteAdo | null = null;
let deTests: ClienteSoporteAdo | null = null;

/**
 * Fábrica por env, memoizada. Solo se llama cuando `soporteDisponible()` es `true` (la ruta lo exige
 * antes), así que en modo real el PAT y la organización existen.
 */
export function obtenerClienteSoporteAdo(): ClienteSoporteAdo {
  if (deTests) return deTests;
  if (memo) return memo;
  if (env.DRFLIT_ADO_MODO === 'simulado') {
    memo = new ClienteSoporteAdoSimulado(env.DRFLIT_ADO_CAMPO_DETALLE);
  } else {
    if (!env.DRFLIT_ADO_PAT || !env.DRFLIT_ADO_ORG_URL) throw new AdoNoDisponibleError('red');
    memo = new ClienteSoporteAdoReal({
      orgUrl: env.DRFLIT_ADO_ORG_URL,
      proyecto: env.DRFLIT_ADO_PROJECT,
      pat: env.DRFLIT_ADO_PAT,
      tipo: env.DRFLIT_ADO_TIPO,
      timeoutMs: env.DRFLIT_ADO_TIMEOUT_MS,
    });
  }
  return memo;
}

/** Solo para tests: inyecta un cliente (o `null` para volver a la fábrica). */
export function fijarClienteSoporteAdoParaTests(c: ClienteSoporteAdo | null): void {
  deTests = c;
  memo = null;
}
