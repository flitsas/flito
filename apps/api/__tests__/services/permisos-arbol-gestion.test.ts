// HU #12873 (Feature #13416, ADR-0025) — Catálogo nuevo de Gestión y Tránsito: el árbol, la expansión
// acción → operaciones y la regla «todos los del grupo», sin base.
//
// AC1 catálogo vs lista aprobada · AC2 anidamiento exportar → exportar_pago · AC3 «Entregar» sin ítem
// Compuerta · AC4 regla «todos» con rol parcial · AC5 excepciones por usuario · AC6 doble sentido
// árbol ↔ operaciones reales (`OPERACIONES_DECLARADAS`) · AC7 documentos adicionales 1:1 · AC8 el rol
// con todo queda con todo. AC9 (arranque código ↔ base) y la paridad del SQL: `migracion-0233.test.ts`.
// El muestreo 200/403 por acción: `permisos-arbol-muestreo.test.ts`.
//
// Mutantes nombrados:
//   · quitar `'soat.solicitud.ver_historial'` del grupo de `accion.soat.ver_listado` → cae AC4 (el rol
//     parcial recibiría la acción) y AC6 (a) (la operación queda sin acción).
//   · en `repartirPorTodos`, quitar la rama `revocar` → cae AC5 (el usuario sin historial conserva todo).
//   · en `expandir`, quitar el bucle de conjunciones → cae «pedir_ambos exige las dos».
//   · en `expandir`, no restar `revocados` al final → cae «revocar gana sobre lo expandido».
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/db/client.js', () => ({ db: {}, getPoolStats: vi.fn() }));

const { ARBOL_GESTION, ARBOL_PERMISOS, ITEMS_GESTION, PREFIJO_ACCION, PREFIJO_ELEMENTO } = await import('@operaciones/shared-types');
const { catalogoCompleto, catalogoDeAcciones, catalogoPlano } = await import('../../src/modules/permisos/catalogo.js');
const { OPERACIONES_DECLARADAS } = await import('../../src/modules/permisos/catalogo-operaciones.js');
const { ACCIONES_GESTION, AREA_GESTION, CONJUNCIONES_GESTION, FUERA_DE_AREA_GESTION } = await import('../../src/modules/permisos/arbol/acciones-gestion.js');
const { ACCIONES_LECTURA, ACCIONES_POR_AREA, CODIGOS_ABSORBIDOS, OPCIONALES_ARBOL, PADRES_DE_OPCIONAL, codigosQueConceden, expandir, operacionesDe, predecesoresDe } = await import('../../src/modules/permisos/arbol/expansion.js');
const { conCadena } = await import('../helpers/auth.js');
const { absorbidosVivos, efectivasExpandidas, informeArbol, repartirPorTodos } = await import('../../src/modules/permisos/arbol/reparto-arbol.js');
const { filtrarPorFuncion } = await import('../../src/shared/permisos-efectivos.js');

/** El catálogo aprobado (Discussion de #13416, decisiones del PO del 2026-10-09), ítem → acciones. */
const APROBADO: Record<string, string[]> = {
  'pagina.flito_tramites': ['ver_listado', 'solicitar_soat', 'solicitar_impuestos', 'descargar_soportes', 'sincronizar', 'configurar_sincronizacion', 'crear_demo', 'entregar'],
  'pagina.flito_soat': ['ver_listado', 'ver_soportes', 'cargar_comprobantes', 'exportar', 'exportar_pago', 'cambiar_proveedor', 'solicitar_sin_tramite', 'gestionar_solicitudes', 'ver_por_validar', 'descargar_zip', 'ver_documentos_adicionales', 'cargar_documentos_adicionales', 'eliminar_documentos_adicionales'],
  'pagina.flito_impuestos': ['ver_listado', 'ver_soportes', 'cargar_comprobantes', 'exportar', 'exportar_pago', 'descargar_zip', 'gestionar_solicitudes', 'certificar_runt', 'cargar_recibo_caja', 'reemplazar_comprobante', 'corregir_direccion', 'descargar_certificado'],
  'pagina.flito_derechos': ['ver_listado', 'cargar', 'procesar_drive', 'ver_soportes'],
  'pagina.flito_revisiones': ['ver', 'revisar_lecturas'],
  'pagina.flito_logistica': ['ver_consola', 'registrar_viajes', 'generar_actas', 'ver_actas', 'despachar_entregar_devolver', 'cerrar_lote', 'reversar_paso'],
  'pagina.flito_logistica_ruta': ['ver', 'escanear', 'reportar_novedad'],
  'pagina.flito_comparendos': ['ver_listado', 'gestionar', 'sincronizar', 'configurar'],
  'pagina.transito_organismos': ['ver', 'editar'],
};

/** El segmento `<item>` de `accion.<item>.<accion>` de cada ítem, literal (no derivado de `ITEMS_GESTION`). */
const CLAVE_ITEM: Record<string, string> = {
  'pagina.flito_tramites': 'tramites', 'pagina.flito_soat': 'soat', 'pagina.flito_impuestos': 'impuestos',
  'pagina.flito_derechos': 'derechos', 'pagina.flito_revisiones': 'revisiones', 'pagina.flito_logistica': 'logistica',
  'pagina.flito_logistica_ruta': 'mi_ruta', 'pagina.flito_comparendos': 'comparendos', 'pagina.transito_organismos': 'organismos_stt',
};
/** Los 55 códigos `accion.*` que salen del catálogo aprobado: el oráculo de AC1, independiente del código. */
const ACCIONES_APROBADAS = Object.entries(APROBADO).flatMap(([item, claves]) => claves.map((c) => `accion.${CLAVE_ITEM[item]}.${c}`)).sort();

