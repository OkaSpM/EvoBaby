# EvoBaby · 荒野伪记忆

五位成员在 8×8 荒野中各自探索、交换经验。玩家决定部落如何处理反例、验证新说法，并追查两次伪记忆的源头。

## 当前 B 版

- Three.js 连续 64 格荒野、本地 Tripo 3D 模型、五色身份与四阶成长。
- 协作调查展示证据贡献，以及反例、公开发现、规则修复、玩家指认各自的回合。
- 历史成长与当前判断分开；阶段改变实际方法，反例可触发复核、失准、重建和恢复。
- 两案修复加两次正确指认才完整成功；可继续的未竟调查保留历史卡并开放续查。
- 16 张图文协作卡、6 类 3D 勋章，支持图文/3D切换与导出。预览不代表通关。
- 评委模式保留世界真值、两次受控注入与协作数据。

## 启动

需要 Python 3.11+、Node.js 20+ 和 npm。在仓库根目录执行：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
cd frontend-b
npm ci
npm exec tsc -b
npm exec vite build -- --config vite.config.ts --outDir dist-next
cd ..
./start-b.command
```

打开 **http://127.0.0.1:8783/b/**。安装依赖需联网，默认游戏运行完全本地，不依赖 CDN、Tripo 或远程模型服务。

若使用包含 `frontend-b/dist-next` 的完整演示 ZIP，安装 Python 依赖后即可运行 `start-b.command`，无需再构建前端。

Windows：设置 `PYTHONPATH=backend` 后，用虚拟环境的 Python 执行 `python -m uvicorn app.b_main:app --host 127.0.0.1 --port 8783`。

## 展示顺序

1. 村子：五名成员在 8×8 世界探索，推进到下一次部落决定。
2. 协作调查：看证据贡献、当前规矩、材料缺口和真实回合。
3. 追查源头：选择案件、成员及记忆，分别提交两案指认。
4. 评委模式：对照世界真值、攻击、集体知识和任务协作。
5. 结局墙：真实存档、16张图文卡、6类3D勋章分开展示。

## A 版保留

A 位于 `frontend/`。先在该目录执行 `npm ci`、`npm run build`，再从仓库根目录运行 `./start.command`，打开 http://127.0.0.1:8781/。

B 使用独立控制器与 `data/cards-b/`，不与 A 共用当前局。

## 验证

```sh
.venv/bin/python -m pytest -q
CHECK_COOPERATION_ART=1 CHECK_EXPANDED_MODELS=1 node --test scripts/check-*.mjs
.venv/bin/python scripts/check-b-closure-matrix.py
```

核心交付验证：后端207项、前端280项通过；提交前3D勋章定向测试也通过。4种代表协议路线实跑通过，覆盖4/16，非穷举；矩阵脚本 `--full` 可检查16种组合。

## 真实边界

当前是本地确定性模拟与 mock 决策，不是在线真实大模型蜂群。不保证每种制度都能通关。撤回、拦截、修正规则和玩家追源分别记录；个人成长不等于集体判断正确。

仓库包含源码和本地运行资产，不包含密钥、私人存档、机器配置、生成日志或旧压缩备份。
