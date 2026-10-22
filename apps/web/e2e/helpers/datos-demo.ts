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

export const EMPRESAS_DEMO = ['Concesionario Demo Norte', 'Concesionario Demo Sur', 'Concesionario Demo Centro'] as const;

/** Organismos de tránsito: nombre real permitido (entidad pública). */
export const ORGANISMOS_REALES = ['Secretaría de Movilidad de Manizales', 'Secretaría de Movilidad de Bogotá'] as const;

export const DATOS_DEMO = {
  placas: ['ZZA101', 'ZZB202', 'ZZC303'],
  cedulas: ['9900000101', '9900000202', '9900000303'],
  nits: ['999000001-7', '999000002-5', '999000003-3'],
  telefonos: ['3000000101'],
  correos: ['mensajero@ejemplo.test'],
  vins: ['9ZZDEMO0000000101', '9ZZDEMO0000000202', '9ZZDEMO0000000303'],
  nombres: NOMBRES_DEMO as readonly string[],
  empresas: EMPRESAS_DEMO as readonly string[],
  /** `nombre`/`name` en las respuestas de clientes es el de una compañía o el de una persona: ambos demo. */
  nombresOEmpresas: [...NOMBRES_DEMO, ...EMPRESAS_DEMO] as readonly string[],
  /** `documento` de un tercero: cédula si es persona, NIT si es compañía. Ambos del registro. */
  documentos: ['9900000101', '9900000202', '9900000303', '999000001-7', '999000002-5', '999000003-3'] as readonly string[],
} as const;

/**
 * Claves de los fixtures que contienen un dato personal o identificador, y la categoría del registro
 * a la que deben pertenecer. La prueba recorre los fixtures y exige que cada valor bajo una de estas
 * claves salga de `DATOS_DEMO`.
 */
