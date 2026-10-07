# RPT-Web 前端 UI 全面优化 开发文档

> 目标：全页面浏览器自适应适配（320px3840px）、UI 组件升级、图标系统替换、统一布局壳与设计令牌。
> 约束：只改展示层与样式，不动后端合同与接口约定；每阶段改动都必须能通过既有前端测试；不引入外部服务依赖。

---

## 一、核查结论验证

| 断点 | 验证结果 | 当前状态 |
|------|----------|----------|
| rpx vw 导致 4K 放大 | 正确。Git HEAD 中 rpx 会转 vw；当前 `postcss.config.js` 已改为 1rpx=0.5px | 已修复，需保留 |
| 28 个 `!important` 在 global.css | 正确。`grep` 确认 28 处 | 需清理 |
| `lang="en"` | 正确。`index.html` 第 2 行 | 需改为 `zh-CN` |
| `overflow-x: hidden` + `overflow: hidden` | 正确。`global.css` 第 56/170 行 | 可能导致内容裁切 |
| `/pages/bank/workbench` 双入口 | 正确。与 `/pages/teacher/workbench` 同指向 | 设计如此，保留 |
| DesktopShell 仅 1 处使用 | 正确。仅 Teacher Workbench | 需推广到更多页面 |
| MasterDetailLayout 仅 1 处使用 | 正确。仅 Message Center | 需推广到更多页面 |
| Unicode 字符作图标 | 正确：`| | | | |` 等 | 需替换为 SVG 图标 |
| Naive UI 未实际使用 | 正确。`package.json` 有依赖但源码无引用 | 暂不引入 |

---

## 二、总体改造策略

### 2.1 风格方向

- **主色保持不变**：`#086CEA`
- **设计语言**：借鉴 Ant Design Pro 的布局壳模式 + shadcn/ui 的图标+文字组合方式
- **桌面端**：紧凑侧边导航 + 居中限宽内容区（max-width: 1200px）
- **移动端**：底部 TabBar + 全宽单列
- **超宽屏**：增加列数和信息密度，不放大按钮/字号/图标

### 2.2 技术约束

- **不引入**：React shadcn、Tailwind CSS、Naive UI（保留依赖但不激活）
- **新增依赖**：`lucide-vue-next`（SVG 图标库，按需引入，tree-shakeable）
- **保留**：Vant 4（移动端组件）、Vue 3 + Vite 8 + Vue Router 4
- **不进行框架迁移**：不转 TypeScript、不引入状态管理库

### 2.3 设计令牌统一（Design Tokens）

```
颜色体系：
--rpt-color-primary: #086CEA          (品牌蓝)
--rpt-color-primary-hover: #0759C7    (悬停)
--rpt-color-primary-light: #EAF3FF    (浅蓝背景)
--rpt-color-success: #16A34A          (成功)
--rpt-color-warning: #D97706          (警告)
--rpt-color-danger: #DC2626           (危险)
--rpt-color-bg-page: #F3F7FF          (页面背景)
--rpt-color-bg-container: #FFFFFF     (容器背景)
--rpt-color-text-primary: #071B3D     (主文字)
--rpt-color-text-secondary: #52627A   (次要文字)
--rpt-color-text-muted: #8B98AA       (弱化文字)
--rpt-color-border: #EEF0F4           (边框)

间距体系：
--rpt-space-xs: 4px
--rpt-space-sm: 8px
--rpt-space-md: 12px
--rpt-space-lg: 16px
--rpt-space-xl: 24px
--rpt-space-2xl: 32px

圆角体系：
--rpt-radius-sm: 6px
--rpt-radius-md: 10px
--rpt-radius-lg: 16px
--rpt-radius-xl: 24px

图标尺寸：
--rpt-icon-sm: 16px
--rpt-icon-md: 20px
--rpt-icon-lg: 24px

响应式断点：
--rpt-bp-sm: 375px
--rpt-bp-md: 768px
--rpt-bp-lg: 1024px
--rpt-bp-xl: 1440px
--rpt-bp-2xl: 1920px
--rpt-content-max: 1200px            (内容最大宽度)
--rpt-content-narrow: 960px          (阅读/表单宽度)
```

---

## 三、五阶段改动清单

### 第一阶段：全局基础层

#### 1.1 保留并验证 rpx px 修复

- **文件**：`postcss.config.js`（已修改，无需改动）
- **验证**：所有页面的 `rpx` 值在 4K 屏幕上均不超过预期 px 值的 1.5 倍

