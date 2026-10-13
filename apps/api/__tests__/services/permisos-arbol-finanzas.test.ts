// HU #13427 (Feature #13416 F3, ADR-0025; diseño §5-bis) — Catálogo de Finanzas en tres niveles y paso de
// los permisos existentes. Sin base: el catálogo del código, el reparto en memoria (lo mismo que la 0235)
// y la partida real = las migraciones 0001..0231 plegadas.
//
// Mutantes nombrados (para QA B):
//   · quitar `lectura: true` de «Ver la parametrización» → cae AC5 (auditor deja de recibirla) y la lista de lectura.
//   · sacar `bolsas.soporte.descargar` de `opcionales` y meterlo en el grupo → cae «ninguna acción de lectura
//     expande a exportar/descargar» y la tabla de pérdidas (financiera sin… nada; el detector lo ve).
//   · quitar `predecesores` de una acción de Integración con Siigo → cae AC5 (admin la recibe solo por 2b) y AC6
//     («el predecesor es el código viejo»).
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/db/client.js', () => ({ db: {}, getPoolStats: vi.fn() }));

const { ARBOL_FINANZAS, ARBOL_ADMINISTRACION } = await import('@operaciones/shared-types');
const { catalogoCompleto, catalogoPlano, catalogoOperacionesNuevas } = await import('../../src/modules/permisos/catalogo.js');
const { OPERACIONES_DECLARADAS } = await import('../../src/modules/permisos/catalogo-operaciones.js');
const { montajesDeFunciones } = await import('../../src/modules/permisos/inventario-guardas.js');
const { ACCIONES_FINANZAS, AREA_FINANZAS, FUERA_DE_AREA_FINANZAS, PARTIDA_DE_OPERACION_NUEVA } = await import('../../src/modules/permisos/arbol/acciones-finanzas.js');
const {
  ACCIONES_LECTURA, ACCIONES_POR_AREA, CODIGOS_ABSORBIDOS, ROL_CON_TODAS_LAS_ACCIONES, expandir, operacionesDe, predecesoresDe,
} = await import('../../src/modules/permisos/arbol/expansion.js');
const { absorbidosVivos, efectivasExpandidas, informeArbol, repartirPorTodos } = await import('../../src/modules/permisos/arbol/reparto-arbol.js');
const { leerRepartoSembrado, MIGRACIONES_ANTES_DEL_ARBOL } = await import('../helpers/permisos-seed-sql.js');

const FINANZAS = ACCIONES_POR_AREA.finanzas;

/**
 * AC1 — El anexo del §5-bis, LITERAL (catálogo aprobado por el PO el 2026-10-07, con «Ver la parametrización»
 * de P-15 y el renombre del freno de P-18): elemento → ítem → acciones, en orden.
 */
const ANEXO = `
Finanzas → Reporte de costos: Ver el listado de trámites · Exportar a Excel · Ver soportes · Ver viajes adicionales · Asignar servicios adicionales · Liquidar (incluye en lote) · Facturar · Enviar a Siigo · Reversar una liquidación
Finanzas → Gastos diarios: Ver los gastos diarios
Finanzas → Bolsas: Ver bolsas de clientes · Ver bolsas de tránsito · Crear bolsas · Editar bolsas · Registrar recargas y cargar saldo · Registrar y corregir movimientos manuales · Cerrar periodo y descargar extracto · Ver alertas y riesgo de saldo
Finanzas → Tarifas: Ver las tarifas (incluye historial) · Crear y modificar tarifas
Finanzas → Servicios adicionales: Ver · Crear · Editar · Dar de baja
Finanzas → Comprobantes: Cargar comprobantes · Asociar manualmente · Ver la cola de comprobantes · Descartar, releer o aceptar una diferencia
Finanzas → Conciliación: Ver las boletas cargadas · Cargar boleta · Conciliar, descartar o volver a cruzar · Cargar o reemplazar el comprobante de la boleta
Finanzas → Facturación electrónica · Parametrización: Ver la parametrización · Mapeo de conceptos · Configuración de terceros
Finanzas → Facturación electrónica · Operación: Ver las facturas emitidas · Reintentar, reenviar el correo, marcar como fallida y reactivar · Quitar el freno de emisión
Administración → Integración con Siigo: Registrar credenciales de pruebas · Registrar credenciales de producción · Probar la conexión
`.trim().split('\n');

