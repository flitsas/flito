// TEMPORAL (Épica #14560, sesión B): fixtures del barrido responsive para las pantallas que con `[]`
// caían en error (flota, mantenimiento, PESV, RNDC, LAFT inusuales, conciliación, métricas de trámites).
// Se borra junto con zz-barrido-responsive.spec.ts. Datos ficticios y evidentes: placas ZZ*, cédulas y
// NIT 99…, correos @ejemplo.test, fechas oct–nov 2026. Formas tomadas de los tipos de cada página.
import type { ManejadorDemo } from '../helpers/datos-demo';
import { CONCILIACION_DETALLE_DEMO } from '../helpers/datos-demo';
import { VISTAS_LAFT } from '../helpers/laft-fixtures';
import { buildDiagDetail, buildPreflight } from '../helpers/pesv-fixtures';

const ok = (body: unknown): ManejadorDemo => () => ({ body });

const PLACAS = ['ZZA101', 'ZZB202', 'ZZC303', 'ZZD404'] as const;
const NOMBRES = ['Ana Demo Prueba', 'Carlos Demo Ejemplo', 'Beatriz Demo Muestra', 'Diego Demo Ficticio'] as const;
const CEDULAS = ['99000001', '99000002', '99000003', '99000004'] as const;
const CORREOS = ['ana.demo@ejemplo.test', 'carlos.demo@ejemplo.test', 'beatriz.demo@ejemplo.test', 'diego.demo@ejemplo.test'] as const;

// ── Flota ────────────────────────────────────────────────────────────────────

const VEHICULOS = PLACAS.map((plate, i) => ({
  id: i + 1, plate, alias: `Unidad demo ${i + 1}`, brand: ['Marca Demo', 'Motor Ficticio'][i % 2], model: `Modelo Z${i + 1}`,
  year: 2020 + i, color: ['Blanco', 'Rojo', 'Gris', 'Azul'][i], tipoVehiculo: i === 3 ? 'remolque' : 'camion',
  tipoMedicion: 'km', combustiblePrincipal: 'diesel', distPromedioDia: 180 + i * 20,
}));

const VEHICULO_DETALLE = {
  data: {
    ...VEHICULOS[0], vin: 'ZZDEMO0000000VIN1', medicionPrincipal: 'km', numMotor: 'MOT-DEMO-001', numSerie: 'SER-DEMO-001',
    rendimientoIdeal: '8.5', esFlotaPropia: true,
  },
  lastMeasurement: { fecha: '2026-11-02', odometro: 125400, horometro: null },
};

const VENCIMIENTOS = {
  count: 4,
  data: [
    { id: 1, vehicleId: 1, plate: PLACAS[0], alias: 'Unidad demo 1', tipoNombre: 'SOAT', vigenciaHasta: '2026-10-30', estado: 'vencido' },
    { id: 2, vehicleId: 2, plate: PLACAS[1], alias: 'Unidad demo 2', tipoNombre: 'Revisión técnico-mecánica', vigenciaHasta: '2026-11-20', estado: 'por_vencer' },
    { id: 3, vehicleId: 3, plate: PLACAS[2], alias: 'Unidad demo 3', tipoNombre: 'Póliza RC', vigenciaHasta: '2026-11-28', estado: 'por_vencer' },
    { id: 4, vehicleId: 4, plate: PLACAS[3], alias: 'Unidad demo 4', tipoNombre: 'Tarjeta de operación', vigenciaHasta: '2026-12-05', estado: 'por_vencer' },
  ],
};

// ── Mantenimiento ────────────────────────────────────────────────────────────

const PROGRAMACION = {
  data: [
    { id: 1, vehicleId: 1, plate: PLACAS[0], alias: 'Unidad demo 1', routineNombre: 'Rutina 10.000 km', jobNombre: 'Cambio de aceite', fechaProgramada: '2026-11-15', medicionProgramada: 130000, tipo: 'automatica', estado: 'pendiente', notas: null },
    { id: 2, vehicleId: 2, plate: PLACAS[1], alias: 'Unidad demo 2', routineNombre: 'Rutina frenos', jobNombre: 'Revisión de frenos', fechaProgramada: '2026-11-18', medicionProgramada: null, tipo: 'manual', estado: 'pendiente', notas: 'Demo' },
    { id: 3, vehicleId: 3, plate: PLACAS[2], alias: 'Unidad demo 3', routineNombre: null, jobNombre: 'Alineación', fechaProgramada: '2026-11-05', medicionProgramada: null, tipo: 'manual', estado: 'vencida', notas: null },
    { id: 4, vehicleId: 4, plate: PLACAS[3], alias: 'Unidad demo 4', routineNombre: 'Rutina 10.000 km', jobNombre: 'Filtros', fechaProgramada: '2026-10-28', medicionProgramada: 98000, tipo: 'automatica', estado: 'ejecutada', notas: null },
  ],
};

const REPUESTOS = {
  data: [
    { id: 1, codigo: 'REP-001', nombre: 'Filtro de aceite demo', unidadMedida: 'und', inventariable: true, existenciaMin: '10', existenciaMax: '40', valorPromedio: '45000', systemId: 1, stockTotal: '4' },
    { id: 2, codigo: 'REP-002', nombre: 'Pastilla de freno demo', unidadMedida: 'und', inventariable: true, existenciaMin: '8', existenciaMax: '30', valorPromedio: '120000', systemId: 2, stockTotal: '16' },
    { id: 3, codigo: 'REP-003', nombre: 'Aceite 15W40 demo', unidadMedida: 'gal', inventariable: true, existenciaMin: '20', existenciaMax: null, valorPromedio: '98000', systemId: 1, stockTotal: '12' },
    { id: 4, codigo: 'REP-004', nombre: 'Correa demo', unidadMedida: 'und', inventariable: false, existenciaMin: '0', existenciaMax: null, valorPromedio: '75000', systemId: null, stockTotal: '3' },
  ],
};

const BODEGAS = { data: [{ id: 1, codigo: 'BOD-1', nombre: 'Bodega demo principal' }, { id: 2, codigo: 'BOD-2', nombre: 'Bodega demo taller' }] };

const RUTINAS = {
  data: [
    { id: 1, codigo: 'RUT-10K', nombre: 'Rutina 10.000 km', descripcion: 'Aceite y filtros', activo: true },
    { id: 2, codigo: 'RUT-FRE', nombre: 'Rutina frenos', descripcion: 'Revisión de frenos cada 30 días', activo: true },
    { id: 3, codigo: 'RUT-ANU', nombre: 'Rutina anual', descripcion: null, activo: false },
  ],
};

const TRABAJOS = {
  data: [
    { id: 1, codigo: 'TRB-01', nombre: 'Cambio de aceite' },
    { id: 2, codigo: 'TRB-02', nombre: 'Revisión de frenos' },
    { id: 3, codigo: 'TRB-03', nombre: 'Alineación' },
  ],
};

