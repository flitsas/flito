// Torre de Control (Épica #14590) — barra de filtros transversal (spec UX §4). Compañía y Periodo siempre a la
// vista; OT, departamento, tipo y estado en «Más filtros» (`PanelFiltros`) con chips y «Limpiar todo». El estado
// lo guarda `useFiltrosTorre` en sessionStorage, nunca en la URL. El buscador es «Buscar placa»: Enter abre la
// ficha (no filtra) y la placa no se guarda en ningún sitio.
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { DEPARTAMENTO_POR_CODIGO, type OpcionesFiltroTorre } from '@operaciones/shared-types';
import { api } from '../../lib/api';
import {
  FILTROS_TORRE_INICIALES, guardarFiltrosTorre, leerFiltrosTorre, type FiltrosTorre, type PeriodoTorre,
} from '../../lib/torreFiltros';
import PanelFiltros, { type FiltroAplicado } from '../flit/PanelFiltros';
import FlitSelect from '../flit/FlitSelect';
import RangoFechas from '../flit/RangoFechas';
import { hoyBogota, humanizar, nombreDepartamento, nombreOrganismo, opcionesPeriodo } from './formatoTorre';

/** Estado compartido de la barra: se lee de sessionStorage al montar y se guarda en cada cambio. */
export function useFiltrosTorre() {
  const [filtros, setFiltros] = useState<FiltrosTorre>(leerFiltrosTorre);
  useEffect(() => { guardarFiltrosTorre(filtros); }, [filtros]);
  const limpiar = () => setFiltros((f) => ({ ...FILTROS_TORRE_INICIALES, periodo: f.periodo, rango: f.rango, companiaId: f.companiaId }));
  /** «Limpiar filtros» de un vacío: todo a los defaults (Este mes, todas las compañías). */
  const restablecer = () => setFiltros({ ...FILTROS_TORRE_INICIALES });
  return { filtros, setFiltros, limpiar, restablecer };
}

export interface CompaniaTorre { id: number; nombre: string }

const OPCIONES_VACIAS: OpcionesFiltroTorre = { companias: [], organismos: [], tiposTramite: [], flitEstados: [] };
const porNombre = <T,>(lista: T[], nombre: (x: T) => string) => [...lista].sort((a, b) => nombre(a).localeCompare(nombre(b), 'es'));

// Una sola petición por carga de la app aunque la pidan la barra y la página (título del resultado). Un fallo no
// se cachea: el reintento vuelve a pedir.
let opcionesEnVuelo: Promise<OpcionesFiltroTorre> | null = null;
function pedirOpciones(): Promise<OpcionesFiltroTorre> {
  opcionesEnVuelo ??= api.get<OpcionesFiltroTorre>('/flito/torre/opciones')
    .then((o) => ({
      companias: porNombre(o.companias ?? [], (c) => c.nombre),
      organismos: porNombre(o.organismos ?? [], (c) => c.nombre),
      tiposTramite: o.tiposTramite ?? [],
      flitEstados: o.flitEstados ?? [],
    }))
    .catch((e) => { opcionesEnVuelo = null; throw e; });
  return opcionesEnVuelo;
}

/** Opciones de los selects de la barra. Mientras cargan o si fallan, cada select queda solo con «Todas/Todos». */
export function useOpcionesTorre() {
  const [opciones, setOpciones] = useState<OpcionesFiltroTorre>(OPCIONES_VACIAS);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState(false);
  const [intento, setIntento] = useState(0);
  useEffect(() => {
    let vivo = true;
    setFallo(false);
    setCargando(true);
    pedirOpciones()
      .then((o) => { if (vivo) setOpciones(o); })
      .catch(() => { if (vivo) setFallo(true); })
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
  }, [intento]);
  return { opciones, cargando, fallo, reintentar: () => setIntento((n) => n + 1) };
}

/** Compañías para el título del resultado del Explorador. */
export function useCompaniasTorre() {
  const { opciones, fallo, reintentar } = useOpcionesTorre();
  return { companias: opciones.companias, fallo, reintentar };
}

