// Catálogo nacional de secretarías de tránsito municipales (código DIVIPOLA/DANE).
// Fuente única — consumida por API (scope multitenant) y web (wizard paso 5).

export interface OrganismoTransito {
  nombre: string;
  ciudad: string;
  codigo: string;
}

export const ORGANISMOS_TRANSITO: readonly OrganismoTransito[] = [
  { nombre: 'STRIA TTEyTTO ENVIGADO', ciudad: 'Envigado', codigo: '05266' },
  { nombre: 'STRIA TTEyTTO MEDELLIN', ciudad: 'Medellín', codigo: '05001' },
  { nombre: 'STRIA TTEyTTO BOGOTA D.C.', ciudad: 'Bogotá', codigo: '11001' },
  { nombre: 'STRIA TTEyTTO CALI', ciudad: 'Cali', codigo: '76001' },
  { nombre: 'STRIA TTEyTTO BARRANQUILLA', ciudad: 'Barranquilla', codigo: '08001' },
  { nombre: 'STRIA TTEyTTO BUCARAMANGA', ciudad: 'Bucaramanga', codigo: '68001' },
  { nombre: 'STRIA TTEyTTO CARTAGENA', ciudad: 'Cartagena', codigo: '13001' },
  { nombre: 'STRIA TTEyTTO CUCUTA', ciudad: 'Cúcuta', codigo: '54001' },
  { nombre: 'STRIA TTEyTTO PEREIRA', ciudad: 'Pereira', codigo: '66001' },
  { nombre: 'STRIA TTEyTTO MANIZALES', ciudad: 'Manizales', codigo: '17001' },
  { nombre: 'STRIA TTEyTTO IBAGUE', ciudad: 'Ibagué', codigo: '73001' },
  { nombre: 'STRIA TTEyTTO VILLAVICENCIO', ciudad: 'Villavicencio', codigo: '50001' },
  { nombre: 'STRIA TTEyTTO PASTO', ciudad: 'Pasto', codigo: '52001' },
  { nombre: 'STRIA TTEyTTO SANTA MARTA', ciudad: 'Santa Marta', codigo: '47001' },
  { nombre: 'STRIA TTEyTTO MONTERIA', ciudad: 'Montería', codigo: '23001' },
  { nombre: 'STRIA TTEyTTO NEIVA', ciudad: 'Neiva', codigo: '41001' },
  { nombre: 'STRIA TTEyTTO ARMENIA', ciudad: 'Armenia', codigo: '63001' },
  { nombre: 'STRIA TTEyTTO POPAYAN', ciudad: 'Popayán', codigo: '19001' },
  { nombre: 'STRIA TTEyTTO VALLEDUPAR', ciudad: 'Valledupar', codigo: '20001' },
  { nombre: 'STRIA TTEyTTO SINCELEJO', ciudad: 'Sincelejo', codigo: '70001' },
  { nombre: 'STRIA TTEyTTO TUNJA', ciudad: 'Tunja', codigo: '15001' },
  { nombre: 'STRIA TTEyTTO FLORENCIA', ciudad: 'Florencia', codigo: '18001' },
  { nombre: 'STRIA TTEyTTO RIONEGRO', ciudad: 'Rionegro', codigo: '05615' },
  { nombre: 'STRIA TTEyTTO ITAGUI', ciudad: 'Itagüí', codigo: '05360' },
  { nombre: 'STRIA TTEyTTO BELLO', ciudad: 'Bello', codigo: '05088' },
  { nombre: 'STRIA TTEyTTO SABANETA', ciudad: 'Sabaneta', codigo: '05631' },
  { nombre: 'STRIA TTEyTTO SOACHA', ciudad: 'Soacha', codigo: '25754' },
  { nombre: 'STRIA TTEyTTO PALMIRA', ciudad: 'Palmira', codigo: '76520' },
  { nombre: 'STRIA TTEyTTO BUENAVENTURA', ciudad: 'Buenaventura', codigo: '76109' },
  { nombre: 'STRIA TTEyTTO DOSQUEBRADAS', ciudad: 'Dosquebradas', codigo: '66170' },
  { nombre: 'STRIA TTEyTTO BARRANCABERMEJA', ciudad: 'Barrancabermeja', codigo: '68081' },
  { nombre: 'STRIA TTEyTTO FLORIDABLANCA', ciudad: 'Floridablanca', codigo: '68276' },
  { nombre: 'STRIA TTEyTTO SOLEDAD', ciudad: 'Soledad', codigo: '08758' },
  { nombre: 'STRIA TTEyTTO YOPAL', ciudad: 'Yopal', codigo: '85001' },
  { nombre: 'STRIA TTEyTTO GIRARDOT', ciudad: 'Girardot', codigo: '25307' },
  { nombre: 'STRIA TTEyTTO SOGAMOSO', ciudad: 'Sogamoso', codigo: '15759' },
  { nombre: 'STRIA TTEyTTO DUITAMA', ciudad: 'Duitama', codigo: '15238' },
  { nombre: 'STRIA TTEyTTO ZIPAQUIRA', ciudad: 'Zipaquirá', codigo: '25899' },
  { nombre: 'STRIA TTEyTTO FUSAGASUGA', ciudad: 'Fusagasugá', codigo: '25290' },
  { nombre: 'STRIA TTEyTTO CHIA', ciudad: 'Chía', codigo: '25175' },
  { nombre: 'STRIA TTEyTTO TULUA', ciudad: 'Tuluá', codigo: '76834' },
  { nombre: 'STRIA TTEyTTO CARTAGO', ciudad: 'Cartago', codigo: '76147' },
  { nombre: 'STRIA TTEyTTO APARTADO', ciudad: 'Apartadó', codigo: '05045' },
  { nombre: 'STRIA TTEyTTO TURBO', ciudad: 'Turbo', codigo: '05837' },
  { nombre: 'STRIA TTEyTTO CALDAS', ciudad: 'Caldas', codigo: '05129' },
  { nombre: 'STRIA TTEyTTO LA ESTRELLA', ciudad: 'La Estrella', codigo: '05380' },
  { nombre: 'STRIA TTEyTTO COPACABANA', ciudad: 'Copacabana', codigo: '05212' },
  { nombre: 'STRIA TTEyTTO MARINILLA', ciudad: 'Marinilla', codigo: '05440' },
  { nombre: 'STRIA TTEyTTO LA CEJA', ciudad: 'La Ceja', codigo: '05376' },
  { nombre: 'STRIA TTEyTTO CAJICA', ciudad: 'Cajicá', codigo: '25126' },
  { nombre: 'STRIA TTOyTTE MCPAL FUNZA', ciudad: 'Funza', codigo: '25286' },
  { nombre: 'STRIA TTEyTTO MOSQUERA', ciudad: 'Mosquera', codigo: '25473' },
  { nombre: 'STRIA TTEyTTO MADRID', ciudad: 'Madrid', codigo: '25430' },
  { nombre: 'STRIA TTOyTTE MCPAL LA CALERA', ciudad: 'La Calera', codigo: '25377' },
  { nombre: 'STRIA TTEyTTO FACATATIVA', ciudad: 'Facatativá', codigo: '25269' },
  { nombre: 'STRIA TTEyTTO GIRARDOTA', ciudad: 'Girardota', codigo: '05308' },
  { nombre: 'STRIA TTEyTTO BARBOSA', ciudad: 'Barbosa', codigo: '05079' },
  { nombre: 'STRIA TTEyTTO GUARNE', ciudad: 'Guarne', codigo: '05318' },
  { nombre: 'STRIA TTEyTTO EL RETIRO', ciudad: 'El Retiro', codigo: '05607' },
  { nombre: 'STRIA TTEyTTO EL CARMEN DE VIBORAL', ciudad: 'El Carmen de Viboral', codigo: '05148' },
  { nombre: 'STRIA TTEyTTO LA UNION', ciudad: 'La Unión', codigo: '05400' },
  { nombre: 'STRIA TTEyTTO SONSON', ciudad: 'Sonsón', codigo: '05756' },
  { nombre: 'STRIA TTEyTTO CAUCASIA', ciudad: 'Caucasia', codigo: '05154' },
  { nombre: 'STRIA TTEyTTO YARUMAL', ciudad: 'Yarumal', codigo: '05887' },
  { nombre: 'STRIA TTEyTTO SANTA ROSA DE OSOS', ciudad: 'Santa Rosa de Osos', codigo: '05686' },
  { nombre: 'STRIA TTEyTTO DON MATIAS', ciudad: 'Don Matías', codigo: '05237' },
  { nombre: 'STRIA TTEyTTO BUGA', ciudad: 'Buga', codigo: '76111' },
  { nombre: 'STRIA TTEyTTO JAMUNDI', ciudad: 'Jamundí', codigo: '76364' },
  { nombre: 'STRIA TTEyTTO YUMBO', ciudad: 'Yumbo', codigo: '76892' },
  { nombre: 'STRIA TTEyTTO CANDELARIA', ciudad: 'Candelaria', codigo: '76130' },
  { nombre: 'STRIA TTEyTTO FLORIDA', ciudad: 'Florida', codigo: '76275' },
  { nombre: 'STRIA TTEyTTO SANTANDER DE QUILICHAO', ciudad: 'Santander de Quilichao', codigo: '19698' },
  { nombre: 'STRIA TTEyTTO PUERTO TEJADA', ciudad: 'Puerto Tejada', codigo: '19573' },
  { nombre: 'STRIA TTEyTTO PIEDECUESTA', ciudad: 'Piedecuesta', codigo: '68547' },
  { nombre: 'STRIA TTEyTTO GIRON', ciudad: 'Girón', codigo: '68307' },
  { nombre: 'STRIA TTEyTTO SAN GIL', ciudad: 'San Gil', codigo: '68679' },
  { nombre: 'STRIA TTEyTTO SOCORRO', ciudad: 'Socorro', codigo: '68755' },
  { nombre: 'STRIA TTEyTTO MAICAO', ciudad: 'Maicao', codigo: '44430' },
  { nombre: 'STRIA TTEyTTO RIOHACHA', ciudad: 'Riohacha', codigo: '44001' },
  { nombre: 'STRIA TTEyTTO QUIBDO', ciudad: 'Quibdó', codigo: '27001' },
  { nombre: 'STRIA TTEyTTO ARAUCA', ciudad: 'Arauca', codigo: '81001' },
  { nombre: 'STRIA TTEyTTO MOCOA', ciudad: 'Mocoa', codigo: '86001' },
  { nombre: 'STRIA TTEyTTO LETICIA', ciudad: 'Leticia', codigo: '91001' },
  { nombre: 'STRIA TTEyTTO MITU', ciudad: 'Mitú', codigo: '97001' },
  { nombre: 'STRIA TTEyTTO INIRIDA', ciudad: 'Inírida', codigo: '94001' },
  { nombre: 'STRIA TTEyTTO PUERTO CARRENO', ciudad: 'Puerto Carreño', codigo: '99001' },
  { nombre: 'STRIA TTEyTTO SAN JOSE DEL GUAVIARE', ciudad: 'San José del Guaviare', codigo: '95001' },
  { nombre: 'STRIA TTEyTTO AGUACHICA', ciudad: 'Aguachica', codigo: '20011' },
  { nombre: 'STRIA TTEyTTO OCANA', ciudad: 'Ocaña', codigo: '54498' },
  { nombre: 'STRIA TTEyTTO PAMPLONA', ciudad: 'Pamplona', codigo: '54518' },
  { nombre: 'STRIA TTEyTTO MAGANGUE', ciudad: 'Magangué', codigo: '13430' },
  { nombre: 'STRIA TTEyTTO LORICA', ciudad: 'Lorica', codigo: '23417' },
  { nombre: 'STRIA TTEyTTO CERETE', ciudad: 'Cereté', codigo: '23162' },
  { nombre: 'STRIA TTEyTTO SAHAGUN', ciudad: 'Sahagún', codigo: '23660' },
  { nombre: 'STRIA TTEyTTO ESPINAL', ciudad: 'Espinal', codigo: '73268' },
  { nombre: 'STRIA TTEyTTO HONDA', ciudad: 'Honda', codigo: '73349' },
  { nombre: 'STRIA TTEyTTO MARIQUITA', ciudad: 'Mariquita', codigo: '73443' },
  { nombre: 'STRIA TTEyTTO GARZON', ciudad: 'Garzón', codigo: '41298' },
  { nombre: 'STRIA TTEyTTO PITALITO', ciudad: 'Pitalito', codigo: '41551' },
  { nombre: 'STRIA TTEyTTO LA PLATA', ciudad: 'La Plata', codigo: '41396' },
  { nombre: 'STRIA TTEyTTO IPIALES', ciudad: 'Ipiales', codigo: '52356' },
  { nombre: 'STRIA TTEyTTO TUMACO', ciudad: 'Tumaco', codigo: '52835' },
  { nombre: 'STRIA TTEyTTO TUQUERRES', ciudad: 'Túquerres', codigo: '52838' },
  { nombre: 'STRIA TTEyTTO CHIQUINQUIRA', ciudad: 'Chiquinquirá', codigo: '15176' },
  { nombre: 'STRIA TTEyTTO PAIPA', ciudad: 'Paipa', codigo: '15516' },
  { nombre: 'STRIA TTEyTTO CHINCHINA', ciudad: 'Chinchiná', codigo: '17174' },
  { nombre: 'STRIA TTEyTTO LA DORADA', ciudad: 'La Dorada', codigo: '17380' },
  { nombre: 'STRIA TTEyTTO VILLANUEVA', ciudad: 'Villanueva', codigo: '44874' },
  { nombre: 'STRIA TTEyTTO COROZAL', ciudad: 'Corozal', codigo: '70215' },
  { nombre: 'STRIA TTEyTTO ACACIAS', ciudad: 'Acacías', codigo: '50006' },
  { nombre: 'STRIA TTEyTTO GRANADA', ciudad: 'Granada', codigo: '50313' },
  { nombre: 'STRIA TTEyTTO PUERTO LOPEZ', ciudad: 'Puerto López', codigo: '50573' },
  { nombre: 'STRIA TTEyTTO AGUAZUL', ciudad: 'Aguazul', codigo: '85010' },
  { nombre: 'STRIA TTEyTTO PAZ DE ARIPORO', ciudad: 'Paz de Ariporo', codigo: '85250' },
  { nombre: 'STRIA TTEyTTO TAME', ciudad: 'Tame', codigo: '81794' },
  { nombre: 'STRIA TTEyTTO CIENAGA', ciudad: 'Ciénaga', codigo: '47189' },
  { nombre: 'STRIA TTEyTTO FUNDACION', ciudad: 'Fundación', codigo: '47288' },
  { nombre: 'STRIA TTEyTTO TURBACO', ciudad: 'Turbaco', codigo: '13836' },
  { nombre: 'STRIA TTEyTTO MALAMBO', ciudad: 'Malambo', codigo: '08433' },
] as const;

