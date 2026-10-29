import { useMedia } from "@/utils/react-use";

const MOBILE_BREAKPOINT = "(max-width: 768px)";

// No explicit defaultState: react-use's useMedia treats a provided default as
// authoritative for the initial render, which would assume desktop until its
// effect runs. Leaving it undefined lets the first client render read
// window.matchMedia() directly, so mobile viewports never mount the desktop
// layout first.
export function useIsMobile(): boolean {
	return useMedia(MOBILE_BREAKPOINT);
}
