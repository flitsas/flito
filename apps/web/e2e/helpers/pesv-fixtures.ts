// Helpers compartidos para specs PESV Diagnóstico (sprint Lerdorf).
//
// Define:
//   - Usuarios stub líder PESV y compliance con `allowedPages` que incluyen 'pesv'
//     (alineado con apps/web/src/lib/permissions.ts:44).
//   - Builders de payloads alineados con los contratos zod en
//     apps/api/src/modules/pesv/diagnostico.schemas.ts.
//   - Mock router helper `mockPesvBackend()` que registra los handlers comunes
//     para que cada spec sólo declare los que le interesan (overrides).
//
// NO toca helpers/auth.ts existente. NO ejecuta consultas reales contra BD.
//
// Convenciones:
//   - Las columnas numeric llegan como string a la app (driver postgres-js).
//   - Los timestamp llegan como ISO 8601.
//   - Microcopy oficial: "Res. 40595/2022" (NO 20223040045295). MOLANO.

import { Page, Route, Locator } from '@playwright/test';

// ─── Fixtures de usuario ──────────────────────────────────────────────────
// Alineado con apps/web/src/lib/permissions.ts: lider_pesv y compliance ven 'pesv'.
export const LIDER_PESV_USER = {
  id: 1001,
  username: 'e2e_lider_pesv',
  name: 'Líder PESV E2E',
  role: 'lider_pesv' as const,
  allowedPages: ['pesv', 'pesv_raci', 'pesv_normativa', 'pesv_retencion'],
};

export const LIDER_PESV_ALT_USER = {
  id: 1002,
  username: 'e2e_lider_pesv_alt',
  name: 'Líder PESV E2E (sesión B)',
  role: 'lider_pesv' as const,
  allowedPages: ['pesv', 'pesv_raci', 'pesv_normativa', 'pesv_retencion'],
};

export const COMPLIANCE_USER = {
  id: 2001,
  username: 'e2e_compliance',
  name: 'Compliance E2E',
  role: 'compliance' as const,
  allowedPages: ['dashboard', 'laft', 'pesv', 'pesv_raci', 'pesv_normativa', 'pesv_retencion'],
};

// ─── Builders ─────────────────────────────────────────────────────────────
export type NivelRubrica = 'no_implementado' | 'en_desarrollo' | 'implementado' | 'sostenido';
export type FasePhva = 'planear' | 'hacer' | 'verificar' | 'actuar';

export interface ItemFixture {
  estandarId: number;
  codigo: string;
  paso: number;
  fase: FasePhva;
  nombre: string;
  descripcion: string | null;
  peso: string;
  orden: number;
  scorePct: string;
  nivelRubrica: NivelRubrica;
  comentarios: string | null;
  evidencias: EvidenciaFixture[];
  updatedAt: string;
  diagnosticoId?: number;
}

export interface EvidenciaFixture {
  keyHash: string;
  filename: string;
  sizeBytes: number;
  mime: string;
  uploadedAt: string;
  uploadedBy: number;
}

