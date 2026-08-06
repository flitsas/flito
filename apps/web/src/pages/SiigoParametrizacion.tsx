// Facturación electrónica — parametrización (HU #11287 y #11288, Feature #11240).
//
// Una sola pantalla para todo el trabajo de dejar la facturación electrónica lista: el mapeo de
// cada concepto a su producto de Siigo, los catálogos y la configuración global de emisión.
//
// Las dos historias comparten página, ruta, ítem de menú y clave de permiso a propósito: son el
// mismo trabajo y de la misma persona, y partirlas obligaría a conceder dos permisos para completar
// una tarea. Este archivo es el caparazón —selector de ambiente, compuerta, aviso de modo simulado
// y pestañas—; el contenido de cada pestaña vive en `components/siigo/`.
//
// **La compuerta encabeza la pantalla** (AC6 de la HU #11288). Es la única pregunta que importa de
// verdad aquí: ¿se puede facturar en producción, y si no, qué falta? Enterrarla al fondo de una
// pestaña obligaría a buscarla, y lo que no se ve no se corrige.

import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import MapeoConceptos from '../components/siigo/MapeoConceptos';
import CatalogosYEmision from '../components/siigo/CatalogosYEmision';
import { CARD, inputCls } from '../components/siigo/estilos';

type Ambiente = 'pruebas' | 'produccion';
type Pestana = 'mapeo' | 'catalogos';

interface MotivoCompuerta {
  tipo: string;
  detalle: string;
  conceptos?: string[];
  campos?: string[];
}

interface EstadoCompuerta {
  ambiente: string;
  modo: string;
  compuertaActiva: boolean;
  emisionRealHabilitada: boolean;
  motivos: MotivoCompuerta[];
}

/**
 * En qué pestaña se corrige cada motivo (AC6: «con enlace a la pantalla o la fila donde se
 * corrige»). Los motivos de mapeo se arreglan en la primera; los de configuración, en la segunda.
 */
function pestanaDeMotivo(tipo: string): Pestana {
  return tipo.startsWith('concepto_') ? 'mapeo' : 'catalogos';
}

const PESTANAS: { id: Pestana; label: string }[] = [
  { id: 'mapeo', label: 'Mapeo de conceptos' },
  { id: 'catalogos', label: 'Catálogos y emisión' },
];

/**
 * `auditor` NO ve la pestaña de catálogos.
 *
 * No es una decisión de esta pantalla: `parametrizacion.routes.ts` excluye a `auditor` de la
 * lectura de catálogos —el único de los cuatro routers de Siigo que lo hace—, y su spec lo afirma
 * a propósito («leer la parametrización no es su función aquí», HU #11281). Ofrecerle una pestaña
 * que va a devolver 403 sería una interfaz que invita a fallar.
 *
 * La asimetría con los otros tres routers está señalada para el Líder Técnico: si algún día se
 * decide que el auditor sí lea los catálogos, basta con quitar este filtro.
 */
function pestanasVisibles(rol: string | undefined): { id: Pestana; label: string }[] {
  return rol === 'auditor' ? PESTANAS.filter((p) => p.id !== 'catalogos') : PESTANAS;
}

