// Fixtures compartidos de la suite E2E de credenciales de Siigo (HU #11890).
//
// Las formas de respuesta NO son suposiciones: salen del backend, que en esta HU no se toca
// (`apps/api/src/modules/siigo/credenciales.routes.ts` y `credenciales.service.ts`). Se copian aquí
// tres detalles que un fixture inventado se saltaría y que cambian lo que hay que probar:
//
//   1. El campo enmascarado se llama `accessKey` —el MISMO nombre que el campo del formulario— y su
//      valor es la constante `'••••••••'` para TODAS las filas (`credenciales.service.ts:62-72`).
//      No hay «últimos 4 caracteres» posibles: el backend no los manda. Y como el listado tiene la
//      misma forma que el formulario, un `setForm({ ...credencial })` para «editar» rellenaría el
//      input con `'••••••••'`, que mide 8 caracteres y PASA el `min(8)` del servidor. Ese es el
//      mutante más probable de esta HU, y por eso el spec afirma el valor exacto de la celda.
//   2. La bandera de la fila es `activo` (no `activa`), y el listado incluye `descifradoFallidoEn` /
//      `descifradoFallidoMotivo`: una credencial cuyo ciphertext no verifica se desactiva SOLA
//      (`credenciales.service.ts:12-13`). Ningún AC de la HU nombra ese estado — de ahí el TC-18.
//   3. `probar-conexion` responde **200 siempre**; el veredicto viaja en el cuerpo y hay SIETE
//      códigos (`siigo.diagnostico.service.ts:23-30`). Y el ambiente sale del cuerpo de la petición:
//      si la pantalla no lo envía, el backend usa el de la configuración global y el «probar
//      conexión para un ambiente» del AC3 sería mentira. Por eso el mock NO hace eco del ambiente
//      recibido: así el spec puede afirmar por separado lo que se envió y lo que se pintó.
//
// Reglas de este archivo (mismas que `laft-fixtures.ts`):
//   · No modifica `helpers/auth.ts` ni ningún helper existente; se añade al lado.
//   · Datos sintéticos: usuarios `qa_*`, notas de fixture, y NUNCA una credencial real de Siigo.
//   · El estado nunca guarda el access key en claro que teclea el test — solo su longitud. Un
//     helper de pruebas que acumula secretos en memoria para «comprobarlos» es el mismo error que
//     el spec del TC-05 persigue.
import { expect, type Page } from '@playwright/test';

// ── Nombres FIJADOS por el coordinador de la HU (no son una suposición del QA) ──────────────────
export const RUTA_PAGINA = '/siigo/credenciales';
export const COMPONENTE = 'SiigoCredenciales';
export const SLUG = 'siigo_credenciales';
export const RUTA_API = '/api/siigo/credenciales';
export const RUTA_PROBAR = '/api/siigo/credenciales/probar-conexion';
export const GLOB_API = '**/api/siigo/credenciales**';
const CANARIO = '/api/__qa_canary';

/** El único valor de `accessKey` que sale del backend (`credenciales.service.ts:62`). */
export const ACCESS_KEY_ENMASCARADA = '••••••••';

export type Ambiente = 'pruebas' | 'produccion';

/** Vista pública de una credencial — espejo de `SiigoCredencialPublica` del API. */
export interface CredencialFixture {
  id: number;
  ambiente: Ambiente;
  username: string;
  /** Siempre enmascarado. El backend nunca devuelve el valor real. */
  accessKey: string;
  activo: boolean;
  keyVersion: number;
  notas: string | null;
  descifradoFallidoEn: string | null;
  descifradoFallidoMotivo: string | null;
  createdAt: string;
  updatedAt: string;
}

export function credencial(over: Partial<CredencialFixture> & { id: number }): CredencialFixture {
  return {
    ambiente: 'pruebas',
    username: 'qa_siigo_pruebas',
    accessKey: ACCESS_KEY_ENMASCARADA,
    activo: true,
    keyVersion: 1,
    notas: null,
    descifradoFallidoEn: null,
    descifradoFallidoMotivo: null,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...over,
  };
}

