// who Escape belongs to when two things are open at once.
//
// a Sheet closes on Escape, and so does an InfoTip. both listen on `window`,
// so both used to run: pressing Escape at the 'i' next to "What this does"
// dismissed the tip AND cancelled the confirm underneath it, discarding the
// staged transaction the user was reading about. the tip is the thing on top
// and it is the only thing that should have answered.
//
// listener order cannot fix it. the sheet registers first (it is already open
// when the tip opens), so it runs first, and `stopImmediatePropagation` from
// the tip arrives after the sheet has already acted. so the decision is made
// from state rather than from ordering: a transient layer CLAIMS Escape while
// it is open, and anything underneath asks before acting.
//
// deliberately not a React context: the InfoTip's bubble is portaled to
// document.body precisely so it escapes the sheet's transform and overflow, and
// a context would have to be threaded through every sheet that might ever
// contain a tip. one module-level count, one question.

let claims = 0;

/**
 * claim Escape for a transient layer above the sheets. returns the release,
 * which must run on unmount as well as on close, or the layer keeps Escape
 * after it is gone.
 */
export function claimEscape(): () => void {
  claims++;
  let released = false;
  return () => {
    // idempotent: a component that releases in both a cleanup and a close
    // handler must not drive the count negative and free Escape early.
    if (released) return;
    released = true;
    claims--;
  };
}

/** is something above the sheets holding Escape right now? */
export function escapeClaimed(): boolean {
  return claims > 0;
}

/** test-only: drop every claim, so one test cannot leak into the next. */
export function resetEscapeClaims(): void {
  claims = 0;
}
