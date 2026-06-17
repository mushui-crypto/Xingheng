import { FormEvent, useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";
import { defaultPlatformConfig, useConfigStore } from "../../store/configStore";
import type { PlatformConfig } from "../../types";

export function AdminSettingsPage() {
  const { config, updateConfig, resetConfig } = useConfigStore();
  const [form, setForm] = useState<PlatformConfig>(config);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setForm(config);
  }, [config]);

  const handleChange = (key: keyof PlatformConfig, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    updateConfig(form);
    setMessage("系统配置已保存。");
  };

  const handleReset = () => {
    resetConfig();
    setForm(defaultPlatformConfig);
    setMessage("已恢复默认配置。");
  };

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">系统配置</h1>
        <p className="mt-2 text-sm text-muted">修改平台白标信息，用户端与后台端会同步读取。</p>
      </div>
      <Card>
        <form className="space-y-5" onSubmit={handleSubmit}>
          <div className="grid gap-4 md:grid-cols-2">
            <Input
              label="平台名称"
              value={form.platformName}
              onChange={(event) => handleChange("platformName", event.target.value)}
              required
            />
            <Input
              label="Logo 文案"
              value={form.logoText}
              maxLength={8}
              onChange={(event) => handleChange("logoText", event.target.value)}
              required
            />
            <Input
              label="主题色"
              type="color"
              value={form.themeColor}
              onChange={(event) => handleChange("themeColor", event.target.value)}
              required
            />
            <Input
              label="默认币种"
              value={form.defaultCurrency}
              onChange={(event) => handleChange("defaultCurrency", event.target.value.toUpperCase())}
              required
            />
          </div>
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-slate-300">风险提示文案</span>
            <textarea
              className="min-h-28 w-full rounded-lg border border-line bg-[#0f1722] px-3.5 py-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-emerald-400"
              value={form.riskNotice}
              onChange={(event) => handleChange("riskNotice", event.target.value)}
              required
            />
          </label>
          {message ? <p className="rounded-lg border border-emerald-400/30 bg-emerald-400/10 p-3 text-sm text-emerald-200">{message}</p> : null}
          <div className="flex flex-wrap gap-3">
            <Button type="submit">保存配置</Button>
            <Button type="button" variant="secondary" onClick={handleReset}>
              恢复默认
            </Button>
          </div>
        </form>
      </Card>
      <Card>
        <p className="text-sm text-muted">实时预览</p>
        <div className="mt-4 flex items-center gap-4">
          <div
            className="flex h-12 w-12 items-center justify-center rounded-lg text-sm font-black text-[#07110f]"
            style={{ backgroundColor: form.themeColor }}
          >
            {form.logoText || "LOGO"}
          </div>
          <div>
            <h2 className="text-xl font-semibold">{form.platformName || "平台名称"}</h2>
            <p className="mt-1 text-sm text-muted">{form.defaultCurrency || "USD"} 模拟交易环境</p>
          </div>
        </div>
      </Card>
    </div>
  );
}