const nodo = new Map(ARBOL_GESTION.map((n) => [n.codigo, n]));
// HU #13427: el árbol ya tiene Finanzas; este archivo mide SOLO Gestión y Tránsito (Finanzas: permisos-arbol-finanzas.test.ts).
const GESTION = ACCIONES_POR_AREA.gestion;
const DE_GESTION = new Set(GESTION);
const ABSORBIDOS_GESTION = new Set([...Object.values(ACCIONES_GESTION).flatMap((a) => a.operaciones), ...CONJUNCIONES_GESTION.map((c) => c.operacion)]);
const OPCIONALES_GESTION = new Set(Object.values(ACCIONES_GESTION).flatMap((a) => a.opcionales ?? []));
/** El ítem (nivel 2) de un nodo de acción, subiendo por la acción madre si es anidada. */
const itemDe = (codigo: string): string => {
  const n = nodo.get(codigo)!;
  return n.tipo === 'item' ? n.codigo : itemDe(n.padre!);
};

describe('AC1 — el catálogo de Gestión y Tránsito es la lista aprobada', () => {
  it('9 ítems, con su elemento: 8 en Gestión y Organismos STT en Tránsito; en el orden del menú', () => {
    const items = ARBOL_GESTION.filter((n) => n.tipo === 'item');
    expect(items.map((n) => n.codigo)).toEqual(Object.keys(APROBADO));
    expect(items.filter((n) => n.padre === 'menu.gestion')).toHaveLength(8);
    expect(nodo.get('pagina.transito_organismos')!.padre).toBe('menu.transito');
    expect(ITEMS_GESTION.map((i) => i.nombre)).toEqual(['Gestión Trámites', 'SOAT', 'Impuestos', 'Derechos', 'Revisiones OCR', 'Logística', 'Mi ruta', 'Comparendos', 'Organismos STT']);
  });

  it('cada ítem tiene EXACTAMENTE sus acciones aprobadas (ni una más, ni una menos)', () => {
    const acciones = ARBOL_GESTION.filter((n) => n.tipo === 'accion');
    for (const [item, claves] of Object.entries(APROBADO)) {
      const deEste = acciones.filter((a) => itemDe(a.codigo) === item).map((a) => a.codigo.split('.')[2]);
      expect(deEste, item).toEqual(claves);
    }
    expect(acciones).toHaveLength(Object.values(APROBADO).flat().length);
  });

  it('decisiones del PO: sin «ver_factura» (P-6), Impuestos sin acciones de SOAT sin operación (P-5), Revisiones con una sola «revisar_lecturas» (P-7)', () => {
    const codigos = ARBOL_GESTION.map((n) => n.codigo);
    expect(codigos.filter((c) => /ver_factura/.test(c))).toEqual([]);
    for (const c of ['cambiar_proveedor', 'solicitar_sin_tramite', 'ver_por_validar', 'ver_documentos_adicionales']) {
      expect(codigos, c).not.toContain(`accion.impuestos.${c}`);
    }
    // P-6: la factura de venta va con «Ver el listado» de Impuestos, como OPCIONAL (es un documento con datos del titular).
    expect(ACCIONES_GESTION['accion.impuestos.ver_listado']!.opcionales).toEqual(['impuestos.factura.ver']);
    expect(operacionesDe('accion.impuestos.ver_listado')).not.toContain('impuestos.factura.ver');
    expect(operacionesDe('accion.revisiones.revisar_lecturas')).toEqual(['revisiones.revision.resolver', 'revisiones.revision.descartar']);
  });

  it('ninguna operación absorbida sigue en el catálogo de hoy ni se concede directo (TC-01d)', () => {
    const hoy = new Set(catalogoCompleto().map((f) => f.codigo));
    expect([...CODIGOS_ABSORBIDOS].filter((c) => hoy.has(c))).toEqual([]);
    // Control: lo absorbido existía en el mundo plano (si no, la intersección vacía no prueba nada).
    const plano = new Set(catalogoPlano().map((f) => f.codigo));
    expect([...ABSORBIDOS_GESTION].filter((c) => !plano.has(c))).toEqual([]);
    // 132 operaciones del área menos los 7 opcionales (PO, 2026-10-13) = 125; menos `sync.sync.lanzar`,
    // retirada en la HU #13631 (migración 0243) = 124.
    expect(ABSORBIDOS_GESTION.size).toBe(124);
    // Y el paso no deja ninguna marca (rol ni usuario) sobre lo absorbido, aunque la tuviera antes.
    const todo = [...ABSORBIDOS_GESTION];
    const r = repartirPorTodos([{ id: 1, rol: 'r' }], {
      filasRol: todo.map((codigo) => ({ rol: 'r', codigo })),
      filasUsuario: todo.slice(0, 5).map((codigo) => ({ userId: 1, codigo, efecto: 'conceder' as const })),
    }, undefined, GESTION);
    expect([...r.filasRol, ...r.filasUsuario].filter((f) => ABSORBIDOS_GESTION.has(f.codigo))).toEqual([]);
  });

  it('elementos de nivel 1 en el orden del menú, con «LAFT» (P-13) y «Ayuda» derivada', () => {
    const elementos = ARBOL_PERMISOS.filter((n) => n.tipo === 'elemento');
    expect(elementos.map((n) => n.nombre)).toEqual(['General', 'Gestión', 'Tránsito', 'Flota', 'Mantenimiento', 'PESV', 'RNDC', 'LAFT', 'Finanzas', 'Administración', 'Ayuda', 'Perfil']);
    expect(elementos.filter((n) => n.derivado).map((n) => n.codigo)).toEqual(['menu.ayuda']);
    for (const e of elementos) expect(e.codigo.startsWith(PREFIJO_ELEMENTO)).toBe(true);
  });

  it('el catálogo del código emite las 55 acciones (nivel 3, padre en la base) y marca nivel 2 a los 9 ítems', () => {
    const cat = catalogoCompleto();
    const acciones = cat.filter((f) => f.tipo === 'accion' && DE_GESTION.has(f.codigo));
    expect(ACCIONES_APROBADAS).toHaveLength(55);
    expect(acciones.map((f) => f.codigo).sort()).toEqual(ACCIONES_APROBADAS);
    expect(Object.keys(ACCIONES_GESTION).sort()).toEqual(ACCIONES_APROBADAS);
    for (const a of acciones) {
      expect(a.nivel, a.codigo).toBe(3);
      expect(a.codigo.startsWith(PREFIJO_ACCION)).toBe(true);
      expect(a.padre, a.codigo).toBe(nodo.get(a.codigo)!.padre);
    }
    expect(cat.filter((f) => f.nivel === 2 && nodo.has(f.codigo)).map((f) => f.codigo).sort()).toEqual(Object.keys(APROBADO).sort());
    // El panel plano (hasta #13430) agrupa la acción con su página: mismo `modulo`.
    const moduloDe = new Map(cat.map((f) => [f.codigo, f.modulo]));
    for (const a of acciones) expect(a.modulo, a.codigo).toBe(moduloDe.get(itemDe(a.codigo)));
  });
});

