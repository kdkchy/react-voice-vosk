import { useMemo } from 'react'
import { useSpeechRecognition } from '../hooks/useSpeechRecognition'

const MODEL_URL = '/models/vosk-model-small-en-us-0.15.zip'

export const VoiceCapture = () => {
  const {
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
  } = useSpeechRecognition({
    modelUrl: MODEL_URL,
  })

  const status = useMemo(() => {
    if (isListening) {
      return 'Listening'
    }
    if (isModelLoading) {
      return 'Loading model'
    }
    if (isModelReady) {
      return 'Ready'
    }
    return 'Idle'
  }, [isListening, isModelLoading, isModelReady])

  const hasAnyTranscript = finalSegments.length > 0 || partialTranscript.length > 0

  const handleMainAction = async (): Promise<void> => {
    if (isListening) {
      await stop()
      return
    }
    await start()
  }

  return (
    <main className="voice-capture">
      <h1>Realtime Conversation Transcription</h1>
      <p className="voice-status">Status: {status}</p>

      <div className="voice-actions">
        <button type="button" onClick={() => void handleMainAction()} disabled={isModelLoading}>
          {isListening ? 'Stop Capture' : 'Start Capture'}
        </button>
        <button type="button" onClick={reset} disabled={!hasAnyTranscript}>
          Clear Transcript
        </button>
      </div>

      {error ? <p className="voice-error">{error}</p> : null}

      <section className="voice-panels">
        <article className="voice-panel">
          <h2>Partial Transcript</h2>
          <p>{partialTranscript || 'Waiting for speech...'}</p>
        </article>

        <article className="voice-panel">
          <h2>Final Transcript Segments</h2>
          {finalSegments.length > 0 ? (
            <ol>
              {finalSegments.map((segment, index) => (
                <li key={`${index}-${segment}`}>{segment}</li>
              ))}
            </ol>
          ) : (
            <p>No final segments yet.</p>
          )}
        </article>

        <article className="voice-panel">
          <h2>Live Transcript</h2>
          <p>{transcript || 'Start capture to begin realtime transcription.'}</p>
        </article>
      </section>
    </main>
  )
}
