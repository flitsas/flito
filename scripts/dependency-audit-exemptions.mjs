// Exenciones aprobadas del gate SCA — fuente de verdad ÚNICA.
//
// La consumen dos scripts y por eso vive aparte: scripts/dependency-audit.mjs (deja pasar el
// advisory) y scripts/check-exemptions.mjs (falla si una entrada ya no aparece en el audit). Si cada
// uno tuviera su copia, la guarda podría quedar comprobando una lista que no es la que se aplica.
//
// Formato: URL del advisory → motivo con referencia. Una entrada por advisory, nunca por paquete.
// Una excepción sólo es válida si está aprobada por el Líder Técnico y documentada en su PR.
//
// Retirar cada entrada en cuanto el paquete se actualice y el advisory desaparezca del audit. Eso ya
// no depende de que alguien se acuerde: `npm run check:exemptions` pone el CI en rojo si una entrada
// deja de corresponder a un advisory real.
// Retirada en la HU #11289 (2026-08-25): GHSA-wgrm-67xf-hhpq (CVE-2024-4367, CVSS 8.8) sobre
// pdfjs-dist <=4.1.392. Dejó de necesitar exención porque el paquete subió a 6.2.108, que es el fix
// upstream: el advisory ya no aparece en el audit. La mitigación por configuración que la sostenía
// —`isEvalSupported: false` en los 5 getDocument()— se retiró en la misma HU: esa opción NO EXISTE
// en v6 y el gate que la vigilaba habría seguido en verde sobre una opción que la librería ya no
// lee. El suelo de navegador que impone el salto está en `docs/adr/ADR-0007`.
export const EXEMPTIONS = new Map([
  // Aprobada por el Líder Técnico (David Chica) el 2026-10-02. node-forge (dependencia directa de
  // apps/api y también vía @signpdf/signer-p12) acepta en la VERIFICACIÓN de firmas RSA PKCS#1 v1.5 elementos DigestAlgorithm anidados de más.
  // FLITO no verifica firmas con node-forge: solo FIRMA (apps/api/src/modules/tramites/docs/
  // pdf-signer.ts genera llave, certificado y .p12; @signpdf/signer-p12 firma el PDF). Sin fix
  // upstream al aprobarla; retirar en cuanto el advisory desaparezca del audit (lo exige
  // `npm run check:exemptions`).
  ['https://github.com/advisories/GHSA-86w9-cpqp-85rv',
    'node-forge: falla en la verificación de firmas PKCS#1 v1.5; FLITO solo firma (pdf-signer.ts, @signpdf/signer-p12), no verifica. Sin fix upstream (2026-10-02).'],
]);
