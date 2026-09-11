// FLITO — Tarifas · la matriz del cliente elegido (HU #12375). Diseño: `docs/ux/flito-configurador-tarifas.md` §6.
//
// Cuatro filas fijas —Matrícula, Traspaso, Otros, Logística— con el valor vigente, desde cuándo y
// quién. La edición es EN SITIO y de una fila a la vez: mientras una tiene el `<input>`, los botones
// de las otras tres se apagan. «Guardar» de esa fila es la única primaria de la pantalla.
//
// Lo que la fila NO pinta a propósito: el id de la vigencia (va en `data-vigencia`), el valor
// anterior (va al toast, leído de la RESPUESTA y no del estado), y ningún «Eliminar»/«Inactiva»
// (RN-04: una vigencia se cierra, no se borra).

import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import toast from 'react-hot-toast';
import { api, ApiError } from '../../lib/api';
import {
  RUTA_TARIFAS, claveLlave, etiquetaLlave, fechaCorta, nombreUsuario, pesosTarifa, validarValorTarifa,
  type FilaVistaTarifa, type ResultadoCambioTarifa, type VistaTarifasCompania,
} from '../../lib/tarifas';
import FlitModal from '../../components/flit/FlitModal';
import StatusChip from '../../components/flit/StatusChip';
import {
  flitInp, FlitTable, FlitTh, FlitTr, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
  flitBtnSecondarySm,
} from '../../components/flit/flitPageKit';

const SIN_CONFIGURAR = 'Sin configurar';
const NOTA_PIE = 'Un valor rige para los trámites que se aprueben desde su fecha. Lo ya liquidado no cambia.';
const MSG_409 = 'Alguien cambió este valor hace un momento. La fila ya está actualizada: revísala y vuelve a intentarlo.';
const MSG_FALLO = 'No se pudo guardar. El valor que escribiste sigue aquí; vuelve a intentarlo.';

interface Edicion {
  clave: string;
  texto: string;
  /** Mensaje de validación o del 400 del servidor; se pinta bajo el campo. */
  error: string | null;
  /** Fallo de red o 500: la fila queda en edición con lo escrito. */
  fallo: string | null;
  /** Solo se enseña el error de validación tras intentar guardar o perder el foco. */
  tocado: boolean;
  guardando: boolean;
}

interface Props {
  vista: VistaTarifasCompania;
  /** La vista se está repidiendo tras una escritura: los controles se apagan sin desmontar la tabla. */
  refrescando: boolean;
  onGuardado: () => void;
  onHistorial: (fila: FilaVistaTarifa) => void;
  /** Para que la página pida `confirm` antes de cambiar de cliente con una fila abierta. */
  onEdicionCambia: (fila: FilaVistaTarifa | null) => void;
}

const celdaTexto = 'px-4 py-3 text-sm align-top';

