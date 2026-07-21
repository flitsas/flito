// FLITO — Trámites unificado (Fase 6). Porta packages/client/src/paginas/tramites/tramites.tsx al kit
// flit/ + api. Una fila por trámite: solicita SOAT/impuestos/ambos, sigue su estado y entrega en lote.
// Es la vista de quien despacha (Operaciones); Auditoría entra en solo lectura. Los gestores NO entran:
// cada uno sigue en su propia cola. Las reglas viven en el backend; aquí solo se orquesta y reporta.

import { puedeOperar } from '../lib/permissions';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ESTADO_IMPUESTO_LABEL, ESTADO_SOAT_LABEL, EstadoImpuesto, EstadoSoat,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import FlitModal from '../components/flit/FlitModal';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import {
  FlitCard, FlitTable, FlitTh, FlitTr, FlitField, FlitEmpty, FlitPillGroup, FlitPillButton,
  flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';

interface FilaSoat {
  id: string; estado: EstadoSoat; proveedorSoatNombre: string | null; valorPagado: number | null;
  enviadoEn: string | null; estancado: boolean; motivoRechazo: string | null;
}
interface FilaImpuesto {
  id: string; estado: EstadoImpuesto; tieneFacturaVenta: boolean; coincidenciaFacturaVenta: number | null;
  valorLiquidado: number | null; valorPagado: number | null; marcadoPorDiferencia: boolean;
  enviadoEn: string | null; estancado: boolean; motivoRechazo: string | null;
}
interface TramiteFila {
  tramiteId: string; idFlit: string; estado: string; companiaNombre: string; organismoNombre: string;
  vehiculo: { vin: string | null; placa: string | null; marca: string | null; linea: string | null; tipoVehiculo: string | null };
  compradorPrincipal: { nombreCompleto: string; numeroDocumento: string } | null;
  compradores: unknown[]; soat: FilaSoat | null; soatAutogestionado: boolean; impuesto: FilaImpuesto | null;
  soatResuelto: boolean; impuestosResueltos: boolean; listoParaEntregar: boolean;
  valorSoat: number | null; valorImpuesto: number | null; sincronizadoEn: string;
}
interface Proveedor { id: string; nombre: string; activo: boolean }

interface ResSoat { enviados: number; yaEnviados: number; autogestionados: number; sinRegistro: number }
interface Ref { tramiteId: string; idFlit: string; placa: string | null }
interface ResImpuestos { enviados: number; yaEnviados: number; requierenFactura: Ref[]; noAplica: number; retenidos: Ref[] }
interface ResEntrega { entregados: number; noHabilitados: Array<{ tramiteId: string; idFlit: string; placa: string; motivo: string }> }
type Resultado =
  | { tipo: 'soat'; soat: ResSoat }
  | { tipo: 'impuestos'; impuestos: ResImpuestos }
  | { tipo: 'ambos'; soat: ResSoat; impuestos: ResImpuestos }
  | { tipo: 'entrega'; entrega: ResEntrega };

const TONO_SOAT: Record<EstadoSoat, ChipTone> = { pendiente: 'draft', en_adquisicion: 'active', pagado: 'success', rechazado: 'danger' };
const TONO_IMP: Record<EstadoImpuesto, ChipTone> = {
  sin_factura: 'draft', retenido: 'warning', pendiente: 'draft', en_gestion: 'active', pagado: 'success', rechazado: 'danger', no_aplica: 'neutral',
};
const pesos = (v: number | null) => v === null ? null
  : new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(v);
const fecha = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

function useDebounce<T>(valor: T, ms: number): T {
  const [dif, setDif] = useState(valor);
  useEffect(() => { const t = setTimeout(() => setDif(valor), ms); return () => clearTimeout(t); }, [valor, ms]);
  return dif;
}

export default function FlitoTramites() {
  const { user } = useAuth();
  const esOperaciones = puedeOperar(user?.role);

  const [texto, setTexto] = useState('');
  const buscar = useDebounce(texto, 300);
  const [soatSel, setSoatSel] = useState<EstadoSoat[]>([]);
  const [impSel, setImpSel] = useState<EstadoImpuesto[]>([]);
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [data, setData] = useState<TramiteFila[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [dialogo, setDialogo] = useState<null | 'soat' | 'ambos'>(null);
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [enProceso, setEnProceso] = useState(false);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    setError(null); setData(null); setSeleccion(new Set());
    const q = new URLSearchParams();
    if (buscar.trim()) q.set('buscar', buscar.trim());
    api.get<TramiteFila[]>(`/flito/tramites?${q}`).then(setData).catch((e) => setError(errorMessage(e)));
  }, [buscar, recarga]);

  useEffect(() => {
    if (!esOperaciones) return;
    api.get<Proveedor[]>('/flito/parametrizacion/proveedores-soat').then(setProveedores).catch(() => setProveedores([]));
  }, [esOperaciones]);

  const todas = data ?? [];
  const filas = useMemo(() => todas.filter((f) => {
    const soatOk = soatSel.length === 0 || (f.soat != null && soatSel.includes(f.soat.estado));
    const impOk = impSel.length === 0 || (f.impuesto != null && impSel.includes(f.impuesto.estado));
    return soatOk && impOk;
  }), [todas, soatSel, impSel]);

  const refrescar = () => setRecarga((n) => n + 1);
  const ids = () => [...seleccion];
  const limpiar = () => setSeleccion(new Set());
  const n = seleccion.size;
  const hayFiltros = soatSel.length > 0 || impSel.length > 0;

  const ejecutar = async (fn: () => Promise<Resultado>) => {
    setEnProceso(true); setError(null);
    try { setResultado(await fn()); limpiar(); refrescar(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setEnProceso(false); }
  };

  const solicitarImpuestos = () => ejecutar(async () => ({ tipo: 'impuestos', impuestos: await api.post<ResImpuestos>('/flito/tramites/solicitar-impuestos', { tramiteIds: ids() }) }));
  const entregar = (tramiteIds: string[]) => ejecutar(async () => ({ tipo: 'entrega', entrega: await api.post<ResEntrega>('/flito/tramites/entregar', { tramiteIds }) }));

  // §correcciones-UX punto 2: la factura de venta (precondición del envío de impuestos) se carga DESDE
  // esta misma vista, por fila, sin ir a otra pantalla.
  const cargarFacturaVenta = async (impuestoId: string, file: File) => {
    setEnProceso(true); setError(null);
    try { await api.upload(`/flito/impuestos/${impuestoId}/factura-venta`, file, 'archivo'); refrescar(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setEnProceso(false); }
  };

  return (
    <div className="space-y-4">
      <PageHeaderCard title="Trámites"
        subtitle="Solicita SOAT e impuestos, sigue su estado y entrega. Una fila por trámite."
        actions={
          <input className={`${flitInp} max-w-xs`} placeholder="Buscar placa, VIN, id o comprador…"
            value={texto} onChange={(e) => setTexto(e.target.value)} />
        } />

      <FlitCard>
        <div className="space-y-2">
          <GrupoFiltro titulo="SOAT" estados={Object.values(EstadoSoat)} etiqueta={(e) => ESTADO_SOAT_LABEL[e]} seleccion={soatSel} onCambio={setSoatSel} />
          <GrupoFiltro titulo="Impuestos" estados={Object.values(EstadoImpuesto)} etiqueta={(e) => ESTADO_IMPUESTO_LABEL[e]} seleccion={impSel} onCambio={setImpSel} />
          {hayFiltros && (
            <button className="text-xs font-semibold" style={{ color: 'var(--flit-blue-text)' }}
              onClick={() => { setSoatSel([]); setImpSel([]); }}>Limpiar filtros</button>
          )}
        </div>
      </FlitCard>

      {error && <FlitCard><p className="text-sm text-red-600">{error}</p></FlitCard>}

      {esOperaciones && n > 0 && (
        <FlitCard>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold" style={{ color: 'var(--flit-blue-text)' }}>{n} seleccionado(s)</span>
            <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={enProceso} onClick={() => setDialogo('soat')}>Solicitar SOAT</button>
            <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={enProceso} onClick={solicitarImpuestos}>Solicitar Impuestos</button>
            <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={enProceso} onClick={() => setDialogo('ambos')}>Solicitar ambos</button>
            <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={enProceso} onClick={() => entregar(ids())}>Entregar</button>
            <button className="text-xs font-semibold" style={{ color: 'var(--flit-text-muted)' }} onClick={limpiar}>Limpiar</button>
          </div>
        </FlitCard>
      )}

      {data && filas.length === 0 && (
        <FlitCard>
          <FlitEmpty>{buscar || hayFiltros ? 'Ningún trámite coincide con el filtro.' : 'No hay trámites. Sincroniza desde FLIT para traer trámites en estado Asignado.'}</FlitEmpty>
        </FlitCard>
      )}

      {filas.length > 0 && (
        <FlitCard>
          <FlitTable>
            <thead>
              <FlitTr>
                {esOperaciones && (
                  <FlitTh>
                    <input type="checkbox" aria-label="Seleccionar todos"
                      checked={filas.length > 0 && seleccion.size === filas.length}
                      onChange={(e) => setSeleccion(e.target.checked ? new Set(filas.map((f) => f.tramiteId)) : new Set())} />
                  </FlitTh>
                )}
                <FlitTh>Trámite</FlitTh><FlitTh>Vehículo</FlitTh><FlitTh>Comprador</FlitTh>
                <FlitTh>Organismo / Compañía</FlitTh><FlitTh>SOAT</FlitTh><FlitTh>Factura venta</FlitTh>
                <FlitTh>Impuestos</FlitTh><FlitTh>Sincronizado</FlitTh><FlitTh>Estado</FlitTh>
              </FlitTr>
            </thead>
            <tbody>
              {filas.map((f) => (
                <FlitTr key={f.tramiteId}>
                  {esOperaciones && (
                    <td className="px-3 py-2">
                      <input type="checkbox" aria-label={`Seleccionar ${f.vehiculo.placa}`}
                        checked={seleccion.has(f.tramiteId)}
                        onChange={() => setSeleccion((s) => { const x = new Set(s); x.has(f.tramiteId) ? x.delete(f.tramiteId) : x.add(f.tramiteId); return x; })} />
                    </td>
                  )}
                  <td className="px-3 py-2 text-xs tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>{f.idFlit}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{f.vehiculo.placa ?? '—'}</div>
                    <div className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>{f.vehiculo.marca} {f.vehiculo.linea}{f.vehiculo.tipoVehiculo ? ` · ${f.vehiculo.tipoVehiculo}` : ''}</div>
                    <div className="text-[11px] tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>{f.vehiculo.vin}</div>
                  </td>
                  <td className="px-3 py-2 text-sm">
                    {f.compradorPrincipal ? (
                      <>
                        <div>{f.compradorPrincipal.nombreCompleto}</div>
                        <div className="text-[11px] tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>{f.compradorPrincipal.numeroDocumento}</div>
                        {f.compradores.length > 1 && <span className="text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>{f.compradores.length} propietarios</span>}
                      </>
                    ) : '—'}
                  </td>
                  <td className="px-3 py-2 text-sm">{f.organismoNombre}<div className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{f.companiaNombre}</div></td>
                  <td className="px-3 py-2"><CeldaSoat fila={f} /></td>
                  <td className="px-3 py-2"><CeldaFacturaVenta fila={f} esOperaciones={esOperaciones} enProceso={enProceso} onCargar={cargarFacturaVenta} /></td>
                  <td className="px-3 py-2"><CeldaImpuesto fila={f} /></td>
                  <td className="px-3 py-2 text-xs tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>{fecha(f.sincronizadoEn)}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-col items-start gap-1">
                      <StatusChip tone="neutral">{f.estado}</StatusChip>
                      {f.listoParaEntregar && <StatusChip tone="success">Listo para entregar</StatusChip>}
                    </div>
                  </td>
                </FlitTr>
              ))}
            </tbody>
          </FlitTable>
        </FlitCard>
      )}

      {dialogo && (
        <DialogoProveedor tipo={dialogo} n={n} proveedores={proveedores} enProceso={enProceso}
          onCancelar={() => setDialogo(null)}
          onConfirmar={(proveedorSoatId) => {
            const tramiteIds = ids();
            setDialogo(null);
            ejecutar(async () => {
              if (dialogo === 'soat') return { tipo: 'soat', soat: await api.post<ResSoat>('/flito/tramites/solicitar-soat', { tramiteIds, proveedorSoatId }) };
              const r = await api.post<{ soat: ResSoat; impuestos: ResImpuestos }>('/flito/tramites/solicitar-ambos', { tramiteIds, proveedorSoatId });
              return { tipo: 'ambos', soat: r.soat, impuestos: r.impuestos };
            });
          }} />
      )}

      {resultado && <ModalResultado resultado={resultado} onCerrar={() => setResultado(null)} />}
    </div>
  );
}

function GrupoFiltro<T extends string>({ titulo, estados, etiqueta, seleccion, onCambio }: {
  titulo: string; estados: readonly T[]; etiqueta: (e: T) => string; seleccion: T[]; onCambio: (v: T[]) => void;
}) {
  const alternar = (e: T) => onCambio(seleccion.includes(e) ? seleccion.filter((x) => x !== e) : [...seleccion, e]);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold" style={{ color: 'var(--flit-text-muted)' }}>{titulo}:</span>
      <FlitPillGroup>
        {estados.map((e) => <FlitPillButton key={e} active={seleccion.includes(e)} onClick={() => alternar(e)}>{etiqueta(e)}</FlitPillButton>)}
      </FlitPillGroup>
    </div>
  );
}

function CeldaSoat({ fila }: { fila: TramiteFila }) {
  if (fila.soatAutogestionado) return <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Autogestionado</span>;
  if (!fila.soat) return <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sin registro</span>;
  const s = fila.soat;
  const v = pesos(s.valorPagado);
  return (
    <div className="space-y-0.5">
      <StatusChip tone={TONO_SOAT[s.estado]}>{ESTADO_SOAT_LABEL[s.estado]}</StatusChip>
      {s.estancado && <div><StatusChip tone="danger">SLA vencido</StatusChip></div>}
      {s.proveedorSoatNombre && <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{s.proveedorSoatNombre}</p>}
      {s.enviadoEn && <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>Enviado {fecha(s.enviadoEn)}</p>}
      {v && <p className="text-xs font-semibold tabular-nums">{v}</p>}
      {s.motivoRechazo && <p className="text-[11px]" style={{ color: 'var(--flit-danger)' }} title={s.motivoRechazo}>{s.motivoRechazo.slice(0, 40)}</p>}
    </div>
  );
}

function CeldaFacturaVenta({ fila, esOperaciones, enProceso, onCargar }: {
  fila: TramiteFila; esOperaciones: boolean; enProceso: boolean; onCargar: (impuestoId: string, file: File) => void;
}) {
  if (!fila.impuesto) return <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>—</span>;
  const imp = fila.impuesto;
  const coincidencia = imp.coincidenciaFacturaVenta != null ? Math.round(imp.coincidenciaFacturaVenta * 100) : null;
  if (imp.tieneFacturaVenta) {
    return (
      <div className="space-y-0.5">
        <StatusChip tone="success">Cargada</StatusChip>
        {coincidencia != null && <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>Coincidencia {coincidencia}%</p>}
      </div>
    );
  }
  // Precondición pendiente: solo relevante mientras el impuesto espera factura (sin_factura).
  const necesita = imp.estado === EstadoImpuesto.SIN_FACTURA;
  if (!necesita) return <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>—</span>;
  if (!esOperaciones) return <span className="text-[11px]" style={{ color: 'var(--flit-warning)' }}>Falta</span>;
  return (
    <label className={`inline-flex cursor-pointer items-center rounded-[999px] border px-3 py-1 text-xs font-medium ${enProceso ? 'opacity-50' : ''}`}
      style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-blue-text)' }}>
      Cargar factura
      <input type="file" accept="application/pdf,image/*" className="hidden" disabled={enProceso}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onCargar(imp.id, f); e.target.value = ''; }} />
    </label>
  );
}

