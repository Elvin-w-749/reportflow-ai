/**
 * Vant 4 组件集中注册适配器
 *
 * 通过 app.use() 注册项目所需的 Vant 组件。
 * Vite 默认 ESM tree-shaking 会自动剔除未使用的导出，无需额外按需导入插件。
 */
import {
  Button,
  Dialog,
  Toast,
  Loading,
  Overlay,
  Popup,
  ActionSheet,
  Field,
  Checkbox,
  CheckboxGroup,
  Cell,
  CellGroup,
  Icon
} from 'vant'

export function setupVant(app) {
  app.use(Button)
  app.use(Toast)
  app.use(Dialog)
  app.use(Loading)
  app.use(Overlay)
  app.use(Popup)
  app.use(ActionSheet)
  app.use(Field)
  app.use(Checkbox)
  app.use(CheckboxGroup)
  app.use(Cell)
  app.use(CellGroup)
  app.use(Icon)
}