const ARBOL = [...ARBOL_FINANZAS, ...ARBOL_ADMINISTRACION];
const ELEMENTO: Record<string, string> = { 'menu.finanzas': 'Finanzas', 'menu.administracion': 'Administración' };

describe('AC1 — nivel 2 y nivel 3 exactamente según el catálogo aprobado (anexo literal)', () => {
  it('elemento → ítem → acciones, en orden y con el nombre literal', () => {
    const items = ARBOL.filter((n) => n.tipo === 'item');
    const lineas = items.map((it) => {
      const acciones = ARBOL.filter((n) => n.tipo === 'accion' && n.padre === it.codigo).sort((x, y) => x.orden - y.orden);
      return `${ELEMENTO[it.padre!]} → ${it.nombre}: ${acciones.map((a) => a.nombre).join(' · ')}`;
    });
    expect(lineas).toEqual(ANEXO);
  });

  it('el catálogo del código emite las 41 acciones (nivel 3) y marca nivel 2 a los 10 ítems; los códigos son los del mapeo', () => {
    const cat = catalogoCompleto();
    const accionesArbol = ARBOL.filter((n) => n.tipo === 'accion').map((n) => n.codigo).sort();
    expect(accionesArbol).toHaveLength(41);
    expect(accionesArbol).toEqual([...FINANZAS]);
    const delCatalogo = cat.filter((f) => f.tipo === 'accion' && FINANZAS.includes(f.codigo));
    expect(delCatalogo.map((f) => f.codigo).sort()).toEqual(accionesArbol);
    for (const f of delCatalogo) expect(f.nivel, f.codigo).toBe(3);
    const items = ARBOL.filter((n) => n.tipo === 'item').map((n) => n.codigo).sort();
    expect(cat.filter((f) => f.nivel === 2 && items.includes(f.codigo)).map((f) => f.codigo).sort()).toEqual(items);
    expect(items).toEqual([
      'pagina.finanzas_gastos_diarios', 'pagina.finanzas_reporte_costos', 'pagina.flito_bolsas', 'pagina.flito_comprobantes',
      'pagina.flito_conciliacion', 'pagina.flito_servicios_adicionales', 'pagina.flito_tarifas', 'pagina.siigo_credenciales',
      'pagina.siigo_operacion', 'pagina.siigo_parametrizacion',
    ]);
  });
});

describe('AC3 — Gastos diarios solo tiene «ver» (P-19)', () => {
  it('una sola acción, de lectura, con la operación nueva; su predecesor es la página, que NO se absorbe', () => {
    expect(FINANZAS.filter((a) => a.startsWith('accion.gastos_diarios.'))).toEqual(['accion.gastos_diarios.ver']);
    expect(operacionesDe('accion.gastos_diarios.ver')).toEqual(['finanzas.gastos_diarios.ver']);
    expect(predecesoresDe('accion.gastos_diarios.ver')).toEqual(['pagina.finanzas_gastos_diarios']);
    expect(ACCIONES_LECTURA.has('accion.gastos_diarios.ver')).toBe(true);
    expect(CODIGOS_ABSORBIDOS.has('pagina.finanzas_gastos_diarios')).toBe(false);
    expect(absorbidosVivos(undefined, FINANZAS).has('pagina.finanzas_gastos_diarios')).toBe(false);
    expect(catalogoCompleto().some((f) => f.codigo === 'pagina.finanzas_gastos_diarios')).toBe(true);
  });
});

