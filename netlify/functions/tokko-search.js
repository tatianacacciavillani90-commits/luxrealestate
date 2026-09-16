// ============================================================================
// BLOQUE: TOKKO — función puente para buscar en vivo en el catálogo real de LUX
// ============================================================================
// Esta función corre en el servidor de Netlify (nunca en el navegador), así que
// la API Key de Tokko queda oculta — nadie que mire el código de la página la
// puede ver. El sitio le pide datos a ESTA función (/.netlify/functions/tokko-search)
// y ella es la que habla con Tokko usando la clave secreta.
//
// La clave se configura en Netlify → Site configuration → Environment variables
// con el nombre exacto TOKKO_API_KEY. Nunca va escrita acá en el código ni en GitHub.
//
// Parámetros que acepta (todos opcionales, vía query string):
//   ?zona=Nordelta&tipo=Casa&operacion=Venta&ambientes=4&limit=30&lang=en
//
// CÓMO FILTRA (importante para futuras ediciones):
// Tokko no publica una tabla oficial de "códigos" para tipo de propiedad ni
// para ubicaciones, así que en vez de adivinar esos códigos (lo que fallaba
// silenciosamente devolviendo 0 resultados), esta función le pide a Tokko un
// lote grande de propiedades de LUX y filtra ELLA MISMA mirando los datos
// reales que devuelve cada propiedad (nombre de zona, tipo, ambientes,
// operación). Confirmado contra la cuenta real de LUX:
//   - operations[].operation_type: string, ej. "Venta" / "Alquiler"
//   - location.full_location / location.name / address / fake_address: texto de zona
//   - room_amount: número de ambientes
//   - photos[].image: foto
// Si en el futuro algo no filtra bien, agregar ?debug=1 a la URL de esta
// función (en el navegador) para ver una propiedad real completa y ajustar
// los nombres de campo en "primero(...)" de más abajo.
// ============================================================================

const TOKKO_BASE = 'https://www.tokkobroker.com/api/v1';

// Devuelve el primer valor no vacío entre varias rutas posibles de un objeto,
// para tolerar variaciones en los nombres de campo.
function primero(obj, rutas) {
  for (const ruta of rutas) {
    const valor = ruta.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
    if (valor !== undefined && valor !== null && valor !== '') return valor;
  }
  return null;
}

function normalizar(texto) {
  return (texto || '')
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // saca acentos para comparar mejor
}

