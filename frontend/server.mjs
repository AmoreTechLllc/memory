import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const distDir = join(__dirname, 'dist')
const backendBase = process.env.BACKEND_URL || 'http://127.0.0.1:8794'
const port = Number.parseInt(process.env.PORT || '4000', 10)

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
])

function setCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, auth, Accept-Language')
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
}

async function serveStatic(response, pathname) {
  const relativePath = pathname === '/' ? '/index.html' : pathname
  const resolved = normalize(join(distDir, relativePath))

  if (!resolved.startsWith(distDir)) {
    response.statusCode = 400
    response.end('Bad request')
    return
  }

  try {
    const fileStat = await stat(resolved)
    if (fileStat.isDirectory()) {
      throw new Error('directory')
    }

    const body = await readFile(resolved)
    response.statusCode = 200
    response.setHeader('Content-Type', contentTypes.get(extname(resolved)) || 'application/octet-stream')
    response.end(body)
  } catch {
    const fallback = await readFile(join(distDir, 'index.html'))
    response.statusCode = 200
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(fallback)
  }
}

function getBackendTargetUrl(requestUrl) {
  const pathname = requestUrl.pathname === '/api'
    ? '/'
    : requestUrl.pathname.startsWith('/api/')
      ? requestUrl.pathname.slice('/api'.length)
      : requestUrl.pathname

  return new URL(`${pathname}${requestUrl.search}`, backendBase)
}

async function proxyApi(request, response) {
  const requestUrl = new URL(request.url || '/', 'http://localhost')
  const targetUrl = getBackendTargetUrl(requestUrl)

  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'undefined') continue
    if (Array.isArray(value)) {
      headers.set(name, value.join(', '))
    } else {
      headers.set(name, value)
    }
  }

  headers.delete('host')

  const upstream = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request,
    duplex: request.method === 'GET' || request.method === 'HEAD' ? undefined : 'half',
  })

  response.statusCode = upstream.status
  upstream.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'transfer-encoding') return
    response.setHeader(key, value)
  })
  setCorsHeaders(response)

  if (request.method === 'HEAD') {
    response.end()
    return
  }

  const buffer = Buffer.from(await upstream.arrayBuffer())
  response.end(buffer)
}

const server = createServer(async (request, response) => {
  setCorsHeaders(response)

  if (!request.url) {
    response.statusCode = 400
    response.end('Missing request url')
    return
  }

  const requestUrl = new URL(request.url, 'http://localhost')

  if (requestUrl.pathname === '/health') {
    response.statusCode = 200
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.end(JSON.stringify({ status: 'ok' }))
    return
  }

  if (requestUrl.pathname.startsWith('/api/')) {
    try {
      await proxyApi(request, response)
    } catch (error) {
      response.statusCode = 502
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.end(JSON.stringify({ error: 'proxy_failed', message: error instanceof Error ? error.message : String(error) }))
    }
    return
  }

  if (requestUrl.pathname === '/api') {
    try {
      await proxyApi(request, response)
    } catch (error) {
      response.statusCode = 502
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.end(JSON.stringify({ error: 'proxy_failed', message: error instanceof Error ? error.message : String(error) }))
    }
    return
  }

  if (requestUrl.pathname.startsWith('/assets/') || requestUrl.pathname === '/favicon.ico' || requestUrl.pathname.endsWith('.js') || requestUrl.pathname.endsWith('.css') || requestUrl.pathname.endsWith('.svg') || requestUrl.pathname.endsWith('.png') || requestUrl.pathname.endsWith('.ico')) {
    await serveStatic(response, requestUrl.pathname)
    return
  }

  await serveStatic(response, requestUrl.pathname)
})

server.listen(port, '0.0.0.0', () => {
  console.log(`[memory-frontend] listening on http://0.0.0.0:${port}`)
  console.log(`[memory-frontend] proxying /api to ${backendBase}`)
})
