export type LlmToolCall = {
  id: string
  name: string
  args: Record<string, unknown>
}

export type LlmTool = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type LlmTurn = {
  role: "user" | "model"
  parts: LlmPart[]
}

export type LlmPart =
  | { text: string }
  | { functionCall: { id?: string; name: string; args: Record<string, unknown> } }
  | { functionResponse: { id?: string; name: string; response: Record<string, unknown> } }

export type LlmResponse = {
  text: string
  toolCalls: LlmToolCall[]
}

export interface LlmAdapter {
  readonly provider: string
  readonly model: string
  enviar(contenido: LlmTurn[], herramientas: LlmTool[], system: string): Promise<LlmResponse>
}

export class LlmError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LlmError"
  }
}
