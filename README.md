# duanju-h5

移动端短剧 H5：分类浏览 + 竖屏沉浸播放（上下滑切集），Vue 3 + Vite + hls.js，Node/Express 提供数据与媒体托管。

## 页面与演示内容

首页采用深色剧场布局：1220px 居中内容区、推荐轮播、9:16 竖版剧集卡片和分类分区。详情页包含剧集介绍、分类信息、好评率、收藏分享、20 集分组选集；支持搜索、排序、分页与本地观看记录。

当前剧集来自本地 downloads 中已筛选的作品，按“成人短剧”和“成人漫剧”归入对应栏目。详情介绍、标签、日期等从各作品的 `metadata.json` 提取；视频使用本地完整 MP4，没有完整视频的作品仍保留介绍并显示“待更新”。封面优先使用从本地视频中选定的非露骨静帧，缺少合适画面时使用统一的风景设计海报。设计海报带有“剧场海报”标识，并非作品原始封面；图片内嵌在 SVG 中，无需请求外部图片。封面来源记录在 `data/local-cover-sources.json`，风景素材来源见 `public/posters/sources.json`。之前的演示目录保存在 `data/backups/`。

## 快速开始

需要 Node.js 22.13 或更新版本（会员数据使用 MySQL）。

```bash
npm install
npm run dev        # 前端 http://localhost:5173 ，后端 http://localhost:3001
```

生产部署：

```bash
npm run build      # 产出 dist/
npm start          # 后端同时托管 dist/ ，访问 http://localhost:3001
```

## VIP 会员与加密货币充值

访问 `/vip` 或点击导航中的 VIP 入口。先注册邮箱账号并登录，再选择月卡（30 天 / 10 U）、半年卡（180 天 / 20 U）或年卡（365 天 / 20 U），使用 USDT 在 TRON（TRC20）网络转账支付。U 指 USDT；页面显示由 NOWPayments 生成的订单收款地址及准确应付数量，转账网络手续费由付款方另付，实际到账需达到套餐金额。套餐均为一次性购买，不自动续费，续费天数从当前有效期末尾累加；已经过期则从确认付款时间开始计算。

会员页面显示会员有效期、充值记录和订单状态。只有服务端验证支付通知、订单归属、金额及币种后才开通会员；仅返回成功页面不会开通。链上确认期间可以回到会员中心查询。少付、失败或需核对的订单不会自动开通，用户应保留订单号和交易哈希联系站点运营者核对。

### 配置收款

