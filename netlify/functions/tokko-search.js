// ============================================================================
// BLOQUE: TOKKO — función puente para buscar en vivo en el catálogo real de LUX
// ============================================================================
// Esta función corre en el servidor de Netlify (nunca en el navegador), así que
// la API Key de Tokko queda oculta — nadie que mire el código de la página la
// puede ver. El sitio le pide datos a ESTA función (/.netlify/functions/tokko-search)
// y ella es la que habla con Tokko usando la clave secreta.
//
// La clave se configura en Netlify → Site configuration → Environment variables
// con el nombre exacto TOKKO_API_KEY (ver instrucciones aparte). Nunca va escrita
// acá en el código ni en GitHub.
//
// Parámetros que acepta (todos opcionales, vía query string):
//   ?zona=Nordelta&tipo=Casa&operacion=Venta&ambientes=4
//
// AVISO PARA FUTURAS EDICIONES: los nombres exactos de los campos que devuelve
// Tokko (título, fotos, precio, etc.) están mapeados más abajo con varios
// nombres alternativos "por las dudas", porque no pudimos probar esta función
// contra la cuenta real antes de publicarla. Si algo aparece vacío o mal en el
// sitio (ej. sin foto, sin precio), lo más probable es que el nombre del campo
// real de Tokko sea distinto al que probamos primero — revisar la respuesta
// cruda de Tokko (se puede loguear con console.log) y ajustar la lista de
// nombres alternativos en las funciones "primero(...)" de más abajo.
// ============================================================================

const TOKKO_BASE = 'https://www.tokkobroker.com/api/v1';

// Mapeos "mejor esfuerzo" — Tokko no publica una tabla oficial completa de IDs.
// Si una búsqueda por tipo devuelve resultados incorrectos, este es el primer
// lugar para corregir.
const OPERATION_MAP = { 'Venta': 1, 'Alquiler': 2 };
const TYPE_MAP = {
  'Departamento': 1,
  'Casa': 2,
  'Lote': 3,
  'Local': 4,
  'Oficina': 5,
  'Galpón/Depósito': 6,
};

// Devuelve el primer valor no vacío entre varias rutas posibles de un objeto,
// para tolerar que Tokko use un nombre de campo distinto al esperado.
function primero(obj, rutas) {
  for (const ruta of rutas) {
    const valor = ruta.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
    if (valor !== undefined && valor !== null && valor !== '') return valor;
  }
  return null;
}

async function resolverUbicacion(zona, apiKey) {
  if (!zona) return null;
  try {
    const url = `${TOKKO_BASE}/location/?format=json&key=${apiKey}&lang=es_ar&q=${encodeURIComponent(zona)}&limit=1`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const lista = data.objects || data.results || (Array.isArray(data) ? data : []);
    const primera = lista[0];
    if (!primera) return null;
    return {
      id: primera.id,
      tipo: (primera.type || 'division').toString().toLowerCase(),
    };
  } catch (e) {
    return null;
  }
}