/** Espejo de `ResultadoDiagnostico` (`siigo.diagnostico.service.ts:32-43`). */
export interface VeredictoFixture {
  ok: boolean;
  codigo: string;
  mensaje: string;
  ambiente: string;
  modo: string;
  username: string | null;
  tokenObtenido: boolean;
  duracionMs: number;
}

export function veredicto(over: Partial<VeredictoFixture> = {}): VeredictoFixture {
  return {
    ok: true,
    codigo: 'ok',
    mensaje: 'Conexión correcta con Siigo (fixture).',
    ambiente: 'pruebas',
    modo: 'real',
    username: 'qa_siigo_pruebas',
    tokenObtenido: true,
    duracionMs: 842,
    ...over,
  };
}

/**
 * Los SIETE códigos del diagnóstico, con un mensaje propio y reconocible cada uno.
 *
 * El mensaje lleva el código dentro a propósito: así el aserto «se pinta el mensaje del cuerpo» no
 * puede pasar por casualidad con un texto que la pantalla se invente, y el fallo dice cuál de los
 * siete caminos se comió la interfaz.
 */
export const CODIGOS_DIAGNOSTICO: VeredictoFixture[] = [
  veredicto({ ok: true, codigo: 'ok', mensaje: 'Veredicto de fixture [ok]: token obtenido.', tokenObtenido: true }),
  veredicto({ ok: false, codigo: 'sin_configuracion', mensaje: 'Veredicto de fixture [sin_configuracion]: falta configurar la integración.', tokenObtenido: false, username: null }),
  veredicto({ ok: false, codigo: 'sin_credenciales', mensaje: 'Veredicto de fixture [sin_credenciales]: no hay credenciales activas para este ambiente.', tokenObtenido: false, username: null }),
  veredicto({ ok: false, codigo: 'llave_maestra', mensaje: 'Veredicto de fixture [llave_maestra]: la llave maestra no está configurada.', tokenObtenido: false, username: null }),
  veredicto({ ok: false, codigo: 'credenciales_rechazadas', mensaje: 'Veredicto de fixture [credenciales_rechazadas]: Siigo rechazó el usuario o el access key.', tokenObtenido: false }),
  veredicto({ ok: false, codigo: 'servicio_no_disponible', mensaje: 'Veredicto de fixture [servicio_no_disponible]: Siigo no respondió a tiempo.', tokenObtenido: false }),
  veredicto({ ok: false, codigo: 'error_inesperado', mensaje: 'Veredicto de fixture [error_inesperado]: algo salió mal al probar.', tokenObtenido: false }),
];

// ── Estado del API simulado ─────────────────────────────────────────────────────────────────────

export interface RespuestaFija { status: number; body: unknown }

export interface EstadoSiigo {
  llaveMaestraConfigurada: boolean;
  credenciales: CredencialFixture[];
  /** Status del GET del listado. Distinto de 200 → estado de error de la pantalla. */
  getStatus: number;
  /** Promesa que retiene el GET: mientras no se resuelva, la pantalla se queda cargando. */
  retenerGet: Promise<void> | null;
  /** Fuerza la respuesta del POST de alta (503 de llave maestra, 400 de datos inválidos…). */
  postRespuesta: RespuestaFija | null;
  /** Fuerza la respuesta del DELETE (404…). */
  deleteRespuesta: RespuestaFija | null;
  /** Veredicto que devuelve `probar-conexion` (siempre con HTTP 200). */
  veredicto: VeredictoFixture;
  /** Retraso del `probar-conexion`, para observar el estado «probando». */
  retrasoProbarMs: number;

