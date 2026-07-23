# session-panel

## 插件路径解析规则

`.opencode/opencode.json` 中的插件路径是**相对于 `.opencode/` 目录**解析的，不是相对于项目根目录。

```jsonc
// .opencode/opencode.json
{
  "plugin": [
    // ❌ 错误：会找 .opencode/your-plugin.ts（不存在）
    // ["./your-plugin.ts", { ... }]

    // ✅ 正确：文件在项目根目录时用 ../
    ["../your-plugin.ts", { ... }]
  ]
}
```

如果插件文件就放在 `.opencode/` 目录内，则 `./` 即可。