const INDICADORES_MTO = {
  desde: '2026-10-01', hasta: '2026-11-13', vehicleId: null,
  mtbf_dias_promedio: 21.5, mttr_horas: 6.2, costo_total: 18450000, costo_por_km: 312.4, km_recorridos: 59060,
  disponibilidad_pct: 93.8, ots_cerradas: 14,
  costo_por_sistema: [{ sistema: 'Motor', monto: 7200000 }, { sistema: 'Frenos', monto: 5100000 }, { sistema: 'Suspensión', monto: 3650000 }, { sistema: 'Eléctrico', monto: 2500000 }],
  ots_reincidentes: [{ vehicleId: 1, plate: PLACAS[0], falla: 'Fuga de aceite', ocurrencias: 3 }, { vehicleId: 2, plate: PLACAS[1], falla: 'Desgaste de frenos', ocurrencias: 2 }],
  mtbf_por_vehiculo: PLACAS.map((plate, i) => ({ vehicleId: i + 1, plate, mtbfDias: [18, 24, 30, null][i], ots: [5, 4, 3, 2][i] })),
};

const ORDENES = {
  data: [
    { id: 1, numero: 'OT-DEMO-0001', vehicleId: 1, plate: PLACAS[0], tipoTrabajo: 'preventivo', estado: 'abierta', fechaIngresoTaller: '2026-11-10', fechaCierreFinal: null, costoTotalCalculado: null },
    { id: 2, numero: 'OT-DEMO-0002', vehicleId: 2, plate: PLACAS[1], tipoTrabajo: 'correctivo', estado: 'cerrada_tecnica', fechaIngresoTaller: '2026-11-03', fechaCierreFinal: null, costoTotalCalculado: '1250000' },
    { id: 3, numero: 'OT-DEMO-0003', vehicleId: 3, plate: PLACAS[2], tipoTrabajo: 'predictivo', estado: 'cerrada_final', fechaIngresoTaller: '2026-10-20', fechaCierreFinal: '2026-10-22', costoTotalCalculado: '840000' },
    { id: 4, numero: 'OT-DEMO-0004', vehicleId: 4, plate: PLACAS[3], tipoTrabajo: 'correctivo', estado: 'anulada', fechaIngresoTaller: '2026-10-15', fechaCierreFinal: null, costoTotalCalculado: null },
  ],
};

const ORDEN_DETALLE = {
  data: {
    id: 1, numero: 'OT-DEMO-0001', vehicleId: 1, tipoTrabajo: 'preventivo', estado: 'abierta',
    fechaIngresoTaller: '2026-11-10T13:00:00.000Z', fechaCierreTecnica: null, fechaCierreFinal: null,
    costoTotalCalculado: null, falla: 'Ruido en frenos', observaciones: 'Orden demo', medicionIngreso: 125400,
  },
  jobs: [
    { id: 1, jobId: 1, jobCodigo: 'TRB-01', jobNombre: 'Cambio de aceite', tiempoRealHoras: '1.5', costoManoObra: '90000' },
    { id: 2, jobId: 2, jobCodigo: 'TRB-02', jobNombre: 'Revisión de frenos', tiempoRealHoras: '2', costoManoObra: '140000' },
  ],
  parts: [
    { id: 1, partId: 1, partCodigo: 'REP-001', partNombre: 'Filtro de aceite demo', cantidad: '1', valorUnit: '45000', descuento: '0', aplicadoStock: false },
    { id: 2, partId: 2, partCodigo: 'REP-002', partNombre: 'Pastilla de freno demo', cantidad: '4', valorUnit: '120000', descuento: '20000', aplicadoStock: true },
    { id: 3, partId: 3, partCodigo: 'REP-003', partNombre: 'Aceite 15W40 demo', cantidad: '2', valorUnit: null, descuento: '0', aplicadoStock: false },
  ],
  otrosGastos: [{ id: 1, concepto: 'Grúa demo', monto: '250000' }, { id: 2, concepto: 'Lavado demo', monto: '40000' }],
  seguimientos: [
    { id: 1, texto: 'Ingresa a taller para revisión.', createdAt: '2026-11-10T13:05:00.000Z' },
    { id: 2, texto: 'Se pidieron repuestos.', createdAt: '2026-11-11T09:30:00.000Z' },
  ],
};

const LIQUIDACIONES = {
  liquidaciones: [
    { id: 1, estado: 'pagada', total: 1150000, nota: 'Pago demo', pagos: [{ id: 1, monto: 1150000, metodo: 'transferencia', createdAt: '2026-11-11T15:00:00.000Z' }] },
    { id: 2, estado: 'pendiente', total: 290000, nota: null, pagos: [] },
  ],
};

// ── LAFT, conciliación, métricas ─────────────────────────────────────────────

const LAFT_UNUSUAL_BASE = VISTAS_LAFT.find((v) => v.ruta === '/laft/unusual')?.cuerpo as { rows: Array<Record<string, unknown>> } | undefined;
const LAFT_FILA_BASE = LAFT_UNUSUAL_BASE?.rows[0] ?? {
  counterpartyId: 9001, counterpartyName: 'CONTRAPARTE SINTÉTICA DOS', counterpartyDoc: 'CC 990000002', detectedAt: '2026-10-03T14:30:00.000Z',
  source: 'fragmentacion_pagos', signals: ['Fragmentación sintética de pagos'], amount: '12345678', currency: 'COP',
  description: 'Operación de prueba sintética.', decision: 'pendiente', decidedAt: null, version: 1,
};
const LAFT_UNUSUAL = {
  rows: [
    { ...LAFT_FILA_BASE, id: 9101 },
    { ...LAFT_FILA_BASE, id: 9102, counterpartyName: 'CONTRAPARTE SINTÉTICA TRES', counterpartyDoc: 'NIT 990000003', detectedAt: '2026-10-21T10:00:00.000Z', source: 'monto_atipico', signals: ['Monto atípico sintético'], amount: '98000000', decision: 'en_analisis' },
    { ...LAFT_FILA_BASE, id: 9103, counterpartyName: 'CONTRAPARTE SINTÉTICA CUATRO', counterpartyDoc: 'CC 990000004', detectedAt: '2026-11-04T16:20:00.000Z', source: 'lista_restrictiva', signals: ['Coincidencia sintética en lista'], amount: null, decision: 'escalada', decidedAt: '2026-11-05T09:00:00.000Z' },
  ],
  total: 3,
};

const CONCILIACION_DETALLE = { ...(CONCILIACION_DETALLE_DEMO['bol-demo-1'] as Record<string, unknown>), id: 'demo-1' };

const METRICAS_TRAMITES = {
  ok: true, windowDays: 30,
  preflight: [{ overall_status: 'ok', n: 182 }, { overall_status: 'advertencia', n: 41 }, { overall_status: 'bloqueo', n: 9 }],
  tiempoTransito: { horas_mediana: 26.5, n: 214 },
  rechazosOt: { rechazos: 7, enviados: 198 },
  rechazosPorMotivo: [{ codigo: 'DOC_ILEGIBLE', n: 4 }, { codigo: 'FIRMA_FALTANTE', n: 2 }, { codigo: 'OTRO', n: 1 }],
  tipologias: [{ tipologia: 'traspaso', n: 120 }, { tipologia: 'matricula', n: 64 }, { tipologia: 'levantamiento_prenda', n: 30 }],
  notificaciones: [{ canal: 'correo', n: 410 }, { canal: 'whatsapp', n: 152 }],
  portal: [{ rol: 'cliente', invitados: 38, con_consentimiento: 31 }, { rol: 'tramitador', invitados: 12, con_consentimiento: 12 }],
  lotes: { lotes: 6, filas: 340, tramites_creados: 322 },
};

