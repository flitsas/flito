// Inventario REAL de las rutas de Express de apps/api: monta `createApp()` (sin escuchar ni tocar la BD) y recorre la pila
// de routers. Es la verdad contra la que se compara contracts/openapi/flito-api.v1.yaml. Imprime JSON a stdout:
//   [{ "metodo": "get", "ruta": "/api/health" }, ...]
//
// Uso: npx tsx --tsconfig apps/api/tsconfig.json scripts/contratos/inventario-rutas.mts
// Exige shared-types compilado (`npm run build -w packages/shared-types`).
// Las variables son ficticias: env.ts exige que existan, pero ninguna se usa para conectarse (nada escucha ni consulta).

import { randomBytes } from 'node:crypto';

const llaveAlAzar = () => randomBytes(32).toString('hex');
const ENTORNO_FICTICIO: Record<string, string> = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://inventario:inventario@127.0.0.1:1/inventario',
  JWT_SECRET: llaveAlAzar(),
  RUNT_INTERNAL_KEY: llaveAlAzar(),
  INTEGRACIONES_MODE: 'cea-proxy',
  PII_ENC_KEY: llaveAlAzar(),
  PII_HMAC_KEY: llaveAlAzar(),
  RNDC_ENC_KEY: llaveAlAzar(),
  RNDC_MODE: 'mock',
  SIIGO_ENC_KEY: llaveAlAzar(),
  COMPARENDOS_ENC_KEY: llaveAlAzar(),
  FLIT2_ENC_KEY: llaveAlAzar(),
  S3_ACCESS_KEY: 'inventario',
  S3_SECRET_KEY: llaveAlAzar(),
  PUBLIC_URL: 'https://inventario.example.com',
  CORS_ORIGIN: 'https://inventario.example.com',
  LOG_LEVEL: 'silent',
};
for (const [clave, valor] of Object.entries(ENTORNO_FICTICIO)) process.env[clave] ??= valor;

interface Capa {
  route?: { path: string | RegExp | (string | RegExp)[]; methods: Record<string, boolean> };
  name?: string;
  regexp?: RegExp;
  keys?: { name: string }[];
  handle?: { stack?: Capa[]; fronteraRouter?: { stack?: Capa[] } };
}

/** Prefijo de montaje de un router a partir de la expresión que Express 4 compiló para él. */
function prefijoDe(capa: Capa): string {
  const fuente = capa.regexp?.source ?? '';
  const FIN = String.raw`\/?(?=\/|$)`;
  if (fuente === `^${FIN}` || fuente === String.raw`^\/?$`) return '';
  const nombres = capa.keys ?? [];
  let i = 0;
  let cuerpo = fuente.startsWith('^') ? fuente.slice(1) : fuente;
  if (cuerpo.endsWith(FIN)) cuerpo = cuerpo.slice(0, -FIN.length);
  return cuerpo
    .replaceAll(String.raw`(?:\/([^\/]+?))`, () => `/:${nombres[i++]?.name}`)
    .replace(/\\(.)/g, '$1');
}

function recorrer(pila: Capa[], prefijo: string, salida: Map<string, { metodo: string; ruta: string }>): void {
  for (const capa of pila) {
    if (capa.route) {
      const rutas = Array.isArray(capa.route.path) ? capa.route.path : [capa.route.path];
      for (const ruta of rutas) {
        const completa = `${prefijo}${String(ruta)}`.replace(/\/+$/, '') || '/';
        for (const metodo of Object.keys(capa.route.methods)) {
          const m = metodo === '_all' ? 'all' : metodo.toLowerCase();
          salida.set(`${m} ${completa}`, { metodo: m, ruta: completa });
        }
      }
    } else {
      // `conAlcance('modulo', router)` envuelve el router en un middleware y deja el original en `fronteraRouter`.
      const pilaHija = capa.handle?.stack ?? capa.handle?.fronteraRouter?.stack;
      if (pilaHija) recorrer(pilaHija, `${prefijo}${prefijoDe(capa)}`, salida);
    }
  }
}

const { createApp } = await import('../../apps/api/src/app.js');
const app = createApp() as unknown as { _router: { stack: Capa[] } };
const rutas = new Map<string, { metodo: string; ruta: string }>();
recorrer(app._router.stack, '', rutas);
const lista = [...rutas.values()].sort((a, b) => a.ruta.localeCompare(b.ruta, 'en') || a.metodo.localeCompare(b.metodo, 'en'));
process.stdout.write(`${JSON.stringify(lista, null, 1)}\n`, () => process.exit(0));
