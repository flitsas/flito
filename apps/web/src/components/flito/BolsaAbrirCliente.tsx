// Abrir la bolsa de un cliente que todavía no la tiene (HU #11210, AC3 y AC4).
//
// No hay un endpoint de «crear bolsa» y no hace falta: la bolsa NACE con la primera recarga, así que
// esto es el mismo formulario de recarga con un paso previo —elegir la compañía— y por eso reutiliza
// `ModalRecarga` en vez de repetirlo. Lo que sí es propio de aquí es la lista de candidatas: solo se
// ofrecen las compañías SIN bolsa, porque para las que ya la tienen la acción correcta es recargar
// desde su detalle, no «abrir» una segunda.

import { useState } from 'react';
import Campo from './BolsaCampo';
import { ModalRecarga } from './BolsaAcciones';
import FlitModal from '../flit/FlitModal';
import { FlitEmpty, flitInp, flitBtnSecondary, flitBtnSecondaryStyle } from '../flit/flitPageKit';

export interface ClienteOpcion {
  id: number;
  name: string;
}

export default function BolsaAbrirCliente({ candidatos, onClose, onHecho }: {
  /** Compañías sin bolsa. Las que ya tienen una no aparecen. */
  candidatos: ClienteOpcion[];
  onClose: () => void;
  onHecho: () => void;
}) {
  const [companiaId, setCompaniaId] = useState<number | null>(null);

  // AC4: sin candidatas no se enseña un formulario que no puede completarse.
  if (candidatos.length === 0) {
    return (
      <FlitModal title="Abrir la bolsa de un cliente" onClose={onClose}>
        <FlitEmpty>
          <span data-testid="sin-clientes-por-abrir">
            Todas las compañías tienen ya su bolsa abierta. Para sumarle saldo a alguna, entra a su
            detalle desde el tablero y registra una recarga.
          </span>
        </FlitEmpty>
        <div className="mt-4 flex justify-end">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>
            Cerrar
          </button>
        </div>
      </FlitModal>
    );
  }

  return (
    <ModalRecarga
      companiaId={companiaId}
      titulo="Abrir la bolsa de un cliente"
      onClose={onClose}
      onRefrescar={onHecho}
      intro={
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          La bolsa se abre con esta primera recarga. Desde ese momento, cada trámite de la compañía
          descuenta de este saldo y aparece en el tablero.
        </p>
      }
      selector={
        <Campo etiqueta="Compañía *">
          <select className={flitInp} value={companiaId ?? ''} required
            aria-label="Compañía a la que abrirle bolsa"
            onChange={(e) => setCompaniaId(e.target.value === '' ? null : Number(e.target.value))}>
            <option value="">Elige una compañía…</option>
            {candidatos.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Campo>
      }
    />
  );
}
