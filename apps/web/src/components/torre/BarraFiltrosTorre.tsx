// Torre de Control (Épica #14590) — barra de filtros transversal (spec UX §4 de la Torre y §3.3/§3.4/§6 del Explorador
// flexible). Compañía (selección múltiple que aplica al cerrar) y Periodo siempre a la vista; OT, departamento, tipo y
// estado actual en «Más filtros» (`PanelFiltros`), también múltiples, con un chip POR FILTRO y «Limpiar todo». El estado
// lo guarda `useFiltrosTorre` en sessionStorage, nunca en la URL. El buscador es «Buscar placa»: muestra coincidencias
// mientras se escribe y Enter abre la ficha (no filtra); la placa no se guarda en ningún sitio.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { DEPARTAMENTO_POR_CODIGO, type OpcionesFiltroTorre } from '@operaciones/shared-types';
import { api } from '../../lib/api';
import {
  FILTROS_TORRE_INICIALES, guardarFiltrosTorre, leerFiltrosTorre, type FiltrosTorre, type PeriodoTorre,
} from '../../lib/torreFiltros';
import PanelFiltros, { type FiltroAplicado } from '../flit/PanelFiltros';
import FlitSelect from '../flit/FlitSelect';
import RangoFechas from '../flit/RangoFechas';
import { hoyBogota, humanizar, listaY, nombreDepartamento, nombreOrganismo, opcionesPeriodo, resumenSeleccion } from './formatoTorre';
import SelectorMultipleTorre from './SelectorMultipleTorre';
import ListaSugerenciasPlaca, { normalizarPlaca, useSugerenciasPlaca } from './SugerenciasPlacaTorre';

export { normalizarPlaca };

