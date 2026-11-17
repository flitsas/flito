// Reintento de los PDF protegidos con contraseña de la carga masiva de SOAT (BUG #14569).
//
// El API devuelve en `protegidos` los PDF cifrados que no pudo abrir (sin clave o con una que no
// los abre). Aquí se pide UNA contraseña por archivo y se reenvían SOLO esos archivos, en tandas
// del mismo tamaño que la carga, con `contrasenas` alineado por posición a cada tanda.
//
// Cada fila de `protegidos` se ata al `ItemCarga` de la selección que la produjo (índice en
// `seleccion.items`). Atarla por nombre en cada render no sirve: dos entradas de ZIP pueden llamarse
// igual, y tras un reintento el orden de la lista cambia. El emparejamiento por nombre se hace una
// sola vez, al llegar la respuesta, y solo contra los archivos que viajaron en ESA petición.
//
// La clave vive solo en el estado de este componente y en el cuerpo multipart: nunca en la URL,
// en `localStorage` ni en `console`. Se borra de cada archivo en cuanto se envía.

import { useState } from 'react';
import { Icono } from '../../flit/kit/Icono';
import { partirCargaMasivaEnTandas } from '@operaciones/shared-types';
import { enviarCargaEnTandas, fusionarResultadoCarga, type ItemCarga } from '../../../lib/carga-masiva';
import { flitBtnPrimary, flitBtnPrimaryStyle } from '../../flit/flitPageKit';
import CampoContrasenaPdf from './CampoContrasenaPdf';

export type FilaCargaSoat = { archivo: string; detalle: string };

export interface ResultadoMasivoSoat {
  pagados: FilaCargaSoat[]; enRevision: FilaCargaSoat[];
  duplicados: FilaCargaSoat[]; noAsociados: FilaCargaSoat[];
  /** BUG #14569. Opcional: una respuesta sin la clave se trata como lista vacía. */
  protegidos?: (FilaCargaSoat & { placa?: string | null; soatId?: string | null })[];
}

const RUTA_FACTURAS = '/flito/soat/facturas';

/**
 * Índice en `items` de cada fila de `protegidos`, buscándolo SOLO entre `enviados` (los índices
 * que viajaron en la petición que devolvió esas filas): el primero aún libre con el mismo nombre.
 * `null` = no se encontró (el reintento no la puede reenviar; se queda como fila informativa).
 */
export function emparejarProtegidos(
  protegidos: readonly FilaCargaSoat[], items: readonly ItemCarga[], enviados: readonly number[],
): (number | null)[] {
  const libres = [...enviados];
  return protegidos.map((p) => {
    const pos = libres.findIndex((i) => items[i]?.nombre === p.archivo);
    if (pos < 0) return null;
    return libres.splice(pos, 1)[0];
  });
}

/** Rótulo del campo: el nombre y, si se repite en la lista, de qué ZIP/ruta salió. */
function etiquetaDe(item: ItemCarga, repetido: boolean, n: number): string {
  if (!repetido) return `Contraseña de ${item.nombre}`;
  const origen = [item.zip, item.ruta].filter(Boolean).join(' › ');
  return `Contraseña de ${item.nombre} (${origen || `archivo ${n}`})`;
}

