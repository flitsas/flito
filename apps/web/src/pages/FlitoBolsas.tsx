// FLITO — Bolsas (Feature #11120, HU #11127–#11130; reestructurado en la #11210; catálogo en la #13901).
//
// UNA sola vista: los KPI encabezan la pantalla y debajo van dos acordeones, compañías y tránsitos.
// El detalle se abre en un modal por encima, para no perder el sitio al revisar uno tras otro.
//
// HU #13901 (spec `docs/ux/flito-bolsas.md`): «Crear bolsa» es la ÚNICA primaria y vive en la
// cabecera; abre el formulario único (`BolsaForm`), que pregunta primero el alcance. El selector de
// periodo se muda al detalle, que es el único sitio donde importa. El buscador manda el texto en el
// body de `POST /buscar` y nunca en la URL (Ley 1581).
//
// La página coordina qué se está mirando y reparte: el tablero, el formulario y los detalles traen
// sus propios datos.
//
// El acceso está cerrado por función (`bolsas.bolsa.ver`), igual que el router de la API: aquí se ve
// el dinero del cliente.

import { useCallback, useState } from 'react';
import { useAuth } from '../lib/auth';
import NoAccess from '../components/NoAccess';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import FlitModal from '../components/flit/FlitModal';
import { flitBtnPrimary, flitBtnPrimaryStyle } from '../components/flit/flitPageKit';
import BolsaDetalleCompania, { RegionDesplazable, type EntradaDetalle } from '../components/flito/BolsaDetalleCompania';
import BolsaForm from '../components/flito/BolsaForm';
import BolsaTransitoDetalle from '../components/flito/BolsaTransito';
import BolsaTransitoForm from '../components/flito/BolsaTransitoForm';
import BolsasTablero from '../components/flito/BolsasTablero';

export default function FlitoBolsas() {
  const { hasFuncion } = useAuth();
  // El gate va aquí y no solo en el router: con la página pero sin la función de ver la bolsa, la
  // pantalla cargaría para soltar 403 seguidos en vez de decir que no hay acceso. HU #12872: es la
  // función de la guarda (`bolsas.bolsa.ver`), no el nombre del rol.
  if (!hasFuncion('bolsas.bolsa.ver')) return <NoAccess page="flito_bolsas" />;
  return <Bolsas />;
}

/** Qué formulario de alta está abierto. `companiaInicial` viene de «Crea la bolsa primero» (AC6). */
type Alta = { companiaInicial: number | null } | null;

function Bolsas() {
  const { hasFuncion } = useAuth();
  const [nonce, setNonce] = useState(0);
  const recargar = useCallback(() => setNonce((n) => n + 1), []);

  const [detalle, setDetalle] = useState<{ entrada: EntradaDetalle; nombre: string } | null>(null);
  const [detalleTransito, setDetalleTransito] = useState<{ id: string; nombre: string } | null>(null);
  const [alta, setAlta] = useState<Alta>(null);
  const [altaTransito, setAltaTransito] = useState(false);

  // AC7: sin la función, el botón NO se pinta (no se deshabilita).
  const puedeCrear = hasFuncion('bolsas.bolsa.crear') || hasFuncion('bolsas.transito.crear');
  const puedeCrearCompania = hasFuncion('bolsas.bolsa.crear');
  const abrirAlta = useCallback((companiaInicial: number | null = null) => {
    setDetalle(null);
    setAlta({ companiaInicial });
  }, []);

  return (
    <div className="space-y-4">
      <PageHeaderCard
        title="Bolsas"
        subtitle="El saldo que cada cliente tiene precargado y el que FLIT mantiene en las secretarías."
        actions={puedeCrear ? (
          <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={() => abrirAlta()}>
            <span aria-hidden="true" className="text-base leading-none">+</span>
            Crear bolsa
          </button>
        ) : undefined}
      />

      <BolsasTablero
        nonce={nonce}
        onCrear={puedeCrear ? () => abrirAlta() : null}
        onVerBolsa={(b) => setDetalle({ entrada: { bolsaId: b.id }, nombre: b.nombre })}
        onVerCompania={(c) => setDetalle({ entrada: { companiaId: c.companiaId }, nombre: c.nombre })}
        onVerTransito={setDetalleTransito}
      />

      {detalle !== null && (
        <BolsaDetalleCompania
          entrada={detalle.entrada}
          nombre={detalle.nombre}
          onClose={() => setDetalle(null)}
          onCambio={recargar}
          onCrearBolsa={puedeCrearCompania ? (companiaId) => abrirAlta(companiaId) : null}
        />
      )}

      {detalleTransito !== null && (
        <FlitModal title={detalleTransito.nombre} onClose={() => setDetalleTransito(null)} full>
          {/* AC9: el mismo envoltorio desplazable que el detalle de compañía. Sin bloque #13407. */}
          <RegionDesplazable etiqueta={`Detalle de la bolsa de ${detalleTransito.nombre}`}>
            <BolsaTransitoDetalle bolsaId={detalleTransito.id} onCambio={recargar} />
          </RegionDesplazable>
        </FlitModal>
      )}

      {alta !== null && (
        <BolsaForm
          companiaInicial={alta.companiaInicial}
          onClose={() => setAlta(null)}
          onGuardada={(b) => {
            setAlta(null);
            recargar();
            setDetalle({ entrada: { bolsaId: b.id }, nombre: b.nombre });
          }}
          onVerBolsa={(bolsaId) => {
            setAlta(null);
            setDetalle({ entrada: { bolsaId }, nombre: 'Bolsa' });
          }}
          onContinuarTransito={() => { setAlta(null); setAltaTransito(true); }}
        />
      )}

      {altaTransito && (
        <BolsaTransitoForm
          onClose={() => setAltaTransito(false)}
          onHecho={() => { setAltaTransito(false); recargar(); }} />
      )}
    </div>
  );
}