describe('AC6 — cobertura: los 68 códigos del área, en los dos sentidos', () => {
  const plano = catalogoPlano();
  const delArea = [...new Set(plano.filter((f) => f.tipo === 'operacion' && AREA_FINANZAS.test(f.codigo)).map((f) => f.codigo))].sort();
  const cubiertas = new Set(FINANZAS.flatMap((a) => [...operacionesDe(a), ...predecesoresDe(a), ...(ACCIONES_FINANZAS[a]!.opcionales ?? [])]));

  it('son 68 en la partida, y cada uno está en ≥1 acción (grupo, predecesor, apoyo u opcional) o declarado fuera de área', () => {
    expect(delArea).toHaveLength(68);
    expect(delArea.filter((c) => !cubiertas.has(c) && !(c in FUERA_DE_AREA_FINANZAS))).toEqual([]);
    expect(Object.keys(FUERA_DE_AREA_FINANZAS)).toEqual(['liquidacion.pago_manual.administrar']);
    expect(CODIGOS_ABSORBIDOS.has('liquidacion.pago_manual.administrar')).toBe(false);
  });

  it('toda acción concede ≥1 operación con guarda viva hoy; ningún predecesor es inventado', () => {
    const conGuarda = new Set(OPERACIONES_DECLARADAS.map((o) => o.codigo));
    for (const a of FINANZAS) {
      expect(operacionesDe(a).filter((op) => conGuarda.has(op)).length, a).toBeGreaterThan(0);
      for (const p of predecesoresDe(a)) expect(plano.some((f) => f.codigo === p), `${a} ← ${p}`).toBe(true);
    }
  });

  it('las operaciones nuevas son EXACTAMENTE las que exige hoy alguna guarda y no existían; su partida es el código viejo', () => {
    expect(catalogoOperacionesNuevas().map((f) => f.codigo).sort()).toEqual(Object.keys(PARTIDA_DE_OPERACION_NUEVA).sort());
    for (const [nueva, partida] of Object.entries(PARTIDA_DE_OPERACION_NUEVA)) {
      expect(plano.some((f) => f.codigo === nueva), nueva).toBe(false);
      // La acción que la concede tiene la partida como predecesor (salvo la de apoyo, que la dan las tres de Integración).
      const dueñas = FINANZAS.filter((a) => operacionesDe(a).includes(nueva));
      expect(dueñas.length, nueva).toBeGreaterThan(0);
      for (const a of dueñas) expect(predecesoresDe(a), `${a} concede ${nueva}`).toContain(partida);
    }
  });
});

describe('AC8 — ninguna guarda referencia los códigos viejos que se retiran', () => {
  const montados = montajesDeFunciones().map((m) => m.codigo);
  it('nadie monta el transitorio `siigo.parametrizacion.administrar` (ni ruta ni en línea), y el catálogo de hoy no lo tiene', () => {
    expect(montados).not.toContain('siigo.parametrizacion.administrar');
    expect(catalogoCompleto().some((f) => f.codigo === 'siigo.parametrizacion.administrar')).toBe(false);
    expect(OPERACIONES_DECLARADAS.some((o) => o.codigo === 'siigo.parametrizacion.administrar')).toBe(false);
  });

  it('las rutas partidas de `finanzas.reporte_costos.ver` piden la operación nueva (exportes, soportes, viajes)', () => {
    const codigoDe = (llave: string) => OPERACIONES_DECLARADAS.find((o) => o.llave === llave)?.codigo;
    expect(codigoDe('finanzas/finanzas.routes.ts POST /reporte-costos/export')).toBe('finanzas.reporte_costos.exportar');
    expect(codigoDe('finanzas/finanzas.routes.ts POST /reporte-costos/consolidado/export')).toBe('finanzas.reporte_costos.exportar');
    expect(codigoDe('finanzas/finanzas.routes.ts GET /tramites/:id/soportes')).toBe('finanzas.reporte_costos.ver_soportes');
    expect(codigoDe('finanzas/finanzas.routes.ts GET /tramites/:id/viajes-logistica')).toBe('finanzas.reporte_costos.ver_viajes');
    expect(codigoDe('finanzas/finanzas.routes.ts GET /gastos-diarios')).toBe('finanzas.gastos_diarios.ver');
    expect(codigoDe('finanzas/finanzas.routes.ts GET /reporte-costos')).toBe('finanzas.reporte_costos.ver');
  });
});

