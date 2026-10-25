// Detalle de una bolsa de tránsito (HU #11161; recompuesto en la HU #13908 sobre el catálogo único,
// spec `docs/ux/flito-bolsas-transito-13908-slim.md`).
//
// Misma familia que `BolsaDetalleCompania`: tarjeta Bolsa con estado y nivel, una primaria por estado
// (activa → «Cargar saldo»; inactiva → «Reactivar bolsa»), cobertura, libro de movimientos y cierres.
// Todo dentro de `RegionDesplazable` (AC8): la cabecera del modal (título y ✕) queda fuera de la
// región y siempre se ve.
//
// Lo que NO hace: recalcular el nivel ni la deuda. Llegan del servidor (`transito`) en su escala, que
// no es la de compañía: tiene «En préstamo».

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  CodigoErrorBolsa, NIVEL_BOLSA_TRANSITO_LABEL,
  type BolsaDetalleDto, type ParCoberturaOcupada,
} from '@operaciones/shared-types';
import { bolsasApi } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  avisoAutogestionTransito, cobroTransito, errorBolsa, fechaHora, hoyColombia, MOTIVO_MINIMO, nombreSecretaria,
  paresOcupados, pesos, saldoConSigno, TONO_NIVEL_TRANSITO,
} from '../../lib/bolsas';
import Campo from './BolsaCampo';
import { RegionDesplazable } from './BolsaDetalleCompania';
import BolsaForm, { AvisoAutogestionTransito } from './BolsaForm';
import { CierresTransito, MovimientosTransito } from './BolsaTransitoLibro';
import FlitModal from '../flit/FlitModal';
import { toastOk } from '../flit/ToastFlito';
import FlitUploadBox from '../flit/FlitUploadBox';
import StatusChip from '../flit/StatusChip';
import {
  FlitCard, flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../flit/flitPageKit';

const ENLACE = 'flit-focus rounded-sm font-semibold underline transition-colors hover:text-[color:var(--flit-blue-ink)]';

type Carga = { tipo: 'cargando' } | { tipo: 'error' } | { tipo: 'no-existe' } | { tipo: 'lista'; bolsa: BolsaDetalleDto };

interface Props {
  bolsaId: string;
  /** Nombre que ya se conoce (fila del listado), para la cabecera mientras carga. */
  nombre: string;
  onClose: () => void;
  /** Saldo, estado o cobertura cambiaron: el listado se relee. */
  onCambio: () => void;
  /** «Ver «{bolsa}»» del conflicto al reactivar: cambia el detalle a esa bolsa. */
  onVerBolsa: (bolsa: { id: string; nombre: string }) => void;
}

/** El padre lo monta con `key={bolsaId}`: cambiar de bolsa es empezar de cero (estado y avisos). */
export default function BolsaDetalleTransito({ bolsaId, nombre, onClose, onCambio, onVerBolsa }: Props) {
  const [carga, setCarga] = useState<Carga>({ tipo: 'cargando' });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let vigente = true;
    bolsasApi.detalle(bolsaId)
      .then((b) => { if (vigente) setCarga({ tipo: 'lista', bolsa: b }); })
      .catch((e) => { if (vigente) setCarga(errorBolsa(e).status === 404 ? { tipo: 'no-existe' } : { tipo: 'error' }); });
    return () => { vigente = false; };
  }, [bolsaId, nonce]);

  const refrescar = useCallback(() => { setNonce((n) => n + 1); onCambio(); }, [onCambio]);
  const titulo = carga.tipo === 'lista' ? carga.bolsa.nombre : nombre;

  return (
    <FlitModal title={titulo} onClose={onClose} full>
      <RegionDesplazable etiqueta={`Detalle de la bolsa ${titulo} (tránsito)`}>
        {carga.tipo === 'cargando' && <Esqueleto />}

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

        {carga.tipo === 'lista' && (
          <Contenido bolsa={carga.bolsa} onRefrescar={refrescar} onVerBolsa={onVerBolsa} />
        )}
      </RegionDesplazable>
    </FlitModal>
  );
}

function Esqueleto() {
  const barra = (w: string, h = 'h-3') => <div className={`${h} rounded`} style={{ width: w, background: 'var(--flit-bg-app)' }} />;
  return (
    <div role="status" aria-label="Cargando la bolsa" className="space-y-4">
      <FlitCard><div className="space-y-3">{barra('30%')}{barra('45%', 'h-7')}{barra('60%')}</div></FlitCard>
      <FlitCard><div className="space-y-3">{barra('80%')}{barra('70%')}{barra('75%')}</div></FlitCard>
    </div>
  );
}

// ─────────────────────────────── Contenido ───────────────────────────────────

