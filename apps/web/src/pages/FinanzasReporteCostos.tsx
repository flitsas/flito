// Finanzas — Reporte de costos. Cada fila muestra los valores SELLADOS si el trámite está
// liquidado, o un ESTIMADO en vivo si no. La distinción se pinta, porque un estimado puede cambiar
// mañana y un sellado no. Rol `financiera` (+ admin/auditor, este último en solo lectura).

import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import FlitModal from '../components/flit/FlitModal';
import StatusChip from '../components/flit/StatusChip';
import RangoFechas from '../components/flit/RangoFechas';
import { CeldaTramite, CeldaVehiculo, CeldaFechas, ENCABEZADOS_COMUNES } from '../components/flit/columnasComunes';
import VisorSoportes from '../components/flit/VisorSoportes';
import {
  FlitCard, FlitTable, FlitTh, FlitTr, FlitEmpty, flitInp, FlitPillGroup, flitPillBtn,
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';

interface Fila {
  tramiteId: string; idFlit: string; placa: string | null; estado: string | null; empresa: string | null;
  vin: string | null; marca: string | null; linea: string | null;
  tipoTramite: string | null; fechaAprobacion: string | null; fechaCreacion: string | null;
  soat: number | null; impuesto: number | null; derechoTramite: number | null;
  logistica: number | null; tramiteDigital: number | null; gmf: number | null; total: number | null;
  sellada: boolean;
  estadoLiquidacion: 'liquidado' | 'facturado' | null;
  noConfigurados: string[];
  /** Conceptos que esperan su documento pagado, no una tarifa. Hoy solo el derecho de tránsito. */
  sinRecibo: string[];
  /** Los que FLITO gestiona y aún no tienen valor pagado (SOAT, impuesto). Bloquean la liquidación. */
  pendientesPago: string[];
  /** Los que la compañía se gestiona sola: no se cobran ni se esperan. */
  autogestionados: string[];
  /** Los que no aplican por el organismo, no por la compañía. Hoy solo el impuesto. */
  noAplican: string[];
}
interface Totales {
  soat: number; impuesto: number; derechoTramite: number; logistica: number; tramiteDigital: number;
  gmf: number; total: number; filasIncompletas: number;
}
interface Resumen { listo: number; incompleto: number; porFacturar: number; facturado: number }
interface Reporte {
  items: Fila[]; total: number; page: number; pageSize: number; totales: Totales; resumen: Resumen;
}
interface Facetas { estados: string[]; empresas: { valor: string; nombre: string }[]; tipos: string[] }
const pesos = (n: number) => n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });

/**
 * Estado con el que arranca el reporte. Cerrar el mes se hace sobre lo aprobado, así que ese es el
 * punto de partida útil; los demás estados siguen a un clic en las pastillas.
 */
const ESTADO_POR_DEFECTO = 'Aprobado';

/**
 * Etiquetas de los conceptos. Se usan para el encabezado Y para cruzar con `noConfigurados`,
 * `sinRecibo`, `pendientesPago` y `autogestionados`, para que el rótulo de la columna y el motivo
 * de la ausencia no puedan divergir.
 */
const CONCEPTO = {
  soat: 'SOAT', impuesto: 'Impuesto', derecho: 'Derecho de tránsito',
  digital: 'Trámite digital', logistica: 'Logística',
} as const;

/**
 * En qué punto del cobro está el trámite. Es EL filtro de esta pantalla, así que se pide con un
 * clic y no combinando dos desplegables: antes, «lo que ya se puede liquidar» —la pregunta con la
 * que se entra aquí— no se podía pedir de ninguna manera, y «liquidado» y «facturado» eran dos
 * selectores independientes que permitían pedir combinaciones imposibles.
 *
 * Las cuatro etapas son excluyentes y cubren todo: cada trámite está en una y solo una.
 */
type Etapa = '' | 'listo' | 'incompleto' | 'por_facturar' | 'facturado';

