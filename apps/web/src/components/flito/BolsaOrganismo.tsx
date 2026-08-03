// Bolsa prepago del Organismo de Tránsito (HU #11162).
//
// Esta pantalla sustituye al «estado de cuenta» de la HU #11130, que estaba construido al revés:
// mostraba una DEUDA derivada (cobrado a los clientes − pagado por FLIT) cuando el negocio funciona
// al contrario. FLIT precarga dinero en la secretaría y ella lo consume con cada derecho de trámite,
// así que lo que hay que responder de un vistazo es «¿cuánto le queda a Medellín?».
//
// Los organismos SIN bolsa no tienen nada que mostrar aquí, y no es un vacío accidental: a esas
// secretarías FLIT nunca les envía dinero, así que no hay saldo ni movimiento posible. La pantalla
// lo dice y no ofrece la acción de cargar.

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import {
  getOrganismoByCodigo, NIVEL_BOLSA_ORGANISMO_LABEL, NivelBolsaOrganismo,
  type BolsaOrganismoConNivel, type MovimientoOrganismoDto,
} from '@operaciones/shared-types';
import { api, ApiError, errorMessage } from '../../lib/api';
import { abrirSoporteBolsa, fechaDia, fechaHora, hoyColombia, pesos } from '../../lib/bolsas';
import Campo from './BolsaCampo';
import FlitModal from '../flit/FlitModal';
import FlitOrganismoCombobox from '../flit/FlitOrganismoCombobox';
import FlitUploadBox from '../flit/FlitUploadBox';
import KpiCard from '../flit/KpiCard';
import {
  FlitCard, FlitEmpty, FlitTable, FlitTh, FlitTr, flitInp,
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../flit/flitPageKit';

/**
 * Cómo se pinta cada nivel. `en_prestamo` es el único que no habla de «saldo»: cuando está en
 * negativo lo que importa no es cuánto queda, sino cuánto se le debe.
 */
const TONO_NIVEL: Record<NivelBolsaOrganismo, { fondo: string; texto: string; urgente: boolean }> = {
  normal: { fondo: 'var(--flit-success-soft)', texto: 'var(--flit-success-text)', urgente: false },
  bajo: { fondo: 'var(--flit-warning-soft)', texto: 'var(--flit-warning-text)', urgente: true },
  critico: { fondo: 'var(--flit-danger-soft)', texto: 'var(--flit-danger-text)', urgente: true },
  agotada: { fondo: 'var(--flit-danger-soft)', texto: 'var(--flit-danger-text)', urgente: true },
  en_prestamo: { fondo: 'var(--flit-danger-soft)', texto: 'var(--flit-danger-text)', urgente: true },
  sin_cargas: { fondo: 'var(--flit-bg-muted)', texto: 'var(--flit-text-secondary)', urgente: false },
};

function mensajeNivel(b: BolsaOrganismoConNivel): string {
  switch (b.nivel) {
    case NivelBolsaOrganismo.EN_PRESTAMO:
      return `Este organismo está en préstamo: siguió emitiendo derechos después de agotar el saldo. Se le deben ${pesos(b.deuda)}, que se netean con la próxima carga.`;
    case NivelBolsaOrganismo.AGOTADA:
      return 'El saldo está en cero. El próximo derecho de trámite lo dejará en préstamo.';
    case NivelBolsaOrganismo.CRITICO:
      return `Saldo crítico: queda el ${b.porcentaje ?? 0} % de la última carga. Conviene recargar ya.`;
    case NivelBolsaOrganismo.BAJO:
      return `Saldo bajo: queda el ${b.porcentaje ?? 0} % de la última carga.`;
    case NivelBolsaOrganismo.SIN_CARGAS:
      return 'Todavía no se le ha cargado saldo a este organismo.';
    default:
      return `Saldo normal: queda el ${b.porcentaje ?? 0} % de la última carga.`;
  }
}

export default function BolsaOrganismo() {
  const [codigo, setCodigo] = useState('');
  const [bolsa, setBolsa] = useState<BolsaOrganismoConNivel | null>(null);
  const [movimientos, setMovimientos] = useState<MovimientoOrganismoDto[]>([]);
  /** El organismo existe pero no opera prepago. Es distinto de «error» y de «aún cargando». */
  const [sinBolsa, setSinBolsa] = useState(false);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [cargandoSaldo, setCargandoSaldo] = useState(false);

  const recargar = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!codigo) { setBolsa(null); setSinBolsa(false); setError(null); return; }
    let vigente = true;
    setCargando(true);
    setError(null);
    setSinBolsa(false);

    api.get<BolsaOrganismoConNivel>(`/flito/bolsas/organismos/${codigo}/bolsa`)
      .then(async (b) => {
        if (!vigente) return;
        setBolsa(b);
        // El libro solo se pide si hay bolsa: en un organismo sin ella no existe.
        const m = await api.get<MovimientoOrganismoDto[]>(`/flito/bolsas/organismos/${codigo}/movimientos`);
        if (vigente) setMovimientos(Array.isArray(m) ? m : []);
      })
      .catch((e) => {
        if (!vigente) return;
        setBolsa(null);
        setMovimientos([]);
        // 404 aquí NO es un fallo: es la respuesta a «este organismo no maneja bolsa prepago».
        if (e instanceof ApiError && e.status === 404) setSinBolsa(true);
        else setError(errorMessage(e));
      })
      .finally(() => { if (vigente) setCargando(false); });

    return () => { vigente = false; };
  }, [codigo, nonce]);

  const organismo = codigo ? getOrganismoByCodigo(codigo) : undefined;
  const nombre = organismo ? `${organismo.ciudad} — ${organismo.nombre}` : codigo;

  return (
    <div className="space-y-4">
      <FlitCard>
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-[280px] flex-1">
            <span className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
              Organismo de tránsito
            </span>
            <FlitOrganismoCombobox value={codigo} onChange={setCodigo}
              aria-label="Organismo de tránsito de la bolsa" />
          </div>
          {/* AC7: sin bolsa no se ofrece la acción. Deshabilitarla invitaría a preguntarse por qué. */}
          {bolsa && (
            <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
              onClick={() => setCargandoSaldo(true)}>
              Cargar saldo
            </button>
          )}
        </div>
        <p className="mt-3 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          Saldo que FLIT mantiene precargado en el organismo. Cada <strong>derecho de trámite</strong> que
          emita lo descuenta; los demás conceptos no lo tocan.
        </p>
      </FlitCard>

      {!codigo && (
        <FlitCard>
          <FlitEmpty>Elige un organismo para ver su saldo disponible y su libro de movimientos.</FlitEmpty>
        </FlitCard>
      )}

      {sinBolsa && (
        <FlitCard>
          <FlitEmpty>
            <span data-testid="organismo-sin-bolsa">
              {nombre} no maneja bolsa prepago. FLIT no le transfiere dinero por adelantado, así que no
              hay saldo ni movimientos que mostrar. Se activa desde la configuración del organismo.
            </span>
          </FlitEmpty>
        </FlitCard>
      )}

      {error && (
        <FlitCard>
          <p className="text-sm" style={{ color: 'var(--flit-danger)' }}>{error}</p>
          <button type="button" className={`${flitBtnSecondary} mt-3`} style={flitBtnSecondaryStyle} onClick={recargar}>
            Reintentar
          </button>
        </FlitCard>
      )}

      {codigo && cargando && !bolsa && !sinBolsa && (
        <FlitCard>
          <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Consultando la bolsa…</p>
        </FlitCard>
      )}

      {bolsa && !error && (
        <>
          {/* AC3. `role` según urgencia y el nivel SIEMPRE escrito: la alerta no puede depender del
              color, porque quien no lo distinga se quedaría sin la información entera. */}
          <div
            role={TONO_NIVEL[bolsa.nivel].urgente ? 'alert' : 'status'}
            data-testid="alerta-nivel-organismo"
            className="rounded-lg px-4 py-3 text-sm"
            style={{ background: TONO_NIVEL[bolsa.nivel].fondo, color: TONO_NIVEL[bolsa.nivel].texto }}
          >
            <strong>{NIVEL_BOLSA_ORGANISMO_LABEL[bolsa.nivel]}</strong> · {mensajeNivel(bolsa)}
          </div>

          <section aria-label={`Bolsa de ${nombre}`} className="grid gap-3 sm:grid-cols-3">
            <KpiCard label="Saldo disponible" value={pesos(bolsa.saldo)}
              hint={bolsa.saldo < 0
                ? 'Negativo: el organismo está en préstamo. La próxima carga lo neta.'
                : 'Lo que le queda a FLIT precargado en este organismo.'}
              chip={bolsa.saldo < 0 ? { tone: 'danger', label: 'En préstamo' } : undefined} />
            <KpiCard label="Total cargado" value={pesos(bolsa.totalCargado)}
              hint="Todo lo que FLIT le ha transferido, desde el primer movimiento." />
            <KpiCard label="Total consumido" value={pesos(bolsa.totalConsumido)}
              hint="Derechos de trámite emitidos con cargo a este saldo." />
          </section>

          <FlitCard>
            <h3 className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>
              Libro de movimientos · {nombre} ({movimientos.length})
            </h3>
            <p className="mb-3 mt-1 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
              Nada se edita ni se borra: una corrección es un movimiento nuevo. El saldo resultante de
              cada línea permite auditar el libro sin recalcular.
            </p>
            {movimientos.length === 0 ? (
              <FlitEmpty>Esta bolsa todavía no tiene movimientos.</FlitEmpty>
            ) : (
              <section aria-label="Movimientos de la bolsa del organismo">
                <FlitTable>
                  <thead>
                    <tr>
                      <FlitTh>Fecha</FlitTh>
                      <FlitTh>Tipo</FlitTh>
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
                        <td className="px-4 py-2 text-sm">
                          {m.tipo === 'entrada'
                            ? (m.origen === 'carga' ? 'Carga' : 'Devolución')
                            : 'Consumo de derecho'}
                        </td>
                        <td className="px-4 py-2 text-sm tabular-nums" title={m.tramiteId ?? undefined}>
                          {/* AC5: los consumos cuelgan de un trámite; las cargas no. */}
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
        </>
      )}

      {cargandoSaldo && codigo && (
        <ModalCargaOrganismo codigo={codigo} nombre={nombre}
          onClose={() => setCargandoSaldo(false)}
          onHecho={() => { setCargandoSaldo(false); recargar(); }} />
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

function ModalCargaOrganismo({ codigo, nombre, onClose, onHecho }: {
  codigo: string; nombre: string; onClose: () => void; onHecho: () => void;
}) {
  const [valor, setValor] = useState('');
  const [fecha, setFecha] = useState(hoyColombia);
  const [observacion, setObservacion] = useState('');
  const [archivo, setArchivo] = useState<File | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valorNum = Number(valor);
  // AC8: cero y negativos se paran aquí, antes de salir a la red.
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
      const r = await api.post<{ saldo: number }>(`/flito/bolsas/organismos/${codigo}/cargas`, form);
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
          Es dinero que FLIT le transfiere al organismo por adelantado. Si la bolsa venía en préstamo,
          esta carga descuenta primero la deuda.
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
