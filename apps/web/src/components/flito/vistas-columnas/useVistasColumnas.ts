// Vistas de columnas persistidas (ADR-0043): estado y acciones de la vista activa de una tabla.
//
// Qué guarda el servidor y qué no:
//   · El servidor resuelve la vista activa (personal → general → sistema) y devuelve SUS columnas
//     ya intersecadas con lo que el usuario puede ver. El cliente no decide permisos.
//   · El `borrador` (casillas tocadas sin guardar) es estado local: dura lo que dura la página.
//     Nada en la URL ni en localStorage (decisión del humano, 2026-11-18).
//   · Elegir una vista en el selector es también estado local (`seleccion`): aplica sus columnas
//     (`VistaColumnas.columnas`, ya intersecadas por el servidor) sin escribir nada. Solo «Usar como
//     predeterminada» fija el puntero personal, y «Restablecer» lo fija a la vista del sistema.
//
// Si la carga falla, la tabla sigue con la vista del sistema (todas las columnas) y la página
// muestra un aviso con reintento; nunca el error crudo del API.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ColumnaDisponible, CodigoVistasColumnas, RespuestaVistasColumnas, TablaVistasId, VistaColumnas,
} from '@operaciones/shared-types';
import { api, ApiError } from '../../../lib/api';
import { toastError, toastOk } from '../../flit/ToastFlito';

export type EstadoCarga = 'cargando' | 'error' | 'listo';

export interface VistasColumnas {
  estado: EstadoCarga;
  datos: RespuestaVistasColumnas | null;
  /** Columnas del catálogo que el usuario puede ver, en orden del catálogo. */
  disponibles: ColumnaDisponible[];
  /** Columnas marcadas ahora mismo (borrador o, si no hay, las de la vista activa). */
  marcadas: ReadonlySet<string>;
  hayCambios: boolean;
  /** Vista elegida en esta sesión (o la que resolvió el servidor), o `null` si es la del sistema. */
  activa: VistaColumnas | null;
  /** Id de la vista elegida; `null` = vista del sistema. */
  elegidaId: number | null;
  /** Id de la predeterminada personal, o `null` si no hay. */
  predeterminadaPersonalId: number | null;
  ocupado: boolean;
  ver: (clave: string) => boolean;
  alternar: (clave: string) => void;
  descartar: () => void;
  recargar: () => void;
  /** Solo sesión: aplica las columnas de la vista sin escribir en el servidor. */
  elegir: (vistaId: number | null) => void;
  /** Persiste la vista del sistema como predeterminada personal (PUT `{vistaId:null}`). */
  restablecer: () => Promise<boolean>;
  guardarNueva: (nombre: string, paraTodos: boolean) => Promise<boolean>;
  guardarCambios: () => Promise<boolean>;
  usarPredeterminada: () => Promise<boolean>;
  predeterminadaTodos: () => Promise<boolean>;
  eliminar: () => Promise<boolean>;
}

const COPY_ERROR: Partial<Record<CodigoVistasColumnas, string>> = {
  NOMBRE_DUPLICADO: 'Ya hay una vista con ese nombre. Elija otro y vuelva a guardar.',
  LIMITE_VISTAS: 'Llegó al límite de vistas personales. Elimine una para guardar otra.',
  VERSION_CONFLICTO: 'La vista cambió en otra sesión. La recargamos: revise y vuelva a guardar.',
  COLUMNA_NO_PERMITIDA: 'La vista incluye columnas que usted no puede ver. Quítelas y vuelva a guardar.',
  CLAVE_DESCONOCIDA: 'La vista tiene columnas que ya no existen. Restablezca y vuelva a armarla.',
  ALCANCE_NO_PERMITIDO: 'Solo un administrador puede guardar o fijar vistas para todos.',
  VISTA_NO_ENCONTRADA: 'Esa vista ya no existe. Recargamos la lista.',
  VISTA_NO_COMPARTIDA: 'Solo una vista para todos puede ser la predeterminada para todos.',
};

function codigoDe(e: unknown): CodigoVistasColumnas | null {
  if (!(e instanceof ApiError)) return null;
  const d = e.rawDetails as { codigo?: unknown } | undefined;
  return typeof d?.codigo === 'string' ? (d.codigo as CodigoVistasColumnas) : null;
}

const base = (tablaId: TablaVistasId) => `/flito/vistas-columnas/${tablaId}`;

