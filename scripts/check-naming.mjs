// Gate de convenciones de rama y título de PR — FLITO.
// Fuente normativa: .cursor/rules/convenciones-rama-pr.mdc y AGENTS.md (Git flow).
//
// Lo usan dos consumidores:
//   - CI, job «naming» (bloqueante sobre el PR)
//   - scripts/git-hooks/pre-push (--warn-only: avisa, no detiene el push)
//
// Uso:
//   node scripts/check-naming.mjs --branch <rama> [--title <título del PR>]
//                                 [--files-from <archivo con la lista de cambios>]
//                                 [--warn-only]
//
// Exit 1 si hay violaciones (salvo --warn-only).

import { readFileSync } from 'node:fs';

const TITLE_MAX = 100; // GitHub admite 256; 100 mantiene el título legible en listas y notificaciones
const BRANCH_MAX = 80;
const DESC_MIN = 15; // caracteres de descripción en el título: obliga a decir algo, no «fix»

// Ramas de ambiente: son origen de PRs de promoción (flit-release), no de desarrollo.
const ENV_BRANCHES = new Set(['develop', 'staging', 'release', 'main']);

const BRANCH_WORK_ITEM = /^(HU|BUG)\/(\d{1,7})-[a-z0-9]+(?:-[A-Za-z0-9]+)+$/;
const BRANCH_SIN_WI = /^(CHORE|DOCS)\/[a-z0-9]+(?:-[A-Za-z0-9]+)+$/;
const TITLE_WORK_ITEM = /^(HU|BUG) (\d{1,7}): (\S.*)$/;
const TITLE_SIN_WI = /^(CHORE|DOCS): (\S.*)$/;
const TITLE_PROMOCION = /^RELEASE: (\S.*)$/;

// CHORE/DOCS es la única vía sin work item: queda acotada a lo que no es producto.
// Un cambio bajo estas rutas es desarrollo y exige HU o Bug en Azure DevOps.
const RUTAS_DE_PRODUCTO = ['apps/', 'packages/'];

function parseArgs(argv) {
  const args = { warnOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--warn-only') args.warnOnly = true;
    else if (flag === '--branch') args.branch = argv[++i];
    else if (flag === '--title') args.title = argv[++i];
    else if (flag === '--files-from') args.filesFrom = argv[++i];
  }
  return args;
}

