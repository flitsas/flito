// FLITO Logística — pestaña Entregas (HU #14125).
// Lectura de viajes ya registrados. El POST sale solo mientras la pestaña está montada.
// La placa vive en el body, nunca en la URL. Sin acciones de destino ni clic de fila.
import { useEffect, useState } from 'react';
import {
  DESTINO_TRASLADO_LOGISTICA_LABEL,
  ESTADO_TRASLADO_LOGISTICA_LABEL,
  type CompaniaConViajeLogistica,
  type DestinoTrasladoLogistica,
  type EstadoTrasladoLogistica,
  type FilaEntregaLogistica,
  type ListadoEntregasLogistica,
} from '@operaciones/shared-types';
import { api, ApiError } from '../../../lib/api';
import { nombreCompania } from '../../../lib/viajesCliente';
import StatusChip, { type ChipTone } from '../../flit/StatusChip';
import {
  FlitCard, FlitEmpty, FlitField, FlitTable, FlitTh, FlitTr, flitBtnSecondary, flitBtnSecondaryStyle, flitInp,
} from '../../flit/flitPageKit';

const ESTADOS: readonly EstadoTrasladoLogistica[] = ['registrado', 'en_ruta', 'entregado', 'devuelto', 'anulado'];
const DESTINOS: readonly DestinoTrasladoLogistica[] = ['cliente', 'flit'];
const TONO: Record<EstadoTrasladoLogistica, ChipTone> = {
  registrado: 'neutral',
  en_ruta: 'warning',
  entregado: 'success',
  devuelto: 'danger',
  anulado: 'neutral',
};
const DEBOUNCE_PLACA_MS = 400;

const fecha = (iso: string | null) => (iso ? new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }) : '—');

interface BuscarEntregas {
  placa?: string;
  estado?: EstadoTrasladoLogistica;
  destino?: DestinoTrasladoLogistica;
  companiaId?: number;
}

type Carga = 'cargando' | 'ok' | 'error' | 'error403';

function cuerpoDe(placa: string, estado: string, destino: string, companiaId: string): BuscarEntregas {
  const body: BuscarEntregas = {};
  const placaLimpia = placa.trim();
  if (placaLimpia) body.placa = placaLimpia;
  if (estado === 'registrado' || estado === 'en_ruta' || estado === 'entregado' || estado === 'devuelto' || estado === 'anulado') {
    body.estado = estado;
  }
  if (destino === 'cliente' || destino === 'flit') body.destino = destino;
  if (companiaId) body.companiaId = Number(companiaId);
  return body;
}