// ── PESV: conductores e indicadores ──────────────────────────────────────────

const CONDUCTORES = {
  data: NOMBRES.map((name, i) => ({
    id: 101 + i, name, username: `demo.conductor${i + 1}`, email: CORREOS[i], cedula: CEDULAS[i],
    licenciaNumero: `LIC-DEMO-${i + 1}`, categorias: i % 2 ? ['C2'] : ['C2', 'C3'], licenciaVigencia: ['2027-03-01', '2026-11-25', '2028-06-30', '2026-10-31'][i],
    examenPsicoVigencia: ['2027-01-15', '2026-12-01', '2026-11-20', '2027-05-05'][i], contratoTipo: ['directo', 'contratista', 'temporal', 'directo'][i],
    esConductor: true,
  })),
};

const CONDUCTOR_DETALLE = {
  user: { id: 101, name: NOMBRES[0], username: 'demo.conductor1', email: CORREOS[0] },
  profile: {
    cedula: CEDULAS[0], fechaNacimiento: '1990-05-10', licenciaNumero: 'LIC-DEMO-1', categorias: ['C2', 'C3'], licenciaVigencia: '2027-03-01',
    examenPsicoFecha: '2026-01-15', examenPsicoVigencia: '2027-01-15', restriccionesMedicas: ['Lentes'], arl: 'ARL Demo', eps: 'EPS Demo',
    fondoPensiones: 'Fondo Demo', contratoTipo: 'directo', experienciaAnios: '8', sancionesCount: 0,
  },
  documentosCount: 3, incidentesCount: 1,
};

const NO_CONDUCTORES = { data: [{ id: 201, name: 'Elena Demo Candidata', username: 'demo.candidata1' }, { id: 202, name: 'Fabio Demo Candidato', username: 'demo.candidato2' }] };

const INDICADORES_PESV = {
  desde: '2026-10-01', hasta: '2026-11-13', accidentes: 2, casi_accidentes: 5, comparendos: 3, lesionados: 1, fatales: 0,
  dias_perdidos_total: 4, costo_total: 3200000, km_recorridos: 59060, tasa_accidentalidad: 3.4, tasa_lesionados: 1.7, tasa_fatales: 0,
  severidad: 6.8, cumplimiento_documental_pct: 87.5, capacitacion_pct: 72, total_conductores: 4,
  top_conductores: NOMBRES.slice(0, 3).map((name, i) => ({ userId: 101 + i, name, incidentes: 3 - i, fatales: 0, victimas: i === 0 ? 1 : 0 })),
};

const INDICADORES_OPERACION = {
  desde: '2026-10-01', hasta: '2026-11-13', conductores_activos: 4,
  inspecciones: { realizadas: 112, esperadas: 128, dias_laborales: 32, pct: 87.5, no_aptos: 6 },
  alcoholimetria: { total: 40, positivos: 1, positivos_pct: 2.5, alerta_umbral: false },
  simulacros: { ejecutados_anio: 1, meta_anual: 2, cumple: false },
  top_conductores_no_aptos: NOMBRES.slice(0, 3).map((name, i) => ({ userId: 101 + i, name, noAptos: 3 - i })),
  top_vehiculos_no_aptos: PLACAS.slice(0, 3).map((plate, i) => ({ vehicleId: i + 1, plate, noAptos: 3 - i })),
};

const CAPACITACIONES = {
  data: [
    { id: 1, titulo: 'Manejo defensivo demo', descripcion: 'Curso demo', horas: '4', fecha: '2026-10-08', instructor: 'Instructor Demo', modalidad: 'presencial', asistentes_count: 12, asistio_count: 10 },
    { id: 2, titulo: 'Primeros auxilios demo', descripcion: null, horas: '8', fecha: '2026-10-22', instructor: null, modalidad: 'virtual', asistentes_count: 15, asistio_count: 15 },
    { id: 3, titulo: 'Fatiga y sueño demo', descripcion: 'Taller', horas: '2', fecha: '2026-11-06', instructor: 'Instructor Demo', modalidad: 'mixta', asistentes_count: 8, asistio_count: 6 },
  ],
};

const HORAS_CAPACITACION = { data: [{ userId: 101, horas: 14 }, { userId: 102, horas: 6 }] };

const INCIDENTES = {
  data: [
    { id: 1, tipo: 'accidente', fecha: '2026-10-12', gravedad: 'leve', estado: 'abierto', plate: PLACAS[0], vehicleId: 1, conductorId: 101, conductorName: NOMBRES[0], descripcion: 'Roce en parqueadero (demo)', victimasCount: 0, diasPerdidos: 0 },
    { id: 2, tipo: 'casi_accidente', fecha: '2026-10-25', gravedad: 'leve', estado: 'en_investigacion', plate: PLACAS[1], vehicleId: 2, conductorId: 102, conductorName: NOMBRES[1], descripcion: 'Frenado brusco (demo)', victimasCount: 0, diasPerdidos: 0 },
    { id: 3, tipo: 'accidente', fecha: '2026-11-03', gravedad: 'grave', estado: 'cerrado', plate: PLACAS[2], vehicleId: 3, conductorId: 103, conductorName: NOMBRES[2], descripcion: 'Colisión trasera (demo)', victimasCount: 1, diasPerdidos: 4 },
    { id: 4, tipo: 'comparendo', fecha: '2026-11-08', gravedad: 'leve', estado: 'abierto', plate: PLACAS[3], vehicleId: 4, conductorId: 104, conductorName: NOMBRES[3], descripcion: null, victimasCount: 0, diasPerdidos: 0 },
  ],
};

const INCIDENTE_DETALLE = {
  data: { ...INCIDENTES.data[0], causaRaizMetodo: '5_porques', causaRaizJsonb: { porques: ['Poca visibilidad', 'Sin espejo convexo'] }, investigacionResponsableId: 101, investigacionCerradaAt: null },
  actions: [{ id: 1, descripcion: 'Instalar espejo convexo (demo)', estado: 'pendiente', fechaLimite: '2026-11-30' }],
};

