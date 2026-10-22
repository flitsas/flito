import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';
import {
  TARJETAS_POR_MODULO, type ModuloGestion, type TarjetaTramiteGestion,
} from '@operaciones/shared-types';
import { flitBtnSecondarySm } from '../../flit/flitPageKit';
import {
  COPY_429, faseBloque, moduloGestionWeb, textoResumen, type GrupoGestion, type MensajeResultadoGestion,
} from '../../../lib/drFlitGestion';
import type { GruposResultado } from '../../../lib/drFlitGestionConsulta';
import { BurbujaDrFlit, ENLACE_DRFLIT } from '../DrFlitMensaje';
import TarjetaTramite from './TarjetaTramite';

// Dr. Flit — bloque «Resultados para {valor}» (HU #13836 G1; UX F6.4 B–E, F6.8, F6.14).
// Grupos en el orden fijo del registro; cada uno se pinta al responder su módulo. Un grupo con 0 o
// 403 no aparece. Sin toast ni animación. El cuerpo va con `aria-live="off"`: las tarjetas no se
// dictan solas; el panel anuncia «Consultando sus módulos…» y el resumen por su `role="status"`.

/** Tarjeta de cada módulo. G2/G3 añaden SOAT, impuestos y derechos. */
const TARJETA: Partial<Record<ModuloGestion, (item: unknown) => ReactNode>> = {
  tramites: (item) => <TarjetaTramite tarjeta={item as TarjetaTramiteGestion} />,
};

const TEXTO_ERROR = 'text-[color:var(--flit-danger-text)]';

export const idTituloGestion = (id: string) => `drflit-gestion-${id}`;
export const idGrupoGestion = (id: string, modulo: ModuloGestion) => `drflit-gestion-${id}-${modulo}`;

export interface ResultadoGestionProps {
  mensaje: MensajeResultadoGestion;
  grupos: GruposResultado;
  /** Repite los módulos indicados (un grupo, o todos los fallidos). */
  onReintentar: (id: string, modulos: ModuloGestion[]) => void;
  onNavegar: () => void;
}

function AvisoError({ texto, onReintentar, alerta = false }: { texto: string; onReintentar: () => void; alerta?: boolean }) {
  return (
    <div className="mt-2 flex items-start gap-2">
      <AlertCircle aria-hidden="true" className={`mt-0.5 h-4 w-4 shrink-0 ${TEXTO_ERROR}`} />
      <div className="min-w-0">
        <p role={alerta ? 'alert' : undefined} className={`break-words ${TEXTO_ERROR}`}>{texto}</p>
        <button type="button" onClick={onReintentar} className={`${flitBtnSecondarySm} mt-2`}>
          Reintentar
        </button>
      </div>
    </div>
  );
}