#### 1.2 重构 `global.css` 设计令牌化

- **文件**：`src/styles/global.css`
- **改动**：
  - 第 6-47 行：扩充 CSS 自定义属性，新增 `--rpt-bp-*` 断点变量、`--rpt-icon-*` 图标尺寸、`--rpt-content-max` 容器宽度
  - 第 49-104 行：基础重置保留，但 `body { overflow-x: hidden }` 改为 `overflow-x: clip`
  - 第 107-162 行：工具类保留，新增 `.rpt-page-container`（居中限宽容器）、`.rpt-desktop-rail`（桌面端侧栏占位）
  - 第 164-389 行：**重点清理**。将 28 个 `!important` 逐步收敛：
    - 品牌色覆盖 改用 CSS 变量继承
    - 组件覆盖 迁移到各组件 scoped style 或独立 CSS 模块
    - 保留约 5 个必要 `!important`（Vant 主题覆盖、安全区适配）
  - 第 392-421 行：响应式断点区重写，支持 5 级断点
  - 第 426-463 行：Vant 主题变量保留，新增 `--van-dialog-width`、`--van-action-sheet-max-width` 等桌面端限制

#### 1.3 重构 `responsive.css`

- **文件**：`src/styles/responsive.css`
- **改动**：
  - 新增 `.hide-below-md`、`.hide-below-lg`、`.show-only-mobile` 等显隐工具
  - 新增 `.rpt-desktop-grid-2`、`.rpt-desktop-grid-3`、`.rpt-desktop-grid-4` 自适应栅格
  - 新增 `.rpt-safe-scroll` 解决嵌套滚动问题

#### 1.4 修复 `index.html`

- **文件**：`index.html`
- **改动**：`lang="en"` 改为 `lang="zh-CN"`

#### 1.5 正确接入 Vant 样式

- **文件**：`src/compat/vantAdapter.js`
- **改动**：确认 Vant CSS 完整引入；当前已通过 `setupVant(app)` 注册组件，但需补充全局 CSS 导入

---

### 第二阶段：响应式布局壳

#### 2.1 新建 `AppShell.vue`（统一布局壳）

- **新建文件**：`src/components/layout/AppShell.vue`
- **功能**：
  - 根据路由 meta 自动选择布局模式：
    - `layout: 'tab'` 普通用户页面：底部 Tab + 桌面紧凑侧栏
    - `layout: 'workbench'` 工作台页面：Ant Design Pro 式可折叠侧栏
    - `layout: 'blank'` 认证页面：无导航，纯居中
  - 内部使用 `DesktopShell` 或 `MasterDetailLayout` 子布局
  - 桌面端自动为侧栏预留空间（`padding-left: var(--rpt-desktop-rail)`）

#### 2.2 升级 `DesktopShell.vue`

- **文件**：`src/components/layout/DesktopShell.vue`
- **改动**：
  - 新增 prop：`contentMaxWidth`（默认 1200px）
  - 新增 slot：`header`（顶部导航栏）
  - 平板端（768-1023px）：侧栏改为顶部水平导航
  - 超宽屏（>=1920px）：内容区最大宽度可配置

#### 2.3 升级 `MasterDetailLayout.vue`

- **文件**：`src/components/layout/MasterDetailLayout.vue`
- **改动**：
  - 新增 prop：`mobileBackButton`（移动端详情页是否显示返回按钮）
  - 平板端（768-1023px）：允许同时显示列表+详情（比例 40:60）
  - 新增 `detailFallback` slot：未选中时的空状态

#### 2.4 升级 `TabBar.vue`

- **文件**：`src/components/TabBar.vue`
- **改动**：
  - 图标替换为 Lucide Vue 组件（见第三阶段）
  - 桌面端 `.tabbar` 添加右侧安全间距
  - 桌面端 TabBar 宽度从 84px 增加到 88px
  - 新增 `aria-label` 和 `role="navigation"` 无障碍属性

#### 2.5 路由元信息扩展

- **文件**：`src/router/index.js`
- **改动**：为每条路由添加 `meta.layout` 字段：
  - 4 个 Tab 页面：`layout: 'tab'`
  - 6 个工作台页面：`layout: 'workbench'`
  - 4 个认证页面：`layout: 'blank'`
  - 其余页面：`layout: 'default'`（带返回按钮的通用布局）

#### 2.6 全局 Dialog/ActionSheet 桌面限宽