function leerCambios(path) {
  if (!path) return null;
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

const EJEMPLOS = `
  Rama    HU/11678-davidchica-ajustes-flito
          BUG/11654-davidchica-correccion-dashboard
          CHORE/davidchica-actualizar-eslint      (sin work item: no toca apps/ ni packages/)
  Título  HU 11678: Ajustes al visor de comparendos para filtrar por municipio
          BUG 11654: Corrección del dashboard que no refrescaba tras cambiar de sede
          CHORE: Actualización de la configuración de ESLint`;

function validarRama(branch, errores) {
  if (ENV_BRANCHES.has(branch)) return null; // PR de promoción: lo valida el título

  if (branch.length > BRANCH_MAX) {
    errores.push(`Rama de ${branch.length} caracteres; el máximo es ${BRANCH_MAX}.`);
  }

  const conWorkItem = BRANCH_WORK_ITEM.exec(branch);
  if (conWorkItem) return { tipo: conWorkItem[1], id: conWorkItem[2] };

  if (BRANCH_SIN_WI.test(branch)) return { tipo: branch.split('/')[0], id: null };

  errores.push(
    `Nombre de rama inválido: «${branch}».\n` +
      `  Formato exigido: HU/<ID>-<desarrollador>-<descripcion-breve> (o BUG/…).\n` +
      `  Sin work item, solo para lo que no es producto: CHORE/<desarrollador>-<desc> o DOCS/<…>.\n` +
      `  Prefijo en MAYÚSCULAS, ID de Azure DevOps sin «#», descripción en kebab-case sin acentos.`,
  );
  return null;
}

function validarTitulo(title, rama, errores) {
  if (title.length > TITLE_MAX) {
    errores.push(`Título de ${title.length} caracteres; el máximo es ${TITLE_MAX}.`);
  }
  if (title.trim() !== title) errores.push('El título no debe empezar ni terminar con espacios.');
  if (title.endsWith('.')) errores.push('El título no lleva punto final.');

  const conWorkItem = TITLE_WORK_ITEM.exec(title);
  const sinWorkItem = TITLE_SIN_WI.exec(title);
  const promocion = TITLE_PROMOCION.exec(title);

  if (!conWorkItem && !sinWorkItem && !promocion) {
    errores.push(
      `Título de PR inválido: «${title}».\n` +
        `  Formato exigido: «HU <ID>: <descripción>» o «BUG <ID>: <descripción>».\n` +
        `  Sin work item: «CHORE: <descripción>» / «DOCS: <descripción>». Promoción: «RELEASE: <descripción>».`,
    );
    return;
  }

  const descripcion = conWorkItem?.[3] ?? sinWorkItem?.[2] ?? promocion[1];
  if (descripcion.length < DESC_MIN) {
    errores.push(
      `La descripción del título tiene ${descripcion.length} caracteres; mínimo ${DESC_MIN}. ` +
        'Debe decir qué cambia y para qué, no «ajustes» ni «fix».',
    );
  }

  if (promocion && rama && !ENV_BRANCHES.has(rama)) {
    errores.push(`«RELEASE:» está reservado a PRs de promoción entre ramas de ambiente; esta sale de «${rama}».`);
  }
  if (!promocion && rama && ENV_BRANCHES.has(rama)) {
    errores.push(`Un PR desde la rama de ambiente «${rama}» es una promoción: el título debe empezar por «RELEASE:».`);
  }

  return { tipo: conWorkItem?.[1] ?? sinWorkItem?.[1] ?? 'RELEASE', id: conWorkItem?.[2] ?? null };
}

function validarCoherencia(rama, titulo, errores) {
  if (!rama || !titulo) return;
  if (rama.tipo !== titulo.tipo) {
    errores.push(`La rama es de tipo ${rama.tipo} y el título de tipo ${titulo.tipo}: deben coincidir.`);
  }
  if (rama.id && titulo.id && rama.id !== titulo.id) {
    errores.push(`El work item de la rama (${rama.id}) no coincide con el del título (${titulo.id}).`);
  }
  if (rama.id && titulo.tipo !== 'RELEASE' && !titulo.id) {
    errores.push(`La rama declara el work item ${rama.id}; el título debe empezar por «${rama.tipo} ${rama.id}:».`);
  }
}

function validarTrazabilidad(rama, cambios, errores) {
  if (!rama || rama.id || !cambios) return; // solo aplica a CHORE/DOCS con lista de cambios disponible
  const producto = cambios.filter((f) => RUTAS_DE_PRODUCTO.some((r) => f.startsWith(r)));
  if (producto.length === 0) return;

  errores.push(
    `Una rama ${rama.tipo}/ no puede tocar código de producto (apps/, packages/): ` +
      `todo desarrollo va ligado a una HU o un Bug de Azure DevOps.\n` +
      `  Archivos: ${producto.slice(0, 5).join(', ')}${producto.length > 5 ? `, … (+${producto.length - 5})` : ''}\n` +
      `  Crea la HU o el Bug (skill flit-crear-hu) y renombra: git branch -m HU/<ID>-<desarrollador>-<desc>`,
  );
}

const args = parseArgs(process.argv.slice(2));
if (!args.branch) {
  console.error('Uso: node scripts/check-naming.mjs --branch <rama> [--title <título>] [--files-from <archivo>]');
  process.exit(2);
}

const errores = [];
const rama = validarRama(args.branch, errores);
const titulo = args.title ? validarTitulo(args.title, args.branch, errores) : null;
validarCoherencia(rama, titulo, errores);
validarTrazabilidad(rama, leerCambios(args.filesFrom), errores);

if (errores.length === 0) {
  console.log(`[naming] OK — rama «${args.branch}»${args.title ? ` · título «${args.title}»` : ''}`);
  process.exit(0);
}

const etiqueta = args.warnOnly ? 'AVISO' : 'BLOQUEADO';
console.error(`[naming] ${etiqueta} — convenciones de rama/título (AGENTS.md · Git flow):\n`);
for (const e of errores) console.error(`  · ${e}`);
console.error(`\nEjemplos válidos:${EJEMPLOS}\n`);
process.exit(args.warnOnly ? 0 : 1);
