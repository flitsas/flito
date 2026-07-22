// FLITO — Panel de demostración (Fase 6). Porta packages/client/src/paginas/demo.tsx al kit flit/.
// Fabrica trámites en el FLIT simulado para ejercitar el flujo sin FLIT real: crear, anular+recrear
// (escenario RN-01/CA-03, mismo VIN) y mover su estado. Todo esto se retira al conectar FLIT real.
// Solo Operaciones. Requiere FLIT_ADAPTER=mock (el backend rechaza si no).

import { useEffect, useState } from 'react';
import {
  ESTADO_TRAMITE_FLITO_LABEL, EstadoTramiteFlito, TipoPropiedad,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import {
  FlitCard, FlitTable, FlitTh, FlitTr, FlitField, FlitEmpty,
  flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';

interface MockTramite {
  idFlit: string; estado: EstadoTramiteFlito; processStatus: number; placa: string | null; vin: string;
  marca: string | null; linea: string | null; companiaNit: string; organismoCodigo: string;
  tipoPropiedad: string; valorImpuestoLiquidado: number | null; creadoEn: string;
}
interface Compania { id: number; nombre: string }
interface Organismo { codigo: string; nombre: string }

const TONO: Record<EstadoTramiteFlito, ChipTone> = {
  asignado: 'active', entregado: 'success', aprobado: 'success', anulado: 'neutral', rechazado: 'danger',
};
const pesos = (v: number | null) => v === null ? '—'
  : new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(v);

export default function FlitoDemo() {
  const [data, setData] = useState<MockTramite[] | null>(null);
  const [companias, setCompanias] = useState<Compania[]>([]);
  const [organismos, setOrganismos] = useState<Organismo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [sincronizando, setSincronizando] = useState(false);
  const [recarga, setRecarga] = useState(0);
  const refrescar = () => setRecarga((n) => n + 1);

  useEffect(() => {
    setError(null);
    api.get<MockTramite[]>('/flito/demo/tramites').then(setData).catch((e) => setError(errorMessage(e)));
  }, [recarga]);

  useEffect(() => {
    api.get<Compania[]>('/flito/parametrizacion/companias').then(setCompanias).catch(() => setCompanias([]));
    api.get<Organismo[]>('/flito/parametrizacion/organismos').then(setOrganismos).catch(() => setOrganismos([]));
  }, []);

  const accion = async (fn: () => Promise<unknown>, ok: string) => {
    setError(null); setAviso(null);
    try { await fn(); setAviso(ok); refrescar(); }
    catch (e) { setError(errorMessage(e)); }
  };

  const sincronizar = async () => {
    setSincronizando(true); setError(null); setAviso(null);
    try { await api.post('/flito/sync/sincronizar'); setAviso('Sincronización ejecutada.'); refrescar(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setSincronizando(false); }
  };

  const filas = data ?? [];

  return (
    <div className="space-y-4">
      <PageHeaderCard title="Panel de demo"
        subtitle="Andamiaje: fabrica trámites en el FLIT simulado para probar el flujo sin FLIT real. Se retira al conectar el adaptador HTTP."
        actions={
          <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={sincronizando} onClick={sincronizar}>
            {sincronizando ? 'Sincronizando…' : 'Sincronizar desde FLIT'}
          </button>
        } />

      {error && <FlitCard><p className="text-sm text-red-600">{error}</p></FlitCard>}
      {aviso && <FlitCard><p className="text-sm" style={{ color: 'var(--flit-success)' }}>{aviso}</p></FlitCard>}

      <FormCrear companias={companias} organismos={organismos}
        onCreado={() => accion(() => Promise.resolve(), 'Trámite creado.')}
        onError={setError} onOk={(m) => { setAviso(m); refrescar(); }} />

      <FlitCard>
        {!data ? <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando…</p>
          : filas.length === 0 ? <FlitEmpty>No hay trámites en el FLIT simulado. Crea uno arriba.</FlitEmpty> : (
          <FlitTable>
            <thead><FlitTr>
              <FlitTh>Trámite</FlitTh><FlitTh>Placa / VIN</FlitTh><FlitTh>Vehículo</FlitTh>
              <FlitTh>Organismo</FlitTh><FlitTh>Liquidado</FlitTh><FlitTh>Estado</FlitTh><FlitTh /></FlitTr></thead>
            <tbody>
              {filas.map((t) => (
                <FlitTr key={t.idFlit}>
                  <td className="px-3 py-2 text-xs tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>{t.idFlit}</td>
                  <td className="px-3 py-2"><div className="font-medium">{t.placa ?? '—'}</div><div className="text-[11px] tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>{t.vin}</div></td>
                  <td className="px-3 py-2 text-sm">{t.marca} {t.linea}</td>
                  <td className="px-3 py-2 text-sm">{t.organismoCodigo}</td>
                  <td className="px-3 py-2 text-sm tabular-nums">{pesos(t.valorImpuestoLiquidado)}</td>
                  <td className="px-3 py-2"><StatusChip tone={TONO[t.estado]}>{ESTADO_TRAMITE_FLITO_LABEL[t.estado]}</StatusChip></td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <button className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                        onClick={() => accion(() => api.post(`/flito/demo/tramites/${t.idFlit}/anular-recrear`), 'Trámite anulado y recreado sobre el mismo VIN.')}>
                        Anular + recrear
                      </button>
                      <select className={`${flitInp} w-auto py-1.5`} value={t.estado}
                        onChange={(e) => accion(() => api.post(`/flito/demo/tramites/${t.idFlit}/estado`, { estado: e.target.value }), 'Estado del trámite actualizado.')}>
                        {(Object.keys(ESTADO_TRAMITE_FLITO_LABEL) as EstadoTramiteFlito[]).map((s) => (
                          <option key={s} value={s}>{ESTADO_TRAMITE_FLITO_LABEL[s]}</option>
                        ))}
                      </select>
                    </div>
                  </td>
                </FlitTr>
              ))}
            </tbody>
          </FlitTable>
        )}
      </FlitCard>
    </div>
  );
}

function FormCrear({ companias, organismos, onError, onOk }: {
  companias: Compania[]; organismos: Organismo[];
  onCreado: () => void; onError: (m: string) => void; onOk: (m: string) => void;
}) {
  const [companiaId, setCompaniaId] = useState('');
  const [organismoCodigo, setOrganismoCodigo] = useState('');
  const [tipoPropiedad, setTipoPropiedad] = useState<TipoPropiedad>(TipoPropiedad.UNICO_PROPIETARIO);
  const [vin, setVin] = useState('');
  const [placa, setPlaca] = useState('');
  const [creando, setCreando] = useState(false);

  const crear = async () => {
    if (!companiaId || !organismoCodigo) return;
    setCreando(true);
    const body: Record<string, unknown> = { companiaId: Number(companiaId), organismoCodigo, tipoPropiedad };
    if (vin.trim()) body.vin = vin.trim();
    if (placa.trim()) body.placa = placa.trim();
    try {
      await api.post('/flito/demo/tramites', body);
      setVin(''); setPlaca('');
      onOk('Trámite creado en el FLIT simulado.');
    } catch (e) { onError(errorMessage(e)); }
    finally { setCreando(false); }
  };

  return (
    <FlitCard>
      <p className="mb-3 text-sm font-semibold" style={{ color: 'var(--flit-blue-text)' }}>Crear trámite simulado</p>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
        <FlitField label="Compañía">
          <select className={flitInp} value={companiaId} onChange={(e) => setCompaniaId(e.target.value)}>
            <option value="">Selecciona…</option>
            {companias.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </select>
        </FlitField>
        <FlitField label="Organismo">
          <select className={flitInp} value={organismoCodigo} onChange={(e) => setOrganismoCodigo(e.target.value)}>
            <option value="">Selecciona…</option>
            {organismos.map((o) => <option key={o.codigo} value={o.codigo}>{o.nombre}</option>)}
          </select>
        </FlitField>
        <FlitField label="Propiedad">
          <select className={flitInp} value={tipoPropiedad} onChange={(e) => setTipoPropiedad(e.target.value as TipoPropiedad)}>
            <option value={TipoPropiedad.UNICO_PROPIETARIO}>Único propietario</option>
            <option value={TipoPropiedad.MULTIPLE_PROPIETARIO}>Múltiple propietario</option>
          </select>
        </FlitField>
        <FlitField label="VIN (opcional)"><input className={flitInp} value={vin} onChange={(e) => setVin(e.target.value)} placeholder="Repite para probar RN-01" /></FlitField>
        <FlitField label="Placa (opcional)"><input className={flitInp} value={placa} onChange={(e) => setPlaca(e.target.value)} /></FlitField>
      </div>
      <div className="mt-3">
        <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={creando || !companiaId || !organismoCodigo} onClick={crear}>
          {creando ? 'Creando…' : 'Crear trámite'}
        </button>
      </div>
    </FlitCard>
  );
}
