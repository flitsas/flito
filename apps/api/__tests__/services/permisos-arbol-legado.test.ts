// HU #13429 (diseño §5-quater.2-4) — Los ítems antiguos en el nivel 2, la clasificación de toda operación viva, el
// retiro de los 43 transitorios y la PARIDAD con el gating de la cadena: sobre el pliegue de las migraciones
// 0001..0237 (antes) y 0001..0239 (después), ningún rol pierde nada y solo gana lo que aprobó el PO (AC3, P-24 con
// la alternativa A1, P-30). TCs de `docs/qa/hu-13429-tcs.md`: TC-02, TC-03, TC-04, TC-06, TC-07, TC-08, TC-25, TC-28.
//
// Mutantes nombrados:
//   · quitar `exigeItem` de las acciones «Administrar» de PESV → supervisor_flota gana normativa/RACI/retención y
//     cae «ganancias = exactamente las aprobadas».
//   · cambiar `alguna` por la regla «todos» → compliance, supervisor_flota y lider_pesv no ganan y cae la misma tabla.
//   · añadir `pagina.pesv_plan` a la expansión de un transitorio (A1 deshecha) → cae «el conductor gana 0».
import { describe, it, expect } from 'vitest';
import { ITEMS_LEGADO, PAGES } from '@operaciones/shared-types';
import { catalogoCompleto, PAGINAS_NO_CONCEDIBLES } from '../../src/modules/permisos/catalogo.js';
import { CODIGOS_ABSORBIDOS, expandir, expandirSinCadena, ITEMS_ANTIGUOS, PADRE } from '../../src/modules/permisos/arbol/expansion.js';
import {
  FAMILIA_ADMINISTRACION_PESV, ITEMS_LEGADO_OPS, TRANSITORIOS_RETIRADOS, TRANSVERSALES,
} from '../../src/modules/permisos/arbol/acciones-legado.js';
import { NOMBRES_LEGADO } from '../../src/modules/permisos/catalogo-operaciones.legado.js';
import { MIGRACIONES_CON_REPARTO, leerRepartoSembrado } from '../helpers/permisos-seed-sql.js';

const PESV_CON_ADMINISTRAR = ITEMS_LEGADO.filter((i) => i.acciones.length > 0);

describe('AC1 / TC-02 y TC-03 — los ítems antiguos en el nivel 2', () => {
  it('46 ítems antiguos, cada uno bajo un elemento; sin nivel 3 salvo «Administrar» en los 20 PESV con operaciones (A1)', () => {
    expect(ITEMS_LEGADO).toHaveLength(46);
    expect(new Set(ITEMS_LEGADO.map((i) => `pagina.${i.slug}`))).toEqual(ITEMS_ANTIGUOS);
    expect(PESV_CON_ADMINISTRAR).toHaveLength(20);
    for (const i of PESV_CON_ADMINISTRAR) {
      expect(i.slug, i.slug).toMatch(/^pesv_/);
      expect(i.acciones.map((a) => a.clave)).toEqual(['administrar']);
    }
    // Los 5 PESV sin operaciones siguen puros.
    expect(ITEMS_LEGADO.filter((i) => i.elemento === 'pesv' && i.acciones.length === 0).map((i) => i.slug).sort())
      .toEqual(['pesv', 'pesv_indicadores_operacion', 'pesv_mi_jornada', 'pesv_reportar_incidente', 'pesv_siniestralidad']);
  });

  it('TC-02: toda página concedible es un ítem que cuelga de un `menu.*`; ningún `menu.*` cuelga de otro nodo', () => {
    // Menos las que absorbe una acción (la compuerta, P-10; el Tablero FLITO, P-11): esas las abre su acción.
    const concedibles = Object.keys(PAGES)
      .filter((s) => !(PAGINAS_NO_CONCEDIBLES as readonly string[]).includes(s) && !CODIGOS_ABSORBIDOS.has(`pagina.${s}`));
    for (const slug of concedibles) {
      const padre = PADRE.get(`pagina.${slug}`);
      expect(padre, slug).toMatch(/^menu\./);
      expect(PADRE.get(padre!), slug).toBeNull();
    }
    const paginas = catalogoCompleto().filter((f) => f.tipo === 'pagina');
    expect(paginas.every((f) => f.nivel === 2 && f.padre?.startsWith('menu.'))).toBe(true);
  });

  it('P-27: Privacidad y Log accesos PII son un solo ítem; P-28: SOAT, Lector de impuestos y Mantenimiento quedan', () => {
    for (const c of ['pagina.privacy', 'pagina.soat', 'pagina.tax_reader', 'pagina.maintenance']) expect(ITEMS_ANTIGUOS.has(c), c).toBe(true);
    expect(ITEMS_LEGADO_OPS['pagina.privacy']!.operaciones).toContain('privacy.accesos_pii.ver');
  });
});

