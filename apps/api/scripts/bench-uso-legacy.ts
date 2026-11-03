// HU #13989 (ADR-0033 §6, AC2) — overhead de las capas de conteo, con el middleware REAL. Fuera de CI.
//   npx tsx scripts/bench-uso-legacy.ts            (desde apps/api; no necesita BD ni Redis)
//
// Dos apps Express idénticas, 120 routers de relleno, una con `montarConteoUsoLegacy` y otra sin él.
// Peticiones secuenciales por loopback con keep-alive, rondas alternadas tras calentar. Nunca escribe en
// una BD: `DATABASE_URL` apunta a un puerto cerrado, así que un flush a los 60 s falla y reintegra.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const RONDAS = 7;
const POR_RONDA = 5000;
const CALENTAMIENTO = 5000;
const ROUTERS_DE_RELLENO = 120;

await import(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../__tests__/setup.ts'));
process.env.DATABASE_URL = 'postgres://bench:bench@127.0.0.1:1/bench';
process.env.USO_LEGACY_CONTEO_ENABLED = '1';
process.env.LOG_LEVEL = 'silent';

const { default: express } = await import('express');
const { montarConteoUsoLegacy } = await import('../src/modules/uso-legacy/uso-legacy.middleware.js');

function construir(conConteo: boolean) {
  const app = express();
  app.use(express.json());
  if (conConteo) montarConteoUsoLegacy(app);
  for (let i = 0; i < ROUTERS_DE_RELLENO; i += 1) {
    const relleno = express.Router();
    relleno.get('/x', (_req, res) => { res.json({ ok: true }); });
    app.use(`/api/relleno-${i}`, relleno);
  }
  for (const prefijo of ['/api/flito/soat', '/api/soat']) {
    const router = express.Router();
    router.get('/:id', (req, res) => { res.json({ id: req.params.id }); });
    app.use(prefijo, router);
  }
  return new Promise<{ puerto: number; cerrar: () => void }>((resolver) => {
    const servidor = app.listen(0, '127.0.0.1', () => {
      resolver({ puerto: (servidor.address() as AddressInfo).port, cerrar: () => servidor.close() });
    });
  });
}

const agente = new http.Agent({ keepAlive: true, maxSockets: 1 });

function pedir(puerto: number, ruta: string): Promise<number> {
  return new Promise((resolver, rechazar) => {
    const t0 = process.hrtime.bigint();
    http.get({ host: '127.0.0.1', port: puerto, path: ruta, agent: agente }, (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        if (res.statusCode !== 200) rechazar(new Error(`status ${res.statusCode}`));
        else resolver(Number(process.hrtime.bigint() - t0) / 1000);
      });
    }).on('error', rechazar);
  });
}

const percentil = (ordenado: number[], p: number) => ordenado[Math.min(ordenado.length - 1, Math.floor(ordenado.length * p))]!;
const mediana = (v: number[]) => percentil([...v].sort((a, b) => a - b), 0.5);
const us = (n: number) => n.toFixed(1).padStart(7);

async function ronda(puerto: number, ruta: string, n: number) {
  const tiempos: number[] = [];
  for (let i = 0; i < n; i += 1) tiempos.push(await pedir(puerto, ruta));
  tiempos.sort((a, b) => a - b);
  return { p50: percentil(tiempos, 0.5), p99: percentil(tiempos, 0.99) };
}

const sin = await construir(false);
const con = await construir(true);

console.log(`Node ${process.version}, Express ${(await import('express/package.json', { with: { type: 'json' } })).default.version}, ${ROUTERS_DE_RELLENO} routers de relleno`);
console.log(`${RONDAS} rondas alternadas de ${POR_RONDA} peticiones secuenciales (keep-alive, loopback), tras calentar ${CALENTAMIENTO}. Cifras en µs, mediana de rondas.\n`);
console.log('Ruta                    | p50 sin | p50 con |    Δp50 | p99 sin | p99 con |    Δp99 | dispersión p50 entre rondas');

for (const ruta of ['/api/flito/soat/1', '/api/soat/1']) {
  await ronda(sin.puerto, ruta, CALENTAMIENTO);
  await ronda(con.puerto, ruta, CALENTAMIENTO);
  const conteoSin: { p50: number; p99: number }[] = [];
  const conteoCon: { p50: number; p99: number }[] = [];
  for (let i = 0; i < RONDAS; i += 1) {
    // El orden alterna para no favorecer siempre a la misma variante con el estado del proceso.
    const orden = i % 2 === 0 ? [[sin, conteoSin], [con, conteoCon]] as const : [[con, conteoCon], [sin, conteoSin]] as const;
    for (const [app, destino] of orden) destino.push(await ronda(app.puerto, ruta, POR_RONDA));
  }
  const [p50s, p50c] = [conteoSin.map((r) => r.p50), conteoCon.map((r) => r.p50)];
  const [p99s, p99c] = [mediana(conteoSin.map((r) => r.p99)), mediana(conteoCon.map((r) => r.p99))];
  const rango = (v: number[]) => `${Math.min(...v).toFixed(0)}–${Math.max(...v).toFixed(0)}`;
  console.log(`${ruta.padEnd(23)} | ${us(mediana(p50s))} | ${us(mediana(p50c))} | ${us(mediana(p50c) - mediana(p50s))} | ${us(p99s)} | ${us(p99c)} | ${us(p99c - p99s)} | sin ${rango(p50s)} · con ${rango(p50c)}`);
}

console.log('\nUmbral del ADR: Δp50 de la ruta ajena dentro de la dispersión; Δp50 de la legacy por debajo de 1000 µs.');
console.log('NO mide: la app real (auth, permisos, routers legacy reales), concurrencia, PDN, ni el efecto del flush');
console.log('(una sentencia por minuto y réplica). El contador corre en `close`, tras enviar la respuesta.');

sin.cerrar();
con.cerrar();
agente.destroy();
process.exit(0);