exports.handler = async function (event) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  const apiKey = process.env.TOKKO_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: 'Falta configurar TOKKO_API_KEY en Netlify.' }),
    };
  }

  const params = event.queryStringParameters || {};
  const zona = (params.zona || '').trim();
  const tipo = (params.tipo || '').trim();
  const operacion = (params.operacion || '').trim();
  const ambientes = (params.ambientes || '').trim();

  // Modo diagnóstico: ?debug=1 devuelve tal cual la primera propiedad que
  // manda Tokko, sin filtrar ni traducir nada — sirve para confirmar los
  // nombres reales de los campos (título, fotos, precio, tipo, operación)
  // y ajustar los mapeos de este archivo con datos reales en vez de adivinar.
  if (params.debug === '1') {
    try {
      const debugData = {
        current_localization_id: 1,
        current_localization_type: 'country',
        price_from: 0,
        price_to: 999999999999,
        operation_types: [1, 2, 3],
        property_types: [1, 2, 3, 4, 5, 6, 7],
        currency: 'ANY',
        filters: [],
      };
      const debugUrl =
        `${TOKKO_BASE}/property/search/?lang=es_ar&format=json&limit=1` +
        `&key=${apiKey}&data=${encodeURIComponent(JSON.stringify(debugData))}`;
      const debugRes = await fetch(debugUrl);
      const debugJson = await debugRes.json();
      return { statusCode: 200, headers, body: JSON.stringify(debugJson, null, 2) };
    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
    }
  }

  const ubicacion = await resolverUbicacion(zona, apiKey);

  const searchData = {
    current_localization_id: ubicacion ? ubicacion.id : 1,
    current_localization_type: ubicacion ? ubicacion.tipo : 'country',
    price_from: 0,
    price_to: 999999999999,
    operation_types: OPERATION_MAP[operacion] ? [OPERATION_MAP[operacion]] : [1, 2, 3],
    property_types: TYPE_MAP[tipo] ? [TYPE_MAP[tipo]] : [1, 2, 3, 4, 5, 6, 7],
    currency: 'ANY',
    filters: [],
  };

  if (ambientes) {
    const esMinimo = ambientes.includes('+');
    const num = parseInt(ambientes.replace('+', ''), 10);
    if (!isNaN(num)) {
      searchData.filters.push(['room_amount', esMinimo ? '>' : '=', String(esMinimo ? num - 1 : num)]);
    }
  }

  // El sitio pide un límite chico (30) para la vidriera general "ver catálogo
  // completo" y uno más amplio (100) cuando hay un filtro puesto — un filtro
  // específico (zona+tipo+ambientes) ya reduce mucho el universo de 450, así
  // que no hace falta traer más que eso para cubrir todo lo que cumpla.
  const limiteRaw = parseInt(params.limit, 10);
  const limite = !isNaN(limiteRaw) ? Math.min(limiteRaw, 100) : 30;

  const searchUrl =
    `${TOKKO_BASE}/property/search/?lang=es_ar&format=json&limit=${limite}` +
    `&order_by=is_starred_on_web&order=DESC&key=${apiKey}` +
    `&data=${encodeURIComponent(JSON.stringify(searchData))}`;

  try {
    const res = await fetch(searchUrl);
    if (!res.ok) {
      return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: `Tokko respondió ${res.status}` }) };
    }
    const data = await res.json();
    const crudas = data.objects || data.results || (Array.isArray(data) ? data : []);

    const propiedades = crudas.map((p) => {
      const fotosRaw = primero(p, ['photos', 'photo_set', 'images']) || [];
      const fotos = (Array.isArray(fotosRaw) ? fotosRaw : [])
        .map((f) => (typeof f === 'string' ? f : primero(f, ['image', 'original', 'url', 'photo'])))
        .filter(Boolean);

      const operaciones = primero(p, ['operations']) || [];
      const primeraOperacion = Array.isArray(operaciones) ? operaciones[0] : null;
      const precios = primeraOperacion ? primero(primeraOperacion, ['prices']) : null;
      const primerPrecio = Array.isArray(precios) ? precios[0] : null;
      const nombresOperaciones = Array.isArray(operaciones)
        ? operaciones.map((o) => primero(o, ['operation_type', 'name'])).filter(Boolean)
        : [];

      const precioTexto = primerPrecio
        ? `${primero(primerPrecio, ['currency']) || 'USD'} ${Number(primero(primerPrecio, ['price', 'amount']) || 0).toLocaleString('es-AR')}`
        : 'Consultar precio';

      return {
        titulo: primero(p, ['publication_title', 'name', 'title']) || 'Propiedad disponible',
        zona: primero(p, ['location.name', 'address', 'fake_address']) || zona || '',
        tipo: primero(p, ['type.name', 'property_type.name']) || tipo || '',
        operacion: nombresOperaciones.join(' / ') || operacion || '',
        ambientes: primero(p, ['room_amount', 'suite_amount']) || '',
        precio: precioTexto,
        foto: fotos[0] || '',
        url: primero(p, ['public_url', 'website_url']) || null,
      };
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, total: propiedades.length, propiedades }),
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
