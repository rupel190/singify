/**
 * ui-scale.ts — one knob for how big the whole karaoke UI renders.
 *
 * Applied as CSS `zoom` on the overlay's render root, so every screen inside
 * scales together: type, padding, controls, the note lane. 1 = the sizes written
 * in the components; 0.75 = everything three-quarters. Change this, not forty
 * font sizes.
 *
 * NOTE: do not "compensate" for the zoom anywhere. Chromium resolves lengths
 * inside a zoomed element in the ZOOMED coordinate space, so `width: 100%` and
 * `height: 100%` already fill the parent exactly — dividing by the scale makes
 * the box 1/scale too big and shoves the content off-centre. Every box under the
 * root is sized in percentages against the fixed, inset-0 overlay for that
 * reason; `vh` is avoided entirely, since whether zoom applies to viewport units
 * is exactly the ambiguity this note exists to dodge.
 */
export const UI_SCALE = 0.75;