const CODIGO_INDEX = new Map(ORGANISMOS_TRANSITO.map((o) => [o.codigo, o]));

export function isKnownOrganismoCodigo(codigo: string | null | undefined): codigo is string {
  if (!codigo) return false;
  return CODIGO_INDEX.has(codigo.trim());
}

export function getOrganismoByCodigo(codigo: string): OrganismoTransito | undefined {
  return CODIGO_INDEX.get(codigo.trim());
}

/** Extrae código DANE desde vehiculo._orgTransito (patrón wizard paso 5). */
export function extractOrganismoCodigoFromVehiculo(vehiculo: unknown): string | null {
  if (!vehiculo || typeof vehiculo !== 'object') return null;
  const org = (vehiculo as { _orgTransito?: { codigo?: string } })._orgTransito;
  const raw = org?.codigo?.trim();
  return raw && isKnownOrganismoCodigo(raw) ? raw : null;
}

// ── Emparejamiento con el reporte de FLIT ────────────────────────────────────
// FLIT no envía el código DIVIPOLA: trae `Ciudad` (municipio, MAYÚSCULAS sin tildes) y `Transito`
// (nombre de la secretaría, cuya redacción VARÍA: p.ej. "STRIA DE TTOyTTE MEDELLIN" vs el catálogo
// "STRIA TTEyTTO MEDELLIN"). Por eso el emparejamiento es por CIUDAD primero (estable, 0 ambiguo en
// el catálogo) y por NOMBRE como respaldo. Devuelve el código DANE del catálogo, o null si no cruza.
const norm = (s: string): string => s.normalize('NFD').toUpperCase().replace(/[^A-Z0-9]/g, '');
const CIUDAD_INDEX = new Map(ORGANISMOS_TRANSITO.map((o) => [norm(o.ciudad), o.codigo]));
const NOMBRE_INDEX = new Map(ORGANISMOS_TRANSITO.map((o) => [norm(o.nombre), o.codigo]));

