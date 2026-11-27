// FLITO — Trámites unificado (Fase 6). Una fila por trámite: solicita SOAT/impuestos/ambos, sigue su estado
// y entrega en lote. Es la vista de quien despacha (Operaciones); Auditoría entra en solo lectura. Los
// gestores NO entran: cada uno sigue en su propia cola. Las reglas viven en el backend; aquí solo se
// orquesta y reporta. Filas, celdas, modales y tipos viven en `components/flito/tramites/`.
//
// Épica #14707, bloque 4 (UX `docs/ux/flito-tramites-rediseno.md`, molde de cola): Filtros en acordeón con
// la búsqueda, las vistas rápidas, «Columnas» y «Orden» (`FiltrosTramites`, estado en `useFiltrosTramites`),
// barra de lote que solo existe con selección y entonces queda fija (`BarraTablaTramites`), zona de avisos,
// tabla sin tarjeta y, abajo, la paginación con el conteo (ajustes 14707: nada flota sobre la tabla sin
// selección). Un fallo del listado es un aviso en página con Reintentar; el de una acción de la bandeja, un
// toast cerrable con copy pulido (nunca el error crudo); el de una acción del detalle, `role="alert"` dentro
// de la modal. Trámite muerto (14707): sin casilla accionable, «Seleccionar todos» lo salta, 409 → refresco.

import { useEffect, useRef, useState } from 'react';
import { api, ApiError, esTramiteNoVigente } from '../lib/api';
import { useAuth } from '../lib/auth';
import { vacioConEnlace } from '../lib/copyEnlace';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton, { claseBoton } from '../components/flit/GradientButton';
import InlineAlert from '../components/flit/InlineAlert';
import { toastError } from '../components/flit/ToastFlito';
import { useProveedoresSelector } from '../components/clientes/proveedoresDatos';
import VisorSoportes from '../components/flit/VisorSoportes';
import ModalFacturaVenta, { esNombrePlacaOrganismo, nombreFacturaVenta } from '../components/flit/ModalFacturaVenta';
import SincronizacionTramites from '../components/flito/tramites/SincronizacionTramites';
import AvisoNovedadesTramites from '../components/flito/tramites/AvisoNovedadesTramites';
import { useNovedadesTramites } from '../components/flito/tramites/useNovedadesTramites';
import { useFiltrosTramites, type Orden } from '../components/flito/tramites/useFiltrosTramites';
import FiltrosTramites, { type FacetasTramites } from '../components/flito/tramites/FiltrosTramites';
import BarraTablaTramites from '../components/flito/tramites/BarraTablaTramites';
import FilaTramite from '../components/flito/tramites/FilaTramite';
import CabeceraTramites from '../components/flito/tramites/CabeceraTramites';
import { useVistasColumnas } from '../components/flito/vistas-columnas/useVistasColumnas';
import PanelColumnas from '../components/flito/vistas-columnas/PanelColumnas';
import AvisoVistasColumnas from '../components/flito/vistas-columnas/AvisoVistasColumnas';
import ModalResultado from '../components/flito/tramites/ModalResultadoTramites';
import { DialogoProveedor, ModalCrearEmpresa, ModalCrearTramiteDemo, ModalDesbloqueo } from '../components/flito/tramites/ModalesTramite';
import {
  esAccionable, type ResEntrega, type ResImpuestos, type ResSoat, type Resultado, type TramiteFila,
} from '../components/flito/tramites/tiposTramites';
import { FlitTable, FlitEmpty } from '../components/flit/flitPageKit';
import { VacioFuenteTramite } from '../components/flito-tramites/FuenteTramite';
import { AvisoSoportesZip, DescargarSoportesZip, ZIP_TRAMITES, useDescargaZip } from '../components/flito/DescargarSoportesZip';
import ModalDetalleTramite from '../components/flito/tramites/detalle/ModalDetalleTramite';
import { useDetalleTramite } from '../components/flito/tramites/detalle/useDetalleTramite';

// Listado paginado en servidor: se piden PAGE_SIZE filas por página con los filtros aplicados en SQL.
const PAGE_SIZE = 50;
interface Paginado { items: TramiteFila[]; total: number; page: number; pageSize: number; marca: string }

