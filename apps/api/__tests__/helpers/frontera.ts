// HU #12875 — `conAlcance` para las apps mínimas de prueba que montan un router de SOAT como lo monta
// `app.ts` (`app.use('/api/flito/soat', conAlcance('soat', router))`).
//
// Es el `conAlcance` REAL, importado de forma diferida en la primera petición: un `import` estático de
// `frontera-enlace.ts` arrastra `db/client.js` antes de que los `vi.mock` con variables de nivel
// superior (`selectMock`, …) estén inicializados, y el fichero entero cae con «Cannot access … before
// initialization». En la primera petición los mocks ya existen.
import type { RequestHandler } from 'express';
import type { ModuloFrontera } from '@operaciones/shared-types';

export function conAlcance(modulo: ModuloFrontera, router: RequestHandler): RequestHandler {
  let real: RequestHandler | null = null;
  return (req, res, next) => {
    const seguir = (h: RequestHandler) => h(req, res, next);
    if (real) { seguir(real); return; }
    import('../../src/shared/middleware/frontera-enlace.js')
      .then((m) => { real ??= m.conAlcance(modulo, router); seguir(real); })
      .catch(next);
  };
}