describe('AC2 — «Exportar con datos de pago y trazabilidad» cuelga de «Exportar a Excel»', () => {
  it.each(['soat', 'impuestos'])('%s: exportar_pago es hija de exportar, las dos de nivel 3', (item) => {
    const hija = catalogoCompleto().find((f) => f.codigo === `accion.${item}.exportar_pago`)!;
    expect(hija.padre).toBe(`accion.${item}.exportar`);
    expect(hija.nivel).toBe(3);
    expect(hija.nombreNegocio).toBe('Exportar con datos de pago y trazabilidad');
    expect(nodo.get(`accion.${item}.exportar`)!.padre).toBe(`pagina.flito_${item}`);
    expect(operacionesDe(`accion.${item}.exportar`)).toEqual([`${item}.excel.exportar`]);
    expect(operacionesDe(`accion.${item}.exportar_pago`)).toEqual([`${item}.excel.exportar_pago`]);
    // La madre NO concede la columna de pago: hace falta la hija.
    expect(expandir([`accion.${item}.exportar`]).has(`${item}.excel.exportar_pago`)).toBe(false);
  });
});

describe('AC3 — «Entregar trámites» en Gestión Trámites; la Compuerta deja de ser ítem', () => {
  it('no hay ítem Compuerta; su página ya no se concede directo y la abre «Entregar»', () => {
    expect(ARBOL_PERMISOS.some((n) => n.slug === 'flito_compuerta')).toBe(false);
    expect(nodo.get('accion.tramites.entregar')!.padre).toBe('pagina.flito_tramites');
    expect(catalogoPlano().map((f) => f.codigo)).toContain('pagina.flito_compuerta');
    const hoy = catalogoCompleto().map((f) => f.codigo);
    expect(hoy).not.toContain('pagina.flito_compuerta');
    expect(hoy.filter((c) => c.startsWith('compuerta.'))).toEqual([]);
    const efectivo = expandir(conCadena(['accion.tramites.entregar'])); // HU #13429: con su ítem y su elemento
    for (const c of ['tramites.tramite.entregar', 'compuerta.cola.ver', 'compuerta.tramite.ver', 'compuerta.tramite.entregar', 'pagina.flito_compuerta']) {
      expect(efectivo.has(c), c).toBe(true);
    }
  });

  it('«Solicitar SOAT e impuestos a la vez» exige las dos acciones de solicitar (conjunción, no acción)', () => {
    expect(CONJUNCIONES_GESTION).toEqual([{ operacion: 'tramites.solicitud.pedir_ambos', acciones: ['accion.tramites.solicitar_soat', 'accion.tramites.solicitar_impuestos'] }]);
    expect(expandir(conCadena(['accion.tramites.solicitar_soat'])).has('tramites.solicitud.pedir_ambos')).toBe(false);
    expect(expandir(conCadena(['accion.tramites.solicitar_impuestos'])).has('tramites.solicitud.pedir_ambos')).toBe(false);
    expect(expandir(conCadena(['accion.tramites.solicitar_soat', 'accion.tramites.solicitar_impuestos'])).has('tramites.solicitud.pedir_ambos')).toBe(true);
    expect(CODIGOS_ABSORBIDOS.has('tramites.solicitud.pedir_ambos')).toBe(true);
  });
});

