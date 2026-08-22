// LAFT — frontera de acceso a las 7 vistas (HU #11275, AC3).
//
// Este es el test que más importa del módulo: LAFT guarda contrapartes con documento, correo y
// marca PEP, y operaciones señaladas como sospechosas. Que un rol sin permiso vea una de esas
// tablas no es un fallo de navegación, es una divulgación.
//
// ── Por qué el negativo aquí no puede ser «no veo la tabla» ────────────────────────────────────
//
// Afirmar una AUSENCIA es lo que se cumple solo en cualquier test roto. El montaje que la vuelve
// una prueba de verdad son cuatro piezas, y ninguna sobra:
//
//   1. **El endpoint se mockea con el fixture CON datos, no se aborta.** Si la guarda se saltara,
//      la PII estaría servida y aparecería en pantalla. Abortar habría dejado la afirmación en
//      «no se ve un nombre que nadie podía traer», que es mucho más débil.
//   2. **Se espía la PETICIÓN, no la respuesta.** El fixture base responde `200 []` a cualquier
//      `/api/**` no mockeado, así que una consulta fugada no deja huella en la interfaz: solo el
//      espía la ve. Y si el componente monta, consulta y se desmonta, la respuesta se descarta
//      pero la petición ya salió con la cookie de sesión.
//   3. **El chunk tampoco se pide.** `React.lazy` dispara su `import()` al MONTARSE, y
//      `ProtectedRoute` devuelve `NoAccess` en lugar de sus hijos. Ese aserto se pone rojo si
//      alguien mueve la guarda DENTRO de la página —que es la CAUSA de una fuga, no su síntoma—
//      aunque ese día la página no consultara nada. Depende del dev server de Vite: en desarrollo
//      el módulo se pide por su ruta de origen (`/src/pages/LaftUnusual.tsx`) y en build por su
//      chunk (`LaftUnusual-<hash>.js`); el localizador cubre las dos formas.
//   4. **El gemelo POSITIVO vive en este mismo archivo**, con los mismos helpers, los mismos globs
//      y el mismo punto de reposo. Si mañana el prefijo del API cambia o un glob se escribe mal, el
//      positivo se pone rojo y delata que el negativo pasaba por vacío.
//
// ── Una desviación respecto al texto del AC, a propósito ───────────────────────────────────────
//
// El AC3 dice «lo redirige». La guarda de este producto NO redirige: `ProtectedRoute` renderiza
// `NoAccess` EN la ruta, conservando la URL y la navegación (`components/NoAccess.tsx` lo
// documenta: reemplazó a un `Navigate to="/"` mudo). Lo que el AC pide de fondo —no renderizar
// contenido con PII— se cumple igual, y es lo que se afirma. Queda anotado en el HANDOFF.
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, CONDUCTOR_USER, AUDITOR_USER } from '../helpers/auth';
import { COMPLIANCE_LAFT_USER, VISTAS_LAFT, mockVista, type VistaLaft } from '../helpers/laft-fixtures';

const CANARIO = '/api/__qa_canary';

interface Espia {
  /** `${método} ${pathname}` de cada petición al API de LAFT. Nunca la URL completa: la query es el
   *  sitio por donde se filtraría un documento a un artefacto de CI (AGENTS.md §14). */
  alApi: string[];
  /** Peticiones del módulo/chunk de cada página LAFT, por nombre de componente. */
  alChunk: string[];
}

function espiar(page: Page): Espia {
  const espia: Espia = { alApi: [], alChunk: [] };
  page.on('request', (req) => {
    const { pathname } = new URL(req.url());
    if (pathname.startsWith('/api/laft')) espia.alApi.push(`${req.method()} ${pathname}`);
    if (/\/pages\/Laft[A-Za-z]*\.tsx$|\/Laft[A-Za-z]*-[A-Za-z0-9_]+\.js$/.test(pathname)) espia.alChunk.push(pathname);
  });
  return espia;
}

/** El chunk de ESTA vista y no el de su vecina: `Laft` no puede casar con `LaftUnusual`. */
function chunkDe(espia: Espia, vista: VistaLaft): string[] {
  const suyo = new RegExp(`/pages/${vista.componente}\\.tsx$|/${vista.componente}-[A-Za-z0-9_]+\\.js$`);
  return espia.alChunk.filter((p) => suyo.test(p));
}

/** Punto de reposo: cuando el canario ha salido, lo que fuera a salir en el montaje ya salió. */
async function reposo(page: Page): Promise<void> {
  const salida = page.waitForRequest((r) => r.url().includes('__qa_canary'), { timeout: 10_000 });
  await page.evaluate((ruta) => { void fetch(ruta).catch(() => {}); }, CANARIO);
  await salida;
}

