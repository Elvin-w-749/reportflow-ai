/**
 * tabBar 跳转：规避偶发 switchTab:fail timeout（分析/选图后主线程繁忙时更易触发）
 * 延后到下一宏任务；失败则短延迟再 switchTab 一次；仍失败则 reLaunch 到同一 tab 路径。
 * @param {string} url 须为 tabBar 页面，如 /pages/home/home
 */
export function safeSwitchTab(url) {
	if (!url || typeof url !== 'string') return
	const path = url.startsWith('/') ? url : `/${url}`
	// 先直接切换（点击即跟手）；仅在 fail（主线程繁忙偶发 timeout）时才延迟重试，
	// 最后 reLaunch 兜底。去掉过去无条件的 setTimeout(0) 延迟，消除每次切 tab 的卡顿感。
	uni.switchTab({
		url: path,
		fail: () => {
			setTimeout(() => {
				uni.switchTab({
					url: path,
					fail: () => {
						uni.reLaunch({
							url: path,
							fail: (e) => {
								console.warn('[safeSwitchTab] 仍失败', path, e)
							}
						})
					}
				})
			}, 280)
		}
	})
}

export default safeSwitchTab
