// Datos demo para las capturas de la Ayuda FLITO (HU #13769).
//
// Las capturas de las fichas se generan sobre fixtures sintéticos servidos con `page.route`: ninguna
// llamada a `/api` llega a un backend real y ninguna imagen muestra datos de una persona real.
// Este archivo es la ÚNICA fuente de esos datos. Toda placa, cédula, NIT, teléfono, correo o nombre
// de persona que aparezca en una captura sale del registro `DATOS_DEMO` y cumple su regla de
// `REGLAS_DATOS_DEMO`. Lo comprueba `datos-demo.test.ts` (node:test, corre en CI).
//
// Reglas de datos ficticios (documentadas también en `.claude/skills/flit-ayuda-flito/SKILL.md`):
//
//   | Dato              | Regla                                                                 |
//   |-------------------|-----------------------------------------------------------------------|
//   | Placa             | Serie `ZZ` + letra + 3 dígitos (`ZZA101`): serie reservada para demo   |
//   | Cédula            | 10 dígitos que empiezan por `99` (9.900.000.000 en adelante): fuera de |
//   |                   | la numeración expedida                                                |
//   | NIT               | 9 dígitos que empiezan por `999` + dígito de verificación (`999000001-7`) |
//   | Teléfono          | Celular `3000000` + 3 dígitos (`3000000101`)                          |
//   | Correo            | Dominio `ejemplo.test` (TLD `.test` reservado, RFC 2606)              |
//   | VIN               | `9ZZDEMO` + 10 dígitos (17 caracteres; la «O» no existe en un VIN real) |
//   | Nombre de persona | Solo de la lista `NOMBRES_DEMO` (inventados; nombre y apellido de     |
//   |                   | pila comunes combinados con apellido «Demo»)                          |
//   | Empresa           | Solo de la lista `EMPRESAS_DEMO` (contienen «Demo»)                   |
//   | Organismo de      | Puede usar su nombre real (es una entidad pública, no un dato         |
//   | tránsito          | personal)                                                             |
//
// Este módulo no importa nada en tiempo de ejecución (solo tipos): lo carga tanto Playwright como
// `node --experimental-strip-types --test`.

import type { Page, Route } from '@playwright/test';

export const REGLAS_DATOS_DEMO = {
  placa: /^ZZ[A-Z]\d{3}$/,
  cedula: /^99\d{8}$/,
  nit: /^999\d{6}-\d$/,
  telefono: /^3000000\d{3}$/,
  correo: /^[a-z0-9._-]+@ejemplo\.test$/,
  vin: /^9ZZDEMO\d{10}$/,
} as const;

export const NOMBRES_DEMO = [
  'ANA DEMO PRUEBA',
  'CARLOS DEMO EJEMPLO',
  'Laura Demo',
  'Andrés Demo',
  'Mensajero Demo',
] as const;

export const EMPRESAS_DEMO = ['Concesionario Demo Norte', 'Concesionario Demo Sur'] as const;

/** Organismos de tránsito: nombre real permitido (entidad pública). */
export const ORGANISMOS_REALES = ['Secretaría de Movilidad de Manizales', 'Secretaría de Movilidad de Bogotá'] as const;

export const DATOS_DEMO = {
  placas: ['ZZA101', 'ZZB202', 'ZZC303'],
  cedulas: ['9900000101', '9900000202', '9900000303'],
  nits: ['999000001-7'],
  telefonos: ['3000000101'],
  correos: ['mensajero@ejemplo.test'],
  vins: ['9ZZDEMO0000000101', '9ZZDEMO0000000202', '9ZZDEMO0000000303'],
  nombres: NOMBRES_DEMO as readonly string[],
  empresas: EMPRESAS_DEMO as readonly string[],
} as const;

/**
 * Claves de los fixtures que contienen un dato personal o identificador, y la categoría del registro
 * a la que deben pertenecer. La prueba recorre los fixtures y exige que cada valor bajo una de estas
 * claves salga de `DATOS_DEMO`.
 */
export const CLAVES_SENSIBLES: Record<string, keyof typeof DATOS_DEMO> = {
  placa: 'placas',
  documento: 'cedulas',
  receptorDocumento: 'cedulas',
  propietarioDocumento: 'cedulas',
  cedula: 'cedulas',
  nit: 'nits',
  telefono: 'telefonos',
  celular: 'telefonos',
  correo: 'correos',
  email: 'correos',
  vin: 'vins',
  nombre: 'nombres',
  name: 'nombres',
  contactoNombre: 'nombres',
  receptorNombre: 'nombres',
  propietarioNombre: 'nombres',
  companiaNombre: 'empresas',
};