export default function MatrizTarifas({ vista, refrescando, onGuardado, onHistorial, onEdicionCambia }: Props) {
  const { companiaNombre, capacidades } = vista;
  const [edicion, setEdicion] = useState<Edicion | null>(null);
  const [modalCero, setModalCero] = useState<{ fila: FilaVistaTarifa; valor: number } | null>(null);
  const [cerrarDe, setCerrarDe] = useState<FilaVistaTarifa | null>(null);
  const [alerta, setAlerta] = useState<string | null>(null);
  // El botón «Cambiar»/«Fijar valor» de cada fila, para devolverle el foco al salir de la edición;
  // y el `<th>` de cada fila, para el modal de dejar de cobrar (su botón desaparece al confirmar).
  const botones = useRef(new Map<string, HTMLButtonElement>());
  const cabeceras = useRef(new Map<string, HTMLTableCellElement>());
  const input = useRef<HTMLInputElement>(null);
  const [focoPendiente, setFocoPendiente] = useState<string | null>(null);

  const filaEnEdicion = edicion ? vista.tarifas.find((f) => claveLlave(f) === edicion.clave) ?? null : null;
  useEffect(() => { onEdicionCambia(filaEnEdicion); }, [filaEnEdicion, onEdicionCambia]);
  // Al cambiar de cliente, lo que hubiera en edición ya no es de nadie.
  useEffect(() => { setEdicion(null); setAlerta(null); }, [vista.companiaId]);

  useEffect(() => {
    if (focoPendiente === null || refrescando) return;
    botones.current.get(focoPendiente)?.focus();
    setFocoPendiente(null);
  }, [focoPendiente, refrescando, vista]);

  const abrir = (fila: FilaVistaTarifa) => {
    setAlerta(null);
    setEdicion({
      clave: claveLlave(fila), texto: fila.valor === null ? '' : String(fila.valor),
      error: null, fallo: null, tocado: false, guardando: false,
    });
    // El foco entra al campo cuando exista; con el valor preescrito y seleccionado (§6.6).
    requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
  };

  const cancelar = () => {
    if (!edicion) return;
    const clave = edicion.clave;
    setEdicion(null);
    setFocoPendiente(clave);
  };

  const sujeto = (fila: FilaVistaTarifa) => `${etiquetaLlave(fila)} de ${companiaNombre}`;

  const guardar = async (fila: FilaVistaTarifa, valor: number, confirmarCero: boolean) => {
    setEdicion((e) => (e ? { ...e, guardando: true, error: null, fallo: null } : e));
    try {
      let antes: string;
      let despues: string;
      if (fila.vigenciaId) {
        const r = await api.patch<ResultadoCambioTarifa>(`${RUTA_TARIFAS}/${fila.vigenciaId}`,
          confirmarCero ? { valor, confirmarCero: true } : { valor });
        if (r.valorNuevo === r.valorAnterior) {
          toast('Ese ya era el valor vigente. No hay nada que guardar.', { duration: 6000 });
          setEdicion(null); setFocoPendiente(claveLlave(fila)); onGuardado();
          return;
        }
        antes = pesosTarifa(r.valorAnterior);
        despues = r.valorNuevo === null ? SIN_CONFIGURAR : pesosTarifa(r.valorNuevo);
      } else {
        const cuerpo: Record<string, unknown> = { companiaId: vista.companiaId, concepto: fila.concepto, valor };
        // `tipoTramite` SOLO en trámite digital: en logística la clave se omite (RN-03).
        if (fila.concepto === 'tramite_digital') cuerpo.tipoTramite = fila.tipoTramite;
        if (confirmarCero) cuerpo.confirmarCero = true;
        const t = await api.post<{ valor: number }>(RUTA_TARIFAS, cuerpo);
        antes = SIN_CONFIGURAR;
        despues = pesosTarifa(t.valor);
      }
      toast.success(`${sujeto(fila)}: ${antes} → ${despues}. Rige desde ahora.`, { duration: 6000 });
      setEdicion(null);
      setFocoPendiente(claveLlave(fila));
      onGuardado();
    } catch (err) {
      const e = err instanceof ApiError ? err : null;
      const cuerpo = (e?.rawDetails ?? null) as { requiereConfirmacion?: string } | null;
      if (e?.status === 400 && cuerpo?.requiereConfirmacion === 'cero') {
        setEdicion((x) => (x ? { ...x, guardando: false } : x));
        setModalCero({ fila, valor });
      } else if (e?.status === 400) {
        // El texto del servidor tal cual, en el campo (AC6). La fila sigue en edición.
        setEdicion((x) => (x ? { ...x, guardando: false, error: e.message, tocado: true } : x));
        requestAnimationFrame(() => input.current?.focus());
      } else if (e?.status === 409) {
        setEdicion(null);
        setAlerta(MSG_409);
        onGuardado();
      } else {
        setEdicion((x) => (x ? { ...x, guardando: false, fallo: `${MSG_FALLO} ${e?.message ?? ''}`.trim() } : x));
      }
    }
  };

  const intentarGuardar = (fila: FilaVistaTarifa) => {
    if (!edicion || edicion.guardando) return;
    const v = validarValorTarifa(edicion.texto, fila.valor);
    if (!v.ok) {
      setEdicion({ ...edicion, error: v.mensaje, tocado: true });
      input.current?.focus();
      return;
    }
    if (v.valor === 0) { setModalCero({ fila, valor: 0 }); return; }
    void guardar(fila, v.valor, false);
  };

  const dejarDeCobrar = async (fila: FilaVistaTarifa) => {
    if (!fila.vigenciaId) return;
    try {
      const r = await api.patch<ResultadoCambioTarifa>(`${RUTA_TARIFAS}/${fila.vigenciaId}`, { activo: false });
      toast.success(`${sujeto(fila)}: ${pesosTarifa(r.valorAnterior)} → ${SIN_CONFIGURAR}.`, { duration: 6000 });
      setCerrarDe(null);
      onGuardado();
    } catch (err) {
      const e = err instanceof ApiError ? err : null;
      setCerrarDe(null);
      if (e?.status === 409) { setAlerta(MSG_409); onGuardado(); return; }
      toast.error(`No se pudo dejar de cobrar. ${e?.message ?? ''}`.trim());
    }
  };

  const bloqueado = refrescando || edicion !== null;
  const validacionVisible = edicion && edicion.tocado ? edicion.error : null;

  return (
    <>
      {alerta && (
        <p role="alert" className="mb-3 text-sm font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>{alerta}</p>
      )}
      <FlitTable label={`Valores de ${companiaNombre}`}>
        <thead>
          <FlitTr>
            <FlitTh>Trámite</FlitTh>
            <FlitTh>Valor vigente</FlitTh>
            <FlitTh>Desde</FlitTh>
            <FlitTh>Quién</FlitTh>
            <FlitTh />
          </FlitTr>
        </thead>
        <tbody>
          {vista.tarifas.map((fila, i) => {
            const clave = claveLlave(fila);
            const enEdicion = edicion?.clave === clave;
            const esLogistica = fila.concepto === 'logistica';
            const grupo = i === 0 ? 'Trámite digital' : esLogistica && vista.tarifas[i - 1]?.concepto !== 'logistica' ? 'Logística' : null;
            return (
              <FilaTarifa
                key={clave}
                grupo={grupo}
                fila={fila}
                sujeto={sujeto(fila)}
                editar={capacidades.editar}
                verHistorial={capacidades.verHistorial}
                enEdicion={enEdicion ? edicion : null}
                validacion={enEdicion ? validacionVisible : null}
                bloqueado={bloqueado}
                inputRef={input}
                registrarBoton={(el) => { if (el) botones.current.set(clave, el); else botones.current.delete(clave); }}
                registrarCabecera={(el) => { if (el) cabeceras.current.set(clave, el); else cabeceras.current.delete(clave); }}
                onTexto={(texto) => setEdicion((e) => (e ? { ...e, texto, error: null, fallo: null } : e))}
                onTocado={() => setEdicion((e) => {
                  if (!e) return e;
                  const v = validarValorTarifa(e.texto, fila.valor);
                  return { ...e, tocado: true, error: v.ok ? null : v.mensaje };
                })}
                onGuardar={() => intentarGuardar(fila)}
                onCancelar={cancelar}
                onAbrir={() => abrir(fila)}
                onHistorial={() => onHistorial(fila)}
                onDejarDeCobrar={() => setCerrarDe(fila)}
              />
            );
          })}
        </tbody>
      </FlitTable>
      <p className="mt-3 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{NOTA_PIE}</p>

      {modalCero && (
        <FlitModal
          title={`Cobrar cero por ${etiquetaLlave(modalCero.fila)}`}
          onClose={() => { setModalCero(null); requestAnimationFrame(() => input.current?.focus()); }}
        >
          <div className="space-y-3 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
            <p>
              {companiaNombre} pasará a pagar $0 por cada {etiquetaLlave(modalCero.fila).toLowerCase()} que se apruebe desde ahora.
            </p>
            <p style={{ color: 'var(--flit-text-secondary)' }}>
              Cero no es lo mismo que «Sin configurar»: con $0 el trámite se liquida y suma cero; sin configurar,
              no se puede liquidar. Si lo que quieres es no cobrar este trámite, usa «Dejar de cobrar».
            </p>
            <div className="flex flex-wrap justify-end gap-2 pt-1">
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                onClick={() => { setModalCero(null); requestAnimationFrame(() => input.current?.focus()); }}>
                Cancelar
              </button>
              <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
                onClick={() => { const m = modalCero; setModalCero(null); void guardar(m.fila, 0, true); }}>
                Cobrar $0
              </button>
            </div>
          </div>
        </FlitModal>
      )}

      {cerrarDe && (
        <ModalDejarDeCobrar
          fila={cerrarDe}
          companiaNombre={companiaNombre}
          restoreFocusRef={{ current: cabeceras.current.get(claveLlave(cerrarDe)) ?? null }}
          onClose={() => setCerrarDe(null)}
          onConfirmar={() => void dejarDeCobrar(cerrarDe)}
        />
      )}
    </>
  );
}

