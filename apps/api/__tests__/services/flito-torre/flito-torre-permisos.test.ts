// Torre de Control Gerencial (Épica #14590) — contrato de permisos y semilla de la 0303, sin base: el SQL se lee del
// archivo y se pliega con el mismo helper que los tests de las migraciones de permisos.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANS_OPERATIVO, FUNCION_TORRE_DINERO, METRICAS_TORRE, ROLE_DEFAULT_PAGES, UMBRALES_TORRE, USER_ROLES } from '@operaciones/shared-types';
import { sqlRepartoTorre, sqlSiembraTorre } from '../../../src/modules/permisos/arbol/sql-torre.js';
import { catalogoCompleto } from '../../../src/modules/permisos/catalogo.js';
import { fijarFuenteDePermisos, invalidarPermisosDe, resolverPermisos } from '../../../src/shared/permisos-efectivos.js';
import { leerRepartoSembrado } from '../../helpers/permisos-seed-sql.js';

const SQL = readFileSync(join(__dirname, '../../../src/db/migrations/0303_flito_torre_fundacion.sql'), 'utf8');
const SQL_DETALLE = readFileSync(join(__dirname, '../../../src/db/migrations/0306_flito_torre_detalle_permisos.sql'), 'utf8');
const SQL_PRODUCTOS = readFileSync(join(__dirname, '../../../src/db/migrations/0307_flito_torre_productos.sql'), 'utf8');
const SQL_LOGISTICA = readFileSync(join(__dirname, '../../../src/db/migrations/0308_flito_torre_logistica.sql'), 'utf8');
const reparto = leerRepartoSembrado();
const de = (rol: string) => [...(reparto.get(rol) ?? new Set<string>())];
const deTorre = (rol: string) => de(rol).filter((f) => f.includes('torre')).sort();

