// Libro y cierres de una bolsa de tránsito (HU #13908, AC5 y AC6; spec
// `docs/ux/flito-bolsas-transito-13908-slim.md`).
//
// Cada sección trae sus datos y tiene sus cuatro estados por separado: si falla una de las dos rutas,
// la otra sigue a la vista y el «Reintentar» solo relee la suya.

import { useEffect, useId, useState } from 'react';
import {
  CodigoErrorBolsa,
  type CierreBolsaTransitoDto, type MovimientoTransitoDto, type OrigenMovimientoTransito,
} from '@operaciones/shared-types';
import { bolsasApi } from '../../lib/api';
import {
  abrirSoporteBolsa, cobroTransito, errorBolsa, etiquetaPeriodo, fechaDia, fechaHora, nombreSecretaria, pesos,
  saldoConSigno, ultimosPeriodos,
} from '../../lib/bolsas';
import FlitModal from '../flit/FlitModal';
import { toastOk } from '../flit/ToastFlito';
import {
  FlitCard, FlitEmpty, FlitTable, FlitTh, FlitTr, flitInp,
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../flit/flitPageKit';

const ENLACE = 'flit-focus rounded-sm font-semibold underline transition-colors hover:text-[color:var(--flit-blue-ink)]';

/** Meses que ofrece «Cerrar un mes»: los 12 anteriores al actual (el mes en curso no se cierra). */
const MESES_CERRABLES = 12;

const mayuscula = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Cómo se nombra una ENTRADA según su origen. `Record` exhaustivo: un origen nuevo es un error de
 * compilación aquí y no una etiqueta equivocada en pantalla.
 */
const ENTRADA_POR_ORIGEN: Record<OrigenMovimientoTransito, string> = {
  carga: 'Carga',
  automatico: 'Devolución',
  conciliacion: 'Conciliación',
};

function tipoMovimiento(m: MovimientoTransitoDto): string {
  if (m.tipo === 'entrada') return ENTRADA_POR_ORIGEN[m.origen] ?? 'Entrada';
  return m.concepto ? `Pago de ${cobroTransito(m.concepto).toLowerCase()}` : 'Consumo';
}

function FilasEsqueleto({ filas, etiqueta }: { filas: number; etiqueta: string }) {
  return (
    <div role="status" aria-label={etiqueta} className="space-y-2">
      {Array.from({ length: filas }, (_, i) => (
        <div key={i} className="h-8 rounded" style={{ background: 'var(--flit-bg-app)' }} />
      ))}
    </div>
  );
}

function ErrorSeccion({ texto, onReintentar }: { texto: string; onReintentar: () => void }) {
  return (
    <div>
      <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{texto}</p>
      <button type="button" className={`${flitBtnSecondary} mt-3`} style={flitBtnSecondaryStyle} onClick={onReintentar}>
        Reintentar
      </button>
    </div>
  );
}

// ─────────────────────────────── Movimientos ─────────────────────────────────

export function MovimientosTransito({ bolsaId, nonce, siguientePaso }: {
  bolsaId: string;
  /** Cambia tras una carga: hay que releer el libro. */
  nonce: number;
  /** Activa y con `bolsas.transito.cargar`: el vacío sugiere «Cargar saldo». */
  siguientePaso: boolean;
}) {
  const [movs, setMovs] = useState<MovimientoTransitoDto[] | null>(null);
  const [error, setError] = useState(false);
  const [reintento, setReintento] = useState(0);

  useEffect(() => {
    let vigente = true;
    setError(false);
    setMovs(null);
    bolsasApi.movimientosTransito(bolsaId)
      .then((m) => { if (vigente) setMovs(Array.isArray(m) ? m : []); })
      .catch(() => { if (vigente) setError(true); });
    return () => { vigente = false; };
  }, [bolsaId, nonce, reintento]);

  return (
    <FlitCard>
      <h3 className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>
        Movimientos{movs ? ` (${movs.length})` : ''}
      </h3>
      <p className="mb-3 mt-1 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
        Nada se edita ni se borra: una corrección es un movimiento nuevo.
      </p>
      {error ? (
        <ErrorSeccion texto="No pudimos cargar los movimientos de la bolsa. Intenta de nuevo."
          onReintentar={() => setReintento((n) => n + 1)} />
      ) : movs === null ? (
        <FilasEsqueleto filas={5} etiqueta="Cargando los movimientos" />
      ) : movs.length === 0 ? (
        <FlitEmpty>
          <span data-testid="movimientos-transito-vacio">
            {siguientePaso
              ? 'Esta bolsa todavía no tiene movimientos. Empieza con «Cargar saldo».'
              : 'Esta bolsa todavía no tiene movimientos.'}
          </span>
        </FlitEmpty>
      ) : (
        <FlitTable label="Movimientos de la bolsa de tránsito">
          <thead>
            <tr>
              <FlitTh>Fecha</FlitTh>
              <FlitTh>Tipo</FlitTh>
              <FlitTh>Secretaría</FlitTh>
              <FlitTh>Trámite</FlitTh>
              <FlitTh className="!text-right">Valor</FlitTh>
              <FlitTh className="!text-right">Saldo resultante</FlitTh>
              <FlitTh>Registrado por</FlitTh>
              <FlitTh center>Soporte</FlitTh>
            </tr>
          </thead>
          <tbody>
            {movs.map((m) => (
              <FlitTr key={m.id}>
                <td className="whitespace-nowrap px-4 py-2 text-sm">
                  <div>{fechaDia(m.fecha)}</div>
                  <div className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{fechaHora(m.createdAt)}</div>
                </td>
                <td className="px-4 py-2 text-sm">{tipoMovimiento(m)}</td>
                <td className="px-4 py-2 text-sm">{m.organismoCodigo ? nombreSecretaria(m.organismoCodigo) : '—'}</td>
                <td className="px-4 py-2 text-sm tabular-nums">
                  {m.tramiteId
                    ? <a className={ENLACE} style={{ color: 'var(--flit-blue-text)' }}
                        href={`/flito/tramites/${m.tramiteId}`}>{m.idFlit ?? 'Ver trámite'}</a>
                    : '—'}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-right text-sm font-semibold tabular-nums"
                  style={{ color: m.tipo === 'entrada' ? 'var(--flit-success-text)' : 'var(--flit-text-primary)' }}>
                  {m.tipo === 'entrada' ? '+' : '−'} {pesos(m.valor)}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-right text-sm tabular-nums">{saldoConSigno(m.saldoResultante)}</td>
                <td className="px-4 py-2 text-xs">{m.registradoPorNombre}</td>
                <td className="px-4 py-2 text-center">
                  {m.soporteId ? (
                    <button type="button" className={`${ENLACE} text-xs`} style={{ color: 'var(--flit-blue-text)' }}
                      aria-label={`Abrir el soporte del movimiento del ${fechaDia(m.fecha)}`}
                      onClick={() => abrirSoporteBolsa(m.soporteId!)}>
                      Ver soporte
                    </button>
                  ) : (
                    <span className="text-xs italic" style={{ color: 'var(--flit-text-muted)' }}>Sin soporte</span>
                  )}
                </td>
              </FlitTr>
            ))}
          </tbody>
        </FlitTable>
      )}
    </FlitCard>
  );
}

// ─────────────────────────────── Cierres ─────────────────────────────────────

export function CierresTransito({ bolsaId, nombre, nonce, puedeCerrar }: {
  bolsaId: string;
  nombre: string;
  nonce: number;
  /** `bolsas.transito.cierre.crear`. Sin ella «Cerrar un mes» no existe en el DOM (AC5). */
  puedeCerrar: boolean;
}) {
  const [cierres, setCierres] = useState<CierreBolsaTransitoDto[] | null>(null);
  const [error, setError] = useState(false);
  const [reintento, setReintento] = useState(0);
  const [cerrando, setCerrando] = useState(false);

  useEffect(() => {
    let vigente = true;
    setError(false);
    setCierres(null);
    bolsasApi.cierresTransito(bolsaId)
      .then((c) => {
        if (!vigente) return;
        const lista = Array.isArray(c) ? [...c] : [];
        lista.sort((a, b) => b.periodo.localeCompare(a.periodo));
        setCierres(lista);
      })
      .catch(() => { if (vigente) setError(true); });
    return () => { vigente = false; };
  }, [bolsaId, nonce, reintento]);

  const releer = () => setReintento((n) => n + 1);

  return (
    <FlitCard>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>Cierres del mes</h3>
        {puedeCerrar && (
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setCerrando(true)}>
            Cerrar un mes
          </button>
        )}
      </div>
      <div className="mt-3">
        {error ? (
          <ErrorSeccion texto="No pudimos cargar los cierres. Intenta de nuevo." onReintentar={releer} />
        ) : cierres === null ? (
          <FilasEsqueleto filas={3} etiqueta="Cargando los cierres" />
        ) : cierres.length === 0 ? (
          <FlitEmpty>
            <span data-testid="cierres-transito-vacio">
              {puedeCerrar
                ? 'Todavía no se ha cerrado ningún mes. Usa «Cerrar un mes» cuando termine el periodo.'
                : 'Todavía no se ha cerrado ningún mes.'}
            </span>
          </FlitEmpty>
        ) : (
          <FlitTable label="Cierres de la bolsa de tránsito">
            <thead>
              <tr>
                <FlitTh>Mes</FlitTh>
                <FlitTh className="!text-right">Saldo inicial</FlitTh>
                <FlitTh className="!text-right">Entradas</FlitTh>
                <FlitTh className="!text-right">Salidas</FlitTh>
                <FlitTh className="!text-right">Saldo final</FlitTh>
                <FlitTh className="!text-right">Movimientos</FlitTh>
                <FlitTh>Cerrado por / el</FlitTh>
              </tr>
            </thead>
            <tbody>
              {cierres.map((c) => (
                <FlitTr key={c.id}>
                  <td className="whitespace-nowrap px-4 py-2 text-sm font-semibold" data-testid={`cierre-${c.periodo}`}>
                    {mayuscula(etiquetaPeriodo(c.periodo))}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-right text-sm tabular-nums">{saldoConSigno(c.saldoInicial)}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-right text-sm tabular-nums">{pesos(c.totalEntradas)}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-right text-sm tabular-nums">{pesos(c.totalSalidas)}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-right text-sm font-semibold tabular-nums">{saldoConSigno(c.saldoFinal)}</td>
                  <td className="px-4 py-2 text-right text-sm tabular-nums">{c.movimientos}</td>
                  <td className="px-4 py-2 text-xs">
                    <div>{c.cerradoPorNombre}</div>
                    <div style={{ color: 'var(--flit-text-muted)' }}>{fechaHora(c.cerradoEn)}</div>
                  </td>
                </FlitTr>
              ))}
            </tbody>
          </FlitTable>
        )}
      </div>

      {cerrando && (
        <ModalCerrarMes bolsaId={bolsaId} nombre={nombre}
          cerrados={new Set((cierres ?? []).map((c) => c.periodo))}
          onClose={() => setCerrando(false)}
          onYaCerrado={releer}
          onHecho={() => { setCerrando(false); releer(); }} />
      )}
    </FlitCard>
  );
}

