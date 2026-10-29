// FLITO Logística — pestaña Viajes a cliente (HU #14116). Una tarjeta por compañía con LT
// clasificadas; el precio se ve ANTES de confirmar. POST /traslados destino cliente. Nunca cerrar-lote.
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CompaniaCerrableLogistica, LtClasificadaCerrable } from '@operaciones/shared-types';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { hasPage } from '../../../lib/permissions';
import {
  avisoSinPrecio, codigoDe, DESTINO_CLIENTE, formatoPrecio, mensajeRegistrarViaje, nombreCompania, nuevaKey,
} from '../../../lib/viajesCliente';
import { toastOk } from '../../flit/ToastFlito';
import FlitModal from '../../flit/FlitModal';
import {
  FlitCard, FlitEmpty, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../../flit/flitPageKit';

type Carga = 'cargando' | 'ok' | 'error' | 'error403';

interface Props {
  grupos: CompaniaCerrableLogistica[];
  estado: Carga;
  onReintentar: () => void;
  onRegistrado: () => void;
}

export default function ViajesACliente({ grupos, estado, onReintentar, onRegistrado }: Props) {
  const { user } = useAuth();
  const veTarifas = hasPage(user, 'flito_tarifas');
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
      <div role="status" aria-label="Cargando viajes a cliente…" className="space-y-3">
        {[0, 1].map((i) => (
          <div key={i} className="rounded-xl border p-4" style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-card)' }}>
            <div className="h-4 w-1/3 rounded" style={{ background: 'var(--flit-border-soft)' }} />
            <div className="mt-3 h-3 w-2/3 rounded" style={{ background: 'var(--flit-border-soft)' }} />
            <div className="mt-2 h-3 w-1/2 rounded" style={{ background: 'var(--flit-border-soft)' }} />
            <div className="mt-4 h-10 w-40 rounded-full" style={{ background: 'var(--flit-border-soft)' }} />
          </div>
        ))}
      </div>
    );
  }

  if (estado === 'error' || estado === 'error403') {
    return (
      <FlitCard>
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
          <p className="flex-1">{estado === 'error403' ? 'No tienes permiso para registrar viajes.' : 'No se pudieron cargar las LT listas para viaje.'}</p>
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
        <h2 className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>Viajes a cliente</h2>
        <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          Cada compañía con LT clasificadas es un viaje. Revisa el precio y regístralo.
        </p>
      </div>

      {grupos.length === 0 ? (
        <FlitEmpty>
          No hay LT clasificadas listas para un viaje. El mensajero tiene que recogerlas y clasificarlas en el organismo primero.
        </FlitEmpty>
      ) : (
        <ul className="space-y-3">
          {grupos.map((g) => (
            <li key={g.companiaId}>
              <TarjetaGrupo
                grupo={g}
                veTarifas={veTarifas}
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
          veTarifas={veTarifas}
          onClose={() => setConfirmar(null)}
          onRegistrado={() => { setConfirmar(null); onRegistrado(); }}
        />
      )}
    </div>
  );
}

function TarjetaGrupo({ grupo, veTarifas, expandida, onToggle, onRegistrar }: {
  grupo: CompaniaCerrableLogistica;
  veTarifas: boolean;
  expandida: boolean;
  onToggle: () => void;
  onRegistrar: () => void;
}) {
  const nombre = nombreCompania(grupo.nombre, grupo.companiaId);
  const sinPrecio = grupo.precioEntregaCliente == null;
  const visibles = grupo.lts.slice(0, 3);
  const resto = grupo.lts.slice(3);
  const nLt = grupo.disponibles;

  return (
    <article className="rounded-xl border p-4" style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-card)' }}>
      <h3 className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
        {nombre} · {nLt} LT
      </h3>

      {sinPrecio ? (
        <div className="mt-2 space-y-2">
          <p className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{avisoSinPrecio(nombre)}</p>
          {veTarifas ? (
            <Link
              to={`/flito/tarifas/${grupo.companiaId}`}
              className={`${flitBtnSecondary} inline-flex`}
              style={flitBtnSecondaryStyle}
            >
              Ir a Tarifas
            </Link>
          ) : (
            <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
              Pídele a Finanzas que fije el precio de Entrega a cliente.
            </p>
          )}
          <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            Falta el precio; no puedes registrar este viaje todavía.
          </p>
        </div>
      ) : (
        <p className="mt-1 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          Se cobrará {formatoPrecio(grupo.precioEntregaCliente!)} por LT · Total {formatoPrecio(grupo.precioEntregaCliente! * nLt)}
        </p>
      )}

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

      {!sinPrecio && (
        <div className="mt-4 flex justify-end">
          <button type="button" className={`${flitBtnPrimary} w-full justify-center sm:w-auto`} style={flitBtnPrimaryStyle} onClick={onRegistrar}>
            Registrar viaje
          </button>
        </div>
      )}
    </article>
  );
}

function lineaLt(lt: LtClasificadaCerrable): string {
  const placa = lt.placa ?? '—';
  return lt.numeroLt ? `${placa} · LT ${lt.numeroLt}` : placa;
}

function ModalConfirmarViaje({ grupo, veTarifas, onClose, onRegistrado }: {
  grupo: CompaniaCerrableLogistica;
  veTarifas: boolean;
  onClose: () => void;
  onRegistrado: () => void;
}) {
  const nombre = nombreCompania(grupo.nombre, grupo.companiaId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codigo, setCodigo] = useState<string | null>(null);
  const keyRef = useRef(nuevaKey());
  const precio = grupo.precioEntregaCliente;
  const nLt = grupo.disponibles;

  const confirmar = async () => {
    setBusy(true); setError(null); setCodigo(null);
    try {
      await api.post('/flito/logistica/traslados', {
        companiaId: grupo.companiaId,
        destino: DESTINO_CLIENTE,
        lts: grupo.lts.map(({ documentoId }) => ({ documentoId })),
      }, { 'Idempotency-Key': keyRef.current });
      toastOk(`Viaje a cliente de ${nombre} registrado (${nLt} LT).`);
      onRegistrado();
    } catch (e) {
      setCodigo(codigoDe(e));
      setError(mensajeRegistrarViaje(e, nombre));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FlitModal title={`Registrar viaje a ${nombre}`} onClose={onClose} cierreBloqueado={busy}>
      <div className="space-y-3" aria-busy={busy || undefined}>
        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          {nLt} LT · destino Cliente
        </p>
        {precio != null && (
          <p className="text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>
            Se cobrará {formatoPrecio(precio)} por cada LT. Total {formatoPrecio(precio * nLt)}.
          </p>
        )}
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          Este precio queda congelado en el viaje. Si Finanzas lo cambia después, este viaje no se mueve.
        </p>
        <ul className="max-h-48 space-y-0.5 overflow-y-auto text-sm tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>
          {grupo.lts.map((lt) => <li key={lt.documentoId}>{lineaLt(lt)}</li>)}
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
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose} disabled={busy}>Cancelar</button>
          <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={busy} onClick={() => void confirmar()}>
            {busy ? 'Registrando…' : 'Confirmar viaje'}
          </button>
        </div>
      </div>
    </FlitModal>
  );
}