export function resolverCodigoOrganismoFlit(params: { ciudad?: string | null; nombre?: string | null }): string | null {
  const ciudad = params.ciudad ? norm(params.ciudad) : '';
  if (ciudad && CIUDAD_INDEX.has(ciudad)) return CIUDAD_INDEX.get(ciudad)!;
  const nombre = params.nombre ? norm(params.nombre) : '';
  if (nombre && NOMBRE_INDEX.has(nombre)) return NOMBRE_INDEX.get(nombre)!;
  return null;
}

// ── Emparejamiento TOLERANTE, para quien SOLO tiene el nombre del RUNT ───────────────────────────
//
// **DOS niveles, y por qué exactamente dos (Bug #12179).**
//
// `resolverCodigoOrganismoFlit` es para el reporte de FLIT, que trae `Ciudad` en una COLUMNA APARTE:
// ahí la ciudad es un dato limpio y la igualdad exacta es la comprobación correcta — relajarla haría
// más laxo un emparejamiento que hoy no falla, y por eso esa función se conserva intacta.
//
// El RUNT no manda ciudad. Manda UNA cadena, `data.vehiculo.organismoTransito`, con la redacción de
// la secretaría, y esa redacción VARÍA respecto de la del catálogo («STRIA DE TTOyTTE MEDELLIN» vs
// «STRIA TTEyTTO MEDELLIN»). Contra `NOMBRE_INDEX` la igualdad exacta falla siempre que el RUNT no
// use LITERALMENTE la redacción propia de FLIT, y el resultado es un `null` que la ficha del wizard
// pinta como «—» aunque el registro SÍ haya mandado el organismo. Eso es el Bug #12179.
//
//   1. **Igualdad exacta normalizada** (delegada, sin cambios). Lo más específico primero. Cubre
//      además CUALQUIER variación de espaciado o puntuación del nombre de catálogo, porque `norm`
//      borra todos los separadores: «STRIATTEYTTOMEDELLIN» es igualdad exacta, no una tolerancia.
//   2. **Contención de la CIUDAD, por PALABRA COMPLETA.** Es el nivel estable: la ciudad no la
//      redacta nadie.
//
// ── Por qué el nivel 2 casa por palabra completa, y no es un detalle de estilo ───────────────────
//
// `norm` quita los espacios, así que sobre la forma pegada `includes` compara subcadenas y cualquier
// municipio que EMPIECE por el nombre de uno del catálogo se lo lleva. Medido sobre municipios
// reales que NO están en los 119:
//
//   · CALIMA EL DARIEN → Cali · CALIFORNIA → Cali · TAMESIS → Tame · BUGALAGRANDE → Buga
//
// Eso no es un «—»: es un `flito_soat.organismo_codigo` EQUIVOCADO, con FK a una fila real, y esa
// columna es el ámbito de bandeja («organismo destino al enviar a tránsito», `schema.ts:390-391`).
// Un SOAT de Támesis acabaría en la bandeja de Tame, Arauca. Un `null` honesto que Operaciones
// completa a mano es estrictamente mejor: este Bug viene a dejar de PERDER organismos, no a empezar
// a inventarlos. La cota de longitud no cubre esto —el problema no es lo corta que sea la clave, es
// que no hay frontera—, así que el nivel 2 compara sobre {@link normPal}: la misma normalización
// pero colapsando los separadores a UN espacio y con espacio al principio y al final, de modo que
// « CALI » no está dentro de « CALIMA EL DARIEN » y « LA CALERA », que son dos palabras, sí casa.
//
// ── Por qué NO hay un tercer nivel, y qué haría falta para añadirlo ─────────────────────────────
//
// Lo hubo: contención del sufijo de 12 caracteres del NOMBRE de catálogo sobre la forma pegada, que
// es lo que hace el picker del traspaso. Se **retiró** en este mismo Bug, y la razón está medida:
//
//   · 119 organismos × 7 plantillas de redacción realistas (literal, todo pegado, «STRIA DE
//     TTOyTTE …», «SECRETARIA DE TRANSITO Y TRANSPORTE DE …», «ORGANISMO DE TRANSITO DE …»,
//     «<nombre> - <ciudad>», espacios comidos) = **833 entradas, CERO alcanzaban el nivel 3**: el
//     nivel 1 se queda con las pegadas y el nivel 2 con todo lo demás.
//   · Su única clase restante —texto extra por delante Y la ciudad pegada por la izquierda,
//     «ORGANISMO STRIA TTEyTTOMEDELLIN»— no tiene UNA sola evidencia en el payload del RUNT.
//   · Y para que dejara de inventar organismos hubo que anclarlo al final: con `includes` resucitaba
//     los cuatro de arriba en cuanto la cadena traía la redacción literal de FLIT delante
//     (`norm('STRIA TTEyTTO TAMESIS')` contiene `'ATTEYTTOTAME'`), que es el patrón MÁS probable.
//
// Un nivel que no acierta nada comprobable pero sí puede fallar es coste neto, y además es código
// que este Bug AÑADÍA. **La vía de vuelta está abierta y es barata**: la línea de log del desenlace
// `ok` publica `organismoRunt: <nombre crudo>` y `organismoCatalogado: false`, así que una redacción
// que hoy no cruce se ve en DEV con el caso real delante. Se añade entonces, con el dato, y no ahora
// a ciegas. Ese instrumento es justo lo que faltaba para que este Bug fuera diagnosticable.
//
// ── Ambigüedad: lo medido, lo resuelto y lo que se paga ─────────────────────────────────────────
//
// El recorrido va de MÁS LARGO A MÁS CORTO. Los dos únicos pares que se contienen entre sí en el
// catálogo son Florida (76275) ⊂ Floridablanca (68276) y Girardot (25307) ⊂ Girardota (05308), y
// los separa la FRONTERA DE PALABRA, no el orden: « FLORIDA » no está dentro de « FLORIDABLANCA »,
// que es una sola palabra. (Comprobado con el mutante del orden ascendente: esos asertos siguen
// verdes.) El orden por longitud se conserva porque es la defensa que queda si mañana entra un
// municipio compuesto que contenga a otro como secuencia de palabras («LA UNION» dentro de «LA UNION
// DEL SUR»).
//
// ── «<municipio> - <departamento>»: la familia que el gate B encontró ───────────────────────────
//
// Una versión anterior de este comentario afirmaba que la única ambigüedad era «… TAME ARAUCA» y que
// «en el catálogo actual eso ocurre en UN caso». **Era falso, y el error de método importa más que
// el caso**: se midieron los pares INTERNOS del catálogo —ciudad contra ciudad de los 119— y se
// concluyó sobre el mundo. La familia real es otra y es grande: cadenas «<municipio> -
// <departamento>» donde el MUNICIPIO está fuera del catálogo y el DEPARTAMENTO se llama como una
// ciudad que sí está. Con 19 municipios de Caldas y 5 de Arauca × 2 plantillas de redacción son 48
// atribuciones equivocadas medidas, todas a un organismo de otro departamento:
//
//     'STRIA DE TRANSITO MUNICIPAL DE SUPIA - CALDAS'  →  05129, que es Caldas ANTIOQUIA
//     'STRIA DE TTOyTTE ARAUQUITA ARAUCA'              →  81001, que es Arauca capital
//
// Y no es una plantilla inventada: «<municipio> - <departamento>» es el fixture del propio spec
// («… SOACHA - CUNDINAMARCA»). Otra vez, medir dentro del conjunto conocido y concluir sobre el
// mundo — la misma trampa que los fixtures copiados del catálogo, que fueron lo que ocultó el Bug.
//
// **La regla:** una ciudad del catálogo que se llama como un DEPARTAMENTO no puede ganar por
// contención (ver {@link DEPARTAMENTOS_COLOMBIA}). Se salta en el recorrido, con dos consecuencias:
//
//   · Si hay otra coincidencia, gana esa. «… TAME ARAUCA» → **Tame (81794)**, que además es lo
//     CORRECTO: Tame es el municipio y Arauca el departamento. Deja de ser una ambigüedad aceptada
//     y pasa a estar bien resuelto.
//   · Si la única coincidencia era el departamento, `null`. No hay forma de distinguir «Caldas el
//     municipio» de «Caldas el departamento», y ante la duda el `null` honesto —un «—» que
//     Operaciones completa a mano— es estrictamente mejor que un código ajeno y silencioso en una
//     columna que es ámbito de bandeja.
//
// **El precio, escrito:** una redacción VARIADA del organismo propio de Caldas o de Arauca
// («STRIA DE TTOyTTE CALDAS») pasa a devolver `null` en vez de su código. Son dos organismos de 119
// y el fallo es el honesto; la alternativa era aceptar 48 atribuciones equivocadas. La redacción
// LITERAL de esos dos —«STRIA TTEyTTO CALDAS», «STRIA TTEyTTO ARAUCA»— sigue resolviendo por el
// nivel 1, que no toca esta regla, y es como llegan cuando de verdad son ellos.
//
// La lista de departamentos va ENTERA y no solo las dos que hoy chocan, para que la regla siga
// siendo correcta si mañana entra al catálogo un Córdoba, un Santander, un Sucre o un Bolívar
// —municipios reales homónimos de departamento—. Hoy la intersección medida es de dos: Caldas
// (05129) y Arauca (81001).
//
// ── Relación con el picker del traspaso, dicha con precisión ────────────────────────────────────
//
// Esto **no es «la lógica del picker promovida»**, y desde que se retiró el nivel 3 lo es menos:
// `resolveOrgFromRuntName` (`apps/web/src/pages/tramite/TraspasoOrganismoPicker.tsx`) tiene DOS
// niveles —sufijo del nombre y ciudad— y aquí queda solo el de ciudad, además ACOTADO a palabra
// completa, que es una condición que el picker no impone. De él viene la idea de emparejar por
// ciudad sobre el mismo campo del mismo payload; el resto diverge a propósito y con la medición de
// arriba detrás.
//
// Por eso tampoco se sustituye la copia del traspaso por esta función: el picker normaliza
// CONSERVANDO espacios y puntuación (solo quita tildes), devuelve el `OrgTransito` entero para el
// FUR y conserva su nivel de sufijo. Cambiarlo por esta sería alterar el comportamiento de un flujo
// que hoy funciona en producción; este Bug no es el sitio, y la unificación pendiente es del lado
// web.
/**
 * Como `norm`, pero conservando la FRONTERA entre palabras: separadores colapsados a un espacio y la
 * cadena rodeada de espacios, para que `includes(' CALI ')` no case dentro de « CALIMA EL DARIEN ».
 *
 * Las tildes se quitan ANTES de colapsar (`\u0300-\u036f`, como el picker del traspaso) y no se
 * dejan caer en el reemplazo general: si una marca de combinación llegara al `[^A-Z0-9]+`,
 * «MEDELLÍN» se partiría en dos palabras («MEDELLI N») y el nivel 2 dejaría de casar justo el caso
 * que abre este Bug.
 */