function Contenido({ bolsa, onRefrescar, onVerBolsa }: {
  bolsa: BolsaDetalleDto;
  onRefrescar: () => void;
  onVerBolsa: (b: { id: string; nombre: string }) => void;
}) {
  const { hasFuncion } = useAuth();
  const puedeCargar = hasFuncion('bolsas.transito.cargar');
  const puedeEditar = hasFuncion('bolsas.transito.editar');
  const puedeEstado = hasFuncion('bolsas.transito.inactivar');
  const verMovimientos = hasFuncion('bolsas.transito.ver_movimientos');
  const verCierres = hasFuncion('bolsas.transito.cierres.ver');
  const puedeCerrar = hasFuncion('bolsas.transito.cierre.crear');

  const [libroNonce, setLibroNonce] = useState(0);
  const [editando, setEditando] = useState(false);
  const [cambioEstado, setCambioEstado] = useState(false);
  const [cargandoSaldo, setCargandoSaldo] = useState(false);
  const [verCobertura, setVerCobertura] = useState(false);
  /** 409 `cobertura_ocupada` al reactivar: aviso de página hasta el siguiente intento o el cierre. */
  const [conflicto, setConflicto] = useState<ParCoberturaOcupada[] | null>(null);
  const tituloRef = useRef<HTMLHeadingElement>(null);
  const idAvisoInactiva = useId();

  const t = bolsa.transito;
  const nivel = t?.nivel ?? 'sin_cargas';
  const secretarias = [...new Set(bolsa.cobertura.map((c) => c.organismoCodigo))];
  const cobros = [...new Set(bolsa.cobertura.map((c) => c.concepto))];
  const avisoAuto = avisoAutogestionTransito((bolsa.paresAutogestionados ?? []).map((p) => nombreSecretaria(p.organismoCodigo)));
  const bolsasEnConflicto = conflicto ? [...new Map(conflicto.map((p) => [p.bolsaId, p.bolsaNombre])).entries()] : [];

  return (
    <>
      <FlitCard>
        <h3 ref={tituloRef} tabIndex={-1} className="flit-focus sr-only">Bolsa</h3>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip tone={bolsa.activa ? 'success' : 'draft'}>{bolsa.activa ? 'Activa' : 'Inactiva'}</StatusChip>
            <StatusChip tone={TONO_NIVEL_TRANSITO[nivel]}>{NIVEL_BOLSA_TRANSITO_LABEL[nivel]}</StatusChip>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {bolsa.activa && puedeCargar && (
              <button type="button" className={`${flitBtnPrimary} order-first lg:order-last`} style={flitBtnPrimaryStyle}
                onClick={() => setCargandoSaldo(true)}>
                Cargar saldo
              </button>
            )}
            {!bolsa.activa && puedeEstado && (
              <button type="button" className={`${flitBtnPrimary} order-first lg:order-last`} style={flitBtnPrimaryStyle}
                onClick={() => { setConflicto(null); setCambioEstado(true); }}>
                Reactivar bolsa
              </button>
            )}
            {/* Decisión del hilo (AC4): con la bolsa inactiva «Cargar saldo» se ve DESHABILITADO, con el
                aviso como explicación, y nunca con peso de primaria junto a «Reactivar bolsa». */}
            {!bolsa.activa && puedeCargar && (
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled
                aria-describedby={idAvisoInactiva}>
                Cargar saldo
              </button>
            )}
            {bolsa.activa && puedeEditar && (
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setEditando(true)}>
                Editar cobertura
              </button>
            )}
            {bolsa.activa && puedeEstado && (
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setCambioEstado(true)}>
                Inactivar
              </button>
            )}
          </div>
        </div>

        <p className="mt-3 text-2xl font-bold tabular-nums leading-none" data-testid="saldo-transito"
          style={{ color: bolsa.saldo < 0 ? 'var(--flit-danger-ink)' : 'var(--flit-text-primary)' }}>
          {saldoConSigno(bolsa.saldo)}
        </p>
        {t && t.deuda > 0 && (
          <p className="mt-1 text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
            Se debe {pesos(t.deuda)} a quien opera la bolsa. La próxima carga lo neta.
          </p>
        )}
        {t && (
          <p className="mt-1 text-xs tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>
            Cargado {pesos(t.totalCargado)} · Consumido {pesos(t.totalConsumido)}
          </p>
        )}

        <div className="mt-3 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Cobertura:</span>
            {bolsa.cobertura.length === 0 ? (
              <span>Sin cobertura definida.</span>
            ) : (
              <>
                <span>
                  {cobros.map(cobroTransito).join(', ')} en {secretarias.length} secretaría{secretarias.length === 1 ? '' : 's'}
                </span>
                <button type="button" className={ENLACE} style={{ color: 'var(--flit-blue-text)' }}
                  aria-expanded={verCobertura} onClick={() => setVerCobertura((v) => !v)}>
                  {verCobertura ? 'Ocultar' : 'Ver'}
                </button>
              </>
            )}
          </p>
          {verCobertura && (
            <ul className="mt-1 list-disc pl-5 text-xs" data-testid="lista-cobertura">
              {secretarias.map((codigo) => (
                <li key={codigo}>
                  {nombreSecretaria(codigo)} · {bolsa.cobertura.filter((c) => c.organismoCodigo === codigo).map((c) => cobroTransito(c.concepto)).join(', ')}
                </li>
              ))}
            </ul>
          )}
        </div>

        {!bolsa.activa && (
          <div role="status" id={idAvisoInactiva} data-testid="aviso-inactiva"
            className="mt-3 rounded-lg border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-app)', color: 'var(--flit-text-secondary)' }}>
            <p>
              Inactiva desde el {fechaHora(bolsa.inactivadaEn)}
              {bolsa.inactivadaPorNombre ? ` por ${bolsa.inactivadaPorNombre}` : ''}.
            </p>
            {bolsa.motivoInactivacion && <p>Motivo: «{bolsa.motivoInactivacion}».</p>}
            <p>No recibe descuentos ni cargas de saldo.</p>
            <p className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
              {puedeEstado ? 'Reactiva la bolsa primero.' : 'Para cargarla, alguien con permiso tiene que reactivarla primero.'}
            </p>
          </div>
        )}

        {conflicto && conflicto.length > 0 && (
          <div role="alert" data-testid="aviso-reactivar-conflicto"
            className="mt-3 rounded-lg border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-app)', color: 'var(--flit-danger-ink)' }}>
            <p>No pudimos reactivarla: otra bolsa activa ya cubre estas secretarías para el mismo cobro.</p>
            <ul className="mt-1 list-disc pl-5">
              {conflicto.map((p) => (
                <li key={`${p.organismoCodigo}-${p.concepto}-${p.bolsaId}`}>
                  {nombreSecretaria(p.organismoCodigo)} · {cobroTransito(p.concepto)} — en «{p.bolsaNombre}»
                </li>
              ))}
            </ul>
            <div className="mt-2 flex flex-wrap gap-3">
              {bolsasEnConflicto.map(([id, nom]) => (
                <button key={id} type="button" className={ENLACE} style={{ color: 'var(--flit-blue-text)' }}
                  onClick={() => onVerBolsa({ id, nombre: nom })}>
                  Ver «{nom}»
                </button>
              ))}
            </div>
          </div>
        )}

        {avisoAuto && <div className="mt-3"><AvisoAutogestionTransito texto={avisoAuto} /></div>}
      </FlitCard>

      {verMovimientos && (
        <MovimientosTransito bolsaId={bolsa.id} nonce={libroNonce} siguientePaso={bolsa.activa && puedeCargar} />
      )}

      {verCierres && (
        <CierresTransito bolsaId={bolsa.id} nombre={bolsa.nombre} nonce={libroNonce} puedeCerrar={puedeCerrar} />
      )}

      {editando && (
        <BolsaForm bolsa={bolsa} onClose={() => setEditando(false)}
          onGuardada={() => { setEditando(false); onRefrescar(); }}
          onVerBolsa={() => setEditando(false)} />
      )}

      {cambioEstado && (
        <ModalEstado bolsa={bolsa} restoreFocusRef={tituloRef}
          onClose={() => setCambioEstado(false)}
          onConflicto={(pares) => { setCambioEstado(false); setConflicto(pares); }}
          onHecho={() => { setCambioEstado(false); setConflicto(null); onRefrescar(); }} />
      )}

      {cargandoSaldo && (
        <ModalCarga bolsa={bolsa}
          onClose={() => setCargandoSaldo(false)}
          onInactiva={onRefrescar}
          onHecho={() => { setCargandoSaldo(false); setLibroNonce((n) => n + 1); onRefrescar(); }} />
      )}
    </>
  );
}

