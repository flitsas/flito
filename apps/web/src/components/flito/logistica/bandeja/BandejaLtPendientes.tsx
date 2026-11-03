// HU #14149 — Pestaña «LT pendientes» de Logística (diseño: docs/ux/logistica-bandeja-lt-pendientes-14149-full.md).
// Filtros y orden en el cliente: la placa nunca sale del navegador (ni URL, ni consola).
import { useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import {
  FlitCard, FlitEmpty, FlitPillButton, FlitPillGroup, FlitTable, FlitTh, FlitTr, flitBtnSecondary, flitBtnSecondaryStyle, flitInp,
} from '../../../flit/flitPageKit';
import { toastError, toastOk } from '../../../flit/ToastFlito';
import ChipFirma, { PuntoFirma } from './ChipFirma';
import ElegirTramiteModal, { type ResultadoModal } from './ElegirTramiteModal';
import { TOPE_BANDEJA, fechaHora, textoAntiguedad, textoCandidatos, type PendienteLt } from './tipos';

type FiltroFirma = 'todas' | 'con' | 'sin';
const mutedStyle = { color: 'var(--flit-text-muted)' } as const;

interface Props { items: PendienteLt[] | null; cargando: boolean; error: boolean; recargar: () => Promise<void> | void }

export default function BandejaLtPendientes({ items, cargando, error, recargar }: Props) {
  const [buscar, setBuscar] = useState('');
  const [firma, setFirma] = useState<FiltroFirma>('todas');
  const [masAntiguaPrimero, setOrden] = useState(true);
  const [abierta, setAbierta] = useState<PendienteLt | null>(null);
  const encabezadoRef = useRef<HTMLHeadingElement>(null);

  const visibles = useMemo(() => {
    const q = buscar.trim().toLowerCase();
    const f = (items ?? []).filter((i) => (!q || (i.placa ?? '').toLowerCase().includes(q))
      && (firma === 'todas' || (firma === 'con' ? i.firmada : !i.firmada)));
    return f.sort((a, b) => (masAntiguaPrimero ? b.antiguedadDias - a.antiguedadDias : a.antiguedadDias - b.antiguedadDias)
      || a.recogidoEn.localeCompare(b.recogidoEn) * (masAntiguaPrimero ? 1 : -1));
  }, [items, buscar, firma, masAntiguaPrimero]);

  const limpiar = () => { setBuscar(''); setFirma('todas'); };
  const terminar = (r: ResultadoModal) => {
    setAbierta(null);
    if (r.tipo === 'cancelar') return;
    if (r.tipo === 'ok') toastOk(r.texto ?? '', { id: 'lt-asignada', duracionMs: 6_000 });
    else toastError(r.texto ?? '', undefined, { id: 'lt-no-pendiente' });
    void recargar();
  };

  const primeraCarga = items === null && !error;
  const filtrando = buscar.trim() !== '' || firma !== 'todas';

  return (
    <div aria-busy={cargando && items === null}>
      <h2 ref={encabezadoRef} tabIndex={-1} className="sr-only">LT pendientes de trámite</h2>
      <FlitCard>
        <p className="mb-3 text-xs" style={mutedStyle}>
          LT que el mensajero recogió sin saber a qué trámite pertenecen. Elige el trámite para que puedan entrar al acta, al viaje y al cobro.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-full sm:max-w-xs">
            <label htmlFor="lt-buscar" className="sr-only">Buscar por placa</label>
            <input id="lt-buscar" className={flitInp} placeholder="Buscar placa…" value={buscar} disabled={primeraCarga}
              onChange={(e) => setBuscar(e.target.value)} autoComplete="off" />
          </div>
          <FlitPillGroup label="Filtrar por firma">
            <FlitPillButton active={firma === 'todas'} pressed={firma === 'todas'} onClick={() => setFirma('todas')}>Todas</FlitPillButton>
            <FlitPillButton active={firma === 'con'} pressed={firma === 'con'} onClick={() => setFirma('con')}><PuntoFirma firmada /> Con firma</FlitPillButton>
            <FlitPillButton active={firma === 'sin'} pressed={firma === 'sin'} onClick={() => setFirma('sin')}><PuntoFirma firmada={false} /> Sin firma</FlitPillButton>
          </FlitPillGroup>
          <div className="lg:hidden">
            <label htmlFor="lt-orden" className="sr-only">Orden</label>
            <select id="lt-orden" className={flitInp} value={masAntiguaPrimero ? 'asc' : 'desc'} onChange={(e) => setOrden(e.target.value === 'asc')}>
              <option value="asc">Antigüedad: más antigua primero</option>
              <option value="desc">Antigüedad: más reciente primero</option>
            </select>
          </div>
        </div>
      </FlitCard>

      {primeraCarga && (
        <FlitCard>
          <div className="mt-0 space-y-2" role="status" aria-label="Cargando LT pendientes">
            {[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-12 animate-pulse rounded-lg" style={{ background: 'var(--flit-border-soft)' }} />)}
          </div>
        </FlitCard>
      )}

      {error && (
        <FlitCard>
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
            <span>No pudimos cargar las LT pendientes. Revisa tu conexión e inténtalo de nuevo.</span>
            <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => void recargar()}>Reintentar</button>
          </div>
        </FlitCard>
      )}

      {items !== null && items.length === 0 && !error && (
        <FlitCard><FlitEmpty>No hay LT esperando trámite. Cuando un mensajero deje una LT sin saber a cuál trámite pertenece, aparecerá aquí.</FlitEmpty></FlitCard>
      )}

      {items !== null && items.length > 0 && (
        <>
          <p role="status" className="sr-only">{visibles.length} LT</p>
          {visibles.length === 0 ? (
            <FlitCard>
              <FlitEmpty>
                Ninguna LT coincide con tu búsqueda. Quita el filtro de firma o prueba con otra placa.{' '}
                {filtrando && (
                  <button type="button" onClick={limpiar}
                    className="flit-focus rounded px-1 font-semibold transition-colors hover:bg-[var(--flit-bg-hover)] hover:underline" style={{ color: 'var(--flit-blue-text)' }}>Limpiar filtros</button>
                )}
              </FlitEmpty>
            </FlitCard>
          ) : (
            <>
              <FlitCard className="hidden lg:block">
                <div className="overflow-x-auto">
                  <FlitTable label="LT pendientes de trámite">
                    <thead>
                      <FlitTr>
                        <FlitTh>Placa</FlitTh><FlitTh>Organismo</FlitTh><FlitTh>Recogida</FlitTh>
                        <FlitTh ariaSort={masAntiguaPrimero ? 'descending' : 'ascending'}>
                          <button type="button" onClick={() => setOrden((v) => !v)}
                            className="flit-focus inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 uppercase tracking-wide transition-colors hover:bg-[var(--flit-bg-hover)] hover:text-[color:var(--flit-text-primary)]">
                            Antigüedad {masAntiguaPrimero ? <ArrowDown size={12} aria-hidden="true" /> : <ArrowUp size={12} aria-hidden="true" />}
                            <span className="sr-only">{masAntiguaPrimero ? ', más antigua primero' : ', más reciente primero'}</span>
                          </button>
                        </FlitTh>
                        <FlitTh>Firma</FlitTh><FlitTh>Acción</FlitTh>
                      </FlitTr>
                    </thead>
                    <tbody>
                      {visibles.map((l) => (
                        <FlitTr key={l.documentoId}>
                          <td className="px-4 py-2">
                            <div className="text-sm font-medium tabular-nums">{l.placa ?? '—'}</div>
                            <div className="text-xs" style={mutedStyle}>{textoCandidatos(l.candidatos.length)}</div>
                          </td>
                          <td className="px-4 py-2 text-sm">{l.organismoCodigo}</td>
                          <td className="px-4 py-2"><div className="text-sm">{l.recogidoPorNombre ?? '—'}</div><div className="text-xs" style={mutedStyle}>{fechaHora(l.recogidoEn)}</div></td>
                          <td className="px-4 py-2 text-sm tabular-nums">{textoAntiguedad(l.antiguedadDias)}</td>
                          <td className="px-4 py-2"><ChipFirma firmada={l.firmada} /></td>
                          <td className="px-4 py-2">
                            <button type="button" onClick={() => setAbierta(l)}
                              className="flit-focus cursor-pointer rounded px-2 py-1 text-xs font-semibold transition-colors hover:bg-[var(--flit-bg-hover)] hover:underline" style={{ color: 'var(--flit-blue-text)' }}>
                              Elegir trámite<span className="sr-only"> de {l.placa ?? 'la LT'}</span>
                            </button>
                          </td>
                        </FlitTr>
                      ))}
                    </tbody>
                  </FlitTable>
                </div>
              </FlitCard>

              <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:hidden">
                {visibles.map((l) => (
                  <li key={l.documentoId}>
                    <FlitCard>
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-sm font-semibold tabular-nums">{l.placa ?? '—'}</span>
                        <ChipFirma firmada={l.firmada} />
                      </div>
                      <div className="mt-1 text-sm">{l.organismoCodigo}</div>
                      <div className="text-sm">Recogió: {l.recogidoPorNombre ?? '—'}</div>
                      <div className="text-xs" style={mutedStyle}>{fechaHora(l.recogidoEn)}</div>
                      <div className="mt-1 text-xs" style={mutedStyle}>{textoAntiguedad(l.antiguedadDias)} · {textoCandidatos(l.candidatos.length)}</div>
                      <button type="button" className={`${flitBtnSecondary} mt-3 w-full justify-center`} style={flitBtnSecondaryStyle} onClick={() => setAbierta(l)}>
                        Elegir trámite<span className="sr-only"> de {l.placa ?? 'la LT'}</span>
                      </button>
                    </FlitCard>
                  </li>
                ))}
              </ul>
              {items.length >= TOPE_BANDEJA && (
                <p className="text-xs" style={mutedStyle}>Mostrando las {TOPE_BANDEJA} más antiguas.</p>
              )}
            </>
          )}
        </>
      )}

      {abierta && <ElegirTramiteModal lt={abierta} restoreFocusRef={encabezadoRef} onTerminar={terminar} />}
    </div>
  );
}
