// Web 端以 375 CSS px 作为 750rpx 设计稿基准：1rpx = 0.5px。
// 不再转换为 vw，避免宽屏/4K 视口把字号、按钮和间距等比例放大。
// 页面宽度适配统一交给 CSS 的 max-width、grid 与 media query。
const rpxToPixels = () => ({
  postcssPlugin: 'postcss-rpx-to-pixels',
  Declaration(decl) {
    if (!decl.value || decl.value.indexOf('rpx') === -1) return
    decl.value = decl.value.replace(/(-?\d*\.?\d+)rpx/g, (_, num) => {
      const px = parseFloat(num) * 0.5
      return `${parseFloat(px.toFixed(3))}px`
    })
  }
})
rpxToPixels.postcss = true

export default {
  plugins: [rpxToPixels()]
}