export default function TabEntregas() {
  const [placa, setPlaca] = useState('');
  const [placaDebounced, setPlacaDebounced] = useState('');
  const [estado, setEstado] = useState('');
  const [destino, setDestino] = useState('');
  const [companiaId, setCompaniaId] = useState('');
  const [intento, setIntento] = useState(0);
  const [carga, setCarga] = useState<Carga>('cargando');
  const [viajes, setViajes] = useState<FilaEntregaLogistica[]>([]);
  const [companias, setCompanias] = useState<CompaniaConViajeLogistica[]>([]);

  useEffect(() => {
    const t = window.setTimeout(() => setPlacaDebounced(placa), DEBOUNCE_PLACA_MS);
    return () => window.clearTimeout(t);
  }, [placa]);

  useEffect(() => {
    let vivo = true;
    setCarga('cargando');
    const body = cuerpoDe(placaDebounced, estado, destino, companiaId);
    api.post<ListadoEntregasLogistica>('/flito/logistica/traslados/buscar', body)
      .then((res) => {
        if (!vivo) return;
        setViajes(res.viajes);
        setCompanias(res.companias);
        setCarga('ok');
      })
      .catch((e: unknown) => {
        if (!vivo) return;
        setCarga(e instanceof ApiError && e.status === 403 ? 'error403' : 'error');
      });
    return () => { vivo = false; };
  }, [placaDebounced, estado, destino, companiaId, intento]);

  const cargando = carga === 'cargando';
  const conFiltro = placaDebounced.trim() !== '' || estado !== '' || destino !== '' || companiaId !== '';

  const limpiar = () => {
    setPlaca('');
    setPlacaDebounced('');
    setEstado('');
    setDestino('');
    setCompaniaId('');
  };

  return (
    <FlitCard>
      <h2 className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>Entregas</h2>
      <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
        Viajes registrados, para ver a dónde van y en qué estado están.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-44">
          <FlitField label="Placa">
            <input
              className={flitInp}
              placeholder="Placa"
              value={placa}
              disabled={cargando}
              autoComplete="off"
              onChange={(e) => setPlaca(e.target.value)}
            />
          </FlitField>
        </div>
        <div className="w-full sm:w-48">
          <FlitField label="Estado">
            <select className={flitInp} value={estado} disabled={cargando} onChange={(e) => setEstado(e.target.value)}>
              <option value="">Todos los estados</option>
              {ESTADOS.map((codigo) => (
                <option key={codigo} value={codigo}>{ESTADO_TRASLADO_LOGISTICA_LABEL[codigo]}</option>
              ))}
            </select>
          </FlitField>
        </div>
        <div className="w-full sm:w-44">
          <FlitField label="Destino">
            <select className={flitInp} value={destino} disabled={cargando} onChange={(e) => setDestino(e.target.value)}>
              <option value="">Todos los destinos</option>
              {DESTINOS.map((codigo) => (
                <option key={codigo} value={codigo}>{DESTINO_TRASLADO_LOGISTICA_LABEL[codigo]}</option>
              ))}
            </select>
          </FlitField>
        </div>
        <div className="w-full sm:w-56">
          <FlitField label="Compañía">
            <select className={flitInp} value={companiaId} disabled={cargando} onChange={(e) => setCompaniaId(e.target.value)}>
              <option value="">Todas las compañías</option>
              {companias.map((c) => (
                <option key={c.companiaId} value={String(c.companiaId)}>{nombreCompania(c.nombre, c.companiaId)}</option>
              ))}
            </select>
          </FlitField>
        </div>
      </div>

      {cargando && (
        <div role="status" aria-label="Cargando viajes…" className="mt-4 space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="rounded-xl border p-4" style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-card)' }}>
              <div className="h-4 w-1/3 rounded" style={{ background: 'var(--flit-border-soft)' }} />
              <div className="mt-3 h-3 w-2/3 rounded" style={{ background: 'var(--flit-border-soft)' }} />
              <div className="mt-2 h-3 w-1/2 rounded" style={{ background: 'var(--flit-border-soft)' }} />
            </div>
          ))}
        </div>
      )}

      {carga === 'error403' && (
        <p className="mt-4 text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
          No tiene permiso para ver los viajes.
        </p>
      )}

      {carga === 'error' && (
        <div role="alert" className="mt-4 flex flex-wrap items-center gap-3 text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
          <p className="flex-1">No se pudieron cargar los viajes. Inténtelo de nuevo.</p>
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setIntento((n) => n + 1)}>
            Reintentar
          </button>
        </div>
      )}

      {carga === 'ok' && viajes.length === 0 && !conFiltro && (
        <div className="mt-4">
          <FlitEmpty>
            Aún no hay viajes. Regístrelos en Viajes: cuando queden registrados, aparecen aquí.
          </FlitEmpty>
        </div>
      )}

      {carga === 'ok' && viajes.length === 0 && conFiltro && (
        <div className="mt-4">
          <FlitEmpty>
            <p>Ningún viaje coincide con estos filtros. Pruebe otra placa o quite un filtro.</p>
            <button
              type="button"
              className="flit-focus mt-3 rounded-lg px-2 py-1 text-sm font-semibold transition-colors hover:bg-[var(--flit-bg-hover)]"
              style={{ color: 'var(--flit-blue-text)' }}
              onClick={limpiar}
            >
              Limpiar filtros
            </button>
          </FlitEmpty>
        </div>
      )}

      {carga === 'ok' && viajes.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <FlitTable label="Viajes">
            <thead>
              <FlitTr>
                <FlitTh>Compañía</FlitTh>
                <FlitTh>Destino</FlitTh>
                <FlitTh>Estado</FlitTh>
                <FlitTh>LT</FlitTh>
                <FlitTh>Registrado</FlitTh>
              </FlitTr>
            </thead>
            <tbody>
              {viajes.map((v) => (
                <FlitTr key={v.id}>
                  <td className="px-4 py-2 text-sm">{nombreCompania(v.companiaNombre, v.companiaId)}</td>
                  <td className="px-4 py-2 text-sm">{DESTINO_TRASLADO_LOGISTICA_LABEL[v.destino]}</td>
                  <td className="px-4 py-2">
                    <StatusChip tone={TONO[v.estado]}>{ESTADO_TRASLADO_LOGISTICA_LABEL[v.estado]}</StatusChip>
                  </td>
                  <td className="px-4 py-2 text-sm tabular-nums">{v.cantidadLt}</td>
                  <td className="px-4 py-2 text-sm">{fecha(v.registradoEn)}</td>
                </FlitTr>
              ))}
            </tbody>
          </FlitTable>
        </div>
      )}
    </FlitCard>
  );
}
