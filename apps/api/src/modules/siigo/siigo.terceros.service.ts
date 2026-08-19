// Siigo — asegurar que el cliente existe como tercero antes de facturar (HU #11297, Feature #11241).
//
// Una factura electrónica se emite CONTRA un tercero. Si el cliente no existe en Siigo, no hay
// factura; si existe duplicado, la factura sale contra el equivocado. Esta historia es el puente, y
// es la primera del programa que ESCRIBE fuera de FLITO.
//
// CUATRO DECISIONES
//
//   1. **Se consulta antes de crear, y se consulta por la PAREJA.** En Siigo una identificación
//      puede repetirse si la sucursal es distinta (§2 de la documentación), así que el NIT solo no
//      identifica a nadie. Buscar por identificación a secas y quedarse con el primero vincularía el
//      cliente al tercero de otra sucursal: una factura fiscal mal dirigida.
//   2. **La actualización LEE antes de escribir.** El `PUT` de Siigo reemplaza, no fusiona: un campo
//      omitido queda vacío en Siigo Nube. Y FLITO no modela todo lo que Siigo guarda —vendedor,
//      cobrador, comentarios—. Mandar «el objeto completo» construido solo con lo que FLITO sabe
//      borraría el resto. Así que se trae el tercero actual y se superpone lo nuestro encima. Es lo
//      que el AC3 pide con todas las letras: reenviar completo Y no vaciar lo que ya estaba.
//   3. **La huella evita la llamada, y evita una copia de los datos.** Guardar lo enviado permitiría
//      comparar, y sería una segunda copia de nombre, dirección y teléfono en otra tabla. El hash
//      responde «¿cambió?» sin conservar el qué. Lo que la tabla SÍ guarda en claro es la
//      identificación —hace falta para reencontrar el tercero—, y por eso entra en el flujo de
//      olvido: decir «aquí solo hay un hash» habría sido verdad de una columna y mentira de la tabla.
//   4. **Un cliente no facturable no sale a la red.** La comprobación la hace el validador que ya
//      existe (HU #11296) y lanza con los motivos nombrados. No se reimplementa aquí.

import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { RESPONSABILIDADES_FISCALES_CODIGOS, SIIGO_ID_TIPOS_CODIGOS } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { clients, siigoTerceros } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import { siigoRequestOrThrow } from './siigo.client.js';
import { claveResiliencia } from './siigo.catalogos.service.js';
import { armarNombreSiigo } from './siigo.nombre.js';
import { modoSiigo } from './siigo.mock.js';
import { registrarOperacion } from './siigo.operaciones.repo.js';
import { motivoLegible } from './siigo.productos.service.js';
// `esViolacionDeUnico` y no una comprobación propia de `code === '23505'`: desde drizzle 0.45 el
// código de Postgres viaja dentro de `cause`, y ese archivo ya documenta por qué. Escribir la
// tercera copia sería el patrón que estas Features llevan corrigiendo toda la iteración.
import { detalleTecnico, esViolacionDeUnico } from './siigo.redaccion.js';
import { ejecutarConResiliencia } from './siigo.resiliencia.js';
import { ClienteNoFacturableError, exigirClienteFacturable } from './siigo.validador-cliente.service.js';
import type { SiigoAmbiente } from './credenciales.service.js';

const log = loggerFor('siigo.terceros');

/** Crear o actualizar un tercero es una escritura. Más margen que una consulta, menos que emitir. */
export const TIMEOUT_TERCERO_MS = 30_000;

/** Circuito propio: que la sincronización de terceros esté caída no debe frenar otras consultas. */
export function claveCortacircuitosTerceros(ambiente: string): string {
  return `siigo:terceros:${ambiente}`;
}

/** Fallo con nombre propio. La ruta lo traduce a HTTP; el servicio no sabe de códigos de estado. */
export class SiigoTerceroError extends Error {
  readonly codigo: 'cliente_no_existe' | 'sin_identificacion' | 'siigo_rechazo';

  constructor(codigo: SiigoTerceroError['codigo'], message: string) {
    super(message);
    this.name = 'SiigoTerceroError';
    this.codigo = codigo;
  }
}

/** La ficha del cliente, en lo que Siigo necesita. */
interface FichaCliente {
  id: number;
  name: string;
  document: string | null;
  idType: string | null;
  personType: string | null;
  branchOffice: number;
  commercialName: string | null;
  fiscalResponsibilities: string[];
  countryCode: string | null;
  stateCode: string | null;
  cityCode: string | null;
  address: string | null;
  contactFirstName: string | null;
  contactLastName: string | null;
  contactEmail: string | null;
  phoneIndicative: string | null;
  phoneNumber: string | null;
}

/** El objeto que viaja a Siigo. Los nombres son los suyos, no los nuestros. */
export interface TerceroSiigo {
  person_type: string;
  id_type: string;
  identification: string;
  branch_office: number;
  name: string[];
  commercial_name?: string;
  fiscal_responsibilities: { code: string }[];
  address: {
    address: string;
    city: { country_code: string; state_code: string; city_code: string };
  };
  // OPCIONALES en el tipo aunque Siigo los exija al CREAR, y la diferencia es la que evita un
  // borrado. Con un `PUT` que reemplaza, `phones: []` no significa «no tengo teléfono»: significa
  // «bórrale el teléfono». Omitir la clave deja intacto lo que Siigo tuviera; mandarla vacía lo
  // destruye. Si al crear faltan, Siigo rechaza — que es ruidoso, visible y reversible.
  phones?: { indicative?: string; number: string }[];
  contacts?: { first_name: string; last_name?: string; email?: string }[];
}

/**
 * Lo ÚNICO que hace falta para buscar el tercero en Siigo: la pareja identificación + sucursal.
 *
 * Existe aparte de `armarTercero` porque buscar y escribir necesitan cosas distintas, y meterlas en
 * la misma puerta tenía una consecuencia concreta: un cliente sin clasificar en FLITO —sin tipo de
 * persona, sin tipo de documento— no se podía ni BUSCAR, aunque estuviera perfectamente cargado en
 * Siigo Nube con todos esos datos. El candado estaba del lado equivocado de la puerta que abre.
 *
 * `GET /v1/customers` solo filtra por `identification` y `branch_office`, así que esto es
 * literalmente todo lo que la consulta consume.
 */
