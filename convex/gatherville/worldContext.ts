// The shared world block: what is in this cafe, and what you can do there.
//
// Two jobs, in this order of importance:
//
// 1. CORRECTNESS. Free-form actions were generated with no knowledge of the
//    world, so a twin could decide to "grab a tray from the salad bar" in a
//    cafe that has no salad bar. Telling the model what actually exists is the
//    fix; nothing else was ever going to fix it.
//
// 2. CACHING. This text is byte-identical for every twin and every decision, so
//    it is the ideal cached block.
//
// Worth stating plainly, because it inverts the usual reasoning: caching does
// NOT pay for itself here. It only saves money on tokens you were going to send
// anyway. Padding a prefix up to Haiku 4.5's 4096-token minimum purely to
// enable caching costs MORE than sending a short uncached prompt — measured, at
// ambient cadence, $0.0118/hr against $0.0044/hr. What caching does is make
// this richer context ~37% cheaper than it would otherwise be ($0.0118 against
// $0.0188). The context has to earn its place on behaviour; caching is the
// discount, not the reason.

import type { Doc } from '../_generated/dataModel';

export type Zone = {
  id: string;
  role: string;
  rect: number[];
  approach: number[][];
  service: { seconds: number; staffed: boolean; automates: boolean } | null;
  note?: string | null;
};

const ROLE_TEXT: Record<string, string> = {
  district_towers: 'a district of high-rise towers',
  district_industrial: 'a former industrial district by the water',
  district_midrise: 'a district of mid-rise blocks',
  district_dense: 'a dense, low-rise district',
  district_leafy: 'a leafy district further out',
  venue: 'an arena where events are held',
  crossing: 'a bridge — the only way across the bay',
  espresso_bar: 'the espresso bar, where drinks are made to order by a barista',
  display_case: 'the refrigerated case of ready-made food — sandwiches, salads, bottled drinks',
  drinks: 'the self-serve drinks counter',
  espresso_pickup: 'the pickup shelf, where finished drinks are handed over',
  kiosk: 'a self-checkout kiosk: put items on the tray and it recognises them',
  register: 'the staffed register, where a cashier rings you up',
};

/**
 * Render the shared block.
 *
 * MUST be byte-stable for a given (world, version). Anything varying per call —
 * a timestamp, a queue length, the current tick — belongs in the volatile part
 * of the prompt instead; putting it here silently destroys the cache for every
 * twin at once, which is far more expensive than not caching at all.
 */
export function renderWorldContext(args: {
  placeName: string;
  variantLabel: string;
  zones: Zone[];
  staff: Record<string, number>;
  tileFeet: number;
}): string {
  const { placeName, variantLabel, zones, staff, tileFeet } = args;
  const lines: string[] = [];

  lines.push(`You are simulating a real person inside ${placeName}.`);
  lines.push('');
  lines.push('THE PLACE');
  lines.push(
    `${variantLabel}. One tile is about ${tileFeet} feet, so distances below ` +
      `are in walking steps.`,
  );
  lines.push('');

  lines.push('WHAT IS IN HERE');
  for (const z of zones) {
    const desc = ROLE_TEXT[z.role] ?? z.role.replace(/_/g, ' ');
    const bits: string[] = [`- ${z.id}: ${desc}`];
    if (z.service) {
      if (z.service.seconds > 0) bits.push(`Typically takes about ${z.service.seconds} seconds.`);
      bits.push(
        z.service.staffed
          ? 'Needs a member of staff.'
          : 'You can use it yourself, without staff.',
      );
    }
    if (z.note) bits.push(z.note);
    lines.push(bits.join(' '));
  }
  lines.push('');

  const staffLines = Object.entries(staff)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k.replace(/([A-Z])/g, ' $1').toLowerCase().trim()}`);
  lines.push('WHO IS WORKING');
  lines.push(staffLines.length ? staffLines.join(', ') + '.' : 'Nobody is on shift.');
  lines.push('');

  lines.push('WHAT YOU MAY DO');
  lines.push(
    'Only things that are possible in the room described above. Do not invent fixtures, ' +
      'products, staff or rooms that are not listed. If you want something that is not here, ' +
      'the realistic action is to go without it, substitute, or leave.',
  );
  lines.push(
    'You may walk to any of the places listed, look at what is there, join a queue, wait, ' +
      'change your mind, give up and leave, sit down, or talk to someone who is next to you.',
  );
  lines.push('');

  lines.push('HOW TO BEHAVE');
  lines.push(
    '- Act as the specific person described below would act, not as a generic customer and ' +
      'not as an assistant.',
  );
  lines.push(
    '- Where their stated preferences and their actual described behaviour disagree, follow ' +
      'the behaviour. People are poor witnesses to their own habits.',
  );
  lines.push(
    '- Ordinary is correct. Most visits to a cafe are uneventful, and a simulation in which ' +
      'every customer has a memorable experience is wrong.',
  );
  lines.push(
    '- Time and queues matter. Someone in a hurry behaves differently from someone with a ' +
      'free hour, and the same person does different things depending on the line.',
  );

  return lines.join('\n');
}

/** FNV-1a, matching prompt.ts. Stamped on traces so prefix churn is visible. */
export function contextDigest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
