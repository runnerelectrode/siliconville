// God mode — intervene in a running life.
//
// This looks like a debug console and is really a data-collection instrument.
// Every override produces a (decision, intervention) pair in identical context,
// which is exactly a (rejected, chosen) preference pair. The UI therefore has
// one job beyond being usable: make it obvious WHICH decision is being
// overridden, because an intervention that doesn't link to a decision is a
// puppet-string pull with no training value.

import { useAction, useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { Doc, Id } from '../../convex/_generated/dataModel';
import { useState } from 'react';

export function GodMode({
  twinId,
  playerId,
  worldId,
  actor,
}: {
  twinId: Id<'twins'>;
  playerId: string;
  worldId: Id<'worlds'>;
  actor: string;
}) {
  const decisions = useQuery(api.gatherville.godmode.recentDecisions, { twinId, limit: 20 });
  const spend = useQuery(api.gatherville.traces.spendByTwin, {
    twinId,
    since: Date.now() - 24 * 60 * 60 * 1000,
  });
  const attach = useMutation(api.gatherville.cadence.attachWatcher);
  const detach = useMutation(api.gatherville.cadence.detachWatcher);

  const [selected, setSelected] = useState<Doc<'traces'> | null>(null);

  if (!decisions) return <div className="p-6 opacity-60">Loading…</div>;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-white/10 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide">God mode</h2>
        {spend && (
          <div className="ml-auto flex gap-4 text-xs tabular-nums opacity-70">
            <span>{spend.decisions} decisions / 24h</span>
            <span>${(spend.costMicros / 1_000_000).toFixed(4)}</span>
            {/* The number that says whether the caching design is holding. Near
                zero means the prefix is churning and 24/7 costs ~4x plan. */}
            <span className={spend.cacheHitRate < 0.5 ? 'text-amber-400' : 'text-green-400'}>
              cache {Math.round(spend.cacheHitRate * 100)}%
            </span>
          </div>
        )}
        {/* Deliberately not "10s". The cadence tier is a ceiling; the engine's
            own pacing (~88s measured — a 60s activity plus walking) is the
            binding constraint at every fast tier, so `observed` has never
            actually throttled anything. What watching really does is wake a
            slowed life immediately instead of making it wait out its interval.
            See cadence.ts. */}
        <button
          className="rounded border border-white/30 px-3 py-1 text-xs"
          onMouseEnter={() => void attach({ twinId })}
          onMouseLeave={() => void detach({ twinId })}
          title="Wakes it up now, and keeps it at full speed while you watch"
        >
          Watch (wakes it up)
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="w-1/2 overflow-y-auto border-r border-white/10">
          {decisions.length === 0 && (
            <p className="p-4 text-sm opacity-60">
              No decisions yet. When nobody is watching it slows to a decision every 15 minutes —
              hover “Watch” to wake it up now.
            </p>
          )}
          {decisions.map((d) => (
            <DecisionRow
              key={d._id}
              decision={d}
              selected={selected?._id === d._id}
              onSelect={() => setSelected(d)}
            />
          ))}
        </div>

        <div className="w-1/2 overflow-y-auto">
          {selected ? (
            <OverridePanel
              decision={selected}
              twinId={twinId}
              playerId={playerId}
              worldId={worldId}
              actor={actor}
              onDone={() => setSelected(null)}
            />
          ) : (
            <p className="p-4 text-sm opacity-60">Pick a decision to override it.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function DecisionRow({
  decision,
  selected,
  onSelect,
}: {
  decision: Doc<'traces'>;
  selected: boolean;
  onSelect: () => void;
}) {
  const override = useQuery(api.gatherville.godmode.overrideFor, { traceId: decision._id });
  return (
    <button
      onClick={onSelect}
      className={`block w-full border-b border-white/5 p-3 text-left hover:bg-white/5 ${
        selected ? 'bg-white/10' : ''
      }`}
    >
      <div className="flex items-center gap-2 text-xs opacity-50">
        <span>{new Date(decision.ts).toLocaleTimeString()}</span>
        <span>{decision.model?.replace('claude-', '')}</span>
        {override && <span className="text-amber-400">overridden</span>}
      </div>
      <div className="mt-1 text-sm">{decision.action}</div>
      <div className="mt-1 line-clamp-2 text-xs opacity-60">{decision.observation}</div>
    </button>
  );
}

function OverridePanel({
  decision,
  twinId,
  playerId,
  worldId,
  actor,
  onDone,
}: {
  decision: Doc<'traces'>;
  twinId: Id<'twins'>;
  playerId: string;
  worldId: Id<'worlds'>;
  actor: string;
  onDone: () => void;
}) {
  const overrideDecision = useAction(api.gatherville.godmode.overrideDecision);
  const [choice, setChoice] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!choice.trim()) return;
    setSaving(true);
    await overrideDecision({
      twinId,
      playerId,
      worldId,
      overridesTraceId: decision._id,
      action: choice.trim(),
      note: note.trim() || undefined,
      actor,
    });
    setSaving(false);
    onDone();
  };

  return (
    <div className="p-4">
      <h3 className="text-xs uppercase tracking-wide opacity-60">Situation</h3>
      <p className="mt-1 text-sm">{decision.observation}</p>

      <h3 className="mt-4 text-xs uppercase tracking-wide opacity-60">It chose</h3>
      <p className="mt-1 text-sm">{decision.action}</p>
      {decision.rationale && <p className="mt-1 text-xs italic opacity-60">{decision.rationale}</p>}

      <h3 className="mt-4 text-xs uppercase tracking-wide opacity-60">It should have</h3>
      {decision.candidates?.length ? (
        <div className="mt-2 space-y-1">
          {decision.candidates.map((c) => (
            <button
              key={c}
              onClick={() => setChoice(c)}
              className={`block w-full rounded border px-3 py-2 text-left text-sm ${
                choice === c ? 'border-white bg-white/10' : 'border-white/20'
              } ${c === decision.action ? 'opacity-40' : ''}`}
            >
              {c}
              {c === decision.action && <span className="ml-2 text-xs">(what it chose)</span>}
            </button>
          ))}
        </div>
      ) : (
        <input
          className="mt-2 w-full rounded border border-white/20 bg-transparent px-3 py-2 text-sm"
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          placeholder="What it should have done"
        />
      )}

      <textarea
        className="mt-3 w-full rounded border border-white/20 bg-transparent px-3 py-2 text-sm"
        rows={3}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Why? (optional — becomes a memory it keeps)"
      />

      <button
        className="mt-3 rounded bg-white px-4 py-2 text-sm font-medium text-black disabled:opacity-40"
        disabled={!choice.trim() || saving || choice === decision.action}
        onClick={() => void submit()}
      >
        {saving ? 'Saving…' : 'Override'}
      </button>
      {choice === decision.action && (
        <p className="mt-2 text-xs opacity-50">
          That's what it already chose — agreeing isn't a preference signal, so it isn't recorded.
        </p>
      )}
    </div>
  );
}
