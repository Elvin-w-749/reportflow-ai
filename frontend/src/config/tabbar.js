/**
 * 自定义 Tab 栏数据源（custom-tabbar 引用此处）。
 * 须与 pages.json 中 tabBar.list 的 pagePath、text、顺序保持一致。
 * （框架要求 pages.json 无法 import，改 Tab 时请同时改两处。）
 */
export const TAB_BAR_LIST = [
	{ pagePath: '/pages/home/home', text: '首页' },
	{ pagePath: '/pages/match/index', text: '匹配' },
	{ pagePath: '/pages/message/center', text: '消息' },
	{ pagePath: '/pages/profile/profile', text: '我的' }
]

export default TAB_BAR_LIST
