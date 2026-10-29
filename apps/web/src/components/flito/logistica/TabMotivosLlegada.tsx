// FLITO Logística — pestaña Motivos de llegada (HU #14120). Catálogo admin-only.
// GET al montar ESTA pestaña, nunca al montar la consola. Sin DELETE. Tono: usted.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { api, ApiError } from '../../../lib/api';
import { toastError, toastOk } from '../../flit/ToastFlito';
import FlitModal from '../../flit/FlitModal';
import { MenuFila } from '../../flit/MenuFila';
import {
  FlitCard, FlitTable, FlitTh, FlitTr, FlitEmpty, FlitField, flitInp,
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
  flitBtnSecondarySm, flitBtnIconoSm,
} from '../../flit/flitPageKit';
import {
  FiltroEstadoPills, ChipEstado, PieConteo, filtrarPorEstado, type FiltroEstado,
} from '../../clientes/EstadoRegistro';

/** DTO de HU #14119. Local: shared-types no lo exporta aún. */
export interface MotivoLlegada {
  id: string;
  nombre: string;
  activo: boolean;
  orden: number;
}

const COPY_409 =
  'Ya existe un motivo de llegada con ese nombre. Cambie el nombre o edite el que ya está en la lista.';
const COPY_VACIO = 'Escriba el nombre del motivo.';
const COPY_LARGO = 'El nombre admite máximo 120 caracteres.';
const COPY_GUARDAR = 'No pudimos guardar el motivo. Intente de nuevo.';
const COPY_ESTADO = 'No pudimos cambiar el estado. Intente de nuevo.';
const COPY_404 = 'Ese motivo ya no está. Recargamos la lista.';
const COPY_CARGA = 'No pudimos cargar los motivos de llegada.';
const COPY_403 = 'No tiene permiso para gestionar los motivos de llegada.';
const COPY_LISTA_VACIA = 'No hay motivos de llegada. Cree el primero con «Nuevo motivo».';

const MAX_NOMBRE = 120;
const PASO_ORDEN = 10;
const TOAST_ID = 'motivo-llegada';
const TOAST_ERR_ID = 'motivo-llegada-error';

type Carga = 'cargando' | 'ok' | 'error' | 'error403';
type ModalModo = { tipo: 'crear' } | { tipo: 'editar'; motivo: MotivoLlegada };
type DialogoEstado = { motivo: MotivoLlegada; activo: boolean };

function errorHttp(e: unknown): { status: number | null; message: string } {
  if (e instanceof ApiError) return { status: e.status, message: e.message };
  return { status: null, message: '' };
}

function validarNombre(raw: string): string | null {
  const nombre = raw.trim();
  if (!nombre) return COPY_VACIO;
  if (nombre.length > MAX_NOMBRE) return COPY_LARGO;
  return null;
}

function ordenadosDe(motivos: MotivoLlegada[]): MotivoLlegada[] {
  return [...motivos].sort((a, b) => a.orden - b.orden || a.nombre.localeCompare(b.nombre, 'es'));
}

