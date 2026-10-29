// FLITO Logística — pestaña Viajes (HU #14116, destino HU #14123).
// Una tarjeta por compañía. El modal reparte Cliente | FLIT: dos destinos son dos POST, primero FLIT.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CompaniaCerrableLogistica, LtClasificadaCerrable } from '@operaciones/shared-types';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { hasPage } from '../../../lib/permissions';
import {
  avisoSinPrecio, codigoDe, DESTINO_CLIENTE, DESTINO_FLIT, formatoPrecio, mensajeRegistrarViaje,
  nombreCompania, nuevaKey, textoPrecioDestino, type DestinoViaje,
} from '../../../lib/viajesCliente';
import { toastOk } from '../../flit/ToastFlito';
import FlitModal from '../../flit/FlitModal';
import {
  FlitCard, FlitEmpty, FlitField, FlitPillButton, FlitPillGroup, flitBtnPrimary, flitBtnPrimaryStyle,
  flitBtnSecondary, flitBtnSecondaryStyle, flitInp,
} from '../../flit/flitPageKit';

type Carga = 'cargando' | 'ok' | 'error' | 'error403';
interface MotivoLlegada { id: string; nombre: string }

interface Props {
  grupos: CompaniaCerrableLogistica[];
  estado: Carga;
  onReintentar: () => void;
  onRegistrado: () => void;
  /** Cambia a la pestaña del catálogo. Solo si hay `logistica.motivos.gestionar`. */
  onIrMotivos?: () => void;
}

export default function ViajesACliente({ grupos, estado, onReintentar, onRegistrado, onIrMotivos }: Props) {
  const [confirmar, setConfirmar] = useState<CompaniaCerrableLogistica | null>(null);
  const [abiertas, setAbiertas] = useState<Set<number>>(() => new Set());

  const toggleMas = (id: number) => {
    setAbiertas((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  if (estado === 'cargando') {
    return (
      <div role="status" aria-label="Cargando viajes…" className="space-y-3">
        {[0, 1].map((i) => (
          <div key={i} className="rounded-xl border p-4" style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-card)' }}>
            <div className="h-4 w-1/3 rounded" style={{ background: 'var(--flit-border-soft)' }} />
            <div className="mt-3 h-3 w-2/3 rounded" style={{ background: 'var(--flit-border-soft)' }} />
            <div className="mt-2 h-3 w-1/2 rounded" style={{ background: 'var(--flit-border-soft)' }} />
            <div className="mt-4 h-10 w-full rounded-full lg:w-40" style={{ background: 'var(--flit-border-soft)' }} />
          </div>
        ))}
      </div>
    );
  }

  if (estado === 'error' || estado === 'error403') {
    return (
      <FlitCard>
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
          <p className="flex-1">{estado === 'error403' ? 'No tiene permiso para registrar viajes.' : 'No se pudieron cargar las LT listas para viaje.'}</p>
          {estado === 'error' && (
            <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onReintentar}>Reintentar</button>
          )}
        </div>
      </FlitCard>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>Viajes</h2>
        <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          Elija el destino de cada compañía y revise el precio antes de registrar.
        </p>
      </div>

      {grupos.length === 0 ? (
        <FlitEmpty>
          No hay LT clasificadas listas para un viaje. Primero deben recogerse y clasificarse en el organismo.
        </FlitEmpty>
      ) : (
        <ul className="space-y-3">
          {grupos.map((g) => (
            <li key={g.companiaId}>
              <TarjetaGrupo
                grupo={g}
                expandida={abiertas.has(g.companiaId)}
                onToggle={() => toggleMas(g.companiaId)}
                onRegistrar={() => setConfirmar(g)}
              />
            </li>
          ))}
        </ul>
      )}

      {confirmar && (
        <ModalConfirmarViaje
          grupo={confirmar}
          onIrMotivos={onIrMotivos}
          onClose={() => setConfirmar(null)}
          onRegistrado={() => { setConfirmar(null); onRegistrado(); }}
        />
      )}
    </div>
  );
}

function TarjetaGrupo({ grupo, expandida, onToggle, onRegistrar }: {
  grupo: CompaniaCerrableLogistica;
  expandida: boolean;
  onToggle: () => void;
  onRegistrar: () => void;
}) {
  const nombre = nombreCompania(grupo.nombre, grupo.companiaId);
  const precioC = grupo.precioEntregaCliente;
  const precioF = grupo.precioEntregaFlit;
  const alguno = precioC != null || precioF != null;
  const visibles = grupo.lts.slice(0, 3);
  const resto = grupo.lts.slice(3);

  return (
    <article className="rounded-xl border p-4" style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-card)' }}>
      <h3 className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
        {nombre} · {grupo.disponibles} LT
      </h3>
      <p className="mt-1 flex flex-wrap gap-x-1 text-sm">
        <span style={{ color: precioC == null ? 'var(--flit-danger-ink)' : 'var(--flit-text-secondary)' }}>
          {textoPrecioDestino('Cliente', precioC)}
        </span>
        <span style={{ color: 'var(--flit-text-muted)' }} aria-hidden="true">·</span>
        <span style={{ color: precioF == null ? 'var(--flit-danger-ink)' : 'var(--flit-text-secondary)' }}>
          {textoPrecioDestino('FLIT', precioF)}
        </span>
      </p>

      {!alguno && <AvisoSinTarifa companiaId={grupo.companiaId} />}

      <ul className="mt-3 space-y-0.5 text-sm tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>
        {(expandida ? grupo.lts : visibles).map((lt) => (
          <li key={lt.documentoId}>{lineaLt(lt)}</li>
        ))}
      </ul>
      {resto.length > 0 && (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expandida}
          className="flit-focus mt-1 rounded-lg px-2 py-1.5 text-xs font-semibold transition-colors hover:bg-[var(--flit-bg-hover)]"
          style={{ color: 'var(--flit-blue-text)', minHeight: 40 }}
        >
          {expandida ? 'Ver menos' : `+ ${resto.length} más`}
        </button>
      )}

      {alguno && (
        <div className="mt-4 flex lg:justify-end">
          <button type="button" className={`${flitBtnPrimary} w-full justify-center lg:w-auto`} style={flitBtnPrimaryStyle} onClick={onRegistrar}>
            Registrar viaje
          </button>
        </div>
      )}
    </article>
  );
}