// ============================================================================
// BLOQUE: TRADUCCIÓN — título de la propiedad al inglés
// ============================================================================
// El título de cada propiedad es texto libre que escribió el asesor en Tokko
// (ej. "Departamento con vista al lago en Oceana Nordelta") — no es un dato
// estructurado, así que no hay forma de traducirlo "a mano" como el resto del
// sitio. Cuando el sitio pide los resultados en inglés (?lang=en), esta
// función llama a un traductor automático gratuito (Google Translate, sin
// necesitar cuenta ni clave) solo para ese texto puntual.
// Si el traductor falla o no responde a tiempo, se deja el título en español
// tal cual — nunca se rompe la búsqueda por esto.
async function traducirTexto(texto) {
  if (!texto) return texto;
  try {
    const url =
      'https://translate.googleapis.com/translate_a/single?client=gtx&sl=es&tl=en&dt=t&q=' +
      encodeURIComponent(texto);
    // Le ponemos un límite de tiempo corto: si el traductor no responde rápido,
    // seguimos con el español en vez de dejar colgada toda la búsqueda.
    const controlador = new AbortController();
    const aviso = setTimeout(() => controlador.abort(), 3500);
    const res = await fetch(url, { signal: controlador.signal });
    clearTimeout(aviso);
    if (!res.ok) return texto;
    const data = await res.json();
    // Formato de respuesta: [[["texto traducido","texto original",...], ...], ...]
    const traducido = (data[0] || []).map((tramo) => tramo[0]).join('');
    return traducido || texto;
  } catch (e) {
    return texto;
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
  const zona = normalizar(params.zona);
  const tipo = normalizar(params.tipo);
  const operacion = normalizar(params.operacion);
  const ambientesParam = (params.ambientes || '').trim();
  const idioma = (params.lang || 'es').toLowerCase();

  // Modo diagnóstico: ?debug=1 devuelve tal cual la primera propiedad que
  // manda Tokko, sin filtrar ni traducir nada.
  if (params.debug === '1') {
    try {
      const debugUrl = `${TOKKO_BASE}/property/search/?lang=es_ar&format=json&limit=1&key=${apiKey}&data=${encodeURIComponent(
        JSON.stringify({
          current_localization_id: 1,
          current_localization_type: 'country',
          price_from: 0,
          price_to: 999999999999,
          operation_types: [1, 2, 3],
          property_types: [1, 2, 3, 4, 5, 6, 7],
          currency: 'ANY',
          filters: [],
        })
      )}`;
      const debugRes = await fetch(debugUrl);
      const debugJson = await debugRes.json();
      return { statusCode: 200, headers, body: JSON.stringify(debugJson, null, 2) };
    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
    }
  }

  // Modo diagnóstico 2: ?debugTraduccion=Texto en español devuelve la
  // traducción tal cual la da el traductor, para confirmar rápido desde el
  // navegador que la conexión funciona después de desplegar.
  if (params.debugTraduccion) {
    const traducido = await traducirTexto(params.debugTraduccion);
    return { statusCode: 200, headers, body: JSON.stringify({ original: params.debugTraduccion, traducido }) };
  }

  // Pedimos un lote grande y sin restricciones de tipo/ubicación (esos los
  // filtramos nosotros abajo con datos reales) para no depender de códigos
  // adivinados. Solo restringimos por operación, que sí confirmamos:
  // 1 = Venta, 2 = Alquiler, 3 = Alquiler temporal.
  const OPERATION_MAP = { venta: 1, alquiler: 2 };
  const operationTypes = OPERATION_MAP[operacion] ? [OPERATION_MAP[operacion]] : [1, 2, 3];

  const searchData = {
    current_localization_id: 1,
    current_localization_type: 'country',
    price_from: 0,
    price_to: 999999999999,
    operation_types: operationTypes,
    property_types: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    currency: 'ANY',
    filters: [],
  };

  const limiteFinal = Math.min(parseInt(params.limit, 10) || 30, 100);
  // Pedimos bastante más de lo que vamos a mostrar, porque después filtramos
  // nosotros mismos por zona/tipo/ambientes sobre este lote.
  const limitePedido = zona || tipo || ambientesParam ? 200 : limiteFinal;

  const searchUrl =
    `${TOKKO_BASE}/property/search/?lang=es_ar&format=json&limit=${limitePedido}` +
    `&order_by=is_starred_on_web&order=DESC&key=${apiKey}` +
    `&data=${encodeURIComponent(JSON.stringify(searchData))}`;

  try {
    const res = await fetch(searchUrl);
    if (!res.ok) {
      return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: `Tokko respondió ${res.status}` }) };
    }
    const data = await res.json();
    const crudas = data.objects || data.results || (Array.isArray(data) ? data : []);

    const conDatos = crudas.map((p) => {
      const fotosRaw = primero(p, ['photos']) || [];
      const fotos = (Array.isArray(fotosRaw) ? fotosRaw : [])
        .map((f) => (typeof f === 'string' ? f : primero(f, ['image', 'original', 'thumb'])))
        .filter(Boolean);

      const operaciones = primero(p, ['operations']) || [];
      const primeraOperacion = Array.isArray(operaciones) ? operaciones[0] : null;
      const precios = primeraOperacion ? primero(primeraOperacion, ['prices']) : null;
      const primerPrecio = Array.isArray(precios) ? precios[0] : null;
      const nombresOperaciones = Array.isArray(operaciones)
        ? operaciones.map((o) => primero(o, ['operation_type'])).filter(Boolean)
        : [];

      const precioTexto = primerPrecio
        ? `${primero(primerPrecio, ['currency']) || 'USD'} ${Number(primero(primerPrecio, ['price', 'amount']) || 0).toLocaleString('es-AR')}`
        : 'Consultar precio';

      const zonaTexto = primero(p, ['location.name']) || primero(p, ['fake_address', 'address']) || '';
      const zonaCompleta = primero(p, ['location.full_location']) || '';
      const tipoTexto = primero(p, ['type.name', 'property_type.name', 'type_name']) || '';
      const ambientesNum = primero(p, ['room_amount']);

      return {
        _zonaBusqueda: normalizar(zonaTexto + ' ' + zonaCompleta),
        _tipoBusqueda: normalizar(tipoTexto),
        _ambientes: ambientesNum ? parseInt(ambientesNum, 10) : null,
        titulo: primero(p, ['publication_title', 'name']) || `${tipoTexto || 'Propiedad'} en ${zonaTexto}`.trim(),
        zona: zonaTexto,
        tipo: tipoTexto,
        operacion: nombresOperaciones.join(' / '),
        ambientes: ambientesNum || '',
        precio: precioTexto,
        foto: fotos[0] || '',
        url: primero(p, ['public_url', 'website_url']) || null,
      };
    });

    let filtradas = conDatos;

    if (zona) {
      filtradas = filtradas.filter((p) => p._zonaBusqueda.includes(zona));
    }
    if (tipo) {
      // Si la propiedad no trae tipo identificable, la dejamos pasar en vez
      // de descartarla — mejor mostrar de más que esconder resultados válidos
      // por un campo que no pudimos leer.
      filtradas = filtradas.filter((p) => !p._tipoBusqueda || p._tipoBusqueda.includes(tipo));
    }
    if (ambientesParam) {
      const esMinimo = ambientesParam.includes('+');
      const num = parseInt(ambientesParam.replace('+', ''), 10);
      if (!isNaN(num)) {
        filtradas = filtradas.filter((p) => {
          if (p._ambientes === null) return false;
          return esMinimo ? p._ambientes >= num : p._ambientes === num;
        });
      }
    }

    const propiedades = filtradas.slice(0, limiteFinal).map((p) => {
      const { _zonaBusqueda, _tipoBusqueda, _ambientes, ...limpio } = p;
      return limpio;
    });

    // Solo si el sitio pidió inglés: traducimos el título de cada propiedad
    // (en paralelo, y solo de la tanda final que se va a mostrar — nunca de
    // las 200 que se pidieron para filtrar). Si alguna traducción falla o
    // tarda de más, esa propiedad puntual queda con su título en español; el
    // resto sigue funcionando normal. Además, para no saturar el traductor
    // gratuito de una sola vez, traducimos como mucho las primeras 25 — el
    // resto (si hay más) queda en español, sin romper la búsqueda.
    if (idioma === 'en') {
      const LIMITE_TRADUCCION = 25;
      await Promise.all(
        propiedades.slice(0, LIMITE_TRADUCCION).map(async (p) => {
          p.tituloEn = await traducirTexto(p.titulo);
        })
      );
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, total: propiedades.length, totalDisponible: filtradas.length, propiedades }),
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
