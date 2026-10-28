import { GoogleGenAI, type Content } from "@google/genai"
import { limpiarSecreto } from "../config.ts"
import { LlmError, type LlmAdapter, type LlmResponse, type LlmTool, type LlmTurn } from "./adapter.ts"

const TIMEOUT_MS = 60_000

export class GoogleAdapter implements LlmAdapter {
  readonly provider = "google"
  readonly model: string
  private readonly cliente: GoogleGenAI

  constructor(apiKey: string, model: string) {
    this.model = model
    this.cliente = new GoogleGenAI({ apiKey })
  }

  async enviar(contenido: LlmTurn[], herramientas: LlmTool[], system: string): Promise<LlmResponse> {
    try {
      return await this.generar(contenido, herramientas, system, true)
    } catch (error) {
      const texto = error instanceof Error ? error.message : ""
      if (/thinking/i.test(texto)) {
        try {
          return await this.generar(contenido, herramientas, system, false)
        } catch (reintento) {
          throw new LlmError(mensajeProveedor(reintento))
        }
      }
      throw new LlmError(mensajeProveedor(error))
    }
  }

  private async generar(
    contenido: LlmTurn[],
    herramientas: LlmTool[],
    system: string,
    conPensamientoCero: boolean,
  ): Promise<LlmResponse> {
    const response = await this.cliente.models.generateContent({
      model: this.model,
      contents: contenido as Content[],
      config: {
        systemInstruction: system,
        temperature: 0,
        maxOutputTokens: 4096,
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
        ...(conPensamientoCero ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        tools: [
          {
            functionDeclarations: herramientas.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parametersJsonSchema: tool.parameters,
            })),
          },
        ],
      },
    })
    const llamadas = response.functionCalls ?? []
    return {
      text: response.text ?? "",
      toolCalls: llamadas.flatMap((llamada, indice) => {
        if (!llamada.name) return []
        return [
          {
            id: llamada.id ?? `call_${indice}`,
            name: llamada.name,
            args: llamada.args ?? {},
          },
        ]
      }),
    }
  }
}

function mensajeProveedor(error: unknown): string {
  const texto = limpiarSecreto(error instanceof Error ? `${error.name} ${error.message}` : "error")
  if (/TimeoutError|AbortError|aborted|timeout/i.test(texto)) {
    return "El modelo no respondió a tiempo. Intenta de nuevo en un momento."
  }
  if (/429|quota|resource exhausted|rate limit/i.test(texto)) {
    return "El proveedor limitó las consultas. Espera un momento e intenta de nuevo."
  }
  if (/API key|API_KEY|401|403|permission denied|unauthenticated/i.test(texto)) {
    return "El proveedor rechazó la clave del modelo. Revisa GEMINI_API_KEY en el servidor."
  }
  return "No pude consultar el modelo. La sesión sigue activa."
}
