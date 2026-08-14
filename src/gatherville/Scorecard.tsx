// The scorecard — the share unit, and the honesty check on the whole product.
//
// Two phases: the user answers the holdout questions, then we reveal what the
// twin predicted. Answering first is not a UI preference — seeing the twin's
// guess first would contaminate the human's answer and the number would stop
// meaning anything.

import { useAction, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';
import { useState } from 'react';

/** Park et al. 2024: agents reached ~85% of the rate at which people predict themselves. */
const PUBLISHED_BENCHMARK = 0.85;

export function Scorecard({ twinId }: { twinId: Id<'twins'> }) {
  const scorecard = useQuery(api.gatherville.interview.scorecard, { twinId });
  const recordAnswer = useAction(api.gatherville.interview.recordUserAnswer);
  const score = useAction(api.gatherville.interview.runScoring);
  const [scoring, setScoring] = useState(false);
  const [scoreError, setScoreError] = useState<string | null>(null);

  if (!scorecard) return <div className="p-8 opacity-60">Loading…</div>;

  const unanswered = scorecard.holdouts.filter((h) => h.userAnswer === undefined);
  const revealed = scorecard.overall !== null;

  // --- answering phase -----------------------------------------------------
  if (!revealed) {
    const current = unanswered[0];
    if (!current) {
      return (
        <div className="mx-auto max-w-xl p-8 text-center">
          <button
            className="rounded bg-white px-6 py-3 font-medium text-black disabled:opacity-40"
            disabled={scoring}
            onClick={async () => {
              setScoring(true);
              setScoreError(null);
              try {
                await score({ twinId });
                // On success the scorecard query flips to the reveal phase;
                // this component unmounts and `scoring` never matters again.
              } catch (e) {
                // Scoring runs one retrieval and one completion per question,
                // and any of them can fail — a missing key, a lapsed provider,
                // the 10-minute action ceiling. Swallowing that left the
                // button reading "Asking…" forever, which is indistinguishable
                // from patience being the answer.
                setScoreError(String((e as Error)?.message ?? e).slice(0, 300));
              } finally {
                setScoring(false);
              }
            }}
          >
            {scoring ? 'Asking…' : 'See how well it knows you'}
          </button>
          <p className="mt-3 text-xs opacity-50">
            {scoring
              ? 'It answers every question with its memories — this can take a few minutes.'
              : 'It answers these now, having never seen yours.'}
          </p>
          {scoreError ? (
            <p className="mt-3 text-xs text-red-400 break-words">{scoreError}</p>
          ) : null}
        </div>
      );
    }

    return (
      <div className="mx-auto max-w-xl p-8">
        <div className="text-xs uppercase tracking-wide opacity-60">
          {scorecard.total - unanswered.length + 1} of {scorecard.total}
        </div>
        <p className="mt-4 text-xl leading-relaxed">{current.question}</p>
        <div className="mt-6 space-y-2">
          {(current.options ?? []).map((option) => (
            <button
              key={option}
              className="block w-full rounded border border-white/20 px-4 py-3 text-left hover:bg-white/5"
              onClick={() => void recordAnswer({ holdoutId: current._id, answer: option })}
            >
              {option}
            </button>
          ))}
        </div>
      </div>
    );
  }

  // --- reveal phase --------------------------------------------------------
  const pct = Math.round((scorecard.overall ?? 0) * 100);
  const domains = Object.entries(scorecard.perDomain).sort((a, b) => b[1] - a[1]);

  return (
    <div className="mx-auto max-w-xl p-8">
      <div className="text-center">
        <div className="text-6xl font-semibold tabular-nums">{pct}%</div>
        <p className="mt-2 text-sm opacity-70">
          It predicted {scorecard.answered} of your answers and got{' '}
          {Math.round((scorecard.overall ?? 0) * scorecard.answered)} right.
        </p>
        {/* Putting a raw score next to the paper's 85% invited a comparison
            that is not valid, and people made it — reasonably. The paper's
            figure is NORMALISED against how consistently people reproduce
            their own answers weeks later, so it is not a percentage correct;
            and it came from a two-hour interview against validated survey
            instruments. Neither holds here. */}
        <p className="mt-2 text-xs leading-relaxed opacity-50">
          Not comparable to the {Math.round(PUBLISHED_BENCHMARK * 100)}% figure you may have seen:
          that one is scaled against how consistently people reproduce their <em>own</em> answers
          weeks later, and comes from a two-hour interview using validated survey questions. This
          is a raw score from a short interview and questions we generated.
        </p>
        {scorecard.answered < 30 && (
          <p className="mt-2 text-xs leading-relaxed opacity-40">
            {scorecard.answered} questions is too few to read much into. At this count the true
            rate could plausibly be anywhere from roughly{' '}
            {Math.max(0, Math.round((pct - 140 / Math.sqrt(scorecard.answered)) ))}% to{' '}
            {Math.min(100, Math.round((pct + 140 / Math.sqrt(scorecard.answered))))}%.
          </p>
        )}
      </div>

      {domains.length > 0 && (
        <div className="mt-8">
          <h3 className="text-xs uppercase tracking-wide opacity-60">Where it knows you</h3>
          <div className="mt-3 space-y-2">
            {domains.map(([domain, rate]) => (
              <div key={domain} className="flex items-center gap-3">
                <span className="w-40 shrink-0 truncate text-sm">{domain}</span>
                <div className="h-1.5 flex-1 rounded bg-white/10">
                  <div className="h-1.5 rounded bg-white/60" style={{ width: `${rate * 100}%` }} />
                </div>
                <span className="w-10 text-right text-xs tabular-nums opacity-70">
                  {Math.round(rate * 100)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-8">
        <h3 className="text-xs uppercase tracking-wide opacity-60">Question by question</h3>
        <div className="mt-3 space-y-3">
          {scorecard.holdouts
            .filter((h) => h.agreed !== undefined)
            .map((h) => (
              <div key={h._id} className="rounded border border-white/10 p-3 text-sm">
                <div className="opacity-80">{h.question}</div>
                <div className="mt-2 flex gap-4 text-xs">
                  <span className="opacity-60">You: {h.userAnswer}</span>
                  <span className={h.agreed ? 'text-green-400' : 'text-amber-400'}>
                    It: {h.twinAnswer}
                  </span>
                </div>
              </div>
            ))}
        </div>
      </div>

      {/* The twin being wrong is more interesting than the twin being right —
          a correction is high-value training data and makes the user feel
          agency rather than judged. */}
      <p className="mt-8 text-center text-xs opacity-50">
        Got something wrong? Correct it in god mode — it learns from that.
      </p>
    </div>
  );
}
