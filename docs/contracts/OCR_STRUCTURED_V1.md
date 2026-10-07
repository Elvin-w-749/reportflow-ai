# `ocr-structured-v1` 内部证据契约草案

## 状态与用途

- 状态：阶段 0 已冻结的实现合同；尚无 runtime adapter。
- JSON Schema：[`ocr-structured-v1.schema.json`](ocr-structured-v1.schema.json)
- 上游：智谱 `POST https://open.bigmodel.cn/api/paas/v4/layout_parsing`，model `glm-ocr`。
- 下游：DeepSeek 候选事实提取与 Evidence Binder。
- 安全属性：结构化 OCR 只是候选证据源，永远不等于 accepted fact。

当前生产不会生成这个对象。扫描 PDF/图片仍在 OCR 证据接入前被阻断；本文只约束后续 adapter 的输入输出与失败行为。

## 顶层合同

```text
version: ocr-structured-v1
sourceMode: ocr-structured
provider: zhipu-layout-parsing
model: glm-ocr
complete: boolean
expectedPageCount: integer 1..100
metadata:
  adapterVersion
  readingOrderVersion
  tableParserVersion
  canonicalizationVersion
  normalizationLimitsVersion: ocr-normalization-limits-v1
  providerBboxNormalizationVersion: glm-normalized-region-bbox-to-rendered-pixels-v1
  blankPagePolicyVersion: verified-blank-page-v1
  coordinateSpace: rendered-image-pixels / top-left / x-right / y-down / xyxy / 3 decimals
  render { engine, dpi, format, quality }
pages[]:
  pageNumber
  bounds
  verifiedBlank
  text
  blocks[]
```

provider envelope 的 `id`、`request_id`、`usage`、`md_results`、`layout_visualization`、crop image/URL 和未知字段都不属于内部合同。adapter 只能从严格验证后的 `layout_details` 与 `data_info` 构造允许字段。

## block、span 与几何

每个 normalized block 必须包含：

- `text`：已完成 Unicode/换行规范化的纯文本，不保留可执行 HTML、脚本、事件属性或外链；
- `charStart / charEnd`：相对当前 `page.text` 的半开区间；
- `bbox: [x0, y0, x1, y1]`：有限数值，位于 `page.bounds` 内，且 `x1 > x0`、`y1 > y0`；
- `sourceBlockOrdinal / sourceLineOrdinal / sourceLineCount`：来源 region 与确定性拆行顺序；
- `regionIndex`：当前页 normalized block 的唯一、连续、1-based index；
- `regionLabel`：内部闭集 label；未知 provider label 在 normalizer 中拒绝；
- `geometryGranularity: region`：明确 bbox 只有 region 粒度；
- `recordMembership`：`single-record / logical-table-row / non-record`；
- `logicalTable`：只有 `table_row` block 可使用，其他 block 必须为 null。

region bbox 不得被描述为字符、金额 token 或 table cell polygon。即使一个 logical row 的 cells 可由文本确定性拆开，cell 也只拥有 page text span，不继承虚假的 cell bbox。

## 坐标空间与确定性转换

内部 `page.bounds` 固定为 200 DPI 渲染图像像素坐标 `[0, 0, renderedWidth, renderedHeight]`：原点左上，x 向右，y 向下，顺序 `x0,y0,x1,y1`，最终保留 3 位小数。内部标识为 `rendered-image-pixels`。

provider `bbox_2d` 只能按 `glm-normalized-region-bbox-to-rendered-pixels-v1` 转换；v1 在整页固定使用 normalized 0..1 mode，不支持 absolute/provider-page fallback：

