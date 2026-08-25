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
// La HU #11561 añade la TERCERA clase de control —municipio, fuente y causal— y se comporta como
// las pills, no como los campos de texto: **aplica al cambiar**. Los tres motivos que obligan al
// gesto explícito en NIT y placa no se pagan aquí (ninguno identifica a nadie, elegir en un
// desplegable es un gesto único y deliberado, y ninguno cambia el verbo de la consulta), así que
// pedir además un `[Buscar]` sería ceremonia. Los tres viajan en la query, igual que `estado` y `q`.
//
// La barra NUNCA se desmonta ni se inhabilita mientras la tabla carga: quien acaba de escribir un
// filtro y ve que tarda, lo primero que hace es corregirlo, y bloquearlo en ese momento es quitarle
// el control justo cuando lo necesita. El único control que sí puede aparecer inhabilitado es un
// selector cuyo CATÁLOGO no cargó (AC2), y entonces lleva su mensaje y su reintento: se inhabilita
// porque no tiene opciones que ofrecer, no porque la pantalla esté ocupada.

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { ComparendosOrigenMerge, ComparendosRegistroEstado } from '@operaciones/shared-types';
import {
  FlitCard, FlitField, FlitPillButton, FlitPillGroup,
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle, flitInp,
} from '../../flit/flitPageKit';
import FlitSelect, { type FlitSelectOpcion } from '../../flit/FlitSelect';
import { useDebounce } from '../../../lib/useDebounce';
import {
  hayCriterios, normalizarNit,
  type CatalogosComparendos, type ClaveCatalogo, type CriteriosComparendos, type EstadoCatalogo,
} from './useComparendosLista';

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

/** «No filtres por esto». Cadena vacía porque es lo que un `<select>` sabe representar. */
const TODAS = '';

/**
 * «Sin causal asignada» como una opción MÁS del mismo selector, y no como una casilla aparte.
 *
 * El API tiene dos parámetros —`causalId` y `sinCausal`— y **mandarlos juntos es un 400**: la
 * intersección de «con esta causal» y «sin ninguna» está vacía siempre, así que el servidor prefiere
 * rechazarlo antes que responder una lista vacía que se lee como «no hay comparendos así». Con un
 * solo selector esa combinación **no se puede ni expresar**, que es mejor que validarla: no hay
 * ningún camino por el que la pantalla pueda producir ese 400.
 *
 * El valor centinela no puede chocar con un id de causal porque esos son UUID.
 */
const SIN_CAUSAL = '__sin_causal__';

/**
 * `origen_merge`: qué fuentes han visto el comparendo, que NO es de qué municipio es.
 *
 * No sale de ningún catálogo —es un enum del contrato—, así que este selector no tiene estado de
 * carga ni puede fallar: son tres valores que viven en `ComparendosOrigenMerge`.
 *
 * **El «Solo» de las dos primeras etiquetas es obligatorio y no es estilo.** El servidor compara por
 * IGUALDAD contra `origen_merge` (`flito-comparendos.registros.service.ts`), así que `fuente=simit`
 * NO incluye las filas `ambos` — que también las vio el SIMIT. Una etiqueta que dijera «SIMIT» a
 * secas describiría un filtro que el operador leería como «todo lo que el SIMIT ha visto»: filtraría,
 * exportaría y se llevaría un archivo al que le faltan filas que da por incluidas. Ese archivo se usa
 * para gestionar cobro.
 */
const FUENTES: { valor: ComparendosOrigenMerge; etiqueta: string }[] = [
  { valor: 'simit', etiqueta: 'Solo SIMIT' },
  { valor: 'municipal', etiqueta: 'Solo municipal' },
  { valor: 'ambos', etiqueta: 'Ambas fuentes' },
];

