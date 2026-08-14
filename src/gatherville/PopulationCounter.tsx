// Population readout, bottom-right.
//
// One number, not two. It previously showed "twins" and "residents" separately,
// which mattered only while ai-town's invented NPCs shared the map — with those
// gone every resident is a person, and two identical figures just read as a bug.
//
// The framing is lives rather than entities: the product is people living a
// life in here, and eventually more than one life each. When counterfactual
// runs exist this grows a genuine second number (people vs lives lived); until
// then a single count is the honest one.

import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';

const TARGET = 8_000_000_000;

export function PopulationCounter() {
  const pop = useQuery(api.gatherville.population.counts);
  if (!pop) return null;

  const lives = pop.twins;
  const share = (lives / TARGET) * 100;

  return (
    // Floats only from `sm:` up — on phones it covered the chat panel.
    <div className="pointer-events-none z-40 mx-auto mt-3 w-fit select-none text-right font-body text-white shadow-solid sm:fixed sm:bottom-4 sm:right-4 sm:mx-0 sm:mt-0">
      <div className="rounded border border-white/20 bg-black/50 px-3 py-2 backdrop-blur-sm">
        <div className="text-[10px] uppercase tracking-widest opacity-60">Population</div>

        <div className="mt-1 flex items-baseline justify-end gap-1.5">
          <span className="text-2xl tabular-nums leading-none">{lives.toLocaleString()}</span>
          <span className="text-xs opacity-70">{lives === 1 ? 'life' : 'lives'}</span>
        </div>

        <div className="mt-1.5 border-t border-white/10 pt-1.5 text-[10px] tabular-nums opacity-40">
          {lives === 0
            ? 'of 8 billion'
            : `${share < 0.0000001 ? '< 0.0000001' : share.toFixed(7)}% of 8 billion`}
        </div>
      </div>
    </div>
  );
}