type AccionBandeja = 'soat' | 'impuestos' | 'ambos' | 'entregar';
const QUE_ACCION: Record<AccionBandeja, { modal: string; toast: string; muerto: string }> = {
  soat: { modal: 'solicitar el SOAT', toast: 'No se pudo solicitar el SOAT. Intenta de nuevo.', muerto: 'No se pudo solicitar el SOAT' },
  impuestos: { modal: 'solicitar los impuestos', toast: 'No se pudo solicitar el impuesto. Intenta de nuevo.', muerto: 'No se pudo solicitar el impuesto' },
  ambos: { modal: 'solicitar el SOAT y los impuestos', toast: 'No se pudo solicitar el SOAT ni el impuesto. Intenta de nuevo.', muerto: 'No se pudo solicitar el SOAT ni el impuesto' },
  entregar: { modal: 'entregar el trámite', toast: 'No se pudo entregar. Intenta de nuevo.', muerto: 'No se pudo entregar' },
};

/** Copy del fallo de una acción de la bandeja (UX §5.7 y 14707 §6): nunca el error crudo. */
function copyFalloBandeja(e: unknown, accion: AccionBandeja, idFlit: string | null): string {
  if (esTramiteNoVigente(e)) {
    return idFlit
      ? `${QUE_ACCION[accion].muerto}: el trámite ${idFlit} se anuló o se revocó en FLIT. La tabla ya se actualizó.`
      : 'No se envió nada: los trámites seleccionados se anularon o se revocaron en FLIT. La tabla ya se actualizó.';
  }
  // Un 409/422 con una frase de negocio del servidor se respeta; lo demás, la frase de la acción.
  if (e instanceof ApiError && (e.status === 409 || e.status === 422) && e.message.trim()) return e.message;
  return QUE_ACCION[accion].toast;
}