export function identidadDeCliente(c: FichaCliente): { identification: string; branch_office: number } {
  const identificacion = (c.document ?? '').trim();
  if (identificacion === '') {
    throw new SiigoTerceroError('sin_identificacion', 'El cliente no tiene identificación.');
  }
  return { identification: identificacion, branch_office: c.branchOffice };
}

/**
 * Marca de «vinculado, pero la ficha local no da para armar el tercero».
 *
 * No es un sha256 y no puede serlo: 64 caracteres hexadecimales nunca van a producir esta cadena,
 * así que ninguna comparación de huellas la acepta por accidente y la próxima sincronización vuelve
 * a intentar completar la ficha en vez de responder «nada cambió».
 */
export const SIN_HUELLA = 'sin-armar';

export type Armado =
  | { ok: true; valor: TerceroSiigo }
  | { ok: false; error: SiigoTerceroError };

/**
 * `armarTercero` en forma de resultado, para las ramas que pueden seguir sin él.
 *
 * Existe porque «no se puede armar» dejó de ser un final: entre el intento y la escritura está la
 * lectura de Siigo, que a menudo aporta justo lo que faltaba. Solo se relanza el fallo cuando ya no
 * queda de dónde sacarlo.
 *
 * Captura únicamente `SiigoTerceroError`. Cualquier otra excepción es un defecto de programación y
 * tragarla la convertiría en un «falta un dato» que mandaría a alguien a revisar una ficha correcta.
 */
export function intentarArmar(c: FichaCliente): Armado {
  try {
    return { ok: true, valor: armarTercero(c) };
  } catch (e) {
    if (e instanceof SiigoTerceroError) return { ok: false, error: e };
    throw e;
  }
}

/**
 * Arma el objeto COMPLETO que Siigo espera a partir de la ficha del cliente.
 *
 * **Pura.** No lee la base ni llama a nadie, así que las reglas de forma —que son casi todo el
 * riesgo de esta historia— se prueban sin red. Lo que no se puede armar bien NO se maquilla: un
 * «NO REPORTA» de relleno sería una afirmación ante la DIAN que nadie autorizó.
 *
 * **Solo hace falta para ESCRIBIR** (`POST` o `PUT`). Para buscar basta `identidadDeCliente`, y las
 * ramas que únicamente vinculan usan `intentarArmar` para poder seguir aunque esto falle.
 */
export function armarTercero(c: FichaCliente): TerceroSiigo {
  const { identification: identificacion } = identidadDeCliente(c);

  // Se comprueba contra el catálogo, no solo que no esté vacío: la columna tiene su CHECK en la
  // base, pero este objeto viaja a un sistema de contabilidad y un código inventado se convierte
  // allá en un tercero con el tipo de documento equivocado.
  const idType = (c.idType ?? '').trim();
  if (!(SIIGO_ID_TIPOS_CODIGOS as readonly string[]).includes(idType)) {
    throw new SiigoTerceroError('sin_identificacion',
      'El cliente no tiene un tipo de identificación válido de Siigo. Confírmelo en su ficha fiscal.');
  }

  const nombre = armarNombreSiigo({
    personType: c.personType,
    name: c.name,
    contactFirstName: c.contactFirstName,
    contactLastName: c.contactLastName,
  });
  // No se maquilla lo que no se puede armar. `armarNombreSiigo` (HU #11295) devuelve el motivo
  // nombrado, y un «NO REPORTA» de relleno sería una afirmación ante la DIAN que nadie autorizó.
  if (!nombre.ok) {
    throw new SiigoTerceroError('sin_identificacion', nombre.detalle);
  }

  const tercero: TerceroSiigo = {
    // `Company` por defecto NO es una suposición cómoda: es lo que la migración 0132 derivó del
    // tipo de documento, y `person_type_origen` deja rastro de quién lo decidió.
    person_type: c.personType === 'Person' ? 'Person' : 'Company',
    // `id_type` sale de la columna que la 0132 creó PARA esto, con su CHECK contra el catálogo de
    // Siigo, y no de `document_type` —varchar(5) libre y heredado— que es además la que el validador
    // de facturabilidad NO mira. Un fallback aquí sería peor que el error: mandaría a Siigo un tipo
    // de identificación inventado sobre un documento fiscal.
    id_type: idType,
    identification: identificacion,
    branch_office: c.branchOffice,
    name: nombre.valor.name,
    fiscal_responsibilities: c.fiscalResponsibilities.map((code) => ({ code })),
    address: {
      address: (c.address ?? '').trim(),
      city: {
        country_code: c.countryCode ?? '',
        state_code: c.stateCode ?? '',
        city_code: c.cityCode ?? '',
      },
    },
  };

  if (c.commercialName && c.commercialName.trim() !== '') {
    tercero.commercial_name = c.commercialName.trim();
  }
  // Los opcionales solo se incluyen cuando HAY dato. Mandar un teléfono vacío no es lo mismo que no
  // mandarlo: con un `PUT` que reemplaza, el vacío BORRA lo que Siigo tuviera.
  if (c.phoneNumber && c.phoneNumber.trim() !== '') {
    tercero.phones = [{
      ...(c.phoneIndicative ? { indicative: c.phoneIndicative.trim() } : {}),
      number: c.phoneNumber.trim(),
    }];
  }
  if (c.contactFirstName && c.contactFirstName.trim() !== '') {
    tercero.contacts = [{
      first_name: c.contactFirstName.trim(),
      ...(c.contactLastName ? { last_name: c.contactLastName.trim() } : {}),
      ...(c.contactEmail ? { email: c.contactEmail.trim() } : {}),
    }];
  }

  return tercero;
}

// ── Hidratación: lo que Siigo puede aportarle a la ficha de FLITO (C7) ──────