1. 复制 `.env.example` 为 `.env`，在 NOWPayments 商户后台创建 API Key、配置 IPN Secret，分别填写 `NOWPAYMENTS_API_KEY`、`NOWPAYMENTS_IPN_SECRET`。密钥仅放在服务端。不启用 NOWPayments 时留空即可。
2. 设置 `APP_URL` 为网站的公网 HTTPS 地址，例如 `https://drama.example.com`。NOWPayments 每笔支付自动指定通知地址 `${APP_URL}/api/payments/nowpayments/ipn`，需允许支付平台访问该 POST 接口。商户需开通 USDT TRC20 收款，并确保平台最低支付金额支持 10 USDT。反向代理将 `/api` 转发到 Node 服务，网站与 API 使用同一来源。
3. VaeHub 通道（法币代收，与 NOWPayments 的 USDT 错开）：找商务获取接口地址（`VAEHUB_API_BASE`，如 `https://xxxx.top/api`）、`VAEHUB_APP_KEY` 与 `VAEHUB_APP_SECRET`，按 `.env.example` 填写 `VAEHUB_COUNTRY`（**ISO3 三字母国家码**，如 `USA` / `SGP`，代收必填）、`VAEHUB_CURRENCY`（默认 USD）与可选的 `VAEHUB_PAYCODE`（**支付方式代码**，如 `PAYNOW_B2C`、`CASHAPP`，不是国家码；不填则由 VaeHub 自动选择），并配置 `VAEHUB_USDT_RATES_JSON`（如 `{"USD":1}`，即 1 USDT 兑换多少法币，实收金额按此换算、小数点后两位向上取整）。这三个字段任一缺失或不合规，该通道不会出现在前端支付方式列表中，服务端启动日志会打印 `[vaehub] 通道未启用，缺少：…` 说明原因。回调地址为 `${APP_URL}/api/payments/vaehub/notify`（VaeHub 全局只配一个回调地址，建单时自动带上该地址；也可在“集成配置”后台手动配置），平台会以 `Authorization: Bearer …` 签名token 推送 `payin_notify`，本站验签通过后返回纯文本 `SUCCESS`。`VAEHUB_RETURN_TYPE=cashier` 返回收银台跳转链接，`qrcode` 返回付款二维码串。下单时用户在 NOWPayments（USDT）与 VaeHub（法币）之间二选一。
4. BSC 链通道（BEP-20 USDT，自建固定地址）：无需第三方商户账号，填 `BSC_PAY_ADDRESS`（收款地址）与可选的 `BSC_TOKEN_CONTRACT`（默认 BSC 主网 USDT `0x55d398326f99059fF775485246999027B3197955`）即可启用。所有订单共用这一个地址，靠「套餐价 + 唯一金额尾数偏移」（如 `10.0123 USDT`，固定 4 位小数，尾数即订单唯一标识）区分订单，用户无需填写备注或 TxHash。支付页会展示一个**付款二维码**，内容是 EIP-681 支付 URI（`ethereum:<代币合约>@56/transfer?address=<收款地址>&uint256=<最小单位金额>`），主流钱包扫码即可预填币种、网络与金额。**订单限时 15 分钟**（`BSC_ORDER_TTL_MS`，默认 900000）：支付页显示实时倒计时，超时订单自动作废（`expired`），前端不再展示收款地址与二维码。作废订单的金额尾数仍会保留一段时间（`BSC_LATE_PAYMENT_WINDOW_MS`，默认 6 小时），期间到达的链上转账依旧认领回原订单——用户可能在截止前一刻就发起了转账，只是链上确认偏慢，钱已进收款地址不能丢弃；超过保留期后该金额才允许被新订单复用。服务端定时扫链上转账日志，按金额精确匹配订单并自动开通会员；金额不符的订单转入人工核对，绝不自动开通。该通道没有第三方回调，因此到账确认取决于轮询间隔（`BSC_POLL_INTERVAL_MS`，默认 15 秒）与链上确认数（`BSC_CONFIRMATIONS`，默认 15）。注意 BSC 上 USDT 交易量极大，公共节点对 `eth_getLogs` 的查询范围有硬限制，服务端会自动分片查询；同时务必确认用户选的是 **BNB Smart Chain** 网络，转错链（以太坊主网、TRON TRC20 等）会导致资产无法找回。
4. 执行 `npm run dev` 或构建后 `npm start`；启动命令自动加载 `.env`。没有完整支付配置时仍可注册登录和查看套餐，付款按钮保持不可用。
4. 可使用独立沙箱账号/密钥与 `NOWPAYMENTS_SANDBOX=true` 辅助调试，但 NOWPayments 已声明沙箱自 2025 年起不再持续维护，与正式环境可能不同。上线前必须使用正式账号完成小额真实支付与通知验收。测试通知同样需要能从外网访问的回调地址。

订单金额与会员天数由服务端生成，客户端不能修改。修改 `VIP_PLANS_JSON` 可调整未来订单套餐（字段 `id/name/days/price/currency/recommended`，示例见 `.env.example`），已创建订单保留购买时的价格和天数。重复提交使用幂等键，网络结果不明的订单保留供运营者核对，不盲目重复创建收款订单。

### 订单状态机

订单状态由服务端集中裁决，状态写入只有一个入口（`transitionOrder`），每次写入都要先过合法迁移表 `ORDER_STATUS_TRANSITIONS`，非法迁移一律拒绝、订单保持原状态：

| 状态 | 含义 | 说明 |
| --- | --- | --- |
| `creating` | 订单创建中 | 刚写入数据库，尚未确认收款信息 |
| `pending` | 等待支付 | 已拿到收款地址 / 收银台链接 |
| `confirming` | 支付确认中 | 渠道已受理，正在确认 |
| `partially_paid` | 待补足金额 | 到账不足 |
| `paid` | 支付成功 | 已开通会员（终态，可被 `refunded` 覆盖） |
| `failed` | 支付失败 | 确定性失败：通道业务级拒绝、HTTP 4xx、渠道明确失败 |
| `expired` | 已过期作废 | 超过支付时限，自动作废 |
| `refunded` | 已退款 | 保留墓碑，迟到回调不能翻回已支付 |
| `review` | 等待人工核实 | **结果不明**才进人工队列，不是失败 |

三条关键规则：

