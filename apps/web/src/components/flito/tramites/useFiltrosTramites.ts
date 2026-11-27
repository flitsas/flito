// FLITO — Gestión Trámites: estado de los filtros de la bandeja (Épica #14707, bloque 4; UX §5.4).
//
// Movido TAL CUAL desde `pages/FlitoTramites.tsx` para que la página baje de líneas: mismos estados,
// misma semilla de `?buscar=`/`?placa=` (HU #12635), misma alerta en la URL (enlace del Tablero) y los
// mismos argumentos de `queryTramites`. Lo nuevo es solo derivado: `cuenta` (filtros activos + alerta,
// SIN el texto buscado), `limpiar()` y `aplicarPreset()`.
//
// AGENTS.md §14: ningún filtro del panel se serializa en la URL de la página (Empresa = NIT). Solo la
// alerta, que ya vivía allí, y la lectura inicial de `?buscar`/`?placa`, que no se escribe nunca.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { EstadoImpuesto, EstadoSoat, esAlertaOperativa, type AlertaOperativa, type FuenteTramite } from '@operaciones/shared-types';
import type { Rango } from '../../flit/RangoFechas';
import { queryTramites } from './useNovedadesTramites';

function useDebounce<T>(valor: T, ms: number): T {
  const [dif, setDif] = useState(valor);
  useEffect(() => { const t = setTimeout(() => setDif(valor), ms); return () => clearTimeout(t); }, [valor, ms]);
  return dif;
}

export type Orden = 'recientes' | 'antiguos';
export type Autogestion = '' | 'si' | 'no';
const SIN_RANGO: Rango = { desde: '', hasta: '' };

/**
 * La vista con la que se abre la pantalla al empezar el día: lo asignado que todavía no se ha movido en
 * ninguno de los dos conceptos, lo más antiguo primero (sin `antiguos`, lo que más espera queda al final).
 */
export const PRESET_RECIEN_LLEGADOS = {
  nombre: 'Recién llegados sin gestionar',
  descripcion: 'Asignados con SOAT e impuesto todavía en pendiente, los más antiguos primero.',
  filtros: { estados: ['Asignado'], soat: [EstadoSoat.PENDIENTE], imp: [EstadoImpuesto.PENDIENTE] },
};

export function useFiltrosTramites() {
  // Semilla desde la URL, solo al montar: un enlace de otra pantalla llega con la búsqueda aplicada.
  // `?buscar=` manda si vienen los dos. A partir de ahí manda el usuario.
  const [texto, setTexto] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('buscar') ?? params.get('placa') ?? '';
  });
  const buscar = useDebounce(texto, 300);
  const [estadosSel, setEstadosSel] = useState<string[]>([]);
  const [soatSel, setSoatSel] = useState<EstadoSoat[]>([]);
  const [impSel, setImpSel] = useState<EstadoImpuesto[]>([]);
  const [ciudadesSel, setCiudadesSel] = useState<string[]>([]);
  const [transitosSel, setTransitosSel] = useState<string[]>([]);
  const [empresasSel, setEmpresasSel] = useState<string[]>([]); // NITs de clientes FLITO
  const [autogestionSel, setAutogestionSel] = useState<Autogestion>('');
  const [fuenteSel, setFuenteSel] = useState<'' | FuenteTramite>(''); // '' = Todas (HU #13071)
  const [creado, setCreado] = useState<Rango>(SIN_RANGO);
  const [aprobado, setAprobado] = useState<Rango>(SIN_RANGO); // HU #11026
  const [ordenSel, setOrdenSel] = useState<Orden>('recientes');
  const [preset, setPreset] = useState<string | null>(null);

  // La alerta vive en la URL: el enlace del Tablero la aplica al entrar. Derivarla evita que la barra
  // de direcciones y la tabla se desincronicen.
  const [searchParams, setSearchParams] = useSearchParams();
  const alertaParam = searchParams.get('alerta');
  const alertaSel: AlertaOperativa | '' = esAlertaOperativa(alertaParam) ? alertaParam : '';
  const setAlertaSel = (v: AlertaOperativa | '') => {
    const next = new URLSearchParams(searchParams);
    if (v) next.set('alerta', v); else next.delete('alerta');
    setSearchParams(next, { replace: true });
  };

  const hayFiltrosSinFuente = soatSel.length > 0 || impSel.length > 0 || empresasSel.length > 0 || estadosSel.length > 0
    || ciudadesSel.length > 0 || transitosSel.length > 0 || autogestionSel !== '' || alertaSel !== '';
  const hayFechas = !!(creado.desde || creado.hasta || aprobado.desde || aprobado.hasta);
  const hayFiltros = hayFiltrosSinFuente || fuenteSel !== '' || hayFechas;
  /** Filtros activos de la rejilla + la alerta del Tablero. El texto buscado no cuenta (UX §5.4). */
  const cuenta = [estadosSel.length, soatSel.length, impSel.length, ciudadesSel.length, transitosSel.length, empresasSel.length]
    .filter((n) => n > 0).length
    + [autogestionSel, fuenteSel, alertaSel].filter((v) => v !== '').length
    + [creado, aprobado].filter((r) => r.desde || r.hasta).length;

  const limpiar = () => {
    setSoatSel([]); setImpSel([]); setEmpresasSel([]); setEstadosSel([]); setTransitosSel([]); setCiudadesSel([]);
    setAutogestionSel(''); setFuenteSel(''); setCreado(SIN_RANGO); setAprobado(SIN_RANGO); setAlertaSel('');
    setOrdenSel('recientes'); setPreset(null);
  };
  /** Se aplica SOBRE el estado limpio; pulsarlo con el preset puesto lo quita. */
  const alternarPreset = () => {
    if (preset === PRESET_RECIEN_LLEGADOS.nombre) { limpiar(); return; }
    limpiar();
    const p = PRESET_RECIEN_LLEGADOS;
    setEstadosSel(p.filtros.estados); setSoatSel(p.filtros.soat); setImpSel(p.filtros.imp);
    setOrdenSel('antiguos'); setPreset(p.nombre);
  };

  /** Argumentos de `queryTramites`, sin cambios respecto a la página anterior. */
  const query = (page: number, pageSize: number) => queryTramites({
    buscar, estados: estadosSel, transitos: transitosSel, ciudades: ciudadesSel, empresas: empresasSel, soat: soatSel,
    impuesto: impSel, autogestion: autogestionSel, fuente: fuenteSel, orden: ordenSel, alerta: alertaSel, creado, aprobado,
  }, page, pageSize);
  /** Clave estable de todos los filtros (sin página) para las dependencias de los efectos. */
  const clave = query(1, 1).toString();

  return {
    texto, setTexto, buscar, estadosSel, setEstadosSel, soatSel, setSoatSel, impSel, setImpSel, ciudadesSel, setCiudadesSel,
    transitosSel, setTransitosSel, empresasSel, setEmpresasSel, autogestionSel, setAutogestionSel, fuenteSel, setFuenteSel,
    creado, setCreado, aprobado, setAprobado, ordenSel, setOrdenSel, preset, alertaSel, setAlertaSel,
    hayFiltros, hayFiltrosSinFuente, hayFechas, cuenta, limpiar, alternarPreset, query, clave,
  };
}

export type EstadoFiltrosTramites = ReturnType<typeof useFiltrosTramites>;
