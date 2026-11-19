// Torre de Control Gerencial (Épica #14590) — exportación a Excel de un tablero
// (`POST /api/flito/torre/tableros/<tablero>/exportar`).
//
// RN-TOR-XT1: una hoja por BLOQUE del tablero, armada con la respuesta del MISMO servicio que pinta la pantalla
//   (`tableroComercial`, `tableroOperativo`…): mismos filtros, alcance, topes, caché y permiso de dinero.
// RN-TOR-XT2: solo agregados. Sin placa, VIN ni datos de una persona: la carga por FUNCIONARIO (nombres de personas)
//   no se exporta, y la frase de un riesgo va sin su `impacto` (clave interna de orden).
// RN-TOR-XT3: sin `FUNCION_TORRE_DINERO` las columnas (y filas de cifras) de dinero NO van al archivo, y una hoja que
//   solo tiene dinero (concentración por ingreso, margen) tampoco.
// RN-TOR-XT4: nombre `torre-<tablero>-<desde>_<hasta>.xlsx` con el rango resuelto del tablero.
// RN-TOR-XT5 (ADR-0047): última hoja «Definiciones» (clave, frase y definición de cada KPI explicada).
import ExcelJS from 'exceljs';
import type { Response } from 'express';
import type {
  CifraExplicada, ConcentracionTorre, TableroComercial, TableroEjecutivo, TableroFinanciero, TableroOperativo,
} from '@operaciones/shared-types';
import { MIME_XLSX, type ExcelColumn } from '../../shared/utils/excel.js';
import { tableroComercial } from './flito-torre.comercial.service.js';
import { textoSeguro } from './flito-torre.export.js';
import { tableroEjecutivo } from './flito-torre.ejecutivo.service.js';
import { tableroFinanciero } from './flito-torre.financiera.service.js';
import { tableroOperativo } from './flito-torre.operativa.service.js';
import type { ContextoTablero } from './flito-torre.tablero-comun.js';

export const TABLEROS_EXPORTABLES = ['comercial', 'operativa', 'financiera', 'ejecutivo'] as const;
export type TableroExportable = (typeof TABLEROS_EXPORTABLES)[number];

/** Columna con marca de dinero (se omite sin `FUNCION_TORRE_DINERO`). */
export interface ColumnaHoja extends ExcelColumn { dinero?: boolean }
export interface HojaTablero { nombre: string; columnas: ColumnaHoja[]; filas: Record<string, unknown>[] }

const COP = '#,##0';
const col = (header: string, key: string, extra: Partial<ColumnaHoja> = {}): ColumnaHoja => ({ header, key, width: 18, ...extra });
const DINERO = { dinero: true, numFmt: COP } as const;

interface Cifra { concepto: string; valor: unknown; dinero?: boolean }
const hojaCifras = (nombre: string, cifras: Cifra[]): HojaTablero & { cifras: Cifra[] } => ({
  nombre, columnas: [col('Concepto', 'concepto', { width: 40 }), col('Valor', 'valor')], filas: [], cifras,
});

function concentracion(nombre: string, c: ConcentracionTorre, etiqueta: string, dinero = false): HojaTablero {
  return {
    nombre,
    columnas: [col('Compañía', 'compania', { width: 36 }), col(etiqueta, 'valor', dinero ? DINERO : {}), col('Participación %', 'pct')],
    filas: [
      ...c.top.map((t) => ({ compania: t.compania, valor: t.valor, pct: t.pct })),
      ...(c.demas.n ? [{ compania: `Demás (${c.demas.n})`, valor: c.demas.valor, pct: c.demas.pct }] : []),
      { compania: 'Total', valor: c.total, pct: 100 },
    ],
  };
}

