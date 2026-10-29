// FLITO Logística — «Mis recogidas» (HU #14111): sub-vista de Mi ruta. Lista (`GET /recogidas/mias`) y detalle
// (`GET /recogidas/:firmanteId`). La cédula del funcionario llega enmascarada (••••1234); el mensajero no la revela.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../../../lib/api';
import StatusChip from '../../flit/StatusChip';
import { FlitEmpty, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary } from '../../flit/flitPageKit';
import PasoFirma from './PasoFirma';
import { filaDePendiente, type PendienteFirma, type RespuestaMisRecogidas, type RespuestaPendientesFirma, type ResumenRecogidaMia } from './recogidaTipos';

type Resumen = ResumenRecogidaMia;
interface Detalle extends Omit<Resumen, 'actas' | 'pendientesTramite' | 'estadoFirma'> {
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

export default function MisRecogidas({ onVolver, onEscanear, puedeConfirmar }: { onVolver: () => void; onEscanear: () => void; puedeConfirmar: boolean }) {
  const [lista, setLista] = useState<Resumen[] | null>(null);
  const [pendientes, setPendientes] = useState<PendienteFirma[]>([]);
  const [contador, setContador] = useState(0);
  const [error, setError] = useState(false);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [elegidas, setElegidas] = useState<Set<string>>(new Set());
  const [firmando, setFirmando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  const cargar = useCallback(() => {
    setError(false); setLista(null);
    Promise.all([
      api.get<RespuestaMisRecogidas>('/flito/logistica/recogidas/mias'),
      api.get<RespuestaPendientesFirma>('/flito/logistica/recogidas/pendientes-firma'),
    ]).then(([m, p]) => {
      setLista(m.recogidas); setContador(m.pendientesFirma); setPendientes(p.pendientes);
      setElegidas(new Set(p.pendientes.map((x) => x.documentoId)));
    }).catch(() => setError(true));
  }, []);
  useEffect(cargar, [cargar]);

  const aFirmar = useMemo(() => pendientes.filter((p) => elegidas.has(p.documentoId)).map(filaDePendiente), [pendientes, elegidas]);
  const alternar = (id: string) => setElegidas((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  if (abierta) return <DetalleRecogida id={abierta} onVolver={() => setAbierta(null)} />;
  if (firmando) {
    return <PasoFirma filas={aFirmar} onAtras={() => setFirmando(false)} onSinFirma={() => setFirmando(false)}
      onConfirmado={(r) => { setFirmando(false); setAviso(`Firmaste ${r.actas === 1 ? '1 acta' : `${r.actas} actas`}. Las LT quedaron recogidas.`); cargar(); }} />;
  }
  const hayLista = lista !== null && (lista.length > 0 || pendientes.length > 0);
  return (
    <section className="space-y-3" aria-labelledby="mis-rec-titulo">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onVolver} className="flit-focus -ml-1 inline-flex items-center gap-1 rounded-lg px-2 py-2 text-sm font-medium transition-colors hover:bg-[var(--flit-bg-hover)]"
          style={{ color: 'var(--flit-text-secondary)', minHeight: 44 }}>
          <ChevronLeft size={18} aria-hidden="true" /> Mi ruta
        </button>
        <h2 id="mis-rec-titulo" className="text-base font-bold" style={{ color: 'var(--flit-blue-text)' }}>Mis recogidas</h2>
      </div>
      {aviso && <p role="status" className="rounded-xl border p-3.5 text-sm" style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-card)', color: 'var(--flit-text-primary)' }}>{aviso}</p>}
      {error && <Fallo texto="No pudimos cargar tus recogidas." onReintentar={cargar} />}
      {!error && lista === null && <Esqueleto filas={3} />}
      {lista && !hayLista && (
        <div className="space-y-3">
          <FlitEmpty>Todavía no has confirmado recogidas. Cuando escanees LT y las confirmes, las verás aquí.</FlitEmpty>
          <button type="button" className={`${flitBtnPrimary} w-full justify-center`} style={{ ...flitBtnPrimaryStyle, minHeight: 48 }} onClick={onEscanear}>Ir a escanear</button>
        </div>
      )}
      {lista && pendientes.length > 0 && (
        <div className="space-y-2" aria-labelledby="pend-firma-titulo" role="group">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="pend-firma-titulo" className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
              Pendientes de firma <StatusChip tone="warning">Falta firma · {contador}</StatusChip>
            </h3>
          </div>
          <ul className="space-y-2">
            {pendientes.map((p) => (
              <li key={p.documentoId}>
                <label className="flex cursor-pointer items-start gap-3 rounded-xl border bg-flit-card px-4 py-3 transition-colors hover:bg-[var(--flit-bg-hover)]"
                  style={{ borderColor: 'var(--flit-border-soft)', minHeight: 64 }}>
                  {puedeConfirmar && (
                    <input type="checkbox" className="flit-focus mt-1 size-5 shrink-0" checked={elegidas.has(p.documentoId)} onChange={() => alternar(p.documentoId)}
                      aria-label={`Firmar la LT ${p.numeroLt ?? ''} de la placa ${p.placa ?? ''}`.replace(/\s+/g, ' ').trim()} />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold tabular-nums" style={{ color: 'var(--flit-text-primary)' }}>{p.placa ?? 'Sin placa'} · {p.numeroLt ?? 'Sin N.º LT'}</span>
                    <span className="block text-xs" style={{ color: 'var(--flit-text-muted)' }}>
                      {p.pendienteTramite ? 'Pendiente de trámite' : (p.companiaNombre ?? 'Compañía sin nombre')} · Org. {p.organismoCodigo} · {fecha(p.fecha)}
                    </span>
                  </span>
                  <StatusChip tone="warning">{p.pendienteTramite ? 'Pendiente de trámite' : 'Falta firma'}</StatusChip>
                </label>
              </li>
            ))}
          </ul>
          {puedeConfirmar ? (
            <button type="button" className={`${flitBtnPrimary} w-full justify-center`} style={{ ...flitBtnPrimaryStyle, minHeight: 48 }}
              disabled={aFirmar.length === 0} onClick={() => { setAviso(null); setFirmando(true); }}>
              {aFirmar.length === 0 ? 'Elige LT para firmar' : `Firmar ${aFirmar.length} LT`}
            </button>
          ) : (
            <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Tu usuario no puede confirmar recogidas. Pide a Operaciones que las firme.</p>
          )}
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