function CeldaImpuesto({ fila }: { fila: TramiteFila }) {
  if (!fila.impuesto) return <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sin registro</span>;
  const imp = fila.impuesto;
  const liq = pesos(imp.valorLiquidado);
  const pag = pesos(imp.valorPagado);
  return (
    <div className="space-y-0.5">
      <StatusChip tone={TONO_IMP[imp.estado]}>{ESTADO_IMPUESTO_LABEL[imp.estado]}</StatusChip>
      {imp.estancado && <div><StatusChip tone="danger">SLA vencido</StatusChip></div>}
      {imp.marcadoPorDiferencia && <div><StatusChip tone="warning">Diferencia de valor</StatusChip></div>}
      {liq && <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>Liquidado {liq}</p>}
      {pag && <p className="text-xs font-semibold tabular-nums">{pag}</p>}
      {imp.motivoRechazo && <p className="text-[11px]" style={{ color: 'var(--flit-danger)' }} title={imp.motivoRechazo}>{imp.motivoRechazo.slice(0, 40)}</p>}
    </div>
  );
}

function DialogoProveedor({ tipo, n, proveedores, enProceso, onConfirmar, onCancelar }: {
  tipo: 'soat' | 'ambos'; n: number; proveedores: Proveedor[]; enProceso: boolean;
  onConfirmar: (proveedorSoatId: string) => void; onCancelar: () => void;
}) {
  const [proveedorSoatId, setProveedorSoatId] = useState('');
  return (
    <FlitModal title={tipo === 'ambos' ? 'Solicitar SOAT e impuestos' : 'Solicitar SOAT'} onClose={onCancelar}>
      <div className="space-y-3">
        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          Elige la aseguradora a la que se envían los {n} trámite(s). El SOAT va a ese proveedor; los impuestos van a su gestor según el organismo.
        </p>
        <FlitField label="Aseguradora">
          <select className={flitInp} value={proveedorSoatId} onChange={(e) => setProveedorSoatId(e.target.value)}>
            <option value="">Elige una aseguradora…</option>
            {proveedores.filter((p) => p.activo).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          </select>
        </FlitField>
        <div className="flex gap-2">
          <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={!proveedorSoatId || enProceso} onClick={() => onConfirmar(proveedorSoatId)}>
            {tipo === 'ambos' ? 'Solicitar ambos' : 'Solicitar SOAT'}
          </button>
          <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onCancelar}>Cancelar</button>
        </div>
      </div>
    </FlitModal>
  );
}

