// Épica #14678 «[ Menú ] Organizar FLITO por áreas de la empresa» (ADR-0048, expand → contract) — PR1: el contrato del
// árbol (`@operaciones/shared-types`) y la migración 0315. Cubre:
//   · el mapa aprobado por el humano y el PO (2026-11-24): cada página bajo su `menu.*` nuevo;
//   · los ocho elementos viejos deprecados y sin hijos, `menu.administracion` reutilizado y vivo;
//   · la cadena menú → página efectiva en el árbol nuevo (el elemento viejo ya no habilita la página);
//   · la 0315: su mapa es `MENU_POR_AREAS`, marca a `admin` (ADR-0022) sin otros literales de rol, sin auditoría;
//   · pérdidas = 0 y ganancias = 0 por rol en el pliegue de todas las migraciones (árbol de antes vs. de después);
//   · V3/R7 (DESCARTADA): aunque `REPARTO_POSTERIOR_AL_ARBOL` corre después de derivar los roles de cada `menu.*`,
//     las páginas de la Torre ya traen esos roles antes (y el proveedor tiene Operaciones por SOAT): su elemento los ve.
// Lo que el pliegue no ve (marcas dormidas, excepciones de usuario) lo cubre la medición sobre la base local del PR.
import { describe, it, expect } from 'vitest';
import { ARBOL_PERMISOS, ELEMENTOS_DEPRECADOS, ELEMENTOS_PERMISOS } from '@operaciones/shared-types';
import { catalogoCompleto } from '../../src/modules/permisos/catalogo.js';
import { expandir, PADRE } from '../../src/modules/permisos/arbol/expansion.js';
import { REPARTO_TORRE } from '../../src/modules/permisos/arbol/acciones-torre.js';
import {
  catalogoAntesDeAreas, ELEMENTO_ANTERIOR, ELEMENTOS_AREAS_VACIAS_14678, ELEMENTOS_NUEVOS_14678, MENU_POR_AREAS, PADRE_ANTES_DE_AREAS,
} from '../../src/modules/permisos/arbol/menu-por-areas.js';
import {
  bloquesInsertSiRolExiste, leerRepartoSembrado, literalesDeRol, menuPorAreasDeSql, MIGRACIONES_CON_REPARTO,
} from '../helpers/permisos-seed-sql.js';
import { leerMigracion } from '../helpers/base-en-tx.js';

const MIGRACION = '0315_flito_menu_por_areas.sql';
const SQL = leerMigracion(MIGRACION);
const MIGRACION_0316 = '0316_flito_menu_areas_proximamente.sql';
const SQL_0316 = leerMigracion(MIGRACION_0316);
const pagina = (slug: string) => `pagina.${slug}`;

/** El mapa aprobado (ADR-0048, «Decisiones del humano»), por página. Las páginas sin entrada de menú, marcadas. */
const MAPA: Record<string, readonly string[]> = {
  'menu.operaciones': ['vehicles', 'clients', 'flito_tramites', 'flito_derechos', 'flito_revisiones', 'flito_bitacora', 'flito_comparendos',
    'flito_logistica', 'flito_logistica_ruta', 'flito_soat', 'flito_impuestos'],
  'menu.financiera': ['finanzas_reporte_costos', 'finanzas_gastos_diarios', 'flito_bolsas', 'flito_tarifas', 'flito_servicios_adicionales',
    'flito_comprobantes', 'flito_conciliacion', 'siigo_parametrizacion', 'siigo_operacion', 'siigo_credenciales'],
  'menu.gerencial': ['dashboard', 'torre_360', 'torre_comercial', 'torre_operativa', 'torre_productos', 'torre_logistica', 'torre_financiera',
    'torre_explorador', 'torre_umbrales',
    'torre_detalle', // sin entrada de menú (lo abre cada cifra de la Torre): va con su familia
  ],
  'menu.kyverum': ['transito', 'fleet', 'maintenance_inicio', 'maintenance_ordenes', 'maintenance_indicadores',
    'pesv', 'pesv_conductores', 'pesv_capacitaciones', 'pesv_incidentes', 'pesv_siniestralidad', 'pesv_checklists', 'pesv_alcoholimetria',
    'pesv_emergencias', 'pesv_indicadores_operacion', 'pesv_politica', 'pesv_comite', 'pesv_plan', 'pesv_diagnostico', 'pesv_tablero_ejecutivo',
    'pesv_reportar_incidente', 'pesv_auditorias', 'pesv_comunicaciones', 'pesv_contratistas', 'pesv_jornadas', 'pesv_mi_jornada', 'pesv_rutas',
    'pesv_pernocta', 'pesv_raci', 'pesv_normativa', 'pesv_retencion',
    'rndc', 'rndc_admin', 'laft', 'laft_unusual', 'laft_trainings', 'laft_manual', 'laft_oficial', 'laft_audit_plan', 'laft_dashboard', 'tramite',
    'maintenance', 'soat', 'tax_reader', // sin entrada de menú: ítems antiguos (P-28), con el resto del legado
  ],
  'menu.administracion': ['privacy', 'users', 'roles_permisos', 'drive', 'admin_rendimiento', 'transito_organismos', 'ia_consumo'], // Épica #14548 (ADR-0051)
  'menu.general': ['flito_dr_flit'],
  'menu.perfil': ['perfil'],
};

