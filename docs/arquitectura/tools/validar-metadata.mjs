#!/usr/bin/env node
// Revisa el modelo LikeC4 con las reglas del plan 01 §8.4 y §10.4 que `likec4 validate` no cubre.
// Uso: node validar-metadata.mjs <modelo.json> <carpeta de .c4> [<carpeta de .c4> ...]
//   modelo.json: salida de `likec4 export json`. Se corre desde la raíz del repo; las rutas se resuelven contra ella.
// Sin dependencias. Sale con 1 si encuentra un error.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const [rutaModelo, ...carpetas] = process.argv.slice(2);
if (!rutaModelo || carpetas.length === 0) {
  console.error('Uso: node validar-metadata.mjs <modelo.json> <carpeta de .c4> [...]');
  process.exit(2);
}

const errores = [];
const CRITICIDADES = new Set(['critica', 'alta', 'media', 'baja']);
const CONTENEDORES = new Set(['webapp', 'service', 'database', 'queue', 'bucket']);
const DESPLEGABLES = new Set(['webapp', 'service']);
const CONTRATO = /^(openapi|asyncapi|proto)/;

function archivos(dir, filtro, salida = []) {
  for (const nombre of readdirSync(dir)) {
    if (nombre === 'node_modules' || nombre === '.git' || nombre === 'out' || nombre === 'bin' || nombre === 'obj') continue;
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) archivos(ruta, filtro, salida);
    else if (filtro(nombre)) salida.push(ruta);
  }
  return salida;
}

// ── Metadatos obligatorios ─────────────────────────────────
const exportado = JSON.parse(readFileSync(rutaModelo, 'utf8'));
const proyectos = Array.isArray(exportado) ? exportado : [exportado];
const adrs = archivos('.', (n) => /^ADR-\d+/.test(n)).map((r) => r.split(/[\\/]/).pop());
let revisados = 0;

for (const proyecto of proyectos) {
  for (const [id, el] of Object.entries(proyecto.elements ?? {})) {
    const meta = el.metadata ?? {};
    const tags = el.tags ?? [];
    const falta = (clave) => errores.push(`${id}: falta metadata.${clave}`);
    if (tags.includes('referencia')) continue;
    const esSistema = el.kind === 'system';
    const esContenedor = CONTENEDORES.has(el.kind);
    if (esSistema || esContenedor) {
      revisados += 1;
      for (const clave of ['owner', 'criticidad', 'datos_personales']) if (!meta[clave]) falta(clave);
      if (meta.criticidad && !CRITICIDADES.has(meta.criticidad)) errores.push(`${id}: criticidad inválida «${meta.criticidad}»`);
      if (meta.datos_personales && !['si', 'no'].includes(meta.datos_personales)) {
        errores.push(`${id}: datos_personales debe ser si o no`);
      }
      if (meta.datos_personales === 'si' && !tags.includes('pii')) errores.push(`${id}: datos_personales=si sin #pii`);
      if (meta.datos_personales === 'no' && tags.includes('pii')) errores.push(`${id}: #pii con datos_personales=no`);
    }
    if (esSistema && !meta.repo) falta('repo');
    if (esContenedor && !meta.repo_path) falta('repo_path');
    if (DESPLEGABLES.has(el.kind) && !meta.k8s_workload) falta('k8s_workload');

    // Rutas y ADR: solo se comprueban en el repo dueño del elemento.
    if (meta.repo_path && !existsSync(meta.repo_path)) errores.push(`${id}: repo_path no existe: ${meta.repo_path}`);
    for (const [clave, valor] of Object.entries(meta)) {
      if (CONTRATO.test(clave) && !existsSync(valor)) errores.push(`${id}: ${clave} no existe: ${valor}`);
    }
    for (const adr of (meta.adr ?? '').split(',').map((a) => a.trim()).filter(Boolean)) {
      if (!adrs.some((a) => a.startsWith(`${adr}-`))) errores.push(`${id}: no se encontró ${adr} en el repo`);
    }
  }
}
if (revisados === 0) errores.push('El modelo exportado no tiene sistemas ni contenedores: ¿cambió el formato de export json?');

// ── Repo público: nada con forma de IP, secreto o correo ───
const PROHIBIDO = [
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/, 'algo con forma de IP'],
  [/\b(?:10|127|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+/, 'una IP privada'],
  [/\beyJ[A-Za-z0-9_-]{10,}/, 'algo con forma de JWT'],
  [/\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S/i, 'una credencial'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}|\bsk-[A-Za-z0-9-]{20,}/, 'una llave'],
  [/[\w.+-]+@[\w-]+\.[\w.]+/, 'un correo'],
  [/\.(?:internal|local|svc\.cluster\.local)\b/, 'un host interno'],
];
for (const carpeta of carpetas) {
  for (const ruta of archivos(carpeta, (n) => n.endsWith('.c4') || n === 'likec4.config.json')) {
    readFileSync(ruta, 'utf8').split(/\r?\n/).forEach((linea, i) => {
      for (const [patron, que] of PROHIBIDO) {
        if (patron.test(linea)) errores.push(`${relative('.', ruta)}:${i + 1}: parece ${que}`);
      }
    });
  }
}

if (errores.length > 0) {
  console.error(`${errores.length} error(es):`);
  for (const e of errores) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`Metadatos y revisión de repo público en orden: ${revisados} sistemas y contenedores revisados.`);