/**
 * Los campos de `clients` que un tercero de Siigo puede rellenar.
 *
 * Exactamente los que exige `evaluarCliente` para considerar facturable a un cliente, y ni uno más:
 * hidratar es tapar el hueco que impide facturar, no importar la ficha entera de Siigo a FLITO.
 */
export interface HuecosDeCliente {
  /**
   * Los dos que deciden si el tercero se puede siquiera ARMAR, y por eso encabezan la lista.
   *
   * Sin ellos `armarTercero` no produce nada, así que un cliente al que le falten queda fuera de
   * todas las ramas —incluida la de vincular, que no los necesita para nada—. Siigo los publica en
   * `person_type` y `id_type.code`, y es la fuente correcta: sobre un tercero que ya existe allá,
   * lo que Siigo diga que es MANDA sobre lo que FLITO haya dejado sin clasificar.
   */
  personType?: 'Person' | 'Company';
  idType?: string;
  fiscalResponsibilities?: string[];
  address?: string;
  countryCode?: string;
  stateCode?: string;
  cityCode?: string;
  phoneIndicative?: string;
  phoneNumber?: string;
  contactFirstName?: string;
  contactLastName?: string;
}

/** Recorta y descarta el vacío. `undefined` significa «Siigo tampoco lo tiene». */
function texto(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const limpio = v.trim();
  if (limpio === '' || limpio.length > max) return undefined;
  return limpio;
}

/** Un teléfono de FLITO son dígitos y como mucho diez. Lo que no encaje NO se guarda: ver abajo. */
function digitos(v: unknown): string | undefined {
  const t = texto(v, 10);
  return t !== undefined && /^[0-9]{1,10}$/.test(t) ? t : undefined;
}

/**
 * El inverso de `armarTercero`: qué le puede aportar a FLITO el tercero que Siigo ya tiene (C7).
 *
 * **Función pura y sin base de datos**, igual que su gemela, y por el mismo motivo: lo que sale de
 * aquí acaba en la ficha fiscal de un cliente.
 *
 * **Lo que no encaja se descarta en silencio, y es deliberado.** Siigo admite en un teléfono cosas
 * que la columna de FLITO no —`varchar(10)` y solo dígitos, porque la ruta de clientes lo exige
 * así—, y una responsabilidad fiscal que no esté en el catálogo de la DIAN no es un dato: es un
 * código que nadie va a poder interpretar. Ante la duda se deja el hueco: un hueco lo ve quien
 * factura y lo llena en un minuto, mientras que un valor colado en una ficha fiscal se descubre
 * cuando la DIAN rechaza la factura.
 */
export function camposDesdeTercero(existente: Record<string, unknown>): HuecosDeCliente {
  const huecos: HuecosDeCliente = {};

  // Tipo de persona. Los dos únicos valores que FLITO admite, y se comprueban: `person_type` viaja
  // como texto libre en la respuesta, y colar un tercer valor en la columna rompería el `CHECK`.
  const tipoPersona = texto(existente.person_type, 20);
  if (tipoPersona === 'Person' || tipoPersona === 'Company') huecos.personType = tipoPersona;

  // Tipo de identificación. Se valida contra el catálogo por el mismo motivo que `armarTercero` lo
  // valida al salir: este código viaja a un sistema contable, y uno inventado se convierte allá en
  // un tercero con el documento equivocado.
  const idTipo = esObjeto(existente.id_type) ? texto(existente.id_type.code, 10) : undefined;
  if (idTipo !== undefined && (SIIGO_ID_TIPOS_CODIGOS as readonly string[]).includes(idTipo)) {
    huecos.idType = idTipo;
  }

  const responsabilidades = Array.isArray(existente.fiscal_responsibilities)
    ? (existente.fiscal_responsibilities as Array<Record<string, unknown>>)
      .map((r) => texto(r?.code, 10))
      .filter((c): c is string => c !== undefined
        && (RESPONSABILIDADES_FISCALES_CODIGOS as readonly string[]).includes(c))
    : [];
  if (responsabilidades.length > 0) huecos.fiscalResponsibilities = responsabilidades;

  const direccion = esObjeto(existente.address) ? existente.address : undefined;
  if (direccion) {
    const calle = texto(direccion.address, 300);
    if (calle !== undefined) huecos.address = calle;

    const ciudad = esObjeto(direccion.city) ? direccion.city : undefined;
    if (ciudad) {
      const pais = texto(ciudad.country_code, 2);
      const departamento = texto(ciudad.state_code, 5);
      const municipio = texto(ciudad.city_code, 10);
      // Los tres o ninguno: el validador los evalúa como una sola cosa («falta el país, el
      // departamento o la ciudad»), así que rellenar dos de tres deja el motivo en pie y encima
      // esconde cuál falta.
      if (pais && departamento && municipio) {
        huecos.countryCode = pais;
        huecos.stateCode = departamento;
        huecos.cityCode = municipio;
      }
    }
  }

  const telefono = Array.isArray(existente.phones) && esObjeto(existente.phones[0])
    ? existente.phones[0] : undefined;
  if (telefono) {
    const indicativo = digitos(telefono.indicative);
    const numero = digitos(telefono.number);
    // Igual que la ubicación: el validador pide los dos juntos.
    if (indicativo && numero) {
      huecos.phoneIndicative = indicativo;
      huecos.phoneNumber = numero;
    }
  }

  const contacto = Array.isArray(existente.contacts) && esObjeto(existente.contacts[0])
    ? existente.contacts[0] : undefined;
  if (contacto) {
    const nombre = texto(contacto.first_name, 100);
    if (nombre !== undefined) {
      huecos.contactFirstName = nombre;
      const apellido = texto(contacto.last_name, 100);
      // El apellido acompaña al nombre y solo si viene; su ausencia no es un hueco que bloquee.
      if (apellido !== undefined) huecos.contactLastName = apellido;
    }
  }

  return huecos;
}