describe('AC6 — árbol ↔ operaciones reales, en los dos sentidos', () => {
  const declaradas = new Set(OPERACIONES_DECLARADAS.map((o) => o.codigo));
  const delArea = [...declaradas].filter((c) => AREA_GESTION.test(c)).sort();
  // Los opcionales (P-9 revisada) cuentan como «pedidos por una acción» aunque no se expandan.
  const concedidas = new Set([...Object.keys(ACCIONES_GESTION).flatMap((a) => operacionesDe(a)), ...CONJUNCIONES_GESTION.map((c) => c.operacion), ...OPCIONALES_ARBOL]);

  it('(a) toda operación del área está en ≥1 acción (o en una conjunción, o declarada fuera de área)', () => {
    expect(delArea.length).toBeGreaterThan(130);
    expect(delArea.filter((c) => !concedidas.has(c) && !(c in FUERA_DE_AREA_GESTION))).toEqual([]);
  });

  it('(b) toda acción concede ≥1 operación con guarda viva', () => {
    for (const a of Object.keys(ACCIONES_GESTION)) {
      expect(operacionesDe(a).filter((c) => declaradas.has(c)).length, a).toBeGreaterThan(0);
    }
  });

  it('(c) ninguna acción refiere un código inexistente (operación declarada o página del catálogo)', () => {
    const paginas = new Set(catalogoPlano().filter((f) => f.tipo === 'pagina').map((f) => f.codigo));
    expect([...concedidas].filter((c) => !declaradas.has(c) && !paginas.has(c))).toEqual([]);
  });

  it('lo de fuera de área NO lo absorbe Gestión; existe, y lo absorbe su área de destino cuando ya está migrada', () => {
    for (const c of Object.keys(FUERA_DE_AREA_GESTION)) {
      expect(declaradas.has(c), c).toBe(true);
      expect(ABSORBIDOS_GESTION.has(c), c).toBe(false);
    }
    // HU #13428: autogestión y empresa ya las absorbe «Clientes y proveedores». HU #13429: el SOAT antiguo es de su ítem
    // antiguo (`pagina.soat`): `administrar` lo expande y `operar` es su opcional (P-26).
    const destino13428 = Object.entries(FUERA_DE_AREA_GESTION).filter(([, d]) => d.includes('#13428')).map(([c]) => c);
    expect(destino13428.sort()).toEqual(['tramites.autogestion.desbloquear', 'tramites.autogestion.revocar', 'tramites.empresa.crear']);
    for (const c of destino13428) expect(ACCIONES_POR_AREA.administracion.some((a) => operacionesDe(a).includes(c)), c).toBe(true);
    for (const c of Object.keys(FUERA_DE_AREA_GESTION).filter((x) => !destino13428.includes(x))) {
      expect(ACCIONES_POR_AREA.gestion.some((a) => operacionesDe(a).includes(c)), c).toBe(false);
      expect(CODIGOS_ABSORBIDOS.has(c) || PADRES_DE_OPCIONAL.get(c)?.includes('pagina.soat'), c).toBe(true);
    }
  });

  it('ningún código de operación ni de guarda empieza por `accion.` o `menu.`', () => {
    expect([...declaradas].filter((c) => c.startsWith(PREFIJO_ACCION) || c.startsWith(PREFIJO_ELEMENTO))).toEqual([]);
  });

  it('el índice inverso: quién concede una operación (para `usuariosConFuncion` y la bitácora)', () => {
    expect(codigosQueConceden('soat.cola.ver')).toEqual(['soat.cola.ver', 'accion.soat.ver_listado']);
    expect(codigosQueConceden('logistica.documento.ver').sort()).toEqual(['accion.logistica.ver_consola', 'accion.mi_ruta.ver', 'logistica.documento.ver']);
    expect(codigosQueConceden('tramites.solicitud.pedir_ambos').sort())
      .toEqual(['accion.tramites.solicitar_impuestos', 'accion.tramites.solicitar_soat', 'tramites.solicitud.pedir_ambos']);
  });

  it('revocar gana también sobre lo que traería una acción', () => {
    const e = expandir(conCadena(['accion.soat.ver_listado', 'parametrizacion.companias.listar']), ['soat.cola.ver']);
    expect(e.has('soat.cola.filtrar')).toBe(true);
    expect(e.has('soat.cola.ver')).toBe(false);
  });
});

/**
 * Fixture (roles inventados, sin literales de rol del producto). Decisión del PO del 2026-10-13:
 *   · «Gestionar solicitudes» MODIFICA → regla «todos» (6 operaciones);
 *   · «Ver el listado» es de LECTURA → basta ALGUNA de sus 4 operaciones.
 */
const GRUPO_GESTION = ['soat.solicitud.enviar', 'soat.solicitud.asumir', 'soat.solicitud.devolver', 'soat.solicitud.reactivar', 'soat.solicitud.reversar', 'soat.solicitud.rechazar'];
const PARCIAL = GRUPO_GESTION.filter((c) => c !== 'soat.solicitud.rechazar');
const GRUPO_LISTADO = ['soat.cola.ver', 'soat.cola.filtrar', 'soat.solicitud.ver', 'soat.solicitud.ver_historial'];
const usuarios = [
  { id: 1, rol: 'rol_completo' }, { id: 2, rol: 'rol_parcial' }, { id: 3, rol: 'rol_completo' }, { id: 4, rol: 'rol_parcial' },
  { id: 5, rol: 'rol_parcial' }, { id: 6, rol: 'rol_lector' },
];
const filasRol = [
  ...GRUPO_GESTION.map((codigo) => ({ rol: 'rol_completo', codigo })),
  ...GRUPO_LISTADO.map((codigo) => ({ rol: 'rol_completo', codigo })),
  ...PARCIAL.map((codigo) => ({ rol: 'rol_parcial', codigo })),
  { rol: 'rol_lector', codigo: 'soat.solicitud.ver' }, // UNA de las 4 del listado
  { rol: 'rol_completo', codigo: 'pagina.flito_soat' },
];

