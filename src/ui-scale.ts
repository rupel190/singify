/**
 * ui-scale.ts — one knob for how big the whole karaoke UI renders.
 *
 * Applied as CSS `zoom` on the overlay's root, so every screen inside scales
 * together: type, padding, controls, the note lane. 1 = the sizes written in the
 * components; 0.75 = everything three-quarters. Change this, not forty font
 * sizes.
 *
 * `zoom` participates in layout (unlike transform: scale), so anything sized in
 * `vh` has to divide the scale back out or it would overflow the viewport —
 * that's what fullHeight() is for. Screens that set their OWN zoom (the 3× menus)
 * multiply with this one, hence the extraZoom argument.
 */
export const UI_SCALE = 0.75;

/** A full viewport height, expressed inside this scale (times any local zoom). */
export function fullHeight(extraZoom = 1): string {
  return `calc(100vh / ${UI_SCALE * extraZoom})`;
}
