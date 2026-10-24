// Detalle de la bolsa de una compañía (HU #13901, Feature #13886; spec `docs/ux/flito-bolsas.md`
// Pantalla 3). Sustituye a `ModalDetalleCliente`.
//
// Se entra por `bolsaId` (fila del listado, éxito del alta, «Ver su bolsa») o por `companiaId`
// (alertas de saldo, que solo conocen la compañía). Por compañía sin bolsa no hay error: hay un aviso
// de página «Crea la bolsa de la compañía primero» (AC6).
//
// AC9: `FlitModal full` deja el diálogo en `overflow-hidden` y delega el scroll en el hijo. El hijo
// es `RegionDesplazable`: la cabecera del modal (título y ✕) queda fuera de la región y siempre se ve.
// NO se toca `FlitModal` (lo usan ~90 archivos). El detalle de tránsito usa el mismo envoltorio.
//
// El extracto, el libro y los cierres siguen por `/:companiaId/…` (el diseño conserva esas rutas y
// `companiaId` no es nulo en compañía), así las cifras salen del mismo libro que el resto del módulo.

import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  CONCEPTO_BOLSA_LABEL, NIVEL_RIESGO_BOLSA_LABEL, CodigoErrorBolsa,
  type BolsaConRiesgo, type BolsaDetalleDto, type CierreDto, type ConceptoBolsa, type ExtractoCliente,
  type MovimientoBolsaDto,
} from '@operaciones/shared-types';
import { api, bolsasApi } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { hasPage } from '../../lib/permissions';
import {
  avisoAutogestion, errorBolsa, etiquetaPeriodo, fechaDia, fechaHora, MOTIVO_MINIMO, periodoActual, pesos,
  TONO_NIVEL, ultimosPeriodos,
} from '../../lib/bolsas';
import BolsaAcciones from './BolsaAcciones';
import BolsaExtracto from './BolsaExtracto';
import BolsaForm, { AvisoAutogestion } from './BolsaForm';
import BolsaMovimientos from './BolsaMovimientos';
import FlitModal from '../flit/FlitModal';
import StatusChip from '../flit/StatusChip';
import {
  FlitCard, flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../flit/flitPageKit';

/** Cuántos meses ofrece el selector de periodo. Un año cubre cualquier cierre que siga en disputa. */
const PERIODOS_OFRECIDOS = 12;

/**
 * Región desplazable del detalle (AC9). Rueda y gesto no necesitan el `tabIndex`; las teclas
 * (↑↓, Re/Av Pág, Inicio/Fin) sí. `overscroll-contain` evita que el gesto arrastre la página de
 * debajo del velo y `overflow-x-hidden` que el modal tenga scroll horizontal: las tablas usan el suyo.
 */
export function RegionDesplazable({ etiqueta, children }: { etiqueta: string; children: ReactNode }) {
  return (
    <div role="region" aria-label={etiqueta} tabIndex={0} data-testid="region-detalle"
      className="flit-focus -mx-6 h-full min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain px-6">
      <div className="min-w-0 space-y-4 pb-2">{children}</div>
    </div>
  );
}

export type EntradaDetalle = { bolsaId: string } | { companiaId: number };

interface Props {
  entrada: EntradaDetalle;
  /** Nombre que ya se conoce (fila o alerta), para la cabecera mientras carga. */
  nombre: string;
  onClose: () => void;
  /** Algo cambió (recarga, estado, conceptos): el listado se relee. */
  onCambio: () => void;
  /** AC6: abre el formulario de alta con esta compañía ya elegida. `null` sin `bolsas.bolsa.crear`. */
  onCrearBolsa: ((companiaId: number) => void) | null;
}

type Carga =
  | { tipo: 'cargando' }
  | { tipo: 'error' }
  | { tipo: 'no-existe' }
  | { tipo: 'sin-bolsa'; companiaId: number }
  | { tipo: 'lista'; bolsa: BolsaDetalleDto };

export default function BolsaDetalleCompania({ entrada, nombre, onClose, onCambio, onCrearBolsa }: Props) {
  const [carga, setCarga] = useState<Carga>({ tipo: 'cargando' });
  const [nonce, setNonce] = useState(0);

  const refrescar = useCallback(() => { setNonce((n) => n + 1); onCambio(); }, [onCambio]);

  const claveEntrada = 'bolsaId' in entrada ? `b:${entrada.bolsaId}` : `c:${entrada.companiaId}`;

  useEffect(() => {
    let vigente = true;
    (async () => {
      try {
        let bolsaId: string | null = 'bolsaId' in entrada ? entrada.bolsaId : null;
        if (bolsaId === null && 'companiaId' in entrada) {
          // Por compañía: el mapa de `/buscar` da el id; si no está, `/estado` confirma que no hay bolsa.
          const filas = await bolsasApi.buscar({ alcance: 'compania' });
          bolsaId = filas.find((f) => f.companiaId === entrada.companiaId)?.id ?? null;
          if (bolsaId === null) {
            const estado = await bolsasApi.estadoCompania(entrada.companiaId);
            if (!vigente) return;
            setCarga(estado.existe ? { tipo: 'error' } : { tipo: 'sin-bolsa', companiaId: entrada.companiaId });
            return;
          }
        }
        const bolsa = await bolsasApi.detalle(bolsaId!);
        if (vigente) setCarga({ tipo: 'lista', bolsa });
      } catch (e) {
        if (!vigente) return;
        setCarga(errorBolsa(e).status === 404 ? { tipo: 'no-existe' } : { tipo: 'error' });
      }
    })();
    return () => { vigente = false; };
    // `claveEntrada` resume `entrada`: el objeto cambia de identidad en cada render del padre.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claveEntrada, nonce]);

  const titulo = carga.tipo === 'lista' ? carga.bolsa.nombre : nombre;

  return (
    <FlitModal title={titulo} onClose={onClose} full>
      <RegionDesplazable etiqueta={`Detalle de la bolsa de ${titulo}`}>
        {carga.tipo === 'cargando' && <EsqueletoBolsa />}

        {carga.tipo === 'error' && (
          <FlitCard>
            <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
              No pudimos cargar la bolsa. Intenta de nuevo.
            </p>
            <button type="button" className={`${flitBtnSecondary} mt-3`} style={flitBtnSecondaryStyle}
              onClick={() => { setCarga({ tipo: 'cargando' }); setNonce((n) => n + 1); }}>
              Reintentar
            </button>
          </FlitCard>
        )}

        {carga.tipo === 'no-existe' && (
          <FlitCard>
            <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
              Esta bolsa ya no existe o no tienes acceso a ella.
            </p>
            <button type="button" className={`${flitBtnSecondary} mt-3`} style={flitBtnSecondaryStyle} onClick={onClose}>
              Volver al listado
            </button>
          </FlitCard>
        )}

        {carga.tipo === 'sin-bolsa' && (
          <AvisoSinBolsa nombre={nombre}
            onCrear={onCrearBolsa ? () => onCrearBolsa(carga.companiaId) : null} />
        )}

        {carga.tipo === 'lista' && (
          <ContenidoBolsa bolsa={carga.bolsa} onRefrescar={refrescar}
            onCrearBolsa={onCrearBolsa && carga.bolsa.companiaId !== null
              ? () => onCrearBolsa(carga.bolsa.companiaId!) : null} />
        )}
      </RegionDesplazable>
    </FlitModal>
  );
}

function EsqueletoBolsa() {
  const barra = (w: string, h = 'h-3') => (
    <div className={`${h} rounded`} style={{ width: w, background: 'var(--flit-bg-app)' }} />
  );
  return (
    <div role="status" aria-label="Cargando la bolsa" className="space-y-4">
      <FlitCard>
        <div className="space-y-3">
          {barra('30%')}
          {barra('45%', 'h-7')}
          {barra('60%')}
        </div>
      </FlitCard>
      <FlitCard>
        <div className="space-y-3">{barra('80%')}{barra('70%')}{barra('75%')}</div>
      </FlitCard>
    </div>
  );
}

function AvisoSinBolsa({ nombre, onCrear }: { nombre: string; onCrear: (() => void) | null }) {
  return (
    <div role="status" data-testid="aviso-sin-bolsa"
      className="rounded-lg border p-4 text-sm"
      style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-app)', color: 'var(--flit-text-secondary)' }}>
      <p className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{nombre} no tiene bolsa.</p>
      <p className="mt-1">
        {onCrear
          ? 'Crea la bolsa de la compañía primero: después podrás registrar recargas y sus trámites descontarán de ella.'
          : 'Crea la bolsa de la compañía primero. Pídele a Financiera que la cree.'}
      </p>
      {onCrear && (
        <div className="mt-3 flex justify-end">
          <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={onCrear}>Crear bolsa</button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────── Contenido ───────────────────────────────────

/** `BolsaExtracto` habla el tipo del tablero antiguo; se adapta en vez de tocarlo (sin cambio, spec). */
function comoBolsaConRiesgo(b: BolsaDetalleDto): BolsaConRiesgo {
  return {
    id: b.id,
    companiaId: b.companiaId ?? 0,
    companiaNombre: b.nombre,
    saldo: b.saldo,
    ultimaRecargaValor: b.ultimaEntradaValor,
    ultimaRecargaEn: b.ultimaEntradaEn,
    nivel: b.nivel,
    porcentaje: b.porcentaje,
    entradasPeriodo: null,
    salidasPeriodo: null,
  };
}

function ContenidoBolsa({ bolsa, onRefrescar, onCrearBolsa }: {
  bolsa: BolsaDetalleDto;
  onRefrescar: () => void;
  onCrearBolsa: (() => void) | null;
}) {
  const { user, hasFuncion } = useAuth();
  const companiaId = bolsa.companiaId!;
  const [periodo, setPeriodo] = useState(periodoActual);
  /** Traer el libro entero en vez de solo el periodo. Solo afecta a la tabla de movimientos. */
  const [verTodo, setVerTodo] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [extracto, setExtracto] = useState<ExtractoCliente | null>(null);
  const [movimientos, setMovimientos] = useState<MovimientoBolsaDto[] | null>(null);
  const [cierres, setCierres] = useState<CierreDto[]>([]);
  const [errorLibro, setErrorLibro] = useState(false);
  const [editando, setEditando] = useState(false);
  const [cambioEstado, setCambioEstado] = useState(false);
  const tituloRef = useRef<HTMLHeadingElement>(null);
  const idPeriodo = useId();

  useEffect(() => {
    let vigente = true;
    setErrorLibro(false);
    setMovimientos(null);
    const q = verTodo ? '' : `?periodo=${periodo}`;
    Promise.all([
      api.get<ExtractoCliente>(`/flito/bolsas/${companiaId}/extracto?periodo=${periodo}`),
      api.get<MovimientoBolsaDto[]>(`/flito/bolsas/${companiaId}/movimientos${q}`),
      api.get<CierreDto[]>(`/flito/bolsas/${companiaId}/cierres`),
    ])
      .then(([e, m, c]) => {
        if (!vigente) return;
        setExtracto(e);
        setMovimientos(Array.isArray(m) ? m : []);
        setCierres(Array.isArray(c) ? c : []);
      })
      .catch(() => { if (vigente) setErrorLibro(true); });
    return () => { vigente = false; };
  }, [companiaId, periodo, verTodo, nonce, bolsa]);

  /** Refresca la bolsa (estado, saldo) y el listado; el libro se relee al llegar la bolsa nueva. */
  const refrescarTodo = onRefrescar;

  const puedeEditar = hasFuncion('bolsas.bolsa.editar');
  const puedeEstado = hasFuncion('bolsas.bolsa.inactivar');

  // El cierre y la corrección se razonan SOBRE EL PERIODO, aunque la tabla enseñe el libro entero.
  const delPeriodo = (movimientos ?? []).filter((m) => m.periodo === periodo);
  const periodoCerrado = cierres.some((c) => c.periodo === periodo);

  const autogestionados = bolsa.conceptosAutogestionados ?? [];
  const marcadosAuto = bolsa.conceptos.filter((c) => autogestionados.includes(c as ConceptoBolsa)) as ConceptoBolsa[];
  const aviso = avisoAutogestion(marcadosAuto);

  return (
    <>
      <FlitCard>
        <h3 ref={tituloRef} tabIndex={-1} className="flit-focus sr-only">Bolsa</h3>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip tone={bolsa.activa ? 'success' : 'draft'}>{bolsa.activa ? 'Activa' : 'Inactiva'}</StatusChip>
            <StatusChip tone={TONO_NIVEL[bolsa.nivel]}>{NIVEL_RIESGO_BOLSA_LABEL[bolsa.nivel]}</StatusChip>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {bolsa.activa && puedeEditar && (
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setEditando(true)}>
                Editar conceptos
              </button>
            )}
            {bolsa.activa && puedeEstado && (
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setCambioEstado(true)}>
                Inactivar
              </button>
            )}
            {!bolsa.activa && puedeEstado && (
              <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={() => setCambioEstado(true)}>
                Reactivar bolsa
              </button>
            )}
          </div>
        </div>

        <p className="mt-3 text-2xl font-bold tabular-nums leading-none"
          style={{ color: bolsa.saldo < 0 ? 'var(--flit-danger-ink)' : 'var(--flit-text-primary)' }}>
          {bolsa.saldo < 0 ? `− ${pesos(Math.abs(bolsa.saldo))}` : pesos(bolsa.saldo)}
        </p>
        <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          {bolsa.porcentaje === null || bolsa.ultimaEntradaValor === null
            ? 'Sin entradas previas: no hay base para calcular el nivel.'
            : `${bolsa.porcentaje} % de la última entrada (${pesos(bolsa.ultimaEntradaValor)} el ${fechaDia(bolsa.ultimaEntradaEn)}).`}
        </p>

        {!bolsa.activa && (
          <div role="status" data-testid="aviso-inactiva"
            className="mt-3 rounded-lg border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-app)', color: 'var(--flit-text-secondary)' }}>
            <p>
              Inactiva desde el {fechaHora(bolsa.inactivadaEn)}
              {bolsa.inactivadaPorNombre ? ` por ${bolsa.inactivadaPorNombre}` : ''}.
            </p>
            {bolsa.motivoInactivacion && <p>Motivo: «{bolsa.motivoInactivacion}».</p>}
            <p>No recibe descuentos, recargas ni movimientos manuales.</p>
            <p className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
              {puedeEstado
                ? 'Reactiva la bolsa primero.'
                : 'Para recargarla, alguien con permiso tiene que reactivarla primero.'}
            </p>
          </div>
        )}

        <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          <span className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Descuenta:</span>
          {bolsa.conceptos.length === 0 ? '—' : bolsa.conceptos.map((c, i) => (
            <span key={c} className="inline-flex items-center gap-1">
              {CONCEPTO_BOLSA_LABEL[c as ConceptoBolsa] ?? c}
              {autogestionados.includes(c as ConceptoBolsa) && <StatusChip tone="neutral">Autogestionado</StatusChip>}
              {i < bolsa.conceptos.length - 1 && <span aria-hidden="true" style={{ color: 'var(--flit-text-muted)' }}>·</span>}
            </span>
          ))}
        </p>

        {aviso && <div className="mt-3"><AvisoAutogestion texto={aviso} verClientes={hasPage(user, 'clients')} /></div>}
      </FlitCard>

      <div className="flex flex-wrap items-end gap-4">
        <div className="w-full sm:w-56">
          <label htmlFor={idPeriodo} className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            Periodo contable
          </label>
          <select id={idPeriodo} className={flitInp} value={periodo} aria-describedby={`${idPeriodo}-ayuda`}
            onChange={(e) => setPeriodo(e.target.value)}>
            {ultimosPeriodos(PERIODOS_OFRECIDOS).map((p) => <option key={p} value={p}>{etiquetaPeriodo(p)}</option>)}
          </select>
        </div>
        <label className="flex min-h-10 items-center gap-2 text-sm">
          <input type="checkbox" className="flit-focus" checked={verTodo} onChange={(e) => setVerTodo(e.target.checked)} />
          <span>Ver el libro completo (todos los periodos)</span>
        </label>
        <p id={`${idPeriodo}-ayuda`} className="w-full text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
          El desglose y el cierre son del periodo elegido. El saldo es siempre el acumulado.
        </p>
      </div>

      {errorLibro ? (
        <FlitCard>
          <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
            No pudimos cargar los movimientos de la bolsa. Intenta de nuevo.
          </p>
          <button type="button" className={`${flitBtnSecondary} mt-3`} style={flitBtnSecondaryStyle}
            onClick={() => setNonce((n) => n + 1)}>
            Reintentar
          </button>
        </FlitCard>
      ) : (
        <>
          <BolsaExtracto bolsa={comoBolsaConRiesgo(bolsa)} extracto={extracto} movimientos={delPeriodo} periodo={periodo} />

          <BolsaAcciones
            companiaId={companiaId}
            companiaNombre={bolsa.nombre}
            periodo={periodo}
            periodoCerrado={periodoCerrado}
            cierres={cierres}
            movimientos={delPeriodo}
            saldoActual={bolsa.saldo}
            activa={bolsa.activa}
            onCrearBolsa={onCrearBolsa ?? undefined}
            onHecho={refrescarTodo}
          />

          <BolsaMovimientos
            companiaNombre={bolsa.nombre}
            periodo={periodo}
            todosLosPeriodos={verTodo}
            movimientos={movimientos}
            error={null}
            onReintentar={() => setNonce((n) => n + 1)}
            onPedirLibroCompleto={() => setVerTodo(true)}
          />
        </>
      )}

      {/* #13407: <ExpedienteDocumental companiaId={bolsa.companiaId} /> */}

      {editando && (
        <BolsaForm bolsa={bolsa} onClose={() => setEditando(false)}
          onGuardada={() => { setEditando(false); onRefrescar(); }}
          onVerBolsa={() => setEditando(false)} onContinuarTransito={() => setEditando(false)} />
      )}

      {cambioEstado && (
        <ModalEstadoBolsa bolsa={bolsa} restoreFocusRef={tituloRef}
          onClose={() => setCambioEstado(false)}
          onHecho={() => { setCambioEstado(false); onRefrescar(); }} />
      )}
    </>
  );
}

// ─────────────────────────── Inactivar / Reactivar ───────────────────────────

function ModalEstadoBolsa({ bolsa, restoreFocusRef, onClose, onHecho }: {
  bolsa: BolsaDetalleDto;
  restoreFocusRef: React.RefObject<HTMLHeadingElement | null>;
  onClose: () => void;
  onHecho: () => void;
}) {
  const inactivar = bolsa.activa;
  const idMotivo = useId();
  const idAyuda = useId();
  const [motivo, setMotivo] = useState('');
  const [salio, setSalio] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const largo = motivo.trim().length;
  const corto = largo < MOTIVO_MINIMO;
  const verbo = inactivar ? 'inactivar' : 'reactivar';

  async function confirmar() {
    if (corto || enviando) return;
    setEnviando(true);
    setError(null);
    try {
      if (inactivar) await bolsasApi.inactivar(bolsa.id, motivo.trim());
      else await bolsasApi.reactivar(bolsa.id, motivo.trim());
      toast.success(inactivar ? 'Bolsa inactivada.' : 'Bolsa reactivada.');
      onHecho();
    } catch (e) {
      const { codigo } = errorBolsa(e);
      if (codigo === CodigoErrorBolsa.YA_INACTIVA || codigo === CodigoErrorBolsa.YA_ACTIVA) {
        toast(`La bolsa ya estaba ${codigo === CodigoErrorBolsa.YA_INACTIVA ? 'inactiva' : 'activa'}; actualizamos la vista.`);
        onHecho();
        return;
      }
      setError(`No pudimos ${verbo} la bolsa. Intenta de nuevo.`);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <FlitModal title={`${inactivar ? 'Inactivar' : 'Reactivar'} la bolsa de ${bolsa.nombre}`} onClose={onClose}
      restoreFocusRef={restoreFocusRef} cierreBloqueado={enviando}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void confirmar(); }}>
        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          {inactivar
            ? 'Mientras esté inactiva no recibe descuentos, recargas ni movimientos manuales. Lo ya asentado no cambia y puedes reactivarla cuando quieras.'
            : 'Vuelve a recibir descuentos, recargas y movimientos manuales desde ahora. Lo que se aplicó mientras estuvo inactiva no se descuenta.'}
        </p>
        <div>
          <label htmlFor={idMotivo} className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            Motivo *
          </label>
          <textarea id={idMotivo} rows={3} maxLength={1000} className={`${flitInp} h-auto py-2`} value={motivo}
            aria-describedby={idAyuda} onChange={(e) => setMotivo(e.target.value)} onBlur={() => setSalio(true)} />
          <div id={idAyuda} className="mt-1 flex flex-wrap justify-between gap-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            <span>Mínimo {MOTIVO_MINIMO} caracteres.</span>
            <span aria-live="polite">({Math.min(largo, MOTIVO_MINIMO)}/{MOTIVO_MINIMO})</span>
          </div>
          {salio && corto && largo > 0 && (
            <p className="mt-1 text-xs" style={{ color: 'var(--flit-danger-ink)' }}>
              Escribe un motivo de al menos {MOTIVO_MINIMO} caracteres.
            </p>
          )}
        </div>
        {error && <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose} disabled={enviando}>
            Cancelar
          </button>
          <button type="submit" className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={corto || enviando}
            aria-describedby={idAyuda}>
            {enviando
              ? (inactivar ? 'Inactivando…' : 'Reactivando…')
              : (inactivar ? 'Inactivar bolsa' : 'Reactivar bolsa')}
          </button>
        </div>
      </form>
    </FlitModal>
  );
}
