// FLITO — Comparendos: la barra de búsqueda del visor (HU #11560, AC3, AC4, AC6 y AC7).
//
// Tres campos y un grupo de pills, y NO se comportan igual, que es lo único importante de este
// archivo:
//
//   · **N.º de comparendo (`q`) busca solo con teclear**, con debounce (AC3). Es un consecutivo del
//     Estado: no identifica a una persona, viaja en la query y su búsqueda es por fragmento.
//   · **NIT y placa exigen un gesto explícito** —Enter o `[Buscar]`— y viajan en el CUERPO de
//     `POST /registros/buscar` (AC4). Nunca en la URL, nunca en el historial (AGENTS.md §14).
//     Que no se disparen al teclear no es una preferencia de estilo: cada consulta deja una fila en
//     el registro de acceso PII (Ley 1581 art. 17) que existe para poder responder «¿quién consultó
//     los datos de este titular?», y llenarlo de teclas a medio escribir degrada la única prueba que
//     el módulo tiene. Además, el limitador de lectura es de 60 por minuto y usuario.
//
// Esa diferencia es también la respuesta a la divergencia entre el AC3 («con debounce») y el
// descarte 6 de la spec de UX («buscar mientras se escribe, descartado»): los tres motivos del
// descarte —registro PII, limitador y cambio de verbo GET↔POST a mitad de tecleo— pesan sobre los
// filtros de IDENTIDAD, y ninguno de los tres se paga aquí, donde solo se difiere `q`. Queda
// anotado en el HANDOFF de la HU porque es una decisión de producto, no de implementación.
//
// La barra NUNCA se desmonta ni se inhabilita mientras la tabla carga: quien acaba de escribir un
// filtro y ve que tarda, lo primero que hace es corregirlo, y bloquearlo en ese momento es quitarle
// el control justo cuando lo necesita.

import { useEffect, useState, type FormEvent } from 'react';
import type { ComparendosRegistroEstado } from '@operaciones/shared-types';
import {
  FlitCard, FlitField, FlitPillButton, FlitPillGroup,
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle, flitInp,
} from '../../flit/flitPageKit';
import { useDebounce } from '../../../lib/useDebounce';
import { normalizarNit, type CriteriosComparendos } from './useComparendosLista';

/** Lo que el servidor exige de `q` (`registrosQuerySchema`): «q=1» recorrería la tabla entera. */
const MIN_NUMERO = 3;
const MIN_NIT = 5;
const MIN_PLACA = 3;
/**
 * 450 ms: por encima de una pausa de escritura y por debajo de lo que se siente como un cuelgue.
 * Con el limitador en 60 consultas por minuto, deja margen de sobra para una sesión de búsqueda.
 */
const ESPERA_MS = 450;

const ESTADOS: { valor: ComparendosRegistroEstado | null; etiqueta: string }[] = [
  { valor: null, etiqueta: 'Todos' },
  { valor: 'activo', etiqueta: 'Activos' },
  { valor: 'inactivo', etiqueta: 'Inactivos' },
];

/** Validación previa a la red: todas evitan un 400 que el usuario no puede interpretar. */
function errorNumero(v: string): string | null {
  const t = v.trim();
  if (t.length === 0 || t.length >= MIN_NUMERO) return null;
  return `Escribe al menos ${MIN_NUMERO} caracteres del número.`;
}

function errorNit(v: string): string | null {
  const t = normalizarNit(v).trim();
  if (t.length === 0) return null;
  if (!/^\d+(-\d)?$/.test(t)) {
    return 'El NIT admite solo números, con guion opcional para el dígito de verificación.';
  }
  if (t.replace('-', '').length < MIN_NIT) return `El NIT debe tener al menos ${MIN_NIT} dígitos.`;
  return null;
}

function errorPlaca(v: string): string | null {
  const t = v.trim();
  if (t.length === 0) return null;
  if (!/^[A-Za-z0-9 -]+$/.test(t)) return 'La placa admite letras, números, espacio y guion.';
  if (t.length < MIN_PLACA) return `La placa debe tener al menos ${MIN_PLACA} caracteres.`;
  return null;
}

interface Props {
  criterios: CriteriosComparendos;
  /** Aplica un cambio parcial. El hook descarta el cursor solo, porque cambian los criterios. */
  onAplicar: (parcial: Partial<CriteriosComparendos>) => void;
  onLimpiar: () => void;
}

