// Fixtures compartidos de la suite E2E del módulo LAFT (HU #11275).
//
// El módulo LAFT es una de las dos superficies del producto con PII cifrada y salidas regulatorias
// (SARLAFT / Ley 1581) y llegaba a esta HU con 0 % de cobertura E2E. Esta suite lo lleva a smoke:
// las 7 vistas montan, la exportación disponible descarga, la guarda de permisos aguanta y el
// listado de inusuales sabe fallar.
//
// Reglas de este archivo:
//   · NO modifica `helpers/auth.ts` ni ningún helper existente — se añade al lado, igual que
//     `pesv-fixtures.ts`. Otra sesión depende de `loginAs`/`ADMIN_USER` tal como están.
//   · TODOS los datos son sintéticos y así se leen a simple vista: documentos 9000000xx, nombres
//     «... SINTÉTICA ...» y correos en `example.invalid` (TLD reservado por la RFC 6761, no
//     resoluble). Ni un dato personal real entra en un spec (AGENTS.md, Ley 1581).
//   · Las formas de respuesta salen de las páginas, no de suposiciones: `/laft/counterparties`
//     devuelve `{rows,total,limit,offset}`, `/laft/unusual` `{rows,total}`, `/laft/trainings` un
//     ARRAY pelado, y `manual`/`officer/vigentes`/`audit-plan` un `{data:[...]}`.
import type { Page } from '@playwright/test';

/**
 * El usuario positivo de la suite es `compliance` con `allowedPages` VACÍO, no un admin comodín.
 *
 * Con `allowedPages: ['*']` la suite pasaría aunque alguien borrara los 7 slugs de
 * `ROLE_DEFAULT_PAGES.compliance`: el comodín concede todo. Con la lista vacía, el permiso que se
 * ejerce es el REAL del rol, así que el día que el catálogo pierda `laft_manual` el spec se cae y
 * dice por qué. Mismo criterio que `FINANCIERA_USER` en `helpers/auth.ts`.
 */
export const COMPLIANCE_LAFT_USER = {
  id: 2101,
  username: 'e2e_compliance_laft',
  name: 'Cumplimiento E2E',
  role: 'compliance' as const,
  allowedPages: [] as string[],
};

/** Una vista del módulo: su ruta, su permiso y las dos huellas que distinguen cargado de vacío. */
export interface VistaLaft {
  /** Ruta del SPA. */
  ruta: string;
  /** `page=` de su `ProtectedRoute` en `App.tsx`. */
  slug: string;
  /** Etiqueta del slug en `PAGES` (shared-types): es lo que escribe `NoAccess`. */
  etiqueta: string;
  /** `<h1>` de la vista (`PageHeaderCard`). */
  titulo: string;
  /** Nombre del componente lazy (`App.tsx`). En dev el módulo se pide por su ruta de origen
   *  (`/src/pages/LaftUnusual.tsx`) y en build por su chunk (`LaftUnusual-<hash>.js`). */
  componente: string;
  /** Glob del endpoint que monta la vista. */
  endpoint: string;
  /** Ruta exacta (pathname) de ese endpoint — para afirmar ausencias sin depender del glob. */
  ruta_api: string;
  /** Payload con datos (estado CARGADO). */
  cuerpo: unknown;
  /** Payload sin filas (estado VACÍO). */
  cuerpoVacio: unknown;
  /** Huella del estado cargado: sale del fixture, así que no puede aparecer por casualidad. */
  textoCargado: RegExp;
  /** Microcopy del estado vacío, tal cual está en la página. */
  textoVacio: RegExp;
  /**
   * Textos del fixture que identifican a alguien (nombre, documento, correo). Son los que NO pueden
   * aparecer en pantalla cuando la guarda de permisos actúa (AC3). Vacío en las vistas que no
   * muestran datos de persona.
   */
  huellaPii: string[];
}