export default function FlitoTramites() {
  const { hasFuncion, tipoEnlace } = useAuth();
  const vc = useVistasColumnas('flito-tramites'); // ADR-0045: vista de columnas activa
  const esOperaciones = hasFuncion('tramites.solicitud.pedir_soat'); // HU #12170
  // HU #13452: las listas de parametrización están cerradas a todo enlace; `null` = «aún no se sabe».
  const sinEnlace = tipoEnlace === 'ninguno';
  const puedePedirSoat = esOperaciones && sinEnlace;

  const f = useFiltrosTramites();
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [data, setData] = useState<TramiteFila[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [cargando, setCargando] = useState(true);
  const [errorListado, setErrorListado] = useState(false);
  const [facetas, setFacetas] = useState<FacetasTramites>({ estados: [], ciudades: [], transitos: [] });
  const [empresasOpc, setEmpresasOpc] = useState<{ nit: string; nombre: string }[]>([]);
  const [dialogo, setDialogo] = useState<null | 'soat' | 'ambos'>(null);
  // Solicitud de SOAT por fila (desde la columna SOAT): apunta a un único trámite en vez de la selección.
  const [filaSolicitud, setFilaSolicitud] = useState<TramiteFila | null>(null);
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [enProceso, setEnProceso] = useState(false);
  const [recarga, setRecarga] = useState(0);
  const proveedores = useProveedoresSelector('soat', puedePedirSoat, recarga); // HU #14342
  const tablaRef = useRef<HTMLDivElement>(null);
  const [crearEmpresa, setCrearEmpresa] = useState<TramiteFila | null>(null);
  const [desbloqueo, setDesbloqueo] = useState<TramiteFila | null>(null);
  const [crearDemo, setCrearDemo] = useState(false); // trámite DEMO (pruebas de Logística)
  const [factura, setFactura] = useState<{ url: string; nombre: string } | null>(null);
  const [soportesDe, setSoportesDe] = useState<{ tramiteId: string; idFlit: string } | null>(null);
  const det = useDetalleTramite(data, page, total, PAGE_SIZE, setPage); // ADR-0046: detalle en memoria, no en la URL

  // HU #13684: el sondeo se pausa con cualquier diálogo propio abierto o una acción en curso.
  const nov = useNovedadesTramites(!!(dialogo || resultado || factura || soportesDe || desbloqueo || crearEmpresa || crearDemo || det.actual) || enProceso, tablaRef);
  // Cualquier cambio de filtro/búsqueda vuelve a la página 1 (evita quedar en una página vacía).
  useEffect(() => { setPage(1); }, [f.clave]);

  // Carga la página actual con todos los filtros aplicados en SQL. Su `marca` es la línea base del aviso de
  // novedades (HU #13684); si viene de «Ver», la selección se conserva.
  useEffect(() => {
    const deVer = nov.iniciarCarga(); setErrorListado(false); setCargando(true); if (!deVer) setSeleccion(new Set());
    const q = f.query(page, PAGE_SIZE);
    api.get<Paginado>(`/flito/tramites?${q}`)
      .then((r) => {
        const ultima = Math.max(1, Math.ceil(r.total / PAGE_SIZE));
        if (page > ultima) { if (deVer) nov.ver(); setPage(ultima); return; } // la página dejó de existir
        nov.fijarBase(r.marca, r.items.map((i) => i.tramiteId), q, deVer); setData(r.items); setTotal(r.total);
        if (deVer) setSeleccion((s) => new Set(r.items.map((i) => i.tramiteId).filter((id) => s.has(id))));
        setCargando(false);
      })
      .catch(() => { nov.falloCarga(); setErrorListado(true); setCargando(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.clave, page, recarga]);

  // Facetas (opciones de los filtros) y, solo sin enlace (HU #13452), las compañías de Empresa gestora.
  useEffect(() => {
    api.get<FacetasTramites>('/flito/tramites/facetas').then(setFacetas).catch(() => { /* los filtros quedan sin opciones */ });
  }, [recarga]);
  useEffect(() => {
    if (!sinEnlace) return;
    api.get<{ nit: string; nombre: string }[]>('/flito/parametrizacion/companias')
      .then((cs) => setEmpresasOpc(cs.map((c) => ({ nit: c.nit, nombre: c.nombre })).sort((a, b) => a.nombre.localeCompare(b.nombre))))
      .catch(() => setEmpresasOpc([]));
  }, [sinEnlace, recarga]);

  const filas = data ?? [];
  const vivas = filas.filter((x) => x.vigenciaTramite === 'vigente');
  const totalPaginas = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const refrescar = () => setRecarga((n) => n + 1);
  /**
   * Lo MARCADO y lo ACCIONABLE no son lo mismo (HU #11910, AC1): `ids()` es lo que se descarga (aplica a
   * todas) e `idsAccionables()` lo que reciben «Solicitar …» y «Entregar».
   */
  const ids = () => [...seleccion];
  const seleccionAccionable = filas.filter((x) => seleccion.has(x.tramiteId) && esAccionable(x));
  const idsAccionables = () => seleccionAccionable.map((x) => x.tramiteId);
  const limpiar = () => setSeleccion(new Set());
  const descargaZip = useDescargaZip(ZIP_TRAMITES); // siempre: regla de los hooks; el render decide si existe

  // Una acción lanzada desde el detalle falla DENTRO de la modal (`role="alert"`, corrige D4); un 409 de trámite
  // no vigente no lleva texto: se refresca y la modal pinta el aviso de 14707. Desde la bandeja: toast + refresco.
  const [errorAccion, setErrorAccion] = useState<string | null>(null);
  useEffect(() => { setErrorAccion(null); }, [det.actual?.tramiteId]);
  const ejecutar = async (accion: AccionBandeja, idFlit: string | null, fn: () => Promise<Resultado>) => {
    const desdeModal = det.actual !== null;
    setEnProceso(true); setErrorAccion(null);
    try { setResultado(await fn()); limpiar(); refrescar(); }
    catch (e) {
      if (esTramiteNoVigente(e)) refrescar();
      if (!desdeModal) toastError(copyFalloBandeja(e, accion, idFlit));
      else if (!esTramiteNoVigente(e)) setErrorAccion(`No se pudo ${QUE_ACCION[accion].modal}. Intenta de nuevo.`);
    }
    finally { setEnProceso(false); }
  };
  const idFlitDe = (tramiteIds: string[]) => (tramiteIds.length === 1 ? filas.find((x) => x.tramiteId === tramiteIds[0])?.idFlit ?? null : null);
  const solicitarImpuestosLote = (tramiteIds: string[]) => ejecutar('impuestos', idFlitDe(tramiteIds),
    async () => ({ tipo: 'impuestos', impuestos: await api.post<ResImpuestos>('/flito/tramites/solicitar-impuestos', { tramiteIds }) }));
  const entregar = (tramiteIds: string[]) => ejecutar('entregar', idFlitDe(tramiteIds),
    async () => ({ tipo: 'entrega', entrega: await api.post<ResEntrega>('/flito/tramites/entregar', { tramiteIds }) }));

  // Factura de venta de FLIT: el nombre lo pone el SERVIDOR (HU #11910, AC5); el cliente valida la forma.
  const verFactura = async (fila: TramiteFila) => {
    try {
      const { blob, nombre } = await api.getBlobNamed(`/flito/impuestos/${fila.impuesto!.id}/factura-venta`, nombreFacturaVenta(fila.idFlit), esNombrePlacaOrganismo);
      setFactura({ url: URL.createObjectURL(blob), nombre });
    } catch {
      toastError(`No se pudo abrir la factura de venta del trámite ${fila.idFlit}. Intenta de nuevo.`, () => { void verFactura(fila); });
    }
  };
  const cerrarFactura = () => { if (factura) URL.revokeObjectURL(factura.url); setFactura(null); };

  const hayTramitesSistema = facetas.estados.length > 0 || total > 0;
  const sinNada = data !== null && !hayTramitesSistema && !f.hayFiltros && !f.buscar.trim();
  const seleccionModo = esOperaciones && seleccion.size > 0;

  return (
    <div className="space-y-4">
      <PageHeaderCard title="Gestión Trámites" icono="flito-tramites" miga={[]}
        subtitle="Solicita SOAT e impuestos de los trámites Asignados y entrégalos cuando estén listos."
        actions={esOperaciones && sinEnlace ? (
          <GradientButton variant="secondary" title="Crea un trámite aprobado de prueba para Logística"
            onClick={() => setCrearDemo(true)}>+ Trámite demo</GradientButton>
        ) : undefined} />

      {/* HU #13452: sincronizar con FLIT 1/FLIT 2 es operación interna: con enlace el bloque no se pinta. */}
      {sinEnlace && <SincronizacionTramites />}

      {/* Cambiar Orden recarga como cualquier filtro y por eso limpia la selección; Columnas solo muestra u oculta
          celdas y la conserva. Ninguno se deshabilita con selección: así se comportan los filtros de al lado. */}
      <FiltrosTramites f={f} facetas={facetas} empresasOpc={sinEnlace ? empresasOpc : null}
        herramientas={(
          <>
            <PanelColumnas vc={vc} esAdmin={hasFuncion('tramites.vistas_columnas.administrar')} />
            {/* Orden cronológico: el gestor trabaja de lo más viejo a lo más nuevo. */}
            <label className="filtros__orden">
              Orden
              <select className="control" value={f.ordenSel} onChange={(e) => f.setOrdenSel(e.target.value as Orden)}>
                <option value="recientes">Más recientes primero</option>
                <option value="antiguos">Más antiguos primero</option>
              </select>
            </label>
          </>
        )} />

      <div>
        <BarraTablaTramites
          seleccion={seleccionModo ? {
            n: seleccion.size, nAccionables: seleccionAccionable.length, puedePedirSoat, enProceso,
            onSolicitarSoat: () => setDialogo('soat'), onSolicitarAmbos: () => setDialogo('ambos'),
            onSolicitarImpuestos: () => solicitarImpuestosLote(idsAccionables()), onEntregar: () => entregar(idsAccionables()),
            // Ocupa el mismo sitio que el viejo «Descargar facturas (zip)» (HU #11910).
            descargar: <DescargarSoportesZip superficie={ZIP_TRAMITES} ids={ids()} ocupado={descargaZip.ocupado} onDescargar={descargaZip.descargar} />,
            onLimpiar: limpiar,
          } : null} />

        {/* Zona de avisos: error del listado, novedades, vistas de columnas y ZIP (UX §5.5). */}
        <div className="space-y-2 empty:hidden">
          {errorListado && (
            <InlineAlert tono="danger" titulo="No pudimos cargar los trámites."
              accion={<button type="button" className={claseBoton('secondary', 'sm')} onClick={refrescar}>Reintentar</button>}>
              <p className="m-0">Revisa tu conexión y vuelve a intentarlo.</p>
            </InlineAlert>
          )}
          <AvisoNovedadesTramites aviso={nov.aviso} anuncio={nov.anuncio} onVer={() => { nov.ver(); refrescar(); }} />
          <AvisoVistasColumnas vc={vc} />
          {/* Fuera de la barra: la descarga NO limpia la selección, y si el usuario la limpia el aviso sigue. */}
          {esOperaciones && (
            <AvisoSoportesZip ocupado={descargaZip.ocupado} marcadas={descargaZip.marcadas} aviso={descargaZip.aviso}
              onReintentar={descargaZip.reintentar} onDescartar={descargaZip.descartar} />
          )}
        </div>

        <div ref={tablaRef} tabIndex={-1} aria-label="Trámites" aria-busy={cargando || undefined} className="flit-focus mt-2 rounded-[9px]">
          {data === null ? (
            !errorListado && (
              <div role="status" aria-label="Cargando trámites" data-kit="esqueleto" className="space-y-2">
                {[0, 1, 2, 3, 4].map((i) => <div key={i} className="kit-esqueleto h-14 w-full" />)}
              </div>
            )
          ) : sinNada ? (
            <FlitEmpty>
              {vacioConEnlace('trámites', tipoEnlace)
                ?? 'Todavía no hay trámites. FLITO los trae solo de FLIT 1 y FLIT 2; aparecen aquí en cuanto lleguen. Si esperabas trámites, revisa el estado en Sincronización.'}
            </FlitEmpty>
          ) : filas.length === 0 ? (f.fuenteSel
            ? <VacioFuenteTramite fuente={f.fuenteSel} onVerTodas={() => f.setFuenteSel('')}
                otrosFiltros={!!f.buscar.trim() || f.hayFiltrosSinFuente || f.hayFechas} />
            : <FlitEmpty>Ningún trámite coincide con el filtro. Quita algún filtro de arriba o usa «Limpiar filtros».</FlitEmpty>
          ) : (
            <FlitTable>
              <CabeceraTramites ver={vc.ver}
                seleccionPagina={esOperaciones ? { marcada: vivas.length > 0 && vivas.every((x) => seleccion.has(x.tramiteId)),
                  onCambio: (m) => setSeleccion(m ? new Set(vivas.map((x) => x.tramiteId)) : new Set()) } : undefined} />
              <tbody>
                {filas.map((x) => (
                  <FilaTramite key={x.tramiteId} f={x} esOperaciones={esOperaciones} seleccionada={seleccion.has(x.tramiteId)}
                    onAlternar={() => setSeleccion((s) => { const n = new Set(s); if (n.has(x.tramiteId)) n.delete(x.tramiteId); else n.add(x.tramiteId); return n; })}
                    onHistorial={(fila) => det.abrir(fila, 'historial')} onFactura={verFactura} onDesbloqueo={setDesbloqueo} onCrearEmpresa={setCrearEmpresa}
                    onSolicitarSoat={puedePedirSoat ? () => { setFilaSolicitud(x); setDialogo('soat'); } : undefined}
                    onSolicitarImpuesto={esOperaciones ? () => solicitarImpuestosLote([x.tramiteId]) : undefined}
                    onSoportes={() => setSoportesDe({ tramiteId: x.tramiteId, idFlit: x.idFlit })} onVer={() => det.abrir(x)} ver={vc.ver} />
                ))}
              </tbody>
            </FlitTable>
          )}
        </div>

        {/* Pie de la tabla (UX §15; ajustes 14707): el conteo junto a la paginación, también con una sola página. */}
        {!sinNada && !(errorListado && data === null) && <PieTramites total={total} cargando={cargando} page={page} totalPaginas={totalPaginas} setPage={setPage} />}
      </div>

      {dialogo && (
        <DialogoProveedor tipo={dialogo} n={filaSolicitud ? 1 : seleccionAccionable.length} proveedores={proveedores} enProceso={enProceso}
          onCancelar={() => { setDialogo(null); setFilaSolicitud(null); }}
          onConfirmar={(proveedorSoatId) => {
            const tramiteIds = filaSolicitud ? [filaSolicitud.tramiteId] : idsAccionables();
            const idFlit = filaSolicitud?.idFlit ?? idFlitDe(tramiteIds);
            const tipo = dialogo;
            setDialogo(null); setFilaSolicitud(null);
            ejecutar(tipo, idFlit, async () => {
              if (tipo === 'soat') return { tipo: 'soat', soat: await api.post<ResSoat>('/flito/tramites/solicitar-soat', { tramiteIds, proveedorSoatId }) };
              const r = await api.post<{ soat: ResSoat; impuestos: ResImpuestos }>('/flito/tramites/solicitar-ambos', { tramiteIds, proveedorSoatId });
              return { tipo: 'ambos', soat: r.soat, impuestos: r.impuestos };
            });
          }} />
      )}

      {det.actual && (
        <ModalDetalleTramite nav={det} recarga={recarga} suspendido={!!dialogo || !!resultado} enProceso={enProceso} errorAccion={errorAccion}
          acciones={{ soat: puedePedirSoat ? (id) => { setFilaSolicitud(filas.find((x) => x.tramiteId === id) ?? det.actual); setDialogo('soat'); } : undefined,
            ambos: puedePedirSoat ? (id) => { setFilaSolicitud(filas.find((x) => x.tramiteId === id) ?? det.actual); setDialogo('ambos'); } : undefined,
            impuestos: esOperaciones ? (id) => solicitarImpuestosLote([id]) : undefined,
            entregar: esOperaciones ? (id) => entregar([id]) : undefined }} />
      )}
      {resultado && <ModalResultado resultado={resultado} onCerrar={() => setResultado(null)} />}
      {factura && <ModalFacturaVenta url={factura.url} nombre={factura.nombre} onCerrar={cerrarFactura} />}
      {soportesDe && (
        <VisorSoportes ruta={`/flito/tramites/${soportesDe.tramiteId}/soportes`} titulo={soportesDe.idFlit} onClose={() => setSoportesDe(null)} />
      )}
      {desbloqueo && (
        <ModalDesbloqueo fila={desbloqueo} onCerrar={() => setDesbloqueo(null)} onHecho={() => { setDesbloqueo(null); refrescar(); }} />
      )}
      {crearEmpresa && (
        <ModalCrearEmpresa fila={crearEmpresa} onCerrar={() => setCrearEmpresa(null)} onCreado={() => { setCrearEmpresa(null); refrescar(); }} />
      )}
      {crearDemo && sinEnlace && (
        <ModalCrearTramiteDemo onCerrar={() => setCrearDemo(false)} onCreado={() => { setCrearDemo(false); refrescar(); }} />
      )}
    </div>
  );
}

/** «‹ Anterior · 1.284 trámites · Página 1 de 26 · Siguiente ›»; con una sola página, solo el conteo. */
function PieTramites({ total, cargando, page, totalPaginas, setPage }: {
  total: number; cargando: boolean; page: number; totalPaginas: number; setPage: (fn: (p: number) => number) => void;
}) {
  const varias = totalPaginas > 1;
  const Contenedor = varias ? 'nav' : 'div';
  const sep = <span className="paginacion-tramites__sep" aria-hidden="true">·</span>;
  return (
    <Contenedor className="paginacion-tramites" data-testid="pie-tramites" aria-label={varias ? 'Paginación de trámites' : undefined}>
      {varias && <button type="button" className={claseBoton('secondary', 'sm')} disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>‹ Anterior</button>}
      {varias && sep}
      <span className="paginacion-tramites__cuenta" role="status">
        {cargando ? 'Actualizando…' : `${total.toLocaleString('es-CO')} ${total === 1 ? 'trámite' : 'trámites'}`}
      </span>
      {varias && sep}
      {varias && <span>Página {page} de {totalPaginas}</span>}
      {varias && sep}
      {varias && <button type="button" className={claseBoton('secondary', 'sm')} disabled={page >= totalPaginas} onClick={() => setPage((p) => Math.min(totalPaginas, p + 1))}>Siguiente ›</button>}
    </Contenedor>
  );
}
