// The city page: the three.js view, the chat rail, and the controls.
//
// Same chrome as the front page: painted background, display title, the
// bordered game-frame with a sidebar, and a footer of buttons. The 3D city
// takes the slot the tile map occupies there.
//
// The frame is deliberately bigger than the front page's. That map is 64x48
// tiles and fits in a 480px band; this one is 256x192 with a downtown, a
// shipyard and a bridge, and at the front page's size you cannot tell a
// district from a car park. Scrolling around is the point, so the viewport
// gets most of the screen.

import { useEffect, useRef, useState } from 'react';
import ReactModal from 'react-modal';
import { useAction, useMutation, useQuery } from 'convex/react';
import Siliconville3D, { type Agent } from './Siliconville3D.tsx';
import { useServerGame } from '../hooks/serverGame.ts';
import Button from '../components/buttons/Button.tsx';
import BackendBoundary from './BackendBoundary.tsx';
import { GoogleSignIn } from '../auth/google.tsx';
import MusicButton from '../components/buttons/MusicButton.tsx';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';
import * as city from '../../data/siliconville3d.js';
import helpImg from '../../assets/help.svg';
import starImg from '../../assets/star.svg';

type Mass = { name: string | null; x: number; y: number; floors: number };

// Read from the generator rather than transcribed. The copy that used to live
// here had already drifted: it filed Cloudflare under FiDI when the generator
// had put it in SOMA.
type District = { name: string; x0: number; y0: number; x1: number; y1: number };
const DISTRICTS = city.districts as District[];

function districtOf(m: Mass) {
  for (const d of DISTRICTS) {
    if (m.x >= d.x0 && m.x < d.x1 && m.y >= d.y0 && m.y < d.y1) return d.name;
  }
  return 'The valley';
}

/**
 * The city chat: humans talking about what they are watching.
 *
 * Separate from the simulation entirely — the agents have their own
 * conversations in the `messages` table, and this is not that. It is one room
 * for whoever has the page open.
 *
 * Identity is a name in localStorage and a random session id. That is not
 * authentication and is not pretending to be: the session id exists so the
 * server can stop someone double-posting, and the name exists so a
 * conversation is followable.
 */