function ModalCerrarMes({ bolsaId, nombre, cerrados, onClose, onHecho, onYaCerrado }: {
  bolsaId: string;
  nombre: string;
  cerrados: Set<string>;
  onClose: () => void;
  onHecho: () => void;
  /** 409 `periodo_cerrado` (carrera): se relee la lista; el modal sigue abierto con el aviso. */
  onYaCerrado: () => void;
}) {
  const idMes = useId();
  /** Meses que el servidor ya dijo que están cerrados, aunque la lista aún no se haya releído. */
  const [yaCerrados, setYaCerrados] = useState<Set<string>>(new Set());
  const opciones = ultimosPeriodos(MESES_CERRABLES + 1).slice(1)
    .filter((p) => !cerrados.has(p) && !yaCerrados.has(p));
  const [periodo, setPeriodo] = useState(opciones[0] ?? '');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Si el mes elegido deja de ofrecerse (lo cerró otro), se pasa al primero disponible.
  const elegido = opciones.includes(periodo) ? periodo : (opciones[0] ?? '');
  const etiqueta = elegido ? etiquetaPeriodo(elegido) : '';

  async function confirmar() {
    if (!elegido || enviando) return;
    setEnviando(true);
    setError(null);
    try {
      await bolsasApi.cerrarMesTransito(bolsaId, elegido);
      toastOk(`${mayuscula(etiqueta)} cerrado.`);
      onHecho();
    } catch (e) {
      const { status, codigo } = errorBolsa(e);
      if (codigo === CodigoErrorBolsa.PERIODO_CERRADO || status === 409) {
        setError(`${mayuscula(etiqueta)} ya estaba cerrado. Lo verás en la lista de cierres.`);
        setYaCerrados((s) => new Set(s).add(elegido));
        onYaCerrado();
      } else {
        setError('No pudimos cerrar el mes. Intenta de nuevo.');
      }
    } finally {
      setEnviando(false);
    }
  }

  return (
    <FlitModal title={`Cerrar un mes de ${nombre}`} onClose={onClose} cierreBloqueado={enviando}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void confirmar(); }}>
        {opciones.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            Los últimos {MESES_CERRABLES} meses ya están cerrados.
          </p>
        ) : (
          <>
            <div>
              <label htmlFor={idMes} className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
                Mes *
              </label>
              <select id={idMes} className={flitInp} value={elegido}
                onChange={(e) => { setPeriodo(e.target.value); setError(null); }}>
                {opciones.map((p) => <option key={p} value={p}>{mayuscula(etiquetaPeriodo(p))}</option>)}
              </select>
            </div>
            <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
              Se guardan el saldo inicial, las entradas, las salidas y el saldo final de {etiqueta} tal como están hoy.
            </p>
          </>
        )}
        {error && <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose} disabled={enviando}>
            Cancelar
          </button>
          {opciones.length > 0 && (
            <button type="submit" className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={enviando}>
              {enviando ? 'Cerrando…' : `Cerrar ${etiqueta}`}
            </button>
          )}
        </div>
      </form>
    </FlitModal>
  );
}