1. **超时必须真的作废。** 服务端每 30 秒扫一次第三方通道（VaeHub / NOWPayments）的超时订单，置为 `expired`；链上通道由自己的扫描器作废。渠道没返回有效期时用 15 分钟兜底（`PROVIDER_ORDER_TTL_MS`）。订单不再停留在 `pending`，迟到的回调也就无从把它改成 `review`。
2. **终态不会被降级。** `failed` / `expired` / `refunded` 的订单不会被迟到的回调改成「等待支付」「支付确认中」或「等待人工核实」。迟到的回调在状态机层面被直接拒绝。
3. **作废不等于丢钱。** `expired` 的订单如果之后确实收到了钱（迟到的转账、迟到的成功通知），仍然升级为 `paid` 并开通会员 —— 用户付了钱却拿不到会员比状态显示难看严重得多。唯一例外是「金额不符」：钱动了但数目不对，这类订单进 `review` 交人工核对，即使订单已过期也不会被丢弃。

「等待人工核实」只用于真正的歧义：渠道建单成功但响应无法解析、金额或币种不符、支付编号被复用。它是给人看的状态，不是失败的兜底。

### 数据与运行

会员账号、密码哈希、会话、订单和会员到期时间保存在 MySQL 的 `vip_users` / `vip_sessions` / `vip_orders` 表中，可用 `MYSQL_*` 环境变量指定连接。建表在服务启动时自动完成（`CREATE TABLE IF NOT EXISTS`），旧库会自动补齐新字段。密码使用 scrypt 加盐哈希，会话为 HttpOnly Cookie 中的随机 token（数据库只存 SHA-256 哈希），生产环境要求 HTTPS。

### 账号增强能力

以下能力全部按配置自动启用，未配置时对应入口在界面上隐藏，不影响邮箱注册登录：

- **图形验证码**：注册、找回密码必须填写；同一 IP + 邮箱连续登录失败 3 次后，登录也要求验证码（抑制撞库）。答案只存哈希、5 分钟过期、校验一次即失效。`AUTH_CAPTCHA=off` 可关闭，仅建议开发/内网环境使用。
- **邮箱验证**：配置 SMTP 后注册即需验证邮箱，未验证的账号可以登录但**不能开通会员**（下单接口返回 403）。验证链接 30 分钟有效且只能使用一次；邮件发送失败时自动标记为已验证，避免用户卡在无法登录的状态。账号面板提供「重新发送验证邮件」。
- **密码找回**：输入邮箱后发送一次性重置链接（30 分钟有效）。无论邮箱是否存在都返回相同结果，避免探测账号；重置成功后注销该账号的全部旧会话，强制重新登录。

配置项见 `.env.example` 的「账号增强能力」段：`SMTP_*` / `MAIL_FROM`。目前仅支持邮箱 + 密码登录注册，未接入第三方登录。

```bash
npm test           # 导入回归测试 + 会员/支付安全与幂等测试
npm run build      # TypeScript 检查与生产构建
```

## 中英文界面

点击页头的 `EN` / `中文` 切换界面语言，播放器中也提供切换入口。选择会保存在当前浏览器，刷新或跳转页面后保留；切换语言不重置登录、搜索、播放或充值订单状态。导航、账号、会员充值、详情和播放操作均支持英文。剧名、简介、标签及封面内文字保留原始内容，不自动翻译视频或字幕。

## 添加你的剧集

### 下载已授权的 MP4

从版权方提供的官方 API 或交付系统取得 MP4 HTTPS 直链/签名链接后，可按剧名和集数批量下载。脚本仅处理 MP4 文件，不登录网站、不解析网页播放器、不读取浏览器 Cookie，也不处理 DRM 或 HLS。它会检查 MP4 文件头，每集默认上限 20 GiB；已存在的目标文件不会覆盖。任务中断后加 `--skip-existing` 可跳过成功下载的文件继续。

```json
{
  "version": 1,
  "items": [
    { "title": "示例剧名", "episode": 1, "url": "https://media.example/episode-01.mp4?signature=授权方签发的临时签名" },
    { "title": "示例剧名", "episode": 2, "url": "https://media.example/episode-02.mp4?signature=授权方签发的临时签名" }
  ]
}
```

将清单保存为 `authorized-media.json`，并按本次内容选择一个栏目目录运行。例如，成人短剧可保存到 `downloads/成人短剧/<作品名>/`：

```bash
npm run download:authorized -- ./authorized-media.json ./downloads/成人短剧
# 断点续跑，跳过已经成功下载的文件
npm run download:authorized -- ./authorized-media.json ./downloads/成人短剧 --skip-existing
```

