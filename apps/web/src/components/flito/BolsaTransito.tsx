// Bolsa de tránsito (HU #11161; reestructurada en la #11210 y en el ajuste 0124).
//
// FLIT precarga dinero en la bolsa y quien la opera paga con ella ante las secretarías que cubre,
// así que lo que hay que responder de un vistazo es «¿cuánto le queda a la bolsa de mi sector?».
//
// Una bolsa NO es una secretaría: agrupa varias y cubre uno o varios cobros. Por eso el título es su
// nombre y la cobertura se enseña siempre —en la tarjeta y en el detalle—: sin ella, dos bolsas con
// saldos parecidos serían indistinguibles.

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import {
  CONCEPTO_BOLSA_TRANSITO_LABEL, getOrganismoByCodigo, NIVEL_BOLSA_TRANSITO_LABEL,
  NivelBolsaTransito,
  type BolsaTransitoConNivel, type ConceptoBolsaTransito, type CoberturaBolsaTransito,
  type MovimientoTransitoDto, type OrigenMovimientoTransito,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../../lib/api';
import { abrirSoporteBolsa, fechaDia, fechaHora, hoyColombia, pesos } from '../../lib/bolsas';
import Campo from './BolsaCampo';
import BolsaTransitoForm from './BolsaTransitoForm';
import FlitModal from '../flit/FlitModal';
import FlitUploadBox from '../flit/FlitUploadBox';
import KpiCard from '../flit/KpiCard';
import StatusChip, { type ChipTone } from '../flit/StatusChip';
import {
  FlitCard, FlitEmpty, FlitTable, FlitTh, FlitTr, flitInp,
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../flit/flitPageKit';

/**
 * Cómo se pinta cada nivel. `en_prestamo` es el único que no habla de «saldo»: cuando está en
 * negativo lo que importa no es cuánto queda, sino cuánto se debe.
 */
const TONO_NIVEL: Record<NivelBolsaTransito, { fondo: string; texto: string; urgente: boolean }> = {
  normal: { fondo: 'var(--flit-success-soft)', texto: 'var(--flit-success-text)', urgente: false },
  bajo: { fondo: 'var(--flit-warning-soft)', texto: 'var(--flit-warning-text)', urgente: true },
  critico: { fondo: 'var(--flit-danger-soft)', texto: 'var(--flit-danger-text)', urgente: true },
  agotada: { fondo: 'var(--flit-danger-soft)', texto: 'var(--flit-danger-text)', urgente: true },
  en_prestamo: { fondo: 'var(--flit-danger-soft)', texto: 'var(--flit-danger-text)', urgente: true },
  sin_cargas: { fondo: 'var(--flit-bg-muted)', texto: 'var(--flit-text-secondary)', urgente: false },
};

/** Tono de la pastilla de la tarjeta. `sin_cargas` es neutro: no es una alarma, es un pendiente. */
const CHIP_NIVEL: Record<NivelBolsaTransito, ChipTone> = {
  normal: 'success', bajo: 'warning', critico: 'danger',
  agotada: 'danger', en_prestamo: 'danger', sin_cargas: 'neutral',
};

/** Color del borde izquierdo, que es lo que permite barrer la rejilla sin leer tarjeta por tarjeta. */
const BORDE_NIVEL: Record<NivelBolsaTransito, string> = {
  normal: 'var(--flit-success)', bajo: 'var(--flit-warning)', critico: 'var(--flit-danger)',
  agotada: 'var(--flit-danger)', en_prestamo: 'var(--flit-danger)', sin_cargas: 'var(--flit-draft)',
};

export function nombreOrganismo(codigo: string): string {
  const o = getOrganismoByCodigo(codigo);
  return o ? `${o.ciudad} — ${o.nombre}` : codigo;
}

/** Nombre corto de la secretaría: en tabla y pastillas no cabe «Ciudad — Secretaría de…». */
function nombreCorto(c: CoberturaBolsaTransito | { organismoCodigo: string; organismoNombre?: string | null }): string {
  if (c.organismoNombre?.trim()) return c.organismoNombre.trim();
  const o = getOrganismoByCodigo(c.organismoCodigo);
  return o ? o.ciudad : c.organismoCodigo;
}

/** Las secretarías de la cobertura, sin repetir: la cobertura es el producto y las repite por concepto. */
function secretariasDe(cobertura: CoberturaBolsaTransito[]): CoberturaBolsaTransito[] {
  const vistas = new Map<string, CoberturaBolsaTransito>();
  for (const c of cobertura) if (!vistas.has(c.organismoCodigo)) vistas.set(c.organismoCodigo, c);
  return [...vistas.values()];
}

/** Los conceptos de la cobertura, sin repetir. */
function conceptosDe(cobertura: CoberturaBolsaTransito[]): ConceptoBolsaTransito[] {
  return [...new Set(cobertura.map((c) => c.concepto))];
}

function mensajeNivel(b: BolsaTransitoConNivel): string {
  switch (b.nivel) {
    case NivelBolsaTransito.EN_PRESTAMO:
      return `Esta bolsa está en préstamo: se siguió pagando después de agotar el saldo. Se deben ${pesos(b.deuda)}, que se netean con la próxima carga.`;
    case NivelBolsaTransito.AGOTADA:
      return 'El saldo está en cero. El próximo pago la dejará en préstamo.';
    case NivelBolsaTransito.CRITICO:
      return `Saldo crítico: queda el ${b.porcentaje ?? 0} % de la última carga. Conviene recargar ya.`;
    case NivelBolsaTransito.BAJO:
      return `Saldo bajo: queda el ${b.porcentaje ?? 0} % de la última carga.`;
    case NivelBolsaTransito.SIN_CARGAS:
      return 'Todavía no se le ha cargado saldo a esta bolsa.';
    default:
      return `Saldo normal: queda el ${b.porcentaje ?? 0} % de la última carga.`;
  }
}

/** Versión corta para la tarjeta, donde no cabe el párrafo entero del detalle. */
function resumenNivel(b: BolsaTransitoConNivel): string {
  switch (b.nivel) {
    case NivelBolsaTransito.EN_PRESTAMO:
      return 'Se siguió pagando después de agotar el saldo.';
    case NivelBolsaTransito.AGOTADA:
      return 'El próximo pago la dejará en préstamo.';
    case NivelBolsaTransito.SIN_CARGAS:
      return 'Creada, pero nunca se le ha cargado saldo.';
    default:
      return `${b.porcentaje ?? 0} % de la última carga (${pesos(b.ultimaCargaValor ?? 0)}).`;
  }
}

/** Secretarías y cobros de la bolsa, como pastillas. Es lo que distingue una bolsa de otra. */
function Cobertura({ cobertura, max }: { cobertura: CoberturaBolsaTransito[]; max?: number }) {
  const secretarias = secretariasDe(cobertura);
  const conceptos = conceptosDe(cobertura);
  const visibles = max ? secretarias.slice(0, max) : secretarias;
  const resto = secretarias.length - visibles.length;

  if (cobertura.length === 0) {
    return (
      <p className="text-xs italic" style={{ color: 'var(--flit-text-muted)' }}>
        Sin cobertura definida.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-1">
        {conceptos.map((c) => (
          <StatusChip key={c} tone="active">{CONCEPTO_BOLSA_TRANSITO_LABEL[c]}</StatusChip>
        ))}
      </div>
      <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
        {visibles.map(nombreCorto).join(', ')}{resto > 0 ? ` y ${resto} más` : ''}
      </p>
    </div>
  );
}

// ─────────────────────────── Tarjeta del tablero ─────────────────────────────

/**
 * Tarjeta de una bolsa en el acordeón «Tránsitos» (HU #11210, AC5 y AC6).
 *
 * Mismas cifras que trae el detalle, sin recalcular nada aquí: el nivel, el porcentaje y la deuda
 * los clasifica el backend, y duplicar esa lógica en pantalla sería garantizar que un día la
 * tarjeta y el modal digan cosas distintas de la misma bolsa.
 */
export function TarjetaBolsaTransito({ bolsa, onVer }: {
  bolsa: BolsaTransitoConNivel;
  onVer: () => void;
}) {
  const enPrestamo = bolsa.saldo < 0;

  return (
    <article
      data-testid={`tarjeta-bolsa-transito-${bolsa.id}`}
      className="flex flex-col bg-white p-5"
      style={{
        borderRadius: 'var(--flit-radius-card)',
        boxShadow: 'var(--flit-shadow-card)',
        border: '1px solid var(--flit-border-soft)',
        borderLeft: `4px solid ${BORDE_NIVEL[bolsa.nivel]}`,
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 truncate text-sm font-bold" title={bolsa.nombre}
          style={{ color: 'var(--flit-blue-text)' }}>
          {bolsa.nombre}
        </h3>
        <StatusChip tone={CHIP_NIVEL[bolsa.nivel]}>{NIVEL_BOLSA_TRANSITO_LABEL[bolsa.nivel]}</StatusChip>
      </div>

      <div className="mt-2">
        <Cobertura cobertura={bolsa.cobertura} max={3} />
      </div>

      <p className="mt-3 text-2xl font-bold tabular-nums leading-none"
        style={{ color: enPrestamo ? 'var(--flit-danger)' : 'var(--flit-text-primary)' }}>
        {pesos(bolsa.saldo)}
      </p>
      <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
        {resumenNivel(bolsa)}
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div>
          <dt style={{ color: 'var(--flit-text-muted)' }}>Cargado por FLIT</dt>
          <dd className="font-semibold tabular-nums" style={{ color: 'var(--flit-success-text)' }}>
            {pesos(bolsa.totalCargado)}
          </dd>
        </div>
        <div>
          <dt style={{ color: 'var(--flit-text-muted)' }}>Consumido</dt>
          <dd className="font-semibold tabular-nums" style={{ color: 'var(--flit-warning-text)' }}>
            {pesos(bolsa.totalConsumido)}
          </dd>
        </div>
        <div className="col-span-2">
          <dt style={{ color: 'var(--flit-text-muted)' }}>Deuda actual</dt>
          {/* Cero es un dato, no un hueco: dice que por esta bolsa no se debe nada. */}
          <dd className="font-semibold tabular-nums"
            style={{ color: bolsa.deuda > 0 ? 'var(--flit-danger)' : undefined }}>
            {pesos(bolsa.deuda)}
          </dd>
        </div>
      </dl>

      <button type="button" className={`${flitBtnPrimary} mt-4 self-start`} style={flitBtnPrimaryStyle}
        onClick={onVer} aria-label={`Ver el detalle de ${bolsa.nombre}`}>
        Ver detalle
      </button>
    </article>
  );
}

// ─────────────────────────── Detalle ─────────────────────────────────────────

/**
 * Cómo se nombra una ENTRADA del libro según quién la produjo.
 *
 * `Record` y no el ternario que había aquí (`origen === 'carga' ? 'Carga' : 'Devolución'`): el
 * ternario compilaba igual con un origen nuevo y lo rotulaba «Devolución», que es la clase de error
 * que nadie ve. Con el mapa exhaustivo, el próximo valor de `OrigenMovimientoTransito` es un error
 * de compilación aquí en vez de una etiqueta equivocada en pantalla (Feature #11623).
 */
const ENTRADA_POR_ORIGEN: Record<OrigenMovimientoTransito, string> = {
  carga: 'Carga',
  automatico: 'Devolución',
  // Una conciliación es siempre una SALIDA, así que esta entrada no debería usarse nunca. Está para
  // que el mapa sea exhaustivo, y si algún día aparece, que diga la verdad y no «Devolución».
  conciliacion: 'Conciliación',
};

/** Cómo se nombra una línea del libro. Un consumo dice de qué cobro salió. */
function tipoMovimiento(m: MovimientoTransitoDto): string {
  if (m.tipo === 'entrada') return ENTRADA_POR_ORIGEN[m.origen];
  return m.concepto ? `Pago de ${CONCEPTO_BOLSA_TRANSITO_LABEL[m.concepto].toLowerCase()}` : 'Consumo';
}

/**
 * Detalle de una bolsa de tránsito: alerta de nivel, cifras, cobertura y libro de movimientos.
 *
 * Se monta dentro de un modal desde el tablero. Recibe el id y vuelve a pedir la bolsa en vez de
 * heredar la del listado: entre que se pintó la rejilla y se abrió el detalle puede haberse liquidado
 * un trámite, y el libro tiene que cuadrar con el saldo que se enseña encima.
 */
export default function BolsaTransitoDetalle({ bolsaId, onCambio }: {
  bolsaId: string;
  /** Avisa al tablero de que el saldo o la cobertura cambiaron, para que refresque la tarjeta. */
  onCambio: () => void;
}) {
  const [bolsa, setBolsa] = useState<BolsaTransitoConNivel | null>(null);
  const [movimientos, setMovimientos] = useState<MovimientoTransitoDto[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [cargandoSaldo, setCargandoSaldo] = useState(false);
  const [editando, setEditando] = useState(false);

  const recargar = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let vigente = true;
    setCargando(true);
    setError(null);

    Promise.all([
      api.get<BolsaTransitoConNivel>(`/flito/bolsas/transito/${bolsaId}`),
      api.get<MovimientoTransitoDto[]>(`/flito/bolsas/transito/${bolsaId}/movimientos`),
    ])
      .then(([b, m]) => {
        if (!vigente) return;
        setBolsa(b);
        setMovimientos(Array.isArray(m) ? m : []);
      })
      .catch((e) => { if (vigente) setError(errorMessage(e)); })
      .finally(() => { if (vigente) setCargando(false); });

    return () => { vigente = false; };
  }, [bolsaId, nonce]);

  if (error) {
    return (
      <div>
        <p className="text-sm" style={{ color: 'var(--flit-danger)' }}>{error}</p>
        <button type="button" className={`${flitBtnSecondary} mt-3`} style={flitBtnSecondaryStyle} onClick={recargar}>
          Reintentar
        </button>
      </div>
    );
  }

  if (cargando && !bolsa) {
    return <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Consultando la bolsa…</p>;
  }

  if (!bolsa) return null;

  return (
    <div className="space-y-4">
      {/* `role` según urgencia y el nivel SIEMPRE escrito: la alerta no puede depender del color,
          porque quien no lo distinga se quedaría sin la información entera. */}
      <div
        role={TONO_NIVEL[bolsa.nivel].urgente ? 'alert' : 'status'}
        data-testid="alerta-nivel-transito"
        className="rounded-lg px-4 py-3 text-sm"
        style={{ background: TONO_NIVEL[bolsa.nivel].fondo, color: TONO_NIVEL[bolsa.nivel].texto }}
      >
        <strong>{NIVEL_BOLSA_TRANSITO_LABEL[bolsa.nivel]}</strong> · {mensajeNivel(bolsa)}
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            Cobertura
          </p>
          <Cobertura cobertura={bolsa.cobertura} />
        </div>
        <div className="flex gap-2">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
            onClick={() => setEditando(true)}>
            Editar cobertura
          </button>
          <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
            onClick={() => setCargandoSaldo(true)}>
            Cargar saldo
          </button>
        </div>
      </div>

      <section aria-label={`Bolsa ${bolsa.nombre}`} className="grid gap-3 sm:grid-cols-3">
        <KpiCard label="Saldo disponible" value={pesos(bolsa.saldo)}
          hint={bolsa.saldo < 0
            ? 'Negativo: la bolsa está en préstamo. La próxima carga lo neta.'
            : 'Lo que queda del dinero que FLIT precargó en esta bolsa.'}
          chip={bolsa.saldo < 0 ? { tone: 'danger', label: 'En préstamo' } : undefined} />
        <KpiCard label="Total cargado" value={pesos(bolsa.totalCargado)}
          hint="Todo lo que FLIT ha transferido, desde el primer movimiento." />
        <KpiCard label="Total consumido" value={pesos(bolsa.totalConsumido)}
          hint="Pagos hechos con cargo a este saldo." />
      </section>

      <FlitCard>
        <h3 className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>
          Libro de movimientos ({movimientos.length})
        </h3>
        <p className="mb-3 mt-1 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
          Nada se edita ni se borra: una corrección es un movimiento nuevo. El saldo resultante de
          cada línea permite auditar el libro sin recalcular.
        </p>
        {movimientos.length === 0 ? (
          <FlitEmpty>Esta bolsa todavía no tiene movimientos.</FlitEmpty>
        ) : (
          <section aria-label="Movimientos de la bolsa de tránsito">
            <FlitTable>
              <thead>
                <tr>
                  <FlitTh>Fecha</FlitTh>
                  <FlitTh>Tipo</FlitTh>
                  <FlitTh>Secretaría</FlitTh>
                  <FlitTh>Trámite</FlitTh>
                  <FlitTh center>Valor</FlitTh>
                  <FlitTh center>Saldo resultante</FlitTh>
                  <FlitTh>Registrado por</FlitTh>
                  <FlitTh center>Soporte</FlitTh>
                </tr>
              </thead>
              <tbody>
                {movimientos.map((m) => (
                  <FlitTr key={m.id}>
                    <td className="px-4 py-2 text-sm whitespace-nowrap">
                      <div>{fechaDia(m.fecha)}</div>
                      <div className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
                        {fechaHora(m.createdAt)}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-sm">{tipoMovimiento(m)}</td>
                    <td className="px-4 py-2 text-sm">
                      {/* Las cargas entran a la bolsa entera, no a una secretaría. */}
                      {m.organismoCodigo ? nombreOrganismo(m.organismoCodigo) : '—'}
                    </td>
                    <td className="px-4 py-2 text-sm tabular-nums" title={m.tramiteId ?? undefined}>
                      {m.tramiteId
                        ? <a className="font-semibold underline" style={{ color: 'var(--flit-blue)' }}
                            href={`/flito/tramites/${m.tramiteId}`}>{m.idFlit ?? 'Ver trámite'}</a>
                        : '—'}
                    </td>
                    <td className="px-4 py-2 text-right text-sm font-semibold tabular-nums"
                      style={{ color: m.tipo === 'entrada' ? 'var(--flit-success-text)' : undefined }}>
                      {m.tipo === 'entrada' ? '+' : '−'}{pesos(m.valor)}
                    </td>
                    <td className="px-4 py-2 text-right text-sm tabular-nums">{pesos(m.saldoResultante)}</td>
                    <td className="px-4 py-2 text-xs">{m.registradoPorNombre}</td>
                    <td className="px-4 py-2 text-center">
                      <SoporteDeLinea soporteId={m.soporteId}
                        etiqueta={`Abrir el soporte del movimiento del ${fechaDia(m.fecha)}`} />
                    </td>
                  </FlitTr>
                ))}
              </tbody>
            </FlitTable>
          </section>
        )}
      </FlitCard>

      {cargandoSaldo && (
        <ModalCargaTransito bolsaId={bolsaId} nombre={bolsa.nombre}
          onClose={() => setCargandoSaldo(false)}
          onHecho={() => { setCargandoSaldo(false); recargar(); onCambio(); }} />
      )}

      {editando && (
        <BolsaTransitoForm
          bolsaId={bolsaId}
          inicial={{
            nombre: bolsa.nombre,
            organismos: secretariasDe(bolsa.cobertura).map((c) => c.organismoCodigo),
            conceptos: conceptosDe(bolsa.cobertura),
          }}
          onClose={() => setEditando(false)}
          onHecho={() => { setEditando(false); recargar(); onCambio(); }}
        />
      )}
    </div>
  );
}

function SoporteDeLinea({ soporteId, etiqueta }: { soporteId: string | null; etiqueta: string }) {
  if (!soporteId) {
    return <span className="text-xs italic" style={{ color: 'var(--flit-text-muted)' }}>Sin soporte</span>;
  }
  return (
    <button type="button" className="text-xs font-semibold underline" style={{ color: 'var(--flit-blue)' }}
      aria-label={etiqueta} onClick={() => abrirSoporteBolsa(soporteId)}>
      Ver soporte
    </button>
  );
}

function ModalCargaTransito({ bolsaId, nombre, onClose, onHecho }: {
  bolsaId: string; nombre: string; onClose: () => void; onHecho: () => void;
}) {
  const [valor, setValor] = useState('');
  const [fecha, setFecha] = useState(hoyColombia);
  const [observacion, setObservacion] = useState('');
  const [archivo, setArchivo] = useState<File | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valorNum = Number(valor);
  // Cero y negativos se paran aquí, antes de salir a la red.
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
      const r = await api.post<{ saldo: number }>(`/flito/bolsas/transito/${bolsaId}/cargas`, form);
      toast.success(`Carga registrada. Saldo de ${nombre}: ${pesos(r.saldo)}.`);
      onHecho();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <FlitModal title={`Cargar saldo a ${nombre}`} onClose={onClose} wide>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); guardar(); }}>
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

        {error && <p className="text-sm" style={{ color: 'var(--flit-danger)' }}>{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>
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
