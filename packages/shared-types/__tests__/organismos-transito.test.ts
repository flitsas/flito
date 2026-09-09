import { describe, it, expect } from 'vitest';
import {
  DEPARTAMENTOS_COLOMBIA,
  esNombreDeDepartamento,
  ORGANISMOS_TRANSITO,
  resolverCodigoOrganismoFlit,
  resolverCodigoOrganismoRunt,
} from '../src/organismos-transito';

// Emparejamiento del reporte de FLIT (sin código DIVIPOLA) con el catálogo nacional.
describe('resolverCodigoOrganismoFlit', () => {
  it('empareja por CIUDAD normalizando mayúsculas/tildes (FLIT trae la ciudad en mayúsculas)', () => {
    expect(resolverCodigoOrganismoFlit({ ciudad: 'FUNZA', nombre: null })).toBe('25286');
    expect(resolverCodigoOrganismoFlit({ ciudad: 'ENVIGADO', nombre: null })).toBe('05266');
  });

  it('la ciudad gana aunque el nombre de FLIT no cuadre con el del catálogo (caso Medellín)', () => {
    // FLIT: "STRIA DE TTOyTTE MEDELLIN"; catálogo: "STRIA TTEyTTO MEDELLIN" (no cruzan por nombre).
    expect(resolverCodigoOrganismoFlit({ ciudad: 'MEDELLIN', nombre: 'STRIA DE TTOyTTE MEDELLIN' })).toBe('05001');
  });

  it('respaldo por NOMBRE cuando la ciudad no está en el catálogo', () => {
    expect(resolverCodigoOrganismoFlit({ ciudad: 'CIUDAD INEXISTENTE', nombre: 'STRIA TTOyTTE MCPAL FUNZA' })).toBe('25286');
  });

  it('devuelve null si no cruza por ciudad ni por nombre', () => {
    expect(resolverCodigoOrganismoFlit({ ciudad: 'MUNICIPIO INEXISTENTE', nombre: 'STRIA DESCONOCIDA' })).toBeNull();
    expect(resolverCodigoOrganismoFlit({ ciudad: null, nombre: null })).toBeNull();
  });

  /**
   * **La cota del Bug #12179: el resolutor del reporte NO se vuelve más laxo.**
   *
   * El reporte de FLIT trae la ciudad en su propia columna, así que aquí la igualdad exacta es la
   * comprobación correcta y relajarla emparejaría filas que hoy no se emparejan. Si alguien
   * «unificara» las dos funciones haciendo que esta llame a la tolerante, este caso se pone rojo.
   */
  it('sigue siendo EXACTO por nombre: la redacción variada del RUNT no cruza sin ciudad', () => {
    expect(resolverCodigoOrganismoFlit({ nombre: 'STRIA DE TTOyTTE MEDELLIN' })).toBeNull();
    expect(resolverCodigoOrganismoFlit({ nombre: 'ORGANISMO DE TRANSITO DE FUNZA' })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Bug #12179 — emparejamiento TOLERANTE con el nombre que redacta el RUNT.
//
// El canal Cliente del SOAT solo tiene UNA cadena (`data.vehiculo.organismoTransito`) y la comparaba
// por igualdad contra el catálogo. Como la redacción del RUNT varía, resolvía `null` aunque el
// registro SÍ mandara el organismo, y el wizard pintaba «—». Todo lo de aquí abajo usa cadenas que
// NO son copias literales del catálogo: una cadena copiada del catálogo pasa igual con el resolutor
// roto y es exactamente por lo que los fixtures del canal nunca vieron el defecto.
describe('resolverCodigoOrganismoRunt (tolerante)', () => {
  it('**la variante que el propio módulo documenta cruza: «STRIA DE TTOyTTE MEDELLIN» → 05001**', () => {
    // El caso del comentario de `resolverCodigoOrganismoFlit`: el catálogo dice «STRIA TTEyTTO
    // MEDELLIN» y el RUNT «STRIA DE TTOyTTE MEDELLIN». Con igualdad exacta esto es `null` — el test
    // de arriba lo fija—, y con el emparejador tolerante es el código de Medellín.
    expect(resolverCodigoOrganismoRunt('STRIA DE TTOyTTE MEDELLIN')).toBe('05001');
  });

  it.each([
    ['ORGANISMO DE TRANSITO DE FUNZA', '25286'],
    ['SECRETARIA DE TRANSITO Y TRANSPORTE DE BUCARAMANGA', '68001'],
    ['STRIA DE TRANSITO MUNICIPAL DE SOACHA - CUNDINAMARCA', '25754'],
    ['DIRECCION DE TRANSITO DE ENVIGADO', '05266'],
    ['stria ttoytte mcpal funza', '25286'],
  ])('prefijos y sufijos distintos del catálogo: «%s» → %s', (nombre, codigo) => {
    expect(resolverCodigoOrganismoRunt(nombre)).toBe(codigo);
  });

  it('la igualdad exacta sigue siendo el PRIMER nivel: el nombre literal del catálogo cruza igual', () => {
    expect(resolverCodigoOrganismoRunt('STRIA TTOyTTE MCPAL FUNZA')).toBe('25286');
    expect(resolverCodigoOrganismoRunt('STRIA TTEyTTO MEDELLIN')).toBe('05001');
  });

  it('**TODO nombre del catálogo se resuelve a SU PROPIO código** (sin colisiones internas)', () => {
    // Recorre los 119. Es lo que detecta una colisión nueva el día que se añada un municipio cuyo
    // nombre esté contenido en otro: el organismo añadido resolvería al ajeno y esto se pondría rojo.
    for (const o of ORGANISMOS_TRANSITO) {
      expect(resolverCodigoOrganismoRunt(o.nombre), `nombre de catálogo: ${o.nombre}`).toBe(o.codigo);
    }
  });

  it('**y con la redacción del RUNT antepuesta, también** (salvo los dos homónimos de departamento)', () => {
    // El mismo recorrido pero con una redacción que NO es la del catálogo, que es donde vive el Bug.
    //
    // Caldas (05129) y Arauca (81001) quedan FUERA y no por comodidad: son las dos ciudades del
    // catálogo que se llaman como un departamento, y la regla que impide que «SUPIA - CALDAS»
    // resuelva Caldas-Antioquia les quita también a ellas la vía tolerante. Es el precio declarado,
    // con test propio más abajo; excluirlas aquí en silencio sería esconderlo.
    const homonimosDeDepartamento = ['05129', '81001'];
    const cubiertos = ORGANISMOS_TRANSITO.filter((o) => !homonimosDeDepartamento.includes(o.codigo));
    expect(cubiertos, 'la exclusión son DOS, no una puerta abierta').toHaveLength(117);
    for (const o of cubiertos) {
      const comoLoDiceElRunt = `STRIA DE TTOyTTE ${o.ciudad.toUpperCase()}`;
      expect(resolverCodigoOrganismoRunt(comoLoDiceElRunt), comoLoDiceElRunt).toBe(o.codigo);
    }
  });

  it('**los dos pares que se contienen en el catálogo los separa la FRONTERA de palabra**', () => {
    // Florida ⊂ Floridablanca y Girardot ⊂ Girardota son los únicos pares medidos sobre el catálogo.
    //
    // El nombre de este caso decía «se deciden por LONGITUD», y **dejó de ser verdad** cuando el
    // nivel 2 pasó a casar por palabra completa: medido con el mutante del orden ascendente, estos
    // cuatro asertos siguen verdes y el único que se cae es el de Tame/Arauca. Lo que los separa hoy
    // es que « FLORIDA » no está dentro de « FLORIDABLANCA », que es UNA palabra. El orden por
    // longitud se conserva —decide Tame/Arauca y cubriría un municipio compuesto futuro—, pero ya no
    // es lo que sostiene este caso, y el título tenía que dejar de afirmarlo.
    expect(resolverCodigoOrganismoRunt('STRIA DE TTOyTTE FLORIDABLANCA')).toBe('68276');
    expect(resolverCodigoOrganismoRunt('STRIA DE TTOyTTE FLORIDA')).toBe('76275');
    expect(resolverCodigoOrganismoRunt('STRIA DE TTOyTTE GIRARDOTA')).toBe('05308');
    expect(resolverCodigoOrganismoRunt('STRIA DE TTOyTTE GIRARDOT')).toBe('25307');
  });

  it('los homónimos de otro departamento NO están en el catálogo: cada nombre cruza una sola vez', () => {
    // Caldas, Granada, Barbosa, La Unión, Villanueva y Cartago aparecen UNA vez, así que no hay
    // ambigüedad que decidir hoy. El aserto fija esa premisa: si mañana se añade el homónimo, el
    // emparejamiento pasa a depender del orden por longitud y hay que volver al docblock.
    for (const ciudad of ['CALDAS', 'GRANADA', 'BARBOSA', 'LA UNION', 'VILLANUEVA', 'CARTAGO']) {
      const norm = (s: string) => s.normalize('NFD').toUpperCase().replace(/[^A-Z0-9]/g, '');
      expect(ORGANISMOS_TRANSITO.filter((o) => norm(o.ciudad) === norm(ciudad)), ciudad).toHaveLength(1);
    }
    // Y los que suenan parecidos pero no se contienen resuelven cada uno lo suyo.
    expect(resolverCodigoOrganismoRunt('STRIA DE TTOyTTE CARTAGO')).toBe('76147');
    expect(resolverCodigoOrganismoRunt('STRIA DE TTOyTTE CARTAGENA')).toBe('13001');
    expect(resolverCodigoOrganismoRunt('STRIA DE TTOyTTE TURBO')).toBe('05837');
    expect(resolverCodigoOrganismoRunt('STRIA DE TTOyTTE TURBACO')).toBe('13836');
  });

  /**
   * **«<municipio> - <departamento>»: la familia que encontró el gate B.**
   *
   * Cadenas donde el MUNICIPIO está fuera del catálogo y el DEPARTAMENTO se llama como una ciudad
   * que sí está. Solo hay dos departamentos así —Caldas (que en el catálogo es el de ANTIOQUIA,
   * 05129) y Arauca (81001)— y bastan para 48 atribuciones equivocadas medidas: 19 municipios de
   * Caldas y 5 de Arauca × 2 plantillas. Un SOAT de Supía se habría ido a la bandeja de Caldas,
   * Antioquia.
   *
   * La plantilla no es inventada: «… SOACHA - CUNDINAMARCA» es un fixture de este mismo archivo.
   *
   * Se cierra excluyendo de la contención a las ciudades homónimas de un departamento. Este bloque
   * es lo que impide reintroducirlo.
   */
  it.each([
    ['SUPIA', 'CALDAS'], ['RIOSUCIO', 'CALDAS'], ['ANSERMA', 'CALDAS'], ['VILLAMARIA', 'CALDAS'],
    ['NEIRA', 'CALDAS'], ['SALAMINA', 'CALDAS'], ['PENSILVANIA', 'CALDAS'], ['MANZANARES', 'CALDAS'],
    ['ARAUQUITA', 'ARAUCA'], ['SARAVENA', 'ARAUCA'], ['FORTUL', 'ARAUCA'],
    ['PUERTO RONDON', 'ARAUCA'], ['CRAVO NORTE', 'ARAUCA'],
  ])('**municipio fuera de catálogo + departamento que sí lo es: «%s - %s» → null**', (muni, depto) => {
    // Las dos plantillas de redacción medidas: con guion y pegada.
    expect(resolverCodigoOrganismoRunt(`STRIA DE TRANSITO MUNICIPAL DE ${muni} - ${depto}`)).toBeNull();
    expect(resolverCodigoOrganismoRunt(`STRIA DE TTOyTTE ${muni} ${depto}`)).toBeNull();
  });

  it('**«TAME ARAUCA» resuelve TAME (81794): el departamento no gana, y eso es lo correcto**', () => {
    // Este caso afirmaba lo contrario —«la ambigüedad aceptada: resuelve Arauca»— y era el único
    // síntoma visible de la familia de arriba. Con la regla de departamentos deja de ser una
    // ambigüedad aceptada y pasa a estar bien resuelto: Tame es el municipio, Arauca el departamento.
    expect(resolverCodigoOrganismoRunt('STRIA TTEyTTO TAME ARAUCA')).toBe('81794');
    expect(resolverCodigoOrganismoRunt('STRIA DE TTOyTTE TAME ARAUCA')).toBe('81794');
    expect(resolverCodigoOrganismoRunt('STRIA DE TTOyTTE TAME')).toBe('81794');
  });

  it('un municipio del catálogo con su departamento detrás sigue resolviendo', () => {
    // La otra mitad: la regla salta el departamento, no la cadena entera. Chinchiná, Manizales y La
    // Dorada están en el catálogo Y en el departamento de Caldas, que es el caso que más fácil se
    // rompería con una regla que descartara toda cadena con nombre de departamento dentro.
    expect(resolverCodigoOrganismoRunt('STRIA TTEyTTO CHINCHINA CALDAS')).toBe('17174');
    expect(resolverCodigoOrganismoRunt('STRIA DE TTOyTTE MANIZALES CALDAS')).toBe('17001');
    expect(resolverCodigoOrganismoRunt('STRIA DE TTOyTTE LA DORADA CALDAS')).toBe('17380');
    expect(resolverCodigoOrganismoRunt('STRIA DE TRANSITO MUNICIPAL DE SOACHA - CUNDINAMARCA')).toBe('25754');
  });

  /**
   * **Las 32 entradas están VIVAS, no solo las dos que hoy chocan.**
   *
   * Nota del gate B: construir el índice con `d.toUpperCase()` en vez de `norm(d)` es hoy un mutante
   * EQUIVALENTE —ninguna de las 119 ciudades cambia de veredicto, porque Caldas y Arauca son de una
   * palabra y sin tilde—, así que ningún test del comportamiento actual puede matarlo. Pero dejaría
   * inertes 14 de las 32: las que llevan tilde o varias palabras. Y la lista existe para el FUTURO:
   * el día que entre al catálogo una ciudad Córdoba (Quindío) o Quindío, el error volvería en
   * silencio y sin test que avise.
   *
   * Se afirma sobre `esNombreDeDepartamento`, que es la MISMA función que alimenta el índice del
   * resolutor y no una copia — si fuera una copia, el aserto probaría el test y no el código.
   */
  it('**los 32 departamentos entran normalizados: tildes y varias palabras incluidas**', () => {
    expect(DEPARTAMENTOS_COLOMBIA).toHaveLength(32);
    // Las 14 que el mutante `toUpperCase()` dejaría inertes, una por una.
    for (const d of [
      'Atlántico', 'Bolívar', 'Boyacá', 'Caquetá', 'Chocó', 'Córdoba', 'Guainía', 'La Guajira',
      'Nariño', 'Norte de Santander', 'Quindío', 'San Andrés y Providencia', 'Valle del Cauca',
      'Vaupés',
    ]) {
      expect(esNombreDeDepartamento(d), `${d} tiene que estar en el índice normalizado`).toBe(true);
    }
    // Y reconoce la forma en que llegaría de verdad: mayúsculas, sin tilde y con la puntuación que
    // traiga el RUNT. Es lo que hace inútil un índice construido con `toUpperCase()`.
    expect(esNombreDeDepartamento('CORDOBA')).toBe(true);
    expect(esNombreDeDepartamento('LA GUAJIRA')).toBe(true);
    expect(esNombreDeDepartamento('N. DE SANTANDER')).toBe(false);
    // Las DOS que hoy intersecan con el catálogo, que son las que la regla usa de verdad.
    expect(esNombreDeDepartamento('Caldas')).toBe(true);
    expect(esNombreDeDepartamento('Arauca')).toBe(true);
    // Y un municipio que no es departamento no puede colarse en el índice.
    expect(esNombreDeDepartamento('Medellín')).toBe(false);
    expect(esNombreDeDepartamento('Funza')).toBe(false);
  });

  it('la intersección catálogo × departamentos es de DOS, y está medida, no supuesta', () => {
    // Si mañana entra al catálogo una ciudad homónima de departamento, este aserto se pone rojo y
    // obliga a repasar el precio documentado en vez de descubrirlo en producción.
    const homonimas = ORGANISMOS_TRANSITO.filter((o) => esNombreDeDepartamento(o.ciudad));
    expect(homonimas.map((o) => o.codigo).sort()).toEqual(['05129', '81001']);
  });

  it('**el PRECIO de la regla, escrito: Caldas y Arauca solo cruzan por igualdad EXACTA**', () => {
    // Los dos organismos del catálogo homónimos de departamento pierden la vía tolerante. Es el
    // precio consciente: dos de 119 dejan de resolver con redacción variada, a cambio de no atribuir
    // 48 solicitudes a un organismo de otro departamento. El fallo es el honesto («—»).
    expect(resolverCodigoOrganismoRunt('STRIA DE TTOyTTE CALDAS')).toBeNull();
    expect(resolverCodigoOrganismoRunt('STRIA DE TTOyTTE ARAUCA')).toBeNull();
    // Y la redacción LITERAL, que es como llegan cuando de verdad son ellos, sigue resolviendo por
    // el nivel 1 — que esta regla no toca.
    expect(resolverCodigoOrganismoRunt('STRIA TTEyTTO CALDAS')).toBe('05129');
    expect(resolverCodigoOrganismoRunt('STRIA TTEyTTO ARAUCA')).toBe('81001');
  });

  /**
   * **Los cuatro falsos positivos que encontró el coordinador, y por qué son caros.**
   *
   * Con `includes` sobre la forma PEGADA (sin espacios), cualquier municipio que empiece por el
   * nombre de uno del catálogo se lo llevaba: «CALI» está dentro de «CALIMA». Eso no produce un «—»,
   * produce un `flito_soat.organismo_codigo` EQUIVOCADO con FK a una fila real — y esa columna es el
   * ámbito de bandeja (`schema.ts:390-391`), así que un SOAT de Támesis acabaría en la bandeja de
   * Tame, Arauca. Un `null` honesto que Operaciones completa a mano es estrictamente mejor.
   *
   * Ninguno de los cuatro está en los 119: son municipios reales fuera del catálogo, que es
   * exactamente el caso que el nivel 2 tiene que dejar pasar de largo.
   */
  it.each([
    ['TAMESIS', 'Támesis (Antioquia) no es Tame (Arauca)'],
    ['CALIMA EL DARIEN', 'Calima El Darién no es Cali'],
    ['CALIFORNIA', 'California (Santander) no es Cali'],
    ['BUGALAGRANDE', 'Bugalagrande no es Buga'],
  ])('**un municipio FUERA del catálogo no se empareja: «%s» → null** (%s)', (municipio) => {
    expect(resolverCodigoOrganismoRunt(municipio)).toBeNull();
    // Y tampoco con la redacción del RUNT delante, que es como llegaría de verdad.
    expect(resolverCodigoOrganismoRunt(`STRIA DE TTOyTTE ${municipio}`)).toBeNull();
    expect(resolverCodigoOrganismoRunt(`TRANSITO MUNICIPAL DE ${municipio}`)).toBeNull();
  });

  /**
   * **Los cuatro, con las DOS redacciones, contra los DOS niveles.**
   *
   * La forma desnuda la cierra la frontera de palabra del nivel 2. La forma con la redacción LITERAL
   * del catálogo delante —`STRIA TTEyTTO <municipio>`, que no es rebuscada: es el patrón del PROPIO
   * catálogo y por tanto la más probable— la cerraba antes el ancla al final de un tercer nivel por
   * sufijo, y hoy la cierra el hecho de que ese nivel **ya no existe**: se retiró tras medir que
   * ninguna de 833 redacciones realistas lo alcanzaba (ver el docblock de la fuente).
   *
   * Este bloque es el que protege esa decisión por los dos lados: muere si alguien devuelve el nivel
   * 2 a la contención sin frontera, y muere si alguien reintroduce el nivel de sufijo con `includes`
   * «por si acaso».
   */
  it.each([
    ['TAMESIS', 'Támesis (Antioquia) no es Tame (Arauca)'],
    ['CALIMA EL DARIEN', 'Calima El Darién no es Cali'],
    ['CALIFORNIA', 'California (Santander) no es Cali'],
    ['BUGALAGRANDE', 'Bugalagrande no es Buga'],
  ])('**«%s» no se empareja por ninguno de los dos niveles** (%s)', (municipio) => {
    expect(resolverCodigoOrganismoRunt(municipio)).toBeNull();
    expect(resolverCodigoOrganismoRunt(`STRIA TTEyTTO ${municipio}`)).toBeNull();
    expect(resolverCodigoOrganismoRunt(`STRIA DE TTOyTTE ${municipio}`)).toBeNull();
  });

  /**
   * **El nivel 1 se queda con la cadena pegada; no hace falta un tercer nivel para eso.**
   *
   * Se conserva porque es la premisa que sostiene la retirada del nivel de sufijo: `norm` borra
   * TODOS los separadores, así que cualquier variación de espaciado o puntuación del nombre de
   * catálogo ya es igualdad exacta. Si alguien «optimizara» `norm` para conservar espacios, este
   * caso se pondría rojo y avisaría de que la retirada del tercer nivel dejó de estar justificada.
   */
  it('la cadena TOTALMENTE PEGADA resuelve por igualdad exacta, no por tolerancia', () => {
    expect(resolverCodigoOrganismoRunt('STRIATTEYTTOMEDELLIN')).toBe('05001');
    expect(resolverCodigoOrganismoRunt('STRIATTOYTTEMCPALFUNZA')).toBe('25286');
  });

  it('la frontera es de PALABRA, no de prefijo: un municipio de dos palabras sigue casando', () => {
    // La otra mitad de la cota. Un `startsWith`/`endsWith` cerraría los cuatro de arriba y rompería
    // estos: «LA CALERA» y «SANTA ROSA DE OSOS» son varias palabras dentro de una cadena más larga.
    expect(resolverCodigoOrganismoRunt('STRIA DE TTOyTTE MCPAL LA CALERA CUNDINAMARCA')).toBe('25377');
    expect(resolverCodigoOrganismoRunt('ORGANISMO DE TRANSITO DE SANTA ROSA DE OSOS')).toBe('05686');
    expect(resolverCodigoOrganismoRunt('TRANSITO DE EL CARMEN DE VIBORAL')).toBe('05148');
    // Y la puntuación no rompe la frontera: sigue siendo un separador, no una letra.
    expect(resolverCodigoOrganismoRunt('STRIA TTEyTTO, MEDELLIN.')).toBe('05001');
  });

  it('**el negativo real sigue siendo `null`: no se empareja con lo primero que haya**', () => {
    // El mutante que mata: devolver el primer organismo del catálogo cuando no hay coincidencia.
    expect(resolverCodigoOrganismoRunt('STRIA TTO DE MARTE')).toBeNull();
    expect(resolverCodigoOrganismoRunt('ORGANISMO INEXISTENTE')).toBeNull();
    expect(resolverCodigoOrganismoRunt('XX')).toBeNull();
  });

  it('la ausencia no rompe: null, undefined y cadena vacía son `null`', () => {
    expect(resolverCodigoOrganismoRunt(null)).toBeNull();
    expect(resolverCodigoOrganismoRunt(undefined)).toBeNull();
    expect(resolverCodigoOrganismoRunt('')).toBeNull();
    expect(resolverCodigoOrganismoRunt('   ')).toBeNull();
  });
});
