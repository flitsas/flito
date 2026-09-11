// FLITO — el ÁMBITO del usuario: todo lo que ramifica por el tipo de enlace del rol, en un solo
// archivo. Extraído de `pages/Users.tsx` sin cambios. HU #12175 / Feature #12072.
//
// Aquí viven las DOS caras del ámbito, que hasta ahora estaban a 400 líneas de distancia dentro de
// la página y siempre se cambiaban juntas:
//   · `AmbitoCelda`  — la celda «Ámbito» de la tabla (organismo, compañía, proveedor, organismos).
//   · `AmbitoCampos` — el bloque de campos condicionados al rol, idéntico en alta y en edición
//                      salvo el `editando` que añade el aviso de re-login.
//
// Las cadenas `role === '…'` que hay dentro son el rol del usuario EDITADO —no guardas de
// autorización—, y se mueven tal cual: quien las convierta en un enlace declarado es la HU #12088,
// y este archivo es el único que tiene que abrir para hacerlo.
//
// **Esto NO es kit.** Mismo criterio que `AtaduraFields.tsx`: props tipadas, sin estado global, y
// un único consumidor (la pantalla de usuarios).

import { getOrganismoByCodigo } from '@operaciones/shared-types';
import FlitOrganismoCombobox from '../../components/flit/FlitOrganismoCombobox';
import type { UserRole } from '../../lib/permissions';
import type { User } from './types';
import { Field } from './UserFormShared';
import { CompaniaField, COMPANIA_REQUERIDA, type CatalogoCompanias } from './CompaniaField';
import {
  OrganismosField, ProveedorSoatField, etiquetasOrganismos, nombreProveedor, resumenOrganismos,
  PROVEEDOR_REQUERIDO,
  type CatalogoOrganismos, type CatalogoProveedores,
} from './AtaduraFields';

// ─────────────────────────── Cara 1 · La celda «Ámbito» de la tabla ──────────────────────────────

export function AmbitoCelda({ user: u, nombreCompania, proveedores, organismos }: {
  user: User;
  nombreCompania: (id: number) => string | null;
  proveedores: CatalogoProveedores;
  organismos: CatalogoOrganismos;
}) {
  return (
    <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
      {u.role === 'transito' ? (
        u.transitoCodigo ? (
          (() => {
            const org = getOrganismoByCodigo(u.transitoCodigo);
            return org ? (
              <span title={`${org.nombre} · ${org.codigo}`}>{org.ciudad}</span>
            ) : (
              <span className="font-mono">{u.transitoCodigo}</span>
            );
          })()
        ) : (
          <span style={{ color: 'var(--flit-warning)' }}>Sin asignar</span>
        )
      ) : u.role === 'cliente' ? (
        u.companiaId ? (
          // Sin nombre en el catálogo —no cargó, o la compañía ya no está— se pinta
          // el id en monoespaciada, igual que hace la rama de tránsito con un código
          // fuera de catálogo. Un hueco en blanco se confundiría con «sin asignar».
          nombreCompania(u.companiaId)
            ? <span>{nombreCompania(u.companiaId)}</span>
            : <span className="font-mono">{u.companiaId}</span>
        ) : (
          <span style={{ color: 'var(--flit-warning)' }}>Sin asignar</span>
        )
      ) : u.role === 'proveedor' ? (
        u.flitoProveedorSoatId ? (
          nombreProveedor(proveedores.data, u.flitoProveedorSoatId)
            ? <span>{nombreProveedor(proveedores.data, u.flitoProveedorSoatId)}</span>
            : <span className="font-mono">{u.flitoProveedorSoatId}</span>
        ) : (
          <span style={{ color: 'var(--flit-warning)' }}>Sin asignar</span>
        )
      ) : u.role === 'gestor_impuestos' ? (
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
      ) : (
        '—'
      )}
    </td>
  );
}

// ───────────────────── Cara 2 · Los campos condicionados al rol del formulario ───────────────────

function TransitoOrganismoField({ value, onChange, required }: { value: string; onChange: (v: string) => void; required?: boolean }) {
  return (
    <Field label="Organismo de tránsito">
      <FlitOrganismoCombobox value={value} onChange={onChange} required={required} />
      <p className="mt-1 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>
        Define qué bandeja verá este usuario (aislamiento Medellín ≠ Envigado).
      </p>
    </Field>
  );
}

/** Los cuatro valores de ámbito que el formulario mantiene en su estado. */
export interface ValoresAmbito {
  transitoCodigo: string;
  companiaId: string;
  flitoProveedorSoatId: string;
  organismosCodigos: string[];
}

/**
 * El bloque de ámbito del formulario: exactamente los mismos cuatro campos condicionados al rol que
 * el alta y la edición pintaban por separado. La única diferencia entre las dos pantallas era
 * `editando`, y sigue siéndolo: es el prop que añade el aviso de re-login en los dos campos que lo
 * traen del kit de ataduras.
 */
export function AmbitoCampos({
  role, editando, companias, proveedores, organismos, valores, onValores,
  errorCompania, setErrorCompania, errorProveedor, setErrorProveedor, errorOrganismos, setErrorOrganismos,
}: {
  role: UserRole;
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
      {role === 'transito' && (
        <TransitoOrganismoField value={valores.transitoCodigo} onChange={(v) => onValores({ transitoCodigo: v })} required />
      )}
      {role === 'cliente' && (
        <CompaniaField
          companias={companias}
          value={valores.companiaId}
          onChange={(v) => { onValores({ companiaId: v }); if (v) setErrorCompania(null); }}
          error={errorCompania}
          onInvalido={() => setErrorCompania(COMPANIA_REQUERIDA)}
        />
      )}
      {role === 'proveedor' && (
        <ProveedorSoatField
          proveedores={proveedores}
          value={valores.flitoProveedorSoatId}
          onChange={(v) => { onValores({ flitoProveedorSoatId: v }); if (v) setErrorProveedor(null); }}
          error={errorProveedor}
          onInvalido={() => setErrorProveedor(PROVEEDOR_REQUERIDO)}
          editando={editando}
        />
      )}
      {role === 'gestor_impuestos' && (
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