export default function BarraFiltrosComparendos({ criterios, onAplicar, onLimpiar }: Props) {
  // Borradores: lo que se está escribiendo, que no es todavía lo que se está consultando.
  const [numero, setNumero] = useState(criterios.q);
  const [nit, setNit] = useState(criterios.nit);
  const [placa, setPlaca] = useState(criterios.placa);

  const errNumero = errorNumero(numero);
  const errNit = errorNit(nit);
  const errPlaca = errorPlaca(placa);

  const numeroDiferido = useDebounce(numero.trim(), ESPERA_MS);
  const aplicado = criterios.q;

  useEffect(() => {
    // Un número a medio escribir no sale a la red: el servidor lo rechazaría con un 400 y el
    // usuario vería un error por haber tecleado dos letras.
    if (errorNumero(numeroDiferido)) return;
    if (numeroDiferido === aplicado) return;
    onAplicar({ q: numeroDiferido });
  }, [numeroDiferido, aplicado, onAplicar]);

  const hayFiltros = Boolean(
    criterios.estado || criterios.q || criterios.nit || criterios.placa
    || numero.trim() || nit.trim() || placa.trim(),
  );

  function buscar(e: FormEvent) {
    e.preventDefault();
    if (errNumero || errNit || errPlaca) return;
    // Los tres a la vez: `[Buscar]` aplica lo que hay escrito, no solo lo último que se tocó.
    onAplicar({ q: numero.trim(), nit: nit.trim(), placa: placa.trim() });
  }

  function limpiar() {
    setNumero('');
    setNit('');
    setPlaca('');
    onLimpiar();
  }

  return (
    <FlitCard>
      <form className="space-y-4" onSubmit={buscar}>
        <div role="group" aria-label="Filtrar por estado de monitoreo">
          <FlitPillGroup>
            {ESTADOS.map(({ valor, etiqueta }) => (
              <FlitPillButton
                key={etiqueta}
                active={criterios.estado === valor}
                pressed={criterios.estado === valor}
                onClick={() => onAplicar({ estado: valor })}
              >
                {etiqueta}
              </FlitPillButton>
            ))}
          </FlitPillGroup>
        </div>

        <div className="grid gap-3 md:grid-cols-[1.4fr_1fr_1fr_auto]">
          <div>
            <FlitField label="N.º de comparendo">
              <input
                className={flitInp}
                value={numero}
                onChange={(e) => setNumero(e.target.value)}
                // Este SÍ lleva ejemplo: un número de comparendo es un consecutivo del Estado, no
                // identifica a una persona y no tiene la forma que la política de arriba vigila.
                placeholder="11001000123456"
                aria-invalid={errNumero ? true : undefined}
                aria-describedby={errNumero ? 'comparendos-error-numero' : 'comparendos-ayuda-numero'}
              />
            </FlitField>
            <p
              id={errNumero ? 'comparendos-error-numero' : 'comparendos-ayuda-numero'}
              className="mt-1 text-xs"
              style={{ color: errNumero ? 'var(--flit-danger)' : 'var(--flit-text-secondary)' }}
              role={errNumero ? 'alert' : undefined}
            >
              {errNumero ?? 'Busca por fragmento, desde 3 caracteres.'}
            </p>
          </div>

          <div>
            <FlitField label="NIT monitoreado">
              <input
                className={flitInp}
                value={nit}
                onChange={(e) => setNit(e.target.value)}
                // Sin `placeholder` de ejemplo, y no es un olvido: es la POLÍTICA DEL MÓDULO que
                // documenta el vacío B en `pages/FlitoComparendos.tsx` — el código no inventa
                // ninguna cadena con forma de NIT o de placa; lo que aparece con esa forma viene del
                // servidor o de lo que el usuario escribió. Un ejemplo estático es justo lo
                // contrario: está en pantalla en TODOS los estados, incluidos los de error que los
                // specs del módulo barren buscando esa forma, y obliga a ese barrido a llevar una
                // lista de excepciones — que es donde un día se cuela un valor real sin que nadie lo
                // note. La etiqueta dice qué es y el texto de ayuda dice cómo se busca.
                inputMode="numeric"
                autoComplete="off"
                aria-invalid={errNit ? true : undefined}
                aria-describedby={errNit ? 'comparendos-error-nit' : 'comparendos-ayuda-nit'}
              />
            </FlitField>
            <p
              id={errNit ? 'comparendos-error-nit' : 'comparendos-ayuda-nit'}
              className="mt-1 text-xs"
              style={{ color: errNit ? 'var(--flit-danger)' : 'var(--flit-text-secondary)' }}
              role={errNit ? 'alert' : undefined}
            >
              {errNit ?? 'Exacto, con o sin puntos. Desde 5 dígitos.'}
            </p>
          </div>

          <div>
            <FlitField label="Placa">
              <input
                className={flitInp}
                value={placa}
                onChange={(e) => setPlaca(e.target.value)}
                autoComplete="off"
                aria-invalid={errPlaca ? true : undefined}
                aria-describedby={errPlaca ? 'comparendos-error-placa' : 'comparendos-ayuda-placa'}
              />
            </FlitField>
            <p
              id={errPlaca ? 'comparendos-error-placa' : 'comparendos-ayuda-placa'}
              className="mt-1 text-xs"
              style={{ color: errPlaca ? 'var(--flit-danger)' : 'var(--flit-text-secondary)' }}
              role={errPlaca ? 'alert' : undefined}
            >
              {errPlaca ?? 'Exacta. Desde 3 caracteres.'}
            </p>
          </div>

          <div className="flex items-start gap-2 md:pt-[1.1rem]">
            <button type="submit" className={flitBtnPrimary} style={flitBtnPrimaryStyle}>
              Buscar
            </button>
            <button
              type="button"
              className={flitBtnSecondary}
              style={flitBtnSecondaryStyle}
              onClick={limpiar}
              disabled={!hayFiltros}
            >
              Limpiar
            </button>
          </div>
        </div>

        <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          El NIT y la placa se buscan exactos y no viajan en la dirección del navegador.
        </p>
      </form>
    </FlitCard>
  );
}
