// The 7-minute interview.
//
// Voice-first by design: the memory stream is fed on narrative, and speech
// yields episodes where a form yields traits. A twin built from traits can only
// restate them; a twin built from episodes can act. Text input exists as a
// fallback, not as the intended path.

import { useAction } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { useCallback, useEffect, useRef, useState } from 'react';

const PHASES = [
  { id: 'grounding', label: 'Getting oriented', seconds: 60 },
  { id: 'episodes', label: 'Recent moments', seconds: 180 },
  { id: 'tensions', label: 'The gaps', seconds: 120 },
  { id: 'holdout-setup', label: 'What people misjudge', seconds: 60 },
] as const;

type Turn = { speaker: 'interviewer' | 'you'; text: string };

export function Interview({ userId, onComplete }: { userId: string; onComplete: (twinId: string) => void }) {
  const [phaseIdx, setPhaseIdx] = useState(0);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [building, setBuilding] = useState(false);
  const [listening, setListening] = useState(false);

  const nextQuestion = useAction(api.gatherville.interview.nextQuestion);
  const buildTwin = useAction(api.gatherville.interview.buildFromTranscript);
  const recognitionRef = useRef<any>(null);

  const phase = PHASES[phaseIdx];
  const transcript = turns.map((t) => `[${t.speaker}]: ${t.text}`).join('\n');

  // --- question flow -------------------------------------------------------

  const askNext = useCallback(
    async (phaseId: string, soFar: string) => {
      setQuestion(null);
      const { question } = await nextQuestion({ phaseId, transcriptSoFar: soFar });
      setQuestion(question);
      setTurns((t) => [...t, { speaker: 'interviewer', text: question }]);
    },
    [nextQuestion],
  );

  useEffect(() => {
    void askNext(phase.id, transcript);
    // Intentionally keyed on phase only — re-asking on every transcript change
    // would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phaseIdx]);

  useEffect(() => {
    const timer = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  // Advance on time, not on a fixed question count — a talkative person should
  // get more depth, not be cut off mid-thought at question three.
  useEffect(() => {
    const budget = PHASES.slice(0, phaseIdx + 1).reduce((sum, p) => sum + p.seconds, 0);
    if (elapsed > budget && phaseIdx < PHASES.length - 1) setPhaseIdx((i) => i + 1);
  }, [elapsed, phaseIdx]);

  // --- speech --------------------------------------------------------------

  const startListening = useCallback(() => {
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SR) return; // text fallback stays available
    const recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event: any) => {
      let text = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        text += event.results[i][0].transcript;
      }
      setAnswer((prev) => (event.results[event.resultIndex].isFinal ? prev + text : prev));
    };
    recognition.onend = () => setListening(false);
    recognition.start();
    recognitionRef.current = recognition;
    setListening(true);
  }, []);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
  }, []);

  // --- submit --------------------------------------------------------------

  const submitAnswer = async () => {
    if (!answer.trim()) return;
    stopListening();
    const updated: Turn[] = [...turns, { speaker: 'you', text: answer.trim() }];
    setTurns(updated);
    setAnswer('');
    await askNext(phase.id, updated.map((t) => `[${t.speaker}]: ${t.text}`).join('\n'));
  };

  const finish = async () => {
    stopListening();
    setBuilding(true);
    const { twinId } = await buildTwin({ userId, transcript });
    onComplete(twinId);
  };

  const totalSeconds = PHASES.reduce((s, p) => s + p.seconds, 0);
  const progress = Math.min(100, (elapsed / totalSeconds) * 100);
  const answeredCount = turns.filter((t) => t.speaker === 'you').length;

  if (building) {
    return (
      <div className="mx-auto max-w-xl p-8 text-center">
        <h2 className="text-2xl font-semibold">Starting your life…</h2>
        <p className="mt-2 text-sm opacity-70">
          Reading the transcript, pulling out what's specific, and working out what it implies.
          About a minute.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="mb-6">
        <div className="flex justify-between text-xs uppercase tracking-wide opacity-60">
          <span>{phase.label}</span>
          <span>
            {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')} / 7:00
          </span>
        </div>
        <div className="mt-2 h-1 w-full rounded bg-white/10">
          <div className="h-1 rounded bg-white/60 transition-all" style={{ width: `${progress}%` }} />
        </div>
      </div>

      <div className="min-h-[6rem]">
        {question ? (
          <p className="text-xl leading-relaxed">{question}</p>
        ) : (
          <p className="text-xl opacity-40">…</p>
        )}
      </div>

      <textarea
        className="mt-6 w-full rounded border border-white/20 bg-transparent p-3 text-base"
        rows={4}
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        placeholder={listening ? 'Listening…' : 'Speak, or type here'}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submitAnswer();
        }}
      />

      <div className="mt-3 flex items-center gap-3">
        <button
          className="rounded border border-white/30 px-4 py-2 text-sm"
          onClick={listening ? stopListening : startListening}
        >
          {listening ? 'Stop' : 'Speak'}
        </button>
        <button
          className="rounded bg-white px-4 py-2 text-sm font-medium text-black disabled:opacity-40"
          onClick={() => void submitAnswer()}
          disabled={!answer.trim()}
        >
          Next
        </button>
        <span className="ml-auto text-xs opacity-50">⌘↵ to send</span>
      </div>

      {/* Guard against building a twin from almost nothing — cold-start
          retrieval is degenerate below a handful of distinct memories, and a
          twin built on three answers will score badly and read as a horoscope. */}
      {answeredCount >= 6 && (
        <button className="mt-8 text-sm underline opacity-70" onClick={() => void finish()}>
          I'm done — start my life
        </button>
      )}
    </div>
  );
}
