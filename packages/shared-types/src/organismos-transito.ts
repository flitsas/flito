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
