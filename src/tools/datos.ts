import { mkdir } from "node:fs/promises"
import path from "node:path"

export type ToolContext = {
  directory: string
  sessionId: string
  confirmadoPorUsuario?: boolean
}

export type Ok<T> = { ok: true; data: T }
export type Err = { ok: false; error: string }
export type Result<T> = Ok<T> | Err

export type CampoSolicitado = {
  etiqueta: string
  hoja?: string
  celda_etiqueta?: string
  celda_valor?: string
  obligatorio?: boolean
}

export type CampoLleno = {
  etiqueta: string
  clave: string
  ruta: string
  valor: string | number | boolean
  confianza: number
}

export type CampoFaltante = {
  etiqueta: string
  motivo: string
}

export type CampoConfirmacion = {
  etiqueta: string
  clave_propuesta: string
  ruta: string
  valor_propuesto: string | number | boolean | null
  nota: string
  confianza: number
}

export type Mapeo = {
  llenos: CampoLleno[]
  faltantes: CampoFaltante[]
  requiere_confirmacion: CampoConfirmacion[]
}

export type SoporteIndice = {
  tipo: string
  archivo: string
  vigencia_hasta: string | null
  pais_emisor: string
  descripcion: string
}

export type Solicitud = {
  id: string
  de: string
  para?: string
  asunto: string
  fecha: string
  pais: string
  cliente: string
  formato: string
  cuerpo: string
  adjuntos: string[]
}

const FRASES_CONFIRMACION = [
  "si",
  "envia",
  "enviar",
  "confirmo",
  "confirmado",
  "adelante",
  "de acuerdo",
  "si envia",
  "si enviar",
  "confirmo el envio",
  "envia el paquete",
  "enviar el paquete",
]

export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

export function esConfirmacionExplicita(mensaje: string): boolean {
  const limpio = normalizar(mensaje)
    .replace(/[¡!¿?.,;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (limpio.startsWith("no ") || limpio === "no") return false
  if (/\b(no envies|no enviar|todavia no|aun no)\b/.test(limpio)) return false
  return FRASES_CONFIRMACION.some((frase) => limpio === frase || limpio.startsWith(`${frase} `))
}

export function fechaEjecucion(ahora = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ahora)
}

export function rutaRelativa(directory: string, absoluta: string): string {
  return path.relative(directory, absoluta).split(path.sep).join("/")
}

export function casoSeguro(caso: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(caso)
}

export function dirCaso(directory: string, caso: string): string {
  return path.join(directory, "fixtures", "reto-01", "casos", caso)
}

export function dirOutCaso(directory: string, caso: string): string {
  return path.join(directory, "out", caso)
}

export async function leerJson<T>(archivo: string): Promise<Result<T>> {
  const file = Bun.file(archivo)
  if (!(await file.exists())) {
    return { ok: false, error: `No se encontró el archivo ${path.basename(archivo)}.` }
  }
  try {
    const data = JSON.parse(await file.text()) as T
    return { ok: true, data }
  } catch {
    return { ok: false, error: `Plantilla corrupta: ${path.basename(archivo)} no es JSON válido.` }
  }
}

export function leerRuta(origen: unknown, ruta: string): unknown {
  const partes = ruta.split(".")
  let actual: unknown = origen
  for (const parte of partes) {
    if (actual === null || typeof actual !== "object" || !(parte in actual)) return undefined
    actual = (actual as Record<string, unknown>)[parte]
  }
  return actual
}

export function esValorEscalar(valor: unknown): valor is string | number | boolean {
  return typeof valor === "string" || typeof valor === "number" || typeof valor === "boolean"
}

export function valorCoincide(maestro: unknown, informado: unknown): boolean {
  if (JSON.stringify(maestro) === JSON.stringify(informado)) return true
  if (typeof informado === "string" && informado === String(maestro)) return true
  if (typeof maestro === "number" && typeof informado === "string" && Number(informado) === maestro) return true
  return false
}

export function tokens(texto: string): string[] {
  const vacias = new Set(["de", "del", "la", "el", "los", "las", "y", "o", "a", "en"])
  return normalizar(texto)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !vacias.has(token))
}

export function jaccard(izquierda: string[], derecha: string[]): number {
  const a = new Set(izquierda)
  const b = new Set(derecha)
  if (a.size === 0 || b.size === 0) return 0
  let interseccion = 0
  for (const token of a) {
    if (b.has(token)) interseccion += 1
  }
  const union = a.size + b.size - interseccion
  return union === 0 ? 0 : interseccion / union
}

export async function asegurarDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

export type LogEntry = {
  ts: string
  herramienta: string
  ok: boolean
  resumen: string
}

export async function anexarLog(directory: string, caso: string | undefined, entrada: LogEntry): Promise<void> {
  const global = path.join(directory, "out", "log.jsonl")
  await escribirLinea(global, entrada)
  if (caso && casoSeguro(caso)) {
    const propio = path.join(dirOutCaso(directory, caso), "log.jsonl")
    await escribirLinea(propio, entrada)
  }
}

async function escribirLinea(archivo: string, entrada: LogEntry): Promise<void> {
  await asegurarDir(path.dirname(archivo))
  const file = Bun.file(archivo)
  const previo = (await file.exists()) ? await file.text() : ""
  await Bun.write(archivo, `${previo}${JSON.stringify(entrada)}\n`)
}

export function resumirResultado(body: Result<unknown>): string {
  if (!body.ok) return body.error
  const data = body.data
  if (data === null || typeof data !== "object") return "ok"
  const registro = data as Record<string, unknown>
  if (typeof registro.pais === "string" && typeof registro.formato === "string") {
    const campos = Array.isArray(registro.campos) ? registro.campos.length : 0
    const soportes = Array.isArray(registro.soportes) ? registro.soportes.length : 0
    return `${registro.pais} ${registro.formato}; ${campos} campos; ${soportes} soportes`
  }
  if (Array.isArray(registro.llenos) && Array.isArray(registro.faltantes)) {
    const confirmar = Array.isArray(registro.requiere_confirmacion) ? registro.requiere_confirmacion.length : 0
    return `llenos ${registro.llenos.length}, faltantes ${registro.faltantes.length}, confirmar ${confirmar}`
  }
  if (typeof registro.listo_para_firma === "boolean") {
    return `listo_para_firma=${registro.listo_para_firma}`
  }
  if (typeof registro.formato === "string" && typeof registro.ruta === "string") {
    return `${registro.formato} ${registro.ruta}`
  }
  if (typeof registro.ruta === "string") return registro.ruta
  return "ok"
}

export async function responder<T>(
  ctx: ToolContext,
  herramienta: string,
  caso: string | undefined,
  body: Result<T>,
): Promise<string> {
  await anexarLog(ctx.directory, caso, {
    ts: new Date().toISOString(),
    herramienta,
    ok: body.ok,
    resumen: resumirResultado(body),
  })
  return JSON.stringify(body)
}
