// Gate SCA — npm audit de dependencias de producción (CI: job dependency-audit).
//
// Falla (exit 1) con cualquier vulnerabilidad High o Critical en dependencias
// de producción, salvo las exenciones aprobadas en EXEMPTIONS. Política
// (AGENTS.md, ci.yml): tolerancia 0 a High+ en producción; una excepción solo
// es válida si está aprobada por el Líder Técnico, documentada en su PR y
// registrada aquí de forma explícita y acotada a UN advisory.
//
// Uso local: `node scripts/dependency-audit.mjs`.
// Modo estricto (verificación del propio gate): FLITO_AUDIT_DISABLE_EXEMPTIONS=1
// ignora las exenciones — útil para comprobar qué seguiría bloqueando.

import { spawnSync } from 'node:child_process';

// Exenciones aprobadas: URL del advisory → motivo con referencia. Retirar cada
// entrada en cuanto el paquete se actualice y desaparezca del audit.
const EXEMPTIONS = new Map([
  [
    'https://github.com/advisories/GHSA-wgrm-67xf-hhpq', // pdfjs-dist <=4.1.392 (High)
    'el fix es major 3→6 en los 4 visores PDF de apps/web y va en HU propia (aprobado en PR #91)',
  ],
]);

const exemptionsEnabled = !process.env.FLITO_AUDIT_DISABLE_EXEMPTIONS;

function auditJson() {
  const res = spawnSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8' });
  if (res.error || !res.stdout) {
    console.error(`✗ No se pudo ejecutar npm audit: ${res.error?.message ?? 'salida vacía'}`);
    process.exit(1);
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    console.error('✗ npm audit no devolvió JSON válido.');
    process.exit(1);
  }
}

// Log humano del job: la misma tabla que imprimía el step anterior.
spawnSync('npm', ['audit', '--omit=dev', '--audit-level=high'], { stdio: 'inherit' });

const audit = auditJson();
const blocking = [];
const exempted = [];

for (const [pkg, vuln] of Object.entries(audit.vulnerabilities ?? {})) {
  for (const via of vuln.via ?? []) {
    // Los `via` string son referencias a otro paquete listado; ya se recogen allí.
    if (typeof via !== 'object' || !via.url) continue;
    if (via.severity !== 'high' && via.severity !== 'critical') continue;
    const item = { pkg, severity: via.severity, title: via.title, url: via.url };
    (exemptionsEnabled && EXEMPTIONS.has(via.url) ? exempted : blocking).push(item);
  }
}

for (const item of exempted) {
  console.log(`⚠ Exenta (aprobada): ${item.pkg} [${item.severity}] ${item.url}\n  └ ${EXEMPTIONS.get(item.url)}`);
}

const counts = audit.metadata?.vulnerabilities ?? {};
console.log(
  `\nResumen npm audit (prod): ${counts.total ?? '?'} totales — ${counts.high ?? 0} high, ${counts.critical ?? 0} critical (${counts.moderate ?? 0} moderate no bloquean)`,
);

if (blocking.length > 0) {
  console.error('\n✗ Vulnerabilidades High/Critical sin exención aprobada:');
  for (const item of blocking) console.error(`  ✗ ${item.pkg} [${item.severity}] ${item.title} — ${item.url}`);
  process.exit(1);
}

console.log('\n✓ dependency-audit OK: sin High/Critical bloqueantes en dependencias de producción.');
