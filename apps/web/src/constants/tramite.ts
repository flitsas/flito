export const STEPS = ['Consulta VIN', 'Documentos', 'Comprador', 'Identidad', 'Generar FUR'];

/** Anexos del checklist `traspaso_standard` — paso 6 wizard traspaso. */
export const TRASPASO_DOC_TYPES = [
  { key: 'soat', label: 'SOAT vigente', required: false },
  { key: 'paz_salvo', label: 'Paz y salvo impuesto vehicular', required: false },
  { key: 'impronta', label: 'Impronta motor/chasis', required: false },
  { key: 'compraventa', label: 'Contrato firmado', required: false },
  { key: 'otro', label: 'Cédulas / otros anexos', required: false },
] as const;

export const DOC_TYPES = [
  { key: 'factura', label: 'Factura de venta', required: true },
  { key: 'aduana', label: 'Manifiesto / Aduana', required: true },
  { key: 'impronta', label: 'Impronta', required: true },
  { key: 'soat', label: 'SOAT', required: false },
  { key: 'certificado_ambiental', label: 'Certificado ambiental', required: false },
  // TRAM-TIPO-02: documentos aduaneros (importación) y judiciales (remate).
  { key: 'declaracion_aduana', label: 'Declaración de importación (DIAN)', required: false },
  { key: 'acta_remate', label: 'Acta de remate', required: false },
  { key: 'oficio_judicial', label: 'Oficio judicial', required: false },
  { key: 'otro', label: 'Otro documento', required: false },
];

export const CIUDADES_CO = ["Bogota","Medellin","Cali","Barranquilla","Cartagena","Bucaramanga","Cucuta","Pereira","Manizales","Santa Marta","Ibague","Villavicencio","Pasto","Monteria","Neiva","Armenia","Valledupar","Popayan","Sincelejo","Tunja","Florencia","Riohacha","Quibdo","Yopal","Mocoa","Leticia","Arauca","San Jose Del Guaviare","Mitu","Puerto Carreno","Inirida","Envigado","Bello","Itagui","Soacha","Soledad","Floridablanca","Palmira","Buenaventura","Barrancabermeja","Dosquebradas","Tulua","Sogamoso","Girardot","Maicao","Magangue","Turbo","Apartado","Cartago","Duitama","Fusagasuga","Girardota","Zipaquira","Facatativa","Chia","Rionegro","Sabaneta","La Estrella","Copacabana","Caldas","Cajica","Marinilla","El Carmen De Viboral","La Ceja","Guatape","El Retiro","El Penol","La Union","Sonson","Barbosa","Buga","Tuluá","Jamundi","Yumbo","Candelaria","Florida","Pradera","El Cerrito","Dagua","Vijes","La Cumbre","Restrepo","Caloto","Santander De Quilichao","Puerto Tejada","Miranda","Corinto","Guachene","Piendamo","Silvia","Toribio","Suarez","Buenos Aires","Cajibio","Timbio","El Tambo","Argelia","Balboa","Patia","Mercaderes","Bolivar","San Sebastian","La Vega","Almaguer","Rosas","Sotara","Purace","Coconuco","Totoro"];

export { ORGANISMOS_TRANSITO } from '@operaciones/shared-types';

// FLIT-CLEANUP-08 PR2: el antiguo `ESTADO_TONE` (clases semánticas Aura
// soft/ring) era código muerto — ningún módulo lo importaba. El mapeo vivo de
// estado→tono lo provee `ESTADO_CHIP` (StatusChip tones FLIT) en TramiteDigital.tsx.
// Se elimina para cerrar la deuda visual residual sin sustituto innecesario.