describe('Regla vigente (PO, 2026-10-13): en las de lectura, exportar/descargar y lo que escribe es OPCIONAL', () => {
  it('las acciones de lectura de Finanzas son EXACTAMENTE estas (flag explícito)', () => {
    expect(FINANZAS.filter((a) => ACCIONES_LECTURA.has(a))).toEqual([
      'accion.bolsas.ver_alertas', 'accion.bolsas.ver_clientes', 'accion.bolsas.ver_transito',
      'accion.comprobantes.ver_cola', 'accion.conciliacion.ver_boletas',
      'accion.facturacion_operacion.ver_facturas', 'accion.facturacion_parametrizacion.ver',
      'accion.gastos_diarios.ver', 'accion.reporte_costos.ver_listado', 'accion.reporte_costos.ver_soportes',
      'accion.reporte_costos.ver_viajes_adicionales', 'accion.servicios_adicionales.ver', 'accion.tarifas.ver',
    ]);
    // «Exportar a Excel» y «Cerrar periodo y descargar extracto» modifican: regla «todos».
    expect(ACCIONES_LECTURA.has('accion.reporte_costos.exportar')).toBe(false);
    expect(ACCIONES_LECTURA.has('accion.bolsas.cerrar_periodo')).toBe(false);
  });

  it('ninguna acción de lectura de Finanzas expande a exportar/descargar ni a nada que escriba (código y guarda real)', () => {
    const llavesDe = (op: string) => OPERACIONES_DECLARADAS.filter((o) => o.codigo === op).map((o) => o.llave);
    // Como el de #12873 (que añadió la factura de venta: un PDF), pero la «factura» de Finanzas NO es un documento:
    // `siigo.factura.consultar` (bandeja, línea de tiempo) y `GET /reporte-costos/facturacion-electronica` devuelven
    // JSON (ningún `siigo/*.routes.ts` ni `finanzas.routes.ts` sirve PDF, XML ni `Content-Disposition`). Por eso aquí se
    // reconoce el DOCUMENTO por la ruta (`factura-venta`, `/pdf`, `/xml`), no la palabra en el código.
    const descarga = (op: string, llave: string) => /\.(exportar|descargar)\w*$/.test(op) || / \S*(export|descarg|zip|\/pdf|\/xml|\/archivo|factura-venta)\S*( \[[^\]]+\])?$/i.test(llave);
    const escribe = (llave: string) => !(/ GET /.test(llave) || / POST \S*\/buscar( \[[^\]]+\])?$/.test(llave));
    const malas = FINANZAS.filter((a) => ACCIONES_LECTURA.has(a)).flatMap((a) => operacionesDe(a).flatMap((op) => {
      const llaves = llavesDe(op);
      if (llaves.length === 0) return [`${a}: ${op} sin guarda declarada`];
      return llaves.filter((l) => descarga(op, l) || escribe(l)).map((l) => `${a}: ${op} (${l})`);
    }));
    expect(malas).toEqual([]);
    expect(descarga('impuestos.factura.ver', 'flito-impuestos/flito-impuestos.routes.ts GET /:id/factura-venta')).toBe(true);
    // Control: las tres descargas que la regla pasó a opcionales SÍ las ve el detector.
    for (const op of ['bolsas.soporte.descargar', 'comprobantes.archivo.descargar', 'conciliacion.comprobante.descargar']) {
      expect(llavesDe(op).some((l) => descarga(op, l)), op).toBe(true);
    }
  });

  it('opcionales del área: los de P-16/P-17 y las tres descargas; ni absorbidos ni expandidos, y siguen en el catálogo', () => {
    const opcionales = FINANZAS.flatMap((a) => ACCIONES_FINANZAS[a]!.opcionales ?? []).sort();
    expect(opcionales).toEqual([
      'bolsas.soporte.descargar', 'comprobantes.archivo.descargar', 'conciliacion.comprobante.descargar',
      'siigo.conceptos.confirmar', 'siigo.factura.anular', 'siigo.factura.corregir',
    ]);
    const hoy = new Set(catalogoCompleto().map((f) => f.codigo));
    for (const c of opcionales) {
      expect(CODIGOS_ABSORBIDOS.has(c), c).toBe(false);
      expect(FINANZAS.some((a) => operacionesDe(a).includes(c)), c).toBe(false);
      expect(hoy.has(c), c).toBe(true);
    }
  });
});