// ─────────────────────────── Inactivar / Reactivar ───────────────────────────

function ModalEstado({ bolsa, restoreFocusRef, onClose, onHecho, onConflicto }: {
  bolsa: BolsaDetalleDto;
  restoreFocusRef: React.RefObject<HTMLHeadingElement | null>;
  onClose: () => void;
  onHecho: () => void;
  onConflicto: (pares: ParCoberturaOcupada[]) => void;
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

  async function confirmar() {
    if (corto || enviando) return;
    setEnviando(true);
    setError(null);
    try {
      if (inactivar) await bolsasApi.inactivar(bolsa.id, motivo.trim());
      else await bolsasApi.reactivar(bolsa.id, motivo.trim());
      toastOk(inactivar ? 'Bolsa inactivada.' : 'Bolsa reactivada.');
      onHecho();
    } catch (e) {
      const { codigo, datos } = errorBolsa(e);
      if (codigo === CodigoErrorBolsa.YA_INACTIVA || codigo === CodigoErrorBolsa.YA_ACTIVA) {
        toastOk(`La bolsa ya estaba ${codigo === CodigoErrorBolsa.YA_INACTIVA ? 'inactiva' : 'activa'}; actualizamos la vista.`);
        onHecho();
        return;
      }
      if (!inactivar && codigo === CodigoErrorBolsa.COBERTURA_OCUPADA) {
        onConflicto(paresOcupados(datos));
        return;
      }
      setError(`No pudimos ${inactivar ? 'inactivar' : 'reactivar'} la bolsa. Intenta de nuevo.`);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <FlitModal title={`${inactivar ? 'Inactivar' : 'Reactivar'} la bolsa ${bolsa.nombre}`} onClose={onClose}
      restoreFocusRef={restoreFocusRef} cierreBloqueado={enviando}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void confirmar(); }}>
        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          {inactivar
            ? 'Mientras esté inactiva no recibe descuentos ni cargas de saldo, y sus secretarías quedan libres para otra bolsa. Lo ya asentado no cambia.'
            : 'Vuelve a recibir descuentos y cargas de saldo desde ahora, siempre que ninguna otra bolsa activa cubra ya sus secretarías para el mismo cobro.'}
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

// ─────────────────────────────── Cargar saldo ────────────────────────────────

function ModalCarga({ bolsa, onClose, onHecho, onInactiva }: {
  bolsa: BolsaDetalleDto;
  onClose: () => void;
  onHecho: () => void;
  /** 409 `bolsa_inactiva`: el detalle se relee por debajo; el modal sigue abierto con el aviso. */
  onInactiva: () => void;
}) {
  const [valor, setValor] = useState('');
  const [fecha, setFecha] = useState(hoyColombia);
  const [observacion, setObservacion] = useState('');
  const [archivo, setArchivo] = useState<File | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valorNum = Number(valor);
  const valorInvalido = valor.trim() === '' || !Number.isFinite(valorNum) || valorNum <= 0;
  const puedeGuardar = !valorInvalido && !enviando;

  async function guardar() {
    if (!puedeGuardar) return;
    setEnviando(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('valor', String(valorNum));
      form.append('fecha', fecha);
      if (observacion.trim()) form.append('observacion', observacion.trim());
      // Opcional: la carga se registra el día en que se ordena la transferencia, que suele ser antes
      // de que el banco emita el comprobante.
      if (archivo) form.append('soporte', archivo);
      const r = await bolsasApi.cargarTransito(bolsa.id, form);
      toastOk(typeof r?.saldo === 'number'
        ? `Carga registrada. Saldo de ${bolsa.nombre}: ${saldoConSigno(r.saldo)}.`
        : 'Carga registrada.');
      onHecho();
    } catch (e) {
      const { status, codigo } = errorBolsa(e);
      if (codigo === CodigoErrorBolsa.BOLSA_INACTIVA) {
        setError('Reactiva la bolsa primero.');
        onInactiva();
      } else if (status === 400) {
        setError('Revisa el valor, la fecha y el soporte e intenta de nuevo.');
      } else {
        setError('No pudimos registrar la carga. Intenta de nuevo.');
      }
    } finally {
      setEnviando(false);
    }
  }

  return (
    <FlitModal title={`Cargar saldo a ${bolsa.nombre}`} onClose={onClose} wide cierreBloqueado={enviando}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void guardar(); }}>
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          Es dinero que FLIT transfiere por adelantado a esta bolsa. Si venía en préstamo, esta carga
          descuenta primero la deuda.
        </p>
        <Campo etiqueta="Valor de la carga *"
          error={valor.trim() !== '' && valorInvalido ? 'El valor de la carga debe ser mayor que cero.' : null}>
          <input type="number" min="1" step="1" className={flitInp} value={valor} required
            onChange={(e) => setValor(e.target.value)} />
        </Campo>
        <Campo etiqueta="Fecha">
          <input type="date" className={flitInp} value={fecha} onChange={(e) => setFecha(e.target.value)} />
        </Campo>
        <Campo etiqueta="Observación">
          <input type="text" className={flitInp} value={observacion} maxLength={1000}
            onChange={(e) => setObservacion(e.target.value)} placeholder="Ej. transferencia del 30/07" />
        </Campo>
        <div>
          <FlitUploadBox label={archivo ? archivo.name : 'Soporte de la carga (opcional)'}
            state={archivo ? 'verified' : 'idle'} count={1} onFile={setArchivo} />
          <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            Se puede registrar sin comprobante y adjuntarlo después.
          </p>
        </div>
        {error && <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose} disabled={enviando}>
            Cancelar
          </button>
          <button type="submit" className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={!puedeGuardar}>
            {enviando ? 'Registrando…' : 'Registrar carga'}
          </button>
        </div>
      </form>
    </FlitModal>
  );
}