1. 先校验 provider page width/height、rendered width/height 均为有限正数，并校验 `x1>x0 / y1>y0`。
2. 当前页每个 region 的四个原始坐标都必须为有限数并位于 `[0,1]`，且 `x1>x0 / y1>y0`；任一坐标大于 1、混合 absolute/normalized、负数或非有限数立即返回 `GLM_OCR_RESPONSE_INVALID`。
3. 唯一缩放公式为 `x = rawX * renderedWidth`、`y = rawY * renderedHeight`；不得根据单个 tuple 猜测模式，不得接受 provider absolute coordinate。
4. 结果使用 `Math.round(value * 1000) / 1000`，`-0` 规范化为 `0`；舍入后必须再次验证 finite、`0<=x0<x1<=width`、`0<=y0<y1<=height`，防止窄 region 塌成零宽/零高。失败内部码为 `provider-bbox.rounded-extent`，公开映射 `GLM_OCR_RESPONSE_INVALID`；不得 clamp 或交换轴。

这个转换只改变坐标空间，不提高 geometry 粒度；输出仍必须声明 `geometryGranularity=region`。

## logical table row/cell

HTML/Markdown table 不能以原始 markup 或一个粗粒度文本块直接交给 DeepSeek。normalizer 必须使用无网络、无脚本、固定版本 parser，产生：

```text
block.regionLabel: table_row
block.recordMembership: logical-table-row
block.logicalTable:
  tableOrdinal
  rowOrdinal / rowCount
  cells[]:
    text
    charStart / charEnd
    cellOrdinal / cellCount
    columnRole
```

每个 cell span 必须完全落在所属 row block span 中；cell ordinal 必须是 `1..cellCount` 的连续序列。每个 row ordinal 必须是 `1..rowCount` 的连续序列。header 只能提供 column role，不能被当作业务记录。

如果一个 provider region 含多个账户/查询行而 parser 不能唯一恢复 logical rows/cells，或合并单元格导致记录归属仍有多解，adapter 必须返回 `OCR_RECORD_MEMBERSHIP_UNPROVEN`。禁止：

- 把整张多账户表标为 `single-record`；
- 让 DeepSeek选择行或金额归属；
- 复制 region bbox 并宣称为 cell geometry；
- 按视觉“看起来像”补缺失 cell；
- 下载 provider 的 layout visualization 或 crop image 二次判断。

## schema 之后仍必须执行的语义校验

JSON Schema 只能表达局部形状。adapter 在构造文档前还必须按以下顺序 fail-closed：

1. `pages.length === expectedPageCount`，pageNumber 必须严格等于 `1..N`，不重复、不跳页、不重排。
2. `complete === true` 才能交给 DeepSeek；`false` 只可作为内存诊断状态，不进入事实提取、缓存或 review projection。
3. 空白页只有在 rendered page 与 provider page 都存在、provider 没有非空 region、版本化确定性 blank detector 同时通过时，才可表示为 `verifiedBlank=true / text="" / blocks=[]`。空内容未经证明返回 `GLM_OCR_PAGE_COVERAGE_MISMATCH`；非空页必须 `verifiedBlank=false` 且至少一个 block。
4. 每页 bounds 合法；每个 bbox 有限、严格在 bounds 内，并执行 `glm-normalized-region-bbox-to-rendered-pixels-v1`。
5. `page.text.slice(charStart, charEnd) === block.text`；每个非空白 page 字符必须恰好覆盖一次，同时所有字符（包括空格、换行）coverage 都必须 `<=1`，任何 whitespace-only overlap 也以 `ocr.page-overlap` 拒绝。
6. block 必须按 `charStart, charEnd, regionIndex` 排序；regionIndex 唯一连续。
7. `sourceLineOrdinal <= sourceLineCount`；按 `sourceBlockOrdinal` 分组后，所有成员 `sourceLineCount` 必须一致，line ordinal 必须唯一且严格连续为 `1..lineCount`。count 漂移使用 `ocr.source-line-count-consistency`，重复 line1 或 line1→line3 gap 使用 `ocr.source-line-sequence`；公开均映射为 `GLM_OCR_RESPONSE_INVALID`。
8. table row/cell 的 ordinal、span、column role 和记录归属全部闭合；否则 `OCR_RECORD_MEMBERSHIP_UNPROVEN`。
9. provider region reading order 与几何排序冲突且无法用固定规则唯一裁决时返回 `OCR_READING_ORDER_CONFLICT`。
10. 单页 `text <= 1,000,000` 字符、单 block/cell `<= 200,000` 字符、单页 blocks `<= 5,000`、整份 document text `<= 1,000,000` 字符；任何截断都视为 coverage failure，而不是成功。
11. 内部 `page.bounds` 与 block `bbox` 每个数最多 3 位小数且禁止 IEEE `-0`；内部文档校验独立拒绝 4 位小数和 `-0`，不能只依赖上游 normalizer。
12. 同一输入与版本重复规范化，UTF-8 canonical JSON 字节必须一致；时间戳、运行 ID、耗时和 provider request ID 不得进入 canonical object。

