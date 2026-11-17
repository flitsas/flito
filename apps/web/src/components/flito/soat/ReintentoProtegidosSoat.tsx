// Reintento de los PDF protegidos con contraseña de la carga masiva de SOAT (BUG #14569).
//
// El API devuelve en `protegidos` los PDF cifrados que no pudo abrir (sin clave o con una que no
// los abre). Aquí cada archivo se reintenta probando su nombre como contraseña («Usar el nombre»,
// marcado por defecto) o con UNA contraseña escrita, y se reenvían SOLO esos archivos, en tandas
// del mismo tamaño que la carga, con `nombresComoClave` y/o `contrasenas` alineados por posición a
// cada tanda. Cada campo viaja solo si la tanda lo usa (`enviarCargaEnTandas`): el API cuenta los
// límites por la presencia del campo. Un archivo cuyo nombre no lo abrió vuelve DESMARCADO, para
// no repetir el mismo intento.
//
// Cada fila de `protegidos` se ata al `ItemCarga` de la selección que la produjo (índice en
// `seleccion.items`). Atarla por nombre en cada render no sirve: dos entradas de ZIP pueden llamarse
// igual, y tras un reintento el orden de la lista cambia. El emparejamiento por nombre se hace una
// sola vez, al llegar la respuesta, y solo contra los archivos que viajaron en ESA petición.
//
// La clave vive solo en el estado de este componente y en el cuerpo multipart: nunca en la URL,
// en `localStorage` ni en `console`. Se borra de cada archivo en cuanto se envía.

import { useId, useState } from 'react';
import { RotateCw } from 'lucide-react';
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

/** Nombre del archivo y, si se repite en la lista, de qué ZIP/ruta salió. */
function nombreDe(item: ItemCarga, repetido: boolean, n: number): string {
  if (!repetido) return item.nombre;
  const origen = [item.zip, item.ruta].filter(Boolean).join(' › ');
  return `${item.nombre} (${origen || `archivo ${n}`})`;
}

const AYUDA_NOMBRE_NO_ABRE = 'El nombre del archivo no abre este PDF. Escribe la contraseña.';
const CASILLA = 'inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-1 text-sm transition-colors hover:bg-[var(--flit-bg-hover)] lg:min-h-8';