const ESTADISTICAS_INCIDENTES = {
  periodo: { from: '2026-10-01', to: '2026-11-13' },
  totales: { total: 4, accidentes: 2, casi: 1, comparendos: 1, fatales: 0, graves: 1, leves: 3, victimas_total: 1, dias_perdidos_total: 4, costos_total: '3200000', investigaciones: 2, investigaciones_cerradas: 1 },
  mensual: [
    { mes: '2026-09', total: 1, accidentes: 1, graves_fatales: 0, victimas: 0 },
    { mes: '2026-10', total: 2, accidentes: 1, graves_fatales: 0, victimas: 0 },
    { mes: '2026-11', total: 2, accidentes: 1, graves_fatales: 1, victimas: 1 },
  ],
  porCausa: [{ metodo: '5_porques', c: 2 }, { metodo: 'ishikawa', c: 1 }],
  topConductores: NOMBRES.slice(0, 3).map((name, i) => ({ conductor_id: 101 + i, name, c: 3 - i, victimas: i === 2 ? 1 : 0 })),
  indicadoresPesv: { hht: 12800, frecuencia: 15.6, severidad: 31.2, indiceGravedad: 0.49, formula: 'IF = N.º eventos × 200.000 / HHT (demo)' },
};

const CHECKLISTS = {
  data: [
    { id: 1, vehicleId: 1, plate: PLACAS[0], conductorId: 101, conductorName: NOMBRES[0], fechaHora: '2026-11-12T06:10:00.000Z', decision: 'apto', anuladoAt: null },
    { id: 2, vehicleId: 2, plate: PLACAS[1], conductorId: 102, conductorName: NOMBRES[1], fechaHora: '2026-11-12T06:25:00.000Z', decision: 'condicional', anuladoAt: null },
    { id: 3, vehicleId: 3, plate: PLACAS[2], conductorId: 103, conductorName: NOMBRES[2], fechaHora: '2026-11-11T05:55:00.000Z', decision: 'no_apto', anuladoAt: null },
    { id: 4, vehicleId: 4, plate: PLACAS[3], conductorId: 104, conductorName: NOMBRES[3], fechaHora: '2026-11-10T06:00:00.000Z', decision: 'apto', anuladoAt: '2026-11-10T08:00:00.000Z' },
  ],
};

const PLANTILLAS_CHECKLIST = { data: [{ id: 1, titulo: 'Preoperacional diario demo', vigente: true }, { id: 2, titulo: 'Preoperacional remolque demo', vigente: true }] };

const PLANTILLA_ITEMS = {
  items: [
    { id: 1, orden: 1, categoria: 'Luces', label: 'Luces delanteras', criterio: 'booleano', obligatorio: true, critico: true },
    { id: 2, orden: 2, categoria: 'Llantas', label: 'Estado de llantas', criterio: 'tres_estados', obligatorio: true, critico: false },
    { id: 3, orden: 3, categoria: 'Fluidos', label: 'Nivel de aceite (cm)', criterio: 'numerico', obligatorio: false, critico: false },
    { id: 4, orden: 4, categoria: 'Frenos', label: 'Freno de servicio', criterio: 'booleano', obligatorio: true, critico: true },
  ],
};

const ALCOHOLIMETRIA = {
  data: NOMBRES.map((name, i) => ({
    id: i + 1, conductorId: 101 + i, conductorName: name, fechaHora: `2026-11-1${i}T06:0${i}:00.000Z`, tipo: i === 3 ? 'aleatoria' : 'rutinaria',
    valorMg: i === 2 ? '0.25' : '0.00', gradoAlcohol: i === 2 ? 1 : 0, resultado: i === 2 ? 'positivo' : 'negativo', accionTomada: i === 2 ? 'Retiro de la operación (demo)' : null,
  })),
};

const CONTACTOS_EMERGENCIA = {
  data: [
    { id: 1, tipo: 'ambulancia', zona: 'Centro', nombre: 'Línea demo ambulancias', telefono: '000 000 0001', telefonoAlternativo: null, email: 'ambulancias@ejemplo.test', prioridad: 1, activo: true },
    { id: 2, tipo: 'bomberos', zona: 'Norte', nombre: 'Línea demo bomberos', telefono: '000 000 0002', telefonoAlternativo: '000 000 0012', email: null, prioridad: 2, activo: true },
    { id: 3, tipo: 'grua', zona: 'Sur', nombre: 'Grúas demo', telefono: '000 000 0003', telefonoAlternativo: null, email: 'gruas@ejemplo.test', prioridad: 3, activo: false },
  ],
};

const PROTOCOLOS_EMERGENCIA = {
  data: [
    { id: 1, titulo: 'Protocolo demo de accidente', categoria: 'accidente', descripcionMd: '1. Asegurar la zona.\n2. Llamar a emergencias.', vigente: true, version: 2 },
    { id: 2, titulo: 'Protocolo demo de incendio', categoria: 'incendio', descripcionMd: 'Usar el extintor del vehículo.', vigente: true, version: 1 },
  ],
};

const SIMULACROS = {
  data: [
    { id: 1, fecha: '2026-10-15', escenario: 'Volcamiento en vía (demo)', participantes: [101, 102, 103], observaciones: 'Tiempo de respuesta adecuado.' },
    { id: 2, fecha: '2026-11-05', escenario: 'Incendio en patio (demo)', participantes: [101, 104], observaciones: null },
  ],
};

// ── PESV: documentos y gobierno ──────────────────────────────────────────────

const POLITICAS = {
  data: [
    { id: 2, version: 2, titulo: 'Política de seguridad vial demo v2', contenidoMd: 'Compromiso demo con la seguridad vial.', estado: 'vigente', vigenciaDesde: '2026-10-01', vigenciaHasta: null, firmadaPor: 101, firmadaAt: '2026-10-01T15:00:00.000Z', optimisticV: 1, createdAt: '2026-09-28T15:00:00.000Z' },
    { id: 3, version: 3, titulo: 'Política de seguridad vial demo v3', contenidoMd: 'Borrador demo.', estado: 'borrador', vigenciaDesde: '2026-12-01', vigenciaHasta: null, firmadaPor: null, firmadaAt: null, optimisticV: 1, createdAt: '2026-11-08T15:00:00.000Z' },
    { id: 1, version: 1, titulo: 'Política de seguridad vial demo v1', contenidoMd: 'Versión anterior demo.', estado: 'reemplazada', vigenciaDesde: '2025-10-01', vigenciaHasta: '2026-09-30', firmadaPor: 101, firmadaAt: '2025-10-01T15:00:00.000Z', optimisticV: 2, createdAt: '2025-09-28T15:00:00.000Z' },
  ],
};

const COMITES = {
  data: [
    { id: 1, nombre: 'Comité de seguridad vial demo', periodicidad: 'trimestral', activo: true, createdAt: '2026-01-10T15:00:00.000Z' },
    { id: 2, nombre: 'Comité operativo demo', periodicidad: 'mensual', activo: true, createdAt: '2026-03-05T15:00:00.000Z' },
  ],
};

const ACTAS = {
  data: [
    { id: 1, numero: 7, fecha: '2026-10-14', lugar: 'Sala demo', estado: 'cerrada', agendaMd: 'Revisión de indicadores.', decisionesMd: 'Reforzar capacitación.' },
    { id: 2, numero: 8, fecha: '2026-11-11', lugar: null, estado: 'borrador', agendaMd: 'Plan anual.', decisionesMd: null },
  ],
};

