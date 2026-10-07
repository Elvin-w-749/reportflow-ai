/**
 * 优先使用 uni.getWindowInfoSync（含 safeAreaInsets），降级回退 uni.getSystemInfoSync。
 */
export function getWindowLayoutSync() {
	try {
		if (typeof uni.getWindowInfoSync === 'function') {
			const win = uni.getWindowInfoSync()
			return {
				statusBarHeight: win.statusBarHeight != null ? win.statusBarHeight : 20,
				windowHeight: win.windowHeight != null ? win.windowHeight : win.screenHeight,
				screenHeight: win.screenHeight,
				safeAreaInsets: win.safeAreaInsets || { bottom: 0, top: 0, left: 0, right: 0 }
			}
		}
	} catch (_) {}
	const s = uni.getSystemInfoSync()
	return {
		statusBarHeight: s.statusBarHeight != null ? s.statusBarHeight : 20,
		windowHeight: s.windowHeight,
		screenHeight: s.screenHeight,
		safeAreaInsets: s.safeAreaInsets || { bottom: 0, top: 0, left: 0, right: 0 }
	}
}
