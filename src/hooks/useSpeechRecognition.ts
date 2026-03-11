import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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

type UseSpeechRecognitionOptions = {
  modelUrl: string
  grammar?: string
  chunkSize?: number
}

type AudioRuntime = {
  context: AudioContext
  stream: MediaStream
  source: MediaStreamAudioSourceNode
  processor: ScriptProcessorNode
  sink: GainNode
}

type UseSpeechRecognitionResult = {
  partialTranscript: string
  finalSegments: string[]
  transcript: string
  isListening: boolean
  isModelLoading: boolean
  isModelReady: boolean
  error: string | null
  start: () => Promise<void>
  stop: () => Promise<void>
  reset: () => void
}

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return 'Unknown speech recognition error'
}

export const useSpeechRecognition = ({
  modelUrl,
  grammar,
  chunkSize = 4096,
}: UseSpeechRecognitionOptions): UseSpeechRecognitionResult => {
  const [partialTranscript, setPartialTranscript] = useState('')
  const [finalSegments, setFinalSegments] = useState<string[]>([])
  const [isListening, setIsListening] = useState(false)
  const [isModelLoading, setIsModelLoading] = useState(false)
  const [isModelReady, setIsModelReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const workerRef = useRef<Worker | null>(null)
  const audioRuntimeRef = useRef<AudioRuntime | null>(null)
  const modelReadyPromiseRef = useRef<Promise<void> | null>(null)
  const modelReadyResolveRef = useRef<(() => void) | null>(null)
  const modelReadyRejectRef = useRef<((reason?: unknown) => void) | null>(null)
  const modelSampleRateRef = useRef<number | null>(null)
  const pendingSampleRateRef = useRef<number | null>(null)

  const createWorker = useCallback((): Worker => {
    if (workerRef.current) {
      return workerRef.current
    }

    const worker = new Worker(new URL('../workers/vosk.worker.ts', import.meta.url), {
      type: 'module',
    })

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data
      if (message.type === 'ready') {
        setIsModelLoading(false)
        setIsModelReady(true)
        modelSampleRateRef.current = pendingSampleRateRef.current
        pendingSampleRateRef.current = null
        modelReadyResolveRef.current?.()
        modelReadyPromiseRef.current = null
        modelReadyResolveRef.current = null
        modelReadyRejectRef.current = null
        return
      }

      if (message.type === 'partial') {
        setPartialTranscript(message.text)
        return
      }

      if (message.type === 'final') {
        const text = message.text.trim()
        if (text) {
          setFinalSegments((prev) => [...prev, text])
        }
        setPartialTranscript('')
        return
      }

      if (message.type === 'error') {
        setError(message.error)
        setIsModelLoading(false)
        pendingSampleRateRef.current = null
        modelReadyRejectRef.current?.(new Error(message.error))
        modelReadyPromiseRef.current = null
        modelReadyResolveRef.current = null
        modelReadyRejectRef.current = null
      }
    }

    worker.onerror = () => {
      const nextError = 'Speech recognition worker crashed'
      setError(nextError)
      setIsModelLoading(false)
      pendingSampleRateRef.current = null
      modelReadyRejectRef.current?.(new Error(nextError))
      modelReadyPromiseRef.current = null
      modelReadyResolveRef.current = null
      modelReadyRejectRef.current = null
    }

    workerRef.current = worker
    return worker
  }, [])

  const cleanupAudioRuntime = useCallback(async (): Promise<void> => {
    const runtime = audioRuntimeRef.current
    audioRuntimeRef.current = null

    if (!runtime) {
      return
    }

    runtime.processor.onaudioprocess = null
    runtime.source.disconnect()
    runtime.processor.disconnect()
    runtime.sink.disconnect()
    runtime.stream.getTracks().forEach((track) => track.stop())

    if (runtime.context.state !== 'closed') {
      await runtime.context.close()
    }
  }, [])

  const ensureModel = useCallback(
    (sampleRate: number): Promise<void> => {
      if (isModelReady && modelSampleRateRef.current === sampleRate) {
        return Promise.resolve()
      }

      if (modelReadyPromiseRef.current) {
        return modelReadyPromiseRef.current
      }

      const worker = createWorker()
      setIsModelLoading(true)
      setError(null)
      pendingSampleRateRef.current = sampleRate

      modelReadyPromiseRef.current = new Promise<void>((resolve, reject) => {
        modelReadyResolveRef.current = resolve
        modelReadyRejectRef.current = reject
      })

      const initCommand: WorkerCommand = {
        type: 'init',
        modelUrl,
        sampleRate,
        grammar,
      }
      worker.postMessage(initCommand)

      return modelReadyPromiseRef.current
    },
    [createWorker, grammar, isModelReady, modelUrl],
  )

  const start = useCallback(async (): Promise<void> => {
    if (isListening) {
      return
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('getUserMedia is not supported in this browser')
      return
    }

    setError(null)

    let stream: MediaStream | null = null
    let context: AudioContext | null = null
    let source: MediaStreamAudioSourceNode | null = null
    let processor: ScriptProcessorNode | null = null
    let sink: GainNode | null = null

    try {
      const worker = createWorker()
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })

      context = new AudioContext()
      await context.resume()

      await ensureModel(context.sampleRate)
      const streamSampleRate = context.sampleRate

      source = context.createMediaStreamSource(stream)
      processor = context.createScriptProcessor(chunkSize, 1, 1)
      sink = context.createGain()
      sink.gain.value = 0

      processor.onaudioprocess = (event: AudioProcessingEvent) => {
        const input = event.inputBuffer.getChannelData(0)
        const chunk = new Float32Array(input.length)
        chunk.set(input)

        const chunkCommand: WorkerCommand = {
          type: 'audio-chunk',
          chunk: chunk.buffer,
          sampleRate: streamSampleRate,
        }

        worker.postMessage(chunkCommand, [chunk.buffer])
      }

      source.connect(processor)
      processor.connect(sink)
      sink.connect(context.destination)

      audioRuntimeRef.current = {
        context,
        stream,
        source,
        processor,
        sink,
      }

      setIsListening(true)
    } catch (nextError) {
      setError(toErrorMessage(nextError))
      await cleanupAudioRuntime()
      if (processor) {
        processor.onaudioprocess = null
      }
      source?.disconnect()
      processor?.disconnect()
      sink?.disconnect()
      stream?.getTracks().forEach((track) => track.stop())
      if (context && context.state !== 'closed') {
        await context.close()
      }
      setIsListening(false)
    }
  }, [chunkSize, cleanupAudioRuntime, createWorker, ensureModel, isListening])

  const stop = useCallback(async (): Promise<void> => {
    if (!isListening) {
      return
    }

    setIsListening(false)
    try {
      await cleanupAudioRuntime()
    } finally {
      if (workerRef.current) {
        const flushCommand: WorkerCommand = { type: 'flush' }
        workerRef.current.postMessage(flushCommand)
      }
    }
  }, [cleanupAudioRuntime, isListening])

  const reset = useCallback((): void => {
    setPartialTranscript('')
    setFinalSegments([])
  }, [])

  useEffect(() => {
    createWorker()

    return () => {
      void cleanupAudioRuntime()

      if (workerRef.current) {
        const destroyCommand: WorkerCommand = { type: 'destroy' }
        workerRef.current.postMessage(destroyCommand)
        workerRef.current.terminate()
        workerRef.current = null
      }

      pendingSampleRateRef.current = null
      modelSampleRateRef.current = null
    }
  }, [cleanupAudioRuntime, createWorker])

  const transcript = useMemo(() => {
    const pieces = [...finalSegments]
    const partial = partialTranscript.trim()
    if (partial) {
      pieces.push(partial)
    }
    return pieces.join(' ').trim()
  }, [finalSegments, partialTranscript])

  return {
    partialTranscript,
    finalSegments,
    transcript,
    isListening,
    isModelLoading,
    isModelReady,
    error,
    start,
    stop,
    reset,
  }
}