const PLANES = {
  data: [
    { id: 2, anio: 2027, objetivoGeneral: 'Reducir la siniestralidad demo en 20 %', presupuestoCop: '45000000', estado: 'borrador', aprobadoAt: null, optimisticV: 1 },
    { id: 1, anio: 2026, objetivoGeneral: 'Consolidar el PESV demo', presupuestoCop: '38000000', estado: 'aprobado', aprobadoAt: '2026-01-20T15:00:00.000Z', optimisticV: 2 },
    { id: 0, anio: 2025, objetivoGeneral: 'Implementar el PESV demo', presupuestoCop: '30000000', estado: 'cerrado', aprobadoAt: '2025-01-20T15:00:00.000Z', optimisticV: 3 },
  ],
};

const fase = (score: number, estandares: number, cubiertos: number, parciales: number) =>
  ({ score, estandares, cubiertos, parciales, ausentes: estandares - cubiertos - parciales });
const TABLERO_PESV = {
  anio: 2026, trimestre: '2026-Q4',
  documentos: {
    politicaVigente: { id: 2, version: 2, titulo: 'Política de seguridad vial demo v2', firmadaAt: '2026-10-01T15:00:00.000Z' },
    planActual: { id: 1, anio: 2026, estado: 'aprobado', presupuestoCop: '38000000' },
    planProximo: { anio: 2027, estado: 'borrador' },
    diagnosticoActual: { id: 1, estado: 'borrador', scoreGlobal: 68.5 },
    ultimaActaComite: { id: 2, numero: 8, fecha: '2026-11-11', estado: 'borrador' },
  },
  cumplimiento: {
    diagnosticoReferencia: { id: 1, anio: 2026, scoreGlobal: 68.5 },
    scoresPorFase: { planear: fase(80, 10, 7, 2), hacer: fase(65, 8, 4, 3), verificar: fase(55, 3, 1, 1), actuar: fase(40, 3, 1, 0) },
    estandaresPorFase: {
      planear: [{ codigo: 'P1.1', nombre: 'Líder del PESV', score: 100, estado: 'cubierto' }, { codigo: 'P1.2', nombre: 'Comité de seguridad vial', score: 50, estado: 'parcial' }],
      hacer: [{ codigo: 'H4.1', nombre: 'Gestión de conductores', score: 75, estado: 'parcial' }],
      verificar: [{ codigo: 'V5.1', nombre: 'Indicadores', score: 50, estado: 'parcial' }],
      actuar: [{ codigo: 'A6.1', nombre: 'Acciones correctivas y preventivas', score: 0, estado: 'ausente' }],
    },
    total24Pasos: 24,
  },
  jornadasMes: { total: 86, cerradasAutomatica: 4, horasTotales: '712.5', alarmasMes: 9, alarmasPendientes: 3, conductoresExcedenSemanal: 1 },
  rutas: { total: 5, conAnalisisTrimestre: 3, sinAnalisisTrimestre: 2 },
};

const AUDITORIAS = {
  data: [
    { id: 1, anio: 2026, tipo: 'interna', alcance: 'PESV completo (demo)', fechaPlanificada: '2026-10-20', fechaInicio: '2026-10-20', fechaCierre: '2026-10-24', auditorExterno: null, estado: 'cerrada', resumen: 'Sin hallazgos críticos.' },
    { id: 2, anio: 2026, tipo: 'externa', alcance: 'Pasos 10 a 16 (demo)', fechaPlanificada: '2026-11-18', fechaInicio: null, fechaCierre: null, auditorExterno: 'Auditora Demo S.A.S.', estado: 'planificada', resumen: null },
    { id: 3, anio: 2026, tipo: 'supert', alcance: 'Reporte anual (demo)', fechaPlanificada: '2026-11-10', fechaInicio: '2026-11-10', fechaCierre: null, auditorExterno: null, estado: 'en_curso', resumen: null },
  ],
};

const AUDITORIA_DETALLE = {
  ...AUDITORIAS.data[0],
  hallazgos: [
    { id: 1, auditoriaId: 1, pasoPesv: 12, severidad: 'no_conformidad_menor', descripcion: 'Registro incompleto de mantenimiento (demo).', estado: 'en_remediacion', fechaLimite: '2026-11-30', cerradoAt: null, accionesMd: null },
    { id: 2, auditoriaId: 1, pasoPesv: null, severidad: 'observacion', descripcion: 'Mejorar la señalización del patio (demo).', estado: 'abierto', fechaLimite: null, cerradoAt: null, accionesMd: null },
  ],
};

const COMUNICACIONES = {
  data: [
    { id: 1, tipo: 'politica', asunto: 'Nueva política de seguridad vial (demo)', cuerpoMd: 'Lean la política vigente.', destinatariosRoles: ['admin', 'conductor'], publicadoAt: '2026-10-02T15:00:00.000Z', vencimientoAcuse: '2026-10-16', acusesCount: 18, createdAt: '2026-10-01T15:00:00.000Z' },
    { id: 2, tipo: 'lecciones_aprendidas', asunto: 'Lección: frenado en pendiente (demo)', cuerpoMd: 'Resumen del caso.', destinatariosRoles: ['conductor'], publicadoAt: '2026-11-04T15:00:00.000Z', vencimientoAcuse: null, acusesCount: 7, createdAt: '2026-11-03T15:00:00.000Z' },
    { id: 3, tipo: 'recordatorio', asunto: 'Recordatorio de preoperacional (demo)', cuerpoMd: 'Diario antes de salir.', destinatariosRoles: ['conductor'], publicadoAt: null, vencimientoAcuse: null, acusesCount: 0, createdAt: '2026-11-12T15:00:00.000Z' },
  ],
};

const CONTRATISTAS = {
  data: [
    { id: 1, razonSocial: 'Transportes Demo Uno S.A.S.', nit: '990000101', contactoNombre: NOMBRES[0], contactoEmail: CORREOS[0], contactoTelefono: '000 000 0101', pesvNivel: 'avanzado', pesvVencimiento: '2027-02-28', evaluacion: 'apto', proximaEvaluacion: '2027-02-01', estado: 'vinculado', observaciones: null },
    { id: 2, razonSocial: 'Logística Demo Dos S.A.S.', nit: '990000102', contactoNombre: NOMBRES[1], contactoEmail: CORREOS[1], contactoTelefono: null, pesvNivel: 'estandar', pesvVencimiento: '2026-11-30', evaluacion: 'apto_condicional', proximaEvaluacion: '2026-11-25', estado: 'vinculado', observaciones: 'Renovar PESV (demo).' },
    { id: 3, razonSocial: 'Carga Demo Tres Ltda.', nit: '990000103', contactoNombre: null, contactoEmail: null, contactoTelefono: null, pesvNivel: null, pesvVencimiento: null, evaluacion: 'no_apto', proximaEvaluacion: null, estado: 'suspendido', observaciones: null },
  ],
};