export function useVistasColumnas(tablaId: TablaVistasId): VistasColumnas {
  const [estado, setEstado] = useState<EstadoCarga>('cargando');
  const [datos, setDatos] = useState<RespuestaVistasColumnas | null>(null);
  const [borrador, setBorrador] = useState<string[] | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [recarga, setRecarga] = useState(0);
  // `undefined` = sin elección en esta sesión: rige la vista activa que resolvió el servidor.
  const [seleccion, setSeleccion] = useState<number | null | undefined>(undefined);

  useEffect(() => {
    let vivo = true;
    setEstado((e) => (e === 'listo' ? e : 'cargando'));
    api.get<RespuestaVistasColumnas>(base(tablaId))
      .then((r) => {
        if (!vivo) return;
        // Respuesta con otra forma (proxy, versión vieja del API): se trata como fallo de carga.
        if (!r || !Array.isArray(r.columnasDisponibles) || !r.vistaActiva || !Array.isArray(r.vistas)) throw new Error('forma');
        setDatos(r); setEstado('listo');
      })
      .catch(() => { if (vivo) setEstado((e) => (e === 'listo' ? e : 'error')); });
    return () => { vivo = false; };
  }, [tablaId, recarga]);

  const recargar = useCallback(() => {
    setEstado((e) => (e === 'error' ? 'cargando' : e));
    setRecarga((n) => n + 1);
  }, []);

  const disponibles = useMemo(() => datos?.columnasDisponibles ?? [], [datos]);
  const fijas = useMemo(() => new Set(disponibles.filter((c) => c.fija).map((c) => c.clave)), [disponibles]);
  const permitidas = useMemo(() => new Set(disponibles.map((c) => c.clave)), [disponibles]);
  const elegidaId = seleccion !== undefined ? seleccion : (datos?.vistaActiva.id ?? null);
  const activa = (elegidaId !== null && datos?.vistas.find((v) => v.id === elegidaId)) || null;
  const deVista = !datos ? undefined
    : activa ? activa.columnas
      : elegidaId === null && seleccion !== undefined ? datos.sistema.columnas
        : datos.vistaActiva.columnas;
  const predeterminadaPersonalId = datos?.vistaActiva.origen === 'personal' ? datos.vistaActiva.id : null;
  const marcadas = useMemo(() => {
    const s = new Set(borrador ?? deVista ?? []);
    fijas.forEach((c) => s.add(c));
    return s;
  }, [borrador, deVista, fijas]);
  const hayCambios = borrador !== null;

  // Sin datos (cargando o error) rige la vista del sistema: todas las columnas.
  const ver = useCallback(
    (clave: string) => (datos ? permitidas.has(clave) && marcadas.has(clave) : true),
    [datos, permitidas, marcadas],
  );

  const alternar = useCallback((clave: string) => {
    if (fijas.has(clave)) return;
    const s = new Set(marcadas);
    if (s.has(clave)) s.delete(clave); else s.add(clave);
    // Orden del catálogo: lo que se persiste no depende del orden de los clics.
    setBorrador(disponibles.map((c) => c.clave).filter((c) => s.has(c)));
  }, [fijas, marcadas, disponibles]);

  const descartar = useCallback(() => setBorrador(null), []);
  const columnasActuales = () => disponibles.map((c) => c.clave).filter((c) => marcadas.has(c));

  /** Corre una escritura: un toast por acción; al terminar recarga la lista y limpia el borrador. */
  const escribir = async <T,>(
    accion: () => Promise<T>, ok: string, fallo: string, limpiar = true, despues?: (r: T) => void,
  ) => {
    setOcupado(true);
    try {
      const resultado = await accion();
      if (limpiar) setBorrador(null);
      if (despues) despues(resultado);
      toastOk(ok, { id: 'vistas-columnas' });
      setRecarga((n) => n + 1);
      return true;
    } catch (e) {
      const codigo = codigoDe(e);
      toastError((codigo && COPY_ERROR[codigo]) || fallo, undefined, { id: 'vistas-columnas' });
      if (codigo === 'VERSION_CONFLICTO' || codigo === 'VISTA_NO_ENCONTRADA') setRecarga((n) => n + 1);
      if (codigo === 'VISTA_NO_ENCONTRADA') { setSeleccion(undefined); setBorrador(null); }
      return false;
    } finally {
      setOcupado(false);
    }
  };

  const fijarPersonal = (vistaId: number | null) =>
    api.put(`${base(tablaId)}/predeterminada/personal`, { vistaId });

  return {
    estado, datos, disponibles, marcadas, hayCambios, activa, elegidaId, predeterminadaPersonalId, ocupado,
    ver, alternar, descartar, recargar,
    elegir: (vistaId) => { setSeleccion(vistaId); setBorrador(null); },
    restablecer: () => escribir(
      () => fijarPersonal(null),
      'Volvió a la vista del sistema.',
      'No se pudo restablecer la vista. Intente de nuevo.',
      true,
      () => setSeleccion(null),
    ),
    // La vista nueva queda elegida en la sesión; ser predeterminada es otra acción («Usar como predeterminada»).
    guardarNueva: (nombre, paraTodos) => escribir(
      () => api.post<{ id: number }>(`${base(tablaId)}/vistas`, {
        nombre: nombre.trim(), alcance: paraTodos ? 'compartida' : 'personal', columnas: columnasActuales(),
      }),
      paraTodos ? 'Vista guardada para todos.' : 'Vista guardada.',
      'No se pudo guardar la vista. Intente de nuevo.',
      true,
      (creada) => setSeleccion(creada.id),
    ),
    guardarCambios: () => escribir(
      () => api.put(`${base(tablaId)}/vistas/${activa?.id}`, { columnas: columnasActuales(), version: activa?.version }),
      'Cambios guardados en la vista.',
      'No se pudieron guardar los cambios. Intente de nuevo.',
    ),
    usarPredeterminada: () => escribir(
      () => fijarPersonal(activa?.id ?? null),
      'Ahora es su vista predeterminada.',
      'No se pudo fijar la vista predeterminada. Intente de nuevo.',
      false,
    ),
    predeterminadaTodos: () => escribir(
      () => api.put(`${base(tablaId)}/predeterminada/general`, { vistaId: activa?.id ?? null }),
      'Ahora es la vista predeterminada para todos.',
      'No se pudo fijar la vista para todos. Intente de nuevo.',
      false,
    ),
    eliminar: () => escribir(
      () => api.delete(`${base(tablaId)}/vistas/${activa?.id}`),
      'Vista eliminada.',
      'No se pudo eliminar la vista. Intente de nuevo.',
      true,
      // Sus punteros caen en el servidor (RN-VC7): se vuelve a la vista que él resuelva.
      () => setSeleccion(undefined),
    ),
  };
}