export default function ReintentoProtegidosSoat({ resultado, itemsProtegidos, items, onActualizar }: {
  resultado: ResultadoMasivoSoat;
  /** Alineado con `resultado.protegidos`: índice en `items` de cada fila, o `null`. */
  itemsProtegidos: (number | null)[];
  items: readonly ItemCarga[];
  onActualizar: (resultado: ResultadoMasivoSoat, itemsProtegidos: (number | null)[]) => void;
}) {
  const [claves, setClaves] = useState<Record<number, string>>({});
  // «Usar el nombre» por archivo (índice en `items`). Ausente = marcada (defecto).
  const [desmarcados, setDesmarcados] = useState<Record<number, true>>({});
  // Archivos cuyo nombre ya se probó y no los abrió: llevan la ayuda bajo el campo.
  const [nombreFallo, setNombreFallo] = useState<Record<number, true>>({});
  const idTodos = useId();
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
  const usaNombre = (idx: number) => !desmarcados[idx];
  const claveDe = (idx: number) => (usaNombre(idx) ? '' : (claves[idx] ?? ''));
  const enviables = filas.filter((f) => usaNombre(f.idx) || claveDe(f.idx) !== '');
  const marcadas = filas.filter((f) => usaNombre(f.idx)).length;
  const todos = marcadas === filas.length;
  const mezcla = marcadas > 0 && !todos;

  const marcar = (indices: readonly number[], si: boolean) => setDesmarcados((prev) => {
    const sig = { ...prev };
    for (const i of indices) { if (si) delete sig[i]; else sig[i] = true; }
    return sig;
  });

  const reintentar = async () => {
    if (enviables.length === 0 || enviando) return;
    setError(null);
    const lote = enviables.map((f) => items[f.idx]);
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
        {
          conRutas: false,
          contrasenaDe: (item) => claveDe(items.indexOf(item)),
          nombreComoClaveDe: (item) => usaNombre(items.indexOf(item)),
        },
      );
      if (!r) { setError(err ?? 'No se pudo reintentar la carga. Intenta de nuevo.'); break; }
      const quitar = new Set(enviados);
      const quedan = (acc.protegidos ?? [])
        .map((p, i) => ({ p, idx: accIdx[i] ?? null }))
        .filter((f) => f.idx === null || !quitar.has(f.idx));
      acc = fusionarResultadoCarga<ResultadoMasivoSoat>({ ...acc, protegidos: quedan.map((f) => f.p) }, r);
      const vuelven = emparejarProtegidos(r.protegidos ?? [], items, enviados);
      accIdx = [...quedan.map((f) => f.idx), ...vuelven];
      onActualizar(acc, accIdx);
      // Lo que se probó por nombre y volvió protegido queda desmarcado y con su ayuda; lo que se
      // probó con clave pierde la ayuda del nombre (manda la de la clave, por `detalle`).
      const porNombre = new Set(enviados.filter((i) => usaNombre(i)));
      const fallaronNombre = vuelven.filter((i): i is number => i !== null && porNombre.has(i));
      marcar(fallaronNombre, false);
      setNombreFallo((prev) => {
        const sig = { ...prev };
        for (const i of enviados) delete sig[i];
        for (const i of fallaronNombre) sig[i] = true;
        return sig;
      });
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
    <section aria-labelledby="titulo-protegidos-soat" className="space-y-3 rounded-lg border p-3"
      style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-app)' }}>
      <div>
        <h3 id="titulo-protegidos-soat" className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
          PDF protegidos con contraseña
        </h3>
        <p className="mt-0.5 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          Con «Usar el nombre» se prueba el nombre del archivo como contraseña; si no, escribe la contraseña. Los que no tengan ninguna de las dos no se envían.
        </p>
      </div>
      <label htmlFor={idTodos} className={`${CASILLA} font-semibold`} style={{ color: 'var(--flit-text-primary)' }}>
        <input id={idTodos} type="checkbox" className="flit-focus size-4 shrink-0 cursor-pointer"
          checked={todos} disabled={enviando !== null}
          ref={(el) => { if (el) el.indeterminate = mezcla; }}
          onChange={(e) => marcar(filas.map((f) => f.idx), e.target.checked)} />
        Usar el nombre en todos
      </label>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {filas.map((f, n) => {
          const item = items[f.idx];
          const nombre = nombreDe(item, (cuenta.get(item.nombre) ?? 0) > 1, n + 1);
          const marcada = usaNombre(f.idx);
          const ayuda = nombreFallo[f.idx] ? AYUDA_NOMBRE_NO_ABRE
            : /no abre/i.test(f.p.detalle) ? 'La contraseña no abre este PDF.' : null;
          return (
            <li key={f.idx} className="min-w-0 space-y-2 rounded-md border p-2"
              style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-card)' }}>
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="min-w-0 break-all text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>{nombre}</span>
                <label className={CASILLA} style={{ color: 'var(--flit-text-primary)' }}>
                  <input type="checkbox" className="flit-focus size-4 shrink-0 cursor-pointer" checked={marcada}
                    disabled={enviando !== null} onChange={(e) => marcar([f.idx], e.target.checked)} />
                  Usar el nombre<span className="sr-only"> de {nombre}</span>
                </label>
              </div>
              {!marcada && (
                <CampoContrasenaPdf label={`Contraseña de ${nombre}`} rotulo="Contraseña"
                  valor={claves[f.idx] ?? ''} disabled={enviando !== null}
                  onCambio={(v) => setClaves((prev) => ({ ...prev, [f.idx]: v }))} ayuda={ayuda} />
              )}
            </li>
          );
        })}
      </ul>
      {error && <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-text)' }}>{error}</p>}
      {enviando && (
        <p role="status" className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          Reintentando {Math.min(enviando.hechos + 1, enviando.total)} de {enviando.total}…
        </p>
      )}
      <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
        disabled={enviando !== null || enviables.length === 0} onClick={() => { void reintentar(); }}>
        <RotateCw size={16} aria-hidden="true" className="shrink-0" />
        {enviando ? 'Reintentando…' : 'Reintentar con contraseña'}
      </button>
    </section>
  );
}