`complete`、schema valid 和 canonical bytes 都不证明事实正确；DocumentManifest、Binder、Ledger、Derived Rules 与 PublicationGate 仍需独立通过。

## label 规范

内部只允许：

- `title`
- `paragraph`
- `list_item`
- `table_row`
- `header`
- `footer`
- `caption`
- `formula`
- `figure_text`

provider raw label 到内部 label 的映射必须是版本化闭表。新增或未知 label 不能映射成通用 paragraph 后继续，而应返回 `GLM_OCR_RESPONSE_INVALID`，经独立 schema/金标变更后才能扩表。

`title / header / footer / caption / formula / figure_text` 必须使用 `recordMembership=non-record`，不得伪装为 `single-record`。`table_row` 必须是 `logical-table-row`；只有 paragraph/list_item 在证据确实闭合时才可能是 `single-record`。

## Parse 前资源上限

这些上限在读取 raw body/markup 时执行，不能等完整构造 DOM 后再检查：

| 机器字段 | 上限 |
|---|---:|
| `rawResponseMaxBytesPerPage` | 16,777,216 bytes |
| `regionsPerPageMax` | 5,000 |
| `rawRegionContentMaxChars` | 200,000 chars |
| `htmlMaxBytesPerRegion` | 1,048,576 bytes |
| `htmlMaxNodesPerRegion` | 10,000 |
| `htmlMaxDepth` | 32 |
| `htmlMaxAttributesPerNode` | 32 |
| `htmlMaxAttributeBytes` | 2,048 bytes |
| `tableRowsPerRegionMax` | 10,000 |
| `tableCellsPerRowMax` | 256 |

超限必须在 DeepSeek 前返回 `GLM_OCR_RESPONSE_INVALID`，不能截断后标记 complete。

## HTML 与内容安全

- raw table parser 只允许无脚本结构标签 `table/thead/tbody/tr/th/td` 和必要属性 `rowspan/colspan`；其他标签、style、`on*=`、`href/src/xlink:href=`、CSS `url(...)`、网络、外部实体和动态代码执行全部拒绝；
- parser 输出 logical row/cell 后丢弃全部 markup；normalized schema 的 `page.text / block.text / cell.text` 拒绝任意 HTML tag，包括 raw 阶段允许的 table 标签；
- 只接受有界 UTF-8/Unicode 文本，拒绝 NUL、非法编码、超大嵌套、超大属性和超过上限的内容；
- table markup 解析后只保留 logical row/cell 纯文本及 span；原始 markup 不进入内部合同；
- provider response body、OCR text、bbox 和布局内容不得写日志；
- 不保存或下载 `layout_visualization`、crop image 或 provider 资源 URL。

## 官方能力边界

智谱公开文档说明该接口支持 URL/base64 的 PDF、JPG、PNG，单图不超过 10 MB、PDF 不超过 50 MB、最多 100 页，并返回 region 级 `index / label / bbox_2d / content`。本系统进一步收紧为逐页内存 JPEG、每页小于 9 MiB，不采用公开 URL，也不把 region 级信息升级为字符/cell 几何。

参考：

- [智谱文档解析 API](https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E6%96%87%E6%A1%A3%E8%A7%A3%E6%9E%90)
- [智谱 GLM-OCR 模型说明](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-ocr)