describe('AC4 — la regla del paso sobre los roles: «todos» si modifica, «alguna» si es de lectura', () => {
  const despues = repartirPorTodos(usuarios, { filasRol, filasUsuario: [] });
  const tiene = (rol: string, c: string) => despues.filasRol.some((f) => f.rol === rol && f.codigo === c);

  it('las acciones de lectura son EXACTAMENTE la lista aprobada (flag explícito, no el nombre)', () => {
    const LECTURA = [
      'accion.comparendos.ver_listado', 'accion.derechos.ver_listado',
      'accion.impuestos.ver_listado', 'accion.impuestos.ver_soportes', 'accion.logistica.ver_actas',
      'accion.logistica.ver_consola', 'accion.mi_ruta.ver', 'accion.organismos_stt.ver', 'accion.revisiones.ver',
      'accion.soat.ver_documentos_adicionales', 'accion.soat.ver_listado', 'accion.soat.ver_por_validar',
      'accion.soat.ver_soportes', 'accion.tramites.ver_listado',
    ];
    expect(LECTURA).toHaveLength(14); // «Ver soportes» de Derechos es una descarga: no es de lectura (PO, 2026-10-13)
    expect([...ACCIONES_LECTURA].filter((a) => DE_GESTION.has(a)).sort()).toEqual(LECTURA);
    // Descargar y exportar no son de lectura (la auditoría no descarga): «Descargar soportes» de Trámites sigue con «todos».
    expect(ACCIONES_LECTURA.has('accion.tramites.descargar_soportes')).toBe(false);
    expect(ACCIONES_LECTURA.has('accion.derechos.ver_soportes')).toBe(false);
  });

  it('ninguna acción de lectura expande a una operación de exportar o descargar, ni a nada que escriba', () => {
    // Por dos vías independientes del flag: el código de la operación y la guarda real que la pide.
    // Mutante que esto mata (QA, 2026-10-13): volver a meter `comparendos.registros.exportar` en
    // «Ver el listado» de Comparendos (POST /registros/export pasaba la regex anterior de «consulta»).
    const llavesDe = (op: string) => OPERACIONES_DECLARADAS.filter((o) => o.codigo === op).map((o) => o.llave);
    // `factura`: la factura de venta se sirve como documento (PDF con datos del titular, HU #11910).
    const descarga = (op: string, llave: string) => /\.(exportar|descargar)\w*$/.test(op) || /\.factura\./.test(op) || / \S*(export|descarg|zip|\/pdf|\/archivo|factura)\S*( \[[^\]]+\])?$/i.test(llave);
    const escribe = (llave: string) => !(/ GET /.test(llave) || / POST \S*\/buscar( \[[^\]]+\])?$/.test(llave));
    // HU #13427: SOLO las de Gestión y Tránsito; Finanzas tiene su propio detector (permisos-arbol-finanzas.test.ts).
    const malas = [...ACCIONES_LECTURA].filter((a) => DE_GESTION.has(a)).flatMap((a) => operacionesDe(a).flatMap((op) => {
      const llaves = llavesDe(op);
      if (llaves.length === 0) return [`${a}: ${op} sin guarda declarada`];
      return llaves.filter((l) => descarga(op, l) || escribe(l)).map((l) => `${a}: ${op} (${l})`);
    }));
    expect(malas).toEqual([]);
    // Control: el detector SÍ ve las tres que la decisión pasó a opcionales.
    expect(descarga('comparendos.registros.exportar', 'flito-comparendos/flito-comparendos.routes.ts POST /registros/export')).toBe(true);
    expect(descarga('revisiones.soporte.descargar', 'flito-revisiones/flito-revisiones.routes.ts GET /soporte/:soporteId/archivo')).toBe(true);
    expect(descarga('logistica.actas.descargar', 'flito-logistica/flito-logistica.routes.ts GET /actas/:id/pdf')).toBe(true);
    expect(descarga('impuestos.factura.ver', 'flito-impuestos/flito-impuestos.routes.ts GET /:id/factura-venta')).toBe(true);
    expect(escribe('x.ts POST /registros/export')).toBe(true);
  });

  it('modifica («Gestionar solicitudes»): el rol con las 6 la recibe; el que tiene 5 de 6 NO', () => {
    expect(tiene('rol_completo', 'accion.soat.gestionar_solicitudes')).toBe(true);
    expect(tiene('rol_parcial', 'accion.soat.gestionar_solicitudes')).toBe(false);
  });

  it('lectura («Ver el listado»): con UNA de las 4 basta; con NINGUNA no se recibe', () => {
    expect(tiene('rol_lector', 'accion.soat.ver_listado')).toBe(true);
    expect(tiene('rol_completo', 'accion.soat.ver_listado')).toBe(true);
    expect(tiene('rol_parcial', 'accion.soat.ver_listado')).toBe(false);
  });

  it('las operaciones absorbidas desaparecen del reparto; lo que no es del árbol (páginas) se queda', () => {
    expect(despues.filasRol.filter((f) => CODIGOS_ABSORBIDOS.has(f.codigo))).toEqual([]);
    expect(tiene('rol_completo', 'pagina.flito_soat')).toBe(true);
  });

  it('el reporte en seco cuenta la pérdida del rol parcial (solo lo que modifica) y la ganancia del lector', () => {
    const i = informeArbol(usuarios, { filasRol, filasUsuario: [] });
    const resto = GRUPO_LISTADO.filter((c) => c !== 'soat.solicitud.ver').sort();
    expect(i.cambios.map((c) => [c.userId, c.pierde, c.gana])).toEqual([
      [2, PARCIAL.slice().sort(), []],
      [4, PARCIAL.slice().sort(), []],
      [5, PARCIAL.slice().sort(), []],
      [6, [], resto],
    ]);
  });
});

