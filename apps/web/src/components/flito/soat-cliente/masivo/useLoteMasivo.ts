// HU #14134 — estado de la carga masiva: archivo, subida, polling del avance y descargas.
//
// Reglas (docs/ux/flito-soat-carga-masiva-renovaciones.md):
//  · Polling cada 2,5 s con UNA petición en vuelo; se cancela al salir (AC6), se pausa con
//    `document.hidden` y se detiene ante un error hasta «Reintentar». Sin SSE.
//  · Privacidad (ADR-0032): al terminar el lote el servidor borra placa/VIN/vehículo de las filas
//    creadas y por validar. Lo recibido antes se conserva SOLO en memoria (estado de este hook:
//    nunca storage, URL ni consola) y se fusiona por `nFila`. Se descarta al desmontar.
import { useCallback, useEffect, useState } from 'react';
import { toastError, toastOk } from '../../../flit/ToastFlito';
import { ApiError, api } from '../../../../lib/api';
import { COPY_COMUN, COPY_MASIVO, codigoDe, errorDeSubida, type ErrorSubida } from './copyMasivo';
import type { AvanceLoteDto, FilaLote, LoteCreadoDto, TipoMasivo } from './tiposMasivo';

const BASE_MASIVO = '/flito/soat/cliente/masivo';
const INTERVALO_MS = 2_500;
const EXTENSION_XLSX = /\.xlsx$/i;

/** Un campo no-null ya recibido no se pierde porque el sondeo final lo traiga null (ADR-0032). */
function fusionar(previas: FilaLote[], nuevas: FilaLote[]): FilaLote[] {
  const antes = new Map(previas.map((f) => [f.nFila, f]));
  return nuevas.map((f) => {
    const o = antes.get(f.nFila);
    return o
      ? { ...f, placa: f.placa ?? o.placa, vin: f.vin ?? o.vin, marca: f.marca ?? o.marca, linea: f.linea ?? o.linea, modelo: f.modelo ?? o.modelo }
      : f;
  });
}

export type ErrorAvance = 'red' | 'no_encontrado';

export function useLoteMasivo(tipo: TipoMasivo, companiaId: number | undefined) {
  const [archivo, setArchivo] = useState<File | null>(null);
  const [errorArchivo, setErrorArchivo] = useState<string | null>(null);
  const [subiendo, setSubiendo] = useState(false);
  const [errorSubida, setErrorSubida] = useState<ErrorSubida | null>(null);
  const [loteId, setLoteId] = useState<string | null>(null);
  const [avance, setAvance] = useState<AvanceLoteDto | null>(null);
  const [filas, setFilas] = useState<FilaLote[]>([]);
  const [errorAvance, setErrorAvance] = useState<ErrorAvance | null>(null);
  const [descargando, setDescargando] = useState<'plantilla' | 'rechazadas' | null>(null);
  const [rechazadasVencidas, setRechazadasVencidas] = useState(false);
  const terminado = avance?.estado === 'terminado';

  const elegirArchivo = useCallback((f: File) => {
    setErrorSubida(null);
    if (!EXTENSION_XLSX.test(f.name)) { setArchivo(null); setErrorArchivo(COPY_COMUN.soloXlsx); return; }
    setErrorArchivo(null);
    setArchivo(f);
  }, []);

  const subir = useCallback(async () => {
    if (!archivo || subiendo) return;
    setSubiendo(true);
    setErrorSubida(null);
    try {
      const campos: Record<string, string> = { tipo };
      if (companiaId !== undefined) campos.companiaId = String(companiaId);
      const r = await api.upload<LoteCreadoDto>(BASE_MASIVO, archivo, 'archivo', campos);
      setAvance(null);
      setFilas([]);
      setErrorAvance(null);
      setLoteId(r.loteId);
      setArchivo(null);
      toastOk(COPY_MASIVO[tipo].toastRecibido, { id: 'soat-masivo-recibido' });
    } catch (e) {
      const err = errorDeSubida(e, tipo);
      setErrorSubida(err);
      if (err.accion !== 'reintentar') setArchivo(null);
    } finally {
      setSubiendo(false);
    }
  }, [archivo, companiaId, subiendo, tipo]);

  // Polling del avance. El cleanup (salir de la vista, cambiar de lote, error, terminado) lo cancela.
  useEffect(() => {
    if (!loteId || errorAvance || terminado) return undefined;
    let vivo = true;
    let enVuelo = false;
    let timer: number | undefined;
    const leer = async () => {
      timer = undefined;
      if (!vivo || enVuelo || document.hidden) return;
      enVuelo = true;
      let seguir: boolean;
      try {
        const a = await api.get<AvanceLoteDto>(`${BASE_MASIVO}/${encodeURIComponent(loteId)}`);
        if (!vivo) return;
        setFilas((previas) => fusionar(previas, a.filas ?? []));
        setAvance(a);
        seguir = a.estado !== 'terminado';
      } catch (e) {
        if (!vivo) return;
        setErrorAvance(e instanceof ApiError && e.status === 404 ? 'no_encontrado' : 'red');
        seguir = false;
      } finally {
        enVuelo = false;
      }
      if (vivo && seguir) timer = window.setTimeout(leer, INTERVALO_MS);
    };
    const alCambiarVisibilidad = () => {
      if (document.hidden || enVuelo) return;
      if (timer !== undefined) window.clearTimeout(timer);
      void leer();
    };
    document.addEventListener('visibilitychange', alCambiarVisibilidad);
    void leer();
    return () => {
      vivo = false;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', alCambiarVisibilidad);
    };
  }, [loteId, errorAvance, terminado]);

  const reintentarAvance = useCallback(() => setErrorAvance(null), []);

  const reiniciar = useCallback(() => {
    setLoteId(null); setAvance(null); setFilas([]); setErrorAvance(null);
    setArchivo(null); setErrorArchivo(null); setErrorSubida(null); setRechazadasVencidas(false);
  }, []);

  const descargarPlantilla = useCallback(async () => {
    setDescargando('plantilla');
    try {
      await api.download(`${BASE_MASIVO}/plantilla?tipo=${tipo}`, COPY_MASIVO[tipo].nombrePlantilla);
    } catch {
      toastError(COPY_COMUN.falloDescarga, undefined, { id: 'soat-masivo-descarga' });
    } finally {
      setDescargando(null);
    }
  }, [tipo]);

  const descargarRechazadas = useCallback(async () => {
    if (!loteId) return;
    setDescargando('rechazadas');
    try {
      await api.download(`${BASE_MASIVO}/${encodeURIComponent(loteId)}/rechazadas`, COPY_MASIVO[tipo].nombreRechazadas);
      toastOk('Rechazadas descargadas.', { id: 'soat-masivo-descarga' });
    } catch (e) {
      const codigo = codigoDe(e);
      if (codigo === 'descarga_no_disponible') {
        setRechazadasVencidas(true);
        toastError(COPY_COMUN.rechazadasVencidas, undefined, { id: 'soat-masivo-descarga' });
      } else {
        toastError(codigo === 'lote_en_proceso' ? COPY_COMUN.rechazadasEnProceso : COPY_COMUN.falloDescarga, undefined, { id: 'soat-masivo-descarga' });
      }
    } finally {
      setDescargando(null);
    }
  }, [loteId, tipo]);

  return {
    archivo, errorArchivo, subiendo, errorSubida, loteId, avance, filas, errorAvance, descargando, rechazadasVencidas, terminado,
    enCurso: loteId !== null && !terminado && errorAvance !== 'no_encontrado',
    elegirArchivo, subir, reintentarAvance, reiniciar, descargarPlantilla, descargarRechazadas,
  };
}
