import { Check, ChevronDown, Search } from "lucide-react";
import { useState } from "react";
import { Modal } from "../../../components/ui/Modal";
import type { ArbitrageAsset } from "../model/types";

type AssetCategory = "crypto" | "metals" | "us_equities";
const categories: Array<{ value: "all" | AssetCategory; label: string }> = [
  { value: "all", label: "全部" },
  { value: "crypto", label: "Crypto" },
  { value: "metals", label: "贵金属" },
  { value: "us_equities", label: "美股合约" },
];

const assetInfo: Record<ArbitrageAsset, { category: AssetCategory; name: string; keywords: string }> = {
  BTC: { category: "crypto", name: "比特币", keywords: "Bitcoin" },
  ETH: { category: "crypto", name: "以太坊", keywords: "Ethereum" },
  SOL: { category: "crypto", name: "Solana", keywords: "索拉纳" },
  XRP: { category: "crypto", name: "瑞波币", keywords: "Ripple" },
  DOGE: { category: "crypto", name: "狗狗币", keywords: "Dogecoin" },
  XAU: { category: "metals", name: "黄金", keywords: "Gold" },
  GOLD: { category: "metals", name: "黄金", keywords: "Gold" },
  XAUT: { category: "metals", name: "Tether Gold", keywords: "黄金" },
  PAXG: { category: "metals", name: "PAX Gold", keywords: "黄金 Paxos" },
  MU: { category: "us_equities", name: "美光科技", keywords: "Micron" },
  NVDA: { category: "us_equities", name: "英伟达", keywords: "NVIDIA" },
  GOOGL: { category: "us_equities", name: "谷歌", keywords: "Google Alphabet" },
  MSFT: { category: "us_equities", name: "微软", keywords: "Microsoft" },
  TSLA: { category: "us_equities", name: "特斯拉", keywords: "Tesla" },
};

export function ArbitrageAssetPicker({ assets, value, onChange }: {
  assets: readonly ArbitrageAsset[];
  value: ArbitrageAsset | "all";
  onChange: (value: ArbitrageAsset | "all") => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<"all" | AssetCategory>("all");
  const keyword = search.trim().toLocaleLowerCase();
  const filtered = assets.filter((asset) => {
    const info = assetInfo[asset];
    return (category === "all" || info.category === category)
      && `${asset} ${info.name} ${info.keywords}`.toLocaleLowerCase().includes(keyword);
  });
  const select = (asset: ArbitrageAsset | "all") => {
    onChange(asset);
    setOpen(false);
  };

  return <>
    <button
      type="button"
      className="flex h-10 min-w-0 w-full items-center gap-2 border border-line bg-black px-3 text-sm text-[#b7bcc4] transition hover:border-white/35 hover:text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-white/60"
      aria-label={`筛选资产：${value === "all" ? "全部资产" : value}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => { setSearch(""); setCategory("all"); setOpen(true); }}
    >
      <Search size={15} className="shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-left">{value === "all" ? "全部资产" : value}</span>
      <ChevronDown size={15} className="shrink-0 text-[#7f8792]" aria-hidden="true" />
    </button>
    <Modal open={open} title="选择资产" description="搜索并选择套利看板中的资产" onClose={() => setOpen(false)} shellClassName="xh-market-modal" bodyClassName="xh-market-modal-body">
      <div className="xh-market-search shrink-0">
        <Search size={18} className="shrink-0" aria-hidden="true" />
        <input data-modal-initial-focus type="search" value={search} placeholder="搜索资产代码或名称" aria-label="搜索资产" onChange={(event) => setSearch(event.target.value)} />
        {search ? <button type="button" onClick={() => setSearch("")}>清除</button> : null}
      </div>
      <div className="xh-market-filters shrink-0" role="group" aria-label="资产分类">
        {categories.map((item) => <button key={item.value} type="button" aria-pressed={category === item.value} className={category === item.value ? "is-active" : ""} onClick={() => setCategory(item.value)}>
          {item.label}<span>{assets.filter((asset) => item.value === "all" || assetInfo[asset].category === item.value).length}</span>
        </button>)}
      </div>
      <button type="button" className="flex min-h-12 w-full shrink-0 items-center justify-between gap-3 border-b border-line px-6 text-left text-sm text-white hover:bg-white/[0.045] focus-visible:outline focus-visible:outline-1 focus-visible:outline-inset focus-visible:outline-white" aria-pressed={value === "all"} onClick={() => select("all")}>
        全部资产{value === "all" ? <Check size={16} className="text-[#c7f26b]" aria-hidden="true" /> : null}
      </button>
      <div className="xh-market-list" role="group" aria-label="资产列表">
        {filtered.length ? filtered.map((asset) => <button
          key={asset}
          type="button"
          aria-pressed={value === asset}
          className={`flex min-h-[60px] w-full items-center justify-between gap-4 border-b border-[#242424] px-6 py-3 text-left text-white transition hover:bg-white/[0.045] focus-visible:outline focus-visible:outline-1 focus-visible:outline-inset focus-visible:outline-white ${value === asset ? "bg-[#c7f26b]/[0.07]" : ""}`}
          onClick={() => select(asset)}
        >
          <span className="min-w-0"><strong className="block font-mono text-sm font-semibold">{asset}</strong><span className="mt-1 block text-xs text-muted">{assetInfo[asset].name}</span></span>
          {value === asset ? <Check size={16} className="shrink-0 text-[#c7f26b]" aria-hidden="true" /> : null}
        </button>) : <div className="xh-market-empty"><p>没有匹配的资产</p><span>请尝试其他关键词或分类。</span></div>}
      </div>
      <div className="xh-market-modal-footer shrink-0"><span>共 {filtered.length} 个结果</span><span>点击资产即可筛选</span></div>
    </Modal>
  </>;
}