describe('AC2 / TC-04 y TC-06 — expansión de los ítems antiguos', () => {
  it.each(Object.entries(ITEMS_LEGADO_OPS).filter(([, i]) => i.operaciones.length))('%s concede todas sus operaciones', (item, i) => {
    const efectivo = expandir([PADRE.get(item)!, item]);
    for (const op of i.operaciones) expect(efectivo.has(op), op).toBe(true);
    for (const op of i.opcionales ?? []) expect(efectivo.has(op), `${op} es opcional: no se expande`).toBe(false);
  });

  it('TC-06: solo expanden los ítems antiguos listados; un ítem FLITO marcado no da ninguna operación sin su acción', () => {
    expect(expandir(['menu.gestion', 'pagina.flito_soat']).has('soat.cola.ver')).toBe(false);
    expect(expandir(['menu.administracion', 'pagina.users']).has('usuarios.usuario.listar')).toBe(false);
  });

  it('P-26: `ver_documento`, `firmar` y `soat.antiguo.operar` son opcionales de su ítem; nadie los gana', () => {
    expect(ITEMS_LEGADO_OPS['pagina.vehicles']!.opcionales).toEqual(['vehicles.propietario.ver_documento']);
    expect(ITEMS_LEGADO_OPS['pagina.laft_manual']!.opcionales).toEqual(['laft.manual.firmar']);
    expect(ITEMS_LEGADO_OPS['pagina.soat']!.opcionales).toEqual(['soat.antiguo.operar']);
  });
});

describe('Clasificación — toda operación viva es opcional (de su acción o ítem) o transversal', () => {
  it('el catálogo no deja ninguna sin clase y los transversales son los 5 de P-29', () => {
    const vivas = catalogoCompleto().filter((f) => f.tipo === 'operacion');
    expect(vivas.filter((f) => !f.padre).map((f) => f.codigo).sort()).toEqual([...TRANSVERSALES].sort());
    for (const f of vivas.filter((x) => x.padre)) expect(PADRE.has(f.padre!), f.codigo).toBe(true);
  });
});

describe('AC3 / TC-07 — se retiran los 43 transitorios; `siigo.conceptos.administrar` sigue siendo de su acción', () => {
  it('la lista es la de la marca «Transitorio» de NOMBRES_LEGADO menos los dos ya retirados, nunca por sufijo', () => {
    const marcados = Object.entries(NOMBRES_LEGADO).filter(([, n]) => /Transitorio/.test(n.descripcion)).map(([c]) => c);
    const yaRetirados = ['clients.clientes.administrar', 'siigo.parametrizacion.administrar'];
    expect(TRANSITORIOS_RETIRADOS).toEqual(marcados.filter((c) => !yaRetirados.includes(c)).sort());
    expect(TRANSITORIOS_RETIRADOS).toHaveLength(43);
    expect(TRANSITORIOS_RETIRADOS).toContain('liquidacion.pago_manual.administrar');
    expect(TRANSITORIOS_RETIRADOS).not.toContain('siigo.conceptos.administrar');
  });

  it('ninguno queda en el catálogo; `siigo.conceptos.administrar` lo sigue dando «Mapeo de conceptos»', () => {
    const codigos = new Set(catalogoCompleto().map((f) => f.codigo));
    for (const t of TRANSITORIOS_RETIRADOS) {
      expect(codigos.has(t), t).toBe(false);
      expect(CODIGOS_ABSORBIDOS.has(t), t).toBe(true);
    }
    expect(expandir(['menu.finanzas', 'pagina.siigo_parametrizacion', 'accion.facturacion_parametrizacion.mapeo_conceptos'])
      .has('siigo.conceptos.administrar')).toBe(true);
  });
});

// ── Paridad sobre el pliegue (TC-08, TC-25, TC-28) ──────────────────────────────────────────────────────────────

const ANTES = leerRepartoSembrado(MIGRACIONES_CON_REPARTO.filter((m) => m < '0238'));
const DESPUES = leerRepartoSembrado();
/** Operaciones y páginas (los `menu.*` y `accion.*` son contenedores, no acceso por sí mismos). */
const acceso = (s: Set<string>) => new Set([...s].filter((c) => !c.startsWith('menu.') && !c.startsWith('accion.')));
const hoy = (rol: string) => acceso(expandirSinCadena(ANTES.get(rol) ?? []));
const manana = (rol: string) => acceso(expandir(DESPUES.get(rol) ?? []));

const PESV_SIN = (...fuera: string[]) => FAMILIA_ADMINISTRACION_PESV.filter((c) => !fuera.includes(c));
const LIDER_TENIA = [
  'drivers.incidentes_registro.administrar', 'pesv.auditorias.administrar', 'pesv.comite.administrar', 'pesv.comunicaciones.administrar',
  'pesv.contratistas.administrar', 'pesv.diagnostico.administrar', 'pesv.diagnostico_consulta.administrar',
  'pesv.incidentes_causa_raiz.administrar', 'pesv.normativa_edicion.administrar', 'pesv.plan.administrar',
  'pesv.politica_edicion.administrar', 'pesv.raci.administrar', 'pesv.retencion_edicion.administrar',
];
const FLOTA_Y_MANTENIMIENTO = ['fleet.flota.administrar', 'maintenance.inicio.administrar', 'maintenance.ordenes.administrar', 'liquidacion.pago_manual.administrar'];