const ETAPAS: Array<{ v: Etapa; label: string; ayuda: string; cuenta?: (r: Resumen) => number }> = [
  { v: '', label: 'Todos', ayuda: 'Todos los trámites del filtro, en cualquier etapa.' },
  {
    v: 'listo', label: 'Listos para liquidar', cuenta: (r) => r.listo,
    ayuda: 'Sin liquidar y con SOAT, impuesto, derecho de tránsito, logística y trámite digital resueltos —saltando los que la compañía autogestiona—. Se pueden sellar ya.',
  },
  {
    v: 'incompleto', label: 'Incompletos', cuenta: (r) => r.incompleto,
    ayuda: 'Sin liquidar porque falta una tarifa, un recibo o un pago. Cada fila dice qué.',
  },
  {
    v: 'por_facturar', label: 'Por facturar', cuenta: (r) => r.porFacturar,
    ayuda: 'Liquidados con valores ya sellados, todavía sin facturar.',
  },
  { v: 'facturado', label: 'Facturados', cuenta: (r) => r.facturado, ayuda: 'Ya facturados.' },
];

/**
 * Un concepto sin valor no siempre significa lo mismo, y decir lo que no es hace daño. Cinco casos:
 *
 *   falta = 'tarifa' → no hay tarifa negociada con la compañía. Se arregla en Clientes y
 *                      proveedores. Solo aplica a logística y trámite digital, que son honorarios
 *                      de FLITO y se pactan cliente a cliente.
 *   falta = 'recibo' → falta el DOCUMENTO pagado. Es el caso del derecho de tránsito, que no se
 *                      configura en ninguna pantalla: se lee del recibo, igual que el SOAT y el
 *                      impuesto. Decirle «no configurado» mandaba a buscar una parametrización
 *                      inexistente.
 *   falta = 'pago'   → FLITO lo gestiona para esta compañía y aún no tiene valor pagado (SOAT,
 *                      impuesto). No hay nada que configurar: hay que empujar o esperar el pago.
 *   falta = 'auto'   → la compañía se lo gestiona por su cuenta. No es una ausencia: FLITO no lo
 *                      cobra. Se dice, porque un guion se leía como «falta algo».
 *   falta = 'nada'   → no aplica porque el ORGANISMO no entrega ese concepto en gestión. Se
 *                      distingue de 'auto' porque no es una decisión del cliente.
 *   sin falta        → no aplica a este trámite. Un guion, porque no hay nada que hacer.
 *
 * En ningún caso se pinta «$ 0»: un cero se suma en la cabeza de quien lee.
 */
type Falta = 'tarifa' | 'recibo' | 'pago' | 'auto' | 'nada';
const TEXTO_FALTA: Record<Falta, string> = {
  tarifa: 'No configurado', recibo: 'Sin recibo', pago: 'Sin pagar',
  auto: 'Autogestiona', nada: 'No aplica',
};

/**
 * Alto común de los controles del filtro. Va en estilo y no en clase porque `flitInp` ya trae su
 * relleno vertical: dos utilidades peleando por la misma propiedad se resuelven por el orden de la
 * hoja, no por el del atributo, y la fila quedaba desalineada a capricho del build.
 */
const ALTO_CONTROL = { height: 40, paddingTop: 0, paddingBottom: 0 } as const;

/**
 * Todo lo que le impide liquidarse, en una sola lista. A quien mira la fila le da igual si lo que
 * falta es una tarifa, un recibo o un pago: lo que necesita saber es qué tiene que resolver.
 */
const faltantes = (f: Fila): string[] => [...f.noConfigurados, ...f.sinRecibo, ...f.pendientesPago];