const NORMATIVA = {
  data: [
    { id: 1, codigo: 'RES-DEMO-001', tipo: 'resolucion', titulo: 'Resolución demo sobre el PESV', emisor: 'Ministerio Demo', fechaPublicacion: '2026-10-01', vigente: true, aplicaA: ['pesv', 'conductores'], urlOficial: null, resumenMd: 'Resumen demo.', ultimaRevisionAt: '2026-10-15T15:00:00.000Z', proximaRevisionAt: '2027-04-15', notasMd: null, optimisticV: 1 },
    { id: 2, codigo: 'DEC-DEMO-002', tipo: 'decreto', titulo: 'Decreto demo de jornadas', emisor: 'Gobierno Demo', fechaPublicacion: '2026-10-20', vigente: true, aplicaA: ['jornadas'], urlOficial: null, resumenMd: null, ultimaRevisionAt: null, proximaRevisionAt: '2026-11-20', notasMd: null, optimisticV: 1 },
    { id: 3, codigo: 'CIR-DEMO-003', tipo: 'circular', titulo: 'Circular demo derogada', emisor: 'Superintendencia Demo', fechaPublicacion: '2026-10-05', vigente: false, aplicaA: [], urlOficial: null, resumenMd: null, ultimaRevisionAt: '2026-11-01T15:00:00.000Z', proximaRevisionAt: '2027-11-01', notasMd: 'Derogada (demo).', optimisticV: 2 },
  ],
};

const NORMA_DETALLE = { ...NORMATIVA.data[0], revisiones: [{ id: 1, revisadaAt: '2026-10-15T15:00:00.000Z', cambiosObservados: 'Sin cambios (demo).', proximaRevisionAt: '2027-04-15' }] };

const RETENCION_POLITICAS = {
  data: [
    { id: 1, tipoDocumento: 'preoperacional', retencionAnios: 2, baseLegal: 'Norma demo art. 1', accion: 'purgar', habilitado: true, notasMd: null, optimisticV: 1 },
    { id: 2, tipoDocumento: 'alcoholimetria', retencionAnios: 5, baseLegal: 'Norma demo art. 2', accion: 'anonimizar', habilitado: true, notasMd: 'Demo', optimisticV: 1 },
    { id: 3, tipoDocumento: 'jornada', retencionAnios: 3, baseLegal: 'Norma demo art. 3', accion: 'archivar_offline', habilitado: false, notasMd: null, optimisticV: 2 },
  ],
};

const RETENCION_LOG = {
  data: [
    { id: 1, politicaId: 1, tipoDocumento: 'preoperacional', cantidadAfectada: 140, cutoffDate: '2024-10-01', accion: 'purgar', ejecutadoAt: '2026-10-01T03:00:00.000Z', ejecutadoPorCron: true, detalleMd: null },
    { id: 2, politicaId: 2, tipoDocumento: 'alcoholimetria', cantidadAfectada: 12, cutoffDate: '2021-11-01', accion: 'anonimizar', ejecutadoAt: '2026-11-01T03:00:00.000Z', ejecutadoPorCron: true, detalleMd: null },
    { id: 3, politicaId: null, tipoDocumento: 'jornada', cantidadAfectada: 0, cutoffDate: '2023-11-01', accion: 'archivar_offline', ejecutadoAt: '2026-11-05T15:00:00.000Z', ejecutadoPorCron: false, detalleMd: 'Ejecución manual (demo).' },
  ],
};

// ── PESV: jornadas, rutas, pernocta ──────────────────────────────────────────

const JORNADAS = {
  data: [
    { id: 1, conductorId: 101, vehicleId: 1, inicioAt: '2026-11-12T05:30:00.000Z', finAt: '2026-11-12T15:00:00.000Z', horasConduccion: '8.5', horasDescansoPre: '10', cerrada: true, cerradaAutomatica: false },
    { id: 2, conductorId: 102, vehicleId: 2, inicioAt: '2026-11-12T06:00:00.000Z', finAt: '2026-11-12T18:30:00.000Z', horasConduccion: '11.2', horasDescansoPre: '7.5', cerrada: true, cerradaAutomatica: true },
    { id: 3, conductorId: 103, vehicleId: 3, inicioAt: '2026-11-13T05:45:00.000Z', finAt: null, horasConduccion: null, horasDescansoPre: '9', cerrada: false, cerradaAutomatica: false },
  ],
};

const PAUSAS = [
  { id: 1, motivo: 'pausa_activa', inicioAt: '2026-11-13T08:00:00.000Z', finAt: '2026-11-13T08:15:00.000Z', duracionMin: 15 },
  { id: 2, motivo: 'alimentacion', inicioAt: '2026-11-13T11:30:00.000Z', finAt: null, duracionMin: null },
];

const JORNADA_DETALLE = {
  ...JORNADAS.data[1],
  pausas: PAUSAS,
  alarmas: [
    { id: 1, jornadaId: 2, tipo: 'mas_10h_jornada', valorObservado: '12.5', valorLimite: '10', unidad: 'h', ackAt: null, generadaAt: '2026-11-12T16:00:00.000Z' },
    { id: 2, jornadaId: 2, tipo: 'menos_8h_descanso', valorObservado: '7.5', valorLimite: '8', unidad: 'h', ackAt: '2026-11-12T17:00:00.000Z', generadaAt: '2026-11-12T06:00:00.000Z' },
  ],
};

const JORNADA_ABIERTA = { ...JORNADAS.data[2], pausas: PAUSAS };

const RUTAS = {
  data: [
    { id: 1, codigo: 'RT-DEMO-01', nombre: 'Ruta demo norte', origen: 'Bogotá', destino: 'Tunja', distanciaKm: '140', duracionEstimadaMin: 180, criticidad: 'media', activo: true, optimisticV: 1 },
    { id: 2, codigo: 'RT-DEMO-02', nombre: 'Ruta demo occidente', origen: 'Medellín', destino: 'Manizales', distanciaKm: '195', duracionEstimadaMin: 300, criticidad: 'alta', activo: true, optimisticV: 1 },
    { id: 3, codigo: 'RT-DEMO-03', nombre: 'Ruta demo sur', origen: 'Cali', destino: 'Popayán', distanciaKm: '140', duracionEstimadaMin: 200, criticidad: 'critica', activo: true, optimisticV: 2 },
    { id: 4, codigo: 'RT-DEMO-04', nombre: 'Ruta demo urbana', origen: 'Bogotá', destino: 'Bogotá', distanciaKm: null, duracionEstimadaMin: null, criticidad: 'baja', activo: false, optimisticV: 1 },
  ],
};

const RUTA_DETALLE = {
  ...RUTAS.data[0],
  waypoints: [
    { id: 1, routeId: 1, orden: 1, tipo: 'origen', nombre: 'Patio demo', lat: '4.60', lng: '-74.08', descripcion: null },
    { id: 2, routeId: 1, orden: 2, tipo: 'peaje', nombre: 'Peaje demo', lat: null, lng: null, descripcion: null },
    { id: 3, routeId: 1, orden: 3, tipo: 'destino', nombre: 'Bodega demo', lat: '5.53', lng: '-73.36', descripcion: 'Cargue (demo)' },
  ],
};

const RIESGOS_RUTA = {
  data: [
    { id: 1, routeId: 1, trimestre: '2026-Q4', fecha: '2026-10-05', estado: 'aprobado', resumen: 'Sin cambios relevantes (demo).', optimisticV: 1 },
    { id: 2, routeId: 1, trimestre: '2026-Q3', fecha: '2026-07-05', estado: 'aprobado', resumen: null, optimisticV: 1 },
  ],
};

