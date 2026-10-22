// Gate de veredictos pre-PR declarados en el cuerpo del PR — FLITO.
// Fuente normativa: .cursor/rules/pre-pr-gates.mdc y AGENTS.md (matriz de invocación).
//
// Los gates pre-PR (skill flit-code-review, qa-agent modo B, security-agent,
// db-review-agent) son disciplina del hilo: ningún otro check de CI puede saber si
// corrieron de verdad. Este check es el enforcement parcial: un PR de producto
// (HU/BUG) debe declarar los cuatro veredictos en su cuerpo, en verde o N/A con
// motivo. CHORE/DOCS/RELEASE quedan exentos (no son producto).
//
// Lo usan dos consumidores:
//   - CI, job «pr-gates» (bloqueante sobre el PR; título y cuerpo llegan por env,
//     nunca interpolados en el shell — son entrada de usuario)
//   - local: PR_TITLE="HU 123: …" PR_BODY="…" node scripts/check-pr-gates.mjs
//
// Formatos aceptados en el cuerpo (línea por gate, «:» o «=»):
//   code-review: OK
//   qa-agent B: PASS            (o SIN-ENTORNO declarado)
//   security-agent: N/A — copia/CSS sin superficie sensible
//   db-review-agent: SANO       (o N/A — no toca schema.ts ni migrations/)
//
// Un veredicto *-CON-OBSERVACIONES no es verde (AGENTS.md): solo pasa con waiver
// humano explícito en la misma línea («waiver: <cita>»).
//
// Exit 1 si falta un veredicto o viene en estado no verde.

const TITLE_WORK_ITEM = /^(HU|BUG) \d{1,7}: /;

// Cada gate: etiqueta para mensajes, regex de la línea, valores verdes y
// sufijo de observaciones que NO cuenta como verde sin waiver.
const GATES = [
  {
    nombre: 'code-review',
    linea: /code-review\s*[:=]/i,
    verde: /code-review\s*[:=]\s*(Skill\s*)?OK\b/i,
    observado: /code-review\s*[:=]\s*(Skill\s*)?OK-CON-OBSERVACIONES/i,
    esperado: 'OK (único veredicto que abre el PR; skill flit-code-review)',
  },
  {
    nombre: 'qa-agent B',
    linea: /qa(-agent)?(\s*B)?\s*[:=]/i,
    verde: /qa(-agent)?(\s*B)?\s*[:=]\s*(HANDOFF\s*)?(PASS|SIN-ENTORNO)\b/i,
    observado: /qa(-agent)?(\s*B)?\s*[:=]\s*(HANDOFF\s*)?PASS-CON-OBSERVACIONES/i,
    esperado: 'PASS o SIN-ENTORNO (qa-agent modo B, pre-PR)',
  },
  {
    nombre: 'security-agent',
    linea: /security(-agent)?\s*[:=]/i,
    verde: /security(-agent)?\s*[:=]\s*(PASS|N\/A)\b/i,
    observado: /security(-agent)?\s*[:=]\s*PASS-CON-OBSERVACIONES/i,
    esperado: 'PASS, o N/A declarado (sin auth/PII/multer/rutas nuevas/package*.json/laft/privacy)',
  },
  {
    nombre: 'db-review-agent',
    linea: /db(-review)?(-agent)?\s*[:=]/i,
    verde: /db(-review)?(-agent)?\s*[:=]\s*(SANO|N\/A)\b/i,
    observado: /db(-review)?(-agent)?\s*[:=]\s*SANO-CON-OBSERVACIONES/i,
    esperado: 'SANO, o N/A declarado (no toca apps/api/src/db/schema.ts ni src/db/migrations/)',
  },
];

const WAIVER = /waiver\s*[:=]\s*\S/i;

const EJEMPLO = `
  ## Gates pre-PR
  code-review: OK
  qa-agent B: PASS
  security-agent: N/A — copy/CSS, sin superficie sensible
  db-review-agent: N/A — no toca schema.ts ni migrations/`;

const title = process.env.PR_TITLE ?? '';
const body = process.env.PR_BODY ?? '';

if (!title) {
  console.error('Uso: PR_TITLE="<título del PR>" PR_BODY="<cuerpo>" node scripts/check-pr-gates.mjs');
  process.exit(2);
}

if (!TITLE_WORK_ITEM.test(title)) {
  console.log(`[pr-gates] N/A — «${title}» no es un PR de producto (HU/BUG); CHORE/DOCS/RELEASE no declaran veredictos.`);
  process.exit(0);
}

const errores = [];
for (const gate of GATES) {
  if (!gate.linea.test(body)) {
    errores.push(`Falta la línea de «${gate.nombre}» en el cuerpo del PR. Se espera: ${gate.esperado}. Si el gate no aplica, se declara N/A con motivo — nunca se omite en silencio.`);
    continue;
  }
  // «observado» se evalúa ANTES que «verde»: «OK-CON-OBSERVACIONES» también casa
  // con la regex de verde (\b casa entre «K» y «-»), y no es éxito sin waiver.
  if (gate.observado.test(body)) {
    if (WAIVER.test(body)) {
      console.log(`[pr-gates] AVISO — «${gate.nombre}» pasa con waiver humano declarado.`);
      continue;
    }
    errores.push(`«${gate.nombre}» viene *-CON-OBSERVACIONES: no es éxito (AGENTS.md). Se corrige y se re-gatea, o se declara «waiver: <cita del humano>» en el cuerpo.`);
    continue;
  }
  if (gate.verde.test(body)) continue;
  errores.push(`«${gate.nombre}» no está en verde. Se espera: ${gate.esperado}.`);
}

if (errores.length === 0) {
  console.log(`[pr-gates] OK — veredictos pre-PR declarados y en verde para «${title}»`);
  process.exit(0);
}

console.error(`[pr-gates] BLOQUEADO — veredictos pre-PR del PR «${title}»:\n`);
for (const e of errores) console.error(`  · ${e}`);
console.error(`\nBloque mínimo esperado en el cuerpo del PR:${EJEMPLO}\n`);
process.exit(1);
