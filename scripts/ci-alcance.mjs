#!/usr/bin/env node
// Alcance del CI: ¿el PR toca algo que no sea documentación?
//
//   node scripts/ci-alcance.mjs --files-from <lista>   escribe `codigo=true|false` en $GITHUB_OUTPUT
//
// Con `codigo=false` el CI omite tests, builds y E2E (un PR DOCS/ que solo trae un ADR no
// necesita 4 min de suite API). Los gates de trazabilidad y seguridad (naming, pr-gates,
// secret-scan, dependency-audit, lint) corren siempre.
//
// El corte es binario a propósito, no «solo API» / «solo web»: los tests de la API leen archivos
// de apps/web (fichas de ayuda, App.tsx, plantilla de nginx) y la web importa tipos y fixtures de
// apps/api. Partir por lado dejaría pasar justo esos cruces.
//
// Falla seguro: si la lista de archivos no se puede calcular o viene vacía, `codigo=true`.
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Lo que no ejecuta ni lee ningún job de build/test. Un .md dentro de apps/ o packages/ SÍ es
// código (las fichas de ayuda de apps/web/src/content/ayuda las consume la web y las testea la API).
const PREFIJOS_DOCUMENTACION = ['docs/', '.claude/', '.cursor/'];

export function esDocumentacion(archivo) {
  if (PREFIJOS_DOCUMENTACION.some((p) => archivo.startsWith(p))) return true;
  const enProducto = archivo.startsWith('apps/') || archivo.startsWith('packages/');
  return !enProducto && archivo.toLowerCase().endsWith('.md');
}

export function calcularAlcance(archivos) {
  const lista = archivos.map((a) => a.trim()).filter(Boolean);
  if (lista.length === 0) return { codigo: true, motivo: 'lista de cambios vacía o no calculable' };
  const deCodigo = lista.filter((a) => !esDocumentacion(a));
  return deCodigo.length === 0
    ? { codigo: false, motivo: `${lista.length} archivo(s), todos de documentación` }
    : { codigo: true, motivo: `${deCodigo.length} archivo(s) de código, p. ej. ${deCodigo[0]}` };
}

function main(argv) {
  const i = argv.indexOf('--files-from');
  let archivos = [];
  try {
    if (i >= 0) archivos = readFileSync(argv[i + 1], 'utf8').split('\n');
  } catch {
    archivos = [];
  }
  const { codigo, motivo } = calcularAlcance(archivos);
  console.log(`codigo=${codigo} — ${motivo}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `codigo=${codigo}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
