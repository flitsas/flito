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

/** Proveedores (gestores) de SOAT ficticios del área Corredor SOAT (HU #13771). Lista aparte: los fixtures de
 *  Facturación recorren `EMPRESAS_DEMO` entera y sus capturas ya están tomadas. */
export const ASEGURADORAS_DEMO = ['Aseguradora Demo Uno', 'Aseguradora Demo Dos'] as const;

/** Organismos de tránsito: nombre real permitido (entidad pública). */
export const ORGANISMOS_REALES = ['Secretaría de Movilidad de Manizales', 'Secretaría de Movilidad de Bogotá'] as const;

export const DATOS_DEMO = {
  placas: ['ZZA101', 'ZZB202', 'ZZC303', 'ZZD404'],
  cedulas: ['9900000101', '9900000202', '9900000303'],
  nits: ['999000001-7', '999000002-5', '999000003-3'],
  telefonos: ['3000000101', '3000000102', '3000000103'],
  correos: ['mensajero@ejemplo.test', 'norte@ejemplo.test', 'sur@ejemplo.test', 'ana.demo@ejemplo.test', 'carlos.demo@ejemplo.test', 'laura.demo@ejemplo.test', 'cuenta-servicio-demo@ejemplo.test'],
  vins: ['9ZZDEMO0000000101', '9ZZDEMO0000000202', '9ZZDEMO0000000303', '9ZZDEMO0000000404'],
  nombres: NOMBRES_DEMO as readonly string[],
  empresas: [...EMPRESAS_DEMO, ...ASEGURADORAS_DEMO] as readonly string[],
  /** `nombre`/`name` en las respuestas de clientes es el de una compañía o el de una persona: ambos demo. */
  nombresOEmpresas: [...NOMBRES_DEMO, ...EMPRESAS_DEMO, ...ASEGURADORAS_DEMO] as readonly string[],
  /** Actor de la Bitácora: una persona demo o el actor automático `sistema` (no es un dato personal). */
  actores: [...NOMBRES_DEMO, 'sistema'] as readonly string[],
  /** `documento` de un tercero: cédula si es persona, NIT si es compañía. Ambos del registro. */
  documentos: ['9900000101', '9900000202', '9900000303', '999000001-7', '999000002-5', '999000003-3'] as readonly string[],
  // ── Área Super Admin (HU #13774) ──
  /** Usuarios de acceso (login) y cuentas de integración: todos llevan «demo»; los que son correo, de `ejemplo.test`. */
  usuarios: ['ana.demo', 'carlos.demo', 'laura.demo', 'andres.demo', 'siigo.pruebas.demo@ejemplo.test', 'siigo.produccion.demo@ejemplo.test'] as readonly string[],
  /** IP de origen del Log de accesos PII: solo rangos de documentación (RFC 5737), que no se enrutan en internet. */
  ips: ['192.0.2.10', '192.0.2.24', '198.51.100.7'] as readonly string[],
  /** Navegador del Log de accesos PII: texto sintético, nunca el de un equipo real. */
  agentesUsuario: ['Navegador Demo 1.0 (equipo de oficina demo)'] as readonly string[],
} as const;

/**
 * Claves de los fixtures que contienen un dato personal o identificador, y la categoría del registro
 * a la que deben pertenecer. La prueba recorre los fixtures y exige que cada valor bajo una de estas
 * claves salga de `DATOS_DEMO`.
 */