  // ── Registro de lo que la pantalla hizo ──
  gets: number;
  /** Metadatos del POST de alta. NUNCA el access key: solo su longitud. */
  altas: { ambiente?: unknown; username?: unknown; notas?: unknown; longitudAccessKey: number }[];
  /** Ambiente que la pantalla envió en cada `probar-conexion`. */
  pruebas: { ambiente?: unknown }[];
  /** Ids sobre los que se pidió el DELETE, en orden. */
  bajas: number[];
}

const esperar = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

/**
 * Monta el API de credenciales sobre `page.route`, con el comportamiento REAL del backend:
 * el alta desactiva la activa anterior del mismo ambiente y conserva el historial, y el DELETE es
 * un soft delete (`activo:false`), nunca un borrado.
 *
 * Devuelve el estado mutable: los tests lo leen para afirmar QUÉ pidió la pantalla, y lo mutan
 * para cambiar la respuesta a mitad de test (el reintento del AC6, por ejemplo).
 */
export async function montarApiSiigo(
  page: Page, inicial: Partial<EstadoSiigo> = {},
): Promise<EstadoSiigo> {
  const estado: EstadoSiigo = {
    llaveMaestraConfigurada: true,
    credenciales: [],
    getStatus: 200,
    retenerGet: null,
    postRespuesta: null,
    deleteRespuesta: null,
    veredicto: veredicto(),
    retrasoProbarMs: 0,
    gets: 0,
    altas: [],
    pruebas: [],
    bajas: [],
    ...inicial,
  };

  await page.route(GLOB_API, async (route) => {
    const req = route.request();
    const { pathname } = new URL(req.url());
    const metodo = req.method();
    const json = (status: number, body: unknown) => route.fulfill({
      status, contentType: 'application/json', body: JSON.stringify(body),
    });
    const cuerpo = (): Record<string, unknown> => {
      try { return JSON.parse(req.postData() ?? '{}') as Record<string, unknown>; } catch { return {}; }
    };

    if (metodo === 'POST' && pathname === RUTA_PROBAR) {
      const b = cuerpo();
      estado.pruebas.push({ ambiente: b.ambiente });
      if (estado.retrasoProbarMs > 0) await esperar(estado.retrasoProbarMs);
      // 200 SIEMPRE, y sin eco del ambiente recibido: lo que se envió y lo que se pinta son dos
      // afirmaciones distintas y el spec las comprueba por separado.
      return json(200, estado.veredicto);
    }

    if (metodo === 'POST' && pathname === RUTA_API) {
      const b = cuerpo();
      const clave = typeof b.accessKey === 'string' ? b.accessKey : '';
      estado.altas.push({
        ambiente: b.ambiente, username: b.username, notas: b.notas, longitudAccessKey: clave.length,
      });
      if (estado.postRespuesta) return json(estado.postRespuesta.status, estado.postRespuesta.body);

      const ambiente = (b.ambiente === 'produccion' ? 'produccion' : 'pruebas') as Ambiente;
      // Igual que `guardarCredencial`: la activa anterior de ESE ambiente se desactiva, no se borra.
      estado.credenciales = estado.credenciales.map(
        (c) => (c.ambiente === ambiente && c.activo ? { ...c, activo: false } : c),
      );
      const nueva = credencial({
        id: Math.max(8000, ...estado.credenciales.map((c) => c.id)) + 1,
        ambiente,
        username: typeof b.username === 'string' ? b.username : 'qa_sin_usuario',
        notas: typeof b.notas === 'string' && b.notas !== '' ? b.notas : null,
        activo: true,
        createdAt: '2026-08-26T12:00:00.000Z',
        updatedAt: '2026-08-26T12:00:00.000Z',
      });
      estado.credenciales = [nueva, ...estado.credenciales];
      return json(201, nueva);
    }

    const baja = /\/api\/siigo\/credenciales\/(\d+)$/.exec(pathname);
    if (metodo === 'DELETE' && baja) {
      const id = Number(baja[1]);
      estado.bajas.push(id);
      if (estado.deleteRespuesta) return json(estado.deleteRespuesta.status, estado.deleteRespuesta.body);
      const fila = estado.credenciales.find((c) => c.id === id);
      if (!fila) return json(404, { error: 'No encontrada' });
      fila.activo = false;
      return json(200, { success: true });
    }

    if (metodo === 'GET' && pathname === RUTA_API) {
      estado.gets += 1;
      if (estado.retenerGet) await estado.retenerGet;
      if (estado.getStatus !== 200) {
        return json(estado.getStatus, { error: 'No se pudieron cargar las credenciales (fixture)' });
      }
      return json(200, {
        data: estado.credenciales,
        llaveMaestraConfigurada: estado.llaveMaestraConfigurada,
      });
    }

    // Cualquier otra cosa cae al catch-all del fixture base, que la deja registrada en el runner.
    return route.fallback();
  });

  return estado;
}