const normPal = (s: string): string =>
  ` ${s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()} `;

/**
 * Los 32 departamentos, para poder distinguir «Caldas el municipio» de «Caldas el departamento».
 *
 * Va la lista ENTERA y no solo las dos que hoy chocan con el catálogo, porque la regla tiene que
 * seguir siendo correcta el día que se añada un organismo de Córdoba (Quindío), Santander
 * (Cauca), Sucre (Santander) o Bolívar (Cauca) — municipios reales que se llaman como un
 * departamento y que hoy no están en los 119. Con la lista corta, ese día el error volvería
 * silencioso.
 *
 * **Hoy la intersección con el catálogo es de DOS**: Caldas (05129, que es el de Antioquia) y
 * Arauca (81001). Medido cruzando `norm` de cada ciudad del catálogo contra esta lista, no a ojo.
 */
export const DEPARTAMENTOS_COLOMBIA: readonly string[] = [
  'Amazonas', 'Antioquia', 'Arauca', 'Atlántico', 'Bolívar', 'Boyacá', 'Caldas', 'Caquetá',
  'Casanare', 'Cauca', 'Cesar', 'Chocó', 'Córdoba', 'Cundinamarca', 'Guainía', 'Guaviare',
  'Huila', 'La Guajira', 'Magdalena', 'Meta', 'Nariño', 'Norte de Santander', 'Putumayo',
  'Quindío', 'Risaralda', 'San Andrés y Providencia', 'Santander', 'Sucre', 'Tolima',
  'Valle del Cauca', 'Vaupés', 'Vichada',
] as const;

