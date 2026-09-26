# 功能阶段测试产物

每个功能使用独立目录保存实际执行结果和证据索引，例如：

```text
features/<feature>/
├── README.md
├── M3-integration-report.md
├── M4-regression-report.md
└── evidence/
```

测试规格仍放在 `docs/sdd/features/<feature>/test-spec.md`；阶段评审冻结结论放在 `docs/deliverables/<feature>/`。未执行的测试不得创建“通过”报告。

当前报告：[图片理解 M1](image-understanding/M1-report.md)、[图片理解 M2](image-understanding/M2-report.md)。
