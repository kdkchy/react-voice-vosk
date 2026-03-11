import {
  createModel,
  type KaldiRecognizer,
  type Model
} from 'vosk-browser'

type ResultMessage = {
  event: "result"
  recognizerId: string
  result: {
    text: string
  }
}

type PartialResultMessage = {
  event: "partialresult"
  recognizerId: string
  result: {
    partial: string
  }
}

type ErrorMessage = {
  event: "error"
  error: string
}

type WorkerCommand =
  | {
      type: 'init'
      modelUrl: string
      sampleRate: number
      grammar?: string
    }
  | {
      type: 'audio-chunk'
      chunk: ArrayBuffer
      sampleRate: number
    }
  | {
      type: 'flush'
    }
  | {
      type: 'destroy'
    }

type WorkerResponse =
  | { type: 'ready' }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'error'; error: string }

let model: Model | null = null
let recognizer: KaldiRecognizer | null = null
let currentModelUrl: string | null = null
let lastPartial = ''

const sendMessage = (message: WorkerResponse): void => {
  self.postMessage(message)
}

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return 'Unknown worker error'
}

const resetRecognizer = (): void => {
  if (!recognizer) {
    return
  }
  recognizer.remove()
  recognizer = null
}

const resetModel = (): void => {
  if (!model) {
    return
  }
  model.terminate()
  model = null
}

const bindRecognizerEvents = (nextRecognizer: KaldiRecognizer): void => {
  nextRecognizer.on('partialresult', (message) => {
    const payload = message as PartialResultMessage;

    const partial = payload.result.partial.trim()
    lastPartial = partial
    sendMessage({ type: 'partial', text: partial })
  })

  nextRecognizer.on('result', (message) => {
    const payload = message as ResultMessage
    const text = payload.result.text.trim()
    if (text) {
      sendMessage({ type: 'final', text })
    }
    lastPartial = ''
    sendMessage({ type: 'partial', text: '' })
  })

  nextRecognizer.on('error', (message) => {
    const payload = message as ErrorMessage
    sendMessage({ type: 'error', error: payload.error })
  })
}

const loadModelAndRecognizer = async (
  modelUrl: string,
  sampleRate: number,
  grammar?: string,
): Promise<void> => {
  if (!model || currentModelUrl !== modelUrl) {
    resetRecognizer()
    resetModel()
    model = await createModel(modelUrl)
    currentModelUrl = modelUrl
  }

  resetRecognizer()
  recognizer = new model.KaldiRecognizer(sampleRate, grammar)
  bindRecognizerEvents(recognizer)
  sendMessage({ type: 'ready' })
}

const processChunk = (chunkBuffer: ArrayBuffer, sampleRate: number): void => {
  if (!recognizer) {
    return
  }
  const chunk = new Float32Array(chunkBuffer)
  recognizer.acceptWaveformFloat(chunk, sampleRate)
}

const flushPartial = (): void => {
  if (!lastPartial.trim()) {
    sendMessage({ type: 'partial', text: '' })
    return
  }
  sendMessage({ type: 'final', text: lastPartial.trim() })
  lastPartial = ''
  sendMessage({ type: 'partial', text: '' })
}

const destroyAll = (): void => {
  lastPartial = ''
  resetRecognizer()
  resetModel()
  currentModelUrl = null
}

const handleCommand = async (command: WorkerCommand): Promise<void> => {
  try {
    if (command.type === 'init') {
      await loadModelAndRecognizer(
        command.modelUrl,
        command.sampleRate,
        command.grammar,
      )
      return
    }

    if (command.type === 'audio-chunk') {
      processChunk(command.chunk, command.sampleRate)
      return
    }

    if (command.type === 'flush') {
      flushPartial()
      return
    }

    if (command.type === 'destroy') {
      destroyAll()
    }
  } catch (error) {
    sendMessage({ type: 'error', error: toErrorMessage(error) })
  }
}

self.onmessage = (event: MessageEvent<WorkerCommand>): void => {
  void handleCommand(event.data)
}