const PERNOCTAS = {
  data: [
    { id: 1, nombre: 'Parador demo norte', routeId: 1, lat: '5.10', lng: '-73.70', capacidad: 12, contacto: NOMBRES[2], telefono: '000 000 0201', servicios: ['parqueadero', 'baño', 'restaurante'], vigente: true },
    { id: 2, nombre: 'Estación demo occidente', routeId: 2, lat: null, lng: null, capacidad: 6, contacto: null, telefono: null, servicios: ['parqueadero'], vigente: true },
    { id: 3, nombre: 'Hotel demo sur', routeId: null, lat: null, lng: null, capacidad: null, contacto: NOMBRES[3], telefono: '000 000 0203', servicios: [], vigente: false },
  ],
};

// ── RNDC ─────────────────────────────────────────────────────────────────────

const RNDC_RESUMEN = {
  rango: { desde: '2026-10-01', hasta: '2026-11-13' },
  manifiestos: { borradores: '3', listos: '2', radicados: '5', aceptados: '12', rechazados: '1', cumplidos: '20', anulados: '1', total: '44' },
  remesas: { borradores: '4', activas_sin_manifiesto: '3', cumplidas: '30', anuladas: '2', total: '39' },
  revenue: { revenue_total: '86500000', revenue_facturable: '79200000', anticipos: '21000000' },
};

const MAESTROS = {
  data: NOMBRES.map((nombre, i) => ({
    id: i + 1, tipo: i === 3 ? 'juridica' : 'natural', tipoDoc: i === 3 ? 'NIT' : 'CC', documento: i === 3 ? '990000301' : CEDULAS[i], nombre,
    direccion: `Calle demo ${i + 1} # 0-0${i}`, ciudadDane: ['11001', '05001', '76001', '17001'][i], telefono: i === 2 ? null : `000 000 03${i}0`,
    email: i === 2 ? null : CORREOS[i], activo: i !== 2,
  })),
};

const MUNICIPIOS = {
  data: [
    { codigoDane: '11001', nombre: 'Bogotá, D.C.', departamentoNombre: 'Bogotá, D.C.' },
    { codigoDane: '05001', nombre: 'Medellín', departamentoNombre: 'Antioquia' },
    { codigoDane: '76001', nombre: 'Cali', departamentoNombre: 'Valle del Cauca' },
    { codigoDane: '17001', nombre: 'Manizales', departamentoNombre: 'Caldas' },
  ],
};
const PRODUCTOS = { data: [{ codigo: '009880', nombre: 'Producto demo varios' }, { codigo: '009881', nombre: 'Producto demo alimentos' }, { codigo: '009882', nombre: 'Producto demo materiales' }] };
const EMPAQUES = { data: [{ codigo: '0', nombre: 'Paquetes (demo)' }, { codigo: '1', nombre: 'Granel (demo)' }, { codigo: '2', nombre: 'Estibas (demo)' }] };
const UNIDADES = { data: [{ codigo: 'KG', nombre: 'Kilogramos' }, { codigo: 'GL', nombre: 'Galones' }, { codigo: 'UN', nombre: 'Unidades' }] };

const REMESAS = {
  data: [
    { id: 1, numero: 'REM-DEMO-0001', consecutivoRndc: '990001', estado: 'activa', clientId: 901, clientName: 'Concesionario Demo Norte', origenNombre: 'Bogotá, D.C.', municipioOrigenDane: '11001', municipioDestinoDane: '05001', cantidadCargada: '12000', pesoKg: '12000', valorFlete: '3200000', fechaCargue: '2026-11-10', manifiestoId: null, cumplidoAt: null },
    { id: 2, numero: 'REM-DEMO-0002', consecutivoRndc: null, estado: 'borrador', clientId: 902, clientName: 'Concesionario Demo Sur', origenNombre: 'Medellín', municipioOrigenDane: '05001', municipioDestinoDane: '76001', cantidadCargada: '8000', pesoKg: null, valorFlete: '2600000', fechaCargue: '2026-11-12', manifiestoId: null, cumplidoAt: null },
    { id: 3, numero: 'REM-DEMO-0003', consecutivoRndc: '990003', estado: 'cumplida', clientId: 903, clientName: 'Concesionario Demo Centro', origenNombre: 'Cali', municipioOrigenDane: '76001', municipioDestinoDane: '17001', cantidadCargada: '15000', pesoKg: '15000', valorFlete: '4100000', fechaCargue: '2026-10-22', manifiestoId: 1, cumplidoAt: '2026-10-25T15:00:00.000Z' },
    { id: 4, numero: 'REM-DEMO-0004', consecutivoRndc: null, estado: 'anulada', clientId: null, clientName: null, origenNombre: null, municipioOrigenDane: '17001', municipioDestinoDane: '11001', cantidadCargada: '500', pesoKg: '500', valorFlete: '900000', fechaCargue: '2026-10-18', manifiestoId: null, cumplidoAt: null },
  ],
};

const REMESA_DETALLE = {
  data: {
    ...REMESAS.data[0], id: 1, propietarioCargaId: 1, destinatarioCargaId: 2, direccionCargue: 'Calle demo 1 # 0-01', direccionDescargue: 'Carrera demo 2 # 0-02',
    productoCodigo: '009880', naturaleza: 'carga_normal', empaqueCodigo: '0', unidadMedidaCodigo: 'KG', horaCargue: '07:30', valorAnticipo: '800000', observaciones: 'Remesa demo',
  },
};

const MANIFIESTOS = {
  total: 4,
  data: [
    { id: 1, numero: 'MAN-DEMO-0001', consecutivoRndc: '880001', estado: 'cumplido', fechaExpedicion: '2026-10-22', valorFleteTotal: '4100000', placaPrincipal: PLACAS[0], conductorNombre: NOMBRES[0], origenDane: '76001', destinoDane: '17001', radicadoAt: '2026-10-22T16:00:00.000Z', cumplidoAt: '2026-10-25T15:00:00.000Z' },
    { id: 2, numero: 'MAN-DEMO-0002', consecutivoRndc: '880002', estado: 'aceptado', fechaExpedicion: '2026-11-05', valorFleteTotal: '3200000', placaPrincipal: PLACAS[1], conductorNombre: NOMBRES[1], origenDane: '11001', destinoDane: '05001', radicadoAt: '2026-11-05T16:00:00.000Z', cumplidoAt: null },
    { id: 3, numero: 'MAN-DEMO-0003', consecutivoRndc: null, estado: 'borrador', fechaExpedicion: '2026-11-12', valorFleteTotal: '2600000', placaPrincipal: PLACAS[2], conductorNombre: null, origenDane: '05001', destinoDane: '76001', radicadoAt: null, cumplidoAt: null },
    { id: 4, numero: 'MAN-DEMO-0004', consecutivoRndc: null, estado: 'rechazado', fechaExpedicion: '2026-11-08', valorFleteTotal: '1800000', placaPrincipal: PLACAS[3], conductorNombre: NOMBRES[3], origenDane: '17001', destinoDane: '11001', radicadoAt: '2026-11-08T16:00:00.000Z', cumplidoAt: null },
  ],
};