下载后会生成 `downloads/成人短剧/<作品名>/第01集.mp4`。在该目录补上版权方提供的 `metadata.json`，然后以 `downloads/` 作为来源运行现有的 `npm run import:manifest` 与 `npm run import:downloads`。成人漫剧请将输出目录改为 `downloads/成人漫剧`。签名链接通常会过期，请从授权方重新取得；不要将签名链接提交到 Git。

### 导入本地下载目录

目录格式为 `downloads/栏目名/作品名/metadata.json`，视频文件名为 `第01集.mp4`、`第02集.mp4` 等。清单 `data/local-import-manifest.json` 记录本次筛选结果及元数据摘要，只有标记为 `include` 且摘要未变的作品会导入。变更介绍或增加作品后应先更新筛选清单。

```bash
# 预览导入数量，不修改文件；需要 ffprobe（随 ffmpeg 安装）
npm run import:downloads -- /Users/zhangchaoyin/zhangzhaoyin/go_items/go_test/downloads
# 写入数据和视频链接，保留目录中其他手工添加的剧集
npm run import:downloads -- /Users/zhangchaoyin/zhangzhaoyin/go_items/go_test/downloads --apply
```

上面的 npm 命令在 `duanju-h5` 项目目录运行。如果把脚本复制到了 `go_test/`，可以在 `go_test` 下指定目标网站项目：

```bash
node import-downloads.mjs ./downloads \
  --project /Users/zhangchaoyin/zhangzhaoyin/node_project/duanju-h5 \
  --apply
```

`./downloads` 相对于当前终端目录；`--project` 决定从哪里读取导入清单、把剧集和媒体链接写到哪里。无需复制网站项目的数据文件到下载目录。运行 `node import-downloads.mjs --help` 可查看参数。

脚本只连接通过检查的完整 MP4，不使用 metadata 中指向网页的集数地址，不导入分片文件。没有完整 MP4 的作品保留在目录中，不生成虚假的选集链接。`public/posters/imported/<id>.jpg` 中已选定的图片会在再次导入时保留。

`media/imported/` 为指向原视频的符号链接，原下载目录需要保留；部署到其他机器时需同时迁移媒体，或在该机器重新运行导入。每次目录变化前自动备份，结果、待补视频和跳过原因见 `data/local-import-report.json`。`--replace-catalog` 可在已确认需要替换整个剧集目录时使用。

更新封面后运行 `npm run covers:sync -- --apply`，可将已记录来源的本地 JPG 同步到剧集资料，并给缺图条目生成设计海报；不加 `--apply` 仅预览。导入脚本使用相同模板，已选定 JPG 不会被替换。新版设计海报使用 `.designed-v1.svg` 文件名，避免浏览器长期缓存旧占位图。列表、轮播和详情页统一使用图片加载失败兜底。

### 手工添加

1. 编辑 `data/dramas.json`（保存即热重载，不用重启）：
   - `categories`：分类列表
   - `dramas[]`：每部剧的 `id / title / cover / description / categoryIds / tags / status / episodes`
   - `channelId`：导入作品填写 `shorts` 或 `anime`，确保只显示在对应栏目
   - `episodes[].src` 支持 `.m3u8`（推荐）或 `.mp4`，可以是本地 `/media/...` 或任意外链
2. 本地视频放到 `media/` 目录，用 `/media/相对路径` 引用。
3. 把 mp4 转成多码率 HLS（弱网不卡的关键）：

```bash
npm run hls -- 输入.mp4 media/剧id/ep01
# 然后 src 填 /media/剧id/ep01/index.m3u8
```

### HLS 上传到 S3

1. 复制 `.env.example` 为 `.env`，填写 `S3_BUCKET / AWS_REGION / S3_PREFIX`（脚本自动加载 `.env`，命令行显式传参优先）。
2. `aws configure` 配好 Access Key（密钥只放 `~/.aws/credentials`，不进项目）。
3. 转码并上传：`bash scripts/batch-hls-upload-s3.sh`；把 `data/dramas.json` 的 src 批量指向 S3：`node scripts/point-dramas-to-s3.mjs --apply`。

### py_project/video 增量导入

适用于 `/Users/zhangchaoyin/zhangzhaoyin/py_project/video` 这类「剧目录 / 第0NN集.mp4」结构的片库。整条流水线按顺序执行，每步都可重复运行，已完成的会自动跳过：

