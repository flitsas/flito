// Estado de cuenta del Organismo de Tránsito (HU #11130).
//
// Esta pantalla NO muestra una bolsa: muestra una CUENTA. Lo que se ve es la diferencia entre lo que
// FLIT le cobró a sus clientes por cuenta del organismo y lo que ya le ha pagado. Registrar un pago
// aquí no toca el saldo de ningún cliente, y la pantalla lo dice en voz alta (AC3) porque «saldo
// pendiente» junto a «bolsa» invita exactamente a la confusión contraria.
//
// Las tres consultas van juntas —cuenta, trámites que la originaron e historial de pagos— porque
// conciliar con un organismo es cruzar las tres: cuánto suma, de dónde sale y qué se le ha pagado.

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import {
  CONCEPTO_BOLSA_LABEL, getOrganismoByCodigo,
  type BolsaSimbolicaOrganismo, type ConceptoBolsa, type PagoOrganismoDto, type TramiteOrganismoDto,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../../lib/api';
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

interface Props {
  /** Para nombrar al cliente de cada línea: los trámites llegan con `companiaId`, no con su nombre. */
  clientes: { id: number; name: string }[];
}

export default function BolsaOrganismo({ clientes }: Props) {
  const [codigo, setCodigo] = useState('');
  const [cuenta, setCuenta] = useState<BolsaSimbolicaOrganismo | null>(null);
  const [tramites, setTramites] = useState<TramiteOrganismoDto[]>([]);
  const [pagos, setPagos] = useState<PagoOrganismoDto[]>([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [pagando, setPagando] = useState(false);

  const recargar = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!codigo) { setCuenta(null); setError(null); return; }
    let vigente = true;
    setCargando(true);
    setError(null);
    Promise.all([
      api.get<BolsaSimbolicaOrganismo>(`/flito/bolsas/organismos/${codigo}`),
      api.get<TramiteOrganismoDto[]>(`/flito/bolsas/organismos/${codigo}/tramites`),
      api.get<PagoOrganismoDto[]>(`/flito/bolsas/organismos/${codigo}/pagos`),
    ])
      .then(([c, t, p]) => {
        if (!vigente) return;
        setCuenta(c);
        setTramites(Array.isArray(t) ? t : []);
        setPagos(Array.isArray(p) ? p : []);
      })
      .catch((e) => { if (vigente) { setError(errorMessage(e)); setCuenta(null); } })
      .finally(() => { if (vigente) setCargando(false); });
    return () => { vigente = false; };
  }, [codigo, nonce]);

  const organismo = codigo ? getOrganismoByCodigo(codigo) : undefined;
  const nombre = organismo ? `${organismo.ciudad} — ${organismo.nombre}` : codigo;
  const nombreCliente = (id: number) => clientes.find((c) => c.id === id)?.name ?? `Cliente ${id}`;

  return (
    <div className="space-y-4">
      <FlitCard>
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-[280px] flex-1">
            <span className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
              Organismo de tránsito
            </span>
            <FlitOrganismoCombobox value={codigo} onChange={setCodigo}
              aria-label="Organismo de tránsito del estado de cuenta" />
          </div>
          {codigo && (
            <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
              onClick={() => setPagando(true)}>
              Registrar un pago al organismo
            </button>
          )}
        </div>
        {/* AC3: la aclaración va SIEMPRE visible, no escondida tras un icono de ayuda. */}
        <p className="mt-3 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          Saldo simbólico de conciliación: es lo que FLIT le debe al organismo, no dinero de ninguna
          bolsa. Registrar un pago aquí <strong>no altera el saldo de ningún cliente</strong>.
        </p>
      </FlitCard>

      {!codigo && (
        <FlitCard>
          <FlitEmpty>Elige un organismo para ver lo cobrado por su cuenta, lo pagado y lo pendiente.</FlitEmpty>
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

      {codigo && cargando && !cuenta && (
        <FlitCard>
          <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Consultando el estado de cuenta…</p>
        </FlitCard>
      )}

      {cuenta && !error && (
        <>
          <section aria-label={`Estado de cuenta de ${nombre}`} className="grid gap-3 sm:grid-cols-3">
            <KpiCard label="Cobrado a los clientes" value={pesos(cuenta.totalCobrado)}
              hint="Salidas de bolsa asentadas por cuenta de este organismo." />
            <KpiCard label="Pagado por FLIT" value={pesos(cuenta.totalPagado)}
              hint="Lo que ya se le transfirió al organismo." />
            <KpiCard label="Pendiente de pago" value={pesos(cuenta.saldoPendiente)}
              hint={cuenta.saldoPendiente < 0
                ? 'Negativo: se le pagó de más. Se compensa con lo que se cobre después.'
                : 'Lo que FLIT todavía le debe.'}
              chip={cuenta.saldoPendiente > 0 ? { tone: 'warning', label: 'Por conciliar' } : undefined} />
          </section>

          <FlitCard>
            <h3 className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>
              Consumo por concepto · {nombre}
            </h3>
            <p className="mb-3 mt-1 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
              Solo cuentan las salidas: una entrada con organismo es un contramovimiento de reverso y
              se resta, porque sumarla inflaría la deuda con el organismo.
            </p>
            {cuenta.porConcepto.length === 0 ? (
              // AC4: sin movimientos NO es un error. Los totales de arriba ya están en cero.
              <FlitEmpty>
                Este organismo todavía no tiene conceptos cobrados. Los totales están en cero.
              </FlitEmpty>
            ) : (
              // Con nombre: en esta pantalla conviven tres tablas y varias comparten rótulo de
              // columna. Sin la región, «la columna Concepto» es ambigua para quien navega por
              // teclado o con lector de pantalla.
              <section aria-label="Consumo por concepto del organismo">
                <FlitTable>
                  <thead>
                    <tr>
                      <FlitTh>Concepto</FlitTh>
                      <FlitTh center>Cobrado</FlitTh>
                      <FlitTh center>Movimientos</FlitTh>
                    </tr>
                  </thead>
                  <tbody>
                    {[...cuenta.porConcepto].sort((a, b) => b.cobrado - a.cobrado).map((l) => (
                      <FlitTr key={l.concepto ?? 'sin_concepto'}>
                        <td className="px-4 py-2 text-sm">
                          {CONCEPTO_BOLSA_LABEL[l.concepto as ConceptoBolsa] ?? 'Sin concepto'}
                        </td>
                        <td className="px-4 py-2 text-right text-sm font-semibold tabular-nums">{pesos(l.cobrado)}</td>
                        <td className="px-4 py-2 text-right text-sm tabular-nums">{l.movimientos}</td>
                      </FlitTr>
                    ))}
                  </tbody>
                  <tfoot>
                    <FlitTr>
                      <td className="px-4 py-2 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
                        Total cobrado
                      </td>
                      <td className="px-4 py-2 text-right text-sm font-bold tabular-nums" style={{ color: 'var(--flit-blue-text)' }}>
                        {pesos(cuenta.totalCobrado)}
                      </td>
                      <td />
                    </FlitTr>
                  </tfoot>
                </FlitTable>
              </section>
            )}
          </FlitCard>

          <FlitCard>
            <h3 className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>
              Trámites que originaron el cobro ({tramites.length})
            </h3>
            <p className="mb-3 mt-1 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
              Solo salidas automáticas: un ajuste manual imputado a este organismo es una corrección
              de FLIT, no algo que el organismo haya facturado.
            </p>
            {tramites.length === 0 ? (
              <FlitEmpty>Ningún trámite ha consumido bolsa por cuenta de este organismo.</FlitEmpty>
            ) : (
              <section aria-label="Trámites del organismo">
                <FlitTable>
                  <thead>
                    <tr>
                      <FlitTh>Trámite</FlitTh>
                      <FlitTh>Cliente</FlitTh>
                      <FlitTh>Concepto</FlitTh>
                      <FlitTh>Fecha</FlitTh>
                      <FlitTh center>Valor</FlitTh>
                      <FlitTh center>Soporte</FlitTh>
                    </tr>
                  </thead>
                  <tbody>
                    {tramites.map((t) => (
                      <FlitTr key={`${t.tramiteId}-${t.concepto ?? 'sin_concepto'}`}>
                        <td className="px-4 py-2 text-sm tabular-nums" title={t.tramiteId}>
                          {t.idFlit ?? 'Sin id de FLIT'}
                        </td>
                        <td className="px-4 py-2 text-sm">{nombreCliente(t.companiaId)}</td>
                        <td className="px-4 py-2 text-sm">
                          {t.concepto ? CONCEPTO_BOLSA_LABEL[t.concepto as ConceptoBolsa] ?? t.concepto : '—'}
                        </td>
                        <td className="px-4 py-2 text-sm whitespace-nowrap">{fechaDia(t.fecha)}</td>
                        <td className="px-4 py-2 text-right text-sm font-semibold tabular-nums">{pesos(t.valor)}</td>
                        <td className="px-4 py-2 text-center">
                          <SoporteDeLinea soporteId={t.soporteId}
                            etiqueta={`Abrir el soporte del trámite ${t.idFlit ?? t.tramiteId}`} />
                        </td>
                      </FlitTr>
                    ))}
                  </tbody>
                </FlitTable>
              </section>
            )}
          </FlitCard>

          <FlitCard>
            <h3 className="mb-3 text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>
              Historial de pagos al organismo ({pagos.length})
            </h3>
            {pagos.length === 0 ? (
              <FlitEmpty>Todavía no se le ha registrado ningún pago a este organismo.</FlitEmpty>
            ) : (
              <section aria-label="Pagos al organismo">
                <FlitTable>
                  <thead>
                    <tr>
                      <FlitTh>Fecha</FlitTh>
                      <FlitTh center>Valor</FlitTh>
                      <FlitTh>Observación</FlitTh>
                      <FlitTh>Registrado por</FlitTh>
                      <FlitTh center>Soporte</FlitTh>
                    </tr>
                  </thead>
                  <tbody>
                    {pagos.map((p) => (
                      <FlitTr key={p.id}>
                        <td className="px-4 py-2 text-sm whitespace-nowrap">
                          <div>{fechaDia(p.fecha)}</div>
                          <div className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
                            {fechaHora(p.createdAt)}
                          </div>
                        </td>
                        <td className="px-4 py-2 text-right text-sm font-semibold tabular-nums">{pesos(p.valor)}</td>
                        <td className="px-4 py-2 text-sm">{p.observacion ?? '—'}</td>
                        <td className="px-4 py-2 text-xs">{p.registradoPorNombre}</td>
                        <td className="px-4 py-2 text-center">
                          {/* Un pago puede nacer sin comprobante: la transferencia se ordena antes de
                              que el banco lo emita. Se dice, no se ofrece un enlace roto. */}
                          <SoporteDeLinea soporteId={p.soporteId}
                            etiqueta={`Abrir el soporte del pago del ${fechaDia(p.fecha)}`} />
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

      {pagando && codigo && (
        <ModalPagoOrganismo codigo={codigo} nombre={nombre}
          onClose={() => setPagando(false)}
          onHecho={() => { setPagando(false); recargar(); }} />
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

function ModalPagoOrganismo({ codigo, nombre, onClose, onHecho }: {
  codigo: string; nombre: string; onClose: () => void; onHecho: () => void;
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
      // Opcional, a diferencia de la recarga: un pago se registra el día en que se ordena la
      // transferencia, que suele ser antes de que llegue el comprobante del banco.
      if (archivo) form.append('soporte', archivo);
      const r = await api.post<{ id: string; saldoPendiente: number }>(
        `/flito/bolsas/organismos/${codigo}/pagos`, form,
      );
      toast.success(`Pago registrado. Pendiente con ${nombre}: ${pesos(r.saldoPendiente)}.`);
      onHecho();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <FlitModal title={`Registrar un pago a ${nombre}`} onClose={onClose} wide>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); guardar(); }}>
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          Este pago reduce lo que FLIT le debe al organismo. No mueve el saldo de ninguna bolsa.
        </p>

        <Campo etiqueta="Valor del pago *"
          error={valor.trim() !== '' && valorInvalido ? 'El valor del pago debe ser mayor que cero.' : null}>
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
          <FlitUploadBox label={archivo ? archivo.name : 'Soporte del pago (opcional)'}
            state={archivo ? 'verified' : 'idle'} count={1} onFile={setArchivo} />
          <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            Se puede registrar sin comprobante y adjuntarlo después: la transferencia se ordena antes
            de que el banco lo emita.
          </p>
        </div>

        {error && <p className="text-sm" style={{ color: 'var(--flit-danger)' }}>{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={!puedeGuardar}>
            {enviando ? 'Registrando…' : 'Registrar pago'}
          </button>
        </div>
      </form>
    </FlitModal>
  );
}