/**
 * Rellena en la ficha del cliente SOLO lo que está vacío, con lo que Siigo ya sabe (C7).
 *
 * Devuelve los nombres de los campos rellenados, para la bitácora. Vacío = no había nada que
 * rellenar, que es el caso normal a partir de la segunda vez.
 *
 * **De una sola vía y solo sobre huecos.** Nunca pisa un valor que FLITO tenga, ni siquiera si
 * difiere del de Siigo: eso sería convertir a Siigo en el maestro de la ficha y abrir la pregunta de
 * quién gana en el `PUT` siguiente, que es justo lo que `fusionarConExistente` decidió no abrir.
 * Aquí solo se responde a «FLITO no lo sabe y Siigo sí».
 */
export async function hidratarClienteDesdeSiigo(
  clienteId: number, existente: Record<string, unknown> | null,
): Promise<string[]> {
  if (!existente) return [];
  const huecos = camposDesdeTercero(existente);
  if (Object.keys(huecos).length === 0) return [];

  const actual = await cargarCliente(clienteId);
  if (!actual) return [];

  const cambios: Record<string, unknown> = {};
  const puesto: string[] = [];

  const rellenarSiVacio = (campo: keyof HuecosDeCliente, vacioAhora: boolean) => {
    const valor = huecos[campo];
    if (valor === undefined || !vacioAhora) return;
    cambios[campo] = valor;
    puesto.push(campo);
  };

  // Primero los dos que desbloquean el armado. `personType` cuenta como vacío cuando no es ninguno
  // de los dos valores válidos: la 0132 dejó filas con la columna en blanco, y una cadena vacía no
  // es «persona natural», es «nadie lo ha clasificado».
  rellenarSiVacio('personType', actual.personType !== 'Person' && actual.personType !== 'Company');
  rellenarSiVacio('idType', !(SIIGO_ID_TIPOS_CODIGOS as readonly string[])
    .includes((actual.idType ?? '').trim()));
  rellenarSiVacio('fiscalResponsibilities', (actual.fiscalResponsibilities ?? []).length === 0);
  rellenarSiVacio('address', vacioTexto(actual.address));
  // La terna de ubicación se evalúa junta, igual que se arma junta.
  const sinUbicacion = vacioTexto(actual.countryCode) || vacioTexto(actual.stateCode) || vacioTexto(actual.cityCode);
  rellenarSiVacio('countryCode', sinUbicacion);
  rellenarSiVacio('stateCode', sinUbicacion);
  rellenarSiVacio('cityCode', sinUbicacion);
  const sinTelefono = vacioTexto(actual.phoneIndicative) || vacioTexto(actual.phoneNumber);
  rellenarSiVacio('phoneIndicative', sinTelefono);
  rellenarSiVacio('phoneNumber', sinTelefono);
  const sinContacto = vacioTexto(actual.contactFirstName);
  rellenarSiVacio('contactFirstName', sinContacto);
  rellenarSiVacio('contactLastName', sinContacto && vacioTexto(actual.contactLastName));

  if (puesto.length === 0) return [];

  // Sin sello de actualización: `clients` no tiene `updated_at`. El rastro de esta escritura queda
  // en la bitácora de Siigo, con los NOMBRES de los campos rellenados y nunca sus valores —son
  // dirección, teléfono y nombre de una persona, y `siigo_operaciones` es append-only—.
  await db.update(clients).set(cambios).where(eq(clients.id, clienteId));

  return puesto;
}

function vacioTexto(v: string | null | undefined): boolean {
  return v === null || v === undefined || v.trim() === '';
}

/**
 * Huella del objeto EXACTO que se envía (AC4).
 *
 * Sobre el objeto y no sobre la fila del cliente: dos filas distintas pueden producir el mismo
 * objeto —un espacio de más, una mayúscula— y en ese caso no hay nada que actualizar en Siigo. La
 * huella tiene que responder «¿cambia lo que Siigo va a ver?», no «¿cambió algo en nuestra tabla?».
 *
 * Las claves se ordenan antes de serializar: `JSON.stringify` respeta el orden de inserción, así que
 * sin ordenar, reordenar dos campos del objeto produciría una huella distinta y una llamada inútil.
 */
export function huellaDeTercero(t: TerceroSiigo): string {
  return createHash('sha256').update(estable(t)).digest('hex');
}

