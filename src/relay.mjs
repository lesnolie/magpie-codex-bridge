const ALLOWED_PATHS = new Set(['/chat/completions', '/models']);

export function normalizeEndpoint(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || url.search) throw new Error('Adapter URL must not contain credentials, fragments or query parameters');
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local))) {
    throw new Error('Adapter must use HTTPS, or HTTP on loopback only');
  }
  return url.href.replace(/\/+$/, '');
}

function allowedURL(endpoint, input) {
  const base = new URL(endpoint.endsWith('/') ? endpoint : endpoint + '/');
  const original = typeof input === 'string' ? input : input?.url;
  if (!original) throw new Error('Missing model request URL');
  const target = new URL(original, base);
  const root = base.pathname.replace(/\/+$/, '');
  const suffix = target.pathname.startsWith(root + '/') ? target.pathname.slice(root.length) : '';
  if (target.origin !== base.origin || !ALLOWED_PATHS.has(suffix) || target.search || target.hash) {
    throw new Error('Refusing model request outside the configured adapter endpoints');
  }
  return target;
}

export async function relayRequest({ endpoint, input, init = {}, key, fetchImpl = fetch }) {
  const target = allowedURL(endpoint, input);
  const headers = new Headers(init?.headers);
  headers.set('authorization', `Bearer ${key}`);
  headers.delete('cookie');
  headers.delete('host');
  const method = init?.method || 'POST';
  if (target.pathname.endsWith('/chat/completions') && method.toUpperCase() !== 'POST') {
    throw new Error('Chat completions must use POST');
  }
  let response;
  try {
    response = await fetchImpl(target, {
      method, headers, body: init?.body, signal: init?.signal,
    });
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    throw new Error(`ChatGPT Web adapter is unreachable at ${new URL(endpoint).origin}. No connection to the real ChatGPT Web service has been established. (${error.message})`);
  }
  // Do not parse or downgrade multipart messages, image URLs, SSE chunks or tool calls.
  // The compatible adapter is responsible for full multimodal/tool semantics.
  const outHeaders = new Headers(response.headers);
  outHeaders.delete('content-length');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outHeaders });
}
