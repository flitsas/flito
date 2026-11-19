// FLITO — Trámites unificado (Fase 6). Porta packages/client/src/paginas/tramites/tramites.tsx al kit
// flit/ + api. Una fila por trámite: solicita SOAT/impuestos/ambos, sigue su estado y entrega en lote.
// Es la vista de quien despacha (Operaciones); Auditoría entra en solo lectura. Los gestores NO entran:
// cada uno sigue en su propia cola. Las reglas viven en el backend; aquí solo se orquesta y reporta.
//
// Rediseño UI Kit 2026 (Épica #14560): molde `#tramites`. Filas, celdas, modales y tipos viven en
// `components/flito/tramites/` (movidos tal cual, sin cambiar lógica) para bajar del techo de líneas.

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { EstadoImpuesto, EstadoSoat } from '@operaciones/shared-types';
import {
  ALERTA_OPERATIVA_LABEL, esAlertaOperativa, type AlertaOperativa,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { vacioConEnlace } from '../lib/copyEnlace';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton, { claseBoton } from '../components/flit/GradientButton';
import { useProveedoresSelector } from '../components/clientes/proveedoresDatos';
import FiltrosInteligentes, { type Preset } from '../components/flit/FiltrosInteligentes';
import RangoFechas from '../components/flit/RangoFechas';
import VisorSoportes from '../components/flit/VisorSoportes';
import ModalFacturaVenta, { esNombrePlacaOrganismo, nombreFacturaVenta } from '../components/flit/ModalFacturaVenta';
import SincronizacionTramites from '../components/flito/tramites/SincronizacionTramites';
import AvisoNovedadesTramites from '../components/flito/tramites/AvisoNovedadesTramites';
import { queryTramites, useNovedadesTramites } from '../components/flito/tramites/useNovedadesTramites';
import FilaTramite from '../components/flito/tramites/FilaTramite';
import CabeceraTramites from '../components/flito/tramites/CabeceraTramites';
import { useVistasColumnas } from '../components/flito/vistas-columnas/useVistasColumnas';
import PanelColumnas from '../components/flito/vistas-columnas/PanelColumnas';
import AvisoVistasColumnas from '../components/flito/vistas-columnas/AvisoVistasColumnas';
import ModalResultado from '../components/flito/tramites/ModalResultadoTramites';
import {
  DialogoProveedor, ModalCrearEmpresa, ModalCrearTramiteDemo, ModalDesbloqueo, ModalHistorial,
} from '../components/flito/tramites/ModalesTramite';
import {
  esAccionable, type HistorialItem, type ResEntrega, type ResImpuestos, type ResSoat, type Resultado, type TramiteFila,
} from '../components/flito/tramites/tiposTramites';
import { FlitCard, FlitTable, FlitEmpty, flitInp } from '../components/flit/flitPageKit';
import FiltroSegmentado from '../components/flit/FiltroSegmentado';
import FiltrosPlegables from '../components/flit/FiltrosPlegables';
import { OPCIONES_FUENTE, VacioFuenteTramite } from '../components/flito-tramites/FuenteTramite';
import type { FuenteTramite } from '@operaciones/shared-types';
import { AvisoSoportesZip, DescargarSoportesZip, ZIP_TRAMITES, useDescargaZip } from '../components/flito/DescargarSoportesZip';
import ModalDetalleTramite from '../components/flito/tramites/detalle/ModalDetalleTramite';
import { useDetalleTramite } from '../components/flito/tramites/detalle/useDetalleTramite';

// Listado paginado en servidor: se piden PAGE_SIZE filas por página con los filtros aplicados en SQL.
const PAGE_SIZE = 50;
interface Paginado { items: TramiteFila[]; total: number; page: number; pageSize: number; marca: string }
interface Facetas { estados: string[]; tramites: string[]; ciudades: string[]; transitos: string[] }

function useDebounce<T>(valor: T, ms: number): T {
  const [dif, setDif] = useState(valor);
  useEffect(() => { const t = setTimeout(() => setDif(valor), ms); return () => clearTimeout(t); }, [valor, ms]);
  return dif;
}

export default function FlitoTramites() {
  const { hasFuncion, tipoEnlace } = useAuth();
  const vc = useVistasColumnas('flito-tramites'); // ADR-0045: vista de columnas activa
  // HU #12170
  const esOperaciones = hasFuncion('tramites.solicitud.pedir_soat');
  // HU #13452: las listas de apoyo de parametrización (compañías, proveedores) están cerradas a todo
  // enlace desde #12875. Solo el usuario SIN enlace las pide y ve lo que depende de ellas; `null` es
  // «aún no se sabe» y no pide nada, para que ni la primera pintura dispare un 403.
  const sinEnlace = tipoEnlace === 'ninguno';
  const puedePedirSoat = esOperaciones && sinEnlace;

  // Semilla desde la URL, solo al montar, para que un enlace de otra pantalla (el detalle del
  // reintento de derechos) llegue con la búsqueda ya aplicada. A partir de ahí manda el usuario.
  // HU #12635: `?placa=` (enlace «Ver trámite» de Comprobantes) alimenta la MISMA búsqueda; `?buscar=` manda si vienen los dos.
  const [texto, setTexto] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('buscar') ?? params.get('placa') ?? '';
  });

  const buscar = useDebounce(texto, 300);
  const [soatSel, setSoatSel] = useState<EstadoSoat[]>([]);
  const [impSel, setImpSel] = useState<EstadoImpuesto[]>([]);
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [data, setData] = useState<TramiteFila[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [facetas, setFacetas] = useState<Facetas>({ estados: [], tramites: [], ciudades: [], transitos: [] });
  const [error, setError] = useState<string | null>(null);
  const [dialogo, setDialogo] = useState<null | 'soat' | 'ambos'>(null);
  // Solicitud de SOAT por fila (desde la columna SOAT): apunta a un único trámite en vez de la selección.
  const [filaSolicitud, setFilaSolicitud] = useState<string | null>(null);
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [enProceso, setEnProceso] = useState(false);
  const [recarga, setRecarga] = useState(0);
  // HU #14342: solo activos que prestan SOAT.
  const proveedores = useProveedoresSelector('soat', puedePedirSoat, recarga);
  const tablaRef = useRef<HTMLDivElement>(null);

  // Dos rangos independientes: creación (fecha de FLIT) y aprobación (HU #11026).
  const [creado, setCreado] = useState({ desde: '', hasta: '' });
  const [aprobado, setAprobado] = useState({ desde: '', hasta: '' });

  // Historial del trámite (modal).
  const [historial, setHistorial] = useState<{ idFlit: string; items: HistorialItem[] } | null>(null);
  // Crear empresa (cliente) desde un trámite con empresa inexistente (NIT precargado).
  const [crearEmpresa, setCrearEmpresa] = useState<TramiteFila | null>(null);
  const [desbloqueo, setDesbloqueo] = useState<TramiteFila | null>(null);
  // Crear trámite DEMO (pruebas de Logística).
  const [crearDemo, setCrearDemo] = useState(false);
  // Visor de factura de venta (modal): blob url + nombre para descargar.
  const [factura, setFactura] = useState<{ url: string; nombre: string } | null>(null);
  // Visor de los soportes del trámite: SOAT, impuesto, derecho de tránsito y logística.
  const [soportesDe, setSoportesDe] = useState<{ tramiteId: string; idFlit: string } | null>(null);
  const det = useDetalleTramite(data, page, total, PAGE_SIZE, setPage); // ADR-0046: detalle en modal (en memoria, no en la URL)

  // Filtros (se aplican EN EL SERVIDOR). Los de texto se debouncean para no disparar un fetch por tecla.
  const [estadosSel, setEstadosSel] = useState<string[]>([]);
  const [ciudadesSel, setCiudadesSel] = useState<string[]>([]);
  const [transitosSel, setTransitosSel] = useState<string[]>([]);
  const [empresasSel, setEmpresasSel] = useState<string[]>([]); // NITs de clientes FLITO
  const [empresasOpc, setEmpresasOpc] = useState<{ nit: string; nombre: string }[]>([]);
  // Filtro rápido de autogestión de la empresa: '' = todas · 'si' = autogestionadas · 'no' = no autogestionadas.
  const [autogestionSel, setAutogestionSel] = useState<'' | 'si' | 'no'>('');
  const [fuenteSel, setFuenteSel] = useState<'' | FuenteTramite>(''); // '' = Todas (HU #13071)
  // Orden cronológico. 'antiguos' es el orden de trabajo del gestor: lo que lleva más esperando va
  // primero. El default sigue siendo lo más reciente, que es como se comportaba antes.
  const [ordenSel, setOrdenSel] = useState<'recientes' | 'antiguos'>('recientes');
  const [preset, setPreset] = useState<string | null>(null);
  // La alerta vive en la URL, no en un useState: así el enlace del tablero la aplica al entrar y
  // la pantalla se puede compartir tal cual. Derivarla (en vez de copiarla a estado) evita que la
  // barra de direcciones y la tabla se desincronicen.
  const [searchParams, setSearchParams] = useSearchParams();
  const alertaParam = searchParams.get('alerta');
  const alertaSel: AlertaOperativa | '' = esAlertaOperativa(alertaParam) ? alertaParam : '';
  const setAlertaSel = (v: AlertaOperativa | '') => {
    const next = new URLSearchParams(searchParams);
    if (v) next.set('alerta', v); else next.delete('alerta');
    setSearchParams(next, { replace: true });
  };
  // Todos los filtros son multiselect; se serializan a una key para las dependencias de los efectos.
  const soatKey = soatSel.join(','); const impKey = impSel.join(','); const empresasKey = empresasSel.join(',');
  const estadosKey = estadosSel.join(','); const ciudadesKey = ciudadesSel.join(','); const transitosKey = transitosSel.join(',');

  // HU #13684: el sondeo se pausa con cualquier diálogo propio abierto o una acción en curso.
  const nov = useNovedadesTramites(!!(dialogo || resultado || historial || factura || soportesDe || desbloqueo || crearEmpresa || crearDemo || det.actual) || enProceso, tablaRef);
  // Cualquier cambio de filtro/búsqueda vuelve a la página 1 (evita quedar en una página vacía).
  useEffect(() => { setPage(1); }, [buscar, estadosKey, ciudadesKey, transitosKey, empresasKey, soatKey, impKey, autogestionSel, fuenteSel, ordenSel, alertaSel]);

  // Carga la página actual desde el servidor con todos los filtros aplicados en SQL. Su `marca` es la
  // línea base del aviso de novedades (HU #13684); si viene de «Ver», la selección se conserva.
  useEffect(() => {
    const deVer = nov.iniciarCarga(); setError(null); if (!deVer) setSeleccion(new Set());
    const q = queryTramites({ buscar, estados: estadosSel, transitos: transitosSel, ciudades: ciudadesSel, empresas: empresasSel, soat: soatSel,
      impuesto: impSel, autogestion: autogestionSel, fuente: fuenteSel, orden: ordenSel, alerta: alertaSel, creado, aprobado }, page, PAGE_SIZE);
    api.get<Paginado>(`/flito/tramites?${q}`)
      .then((r) => {
        const ultima = Math.max(1, Math.ceil(r.total / PAGE_SIZE));
        if (page > ultima) { if (deVer) nov.ver(); setPage(ultima); return; } // la página dejó de existir
        nov.fijarBase(r.marca, r.items.map((i) => i.tramiteId), q, deVer); setData(r.items); setTotal(r.total);
        if (deVer) setSeleccion((s) => new Set(r.items.map((i) => i.tramiteId).filter((id) => s.has(id))));
      })
      .catch((e) => { nov.falloCarga(); setError(errorMessage(e)); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buscar, estadosKey, transitosKey, ciudadesKey, empresasKey, soatKey, impKey, autogestionSel, fuenteSel, ordenSel, alertaSel,
    creado.desde, creado.hasta, aprobado.desde, aprobado.hasta, page, recarga]);

  // Facetas (opciones de los dropdowns) + clientes FLITO (para el multiselect de empresa gestora).
  useEffect(() => {
    api.get<Facetas>('/flito/tramites/facetas').then(setFacetas).catch(() => { /* dropdowns quedan vacíos */ });
  }, [recarga]);

  // HU #13452: con enlace el filtro de empresa gestora no se pinta (el listado ya viene acotado a su
  // enlace) y la lista no se pide.
  useEffect(() => {
    if (!sinEnlace) return;
    api.get<{ nit: string; nombre: string }[]>('/flito/parametrizacion/companias')
      .then((cs) => setEmpresasOpc(cs.map((c) => ({ nit: c.nit, nombre: c.nombre })).sort((a, b) => a.nombre.localeCompare(b.nombre))))
      .catch(() => setEmpresasOpc([]));
  }, [sinEnlace, recarga]);

  const filas = data ?? [];
  const totalPaginas = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const refrescar = () => setRecarga((n) => n + 1);
  /**
   * **Lo MARCADO y lo ACCIONABLE dejan de ser lo mismo** (HU #11910, AC1).
   *
   * Hasta esta HU `ids()` era `[...seleccion]` y eso era seguro **solo** porque la casilla de las
   * filas no accionables venía `disabled`: la interfaz impedía construir una selección que las
   * acciones no supieran tratar. Al abrir la casilla a cualquier fila —que es lo que pide el AC1,
   * porque las Entregadas son justo las que tienen la evidencia completa— ese `disabled` deja de
   * tapar el agujero, y «Entregar» empezaría a mandar al backend ids que nunca admitió.
   *
   * Así que se separan: `ids()` sigue siendo lo que se descarga —la descarga sí aplica a todas— y
   * `idsAccionables()` es lo que reciben «Solicitar …» y «Entregar». Ninguna acción existente cambia
   * a qué filas aplica; lo que cambia es que ahora se dice.
   */
  const ids = () => [...seleccion];
  const seleccionAccionable = filas.filter((f) => seleccion.has(f.tramiteId) && esAccionable(f));
  const idsAccionables = () => seleccionAccionable.map((f) => f.tramiteId);
  const limpiar = () => setSeleccion(new Set());
  const n = seleccion.size;
  const nAccionables = seleccionAccionable.length;
  // `(2)` cuando no hay desajuste y `(2 de 3)` cuando lo hay: el número va DENTRO del nombre
  // accesible, que es lo que se lee en el instante de decidir.
  const cuentaAccionable = nAccionables < n ? `${nAccionables} de ${n}` : `${nAccionables}`;
  // Quién puede DESCARGAR SOPORTES: la misma guarda de la barra. El auditor no la ve (AC7).
  const puedeDescargarSoportes = esOperaciones;
  // El hook se llama SIEMPRE (regla de los hooks); quien decide si la acción existe es el render.
  const descargaZip = useDescargaZip(ZIP_TRAMITES);
  const limpiarFiltros = () => {
    setSoatSel([]); setImpSel([]); setEmpresasSel([]); setEstadosSel([]);
    setTransitosSel([]); setCiudadesSel([]); setAutogestionSel(''); setFuenteSel(''); setAlertaSel('');
    setOrdenSel('recientes'); setPreset(null);
  };

  /**
   * La vista con la que se abre la pantalla al empezar el día: lo que ya está asignado y todavía no
   * se ha movido en ninguno de los dos conceptos.
   *
   * Son cuatro condiciones —estado, SOAT, impuesto y orden— y ponerlas a mano cada mañana es
   * exactamente el trabajo que un preset ahorra. El orden importa tanto como el filtro: sin
   * `antiguos`, lo que lleva más esperando queda en la última página.
   */
  const PRESETS: Array<Preset<{ estados: string[]; soat: EstadoSoat[]; imp: EstadoImpuesto[] }>> = [{
    nombre: 'Recién llegados sin gestionar',
    descripcion: 'Asignados con SOAT e impuesto todavía en pendiente, los más antiguos primero.',
    filtros: { estados: ['Asignado'], soat: [EstadoSoat.PENDIENTE], imp: [EstadoImpuesto.PENDIENTE] },
  }];

  const aplicarPreset = (p: Preset<{ estados: string[]; soat: EstadoSoat[]; imp: EstadoImpuesto[] }>) => {
    limpiarFiltros();
    setEstadosSel(p.filtros.estados);
    setSoatSel(p.filtros.soat);
    setImpSel(p.filtros.imp);
    setOrdenSel('antiguos');
    setPreset(p.nombre);
  };

  const hayFiltrosSinFuente = soatSel.length > 0 || impSel.length > 0 || empresasSel.length > 0 || estadosSel.length > 0 || ciudadesSel.length > 0 || transitosSel.length > 0 || autogestionSel !== '' || alertaSel !== '';
  const hayFiltros = hayFiltrosSinFuente || fuenteSel !== '';

  const ejecutar = async (fn: () => Promise<Resultado>) => {
    setEnProceso(true); setError(null);
    try { setResultado(await fn()); limpiar(); refrescar(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setEnProceso(false); }
  };

  const solicitarImpuestosLote = (tramiteIds: string[]) => ejecutar(async () => ({ tipo: 'impuestos', impuestos: await api.post<ResImpuestos>('/flito/tramites/solicitar-impuestos', { tramiteIds }) }));
  const solicitarImpuestos = () => solicitarImpuestosLote(idsAccionables());
  const entregar = (tramiteIds: string[]) => ejecutar(async () => ({ tipo: 'entrega', entrega: await api.post<ResEntrega>('/flito/tramites/entregar', { tramiteIds }) }));

  // Ver la factura de venta de FLIT: el endpoint (auth) sirve el PDF; se descarga el blob y se
  // muestra en un visor (modal) desde el que también se puede descargar.
  //
  // **El nombre lo pone el SERVIDOR** (HU #11910, AC5): `PLACA-ORGANISMO.<ext>`, el mismo con el que
  // sale dentro del ZIP. Antes se fabricaba aquí (`factura-venta-<idFlit>.pdf`) y quien bajaba un ZIP
  // y luego una factura suelta acababa con dos convenciones en la misma carpeta, sin forma de
  // emparejarlas. El cliente VALIDA la forma y cae al respaldo si no encaja; no la inventa.
  const verFactura = async (fila: TramiteFila) => {
    setError(null);
    try {
      const { blob, nombre } = await api.getBlobNamed(
        `/flito/impuestos/${fila.impuesto!.id}/factura-venta`,
        nombreFacturaVenta(fila.idFlit),
        esNombrePlacaOrganismo,
      );
      setFactura({ url: URL.createObjectURL(blob), nombre });
    } catch (e) { setError(errorMessage(e)); }
  };
  const cerrarFactura = () => { if (factura) URL.revokeObjectURL(factura.url); setFactura(null); };

  // HU #11910: el ZIP de la selección vive en `DescargarSoportesZip` (ids de TRÁMITE; el servidor filtra qué existe).

  const verHistorial = async (f: TramiteFila) => {
    setError(null);
    try {
      const items = await api.get<HistorialItem[]>(`/flito/tramites/${f.tramiteId}/historial`);
      setHistorial({ idFlit: f.idFlit, items });
    } catch (e) { setError(errorMessage(e)); }
  };

  const hayTramitesSistema = facetas.estados.length > 0 || total > 0;

  return (
    <div className="space-y-4">
      <PageHeaderCard title="Gestión Trámites" icono="flito-tramites" miga={[]}
        subtitle="Centro de gestión de los trámites de FLIT: sincroniza y consulta su estado, y solicita SOAT e impuestos. Solo los trámites Asignados —con empresa y secretaría emparejadas— habilitan esas gestiones."
        actions={esOperaciones && sinEnlace ? (
          <GradientButton variant="secondary" title="Crea un trámite aprobado de prueba para Logística"
            onClick={() => setCrearDemo(true)}>+ Trámite demo</GradientButton>
        ) : undefined} />

      {/* HU #13452: sincronizar con FLIT 1/FLIT 2 es operación interna: con enlace el bloque no se pinta. */}
      {sinEnlace && <SincronizacionTramites />}

      {error && (
        <div className="sticky top-[calc(var(--kit-alto-barra)+0.5rem)] z-20">
          <div className="kit-alerta" data-tono="danger" data-kit="alerta">
            <img src="/kit/aviso-error.svg" alt="" aria-hidden="true" className="kit-alerta__icono" />
            <p role="alert" className="m-0 min-w-0 flex-1 text-sm">{error}</p>
          </div>
        </div>
      )}

      {esOperaciones && n > 0 && (
        <div className="barra-accion" data-kit="barra-accion">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-[color:var(--color-action)]">{n} seleccionado(s)</span>
            {/* Las cuatro acciones de siempre, sobre las filas de siempre. Si en lo marcado no hay
                ninguna accionable no se pintan: un botón que no puede actuar sobre nada es peor que
                su ausencia. El número del rótulo es el de las filas sobre las que SÍ actúan. */}
            {nAccionables > 0 && (
              <>
                {puedePedirSoat && <GradientButton variant="secondary" size="sm" disabled={enProceso} onClick={() => setDialogo('soat')}>Solicitar SOAT ({cuentaAccionable})</GradientButton>}
                <GradientButton variant="secondary" size="sm" disabled={enProceso} onClick={solicitarImpuestos}>Solicitar Impuestos ({cuentaAccionable})</GradientButton>
                {puedePedirSoat && <GradientButton variant="secondary" size="sm" disabled={enProceso} onClick={() => setDialogo('ambos')}>Solicitar ambos ({cuentaAccionable})</GradientButton>}
                <GradientButton size="sm" disabled={enProceso} onClick={() => entregar(idsAccionables())}>Entregar ({cuentaAccionable})</GradientButton>
              </>
            )}
            {/* Ocupa el MISMO píxel que el viejo «Descargar facturas (zip)»: quien lo tenía
                memorizado hace el mismo gesto y se encuentra un diálogo con «Factura de venta» ya
                marcada, así que confirmar sin leer produce al menos lo de antes. Lo que cambia y hay
                que declarar: el archivo ya no se llama `facturas-venta.zip`. */}
            <DescargarSoportesZip
              superficie={ZIP_TRAMITES}
              ids={ids()}
              ocupado={descargaZip.ocupado}
              onDescargar={descargaZip.descargar}
            />
            {/* Acción terciaria: ghost del kit (subrayada), a la altura del resto de la barra. */}
            <GradientButton type="button" variant="ghost" size="sm" onClick={limpiar}>
              Limpiar
            </GradientButton>
          </div>
          {nAccionables < n && (
            <p className="m-0 text-sm text-[color:var(--color-text-secondary)]">
              De las {n} filas marcadas, {nAccionables} están Asignadas con empresa y secretaría
              emparejadas y son las únicas sobre las que actúan Solicitar y Entregar.
              Descargar soportes usa las {n}.
            </p>
          )}
          </div>
        </div>
      )}

      {/* Fuera de la barra a propósito: la descarga NO limpia la selección, pero si el usuario la
          limpia el aviso tiene que seguir en pantalla. Se monta donde se monta el botón. */}
      {puedeDescargarSoportes && (
        <AvisoSoportesZip
          ocupado={descargaZip.ocupado}
          marcadas={descargaZip.marcadas}
          aviso={descargaZip.aviso}
          onReintentar={descargaZip.reintentar}
          onDescartar={descargaZip.descartar}
        />
      )}

      {data !== null && !hayTramitesSistema && !hayFiltros && !buscar.trim() && (
        <FlitCard>
          <AvisoNovedadesTramites aviso={nov.aviso} anuncio={nov.anuncio} onVer={() => { nov.ver(); refrescar(); }} />
          <FlitEmpty>{vacioConEnlace('trámites', tipoEnlace) ?? 'No hay trámites. FLITO los trae de FLIT automáticamente.'}</FlitEmpty>
        </FlitCard>
      )}

      {data !== null && (hayTramitesSistema || hayFiltros || !!buscar.trim()) && (
        <FlitCard>
          {/* Barra superior: búsqueda global + total + paginación. Los filtros por columna viven en
              el encabezado de la tabla (abajo). */}
          <div className="mb-3 flex flex-wrap items-center gap-3 border-b border-[color:var(--color-border)] pb-3">
            <input className={`${flitInp} w-full sm:w-72`} placeholder="Buscar placa, VIN, id o propietario…"
              value={texto} onChange={(e) => setTexto(e.target.value)} />
            {/* Épica #14560 (b): en teléfono estos controles se pliegan tras «Filtros (n)»; solo presentación. */}
            <FiltrosPlegables modo="linea"
              activos={[!!(creado.desde || creado.hasta), !!(aprobado.desde || aprobado.hasta), autogestionSel !== '', fuenteSel !== ''].filter(Boolean).length}>
            <FiltrosInteligentes presets={PRESETS} activo={preset}
              onAplicar={aplicarPreset} onQuitar={limpiarFiltros} />
            <RangoFechas etiqueta="Creado" valor={creado} onCambio={(r) => { setCreado(r); setPage(1); }} />
            <RangoFechas etiqueta="Aprobado" valor={aprobado} onCambio={(r) => { setAprobado(r); setPage(1); }} />
            {/* Filtros rápidos de conjunto: autogestión de la empresa y fuente del trámite (HU #13071). */}
            <FiltroSegmentado ariaLabel="Filtrar por autogestión" valor={autogestionSel} onCambio={setAutogestionSel}
              opciones={[{ valor: '', etiqueta: 'Todas' }, { valor: 'si', etiqueta: 'Autogestionadas' }, { valor: 'no', etiqueta: 'No autogestionadas' }]} />
            <FiltroSegmentado rotulo="Fuente" ariaLabel="Filtrar por fuente" valor={fuenteSel} onCambio={setFuenteSel} opciones={OPCIONES_FUENTE} />
            </FiltrosPlegables>
            {/* Alerta activa (llega del tablero por URL). Se muestra siempre que esté puesta, para
                que nadie interprete un listado recortado como si fuera la maestra completa. */}
            {alertaSel && (
              <button type="button" onClick={() => setAlertaSel('')}
                aria-label={`Quitar la alerta ${ALERTA_OPERATIVA_LABEL[alertaSel]}`}
                className={claseBoton('primary', 'sm', 'gap-2')}>
                {ALERTA_OPERATIVA_LABEL[alertaSel]}
                <span aria-hidden="true">×</span>
              </button>
            )}
            <PanelColumnas vc={vc} esAdmin={hasFuncion('tramites.vistas_columnas.administrar')} />
            {/* Orden cronológico: el gestor trabaja de lo más viejo a lo más nuevo. */}
            <label className="flex items-center gap-2 text-xs font-semibold text-[color:var(--color-text-secondary)]">
              Orden
              <select className={flitInp} value={ordenSel}
                onChange={(e) => setOrdenSel(e.target.value as 'recientes' | 'antiguos')}>
                <option value="recientes">Más recientes primero</option>
                <option value="antiguos">Más antiguos primero</option>
              </select>
            </label>
            <span className="text-xs font-semibold text-[color:var(--color-text-secondary)]">{total.toLocaleString('es-CO')} trámite(s)</span>
            {total > PAGE_SIZE && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <button className={claseBoton('secondary', 'sm')} disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>‹ Anterior</button>
                <span className="font-semibold text-[color:var(--color-text-secondary)]">Página {page} de {totalPaginas}</span>
                <button className={claseBoton('secondary', 'sm')} disabled={page >= totalPaginas} onClick={() => setPage((p) => Math.min(totalPaginas, p + 1))}>Siguiente ›</button>
              </div>
            )}
            {hayFiltros && (
              <GradientButton variant="ghost" size="sm" className="ml-auto"
                onClick={limpiarFiltros}>Limpiar filtros</GradientButton>
            )}
          </div>
          <AvisoNovedadesTramites aviso={nov.aviso} anuncio={nov.anuncio} onVer={() => { nov.ver(); refrescar(); }} />
          <AvisoVistasColumnas vc={vc} />
          <div ref={tablaRef} tabIndex={-1} aria-label="Trámites" className="flit-focus rounded-[9px]">
          {filas.length === 0 ? (fuenteSel
            ? <VacioFuenteTramite fuente={fuenteSel} onVerTodas={() => setFuenteSel('')}
                otrosFiltros={!!buscar.trim() || hayFiltrosSinFuente || !!(creado.desde || creado.hasta || aprobado.desde || aprobado.hasta)} />
            : <FlitEmpty>Ningún trámite coincide con el filtro.</FlitEmpty>
          ) : (
          <FlitTable>
            <CabeceraTramites ver={vc.ver} facetas={facetas} estados={[estadosSel, setEstadosSel]} ciudades={[ciudadesSel, setCiudadesSel]}
              transitos={[transitosSel, setTransitosSel]} soat={[soatSel, setSoatSel]} imp={[impSel, setImpSel]}
              empresas={sinEnlace ? { filtro: [empresasSel, setEmpresasSel], opciones: empresasOpc } : undefined} conDetalle
              seleccionPagina={esOperaciones ? { marcada: filas.length > 0 && filas.every((f) => seleccion.has(f.tramiteId)),
                onCambio: (m) => setSeleccion(m ? new Set(filas.map((f) => f.tramiteId)) : new Set()) } : undefined} />
            <tbody>
              {filas.map((f) => (
                <FilaTramite key={f.tramiteId} f={f} esOperaciones={esOperaciones}
                  seleccionada={seleccion.has(f.tramiteId)}
                  onAlternar={() => setSeleccion((s) => { const x = new Set(s); x.has(f.tramiteId) ? x.delete(f.tramiteId) : x.add(f.tramiteId); return x; })}
                  onHistorial={verHistorial} onFactura={verFactura} onDesbloqueo={setDesbloqueo} onCrearEmpresa={setCrearEmpresa}
                  onSolicitarSoat={puedePedirSoat ? () => { setFilaSolicitud(f.tramiteId); setDialogo('soat'); } : undefined}
                  onSolicitarImpuesto={esOperaciones ? () => solicitarImpuestosLote([f.tramiteId]) : undefined}
                  onSoportes={() => setSoportesDe({ tramiteId: f.tramiteId, idFlit: f.idFlit })} onVer={() => det.abrir(f)} ver={vc.ver} />
              ))}
            </tbody>
          </FlitTable>
          )}
          </div>
        </FlitCard>
      )}

      {dialogo && (
        <DialogoProveedor tipo={dialogo} n={filaSolicitud ? 1 : nAccionables} proveedores={proveedores} enProceso={enProceso}
          onCancelar={() => { setDialogo(null); setFilaSolicitud(null); }}
          onConfirmar={(proveedorSoatId) => {
            const tramiteIds = filaSolicitud ? [filaSolicitud] : idsAccionables();
            setDialogo(null); setFilaSolicitud(null);
            ejecutar(async () => {
              if (dialogo === 'soat') return { tipo: 'soat', soat: await api.post<ResSoat>('/flito/tramites/solicitar-soat', { tramiteIds, proveedorSoatId }) };
              const r = await api.post<{ soat: ResSoat; impuestos: ResImpuestos }>('/flito/tramites/solicitar-ambos', { tramiteIds, proveedorSoatId });
              return { tipo: 'ambos', soat: r.soat, impuestos: r.impuestos };
            });
          }} />
      )}

      {det.actual && (
        <ModalDetalleTramite nav={det} recarga={recarga} suspendido={!!dialogo || !!resultado} enProceso={enProceso}
          acciones={{ soat: puedePedirSoat ? (id) => { setFilaSolicitud(id); setDialogo('soat'); } : undefined, ambos: puedePedirSoat ? (id) => { setFilaSolicitud(id); setDialogo('ambos'); } : undefined,
            impuestos: esOperaciones ? (id) => solicitarImpuestosLote([id]) : undefined, entregar: esOperaciones ? (id) => entregar([id]) : undefined }} />
      )}
      {resultado && <ModalResultado resultado={resultado} onCerrar={() => setResultado(null)} />}
      {historial && <ModalHistorial idFlit={historial.idFlit} items={historial.items} onCerrar={() => setHistorial(null)} />}
      {factura && <ModalFacturaVenta url={factura.url} nombre={factura.nombre} onCerrar={cerrarFactura} />}

      {soportesDe && (
        <VisorSoportes ruta={`/flito/tramites/${soportesDe.tramiteId}/soportes`} titulo={soportesDe.idFlit}
          onClose={() => setSoportesDe(null)} />
      )}

      {desbloqueo && (
        <ModalDesbloqueo fila={desbloqueo}
          onCerrar={() => setDesbloqueo(null)}
          onHecho={() => { setDesbloqueo(null); setRecarga((n) => n + 1); }} />
      )}

      {crearEmpresa && (
        <ModalCrearEmpresa fila={crearEmpresa}
          onCerrar={() => setCrearEmpresa(null)}
          onCreado={() => { setCrearEmpresa(null); setRecarga((n) => n + 1); }} />
      )}

      {crearDemo && sinEnlace && (
        <ModalCrearTramiteDemo onCerrar={() => setCrearDemo(false)}
          onCreado={() => { setCrearDemo(false); setRecarga((n) => n + 1); }} />
      )}
    </div>
  );
}