/** Normaliza la placa: mayúsculas y sin espacios ni guiones. Menos de 5 caracteres = no se envía. */
export const normalizarPlaca = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');

const ORDEN_DEPARTAMENTOS = Object.entries(DEPARTAMENTO_POR_CODIGO).sort((a, b) => a[1].localeCompare(b[1], 'es'));

type Borrador = Pick<FiltrosTorre, 'organismo' | 'departamento' | 'tipoTramite' | 'flitEstado'>;
const borradorDe = (f: FiltrosTorre): Borrador => ({ organismo: f.organismo, departamento: f.departamento, tipoTramite: f.tipoTramite, flitEstado: f.flitEstado });

export default function BarraFiltrosTorre({ filtros, onCambio, onLimpiar, onBuscarPlaca, buscadorRef }: {
  filtros: FiltrosTorre;
  onCambio: (f: FiltrosTorre) => void;
  onLimpiar: () => void;
  /** La placa ya normalizada y válida. */
  onBuscarPlaca: (placa: string) => void;
  /** Contenedor del buscador: la ficha devuelve el foco a su input al cerrarse. */
  buscadorRef?: RefObject<HTMLDivElement>;
}) {
  const { opciones, cargando, fallo, reintentar } = useOpcionesTorre();
  const { companias } = opciones;
  const [placa, setPlaca] = useState('');
  const [errorPlaca, setErrorPlaca] = useState(false);
  const [borrador, setBorrador] = useState<Borrador>(() => borradorDe(filtros));
  const idError = useId();
  const propio = useRef<HTMLDivElement>(null);
  const contenedor = buscadorRef ?? propio;

  useEffect(() => { setBorrador(borradorDe(filtros)); }, [filtros]);

  const enviarPlaca = (texto: string) => {
    const p = normalizarPlaca(texto);
    if (p.length < 5) { setErrorPlaca(true); return; }
    setErrorPlaca(false);
    setPlaca(p);
    onBuscarPlaca(p);
  };

  const cambiarPeriodo = (v: string) => {
    if (v === 'personalizado') {
      const hoy = hoyBogota();
      onCambio({ ...filtros, periodo: 'personalizado', rango: filtros.rango ?? { desde: `${hoy.slice(0, 8)}01`, hasta: hoy } });
      return;
    }
    onCambio({ ...filtros, periodo: v as PeriodoTorre, rango: null });
  };

  const aplicados: FiltroAplicado[] = [
    ...(filtros.organismo ? [{ id: 'organismo', etiqueta: `OT: ${opciones.organismos.find((o) => o.codigo === filtros.organismo)?.nombre ?? nombreOrganismo(filtros.organismo)}` }] : []),
    ...(filtros.departamento ? [{ id: 'departamento', etiqueta: `Departamento: ${nombreDepartamento(filtros.departamento)}` }] : []),
    ...(filtros.tipoTramite ? [{ id: 'tipoTramite', etiqueta: `Tipo: ${etiquetaDe(opciones.tiposTramite, filtros.tipoTramite)}` }] : []),
    ...(filtros.flitEstado ? [{ id: 'flitEstado', etiqueta: `Estado: ${etiquetaDe(opciones.flitEstados, filtros.flitEstado)}` }] : []),
  ];

  // Un solo aviso para la lista de opciones (cargan juntas): en el select de Compañía, que siempre está a la vista.
  const mensajeOpciones = fallo ? 'No pudimos cargar las opciones de los filtros.' : cargando ? 'Cargando las opciones…' : null;
  const opcionesCompania = [{ valor: '', etiqueta: 'Todas las compañías' }, ...companias.map((c) => ({ valor: String(c.id), etiqueta: c.nombre }))];

  return (
    <section aria-label="Filtros de la Torre" className="flex flex-col gap-3" data-torre="barra-filtros"
      data-opciones={cargando ? 'cargando' : fallo ? 'error' : 'listo'} aria-busy={cargando || undefined}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:flex lg:flex-wrap lg:items-end">
        <div className="min-w-0 lg:w-72">
          <FlitSelect label="Compañía" value={filtros.companiaId ? String(filtros.companiaId) : ''} opciones={opcionesCompania}
            onChange={(v) => onCambio({ ...filtros, companiaId: v ? Number(v) : null })}
            disabled={cargando} fallo={fallo} mensaje={mensajeOpciones} onReintentar={fallo ? reintentar : undefined}
            textoReintento="Volver a cargar las opciones" />
        </div>
        <div className="min-w-0 lg:w-72">
          <FlitSelect label="Periodo" value={filtros.periodo} opciones={opcionesPeriodo()} onChange={cambiarPeriodo} />
        </div>
        {filtros.periodo === 'personalizado' && filtros.rango && (
          <div className="min-w-0 md:col-span-2 lg:w-auto">
            <RangoFechas etiqueta="Rango personalizado" valor={filtros.rango}
              onCambio={(r) => { if (r.desde && r.hasta) onCambio({ ...filtros, rango: { desde: r.desde, hasta: r.hasta } }); }} />
          </div>
        )}
      </div>

      {/* «Más filtros» en el renglón del buscador también a 375 px. El CSS del kit no tiene capa y gana a las
          utilidades de Tailwind, por eso el `!`; `\_` = guion bajo literal (Tailwind lee `_` como espacio). Solo esta barra. */}
      <div ref={contenedor}
        className="[&_.filtros\_\_barra]:flex-nowrap! [&_.filtros\_\_boton]:shrink-0!">
        <PanelFiltros
          busqueda={placa}
          onBusqueda={(v) => { setPlaca(v); if (errorPlaca) setErrorPlaca(false); }}
          placeholder="Buscar placa"
          etiquetaBusqueda="Buscar placa: escriba la placa y pulse Enter para ver su ficha"
          describedBy={errorPlaca ? idError : undefined}
          onEnviarBusqueda={enviarPlaca}
          textoBoton="Más filtros"
          aplicados={aplicados}
          onQuitar={(id) => onCambio({ ...filtros, [id]: null })}
          onLimpiar={onLimpiar}
          onAplicar={() => onCambio({ ...filtros, ...borrador })}
          campos={(
            <>
              <FlitSelect label="Organismo de tránsito" value={borrador.organismo ?? ''} disabled={cargando}
                opciones={[{ valor: '', etiqueta: 'Todos los organismos' }, ...opciones.organismos.map((o) => ({ valor: o.codigo, etiqueta: o.nombre }))]}
                onChange={(v) => setBorrador((b) => ({ ...b, organismo: v || null }))} />
              <FlitSelect label="Departamento" value={borrador.departamento ?? ''}
                opciones={[{ valor: '', etiqueta: 'Todos los departamentos' }, ...ORDEN_DEPARTAMENTOS.map(([c, n]) => ({ valor: c, etiqueta: n }))]}
                onChange={(v) => setBorrador((b) => ({ ...b, departamento: v || null }))} />
              <FlitSelect label="Tipo de trámite" value={borrador.tipoTramite ?? ''} disabled={cargando}
                opciones={[{ valor: '', etiqueta: 'Todos los tipos' }, ...opciones.tiposTramite]}
                onChange={(v) => setBorrador((b) => ({ ...b, tipoTramite: v || null }))} />
              <FlitSelect label="Estado" value={borrador.flitEstado ?? ''} disabled={cargando}
                opciones={[{ valor: '', etiqueta: 'Todos los estados' }, ...opciones.flitEstados]}
                onChange={(v) => setBorrador((b) => ({ ...b, flitEstado: v || null }))} />
            </>
          )}
        />
      </div>
      {errorPlaca && (
        <p id={idError} className="text-sm" style={{ color: 'var(--flit-danger-ink)' }} role="alert">
          Escriba la placa completa, por ejemplo XXX000.
        </p>
      )}
    </section>
  );
}

/** Etiqueta de una opción; si la lista no cargó (o el valor ya no existe), la clave humanizada. */
function etiquetaDe(lista: { valor: string; etiqueta: string }[], v: string): string {
  return lista.find((o) => o.valor === v)?.etiqueta ?? humanizar(v);
}
