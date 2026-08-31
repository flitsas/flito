// FLITO — «Descargar soportes» en ZIP sobre las filas marcadas (HU #11910, Feature #11908).
//
// Es la ACCIÓN HERMANA de «Exportar a Excel» (HU #11909, `ExportarCola.tsx`) y por eso comparte con
// ella todo lo que ya estaba resuelto: el copy de los errores comunes (`avisoDeError`), la tarjeta
// del aviso (`AvisoVisible`), el guardia del nombre servido (`esNombreDeExport`) y el reparto entre
// `role="status"` y `role="alert"`. Lo único que se escribe aquí es lo que aquella no tenía: un
// diálogo de tipos de documento y un aviso con cifras para el ZIP parcial.
//
// Tres diferencias con el export, y las tres son de fondo:
//
//   · **Actúa sobre la SELECCIÓN, no sobre el filtro.** Por eso el botón vive en la barra de
//     selección, junto a «Enviar» y «Certificar», y no en el slot `actions` de la cabecera. Lo que
//     viaja son ids, nunca filtros: `{ ids, tipos }` y nada más.
//   · **El diálogo se abre solo si hay más de un tipo.** En SOAT hay uno —el comprobante del SOAT—
//     y un diálogo cuya única respuesta posible es «sí» es un clic que no decide nada. No es una
//     excepción escrita a mano para SOAT: es `tipos.length > 1`, así que el día que SOAT gane un
//     segundo tipo el diálogo aparece solo.
//   · **El ZIP parcial se descarga y se DICE con cifras.** El servidor omite el documento que falta
//     en vez de tumbar el ZIP; lo que no se acepta es la versión silenciosa —un archivo más corto de
//     lo esperado sin que nadie lo diga—, que es la misma trampa que el «Excel truncado» que la
//     #11909 prohibió. La cifra la trae **`X-Soportes-Registros`** —filas marcadas que aportaron
//     algo—, **no `X-Soportes-Incluidos`**, que cuenta DOCUMENTOS: en el ZIP mixto de Trámites un
//     trámite aporta hasta tres, así que con aquella cinco marcadas podrían dar «6 de 5». Sin
//     cabecera el aviso queda genérico y correcto, nunca inventado.
//
// **Nada de esto toca la URL** (AGENTS.md §14): los ids van en el CUERPO del POST y no hay variante
// `GET` de estos endpoints. La placa entra en el nombre de cada entrada del ZIP —eso es el AC5— pero
// NO en el nombre del ZIP, que es lo que acaba en asuntos de correo y carpetas compartidas.