// ── Espías ──────────────────────────────────────────────────────────────────────────────────────

export interface EspiaSiigo {
  /** `${método} ${pathname}` de cada petición a `/api/siigo/**`. Nunca la URL completa: la query
   *  es justo por donde se filtraría un secreto a un artefacto de CI (AGENTS.md §14). */
  alApi: string[];
  /** Peticiones del módulo/chunk de la página (dev: `/src/pages/X.tsx`; build: `X-<hash>.js`). */
  alChunk: string[];
  /** `${método} ${pathname}` de las peticiones cuya URL —query incluida— lleva el centinela. */
  centinelaEnUrl: string[];
  /** `${método} ${pathname}` de las peticiones cuyo CUERPO lleva el centinela. */
  centinelaEnCuerpo: string[];
}

/**
 * Espía de red. Se instala ANTES de navegar.
 *
 * `centinela` es el valor sintético que el test teclea como access key: se busca en la URL y en el
 * cuerpo de CADA petición, no solo en las del módulo de Siigo. Un secreto que se escapa rara vez lo
 * hace por la puerta que se está mirando.
 */
export function espiar(page: Page, centinela?: string): EspiaSiigo {
  const espia: EspiaSiigo = { alApi: [], alChunk: [], centinelaEnUrl: [], centinelaEnCuerpo: [] };
  page.on('request', (req) => {
    const url = req.url();
    const { pathname } = new URL(url);
    const firma = `${req.method()} ${pathname}`;
    if (pathname.startsWith('/api/siigo')) espia.alApi.push(firma);
    if (pathname.includes(COMPONENTE)) espia.alChunk.push(pathname);
    if (centinela) {
      if (url.includes(centinela)) espia.centinelaEnUrl.push(firma);
      if ((req.postData() ?? '').includes(centinela)) espia.centinelaEnCuerpo.push(firma);
    }
  });
  return espia;
}

/**
 * Captura TODO lo que la página escriba en consola, con los argumentos serializados.
 *
 * `page.on('console')` no basta: `msg.text()` de un objeto sale como `JSHandle@object`, así que un
 * `console.log(form)` —con el access key dentro— pasaría desapercibido. Aquí se envuelve la consola
 * antes de que cargue nada de la aplicación y se serializa cada argumento con un `JSON.stringify`
 * a prueba de ciclos.
 *
 * Debe llamarse ANTES de `loginAs` (que ya navega).
 */
export async function capturarConsola(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __qaConsola?: string[] };
    w.__qaConsola = [];
    const serializar = (valor: unknown): string => {
      if (typeof valor === 'string') return valor;
      const vistos = new WeakSet<object>();
      try {
        return JSON.stringify(valor, (_k, v: unknown) => {
          if (typeof v === 'object' && v !== null) {
            if (vistos.has(v as object)) return '[ciclo]';
            vistos.add(v as object);
          }
          return v;
        }) ?? String(valor);
      } catch {
        return String(valor);
      }
    };
    const consola = console as unknown as Record<string, (...a: unknown[]) => void>;
    for (const nivel of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
      const original = consola[nivel]?.bind(console);
      consola[nivel] = (...args: unknown[]) => {
        try { w.__qaConsola?.push(args.map(serializar).join(' ')); } catch { /* nunca romper la app */ }
        original?.(...args);
      };
    }
  });
}

