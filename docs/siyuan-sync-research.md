# 思源笔记数据同步机制调研

## 范围与版本

本文只依据思源笔记官方源码与官方仓库文档。调研基线为 SiYuan `44a6c212a994c7ba8129fc38b001a9ab58957c6f`；该版本在 [`kernel/go.mod`](https://github.com/siyuan-note/siyuan/blob/44a6c212a994c7ba8129fc38b001a9ab58957c6f/kernel/go.mod#L75) 固定使用 DejaVu `56b6bf7abb5b77895323c656eb4972cbe9678877`。移动生命周期另核对 SiYuan Android `97580e0cb720eca11b77a72d9a64df56edfd58cb` 和 SiYuan iOS `26bfa3f70b5c58000b91991795778dd0d9e0f748`。DejaVu 是思源官方的数据快照与同步组件，其官方说明将核心模型概括为 Git 式版本控制、文件分块去重、压缩、加密、快照索引与 `latest` 引用。[DejaVu 设计说明](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/README.md#L23-L51)

## 结论摘要

1. 思源不是把文件系统事件直接变成一份持久化的“待上传文件列表”。应用内的编辑、删除、资源变更只把下一次同步重新安排到配置间隔之后；真正同步前会刷新编辑事务，然后扫描完整数据目录，与本地最新快照比较。
2. 正常多设备同步依赖三个版本做逐路径合并：`latest-sync`（上次成功同步的共同基线）、本地最新快照和云端最新快照。旧设备上的文件若自基线后没有修改，而云端已经删除，云端删除会胜出，因此不会复活。
3. DejaVu 没有独立的永久删除墓碑。删除由“文件存在于共同基线、但不再存在于某个完整快照”表达。这能解决正常的离线设备回归，但如果本地 `latest-sync` 丢失而旧文件仍在，源码会把旧文件视为本地新增；这是从源码推导出的缓存丢失边界。当前插件的永久删除记录比这更强，不应改回思源的隐式删除模型。
4. 同一进程内使用互斥锁串行化快照、签出和同步；云端使用带设备 ID 和过期时间的租约文件避免设备同时发布。内容对象和索引先上传，最后更新 `refs/latest`，所以中途失败通常只留下未被引用的对象，不会让 `latest` 指向缺失内容。
5. 大文件在快照层被切成内容寻址的分块；只上传和下载缺失分块，并限制并发数。它不是 S3 Multipart Upload，也没有显式的持久化传输续传队列。失败后由后续同步重新计算所需对象，并复用已经进入内容寻址对象库的分块。
6. 对当前插件最值得立即移植的是“运行中再次请求不得丢失”的请求合并状态机。修复前，`syncNow()` 在已有同步运行时只返回同一个 Promise，没有记录“完成后必须再跑一次”；如果本地修改事件在长同步期间触发，5 秒定时器到期后会被吞并，只能等待下一次 2 分钟轮询。这是本次“电脑已修改，安卓没看到”最可信的机制级原因，并已按本文建议修复。

## 1. 本地改动如何检测与排队

### 改动事件只负责标记“需要同步”

思源在编辑事务提交后调用 `IncSync()`；资源文件监听器也会在写入事件后调用它。[事务提交入口](https://github.com/siyuan-note/siyuan/blob/44a6c212a994c7ba8129fc38b001a9ab58957c6f/kernel/model/transaction.go#L2582-L2607) [资源监听入口](https://github.com/siyuan-note/siyuan/blob/44a6c212a994c7ba8129fc38b001a9ab58957c6f/kernel/model/assets_watcher.go#L64-L101)

`IncSync()` 本身不保存文件路径，而是把连续无变化计数清零，并将下一次同步设为“当前时间 + 配置间隔”。后台任务每 5 秒检查是否到期。[`IncSync` 与计划时间](https://github.com/siyuan-note/siyuan/blob/44a6c212a994c7ba8129fc38b001a9ab58957c6f/kernel/model/sync.go#L923-L931) [5 秒调度任务](https://github.com/siyuan-note/siyuan/blob/44a6c212a994c7ba8129fc38b001a9ab58957c6f/kernel/job/cron.go#L29-L34)

这是一种“脏标记 + 截止时间”模型，不是逐文件传输队列。无变化同步会指数延长下一轮时间，有本地改动时再恢复用户设置的间隔。[无变化退避](https://github.com/siyuan-note/siyuan/blob/44a6c212a994c7ba8129fc38b001a9ab58957c6f/kernel/model/repository.go#L2288-L2299)

### 同步前执行完整扫描

进入云同步前，内核先刷新待提交事务，再调用 DejaVu `Index` 创建本地快照。[同步前索引](https://github.com/siyuan-note/siyuan/blob/44a6c212a994c7ba8129fc38b001a9ab58957c6f/kernel/model/repository.go#L2660-L2673) DejaVu 会遍历整个数据目录，并把路径、大小和修改时间收集为文件描述；随后与上一个本地 `latest` 快照比较，找出新增、变化和缺失路径。[完整扫描与快照差异](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/repo.go#L900-L948) [差异与新索引生成](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/repo.go#L950-L1079)

因此，文件系统事件即使漏报，只要后续仍有启动、手动或周期同步，完整扫描仍能发现变化；事件不承担正确性的唯一责任。

### 运行期间到达的新请求不会丢失

思源为自动、手动、退出、仅上传和仅下载分别保存 `requested` 与 `completed` 计数。新的调用先增加请求序号，再等待同步互斥锁；拿到锁后如果该请求尚未被前一轮覆盖，就执行一轮同步。这让“同步进行中又发生修改”至少触发一次后续同步，同时允许多个重复请求合并成一轮。[请求合并状态机](https://github.com/siyuan-note/siyuan/blob/44a6c212a994c7ba8129fc38b001a9ab58957c6f/kernel/model/sync.go#L247-L296)

这比修复前插件的单个 `runningSync` Promise 更可靠。本次已加入串行请求队列：运行中收到任何本地事件、前台事件、手动同步或定时检查时只置位；当前轮结束后继续执行，直到没有新请求。批量删除确认是安全例外：若同步正在运行，必须等新计划生成后重新确认，避免把旧授权用于已经变化的删除集合。

### 不应照搬的检测细节

DejaVu 的 `File.ID` 由路径和“秒级修改时间”生成，快照初筛也只按路径与秒级修改时间判断文件是否相同；内容相等判断则使用大小和分块 ID。[文件 ID](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/entity/file.go#L26-L49) [文件与内容相等规则](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/diff.go#L142-L168) 对 Obsidian 插件而言，继续以 SHA-256 内容哈希作为最终变化依据更安全；`mtime + size` 只能作为避免重复读取的缓存提示，不能作为长期正确性依据。

## 2. 多设备版本、快照、事务与锁

### 三个版本构成逐路径三方合并

每个 DejaVu `Index` 是某一时刻全部文件 ID 的完整列表，并带设备 ID、设备名、系统和创建时间。[Index 结构](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/entity/index.go#L29-L46)

同步时分别读取：

- `latest-sync`：本设备上次成功同步后记录的共同基线；
- `latest`：本设备同步前完整扫描产生的本地版本；
- 云端 `refs/latest` 指向的远端版本。

源码用这三组文件按路径分类为未变化、仅元数据变化、更新或删除，再决定每条路径采用本地或云端版本。[读取共同基线与三方分类](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/sync.go#L350-L405) [逐路径分类实现](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/sync_merge.go#L94-L175)

### 为什么正常的旧设备不会复活已删除文件

设共同基线中存在 `A.md`：

| 共同基线 | 旧设备本地 | 云端 | 结果 |
|---|---|---|---|
| 存在 | 原样存在 | 已删除 | 云端删除胜出，删除旧设备本地文件 |
| 存在 | 已修改 | 已删除 | 编辑/删除冲突；思源保留本地修改并再次发布，同时保存历史 |
| 存在 | 已删除 | 已修改 | 删除/编辑冲突；思源采用本地删除，同时保存云端版本历史 |

官方同步场景测试覆盖了“远端删除在旧客户端应用”和“远端删除与本地编辑冲突后保留本地编辑”。[远端删除测试](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/test/sync/testdata/cases/basic/config.json#L146-L179) 决策源码明确区分本地删除/云端更新、本地更新/云端删除和双端更新。[冲突决策](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/sync_merge.go#L190-L219)

这里的关键不是文件修改时间，而是共同基线证明“旧设备上的这个文件是旧版本，并非新创建”。

### 删除记录的边界

DejaVu 的最新索引只列出当前存在的文件；删除记录没有作为永久实体保存在最新索引里，而是通过相邻快照和 `latest-sync` 共同基线的集合差表达。成功合并后，本地 `latest` 和 `latest-sync` 都更新到最终索引。[成功后的引用更新](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/sync.go#L673-L745)

源码在找不到 `latest-sync` 时返回空索引。[缺少共同基线的行为](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/sync.go#L1774-L1802) 结合逐路径分类可推导：如果同步仓库状态丢失但旧数据文件仍在，本地文件会被视为“从空基线新增”，而云端删除只是“仍为空”，本地版本可能重新发布。这是基于源码的推论，不是官方承诺的故障场景。

当前插件不应照搬这一点。它已经把删除保存为带稳定 Entry ID 的永久加密状态，即使本地缓存丢失也能从远端快照恢复删除知识；这正好覆盖了 DejaVu 隐式删除模型的边界。

### 本地串行化与云端发布

DejaVu 使用进程级互斥锁，避免 `Checkout`、`Index` 与 `Sync` 同时运行。[仓库互斥锁](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/repo.go#L107-L109) 云端变更前会尝试取得 `lock-sync` 租约；锁每 30 秒刷新，65 秒后可视为过期，冲突时最多重试三次、每次等待 5 秒。[云端租约](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/sync_lock.go#L62-L133)

一次发布先上传内容对象和文件对象，然后上传不可变索引，最后更新 `refs/latest`。索引与 `refs/latest` 的顺序在代码中被明确要求。[最终引用发布顺序](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/sync.go#L775-L811) 对 S3 和思源云，代码还写入递增序号的 `refs/latest-<seq>-<id>`，用于发现被缓存的旧 `refs/latest`，并在不一致时比较索引创建时间。[缓存旧引用防护](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/sync.go#L813-L845) [读取时交叉校验](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/sync.go#L1968-L2047)

需要注意，DejaVu 的 S3 `lock-sync` 是先读取再普通覆盖写入，没有展示 S3 条件写，因此它不如当前插件的 `If-Match` Head CAS 严格。[锁的读取与普通上传](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/sync_lock.go#L95-L102) [S3 PutObject 实现](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/cloud/s3.go#L52-L83) 当前插件应保留“不可变对象先写、最后以 ETag 条件更新 Head”的设计，不需要换成远端租约文件。

## 3. 启动、前台与远端变化触发

思源桌面和移动内核都在加载笔记本前调用 `BootSyncData()`；移动端完成启动同步后才继续初始化笔记本。[移动端启动顺序](https://github.com/siyuan-note/siyuan/blob/44a6c212a994c7ba8129fc38b001a9ab58957c6f/kernel/mobile/kernel.go#L274-L300) 启动同步会并行执行本地索引和远端最新版本预取，再在后台完成合并。[启动同步实现](https://github.com/siyuan-note/siyuan/blob/44a6c212a994c7ba8129fc38b001a9ab58957c6f/kernel/model/repository.go#L1929-L2053)

SiYuan Android 的原生 Activity 在进入前台和进入后台时都会调用同步 API；内核 API 将该请求标记为 `mobileSwitch`，确认内核已启动且同步已启用后执行同步。[Android 前后台回调](https://github.com/siyuan-note/siyuan-android/blob/97580e0cb720eca11b77a72d9a64df56edfd58cb/app/src/main/java/org/b3log/siyuan/MainActivity.java#L1425-L1443) [Android 同步请求](https://github.com/siyuan-note/siyuan-android/blob/97580e0cb720eca11b77a72d9a64df56edfd58cb/app/src/main/java/org/b3log/siyuan/MainActivity.java#L1576-L1613) [内核前后台同步入口](https://github.com/siyuan-note/siyuan/blob/44a6c212a994c7ba8129fc38b001a9ab58957c6f/kernel/api/sync.go#L456-L481)

SiYuan iOS 在应用重新进入前台或活跃时检查内核；如果内核已被系统终止，则重新启动内核，随后走启动同步。该原生代码没有在“内核仍存活”分支显式调用同步 API，因此跨平台插件仍需要自己的前台可见事件兜底。[iOS 前台通知注册](https://github.com/siyuan-note/siyuan-ios/blob/26bfa3f70b5c58000b91991795778dd0d9e0f748/siyuan-ios/ViewController.swift#L187-L197) [iOS 前台内核检查](https://github.com/siyuan-note/siyuan-ios/blob/26bfa3f70b5c58000b91991795778dd0d9e0f748/siyuan-ios/ViewController.swift#L815-L830)

同步模式语义为：自动模式执行启动、退出、定时和手动同步；手动模式仍执行启动、退出和手动同步；完全手动模式只响应手动操作。[模式检查](https://github.com/siyuan-note/siyuan/blob/44a6c212a994c7ba8129fc38b001a9ab58957c6f/kernel/model/sync.go#L342-L349) 默认自动间隔是 30 秒，设置范围为 30 秒到 12 小时。[默认配置](https://github.com/siyuan-note/siyuan/blob/44a6c212a994c7ba8129fc38b001a9ab58957c6f/kernel/conf/sync.go#L19-L45) [间隔范围](https://github.com/siyuan-note/siyuan/blob/44a6c212a994c7ba8129fc38b001a9ab58957c6f/kernel/model/sync.go#L530-L540)

思源官方云还支持 WebSocket 同步感知：一台设备发布变化后通知其他在线内核，接收端触发仅下载同步。[同步感知接收](https://github.com/siyuan-note/siyuan/blob/44a6c212a994c7ba8129fc38b001a9ab58957c6f/kernel/model/sync.go#L1053-L1059) 该连接只在思源官方 Provider 下建立，不适用于第三方 S3。[Provider 限制](https://github.com/siyuan-note/siyuan/blob/44a6c212a994c7ba8129fc38b001a9ab58957c6f/kernel/model/sync.go#L983-L990)

对当前纯 S3 插件而言，没有服务器推送通道，所以正确体验应明确为：

- Obsidian 启动或布局就绪后立即检查；
- 移动应用每次回到前台立即检查；
- 前台期间定时读取 Head；
- 本地变更在短防抖后请求同步；
- 任何请求若撞上正在运行的同步，必须保证结束后再跑一轮。

当前插件已有启动、回到前台、2 分钟检查和 5 秒本地防抖；本次补齐了最后一条可靠请求合并。

## 4. 冲突与删除处理

DejaVu 对同一路径做三方分类，能够识别三类逻辑冲突：双端编辑、本地删除/云端编辑、本地编辑/云端删除。[冲突类型](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/sync_merge.go#L28-L57)

被舍弃的版本会写入同步历史；如果用户开启“生成冲突文档”，`.sy` 冲突还会生成一个可见副本。[历史保存](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/sync.go#L493-L518) [可选冲突文档](https://github.com/siyuan-note/siyuan/blob/44a6c212a994c7ba8129fc38b001a9ab58957c6f/kernel/model/repository.go#L2225-L2285)

但思源并不是“所有冲突暂停并等待用户决定”。双端编辑通常保留本地版本，若本地版本比云端旧超过 7 分钟则选择云端；编辑/删除冲突也可能自动选择本地并重新发布。该策略显式依赖设备文件时间。[胜者与 7 分钟阈值](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/sync_merge.go#L149-L219) [时间阈值](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/sync_merge.go#L236-L250)

当前插件的方向更适合用户提出的安全要求：编辑/删除保留删除状态和候选内容，必须显式选择恢复；编辑/编辑仅在有共同基线且 Markdown 三方合并无冲突时自动合并；设备时钟不决定因果关系。应借鉴思源的三方分类和历史保留，但不应复制其“本地优先 + 7 分钟时间阈值”。

## 5. 大文件、分块与重试

DejaVu 的文件记录包含有序 Chunk ID 列表，Chunk 以内容哈希寻址。[文件与分块结构](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/entity/file.go#L26-L45) 大于分块器最小尺寸的文件使用固定多项式进行内容定义分块，每块按哈希写入对象仓库；读取后再次检查文件大小和修改时间，发现扫描期间变化则让整次索引重试。[文件分块](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/repo.go#L1210-L1308) 索引遇到“读取过程中改变”最多重试 7 次。[索引重试](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/repo.go#L882-L897)

同步只计算本地缺失的文件对象和分块对象，并以可配置并发池下载或上传；遇到首个错误会快速失败。[缺失对象计算](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/sync.go#L1626-L1661) [并发分块上传](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/sync.go#L1560-L1623) [并发分块下载](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/sync.go#L1016-L1069)

S3 Provider 对每个 DejaVu 对象执行普通 `PutObject` 和 `GetObject`，下载单个对象时仍会完整读入内存。[S3 上传与下载](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/cloud/s3.go#L52-L134) 它通过“应用层文件分块”限制单个对象大小，而不是通过 Range GET 或 Multipart Upload 传输一个大对象。

下载成功的分块会立即写入本地内容寻址对象库，所以下一轮可跳过本机已有分块；上传在 Head 发布前失败时，下一轮仍可能对已经上传但尚未被旧 Head 引用的同名对象重新执行幂等 PUT。DejaVu 源码没有显示持久化的分块传输进度或可恢复 Multipart Upload ID。可安全借鉴的是内容寻址分块和幂等对象，而不是笼统地把它称作断点续传。当前插件刚加入的 Android Range GET 与 Multipart Upload 解决的是桥接层内存峰值；若未来要获得 DejaVu 式去重和天然重试粒度，需要引入新的 Blob Manifest 和独立加密 Chunk 对象，属于协议 v2 迁移，不能作为这次同步触发问题的顺手修补。

## 6. 对当前 Obsidian S3 插件的具体建议

### 本次实施

1. **可靠合并同步请求。** 已增加串行请求队列。同步运行中收到本地变更、手动同步、前台唤醒或定时检查时，会标记后续轮次；当前轮结束后继续执行，直到请求已全部覆盖。
2. **为触发合并补集成测试。** 已覆盖第一轮同步完成发布但仍被人为阻塞、电脑再次修改并请求同步、第二轮发布最新内容、另一个 Replica 最终下载最新版的完整链路。

### 随后实施

1. 状态页显示本机最后接受的 `generation/commitId`、S3 当前 Head 的 `generation/commitId`、本轮开始/完成时间和是否还排队一轮，以区分“电脑未发布”和“安卓未拉取”。
2. 真机覆盖“安卓回到前台时已有远端新 Head”的应用生命周期路径；目前自动测试通过直接执行另一个 Replica 的同步来验证最终内容。
3. 对最近收到 `modify` 事件的路径强制重新计算哈希，即使 `mtime + size` 看起来相同；缓存只能优化读取，不能让修改永久不可见。
4. 将远端内容验证通过后先写临时文件，再原子替换或以 Obsidian 可支持的最接近方式替换目标。DejaVu 的签出会写临时文件、`fsync`、关闭后再重命名，并在 Windows 锁文件失败时重试三次。[安全签出](https://github.com/siyuan-note/dejavu/blob/56b6bf7abb5b77895323c656eb4972cbe9678877/repo.go#L1438-L1498)
5. 网络瞬态错误采用有上限的指数退避和抖动；仍由下一轮完整扫描恢复，不维护庞大的逐文件待传输清单。

### 保留当前方案，不照搬思源

1. 保留永久加密删除记录，不能降级为“只在完整快照中缺席”。
2. 保留 S3 ETag 条件更新 Head；不要换成先读后写的 `lock-sync` 文件。
3. 保留显式编辑/删除冲突决策；不要用设备时间或 7 分钟阈值自动复活/覆盖。
4. 保留随机远端对象名和加密元数据；DejaVu 的路径与时间元数据模型不符合当前插件已经确定的隐私要求。
5. 内容定义分块作为独立协议升级评估；当前 Android 传输分块继续使用现有 Range GET 与 Multipart Upload。

## 针对当前故障的验证顺序

1. 在电脑端修改一个小型 Markdown 文件，记录电脑插件显示的发布后 `generation/commitId`。
2. 直接读取 S3 Head，确认它与电脑端一致；若不一致，问题在电脑端触发或发布。
3. 将安卓切到后台再回前台，确认立即开始检查，并记录其读取到的 Head；若仍是旧值，问题在远端读取或配置绑定。
4. 若安卓已读到新 Head 但文件没变化，检查同步计划是否将其列为下载、延迟、冲突或路径不支持。
5. 专门复现“电脑正在长同步时再次修改文件”；如果第二次修改只有等到 2 分钟轮询才出现，即可验证丢失的运行中触发。