function hojasComercial(t: TableroComercial): HojaTablero[] {
  return [
    hojaCifras('Cifras', [
      { concepto: 'Clientes en caída', valor: t.cifras.clientesEnCaida },
      { concepto: 'Concentración top 3 %', valor: t.cifras.concentracionTop3Pct },
      { concepto: 'Concentración top 5 %', valor: t.cifras.concentracionTop5Pct },
      { concepto: 'Conversión a facturado %', valor: t.cifras.conversionFacturadoPct },
      { concepto: 'Trámites del periodo', valor: t.cifras.tramitesPeriodo },
      { concepto: 'Trámites del periodo anterior', valor: t.cifras.tramitesPeriodoAnterior },
    ]),
    {
      nombre: 'Fuga de clientes',
      columnas: [col('Compañía', 'compania', { width: 36 }), col(`Trámites (${t.fuga.ventanaDias} días)`, 'tramitesVentana'),
        col('Promedio', 'promedio'), col('Variación %', 'variacionPct')],
      filas: t.fuga.filas.map((f) => ({ compania: f.compania, tramitesVentana: f.tramitesVentana, promedio: f.promedio, variacionPct: f.variacionPct })),
    },
    concentracion('Concentración volumen', t.concentracion.volumen, 'Trámites'),
    ...(t.concentracion.ingreso ? [concentracion('Concentración ingreso', t.concentracion.ingreso, 'Ingreso', true)] : []),
    {
      nombre: 'Embudo',
      columnas: [col('Paso', 'paso'), col('Trámites', 'valor'), col('% de creados', 'pct')],
      filas: t.embudo.pasos.map((p) => ({ paso: p.paso, valor: p.valor, pct: p.pct })),
    },
    {
      nombre: 'Tendencia',
      columnas: [col('Corte', 'corte'), col('Periodo', 'periodo'), col('Trámites', 'valor')],
      filas: [
        ...t.tendencia.mensual.map((s) => ({ corte: 'Mensual', periodo: s.etiqueta, valor: s.valor })),
        ...t.tendencia.trimestral.map((s) => ({ corte: 'Trimestral', periodo: s.etiqueta, valor: s.valor })),
      ],
    },
    {
      nombre: 'Venta cruzada',
      columnas: [col('Compañía', 'compania', { width: 36 }), col('Trámites', 'tramites'), col('Trámites (línea)', 'l_tramites'),
        col('SOAT', 'l_soat'), col('Impuestos', 'l_impuestos'), col('Derechos', 'l_derechos'), col('Logística', 'l_logistica')],
      filas: t.ventaCruzada.filas.map((f) => ({
        compania: f.compania, tramites: f.tramites, l_tramites: f.lineas.tramites, l_soat: f.lineas.soat,
        l_impuestos: f.lineas.impuestos, l_derechos: f.lineas.derechos, l_logistica: f.lineas.logistica,
      })),
    },
  ];
}

function hojasOperativa(t: TableroOperativo): HojaTablero[] {
  return [
    hojaCifras('Cifras', [
      { concepto: 'Sin gestión fuera de ANS', valor: t.cifras.sinGestionFueraAns },
      { concepto: 'Borradores abandonados', valor: t.cifras.borradoresAbandonados },
      { concepto: 'Trámites en curso', valor: t.cifras.wip },
      { concepto: 'Entrega al primer intento %', valor: t.cifras.primerIntentoPct },
    ]),
    {
      nombre: 'Radar',
      columnas: [col('Causa', 'etiqueta', { width: 40 }), col('Cantidad', 'cantidad'), col('Umbral', 'umbral'), col('Unidad', 'unidad'), col('Severidad', 'severidad')],
      filas: t.radar.filas.map((f) => ({ etiqueta: f.etiqueta, cantidad: f.cantidad, umbral: f.umbral, unidad: f.unidad, severidad: f.severidad })),
    },
    {
      nombre: 'Carga por organismo',
      columnas: [col('Organismo', 'etiqueta', { width: 40 }), col('Trámites en curso', 'valor')],
      filas: t.carga.porOrganismo.map((s) => ({ etiqueta: s.etiqueta, valor: s.valor })),
    },
    {
      nombre: 'Comparativo OT',
      columnas: [col('Organismo', 'organismo', { width: 40 }), col('Volumen', 'volumen'), col('Aprobado %', 'pctAprobado'),
        col('Rechazado %', 'pctRechazado'), col('Pendientes', 'pendientes'), col('Mediana respuesta (días)', 'medianaRespuestaDias'),
        col(`Sobre umbral (${t.benchmarkOt.umbralDias} días)`, 'sobreUmbral')],
      filas: t.benchmarkOt.filas.map((f) => ({
        organismo: f.organismo, volumen: f.volumen, pctAprobado: f.pctAprobado, pctRechazado: f.pctRechazado,
        pendientes: f.pendientes, medianaRespuestaDias: f.medianaRespuestaDias, sobreUmbral: f.sobreUmbral ? 'Sí' : 'No',
      })),
    },
    hojaCifras('Logística', [
      { concepto: 'Entregas', valor: t.logistica.entregas },
      { concepto: 'Al primer intento', valor: t.logistica.primerIntento },
      { concepto: 'Al primer intento %', valor: t.logistica.primerIntentoPct },
      { concepto: 'Viajes adicionales', valor: t.logistica.viajesAdicionales },
      { concepto: 'Tiempo medio de entrega (días)', valor: t.logistica.tiempoMedioEntregaDias },
    ]),
  ];
}