export const CLAVES_SENSIBLES: Record<string, keyof typeof DATOS_DEMO> = {
  placa: 'placas',
  documento: 'documentos',
  receptorDocumento: 'cedulas',
  propietarioDocumento: 'cedulas',
  cedula: 'cedulas',
  nit: 'nits',
  telefono: 'telefonos',
  celular: 'telefonos',
  correo: 'correos',
  email: 'correos',
  vin: 'vins',
  nombre: 'nombresOEmpresas',
  name: 'nombresOEmpresas',
  clienteNombre: 'empresas',
  titularDocumento: 'documentos',
  placaLeida: 'placas',
  subidoPorNombre: 'nombres',
  cargadaPorNombre: 'nombres',
  conciliadaPorNombre: 'nombres',
  registradoPorNombre: 'nombres',
  aplicadoPorNombre: 'nombres',
  descartadoPorNombre: 'nombres',
  companiaSoatNombre: 'empresas',
  companiaNombre: 'empresas',
  titularRazonSocial: 'empresas',
  companyName: 'empresas',
  contactoNombre: 'nombres',
  receptorNombre: 'nombres',
  propietarioNombre: 'nombres',
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

// ── Área Facturación (HU #13770) ─────────────────────────────────────────────
// Montos, facturas e ID FLIT sintéticos: facturas `DEMO-…`, ID FLIT `FLIT-DEMO-…`, valores redondos.

const CLIENTE_DEMO = [
  { id: 901, name: EMPRESAS_DEMO[0], nit: DATOS_DEMO.nits[0] },
  { id: 902, name: EMPRESAS_DEMO[1], nit: DATOS_DEMO.nits[1] },
  { id: 903, name: EMPRESAS_DEMO[2], nit: DATOS_DEMO.nits[2] },
] as const;

/** `GET /api/clients`: lista mínima de compañías demo (selectores de cliente). */
export const CLIENTES_DEMO = CLIENTE_DEMO.map((c) => ({
  id: c.id, name: c.name, nit: c.nit, document: c.nit, status: 'active', active: true,
  autogestionLogistica: false,
}));

function mapeo(id: string, concepto: string, codigo: string | null, nombreProducto: string | null, confirmado: boolean) {
  return {
    id, ambiente: 'pruebas', concepto, tipoTramite: null, codigoProducto: codigo, nombreProducto,
    clasificacionTributaria: null, impuestos: [], unidadMedida: codigo ? '94' : null,
    ingresoParaTerceros: concepto !== 'tramite_digital' && concepto !== 'logistica',
    lineaPropiaPendiente: false, confirmadoContabilidad: confirmado, confirmadoPorId: confirmado ? 1 : null,
    confirmadoEn: confirmado ? '2026-10-01T15:00:00.000Z' : null, validacionEstado: codigo ? 'ok' : 'pendiente',
    validacionMensaje: null, listoParaFacturar: codigo !== null,
  };
}

export const SIIGO_MAPEO_DEMO = {
  data: [
    mapeo('m-1', 'soat', 'DEMO-SOAT', 'SOAT (demo)', true),
    mapeo('m-2', 'impuesto_vehicular', 'DEMO-IMP', 'Impuesto vehicular (demo)', true),
    mapeo('m-3', 'derecho_transito', 'DEMO-DER', 'Derecho de tránsito (demo)', false),
    mapeo('m-4', 'tramite_digital', 'DEMO-TD', 'Trámite digital (demo)', true),
    mapeo('m-5', 'logistica', 'DEMO-LOG', 'Logística (demo)', false),
    mapeo('m-6', 'gmf', null, null, false),
  ],
};

export const SIIGO_COMPUERTA_DEMO = {
  ambiente: 'pruebas', modo: 'real', compuertaActiva: true, emisionRealHabilitada: false,
  motivos: [{ tipo: 'conceptos_sin_mapear', detalle: 'Falta mapear 1 concepto a un producto de Siigo: GMF (4x1000).', conceptos: ['gmf'] }],
};

export const SIIGO_VALIDACION_DEMO = {
  total: 3, facturables: 2, noFacturables: 1, pendientesClasificacion: 0,
  porMotivo: [{ motivo: 'telefono_faltante', detalle: 'Falta el teléfono.', clientes: 1 }],
};

export const SIIGO_VALIDACION_DETALLE_DEMO = {
  total: 3,
  data: [
    { clienteId: 901, nombre: EMPRESAS_DEMO[0], documento: DATOS_DEMO.nits[0], facturable: true, pendienteClasificacion: false, faltantes: [] },
    { clienteId: 903, nombre: EMPRESAS_DEMO[2], documento: DATOS_DEMO.nits[2], facturable: true, pendienteClasificacion: false, faltantes: [] },
    { clienteId: 902, nombre: EMPRESAS_DEMO[1], documento: null, facturable: false, pendienteClasificacion: false,
      faltantes: [{ motivo: 'telefono_faltante', detalle: 'Falta el teléfono.', campo: 'telefono' }] },
  ],
};

function guia(codigo: string, descripcion: string, accion: string, sirve: boolean) {
  return {
    codigo, descripcion, accion, responsable: 'operacion', responsableEtiqueta: 'Operación', reintentable: false,
    reintentoManual: sirve, sirveReintentar: sirve, conocido: true, texto: `${descripcion} ${accion}`,
  };
}

function caso(i: number, fuente: 'emision' | 'dian', dias: number, g: ReturnType<typeof guia>) {
  return {
    fuente, refId: `ref-demo-${i}`, facturaId: `fac-demo-${i}`, facturaNumero: fuente === 'emision' ? null : `DEMO-${100 + i}`,
    ocurridoEn: `2026-10-${String(21 - dias).padStart(2, '0')}T14:00:00.000Z`, antiguedadDias: dias, codigo: g.codigo,
    guia: g, detalle: g.descripcion,
    estado: { cola: fuente === 'emision' ? 'fallido_definitivo' : null, dian: fuente === 'dian' ? 'rechazada' : null, correo: null },
    colaId: fuente === 'emision' ? `cola-demo-${i}` : null, intentos: 3, maxIntentos: 3,
    tramites: [{ tramiteId: `tr-demo-${i}`, idFlit: `FLIT-DEMO-${i}` }],
    clienteId: 900 + ((i % 2) + 1), clienteNombre: EMPRESAS_DEMO[i % 2], descarte: null,
  };
}

const GUIA_TIEMPO = guia('timeout', 'Siigo no respondió a tiempo.', 'Vuelva a intentarlo.', true);
const GUIA_DIAN = guia('dian_rechazo', 'La DIAN rechazó el documento.', 'Registre una corrección.', false);

export const SIIGO_BANDEJA_DEMO = {
  ambiente: 'pruebas', limite: 50, offset: 0, hayMas: false,
  items: [caso(1, 'emision', 6, GUIA_TIEMPO), caso(2, 'dian', 3, GUIA_DIAN), caso(3, 'emision', 1, GUIA_TIEMPO)],
};

export const SIIGO_RESUMEN_DEMO = {
  ambiente: 'pruebas', total: 3,
  porFuente: { emision: 2, dian: 1, correo: 0 },
  porResponsable: { operacion: 3, contabilidad: 0, soporte: 0, automatico: 0 },
  porCodigo: [
    { codigo: 'timeout', etiqueta: 'Siigo no respondió a tiempo', total: 2, reintentable: true },
    { codigo: 'dian_rechazo', etiqueta: 'Rechazo de la DIAN', total: 1, reintentable: false },
  ],
};

export const SIIGO_FRENO_DEMO = {
  ambiente: 'pruebas', modo: 'real', ventanaHoras: 1, umbral: 0.5, minimoOperaciones: 10,
  desde: '2026-10-21T13:00:00.000Z', hasta: '2026-10-21T14:00:00.000Z', total: 20, errores: 1, erroresDeDatos: 0,
  proporcion: 0.05, muestraSuficiente: true, superaUmbral: false,
  frenoActivo: true, frenada: false, frenadaDesde: null, ultimaReactivacion: null, motivo: null,
};

export const SIIGO_LINEA_TIEMPO_DEMO = {
  tramiteId: 'tr-demo-1', facturacionIniciada: true, facturaId: 'fac-demo-1',
  hitos: [
    { fuente: 'liquidacion', tipo: 'liquidado', detalle: null, resultado: 'ok', ocurridoEn: '2026-10-14T13:00:00.000Z', usuarioId: 1 },
    { fuente: 'siigo', tipo: 'encolada', detalle: null, resultado: 'informativo', ocurridoEn: '2026-10-15T13:00:00.000Z', usuarioId: 1 },
    { fuente: 'siigo', tipo: 'intento_fallido', detalle: 'Siigo no respondió a tiempo.', resultado: 'error', ocurridoEn: '2026-10-15T14:00:00.000Z', usuarioId: null },
  ],
};

/** Productos de Siigo (catálogo demo). Su `nombre` es el de un producto, no el de una persona. */
export const SIIGO_PRODUCTOS_DEMO = {
  truncado: false, total: 6,
  items: SIIGO_MAPEO_DEMO.data.filter((m) => m.codigoProducto).map((m) => ({
    codigo: m.codigoProducto as string, nombre: m.nombreProducto as string, activo: true, impuestos: [],
  })),
};

export const SIIGO_TERCEROS_DEMO = {
  resumen: { totalClientes: 3, conTercero: 1 },
  ciudadesEstado: { total: 3, conCodigo: 3, pendientes: 0, proponibles: 0, ambiguos: 0, sinEquivalencia: 0 },
};

// ── Comprobantes ─────────────────────────────────────────────────────────────

function comprobante(i: number, p: Record<string, unknown>) {
  return {
    id: `comp-demo-${i}`, loteId: 'lote-demo-1', estado: 'pendiente', motivoPendiente: 'leido', detallePendiente: null,
    tipoDocumento: 'recibo_derecho', esPago: true, concepto: 'derecho', tramite: null, cruce: null,
    placaLeida: DATOS_DEMO.placas[0], vinLeido: null, idFlitLeido: null, valor: 98000, fechaDocumento: '2026-10-20',
    numeroDocumento: `DEMO-450${i}`, emisor: ORGANISMOS_REALES[0], marcadoPorDiferencia: false, diferenciaTarifa: null,
    diferenciaAceptada: false, paginas: null, archivo: { nombre: `comprobante-demo-${i}.pdf`, contentType: 'image/svg+xml' },
    createdAt: '2026-10-21T13:30:00.000Z', aplicadoEn: null, aplicadoAutomaticamente: false, descartadoEn: null,
    subidoPorNombre: NOMBRES_DEMO[2], aplicadoPorNombre: null, descartadoPorNombre: null,
    ...p,
  };
}

export const COMPROBANTES_DEMO = {
  total: 4, page: 1, pageSize: 25,
  items: [
    comprobante(1, {}),
    comprobante(2, { tipoDocumento: 'factura_soat', concepto: 'soat', valor: 485000, placaLeida: DATOS_DEMO.placas[1],
      motivoPendiente: 'tipo_no_identificado', paginas: [3, 4] }),
    comprobante(3, { tipoDocumento: null, esPago: null, concepto: null, valor: null, placaLeida: null,
      motivoPendiente: 'ocr_no_disponible', numeroDocumento: null, emisor: null }),
    comprobante(4, { estado: 'aplicado', motivoPendiente: null, aplicadoAutomaticamente: true, aplicadoEn: '2026-10-21T13:31:00.000Z',
      tramite: { id: 'tr-demo-3', idFlit: 'FLIT-DEMO-3', placa: DATOS_DEMO.placas[2] }, cruce: 'placa', placaLeida: DATOS_DEMO.placas[2],
      tipoDocumento: 'recibo_impuesto', concepto: 'impuesto', valor: 312000 }),
  ],
};

const ADMITE_DEMO = { derecho: 'admite', soat: 'ya_pagado', impuesto: 'admite', tramite_digital: 'admite', logistica: 'admite', servicios_adicionales: 'admite' };

export const COMPROBANTE_DETALLE_DEMO = {
  ...COMPROBANTES_DEMO.items[0],
  campos: [
    { campo: 'tipoDocumento', valor: 'recibo_derecho', confianza: 0.96, confiable: true, nivel: 'alta' },
    { campo: 'esComprobantePago', valor: 'true', confianza: 0.96, confiable: true, nivel: 'alta' },
    { campo: 'concepto', valor: 'derecho', confianza: 0.93, confiable: true, nivel: 'alta' },
    { campo: 'valorTotal', valor: '98000', confianza: 0.97, confiable: true, nivel: 'alta' },
    { campo: 'fechaPago', valor: '2026-10-20', confianza: 0.95, confiable: true, nivel: 'alta' },
    { campo: 'numeroDocumento', valor: 'DEMO-4501', confianza: 0.78, confiable: true, nivel: 'media' },
    { campo: 'emisor', valor: ORGANISMOS_REALES[0], confianza: 0.9, confiable: true, nivel: 'alta' },
    { campo: 'placa', valor: DATOS_DEMO.placas[0], confianza: 0.6, confiable: false, nivel: 'baja' },
  ],
  candidatos: [{
    tramiteId: 'tr-demo-1', idFlit: 'FLIT-DEMO-1', placa: DATOS_DEMO.placas[0], vin: DATOS_DEMO.vins[0], tipoTramite: 'Traspaso',
    empresa: EMPRESAS_DEMO[0], flitEstado: 'aprobado', liquidado: false, admite: ADMITE_DEMO,
  }],
  aplicadoMotivo: null, descartadoMotivo: null, soporteAplicadoId: null, diferenciaAceptadaEn: null,
  diferenciaAceptadaMotivo: null, diferenciaAceptadaPorNombre: null,
};

/** Imagen del comprobante demo (SVG sintético: no es un recibo real). */
export const COMPROBANTE_IMAGEN_DEMO = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="780" viewBox="0 0 600 780">
<rect width="600" height="780" fill="#ffffff"/><rect x="20" y="20" width="560" height="740" fill="none" stroke="#9aa5b1" stroke-width="2"/>
<text x="300" y="80" font-family="sans-serif" font-size="26" text-anchor="middle" fill="#1f2933">RECIBO DE PAGO — DEMO</text>
<text x="300" y="115" font-family="sans-serif" font-size="16" text-anchor="middle" fill="#52606d">${ORGANISMOS_REALES[0]}</text>
<g font-family="sans-serif" font-size="18" fill="#1f2933">
<text x="60" y="200">Concepto: Derecho de tránsito</text><text x="60" y="250">Placa: ${DATOS_DEMO.placas[0]}</text>
<text x="60" y="300">N.º de documento: DEMO-4501</text><text x="60" y="350">Fecha de pago: 20/10/2026</text>
<text x="60" y="420" font-size="24">Valor pagado: $ 98.000</text></g>
<text x="300" y="720" font-family="sans-serif" font-size="14" text-anchor="middle" fill="#9aa5b1">Documento de demostración sin validez</text></svg>`;

// ── Conciliación ─────────────────────────────────────────────────────────────

const CONTEO_VACIO = { ok: 0, no_encontrada: 0, no_pagado: 0, valor_distinto: 0, poliza_duplicada: 0, otra_compania: 0, ya_conciliada: 0, cobrado_otro_cliente: 0 };

function boleta(id: string, p: Record<string, unknown>) {
  return {
    id, referencia: `BOL-DEMO-${id.slice(-1)}`, companiaId: 901, companiaNombre: EMPRESAS_DEMO[0], concepto: 'soat', estado: 'cargada',
    archivoNombre: `boleta-portal-demo-${id.slice(-1)}.xlsx`, filas: 2, totalDeclarado: 970000, totalCruzado: 970000,
    fechaPago: '2026-10-20', cargadaPorNombre: NOMBRES_DEMO[2], conciliadaEn: null, conciliadaPorNombre: null,
    createdAt: '2026-10-20T15:00:00.000Z', conteo: { ...CONTEO_VACIO, ok: 2 }, sinCuadrar: 0, ...p,
  };
}

function linea(i: number, placa: string, valor: number, p: Record<string, unknown> = {}) {
  return {
    id: `lin-demo-${i}`, filaNumero: i + 1, numeroPolizaNorm: `DEMOPOL${1000 + i}`, valorDeclarado: valor, resultado: 'ok', detalle: null,
    soatId: `soat-demo-${i}`, placa, valorSoat: valor, soatEstado: 'pagado', companiaSoatNombre: EMPRESAS_DEMO[0], candidatos: null,
    boletaAnteriorRef: null, boletaAnteriorFecha: null, companiaCobroNombre: null, yaDescontadoEnLiquidacion: false, conciliadaEn: null, ...p,
  };
}

const BOLETA_SIN_CUADRAR = boleta('bol-demo-1', {
  companiaId: 902, companiaNombre: EMPRESAS_DEMO[1], totalDeclarado: 990000, totalCruzado: 970000,
  conteo: { ...CONTEO_VACIO, ok: 1, valor_distinto: 1 }, sinCuadrar: 1,
});
const BOLETA_CUADRA = boleta('bol-demo-2', {});
const BOLETA_CONCILIADA = boleta('bol-demo-3', {
  companiaId: 903, companiaNombre: EMPRESAS_DEMO[2], estado: 'conciliada', fechaPago: '2026-10-14',
  conciliadaEn: '2026-10-15T16:00:00.000Z', conciliadaPorNombre: NOMBRES_DEMO[2], createdAt: '2026-10-14T15:00:00.000Z',
});

export const CONCILIACION_BOLETAS_DEMO = { siguienteCursor: null, items: [BOLETA_SIN_CUADRAR, BOLETA_CUADRA, BOLETA_CONCILIADA] };

export const CONCILIACION_DETALLE_DEMO: Record<string, unknown> = {
  'bol-demo-1': { ...BOLETA_SIN_CUADRAR, filasOmitidas: 0, comprobante: null, lineas: [
    linea(1, DATOS_DEMO.placas[0], 485000, { companiaSoatNombre: EMPRESAS_DEMO[1] }),
    linea(2, DATOS_DEMO.placas[1], 505000, { resultado: 'valor_distinto', valorSoat: 485000, companiaSoatNombre: EMPRESAS_DEMO[1],
      detalle: 'El portal declara $ 505.000 y FLITO pagó $ 485.000.' }),
  ] },
  'bol-demo-2': { ...BOLETA_CUADRA, filasOmitidas: 0, comprobante: null, lineas: [
    linea(3, DATOS_DEMO.placas[0], 485000), linea(4, DATOS_DEMO.placas[2], 485000),
  ] },
  'bol-demo-3': { ...BOLETA_CONCILIADA, filasOmitidas: 0, comprobante: null, lineas: [
    linea(5, DATOS_DEMO.placas[1], 485000, { companiaSoatNombre: EMPRESAS_DEMO[2], conciliadaEn: '2026-10-15T16:00:00.000Z' }),
    linea(6, DATOS_DEMO.placas[2], 485000, { companiaSoatNombre: EMPRESAS_DEMO[2], conciliadaEn: '2026-10-15T16:00:00.000Z' }),
  ] },
};

// ── Bolsas ───────────────────────────────────────────────────────────────────

function bolsaCliente(c: number, saldo: number, nivel: string, porcentaje: number | null, entradas: number, salidas: number) {
  return {
    id: `bolsa-demo-${c}`, companiaId: 900 + c, companiaNombre: EMPRESAS_DEMO[c - 1], saldo, ultimaRecargaValor: 5000000,
    ultimaRecargaEn: '2026-10-02T15:00:00.000Z', nivel, porcentaje, entradasPeriodo: entradas, salidasPeriodo: salidas,
  };
}

export const BOLSAS_RIESGO_DEMO = [
  bolsaCliente(1, 3250000, 'normal', 65, 5000000, 1750000),
  bolsaCliente(2, 420000, 'critico', 8, 5000000, 4580000),
];

export const BOLSAS_DEMO = {
  consolidado: { clientes: 2, saldoTotal: 3670000 },
  alertas: {
    saldo: [{ tipo: 'saldo', nivel: 'critico', companiaId: 902, companiaNombre: EMPRESAS_DEMO[1], saldo: 420000, porcentaje: 8,
      mensaje: `${EMPRESAS_DEMO[1]} tiene el 8 % de su última recarga.` }],
    conciliacion: { soportesSinTramite: 0, movimientosSinSoporte: 0, boletasSinComprobante: 1 },
  },
  transito: [{
    id: 'bt-demo-1', nombre: 'Bolsa tránsito Manizales (demo)', saldo: 2100000, ultimaCargaValor: 3000000,
    ultimaCargaEn: '2026-10-05T15:00:00.000Z', nivel: 'normal', porcentaje: 70, deuda: 0, totalCargado: 3000000, totalConsumido: 900000,
    cobertura: [{ organismoCodigo: '17001000', organismoNombre: ORGANISMOS_REALES[0], concepto: 'derecho' }],
  }],
  extracto: {
    companiaId: 901, saldoActual: 3250000, totalEntradas: 5000000, totalSalidas: 1750000,
    porOrganismo: [{ clave: ORGANISMOS_REALES[0], entradas: 0, salidas: 1750000, movimientos: 3 }],
    porConcepto: [{ clave: 'soat', entradas: 0, salidas: 970000, movimientos: 2 }, { clave: 'derecho', entradas: 0, salidas: 780000, movimientos: 1 }],
  },
  movimientos: [
    { id: 'mov-demo-1', companiaId: 901, tipo: 'entrada', origen: 'recarga', concepto: null, organismoCodigo: null, tramiteId: null, idFlit: null,
      valor: 5000000, saldoResultante: 5000000, periodo: '2026-10', fecha: '2026-10-02', observacion: 'Recarga de octubre', soporteId: 'sop-demo-1',
      registradoPorNombre: NOMBRES_DEMO[2], createdAt: '2026-10-02T15:00:00.000Z' },
    { id: 'mov-demo-2', companiaId: 901, tipo: 'salida', origen: 'conciliacion', concepto: 'soat', organismoCodigo: null, tramiteId: 'tr-demo-1', idFlit: 'FLIT-DEMO-1',
      valor: 970000, saldoResultante: 4030000, periodo: '2026-10', fecha: '2026-10-15', observacion: null, soporteId: null,
      registradoPorNombre: NOMBRES_DEMO[2], createdAt: '2026-10-15T16:00:00.000Z' },
    { id: 'mov-demo-3', companiaId: 901, tipo: 'salida', origen: 'automatico', concepto: 'derecho', organismoCodigo: '17001000', tramiteId: 'tr-demo-2', idFlit: 'FLIT-DEMO-2',
      valor: 780000, saldoResultante: 3250000, periodo: '2026-10', fecha: '2026-10-18', observacion: null, soporteId: 'sop-demo-2',
      registradoPorNombre: NOMBRES_DEMO[2], createdAt: '2026-10-18T16:00:00.000Z' },
  ],
};

// ── Tarifas ──────────────────────────────────────────────────────────────────

const USUARIO_TARIFAS_DEMO = { id: 1, nombre: NOMBRES_DEMO[2] };

function filaTarifa(concepto: string, tipoTramite: string | null, valor: number | null, i: number) {
  return {
    concepto, tipoTramite, vigenciaId: valor === null ? null : `vig-demo-${i}`, valor,
    vigenteDesde: valor === null ? null : '2026-09-01T15:00:00.000Z', fijadoPor: valor === null ? null : USUARIO_TARIFAS_DEMO,
    ...(concepto === 'logistica' ? { flitoGestionaLogistica: true } : {}),
  };
}

export const TARIFAS_DEMO = {
  /** Vigencias abiertas por compañía: 901 tiene 3 de 4, 902 ninguna, 903 las 4. */
  abiertas: [
    ...[1, 2, 3].map((i) => ({ id: `vig-demo-${i}`, companiaId: 901 })),
    ...[4, 5, 6, 7].map((i) => ({ id: `vig-demo-${i}`, companiaId: 903 })),
  ],
  vista901: {
    companiaId: 901, companiaNombre: EMPRESAS_DEMO[0], capacidades: { editar: true, verHistorial: true },
    tarifas: [
      filaTarifa('tramite_digital', 'MATRICULA', 180000, 1), filaTarifa('tramite_digital', 'TRASPASO', 150000, 2),
      filaTarifa('tramite_digital', 'OTROS', 90000, 3), filaTarifa('logistica', null, null, 0),
    ],
  },
  historial: [
    { id: 'vig-demo-2', concepto: 'tramite_digital', tipoTramite: 'TRASPASO', valor: 150000, vigenteDesde: '2026-09-01T15:00:00.000Z',
      vigenteHasta: null, fijadoPor: USUARIO_TARIFAS_DEMO, fijadoEn: '2026-09-01T15:00:00.000Z', cerradoPor: null, cerradoEn: null },
    { id: 'vig-demo-0', concepto: 'tramite_digital', tipoTramite: 'TRASPASO', valor: 140000, vigenteDesde: '2026-06-01T15:00:00.000Z',
      vigenteHasta: '2026-09-01T15:00:00.000Z', fijadoPor: USUARIO_TARIFAS_DEMO, fijadoEn: '2026-06-01T15:00:00.000Z',
      cerradoPor: USUARIO_TARIFAS_DEMO, cerradoEn: '2026-09-01T15:00:00.000Z' },
  ],
};

// ── Servicios adicionales ────────────────────────────────────────────────────

function tipoServicio(id: string, nombre: string, descripcion: string | null, valor: number, baja: string | null = null) {
  return {
    id, nombre, descripcion, valor, activo: baja === null, dadoDeBajaEn: baja, dadoDeBajaPorId: baja ? 1 : null,
    creadoEn: '2026-08-01T15:00:00.000Z', creadoPorId: 1, actualizadoEn: '2026-10-01T15:00:00.000Z', actualizadoPorId: 1,
  };
}

/** Catálogo demo: los tres iniciales (uno aún a $ 0, «Por tarifar»), uno añadido y uno dado de baja. */
export const SERVICIOS_ADICIONALES_DEMO = {
  activos: [
    tipoServicio('sa-demo-1', 'Derecho de petición', 'Radicación y seguimiento ante el organismo.', 0),
    tipoServicio('sa-demo-2', 'Diagnóstico', 'Revisión del estado del vehículo antes del trámite.', 60000),
    tipoServicio('sa-demo-3', 'Paz y salvo de impuestos', 'Certificado de la secretaría de hacienda.', 35000),
    tipoServicio('sa-demo-4', 'Traslado de cuenta', null, 80000),
  ],
  bajas: [tipoServicio('sa-demo-5', 'Copia de licencia', null, 20000, '2026-09-15T15:00:00.000Z')],
};

// ── Reporte de costos y Gastos diarios ───────────────────────────────────────

const SIN_DOCUMENTAL = {
  origenes: { tramiteDigital: 'tarifa', logistica: 'tarifa' },
  valorDocumental: { tramiteDigital: null, logistica: null, serviciosAdicionales: null },
};

function filaCostos(i: number, p: Record<string, unknown>) {
  const placa = DATOS_DEMO.placas[(i - 1) % 3];
  return {
    tramiteId: `tr-demo-${i}`, idFlit: `FLIT-DEMO-${i}`, placa, estado: 'Aprobado', empresa: EMPRESAS_DEMO[(i - 1) % 3],
    vin: DATOS_DEMO.vins[(i - 1) % 3], marca: 'MARCA DEMO', linea: 'LÍNEA DEMO', tipoTramite: i % 2 ? 'Traspaso' : 'Matrícula',
    fechaAprobacion: `2026-10-${String(5 + i).padStart(2, '0')}T15:00:00.000Z`, fechaCreacion: '2026-10-01T15:00:00.000Z',
    soat: 485000, impuesto: 312000, derechoTramite: 98000, logistica: 45000, tramiteDigital: 150000, gmf: 3760, total: 1093760,
    sellada: false, estadoLiquidacion: null, noConfigurados: [], sinRecibo: [], pendientesPago: [], autogestionados: [], noAplican: [],
    estadoFacturacion: 'no_enviado', facturaNumero: null, facturaRequiereRevision: false, soatConciliado: false,
    boletaReferencia: null, soatConciliadoEn: null,
    titularNombres: null, titularApellidos: null, titularRazonSocial: EMPRESAS_DEMO[(i - 1) % 3], titularTipoDocumento: 'NIT',
    titularDocumento: DATOS_DEMO.nits[(i - 1) % 3], organismoCodigo: '17001000', organismoNombre: ORGANISMOS_REALES[0],
    mes: '2026-10', trimestre: '2026-T4', totalReintegro: 943760, totalServicio: 150000, serviciosAdicionales: null,
    serviciosAdicionalesCantidad: 0, logisticaViajesCantidad: 1, ...SIN_DOCUMENTAL, ...p,
  };
}

const UNIDAD_COSTOS = {
  soat: 485000, impuesto: 312000, derechoTramite: 98000, logistica: 45000, tramiteDigital: 150000, gmf: 3760,
  total: 1093760, filasIncompletas: 0, totalReintegro: 943760, totalServicio: 150000, serviciosAdicionales: 0,
};
type Totales = typeof UNIDAD_COSTOS;
const sumar = (...ts: Totales[]): Totales => Object.fromEntries(
  Object.keys(UNIDAD_COSTOS).map((k) => [k, ts.reduce((a, t) => a + t[k as keyof Totales], 0)]),
) as Totales;
/** Por cliente: Norte lleva dos trámites; Sur uno sin recibo de impuesto; Centro uno con un servicio adicional. */
const TOTALES_CLIENTE: Totales[] = [
  sumar(UNIDAD_COSTOS, UNIDAD_COSTOS),
  { ...UNIDAD_COSTOS, impuesto: 0, totalReintegro: 631760, total: 781760, filasIncompletas: 1 },
  { ...UNIDAD_COSTOS, serviciosAdicionales: 60000, totalServicio: 210000, total: 1153760 },
];
const TOTALES_COSTOS = sumar(...TOTALES_CLIENTE);

export const REPORTE_COSTOS_DEMO = {
  total: 4, page: 1, pageSize: 50, totales: TOTALES_COSTOS,
  resumen: { listo: 1, incompleto: 1, porFacturar: 1, facturado: 1 },
  items: [
    filaCostos(1, {}),
    filaCostos(2, { impuesto: null, sinRecibo: ['Impuesto'], total: null, totalReintegro: null }),
    filaCostos(3, { sellada: true, estadoLiquidacion: 'liquidado', serviciosAdicionales: 60000, serviciosAdicionalesCantidad: 1,
      totalServicio: 210000, total: 1153760 }),
    filaCostos(4, { sellada: true, estadoLiquidacion: 'facturado', estadoFacturacion: 'aceptado', facturaNumero: 'DEMO-104',
      placa: DATOS_DEMO.placas[0], empresa: EMPRESAS_DEMO[0], titularRazonSocial: EMPRESAS_DEMO[0], titularDocumento: DATOS_DEMO.nits[0],
      vin: DATOS_DEMO.vins[0], soatConciliado: true, boletaReferencia: 'BOL-DEMO-3', soatConciliadoEn: '2026-10-15T16:00:00.000Z' }),
  ],
};

/** Elegibilidad para enviar a facturación electrónica: solo lo facturado (congelado) es elegible. */
export function elegibilidadDemo(ids: string[]) {
  const facturados = new Set(REPORTE_COSTOS_DEMO.items.filter((f) => f.estadoLiquidacion === 'facturado').map((f) => f.tramiteId));
  const items = ids.map((tramiteId) => ({
    tramiteId, companiaId: 901, elegible: facturados.has(tramiteId),
    motivos: facturados.has(tramiteId) ? [] : [{ motivo: 'liquidacion_no_facturada', detalle: 'La liquidación todavía no está facturada.' }],
  }));
  const elegibles = items.filter((i) => i.elegible).length;
  return {
    items,
    resumen: {
      total: items.length, elegibles, noElegibles: items.length - elegibles, anterioresAlCorte: 0,
      porMotivo: { liquidacion_no_facturada: items.length - elegibles, documentacion_incompleta: 0, anterior_al_corte: 0 },
    },
  };
}

export const REPORTE_FACTURACION_DEMO = {
  total: 1, no_enviado: 3, encolado: 0, en_proceso: 0, emitido: 0, aceptado: 1, rechazado: 0, anulado: 0, fallido: 0,
};

export const REPORTE_FACETAS_DEMO = {
  estados: ['Aprobado', 'En trámite'],
  empresas: EMPRESAS_DEMO.map((e, i) => ({ valor: String(901 + i), nombre: e })),
  tipos: ['Matrícula', 'Traspaso'],
  organismos: [{ valor: '17001000', nombre: ORGANISMOS_REALES[0] }],
};

export const REPORTE_CONSOLIDADO_DEMO = {
  periodo: 'mes', totales: TOTALES_COSTOS,
  items: EMPRESAS_DEMO.map((e, i) => ({
    ...TOTALES_CLIENTE[i], clienteClave: String(901 + i), clienteNombre: e, periodo: '2026-10', tramites: i === 0 ? 2 : 1,
  })),
};

/** Gastos diarios demo: 30 días (22-sep a 21-oct-2026), sin gasto los domingos; cantidades y valores sintéticos. */
export const GASTOS_DIARIOS_DEMO = (() => {
  const celda = (cantidad: number, unitario: number) => ({ cantidad, valor: String(cantidad * unitario) });
  const UNITARIO = { soat: 485000, impuesto: 312000, derecho: 98000, logistica: 45000, serviciosAdicionales: 35000 } as const;
  const serie = Array.from({ length: 30 }, (_, i) => {
    const fecha = new Date(Date.UTC(2026, 8, 22 + i));
    const dia = fecha.toISOString().slice(0, 10);
    const n = fecha.getUTCDay() === 0 ? 0 : 1 + ((i * 7) % 4);
    return {
      dia,
      soat: celda(n, UNITARIO.soat), impuesto: celda(Math.max(0, n - 1), UNITARIO.impuesto), derecho: celda(n, UNITARIO.derecho),
      logistica: celda(i % 3 === 0 ? n : 0, UNITARIO.logistica), serviciosAdicionales: celda(i % 5 === 0 ? 1 : 0, UNITARIO.serviciosAdicionales),
    };
  });
  const cats = ['soat', 'impuesto', 'derecho', 'logistica', 'serviciosAdicionales'] as const;
  const totales = Object.fromEntries(cats.map((c) => [c, {
    cantidad: serie.reduce((a, d) => a + d[c].cantidad, 0), valor: String(serie.reduce((a, d) => a + Number(d[c].valor), 0)),
  }])) as Record<(typeof cats)[number], { cantidad: number; valor: string }>;
  const base = cats.reduce((a, c) => a + Number(totales[c].valor), 0);
  const gmf = Math.round(base * 0.004);
  return {
    desde: '2026-09-22', hasta: '2026-10-21', serie,
    totales: { ...totales, base: String(base), gmfEstimado: String(gmf), total: String(base + gmf) },
  };
})();

/** Usuario de sesión de las capturas del área Facturación (HU #13770): Administrador demo. */
export const NOMBRE_ADMIN_DEMO = NOMBRES_DEMO[2];

/** Todos los fixtures que pinta alguna captura. La prueba de datos ficticios los recorre. */
export const FIXTURES_DEMO: Record<string, unknown> = {
  MI_RUTA_DEMO,
  LT_DEMO,
  RECEPTOR_DEMO: { receptorNombre: RECEPTOR_DEMO.nombre, receptorDocumento: RECEPTOR_DEMO.documento },
  CLIENTES_DEMO,
  SIIGO_MAPEO_DEMO,
  SIIGO_COMPUERTA_DEMO,
  SIIGO_VALIDACION_DEMO,
  SIIGO_VALIDACION_DETALLE_DEMO,
  SIIGO_BANDEJA_DEMO,
  // `porFuente.correo` es un conteo de la fuente «correo» (número), no un correo: va fuera del recorrido.
  SIIGO_RESUMEN_DEMO: { ...SIIGO_RESUMEN_DEMO, porFuente: null },
  SIIGO_FRENO_DEMO,
  SIIGO_LINEA_TIEMPO_DEMO,
  SIIGO_TERCEROS_DEMO,
  // El `nombre` de un producto de Siigo no es de una persona: se recorre con otra clave.
  // El `nombre` de un archivo no es de una persona: se recorre con otra clave.
  COMPROBANTES_DEMO: COMPROBANTES_DEMO.items.map(({ archivo, ...c }) => ({ ...c, archivoNombre: archivo.nombre })),
  COMPROBANTE_DETALLE_DEMO: (({ archivo, ...c }) => ({ ...c, archivoNombre: archivo.nombre }))(COMPROBANTE_DETALLE_DEMO),
  CONCILIACION_BOLETAS_DEMO,
  CONCILIACION_DETALLE_DEMO,
  BOLSAS_RIESGO_DEMO,
  // El `nombre` de una bolsa de tránsito no es de una persona: se recorre con otra clave.
  BOLSAS_DEMO: { ...BOLSAS_DEMO, transito: BOLSAS_DEMO.transito.map(({ nombre, ...b }) => ({ ...b, nombreBolsa: nombre })) },
  TARIFAS_DEMO,
  // El `nombre` de un tipo de servicio no es de una persona: se recorre con otra clave.
  SERVICIOS_ADICIONALES_DEMO: [...SERVICIOS_ADICIONALES_DEMO.activos, ...SERVICIOS_ADICIONALES_DEMO.bajas]
    .map(({ nombre, ...t }) => ({ ...t, nombreServicio: nombre })),
  REPORTE_COSTOS_DEMO,
  REPORTE_CONSOLIDADO_DEMO,
  GASTOS_DIARIOS_DEMO,
  // `nombre` de una faceta es el de una empresa demo o el de un organismo (nombre real permitido).
  REPORTE_FACETAS_DEMO: { ...REPORTE_FACETAS_DEMO, organismos: REPORTE_FACETAS_DEMO.organismos.map(({ nombre, ...o }) => ({ ...o, organismo: nombre })) },
  SIIGO_PRODUCTOS_DEMO: SIIGO_PRODUCTOS_DEMO.items.map(({ nombre, ...p }) => ({ ...p, nombreProducto: nombre })),
};

// ── Interceptación de /api ───────────────────────────────────────────────────

/** `contentType` distinto de JSON (p. ej. la imagen de un comprobante): `body` se envía tal cual. */
export type RespuestaDemo = { status?: number; body: unknown; contentType?: string };
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
    if (r.contentType) return route.fulfill({ status: r.status ?? 200, contentType: r.contentType, body: r.body as string });
    return route.fulfill({ status: r.status ?? 200, contentType: 'application/json', body: JSON.stringify(r.body) });
  });
  return registro;
}