/**
 * Los cuatro estados de un selector alimentado por catálogo, según cómo le fue a SU petición.
 *
 * `reintentable` es lo que decide si aparece el botón de reintento, y no coincide con «hay mensaje»:
 * mientras el catálogo CARGA no hay nada que reintentar y el botón sería un control que invita a
 * repetir una petición que está en vuelo. En los otros dos casos con mensaje sí aparece, y es además
 * la única salida por teclado del callejón —un `<select disabled>` no recibe foco— (ver `FlitSelect`).
 */
interface PieDeCatalogo {
  mensaje: string | null;
  fallo: boolean;
  disabled: boolean;
  reintentable: boolean;
}

function pieDeCatalogo(estado: EstadoCatalogo, vacio: boolean, nombre: string): PieDeCatalogo {
  if (estado === 'cargando') {
    return { mensaje: `Cargando ${nombre}…`, fallo: false, disabled: true, reintentable: false };
  }
  if (estado === 'error') {
    return {
      mensaje: `No se pudo cargar el catálogo de ${nombre}. El resto de la pantalla sigue funcionando.`,
      fallo: true,
      disabled: true,
      reintentable: true,
    };
  }
  if (vacio) {
    return {
      mensaje: `No hay ${nombre} en el catálogo todavía.`,
      fallo: false,
      disabled: true,
      reintentable: true,
    };
  }
  return { mensaje: null, fallo: false, disabled: false, reintentable: false };
}

/**
 * **Los selectores NO filtran por `activo`, y es una desviación DELIBERADA de la letra del AC2.**
 *
 * El AC2 dice que los catálogos «traen solo activos». La RN-36 dice otra cosa y es la que manda
 * aquí: dar de baja un municipio o una causal deja de CONSULTAR esa fuente, no borra los
 * comparendos que ya trajo ni las gestiones ya clasificadas con esa causal. Filtrando por `activo`,
 * esos comparendos dejarían de ser consultables desde la pantalla —deuda viva que desaparece de la
 * vista por un cambio de parametrización—, así que las entradas dadas de baja se ofrecen, marcadas
 * como inactivas.
 *
 * (De paso, el AC2 tampoco describe el API: `GET /municipios` y `GET /causales` devuelven el
 * catálogo ENTERO con su bandera `activo`; el filtrado, si lo hubiera, sería de la pantalla.)
 *
 * Lo que esta función añade encima es el valor **aplicado que no está en la lista**, que es el caso
 * que muerde en silencio: si el `<select>` no tiene una opción con ese `value`, el navegador cae a
 * la primera y **el filtro cambia de significado sin que nadie lo pida**, mientras la tabla sigue
 * enseñando lo que sí se pidió. Ocurre cuando la entrada se borró del catálogo o cuando el catálogo
 * no llegó a cargar. Se marca «fuera del catálogo» —en el texto, no con un color— porque es lo que
 * pasa: se puede conservar, no volver a elegir.
 */
function conElValorAplicado(
  opciones: FlitSelectOpcion[],
  aplicado: string | undefined,
  respaldo: (valor: string) => FlitSelectOpcion,
): FlitSelectOpcion[] {
  if (!aplicado || opciones.some((o) => o.valor === aplicado)) return opciones;
  return [...opciones, respaldo(aplicado)];
}

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
  /** Municipios y causales con SU estado: es lo que llena —o inhabilita— cada selector (AC2). */
  catalogos: CatalogosComparendos;
}