describe('AC5 — la misma regla sobre las excepciones por usuario', () => {
  const filasUsuario = [
    { userId: 3, codigo: 'soat.solicitud.rechazar', efecto: 'revocar' as const },   // modifica: le falta una → revocar
    { userId: 4, codigo: 'soat.solicitud.rechazar', efecto: 'conceder' as const },  // modifica: la completa → conceder
    { userId: 5, codigo: 'soat.cola.filtrar', efecto: 'conceder' as const },        // lectura: con una concedida → conceder
    { userId: 6, codigo: 'soat.solicitud.ver', efecto: 'revocar' as const },        // lectura: le quitan la única → revocar
  ];
  const despues = repartirPorTodos(usuarios, { filasRol, filasUsuario });
  const excepcion = (id: number) => despues.filasUsuario.filter((f) => f.userId === id).map((f) => `${f.efecto} ${f.codigo}`);

  it('modifica: al que su rol da la acción pero le faltaba una pieza se le REVOCA; al que la completaba con una concesión se le CONCEDE', () => {
    expect(excepcion(3)).toEqual(['revocar accion.soat.gestionar_solicitudes']);
    expect(excepcion(4)).toEqual(['conceder accion.soat.gestionar_solicitudes']);
    expect(excepcion(1)).toEqual([]);
    expect(excepcion(2)).toEqual([]);
  });

  it('lectura: con UNA concedida se CONCEDE; si le revocaron la única que su rol le daba, se REVOCA', () => {
    expect(excepcion(5)).toEqual(['conceder accion.soat.ver_listado']);
    expect(excepcion(6)).toEqual(['revocar accion.soat.ver_listado']);
  });

  it('el efectivo expandido de cada persona sigue la regla sobre SU conjunto viejo', () => {
    const e = efectivasExpandidas(usuarios, despues);
    expect(GRUPO_GESTION.every((c) => e.get(1)!.has(c))).toBe(true);
    expect(GRUPO_GESTION.some((c) => e.get(2)!.has(c))).toBe(false);
    expect(GRUPO_GESTION.some((c) => e.get(3)!.has(c))).toBe(false);
    expect(GRUPO_GESTION.every((c) => e.get(4)!.has(c))).toBe(true);
    expect(GRUPO_LISTADO.every((c) => e.get(5)!.has(c))).toBe(true);
    expect(GRUPO_LISTADO.some((c) => e.get(6)!.has(c))).toBe(false);
  });

  it('`usuariosConFuncion` (su pliegue puro) ve el mundo nuevo: la operación la da la acción', () => {
    const filas = new Map(usuarios.map((u) => [u.id, {
      rol: u.rol, tipoEnlace: 'ninguno',
      // HU #13429: las filas llegan con su cadena (ítem y elemento), como tras la 0239.
      funcionesDelRol: conCadena(despues.filasRol.filter((f) => f.rol === u.rol).map((f) => f.codigo)),
      excepciones: [
        ...conCadena(despues.filasUsuario.filter((f) => f.userId === u.id && f.efecto === 'conceder').map((f) => f.codigo))
          .map((codigo) => ({ codigo, efecto: 'conceder' as const })),
        ...despues.filasUsuario.filter((f) => f.userId === u.id && f.efecto === 'revocar').map((f) => ({ codigo: f.codigo, efecto: f.efecto })),
      ],
    }]));
    expect(filtrarPorFuncion(filas, 'soat.solicitud.rechazar')).toEqual([1, 4]);
    expect(filtrarPorFuncion(filas, 'soat.cola.ver')).toEqual([1, 3, 5]);
  });
});

