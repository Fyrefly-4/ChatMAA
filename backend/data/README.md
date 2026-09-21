# 规划资料快照

2026-09-21，D3 本地资料导入基线。`catalog-cn.json` 保存公开资料的必要标识、名称、消耗、普通掉落关系和历史统计，不包含用户库存、账号信息、截图或游戏资源文件。运行时只读本地快照，资料获取与激活是独立维护操作。

## 来源与覆盖

| 来源 | 固定依据 | 用法 |
|---|---|---|
| [ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData/tree/bb8f9ac8db143a661577ed6ef5184d3c6e93d1d0/zh_CN/gamedata/excel) | `bb8f9ac8db143a661577ed6ef5184d3c6e93d1d0` 的 stage_table、item_table | 国服材料名称、普通关卡条件、重复掉落、材料表候选顺序 |
| [MAA 资源](https://github.com/MaaAssistantArknights/MaaAssistantArknights/tree/v6.17.5/resource) | `v6.17.5` 的 stages.json、item_index.json | 核对关卡 ID、关卡码、理智消耗、材料 ID 及普通／额外掉落关系 |
| [企鹅统计 Matrix API](https://developer.penguin-stats.io/public-api/zh/api-v2-instruction/matrix-api) | CN public matrix，实际获取时间写入 sources | 历史产量均值，仅作参考；不上传用户执行数据 |

本次导入保留 249 个无歧义关卡条目、60 个材料条目、2,175 条适用关系、2,149 组参考统计和 38 个默认候选。默认候选沿用游戏材料表 `stageDropList` 顺序中的首个已核验常驻关卡，不进行效率排序，也不称为最优。未覆盖默认候选的材料仍可从适用关系中指定关卡。

导入要求两份关卡资料的 ID、码及消耗一致，筛选可代理的 MAIN／SUB／DAILY 普通难度；材料关系必须同时出现在两源的重复掉落集合。首次奖励、突袭／特殊难度、活动和剿灭不作为本快照默认规划依据。同码多记录不能明确区分时整组暂不导入。367 个 MAA 条目因此未进入快照；该数字是资料筛选结果，不是执行端不支持的数量。显式次数目标不因为缺少推荐资料而被拒绝。

DAILY 条目标记为 scheduled，不能宣称当前开放；常驻关卡仍须满足账号解锁和可用代理条件。静态资料与 MAA 收录不证明现场导航或游戏执行成功。

参考统计须单个窗口、至少 100 次样本且数量有效；重复窗口不相加。100 是避免极少样本的导入门槛，不构成统计精度保证。`end=null` 保留源语义，`asOf` 为实际获取时点，不虚构统计结束时间。缺统计时仍可形成适用方案，但明确无法可靠估算；参考产量不用于设置材料任务的次数上限。

快照的 `version` 是除自身之外内容的 SHA-256；每个来源另保存原始下载字节摘要、URL、版本和获取时间。后续业务装配使用该版本标识保存方案依据。

## 显式更新

以下命令只读取公开资料和生成候选文件，不连接游戏；在仓库根目录运行。选择一个已核对的完整游戏数据提交 SHA，不使用漂移的分支名。

```powershell
node backend/src/business/catalog-fetch.ts .artifacts/catalog-update <游戏资料40位SHA> v6.17.5
node backend/src/business/catalog-import.ts .artifacts/catalog-update .artifacts/catalog-update/manifest.json .artifacts/catalog-update/catalog.json
```

若 raw.githubusercontent.com 直连不可用，可以在第一条末尾加 `--github-cli`，使用本机已配置的 `gh` 只读下载 GitHub 文件；企鹅统计仍通过其公开 HTTPS API 获取。工具不修改远端，也不自动重试失败请求。下载未完成不会写入新清单；导入检查所有摘要和结构，失败不替换输出文件。

导入、选择与估算实现见 [catalog.ts](../src/business/catalog.ts)、[catalog-import.ts](../src/business/catalog-import.ts)、[catalog-fetch.ts](../src/business/catalog-fetch.ts)。本提交提供离线资料与目标计算，尚未接入业务入口。