function hojasFinanciera(t: TableroFinanciero): HojaTablero[] {
  const m = t.cifras.menorCobertura;
  return [
    hojaCifras('Cifras', [
      { concepto: 'Menor cobertura (compañía)', valor: m?.compania ?? null },
      { concepto: 'Menor cobertura (días)', valor: m?.dias ?? null },
      { concepto: 'Sin facturar (valor)', valor: t.cifras.sinFacturarValor, dinero: true },
      { concepto: 'Sin facturar (trámites)', valor: t.cifras.sinFacturarTramites },
      { concepto: 'Margen %', valor: t.cifras.margenPct, dinero: true },
      { concepto: 'Soportes completos %', valor: t.cifras.soportesCompletosPct },
    ]),
    {
      nombre: 'Bolsas',
      columnas: [col('Compañía', 'compania', { width: 36 }), col('Saldo', 'saldo', DINERO), col('Consumo diario', 'consumoDiario', DINERO),
        col('Días de cobertura', 'diasCobertura'), col('Severidad', 'severidad')],
      filas: t.bolsas.filas.map((f) => ({ compania: f.compania, saldo: f.saldo, consumoDiario: f.consumoDiario, diasCobertura: f.diasCobertura, severidad: f.severidad })),
    },
    {
      nombre: 'Sin facturar',
      columnas: [col('Compañía', 'compania', { width: 36 }), col('Trámites', 'tramites'), col('Valor estimado', 'valorEstimado', DINERO),
        col('Más antiguo (días)', 'masAntiguoDias')],
      filas: t.sinFacturar.filas.map((f) => ({ compania: f.compania, tramites: f.tramites, valorEstimado: f.valorEstimado, masAntiguoDias: f.masAntiguoDias })),
    },
    ...(t.margen ? [
      {
        nombre: 'Margen por servicio',
        columnas: [col('Servicio', 'servicio'), col('Cobrado', 'cobrado', DINERO), col('Costo', 'costo', DINERO), col('Sin costo registrado', 'sinCosto')],
        filas: t.margen.porServicio.map((s) => ({ servicio: s.servicio, cobrado: s.cobrado, costo: s.costo, sinCosto: s.sinCostoRegistrado ? 'Sí' : 'No' })),
      },
      {
        nombre: 'Margen por cliente',
        columnas: [col('Compañía', 'compania', { width: 36 }), col('Cobrado', 'cobrado', DINERO), col('Costo', 'costo', DINERO),
          col('Margen %', 'margenPct', { dinero: true }), col('Sin costo registrado', 'sinCosto')],
        filas: t.margen.porCliente.map((c) => ({ compania: c.compania, cobrado: c.cobrado, costo: c.costo, margenPct: c.margenPct, sinCosto: c.sinCostoRegistrado ? 'Sí' : 'No' })),
      },
    ] : []),
    hojaCifras('Conciliación', [
      { concepto: 'Soportes completos', valor: t.conciliacion.completos },
      { concepto: 'Con dos soportes', valor: t.conciliacion.dos },
      { concepto: 'Con un soporte', valor: t.conciliacion.uno },
      { concepto: 'Sin soportes', valor: t.conciliacion.cero },
      { concepto: 'Total', valor: t.conciliacion.total },
      { concepto: 'Completos %', valor: t.conciliacion.pctCompletos },
    ]),
  ];
}

function hojasEjecutivo(t: TableroEjecutivo): HojaTablero[] {
  const p = t.proyeccion;
  const anterior = new Map(p.mesAnterior.map((d) => [d.dia, d.valor]));
  const dias = [...new Set([...p.acumulado.map((d) => d.dia), ...p.mesAnterior.map((d) => d.dia)])].sort((a, b) => a - b);
  const actual = new Map(p.acumulado.map((d) => [d.dia, d.valor]));
  return [
    hojaCifras('Resumen', [
      { concepto: 'Trámites del mes', valor: t.comercial.tramitesMes },
      { concepto: 'Clientes en caída', valor: t.comercial.clientesEnCaida },
      { concepto: `Aprobados dentro de ANS (${t.operativo.umbralDias} días) %`, valor: t.operativo.pctDentroAns },
      { concepto: 'Margen %', valor: t.financiero.margenPct, dinero: true },
      { concepto: 'Sin facturar (valor)', valor: t.financiero.sinFacturarValor, dinero: true },
    ]),
    hojaCifras('Proyección', [
      { concepto: 'Mes', valor: p.mes },
      { concepto: 'Días transcurridos', valor: p.diasTranscurridos },
      { concepto: 'Días del mes', valor: p.diasMes },
      { concepto: 'Total mes anterior', valor: p.totalMesAnterior },
      { concepto: 'Proyección de cierre', valor: p.proyeccionCierre },
      { concepto: 'Variación %', valor: p.variacionPct },
      { concepto: 'Meta', valor: p.meta },
    ]),
    {
      nombre: 'Acumulado diario',
      columnas: [col('Día', 'dia'), col('Mes en curso', 'actual'), col('Mes anterior', 'anterior')],
      filas: dias.map((d) => ({ dia: d, actual: actual.get(d) ?? null, anterior: anterior.get(d) ?? null })),
    },
    {
      nombre: 'Riesgos',
      columnas: [col('Área', 'area'), col('Riesgo', 'frase', { width: 60 }), col('Umbral', 'umbral', { width: 24 }), col('Severidad', 'severidad')],
      filas: t.riesgos.map((r) => ({ area: r.area, frase: r.frase, umbral: r.umbral, severidad: r.severidad })),
    },
  ];
}