interface FilaProps {
  grupo: string | null;
  fila: FilaVistaTarifa;
  sujeto: string;
  editar: boolean;
  verHistorial: boolean;
  enEdicion: Edicion | null;
  validacion: string | null;
  bloqueado: boolean;
  inputRef: RefObject<HTMLInputElement>;
  registrarBoton: (el: HTMLButtonElement | null) => void;
  registrarCabecera: (el: HTMLTableCellElement | null) => void;
  onTexto: (t: string) => void;
  onTocado: () => void;
  onGuardar: () => void;
  onCancelar: () => void;
  onAbrir: () => void;
  onHistorial: () => void;
  onDejarDeCobrar: () => void;
}

function FilaTarifa(p: FilaProps) {
  const { fila, sujeto, enEdicion, validacion } = p;
  const idMensaje = useId();
  const etiqueta = etiquetaLlave(fila);
  const tieneValor = fila.valor !== null;
  const guardable = !!enEdicion && !enEdicion.guardando && validarValorTarifa(enEdicion.texto, fila.valor).ok;

  const teclas = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); if (guardable) p.onGuardar(); else p.onTocado(); }
    if (e.key === 'Escape') { e.preventDefault(); p.onCancelar(); }
  };

  const mensaje = enEdicion?.fallo ?? validacion;

  return (
    <>
      {p.grupo && (
        // Cabecera de grupo como TÍTULO y no como `<th scope="rowgroup">`: Chromium expone ese `th`
        // como `rowheader`, y la matriz dejaría de tener «exactamente cuatro» cabeceras de fila
        // (nota 1 de QA). Un encabezado de nivel 3 se navega igual y no se confunde con una fila.
        <tr className="border-t" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <td colSpan={5} className="px-4 pb-1 pt-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>{p.grupo}</h3>
          </td>
        </tr>
      )}
      <FlitTr>
        <th scope="row" tabIndex={-1} ref={p.registrarCabecera} data-vigencia={fila.vigenciaId ?? undefined}
          className={`${celdaTexto} flit-focus text-left font-medium`} style={{ color: 'var(--flit-text-primary)' }}>
          {etiqueta}
          {fila.concepto === 'logistica' && (
            <div className="mt-1">
              <StatusChip tone={fila.flitoGestionaLogistica ? 'active' : 'neutral'}>
                {fila.flitoGestionaLogistica ? 'Gestiona FLITO' : 'Autogestiona el cliente'}
              </StatusChip>
            </div>
          )}
        </th>
        <td className={`${celdaTexto} tabular-nums`} style={{ color: tieneValor ? 'var(--flit-text-primary)' : 'var(--flit-text-muted)' }}>
          {enEdicion ? (
            <div className="flex flex-col gap-1">
              <label htmlFor={`${idMensaje}-valor`} className="sr-only">Valor de {sujeto}</label>
              <div className="flex items-center gap-1">
                <span aria-hidden="true">$</span>
                <input
                  id={`${idMensaje}-valor`}
                  ref={p.inputRef}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  className={`${flitInp} w-40`}
                  value={enEdicion.texto}
                  aria-invalid={mensaje ? true : undefined}
                  aria-describedby={mensaje ? idMensaje : undefined}
                  disabled={enEdicion.guardando}
                  onChange={(e) => p.onTexto(e.target.value)}
                  onBlur={p.onTocado}
                  onKeyDown={teclas}
                />
              </div>
              {tieneValor && (
                <span className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>Antes: {pesosTarifa(fila.valor as number)}</span>
              )}
              {mensaje && (
                <p id={idMensaje} role="alert" className="text-xs font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>{mensaje}</p>
              )}
            </div>
          ) : tieneValor ? pesosTarifa(fila.valor as number) : SIN_CONFIGURAR}
        </td>
        <td className={celdaTexto} style={{ color: 'var(--flit-text-secondary)' }}>{tieneValor ? fechaCorta(fila.vigenteDesde) : '—'}</td>
        <td className={celdaTexto} style={{ color: 'var(--flit-text-secondary)' }}>{tieneValor ? nombreUsuario(fila.fijadoPor) : '—'}</td>
        <td className={celdaTexto}>
          <div className="flex flex-wrap justify-end gap-2">
            {enEdicion ? (
              <>
                <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={!guardable}
                  aria-label={`Guardar · ${sujeto}`} onClick={p.onGuardar}>
                  {enEdicion.guardando ? 'Guardando…' : 'Guardar'}
                </button>
                <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={enEdicion.guardando}
                  aria-label={`Cancelar · ${sujeto}`} onClick={p.onCancelar}>
                  Cancelar
                </button>
              </>
            ) : (
              <>
                {p.editar && (
                  <button type="button" ref={p.registrarBoton} className={flitBtnSecondarySm} style={flitBtnSecondaryStyle}
                    disabled={p.bloqueado} aria-label={`${tieneValor ? 'Cambiar' : 'Fijar valor'} · ${sujeto}`} onClick={p.onAbrir}>
                    {tieneValor ? 'Cambiar' : 'Fijar valor'}
                  </button>
                )}
                {p.verHistorial && (
                  <button type="button" className={flitBtnSecondarySm} style={flitBtnSecondaryStyle}
                    disabled={p.bloqueado} aria-label={`Historial · ${sujeto}`} onClick={p.onHistorial}>
                    Historial
                  </button>
                )}
                {p.editar && tieneValor && (
                  <button type="button" className={flitBtnSecondarySm} style={{ ...flitBtnSecondaryStyle, color: 'var(--flit-danger-ink)' }}
                    disabled={p.bloqueado} aria-label={`Dejar de cobrar · ${sujeto}`} onClick={p.onDejarDeCobrar}>
                    Dejar de cobrar
                  </button>
                )}
              </>
            )}
          </div>
        </td>
      </FlitTr>
    </>
  );
}

