// HU #13684 — Aviso de trámites nuevos o actualizados sin recargar la lista de Gestión Trámites.
//
// La página fija la LÍNEA BASE con la `marca` (hora de la BD) de cada GET visible; este hook pregunta
// cada ~50 s a `POST /flito/tramites/novedades/buscar` si desde esa marca entró algo que cumple los mismos
// filtros (nuevos) o cambió algo de la página visible (actualizados). La tabla no se toca: solo se
// enciende el aviso, y es el operador quien decide recargar con «Ver».
//
// Los filtros viajan en el BODY (pueden llevar placa, nombre o NIT en `buscar`: AGENTS §14). Cualquier
// fallo de la consulta (red, 4xx, 429 del limitador, 5xx) se traga: sin toast y sin tocar el aviso.

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { api } from '../../../lib/api';

/** Intervalo del sondeo. El AC1 pide el aviso en ≤ 60 s; 50 s deja margen para la latencia. */
export const INTERVALO_NOVEDADES_MS = 50_000;

export interface FiltrosTramites {
  buscar: string; estados: string[]; transitos: string[]; ciudades: string[]; empresas: string[];
  soat: string[]; impuesto: string[]; autogestion: string; fuente: string; orden: string; alerta: string;
  creado: { desde: string; hasta: string }; aprobado: { desde: string; hasta: string };
}

/**
 * Query del listado. Función pura y ÚNICA: la usan el GET de la lista y el body del sondeo, para que
 * «nuevo» se cuente exactamente con el filtro que el operador está viendo.
 */
export function queryTramites(f: FiltrosTramites, page: number, pageSize: number): URLSearchParams {
  const q = new URLSearchParams();
  if (f.buscar.trim()) q.set('buscar', f.buscar.trim());
  if (f.estados.length) q.set('estados', f.estados.join(','));
  if (f.transitos.length) q.set('transitos', f.transitos.join(','));
  if (f.ciudades.length) q.set('ciudades', f.ciudades.join(','));
  if (f.empresas.length) q.set('empresas', f.empresas.join(','));
  if (f.soat.length) q.set('soat', f.soat.join(','));
  if (f.impuesto.length) q.set('impuesto', f.impuesto.join(','));
  if (f.autogestion) q.set('autogestion', f.autogestion);
  if (f.fuente) q.set('fuente', f.fuente);
  if (f.orden !== 'recientes') q.set('orden', f.orden);
  if (f.alerta) q.set('alerta', f.alerta);
  if (f.creado.desde) q.set('creadoDesde', f.creado.desde);
  if (f.creado.hasta) q.set('creadoHasta', f.creado.hasta);
  if (f.aprobado.desde) q.set('aprobadoDesde', f.aprobado.desde);
  if (f.aprobado.hasta) q.set('aprobadoHasta', f.aprobado.hasta);
  q.set('page', String(page)); q.set('pageSize', String(pageSize));
  return q;
}

export interface Novedades { nuevos: number; actualizados: number }

interface LineaBase { marca: string; visibles: string[]; filtros: Record<string, string> }

/** Hay un diálogo abierto en la página (los de la propia página y los de Sincronización / descargas). */
const hayDialogoAbierto = () => !!document.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"]');

/**
 * @param pausado diálogo propio abierto o acción en curso (lote, descarga): no se consulta (AC4).
 * @param tablaRef contenedor de la tabla: recibe el foco tras «Ver» (AC3/AC5).
 */
export function useNovedadesTramites(pausado: boolean, tablaRef: RefObject<HTMLElement>) {
  const [aviso, setAviso] = useState<Novedades | null>(null);
  const [anuncio, setAnuncio] = useState('');
  const base = useRef<LineaBase | null>(null);
  const cargando = useRef(false);
  const enVuelo = useRef(false);
  const conservar = useRef(false);
  const pausadoRef = useRef(pausado);
  pausadoRef.current = pausado;

  /** Empieza una carga visible: sin línea base ni aviso hasta que termine. Devuelve si viene de «Ver». */
  const iniciarCarga = useCallback(() => {
    cargando.current = true; base.current = null; setAviso(null);
    const deVer = conservar.current; conservar.current = false;
    return deVer;
  }, []);

  /** La carga terminó bien: su `marca` es la nueva línea base. */
  const fijarBase = useCallback((marca: string, visibles: string[], q: URLSearchParams, deVer: boolean) => {
    const filtros = Object.fromEntries([...q].filter(([k]) => k !== 'page' && k !== 'pageSize'));
    // Sin `marca` (API anterior a la HU) no hay línea base y por tanto no hay sondeo.
    base.current = marca ? { marca, visibles: visibles.slice(0, 200), filtros } : null;
    cargando.current = false;
    if (deVer) {
      setAnuncio('Lista actualizada.');
      requestAnimationFrame(() => tablaRef.current?.focus());
    }
  }, [tablaRef]);

  const falloCarga = useCallback(() => { cargando.current = false; }, []);

  /** «Ver»: la próxima carga conserva la selección y lleva el foco a la tabla. */
  const ver = useCallback(() => { conservar.current = true; setAviso(null); }, []);

  const consultar = useCallback(async () => {
    const b = base.current;
    if (!b || cargando.current || enVuelo.current || pausadoRef.current) return;
    if (document.visibilityState !== 'visible' || hayDialogoAbierto()) return;
    enVuelo.current = true;
    try {
      const r = await api.post<Novedades>('/flito/tramites/novedades/buscar', { filtros: b.filtros, marca: b.marca, visibles: b.visibles });
      // Si mientras tanto hubo otra carga, la respuesta es de una línea base vieja: se descarta.
      if (base.current !== b) return;
      if (r.nuevos > 0 || r.actualizados > 0) { setAviso({ nuevos: r.nuevos, actualizados: r.actualizados }); setAnuncio(''); }
    } catch {
      // AC4: silencioso. Ni toast ni cambio del aviso que ya hubiera.
    } finally {
      enVuelo.current = false;
    }
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => { void consultar(); }, INTERVALO_NOVEDADES_MS);
    const alVolver = () => { if (document.visibilityState === 'visible') void consultar(); };
    document.addEventListener('visibilitychange', alVolver);
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', alVolver); };
  }, [consultar]);

  return { aviso, anuncio, iniciarCarga, fijarBase, falloCarga, ver };
}