const TONO_COLOR: Record<ChipTone, string> = {
  success: 'var(--flit-success)', active: 'var(--flit-info)', warning: 'var(--flit-warning)',
  danger: 'var(--flit-danger)', draft: 'var(--flit-draft)', neutral: 'var(--flit-text-muted)',
};

function Linea({ tono, children }: { tono: ChipTone; children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-sm">
      <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: TONO_COLOR[tono] }} />
      <span>{children}</span>
    </p>
  );
}

function DetalleSoat({ r }: { r: ResSoat }) {
  const vacio = !r.enviados && !r.yaEnviados && !r.autogestionados && !r.sinRegistro;
  return (
    <div className="space-y-1.5">
      {r.enviados > 0 && <Linea tono="success">{r.enviados} SOAT enviado(s): pasan a «En adquisición».</Linea>}
      {r.yaEnviados > 0 && <Linea tono="neutral">{r.yaEnviados} ya solicitados o pagados: no se reenvían.</Linea>}
      {r.autogestionados > 0 && <Linea tono="neutral">{r.autogestionados} no llevan SOAT: su compañía lo autogestiona.</Linea>}
      {r.sinRegistro > 0 && <Linea tono="neutral">{r.sinRegistro} sin registro de SOAT todavía.</Linea>}
      {vacio && <Linea tono="neutral">Ningún trámite tenía SOAT por enviar.</Linea>}
    </div>
  );
}