- **文件**：`src/compat/overlay.js`、`src/compat/components/UniOverlay.vue`
- **改动**：
  - ActionSheet 面板：桌面端 `max-width: 480px`，居中，圆角 16px
  - Vant Dialog：通过 CSS 变量 `--van-dialog-width: min(85vw, 420px)` 限制
  - Vant Toast：桌面端 `max-width: 360px`，居中

---

### 第三阶段：组件与图标升级

#### 3.1 安装 `lucide-vue-next`

- **文件**：`package.json`
- **改动**：`npm install lucide-vue-next`（约 40KB gzipped）

#### 3.2 新建图标映射配置

- **新建文件**：`src/config/icons.js`
- **内容**：语义化图标映射表，统一管理所有图标引用

```
// 图标映射表（按需引入，支持 tree-shaking）
export const ICON_MAP = {
  // 导航
  home:           'Home',
  match:          'Search',
  message:        'MessageCircle',
  profile:        'User',
  back:           'ChevronLeft',
  forward:        'ChevronRight',
  close:          'X',
  // 功能
  upload:         'Upload',
  report:         'FileText',
  debt:           'CreditCard',
  advisor:        'Phone',
  reminder:       'Bell',
  material:       'Paperclip',
  settings:       'Settings',
  logout:         'LogOut',
  // 状态
  success:        'CheckCircle',
  warning:        'AlertTriangle',
  danger:         'AlertCircle',
  info:           'Info',
  // 操作
  add:            'Plus',
  edit:           'Edit',
  delete:         'Trash2',
  refresh:        'RefreshCw',
  filter:         'Filter',
  more:           'MoreHorizontal',
  // 工作台
  monitor:        'Activity',
  client:         'Users',
  task:           'ClipboardList',
  admin:          'Shield',
  publisher:      'Send',
  service:        'Headphones',
}
```

#### 3.3 TabBar 图标替换

- **文件**：`src/components/TabBar.vue`、`src/config/tabbar.js`
- **改动**：
  - `tabIcon()` 函数删除，改为 `tabList` 中携带 `icon` 字段
  - 模板中 `<text class="tab-symbol">{{ tabIcon(index) }}</text>` 替换为 `<component :is="item.icon" :size="24" />`
  - 保留消息未读徽标和桌面端竖排布局

#### 3.4 返回按钮统一替换

- **影响范围**：约 25 个页面中的 `` 字符
- **改动**：所有 `` 替换为 `<ChevronLeft :size="20" />` 组件
- **方式**：在 `AppShell` 中统一处理，非 Tab/认证页面自动显示返回按钮

#### 3.5 Profile 菜单图标替换

- **文件**：`src/pages/profile/Profile.vue`
- **改动**：
  - 14 个中文单字图标（"报""传""材""询""债""日""师""服""管""密""电""协""隐""知"）替换为对应 Lucide 图标
  - 图标容器 `.menu-icon` 使用统一颜色和尺寸

#### 3.6 快速入口卡片图标替换

- **影响范围**：`Admin/Workbench.vue`、`Teacher/Workbench.vue` 等
- **改动**：中文单字入口图标替换为语义化 Lucide 图标

#### 3.7 箭头图标统一

- **影响范围**：约 30 个页面中的 `` 字符
- **改动**：所有 `` 替换为 `<ChevronRight :size="16" />`

---

### 第四阶段：页面逐批迁移

#### 4.1 认证页面（4 个）

- **文件**：`Login.vue`、`Register.vue`、`ChangePassword.vue`、`ResetPassword.vue`
- **改动**：
  - 添加 `max-width: 440px` 居中容器
  - 桌面端添加卡片样式（白色背景 + 阴影 + 圆角）
  - `lang="en"` 修复已在 `index.html` 完成

#### 4.2 用户 Tab 页面（4 个）

- **文件**：`Home.vue`、`Match.vue`、`Center.vue`、`Profile.vue`
- **改动**：
  - 桌面端使用 `AppShell` 布局（左侧竖排 TabBar + 内容限宽）
  - 图标替换（见第三阶段）
  - 卡片组件统一间距和圆角
  - Home 的信用分仪表盘保持纯 CSS 实现，不做改动

#### 4.3 报告页面（3 个）

- **文件**：`Upload.vue`、`Manage.vue`、`Detail.vue`
- **改动**：
  - 桌面端切换为 `MasterDetailLayout`（Manage 为列表 + Detail 为详情）
  - 固定底部操作栏桌面端居中限宽
  - 锚点导航芯片桌面端改为横向排列
  - 快速操作卡片图标替换