/** RN-TOR-XT3: quita columnas y filas de cifras de dinero si el rol no lo ve. */
export function aplicarDinero(hojas: (HojaTablero & { cifras?: Cifra[] })[], dinero: boolean): HojaTablero[] {
  return hojas.map((h) => ({
    nombre: h.nombre,
    columnas: dinero ? h.columnas : h.columnas.filter((c) => !c.dinero),
    filas: h.cifras ? h.cifras.filter((c) => dinero || !c.dinero).map(({ concepto, valor }) => ({ concepto, valor })) : h.filas,
  }));
}

/** RN-TOR-XT5 (ADR-0047): hoja «Definiciones» con la clave, la frase y la definición de cada cifra explicada. */
export function hojaDefiniciones(explicaciones: Partial<Record<string, CifraExplicada>>): HojaTablero {
  return {
    nombre: 'Definiciones',
    columnas: [col('Cifra', 'clave', { width: 28 }), col('Qué dice', 'frase', { width: 80 }), col('Cómo se calcula', 'definicion', { width: 90 })],
    filas: Object.entries(explicaciones).filter((e): e is [string, CifraExplicada] => e[1] != null)
      .map(([clave, e]) => ({ clave, frase: textoSeguro(e.frase), definicion: textoSeguro(e.definicion) })),
  };
}

/** Hojas del libro (puro sobre el servicio; para los tests). */
export async function libroTablero(
  tablero: TableroExportable, ctx: ContextoTablero,
): Promise<{ rango: { desde: string; hasta: string }; hojas: HojaTablero[] }> {
  const con = (h: HojaTablero[], e: Partial<Record<string, CifraExplicada>>) => [...h, hojaDefiniciones(e)];
  const t = tablero === 'comercial' ? await tableroComercial(ctx).then((r) => ({ rango: r.rango, hojas: con(hojasComercial(r), r.explicaciones) }))
    : tablero === 'operativa' ? await tableroOperativo(ctx).then((r) => ({ rango: r.rango, hojas: con(hojasOperativa(r), r.explicaciones) }))
      : tablero === 'financiera' ? await tableroFinanciero(ctx).then((r) => ({ rango: r.rango, hojas: con(hojasFinanciera(r), r.explicaciones) }))
        : await tableroEjecutivo(ctx).then((r) => ({ rango: r.rango, hojas: con(hojasEjecutivo(r), r.explicaciones) }));
  return { rango: t.rango, hojas: aplicarDinero(t.hojas, ctx.dinero) };
}

/** RN-TOR-XT4. */
export const nombreArchivoTablero = (tablero: TableroExportable, r: { desde: string; hasta: string }): string =>
  `torre-${tablero}-${r.desde}_${r.hasta}.xlsx`;

export async function exportarTablero(res: Response, tablero: TableroExportable, ctx: ContextoTablero): Promise<void> {
  const { rango, hojas } = await libroTablero(tablero, ctx);
  const libro = new ExcelJS.Workbook();
  for (const h of hojas) {
    const hoja = libro.addWorksheet(h.nombre.slice(0, 31));
    hoja.columns = h.columnas.map((c) => ({ header: c.header, key: c.key, width: c.width || 20 }));
    for (const c of h.columnas) if (c.numFmt) hoja.getColumn(c.key).numFmt = c.numFmt;
    hoja.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
    hoja.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    hoja.views = [{ state: 'frozen', ySplit: 1 }];
    h.filas.forEach((f) => hoja.addRow(f));
  }
  res.setHeader('Content-Type', MIME_XLSX);
  res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivoTablero(tablero, rango)}"`);
  res.setHeader('Cache-Control', 'no-store');
  await libro.xlsx.write(res);
  res.end();
}