const FASES_24: Array<{ fase: FasePhva; paso: number; codigo: string; nombre: string }> = [
  { fase: 'planear', paso: 1, codigo: 'P1.1', nombre: 'Política PESV firmada' },
  { fase: 'planear', paso: 2, codigo: 'P1.2', nombre: 'Objetivos PESV documentados' },
  { fase: 'planear', paso: 3, codigo: 'P1.3', nombre: 'Comité PESV constituido' },
  { fase: 'planear', paso: 4, codigo: 'P1.4', nombre: 'Responsable PESV designado' },
  { fase: 'planear', paso: 5, codigo: 'P1.5', nombre: 'Matriz RACI definida' },
  { fase: 'planear', paso: 6, codigo: 'P1.6', nombre: 'Diagnóstico inicial de riesgos' },
  { fase: 'hacer', paso: 7, codigo: 'H2.1', nombre: 'Comportamiento humano: selección conductores' },
  { fase: 'hacer', paso: 8, codigo: 'H2.2', nombre: 'Pruebas psicosensométricas' },
  { fase: 'hacer', paso: 9, codigo: 'H2.3', nombre: 'Capacitación en seguridad vial' },
  { fase: 'hacer', paso: 10, codigo: 'H2.4', nombre: 'Control consumo alcohol y SPA' },
  { fase: 'hacer', paso: 11, codigo: 'H3.1', nombre: 'Mantenimiento preventivo flota' },
  { fase: 'hacer', paso: 12, codigo: 'H3.2', nombre: 'Inspección pre-operacional' },
  { fase: 'hacer', paso: 13, codigo: 'H3.3', nombre: 'Documentación vehículos al día' },
  { fase: 'hacer', paso: 14, codigo: 'H4.1', nombre: 'Rutas y desplazamientos seguros' },
  { fase: 'hacer', paso: 15, codigo: 'H4.2', nombre: 'Política horas de conducción' },
  { fase: 'hacer', paso: 16, codigo: 'H4.3', nombre: 'Atención a accidentes en vía' },
  { fase: 'verificar', paso: 17, codigo: 'V5.1', nombre: 'Indicadores PESV' },
  { fase: 'verificar', paso: 18, codigo: 'V5.2', nombre: 'Auditorías internas anuales' },
  { fase: 'verificar', paso: 19, codigo: 'V5.3', nombre: 'Reporte e investigación incidentes' },
  { fase: 'verificar', paso: 20, codigo: 'V5.4', nombre: 'Evaluación contratistas con flota' },
  { fase: 'actuar', paso: 21, codigo: 'A6.1', nombre: 'Acciones correctivas y preventivas' },
  { fase: 'actuar', paso: 22, codigo: 'A6.2', nombre: 'Revisión por la dirección' },
  { fase: 'actuar', paso: 23, codigo: 'A6.3', nombre: 'Mejora continua' },
  { fase: 'actuar', paso: 24, codigo: 'A6.4', nombre: 'Lecciones aprendidas comunicadas' },
];

export function build24Items(opts: { diagnosticoId?: number } = {}): ItemFixture[] {
  const diagnosticoId = opts.diagnosticoId ?? 1;
  const updatedAt = '2026-05-12T10:00:00.000Z';
  return FASES_24.map((f, i) => ({
    diagnosticoId,
    estandarId: 1000 + i + 1,
    codigo: f.codigo,
    paso: f.paso,
    fase: f.fase,
    nombre: f.nombre,
    descripcion: `Descripción normativa del estándar ${f.codigo} (Res. 40595/2022 anexo).`,
    peso: '1.00',
    orden: i + 1,
    scorePct: '0.00',
    nivelRubrica: 'no_implementado',
    comentarios: null,
    evidencias: [],
    updatedAt,
  }));
}

export function buildDiagDetail(opts: {
  id?: number;
  anio?: number;
  estado?: 'borrador' | 'cerrado';
  items?: ItemFixture[];
  scoreGlobal?: string;
} = {}) {
  const id = opts.id ?? 1;
  const items = opts.items ?? build24Items({ diagnosticoId: id });
  return {
    id,
    anio: opts.anio ?? 2027,
    fecha: '2026-05-12',
    scoreGlobal: opts.scoreGlobal ?? '0.00',
    estado: opts.estado ?? 'borrador',
    cerradoAt: opts.estado === 'cerrado' ? '2026-05-12T15:00:00.000Z' : null,
    createdAt: '2026-05-12T09:00:00.000Z',
    updatedAt: '2026-05-12T10:00:00.000Z',
    nivelEmpresa: 'avanzado' as const,
    responsableId: LIDER_PESV_USER.id,
    nivelCriterioJustificacion: null,
    observaciones: null,
    items,
    historial: [],
  };
}

