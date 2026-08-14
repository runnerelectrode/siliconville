export const ACTION_TIMEOUT = 120_000; // more time for local dev
// export const ACTION_TIMEOUT = 60_000;// normally fine

export const IDLE_WORLD_TIMEOUT = 5 * 60 * 1000;
export const WORLD_HEARTBEAT_INTERVAL = 60 * 1000;

export const MAX_STEP = 10 * 60 * 1000;
export const TICK = 16;
export const STEP_INTERVAL = 1000;

export const PATHFINDING_TIMEOUT = 60 * 1000;
export const PATHFINDING_BACKOFF = 1000;
export const CONVERSATION_DISTANCE = 1.3;
export const MIDPOINT_THRESHOLD = 4;
export const TYPING_TIMEOUT = 15 * 1000;
export const COLLISION_THRESHOLD = 0.75;

// How many human players can be in a world at once.
export const MAX_HUMAN_PLAYERS = 8;

// Don't talk to anyone for 15s after having a conversation.
// Was 15s. With 72 residents on one map, a 15-second cooldown means an agent
// finishes talking, walks a few tiles, and is immediately in another
// conversation. Measured on the live world: 36 conversations, 72 of 72
// participants, 0 of 72 with a path. Nobody was walking anywhere, which is
// what "they don't move / it doesn't feel like free will" actually was.
export const CONVERSATION_COOLDOWN = 180_000;

// Don't do another activity for 10s after doing one.
export const ACTIVITY_COOLDOWN = 10_000;

// Don't talk to a player within 60s of talking to them.
// Before the same PAIR talk again. Raised so a crowd does not re-pair
// endlessly with its nearest neighbour.
export const PLAYER_CONVERSATION_COOLDOWN = 300_000;

// Invite 80% of invites that come from other agents.
// Was 0.8, which at this density means almost every meeting becomes a
// conversation. Declining is a decision too — an agent that sometimes walks
// past someone looks far more like it has its own agenda than one that stops
// for everybody.
// 0.3 was still too high. Measured after that change: 20 residents, 10
// conversations, 0 walking — everybody paired, again. Pairing is pairwise, so
// the chance of a given agent being free falls off much faster than the
// probability suggests, and the city's default state has to be WALKING with
// conversation as the exception, not the reverse.
export const INVITE_ACCEPT_PROBABILITY = 0.12;

// Wait for 1m for invites to be accepted.
export const INVITE_TIMEOUT = 60000;

// Wait for another player to say something before jumping in.
// Back to upstream's 20s. The 60s override was for watching a handful of
// agents talk on a small map; here it just pins people in place.
export const AWKWARD_CONVERSATION_TIMEOUT = 20_000;

// Leave a conversation after participating too long.
// Back to upstream's 2 minutes. TEN minutes was the single biggest cause of
// a motionless city: a conversation that long means each participant is
// standing still for a tenth of an hour, and with everyone paired that is
// the whole population.
export const MAX_CONVERSATION_DURATION = 2 * 60_000;

// Leave a conversation if it has more than 8 messages;
// Fewer turns per conversation: shorter exchanges, more walking between
// them, and materially fewer LLM calls per agent-hour.
export const MAX_CONVERSATION_MESSAGES = 5;

// Wait for 1s after sending an input to the engine. We can remove this
// once we can await on an input being processed.
export const INPUT_DELAY = 1000;

// How many memories to get from the agent's memory.
// This is over-fetched by 10x so we can prioritize memories by more than relevance.
export const NUM_MEMORIES_TO_SEARCH = 3;

// Wait for at least two seconds before sending another message.
export const MESSAGE_COOLDOWN = 2000;

// Don't run a turn of the agent more than once a second.
export const AGENT_WAKEUP_THRESHOLD = 1000;

// How old we let memories be before we vacuum them
export const VACUUM_MAX_AGE = 2 * 7 * 24 * 60 * 60 * 1000;
export const DELETE_BATCH_SIZE = 64;

export const HUMAN_IDLE_TOO_LONG = 5 * 60 * 1000;

export const ACTIVITIES = [
  { description: 'reading a book', emoji: '📖', duration: 60_000 },
  { description: 'daydreaming', emoji: '🤔', duration: 60_000 },
  { description: 'gardening', emoji: '🥕', duration: 60_000 },
];

export const ENGINE_ACTION_DURATION = 30000;

// Bound the number of pathfinding searches we do per game step.
export const MAX_PATHFINDS_PER_STEP = 16;

export const DEFAULT_NAME = 'Me';