function estable(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(estable).join(',')}]`;
  if (valor !== null && typeof valor === 'object') {
    const claves = Object.keys(valor as Record<string, unknown>).sort();
    return `{${claves.map((k) => `${JSON.stringify(k)}:${estable((valor as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(valor ?? null);
}

/**
 * Superpone lo que FLITO sabe sobre lo que Siigo ya tiene (AC3).
 *
 * **Esta función es la que impide un daño irreversible.** El `PUT` de Siigo reemplaza y no fusiona,
 * y FLITO no modela todo lo que Siigo guarda de un tercero: `related_users.seller_id`, el cobrador,
 * los comentarios, campos adicionales. Enviar «el objeto completo» construido solo con lo nuestro
 * los dejaría vacíos en Siigo Nube — en TODOS los clientes, de una pasada, sin error y sin vuelta
 * atrás, porque son datos que FLITO nunca tuvo y no puede restaurar.
 *
 * Así que lo completo se completa de verdad: se parte del tercero que Siigo devuelve y se pisan solo
 * los campos de los que FLITO es dueño. Lo que no conocemos, ni se toca ni se menciona.
 */
export function fusionarConExistente(
  existente: Record<string, unknown>,
  nuestro: TerceroSiigo,
): Record<string, unknown> {
  // `id` y `metadata` los pone Siigo; reenviarlos no aporta y en algunos endpoints molesta.
  const { id: _id, metadata: _metadata, ...resto } = existente;
  const fusionado: Record<string, unknown> = { ...resto, ...(nuestro as unknown as Record<string, unknown>) };

  // **El spread solo protege el PRIMER nivel, y los campos de FLITO son anidados.** Sin lo que
  // sigue, `address` se reemplaza entero y `address.postal_code` —que FLITO no modela— se borraría
  // en CADA actualización de CADA tercero. Lo mismo con la extensión del teléfono y el teléfono del
  // contacto. Es el mismo borrado silencioso, un nivel más abajo, y el test que solo mira campos de
  // primer nivel no lo ve.
  if (nuestro.address && esObjeto(resto.address)) {
    fusionado.address = { ...resto.address, ...nuestro.address };
  }
  // Los elementos SOBRANTES de las listas también son datos que FLITO no tiene: un segundo teléfono
  // o un segundo contacto cargados en Siigo. Se conserva la cola y se pisa solo la cabeza, que es lo
  // único de lo que FLITO es dueño.
  fusionado.phones = fusionarLista(resto.phones, nuestro.phones);
  fusionado.contacts = fusionarLista(resto.contacts, nuestro.contacts);
  if (fusionado.phones === undefined) delete fusionado.phones;
  if (fusionado.contacts === undefined) delete fusionado.contacts;

  return fusionado;
}

function esObjeto(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Cabeza nuestra, cola de Siigo.
 *
 * Si FLITO no tiene el dato, se devuelve la lista de Siigo intacta —omitirla borraría—. Si lo tiene,
 * el primer elemento es el nuestro y detrás siguen los que Siigo tuviera de más, con sus subcampos
 * (`extension`, `phone` del contacto) conservados en el elemento que pisamos.
 */
function fusionarLista<T extends Record<string, unknown>>(
  deSiigo: unknown, nuestra: T[] | undefined,
): unknown {
  const existentes = Array.isArray(deSiigo) ? (deSiigo as Record<string, unknown>[]) : [];
  if (!nuestra || nuestra.length === 0) {
    return existentes.length > 0 ? existentes : undefined;
  }
  const cabeza = esObjeto(existentes[0]) ? { ...existentes[0], ...nuestra[0] } : nuestra[0];
  return [cabeza, ...existentes.slice(1)];
}

/** Lo que devuelve asegurar un tercero. Nombres, no booleanos: la bitácora los distingue. */
export type DesenlaceTercero = 'vinculado_existente' | 'creado' | 'actualizado' | 'sin_cambios';

export interface ResultadoTercero {
  clienteId: number;
  siigoCustomerId: string;
  identificacion: string;
  sucursal: number;
  desenlace: DesenlaceTercero;
}

async function cargarCliente(clienteId: number): Promise<FichaCliente | null> {
  const [c] = await db.select({
    id: clients.id,
    name: clients.name,
    document: clients.document,
    idType: clients.idType,
    personType: clients.personType,
    branchOffice: clients.branchOffice,
    commercialName: clients.commercialName,
    fiscalResponsibilities: clients.fiscalResponsibilities,
    countryCode: clients.countryCode,
    stateCode: clients.stateCode,
    cityCode: clients.cityCode,
    address: clients.address,
    contactFirstName: clients.contactFirstName,
    contactLastName: clients.contactLastName,
    contactEmail: clients.contactEmail,
    phoneIndicative: clients.phoneIndicative,
    phoneNumber: clients.phoneNumber,
  }).from(clients).where(eq(clients.id, clienteId)).limit(1);

  return c ?? null;
}

/**
 * Busca el tercero en Siigo por la PAREJA identificación + sucursal (AC1, AC2).
 *
 * Devuelve `null` cuando no existe. Los dos filtros van en la consulta y no se filtra en memoria: el
 * listado de Siigo pagina, y filtrar después de traer una página se saltaría los de la segunda.
 */
export async function buscarTercero(
  identificacion: string, sucursal: number, ambiente: string,
): Promise<Record<string, unknown> | null> {
  const datos = await ejecutarConResiliencia(
    () => siigoRequestOrThrow<unknown>({
      metodo: 'GET',
      ruta: `/v1/customers?identification=${encodeURIComponent(identificacion)}&branch_office=${sucursal}`,
      ambiente: ambiente as SiigoAmbiente,
      timeoutMs: TIMEOUT_TERCERO_MS,
    }),
    { clave: claveResiliencia(ambiente), claveCortacircuitos: claveCortacircuitosTerceros(ambiente) },
  );

  const resultados = (datos as { results?: unknown[] } | null)?.results;
  if (!Array.isArray(resultados)) return null;

  // La sucursal se vuelve a comprobar sobre la respuesta. El filtro se manda, pero confiar en que un
  // proveedor externo lo aplique —y quedarse con el primero si no— es exactamente cómo se vincula un
  // cliente al tercero de otra sucursal.
  const exacto = resultados.find((r) => {
    const t = r as Record<string, unknown>;
    return normalizarIdentificacion(String(t.identification ?? '')) === normalizarIdentificacion(identificacion)
      && Number(t.branch_office ?? 0) === sucursal;
  });

  return (exacto as Record<string, unknown> | undefined) ?? null;
}

/**
 * Asegura que el cliente existe como tercero en Siigo y está al día (todos los AC).
 *
 * El orden importa y no es casual: primero lo que no cuesta nada (validar), después lo que cuesta
 * una petición (consultar), y solo entonces lo que escribe fuera de FLITO.
 */
export async function asegurarTercero(clienteId: number): Promise<ResultadoTercero> {
  const cliente = await cargarCliente(clienteId);
  if (!cliente) {
    throw new SiigoTerceroError('cliente_no_existe', `No existe el cliente ${clienteId}.`);
  }

  // C7 — la validación de facturabilidad se exige antes de ESCRIBIR en Siigo, no antes de LEER.
  //
  // Estaba aquí arriba, y era un candado del lado equivocado de la puerta: los cinco campos que
  // pide —responsabilidad fiscal, dirección, ubicación, teléfono, contacto— existen para armar el
  // `POST /v1/customers`, y en la rama que solo VINCULA un tercero que Siigo ya tiene no se usa
  // ninguno. El efecto era que una empresa perfectamente cargada en Siigo Nube no se podía vincular
  // porque la copia de FLITO estaba incompleta, y la única salida era volver a teclear en FLITO lo
  // que ya estaba escrito enfrente.
  //
  // **`armarTercero` bajó por el mismo motivo, y no era una excepción razonable sino el mismo
  // error una puerta más adentro.** Se quedaba arriba «porque hace falta para buscar», y no es
  // cierto: buscar solo consume identificación y sucursal (`identidadDeCliente`). Lo que exigía de
  // más —tipo de persona, tipo de documento, nombre armable— es justo lo que Siigo devuelve y la
  // hidratación sabe copiar, así que pedirlo ANTES de leer dejaba fuera exactamente a los clientes
  // que esta rama existe para rescatar: los que están completos allá y en blanco aquí.
  //
  // Ahora se intenta armar, y si no se puede se sigue adelante con la identidad. Solo las ramas que
  // ESCRIBEN exigen el armado, y para entonces la hidratación ya tuvo su oportunidad.
  const ambiente = process.env.SIIGO_AMBIENTE ?? 'pruebas';
  const identidad = identidadDeCliente(cliente);
  let armado = intentarArmar(cliente);
  let huella = armado.ok ? huellaDeTercero(armado.valor) : null;

  /**
   * El tercero armado, o el fallo original si sigue sin poder armarse.
   *
   * Lo lanza tal cual —`sin_identificacion`, con el campo que falta— porque para cuando se llama a
   * esto ya se leyó de Siigo y se hidrató: si todavía falta algo, es que ni Siigo lo tiene, y el
   * mensaje del validador es lo único accionable que queda.
   */
  const exigirArmado = (): TerceroSiigo => {
    if (armado.ok) return armado.valor;
    throw armado.error;
  };

  const [vinculo] = await db.select().from(siigoTerceros)
    .where(eq(siigoTerceros.clientId, clienteId)).limit(1);

  const bitacora = (resultado: 'ok' | 'error_negocio' | 'error_tecnico', mensaje: string) =>
    registrarOperacion({
      ambiente,
      operacion: 'tercero_asegurar',
      resultado,
      modo: modoSiigo(),
      entidadTipo: 'cliente',
      entidadId: String(clienteId),
      mensaje,
    });

  /**
   * C7 — tapa con lo que Siigo acaba de devolver los huecos de la ficha, y rearma si algo cambió.
   *
   * El rearmado no es opcional: `nuestro` y `huella` se calcularon con la ficha vieja, y guardar esa
   * huella dejaría el vínculo diciendo que hay diferencias con Siigo cuando ya no las hay — un `PUT`
   * inútil en cada sincronización, para siempre.
   */
  const hidratarYRearmar = async (leido: Record<string, unknown> | null): Promise<void> => {
    const rellenados = await hidratarClienteDesdeSiigo(clienteId, leido);
    if (rellenados.length === 0) return;
    const refrescado = await cargarCliente(clienteId);
    if (refrescado) {
      armado = intentarArmar(refrescado);
      huella = armado.ok ? huellaDeTercero(armado.valor) : null;
    }
    await bitacora('ok',
      `Ficha del cliente ${clienteId} completada desde Siigo: ${rellenados.join(', ')}.`);
  };

  try {
    // ── Ya vinculado ────────────────────────────────────────────────────────
    if (vinculo) {
      // AC4 — nada cambió: ni una petición. Es la rama más frecuente con diferencia, porque los
      // datos fiscales de un cliente cambian una vez al año y se factura todas las semanas.
      //
      // Con la ficha sin armar `huella` es `null`, que no coincide con nada: se cae al camino largo,
      // que lee de Siigo e hidrata. Es lo que se quiere — un vínculo cuya ficha local está coja se
      // arregla solo la próxima vez que alguien lo sincroniza.
      if (huella !== null && vinculo.huella === huella) {
        return {
          clienteId, siigoCustomerId: vinculo.siigoCustomerId,
          identificacion: vinculo.identificacion, sucursal: vinculo.sucursal,
          desenlace: 'sin_cambios',
        };
      }

      // AC3 — se lee ANTES de escribir. Ver `fusionarConExistente`: sin esto, actualizar borraría
      // en Siigo Nube todo lo que FLITO no modela.
      // B1 — NO hay rama que emita el `PUT` sin haber leído. `traerPorId` lanza si no puede
      // confirmar qué había: `siigo.client.ts` convierte un 200 con cuerpo ilegible en `null`, y
      // tratar ese `null` como «no existe» y mandar el objeto crudo era exactamente el borrado que
      // toda esta historia previene, entrando por la única puerta que quedaba abierta.
      const existente = await traerPorId(vinculo.siigoCustomerId, ambiente, vinculo.identificacion, vinculo.sucursal);

      // C7 — se rellenan los huecos ANTES de validar. Ya tenemos delante lo que Siigo sabe: pedirle
      // a alguien que lo teclee otra vez para poder mandar un `PUT` sería absurdo.
      await hidratarYRearmar(existente);

      // Aquí SÍ: el `PUT` reemplaza, y mandar la ficha coja de FLITO borraría en Siigo Nube lo que
      // este cliente tenga y nosotros no. `fusionarConExistente` protege lo que FLITO no modela,
      // pero no puede proteger un campo que FLITO sí modela y tiene vacío.
      await exigirClienteFacturable(clienteId);

      const nuestro = exigirArmado();
      const completo = fusionarConExistente(existente, nuestro);

      await ejecutarConResiliencia(
        () => siigoRequestOrThrow<unknown>({
          metodo: 'PUT',
          ruta: `/v1/customers/${encodeURIComponent(vinculo.siigoCustomerId)}`,
          ambiente: ambiente as SiigoAmbiente,
          cuerpo: completo,
          timeoutMs: TIMEOUT_TERCERO_MS,
        }),
        { clave: claveResiliencia(ambiente), claveCortacircuitos: claveCortacircuitosTerceros(ambiente) },
      );

      // B4 — la pareja local se refresca con lo que se ACABA DE ENVIAR. Sin esto, corregir la
      // identificación de un cliente cambiaba la del tercero en Siigo y dejaba la fila local con la
      // vieja: el índice único quedaba desalineado de la realidad y dejaba de proteger.
      await db.update(siigoTerceros)
        .set({
          identificacion: nuestro.identification,
          sucursal: nuestro.branch_office,
          // No es `huella!`: se acaba de armar con éxito —`exigirArmado` habría lanzado— así que
          // se recalcula sobre lo que de verdad se envió, sin apoyarse en una variable que el
          // compilador no puede saber que ya está resuelta.
          huella: huellaDeTercero(nuestro),
          sincronizadoEn: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(siigoTerceros.id, vinculo.id));

      await bitacora('ok', `Tercero del cliente ${clienteId} actualizado en Siigo.`);
      return {
        clienteId, siigoCustomerId: vinculo.siigoCustomerId,
        identificacion: vinculo.identificacion, sucursal: vinculo.sucursal,
        desenlace: 'actualizado',
      };
    }

    // ── Sin vincular ────────────────────────────────────────────────────────
    // AC1 — se consulta antes de crear. Crear a ciegas produciría el duplicado que el índice único
    // de Siigo rechaza… salvo que la sucursal difiera, en cuyo caso lo ACEPTA y quedan dos.
    //
    // Se busca con `identidad`, no con el tercero armado: esta consulta solo filtra por
    // identificación y sucursal, y exigir el resto era lo que impedía rescatar al cliente que ya
    // está completo en Siigo Nube.
    const encontrado = await buscarTercero(identidad.identification, identidad.branch_office, ambiente);

    let siigoCustomerId: string;
    let desenlace: DesenlaceTercero;

    if (encontrado) {
      siigoCustomerId = String(encontrado.id ?? '');
      desenlace = 'vinculado_existente';
      if (siigoCustomerId === '') {
        throw new SiigoTerceroError('siigo_rechazo',
          'Siigo devolvió un tercero sin identificador; no se puede vincular.');
      }
      // C7 — vincular NO exige que FLITO tenga la ficha completa: no se escribe nada en Siigo, solo
      // se guarda de qué tercero se trata. Y de paso se aprovecha lo que se acaba de leer para
      // tapar los huecos, así el `PUT` de la próxima vez no salga cojo.
      await hidratarYRearmar(encontrado);
    } else {
      // AC5 — crear es la ÚNICA rama en la que FLITO tiene que aportarlo todo, porque no existe
      // nada enfrente de dónde sacarlo. Un cliente no facturable no sale a la red.
      await exigirClienteFacturable(clienteId);

      const creado = await ejecutarConResiliencia(
        () => siigoRequestOrThrow<unknown>({
          metodo: 'POST',
          ruta: '/v1/customers',
          ambiente: ambiente as SiigoAmbiente,
          cuerpo: exigirArmado(),
          timeoutMs: TIMEOUT_TERCERO_MS,
        }),
        { clave: claveResiliencia(ambiente), claveCortacircuitos: claveCortacircuitosTerceros(ambiente) },
      );
      siigoCustomerId = String((creado as { id?: unknown } | null)?.id ?? '');
      desenlace = 'creado';
      if (siigoCustomerId === '') {
        throw new SiigoTerceroError('siigo_rechazo',
          'Siigo aceptó la creación pero no devolvió el identificador del tercero.');
      }
    }

    try {
      await db.insert(siigoTerceros).values({
        clientId: clienteId,
        siigoCustomerId,
        identificacion: identidad.identification,
        sucursal: identidad.branch_office,
        // Vinculando un tercero cuya ficha local sigue coja —Siigo tampoco tenía todo— el vínculo
        // se guarda igual, porque vincular es lo que desbloquea facturar: la factura solo manda
        // `identification` y `branch_office`, y los dos están.
        //
        // La huella queda con un centinela que NO puede coincidir con ningún sha256, de modo que la
        // próxima sincronización se salte el atajo de «nada cambió» y vuelva a intentar completar
        // la ficha. Guardar aquí una huella inventada dejaría el vínculo afirmando que está al día.
        huella: huella ?? SIN_HUELLA,
      });
    } catch (e) {
      // AC8 — otra petición ganó la carrera. No es un fallo: el tercero está vinculado, que es lo
      // que se quería. Se relee para devolver el vínculo que sí quedó.
      if (esViolacionDeUnico(e)) {
        // B5 — se relee por CLIENTE, que es la carrera que describe el AC8. Releer por la pareja
        // podía devolver la fila de OTRO cliente y devolver un vínculo que este cliente no tiene:
        // `vinculoDeCliente` seguiría diciendo `null` y nadie entendería por qué.
        const [propio] = await db.select().from(siigoTerceros)
          .where(eq(siigoTerceros.clientId, clienteId)).limit(1);
        if (propio) {
          await bitacora('ok', `Tercero del cliente ${clienteId} ya estaba vinculado (carrera resuelta).`);
          return {
            clienteId, siigoCustomerId: propio.siigoCustomerId,
            identificacion: propio.identificacion, sucursal: propio.sucursal,
            desenlace: 'vinculado_existente',
          };
        }
        // El choque no fue con nosotros mismos: otro cliente ya ocupa esa identificación o ese
        // tercero. Decirlo es lo único honesto — y si acabábamos de CREAR en Siigo, hay un tercero
        // allá sin vínculo aquí, que alguien tiene que resolver a mano. Se dice en el mensaje en vez
        // de dejarlo callado, porque callado nadie lo encuentra.
        const huerfano = desenlace === 'creado'
          ? ` Se creó el tercero ${siigoCustomerId} en Siigo y quedó SIN vincular: revísalo.`
          : '';
        await bitacora('error_negocio',
          `Otro cliente ya está vinculado a la identificación ${identidad.identification} (sucursal ${identidad.branch_office}).${huerfano}`);
        throw new SiigoTerceroError('siigo_rechazo',
          `Otro cliente de FLITO ya está vinculado a esa identificación y sucursal.${huerfano}`);
      }
      throw e;
    }

    await bitacora('ok', `Tercero del cliente ${clienteId} ${desenlace === 'creado' ? 'creado' : 'vinculado'} en Siigo.`);
    return {
      clienteId, siigoCustomerId,
      identificacion: identidad.identification, sucursal: identidad.branch_office,
      desenlace,
    };
  } catch (e) {
    // AC6 — traducido a lenguaje operativo, y el vínculo local NO queda a medio escribir: se escribe
    // después de que Siigo confirme, nunca antes.
    // C7 — el fallo del validador sube TAL CUAL, y esto no es un detalle de estilo.
    //
    // Desde que la guarda vive dentro del `try` —tiene que estar ahí: solo se exige en las ramas que
    // escriben—, este `catch` la alcanza. Y `motivoLegible` está escrito para fallos de la RED: le
    // da a cualquier excepción que no reconozca un «Siigo no respondió», que aquí sería mentira dos
    // veces —Siigo respondió, y el problema es de FLITO— y además borraría lo único que sirve para
    // arreglarlo: la lista de qué campo falta, que es el AC5 entero.
    if (e instanceof ClienteNoFacturableError) throw e;

    const motivo = motivoLegible(e);
    log.error({ err: detalleTecnico(e), clienteId }, 'no se pudo asegurar el tercero en Siigo');
    await bitacora(
      (e as { requiereCorreccionDeDatos?: boolean } | null)?.requiereCorreccionDeDatos === true
        ? 'error_negocio' : 'error_tecnico',
      `No se pudo asegurar el tercero del cliente ${clienteId}: ${motivo}`,
    );
    if (e instanceof SiigoTerceroError) throw e;
    throw new SiigoTerceroError('siigo_rechazo', motivo);
  }
}

/** El tercero tal como Siigo lo tiene hoy. `null` si ya no está: se tratará como creación. */
async function traerPorId(
  siigoCustomerId: string, ambiente: string,
  identificacionEsperada: string, sucursalEsperada: number,
): Promise<Record<string, unknown>> {
  let datos: unknown;
  try {
    datos = await ejecutarConResiliencia(
      () => siigoRequestOrThrow<unknown>({
        metodo: 'GET',
        ruta: `/v1/customers/${encodeURIComponent(siigoCustomerId)}`,
        ambiente: ambiente as SiigoAmbiente,
        timeoutMs: TIMEOUT_TERCERO_MS,
      }),
      { clave: claveResiliencia(ambiente), claveCortacircuitos: claveCortacircuitosTerceros(ambiente) },
    );
  } catch (e) {
    // No poder leerlo NO autoriza a sobrescribirlo a ciegas: se propaga. Actualizar sin saber qué
    // había es justo el borrado silencioso que `fusionarConExistente` existe para impedir.
    log.warn({ err: detalleTecnico(e), siigoCustomerId }, 'no se pudo leer el tercero antes de actualizarlo');
    throw e;
  }

  if (!esObjeto(datos)) {
    // Un 200 con cuerpo vacío o ilegible NO es «no existe»: es «no sé qué hay». La diferencia
    // decide entre conservar y destruir.
    throw new SiigoTerceroError('siigo_rechazo',
      'Siigo no devolvió el tercero al consultarlo; no se actualiza sin saber qué había.');
  }

  // B3 — se comprueba que sea EL tercero pedido, igual que hace `buscarTercero` con su respuesta.
  // Si Siigo devolviera otro, la fusión incorporaría el vendedor, el cobrador y los comentarios de
  // OTRO cliente al `PUT` sobre este: una mezcla de datos contables entre terceros, irreversible.
  const mismoId = String(datos.id ?? '') === siigoCustomerId;
  const mismaIdentificacion = normalizarIdentificacion(String(datos.identification ?? ''))
    === normalizarIdentificacion(identificacionEsperada);
  const mismaSucursal = Number(datos.branch_office ?? 0) === sucursalEsperada;
  if (!mismoId || !mismaIdentificacion || !mismaSucursal) {
    throw new SiigoTerceroError('siigo_rechazo',
      'El tercero que devolvió Siigo no coincide con el vinculado. No se actualiza nada.');
  }

  return datos;
}

/**
 * Cómo se compara una identificación.
 *
 * El catálogo admite tipos ALFANUMÉRICOS —pasaporte, cédula de extranjería, PEP, PPT—, así que
 * `ab123` y `AB123` son el mismo documento. Compararlos como distintos hace que no se encuentre el
 * tercero, se intente crear, Siigo responda «identificación duplicada» y el cliente quede bloqueado
 * para siempre. El repo ya compara así en `recalcularDuplicados`.
 */
export function normalizarIdentificacion(v: string): string {
  return v.trim().toUpperCase();
}

/**
 * Anonimiza la identificación de los vínculos de unos clientes (Ley 1581).
 *
 * La tabla guarda la cédula o el NIT en claro porque hace falta para reencontrar el tercero en
 * Siigo. El flujo de olvido anonimiza `clients.document` y NO borra la fila del cliente, así que el
 * `ON DELETE CASCADE` no alcanza aquí: sin esta función, la identificación del titular sobreviviría
 * a su propia supresión en una tabla que nadie recuerda.
 *
 * Se anonimiza con el MISMO valor que recibe `clients.document`, para que el vínculo siga siendo
 * rastreable como pareja y no quede una fila que apunta a un cliente que ya no se llama así.
 *
 * Recibe el ejecutor porque el olvido corre dentro de UNA transacción: si esto usara la conexión
 * suelta, quedaría un titular medio olvidado que nadie sabría terminar de olvidar.
 */
export async function anonimizarTercerosDeClientes(
  clienteIds: number[],
  identificacionAnonima: string,
  ejecutor: Pick<typeof db, 'update'> = db,
): Promise<number> {
  if (clienteIds.length === 0) return 0;
  const filas = await ejecutor.update(siigoTerceros)
    .set({ identificacion: identificacionAnonima, updatedAt: new Date() })
    .where(inArray(siigoTerceros.clientId, clienteIds))
    .returning({ id: siigoTerceros.id });
  return filas.length;
}

/** El vínculo de un cliente, si lo tiene. Lo consulta la elegibilidad (HU #11324) sin llamar a Siigo. */
export async function vinculoDeCliente(clienteId: number) {
  const [v] = await db.select().from(siigoTerceros)
    .where(eq(siigoTerceros.clientId, clienteId)).limit(1);
  return v ?? null;
}