function DetalleImpuestos({ r }: { r: ResImpuestos }) {
  const vacio = !r.enviados && !r.yaEnviados && !r.requierenFactura.length && !r.retenidos.length && !r.noAplica;
  return (
    <div className="space-y-1.5">
      {r.enviados > 0 && <Linea tono="success">{r.enviados} impuesto(s) enviado(s): pasan a «En gestión».</Linea>}
      {r.yaEnviados > 0 && <Linea tono="neutral">{r.yaEnviados} ya en gestión o pagados: no se reenvían.</Linea>}
      {r.requierenFactura.length > 0 && <Linea tono="warning">Requieren factura de venta antes de enviarse ({r.requierenFactura.length}): {r.requierenFactura.map((x) => x.placa).join(', ')}</Linea>}
      {r.retenidos.length > 0 && <Linea tono="warning">Retenidos por organismo sin clasificar ({r.retenidos.length}): {r.retenidos.map((x) => x.placa).join(', ')}</Linea>}
      {r.noAplica > 0 && <Linea tono="neutral">{r.noAplica} no aplican: compañía u organismo autogestionado.</Linea>}
      {vacio && <Linea tono="neutral">Ningún trámite tenía impuesto por enviar.</Linea>}
    </div>
  );
}

const TITULO: Record<Resultado['tipo'], string> = {
  soat: 'Resultado de solicitar SOAT', impuestos: 'Resultado de solicitar Impuestos',
  ambos: 'Resultado de solicitar SOAT e Impuestos', entrega: 'Resultado de la entrega',
};