function CityChat() {
  const messages = useQuery(api.siliconville.chat, { limit: 60 });
  const say = useMutation(api.siliconville.say);
  const [draft, setDraft] = useState('');
  const [name, setName] = useState(
    () => localStorage.getItem('sv.name') ?? '',
  );
  const sessionId = useRef(
    localStorage.getItem('sv.session') ??
      Math.random().toString(36).slice(2) + Date.now().toString(36),
  );
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem('sv.session', sessionId.current);
  }, []);
  useEffect(() => {
    // Stick to the bottom as messages arrive; a chat that does not is a chat
    // nobody reads the newest line of.
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages?.length]);

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    const who = name.trim() || 'Anon';
    localStorage.setItem('sv.name', who);
    setName(who);
    setDraft('');
    await say({ name: who, text, sessionId: sessionId.current });
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 overflow-y-auto text-sm leading-relaxed pr-1">
        {messages === undefined ? (
          <p className="opacity-60">Connecting…</p>
        ) : messages.length === 0 ? (
          <p className="opacity-60">
            Nobody has said anything yet. What is happening out there?
          </p>
        ) : (
          messages.map((m) => (
            <div key={m.id} className="mb-2">
              <span className="font-display text-white">{m.name}</span>{' '}
              <span className="opacity-50 text-xs">
                {new Date(m.at).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
              <div className="opacity-85 break-words">{m.text}</div>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>

      <div className="pt-3 mt-2 border-t border-brown-900/60 shrink-0">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="your name"
          maxLength={24}
          className="w-full mb-2 px-2 py-1 text-sm bg-brown-900/60 text-brown-100 outline-none"
        />
        <div className="flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void send();
            }}
            placeholder="say something"
            maxLength={280}
            className="flex-1 px-2 py-1 text-sm bg-brown-900/60 text-brown-100 outline-none"
          />
          <button
            onClick={() => void send()}
            className="px-3 py-1 text-sm font-display bg-brown-900 text-white hover:opacity-80"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Subscribes to the world and writes the residents into a ref the renderer
 * reads each frame.
 *
 * A ref rather than state on purpose: the scene is built once, and putting
 * player positions in React state would re-render this tree on every engine
 * step for no benefit — nothing in the DOM depends on where anyone is
 * standing. It renders nothing itself.
 */
function AgentFeed({ worldId, agentsRef, engineRef }: {
  worldId: Id<'worlds'> | undefined;
  agentsRef: React.MutableRefObject<Agent[]>;
  engineRef: React.MutableRefObject<unknown>;
}) {
  const game = useServerGame(worldId);
  // The engine document carries the server's step timing, which is what the
  // playback clock needs. useServerGame does not expose it; Convex dedupes
  // identical subscriptions, so asking again is close to free.
  const worldState = useQuery(api.world.worldState, worldId ? { worldId } : 'skip');

  useEffect(() => {
    engineRef.current = worldState?.engine;
  }, [worldState, engineRef]);

  useEffect(() => {
    if (!game) {
      agentsRef.current = [];
      return;
    }
    agentsRef.current = [...game.world.players.values()].map((p) => ({
      id: p.id,
      x: p.position.x,
      y: p.position.y,
      dx: p.facing.dx,
      dy: p.facing.dy,
      name: game.playerDescriptions.get(p.id)?.name ?? 'Resident',
      // The sampled path between engine steps. Without this a client only ever
      // sees committed positions, which arrive as jumps.
      history: game.world.historicalLocations?.get(p.id),
    }));
  }, [game, agentsRef]);
  return null;
}

/**
 * The simulation controls, and the only part of this page that needs a
 * backend. Kept separate so it can sit behind an error boundary: the map is a
 * generated, static thing and has no business disappearing because Convex is
 * unreachable.
 */
/**
 * "Follow me" — the over-the-shoulder camera, shown only to someone who has a
 * twin in this city.
 *
 * There is no auth here, so "logged in" means what it can honestly mean: this
 * browser has a userId in localStorage, that userId has a twin, and that twin
 * has been given a body in the world. The same key the interview writes, so
 * finishing the interview is what turns this on.
 */
function FollowControl({ followRef, camYawRef }: {
  followRef: React.MutableRefObject<string | null>;
  camYawRef: React.MutableRefObject<number>;
}) {
  // The SERVER's view of who we are, not the token decoded in the browser.
  // Convex derives identity.subject from the verified JWT, and assuming the
  // client's `sub` matches it would silently look up the wrong twin if the two
  // ever differed. Ask the side that decides.
  const me = useQuery(api.siliconville.me);
  const localId = localStorage.getItem('gatherville:userId') ?? '';
  const claim = useMutation(api.siliconville.claimTwin);

  // On first sign-in, move this browser's twin onto the account. Before this,
  // a twin belonged to a browser: clearing storage orphaned it and it could
  // not follow you to a second device.
  useEffect(() => {
    if (me && localId) void claim({ localUserId: localId });
  }, [me, localId, claim]);

  // Let the server decide which key identifies us — see twins.mine. Choosing
  // here meant a lapsed token silently looked up the wrong one.
  const twin = useQuery(api.gatherville.twins.mine, { localUserId: localId || undefined });
  const [following, setFollowing] = useState(false);
  const playerId = twin?.playerId ?? null;

  // A twin without a body is a placement that failed during onboarding — the
  // city's engine may have been paused with nobody watching it. Visiting the
  // city IS somebody watching, so heal it here. Once per page, not per retry:
  // ensureBody resumes the engine and spawns through the input queue, and
  // hammering it from a render loop would spawn nothing extra but query-spam
  // the world.
  const ensureBody = useAction(api.gatherville.twins.ensureBody);
  const healed = useRef(false);
  useEffect(() => {
    if (twin && !twin.playerId && !healed.current) {
      healed.current = true;
      void ensureBody({ localUserId: localId || undefined }).catch(() => {});
    }
  }, [twin, localId, ensureBody]);

  useEffect(() => {
    // Stop following if the twin loses its body — otherwise the camera sits
    // pointing at a figure that is no longer in the scene.
    if (!playerId && following) {
      setFollowing(false);
      followRef.current = null;
    }
  }, [playerId, following, followRef]);

  if (!playerId) return null;
  return (
    <>
      {following ? <Steering localId={localId} camYawRef={camYawRef} /> : null}
    <Button
      imgUrl={starImg}
      title={following ? 'Back to the city view' : 'Follow your twin'}
      onClick={() => {
        const next = !following;
        setFollowing(next);
        followRef.current = next ? playerId : null;
      }}
    >
      {following ? 'City view' : 'Follow me'}
    </Button>
    </>
  );
}

/**
 * Walk your resident: keyboard, or the on-screen pad.
 *
 * Sends a DIRECTION, not a destination, so the browser never needs to know
 * where the figure is — nothing to sync, nothing to reconcile. A four-tile hop
 * resolves inside the engine's ~1s commit, so held input reads as continuous
 * walking with no client-side prediction.
 *
 * Steps IMMEDIATELY on press, then repeats while held. The first version only
 * sent on the repeat interval, so a tap — press and release inside 900ms —
 * added the key and removed it before the timer ever fired, and nothing moved.
 * Anything short of holding a key looked completely dead.
 */
function Steering({ localId, camYawRef }: {
  localId: string;
  camYawRef: React.MutableRefObject<number>;
}) {
  const steer = useMutation(api.siliconville.steer);
  const held = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The last steer's engine input, watched so the ENGINE's verdict reaches the
  // label. `moved: true` from the mutation only means "queued": the handler can
  // still refuse a tick later (in a conversation, nowhere walkable), and that
  // used to die in the backend logs while every press looked accepted.
  const [lastInputId, setLastInputId] = useState<Id<'inputs'> | null>(null);
  const verdict = useQuery(
    api.aiTown.main.inputStatus,
    lastInputId ? { inputId: lastInputId } : 'skip',
  );
  const engineProblem = verdict
    ? verdict.kind === 'error'
      ? String(verdict.message).slice(0, 80)
      : typeof verdict.value === 'string' && verdict.value !== 'ok'
        ? verdict.value
        : null
    : null;

  // Kept in refs so the key handlers, registered once, never call a stale copy.
  const send = useRef((dx: number, dy: number, tiles?: number) => {});
  const halt = useRef(() => {});
  const lastVec = useRef<readonly [number, number]>([0, 0]);
  halt.current = () => {
    void steer({ dx: 0, dy: 1, localUserId: localId || undefined, stop: true }).catch(() => {});
  };
  send.current = (dx, dy, tiles = 24) => {
    if (!dx && !dy) return;
    lastVec.current = [dx, dy];
    steer({ dx, dy, localUserId: localId || undefined, tiles })
      .then((r) => {
        // The mutation reports refusals as data rather than throwing, so
        // without this a twin with no body just silently ignores every press.
        setProblem(r && !r.moved ? (r as { reason?: string }).reason ?? 'cannot move' : null);
        setLastInputId((r as { inputId?: Id<'inputs'> })?.inputId ?? null);
      })
      .catch((e) => setProblem(String(e?.message ?? e).slice(0, 80)));
  };

  /**
   * Pressed direction, rotated into world space by the camera.
   *
   * This used to send the raw press: up meant NORTH ON THE MAP. But the follow
   * camera sits behind the figure and swings round as it turns, so "north" is
   * whatever direction the view happens to be facing away from — press up and
   * the figure walks left, or straight at the camera. It moved every time; it
   * just never went where you pressed, which is indistinguishable from broken.
   *
   * The renderer publishes its yaw so the press can be interpreted against the
   * frame the person is actually looking through. Forward is (sin y, cos y)
   * because person() faces +Z and tile Y maps to world Z.
   */
  const vector = () => {
    let fwd = 0;
    let strafe = 0;
    for (const k of held.current) {
      if (k === 'up') fwd += 1;
      else if (k === 'down') fwd -= 1;
      else if (k === 'left') strafe -= 1;
      else if (k === 'right') strafe += 1;
    }
    if (!fwd && !strafe) return [0, 0] as const;

    const yaw = camYawRef.current;
    // Not following, or no frame yet: fall back to map-aligned, which is at
    // least predictable rather than arbitrary.
    if (!Number.isFinite(yaw)) return [strafe, -fwd] as const;

    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    // Screen-right is forward × up = (-cos, sin) in tile space, not (cos, -sin):
    // the first version used the latter and left/right came out mirrored.
    return [fwd * sin - strafe * cos, fwd * cos + strafe * sin] as const;
  };

  // When the current gesture began — a press with nothing else held starts it.
  const gestureStart = useRef(0);

  const press = (dir: string) => {
    if (!held.current.size) gestureStart.current = performance.now();
    held.current.add(dir);
    const [dx, dy] = vector();
    send.current(dx, dy);
    if (timer.current === null) {
      // Refresh while held — rarely, and this interval is load-bearing.
      //
      // Each send calls movePlayer, which throws the route away and marks
      // `needsPath`; the engine recomputes it a tick later. Refreshing every
      // 2s meant the figure spent most of its life re-planning instead of
      // walking and managed 0.32 tiles/s — slower than the NPC amble it was
      // meant to beat. A single steer with no refreshes covers 20 tiles in 5s.
      //
      // So: refresh just before the 5s lease lapses, not continuously. The
      // 24-tile lead is what keeps it walking in between.
      timer.current = setInterval(() => {
        const [rx, ry] = vector();
        if (!rx && !ry) return;
        send.current(rx, ry);
      }, 3_800);
    }
  };
  const release = (dir: string) => {
    held.current.delete(dir);
    if (held.current.size) {
      // Still holding something else — re-aim immediately rather than waiting
      // for the next tick, so releasing one key of a diagonal responds at once.
      const [rx, ry] = vector();
      send.current(rx, ry);
      return;
    }
    if (timer.current !== null) {
      clearInterval(timer.current);
      timer.current = null;
    }
    // A tap steps, a hold walks-then-halts. Halting on EVERY release re-broke
    // taps one layer deeper than the bug f8f1810 fixed: press sent a move,
    // release sent a stop ~150ms behind it, and the engine walked the figure
    // ~0.3 tiles before the halt landed — invisible on screen. A pad click is
    // always a tap, so clicking the arrows did nothing at all.
    const quick = performance.now() - gestureStart.current < 350;
    const [lx, ly] = lastVec.current;
    if (quick && (lx || ly)) {
      // Re-aim the route at 2 tiles instead of 24: a visible step, then done.
      send.current(lx, ly, 2);
    } else {
      halt.current();
    }
  };
  const releaseAll = () => {
    const wasMoving = held.current.size > 0;
    held.current.clear();
    if (timer.current !== null) {
      clearInterval(timer.current);
      timer.current = null;
    }
    if (wasMoving) halt.current();
  };

  useEffect(() => {
    const KEYS: Record<string, string> = {
      w: 'up', arrowup: 'up',
      s: 'down', arrowdown: 'down',
      a: 'left', arrowleft: 'left',
      d: 'right', arrowright: 'right',
    };
    const typing = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      // The city chat is on this page — don't walk while someone types "sad".
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      const dir = KEYS[e.key.toLowerCase()];
      if (!dir || typing(e)) return;
      e.preventDefault();
      // Ignore OS key-repeat: walking speed should not depend on someone's
      // keyboard settings.
      if (e.repeat) return;
      press(dir);
    };
    const up = (e: KeyboardEvent) => {
      const dir = KEYS[e.key.toLowerCase()];
      if (dir) release(dir);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    // Keys held when the tab loses focus never fire keyup, and the figure would
    // keep walking on its own.
    window.addEventListener('blur', releaseAll);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', releaseAll);
      releaseAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Touch pad. Phones have no arrow keys, so without this the feature simply
  // does not exist on a phone. onPointer* covers touch, pen and mouse alike.
  const Pad = ({ dir, glyph, cls }: { dir: string; glyph: string; cls: string }) => (
    <button
      className={`${cls} h-10 w-10 rounded bg-black/50 text-white/90 text-lg leading-none
                  ring-1 ring-white/25 active:bg-white/25 pointer-events-auto select-none`}
      aria-label={dir}
      onPointerDown={(e) => {
        e.preventDefault();
        press(dir);
      }}
      onPointerUp={() => release(dir)}
      onPointerLeave={() => release(dir)}
      onPointerCancel={() => release(dir)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {glyph}
    </button>
  );

  return (
    // Fixed over the map, not inline in the footer.
    //
    // A three-row cross is ~130px tall and the footer row is ~56px, so the
    // bottom button fell off the viewport — measured at y=776+40 in an 800px
    // window, which is exactly the clipped pad in the report. Floating it also
    // puts it where a thumb already is on a phone.
    <div className="fixed bottom-28 right-5 z-40 flex flex-col items-center gap-1 pointer-events-none">
      <div className="grid grid-cols-3 grid-rows-3 gap-1" style={{ touchAction: 'none' }}>
        <Pad dir="up" glyph="↑" cls="col-start-2 row-start-1" />
        <Pad dir="left" glyph="←" cls="col-start-1 row-start-2" />
        <Pad dir="right" glyph="→" cls="col-start-3 row-start-2" />
        <Pad dir="down" glyph="↓" cls="col-start-2 row-start-3" />
      </div>
      <span className="text-[10px] text-white/70 bg-black/50 px-1.5 py-0.5 rounded pointer-events-none">
        {problem ?? engineProblem ?? 'arrows / WASD'}
      </span>
    </div>
  );
}

function SimControls({ agentsRef, engineRef, followRef, camYawRef }: {
  agentsRef: React.MutableRefObject<Agent[]>;
  engineRef: React.MutableRefObject<unknown>;
  followRef: React.MutableRefObject<string | null>;
  camYawRef: React.MutableRefObject<number>;
}) {
  // The city runs in its OWN Convex world, not the front page's — see
  // convex/siliconville.ts. Null until someone starts it, which is why the
  // button says Start rather than Freeze on first load.
  const world = useQuery(api.siliconville.status);
  const start = useMutation(api.siliconville.init);
  const setRunning = useMutation(api.siliconville.setRunning);
  const heartbeat = useMutation(api.siliconville.heartbeat);
  const running = world?.status === 'running';

  // Ping only while someone is ACTUALLY looking at it.
  //
  // This fired every 30s for as long as the tab existed — backgrounded, on a
  // second monitor, forgotten overnight. Since heartbeat also resumes a paused
  // engine, that meant the city could never stay stopped while any tab was
  // open anywhere, and the engine writes the whole world document once a
  // second (game.ts stepDuration = 1000). A laptop left open was ~86k writes a
  // day for a city nobody was watching, plus the same volume pushed back out
  // to every subscribed tab. That is what exhausted the plan, not the number
  // of residents — one agent shrank each write and left the rate untouched.
  //
  // Visibility is the honest signal for "someone is looking", and the interval
  // is 60s to match WORLD_HEARTBEAT_INTERVAL rather than double it.
  useEffect(() => {
    if (!world) return;
    const ping = () => {
      if (document.visibilityState === 'visible') void heartbeat({});
    };
    ping();
    const id = setInterval(ping, 60_000);
    // Ping on return too, so coming back to the tab wakes the city at once
    // instead of up to a minute later.
    document.addEventListener('visibilitychange', ping);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', ping);
    };
  }, [world, heartbeat]);

  return (
    <>
      <AgentFeed worldId={world?.worldId} agentsRef={agentsRef} engineRef={engineRef} />
      {!world ? (
        <Button
          imgUrl={starImg}
          title="Create the Siliconville world"
          onClick={() => void start({})}
        >
          Start the city
        </Button>
      ) : (
        <Button
          imgUrl={starImg}
          title={running ? 'Pause the simulation' : 'Resume the simulation'}
          onClick={() => void setRunning({ running: !running })}
        >
          {running ? 'Freeze' : 'Unfreeze'}
        </Button>
      )}
      <FollowControl followRef={followRef} camYawRef={camYawRef} />
      <MusicButton />
    </>
  );
}

/** Population, bottom-right. It is a readout, not a control. */
function ResidentCount() {
  const world = useQuery(api.siliconville.status);
  if (!world) return null;
  return (
    <span className="text-white/70 text-sm self-center pointer-events-none">
      {world.agents} residents
    </span>
  );
}

export default function SiliconvilleShell() {
  const [tab, setTab] = useState<'chat' | 'about'>('chat');
  const [help, setHelp] = useState(false);
  // Shared between the subscription and the renderer; see AgentFeed.
  const agentsRef = useRef<Agent[]>([]);
  const engineRef = useRef<unknown>(undefined);
  // playerId of the twin the camera is riding, or null for the city view.
  const followRef = useRef<string | null>(null);
  const camYawRef = useRef<number>(NaN);


  return (
    <main className="relative flex min-h-screen flex-col items-center justify-between font-body siliconville-background">
      {/* The page promises a digital identity of yourself; this is the only
          thing on it that delivers one, so it goes top-left where the front
          page keeps it rather than buried in the footer with the sim controls. */}
      <a
        href="/gatherville#interview"
        className="button text-white shadow-solid text-xl pointer-events-auto absolute top-4 left-4 z-10"
      >
        <div className="inline-block bg-clay-700">
          <span>
            <div className="inline-flex h-full items-center gap-4">Start your life</div>
          </span>
        </div>
      </a>

      <div className="absolute top-4 right-4 z-10">
        <GoogleSignIn />
      </div>

      <div className="w-full lg:h-screen min-h-screen relative isolate overflow-hidden lg:p-6 shadow-2xl flex flex-col justify-start">
        <h1 className="mx-auto text-4xl p-2 sm:text-7xl lg:text-8xl font-bold font-display leading-none tracking-wide game-title w-full text-left sm:text-center sm:w-auto">
          Siliconville
        </h1>

        <div className="max-w-xs md:max-w-xl lg:max-w-none mx-auto my-2 text-center text-base sm:text-lg md:text-xl text-white leading-tight shadow-solid">
          Join and create an AI town for synthetic humans.
        </div>

        {/* min-h-[68vh] rather than the front page's 480px: this map is four
            times the area and needs the room to be worth scrolling. */}
        <div className="mx-auto w-full grid grid-rows-[minmax(0,1fr)_auto] lg:grid-rows-[1fr] lg:grid-cols-[1fr_auto] lg:grow max-w-[1800px] min-h-[68vh] game-frame">
          <div className="relative overflow-hidden bg-[#0f1116]">
            <Siliconville3D
              chrome={false}
              agentsRef={agentsRef}
              engineRef={engineRef}
              followRef={followRef}
              camYawRef={camYawRef}
            />
          </div>

          <div className="flex flex-col overflow-y-auto shrink-0 px-4 py-5 sm:px-6 lg:w-80 xl:pr-6 border-t-8 sm:border-t-0 sm:border-l-8 border-brown-900 bg-brown-800 text-brown-100">
            <div className="flex gap-2 mb-4">
              {(['chat', 'about'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-3 py-1 text-sm font-display tracking-wide ${
                    tab === t ? 'bg-brown-900 text-white' : 'opacity-60 hover:opacity-100'
                  }`}
                >
                  {t === 'chat' ? 'City chat' : 'About'}
                </button>
              ))}
            </div>

            {tab === 'chat' ? (
              <CityChat />
            ) : (
              <div className="text-sm leading-relaxed opacity-85">
                <p>
                  Procedural geometry — every building, road and tree is generated from a plan, not
                  modelled by hand. The words are buildings: their footprints are the letterforms.
                </p>
                <p className="mt-3">
                  Brand marks come from the open-source simple-icons set. Trademarks belong to their
                  owners; this is an homage, not an official map.
                </p>
                <p className="mt-3">
                  The simulation runs on the ai-town engine, walking the same tile grid this view
                  is generated from — so where a resident stands in the simulation is where it
                  stands here. Buildings carry doors and rooms, so there is somewhere to walk to.
                </p>
                <p className="mt-3">
                  Residents come only from completed interviews. Nothing seeds the city with
                  invented people, because a city of invented people looks exactly like a city of
                  real ones — and that resemblance is what would make the accuracy score
                  meaningless.
                </p>
                <p className="mt-3">
                  <a className="underline" href="/2d">
                    2D tile version
                  </a>
                </p>
              </div>
            )}
          </div>
        </div>

        <footer className="justify-end bottom-0 left-0 w-full flex items-center mt-3 gap-3 px-6 pb-4 flex-wrap pointer-events-none">
          <div className="flex gap-4 flex-grow pointer-events-none items-center">
            <BackendBoundary>
              <SimControls agentsRef={agentsRef} engineRef={engineRef} followRef={followRef} camYawRef={camYawRef} />
            </BackendBoundary>
            <Button imgUrl={helpImg} onClick={() => setHelp(true)}>
              How to join
            </Button>
          </div>
          {/* Bottom-right, away from the buttons: a number you glance at, not
              something you press. */}
          <BackendBoundary fallback={null}>
            <ResidentCount />
          </BackendBoundary>
          {/* Tile counts and tenant totals were build stats, not information
              anyone visiting needs — and the resident count, which does matter,
              already sits with the controls. */}
        </footer>

        <ReactModal
          isOpen={help}
          onRequestClose={() => setHelp(false)}
          style={modalStyles}
          contentLabel="Siliconville"
          ariaHideApp={false}
        >
          <div className="font-body">
            <h1 className="text-center text-4xl font-bold font-display game-title">Siliconville</h1>
            <p className="mt-4">
              A generated Silicon Valley: five districts, a downtown, a shipyard and a bridge, with
              the words built out of the buildings themselves.
            </p>
            <p className="mt-4">
              <b>Everyone here is somebody.</b> The city creates no residents of its own — there are
              no stock characters wandering about. A resident exists only where a real person
              finished the interview, so an empty city means nobody has joined yet, not that
              something is broken.
            </p>
            <p className="mt-4">
              <b>To join:</b> press <i>Start your life</i>. You will be asked about your recent days
              and the choices you actually make — about seven minutes. Your answers become a
              resident that walks the city, remembers, and decides for itself.
            </p>
            <p className="mt-4">
              Then it takes a set of questions it has never seen and answers them as you, and you
              find out how close it got. That score is the point of the whole thing: a simulated
              person is easy to make believable and hard to make accurate.
            </p>
            <p className="mt-4">
              Once you have one, <i>Follow me</i> puts the camera over its shoulder and the arrow
              keys, WASD, or the on-screen pad walk it around. Let go and it goes back to its own
              plans.
            </p>
            <p className="mt-4 opacity-70">
              Brand marks are from the open-source simple-icons set; trademarks belong to their
              owners. This is an homage, not an official map.
            </p>
          </div>
        </ReactModal>
      </div>
    </main>
  );
}

const modalStyles = {
  overlay: { backgroundColor: 'rgb(0, 0, 0, 75%)', zIndex: 12 },
  content: {
    top: '50%',
    left: '50%',
    right: 'auto',
    bottom: 'auto',
    marginRight: '-50%',
    transform: 'translate(-50%, -50%)',
    maxWidth: '50rem',
    border: '10px solid rgb(23, 20, 33)',
    borderRadius: '0',
    background: 'rgb(35, 38, 58)',
    color: 'white',
    fontFamily: '"Upheaval Pro", "sans-serif"',
  },
};