describe('semilla de umbrales', () => {
  // La 0303 siembra los nueve primeros; la 0307 (B3), `dias_soat_por_vencer`; la 0308 (B4), `dias_traslado_abierto`.
  const filas = [...`${SQL}\n${SQL_PRODUCTOS}\n${SQL_LOGISTICA}`.matchAll(/^\s+\('([a-z_]+)', ([\d.]+), '([a-z]+)', '([^']+)'\)/gm)]
    .map(([, clave, valor, unidad, descripcion]) => ({ clave, valor: Number(valor), unidad, descripcion }));

  it('siembra exactamente el catálogo `UMBRALES_TORRE` (clave, valor, unidad y descripción)', () => {
    expect(filas).toEqual(UMBRALES_TORRE.map((u) => ({ clave: u.clave, valor: u.valorPorDefecto, unidad: u.unidad, descripcion: u.descripcion })));
  });

  it('los operativos coinciden con `ANS_OPERATIVO`', () => {
    const v = Object.fromEntries(filas.map((f) => [f.clave, f.valor]));
    expect(v.horas_sin_gestion).toBe(ANS_OPERATIVO.SIN_GESTION_HORAS);
    expect(v.dias_borrador_abandonado).toBe(ANS_OPERATIVO.BORRADOR_DIAS);
    expect(v.horas_soat_impuesto_sin_soporte).toBe(ANS_OPERATIVO.SIN_GESTION_HORAS);
    expect(v.dias_respuesta_ot).toBe(ANS_OPERATIVO.SIN_APROBAR_DIAS);
    expect(v.meta_mensual_aprobados).toBe(0);
  });

  it('la semilla no pisa un valor ajustado (ON CONFLICT DO NOTHING)', () => {
    expect(SQL).toMatch(/\('meta_mensual_aprobados'[^\n]*\n\s*ON CONFLICT \(clave\) DO NOTHING;/);
    expect(SQL_PRODUCTOS).toMatch(/\('dias_soat_por_vencer'[^\n]*\n\s*ON CONFLICT \(clave\) DO NOTHING;/);
    expect(SQL_LOGISTICA).toMatch(/\('dias_traslado_abierto'[^\n]*\n\s*ON CONFLICT \(clave\) DO NOTHING;/);
  });
});

describe('árbol generado de la 0303', () => {
  it('lo pegado entre las marcas es exactamente la salida del generador', () => {
    const bloque = SQL.slice(SQL.indexOf('-- ÁRBOL GENERADO (inicio)\n') + '-- ÁRBOL GENERADO (inicio)\n'.length, SQL.indexOf('-- ÁRBOL GENERADO (fin)'));
    expect(bloque.trim()).toBe(`${sqlSiembraTorre()}\n\n${sqlRepartoTorre()}`.trim());
  });

  it('los dos roles de gerencia existen en USER_ROLES y la 0303 los crea sin enlace', () => {
    expect(USER_ROLES).toContain('gerencia_comercial');
    expect(USER_ROLES).toContain('gerencia_general');
    expect(SQL).toMatch(/\('gerencia_comercial', 'Gerencia Comercial', '[^']+', 'ninguno', 'interno', false\)/);
    expect(SQL).toMatch(/\('gerencia_general', 'Gerencia General', '[^']+', 'ninguno', 'interno', false\)/);
  });
});

describe('detalle universal (ADR-0047, B1): su migración', () => {
  const bloque = (sql: string) => sql.slice(sql.indexOf('-- ÁRBOL GENERADO (inicio)\n') + '-- ÁRBOL GENERADO (inicio)\n'.length, sql.indexOf('-- ÁRBOL GENERADO (fin)'));

  it('lo pegado entre las marcas es exactamente la salida del generador (tramo «detalle»)', () => {
    expect(bloque(SQL_DETALLE).trim()).toBe(`${sqlSiembraTorre(catalogoCompleto(), 'detalle')}\n\n${sqlRepartoTorre('detalle')}`.trim());
  });

  it('la 0303 (ya aplicada) no recibe el detalle: su bloque no lo menciona', () => {
    expect(bloque(SQL)).not.toContain('torre_detalle');
  });

  it('es idempotente: ON CONFLICT en las dos tablas', () => {
    expect(SQL_DETALLE).toMatch(/INSERT INTO permisos_funciones[\s\S]+ON CONFLICT \(codigo\) DO UPDATE/);
    expect(SQL_DETALLE).toMatch(/INSERT INTO permisos_rol_funcion[\s\S]+ON CONFLICT \(rol_codigo, funcion_codigo\) DO NOTHING;/);
  });

  it('reparto: financiera y las dos gerencias ven y exportan; el auditor solo ve; admin todo', () => {
    const con = (fn: string) => [...reparto].filter(([, fns]) => fns.has(fn)).map(([r]) => r).sort();
    expect(con('accion.torre_detalle.ver')).toEqual(['admin', 'auditor', 'financiera', 'gerencia_comercial', 'gerencia_general']);
    expect(con('accion.torre_detalle.exportar')).toEqual(['admin', 'financiera', 'gerencia_comercial', 'gerencia_general']);
    expect(con('pagina.torre_detalle')).toEqual(['admin', 'auditor', 'financiera', 'gerencia_comercial', 'gerencia_general']);
  });

  it('el catálogo del código coincide con lo sembrado para exportar el detalle', () => {
    const f = catalogoCompleto().find((x) => x.codigo === 'accion.torre_detalle.exportar')!;
    expect(f.roles).toEqual(['admin', 'financiera', 'gerencia_comercial', 'gerencia_general']);
  });
});

describe('Productos (B3): su migración', () => {
  const bloque = (sql: string) => sql.slice(sql.indexOf('-- ÁRBOL GENERADO (inicio)\n') + '-- ÁRBOL GENERADO (inicio)\n'.length, sql.indexOf('-- ÁRBOL GENERADO (fin)'));

  it('lo pegado entre las marcas es exactamente la salida del generador (tramo «productos»)', () => {
    expect(bloque(SQL_PRODUCTOS).trim()).toBe(`${sqlSiembraTorre(catalogoCompleto(), 'productos')}\n\n${sqlRepartoTorre('productos')}`.trim());
  });

  it('el tramo nuevo no cambia los anteriores: ni la 0303 ni la 0306 mencionan Productos', () => {
    expect(bloque(SQL)).not.toContain('torre_productos');
    expect(bloque(SQL_DETALLE)).not.toContain('torre_productos');
    expect(sqlRepartoTorre('detalle')).not.toContain('torre_productos');
    expect(sqlRepartoTorre()).not.toContain('torre_productos');
  });

  it('es idempotente: ON CONFLICT en las tres tablas', () => {
    expect(SQL_PRODUCTOS).toMatch(/INSERT INTO flito_torre_umbrales[\s\S]+ON CONFLICT \(clave\) DO NOTHING;/);
    expect(SQL_PRODUCTOS).toMatch(/INSERT INTO permisos_funciones[\s\S]+ON CONFLICT \(codigo\) DO UPDATE/);
    expect(SQL_PRODUCTOS).toMatch(/INSERT INTO permisos_rol_funcion[\s\S]+ON CONFLICT \(rol_codigo, funcion_codigo\) DO NOTHING;/);
  });

  it('reparto: los que ven Operativa (auditor y gerencia_general) y admin; ni financiera ni gerencia_comercial', () => {
    const con = (fn: string) => [...reparto].filter(([, fns]) => fns.has(fn)).map(([r]) => r).sort();
    expect(con('accion.torre_productos.ver')).toEqual(con('accion.torre_operativa.ver'));
    expect(con('accion.torre_productos.ver')).toEqual(['admin', 'auditor', 'gerencia_general']);
    expect(con('pagina.torre_productos')).toEqual(['admin', 'auditor', 'gerencia_general']);
    const f = catalogoCompleto().find((x) => x.codigo === 'accion.torre_productos.ver')!;
    expect(f.roles).toEqual(['admin', 'auditor', 'gerencia_general']);
  });

  it('la página por defecto la reciben los mismos roles que `torre_operativa` (sin `operaciones`)', () => {
    const roles = (slug: string) => USER_ROLES.filter((r) => (ROLE_DEFAULT_PAGES[r] ?? []).includes(slug as never)).sort();
    expect(roles('torre_productos')).toEqual(roles('torre_operativa'));
    expect(USER_ROLES as readonly string[]).not.toContain('operaciones');
  });
});

describe('Logística (B4): su migración', () => {
  const bloque = (sql: string) => sql.slice(sql.indexOf('-- ÁRBOL GENERADO (inicio)\n') + '-- ÁRBOL GENERADO (inicio)\n'.length, sql.indexOf('-- ÁRBOL GENERADO (fin)'));

  it('lo pegado entre las marcas es exactamente la salida del generador (tramo «logistica»)', () => {
    expect(bloque(SQL_LOGISTICA).trim()).toBe(`${sqlSiembraTorre(catalogoCompleto(), 'logistica')}\n\n${sqlRepartoTorre('logistica')}`.trim());
  });

  it('el tramo nuevo no cambia los anteriores: ni la 0303, ni la 0306, ni la 0307 mencionan Logística', () => {
    for (const s of [SQL, SQL_DETALLE, SQL_PRODUCTOS]) expect(bloque(s)).not.toContain('torre_logistica');
    for (const t of ['fundacion', 'detalle', 'productos'] as const) expect(sqlRepartoTorre(t)).not.toContain('torre_logistica');
    expect(bloque(SQL_PRODUCTOS).trim()).toBe(`${sqlSiembraTorre(catalogoCompleto(), 'productos')}\n\n${sqlRepartoTorre('productos')}`.trim());
  });

  it('es idempotente: ON CONFLICT en las tres tablas', () => {
    expect(SQL_LOGISTICA).toMatch(/INSERT INTO flito_torre_umbrales[\s\S]+ON CONFLICT \(clave\) DO NOTHING;/);
    expect(SQL_LOGISTICA).toMatch(/INSERT INTO permisos_funciones[\s\S]+ON CONFLICT \(codigo\) DO UPDATE/);
    expect(SQL_LOGISTICA).toMatch(/INSERT INTO permisos_rol_funcion[\s\S]+ON CONFLICT \(rol_codigo, funcion_codigo\) DO NOTHING;/);
  });

  it('reparto: el de Productos (admin, auditor y gerencia_general); ni financiera ni gerencia_comercial', () => {
    const con = (fn: string) => [...reparto].filter(([, fns]) => fns.has(fn)).map(([r]) => r).sort();
    expect(con('accion.torre_logistica.ver')).toEqual(con('accion.torre_productos.ver'));
    expect(con('accion.torre_logistica.ver')).toEqual(['admin', 'auditor', 'gerencia_general']);
    expect(con('pagina.torre_logistica')).toEqual(['admin', 'auditor', 'gerencia_general']);
    const f = catalogoCompleto().find((x) => x.codigo === 'accion.torre_logistica.ver')!;
    expect(f.roles).toEqual(['admin', 'auditor', 'gerencia_general']);
  });

  it('la página por defecto la reciben los mismos roles que `torre_operativa` (sin `operaciones`)', () => {
    const roles = (slug: string) => USER_ROLES.filter((r) => (ROLE_DEFAULT_PAGES[r] ?? []).includes(slug as never)).sort();
    expect(roles('torre_logistica')).toEqual(roles('torre_operativa'));
  });
});

describe('reparto de la Torre (plegadas las migraciones)', () => {
  it('NADIE salvo admin tiene «Editar los umbrales»', () => {
    const con = [...reparto].filter(([, fns]) => fns.has('accion.torre_umbrales.editar')).map(([r]) => r);
    expect(con).toEqual(['admin']);
  });

  it('gerencia_comercial: su tablero y el Explorador completo (con dinero), nada de umbrales', () => {
    expect(deTorre('gerencia_comercial')).toEqual([
      'accion.torre_comercial.ver', 'accion.torre_detalle.exportar', 'accion.torre_detalle.ver', 'accion.torre_explorador.buscar_placa',
      'accion.torre_explorador.consultar', 'accion.torre_explorador.exportar', 'accion.torre_explorador.ver_dinero',
      'pagina.torre_comercial', 'pagina.torre_detalle', 'pagina.torre_explorador',
    ]);
  });

  it('gerencia_general: los cuatro tableros, el Explorador completo, ver (no editar) los umbrales y, B5, el equipo', () => {
    expect(deTorre('gerencia_general')).toEqual([
      'accion.torre_360.ver', 'accion.torre_comercial.ver', 'accion.torre_detalle.exportar', 'accion.torre_detalle.ver',
      'accion.torre_explorador.buscar_placa', 'accion.torre_explorador.consultar',
      'accion.torre_explorador.exportar', 'accion.torre_explorador.ver_dinero', 'accion.torre_financiera.ver', 'accion.torre_logistica.ver',
      'accion.torre_operativa.ver', 'accion.torre_operativa.ver_equipo', 'accion.torre_productos.ver', 'accion.torre_umbrales.ver', 'pagina.torre_360', 'pagina.torre_comercial',
      'pagina.torre_detalle', 'pagina.torre_explorador', 'pagina.torre_financiera', 'pagina.torre_logistica', 'pagina.torre_operativa',
      'pagina.torre_productos', 'pagina.torre_umbrales',
    ]);
  });

  it('las gerencias no reciben nada fuera de la Torre salvo lo universal de todo rol nuevo (Perfil, manuales de Dr. Flit)', () => {
    for (const rol of ['gerencia_comercial', 'gerencia_general']) {
      const fuera = de(rol).filter((f) => !f.includes('torre')).sort();
      expect(fuera.filter((f) => !['menu.general', 'menu.administracion', 'menu.perfil'].includes(f))).toEqual([
        'accion.dr_flit.ver_manuales', 'accion.perfil.cambiar_contrasena', 'accion.perfil.ver_datos', 'pagina.flito_dr_flit', 'pagina.perfil',
      ]);
    }
  });

  it('auditor lee la Torre pero NO exporta ni edita umbrales', () => {
    const suyas = deTorre('auditor');
    expect(suyas).toContain('accion.torre_explorador.consultar');
    expect(suyas).toContain('accion.torre_umbrales.ver');
    expect(suyas).not.toContain('accion.torre_explorador.exportar');
    expect(suyas).not.toContain('accion.torre_umbrales.editar');
    expect(suyas).toContain('accion.torre_detalle.ver');
    expect(suyas).not.toContain('accion.torre_detalle.exportar');
  });

  it('«Ver las métricas de dinero» la tienen admin, financiera, auditor y las dos gerencias', () => {
    const con = [...reparto].filter(([, fns]) => fns.has('accion.torre_explorador.ver_dinero')).map(([r]) => r).sort();
    expect(con).toEqual(['admin', 'auditor', 'financiera', 'gerencia_comercial', 'gerencia_general']);
  });

  it('el catálogo del código coincide con lo sembrado para la acción de dinero', () => {
    const f = catalogoCompleto().find((x) => x.codigo === 'accion.torre_explorador.ver_dinero')!;
    expect(f.roles).toEqual(['admin', 'auditor', 'financiera', 'gerencia_comercial', 'gerencia_general']);
  });

  it('el motor concede `torre.metricas.dinero` a gerencia_comercial y se lo niega a quien no tiene la acción', async () => {
    const roles = ['gerencia_comercial', 'mensajero'];
    fijarFuenteDePermisos(async (id) => {
      const rol = roles[id - 5000];
      return rol ? { rol, tipoEnlace: 'ninguno', proveedor: null, funcionesDelRol: de(rol), excepciones: [] } : null;
    });
    roles.forEach((_, i) => invalidarPermisosDe(5000 + i));
    const gc = await resolverPermisos(5000);
    const me = await resolverPermisos(5001);
    expect(gc.ok && gc.funciones.has(FUNCION_TORRE_DINERO)).toBe(true);
    expect(me.ok && me.funciones.has(FUNCION_TORRE_DINERO)).toBe(false);
  });
});

describe('catálogo de métricas', () => {
  it('marca `requiereDinero` exactamente en las seis métricas de dinero (B3: + `soat_pagados_valor`)', () => {
    expect(METRICAS_TORRE.filter((m) => m.requiereDinero).map((m) => m.id).sort()).toEqual(
      ['costo_logistica', 'derechos_pagados', 'impuestos_pagados', 'ingreso_liquidado', 'sin_facturar', 'soat_pagados_valor'],
    );
  });
});