function AvisoSinTarifa({ companiaId }: { companiaId: number }) {
  const { user } = useAuth();
  if (hasPage(user, 'flito_tarifas')) {
    return (
      <Link to={`/flito/tarifas/${companiaId}`} className={`${flitBtnSecondary} mt-2 inline-flex`} style={flitBtnSecondaryStyle}>
        Ir a Tarifas
      </Link>
    );
  }
  return (
    <p className="mt-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
      Pídale a Finanzas que fije el precio.
    </p>
  );
}

function lineaLt(lt: LtClasificadaCerrable): string {
  const placa = lt.placa ?? '—';
  return lt.numeroLt ? `${placa} · LT ${lt.numeroLt}` : placa;
}

function fraseCobro(n: number, precio: number): string {
  return `Se cobrará ${formatoPrecio(precio)} por cada LT. Total ${formatoPrecio(precio * n)}.`;
}

function ModalConfirmarViaje({ grupo, onClose, onRegistrado, onIrMotivos }: {
  grupo: CompaniaCerrableLogistica;
  onClose: () => void;
  onRegistrado: () => void;
  onIrMotivos?: () => void;
}) {
  const nombre = nombreCompania(grupo.nombre, grupo.companiaId);
  const defecto: DestinoViaje = grupo.precioEntregaCliente != null ? DESTINO_CLIENTE : DESTINO_FLIT;
  const [asig, setAsig] = useState<Record<string, DestinoViaje>>(() =>
    Object.fromEntries(grupo.lts.map((lt) => [lt.documentoId, defecto])),
  );
  const [motivoId, setMotivoId] = useState('');
  const [nota, setNota] = useState('');
  const [motivos, setMotivos] = useState<MotivoLlegada[]>([]);
  const [motivosEstado, setMotivosEstado] = useState<'idle' | 'cargando' | 'ok' | 'error'>('idle');
  const [motivosTick, setMotivosTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codigo, setCodigo] = useState<string | null>(null);
  const keys = useRef<{ flit: { sig: string; key: string } | null; cliente: { sig: string; key: string } | null }>({ flit: null, cliente: null });
  const flitOk = useRef(false);
  const { user } = useAuth();
  const veTarifas = hasPage(user, 'flito_tarifas');

  const ltsFlit = grupo.lts.filter((lt) => asig[lt.documentoId] === DESTINO_FLIT);
  const ltsCliente = grupo.lts.filter((lt) => asig[lt.documentoId] !== DESTINO_FLIT);
  const hayFlit = ltsFlit.length > 0;
  const hayCliente = ltsCliente.length > 0;
  const todosFlit = hayFlit && !hayCliente;
  const todosCliente = hayCliente && !hayFlit;
  const precioC = grupo.precioEntregaCliente;
  const precioF = grupo.precioEntregaFlit;
  const faltaPrecio = (hayCliente && precioC == null) || (hayFlit && precioF == null);
  const motivosListos = motivosEstado === 'ok' && motivos.length > 0 && motivoId !== '';
  const puede = !busy && !faltaPrecio && (!hayFlit || motivosListos);

  useEffect(() => {
    if (!hayFlit) return;
    let vivo = true;
    setMotivosEstado('cargando');
    api.get<MotivoLlegada[]>('/flito/logistica/motivos-llegada?soloActivos=true')
      .then((rows) => {
        if (!vivo) return;
        setMotivos(Array.isArray(rows) ? rows : []);
        setMotivosEstado('ok');
      })
      .catch(() => { if (vivo) setMotivosEstado('error'); });
    return () => { vivo = false; };
  }, [hayFlit, motivosTick]);

  const ponerTodas = (d: DestinoViaje) => {
    setAsig(Object.fromEntries(grupo.lts.map((lt) => [lt.documentoId, d])));
  };

  const llave = (destino: DestinoViaje, sig: string) => {
    const prev = keys.current[destino];
    if (prev?.sig === sig) return prev.key;
    const key = nuevaKey();
    keys.current[destino] = { sig, key };
    return key;
  };

  const cerrar = () => {
    if (flitOk.current) onRegistrado();
    else onClose();
  };

  const confirmar = async () => {
    if (!puede) return;
    setBusy(true); setError(null); setCodigo(null);
    const notaTrim = nota.trim();
    const idsFlit = ltsFlit.map((lt) => lt.documentoId);
    const idsCliente = ltsCliente.map((lt) => lt.documentoId);
    try {
      if (hayFlit && !flitOk.current) {
        await api.post('/flito/logistica/traslados', {
          companiaId: grupo.companiaId,
          destino: DESTINO_FLIT,
          motivoLlegadaId: motivoId,
          lts: idsFlit.map((documentoId) => ({
            documentoId,
            ...(notaTrim ? { nota: notaTrim } : {}),
          })),
        }, { 'Idempotency-Key': llave(DESTINO_FLIT, `${idsFlit.join(',')}|${motivoId}|${notaTrim}`) });
        flitOk.current = true;
      }
      if (hayCliente) {
        await api.post('/flito/logistica/traslados', {
          companiaId: grupo.companiaId,
          destino: DESTINO_CLIENTE,
          lts: idsCliente.map((documentoId) => ({ documentoId })),
        }, { 'Idempotency-Key': llave(DESTINO_CLIENTE, idsCliente.join(',')) });
      }
      if (hayFlit && hayCliente) {
        toastOk(`Quedaron dos viajes de ${nombre}: ${ltsFlit.length} LT a FLIT y ${ltsCliente.length} al cliente.`);
      } else if (hayFlit) {
        toastOk(`Viaje a FLIT de ${nombre} registrado (${ltsFlit.length} LT).`);
      } else {
        toastOk(`Viaje a cliente de ${nombre} registrado (${ltsCliente.length} LT).`);
      }
      onRegistrado();
    } catch (e) {
      setCodigo(codigoDe(e));
      if (flitOk.current && hayFlit && hayCliente) {
        setError('El viaje a FLIT quedó registrado. El viaje a cliente no. Las LT de cliente siguen aquí.');
      } else {
        const destinoFallo: DestinoViaje = hayFlit && !flitOk.current ? DESTINO_FLIT : DESTINO_CLIENTE;
        setError(mensajeRegistrarViaje(e, nombre, destinoFallo));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <FlitModal title={`Registrar viaje a ${nombre}`} onClose={cerrar} cierreBloqueado={busy}>
      <div className="space-y-3" aria-busy={busy || undefined}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Destino del viaje</span>
          <div role="group" aria-label="Destino del viaje">
            <FlitPillGroup>
              <FlitPillButton active={todosCliente} pressed={todosCliente} onClick={() => ponerTodas(DESTINO_CLIENTE)}>Cliente</FlitPillButton>
              <FlitPillButton active={todosFlit} pressed={todosFlit} onClick={() => ponerTodas(DESTINO_FLIT)}>FLIT</FlitPillButton>
            </FlitPillGroup>
          </div>
        </div>

        <PreciosModal
          nombre={nombre}
          hayFlit={hayFlit}
          hayCliente={hayCliente}
          nFlit={ltsFlit.length}
          nCliente={ltsCliente.length}
          precioC={precioC}
          precioF={precioF}
        />
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          Este precio queda congelado en el viaje. Si Finanzas lo cambia después, este viaje no se mueve.
        </p>

        {faltaPrecio && (
          <div className="space-y-2 text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
            {hayFlit && precioF == null && <p>{avisoSinPrecio(nombre, DESTINO_FLIT)}</p>}
            {hayCliente && precioC == null && <p>{avisoSinPrecio(nombre, DESTINO_CLIENTE)}</p>}
            {veTarifas && (
              <Link to={`/flito/tarifas/${grupo.companiaId}`} className={`${flitBtnSecondary} inline-flex`} style={flitBtnSecondaryStyle}>
                Ir a Tarifas
              </Link>
            )}
          </div>
        )}

        {hayFlit && (
          <BloqueMotivo
            motivos={motivos}
            estado={motivosEstado}
            motivoId={motivoId}
            nota={nota}
            busy={busy}
            onMotivo={setMotivoId}
            onNota={setNota}
            onReintentar={() => setMotivosTick((n) => n + 1)}
            onIrMotivos={onIrMotivos ? () => { onIrMotivos(); onClose(); } : undefined}
          />
        )}

        <ul className="max-h-60 space-y-2 overflow-y-auto">
          {grupo.lts.map((lt) => {
            const placa = lt.placa ?? lt.documentoId;
            const d = asig[lt.documentoId] ?? defecto;
            return (
              <li key={lt.documentoId} className="flex flex-col gap-1 lg:flex-row lg:items-center lg:justify-between">
                <span className="text-sm tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>{lineaLt(lt)}</span>
                <div role="group" aria-label={`Destino de ${placa}`}>
                  <FlitPillGroup>
                    <FlitPillButton active={d === DESTINO_CLIENTE} pressed={d === DESTINO_CLIENTE} onClick={() => setAsig((prev) => ({ ...prev, [lt.documentoId]: DESTINO_CLIENTE }))}>Cliente</FlitPillButton>
                    <FlitPillButton active={d === DESTINO_FLIT} pressed={d === DESTINO_FLIT} onClick={() => setAsig((prev) => ({ ...prev, [lt.documentoId]: DESTINO_FLIT }))}>FLIT</FlitPillButton>
                  </FlitPillGroup>
                </div>
              </li>
            );
          })}
        </ul>

        {error && (
          <div role="alert" className="space-y-2 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--flit-border-soft)', color: 'var(--flit-danger-ink)', background: 'var(--flit-bg-card)' }}>
            <p>{error}</p>
            {codigo === 'PRECIO_TRASLADO_NO_CONFIGURADO' && veTarifas && (
              <Link to={`/flito/tarifas/${grupo.companiaId}`} className={`${flitBtnSecondary} inline-flex`} style={flitBtnSecondaryStyle}>
                Ir a Tarifas
              </Link>
            )}
          </div>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button type="button" className={`${flitBtnSecondary} w-full justify-center sm:w-auto`} style={flitBtnSecondaryStyle} onClick={cerrar} disabled={busy}>Cancelar</button>
          <button type="button" className={`${flitBtnPrimary} w-full justify-center sm:w-auto`} style={flitBtnPrimaryStyle} disabled={!puede} onClick={() => void confirmar()}>
            {busy ? 'Registrando…' : 'Confirmar viaje'}
          </button>
        </div>
      </div>
    </FlitModal>
  );
}

function PreciosModal({ nombre, hayFlit, hayCliente, nFlit, nCliente, precioC, precioF }: {
  nombre: string;
  hayFlit: boolean;
  hayCliente: boolean;
  nFlit: number;
  nCliente: number;
  precioC: number | null;
  precioF: number | null;
}) {
  if (hayFlit && hayCliente) {
    return (
      <div className="space-y-1 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
        <p>Se registrarán dos viajes de {nombre}.</p>
        {precioF != null && <p>A FLIT: {nFlit} LT · {formatoPrecio(precioF)} por LT · Total {formatoPrecio(precioF * nFlit)}.</p>}
        {precioC != null && <p>A cliente: {nCliente} LT · {formatoPrecio(precioC)} por LT · Total {formatoPrecio(precioC * nCliente)}.</p>}
      </div>
    );
  }
  if (hayFlit && precioF != null) {
    return <p className="text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>{fraseCobro(nFlit, precioF)}</p>;
  }
  if (hayCliente && precioC != null) {
    return <p className="text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>{fraseCobro(nCliente, precioC)}</p>;
  }
  return null;
}

function BloqueMotivo({ motivos, estado, motivoId, nota, busy, onMotivo, onNota, onReintentar, onIrMotivos }: {
  motivos: MotivoLlegada[];
  estado: 'idle' | 'cargando' | 'ok' | 'error';
  motivoId: string;
  nota: string;
  busy: boolean;
  onMotivo: (id: string) => void;
  onNota: (v: string) => void;
  onReintentar: () => void;
  onIrMotivos?: () => void;
}) {
  const cargando = estado === 'cargando' || estado === 'idle';
  const vacio = estado === 'ok' && motivos.length === 0;
  const falta = estado === 'ok' && motivos.length > 0 && motivoId === '';
  return (
    <div className="space-y-3">
      {!vacio && (
        <FlitField label="Motivo de llegada *">
          <select
            className={`${flitInp} h-10 py-0 hover:bg-[var(--flit-bg-hover)]`}
            value={motivoId}
            disabled={cargando || estado === 'error' || busy}
            onChange={(e) => onMotivo(e.target.value)}
          >
            <option value="">{cargando ? 'Cargando motivos…' : 'Elija el motivo'}</option>
            {motivos.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
          </select>
        </FlitField>
      )}
      {falta && <p className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>Elija el motivo de llegada.</p>}
      {estado === 'error' && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
          <p className="flex-1">No se pudieron cargar los motivos de llegada.</p>
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onReintentar}>Reintentar</button>
        </div>
      )}
      {vacio && (
        <div className="space-y-2">
          <p className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
            No hay motivos de llegada activos. Pídale a quien administra el catálogo que active uno.
          </p>
          {onIrMotivos && (
            <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onIrMotivos}>
              Ir a Motivos de llegada
            </button>
          )}
        </div>
      )}
      <FlitField label="Nota (opcional)">
        <textarea
          className={`${flitInp} hover:bg-[var(--flit-bg-hover)]`}
          rows={2}
          maxLength={300}
          value={nota}
          disabled={busy}
          onChange={(e) => onNota(e.target.value.slice(0, 300))}
        />
      </FlitField>
    </div>
  );
}