function Grupo({ id, modulo, grupo, variosVerMas, onReintentar, onNavegar }: {
  id: string; modulo: ModuloGestion; grupo: GrupoGestion; variosVerMas: boolean;
  onReintentar: () => void; onNavegar: () => void;
}) {
  const reg = moduloGestionWeb(modulo);
  const pintar = TARJETA[modulo];
  if (!reg || !pintar || grupo.estado === 'oculto') return null;
  const idH4 = idGrupoGestion(id, modulo);
  return (
    <section aria-labelledby={idH4} className="mt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <h4 id={idH4} tabIndex={-1} className="flit-focus rounded-md font-semibold">{reg.etiqueta}</h4>
        {grupo.estado === 'ok' && <p className="tabular-nums text-flit-secondary">{grupo.total} en total</p>}
      </div>
      {grupo.estado === 'cargando' && (
        <div aria-hidden="true" className="mt-2 rounded-flit border border-flit-soft px-3 py-3">
          <div className="h-3 w-3/4 rounded bg-flit-app" />
          <div className="mt-2 h-3 w-1/2 rounded bg-flit-app" />
        </div>
      )}
      {grupo.estado === 'error' && (
        <AvisoError texto={grupo.status === 429 ? COPY_429 : `No pude consultar ${reg.etiqueta}.`} onReintentar={onReintentar} />
      )}
      {grupo.estado === 'ok' && (
        <>
          <ul aria-label={`${reg.etiqueta} encontrados`} className="mt-2 divide-y divide-flit-soft rounded-flit border border-flit-soft">
            {grupo.items.slice(0, TARJETAS_POR_MODULO).map((item, i) => (
              <li key={(item as { id?: string }).id ?? i}>{pintar(item)}</li>
            ))}
          </ul>
          {grupo.total > TARJETAS_POR_MODULO && (
            <p className="mt-2 tabular-nums text-flit-secondary">
              Mostrando {Math.min(TARJETAS_POR_MODULO, grupo.items.length)} de {grupo.total}.
            </p>
          )}
          <div className="mt-2">
            {/* Ruta del módulo SIN query: ni placa, ni VIN, ni id FLIT (AC6, regla 14). */}
            <Link
              to={reg.ruta}
              onClick={onNavegar}
              className={ENLACE_DRFLIT}
              aria-label={grupo.total > TARJETAS_POR_MODULO && variosVerMas
                ? `Ver más ${reg.etiqueta.toLowerCase()} en la pantalla de ${reg.etiqueta}` : undefined}
            >
              {grupo.total > TARJETAS_POR_MODULO ? 'Ver más en la pantalla' : `Abrir la pantalla de ${reg.etiqueta}`}
              <span aria-hidden="true">→</span>
            </Link>
          </div>
        </>
      )}
    </section>
  );
}

export default function ResultadoGestion({ mensaje, grupos, onReintentar, onNavegar }: ResultadoGestionProps) {
  const { id, valor } = mensaje;
  const lista = mensaje.modulos.map((m) => [m, grupos[m] ?? { estado: 'cargando' }] as const);
  const fase = faseBloque(lista.map(([, g]) => g));
  const fallidos = lista.filter(([, g]) => g.estado === 'error').map(([m]) => m);
  const variosVerMas = lista.filter(([, g]) => g.estado === 'ok' && g.total > TARJETAS_POR_MODULO).length > 1;
  const idH3 = idTituloGestion(id);
  return (
    <BurbujaDrFlit>
      <section aria-labelledby={idH3} aria-live="off">
        <h3 id={idH3} tabIndex={-1} className="flit-focus break-words rounded-md font-semibold">
          Resultados para {valor}
        </h3>
        {fase.fase === 'cargando' && <p className="mt-1 text-flit-secondary">Consultando sus módulos…</p>}
        {fase.fase === 'lleno' && (
          <p className="mt-1 break-words">
            {textoResumen(fase.coincidencias, fase.modulos)}{' '}
            <span className="text-flit-secondary">Las pantallas se abren sin filtro: allí busque de nuevo {valor}.</span>
          </p>
        )}
        {fase.fase === 'mixto' && (
          <p className="mt-1">No encontré coincidencias en los módulos que respondieron.</p>
        )}
        {fase.fase === 'vacio' && (
          <>
            <p className="mt-1">No encontré resultados en sus módulos.</p>
            <p className="mt-1 break-words text-flit-secondary">
              Revise que {valor} esté bien escrito o búsquelo en la pantalla del módulo.
            </p>
          </>
        )}
        {fase.fase === 'error' ? (
          <AvisoError
            alerta
            texto={fase.todos429 ? COPY_429 : 'No pude consultar sus módulos. Revise su conexión e intente de nuevo.'}
            onReintentar={() => onReintentar(id, fallidos)}
          />
        ) : (
          lista.map(([m, g]) => (
            <Grupo
              key={m}
              id={id}
              modulo={m}
              grupo={g}
              variosVerMas={variosVerMas}
              onReintentar={() => onReintentar(id, [m])}
              onNavegar={onNavegar}
            />
          ))
        )}
      </section>
    </BurbujaDrFlit>
  );
}
