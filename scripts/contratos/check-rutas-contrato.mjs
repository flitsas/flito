// Gate de CI: falla si una ruta de Express de apps/api no aparece en contracts/openapi/flito-api.v1.yaml, o si el contrato
// declara una ruta que ya no existe. El inventario sale del Express real (inventario-rutas.mts), no de un grep: así cuenta
// routers envueltos, fábricas y prefijos compartidos.
//
// Uso: npm run check:contrato-rutas (exige shared-types compilado). Para corregir: npm run contrato:generar.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { compararRutas, operacionesDeYaml } from './rutas-openapi.mjs';

const RAIZ = path.resolve(import.meta.dirname, '../..');
const CONTRATO = 'contracts/openapi/flito-api.v1.yaml';

const salida = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', '--tsconfig', 'apps/api/tsconfig.json', 'scripts/contratos/inventario-rutas.mts'], {
  cwd: RAIZ, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
});
const inventario = JSON.parse(salida.slice(salida.indexOf('[')));
if (inventario.length < 100) {
  console.error(`::error::El inventario trajo solo ${inventario.length} rutas: la lectura de Express falló, no el contrato.`);
  process.exit(1);
}
const { faltan, sobran } = compararRutas(inventario, operacionesDeYaml(readFileSync(path.join(RAIZ, CONTRATO), 'utf8')));
for (const r of faltan) console.error(`::error file=${CONTRATO}::Ruta de Express que no está en el contrato: ${r}`);
for (const r of sobran) console.error(`::error file=${CONTRATO}::Ruta del contrato que ya no existe en Express: ${r}`);
if (faltan.length || sobran.length) {
  console.error(`${faltan.length} faltan y ${sobran.length} sobran. Corrígelo con: npm run contrato:generar`);
  process.exit(1);
}
console.log(`Contrato al día: ${inventario.length} rutas de Express, todas en ${CONTRATO}.`);