export default function TabMotivosLlegada() {
  const [carga, setCarga] = useState<Carga>('cargando');
  const [motivos, setMotivos] = useState<MotivoLlegada[]>([]);
  const [filtro, setFiltro] = useState<FiltroEstado>('todos');
  const [modal, setModal] = useState<ModalModo | null>(null);
  const [dialogo, setDialogo] = useState<DialogoEstado | null>(null);
  const [nombre, setNombre] = useState('');
  const [errorNombre, setErrorNombre] = useState<string | null>(null);
  const [errorModal, setErrorModal] = useState<string | null>(null);
  const [errorDialogo, setErrorDialogo] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [reordenando, setReordenando] = useState<string | null>(null);

  const btnNuevoRef = useRef<HTMLButtonElement>(null);
  const btnEditarRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const restoreEditarRef = useRef<HTMLButtonElement | null>(null);
  const inputNombreRef = useRef<HTMLInputElement>(null);

  const cargar = useCallback(() => {
    setCarga('cargando');
    api.get<MotivoLlegada[]>('/flito/logistica/motivos-llegada')
      .then((lista) => {
        setMotivos(lista);
        setCarga('ok');
      })
      .catch((e) => {
        setMotivos([]);
        setCarga(errorHttp(e).status === 403 ? 'error403' : 'error');
      });
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  useEffect(() => {
    if (errorNombre) inputNombreRef.current?.focus();
  }, [errorNombre]);

  const ordenados = ordenadosDe(motivos);
  const visibles = filtrarPorEstado(ordenados, filtro, (m) => m.activo);

  const abrirCrear = () => {
    setNombre('');
    setErrorNombre(null);
    setErrorModal(null);
    setModal({ tipo: 'crear' });
  };

  const abrirEditar = (motivo: MotivoLlegada) => {
    restoreEditarRef.current = btnEditarRefs.current.get(motivo.id) ?? null;
    setNombre(motivo.nombre);
    setErrorNombre(null);
    setErrorModal(null);
    setModal({ tipo: 'editar', motivo });
  };

  const cerrarModal = () => {
    setModal(null);
    setNombre('');
    setErrorNombre(null);
    setErrorModal(null);
  };

  const recargarPor404 = () => {
    toastError(COPY_404, undefined, { id: TOAST_ERR_ID });
    cerrarModal();
    setDialogo(null);
    cargar();
  };

  const guardarModal = async () => {
    const fallo = validarNombre(nombre);
    if (fallo) {
      setErrorNombre(fallo);
      setErrorModal(null);
      return;
    }
    const recortado = nombre.trim();
    setGuardando(true);
    setErrorNombre(null);
    setErrorModal(null);
    try {
      if (modal?.tipo === 'crear') {
        const maxOrden = motivos.reduce((m, x) => Math.max(m, x.orden), 0);
        const orden = motivos.length === 0 ? PASO_ORDEN : maxOrden + PASO_ORDEN;
        await api.post('/flito/logistica/motivos-llegada', { nombre: recortado, orden });
        toastOk('Motivo creado.', { id: TOAST_ID });
        cerrarModal();
        cargar();
      } else if (modal?.tipo === 'editar') {
        await api.patch(`/flito/logistica/motivos-llegada/${modal.motivo.id}`, { nombre: recortado });
        toastOk('Cambios guardados.', { id: TOAST_ID });
        cerrarModal();
        cargar();
      }
    } catch (e) {
      const { status, message } = errorHttp(e);
      if (status === 409) {
        setErrorNombre(COPY_409);
      } else if (status === 422) {
        setErrorNombre(/máximo|maximo/i.test(message) ? COPY_LARGO : COPY_VACIO);
      } else if (status === 404) {
        recargarPor404();
      } else {
        setErrorModal(COPY_GUARDAR);
      }
    } finally {
      setGuardando(false);
    }
  };

  const mover = async (motivo: MotivoLlegada, dir: -1 | 1) => {
    const idx = ordenados.findIndex((m) => m.id === motivo.id);
    const vecino = ordenados[idx + dir];
    if (!vecino) return;
    setReordenando(motivo.id);
    try {
      await api.patch(`/flito/logistica/motivos-llegada/${motivo.id}`, { orden: vecino.orden });
      await api.patch(`/flito/logistica/motivos-llegada/${vecino.id}`, { orden: motivo.orden });
      toastOk('Orden actualizado.', { id: TOAST_ID });
      cargar();
    } catch (e) {
      const { status } = errorHttp(e);
      if (status === 404) recargarPor404();
      else toastError(COPY_GUARDAR, undefined, { id: TOAST_ERR_ID });
    } finally {
      setReordenando(null);
    }
  };

  const abrirEstado = (motivo: MotivoLlegada, activo: boolean) => {
    setErrorDialogo(null);
    setDialogo({ motivo, activo });
  };

  const confirmarEstado = async () => {
    if (!dialogo) return;
    setGuardando(true);
    setErrorDialogo(null);
    try {
      await api.patch(`/flito/logistica/motivos-llegada/${dialogo.motivo.id}/estado`, { activo: dialogo.activo });
      toastOk(dialogo.activo
        ? 'Motivo activado.'
        : 'Motivo desactivado. No aparecerá al registrar un viaje a FLIT.', { id: TOAST_ID });
      setDialogo(null);
      cargar();
    } catch (e) {
      const { status } = errorHttp(e);
      if (status === 404) recargarPor404();
      else setErrorDialogo(COPY_ESTADO);
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>Motivos de llegada</h2>
          <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            Motivos por los que un organismo llega a las instalaciones de FLIT. El orden de esta lista es el que verá al registrar un viaje a FLIT.
          </p>
        </div>
        <button
          ref={btnNuevoRef}
          type="button"
          className={`${flitBtnPrimary} shrink-0 self-start`}
          style={flitBtnPrimaryStyle}
          onClick={abrirCrear}
        >
          Nuevo motivo
        </button>
      </div>

      {carga === 'cargando' && (
        <div role="status" aria-label="Cargando motivos de llegada…">
          <span className="sr-only">Cargando motivos de llegada…</span>
          <FlitTable>
            <thead>
              <FlitTr>
                <FlitTh>Motivo</FlitTh>
                <FlitTh>Estado</FlitTh>
                <FlitTh>Acciones</FlitTh>
              </FlitTr>
            </thead>
            <tbody>
              {[0, 1, 2].map((i) => (
                <FlitTr key={i}>
                  <td className="px-4 py-3"><div className="h-4 w-2/3 rounded" style={{ background: 'var(--flit-border-soft)' }} /></td>
                  <td className="px-4 py-3"><div className="h-5 w-16 rounded-full" style={{ background: 'var(--flit-border-soft)' }} /></td>
                  <td className="px-4 py-3"><div className="h-7 w-28 rounded" style={{ background: 'var(--flit-border-soft)' }} /></td>
                </FlitTr>
              ))}
            </tbody>
          </FlitTable>
        </div>
      )}

      {carga === 'error' && (
        <FlitCard>
          <div role="alert" className="flex flex-wrap items-center gap-3 text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
            <p className="flex-1">{COPY_CARGA}</p>
            <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={cargar}>Reintentar</button>
          </div>
        </FlitCard>
      )}

      {carga === 'error403' && (
        <FlitCard>
          <div role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
            <p>{COPY_403}</p>
          </div>
        </FlitCard>
      )}

      {carga === 'ok' && (
        <>
          {motivos.length > 0 && (
            <FiltroEstadoPills valor={filtro} onCambio={setFiltro} />
          )}

          {motivos.length === 0 ? (
            <FlitCard>
              <FlitEmpty>{COPY_LISTA_VACIA}</FlitEmpty>
            </FlitCard>
          ) : visibles.length === 0 ? (
            <FlitEmpty>
              <p>{filtro === 'activos' ? 'Ningún motivo activo.' : 'Ningún motivo inactivo.'}</p>
              <button
                type="button"
                className={`${flitBtnSecondarySm} mt-3`}
                style={flitBtnSecondaryStyle}
                onClick={() => setFiltro('todos')}
              >
                Ver todos
              </button>
            </FlitEmpty>
          ) : (
            <>
              <FlitTable label="Motivos de llegada">
                <thead>
                  <FlitTr>
                    <FlitTh>Motivo</FlitTh>
                    <FlitTh>Estado</FlitTh>
                    <FlitTh>Acciones</FlitTh>
                  </FlitTr>
                </thead>
                <tbody>
                  {visibles.map((m) => {
                    const idxCompleto = ordenados.findIndex((x) => x.id === m.id);
                    const esPrimero = idxCompleto === 0;
                    const esUltimo = idxCompleto === ordenados.length - 1;
                    const ocupado = reordenando === m.id;
                    return (
                      <FlitTr key={m.id}>
                        <td className="px-4 py-2.5 text-sm" style={{ color: 'var(--flit-text-primary)' }}>{m.nombre}</td>
                        <td className="px-4 py-2.5"><ChipEstado activo={m.activo} /></td>
                        <td className="px-4 py-2.5">
                          <div className="flex flex-wrap items-center gap-1">
                            <button
                              type="button"
                              className={flitBtnIconoSm}
                              aria-label={`Subir ${m.nombre}`}
                              title={`Subir ${m.nombre}`}
                              disabled={esPrimero || ocupado}
                              onClick={() => void mover(m, -1)}
                            >
                              <ArrowUp size={14} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className={flitBtnIconoSm}
                              aria-label={`Bajar ${m.nombre}`}
                              title={`Bajar ${m.nombre}`}
                              disabled={esUltimo || ocupado}
                              onClick={() => void mover(m, 1)}
                            >
                              <ArrowDown size={14} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className={flitBtnSecondarySm}
                              ref={(el) => {
                                if (el) btnEditarRefs.current.set(m.id, el);
                                else btnEditarRefs.current.delete(m.id);
                              }}
                              aria-label={`Editar ${m.nombre}`}
                              onClick={() => abrirEditar(m)}
                            >
                              Editar
                            </button>
                            <MenuFila
                              etiqueta={`Acciones de ${m.nombre}`}
                              opciones={[
                                m.activo
                                  ? { id: 'desactivar', texto: 'Desactivar', tono: 'peligro', onElegir: () => abrirEstado(m, false) }
                                  : { id: 'activar', texto: 'Activar', onElegir: () => abrirEstado(m, true) },
                              ]}
                            />
                          </div>
                        </td>
                      </FlitTr>
                    );
                  })}
                </tbody>
              </FlitTable>
              <PieConteo visibles={visibles.length} total={motivos.length} />
            </>
          )}
        </>
      )}

      {modal && (
        <FlitModal
          title={modal.tipo === 'crear' ? 'Nuevo motivo de llegada' : 'Editar motivo de llegada'}
          onClose={cerrarModal}
          restoreFocusRef={modal.tipo === 'crear' ? btnNuevoRef : restoreEditarRef}
          cierreBloqueado={guardando}
        >
          <form
            noValidate
            onSubmit={(e) => { e.preventDefault(); void guardarModal(); }}
            className="space-y-4"
          >
            <FlitField label="Nombre *">
              <input
                ref={inputNombreRef}
                id="motivo-llegada-nombre"
                className={flitInp}
                value={nombre}
                onChange={(e) => { setNombre(e.target.value); setErrorNombre(null); }}
                maxLength={MAX_NOMBRE}
                aria-required={true}
                aria-invalid={errorNombre ? true : undefined}
                aria-describedby={errorNombre ? 'motivo-llegada-nombre-error' : undefined}
                autoComplete="off"
              />
              {errorNombre && (
                <p id="motivo-llegada-nombre-error" className="mt-1 text-xs" style={{ color: 'var(--flit-danger-ink)' }}>
                  {errorNombre}
                </p>
              )}
            </FlitField>
            {errorModal && (
              <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{errorModal}</p>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={cerrarModal} disabled={guardando}>
                Cancelar
              </button>
              <button type="submit" className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={guardando}>
                {guardando ? 'Guardando…' : modal.tipo === 'crear' ? 'Crear motivo' : 'Guardar cambios'}
              </button>
            </div>
          </form>
        </FlitModal>
      )}

      {dialogo && (
        <FlitModal
          title={dialogo.activo ? 'Activar motivo' : 'Desactivar motivo'}
          onClose={() => { if (!guardando) setDialogo(null); }}
          cierreBloqueado={guardando}
        >
          <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            {dialogo.activo
              ? `«${dialogo.motivo.nombre}» volverá a aparecer al registrar un viaje a FLIT.`
              : `Si desactiva «${dialogo.motivo.nombre}», no aparecerá al registrar un viaje a FLIT. El histórico de viajes conserva el motivo.`}
          </p>
          {errorDialogo && (
            <p role="alert" className="mt-3 text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{errorDialogo}</p>
          )}
          <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setDialogo(null)} disabled={guardando}>
              Cancelar
            </button>
            <button
              type="button"
              className={flitBtnPrimary}
              style={dialogo.activo ? flitBtnPrimaryStyle : { ...flitBtnPrimaryStyle, color: 'var(--flit-danger-ink)' }}
              disabled={guardando}
              onClick={() => void confirmarEstado()}
            >
              {guardando ? 'Guardando…' : dialogo.activo ? 'Activar' : 'Desactivar'}
            </button>
          </div>
        </FlitModal>
      )}
    </div>
  );
}
