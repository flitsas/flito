// FLITO — Servicios adicionales: el catálogo de tipos y su valor (HU #12542, Feature #12540).
// Diseño: `docs/ux/flito-servicios-adicionales-catalogo.md` (modo full).
//
// Página delgada: estado de la lista, el GET con guarda de «solo la última petición escribe
// estado» (calco de FlitoTarifas), el 403 → NoAccess, los cuatro estados y qué modal está abierto.
// La tabla, el formulario (crear y editar, una pieza) y el diálogo de baja viven en
// `components/servicios-adicionales/`. Tras cada escritura la lista se repide ENTERA al servidor:
// no se parchea la fila con lo que el modal cree haber guardado.
//
// Los botones existen por `hasFuncion('parametrizacion.servicios_adicionales.*')`, nunca por rol.
// El gate de ruta es `ProtectedRoute page="flito_servicios_adicionales"`; el 403 del GET es la
// segunda valla y pinta la misma pantalla `NoAccess`, no un error.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { api, ApiError, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  RUTA_SERVICIOS_ADICIONALES, lineaPorTarifar, tituloTipos, type ServicioAdicionalTipo,
} from '../lib/serviciosAdicionales';
import NoAccess from '../components/NoAccess';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import {
  FlitCard, FlitEmpty, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';
import TablaServiciosAdicionales from '../components/servicios-adicionales/TablaServiciosAdicionales';
import FormularioTipoServicio from '../components/servicios-adicionales/FormularioTipoServicio';
import DialogoBajaTipoServicio from '../components/servicios-adicionales/DialogoBajaTipoServicio';

const SUBTITULO = 'Lo que FLITO cobra aparte del trámite: cada tipo con su valor en pesos.';
const NO_DISPONIBLE = 'El tipo ya no está disponible. La lista se actualizó.';
const DURACION_TOAST = 6000;

type Modal = { modo: 'crear' } | { modo: 'editar'; tipo: ServicioAdicionalTipo } | { modo: 'baja'; tipo: ServicioAdicionalTipo };

const barra = (ancho: string, key: number) => (
  <div key={key} className={`h-5 ${ancho} animate-pulse rounded`} style={{ background: 'var(--flit-bg-table-header)' }} />
);

export default function FlitoServiciosAdicionales() {
  const { hasFuncion } = useAuth();
  const puedeCrear = hasFuncion('parametrizacion.servicios_adicionales.crear');
  const puedeEditar = hasFuncion('parametrizacion.servicios_adicionales.editar');
  const puedeDarDeBaja = hasFuncion('parametrizacion.servicios_adicionales.dar_de_baja');

  const [tipos, setTipos] = useState<ServicioAdicionalTipo[] | null>(null);
  const [error, setError] = useState<{ status: number; mensaje: string } | null>(null);
  const [refrescando, setRefrescando] = useState(false);
  const [incluirBajas, setIncluirBajas] = useState(false);
  const [modal, setModal] = useState<Modal | null>(null);
  const [anuncio, setAnuncio] = useState('');
  const tituloLista = useRef<HTMLHeadingElement>(null);
  /** Tras editar, el foco vuelve al «Editar» de esa fila cuando la lista repedida ya está pintada. */
  const focoTrasRefresco = useRef<string | null>(null);

  // Solo la ÚLTIMA petición lanzada escribe estado: marcar y desmarcar el control dos veces
  // seguidas —o el doble montaje de StrictMode— no puede dejar en pantalla la respuesta tardía.
  const peticion = useRef(0);
  const cargar = useCallback((conBajas: boolean, modo: 'inicial' | 'refresco') => {
    const mia = ++peticion.current;
    const vigente = () => mia === peticion.current;
    if (modo === 'inicial') setTipos(null); else setRefrescando(true);
    setError(null);
    return api.get<ServicioAdicionalTipo[]>(`${RUTA_SERVICIOS_ADICIONALES}${conBajas ? '?incluirBajas=1' : ''}`)
      .then((lista) => {
        if (!vigente()) return;
        setTipos(lista);
        if (modo === 'refresco') setAnuncio('Catálogo actualizado.');
      })
      .catch((e) => {
        if (!vigente()) return;
        setError({ status: e instanceof ApiError ? e.status : 0, mensaje: errorMessage(e) });
        if (modo === 'inicial') setTipos(null);
      })
      .finally(() => { if (vigente()) setRefrescando(false); });
  }, []);

  useEffect(() => { void cargar(incluirBajas, 'inicial'); }, [incluirBajas, cargar]);

  const refrescar = () => { setAnuncio(''); void cargar(incluirBajas, 'refresco'); };
  const cerrar = () => setModal(null);

  const guardado = () => {
    const creado = modal?.modo === 'crear';
    if (modal?.modo === 'editar') focoTrasRefresco.current = modal.tipo.id;
    cerrar();
    toast.success(creado ? 'Tipo creado.' : 'Cambios guardados.', { duration: DURACION_TOAST });
    refrescar();
  };
  const dadoDeBaja = (nombre: string) => {
    cerrar();
    toast.success(`«${nombre}» dado de baja.`, { duration: DURACION_TOAST });
    refrescar();
  };
  const noDisponible = () => {
    cerrar();
    toast.error(NO_DISPONIBLE, { duration: DURACION_TOAST });
    refrescar();
  };

  // Mientras la lista se repide, los botones de fila están apagados y el que abrió el modal no
  // puede recuperar el foco (`FlitModal` lo deja en el h2). Cuando llega la lista nueva, se lleva al
  // «Editar» de la fila editada, que es donde estaba (UX §6.6). Si la fila ya no está, se queda en el h2.
  useEffect(() => {
    if (refrescando || tipos === null || !focoTrasRefresco.current) return;
    const id = focoTrasRefresco.current;
    focoTrasRefresco.current = null;
    document.querySelector<HTMLElement>(`th[data-id="${CSS.escape(id)}"]`)
      ?.closest('tr')?.querySelector<HTMLButtonElement>('button[aria-label^="Editar"]')?.focus();
  }, [refrescando, tipos]);

  const porTarifar = useMemo(() => (tipos ?? []).filter((t) => t.activo && t.valor === 0).length, [tipos]);

  if (error?.status === 403) return <NoAccess page="flito_servicios_adicionales" />;

  const nuevoTipo = puedeCrear && (
    <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={() => setModal({ modo: 'crear' })}>
      Nuevo tipo
    </button>
  );
  const nuevoTipoVacio = puedeCrear && (
    <button type="button" className={`${flitBtnSecondary} mt-4`} style={flitBtnSecondaryStyle} onClick={() => setModal({ modo: 'crear' })}>
      Nuevo tipo
    </button>
  );

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard title="Servicios adicionales" subtitle={SUBTITULO} actions={nuevoTipo || undefined} />
      <p className="sr-only" role="status">{anuncio}</p>

      {error && tipos === null ? (
        <FlitCard className="mx-auto w-full max-w-xl text-center">
          <p role="alert" className="text-sm font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>
            No se pudo cargar el catálogo de servicios adicionales.
          </p>
          <p className="mt-1 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{error.mensaje}</p>
          <button type="button" className={`${flitBtnSecondary} mt-4`} style={flitBtnSecondaryStyle} onClick={() => void cargar(incluirBajas, 'inicial')}>
            Reintentar
          </button>
        </FlitCard>
      ) : (
        <FlitCard>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 ref={tituloLista} tabIndex={-1} className="flit-focus text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>
              {tipos ? tituloTipos(tipos) : 'Tipos'}
            </h2>
            <label className="inline-flex cursor-pointer items-center gap-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
              <input
                type="checkbox" className="flit-focus h-4 w-4" checked={incluirBajas} disabled={tipos === null}
                onChange={(e) => setIncluirBajas(e.target.checked)}
              />
              Mostrar dados de baja
            </label>
          </div>

          {error && (
            <p role="alert" className="mb-3 text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
              No se pudo actualizar el catálogo. {error.mensaje}{' '}
              <button type="button" className="underline" onClick={refrescar}>Reintentar</button>
            </p>
          )}

          {tipos === null ? (
            <div role="status" aria-busy="true" aria-label="Cargando tipos de servicio adicional" className="space-y-3">
              {['w-full', 'w-full', 'w-full', 'w-full'].map(barra)}
            </div>
          ) : tipos.length === 0 ? (
            <FlitEmpty>
              {incluirBajas ? (
                <p style={{ color: 'var(--flit-text-primary)' }}>Ningún tipo, ni activo ni dado de baja.</p>
              ) : (
                <>
                  <p style={{ color: 'var(--flit-text-primary)' }}>Aún no hay tipos de servicio adicional.</p>
                  <p className="mt-1">Crea el primero: un nombre, una descripción si hace falta y su valor en pesos.</p>
                </>
              )}
              {nuevoTipoVacio}
            </FlitEmpty>
          ) : (
            <>
              {porTarifar > 0 && (
                <p className="mb-3 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{lineaPorTarifar(porTarifar)}</p>
              )}
              <TablaServiciosAdicionales
                tipos={tipos}
                puedeEditar={puedeEditar}
                puedeDarDeBaja={puedeDarDeBaja}
                bloqueada={refrescando}
                onEditar={(tipo) => setModal({ modo: 'editar', tipo })}
                onDarDeBaja={(tipo) => setModal({ modo: 'baja', tipo })}
              />
            </>
          )}
        </FlitCard>
      )}

      {modal && modal.modo !== 'baja' && (
        <FormularioTipoServicio
          tipo={modal.modo === 'editar' ? modal.tipo : null}
          onClose={cerrar}
          onGuardado={guardado}
          onNoDisponible={noDisponible}
          restoreFocusRef={tituloLista}
        />
      )}
      {modal?.modo === 'baja' && (
        <DialogoBajaTipoServicio
          tipo={modal.tipo}
          onClose={cerrar}
          onDadoDeBaja={() => dadoDeBaja(modal.tipo.nombre)}
          onNoDisponible={noDisponible}
          restoreFocusRef={tituloLista}
        />
      )}
    </div>
  );
}