/** Por qué está vacía la celda de este concepto, si es que lo está. El backend ya lo decidió. */
function faltaDe(f: Fila, concepto: string): Falta | undefined {
  if (f.noConfigurados.includes(concepto)) return 'tarifa';
  if (f.sinRecibo.includes(concepto)) return 'recibo';
  if (f.pendientesPago.includes(concepto)) return 'pago';
  if (f.autogestionados.includes(concepto)) return 'auto';
  if (f.noAplican.includes(concepto)) return 'nada';
  return undefined;
}

function Monto({ v, falta, negrita }: { v: number | null; falta?: Falta; negrita?: boolean }) {
  if (v === null) {
    return (
      <span className="text-xs italic" style={{ color: 'var(--flit-text-muted)' }}>
        {falta ? TEXTO_FALTA[falta] : '—'}
      </span>
    );
  }
  return <span className={negrita ? 'font-semibold' : undefined}>{pesos(v)}</span>;
}

export default function FinanzasReporteCostos() {
  const { user } = useAuth();
  // Auditoría observa la conciliación; no la ejecuta.
  const puedeLiquidar = user?.role === 'admin' || user?.role === 'financiera';
  const puedeReversar = user?.role === 'admin';

  const [data, setData] = useState<Reporte | null>(null);
  const [facetas, setFacetas] = useState<Facetas | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);
  const [enProceso, setEnProceso] = useState(false);
  const [soportesDe, setSoportesDe] = useState<Fila | null>(null);
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());

  const [buscar, setBuscar] = useState('');
  const [empresa, setEmpresa] = useState('');
  const [tipo, setTipo] = useState('');
  const [etapa, setEtapa] = useState<Etapa>('');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [aprobadoDesde, setAprobadoDesde] = useState('');
  const [aprobadoHasta, setAprobadoHasta] = useState('');
  const [estados, setEstados] = useState<string[]>([ESTADO_POR_DEFECTO]);
  const [docCompleta, setDocCompleta] = useState(false);
  const [page, setPage] = useState(1);

  const estadosKey = estados.join(',');

  const params = () => {
    const p = new URLSearchParams();
    if (buscar.trim()) p.set('buscar', buscar.trim());
    if (empresa) p.set('empresas', empresa);
    if (tipo) p.set('tipos', tipo);
    if (etapa) p.set('etapa', etapa);
    if (desde) p.set('desde', desde);
    if (hasta) p.set('hasta', hasta);
    if (aprobadoDesde) p.set('aprobadoDesde', aprobadoDesde);
    if (aprobadoHasta) p.set('aprobadoHasta', aprobadoHasta);
    if (estados.length) p.set('estados', estados.join(','));
    if (docCompleta) p.set('documentacionCompleta', 'si');
    return p;
  };

  const limpiarFiltros = () => {
    setBuscar(''); setEmpresa(''); setTipo(''); setEtapa('');
    setDesde(''); setHasta(''); setAprobadoDesde(''); setAprobadoHasta('');
    setDocCompleta(false);
    // Vuelve al punto de partida del reporte, no a «todos los estados»: quien limpia quiere el
    // estado inicial de la pantalla, y ese es Aprobado.
    setEstados([ESTADO_POR_DEFECTO]);
  };

  const hayFiltros = buscar !== '' || empresa !== '' || tipo !== '' || etapa !== '' || docCompleta
    || desde !== '' || hasta !== '' || aprobadoDesde !== '' || aprobadoHasta !== ''
    || estadosKey !== ESTADO_POR_DEFECTO;

  useEffect(() => { setPage(1); setSeleccion(new Set()); }, [buscar, empresa, tipo, etapa, desde, hasta, aprobadoDesde, aprobadoHasta, estadosKey, docCompleta]);

  useEffect(() => {
    setError(null);
    const p = params();
    p.set('page', String(page));
    api.get<Reporte>(`/finanzas/reporte-costos?${p.toString()}`).then(setData).catch((e) => setError(errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buscar, empresa, tipo, etapa, desde, hasta, aprobadoDesde, aprobadoHasta, estadosKey, docCompleta, page, recarga]);

  useEffect(() => { api.get<Facetas>('/finanzas/reporte-costos/facetas').then(setFacetas).catch(() => setFacetas(null)); }, []);

  const filas = data?.items ?? [];
  const totalPaginas = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const refrescar = () => setRecarga((n) => n + 1);

  /** Solo se puede liquidar lo que no está liquidado y tiene todos sus conceptos resueltos. */
  // Ni sin tarifa, ni sin recibo, ni sin pagar: la primera congelaría un cobro inventado, la
  // segunda un total al que le falta un costo que existe, y la tercera un cobro que aún no ocurrió.
  // Es la misma condición que exige el backend al sellar: si aquí faltara una, el botón se ofrecería
  // activo para fallar al pulsarlo.
  const liquidable = (f: Fila) => !f.sellada && faltantes(f).length === 0;
  const liquidables = filas.filter(liquidable);

  const ejecutar = async (fn: () => Promise<string>) => {
    setEnProceso(true); setError(null); setAviso(null);
    try { setAviso(await fn()); refrescar(); setSeleccion(new Set()); }
    catch (e) { setError(errorMessage(e)); }
    finally { setEnProceso(false); }
  };

  const liquidarUno = (f: Fila) => ejecutar(async () => {
    await api.post(`/flito/liquidacion/${f.tramiteId}/liquidar`, {});
    return `${f.idFlit} liquidado.`;
  });

  const liquidarLote = () => ejecutar(async () => {
    const r = await api.post<{ liquidados: string[]; fallidos: { motivo: string }[] }>(
      '/flito/liquidacion/lote/liquidar', { tramiteIds: [...seleccion] });
    return `${r.liquidados.length} liquidados, ${r.fallidos.length} sin liquidar.`;
  });

  const facturarUno = (f: Fila) => ejecutar(async () => {
    await api.post(`/flito/liquidacion/${f.tramiteId}/facturar`, {});
    return `${f.idFlit} marcado como facturado.`;
  });

  const reversarUno = (f: Fila, motivo: string) => ejecutar(async () => {
    await api.post(`/flito/liquidacion/${f.tramiteId}/reversar`, { motivo });
    return `Liquidación de ${f.idFlit} reversada.`;
  });

  const exportar = () => {
    // La exportación cubre TODO el filtro, no la página: se abre en una pestaña para que el
    // navegador gestione la descarga con su propio indicador de progreso.
    window.open(`/api/finanzas/reporte-costos/export?${params().toString()}`, '_blank');
  };

  return (
    <div className="space-y-4">
      <PageHeaderCard title="Reporte de costos"
        subtitle="Costos reales por trámite. Las filas liquidadas muestran valores sellados; el resto, un estimado con las tarifas vigentes."
        actions={<button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={exportar}>Exportar CSV</button>} />

      {/* Dos líneas y se acabó: arriba EN QUÉ punto del cobro está el trámite —que es a lo que se
          entra— y abajo sobre QUÉ trámites, cada control del mismo alto y en su columna. Antes eran
          cuatro bandas sueltas, dos de ellas con desplegables que decían lo mismo de dos maneras. */}
      <FlitCard className="!p-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <FlitPillGroup>
            {ETAPAS.map((e) => (
              <button key={e.v} type="button" title={e.ayuda} onClick={() => setEtapa(e.v)}
                aria-pressed={etapa === e.v}
                className="flit-focus inline-flex items-center gap-2 rounded-[999px] px-4 py-2 text-xs font-semibold transition-colors"
                style={flitPillBtn(etapa === e.v)}>
                {e.label}
                {/* El número decide a dónde ir: sin él hay que entrar en cada pestaña para ver si
                    tiene trabajo dentro. Cuenta con los demás filtros puestos, no sobre todo. */}
                {data && e.cuenta && (
                  <span className="rounded-[999px] px-1.5 py-0.5 text-[10px] tabular-nums"
                    style={{ background: 'var(--flit-bg-app)', color: 'var(--flit-text-secondary)' }}>
                    {e.cuenta(data.resumen).toLocaleString('es-CO')}
                  </span>
                )}
              </button>
            ))}
          </FlitPillGroup>

          <label className="flex cursor-pointer items-center gap-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}
            title="Con soporte cargado de SOAT, impuesto, derecho y logística — saltando los que la compañía autogestiona.">
            <input type="checkbox" checked={docCompleta} onChange={(e) => setDocCompleta(e.target.checked)} />
            Solo con soportes completos
          </label>

          {/* Solo `ml-auto`: el tamaño se queda el del botón secundario de siempre. Recortarlo con
              clases sueltas (h-8, text-xs) es apostar a qué utilidad de Tailwind gana en la hoja. */}
          <button className={`${flitBtnSecondary} ml-auto`} style={flitBtnSecondaryStyle}
            disabled={!hayFiltros} onClick={limpiarFiltros}>Limpiar filtros</button>
        </div>

        {/* Cada filtro en su columna y del mismo alto. Los dos rangos son independientes y van
            rotulados: «desde/hasta» a secas, con dos fechas en juego, no dice sobre cuál filtra. */}
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <input className={flitInp} style={ALTO_CONTROL} placeholder="Placa, VIN o trámite FLIT…"
            aria-label="Buscar" value={buscar} onChange={(e) => setBuscar(e.target.value)} />
          <select className={flitInp} style={ALTO_CONTROL} aria-label="Empresa" value={empresa} onChange={(e) => setEmpresa(e.target.value)}>
            <option value="">Todas las empresas</option>
            {facetas?.empresas.map((e) => <option key={e.valor} value={e.valor}>{e.nombre}</option>)}
          </select>
          <select className={flitInp} style={ALTO_CONTROL} aria-label="Tipo de trámite" value={tipo} onChange={(e) => setTipo(e.target.value)}>
            <option value="">Todos los tipos</option>
            {facetas?.tipos.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <FiltroEstados opciones={facetas?.estados ?? []} seleccion={estados} onCambio={setEstados} />
          <RangoFechas etiqueta="Creación" valor={{ desde, hasta }}
            onCambio={(r) => { setDesde(r.desde); setHasta(r.hasta); }} />
          <RangoFechas etiqueta="Aprobación" valor={{ desde: aprobadoDesde, hasta: aprobadoHasta }}
            onCambio={(r) => { setAprobadoDesde(r.desde); setAprobadoHasta(r.hasta); }} />
        </div>
      </FlitCard>

      {error && <FlitCard><p className="text-sm text-red-600">{error}</p></FlitCard>}
      {aviso && <FlitCard><p className="text-sm" style={{ color: 'var(--flit-blue-text)' }}>{aviso}</p></FlitCard>}

      {/* Un total al que le faltan conceptos no puede pasar por completo. Va en una línea y con la
          salida puesta: el aviso servía de poco si para ver esos trámites había que ir a armar el
          filtro a mano. */}
      {data && data.totales.filasIncompletas > 0 && (
        <FlitCard className="!p-3">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span>
              El total mostrado está incompleto:{' '}
              <strong>{data.totales.filasIncompletas.toLocaleString('es-CO')}</strong> de{' '}
              <strong>{data.total.toLocaleString('es-CO')}</strong> trámites tienen algún concepto
              sin resolver.
            </span>
            {etapa !== 'incompleto' && (
              <button type="button" className="text-sm font-semibold underline"
                style={{ color: 'var(--flit-blue-text)' }} onClick={() => setEtapa('incompleto')}>
                Ver cuáles
              </button>
            )}
          </p>
        </FlitCard>
      )}

      {puedeLiquidar && seleccion.size > 0 && (
        <FlitCard>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-semibold">{seleccion.size} seleccionado(s)</span>
            <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={enProceso} onClick={liquidarLote}>
              {enProceso ? 'Liquidando…' : 'Liquidar seleccionados'}
            </button>
            <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setSeleccion(new Set())}>Quitar selección</button>
          </div>
        </FlitCard>
      )}

      {data && filas.length === 0 && <FlitCard><FlitEmpty>No hay trámites que coincidan con los filtros.</FlitEmpty></FlitCard>}

      {filas.length > 0 && (
        <FlitCard>
          <div className="mb-3"><Paginacion total={data!.total} page={data!.page} totalPaginas={totalPaginas} onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => p + 1)} /></div>
          <div className="overflow-x-auto">
            <FlitTable>
              <thead>
                <FlitTr>
                  {puedeLiquidar && (
                    <FlitTh>
                      <input type="checkbox" aria-label="Seleccionar liquidables"
                        checked={liquidables.length > 0 && liquidables.every((f) => seleccion.has(f.tramiteId))}
                        onChange={(e) => setSeleccion(e.target.checked ? new Set(liquidables.map((f) => f.tramiteId)) : new Set())} />
                    </FlitTh>
                  )}
                  {ENCABEZADOS_COMUNES.map((h) => <FlitTh key={h}>{h}</FlitTh>)}
                  <FlitTh>Liquidación</FlitTh>
                  <FlitTh center>{CONCEPTO.soat}</FlitTh>
                  <FlitTh center>{CONCEPTO.impuesto}</FlitTh>
                  <FlitTh center>{CONCEPTO.derecho}</FlitTh>
                  <FlitTh center>{CONCEPTO.logistica}</FlitTh>
                  <FlitTh center>{CONCEPTO.digital}</FlitTh>
                  <FlitTh center>GMF</FlitTh>
                  <FlitTh center>Total</FlitTh>
                  <FlitTh />
                </FlitTr>
              </thead>
              <tbody>
                {filas.map((f) => (
                  <FlitTr key={f.tramiteId}>
                    {puedeLiquidar && (
                      <td className="px-3 py-2">
                        {liquidable(f) && (
                          <input type="checkbox" aria-label={`Seleccionar ${f.idFlit}`}
                            checked={seleccion.has(f.tramiteId)}
                            onChange={() => setSeleccion((s) => {
                              const n = new Set(s);
                              if (n.has(f.tramiteId)) n.delete(f.tramiteId); else n.add(f.tramiteId);
                              return n;
                            })} />
                        )}
                      </td>
                    )}
                    <CeldaTramite idFlit={f.idFlit} tipoTramite={f.tipoTramite} extra={f.empresa} />
                    <CeldaVehiculo placa={f.placa} vin={f.vin} marca={f.marca} linea={f.linea} />
                    <CeldaFechas creado={f.fechaCreacion} aprobado={f.fechaAprobacion} />
                    <td className="px-4 py-2 whitespace-nowrap">
                      {f.estadoLiquidacion === 'facturado'
                        ? <StatusChip tone="success">Facturado</StatusChip>
                        : f.sellada
                          ? <StatusChip tone="active">Liquidado</StatusChip>
                          : <StatusChip tone="draft">Estimado</StatusChip>}
                    </td>
                    {/* SOAT e impuesto nunca entran en `noConfigurados`: no hay tarifa que
                        configurar. Su celda vacía puede ser un pago pendiente, una compañía que los
                        autogestiona o un trámite exento, y cada una se dice con su nombre. */}
                    <td className="px-4 py-2 text-right tabular-nums"><Monto v={f.soat} falta={faltaDe(f, CONCEPTO.soat)} /></td>
                    <td className="px-4 py-2 text-right tabular-nums"><Monto v={f.impuesto} falta={faltaDe(f, CONCEPTO.impuesto)} /></td>
                    <td className="px-4 py-2 text-right tabular-nums"><Monto v={f.derechoTramite} falta={faltaDe(f, CONCEPTO.derecho)} /></td>
                    <td className="px-4 py-2 text-right tabular-nums"><Monto v={f.logistica} falta={faltaDe(f, CONCEPTO.logistica)} /></td>
                    <td className="px-4 py-2 text-right tabular-nums"><Monto v={f.tramiteDigital} falta={faltaDe(f, CONCEPTO.digital)} /></td>
                    <td className="px-4 py-2 text-right tabular-nums"><Monto v={f.gmf} /></td>
                    <td className="px-4 py-2 text-right tabular-nums" style={{ color: 'var(--flit-blue-text)' }}><Monto v={f.total} negrita /></td>
                    <td className="px-3 py-2">
                      <Acciones fila={f} puedeLiquidar={puedeLiquidar} puedeReversar={puedeReversar} enProceso={enProceso}
                        onLiquidar={() => liquidarUno(f)} onFacturar={() => facturarUno(f)}
                        onReversar={(m) => reversarUno(f, m)} onSoportes={() => setSoportesDe(f)} />
                    </td>
                  </FlitTr>
                ))}
              </tbody>
              {data && (
                <tfoot>
                  <FlitTr>
                    {puedeLiquidar && <td />}
                    <td className="px-4 py-2 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
                      Totales ({data.total.toLocaleString('es-CO')} trámites del filtro)
                    </td>
                    <td />
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{pesos(data.totales.soat)}</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{pesos(data.totales.impuesto)}</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{pesos(data.totales.derechoTramite)}</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{pesos(data.totales.logistica)}</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{pesos(data.totales.tramiteDigital)}</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{pesos(data.totales.gmf)}</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums" style={{ color: 'var(--flit-blue-text)' }}>{pesos(data.totales.total)}</td>
                    <td />
                  </FlitTr>
                </tfoot>
              )}
            </FlitTable>
          </div>

          <div className="mt-3"><Paginacion total={data!.total} page={data!.page} totalPaginas={totalPaginas} onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => p + 1)} /></div>
        </FlitCard>
      )}

      {soportesDe && (
        <VisorSoportes ruta={`/finanzas/tramites/${soportesDe.tramiteId}/soportes`} titulo={soportesDe.idFlit}
          onClose={() => setSoportesDe(null)} />
      )}
    </div>
  );
}