export async function leerConsola(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __qaConsola?: string[] }).__qaConsola ?? []);
}

/** Volcado completo de `localStorage` + `sessionStorage`, clave y valor. */
export async function leerAlmacenamiento(page: Page): Promise<string> {
  return page.evaluate(() => {
    const volcar = (s: Storage) => Object.entries({ ...s }).map(([k, v]) => `${k}=${String(v)}`).join('\n');
    return `${volcar(localStorage)}\n${volcar(sessionStorage)}`;
  });
}

/**
 * Punto de reposo determinista: cuando el canario ha salido, lo que fuera a salir en el montaje ya
 * pasó por la misma cola de red. No hay `waitForTimeout` en esta suite.
 */
export async function reposo(page: Page): Promise<void> {
  const salida = page.waitForRequest((r) => r.url().includes('__qa_canary'), { timeout: 10_000 });
  await page.evaluate((ruta) => { void fetch(ruta).catch(() => {}); }, CANARIO);
  await salida;
}

// ── Localizadores de la pantalla ────────────────────────────────────────────────────────────────
//
// CORREGIDOS tras leer la implementación (2026-08-26). La versión de estos helpers escrita en modo
// A daba por hecho el modelo que hereda de `RndcAdminCredenciales`: UN formulario con un `<select>`
// de ambiente. El diseño real (`docs/ux/siigo-credenciales-integracion.md`, §3.1 y §6.2) lo descarta
// a propósito: hay UNA TARJETA POR AMBIENTE y el alta ocurre en un modal abierto desde su tarjeta,
// así que el ambiente es CONTEXTO de la tarjeta y no un control del formulario.
//
// Qué cambia y qué NO:
//   · Cambia POR DÓNDE se llega (un modal por tarjeta, un historial plegable, campos dentro del
//     `dialog`). Eso es navegación, no comportamiento.
//   · NO cambia ni un solo aserto. El ambiente se sigue exigiendo donde de verdad importa —en el
//     CUERPO del POST (`estado.altas[0].ambiente`)—, que además es una prueba más fuerte del diseño
//     por tarjeta: demuestra que la tarjeta de pruebas manda `pruebas` y no lo que hubiera elegido
//     un `<select>` que ya no existe.
//
// Se localiza por ROL y nombre accesible, con expresión regular: el copy exacto lo decide el
// `ux-agent`, pero que exista un control alcanzable por su nombre no es negociable —es la mitad del
// AC6—. Los nombres de los estados (`role="status"` con `aria-busy`, `role="alert"` con
// «Reintentar») son el contrato ya establecido del repo (`flito-comparendos-cascaron.spec.ts`).

/** El ambiente tal y como aparece en las frases de la interfaz («… de pruebas»). */
const EN_FRASE: Record<Ambiente, string> = { pruebas: 'pruebas', produccion: 'producci[oó]n' };

/** El modal de alta o el diálogo de confirmación: solo hay uno abierto a la vez. */
export const modal = (page: Page) => page.getByRole('dialog');

// Los campos viven DENTRO del modal. Acotarlos ahí no es un capricho: `getByLabel(/usuario/i)` a
// nivel de página choca en modo estricto con el botón del shell `aria-label="Menú de usuario · …"`,
// y ese choque no lo arregla ningún cambio de la pantalla. Es un fallo del localizador, y se
// arregla en el localizador.
export const campoUsuario = (page: Page) => modal(page).getByRole('textbox', { name: /usuario/i });
export const campoAccessKey = (page: Page) => modal(page).getByLabel(/access\s*key/i);
export const campoNotas = (page: Page) => modal(page).getByLabel(/notas/i);
export const botonGuardar = (page: Page) => modal(page).getByRole('button', { name: /guardar/i });