describe('Opcionales (PO, 2026-10-13): ni grupo, ni expansión, ni retiro', () => {
  const ACCION = 'accion.logistica.despachar_entregar_devolver';
  const DESPACHAR = 'logistica.actas.despachar';
  const AJENAS = 'logistica.actas.operar_ajenas';
  const RUNT = 'soat.solicitud.reintentar_runt';

  it('son EXACTAMENTE despachar y operar ajenas, reintentar el RUNT, y exportar/descargar dentro de las de lectura', () => {
    expect([...OPCIONALES_GESTION].sort()).toEqual([
      AJENAS, DESPACHAR, RUNT,
      'comparendos.registros.exportar', 'logistica.actas.descargar', 'revisiones.soporte.descargar',
      'impuestos.factura.ver',
      'logistica.actas.ver_documento_firmante', // HU #14110: cédula del firmante del acta de organismo (PII, se concede aparte)
      'logistica.recogida.confirmar', // HU #14110: opcional de accion.mi_ruta.escanear (firma del organismo)
      'logistica.documento.resolver_tramite', // HU #14143: opcional de accion.logistica.reversar_paso (resolver el trámite de una LT pendiente)
      'logistica.traslado.registrar', // HU #14114: opcional de accion.mi_ruta.escanear (registrar viaje a cliente)
    ].sort());
  });

  it('en las de lectura, quien tenía exportar/descargar lo conserva y nadie lo gana', () => {
    const us = [{ id: 1, rol: 'r_lee' }, { id: 2, rol: 'r_exporta' }];
    const antes = { filasRol: [
      { rol: 'r_lee', codigo: 'comparendos.registros.listar' },
      { rol: 'r_exporta', codigo: 'comparendos.registros.listar' }, { rol: 'r_exporta', codigo: 'comparendos.registros.exportar' },
    ], filasUsuario: [] };
    const e = efectivasExpandidas(us, repartirPorTodos(us, antes));
    expect(e.get(1)!.has('comparendos.registro.ver')).toBe(true);
    expect(e.get(1)!.has('comparendos.registros.exportar')).toBe(false);
    expect(e.get(2)!.has('comparendos.registros.exportar')).toBe(true);
  });

  it('ninguna acción absorbe un opcional, ninguna lo expande y siguen en el catálogo de hoy', () => {
    const hoy = new Set(catalogoCompleto().map((f) => f.codigo));
    for (const c of OPCIONALES_ARBOL) {
      expect(CODIGOS_ABSORBIDOS.has(c), c).toBe(false);
      expect(Object.keys(ACCIONES_GESTION).filter((a) => operacionesDe(a).includes(c)), c).toEqual([]);
      expect(hoy.has(c), c).toBe(true);
    }
    expect(predecesoresDe(ACCION)).toEqual(['logistica.actas.entregar', 'logistica.actas.devolver']);
    expect(predecesoresDe('accion.soat.ver_por_validar')).toEqual(['soat.incompletas.buscar', 'soat.incompleta.ver']);
  });

  it('el catálogo rechaza un opcional que otra acción absorbe (la validación de `catalogoDeAcciones` existe)', () => {
    // Control de la red: el mensaje de error está en el código y nombra el caso.
    expect(catalogoDeAcciones.toString()).toMatch(/declara opcional un código que otra acción absorbe/);
  });

  it('mensajero: con entregar y devolver recibe la acción y sigue sin despachar ni operar ajenas; quien las tenía, las conserva', () => {
    const us = [{ id: 1, rol: 'r_mensajero' }, { id: 2, rol: 'r_logistica' }];
    const antes = { filasRol: [
      { rol: 'r_mensajero', codigo: 'logistica.actas.entregar' }, { rol: 'r_mensajero', codigo: 'logistica.actas.devolver' },
      ...['logistica.actas.entregar', 'logistica.actas.devolver', DESPACHAR, AJENAS].map((codigo) => ({ rol: 'r_logistica', codigo })),
    ], filasUsuario: [] };
    const r = repartirPorTodos(us, antes);
    const e = efectivasExpandidas(us, r);
    expect(r.filasRol.filter((f) => f.codigo === ACCION).map((f) => f.rol).sort()).toEqual(['r_logistica', 'r_mensajero']);
    expect(e.get(1)!.has('logistica.actas.entregar')).toBe(true);
    expect(e.get(1)!.has(DESPACHAR)).toBe(false);
    expect(e.get(1)!.has(AJENAS)).toBe(false);
    expect(e.get(2)!.has(DESPACHAR)).toBe(true);
    expect(e.get(2)!.has(AJENAS)).toBe(true);
    expect(r.filasUsuario).toEqual([]);
  });

  it('Ver por validar: con UNA de las dos de consulta se recibe, y nadie gana reintentar el RUNT', () => {
    const us = [{ id: 1, rol: 'r_lee' }, { id: 2, rol: 'r_runt' }];
    const antes = { filasRol: [
      { rol: 'r_lee', codigo: 'soat.incompletas.buscar' },
      { rol: 'r_runt', codigo: 'soat.incompletas.buscar' }, { rol: 'r_runt', codigo: RUNT },
    ], filasUsuario: [] };
    const e = efectivasExpandidas(us, repartirPorTodos(us, antes));
    expect(e.get(1)!.has('soat.incompleta.ver')).toBe(true);
    expect(e.get(1)!.has(RUNT)).toBe(false);
    expect(e.get(2)!.has(RUNT)).toBe(true);
  });
});