/** Lo aprobado (AC3, P-24 con A1, P-30): por rol, exactamente lo que gana. */
const GANANCIAS: Record<string, string[]> = {
  admin: [],
  auditor: ['pagina.transito_organismos', 'laft.manual.administrar', 'laft.oficial.administrar', 'laft.plan_auditoria.administrar', 'soat.antiguo.administrar'],
  cliente: [],
  compliance: [
    ...PESV_SIN('pesv.diagnostico_consulta.administrar'), 'privacy.olvido.administrar',
    'laft.listas.administrar', 'laft.retencion.administrar', 'laft.sincronizacion.administrar', 'laft.manual.administrar', 'laft.oficial.administrar',
  ],
  conductor: [],
  financiera: [],
  gestor_impuestos: [],
  lider_pesv: [...PESV_SIN(...LIDER_TENIA), ...FLOTA_Y_MANTENIMIENTO],
  mensajero: ['pagina.flito_logistica'],
  proveedor: ['soat.antiguo.administrar'],
  // Sin RACI, normativa ni retención (no tiene esas páginas: `exigeItem`) y sin lo que ya administraba.
  supervisor_flota: [
    ...PESV_SIN('pesv.normativa.administrar', 'pesv.normativa_edicion.administrar', 'pesv.raci.administrar', 'pesv.retencion.administrar',
      'pesv.retencion_edicion.administrar', 'pesv.incidentes_causa_raiz.administrar', 'drivers.incidentes_registro.administrar'),
    ...FLOTA_Y_MANTENIMIENTO, 'vehicles.vehiculos.administrar',
  ],
  transito: ['pagina.transito_organismos'],
};

describe('AC3 / TC-08 y TC-25 — paridad con el gating: nadie pierde; solo se gana lo aprobado', () => {
  it('el pliegue tiene los 12 roles antes y después', () => {
    expect([...ANTES.keys()].sort()).toEqual(Object.keys(GANANCIAS).sort());
    expect([...DESPUES.keys()].sort()).toEqual(Object.keys(GANANCIAS).sort());
  });

  it.each(Object.keys(GANANCIAS))('%s: pérdidas = 0 y ganancias = exactamente las aprobadas', (rol) => {
    const a = hoy(rol);
    const m = manana(rol);
    expect([...a].filter((c) => !m.has(c)), 'pierde').toEqual([]);
    expect([...m].filter((c) => !a.has(c)).sort(), 'gana').toEqual([...GANANCIAS[rol]!].sort());
  });

  it('cuentas de la tabla del diseño (§5-quater.4): compliance 31, supervisor_flota 24, lider_pesv 17, auditor 4 + Organismos STT', () => {
    expect(GANANCIAS.compliance).toHaveLength(31);
    expect(GANANCIAS.supervisor_flota).toHaveLength(24);
    expect(GANANCIAS.lider_pesv).toHaveLength(17);
    expect(GANANCIAS.auditor).toHaveLength(5);
  });

  it('el rol que tenía todo tiene todo: admin, con todos los elementos y todas las acciones «Administrar»', () => {
    const admin = DESPUES.get('admin')!;
    for (const i of PESV_CON_ADMINISTRAR) expect(admin.has(`accion.${i.slug}.administrar`), i.slug).toBe(true);
    for (const e of catalogoCompleto().filter((f) => f.tipo === 'elemento')) expect(admin.has(e.codigo), e.codigo).toBe(true);
  });
});

describe('P-24 / TC-28 — el conductor: 0 ganancias y paridad de sus 22 pantallas (alternativa A1)', () => {
  it('conserva sus 22 pantallas efectivas y no recibe ninguna acción «Administrar»', () => {
    const antes = [...hoy('conductor')].filter((c) => c.startsWith('pagina.')).sort();
    expect(antes).toHaveLength(24); // 22 de PESV + Tablero + Perfil
    expect(antes.filter((c) => c.startsWith('pagina.pesv'))).toHaveLength(22);
    const despues = manana('conductor');
    for (const p of antes) expect(despues.has(p), p).toBe(true);
    expect([...DESPUES.get('conductor')!].filter((c) => c.startsWith('accion.pesv'))).toEqual([]);
    expect([...despues].filter((c) => FAMILIA_ADMINISTRACION_PESV.includes(c))).toEqual([]);
  });

  it('recibe `menu.pesv`, `menu.general` y `menu.perfil` (el contenedor de lo que ya ve, no una ganancia)', () => {
    const c = DESPUES.get('conductor')!;
    for (const m of ['menu.pesv', 'menu.general', 'menu.perfil']) expect(c.has(m), m).toBe(true);
  });
});
