#!/usr/bin/env node
// Convierte la Lista-de-ciudades.xlsx de Siigo al JSON que carga `siigo.ciudades.service.ts`.
//
// HU #11293 (Feature #11241). Procedimiento completo en
// `docs/integraciones/siigo-catalogo-ciudades.md`.
//
//   node apps/api/src/scripts/convertir-ciudades-siigo.mjs /tmp/Lista-de-ciudades.xlsx
//
// **Sin dependencias.** Un .xlsx es un zip de XML y aquí solo hacen falta dos entradas:
// `sharedStrings.xml` (las cadenas del libro) y `sheet1.xml` (las celdas, que referencian el índice
// de esa tabla cuando son de tipo `s`). Añadir una librería de Excel al árbol de producción para
// una conversión que se corre una vez al año no vale lo que cuesta mantenerla.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESTINO = path.resolve(__dirname, '../db/data/siigo-ciudades.json');

const ORIGEN_OFICIAL =
  'https://saprodcentralassets.blob.core.windows.net/siigoapi/documentation/Lista-de-ciudades.xlsx';

/** Extrae una entrada del zip sin librerías: `unzip -p` está en cualquier Linux y en macOS. */
function entradaDelZip(rutaZip, entrada) {
  return execFileSync('unzip', ['-p', rutaZip, entrada], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
}

function desescapar(xml) {
  return xml
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

/** Las cadenas compartidas, en orden. Una puede venir partida en varios <t> si tiene formato. */
function cadenasCompartidas(xml) {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => desescapar(t[1])).join(''),
  );
}

function filas(xml, cadenas) {
  const salida = [];
  for (const fila of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const celdas = {};
    for (const c of fila[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g)) {
      const [, columna, atributos, contenido] = c;
      const valor = /<v>([\s\S]*?)<\/v>/.exec(contenido)?.[1];
      if (valor === undefined) {
        celdas[columna] = desescapar(/<t[^>]*>([\s\S]*?)<\/t>/.exec(contenido)?.[1] ?? '').trim();
      } else {
        celdas[columna] = (atributos.includes('t="s"') ? cadenas[Number(valor)] : valor).trim();
      }
    }
    salida.push(celdas);
  }
  return salida;
}

const rutaXlsx = process.argv[2];
if (!rutaXlsx) {
  console.error('Uso: node convertir-ciudades-siigo.mjs <Lista-de-ciudades.xlsx>');
  process.exit(1);
}

const cadenas = cadenasCompartidas(entradaDelZip(rutaXlsx, 'xl/sharedStrings.xml'));
const todas = filas(entradaDelZip(rutaXlsx, 'xl/worksheets/sheet1.xml'), cadenas);

// El encabezado real: CityCode | CityName | StateCode | StateName | CountryCode | CountryName.
// Se comprueba en vez de asumirse: si Siigo reordena las columnas, es mejor fallar aquí que
// cargar 4.605 ciudades con el país y la ciudad intercambiados.
const ESPERADO = ['CityCode', 'CityName', 'StateCode', 'StateName', 'CountryCode', 'CountryName'];
const encabezado = ['A', 'B', 'C', 'D', 'E', 'F'].map((c) => todas[0][c]);
if (ESPERADO.join('|') !== encabezado.join('|')) {
  console.error(`El encabezado cambió.\n  esperado: ${ESPERADO.join(' | ')}\n  recibido: ${encabezado.join(' | ')}`);
  process.exit(1);
}

const ciudades = todas.slice(1)
  .filter((r) => r.A && r.B && r.C && r.E)
  .map((r) => ({
    countryCode: r.E, countryName: r.F, stateCode: r.C, stateName: r.D, cityCode: r.A, cityName: r.B,
  }))
  // Orden estable: el diff de git muestra lo que cambió, no una reordenación completa.
  //
  // Comparación de código, NO `localeCompare`: ese ordena según el locale de quien corre el script
  // —«Ae» antes o después de «AG» según la máquina— y regenerar el archivo desde otro equipo
  // produciría un diff de 4.605 líneas sin que hubiera cambiado un solo dato.
  .sort((a, b) => {
    const ka = `${a.countryCode}|${a.stateCode}|${a.cityCode}`;
    const kb = `${b.countryCode}|${b.stateCode}|${b.cityCode}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

const hoy = new Date().toISOString().slice(0, 10);
const cabecera = {
  _comentario: [
    'Catálogo oficial de países, departamentos y ciudades que Siigo reconoce (HU #11293).',
    'GENERADO — no editar a mano. Procedimiento en docs/integraciones/siigo-catalogo-ciudades.md.',
    'Siigo NO expone un servicio de ciudades: publica un .xlsx. Por eso vive aquí y no en siigo_catalogos.',
  ],
  version: hoy,
  origen: ORIGEN_OFICIAL,
  descargadoEn: hoy,
  sha256Origen: createHash('sha256').update(readFileSync(rutaXlsx)).digest('hex'),
  total: ciudades.length,
};

const cuerpo = ciudades.map((c) => JSON.stringify(c)).join(',\n    ');
const salida = `${JSON.stringify(cabecera, null, 2).slice(0, -2)},\n  "ciudades": [\n    ${cuerpo}\n  ]\n}\n`;
JSON.parse(salida); // no escribir algo que no sea JSON válido
writeFileSync(DESTINO, salida, 'utf8');
console.log(`${ciudades.length} ciudades → ${DESTINO}`);
