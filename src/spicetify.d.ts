/**
 * spicetify.d.ts — minimal ambient types for the Spicetify globals we touch.
 *
 * Spicetify injects `Spicetify.React` / `Spicetify.ReactDOM` (its own bundled
 * React) plus the `Spicetify.Player` API. We only declare the slice we use.
 * In the browser harness we assign a real React to `globalThis.Spicetify`.
 */

export {};

declare global {
  interface SpicetifyTrackItem {
    uri?: string;
    name?: string;
    artists?: { name: string }[];
    album?: { name?: string };
    duration?: { milliseconds?: number };
  }

  interface SpicetifyPlayerData {
    item?: SpicetifyTrackItem;
    /** current track (newer API alias) */
    track?: SpicetifyTrackItem;
    isPaused?: boolean;
  }

  interface SpicetifyPlayerEvent {
    /** onprogress carries the position in ms; songchange carries player data */
    data: number & SpicetifyPlayerData;
  }

  interface SpicetifyPlayer {
    addEventListener(
      event: "songchange" | "onprogress" | "onplaypause" | string,
      cb: (e: SpicetifyPlayerEvent) => void
    ): void;
    removeEventListener(event: string, cb: (e: SpicetifyPlayerEvent) => void): void;
    data?: SpicetifyPlayerData;
    getProgress?(): number;
    isPlaying?(): boolean;
  }

  interface SpicetifyReactDOM {
    render?(element: unknown, container: Element): void;
    createRoot?(container: Element): { render(element: unknown): void; unmount(): void };
  }

  interface SpicetifyGlobal {
    React: typeof import("react");
    ReactDOM: SpicetifyReactDOM;
    Player: SpicetifyPlayer;
    Platform?: Record<string, unknown>;
    CosmosAsync?: unknown;
    showNotification?(text: string, isError?: boolean): void;
  }

  // eslint-disable-next-line no-var
  var Spicetify: SpicetifyGlobal;

  // We compile JSX with the classic factory `Spicetify.React.createElement`,
  // which resolves against the *global* `JSX` namespace. React 19's types put
  // JSX under `React.JSX`, so re-expose it globally.
  namespace JSX {
    type Element = import("react").JSX.Element;
    type ElementClass = import("react").JSX.ElementClass;
    type ElementAttributesProperty = import("react").JSX.ElementAttributesProperty;
    type ElementChildrenAttribute = import("react").JSX.ElementChildrenAttribute;
    type LibraryManagedAttributes<C, P> = import("react").JSX.LibraryManagedAttributes<C, P>;
    type IntrinsicAttributes = import("react").JSX.IntrinsicAttributes;
    type IntrinsicClassAttributes<T> = import("react").JSX.IntrinsicClassAttributes<T>;
    type IntrinsicElements = import("react").JSX.IntrinsicElements;
  }
}
