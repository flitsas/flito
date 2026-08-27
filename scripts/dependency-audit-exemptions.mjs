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
export const EXEMPTIONS = new Map([]);