function ModalDejarDeCobrar({ fila, companiaNombre, restoreFocusRef, onClose, onConfirmar }: {
  fila: FilaVistaTarifa; companiaNombre: string; restoreFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void; onConfirmar: () => void;
}) {
  const [enviando, setEnviando] = useState(false);
  const etiqueta = etiquetaLlave(fila);
  const esLogistica = fila.concepto === 'logistica';
  return (
    <FlitModal title={`Dejar de cobrar ${esLogistica ? 'la logística' : etiqueta}`} onClose={onClose} restoreFocusRef={restoreFocusRef}>
      <div className="space-y-3 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
        <p>
          {companiaNombre} deja de tener valor de {etiqueta.toLowerCase()} desde ahora. La vigencia de {pesosTarifa(fila.valor ?? 0)} queda
          cerrada en el historial, con tu nombre y la hora.
        </p>
        <p style={{ color: 'var(--flit-text-secondary)' }}>
          {esLogistica ? 'Sus entregas nuevas' : 'Sus trámites nuevos de este tipo'} saldrán como «No configurado» en el reporte de costos y no se
          podrán liquidar hasta que se fije un valor otra vez. Lo ya liquidado no cambia.
        </p>
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose} disabled={enviando}>Cancelar</button>
          {/* Rojo y no gradiente: desde este clic los trámites dejan de poder liquidarse. Es la variante
              TINTA del rojo (`--flit-danger-ink`) y no la superficie: con texto blanco, `--flit-danger`
              se queda en 3,9:1 y axe lo marca como serio (misma lección del Bug #11604). */}
          <button type="button" className={flitBtnPrimary} style={{ background: 'var(--flit-danger-ink)' }} disabled={enviando}
            onClick={() => { setEnviando(true); onConfirmar(); }}>
            Dejar de cobrar
          </button>
        </div>
      </div>
    </FlitModal>
  );
}