const hijosDe = (elemento: string) => ARBOL_PERMISOS.filter((n) => n.padre === elemento).map((n) => n.codigo).sort();

describe('el mapa del menú por áreas (ADR-0048)', () => {
  it.each(Object.entries(MAPA))('%s: exactamente sus páginas, ni una más', (elemento, slugs) => {
    for (const s of slugs) expect(PADRE.get(pagina(s)), s).toBe(elemento);
    expect(hijosDe(elemento)).toEqual(slugs.map(pagina).sort());
  });

  it('las 25 de PESV, RNDC (2 páginas), LAFT (7) y Mantenimiento (3 + el general) van a Kyverum (V4)', () => {
    const k = MAPA['menu.kyverum']!;
    expect(k.filter((s) => s.startsWith('pesv'))).toHaveLength(25);
    expect(k.filter((s) => s.startsWith('laft'))).toHaveLength(7);
    expect(k.filter((s) => s.startsWith('rndc'))).toHaveLength(2);
    expect(k.filter((s) => s.startsWith('maintenance'))).toHaveLength(4);
    expect(k).toHaveLength(43);
  });

  it('opciones nuevas en el orden del menú; ocho deprecados sin hijos; Administración reutilizada y viva', () => {
    const vivos = ELEMENTOS_PERMISOS.filter((e) => !e.deprecado).sort((a, b) => a.orden - b.orden).map((e) => e.codigo);
    expect(vivos).toEqual(['menu.operaciones', 'menu.financiera', 'menu.comercial', 'menu.diseno', 'menu.tecnologia',
      'menu.infraestructura', 'menu.producto', 'menu.gerencial', 'menu.kyverum', 'menu.general', 'menu.administracion',
      'menu.ayuda', 'menu.perfil']);
    // Orden 1-9: antes que todo; Gerencial y Kyverum pasan a 8 y 9 con la 0316 (PR 4) para dejar 3-7 a las áreas
    // vacías. Los deprecados y General conservan el suyo (sin empates con las opciones nuevas). El texto de la 0315
    // (aplicada) no cambia: sigue sembrando 3 y 4, y la 0316 re-numera.
    expect(ELEMENTOS_NUEVOS_14678.map((c) => [c, ELEMENTOS_PERMISOS.find((e) => e.codigo === c)!.orden])).toEqual([
      ['menu.operaciones', 1], ['menu.financiera', 2], ['menu.gerencial', 8], ['menu.kyverum', 9],
    ]);
    expect(SQL).toMatch(/\('menu\.operaciones', 'operaciones', 'Operaciones', '[^']*', 'elemento', '1', '1'\)/);
    expect(SQL).toMatch(/\('menu\.kyverum', 'kyverum', 'Kyverum', '[^']*', 'elemento', '1', '4'\)/);
    expect([...ELEMENTOS_DEPRECADOS].sort()).toEqual(['menu.finanzas', 'menu.flota', 'menu.gestion', 'menu.laft', 'menu.mantenimiento',
      'menu.pesv', 'menu.rndc', 'menu.transito']);
    for (const e of ELEMENTOS_DEPRECADOS) expect(hijosDe(e), e).toEqual([]);
    expect(ELEMENTOS_PERMISOS.filter((e) => e.deprecado && e.tipo !== 'elemento')).toEqual([]);
    // Siguen en el catálogo (el arranque no ve códigos huérfanos) y en el árbol que devuelve la API.
    const cat = new Set(catalogoCompleto().map((f) => f.codigo));
    for (const e of [...ELEMENTOS_DEPRECADOS, ...ELEMENTOS_NUEVOS_14678]) expect(cat.has(e), e).toBe(true);
  });
});

describe('la cadena menú → página en el árbol nuevo', () => {
  it('la página se ve con su opción nueva; con solo el elemento viejo, no', () => {
    expect(expandir(['menu.kyverum', 'pagina.pesv_plan']).has('pagina.pesv_plan')).toBe(true);
    expect(expandir(['menu.pesv', 'pagina.pesv_plan']).has('pagina.pesv_plan')).toBe(false);
    expect(expandir(['menu.administracion', 'pagina.transito_organismos']).has('pagina.transito_organismos')).toBe(true);
    expect(expandir(['menu.transito', 'pagina.transito_organismos']).has('pagina.transito_organismos')).toBe(false);
    expect(expandir(['menu.financiera', 'pagina.siigo_credenciales']).has('pagina.siigo_credenciales')).toBe(true);
    expect(expandir(['menu.administracion', 'pagina.siigo_credenciales']).has('pagina.siigo_credenciales')).toBe(false);
    // Revocar la opción nueva apaga la página y sus acciones (revocar gana).
    const tablero = ['menu.gerencial', 'pagina.torre_360', 'accion.torre_360.ver'];
    expect(expandir(tablero).has('accion.torre_360.ver')).toBe(true);
    const sinMenu = expandir(tablero.filter((c) => c !== 'menu.gerencial'), ['menu.gerencial']);
    expect(sinMenu.has('pagina.torre_360')).toBe(false);
    expect(sinMenu.has('accion.torre_360.ver')).toBe(false);
  });

  it('el árbol de antes (reportes en seco de la 0239/0240) conserva los padres viejos', () => {
    expect(PADRE_ANTES_DE_AREAS.get('pagina.pesv_plan')).toBe('menu.pesv');
    expect(PADRE_ANTES_DE_AREAS.get('pagina.transito_organismos')).toBe('menu.transito');
    expect(PADRE_ANTES_DE_AREAS.has('menu.kyverum')).toBe(false);
    const antes = catalogoAntesDeAreas(catalogoCompleto());
    expect(antes.find((f) => f.codigo === 'pagina.torre_umbrales')).toMatchObject({ padre: 'menu.administracion', orden: 70 });
    expect(antes.some((f) => ELEMENTOS_NUEVOS_14678.includes(f.codigo))).toBe(false);
  });
});

describe('la migración 0315', () => {
  it('su mapa es exactamente `MENU_POR_AREAS`: toda página que cuelga de una opción nueva, y Organismos STT', () => {
    const mapa = menuPorAreasDeSql(SQL)!;
    expect(mapa.map(([p, v, n, o]) => ({ pagina: p, viejo: v, nuevo: n, orden: Number(o) })))
      .toEqual(MENU_POR_AREAS.map(({ pagina: p, viejo, nuevo, orden }) => ({ pagina: p, viejo, nuevo, orden })));
    const destino = new Set(ELEMENTOS_NUEVOS_14678);
    const esperado = ARBOL_PERMISOS.filter((n) => n.tipo === 'item' && destino.has(n.padre!)).map((n) => n.codigo);
    expect(mapa.map(([p]) => p).sort()).toEqual([...esperado, 'pagina.transito_organismos'].sort());
    for (const [p, v] of mapa) expect(ELEMENTO_ANTERIOR.get(p), p).toBe(v);
    expect(mapa).toHaveLength(75);
  });

  it('siembra los cuatro elementos y se los marca a `admin` por JOIN (ADR-0022); ningún otro literal de rol', () => {
    for (const e of ELEMENTOS_NUEVOS_14678) expect(SQL).toContain(`('${e}', '${e.slice(5)}',`);
    const admin = bloquesInsertSiRolExiste(SQL).join('');
    for (const e of ELEMENTOS_NUEVOS_14678) expect(admin).toContain(`('admin', '${e}')`);
    expect(literalesDeRol(SQL).filter((r) => r !== 'admin')).toEqual([]);
    expect(MIGRACIONES_CON_REPARTO).toContain(MIGRACION);
  });

  it('sin auditoría, sin transacción propia, idempotente por construcción', () => {
    const sinComentarios = SQL.replace(/--[^\n]*/g, '');
    expect(sinComentarios).not.toMatch(/permisos_auditoria/);
    expect(sinComentarios).not.toMatch(/\b(BEGIN|COMMIT)\b/);
    expect(sinComentarios).toMatch(/WHERE f\.padre_codigo IS DISTINCT FROM m\.nuevo/); // la 2.ª corrida no mueve nada
    expect(sinComentarios).toMatch(/IS DISTINCT FROM \(EXCLUDED\.modulo/);
  });
});

describe('pérdidas = 0 y ganancias = 0 por rol (pliegue de todas las migraciones)', () => {
  const ANTES = leerRepartoSembrado(MIGRACIONES_CON_REPARTO.filter((m) => m !== MIGRACION));
  const DESPUES = leerRepartoSembrado();
  const acceso = (s: Set<string>) => [...s].filter((c) => !c.startsWith('menu.')).sort();

  it.each([...ANTES.keys()].sort())('%s: ve exactamente lo mismo con el árbol nuevo', (rol) => {
    const antes = acceso(expandir(ANTES.get(rol)!, [], PADRE_ANTES_DE_AREAS));
    const despues = acceso(expandir(DESPUES.get(rol)!));
    expect(despues.filter((c) => !antes.includes(c)), 'gana').toEqual([]);
    expect(antes.filter((c) => !despues.includes(c)), 'pierde').toEqual([]);
  });

  it('expand: ningún rol pierde la marca de un elemento viejo', () => {
    for (const [rol, codigos] of ANTES) {
      for (const e of ELEMENTOS_DEPRECADOS) if (codigos.has(e)) expect(DESPUES.get(rol)!.has(e), `${rol} ${e}`).toBe(true);
    }
  });
});

describe('V3 / R7 descartada — el elemento de cada página del reparto posterior ya tiene a su rol', () => {
  const cat = new Map(catalogoCompleto().map((f) => [f.codigo, f]));

  it('cada rol de `REPARTO_TORRE` tiene `menu.gerencial` (la Torre ya no cuelga de General)', () => {
    for (const [rol, codigos] of REPARTO_TORRE) {
      for (const c of codigos.filter((x) => x.startsWith('pagina.'))) {
        const elemento = PADRE.get(c)!;
        expect(elemento).toBe('menu.gerencial');
        expect(cat.get(elemento)!.roles, `${rol} ${c}`).toContain(rol);
      }
    }
  });

  it('un elemento conserva los roles de las páginas que se le fueron (deprecados y Administración)', () => {
    for (const { pagina: p, viejo } of MENU_POR_AREAS) {
      for (const rol of cat.get(p)!.roles) expect(cat.get(viejo)!.roles, `${viejo} ← ${p} (${rol})`).toContain(rol);
    }
  });
});

/** Épica #14678 PR 4: las cinco áreas sin pantallas (`ELEMENTOS_AREAS_VACIAS_14678`), en el orden de `SECTION_ORDER`. */
const AREAS_VACIAS: ReadonlyArray<readonly [string, string, number]> = [
  ['menu.comercial', 'Comercial', 3], ['menu.diseno', 'Diseño', 4], ['menu.tecnologia', 'Tecnología', 5],
  ['menu.infraestructura', 'Infraestructura', 6], ['menu.producto', 'Producto', 7],
];

describe('la migración 0316 (Épica #14678 PR 4: áreas sin pantallas)', () => {
  const sinComentarios = SQL_0316.replace(/--[^\n]*/g, '');

  it('siembra los cinco elementos, nivel 1, orden 3-7, con el `modulo` y el texto del catálogo', () => {
    expect(ELEMENTOS_AREAS_VACIAS_14678).toEqual(AREAS_VACIAS.map(([c]) => c));
    const cat = new Map(catalogoCompleto().map((f) => [f.codigo, f]));
    for (const [codigo, nombre, orden] of AREAS_VACIAS) {
      const modulo = codigo.slice(5);
      expect(sinComentarios).toContain(
        `('${codigo}', '${modulo}', '${nombre}', 'Ver la sección «${nombre}» del menú.', 'elemento', '1', '${orden}')`,
      );
      expect(cat.get(codigo), codigo).toMatchObject({ tipo: 'elemento', modulo, nombreNegocio: nombre });
    }
  });

  it('re-numera Gerencial a 8 y Kyverum a 9 en un UPDATE aparte con `IS DISTINCT FROM` (idempotente)', () => {
    expect(sinComentarios).toMatch(/UPDATE permisos_funciones AS f SET orden = v\.orden\s+FROM \(VALUES \('menu\.gerencial', 8\), \('menu\.kyverum', 9\)\)/);
    expect(sinComentarios).toMatch(/f\.orden IS DISTINCT FROM v\.orden/);
    expect(sinComentarios).toMatch(/IS DISTINCT FROM \(EXCLUDED\.modulo/);
    for (const c of ['menu.gerencial', 'menu.kyverum']) expect(ELEMENTOS_PERMISOS.find((e) => e.codigo === c)?.orden, c).toBe(c === 'menu.gerencial' ? 8 : 9);
  });

  it('sin marca para ningún rol (admin incluido) ni usuario, sin auditoría, sin transacción propia', () => {
    expect(sinComentarios).not.toMatch(/permisos_rol_funcion|permisos_usuario_funcion|permisos_auditoria/);
    expect(literalesDeRol(SQL_0316)).toEqual([]);
    expect(bloquesInsertSiRolExiste(SQL_0316)).toEqual([]);
    expect(sinComentarios).not.toMatch(/\b(BEGIN|COMMIT)\b/);
    expect(MIGRACIONES_CON_REPARTO).toContain(MIGRACION_0316);
  });
});

describe('áreas vacías (Épica #14678 PR 4)', () => {
  it('ningún nodo del árbol cuelga de una de las cinco: no tienen pantallas', () => {
    for (const c of ELEMENTOS_AREAS_VACIAS_14678) {
      expect(PADRE.has(c), c).toBe(true); // existen en el árbol (si no, el resolutor no las vería)
      expect(PADRE.get(c), c).toBeNull();
      expect(hijosDe(c), c).toEqual([]);
    }
  });

  it('un rol con solo `menu.comercial` lo tiene efectivo y no gana ninguna página ni operación', () => {
    expect([...expandir(['menu.comercial'])]).toEqual(['menu.comercial']);
    const todas = expandir([...ELEMENTOS_AREAS_VACIAS_14678]);
    expect([...todas].sort()).toEqual([...ELEMENTOS_AREAS_VACIAS_14678].sort());
    // Revocar gana: con `revocar` del elemento en el usuario, no queda nada.
    expect([...expandir(['menu.comercial'], ['menu.comercial'])]).toEqual([]);
  });

  it('pérdidas = 0 y ganancias = 0: el catálogo no les da roles y ninguna migración se las marca a un rol', () => {
    const cat = new Map(catalogoCompleto().map((f) => [f.codigo, f]));
    for (const c of ELEMENTOS_AREAS_VACIAS_14678) expect(cat.get(c)?.roles, c).toEqual([]);
    for (const [rol, codigos] of leerRepartoSembrado()) {
      for (const c of ELEMENTOS_AREAS_VACIAS_14678) expect(codigos.has(c), `${rol} ${c}`).toBe(false);
    }
  });

  it('el árbol de antes (generadores históricos) no las tiene', () => {
    for (const c of ELEMENTOS_AREAS_VACIAS_14678) expect(PADRE_ANTES_DE_AREAS.has(c), c).toBe(false);
    const antes = catalogoAntesDeAreas(catalogoCompleto());
    expect(antes.some((f) => ELEMENTOS_AREAS_VACIAS_14678.includes(f.codigo))).toBe(false);
  });
});
