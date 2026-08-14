// Keeps a backend failure from taking the page down with it.
//
// Convex's useQuery throws when a function is missing or errors, and an
// uncaught throw in a hook makes React unmount the entire tree — which is
// exactly what happened here: the map rendered, the simulation query failed a
// couple of seconds later, and the whole page went blank with nothing in the
// console to explain it.
//
// The city is a static, generated thing that needs no backend at all. Only the
// controls do. So the controls sit behind this boundary and degrade to a note,
// and the map keeps working whether or not Convex is reachable.

import { Component, ReactNode } from 'react';

type Props = { children: ReactNode; fallback?: ReactNode };
type State = { failed: boolean };

export default class BackendBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // Logged rather than swallowed: a missing deployment should be findable,
    // just not fatal.
    console.warn('[siliconville] simulation backend unavailable:', error);
  }

  render() {
    if (this.state.failed) {
      return (
        this.props.fallback ?? (
          <div className="text-white/60 text-sm self-center pointer-events-none">
            Simulation backend unavailable — run <code>npx convex deploy</code>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
