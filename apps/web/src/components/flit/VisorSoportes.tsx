// Visor de documentos: pide una lista de soportes a la ruta que se le indique y los enseña todos.
//
// No hay selección de qué mostrar: se pide todo y se lista lo que exista. Un trámite con los tres
// comprobantes cargados tiene que enseñar los tres, no el primero que se encontró.
//
// Nació dentro del reporte de costos y se sacó aquí al necesitarlo también la tabla de derechos de
// tránsito: quien mira un derecho quiere comprobar si el SOAT y el impuesto del mismo trámite están
// cargados, y hasta ahora tenía que salir a otra pantalla para averiguarlo. Se comparte el
// componente en vez de duplicarlo porque lo caro no es la maqueta, es que las dos copias se separen
// —una gana un origen nuevo y la otra no— y nadie se entere hasta que falte un documento.
//
// La RUTA es un parámetro por lo mismo: la lista se sirve desde cuatro sitios (finanzas, Gestión de
// trámites, el detalle de un SOAT y el de un impuesto) porque cada pantalla entra con un rol y una
// frontera distintas. Lo que cambia es de dónde se piden los documentos, no cómo se enseñan.

import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import FlitModal from './FlitModal';
import VisorPdf from './VisorPdf';
import { FlitEmpty } from './flitPageKit';

export interface Soporte {
  id: string; origen: string; tipo: string; nombreArchivo: string; url: string; subidoEn: string;
}

/** Cómo se nombra cada origen en el visor. Lo que no esté aquí se muestra tal cual. */
const ORIGEN_SOPORTE: Record<string, string> = {
  soat: 'SOAT', impuesto: 'Impuesto', derecho: 'Derecho de tránsito', logistica: 'Logística',
};

const fechaCorta = (iso: string | null) =>
  (iso === null ? null : new Date(iso).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: '2-digit' }));

export default function VisorSoportes({ ruta, titulo, vacio, onClose }: {
  /** Endpoint que devuelve `Soporte[]`. P. ej. `/flito/tramites/<id>/soportes`. */
  ruta: string;
  /** Cómo se llama lo que se mira, en el encabezado. Normalmente su id de FLIT o su placa. */
  titulo: string;
  /** Qué decir cuando no hay ningún documento. El default habla de un trámite. */
  vacio?: string;
  onClose: () => void;
}) {
  const [soportes, setSoportes] = useState<Soporte[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activo, setActivo] = useState<Soporte | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    api.get<Soporte[]>(ruta)
      // El activo se conserva entre recargas: al pedir la lista de nuevo no se pierde de vista el
      // documento que se estaba mirando.
      .then((s) => {
        const lista = Array.isArray(s) ? s : [];
        setSoportes(lista);
        setActivo((a) => lista.find((x) => x.id === a?.id) ?? lista[0] ?? null);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [ruta, nonce]);

  return (
    // `full`: un PDF a 448 px de ancho no se lee sin hacer zoom. El visor ocupa casi toda la
    // pantalla y la lista de documentos pasa a una columna lateral, que es la forma de no gastar
    // altura del documento en pastillas.
    <FlitModal title={`Documentos de ${titulo}`} onClose={onClose} full>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!soportes && !error && <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando…</p>}
      {soportes && soportes.length === 0 && (
        <FlitEmpty>{vacio ?? 'Este trámite no tiene ningún documento cargado todavía.'}</FlitEmpty>
      )}
      {soportes && soportes.length > 0 && (
        <div className="flex h-full min-h-0 gap-4">
          <aside className="flex w-64 shrink-0 flex-col gap-2 overflow-y-auto">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span style={{ color: 'var(--flit-text-secondary)' }}>{soportes.length} documento(s)</span>
              {/* Un comprobante cargado en otra pestaña aparece sin cerrar y volver a abrir. */}
              <button type="button" className="underline" style={{ color: 'var(--flit-blue-text)' }}
                onClick={() => setNonce((n) => n + 1)}>Actualizar</button>
            </div>
            {soportes.map((s) => {
              const activa = activo?.id === s.id;
              return (
                <button key={s.id} type="button" onClick={() => setActivo(s)}
                  className="rounded-lg border px-3 py-2 text-left text-xs transition-colors"
                  style={activa
                    ? { borderColor: 'var(--flit-blue-text)', background: 'rgba(48,102,190,0.08)' }
                    : { borderColor: 'var(--flit-border-input)' }}>
                  <div className="font-semibold" style={{ color: 'var(--flit-blue-text)' }}>
                    {ORIGEN_SOPORTE[s.origen] ?? s.origen}
                  </div>
                  <div className="break-all" style={{ color: 'var(--flit-text-secondary)' }}>{s.nombreArchivo}</div>
                  <div style={{ color: 'var(--flit-text-muted)' }}>{fechaCorta(s.subidoEn) ?? ''}</div>
                </button>
              );
            })}
          </aside>
          <div className="min-h-0 min-w-0 flex-1">
            {activo && <VisorPdf key={activo.id} url={activo.url} nombre={activo.nombreArchivo} />}
          </div>
        </div>
      )}
    </FlitModal>
  );
}