test.describe('LAFT — la guarda de permisos aguanta (HU #11275, AC3)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  // ── Gemelo POSITIVO ───────────────────────────────────────────────────────────────────────────
  for (const vista of VISTAS_LAFT) {
    test(`AC3 (gemelo positivo) — con permiso, ${vista.ruta} monta, pide su chunk y consulta el API`, async ({ page }) => {
      await loginAs(page, COMPLIANCE_LAFT_USER);
      const espia = espiar(page);
      await mockVista(page, vista);

      await page.goto(vista.ruta);
      await expect(page.getByRole('heading', { level: 1, name: vista.titulo, exact: true })).toBeVisible();
      await reposo(page);

      expect(espia.alApi).toContain(`GET ${vista.ruta_api}`);
      expect(chunkDe(espia, vista), `no se pidió el módulo de ${vista.componente}`).not.toEqual([]);
      // Y la PII del fixture SÍ se ve aquí. Es lo que da valor al `not.toContain` del negativo:
      // demuestra que ese aserto es capaz de fallar.
      for (const dato of vista.huellaPii) {
        expect(await page.content()).toContain(dato);
      }
    });
  }

  // ── Negativo: el rol más acotado del sistema ─────────────────────────────────────────────────
  for (const vista of VISTAS_LAFT) {
    test(`AC3 — conductor: ${vista.ruta} no renderiza PII, no consulta el API y no descarga el módulo`, async ({ page }) => {
      await loginAs(page, CONDUCTOR_USER);
      const espia = espiar(page);
      // Servido CON datos a propósito: si la guarda se saltara, la PII estaría disponible.
      await mockVista(page, vista);

      await page.goto(vista.ruta);
      await expect(page.getByRole('heading', { name: `No tienes acceso a ${vista.etiqueta}` })).toBeVisible();
      await reposo(page);

      // 1 · Nada de la vista se pintó: su `<h1>` exacto no está (el de `NoAccess` no cuenta).
      await expect(page.getByRole('heading', { level: 1, name: vista.titulo, exact: true })).toHaveCount(0);
      await expect(page.getByText(vista.textoCargado)).toHaveCount(0);
      // 2 · Ni un dato identificable llegó al documento.
      const html = await page.content();
      for (const dato of vista.huellaPii) {
        expect(html, `${dato} llegó al DOM sin permiso`).not.toContain(dato);
      }
      // 3 · Ninguna petición salió hacia el API de LAFT — ni siquiera una que se descarte luego.
      expect(espia.alApi).toEqual([]);
      // 4 · Y el módulo ni se descargó: la guarda está ANTES del montaje, no dentro de la página.
      expect(chunkDe(espia, vista)).toEqual([]);
      // 5 · La URL no cambió (la guarda no redirige, ver cabecera) y no lleva nada identificable.
      expect(page.url()).toContain(vista.ruta);
    });
  }

  // ── Negativo fino: el auditor tiene CUATRO de las siete ───────────────────────────────────────
  //
  // Es el que de verdad prueba que la guarda mira el SLUG y no el módulo: `auditor` entra a manual,
  // oficial, plan de auditorías y tablero, y NO entra a contrapartes, inusuales ni capacitaciones.
  // Un test que solo usara `conductor` pasaría igual con una guarda de brocha gorda que negara LAFT
  // entero a quien no sea admin, y ese día el reparto fino —el que decide qué ve una auditoría—
  // dejaría de estar protegido sin que nada se pusiera rojo.
  //
  // (El corte NO es «con PII / sin PII»: `/laft/oficial` también lleva nombre y correo, y el auditor
  //  SÍ debe verlo — es el registro de designación que audita. El corte es el del catálogo de roles.)
  const AUDITOR_NO_ENTRA = ['laft', 'laft_unusual', 'laft_trainings'];

  for (const vista of VISTAS_LAFT.filter((v) => AUDITOR_NO_ENTRA.includes(v.slug))) {
    test(`AC3 — auditor: ${vista.ruta} le está negada`, async ({ page }) => {
      await loginAs(page, AUDITOR_USER);
      const espia = espiar(page);
      await mockVista(page, vista);

      await page.goto(vista.ruta);
      await expect(page.getByRole('heading', { name: `No tienes acceso a ${vista.etiqueta}` })).toBeVisible();
      await reposo(page);

      const html = await page.content();
      for (const dato of vista.huellaPii) {
        expect(html, `${dato} llegó al DOM del auditor`).not.toContain(dato);
      }
      expect(espia.alApi).toEqual([]);
      expect(chunkDe(espia, vista)).toEqual([]);
    });
  }

  for (const vista of VISTAS_LAFT.filter((v) => !AUDITOR_NO_ENTRA.includes(v.slug))) {
    test(`AC3 — auditor: ${vista.ruta} SÍ la ve — el negativo es por slug, no por módulo`, async ({ page }) => {
      await loginAs(page, AUDITOR_USER);
      await mockVista(page, vista);

      await page.goto(vista.ruta);
      await expect(page.getByRole('heading', { level: 1, name: vista.titulo, exact: true })).toBeVisible();
      await expect(page.getByText(vista.textoCargado).first()).toBeVisible();
    });
  }
});
