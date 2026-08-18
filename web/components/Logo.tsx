/**
 * The Yven brand mark, in one place.
 *
 * Every surface used to draw its own approximation: the marketing nav
 * and the sidebar rendered the word "Yven" as gradient-clipped text in
 * whatever font the page happened to load, and the app chrome paired it
 * with a lucide `Play` glyph in a gradient square. Neither was the
 * logo — they were stand-ins from before there was one.
 *
 * Assets are exported from the supplied Illustrator file (which is a
 * PDF-1.6 container, so the artwork came out as real vector before
 * rasterising) and live in /public/brand:
 *
 *   yven-mark.png          the Y device alone, transparent
 *   yven-lockup.png        device + wordmark, wordmark in WHITE
 *   yven-lockup-light.png  device + wordmark, wordmark in the original
 *                          near-black — for light backgrounds only
 *
 * The wordmark ships as two files rather than one recoloured with CSS
 * because it is raster: `filter: invert()` would flip the purple device
 * to green along with it.
 *
 * Sizing is driven by HEIGHT (`h-*` on the element, width auto). The
 * intrinsic width/height attributes are the real pixel dimensions so
 * the browser reserves the right box and the nav does not reflow as the
 * image decodes — the reflow that shows up as the CTA wrapping for one
 * frame on a cold load.
 */

const LOCKUP_W = 874;
const LOCKUP_H = 256;
const MARK_W = 442;
const MARK_H = 512;

/** Device + wordmark. `className` sets the height, e.g. "h-7 w-auto". */
export function Logo({
  className = "h-7 w-auto",
  variant = "dark",
}: {
  className?: string;
  /** "dark" = white wordmark (dark UI). "light" = near-black wordmark. */
  variant?: "dark" | "light";
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={variant === "light" ? "/brand/yven-lockup-light.png" : "/brand/yven-lockup.png"}
      alt="Yven"
      width={LOCKUP_W}
      height={LOCKUP_H}
      className={className}
      decoding="async"
    />
  );
}

/** The Y device on its own — for tight rails and small chrome. */
export function LogoMark({ className = "h-7 w-auto" }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/brand/yven-mark.png"
      alt="Yven"
      width={MARK_W}
      height={MARK_H}
      className={className}
      decoding="async"
    />
  );
}