```bash
npm run video:map         # 扫描目录 -> data/video-import-map.json（不入库，可重新生成）
npm run video:transcode   # 缺失的集转 HLS -> hls-output/<dramaId>/episode-<no>/
npm run video:covers      # 为新剧抽封面 -> public/posters/imported/<dramaId>.jpg
npm run video:s3          # HLS 与封面上传到 S3（只传远端缺失的）
npm run video:db          # 写入 MySQL 并合并 data/dramas.json
```

规则：

- **剧 ID**：剧名能匹配现有库存则复用原 `drama.id`，否则新建 `local-<sha256[:16]>`。重复剧只更新集数 / 封面 / 简介，不产生第二条记录。
- **集数并集**：`video/` 目录只有部分集时，保留原有库存里更多的集（例：`Accident with my Stepmom` 原有 10 集来自 `py_project/download`）。
- **播放地址**：`/s3-hls/<dramaId>/episode-<no>/index.m3u8`，走服务端私有桶中转；只有本地已产出 `index.m3u8` 的集才写地址。
- **元数据**：简介取 `all_series.csv` 的 `description`，剧集清单取 `all_episodes.csv` 里状态为 `downloaded` / `already_downloaded` 的集。
- **码率档位**：按源视频短边封顶 1080 / 720 / 480，绝不放大。

`npm run video:db` 需要 MySQL 凭据（`MYSQL_*`），未加载 `.env` 会报 `Access denied`。若本机 Node 18 不支持 `--env-file-if-exists`，用 `set -a && . ./.env && set +a` 手动导出。

## 去除视频水印

部分片源（91CRDJ.COM 一类）在画面像素里烧录了半透明文字水印，沿画面边缘匀速移动。这不是播放器叠加层，所以前端改样式无法去掉，只能在转码前处理像素。

水印在每部片源里的**字号和位置都不一样**，所以不能写死模板坐标。`scripts/wm_clean.py` 做成完全自适应：

1. **OCR 采样**：在片长上均匀取 8 帧，用 tesseract 找出所有疑似水印的横条文字框；
2. **候选择优**：每个候选框裁成模板，用 FFT-NCC 试跑追踪，命中率最高且位置分散的胜出（位置分散 = 水印在移动，排除固定字幕）；
3. **逐帧追踪**：隔帧做 FFT-NCC 定位，中间帧线性插值，得到每帧的水印坐标；
4. **逐帧修复**：用模板笔画蒙版（半透明叠加层的正高通残差）贴到水印位置，`cv2.inpaint`（Telea）修复；
5. **管道编码**：修复后的帧通过管道交给 ffmpeg（libx264 / crf 18），避免 OpenCV `mp4v` 的二次有损压缩。

```bash
# 准备环境（OpenCV 不装到系统 Python，避免污染全局）
python3 -m venv .venv-wm
.venv-wm/bin/pip install opencv-python-headless numpy

# 检测某部剧有没有水印（跨帧复现的文本 token 判定，不依赖水印具体文字）
.venv-wm/bin/python scripts/wm_detect3.py <video.mp4>

# 单集去水印
.venv-wm/bin/python scripts/wm_clean.py <video.mp4> -o clean.mp4

# 扫描 media/imported 全部剧，标记有水印的（写 data/watermark-scan.json）
.venv-wm/bin/python scripts/wm_scan_imported.py

# 批量去水印 -> media/clean/<dramaId>/episode-N.mp4
.venv-wm/bin/python scripts/wm_clean_batch.py --parallel 4

# 用去水印后的源重转 HLS（对有 clean 源的集强制重转）
node scripts/transcode-local.mjs --dry-run
node scripts/transcode-local.mjs --parallel 4

# 重传 S3（--force 覆盖旧分片）
node scripts/upload-local-s3.mjs --force
```

去水印后的源放在 `media/clean/<dramaId>/`，`scripts/video-transcode.mjs` 与 `scripts/transcode-local.mjs` 都会优先使用它（存在即用，并在 dry-run 输出里标 `[已去水印]`）。转码后按原有流程上传 S3 即可。

> **缓存注意**：S3 上的 `.ts` 分片是 `immutable` 长缓存，重传后浏览器仍可能命中旧分片。
> 换批视频后需要让客户端强制刷新，或给分片路径带上版本号（如 `seg_0000.ts?v=2`）。

多码率 HLS 的产物是 `episode-N/<tier>/index.m3u8`，服务端中转已支持档位子目录：`/s3-hls/<dramaId>/episode-N/720p/seg_0000.ts`。

## 流畅播放做了什么

