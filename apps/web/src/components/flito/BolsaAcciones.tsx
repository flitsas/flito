// Recargas, movimientos manuales, correcciones y cierre de periodo (HU #11129).
//
// Las tres acciones que mueven dinero viven juntas porque comparten las mismas dos reglas: nada se
// registra sin evidencia, y nada se registra dos veces. La primera la impone el backend (el soporte
// es obligatorio); la segunda es responsabilidad de esta pantalla y se explica en `ModalRecarga`.

import { useState } from 'react';
import toast from 'react-hot-toast';
import {
  ConceptoBolsa, CONCEPTO_BOLSA_LABEL, TipoMovimientoBolsa, OrigenMovimientoBolsa,
  type CierreDto, type MovimientoBolsaDto, type RespuestaMovimiento, type RespuestaRecarga,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../../lib/api';
import { descargarCsv, etiquetaPeriodo, fechaHora, hoyColombia, pesos } from '../../lib/bolsas';
import Campo from './BolsaCampo';
import FlitModal from '../flit/FlitModal';
import FlitOrganismoCombobox from '../flit/FlitOrganismoCombobox';
import FlitUploadBox from '../flit/FlitUploadBox';
import StatusChip from '../flit/StatusChip';
import {
  FlitCard, FlitEmpty, FlitTable, FlitTh, FlitTr, flitInp,
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../flit/flitPageKit';

type Accion = 'recarga' | 'manual' | 'correccion' | 'cierre' | null;

interface Props {
  companiaId: number;
  companiaNombre: string;
  periodo: string;
  /** El periodo ya tiene cierre. Es irreversible: no hay endpoint para reabrirlo. */
  periodoCerrado: boolean;
  cierres: CierreDto[];
  /** Libro del periodo elegido. Alimenta el resumen del cierre y la lista de corregibles. */
  movimientos: MovimientoBolsaDto[];
  saldoActual: number;
  onHecho: () => void;
}

export default function BolsaAcciones({
  companiaId, companiaNombre, periodo, periodoCerrado, cierres, movimientos, saldoActual, onHecho,
}: Props) {
  const [accion, setAccion] = useState<Accion>(null);
  const cierre = cierres.find((c) => c.periodo === periodo) ?? null;

  const cerrar = () => setAccion(null);
  /** Cierra el modal Y refresca. Los dos modales que enseñan un resultado no lo usan: ver abajo. */
  const hecho = () => { setAccion(null); onHecho(); };

  return (
    <>
      <FlitCard>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
            disabled={periodoCerrado} onClick={() => setAccion('recarga')}>
            Registrar una recarga
          </button>
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
            disabled={periodoCerrado} onClick={() => setAccion('manual')}>
            Movimiento manual
          </button>
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
            disabled={periodoCerrado} onClick={() => setAccion('correccion')}>
            Corregir un movimiento
          </button>
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
            disabled={periodoCerrado} onClick={() => setAccion('cierre')}>
            Cerrar {etiquetaPeriodo(periodo)}
          </button>

          {periodoCerrado && cierre && (
            <span className="flex flex-wrap items-center gap-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
              <StatusChip tone="neutral">Periodo cerrado</StatusChip>
              {/* Por qué están apagados los botones, sin obligar a pasar el ratón por encima. */}
              <span>
                Cerrado por {cierre.cerradoPorNombre} el {fechaHora(cierre.cerradoEn)}. Un cierre no se
                reabre: lo que haya que corregir se ajusta en el periodo abierto.
              </span>
              <button type="button" className="underline" style={{ color: 'var(--flit-blue-text)' }}
                onClick={() => descargarReporteCierre(companiaNombre, cierre)}>
                Descargar el reporte
              </button>
            </span>
          )}
        </div>
      </FlitCard>

      {cierres.length > 0 && <HistorialCierres cierres={cierres} companiaNombre={companiaNombre} />}

      {/* Recarga y cierre reciben `onRefrescar` en vez de `onHecho`: los dos tienen una pantalla de
          resultado —el duplicado y el reporte sellado— y cerrarlos al terminar la petición la haría
          desaparecer antes de que nadie la lea. Cierran cuando lo diga el usuario. */}
      {accion === 'recarga' && (
        <ModalRecarga companiaId={companiaId} onClose={cerrar} onRefrescar={onHecho} />
      )}
      {accion === 'manual' && (
        <ModalManual companiaId={companiaId} onClose={cerrar} onHecho={hecho} />
      )}
      {accion === 'correccion' && (
        <ModalCorreccion companiaId={companiaId} movimientos={movimientos} onClose={cerrar} onHecho={hecho} />
      )}
      {accion === 'cierre' && (
        <ModalCierre companiaId={companiaId} companiaNombre={companiaNombre} periodo={periodo}
          movimientos={movimientos} saldoActual={saldoActual} onClose={cerrar} onRefrescar={onHecho} />
      )}
    </>
  );
}

// ─────────────────────────────── Recarga ─────────────────────────────────────

/**
 * Clave de idempotencia del formulario.
 *
 * `randomUUID` no existe fuera de un contexto seguro (http:// que no sea localhost). El respaldo no
 * pretende ser criptográfico: solo tiene que ser distinto entre dos aperturas del mismo formulario,
 * que es lo único que protege esta clave.
 */
function nuevaClave(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `bolsa-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function ModalRecarga({ companiaId, onClose, onRefrescar }: {
  companiaId: number; onClose: () => void; onRefrescar: () => void;
}) {
  /**
   * La clave se acuña AL ABRIR el formulario y no al pulsar guardar.
   *
   * Generarla en el clic no protege de nada: un doble clic produciría dos claves distintas y el
   * libro —que es append-only— acreditaría el dinero dos veces. Acuñada al abrir, el segundo envío
   * llega con la misma clave y el servidor devuelve el movimiento original con `duplicado: true`.
   * Se conserva en los reintentos por error de red, y muere con el modal.
   */
  const [clave] = useState(nuevaClave);
  const [valor, setValor] = useState('');
  const [fecha, setFecha] = useState(hoyColombia);
  const [observacion, setObservacion] = useState('');
  const [archivo, setArchivo] = useState<File | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicado, setDuplicado] = useState<RespuestaRecarga | null>(null);

  const valorNum = Number(valor);
  const valorInvalido = valor.trim() === '' || !Number.isFinite(valorNum) || valorNum <= 0;
  const puedeGuardar = !valorInvalido && archivo !== null && !enviando;

  async function guardar() {
    if (!puedeGuardar || !archivo) return;
    setEnviando(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('valor', String(valorNum));
      form.append('fecha', fecha);
      if (observacion.trim()) form.append('observacion', observacion.trim());
      form.append('soporte', archivo);
      const r = await api.post<RespuestaRecarga>(
        `/flito/bolsas/${companiaId}/recargas`, form, { 'Idempotency-Key': clave },
      );

      if (r.duplicado) {
        // El servidor no acreditó nada: este envío repetía una clave ya vista. Se enseña el
        // movimiento ORIGINAL y NO se anuncia un registro nuevo, que es justo lo que haría creer
        // que el dinero entró dos veces.
        setDuplicado(r);
        onRefrescar();
        return;
      }
      toast.success(`Recarga de ${pesos(r.movimiento.valor)} registrada. Saldo: ${pesos(r.saldo)}.`);
      onRefrescar();
      onClose();
    } catch (e) {
      // El mensaje del servidor tal cual (AC5): 403 y 409 dicen algo que la pantalla no sabe.
      setError(errorMessage(e));
    } finally {
      setEnviando(false);
    }
  }

  if (duplicado) {
    return (
      <FlitModal title="Esta recarga ya estaba registrada" onClose={onClose} wide>
        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          El envío repetía una recarga que ya se había asentado, así que <strong>no se sumó nada al
          saldo</strong>. Este es el movimiento original:
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
          <dt style={{ color: 'var(--flit-text-muted)' }}>Valor</dt>
          <dd className="font-semibold tabular-nums">{pesos(duplicado.movimiento.valor)}</dd>
          <dt style={{ color: 'var(--flit-text-muted)' }}>Registrado por</dt>
          <dd>{duplicado.movimiento.registradoPorNombre}</dd>
          <dt style={{ color: 'var(--flit-text-muted)' }}>Saldo de la bolsa</dt>
          <dd className="font-semibold tabular-nums">{pesos(duplicado.saldo)}</dd>
        </dl>
        <div className="mt-5 flex justify-end">
          <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={onClose}>
            Entendido
          </button>
        </div>
      </FlitModal>
    );
  }

  return (
    <FlitModal title="Registrar una recarga" onClose={onClose} wide>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); guardar(); }}>
        <Campo etiqueta="Valor de la recarga *"
          error={valor.trim() !== '' && valorInvalido ? 'El valor de la recarga debe ser mayor que cero.' : null}>
          <input type="number" min="1" step="1" className={flitInp} value={valor} required
            onChange={(e) => setValor(e.target.value)} placeholder="Ej. 5000000" />
        </Campo>

        <Campo etiqueta="Fecha" ayuda="Determina el periodo contable al que se imputa la entrada.">
          <input type="date" className={flitInp} value={fecha} onChange={(e) => setFecha(e.target.value)} />
        </Campo>

        <Campo etiqueta="Observación">
          <input type="text" className={flitInp} value={observacion} maxLength={1000}
            onChange={(e) => setObservacion(e.target.value)} placeholder="Ej. transferencia Bancolombia 12345" />
        </Campo>

        <div>
          <FlitUploadBox label={archivo ? archivo.name : 'Comprobante de la transferencia (PDF o imagen)'}
            required state={archivo ? 'verified' : 'idle'} count={1} onFile={setArchivo} />
          {archivo === null && (
            <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
              Una entrada de dinero sin comprobante no es auditable: el soporte es obligatorio.
            </p>
          )}
        </div>

        {error && <p className="text-sm" style={{ color: 'var(--flit-danger)' }}>{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={!puedeGuardar}>
            {enviando ? 'Registrando…' : 'Registrar recarga'}
          </button>
        </div>
      </form>
    </FlitModal>
  );
}

// ──────────────────────── Movimiento manual ──────────────────────────────────

function ModalManual({ companiaId, onClose, onHecho }: {
  companiaId: number; onClose: () => void; onHecho: () => void;
}) {
  const [tipo, setTipo] = useState<TipoMovimientoBolsa>(TipoMovimientoBolsa.SALIDA);
  const [valor, setValor] = useState('');
  const [motivo, setMotivo] = useState('');
  const [fecha, setFecha] = useState(hoyColombia);
  const [concepto, setConcepto] = useState<string>('');
  const [organismo, setOrganismo] = useState('');
  const [archivo, setArchivo] = useState<File | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valorNum = Number(valor);
  const valorInvalido = valor.trim() === '' || !Number.isFinite(valorNum) || valorNum <= 0;
  // El mismo mínimo que valida el backend: enterarse del límite después de enviar es peor que verlo.
  const motivoInvalido = motivo.trim().length < 5;
  const puedeGuardar = !valorInvalido && !motivoInvalido && archivo !== null && !enviando;

  async function guardar() {
    if (!puedeGuardar || !archivo) return;
    setEnviando(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('tipo', tipo);
      form.append('valor', String(valorNum));
      form.append('motivo', motivo.trim());
      form.append('fecha', fecha);
      if (concepto) form.append('concepto', concepto);
      if (organismo) form.append('organismoCodigo', organismo);
      form.append('soporte', archivo);
      const r = await api.post<RespuestaMovimiento>(`/flito/bolsas/${companiaId}/movimientos-manuales`, form);
      toast.success(`Movimiento manual registrado. Saldo: ${pesos(r.saldo)}.`);
      onHecho();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <FlitModal title="Registrar un movimiento manual" onClose={onClose} wide>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); guardar(); }}>
        <fieldset>
          <legend className="mb-1 text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            Tipo de movimiento *
          </legend>
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" name="tipo-manual" value={TipoMovimientoBolsa.SALIDA}
                checked={tipo === TipoMovimientoBolsa.SALIDA}
                onChange={() => setTipo(TipoMovimientoBolsa.SALIDA)} />
              Salida (descuenta saldo)
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="tipo-manual" value={TipoMovimientoBolsa.ENTRADA}
                checked={tipo === TipoMovimientoBolsa.ENTRADA}
                onChange={() => setTipo(TipoMovimientoBolsa.ENTRADA)} />
              Entrada (suma saldo)
            </label>
          </div>
        </fieldset>

        <Campo etiqueta="Valor *"
          error={valor.trim() !== '' && valorInvalido ? 'El valor del movimiento debe ser mayor que cero.' : null}>
          <input type="number" min="1" step="1" className={flitInp} value={valor} required
            onChange={(e) => setValor(e.target.value)} />
        </Campo>

        <Campo etiqueta="Motivo *"
          error={motivo.trim() !== '' && motivoInvalido ? 'Indica el motivo del movimiento (al menos 5 caracteres).' : null}>
          <input type="text" className={flitInp} value={motivo} required maxLength={1000}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="Por qué se registra a mano este ajuste" />
        </Campo>

        <div className="grid gap-4 sm:grid-cols-2">
          <Campo etiqueta="Fecha">
            <input type="date" className={flitInp} value={fecha} onChange={(e) => setFecha(e.target.value)} />
          </Campo>
          <Campo etiqueta="Concepto">
            <select className={flitInp} value={concepto} onChange={(e) => setConcepto(e.target.value)}>
              <option value="">Sin concepto</option>
              {Object.values(ConceptoBolsa).map((c) => (
                <option key={c} value={c}>{CONCEPTO_BOLSA_LABEL[c]}</option>
              ))}
            </select>
          </Campo>
        </div>

        <div>
          <span className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            Organismo de tránsito
          </span>
          <FlitOrganismoCombobox value={organismo} onChange={setOrganismo} allowEmpty
            emptyLabel="Sin organismo" aria-label="Organismo de tránsito del movimiento" />
        </div>

        <div>
          <FlitUploadBox label={archivo ? archivo.name : 'Evidencia del ajuste (PDF o imagen)'}
            required state={archivo ? 'verified' : 'idle'} count={1} onFile={setArchivo} />
          {archivo === null && (
            <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
              Un movimiento que decide una persona sin dejar respaldo no es auditable.
            </p>
          )}
        </div>

        {error && <p className="text-sm" style={{ color: 'var(--flit-danger)' }}>{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={!puedeGuardar}>
            {enviando ? 'Registrando…' : 'Registrar movimiento'}
          </button>
        </div>
      </form>
    </FlitModal>
  );
}

// ─────────────────────────── Corrección ──────────────────────────────────────

function ModalCorreccion({ companiaId, movimientos, onClose, onHecho }: {
  companiaId: number; movimientos: MovimientoBolsaDto[]; onClose: () => void; onHecho: () => void;
}) {
  // Solo los manuales: un movimiento automático nace del sellado de una liquidación y el backend
  // rechaza corregirlo (409). Ofrecerlo aquí sería invitar a un error que solo se ve al enviar.
  const corregibles = movimientos.filter((m) => m.origen === OrigenMovimientoBolsa.MANUAL);
  const [movimientoId, setMovimientoId] = useState('');
  const [valor, setValor] = useState('');
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valorNum = Number(valor);
  const valorInvalido = valor.trim() === '' || !Number.isFinite(valorNum) || valorNum <= 0;
  const motivoInvalido = motivo.trim().length < 5;
  const puedeGuardar = movimientoId !== '' && !valorInvalido && !motivoInvalido && !enviando;

  async function guardar() {
    if (!puedeGuardar) return;
    setEnviando(true);
    setError(null);
    try {
      const r = await api.post<RespuestaMovimiento>(
        `/flito/bolsas/${companiaId}/movimientos/${movimientoId}/correccion`,
        { valor: valorNum, motivo: motivo.trim() },
      );
      toast.success(`Corrección asentada. Saldo: ${pesos(r.saldo)}.`);
      onHecho();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <FlitModal title="Corregir un movimiento manual" onClose={onClose} wide>
      {corregibles.length === 0 ? (
        <FlitEmpty>
          No hay movimientos manuales en este periodo. Las salidas automáticas se corrigen con un
          movimiento manual suelto, no editando la fila que generó la liquidación.
        </FlitEmpty>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); guardar(); }}>
          <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            La fila original no se toca: se asienta un ajuste que la referencia, de forma que el libro
            sigue contando lo que pasó de verdad.
          </p>
          <Campo etiqueta="Movimiento a corregir *">
            <select className={flitInp} value={movimientoId} required
              onChange={(e) => setMovimientoId(e.target.value)}>
              <option value="">Elige un movimiento…</option>
              {corregibles.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.fecha.slice(0, 10)} · {m.tipo === TipoMovimientoBolsa.ENTRADA ? 'Entrada' : 'Salida'} de {pesos(m.valor)}
                  {m.observacion ? ` · ${m.observacion.slice(0, 40)}` : ''}
                </option>
              ))}
            </select>
          </Campo>

          <Campo etiqueta="Valor corregido *"
            error={valor.trim() !== '' && valorInvalido ? 'El valor corregido debe ser mayor que cero.' : null}>
            <input type="number" min="1" step="1" className={flitInp} value={valor} required
              onChange={(e) => setValor(e.target.value)} />
          </Campo>

          <Campo etiqueta="Motivo *"
            error={motivo.trim() !== '' && motivoInvalido ? 'Indica el motivo del movimiento (al menos 5 caracteres).' : null}>
            <input type="text" className={flitInp} value={motivo} required maxLength={1000}
              onChange={(e) => setMotivo(e.target.value)} />
          </Campo>

          {error && <p className="text-sm" style={{ color: 'var(--flit-danger)' }}>{error}</p>}

          <div className="flex justify-end gap-2">
            <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={!puedeGuardar}>
              {enviando ? 'Asentando…' : 'Asentar corrección'}
            </button>
          </div>
        </form>
      )}
    </FlitModal>
  );
}

// ───────────────────────────── Cierre ────────────────────────────────────────

function ModalCierre({ companiaId, companiaNombre, periodo, movimientos, saldoActual, onClose, onRefrescar }: {
  companiaId: number; companiaNombre: string; periodo: string;
  movimientos: MovimientoBolsaDto[]; saldoActual: number; onClose: () => void; onRefrescar: () => void;
}) {
  const [observaciones, setObservaciones] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cerrado, setCerrado] = useState<CierreDto | null>(null);

  const entradas = movimientos.filter((m) => m.tipo === TipoMovimientoBolsa.ENTRADA).reduce((s, m) => s + m.valor, 0);
  const salidas = movimientos.filter((m) => m.tipo === TipoMovimientoBolsa.SALIDA).reduce((s, m) => s + m.valor, 0);

  async function cerrarPeriodo() {
    setEnviando(true);
    setError(null);
    try {
      const c = await api.post<CierreDto>(`/flito/bolsas/${companiaId}/cierres`, {
        periodo,
        ...(observaciones.trim() ? { observaciones: observaciones.trim() } : {}),
      });
      setCerrado(c);
      onRefrescar();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setEnviando(false);
    }
  }

  // Tras cerrar se enseñan las cifras SELLADAS por el servidor, no las que se calcularon aquí: el
  // reporte que queda para auditoría es el suyo.
  if (cerrado) {
    return (
      <FlitModal title={`${etiquetaPeriodo(periodo)} cerrado`} onClose={onClose} wide>
        <ResumenCierre saldoInicial={cerrado.saldoInicial} entradas={cerrado.totalEntradas}
          salidas={cerrado.totalSalidas} saldoFinal={cerrado.saldoFinal} movimientos={cerrado.movimientos} />
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
            onClick={() => descargarReporteCierre(companiaNombre, cerrado)}>
            Descargar el reporte de cierre
          </button>
          <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={onClose}>
            Volver a la bolsa
          </button>
        </div>
      </FlitModal>
    );
  }

  return (
    <FlitModal title={`Cerrar ${etiquetaPeriodo(periodo)}`} onClose={onClose} wide>
      <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
        Vas a cerrar el periodo de <strong>{companiaNombre}</strong>. El cierre congela sus movimientos
        y sella el reporte: <strong>no hay forma de reabrirlo</strong>. Lo que aparezca después se
        ajusta en el periodo siguiente.
      </p>

      <div className="mt-4">
        <ResumenCierre entradas={entradas} salidas={salidas} saldoFinal={saldoActual}
          movimientos={movimientos.length} />
      </div>

      <div className="mt-4">
        <Campo etiqueta="Observaciones del cierre">
          <input type="text" className={flitInp} value={observaciones} maxLength={2000}
            onChange={(e) => setObservaciones(e.target.value)} placeholder="Opcional" />
        </Campo>
      </div>

      {error && <p className="mt-3 text-sm" style={{ color: 'var(--flit-danger)' }}>{error}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>
          Cancelar
        </button>
        <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
          disabled={enviando} onClick={cerrarPeriodo}>
          {enviando ? 'Cerrando…' : 'Confirmar el cierre'}
        </button>
      </div>
    </FlitModal>
  );
}

function ResumenCierre({ saldoInicial, entradas, salidas, saldoFinal, movimientos }: {
  saldoInicial?: number; entradas: number; salidas: number; saldoFinal: number; movimientos: number;
}) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border p-4 text-sm"
      style={{ borderColor: 'var(--flit-border-soft)' }}>
      {saldoInicial !== undefined && (
        <>
          <dt style={{ color: 'var(--flit-text-muted)' }}>Saldo inicial</dt>
          <dd className="text-right tabular-nums">{pesos(saldoInicial)}</dd>
        </>
      )}
      <dt style={{ color: 'var(--flit-text-muted)' }}>Entradas</dt>
      <dd className="text-right font-semibold tabular-nums" style={{ color: 'var(--flit-success)' }}>
        {pesos(entradas)}
      </dd>
      <dt style={{ color: 'var(--flit-text-muted)' }}>Salidas</dt>
      <dd className="text-right font-semibold tabular-nums" style={{ color: 'var(--flit-warning)' }}>
        {pesos(salidas)}
      </dd>
      <dt style={{ color: 'var(--flit-text-muted)' }}>Movimientos</dt>
      <dd className="text-right tabular-nums">{movimientos}</dd>
      <dt className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Saldo final</dt>
      <dd className="text-right text-base font-bold tabular-nums" style={{ color: 'var(--flit-blue-text)' }}>
        {pesos(saldoFinal)}
      </dd>
    </dl>
  );
}

function HistorialCierres({ cierres, companiaNombre }: { cierres: CierreDto[]; companiaNombre: string }) {
  return (
    <FlitCard>
      <h3 className="mb-3 text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>
        Periodos cerrados ({cierres.length})
      </h3>
      <FlitTable>
        <thead>
          <tr>
            <FlitTh>Periodo</FlitTh>
            <FlitTh center>Saldo inicial</FlitTh>
            <FlitTh center>Entradas</FlitTh>
            <FlitTh center>Salidas</FlitTh>
            <FlitTh center>Saldo final</FlitTh>
            <FlitTh>Cerrado por</FlitTh>
            <FlitTh center>Reporte</FlitTh>
          </tr>
        </thead>
        <tbody>
          {cierres.map((c) => (
            <FlitTr key={c.id}>
              <td className="px-4 py-2 text-sm font-medium">{etiquetaPeriodo(c.periodo)}</td>
              <td className="px-4 py-2 text-right text-sm tabular-nums">{pesos(c.saldoInicial)}</td>
              <td className="px-4 py-2 text-right text-sm tabular-nums" style={{ color: 'var(--flit-success)' }}>
                {pesos(c.totalEntradas)}
              </td>
              <td className="px-4 py-2 text-right text-sm tabular-nums" style={{ color: 'var(--flit-warning)' }}>
                {pesos(c.totalSalidas)}
              </td>
              <td className="px-4 py-2 text-right text-sm font-semibold tabular-nums">{pesos(c.saldoFinal)}</td>
              <td className="px-4 py-2 text-xs">
                <div>{c.cerradoPorNombre}</div>
                <div style={{ color: 'var(--flit-text-muted)' }}>{fechaHora(c.cerradoEn)}</div>
              </td>
              <td className="px-4 py-2 text-center">
                <button type="button" className="text-xs font-semibold underline"
                  style={{ color: 'var(--flit-blue)' }}
                  aria-label={`Descargar el reporte de cierre de ${etiquetaPeriodo(c.periodo)}`}
                  onClick={() => descargarReporteCierre(companiaNombre, c)}>
                  Descargar
                </button>
              </td>
            </FlitTr>
          ))}
        </tbody>
      </FlitTable>
    </FlitCard>
  );
}

/**
 * Reporte de cierre descargable (AC4).
 *
 * Se arma con las cifras SELLADAS que devolvió el servidor, no recalculando el libro: el documento
 * de auditoría tiene que decir lo mismo que la fila de `flito_bolsa_cierres`, pase lo que pase
 * después en la bolsa.
 */
function descargarReporteCierre(companiaNombre: string, c: CierreDto): void {
  descargarCsv(
    `cierre-${c.periodo}-${companiaNombre.replace(/[^\w-]+/g, '_')}.csv`,
    ['Cliente', 'Periodo', 'Saldo inicial', 'Entradas', 'Salidas', 'Saldo final', 'Movimientos',
      'Observaciones', 'Cerrado por', 'Cerrado el'],
    [[
      companiaNombre, c.periodo, pesos(c.saldoInicial), pesos(c.totalEntradas), pesos(c.totalSalidas),
      pesos(c.saldoFinal), String(c.movimientos), c.observaciones ?? '', c.cerradoPorNombre,
      fechaHora(c.cerradoEn),
    ]],
  );
}
