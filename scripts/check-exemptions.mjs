// HU #11289 — gate anti «exención zombi» del SCA.
//
// scripts/dependency-audit.mjs deja pasar advisories High/Critical concretos mediante EXEMPTIONS.
// El comentario de ese mapa ya ordena retirar cada entrada «en cuanto el paquete se actualice y
// desaparezca del audit», pero hasta hoy nadie lo comprobaba: una exención caducada sobrevive
// indefinidamente y se lleva por delante advisories futuros del mismo URL sin que nadie se entere.
//
// Este gate cruza EXEMPTIONS contra la salida real de `npm audit --omit=dev --json` y falla si
// alguna entrada YA NO aparece. Es, sobre todo, una función de forzado sobre el salto de pdfjs-dist
// a v6: quien suba la versión y olvide borrar la entrada se encuentra el CI en rojo.
//
// Nota sobre el criterio: este gate NO opina sobre si una exención está justificada — de eso
// responde el Líder Técnico en el PR. Sólo comprueba que siga describiendo algo real.
//
// Uso: node scripts/check-exemptions.mjs
// Exit 1 si hay entradas que ya no corresponden a ningún advisory del audit.

import { spawnSync } from 'node:child_process';
import { EXEMPTIONS } from './dependency-audit-exemptions.mjs';

function auditJson() {
  const res = spawnSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8' });
  // `npm audit` sale con código != 0 cuando encuentra vulnerabilidades: eso es lo normal aquí y no
  // es un fallo de ejecución. Lo que sí es fallo es no obtener JSON.
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

const audit = auditJson();

// URLs de advisory realmente presentes en el audit de producción, con el paquete que los arrastra.
const presentes = new Map();
for (const [pkg, vuln] of Object.entries(audit.vulnerabilities ?? {})) {
  for (const via of vuln.via ?? []) {
    if (typeof via !== 'object' || !via.url) continue;
    if (!presentes.has(via.url)) presentes.set(via.url, { pkg, severity: via.severity });
  }
}

const zombis = [];
const vivas = [];
for (const [url, motivo] of EXEMPTIONS) {
  (presentes.has(url) ? vivas : zombis).push({ url, motivo });
}

console.log(`check:exemptions · ${EXEMPTIONS.size} exención(es) declarada(s) · ${presentes.size} advisory(s) en el audit de producción`);

for (const v of vivas) {
  const info = presentes.get(v.url);
  console.log(`  · vigente: ${info.pkg} [${info.severity}] ${v.url}`);
}

if (zombis.length > 0) {
  console.error('\n✗ Exención(es) zombi: declaradas en EXEMPTIONS pero ausentes del npm audit actual.');
  for (const z of zombis) {
    console.error(`  ✗ ${z.url}\n      motivo declarado: ${z.motivo}`);
  }
  console.error(
    `\n${zombis.length} entrada(s) caduca(s). Si el paquete ya se actualizó, BORRA la entrada de EXEMPTIONS en\n` +
      'scripts/dependency-audit-exemptions.mjs (y con ella la mitigación temporal que la acompañaba).\n' +
      'Una exención que no describe ningún advisory real enmascara los que vengan después con el mismo URL.',
  );
  process.exit(1);
}

console.log('\n✓ check:exemptions OK: toda exención declarada sigue correspondiendo a un advisory real del audit.');