/** Estado compartido de la barra: se lee de sessionStorage al montar y se guarda en cada cambio. */
export function useFiltrosTorre() {
  const [filtros, setFiltros] = useState<FiltrosTorre>(leerFiltrosTorre);
  useEffect(() => { guardarFiltrosTorre(filtros); }, [filtros]);
  /** «Limpiar todo»: quita lo de «Más filtros» y conserva Compañía y Periodo. */
  const limpiar = () => setFiltros((f) => ({ ...FILTROS_TORRE_INICIALES, periodo: f.periodo, rango: f.rango, companiaIds: f.companiaIds }));
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

const ORDEN_DEPARTAMENTOS = Object.entries(DEPARTAMENTO_POR_CODIGO).sort((a, b) => a[1].localeCompare(b[1], 'es'));

type Borrador = Pick<FiltrosTorre, 'organismos' | 'departamentos' | 'tiposTramite' | 'flitEstados'>;
const borradorDe = (f: FiltrosTorre): Borrador => ({
  organismos: f.organismos, departamentos: f.departamentos, tiposTramite: f.tiposTramite, flitEstados: f.flitEstados,
});

/** Etiqueta de una opción; si la lista no cargó (o el valor ya no existe), la clave humanizada. */
function etiquetaDe(lista: { valor: string; etiqueta: string }[], v: string): string {
  return lista.find((o) => o.valor === v)?.etiqueta ?? humanizar(v);
}

/** Nombres legibles de cada filtro de «Más filtros» (chips, subtítulo del resultado y aviso de estado). */
export function nombresFiltros(f: Pick<FiltrosTorre, 'organismos' | 'departamentos' | 'tiposTramite' | 'flitEstados'>, o: OpcionesFiltroTorre) {
  return {
    organismos: f.organismos.map((c) => o.organismos.find((x) => x.codigo === c)?.nombre ?? nombreOrganismo(c)),
    departamentos: f.departamentos.map(nombreDepartamento),
    tiposTramite: f.tiposTramite.map((v) => etiquetaDe(o.tiposTramite, v)),
    flitEstados: f.flitEstados.map((v) => etiquetaDe(o.flitEstados, v)),
  };
}

/** Rótulo de cada chip (spec §3.4): un chip POR FILTRO. */
export const ROTULO_FILTRO = { organismos: 'OT', departamentos: 'Departamento', tiposTramite: 'Tipo', flitEstados: 'Estado actual' } as const;

/** «OT: OT Demo Norte», «OT: OT Demo Norte y 2 más» (la maqueta aprobada resume igual con dos). */
const textoChip = (rotulo: string, nombres: string[]) => `${rotulo}: ${resumenSeleccion(nombres)}`;

const elegidas = (n: number) => `${n} ${n === 1 ? 'elegida' : 'elegidas'}`;
const elegidos = (n: number) => `${n} ${n === 1 ? 'elegido' : 'elegidos'}`;

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
  const [placa, setPlaca] = useState('');
  const [errorPlaca, setErrorPlaca] = useState(false);
  const [borrador, setBorrador] = useState<Borrador>(() => borradorDe(filtros));
  const idError = useId();
  const idSug = useId();
  const propio = useRef<HTMLDivElement>(null);
  const contenedor = buscadorRef ?? propio;

  // Sugerencias: la lista se abre al escribir y se cierra con Esc, Tab, al salir del input o al elegir.
  const sug = useSugerenciasPlaca(placa);
  const [listaAbierta, setListaAbierta] = useState(false);
  const [activo, setActivo] = useState(-1);
  const visible = listaAbierta && sug.estado !== 'cerrada';
  const idOpcion = (i: number) => `${idSug}-sug-${i}`;
  useEffect(() => { setActivo(-1); }, [sug.sugerencias]);

  useEffect(() => { setBorrador(borradorDe(filtros)); }, [filtros]);

  const abrirFicha = (p: string) => {
    setErrorPlaca(false);
    setPlaca(p);
    setListaAbierta(false);
    onBuscarPlaca(p);
  };
  const enviarPlaca = (texto: string) => {
    const p = normalizarPlaca(texto);
    if (p.length < 5) { setErrorPlaca(true); setListaAbierta(false); return; }
    abrirFicha(p);
  };

  /** Teclado del combobox (spec §6). `true` = atendida; `false` = sigue el comportamiento de siempre. */
  const teclaBuscador = (e: KeyboardEvent<HTMLInputElement>): boolean => {
    const n = sug.sugerencias.length;
    if (e.key === 'ArrowDown') {
      if (n === 0) return false;
      e.preventDefault();
      setListaAbierta(true);
      setActivo((a) => (visible ? Math.min(a + 1, n - 1) : 0));
      return true;
    }
    if (e.key === 'ArrowUp') {
      if (!visible || activo < 0) return false;
      e.preventDefault();
      setActivo((a) => a - 1);
      return true;
    }
    if (e.key === 'Enter' && visible && activo >= 0 && sug.sugerencias[activo]) {
      e.preventDefault();
      abrirFicha(sug.sugerencias[activo].placa);
      return true;
    }
    if (e.key === 'Escape' && visible) {
      // Cierra la lista y conserva el texto; no llega al Drawer ni al panel de alrededor.
      e.preventDefault();
      e.stopPropagation();
      setListaAbierta(false);
      setActivo(-1);
      return true;
    }
    if (e.key === 'Tab') setListaAbierta(false);
    return false;
  };

  const cambiarPeriodo = (v: string) => {
    if (v === 'personalizado') {
      const hoy = hoyBogota();
      onCambio({ ...filtros, periodo: 'personalizado', rango: filtros.rango ?? { desde: `${hoy.slice(0, 8)}01`, hasta: hoy } });
      return;
    }
    onCambio({ ...filtros, periodo: v as PeriodoTorre, rango: null });
  };

  const nombres = nombresFiltros(filtros, opciones);
  const aplicados: FiltroAplicado[] = (Object.keys(ROTULO_FILTRO) as (keyof typeof ROTULO_FILTRO)[])
    .filter((k) => nombres[k].length > 0)
    .map((k) => ({
      id: k, etiqueta: textoChip(ROTULO_FILTRO[k], nombres[k]),
      ariaQuitar: `Quitar filtro ${ROTULO_FILTRO[k]}: ${listaY(nombres[k])}`,
    }));

  const opcionesCompania = opciones.companias.map((c) => ({ valor: String(c.id), etiqueta: c.nombre }));

  return (
    <section aria-label="Filtros de la Torre" className="flex flex-col gap-3" data-torre="barra-filtros"
      data-opciones={cargando ? 'cargando' : fallo ? 'error' : 'listo'} aria-busy={cargando || undefined}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:flex lg:flex-wrap lg:items-start">
        <div className="min-w-0 lg:w-72">
          {/* Un solo aviso para la lista de opciones (cargan juntas): en Compañía, que siempre está a la vista. */}
          <SelectorMultipleTorre label="Compañía" valor={filtros.companiaIds.map(String)} opciones={opcionesCompania}
            onCambio={(v) => onCambio({ ...filtros, companiaIds: v.map(Number) })} aplicarAlCerrar
            todas="Todas las compañías" sustantivo="Ninguna compañía" elegidas={elegidas}
            cargando={cargando} fallo={fallo} onReintentar={reintentar} />
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
          onBusqueda={(v) => { setPlaca(v); setListaAbierta(true); if (errorPlaca) setErrorPlaca(false); }}
          placeholder="Buscar placa"
          etiquetaBusqueda="Buscar placa: escriba 3 o más caracteres para ver coincidencias, o la placa completa y Enter para ver su ficha"
          describedBy={errorPlaca ? idError : undefined}
          onEnviarBusqueda={enviarPlaca}
          combobox={{
            expandido: visible, listboxId: `${idSug}-lista`,
            activoId: visible && activo >= 0 ? idOpcion(activo) : undefined,
            onKeyDown: teclaBuscador,
            onFocus: () => { if (placa) setListaAbierta(true); },
            onBlur: () => { setListaAbierta(false); setActivo(-1); },
            lista: (
              <ListaSugerenciasPlaca visible={visible} listboxId={`${idSug}-lista`} idOpcion={idOpcion} estado={sug.estado}
                texto={sug.texto} buscando={sug.buscando} sugerencias={sug.sugerencias} hayMas={sug.hayMas} activo={activo}
                onResaltar={setActivo} onElegir={(s) => abrirFicha(s.placa)} onReintentar={sug.reintentar} />
            ),
          }}
          textoBoton="Más filtros"
          aplicados={aplicados}
          onQuitar={(id) => onCambio({ ...filtros, [id]: [] })}
          onLimpiar={onLimpiar}
          onAplicar={() => onCambio({ ...filtros, ...borrador })}
          campos={(
            <>
              <SelectorMultipleTorre label="Organismo de tránsito" valor={borrador.organismos} cargando={cargando}
                opciones={opciones.organismos.map((o) => ({ valor: o.codigo, etiqueta: o.nombre }))}
                onCambio={(v) => setBorrador((b) => ({ ...b, organismos: v }))}
                todas="Todos los organismos" sustantivo="Ningún organismo" elegidas={elegidos}
                busquedaMinima={2} maxVisibles={50} textoTruncado="Escriba para acotar: hay más organismos." />
              <SelectorMultipleTorre label="Departamento" valor={borrador.departamentos}
                opciones={ORDEN_DEPARTAMENTOS.map(([c, n]) => ({ valor: c, etiqueta: n }))}
                onCambio={(v) => setBorrador((b) => ({ ...b, departamentos: v }))}
                todas="Todos los departamentos" sustantivo="Ningún departamento" elegidas={elegidos} />
              <SelectorMultipleTorre label="Tipo de trámite" valor={borrador.tiposTramite} cargando={cargando}
                opciones={opciones.tiposTramite} onCambio={(v) => setBorrador((b) => ({ ...b, tiposTramite: v }))}
                todas="Todos los tipos" sustantivo="Ningún tipo" elegidas={elegidos} />
              <SelectorMultipleTorre label="Estado actual" valor={borrador.flitEstados} cargando={cargando}
                opciones={opciones.flitEstados} onCambio={(v) => setBorrador((b) => ({ ...b, flitEstados: v }))}
                todas="Todos los estados" sustantivo="Ningún estado" elegidas={elegidos} />
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