import { useCallback, useRef, useState } from 'react';
import {
  CABECERAS_ZIP_SOPORTES, CODIGO_ZIP_DEMASIADO_GRANDE, CODIGO_ZIP_DEMASIADOS_REGISTROS,
  CODIGO_ZIP_SIN_SOPORTES, TipoSoporteZip, ZIP_SOPORTES_MAX_REGISTROS,
} from '@operaciones/shared-types';
import { ApiError, api } from '../../lib/api';
import FlitModal from '../flit/FlitModal';
import {
  AvisoVisible, avisoDeError, esNombreDeExport, type AvisoExport,
} from './ExportarCola';
import {
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../flit/flitPageKit';

/**
 * Los tipos vienen de `shared-types` y **no se redeclaran aquí**: son los mismos literales con los
 * que el esquema `.strict()` del endpoint valida el cuerpo, así que un valor inventado en esta
 * pantalla es un error de compilación y no un 400 en producción.
 *
 * `RECIBO_IMPUESTO` cubre el recibo CON y SIN marca de agua —el servidor resuelve al limpio y cae al
 * marcado—: son dos filas de `TipoSoporte` pero una sola cosa para quien concilia, y una tercera
 * casilla obligaría al usuario a saber qué es una marca de agua.
 */
export interface OpcionTipoZip {
  valor: TipoSoporteZip;
  /** El rótulo de la casilla, con **la palabra que el usuario ya ve en la pantalla**. */
  rotulo: string;
  /** La línea de ayuda de la opción, atada por `aria-describedby`. */
  ayuda: string;
  /** Cómo se nombra en la frase del aviso: «…tenían recibo del impuesto; las otras 3 no». */
  enFrase: string;
}

const FACTURA_VENTA: OpcionTipoZip = {
  valor: TipoSoporteZip.FACTURA_VENTA,
  rotulo: 'Factura de venta',
  ayuda: 'La que emite el concesionario y llega de FLIT.',
  enFrase: 'factura de venta',
};
const RECIBO_IMPUESTO: OpcionTipoZip = {
  valor: TipoSoporteZip.RECIBO_IMPUESTO,
  rotulo: 'Recibo del impuesto',
  ayuda: 'El comprobante que el organismo emite al pagar.',
  enFrase: 'recibo del impuesto',
};
const FACTURA_SOAT: OpcionTipoZip = {
  valor: TipoSoporteZip.FACTURA_SOAT,
  rotulo: 'Comprobante del SOAT',
  ayuda: 'La póliza o factura de la aseguradora.',
  enFrase: 'comprobante del SOAT',
};

/** Lo que distingue a las tres pantallas: la ruta, los tipos y dos líneas de copy. */
export interface SuperficieZip {
  /** Ruta del POST, sin `/api`. */
  ruta: string;
  tipos: OpcionTipoZip[];
  /**
   * ¿El cuerpo lleva `tipos`?
   *
   * En SOAT **no**, y no es una simetría rota por descuido: el esquema de ese endpoint es
   * `z.object({ ids }).strict()` —un solo tipo posible, así que no hay nada que elegir— y mandarle
   * un `tipos` de cortesía sería un 400. Va como dato de la superficie y no deducido de
   * `tipos.length > 1`, para que el día en que las dos cosas dejen de coincidir se vea aquí.
   */
  tiposEnElCuerpo: boolean;
  /** Línea bajo el botón. Solo tiene sentido donde no hay diálogo que lo explique. */
  lineaAyuda?: string;
  /** Solo en Trámites: qué cambió respecto del botón que ocupaba este píxel. */
  notaTransicion?: string;
}

export const ZIP_SOAT: SuperficieZip = {
  ruta: '/flito/soat/soportes/zip',
  tipos: [FACTURA_SOAT],
  tiposEnElCuerpo: false,
  // Sin diálogo, el usuario no tiene dónde leer qué entra en el ZIP: esta línea es ese sitio.
  lineaAyuda: 'Se descargan los comprobantes de pago cargados en las filas marcadas.',
};

export const ZIP_IMPUESTOS: SuperficieZip = {
  ruta: '/flito/impuestos/soportes/zip',
  tipos: [FACTURA_VENTA, RECIBO_IMPUESTO],
  tiposEnElCuerpo: true,
};

export const ZIP_TRAMITES: SuperficieZip = {
  ruta: '/flito/tramites/soportes/zip',
  tipos: [FACTURA_VENTA, RECIBO_IMPUESTO, FACTURA_SOAT],
  tiposEnElCuerpo: true,
  notaTransicion: 'Antes este botón traía solo las facturas de venta. Ahora eliges qué documentos entran.',
};

/** Prefijo del nombre que pone el servidor. **Sin placa**: el nombre del ZIP acaba en un asunto de correo. */
const PREFIJO_ZIP = 'soportes';
const NOMBRE_RESPALDO = 'soportes.zip';
/**
 * Lo que el ZIP declara de sí mismo, para el aviso del caso parcial.
 *
 * **Son DOS cifras y la del copy es `registros`, no `incluidos`.** `incluidos` cuenta DOCUMENTOS y
 * `registros` cuenta filas marcadas que aportaron al menos uno. En SOAT casi coinciden; en el ZIP
 * mixto de Trámites no, porque un trámite aporta hasta tres documentos: con `incluidos`, cinco
 * marcadas podrían dar «6 de 5» —una cifra falsa con aspecto de cierta, y encima solo en la pantalla
 * que menos se mira—. La frase habla de «filas marcadas», así que el número tiene que contar filas.
 *
 * Los nombres se importan de `shared-types` y no se escriben aquí: **el nombre de la cabecera ES el
 * contrato**, y un literal repetido en las dos puntas se desincroniza sin que nada se ponga rojo —el
 * síntoma sería que el aviso vuelve al genérico, en verde y sin error en ninguna parte—.
 */
interface ResultadoZip {
  nombre: string;
  /** Filas marcadas que aportaron algo. `null` si no vino la cabecera: entonces, sin cifras. */
  registros: number | null;
}

/** Un entero no negativo de una cabecera, o `null`. Nunca se completa lo que no vino. */
function cifraDeCabecera(bruto: string | null): number | null {
  // `Number('')` es 0 y `Number('x')` es NaN: solo se acepta un entero no negativo, porque un 0 mal
  // leído convertiría una descarga completa en «0 de las 5 filas…», que es mentira.
  const n = bruto === null ? Number.NaN : Number(bruto);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Lanza la descarga y devuelve con qué nombre se guardó y cuántas filas aportaron documento.
 *
 * `downloadPostNamed` es lo que hace que un error VESTIDO de archivo no acabe en la carpeta de
 * descargas: `request()` mira el `content-type` antes que `res.ok`, así que un 409 con cabecera de
 * zip sale por la rama del blob y `errorVestidoDeArchivo` lo reconstruye como `ApiError`. Ese
 * guardia vive en `lib/api.ts`; aquí solo hay que usarlo.
 */
export async function descargarSoportes(
  superficie: SuperficieZip, ids: string[], tipos: TipoSoporteZip[],
): Promise<ResultadoZip> {
  let registros: number | null = null;
  const nombre = await api.downloadPostNamed(
    superficie.ruta,
    NOMBRE_RESPALDO,
    superficie.tiposEnElCuerpo ? { ids, tipos } : { ids },
    (n) => esNombreDeExport(PREFIJO_ZIP, n, 'zip'),
    (leer) => { registros = cifraDeCabecera(leer(CABECERAS_ZIP_SOPORTES.registros)); },
  );
  return { nombre, registros };
}

/** `codigo` estable del cuerpo de error. **Nunca se mira el texto para DECIDIR nada.** */
function codigoDe(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const cuerpo = e.rawDetails as { codigo?: unknown } | null | undefined;
  return typeof cuerpo?.codigo === 'string' ? cuerpo.codigo : null;
}

/** El texto que escribió el SERVIDOR, de su propio campo y no del mensaje ya derivado por el cliente. */
function textoDelServidor(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const cuerpo = e.rawDetails as { error?: unknown } | null | undefined;
  const texto = typeof cuerpo?.error === 'string' ? cuerpo.error.trim() : '';
  return texto.length > 0 ? texto : null;
}

/** «factura de venta», «los documentos que elegiste» — cómo nombrar lo pedido en una frase. */
function loPedido(superficie: SuperficieZip, tipos: TipoSoporteZip[]): string {
  if (tipos.length === 1) {
    const opcion = superficie.tipos.find((t) => t.valor === tipos[0]);
    if (opcion) return opcion.enFrase;
  }
  return 'los documentos que elegiste';
}

/**
 * Qué se le dice al usuario cuando el ZIP falla.
 *
 * **Los dos casos propios se reconocen por `codigo` y NO por el HTTP**: el AC6 es el mismo suceso
 * llegue con 409 o con 422, y atar la interfaz al número dejaría al usuario leyendo «avisa a
 * soporte» el día que el backend afine el estado. Todo lo demás —429, 403, corte, genérico— cae en
 * `avisoDeError`, que es la función de la #11909 y no se reescribe.
 *
 * **Ninguno de los dos propios ofrece reintento**: repetir la misma petición da lo mismo. Lo que hay
 * que cambiar es la selección o el tipo, y eso lo dice el propio mensaje.
 */
export function avisoDeZip(
  e: unknown, marcadas: number, superficie: SuperficieZip, tipos: TipoSoporteZip[],
): AvisoExport {
  const codigo = codigoDe(e);
  if (codigo === CODIGO_ZIP_SIN_SOPORTES) {
    return {
      tono: 'error',
      reintentable: false,
      texto: textoDelServidor(e)
        ?? `Ninguna de las ${marcadas} filas marcadas tiene ${loPedido(superficie, tipos)}. `
          + 'No se descargó nada.',
    };
  }
  // PESO. Se puede chocar con TRES filas si sus documentos son enormes, así que la salida es quitar
  // esas de la selección — «marca menos filas» sería mandarle a probar a ciegas.
  if (codigo === CODIGO_ZIP_DEMASIADO_GRANDE) {
    return {
      tono: 'error',
      reintentable: false,
      // Sin cifra en el respaldo, a propósito: el presupuesto en MB es una variable de ENTORNO del
      // API y el número de verdad solo lo trae el 422 escrito en su propio mensaje. Cualquier cifra
      // compilada aquí queda verde hoy y miente el día en que un despliegue mueva la variable.
      texto: textoDelServidor(e)
        ?? 'Los documentos seleccionados pesan más de lo que admite una descarga. Quita de la '
          + 'selección los registros con documentos más pesados y vuelve a intentarlo.',
    };
  }
  // CANTIDAD. Otro caso y otra salida: aquí sí es «marca menos filas», aunque cada una pese nada.
  // Normalmente no se llega —`avisoDeTope` lo ataja antes de la petición—; esta rama cubre el
  // desajuste de versiones, cuando el tope del servidor es menor que el compilado en la pantalla.
  if (codigo === CODIGO_ZIP_DEMASIADOS_REGISTROS) {
    return { tono: 'error', reintentable: false, texto: textoDelServidor(e) ?? textoDeTope() };
  }
  return avisoDeError(e);
}

/**
 * El copy del tope de CANTIDAD, con el número de `shared-types`.
 *
 * Aquí sí se compila una cifra, al revés que en el tope de peso, y la diferencia no es de criterio:
 * `ZIP_SOPORTES_MAX_REGISTROS` es la **forma del cuerpo** —el mismo valor que el servidor usa como
 * cota dura, publicado para que la pantalla pueda avisar antes—, no una perilla de entorno que un
 * despliegue pueda mover sin que este paquete se entere. Aun así, cuando el error llega del servidor
 * gana SU texto: así el número es el correcto incluso con las dos puntas en versiones distintas.
 */
function textoDeTope(): string {
  return `Solo se pueden descargar los documentos de ${ZIP_SOPORTES_MAX_REGISTROS} registros a la `
    + 'vez. Marca menos filas y vuelve a intentarlo.';
}

/** El texto de la banda de éxito. Con cifras solo cuando el servidor las declaró **y** faltó algo. */
function avisoDeExito(
  { nombre, registros }: ResultadoZip, marcadas: number,
  superficie: SuperficieZip, tipos: TipoSoporteZip[],
): AvisoExport {
  const parcial = registros !== null && registros < marcadas;
  const faltan = marcadas - (registros ?? 0);
  return {
    tono: 'ok',
    reintentable: false,
    texto: parcial
      ? `ZIP descargado: ${nombre} — ${registros} de las ${marcadas} filas marcadas tenían `
        + `${loPedido(superficie, tipos)}; las otras ${faltan} no.`
      : `ZIP descargado: ${nombre}`,
  };
}

export interface EstadoDescargaZip {
  ocupado: boolean;
  aviso: AvisoExport | null;
  /** Cuántas filas iban en la última petición: es la cifra que se lee en el anuncio y en el aviso. */
  marcadas: number;
  descargar: (ids: string[], tipos: TipoSoporteZip[]) => void;
  reintentar: () => void;
  descartar: () => void;
}

/**
 * El estado de la descarga, con el candado del doble clic.
 *
 * **El candado es una `ref` y no el `disabled` del botón**, y la diferencia es la lección que costó
 * un rojo intermitente en la HU #11562: `disabled` es una propiedad que React escribe en el DOM en
 * el commit SIGUIENTE al clic, y entre el primer clic y ese commit cabe un segundo —un doble clic
 * humano, un `click()` desde el teclado, un lector que reenvía el evento— que encontraría el botón
 * todavía habilitado y saldría a la red. «No admite un segundo clic» es una afirmación sobre la
 * PETICIÓN, no sobre un atributo. Aquí importa el doble: un ZIP de 100 PDF cuesta caro en el
 * servidor y la segunda petición es trabajo real, no un byte de más.
 *
 * `ultima` guarda ids y tipos para que «Reintentar la descarga» repita EXACTAMENTE lo mismo: leerlo
 * otra vez de la selección enviaría algo distinto de lo que falló.
 */
export function useDescargaZip(superficie: SuperficieZip): EstadoDescargaZip {
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState<AvisoExport | null>(null);
  const [marcadas, setMarcadas] = useState(0);
  const enVuelo = useRef(false);
  const ultima = useRef<{ ids: string[]; tipos: TipoSoporteZip[] } | null>(null);

  const descargar = useCallback((ids: string[], tipos: TipoSoporteZip[]) => {
    if (enVuelo.current || ids.length === 0 || tipos.length === 0) return;
    // El tope de CANTIDAD se ataja aquí, sin gastar la petición: marcar 120 filas con «seleccionar
    // todo» es lo más fácil de hacer sin querer en esta tabla, y el viaje solo serviría para traer
    // de vuelta el mismo número que ya está publicado. `reintentable: false` porque repetir da lo
    // mismo — lo que hay que cambiar es la selección.
    setMarcadas(ids.length);
    if (ids.length > ZIP_SOPORTES_MAX_REGISTROS) {
      setAviso({ tono: 'error', reintentable: false, texto: textoDeTope() });
      return;
    }
    enVuelo.current = true;
    ultima.current = { ids, tipos };
    setOcupado(true);
    setAviso(null);

    descargarSoportes(superficie, ids, tipos)
      .then((r) => setAviso(avisoDeExito(r, ids.length, superficie, tipos)))
      .catch((e) => setAviso(avisoDeZip(e, ids.length, superficie, tipos)))
      .finally(() => {
        enVuelo.current = false;
        setOcupado(false);
      });
  }, [superficie]);

  const reintentar = useCallback(() => {
    const previa = ultima.current;
    if (previa) descargar(previa.ids, previa.tipos);
  }, [descargar]);

  const descartar = useCallback(() => setAviso(null), []);

  return { ocupado, aviso, marcadas, descargar, reintentar, descartar };
}

/**
 * El botón de la barra de selección y, si hay más de un tipo, su diálogo.
 *
 * El número del rótulo es el de filas MARCADAS —y aquí sí es el total, a diferencia de «Enviar» y
 * «Certificar»—: la acción aplica a todas, y esa es justo la diferencia que hace comprensible el
 * desajuste que aquellos dos declaran con su «(3 de 8)».
 *
 * **No se deshabilita por «ninguna tiene documentos»**: el cliente no sabe qué soportes existen y
 * adivinarlo lo llevaría a apagar el botón sin motivo. Quien lo sabe es el servidor, y lo dice con
 * el AC6.
 */
export function DescargarSoportesZip(
  { superficie, ids, ocupado, onDescargar }:
  {
    superficie: SuperficieZip; ids: string[]; ocupado: boolean;
    onDescargar: (ids: string[], tipos: TipoSoporteZip[]) => void;
  },
) {
  const [abierto, setAbierto] = useState(false);
  const conDialogo = superficie.tipos.length > 1;

  const alPulsar = () => {
    if (conDialogo) { setAbierto(true); return; }
    onDescargar(ids, superficie.tipos.map((t) => t.valor));
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        className={flitBtnSecondary}
        style={flitBtnSecondaryStyle}
        onClick={alPulsar}
        disabled={ocupado || ids.length === 0}
        aria-busy={ocupado || undefined}
      >
        {/* «Descargar soportes» y no «Descargar» a secas: en Impuestos convive con «Descargar
            certificado» por fila, y dos botones con el mismo nombre accesible en la misma pantalla
            son dos acciones indistinguibles para quien navega con lector. */}
        {ocupado ? 'Preparando el ZIP…' : `Descargar soportes (${ids.length})`}
      </button>
      {superficie.lineaAyuda && (
        <span className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          {superficie.lineaAyuda}
        </span>
      )}
      {abierto && (
        <DialogoTipos
          superficie={superficie}
          marcadas={ids.length}
          onCancelar={() => setAbierto(false)}
          onConfirmar={(tipos) => {
            // Se cierra ANTES de lanzar: un ZIP de 100 PDF puede tardar y retener la pantalla tras
            // un modal todo ese rato es peor que el problema. El foco vuelve solo al botón que lo
            // abrió (`useFocusTrap`), que es justo el que pasa a `aria-busy`.
            setAbierto(false);
            onDescargar(ids, tipos);
          }}
        />
      )}
    </div>
  );
}

/**
 * El diálogo de tipos: `FlitModal` + un `fieldset`.
 *
 * **No se crea un componente de diálogo nuevo.** `FlitModal` ya trae `role="dialog"`, `aria-modal`,
 * nombre accesible desde `title`, foco que entra, se atrapa y se restaura, Esc que cierra solo el de
 * más arriba y cierre por backdrop. Lo que no hay en el repo es un «modal con casillas», y eso se
 * compone con `<fieldset>` + `<label>` del kit, no con un sistema nuevo.
 *
 * **No se le pasa `restoreFocusRef`**: el botón que abre sigue montado al cerrar —la descarga no
 * refresca la cola— y ese respaldo solo hace falta cuando el disparador desaparece.
 *
 * **Todas las casillas marcadas por defecto**: el caso frecuente es «todo lo que tengan estas filas»
 * y así el gesto memorizado del botón viejo de Trámites sigue trayendo su factura de venta.
 */
function DialogoTipos(
  { superficie, marcadas, onCancelar, onConfirmar }:
  {
    superficie: SuperficieZip; marcadas: number;
    onCancelar: () => void; onConfirmar: (tipos: TipoSoporteZip[]) => void;
  },
) {
  const [elegidos, setElegidos] = useState<TipoSoporteZip[]>(
    () => superficie.tipos.map((t) => t.valor),
  );
  const sinTipos = elegidos.length === 0;

  const alternar = (valor: TipoSoporteZip, marcado: boolean) => setElegidos(
    (previos) => marcado
      ? [...previos, valor]
      : previos.filter((v) => v !== valor),
  );

  return (
    <FlitModal title="Documentos del ZIP" onClose={onCancelar}>
      <div className="space-y-4">
        {superficie.notaTransicion && (
          <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            {superficie.notaTransicion}
          </p>
        )}

        {/* El `fieldset` con `legend` es lo que da contexto al grupo cuando las casillas se recorren
            una a una con lector: sin él, «Factura de venta» llega sola y sin decir de qué filas. */}
        <fieldset className="space-y-3">
          <legend className="mb-2 text-sm font-semibold" style={{ color: 'var(--flit-blue-text)' }}>
            Qué se descarga de las {marcadas} filas marcadas
          </legend>
          {superficie.tipos.map((t) => (
            <label key={t.valor} className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={elegidos.includes(t.valor)}
                aria-describedby={`zip-ayuda-${t.valor}`}
                onChange={(e) => alternar(t.valor, e.target.checked)}
              />
              <span>
                <span className="font-medium">{t.rotulo}</span>
                <span
                  id={`zip-ayuda-${t.valor}`}
                  className="block text-xs"
                  style={{ color: 'var(--flit-text-secondary)' }}
                >
                  {t.ayuda}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          Se descarga un solo ZIP. Cada archivo va con el nombre PLACA-ORGANISMO.
        </p>

        {/* Un `disabled` no dice por qué lo está, así que el motivo se anuncia: aparece a la vez que
            el botón se apaga. Tinta `--flit-danger-ink`, nunca `--flit-danger` a 14 px (Bug #11604). */}
        {sinTipos && (
          <p role="status" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
            Elige al menos un tipo de documento.
          </p>
        )}

        <div className="flex justify-end gap-2">
          {/* «Cancelar» además del aspa de `FlitModal`: es un diálogo de decisión, no un visor. */}
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onCancelar}>
            Cancelar
          </button>
          <button
            type="button"
            className={flitBtnPrimary}
            style={flitBtnPrimaryStyle}
            disabled={sinTipos}
            onClick={() => onConfirmar(elegidos)}
          >
            Descargar
          </button>
        </div>
      </div>
    </FlitModal>
  );
}

/**
 * La banda de resultado y el anuncio de los cuatro estados de la acción.
 *
 * **El reparto entre las dos regiones es el de `AvisoExportCola` y no una simetría bonita:**
 *
 *   · `ocupado` y el éxito van por una `role="status"` **siempre montada** que solo cambia de
 *     contenido. Una región polite que se monta ya rellena no dispara anuncio en varios lectores.
 *   · El error va por `role="alert"` dentro de `AvisoVisible`, que sí se anuncia al insertarse, y
 *     por eso NO se repite en la polite: dicho dos veces se oye dos veces.
 *
 * A diferencia del export, aquí **sí hay una línea visible mientras trabaja**: un ZIP tarda más que
 * un Excel y el único cambio en pantalla sería el rótulo del botón.
 *
 * Se monta donde se monta el botón —y no colgada de la selección—, para que el aviso siga en pantalla
 * después de que el usuario limpie lo marcado.
 */
export function AvisoSoportesZip(
  { ocupado, marcadas, aviso, onReintentar, onDescartar }:
  {
    ocupado: boolean; marcadas: number; aviso: AvisoExport | null;
    onReintentar: () => void; onDescartar: () => void;
  },
) {
  const esError = aviso?.tono === 'error';
  const anuncio = ocupado
    ? `Preparando el ZIP con los soportes de ${marcadas} filas.`
    : (aviso && !esError ? aviso.texto : '');

  return (
    <>
      <p className="sr-only" role="status">{anuncio}</p>
      {ocupado && (
        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          Estamos armando el ZIP. Puede tardar; puedes seguir en la cola mientras tanto.
        </p>
      )}
      {!ocupado && aviso && (
        <AvisoVisible aviso={aviso} onReintentar={onReintentar} onDescartar={onDescartar} />
      )}
    </>
  );
}
