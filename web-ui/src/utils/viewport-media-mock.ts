/**
 * Shared test helper: a realistic window.matchMedia mock driven by a mutable
 * viewport width. Evaluates "max-width" queries against the current width and
 * delivers change events to registered listeners when the width crosses the
 * boundary, mirroring what a browser resize or orientation change does.
 */

type MediaQueryChangeCallback = (event: Event) => void;

/**
 * A realistic window.matchMedia mock driven by a mutable viewport width.
 * Evaluates "max-width" queries against the current width and delivers
 * change events to registered listeners when the width crosses the boundary,
 * mirroring what a browser resize or orientation change does.
 */
export function createViewportMediaMock(initialWidth: number) {
	const listeners = new Set<MediaQueryChangeCallback>();

	const evaluate = (query: string): boolean => {
		const maxWidth = /\(max-width:\s*([\d.]+)px\)/.exec(query);
		if (!maxWidth) {
			return false;
		}
		return viewportWidth <= Number(maxWidth[1]);
	};

	let viewportWidth = initialWidth;

	const matchMedia = (query: string): MediaQueryList => ({
		// Like a real MediaQueryList, `matches` is live and re-evaluated.
		get matches() {
			return evaluate(query);
		},
		media: query,
		onchange: null,
		addListener: () => {},
		removeListener: () => {},
		addEventListener: (_type: string, listener: EventListenerOrEventListenerObject | null) => {
			if (typeof listener === "function") {
				listeners.add(listener as MediaQueryChangeCallback);
			}
		},
		removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject | null) => {
			if (typeof listener === "function") {
				listeners.delete(listener as MediaQueryChangeCallback);
			}
		},
		dispatchEvent: () => true,
	});

	return {
		matchMedia,
		resizeTo(width: number) {
			viewportWidth = width;
			const event = new Event("change");
			listeners.forEach((listener) => {
				listener(event);
			});
		},
	};
}