export function buildPreflight(opts: {
  totalEstandares?: number;
  evaluados?: number;
  conEvidencia?: number;
  bloqueos?: Array<{ estandarId: number; codigo: string; motivo: string }>;
  advertencias?: Array<{ estandarId: number; codigo: string; motivo: string }>;
  scoreProyectado?: number;
} = {}) {
  const bloqueos = opts.bloqueos ?? [];
  const advertencias = opts.advertencias ?? [];
  return {
    scoreProyectado: opts.scoreProyectado ?? 0,
    totalEstandares: opts.totalEstandares ?? 24,
    evaluados: opts.evaluados ?? 0,
    conEvidencia: opts.conEvidencia ?? 0,
    bloqueos,
    advertencias,
    puedeCerrar: bloqueos.length === 0,
  };
}

// ─── /me + login helpers ──────────────────────────────────────────────────
export async function loginAsUser(page: Page, user: typeof LIDER_PESV_USER | typeof COMPLIANCE_USER) {
  await page.route('**/api/auth/me', async (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(user) }),
  );
  await page.goto('/login');
  await page.evaluate(() => localStorage.setItem('token', 'fake.jwt.e2e'));
}

// ─── Mock fijo para listado vacío de catálogo (módulos hermanos) ──────────
export async function stubPesvSiblings(page: Page) {
  // Algunas páginas hermanas pueden consultarse en lazy preload — ignoramos.
  await page.route('**/api/pesv/estandares**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }),
  );
}

// ─── Pequeño helper para responder JSON ───────────────────────────────────
export function jsonRoute(status: number, body: unknown) {
  return (route: Route) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

// ─── Selectores robustos para RubricaRadioGroup ───────────────────────────
// Los radios reales son <input type="radio" value="..."> visualmente ocultos
// (className "absolute opacity-0 w-0 h-0"). Los <label htmlFor> que los
// envuelven SÍ son visibles y clickables. Usamos el attribute `value` por ser
// único (los aria-labels derivados del texto matchean varios elementos: "No
// implementado" + "Implementado" + "Sostenido 100% Implementado").
//
// `rubricaRadio(scope, nivel)` → locator del <input> (estable, único).
// `rubricaLabel(scope, nivel)` → locator del <label> contenedor (clickable).
export function rubricaRadio(scope: Page | Locator, nivel: NivelRubrica): Locator {
  return scope.locator(`input[type="radio"][value="${nivel}"]`);
}

export function rubricaLabel(scope: Page | Locator, nivel: NivelRubrica): Locator {
  // El input tiene id="…-<nivel>" generado vía useId() y el label htmlFor lo
  // referencia. Apuntamos al label por su htmlFor terminado en `-<nivel>`.
  return scope.locator(`label[for$="-${nivel}"]`);
}

/**
 * Selecciona un nivel de la rúbrica de forma robusta.
 *
 * El componente RubricaRadioGroup oculta visualmente el <input type="radio">
 * (className "absolute opacity-0 w-0 h-0"). Playwright `.click()` falla con
 * "outside of the viewport" aún con `force:true` porque el bounding box es 0×0.
 *
 * Estrategia: click sobre el <label htmlFor={id}> contenedor (visible y wired
 * al radio). El navegador convierte el click del label en un click nativo del
 * input → dispara `change` event con bubbles → React captura vía delegación
 * en root y ejecuta onChange. Validado en Chromium Playwright headless.
 *
 * Para garantizar idempotencia en navegadores donde label→input no propaga
 * (raro pero posible), validamos `checked` y, si falla, hacemos un commit
 * directo simulando el evento nativo de React.
 */
export async function selectRubricaNivel(scope: Page | Locator, nivel: NivelRubrica): Promise<void> {
  await rubricaLabel(scope, nivel).click();
  // Validación + fallback determinista: si por timing el click del label no
  // propagó al input, forzamos el cambio via setter nativo + dispatch 'change'
  // que es el ciclo que React-DOM observa para sincronizar onChange.
  const checked = await rubricaRadio(scope, nivel).evaluate(
    (el) => (el as HTMLInputElement).checked,
  );
  if (!checked) {
    await rubricaRadio(scope, nivel).evaluate((el) => {
      const input = el as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'checked',
      )?.set;
      setter?.call(input, true);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
}