/**
 * Estados del trámite, en un desplegable con casillas.
 *
 * Eran ocho pastillas siempre desplegadas, una banda entera del panel para un filtro que casi nunca
 * se toca —se entra por «Aprobado» y ahí se queda—. Plegado ocupa lo que un campo y sigue diciendo
 * qué hay puesto sin abrirlo, que es lo que de verdad hace falta ver.
 *
 * Es un `<details>`, el mismo patrón de `RangoFechas` y `ThFiltroMulti`: el navegador ya resuelve
 * abrir, cerrar y el foco por teclado.
 */
function FiltroEstados({ opciones, seleccion, onCambio }: {
  opciones: string[]; seleccion: string[]; onCambio: (v: string[]) => void;
}) {
  const alternar = (v: string) =>
    onCambio(seleccion.includes(v) ? seleccion.filter((x) => x !== v) : [...seleccion, v]);

  const resumen = seleccion.length === 0 ? 'Todos'
    : seleccion.length === 1 ? seleccion[0]
      : `${seleccion.length} seleccionados`;

  return (
    <details className="relative">
      <summary className="flit-focus flex cursor-pointer list-none items-center gap-2 rounded-[10px] border bg-white px-3 text-sm"
        style={{ ...ALTO_CONTROL, borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}
        aria-label="Estado del trámite">
        <span className="text-xs font-semibold" style={{ color: 'var(--flit-text-muted)' }}>Estado</span>
        <span className="truncate">{resumen}</span>
      </summary>
      <div className="absolute z-30 mt-1 max-h-72 w-56 overflow-auto rounded-lg border bg-white p-2 shadow-lg"
        style={{ borderColor: 'var(--flit-border-input)' }}>
        {opciones.length === 0 && (
          <p className="px-1 py-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sin estados que ofrecer</p>
        )}
        {opciones.map((o) => (
          <label key={o} className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-slate-50">
            <input type="checkbox" checked={seleccion.includes(o)} onChange={() => alternar(o)} />
            <span className="truncate">{o}</span>
          </label>
        ))}
        {seleccion.length > 0 && (
          <button type="button" className="mt-1 w-full text-xs underline" style={{ color: 'var(--flit-text-muted)' }}
            onClick={() => onCambio([])}>Cualquier estado</button>
        )}
      </div>
    </details>
  );
}

function Acciones({ fila, puedeLiquidar, puedeReversar, enProceso, onLiquidar, onFacturar, onReversar, onSoportes }: {
  fila: Fila; puedeLiquidar: boolean; puedeReversar: boolean; enProceso: boolean;
  onLiquidar: () => void; onFacturar: () => void; onReversar: (motivo: string) => void; onSoportes: () => void;
}) {
  const [reversando, setReversando] = useState(false);
  const [motivo, setMotivo] = useState('');
  // Las tres ausencias bloquean, y se nombran juntas: a quien lee le da igual si lo que falta es una
  // tarifa, un recibo o un pago, lo que necesita saber es qué le impide liquidar.
  const falta = faltantes(fila);
  const bloqueado = falta.length > 0;

  return (
    <div className="flex flex-wrap items-center gap-1">
      <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onSoportes}>Soporte</button>

      {puedeLiquidar && !fila.sellada && (
        <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={enProceso || bloqueado}
          title={bloqueado ? `Falta: ${falta.join(', ')}` : 'Sellar los valores de este trámite'}
          onClick={onLiquidar}>Liquidar</button>
      )}
      {/* Por qué NO se puede liquidar, sin obligar a pasar el ratón por encima del botón. */}
      {puedeLiquidar && !fila.sellada && bloqueado && (
        <span className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>Falta: {falta.join(', ')}</span>
      )}

      {puedeLiquidar && fila.estadoLiquidacion === 'liquidado' && (
        <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={enProceso} onClick={onFacturar}>Facturar</button>
      )}
      {/* Tras facturar ya no se ofrece reversar: los valores quedan congelados de verdad. */}
      {puedeReversar && fila.estadoLiquidacion === 'liquidado' && (
        reversando ? (
          <span className="flex items-center gap-1">
            <input className={`${flitInp} h-8 w-40 text-xs`} placeholder="Motivo del reverso" aria-label="Motivo del reverso"
              value={motivo} onChange={(e) => setMotivo(e.target.value)} />
            <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={motivo.trim().length < 5 || enProceso}
              onClick={() => { onReversar(motivo.trim()); setReversando(false); setMotivo(''); }}>Confirmar</button>
          </span>
        ) : (
          <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setReversando(true)}>Reversar</button>
        )
      )}
    </div>
  );
}

function Paginacion({ total, page, totalPaginas, onPrev, onNext }: {
  total: number; page: number; totalPaginas: number; onPrev: () => void; onNext: () => void;
}) {
  const btn = 'rounded-lg border px-3 py-1.5 text-sm font-semibold disabled:opacity-40';
  const btnStyle = { borderColor: 'var(--flit-border-input)', color: 'var(--flit-blue-text)' } as const;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
        <strong style={{ color: 'var(--flit-text-primary)' }}>{total.toLocaleString('es-CO')}</strong> trámites · página {page} de {totalPaginas}
      </span>
      <div className="flex gap-2">
        <button className={btn} style={btnStyle} disabled={page <= 1} onClick={onPrev}>← Anterior</button>
        <button className={btn} style={btnStyle} disabled={page >= totalPaginas} onClick={onNext}>Siguiente →</button>
      </div>
    </div>
  );
}