describe('AC7 — documentos adicionales: 1:1, conservan roles y excepciones', () => {
  const OPS = ['ver', 'cargar', 'eliminar'].map((x) => [`accion.soat.${x}_documentos_adicionales`, `soat.documentos_adicionales.${x}`] as const);

  it('cada acción concede exactamente su operación', () => {
    for (const [accion, op] of OPS) expect(operacionesDe(accion)).toEqual([op]);
  });

  it('quien tenía cada operación (por rol o por excepción, también revocada) tiene después exactamente la misma', () => {
    const us = [{ id: 10, rol: 'r_docs' }, { id: 11, rol: 'r_docs' }, { id: 12, rol: 'r_nada' }];
    const antes = {
      filasRol: [{ rol: 'r_docs', codigo: 'soat.documentos_adicionales.ver' }, { rol: 'r_docs', codigo: 'soat.documentos_adicionales.cargar' }],
      filasUsuario: [
        { userId: 11, codigo: 'soat.documentos_adicionales.cargar', efecto: 'revocar' as const },
        { userId: 12, codigo: 'soat.documentos_adicionales.eliminar', efecto: 'conceder' as const },
      ],
    };
    const hoy = efectivasExpandidas(us, antes);
    const manana = efectivasExpandidas(us, repartirPorTodos(us, antes));
    for (const u of us) for (const [, op] of OPS) expect(manana.get(u.id)!.has(op), `${u.id} ${op}`).toBe(hoy.get(u.id)!.has(op));
  });
});

describe('Grupo incompleto en un ambiente (nota de db-review, 2026-10-13)', () => {
  it('si falta un código de un grupo, su acción no se reparte y sus demás miembros NO se borran', () => {
    const existentes = new Set(catalogoPlano().map((f) => f.codigo));
    existentes.delete('soat.solicitud.rechazar'); // falta un miembro de «Gestionar solicitudes»
    const vivos = PARCIAL; // los otros 5
    // Solo Gestión (HU #13428: con el árbol entero, el reparto universal de Perfil también llegaría a `r`).
    const r = repartirPorTodos([{ id: 1, rol: 'r' }], { filasRol: vivos.map((codigo) => ({ rol: 'r', codigo })), filasUsuario: [] }, existentes, GESTION);
    expect(r.filasRol.map((f) => f.codigo).sort()).toEqual([...vivos].sort());
    expect(absorbidosVivos(existentes).has('soat.solicitud.enviar')).toBe(false);
    // Control: con el grupo entero, sí se absorbe y la acción llega.
    const todos = repartirPorTodos([{ id: 1, rol: 'r' }], { filasRol: GRUPO_GESTION.map((codigo) => ({ rol: 'r', codigo })), filasUsuario: [] }, new Set(catalogoPlano().map((f) => f.codigo)), GESTION);
    expect(todos.filasRol.map((f) => f.codigo)).toEqual(['accion.soat.gestionar_solicitudes']);
  });

  it('la conjunción solo se absorbe si sobreviven TODAS sus acciones', () => {
    const existentes = new Set(catalogoPlano().map((f) => f.codigo));
    existentes.delete('tramites.solicitud.pedir_soat');
    expect(absorbidosVivos(existentes).has('tramites.solicitud.pedir_ambos')).toBe(false);
    expect(absorbidosVivos(new Set(catalogoPlano().map((f) => f.codigo))).has('tramites.solicitud.pedir_ambos')).toBe(true);
  });
});

describe('AC8 — el rol que tenía todo lo absorbido queda con todas las acciones', () => {
  it('por la regla, sin nombrarlo', () => {
    const todo = [...ABSORBIDOS_GESTION].map((codigo) => ({ rol: 'rol_con_todo', codigo }));
    const i = informeArbol([{ id: 1, rol: 'rol_con_todo' }], { filasRol: todo, filasUsuario: [] }, undefined, GESTION);
    expect(i.rolesConTodo).toEqual([{ rol: 'rol_con_todo', faltabanAntes: [], faltan: [] }]);
    expect(i.cambios).toEqual([]);
  });

  it('`admin` (decisión del PO del 2026-10-13) recibe TODAS, también aquella cuyo grupo no tenía entero, y a sus usuarios no se les revoca', () => {
    const sinGrupoSoat = [...ABSORBIDOS_GESTION].filter((c) => !['soat.solicitud.crear', 'soat.runt.preconsultar', 'soat.factura.leer'].includes(c));
    const filas = { filasRol: sinGrupoSoat.map((codigo) => ({ rol: 'admin', codigo })), filasUsuario: [] };
    const r = repartirPorTodos([{ id: 7, rol: 'admin' }], filas, undefined, GESTION);
    const deAdmin = r.filasRol.filter((f) => f.rol === 'admin').map((f) => f.codigo).sort();
    expect(deAdmin).toEqual(ACCIONES_APROBADAS);
    expect(r.filasUsuario).toEqual([]);
    expect(efectivasExpandidas([{ id: 7, rol: 'admin' }], r).get(7)!.has('soat.solicitud.crear')).toBe(true);
    // Control: otro rol con el mismo conjunto NO recibe «solicitar sin trámite» (la regla «todos» sigue).
    const otro = repartirPorTodos([], { filasRol: sinGrupoSoat.map((codigo) => ({ rol: 'r', codigo })), filasUsuario: [] });
    expect(otro.filasRol.map((f) => f.codigo)).not.toContain('accion.soat.solicitar_sin_tramite');
  });

  it('segunda corrida (los grupos ya no existen en la base): no reparte ni revoca nada', () => {
    const existentes = new Set(catalogoCompleto().map((f) => f.codigo));
    const filas = { filasRol: [{ rol: 'r', codigo: 'accion.soat.ver_listado' }], filasUsuario: [] };
    expect(repartirPorTodos([{ id: 1, rol: 'r' }], filas, existentes, GESTION)).toEqual(filas);
  });
});