export default function BarraFiltrosComparendos({
  criterios, onAplicar, onLimpiar, catalogos,
}: Props) {
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
    /**
     * **El diferido solo se aplica cuando ya ALCANZÓ al borrador.**
     *
     * Sin esta guarda, pulsar `[Buscar]` antes de que venza el retardo BORRA el número recién
     * buscado. El efecto depende de `aplicado`, así que `[Buscar]` —que aplica los tres campos a la
     * vez— lo vuelve a disparar de inmediato; en ese instante `numeroDiferido` todavía es el valor
     * VIEJO (la cadena vacía, que pasa la validación por ser «sin filtro»), no coincide con lo
     * aplicado, y se manda `q: ''`. El resultado es una consulta de más —una fila de más en el
     * registro de acceso PII y un hueco de más en el limitador— y una ventana de cientos de
     * milisegundos en la que la tabla muestra el filtro sin el número.
     *
     * Esa ventana es lo que convierte un defecto cosmético en uno con consecuencias desde la
     * HU #11561: exportar dentro de ella descarga el conjunto SIN el número de comparendo, que es
     * más ancho que el que se está viendo, y el archivo no dice en ninguna parte que le falta un
     * filtro. Se descubrió con el test de paridad del export.
     */
    if (numeroDiferido !== numero.trim()) return;
    // Un número a medio escribir no sale a la red: el servidor lo rechazaría con un 400 y el
    // usuario vería un error por haber tecleado dos letras.
    if (errorNumero(numeroDiferido)) return;
    if (numeroDiferido === aplicado) return;
    onAplicar({ q: numeroDiferido });
  }, [numeroDiferido, numero, aplicado, onAplicar]);

  /**
   * ¿Hay algo que limpiar? (AC1 · «ver todos»)
   *
   * Delega en `hayCriterios`, que es la MISMA función con la que el hook decide si el vacío es el A
   * o el B, y solo añade los borradores que todavía no se han aplicado. Escrita a mano —como estaba
   * hasta esta HU, con `estado`, `q`, `nit` y `placa` sueltos— se quedó corta en cuanto los criterios
   * crecieron: con un municipio o una causal puestos y nada más, `[Limpiar]` aparecía inhabilitado y
   * no había forma de volver a «todos». Dos listas de los mismos criterios son dos listas que se
   * separan; esta es la copia que sobraba.
   */
  const hayFiltros = hayCriterios(criterios) || Boolean(numero.trim() || nit.trim() || placa.trim());

  /**
   * El valor de cada opción es el `codigoFuente` —«ITAGUI»—, **nunca el `id` del catálogo**.
   *
   * Es lo que el sync guarda en la fila del comparendo y contra lo que compara el filtro. Mandar el
   * UUID del catálogo no da error: responde **200 con cero filas**, y la pantalla diría «ningún
   * comparendo coincide» teniendo comparendos de ese municipio delante. Es el mismo desenlace mudo
   * que la placa imposible de la #11560, y por eso hay un test anclado a este valor exacto.
   */
  const opcionesMunicipio = useMemo(() => conElValorAplicado(
    catalogos.listaMunicipios.map((m) => ({
      valor: m.codigoFuente,
      etiqueta: m.nombre,
      nota: m.activo ? undefined : 'inactivo',
    })),
    criterios.municipio,
    (valor) => ({
      // El nombre si el mapa lo conoce; si no, el `codigoFuente` crudo, que sigue siendo cierto.
      valor, etiqueta: catalogos.municipios[valor] ?? valor, nota: 'fuera del catálogo',
    }),
  ), [catalogos.listaMunicipios, catalogos.municipios, criterios.municipio]);

  // Por `orden` y no alfabéticamente: el campo existe justo para que la lista se lea en la secuencia
  // natural de la gestión.
  const opcionesCausal = useMemo(() => conElValorAplicado(
    [...catalogos.listaCausales]
      .sort((a, b) => a.orden - b.orden)
      .map((c) => ({ valor: c.id, etiqueta: c.nombre, nota: c.activo ? undefined : 'inactiva' })),
    criterios.causalId,
    (valor) => ({
      valor, etiqueta: catalogos.causales[valor] ?? 'Causal aplicada', nota: 'fuera del catálogo',
    }),
  ), [catalogos.listaCausales, catalogos.causales, criterios.causalId]);

  const pieMunicipio = pieDeCatalogo(
    catalogos.estado.municipios, opcionesMunicipio.length === 0, 'municipios',
  );
  const pieCausal = pieDeCatalogo(
    catalogos.estado.causales, opcionesCausal.length === 0, 'causales',
  );

  // Un selector con el valor aplicado dentro NO se inhabilita aunque su catálogo esté caído: quien
  // tiene un filtro puesto tiene que poder quitarlo, y un control inhabilitado no deja hacerlo.
  const bloquear = (pie: PieDeCatalogo, valorAplicado: unknown) => pie.disabled && !valorAplicado;

  const reintentar = (pie: PieDeCatalogo, cual: ClaveCatalogo) => (pie.reintentable
    ? () => catalogos.recargar(cual)
    : undefined);

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

        {/* Los tres selectores van ANTES de los campos de texto y no entre ellos: el recorrido con
            tabulador de «N.º → NIT → placa → [Buscar]» es un bloque con un solo gesto de cierre, y
            meter tres paradas en medio lo partiría en dos sin que nada lo explique. Aquí, además,
            leen en el orden en que se piensa la búsqueda: primero se acota de dónde y de qué tipo,
            después se busca uno concreto. */}
        <div className="grid gap-3 md:grid-cols-3">
          <FlitSelect
            label="Municipio"
            value={criterios.municipio ?? TODAS}
            opciones={[{ valor: TODAS, etiqueta: 'Todos los municipios' }, ...opcionesMunicipio]}
            onChange={(v) => onAplicar({ municipio: v || undefined })}
            /* HU #11795. Decía «Dónde se vio el comparendo, según el catálogo de fuentes.», y desde
               que la tabla muestra el organismo en las filas de SIMIT esa frase pasó a ser una
               trampa: sugiere que la fila cuya celda dice «Organismo · Medellin» saldría al filtrar
               por MEDELLIN, y no sale. El filtro es igualdad exacta contra `municipioFuente`
               normalizado (RN-36) y **eso no cambia**: es lo que sostiene el índice
               `(municipio_fuente, created_at DESC, id DESC)` de la 0153 y el cursor de RN-32.
               Se dice ANTES de que alguien lo reporte como defecto, no después. */
            ayuda="El filtro busca por el municipio al que se le consultó. Los comparendos que solo reportó SIMIT no tienen municipio y no salen aquí, aunque su organismo lo mencione."
            mensaje={pieMunicipio.mensaje}
            fallo={pieMunicipio.fallo}
            disabled={bloquear(pieMunicipio, criterios.municipio)}
            onReintentar={reintentar(pieMunicipio, 'municipios')}
            textoReintento="Volver a cargar los municipios"
          />

          <FlitSelect
            label="Fuente"
            value={criterios.fuente ?? TODAS}
            opciones={[
              { valor: TODAS, etiqueta: 'Todas las fuentes' },
              ...FUENTES.map((f) => ({ valor: f.valor, etiqueta: f.etiqueta })),
            ]}
            onChange={(v) => onAplicar({ fuente: (v || undefined) as ComparendosOrigenMerge | undefined })}
            // Lo que este filtro responde de verdad, que no se adivina por el nombre: es el que
            // contesta «¿qué tiene el SIMIT que el municipio todavía no?».
            ayuda="Qué fuentes han visto el comparendo, no de qué municipio es."
          />

          <FlitSelect
            label="Causal de gestión"
            value={criterios.sinCausal ? SIN_CAUSAL : (criterios.causalId ?? TODAS)}
            opciones={[
              { valor: TODAS, etiqueta: 'Todas las causales' },
              { valor: SIN_CAUSAL, etiqueta: 'Sin causal asignada' },
              ...opcionesCausal,
            ]}
            onChange={(v) => onAplicar(v === SIN_CAUSAL
              // Los dos parámetros se escriben SIEMPRE juntos, y por eso no pueden contradecirse:
              // elegir uno apaga el otro en la misma aplicación de criterios.
              ? { causalId: undefined, sinCausal: true }
              : { causalId: v || undefined, sinCausal: undefined })}
            ayuda="«Sin causal asignada» es la cola de lo que falta por mirar."
            mensaje={pieCausal.mensaje}
            fallo={pieCausal.fallo}
            disabled={bloquear(pieCausal, criterios.causalId)}
            onReintentar={reintentar(pieCausal, 'causales')}
            textoReintento="Volver a cargar las causales"
          />
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
