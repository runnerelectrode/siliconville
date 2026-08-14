// Routes the Gatherville surfaces alongside ai-town's game view.
//
// Deliberately not a router dependency — ai-town is a single-page app and this
// is four views. A hash route keeps deep links working (share a scorecard) with
// no new packages and nothing to configure at deploy time.

import { useEffect, useState } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';
import { Interview } from './Interview';
import { Scorecard } from './Scorecard';
import { GodMode } from './GodMode';

type View = { name: 'town' } | { name: 'interview' } | { name: 'scorecard' | 'god'; twinId: string };

function parseHash(): View {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const [name, arg] = hash.split('/');
  if (name === 'interview') return { name: 'interview' };
  if ((name === 'scorecard' || name === 'god') && arg) return { name, twinId: arg };
  return { name: 'town' };
}

export function useHashView() {
  const [view, setView] = useState<View>(parseHash);
  useEffect(() => {
    const onChange = () => setView(parseHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return view;
}

export function navigate(to: string) {
  window.location.hash = to;
}

/** Overlay shown for every view except the town itself. */
export function GathervilleShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[rgb(23,20,33)] text-white">
      <button
        className="fixed right-4 top-4 z-10 rounded border border-white/30 px-3 py-1 text-sm"
        onClick={() => navigate('')}
      >
        ← Town
      </button>
      {children}
    </div>
  );
}

/**
 * A stable per-browser id.
 *
 * Real auth comes later (Clerk is already wired into ai-town, just commented
 * out). Until then this keeps one person's twin attached to one person — using
 * a fixed string would give every visitor the same twin, which for a product
 * built on personal behavioural data is the wrong failure to ship even in dev.
 */
export function useLocalUserId(): string {
  const [userId] = useState(() => {
    const existing = localStorage.getItem('gatherville:userId');
    if (existing) return existing;
    const fresh = `local-${crypto.randomUUID()}`;
    localStorage.setItem('gatherville:userId', fresh);
    return fresh;
  });
  return userId;
}

export function GathervilleRoutes() {
  const view = useHashView();
  const userId = useLocalUserId();
  const twin = useQuery(api.gatherville.twins.byUserId, { userId });

  if (view.name === 'town') {
    return <TownOverlay twinId={twin?._id} hasTwin={!!twin} />;
  }

  if (view.name === 'interview') {
    return (
      <GathervilleShell>
        <Interview userId={userId} onComplete={(twinId) => navigate(`scorecard/${twinId}`)} />
      </GathervilleShell>
    );
  }

  if (view.name === 'scorecard') {
    return (
      <GathervilleShell>
        <Scorecard twinId={view.twinId as Id<'twins'>} />
        <div className="mx-auto max-w-xl px-8 pb-12">
          <button
            className="text-sm underline opacity-70"
            onClick={() => navigate(`god/${view.twinId}`)}
          >
            Open god mode →
          </button>
        </div>
      </GathervilleShell>
    );
  }

  return (
    <GathervilleShell>
      <GodModeLoader twinId={view.twinId as Id<'twins'>} actor={userId} />
    </GathervilleShell>
  );
}

/** God mode needs the twin's world binding, which only exists after attachment. */
function GodModeLoader({ twinId, actor }: { twinId: Id<'twins'>; actor: string }) {
  const twin = useQuery(api.gatherville.twins.byId, { twinId });
  if (!twin) return <div className="p-8 opacity-60">Loading…</div>;
  if (!twin.playerId || !twin.worldId) {
    return (
      <div className="p-8">
        <p className="opacity-70">
          This life hasn't started yet, so there are no decisions to override.
        </p>
        <p className="mt-2 text-sm opacity-50">
          Finish the interview to place it in the town.
        </p>
      </div>
    );
  }
  return (
    <GodMode twinId={twinId} playerId={twin.playerId} worldId={twin.worldId} actor={actor} />
  );
}

/** Small persistent affordance over the town view. */
function TownOverlay({ twinId, hasTwin }: { twinId?: string; hasTwin: boolean }) {
  return (
    // Fixed top-left overlapped the title on narrow screens. Static and centred
    // on phones, floating on desktop where there's room beside the title.
    <div className="pointer-events-auto z-40 flex flex-wrap justify-center gap-2 px-4 pt-3 sm:fixed sm:left-4 sm:top-4 sm:justify-start sm:px-0 sm:pt-0">
      {!hasTwin ? (
        <button
          className="rounded bg-white px-4 py-2 text-sm font-medium text-black shadow-lg"
          onClick={() => navigate('interview')}
        >
          Start your life
        </button>
      ) : (
        <>
          <button
            className="rounded border border-white/40 bg-black/50 px-3 py-2 text-sm text-white"
            onClick={() => navigate(`scorecard/${twinId}`)}
          >
            Scorecard
          </button>
          <button
            className="rounded border border-white/40 bg-black/50 px-3 py-2 text-sm text-white"
            onClick={() => navigate(`god/${twinId}`)}
          >
            God mode
          </button>
        </>
      )}
    </div>
  );
}
