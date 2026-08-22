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
export const EXEMPTIONS = new Map([
  [
    'https://github.com/advisories/GHSA-wgrm-67xf-hhpq', // pdfjs-dist <=4.1.392 (High)
    'la ejecución de JS ya está MITIGADA por configuración: `isEvalSupported: false` en las 5 llamadas a ' +
      'getDocument() de apps/web (HU #11289), con guarda `npm run check:pdfjs-eval`. La exención sigue viva ' +
      'sólo porque npm audit compara versiones y no lee configuración: el advisory seguirá apareciendo ' +
      'mientras pdfjs-dist sea 3.x. Se retira con el salto a v6 (major 3→6, bloqueado por el suelo de ' +
      'navegador que impone; aprobado en PR #91)',
  ],
]);