#### 4.4 服务与沟通页面（5 个）

- **文件**：`DebtManage.vue`、`RepaymentReminder.vue`、`SupplementMaterials.vue`、`Advisor.vue`、`Conversation.vue`
- **改动**：
  - DebtManage：桌面端三列风险网格改为四列（充分利用宽屏）
  - Advisor：固定底部按钮桌面端居中限宽
  - Conversation：聊天输入框桌面端限宽 720px

#### 4.5 工作台页面（9 个）

- **文件**：`Admin/Workbench.vue`、`Admin/Monitor.vue`、`Teacher/Workbench.vue`、`Teacher/Apply.vue`、`Teacher/Reviewing.vue`、`Teacher/Clients.vue`、`Teacher/Tasks.vue`、`Teacher/ClientDetail.vue`、`Service/Workbench.vue`
- **改动**：
  - 统一使用 `DesktopShell` 布局（可折叠侧栏 + 主内容区）
  - 桌面端数据列表切换为双列/三列网格
  - 快速入口图标替换
  - 同步状态指示器优化

#### 4.6 内容与官网页面（2 个）

- **文件**：`report/Detail.vue`、`official/Official.vue`
- **改动**：
  - Detail：桌面端限宽阅读区（max-width: 800px）
  - Official：保留现有 clamp/vw 响应式设计，不做机械替换

---

### 第五阶段：验收与无障碍

#### 5.1 键盘与无障碍

- **影响范围**：所有 `<view @click>` 交互元素
- **改动**：
  - 可点击元素添加 `role="button"`、`tabindex="0"`
  - 可点击元素添加 `@keydown.enter` 和 `@keydown.space` 处理
  - 添加 `:focus-visible` 焦点样式（蓝色轮廓 2px）
  - 点击区域最小 44x44px（满足 WCAG 2.5.5）
  - 图标添加 `aria-hidden="true"`，纯图标按钮添加 `aria-label`

#### 5.2 空态/错误态/加载态统一

- **新建文件**：`src/components/StateFeedback.vue`
- **功能**：统一的状态反馈组件，支持 loading/empty/error/unauthorized 四种状态
- **改动**：逐步替换各页面中内联的状态处理

#### 5.3 减少动画偏好

- **文件**：`src/styles/global.css`
- **改动**：添加 `@media (prefers-reduced-motion: reduce)` 规则，禁用过渡动画

#### 5.4 多分辨率截图验证

- **验证范围**：320px / 375px / 414px / 768px / 1024px / 1440px / 1920px / 2560px / 3840px
- **验证项**：无横向裁切、无图标重叠、无固定栏遮挡、无布局断裂

---

## 四、文件改动汇总

| 阶段 | 新建 | 修改 | 删除 |
|------|------|------|------|
| 第一阶段 | 0 | 4（global.css, responsive.css, index.html, vantAdapter.js） | 0 |
| 第二阶段 | 1（AppShell.vue） | 5（DesktopShell.vue, MasterDetailLayout.vue, TabBar.vue, router/index.js, overlay.js + UniOverlay.vue） | 0 |
| 第三阶段 | 1（config/icons.js） | 3（package.json, TabBar.vue, config/tabbar.js）+ 约 30 个页面的图标替换 | 0 |
| 第四阶段 | 0 | 约 30 个页面 | 0 |
| 第五阶段 | 1（StateFeedback.vue） | 约 30 个页面（无障碍属性）+ global.css | 0 |
| **总计** | **3 个新文件** | **约 40 个文件修改** | **0** |

---

## 五、风险与注意事项

1. **改动规模约 40 个文件**：均为展示层与样式改动，回退方式按常规版本控制操作即可，本节不绑定某次工作区快照
2. **postcss.config.js 的 rpx 修复**：必须保留，这是解决 4K 放大问题的核心
3. **Vant 4 与桌面端**：Vant 为移动端设计，桌面端需要通过 CSS 变量限制弹窗/面板宽度
4. **兼容层 ScrollView**：`GAP-COMPAT-001`/`GAP-COMPAT-002` 的下拉刷新和滚动定位能力不在本轮修复范围
5. **不引入深色模式**：本轮不涉及

---

## 六、执行顺序

```
第一阶段（全局基础层）
  第二阶段（响应式布局壳）
    第三阶段（组件与图标升级）
      第四阶段（页面逐批迁移）  可与第三阶段部分并行
        第五阶段（验收与无障碍）
```

每个阶段完成后需通过该阶段对应的验证检查点，方可进入下一阶段。