export default function ReintentoProtegidosSoat({ resultado, itemsProtegidos, items, onActualizar }: {
  resultado: ResultadoMasivoSoat;
  /** Alineado con `resultado.protegidos`: índice en `items` de cada fila, o `null`. */
  itemsProtegidos: (number | null)[];
  items: readonly ItemCarga[];
  onActualizar: (resultado: ResultadoMasivoSoat, itemsProtegidos: (number | null)[]) => void;
}) {
  const [claves, setClaves] = useState<Record<number, string>>({});
  const [enviando, setEnviando] = useState<{ hechos: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const protegidos = resultado.protegidos ?? [];
  // Vacío: sin protegidos (o ninguno reenviable) la sección no existe.
  const filas = protegidos
    .map((p, i) => ({ p, idx: itemsProtegidos[i] ?? null }))
    .filter((f): f is { p: typeof f.p; idx: number } => f.idx !== null && items[f.idx] !== undefined);
  if (filas.length === 0) return null;

  const cuenta = new Map<string, number>();
  for (const f of filas) cuenta.set(items[f.idx].nombre, (cuenta.get(items[f.idx].nombre) ?? 0) + 1);
  const conClave = filas.filter((f) => (claves[f.idx] ?? '') !== '');

  const reintentar = async () => {
    if (conClave.length === 0 || enviando) return;
    setError(null);
    const lote = conClave.map((f) => items[f.idx]);
    const tandas = partirCargaMasivaEnTandas(lote);
    let acc = resultado;
    let accIdx = itemsProtegidos;
    let hechos = 0;
    setEnviando({ hechos, total: lote.length });
    // Una tanda por llamada: si la k-ésima falla, las anteriores ya quedaron fusionadas y sus filas
    // fuera de `protegidos`; lo no enviado conserva su clave para el siguiente intento.
    for (const tanda of tandas) {
      const enviados = tanda.map((item) => items.indexOf(item));
      const { resultado: r, error: err } = await enviarCargaEnTandas<ResultadoMasivoSoat>(
        RUTA_FACTURAS, tanda, () => undefined, undefined,
        { conRutas: false, contrasenaDe: (item) => claves[items.indexOf(item)] ?? '' },
      );
      if (!r) { setError(err ?? 'No se pudo reintentar la carga. Intenta de nuevo.'); break; }
      const quitar = new Set(enviados);
      const quedan = (acc.protegidos ?? [])
        .map((p, i) => ({ p, idx: accIdx[i] ?? null }))
        .filter((f) => f.idx === null || !quitar.has(f.idx));
      acc = fusionarResultadoCarga<ResultadoMasivoSoat>({ ...acc, protegidos: quedan.map((f) => f.p) }, r);
      accIdx = [...quedan.map((f) => f.idx), ...emparejarProtegidos(r.protegidos ?? [], items, enviados)];
      onActualizar(acc, accIdx);
      setClaves((prev) => {
        const sig = { ...prev };
        for (const i of enviados) delete sig[i];
        return sig;
      });
      hechos += tanda.length;
      setEnviando({ hechos, total: lote.length });
      if (err) { setError(err); break; }
    }
    setEnviando(null);
  };

  return (
    <section aria-labelledby="titulo-protegidos-soat" className="space-y-3 rounded-[9px] border p-3"
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
      <div>
        <h3 id="titulo-protegidos-soat" className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>
          PDF protegidos con contraseña
        </h3>
        <p className="mt-0.5 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          Escribe la contraseña de cada archivo que quieras cargar y reinténtalo. Los que dejes en blanco no se envían.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {filas.map((f, n) => {
          const item = items[f.idx];
          return (
            <CampoContrasenaPdf key={f.idx} label={etiquetaDe(item, (cuenta.get(item.nombre) ?? 0) > 1, n + 1)}
              valor={claves[f.idx] ?? ''} disabled={enviando !== null}
              onCambio={(v) => setClaves((prev) => ({ ...prev, [f.idx]: v }))}
              ayuda={/no abre/i.test(f.p.detalle) ? 'La contraseña no abre este PDF.' : null} />
          );
        })}
      </div>
      {error && <p role="alert" className="text-sm" style={{ color: 'var(--kit-rojo-texto)' }}>{error}</p>}
      {enviando && (
        <p role="status" className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          Reintentando {Math.min(enviando.hechos + 1, enviando.total)} de {enviando.total}…
        </p>
      )}
      <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
        disabled={enviando !== null || conClave.length === 0} onClick={() => { void reintentar(); }}>
        <Icono nombre="reintento" size={16} className="shrink-0" />
        {enviando ? 'Reintentando…' : 'Reintentar con contraseña'}
      </button>
    </section>
  );
}
