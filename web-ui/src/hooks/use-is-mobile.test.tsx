import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useIsMobile } from "@/hooks/use-is-mobile";

type MediaQueryChangeCallback = (event: Event) => void;

/**
 * A realistic window.matchMedia mock driven by a mutable viewport width.
 * Evaluates "max-width" queries against the current width and delivers
 * change events to registered listeners when the width crosses the boundary,
 * mirroring what a browser resize or orientation change does.
 */
function createViewportMediaMock(initialWidth: number) {
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

const renderLog: boolean[] = [];

function MobileProbe(): ReactElement {
	const isMobile = useIsMobile();
	// Record every render, including the very first one, so tests can
	// assert on the initial client-render value before/after effects.
	renderLog.push(isMobile);
	return <div data-testid={isMobile ? "probe-mobile" : "probe-desktop"} />;
}

describe("useIsMobile", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let mediaMock: ReturnType<typeof createViewportMediaMock>;
	let previousMatchMedia: typeof window.matchMedia;

	beforeEach(() => {
		renderLog.length = 0;
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		previousMatchMedia = window.matchMedia;
		mediaMock = createViewportMediaMock(1280);
		window.matchMedia = mediaMock.matchMedia;
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		window.matchMedia = previousMatchMedia;
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("reports the mobile viewport during the very first render, not after effects", () => {
		mediaMock.resizeTo(390); // iPhone-sized viewport

		act(() => {
			root.render(<MobileProbe />);
		});

		// The first render must already be mobile. The previous
		// implementation recorded [false, true] here (desktop first, then
		// corrected once the media query effect ran).
		expect(renderLog).toEqual([true]);
		expect(container.querySelector('[data-testid="probe-mobile"]')).not.toBeNull();
	});

	it("reports the desktop viewport during the very first render", () => {
		mediaMock.resizeTo(1280);

		act(() => {
			root.render(<MobileProbe />);
		});

		expect(renderLog).toEqual([false]);
		expect(container.querySelector('[data-testid="probe-desktop"]')).not.toBeNull();
	});

	it("updates when the viewport changes to mobile and back to desktop", () => {
		mediaMock.resizeTo(1280);

		act(() => {
			root.render(<MobileProbe />);
		});
		expect(container.querySelector('[data-testid="probe-desktop"]')).not.toBeNull();

		// Resize/orientation change to a mobile-sized viewport.
		act(() => {
			mediaMock.resizeTo(700);
		});
		expect(container.querySelector('[data-testid="probe-mobile"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="probe-desktop"]')).toBeNull();

		// Back to desktop.
		act(() => {
			mediaMock.resizeTo(1024);
		});
		expect(container.querySelector('[data-testid="probe-desktop"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="probe-mobile"]')).toBeNull();
	});

	it("treats a 768px viewport as mobile and 769px as desktop", () => {
		mediaMock.resizeTo(768);

		act(() => {
			root.render(<MobileProbe />);
		});
		expect(container.querySelector('[data-testid="probe-mobile"]')).not.toBeNull();

		act(() => {
			mediaMock.resizeTo(769);
		});
		expect(container.querySelector('[data-testid="probe-desktop"]')).not.toBeNull();
	});
});