const DEPARTAMENTOS_NORM = new Set(DEPARTAMENTOS_COLOMBIA.map((d) => norm(d)));

/**
 * ¿Este nombre es el de un departamento? Con la MISMA normalización que las ciudades del catálogo.
 *
 * Se exporta para que la garantía sea comprobable, y esa es toda su razón de ser. Con el catálogo de
 * HOY, construir el índice con `toUpperCase()` en vez de `norm()` es un mutante **equivalente**:
 * ninguna de las 119 ciudades cambia de veredicto, porque las dos que intersecan —Caldas y Arauca—
 * son de una sola palabra y sin tilde. Pero dejaría INERTES 14 de las 32 entradas (Atlántico,
 * Bolívar, Boyacá, Caquetá, Chocó, Córdoba, Guainía, La Guajira, Nariño, Norte de Santander,
 * Quindío, San Andrés y Providencia, Valle del Cauca, Vaupés), y la lista de 32 existe justamente
 * para el futuro: el día que entre al catálogo una ciudad Córdoba o Quindío, el error volvería en
 * silencio. Afirmando sobre esta función —la misma que alimenta el índice, no una copia— el mutante
 * deja de ser equivalente.
 */
export function esNombreDeDepartamento(nombre: string): boolean {
  return DEPARTAMENTOS_NORM.has(norm(nombre));
}

