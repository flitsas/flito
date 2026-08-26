// Alta y redefinición de una bolsa de tránsito (HU #11161, ajuste 0124).
//
// Una bolsa se define con tres cosas: cómo se llama, a qué secretarías le aplica y qué cobros
// maneja. El producto de las dos listas es su cobertura, y por eso el formulario es el mismo para
// crear y para editar: en los dos casos lo que se manda es el estado final completo, no un cambio.
//
// La regla que el usuario tiene que entender aquí es que una secretaría no puede repetir concepto
// entre bolsas. No se comprueba en el navegador: el servidor la impone con un índice único y
// devuelve un 409 que dice exactamente qué se solapa. Duplicar esa comprobación aquí solo serviría
// para que un día la pantalla dijera que sí y el servidor que no.

import { useEffect, useState } from 'react';
import {
  CONCEPTO_BOLSA_TRANSITO_LABEL, CONCEPTOS_BOLSA_TRANSITO, type ConceptoBolsaTransito,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../../lib/api';
import Campo from './BolsaCampo';
import FlitModal from '../flit/FlitModal';
import {
  flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../flit/flitPageKit';

export interface OrganismoOpcion {
  codigo: string;
  nombre: string;
  ciudad: string;
  alias: string | null;
}

interface Props {
  /** Presente al editar; ausente al crear. */
  bolsaId?: string;
  inicial?: { nombre: string; organismos: string[]; conceptos: ConceptoBolsaTransito[] };
  onClose: () => void;
  onHecho: () => void;
}

function etiquetaOrganismo(o: OrganismoOpcion): string {
  return o.alias?.trim() || `${o.ciudad} — ${o.nombre}`;
}

export default function BolsaTransitoForm({ bolsaId, inicial, onClose, onHecho }: Props) {
  const editando = Boolean(bolsaId);
  const [nombre, setNombre] = useState(inicial?.nombre ?? '');
  const [organismos, setOrganismos] = useState<string[]>(inicial?.organismos ?? []);
  const [conceptos, setConceptos] = useState<ConceptoBolsaTransito[]>(inicial?.conceptos ?? []);
  const [catalogo, setCatalogo] = useState<OrganismoOpcion[]>([]);
  const [busqueda, setBusqueda] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<OrganismoOpcion[]>('/transito/organismos-config')
      .then((o) => setCatalogo(Array.isArray(o) ? o : []))
      // Sin catálogo no se puede elegir secretaría, y el formulario lo dice en vez de quedarse en
      // blanco: es un fallo de red, no una lista vacía.
      .catch((e) => setError(errorMessage(e)));
  }, []);

  const visibles = catalogo.filter((o) => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return true;
    return etiquetaOrganismo(o).toLowerCase().includes(q) || o.codigo.includes(q);
  });

  const alternar = <T,>(lista: T[], valor: T): T[] =>
    lista.includes(valor) ? lista.filter((v) => v !== valor) : [...lista, valor];

  const puedeGuardar = nombre.trim().length >= 3 && organismos.length > 0 && conceptos.length > 0 && !enviando;

  async function guardar() {
    if (!puedeGuardar) return;
    setEnviando(true);
    setError(null);
    try {
      const cuerpo = { nombre: nombre.trim(), organismos, conceptos };
      if (editando) await api.patch(`/flito/bolsas/transito/${bolsaId}`, cuerpo);
      else await api.post('/flito/bolsas/transito', cuerpo);
      onHecho();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <FlitModal title={editando ? 'Editar bolsa de tránsito' : 'Crear bolsa de tránsito'} onClose={onClose} wide>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); guardar(); }}>
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          FLIT le transfiere dinero a esta bolsa y quien la opera paga con ella ante las secretarías
          que elijas. Cada vez que se pague uno de los cobros marcados en una de esas secretarías, el
          valor se descuenta de aquí.
        </p>

        <Campo etiqueta="Nombre de la bolsa *"
          error={nombre.trim() !== '' && nombre.trim().length < 3 ? 'Al menos 3 caracteres.' : null}>
          <input type="text" className={flitInp} value={nombre} maxLength={120} required
            placeholder="Ej. Bolsa de mi sector" onChange={(e) => setNombre(e.target.value)} />
        </Campo>

        <fieldset>
          <legend className="mb-1 text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            Cobros que maneja * ({conceptos.length} seleccionado{conceptos.length === 1 ? '' : 's'})
          </legend>
          <div className="flex flex-wrap gap-3">
            {CONCEPTOS_BOLSA_TRANSITO.map((c) => (
              <label key={c} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={conceptos.includes(c)}
                  onChange={() => setConceptos((prev) => alternar(prev, c))} />
                {CONCEPTO_BOLSA_TRANSITO_LABEL[c]}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-1 text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            Secretarías a las que aplica * ({organismos.length} seleccionada{organismos.length === 1 ? '' : 's'})
          </legend>
          <input type="search" className={`${flitInp} mb-2`} value={busqueda}
            placeholder="Buscar secretaría…" aria-label="Buscar secretaría"
            onChange={(e) => setBusqueda(e.target.value)} />
          <div className="max-h-56 overflow-y-auto rounded-lg border p-2"
            style={{ borderColor: 'var(--flit-border-soft)' }}>
            {visibles.length === 0 ? (
              <p className="p-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
                Ninguna secretaría coincide con la búsqueda.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {visibles.map((o) => (
                  <li key={o.codigo}>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={organismos.includes(o.codigo)}
                        onChange={() => setOrganismos((prev) => alternar(prev, o.codigo))} />
                      <span className="truncate" title={etiquetaOrganismo(o)}>{etiquetaOrganismo(o)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </fieldset>

        {error && <p className="text-sm" style={{ color: 'var(--flit-danger)' }} role="alert">{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={!puedeGuardar}>
            {enviando ? 'Guardando…' : (editando ? 'Guardar cambios' : 'Crear bolsa')}
          </button>
        </div>
      </form>
    </FlitModal>
  );
}
