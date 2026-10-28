// FLITO Logística — «Mis recogidas» (HU #14111): sub-vista de Mi ruta. Lista (`GET /recogidas/mias`) y detalle
// (`GET /recogidas/:firmanteId`). La cédula del funcionario llega enmascarada (••••1234); el mensajero no la revela.

import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../../../lib/api';
import StatusChip from '../../flit/StatusChip';
import { FlitEmpty, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary } from '../../flit/flitPageKit';

interface Resumen { firmanteId: string; organismoCodigo: string; nombre: string; documentoEnmascarado: string | null; firmadoEn: string; actas: number; pendientesTramite: number }
interface Detalle extends Omit<Resumen, 'actas' | 'pendientesTramite'> {
  actas: Array<{ actaId: string; companiaId: number; companiaNombre: string | null; documentoIds: string[] }>; pendientesTramite: string[];
}

const fecha = (iso: string) => new Date(iso).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

function Esqueleto({ filas }: { filas: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Cargando">
      {Array.from({ length: filas }, (_, i) => <div key={i} className="h-16 animate-pulse rounded-xl" style={{ background: 'var(--flit-bg-hover)' }} />)}
    </div>
  );
}

function Fallo({ texto, onReintentar }: { texto: string; onReintentar: () => void }) {
  return (
    <div role="alert" className="space-y-2 rounded-xl border p-4 text-sm" style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-card)', color: 'var(--flit-danger-ink)' }}>
      <p>{texto}</p>
      <button type="button" className={flitBtnSecondary} onClick={onReintentar}>Reintentar</button>
    </div>
  );
}

export default function MisRecogidas({ onVolver, onEscanear }: { onVolver: () => void; onEscanear: () => void }) {
  const [lista, setLista] = useState<Resumen[] | null>(null);
  const [error, setError] = useState(false);
  const [abierta, setAbierta] = useState<string | null>(null);

  const cargar = useCallback(() => {
    setError(false); setLista(null);
    api.get<{ recogidas: Resumen[] }>('/flito/logistica/recogidas/mias').then((r) => setLista(r.recogidas)).catch(() => setError(true));
  }, []);
  useEffect(cargar, [cargar]);

  if (abierta) return <DetalleRecogida id={abierta} onVolver={() => setAbierta(null)} />;
  return (
    <section className="space-y-3" aria-labelledby="mis-rec-titulo">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onVolver} className="flit-focus -ml-1 inline-flex items-center gap-1 rounded-lg px-2 py-2 text-sm font-medium transition-colors hover:bg-[var(--flit-bg-hover)]"
          style={{ color: 'var(--flit-text-secondary)', minHeight: 44 }}>
          <ChevronLeft size={18} aria-hidden="true" /> Mi ruta
        </button>
        <h2 id="mis-rec-titulo" className="text-base font-bold" style={{ color: 'var(--flit-blue-text)' }}>Mis recogidas</h2>
      </div>
      {error && <Fallo texto="No pudimos cargar tus recogidas." onReintentar={cargar} />}
      {!error && lista === null && <Esqueleto filas={3} />}
      {lista?.length === 0 && (
        <div className="space-y-3">
          <FlitEmpty>Todavía no has confirmado recogidas. Cuando escanees LT y las confirmes, las verás aquí.</FlitEmpty>
          <button type="button" className={`${flitBtnPrimary} w-full justify-center`} style={{ ...flitBtnPrimaryStyle, minHeight: 48 }} onClick={onEscanear}>Ir a escanear</button>
        </div>
      )}
      {lista && lista.length > 0 && (
        <ul className="space-y-2">
          {lista.map((r) => (
            <li key={r.firmanteId}>
              <button type="button" onClick={() => setAbierta(r.firmanteId)}
                className="flit-focus flex w-full items-center justify-between gap-2 rounded-xl border bg-flit-card px-4 py-3 text-left transition-colors hover:bg-[var(--flit-bg-hover)]"
                style={{ borderColor: 'var(--flit-border-soft)', minHeight: 64 }}>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{fecha(r.firmadoEn)} · Org. {r.organismoCodigo}</span>
                  <span className="block text-xs" style={{ color: 'var(--flit-text-muted)' }}>
                    {plural(r.actas, 'acta', 'actas')}{r.pendientesTramite ? ` · ${plural(r.pendientesTramite, 'LT pendiente', 'LT pendientes')}` : ''}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1"><StatusChip tone="success">Firmada</StatusChip><ChevronRight size={16} aria-hidden="true" style={{ color: 'var(--flit-text-muted)' }} /></span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DetalleRecogida({ id, onVolver }: { id: string; onVolver: () => void }) {
  const [d, setD] = useState<Detalle | null>(null);
  const [error, setError] = useState(false);
  const cargar = useCallback(() => {
    setError(false); setD(null);
    api.get<Detalle>(`/flito/logistica/recogidas/${id}`).then(setD).catch(() => setError(true));
  }, [id]);
  useEffect(cargar, [cargar]);
  return (
    <section className="space-y-3" aria-labelledby="det-rec-titulo">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onVolver} className="flit-focus -ml-1 inline-flex items-center gap-1 rounded-lg px-2 py-2 text-sm font-medium transition-colors hover:bg-[var(--flit-bg-hover)]"
          style={{ color: 'var(--flit-text-secondary)', minHeight: 44 }}>
          <ChevronLeft size={18} aria-hidden="true" /> Mis recogidas
        </button>
        <h2 id="det-rec-titulo" className="text-base font-bold" style={{ color: 'var(--flit-blue-text)' }}>{d ? `Recogida del ${fecha(d.firmadoEn)}` : 'Recogida'}</h2>
      </div>
      {error && <Fallo texto="No pudimos cargar esta recogida." onReintentar={cargar} />}
      {!error && !d && <Esqueleto filas={2} />}
      {d && (
        <div className="space-y-3">
          <div className="rounded-xl border bg-flit-card p-3.5 text-sm" style={{ borderColor: 'var(--flit-border-soft)' }}>
            <p style={{ color: 'var(--flit-text-primary)' }}>Funcionario: <span className="font-semibold">{d.nombre}</span></p>
            <p style={{ color: 'var(--flit-text-secondary)' }}>Cédula <span className="tabular-nums">{d.documentoEnmascarado ?? '—'}</span> · Org. {d.organismoCodigo}</p>
            <div className="mt-2"><StatusChip tone="success">Firmada</StatusChip></div>
          </div>
          {d.actas.map((a, i) => (
            <div key={a.actaId} className="rounded-xl border bg-flit-card p-3.5 text-sm" style={{ borderColor: 'var(--flit-border-soft)' }}>
              <p className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Acta {i + 1} · {a.companiaNombre ?? 'Compañía'}</p>
              <p style={{ color: 'var(--flit-text-muted)' }}>{plural(a.documentoIds.length, 'LT', 'LT')}</p>
            </div>
          ))}
          {d.pendientesTramite.length > 0 && (
            <p className="rounded-xl border p-3.5 text-sm" style={{ borderColor: 'var(--flit-border-soft)', color: 'var(--flit-text-secondary)' }}>
              Pendientes de trámite: {d.pendientesTramite.length}. Quedaron firmadas, sin acta, hasta que Operaciones elija el trámite.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
