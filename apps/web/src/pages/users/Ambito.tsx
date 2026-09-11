// FLITO — el ÁMBITO del usuario: todo lo que ramifica por el tipo de enlace del rol, en un solo
 // archivo. Extraído de `pages/Users.tsx` sin cambios. HU #12175 / Feature #12072.
 // HU #12088: el switch es por `tipoEnlace` (catálogo `permisos_roles`), no por `role ===`.
 // Organismos unificados en `OrganismosField` (ex-`transito` deja de usar `FlitOrganismoCombobox`).
 //
 // Aquí viven las DOS caras del ámbito, que hasta ahora estaban a 400 líneas de distancia dentro de
 // la página y siempre se cambiaban juntas:
 //   · `AmbitoCelda`  — la celda «Ámbito» de la tabla (organismo, compañía, proveedor, organismos).
 //   · `AmbitoCampos` — el bloque de campos condicionados al enlace, idéntico en alta y en edición
 //                      salvo el `editando` que añade el aviso de re-login.
 //
 // **Esto NO es kit.** Mismo criterio que `AtaduraFields.tsx`: props tipadas, sin estado global, y
 // un único consumidor (la pantalla de usuarios).

import type { TipoEnlace } from '@operaciones/shared-types';
import type { User } from './types';
import { CompaniaField, COMPANIA_REQUERIDA, type CatalogoCompanias } from './CompaniaField';
import {
  OrganismosField, ProveedorSoatField, etiquetasOrganismos, nombreProveedor, resumenOrganismos,
  PROVEEDOR_REQUERIDO,
  type CatalogoOrganismos, type CatalogoProveedores,
} from './AtaduraFields';

// ─────────────────────────── Cara 1 · La celda «Ámbito» de la tabla ──────────────────────────────

export function AmbitoCelda({ user: u, tipoEnlace, nombreCompania, proveedores, organismos }: {
  user: User;
  /** Del mapa `codigo → tipoEnlace` cargado en `UsersGestion`. Si falta el rol, `ninguno`. */
  tipoEnlace: TipoEnlace;
  nombreCompania: (id: number) => string | null;
  proveedores: CatalogoProveedores;
  organismos: CatalogoOrganismos;
}) {
  return (
    <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
      {tipoEnlace === 'organismos_transito' ? (
        u.organismosCodigos.length > 0 ? (
          // `title` con la lista completa es COMPLEMENTARIO, nunca el único
          // portador: no existe para teclado ni para táctil. La lista entera está a
          // un clic, en «Editar», que es además donde se puede cambiar.
          <span
            className={organismos.data ? undefined : 'font-mono'}
            title={etiquetasOrganismos(organismos.data, u.organismosCodigos).join(', ')}
          >
            {resumenOrganismos(etiquetasOrganismos(organismos.data, u.organismosCodigos))}
          </span>
        ) : (
          <span style={{ color: 'var(--flit-warning)' }}>Sin asignar</span>
        )
      ) : tipoEnlace === 'compania' ? (
        u.companiaId ? (
          // Sin nombre en el catálogo —no cargó, o la compañía ya no está— se pinta
          // el id en monoespaciada. Un hueco en blanco se confundiría con «sin asignar».
          nombreCompania(u.companiaId)
            ? <span>{nombreCompania(u.companiaId)}</span>
            : <span className="font-mono">{u.companiaId}</span>
        ) : (
          <span style={{ color: 'var(--flit-warning)' }}>Sin asignar</span>
        )
      ) : tipoEnlace === 'proveedor_soat' ? (
        u.flitoProveedorSoatId ? (
          nombreProveedor(proveedores.data, u.flitoProveedorSoatId)
            ? <span>{nombreProveedor(proveedores.data, u.flitoProveedorSoatId)}</span>
            : <span className="font-mono">{u.flitoProveedorSoatId}</span>
        ) : (
          <span style={{ color: 'var(--flit-warning)' }}>Sin asignar</span>
        )
      ) : (
        '—'
      )}
    </td>
  );
}

// ───────────────────── Cara 2 · Los campos condicionados al enlace del formulario ─────────────────

/** Los tres valores de ámbito que el formulario mantiene en su estado (HU #12088: sin `transitoCodigo`). */
export interface ValoresAmbito {
  companiaId: string;
  flitoProveedorSoatId: string;
  organismosCodigos: string[];
}

/**
 * El bloque de ámbito del formulario: campos condicionados a `tipoEnlace`. La única diferencia
 * entre alta y edición es `editando` (aviso de re-login en proveedor / organismos).
 */
export function AmbitoCampos({
  tipoEnlace, editando, companias, proveedores, organismos, valores, onValores,
  errorCompania, setErrorCompania, errorProveedor, setErrorProveedor, errorOrganismos, setErrorOrganismos,
}: {
  tipoEnlace: TipoEnlace;
  editando?: boolean;
  companias: CatalogoCompanias;
  proveedores: CatalogoProveedores;
  organismos: CatalogoOrganismos;
  valores: ValoresAmbito;
  onValores: (parcial: Partial<ValoresAmbito>) => void;
  errorCompania: string | null;
  setErrorCompania: (v: string | null) => void;
  errorProveedor: string | null;
  setErrorProveedor: (v: string | null) => void;
  errorOrganismos: string | null;
  setErrorOrganismos: (v: string | null) => void;
}) {
  return (
    <>
      {tipoEnlace === 'compania' && (
        <CompaniaField
          companias={companias}
          value={valores.companiaId}
          onChange={(v) => { onValores({ companiaId: v }); if (v) setErrorCompania(null); }}
          error={errorCompania}
          onInvalido={() => setErrorCompania(COMPANIA_REQUERIDA)}
        />
      )}
      {tipoEnlace === 'proveedor_soat' && (
        <ProveedorSoatField
          proveedores={proveedores}
          value={valores.flitoProveedorSoatId}
          onChange={(v) => { onValores({ flitoProveedorSoatId: v }); if (v) setErrorProveedor(null); }}
          error={errorProveedor}
          onInvalido={() => setErrorProveedor(PROVEEDOR_REQUERIDO)}
          editando={editando}
        />
      )}
      {tipoEnlace === 'organismos_transito' && (
        <OrganismosField
          organismos={organismos}
          seleccionados={valores.organismosCodigos}
          onChange={(cs) => { onValores({ organismosCodigos: cs }); if (cs.length > 0) setErrorOrganismos(null); }}
          error={errorOrganismos}
          editando={editando}
        />
      )}
    </>
  );
}