export const botonReintentar = (page: Page) => page.getByRole('button', { name: /reintentar/i });
export const cargando = (page: Page) => page.getByRole('status');
export const alerta = (page: Page) => page.getByRole('alert');

/** «Probar conexión de pruebas» — el sufijo `sr-only` es lo que distingue las dos tarjetas. */
export const botonProbar = (page: Page, ambiente: Ambiente) => page.getByRole('button', {
  name: new RegExp(`probar conexi[oó]n.*\\bde ${EN_FRASE[ambiente]}`, 'i'),
});

/** «Registrar nueva credencial de pruebas» / «Registrar otra credencial de producción». */
export const botonRegistrar = (page: Page, ambiente: Ambiente) => page.getByRole('button', {
  name: new RegExp(`registrar (nueva|otra) credencial de ${EN_FRASE[ambiente]}`, 'i'),
});

/** Abre el modal de alta desde la tarjeta de ESE ambiente y espera a que el formulario esté a la vista. */
export async function abrirFormulario(page: Page, ambiente: Ambiente): Promise<void> {
  await botonRegistrar(page, ambiente).click();
  await expect(modal(page)).toBeVisible();
  await expect(campoAccessKey(page)).toBeVisible();
}

/**
 * Despliega el historial de la tarjeta. El historial es un `disclosure` plegado por defecto: la
 * credencial que se desactiva sale del bloque de la activa y pasa a la tabla de historial, así que
 * sin abrirlo no se puede afirmar —ni desmentir— que siga ahí.
 *
 * Abrirlo no debilita nada: lo que el AC1 y el AC4 exigen es que la credencial anterior SIGA
 * EXISTIENDO y se lea como inactiva, no que esté desplegada de entrada.
 */
export async function abrirHistorial(page: Page, ambiente: Ambiente): Promise<void> {
  const etiqueta = ambiente === 'pruebas' ? 'Pruebas' : 'Producci[oó]n';
  const disparador = page.getByRole('button', {
    name: new RegExp(`${etiqueta}:\\s*Historial de este ambiente`, 'i'),
  });
  await expect(disparador, `la tarjeta de ${ambiente} no ofrece su historial`).toHaveCount(1);
  if ((await disparador.getAttribute('aria-expanded')) !== 'true') await disparador.click();
  await expect(disparador).toHaveAttribute('aria-expanded', 'true');
}

/**
 * Busca un enlace de navegación por su HREF, abriendo cada módulo del dock hasta encontrarlo.
 *
 * Por href y no por etiqueta: el copy del enlace y la sección donde vive los decide el `ux-agent`,
 * y el AC7 no pide una etiqueta concreta —pide que la página sea ALCANZABLE desde la navegación—.
 * Una sección de un solo ítem se pinta como enlace directo (`FlitNavBar.tsx:131`), así que primero
 * se mira sin abrir nada.
 */
export async function enlaceEnNavegacion(
  page: Page, href: string,
): Promise<{ encontrado: boolean; seccion: string | null }> {
  const nav = page.getByRole('navigation', { name: 'Navegación principal' });
  await expect(nav).toBeVisible();
  const enlace = page.locator(`a[href="${href}"]`);
  if (await enlace.count() > 0) return { encontrado: true, seccion: '(enlace directo del dock)' };

  const botones = nav.getByRole('button');
  const total = await botones.count();
  for (let i = 0; i < total; i += 1) {
    const boton = botones.nth(i);
    const nombre = (await boton.textContent())?.trim() ?? `módulo #${i}`;
    await boton.click();
    if (await enlace.count() > 0) return { encontrado: true, seccion: nombre };
  }
  return { encontrado: false, seccion: null };
}