describe('AC4/AC5/AC7 — el paso sobre la partida real (0001..0231 plegadas): roles, excepciones y admin', () => {
  const partida = leerRepartoSembrado(MIGRACIONES_ANTES_DEL_ARBOL);
  const filasRol = [...partida].flatMap(([rol, cs]) => [...cs].map((codigo) => ({ rol, codigo })));
  const usuarios = [...partida.keys()].map((rol, i) => ({ id: i + 1, rol }));
  const despues = repartirPorTodos(usuarios, { filasRol, filasUsuario: [] }, undefined, FINANZAS);
  const accionesDe = (rol: string) => despues.filasRol.filter((f) => f.rol === rol && FINANZAS.includes(f.codigo)).map((f) => f.codigo.slice('accion.'.length)).sort();

  it('AC7: admin recibe TODAS las acciones del área', () => {
    expect(ROL_CON_TODAS_LAS_ACCIONES).toBe('admin');
    expect(accionesDe('admin')).toEqual(FINANZAS.map((a) => a.slice('accion.'.length)));
  });

  it('AC5: financiera — todo lo que tenía entero (sin Mapeo, Terceros, Freno ni Integración: era transitorio de admin)', () => {
    expect(accionesDe('financiera')).toEqual([
      'bolsas.cerrar_periodo', 'bolsas.crear', 'bolsas.editar', 'bolsas.movimientos_manuales', 'bolsas.registrar_recargas',
      'bolsas.ver_alertas', 'bolsas.ver_clientes', 'bolsas.ver_transito',
      'comprobantes.asociar', 'comprobantes.cargar', 'comprobantes.resolver', 'comprobantes.ver_cola',
      'conciliacion.cargar_boleta', 'conciliacion.comprobante', 'conciliacion.conciliar', 'conciliacion.ver_boletas',
      'facturacion_operacion.gestionar', 'facturacion_operacion.ver_facturas', 'facturacion_parametrizacion.ver',
      'reporte_costos.asignar_servicios_adicionales', 'reporte_costos.enviar_siigo', 'reporte_costos.exportar', 'reporte_costos.facturar',
      'reporte_costos.liquidar', 'reporte_costos.ver_listado', 'reporte_costos.ver_soportes', 'reporte_costos.ver_viajes_adicionales',
      'servicios_adicionales.crear', 'servicios_adicionales.dar_de_baja', 'servicios_adicionales.editar', 'servicios_adicionales.ver',
      'tarifas.crear_modificar', 'tarifas.ver',
    ]);
  });

  it('AC5: auditor — solo lectura (alguna basta) y Exportar (tenía el reporte entero); nada que modifique', () => {
    expect(accionesDe('auditor')).toEqual([
      'facturacion_operacion.ver_facturas', 'facturacion_parametrizacion.ver',
      'reporte_costos.exportar', 'reporte_costos.ver_listado', 'reporte_costos.ver_soportes', 'reporte_costos.ver_viajes_adicionales',
    ]);
  });

  it('AC5: pérdidas y ganancias por rol (reporte en seco sobre la partida): nadie pierde; auditor gana la copia local de catálogos', () => {
    const i = informeArbol(usuarios, { filasRol, filasUsuario: [] }, undefined, FINANZAS);
    const porRol = Object.fromEntries(i.cambios.map((c) => [c.rol, { pierde: c.pierde, gana: c.gana }]));
    expect(i.cambios.flatMap((c) => c.pierde)).toEqual([]);
    expect(porRol).toEqual({ auditor: { pierde: [], gana: ['siigo.emision.ver'] } });
    // Control: lo que tenía `admin` en el transitorio sigue efectivo por las acciones (credenciales, mapeo, freno…).
    const e = efectivasExpandidas(usuarios, despues).get(usuarios.find((u) => u.rol === 'admin')!.id)!;
    for (const op of Object.keys(PARTIDA_DE_OPERACION_NUEVA)) expect(e.has(op), op).toBe(true);
  });

  it('AC5: los opcionales no cuentan, no se expanden y se conservan (financiera conserva confirmar/corregir/anular/descargas)', () => {
    const fin = usuarios.find((u) => u.rol === 'financiera')!;
    const e = efectivasExpandidas(usuarios, despues).get(fin.id)!;
    for (const op of ['siigo.conceptos.confirmar', 'siigo.factura.corregir', 'siigo.factura.anular', 'bolsas.soporte.descargar', 'comprobantes.archivo.descargar', 'conciliacion.comprobante.descargar']) {
      expect(e.has(op), op).toBe(true);
    }
    // Nadie los gana por la acción: un rol con solo «Ver bolsas de clientes» no descarga soportes.
    expect(expandir(['accion.bolsas.ver_clientes']).has('bolsas.soporte.descargar')).toBe(false);
    expect(expandir(['accion.facturacion_parametrizacion.mapeo_conceptos']).has('siigo.conceptos.confirmar')).toBe(false);
  });

  it('AC5: «todos» si modifica — un rol con liquidar sin liquidar_lote NO recibe «Liquidar»; «alguna» si es de lectura', () => {
    const r = repartirPorTodos([], { filasRol: [
      { rol: 'parcial', codigo: 'liquidacion.liquidacion.liquidar' },
      { rol: 'lector', codigo: 'liquidacion.liquidacion.ver_eventos' },
    ], filasUsuario: [] }, undefined, FINANZAS);
    expect(r.filasRol.filter((f) => f.rol === 'parcial').map((f) => f.codigo)).toEqual([]);
    expect(r.filasRol.filter((f) => f.rol === 'lector').map((f) => f.codigo)).toEqual(['accion.reporte_costos.ver_listado']);
  });

  it('AC4: el paso uno a uno llega a las excepciones por usuario (conceder si lo completa, revocar si le falta)', () => {
    const us = [{ id: 1, rol: 'r' }, { id: 2, rol: 'r' }, { id: 3, rol: 'otro' }];
    const r = repartirPorTodos(us, {
      filasRol: [{ rol: 'r', codigo: 'parametrizacion.tarifas.crear' }, { rol: 'r', codigo: 'parametrizacion.tarifas.editar' }],
      filasUsuario: [
        { userId: 2, codigo: 'parametrizacion.tarifas.editar', efecto: 'revocar' },
        { userId: 3, codigo: 'parametrizacion.tarifas.crear', efecto: 'conceder' },
        { userId: 3, codigo: 'parametrizacion.tarifas.editar', efecto: 'conceder' },
      ],
    }, undefined, FINANZAS);
    expect(r.filasUsuario).toEqual([
      { userId: 2, codigo: 'accion.tarifas.crear_modificar', efecto: 'revocar' },
      { userId: 3, codigo: 'accion.tarifas.crear_modificar', efecto: 'conceder' },
    ]);
    const e = efectivasExpandidas(us, r);
    expect(e.get(1)!.has('parametrizacion.tarifas.editar')).toBe(true);
    expect(e.get(2)!.has('parametrizacion.tarifas.crear')).toBe(false);
    expect(e.get(3)!.has('parametrizacion.tarifas.editar')).toBe(true);
  });

  it('AC4: el transitorio por excepción — quien lo tenía concedido recibe las 6 acciones que lo sustituyen', () => {
    const r = repartirPorTodos([{ id: 9, rol: 'x' }], { filasRol: [], filasUsuario: [{ userId: 9, codigo: 'siigo.parametrizacion.administrar', efecto: 'conceder' }] }, undefined, FINANZAS);
    expect(r.filasUsuario.map((f) => `${f.codigo} ${f.efecto}`).sort()).toEqual([
      'accion.facturacion_operacion.freno conceder', 'accion.facturacion_parametrizacion.mapeo_conceptos conceder',
      'accion.facturacion_parametrizacion.terceros conceder', 'accion.integracion_siigo.credenciales_produccion conceder',
      'accion.integracion_siigo.credenciales_pruebas conceder', 'accion.integracion_siigo.probar_conexion conceder',
    ]);
  });

  it('AC9: segunda corrida (los grupos ya no existen): no reparte ni revoca nada, ni toca la página de gastos diarios', () => {
    const existentes = new Set(catalogoCompleto().map((f) => f.codigo));
    const filas = {
      filasRol: [{ rol: 'admin', codigo: 'accion.gastos_diarios.ver' }, { rol: 'admin', codigo: 'pagina.finanzas_gastos_diarios' }],
      filasUsuario: [],
    };
    expect(repartirPorTodos([{ id: 1, rol: 'admin' }], filas, existentes, FINANZAS).filasRol.filter((f) => f.rol === 'admin' && f.codigo.startsWith('accion.')).map((f) => f.codigo).sort())
      .toEqual([...FINANZAS]);
    const sinAdmin = { filasRol: [{ rol: 'r', codigo: 'pagina.finanzas_gastos_diarios' }, { rol: 'r', codigo: 'accion.gastos_diarios.ver' }], filasUsuario: [] };
    expect(repartirPorTodos([{ id: 1, rol: 'r' }], sinAdmin, existentes, FINANZAS)).toEqual(sinAdmin);
  });
});