export default function SiigoParametrizacion() {
  const { user } = useAuth();
  const puedeEditar = user?.role === 'admin';
  const puedeConfirmar = user?.role === 'admin' || user?.role === 'financiera';

  const pestanas = pestanasVisibles(user?.role);

  const [ambiente, setAmbiente] = useState<Ambiente>('pruebas');
  const [pestana, setPestana] = useState<Pestana>('mapeo');
  const [compuerta, setCompuerta] = useState<EstadoCompuerta | null>(null);
  const [errorCompuerta, setErrorCompuerta] = useState<string | null>(null);

  const cargarCompuerta = useCallback(async () => {
    setErrorCompuerta(null);
    try {
      setCompuerta(await api.get<EstadoCompuerta>(`/siigo/compuerta?ambiente=${ambiente}`));
    } catch (e) {
      // El fallo de la compuerta NO tumba la pantalla: sin ella se sigue pudiendo parametrizar.
      setCompuerta(null);
      setErrorCompuerta(errorMessage(e));
    }
  }, [ambiente]);

  useEffect(() => { void cargarCompuerta(); }, [cargarCompuerta]);

  return (
    <div className="space-y-5">
      <PageHeaderCard
        title="Facturación electrónica — Parametrización"
        subtitle="Catálogos, mapeo de conceptos y configuración de emisión de la integración con Siigo."
        actions={(
          <div className="flex items-center gap-3">
            <label htmlFor="ambiente-siigo" className="text-sm font-medium" style={{ color: 'var(--flit-text-muted)' }}>
              Ambiente
            </label>
            <select
              id="ambiente-siigo"
              className={`${inputCls} w-40`}
              value={ambiente}
              onChange={(e) => setAmbiente(e.target.value as Ambiente)}
            >
              <option value="pruebas">Pruebas</option>
              <option value="produccion">Producción</option>
            </select>
          </div>
        )}
      />

      {/* AC7 — el modo simulado se señaliza de forma permanente, no en un toast que se va. */}
      {compuerta?.modo === 'mock' && (
        <div
          role="status"
          className="flex items-start gap-3 bg-white px-5 py-4 text-sm"
          style={{ ...CARD, borderLeft: '4px solid var(--flit-warning)' }}
        >
          <span aria-hidden="true" className="text-lg leading-none">🧪</span>
          <div>
            <p className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
              Modo simulado: los datos vienen del simulador, no de Siigo.
            </p>
            <p style={{ color: 'var(--flit-text-muted)' }}>
              Nada de lo que se haga aquí llega a Siigo ni a la DIAN, y la compuerta que impide
              emitir sin confirmación de contabilidad <strong>no aplica</strong> en este modo.
            </p>
          </div>
        </div>
      )}

      {/* AC6 — el estado de la compuerta encabeza la pantalla. */}
      {compuerta && !compuerta.emisionRealHabilitada && (
        <section
          aria-labelledby="compuerta-titulo"
          className="bg-white px-5 py-4"
          style={{ ...CARD, borderLeft: '4px solid var(--flit-danger)' }}
        >
          <h2 id="compuerta-titulo" className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            <span aria-hidden="true" style={{ color: 'var(--flit-danger)' }}>⚠ </span>
            La emisión en producción está bloqueada
          </h2>
          <ul className="mt-2 space-y-1.5">
            {/* `?? []` y no `compuerta.motivos` a secas: una respuesta incompleta —un despliegue a
                medias, un proxy que recorta— no puede tumbar toda la pantalla de parametrización
                por un banner informativo. */}
            {(compuerta.motivos ?? []).map((m) => (
              <li key={m.tipo} className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
                {m.detalle}{' '}
                {/* El «enlace a donde se corrige» es la pestaña: es la misma pantalla. */}
                {pestanas.some((p) => p.id === pestanaDeMotivo(m.tipo)) && (
                  <button
                    type="button"
                    onClick={() => setPestana(pestanaDeMotivo(m.tipo))}
                    className="flit-focus font-semibold underline"
                    style={{ color: 'var(--flit-info)' }}
                  >
                    Ir a corregirlo
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {compuerta?.emisionRealHabilitada && compuerta.compuertaActiva && (
        <p
          role="status"
          className="bg-white px-5 py-4 text-sm font-semibold"
          style={{ ...CARD, borderLeft: '4px solid var(--flit-success)', color: 'var(--flit-text-primary)' }}
        >
          La parametrización está completa: la emisión en producción está habilitada.
        </p>
      )}

      {errorCompuerta && (
        <p role="alert" className="bg-white px-5 py-4 text-sm" style={{ ...CARD, color: 'var(--flit-text-primary)' }}>
          <span aria-hidden="true" style={{ color: 'var(--flit-danger)' }}>⚠ </span>
          No se pudo consultar el estado de la emisión: {errorCompuerta}
        </p>
      )}

      <div role="tablist" aria-label="Secciones de la parametrización" className="flex gap-2">
        {pestanas.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            id={`tab-${p.id}`}
            aria-selected={pestana === p.id}
            aria-controls={`panel-${p.id}`}
            onClick={() => setPestana(p.id)}
            className="flit-focus rounded-[10px] border px-4 py-2 text-sm font-semibold"
            style={{
              borderColor: pestana === p.id ? 'var(--flit-info)' : 'var(--flit-border-input)',
              color: 'var(--flit-text-primary)',
              background: pestana === p.id ? 'rgba(79, 116, 201, 0.10)' : 'white',
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${pestana}`} aria-labelledby={`tab-${pestana}`}>
        {pestana === 'mapeo' || !pestanas.some((p) => p.id === pestana) ? (
          <MapeoConceptos
            ambiente={ambiente}
            puedeEditar={puedeEditar}
            puedeConfirmar={puedeConfirmar}
            onCambio={() => { void cargarCompuerta(); }}
          />
        ) : (
          <CatalogosYEmision
            ambiente={ambiente}
            puedeEditar={puedeEditar}
            onCambio={() => { void cargarCompuerta(); }}
          />
        )}
      </div>
    </div>
  );
}