const CIUDADES_POR_LONGITUD = [...ORGANISMOS_TRANSITO]
  .map((o) => ({ codigo: o.codigo, clave: normPal(o.ciudad), esDepartamento: esNombreDeDepartamento(o.ciudad) }))
  .sort((a, b) => b.clave.length - a.clave.length);

/**
 * El código DIVIPOLA a partir del nombre de organismo **tal como lo redacta el RUNT**, o `null`.
 *
 * Dos niveles: igualdad exacta normalizada → contención de la CIUDAD por palabra completa, con las
 * ciudades homónimas de un departamento excluidas de la contención. Ver el bloque de arriba para el
 * porqué de cada uno, por qué NO hay un tercero, y qué se gana y qué se paga con la regla de
 * departamentos.
 *
 * NO se usa para el reporte de FLIT: ese trae la ciudad en su propia columna y se empareja con
 * {@link resolverCodigoOrganismoFlit}, que sigue siendo exacto a propósito.
 */
export function resolverCodigoOrganismoRunt(nombreRunt: string | null | undefined): string | null {
  const exacto = resolverCodigoOrganismoFlit({ nombre: nombreRunt ?? null });
  if (exacto) return exacto;

  const crudo = nombreRunt ?? '';
  // Sin una sola letra o dígito no hay nada que emparejar.
  if (norm(crudo).length === 0) return null;

  // Nivel 2, por PALABRA COMPLETA: claves y objetivo van rodeados de espacios, así que « CALI » no
  // casa dentro de « CALIMA EL DARIEN » y « LA CALERA » sí casa entera. La cota son los 3 caracteres
  // del picker más los dos espacios: una clave de una o dos letras sería ruido.
  const objetivo = normPal(crudo);
  for (const c of CIUDADES_POR_LONGITUD) {
    // Una ciudad que se llama como un DEPARTAMENTO no puede ganar por contención: en
    // «… SUPIA - CALDAS» lo que casa es el departamento, no el municipio. Se salta, así que si hay
    // otra coincidencia gana esa («… TAME ARAUCA» → Tame) y si era la única el resultado es `null`.
    if (c.esDepartamento) continue;
    if (c.clave.length >= 5 && objetivo.includes(c.clave)) return c.codigo;
  }
  return null;
}
