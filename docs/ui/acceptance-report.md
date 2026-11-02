# S2-2.5 前端验收记录

记录时间：2026-11-02 · 浏览器：Chrome 156 headless（CDP 设备模拟）· 数据：本地测试夹具（3 个长文本目标、7 个知识点、8 条会话）

## 一、7 视口 × 5 页面：滚动可达性与横向溢出

每格含义：滚动到底后，正文与可交互控件是否全部在视口内（`OK` = 全部可达，无横向溢出，底部导航无遮挡）。

| 视口 | 今日学习 | AI 学习 | 练习与反馈 | 我的学习档案 | 系统设置 |
|---|---|---|---|---|---|
| 320x640 | OK | OK | OK | OK | OK |
| 360x800 | OK | OK | OK | OK | OK |
| 390x844 | OK | OK | OK | OK | OK |
| 768x1024 | OK | OK | OK | OK | OK |
| 1024x768 | OK | OK | OK | OK | OK |
| 1440x900 | OK | OK | OK | OK | OK |
| 1920x1080 | OK | OK | OK | OK | OK |

共 35 组页面/视口组合，全部通过。

## 二、真实浏览器行为检查

| 检查项 | 结果 |
|---|---|
| deep link opens the linked conversation | 通过 · selected: 并发控制器的实现细节：限流、取消与错误聚合 |
| deep link restores the checkpoint revision | 通过 · #2 |
| deep link loads chat history | 通过 |
| refresh keeps the same conversation | 通过 · selected: 并发控制器的实现细节：限流、取消与错误聚合 |
| refresh keeps the same revision | 通过 · #2 |
| back returns to the learn page with its conversation | 通过 · selected: 并发控制器的实现细节：限流、取消与错误聚合 |
| forward returns to the previous page | 通过 · h1: 今日学习 |
| recent session opens the right conversation | 通过 · selected: 复习闭包与词法作用域：用三个反例检验自己是否真的理解了 |
| recent session adds exactly one history entry | 通过 · 1 → 2 |
| back from a recent session returns to today | 通过 |
| composer draft survives a page switch | 通过 · draft: 这是一段还没发出去的草稿 |
| fast A/B switch lands on the last chosen conversation | 通过 · selected: 并发控制器的实现细节：限流、取消与错误聚合 |
| fast A/B switch shows that conversation's revision | 通过 · #2 |
| phone: the learning-sessions card below the chat is reachable | 通过 · {"top":97,"bottom":121,"viewport":844,"scrollable":true} |
| phone: the rail's last card ends above the bottom navigation | 通过 · {"cardBottom":742,"navTop":774,"itemInsideList":true,"listBottom":725} |
| phone: the last session row is reachable inside the session list | 通过 · {"itemInsideList":true,"listBottom":725} |
| phone keyboard-height viewport keeps the input and send button operable | 通过 · {"inputTop":186,"inputBottom":245,"sendBottom":287,"viewport":420,"cardHeight":340,"scrollTop":120} |

## 三、自动化测试

```
npx vitest run   # 101 文件 / 824 通过 / 3 跳过 / 0 失败
npm run build    # 通过
```

新增/更新的回归测试：
- `stores/learning-store.test.ts`：7 项确定性并发（A/B 乱序、切换、清空、暂停/初始化跨会话、旧失败不污染、冲突刷新限定本会话）
- `react/shell/navigation.test.ts`：13 项（深链接、刷新语义、后退/前进恢复会话、单条历史记录、StrictMode 双执行、非 learn 页丢弃 session）
- `react/shell/shell.css.test.ts`：6 项滚动职责契约
- `react/pages/LearnPage.test.tsx`：快速切换不串台、会话打开失败有可见错误

截图：`docs/ui/acceptance-*.png`（18 张，覆盖 light/dark、1440/1024/768/390/320、手机滚动到底与键盘高度视口）。S2-2.5 基线截图未改动。