// ── Licencia de tránsito (PDF417) ficticia ───────────────────────────────────
// Misma estructura que el código real de la LT, con todos sus campos del registro demo.
// La imagen base64 del código va truncada y no es una foto.
function rawLt(i: 0 | 1 | 2): string {
  const dir = ['CALLE 1 N 1 01', 'CARRERA 2 N 2 02', 'AVENIDA 3 N 3 03'][i];
  return [
    `1000000000${i + 1}`,
    'C.C.',
    DATOS_DEMO.cedulas[i],
    [NOMBRES_DEMO[0], NOMBRES_DEMO[1], NOMBRES_DEMO[0]][i],
    dir,
    'MANIZALES',
    '7',
    '/9j/DEMO',
    DATOS_DEMO.placas[i],
    DATOS_DEMO.vins[i],
    DATOS_DEMO.vins[i],
    `35202600000000${i + 1}`,
    'GASOLINA',
  ].join(' ');
}

export const LT_DEMO = {
  relacionada: { raw: rawLt(0), numeroLt: 'LT90000000101', placa: DATOS_DEMO.placas[0] },
  sinTramite: { raw: rawLt(1), numeroLt: 'LT90000000202', placa: DATOS_DEMO.placas[1] },
  offline: { raw: rawLt(2), numeroLt: 'LT90000000303', placa: DATOS_DEMO.placas[2] },
} as const;

// ── Fixtures por pantalla ────────────────────────────────────────────────────

export const MI_RUTA_DEMO = {
  entregas: [
    {
      actaId: 'acta-demo-1',
      companiaNombre: EMPRESAS_DEMO[0],
      direccionEntrega: 'Calle 10 # 20-30',
      contactoNombre: NOMBRES_DEMO[2],
      documentos: [
        { id: 'doc-demo-1', placa: DATOS_DEMO.placas[2], idFlit: 'FLIT-DEMO-1', numeroLt: 'LT90000000303' },
      ],
    },
  ],
};

export const RECEPTOR_DEMO = { nombre: NOMBRES_DEMO[3], documento: DATOS_DEMO.cedulas[2] } as const;

/** Usuario de sesión de las capturas: su nombre se ve en la cabecera, así que también es demo. */
export const NOMBRE_USUARIO_DEMO = NOMBRES_DEMO[4];

/** Todos los fixtures que pinta alguna captura. La prueba de datos ficticios los recorre. */
export const FIXTURES_DEMO: Record<string, unknown> = {
  MI_RUTA_DEMO,
  LT_DEMO,
  RECEPTOR_DEMO: { receptorNombre: RECEPTOR_DEMO.nombre, receptorDocumento: RECEPTOR_DEMO.documento },
};

// ── Interceptación de /api ───────────────────────────────────────────────────

export type RespuestaDemo = { status?: number; body: unknown };
export type ManejadorDemo = (route: Route) => RespuestaDemo | Promise<RespuestaDemo>;

/**
 * Responde TODO `/api/**` con fixtures. Los endpoints de `rutas` (regex sobre el pathname, la
 * primera que case gana) devuelven su fixture; cualquier otro `/api` devuelve `[]` sintético y queda
 * anotado en `noMockeados`. Ninguna petición sigue a la red: no hay `route.continue()`.
 *
 * Devuelve el registro para que el spec compruebe (AC2) que cada petición a `/api` la respondió
 * este interceptor.
 */
export async function interceptarApiDemo(page: Page, rutas: Array<[RegExp, ManejadorDemo]>) {
  const registro = { atendidas: [] as string[], noMockeados: [] as string[], vistas: [] as string[] };
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (u.pathname.startsWith('/api/')) registro.vistas.push(`${req.method()} ${u.pathname}`);
  });
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const { pathname } = new URL(req.url());
    const firma = `${req.method()} ${pathname}`;
    registro.atendidas.push(firma);
    const hit = rutas.find(([re]) => re.test(pathname));
    if (!hit) {
      registro.noMockeados.push(firma);
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    }
    const r = await hit[1](route);
    return route.fulfill({ status: r.status ?? 200, contentType: 'application/json', body: JSON.stringify(r.body) });
  });
  return registro;
}