export const VISTAS_LAFT: VistaLaft[] = [
  {
    ruta: '/laft',
    slug: 'laft',
    etiqueta: 'Cumplimiento LAFT',
    titulo: 'Cumplimiento LAFT',
    componente: 'Laft',
    endpoint: '**/api/laft/counterparties**',
    ruta_api: '/api/laft/counterparties',
    cuerpo: {
      rows: [{
        id: 9001,
        kind: 'PJ',
        docType: 'NIT',
        docNumber: '900000001',
        fullName: 'CONTRAPARTE SINTÉTICA UNO S.A.S.',
        email: 'contraparte.uno@example.invalid',
        city: 'Ciudad Fixture',
        country: 'CO',
        isPep: true,
        riskLevel: 'alto',
        status: 'pendiente',
        nextReviewAt: '2027-01-15',
        version: 1,
        createdAt: '2026-01-15T10:00:00.000Z',
      }],
      total: 1,
      limit: 50,
      offset: 0,
    },
    cuerpoVacio: { rows: [], total: 0, limit: 50, offset: 0 },
    textoCargado: /CONTRAPARTE SINTÉTICA UNO S\.A\.S\./,
    textoVacio: /Sin contrapartes registradas/,
    huellaPii: ['CONTRAPARTE SINTÉTICA UNO S.A.S.', '900000001'],
  },
  {
    ruta: '/laft/unusual',
    slug: 'laft_unusual',
    etiqueta: 'Operaciones inusuales',
    titulo: 'Operaciones inusuales',
    componente: 'LaftUnusual',
    endpoint: '**/api/laft/unusual**',
    ruta_api: '/api/laft/unusual',
    cuerpo: {
      rows: [{
        id: 9101,
        counterpartyId: 9001,
        counterpartyName: 'CONTRAPARTE SINTÉTICA DOS',
        counterpartyDoc: 'CC 900000002',
        detectedAt: '2026-02-03T14:30:00.000Z',
        source: 'fragmentacion_pagos',
        signals: ['Fragmentación sintética de pagos'],
        amount: '12345678',
        currency: 'COP',
        description: 'Operación de prueba sintética para la suite E2E del módulo LAFT.',
        decision: 'en_analisis',
        decidedAt: null,
        version: 1,
      }],
      total: 1,
    },
    cuerpoVacio: { rows: [], total: 0 },
    textoCargado: /CONTRAPARTE SINTÉTICA DOS/,
    textoVacio: /Sin operaciones registradas/,
    huellaPii: ['CONTRAPARTE SINTÉTICA DOS', '900000002'],
  },
  {
    ruta: '/laft/trainings',
    slug: 'laft_trainings',
    etiqueta: 'Capacitaciones',
    titulo: 'Programa de capacitaciones',
    componente: 'LaftTrainings',
    endpoint: '**/api/laft/trainings**',
    ruta_api: '/api/laft/trainings',
    // OJO: esta ruta devuelve un array PELADO, no `{rows}` ni `{data}`.
    cuerpo: [{
      id: 9201,
      title: 'Capacitación anual SARLAFT (fixture)',
      description: 'Contenido sintético de la suite E2E.',
      trainerName: 'Formador Sintético',
      scheduledAt: '2026-03-10T13:00:00.000Z',
      durationHours: '4.0',
      passingScore: 70,
      attendeesCount: 12,
      attendedCount: 11,
    }],
    cuerpoVacio: [],
    textoCargado: /Capacitación anual SARLAFT \(fixture\)/,
    textoVacio: /Sin capacitaciones registradas/,
    huellaPii: ['Formador Sintético'],
  },
  {
    ruta: '/laft/manual',
    slug: 'laft_manual',
    etiqueta: 'LAFT — Manual SARLAFT',
    titulo: 'Manual SARLAFT',
    componente: 'LaftManual',
    endpoint: '**/api/laft/manual',
    ruta_api: '/api/laft/manual',
    cuerpo: {
      data: [{
        id: 9301,
        version: 7,
        publicado: true,
        publicadoAt: '2026-04-01T09:00:00.000Z',
        sha256: 'f1x7u4e0aaaabbbbccccddddeeeeffff00001111222233334444555566667777',
        createdAt: '2026-03-25T09:00:00.000Z',
      }],
    },
    cuerpoVacio: { data: [] },
    textoCargado: /v7/,
    textoVacio: /Sin versiones de manual registradas/,
    huellaPii: [],
  },
  {
    ruta: '/laft/oficial',
    slug: 'laft_oficial',
    etiqueta: 'LAFT — Oficial cumplimiento',
    titulo: 'Oficial de cumplimiento',
    componente: 'LaftOfficer',
    endpoint: '**/api/laft/officer/vigentes',
    ruta_api: '/api/laft/officer/vigentes',
    cuerpo: {
      data: [{
        id: 9401,
        rol: 'principal',
        userName: 'Oficial Sintético Uno',
        userEmail: 'oficial.uno@example.invalid',
        validFrom: '2026-01-02T00:00:00.000Z',
        validTo: null,
        certificacionIso17024: true,
      }],
    },
    cuerpoVacio: { data: [] },
    textoCargado: /Oficial Sintético Uno/,
    textoVacio: /Sin oficiales vigentes designados/,
    huellaPii: ['Oficial Sintético Uno', 'oficial.uno@example.invalid'],
  },
  {
    ruta: '/laft/plan-auditorias',
    slug: 'laft_audit_plan',
    etiqueta: 'LAFT — Plan de auditorías',
    titulo: 'Plan de auditorías',
    componente: 'LaftAuditPlan',
    endpoint: '**/api/laft/audit-plan**',
    ruta_api: '/api/laft/audit-plan',
    cuerpo: {
      data: [{
        id: 9501,
        anio: 2026,
        tipo: 'interna',
        estado: 'en_ejecucion',
        titulo: 'Auditoría interna SARLAFT (fixture)',
      }],
    },
    cuerpoVacio: { data: [] },
    textoCargado: /Auditoría interna SARLAFT \(fixture\)/,
    textoVacio: /Sin planes de auditoría registrados/,
    huellaPii: [],
  },
  {
    ruta: '/laft/tablero',
    slug: 'laft_dashboard',
    etiqueta: 'LAFT — Tablero',
    titulo: 'Estado del cumplimiento',
    componente: 'LaftDashboard',
    endpoint: '**/api/laft/dashboard**',
    ruta_api: '/api/laft/dashboard',
    cuerpo: {
      officerInfo: { principal: true, suplente: true, principalIso17024: true, ok: true },
      manualVigente: { version: 7, publicadoAt: '2026-04-01T09:00:00.000Z', sha256: 'f1x7u4e0' },
      contrapartesAgg: { total: 42, alto: 3, pendientes: 5, bloqueadas: 1 },
      empleadosVencidos: 2,
    },
    // El tablero no tiene «estado vacío» propio: sin datos sigue pintando sus 4 tarjetas en cero.
    cuerpoVacio: {
      officerInfo: { principal: false, suplente: false, principalIso17024: false, ok: false },
      manualVigente: null,
      contrapartesAgg: { total: 0, alto: 0, pendientes: 0, bloqueadas: 0 },
      empleadosVencidos: 0,
    },
    textoCargado: /Riesgo alto: 3/,
    textoVacio: /No hay manual publicado/,
    huellaPii: [],
  },
];

/** Registra el endpoint de una vista con el cuerpo indicado. Devuelve el contador de peticiones. */
export async function mockVista(
  page: Page,
  vista: VistaLaft,
  cuerpo: unknown = vista.cuerpo,
): Promise<{ peticiones: string[] }> {
  const peticiones: string[] = [];
  await page.route(vista.endpoint, async (route) => {
    peticiones.push(new URL(route.request().url()).pathname);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(cuerpo),
    });
  });
  return { peticiones };
}