function ModalResultado({ resultado, onCerrar }: { resultado: Resultado; onCerrar: () => void }) {
  return (
    <FlitModal title={TITULO[resultado.tipo]} onClose={onCerrar} wide>
      <div className="space-y-3">
        {resultado.tipo === 'soat' && <DetalleSoat r={resultado.soat} />}
        {resultado.tipo === 'impuestos' && <DetalleImpuestos r={resultado.impuestos} />}
        {resultado.tipo === 'ambos' && (
          <>
            <div><p className="mb-1 text-xs font-semibold uppercase" style={{ color: 'var(--flit-text-muted)' }}>SOAT</p><DetalleSoat r={resultado.soat} /></div>
            <div><p className="mb-1 text-xs font-semibold uppercase" style={{ color: 'var(--flit-text-muted)' }}>Impuestos</p><DetalleImpuestos r={resultado.impuestos} /></div>
          </>
        )}
        {resultado.tipo === 'entrega' && (
          <div className="space-y-1.5">
            {resultado.entrega.entregados > 0 && <Linea tono="success">{resultado.entrega.entregados} trámite(s) entregado(s).</Linea>}
            {resultado.entrega.noHabilitados.length > 0 && (
              <div>
                <Linea tono="warning">{resultado.entrega.noHabilitados.length} no estaban habilitados:</Linea>
                <ul className="mt-1 space-y-1">
                  {resultado.entrega.noHabilitados.map((t) => (
                    <li key={t.tramiteId} className="rounded-md border p-2 text-xs" style={{ borderColor: 'var(--flit-border-soft)' }}>
                      <span className="font-medium">{t.placa}</span> <span style={{ color: 'var(--flit-text-muted)' }}>— {t.motivo}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!resultado.entrega.entregados && !resultado.entrega.noHabilitados.length && <Linea tono="neutral">No había trámites por entregar.</Linea>}
          </div>
        )}
        <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={onCerrar}>Entendido</button>
      </div>
    </FlitModal>
  );
}