- HLS 自适应码率：弱网自动降到 480p，网络好升回 1080p，不会转圈。
- 只渲染当前集 ±1，同一时刻只解码一路流。
- 播放当前集时预取下一集清单，切集接近秒开。
- 分片 4 秒、前向缓冲 30 秒、后向仅保留 10 秒，内存占用稳定。
- 服务端对 `.ts/.m4s` 分片下发一年 immutable 缓存，二次观看走本地缓存。
- `express.static` 原生支持 Range，mp4 拖动进度条不重下整个文件。

## 目录

```
data/dramas.json     剧集与分类数据
media/               视频文件（不入库）
scripts/to-hls.sh    mp4 → 多码率 HLS
server/              Express API + 静态托管
src/                 Vue 前端
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3001 | 后端端口 |
| `MEDIA_DIR` | `./media` | 媒体目录 |
| `DATA_FILE` | `./data/dramas.json` | 数据文件 |
| `APP_URL` | 无 | 网站公网 HTTPS 地址，生成支付通知地址 |
| `NOWPAYMENTS_API_KEY` | 无 | NOWPayments 服务端 API Key |
| `NOWPAYMENTS_IPN_SECRET` | 无 | 支付通知签名密钥 |
| `NOWPAYMENTS_SANDBOX` | false | 使用独立沙箱 API 与沙箱密钥 |
| `VAEHUB_API_BASE` | 无 | VaeHub 接口地址（如 `https://xxxx.top/api`） |
| `VAEHUB_APP_TAG` | project | VaeHub 应用标识，固定为 `project` |
| `VAEHUB_APP_KEY` | 无 | VaeHub 服务端 App Key |
| `VAEHUB_APP_SECRET` | 无 | VaeHub 服务端 App Secret |
| `VAEHUB_CURRENCY` | USD | VaeHub 代收法币币种 |
| `VAEHUB_COUNTRY` | 无 | VaeHub 代收国家（ISO3 三字母码，如 USA / SGP），必填 |
| `VAEHUB_USDT_RATES_JSON` | 无 | VaeHub 法币汇率（如 `{"USD":1}`），缺失则该通道不可用 |
| `VAEHUB_PAYCODE` | 无 | VaeHub 支付方式代码（如 PAYNOW_B2C、CASHAPP），不填则自动选择 |
| `VAEHUB_RETURN_TYPE` | cashier | `cashier`=收银台链接，`qrcode`=付款二维码串 |
| `BSC_PAY_ADDRESS` | 无 | BSC 链自建固定收款地址，配置后启用该通道 |
| `BSC_TOKEN_CONTRACT` | `0x55d398326f99059fF775485246999027B3197955` | BSC 主网 USDT（Binance-Peg）合约 |
| `BSC_TOKEN_SYMBOL` | USDT | 收款代币符号（仅展示用） |
| `BSC_TOKEN_DECIMALS` | 18 | 收款代币精度 |
| `BSC_CHAIN_ID` | 56 | BSC 主网 Chain ID |
| `BSC_DISPLAY_DECIMALS` | 4 | 应付金额展示精度（固定小数位，尾数即订单标识） |
| `BSC_OFFSET_MAX_STEPS` | 100 | 金额尾数偏移步数上限，决定应付金额最多比套餐价多多少 |
| `BSC_CONFIRMATIONS` | 15 | 开通会员前要求的链上确认数 |
| `BSC_POLL_INTERVAL_MS` | 15000 | 链上到账扫描间隔 |
| `BSC_ORDER_TTL_MS` | 900000 | 订单有效期（15 分钟），超时订单自动作废 |
| `BSC_LATE_PAYMENT_WINDOW_MS` | 21600000 | 订单作废后仍认领迟到转账的宽限期（6 小时），期间金额尾数不被新订单复用 |
| `BSC_LOOKBACK_BLOCKS` | 200 | 进程重启后回溯扫描的区块数 |
| `BSC_RPC_URL` | 多个公共 RPC | BSC 链 RPC 地址，多个用逗号分隔 |
| `S3_BUCKET` | `duanju-h5-hls-473041657070` | HLS 上传目标桶（上传与指链脚本共用，自动读 `.env`） |
| `AWS_REGION` | `ap-northeast-1` | S3 区域 |
| `S3_PREFIX` | `hls` | S3 前缀目录 |
| `VIP_DB_FILE` | `./data/vip.sqlite` | 会员与订单 SQLite 数据库 |
| `VIP_PLANS_JSON` | 10 / 20 / 20 U | 自定义套餐 JSON 数组，见 `.env.example` |

请只上架你拥有版权或已获授权的内容。