export const CLAVES_SENSIBLES: Record<string, keyof typeof DATOS_DEMO> = {
  placa: 'placas',
  phone: 'telefonos',
  aseguradora: 'empresas',
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
  // Área Corredor SOAT (HU #13771)
  nombreCompleto: 'nombres',
  numeroDocumento: 'documentos',
  empresaNit: 'nits',
  nitMonitoreado: 'nits',
  alias: 'empresas',
  proveedorSoatNombre: 'empresas',
  enviadoPorNombre: 'nombres',
  solicitadoPorNombre: 'nombres',
  titular: 'nombres',
  placaSugerida: 'placas',
  actorNombre: 'actores',
  // Área Corredor Impuestos (HU #13772)
  compradorNombre: 'nombres',
  compradorDocumento: 'cedulas',
  empresa: 'empresas',
  modificadoPor: 'nombres',
  certificadoPorNombre: 'nombres',
  // Área Mensajero y Logística (HU #13773)
  propietario: 'nombres',
  companiaNit: 'nits',
  mensajeroNombre: 'nombres',
  // Área Super Admin (HU #13774)
  username: 'usuarios',
  docNumber: 'cedulas',
  ipOrigen: 'ips',
  ip: 'ips',
  userAgent: 'agentesUsuario',
  cuentaServicio: 'correos',
  cedulaDemo: 'cedulas',
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

// ── Bolsas: expediente documental de la compañía (HU #13892) ─────────────────
// Compañía 901 (la bolsa demo del detalle). Fechas respecto del reloj demo (21-oct-2026): la Cámara
// vigente, el RUT vencido, el certificado sin fecha leída, la cédula cargada y el adicional pendiente.

function versionDocDemo(tipo: string, n: number, extra: Record<string, unknown>) {
  return {
    id: `00000000-0000-4000-8000-0000000009${String(n).padStart(2, '0')}`, tipo, version: 1, estado: 'valido',
    fechaExpedicion: null, fechaOrigen: null, venceEl: null, fechaManual: null,
    mime: 'application/pdf', tamanoBytes: 245000, cargadoPor: NOMBRES_DEMO[2], cargadoEn: '2026-10-06T15:20:00.000Z', ...extra,
  };
}

export const EXPEDIENTE_BOLSA_DEMO = {
  companiaId: 901,
  completo: false,
  documentos: [
    { tipo: 'camara_comercio', opcional: false, estado: 'valido', tieneHistorial: true,
      vigente: versionDocDemo('camara_comercio', 1, { fechaExpedicion: '2026-10-05', venceEl: '2026-11-04', fechaOrigen: 'ocr' }) },
    { tipo: 'rut', opcional: false, estado: 'vencido', tieneHistorial: true,
      vigente: versionDocDemo('rut', 2, { estado: 'vencido', version: 2, fechaExpedicion: '2026-09-10', venceEl: '2026-10-10', fechaOrigen: 'ocr' }) },
    { tipo: 'cedula_representante', opcional: false, estado: 'valido', tieneHistorial: true, vigente: versionDocDemo('cedula_representante', 3, {}) },
    { tipo: 'certificado_bancario', opcional: false, estado: 'no_validado', tieneHistorial: true,
      vigente: versionDocDemo('certificado_bancario', 4, { estado: 'no_validado', cargadoEn: '2026-10-20T14:05:00.000Z' }) },
    { tipo: 'adicional', opcional: true, estado: 'pendiente', tieneHistorial: false, vigente: null },
  ],
};

/**
 * E6 `POST /bolsas-documentos/estado-lote` (HU #13893): chip «Expediente» del listado. La 901 cuadra
 * con su expediente (RUT vencido, certificado sin validar → «Docs pendientes»); la 902 está completa.
 */
export const ESTADO_LOTE_BOLSAS_DEMO = {
  estados: [
    { companiaId: 901, completo: false,
      estados: { camara_comercio: 'valido', rut: 'vencido', cedula_representante: 'valido', certificado_bancario: 'no_validado' } },
    { companiaId: 902, completo: true,
      estados: { camara_comercio: 'valido', rut: 'valido', cedula_representante: 'valido', certificado_bancario: 'valido' } },
  ],
};

// ── Tarifas ──────────────────────────────────────────────────────────────────

const USUARIO_TARIFAS_DEMO = { id: 1, nombre: NOMBRES_DEMO[2] };

function filaTarifa(concepto: string, tipoTramite: string | null, valor: number | null, i: number) {
  return {
    concepto, tipoTramite, vigenciaId: valor === null ? null : `vig-demo-${i}`, valor,
    vigenteDesde: valor === null ? null : '2026-09-01T15:00:00.000Z', fijadoPor: valor === null ? null : USUARIO_TARIFAS_DEMO,
    ...(concepto === 'logistica_cliente' ? { flitoGestionaLogistica: true } : {}),
  };
}

export const TARIFAS_DEMO = {
  /** Vigencias abiertas por compañía: 901 tiene 4 de 5 (falta Entrega a FLIT), 902 ninguna, 903 las 5. */
  abiertas: [
    ...[1, 2, 3, 8].map((i) => ({ id: `vig-demo-${i}`, companiaId: 901 })),
    ...[4, 5, 6, 7, 9].map((i) => ({ id: `vig-demo-${i}`, companiaId: 903 })),
  ],
  vista901: {
    companiaId: 901, companiaNombre: EMPRESAS_DEMO[0], capacidades: { editar: true, verHistorial: true },
    tarifas: [
      filaTarifa('tramite_digital', 'MATRICULA', 180000, 1), filaTarifa('tramite_digital', 'TRASPASO', 150000, 2),
      filaTarifa('tramite_digital', 'OTROS', 90000, 3), filaTarifa('logistica_cliente', null, 38000, 8), filaTarifa('logistica_flit', null, null, 0),
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

// ── Área Corredor SOAT (HU #13771) ───────────────────────────────────────────
// Trámites `FLIT-DEMO-…`, pólizas `DEMO-POL-…`, comparendos `99999…`: identificadores sintéticos.
// Vehículos: placas, VIN y compradores del registro; marcas y organismos con su nombre real.

const P = DATOS_DEMO.placas;
const V = DATOS_DEMO.vins;
const C = DATOS_DEMO.cedulas;
const N = DATOS_DEMO.nits;

/** `GET /api/flito/parametrizacion/proveedores-soat`: gestores de SOAT. */
export const PROVEEDORES_SOAT_DEMO = [
  { id: 'prov-demo-1', nombre: ASEGURADORAS_DEMO[0], estrategia: 'portal', umbralOcr: 0.85, slaHoras: 24, activo: true },
  { id: 'prov-demo-2', nombre: ASEGURADORAS_DEMO[1], estrategia: 'correo', umbralOcr: 0.9, slaHoras: 48, activo: true },
];

// ── Tablero ──
export const TABLERO_DEMO = {
  soat: { pendiente: 4, solicitado: 6, con_novedad: 1, pagado: 12 },
  impuestos: { pendiente: 3, solicitado: 5, con_novedad: 0, pagado: 9 },
  revisionesPendientes: { soat: 2, impuestos: 1 },
  estancados: { soat: 1, impuestos: 0 },
  diferenciasDeValor: 1,
  compuertaHabilitados: 3,
  alertas: { borrador_5d: 2, sin_aprobar_ans: 0, soat_sin_gestion: 1, impuesto_sin_gestion: 0 },
};

// ── Bitácora ──
export const BITACORA_DEMO = [
  { id: 5, resource: 'flito_soat', resourceId: 'soat-demo-3', action: 'update', actorNombre: NOMBRES_DEMO[2], actorId: 1, detalle: 'Pago confirmado por factura', creadoEn: '2026-10-21T14:40:00Z' },
  { id: 4, resource: 'flito_tramite', resourceId: 'tra-demo-2', action: 'update', actorNombre: 'sistema', actorId: null, detalle: 'Compuerta habilitada', creadoEn: '2026-10-21T14:05:00Z' },
  { id: 3, resource: 'flito_impuesto', resourceId: 'imp-demo-2', action: 'update', actorNombre: NOMBRES_DEMO[3], actorId: 2, detalle: 'Recibo del impuesto cargado', creadoEn: '2026-10-21T13:30:00Z' },
  { id: 2, resource: 'flito_revision', resourceId: 'rev-demo-1', action: 'create', actorNombre: 'sistema', actorId: null, detalle: 'Documento enviado a revisión por baja confianza', creadoEn: '2026-10-21T13:20:00Z' },
  { id: 1, resource: 'flito_tramite', resourceId: 'tra-demo-1', action: 'create', actorNombre: 'sistema', actorId: null, detalle: 'Trámite leído de FLIT', creadoEn: '2026-10-21T12:00:00Z' },
];

// ── Revisiones OCR ──
const campo = (valor: string, confianza: number) => ({ valor, confianza, confiable: confianza >= 0.85 });
export const REVISIONES_DEMO = [
  {
    id: 'rev-demo-1', modulo: 'soat', motivo: 'confianza_insuficiente',
    detalle: 'Algunos campos quedaron bajo el umbral de confianza del gestor.', registroId: null, placaSugerida: P[0],
    extraccion: {
      placa: campo(P[0], 0.97), vin: campo(V[0], 0.93), numeroPoliza: campo('DEMO-POL-0001', 0.62),
      vigenciaDesde: campo('2026-10-15', 0.9), vigenciaHasta: campo('2027-10-14', 0.9), valorTotal: campo('740800', 0.88),
      aseguradora: campo(ASEGURADORAS_DEMO[0], 0.71),
    },
    resuelto: false, creadoEn: '2026-10-21T13:20:00Z', soporte: { id: 'sop-demo-1', nombreArchivo: `poliza-${P[0]}.pdf` },
  },
  {
    id: 'rev-demo-2', modulo: 'soat', motivo: 'llave_no_cruza',
    detalle: 'La placa leída no corresponde a ningún SOAT de la cola.', registroId: null, placaSugerida: P[1],
    extraccion: { placa: campo(P[1], 0.95), vin: campo(V[1], 0.9), numeroPoliza: campo('DEMO-POL-0002', 0.91) },
    resuelto: false, creadoEn: '2026-10-21T11:05:00Z', soporte: { id: 'sop-demo-2', nombreArchivo: `poliza-${P[1]}.pdf` },
  },
];
export const REVISION_CAMPOS_SOAT = ['placa', 'vin', 'numeroPoliza', 'vigenciaDesde', 'vigenciaHasta', 'valorTotal', 'aseguradora'];
/** Candidatos del selector «Trámite contra el que se concilia» (lista corta de la cola SOAT). */
export const REVISION_CANDIDATOS_SOAT = [
  { id: 'soat-demo-1', vin: V[0], placa: P[0], marca: 'Chevrolet', linea: 'Onix' },
  { id: 'soat-demo-2', vin: V[2], placa: P[2], marca: 'Renault', linea: 'Duster' },
];
/** PDF mínimo del soporte (una página con texto «documento demo»). */
export const PDF_DEMO = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
  + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n'
  + '4 0 obj<</Length 52>>stream\nBT /F1 14 Tf 40 100 Td (Poliza SOAT - documento demo) Tj ET\nendstream endobj\n'
  + '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF';

// ── Comparendos ──
const FECHA_CONF = '2026-09-01T15:00:00Z';
export const COMPARENDOS_NITS_DEMO = [
  { id: 'nit-demo-1', nit: N[0], alias: EMPRESAS_DEMO[0], activo: true, creadoEn: FECHA_CONF, actualizadoEn: FECHA_CONF },
  { id: 'nit-demo-2', nit: N[1], alias: EMPRESAS_DEMO[1], activo: true, creadoEn: FECHA_CONF, actualizadoEn: FECHA_CONF },
];
export const COMPARENDOS_MUNICIPIOS_DEMO = [
  { id: 'mun-demo-1', codigoFuente: 'MANIZALES', nombre: 'Manizales', activo: true, creadoEn: FECHA_CONF, actualizadoEn: FECHA_CONF },
  { id: 'mun-demo-2', codigoFuente: 'BOGOTA', nombre: 'Bogotá', activo: true, creadoEn: FECHA_CONF, actualizadoEn: FECHA_CONF },
];
export const COMPARENDOS_CAUSALES_DEMO = [
  { id: 'cau-demo-1', nombre: 'Notificado al cliente', activo: true, orden: 1, creadoEn: FECHA_CONF, actualizadoEn: FECHA_CONF },
  { id: 'cau-demo-2', nombre: 'En descargos', activo: true, orden: 2, creadoEn: FECHA_CONF, actualizadoEn: FECHA_CONF },
];
export const COMPARENDOS_TOKEN_DEMO = { configurado: true, actualizadoEn: FECHA_CONF, actualizadoPor: { id: 1, nombre: NOMBRES_DEMO[2] }, keyVersion: 1 };
function comparendo(i: number, p: Record<string, unknown>) {
  return {
    id: `cmp-demo-${i}`, numeroComparendo: `9999900000000${i}`, nitMonitoreado: N[(i - 1) % 2], placa: P[(i - 1) % 3],
    codigoInfraccion: 'C02', descripcionInfraccion: 'Estacionar en sitio prohibido', fechaComparendo: '2026-09-12',
    fechaNotificacion: '2026-09-20', organismo: ORGANISMOS_REALES[0], municipioFuente: 'MANIZALES', municipioComparendo: 'MANIZALES',
    monto: '604100.00', estadoFuente: 'PENDIENTE DE PAGO', tipoRegistro: 'comparendo', numeroResolucion: null,
    origenMerge: 'ambos', vistoEnSimit: true, vistoEnMunicipal: true, estado: 'activo',
    primeraVistoEn: '2026-09-21T13:00:00Z', ultimoVistoEn: '2026-10-21T13:00:00Z', inactivadoEn: null, ultimoSyncRunId: 'run-demo-1',
    causalId: null, observacion: null, gestionActualizadaEn: null, gestionActualizadaPor: null,
    creadoEn: '2026-09-21T13:00:00Z', actualizadoEn: '2026-10-21T13:00:00Z', ...p,
  };
}
export const COMPARENDOS_REGISTROS_DEMO = {
  nextCursor: null,
  items: [
    comparendo(1, { causalId: 'cau-demo-1', observacion: 'Se avisó al concesionario por correo.' }),
    comparendo(2, { codigoInfraccion: 'C29', descripcionInfraccion: 'Exceder la velocidad permitida', monto: '1209100.00', organismo: ORGANISMOS_REALES[1], municipioFuente: 'BOGOTA', municipioComparendo: 'BOGOTA' }),
    comparendo(3, { origenMerge: 'simit', vistoEnMunicipal: false, estado: 'inactivo', inactivadoEn: '2026-10-14T13:00:00Z', estadoFuente: null }),
  ],
};
export const COMPARENDO_DETALLE_DEMO = {
  ...COMPARENDOS_REGISTROS_DEMO.items[0],
  eventos: [
    { id: 'ev-demo-1', tipo: 'primera_llegada', syncRunId: 'run-demo-0', detalle: null, ocurridoEn: '2026-09-21T13:00:00Z' },
  ],
};
const RESUMEN_SYNC = {
  modo: 'real', nitsProcesados: 2, llamadasSimitOk: 2, llamadasSimitError: 0, llamadasMunicipalOk: 4, llamadasMunicipalError: 0,
  upserts: 3, inactivados: 1, reactivados: 0, primeraLlegada: 1, itemsIgnorados: 0, nitsSinInactivacion: 0,
  abortadaPorTiempo: false, inactivacionOmitida: null,
};
export const COMPARENDOS_RUNS_DEMO = [
  { runId: 'run-demo-1', estado: 'completed', iniciadoEn: '2026-10-21T13:00:00Z', finalizadoEn: '2026-10-21T13:01:10Z', scopeNits: [N[0], N[1]], resumen: RESUMEN_SYNC, iniciadoPor: 1 },
  { runId: 'run-demo-0', estado: 'completed', iniciadoEn: '2026-10-14T13:00:00Z', finalizadoEn: '2026-10-14T13:01:02Z', scopeNits: [N[0], N[1]], resumen: RESUMEN_SYNC, iniciadoPor: 1 },
];

// ── Clientes y proveedores ──
export const CLIENTES_FICHA_DEMO = [
  // HU #13968: el proveedor ES el canal; la tercera compañía trae el aviso del permiso sin efecto.
  { gestorSoatSinTramite: { id: 'prov-demo-1', nombre: ASEGURADORAS_DEMO[0], activo: true }, permisoSinTramiteSinEfecto: false },
  { gestorSoatSinTramite: null, permisoSinTramiteSinEfecto: false },
  { gestorSoatSinTramite: null, permisoSinTramiteSinEfecto: true },
].map((canal, i) => ({
  id: 901 + i, name: EMPRESAS_DEMO[i], document: N[i], documentType: 'NIT',
  phone: DATOS_DEMO.telefonos[i], email: i < 2 ? DATOS_DEMO.correos[i + 1] : null, address: null,
  city: ['Manizales', 'Pereira', 'Bogotá'][i],
  // HU #13948: una compañía inactiva para que la captura muestre los dos chips de Estado.
  active: i !== 1,
  soatAutogestionable: i === 1, impuestosAutogestionable: false, logisticaAutogestionable: i === 2, logisticaPermiteParcial: i === 0,
  ...canal,
}));

// ── Gestión Trámites ──
function tramite(i: number, p: Record<string, unknown>) {
  const k = (i - 1) % 3;
  return {
    fechaCreacion: '2026-10-20T15:00:00Z', tramiteId: `tra-demo-${i}`, idFlit: `FLIT-DEMO-${100 + i}`, estado: 'Asignado', asignado: true,
    tipoTramite: 'Matricula', ciudad: 'Manizales', empresaExiste: true, empresaNit: N[k], secretariaEmparejada: true,
    transitoNombre: ORGANISMOS_REALES[0], facturaVentaFlitId: null, companiaNombre: EMPRESAS_DEMO[k], organismoNombre: ORGANISMOS_REALES[0],
    fuente: 'flit', vehiculo: { vin: V[k], placa: P[k], marca: 'Chevrolet', linea: 'Onix' },
    compradorPrincipal: { nombreCompleto: NOMBRES_DEMO[k], numeroDocumento: C[k], tipoDocumento: 'CC', correo: null },
    compradores: [{ nombreCompleto: NOMBRES_DEMO[k], numeroDocumento: C[k] }],
    soat: { id: `soat-demo-${i}`, estado: 'pendiente', proveedorSoatNombre: null, valorPagado: null },
    excepcionesAutogestion: [], soatAutogestionado: false,
    impuesto: { id: `imp-demo-${i}`, estado: 'pendiente', tieneFacturaVenta: false, valorPagado: null },
    listoParaEntregar: false, ...p,
  };
}
export const TRAMITES_DEMO = {
  items: [
    tramite(1, {}),
    tramite(2, {
      tipoTramite: 'Traspaso', ciudad: 'Pereira', fuente: 'flit2', facturaVentaFlitId: 'fac-demo-2',
      vehiculo: { vin: V[1], placa: P[1], marca: 'Renault', linea: 'Duster' },
      soat: { id: 'soat-demo-2', estado: 'pagado', proveedorSoatNombre: ASEGURADORAS_DEMO[0], valorPagado: 740800 },
      impuesto: { id: 'imp-demo-2', estado: 'pagado', tieneFacturaVenta: true, valorPagado: 120000 }, listoParaEntregar: true,
    }),
    tramite(3, {
      fechaCreacion: '2026-10-19T15:00:00Z', vehiculo: { vin: V[2], placa: P[2], marca: 'Mazda', linea: 'CX-30' },
      soat: { id: 'soat-demo-3', estado: 'solicitado', proveedorSoatNombre: ASEGURADORAS_DEMO[1], valorPagado: null },
      impuesto: { id: 'imp-demo-3', estado: 'solicitado', tieneFacturaVenta: true, valorPagado: null },
    }),
    // Secretaría sin emparejar: se puede marcar (para descargar), pero Solicitar y Entregar no la cuentan.
    tramite(4, {
      fechaCreacion: '2026-10-18T15:00:00Z', secretariaEmparejada: false, transitoNombre: 'STT Villamaría', organismoNombre: null,
      vehiculo: { vin: V[3], placa: P[3], marca: 'Kia', linea: 'Picanto' },
    }),
  ],
  total: 4, page: 1, pageSize: 50,
};
export const TRAMITES_FACETAS_DEMO = {
  estados: ['Asignado'], tramites: ['Matricula', 'Traspaso'], ciudades: ['Manizales', 'Pereira'], transitos: [...ORGANISMOS_REALES],
};
export const COMPANIAS_DEMO = CLIENTE_DEMO.map((c) => ({ id: c.id, nit: c.nit, nombre: c.name, logisticaAutogestionable: false }));
const hora = (iso: string) => iso;
export const SYNC_DEMO = {
  interruptores: {
    maestroFlit2: true,
    fuentes: [
      { fuente: 'flit1', encendido: true, actualizadoEn: hora('2026-10-20T13:00:00Z'), actualizadoPor: { id: 1, nombre: NOMBRES_DEMO[2] } },
      { fuente: 'flit2', encendido: true, actualizadoEn: hora('2026-10-20T13:00:00Z'), actualizadoPor: { id: 1, nombre: NOMBRES_DEMO[2] } },
    ],
  },
  estado1: { habilitada: true, motivoDeshabilitada: null, ultimaSincronizacion: '2026-10-21T14:58:00Z', hayTramites: true },
  estado2: {
    habilitada: true, motivoDeshabilitada: null, configurado: true, motivoSinConfigurar: null,
    ultimaExitosaEn: '2026-10-21T14:57:00Z', ultimoIntentoEn: '2026-10-21T14:57:00Z', atrasada: false, alerta: false, problema: null,
    piiEnmascarada: { tramites: 0, desde: null },
    automatica: { activa: true, intervaloMs: 300_000, proximaEn: '2026-10-21T15:02:00Z', enCurso: false, generadoEn: '2026-10-21T15:00:00Z' },
  },
  lectura1: { ultimaLecturaBuenaEn: '2026-10-21T14:58:00Z', proximaLecturaPrevistaEn: '2026-10-21T15:00:00Z', ultimoFallo: null },
};

// ── Cola SOAT ──
function soat(i: number, p: Record<string, unknown>) {
  const k = (i - 1) % 3;
  return {
    id: `soat-demo-${i}`, vin: V[k], placa: P[k], marca: 'Chevrolet', linea: 'Onix', cilindraje: '1389', carroceria: 'SEDAN',
    tipoServicio: 'Particular', estado: 'pendiente', esMultiplePropietario: false, companiaNombre: EMPRESAS_DEMO[k],
    organismoNombre: ORGANISMOS_REALES[0], proveedorSoatId: null, proveedorSoatNombre: null,
    compradores: [{ nombreCompleto: NOMBRES_DEMO[k], numeroDocumento: C[k], tipoDocumento: 'CC', orden: 0, porcentajeParticipacion: null }],
    tramitesFlit: [`FLIT-DEMO-${100 + i}`], tipoTramite: 'Matricula', fechaAprobacion: null, fechaCreacion: '2026-10-20T15:00:00Z',
    enviadoPorNombre: null, enviadoEn: null, pagadoEn: null, valorPagado: null, estancado: false, motivoRechazo: null,
    creadoEn: '2026-10-20T15:10:00Z', gestionOperaciones: false, ...p,
  };
}
export const SOAT_COLA_DEMO = [
  soat(1, {}),
  soat(2, {
    estado: 'pagado', marca: 'Renault', linea: 'Duster', proveedorSoatId: 'prov-demo-1', proveedorSoatNombre: ASEGURADORAS_DEMO[0],
    enviadoPorNombre: NOMBRES_DEMO[2], enviadoEn: '2026-10-20T16:00:00Z', pagadoEn: '2026-10-21T13:00:00Z', valorPagado: 740800,
  }),
  soat(3, {
    estado: 'solicitado', marca: 'Mazda', linea: 'CX-30', carroceria: 'SUV', proveedorSoatId: 'prov-demo-2', proveedorSoatNombre: ASEGURADORAS_DEMO[1],
    enviadoPorNombre: NOMBRES_DEMO[2], enviadoEn: '2026-10-21T12:00:00Z',
  }),
];
export const SOAT_FACETAS_DEMO = {
  companias: CLIENTE_DEMO.map((c) => ({ id: c.id, nombre: c.name })),
  organismos: [{ codigo: '17001', nombre: ORGANISMOS_REALES[0] }, { codigo: '11001', nombre: ORGANISMOS_REALES[1] }],
  proveedores: PROVEEDORES_SOAT_DEMO.map((p) => ({ id: p.id, nombre: p.nombre })),
};
/** Una solicitud del canal SOAT sin trámite guardada «por validar» (el RUNT no respondió). */
export const SOAT_POR_VALIDAR_DEMO = {
  id: 'inc-demo-1', estado: 'incompleta', vin: V[2], companiaId: 903, companiaNombre: EMPRESAS_DEMO[2],
  placa: null, marca: null, linea: null, titular: NOMBRES_DEMO[1], solicitadoPorNombre: NOMBRES_DEMO[3],
  solicitadoEn: '2026-10-21T13:40:00Z', intentos: 1, ultimoIntentoRuntEn: '2026-10-21T13:41:00Z', descarte: null, soatId: null,
};

/** `GET /api/flito/soat/cliente/companias` para un Cliente con enlace: su compañía, fija. */
export const SOAT_COMPANIAS_CANAL_DEMO = { fija: true, companias: [{ id: 901, nombre: EMPRESAS_DEMO[0] }] };
/** Documentos adicionales de un SOAT (detalle): `{ documentos }`. La URL es un marcador sin destino. */
export const SOAT_DOCUMENTOS_ADICIONALES_DEMO = {
  documentos: [
    { id: 'doc-demo-1', etiqueta: 'Tarjeta de propiedad', tipoContenido: 'application/pdf', tamanoBytes: 245760,
      subidoEn: '2026-10-20T16:05:00Z', subidoPorNombre: NOMBRES_DEMO[3], url: '/api/files?demo=1' },
  ],
};

// ── Área Corredor Impuestos (HU #13772) ─────────────────────────────────────
// Trámites `FLIT-DEMO-…` e impuestos `imp-demo-…`: identificadores sintéticos. Compradores, placas y VIN
// del registro; organismo con su nombre real (entidad pública) y marcas reales.

// ── Cola de Impuestos ──
function impuesto(i: number, p: Record<string, unknown>) {
  const k = (i - 1) % 3;
  return {
    id: `imp-demo-${i}`, tramiteId: `tra-demo-${i}`, idFlit: `FLIT-DEMO-${100 + i}`, placa: P[i - 1], vin: V[i - 1],
    marca: 'Chevrolet', linea: 'Onix', tipoTramite: 'Matricula', fechaAprobacion: null, fechaCreacion: '2026-10-20T15:00:00Z',
    estado: 'pendiente', compradorNombre: NOMBRES_DEMO[k], compradorDocumento: C[k], compradorTipoDocumento: 'CC',
    companiaNombre: EMPRESAS_DEMO[k], organismoCodigo: '17001', organismoNombre: ORGANISMOS_REALES[0],
    valorLiquidado: null, valorPagado: null, marcadoPorDiferencia: false, tieneFacturaVenta: true,
    enviadoPorNombre: null, enviadoEn: null, pagadoEn: null, estancado: false, motivoRechazo: null,
    creadoEn: '2026-10-20T15:10:00Z', gestionOperaciones: false, certificacion: null, liquidadoEn: null, documentos: null,
    analisisEstado: null, semaforo: null, motivoSemaforo: null, ...p,
  };
}
export const IMPUESTOS_COLA_DEMO = [
  impuesto(1, {}),
  impuesto(2, {
    estado: 'solicitado', marca: 'Renault', linea: 'Duster', enviadoPorNombre: NOMBRES_DEMO[2], enviadoEn: '2026-10-19T16:00:00Z',
    valorLiquidado: 412000, liquidadoEn: '2026-10-20T14:00:00Z', documentos: 'liquidacion',
    analisisEstado: 'completado', semaforo: 'naranja',
  }),
  impuesto(3, {
    estado: 'pagado', marca: 'Mazda', linea: 'CX-30', enviadoPorNombre: NOMBRES_DEMO[2], enviadoEn: '2026-10-16T16:00:00Z',
    valorLiquidado: 385000, valorPagado: 385000, liquidadoEn: '2026-10-17T14:00:00Z', pagadoEn: '2026-10-20T13:00:00Z', documentos: 'ambos',
    analisisEstado: 'completado', semaforo: 'verde',
    certificacion: { id: 'cert-demo-3', certificadoEn: '2026-10-17T15:00:00Z', certificadoPorNombre: null, automatica: true },
  }),
  impuesto(4, {
    estado: 'solicitado', marca: 'Kia', linea: 'Picanto', enviadoPorNombre: NOMBRES_DEMO[2], enviadoEn: '2026-10-08T16:00:00Z',
    estancado: true, gestionOperaciones: true, analisisEstado: 'completado', semaforo: 'rojo', motivoSemaforo: 'runt_sin_respuesta',
  }),
];
export const IMPUESTOS_FACETAS_DEMO = {
  companias: CLIENTE_DEMO.map((c) => ({ id: c.id, nombre: c.name })),
  organismos: [{ codigo: '17001', nombre: ORGANISMOS_REALES[0] }],
};
/** Detalle del impuesto en naranja (`imp-demo-2`): la factura y el RUNT no coinciden en color y cilindraje. */
export const IMPUESTO_DETALLE_DEMO = {
  ...IMPUESTOS_COLA_DEMO[1],
  comparacion: {
    version: 1, motivo: null, calculadoEn: '2026-10-19T16:05:00Z',
    resumen: { coinciden: 4, difieren: 2, noVerificables: 0 },
    campos: [
      { campo: 'vin', resultado: 'coincide', valorFactura: V[1], valorRunt: V[1] },
      { campo: 'marca', resultado: 'coincide', valorFactura: 'RENAULT', valorRunt: 'RENAULT' },
      { campo: 'linea', resultado: 'coincide', valorFactura: 'DUSTER', valorRunt: 'DUSTER' },
      { campo: 'anio', resultado: 'coincide', valorFactura: '2027', valorRunt: '2027' },
      { campo: 'color', resultado: 'difiere', valorFactura: 'GRIS ESTRELLA', valorRunt: 'GRIS COMETA' },
      { campo: 'cilindrada', resultado: 'difiere', valorFactura: '1598', valorRunt: '1600' },
    ],
  },
  // Sin dirección: la captura no la necesita y así ningún fixture lleva una dirección.
  direccionComprador: null, envioFlit2: null, envioComprobante: null,
  soportes: [{ id: 'sop-demo-2', tipo: 'liquidacion' }],
};

// ── Derechos de tránsito ──
function derecho(i: number, p: Record<string, unknown>) {
  const k = (i - 1) % 3;
  return {
    id: `der-demo-${i}`, tramiteId: `tra-demo-${i}`, idFlit: `FLIT-DEMO-${100 + i}`, placa: P[i - 1], organismoCodigo: '17001',
    empresa: EMPRESAS_DEMO[k], valor: '186500', fechaPago: '2026-10-20', numeroRadicado: null, tipoTramiteRecibo: 'Matrícula inicial',
    origen: 'manual', advertencias: null, soporteId: `sop-der-demo-${i}`, createdAt: '2026-10-20T16:00:00Z',
    archivoOrigen: `recibo-demo-${i}.pdf`, paginas: [1], procesamientoId: null, procesamientoArchivo: null,
    vin: V[i - 1], marca: 'Chevrolet', linea: 'Onix', tipoTramite: 'Matricula', fechaAprobacion: null, fechaCreacion: '2026-10-19T15:00:00Z',
    ...p,
  };
}
export const DERECHOS_DEMO = {
  items: [
    derecho(1, {}),
    derecho(2, { marca: 'Renault', linea: 'Duster', origen: 'drive', archivoOrigen: null, procesamientoId: 7,
      procesamientoArchivo: 'consolidado-demo-2026-10-20.pdf', paginas: [3, 4] }),
    // `advertencias` es un arreglo de textos del sistema (no lleva datos de personas): el guard no lo recorre.
    derecho(3, { marca: 'Mazda', linea: 'CX-30', tipoTramite: 'Traspaso',
      advertencias: ['El concepto del recibo (Matrícula inicial) no coincide con el del trámite (Traspaso).'] }),
  ],
  total: 3,
};
export const DERECHOS_FACETAS_DEMO = { organismos: ['17001'], origenes: ['manual', 'drive'] };
/** Resultado de una carga manual: una canasta por desenlace. */
export const DERECHOS_RESULTADO_DEMO = {
  registrados: [{ archivo: 'recibo-demo-1.pdf', placa: P[0], idFlit: 'FLIT-DEMO-101', registroId: 'der-demo-1', valor: '186500', detalle: 'Registrado en el trámite.' }],
  enRevision: [{ archivo: 'recibo-demo-4.pdf', placa: P[3], idFlit: null, registroId: null, valor: '186500', detalle: 'La placa tiene varios trámites: se resuelve en Revisiones OCR.' }],
  duplicados: [{ archivo: 'recibo-demo-2.pdf', placa: P[1], idFlit: 'FLIT-DEMO-102', registroId: 'der-demo-2', valor: '186500', detalle: 'Ya estaba registrado.' }],
  pendientes: [], omitidas: [], fallidos: [],
};
/** Pestaña «Drive · Medellín»: consolidados del día y el registro de pasadas. `modificadoPor` es una persona demo. */
export const DERECHOS_DRIVE_DEMO = [
  { fileId: 'drv-demo-1', nombre: 'consolidado-demo-2026-10-21.pdf', tamanoBytes: 1_258_291, modificadoEn: '2026-10-21T12:30:00Z',
    modificadoPor: NOMBRES_DEMO[3], procesadoEn: null, omitidoEn: null },
  { fileId: 'drv-demo-2', nombre: 'consolidado-demo-2026-10-20.pdf', tamanoBytes: 1_048_000, modificadoEn: '2026-10-20T12:10:00Z',
    modificadoPor: NOMBRES_DEMO[3], procesadoEn: '2026-10-20T14:00:00Z', omitidoEn: null },
];
export const DERECHOS_DRIVE_REGISTRO_DEMO = [
  { id: 7, fileId: 'drv-demo-2', nombreArchivo: 'consolidado-demo-2026-10-20.pdf', estado: 'completado', modificadoPor: NOMBRES_DEMO[3],
    modificadoEn: '2026-10-20T12:10:00Z', totalPaginas: 13, cuentasDetectadas: 12, placasUnicas: 11, valorTotal: '2238000',
    error: null, procesadoEn: '2026-10-20T14:00:00Z', sigueEnDrive: true },
];

// ── Área Mensajero y Logística (HU #13773) ──────────────────────────────────
// Consola Logística del Administrador: una licencia por estado, sus actas y el detalle con viajes.
// La bitácora del detalle no lleva coordenadas (`lat`/`lng` en null): la ubicación es dato personal.

const ORG_LOGISTICA = { organismoCodigo: '17001', organismoNombre: ORGANISMOS_REALES[0] };

const filaLogistica = (i: 0 | 1 | 2 | 3, estadoSimple: string, estadoSimpleLabel: string, estado: string, conLt: boolean, empresa: 0 | 1 | 2) => ({
  tramiteId: `tram-log-demo-${i + 1}`, idFlit: `FLIT-DEMO-30${i + 1}`,
  placa: DATOS_DEMO.placas[i], vin: DATOS_DEMO.vins[i], propietario: NOMBRES_DEMO[i % 2],
  companiaId: 901 + empresa, companiaNombre: EMPRESAS_DEMO[empresa], companiaNit: DATOS_DEMO.nits[empresa],
  ...ORG_LOGISTICA,
  docId: conLt ? `doc-log-demo-${i + 1}` : null, estado, estadoLabel: estadoSimpleLabel,
  estadoSimple, estadoSimpleLabel,
  numeroLicencia: conLt ? `1000000000${i + 1}` : null, numeroLt: conLt ? `LT9000000010${i + 1}` : null,
  actaId: null, motivo: null, actualizadoEn: '2026-10-21T14:00:00.000Z',
});

export const LOGISTICA_TRAMITES_DEMO = {
  items: [
    filaLogistica(0, 'pendiente', 'Pendiente de recogida', 'pendiente', false, 0),
    filaLogistica(1, 'registrada', 'Registrada', 'recogido', true, 0),
    filaLogistica(2, 'despachada', 'Despachada', 'despachado', true, 1),
    filaLogistica(3, 'entregada', 'Entregada', 'entregado', true, 2),
  ],
  total: 4, page: 1, pageSize: 50,
};

export const LOGISTICA_FACETAS_DEMO = {
  estados: ['pendiente', 'registrada', 'despachada', 'entregada', 'novedad'],
  empresas: EMPRESAS_DEMO.map((nombre, i) => ({ nit: DATOS_DEMO.nits[i], nombre })),
  organismos: [],
  companiasCerrables: [
    {
      companiaId: 901, nombre: EMPRESAS_DEMO[0], disponibles: 2, precioEntregaCliente: 12000,
      lts: [
        { documentoId: 'doc-log-demo-1', placa: DATOS_DEMO.placas[0], numeroLt: 'LT90000000101', idFlit: 'FLIT-DEMO-1' },
        { documentoId: 'doc-log-demo-2', placa: DATOS_DEMO.placas[1], numeroLt: 'LT90000000202', idFlit: 'FLIT-DEMO-2' },
      ],
    },
    {
      companiaId: 902, nombre: EMPRESAS_DEMO[1], disponibles: 1, precioEntregaCliente: null,
      lts: [
        { documentoId: 'doc-log-demo-3', placa: DATOS_DEMO.placas[2], numeroLt: 'LT90000000303', idFlit: 'FLIT-DEMO-3' },
      ],
    },
  ],
  mensajeros: [{ id: 51, nombre: NOMBRES_DEMO[4] }],
};

export const LOGISTICA_ACTAS_DEMO = [
  { id: 'acta-log-demo-1', companiaId: 901, companiaNombre: EMPRESAS_DEMO[0], estado: 'generada', estadoLabel: 'Generada',
    mensajeroId: null, mensajeroNombre: null, documentos: 2, receptorNombre: null, entregadoEn: null, creadoEn: '2026-10-21T13:00:00.000Z' },
  { id: 'acta-log-demo-2', companiaId: 902, companiaNombre: EMPRESAS_DEMO[1], estado: 'despachada', estadoLabel: 'Despachada',
    mensajeroId: 51, mensajeroNombre: NOMBRES_DEMO[4], documentos: 1, receptorNombre: null, entregadoEn: null, creadoEn: '2026-10-20T13:00:00.000Z' },
  { id: 'acta-log-demo-3', companiaId: 903, companiaNombre: EMPRESAS_DEMO[2], estado: 'entregada', estadoLabel: 'Entregada',
    mensajeroId: 51, mensajeroNombre: NOMBRES_DEMO[4], documentos: 1, receptorNombre: NOMBRES_DEMO[3],
    entregadoEn: '2026-10-20T20:00:00.000Z', creadoEn: '2026-10-19T13:00:00.000Z' },
];

/** Detalle de la licencia Registrada (fila 2): datos del trámite y su bitácora. */
export const LOGISTICA_DETALLE_DEMO = {
  ...LOGISTICA_TRAMITES_DEMO.items[1],
  propietarioDocumento: DATOS_DEMO.cedulas[1], combustible: 'GASOLINA', tieneFoto: false,
  eventos: [
    { id: 'ev-log-demo-1', estadoAnterior: 'pendiente', estadoNuevo: 'recogido', actorNombre: NOMBRES_DEMO[4],
      lat: null, lng: null, motivo: null, origen: 'pwa', creadoEn: '2026-10-21T14:00:00.000Z' },
  ],
};

/** Viajes adicionales del trámite de la fila 2: un viaje a tarifa vigente. */
export const LOGISTICA_VIAJES_DEMO = {
  tramiteId: LOGISTICA_DETALLE_DEMO.tramiteId, idFlit: LOGISTICA_DETALLE_DEMO.idFlit,
  gestionaLogistica: true, liquidado: false, tarifaVigente: 25000,
  items: [
    { id: 'viaje-log-demo-2', numero: 2, modo: 'inicial', valor: 25000, tarifaVigente: 25000, motivo: 'segunda_entrega',
      motivoDetalle: null, registradoPorId: 7, registradoPorNombre: NOMBRES_DEMO[2], registradoEn: '2026-10-21T15:00:00.000Z' },
  ],
  totalViajes: 2, totalAdicionales: 25000,
};

// ── Área Super Admin (HU #13774) ────────────────────────────────────────────
// Usuarios, Log de accesos PII, Privacidad y datos, Google Drive, Roles y permisos e Integración con Siigo.
// Ningún fixture representa una anonimización ejecutada: Privacidad solo tiene la previsualización (AC4).

const usuarioDemo = (id: number, i: 0 | 1 | 2 | 3, role: string, extra: Record<string, unknown> = {}) => ({
  id, username: DATOS_DEMO.usuarios[i], name: NOMBRES_DEMO[i], email: i === 3 ? null : DATOS_DEMO.correos[3 + i],
  role, active: true, funciones: [], transitoCodigo: null, companiaId: null, flitoProveedorSoatId: null,
  organismosCodigos: [], createdAt: '2026-09-01T15:00:00.000Z', deletedAt: null, ...extra,
});

export const USUARIOS_DEMO = [
  usuarioDemo(1, 2, 'admin'),
  usuarioDemo(2, 0, 'financiera'),
  usuarioDemo(3, 1, 'auditor', { active: false }),
  usuarioDemo(4, 3, 'mensajero'),
];

export const USUARIOS_RESUMEN_DEMO = { porRol: { admin: 1, financiera: 1, auditor: 1, mensajero: 1 }, activos: 3, inactivos: 1 };

/** Historial de Usuarios: cambio de rol y desactivación hechos por el Administrador demo. */
const ACTOR_DEMO = { userId: 1, email: DATOS_DEMO.correos[5], rol: 'admin' };
export const USUARIOS_HISTORIAL_DEMO = {
  total: 2, limite: 50, offset: 0, desdeCuando: '2026-09-01T15:00:00.000Z',
  items: [
    { id: 72, loteId: 'lote-demo-2', entidad: 'usuario', accion: 'desactivar', campo: 'active', valorAntes: true, valorDespues: false,
      titular: { userId: 3, username: DATOS_DEMO.usuarios[1], rol: 'auditor' }, rolAfectado: null, actor: ACTOR_DEMO,
      origen: 'usuario', motivo: null, creadoEn: '2026-10-21T14:20:00.000Z' },
    { id: 71, loteId: 'lote-demo-1', entidad: 'usuario', accion: 'editar', campo: 'role', valorAntes: 'mensajero', valorDespues: 'financiera',
      titular: { userId: 2, username: DATOS_DEMO.usuarios[0], rol: 'financiera' }, rolAfectado: null, actor: ACTOR_DEMO,
      origen: 'usuario', motivo: null, creadoEn: '2026-10-20T16:05:00.000Z' },
  ],
};
export const USUARIOS_TITULARES_DEMO = [{ userId: 2, username: DATOS_DEMO.usuarios[0] }, { userId: 3, username: DATOS_DEMO.usuarios[1] }];

/** Catálogo de roles de las pantallas Usuarios y Roles y permisos (sin datos personales). */
export const ROLES_DEMO = [
  ['admin', 'Administrador', 1], ['financiera', 'Financiera', 1], ['auditor', 'Auditor', 1], ['mensajero', 'Mensajero', 1],
  ['gestor_demo', 'Gestor demo', 0],
].map(([codigo, nombre, usuarios]) => ({
  codigo, nombre, descripcion: codigo === 'gestor_demo' ? 'Rol de ejemplo para la ayuda.' : null, tipoEnlace: 'ninguno',
  esSistema: codigo === 'admin', activo: true, usuarios, borrable: usuarios === 0 && codigo !== 'admin',
  motivoNoBorrable: usuarios === 0 ? null : 'Hay usuarios con este rol.',
  createdAt: '2026-09-01T15:00:00.000Z', updatedAt: '2026-09-01T15:00:00.000Z',
}));

/** Log de accesos PII: quién (número de usuario y rol), qué recurso, qué campos y desde qué IP de documentación. */
const accesoPii = (id: number, userId: number, userRole: string, resourceTipo: string, resourceId: number, accion: string,
  campos: string[], ip: 0 | 1 | 2, hora: string) => ({
  id, userId, userRole, resourceTipo, resourceId, accion, camposAccedidos: campos, motivo: null,
  ipOrigen: DATOS_DEMO.ips[ip], userAgent: DATOS_DEMO.agentesUsuario[0], requestId: `req-demo-${id}`, accessedAt: `2026-10-21T${hora}.000Z`,
});

export const LOG_PII_DEMO = {
  total: 5,
  rows: [
    accesoPii(905, 1, 'admin', 'conductor', 12, 'read', ['documento', 'telefono'], 0, '14:52:10'),
    accesoPii(904, 2, 'financiera', 'propietario', 7, 'decrypt', ['documento'], 1, '14:31:44'),
    accesoPii(903, 1, 'admin', 'conductor', 12, 'export', ['nombre', 'documento', 'telefono'], 0, '13:05:02'),
    accesoPii(902, 3, 'auditor', 'cliente', 31, 'search', ['documento'], 2, '11:47:29'),
    accesoPii(901, 2, 'financiera', 'propietario', 7, 'read', ['nombre'], 1, '09:12:55'),
  ],
};

export const LOG_PII_STATS_DEMO = {
  desde: '2026-09-21T15:00:00.000Z',
  porUsuario: [{ user_id: 1, user_role: 'admin', accesos: 2 }, { user_id: 2, user_role: 'financiera', accesos: 2 }, { user_id: 3, user_role: 'auditor', accesos: 1 }],
  porRecurso: [{ resource_tipo: 'conductor', accion: 'read', accesos: 1 }, { resource_tipo: 'propietario', accion: 'decrypt', accesos: 1 }, { resource_tipo: 'conductor', accion: 'export', accesos: 1 }, { resource_tipo: 'cliente', accion: 'search', accesos: 1 }, { resource_tipo: 'propietario', accion: 'read', accesos: 1 }],
};

/** Privacidad y datos: SOLO la previsualización de un documento demo. La anonimización no tiene fixture (AC4). */
export const PRIVACY_PREVIEW_DEMO = {
  docNumber: DATOS_DEMO.cedulas[0],
  affected: { clients: 1, vehicles: 2, soat_requests: 3, tramites_digitales: 1, laft_counterparties: 0, laft_beneficial_owners: 0 },
};

/** Google Drive: nombres de carpeta y de archivo `*-demo-*`; ningún archivo real. */
const archivoDrive = (id: string, nombre: string, mimeType: string, size: string, dia: string) => ({
  id, name: nombre, mimeType, size, createdTime: `2026-10-${dia}T14:00:00.000Z`, modifiedTime: `2026-10-${dia}T15:30:00.000Z`,
  webViewLink: `https://drive.ejemplo.test/${id}`,
});

const CARPETA = 'application/vnd.google-apps.folder';
export const DRIVE_RAIZ_DEMO = {
  ok: true,
  folders: [
    archivoDrive('carpeta-demo-1', 'cuentas-cobro-demo-octubre', CARPETA, '0', '01'),
    archivoDrive('carpeta-demo-2', 'tramites-demo-2026', CARPETA, '0', '02'),
  ],
  files: [archivoDrive('arch-demo-1', 'instructivo-demo-carpetas.pdf', 'application/pdf', '48213', '03')],
};
export const DRIVE_CARPETA_DEMO = {
  ok: true,
  folders: [],
  files: [
    archivoDrive('arch-demo-2', 'cuentas-cobro-demo-semana-42.pdf', 'application/pdf', '312400', '20'),
    archivoDrive('arch-demo-3', 'cuentas-cobro-demo-semana-41.pdf', 'application/pdf', '298760', '13'),
    archivoDrive('arch-demo-4', 'soporte-demo-pago.png', 'image/png', '91200', '13'),
  ],
};

const cuentaDemo = (i: 0 | 1 | 2, tipoTramite: string, valorTotal: number) => ({
  placa: DATOS_DEMO.placas[i], propietario: NOMBRES_DEMO[i], cedula: DATOS_DEMO.cedulas[i],
  vehiculo: ['AUTOMÓVIL DEMO', 'CAMIONETA DEMO', 'MOTOCICLETA DEMO'][i], tipoTramite, valorTotal,
  downloadUrl: `/api/drive/descargas/cuenta-demo-${i + 1}.pdf`, pdfFile: `cuenta-demo-${i + 1}.pdf`,
});
export const DRIVE_PROCESO_DEMO = {
  ok: true, totalPaginas: 3, cuentasDetectadas: 3, placasUnicas: 3, valorTotal: 1_386_000,
  excelDownloadUrl: '/api/drive/descargas/cuentas-demo-semana-42.xlsx', excelFile: 'cuentas-demo-semana-42.xlsx',
  zipFile: null, zipDownloadUrl: null,
  cuentas: [cuentaDemo(0, 'Traspaso', 512000), cuentaDemo(1, 'Matrícula inicial', 618000), cuentaDemo(2, 'Traspaso', 256000)],
};

/** Integración con Siigo: credenciales con usuario demo; la access key solo sale enmascarada, como del servidor. */
const credencialSiigo = (id: number, ambiente: 'pruebas' | 'produccion', usuario: 4 | 5, activo: boolean, keyVersion: number, notas: string | null, dia: string) => ({
  id, ambiente, username: DATOS_DEMO.usuarios[usuario], accessKey: '••••••••', activo, keyVersion, notas,
  descifradoFallidoEn: null, descifradoFallidoMotivo: null,
  createdAt: `2026-${dia}T15:00:00.000Z`, updatedAt: `2026-${dia}T15:00:00.000Z`,
});
export const SIIGO_CREDENCIALES_DEMO = {
  llaveMaestraConfigurada: true,
  data: [
    credencialSiigo(11, 'pruebas', 4, true, 2, 'Cuenta de pruebas demo', '10-01'),
    credencialSiigo(10, 'pruebas', 4, false, 1, null, '08-15'),
  ],
};
export const SIIGO_PRUEBA_DEMO = {
  ok: true, codigo: 'ok', mensaje: 'Conexión correcta con Siigo: el usuario demo obtuvo su token.', ambiente: 'pruebas', modo: 'real',
  username: DATOS_DEMO.usuarios[4], tokenObtenido: true, duracionMs: 640,
};

/** Usuario de sesión de las capturas del área Facturación (HU #13770): Administrador demo. */
export const NOMBRE_ADMIN_DEMO = NOMBRES_DEMO[2];

// ── Tablero de control y Organismos de tránsito (HU #13775) ──

/** Panel operativo (`/`): solo conteos, sin datos personales. */
export const PANEL_SOAT_STATS_DEMO = { totalVehicles: 48, pendiente: 3, enviado: 2, comprado: 5, verificado: 36, rechazado: 1 };
export const PANEL_VENCIMIENTOS_DEMO = {
  count: 4,
  data: [{ estado: 'vencido' }, { estado: 'por_vencer' }, { estado: 'por_vencer' }, { estado: 'por_vencer' }],
};
export const PANEL_RNDC_DEMO = { total: 2, data: [{ id: 1 }, { id: 2 }] };

/**
 * Organismos de tránsito: nombre, ciudad y código reales (entidad pública, códigos públicos); alias y
 * logo de demo. Sin correos, teléfonos, NIT ni direcciones. `nombre` y `alias` del organismo se recorren
 * con otra clave en `FIXTURES_DEMO` (no son de una persona ni de una empresa).
 */
export const ORGANISMOS_CONFIG_DEMO = [
  {
    codigo: '17001000', nombre: ORGANISMOS_REALES[0], ciudad: 'Manizales', alias: 'Movilidad Manizales',
    logoUrl: null, logoUrlExterno: null, logoStorageKey: null, activo: true, userCount: 2, updatedAt: '2026-10-15T15:00:00.000Z',
  },
  {
    codigo: '11001000', nombre: ORGANISMOS_REALES[1], ciudad: 'Bogotá', alias: null,
    logoUrl: null, logoUrlExterno: null, logoStorageKey: null, activo: true, userCount: 0, updatedAt: null,
  },
];
export const ORGANISMOS_MODALIDAD_DEMO = [
  {
    codigo: '17001000', nombre: ORGANISMOS_REALES[0], alias: 'Movilidad Manizales', activo: true,
    modalidadVigente: 'requiere_gestion', umbralOcr: 0.85, slaHoras: 48, diferenciaValorActiva: true, tramitesRetenidos: 0,
  },
];
/** Historial de modalidad: actor = persona demo; el motivo es texto de operación, sin datos personales. */
export const ORGANISMO_VIGENCIAS_DEMO = [
  {
    id: 'vig-demo-2', modalidad: 'requiere_gestion', desde: '2026-09-01T05:00:00.000Z', hasta: null,
    motivo: 'El organismo pidió que FLITO radique los trámites', actorNombre: NOMBRES_DEMO[2], creadoEn: '2026-09-01T15:00:00.000Z',
  },
  {
    id: 'vig-demo-1', modalidad: 'autogestionado', desde: '2026-03-01T05:00:00.000Z', hasta: '2026-09-01T05:00:00.000Z',
    motivo: 'Modalidad inicial', actorNombre: NOMBRES_DEMO[3], creadoEn: '2026-03-01T15:00:00.000Z',
  },
];
export const ORGANISMO_PLANTILLA_DEMO = {
  override: { hide: [], require: [], add: [{ id: 'paz_y_salvo_municipal', label: 'Paz y salvo municipal', obligatorio: true }] },
};

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
  // El `numeroDocumento` de un comprobante es el número de la factura (`DEMO-…`), no el de una persona (HU #13771).
  COMPROBANTES_DEMO: COMPROBANTES_DEMO.items.map(({ archivo, numeroDocumento, ...c }) => ({ ...c, archivoNombre: archivo.nombre, numeroComprobante: numeroDocumento })),
  COMPROBANTE_DETALLE_DEMO: (({ archivo, numeroDocumento, ...c }) => ({ ...c, archivoNombre: archivo.nombre, numeroComprobante: numeroDocumento }))(COMPROBANTE_DETALLE_DEMO),
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
  // ── Área Corredor SOAT (HU #13771) ──
  PROVEEDORES_SOAT_DEMO,
  BITACORA_DEMO,
  // `extraccion` trae objetos {valor, confianza}: se recorre el valor leído bajo la misma clave.
  REVISIONES_DEMO: REVISIONES_DEMO.map((r) => ({
    ...r, extraccion: Object.fromEntries(Object.entries(r.extraccion).map(([k, c]) => [k, c.valor])),
  })),
  REVISION_CANDIDATOS_SOAT,
  COMPARENDOS_NITS_DEMO,
  COMPARENDOS_TOKEN_DEMO,
  COMPARENDOS_REGISTROS_DEMO,
  COMPARENDO_DETALLE_DEMO,
  CLIENTES_FICHA_DEMO,
  TRAMITES_DEMO,
  COMPANIAS_DEMO,
  SYNC_DEMO,
  SOAT_COLA_DEMO,
  // `nombre` de un organismo de tránsito: nombre real permitido; se recorre con otra clave.
  SOAT_FACETAS_DEMO: { ...SOAT_FACETAS_DEMO, organismos: SOAT_FACETAS_DEMO.organismos.map(({ nombre, ...o }) => ({ ...o, organismo: nombre })) },
  SOAT_POR_VALIDAR_DEMO,
  SOAT_COMPANIAS_CANAL_DEMO,
  SOAT_DOCUMENTOS_ADICIONALES_DEMO,
  // ── Área Corredor Impuestos (HU #13772) ──
  IMPUESTOS_COLA_DEMO,
  // `nombre` de un organismo de tránsito: nombre real permitido; se recorre con otra clave.
  IMPUESTOS_FACETAS_DEMO: { ...IMPUESTOS_FACETAS_DEMO, organismos: IMPUESTOS_FACETAS_DEMO.organismos.map(({ nombre, ...o }) => ({ ...o, organismo: nombre })) },
  // `comparacion.campos` trae {campo, valorFactura, valorRunt}: se aplana a {<campo>: valor} por lado para que
  // el VIN leído de la factura y el del RUNT se recorran bajo la clave `vin`.
  IMPUESTO_DETALLE_DEMO: {
    ...IMPUESTO_DETALLE_DEMO,
    comparacion: {
      factura: Object.fromEntries(IMPUESTO_DETALLE_DEMO.comparacion.campos.map((c) => [c.campo, c.valorFactura])),
      runt: Object.fromEntries(IMPUESTO_DETALLE_DEMO.comparacion.campos.map((c) => [c.campo, c.valorRunt])),
    },
  },
  DERECHOS_DEMO,
  DERECHOS_RESULTADO_DEMO,
  // El `nombre` de un archivo del Drive no es de una persona: se recorre con otra clave.
  DERECHOS_DRIVE_DEMO: DERECHOS_DRIVE_DEMO.map(({ nombre, ...a }) => ({ ...a, nombreArchivo: nombre })),
  DERECHOS_DRIVE_REGISTRO_DEMO,
  // ── Área Mensajero y Logística (HU #13773) ──
  LOGISTICA_TRAMITES_DEMO,
  LOGISTICA_FACETAS_DEMO,
  LOGISTICA_ACTAS_DEMO,
  LOGISTICA_DETALLE_DEMO,
  LOGISTICA_VIAJES_DEMO,
  // ── Área Super Admin (HU #13774) ──
  USUARIOS_DEMO,
  // `titular` y `actor` del historial son objetos: se recorren sus campos (`username`, `email`) bajo otra clave.
  USUARIOS_HISTORIAL_DEMO: USUARIOS_HISTORIAL_DEMO.items.map(({ titular, actor, ...i }) => ({ ...i, titularUsuario: titular, actorDatos: actor })),
  USUARIOS_TITULARES_DEMO,
  // El `nombre` de un rol no es de una persona: se recorre con otra clave.
  ROLES_DEMO: ROLES_DEMO.map(({ nombre, ...r }) => ({ ...r, nombreRol: nombre })),
  LOG_PII_DEMO,
  LOG_PII_STATS_DEMO,
  PRIVACY_PREVIEW_DEMO,
  // El `name` de una carpeta o archivo del Drive no es de una persona: se recorre con otra clave.
  DRIVE_RAIZ_DEMO: [...DRIVE_RAIZ_DEMO.folders, ...DRIVE_RAIZ_DEMO.files].map(({ name, ...a }) => ({ ...a, nombreArchivo: name })),
  DRIVE_CARPETA_DEMO: DRIVE_CARPETA_DEMO.files.map(({ name, ...a }) => ({ ...a, nombreArchivo: name })),
  DRIVE_PROCESO_DEMO,
  SIIGO_CREDENCIALES_DEMO,
  SIIGO_PRUEBA_DEMO,
  // ── Tablero de control y Organismos de tránsito (HU #13775) ──
  PANEL_SOAT_STATS_DEMO,
  PANEL_VENCIMIENTOS_DEMO,
  PANEL_RNDC_DEMO,
  // `nombre` y `alias` de un organismo de tránsito: nombre real permitido (entidad pública); se recorren con otra clave.
  ORGANISMOS_CONFIG_DEMO: ORGANISMOS_CONFIG_DEMO.map(({ nombre, alias, ...o }) => ({ ...o, organismo: nombre, aliasOrganismo: alias })),
  ORGANISMOS_MODALIDAD_DEMO: ORGANISMOS_MODALIDAD_DEMO.map(({ nombre, alias, ...o }) => ({ ...o, organismo: nombre, aliasOrganismo: alias })),
  ORGANISMO_VIGENCIAS_DEMO,
  ORGANISMO_PLANTILLA_DEMO,
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