/**
 * Va al PRINCIPIO de `TABLA` del barrido: gana a lo cosechado. Regex sobre el pathname (sin query),
 * ancladas con `$`, las específicas antes que las genéricas (`/drivers/incidents` antes de `/drivers/:id`).
 * `/fleet/documents/expiring` y `/rndc/manifiestos` son superconjuntos de los fixtures del panel de inicio.
 */
export const TABLA_EXTRA: Array<[RegExp, ManejadorDemo]> = [
  // Flota
  [/\/api\/fleet\/documents\/expiring$/, ok(VENCIMIENTOS)],
  [/\/api\/fleet\/vehicles\/[^/]+$/, ok(VEHICULO_DETALLE)],
  [/\/api\/fleet\/vehicles$/, ok({ data: VEHICULOS })],
  // Mantenimiento
  [/\/api\/maintenance\/schedule$/, ok(PROGRAMACION)],
  [/\/api\/maintenance\/indicators$/, ok(INDICADORES_MTO)],
  [/\/api\/maintenance\/routines$/, ok(RUTINAS)],
  [/\/api\/maintenance\/jobs$/, ok(TRABAJOS)],
  [/\/api\/maintenance\/work-orders\/[^/]+$/, ok(ORDEN_DETALLE)],
  [/\/api\/maintenance\/work-orders$/, ok(ORDENES)],
  [/\/api\/parts\/locations$/, ok(BODEGAS)],
  [/\/api\/parts$/, ok(REPUESTOS)],
  [/\/api\/liquidaciones$/, ok(LIQUIDACIONES)],
  // LAFT, conciliación, métricas
  [/\/api\/laft\/unusual$/, ok(LAFT_UNUSUAL)],
  [/\/api\/flito\/conciliacion\/boletas\/demo-1$/, ok(CONCILIACION_DETALLE)],
  [/\/api\/tramites\/metrics\/summary$/, ok(METRICAS_TRAMITES)],
  // PESV: /drivers/*
  [/\/api\/drivers\/pesv-indicators$/, ok(INDICADORES_PESV)],
  [/\/api\/drivers\/operational-indicators$/, ok(INDICADORES_OPERACION)],
  [/\/api\/drivers\/candidates\/non-driver$/, ok(NO_CONDUCTORES)],
  [/\/api\/drivers\/trainings\/report\/horas-conductor$/, ok(HORAS_CAPACITACION)],
  [/\/api\/drivers\/trainings$/, ok(CAPACITACIONES)],
  [/\/api\/drivers\/incidents\/stats$/, ok(ESTADISTICAS_INCIDENTES)],
  [/\/api\/drivers\/incidents\/[^/]+$/, ok(INCIDENTE_DETALLE)],
  [/\/api\/drivers\/incidents$/, ok(INCIDENTES)],
  [/\/api\/drivers\/checklists\/templates\/[^/]+$/, ok(PLANTILLA_ITEMS)],
  [/\/api\/drivers\/checklists\/templates$/, ok(PLANTILLAS_CHECKLIST)],
  [/\/api\/drivers\/checklists$/, ok(CHECKLISTS)],
  [/\/api\/drivers\/alcohol-tests$/, ok(ALCOHOLIMETRIA)],
  [/\/api\/drivers\/emergency\/contacts$/, ok(CONTACTOS_EMERGENCIA)],
  [/\/api\/drivers\/emergency\/protocols$/, ok(PROTOCOLOS_EMERGENCIA)],
  [/\/api\/drivers\/emergency\/drills$/, ok(SIMULACROS)],
  [/\/api\/drivers\/[^/]+$/, ok(CONDUCTOR_DETALLE)],
  [/\/api\/drivers$/, ok(CONDUCTORES)],
  // PESV: /pesv/*
  [/\/api\/pesv\/policy$/, ok(POLITICAS)],
  [/\/api\/pesv\/comite\/[^/]+\/actas$/, ok(ACTAS)],
  [/\/api\/pesv\/comite$/, ok(COMITES)],
  [/\/api\/pesv\/plan$/, ok(PLANES)],
  [/\/api\/pesv\/tablero$/, ok(TABLERO_PESV)],
  [/\/api\/pesv\/auditorias\/[^/]+$/, ok(AUDITORIA_DETALLE)],
  [/\/api\/pesv\/auditorias$/, ok(AUDITORIAS)],
  [/\/api\/pesv\/comunicaciones$/, ok(COMUNICACIONES)],
  [/\/api\/pesv\/contratistas$/, ok(CONTRATISTAS)],
  [/\/api\/pesv\/normativa\/[^/]+$/, ok(NORMA_DETALLE)],
  [/\/api\/pesv\/normativa$/, ok(NORMATIVA)],
  [/\/api\/pesv\/retencion\/politicas$/, ok(RETENCION_POLITICAS)],
  [/\/api\/pesv\/retencion\/log$/, ok(RETENCION_LOG)],
  // `/pesv/diagnostico/demo-1` llega como `/pesv/diagnostico/NaN` (la página hace parseInt del id).
  [/\/api\/pesv\/diagnostico\/[^/]+\/preflight$/, ok(buildPreflight({ evaluados: 18, conEvidencia: 12, scoreProyectado: 68.5 }))],
  [/\/api\/pesv\/diagnostico\/[^/]+$/, ok(buildDiagDetail({ id: 1, anio: 2026, scoreGlobal: '68.50' }))],
  // PESV: jornadas, rutas, pernocta
  [/\/api\/jornadas\/abierta$/, ok(JORNADA_ABIERTA)],
  [/\/api\/jornadas\/[^/]+$/, ok(JORNADA_DETALLE)],
  [/\/api\/jornadas$/, ok(JORNADAS)],
  [/\/api\/rutas\/pernocta$/, ok(PERNOCTAS)],
  [/\/api\/rutas\/risk$/, ok(RIESGOS_RUTA)],
  [/\/api\/rutas\/[^/]+$/, ok(RUTA_DETALLE)],
  [/\/api\/rutas$/, ok(RUTAS)],
  // RNDC
  [/\/api\/rndc\/indicadores\/resumen$/, ok(RNDC_RESUMEN)],
  [/\/api\/rndc\/catalogos\/municipios$/, ok(MUNICIPIOS)],
  [/\/api\/rndc\/catalogos\/productos$/, ok(PRODUCTOS)],
  [/\/api\/rndc\/catalogos\/empaques$/, ok(EMPAQUES)],
  [/\/api\/rndc\/catalogos\/unidades$/, ok(UNIDADES)],
  [/\/api\/rndc\/(tenedores|propietarios-carga|destinatarios-carga)$/, ok(MAESTROS)],
  [/\/api\/rndc\/remesas\/[^/]+$/, ok(REMESA_DETALLE)],
  [/\/api\/rndc\/remesas$/, ok(REMESAS)],
  [/\/api\/rndc\/manifiestos$/, ok(MANIFIESTOS)],
];
